import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDxHeartbeat, DX_HEARTBEAT_MS, DX_HEARTBEAT_TTL_MS } from '../src/dx-heartbeat.ts'

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

test('a failed ack is said, marks the switch unhealthy, and the next beat acks again', async () => {
  let n = 0
  const hb = createDxHeartbeat({
    rest: { heartbeat: async (op) => { n++; if (op === 'ack' && n === 2) throw new Error('timeout') } },
    log: () => {},
  })
  await hb.beat()
  await hb.beat()
  assert.equal(hb.healthy, false)
  await hb.beat()
  assert.equal(hb.healthy, true)
})
