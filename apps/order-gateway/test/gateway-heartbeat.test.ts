/**
 * The gateway's Status heartbeat and the Delta positions snapshot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDeltaPositionsSnapshot,
  createGatewayHeartbeat,
  DELTA_DEMO_SNAPSHOT_ID,
  DELTA_SNAPSHOT_ID,
  GATEWAY_HEARTBEAT_ID,
  hostOf,
} from '../src/gateway-heartbeat.ts'

function sink(): { writes: { filter: Record<string, unknown>; set: Record<string, unknown> }[]; fail: boolean; updateOne: (f: Record<string, unknown>, u: Record<string, unknown>) => Promise<unknown> } {
  const s = {
    writes: [] as { filter: Record<string, unknown>; set: Record<string, unknown> }[],
    fail: false,
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown> {
      if (s.fail) throw new Error('mongo down')
      s.writes.push({ filter, set: update['$set'] as Record<string, unknown> })
      return { matchedCount: 1 }
    },
  }
  return s
}

function events(rows: Record<string, unknown>[]): never {
  return {
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => rows }) }) }),
  } as never
}

test('a beat writes the broker mode, host and the newest real order event', async () => {
  const col = sink()
  const hb = createGatewayHeartbeat({
    collection: col,
    events: events([{ ts: 900, phase: 'INVALID' }, { ts: 500, phase: 'PLACED' }, { ts: 700, phase: 'FILLED' }]),
    now: () => 1_000,
    startedAt: 10,
    pid: 42,
    broker: 'delta',
    host: 'api.india.delta.exchange',
    deltaHeartbeatOk: () => true,
    log: () => {},
  })
  await hb.beat()
  assert.equal(col.writes.length, 1)
  assert.deepEqual(col.writes[0]?.filter, { _id: GATEWAY_HEARTBEAT_ID })
  const doc = col.writes[0]?.set
  assert.equal(doc?.['at'], 1_000)
  assert.equal(doc?.['broker'], 'delta')
  assert.equal(doc?.['host'], 'api.india.delta.exchange')
  // A desk-api INVALID refusal is not the gateway's own trace.
  assert.equal(doc?.['lastOrderAt'], 700)
  assert.equal(doc?.['deltaHeartbeatOk'], true)
})

test('simulate mode beats too, with no host and no Delta heartbeat; a failed write never throws', async () => {
  const col = sink()
  const lines: string[] = []
  const hb = createGatewayHeartbeat({
    collection: col,
    events: events([]),
    now: () => 5,
    startedAt: 1,
    pid: 1,
    broker: 'simulate',
    host: null,
    deltaHeartbeatOk: () => null,
    log: (m) => lines.push(m),
  })
  await hb.beat()
  assert.equal(col.writes[0]?.set['broker'], 'simulate')
  assert.equal(col.writes[0]?.set['lastOrderAt'], null)
  assert.equal(col.writes[0]?.set['deltaHeartbeatOk'], null)
  col.fail = true
  await hb.beat()
  await hb.beat()
  assert.equal(lines.filter((l) => /FAILED/.test(l)).length, 1, 'said once, not every beat')
})

test('the Delta snapshot carries desk-spelled positions, and a failed read carries none', async () => {
  const col = sink()
  let fail = false
  const snap = createDeltaPositionsSnapshot({
    positions: async () => {
      if (fail) throw new Error('401 unauthorized')
      return [{ tradingsymbol: 'C-BTC-80000-041126', netQty: -0.05, avgPrice: 120 }]
    },
    collection: col,
    now: () => 77,
    host: 'api.india.delta.exchange',
    log: () => {},
  })
  await snap.take()
  assert.deepEqual(col.writes[0]?.filter, { _id: DELTA_SNAPSHOT_ID })
  const ok = col.writes[0]?.set
  assert.equal(ok?.['ok'], true)
  assert.equal(ok?.['symbolSpace'], 'desk')
  assert.deepEqual(ok?.['positions'], [{ tradingsymbol: 'C-BTC-80000-041126', netQty: -0.05, avgPrice: 120 }])
  assert.deepEqual(ok?.['emptyDiagnostic'], { positions: 'array(1)' })

  fail = true
  await snap.take()
  const bad = col.writes[1]?.set
  assert.equal(bad?.['ok'], false)
  assert.equal(bad?.['positions'], null)
  assert.match(String(bad?.['error']), /401 unauthorized/)
})

test('hostOf names the host, and passes through what does not parse', () => {
  assert.equal(hostOf('https://cdn-ind.testnet.deltaex.org'), 'cdn-ind.testnet.deltaex.org')
  assert.equal(hostOf(null), null)
  assert.equal(hostOf('not a url'), 'not a url')
})

test('the demo account is written under its own id, and the heartbeat says whether the demo rail is up', async () => {
  const col = sink()
  const snap = createDeltaPositionsSnapshot({
    positions: async () => {
      throw new Error('testnet down')
    },
    collection: col,
    now: () => 9,
    host: 'cdn-ind.testnet.deltaex.org',
    log: () => {},
    id: DELTA_DEMO_SNAPSHOT_ID,
    broker: 'delta-demo',
  })
  await snap.take()
  assert.deepEqual(col.writes[0]?.filter, { _id: 'delta-demo' })
  assert.equal(col.writes[0]?.set['broker'], 'delta-demo')
  assert.match(String(col.writes[0]?.set['error']), /^Delta testnet \/v2\/positions failed: testnet down/)

  const hbCol = sink()
  const hb = createGatewayHeartbeat({
    collection: hbCol,
    events: events([]),
    now: () => 1,
    startedAt: 1,
    pid: 1,
    broker: 'simulate',
    host: null,
    deltaHeartbeatOk: () => null,
    demoReady: () => true,
    log: () => {},
  })
  await hb.beat()
  assert.equal(hbCol.writes[0]?.set['demoReady'], true)
})
