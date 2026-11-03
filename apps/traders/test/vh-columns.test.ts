import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GUESS_LABEL, butterfly, butterfly2, ratio, straddle, type PriceAt } from '../src/analytics/vh-columns.ts'

const table = (rows: Record<number, number>): PriceAt => (k) => rows[k] ?? null
const ce = table({ 80: 21, 90: 14, 100: 8, 110: 3.5, 120: 2 })
const pe = table({ 90: 2.5, 100: 6, 110: 11 })

test('butterfly is p(k-s) - 2p(k) + p(k+s)', () => {
  assert.equal(butterfly(ce, 100, 10), 1.5)
  assert.equal(butterfly(pe, 100, 10), 1.5)
})

test('butterfly2 reaches two steps each way', () => {
  assert.equal(butterfly2(ce, 100, 10), 7)
})

test('ratio is p(k) - 2 p(k+s) for a call and p(k) - 2 p(k-s) for a put', () => {
  assert.equal(ratio(ce, 100, 10, 'CE'), 1)
  assert.equal(ratio(pe, 100, 10, 'PE'), 1)
})

test('straddle adds both sides and needs both', () => {
  assert.equal(straddle(8, 6), 14)
  assert.equal(straddle(8, null), null)
  assert.equal(straddle(null, 6), null)
})

test('a missing wing gives null', () => {
  assert.equal(butterfly(ce, 80, 10), null)
  assert.equal(butterfly2(ce, 90, 10), null)
  assert.equal(ratio(ce, 120, 10, 'CE'), null)
  assert.equal(ratio(pe, 90, 10, 'PE'), null)
})

test('the label says these are guesses', () => {
  assert.match(GUESS_LABEL, /unconfirmed/)
})
