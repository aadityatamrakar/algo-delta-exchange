/**
 * What every assistant tool shares: the deps it reads through, the turn's
 * context (`ToolCtx`), the plain-function tool shape, and the R9 envelope.
 *
 * No tool takes a trader argument. `ToolCtx.trader` is bound once per turn
 * from the session by the same `whose()` every route uses (an admin's `?as=`
 * works as everywhere), so a model cannot ask for another trader's book. The
 * `allowClose`, `presets` and `view` fields come from the request body only
 * (spec R6): nothing a model writes can set them.
 *
 * Tools return plain data (`ToolOutcome`): `result` is what the model sees,
 * `cards` what the page gets. `ai-tools.ts` adapts them to the library.
 */

import type { z } from 'zod'
import type { PresetId } from '@algomaker/payoff'
import { marketOpenAt } from '../../analytics/calendar.ts'
import { STOCK_RE } from '../../books/manual.ts'
import { FEED_NOT_TICKING } from '../../market/quotes.ts'
import type { R3RouteDeps } from '../../routes/r3-deps.ts'
import type { AssistantCard, ViewChoice } from '../wire.ts'
import type { LegAliases, Redactor } from '../redact.ts'
import type { PlanCache } from './plans.ts'

/** The app's bag, as the agent reads it: TradersDeps (with Lane 2's history, intraday and marketContext) and Release 3's stores. */
export type AgentDeps = R3RouteDeps

/** Per-turn counters, enforced outside the model (spec R10). */
export interface TurnCounters {
  toolCalls: number
  searches: number
}

export interface ToolCtx {
  readonly trader: string
  readonly deps: AgentDeps
  readonly aliases: LegAliases
  readonly plans: PlanCache
  readonly redactor: Redactor
  readonly counters: TurnCounters
  /** The page's "Allow closing legs" checkbox (R6): from the request body, never from the model. */
  readonly allowClose: boolean
  /** The trader's own words this turn, as typed: what R6 checks a close or shift the model proposes against. */
  readonly userText: string
  readonly presets: readonly PresetId[]
  readonly view: ViewChoice | null
  /** The book the page is on, when it is on one. */
  readonly stock: string | null
  /** Card ids, unique in the conversation. */
  nextCardId(): string
}

export interface ToolOutcome {
  /** What the model sees: plain data with the R9 envelope, built from an allowlist. */
  readonly result: Readonly<Record<string, unknown>>
  readonly cards?: readonly AssistantCard[]
  /** One short line for the tool chip. */
  readonly summary?: string
}

export interface AgentTool<I = unknown> {
  readonly name: string
  readonly description: string
  readonly input: z.ZodType<I>
  /** A chip label for this call: "reading TCS". */
  label(input: I): string
  /** Counts against the per-turn search cap (R10). */
  readonly search?: boolean
  run(ctx: ToolCtx, input: I): Promise<ToolOutcome>
}

/** A tool with its input type erased, for the list the loop runs: the library validates the input against `input` first. */
export interface AnyTool {
  readonly name: string
  readonly description: string
  readonly input: z.ZodType
  label(input: never): string
  readonly search?: boolean
  run(ctx: ToolCtx, input: never): Promise<ToolOutcome>
}

/** A tool's refusal the model should read and act on (a bad stock, no book). Its message is ours, never a library's. */
export class ToolRefusal extends Error {}

/** R9: when, whether the market is shut, whether the feed ticks, whether anything read was stale, and what to say about it. */
export interface Envelope {
  readonly asOf: number
  readonly closed: boolean
  readonly feedAlive: boolean
  readonly stale: boolean
  readonly warnings: readonly string[]
}

export const CLOSED_WARNING = 'the market is closed: prices are the last session\'s — every figure is indicative'
export const DEAD_FEED_WARNING = 'the price feed is not ticking: prices are the last seen — every figure is indicative'

/** `closed` defaults to the session clock at `asOf` (which defaults to now). */
export function envelope(ctx: ToolCtx, o: { readonly asOf?: number; readonly closed?: boolean; readonly stale?: boolean; readonly warnings?: readonly string[] } = {}): Envelope {
  const asOf = o.asOf ?? ctx.deps.now()
  const closed = o.closed ?? !marketOpenAt(asOf)
  const feedAlive = ctx.deps.quotes.feedAlive()
  const warnings: string[] = []
  if (closed) warnings.push(CLOSED_WARNING)
  else if (!feedAlive) warnings.push(DEAD_FEED_WARNING)
  for (const w of o.warnings ?? []) if (!warnings.includes(w)) warnings.push(w)
  return { asOf, closed, feedAlive, stale: (o.stale ?? false) || closed || !feedAlive, warnings }
}

/**
 * Server-authored warning lines a tool result may carry (R11). A book view's
 * warnings also name uploaded files and quote their parse errors; those never
 * reach the model — they are counted in one line instead.
 */
const SAFE_LINES: readonly RegExp[] = [
  /^no watcher has reported for this trader yet/,
  /^the watcher has not reported since \d\d:\d\d/,
  /^no spot price for [A-Z0-9&-]{1,20} yet$/,
  /^[A-Z0-9&-]{1,20} (spot|FUT \d{4}-\d{2}-\d{2}) price is stale — last tick \d\d:\d\d$/,
  /^price coverage reduced — the traders feed cap \(\d+ tokens\) is reached$/,
  /^(shares|FUT \d{4}-\d{2}-\d{2}|[\d.]+ (CE|PE) \d{4}-\d{2}-\d{2}): (no price yet|expired at today's close|no vol solved from the \d{4}-\d{2}-\d{2} chain) — left out of the (MTM|greeks)$/,
  /^\d+ expired leg\(s\) hidden/,
  /^delivered shares from the \d{4}-\d{2}-\d{2} expiry are in the book at ₹[\d,]+\.\d{2} \([+-]?\d+ shares\)$/,
  /^settlement takes every ITM stock option as exercised, and charges no exercise STT or stamp duty on delivery$/,
  /^a manual share leg is in this book beside delivered shares the settlement booked/,
  /^no price for \d{4}-\d{2}-\d{2} yet — that month's legs are not priced$/,
  /^\d{4}-\d{2}-\d{2} is valued off spot carried to expiry/,
]

export function safeWarnings(lines: readonly string[]): string[] {
  const out: string[] = []
  let withheld = 0
  for (const l of lines) {
    if (l === FEED_NOT_TICKING) continue   // the envelope says it in its own words
    if (SAFE_LINES.some((re) => re.test(l))) out.push(l)
    else withheld++
  }
  if (withheld > 0) out.push(`${withheld} more ${withheld === 1 ? 'note' : 'notes'} on the book page (uploaded files or contracts the master does not know)`)
  return out
}

/**
 * R11: a symbol is free text from an uploaded file until it passes STOCK_RE.
 * The ingest keeps whatever a file says (skipping a line could hide a real
 * trade); the agent drops every row whose symbol is not an NSE symbol before
 * the model sees it, and says how many in its own words.
 */
export function nseRows<T>(rows: readonly T[], symbolOf: (r: T) => unknown): { readonly rows: T[]; readonly dropped: number } {
  const kept = rows.filter((r) => {
    const s = symbolOf(r)
    return s === undefined || s === null || (typeof s === 'string' && STOCK_RE.test(s))
  })
  return { rows: kept, dropped: rows.length - kept.length }
}

export const droppedSymbols = (n: number): string =>
  `${n} ${n === 1 ? 'row was' : 'rows were'} left out: ${n === 1 ? 'its symbol is' : 'their symbols are'} not an NSE symbol (see the book pages)`

/** Rounds to 2 decimals (rupees) or 4 (greeks, vols): no float noise in a prompt. */
export const r2 = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null)
export const r4 = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)
