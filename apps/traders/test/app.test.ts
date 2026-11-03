import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import type { RepairPool } from '../src/analytics/repair-pool.ts'
import { createApp, type AppOverride } from '../src/app.ts'
import { assertOrigins, configFromEnv } from '../src/config.ts'
import { TradersDb } from '../src/db.ts'
import { sha256hex } from '../src/hash.ts'
import type { TradersMaster } from '../src/market/master.ts'
import type { OnScreenSet } from '../src/market/on-screen.ts'
import type { TradersQuotes } from '../src/market/quotes.ts'
import type { Declarer } from '../src/market/subscriptions.ts'
import { ENDPOINTS } from '../src/routes/endpoints.ts'
import type { IngestDeps } from '../src/ingest/pipeline.ts'
import { CANONICAL_HEADERS } from '../src/ingest/canonical.ts'
import { CANONICAL_PARSERS, parserFor, registerParsers } from '../src/ingest/parsers.ts'
import { TEST_ROWS, OCT, testMaster } from './fixtures/master.ts'
import { connectSuite, wipe } from './mongo.ts'
import { HARNESS_ORIGIN, startTraders, type TradersHarness } from './harness.ts'

const quotes: TradersQuotes = { quote: () => null, feedAlive: () => true }
const h: TradersHarness | null = await startTraders({ suite: 'app', quotes })
after(async () => { registerParsers(CANONICAL_PARSERS); await h?.close() })

const B = '/v1/traders'
const post = (who: string, path: string, json: unknown) =>
  h!.as(who)(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) })

beforeEach(async () => {
  if (h === null) return
  await wipe(h.handle)
  await h.addUser('boss', 'admin'); await h.addUser('ravi'); await h.addUser('sita')
})

test('configFromEnv', () => {
  assert.throws(() => configFromEnv({}), /TRADERS_MONGO_URL is required/)
  const c = configFromEnv({ TRADERS_MONGO_URL: 'mongodb://x/y', TRADERS_ORIGINS: ' http://a , ,http://b', TRADERS_SESSION_TTL_MS: 'abc' })
  assert.deepEqual([c.port, c.busUrl, c.origins, c.sessionTtlMs], [8894, 'ws://127.0.0.1:8891', ['http://a', 'http://b'], DEFAULT_SESSION_TTL_MS])
  const d = configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_PORT: '9000', DESK_BUS_URL: 'ws://h:1', TRADERS_SESSION_TTL_MS: '60000' })
  assert.deepEqual([d.port, d.busUrl, d.sessionTtlMs, d.origins], [9000, 'ws://h:1', 60000, []])
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_SESSION_TTL_MS: '-5' }).sessionTtlMs, DEFAULT_SESSION_TTL_MS)
  assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_PORT: 'abc' }), /TRADERS_PORT/)
  assert.equal(c.maxTokens, 2000)
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MAX_TOKENS: ' 500 ' }).maxTokens, 500)
  for (const bad of ['abc', '0', '-1', '1.5'])
    assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MAX_TOKENS: bad }), /TRADERS_MAX_TOKENS/, bad)
})

test('configFromEnv: TRADERS_NSE_DIR defaults to <repo>/data/nse wherever the process starts; a relative one is from the repo root', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm' }).nseDir, join(repo, 'data/nse'))
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_NSE_DIR: '  ' }).nseDir, join(repo, 'data/nse'))
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_NSE_DIR: ' /srv/nse ' }).nseDir, '/srv/nse')
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_NSE_DIR: 'var/nse' }).nseDir, join(repo, 'var/nse'))
})

test('origins: exact only; plain http by IP is accepted; * and null refuse to boot', async (t) => {
  assert.deepEqual(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_ORIGINS: 'http://203.0.113.10' }).origins, ['http://203.0.113.10'])
  for (const bad of ['*', 'null', 'NULL', 'http://a,*', 'https://*.example.com']) {
    assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_ORIGINS: bad }), /TRADERS_ORIGINS/, bad)
  }
  assert.throws(() => assertOrigins(['*']), /exact origins/)
  assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_ORIGINS: 'http://203.0.113.10/' }),
    /entry "http:\/\/203\.0\.113\.10\/" is not an origin — use http:\/\/203\.0\.113\.10/)
  assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_ORIGINS: '203.0.113.10' }), /entry "203\.0\.113\.10" is not an origin/)
  assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_ORIGINS: 'http://a/path' }), /is not an origin/)
  assert.deepEqual(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_ORIGINS: 'http://203.0.113.10:8080' }).origins, ['http://203.0.113.10:8080'])
  if (h === null) return skipUnlessMongo(t)
  await assert.rejects(
    createApp({ db: h.db, bus: null, config: { ...h.deps.config, origins: ['*'] }, now: () => 0, log: () => {}, master: testMaster(), declare: false }),
    /TRADERS_ORIGINS/,
  )
})

test('a plain-http origin by IP gets CORS and may write', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const ip = await startTraders({ suite: 'app_ip', quotes, origins: ['http://203.0.113.10'] })
  assert.ok(ip)
  try {
    const pre = await fetch(`${ip.url}${B}/auth/login`, { method: 'OPTIONS', headers: { origin: 'http://203.0.113.10' } })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://203.0.113.10')
    await ip.addUser('ravi')
    const write = await fetch(`${ip.url}${B}/auth/login`, {
      method: 'POST', headers: { origin: 'http://203.0.113.10', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ravi', password: 'ravi-password' }),
    })
    assert.equal(write.status, 200)
    assert.equal(write.headers.get('access-control-allow-origin'), 'http://203.0.113.10')
    const other = await fetch(`${ip.url}${B}/auth/login`, { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(other.status, 403)
  } finally { await ip.close() }
})

test('health answers without a login', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await fetch(`${h.url}${B}/health`)
  assert.equal(r.status, 200)
  const b = await r.json() as Record<string, unknown>
  assert.equal(b['ok'], true)
  assert.equal(b['feedAlive'], true)
  assert.equal(b['busConnected'], null)            // an in-process bus has no connection to report
  assert.equal(b['masterLoadedAt'], 0)
  assert.equal(b['masterContracts'], testMaster().options.optionCount + testMaster().cash.size)
  assert.deepEqual([b['declaredTokens'], b['declaredAt']], [0, null])   // declare: false
  assert.deepEqual([b['tokenCap'], b['tokenCapHit']], [2000, false])
})

test('a declaration over the feed cap: health says so, and only the trimmed book warns', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const capped: Declarer = {
    addTokenSource: () => {}, refreshNow: async () => [], stop: () => {},
    last: () => ({ count: 2000, at: 5, capHit: true, trimmed: new Set(['TCS']), bookDemand: 2400 }),
  }
  const c = await startTraders({ suite: 'app_cap', quotes, deps: { subscriptions: capped } })
  assert.ok(c)
  try {
    const b = await (await fetch(`${c.url}${B}/health`)).json() as Record<string, unknown>
    assert.deepEqual([b['declaredTokens'], b['tokenCap'], b['tokenCapHit']], [2000, 2000, true])
    await c.addUser('ravi')
    const ravi = c.as('ravi')
    const add = (stock: string) => ravi(`${B}/books/${stock}/legs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instrument: 'future', expiry: OCT, qty: 175, avgPrice: 3500 }),
    })
    assert.equal((await add('TCS')).status, 201); assert.equal((await add('JINDALSTEL')).status, 201)
    const warnings = async (stock: string) => ((await (await ravi(`${B}/books/${stock}`)).json()) as { warnings: string[] }).warnings
    assert.ok((await warnings('TCS')).includes('price coverage reduced — the traders feed cap (2000 tokens) is reached'))
    assert.equal((await warnings('JINDALSTEL')).some((w) => w.startsWith('price coverage')), false)
  } finally { await c.close() }
})

test('every endpoint in the table has a handler', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const boss = h.as('boss')
  const tok = await h.token('ravi')
  for (const e of ENDPOINTS) {
    const path = `${B}${e.pattern.slice(B.length)}`.replace(':stock', 'TCS').replace(':name', 'ravi').replace(':key', 'nokey')
    const headers: Record<string, string> = {}
    let body: string | Buffer | undefined
    if (e.method !== 'GET') {
      body = e.raw ? Buffer.from('x') : '{}'
      headers['content-type'] = e.raw ? 'application/octet-stream' : 'application/json'
    }
    let r: Response
    if (e.kind === 'watcher') r = await fetch(h.url + path, { method: e.method, headers: { ...headers, authorization: `Bearer ${tok}` }, ...(body === undefined ? {} : { body }) })
    else if (e.kind === 'public') r = await fetch(h.url + path, { method: e.method, headers, ...(body === undefined ? {} : { body }) })
    else r = await boss(path + (path.includes('?') ? '&' : '?') + 'as=ravi', { method: e.method, headers, ...(body === undefined ? {} : { body }) })
    const text = await r.text()
    assert.equal(/has no handler/.test(text), false, `${e.id}: ${r.status} ${text}`)
  }
})

const FO_1019 = 'Nse Derivatives/Trades/1019TRD.TXT'
const fixture = (p: string) => readFileSync(fileURLToPath(new URL(`./fixtures/odin/${p}`, import.meta.url)))

test('an ODIN trade file uploaded by the watcher shows on the book', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const body = fixture(FO_1019)
  const q = `path=${encodeURIComponent(FO_1019)}&mtime=1&sha256=${sha256hex(body)}`
  const put = await fetch(`${h.url}${B}/files?${q}`, {
    method: 'PUT', headers: { authorization: `Bearer ${await h.token('ravi')}`, 'content-type': 'application/octet-stream' }, body,
  })
  assert.equal(put.status, 200)
  assert.equal(((await put.json()) as { parser: string }).parser, 'odin-nse-fo-trades')
  const ravi = h.as('ravi')
  const list = await (await ravi(`${B}/books`)).json() as { stock: string }[]
  assert.ok(list.some((b) => b.stock === 'JINDALSTEL'), JSON.stringify(list))
  const view = await (await ravi(`${B}/books/JINDALSTEL`)).json() as { legs: { matched: boolean }[] }
  assert.ok(view.legs.length > 0)
  assert.ok(view.legs.every((l) => l.matched), JSON.stringify(view.legs))
  assert.equal((await h.as('sita')(`${B}/books/JINDALSTEL`)).status, 404)   // another trader's file is not sita's book
})

test('one LegStore: a manual leg bumps the version the book view reads, and shows at once', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const ravi = h.as('ravi')
  const before = h.deps.legs.version('ravi')
  const r = await post('ravi', `${B}/books/TCS/legs`, { instrument: 'future', expiry: OCT, qty: 175, avgPrice: 3500 })
  assert.equal(r.status, 201)
  assert.ok(h.deps.legs.version('ravi') > before)
  const first = await (await ravi(`${B}/books/TCS`)).json() as { legs: unknown[] }
  assert.equal(first.legs.length, 1)
  const r2 = await post('ravi', `${B}/books/TCS/legs`, { instrument: 'share', qty: 10, avgPrice: 3000 })
  assert.equal(r2.status, 201)
  const second = await (await ravi(`${B}/books/TCS`)).json() as { legs: unknown[] }
  assert.equal(second.legs.length, 2)
})

test('one TraderStore, SessionStore and WatcherTokens serve the gate and the admin routes', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await post('boss', `${B}/admin/traders/ravi/token`, {})
  assert.equal(r.status, 200)
  const token = ((await r.json()) as { token: string }).token
  assert.equal((await h.deps.tokens.active('ravi')) !== null, true)
  // the gate accepts a token the admin route just issued
  const hb = await fetch(`${h.url}${B}/heartbeat`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: '1', folder: 'C:\\x', lastUploadAt: null, fileCount: 0 }),
  })
  assert.equal(hb.status, 200)
  assert.notEqual(await h.deps.status.get('ravi'), null)       // recorded through deps.status
  // disabling through the admin route kills the live session at the gate
  const ravi = h.as('ravi')
  assert.equal((await ravi(`${B}/auth/me`)).status, 200)
  assert.equal((await h.as('boss')(`${B}/admin/traders/ravi`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) })).status, 200)
  assert.equal((await ravi(`${B}/books`)).status, 401)
})

test('one IngestDeps: the watcher route and the admin upload both go through deps.ingest', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const seen: string[] = []
  const ingest: IngestDeps = { files: h.deps.files, log: () => {}, apply: async (trader) => { seen.push(trader) } }
  const app2 = await startTraders({ suite: 'app_ingest', quotes, deps: { ingest } })
  assert.ok(app2)
  try {
    await app2.addUser('boss', 'admin'); await app2.addUser('ravi')
    const text = `${CANONICAL_HEADERS.trades}\nT1,O1,C1,TCS,future,2026-10-27,,,Sell,175,3500,2026-10-19T10:15:00+05:30`
    const body = Buffer.from(text)
    const q = (p: string) => `path=${p}&mtime=1&sha256=${sha256hex(body)}`
    const tok = await app2.token('ravi')
    const w = await fetch(`${app2.url}${B}/files?${q('a.csv')}`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream' }, body })
    const a = await app2.as('boss')(`${B}/admin/traders/ravi/files?${q('b.csv')}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body })
    assert.deepEqual([w.status, a.status], [200, 200])
    assert.equal(app2.deps.ingest, ingest)
    assert.deepEqual(seen, ['ravi', 'ravi'])
  } finally { await app2.close() }
})

test('the ODIN parsers are registered ahead of the canonical ones', () => {
  assert.equal(parserFor(FO_1019, fixture(FO_1019).toString('latin1').split('\r\n')[0]!)?.id, 'odin-nse-fo-trades')
  assert.equal(parserFor('trades.csv', CANONICAL_HEADERS.trades)?.id, 'canonical-trades')
})

// ---- the master -----------------------------------------------------------

test('the master is loaded before start() resolves; an empty instrument collection refuses to start', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const s = await connectSuite('app_master')
  assert.ok(s)
  try {
    await wipe(s.handle, ['instrument', 'desk-marks'])
    const make = () => createApp({ db: s.db, bus: null, config: h.deps.config, now: () => 5_000, log: () => {}, quotes, declare: false })
    const empty = await make()
    assert.throws(() => empty.deps.master(), /not loaded/)        // never an empty master, even before start
    await assert.rejects(empty.start(), /instrument collection is empty/)

    await s.handle.db.collection('instrument').insertMany(TEST_ROWS.map((r) => ({ ...r })))
    const app = await make()
    await app.start()
    try {
      const m = app.deps.master()
      assert.equal(m.loadedAt, 5_000)
      assert.ok(m.cash.has('TCS') && m.options.optionCount > 0)
    } finally { await app.stop() }
  } finally {
    await wipe(s.handle, ['instrument', 'desk-marks'])
    await s.handle.close()
  }
})

test('a failed master refresh keeps the old master', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const logs: string[] = []
  let calls = 0
  const first: TradersMaster = testMaster(111)
  const app = await createApp({
    db: h.db, bus: null, config: h.deps.config, now: () => 9, log: (m) => logs.push(m), quotes, declare: false,
    masterRefreshMs: 10,
    loadMaster: async () => { calls++; if (calls === 1) return first; throw new Error('mongo went away') },
  })
  await app.start()
  try {
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(calls >= 2)
    assert.equal(app.deps.master(), first)
    assert.ok(logs.some((l) => /refresh failed/.test(l)))
  } finally { await app.stop() }
})

test('the feed: ticks on the bus reach the built quote cache; an injected quotes object skips it', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const own = await startTraders({ suite: 'app_feed' })
  assert.ok(own)
  try {
    const tcs = [...own.deps.master().cash.values()].find((r) => r.tradingsymbol === 'TCS')!.instrument_token
    assert.equal(own.deps.quotes.quote(tcs), null)
    own.bus.publish('md.tick', { token: tcs, price: 3500, ts: Date.now() }, Date.now())
    assert.equal(own.deps.quotes.quote(tcs)?.price, 3500)
    own.bus.publish('md.health', { ok: 1 }, 1)
    assert.deepEqual(own.deps.feed.payload, { ok: 1 })
  } finally { await own.close() }
})

// ---- the intraday sampler ------------------------------------------------------

test('the intraday sampler starts with the app and stops with it; intradaySampler: false keeps it off', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const cases: readonly [{ intradaySampler?: boolean }, readonly string[]][] = [[{}, ['start', 'stop']], [{ intradaySampler: false }, []]]
  for (const [o, want] of cases) {
    const app = await createApp({
      db: h.db, bus: null, config: h.deps.config, now: () => Date.UTC(2026, 9, 19, 4, 30), log: () => {},
      master: testMaster(), quotes, declare: false, every: () => () => {}, bandBoard: false, ...o,
    })
    const calls: string[] = []
    const ib = app.deps.intraday
    const start = ib.start.bind(ib)
    const stop = ib.stop.bind(ib)
    ib.start = () => { calls.push('start'); start() }
    ib.stop = () => { calls.push('stop'); stop() }
    try {
      await app.start()
      assert.deepEqual(calls, want.slice(0, 1))
    } finally { await app.stop() }
    assert.deepEqual(calls, want)
  }
})

// ---- the NSE end-of-day folder ----------------------------------------------

test('the NSE folders are read once the server listens, never awaited by start(); each refresh timer fires its pass; stop() clears both (final fix I4)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const root = mkdtempSync(join(tmpdir(), 'traders-app-nse-'))
  const fixtures = fileURLToPath(new URL('../../../packages/span/test/fixtures', import.meta.url))
  const FO = 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'
  const CM = 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv'
  mkdirSync(join(root, '2026-10-16'))
  copyFileSync(join(fixtures, 'eod', 'fo-udiff.csv'), join(root, '2026-10-16', FO))
  // the timers as the app sets them: fired by hand, never by the clock
  const timers: { readonly ms: number; readonly run: () => Promise<void>; cleared: number }[] = []
  const every = (run: () => Promise<void>, ms: number): (() => void) => {
    const timer = { ms, run, cleared: 0 }
    timers.push(timer)
    return () => { timer.cleared++ }
  }
  mkdirSync(join(root, 'history'))
  const day = (date: string) => JSON.stringify({ date, symbols: { TCS: { o: 3390, h: 3420, l: 3380, c: 3400, v: 1, fut: null, opt: null } } })
  writeFileSync(join(root, 'history', '2026-10-15.json'), day('2026-10-15'))
  const make = () => createApp({
    db: h.db, bus: null, config: { ...h.deps.config, nseDir: root }, now: () => Date.UTC(2026, 9, 19, 4, 30), log: () => {},
    master: testMaster(), quotes, declare: false, eodRefreshMs: 111, spanRefreshMs: 222, historyRefreshMs: 333, every, daily: false,
  })
  /** Each pass the app starts: the stores' refreshes and the open-books read that starts a SPAN pass. */
  const spy = (app: Awaited<ReturnType<typeof make>>) => {
    const seen = { eod: [] as Promise<void>[], span: [] as Promise<void>[], history: [] as Promise<void>[], books: 0 }
    const { eod, span, legs, history } = app.deps
    const eodRefresh = eod.refresh.bind(eod)
    const spanRefresh = span.refresh.bind(span)
    const historyRefresh = history.refresh.bind(history)
    eod.refresh = () => { const p = eodRefresh(); seen.eod.push(p); return p }
    span.refresh = (symbols) => { const p = spanRefresh(symbols); seen.span.push(p); return p }
    history.refresh = () => { const p = historyRefresh(); seen.history.push(p); return p }
    legs.allOpen = async () => { seen.books++; return [] }
    return seen
  }
  const app = await make()
  const seen = spy(app)
  try {
    await app.start()
    assert.deepEqual(timers.map((x) => x.ms), [111, 222, 333])
    for (let i = 0; i < 3; i++) await new Promise(setImmediate)
    assert.deepEqual([seen.eod.length, seen.books, seen.span.length, seen.history.length], [0, 0, 0, 0], 'start() ran a pass before the server listens')
    assert.deepEqual(app.deps.eod.status().missing, [FO, CM])

    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    assert.deepEqual([seen.eod.length, seen.books, seen.history.length], [1, 1, 1])   // the first passes began as it started to listen
    await Promise.all(seen.history)
    assert.deepEqual(app.deps.history.bars('TCS', 10).map((b) => b.date), ['2026-10-15'])
    writeFileSync(join(root, 'history', '2026-10-16.json'), day('2026-10-16'))
    await timers[2]!.run()
    assert.deepEqual(app.deps.history.bars('TCS', 10).map((b) => b.date), ['2026-10-15', '2026-10-16'])
    await Promise.all(seen.eod)
    assert.deepEqual(app.deps.eod.status(), { day: '2026-10-16', fo: FO, cm: null, missing: [CM] })
    await new Promise(setImmediate)
    assert.equal(seen.span.length, 1)
    await Promise.all(seen.span)
    assert.equal(app.deps.span.span(), null)

    copyFileSync(join(fixtures, 'eod', 'cm-udiff.csv'), join(root, '2026-10-16', CM))
    await timers[0]!.run()
    assert.equal(seen.eod.length, 2)
    assert.deepEqual(app.deps.eod.status().missing, [])
    mkdirSync(join(root, '2026-10-19'))
    copyFileSync(join(fixtures, 'mini.spn'), join(root, '2026-10-19', 'nsccl.20261019.i1.spn'))
    await timers[1]!.run()
    assert.deepEqual([seen.books, seen.span.length], [2, 2])
    assert.equal(app.deps.span.span()?.source.file, 'nsccl.20261019.i1.spn')

    await app.stop()
    assert.deepEqual(timers.map((x) => x.cleared), [1, 1, 1])
  } finally {
    await app.stop()
    await new Promise((r) => app.server.close(r))
  }

  // an app stopped before it listens never reads the folders
  timers.length = 0
  const idle = await make()
  const quiet = spy(idle)
  await idle.start()
  await idle.stop()
  assert.deepEqual(timers.map((x) => x.cleared), [1, 1, 1])
  idle.server.emit('listening')
  assert.deepEqual([quiet.eod.length, quiet.books, quiet.history.length], [0, 0, 0])
  rmSync(root, { recursive: true, force: true })
})

test('expired legs are settled again once the history is read at boot, and when it picks up a day (G1); an empty folder or an unchanged one is no run', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const root = mkdtempSync(join(tmpdir(), 'traders-app-settle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'history'))
  const day = (date: string, c: number) => JSON.stringify({ date, symbols: { TCS: { o: c, h: c, l: c, c, v: 1, fut: null, opt: null } } })
  const SEP = '2026-09-29'
  await h.db.collection('traders-trades').insertOne({
    trader: 'ravi', tradeNo: 'T1', orderNo: 'O1', clientCode: 'C0001', stock: 'TCS', instrument: 'option', expiry: SEP, strike: 2000, optType: 'CE',
    side: 'Buy', qty: 175, price: 20, time: Date.parse(`${SEP}T10:00:00+05:30`), day: SEP, seq: 1,
  })
  await h.db.collection('traders-settings').insertOne({ kind: 'ledger', trader: 'ravi', historyFrom: '2026-05-04' })
  const timers: { readonly ms: number; readonly run: () => Promise<void> }[] = []
  const every = (run: () => Promise<void>, ms: number): (() => void) => { timers.push({ ms, run }); return () => {} }
  const logged: { msg: string; fields: unknown }[] = []
  const app = await createApp({
    db: h.db, bus: null, config: { ...h.deps.config, nseDir: root }, now: () => Date.parse('2026-10-23T10:30:00+05:30'),
    log: (msg, fields) => { logged.push({ msg, fields }) }, master: testMaster(), quotes, declare: false, historyRefreshMs: 333, every, bandBoard: false,
  })
  const runs = () => logged.filter((l) => l.msg === 'settlement recomputed').map((l) => l.fields)
  const legsOf = async () => (await app.deps.legs.open('ravi')).map((l) => [l.instrument, l.qty, l.avgPrice])
  // as a previous process left them: settled
  const settled = { clientCode: 'C0001', stock: 'TCS', expiry: SEP, strike: 2000, optType: 'CE' as const }
  await app.deps.legs.replaceOdin('ravi', [
    { ...settled, instrument: 'option', qty: 0, avgPrice: 0 },
    { ...settled, instrument: 'share', expiry: '', strike: null, optType: null, qty: 175, avgPrice: 2032.4 },
  ], () => null)
  try {
    await app.start()
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    // no history day read (an empty or unreadable folder): no run, so nothing settled is re-opened
    await app.deps.history.refresh()
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(runs(), [])
    assert.deepEqual(await legsOf(), [['share', 175, 2032.4]])

    // a day arrives, but not the 29th's: the call is open again, unsettled, and says why
    writeFileSync(join(root, 'history', '2026-09-28.json'), day('2026-09-28', 2010))
    const history = timers.find((x) => x.ms === 333)!
    await history.run()
    assert.deepEqual(runs(), [{ traders: 1, fills: 0, unsettled: 1, failed: 0, ms: 0 }])
    assert.deepEqual(await legsOf(), [['option', 175, 20]])
    assert.deepEqual((await app.deps.ledger.settlement('ravi')).unsettled.map((u) => u.reason), ['no NSE history for 2026-09-29'])

    writeFileSync(join(root, 'history', `${SEP}.json`), day(SEP, 2032.4))
    await history.run()
    assert.equal(runs().length, 2)
    assert.deepEqual(await legsOf(), [['share', 175, 2032.4]])
    await history.run()
    assert.equal(runs().length, 2, 'the same history settles nothing again')
    assert.equal(JSON.stringify(logged).includes('C0001'), false)
  } finally {
    await app.stop()
    await new Promise((r) => app.server.close(r))
  }
})

test('the harness app reads no NSE folder, and the charges store answers the seed rates', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.deepEqual(h.deps.eod.status().missing, ['BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv', 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv'])
  const { SEED_RATES } = await import('../src/analytics/charges.ts')
  assert.deepEqual(await h.deps.charges.get(), SEED_RATES)
})

test('createApp takes as overrides only what it honours (R3 final fix M7)', () => {
  // the stores, the master, the quotes, the declarer and the repair pool may be handed in
  const honoured: AppOverride = { subscriptions: null as unknown as Declarer, repair: null as unknown as RepairPool }
  // @ts-expect-error createApp always builds its own Market Watch set (and band store, risk and board): an override would be ignored
  const onScreen: AppOverride = { onScreen: null as unknown as OnScreenSet }
  // @ts-expect-error the bag's db is createApp's own argument
  const db: AppOverride = { db: null as unknown as TradersDb }
  assert.ok(honoured && onScreen && db)
})
