/**
 * The Delta Broker page's data (`dx-broker.ts`): what Delta holds on one
 * account — positions, the order book, fills, margin — as the gateway read it.
 * Pure, plus the route over a fake db: no Mongo, no HTTP.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dxBrokerView, DX_BROKER_STALE_MS, handleDxBroker } from '../src/dx-broker.ts'

const NOW = Date.parse('2026-11-04T18:05:00Z')

const positionsDoc = {
  _id: 'delta',
  asOf: NOW - 10_000,
  ok: true,
  error: '',
  broker: 'delta',
  host: 'api.india.delta.exchange',
  symbolSpace: 'desk',
  positions: [
    { tradingsymbol: 'C-BTC-80400-061126', netQty: -0.08, avgPrice: 833.6 },
    { tradingsymbol: 'P-BTC-80400-061126', netQty: -0.08, avgPrice: 873 },
  ],
}

const stopRow = {
  id: '7001', symbol: 'C-BTC-80400-061126', side: 'buy', kind: 'stop', state: 'pending', qty: 0.08, filledQty: 0,
  limitPrice: 1100, stopPrice: 1042, avgFillPrice: null, reduceOnly: true, clientOrderId: null, cancellationReason: null,
  createdAt: NOW - 60_000, updatedAt: null,
}
const fillRow = {
  id: 'f-1', orderId: '6990', symbol: 'P-BTC-80400-061126', side: 'sell', qty: 0.08, price: 873, commission: 0.02,
  role: 'maker', fillType: 'normal', at: NOW - 120_000,
}
const ordersDoc = {
  _id: 'delta',
  asOf: NOW - 5_000,
  broker: 'delta',
  host: 'api.india.delta.exchange',
  open: { ok: true, error: '', rows: [stopRow] },
  recent: { ok: true, error: '', rows: [] },
  fills: { ok: true, error: '', rows: [fillRow] },
}
const marginDoc = {
  _id: 'delta', asOf: NOW - 4_000, ok: true, error: '', rail: 'live', balance: 1289.7, available: 503.32,
  positionMargin: 0, orderMargin: 0, portfolioMargin: 786.38, used: 786.38, utilizedPct: 60.97,
}

test('the live account: positions in desk spelling, the open book, fills and the live margin row, each with its age', () => {
  const v = dxBrokerView({ rail: 'live', positionsDoc, ordersDoc, marginDocs: [marginDoc], nowMs: NOW })
  assert.equal(v.rail, 'live')
  assert.equal(v.label, 'Live')
  assert.equal(v.host, 'api.india.delta.exchange')
  assert.equal(v.inrPerUsd, 85)
  assert.equal(v.positions.state, 'ok')
  assert.equal(v.positions.ageMs, 10_000)
  assert.deepEqual(v.positions.rows, [
    { symbol: 'C-BTC-80400-061126', netQty: -0.08, avgPrice: 833.6 },
    { symbol: 'P-BTC-80400-061126', netQty: -0.08, avgPrice: 873 },
  ])
  assert.equal(v.openOrders.state, 'ok')
  assert.equal(v.openOrders.ageMs, 5_000)
  assert.deepEqual(v.openOrders.rows, [stopRow])
  assert.equal(v.recentOrders.state, 'ok')
  assert.deepEqual(v.recentOrders.rows, [])
  assert.deepEqual(v.fills.rows, [fillRow])
  assert.equal(v.margin.id, 'delta')
  assert.equal(v.margin.state, 'ok')
  assert.equal(v.margin.available, 503.32)
  assert.equal(v.margin.used, 786.38)
})

test('nothing written is absent with a reason — never an empty list that reads as "nothing held"', () => {
  const v = dxBrokerView({ rail: 'demo', positionsDoc: null, ordersDoc: null, marginDocs: [], nowMs: NOW })
  assert.equal(v.label, 'Demo')
  assert.equal(v.host, null)
  for (const s of [v.positions, v.openOrders, v.recentOrders, v.fills]) {
    assert.equal(s.state, 'absent')
    assert.deepEqual(s.rows, [])
    assert.match(s.reason, /not written|gateway/)
  }
  assert.equal(v.margin.id, 'delta-demo')
  assert.equal(v.margin.state, 'absent')
})

test('a failed read is failed with its error and no rows; an old read is stale and keeps its rows', () => {
  const failedPositions = { ...positionsDoc, ok: false, error: 'Delta /v2/positions failed: timeout', positions: null }
  const failedOpen = { ...ordersDoc, open: { ok: false, error: 'Delta open orders failed: 429', rows: null } }
  const v = dxBrokerView({ rail: 'live', positionsDoc: failedPositions, ordersDoc: failedOpen, marginDocs: [], nowMs: NOW })
  assert.equal(v.positions.state, 'failed')
  assert.equal(v.positions.error, 'Delta /v2/positions failed: timeout')
  assert.deepEqual(v.positions.rows, [])
  assert.equal(v.openOrders.state, 'failed')
  assert.equal(v.openOrders.error, 'Delta open orders failed: 429')
  assert.equal(v.fills.state, 'ok', 'one list failing leaves the others as they are')

  const old = NOW - DX_BROKER_STALE_MS - 1
  const s = dxBrokerView({
    rail: 'live',
    positionsDoc: { ...positionsDoc, asOf: old },
    ordersDoc: { ...ordersDoc, asOf: old },
    marginDocs: [],
    nowMs: NOW,
  })
  assert.equal(s.positions.state, 'stale')
  assert.equal(s.positions.rows.length, 2)
  assert.equal(s.openOrders.state, 'stale')
  assert.equal(s.fills.state, 'stale')
})

test('a row the API cannot read is dropped from the figures as null, never zero', () => {
  const junk = { ...positionsDoc, positions: [{ tradingsymbol: 'C-BTC-1-061126', netQty: 'x', avgPrice: null }, 'garbage'] }
  const v = dxBrokerView({ rail: 'live', positionsDoc: junk, ordersDoc: null, marginDocs: [], nowMs: NOW })
  assert.deepEqual(v.positions.rows, [{ symbol: 'C-BTC-1-061126', netQty: null, avgPrice: null }])
})

// ------------------------------------------------------------------ route

function fakeDb(docs: Record<string, Record<string, unknown>[]>): { db: unknown; reads: string[] } {
  const reads: string[] = []
  const db = {
    collection: (name: string) => ({
      findOne: async (f: { _id: string }) => {
        reads.push(`${name}:${f._id}`)
        return (docs[name] ?? []).find((d) => d['_id'] === f._id) ?? null
      },
      find: () => ({ toArray: async () => docs[name] ?? [] }),
    }),
  }
  return { db, reads }
}

function ctxFor(query: string): { ctx: never; sent: { status: number; body: unknown }[] } {
  const sent: { status: number; body: unknown }[] = []
  const ctx = {
    url: new URL(`http://x/v1/desk/broker/delta${query}`),
    send: (status: number, body: unknown) => sent.push({ status, body }),
  }
  return { ctx: ctx as never, sent }
}

test('the route reads the demo account under its own ids, and refuses a rail it does not know', async () => {
  const { db, reads } = fakeDb({
    'desk-broker-snapshot': [{ ...positionsDoc, _id: 'delta-demo' }],
    'desk-broker-orders': [],
    'desk-broker-margin': [{ ...marginDoc, _id: 'delta-demo', rail: 'demo' }],
  })
  const deps = { db, now: () => NOW } as never
  const ok = ctxFor('?rail=demo')
  assert.equal(await handleDxBroker(deps, ok.ctx), true)
  assert.equal(ok.sent[0]?.status, 200)
  assert.deepEqual(reads.sort(), ['desk-broker-orders:delta-demo', 'desk-broker-snapshot:delta-demo'])
  const body = ok.sent[0]?.body as { rail: string; positions: { state: string }; openOrders: { state: string }; margin: { state: string } }
  assert.equal(body.rail, 'demo')
  assert.equal(body.positions.state, 'ok')
  assert.equal(body.openOrders.state, 'absent')
  assert.equal(body.margin.state, 'ok')

  for (const q of ['', '?rail=paper', '?rail=LIVE']) {
    const bad = ctxFor(q)
    await handleDxBroker(deps, bad.ctx)
    assert.equal(bad.sent[0]?.status, 400, q)
  }
})
