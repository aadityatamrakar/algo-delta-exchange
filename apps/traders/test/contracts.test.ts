import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contractsOf } from '../src/market/master.ts'
import { DEC, NOV, OCT, TEST_ROWS, testMaster } from './fixtures/master.ts'

test("a stock's listed expiries from today, each with its lot, ascending strikes and whether a future lists on it", () => {
  const v = contractsOf(testMaster(), 'TCS', '2026-10-20')
  assert.equal(v.stock, 'TCS')
  assert.deepEqual(v.expiries.map((e) => [e.expiry, e.future]), [[OCT, true], [NOV, true], [DEC, true]])
  const lot = TEST_ROWS.find((r) => r.name === 'TCS' && r.expiry === OCT && r.instrument_type === 'CE')!.lot_size
  assert.equal(v.expiries[0]!.lotSize, lot)
  const ks = v.expiries[0]!.strikes
  assert.ok(ks.length > 1)
  assert.deepEqual([...ks].sort((a, b) => a - b), ks)
})

test('an expiry before today is left out; an unknown stock lists nothing', () => {
  assert.deepEqual(contractsOf(testMaster(), 'TCS', '2026-11-01').expiries.map((e) => e.expiry), [NOV, DEC])
  assert.deepEqual(contractsOf(testMaster(), 'NOSUCH', '2026-10-20').expiries, [])
})
