// G6 (spec 2026-10-23): one F&O expiry instant, 15:40 IST, everywhere a contract is valued. Core's `FNO_CLOSE_MIN`
// is the source; greeks and payoff sit below core in the dependency graph and repeat the literal, so this pins them.
// The NSE decision clock stays 15:30 on purpose and is pinned here too, so a change to either is deliberate.
// (Moved from apps/traders/test/fno-close.test.ts when the traders desk was removed, 3 Nov 2026.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FNO_CLOSE_MIN, MARKET_CLOSE_MIN } from '@algomaker/core'
import { DECISION_CLOCK_CLOSE_MIN, DECISIONS_END_MIN } from '@algomaker/desk-engine'
import { yearsToExpiry } from '@algomaker/greeks'
import { valuationAt } from '../src/index.ts'

const DAY = '2026-10-27'
/** `minute` IST on DAY, epoch ms. */
const at = (minute: number): number => Date.parse(`${DAY}T00:00:00+05:30`) + minute * 60_000

test('15:40 is the F&O close in core', () => {
  assert.equal(FNO_CLOSE_MIN, 15 * 60 + 40)
})

test('the greeks price an expiring contract to 15:40, and not a minute past', () => {
  assert.ok(yearsToExpiry(DAY, at(FNO_CLOSE_MIN - 1)) > 0)
  assert.equal(yearsToExpiry(DAY, at(FNO_CLOSE_MIN)), 0)
  // Ten minutes more life than the 15:30 instant gave it.
  assert.ok(Math.abs(yearsToExpiry(DAY, at(MARKET_CLOSE_MIN)) * 365 * 1440 - 10) < 1e-6)
})

test("payoff's Expiry column values at the same instant", () => {
  assert.equal(valuationAt(DAY, at(600), 'close')!.ms, at(FNO_CLOSE_MIN))
})

test('the NSE desk still stops deciding at 15:30, with the strategies', () => {
  assert.equal(DECISIONS_END_MIN, MARKET_CLOSE_MIN)
  assert.equal(DECISION_CLOCK_CLOSE_MIN, MARKET_CLOSE_MIN)
})
