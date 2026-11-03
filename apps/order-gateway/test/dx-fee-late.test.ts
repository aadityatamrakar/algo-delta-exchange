/**
 * THE MISSING FEE ON ONE LEG (13 and 20 Nov, demo rail): each straddle's two
 * fills got Delta's commission on only one leg. The FILLED update reached the
 * gateway before Delta's `/v2/fills` listed that order's fill, the lookup found
 * nothing, and the row went in with no fee — and was never revisited.
 *
 * Now: (1) a filled update waits, bounded, until Delta's fills COVER its
 * quantity before it is recorded; (2) a backfill puts the commission on any
 * Delta fill, order and booked decision that still lacks one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awaitDeltaFee, deltaCommission } from '../src/dx-edge.ts'
import { backfillDeltaFees, type FeeBackfillPorts } from '../src/dx-fee-backfill.ts'

interface U {
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly status: string
  readonly filledQty: number
  readonly avgPrice: number
  readonly fee?: number
}
const update = (over: Partial<U> = {}): U => ({
  brokerOrderId: '77',
  clientOrderId: 'd1#1',
  status: 'FILLED',
  filledQty: 0.05,
  avgPrice: 300,
  ...over,
})

test('a partial listing is not the order\'s fee: commission counts only once the fills cover the quantity', async () => {
  const rest = { fills: async () => ({ fills: [{ order_id: '77', commission: '0.1', size: 20 }] }) }
  assert.equal(await deltaCommission(rest, '77', 50), null, '20 of 50 contracts listed')
  assert.equal(await deltaCommission(rest, '77', 20), 0.1)
  assert.equal(await deltaCommission(rest, '77'), 0.1, 'no quantity asked: as before')
})

test('a FILLED update waits for Delta to list its fill, then carries the commission', async () => {
  let calls = 0
  const rest = {
    fills: async () => {
      calls++
      return calls < 3 ? { fills: [] } : { fills: [{ order_id: '77', commission: '0.164', size: '50' }] }
    },
  }
  const slept: number[] = []
  const out = await awaitDeltaFee({ rest, step: 0.001, sleep: async (ms) => void slept.push(ms) }, update())
  assert.equal(out.fee, 0.164)
  assert.equal(calls, 3)
  assert.deepEqual(slept, [0, 500, 1000].slice(0, 3))
})

test('the wait is bounded: no listing, no fee — never a guess; a fee already on the update is kept', async () => {
  const rest = { fills: async () => ({ fills: [] }) }
  const out = await awaitDeltaFee({ rest, step: 0.001, sleep: async () => {} }, update())
  assert.equal('fee' in out, false)
  let asked = false
  const kept = await awaitDeltaFee(
    { rest: { fills: async () => { asked = true; return { fills: [] } } }, step: 0.001, sleep: async () => {} },
    update({ fee: 0.2 }),
  )
  assert.equal(kept.fee, 0.2)
  assert.equal(asked, false)
  const working = await awaitDeltaFee({ rest, step: 0.001, sleep: async () => {} }, update({ status: 'WORKING', filledQty: 0 }))
  assert.equal('fee' in working, false)
})

test('the backfill puts the commission on the fill row, the order and the folded decision — once', async () => {
  const order: Record<string, unknown> = {
    clientOrderId: 'd1#1', state: 'FILLED', mode: 'paper', dx_paper_rail: 'demo', tradingsymbol: 'C-BTC-77000-131126',
    filledQty: 0.05, brokerOrderIds: ['77'], resolvedAt: 1_000,
  }
  const fills: Record<string, unknown>[] = [
    { baseClientOrderId: 'd1#1', brokerOrderId: '77', status: 'FILLED', filledQty: 0.05, avgPrice: 300, ts: 900 },
  ]
  const decision: { decisionId: string; foldedOrders: string[]; fills: Record<string, unknown>[] } = {
    decisionId: 'd1',
    foldedOrders: ['d1#0', 'd1#1'],
    fills: [
      { tradingsymbol: 'P-BTC-77000-131126', qty: 0.05, price: 290, fee: 0.164 },
      { tradingsymbol: 'C-BTC-77000-131126', qty: 0.05, price: 300 },
    ],
  }
  const said: string[] = []
  const ports: FeeBackfillPorts = {
    pendingOrders: async () => (order['fee'] === undefined ? [order] : []),
    restFor: (o) => (o['dx_paper_rail'] === 'demo' ? { fills: async () => ({ fills: [{ order_id: '77', commission: '0.171', size: 50 }] }) } : null),
    setOrderFee: async (_id, fee) => void (order['fee'] = fee),
    setFillFee: async (_base, brokerOrderId, fee) => {
      for (const f of fills) if (f['brokerOrderId'] === brokerOrderId && f['fee'] === undefined) f['fee'] = fee
    },
    decisionFor: async () => decision,
    setDecisionFillFee: async (_id, index, fee) => void (decision.fills[index]!['fee'] = fee),
    log: (m) => void said.push(m),
  }
  const r = await backfillDeltaFees(ports)
  assert.deepEqual(r, { orders: 1, filled: 1 })
  assert.equal(order['fee'], 0.171)
  assert.equal(fills[0]?.['fee'], 0.171)
  assert.equal(decision.fills[1]?.['fee'], 0.171, 'the leg that lacked it')
  assert.equal(decision.fills[0]?.['fee'], 0.164, 'the other leg untouched')
  assert.deepEqual(await backfillDeltaFees(ports), { orders: 0, filled: 0 }, 'nothing left to do')
})

test('the backfill leaves an order alone while Delta has not listed all of it', async () => {
  const order: Record<string, unknown> = { clientOrderId: 'd2#0', state: 'FILLED', mode: 'live', filledQty: 0.05, brokerOrderIds: ['88'] }
  let set = false
  const r = await backfillDeltaFees({
    pendingOrders: async () => [order],
    restFor: () => ({ fills: async () => ({ fills: [{ order_id: '88', commission: '0.05', size: 10 }] }) }),
    setOrderFee: async () => void (set = true),
    setFillFee: async () => void (set = true),
    decisionFor: async () => null,
    setDecisionFillFee: async () => void (set = true),
    log: () => {},
  })
  assert.deepEqual(r, { orders: 1, filled: 0 })
  assert.equal(set, false)
})
