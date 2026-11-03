/**
 * Fill sums on Delta's 0.001 grid are cleaned onto the step, so a filled order
 * is FILLED — not one float ulp short and working forever. DESK_VENUE is read
 * at import, so it is set before the module loads (node:test runs each file in
 * its own process).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env['DESK_VENUE'] = 'dx'
const { aggregateTranches, decideOrderOutcome, trancheQtyThrough } = await import('../src/gateway.ts')

const row = (clientOrderId: string, filledQty: number, avgPrice = 212) => ({
  clientOrderId,
  baseClientOrderId: 'c',
  brokerOrderId: `b-${clientOrderId}`,
  tradingsymbol: 'C-BTC-76600-041126',
  status: 'FILLED',
  filledQty,
  avgPrice,
  ts: 1,
  tag: 'BS',
  mode: 'paper' as const,
})

test('three 1-contract fills of 0.001 complete a 0.003 order', () => {
  const agg = aggregateTranches([row('c.1', 0.001), row('c.2', 0.001), row('c.3', 0.001)], 0.003, {
    ids: ['c.1', 'c.2', 'c.3'],
    failed: [],
  })
  assert.equal(agg.filledQty, 0.003)
  assert.equal(agg.complete, true)
  assert.deepEqual(decideOrderOutcome(agg, 0.003)?.state, 'FILLED')
})

test('a sum that drifts BELOW the order in raw floats (0.7 + 0.1) still completes 0.8', () => {
  assert.ok(0.7 + 0.1 < 0.8, 'the raw float sum really is short')
  const agg = aggregateTranches([row('c.1', 0.7), row('c.2', 0.1)], 0.8, { ids: ['c.1', 'c.2'], failed: [] })
  assert.equal(agg.filledQty, 0.8)
  assert.equal(agg.complete, true)
  assert.equal(decideOrderOutcome(agg, 0.8)?.state, 'FILLED')
})

test('a sum that drifts ABOVE is recorded clean (0.051 + 0.049 + 0.05 = 0.15)', () => {
  const agg = aggregateTranches([row('a', 0.051), row('b', 0.049), row('c', 0.05)], 0.15)
  assert.equal(agg.filledQty, 0.15)
})

test('a tranche plan sums onto the step too', () => {
  assert.equal(trancheQtyThrough([{ qty: 0.7 }, { qty: 0.1 }], 1), 0.8)
})

test('the order\'s fee is the sum of each tranche\'s furthest row, and rides the outcome', () => {
  // Fee is CUMULATIVE per tranche like filledQty: the PARTIAL row's 0.1 is
  // superseded by the FILLED row's 0.2, never added to it.
  const agg = aggregateTranches(
    [
      { ...row('c.1', 0.025), status: 'PARTIALLY_FILLED', fee: 0.1 },
      { ...row('c.1', 0.05), fee: 0.2 },
      { ...row('c.2', 0.05), fee: 0.21 },
    ],
    0.1,
    { ids: ['c.1', 'c.2'], failed: [] },
  )
  assert.equal(agg.fee, 0.41)
  assert.equal(decideOrderOutcome(agg, 0.1)?.fee, 0.41)
})

test('no tranche row carries a fee: the order has none — absent, not 0', () => {
  const agg = aggregateTranches([row('c.1', 0.05)], 0.05, { ids: ['c.1'], failed: [] })
  assert.equal(agg.fee, null)
  const out = decideOrderOutcome(agg, 0.05)
  assert.equal(out !== null && 'fee' in out, false)
})
