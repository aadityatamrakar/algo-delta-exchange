/**
 * The book page's positions/greeks marks for a demo-rail book come off the
 * Delta testnet (`demoDisplayExitQuotes`), production for everyone else, and a
 * demo leg the testnet has not quoted is priced at production and NAMED.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from './require-mongo.ts'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { QuoteCache, StaticMarks } from '../src/marks.ts'
import type { ActionsRequest } from '../src/contract.ts'

const URL = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_demomarks_test'
const EXPIRY = '2026-11-13'
const TAG = 'BTC-bull-s-demo'
let handle: MongoHandle | null = null
let store: DeskStore
let available = false
const clockMs = Date.UTC(2026, 10, 10, 8)

const TOKEN: Record<string, number> = { 'P-BTC-77000-131126': 501, 'C-BTC-77000-131126': 502 }
function master(): OptionMaster {
  const rows: InstrumentRow[] = Object.entries(TOKEN).map(([sym, token]) => ({
    instrument_token: token,
    tradingsymbol: sym,
    name: 'BTC',
    expiry: EXPIRY,
    strike: 77000,
    tick_size: 0.1,
    lot_size: 0.001,
    instrument_type: sym.startsWith('P') ? 'PE' : 'CE',
    segment: 'DX-OPT',
    exchange: 'DELTA',
  }))
  rows.push({
    instrument_token: 14,
    tradingsymbol: '.DEXBTUSD',
    name: 'BTC',
    expiry: '',
    strike: 0,
    tick_size: 0.5,
    lot_size: 0.001,
    instrument_type: 'INDEX',
    segment: 'DX-INDICES',
    exchange: 'DELTA',
  })
  return new OptionMaster(rows)
}

before(async () => {
  try {
    handle = await connectMongo(URL, { serverSelectionTimeoutMS: 2500 })
  } catch {
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  available = true
})
after(async () => {
  if (handle !== null) await handle.close()
})
beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  await store.ensureIndexes()
  await store.registerStrategy({ tag: TAG, kind: 'external', label: 'BULL-S demo', modes: { paper: { enabled: true } } }, clockMs)
})
function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

const req = (): ActionsRequest => ({
  symbol: 'BTC',
  expiry: EXPIRY,
  mode: 'paper',
  tag: TAG,
  decisionId: `d-${Math.random().toString(36).slice(2)}`,
  actions: [
    { op: 'open', ts: 'P#0', strike: 77000, type: 'PE', side: 'Sell', qty: 0.1 },
    { op: 'open', ts: 'C#0', strike: 77000, type: 'CE', side: 'Sell', qty: 0.1 },
  ],
})

function svc(venue: 'demo' | 'prod', prod: QuoteCache, demo: QuoteCache): BridgeService {
  return new BridgeService({
    store,
    rails: { paper: new PaperRail(handle!.db), live: new LiveRail(handle!.db, []) },
    master: { current: () => master() },
    marks: new StaticMarks({ 'P-BTC-77000-131126': 1800, 'C-BTC-77000-131126': 400 }, { BTC: 77000 }),
    displaySpot: () => 77000,
    displayExitQuotes: (token, exit) => prod.displayExitQuote(token, exit),
    demoDisplayExitQuotes: (token, exit) => demo.displayExitQuote(token, exit),
    marksVenue: () => venue,
    clock: { now: () => clockMs },
  })
}

function caches() {
  const prod = new QuoteCache({ now: () => clockMs })
  const demo = new QuoteCache({ now: () => clockMs })
  prod.update(501, 1783.5, clockMs, { bid: 1780, ask: 1783.5 })
  prod.update(502, 400, clockMs, { bid: 398, ask: 401 })
  demo.update(501, 1808.5, clockMs, { bid: 1805, ask: 1808.5 })
  return { prod, demo }
}

itMongo('a demo-rail book shows testnet marks; the C leg with no demo quote falls back and is named', async () => {
  const { prod, demo } = caches()
  await svc('demo', prod, demo).applyDecision(req())
  const pos = await svc('demo', prod, demo).positions(TAG, 'paper')
  assert.equal(pos.marksSource, 'delta-demo')
  assert.deepEqual(pos.marksFallback, ['C-BTC-77000-131126'])
  assert.equal(pos.quotes?.['P-BTC-77000-131126']?.ask, 1808.5, 'the testnet ask')
  assert.equal(pos.quotes?.['C-BTC-77000-131126']?.ask, 401, 'production, named above')
})

itMongo('a production book never reads the testnet', async () => {
  const { prod, demo } = caches()
  await svc('prod', prod, demo).applyDecision(req())
  const pos = await svc('prod', prod, demo).positions(TAG, 'paper')
  assert.equal(pos.marksSource, 'delta')
  assert.deepEqual(pos.marksFallback, [])
  assert.equal(pos.quotes?.['P-BTC-77000-131126']?.ask, 1783.5)
})
