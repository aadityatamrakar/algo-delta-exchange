/**
 * THE PLAYBOOK SUITES' SHARED MARKET — one synthetic NIFTY session the frame,
 * the kit and the strategy suites can all decide against.
 *
 * TEST-ONLY, and not a test file itself (the runner's glob is `*.test.ts`).
 *
 * THE DAY is Friday 16 Oct 2026 against NIFTY's weekly of Monday 19 Oct: one
 * trading day to expiry (`tradingDaysToExpiry` 1), three calendar days of
 * Black-76 tenor. The board is the scenario harness's own (`buildChain`), so
 * every greek and every spread a test reads is the model's rather than a
 * typed-in number, and the index tape is a `SpotRing` filled one print a
 * second — the cadence the host pushes at.
 *
 * WHY A TAPE OBJECT AND NOT A FILLED RING. `SpotRing.latest()` is the
 * playbooks' `S`, and it is the newest sample PUSHED, whatever `nowMs` says.
 * A ring filled to 10:30 and read at 10:00 would hand the frame a level from
 * the future that also reads as fresh. So a `Tape` is advanced to each pass's
 * instant, exactly as the feed would have printed it, and never past it.
 */
import { DEFAULT_DIALS, type Dials } from '../src/dials.ts'
import type { DeltaLeanInputs } from '../src/delta-lean/decide.ts'
import { atmStraddleMid, readRegime, SpotRing, type Regime, type RegimeRead } from '../src/delta-lean/regime.ts'
import type { ForwardSource } from '../src/forward.ts'
import { markLeg, midOf } from '../src/marking.ts'
import {
  EMPTY_PLAYBOOK_STATE,
  EMPTY_RULE_STATE,
  type ChainSnap,
  type LegView,
  type OptType,
  type PlaybookState,
  type RuleState,
  type Side,
} from '../src/types.ts'
import type { OpenAction, OpenPlan, Playbook, PlaybookCtx } from '../src/delta-lean/playbook/types.ts'
import { tradingDaysToExpiry } from '../src/delta-lean/playbook/calendar.ts'
import { buildChain, LOT } from './scenario/chain-model.ts'
import { istMs } from './scenario/paths.ts'
import { minutesToExpiry } from './scenario/sim.ts'

export const DATE = '2026-10-16' // a Friday
export const EXPIRY = '2026-10-19' // NIFTY's weekly, moved to Monday by Dussehra
export const OPEN = 25_000
export const IV = 0.12
export const NIFTY_LOT = LOT.NIFTY

/** Epoch ms of an IST minute of `DATE`; fractional minutes are seconds. */
export const at = (minute: number): number => istMs(DATE, minute)

/** A calm tape: ±4 points on a 200 s period around the open. Two
 * consecutive five-minute windows inside `dl_quiet_mult` x implied, so the
 * detector reads it `quiet` — a reading, not `unknown`. */
export const calm = (ms: number): number => OPEN + 4 * Math.sin((2 * Math.PI * (ms - at(555))) / 200_000)

/** The index feed, printed one sample a second up to the instant asked for. */
export class Tape {
  readonly ring = new SpotRing(32_768)
  readonly level: (ms: number) => number
  readonly stepMs: number
  #lastMs: number
  constructor(level: (ms: number) => number = calm, fromMs: number = at(555), stepMs = 1_000) {
    this.level = level
    this.stepMs = stepMs
    this.#lastMs = fromMs - stepMs
  }
  /** Print every sample up to `ms`; returns the newest level. */
  advanceTo(ms: number): number {
    for (let t = this.#lastMs + this.stepMs; t <= ms; t += this.stepMs) {
      this.ring.push({ ms: t, spot: this.level(t) })
      this.#lastMs = t
    }
    return this.ring.latest()?.spot ?? Number.NaN
  }
  /** Skip printing up to `ms` — a hole in the feed. */
  skipTo(ms: number): void {
    this.#lastMs = Math.max(this.#lastMs, ms)
  }
  get lastMs(): number {
    return this.#lastMs
  }
}

/** The board at `nowMs` on an index level, every quote stamped `quoteAsOf`. */
export function chainAt(
  nowMs: number,
  index: number,
  over: { readonly quoteAsOf?: number; readonly atmIv?: number; readonly expiry?: string } = {},
): ChainSnap {
  const minuteOfDay = Math.floor((nowMs - istMs(DATE, 0)) / 60_000)
  return buildChain({
    symbol: 'NIFTY', expiry: over.expiry ?? EXPIRY, dateIst: DATE, minuteOfDay,
    index, atmIv: over.atmIv ?? IV, nowMs,
    ...(over.quoteAsOf === undefined ? {} : { quoteAsOf: over.quoteAsOf }),
  })
}

/** A held leg marked off `chain` the way the supervisor marks one. `entry`
 * defaults to the quote's mid; `mtm` may be overridden to script a P&L. */
export function legOn(
  chain: ChainSnap,
  strike: number,
  optType: OptType,
  side: Side,
  lots: number,
  over: Partial<LegView> = {},
): LegView {
  const row = chain.strikes.find((r) => Math.abs(r.strike - strike) < 1e-6)
  const q = (optType === 'CE' ? row?.ce : row?.pe) ?? { bid: null, ask: null, ltp: null, asOf: chain.asOf }
  const entry = over.entry ?? midOf(q) ?? 0
  const minuteOfDay = Math.floor((chain.asOf - istMs(DATE, 0)) / 60_000)
  const leg = markLeg(
    { strike, optType, side, lots, lotSize: chain.lotSize, entry, instrument: `NIFTY-${chain.expiry}-${strike}${optType}`, openedByEngine: true, leanId: '' },
    q, chain, DATE, minuteOfDay, 'live',
  )
  return { ...leg, ...over }
}

export interface InputsOver {
  readonly legs?: readonly LegView[]
  readonly chain?: ChainSnap
  readonly cumRealized?: number
  readonly pendingLots?: number
  readonly inFlight?: boolean
  readonly forwardSource?: ForwardSource | undefined
  readonly prevClose?: number | null
  readonly repairHold?: boolean
  readonly ordersThisMinute?: number
  readonly spotAsOf?: number
  readonly dateIst?: string
  readonly expiry?: string
}

/** One pass's inputs: the tape advanced to `nowMs`, the board priced off it. */
export function inputsAt(tape: Tape, nowMs: number, over: InputsOver = {}): DeltaLeanInputs {
  const level = tape.advanceTo(nowMs)
  const chain = over.chain ?? chainAt(nowMs, level)
  const minuteOfDay = Math.floor((nowMs - istMs(DATE, 0)) / 60_000)
  const expiry = over.expiry ?? chain.expiry
  return {
    tag: 'NIFTY-pb-test', mode: 'paper', nowMs, dateIst: over.dateIst ?? DATE, minuteOfDay,
    dte: 3, chain, legs: over.legs ?? [], protectedQty: {}, cumRealized: over.cumRealized ?? 0,
    margin: { value: 0, source: 'model', asOf: nowMs, fresh: false },
    pendingLots: over.pendingLots ?? 0, repairHold: over.repairHold ?? false, pricing: 'live',
    ring: tape.ring, minutesToExpiry: minutesToExpiry(DATE, minuteOfDay, expiry),
    ordersThisMinute: over.ordersThisMinute ?? 0,
    spotAsOf: over.spotAsOf ?? tape.lastMs,
    expiry,
    inFlight: over.inFlight ?? false,
    // The harness board IS the index carried over the tenor, so that is its
    // honest source; a test of the forward gate overrides it, or leaves it out.
    ...(!('forwardSource' in over)
      ? { forwardSource: 'index-carry' as const }
      : over.forwardSource === undefined ? {} : { forwardSource: over.forwardSource }),
    prevClose: over.prevClose ?? null,
  }
}

/** The frame's test dials: a delta-lean book whose `pb_playbook` names the
 * fake below, with a wide window and stops far from the day's backstop so a
 * test reaches the rule it is about. */
export function dialsOf(over: Partial<Dials> = {}): Dials {
  return {
    ...DEFAULT_DIALS,
    delta_lean_enabled: true,
    dl_parity_forward: true,
    dl_open_lots: 0,
    margin_cap: 2_500_000,
    dl_day_max_loss: 50_000,
    dl_day_target: 100_000,
    pb_playbook: 99,
    pb_min_dte: 1,
    pb_lots: 2,
    pb_entry_start_min: 570,
    pb_entry_end_min: 870,
    pb_max_entries: 2,
    pb_reentry_cooldown_s: 600,
    pb_confirm_s: 0,
    pb_trade_max_loss: 6_000,
    pb_trade_target: 12_000,
    pb_trail_start: 0,
    pb_late_trail_start: 2_000,
    pb_late_min: 780,
    pb_trail_keep: 0.6,
    ...over,
  }
}

/** A rule state already rolled to `DATE`, with a playbook state on it. */
export function stateWith(pb: Partial<PlaybookState> = {}, over: Partial<RuleState> = {}): RuleState {
  return {
    ...EMPTY_RULE_STATE,
    dlDayStarted: DATE,
    dlRegimeSinceMs: at(555),
    ...over,
    pb: { ...EMPTY_PLAYBOOK_STATE, ...pb },
  }
}

const buy = (strike: number, optType: OptType): OpenAction => ({ op: 'open', strike, optType, side: 'Buy', lots: 1 })

/** A CE debit spread at the fixture's money: buy the 24,950, sell the 25,150. */
export const SPREAD: OpenPlan = {
  side: 'up',
  protective: [buy(24_950, 'CE')],
  shorts: [{ strike: 25_150, optType: 'CE', cover: 24_950 }],
  lots: 2,
  reason: 'a CE debit spread',
}

/** An iron fly at 25,000 with wings five steps out. */
export const FLY: OpenPlan = {
  side: 'none',
  protective: [buy(25_250, 'CE'), buy(24_750, 'PE')],
  shorts: [
    { strike: 25_000, optType: 'CE', cover: 25_250 },
    { strike: 25_000, optType: 'PE', cover: 24_750 },
  ],
  lots: 2,
  reason: 'an iron fly',
}

/** A scripted playbook: wait, no exits and no adds unless a test says
 * otherwise. Registered under id 99 by the frame suite. */
export function fake(over: Partial<Pick<Playbook, 'enter' | 'exits' | 'adds'>> = {}, id = 99, name = 'fake'): Playbook {
  return {
    id,
    name,
    enter: over.enter ?? (() => ({ kind: 'wait', reason: 'fake: nothing to do' })),
    exits: over.exits ?? (() => ({})),
    adds: over.adds ?? (() => ({})),
  }
}

/**
 * A `PlaybookCtx` for the kit's direct tests, built the way the frame builds
 * one — but by hand, from the fields the kit reads, so a kit test does not
 * depend on the frame deciding to call a playbook at all.
 */
export function ctxOf(inputs: DeltaLeanInputs, dials: Dials, pb: Partial<PlaybookState> = {}): PlaybookCtx {
  const st = stateWith(pb)
  const str = atmStraddleMid(inputs.chain)
  const latest = inputs.ring.latest()
  const read = readRegime(inputs.ring, inputs.chain, inputs.nowMs, inputs.minutesToExpiry, dials, 'unknown', null)
  const total = inputs.cumRealized + inputs.legs.reduce((s, l) => s + l.mtm, 0)
  return {
    inputs, dials, st, pb: st.pb, read, regime: read.slow, regimeHeldMs: 0,
    spot: latest?.spot ?? null,
    spotFresh: latest !== null && inputs.nowMs - latest.ms <= dials.dl_spot_stale_s * 1000,
    fwd: inputs.chain.spot, forwardOk: true, str,
    imp: () => null,
    dayComplete: false, dayRobust: false, dayImplied: null, gapPct: null,
    totalPnl: total, tradePnl: st.pb.tradeOpenMs > 0 ? total - st.pb.basePnl : 0,
    cost: inputs.legs.reduce((s, l) => s + (l.side === 'Buy' ? 1 : -1) * l.entry * l.lots * l.lotSize, 0),
    working: inputs.pendingLots > 0 || inputs.inFlight === true,
    expiryDay: inputs.chain.expiry === inputs.dateIst,
    tradingDte: tradingDaysToExpiry(inputs.dateIst, inputs.chain.expiry),
    nowMs: inputs.nowMs, minuteOfDay: inputs.minuteOfDay,
  }
}

/**
 * A regime READ consistent with a label a unit test sets by hand.
 *
 * The playbooks act on a trend label only while the slow window itself still
 * shows it (`kit.onTape`, spec M11): a hand-set `regime` over the fixture's
 * flat tape would read as the detector's dwell, not a trend. So a unit test
 * that sets `regime` sets the READ with it: a clean move of three implied
 * moves for a trend, a wide range that went nowhere for chop, a narrow one for
 * quiet. `unknown` keeps no stat at all.
 */
export function tapeRead(base: RegimeRead, regime: Regime, implied = 10): RegimeRead {
  const stat = (displacement: number, range: number) => ({
    displacement, range, cleanliness: range > 0 ? Math.abs(displacement) / range : 0, samples: 150, spanMs: 300_000,
  })
  const slowStat =
    regime === 'trend-up' ? stat(3 * implied, 3 * implied)
      : regime === 'trend-down' ? stat(-3 * implied, 3 * implied)
        : regime === 'chop' ? stat(0, 3 * implied)
          : regime === 'quiet' ? stat(0, 0.3 * implied)
            : null
  return { ...base, slow: regime, slowStat, impliedSlow: slowStat === null ? null : implied }
}

