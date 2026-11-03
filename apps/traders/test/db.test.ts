import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import type { Database } from '../../api/src/store.ts'
import { mtmTradesFilters } from '../src/analytics/mtm.ts'
import { seriesTradesFilter } from '../src/analytics/series-pnl.ts'
import { ForbiddenCollection, TradersDb } from '../src/db.ts'
import { connectSuite, suiteUrl, wipe } from './mongo.ts'

interface Call { collection: string; method: string; args: unknown[] }

/** A Database that records every call and answers nothing. */
function fakeDatabase(): { db: Database; calls: Call[] } {
  const calls: Call[] = []
  const db = {
    collection(name: string) {
      return new Proxy({}, {
        get: (_t, method: string) => async (...args: unknown[]) => { calls.push({ collection: name, method, args }); return null },
      })
    },
  } as unknown as Database
  return { db, calls }
}

test('collection() refuses every name outside the traders list', () => {
  const tdb = new TradersDb(fakeDatabase().db)
  for (const n of ['desk-books-registry', 'desk-subscriptions', 'instrument', 'positional', 'traders-unknown', 'Traders-users', ''])
    assert.throws(() => tdb.collection(n as never), ForbiddenCollection)
  assert.doesNotThrow(() => tdb.collection('traders-legs'))
})
test('desk() is read-only and limited to instrument and desk-marks', () => {
  const ro = new TradersDb(fakeDatabase().db).desk('instrument')
  for (const m of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'createIndex', 'drop'])
    assert.equal(m in ro, false)
  assert.throws(() => new TradersDb(fakeDatabase().db).desk('desk-books-registry' as never), ForbiddenCollection)
})
test('publishSubscription writes exactly the traders document', async () => {
  const fake = fakeDatabase()
  await new TradersDb(fake.db).publishSubscription([30, 10, 30, 20], 1000)
  assert.deepEqual(fake.calls, [{ collection: 'desk-subscriptions', method: 'updateOne',
    args: [{ source: 'traders' }, { $set: { source: 'traders', tokens: [10, 20, 30], updatedAt: 1000 } }, { upsert: true }] }])
})
test('ensureIndexes: a second active token for one trader is refused', async (t) => {
  const s = await connectSuite('db'); if (s === null) return skipUnlessMongo(t)
  await wipe(s.handle); await s.db.ensureIndexes()
  const tokens = s.db.collection('traders-tokens')
  await tokens.insertOne({ trader: 'a', tokenHash: 'h1', createdAt: 1, lastUsedAt: null, revokedAt: null })
  await assert.rejects(tokens.insertOne({ trader: 'a', tokenHash: 'h2', createdAt: 2, lastUsedAt: null, revokedAt: null }))
  await tokens.insertOne({ trader: 'a', tokenHash: 'h3', createdAt: 3, lastUsedAt: null, revokedAt: 4 })
  await s.handle.close()
})
/** Every index scan in an explain answer (the classic or the SBE shape), by its key pattern. */
function ixscans(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) ixscans(v, out)
  else if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>
    if (o['stage'] === 'IXSCAN' && typeof o['keyPattern'] === 'object') out.push(JSON.stringify(o['keyPattern']))
    for (const v of Object.values(o)) ixscans(v, out)
  }
  return out
}

test('ensureIndexes: a book\'s series and MTM trades are ranges on { trader, stock, expiry }, not the trader\'s history', async (t) => {
  const s = await connectSuite('db'); if (s === null) return skipUnlessMongo(t)
  await wipe(s.handle); await s.db.ensureIndexes()
  const trades = s.db.collection('traders-trades')
  // a long history in other stocks and expired months, the book's own few live trades
  let n = 0
  for (const stock of ['TCS', 'INFY', 'WIPRO', 'SBIN']) {
    for (const expiry of ['2026-07-30', '2026-08-27', '2026-09-29', '2026-10-27', '']) {
      for (let k = 0; k < 25; k++) {
        n++
        await trades.insertOne({ trader: 'a', tradeNo: `t${n}`, orderNo: `o${n}`, stock, expiry, instrument: expiry === '' ? 'share' : 'option', day: '2026-10-20', seq: n })
      }
    }
  }
  const raw = s.handle.db.collection('traders-trades') as unknown as { find(f: unknown): { explain(v?: string): Promise<unknown> } }
  const TRADES_INDEX = JSON.stringify({ trader: 1, stock: 1, expiry: 1 })
  try {
    for (const f of [seriesTradesFilter('a', 'TCS', '2026-10-22'), ...mtmTradesFilters('a', 'TCS', '2026-10-22')]) {
      const plan = await raw.find(f).explain('executionStats') as { queryPlanner: { winningPlan: unknown }; executionStats?: { totalKeysExamined?: number } }
      assert.deepEqual([...new Set(ixscans(plan.queryPlanner.winningPlan))], [TRADES_INDEX], JSON.stringify(f))
      assert.ok((plan.executionStats?.totalKeysExamined ?? 0) <= 26, `${JSON.stringify(f)}: ${plan.executionStats?.totalKeysExamined} keys`)
    }
  } finally {
    await s.handle.close()
  }
})

test('suiteUrl never names the desk database', () => {
  assert.match(suiteUrl('x'), /\/algomaker_dx_traders_test_(\w+_)?x$/)
  // The live desk, this clone's desk and a live-repo test database: the db name is what is refused, so no host:port is needed.
  for (const db of ['algomaker', 'algomaker_dx', 'algomaker_traders_test_x']) {
    process.env['DESK_TEST_MONGO'] = `mongodb://db.test/${db}`
    try { assert.throws(() => suiteUrl('x'), /never the desk database/, db) } finally { delete process.env['DESK_TEST_MONGO'] }
  }
})
