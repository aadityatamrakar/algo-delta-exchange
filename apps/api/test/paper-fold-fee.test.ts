/**
 * THE VENUE FEE RIDES THE FOLDED FILL. MONGO-FREE: the fee read is pure.
 *
 * The gateway writes what the venue charged (Delta: the simulator's
 * `optionFee` at the touch, or the exchange's reported commission) on its
 * order document. The fold books it onto the desk fill, so realised P&L is
 * net of it; an NSE document carries none, and its fill grows no key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldedFee } from '../src/paper-fold.ts'

test('a document total fee is booked whole when the whole report is booked', () => {
  assert.equal(foldedFee({ fee: 0.742 }, 0.1, 0.1), 0.742)
})

test('per-fill fees are summed when the document carries no total', () => {
  const doc = { fills: [{ qty: 0.05, price: 212, fee: 0.4 }, { qty: 0.05, price: 211, fee: 0.35 }] }
  assert.equal(foldedFee(doc, 0.1, 0.1), 0.75)
})

test('a capped fold books the fee pro rata — the desk never pays for what it did not book', () => {
  assert.equal(foldedFee({ fee: 0.9 }, 0.1, 0.15), 0.6)
})

test('no fee anywhere is undefined, not zero — the NSE fill stays as it was', () => {
  assert.equal(foldedFee({ filledQty: 75, avgPrice: 120 }, 75, 75), undefined)
  assert.equal(foldedFee({ fee: 'x' }, 1, 1), undefined)
  assert.equal(foldedFee({ fee: -1 }, 1, 1), undefined)
})

test('a refused order\'s reason becomes a decision skip; a full fill or a silent one adds none', async () => {
  const { refusalOf } = await import('../src/paper-fold.ts')
  const doc = { tradingsymbol: 'C-BTC-77200-041126', state: 'REJECTED', reason: 'oi-cap: 77200 CE open interest at the cap' }
  assert.deepEqual(refusalOf(doc, 0, 0.005), { instrument: 'C-BTC-77200-041126', reason: 'oi-cap: 77200 CE open interest at the cap' })
  assert.deepEqual(refusalOf({ ...doc, state: 'PARTIAL' }, 0.002, 0.005)?.reason, 'oi-cap: 77200 CE open interest at the cap')
  assert.equal(refusalOf(doc, 0.005, 0.005), undefined)
  assert.equal(refusalOf({ tradingsymbol: 'x', state: 'REJECTED' }, 0, 0.005), undefined)
})
