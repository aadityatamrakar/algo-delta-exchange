/**
 * A BULL-S book cannot be ARMED live without `bs_margin_budget` > 0 (lane A,
 * 3 Nov) — `../src/bull-s-live.ts`. Paper is never asked.
 *
 * OWN DATABASE NAME: `algomaker_dx_laneA_bs_live_test`, distinct from every
 * other Mongo test file.
 */
import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OptionMaster } from '@algomaker/instruments'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { deskRoutes } from '../src/routes/desk.ts'
import { liveBudgetRefusal } from '../src/bull-s-live.ts'
import { reconcileHaltFor } from '../src/reconcile-halt.ts'

// ─────────────────────────────────────────────────────────────── pure

test('a BULL-S book with no budget is refused live, named; a budget, or another engine, is not', () => {
  assert.match(liveBudgetRefusal('B', { bs_enabled: true, bs_strike_step: 200 }) ?? '', /bs_margin_budget/)
  assert.match(liveBudgetRefusal('B', { bs_enabled: true, bs_strike_step: 200, bs_margin_budget: 0 }) ?? '', /'B'/)
  assert.equal(liveBudgetRefusal('B', { bs_enabled: true, bs_strike_step: 200, bs_margin_budget: 1500 }), null)
  assert.equal(liveBudgetRefusal('B', { target_pnl: 25000 }), null, 'not a BULL-S book')
  assert.equal(liveBudgetRefusal('B', {}), null)
})

// ─────────────────────────────────────────────────────────────── over Mongo

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_laneA_bs_live_test'
const TOKEN = 'test-token-do-not-use-in-prod'
const NOW = Date.UTC(2026, 10, 3, 10, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let sink: NudgeSink | null = null
let base = ''
let available = false

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  const master = (): OptionMaster => new OptionMaster([])
  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle.db), live: new LiveRail(handle.db, []) },
    master: { current: master },
    marks: new StaticMarks({}, {}),
    clock: { now: () => NOW },
  })
  const gate = bearerGate(TOKEN)
  const apiDeps: ApiDeps = { db: handle.db, store, service, master: { current: master }, log: () => {}, now: () => NOW }
  server = createBridgeServer({
    gate,
    routes: [
      booksRoutes({ ...apiDeps, gate } as unknown as Parameters<typeof booksRoutes>[0]),
      deskRoutes({ ...apiDeps, gate }),
    ],
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  sink = await startNudgeSink()
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  await store.ensureIndexes()
})

const TAG = 'BTC-2026-11-04-bull-s-daily'
const create = (mode: 'paper' | 'live', budget?: number) => ({
  tag: TAG,
  symbol: 'BHEL',
  expiry: '2026-11-04',
  mode,
  variant: 'hold-recycle-r',
  dials: { bs_enabled: true, bs_strike_step: 200, ...(budget === undefined ? {} : { bs_margin_budget: budget }) },
})

itMongo('arming LIVE on a BULL-S book with no budget is a 400 naming bs_margin_budget, before any password', async () => {
  const made = await call('POST', '/v1/desk/books/registry', create('live'))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const arm = await call('PATCH', `/v1/desk/strategies/${TAG}`, { modes: { live: { enabled: true } } })
  assert.equal(arm.status, 400, JSON.stringify(arm.body))
  assert.match(String(arm.body['error']), /bs_margin_budget/)
  const start = await call('POST', `/v1/desk/books/registry/${TAG}/start`, { mode: 'live' })
  assert.equal(start.status, 400, JSON.stringify(start.body))
  assert.match(String(start.body['error']), /bs_margin_budget/)
  assert.equal((await store.getBook(TAG, 'live'))?.desired, 'stopped', 'nothing was started')
})

itMongo('with a budget set, the arm goes on to the password gate and the start goes through', async () => {
  const made = await call('POST', '/v1/desk/books/registry', create('live', 1500))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const arm = await call('PATCH', `/v1/desk/strategies/${TAG}`, { modes: { live: { enabled: true } } })
  assert.equal(arm.status, 403, 'past the budget check: a machine token cannot re-authenticate')
  const start = await call('POST', `/v1/desk/books/registry/${TAG}/start`, { mode: 'live' })
  assert.equal(start.status, 200, JSON.stringify(start.body))
})

itMongo('a dials PATCH on a LIVE BULL-S book cannot take the budget to 0; raising it goes on to the password', async () => {
  const made = await call('POST', '/v1/desk/books/registry', create('live', 1500))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const zero = await call('PATCH', `/v1/desk/books/registry/${TAG}`, { mode: 'live', dials: { bs_margin_budget: 0 } })
  assert.equal(zero.status, 400, JSON.stringify(zero.body))
  assert.match(String(zero.body['error']), /bs_margin_budget/)
  const more = await call('PATCH', `/v1/desk/books/registry/${TAG}`, { mode: 'live', dials: { bs_margin_budget: 2000 } })
  assert.equal(more.status, 403, JSON.stringify(more.body))
})

itMongo('the reconcile halt engages a LIVE-scoped kill switch and writes desk-alerts; the operator release clears the scope', async () => {
  const guard = reconcileHaltFor({ db: handle!.db, store, now: () => NOW, log: () => {} }, 'live')
  const off = {
    asOf: NOW, day: '2026-11-03', mode: 'live' as const, comparable: true, reason: '', brokerAsOf: NOW,
    symbols: [{ symbol: 'C-BTC-80000-041126', broker: -30, books: -50, ledger: 0, agree: false, claimedBy: [TAG] }],
    divergent: ['C-BTC-80000-041126'], unattributable: [], unmeasurable: [], intervalMs: 300_000,
  }
  await guard.observe(off)
  await guard.observe(off)
  const halt = await store.loadKillSwitch()
  assert.equal(halt.enabled, true)
  assert.equal(halt.scope, 'live')
  assert.equal(halt.setBy, 'positions-compare')
  const alerts = await handle!.db.collection('desk-alerts').find({}).toArray()
  assert.deepEqual(alerts.map((a) => a['severity']).sort(), ['critical', 'warn'])
  // The operator releases it the usual way; a later manual engage holds every rail.
  await store.saveKillSwitch({ enabled: false, reason: '', setBy: 'op', setAt: NOW })
  await store.saveKillSwitch({ enabled: true, reason: 'manual', setBy: 'op', setAt: NOW })
  assert.equal((await store.loadKillSwitch()).scope, undefined)
  await handle!.db.collection('desk-alerts').deleteMany({})
})

itMongo('PAPER is never asked: a paper BULL-S book with no budget starts', async () => {
  const made = await call('POST', '/v1/desk/books/registry', create('paper'))
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const start = await call('POST', `/v1/desk/books/registry/${TAG}/start`, { mode: 'paper' })
  assert.equal(start.status, 200, JSON.stringify(start.body))
})
