import test from 'node:test'
import assert from 'node:assert/strict'
import { ALERT_DEDUPE_MS, createAlertSink, type DeskAlertDoc } from '../src/desk-alerts.ts'

const T0 = Date.UTC(2026, 10, 3, 10, 0)

function coll() {
  const docs: DeskAlertDoc[] = []
  return {
    docs,
    insertOne: async (d: DeskAlertDoc) => {
      docs.push(d)
      return {}
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

test('an alert is inserted in the shared desk-alerts shape, nothing else on it', async () => {
  const c = coll()
  let now = T0
  const raise = createAlertSink(c, { now: () => now })
  raise({ severity: 'warn', source: 'supervisor', mode: 'live', tag: 'BULL1', key: 'BULL1:stale-quote', message: 'x' })
  await flush()
  assert.deepEqual(c.docs, [
    { at: T0, severity: 'warn', source: 'supervisor', mode: 'live', tag: 'BULL1', key: 'BULL1:stale-quote', message: 'x' },
  ])
  void now
})

test('at most one doc per key per 10 minutes; another key is its own', async () => {
  const c = coll()
  let now = T0
  const raise = createAlertSink(c, { now: () => now })
  const a = { severity: 'warn', source: 'supervisor', mode: 'paper', key: 'k1', message: 'm' } as const
  raise(a)
  now += 60_000
  raise(a)
  raise({ ...a, key: 'k2' })
  now = T0 + ALERT_DEDUPE_MS - 1
  raise(a)
  now = T0 + ALERT_DEDUPE_MS
  raise(a)
  await flush()
  assert.equal(ALERT_DEDUPE_MS, 600_000)
  assert.deepEqual(c.docs.map((d) => `${d.key}@${d.at - T0}`), ['k1@0', 'k2@60000', `k1@${ALERT_DEDUPE_MS}`])
})

test('a failing write never throws into the caller, and is logged', async () => {
  const logged: string[] = []
  const raise = createAlertSink(
    {
      insertOne: () => {
        throw new Error('down')
      },
    },
    { now: () => T0, log: (m) => logged.push(m) },
  )
  assert.doesNotThrow(() => raise({ severity: 'critical', source: 'api', mode: 'live', key: 'k', message: 'm' }))
  const rejecting = createAlertSink(
    { insertOne: async () => Promise.reject(new Error('refused')) },
    { now: () => T0, log: (m) => logged.push(m) },
  )
  assert.doesNotThrow(() => rejecting({ severity: 'critical', source: 'api', mode: 'live', key: 'k', message: 'm' }))
  await flush()
  assert.equal(logged.length, 2)
  assert.match(logged.join(' '), /down/)
  assert.match(logged.join(' '), /refused/)
})
