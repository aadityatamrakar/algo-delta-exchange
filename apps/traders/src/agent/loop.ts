/**
 * One assistant turn, start to finish, as our own events (spec §7): resolve
 * the conversation (a model change or a 200 KB document starts a new one),
 * bind the tools to the trader, run the model through the library adapter,
 * map its parts to `meta → status/tool/card/text → usage → done`, check the
 * answer's numbers (R2), price the turn (R10) and store it whole (R12) — also
 * when it was aborted or failed.
 *
 * The HTTP side (busy, budget and ownership checks, the SSE framing, the
 * disconnect) is routes/assistant.ts; this file never sees a request.
 */

import type { PresetId } from '@algomaker/payoff'
import type { Log } from '../routes/kit.ts'
import { runModel, type AgentMessage, type Meter, type RunPart, type TurnLimits } from './ai-tools.ts'
import { capRefusal, costUsd, TURN_LIMITS, worstCallUsd, type Caps, type SpendLedger } from './budget.ts'
import type { AiConfig } from './config.ts'
import type { ModelChoice } from './model.ts'
import { PROMPT_VERSION, SYSTEM_PROMPT, turnPreamble } from './prompt.ts'
import { provenanceOf, type Provenance } from './provenance.ts'
import { LegAliases, Redactor } from './redact.ts'
import { answerIndex, CONVERSATION_MAX_BYTES, titleOf, type AssistantStore, type ConversationDoc, type TurnRecord } from './store.ts'
import type { AgentDeps, AnyTool, ToolCtx } from './tools/ctx.ts'
import { PlanCache } from './tools/plans.ts'
import type { AssistantCard, AssistantErrorCode, AssistantEvent, ViewChoice } from './wire.ts'

export const MAX_OUTPUT_TOKENS = 16_000

export interface TurnDeps {
  readonly agent: AgentDeps
  readonly store: AssistantStore
  readonly config: AiConfig
  /** The model, built once per process (or a mock in tests). */
  readonly choice: () => ModelChoice
  readonly tools: readonly AnyTool[]
  /** What running turns hold against the caps (R10); the route has already held this turn's first call. */
  readonly ledger: SpendLedger
  readonly log: Log
  readonly now: () => number
  /** Tests shorten the wall clock. */
  readonly wallClockMs?: number
  readonly limits?: Partial<TurnLimits>
}

export interface TurnRequest {
  readonly trader: string
  readonly message: string
  /** An existing conversation the route has already checked is this trader's; null = a new one. */
  readonly conversation: ConversationDoc | null
  readonly stock: string | null
  /** From the request body (R6). */
  readonly allowClose: boolean
  readonly presets: readonly PresetId[]
  readonly view: ViewChoice | null
  /** The trader's spend today before this turn, USD. */
  readonly spentToday: number
  /** This turn's id in the ledger. */
  readonly turnId: string
  /** IST midnight: where today's spend is summed from. */
  readonly dayStart: number
}

export type Emit = (e: AssistantEvent) => void

export interface TurnOutcome {
  readonly conversationId: string
  readonly turn: number
  readonly costUsd: number
  readonly aborted: boolean
  readonly provenance: Provenance
}

const TIMEOUT_MESSAGE = 'the answer took longer than two minutes and was stopped'
const BUDGET_STOP = 'stopped before another model call: it could pass today\'s assistant budget'

/** Opens the turn's conversation: the given one, or a new one when it was changed model or grew past 200 KB. */
async function conversationFor(d: TurnDeps, req: TurnRequest, choice: ModelChoice, emit: Emit): Promise<ConversationDoc> {
  const c = req.conversation
  const create = (prev: string | null): Promise<ConversationDoc> => d.store.create({
    trader: req.trader, stock: req.stock ?? c?.stock ?? null, title: titleOf(req.message), provider: choice.provider, model: choice.modelId, prev,
  })
  if (c === null) return await create(null)
  if (c.model !== choice.modelId || c.provider !== choice.provider) {
    const next = await create(c._id)
    emit({ event: 'warning', data: { text: `the assistant now runs ${choice.modelId}: this starts a new conversation` } })
    return next
  }
  if (c.bytes > CONVERSATION_MAX_BYTES) {
    const next = await create(c._id)
    emit({ event: 'warning', data: { text: 'that conversation grew past 200 KB: this starts a new one (the old one is kept)' } })
    return next
  }
  return c
}

/** The stored turns as the model saw them: each turn's user message, then what came back. A turn with nothing back is left out. */
export function historyOf(doc: ConversationDoc): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const t of doc.turns) {
    const back = JSON.parse(t.messagesJson) as AgentMessage[]
    if (back.length === 0 || t.userMessageJson === '') continue
    out.push(JSON.parse(t.userMessageJson) as AgentMessage, ...back)
  }
  return out
}

export async function runTurn(d: TurnDeps, req: TurnRequest, emit: Emit, clientSignal: AbortSignal): Promise<TurnOutcome> {
  const choice = d.choice()
  const doc = await conversationFor(d, req, choice, emit)
  emit({ event: 'meta', data: { conversationId: doc._id, model: choice.modelId, stock: doc.stock } })

  let cardSeq = doc.cardSeq
  const legs = await d.agent.legs.open(req.trader)
  const ctx: ToolCtx = {
    trader: req.trader, deps: d.agent,
    aliases: new LegAliases(doc.aliases), plans: new PlanCache(doc.plans),
    redactor: new Redactor({ trader: req.trader, legs }),
    counters: { toolCalls: 0, searches: 0 },
    allowClose: req.allowClose, userText: req.message, presets: req.presets, view: req.view, stock: req.stock ?? doc.stock,
    nextCardId: () => `K${++cardSeq}`,
  }
  const userMessage: AgentMessage = {
    role: 'user',
    content: turnPreamble({ stock: ctx.stock, presets: req.presets, view: req.view, allowClose: req.allowClose }) + ctx.redactor.scrubText(req.message),
  }

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), d.wallClockMs ?? TURN_LIMITS.wallClockMs)
  const signal = AbortSignal.any([clientSignal, timeout.signal])
  const defs = new Map(d.tools.map((t) => [t.name, t]))
  const labels = new Map<string, string>()
  const limits: TurnLimits = {
    maxSteps: d.config.maxSteps, maxToolCalls: TURN_LIMITS.maxToolCalls, maxSearches: TURN_LIMITS.maxSearches, maxOutputTokens: MAX_OUTPUT_TOKENS, ...d.limits,
  }

  let text = ''
  const cards: AssistantCard[] = []
  const results: unknown[] = []
  let error: { code: AssistantErrorCode; message: string } | null = null
  let aborted = false
  let thinking = false
  let steps = 0
  let budgetStopped = false
  const send = (e: AssistantEvent): void => { if (!clientSignal.aborted) emit(e) }
  const price = d.config.price
  const caps: Caps = { traderUsd: d.config.traderDailyUsd, globalUsd: d.config.dailyUsd }
  /** R10, before every call after the first: stored spend + what other turns hold + this turn so far + the next call's worst case must fit. */
  const allowNextCall = async (m: Meter): Promise<boolean> => {
    if (price === null) return false
    const soFar = costUsd(m.usage, price)
    const next = worstCallUsd(m.nextInput, limits.maxOutputTokens, price)
    d.ledger.set(req.turnId, soFar + next)
    const stored = await d.store.spendSince(req.dayStart, req.trader)
    const others = d.ledger.held(req.trader, req.turnId)
    const refusal = capRefusal({ traderUsd: stored.traderUsd + others.traderUsd + soFar, globalUsd: stored.globalUsd + others.globalUsd + soFar }, caps, next)
    if (refusal !== null) budgetStopped = true
    return refusal === null
  }

  const run = runModel({
    choice, system: SYSTEM_PROMPT, messages: [...historyOf(doc), userMessage], tools: d.tools, ctx, limits, abortSignal: signal, log: d.log, allowNextCall,
  })
  try {
    for await (const p of run.parts as AsyncIterable<RunPart>) {
      switch (p.kind) {
        case 'step-start': steps++; thinking = false; break
        case 'reasoning':
          if (!thinking) { thinking = true; send({ event: 'status', data: { label: 'thinking' } }) }
          break
        case 'text': text += p.delta; send({ event: 'text', data: { delta: p.delta } }); break
        case 'tool-start': {
          const def = defs.get(p.name)
          let label = p.name
          try { if (def !== undefined) label = def.label(p.input as never) } catch { /* a malformed input keeps the name */ }
          labels.set(p.id, label)
          send({ event: 'tool', data: { id: p.id, name: p.name, label, state: 'start' } })
          break
        }
        case 'tool-done': {
          results.push(p.exec.result)
          send({ event: 'tool', data: { id: p.id, name: p.name, label: labels.get(p.id) ?? p.name, state: p.exec.ok ? 'done' : 'error', ...(p.exec.summary === null ? {} : { summary: p.exec.summary }) } })
          for (const c of p.exec.cards) { cards.push(c); send({ event: 'card', data: c }) }
          break
        }
        case 'tool-failed': send({ event: 'tool', data: { id: p.id, name: p.name, label: labels.get(p.id) ?? p.name, state: 'error', summary: p.message } }); break
        case 'step-done': break
        case 'finish':
          if (p.finish === 'content-filter') send({ event: 'warning', data: { text: 'the model declined to answer this one' } })
          else if (p.finish === 'length') send({ event: 'warning', data: { text: 'the answer hit its length limit' } })
          break
        case 'error':
          error = { code: 'provider', message: p.status === null ? `the model provider failed: ${p.message}` : `the model provider answered ${p.status}: ${p.message}` }
          break
        case 'abort': aborted = true; break
      }
    }
  } catch (e) {
    error = { code: 'internal', message: 'the assistant failed on the server' }
    d.log('assistant turn failed', { conversation: doc._id, error: e instanceof Error ? e.message : String(e) })
  } finally {
    clearTimeout(timer)
  }
  if (aborted && timeout.signal.aborted && !clientSignal.aborted) error = { code: 'timeout', message: TIMEOUT_MESSAGE }

  if (budgetStopped && error === null) send({ event: 'warning', data: { text: BUDGET_STOP } })

  const messages = await run.messages()
  // every call the provider counted, and every call cut off charged at its prompt plus the full output cap (R10)
  const meter = run.meter()
  const usage = meter.usage
  const cost = price === null ? 0 : costUsd(usage, price)
  const provenance = provenanceOf(text, [...results, ...ctx.plans.state.plans.map((p) => p.metrics)])
  const turn: TurnRecord = {
    at: d.now(), user: req.message, userMessageJson: JSON.stringify(userMessage), messagesJson: JSON.stringify(messages),
    text, cards, usage, costUsd: cost, cutOffCalls: meter.cutOff, provenance, aborted, error: error?.message ?? null,
    model: choice.modelId, promptVersion: PROMPT_VERSION, feedback: null,
  }
  let record: number
  try {
    record = await d.store.appendTurn(doc._id, turn, { aliases: ctx.aliases.keys, plans: ctx.plans.state, cardSeq })
  } finally {
    // stored (or failed to store): the store's spend counts it from here, not the ledger
    d.ledger.release(req.turnId)
  }
  d.log('assistant turn', {
    conversation: doc._id, steps, calls: meter.calls, cutOffCalls: meter.cutOff, toolCalls: ctx.counters.toolCalls, costUsd: cost, aborted,
    budgetStopped, error: error?.code ?? null,
    // R2: the figures the answer gave that no tool result backs (model text, never an identity: the redactor ran on what it read)
    unverified: provenance.unverified,
  })
  if (error !== null) send({ event: 'error', data: error })
  send({ event: 'usage', data: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cacheReadTokens, costUsd: cost, traderUsdToday: Math.round((req.spentToday + cost) * 1e4) / 1e4 } })
  send({ event: 'done', data: { provenance, turn: answerIndex(record) } })
  return { conversationId: doc._id, turn: answerIndex(record), costUsd: cost, aborted, provenance }
}
