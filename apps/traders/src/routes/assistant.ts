/**
 * The assistant's endpoints (spec §6.4, §6.5a, §7). Whose data a request is
 * about comes from `whose()`, as on every route: a trader is always
 * themselves, an admin names a trader with `?as=`.
 *
 *   GET    /assistant/status                      on or off and why, today's spend and caps, the goal chips
 *   POST   /assistant/chat                        one turn, as Server-Sent Events (our events, §7)
 *   GET    /assistant/conversations               the trader's last 30
 *   GET    /assistant/conversations/:id           one, page-ready
 *   DELETE /assistant/conversations/:id           hides it from the list; the record stays (§6.5a)
 *   POST   /assistant/conversations/:id/feedback  thumbs on one answer
 *   GET    /admin/assistant/usage?days=7          per trader per day: turns, tokens, USD
 *   GET    /admin/assistant/export?from&to        every turn, one JSON line each (application/x-ndjson)
 *
 * Off (R4): status says why, chat answers 503, everything else reads what is
 * stored. `allowClose`, the goal chips and the view come from the chat body
 * only (R6). Busy and budget answer 429 before the stream opens; once it is
 * open, a ping goes out after 5 s of quiet and a client that hangs up aborts
 * the turn (its partial record is still stored).
 */

import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import { PRESET_IDS } from '@algomaker/payoff'
import { randomUUID } from 'node:crypto'
import { capRefusal, worstCallUsd, type SpendLedger, type TurnGate } from '../agent/budget.ts'
import { tokensOfBytes } from '../agent/ai-tools.ts'
import type { AiConfig } from '../agent/config.ts'
import { MAX_OUTPUT_TOKENS, runTurn, type Emit } from '../agent/loop.ts'
import type { ModelChoice, ModelFactory } from '../agent/model.ts'
import { PRESETS } from '../agent/prompt.ts'
import { conversationView, recordIndex, type AssistantStore, type ConversationDoc, type TurnRecord } from '../agent/store.ts'
import type { AgentDeps, AnyTool } from '../agent/tools/ctx.ts'
import type { AssistantEvent, AssistantStatus, ViewChoice } from '../agent/wire.ts'
import type { TraderStore } from '../auth/users.ts'
import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import { BadRequest, NotFound, isIsoDate, istDate, type Log, type Route, type RouteCtx } from './kit.ts'
import type { LiveStreams } from './live.ts'

export const ASSISTANT_PING_MS = 5_000
/** Open chat streams: one per trader (the turn gate's rule), a little room for an admin's `?as=`. */
export const ASSISTANT_STREAMS_PER_USER = 2
export const ASSISTANT_STREAMS_TOTAL = 8
export const MESSAGE_MAX = 4000
export const NOTE_MAX = 500
/** One export's range: a month, so one request never walks the whole history. */
export const EXPORT_MAX_DAYS = 31
const DAY_MS = 86_400_000

export interface AssistantRouteDeps {
  readonly users: TraderStore
  readonly agent: AgentDeps
  readonly store: AssistantStore
  readonly config: AiConfig
  readonly modelFor: ModelFactory
  readonly tools: readonly AnyTool[]
  readonly gate: TurnGate
  /** What running turns hold against the caps (R10). */
  readonly ledger: SpendLedger
  readonly streams: LiveStreams
  readonly now: () => number
  readonly log: Log
  /** Tests shorten the clocks. */
  readonly pingMs?: number
  readonly wallClockMs?: number
}

const viewSchema = z.object({
  vol: z.union([
    z.literal('implied'), z.literal('hv20'),
    z.object({ shiftPts: z.number().min(-50).max(50) }).strict(),
    z.object({ annual: z.number().gt(0).max(3) }).strict(),
  ]),
  driftPct: z.number().min(-100).max(100).optional(),
  horizon: z.string().refine(isIsoDate, 'a date, YYYY-MM-DD').optional(),
}).strict()

const chatSchema = z.object({
  conversationId: z.string().regex(/^c-[0-9a-f-]{36}$/, 'not a conversation id').optional(),
  stock: z.string().trim().toUpperCase().regex(STOCK_RE, 'the stock must be 1 to 20 letters, digits, & or -').optional(),
  message: z.string().trim().min(1, 'the message is empty').max(MESSAGE_MAX, `the message is over ${MESSAGE_MAX} characters`),
  allowClose: z.boolean().optional(),
  presets: z.array(z.enum(PRESET_IDS as readonly [string, ...string[]])).max(6).optional(),
  view: viewSchema.optional(),
}).strict()

const feedbackSchema = z.object({
  turn: z.number().int().min(0),
  rating: z.enum(['up', 'down']),
  note: z.string().max(NOTE_MAX, `the note is over ${NOTE_MAX} characters`).optional(),
}).strict()

function viewOf(v: z.infer<typeof viewSchema> | undefined): ViewChoice | null {
  if (v === undefined) return null
  return { vol: v.vol, ...(v.driftPct === undefined ? {} : { driftPct: v.driftPct }), ...(v.horizon === undefined ? {} : { horizon: v.horizon }) }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new BadRequest(i === undefined ? 'bad request body' : `${i.path.length === 0 ? 'body' : i.path.join('.')}: ${i.message}`)
  }
  return r.data
}

/** The system prompt and tool definitions, in bytes, roughly: the part of every first call that is not the conversation. */
export const PREFIX_BYTES = 30_000

/** A turn's first call, in tokens, before it is built: the prefix, the stored conversation and the message, about three bytes a token. */
export function firstCallTokens(conversation: ConversationDoc | null, message: string): number {
  return tokensOfBytes(PREFIX_BYTES + (conversation?.bytes ?? 0) + Buffer.byteLength(message, 'utf8'))
}

/** IST midnight of `nowMs`. */
export const istDayStart = (nowMs: number): number => Date.parse(`${istDate(nowMs)}T00:00:00+05:30`)

/** Writes, and when the socket's buffer is full waits for it to drain; false once the client has gone. */
export async function writeOrWait(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false
  if (res.write(chunk)) return true
  return await new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => (): void => { res.off('drain', drained); res.off('close', closed); resolve(ok) }
    const drained = done(true)
    const closed = done(false)
    res.once('drain', drained)
    res.once('close', closed)
  })
}

function sse(res: ServerResponse, e: AssistantEvent): void {
  if (!res.writableEnded && !res.destroyed) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
}

/** The tool calls of one stored turn, from its messages: name, arguments and the result the model saw. */
export function toolCallsOf(t: TurnRecord): { name: string; arguments: unknown; result: unknown }[] {
  let msgs: { role?: unknown; content?: unknown }[]
  try { msgs = JSON.parse(t.messagesJson) as typeof msgs } catch { return [] }
  const results = new Map<string, unknown>()
  for (const m of msgs) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue
    for (const p of m.content as { type?: unknown; toolCallId?: unknown; output?: { value?: unknown } }[]) {
      if (p.type === 'tool-result' && typeof p.toolCallId === 'string') results.set(p.toolCallId, p.output?.value ?? p.output ?? null)
    }
  }
  const out: { name: string; arguments: unknown; result: unknown }[] = []
  for (const m of msgs) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const p of m.content as { type?: unknown; toolCallId?: unknown; toolName?: unknown; input?: unknown }[]) {
      if (p.type === 'tool-call' && typeof p.toolCallId === 'string') {
        out.push({ name: String(p.toolName), arguments: p.input ?? null, result: results.get(p.toolCallId) ?? null })
      }
    }
  }
  return out
}

export function exportLine(doc: Pick<ConversationDoc, '_id' | 'kind' | 'trader' | 'stock' | 'hidden'>, t: TurnRecord): string {
  return JSON.stringify({
    kind: doc.kind, conversationId: doc._id, trader: doc.trader, stock: doc.stock, at: t.at, model: t.model, promptVersion: t.promptVersion,
    message: t.user, answer: t.text, toolCalls: toolCallsOf(t), cards: t.cards, usage: t.usage, costUsd: t.costUsd,
    provenance: t.provenance, feedback: t.feedback, aborted: t.aborted, error: t.error, hidden: doc.hidden,
    ...(t.request === undefined ? {} : { request: t.request }),
  })
}

export function assistantRoutes(d: AssistantRouteDeps): Route {
  let choice: ModelChoice | null = null
  const model = (): ModelChoice => (choice ??= d.modelFor(d.config))
  const caps = { traderUsd: d.config.traderDailyUsd, globalUsd: d.config.dailyUsd }

  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'assistant.status': return await status(ctx)
      case 'assistant.chat': return await chat(ctx)
      case 'assistant.conversations': return await list(ctx)
      case 'assistant.conversation': return await one(ctx)
      case 'assistant.conversation.hide': return await hide(ctx)
      case 'assistant.feedback': return await feedback(ctx)
      case 'admin.assistant.usage': return await usage(ctx)
      case 'admin.assistant.export': return await exportTurns(ctx)
      default: return false
    }
  }

  async function status(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const spent = await d.store.spendSince(istDayStart(d.now()), trader)
    const body: AssistantStatus = {
      enabled: d.config.enabled,
      ...(d.config.reason === null ? {} : { reason: d.config.reason }),
      ...(d.config.enabled ? { provider: d.config.provider, model: d.config.model } : {}),
      budget: { traderUsdToday: spent.traderUsd, traderCapUsd: caps.traderUsd, globalUsdToday: spent.globalUsd, globalCapUsd: caps.globalUsd },
      presets: PRESETS,
    }
    ctx.send(200, body)
    return true
  }

  async function chat(ctx: RouteCtx): Promise<boolean> {
    if (!d.config.enabled) {
      // the wire's error codes have no 'off': the page reads why from `error` (and from status, which it asks first)
      ctx.send(503, { error: d.config.reason ?? 'the assistant is off', code: 'internal' })
      return true
    }
    const trader = await whose(ctx, d.users)
    const body = parse(chatSchema, await ctx.readJson())
    let conversation: ConversationDoc | null = null
    if (body.conversationId !== undefined) {
      conversation = await d.store.owned(body.conversationId, trader)
      if (conversation === null) throw new NotFound(`no conversation ${body.conversationId}`)
    }
    const release = d.gate.enter(trader)
    if (release === null) {
      ctx.send(429, { error: 'an answer is already being written — wait for it or stop it', code: 'busy' })
      return true
    }
    const turnId = randomUUID()
    try {
      // R10: stored spend, plus what other running turns hold, plus this turn's first call at its worst, must fit both caps
      const dayStart = istDayStart(d.now())
      const stored = await d.store.spendSince(dayStart, trader)
      const others = d.ledger.held(trader)
      const firstCall = d.config.price === null ? 0 : worstCallUsd(firstCallTokens(conversation, body.message), MAX_OUTPUT_TOKENS, d.config.price)
      const refusal = capRefusal({ traderUsd: stored.traderUsd + others.traderUsd, globalUsd: stored.globalUsd + others.globalUsd }, caps, firstCall)
      if (refusal !== null) {
        ctx.send(429, { error: refusal.message, code: refusal.code })
        return true
      }
      d.ledger.hold(turnId, trader, firstCall)
      await stream(ctx, trader, body, conversation, stored.traderUsd, turnId, dayStart)
      return true
    } finally {
      d.ledger.release(turnId)
      release()
    }
  }

  async function stream(
    ctx: RouteCtx, trader: string, body: z.infer<typeof chatSchema>, conversation: ConversationDoc | null, spentToday: number, turnId: string, dayStart: number,
  ): Promise<void> {
    const { res } = ctx
    const hangUp = new AbortController()
    const user = ctx.principal?.name ?? trader
    const self = { user, close: () => { hangUp.abort(); if (!res.writableEnded) res.end() } }
    if (!d.streams.add(self, ASSISTANT_STREAMS_PER_USER, ASSISTANT_STREAMS_TOTAL)) {
      ctx.send(503, { error: 'too many assistant streams open — try again shortly', code: 'busy' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive',
    })
    // a client that goes away mid-answer aborts the turn: the model call stops and what finished is stored
    res.on('close', () => { if (!res.writableFinished) hangUp.abort() })
    let lastWrite = d.now()
    const emit: Emit = (e) => { lastWrite = d.now(); sse(res, e) }
    const pingMs = d.pingMs ?? ASSISTANT_PING_MS
    const timer = setInterval(() => {
      if (d.now() - lastWrite >= pingMs) emit({ event: 'ping', data: {} })
    }, Math.min(pingMs, 1_000))
    try {
      await runTurn({
        agent: d.agent, store: d.store, config: d.config, choice: model, tools: d.tools, ledger: d.ledger, log: d.log, now: d.now,
        ...(d.wallClockMs === undefined ? {} : { wallClockMs: d.wallClockMs }),
      }, {
        trader, message: body.message, conversation, stock: body.stock ?? null,
        allowClose: body.allowClose === true, presets: (body.presets ?? []) as typeof PRESET_IDS[number][], view: viewOf(body.view), spentToday,
        turnId, dayStart,
      }, emit, hangUp.signal)
    } catch (e) {
      d.log('assistant chat failed', { error: e instanceof Error ? e.message : String(e) })
      emit({ event: 'error', data: { message: 'the assistant failed on the server', code: 'internal' } })
    } finally {
      clearInterval(timer)
      d.streams.remove(self)
      if (!res.writableEnded) res.end()
    }
  }

  async function list(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    ctx.send(200, await d.store.list(trader))
    return true
  }

  function idOf(ctx: RouteCtx): string {
    const id = ctx.params['id'] ?? ''
    if (!/^c-[0-9a-f-]{36}$/.test(id)) throw new NotFound(`no conversation ${id}`)
    return id
  }

  async function one(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const id = idOf(ctx)
    const doc = await d.store.owned(id, trader)
    if (doc === null) throw new NotFound(`no conversation ${id}`)
    ctx.send(200, conversationView(doc))
    return true
  }

  async function hide(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const id = idOf(ctx)
    if (!(await d.store.hide(id, trader))) throw new NotFound(`no conversation ${id}`)
    ctx.send(200, { id, hidden: true })
    return true
  }

  async function feedback(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const id = idOf(ctx)
    const body = parse(feedbackSchema, await ctx.readJson())
    const record = recordIndex(body.turn)
    if (record === null) throw new BadRequest('turn: feedback is on an answer — an odd index of the conversation\'s turns')
    const ok = await d.store.setFeedback(id, trader, record, { rating: body.rating, note: (body.note ?? '').trim(), at: d.now() })
    if (!ok) throw new NotFound(`no answer ${body.turn} in conversation ${id}`)
    ctx.send(200, { id, turn: body.turn, rating: body.rating })
    return true
  }

  async function usage(ctx: RouteCtx): Promise<boolean> {
    const raw = ctx.url.searchParams.get('days')
    const days = raw === null ? 7 : Number(raw)
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new BadRequest('days must be a whole number from 1 to 90')
    ctx.send(200, await d.store.usage(days))
    return true
  }

  async function exportTurns(ctx: RouteCtx): Promise<boolean> {
    const today = istDate(d.now())
    const from = ctx.url.searchParams.get('from') ?? istDate(d.now() - 6 * DAY_MS)
    const to = ctx.url.searchParams.get('to') ?? today
    if (!isIsoDate(from) || !isIsoDate(to)) throw new BadRequest('from and to must be dates, YYYY-MM-DD')
    const fromMs = Date.parse(`${from}T00:00:00+05:30`)
    const toMs = Date.parse(`${to}T00:00:00+05:30`) + DAY_MS
    if (toMs <= fromMs) throw new BadRequest('to is before from')
    if (toMs - fromMs > EXPORT_MAX_DAYS * DAY_MS) throw new BadRequest(`at most ${EXPORT_MAX_DAYS} days in one export`)
    const res = ctx.res
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="assistant-${from}-${to}.ndjson"`,
    })
    // one document at a time from a cursor; a full socket buffer is waited out, a client that leaves ends the walk
    for await (const doc of d.store.touched(fromMs, toMs)) {
      const lines = doc.turns.filter((t) => t.at >= fromMs && t.at < toMs).map((t) => `${exportLine(doc, t)}\n`).join('')
      if (lines !== '' && !(await writeOrWait(res, lines))) break
      await new Promise<void>((r) => setImmediate(r))   // other requests get a turn between documents
    }
    if (!res.writableEnded) res.end()
    return true
  }
}
