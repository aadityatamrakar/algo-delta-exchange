/**
 * Desk health, read from outside the desk: the gateway's heartbeat row, the
 * supervisor's lease, and desk-api's own system report (which carries the
 * market-data process's md.health freshness).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiReadings, gatewayReading, readDeskHealth, supervisorReading } from '../src/health.ts'

const NOW = 2_000_000_000_000

test('gateway: healthy while its heartbeat row is younger than the stale window', () => {
  assert.equal(gatewayReading({ at: NOW - 20_000 }, NOW, 60_000).healthy, true)
  const old = gatewayReading({ at: NOW - 61_000 }, NOW, 60_000)
  assert.equal(old.healthy, false)
  assert.match(old.detail, /61s/)
  assert.equal(gatewayReading(null, NOW, 60_000).healthy, false)
})

test('supervisor: healthy while its lease is unexpired (5 s grace)', () => {
  assert.equal(supervisorReading({ expiresAt: NOW + 10_000 }, NOW).healthy, true)
  assert.equal(supervisorReading({ expiresAt: NOW - 4_000 }, NOW).healthy, true)
  assert.equal(supervisorReading({ expiresAt: NOW - 6_000 }, NOW).healthy, false)
  assert.equal(supervisorReading(null, NOW).healthy, false)
})

test('api + marketdata from the system report; a refusal still proves the api alive', () => {
  const ok = apiReadings({ status: 200, body: { components: [{ id: 'dx-marketdata', state: 'ok', detail: 'fine' }] } })
  assert.deepEqual(ok.map((r) => [r.component, r.healthy]), [['dx-api', true], ['dx-marketdata', true]])
  const stale = apiReadings({ status: 200, body: { components: [{ id: 'dx-marketdata', state: 'stale', detail: 'no md.health' }] } })
  assert.equal(stale.find((r) => r.component === 'dx-marketdata')?.healthy, false)
  const refused = apiReadings({ status: 401, body: {} })
  assert.deepEqual(refused.map((r) => [r.component, r.healthy]), [['dx-api', true]])
  const down = apiReadings({ error: 'ECONNREFUSED' })
  assert.deepEqual(down.map((r) => [r.component, r.healthy]), [['dx-api', false]])
})

test('readDeskHealth reads the two rows and the report, with the bearer', async () => {
  const seen: { url: string; auth: string | undefined }[] = []
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'desk-gateway-heartbeat' ? { at: NOW - 1000 } : { expiresAt: NOW + 20_000 }),
    }),
  }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.['Authorization'] })
    return new Response(JSON.stringify({ components: [{ id: 'dx-marketdata', state: 'ok' }] }), { status: 200 })
  }) as unknown as typeof fetch
  const r = await readDeskHealth({ db, fetch: fetchFn, apiUrl: 'http://127.0.0.1:1', token: 'T', now: () => NOW })
  assert.deepEqual(r.map((x) => [x.component, x.healthy]), [
    ['dx-gateway', true], ['dx-supervisor', true], ['dx-api', true], ['dx-marketdata', true],
  ])
  assert.equal(seen[0]?.url, 'http://127.0.0.1:1/v1/desk/system')
  assert.equal(seen[0]?.auth, 'Bearer T')
})
