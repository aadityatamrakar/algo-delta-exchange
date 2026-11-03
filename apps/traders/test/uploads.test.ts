import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { FileStore } from '../src/ingest/files.ts'
import { CANONICAL_HEADERS } from '../src/ingest/canonical.ts'
import { registerParsers, CANONICAL_PARSERS, type FileParser } from '../src/ingest/parsers.ts'
import type { IngestDeps } from '../src/ingest/pipeline.ts'
import { sha256hex } from '../src/hash.ts'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { authRoutes } from '../src/routes/auth.ts'
import { uploadRoutes } from '../src/routes/uploads.ts'
import { WatcherStatusStore } from '../src/watcher-status.ts'
import { startHarness, type Harness } from './harness.ts'

const applied: { trader: string; kind: string }[] = []
const parsersSeen: (string | null)[] = []
let failApply = 0
let status: WatcherStatusStore
const h: Harness | null = await startHarness('uploads', (d) => {
  status = new WatcherStatusStore(d.db)
  const ingest: IngestDeps = {
    files: new FileStore(d.db, d.now), log: d.log,
    apply: async (trader, parsed, file) => {
      if (failApply > 0) { failApply--; throw new Error('mongo went away') }
      applied.push({ trader, kind: parsed.kind }); parsersSeen.push(file.parser) },
  }
  return [
    authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }),
    uploadRoutes({ ingest, status, users: d.users, now: d.now, log: d.log }),
  ]
})
after(async () => { registerParsers(CANONICAL_PARSERS); await h?.close() })
let admin = ''
let token = ''
beforeEach(async () => {
  if (h === null) return
  registerParsers(CANONICAL_PARSERS)
  await h.reset(); applied.length = 0; parsersSeen.length = 0; failApply = 0
  await h.addUser('boss', 'admin'); await h.addUser('ravi')
  admin = await h.login('boss'); token = await h.watcherToken('ravi')
})

const TRADES = `${CANONICAL_HEADERS.trades}\nT1,O1,C1,TCS,future,2026-10-27,,,Sell,175,3500,2026-10-19T10:15:00+05:30`
const q = (p: string, text: string, extra = '') => `/v1/traders/files?path=${encodeURIComponent(p)}&mtime=1&sha256=${sha256hex(text)}${extra}`
const putFile = (tok: string, p: string, text: string, extra = '') =>
  h!.call('PUT', q(p, text, extra), { bearer: tok, raw: text, contentType: 'application/octet-stream' })

test('a watcher PUT stores, parses and applies', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await putFile(token, 'trades.csv', TRADES)
  assert.deepEqual(r.body, { stored: true, parser: 'canonical-trades', parseError: null })
  assert.deepEqual(applied, [{ trader: 'ravi', kind: 'trades' }])
  const again = await putFile(token, 'trades.csv', TRADES)
  assert.deepEqual(again.body, r.body); assert.equal(applied.length, 1)
})

test('apply is told which parser took the file, also when the stored row has none yet', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await putFile(token, 'trades.csv', TRADES)
  assert.deepEqual(parsersSeen, ['canonical-trades'])
})

test('a file that does not parse reports why and applies nothing', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await putFile(token, 'positions.csv', `${CANONICAL_HEADERS.positions}\nC1,TCS,opt,2026-10-27,3500,CE,-350,40`)
  assert.equal(r.body.parseError, 'line 2: instrument "opt" must be option, future or share'); assert.deepEqual(applied, [])
  const stored = await h.db.collection('traders-files').findOne({ trader: 'ravi', path: 'positions.csv' })
  assert.equal(stored!['parseError'], r.body.parseError)
})

test('a file no parser claims is stored with parser null', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await putFile(token, 'Nse Derivatives/Trades/DOCOMMiocp.log', 'hello\n')
  assert.deepEqual(r.body, { stored: true, parser: null, parseError: null }); assert.deepEqual(applied, [])
})

test('wrong sha256 is 400; a bad offset is 409 {error:"offset"}; bad query is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const bad = await h.call('PUT', `/v1/traders/files?path=a.csv&mtime=1&sha256=${sha256hex('other')}`, { bearer: token, raw: 'a' })
  assert.equal(bad.status, 400)
  const off = await putFile(token, 'a.csv', 'a', '&offset=5')
  assert.equal(off.status, 409); assert.deepEqual(off.body, { error: 'offset' })
  assert.equal((await h.call('PUT', `/v1/traders/files?path=..%2Fa&mtime=1&sha256=${sha256hex('a')}`, { bearer: token, raw: 'a' })).status, 400)
  assert.equal((await h.call('PUT', `/v1/traders/files?path=a&mtime=-1&sha256=${sha256hex('a')}`, { bearer: token, raw: 'a' })).status, 400)
  assert.equal((await h.call('PUT', `/v1/traders/files?path=a&mtime=1&sha256=ABC`, { bearer: token, raw: 'a' })).status, 400)
})

test('an offset append re-parses the whole file and records skipped lines', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const seen: string[] = []
  const odd: FileParser = {
    id: 'odd', matches: (p) => p.endsWith('.odd'),
    parse(text) { seen.push(text); return { kind: 'log', day: '2026-10-19', skipped: Array.from({ length: 25 }, (_, i) => ({ lineNo: i + 1, reason: 'x' })) } },
  }
  registerParsers([odd, ...CANONICAL_PARSERS])
  await putFile(token, 'd.odd', 'a\r\n')
  const r = await putFile(token, 'd.odd', 'b\r\n', '&offset=3')
  assert.equal(r.status, 409); assert.deepEqual(r.body, { error: 'offset' }) // sha is of the new bytes only, not the whole file
  const whole = 'a\r\nb\r\n'
  const ok = await h.call('PUT', `/v1/traders/files?path=d.odd&mtime=2&sha256=${sha256hex(whole)}&offset=3`, { bearer: token, raw: 'b\r\n' })
  assert.equal(ok.body.parseError, null)
  assert.deepEqual(seen, ['a\r\n', whole])
  const row = await h.db.collection('traders-files').findOne({ trader: 'ravi', path: 'd.odd' })
  assert.equal((row!['skipped'] as unknown[]).length, 20)
})

test('heartbeat records status from the token; a bad body is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('POST', '/v1/traders/heartbeat', { bearer: token, json: { version: '1.0', folder: 'C:\\odin', lastUploadAt: null, fileCount: 3, trader: 'boss' } })
  assert.deepEqual(r.body, { ok: true })
  const s = await status.get('ravi')
  assert.equal(s!.fileCount, 3); assert.equal(s!.lastHeartbeatAt, h.clock.now)
  assert.equal(await status.get('boss'), null)
  assert.equal((await h.call('POST', '/v1/traders/heartbeat', { bearer: token, json: { version: 1 } })).status, 400)
})

test('admin manual upload runs the same pipeline for the named trader', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('PUT', '/v1/traders/admin/traders/ravi/files?path=trades.csv', { cookie: admin, raw: TRADES, contentType: 'application/octet-stream' })
  assert.equal(r.body.parser, 'canonical-trades'); assert.deepEqual(applied, [{ trader: 'ravi', kind: 'trades' }])
  assert.equal((await h.call('PUT', '/v1/traders/admin/traders/nobody/files?path=p.csv', { cookie: admin, raw: TRADES, contentType: 'application/octet-stream' })).status, 404)
  assert.equal((await h.call('PUT', '/v1/traders/admin/traders/boss/files?path=p.csv', { cookie: admin, raw: TRADES, contentType: 'application/octet-stream' })).status, 404)
})

test('a watcher token cannot read, a session cannot upload', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await h.call('GET', '/v1/traders/files', { bearer: token })).status, 403)
  assert.equal((await h.call('PUT', '/v1/traders/files?path=a.csv&mtime=1&sha256=' + sha256hex('a'), { cookie: await h.login('ravi'), raw: 'a', contentType: 'application/octet-stream' })).status, 403)
})

test('an internal failure answers 500 and an identical PUT finishes the parse', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  failApply = 1
  const bad = await putFile(token, 'trades.csv', TRADES)
  assert.equal(bad.status, 500); assert.deepEqual(applied, [])
  const row = await h.db.collection('traders-files').findOne({ trader: 'ravi', path: 'trades.csv' })
  assert.match(row!['parseError'] as string, /^internal: mongo went away/)
  const ok = await putFile(token, 'trades.csv', TRADES)
  assert.deepEqual(ok.body, { stored: true, parser: 'canonical-trades', parseError: null })
  assert.deepEqual(applied, [{ trader: 'ravi', kind: 'trades' }])
  const row2 = await h.db.collection('traders-files').findOne({ trader: 'ravi', path: 'trades.csv' })
  assert.equal(row2!['parseError'], null)
})

test('a file stored before its parser existed is parsed by an identical PUT', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  registerParsers([])
  assert.equal((await putFile(token, 'trades.csv', TRADES)).body.parser, null)
  registerParsers(CANONICAL_PARSERS)
  const r = await putFile(token, 'trades.csv', TRADES)
  assert.deepEqual(r.body, { stored: true, parser: 'canonical-trades', parseError: null })
  assert.deepEqual(applied, [{ trader: 'ravi', kind: 'trades' }])
})
