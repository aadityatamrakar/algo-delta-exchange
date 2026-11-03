import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAILY_AT_MINUTES, dailyDue, dailyRowOf, dailyTotalsOf, dailyViewOf, type DailyBook, type DailyRow } from '../src/analytics/daily.ts'
import type { MarginView, MtmBlock } from '../src/analytics/wire.ts'
import type { BookView, SeriesTotal } from '../src/types.ts'

const ist = (iso: string): number => Date.parse(`${iso}+05:30`)

test('the record is due on a trading day from 15:45 IST, until midnight, and never otherwise', () => {
  assert.equal(DAILY_AT_MINUTES, 15 * 60 + 45)
  // Monday 19 Oct 2026
  assert.equal(dailyDue(ist('2026-10-19T15:44:59')), null)
  assert.equal(dailyDue(ist('2026-10-19T15:45:00')), '2026-10-19')
  assert.equal(dailyDue(ist('2026-10-19T23:59:00')), '2026-10-19')
  assert.equal(dailyDue(ist('2026-10-20T00:01:00')), null, 'past midnight the day is over: nothing is backfilled')
  assert.equal(dailyDue(ist('2026-10-20T09:00:00')), null)
  // Saturday and Sunday 17–18 Oct, and Dussehra 2026-10-20 is a trading day on the desk calendar only if it says so
  assert.equal(dailyDue(ist('2026-10-17T16:00:00')), null)
  assert.equal(dailyDue(ist('2026-10-18T16:00:00')), null)
  // a 2026 NSE holiday: Diwali Laxmi Pujan 8 Nov is a Sunday; Christmas Fri 25 Dec 2026
  assert.equal(dailyDue(ist('2026-12-25T16:00:00')), null)
  assert.equal(dailyDue(ist('2026-12-24T16:00:00')), '2026-12-24')
})

const view = (over: Partial<BookView> = {}, mtms: (number | null)[] = [100, -40]): BookView => ({
  stock: 'TCS', asOf: 0, closed: true, spot: 3400, futures: {}, forwards: {},
  legs: mtms.map((mtm, i) => ({ key: `k${i}`, mtm })) as unknown as BookView['legs'],
  totals: { delta: 350, gamma: -0.0123, vega: -310, theta: 140, mtm: 60 },
  payoff: null, unmatched: [], mismatch: null, historyFrom: null, warnings: ['w1', 'w2'], ...over,
})

const block = (total: number | null, partial: string[] = []): MtmBlock => ({
  gross: { previous: null, today: 0, total: null }, expense: { previous: null, today: 0, total: 0 },
  current: { previous: null, today: 0, total }, squareOff: 0, projected: null, payInOut: 0, cfBalance: 0,
  openCycleCharges: 0, partial, ratesConfirmed: true, notes: [],
})

const series = (net: number | null, booked = 500): SeriesTotal => ({
  open: net === null ? null : net - booked, booked, gross: net, charges: 0, net, closedContracts: 1, from: '2026-10-01', ratesConfirmed: true, notes: [],
})

const marginView = (total: number | null, available = true): MarginView => ({
  available, initial: null, exposure: null, total, peak: null, parts: null,
  span: { file: 'f', label: 'NSE SPAN end of day 19 Oct', businessDate: '2026-10-19', savedAt: null },
  exposureFile: null, stale: false, missing: [], notes: [],
})

const book = (o: Partial<DailyBook> = {}): DailyBook => ({
  view: view(), mtm: block(1234), margin: marginView(250000), series: series(900), spot: 3400, ...o,
})

test('a row takes each value from the page: the MTM block total, the legs\' sum, the series, the totals, the margin and its file', () => {
  const r = dailyRowOf('asha', 'TCS', '2026-10-19', 5, book())
  assert.deepEqual(r, {
    trader: 'asha', stock: 'TCS', day: '2026-10-19', at: 5,
    dayMtm: 1234, openPnl: 60, seriesNet: 900, seriesBooked: 500, spot: 3400,
    delta: 350, gamma: -0.0123, theta: 140, vega: -310,
    margin: 250000, marginSource: 'NSE SPAN end of day 19 Oct', legs: 2, warnings: 2,
  })
})

test('a figure the page cannot give is null, never 0: no MTM total, an unpriced leg, no series, no margin', () => {
  const r = dailyRowOf('asha', 'TCS', '2026-10-19', 5, book({
    mtm: block(null, ['a']), view: view({}, [100, null]), series: null, margin: marginView(null, false),
  }))
  assert.deepEqual([r.dayMtm, r.openPnl, r.seriesNet, r.seriesBooked, r.margin, r.marginSource], [null, null, null, null, null, null])
  assert.equal(r.warnings, 3, "the view's two warnings and the one contract the block left out")
  const none = dailyRowOf('asha', 'TCS', '2026-10-19', 5, book({ mtm: null, margin: null }))
  assert.deepEqual([none.dayMtm, none.margin], [null, null])
  // net unknown while the booked part is known: the legs have no LTP
  const open = dailyRowOf('asha', 'TCS', '2026-10-19', 5, book({ series: series(null, 700) }))
  assert.deepEqual([open.seriesNet, open.seriesBooked], [null, 700])
})

test('a book flat at the close has no legs, no open P&L, no greeks and no margin to know — but its Day MTM and series stand', () => {
  const r = dailyRowOf('asha', 'INFY', '2026-10-19', 5, { view: null, mtm: block(-820), margin: null, series: series(-820, -820), spot: 1500 })
  assert.deepEqual(
    [r.dayMtm, r.openPnl, r.seriesNet, r.legs, r.delta, r.gamma, r.theta, r.vega, r.margin, r.marginSource, r.spot],
    [-820, 0, -820, 0, 0, 0, 0, 0, 0, null, 1500],
  )
})

const rows = (): DailyRow[] => [
  dailyRowOf('asha', 'TCS', '2026-10-19', 10, book()),
  dailyRowOf('asha', 'NIFTY', '2026-10-19', 12, book({
    view: view({ stock: 'NIFTY', spot: 25000, totals: { delta: -200, gamma: 0, vega: -50, theta: 10, mtm: -5 } }, [-5]),
    mtm: block(300), series: series(100, 40), margin: marginView(100000), spot: 25000,
  })),
  dailyRowOf('asha', 'TCS', '2026-10-16', 9, book({ mtm: block(-100) })),
]

test('totals add the money, the delta as money, and name the books a figure is missing for', () => {
  const t = dailyTotalsOf(rows().slice(0, 2))
  assert.deepEqual([t.books, t.legs, t.dayMtm, t.openPnl, t.seriesNet, t.seriesBooked], [2, 3, 1534, 55, 1000, 540])
  assert.equal(t.deltaValue, 350 * 3400 + -200 * 25000)
  assert.deepEqual([t.vega, t.theta, t.margin, t.warnings], [-360, 150, 350000, 4])
  assert.deepEqual(t.missing, { dayMtm: [], openPnl: [], series: [], spot: [], margin: [] })

  const unknown = dailyTotalsOf([
    ...rows().slice(0, 1), dailyRowOf('asha', 'SBIN', '2026-10-19', 1, book({ mtm: block(null), margin: null, series: null, spot: null })),
  ])
  assert.deepEqual([unknown.dayMtm, unknown.seriesNet, unknown.seriesBooked, unknown.openPnl], [null, null, null, 60 + 60], 'a total of the known ones would read as the whole')
  assert.deepEqual(unknown.missing, { dayMtm: ['SBIN'], openPnl: [], series: ['SBIN'], spot: ['SBIN'], margin: ['SBIN'] })
  assert.equal(unknown.deltaValue, null, 'a book with no spot: the delta value is unknown, not the known books\'')
  assert.equal(unknown.margin, null, 'a book with no margin: the total is unknown, not ₹250,000')
  // every book without a margin is null too, never ₹0
  const none = dailyTotalsOf([dailyRowOf('asha', 'SBIN', '2026-10-19', 1, book({ margin: null, spot: null }))])
  assert.deepEqual([none.margin, none.deltaValue], [null, null])
  // a flat book's margin is a known 0
  assert.equal(dailyTotalsOf([dailyRowOf('asha', 'INFY', '2026-10-19', 1, { view: null, mtm: block(1), margin: null, series: null, spot: 1500 })]).margin, 0)
})

test('the view is newest day first, a day\'s books by stock, each day with its totals and its latest write', () => {
  const v = dailyViewOf('asha', rows(), 99, '2026-10-12')
  assert.deepEqual([v.trader, v.asOf, v.recordedFrom], ['asha', 99, '2026-10-12'])
  assert.deepEqual(v.days.map((d) => [d.day, d.at, d.books.map((b) => b.stock), d.totals.books]), [
    ['2026-10-19', 12, ['NIFTY', 'TCS'], 2],
    ['2026-10-16', 9, ['TCS'], 1],
  ])
  assert.equal(v.days[1]?.totals.dayMtm, -100)
  assert.ok(v.notes.some((n) => /never rewritten/.test(n)) && v.notes.some((n) => /no live prices/.test(n)))
  assert.deepEqual(dailyViewOf('asha', [], 1, null).days, [])
})
