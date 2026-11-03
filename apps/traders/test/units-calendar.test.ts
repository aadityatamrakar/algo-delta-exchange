import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PayoffLeg } from '@algomaker/payoff'
import { marketOpenAt, nextOpenDay, nextTradingDay, previousTradingDay } from '../src/analytics/calendar.ts'
import { bookLotGcd } from '../src/analytics/units.ts'

const opt = (qty: number): PayoffLeg => ({ id: `o${qty}`, instrument: 'option', qty, strike: 3000, type: 'CE', expiry: '2026-10-27', entry: 50, iv: 0.2 })
const share = (qty: number): PayoffLeg => ({ id: `s${qty}`, instrument: 'future', qty, strike: null, type: null, expiry: '', entry: 2950, iv: null })

test('lot gcd', () => {
  assert.equal(bookLotGcd([opt(-525), opt(-525)], 175), 3); assert.equal(bookLotGcd([opt(-1225), opt(525)], 175), 1)
  assert.equal(bookLotGcd([share(1000)], 175), 1); assert.equal(bookLotGcd([], 175), 1); assert.equal(bookLotGcd([opt(-525)], null), 1)
})
test('lot gcd: whole-lot shares count, a zero leg does not, a bad lot size is unknown', () => {
  assert.equal(bookLotGcd([opt(-700), share(1050)], 175), 2)
  assert.equal(bookLotGcd([opt(-700), opt(0)], 175), 4); assert.equal(bookLotGcd([opt(0)], 175), 1)
  for (const bad of [0, -175, Number.NaN, Infinity]) assert.equal(bookLotGcd([opt(-525)], bad), 1)
})
test('trading days skip weekends and NSE holidays', () => {
  assert.equal(nextTradingDay('2026-10-19'), '2026-10-21')      // 20 Oct is Dussehra
  assert.equal(nextTradingDay('2026-10-23'), '2026-10-26')
  assert.equal(previousTradingDay('2026-10-19'), '2026-10-16')
})
test('past the 2026 calendar only weekends are skipped', () => {
  assert.equal(nextTradingDay('2026-12-31'), '2027-01-01')
  assert.equal(previousTradingDay('2027-01-04'), '2027-01-01')
})
test('a day that is not a date has no neighbour', () => {
  for (const junk of ['', 'nope', '2026-13-45', '2026-02-30', '19-10-2026']) {
    assert.equal(nextTradingDay(junk), ''); assert.equal(previousTradingDay(junk), '')
  }
})

/** An IST wall-clock time as epoch ms. */
const ist = (day: string, hm: string): number => Date.parse(`${day}T${hm}:00+05:30`)

test('the next open: this morning\'s 09:15 before it on a trading day, else the next trading day\'s (final fix I1)', () => {
  assert.equal(nextOpenDay(ist('2026-10-27', '08:45')), '2026-10-27')      // an expiry morning: its legs are not expired yet
  assert.equal(nextOpenDay(ist('2026-10-27', '00:00')), '2026-10-27')
  assert.equal(nextOpenDay(ist('2026-10-27', '09:14')), '2026-10-27')
  assert.equal(nextOpenDay(ist('2026-10-27', '09:15')), '2026-10-28')      // the open has come
  assert.equal(nextOpenDay(ist('2026-10-27', '16:00')), '2026-10-28')
  assert.equal(nextOpenDay(ist('2026-10-20', '08:45')), '2026-10-21')      // a holiday morning: no open today
  assert.equal(nextOpenDay(ist('2026-10-24', '08:45')), '2026-10-26')      // a Saturday
  assert.equal(nextOpenDay(ist('2026-10-23', '18:00')), '2026-10-26')      // Friday evening
})

test('the market is open 09:15 to before the 15:40 F&O close on an NSE trading day only: a weekday holiday is closed (R3 final fix I1)', () => {
  assert.equal(marketOpenAt(ist('2026-10-19', '11:00')), true)
  assert.equal(marketOpenAt(ist('2026-10-20', '11:00')), false)      // Tuesday, Dussehra
  assert.equal(marketOpenAt(ist('2026-10-24', '11:00')), false)      // a Saturday
  assert.equal(marketOpenAt(ist('2026-10-19', '09:14')), false)
  assert.equal(marketOpenAt(ist('2026-10-19', '09:15')), true)
  assert.equal(marketOpenAt(ist('2026-10-19', '15:30')), true)       // F&O trades to 15:40 since 3 Aug 2026
  assert.equal(marketOpenAt(ist('2026-10-19', '15:39')), true)
  assert.equal(marketOpenAt(ist('2026-10-19', '15:40')), false)
})
