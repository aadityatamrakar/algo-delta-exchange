import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ledgerWalk, legsFromTrades, ledgerTradeOf } from '../src/ingest/ledger.ts'
import type { LedgerTrade } from '../src/ingest/ledger.ts'
import type { ParsedPosition } from '../src/ingest/parsers.ts'
import type { TraderTrade } from '../src/types.ts'

const tr = (side: 'Buy' | 'Sell', qty: number, price: number, day: string, hhmm: string, seq: number, over: Partial<LedgerTrade> = {}): LedgerTrade =>
  ({ clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE', side, qty, price, day, time: Date.parse(`${day}T${hhmm}:00+05:30`), seq, ...over })
const one = (legs: ParsedPosition[]) => { assert.equal(legs.length, 1); return [legs[0]!.qty, Number(legs[0]!.avgPrice.toFixed(4))] }

test('a short carries a positive net price', () => assert.deepEqual(one(legsFromTrades(null, [tr('Sell', 175, 40, '2026-10-19', '09:20', 1)])), [-175, 40]))
test('flat at the END of a day resets the value', () => {
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 10, '2026-10-16', '10:00', 1), tr('Sell', 100, 12, '2026-10-16', '11:00', 2), tr('Buy', 100, 11, '2026-10-19', '10:00', 1)])), [100, 11])
})
test('flat intraday and reopened the same day does not reset', () => {
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 10, '2026-10-19', '10:00', 1), tr('Sell', 100, 12, '2026-10-19', '11:00', 2), tr('Buy', 100, 11, '2026-10-19', '12:00', 3)])), [100, 9])
})
test('the net price can be negative', () => {
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 5, '2026-10-19', '10:00', 1), tr('Sell', 50, 20, '2026-10-19', '10:05', 2)])), [50, -10])
})
test('file order: time, then line number', () => {
  const same = '10:00'
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 11, '2026-10-19', same, 3), tr('Sell', 100, 10, '2026-10-19', same, 2)])), [0, 0])
  assert.deepEqual(one(legsFromTrades(null, [tr('Sell', 100, 12, '2026-10-16', '11:00', 2), tr('Buy', 100, 10, '2026-10-16', '10:00', 1), tr('Buy', 50, 11, '2026-10-19', '09:30', 1)])), [50, 11])
})
test('trades given out of order are walked by day, time, seq', () => {
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 11, '2026-10-19', '10:00', 1), tr('Buy', 100, 10, '2026-10-16', '10:00', 1), tr('Sell', 100, 12, '2026-10-16', '11:00', 2)])), [100, 11])
})
test('ledgerWalk: after the balance day, by day, time, then line; the input is not reordered', () => {
  const given = [tr('Buy', 1, 1, '2026-10-19', '10:00', 2), tr('Buy', 1, 2, '2026-10-19', '10:00', 1), tr('Buy', 1, 3, '2026-10-16', '15:00', 1), tr('Buy', 1, 4, '2026-10-15', '09:00', 1)]
  const before = given.map((t) => t.price)
  assert.deepEqual(ledgerWalk(null, given).map((t) => t.price), [4, 3, 2, 1])
  assert.deepEqual(ledgerWalk({ day: '2026-10-16', positions: [] }, given).map((t) => t.price), [2, 1])
  assert.deepEqual(given.map((t) => t.price), before)
})
test('duplicate balance rows for one contract are summed', () => {
  const row = (qty: number, avgPrice: number) => ({ clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: '2026-10-27', strike: 3500, optType: 'CE' as const, qty, avgPrice })
  assert.deepEqual(one(legsFromTrades({ day: '2026-10-16', positions: [row(-350, 40), row(-175, 44)] }, [])), [-525, Number(((-350 * 40 - 175 * 44) / -525).toFixed(4))])
})
test('an opening balance seeds the walk; trades on or before its day are not counted again', () => {
  const balance = { day: '2026-10-16', positions: [{ clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: '2026-10-27', strike: 3500, optType: 'CE' as const, qty: -350, avgPrice: 40 }] }
  assert.deepEqual(one(legsFromTrades(balance, [tr('Sell', 999, 1, '2026-10-16', '15:00', 9), tr('Buy', 175, 30, '2026-10-19', '10:15', 1)])), [-175, 50])
})
test('two client codes on one contract stay apart', () => {
  const legs = legsFromTrades(null, [tr('Sell', 350, 40, '2026-10-19', '09:20', 1), tr('Buy', 175, 38, '2026-10-19', '09:21', 2, { clientCode: 'C2' })])
  assert.deepEqual(legs.map((l) => [l.clientCode, l.qty]), [['C1', -350], ['C2', 175]])
})
test('ledgerTradeOf keeps only the ledger fields', () => {
  const t: TraderTrade = { trader: 'a', tradeNo: '1', orderNo: '2', ...tr('Buy', 1, 2, '2026-10-19', '10:00', 4) }
  assert.deepEqual(ledgerTradeOf(t), tr('Buy', 1, 2, '2026-10-19', '10:00', 4))
})
