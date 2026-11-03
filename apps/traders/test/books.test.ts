import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { authRoutes } from '../src/routes/auth.ts'
import { LegStore } from '../src/books/legs.ts'
import { sha256hex } from '../src/hash.ts'
import { FileStore } from '../src/ingest/files.ts'
import { booksRoutes } from '../src/routes/books.ts'
import type { Instrument, ManualLegInput, TraderLeg } from '../src/types.ts'
import { MM_SPOT, NIFTY_WK, OCT, TCS_SPOT, octCE, niftyWkPE, testMaster } from './fixtures/master.ts'
import { startHarness, type Harness } from './harness.ts'

const MASTER = testMaster()
let legs: LegStore
let files: FileStore
const h: Harness | null = await startHarness('books', (d) => {
  legs = new LegStore(d.db, d.now)
  files = new FileStore(d.db, d.now)
  return [authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }),
    booksRoutes({ users: d.users, legs, files, master: () => MASTER, now: d.now, log: d.log })]
})
after(async () => { await h?.close() })

const B = '/v1/traders/books'
let ravi = ''
let boss = ''
const get = (path: string, cookie = ravi) => h!.call('GET', path, { cookie })
const post = (path: string, json: unknown, cookie = ravi) => h!.call('POST', path, { cookie, json })
const pick = (o: Record<string, unknown>, ks: string[]) => Object.fromEntries(ks.map((k) => [k, o[k]]))

beforeEach(async () => {
  if (h === null) return
  await h.reset()
  h.clock.now = Date.parse('2026-10-19T10:30:00+05:30')
  await h.addUser('boss', 'admin'); await h.addUser('ravi'); await h.addUser('sita')
  ravi = await h.login('ravi'); boss = await h.login('boss')
})

async function odin(trader: string, stock: string, instrument: Instrument, expiry: string, strike: number | null, optType: 'CE' | 'PE' | null, qty: number): Promise<void> {
  const p = { stock, instrument, expiry, strike, optType, qty, avgPrice: 10, clientCode: 'C0001' }
  await legs.replaceOdin(trader, [p], () => 1)
}
async function seedOdin(trader: string, rows: ReadonlyArray<readonly [string, Instrument, string, number | null, 'CE' | 'PE' | null, number]>): Promise<void> {
  const all = rows.map(([stock, instrument, expiry, strike, optType, qty]) =>
    ({ stock, instrument, expiry, strike, optType, qty, avgPrice: 10, clientCode: 'C0001' }))
  await legs.replaceOdin(trader, all, () => 1)
}
const manualShare = (stock: string, qty: number): ManualLegInput =>
  ({ stock, instrument: 'share', expiry: '', strike: null, optType: null, qty, avgPrice: 3000, note: '' })

test('books lists every underlying with an open leg, manual-only and index books included', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await seedOdin('ravi', [
    ['TCS', 'option', OCT, 3500, 'CE', -175], ['TCS', 'option', OCT, 3600, 'CE', 0],
    ['NIFTY', 'option', NIFTY_WK, 25500, 'PE', 75],
    ['RELIANCE', 'option', OCT, 1400, 'CE', 0], ['RELIANCE', 'future', OCT, null, null, 0],
  ])
  await legs.addManual('ravi', manualShare('INFY', 100), null)
  await legs.addManual('ravi', manualShare('TCS', 10), TCS_SPOT)
  await legs.addManual('sita', manualShare('SBIN', 10), null)
  assert.deepEqual((await get(B)).body, [
    { stock: 'INFY', legCount: 1, mismatch: null, lastFileAt: null, band: null },
    { stock: 'NIFTY', legCount: 1, mismatch: null, lastFileAt: null, band: null },
    { stock: 'TCS', legCount: 2, mismatch: null, lastFileAt: null, band: null },
  ])
})

test('lastFileAt is the newest file the trader sent', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await legs.addManual('ravi', manualShare('INFY', 100), null)
  await files.put('ravi', { path: 'a.csv', body: Buffer.from('x'), sha256: sha256hex('x'), mtime: 1, offset: null })
  const at = h.clock.now
  const r = await get(B)
  assert.equal(r.body[0].lastFileAt, at)
  h.clock.now += 5000
  await files.put('ravi', { path: 'b.csv', body: Buffer.from('y'), sha256: sha256hex('y'), mtime: 1, offset: null })
  await files.put('sita', { path: 'c.csv', body: Buffer.from('z'), sha256: sha256hex('z'), mtime: 1, offset: null })
  h.clock.now += 5000
  assert.equal((await get(B)).body[0].lastFileAt, at + 5000)
  assert.equal(await files.lastReceivedAt('nobody'), null)
})

test('expired legs are not counted', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await seedOdin('ravi', [
    ['TCS', 'option', '2026-10-18', 3500, 'CE', -175], ['TCS', 'option', OCT, 3500, 'PE', -175],
    ['WIPRO', 'option', '2026-10-18', 250, 'CE', 100],
  ])
  assert.deepEqual((await get(B)).body, [{ stock: 'TCS', legCount: 1, mismatch: null, lastFileAt: null, band: null }])
})

test('adding 1,000 TCS shares by hand', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await post(`${B}/TCS/legs`, { instrument: 'share', qty: 1000, avgPrice: 3000 })
  assert.equal(r.status, 201); assert.match(r.body.key, /^manual:/)
  assert.deepEqual(pick(r.body, ['stock', 'instrument', 'expiry', 'strike', 'optType', 'qty', 'avgPrice', 'clientCode', 'source', 'token', 'note']),
    { stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null, qty: 1000, avgPrice: 3000, clientCode: '', source: 'manual', token: TCS_SPOT, note: '' })
  assert.equal((await post(`${B}/tcs/legs`, { instrument: 'share', qty: 5, avgPrice: 1 })).body.stock, 'TCS')
})

test('a manual option leg is matched to its contract', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await post(`${B}/TCS/legs`, { instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -175, avgPrice: 20, note: 'hedge' })
  assert.equal(r.status, 201); assert.equal(r.body.token, octCE(3500)); assert.equal(r.body.note, 'hedge')
  const w = await post(`${B}/NIFTY/legs`, { instrument: 'option', expiry: NIFTY_WK, strike: 25500, optType: 'PE', qty: 75, avgPrice: 5 })
  assert.equal(w.body.token, niftyWkPE(25500))
})

test('a symbol with & survives the path', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await post(`${B}/M%26M/legs`, { instrument: 'share', qty: 50, avgPrice: 3100 })
  assert.equal(r.status, 201); assert.equal(r.body.stock, 'M&M'); assert.equal(r.body.token, MM_SPOT)
  assert.deepEqual((await get(B)).body.map((b: { stock: string }) => b.stock), ['M&M'])
})

test('manual leg validation', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const bad = async (stock: string, body: unknown) => (await post(`${B}/${stock}/legs`, body))
  assert.equal((await bad('TCS', { instrument: 'option', expiry: OCT, strike: 3510, optType: 'CE', qty: -175, avgPrice: 20 })).body.error,
    'no TCS 3510 CE 2026-10-27 in the instrument master')
  assert.equal((await bad('TCS', { instrument: 'future', expiry: '2027-01-26', qty: 175, avgPrice: 1 })).body.error,
    'no TCS FUT 2027-01-26 in the instrument master')
  const cases: unknown[] = [
    { instrument: 'share', qty: 0, avgPrice: 1 },
    { instrument: 'share', qty: 1.5, avgPrice: 1 },
    { instrument: 'share', qty: 10_000_001, avgPrice: 1 },
    { instrument: 'share', qty: 10, avgPrice: null },
    { instrument: 'share', qty: 10, avgPrice: 1, note: 'x'.repeat(201) },
    { instrument: 'share', qty: 10, avgPrice: 1, expiry: OCT },
    { instrument: 'bond', qty: 10, avgPrice: 1 },
    { instrument: 'option', expiry: OCT, strike: 0, optType: 'CE', qty: 10, avgPrice: 1 },
    { instrument: 'option', expiry: OCT, strike: 3500, optType: 'XX', qty: 10, avgPrice: 1 },
    { instrument: 'option', expiry: '27-10-2026', strike: 3500, optType: 'CE', qty: 10, avgPrice: 1 },
    { instrument: 'future', qty: 10, avgPrice: 1 },
    { instrument: 'future', expiry: OCT, strike: 3500, qty: 10, avgPrice: 1 },
  ]
  for (const c of cases) assert.equal((await bad('TCS', c)).status, 400, JSON.stringify(c))
  assert.equal((await bad('BAD$', { instrument: 'share', qty: 10, avgPrice: 1 })).status, 400)
  assert.equal((await bad('TCS', { instrument: 'share', qty: 10, avgPrice: 1, note: 'x'.repeat(200) })).status, 201)
  assert.equal((await bad('TCS', { instrument: 'share', qty: -10_000_000, avgPrice: -0.5 })).status, 201)
})

test('only manual legs can be edited or deleted', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await odin('ravi', 'TCS', 'option', OCT, 3500, 'CE', -175)
  const odinKey = (await legs.open('ravi'))[0]!.key
  const mine: TraderLeg = await legs.addManual('ravi', manualShare('TCS', 100), TCS_SPOT)
  const L = '/v1/traders/legs/'
  const patch = (key: string, json: unknown, cookie = ravi) => h!.call('PATCH', L + encodeURIComponent(key), { cookie, json })
  const del = (key: string, cookie = ravi) => h!.call('DELETE', L + encodeURIComponent(key), { cookie })

  const p = await patch(mine.key, { qty: 500, note: 'sold half' })
  assert.equal(p.status, 200); assert.equal(p.body.qty, 500); assert.equal(p.body.note, 'sold half'); assert.equal(p.body.avgPrice, 3000)
  assert.equal((await legs.open('ravi', 'TCS')).find((l) => l.key === mine.key)?.qty, 500)
  assert.equal((await patch(mine.key, { stock: 'INFY' })).status, 400)
  assert.equal((await patch(mine.key, {})).status, 400)
  assert.equal((await patch(mine.key, { qty: 0 })).status, 400)

  const o = await patch(odinKey, { qty: 1 })
  assert.equal(o.status, 409); assert.equal(o.body.error, 'an ODIN leg cannot be edited; it follows the ODIN files')
  assert.equal((await del(odinKey)).status, 409)

  const sitas = await legs.addManual('sita', manualShare('TCS', 5), TCS_SPOT)
  assert.equal((await patch(sitas.key, { qty: 1 })).status, 404)
  assert.equal((await del(sitas.key)).status, 404)

  const d = await del(mine.key)
  assert.equal(d.status, 200); assert.deepEqual(d.body, { deleted: true })
  assert.equal((await del(mine.key)).status, 404)
  assert.equal((await legs.open('sita', 'TCS')).length, 1)
})

test('an admin reads a trader with ?as=', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await legs.addManual('ravi', manualShare('INFY', 100), null)
  await legs.addManual('sita', manualShare('SBIN', 100), null)
  assert.deepEqual((await get(`${B}?as=ravi`, boss)).body.map((b: { stock: string }) => b.stock), ['INFY'])
  assert.equal((await get(B, boss)).status, 400)
  assert.equal((await get(`${B}?as=nobody`, boss)).status, 404)
  // a trader is always themselves
  assert.deepEqual((await get(`${B}?as=sita`, ravi)).body.map((b: { stock: string }) => b.stock), ['INFY'])
  assert.equal((await post(`${B}/TCS/legs?as=sita`, { instrument: 'share', qty: 1, avgPrice: 1 }, ravi)).status, 201)
  assert.equal((await legs.open('sita', 'TCS')).length, 0)
  assert.equal((await get(B, '')).status, 401)
})
