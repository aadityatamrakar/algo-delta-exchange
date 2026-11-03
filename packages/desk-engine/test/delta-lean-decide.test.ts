/**
 * THE ORDER OF THESE CHECKS IS THE RISK MODEL.
 *
 * `decideDeltaLean` is the second decide path and it has no parity fixtures —
 * nothing recorded this book, because this book has never run. So the ORDER is
 * what this file is for, and every test below pins one ordering that is only
 * ever visible as a bug in money:
 *
 *   - ADDS ONLY UNTIL THE CLOSE (spec D2). Four things may close a leg: the
 *     flatten windows, the day-loss backstop, the day target and the stuck
 *     exit. Section 8's scripted day asserts that nothing else ever does,
 *     across a whole synthetic session of regime changes.
 *   - A latched stop is TERMINAL. It sits above the clock and above everything
 *     the regime has to say, so a book that stopped itself cannot be talked
 *     back in by a tape that looks good.
 *   - A flatten that sat below the session gate would never fire on a restart
 *     after 15:00 — and `apps/supervisor/src/main.ts` forbids a SIGTERM
 *     square-off, so that restart is the only thing between a hung book and the
 *     overnight carry D4 forbids.
 *   - THE SAME REGIME NEVER JUSTIFIES TWO PACKAGES IN A ROW. A CHURN GUARD: it
 *     turns "add when the trend is on" into "add when the tape changed its mind
 *     and came back". It used to be load-bearing as well, because `D` was
 *     defined off the long band alone and a fresh open read as short of its own
 *     posture; the amended §6.2 defines `D` as the hedged pair's own net delta,
 *     so the open meets its posture outright and this gate now only bounds how
 *     OFTEN a genuine shortfall may be topped up.
 *   - `'unknown'` is not `'quiet'`. Quiet is the regime that SELLS premium, and
 *     a strangle sold into a chain that stopped printing is the worst thing
 *     this path can cause.
 *
 * THE FIXTURE is a NIFTY-shaped weekly board, hand-derivable and built from
 * real `b76Price` marks so every greek below is the model's rather than a
 * typed-in number: 41 strikes (23,000…25,000 by 50) around spot 24,000, lot 65,
 * six calendar days to expiry, quoted so each MID is exactly the Black-76 price
 * at vol 0.12. The delta bands therefore land on real strikes:
 *
 *   debit 'up'     buy 23,950 CE (δ 0.556)   sell 24,200 CE (δ 0.297)
 *   debit 'down'   buy 24,050 PE (δ 0.550)   sell 23,800 PE (δ 0.290)
 *   credit 'up'    buy 23,500 PE (δ 0.084)   sell 23,800 PE (δ 0.290)
 *   credit 'down'  buy 24,500 CE (δ 0.091)   sell 24,200 CE (δ 0.297)
 *   neutral CE     23,950 CE (δ 0.556) — the ONLY call in the 0.45-0.60 band
 *   neutral PE     24,050 PE (δ 0.550) — the ONLY put in it
 *
 * Those last two are exact and load-bearing: 24,050 CE is δ 0.449 and 23,900 CE
 * is δ 0.609, so the call band holds ONE tradable strike and the put band one
 * too. The `flat` sale may not land on a strike the book holds LONG — an
 * opposite-side fill on a held instrument is netted downstream into a partial
 * CLOSE of that leg — so on this board a book long the band's own strike has
 * nowhere to sell and takes the "no tradable strike in the band" wait. That is
 * why the FLAT and the cap/stuck fixtures below hold 23,900 CE and 24,100 PE
 * rather than the band strikes themselves: they are testing the sale, not the
 * refusal, and the refusal has tests of its own.
 *
 * THE TAPE is a `SpotRing` filled one sample a second, exactly as the host
 * fills it. Every regime below is REACHED through `readRegime` rather than
 * injected, because the composition of detector and controller is the thing
 * this task builds — a test that stubbed the regime would pass with the two
 * wired together backwards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import { DEFAULT_DIALS, resolveDials, type Dials } from '../src/dials.ts'
import { PRESETS } from '../src/presets.ts'
import { RISK_FREE, strikeGreeks } from '../src/marking.ts'
import { bookSpanLegs, openSpanLeg, spanLiteMargin } from '../src/margin-project.ts'
import { EMPTY_RULE_STATE } from '../src/types.ts'
import type {
  ChainSnap,
  EngineAction,
  LegView,
  MarginInput,
  OptType,
  Quote,
  RuleState,
  Side,
} from '../src/types.ts'
import type { MarkContext } from '../src/guards.ts'
import { type Regime, SpotRing } from '../src/delta-lean/regime.ts'
import { decideDeltaLean, type DeltaLeanInputs } from '../src/delta-lean/decide.ts'

const DATE = '2026-09-16'   // a Wednesday
const NEXT_DAY = '2026-09-17' // the Thursday after it — both NSE trading days
const EXPIRY = '2026-09-22' // the following Tuesday: NIFTY's weekly (spec §3)
const MINUTE = 600          // 10:00 IST, comfortably inside the session
const DTE = 6
const T6 = DTE / 365
const VOL = 0.12            // an index vol, not a single-stock one
const SPOT = 24_000
const STEP = 50
const LOT = 65              // NIFTY, as of Jan 2026
/** 2026-09-16 10:00 IST as an epoch. A real instant, never `Date.now()`. */
const NOW = Date.UTC(2026, 8, 16, 4, 30)
/** Trading minutes from 10:00 on the 16th to the 22nd close: 330 left today
 * plus four whole sessions (17th, 18th, 21st, 22nd). */
const MTX = 330 + 4 * 375

const q = (bid: number, ask: number, asOf = NOW): Quote => ({ bid, ask, ltp: null, asOf })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so the IV
 * solve returns `VOL` and every greek is the model's. The 1% spread is inside
 * `dl_max_spread_pct` at every strike the bands reach. */
function bookAt(strike: number, type: OptType, asOf = NOW): Quote {
  const px = b76Price({ future: SPOT, strike, t: T6, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.995, px * 1.005, asOf)
}

const LADDER = Array.from({ length: 41 }, (_, i) => 23_000 + i * STEP)

function chainOf(over: Partial<ChainSnap> = {}): ChainSnap {
  return {
    symbol: 'NIFTY',
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: q(SPOT - 0.5, SPOT + 0.5),
    spot: SPOT,
    strikes: LADDER.map((k) => ({ strike: k, ce: bookAt(k, 'CE'), pe: bookAt(k, 'PE') })),
    asOf: NOW,
    ...over,
  }
}

const CHAIN = chainOf()

/**
 * THE SAME LADDER AT A DIFFERENT FORWARD — a session where the index moved.
 *
 * Every quote is re-priced with `b76Price` at `future`, so the IV still solves
 * to `VOL` and every delta is the model's AT THE NEW SPOT rather than a number
 * typed in. This is how a fixture expresses the one thing the static board
 * cannot: a leg the book SOLD at 0.20-0.30 delta drifting up into the
 * `dl_long_delta` band the adds select from.
 */
function chainAt(future: number): ChainSnap {
  const px = (strike: number, type: OptType): Quote => {
    const p = b76Price({ future, strike, t: T6, vol: VOL, rate: RISK_FREE, type })
    return q(p * 0.995, p * 1.005)
  }
  return {
    ...CHAIN,
    future: q(future - 0.5, future + 0.5),
    spot: future,
    strikes: LADDER.map((k) => ({ strike: k, ce: px(k, 'CE'), pe: px(k, 'PE') })),
  }
}

/** The per-share |delta| of a strike on this board, as `markLeg` stores it. */
function deltaOf(strike: number, optType: OptType): number {
  const g = strikeGreeks(CHAIN, strike, optType, DATE, MINUTE)
  assert.ok(g !== null, `${strike} ${optType} must be measurable on this board`)
  return Math.abs(g.delta)
}

const D_23950_CE = deltaOf(23_950, 'CE')
const D_24200_CE = deltaOf(24_200, 'CE')
const D_24050_PE = deltaOf(24_050, 'PE')

// ── the tape ────────────────────────────────────────────────────────────────

/** One sample a second over `[endMs - seconds*1000, endMs]`, priced by `fn(t)`
 * where `t` counts seconds from the START of the fill — exactly the cadence the
 * host pushes at. */
function fill(ring: SpotRing, endMs: number, seconds: number, fn: (t: number) => number): void {
  for (let t = 0; t <= seconds; t++) ring.push({ ms: endMs - (seconds - t) * 1000, spot: fn(t) })
}

/** A clean 300-point ramp over the last fifteen minutes, ENDING at `SPOT` so
 * the tape and the board agree on where the index is. ~19x the 5-minute implied
 * move, so all three windows read the same trend. */
function trending(dirSign: 1 | -1, endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, 900, (t) => SPOT - dirSign * 300 * (1 - t / 900))
  return ring
}

/** Fifteen minutes inside an 8-point band: a range well under `dl_quiet_mult` x
 * implied on BOTH the slow window and the one before it, which is what
 * `readRegime` demands before it will say quiet at all. */
function quietTape(endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, 900, (t) => SPOT + 4 * Math.sin((2 * Math.PI * t) / 200))
  return ring
}

/** A 60-point sine on a 5-minute period: every whole window has displacement 0
 * and a range four times the quiet bar. Chop under either trend multiplier. */
function choppy(endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, 900, (t) => SPOT + 30 * Math.sin((2 * Math.PI * t) / 300))
  return ring
}

/** No ticks at all: the feed died. Every window is `null`, the read is
 * `'unknown'`, and an unknown regime must open NOTHING. */
const DEAD_FEED = new SpotRing(4096)

// ── legs ────────────────────────────────────────────────────────────────────

/** A held leg, marked off the same board with the same signs `markLeg` uses:
 * `delta` an unsigned magnitude, `theta` and `gamma` the CONTRACT's, unsigned
 * by side. Nothing here is hand-typed. */
function legAt(
  strike: number,
  optType: OptType,
  side: Side,
  lots: number,
  over: Partial<LegView> = {},
): LegView {
  const g = strikeGreeks(CHAIN, strike, optType, DATE, MINUTE)
  assert.ok(g !== null, `${strike} ${optType} must be measurable on this board`)
  const row = CHAIN.strikes.find((s) => s.strike === strike)
  assert.ok(row !== undefined)
  const quote = optType === 'CE' ? row.ce : row.pe
  assert.ok(quote !== null)
  return {
    instrument: `NIFTY26SEP${strike}${optType}`,
    strike,
    optType,
    side,
    lots,
    lotSize: LOT,
    entry: 100,
    openedByEngine: true,
    // Unstamped. The hold-and-adjust engine writes no lean id at all.
    leanId: '',
    iv: g.iv,
    delta: Math.abs(g.delta),
    gamma: g.gamma,
    theta: g.theta,
    vega: g.vega,
    hasGreeks: true,
    mtm: 0,
    exit: quote,
    ...over,
  }
}

/** `legAt`, marked off a board other than `CHAIN` — for the drifted-forward
 * fixture, where the whole point is that the greeks are the NEW board's. */
function legOn(
  chain: ChainSnap,
  strike: number,
  optType: OptType,
  side: Side,
  lots: number,
  over: Partial<LegView> = {},
): LegView {
  const g = strikeGreeks(chain, strike, optType, DATE, MINUTE)
  assert.ok(g !== null, `${strike} ${optType} must be measurable on this board`)
  const row = chain.strikes.find((s) => s.strike === strike)
  assert.ok(row !== undefined)
  const quote = optType === 'CE' ? row.ce : row.pe
  assert.ok(quote !== null)
  return {
    instrument: `NIFTY26SEP${strike}${optType}`,
    strike,
    optType,
    side,
    lots,
    lotSize: LOT,
    entry: 100,
    openedByEngine: true,
    leanId: '',
    iv: g.iv,
    delta: Math.abs(g.delta),
    gamma: g.gamma,
    theta: g.theta,
    vega: g.vega,
    hasGreeks: true,
    mtm: 0,
    exit: quote,
    ...over,
  }
}

/** The book a `trend-up` open leaves behind: 4 lots long the 23,950 CE and 4
 * short the 24,200 CE. Net ≈ 4 × (0.556 − 0.297) ≈ +1.04 delta-lots. */
const OPENED_UP = (lots = 4): LegView[] => [
  legAt(23_950, 'CE', 'Buy', lots),
  legAt(24_200, 'CE', 'Sell', lots),
]

// ── inputs ──────────────────────────────────────────────────────────────────

const MARGIN: MarginInput = { value: 0, source: 'broker', asOf: NOW, fresh: true }

interface Over {
  readonly ring?: SpotRing
  readonly legs?: readonly LegView[]
  readonly minuteOfDay?: number
  readonly dateIst?: string
  readonly cumRealized?: number
  readonly chain?: ChainSnap
  readonly margin?: MarginInput
  readonly pendingLots?: number
  readonly repairHold?: boolean
  readonly spotAsOf?: number
  readonly ordersThisMinute?: number
  readonly nowMs?: number
  readonly expiry?: string
}

function inputsIn(over: Over = {}): DeltaLeanInputs {
  return {
    tag: 'NIFTY-DL',
    mode: 'paper',
    nowMs: over.nowMs ?? NOW,
    dateIst: over.dateIst ?? DATE,
    minuteOfDay: over.minuteOfDay ?? MINUTE,
    dte: DTE,
    chain: over.chain ?? CHAIN,
    legs: over.legs ?? [],
    protectedQty: {},
    cumRealized: over.cumRealized ?? 0,
    margin: over.margin ?? MARGIN,
    pendingLots: over.pendingLots ?? 0,
    repairHold: over.repairHold ?? false,
    pricing: 'live',
    ring: over.ring ?? DEAD_FEED,
    minutesToExpiry: MTX,
    ordersThisMinute: over.ordersThisMinute ?? 0,
    spotAsOf: over.spotAsOf ?? (over.nowMs ?? NOW),
    expiry: over.expiry ?? EXPIRY,
  }
}

const DIALS: Dials = DEFAULT_DIALS
const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })

/** Inert on this path — the delta-lean book evaluates every second and owns no
 * 5-minute mark grid (spec §10). Passed because the signature takes it. */
const MARK: MarkContext = { isNewMark: true, markIndexToday: 9 }

/** A state that has already rolled for `DATE`, so `rollDay` is a no-op and the
 * test is about the rule under it rather than about the auto-start. The regime
 * clock is set an hour back, so `dl_adjust_confirm_s` is satisfied the moment
 * the detector agrees with `dlRegime` — which `dlRegime: ''` never does, so a
 * test that needs a CONFIRMED regime uses `settled` below and not this. */
const TODAY: RuleState = {
  ...EMPTY_RULE_STATE,
  dlDayStarted: DATE,
  dlRegimeSinceMs: NOW - 3_600_000,
}

/** A book that has already opened `side` and is past its cooldown. */
function opened(side: 'up' | 'down' | 'none', over: Partial<RuleState> = {}): RuleState {
  return {
    ...TODAY,
    dlOpenedMs: NOW - 3_600_000,
    dlOpenSide: side,
    dlLastAdjustMs: NOW - 3_600_000,
    dlLastAdjustRegime: side === 'up' ? 'trend-up' : side === 'down' ? 'trend-down' : 'quiet',
    ...over,
  }
}

/**
 * `opened`, with the detector's own label ALREADY STORED and an hour old too.
 *
 * `opened` alone leaves `dlRegime` at `''`, which `prevRegime` reads as
 * `'unknown'` — so the first read of ANY tape is a CHANGE, `decideDeltaLean`
 * restamps `dlRegimeSinceMs` to now, and every adjustment below would die on
 * the confirm gate rather than on the rule it is meant to be testing. The
 * regime named here is the one the tape passed in the same call really
 * classifies as; section 1 pins that correspondence, so this stubs nothing.
 */
function openedOn(
  regime: Regime,
  side: 'up' | 'down' | 'none',
  over: Partial<RuleState> = {},
): RuleState {
  return opened(side, { dlRegime: regime, dlRegimeSinceMs: NOW - 3_600_000, ...over })
}

/**
 * `TODAY` with the detector's own label ALREADY STORED and an hour old, so the
 * read agrees with the row, nothing restamps, and `dl_adjust_confirm_s` is
 * satisfied on the first tick.
 *
 * `TODAY` alone cannot express this and the open tests must not use it:
 * `TODAY.dlRegime` is `''`, which `prevRegime` reads as `'unknown'`, so the
 * first read of ANY tape is a CHANGE and `decideDeltaLean` restamps
 * `dlRegimeSinceMs` to `nowMs` — a zero-second-old reading that correctly
 * confirms nothing. That is the engine being right about a cold row, not a
 * gate to work around.
 */
function settled(regime: Regime, over: Partial<RuleState> = {}): RuleState {
  return { ...TODAY, dlRegime: regime, dlRegimeSinceMs: NOW - 3_600_000, ...over }
}

/** The `'open'` arm, narrowed once so every assertion can read a `strike` and
 * an `optType` without re-narrowing at the call site. */
type OpenAction = Extract<EngineAction, { op: 'open' }>

const opens = (actions: readonly EngineAction[]): OpenAction[] =>
  actions.filter((a): a is OpenAction => a.op === 'open')
const sells = (actions: readonly EngineAction[]): OpenAction[] =>
  opens(actions).filter((a) => a.side === 'Sell')
const buys = (actions: readonly EngineAction[]): OpenAction[] =>
  opens(actions).filter((a) => a.side === 'Buy')
const exits = (actions: readonly EngineAction[]): readonly EngineAction[] =>
  actions.filter((a) => a.op === 'close' || a.op === 'resize')

/** What `spanLiteMargin` prices `held` plus `actions` at, with the opens at
 * `lots` a leg and `lotSize` a lot — built from the engine's OWN `bookSpanLegs`
 * and `openSpanLeg`, so a cap in a test is a number the engine will agree with
 * rather than one guessed at. */
function spanTotalOf(
  actions: readonly EngineAction[],
  lots: number,
  held: readonly LegView[] = [],
  lotSize: number = LOT,
): number {
  const legs = [
    ...bookSpanLegs(held, EXPIRY),
    ...opens(actions).map((a) => openSpanLeg({ ...a, lots }, lotSize, EXPIRY)),
  ]
  return spanLiteMargin(legs, SPOT, DATE).total
}

/** The largest size in `[1, dl_open_lots]` that fits `cap` when the opens are
 * priced at `lotSize` a lot — `fitLots`'s walk, spelled out so a test can ask
 * what EACH candidate lot-size rule would have answered. */
function fitAt(
  actions: readonly EngineAction[],
  held: readonly LegView[],
  lotSize: number,
  cap: number,
): number {
  for (let n = DEFAULT_DIALS.dl_open_lots; n >= 1; n -= 1) {
    if (spanTotalOf(actions, n, held, lotSize) <= cap) return n
  }
  return 0
}

/** A minute-of-day as `HH:MM`, so an assertion message names a time an operator
 * can find on a chart. */
const clockOf = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// ════════════════════════════════════════════════ 1. the tape reads as built

test('the fixture tapes reach the regimes the rest of this file assumes', () => {
  // Not a tautology: every controller test below is only testing what it claims
  // if the tape actually classifies. A drifting dial or a changed MIN_SPAN_FRAC
  // would otherwise turn half this file green for the wrong reason.
  const read = (ring: SpotRing): string =>
    decideDeltaLean(inputsIn({ ring }), DIALS, TODAY, MARK).stateAfter.dlRegime
  assert.equal(read(trending(1)), 'trend-up')
  assert.equal(read(trending(-1)), 'trend-down')
  assert.equal(read(quietTape()), 'quiet')
  assert.equal(read(choppy()), 'chop')
  assert.equal(read(DEAD_FEED), 'unknown')
})

test('a regime CHANGE restamps the clock; the same reading leaves it alone', () => {
  // `dlRegimeSinceMs` IS the confirmation clock for the open and for every
  // adjustment. Restamp it on an unchanged reading and no regime ever confirms;
  // fail to restamp it on a change and a one-second-old reading passes a
  // sixty-second gate.
  const held: RuleState = { ...TODAY, dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 10_000 }
  const same = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, held, MARK)
  assert.equal(same.stateAfter.dlRegimeSinceMs, NOW - 10_000, 'unchanged: the clock runs on')

  // The contrary reading is taken on a trend the book has held PAST the
  // detector's dwell. `readRegime` will not leave a trend inside
  // `dl_regime_dwell_s` (120 s) of entering it, so at `held`'s ten seconds the
  // detector would still say 'trend-up' — and that is the detector's rule, not
  // this controller's. What is under test here is only what the controller does
  // with the label it is handed.
  const settled: RuleState = { ...held, dlRegimeSinceMs: NOW - 3_600_000 }
  const changed = decideDeltaLean(inputsIn({ ring: trending(-1) }), DIALS, settled, MARK)
  assert.equal(changed.stateAfter.dlRegime, 'trend-down')
  assert.equal(changed.stateAfter.dlRegimeSinceMs, NOW, 'changed: the clock restarts here')
})

// ══════════════════════════════════════════════════ 2. the day roll and latch

test('a new IST date clears the stop and the open — the book trades again', () => {
  const yesterday: RuleState = {
    ...TODAY,
    dlStopped: true,
    dlOpenedMs: NOW - 86_400_000,
    dlOpenSide: 'up',
    dlAdjustsToday: 6,
  }
  const d = decideDeltaLean(
    inputsIn({ ring: DEAD_FEED, dateIst: NEXT_DAY }),
    DIALS,
    yesterday,
    MARK,
  )
  assert.equal(d.stateAfter.dlStopped, false)
  assert.equal(d.stateAfter.dlOpenedMs, 0)
  assert.equal(d.stateAfter.dlAdjustsToday, 0)
  assert.equal(d.stateAfter.dlDayStarted, NEXT_DAY)
})

test('the latched stop outranks every regime, and flattens what is left', () => {
  const st: RuleState = { ...TODAY, dlStopped: true }
  const flat = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, st, MARK)
  assert.equal(flat.action, 'hold')
  assert.equal(flat.trigger, 'dl-stop')
  assert.equal(flat.actions.length, 0, 'the trend never got a look in')

  const held = decideDeltaLean(inputsIn({ ring: trending(1), legs: OPENED_UP() }), DIALS, st, MARK)
  assert.equal(held.action, 'flatten')
  assert.equal(held.trigger, 'dl-stop')
  assert.equal(held.urgency, 'urgent')
  assert.equal(exits(held.actions).length, 2)
  assert.equal(opens(held.actions).length, 0)
})

test('a closeAll buys back the SHORT before it sells the long', () => {
  // Not taste: between two fills the book must never be naked, and that instant
  // is exactly when an index gaps.
  const st: RuleState = { ...TODAY, dlStopped: true }
  const d = decideDeltaLean(inputsIn({ ring: quietTape(), legs: OPENED_UP() }), DIALS, st, MARK)
  const first = d.actions[0]
  assert.ok(first !== undefined && first.op === 'close')
  assert.equal(first.instrument, 'NIFTY26SEP24200CE', 'the SHORT call goes first')
})

// ═══════════════════════════════════════════════════════ 3. the four exits

test('past the flat-by the residual goes to the blind ladder', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 901 }),
    DIALS,
    TODAY,
    MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
  assert.equal(d.urgency, 'ladder')
})

test('14:55 is an urgent flatten and 14:50 a passive one — one trigger, two ways', () => {
  const urgent = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 896 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(urgent.trigger, 'eod')
  assert.equal(urgent.urgency, 'urgent')

  const passive = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 891 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(passive.trigger, 'eod')
  assert.equal(passive.urgency, 'passive')
})

test('the 14:55 urgent flatten is emitted under a WORKING package, for every leg still held', () => {
  // 2026-10-01: the 14:50 passive flatten left one close resting. The engine is
  // not what lost the 14:55 escalation — the clock sits ABOVE the working-package
  // wait — and this pins that it stays so. The host's half (preempt the resting
  // passive package, then route this) is `engine-host-delta-lean.test.ts`.
  const legs = OPENED_UP()
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs, minuteOfDay: 895, pendingLots: 4 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
  assert.equal(d.urgency, 'urgent')
  assert.deepEqual(
    d.actions.map((a) => (a.op === 'close' ? a.instrument : `not a close: ${a.op}`)).sort(),
    legs.map((l) => l.instrument).sort(),
  )
})

test('the flatten window latches the day ONCE THE BOOK IS FLAT, and not before', () => {
  // Before flat: the latch would ride on a package that has not filled, and the
  // next tick would see `dlStopped` with legs still out — which is the same
  // flatten under a different trigger. After flat there is nothing left to do
  // all session, and the latch is what says so.
  const working = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 891 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(working.stateAfter.dlStopped, false)

  const done = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], minuteOfDay: 891 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(done.action, 'hold')
  assert.equal(done.trigger, 'eod')
  assert.equal(done.stateAfter.dlStopped, true)
  assert.equal(done.markState.dlStopped, true, 'and on BOTH states — see the next test')
})

test('the flatten clock sits ABOVE the session gate', () => {
  // The supervisor's SIGTERM is deliberately inert, so a book can wake up after
  // 15:00 still carrying. This is the only thing between that and the overnight
  // carry D4 forbids — so it must not be gated on `isTradingDay`.
  const d = decideDeltaLean(
    inputsIn({ ring: DEAD_FEED, legs: OPENED_UP(), minuteOfDay: 901, dateIst: '2026-09-19' }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
})

test('the day-loss backstop flattens urgently and latches IMMEDIATELY', () => {
  // D6: a disaster backstop — ₹30,000 on the aggressive column since R1 of the
  // 2026-10-04 review, just past where the stuck exit's floor sits.
  // It latches on BOTH states because `stateAfter` is persisted only when a
  // decision routes — a latch that lived there alone would be undone by a
  // dropped package, and the next loop would adjust on a spent budget.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -30_001 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.urgency, 'urgent')
  assert.equal(d.stateAfter.dlStopped, true)
  assert.equal(d.markState.dlStopped, true)
})

test('the backstop reads the OPEN book`s mark, not banked money alone', () => {
  // `totalPnl` is `cumRealized + Σ leg.mtm`. A budget counting only banked
  // rupees would ignore the unrealised loss it exists to stop.
  const bleeding = OPENED_UP().map((l) => ({ ...l, mtm: -15_001 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: bleeding, cumRealized: 0 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.stateAfter.dlStopped, true)
})

test('the day target banks the book on a LADDER and latches ON THE FLATTENING TICK', () => {
  /**
   * A MARK-BASED TRIGGER DOES NOT SURVIVE ITS OWN LADDER.
   *
   * `totalPnl` is `cumRealized + Σ leg.mtm`, and the ladder takes the legs —
   * and the mark with them — before the host has folded the fills back into
   * `cumRealized`. So the tick after a PARTIAL fill can read below the target,
   * fall through to §6.2 and route an add onto a book that was being banked;
   * and once the ladder has filled outright, a flatten that realised less than
   * the target hands an OPENED, LEGLESS book back to the posture, which reads
   * a `lean` gap of the whole D and pyramids in unhedged.
   *
   * So it latches on BOTH states immediately, exactly like `dl-stop` and
   * `dl-stuck`; step 1 carries out whatever a partial fill left behind.
   */
  const winning = OPENED_UP().map((l) => ({ ...l, mtm: 5_001 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: winning }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-target')
  assert.equal(d.urgency, 'ladder')
  assert.equal(d.stateAfter.dlStopped, true, 'latched on the routing state')
  assert.equal(
    d.markState.dlStopped,
    true,
    'AND on the mark state — `stateAfter` alone is undone by a dropped package',
  )

  const banked = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], cumRealized: 10_002 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(banked.action, 'hold')
  assert.equal(banked.trigger, 'dl-target')
  assert.equal(banked.stateAfter.dlStopped, true)
})

test('one rupee short of the target is not the target', () => {
  const nearly = OPENED_UP().map((l) => ({ ...l, mtm: 4_999.5 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: nearly }),
    DIALS, opened('up'), MARK,
  )
  assert.notEqual(d.trigger, 'dl-target')
  assert.equal(exits(d.actions).length, 0)
})

test('the backstop outranks the target — a book at both is a book in trouble', () => {
  // Impossible on one number, but not on two rails: a stale `cumRealized` and a
  // collapsing mark can cross in the same tick. Whichever way they cross, the
  // decision must be the URGENT one.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -30_001 }),
    dialsOf({ dl_day_target: -300_000 }),   // a target this book has "made"
    opened('up'),
    MARK,
  )
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.urgency, 'urgent')
})

// ══════════════════════════════════════════════════ 4. the gates before a rule

test('before the warm-up the detector runs and NOTHING is placed', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), minuteOfDay: 569 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
  assert.equal(d.stateAfter.dlRegime, 'trend-up', 'the detector ran — the warm-up is not a blindfold')
})

test('a non-trading day places nothing, whatever the tape says', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), dateIst: '2026-09-19' }),   // a Saturday
    DIALS, { ...TODAY, dlDayStarted: '2026-09-19' }, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
})

test('a repair hold stands the book down', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), repairHold: true }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
})

test('a working package holds the pass — one package per book', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), pendingLots: 4 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
})

test('but an EXIT jumps every one of those four gates', () => {
  // A book that cannot place its add misses a trade; a book that cannot place
  // its exit carries the position the exit exists to remove.
  for (const over of [
    { minuteOfDay: 569 },
    { repairHold: true },
    { pendingLots: 4 },
    { dateIst: '2026-09-19' as string },
  ]) {
    const d = decideDeltaLean(
      inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -30_001, ...over }),
      DIALS, opened('up'), MARK,
    )
    assert.equal(d.action, 'flatten', `the backstop must fire through ${JSON.stringify(over)}`)
    assert.equal(d.trigger, 'dl-stop')
  }
})

test('a stale index price refuses NEW RISK and never an exit', () => {
  const stale = { spotAsOf: NOW - 11_000 }
  const held = decideDeltaLean(inputsIn({ ring: trending(1), ...stale }), DIALS, TODAY, MARK)
  assert.equal(held.action, 'hold')
  assert.ok(held.reason.includes('stale'), `the ledger must say why: ${held.reason}`)

  const out = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -30_001, ...stale }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(out.action, 'flatten')
})

// ════════════════════════════════════════════════════════════ 5. the open

test('the fixture board is the one the delta bands are read off', () => {
  // The header's delta table is PROSE, and every band assertion below trusts
  // it. This is the assertion: a fixture that drifts — a changed vol, a changed
  // DTE, a changed `strikeGreeks` — must fail HERE, loudly, rather than as a
  // mystery about which strike a band landed on in this task or the next.
  assert.ok(Math.abs(D_23950_CE - 0.556) < 0.002, `23,950 CE is ${D_23950_CE}, not ~0.556`)
  assert.ok(Math.abs(D_24200_CE - 0.297) < 0.002, `24,200 CE is ${D_24200_CE}, not ~0.297`)
  assert.ok(Math.abs(D_24050_PE - 0.550) < 0.002, `24,050 PE is ${D_24050_PE}, not ~0.550`)
})

test('a confirmed trend-up opens the debit pair: 4 lots long, 4 lots hedged', () => {
  // D3: one hedge, placed at open. For a trend it is the sold further-OTM
  // option of the same type — the debit pair's short — and nothing removes it
  // before the close.
  const d = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, settled('trend-up'), MARK)
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.urgency, 'passive', 'an open is WORKED at the touch, never crossed')
  assert.equal(d.actions.length, 2)
  const b = buys(d.actions)
  const s = sells(d.actions)
  assert.equal(b.length, 1)
  assert.equal(s.length, 1)
  assert.equal(b[0]?.strike, 23_950)
  assert.equal(b[0]?.optType, 'CE')
  assert.equal(b[0]?.lots, 4, 'dl_open_lots, in CONTRACT lots (D7)')
  assert.equal(s[0]?.strike, 24_200)
  assert.equal(s[0]?.optType, 'CE')
  assert.equal(s[0]?.lots, 4)
  assert.ok(
    d.actions.indexOf(b[0] as EngineAction) < d.actions.indexOf(s[0] as EngineAction),
    'the LONG is emitted first — the book is never short a leg it has not covered',
  )
})

test('the open records the side, the instant, the cooldown and the regime that justified it', () => {
  const d = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, settled('trend-up'), MARK)
  assert.equal(d.stateAfter.dlOpenSide, 'up')
  assert.equal(d.stateAfter.dlOpenedMs, NOW)
  assert.equal(d.stateAfter.dlLastAdjustMs, NOW, 'THE OPEN COUNTS AS THE FIRST PACKAGE')
  assert.equal(d.stateAfter.dlLastAdjustRegime, 'trend-up')
  assert.equal(d.stateAfter.dlAdjustsToday, 0, 'the open is not an adjustment')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0)
  // `markState` is the book BEFORE the package: a dropped open must not leave
  // the row saying the book opened.
  assert.equal(d.markState.dlOpenedMs, 0)
  assert.equal(d.markState.dlOpenSide, '')
})

test('a confirmed trend-down opens the same structure on the put ladder', () => {
  const d = decideDeltaLean(inputsIn({ ring: trending(-1) }), DIALS, settled('trend-down'), MARK)
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.stateAfter.dlOpenSide, 'down')
  assert.equal(buys(d.actions)[0]?.optType, 'PE')
  assert.equal(buys(d.actions)[0]?.strike, 24_050)
  assert.equal(sells(d.actions)[0]?.optType, 'PE')
  assert.equal(sells(d.actions)[0]?.strike, 23_800)
})

test('a confirmed quiet opens BOTH credit wings, four legs, and records `none`', () => {
  // D3: for a quiet open the hedge IS the strangle's two wings.
  const d = decideDeltaLean(inputsIn({ ring: quietTape() }), DIALS, settled('quiet'), MARK)
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.stateAfter.dlOpenSide, 'none')
  assert.equal(d.actions.length, 4)
  assert.equal(sells(d.actions).length, 2, 'one short each side')
  assert.equal(buys(d.actions).length, 2, 'and a wing behind each of them')
  for (const sell of sells(d.actions)) assert.equal(sell.lots, 4)
  for (const wing of buys(d.actions)) assert.equal(wing.lots, 4)
  // Each side's wing is bought BEFORE its short is sold.
  const ceWing = buys(d.actions).find((a) => a.optType === 'CE')
  const ceShort = sells(d.actions).find((a) => a.optType === 'CE')
  assert.ok(ceWing !== undefined && ceShort !== undefined)
  assert.ok(d.actions.indexOf(ceWing) < d.actions.indexOf(ceShort))
})

test('chop opens NOTHING, and neither does unknown', () => {
  // `'unknown'` is not `'quiet'`. Quiet is the one regime that SELLS premium,
  // and a strangle sold into a chain that stopped printing is the worst thing
  // this path can cause.
  for (const ring of [choppy(), DEAD_FEED]) {
    const d = decideDeltaLean(inputsIn({ ring }), DIALS, TODAY, MARK)
    assert.equal(d.action, 'hold')
    assert.equal(d.actions.length, 0)
  }
})

test('an unconfirmed regime waits out `dl_adjust_confirm_s` before opening', () => {
  // The clock is `dlRegimeSinceMs` and the gate is 60s aggressive / 120s
  // conservative. A regime that has been on for one second is a tick, not a
  // reading.
  const fresh = settled('trend-up', { dlRegimeSinceMs: NOW - 59_000 })
  const early = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, fresh, MARK)
  assert.equal(early.action, 'hold')
  assert.ok(early.reason.includes('confirm'), `the ledger must say why: ${early.reason}`)

  const ripe = settled('trend-up', { dlRegimeSinceMs: NOW - 60_000 })
  const late = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, ripe, MARK)
  assert.equal(late.trigger, 'dl-open', 'the boundary is inclusive')
})

test('the conservative preset waits twice as long', () => {
  const d = dialsOf({ dl_adjust_confirm_s: 120, dl_open_lots: 2 })
  const at60 = settled('trend-up', { dlRegimeSinceMs: NOW - 60_000 })
  assert.equal(decideDeltaLean(inputsIn({ ring: trending(1) }), d, at60, MARK).action, 'hold')
  const at120 = settled('trend-up', { dlRegimeSinceMs: NOW - 120_000 })
  const open = decideDeltaLean(inputsIn({ ring: trending(1) }), d, at120, MARK)
  assert.equal(open.trigger, 'dl-open')
  assert.equal(buys(open.actions)[0]?.lots, 2, 'and opens two lots, not four')
})

test('an OPENED book never opens again, however good the tape looks', () => {
  // ONE PACKAGE A DAY (D3). `dlOpenedMs` is the whole gate, and it survives a
  // restart through the state row.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP() }),
    DIALS, opened('up'), MARK,
  )
  assert.notEqual(d.trigger, 'dl-open')
})

test('a package that does not fit the SPAN cap is NOT opened, and the stuck rule does not apply', () => {
  /**
   * §6.1: "if even one lot does not fit, do not open (and the stuck rule does
   * not apply — there is nothing to lose)." The stuck clock must stay at 0: a
   * book that never opened cannot be stuck in a losing position, and arming the
   * clock here would exit a flat book on a cap it never spent.
   */
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape() }),          // a strangle: two shorts, real margin
    dialsOf({ margin_cap: 1 }),
    settled('quiet'), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0, 'no stuck clock on a book with nothing to lose')
  assert.equal(d.stateAfter.dlOpenedMs, 0)
  assert.ok(d.reason.includes('cap'), `the ledger must name the cap: ${d.reason}`)
})

test('a cap that fits fewer lots TRUNCATES the open — it never rounds up', () => {
  /**
   * §6.3's rule applied to the open: shrink to the largest size that fits.
   * Found by walking DOWN from `dl_open_lots`, so a cap between two sizes
   * always lands on the smaller.
   */
  const full = decideDeltaLean(inputsIn({ ring: quietTape() }), DIALS, settled('quiet'), MARK)
  const fourLots = spanTotalOf(full.actions, 4)
  const twoLots = spanTotalOf(full.actions, 2)
  assert.ok(twoLots < fourLots, 'the fixture must price four lots dearer than two')

  // A cap between two and three lots: two is what fits.
  const squeezed = decideDeltaLean(
    inputsIn({ ring: quietTape() }),
    dialsOf({ margin_cap: Math.floor((twoLots + spanTotalOf(full.actions, 3)) / 2) }),
    settled('quiet'), MARK,
  )
  assert.equal(squeezed.trigger, 'dl-open')
  for (const a of opens(squeezed.actions)) assert.equal(a.lots, 2)
  // A LEG COUNT ALONE HIDES THE TRIM — four legs either way. The ledger must
  // carry the size and the reason it shrank.
  assert.ok(
    squeezed.reason.includes('2 lot(s) a leg'),
    `the ledger must name the fitted size: ${squeezed.reason}`,
  )
  assert.ok(
    squeezed.reason.includes('trimmed from 4'),
    `and that the cap trimmed it: ${squeezed.reason}`,
  )
  assert.ok(
    full.reason.includes('4 lot(s) a leg') && !full.reason.includes('trimmed'),
    `an untrimmed open says its size and nothing about a trim: ${full.reason}`,
  )
})

test('the open is sized on the BOOK`s short lot, not the chain`s — one rule, two projections', () => {
  /**
   * `projectMarginCap` prices its own Sell opens with `sellLotSize(legs, chain)`
   * and `openSpanLeg` — the lot of the first short the book already holds, the
   * chain's only when it holds none — and this path calls the same two. Read
   * `chain.lotSize` here while the recenter projection reads the book's and the
   * desk's two cap gates price the same package differently: one of them is
   * then wrong, and neither ever errors.
   */
  const fat = legAt(23_000, 'PE', 'Sell', 1, { lotSize: LOT * 2 })
  const unit = opens(
    decideDeltaLean(inputsIn({ ring: quietTape() }), DIALS, settled('quiet'), MARK).actions,
  )

  // A cap chosen so the two candidate rules give DIFFERENT answers — without
  // that the assertion below would pass under either.
  const cap = spanTotalOf(unit, 2, [fat], LOT * 2)
  const byBook = fitAt(unit, [fat], LOT * 2, cap)
  const byChain = fitAt(unit, [fat], LOT, cap)
  assert.equal(byBook, 2)
  assert.ok(
    byChain > byBook,
    `the cap must separate the rules: chain says ${byChain}, book says ${byBook}`,
  )

  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: [fat] }),
    dialsOf({ margin_cap: cap }),
    settled('quiet'),
    MARK,
  )
  assert.equal(d.trigger, 'dl-open')
  for (const a of opens(d.actions)) {
    assert.equal(a.lots, byBook, 'the BOOK`s short lot sized this open, not the chain`s')
  }
})

test('a BUY-only package always fits — a long option never raises SPAN-lite', () => {
  // §6.3: "Buys are projected too (a Buy never raises SPAN-lite, so they always
  // pass)." A cap of one rupee must still let a pure debit through, which is
  // what makes the `counter` neutralising buy of §6.2 unconditional — the book
  // is long from an up open, the tape has turned down, and no margin ceiling
  // may stand between it and getting back to flat.
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    dialsOf({ margin_cap: 1 }),
    openedOn('trend-down', 'up'),
    MARK,
  )
  assert.equal(opens(d.actions).length > 0, true, 'a debit adjustment is not capped out')
  assert.equal(buys(d.actions)[0]?.optType, 'PE')
  assert.equal(sells(d.actions).length, 0)
})

test('the open is paced like any package — but an exit is not', () => {
  const squeezed = decideDeltaLean(
    inputsIn({ ring: quietTape(), ordersThisMinute: 38 }),   // 2 slots left, 4 legs wanted
    DIALS, settled('quiet'), MARK,
  )
  assert.equal(squeezed.action, 'hold', 'opens go WHOLE OR NOT AT ALL — half a strangle is naked')
  assert.ok(squeezed.reason.includes('budget'), `the ledger must say so: ${squeezed.reason}`)

  const out = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: OPENED_UP(), cumRealized: -30_001, ordersThisMinute: 40 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(out.action, 'flatten', 'no rate limit is worth carrying the position')
  assert.equal(exits(out.actions).length, 2)
})

// ══════════════════════════════════════════════ 6. posture and adjustment

/**
 * D = `dl_open_lots` x (mid(long band) - mid(short band)) = 4 x (0.60 - 0.25)
 * = 1.4 delta-lots: THE HEDGED PAIR'S OWN NET DELTA, not the long leg's.
 *
 * That definition is what makes this engine coherent. The debit pair the open
 * puts on carries 4 x (0.556 - 0.297) = ~1.04 delta-lots on this board, and
 * `|1.4 - 1.04| = 0.36` is inside the 0.5 dead band — so A FRESHLY OPENED TREND
 * BOOK MEETS ITS OWN POSTURE EXACTLY and does nothing on its next tick. Defined
 * off the long band alone it would read as permanently short of itself, and
 * only the same-regime gate would stand between that and an instant pyramid.
 *
 * THE POSTURE IS RELATIVE TO `dlOpenSide`, in three modes, and the difference
 * between them is the operator's rule "neutralise, never reverse":
 *
 *   `lean`     the trend is the direction the book OPENED. One-sided at +-D:
 *              short of it, buy more of the open's own option (the pyramid).
 *              Past it, do nothing — a book that has run is never sold down.
 *   `counter`  the trend is AGAINST the open, or it is any trend on a strangle
 *              book. One-sided back TOWARDS ZERO: buy the regime's option only
 *              while the book leans against the regime. Never past zero, so a
 *              flip neutralises and the book never ends up short from a long
 *              open.
 *   `flat`     quiet or chop. Two-sided at zero: sell the same-side option in
 *              the ATM neutral band to bring the net back inside the band.
 */
const D_UNIT =
  4 *
  ((DIALS.dl_long_delta_lo + DIALS.dl_long_delta_hi) / 2 -
    (DIALS.dl_short_delta_lo + DIALS.dl_short_delta_hi) / 2)

/** The book's net delta in delta-lots, computed the way the engine computes it:
 * wing sign x side sign x |delta| x lots, each applied exactly once. */
function netOf(legs: readonly LegView[]): number {
  let net = 0
  for (const l of legs) {
    net += (l.optType === 'CE' ? 1 : -1) * (l.side === 'Buy' ? 1 : -1) * Math.abs(l.delta) * l.lots
  }
  return net
}

test('D is the hedged pair`s own net delta, so a fresh open meets its posture', () => {
  assert.ok(Math.abs(D_UNIT - 1.4) < 1e-9, `D must be 1.4, got ${D_UNIT}`)
  const legs = OPENED_UP()
  const net = netOf(legs)
  assert.ok(
    Math.abs(D_UNIT - net) <= DIALS.dl_dead_band_lots,
    `the opened pair (${net.toFixed(3)}) must be inside the band of D (${D_UNIT})`,
  )
  // And the engine agrees: the tick after the open does nothing at all.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }),   // every gate is open
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
  assert.ok(
    d.reason.includes('nothing to add'),
    `the ledger must say the posture is met: ${d.reason}`,
  )
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0, 'a met posture is not a blocked one')
})

test('an OPENED book holding NO legs adjusts nothing — the naked-pyramid probe', () => {
  /**
   * THE EXACT PROBE THAT PRODUCED A 3-LOT NAKED BUY CE.
   *
   * `dlOpenedMs` non-zero and an empty `legs` is a real state, not a fixture
   * curiosity: the target ladder fills, the stuck ladder fills, a repair takes
   * the package off, the broker rejects the whole open — and §6.2 then reads a
   * net delta of ZERO against a `lean` target of the whole D and routes the
   * pyramid, UNHEDGED, onto a book whose day is over. The day's package is
   * gone; there is nothing left to adjust AROUND.
   */
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], cumRealized: 9_000 }),
    DIALS,
    openedOn('trend-up', 'up', { dlLastAdjustRegime: 'quiet' }),
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0, 'and above all no naked pyramid')
  assert.ok(
    d.reason.includes("the day's package is gone"),
    `the ledger must say why: ${d.reason}`,
  )
  assert.equal(d.stateAfter.dlAdjustsToday, 0, 'nothing was spent')
})

test('LEAN: a trend in the open`s own direction buys more of the open`s option', () => {
  // §6.2 row 1: lots = max(1, round(gap / strikeDelta)).
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]              // ~0.556 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-add', 'the pyramid, and only the pyramid, is dl-add')
  assert.equal(d.actions.length, 1, 'ONE LEG — adds only, and one at a time')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'CE')
  assert.equal(a?.strike, 23_950, 'the long band, which is where a unit expresses direction')
  assert.equal(a?.lots, Math.max(1, Math.round((D_UNIT - netOf(legs)) / D_23950_CE)))
  assert.equal(exits(d.actions).length, 0, 'ADDS ONLY (D2)')
})

test('LEAN down is the same structure on the put ladder', () => {
  const legs = [legAt(24_050, 'PE', 'Buy', 1)]              // ~-0.556 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    DIALS, openedOn('trend-down', 'down', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.trigger, 'dl-add')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'PE')
  assert.equal(a?.strike, 24_050)
  assert.equal(exits(d.actions).length, 0)
})

test('LEAN is ONE-SIDED — a book that has run past D is never sold down', () => {
  // 6 lots long is ~3.34 delta-lots against a D of 1.4. The v1 controller would
  // have diffed that back to target and SOLD the difference; this engine does
  // not own a rule that can sell a directional leg.
  const legs = [legAt(23_950, 'CE', 'Buy', 6)]
  assert.ok(netOf(legs) > D_UNIT + DIALS.dl_dead_band_lots, 'the fixture must be past D')
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
  assert.ok(
    d.reason.includes('nothing to add'),
    `a book past D is a met posture, not a blocked one: ${d.reason}`,
  )
})

test('COUNTER: a trend AGAINST the open buys the regime`s option back to ZERO', () => {
  /**
   * The book is long from an up open; the tape now says down. §6.2 row 2: buy
   * the PE at the long band, sized to close the gap to ZERO — not to -D. A flip
   * NEUTRALISES; it never reverses the book, so a long open can never end the
   * day short.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]              // ~+2.22 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    DIALS, openedOn('trend-down', 'up'), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-neutral', 'a correction, not a conviction')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'PE')
  assert.equal(a?.strike, 24_050)
  // Sized to ZERO: |net| / strikeDelta, never (|net| + D) / strikeDelta.
  assert.equal(a?.lots, Math.max(1, Math.round(netOf(legs) / D_24050_PE)))
  assert.equal(exits(d.actions).length, 0, 'the original leg is NEVER exited (D2)')
})

test('COUNTER never reverses: the neutralised book lands at zero, not on the other side', () => {
  // The arithmetic the test above pins, spelled out: fold the package in and the
  // net must be inside the band of ZERO, and must not have crossed past it by
  // more than the rounding of one strike.
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]
  const before = netOf(legs)
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    DIALS, openedOn('trend-down', 'up'), MARK,
  )
  const a = opens(d.actions)[0]
  assert.ok(a !== undefined)
  const after = netOf([...legs, legAt(a.strike, a.optType, a.side, a.lots)])
  assert.ok(Math.abs(after) < Math.abs(before), `${before} -> ${after} must move towards zero`)
  assert.ok(
    after > -(DIALS.dl_dead_band_lots + D_24050_PE),
    `${after} must not be a reversal — a long open never ends up short`,
  )
})

test('COUNTER does NOTHING when the book is already on the regime`s side', () => {
  // §6.2's own words: "a strangle book that has gone net long in a trend-up is
  // not asked to do anything, because it is already on the right side."
  const longBook = [legAt(23_950, 'CE', 'Buy', 2)]
  const rightSide = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: longBook }),
    DIALS, openedOn('trend-up', 'none'), MARK,
  )
  assert.equal(rightSide.action, 'hold')
  assert.equal(rightSide.actions.length, 0)
  assert.ok(
    rightSide.reason.includes('nothing to add'),
    `the ledger must say so rather than just falling through: ${rightSide.reason}`,
  )

  // And the mirror: a net-SHORT strangle book in a trend-up IS corrected.
  const shortBook = [legAt(24_050, 'PE', 'Buy', 2)]
  const wrongSide = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: shortBook }),
    DIALS, openedOn('trend-up', 'none'), MARK,
  )
  assert.equal(wrongSide.trigger, 'dl-neutral')
  const a = opens(wrongSide.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'CE')
  assert.equal(a?.lots, Math.max(1, Math.round(Math.abs(netOf(shortBook)) / D_23950_CE)))
})

test('FLAT: a quiet regime sells an ATM call to neutralise — it never closes the long', () => {
  // §6.2 row 3, and the operator's own rule: "when direction or regime is off,
  // neutralise by ADDING (buy the opposite option, or sell a same-side one)
  // rather than closing".
  // The long is the 23,900 call and NOT the 23,950 the neutral band picks:
  // a sale at a strike the book is long is netted by the paper fold into a
  // partial CLOSE of that leg, which is the one thing this engine may not do.
  // The test below pins that refusal; this one pins the sale itself.
  const legs = [legAt(23_900, 'CE', 'Buy', 4)]              // ~+2.44 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    DIALS, openedOn('quiet', 'up'), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-neutral')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Sell')
  assert.equal(a?.optType, 'CE')
  assert.equal(a?.strike, 23_950, 'the 0.45-0.60 band — ATM, not ITM (D5)')
  assert.equal(a?.lots, Math.max(1, Math.round(netOf(legs) / D_23950_CE)))
  assert.equal(exits(d.actions).length, 0, 'nothing is closed, ever, here')
})

test('the FLAT sale never picks a strike the book holds LONG in the same wing', () => {
  /**
   * THE PAPER FOLD NETS, AND A NET IS A CLOSE.
   *
   * `book.ts` folds an opposite-side fill on an instrument the book already
   * holds INTO that position — a Sell of 4 lots against a 4-lot long is a
   * partial close, not a new short. So a `flat` sale that lands on a strike
   * the book is long takes the day's own leg off, which is exactly what D2
   * forbids and what no `closeAll` ever authorised.
   *
   * The sale must therefore choose a DIFFERENT strike, or wait. On this board
   * the 0.45-0.60 call band holds exactly one tradable strike (23,950, δ
   * 0.556 — 24,050 is 0.449 and 23,900 is 0.609), so refusing it leaves the
   * band empty and the existing "no tradable strike" wait is the answer. A
   * wait is a WAIT: the next print can put a strike back in the band, and no
   * stuck clock arms behind it.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    DIALS, openedOn('quiet', 'up'), MARK,
  )
  const a = opens(d.actions)[0]
  if (a !== undefined) {
    assert.equal(a.side, 'Sell')
    assert.ok(
      !legs.some((l) => l.optType === a.optType && l.side === 'Buy' && l.strike === a.strike),
      `the sale landed on a held long: ${a.side} ${a.lots} x ${a.strike} ${a.optType}`,
    )
  } else {
    assert.equal(d.action, 'hold')
    assert.ok(
      d.reason.includes('no tradable strike in the band'),
      `the ledger must say why: ${d.reason}`,
    )
    assert.equal(d.stateAfter.dlBlockedSinceMs, 0, 'an empty band is a wait, not a block')
  }
  assert.equal(exits(d.actions).length, 0, 'and nothing is closed by the back door either')
})

test('the same refusal on the put ladder — a down-opened book long the neutral PE', () => {
  const legs = [legAt(24_050, 'PE', 'Buy', 4)]
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    DIALS, openedOn('quiet', 'down'), MARK,
  )
  const a = opens(d.actions)[0]
  if (a !== undefined) {
    assert.equal(a.side, 'Sell')
    assert.ok(
      !legs.some((l) => l.optType === a.optType && l.side === 'Buy' && l.strike === a.strike),
      `the sale landed on a held long: ${a.side} ${a.lots} x ${a.strike} ${a.optType}`,
    )
  } else {
    assert.equal(d.action, 'hold')
    assert.ok(
      d.reason.includes('no tradable strike in the band'),
      `the ledger must say why: ${d.reason}`,
    )
  }
  assert.equal(exits(d.actions).length, 0)
})

test('a strike the book holds on the SAME side is still a fine strike', () => {
  // The guard is about NETTING, not about repetition: adding to a leg the book
  // already holds on the same side GROWS it, which is an add. Refusing that
  // would take the sideways sale away from the books that have already used it
  // once, and the pyramid away from the strike it most wants.
  const legs = [legAt(23_900, 'CE', 'Buy', 4), legAt(23_950, 'CE', 'Sell', 1)]
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    DIALS, openedOn('quiet', 'up'), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(opens(d.actions)[0]?.strike, 23_950, 'a held SHORT does not disqualify a SALE')
  // Unmarked, book.ts skips it as "already open" and the book never moves.
  assert.equal(opens(d.actions)[0]?.add, true, 'an open onto a held same-side leg must say it is an add')
})

test('an adjustment onto a strike the book does not hold is a new leg, not an add', () => {
  const legs = [legAt(23_900, 'CE', 'Buy', 4)]
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    DIALS, openedOn('quiet', 'up'), MARK,
  )
  assert.equal(d.action, 'adjust')
  const a = opens(d.actions)[0]
  assert.ok(a !== undefined)
  assert.ok(!legs.some((l) => l.strike === a.strike && l.optType === a.optType && l.side === a.side))
  assert.equal(a.add, undefined)
})

test('THE PYRAMID NEVER BUYS BACK THE HEDGE — the drifted short is skipped', () => {
  /**
   * THE EXPENSIVE HALF OF THE SAME NETTING BUG, and it is the BUY.
   *
   * The open's hedge is SOLD at 0.20-0.30 delta (D3: the debit pair's short,
   * and nothing removes a hedge before the close). A day that trends the way
   * the book opened carries that short up through 0.55 — straight into the
   * `dl_long_delta` band the `lean` pyramid and the `counter` buy both select
   * from. The pyramid then picks THE HEDGE'S OWN STRIKE, the fold nets the buy
   * into the short, and the book is left naked in the very direction it is
   * pyramiding: no hedge, more size, and a ledger line that reads
   * `dl-add, pyramiding by adding 1 lot(s)`.
   *
   * The board here is the fixture re-priced at a forward of 24,250 — the same
   * ladder and the same vol, a session where the index simply moved. At that
   * forward the held 24,200 short is 50 in the money (δ 0.556) and is the
   * FIRST strike the long-band walk reaches. The guard must step past it.
   */
  const chain = chainAt(24_250)
  const legs = [
    legOn(chain, 23_950, 'CE', 'Buy', 2),
    legOn(chain, 24_200, 'CE', 'Sell', 2),   // the hedge, now δ ~0.556
  ]
  // The fixture is only a fixture if the collision is really on the table.
  const drifted = Math.abs(strikeGreeks(chain, 24_200, 'CE', DATE, MINUTE)?.delta ?? 0)
  assert.ok(
    drifted >= DIALS.dl_long_delta_lo && drifted <= DIALS.dl_long_delta_hi,
    `the hedge must have drifted INTO the long band, it is at ${drifted.toFixed(3)}`,
  )

  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs, chain }),
    DIALS, openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-add', 'the pyramid really is what is being sized')
  const a = opens(d.actions)[0]
  assert.ok(a !== undefined)
  assert.equal(a.side, 'Buy')
  assert.equal(a.optType, 'CE')
  assert.notEqual(a.strike, 24_200, 'NOT the hedge — that buy would net the hedge away')
  assert.ok(
    !legs.some((l) => l.optType === a.optType && l.side === 'Sell' && l.strike === a.strike),
    `the pyramid landed on a held short: Buy ${a.lots} x ${a.strike} ${a.optType}`,
  )
  assert.equal(exits(d.actions).length, 0, 'and it is still an ADD (D2)')
})

test('FLAT is TWO-SIDED — a net-short book in chop sells a PUT', () => {
  // 24,100, not the 24,050 the neutral put band picks: see the held-long
  // refusal above.
  const legs = [legAt(24_100, 'PE', 'Buy', 4)]              // ~-2.41 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: choppy(), legs }),
    DIALS, openedOn('chop', 'down'), MARK,
  )
  assert.equal(d.trigger, 'dl-neutral')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Sell')
  assert.equal(a?.optType, 'PE')
  assert.equal(exits(d.actions).length, 0)
})

test('the trigger is the MODE, and nothing else', () => {
  // `dl-add` is more of the same bet; `dl-neutral` is damage control. An
  // operator reading a journal needs those two apart, and the mode is the only
  // thing that decides which is which.
  const cases: [string, SpotRing, Regime, LegView[], 'up' | 'down' | 'none', string][] = [
    ['lean', trending(1), 'trend-up', [legAt(23_950, 'CE', 'Buy', 1)], 'up', 'dl-add'],
    ['counter, trend against the open', trending(-1), 'trend-down', [legAt(23_950, 'CE', 'Buy', 4)], 'up', 'dl-neutral'],
    ['counter, any trend on a strangle', trending(1), 'trend-up', [legAt(24_050, 'PE', 'Buy', 2)], 'none', 'dl-neutral'],
    ['flat', quietTape(), 'quiet', [legAt(23_900, 'CE', 'Buy', 4)], 'up', 'dl-neutral'],
  ]
  for (const [what, ring, regime, legs, side, want] of cases) {
    const d = decideDeltaLean(
      inputsIn({ ring, legs }),
      DIALS, openedOn(regime, side, { dlLastAdjustRegime: 'chop' }), MARK,
    )
    assert.equal(d.action, 'adjust', `${what} must act`)
    assert.equal(d.trigger, want, `${what} must be ${want}`)
  }
})


test('an adjustment stamps the cooldown, the count and the regime that justified it', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [legAt(23_950, 'CE', 'Buy', 1)] }),
    DIALS, openedOn('trend-up', 'up', { dlAdjustsToday: 2, dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.stateAfter.dlAdjustsToday, 3)
  assert.equal(d.stateAfter.dlLastAdjustMs, NOW)
  assert.equal(d.stateAfter.dlLastAdjustRegime, 'trend-up')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0)
  assert.equal(d.stateAfter.dlOpenedMs, NOW - 3_600_000, 'the open instant is not rewritten')
  // A dropped package must not burn an adjustment.
  assert.equal(d.markState.dlAdjustsToday, 2)
  assert.equal(d.markState.dlLastAdjustMs, NOW - 3_600_000)
})

test('THE SAME REGIME NEVER JUSTIFIES TWO PACKAGES IN A ROW', () => {
  /**
   * THE CHURN GUARD. Without it a trend that merely PERSISTS tops the book up
   * every `dl_adjust_cooldown_s` all afternoon, which is the 15-second trend
   * pyramid of 2026-09-22 with a slower clock. With it the tape has to change
   * its mind and come back before the book adds again.
   *
   * It is no longer the thing standing between a fresh open and an instant
   * pyramid — the amended §6.2's `D` is the hedged pair's own net delta, so a
   * fresh open meets its posture and wants nothing. This gate bounds the
   * FREQUENCY of genuine top-ups, which is a smaller job and still a real one.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const again = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, openedOn('trend-up', 'up', { dlLastAdjustRegime: 'trend-up' }), MARK,
  )
  assert.equal(again.action, 'hold')
  assert.ok(again.reason.includes('already'), `the ledger must say why: ${again.reason}`)
  assert.equal(again.stateAfter.dlBlockedSinceMs, 0, 'and it is NOT a stuck condition')

  const changed = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(changed.action, 'adjust')
})

test('the cooldown holds an adjustment the posture wants', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const hot = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', { dlLastAdjustMs: NOW - 599_000, dlLastAdjustRegime: 'chop' }),
    MARK,
  )
  assert.equal(hot.action, 'hold')
  assert.ok(hot.reason.includes('cooldown'), `the ledger must say why: ${hot.reason}`)
  assert.equal(hot.stateAfter.dlBlockedSinceMs, 0, 'a cooldown is not a stuck condition')

  const cooled = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', { dlLastAdjustMs: NOW - 600_000, dlLastAdjustRegime: 'chop' }),
    MARK,
  )
  assert.equal(cooled.action, 'adjust', 'the boundary is inclusive')
})

test('the confirm window holds an adjustment too', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', {
      dlRegimeSinceMs: NOW - 30_000,
      dlLastAdjustRegime: 'chop',
    }),
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.ok(d.reason.includes('confirm'), `the ledger must say why: ${d.reason}`)
})

test('an unknown regime adjusts nothing and clears the stuck clock', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: DEAD_FEED, legs: OPENED_UP() }),
    DIALS, openedOn('unknown', 'up', { dlBlockedSinceMs: NOW - 400_000 }), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0, 'no reading, no block')
})

test('an unpriced leg holds the pass — the book delta is not measurable', () => {
  // `types.ts`: absent is never zero. A leg whose IV would not solve is a leg
  // whose quote the book could not read, and sizing an order against a partial
  // sum would trade against a position the engine cannot see.
  const legs = [legAt(23_950, 'CE', 'Buy', 4), legAt(24_200, 'CE', 'Sell', 4, { hasGreeks: false })]
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.ok(d.reason.includes('measurable'), `the ledger must say why: ${d.reason}`)
})

test('`dl_max_adjusts_day` is a hard ceiling on packages after the open', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const spent = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, openedOn('trend-up', 'up', { dlAdjustsToday: 6, dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(spent.action, 'hold')
  assert.equal(opens(spent.actions).length, 0)

  const room = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, openedOn('trend-up', 'up', { dlAdjustsToday: 5, dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(room.action, 'adjust')
})

// ══════════════════════════════════ 7. the margin gate and the stuck exit

/**
 * §6.3 sits BEFORE the churn guard, the confirm window and the cooldown and
 * right after the day limit, and that order is the risk model again: a package
 * the cap refuses is BLOCKED, and §6.4 arms on a block whether or not one of
 * the three waiting gates would also have held it. Priced the other way round,
 * a book at the cap in a persistent trend would keep resetting its own stuck
 * clock on the churn guard and never exit.
 */

test('a sideways sale is TRUNCATED to the lots that fit — never rounded up', () => {
  /**
   * §6.3: "shrink the package's lots down to the largest that fits
   * (truncation, never rounding up)". The `flat` mode's sideways sell is the
   * ONLY adjustment that adds margin, so it is the only one this can bite on —
   * `lean` and `counter` both BUY, and a long option never raises SPAN-lite.
   *
   * A quiet tape on a book that is ~4.45 delta-lots long: `flat`, two-sided,
   * so it wants to sell ~8 lots of the ATM call.
   */
  const legs = [legAt(23_900, 'CE', 'Buy', 8)]      // ~4.45 delta-lots long
  const st = openedOn('quiet', 'up')
  const full = decideDeltaLean(inputsIn({ ring: quietTape(), legs }), DIALS, st, MARK)
  assert.equal(full.trigger, 'dl-neutral')
  const wanted = opens(full.actions)[0]?.lots ?? 0
  assert.ok(wanted >= 3, `the fixture must want at least three lots, wanted ${wanted}`)

  // Priced with the engine's OWN `bookSpanLegs`/`openSpanLeg` pair, so a cap in
  // this test is a number `projectFits` will agree with rather than a guess.
  const bookSpan = spanTotalOf([], 0, legs)
  const capFor = (n: number): number => spanTotalOf(full.actions, n, legs)
  assert.ok(capFor(2) < capFor(3), 'the fixture must price three lots dearer than two')
  assert.ok(bookSpan <= capFor(2), 'and the held book must fit under both')

  const squeezed = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: capFor(2) }),
    st, MARK,
  )
  assert.equal(squeezed.trigger, 'dl-neutral')
  assert.equal(opens(squeezed.actions)[0]?.lots, 2, 'truncated DOWN to what fits')
  assert.ok(
    squeezed.reason.includes(`cut from ${wanted}`),
    `the ledger must carry the trim: ${squeezed.reason}`,
  )
  assert.ok(!full.reason.includes('cut from'), `an untrimmed package says nothing: ${full.reason}`)
})

test('a cap that fits nothing BLOCKS the adjustment and arms the stuck clock', () => {
  const legs = [legAt(23_900, 'CE', 'Buy', 8)]
  const losing = legs.map((l) => ({ ...l, mtm: -26_000 }))
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: losing }),
    dialsOf({ margin_cap: 1 }),
    openedOn('quiet', 'up'), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, NOW, 'the clock STARTS on the first blocked tick')
  assert.ok(d.reason.includes('cap'), `the ledger must name the cap: ${d.reason}`)
  assert.equal(exits(d.actions).length, 0, 'a block is not an exit — not yet')
})

test('a cap-blocked adjustment arms the clock even when the churn guard agrees', () => {
  // The ordering §6.3/§6.4 need between them: the margin gate runs BEFORE the
  // three waiting gates, so a book at the cap in a trend that merely persists
  // cannot reset its own stuck clock on the churn guard for ever.
  const legs = [legAt(23_900, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    openedOn('quiet', 'up', { dlLastAdjustRegime: 'quiet', dlLastAdjustMs: NOW - 1_000 }),
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, NOW, 'blocked is blocked, whatever else also holds')
  assert.ok(d.reason.includes('cap'), `and the cap is what the ledger names: ${d.reason}`)
})

test('the stuck exit needs BOTH the block and the loss, and either clearing resets the clock', () => {
  /**
   * §6.4: "Any tick where either condition clears resets the clock." The clock
   * measures ONE CONTINUOUS STRETCH of cap-blocked-and-losing, not a total —
   * otherwise a book that is blocked all morning and losing all afternoon exits
   * on two conditions that never once held together.
   */
  const legs = [legAt(23_900, 'CE', 'Buy', 8)]
  const armed = openedOn('quiet', 'up', { dlBlockedSinceMs: NOW - 200_000 })

  // Blocked, but only just losing: under `dl_stuck_loss` the clock resets.
  const shallow = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: legs.map((l) => ({ ...l, mtm: -24_999 })) }),
    dialsOf({ margin_cap: 1 }),
    armed, MARK,
  )
  assert.equal(shallow.stateAfter.dlBlockedSinceMs, 0, 'not losing enough — clock reset')

  // Losing, but NOT blocked: the adjustment goes out instead.
  const free = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: legs.map((l) => ({ ...l, mtm: -26_000 })) }),
    DIALS, armed, MARK,
  )
  assert.equal(free.action, 'adjust', 'a move that still helps is made, not abandoned')
  assert.equal(free.stateAfter.dlBlockedSinceMs, 0)
})

test('blocked AND losing for `dl_stuck_confirm_s` exits on a ladder and latches', () => {
  // "Cap reached, no move can still make money, minimise the downside."
  const legs = [legAt(23_900, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    openedOn('quiet', 'up', { dlBlockedSinceMs: NOW - 300_000 }),
    MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-stuck')
  assert.equal(d.urgency, 'ladder')
  assert.equal(exits(d.actions).length, 1)
  assert.equal(opens(d.actions).length, 0)
})

test('one second short of the stuck window is a hold with the clock still running', () => {
  const legs = [legAt(23_900, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const since = NOW - 299_000
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    openedOn('quiet', 'up', { dlBlockedSinceMs: since }),
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, since, 'the clock is NOT restamped while it runs')
})

test('the ADJUST LIMIT also arms the stuck clock — a book that can never move again', () => {
  // §6.4's other arm: blocked by `dl_max_adjusts_day` rather than by the cap.
  // The book is not out of margin, it is out of permission, and the outcome for
  // the position is the same.
  //
  // A `lean` posture wants this one: one lot long (0.56 delta-lots) against a D
  // of 1.4, so the gap is 0.84 — past the 0.5 band, and a real pyramid the book
  // is not allowed to place.
  const legs = [legAt(23_950, 'CE', 'Buy', 1)].map((l) => ({ ...l, mtm: -26_000 }))
  const armed = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', { dlAdjustsToday: 6, dlLastAdjustRegime: 'chop' }),
    MARK,
  )
  assert.equal(armed.action, 'hold')
  assert.equal(armed.stateAfter.dlBlockedSinceMs, NOW)

  const out = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', {
      dlAdjustsToday: 6,
      dlLastAdjustRegime: 'chop',
      dlBlockedSinceMs: NOW - 300_000,
    }),
    MARK,
  )
  assert.equal(out.trigger, 'dl-stuck')
})

test('a cooldown or a same-regime hold NEVER arms the stuck clock', () => {
  /**
   * §6.4 arms on the cap and on the adjust limit ONLY. A cooldown clears by
   * itself in ten minutes and a same-regime hold clears the moment the tape
   * changes; exiting a losing book because it is inside a cooldown would turn
   * the engine's own patience into a stop.
   *
   * The loss sits past the 25,000 stuck floor and inside the 30,000 backstop
   * (R1), so the only exit it could reach is the stuck one.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 1)].map((l) => ({ ...l, mtm: -28_000 }))
  const cooling = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', {
      dlLastAdjustMs: NOW - 1_000,
      dlLastAdjustRegime: 'chop',
      dlBlockedSinceMs: NOW - 400_000,
    }),
    MARK,
  )
  assert.equal(cooling.action, 'hold')
  assert.ok(cooling.reason.includes('cooldown'), `the ledger must say why: ${cooling.reason}`)
  assert.equal(cooling.stateAfter.dlBlockedSinceMs, 0)

  const repeated = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    openedOn('trend-up', 'up', { dlLastAdjustRegime: 'trend-up', dlBlockedSinceMs: NOW - 400_000 }),
    MARK,
  )
  assert.equal(repeated.action, 'hold')
  assert.ok(repeated.reason.includes('already'), `the ledger must say why: ${repeated.reason}`)
  assert.equal(repeated.stateAfter.dlBlockedSinceMs, 0)
})

test('an unpriced leg and a budget drop hold WITHOUT arming the clock', () => {
  // Neither is a block: one is a quote the book could not read and the other is
  // a rate limit that clears next minute. Both must leave the clock at 0, like
  // every other wait branch.
  const unpriced = [
    legAt(23_950, 'CE', 'Buy', 4, { mtm: -28_000 }),
    legAt(24_200, 'CE', 'Sell', 4, { hasGreeks: false }),
  ]
  const blind = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: unpriced }),
    DIALS,
    openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop', dlBlockedSinceMs: NOW - 400_000 }),
    MARK,
  )
  assert.equal(blind.action, 'hold')
  assert.equal(blind.stateAfter.dlBlockedSinceMs, 0, 'an unreadable book is not a blocked one')

  const starved = decideDeltaLean(
    inputsIn({
      ring: trending(1),
      legs: [legAt(23_950, 'CE', 'Buy', 1, { mtm: -28_000 })],
      ordersThisMinute: 40,
    }),
    DIALS,
    openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop', dlBlockedSinceMs: NOW - 400_000 }),
    MARK,
  )
  assert.equal(starved.action, 'hold')
  assert.ok(starved.reason.includes('budget'), `the ledger must say why: ${starved.reason}`)
  assert.equal(starved.stateAfter.dlBlockedSinceMs, 0, 'a rate limit is not a block either')
})

test('the conservative book gets stuck ten thousand rupees sooner', () => {
  const legs = [legAt(23_900, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -16_000 }))
  const d = dialsOf({ margin_cap: 1, dl_stuck_loss: 15_000, dl_open_lots: 2 })
  const out = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    d,
    openedOn('quiet', 'up', { dlBlockedSinceMs: NOW - 300_000 }),
    MARK,
  )
  assert.equal(out.trigger, 'dl-stuck')

  const aggressive = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    openedOn('quiet', 'up', { dlBlockedSinceMs: NOW - 300_000 }),
    MARK,
  )
  assert.equal(aggressive.action, 'hold', 'the same loss is not yet stuck at 25,000')
})

test('the stuck exit LATCHES IMMEDIATELY — nothing re-opens behind it', () => {
  /**
   * THE ONE EXIT THAT CANNOT WAIT FOR A FLAT BOOK.
   *
   * The target and the flatten windows latch once flat because their trigger
   * SURVIVES the flatten: a book at its target is still at its target on the
   * next tick, so a partial fill is re-decided and finishes the job. The stuck
   * condition does the opposite — it is "an adjustment is WANTED but blocked",
   * and the moment the ladder fills there is no book, so nothing is wanted,
   * `fitLots` fits on an empty book, nothing is blocked and `stuckExit` is
   * never asked again. `dlStopped` left false there is a book that paid a
   * ladder to get flat and is then handed straight back to §6.2: on a `lean`
   * posture the flat book reads a gap of the whole D and routes a fresh,
   * UNHEDGED pyramid.
   *
   * So it latches on BOTH states immediately, like the day-loss backstop, and
   * any unfilled remainder is carried out by step 1 on the next tick.
   */
  const st = openedOn('quiet', 'up', { dlBlockedSinceMs: NOW - 300_000 })
  const legs = [legAt(23_900, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const out = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }), st, MARK,
  )
  assert.equal(out.trigger, 'dl-stuck')
  assert.equal(out.urgency, 'ladder', 'it must be out, and it is still not an emergency')
  assert.equal(out.stateAfter.dlStopped, true, 'latched on the routing state')
  assert.equal(
    out.markState.dlStopped,
    true,
    'AND on the mark state — `stateAfter` alone is undone by a dropped package',
  )

  // The ladder filled. The same tick's book, flat, and the day still red.
  const done = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: [], cumRealized: -26_000 }),
    dialsOf({ margin_cap: 1 }), out.stateAfter, MARK,
  )
  assert.equal(done.action, 'hold')
  assert.equal(done.trigger, 'dl-stop', 'terminal for the day, like every other latch')
  assert.equal(done.actions.length, 0)

  // And THE REPRODUCTION: the detector settles on the best tape of the day with
  // every gate open. Before the latch was made immediate this tick routed a
  // three-lot UNHEDGED pyramid onto a book that had just been flattened for
  // being stuck.
  const tempted = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], cumRealized: -26_000 }),
    DIALS,
    {
      ...out.stateAfter,
      dlRegime: 'trend-up',
      dlRegimeSinceMs: NOW - 3_600_000,
      dlLastAdjustRegime: 'chop',
    },
    MARK,
  )
  assert.equal(tempted.action, 'hold')
  assert.equal(tempted.trigger, 'dl-stop')
  assert.equal(tempted.actions.length, 0, 'no re-open, and above all no unhedged pyramid')
})

test('a tick that cannot even EVALUATE the block resets the clock', () => {
  /**
   * §6.4's window is one continuous stretch of ticks that looked at the block
   * and found it. A gate above §6.2 never asks the question at all — a working
   * package, a repair hold, a stale index, the warm-up — so the ticks it
   * returns are not evidence of anything, and carrying the clock across them
   * would let a stuck exit fire on a five-minute-old reading with no fresh
   * confirmation behind it. They reset it, like every other wait.
   */
  const legs = [legAt(23_900, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const capped = dialsOf({ margin_cap: 1 })
  const armed = openedOn('quiet', 'up', { dlBlockedSinceMs: NOW - 299_000 })

  // The control: the same tick WITHOUT a gate in front of it is one second off
  // the exit, so every case below is a clock that really was about to fire.
  const running = decideDeltaLean(inputsIn({ ring: quietTape(), legs }), capped, armed, MARK)
  assert.equal(running.stateAfter.dlBlockedSinceMs, NOW - 299_000, 'armed and one second short')

  const gated: [string, DeltaLeanInputs][] = [
    ['a working package', inputsIn({ ring: quietTape(), legs, pendingLots: 4 })],
    ['a repair hold', inputsIn({ ring: quietTape(), legs, repairHold: true })],
    ['the warm-up', inputsIn({ ring: quietTape(), legs, minuteOfDay: 569 })],
    ['a stale index', inputsIn({ ring: quietTape(), legs, spotAsOf: NOW - 60_000 })],
  ]
  for (const [what, inputs] of gated) {
    const d = decideDeltaLean(inputs, capped, armed, MARK)
    assert.equal(d.action, 'hold', `${what} must hold`)
    assert.equal(d.stateAfter.dlBlockedSinceMs, 0, `${what} did not evaluate the block`)
  }

  // The session gate too — pinned on a state already rolled to the Saturday, so
  // it is the GATE clearing the clock here and not `rollDay`.
  const closed = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs, dateIst: '2026-09-19' }),
    capped,
    { ...armed, dlDayStarted: '2026-09-19' },
    MARK,
  )
  assert.equal(closed.action, 'hold')
  assert.equal(closed.stateAfter.dlBlockedSinceMs, 0)
})

test('the stuck exit is the FOURTH and last thing that can close a leg', () => {
  // §6.5's complete list, asserted as a list: `eod`, `dl-stop`, `dl-target`,
  // `dl-stuck`, and nothing else in this file ever emits a close.
  const closers = new Set(['eod', 'dl-stop', 'dl-target', 'dl-stuck'])
  const legs = [legAt(23_900, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const stuck = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    openedOn('quiet', 'up', { dlBlockedSinceMs: NOW - 300_000 }),
    MARK,
  )
  assert.ok(closers.has(stuck.trigger), `${stuck.trigger} must be one of the four`)
  assert.equal(stuck.action, 'flatten')
})

test('COUNTER never crosses zero by more than the dead band, however tight the band', () => {
  /**
   * §6.2's "never reverses", made dial-proof. `lots = round(gap / perLot)` can
   * overshoot by up to half a strike's delta, which the shipped 0.5 dead band
   * absorbs — but the band is a DIAL, and at 0.1 that same rounding would fold
   * a long book to net SHORT. So the lots are clamped: a `counter` package may
   * land no further than `dl_dead_band_lots` past zero.
   */
  const legs = [legAt(24_050, 'PE', 'Buy', 6)]     // ~-3.30 delta-lots
  const before = netOf(legs)
  // A deep long band, so one lot moves ~0.86 delta-lots and the rounding has
  // something visible to overshoot by: 3.30 / 0.86 is 3.82, which rounds UP to
  // four and lands the book 0.15 delta-lots on the WRONG side of zero.
  const deep = { dl_long_delta_lo: 0.85, dl_long_delta_hi: 0.95 }

  const shipped = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    dialsOf(deep), openedOn('trend-up', 'none'), MARK,
  )
  const wide = opens(shipped.actions)[0]
  assert.ok(wide !== undefined, 'the wide band must still act')
  const perLot = deltaOf(wide.strike, 'CE')
  assert.ok(
    wide.lots * perLot > Math.abs(before) + 0.1,
    `the fixture must overshoot a 0.1 band: ${wide.lots} x ${perLot} vs ${Math.abs(before)}`,
  )
  const wideAfter = netOf([...legs, legAt(wide.strike, wide.optType, wide.side, wide.lots)])
  assert.ok(
    Math.abs(wideAfter) <= DIALS.dl_dead_band_lots,
    `at the shipped band the rounding is absorbed: ${wideAfter}`,
  )

  const tight = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    dialsOf({ ...deep, dl_dead_band_lots: 0.1 }), openedOn('trend-up', 'none'), MARK,
  )
  const a = opens(tight.actions)[0]
  assert.ok(a !== undefined)
  assert.equal(a.lots, wide.lots - 1, 'clamped DOWN by one, never to zero')
  const after = netOf([...legs, legAt(a.strike, a.optType, a.side, a.lots)])
  assert.ok(after < 0, `a short book neutralised must not end up long: ${before} -> ${after}`)
  assert.ok(Math.abs(after) < Math.abs(before), 'and it must still move towards zero')
})

test('the counter clamp never clamps below one lot, and leaves LEAN alone', () => {
  // A clamp that could return 0 would turn "neutralise" into "do nothing" on
  // the one posture §6.2 makes unconditional.
  const legs = [legAt(24_050, 'PE', 'Buy', 1)]
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    // One lot of the deep band already overshoots a 0.05 band, so the clamp
    // fires and `max(1, ...)` is the only thing holding the package together.
    dialsOf({ dl_long_delta_lo: 0.85, dl_long_delta_hi: 0.95, dl_dead_band_lots: 0.05 }),
    openedOn('trend-up', 'none'), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.ok((opens(d.actions)[0]?.lots ?? 0) >= 1, 'a wanted counter always sends at least one lot')

  // LEAN's target is +-D, not zero; overshooting D is not a reversal, so the
  // clamp must not touch it.
  const lean = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [legAt(23_950, 'CE', 'Buy', 1)] }),
    dialsOf({ dl_dead_band_lots: 0.05 }),
    openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(lean.trigger, 'dl-add')
  assert.equal(
    opens(lean.actions)[0]?.lots,
    Math.max(1, Math.round((D_UNIT - netOf([legAt(23_950, 'CE', 'Buy', 1)])) / D_23950_CE)),
    'the pyramid is sized by §6.2`s formula, unclamped',
  )
})

// ═══════════════════════════════════════════════ 8. a whole scripted day

/**
 * THE ONE PROPERTY THE WHOLE DESIGN REDUCES TO.
 *
 * Every test above pins one rule. This section drives a WHOLE SYNTHETIC
 * SESSION — 09:15 to 15:01, a decision every minute, through six regime
 * changes — and asserts the things the operator actually asked for:
 *
 *   1. NOTHING CLOSES A LEG before the flatten window except `dl-target`,
 *      `dl-stuck` or `dl-stop`. This is D2, and it is the property that the
 *      2026-09-22 book violated 240 times.
 *   2. THE BOOK OPENS ONCE. One package of 2 or 4 legs, and no second one
 *      however the tape turns.
 *   3. THE ORDER COUNT IS BOUNDED. At most that open plus `dl_max_adjusts_day`
 *      one-leg adjustments, plus one close a leg — spec §8's "10 opens + 10
 *      closes ≈ 20 orders per book per day".
 *   4. THE BOOK NEVER REVERSES. Amended §6.2: a `counter` adjustment
 *      neutralises to ZERO and never past it, so a book that opened `'up'` can
 *      never end up meaningfully net short, whatever the tape does to it. The
 *      bound is the dead band plus one long-band strike's delta, because a
 *      `counter` package rounds to the nearest lot and may overshoot by half of
 *      one. A test that asserted a hard zero would fail on arithmetic rather
 *      than on a rule.
 *   5. IT ENDS FLAT AND LATCHED. `dl_flat_by_min` is not a suggestion.
 *
 * The book is carried forward tick to tick exactly as the host carries it: the
 * decision's `stateAfter` becomes the next tick's state, and a routed open is
 * folded into the leg list, so the posture the engine reads is the posture its
 * own packages built. A test that reset the legs each tick would let the engine
 * re-open forever and prove nothing.
 *
 * TWO tapes are driven through the SAME drive and the SAME properties, because
 * one tape cannot discriminate on its own. The first opens on QUIET — a
 * strangle whose net delta is ~0 by construction, so every later posture is
 * satisfied outright and the book legitimately sits still all day. That day
 * proves the engine does not churn, but its adds-only and no-reversal
 * assertions are vacuous: nothing was ever added. The second opens on a TREND
 * and is then turned against itself four times, so `counter`, `flat` and `lean`
 * packages all actually route — and only THAT day can catch an adjustment that
 * closes a leg, a counter that crosses zero or a counter that runs past the
 * daily cap.
 */

/** A leg list with `action`'s opens folded in — the paper rail's fold, in four
 * lines. An open on a strike the book already holds on the same side grows that
 * leg rather than adding a second row, which is what `book.ts` does. */
function fold(legs: readonly LegView[], actions: readonly EngineAction[]): LegView[] {
  let out = [...legs]
  for (const a of actions) {
    if (a.op === 'close') {
      out = out.filter((l) => l.instrument !== a.instrument)
      continue
    }
    if (a.op === 'resize') {
      out = out.map((l) => (l.instrument === a.instrument ? { ...l, lots: a.targetLots } : l))
      continue
    }
    const at = out.findIndex(
      (l) => l.strike === a.strike && l.optType === a.optType && l.side === a.side,
    )
    if (at >= 0) {
      const held = out[at]
      assert.ok(held !== undefined)
      // book.ts refuses an unmarked open on a held contract; so does this fold.
      assert.equal(a.add, true, `open onto held ${a.strike} ${a.optType} ${a.side} is not marked add`)
      out[at] = { ...held, lots: held.lots + a.lots }
      continue
    }
    out.push(legAt(a.strike, a.optType, a.side, a.lots))
  }
  return out
}

/** A tape as a function of the minute, ending at that minute's instant. */
type Tape = (minute: number, endMs: number) => SpotRing

/** The quiet-open day: quiet to 10:30, up to 11:30, chop to 12:15, down to
 * 13:15, quiet to 14:15, up to the close. Six regime changes, which is more
 * than any real session hands a book. The 09:30 open is the credit strangle. */
const QUIET_OPEN_DAY: Tape = (minute, endMs) => {
  if (minute < 630) return quietTape(endMs)
  if (minute < 690) return trending(1, endMs)
  if (minute < 735) return choppy(endMs)
  if (minute < 795) return trending(-1, endMs)
  if (minute < 855) return quietTape(endMs)
  return trending(1, endMs)
}

/**
 * The trend-open day: the same six segments, started on a trend so the 09:30
 * open is the DEBIT PAIR and `dlOpenSide` is `'up'`.
 *
 * Every segment after it is chosen to make a posture WANT something of a book
 * that leans up: `trend-down` is `counter` (buy the put back to zero), `chop`
 * is `flat` (sell the same-side option), `trend-up` is `lean` (pyramid the
 * call). Each segment is at least forty minutes, which clears both
 * `dl_regime_dwell_s` (120 s, or the detector holds the old label) and
 * `dl_adjust_cooldown_s` (600 s, or the package is held as churn).
 */
const TREND_OPEN_DAY: Tape = (minute, endMs) => {
  if (minute < 630) return trending(1, endMs)   // 09:15-10:30 opens 'up'
  if (minute < 690) return trending(-1, endMs)  // 10:30-11:30 counter
  if (minute < 735) return choppy(endMs)        // 11:30-12:15 flat
  if (minute < 795) return trending(1, endMs)   // 12:15-13:15 lean
  if (minute < 855) return trending(-1, endMs)  // 13:15-14:15 counter
  return quietTape(endMs)                       // 14:15-close  flat
}

/**
 * The whipsaw day: the debit pair opens on a trend-up, and from 09:30 the tape
 * FLIPS EVERY FIFTEEN MINUTES for the rest of the session — twenty-one changes
 * of mind, each one far enough apart to clear `dl_regime_dwell_s` (120 s),
 * `dl_adjust_confirm_s` (60 s) and `dl_adjust_cooldown_s` (600 s), and each one
 * alternating so the churn guard never holds it either.
 *
 * Every flip WANTS a package: `trend-down` reads `counter` on an up book and
 * buys it back to zero, the next `trend-up` reads `lean` and pyramids it back
 * to +D. Nothing about this tape is realistic; it exists so that
 * `dl_max_adjusts_day` is the thing that stops the book rather than the tape
 * running out of ideas, which is the only way §8's ceiling can be tested at
 * all.
 */
const WHIPSAW_DAY: Tape = (minute, endMs) => {
  if (minute < 570) return trending(1, endMs)
  return Math.floor((minute - 570) / 15) % 2 === 0 ? trending(1, endMs) : trending(-1, endMs)
}

/** Everything a scripted day did, in the terms the properties are stated in. */
interface DayLog {
  readonly st: RuleState
  readonly legs: readonly LegView[]
  /** Every action routed all day, one per order. */
  readonly orders: number
  /** Legs in the ONE open package. */
  readonly openLegs: number
  readonly opens: number
  readonly adjustments: number
  /** Orders routed by those adjustment packages. Spec §8: one apiece. */
  readonly adjustOrders: number
  /** Orders that closed or resized a leg, all day. */
  readonly closeOrders: number
  /** Every package that closed or resized a leg before the flatten window. */
  readonly closesBefore: ReadonlyArray<{ readonly minute: number; readonly trigger: string }>
  readonly triggers: readonly string[]
  /** The most net-SHORT the book ever got. It opened long or flat, so under the
   * amended §6.2 this can never pass -(band + one strike's delta). */
  readonly mostShort: number
}

/**
 * THE DRIVE. 09:15 to 15:01 at one decision a minute, the state and the legs
 * carried forward exactly as the host carries them.
 *
 * A minute, not a second: `dl_eval_min_ms` is 1 s and the live book decides 20k
 * times a session, but every gate this asserts is measured in minutes
 * (`dl_adjust_cooldown_s` 600, `dl_adjust_confirm_s` 60, `dl_regime_dwell_s`
 * 120, `dl_stuck_confirm_s` 300) and the tape is a closed form of the instant.
 * A per-second drive changes nothing about which packages route and costs sixty
 * times the runtime.
 */
function scriptedDay(tape: Tape): DayLog {
  let st: RuleState = { ...EMPTY_RULE_STATE }
  let legs: LegView[] = []
  let orders = 0
  let openLegs = 0
  let opens = 0
  let adjustments = 0
  let adjustOrders = 0
  let closeOrders = 0
  const closesBefore: { minute: number; trigger: string }[] = []
  const triggers: string[] = []
  let mostShort = 0

  for (let minute = 555; minute <= 901; minute += 1) {
    const nowMs = NOW + (minute - MINUTE) * 60_000
    const d = decideDeltaLean(
      inputsIn({ ring: tape(minute, nowMs), legs, minuteOfDay: minute, nowMs }),
      DIALS,
      st,
      MARK,
    )
    if (d.actions.length === 0) {
      st = d.stateAfter
      continue
    }
    triggers.push(`${clockOf(minute)} ${d.trigger}(${d.actions.length})`)
    orders += d.actions.length
    const closing = d.actions.filter((a) => a.op !== 'open')
    closeOrders += closing.length
    if (closing.length > 0 && minute < DIALS.dl_flatten_passive_min) {
      closesBefore.push({ minute, trigger: d.trigger })
    }
    if (d.trigger === 'dl-open') {
      openLegs = d.actions.length
      opens += 1
    }
    if (d.trigger === 'dl-add' || d.trigger === 'dl-neutral') {
      adjustments += 1
      adjustOrders += d.actions.length
    }
    legs = fold(legs, d.actions)
    mostShort = Math.min(mostShort, netOf(legs))
    st = d.stateAfter
  }
  return {
    st, legs, orders, openLegs, opens, adjustments, adjustOrders, closeOrders,
    closesBefore, triggers, mostShort,
  }
}

/** The five properties of §1 / §5 / §6 / §8, asserted against whatever the day
 * did. Every one of them is an upper bound or a terminal state, so a book that
 * legitimately sat still passes — which is the behaviour the operator asked
 * for. */
function assertDayProperties(day: DayLog, label: string): void {
  const story = `${label}. Day: ${day.triggers.join(', ')}`

  // 1. ADDS ONLY. Anything that closed before 14:50 must be one of the three
  //    exits — and on these tapes, which never lose enough, none of them fire.
  for (const c of day.closesBefore) {
    assert.ok(
      c.trigger === 'dl-target' || c.trigger === 'dl-stuck' || c.trigger === 'dl-stop',
      `${clockOf(c.minute)}: a ${c.trigger} closed a leg before the flatten window — D2 is violated. ${story}`,
    )
  }

  // 2. THE BOOK OPENED ONCE, AND ONLY ONCE.
  assert.ok(
    day.openLegs === 2 || day.openLegs === 4,
    `one open package of 2 or 4 legs, got ${day.openLegs}. ${story}`,
  )
  assert.equal(day.st.dlOpenedMs === 0, false, `the book did open. ${story}`)
  assert.equal(day.opens, 1, `exactly one open. ${story}`)

  // 3. THE COUNT IS BOUNDED. Spec §8: open (≤4) + `dl_max_adjusts_day` single
  //    legs + one close a leg at the flatten.
  assert.ok(
    day.adjustments <= DIALS.dl_max_adjusts_day,
    `${day.adjustments} adjustments against a cap of ${DIALS.dl_max_adjusts_day}. ${story}`,
  )
  assert.equal(
    day.st.dlAdjustsToday,
    day.adjustments,
    `the counter agrees with what went out. ${story}`,
  )
  assert.equal(
    day.adjustOrders,
    day.adjustments,
    `§8: each adjustment is ONE order, got ${day.adjustOrders} for ${day.adjustments} packages. ${story}`,
  )
  assert.equal(
    day.orders,
    day.openLegs + day.adjustOrders + day.closeOrders,
    `every order is the open, an adjustment or a close. ${story}`,
  )
  const ceiling = 4 + DIALS.dl_max_adjusts_day + (4 + DIALS.dl_max_adjusts_day)
  assert.ok(day.orders <= ceiling, `${day.orders} orders against a §8 ceiling of ${ceiling}. ${story}`)

  // 4. THE BOOK NEVER REVERSED. A `counter` adjustment brings the net to ZERO
  //    and never past it, so an up-or-flat open can never turn into a short
  //    book. The tolerance is the dead band plus one long-band strike's delta:
  //    a package rounds to the nearest lot, so it may overshoot by half of one.
  const reversalBound = -(DIALS.dl_dead_band_lots + D_23950_CE)
  assert.ok(
    day.mostShort >= reversalBound,
    `the book went to ${day.mostShort.toFixed(2)} delta-lots, past the ${reversalBound.toFixed(2)} no-reversal bound. ${story}`,
  )

  // 5. AND IT ENDED FLAT AND STOPPED. `dl_flat_by_min` is not a suggestion.
  assert.deepEqual(day.legs, [], `the book must be flat by 15:01, holding ${day.legs.length} leg(s). ${story}`)
  assert.equal(day.st.dlStopped, true, `and latched for the day. ${story}`)
}

test('over a whole scripted day nothing closes early and the order count stays bounded', () => {
  const day = scriptedDay(QUIET_OPEN_DAY)
  assertDayProperties(day, 'the quiet-open day')

  // The strangle's net delta is ~0 by construction, so every posture after it
  // is met outright: this day is the NO-CHURN case, and it must route the open
  // and the flatten and NOTHING else. Asserted exactly, because "it did nothing
  // all day" is the whole point of the rewrite and a silent drift away from it
  // — an add that fires on a book already flat — would otherwise pass the
  // upper bounds above.
  assert.equal(day.adjustments, 0, `a flat strangle needs no adjustment. Day: ${day.triggers.join(', ')}`)
  assert.equal(day.orders, day.openLegs * 2, 'one open a leg and one close a leg, and nothing between')
})

test('a scripted day that must ADJUST is still adds-only, capped and never reversed', () => {
  // The quiet day above cannot discriminate on its own: it never adds, so its
  // adds-only and no-reversal assertions are vacuous. This day opens the debit
  // pair and is then turned against itself four times, so `counter`, `flat` and
  // `lean` packages actually route — and an adjustment that emitted a `close`,
  // a `counter` that crossed zero, or a controller that kept adding past
  // `dl_max_adjusts_day` all die here.
  const day = scriptedDay(TREND_OPEN_DAY)
  assertDayProperties(day, 'the trend-open day')

  assert.ok(
    day.adjustments >= 1,
    `this day exists to exercise the adjustment path; it routed none. Day: ${day.triggers.join(', ')}`,
  )
  // Every close all day happened at the flatten — the adjustments contributed
  // none of them, which is D2 stated as arithmetic rather than as a filter.
  assert.equal(
    day.closesBefore.length,
    0,
    `a day of adds closed nothing before 14:50. Day: ${day.triggers.join(', ')}`,
  )
  assert.ok(
    day.closeOrders <= day.openLegs + day.adjustments,
    `the flatten cannot close more legs than were ever opened. Day: ${day.triggers.join(', ')}`,
  )
})

test('a whipsaw day runs the book INTO `dl_max_adjusts_day` and stops there', () => {
  // The cap is an upper bound, and an upper bound no tape ever reaches proves
  // nothing. This tape changes its mind twenty-one times, so the book would
  // route a package on every flip — and §8's ceiling is the only thing that
  // stops it. Remove the day limit and this is the test that notices.
  const day = scriptedDay(WHIPSAW_DAY)
  assertDayProperties(day, 'the whipsaw day')

  assert.equal(
    day.adjustments,
    DIALS.dl_max_adjusts_day,
    `the cap is what stopped it, not the tape. Day: ${day.triggers.join(', ')}`,
  )
  // And the book went on living: a spent adjustment budget is a WAIT, not an
  // exit. Nothing closes before the flatten just because the book ran out of
  // moves — §6.4's stuck exit needs the LOSS as well, and this book is flat on
  // the mark.
  assert.equal(
    day.closesBefore.length,
    0,
    `a book out of adjustments waits; it does not exit. Day: ${day.triggers.join(', ')}`,
  )
})

/** What a scripted TARGET day did, in the terms the two tests below assert. */
interface TargetDay {
  readonly st: RuleState
  readonly legs: readonly LegView[]
  /** Every package routed AFTER the latch was set — which must be none. */
  readonly after: readonly string[]
  /** The minute `dl-target` first flattened, or 0. */
  readonly targetAt: number
  /** Orders routed strictly after the target's own flatten. */
  readonly ordersAfterFlatten: number
}

/**
 * The §8 drive again, with a book that marks `+11,000` from the moment it
 * opens — and a FLATTEN THAT REALISES `bankOnFlatten`.
 *
 * The two are deliberately different numbers. `totalPnl` is
 * `cumRealized + Σ leg.mtm`, so the ladder takes the mark away and leaves only
 * what it actually banked; a ladder that slipped realises LESS than the target
 * that fired it, and the trigger is then gone. That is why `dl-target` latches
 * on the flattening tick rather than once flat: an opened, legless, unlatched
 * book is handed straight back to §6.2, which reads a `lean` gap of the whole
 * D and pyramids in unhedged.
 */
function targetDay(tape: Tape, bankOnFlatten: number): TargetDay {
  let st: RuleState = { ...EMPTY_RULE_STATE }
  let legs: LegView[] = []
  const after: string[] = []
  let banked = 0
  let targetAt = 0
  let ordersAfterFlatten = 0

  for (let minute = 555; minute <= 901; minute += 1) {
    const nowMs = NOW + (minute - MINUTE) * 60_000
    const marked = legs.map((l, i) => ({ ...l, mtm: i === 0 ? 11_000 : 0 }))
    const d = decideDeltaLean(
      inputsIn({
        ring: tape(minute, nowMs), legs: marked, minuteOfDay: minute, nowMs,
        cumRealized: banked,
      }),
      DIALS, st, MARK,
    )
    if (st.dlStopped && d.actions.length > 0) after.push(`${clockOf(minute)} ${d.trigger}`)
    if (targetAt > 0) ordersAfterFlatten += d.actions.length
    if (d.trigger === 'dl-target' && d.action === 'flatten') {
      banked = bankOnFlatten
      if (targetAt === 0) targetAt = minute
    }
    legs = fold(legs, d.actions)
    st = d.stateAfter
  }
  return { st, legs, after, targetAt, ordersAfterFlatten }
}

test('a scripted day that hits the target stops there and trades no more', () => {
  // The trend-open day, so the book the target banks is a REAL hedged package
  // the posture has opinions about — on the quiet day the strangle's net delta
  // is ~0 and every later posture is met anyway, so the day could not tell a
  // latch from a coincidence. The ladder realises MORE than the target here
  // (11,000 against 10,000): the trigger survives its own flatten, and the
  // latch is not what stops the book.
  const day = targetDay(TREND_OPEN_DAY, 11_000)
  assert.deepEqual(day.after, [], `nothing may route after the latch. Got: ${day.after.join(', ')}`)
  assert.equal(day.st.dlStopped, true)
  assert.deepEqual(day.legs, [])
  // And it banked in the MORNING, not at the flatten: the target is an exit in
  // its own right, not a relabelled `eod`.
  assert.ok(
    day.targetAt > 0 && day.targetAt < DIALS.dl_flatten_passive_min,
    `the target must have banked the book before 14:50, got ${day.targetAt === 0 ? 'never' : clockOf(day.targetAt)}`,
  )
})

test('a target flatten that realises LESS than the target still ends the day', () => {
  /**
   * THE LADDER SLIPPED. `dl_day_target` is 10,000 and the flatten banks 9,400,
   * so on the very next tick `totalPnl` is BELOW the target and step 4 will
   * never fire again — the trigger did not survive its own ladder.
   *
   * With the latch waiting for a flat book, that tick was an opened, legless,
   * unstopped book falling through to §6.2: a `lean` posture against a net
   * delta of zero, a gap of the whole D, and a fresh UNHEDGED pyramid bought
   * on a day that had already been banked. Latching on the flattening tick
   * ends it, and §6.2's legless guard is the second lock on the same door.
   */
  const day = targetDay(TREND_OPEN_DAY, 9_400)
  assert.ok(day.targetAt > 0, 'the target must have fired at all')
  assert.ok(
    day.targetAt < DIALS.dl_flatten_passive_min,
    `and in the morning, got ${clockOf(day.targetAt)}`,
  )
  assert.equal(day.st.dlStopped, true, 'latched on the flattening tick, not on the fill')
  assert.deepEqual(day.legs, [], 'and flat')
  assert.deepEqual(day.after, [], `nothing may route after the latch. Got: ${day.after.join(', ')}`)
  assert.equal(
    day.ordersAfterFlatten,
    0,
    'the order book is unchanged after the flatten — no re-open, no pyramid',
  )
})

// ═════════════════════════════════════════════ 9. hold to expiry (2026-10-05)
/**
 * `dl_hold_to_expiry` — THE WEEKLY SIBLING. Three behaviours, and the rest of
 * this file is the proof that the intraday book has none of them:
 *
 *   1. the clock ladder runs only when `dateIst` is the book's `expiry`, so a
 *      hold book carries overnight on every other day — INCLUDING one that
 *      wakes after 15:00 still carrying, which an intraday book ladders out;
 *   2. the package is opened once for the book's life;
 *   3. target, backstop and the latched stop are BOOK-LIFE exits, measured on
 *      `cumRealized + Σ mtm` (the tag's lifetime bank) and terminal to expiry.
 */

const HOLD = dialsOf({ dl_hold_to_expiry: true })
/** 2026-09-17 10:00 IST — the trading day after `DATE`. */
const NEXT_NOW = NOW + 86_400_000

test('HOLD, non-expiry day: past 14:50, 14:55 and 15:00 the book CARRIES — no eod exit', () => {
  for (const minuteOfDay of [891, 896, 901, 905]) {
    const d = decideDeltaLean(
      inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay }),
      HOLD, openedOn('trend-up', 'up'), MARK,
    )
    assert.notEqual(d.trigger, 'eod', `${minuteOfDay}: no clock exit on a non-expiry day`)
    assert.equal(exits(d.actions).length, 0, `${minuteOfDay}: nothing closed`)
    assert.equal(d.stateAfter.dlStopped, false, `${minuteOfDay}: and nothing latched`)
  }
  // The same tick on an intraday book is the ladder — the contrast is the dial.
  const intraday = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 905 }),
    DIALS, openedOn('trend-up', 'up'), MARK,
  )
  assert.equal(intraday.trigger, 'eod')
  assert.equal(intraday.urgency, 'ladder')
})

test('HOLD: a book that WAKES after 15:00 on a non-expiry day still carrying is not laddered out', () => {
  // Review focus 1. The supervisor's SIGTERM is inert, so a restart after
  // 15:00 is a real way to arrive here. On an intraday book that is the
  // overnight carry D4 forbids; on a hold book it is the plan. Woken on the
  // day AFTER its last decision, so the roll runs on this very tick too.
  const woke = decideDeltaLean(
    inputsIn({ ring: DEAD_FEED, legs: OPENED_UP(), minuteOfDay: 905, dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, opened('up'), MARK,
  )
  assert.equal(woke.action, 'hold')
  assert.notEqual(woke.trigger, 'eod')
  assert.equal(woke.actions.length, 0)
  assert.equal(woke.stateAfter.dlDayStarted, NEXT_DAY, 'the day rolled')
  assert.equal(woke.stateAfter.dlOpenedMs, NOW - 3_600_000, 'and the open was kept')
  assert.equal(woke.reason, '15:05: holding overnight — no adjustments after the intraday flatten slot')
})

test('HOLD, expiry day: the full ladder at 14:50, 14:55 and 15:00', () => {
  // Review focus 2, first half. `dateIst === expiry`: the contract dies today,
  // and the book is the intraday book from here.
  const at = (minuteOfDay: number, legs: readonly LegView[] = OPENED_UP()) =>
    decideDeltaLean(
      inputsIn({ ring: trending(1), legs, minuteOfDay, dateIst: EXPIRY, expiry: EXPIRY }),
      HOLD, { ...openedOn('trend-up', 'up'), dlDayStarted: EXPIRY }, MARK,
    )
  const before = at(889)
  assert.notEqual(before.trigger, 'eod', '14:49 is still the day')
  const passive = at(890)
  assert.equal(passive.trigger, 'eod')
  assert.equal(passive.urgency, 'passive')
  assert.equal(passive.reason, '14:50: passive flatten — worked, not crossed — closing all 2 leg(s)')
  const urgent = at(895)
  assert.equal(urgent.trigger, 'eod')
  assert.equal(urgent.urgency, 'urgent')
  const ladder = at(900)
  assert.equal(ladder.trigger, 'eod')
  assert.equal(ladder.urgency, 'ladder')
  assert.equal(exits(ladder.actions).length, 2)
})

test('HOLD, expiry day: the eod latch, once flat, survives the next day roll', () => {
  // Review focus 2, second half. The roll retires the book tomorrow; until it
  // does, nothing may re-open behind the expiry flatten.
  const flat = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], minuteOfDay: 901, dateIst: EXPIRY, expiry: EXPIRY }),
    HOLD, { ...openedOn('trend-up', 'up'), dlDayStarted: EXPIRY }, MARK,
  )
  assert.equal(flat.trigger, 'eod')
  assert.equal(flat.stateAfter.dlStopped, true)

  const morning = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], dateIst: '2026-09-23', nowMs: Date.UTC(2026, 8, 23, 4, 30) }),
    HOLD, flat.stateAfter, MARK,
  )
  assert.equal(morning.stateAfter.dlDayStarted, '2026-09-23')
  assert.equal(morning.stateAfter.dlStopped, true, 'the latch survived the roll')
  assert.equal(morning.trigger, 'dl-stop')
  assert.equal(opens(morning.actions).length, 0)
})

test('HOLD: the package is opened ONCE — a confirmed tape the next day opens nothing', () => {
  // Yesterday's open, rolled into today with the regime confirmed an hour ago:
  // on an intraday book this is exactly the state that opens. Flat (a repair
  // took the package off) and carrying, a hold book opens nothing.
  const today: RuleState = {
    ...opened('up'),
    dlDayStarted: NEXT_DAY,
    dlRegime: 'trend-up',
    dlRegimeSinceMs: NEXT_NOW - 3_600_000,
    dlLastAdjustMs: 0,
    dlLastAdjustRegime: '',
  }
  const flat = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs: [], dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, today, MARK,
  )
  assert.equal(opens(flat.actions).length, 0)
  assert.notEqual(flat.trigger, 'dl-open')
  assert.equal(flat.reason, "the day's package is gone — nothing to adjust")

  // And the same tape on a row that never opened DOES open — the gate is the
  // stamp, not the tape.
  const fresh = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs: [], dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, { ...today, dlOpenedMs: 0, dlOpenSide: '' }, MARK,
  )
  assert.equal(fresh.trigger, 'dl-open')
})

test('HOLD: the target is a BOOK target — banked days count, and the reason says so', () => {
  // The day rolled this morning (`dlDayRealized` 0), but the tag banked 8,000
  // on an earlier day. 8,000 + 2 × 1,001 open = 10,002: the BOOK is at target,
  // and has stood there the rupee hold (section 11).
  const rolled: RuleState = {
    ...openedOn('trend-up', 'up'), dlDayStarted: NEXT_DAY, dlDayRealized: 0, dlRupeeSinceMs: NEXT_NOW - 60_000,
  }
  const legs = OPENED_UP().map((l) => ({ ...l, mtm: 1_001 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs, cumRealized: 8_000, dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, rolled, MARK,
  )
  assert.equal(d.trigger, 'dl-target')
  assert.equal(d.urgency, 'ladder')
  assert.equal(d.reason, 'book target: Rs10,002 at or past Rs10,000, held 60s — banking it — closing all 2 leg(s)')
  assert.equal(d.stateAfter.dlStopped, true)
  assert.equal(d.markState.dlStopped, true)
})

test('HOLD: the backstop is a BOOK backstop, on the same lifetime figure', () => {
  const rolled: RuleState = {
    ...openedOn('trend-up', 'up'), dlDayStarted: NEXT_DAY, dlDayRealized: 0, dlRupeeSinceMs: NEXT_NOW - 60_000,
  }
  // Today's open marks alone are -10,002, well inside the line; the 20,000 the
  // tag lost on an earlier day is what carries the BOOK through it.
  const legs = OPENED_UP().map((l) => ({ ...l, mtm: -5_001 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs, cumRealized: -20_000, dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, rolled, MARK,
  )
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.urgency, 'urgent')
  assert.equal(d.reason, 'book backstop: Rs-30,002 through the Rs-30,000 floor, held 60s — closing all 2 leg(s)')
  assert.equal(d.stateAfter.dlStopped, true)
})

test('an INTRADAY book still says "day target" and "day backstop"', () => {
  const win = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP().map((l) => ({ ...l, mtm: 5_001 })) }),
    DIALS, opened('up'), MARK,
  )
  assert.match(win.reason, /^day target: /)
  const loss = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -30_001 }),
    DIALS, opened('up'), MARK,
  )
  assert.match(loss.reason, /^day backstop: /)
  const stopped = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, { ...TODAY, dlStopped: true }, MARK)
  assert.equal(stopped.reason, 'stopped for the day — flat already')
})

test('HOLD: a target exit is TERMINAL for the week — the next day stays flat and latched', () => {
  const win = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP().map((l) => ({ ...l, mtm: 5_001 })) }),
    HOLD, opened('up', { dlRupeeSinceMs: NOW - 60_000 }), MARK,
  )
  assert.equal(win.trigger, 'dl-target')

  // The ladder filled overnight's worth of nothing: flat, 10,002 banked, and a
  // tape the next morning that would open an intraday book.
  const nextDay = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs: [], cumRealized: 10_002, dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, win.stateAfter, MARK,
  )
  assert.equal(nextDay.stateAfter.dlDayStarted, NEXT_DAY, 'the day rolled')
  assert.equal(nextDay.stateAfter.dlStopped, true, 'and the stop did not')
  assert.equal(nextDay.action, 'hold')
  assert.equal(nextDay.trigger, 'dl-stop')
  assert.equal(nextDay.reason, 'stopped until expiry — flat already')
  assert.equal(nextDay.actions.length, 0)

  // A residual leg the ladder did not fill is carried out URGENTLY next day.
  const residual = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs: OPENED_UP(1), dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, win.stateAfter, MARK,
  )
  assert.equal(residual.action, 'flatten')
  assert.equal(residual.trigger, 'dl-stop')
  assert.equal(residual.urgency, 'urgent')
  assert.equal(opens(residual.actions).length, 0)

  // The intraday book, same two ticks: the stop clears with the date.
  const intraday = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs: [], dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    DIALS, win.stateAfter, MARK,
  )
  assert.equal(intraday.stateAfter.dlStopped, false)
})

test('HOLD, non-expiry day: from 14:50 the book FREEZES — a tape that adjusts at 14:00 adjusts nothing at 14:55', () => {
  // Ruling 2026-10-05: the intraday books never trade the last half hour and it
  // is the thinnest part of the session, so a hold book carrying overnight
  // stands still from the intraday flatten slot to the close. Exits above it
  // (target, backstop, latched stop) still run.
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const st = openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' })
  const at1400 = decideDeltaLean(inputsIn({ ring: trending(1), legs, minuteOfDay: 840 }), HOLD, st, MARK)
  assert.equal(at1400.action, 'adjust', 'the fixture WOULD adjust in the session')
  assert.equal(at1400.trigger, 'dl-add')

  const at1455 = decideDeltaLean(inputsIn({ ring: trending(1), legs, minuteOfDay: 895 }), HOLD, st, MARK)
  assert.equal(at1455.action, 'hold')
  assert.equal(at1455.actions.length, 0)
  assert.equal(at1455.reason, '14:55: holding overnight — no adjustments after the intraday flatten slot')

  // Nor does an un-opened hold book open into the close.
  const unopened = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], minuteOfDay: 890 }), HOLD, settled('trend-up'), MARK,
  )
  assert.equal(unopened.action, 'hold')
  assert.equal(opens(unopened.actions).length, 0)

  // And the target still fires inside the freeze — it is an exit, above it.
  const win = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP().map((l) => ({ ...l, mtm: 5_001 })), minuteOfDay: 895 }),
    HOLD, opened('up', { dlRupeeSinceMs: NOW - 60_000 }), MARK,
  )
  assert.equal(win.trigger, 'dl-target')
})

test('HOLD: the freeze ends with the date — the next morning past warm-up the book trades again', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const st: RuleState = {
    ...openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }),
    dlDayStarted: NEXT_DAY,
    dlRegimeSinceMs: NEXT_NOW - 3_600_000,
    dlLastAdjustMs: 0,
  }
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1, NEXT_NOW), legs, dateIst: NEXT_DAY, nowMs: NEXT_NOW }),
    HOLD, st, MARK,
  )
  assert.equal(d.action, 'adjust')
})

test('HOLD, PAST expiry (a missed roll): the ladder runs — 14:50 on expiry+1 is a passive flatten', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 890, dateIst: '2026-09-23', expiry: EXPIRY, nowMs: Date.UTC(2026, 8, 23, 9, 20) }),
    HOLD, { ...openedOn('trend-up', 'up'), dlDayStarted: '2026-09-23' }, MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
  assert.equal(d.urgency, 'passive')
})

test('HOLD, non-expiry day: the BACKSTOP still fires inside the freeze — urgent, latched', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 895, cumRealized: -30_001 }),
    HOLD, opened('up', { dlRupeeSinceMs: NOW - 60_000 }), MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.urgency, 'urgent')
  assert.match(d.reason, /^book backstop: /)
  assert.equal(d.stateAfter.dlStopped, true)
})

test('HOLD with an EMPTY expiry ladders every day — an unknown contract date fails safe', () => {
  // '' sorts before every ISO date, so `dateIst >= expiry` is always true: a
  // row that lost its expiry behaves as an intraday book rather than carrying
  // a contract nobody can date through the close.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 890, expiry: '' }),
    HOLD, openedOn('trend-up', 'up'), MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
  assert.equal(d.urgency, 'passive')
})

// ════════════════════════ 10. the old-build fail-safe (six-playbooks D9, §4.1)

/**
 * A PLAYBOOK ROW ON A BUILD THAT HAS NEVER HEARD OF PLAYBOOKS.
 *
 * Such a supervisor drops every `pb_*` key as an unknown dial and, because the
 * row still says `delta_lean_enabled`, runs it HERE — the hold-and-adjust
 * engine, which would open its debit pair on the first confirmed trend. The
 * only thing standing between that and an unplanned book is `dl_open_lots: 0`
 * in the preset: `fitLots` walks down from 0 and finds nothing, so the open
 * never goes on. Simulated by resolving the preset with every key an old
 * build does not know removed — the `pb_*` dials and `dl_parity_forward` —
 * which is exactly the document an old build would decide on.
 */
function oldBuildDials(key: string): Dials {
  const p = PRESETS.find((x) => x.key === key)
  assert.ok(p !== undefined, `${key} must exist`)
  const doc = Object.fromEntries(
    Object.entries(p.dials).filter(([k]) => !k.startsWith('pb_') && k !== 'dl_parity_forward'),
  ) as Record<string, number | boolean>
  const { dials, unknown } = resolveDials(doc)
  assert.deepEqual(unknown, [])
  assert.equal(dials.delta_lean_enabled, true, 'an old build still reads it as a delta-lean book')
  return dials
}

test('a pb-trend-drive row on an old build never emits a dl-open, on any confirmed regime', () => {
  const dials = oldBuildDials('pb-trend-drive')
  const tapes: Array<[SpotRing, Regime]> = [
    [trending(1), 'trend-up'],
    [trending(-1), 'trend-down'],
    [quietTape(), 'quiet'],
  ]
  for (const [ring, regime] of tapes) {
    const d = decideDeltaLean(inputsIn({ ring }), dials, settled(regime), MARK)
    assert.notEqual(d.trigger, 'dl-open', `${regime} opened on an old build`)
    assert.equal(d.action, 'hold', regime)
    assert.equal(opens(d.actions).length, 0, regime)
    assert.equal(d.stateAfter.dlOpenedMs, 0, `${regime}: the book must still read as never opened`)
  }
})

test('the same holds for every playbook preset — not one of the six opens on an old build', () => {
  for (const key of ['pb-trend-drive', 'pb-wing-straddle', 'pb-reversal', 'pb-expiry-drive', 'pb-expiry-theta', 'pb-expiry-gamma']) {
    const d = decideDeltaLean(inputsIn({ ring: trending(1) }), oldBuildDials(key), settled('trend-up'), MARK)
    assert.notEqual(d.trigger, 'dl-open', key)
    assert.equal(opens(d.actions).length, 0, key)
  }
})

test('an old build still runs the clock and the backstop on a playbook row', () => {
  // Inert is not unguarded (§4.1): if a leg is somehow on the book, the old
  // build's flatten windows and the preset's own backstop still take it off.
  const dials = oldBuildDials('pb-trend-drive')
  const eod = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(2), minuteOfDay: 895 }),
    dials, settled('trend-up'), MARK,
  )
  assert.equal(eod.action, 'flatten')
  assert.equal(eod.trigger, 'eod')
  const stop = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(2), cumRealized: -9_000 }),
    dials, settled('trend-up'), MARK,
  )
  assert.equal(stop.action, 'flatten')
  assert.equal(stop.trigger, 'dl-stop', 'the preset`s 9,000 backstop, not the default 30,000')
})

// ══════════════════ the open's gates, and the zero books (spec 2026-10-17)
//
// `docs/superpowers/specs/2026-10-17-delta-lean-zero-design.md` D4-D6: a
// window the open must go on inside, a fallback condor in its last minute, a
// switch per regime, a day the book opens on, and a target of 0 that is off.
// All of it gates the OPEN alone, and at the defaults none of it exists.

const presetDials = (key: string): Dials => {
  const p = PRESETS.find((x) => x.key === key)
  assert.ok(p !== undefined, `preset ${key} must exist`)
  const { dials, unknown } = resolveDials(p.dials as Record<string, number | boolean>)
  assert.deepEqual(unknown, [], `${key} sets a dial the schema refuses`)
  return dials
}
const ZERO = presetDials('delta-lean-zero')
const ZERO_0DTE = presetDials('delta-lean-zero-0dte')
const AT_0930 = 570
const AT_0931 = 571

test('at the defaults the open has no window: a confirmed trend at 10:00 opens as it always did', () => {
  assert.equal(DIALS.dl_open_by_min, 0)
  const d = decideDeltaLean(inputsIn({ ring: trending(1), minuteOfDay: MINUTE }), DIALS, settled('trend-up'), MARK)
  assert.equal(d.trigger, 'dl-open')
})

test('past `dl_open_by_min` nothing opens that day; its own minute is still inside the window', () => {
  const d = dialsOf({ dl_open_by_min: AT_0931 })
  const late = decideDeltaLean(
    inputsIn({ ring: trending(1), minuteOfDay: AT_0931 + 1 }), d, settled('trend-up'), MARK,
  )
  assert.equal(late.action, 'hold')
  assert.equal(late.actions.length, 0)
  assert.match(late.reason, /^09:32 is past the 09:31 open window — no package today$/)
  const last = decideDeltaLean(inputsIn({ ring: trending(1), minuteOfDay: AT_0931 }), d, settled('trend-up'), MARK)
  assert.equal(last.trigger, 'dl-open', 'the window is inclusive of its last minute')
})

test('the window gates the OPEN only — past it an opened book still exits and still adjusts', () => {
  const d = dialsOf({ dl_open_by_min: AT_0931 })
  const stop = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -30_001 }), d, opened('up'), MARK,
  )
  assert.equal(stop.trigger, 'dl-stop')
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const add = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }), d, openedOn('trend-up', 'up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(add.trigger, 'dl-add', 'the 10:00 pyramid of the LEAN test above, window or no window')
})

test('in the window`s last minute the fallback opens the QUIET package on chop — and only then', () => {
  const d = dialsOf({ dl_open_by_min: AT_0931, dl_open_fallback: true })
  const open = decideDeltaLean(inputsIn({ ring: choppy(), minuteOfDay: AT_0931 }), d, settled('chop'), MARK)
  assert.equal(open.action, 'adjust')
  assert.equal(open.trigger, 'dl-open')
  assert.equal(open.actions.length, 4, 'both credit units: two shorts, a wing behind each')
  assert.equal(sells(open.actions).length, 2)
  assert.equal(buys(open.actions).length, 2)
  assert.equal(open.stateAfter.dlOpenSide, 'none')
  assert.equal(open.stateAfter.dlLastAdjustRegime, 'chop', 'it records the reading it opened on')
  assert.match(open.reason, /^chop at 09:31, the open window's last minute — the quiet package anyway: opening none, 4 leg\(s\)/)
  // A minute earlier chop is still nothing to express.
  const early = decideDeltaLean(inputsIn({ ring: choppy(), minuteOfDay: AT_0930 }), d, settled('chop'), MARK)
  assert.equal(early.action, 'hold')
  assert.equal(early.actions.length, 0)
  // With the fallback off, the last minute is like any other.
  const off = decideDeltaLean(
    inputsIn({ ring: choppy(), minuteOfDay: AT_0931 }), dialsOf({ dl_open_by_min: AT_0931 }), settled('chop'), MARK,
  )
  assert.equal(off.action, 'hold')
  assert.equal(off.actions.length, 0)
})

test('an UNCONFIRMED trend in the last minute takes the fallback too — "no confirmed regime by the window`s end"', () => {
  const d = dialsOf({ dl_open_by_min: AT_0931, dl_open_fallback: true })
  const young = settled('trend-up', { dlRegimeSinceMs: NOW - 10_000 })
  const open = decideDeltaLean(inputsIn({ ring: trending(1), minuteOfDay: AT_0931 }), d, young, MARK)
  assert.equal(open.trigger, 'dl-open')
  assert.equal(open.stateAfter.dlOpenSide, 'none', 'the condor, not the trend`s spread')
  // A minute earlier the same reading waits out its confirm window as ever.
  const early = decideDeltaLean(inputsIn({ ring: trending(1), minuteOfDay: AT_0930 }), d, young, MARK)
  assert.equal(early.action, 'hold')
  assert.ok(early.reason.includes('confirm window'), early.reason)
})

test('the fallback NEVER sells into `unknown` — no reading is not a quiet one', () => {
  const d = dialsOf({ dl_open_by_min: AT_0931, dl_open_fallback: true })
  const dead = decideDeltaLean(inputsIn({ ring: DEAD_FEED, minuteOfDay: AT_0931 }), d, TODAY, MARK)
  assert.equal(dead.action, 'hold')
  assert.equal(dead.actions.length, 0)
})

test('the fallback IS the quiet package, so `dl_open_quiet` off turns it off too', () => {
  const d = dialsOf({ dl_open_by_min: AT_0931, dl_open_fallback: true, dl_open_quiet: false })
  const chop = decideDeltaLean(inputsIn({ ring: choppy(), minuteOfDay: AT_0931 }), d, settled('chop'), MARK)
  assert.equal(chop.action, 'hold')
  assert.equal(chop.actions.length, 0)
})

test('a confirmed trend whose spread cannot form falls back to the condor in the last minute (spec D5)', () => {
  // A hedge band no strike on this ladder reaches (the 25,000 CE is ~0.004).
  const noHedge = { dl_short_delta_lo: 0.001, dl_short_delta_hi: 0.002 }
  const d = dialsOf({ dl_open_by_min: AT_0931, dl_open_fallback: true, ...noHedge })
  const open = decideDeltaLean(inputsIn({ ring: trending(1), minuteOfDay: AT_0931 }), d, settled('trend-up'), MARK)
  assert.equal(open.trigger, 'dl-open')
  assert.equal(open.stateAfter.dlOpenSide, 'none')
  assert.match(open.reason, /^trend-up at 09:31, the open window's last minute — the quiet package anyway/)
  // Without the fallback the same tick is the ordinary refusal.
  const plain = decideDeltaLean(
    inputsIn({ ring: trending(1), minuteOfDay: AT_0931 }), dialsOf({ dl_open_by_min: AT_0931, ...noHedge }),
    settled('trend-up'), MARK,
  )
  assert.equal(plain.action, 'hold')
  assert.match(plain.reason, /^trend-up: the open does not fit/)
})

test('a regime whose switch is off waits, and names the switch; the others still open', () => {
  const noUp = dialsOf({ dl_open_trend_up: false })
  const up = decideDeltaLean(inputsIn({ ring: trending(1) }), noUp, settled('trend-up'), MARK)
  assert.equal(up.action, 'hold')
  assert.equal(up.actions.length, 0)
  assert.equal(up.reason, 'trend-up: this book does not open on trend-up (dl_open_trend_up is off)')
  assert.equal(decideDeltaLean(inputsIn({ ring: trending(-1) }), noUp, settled('trend-down'), MARK).trigger, 'dl-open')
  assert.equal(decideDeltaLean(inputsIn({ ring: quietTape() }), noUp, settled('quiet'), MARK).trigger, 'dl-open')

  const noDown = dialsOf({ dl_open_trend_down: false })
  const down = decideDeltaLean(inputsIn({ ring: trending(-1) }), noDown, settled('trend-down'), MARK)
  assert.equal(down.action, 'hold')
  assert.match(down.reason, /\(dl_open_trend_down is off\)$/)

  const noQuiet = dialsOf({ dl_open_quiet: false })
  const quiet = decideDeltaLean(inputsIn({ ring: quietTape() }), noQuiet, settled('quiet'), MARK)
  assert.equal(quiet.action, 'hold')
  assert.match(quiet.reason, /\(dl_open_quiet is off\)$/)
})

test('`dl_expiry_day_only` opens nothing before its contract`s last session — or after it — and opens on it', () => {
  const d = dialsOf({ dl_expiry_day_only: true })
  const before = decideDeltaLean(inputsIn({ ring: trending(-1) }), d, settled('trend-down'), MARK)
  assert.equal(before.action, 'hold')
  assert.equal(before.actions.length, 0)
  assert.equal(
    before.reason,
    "2026-09-16 is not this book's expiry day (2026-09-22) — it opens only on its contract's last session",
  )
  const past = decideDeltaLean(inputsIn({ ring: trending(-1), expiry: '2026-09-15' }), d, settled('trend-down'), MARK)
  assert.equal(past.action, 'hold', 'a dead contract is not an expiry day either')
  // `expiry` is the registry row's; the board stays priced six sessions out,
  // so the strikes are the ones the rest of this file reads.
  const on = decideDeltaLean(inputsIn({ ring: trending(-1), expiry: DATE }), d, settled('trend-down'), MARK)
  assert.equal(on.trigger, 'dl-open')
  assert.equal(on.stateAfter.dlOpenSide, 'down')
})

test('a ₹0 day target is OFF: a flat book at ₹0 still opens, and nothing latches the day', () => {
  const d = decideDeltaLean(inputsIn({ ring: trending(1) }), dialsOf({ dl_day_target: 0 }), settled('trend-up'), MARK)
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.stateAfter.dlStopped, false)
})

test('THE ZERO BOOK: chop at 09:31 opens the far-winged condor, 2 lots, shorts |Δ| ≤ 0.24, wings ≤ 0.03', () => {
  const d = decideDeltaLean(inputsIn({ ring: choppy(), minuteOfDay: AT_0931 }), ZERO, settled('chop'), MARK)
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.actions.length, 4)
  for (const a of opens(d.actions)) assert.equal(a.lots, 2, `${a.strike} ${a.optType}`)
  for (const s of sells(d.actions)) {
    assert.ok(deltaOf(s.strike, s.optType) <= 0.24, `short ${s.strike} ${s.optType} at ${deltaOf(s.strike, s.optType)}`)
  }
  for (const w of buys(d.actions)) {
    assert.ok(deltaOf(w.strike, w.optType) <= 0.03, `wing ${w.strike} ${w.optType} at ${deltaOf(w.strike, w.optType)}`)
    const short = sells(d.actions).find((s) => s.optType === w.optType)
    assert.ok(short !== undefined)
    assert.ok(w.optType === 'CE' ? w.strike > short.strike : w.strike < short.strike, 'the wing is beyond its short')
  }
  // 09:28 is still the warm-up; 09:32 is past the window.
  assert.equal(decideDeltaLean(inputsIn({ ring: choppy(), minuteOfDay: 568 }), ZERO, settled('chop'), MARK).action, 'hold')
  assert.equal(decideDeltaLean(inputsIn({ ring: choppy(), minuteOfDay: 572 }), ZERO, settled('chop'), MARK).action, 'hold')
})

test('THE ZERO BOOK holds no target: a ₹50,000 mark is not banked', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: choppy(), legs: OPENED_UP(2), cumRealized: 50_000, minuteOfDay: 700 }), ZERO, opened('up'), MARK,
  )
  assert.notEqual(d.trigger, 'dl-target')
  assert.equal(d.stateAfter.dlStopped, false)
  // ...and flattens on its own 14:30 clock.
  const eod = decideDeltaLean(
    inputsIn({ ring: choppy(), legs: OPENED_UP(2), cumRealized: 50_000, minuteOfDay: 870 }), ZERO, opened('up'), MARK,
  )
  assert.equal(eod.trigger, 'eod')
  assert.equal(eod.urgency, 'passive')
})

test('THE ZERO BOOK`s stuck exit can never fire ahead of its backstop (spec D6)', () => {
  // No adjustment is allowed, so every one the posture wants is BLOCKED by the
  // day limit and §6.4's clock is live — here armed an hour ago. The floor sits
  // ON the backstop, so the backstop takes the book first.
  const armed = openedOn('chop', 'up', { dlBlockedSinceMs: NOW - 3_600_000 })
  const above = decideDeltaLean(
    inputsIn({ ring: choppy(), legs: OPENED_UP(), cumRealized: -19_999, minuteOfDay: 700 }), ZERO, armed, MARK,
  )
  assert.equal(above.action, 'hold')
  assert.match(above.reason, /all 0 adjustments are spent — but Rs-19,999 is inside the Rs-20,000 stuck floor/)
  const at = decideDeltaLean(
    inputsIn({ ring: choppy(), legs: OPENED_UP(), cumRealized: -20_000, minuteOfDay: 700 }), ZERO, armed, MARK,
  )
  assert.equal(at.trigger, 'dl-stop', 'the backstop, never dl-stuck')
})

test('THE 0-DTE BOOK: on expiry day a confirmed trend-down opens the put spread at the zero book`s bands', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), minuteOfDay: AT_0931, expiry: DATE }), ZERO_0DTE, settled('trend-down'), MARK,
  )
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.stateAfter.dlOpenSide, 'down')
  assert.equal(d.actions.length, 2)
  const long = buys(d.actions)[0]
  const short = sells(d.actions)[0]
  assert.ok(long !== undefined && short !== undefined)
  assert.equal(long.optType, 'PE')
  assert.equal(short.optType, 'PE')
  assert.equal(long.lots, 2)
  const dl = deltaOf(long.strike, 'PE')
  const ds = deltaOf(short.strike, 'PE')
  assert.ok(dl >= 0.63 && dl <= 0.73, `long ${long.strike} at ${dl}`)
  assert.ok(ds >= 0.3 && ds <= 0.4, `short ${short.strike} at ${ds}`)
})

test('THE 0-DTE BOOK opens nothing else: not trend-up, quiet or chop on expiry day, nor trend-down on any other', () => {
  const at = (ring: SpotRing, regime: Regime, expiry: string) =>
    decideDeltaLean(inputsIn({ ring, minuteOfDay: AT_0931, expiry }), ZERO_0DTE, settled(regime), MARK)
  for (const [ring, regime] of [[trending(1), 'trend-up'], [quietTape(), 'quiet'], [choppy(), 'chop']] as const) {
    const d = at(ring, regime, DATE)
    assert.equal(d.action, 'hold', regime)
    assert.equal(d.actions.length, 0, `${regime}: no fallback condor either`)
  }
  const notToday = at(trending(-1), 'trend-down', EXPIRY)
  assert.equal(notToday.action, 'hold')
  assert.match(notToday.reason, /not this book's expiry day/)
})

// ═══════════════════════ 11. the hold book's rupee hold (2026-10-30)
/**
 * `dl_rupee_hold_s` — ON A HOLD BOOK, steps 3-4 fire only on a reading that has
 * STOOD that long. A hold book carries its legs overnight, and its first marks
 * at 09:15 blend legs already on today's book with legs still on the last
 * session's: on 19 Oct the NIFTY hold-conservative book read Rs-16,289 through
 * its Rs-15,000 floor at 09:15:00.7 and closed on it, and that close banked
 * +Rs7,797, seven of nine legs inside three seconds; on 22 Oct its successor
 * read Rs14,853 past the Rs10,000 target at 09:15:02.3, against +Rs8,645 a
 * second later. An
 * intraday book opens after the warm-up and is flat overnight, so it has no
 * stale open to doubt and keeps acting on the first mark.
 */
const HOLD_CONS = presetDials('delta-lean-hold-conservative')
const INTRA_CONS = presetDials('delta-lean-conservative')
/** 2026-09-17 09:15:00 IST — the session open after a night carried. */
const OPEN_MS = Date.UTC(2026, 8, 17, 3, 45)
const AT_0915 = 555
const HOLD_MS = HOLD_CONS.dl_rupee_hold_s * 1000
/** The carried book, already rolled for the morning it is read on. */
const CARRIED: RuleState = { ...openedOn('trend-up', 'up'), dlDayStarted: NEXT_DAY }

/** The carried pair, marked so the book reads `pnl` — all of it on the short. */
const markedAt = (pnl: number): LegView[] => [
  legAt(23_950, 'CE', 'Buy', 2),
  legAt(24_200, 'CE', 'Sell', 2, { mtm: pnl }),
]

/** One pass on the hold morning, `ms` after the open. */
const atOpen = (pnl: number, ms: number, st: RuleState, dials: Dials = HOLD_CONS) =>
  decideDeltaLean(
    inputsIn({
      ring: trending(1, OPEN_MS + ms), legs: markedAt(pnl), dateIst: NEXT_DAY,
      minuteOfDay: AT_0915, nowMs: OPEN_MS + ms,
    }),
    dials, st, MARK,
  )

test('the hold presets carry the 60s rupee hold', () => {
  assert.equal(HOLD_CONS.dl_rupee_hold_s, 60)
  assert.equal(presetDials('delta-lean-hold-aggressive').dl_rupee_hold_s, 60)
})

test('HOLD: a stale opening mark through the floor that clears inside the hold does NOT fire', () => {
  const stale = atOpen(-16_289, 700, CARRIED)
  assert.equal(stale.action, 'hold')
  assert.notEqual(stale.trigger, 'dl-stop')
  assert.equal(exits(stale.actions).length, 0)
  assert.equal(stale.stateAfter.dlStopped, false)
  assert.equal(stale.markState.dlStopped, false)
  assert.equal(stale.stateAfter.dlRupeeSinceMs, OPEN_MS + 700, 'the clock starts on the first reading through')

  const sane = atOpen(-2_246, 3_000, stale.stateAfter)
  assert.equal(sane.stateAfter.dlStopped, false)
  assert.equal(sane.stateAfter.dlRupeeSinceMs, 0, 'and resets the moment the reading clears')

  // A second blip starts its own window rather than resuming the first: at
  // the first one's 60s mark it is one second old.
  const again = atOpen(-16_289, HOLD_MS - 300, sane.stateAfter)
  const later = atOpen(-16_289, HOLD_MS + 700, again.stateAfter)
  assert.notEqual(later.trigger, 'dl-stop')
  assert.equal(later.stateAfter.dlRupeeSinceMs, OPEN_MS + HOLD_MS - 300)
})

test('HOLD: a stale opening mark past the target that clears inside the hold does NOT bank', () => {
  const stale = atOpen(14_853, 2_300, CARRIED)
  assert.equal(stale.action, 'hold')
  assert.notEqual(stale.trigger, 'dl-target')
  assert.equal(stale.stateAfter.dlStopped, false)
  assert.equal(stale.stateAfter.dlRupeeSinceMs, OPEN_MS + 2_300)

  const sane = atOpen(8_645, 3_000, stale.stateAfter)
  assert.notEqual(sane.trigger, 'dl-target')
  assert.equal(sane.stateAfter.dlStopped, false)
  assert.equal(sane.stateAfter.dlRupeeSinceMs, 0)
})

test('HOLD: a reading through the floor that STANDS the hold fires — urgent, latched, and says so', () => {
  const first = atOpen(-16_289, 0, CARRIED)
  const short = atOpen(-16_289, HOLD_MS - 1_000, first.stateAfter)
  assert.equal(short.action, 'hold', 'one second short of the hold')
  assert.equal(short.stateAfter.dlRupeeSinceMs, OPEN_MS, 'the clock is NOT restamped while it runs')

  const d = atOpen(-16_289, HOLD_MS, short.stateAfter)
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.urgency, 'urgent')
  assert.equal(d.reason, 'book backstop: Rs-16,289 through the Rs-15,000 floor, held 60s — closing all 2 leg(s)')
  assert.equal(d.stateAfter.dlStopped, true)
  assert.equal(d.markState.dlStopped, true)
})

test('HOLD: a reading past the target that STANDS the hold banks it on the ladder', () => {
  const first = atOpen(14_853, 0, CARRIED)
  const d = atOpen(12_000, HOLD_MS, first.stateAfter)
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-target')
  assert.equal(d.urgency, 'ladder')
  assert.equal(d.reason, 'book target: Rs12,000 at or past Rs10,000, held 60s — banking it — closing all 2 leg(s)')
  assert.equal(d.stateAfter.dlStopped, true)
  assert.equal(d.markState.dlStopped, true)
})

test('HOLD: one clock for both lines — a reading that swings from one to the other keeps it', () => {
  // As on the playbook frame: the book has been off-line the whole time, and
  // the line it stands on when the hold runs out is the one that fires.
  const first = atOpen(-16_289, 0, CARRIED)
  const d = atOpen(12_000, HOLD_MS, first.stateAfter)
  assert.equal(d.trigger, 'dl-target')
})

test('an INTRADAY book still fires on the first mark through either line, whatever the dial says', () => {
  for (const dials of [INTRA_CONS, { ...INTRA_CONS, dl_rupee_hold_s: 600 }]) {
    const loss = decideDeltaLean(inputsIn({ ring: trending(1), legs: markedAt(-16_289) }), dials, opened('up'), MARK)
    assert.equal(loss.action, 'flatten')
    assert.equal(loss.trigger, 'dl-stop')
    assert.equal(loss.reason, 'day backstop: Rs-16,289 through the Rs-15,000 floor — closing all 2 leg(s)')
    assert.equal(loss.stateAfter.dlStopped, true)
    assert.equal(loss.stateAfter.dlRupeeSinceMs, 0, 'no clock on an intraday book')
    const win = decideDeltaLean(inputsIn({ ring: trending(1), legs: markedAt(10_001) }), dials, opened('up'), MARK)
    assert.equal(win.trigger, 'dl-target')
    assert.equal(win.reason, 'day target: Rs10,001 at or past Rs10,000 — banking it — closing all 2 leg(s)')
  }
})

test('HOLD: a FLAT book acts at once — banked rupees have no mark in them to doubt', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1, OPEN_MS), legs: [], cumRealized: 10_002, dateIst: NEXT_DAY, minuteOfDay: AT_0915, nowMs: OPEN_MS }),
    HOLD_CONS, CARRIED, MARK,
  )
  assert.equal(d.trigger, 'dl-target')
  assert.equal(d.reason, 'book target: Rs10,002 at or past Rs10,000 — banking it — flat already')
  assert.equal(d.stateAfter.dlStopped, true)
})

test('HOLD: dl_rupee_hold_s 0 is the old behaviour — the first mark through fires', () => {
  const d = atOpen(-16_289, 700, CARRIED, { ...HOLD_CONS, dl_rupee_hold_s: 0 })
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.reason, 'book backstop: Rs-16,289 through the Rs-15,000 floor — closing all 2 leg(s)')
})

test('HOLD: a row registered before the dial existed resolves it to 60s — no data patch', () => {
  // The four hold rows on file were registered with the old dial set: their
  // documents carry every other dial and not this one.
  const p = PRESETS.find((x) => x.key === 'delta-lean-hold-conservative')
  assert.ok(p !== undefined)
  const { dl_rupee_hold_s: _absent, ...onFile } = resolveDials(p.dials as Record<string, number | boolean>).dials
  assert.equal('dl_rupee_hold_s' in onFile, false)
  const { dials, unknown } = resolveDials(onFile)
  assert.deepEqual(unknown, [])
  assert.equal(dials.dl_rupee_hold_s, 60)
  const stale = atOpen(-16_289, 700, CARRIED, dials)
  assert.notEqual(stale.trigger, 'dl-stop')
  assert.equal(stale.stateAfter.dlRupeeSinceMs, OPEN_MS + 700)
})

test('HOLD: a new date clears the clock — a stretch never spans two sessions', () => {
  // Through the floor in the last seconds of a session, then nothing until the
  // next morning's first pass: that pass starts a window of its own.
  const late = atOpen(-16_289, 0, CARRIED)
  const d = atOpen(-16_289, 700, { ...late.stateAfter, dlDayStarted: DATE })
  assert.notEqual(d.trigger, 'dl-stop')
  assert.equal(d.stateAfter.dlRupeeSinceMs, OPEN_MS + 700)
})

// ═══════════════════════ 12. the conservative books, opened and held (30 Oct 2026)
/**
 * The 30 Oct review found the neutralising adjustments lost money on balance
 * in all four daily books — the opening legs alone beat the managed book — so
 * the conservative column (intraday and hold) now runs `dl_max_adjusts_day: 0`
 * against aggressive's 6. Every adjustment the posture wants is then BLOCKED
 * by the day limit, which is one of §6.4's two arms: the stuck clock runs on
 * every losing tick. With the stuck floor ON the backstop the backstop must
 * still be the exit that takes the book — the zero book's D6, on a book that
 * also has a target and, on the hold side, a 60s rupee hold.
 */
const AGG = presetDials('delta-lean-aggressive')

/** A trend-down against the up-opened pair wants it back to zero (`counter`):
 * an adjustment the posture asks for on every tick, at 10:00 — the PE buy,
 * which always fits the cap, so nothing but the day limit can block it. Four
 * lots, so the pair's net (≈ +1.04 delta-lots) is well outside the 0.5 dead
 * band. */
const turnedAt = (pnl: number, nowMs = NOW) =>
  inputsIn({ ring: trending(-1, nowMs), legs: OPENED_UP(), cumRealized: pnl, nowMs })

test('CONSERVATIVE, opened and held: the adjustment aggressive makes is BLOCKED, and nothing goes out', () => {
  // The same tick, the same book, every waiting gate clear (cooldown an hour
  // gone, the regime confirmed an hour ago and not the one that paid last).
  const st = openedOn('trend-down', 'up')
  const agg = decideDeltaLean(turnedAt(-2_000), AGG, st, MARK)
  assert.equal(agg.action, 'adjust', 'the comparison arm still adjusts')
  assert.equal(agg.trigger, 'dl-neutral')

  const con = decideDeltaLean(turnedAt(-2_000), INTRA_CONS, st, MARK)
  assert.equal(con.action, 'hold')
  assert.equal(con.actions.length, 0)
  assert.match(con.reason, /all 0 adjustments are spent — but Rs-2,000 is inside the Rs-15,000 stuck floor/)
  assert.equal(con.stateAfter.dlBlockedSinceMs, 0, 'not losing enough — no stuck clock')
  assert.equal(con.stateAfter.dlAdjustsToday, 0)
  assert.equal(HOLD_CONS.dl_max_adjusts_day, 0, 'the hold column holds too')
})

test('CONSERVATIVE: a blocked book through the floor takes the BACKSTOP, never dl-stuck — however long the clock has run', () => {
  // The clock armed an hour ago: a book that has been blocked and losing all
  // morning. One rupee inside the floor it is a hold; at the floor the
  // backstop reads the same `totalPnl` three steps earlier and takes it.
  const armed = openedOn('trend-down', 'up', { dlBlockedSinceMs: NOW - 3_600_000 })
  const inside = decideDeltaLean(turnedAt(-14_999), INTRA_CONS, armed, MARK)
  assert.equal(inside.action, 'hold')
  assert.match(inside.reason, /all 0 adjustments are spent — but Rs-14,999 is inside the Rs-15,000 stuck floor/)
  assert.equal(inside.stateAfter.dlBlockedSinceMs, 0)

  for (const pnl of [-15_000, -15_001, -40_000]) {
    const at = decideDeltaLean(turnedAt(pnl), INTRA_CONS, armed, MARK)
    assert.equal(at.trigger, 'dl-stop', `${pnl}: the backstop, never dl-stuck`)
    assert.equal(at.urgency, 'urgent')
    assert.equal(at.stateAfter.dlStopped, true)
  }
})

test('HOLD-CONSERVATIVE: blocked through the floor, the held backstop fires at 60s — 240s before the stuck window could', () => {
  // A carried book at 10:00, opened an hour ago (a hold book's open is kept
  // across the date, so the hour stands in for the days before). Both clocks
  // start on the first pass through the floor: the rupee hold at step 3, the
  // stuck clock at §6.4 — and the rupee hold is the shorter of the two.
  const carried = openedOn('trend-down', 'up')
  const t0 = NOW
  const pass = (ms: number, st: RuleState) =>
    decideDeltaLean(turnedAt(-15_000, t0 + ms), HOLD_CONS, st, MARK)

  const first = pass(0, carried)
  assert.equal(first.action, 'hold')
  assert.equal(first.stateAfter.dlRupeeSinceMs, t0, 'the backstop`s hold starts')
  assert.equal(first.stateAfter.dlBlockedSinceMs, t0, 'and so does the stuck clock')
  assert.match(first.reason, /all 0 adjustments are spent at Rs-15,000 — 300s left of the 300s stuck window/)

  const short = pass(HOLD_CONS.dl_rupee_hold_s * 1000 - 1_000, first.stateAfter)
  assert.equal(short.action, 'hold', 'one second short of the rupee hold')
  assert.equal(short.stateAfter.dlBlockedSinceMs, t0)

  const fired = pass(HOLD_CONS.dl_rupee_hold_s * 1000, short.stateAfter)
  assert.equal(fired.trigger, 'dl-stop')
  assert.equal(fired.urgency, 'urgent')
  assert.equal(fired.reason, 'book backstop: Rs-15,000 through the Rs-15,000 floor, held 60s — closing all 2 leg(s)')
  assert.equal(fired.stateAfter.dlStopped, true)
})

test('HOLD-CONSERVATIVE: a carried row on the OLD dials (4 adjustments) still adjusts until it is patched to 0', () => {
  // What the two books registered before 30 Oct resolve: the roll never
  // rewrites a running row's dials, so the patch is the operator's (runbook
  // §7.8). Shown here so the difference is the dial and nothing else.
  const st = openedOn('trend-down', 'up')
  const onFile = { ...HOLD_CONS, dl_max_adjusts_day: 4 }
  const old = decideDeltaLean(turnedAt(-2_000), onFile, st, MARK)
  assert.equal(old.action, 'adjust')
  const patched = decideDeltaLean(turnedAt(-2_000), HOLD_CONS, st, MARK)
  assert.equal(patched.action, 'hold')
  assert.equal(patched.actions.length, 0)
})
