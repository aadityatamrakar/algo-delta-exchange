/**
 * What Delta would charge to close one open leg now (`dx-close-fee.ts`).
 *
 * The rate is the one THIS ACCOUNT's fills show, not the published one: on
 * 4 Nov every live commission was 0.009 % of notional plus 18 % GST, maker and
 * taker alike, whatever the strike or premium — 10 % under the 0.01 % on
 * Delta's fee page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dxCloseFee } from '../src/dx-close-fee.ts'

const near = (a: number, b: number, tol: number): void =>
  assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`)

test('0.009 % of notional (qty x index) plus 18 % GST, when that is under the premium cap', () => {
  // 0.1 BTC at an index of 80,519: 0.00009 x 0.1 x 80,519 = 0.724671; + 18 %.
  near(dxCloseFee({ qty: 0.1, price: 917, index: 80_519 }), 0.724671 * 1.18, 1e-8)
})

test('a cheap option pays 3.5 % of its premium instead, plus GST', () => {
  // 3.5 % x 0.1 x 100 = 0.35 is under the notional figure (0.7247).
  near(dxCloseFee({ qty: 0.1, price: 100, index: 80_519 }), 0.35 * 1.18, 1e-8)
})

test('it reproduces a real Delta commission: 0.1 BTC of 80000 CE at 19:51 UTC, 4 Nov, charged $0.8496', () => {
  // Index at that minute (Delta's .DEXBTUSD candle) opened at 79,997.3.
  near(dxCloseFee({ qty: 0.1, price: 731.4, index: 79_997.3 }), 0.8496, 0.0005)
})

test('the sign of the quantity does not matter, and float noise lands on the 0.001 grid', () => {
  const short = dxCloseFee({ qty: -0.07, price: 497, index: 80_000 })
  assert.equal(short, dxCloseFee({ qty: 0.07, price: 497, index: 80_000 }))
  assert.equal(dxCloseFee({ qty: 0.1 - 1e-12, price: 917, index: 80_519 }), dxCloseFee({ qty: 0.1, price: 917, index: 80_519 }))
})
