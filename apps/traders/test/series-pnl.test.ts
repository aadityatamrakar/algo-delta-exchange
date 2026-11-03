import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chargesFor, SEED_RATES } from '../src/analytics/charges.ts'
import { seriesClosed, seriesPnl, withOpenLegs, type SeriesInputs, type SeriesLeg, type SeriesTrade } from '../src/analytics/series-pnl.ts'
import type { ChargeRates } from '../src/analytics/wire.ts'
import { legsFromTrades } from '../src/ingest/ledger.ts'
import { legKey } from '../src/types.ts'

const OCT = '2026-10-27'
const NOV = '2026-11-24'
const SEP = '2026-09-29'

/** No charges at all, so the P&L figures are exact. */
const FREE: ChargeRates = {
  option: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  future: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  share: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  sebiPerCrore: 0, gstPct: 0, brokerage: { default: { mode: 'order', amount: 0 }, byTrader: {} }, confirmedBy: 'admin', confirmedAt: 1,
}

let seq = 0
function tr(side: 'Buy' | 'Sell', qty: number, price: number, day: string, over: Partial<SeriesTrade> & { hhmm?: string } = {}): SeriesTrade {
  const { hhmm = '10:00', ...rest } = over
  seq++
  return {
    clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE',
    side, qty, price, day, time: Date.parse(`${day}T${hhmm}:00+05:30`), seq, orderNo: `o${seq}`, ...rest,
  }
}

/** An open leg; its key carries its client code, as R1's do. */
const leg = (mtm: number | null, over: Partial<SeriesLeg> & { readonly clientCode?: string } = {}): SeriesLeg => {
  const { clientCode = 'C1', ...rest } = over
  const l = { instrument: 'option' as const, expiry: OCT, strike: 3500, optType: 'CE' as const, mtm, ...rest }
  return { key: legKey({ ...l, clientCode, stock: 'TCS' }), ...l }
}

const run = (o: Partial<SeriesInputs>) => seriesPnl({
  trader: 'asha', stock: 'TCS', today: '2026-10-22', legs: [], trades: [], balance: null, historyFrom: '2026-08-01',
  rates: FREE, lotSizeOf: () => 175, ...o,
})

const only = (o: Partial<SeriesInputs>) => {
  const r = run(o)
  assert.equal(r.series.length, 1, JSON.stringify(r.series))
  return r.series[0]!
}

test('a partial close inside an open cycle is in the net price only: never booked again', () => {
  // sold 100 at 10, bought 50 back at 6: the leg is -50 at a net price of 14, so at LTP 5 its GrossMTM is 450 (200 realised + 250 open)
  const s = only({ trades: [tr('Sell', 100, 10, '2026-10-19'), tr('Buy', 50, 6, '2026-10-20')], legs: [leg(450)] })
  assert.deepEqual([s.open, s.booked, s.gross, s.net, s.closedContracts, s.openLegs], [450, 0, 450, 450, 0, 1])
})

test('a contract closed, reopened and closed again is two cycles, each booked', () => {
  const s = only({
    trades: [
      tr('Sell', 100, 10, '2026-10-15'), tr('Buy', 100, 6, '2026-10-16'),     // +400
      tr('Sell', 100, 8, '2026-10-19'), tr('Buy', 100, 9, '2026-10-20'),      // -100
    ],
  })
  assert.deepEqual([s.expiry, s.open, s.booked, s.gross, s.closedContracts, s.openLegs, s.from], [OCT, 0, 300, 300, 2, 0, '2026-10-15'])
})

test('flat at a day\'s end books the cycle; flat and reopened within the day carries it in the net price', () => {
  const sameDay = [tr('Buy', 100, 10, '2026-10-19', { hhmm: '10:00' }), tr('Sell', 100, 12, '2026-10-19', { hhmm: '11:00' }), tr('Buy', 100, 11, '2026-10-19', { hhmm: '12:00' })]
  // the ledger's own net price: 9, so at LTP 11 the open leg holds the 200 made intraday
  const [held] = legsFromTrades(null, sameDay)
  assert.equal(held!.avgPrice, 9)
  const a = only({ trades: sameDay, legs: [leg((11 - 9) * 100)] })
  assert.deepEqual([a.open, a.booked, a.gross, a.closedContracts], [200, 0, 200, 0])

  const nextDay = [tr('Buy', 100, 10, '2026-10-19', { hhmm: '10:00' }), tr('Sell', 100, 12, '2026-10-19', { hhmm: '11:00' }), tr('Buy', 100, 11, '2026-10-20', { hhmm: '09:30' })]
  assert.equal(legsFromTrades(null, nextDay)[0]!.avgPrice, 11)
  const b = only({ trades: nextDay, legs: [leg(0)] })
  assert.deepEqual([b.open, b.booked, b.gross, b.closedContracts], [0, 200, 200, 1])
})

test('every client code is in the series, each contract walked on its own; a code\'s case does not split it', () => {
  const s = only({
    trades: [
      tr('Sell', 100, 10, '2026-10-19'), tr('Buy', 100, 7, '2026-10-20', { clientCode: 'c1' }),   // C1: +300, one contract
      tr('Buy', 100, 8, '2026-10-19', { clientCode: 'C2' }),                                       // C2: still open, not netted against C1
    ],
    legs: [leg(-50, { clientCode: 'C2' })],
  })
  assert.deepEqual([s.open, s.booked, s.gross, s.closedContracts, s.openLegs], [-50, 300, 250, 1, 1])
})

test('a future of the same expiry is in the series beside its options', () => {
  const s = only({
    trades: [
      tr('Buy', 175, 3000, '2026-10-19', { instrument: 'future', strike: null, optType: null }),
      tr('Sell', 175, 3050, '2026-10-20', { instrument: 'future', strike: null, optType: null }),
      tr('Sell', 175, 40, '2026-10-19'),
    ],
    legs: [leg(1000)],
  })
  assert.deepEqual([s.open, s.booked, s.gross, s.closedContracts], [1000, 175 * 50, 1000 + 175 * 50, 1])
})

test('an open leg with no LTP makes open, gross and net unknown and is named; booked and charges still stand', () => {
  const noLtpLeg = leg(null, { strike: 3600 })
  const r = run({ trades: [tr('Sell', 100, 10, '2026-10-15'), tr('Buy', 100, 6, '2026-10-16')], legs: [leg(100), noLtpLeg] })
  const s = r.series[0]!
  assert.deepEqual([s.open, s.booked, s.gross, s.net], [null, 400, null, null])
  assert.deepEqual(s.noLtp, [noLtpLeg.key])
  assert.ok(s.notes.includes('3600 CE 2026-10-27: no LTP — open and net unknown'), JSON.stringify(s.notes))
  assert.deepEqual([r.total.open, r.total.booked, r.total.gross, r.total.net], [null, 400, null, null])
})

test('charges: chargesFor over every fill of the series, open and closed cycles, an order per day, with the admin\'s rates', () => {
  const trades = [
    tr('Sell', 175, 40, '2026-10-15', { orderNo: 'A' }), tr('Buy', 175, 30, '2026-10-16', { orderNo: 'A' }),   // order numbers repeat across days
    tr('Sell', 350, 20, '2026-10-19', { orderNo: 'B', strike: 3600 }), tr('Sell', 175, 21, '2026-10-19', { orderNo: 'B', strike: 3600 }),
  ]
  const s = only({ trades, legs: [leg(500, { strike: 3600 })], rates: SEED_RATES })
  const want = chargesFor(trades.map((t) => ({ instrument: t.instrument, side: t.side, qty: t.qty, price: t.price, orderNo: `${t.day}|${t.orderNo}`, lotSize: 175 })), SEED_RATES, 'asha').total
  assert.ok(Math.abs(s.charges - want) < 1e-9, `${s.charges} vs ${want}`)
  assert.ok(s.charges > 60 && s.charges < 61 + 50, String(s.charges))   // three orders' brokerage at least
  assert.equal(s.gross, 500 + 175 * 10)
  assert.ok(Math.abs((s.net as number) - (500 + 1750 - want)) < 1e-9)
  assert.equal(run({ trades, rates: SEED_RATES }).total.ratesConfirmed, false)
  assert.equal(run({ trades }).total.ratesConfirmed, true)
})

test('a next-month future opened and closed while this month is open: two series, the total sums them', () => {
  const fut = { instrument: 'future' as const, expiry: NOV, strike: null, optType: null }
  const r = run({
    trades: [tr('Sell', 100, 10, '2026-10-19'), tr('Buy', 175, 3000, '2026-10-19', fut), tr('Sell', 175, 3020, '2026-10-20', fut)],
    legs: [leg(-200)],
  })
  assert.deepEqual(r.series.map((s) => [s.expiry, s.open, s.booked, s.net, s.openLegs]), [[OCT, -200, 0, -200, 1], [NOV, 0, 3500, 3500, 0]])
  assert.deepEqual([r.total.open, r.total.booked, r.total.gross, r.total.net, r.total.closedContracts, r.total.from], [-200, 3500, 3300, 3300, 1, '2026-10-19'])
})

test('after this month\'s expiry its series drops out and the next month\'s stays, from its first trade', () => {
  const fut = { instrument: 'future' as const, expiry: NOV, strike: null, optType: null }
  const trades = [tr('Sell', 100, 10, '2026-10-19'), tr('Buy', 100, 4, '2026-10-26'), tr('Buy', 175, 3000, '2026-10-19', fut), tr('Sell', 175, 3020, '2026-10-20', fut)]
  assert.deepEqual(run({ trades }).series.map((s) => s.expiry), [OCT, NOV])
  // on its expiry day the series is still live
  assert.deepEqual(run({ trades, today: OCT }).series.map((s) => s.expiry), [OCT, NOV])
  const after = run({ trades, today: '2026-10-28' })
  assert.deepEqual(after.series.map((s) => [s.expiry, s.booked, s.from]), [[NOV, 3500, '2026-10-19']])
  assert.equal(after.total.booked, 3500)
})

test('a stock whose live-expiry trades are all closed still has its series: booked only', () => {
  const s = only({ trades: [tr('Sell', 100, 10, '2026-10-15'), tr('Buy', 100, 12, '2026-10-16')] })
  assert.deepEqual([s.open, s.booked, s.net, s.openLegs, s.closedContracts], [0, -200, -200, 0, 1])
})

test('expired contracts and shares are left out; a book holding shares says so', () => {
  const r = run({
    trades: [
      tr('Sell', 100, 10, '2026-09-20', { expiry: SEP }), tr('Buy', 100, 2, '2026-09-25', { expiry: SEP }),
      tr('Buy', 50, 3000, '2026-10-19', { instrument: 'share', expiry: '', strike: null, optType: null }),
    ],
    legs: [leg(5000, { instrument: 'share', expiry: '', strike: null, optType: null }), leg(100)],
  })
  assert.deepEqual(r.series.map((s) => [s.expiry, s.open, s.booked]), [[OCT, 100, 0]])
  assert.deepEqual(r.total.notes, ['shares are left out of P&L: they have no expiry'])
  assert.deepEqual(run({ legs: [leg(100)] }).total.notes, [])
})

test('an opening balance starts the walk, and booked counts from where the history starts', () => {
  const position = { clientCode: 'c1', stock: 'TCS', instrument: 'option' as const, expiry: OCT, strike: 3500, optType: 'CE' as const, qty: -100, avgPrice: 12 }
  const other = { ...position, stock: 'INFY', qty: -500 }
  const s = only({
    balance: { day: '2026-10-12', positions: [position, other] },
    historyFrom: null,
    // on the balance's day: already in it, never counted again
    trades: [tr('Sell', 999, 1, '2026-10-12'), tr('Buy', 100, 5, '2026-10-14')],
  })
  assert.deepEqual([s.booked, s.closedContracts, s.from, s.since], [700, 1, '2026-10-14', '2026-10-13'])
  assert.ok(s.notes.includes('booked since 13 Oct 2026 — the trade history starts there'), JSON.stringify(s.notes))

  const late = only({ historyFrom: '2026-10-08', trades: [tr('Sell', 100, 10, '2026-10-15')], legs: [leg(0)] })
  assert.equal(late.since, '2026-10-08')
  // a history from before the month: nothing to say, even for next month's series
  const early = run({ historyFrom: '2026-08-26', trades: [tr('Sell', 100, 10, '2026-10-15', { expiry: NOV })] })
  assert.deepEqual(early.series.map((x) => [x.since, x.notes]), [[null, []]])
})

test('open + booked is every trade\'s cash plus the open legs at LTP, through resets and same-day flips', () => {
  const ltp: Record<number, number> = { 3500: 9, 3600: 4, 3700: 1 }
  const trades = [
    tr('Sell', 175, 20, '2026-10-12', { strike: 3500 }), tr('Buy', 175, 14, '2026-10-13', { strike: 3500 }),
    tr('Sell', 350, 15, '2026-10-14', { strike: 3500 }), tr('Buy', 175, 11, '2026-10-15', { strike: 3500 }),
    tr('Sell', 175, 8, '2026-10-12', { strike: 3600, hhmm: '09:30' }), tr('Buy', 175, 6, '2026-10-12', { strike: 3600, hhmm: '10:30' }),
    tr('Sell', 350, 7, '2026-10-12', { strike: 3600, hhmm: '11:30' }), tr('Buy', 350, 5, '2026-10-19', { strike: 3600 }),
    tr('Sell', 175, 6, '2026-10-20', { strike: 3600 }),
    tr('Buy', 175, 3, '2026-10-14', { strike: 3700 }), tr('Sell', 175, 2, '2026-10-16', { strike: 3700 }),
  ]
  const legs = legsFromTrades(null, trades).filter((l) => l.qty !== 0)
    .map((l) => leg((ltp[l.strike as number]! - l.avgPrice) * l.qty, { strike: l.strike }))
  const cash = trades.reduce((s, t) => s - (t.side === 'Buy' ? 1 : -1) * t.qty * t.price, 0)
  const atLtp = legsFromTrades(null, trades).reduce((s, l) => s + l.qty * (ltp[l.strike as number] ?? 0), 0)
  const s = only({ trades, legs })
  assert.ok(Math.abs((s.gross as number) - (cash + atLtp)) < 1e-6, `${s.gross} vs ${cash + atLtp}`)
  assert.equal(s.closedContracts, 3)
})

test('one closed part, the open legs added again and again (the live frame): each the same as seriesPnl from scratch', () => {
  const inputs: SeriesInputs = {
    trader: 'asha', stock: 'TCS', today: '2026-10-22', historyFrom: '2026-08-01', rates: SEED_RATES, lotSizeOf: () => 175, balance: null,
    trades: [tr('Sell', 100, 10, '2026-10-15'), tr('Buy', 100, 6, '2026-10-16'), tr('Sell', 50, 12, '2026-10-19', { expiry: NOV })],
    legs: [],
  }
  const closed = seriesClosed(inputs)
  for (const legs of [[leg(450)], [leg(-120.5), leg(30, { expiry: NOV })], [leg(null)], [leg(10, { instrument: 'share', expiry: '' })], []]) {
    assert.deepEqual(withOpenLegs(closed, { ...inputs, legs }), seriesPnl({ ...inputs, legs }), JSON.stringify(legs))
  }
})
