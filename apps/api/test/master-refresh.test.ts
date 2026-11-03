import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InstrumentRow } from '@algomaker/instruments'
import { MasterRefresher, collectionFingerprint } from '../src/master-refresh.ts'
import { QuoteCache } from '../src/marks.ts'
import { buildChain, chainExpiries } from '../src/chain.ts'

/** The 3 Nov BTC listing, in miniature: three expiries, CE and PE at each strike. */
const EXPIRIES = ['2026-11-03', '2026-11-06', '2026-11-27']
const STRIKES = [77400, 77600, 77800]

function listing(): InstrumentRow[] {
  const rows: InstrumentRow[] = []
  let token = 161000
  for (const expiry of EXPIRIES) {
    for (const type of ['CE', 'PE'] as const) {
      for (const strike of STRIKES) {
        rows.push({
          instrument_token: token++,
          tradingsymbol: `${type === 'CE' ? 'C' : 'P'}-BTC-${strike}-${expiry}`,
          name: 'BTC',
          expiry,
          strike,
          tick_size: 0.1,
          lot_size: 0.001,
          instrument_type: type,
          segment: 'DX-OPT',
          exchange: 'DELTA',
        })
      }
    }
  }
  return rows
}

/** A collection a sync is writing one upsert at a time. */
function syncingCollection(all: InstrumentRow[]) {
  let written = 0
  return {
    advance(n: number): void {
      written = Math.min(all.length, written + n)
    },
    source: {
      load: async () => all.slice(0, written),
      fingerprint: async () => `${written}|${written === 0 ? '' : all[written - 1]!.instrument_token}`,
    },
  }
}

test('a master loaded mid-sync heals on the next change check — every expiry and every PE returns', async () => {
  const all = listing()
  const col = syncingCollection(all)
  // The api boots while the sync has written only the first expiry's CEs and one PE.
  col.advance(STRIKES.length + 1)
  const refresher = new MasterRefresher(col.source)
  await refresher.reload('boot')

  const marks = new QuoteCache({ now: () => 1_000_000 })
  // The feed quotes every token regardless of what the api's master lists.
  for (const r of all) marks.update(r.instrument_token, 500, 999_000, { bid: 499, ask: 501 })
  const deps = () => ({ master: refresher.current(), marks, now: () => 1_000_000 })

  // The defect: one expiry, and PEs blank although their ticks are cached.
  assert.deepEqual(chainExpiries(refresher.current(), 'BTC').expiries, ['2026-11-03'])
  const partial = buildChain(deps(), 'BTC', '2026-11-03')
  assert.equal(partial.rows.filter((r) => r.PE === null).length, STRIKES.length - 1)

  // Nothing written since: no reload.
  assert.equal(await refresher.reloadIfChanged(), false)

  col.advance(all.length)
  assert.equal(await refresher.reloadIfChanged(), true)

  assert.deepEqual(chainExpiries(refresher.current(), 'BTC').expiries, EXPIRIES)
  for (const expiry of EXPIRIES) {
    const chain = buildChain(deps(), 'BTC', expiry)
    assert.equal(chain.rows.length, STRIKES.length, expiry)
    for (const row of chain.rows) {
      assert.equal(row.CE?.bid, 499, `${expiry} ${row.strike} CE`)
      assert.equal(row.PE?.bid, 499, `${expiry} ${row.strike} PE`)
      assert.ok(row.peContract !== undefined, `${expiry} ${row.strike} peContract`)
    }
  }
  assert.equal(await refresher.reloadIfChanged(), false)
})

test('the fingerprint is read before the rows, so a sync finishing during the load is still caught', async () => {
  const all = listing()
  const col = syncingCollection(all)
  col.advance(4)
  let finished = false
  const source = {
    fingerprint: col.source.fingerprint,
    // The sync writes its last 6 rows between the first fingerprint read and the load.
    load: async () => {
      if (!finished) col.advance(6)
      finished = true
      return col.source.load()
    },
  }
  const refresher = new MasterRefresher(source)
  await refresher.reload('boot')
  assert.equal(refresher.current().optionCount, 10)
  // The fingerprint the load stored is the earlier one, so the check reloads once.
  assert.equal(await refresher.reloadIfChanged(), true)
  assert.equal(await refresher.reloadIfChanged(), false)
})

test('the collection fingerprint is the row count and the newest _id', async () => {
  const calls: string[] = []
  const col = {
    countDocuments: async () => {
      calls.push('count')
      return 534
    },
    find: (_f: Record<string, never>, o: { sort: { _id: -1 }; limit: 1 }) => {
      calls.push(`find sort=${o.sort._id} limit=${o.limit}`)
      return { toArray: async () => [{ _id: 'abc' }] }
    },
  }
  assert.equal(await collectionFingerprint(col), '534|abc')
  assert.deepEqual(calls, ['count', 'find sort=-1 limit=1'])
})
