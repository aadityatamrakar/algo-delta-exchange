/**
 * The safety walk: trader A can never read or change trader B's data through
 * ANY endpoint. Every id in the endpoint table has a case in
 * ownership-cases.ts; the suite fails listing any that lacks one. Afterwards no
 * desk document has changed and no collection outside the allowed set exists.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { TRADERS_COLLECTIONS } from '../src/db.ts'
import { sha256hex } from '../src/hash.ts'
import { ENDPOINTS } from '../src/routes/endpoints.ts'
import { CASES, PHONE_B, type Res, type Walk } from './ownership-cases.ts'
import { TCS_SPOT, TEST_ROWS } from './fixtures/master.ts'
import { startTraders, type TradersHarness } from './harness.ts'
import { suiteUrl } from './mongo.ts'

const SUITE = 'ownership'
const DESK_KEEP = ['desk-books-registry', 'desk-subscriptions', 'instrument', 'desk-marks']
const FIXTURES = fileURLToPath(new URL('./fixtures/odin', import.meta.url))
const TRADES = 'Nse Derivatives/Trades/1019TRD.TXT'
const ORDERS = 'Nse Derivatives/Orders/1019ORD.TXT'

const h: TradersHarness | null = await startTraders({ suite: SUITE })
const mongo = createRequire(import.meta.url)('mongodb') as {
  MongoClient: { connect(u: string, o: object): Promise<{ db(): any; close(): Promise<void> }> }
}
const client = h === null ? null : await mongo.MongoClient.connect(suiteUrl(SUITE), { useUnifiedTopology: true })
const rawDb = client?.db()

async function snapshotDesk(o: { ignore: Record<string, Record<string, unknown>> }): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  const names: string[] = (await rawDb.listCollections().toArray()).map((c: { name: string }) => c.name)
  for (const name of names.filter((n) => !(TRADERS_COLLECTIONS as readonly string[]).includes(n) && !n.startsWith('system.')).sort()) {
    const docs: Record<string, unknown>[] = await rawDb.collection(name).find({}).toArray()
    const ignore = o.ignore[name]
    out[name] = docs
      .filter((d) => ignore === undefined || !Object.entries(ignore).every(([k, v]) => d[k] === v))
      .map((d) => JSON.stringify(d)).sort()
  }
  return out
}

let walk: Walk
let deskBefore: Record<string, string[]>

const b = { stocks: ['JINDALSTEL', 'M&M'], manualKey: '', day: '2026-10-19', conversation: 'c-00000000-0000-0000-0000-00000000b0b0' }

before(async () => {
  if (h === null) return
  await h.addUser('boss', 'admin'); await h.addUser('ravi'); await h.addUser('sita')
  const tokenA = await h.token('ravi'); const tokenB = await h.token('sita')

  const raw = (method: string, path: string, headers: Record<string, string>, body: unknown): Promise<Res> => {
    const init: RequestInit = { method, headers }
    if (body instanceof Buffer) { init.body = body; headers['content-type'] = 'application/octet-stream' }
    else if (body !== undefined) { init.body = JSON.stringify(body); headers['content-type'] = 'application/json' }
    return fetch(h.url + path, init).then(async (r) => {
      // a live stream never ends: read up to its first frame, then hang up; the body is that frame
      if ((r.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        const reader = r.body!.getReader()
        let got = ''
        while (!/event: frame\ndata: .*\n\n/.test(got)) {
          const { value, done } = await reader.read()
          if (done) break
          got += new TextDecoder().decode(value)
        }
        await reader.cancel()
        const m = /event: frame\ndata: (.*)\n\n/.exec(got)
        return { status: r.status, body: m === null ? null : JSON.parse(m[1]!) as unknown, headers: r.headers }
      }
      const text = await r.text()
      let parsed: unknown = null
      if (text !== '') { try { parsed = JSON.parse(text) } catch { parsed = text } }
      return { status: r.status, body: parsed, headers: r.headers }
    })
  }
  const sessions = new Map<string, string>()
  const login = async (name: string): Promise<string> => {
    const r = await fetch(h.url + '/v1/traders/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, password: `${name}-password` }),
    })
    assert.equal(r.status, 200)
    return (r.headers.get('set-cookie') ?? '').split(';')[0] as string
  }
  const cookieOf = async (name: string): Promise<string> => {
    let c = sessions.get(name)
    if (c === undefined) { c = await login(name); sessions.set(name, c) }
    return c
  }
  const withCookie = (cookie: string, m: string, p: string, body?: unknown) => raw(m, p, { cookie }, body)
  const rows = async (collection: string, trader: string): Promise<Record<string, unknown>[]> =>
    (await rawDb.collection(collection).find({ [collection === 'traders-users' || collection === 'traders-push' ? 'username' : 'trader']: trader }, { projection: { _id: 0 } }).toArray())
      .map((d: Record<string, unknown>) => JSON.parse(JSON.stringify(d))).sort((x: object, y: object) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)
  const bearer = (tok: string) => (m: string, p: string, body?: unknown) => raw(m, p, { authorization: `Bearer ${tok}` }, body)

  // B's watcher sends the ODIN fixtures and a heartbeat
  const watcherB = bearer(tokenB)
  for (const path of [TRADES, ORDERS]) {
    const body = readFileSync(`${FIXTURES}/${path}`)
    const r = await watcherB('PUT', `/v1/traders/files?path=${encodeURIComponent(path)}&mtime=1&sha256=${sha256hex(body)}`, body)
    assert.equal(r.status, 200, path)
    assert.equal(r.body.parseError, null, path)
  }
  assert.equal((await watcherB('POST', '/v1/traders/heartbeat', { version: '1.0', folder: 'C:\\odin-sita', lastUploadAt: null, fileCount: 2 })).status, 200)
  // B holds a manual M&M share leg, A a manual TCS share leg only
  const sita = await cookieOf('sita'); const ravi = await cookieOf('ravi')
  const mm = await withCookie(sita, 'POST', '/v1/traders/books/M%26M/legs', { instrument: 'share', qty: 10, avgPrice: 2500 })
  assert.equal(mm.status, 201, JSON.stringify(mm.body))
  b.manualKey = mm.body.key
  assert.equal((await withCookie(ravi, 'POST', '/v1/traders/books/TCS/legs', { instrument: 'share', qty: 5, avgPrice: 3400 })).status, 201)

  // sentinel desk documents, and the declaration document the app owns
  await rawDb.collection('desk-books-registry').deleteMany({})
  await rawDb.collection('desk-books-registry').insertOne({ _id: 'sentinel', v: 1 })
  await rawDb.collection('desk-subscriptions').insertOne({ source: 'hosted-runner', tokens: [1], updatedAt: 1 })
  await rawDb.collection('instrument').insertMany(TEST_ROWS.map((r) => ({ ...r })))
  await rawDb.collection('desk-marks').insertMany([{ token: TCS_SPOT, price: 3400, ts: 1 }, { token: 1001, price: 3410, ts: 1 }])
  await h.db.publishSubscription([TCS_SPOT], h.clock.now)
  deskBefore = await snapshotDesk({ ignore: { 'desk-subscriptions': { source: 'traders' } } })

  walk = {
    asA: async (m, p, body) => raw(m, p, { cookie: await cookieOf('ravi') }, body),
    asAdmin: async (m, p, body) => raw(m, p, { cookie: await cookieOf('boss') }, body),
    watcherA: bearer(tokenA), watcherB,
    anon: (m, p, body) => raw(m, p, {}, body),
    login, withCookie, tokenA, tokenB, rows,
    b: {
      get stocks() { return b.stocks }, get manualKey() { return b.manualKey }, day: b.day, conversation: b.conversation,
      legKeys: async () => (await rows('traders-legs', 'sita')).map((l) => l['key'] as string).sort(),
      files: async () => (await rows('traders-files', 'sita')).map((f) => f['path'] as string).sort(),
    } as Walk['b'],
  }
  assert.ok((await walk.b.legKeys()).length >= 2, 'B holds ODIN legs and the manual one')
  assert.ok((await walk.b.files()).length === 2)
  // B holds one assistant conversation of one turn (the walk's assistant is off: nothing could write one)
  await h.db.collection('traders-assistant').insertOne({
    _id: b.conversation, kind: 'chat', trader: 'sita', stock: 'M&M', title: 'sita asks', provider: 'anthropic', model: 'claude-opus-5-5',
    hidden: false, createdAt: h.clock.now, updatedAt: h.clock.now, prev: null, aliases: [], plans: { plans: [], next: 1 }, cardSeq: 0, bytes: 10,
    turns: [{ at: h.clock.now, user: 'sita asks', userMessageJson: '{}', messagesJson: '[]', text: 'sita answer', cards: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.01, provenance: { checked: 0, unverified: [] }, aborted: false, error: null, model: 'claude-opus-5-5', promptVersion: 'x', feedback: null }],
  } as never)
  // B has a phone subscribed, an alert of its own and one admin-wide alert naming it (gaps G7)
  assert.equal((await withCookie(sita, 'POST', '/v1/traders/push/subscribe', PHONE_B)).status, 200)
  await h.db.collection('traders-alerts').insertOne({ trader: 'sita', kind: 'band-breach', stock: 'JINDALSTEL', dedupeKey: 'band|sita|JINDALSTEL|1', title: 'sita alert', body: 'JINDALSTEL out of band', url: '/traders/#/books/JINDALSTEL', at: h.clock.now, sentAt: null, expiresAt: new Date(h.clock.now + 86_400_000) })
  await h.db.collection('traders-alerts').insertOne({ trader: null, kind: 'watcher-offline', stock: null, dedupeKey: 'admin|watcher|sita|1', title: 'Watcher offline: sita', body: 'No heartbeat since 09:30 IST.', url: '/traders/#/admin', at: h.clock.now, sentAt: null, expiresAt: new Date(h.clock.now + 86_400_000) })
  // no release-1 parser fills the log: give B one line through the app's own writer
  await h.db.collection('traders-log').insertOne({ trader: 'sita', day: b.day, seq: 1, time: Date.parse('2026-10-19T10:00:00+05:30'), text: 'sita log line' })
  // and one daily-record row (the recorder is off in the walk; the row is the shape it writes)
  await h.db.collection('traders-daily').insertOne({
    trader: 'sita', stock: 'M&M', day: b.day, at: h.clock.now, dayMtm: 1, openPnl: 1, seriesNet: 1, seriesBooked: 1, spot: 2500,
    delta: 10, gamma: 0, theta: 0, vega: 0, margin: null, marginSource: null, legs: 1, warnings: 0,
  })
  // B really holds orders, trades and log lines on b.day, in the database and through the API
  for (const [col, path] of [['traders-orders', 'orders'], ['traders-trades', 'trades'], ['traders-log', 'log']] as const) {
    const n = await rawDb.collection(col).countDocuments({ trader: 'sita', day: b.day })
    assert.ok(n > 0, `${col}: B has no rows on ${b.day}`)
    const api = await withCookie(sita, 'GET', `/v1/traders/${path}?day=${b.day}`)
    assert.ok(Array.isArray(api.body) && api.body.length > 0, `${path}: B sees nothing of its own on ${b.day}`)
    assert.equal(await rawDb.collection(col).countDocuments({ trader: 'ravi', day: b.day }), 0)
  }
})

after(async () => { await client?.close(); await h?.close() })

test('every endpoint has an ownership case', () => {
  const missing = ENDPOINTS.filter((e) => !(e.id in CASES)).map((e) => e.id)
  assert.deepEqual(missing, [], `endpoint(s) ${missing.join(', ')} have no ownership case — add one to test/ownership-cases.ts`)
  const unknown = Object.keys(CASES).filter((id) => !ENDPOINTS.some((e) => e.id === id))
  assert.deepEqual(unknown, [], 'a case names an endpoint that does not exist')
})

for (const e of ENDPOINTS) {
  test(`ownership: ${e.id}`, async (t) => {
    if (h === null) return skipUnlessMongo(t)
    const run = CASES[e.id]
    assert.ok(run, `endpoint ${e.id} has no ownership case — add one to test/ownership-cases.ts`)
    await run(walk)
  })
}

const FILL: Record<string, string> = { ':name': 'sita', ':stock': 'TCS', ':key': 'x' }
const fill = (pattern: string): string => pattern.split('/').map((s) => FILL[s] ?? s).join('/')

test('each kind of door refuses the wrong kind of key', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const e of ENDPOINTS) {
    const path = `${fill(e.pattern)}?as=sita`
    const body = e.raw ? Buffer.from('x') : e.method === 'GET' || e.method === 'DELETE' ? undefined : {}
    if (e.kind === 'trader' || e.kind === 'admin') {
      assert.equal((await walk.watcherA(e.method, path, body)).status, 403, `${e.id}: a watcher token on a session endpoint`)
      assert.equal((await walk.anon(e.method, path, body)).status, 401, `${e.id}: no credentials`)
    }
    if (e.kind === 'watcher') {
      assert.equal((await walk.asA(e.method, path, body)).status, 403, `${e.id}: a trader session on a watcher endpoint`)
      assert.equal((await walk.asAdmin(e.method, path, body)).status, 403, `${e.id}: an admin session on a watcher endpoint`)
      assert.equal((await walk.anon(e.method, path, body)).status, 401, `${e.id}: no credentials`)
    }
    if (e.kind === 'admin') {
      assert.equal((await walk.asA(e.method, path, body)).status, 403, `${e.id}: a trader on an admin endpoint`)
    }
  }
})

test('after the walk, no desk collection changed', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const names: string[] = (await rawDb.listCollections().toArray()).map((c: { name: string }) => c.name)
  assert.deepEqual(names.filter((n) => !(TRADERS_COLLECTIONS as readonly string[]).includes(n) && !DESK_KEEP.includes(n) && !n.startsWith('system.')), [])
  assert.deepEqual(await snapshotDesk({ ignore: { 'desk-subscriptions': { source: 'traders' } } }), deskBefore)
  const mine = await rawDb.collection('desk-subscriptions').find({ source: 'traders' }).toArray()
  assert.equal(mine.length, 1)
})
