/**
 * Delta's own order book and fills, for the Broker page (`dx-broker-orders.ts`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DxFill, DxOrder } from '@algomaker/dx'
import {
  createDeltaOrdersSnapshot,
  fillRowOf,
  orderRowOf,
  DELTA_ORDERS_ID,
  DELTA_DEMO_ORDERS_ID,
} from '../src/dx-broker-orders.ts'

function sink(): {
  writes: { filter: Record<string, unknown>; set: Record<string, unknown>; options: Record<string, unknown> | undefined }[]
  fail: boolean
  updateOne: (f: Record<string, unknown>, u: Record<string, unknown>, o?: Record<string, unknown>) => Promise<unknown>
} {
  const s = {
    writes: [] as { filter: Record<string, unknown>; set: Record<string, unknown>; options: Record<string, unknown> | undefined }[],
    fail: false,
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
      if (s.fail) throw new Error('mongo down')
      s.writes.push({ filter, set: update['$set'] as Record<string, unknown>, options })
      return { matchedCount: 1 }
    },
  }
  return s
}

const STOP: DxOrder = {
  id: 7001,
  product_id: 55,
  product_symbol: 'C-BTC-80400-061126',
  size: 80,
  unfilled_size: 80,
  side: 'buy',
  order_type: 'limit_order',
  limit_price: '1100',
  stop_order_type: 'stop_loss_order',
  stop_price: '1042',
  state: 'pending',
  reduce_only: true,
  client_order_id: 'bk-abc',
  created_at: '2026-11-04T15:47:14.592163Z',
  updated_at: '2026-11-04T15:47:15.000000Z',
}

const SOLD: DxOrder = {
  id: 6990,
  product_id: 56,
  product_symbol: 'P-BTC-80400-061126',
  size: 80,
  unfilled_size: 0,
  side: 'sell',
  order_type: 'limit_order',
  limit_price: '870',
  average_fill_price: '873',
  state: 'closed',
  created_at: '2026-11-04T15:40:01Z',
}

const FILL: DxFill = {
  id: 'f-1',
  size: '80',
  price: '873',
  side: 'sell',
  role: 'maker',
  fill_type: 'normal',
  commission: '0.0212',
  order_id: '6990',
  product_symbol: 'P-BTC-80400-061126',
  created_at: '2026-11-04T15:40:02.250000Z',
}

test('an order row is in BTC and dollars as numbers, a stop is a stop, and times are epoch ms', () => {
  const r = orderRowOf(STOP, 0.001)
  assert.deepEqual(r, {
    id: '7001',
    symbol: 'C-BTC-80400-061126',
    side: 'buy',
    kind: 'stop',
    state: 'pending',
    qty: 0.08,
    filledQty: 0,
    limitPrice: 1100,
    stopPrice: 1042,
    avgFillPrice: null,
    reduceOnly: true,
    clientOrderId: 'bk-abc',
    cancellationReason: null,
    createdAt: Date.parse('2026-11-04T15:47:14.592Z'),
    updatedAt: Date.parse('2026-11-04T15:47:15Z'),
  })
  const sold = orderRowOf(SOLD, 0.001)
  assert.equal(sold.kind, 'limit')
  assert.equal(sold.filledQty, 0.08)
  assert.equal(sold.avgFillPrice, 873)
  assert.equal(sold.reduceOnly, false)
  assert.equal(sold.updatedAt, null, 'absent is null, never 0')
})

test('an unreadable figure is null, never zero; a market order and a take-profit say so', () => {
  const junk = orderRowOf({ ...SOLD, limit_price: 'abc', average_fill_price: null, order_type: 'market_order', created_at: 'not a date' }, 0.001)
  assert.equal(junk.limitPrice, null)
  assert.equal(junk.avgFillPrice, null)
  assert.equal(junk.kind, 'market')
  assert.equal(junk.createdAt, null)
  assert.equal(orderRowOf({ ...STOP, stop_order_type: 'take_profit_order' }, 0.001).kind, 'take-profit')
})

test('a fill row is in BTC, with its price, fee and role', () => {
  assert.deepEqual(fillRowOf(FILL, 0.001), {
    id: 'f-1',
    orderId: '6990',
    symbol: 'P-BTC-80400-061126',
    side: 'sell',
    qty: 0.08,
    price: 873,
    commission: 0.0212,
    role: 'maker',
    fillType: 'normal',
    at: Date.parse('2026-11-04T15:40:02.250Z'),
  })
  assert.equal(fillRowOf({ id: 'f-2' }, 0.001).qty, null, 'no size is no quantity, not zero')
})

test('one take writes the open book (newest first), the recent history and the fills, upserted under the live id', async () => {
  const col = sink()
  const older = { ...STOP, id: 7000, created_at: '2026-11-04T15:00:00Z' }
  const snap = createDeltaOrdersSnapshot({
    openOrders: async () => [older, STOP],
    recentOrders: async () => [SOLD],
    fills: async () => [FILL],
    collection: col,
    now: () => 1_000,
    host: 'api.india.delta.exchange',
    log: () => {},
  })
  await snap.take()
  assert.equal(col.writes.length, 1)
  const w = col.writes[0]!
  assert.deepEqual(w.filter, { _id: DELTA_ORDERS_ID })
  assert.deepEqual(w.options, { upsert: true })
  assert.equal(w.set['asOf'], 1_000)
  assert.equal(w.set['broker'], 'delta')
  assert.equal(w.set['host'], 'api.india.delta.exchange')
  const open = w.set['open'] as { ok: boolean; error: string; rows: { id: string }[] }
  assert.equal(open.ok, true)
  assert.equal(open.error, '')
  assert.deepEqual(open.rows.map((r) => r.id), ['7001', '7000'])
  assert.deepEqual((w.set['recent'] as { rows: { id: string }[] }).rows.map((r) => r.id), ['6990'])
  assert.deepEqual((w.set['fills'] as { rows: { id: string }[] }).rows.map((r) => r.id), ['f-1'])
})

test('each list fails on its own: a failed read is ok:false with its error and NO rows, the others still land', async () => {
  const col = sink()
  const snap = createDeltaOrdersSnapshot({
    openOrders: async () => {
      throw new Error('GET /v2/orders: 429 rate_limited')
    },
    recentOrders: async () => [SOLD],
    fills: async () => {
      throw new Error('timeout')
    },
    collection: col,
    now: () => 2_000,
    host: 'cdn-ind.testnet.deltaex.org',
    log: () => {},
    id: DELTA_DEMO_ORDERS_ID,
    broker: 'delta-demo',
  })
  await snap.take()
  const w = col.writes[0]!
  assert.deepEqual(w.filter, { _id: DELTA_DEMO_ORDERS_ID })
  assert.equal(w.set['broker'], 'delta-demo')
  assert.deepEqual(w.set['open'], {
    ok: false,
    error: 'Delta testnet open orders failed: GET /v2/orders: 429 rate_limited',
    rows: null,
  })
  assert.equal((w.set['recent'] as { ok: boolean }).ok, true)
  assert.deepEqual(w.set['fills'], { ok: false, error: 'Delta testnet fills failed: timeout', rows: null })
})

test('a failed write never throws, and a take still running is not doubled', async () => {
  const col = sink()
  col.fail = true
  const logs: string[] = []
  let release: () => void = () => {}
  let reads = 0
  const snap = createDeltaOrdersSnapshot({
    openOrders: async () => {
      reads++
      await new Promise<void>((r) => {
        release = r
      })
      return []
    },
    recentOrders: async () => [],
    fills: async () => [],
    collection: col,
    now: () => 3_000,
    host: null,
    log: (m) => logs.push(m),
  })
  const first = snap.take()
  await snap.take()
  assert.equal(reads, 1, 'the second take returned at once')
  release()
  await first
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /orders snapshot write failed/)
})
