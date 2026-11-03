import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { SnapshotCache } from '../src/analytics/snapshot.ts'
import { SpanStore } from '../src/analytics/margin.ts'
import { LegStore } from '../src/books/legs.ts'
import { authRoutes } from '../src/routes/auth.ts'
import { marginRoutes } from '../src/routes/margin.ts'
import { L4, R2_NOW, r2Legs, r2Market } from './fixtures/r2-book.ts'
import { HARNESS_ORIGIN, startHarness, type Harness } from './harness.ts'

const FIX = fileURLToPath(new URL('../../../packages/span/test/fixtures/', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'traders-margin-routes-'))
mkdirSync(join(root, '2026-10-19'))
writeFileSync(join(root, '2026-10-19', 'nsccl.20261019.i2.spn'), readFileSync(join(FIX, 'mini.spn')))
writeFileSync(join(root, '2026-10-19', 'ael_19102026.csv'), readFileSync(join(FIX, 'ael_19102026.csv')))
writeFileSync(join(root, '2026-10-19', 'manifest.json'), JSON.stringify({
  a: { name: 'nsccl.20261019.i2.spn', url: 'x', savedAt: Date.UTC(2026, 9, 19, 8, 1), bytes: 1, sha256: '0' },
}))
const span = new SpanStore({ dir: root, now: () => R2_NOW })
await span.refresh(new Set(['TCS']))

let legs: LegStore
const h: Harness | null = await startHarness('margin', (d) => {
  legs = new LegStore(d.db, d.now)
  const snapshots = new SnapshotCache({ ...r2Market(), now: () => R2_NOW })
  return [
    authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }),
    marginRoutes({ users: d.users, legs, snapshots, span, now: () => R2_NOW }),
  ]
})
after(async () => { await h?.close(); rmSync(root, { recursive: true, force: true }) })

const M = '/v1/traders/books/TCS/margin'
let asha = ''
beforeEach(async () => {
  if (h === null) return
  await h.reset()
  await h.addUser('asha'); await h.addUser('boss', 'admin')
  asha = await h.login('asha')
  const db = h.handle.db.collection('traders-legs')
  await db.insertMany(r2Legs().map((l) => ({ ...l })))
})

test('GET margin: 200 with the MarginView', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('GET', M, { cookie: asha })
  assert.equal(r.status, 200)
  assert.equal(r.body.available, true)
  assert.equal(r.body.span.label, 'NSE SPAN 13:31')
  assert.ok(Number.isFinite(r.body.initial) && r.body.total > 0)
})

test('?exclude= leaves a leg out of the figure; repeated, it leaves several', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const all = (await h.call('GET', M, { cookie: asha })).body
  const one = (await h.call('GET', `${M}?exclude=${encodeURIComponent(L4)}`, { cookie: asha })).body
  assert.notEqual(one.initial, all.initial)
  assert.ok(one.notes.includes('1 unticked leg(s) left out'))
  const two = (await h.call('GET', `${M}?exclude=${encodeURIComponent(L4)}&exclude=${encodeURIComponent(r2Legs()[0]!.key)}`, { cookie: asha })).body
  assert.ok(two.notes.includes('2 unticked leg(s) left out'))
})

test('a stock the trader does not hold is 404; a bad stock is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('GET', '/v1/traders/books/BSTOCK/margin', { cookie: asha })
  assert.equal(r.status, 404)
  assert.deepEqual(r.body, { error: 'no open book BSTOCK' })
  assert.equal((await h.call('GET', '/v1/traders/books/b!d/margin', { cookie: asha })).status, 400)
})

test('no session is 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await h.call('GET', M)).status, 401)
})

test('the store exists on a missing folder; the file appears after the next refresh, no restart', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { createApp } = await import('../src/app.ts')
  const { bookMargin, NO_SPAN_NOTE } = await import('../src/analytics/margin.ts')
  const { testMaster } = await import('./fixtures/master.ts')
  const parent = mkdtempSync(join(tmpdir(), 'traders-margin-app-'))
  const dir = join(parent, 'nse')
  const app = await createApp({
    db: h.db, bus: null, config: { port: 0, mongoUrl: '', busUrl: '', origins: [HARNESS_ORIGIN], sessionTtlMs: 3_600_000, maxTokens: 2000, nseDir: dir },
    now: () => R2_NOW, log: () => {}, master: testMaster(), quotes: { quote: () => null, feedAlive: () => true },
    declare: false, spanRefreshMs: 3_600_000,        // the timer never fires in the test: refreshes are called directly
  })
  try {
    await app.start()
    const before = await bookMargin(app.deps, 'asha', 'TCS', R2_NOW)
    assert.deepEqual([before!.available, before!.notes], [false, [NO_SPAN_NOTE]])
    mkdirSync(join(dir, '2026-10-19'), { recursive: true })
    writeFileSync(join(dir, '2026-10-19', 'nsccl.20261019.i2.spn'), readFileSync(join(FIX, 'mini.spn')))
    writeFileSync(join(dir, '2026-10-19', 'ael_19102026.csv'), readFileSync(join(FIX, 'ael_19102026.csv')))
    writeFileSync(join(dir, '2026-10-19', 'manifest.json'), JSON.stringify({ a: { name: 'nsccl.20261019.i2.spn', url: 'x', savedAt: Date.UTC(2026, 9, 19, 8, 1), bytes: 1, sha256: '0' } }))
    await app.deps.span.refresh(new Set(['TCS']))
    const after = await bookMargin(app.deps, 'asha', 'TCS', R2_NOW)
    assert.equal(after!.available, true)
    assert.equal(after!.span!.label, 'NSE SPAN 13:31')
  } finally {
    await app.stop()
    rmSync(parent, { recursive: true, force: true })
  }
})
