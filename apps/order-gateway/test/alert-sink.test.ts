import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALERT_DEDUPE_MS, DESK_ALERTS_COLLECTION, createAlertSink } from '../src/alert-sink.ts'

/**
 * The shared alert contract: `desk-alerts`, one insert per key per 10 min,
 * fire-and-forget — a write that fails or hangs never reaches the order path.
 */

const NOW = 1_793_696_000_000

function sink(insert: (doc: Record<string, unknown>) => Promise<unknown>) {
  const clock = { t: NOW }
  const logs: string[] = []
  const s = createAlertSink({
    collection: { insertOne: insert },
    now: () => clock.t,
    log: (m) => void logs.push(m),
  })
  return { s, clock, logs }
}

test('the document is the shared contract shape, source gateway', async () => {
  const docs: Record<string, unknown>[] = []
  const { s } = sink(async (d) => void docs.push(d))
  s.raise({ severity: 'critical', mode: 'live', key: 'close-unfilled:o1', message: 'still open', tag: 'BULLS-BTC' })
  await new Promise((r) => setImmediate(r))
  assert.equal(DESK_ALERTS_COLLECTION, 'desk-alerts')
  assert.deepEqual(docs, [
    { at: NOW, severity: 'critical', source: 'gateway', mode: 'live', tag: 'BULLS-BTC', key: 'close-unfilled:o1', message: 'still open' },
  ])
})

test('at most one document per key per 10 minutes; another key is its own', async () => {
  const docs: Record<string, unknown>[] = []
  const { s, clock } = sink(async (d) => void docs.push(d))
  s.raise({ severity: 'warn', mode: 'paper', key: 'k1', message: 'a' })
  s.raise({ severity: 'warn', mode: 'paper', key: 'k1', message: 'b' })
  s.raise({ severity: 'warn', mode: 'paper', key: 'k2', message: 'c' })
  clock.t += ALERT_DEDUPE_MS - 1
  s.raise({ severity: 'warn', mode: 'paper', key: 'k1', message: 'd' })
  clock.t += 1
  s.raise({ severity: 'warn', mode: 'paper', key: 'k1', message: 'e' })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(docs.map((d) => d['message']), ['a', 'c', 'e'])
  assert.equal(ALERT_DEDUPE_MS, 600_000)
})

test('fire-and-forget: a rejecting, throwing or hanging insert never throws into the caller', async () => {
  const a = sink(async () => {
    throw new Error('mongo down')
  })
  assert.doesNotThrow(() => a.s.raise({ severity: 'critical', mode: 'live', key: 'x', message: 'm' }))
  await new Promise((r) => setImmediate(r))
  assert.ok(a.logs.some((l) => /alert write failed/.test(l)))

  const b = sink(() => {
    throw new Error('sync throw')
  })
  assert.doesNotThrow(() => b.s.raise({ severity: 'critical', mode: 'live', key: 'x', message: 'm' }))

  const c = sink(() => new Promise(() => {}))
  const t0 = Date.now()
  c.s.raise({ severity: 'critical', mode: 'live', key: 'x', message: 'm' })
  assert.ok(Date.now() - t0 < 50, 'raise returned without waiting')
})
