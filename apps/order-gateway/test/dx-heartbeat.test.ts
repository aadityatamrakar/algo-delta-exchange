import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DxApiError } from '@algomaker/dx'
import { createDxHeartbeat, retireDxHeartbeat, DX_HEARTBEAT_MS, DX_HEARTBEAT_TTL_MS } from '../src/dx-heartbeat.ts'

test('the dead-man switch is created once, then acked with a 30 s ttl on every beat', async () => {
  const calls: string[] = []
  const hb = createDxHeartbeat({
    rest: { heartbeat: async (op, ttl) => { calls.push(`${op}:${String(ttl)}`) } },
    log: () => {},
  })
  await hb.beat()
  await hb.beat()
  await hb.beat()
  assert.deepEqual(calls, ['create:30000', 'ack:30000', 'ack:30000'])
  assert.equal(DX_HEARTBEAT_MS, 10_000)
  assert.equal(DX_HEARTBEAT_TTL_MS, 30_000)
})

test('a failed create is retried on the next beat and never throws', async () => {
  const calls: string[] = []
  let fail = true
  const said: string[] = []
  const hb = createDxHeartbeat({
    rest: {
      heartbeat: async (op) => {
        calls.push(op)
        if (fail) throw new Error('503')
      },
    },
    log: (m) => said.push(m),
  })
  await hb.beat()
  fail = false
  await hb.beat()
  await hb.beat()
  assert.deepEqual(calls, ['create', 'create', 'ack'])
  assert.ok(said.some((m) => /HEARTBEAT/.test(m)))
  assert.equal(hb.healthy, true)
})

test('a failed ack is said, marks the switch unhealthy, and the next beat RE-CREATES before acking', async () => {
  // Delta can drop a heartbeat (a restart on its side, an expiry): acking an id
  // it no longer has fails forever, so the next beat registers it again.
  const calls: string[] = []
  let n = 0
  const hb = createDxHeartbeat({
    rest: { heartbeat: async (op) => { n++; calls.push(op); if (op === 'ack' && n === 2) throw new Error('heartbeat not found') } },
    log: () => {},
  })
  await hb.beat()
  await hb.beat()
  assert.equal(hb.healthy, false)
  await hb.beat()
  assert.equal(hb.healthy, true)
  assert.deepEqual(calls, ['create', 'ack', 'create'])
})

test('a re-create that fails still acks, so a switch Delta kept stays renewed', async () => {
  const calls: string[] = []
  let failAck = true
  const hb = createDxHeartbeat({
    rest: {
      heartbeat: async (op) => {
        calls.push(op)
        if (op === 'ack' && failAck) { failAck = false; throw new Error('timeout') }
        if (op === 'create' && calls.length > 1) throw new Error('heartbeat_id already exists')
      },
    },
    log: () => {},
  })
  await hb.beat() // create ok
  await hb.beat() // ack fails
  assert.equal(hb.healthy, false)
  await hb.beat() // re-create refused, ack ok
  assert.deepEqual(calls, ['create', 'ack', 'create', 'ack'])
  assert.equal(hb.healthy, true)
})

test('retireDxHeartbeat: ack a live ttl, then 0, until Delta says the switch is disabled', async () => {
  const acks: number[] = []
  let answer: boolean | string = true
  const r = retireDxHeartbeat({
    rest: { heartbeatAck: async (ttl) => { acks.push(ttl); return { process_enabled: ttl === 0 ? answer : true } } },
    log: () => {},
  })
  answer = 'true' // Delta did not disable it — try again next beat
  await r.beat()
  assert.equal(r.retired, false)
  answer = false
  await r.beat()
  assert.equal(r.retired, true)
  await r.beat() // retired: never touched again (a second ttl-0 ack re-enables and FIRES it)
  assert.deepEqual(acks, [30000, 0, 30000, 0])
})

test('retireDxHeartbeat: an id Delta does not know (4xx) is already retired; a 5xx is retried', async () => {
  const err = (status: number) => new DxApiError({ status, code: status === 400 ? 'heartbeat_not_found' : 'http_503', message: 'x' })
  let status = 503
  const said: string[] = []
  const r = retireDxHeartbeat({
    rest: { heartbeatAck: async () => { throw err(status) } },
    log: (m) => said.push(m),
  })
  await r.beat()
  assert.equal(r.retired, false)
  status = 400
  await r.beat()
  assert.equal(r.retired, true)
  assert.ok(said.some((m) => /RETIRE/.test(m)))
})
