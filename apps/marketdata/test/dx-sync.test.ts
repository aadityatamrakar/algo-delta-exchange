/**
 * The Delta products sync and settlement writer against a fake REST client
 * and in-memory collections. The normaliser is the real `toInstrumentRows`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toInstrumentRows, type DxProduct } from '@algomaker/dx'
import {
  DX_SETTLEMENT_WAIT_MS,
  dxSyncDue,
  planDxSync,
  runDxSync,
  type DxCollection,
  type DxSyncDeps,
} from '../src/dx-sync.ts'
import { loadStoredInstruments } from '../src/sync-runner.ts'
import type { DxRestPort } from '../src/dx-ports.ts'

/** Enough of a Mongo collection for the sync: `find({})`, upserts, `$in` deletes. */
class FakeCollection implements DxCollection {
  docs: Record<string, unknown>[] = []
  readonly key: string
  constructor(key: string) {
    this.key = key
  }
  find(f: Record<string, unknown>) {
    const ids = (f[this.key] as { $in?: unknown[] } | undefined)?.$in
    const hit = ids === undefined ? this.docs : this.docs.filter((d) => ids.includes(d[this.key]))
    return { toArray: async () => hit.map((d) => ({ ...d })) }
  }
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }) {
    const k = filter[this.key]
    const hit = this.docs.find((d) => d[this.key] === k)
    if (hit !== undefined) {
      Object.assign(hit, update['$set'] ?? {})
      return
    }
    if (options?.upsert !== true) return
    this.docs.push({ [this.key]: k, ...(update['$setOnInsert'] as object), ...(update['$set'] as object) })
  }
  async deleteMany(filter: Record<string, unknown>) {
    const ids = (filter[this.key] as { $in: unknown[] }).$in
    this.docs = this.docs.filter((d) => !ids.includes(d[this.key]))
  }
  async createIndex() {}
}

const NOW = Date.UTC(2026, 10, 4, 13, 0) // 4 Nov 13:00 UTC: the 04-11 expiry settled an hour ago

function product(id: number, strike: number, cp: 'C' | 'P', expiry: string, over: Partial<DxProduct> = {}): DxProduct {
  const [y, m, d] = expiry.split('-')
  return {
    id,
    symbol: `${cp}-BTC-${strike}-${d}${m}${y!.slice(2)}`,
    contract_type: cp === 'C' ? 'call_options' : 'put_options',
    state: 'live',
    strike_price: String(strike),
    settlement_time: `${expiry}T12:00:00Z`,
    settlement_price: null,
    contract_value: '0.001',
    tick_size: '0.1',
    underlying_asset: { id: 1, symbol: 'BTC' },
    spot_index: { id: 14, symbol: '.DEXBTUSD', tick_size: '0.5' },
    ...over,
  }
}

function rig(opts: {
  live: DxProduct[]
  expired?: DxProduct[]
  stored?: DxProduct[]
  bookTokens?: number[]
  registry?: { symbol: string; expiry: string }[]
  nowMs?: number
}) {
  const instruments = new FakeCollection('instrument_token')
  const settlements = new FakeCollection('_id')
  for (const r of toInstrumentRows(opts.stored ?? [])) instruments.docs.push({ ...r })
  const calls: Parameters<DxRestPort['products']>[0][] = []
  const logs: string[] = []
  const rest: DxRestPort = {
    products: async (q) => {
      calls.push(q)
      if (q.states?.includes('live')) return opts.live
      return (opts.expired ?? []).filter((p) => q.expiryDate === undefined || p.settlement_time?.startsWith(q.expiryDate))
    },
  }
  const deps: DxSyncDeps = {
    rest,
    normalise: toInstrumentRows,
    instruments,
    settlements,
    loadStored: () => loadStoredInstruments(instruments),
    bookTokens: async () => new Set(opts.bookTokens ?? []),
    registryChains: async () => opts.registry ?? [],
    nowMs: () => opts.nowMs ?? NOW,
    log: (m) => void logs.push(m),
  }
  return { deps, instruments, settlements, calls, logs }
}

const tokens = (c: FakeCollection) => c.docs.map((d) => d['instrument_token']).sort((a, b) => Number(a) - Number(b))

test('sync writes every live BTC option and the .DEXBTUSD spot row', async () => {
  const r = rig({ live: [product(201, 76600, 'C', '2026-11-05'), product(202, 76600, 'P', '2026-11-05')] })
  const res = await runDxSync(r.deps)
  assert.equal(res.options, 2)
  assert.deepEqual(tokens(r.instruments), [14, 201, 202])
  const call = r.instruments.docs.find((d) => d['instrument_token'] === 201)
  assert.deepEqual(
    { type: call?.['instrument_type'], strike: call?.['strike'], expiry: call?.['expiry'], lot: call?.['lot_size'], name: call?.['name'] },
    { type: 'CE', strike: 76600, expiry: '2026-11-05', lot: 0.001, name: 'BTC' },
  )
  const spot = r.instruments.docs.find((d) => d['instrument_token'] === 14)
  assert.equal(spot?.['tradingsymbol'], '.DEXBTUSD')
  assert.deepEqual(r.calls[0], { contractTypes: ['call_options', 'put_options'], states: ['live'], underlying: ['BTC'] })
})

test('an expired row is pruned once settled and unreferenced; a book leg or a registry row keeps it', async () => {
  const old = [
    product(101, 70000, 'C', '2026-11-04'), // settled, unreferenced → pruned
    product(102, 70000, 'P', '2026-11-04'), // held by an open desk-books leg → kept
  ]
  const older = product(90, 65000, 'C', '2026-11-03') // named by a registry row → kept
  const r = rig({
    live: [product(201, 76600, 'C', '2026-11-05')],
    stored: [...old, older],
    expired: [
      { ...old[0]!, state: 'expired', settlement_price: '0' },
      { ...old[1]!, state: 'expired', settlement_price: '512.3' },
      { ...older, state: 'expired', settlement_price: '0' },
    ],
    bookTokens: [102],
    registry: [{ symbol: 'BTC', expiry: '2026-11-03' }],
  })
  const res = await runDxSync(r.deps)
  assert.deepEqual(tokens(r.instruments), [14, 90, 102, 201])
  assert.deepEqual([...res.plan.retainedExpired].sort((a, b) => a - b), [90, 102])
  assert.equal(res.settlementsWritten, 3)
})

test('a settled product writes one dx-settlements row, and a re-run never rewrites it', async () => {
  const exp = product(101, 70000, 'C', '2026-11-04')
  const r = rig({
    live: [product(201, 76600, 'C', '2026-11-05')],
    stored: [exp],
    expired: [{ ...exp, state: 'expired', settlement_price: '6588.2' }],
    bookTokens: [101],
  })
  await runDxSync(r.deps)
  assert.deepEqual(r.settlements.docs, [
    { _id: 101, symbol: 'C-BTC-70000-041126', expiry: '2026-11-04', price: 6588.2, publishedAt: NOW },
  ])
  const expiredCall = r.calls.find((c) => c.states?.includes('expired'))
  assert.deepEqual(expiredCall, {
    contractTypes: ['call_options', 'put_options'],
    states: ['expired', 'settled'],
    underlying: ['BTC'],
    expiryDate: '2026-11-04',
  })

  // Delta later reports something else: the booked row stands, and no second fetch is made.
  const before = r.calls.length
  const again = await runDxSync(r.deps)
  assert.equal(again.settlementsWritten, 0)
  assert.equal(r.settlements.docs.length, 1)
  assert.equal(r.settlements.docs[0]?.['price'], 6588.2)
  assert.equal(r.calls.length, before + 1, 'only the live listing')
})

test('an unpublished settlement keeps the row and is retried; a day later the row goes, with a warning', async () => {
  const exp = product(101, 70000, 'C', '2026-11-04')
  const r = rig({
    live: [product(201, 76600, 'C', '2026-11-05')],
    stored: [exp],
    expired: [{ ...exp, state: 'expired', settlement_price: null }],
  })
  const first = await runDxSync(r.deps)
  assert.equal(first.settlementsWritten, 0)
  assert.equal(r.settlements.docs.length, 0, 'never invented')
  assert.ok(tokens(r.instruments).includes(101))

  const late = rig({
    live: [product(201, 76600, 'C', '2026-11-05')],
    stored: [exp],
    expired: [{ ...exp, state: 'expired', settlement_price: null }],
    nowMs: Date.UTC(2026, 10, 4, 12) + DX_SETTLEMENT_WAIT_MS,
  })
  const res = await runDxSync(late.deps)
  assert.deepEqual(res.plan.unsettledDropped, [101])
  assert.ok(!tokens(late.instruments).includes(101))
  assert.ok(late.logs.some((l) => l.includes('NO published settlement')))
})

test('a row is not expired before its 12:00 UTC instant, even off the listing', () => {
  const [row] = toInstrumentRows([product(101, 70000, 'C', '2026-11-04')])
  const plan = planDxSync({
    listed: [],
    existing: [row!],
    nowMs: Date.UTC(2026, 10, 4, 11, 59, 59),
    referenced: () => false,
    settled: new Set([101]),
  })
  assert.deepEqual(plan.toDelete, [])
  const after = planDxSync({ ...{ listed: [], existing: [row!], referenced: () => false, settled: new Set([101]) }, nowMs: Date.UTC(2026, 10, 4, 12) })
  assert.deepEqual(after.toDelete, [101])
})

test('a listing with no BTC option throws and leaves the stored master untouched', async () => {
  const r = rig({ live: [], stored: [product(201, 76600, 'C', '2026-11-05')] })
  const before = JSON.stringify(r.instruments.docs)
  await assert.rejects(() => runDxSync(r.deps), /no BTC option/)
  assert.equal(JSON.stringify(r.instruments.docs), before)
})

test('dxSyncDue: at boot, every 15 minutes, and on the first pass after 12:00 UTC', () => {
  const noon = Date.UTC(2026, 10, 4, 12)
  assert.equal(dxSyncDue(noon - 3_600_000, 0), true)
  assert.equal(dxSyncDue(noon - 600_000, noon - 1_500_000), true)
  assert.equal(dxSyncDue(noon - 600_000, noon - 700_000), false)
  // Synced at 11:55; at 12:00:30 not yet (the post-settlement delay is a minute), at 12:01 yes.
  assert.equal(dxSyncDue(noon + 30_000, noon - 300_000), false)
  assert.equal(dxSyncDue(noon + 60_000, noon - 300_000), true)
  // Once done after the instant, it is not due again until the cadence.
  assert.equal(dxSyncDue(noon + 120_000, noon + 61_000), false)
})
