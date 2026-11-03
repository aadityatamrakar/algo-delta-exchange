/**
 * TREND DRIVE (id 1) AND EXPIRY DRIVE (id 4) — six-playbooks spec §5.1, §5.4.
 *
 * One strategy, two dial sets: the confirmed opening trend bought as a debit
 * spread, with a debit stop, a flip stop that never takes a winner out (D5),
 * and at most one pyramid add (D6). Trend Drive strikes it by delta bands on a
 * contract at least a session out; Expiry Drive strikes it in straddle units on
 * the contract that expires today and is out by 12:00.
 *
 * TWO HALVES:
 *
 *   - THE RULES, one test each, on the frame fixture's calm NIFTY board
 *     (`playbook-fixture.ts`): the strategy's three answers called directly on
 *     a hand-set `PlaybookCtx`, then the same answers through the production
 *     frame (`decidePlaybook`) so the reasons, triggers and debounces are the
 *     ones the journal will carry;
 *   - THE SCENARIOS of spec §7 that name these books, each a whole simulated
 *     session (`scenario/sim.ts`) on the shipped preset, asserting what the
 *     spec says the book does on that kind of day — and, on EVERY run, that
 *     the book is never short an option it is not long, lot for lot (D1), and
 *     that it is flat by 15:00.
 *
 * HOW THE SCENARIOS ARE SIZED. The regime detector calls a trend when the
 * index moves at least `dl_trend_mult` (2) x the move the ATM straddle prices
 * over its 300 s window, on a path at least `dl_clean_min` (0.6) clean; the
 * playbook then wants the label held `pb_confirm_s`. So every burst below is
 * sized in that implied move (`impliedMove`, read off the day's own opening
 * board), never in points, and the mornings before the bursts are a 2-minute
 * zigzag of 1.2x implied a leg: a two-way tape that reads `chop`, never
 * `quiet`, and whose last leg runs AGAINST the first burst, so whatever reads
 * as a trend reads off the bursts alone.
 *
 * ONE BAD PRINT (M11) gets three scenarios, not one. A 1% print read as the
 * newest sample turns the detector's label, and its `dl_regime_dwell_s` (120 s)
 * then holds that label on a tape that never moved. Trend Drive's 120 s confirm
 * outlasts the dwell; Expiry Drive's 90 s confirm and both flips (90 s, 60 s)
 * do not — before the strategy checked the tape as well as the label, Expiry
 * Drive opened 92 s after such a print and Trend Drive flipped out of a losing
 * trade 96 s after one. The three pin that none of that happens.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Dials } from '../src/dials.ts'
import type { MarkContext } from '../src/guards.ts'
import { atmStraddleMid, type Regime, type RegimeRead, type WindowStat } from '../src/delta-lean/regime.ts'
import { decidePlaybook } from '../src/delta-lean/playbook/decide.ts'
import { debitByBands, debitByStraddle } from '../src/delta-lean/playbook/kit.ts'
import { PLAYBOOKS } from '../src/delta-lean/playbook/registry.ts'
import { dayComplete } from '../src/delta-lean/playbook/session.ts'
import { EXPIRY_DRIVE, TREND_DRIVE } from '../src/delta-lean/playbook/trend-spread.ts'
import type { EntryVerdict, OpenPlan, PlaybookCtx, PlaybookStep } from '../src/delta-lean/playbook/types.ts'
import type { ChainSnap, EngineAction, EngineDecision, LegView, PlaybookState, RuleState } from '../src/types.ts'
import { at, calm, chainAt, ctxOf, DATE, inputsAt, legOn, OPEN, stateWith, Tape, type InputsOver } from './playbook-fixture.ts'
import { buildChain, impliedMove } from './scenario/chain-model.ts'
import { istMs, type ScenarioSpec, type Segment } from './scenario/paths.ts'
import { minutesToExpiry, presetDials, runSession, type SimResult } from './scenario/sim.ts'

const TD = presetDials('pb-trend-drive')
const ED = presetDials('pb-expiry-drive')
const NOW = at(600) // 10:00 on the fixture's Friday
const MARK: MarkContext = { isNewMark: true, markIndexToday: 9 }

// ── the rules, on a hand-set context ────────────────────────────────────────

interface Over {
  readonly ctx?: Partial<PlaybookCtx>
  readonly pb?: Partial<PlaybookState>
  readonly inputs?: InputsOver
  /** The tape's level by time; defaults to the context's `spot` for the last
   * 5 s over the calm tape. */
  readonly level?: (ms: number) => number
}

/** A slow window that moved `displacement` points in a straight line, against
 * an 18-point implied move: 3x the bar for ±54 — a trend on the tape. */
const slowStat = (displacement: number, range = Math.abs(displacement)): WindowStat => ({
  displacement, range, cleanliness: range > 0 ? Math.abs(displacement) / range : 0, samples: 300, spanMs: 300_000,
})
/** The detector's read for a label: a trend label with its trend on the tape
 * (the slow window still beats the hold bar), anything else as the calm tape
 * read it. A test of the dwell-held label replaces `slowStat` by hand. */
function readFor(regime: Regime, base: RegimeRead): RegimeRead {
  const stat = regime === 'trend-up' ? slowStat(54) : regime === 'trend-down' ? slowStat(-54) : base.slowStat
  return { ...base, slow: regime, slowStat: stat, impliedSlow: 18 }
}

/**
 * A pass on the fixture's calm board at 25,000, read as a CONFIRMED TREND UP
 * unless a test says otherwise: the label held ten minutes and on the tape,
 * the open seen and 20 points under the index. Each test moves the one field
 * its rule reads.
 */
function ctxAt(dials: Dials, over: Over = {}): PlaybookCtx {
  // The ring's newest prints ARE the context's `S`, as in production, where
  // `ctx.spot` is the ring's latest — so the steadied index reads it too.
  const S = over.ctx?.spot === undefined ? OPEN : over.ctx.spot
  const level = over.level ?? ((ms: number): number => (S !== null && ms >= NOW - 5_000 ? S : calm(ms)))
  const base = ctxOf(inputsAt(new Tape(level), NOW, over.inputs ?? {}), dials, { dayOpen: OPEN - 20, ...over.pb })
  const regime = over.ctx?.regime ?? 'trend-up'
  return {
    ...base,
    regime, read: readFor(regime, base.read), regimeHeldMs: 600_000, dayComplete: true, spot: OPEN, spotFresh: true,
    ...over.ctx,
  }
}

/** An up trade opened at 09:40 off 25,000, fully staged. */
const TRADE: Partial<PlaybookState> = {
  entries: 1, tradeOpenMs: at(580), side: 'up', planLots: 2, stageMs: at(580),
  stageSpot: OPEN, stageReadyMs: at(580) + 12_000, entrySpot: OPEN, entryStr: 217, basePnl: 0,
}

/** A pass on that trade; `cost` and `tradePnl` are set by hand, so every
 * threshold below is a number the test states. */
function onTrade(
  dials: Dials,
  ctx: Partial<PlaybookCtx> = {},
  pb: Partial<PlaybookState> = {},
  inputs: InputsOver = {},
  level?: (ms: number) => number,
): PlaybookCtx {
  return ctxAt(dials, { pb: { ...TRADE, ...pb }, ctx: { cost: 13_000, tradePnl: 0, ...ctx }, inputs, ...(level === undefined ? {} : { level }) })
}

/** The pyramid's pass: a winning up trade, its trend held, `S` 0.5 x Dday out. */
const ADD_CTX = { tradePnl: 1_500, regimeHeldMs: 130_000, dayImplied: 150, spot: OPEN + 75 } as const

/** Nothing fired, nothing to add, and no rupee clock claimed (`heldRupee` off
 * says nothing: the frame resets the shared clock itself). */
function quiet(step: PlaybookStep, what = ''): void {
  assert.equal(step.exit, undefined, `${what}: ${JSON.stringify(step)}`)
  assert.equal(step.add, undefined, `${what}: ${JSON.stringify(step)}`)
  assert.deepEqual(step.patch ?? {}, {}, what)
}

const reasonOf = (v: EntryVerdict): string => (v.kind === 'wait' ? v.reason : v.plan.reason)
function planOf(v: EntryVerdict): OpenPlan {
  assert.equal(v.kind, 'open', `expected an open, got: ${reasonOf(v)}`)
  return (v as Extract<EntryVerdict, { kind: 'open' }>).plan
}

/** The calm board at 10:00, and the call spread the fixture's bands find on it. */
const BOARD: ChainSnap = chainAt(NOW, OPEN)
const spreadLegs = (chain: ChainSnap = BOARD): LegView[] => [
  legOn(chain, 24_950, 'CE', 'Buy', 2, { mtm: 0 }),
  legOn(chain, 25_200, 'CE', 'Sell', 2, { mtm: 0 }),
]

test('the registry holds Trend Drive at 1 and Expiry Drive at 4, the names the journal prefixes', () => {
  assert.equal(PLAYBOOKS.get(1), TREND_DRIVE)
  assert.equal(PLAYBOOKS.get(4), EXPIRY_DRIVE)
  assert.deepEqual([TREND_DRIVE.id, TREND_DRIVE.name, EXPIRY_DRIVE.id, EXPIRY_DRIVE.name], [1, 'trend-drive', 4, 'expiry-drive'])
})

test('enter: no trend, no trade — quiet, chop and unknown all wait, naming the regime', () => {
  for (const regime of ['quiet', 'chop', 'unknown'] as const) {
    const v = TREND_DRIVE.enter(ctxAt(TD, { ctx: { regime } }))
    assert.equal(v.kind, 'wait')
    assert.match(reasonOf(v), new RegExp(`^no trend: the slow regime is ${regime}$`))
  }
})

test('enter: the trend must have held pb_confirm_s, inclusive — 120 s on Trend Drive, 90 s on Expiry Drive', () => {
  const young = TREND_DRIVE.enter(ctxAt(TD, { ctx: { regimeHeldMs: 119_999 } }))
  assert.equal(young.kind, 'wait')
  assert.equal(reasonOf(young), 'trend-up held 119s of the 120s confirm')
  assert.equal(TREND_DRIVE.enter(ctxAt(TD, { ctx: { regimeHeldMs: 120_000 } })).kind, 'open')
  assert.equal(EXPIRY_DRIVE.enter(ctxAt(ED, { ctx: { regimeHeldMs: 89_999 } })).kind, 'wait')
  assert.equal(EXPIRY_DRIVE.enter(ctxAt(ED, { ctx: { regimeHeldMs: 90_000 } })).kind, 'open')
})

test('enter: once the open is seen, the trend must agree with sign(S - O); a fold that never saw it skips the test and says so (O9)', () => {
  const below = TREND_DRIVE.enter(ctxAt(TD, { pb: { dayOpen: OPEN + 10 } }))
  assert.equal(below.kind, 'wait')
  assert.equal(reasonOf(below), 'trend-up against the open: the index 25000.0 is 10.0 below the 25010.0 open')
  const level = TREND_DRIVE.enter(ctxAt(TD, { pb: { dayOpen: OPEN } }))
  assert.equal(level.kind, 'wait', 'at the open is no direction at all')
  const down = { regime: 'trend-down', spot: OPEN - 30 } as const
  assert.equal(TREND_DRIVE.enter(ctxAt(TD, { pb: { dayOpen: OPEN }, ctx: down })).kind, 'open')
  assert.equal(TREND_DRIVE.enter(ctxAt(TD, { pb: { dayOpen: OPEN - 40 }, ctx: down })).kind, 'wait')
  const blind = TREND_DRIVE.enter(ctxAt(TD, { ctx: { spot: null, spotFresh: false } }))
  assert.equal(blind.kind, 'wait', 'no index level, nothing to test the open against')

  const late = TREND_DRIVE.enter(ctxAt(TD, { pb: { dayOpen: OPEN + 10 }, ctx: { dayComplete: false } }))
  assert.match(planOf(late).reason, /the fold never saw the open: the open-direction test skipped/)
})

test('enter: Trend Drive opens the delta-band debit spread on the trend\'s own side, at pb_lots', () => {
  const c = ctxAt(TD)
  const up = planOf(TREND_DRIVE.enter(c))
  const bands = debitByBands(c, 'up')
  assert.ok(bands !== null)
  assert.deepEqual([up.protective, up.shorts], [bands.protective, bands.shorts])
  assert.deepEqual(up.protective.map((a) => [a.strike, a.optType, a.side, a.lots]), [[24_950, 'CE', 'Buy', 1]])
  assert.deepEqual(up.shorts, [{ strike: 25_200, optType: 'CE', cover: 24_950 }])
  assert.deepEqual([up.side, up.lots], ['up', 2])
  assert.equal(up.stamps, undefined, 'the frame stamps the entry straddle itself')
  assert.match(up.reason, /^trend-up held 600s, the index 20.0 above the open, gap unknown \(the 0.25% gap gate skipped\): the 24950\/25200 CE debit spread by delta bands$/)

  const dn = planOf(TREND_DRIVE.enter(ctxAt(TD, { pb: { dayOpen: OPEN + 20 }, ctx: { regime: 'trend-down', gapPct: -0.41 } })))
  const puts = debitByBands(c, 'down')
  assert.ok(puts !== null)
  assert.deepEqual([dn.side, dn.protective, dn.shorts], ['down', puts.protective, puts.shorts])
  assert.match(dn.reason, /the index 20.0 below the open, gap -0.41%: the 25050\/24850 PE debit spread/)
})

test('enter: Expiry Drive opens the straddle-unit spread — the ATM long, the short max(1 step, pb_short_str_k x STR) beyond it', () => {
  const c = ctxAt(ED)
  const plan = planOf(EXPIRY_DRIVE.enter(c))
  const want = debitByStraddle(c, 'up')
  assert.ok(want !== null)
  const str = atmStraddleMid(c.inputs.chain) ?? Number.NaN
  assert.deepEqual([plan.protective, plan.shorts, plan.lots, plan.side], [want.protective, want.shorts, ED.pb_lots, 'up'])
  assert.equal(plan.protective[0]?.strike, 25_000)
  // Read off the preset rather than restated: the distance is a dial (1.0 x STR
  // since the Task 9 finding that 0.6 made a one-step spread whose exits could
  // not fire), and a pin on the number belongs to the presets suite.
  assert.equal(plan.shorts[0]?.strike, 25_000 + Math.max(50, Math.ceil((ED.pb_short_str_k * str) / 50) * 50))
  assert.match(plan.reason, /CE debit spread in straddle units$/)
})

test('enter: no spread on the board is a wait, never half a spread; an unreadable pb_strike_mode trades nothing', () => {
  // The band's only long held short: the kit finds no spread, and neither may we.
  const blocked = TREND_DRIVE.enter(ctxAt(TD, { inputs: { chain: BOARD, legs: [legOn(BOARD, 24_950, 'CE', 'Sell', 1)] } }))
  assert.equal(blocked.kind, 'wait')
  assert.equal(reasonOf(blocked), 'trend-up confirmed, but no CE debit spread by delta bands on this board')
  const atm = EXPIRY_DRIVE.enter(ctxAt(ED, { inputs: { chain: BOARD, legs: [legOn(BOARD, 25_000, 'CE', 'Sell', 1)] } }))
  assert.equal(reasonOf(atm), 'trend-up confirmed, but no CE debit spread in straddle units on this board')
  const odd = TREND_DRIVE.enter(ctxAt({ ...TD, pb_strike_mode: 2 }))
  assert.equal(odd.kind, 'wait')
  assert.match(reasonOf(odd), /pb_strike_mode 2 is neither 0 \(delta bands\) nor 1 \(straddle units\)/)
})

test('debit stop: trade P&L at or through -pb_debit_stop_frac x the debit, held pb_rupee_hold_s, exits urgently and not for the day', () => {
  const line = -0.4 * 13_000 // -5,200
  const above = TREND_DRIVE.exits(onTrade(TD, { tradePnl: line + 1 }))
  quiet(above, 'off: no exit, and the shared rupee clock is not this rule\'s to reset')
  const first = TREND_DRIVE.exits(onTrade(TD, { tradePnl: line }))
  assert.equal(first.exit, undefined, 'the first pass in the zone starts the clock')
  assert.deepEqual(first.patch, { rupeeSinceMs: NOW })
  assert.match(first.note ?? '', /^debit stop pending: trade P&L Rs-5,200 at or through Rs-5,200 — held 0s of 3s$/)
  const kept = TREND_DRIVE.exits(onTrade(TD, { tradePnl: line }, { rupeeSinceMs: NOW - 2_000 }))
  assert.deepEqual([kept.exit, kept.patch], [undefined, { rupeeSinceMs: NOW - 2_000 }], 'a running clock is kept, not restamped')
  const fired = TREND_DRIVE.exits(onTrade(TD, { tradePnl: line - 100 }, { rupeeSinceMs: NOW - 3_000 }))
  assert.deepEqual(fired.exit, {
    reason: 'debit stop: trade P&L Rs-5,300 at or through 40% of the Rs13,000 debit (Rs-5,200), held 3s',
    urgency: 'urgent',
    final: false,
  })
  // Expiry Drive's half, and the rule off: at 0, and on a credit.
  assert.ok(EXPIRY_DRIVE.exits(onTrade(ED, { tradePnl: -6_500 }, { rupeeSinceMs: NOW - 3_000 })).exit !== undefined)
  assert.equal(EXPIRY_DRIVE.exits(onTrade(ED, { tradePnl: -6_499 }, { rupeeSinceMs: NOW - 3_000 })).exit, undefined)
  quiet(TREND_DRIVE.exits(onTrade({ ...TD, pb_debit_stop_frac: 0 }, { tradePnl: -5_900 }, { rupeeSinceMs: NOW - 3_000 })))
  quiet(TREND_DRIVE.exits(onTrade(TD, { cost: -2_000, tradePnl: -5_900 }, { rupeeSinceMs: NOW - 3_000 })))
})

test('flip: the opposite trend held pb_flip_confirm_s on a LOSING trade exits urgently — a winning one is never flipped out (D5)', () => {
  const against = { regime: 'trend-down', regimeHeldMs: 90_000, tradePnl: 0 } as const
  const fired = TREND_DRIVE.exits(onTrade(TD, against, { rupeeSinceMs: NOW - 3_000 }))
  assert.deepEqual(fired.exit, {
    reason: 'flip: trend-down held 90s against the up trade, which is losing (trade P&L Rs0), held 3s',
    urgency: 'urgent',
    final: false,
  })
  const first = TREND_DRIVE.exits(onTrade(TD, against))
  assert.deepEqual([first.exit, first.patch], [undefined, { rupeeSinceMs: NOW }], 'one mark at or under zero is not a loss yet (O19)')
  quiet(TREND_DRIVE.exits(onTrade(TD, { ...against, tradePnl: 1 }, { rupeeSinceMs: NOW - 60_000 })), 'a winner rides')
  quiet(TREND_DRIVE.exits(onTrade(TD, { ...against, regimeHeldMs: 89_999 }, { rupeeSinceMs: NOW - 3_000 })))
  for (const regime of ['trend-up', 'chop', 'quiet', 'unknown'] as const) {
    quiet(TREND_DRIVE.exits(onTrade(TD, { ...against, regime }, { rupeeSinceMs: NOW - 3_000 })), regime)
  }
  quiet(TREND_DRIVE.exits(onTrade({ ...TD, pb_flip_confirm_s: 0 }, against, { rupeeSinceMs: NOW - 3_000 })))
  // A down trade flips on trend-up; Expiry Drive flips at 60 s.
  const downTrade = { side: 'down', rupeeSinceMs: NOW - 3_000 } as const
  assert.ok(TREND_DRIVE.exits(onTrade(TD, { ...against, regime: 'trend-up' }, downTrade)).exit !== undefined)
  assert.ok(EXPIRY_DRIVE.exits(onTrade(ED, { ...against, regimeHeldMs: 60_000 }, { rupeeSinceMs: NOW - 3_000 })).exit !== undefined)
  quiet(EXPIRY_DRIVE.exits(onTrade(ED, { ...against, regimeHeldMs: 59_999 }, { rupeeSinceMs: NOW - 3_000 })))
  // A trade with no side on record cannot be flipped: there is no "opposite".
  quiet(TREND_DRIVE.exits(onTrade(TD, against, { side: '', rupeeSinceMs: NOW - 3_000 })))
})

test('a trend label the detector\'s dwell holds after the tape has let go is no trend: no entry, and no flip (M11)', () => {
  // One bad print turned the label; the slow window now reads a wide range
  // that went nowhere, and only `dl_regime_dwell_s` keeps the label on.
  const dwellHeld = (regime: 'trend-up' | 'trend-down'): Partial<PlaybookCtx> => ({
    regime, read: { ...ctxAt(ED, { ctx: { regime } }).read, slowStat: slowStat(regime === 'trend-up' ? 4 : -4, 260) },
  })
  const entry = EXPIRY_DRIVE.enter(ctxAt(ED, { ctx: { ...dwellHeld('trend-up'), regimeHeldMs: 92_000 } }))
  assert.equal(entry.kind, 'wait')
  assert.equal(reasonOf(entry), 'trend-up held 92s, but the slow window now reads chop: a label the detector\'s dwell is holding, not a trend on the tape')
  const contrary = TREND_DRIVE.exits(onTrade(TD, { ...dwellHeld('trend-down'), regimeHeldMs: 95_000, tradePnl: -800 }, { rupeeSinceMs: NOW - 3_000 }))
  quiet(contrary, 'a dwell-held contrary label')
  assert.equal(contrary.note, 'flip held off: trend-down is a label the detector\'s dwell is holding — the slow window reads chop')
  assert.equal(TREND_DRIVE.adds(onTrade(TD, { ...ADD_CTX, ...dwellHeld('trend-up') }, {}, { chain: BOARD, legs: spreadLegs() })).add, undefined)
  // The same holds with the trend still on the tape: it trades, and it flips.
  assert.equal(EXPIRY_DRIVE.enter(ctxAt(ED, { ctx: { regimeHeldMs: 92_000 } })).kind, 'open')
  assert.ok(TREND_DRIVE.exits(onTrade(TD, { regime: 'trend-down', regimeHeldMs: 95_000, tradePnl: -800 }, { rupeeSinceMs: NOW - 3_000 })).exit !== undefined)
})


test('adds: one long at the long-band strike, 1 lot, add:true onto the held long — a single-stage buy (D6)', () => {
  const step = TREND_DRIVE.adds(onTrade(TD, ADD_CTX, {}, { chain: BOARD, legs: spreadLegs() }))
  const add = step.add
  assert.ok(add !== undefined, step.note ?? 'no add')
  assert.deepEqual(add.protective, [{ op: 'open', strike: 24_950, optType: 'CE', side: 'Buy', lots: 1, add: true }])
  assert.deepEqual([add.shorts, add.lots, add.side], [[], 1, 'up'])
  assert.equal(add.reason, 'pyramid: trade P&L Rs1,500 and trend-up held 130s, the index 75.0 beyond the 25000.0 entry (0.5 x Dday = 75.0): one 24950CE')
  // A strike the book does not hold is a plain open.
  const fresh = TREND_DRIVE.adds(onTrade(TD, ADD_CTX, {}, { chain: BOARD, legs: [] }))
  assert.deepEqual(fresh.add?.protective, [{ op: 'open', strike: 24_950, optType: 'CE', side: 'Buy', lots: 1 }])
  // A down trade adds a put.
  const puts = TREND_DRIVE.adds(onTrade(TD, { ...ADD_CTX, regime: 'trend-down', spot: OPEN - 75 }, { side: 'down' }, { chain: BOARD }))
  assert.equal(puts.add?.protective[0]?.optType, 'PE')
})

test('adds: every condition binds — a winning trade, its own trend held, Dday known, S fresh and 0.5 x Dday out — and the cap', () => {
  const legs = { chain: BOARD, legs: spreadLegs() }
  const none = (ctx: Partial<PlaybookCtx>, pb: Partial<PlaybookState> = {}, dials: Dials = TD): void => {
    const step = TREND_DRIVE.adds(onTrade(dials, { ...ADD_CTX, ...ctx }, pb, legs))
    assert.equal(step.add, undefined, JSON.stringify({ ctx, pb }))
  }
  none({ tradePnl: 0 })
  none({ regime: 'chop' })
  none({ regime: 'trend-down' })
  none({ regimeHeldMs: 119_999 })
  none({ dayImplied: null })
  none({ spotFresh: false })
  none({ spot: null })
  none({ spot: OPEN + 74.9 })
  none({}, { side: '' })
  none({}, { adds: 1 })
  none({}, {}, { ...TD, pb_max_adds: 0 })
  assert.ok(TREND_DRIVE.adds(onTrade(TD, ADD_CTX, {}, legs)).add !== undefined, 'and with all of them, it adds')
})

test('adds: the extension is measured on the STEADIED index — one bad print in the trend\'s direction buys nothing (M11, engine review finding 5)', () => {
  const legs = { chain: BOARD, legs: spreadLegs() }
  const add = (level: (ms: number) => number): PlaybookStep =>
    TREND_DRIVE.adds(onTrade(TD, { ...ADD_CTX, spot: level(NOW) }, {}, legs, level))
  // The tape at the entry; this pass's one print 200 points out.
  const one = add((ms) => (ms === NOW ? OPEN + 200 : OPEN))
  assert.equal(one.add, undefined, JSON.stringify(one))
  // Two prints there are the market: the add goes, measured on them.
  const two = add((ms) => (ms >= NOW - 1_000 ? OPEN + 200 : OPEN))
  assert.ok(two.add !== undefined, two.note ?? 'no add')
  assert.match(two.add.reason, /the index 200\.0 beyond the 25000\.0 entry/)
})

test('adds never buy a strike the book holds short; Expiry Drive\'s add, were its cap raised, is the ATM strike', () => {
  // The band's only strike held short: no add at all, never a buy that nets the short away.
  const short = TREND_DRIVE.adds(onTrade(TD, ADD_CTX, {}, { chain: BOARD, legs: [legOn(BOARD, 24_950, 'CE', 'Sell', 1, { mtm: 0 })] }))
  assert.equal(short.add, undefined)
  assert.equal(short.note, 'pyramid wanted, but no tradable CE strike in the 0.55-0.65 long band that the book does not hold short')
  // Wider bands hold another candidate, and the exclusion goes there.
  const wide = { ...TD, dl_long_delta_lo: 0.45, dl_long_delta_hi: 0.8 }
  const other = TREND_DRIVE.adds(onTrade(wide, ADD_CTX, {}, { chain: BOARD, legs: [legOn(BOARD, 24_950, 'CE', 'Sell', 1, { mtm: 0 })] }))
  assert.ok(other.add !== undefined)
  assert.notEqual(other.add.protective[0]?.strike, 24_950)

  const ed = { ...ED, pb_max_adds: 1 }
  const atm = EXPIRY_DRIVE.adds(onTrade(ed, { ...ADD_CTX, regimeHeldMs: 90_000 }, {}, { chain: BOARD, legs: [legOn(BOARD, 25_000, 'CE', 'Buy', 2, { mtm: 0 })] }))
  assert.deepEqual(atm.add?.protective, [{ op: 'open', strike: 25_000, optType: 'CE', side: 'Buy', lots: 1, add: true }])
  const blocked = EXPIRY_DRIVE.adds(onTrade(ed, ADD_CTX, {}, { chain: BOARD, legs: [legOn(BOARD, 25_000, 'CE', 'Sell', 1, { mtm: 0 })] }))
  assert.equal(blocked.add, undefined)
  quiet(EXPIRY_DRIVE.adds(onTrade(ED, ADD_CTX, {}, { chain: BOARD })), 'the shipped Expiry Drive never pyramids')
})

// ── the rules, through the production frame ─────────────────────────────────

/** 25,000 until 09:50, then up `ptsPer5` points every five minutes, cleanly:
 * a tape the detector reads as a trend up from about 09:54 (or down). */
const drive = (ptsPer5: number) => (ms: number): number => OPEN + Math.max(0, ms - at(590)) * (ptsPer5 / 300_000)
const run = (inputs: Parameters<typeof decidePlaybook>[0], dials: Dials, state: RuleState): EngineDecision =>
  decidePlaybook(inputs, dials, state, MARK)
const opens = (d: EngineDecision): Array<[number, string, string, number, boolean]> =>
  d.actions.flatMap((a: EngineAction) => (a.op === 'open' ? [[a.strike, a.optType, a.side, a.lots, a.add === true]] : []))

test('through the frame: a confirmed trend up opens stage 1 — the band long alone at 2 lots, the short planned against it', () => {
  const tape = new Tape(drive(54))
  const inputs = inputsAt(tape, NOW)
  const d = run(inputs, TD, stateWith({}, { dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 130_000 }))
  assert.equal(d.trigger, 'dl-open', d.reason)
  assert.match(d.reason, /^trend-drive: trend-up held 130s, the index 108.0 above the open, gap unknown .*by delta bands — stage 1: buying 1 protective leg\(s\) at 2 lot\(s\) a leg; 1 short\(s\) to follow once covered$/)
  const [long] = opens(d)
  assert.ok(long !== undefined)
  assert.deepEqual(long.slice(1), ['CE', 'Buy', 2, false])
  assert.deepEqual(d.stateAfter.pb.planShorts.map((s) => [s.optType, s.cover]), [['CE', long[0]]])
  assert.equal(d.stateAfter.pb.side, 'up')
  // The same tape on Expiry Drive's dials is the wrong contract: no entry (O11).
  const ed = run(inputsAt(new Tape(drive(54)), NOW), ED, stateWith({}, { dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 130_000 }))
  assert.equal(ed.action, 'hold')
  assert.match(ed.reason, /^expiry-drive: no new risk — wrong contract: the preset trades only today's expiry/)
})

test('through the frame: the debit stop and the flip are dl-exit, urgent, shorts bought back first; a winner on a contrary trend holds', () => {
  const legs = spreadLegs()
  const cost = legs.reduce((s, l) => s + (l.side === 'Buy' ? 1 : -1) * l.entry * l.lots * l.lotSize, 0)
  const pnl = Math.round(-0.4 * cost) - 100 // through the debit line, short of the 6,000 hard stop
  assert.ok(pnl > -TD.pb_trade_max_loss)
  const calm = new Tape()
  const debit = run(inputsAt(calm, NOW, { chain: BOARD, legs, cumRealized: pnl }), TD, stateWith({ ...TRADE, rupeeSinceMs: NOW - 3_000 }))
  assert.equal(debit.trigger, 'dl-exit')
  assert.equal(debit.urgency, 'urgent')
  assert.match(debit.reason, /^trend-drive: debit stop: trade P&L .* at or through 40% of the .* debit .*, held 3s — buying back 1 short\(s\) first, 1 long\(s\) after$/)
  assert.deepEqual(debit.actions, [{ op: 'close', instrument: legs[1]?.instrument }])
  assert.equal(debit.stateAfter.pb.doneForDay, false, 'not final: the day may trade again if entries remain')

  // A falling tape reads trend-down, held 95 s, against the up trade.
  const down = new Tape(drive(-54))
  const st = (rupee: number): RuleState => stateWith({ ...TRADE, rupeeSinceMs: rupee }, { dlRegime: 'trend-down', dlRegimeSinceMs: NOW - 95_000 })
  const flip = run(inputsAt(down, NOW, { chain: BOARD, legs, cumRealized: -500 }), TD, st(NOW - 3_000))
  assert.equal(flip.trigger, 'dl-exit', flip.reason)
  assert.match(flip.reason, /^trend-drive: flip: trend-down held 95s against the up trade, which is losing \(trade P&L Rs-500\), held 3s/)
  const winner = run(inputsAt(new Tape(drive(-54)), NOW, { chain: BOARD, legs, cumRealized: 500 }), TD, st(0))
  assert.equal(winner.action, 'hold', winner.reason)
  assert.equal(winner.stateAfter.pb.rupeeSinceMs, 0)
})

test('through the frame: the pyramid is one dl-add of one lot, paced by pb_retry_s, and never a second', () => {
  const tape = new Tape(drive(54))
  const inputs = (over: InputsOver = {}): Parameters<typeof decidePlaybook>[0] =>
    inputsAt(tape, NOW, { chain: BOARD, legs: spreadLegs(), cumRealized: 1_000, ...over })
  const pb = { ...TRADE, entrySpot: OPEN, dayImplied: 150 }
  const regime = { dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 130_000 } as const
  const d = run(inputs(), TD, stateWith(pb, regime))
  assert.equal(d.trigger, 'dl-add', d.reason)
  assert.deepEqual(opens(d), [[24_950, 'CE', 'Buy', 1, true]])
  assert.match(d.reason, /^trend-drive: pyramid: .* — adding 1 long\(s\) at 1 lot\(s\)$/)
  assert.equal(d.stateAfter.pb.adds, 1)
  assert.equal(d.markState.pb.adds, 0, 'a refused add is not spent')
  const second = run(inputs(), TD, stateWith({ ...pb, adds: 1 }, regime))
  assert.equal(second.action, 'hold')
  const paced = run(inputs(), TD, stateWith(pb, { ...regime, dlLastAdjustMs: NOW - 10_000 }))
  assert.match(paced.reason, /^trend-drive: add wanted \(pyramid: .*\) — 20s left of the 30s retry interval/)
})

// ── the scenarios (spec §7) ─────────────────────────────────────────────────

const FRI = DATE // Friday 16 Oct: NIFTY's weekly of Monday 19 Oct is one session out
const WEEKLY = '2026-10-19'
const EXPIRY_DAY = '2026-10-19' // that Monday is the weekly's own expiry day
const IV = 0.12
const IV_0DTE = 0.15
const NOISE = 1.5
/** The two passes a D2 close takes at the touch (the shorts, then the longs)
 * plus the rupee hold: what a stop may cost beyond its own line. */
const SLACK = 500

/** The opening board's 5-minute implied move — the detector's own yardstick. */
function implied5(dateIst: string, expiry: string, iv: number): number {
  const minute = 571
  const chain = buildChain({ symbol: 'NIFTY', expiry, dateIst, minuteOfDay: minute, index: OPEN, atmIv: iv, nowMs: istMs(dateIst, minute) })
  return impliedMove(chain, minutesToExpiry(dateIst, minute, expiry), 5)
}

/** `Dday` as the fold freezes it at 09:16: STR x sqrt(min(375, MTE) / MTE). */
function dayImpliedOf(dateIst: string, expiry: string, iv: number): number {
  const minute = 556
  const chain = buildChain({ symbol: 'NIFTY', expiry, dateIst, minuteOfDay: minute, index: OPEN, atmIv: iv, nowMs: istMs(dateIst, minute) })
  const mte = minutesToExpiry(dateIst, minute, expiry)
  return (atmStraddleMid(chain) ?? Number.NaN) * Math.sqrt(Math.min(375, mte) / mte)
}

const I5 = implied5(FRI, WEEKLY, IV)
const DDAY = dayImpliedOf(FRI, WEEKLY, IV)
const I5X = implied5(EXPIRY_DAY, EXPIRY_DAY, IV_0DTE)

/** 2-minute legs of 1.2x implied, alternating; `up` says which way the first
 * goes. An even count ends on a leg against the first, back where it began. */
const zigzag = (i5: number, legs: number, up: boolean): Segment[] =>
  Array.from({ length: legs }, (_, i) => ({ minutes: 2, drift: (i % 2 === 0) === up ? 1.2 * i5 : -1.2 * i5, noise: NOISE }))
/** `n` 5-minute bursts of `k` x implied in `dir`, 3 minutes apart. */
const bursts = (i5: number, k: number, n: number, dir: 1 | -1): Segment[] =>
  Array.from({ length: n }, (_, i): Segment[] => [
    ...(i > 0 ? [{ minutes: 3, drift: 0, noise: NOISE }] : []),
    { minutes: 5, drift: dir * k * i5, noise: NOISE },
  ]).flat()
const still = (minutes: number, noise = NOISE): Segment => ({ minutes, drift: 0, noise })
/** The previous close that makes the 25,000 open a gap of `pct` percent. */
const gapOf = (pct: number): number => OPEN / (1 + pct / 100)

function day(over: Partial<ScenarioSpec> & Pick<ScenarioSpec, 'name' | 'segments'>): ScenarioSpec {
  return { symbol: 'NIFTY', dateIst: FRI, expiry: WEEKLY, open: OPEN, baseIv: IV, seed: 11, ...over }
}

/** The morning of M1: a 0.4% gap, a two-way 09:15-09:31, four bursts up of
 * 2.5x implied (the spec's floor), then a still afternoon. */
const M1_TAPE: Segment[] = [...zigzag(I5, 8, true), ...bursts(I5, 2.5, 4, 1), still(330)]

const SCENARIOS = {
  M1: day({ name: 'M1 trend up in bursts after a 0.4% gap', prevClose: gapOf(0.4), segments: M1_TAPE }),
  M2: day({
    name: 'M2 trend down in bursts after a -0.4% gap', prevClose: gapOf(-0.4),
    segments: [...zigzag(I5, 8, false), ...bursts(I5, 2.5, 4, -1), still(330)],
  }),
  M3: day({
    name: 'M3 gap up one Dday and go', prevClose: OPEN - DDAY,
    segments: [{ minutes: 30, drift: 15 * I5, noise: NOISE }, { minutes: 60, drift: 2 * I5, noise: NOISE }, still(285)],
  }),
  M5: day({ name: 'M5 tight range, a 0.1% gap', prevClose: gapOf(0.1), segments: [still(375, 2)] }),
  M6: day({
    name: 'M6 wide two-way chop', prevClose: gapOf(0.4),
    segments: [
      { minutes: 3, drift: 1.5 * I5, noise: 2 },
      ...Array.from({ length: 30 }, (_, i): Segment => ({ minutes: 6, drift: (i % 2 === 0 ? -3 : 3) * I5, noise: 2 })),
      still(192, 2),
    ],
  }),
  M7: day({
    name: 'M7 morning trend up, then a V below the open', prevClose: gapOf(0.4),
    segments: [...zigzag(I5, 8, true), ...bursts(I5, 2.5, 3, 1), { minutes: 25, drift: -10.5 * I5, noise: NOISE }, still(298)],
  }),
  M8: day({
    name: 'M8 quiet morning, trend after 11:00', prevClose: gapOf(0.4),
    segments: [still(105, 1), ...bursts(I5, 3, 4, 1), still(241)],
  }),
  M11: day({
    name: 'M11 one bad print 1% away on a two-way morning', prevClose: gapOf(0.4),
    segments: [{ minutes: 2, drift: 1.5 * I5, noise: NOISE }, ...zigzag(I5, 60, false), still(253)],
    spikes: [{ atMin: 585, pts: OPEN * 0.01 }],
  }),
  // Two bursts up (no add: under 0.5 x Dday beyond the entry), then a slow
  // fade of 1x implied per 5 minutes — never a trend down, but enough to put
  // the trade under water by 10:05, when ONE bad print 1% below lands.
  M11S: day({
    name: 'M11 on the stop side: a bad print against a losing trade', prevClose: gapOf(0.4),
    segments: [...zigzag(I5, 8, true), ...bursts(I5, 2.5, 2, 1), { minutes: 40, drift: -8 * I5, noise: NOISE }, still(282)],
    spikes: [{ atMin: 605, pts: -OPEN * 0.01 }],
  }),
  M19: day({ name: 'M19 a 0.1% gap that trends', prevClose: gapOf(0.1), segments: M1_TAPE }),
  O1: day({ name: 'O1 the index stale 09:28-09:40', prevClose: gapOf(0.4), segments: M1_TAPE, holes: [{ fromMin: 568, toMin: 580 }] }),
  O9: day({
    name: 'O9 the supervisor starts at 10:00', prevClose: gapOf(0.4), startMin: 600,
    segments: [...zigzag(I5, 22, true), still(1), ...bursts(I5, 3, 3, 1), still(310)],
  }),
  FILLS: day({
    name: 'the hedge short is skipped by the desk', prevClose: gapOf(0.4), segments: M1_TAPE,
    fills: (_pass, a) => (a.op === 'open' && a.side === 'Sell' ? 'skip' : 'fill'),
  }),
  M11X: day({
    name: 'M11 on expiry day: one bad print 1% away', dateIst: EXPIRY_DAY, expiry: EXPIRY_DAY, baseIv: IV_0DTE, prevClose: gapOf(0.4),
    segments: [{ minutes: 2, drift: 1.5 * I5X, noise: 1 }, ...zigzag(I5X, 60, false), still(253, 1)],
    spikes: [{ atMin: 585, pts: OPEN * 0.01 }],
  }),
  M14: day({
    name: 'M14 an expiry morning trend', dateIst: EXPIRY_DAY, expiry: EXPIRY_DAY, baseIv: IV_0DTE, prevClose: gapOf(0.4),
    segments: [...zigzag(I5X, 8, true), ...bursts(I5X, 3, 3, 1), still(323, 1)],
  }),
  O11: day({
    name: 'O11 Expiry Drive handed a 3-session contract', dateIst: '2026-10-22', expiry: '2026-10-27', prevClose: gapOf(0.4),
    segments: [...zigzag(implied5('2026-10-22', '2026-10-27', IV), 8, true), ...bursts(implied5('2026-10-22', '2026-10-27', IV), 3, 3, 1), still(323)],
  }),
} as const

const RUNS = new Map<keyof typeof SCENARIOS, SimResult>()
/** One scenario, run once on its preset and remembered: Expiry Drive for the
 * expiry-day and wrong-contract days, Trend Drive for the rest. */
function sim(key: keyof typeof SCENARIOS): SimResult {
  const done = RUNS.get(key)
  if (done !== undefined) return done
  const dials = key === 'M14' || key === 'M11X' || key === 'O11' ? ED : TD
  const r = runSession(decidePlaybook, dials, SCENARIOS[key])
  RUNS.set(key, r)
  return r
}

const show = (r: SimResult): string =>
  JSON.stringify(r.trades.map((t) => ({ ...t, pnl: Math.round(t.pnl) })))
/** Stage 1 of every entry: a dl-open that BUYS. (Stage 2 is a dl-open that sells.) */
const entries = (r: SimResult): SimResult['decisions'] =>
  r.decisions.filter((d) => d.trigger === 'dl-open' && d.actions.some((a) => a.op === 'open' && a.side === 'Buy'))
const adds = (r: SimResult): SimResult['decisions'] => r.decisions.filter((d) => d.trigger === 'dl-add')

/** D1 on every pass, and flat by 15:00 — asked of every scenario. */
function safe(r: SimResult, what: string): void {
  assert.equal(r.nakedShortPasses, 0, `${what}: ${r.nakedShortPasses} pass(es) short an option not covered lot for lot`)
  for (const t of r.trades) {
    assert.ok(t.closeMin !== null && t.closeMin <= 900, `${what}: a trade still open after 15:00: ${JSON.stringify(t)}`)
  }
}

/** Every pass in IST minutes `[from, to)` held for the one reason `re` — the
 * gate a scenario is about, and not some other rule standing in front of it. */
function allSay(r: SimResult, from: number, to: number, re: RegExp): void {
  const passes = r.decisions.filter((d) => d.minute >= from && d.minute < to)
  assert.ok(passes.length > 0, `no pass in minutes ${from}-${to}`)
  const odd = passes.find((d) => !re.test(d.reason))
  assert.equal(odd, undefined, `minute ${odd?.minute}: ${odd?.reason}`)
}

/** The first trade's realised P&L, asserting there is exactly one. */
function oneTrade(r: SimResult, what: string): SimResult['trades'][number] {
  assert.equal(r.trades.length, 1, `${what}: ${show(r)}`)
  const t = r.trades[0]
  assert.ok(t !== undefined)
  return t
}

test('the scenarios are sized in the detector\'s own units: 5-minute implied and Dday off each day\'s opening board', () => {
  assert.ok(I5 > 15 && I5 < 21, `a 1-DTE NIFTY 5-minute implied of ${I5}`)
  assert.ok(DDAY > 140 && DDAY < 170, `a 1-DTE NIFTY Dday of ${DDAY}`)
  assert.ok(I5X > 7 && I5X < 12, `a 0-DTE NIFTY 5-minute implied of ${I5X}`)
})

test('M1 — a 0.4% gap and a trend up in bursts of 2.5x implied: Trend Drive enters up before 10:15, adds once, and ends positive', () => {
  const r = sim('M1')
  safe(r, 'M1')
  const [entry] = entries(r)
  assert.ok(entry !== undefined, 'no entry on a trend day')
  assert.ok(entry.minute >= 570 && entry.minute < 615, `entered at minute ${entry.minute}`)
  assert.match(entry.reason, /^trend-drive: trend-up held \d+s, the index [\d.]+ above the open, gap \+0\.40%: the \d+\/\d+ CE debit spread by delta bands/)
  assert.equal(adds(r).length, 1, `the pyramid: ${adds(r).map((d) => d.reason).join(' | ')}`)
  const t = oneTrade(r, 'M1')
  assert.equal(t.side, 'up')
  assert.ok(t.pnl > 0, `M1 lost: ${show(r)}`)
})

test('M2 — the mirror: a -0.4% gap and bursts down: Trend Drive enters down before 10:15 and ends positive', () => {
  const r = sim('M2')
  safe(r, 'M2')
  const [entry] = entries(r)
  assert.ok(entry !== undefined, 'no entry on a trend-down day')
  assert.ok(entry.minute >= 570 && entry.minute < 615, `entered at minute ${entry.minute}`)
  assert.match(entry.reason, /PE debit spread by delta bands/)
  assert.ok(adds(r).length <= 1)
  const t = oneTrade(r, 'M2')
  assert.equal(t.side, 'down')
  assert.ok(t.pnl > 0, `M2 lost: ${show(r)}`)
})

test('M3 — a gap up of one Dday that keeps going: Trend Drive enters and is positive', () => {
  const r = sim('M3')
  safe(r, 'M3')
  const [entry] = entries(r)
  assert.ok(entry !== undefined && entry.minute < 615, 'no entry on a gap-and-go')
  assert.match(entry.reason, /gap \+0\.6\d%/)
  assert.ok(adds(r).length <= 1)
  const t = oneTrade(r, 'M3')
  assert.equal(t.side, 'up')
  assert.ok(t.pnl > 0, `M3 lost: ${show(r)}`)
})

test('M5 — a tight range on a 0.1% gap: Trend Drive stays out, and the gap gate is what it says', () => {
  const r = sim('M5')
  safe(r, 'M5')
  assert.deepEqual(r.decisions.filter((d) => d.trigger === 'dl-open'), [])
  assert.equal(r.trades.length, 0)
  allSay(r, 570, 615, /no new risk — the opening gap is 0\.10%, under the 0\.25% minimum$/)
})

test('M6 — a wide two-way chop: at most one trade, and its loss inside the hard stop', () => {
  const r = sim('M6')
  safe(r, 'M6')
  assert.ok(r.trades.length <= 1, show(r))
  for (const t of r.trades) assert.ok(t.pnl >= -(TD.pb_trade_max_loss + SLACK), `M6: ${show(r)}`)
  assert.ok(r.minPnl >= -(TD.pb_trade_max_loss + SLACK), `the day's low mark ${Math.round(r.minPnl)}`)
})

test('M7 — a morning trend up, then a V below the open: an up entry, a bounded loss, and no flip while the trade was winning (D5)', () => {
  const r = sim('M7')
  safe(r, 'M7')
  const t = oneTrade(r, 'M7')
  assert.equal(t.side, 'up')
  assert.ok(t.pnl >= -(TD.pb_trade_max_loss + SLACK), `M7: ${show(r)}`)
  const flips = r.decisions.filter((d) => d.trigger === 'dl-exit' && /: flip: /.test(d.reason))
  for (const f of flips) {
    const m = /trade P&L Rs(-?[\d,]+)\)/.exec(f.reason)
    assert.ok(m !== null && Number((m[1] ?? '').replace(/,/g, '')) <= 0, `a flip on a winner: ${f.reason}`)
  }
})

test('M8 — a quiet morning and a trend after 11:00: Trend Drive stays out, held by its window', () => {
  const r = sim('M8')
  safe(r, 'M8')
  assert.deepEqual(r.decisions.filter((d) => d.trigger === 'dl-open'), [])
  allSay(r, 660, 720, /no new risk — \d\d:\d\d is outside the 09:30-10:15 entry window$/)
})

test('M11 — one bad print 1% away is read by the detector, and opens nothing', () => {
  const r = sim('M11')
  safe(r, 'M11')
  // The print DID reach the detector: the label turned for it...
  assert.ok(r.decisions.some((d) => d.minute === 585 && /trend-up held 0s of the 120s confirm/.test(d.reason)), 'the spike was never read')
  // ...and the label alone, held by the detector's dwell, never confirmed.
  assert.deepEqual(entries(r), [])
  assert.equal(r.trades.length, 0)
})

test('M11 on the stop side — a bad print 1% against a losing trade turns the label for the dwell, and fires no flip', () => {
  const r = sim('M11S')
  safe(r, 'M11S')
  const t = oneTrade(r, 'M11S')
  assert.ok(t.openMin < 605, `the trade must be on before the print: ${show(r)}`)
  // The print reached the detector: the label turned against the losing trade
  // and was held past the 90 s flip...
  const held = r.decisions.filter((d) => d.minute >= 605 && d.minute < 607 && /flip held off: trend-down is a label the detector's dwell is holding/.test(d.reason))
  assert.ok(held.length > 0, `the spike was never read: ${r.decisions.find((d) => d.minute === 606)?.reason}`)
  // ...and nothing closed on it.
  const flips = r.decisions.filter((d) => d.trigger === 'dl-exit' && /: flip: /.test(d.reason))
  assert.deepEqual(flips.map((d) => `${d.minute} ${d.reason}`), [])
  assert.ok(t.closeMin === null || t.closeMin > 610, `closed at ${t.closeMin} on a bad print: ${t.closeReason}`)
  assert.ok(t.pnl >= -(TD.pb_trade_max_loss + SLACK), show(r))
})

test('M19 — a 0.1% gap on the very tape that trades in M1: Trend Drive stands down — the gate\'s cost, a missed trade', () => {
  const r = sim('M19')
  safe(r, 'M19')
  assert.deepEqual(r.decisions.filter((d) => d.trigger === 'dl-open'), [])
  assert.ok(r.decisions.some((d) => /the opening gap is 0\.10%, under the 0\.25% minimum/.test(d.reason)))
  assert.ok(entries(sim('M1')).length > 0, 'the same tape on a 0.4% gap does trade')
})

test('O1 — the index stale 09:28-09:40: no entry inside the hole, held by the stale-index gate', () => {
  const r = sim('O1')
  safe(r, 'O1')
  assert.deepEqual(entries(r).filter((d) => d.minute >= 568 && d.minute < 580), [])
  allSay(r, 571, 580, /no new risk — the index is [\d.]+s stale, past 10s$/)
  for (const e of entries(r)) assert.ok(e.minute >= 580, `entered at ${e.minute}`)
})

test('O9 — started at 10:00: the fold never saw the open, so the open-direction test is skipped, and the trend still trades', () => {
  const r = sim('O9')
  safe(r, 'O9')
  assert.equal(dayComplete(r.finalState.pb, FRI), false)
  const [entry] = entries(r)
  assert.ok(entry !== undefined && entry.minute >= 600 && entry.minute < 615, `no entry after a 10:00 start: ${show(r)}`)
  assert.match(entry.reason, /the fold never saw the open: the open-direction test skipped/)
  assert.match(entry.reason, /gap unknown \(the 0\.25% gap gate skipped\)/)
})

test('fills — the desk skips every hedge sale: the frame re-sends it, then aborts at 120 s and sells the long; never naked', () => {
  const r = sim('FILLS')
  safe(r, 'FILLS')
  const t = oneTrade(r, 'FILLS')
  assert.equal(t.openTrigger, 'dl-open')
  assert.equal(t.closeTrigger, 'dl-exit')
  assert.match(t.closeReason, /^trend-drive: stage-2 abort: \d+CE still unsold \d+s after the protective legs were held — selling 1 long\(s\), no short left$/)
  assert.ok(r.outcomes.skipped >= 2, `the sale was re-sent: ${JSON.stringify(r.outcomes)}`)
  assert.deepEqual(adds(r), [], 'an unfinished package never pyramids')
  assert.equal(r.finalState.dlStopped, true, 'the entry is spent: done for the day')
})

test('M11 on expiry day — the same bad print, on Expiry Drive\'s 90 s confirm: no entry', () => {
  const r = sim('M11X')
  safe(r, 'M11X')
  assert.ok(r.decisions.some((d) => d.minute === 585 && /trend-up held 0s of the 90s confirm/.test(d.reason)), 'the spike was never read')
  // Past the 90 s confirm the label is still up — the detector's 120 s dwell
  // holds it — and the tape is what refuses it.
  assert.ok(
    r.decisions.some((d) => d.minute === 586 && /trend-up held 9\ds, but the slow window now reads chop: a label the detector's dwell is holding/.test(d.reason)),
    `the dwell-held label was not what held the entry: ${r.decisions.find((d) => d.minute === 586)?.reason}`,
  )
  assert.deepEqual(entries(r), [], `an entry on a bad print: ${entries(r).map((d) => `${d.minute} ${d.reason}`).join(' | ')}`)
})

test('M14 — an expiry-morning trend: Expiry Drive enters before 10:15 and is flat by 12:00 on its time exit', () => {
  const r = sim('M14')
  safe(r, 'M14')
  const [entry] = entries(r)
  assert.ok(entry !== undefined && entry.minute >= 570 && entry.minute < 615, `no entry on the expiry morning: ${show(r)}`)
  assert.match(entry.reason, /^expiry-drive: trend-up held \d+s, .*: the 25\d+\/25\d+ CE debit spread in straddle units/)
  const t = oneTrade(r, 'M14')
  assert.ok(t.closeMin !== null && t.closeMin <= 720, `still open after 12:00: ${show(r)}`)
  assert.equal(t.closeTrigger, 'dl-exit')
  assert.match(t.closeReason, /time exit: 12:00 at or past 12:00 — final for the day/)
  assert.equal(r.trades.filter((x) => x.openMin >= 720).length, 0, 'nothing after the time exit')
})

test('O11 — Expiry Drive handed a contract three sessions out: no entry, the wrong contract named every pass', () => {
  const r = sim('O11')
  safe(r, 'O11')
  assert.deepEqual(r.decisions.filter((d) => d.trigger === 'dl-open'), [])
  allSay(r, 555, 890, /no new risk — wrong contract: the preset trades only today's expiry, and 2026-10-27 is 3 trading day\(s\) out$/)
})
