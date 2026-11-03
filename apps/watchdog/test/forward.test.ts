/**
 * ALERT DELIVERY: new un-forwarded `desk-alerts` go to Telegram when it is
 * configured, and are stamped `forwardedAt`; without config they are logged and
 * stamped so the log is said once. Telegram is never called here: fake fetch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAlertForwarder, createWatchdogAlertSink, telegramConfigFromEnv } from '../src/forward.ts'

type Doc = Record<string, unknown>
const NOW = 2_000_000_000_000

function fakeAlerts(docs: Doc[]) {
  const updates: { id: unknown; set: Doc }[] = []
  const inserted: Doc[] = []
  const collection = {
    find: (q: Doc) => ({
      sort: () => ({
        limit: (n: number) => ({
          toArray: async () => {
            const unforwarded = (q['forwardedAt'] as Doc | undefined)?.['$exists'] === false
            return docs.filter((d) => !unforwarded || d['forwardedAt'] === undefined).slice(0, n)
          },
        }),
      }),
    }),
    updateOne: async (f: Doc, u: Doc) => {
      const set = u['$set'] as Doc
      updates.push({ id: f['_id'], set })
      const d = docs.find((x) => x['_id'] === f['_id'])
      if (d !== undefined) Object.assign(d, set)
      return {}
    },
    insertOne: async (d: Doc) => {
      inserted.push(d)
      return {}
    },
  }
  return { collection, updates, inserted }
}

const alert = (id: string, over: Doc = {}): Doc => ({
  _id: id, at: NOW - 1000, severity: 'critical', source: 'dx-gateway/backstop', mode: 'live', key: `k-${id}`, message: `msg ${id}`, ...over,
})

test('telegram config needs both token and chat', () => {
  assert.equal(telegramConfigFromEnv({}), null)
  assert.equal(telegramConfigFromEnv({ DX_ALERT_TELEGRAM_TOKEN: 't' }), null)
  assert.deepEqual(telegramConfigFromEnv({ DX_ALERT_TELEGRAM_TOKEN: 't', DX_ALERT_TELEGRAM_CHAT: '42' }), { token: 't', chat: '42' })
})

test('with Telegram: each new alert is sent once, then stamped forwardedAt', async () => {
  const a = fakeAlerts([alert('a1'), alert('a2', { forwardedAt: NOW - 5 })])
  const sent: { url: string; body: Doc }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) as Doc })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
  const logs: string[] = []
  const fw = createAlertForwarder({ collection: a.collection, telegram: { token: 'SECRET', chat: '42' }, fetch: fetchFn, log: (m) => logs.push(m), now: () => NOW })
  await fw.run()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, 'https://api.telegram.org/botSECRET/sendMessage')
  assert.equal(sent[0]?.body['chat_id'], '42')
  assert.match(String(sent[0]?.body['text']), /CRITICAL/)
  assert.match(String(sent[0]?.body['text']), /msg a1/)
  assert.deepEqual(a.updates.map((u) => [u.id, u.set['forwardedAt'], u.set['forwardedVia']]), [['a1', NOW, 'telegram']])
  await fw.run()
  assert.equal(sent.length, 1, 'never sent twice')
  assert.ok(logs.every((l) => !l.includes('SECRET')), 'the token is never logged')
})

test('a failed send is not stamped: it is retried on the next pass', async () => {
  const a = fakeAlerts([alert('a1')])
  let fail = true
  const fetchFn = (async () => (fail ? new Response('{"ok":false}', { status: 502 }) : new Response('{"ok":true}', { status: 200 }))) as unknown as typeof fetch
  const fw = createAlertForwarder({ collection: a.collection, telegram: { token: 'T', chat: '1' }, fetch: fetchFn, log: () => {}, now: () => NOW })
  await fw.run()
  assert.equal(a.updates.length, 0)
  fail = false
  await fw.run()
  assert.equal(a.updates.length, 1)
})

test('without Telegram: logged and stamped via log; nothing is fetched', async () => {
  const a = fakeAlerts([alert('a1')])
  const logs: string[] = []
  const fetchFn = (async () => { throw new Error('must not fetch') }) as unknown as typeof fetch
  const fw = createAlertForwarder({ collection: a.collection, telegram: null, fetch: fetchFn, log: (m) => logs.push(m), now: () => NOW })
  await fw.run()
  assert.ok(logs.some((l) => l.includes('msg a1')))
  assert.equal(a.updates[0]?.set['forwardedVia'], 'log')
})

test('a backlog older than the max age is stamped skipped, never sent', async () => {
  const a = fakeAlerts([alert('old', { at: NOW - 7 * 3600_000 })])
  let calls = 0
  const fetchFn = (async () => { calls++; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
  const fw = createAlertForwarder({ collection: a.collection, telegram: { token: 'T', chat: '1' }, fetch: fetchFn, log: () => {}, now: () => NOW })
  await fw.run()
  assert.equal(calls, 0)
  assert.equal(a.updates[0]?.set['forwardedVia'], 'skipped-old')
})

test('the watchdog sink writes the shared contract shape and dedupes per key', async () => {
  const a = fakeAlerts([])
  let now = NOW
  const sink = createWatchdogAlertSink({ collection: a.collection, now: () => now, log: () => {} })
  sink({ severity: 'critical', mode: 'live', key: 'k', message: 'm' })
  sink({ severity: 'critical', mode: 'live', key: 'k', message: 'm' })
  now += 11 * 60_000
  sink({ severity: 'critical', mode: 'live', key: 'k', message: 'm' })
  await new Promise((r) => setImmediate(r))
  assert.equal(a.inserted.length, 2)
  assert.deepEqual(a.inserted[0], { at: NOW, severity: 'critical', source: 'dx-watchdog', mode: 'live', key: 'k', message: 'm' })
})
