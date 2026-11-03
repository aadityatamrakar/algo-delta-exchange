import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addMonths, adminBookedOf, bookedKey, bookedLedger, bookedOf, bookedView, defaultRange, LOT_UNKNOWN_NOTE, LOT_UNKNOWN_ROW_NOTE,
  NET_UNKNOWN_NOTE, SETTLEMENT_NOTE, SHARES_BOOKED_NOTE, type BookedInputs,
} from '../src/analytics/booked.ts'
import { chargesFor, SEED_RATES } from '../src/analytics/charges.ts'
import { cycleWalk, type WalkTrade } from '../src/analytics/cycles.ts'
import { seriesPnl, SETTLED_NOTE, type SeriesLeg } from '../src/analytics/series-pnl.ts'
import type { ChargeRates } from '../src/analytics/wire.ts'
import { legsFromTrades } from '../src/ingest/ledger.ts'
import type { SettlementFill } from '../src/ingest/settlement.ts'
import { bookedRange } from '../src/routes/booked.ts'
import { BadRequest } from '../src/routes/kit.ts'
import { legKey } from '../src/types.ts'

const OCT = '2026-10-27'
const NOV = '2026-11-24'
const SEP = '2026-09-29'
const AUG = '2026-08-25'
const TODAY = '2026-10-22'
const ASOF = Date.parse('2026-10-22T10:00:00+05:30')

/** No charges at all, so the P&L figures are exact. */
const FREE: ChargeRates = {
  option: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  future: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  share: { sttBuyPct: 0, sttSellPct: 0, exchangePct: 0, stampBuyPct: 0 },
  sebiPerCrore: 0, gstPct: 0, brokerage: { default: { mode: 'order', amount: 0 }, byTrader: {} }, confirmedBy: 'admin', confirmedAt: 1,
}

let seq = 0
function tr(side: 'Buy' | 'Sell', qty: number, price: number, day: string, over: Partial<WalkTrade> & { hhmm?: string } = {}): WalkTrade {
  const { hhmm = '10:00', ...rest } = over
  seq++
  return {
    clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE',
    side, qty, price, day, time: Date.parse(`${day}T${hhmm}:00+05:30`), seq, orderNo: `o${seq}`, ...rest,
  }
}
const SHARE = { instrument: 'share' as const, expiry: '', strike: null, optType: null }
const FUT = { instrument: 'future' as const, strike: null, optType: null }

/** NSE's settlement of a contract, as `settlementOf` makes it: dated on its expiry day, carrying no order. */
function settle(side: 'Buy' | 'Sell', qty: number, price: number, over: Partial<SettlementFill> & { hhmm?: string } = {}): SettlementFill {
  const { hhmm = '15:40', ...rest } = over
  const expiry = rest.expiry ?? OCT
  seq++
  return {
    clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry, strike: 3500, optType: 'CE',
    side, qty, price, day: expiry, time: Date.parse(`${expiry}T${hhmm}:00+05:30`), seq, settlement: true, ...rest,
  }
}

const inputs = (o: Partial<BookedInputs>): BookedInputs => ({
  trader: 'asha', trades: [], balance: null, historyFrom: '2026-07-01', rates: FREE, settlement: [], today: TODAY,
  lotSizeOf: () => 175, ...o,
})
const RANGE = { asOf: ASOF, from: '2026-07', to: '2026-12' }
const view = (o: Partial<BookedInputs>, mtm?: Record<string, number | null>) =>
  bookedOf({ ...inputs(o), ...RANGE, ...(mtm === undefined ? {} : { openMtm: new Map(Object.entries(mtm)) }) })
const rowOf = (v: ReturnType<typeof view>, stock: string, expiry: string, month?: string) => {
  const r = v.rows.find((x) => x.stock === stock && x.expiry === expiry && (month === undefined || x.month === month))
  assert.ok(r, `${stock} ${expiry} ${month ?? ''}: ${JSON.stringify(v.rows.map((x) => [x.stock, x.expiry, x.month]))}`)
  return r
}

test('a series closed out books Σ −v of its cycles, its charges over its fills, net = booked − charges', () => {
  const trades = [
    tr('Sell', 175, 40, '2026-09-10', { stock: 'INFY', expiry: SEP }), tr('Buy', 175, 30, '2026-09-11', { stock: 'INFY', expiry: SEP }),    // +1750
    tr('Sell', 350, 20, '2026-09-14', { stock: 'INFY', expiry: SEP, strike: 1600 }), tr('Buy', 350, 25, '2026-09-20', { stock: 'INFY', expiry: SEP, strike: 1600 }),   // −1750 + …
  ]
  const r = rowOf(view({ trades, rates: SEED_RATES }), 'INFY', SEP)
  const charges = chargesFor(trades.map((t) => ({ instrument: t.instrument, side: t.side, qty: t.qty, price: t.price, orderNo: `${t.day}|${t.orderNo}`, lotSize: 175 })), SEED_RATES, 'asha').total
  assert.deepEqual([r.kind, r.month, r.booked, r.settled, r.status, r.closedCycles, r.openContracts, r.firstDay, r.lastDay, r.openMtm],
    ['series', '2026-09', 1750 - 1750, 0, 'closed', 2, 0, '2026-09-10', '2026-09-20', null])
  assert.ok(Math.abs(r.charges - charges) < 1e-9 && r.charges > 0)
  assert.ok(Math.abs((r.net as number) - (r.booked - charges)) < 1e-9)
})

test('one walk: every live series books and charges what the Series P&L block does, and its net is the block\'s net', () => {
  const trades = [
    tr('Sell', 175, 20, '2026-10-12'), tr('Buy', 175, 14, '2026-10-13'),
    tr('Sell', 350, 15, '2026-10-14'), tr('Buy', 175, 11, '2026-10-15'),
    tr('Sell', 175, 8, '2026-10-12', { strike: 3600, hhmm: '09:30' }), tr('Buy', 175, 6, '2026-10-12', { strike: 3600, hhmm: '10:30' }),
    tr('Sell', 350, 7, '2026-10-12', { strike: 3600, hhmm: '11:30' }), tr('Buy', 350, 5, '2026-10-19', { strike: 3600 }),
    tr('Buy', 175, 3000, '2026-10-19', { ...FUT, expiry: NOV }), tr('Sell', 175, 3020, '2026-10-20', { ...FUT, expiry: NOV }),
    tr('Sell', 175, 30, '2026-09-20', { expiry: SEP }), tr('Buy', 175, 2, '2026-09-25', { expiry: SEP }),
    tr('Sell', 100, 900, '2026-10-01', { stock: 'INFY', expiry: OCT, strike: 1500 }),
  ]
  const ltp: Record<number, number> = { 3500: 9 }
  const legs: SeriesLeg[] = legsFromTrades(null, trades).filter((l) => l.qty !== 0 && l.stock === 'TCS' && l.expiry >= TODAY)
    .map((l) => ({ key: legKey(l), instrument: l.instrument, expiry: l.expiry, strike: l.strike, optType: l.optType, mtm: (ltp[l.strike as number]! - l.avgPrice) * l.qty }))
  const block = seriesPnl({ trader: 'asha', stock: 'TCS', today: TODAY, legs, trades: trades.filter((t) => t.stock === 'TCS'), balance: null, historyFrom: '2026-07-01', rates: SEED_RATES, lotSizeOf: () => 175 })
  const v = view({ trades, rates: SEED_RATES }, Object.fromEntries(block.series.filter((s) => s.openLegs > 0).map((s) => [bookedKey('TCS', s.expiry), s.open])))
  assert.deepEqual(block.series.map((s) => s.expiry), [OCT, NOV])
  for (const s of block.series) {
    const r = rowOf(v, 'TCS', s.expiry)
    assert.equal(r.booked, s.booked, s.expiry)
    assert.ok(Math.abs(r.charges - s.charges) < 1e-9, s.expiry)
    assert.equal(r.closedCycles, s.closedContracts, s.expiry)
    assert.ok(Math.abs((r.net as number) - (s.net as number)) < 1e-9, `${s.expiry}: ${r.net} vs ${s.net}`)
    assert.equal(r.status, s.openLegs > 0 ? 'open' : 'closed')
  }
  assert.equal(rowOf(v, 'TCS', OCT).openMtm, block.series[0]!.open)
  // the expired September series and a stock with no tab are on the page; the block has neither
  assert.deepEqual([rowOf(v, 'TCS', SEP).booked, rowOf(v, 'TCS', SEP).status], [175 * 28, 'closed'])
  assert.equal(rowOf(v, 'INFY', OCT).status, 'open')
})

test('the shared walk: a cycle per flat-at-day-end, client codes case-blind, the balance starts it, settlement fills kept out of fills', () => {
  const cycles = cycleWalk(
    { day: '2026-10-09', positions: [{ clientCode: 'c1', stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -100, avgPrice: 12 }] },
    [tr('Sell', 5, 1, '2026-10-09'), tr('Buy', 100, 5, '2026-10-12', { clientCode: 'C1' }), tr('Sell', 100, 9, '2026-10-14'), tr('Buy', 40, 4, '2026-10-27')],
    [settle('Buy', 60, 0)],
  )
  assert.deepEqual(cycles.map((c) => [c.closedOn, c.booked, c.settled, c.fills.length, c.qty]), [['2026-10-12', 700, false, 1, 0], [OCT, 900 - 160, true, 2, 0]])
  assert.equal(new Set(cycles.map((c) => c.contract.key)).size, 1)
})

test('settlement: a contract held to expiry closes at its settlement fill, booked includes it, charges never do', () => {
  // short 175 of the 3500 CE at 40; NSE settles it at intrinsic 25 on the expiry day (S = 3525)
  const trades = [tr('Sell', 175, 40, '2026-10-20'), tr('Buy', 175, 3000, '2026-10-20', { ...FUT }), tr('Sell', 50, 9, '2026-10-21', { strike: 3600 }), tr('Buy', 50, 2, '2026-10-26', { strike: 3600 })]
  const fills = [settle('Buy', 175, 25, { hhmm: '09:00' }), settle('Sell', 175, 3525, { ...FUT })]
  const after = { trades, settlement: fills, today: '2026-10-28', rates: SEED_RATES }
  const r = rowOf(view(after), 'TCS', OCT)
  assert.deepEqual([r.booked, r.settled, r.status, r.closedCycles, r.openContracts, r.lastDay], [175 * 15 + 175 * 525 + 50 * 7, 175 * 15 + 175 * 525, 'settled', 3, 0, '2026-10-26'])
  const real = chargesFor(trades.map((t) => ({ instrument: t.instrument, side: t.side, qty: t.qty, price: t.price, orderNo: `${t.day}|${t.orderNo}`, lotSize: 175 })), SEED_RATES, 'asha').total
  assert.ok(Math.abs(r.charges - real) < 1e-9, `${r.charges} vs ${real}`)
  assert.ok(Math.abs((r.net as number) - (r.booked - real)) < 1e-9)
  assert.ok(view(after).notes.includes(SETTLEMENT_NOTE))
  assert.equal(view({ trades: trades.slice(2) , today: '2026-10-28' }).notes.includes(SETTLEMENT_NOTE), false)

  // the same series on the Series P&L block, on the expiry evening: it settles there too, booked alike, its legs gone
  const block = seriesPnl({ trader: 'asha', stock: 'TCS', today: OCT, legs: [], trades, settlement: fills, balance: null, historyFrom: null, rates: SEED_RATES, lotSizeOf: () => 175 })
  const s = block.series[0]!
  assert.deepEqual([s.expiry, s.booked, s.open, s.closedContracts], [OCT, r.booked, 0, 3])
  assert.ok(Math.abs(s.charges - real) < 1e-9)
  assert.ok(s.notes.includes(SETTLED_NOTE), JSON.stringify(s.notes))
  // and before the close exists (no fill yet) it is open as before, with no note
  const before = seriesPnl({ trader: 'asha', stock: 'TCS', today: OCT, legs: [], trades, balance: null, historyFrom: null, rates: FREE, lotSizeOf: () => 175 })
  assert.deepEqual([before.series[0]!.booked, before.series[0]!.notes.includes(SETTLED_NOTE)], [50 * 7, false])
})

test('an expired contract with no settlement price is unsettled: its net is unknown, said with the reason', () => {
  const trades = [tr('Sell', 175, 40, '2026-09-10', { expiry: SEP }), tr('Sell', 100, 9, '2026-09-11', { expiry: SEP, strike: 3600 }), tr('Buy', 100, 4, '2026-09-12', { expiry: SEP, strike: 3600 })]
  const plain = view({ trades })
  const r = rowOf(plain, 'TCS', SEP)
  assert.deepEqual([r.status, r.booked, r.openMtm, r.net, r.openContracts], ['unsettled', 500, null, null, 1])
  assert.ok(r.notes.some((n) => n.startsWith('expired 29 Sep 2026 with 1 contract(s) still open')), JSON.stringify(r.notes))
  assert.deepEqual([plain.total.booked, plain.total.net, plain.total.open], [500, null, 1])
  assert.ok(plain.notes.includes(NET_UNKNOWN_NOTE))
  const said = view({ trades, unsettled: [{ key: 'k', stock: 'TCS', expiry: SEP, qty: -175, reason: 'no NSE close for 29 Sep 2026' }] })
  assert.deepEqual(rowOf(said, 'TCS', SEP).notes, ['no NSE close for 29 Sep 2026'])
})

test('an open series adds its open MTM (net = Series P&L); unpriced, its net is unknown; a manual-only one still has a row', () => {
  const trades = [tr('Sell', 100, 10, '2026-10-15'), tr('Buy', 100, 6, '2026-10-16'), tr('Sell', 100, 8, '2026-10-19', { strike: 3600 })]
  const priced = view({ trades }, { [bookedKey('TCS', OCT)]: -150, [bookedKey('VEDL', NOV)]: 75 })
  const r = rowOf(priced, 'TCS', OCT)
  assert.deepEqual([r.status, r.booked, r.openMtm, r.net, r.openContracts, r.closedCycles], ['open', 400, -150, 250, 1, 1])
  assert.deepEqual([rowOf(priced, 'VEDL', NOV).status, rowOf(priced, 'VEDL', NOV).net, rowOf(priced, 'VEDL', NOV).booked], ['open', 75, 0])
  assert.deepEqual([priced.total.openMtm, priced.total.net, priced.total.open], [-75, 325, 2])
  const unpriced = view({ trades })
  assert.deepEqual([rowOf(unpriced, 'TCS', OCT).openMtm, rowOf(unpriced, 'TCS', OCT).net], [null, null])
  assert.ok(rowOf(unpriced, 'TCS', OCT).notes.some((n) => n.startsWith('open P&L unknown')))
  assert.deepEqual([unpriced.total.booked, unpriced.total.openMtm, unpriced.total.net], [400, null, null])
  const nulled = view({ trades }, { [bookedKey('TCS', OCT)]: null })
  assert.equal(rowOf(nulled, 'TCS', OCT).net, null)
})

test('shares: their own row, booked when a holding is flat at a day\'s end, in that month; a holding still open sits in this month', () => {
  const trades = [
    tr('Buy', 10, 1000, '2026-08-20', SHARE), tr('Sell', 10, 1100, '2026-09-03', SHARE),          // +1000 booked in Sep
    tr('Buy', 5, 1200, '2026-09-25', SHARE), tr('Sell', 5, 1150, '2026-10-05', SHARE),            // −250 booked in Oct
    tr('Buy', 4, 1180, '2026-10-12', SHARE),                                                       // held
    tr('Buy', 2, 500, '2026-08-03', { ...SHARE, stock: 'INFY' }), tr('Sell', 2, 450, '2026-08-03', { ...SHARE, stock: 'INFY' }),
  ]
  const v = view({ trades }, { [bookedKey('TCS', '')]: 80 })
  const sep = rowOf(v, 'TCS', '', '2026-09')
  const oct = rowOf(v, 'TCS', '', '2026-10')
  assert.deepEqual([sep.kind, sep.booked, sep.status, sep.closedCycles, sep.firstDay, sep.lastDay], ['shares', 1000, 'closed', 1, '2026-08-20', '2026-09-03'])
  assert.deepEqual([oct.booked, oct.status, oct.openMtm, oct.net, oct.closedCycles, oct.openContracts], [-250, 'open', 80, -170, 1, 1])
  assert.deepEqual([rowOf(v, 'INFY', '', '2026-08').booked, rowOf(v, 'INFY', '', '2026-08').status], [-100, 'closed'])
  assert.ok(v.notes.includes(SHARES_BOOKED_NOTE))
  assert.equal(view({ trades: [tr('Sell', 1, 1, '2026-10-01')] }).notes.includes(SHARES_BOOKED_NOTE), false)
})

test('a range of months: rows newest month first, by stock, shares after series; totals by month and by stock; the months on offer', () => {
  const trades = [
    tr('Sell', 100, 10, '2026-08-10', { expiry: AUG }), tr('Buy', 100, 4, '2026-08-11', { expiry: AUG }),                       // TCS Aug +600
    tr('Sell', 100, 10, '2026-09-10', { expiry: SEP }), tr('Buy', 100, 12, '2026-09-11', { expiry: SEP }),                      // TCS Sep −200
    tr('Sell', 50, 20, '2026-09-10', { stock: 'INFY', expiry: SEP }), tr('Buy', 50, 10, '2026-09-11', { stock: 'INFY', expiry: SEP }),   // INFY Sep +500
    tr('Buy', 3, 100, '2026-09-01', { ...SHARE, stock: 'INFY' }), tr('Sell', 3, 110, '2026-09-02', { ...SHARE, stock: 'INFY' }),         // INFY shares Sep +30
    tr('Sell', 100, 5, '2026-07-10', { expiry: '2026-07-28' }), tr('Buy', 100, 1, '2026-07-11', { expiry: '2026-07-28' }),             // TCS Jul, out of range
  ]
  const v = bookedView(bookedLedger(inputs({ trades })), { asOf: ASOF, from: '2026-08', to: '2026-10' })
  assert.deepEqual(v.rows.map((r) => [r.month, r.stock, r.kind]), [['2026-09', 'INFY', 'series'], ['2026-09', 'INFY', 'shares'], ['2026-09', 'TCS', 'series'], ['2026-08', 'TCS', 'series']])
  assert.deepEqual(v.byMonth.map((m) => [m.month, m.booked, m.net, m.rows]), [['2026-09', 330, 330, 3], ['2026-08', 600, 600, 1]])
  assert.deepEqual(v.byStock.map((s) => [s.stock, s.booked]), [['INFY', 530], ['TCS', 400]])
  assert.deepEqual([v.total.booked, v.total.charges, v.total.openMtm, v.total.net, v.total.rows, v.total.open], [930, 0, 0, 930, 4, 0])
  assert.deepEqual(v.months, ['2026-09', '2026-08', '2026-07'])
  assert.deepEqual([v.from, v.to, v.trader, v.asOf], ['2026-08', '2026-10', 'asha', ASOF])
})

test('every figure counts from the history start, and the view says so; a month that starts before it is marked', () => {
  const trades = [tr('Sell', 100, 10, '2026-10-14'), tr('Buy', 100, 5, '2026-10-15'), tr('Sell', 100, 10, '2026-10-14', { expiry: NOV }), tr('Buy', 100, 5, '2026-10-15', { expiry: NOV })]
  const v = view({ trades, historyFrom: '2026-10-08' })
  assert.equal(v.historyStart, '2026-10-08')
  assert.ok(v.notes.includes('Figures count from 08 Oct 2026: the trade history the app holds starts there, and nothing before it is in them.'), JSON.stringify(v.notes))
  assert.deepEqual([rowOf(v, 'TCS', OCT).since, rowOf(v, 'TCS', NOV).since], ['2026-10-08', null])
  assert.ok(rowOf(v, 'TCS', OCT).notes.includes('counts from 08 Oct 2026 — the trade history starts there'))
  // an opening balance: the day after it, when later than the first trade file
  const b = view({ trades, historyFrom: '2026-10-01', balance: { day: '2026-10-12', positions: [] } })
  assert.equal(b.historyStart, '2026-10-13')
  assert.equal(view({ trades: [], historyFrom: null }).notes[0], 'No trade history yet: the figures start with the first ODIN trade file.')
})

test('the desk roll-up: each trader\'s months, the desk per month and in all; an unknown net stays unknown', () => {
  const a = view({ trades: [tr('Sell', 100, 10, '2026-09-10', { expiry: SEP }), tr('Buy', 100, 4, '2026-09-11', { expiry: SEP }), tr('Sell', 100, 10, '2026-10-14')] }, { [bookedKey('TCS', OCT)]: 100 })
  const b = view({ trader: 'ravi', trades: [tr('Sell', 50, 10, '2026-10-10'), tr('Buy', 50, 14, '2026-10-12')] })
  const desk = adminBookedOf([a, b], { asOf: ASOF, from: RANGE.from, to: RANGE.to })
  assert.deepEqual(desk.traders.map((t) => [t.trader, t.total.booked, t.total.net]), [['asha', 600, 700], ['ravi', -200, -200]])
  assert.deepEqual(desk.byMonth.map((m) => [m.month, m.booked, m.openMtm, m.net]), [['2026-10', -200, 100, -100], ['2026-09', 600, 0, 600]])
  assert.deepEqual([desk.total.booked, desk.total.net, desk.total.rows], [400, 500, 3])
  assert.ok(desk.notes.includes('asha: figures count from 01 Jul 2026'))
  const unknown = adminBookedOf([a, view({ trades: [tr('Sell', 1, 1, '2026-10-14')] })], { asOf: ASOF, from: RANGE.from, to: RANGE.to })
  assert.deepEqual([unknown.total.net, unknown.byMonth[0]!.net, unknown.byMonth[1]!.net], [null, null, 600])
  assert.ok(unknown.notes.includes(NET_UNKNOWN_NOTE))
})

test('months: the default range is this month and the two before; from/to are checked', () => {
  assert.deepEqual(defaultRange('2026-01-15'), { from: '2025-11', to: '2026-01' })
  assert.deepEqual([addMonths('2026-10', -2), addMonths('2025-12', 1), addMonths('2026-03', -15)], ['2026-08', '2026-01', '2024-12'])
  const q = (s: string) => bookedRange(new URLSearchParams(s), TODAY)
  assert.deepEqual(q(''), { from: '2026-08', to: '2026-10' })
  assert.deepEqual(q('to=2026-02'), { from: '2025-12', to: '2026-02' })
  assert.deepEqual(q('from=2026-05&to=2026-07'), { from: '2026-05', to: '2026-07' })
  for (const bad of ['from=2026-13', 'to=26-10', 'from=2026-10&to=2026-09', 'to=2026-1']) assert.throws(() => q(bad), BadRequest, bad)
})

/** Brokerage only, so the figure is the brokerage rule alone. */
const brokerageOnly = (mode: 'order' | 'lot', amount: number): ChargeRates => ({ ...FREE, brokerage: { default: { mode, amount }, byTrader: {} } })

test('an order number repeated on another day is another order: brokerage per order counts the day with it', () => {
  // ODIN restarts its order numbers: order A on 14 Oct and order A on 15 Oct are two orders, two brokerages
  const twoDays = [tr('Sell', 175, 40, '2026-10-14', { orderNo: 'A' }), tr('Buy', 175, 30, '2026-10-15', { orderNo: 'A' })]
  const oneDay = [tr('Sell', 175, 40, '2026-10-14', { orderNo: 'A', hhmm: '10:00' }), tr('Sell', 175, 39, '2026-10-14', { orderNo: 'A', hhmm: '10:01' }), tr('Buy', 350, 30, '2026-10-15', { orderNo: 'B' })]
  const rates = brokerageOnly('order', 20)
  assert.equal(rowOf(view({ trades: twoDays, rates }), 'TCS', OCT).charges, 40)
  assert.equal(rowOf(view({ trades: oneDay, rates }), 'TCS', OCT).charges, 40)   // A's two fills on one day are one order, B another
  assert.equal(rowOf(view({ trades: [...twoDays, tr('Sell', 10, 9, '2026-10-16', { orderNo: 'A', strike: 3600 })], rates }), 'TCS', OCT).charges, 60)
})

test('per-lot brokerage: each F&O fill pays per lot; a contract the master no longer lists (expired) pays per order, said on its row', () => {
  const trades = [
    tr('Sell', 350, 40, '2026-10-14'), tr('Buy', 175, 30, '2026-10-15'),                                     // Oct, live: 2 + 1 lots
    tr('Sell', 175, 30, '2026-09-20', { expiry: SEP }), tr('Buy', 175, 2, '2026-09-25', { expiry: SEP }),     // Sep, expired: no lot size
    tr('Buy', 10, 1000, '2026-10-01', SHARE), tr('Sell', 10, 1010, '2026-10-02', SHARE),                       // shares pay per order anyway
  ]
  const lotSizeOf = (_s: string, instrument: string, expiry: string): number | null => (instrument === 'share' ? 1 : expiry >= TODAY ? 175 : null)
  const v = view({ trades, rates: brokerageOnly('lot', 10), lotSizeOf })
  const oct = rowOf(v, 'TCS', OCT)
  const sep = rowOf(v, 'TCS', SEP)
  const shares = rowOf(v, 'TCS', '', '2026-10')
  assert.deepEqual([oct.charges, oct.notes.includes(LOT_UNKNOWN_ROW_NOTE)], [30, false])
  assert.deepEqual([sep.charges, sep.notes.includes(LOT_UNKNOWN_ROW_NOTE)], [20, true])
  assert.deepEqual([shares.charges, shares.notes.includes(LOT_UNKNOWN_ROW_NOTE)], [20, false])
  assert.ok(v.notes.includes(LOT_UNKNOWN_NOTE))
  assert.ok(adminBookedOf([v], { asOf: ASOF, from: RANGE.from, to: RANGE.to }).notes.includes(LOT_UNKNOWN_NOTE))
  // per order (the desk's rates today) nothing is unknown, and a range without the expired series says nothing
  assert.equal(view({ trades, rates: brokerageOnly('order', 10), lotSizeOf }).notes.includes(LOT_UNKNOWN_NOTE), false)
  assert.equal(bookedOf({ ...inputs({ trades, rates: brokerageOnly('lot', 10), lotSizeOf }), asOf: ASOF, from: '2026-10', to: '2026-10' }).notes.includes(LOT_UNKNOWN_NOTE), false)
})
