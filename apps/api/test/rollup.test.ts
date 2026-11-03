/**
 * The Phase B arithmetic, tested where it is pure.
 *
 * `packages/pnl` already proves average cost, the short credit and the mark in
 * isolation. What is NOT proven there, and is proven here, is everything this
 * layer adds on top of it: the window split that makes a carried position
 * price correctly, the null-not-zero discipline on an unmarked leg, a rollup
 * that survives a gap in the snapshot series, and the prune guard.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDailyReport,
  computeWindowPnl,
  extremes,
  inTradingSession,
  istMinutesOfDay,
  planPrune,
  splitFills,
  symbolsIn,
  type SeriesPoint,
  type StampedFill,
} from '../src/rollup.ts'
import { istDayRange } from '../src/routes/kit.ts'

const DAY = '2026-07-27'
const { from: DAY_START } = istDayRange(DAY)
const YESTERDAY = DAY_START - 6 * 60 * 60 * 1000
const T = (minutes: number): number => DAY_START + minutes * 60_000

function fill(
  tradingsymbol: string,
  side: 'Buy' | 'Sell',
  qty: number,
  price: number,
  ts: number,
): StampedFill {
  return { tradingsymbol, side, qty, price, ts }
}

function windowOf(fills: readonly StampedFill[]): ReturnType<typeof splitFills> {
  return splitFills(fills, DAY_START)
}

// --------------------------------------------------------------- realised

test('realised across open, close, roll and resize', () => {
  const fills = [
    // open a short
    fill('NIFTY26JUL25000CE', 'Sell', 75, 120, T(1)),
    // roll it: buy back, sell the next strike
    fill('NIFTY26JUL25000CE', 'Buy', 75, 100, T(2)),
    fill('NIFTY26JUL25100CE', 'Sell', 75, 90, T(3)),
    // resize the new leg down by buying a third of it back
    fill('NIFTY26JUL25100CE', 'Buy', 25, 80, T(4)),
    // and close the rest
    fill('NIFTY26JUL25100CE', 'Buy', 50, 70, T(5)),
  ]
  const pnl = computeWindowPnl(windowOf(fills), {})
  // 75*(120-100) = 1500 on the roll, 25*10 + 50*20 = 1250 on the new leg.
  assert.equal(pnl.realised, 2750)
  assert.equal(pnl.openLegs, 0)
  // Flat book: nothing to mark, so it is complete and total IS the realised
  // figure — this is the one case where a 0 unrealised is a fact, not a gap.
  assert.equal(pnl.unrealised, 0)
  assert.equal(pnl.total, 2750)
  assert.deepEqual(pnl.unpriced, [])
})

test('average cost survives a partial close: the remainder keeps its average', () => {
  const fills = [
    fill('BHEL26AUG420CE', 'Buy', 2625, 10, T(1)),
    fill('BHEL26AUG420CE', 'Buy', 2625, 14, T(2)),
    fill('BHEL26AUG420CE', 'Sell', 2625, 20, T(3)),
  ]
  const pnl = computeWindowPnl(windowOf(fills), { BHEL26AUG420CE: 20 })
  const leg = pnl.positions.find((p) => p.tradingsymbol === 'BHEL26AUG420CE')
  assert.equal(leg?.avgCost, 12, 'remainder must NOT be re-based to the closing price')
  assert.equal(pnl.realised, 2625 * 8)
  assert.equal(pnl.unrealised, 2625 * 8)
})

test('a short opens as a credit and buying it back realises against that credit', () => {
  const short = [fill('BHEL26AUG420CE', 'Sell', 13125, 15, T(1))]
  const opened = computeWindowPnl(windowOf(short), { BHEL26AUG420CE: 12 })
  assert.equal(opened.positions[0]?.qty, -13125, 'short is a NEGATIVE quantity')
  assert.equal(opened.positions[0]?.avgCost, 15, 'avgCost is the premium RECEIVED')
  assert.equal(opened.realised, 0)
  // -13125 * (12 - 15): the credit is a gain as the option decays.
  assert.equal(opened.unrealised, 39_375)

  const closed = computeWindowPnl(
    windowOf([...short, fill('BHEL26AUG420CE', 'Buy', 13125, 12, T(2))]),
    {},
  )
  assert.equal(closed.realised, 39_375, 'the buy-back books the decay')
  assert.equal(closed.openLegs, 0)
})

// ------------------------------------------------------- the carried window

test('a leg carried from yesterday realises against ITS average, not the buy-back price', () => {
  const fills = [
    fill('BHEL26AUG420CE', 'Sell', 100, 20, YESTERDAY),
    fill('BHEL26AUG420CE', 'Buy', 100, 18, T(30)),
  ]
  const w = windowOf(fills)
  assert.equal(w.carried.length, 1)
  assert.equal(w.during.length, 1)

  const pnl = computeWindowPnl(w, {})
  assert.equal(pnl.realised, 200, "today's buy-back books 100 x (20 - 18)")

  // The failure this guards against: dropping the carry makes the buy-back look
  // like OPENING a long, so realised reads 0 and the book claims +100 contracts.
  const withoutCarry = computeWindowPnl({ carried: [], during: w.during }, {})
  assert.equal(withoutCarry.realised, 0)
  assert.equal(withoutCarry.positions[0]?.qty, 100)
})

test("realised reports only the window's own bookings, not the carry's", () => {
  const fills = [
    fill('BHEL26AUG420CE', 'Sell', 50, 20, YESTERDAY),
    // Yesterday's own partial cover: 20 x (20 - 19) = 20, already reported then.
    fill('BHEL26AUG420CE', 'Buy', 20, 19, YESTERDAY + 60_000),
    // Today's cover: 30 x (20 - 18) = 60.
    fill('BHEL26AUG420CE', 'Buy', 30, 18, T(10)),
  ]
  const pnl = computeWindowPnl(windowOf(fills), {})
  assert.equal(pnl.realised, 60, "yesterday's 20 must not reappear in today's number")
  assert.equal(pnl.openLegs, 0)
})

// ---------------------------------------------------- null, never zero (§8)

test('one unmarked open leg nulls unrealised AND total, and names the contract', () => {
  const fills = [
    fill('BHEL26AUG420CE', 'Sell', 100, 20, T(1)),
    fill('BHEL26AUG430CE', 'Sell', 100, 10, T(2)),
    fill('BHEL26AUG440CE', 'Sell', 100, 5, T(3)),
  ]
  const pnl = computeWindowPnl(windowOf(fills), { BHEL26AUG420CE: 18 })
  assert.equal(pnl.unrealised, null, 'a partial mark is NOT a number')
  assert.equal(pnl.total, null)
  assert.equal(pnl.complete, false)
  assert.deepEqual([...pnl.unpriced], ['BHEL26AUG430CE', 'BHEL26AUG440CE'])
  assert.equal(pnl.openLegs, 3, 'the unmarked legs are still open legs, not dropped')
})

test('a genuinely flat, fully marked book is 0 and complete — the distinction §8 exists for', () => {
  const flat = computeWindowPnl(
    windowOf([
      fill('BHEL26AUG420CE', 'Sell', 100, 20, T(1)),
      fill('BHEL26AUG420CE', 'Buy', 100, 20, T(2)),
    ]),
    {},
  )
  assert.equal(flat.total, 0)
  assert.equal(flat.complete, true)
  assert.deepEqual(flat.unpriced, [])
})

test('a mark of exactly zero is usable; a missing one is not', () => {
  const fills = [fill('BHEL26AUG470CE', 'Sell', 100, 3, T(1))]
  const worthless = computeWindowPnl(windowOf(fills), { BHEL26AUG470CE: 0 })
  assert.equal(worthless.unrealised, 300, 'a far-OTM option really can mark at zero')
  assert.equal(worthless.complete, true)
})

test('symbolsIn covers both halves of the window', () => {
  const w = windowOf([
    fill('A', 'Sell', 1, 1, YESTERDAY),
    fill('B', 'Buy', 1, 1, T(1)),
    fill('A', 'Buy', 1, 1, T(2)),
  ])
  assert.deepEqual(symbolsIn(w).sort(), ['A', 'B'])
})

// ------------------------------------------------------------ the extremes

test('extremes skip null points instead of reading them as zero', () => {
  const series: SeriesPoint[] = [
    { ts: T(1), realised: 0, unrealised: 500, total: 500 },
    { ts: T(2), realised: 0, unrealised: null, total: null },
    { ts: T(3), realised: 0, unrealised: 900, total: 900 },
  ]
  const e = extremes(series)
  assert.equal(e.maxProfit, 900)
  assert.equal(e.maxLoss, 500, 'the worst POINT of the day, not a fabricated 0 low')
  assert.equal(e.used, 2)
})

test('no usable points means both extremes are null, not zero', () => {
  const e = extremes([{ ts: T(1), realised: 10, unrealised: null, total: null }])
  assert.equal(e.maxProfit, null)
  assert.equal(e.maxLoss, null)
  assert.equal(e.used, 0)
})

// -------------------------------------------------------------- the rollup

const ROLLUP_FILLS: StampedFill[] = [
  fill('BHEL26AUG420CE', 'Sell', 13125, 15, T(5)),
  fill('BHEL26AUG400PE', 'Sell', 13125, 11, T(6)),
  fill('BHEL26AUG400PE', 'Buy', 13125, 8, T(200)),
]
const ROLLUP_MARKS = { BHEL26AUG420CE: 12, BHEL26AUG400PE: 8 }

test('a rollup recomputed from fills equals the live-computed number', () => {
  const w = windowOf(ROLLUP_FILLS)
  const live = computeWindowPnl(w, ROLLUP_MARKS)
  const report = buildDailyReport({
    date: DAY,
    tag: 'DESK_BHEL',
    mode: 'paper',
    window: w,
    marks: ROLLUP_MARKS,
    series: [],
    writtenAt: T(400),
  })
  assert.equal(report.realised, live.realised)
  assert.equal(report.total, live.total)
  assert.equal(report.closingSource, 'marks')
  assert.equal(report.closingPositions, 1)
  assert.equal(report.orderCount, 3)
})

test('a gap in the snapshot series does not corrupt the rollup', () => {
  const w = windowOf(ROLLUP_FILLS)
  const truth = computeWindowPnl(w, ROLLUP_MARKS)
  const gappy: SeriesPoint[] = [
    { ts: T(10), realised: 0, unrealised: 1_000, total: 1_000 },
    // The feed died for an hour. Nulls, not zeroes.
    { ts: T(70), realised: 0, unrealised: null, total: null },
    { ts: T(130), realised: 0, unrealised: null, total: null },
    { ts: T(250), realised: 39_375, unrealised: 39_375, total: 78_750 },
  ]
  const report = buildDailyReport({
    date: DAY,
    tag: 'DESK_BHEL',
    mode: 'paper',
    window: w,
    marks: ROLLUP_MARKS,
    series: gappy,
    writtenAt: T(400),
  })
  assert.equal(report.realised, truth.realised, 'realised comes from FILLS, never the series')
  assert.equal(report.total, truth.total)
  assert.equal(report.snapshots, 2, 'only the points that carried a number were used')
  assert.equal(report.maxProfit, 78_750)
  assert.equal(report.maxLoss, 1_000)
})

/**
 * THE DOUBLE-COUNT. This test previously asserted the defect as intended
 * behaviour, which is why it survived review.
 *
 * `realised` is the END-OF-DAY figure; a borrowed `unrealised` is a
 * POINT-IN-TIME one. A leg that went open -> closed between the snapshot and
 * the close appears in both, and the rollup — kept forever — overstates the day
 * by exactly that leg while the snapshots that would expose it are pruned at 30
 * days.
 */
test('a fill AFTER the last marked snapshot makes the close unknowable, not double-counted', () => {
  const w = windowOf(ROLLUP_FILLS)
  const series: SeriesPoint[] = [
    { ts: T(100), realised: 0, unrealised: 20_000, total: 20_000 },
    // Taken BEFORE the 13125 buy-back at T(200): borrowing its unrealised would
    // count that leg once here and again in the day's realised.
    { ts: T(150), realised: 0, unrealised: 30_000, total: 30_000 },
    { ts: T(240), realised: 39_375, unrealised: null, total: null },
  ]
  const report = buildDailyReport({
    date: DAY,
    tag: 'DESK_BHEL',
    mode: 'paper',
    window: w,
    // The 15:40 rollup runs after the feed has gone quiet: no marks at all.
    marks: {},
    series,
    writtenAt: T(400),
  })
  assert.equal(report.realised, 39_375, 'realised is still recomputed from the fills')
  assert.equal(report.total, null, 'the old code reported 69,375 — 30,000 of it counted twice')
  assert.equal(report.closingSource, 'none')
})

test('with NO fill after the last marked snapshot the mark component is safely borrowed', () => {
  // Same series, but the last marked point is AFTER the final fill, so the
  // position set has not moved and realised + unrealised is coherent.
  const w = windowOf(ROLLUP_FILLS)
  const lastFillTs = Math.max(...w.during.map((f) => f.ts))
  const series: SeriesPoint[] = [
    { ts: lastFillTs + 1, realised: 39_375, unrealised: 30_000, total: 69_375 },
    { ts: lastFillTs + 2, realised: 39_375, unrealised: null, total: null },
  ]
  const report = buildDailyReport({
    date: DAY, tag: 'DESK_BHEL', mode: 'paper', window: w, marks: {}, series, writtenAt: T(400),
  })
  assert.equal(report.closingSource, 'snapshot')
  assert.equal(report.total, 39_375 + 30_000)
})

test('no marks and no marked snapshot leaves total null rather than inventing one', () => {
  const report = buildDailyReport({
    date: DAY,
    tag: 'DESK_BHEL',
    mode: 'paper',
    window: windowOf(ROLLUP_FILLS),
    marks: {},
    series: [],
    writtenAt: T(400),
  })
  assert.equal(report.total, null)
  assert.equal(report.closingSource, 'none')
  assert.equal(report.realised, 39_375, 'the booked figure is still known and still reported')
})

test('costs are subtracted from realised only, and default to gross', () => {
  const w = windowOf(ROLLUP_FILLS)
  const gross = buildDailyReport({
    date: DAY, tag: 'T', mode: 'paper', window: w, marks: ROLLUP_MARKS, series: [], writtenAt: 0,
  })
  const net = buildDailyReport({
    date: DAY, tag: 'T', mode: 'paper', window: w, marks: ROLLUP_MARKS, series: [], writtenAt: 0,
    costs: { book: 500, bySymbol: { BHEL26AUG400PE: 120 } },
  })
  assert.equal(net.realised, gross.realised - 620)
  assert.equal((net.total ?? 0) - (gross.total ?? 0), -620)
})

// --------------------------------------------------------------- the prune

test('a day missing one strategy rollup is skipped, and says which one', () => {
  const [decision] = planPrune([
    {
      date: '2026-06-01',
      snapshots: 1500,
      active: ['DESK_BHEL|paper', 'DESK_NIFTY|live'],
      rolledUp: ['DESK_BHEL|paper'],
    },
  ])
  assert.equal(decision?.action, 'skip')
  assert.match(decision?.reason ?? '', /DESK_NIFTY\|live/)
  assert.match(decision?.reason ?? '', /never summarised/)
})

test('a fully rolled-up day is deleted', () => {
  const [decision] = planPrune([
    {
      date: '2026-06-01',
      snapshots: 1500,
      active: ['DESK_BHEL|paper'],
      rolledUp: ['DESK_BHEL|paper', 'DESK_OLD|paper'],
    },
  ])
  assert.equal(decision?.action, 'delete')
  assert.equal(decision?.snapshots, 1500)
})

test('a day that was snapshotted but never traded still needs a rollup first', () => {
  // A carried book marked all day with no fills. Its intraday detail is exactly
  // as unrecoverable as a trading day's, so the guard must not exempt it.
  const [decision] = planPrune([
    { date: '2026-06-01', snapshots: 900, active: ['DESK_BHEL|paper'], rolledUp: [] },
  ])
  assert.equal(decision?.action, 'skip')
})

// ------------------------------------------------------------ session gate

test('the session gate opens at 09:15 IST and closes at the 15:40 F&O close, weekdays only', () => {
  const at = (date: string, hh: number, mm: number): number =>
    Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`) -
    5.5 * 60 * 60 * 1000
  // 2026-07-27 is a Monday.
  assert.equal(istMinutesOfDay(at('2026-07-27', 9, 15)), 555)
  assert.equal(inTradingSession(at('2026-07-27', 9, 14)), false)
  assert.equal(inTradingSession(at('2026-07-27', 9, 15)), true, 'a restart at 09:15 must be live')
  assert.equal(inTradingSession(at('2026-07-27', 15, 30)), true)
  assert.equal(inTradingSession(at('2026-07-27', 15, 39)), true, 'F&O trades to 15:40 since 3 Aug 2026')
  assert.equal(inTradingSession(at('2026-07-27', 15, 40)), false, 'the 15:40 rollup marks the close itself')
  // 2026-07-25 is a Saturday, 2026-07-26 a Sunday.
  assert.equal(inTradingSession(at('2026-07-25', 11, 0)), false)
  assert.equal(inTradingSession(at('2026-07-26', 11, 0)), false)
})
