/** The fee backfill's Mongo ports against a real Mongo: the queries select and set what they say. */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { connectMongo, type MongoHandle } from '../../api/src/mongo.ts'
import { backfillDeltaFees, mongoFeeBackfillPorts } from '../src/dx-fee-backfill.ts'

const URL_MONGO = process.env['DESK_TEST_MONGO_GW_FEE'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_gw_fee_test'
const NOW = Date.parse('2026-11-13T12:30:00Z')
let handle: MongoHandle | null = null

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO)
  } catch {
    handle = null
  }
})
after(async () => {
  await handle?.close()
})
beforeEach(async () => {
  if (handle === null) return
  for (const c of ['desk-gateway-orders', 'desk-fills', 'desk-decisions']) await handle.db.collection(c).deleteMany({})
})

test('a demo straddle leg booked feeless gets Delta\'s commission on order, fill row and decision', async (t) => {
  if (handle === null) return skipUnlessMongo(t)
  const db = handle.db
  await db.collection('desk-gateway-orders').insertMany([
    // The leg that missed its fee (13 Nov) …
    { clientOrderId: 'dA#1', state: 'FILLED', mode: 'paper', dx_paper_rail: 'demo', tradingsymbol: 'C-BTC-77000-131126', filledQty: 0.05, brokerOrderIds: ['901'], resolvedAt: NOW - 60_000 },
    // … the leg that has one, a simulator order, and an old one: none touched.
    { clientOrderId: 'dA#0', state: 'FILLED', mode: 'paper', dx_paper_rail: 'demo', tradingsymbol: 'P-BTC-77000-131126', filledQty: 0.05, brokerOrderIds: ['900'], resolvedAt: NOW - 60_000, fee: 0.164 },
    { clientOrderId: 'dS#0', state: 'FILLED', mode: 'paper', tradingsymbol: 'C-BTC-77000-131126', filledQty: 0.05, brokerOrderIds: ['sim-1'], resolvedAt: NOW - 60_000 },
    { clientOrderId: 'dO#0', state: 'FILLED', mode: 'live', tradingsymbol: 'C-BTC-77000-131126', filledQty: 0.05, brokerOrderIds: ['5'], resolvedAt: NOW - 3 * 86_400_000 },
  ])
  await db.collection('desk-fills').insertMany([
    { baseClientOrderId: 'dA#1', clientOrderId: 'dA#1', brokerOrderId: '901', status: 'WORKING', filledQty: 0, ts: 1 },
    { baseClientOrderId: 'dA#1', clientOrderId: 'dA#1', brokerOrderId: '901', status: 'FILLED', filledQty: 0.05, ts: 2 },
  ])
  await db.collection('desk-decisions').insertOne({
    decisionId: 'dA', mode: 'paper', foldedOrders: ['dA#0', 'dA#1'],
    fills: [
      { op: 'open', tradingsymbol: 'P-BTC-77000-131126', side: 'Sell', qty: 0.05, price: 290, fee: 0.164 },
      { op: 'open', tradingsymbol: 'C-BTC-77000-131126', side: 'Sell', qty: 0.05, price: 300 },
    ],
  })
  const asked: string[] = []
  const ports = mongoFeeBackfillPorts({
    orders: db.collection('desk-gateway-orders') as never,
    fills: db.collection('desk-fills') as never,
    decisions: db.collection('desk-decisions') as never,
    restFor: (o) => {
      asked.push(String(o['clientOrderId']))
      return { fills: async () => ({ fills: [{ order_id: '901', commission: '0.171', size: '50' }] }) }
    },
    now: () => NOW,
    log: () => {},
  })
  assert.deepEqual(await backfillDeltaFees(ports), { orders: 1, filled: 1 })
  assert.deepEqual(asked, ['dA#1'], 'only the feeless, recent, Delta-rail order is asked')
  const order = await db.collection('desk-gateway-orders').findOne({ clientOrderId: 'dA#1' })
  assert.equal(order?.['fee'], 0.171)
  const rows = await db.collection('desk-fills').find({ baseClientOrderId: 'dA#1' }).sort({ ts: 1 }).toArray()
  assert.deepEqual(rows.map((r) => r['fee']), [undefined, 0.171], 'the traded row only')
  const d = await db.collection('desk-decisions').findOne({ decisionId: 'dA' })
  assert.deepEqual((d?.['fills'] as Record<string, unknown>[]).map((f) => f['fee']), [0.164, 0.171])
  assert.deepEqual(await backfillDeltaFees(ports), { orders: 0, filled: 0 })
})
