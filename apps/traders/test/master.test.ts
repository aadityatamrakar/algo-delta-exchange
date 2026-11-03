import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadStoredInstruments } from '../../marketdata/src/sync-runner.ts'
import { instrumentRowOf, lotSizeOf, matchLeg, nearestFuture, spotTokenOf } from '../src/market/master.ts'
import type { LegContract } from '../src/market/master.ts'
import {
  BAJ_SPOT, MM_SPOT, NIFTY_OCT_FUT, NIFTY_WK, NOV, OCT, TCS_NOV_FUT, TCS_OCT_FUT, TCS_SPOT, TEST_ROWS,
  niftyWkPE, octCE, testMaster,
} from './fixtures/master.ts'

const m = testMaster()
const share = (stock: string): LegContract => ({ stock, instrument: 'share', expiry: '', strike: null, optType: null })

test('options and futures match on (stock, expiry, strike, type)', () => {
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE' }), octCE(3500))
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3510, optType: 'CE' }), null)
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'future', expiry: NOV, strike: null, optType: null }), TCS_NOV_FUT)
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'future', expiry: '2027-01-26', strike: null, optType: null }), null)
  assert.equal(matchLeg(m, { stock: 'NIFTY', instrument: 'option', expiry: NIFTY_WK, strike: 25500, optType: 'PE' }), niftyWkPE(25500))
})
test('shares match the NSE cash row by symbol, never by company name', () => {
  assert.equal(matchLeg(m, share('TCS')), TCS_SPOT)
  assert.equal(matchLeg(m, share('BAJFINANCE')), BAJ_SPOT)
  assert.equal(matchLeg(m, share('TATA CONSULTANCY SERV LT')), null)
  assert.equal(matchLeg(m, share('M&M')), MM_SPOT)
})
test('nearestFuture skips expired months and weeklies', () => {
  assert.equal(nearestFuture(m, 'TCS', '2026-10-19')?.instrumentToken, TCS_OCT_FUT)
  assert.equal(nearestFuture(m, 'TCS', '2026-10-28')?.instrumentToken, TCS_NOV_FUT)
  assert.equal(nearestFuture(m, 'NIFTY', '2026-10-19')?.instrumentToken, NIFTY_OCT_FUT) // the 2026-10-20 weekly lists no future
  assert.equal(nearestFuture(m, 'TCS', '2027-01-01'), null)
})
test('spot for stocks and indices; lot size', () => {
  assert.equal(spotTokenOf(m, 'TCS'), TCS_SPOT)
  assert.equal(spotTokenOf(m, 'NIFTY'), 256265)
  assert.equal(spotTokenOf(m, 'NOSUCH'), null)
  assert.equal(lotSizeOf(m, { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'PE' }), 175)
  assert.equal(lotSizeOf(m, { stock: 'TCS', instrument: 'future', expiry: NOV, strike: null, optType: null }), 175)
  assert.equal(lotSizeOf(m, share('TCS')), 1)
  assert.equal(lotSizeOf(m, { stock: 'TCS', instrument: 'option', expiry: '2027-01-26', strike: 3500, optType: 'PE' }), null)
})
test('instrumentRowOf reads documents exactly as loadStoredInstruments does', async () => {
  const docs = TEST_ROWS.map((r) => ({ ...r, _id: String(r.instrument_token) }))
  const theirs = await loadStoredInstruments({ find: () => ({ toArray: async () => docs }) } as never)
  assert.deepEqual(docs.map(instrumentRowOf), theirs)
})
