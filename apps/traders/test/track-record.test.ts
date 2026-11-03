/**
 * The track record, pure (analytics/track-record.ts): a hand-built desk — four stock series, an index weekly, a live
 * series and an expired one left open — through the real Booked ledger walk, so every P&L here is the Booked page's
 * row. No Mongo.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookedKey, bookedLedger, bookedView, historyNote, SETTLEMENT_NOTE, type BookedInputs } from '../src/analytics/booked.ts'
import { SEED_RATES } from '../src/analytics/charges.ts'
import type { WalkTrade } from '../src/analytics/cycles.ts'
import {
  LIVE_PNL_NOTE, median, summarise, TRACK_MAX_ROWS, trackRecord, trackSeries, windowStart, type TrackInputs, type TrackSeries,
} from '../src/analytics/track-record.ts'
import type { ChargeRates } from '../src/analytics/wire.ts'
import type { SettlementFill } from '../src/ingest/settlement.ts'

const TODAY = '2026-10-22'
const AUG = '2026-08-25'
const SEP = '2026-09-29'
const OCT = '2026-10-27'
const NIFTY_WEEK = '2026-10-20'

/** No charges at all, so every P&L is the gross and exact. */
const FREE: ChargeRates = {
  option: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  future: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  share: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  sebiPerCrore: 0, gstPct: 0, brokerage: { default: { mode: 'order', amount: 0 }, byTrader: {} }, confirmedBy: 'admin', confirmedAt: 1,
}

let seq = 0
function tr(side: 'Buy' | 'Sell', qty: number, price: number, day: string, over: Partial<WalkTrade> = {}): WalkTrade {
  seq++
  return {
    clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: SEP, strike: 3500, optType: 'CE',
    side, qty, price, day, time: Date.parse(`${day}T10:00:00+05:30`) + seq, seq, orderNo: `o${seq}`, ...over,
  }
}
const FUT = { instrument: 'future' as const, strike: null, optType: null }
const ce = (strike: number, o: Partial<WalkTrade> = {}): Partial<WalkTrade> => ({ strike, optType: 'CE', ...o })
const pe = (strike: number, o: Partial<WalkTrade> = {}): Partial<WalkTrade> => ({ strike, optType: 'PE', ...o })

const TRADES: readonly WalkTrade[] = [
  // TCS Aug, a trend month: a strangle 3.45% out each side, the future traded on 8 days, closed 14 Aug (−17,500 + 6,125)
  tr('Sell', 175, 50, '2026-08-03', ce(3000, { expiry: AUG })), tr('Sell', 175, 40, '2026-08-03', pe(2800, { expiry: AUG })),
  ...['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']
    .map((day, n) => tr(n % 2 === 0 ? 'Sell' : 'Buy', 175, 3000, day, { expiry: AUG, ...FUT })),
  tr('Buy', 175, 150, '2026-08-14', ce(3000, { expiry: AUG })), tr('Buy', 175, 5, '2026-08-14', pe(2800, { expiry: AUG })),
  // INFY Aug: a put sold and never closed, no settlement close — unsettled, no P&L
  tr('Sell', 100, 12, '2026-08-10', pe(1500, { stock: 'INFY', expiry: AUG })),
  // TCS Sep: calls 175 @3180 + 525 @3120 (qty-weighted 3135, 4.5% out), puts 2850 (5% out), a 3300 CE wing; adjusted 3 days, flat 15 Sep
  tr('Sell', 175, 30, '2026-09-01', ce(3180)), tr('Sell', 525, 40, '2026-09-01', ce(3120)), tr('Sell', 700, 25, '2026-09-01', pe(2850)),
  tr('Buy', 700, 5, '2026-09-01', ce(3300)),
  tr('Buy', 175, 10, '2026-09-05', ce(3180)),
  tr('Sell', 175, 3050, '2026-09-08', FUT),
  tr('Buy', 525, 20, '2026-09-15', ce(3120)), tr('Buy', 700, 5, '2026-09-15', pe(2850)), tr('Sell', 700, 1, '2026-09-15', ce(3300)),
  tr('Buy', 175, 3000, '2026-09-15', FUT),
  // INFY Sep: one call held to expiry, settled 60 in the money (−16,000)
  tr('Sell', 400, 20, '2026-09-02', ce(1500, { stock: 'INFY' })),
  // NIFTY weekly, opened and closed on its expiry day (+1,125)
  tr('Sell', 75, 20, NIFTY_WEEK, ce(25000, { stock: 'NIFTY', expiry: NIFTY_WEEK })), tr('Buy', 75, 5, NIFTY_WEEK, ce(25000, { stock: 'NIFTY', expiry: NIFTY_WEEK })),
  // TCS Oct, live
  tr('Sell', 175, 30, '2026-10-15', ce(3600, { expiry: OCT })),
]

const SETTLEMENT: readonly SettlementFill[] = [{
  clientCode: 'C1', stock: 'INFY', instrument: 'option', expiry: SEP, strike: 1500, optType: 'CE',
  side: 'Buy', qty: 400, price: 60, day: SEP, time: Date.parse(`${SEP}T15:40:00+05:30`), seq: 9999, settlement: true,
}]

/** Unadjusted settlement closes: what the strikes are measured from. TCS split 1:2 after Sep, so these are twice the bars. */
const CLOSES: Readonly<Record<string, number>> = {
  'TCS|2026-07-31': 2900, 'TCS|2026-08-31': 3000, 'TCS|2026-10-14': 3550,
  'INFY|2026-08-07': 1550, 'INFY|2026-09-01': 1450, 'NIFTY|2026-10-19': 24900,
}
/** Back-adjusted bars, oldest → newest (TCS's halved by the split). */
const BARS: Readonly<Record<string, readonly { date: string; close: number }[]>> = {
  TCS: [
    { date: '2026-07-31', close: 1450 }, { date: '2026-08-03', close: 1460 }, { date: '2026-08-10', close: 1600 }, { date: '2026-08-14', close: 1620 },
    { date: '2026-08-25', close: 1610 }, { date: '2026-08-31', close: 1500 }, { date: '2026-09-01', close: 1530 }, { date: '2026-09-10', close: 1590 },
    { date: '2026-09-20', close: 1470 }, { date: '2026-09-29', close: 1560 }, { date: '2026-09-30', close: 1800 },
  ],
  INFY: [{ date: '2026-09-01', close: 1450 }, { date: '2026-09-10', close: 1600 }, { date: '2026-09-29', close: 1560 }],
}

const ledgerInputs = (rates: ChargeRates): BookedInputs => ({
  trader: 'asha', trades: TRADES, balance: null, historyFrom: '2026-07-01', rates, settlement: SETTLEMENT, today: TODAY, lotSizeOf: () => 175,
})

const inputs = (rates: ChargeRates = FREE): TrackInputs => ({
  fills: TRADES.map(({ stock, instrument, expiry, strike, optType, side, qty, day }) => ({ stock, instrument, expiry, strike, optType, side, qty, day })),
  today: TODAY,
  isIndex: (s) => s === 'NIFTY',
  close: (stock, day) => CLOSES[`${stock}|${day}`],
  bars: (stock) => BARS[stock] ?? [],
  ledger: bookedLedger(ledgerInputs(rates)),
})

const byKey = (xs: readonly TrackSeries[]): Map<string, TrackSeries> => new Map(xs.map((s) => [bookedKey(s.stock, s.expiry), s]))
const one = (xs: readonly TrackSeries[], stock: string, expiry: string): TrackSeries => {
  const s = byKey(xs).get(bookedKey(stock, expiry))
  assert.ok(s, `${stock} ${expiry}`)
  return s
}

test('each series: entry and days to expiry, adjustment days, contracts, the shorts from the previous close, wings', () => {
  const all = trackSeries(inputs())
  assert.equal(all.length, 6, 'a series is a stock and expiry with an option fill')
  const sep = one(all, 'TCS', SEP)
  assert.deepEqual(
    [sep.kind, sep.entryDay, sep.dteAtEntry, sep.lastDay, sep.dteAtLast, sep.adjustDays, sep.contracts, sep.wings],
    ['stock', '2026-09-01', 28, '2026-09-15', 14, 3, 4, true],
    'a futures day (8 Sep) is an adjustment day; the future is not a contract',
  )
  assert.equal(sep.shortCallPct, 4.5, 'qty-weighted: 175 × 3180 and 525 × 3120 = 3135, from the raw close 3000')
  assert.equal(sep.shortPutPct, 5)
  const aug = one(all, 'TCS', AUG)
  assert.deepEqual([aug.entryDay, aug.dteAtEntry, aug.adjustDays, aug.dteAtLast, aug.contracts, aug.wings], ['2026-08-03', 22, 9, 11, 2, false])
  assert.deepEqual([aug.shortCallPct, aug.shortPutPct], [3.45, 3.45], 'a Monday entry measures from Friday\'s close')
  const infy = one(all, 'INFY', SEP)
  assert.deepEqual([infy.shortCallPct, infy.shortPutPct, infy.adjustDays, infy.dteAtLast], [3.45, null, 0, 27], 'no put sold: null')
  const nifty = one(all, 'NIFTY', NIFTY_WEEK)
  assert.deepEqual([nifty.kind, nifty.dteAtEntry, nifty.shortCallPct], ['index', 0, 0.4])
})

test('the move from entry is on the back-adjusted bars, to the expiry when held there, else to the last fill; null where the bars do not reach', () => {
  const all = trackSeries(inputs())
  const sep = one(all, 'TCS', SEP)
  assert.deepEqual([sep.maxUpPct, sep.maxDownPct], [6, 0], 'from the 31 Aug bar (1500) to the last fill (15 Sep): the 20 Sep dip came after it was closed')
  assert.equal(one(all, 'INFY', SEP).heldToExpiry, true, 'INFY Sep runs to its expiry')
  assert.deepEqual([one(all, 'TCS', AUG).maxUpPct, one(all, 'TCS', AUG).maxDownPct], [11.72, 0])
  assert.deepEqual([one(all, 'INFY', SEP).maxUpPct, one(all, 'INFY', SEP).maxDownPct], [10.34, 0])
  assert.equal(one(all, 'INFY', AUG).maxUpPct, null, 'no INFY bar before 10 Aug')
  assert.equal(one(all, 'NIFTY', NIFTY_WEEK).maxUpPct, null, 'no bars at all')
  assert.equal(one(all, 'TCS', OCT).maxUpPct, null, 'live, and no close since entry yet')
})

test('P&L is the Booked page\'s net for the stock and expiry; held to expiry is a settled cycle; live and unsettled have none', () => {
  for (const rates of [FREE, SEED_RATES]) {
    const i = inputs(rates)
    const all = trackSeries(i)
    const page = bookedView(i.ledger, { asOf: 0, from: '2026-01', to: '2026-12' })
    for (const s of all.filter((x) => !x.open)) {
      const row = page.rows.find((r) => r.kind === 'series' && r.stock === s.stock && r.expiry === s.expiry)
      assert.ok(row, `${s.stock} ${s.expiry}`)
      assert.equal(s.pnl, row.net === null ? null : Math.round(row.net * 100) / 100, `${s.stock} ${s.expiry}`)
    }
  }
  const all = trackSeries(inputs())
  assert.equal(one(all, 'TCS', SEP).pnl, 33950)
  assert.equal(one(all, 'TCS', AUG).pnl, -11375)
  assert.equal(one(all, 'NIFTY', NIFTY_WEEK).pnl, 1125)
  const infy = one(all, 'INFY', SEP)
  assert.deepEqual([infy.pnl, infy.heldToExpiry], [-16000, true])
  assert.equal(one(all, 'TCS', SEP).heldToExpiry, false)
  const unsettled = one(all, 'INFY', AUG)
  assert.deepEqual([unsettled.pnl, unsettled.open, unsettled.heldToExpiry], [null, false, false])
  assert.match(unsettled.pnlNote ?? '', /still open and no NSE close to settle them at — net unknown/)
  const live = one(all, 'TCS', OCT)
  assert.deepEqual([live.open, live.pnl, live.pnlNote], [true, null, LIVE_PNL_NOTE])
  assert.equal(live.shortCallPct, 1.41)
  const withCharges = one(trackSeries(inputs(SEED_RATES)), 'TCS', SEP).pnl
  assert.ok(withCharges !== null && withCharges < 33950, 'after charges')
})

test('the summary: wins, medians, the worst tenth, buckets by move, by adjustment days and held vs closed; stock and index apart', () => {
  const rec = trackRecord(trackSeries(inputs()), { from: windowStart(TODAY, 12), stock: null, ledger: inputs().ledger })
  const s = rec.summary.stock
  assert.ok(s)
  assert.deepEqual(
    [s.n, s.noPnl, s.wins, s.winRate, s.medianWin, s.medianLoss, s.worstTenthLoss, s.allWins],
    [4, 1, 1, 33.33, 33950, -13687.5, -16000, 33950],
    'TCS Sep won, TCS Aug and INFY Sep lost, INFY Aug has no P&L; the worst ⌈3/10⌉ = 1',
  )
  assert.deepEqual(s.byMove.map((b) => [b.bucket, b.n, b.winRate, b.medianPnl]), [
    ['under 4%', 0, null, null], ['4–7%', 1, 100, 33950], ['7–10%', 0, null, null], ['10% or more', 2, 0, -13687.5],
  ])
  assert.deepEqual(s.byAdjustDays.map((b) => [b.bucket, b.n, b.winRate, b.medianPnl]), [
    ['0–1', 1, 0, -16000], ['2–3', 1, 100, 33950], ['4–7', 0, null, null], ['8 or more', 1, 0, -11375],
  ])
  assert.deepEqual([s.heldToExpiry.n, s.heldToExpiry.winRate, s.heldToExpiry.medianPnl], [1, 0, -16000])
  assert.deepEqual([s.closedBefore.n, s.closedBefore.winRate, s.closedBefore.medianPnl], [2, 50, 11287.5])
  assert.deepEqual(s.typical, { dteAtEntry: 24.5, shortCallPct: 3.45, shortPutPct: 3.45, adjustDays: 1.5, dteAtLast: 14.5 }, 'over every expired series, P&L or not')

  const ix = rec.summary.index
  assert.ok(ix)
  assert.deepEqual([ix.n, ix.wins, ix.winRate, ix.medianLoss, ix.worstTenthLoss, ix.allWins], [1, 1, 100, null, null, 1125], 'no loss in the worst tenth: none')
  assert.deepEqual(ix.byMove.at(-1), { bucket: 'no history', n: 1, winRate: 100, medianPnl: 1125 }, 'a series with no bars has its own bucket')
  assert.equal(rec.open, 1)
})

test('newest first, the window and the stock cut the rows and the summary; the rows are capped, the summary is not', () => {
  const all = trackSeries(inputs())
  const ledger = inputs().ledger
  const rec = trackRecord(all, { from: windowStart(TODAY, 12), stock: null, ledger })
  assert.deepEqual(rec.series.map((x) => `${x.stock} ${x.expiry}`), [
    `TCS ${OCT}`, `NIFTY ${NIFTY_WEEK}`, `INFY ${SEP}`, `TCS ${SEP}`, `INFY ${AUG}`, `TCS ${AUG}`,
  ])
  assert.deepEqual([rec.total, rec.truncated], [6, false])
  assert.equal(TRACK_MAX_ROWS, 40)

  const cut = trackRecord(all, { from: windowStart(TODAY, 12), stock: null, ledger, maxRows: 2 })
  assert.deepEqual([cut.series.length, cut.total, cut.truncated, cut.summary.stock?.n], [2, 6, true, 4])

  const sepOn = trackRecord(all, { from: '2026-09-01', stock: null, ledger })
  assert.deepEqual(sepOn.series.map((x) => x.expiry), [OCT, NIFTY_WEEK, SEP, SEP], 'August expired before the window')
  assert.equal(sepOn.summary.stock?.n, 2)

  const infy = trackRecord(all, { from: windowStart(TODAY, 12), stock: 'INFY', ledger })
  assert.deepEqual([infy.series.map((x) => x.expiry), infy.summary.stock?.n, infy.summary.index], [[SEP, AUG], 2, null])
})

test('the notes: where the history starts, settlement and its delivered shares, series with no P&L or no bars', () => {
  const ledger = inputs().ledger
  const rec = trackRecord(trackSeries(inputs()), { from: windowStart(TODAY, 12), stock: null, ledger })
  assert.equal(rec.notes[0], historyNote('2026-07-01'))
  assert.ok(rec.notes.includes(SETTLEMENT_NOTE))
  assert.ok(rec.notes.some((n) => /delivers shares/.test(n)))
  assert.ok(rec.notes.includes('1 expired series has no P&L (pnlNote says why): left out of the summary\'s P&L figures'), JSON.stringify(rec.notes))
  assert.ok(rec.notes.includes('3 series have no daily closes around the entry in the history: the move from entry is null'), JSON.stringify(rec.notes))
  assert.equal(rec.notes.some((n) => /charges rates not confirmed/.test(n)), false, 'FREE is confirmed')
  const unconfirmed = bookedLedger({ ...ledgerInputs({ ...FREE, confirmedBy: null }) })
  const r2 = trackRecord(trackSeries({ ...inputs(), ledger: unconfirmed }), { from: windowStart(TODAY, 12), stock: 'TCS', ledger: unconfirmed })
  assert.ok(r2.notes.some((n) => /charges rates not confirmed/.test(n)))
  assert.equal(r2.notes.some((n) => /no P&L/.test(n)), false, 'TCS alone has none without a P&L')
})

test('helpers: the window start clamps the day, the median of an even count is the middle mean, an empty summary has nulls', () => {
  assert.equal(windowStart('2026-10-22', 12), '2025-10-22')
  assert.equal(windowStart('2026-03-31', 1), '2026-02-28')
  assert.equal(windowStart('2026-01-15', 18), '2024-07-15')
  assert.equal(median([]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  const empty = summarise([])
  assert.deepEqual([empty.n, empty.winRate, empty.medianWin, empty.worstTenthLoss, empty.allWins, empty.typical.dteAtEntry], [0, null, null, null, 0, null])
})

test('the worst tenth sums only its losses: a winner in it is not netted, and all winners give none', () => {
  const base = one(trackSeries(inputs()), 'TCS', SEP)
  const of = (pnls: readonly number[]): readonly TrackSeries[] => pnls.map((pnl) => ({ ...base, pnl }))
  assert.equal(summarise(of([100, 200, 300])).worstTenthLoss, null)
  const twenty = [-500, ...Array.from({ length: 19 }, (_, k) => 100 + k)]
  assert.equal(summarise(of(twenty)).worstTenthLoss, -500, '⌈20/10⌉ = 2: the loser and the smallest winner; only the loser counts')
})
