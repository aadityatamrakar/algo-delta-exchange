import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { sha256hex } from '../src/hash.ts'
import { FileStore } from '../src/ingest/files.ts'
import { authRoutes } from '../src/routes/auth.ts'
import { recordsRoutes } from '../src/routes/records.ts'
import type { LogLine, TraderOrder, TraderTrade } from '../src/types.ts'
import { WatcherStatusStore } from '../src/watcher-status.ts'
import { startHarness, type Harness } from './harness.ts'

let status: WatcherStatusStore
let files: FileStore
const h: Harness | null = await startHarness('records', (d) => {
  status = new WatcherStatusStore(d.db)
  files = new FileStore(d.db, d.now)
  return [authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }),
    recordsRoutes({ users: d.users, db: d.db, status, files, now: d.now })]
})
after(async () => { await h?.close() })

const V = '/v1/traders'
let ravi = ''
let boss = ''
const get = (path: string, cookie = ravi) => h!.call('GET', path, { cookie })
const at = (hhmm: string, day = '2026-10-19') => Date.parse(`${day}T${hhmm}:00+05:30`)

beforeEach(async () => {
  if (h === null) return
  await h.reset()
  h.clock.now = at('10:30')
  await h.addUser('boss', 'admin'); await h.addUser('ravi'); await h.addUser('sita')
  ravi = await h.login('ravi'); boss = await h.login('boss')
})

const order = (trader: string, orderNo: string, stock: string, time: number, day: string): TraderOrder => ({
  trader, orderNo, exchOrderNo: '', clientCode: 'C0001', stock, instrument: 'share', expiry: '', strike: null, optType: null,
  side: 'Buy', qty: 10, price: 1, status: 'Open', reason: '', time, day, filledQty: null, updateTime: time,
})
const trade = (trader: string, tradeNo: string, stock: string, time: number, day: string, seq: number): TraderTrade => ({
  trader, tradeNo, orderNo: 'o' + tradeNo, clientCode: 'C0001', stock, instrument: 'share', expiry: '', strike: null, optType: null,
  side: 'Sell', qty: 5, price: 2, time, day, seq,
})

test('orders filter by day and stock, newest first; default day is today', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const col = h.db.collection<TraderOrder>('traders-orders')
  for (const o of [
    order('ravi', 'a', 'TCS', at('09:20'), '2026-10-19'), order('ravi', 'b', 'INFY', at('10:05'), '2026-10-19'),
    order('ravi', 'c', 'TCS', at('10:10'), '2026-10-19'), order('ravi', 'd', 'TCS', at('09:30', '2026-10-16'), '2026-10-16'),
    order('sita', 'e', 'TCS', at('10:00'), '2026-10-19'),
  ]) await col.insertOne(o)
  const r = await get(`${V}/orders`)
  assert.deepEqual(r.body.map((o: TraderOrder) => o.orderNo), ['c', 'b', 'a'])
  assert.equal('_id' in r.body[0], false)
  assert.deepEqual((await get(`${V}/orders?stock=tcs`)).body.map((o: TraderOrder) => o.orderNo), ['c', 'a'])
  assert.deepEqual((await get(`${V}/orders?day=2026-10-16`)).body.map((o: TraderOrder) => o.orderNo), ['d'])
  assert.deepEqual((await get(`${V}/orders?as=sita`)).body.map((o: TraderOrder) => o.orderNo), ['c', 'b', 'a'])
  assert.deepEqual((await get(`${V}/orders?as=sita`, boss)).body.map((o: TraderOrder) => o.orderNo), ['e'])
  assert.equal((await get(`${V}/orders`, boss)).status, 400)
})

test('trades come newest first, one trader at a time', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const col = h.db.collection<TraderTrade>('traders-trades')
  for (const x of [
    trade('ravi', '1', 'TCS', at('09:20'), '2026-10-19', 1), trade('ravi', '2', 'M&M', at('10:20'), '2026-10-19', 2),
    trade('sita', '3', 'TCS', at('10:25'), '2026-10-19', 1),
  ]) await col.insertOne(x)
  assert.deepEqual((await get(`${V}/trades`)).body.map((x: TraderTrade) => x.tradeNo), ['2', '1'])
  assert.deepEqual((await get(`${V}/trades?stock=M%26M`)).body.map((x: TraderTrade) => x.tradeNo), ['2'])
})

test('a day that is not ISO is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const p of ['orders', 'trades', 'log']) {
    assert.equal((await get(`${V}/${p}?day=19-10-2026`)).status, 400, p)
    assert.equal((await get(`${V}/${p}?day=2026-02-30`)).status, 400, p)
  }
})

test('log is in seq order', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const col = h.db.collection<LogLine>('traders-log')
  for (const [seq, text, trader, day] of [[3, 'c', 'ravi', '2026-10-19'], [1, 'a', 'ravi', '2026-10-19'], [2, 'b', 'ravi', '2026-10-19'],
    [1, 'x', 'sita', '2026-10-19'], [1, 'y', 'ravi', '2026-10-16']] as const) {
    await col.insertOne({ trader, day, seq, time: at('10:00'), text })
  }
  assert.deepEqual((await get(`${V}/log`)).body.map((l: LogLine) => l.text), ['a', 'b', 'c'])
  assert.deepEqual((await get(`${V}/log?day=2026-10-16`)).body.map((l: LogLine) => l.text), ['y'])
})

test('watcher status is null before a heartbeat; files never carry content', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await get(`${V}/watcher`)).body, null)
  await status.record('ravi', { version: '1.0.0', folder: 'C:\\ODIN', lastUploadAt: null, fileCount: 2 }, h.clock.now)
  assert.deepEqual((await get(`${V}/watcher`)).body,
    { lastHeartbeatAt: h.clock.now, lastUploadAt: null, version: '1.0.0', folder: 'C:\\ODIN', fileCount: 2 })
  assert.equal((await get(`${V}/watcher`, boss)).status, 400)

  assert.deepEqual((await get(`${V}/files`)).body, [])
  const put = async (trader: string, path: string, text: string) =>
    await files.put(trader, { path, body: Buffer.from(text), sha256: sha256hex(text), mtime: 5, offset: null })
  await put('ravi', 'a.csv', 'secret-content'); h.clock.now += 1000
  await put('ravi', 'b.csv', 'more'); await put('sita', 'c.csv', 'other')
  await files.setParse('ravi', 'a.csv', 'odin-nse-fo-trades', null, [{ lineNo: 3, reason: 'bad qty' }])
  const r = await get(`${V}/files`)
  assert.deepEqual(r.body.map((f: { path: string }) => f.path), ['b.csv', 'a.csv'])
  assert.equal(JSON.stringify(r.body).includes('secret-content'), false)
  assert.equal('content' in r.body[0], false); assert.equal('_id' in r.body[0], false)
  assert.deepEqual(r.body[1].skipped, [{ lineNo: 3, reason: 'bad qty' }])
  assert.equal(r.body[1].parser, 'odin-nse-fo-trades')
})

test('an internal parse failure reads as a retry, not as the raw error', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await files.put('ravi', { path: 'a.csv', body: Buffer.from('x'), sha256: sha256hex('x'), mtime: 5, offset: null })
  await files.put('ravi', { path: 'b.csv', body: Buffer.from('y'), sha256: sha256hex('y'), mtime: 5, offset: null })
  await files.setParse('ravi', 'a.csv', null, 'internal: MongoServerError at /srv/x.ts:12')
  await files.setParse('ravi', 'b.csv', 'p', 'line 4: qty is not a number')
  const rows = (await get(`${V}/files`)).body as { path: string; parseError: string }[]
  const by = Object.fromEntries(rows.map((f) => [f.path, f.parseError]))
  assert.equal(by['a.csv'], 'internal error — the server will retry')
  assert.equal(by['b.csv'], 'line 4: qty is not a number')
})

test('a log over the cap keeps the newest lines, in seq order, and says it was cut', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const col = h.db.collection<LogLine>('traders-log')
  for (let seq = 1; seq <= 5001; seq++) await col.insertOne({ trader: 'ravi', day: '2026-10-19', seq, time: at('10:00'), text: `l${seq}` })
  const r = await get(`${V}/log`)
  assert.equal(r.headers.get('x-truncated'), 'true')
  assert.equal(r.body.length, 5000); assert.equal(r.body[0].seq, 2); assert.equal(r.body[4999].seq, 5001)
  assert.equal(r.body.every((l: LogLine, i: number) => l.seq === i + 2), true)
  await col.deleteOne({ trader: 'ravi', day: '2026-10-19', seq: 1 })
  const exact = await get(`${V}/log`)
  assert.equal(exact.headers.get('x-truncated'), null); assert.equal(exact.body.length, 5000)
})

test('orders over the cap say so; files cap at 500 newest', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const o = h.db.collection<TraderOrder>('traders-orders')
  for (let i = 0; i < 5001; i++) await o.insertOne(order('ravi', String(i).padStart(5, '0'), 'TCS', at('09:20') + i, '2026-10-19'))
  const r = await get(`${V}/orders`)
  assert.equal(r.headers.get('x-truncated'), 'true'); assert.equal(r.body.length, 5000); assert.equal(r.body[0].orderNo, '05000')
  assert.equal((await get(`${V}/orders?stock=INFY`)).headers.get('x-truncated'), null)

  const f = h.db.collection('traders-files')
  for (let i = 0; i < 501; i++) await f.insertOne({ trader: 'ravi', path: `f${i}.csv`, sha256: 'x', size: 1, mtime: 1, receivedAt: 1000 + i, parser: null, parseError: null, content: 'c' })
  const fr = await get(`${V}/files`)
  assert.equal(fr.headers.get('x-truncated'), 'true'); assert.equal(fr.body.length, 500)
  assert.equal(fr.body[0].path, 'f500.csv'); assert.equal(fr.body[499].path, 'f1.csv')
  await f.deleteOne({ trader: 'ravi', path: 'f0.csv' })
  assert.equal((await get(`${V}/files`)).headers.get('x-truncated'), null)
})
