/**
 * THE SESSION DRIVER — one simulated day for ANY decide function, filled at
 * the touch, scored as trades.
 *
 * TEST-ONLY, like everything under `test/scenario/`.
 *
 * WHAT IT STANDS IN FOR. In production the supervisor feeds a `SpotRing` off
 * the index bus, snaps the book's chain, marks its legs with `markLeg`, calls
 * a decide path, persists one of the two states it answers with, and routes
 * the actions to a desk whose paper fills land on the touch. This file is that
 * loop with every moving part replaced by something deterministic:
 *
 *   - every 2 s   the index feed prints into a `SpotRing(32_768)` — except
 *                 inside a hole; a spike is the one print that is wrong;
 *   - every 4 s   a pass: build the chain (frozen inside a quote freeze), mark
 *                 the legs (`'live'`, exit side), call `decide`, persist
 *                 `actions.length > 0 ? stateAfter : markState` — the
 *                 supervisor's own rule (`types.ts`, `markState`) — and fill
 *                 every action at once on that chain: a buy at the ask, a sell
 *                 at the bid;
 *   - an `open` adds to, or nets against, the same instrument; a `close`
 *     takes the whole position off at the touch; a `resize` trades the
 *     difference. Realised rupees fold into `cumRealized` the moment they are
 *     realised, so `cumRealized + Σ mtm` is continuous across a close.
 *
 * BY DEFAULT EVERYTHING FILLS AT ONCE, so nothing is ever working
 * (`pendingLots` 0). `ScenarioSpec.fills` replaces that per action (`paths.ts`
 * `FillOutcome`) with what the host would see: a skip (no leg; an all-open
 * package of skips rolled back to `markState` with its adjust stamp kept), a
 * failure (no leg; `stateAfter` stands), a partial fill, or a fill held back
 * for passes. While
 * one is held back the book is IN FLIGHT, exactly as the supervisor's is: the
 * inputs carry `inFlight` and `pendingLots`, the decision is a mark
 * (`markState` persisted, nothing routed), and only an exit the working
 * package is not already working pre-empts it — cancelling what is pending —
 * so the next pass decides against the book that really exists.
 *
 * TRADES ARE ROUND TRIPS: flat → holding → flat, opened and closed by
 * whichever decision's fills crossed the line. A trade still open when the
 * session ends has `closeMin: null`, and its `pnl` includes the open legs at
 * their exit-side mark — what closing them at the touch would bank.
 *
 * THE NAKED-SHORT COUNT (spec D1, defined risk). A pass is naked when, after
 * its fills, some option type is short more lots than it is long. Coverage is
 * lot for lot by a long of the SAME TYPE AT ANY STRIKE, because on one expiry
 * any long call bounds a short call's loss and any long put a short put's: a
 * debit spread's protective long sits ITM of its short, an iron fly's wing
 * OTM of it, and both are defined risk. Reading "protective" as "further OTM"
 * would score every debit spread naked.
 */

import type { DeltaLeanInputs } from '../../src/delta-lean/decide.ts'
import { SpotRing } from '../../src/delta-lean/regime.ts'
import { resolveDials, type Dials } from '../../src/dials.ts'
import type { MarkContext } from '../../src/guards.ts'
import { bookSpanLegs, spanLiteMargin } from '../../src/margin-project.ts'
import { exitPrice, markLeg } from '../../src/marking.ts'
import { PRESETS } from '../../src/presets.ts'
import { DECISION_CLOCK_CLOSE_MIN, isTradingDay, MARK_STEP_MIN, markOf, SESSION_OPEN_MIN } from '../../src/session.ts'
import {
  EMPTY_RULE_STATE,
  type ChainSnap,
  type EngineAction,
  type EngineDecision,
  type LegView,
  type OptType,
  type Quote,
  type RuleState,
  type Side,
  type Trigger,
  type Urgency,
} from '../../src/types.ts'
import { buildChain, LOT, quoteAt, type ChainArgs } from './chain-model.ts'
import {
  checkSpec, DEFAULT_END_MIN, indexPath, istMs, ivPath, SAMPLE_MS, type FillOutcome, type ScenarioSpec,
} from './paths.ts'

export type DecideFn = (inputs: DeltaLeanInputs, dials: Dials, state: RuleState, markCtx: MarkContext) => EngineDecision

export interface SimTrade {
  readonly openMin: number
  readonly closeMin: number | null
  readonly openTrigger: Trigger
  readonly closeTrigger: Trigger | null
  readonly closeReason: string
  readonly side: string // pb.side at the open ('' for non-playbook decide fns)
  readonly pnl: number // realised over the round trip (flat -> holding -> flat)
}

export interface SimResult {
  readonly decisions: ReadonlyArray<{
    readonly minute: number
    readonly trigger: Trigger
    readonly reason: string
    readonly actions: readonly EngineAction[]
  }>
  readonly trades: readonly SimTrade[]
  readonly finalPnl: number
  readonly minPnl: number
  readonly maxPnl: number
  readonly orders: number
  readonly nakedShortPasses: number // passes where a short leg had no same-type long held to cover it, lot for lot
  readonly finalState: RuleState
  /** How the `fills` hook's outcomes fell: actions skipped, failed, held back,
   * part-filled, and held back but cancelled by a pre-empting exit. */
  readonly outcomes: { readonly skipped: number; readonly failed: number; readonly delayed: number; readonly partial: number; readonly cancelled: number }
}

/** One decision pass every 4 s — two index prints per pass. */
export const PASS_MS = 4_000

/** The supervisor's full-session ring (spec F5): ~9 hours at 1 Hz, all day at 0.5 Hz. */
export const RING_CAPACITY = 32_768

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const SESSION_MINUTES = DECISION_CLOCK_CLOSE_MIN - SESSION_OPEN_MIN
const MAX_EXPIRY_DAYS = 400

function utcDayMs(dateIso: string): number | null {
  const ms = Date.parse(`${dateIso}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : null
}

/**
 * TRADING minutes from `minuteOfDay` on `dateIst` to the 15:30 settle on
 * `expiry` — the supervisor's `tradingMinutesToExpiry`
 * (`apps/supervisor/src/engine-host.ts`), restated rule for rule because a
 * test package must not import an app. Today counts from the minute, clamped
 * into the session; every later trading day counts 375; a weekend or an NSE
 * holiday counts nothing; an expiry already past is 0.
 */
export function minutesToExpiry(dateIst: string, minuteOfDay: number, expiry: string): number {
  const from = utcDayMs(dateIst)
  const to = utcDayMs(expiry)
  if (from === null || to === null || to < from) return 0
  if (to - from > MAX_EXPIRY_DAYS * DAY_MS) return 0
  let minutes = 0
  for (let day = from; day <= to; day += DAY_MS) {
    if (!isTradingDay(new Date(day).toISOString().slice(0, 10))) continue
    if (day !== from) {
      minutes += SESSION_MINUTES
      continue
    }
    const m = Math.min(Math.max(minuteOfDay, SESSION_OPEN_MIN), DECISION_CLOCK_CLOSE_MIN)
    minutes += DECISION_CLOCK_CLOSE_MIN - m
  }
  return minutes
}

/** A preset's dials, resolved — or a throw naming the preset or the dials
 * this build does not know, so a suite never runs on silently-default dials. */
export function presetDials(key: string): Dials {
  const preset = PRESETS.find((p) => p.key === key)
  if (preset === undefined) throw new RangeError(`no preset '${key}'`)
  const { dials, unknown } = resolveDials(preset.dials as Record<string, number | boolean>)
  if (unknown.length > 0) throw new RangeError(`preset '${key}': dials this build does not know: ${unknown.join(', ')}`)
  return dials
}

/** A held position. Mutable, and private to one run. */
interface Position {
  readonly instrument: string
  readonly strike: number
  readonly optType: OptType
  side: Side
  lots: number
  entry: number // per-share, the average fill
}

type QuoteFn = (strike: number, optType: OptType) => Quote

const sideSign = (s: Side): number => (s === 'Buy' ? 1 : -1)
const flip = (s: Side): Side => (s === 'Buy' ? 'Sell' : 'Buy')

/**
 * `pb.side` of a state, read WITHOUT naming `RuleState.pb`: the playbook
 * foundation adds that field, and this harness has to compile and run on
 * both sides of it. '' when the state has none — every non-playbook path.
 */
function playbookSide(state: RuleState): string {
  const pb: unknown = Reflect.get(state, 'pb')
  return typeof pb === 'object' && pb !== null && 'side' in pb && typeof pb.side === 'string' ? pb.side : ''
}

/** One execution at the touch, netted against what is held. Returns the
 * rupees it realised. */
function trade(
  book: Map<string, Position>,
  instrument: string,
  strike: number,
  optType: OptType,
  side: Side,
  lots: number,
  lotSize: number,
  quote: QuoteFn,
): number {
  if (!(lots > 0)) return 0
  const q = quote(strike, optType)
  const px = side === 'Buy' ? q.ask : q.bid
  if (px === null) throw new Error(`${instrument} has no ${side === 'Buy' ? 'ask' : 'bid'} to fill a ${side} on`)
  const held = book.get(instrument)
  if (held === undefined) {
    book.set(instrument, { instrument, strike, optType, side, lots, entry: px })
    return 0
  }
  if (held.side === side) {
    held.entry = (held.entry * held.lots + px * lots) / (held.lots + lots)
    held.lots += lots
    return 0
  }
  const closed = Math.min(lots, held.lots)
  const realised = sideSign(held.side) * (px - held.entry) * closed * lotSize
  held.lots -= closed
  if (held.lots === 0) book.delete(instrument)
  if (lots > closed) book.set(instrument, { instrument, strike, optType, side, lots: lots - closed, entry: px })
  return realised
}

function fill(
  book: Map<string, Position>,
  action: EngineAction,
  name: (strike: number, optType: OptType) => string,
  lotSize: number,
  quote: QuoteFn,
): number {
  if (action.op === 'open') {
    const { strike, optType, side, lots } = action
    return trade(book, name(strike, optType), strike, optType, side, lots, lotSize, quote)
  }
  const held = book.get(action.instrument)
  if (held === undefined) return 0 // nothing to close; the desk would refuse it
  const { instrument, strike, optType } = held
  const target = action.op === 'close' ? 0 : Math.max(0, action.targetLots)
  const diff = target - held.lots
  const side = diff > 0 ? held.side : flip(held.side)
  return trade(book, instrument, strike, optType, side, Math.abs(diff), lotSize, quote)
}

/** Every held position marked as the supervisor marks it: `markLeg`, live
 * pricing, exit side. */
function markBook(
  book: Map<string, Position>,
  lotSize: number,
  quote: QuoteFn,
  chain: ChainSnap,
  dateIst: string,
  minuteOfDay: number,
): LegView[] {
  return [...book.values()].map((p) => markLeg(
    {
      strike: p.strike, optType: p.optType, side: p.side, lots: p.lots, lotSize,
      entry: p.entry, instrument: p.instrument, openedByEngine: true, leanId: '',
    },
    quote(p.strike, p.optType), chain, dateIst, minuteOfDay, 'live',
  ))
}

/** The open book's mark after the fills: `markLeg`'s live arm (exit side,
 * 0 when that side is absent) without the IV solve nobody reads here. */
function bookMtm(book: Map<string, Position>, lotSize: number, quote: QuoteFn): number {
  let mtm = 0
  for (const p of book.values()) {
    const px = exitPrice(quote(p.strike, p.optType), p.side)
    if (px !== null) mtm += sideSign(p.side) * (px - p.entry) * p.lots * lotSize
  }
  return mtm
}

function nakedShort(book: Map<string, Position>): boolean {
  for (const optType of ['CE', 'PE'] as const) {
    let net = 0
    for (const p of book.values()) if (p.optType === optType) net += sideSign(p.side) * p.lots
    if (net < 0) return true
  }
  return false
}

const inside = (windows: ScenarioSpec['holes'], minute: number): boolean =>
  windows?.some((w) => minute >= w.fromMin && minute < w.toMin) ?? false

/** A round trip in progress; `base` is `cumRealized` before its first fill. */
type OpenTrade = Pick<SimTrade, 'openMin' | 'openTrigger' | 'side'> & { readonly base: number }

/** A fill held back by the `fills` hook, due on pass `due`. */
interface Pending {
  readonly due: number
  readonly action: EngineAction
  readonly trigger: Trigger
  readonly reason: string
}

/** The exits that pre-empt a working package: the host's `GUARD_TRIGGERS`
 * on this path (`eod`) and its `DL_EXIT_TRIGGERS`, `dl-exit` included. */
const PREEMPTS: ReadonlySet<Trigger> = new Set<Trigger>(['eod', 'dl-stop', 'dl-target', 'dl-stuck', 'dl-exit'])
const DL_EXITS: ReadonlySet<Trigger> = new Set<Trigger>(['dl-stop', 'dl-target', 'dl-stuck', 'dl-exit'])
/** The wire's two work modes, weakest first; a ladder is worked as urgent. */
const rank = (u: Urgency): number => (u === 'passive' ? 0 : 1)

/** The host's `alreadyWorking`: the working package is this exit already —
 * the same trigger, or `dl-stop` over a delta-lean exit — worked as hard. */
function alreadyWorking(flight: { readonly trigger: Trigger; readonly urgency: Urgency }, trigger: Trigger, urgency: Urgency): boolean {
  const same = flight.trigger === trigger || (trigger === 'dl-stop' && DL_EXITS.has(flight.trigger))
  return same && rank(flight.urgency) >= rank(urgency)
}

/** One action's outcome, normalised: a delay of 0 passes is a fill now. */
type Fate = 'fill' | 'skip' | 'fail' | { readonly delay: number } | { readonly lots: number }
function outcomeOf(o: FillOutcome): Fate {
  if (typeof o === 'string') return o
  if ('delayPasses' in o) {
    if (!Number.isFinite(o.delayPasses)) throw new RangeError(`a delay of ${o.delayPasses} passes`)
    const n = Math.ceil(o.delayPasses)
    return n > 0 ? { delay: n } : 'fill'
  }
  if (!(o.fillLots >= 1) || !Number.isFinite(o.fillLots)) throw new RangeError(`a partial fill of ${o.fillLots} lots`)
  return { lots: Math.floor(o.fillLots) }
}

/** What a partial fill of `lots` executes: that many lots of an open, or that
 * many lots off the position a close takes off (the rest never fills). */
function partialOf(action: EngineAction, lots: number, book: Map<string, Position>): EngineAction {
  if (action.op === 'open') return { ...action, lots: Math.min(action.lots, lots) }
  if (action.op === 'resize') return action
  const held = book.get(action.instrument)?.lots ?? 0
  return { op: 'resize', instrument: action.instrument, targetLots: Math.max(0, held - lots) }
}

/** Run one scenario day through `decide`. See the file header for the loop. */
export function runSession(decide: DecideFn, dials: Dials, spec: ScenarioSpec): SimResult {
  checkSpec(spec)
  const { symbol, dateIst, expiry } = spec
  const printed = indexPath(spec) // what the index feed prints, bad prints and all
  const traded = indexPath({ ...spec, spikes: [] }) // what the options price off
  const iv = ivPath(spec)
  const lotSize = LOT[symbol]
  const name = (strike: number, optType: OptType): string => `${symbol}-${expiry}-${strike}${optType}`
  const midnight = istMs(dateIst, 0)
  const openMs = istMs(dateIst, SESSION_OPEN_MIN)
  const onGrid = (ms: number, round: (x: number) => number): number =>
    openMs + round((ms - openMs) / SAMPLE_MS) * SAMPLE_MS
  const startMs = onGrid(istMs(dateIst, spec.startMin ?? SESSION_OPEN_MIN), Math.ceil)
  const endMs = istMs(dateIst, spec.endMin ?? DEFAULT_END_MIN)
  const toDay = utcDayMs(expiry)
  const fromDay = utcDayMs(dateIst)
  const dte = toDay === null || fromDay === null ? 0 : Math.round((toDay - fromDay) / DAY_MS)

  const ring = new SpotRing(RING_CAPACITY)
  const book = new Map<string, Position>()
  const routedAt: number[] = []
  const decisions: Array<SimResult['decisions'][number]> = []
  const trades: SimTrade[] = []
  const outcomes = { skipped: 0, failed: 0, delayed: 0, partial: 0, cancelled: 0 }
  let state: RuleState = EMPTY_RULE_STATE
  let cumRealized = 0
  let spotAsOf = 0 // the epoch: infinitely stale until the first print
  let orders = 0
  let nakedShortPasses = 0
  let minPnl = Number.POSITIVE_INFINITY
  let maxPnl = Number.NEGATIVE_INFINITY
  let finalPnl = 0
  let lastMark = -1
  let open: OpenTrade | null = null
  let pending: Pending[] = []
  let flight: { readonly trigger: Trigger; readonly urgency: Urgency } | null = null
  let passIndex = -1

  for (let t = startMs; t <= endMs; t += SAMPLE_MS) {
    const minute = (t - midnight) / MINUTE_MS
    if (!inside(spec.holes, minute)) {
      ring.push({ ms: t, spot: printed(t) })
      spotAsOf = t
    }
    if ((t - startMs) % PASS_MS !== 0) continue
    passIndex += 1

    const minuteOfDay = Math.floor(minute)
    // Inside a freeze the board is the one its first instant quoted, stamped
    // then: the index and the vol move on, the quotes do not.
    const freeze = spec.quoteFreezes?.find((w) => minute >= w.fromMin && minute < w.toMin)
    const quotedAt = freeze === undefined ? t : onGrid(istMs(dateIst, freeze.fromMin), Math.floor)
    const args: ChainArgs = {
      symbol, expiry, dateIst,
      minuteOfDay: Math.floor((quotedAt - midnight) / MINUTE_MS),
      index: traded(quotedAt), atmIv: iv(quotedAt), nowMs: t, quoteAsOf: quotedAt,
    }
    const chain = buildChain(args)
    const listed = new Map(chain.strikes.map((r) => [r.strike, r]))
    const quote: QuoteFn = (strike, optType) => {
      const row = listed.get(strike)
      return (optType === 'CE' ? row?.ce : row?.pe) ?? quoteAt(args, strike, optType)
    }
    /** Execute one action at this pass's touch, and score the round trip it
     * opens or closes against the decision that ROUTED it. */
    const execute = (action: EngineAction, trigger: Trigger, reason: string): void => {
      const wasHolding = book.size > 0
      const before = cumRealized
      cumRealized += fill(book, action, name, lotSize, quote)
      if (!wasHolding && book.size > 0) {
        open = { openMin: minuteOfDay, openTrigger: trigger, side: playbookSide(state), base: before }
      } else if (wasHolding && book.size === 0 && open !== null) {
        const { base, ...opened } = open
        trades.push({ ...opened, closeMin: minuteOfDay, closeTrigger: trigger, closeReason: reason, pnl: cumRealized - base })
        open = null
      }
    }

    // A held-back fill lands at the start of the pass it is due on, before
    // the book is marked: the decision sees the book the desk now holds.
    for (const p of pending.filter((x) => x.due <= passIndex)) execute(p.action, p.trigger, p.reason)
    pending = pending.filter((x) => x.due > passIndex)
    if (pending.length === 0) flight = null

    const legs = markBook(book, lotSize, quote, chain, dateIst, minuteOfDay)
    while (routedAt.length > 0 && (routedAt[0] ?? Number.POSITIVE_INFINITY) <= t - MINUTE_MS) routedAt.shift()
    let pendingLots = 0
    for (const p of pending) {
      const a = p.action
      const held = a.op === 'open' ? 0 : (book.get(a.instrument)?.lots ?? 0)
      pendingLots += a.op === 'open' ? a.lots : a.op === 'close' ? held : Math.abs(held - a.targetLots)
    }
    const inputs: DeltaLeanInputs = {
      tag: spec.name, mode: 'paper', nowMs: t, dateIst, minuteOfDay, dte, chain, legs,
      protectedQty: {}, cumRealized,
      // The book's own SPAN-lite figure, as a model read — never a broker one.
      margin: {
        value: spanLiteMargin(bookSpanLegs(legs, expiry), chain.spot, dateIst).total,
        source: 'model', asOf: t, fresh: false,
      },
      // Nothing is ever under repair; something is working only while a fill
      // is held back.
      pendingLots, repairHold: false, pricing: 'live',
      ring, minutesToExpiry: minutesToExpiry(dateIst, minuteOfDay, expiry),
      ordersThisMinute: routedAt.length, spotAsOf, expiry,
      inFlight: flight !== null,
      forwardSource: spec.forwardSource ?? 'index-carry',
      prevClose: spec.prevClose ?? null,
    }
    const mark = markOf(minuteOfDay)
    const markCtx: MarkContext = {
      isNewMark: mark !== lastMark,
      markIndexToday: Math.max(0, (mark - SESSION_OPEN_MIN) / MARK_STEP_MIN),
    }
    lastMark = mark

    const decision = decide(inputs, dials, state, markCtx)
    const { trigger, reason, actions } = decision
    decisions.push({ minute: minuteOfDay, trigger, reason, actions })

    if (flight !== null) {
      // IN FLIGHT: the host decides, persists the mark and routes nothing. An
      // exit that ACTS — closes or not — and that the working package is not
      // already working pre-empts it, as the host's `#watchWhileWorking` does.
      state = decision.markState
      if (decision.action !== 'hold' && PREEMPTS.has(trigger) && !alreadyWorking(flight, trigger, decision.urgency)) {
        outcomes.cancelled += pending.length
        pending = []
        flight = null
      }
    } else if (actions.length > 0) {
      const fates = actions.map((a) => outcomeOf(spec.fills?.(passIndex, a) ?? 'fill'))
      orders += actions.length
      for (let i = 0; i < actions.length; i += 1) routedAt.push(t)
      if (fates.every((f) => f === 'skip') && actions.every((a) => a.op === 'open')) {
        // desk-api skipped the whole open: the host folds it as a refusal,
        // back to the mark with the adjust stamp kept, and gives the budget back.
        state = {
          ...decision.markState,
          lastActionMs: decision.stateAfter.lastActionMs,
          dlLastAdjustMs: decision.stateAfter.dlLastAdjustMs,
        }
        routedAt.splice(routedAt.length - actions.length, actions.length)
      } else {
        state = decision.stateAfter
      }
      actions.forEach((action, i) => {
        const fate = fates[i] ?? 'fill'
        if (fate === 'fill') execute(action, trigger, reason)
        else if (fate === 'skip') outcomes.skipped += 1
        else if (fate === 'fail') outcomes.failed += 1
        else if ('delay' in fate) {
          outcomes.delayed += 1
          pending.push({ due: passIndex + fate.delay, action, trigger, reason })
        } else {
          outcomes.partial += 1
          execute(partialOf(action, fate.lots, book), trigger, reason)
        }
      })
      if (pending.length > 0) flight = { trigger, urgency: decision.urgency }
    } else {
      state = decision.markState
    }

    const pnl = cumRealized + bookMtm(book, lotSize, quote)
    finalPnl = pnl
    minPnl = Math.min(minPnl, pnl)
    maxPnl = Math.max(maxPnl, pnl)
    if (nakedShort(book)) nakedShortPasses += 1
  }

  if (open !== null) {
    const { base, ...opened } = open as OpenTrade
    trades.push({ ...opened, closeMin: null, closeTrigger: null, closeReason: '', pnl: finalPnl - base })
  }
  const passed = decisions.length > 0
  return {
    decisions, trades, finalPnl,
    minPnl: passed ? minPnl : 0, maxPnl: passed ? maxPnl : 0,
    orders, nakedShortPasses, finalState: state, outcomes,
  }
}
