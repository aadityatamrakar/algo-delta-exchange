/**
 * `pb_min_dte` IS COUNTED IN SESSIONS — pinned on the real October 2026 board.
 *
 * The month the playbooks ship in has both of the cases calendar days get
 * wrong: weekends (a Friday's Monday weekly is one session, not three) and a
 * holiday mid-week (Dussehra on Tuesday 20 Oct moved NIFTY's expiry to Monday
 * the 19th, and takes a session out of every contract that spans it).
 *
 *   NIFTY expiries   2026-10-19 (Mon), 2026-10-27 (Tue)
 *   SENSEX expiries  2026-10-22 (Thu), 2026-10-29 (Thu)
 *   holidays         2026-10-02 (Fri, Gandhi Jayanti), 2026-10-20 (Tue, Dussehra)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tradingDaysToExpiry } from '@algomaker/desk-engine'

test('today`s contract is 0, and today itself never counts', () => {
  assert.equal(tradingDaysToExpiry('2026-10-16', '2026-10-16'), 0)
  assert.equal(tradingDaysToExpiry('2026-10-19', '2026-10-19'), 0)
})

test('a Friday`s Monday weekly is ONE session, not three calendar days', () => {
  assert.equal(tradingDaysToExpiry('2026-10-16', '2026-10-19'), 1)
  // and from the weekend in between, the same one session
  assert.equal(tradingDaysToExpiry('2026-10-17', '2026-10-19'), 1)
  assert.equal(tradingDaysToExpiry('2026-10-18', '2026-10-19'), 1)
})

test('a holiday is not a session: Dussehra takes one out of every contract across it', () => {
  // Fri 16th to Thu 22nd: Mon 19, (Tue 20 Dussehra), Wed 21, Thu 22.
  assert.equal(tradingDaysToExpiry('2026-10-16', '2026-10-22'), 3)
  // Fri 16th to Tue 27th: 19, 21, 22, 23, 26, 27.
  assert.equal(tradingDaysToExpiry('2026-10-16', '2026-10-27'), 6)
  // Mon 19th to Tue 27th: 21, 22, 23, 26, 27.
  assert.equal(tradingDaysToExpiry('2026-10-19', '2026-10-27'), 5)
  // Thu 1st to Tue 6th: (Fri 2 Gandhi Jayanti), Mon 5, Tue 6.
  assert.equal(tradingDaysToExpiry('2026-10-01', '2026-10-06'), 2)
})

test('the presets` minimums, read on the ship date', () => {
  // Friday 16 Oct. Intraday books need 1 session: NIFTY's Monday weekly
  // qualifies. Wing Straddle needs 5: the 22nd's SENSEX weekly (3) does not,
  // NIFTY's 27th (6) does.
  assert.ok(tradingDaysToExpiry('2026-10-16', '2026-10-19') >= 1)
  assert.ok(tradingDaysToExpiry('2026-10-16', '2026-10-22') < 5)
  assert.ok(tradingDaysToExpiry('2026-10-16', '2026-10-27') >= 5)
})

test('-1 for a contract that is not live: expired, unreadable, or absurdly far', () => {
  // -1 and not 0: 0 is "expires today", which an expiry preset trades, and a
  // dead or unreadable contract must fail every gate — `>= 0` included.
  assert.equal(tradingDaysToExpiry('2026-10-16', '2026-10-15'), -1, 'expired yesterday')
  assert.equal(tradingDaysToExpiry('2026-10-16', ''), -1)
  assert.equal(tradingDaysToExpiry('', '2026-10-19'), -1)
  assert.equal(tradingDaysToExpiry('2026-10-16', 'soon'), -1)
  assert.equal(tradingDaysToExpiry('2026-02-31', '2026-03-03'), -1, 'no 31 February')
  assert.equal(tradingDaysToExpiry('2026-10-16', '2046-10-16'), -1, 'twenty years is a typo')
  // A long-dated contract inside the horizon is still counted.
  assert.ok(tradingDaysToExpiry('2026-10-16', '2031-10-16') > 1_000)
})
