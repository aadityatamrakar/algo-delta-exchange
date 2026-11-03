import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optionFee } from '../src/index.ts'

test('fee is the premium cap when 3.5% of premium is below 0.01% of notional', () => {
  // notional 100 × 0.001 × 76592 = 7659.2 → 0.01% = 0.76592; premium cap 3.5% × 100 × 0.001 × 212 = 0.742
  const f = optionFee({ contracts: 100, index: 76592, premium: 212 })
  assert.equal(f.fee, 0.742)
  assert.equal(f.gst, 0.13356)
  assert.equal(f.total, 0.87556)
})

test('fee is 0.01% of notional when the premium is rich', () => {
  // help-page example: 0.3 BTC (300 contracts) at premium 150, index 90000 → min(2.70, 1.575)
  assert.equal(optionFee({ contracts: 300, index: 90000, premium: 150 }).fee, 1.575)
  // ATM 76600 straddle leg: min(0.0001 × 0.1 × 76592, 0.035 × 0.1 × 804.6)
  assert.equal(optionFee({ contracts: 100, index: 76592, premium: 804.6 }).fee, 0.76592)
})

test('zero contracts cost nothing; bad inputs throw instead of returning a fee', () => {
  assert.deepEqual(optionFee({ contracts: 0, index: 76592, premium: 212 }), { fee: 0, gst: 0, total: 0 })
  assert.throws(() => optionFee({ contracts: 1.5, index: 76592, premium: 212 }), RangeError)
  assert.throws(() => optionFee({ contracts: -1, index: 76592, premium: 212 }), RangeError)
  assert.throws(() => optionFee({ contracts: 1, index: Number.NaN, premium: 212 }), RangeError)
})
