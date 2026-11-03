/**
 * `traders-assistant`: every conversation and every turn, kept (spec R12,
 * §6.5, §6.5a). One document per conversation; a turn is appended, never
 * rewritten (feedback is the one field set later). No app path deletes a
 * document: DELETE hides it from the trader's list, the 200 KB rollover opens
 * a new document and leaves the old one as it was.
 *
 * The model messages are stored as the JSON the library returned — reasoning
 * parts, signatures and provider metadata included — because a thinking block
 * must be replayed byte for byte, and a JSON string round-trips exactly where
 * BSON would not promise to (field names, number types). The leg aliases and
 * the plan cache are saved with the conversation, server side only.
 *
 * Daily spend is summed from here (index trader+updatedAt, and updatedAt for
 * the desk total).
 */

import { randomUUID } from 'node:crypto'
import type { TradersDb } from '../db.ts'
import type { TokenUsage } from './budget.ts'
import type { PlanCacheState } from './tools/plans.ts'
import type { Provenance } from './provenance.ts'
import type { AssistantCard, AssistantUsageView, ConversationSummary, ConversationView } from './wire.ts'
import { istDate } from '../routes/kit.ts'

export const CONVERSATION_MAX_BYTES = 200 * 1024
export const CONVERSATIONS_LISTED = 30
const DAY_MS = 86_400_000

export type ConversationKind = 'chat' | 'plan-search'

export interface TurnFeedback { readonly rating: 'up' | 'down'; readonly note: string; readonly at: number }

export interface TurnRecord {
  readonly at: number
  /** The trader's words, as typed. */
  readonly user: string
  /** The user message as sent to the model (preamble + words, scrubbed), JSON. */
  readonly userMessageJson: string
  /** The response messages exactly as the library returned them, JSON. */
  readonly messagesJson: string
  /** The answer as the page showed it. */
  readonly text: string
  readonly cards: readonly AssistantCard[]
  /** What was charged: the provider's counts, plus the pessimistic charge for every call cut off mid-stream (R10). */
  readonly usage: TokenUsage
  readonly costUsd: number
  /** Model calls cut off mid-stream and charged at their prompt plus the full output cap. Absent on records before 23 Oct. */
  readonly cutOffCalls?: number
  readonly provenance: Provenance
  readonly aborted: boolean
  readonly error: string | null
  readonly model: string
  readonly promptVersion: string
  readonly feedback: TurnFeedback | null
  /** A plan-search run's request (kind 'plan-search' only). */
  readonly request?: unknown
}

export interface ConversationDoc {
  readonly _id: string
  readonly kind: ConversationKind
  readonly trader: string
  readonly stock: string | null
  readonly title: string
  readonly provider: string
  readonly model: string
  readonly hidden: boolean
  readonly createdAt: number
  readonly updatedAt: number
  /** The conversation this one continues after a 200 KB rollover. */
  readonly prev: string | null
  /** Leg keys by alias number (L1 = [0]). Server side only. */
  readonly aliases: readonly string[]
  readonly plans: PlanCacheState
  readonly cardSeq: number
  /** Bytes of the stored turns, for the rollover. */
  readonly bytes: number
  readonly turns: readonly TurnRecord[]
}

export interface ConversationState {
  readonly aliases: readonly string[]
  readonly plans: PlanCacheState
  readonly cardSeq: number
}

const byteSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')

/** The trader's words as a list title: the first line, at most 80 characters. */
export function titleOf(message: string): string {
  const line = message.trim().split('\n')[0] ?? ''
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`
}

/** A conversation as the page shows it: each turn is the trader's line and the answer; `turn` indexes count both. */
export function conversationView(doc: ConversationDoc): ConversationView {
  return {
    id: doc._id, stock: doc.stock,
    turns: doc.turns.flatMap((t) => [
      { role: 'user' as const, text: t.user, cards: [], at: t.at },
      { role: 'assistant' as const, text: t.text, cards: t.cards, at: t.at, feedback: t.feedback?.rating ?? null },
    ]),
  }
}

/** ConversationView's index of turn record `i`'s answer, and back; null for a user line. */
export const answerIndex = (i: number): number => 2 * i + 1
export const recordIndex = (viewTurn: number): number | null => (Number.isInteger(viewTurn) && viewTurn >= 1 && viewTurn % 2 === 1 ? (viewTurn - 1) / 2 : null)

export class AssistantStore {
  readonly #db: TradersDb
  readonly #now: () => number

  constructor(db: TradersDb, now: () => number) {
    this.#db = db
    this.#now = now
  }

  #col() {
    return this.#db.collection<ConversationDoc>('traders-assistant')
  }

  async ensureIndexes(): Promise<void> {
    await this.#col().createIndex({ trader: 1, updatedAt: -1 })
    await this.#col().createIndex({ updatedAt: 1 })
  }

  async create(o: { readonly trader: string; readonly stock: string | null; readonly title: string; readonly provider: string; readonly model: string; readonly kind?: ConversationKind; readonly prev?: string | null }): Promise<ConversationDoc> {
    const at = this.#now()
    const doc: ConversationDoc = {
      _id: `c-${randomUUID()}`, kind: o.kind ?? 'chat', trader: o.trader, stock: o.stock, title: o.title, provider: o.provider, model: o.model,
      hidden: false, createdAt: at, updatedAt: at, prev: o.prev ?? null, aliases: [], plans: { plans: [], next: 1 }, cardSeq: 0, bytes: 0, turns: [],
    }
    await this.#col().insertOne({ ...doc })
    return doc
  }

  async get(id: string): Promise<ConversationDoc | null> {
    return await this.#col().findOne({ _id: id })
  }

  /** The trader's own, not hidden; null otherwise (another trader's id answers the same as a missing one). */
  async owned(id: string, trader: string): Promise<ConversationDoc | null> {
    return await this.#col().findOne({ _id: id, trader, hidden: false })
  }

  /** Appends a turn and saves the aliases, plans and card counter it left. Answers the turn's record index. */
  async appendTurn(id: string, turn: TurnRecord, state: ConversationState): Promise<number> {
    const doc = await this.get(id)
    if (doc === null) throw new Error(`no conversation ${id}`)
    await this.#col().updateOne({ _id: id }, {
      $push: { turns: turn },
      $set: { aliases: [...state.aliases], plans: state.plans, cardSeq: state.cardSeq, updatedAt: turn.at, bytes: doc.bytes + byteSize(turn) },
    })
    return doc.turns.length
  }

  async list(trader: string, limit = CONVERSATIONS_LISTED): Promise<ConversationSummary[]> {
    const rows = await this.#col().find({ trader, hidden: false, kind: 'chat' }, { projection: { turns: 0, aliases: 0, plans: 0 } })
      .sort({ updatedAt: -1 }).limit(limit).toArray()
    return rows.map((d) => ({ id: d._id, title: d.title, stock: d.stock, updatedAt: d.updatedAt, model: d.model }))
  }

  /** Hides from the trader's list; the record stays. False when it is not this trader's (or already hidden). */
  async hide(id: string, trader: string): Promise<boolean> {
    const r = await this.#col().updateOne({ _id: id, trader, hidden: false }, { $set: { hidden: true } })
    return (r.matchedCount ?? 0) > 0
  }

  /** False when the conversation is not this trader's or has no such turn. */
  async setFeedback(id: string, trader: string, record: number, fb: TurnFeedback): Promise<boolean> {
    const r = await this.#col().updateOne(
      { _id: id, trader, hidden: false, [`turns.${record}`]: { $exists: true } },
      { $set: { [`turns.${record}.feedback`]: fb } },
    )
    return (r.matchedCount ?? 0) > 0
  }

  /** US dollars spent since `sinceMs`: by the trader (when given) and by the whole desk. */
  async spendSince(sinceMs: number, trader: string): Promise<{ traderUsd: number; globalUsd: number }> {
    const docs = await this.#col().find({ updatedAt: { $gte: sinceMs } }, { projection: { trader: 1, 'turns.at': 1, 'turns.costUsd': 1 } }).toArray()
    let traderUsd = 0, globalUsd = 0
    for (const d of docs) {
      for (const t of d.turns ?? []) {
        if (t.at < sinceMs) continue
        globalUsd += t.costUsd
        if (d.trader === trader) traderUsd += t.costUsd
      }
    }
    return { traderUsd: Math.round(traderUsd * 1e4) / 1e4, globalUsd: Math.round(globalUsd * 1e4) / 1e4 }
  }

  /** Per trader per IST day: turns, tokens and dollars over the last `days`. */
  async usage(days: number): Promise<AssistantUsageView> {
    const since = Date.parse(`${istDate(this.#now() - (days - 1) * DAY_MS)}T00:00:00+05:30`)
    const docs = await this.#col().find({ updatedAt: { $gte: since } }, { projection: { trader: 1, 'turns.at': 1, 'turns.costUsd': 1, 'turns.usage': 1 } }).toArray()
    const rows = new Map<string, { trader: string; day: string; turns: number; inputTokens: number; outputTokens: number; usd: number }>()
    for (const d of docs) {
      for (const t of d.turns ?? []) {
        if (t.at < since) continue
        const day = istDate(t.at)
        const k = `${d.trader}|${day}`
        const r = rows.get(k) ?? { trader: d.trader, day, turns: 0, inputTokens: 0, outputTokens: 0, usd: 0 }
        r.turns++
        r.inputTokens += t.usage?.inputTokens ?? 0
        r.outputTokens += t.usage?.outputTokens ?? 0
        r.usd = Math.round((r.usd + t.costUsd) * 1e4) / 1e4
        rows.set(k, r)
      }
    }
    return { days, rows: [...rows.values()].sort((a, b) => (a.day === b.day ? (a.trader < b.trader ? -1 : 1) : a.day < b.day ? 1 : -1)) }
  }

  /**
   * Every document touched in [fromMs, toMs), hidden ones too, oldest first,
   * one at a time from a cursor — never the whole range in memory — and
   * without the server-side aliases (leg keys carry client codes) and plans.
   * Stopping early closes the cursor.
   */
  async *touched(fromMs: number, toMs: number): AsyncGenerator<Omit<ConversationDoc, 'aliases' | 'plans'>> {
    const cur = this.#col().find({ updatedAt: { $gte: fromMs }, createdAt: { $lt: toMs } }, { projection: { aliases: 0, plans: 0 } }).sort({ createdAt: 1 })
    try {
      for (let d = await cur.next(); d !== null; d = await cur.next()) yield d
    } finally {
      await cur.close()
    }
  }

  /**
   * A deterministic plan-search run, kept like a chat turn (§6.5a): its own
   * document of kind 'plan-search', never listed with the conversations.
   * Phase B's route calls this.
   */
  async recordPlanSearch(o: { readonly trader: string; readonly stock: string; readonly request: unknown; readonly card: AssistantCard }): Promise<string> {
    const doc = await this.create({ trader: o.trader, stock: o.stock, title: `plan search ${o.stock}`, provider: 'none', model: 'none', kind: 'plan-search' })
    const turn: TurnRecord = {
      at: doc.createdAt, user: '', userMessageJson: '', messagesJson: '[]', text: '', cards: [o.card],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, provenance: { checked: 0, unverified: [] },
      aborted: false, error: null, model: 'none', promptVersion: '', feedback: null, request: o.request,
    }
    await this.appendTurn(doc._id, turn, { aliases: [], plans: { plans: [], next: 1 }, cardSeq: 0 })
    return doc._id
  }
}
