import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InstrumentRow } from '@algomaker/instruments'
import { ledgerWalk, legsFromTrades, type LedgerTrade, type OpeningBalance } from '../src/ingest/ledger.ts'
import {
  isIndexFrom, listedAbout, priceFromHistory, settlementOf, settlementRun, tradeRecordOf,
  type HistoryCloses, type IsIndex, type SettlementPrice, type TradeRecord,
} from '../src/ingest/settlement.ts'
import { buildTradersMaster } from '../src/market/master.ts'
import { testMaster } from './fixtures/master.ts'

const SEP = '2026-09-29'
const TODAY = '2026-10-23'
const AFTER = '2026-09-30'

const tr = (side: 'Buy' | 'Sell', qty: number, price: number, day: string, hhmm: string, seq: number, over: Partial<LedgerTrade> = {}): LedgerTrade =>
  ({ clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: SEP, strike: 2000, optType: 'CE', side, qty, price, day, time: Date.parse(`${day}T${hhmm}:00+05:30`), seq, ...over })
const share = (side: 'Buy' | 'Sell', qty: number, price: number, day: string, hhmm: string, seq: number, over: Partial<LedgerTrade> = {}): LedgerTrade =>
  tr(side, qty, price, day, hhmm, seq, { instrument: 'share', expiry: '', strike: null, optType: null, ...over })

/** S per (stock, day); anything else is missing. */
const prices = (m: Record<string, number>): SettlementPrice => (stock, day) => m[`${stock}|${day}`] ?? null
const TCS_AT = prices({ [`TCS|${SEP}`]: 2032.4, [`NIFTY|${SEP}`]: 24800, [`TCS|${TODAY}`]: 2100 })
const INDEX: IsIndex = (s) => s === 'NIFTY'

/** The fills as [instrument, side, qty, price]. */
const shape = (fills: readonly LedgerTrade[]) => fills.map((f) => [f.instrument, f.side, f.qty, f.price])

test('a long ITM stock call closes at intrinsic and takes the shares in at S', () => {
  const s = settlementRun(null, [tr('Buy', 175, 20, '2026-09-22', '10:00', 1)], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(s.fills), [['option', 'Sell', 175, 32.4], ['share', 'Buy', 175, 2032.4]])
  assert.equal(s.fills[1]!.expiry, ''); assert.equal(s.fills[1]!.strike, null); assert.equal(s.fills[1]!.optType, null)
  assert.ok(s.fills.every((f) => f.settlement === true && f.day === SEP))
  assert.deepEqual(s.deliveries, [{ key: 'C1|share|TCS|||', stock: 'TCS', expiry: SEP, shares: 175, price: 2032.4, from: 'C1|option|TCS|2026-09-29|2000|CE' }])
  assert.deepEqual(s.unsettled, [])
})

test('an OTM option closes at 0 and delivers nothing', () => {
  const s = settlementOf(null, [tr('Sell', 175, 15, '2026-09-22', '10:00', 1, { strike: 2100 })], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(s.fills), [['option', 'Buy', 175, 0]])
  const put = settlementOf(null, [tr('Buy', 175, 15, '2026-09-22', '10:00', 1, { strike: 2000, optType: 'PE' })], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(put.fills), [['option', 'Sell', 175, 0]])
})

test('puts and short calls: long PE and short CE give the shares out, short PE takes them in', () => {
  const longPe = settlementRun(null, [tr('Buy', 175, 30, '2026-09-22', '10:00', 1, { strike: 2100, optType: 'PE' })], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(longPe.fills), [['option', 'Sell', 175, 67.6], ['share', 'Sell', 175, 2032.4]])
  assert.equal(longPe.deliveries[0]!.shares, -175)
  const shortPe = settlementRun(null, [tr('Sell', 350, 30, '2026-09-22', '10:00', 1, { strike: 2100, optType: 'PE' })], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(shortPe.fills), [['option', 'Buy', 350, 67.6], ['share', 'Buy', 350, 2032.4]])
  assert.equal(shortPe.deliveries[0]!.shares, 350)
  const shortCe = settlementRun(null, [tr('Sell', 175, 30, '2026-09-22', '10:00', 1)], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(shortCe.fills), [['option', 'Buy', 175, 32.4], ['share', 'Sell', 175, 2032.4]])
  assert.equal(shortCe.deliveries[0]!.shares, -175)
})

test('a stock future closes at S and delivers q; a short one gives the shares out', () => {
  const fut = { instrument: 'future', strike: null, optType: null } as const
  const long = settlementOf(null, [tr('Buy', 175, 2010, '2026-09-22', '10:00', 1, fut)], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(long.fills), [['future', 'Sell', 175, 2032.4], ['share', 'Buy', 175, 2032.4]])
  const short = settlementOf(null, [tr('Sell', 175, 2010, '2026-09-22', '10:00', 1, fut)], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(short.fills), [['future', 'Buy', 175, 2032.4], ['share', 'Sell', 175, 2032.4]])
})

test('an index is cash-settled: the option and the future close, no shares', () => {
  const nifty = { stock: 'NIFTY', strike: 24500 } as const
  const s = settlementRun(null, [
    tr('Buy', 75, 120, '2026-09-22', '10:00', 1, nifty),
    tr('Sell', 75, 24600, '2026-09-22', '10:01', 2, { stock: 'NIFTY', instrument: 'future', strike: null, optType: null }),
  ], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(s.fills).sort(), [['future', 'Buy', 75, 24800], ['option', 'Sell', 75, 300]].sort())
  assert.deepEqual(s.deliveries, [])
})

test('no S: the contract stays open, unsettled with its reason; a plain price function gives a plain reason', () => {
  const t = [tr('Buy', 175, 20, '2026-07-21', '10:00', 1, { expiry: '2026-07-28' })]
  const plain = settlementOf(null, t, TODAY, TCS_AT, INDEX)
  assert.deepEqual(plain, { fills: [], unsettled: [{ key: 'C1|option|TCS|2026-07-28|2000|CE', stock: 'TCS', expiry: '2026-07-28', qty: 175, reason: 'no settlement price for 2026-07-28' }] })
  const explained = Object.assign(TCS_AT, { missing: (_s: string, d: string) => `no NSE history for ${d}` })
  assert.equal(settlementOf(null, t, TODAY, explained, INDEX).unsettled[0]!.reason, 'no NSE history for 2026-07-28')
  // and the legs keep it open
  assert.equal(legsFromTrades(null, t)[0]!.qty, 175)
})

test("today's expiry settles once its close exists and is never unsettled before; a later one is left alone", () => {
  const t = [tr('Buy', 175, 20, '2026-10-20', '10:00', 1, { expiry: TODAY })]
  assert.deepEqual(shape(settlementOf(null, t, TODAY, TCS_AT, INDEX).fills), [['option', 'Sell', 175, 100], ['share', 'Buy', 175, 2100]])
  assert.deepEqual(settlementOf(null, t, TODAY, prices({}), INDEX), { fills: [], unsettled: [] })
  assert.deepEqual(settlementOf(null, [tr('Buy', 175, 20, '2026-10-20', '10:00', 1, { expiry: '2026-10-27' })], TODAY, TCS_AT, INDEX), { fills: [], unsettled: [] })
})

test('a partial close on the expiry day settles the rest; the expired leg ends at 0 beside the share leg', () => {
  const t = [tr('Buy', 525, 20, '2026-09-22', '10:00', 1), tr('Sell', 175, 30, SEP, '11:00', 1)]
  const s = settlementOf(null, t, TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(s.fills), [['option', 'Sell', 350, 32.4], ['share', 'Buy', 350, 2032.4]])
  const legs = legsFromTrades(null, [...t, ...s.fills])
  assert.deepEqual(legs.map((l) => [l.instrument, l.qty, Number(l.avgPrice.toFixed(4))]), [['option', 0, 0], ['share', 350, 2032.4]])
})

test('flat and reopened on the expiry day settles what is open at its end; flat at the end settles nothing', () => {
  const reopened = [tr('Buy', 175, 20, SEP, '10:00', 1), tr('Sell', 175, 25, SEP, '11:00', 2), tr('Buy', 350, 28, SEP, '14:00', 3)]
  assert.deepEqual(shape(settlementOf(null, reopened, TODAY, TCS_AT, INDEX).fills), [['option', 'Sell', 350, 32.4], ['share', 'Buy', 350, 2032.4]])
  const flat = [tr('Buy', 175, 20, '2026-09-22', '10:00', 1), tr('Sell', 175, 25, SEP, '15:20', 2)]
  assert.deepEqual(settlementOf(null, flat, TODAY, TCS_AT, INDEX), { fills: [], unsettled: [] })
})

test('every fill walks after every real trade of its day, whatever their time or line', () => {
  const late = tr('Buy', 175, 20, SEP, '23:59', Number.MAX_SAFE_INTEGER - 1, { time: Date.parse(`${SEP}T23:59:59+05:30`) })
  const sold = share('Sell', 175, 2040, SEP, '15:10', 999_999)
  const s = settlementOf(null, [late, sold], TODAY, TCS_AT, INDEX)
  const walk = ledgerWalk(null, [...s.fills, sold, late])
  assert.deepEqual(walk.slice(0, 2), [sold, late])
  assert.ok(walk.slice(2).every((f) => 'settlement' in f))
  assert.ok(s.fills.every((f) => f.time > late.time && f.time < Date.parse(`${AFTER}T00:00:00+05:30`)))
})

test('the delivered shares net with the cash-market sell that follows', () => {
  const t = [tr('Buy', 175, 20, '2026-09-22', '10:00', 1), share('Sell', 175, 2050, AFTER, '09:30', 1)]
  const s = settlementOf(null, t, TODAY, TCS_AT, INDEX)
  const legs = legsFromTrades(null, [...t, ...s.fills])
  assert.deepEqual(legs.map((l) => [l.instrument, l.qty, l.avgPrice]), [['option', 0, 0], ['share', 0, 0]])
  // without the settlement, that sell is a short the trader never had
  assert.deepEqual(legsFromTrades(null, t).map((l) => [l.instrument, l.qty]), [['option', 175], ['share', -175]])
})

test('client codes are upper-cased, as LedgerStore reads them', () => {
  const s = settlementRun(null, [tr('Buy', 100, 20, '2026-09-22', '10:00', 1, { clientCode: 'c1' }), tr('Buy', 75, 21, '2026-09-23', '10:00', 1)], TODAY, TCS_AT, INDEX)
  assert.deepEqual(shape(s.fills), [['option', 'Sell', 175, 32.4], ['share', 'Buy', 175, 2032.4]])
  assert.ok(s.fills.every((f) => f.clientCode === 'C1'))
})

test('a trade dated after its own expiry does not move what settles', () => {
  const t = [tr('Buy', 175, 20, '2026-09-22', '10:00', 1), tr('Sell', 175, 1, '2026-10-01', '10:00', 1)]
  assert.deepEqual(shape(settlementOf(null, t, TODAY, TCS_AT, INDEX).fills), [['option', 'Sell', 175, 32.4], ['share', 'Buy', 175, 2032.4]])
})

test('the balance edge: a contract the balance holds past its expiry settles first thing after the balance', () => {
  const pos = { clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: SEP, strike: 2000, optType: 'CE' as const, qty: 175, avgPrice: 20 }
  for (const day of [SEP, AFTER]) {
    const balance: OpeningBalance = { day, positions: [pos] }
    const sold = share('Sell', 175, 2050, '2026-10-01', '00:00', 0)
    const s = settlementOf(balance, [sold], TODAY, TCS_AT, INDEX)
    assert.deepEqual(shape(s.fills), [['option', 'Sell', 175, 32.4], ['share', 'Buy', 175, 2032.4]])
    const first = day === SEP ? AFTER : '2026-10-01'
    assert.ok(s.fills.every((f) => f.day === first && f.time === Date.parse(`${first}T00:00:00+05:30`) && f.seq === -1))
    const legs = legsFromTrades(balance, [sold, ...s.fills])
    assert.deepEqual(legs.map((l) => [l.instrument, l.qty]), [['option', 0], ['share', 0]])
  }
  // trades on or before the balance's day are in it, not counted again
  const balance: OpeningBalance = { day: AFTER, positions: [pos] }
  assert.equal(settlementOf(balance, [tr('Buy', 999, 1, SEP, '10:00', 1)], TODAY, TCS_AT, INDEX).fills[0]!.qty, 175)
})

test('shares and an option with no strike are not settled; the latter is reported', () => {
  assert.deepEqual(settlementOf(null, [share('Buy', 10, 2000, '2026-09-22', '10:00', 1)], TODAY, TCS_AT, INDEX), { fills: [], unsettled: [] })
  const bad = settlementOf(null, [tr('Buy', 175, 20, '2026-09-22', '10:00', 1, { strike: null })], TODAY, TCS_AT, INDEX)
  assert.deepEqual(bad.unsettled.map((u) => u.reason), ['no strike or option type'])
})

// ---- the record guard ------------------------------------------------------------

/** Every weekday from `from` to `to` (holidays too: a trader cannot trade on one), less `missing`. */
function days(from: string, to: string, missing: readonly string[] = []): Set<string> {
  const out = new Set<string>()
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10)
    if (new Date(t).getUTCDay() % 6 !== 0 && !missing.includes(d)) out.add(d)
  }
  return out
}
/** A record of NSE F&O trades on `nse` (no BSE trades), from `from`. */
const nseRecord = (nse: Set<string>, from: string): TradeRecord => ({ days: { NSE: nse, BSE: new Set() }, from })
const FROM_JUNE = '2026-06-01'   // before the September contracts listed (about 29 Jun)

test('an exact-ATM option closes at 0 and delivers nothing', () => {
  const s = settlementRun(null, [tr('Buy', 175, 20, '2026-09-22', '10:00', 1), tr('Sell', 175, 20, '2026-09-22', '10:01', 2, { optType: 'PE' })], TODAY, prices({ [`TCS|${SEP}`]: 2000 }), INDEX)
  assert.deepEqual(shape(s.fills).sort(), [['option', 'Buy', 175, 0], ['option', 'Sell', 175, 0]])
  assert.deepEqual(s.deliveries, [])
})

test('the record guard: a trading day with no F&O trade while the cycle was open holds it, with the day named', () => {
  const t = [tr('Buy', 175, 20, '2026-09-22', '10:00', 1)]
  assert.equal(settlementOf(null, t, TODAY, TCS_AT, INDEX, nseRecord(days(FROM_JUNE, TODAY), FROM_JUNE)).fills.length, 2)
  const held = settlementRun(null, t, TODAY, TCS_AT, INDEX, nseRecord(days(FROM_JUNE, TODAY, ['2026-09-24', '2026-09-25']), FROM_JUNE))
  assert.deepEqual(held.fills, []); assert.deepEqual(held.deliveries, [])
  assert.deepEqual(held.unsettled.map((u) => [u.qty, u.reason]), [[175, 'no trade stored on 2026-09-24 and 1 more trading day(s) while it was open — a trade file may be missing']])
  // a gap before the open cycle began does not matter: the contract went flat at a day's end, then reopened
  const reopened = [tr('Buy', 175, 20, '2026-09-01', '10:00', 1), tr('Sell', 175, 22, '2026-09-02', '10:00', 1), tr('Buy', 175, 21, '2026-09-28', '10:00', 1)]
  assert.equal(settlementOf(null, reopened, TODAY, TCS_AT, INDEX, nseRecord(days(FROM_JUNE, TODAY, ['2026-09-10']), FROM_JUNE)).fills.length, 2)
  // the expiry day itself counts: a closing trade on it may be in a file that never came
  const lastDay = nseRecord(days(FROM_JUNE, TODAY, [SEP]), FROM_JUNE)
  assert.equal(settlementOf(null, [tr('Buy', 175, 20, '2026-09-28', '10:00', 1)], TODAY, TCS_AT, INDEX, lastDay).unsettled.length, 1)
})

test('the record guard: a holiday is no gap', () => {
  // 14 Sep 2026 (Ganesh Chaturthi) and 2 Oct 2026 (Gandhi Jayanti) are NSE holidays: nobody trades on them
  const t = [tr('Buy', 175, 20, '2026-09-10', '10:00', 1)]
  const record = nseRecord(days(FROM_JUNE, TODAY, ['2026-09-14', '2026-10-02']), FROM_JUNE)
  assert.equal(settlementOf(null, t, TODAY, TCS_AT, INDEX, record).fills.length, 2)
  // the day after the holiday is a trading day again
  const gap = nseRecord(days(FROM_JUNE, TODAY, ['2026-09-14', '2026-09-15']), FROM_JUNE)
  assert.deepEqual(settlementOf(null, t, TODAY, TCS_AT, INDEX, gap).unsettled.map((u) => u.reason), ['no trade stored on 2026-09-15 while it was open — a trade file may be missing'])
})

test('the record guard counts only F&O trades on the contract\'s exchange', () => {
  // the trader's record as LedgerStore builds it: a share trade fills no F&O day, an NSE trade no BSE day
  const nseDaily = [...days('2026-09-21', SEP)].map((d, i) => tr('Buy', 1, 1, d, '10:00', i, { strike: 2500, expiry: '2026-10-27' }))
  const withShares = [
    tr('Buy', 175, 20, '2026-09-21', '10:00', 1),
    ...nseDaily.filter((t) => t.day !== '2026-09-23'), share('Buy', 1, 2000, '2026-09-23', '10:00', 9),
  ]
  const r = tradeRecordOf(withShares, FROM_JUNE)
  assert.equal(r.days.NSE.has('2026-09-23'), false)
  assert.deepEqual(settlementOf(null, withShares, TODAY, TCS_AT, INDEX, r).unsettled.map((u) => u.reason),
    ['no trade stored on 2026-09-23 while it was open — a trade file may be missing'])
  // a SENSEX contract is vouched for by BSE trade days only
  const sensex = tr('Sell', 20, 300, '2026-09-21', '10:00', 1, { stock: 'SENSEX', strike: 85000, expiry: '2026-09-24' })
  const bseOnce = tradeRecordOf([sensex, ...nseDaily], FROM_JUNE)
  const at = prices({ 'SENSEX|2026-09-24': 84000 })
  assert.deepEqual(settlementOf(null, [sensex, ...nseDaily], TODAY, at, () => true, bseOnce).unsettled.map((u) => u.reason),
    ['no trade stored on 2026-09-22 and 2 more trading day(s) while it was open — a trade file may be missing'])
  const bseDaily = tradeRecordOf([sensex, ...['2026-09-22', '2026-09-23', '2026-09-24'].map((d, i) => ({ ...sensex, day: d, seq: i }))], FROM_JUNE)
  assert.equal(settlementOf(null, [sensex], TODAY, at, () => true, bseDaily).fills.length, 1)
})

test('the record guard: a contract listed before the record, with no opening balance, is held in every cycle', () => {
  const record = nseRecord(days('2026-08-25', TODAY), '2026-08-25')
  const why = "opened before the trader's record (2026-08-25) with no opening balance — upload a positions file for 2026-08-24 to settle it"
  // short 350 before the record, Buy 175 on 10 Sep: the walk would read long +175 and settle it
  for (const day of ['2026-08-25', '2026-09-10']) {
    assert.deepEqual(settlementOf(null, [tr('Buy', 175, 20, day, '10:00', 1)], TODAY, TCS_AT, INDEX, record).unsettled.map((u) => u.reason), [why])
  }
  // listed after the record began (listedAbout: three monthly expiries back), it cannot carry an earlier position
  assert.equal(listedAbout(SEP), '2026-06-29')
  assert.equal(listedAbout('2026-05-31'), '2026-02-28')
  assert.equal(settlementOf(null, [tr('Sell', 175, 20, '2026-06-30', '10:00', 1)], TODAY, TCS_AT, INDEX, nseRecord(days(FROM_JUNE, TODAY), FROM_JUNE)).fills.length, 2)
  // an opening balance is the positions before the trades: with one, the contract settles
  const pos = { clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: SEP, strike: 2000, optType: 'CE' as const, qty: -350, avgPrice: 20 }
  const s = settlementRun({ day: '2026-08-24', positions: [pos] }, [tr('Buy', 175, 20, '2026-09-10', '10:00', 1)], TODAY, TCS_AT, INDEX, record)
  assert.deepEqual(shape(s.fills), [['option', 'Buy', 175, 32.4], ['share', 'Sell', 175, 2032.4]])
})

// ---- the adapters --------------------------------------------------------------

/** A history store's closes: per day, per stock, a close or null (listed, nothing to settle at). */
function history(closes: Record<string, Record<string, number | null>>): HistoryCloses {
  return {
    close: (stock, day) => closes[day]?.[stock],
    hasCloses: (day) => day in closes,
    closeDays: () => ({ days: Object.keys(closes).length, first: Object.keys(closes).sort()[0] ?? null }),
  }
}

test('priceFromHistory: a stock settles at its CM close, an index only at its own close, and a gap says why', () => {
  const p = priceFromHistory(history({
    '2025-10-01': { TCS: 3000 },
    [SEP]: { TCS: 2032.4, NIFTY: null, BANKNIFTY: 54500.1 },
  }))
  assert.equal(p('TCS', SEP), 2032.4)
  assert.equal(p('NIFTY', SEP), null)   // its bar is the next month's future, never the settlement price
  assert.equal(p('BANKNIFTY', SEP), 54500.1)
  assert.equal(p('TATAMOTORS', SEP), null)
  assert.equal(p('TCS', '2025-07-31'), null)
  assert.equal(p.missing('NIFTY', SEP), `no index close in the NSE history of ${SEP}`)
  assert.equal(p.missing('TATAMOTORS', SEP), `not in the NSE history of ${SEP}`)
  assert.equal(p.missing('TCS', '2025-07-31'), 'no NSE history for 2025-07-31 (it starts 2025-10-01)')
  assert.equal(p.missing('TCS', '2026-09-28'), 'no NSE history for 2026-09-28')
  // settlementOf takes the reason from it
  const u = settlementOf(null, [tr('Buy', 75, 120, '2026-09-22', '10:00', 1, { stock: 'NIFTY', strike: 24500 })], TODAY, p, INDEX).unsettled
  assert.deepEqual(u.map((x) => [x.stock, x.qty, x.reason]), [['NIFTY', 75, `no index close in the NSE history of ${SEP}`]])
})

test('isIndexFrom: the known indices, an F&O underlying with no NSE cash row, and a delisted stock', () => {
  const isIndex = isIndexFrom(() => testMaster())
  for (const s of ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX']) assert.equal(isIndex(s), true, s)
  for (const s of ['TCS', 'BAJFINANCE', 'M&M', 'TATAMOTORS']) assert.equal(isIndex(s), false, s)
  const fpi: InstrumentRow = { instrument_token: 9, tradingsymbol: 'NIFTYFPI26OCTFUT', name: 'NIFTYFPI', expiry: '2026-10-27', strike: 0, tick_size: 0.05, lot_size: 50, instrument_type: 'FUT', segment: 'NFO-FUT', exchange: 'NFO' }
  assert.equal(isIndexFrom(() => buildTradersMaster([fpi], 0))('NIFTYFPI'), true)
})
