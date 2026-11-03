/**
 * The objective search in the repair pool (spec §4, R10): a plan search takes
 * one of the same two slots as a repair, keeps its own minute of results and
 * its own flight per book, and crosses to the same worker threads as plain
 * data. repair-pool.test.ts, untouched, still pins the repair side.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presetObjective, searchPlans, type PlanSearchResult, type RepairPlan } from '@algomaker/payoff'
import { isPlanSearchJob, planSearchContextOf, type PlanSearchJob } from '../src/analytics/plan-search-job.ts'
import { RepairPool, workerRunner } from '../src/analytics/repair-pool.ts'
import { lookupsOf, type RepairJob } from '../src/analytics/repair.ts'
import { tcsJob as repairJob } from './fixtures/repair-book.ts'

const result = (tag: string): PlanSearchResult => ({ refused: tag } as unknown as PlanSearchResult)
const job = (chain: RepairJob, tag = 'x'): PlanSearchJob => ({
  kind: 'plan-search', chain, futureMark: chain.future + 5, lotSize: 175,
  quotes: [{ strike: 3500, type: 'CE', bid: 40, ask: 41, stale: false }],
  span: null, spec: { tag } as never, allowClose: false,
})

/** A runner whose calls wait until released. */
function held<J, R>(out: (j: J) => R) {
  const calls: { job: J; release(): void }[] = []
  return {
    calls,
    run: (j: J): Promise<R> => new Promise((resolve) => { calls.push({ job: j, release: () => resolve(out(j)) }) }),
  }
}

test('a plan search waits for the slot a repair holds, and runs when it is released', async () => {
  const repairs = held<RepairJob, readonly RepairPlan[]>(() => [])
  const searches = held<PlanSearchJob, PlanSearchResult>((j) => result(String((j.spec as unknown as { tag: string }).tag)))
  const pool = new RepairPool({ run: repairs.run, runSearch: searches.run, now: () => 0, maxRunning: 1 })
  const chain = repairJob()
  const r = pool.request('ravi|TCS', 'k1', chain)
  const s = pool.search('ravi|TCS', 'k1', job(chain, 'first'))
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(repairs.calls.length, 1)
  assert.equal(searches.calls.length, 0, 'the one slot is the repair\'s')
  assert.equal(pool.running(), 1)
  repairs.calls[0]!.release()
  assert.ok(!('busy' in (await r)))
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(searches.calls.length, 1, 'the slot passed to the waiting search')
  searches.calls[0]!.release()
  const a = await s
  assert.ok(!('busy' in a))
  assert.equal((a as { result: PlanSearchResult }).result.refused, 'first')
  assert.equal(pool.running(), 0)
})

test('plan searches keep their own minute and their own flight per book; a repair under the same key is not a hit', async () => {
  let clock = 0
  const searches = held<PlanSearchJob, PlanSearchResult>((j) => result(String((j.spec as unknown as { tag: string }).tag)))
  const repairs = held<RepairJob, readonly RepairPlan[]>(() => [])
  const pool = new RepairPool({ run: repairs.run, runSearch: searches.run, now: () => clock })
  const chain = repairJob()
  const first = pool.search('ravi|TCS', 'k1', job(chain, 'a'))
  const shared = pool.search('ravi|TCS', 'k1', job(chain, 'b'))
  const other = await pool.search('ravi|TCS', 'k2', job(chain, 'c'))
  assert.ok('busy' in other, 'another key while one is in flight: busy')
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(searches.calls.length, 1, 'the same key shares the flight')
  searches.calls[0]!.release()
  const [x, y] = await Promise.all([first, shared])
  assert.equal((x as { result: PlanSearchResult }).result.refused, 'a')
  assert.equal((y as { result: PlanSearchResult }).result.refused, 'a')
  clock = 30_000
  const cached = await pool.search('ravi|TCS', 'k1', job(chain, 'd'))
  assert.equal((cached as { cached: boolean }).cached, true)
  const repair = pool.request('ravi|TCS', 'k1', chain)
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(repairs.calls.length, 1, 'a repair under the same key runs: each kind keeps its own results')
  repairs.calls[0]!.release()
  await repair
  clock = 60_000
  pool.search('ravi|TCS', 'k1', job(chain, 'e'))
  await new Promise((res) => setTimeout(res, 10))
  assert.equal(searches.calls.length, 2, 'past the minute it runs again')
  searches.calls[1]!.release()
})

test('a pool given no search runner refuses a plan search, and its repairs are untouched', async () => {
  const pool = new RepairPool({ run: async () => [], now: () => 0 })
  await assert.rejects(pool.search('ravi|TCS', 'k', job(repairJob())), /runs no plan search/)
  assert.ok(!('busy' in (await pool.request('ravi|TCS', 'k', repairJob()))))
  assert.equal(pool.running(), 0)
})

test('the job rebuilds the search context in the worker the way a repair rebuilds its lookups', () => {
  const chain = repairJob()
  const j = job(chain)
  assert.equal(isPlanSearchJob(j), true)
  assert.equal(isPlanSearchJob(chain), false)
  const ctx = planSearchContextOf(structuredClone(j))
  const ref = lookupsOf(chain)
  for (const s of chain.strikes.slice(0, 10)) {
    assert.equal(ctx.priceOf(s.strike, s.type), ref.priceOf(s.strike, s.type))
    assert.equal(ctx.ivOf(s.strike, s.type), ref.ivOf(s.strike, s.type))
  }
  assert.deepEqual(ctx.quoteOf?.(3500, 'CE'), { bid: 40, ask: 41, stale: false })
  assert.equal(ctx.quoteOf?.(3600, 'CE'), null)
  assert.deepEqual([ctx.future, ctx.expiry, ctx.realised, ctx.triggers, ctx.futureMark, ctx.lotSize], [chain.future, chain.expiry, 0, null, chain.future + 5, 175])
  assert.equal(ctx.marginOf, undefined, 'no SPAN file: the search ranks on SPAN-lite')
  const withSpan = planSearchContextOf(structuredClone({
    ...j, span: { symbol: 'TCS', file: { businessDate: '2026-10-19', settlement: '', created: '', commodities: new Map() } as never, rates: new Map([['TCS', 3.5]]), fixed: [] },
  }))
  assert.equal(typeof withSpan.marginOf, 'function', 'a SPAN file crosses as plain data and becomes marginOf')
  // the file prices none of these contracts: a part-figure is never ranked on — null, and the search falls back to SPAN-lite
  assert.equal(withSpan.marginOf?.(chain.legs), null)
  const noRate = planSearchContextOf(structuredClone({
    ...j, span: { symbol: 'TCS', file: { businessDate: '2026-10-19', settlement: '', created: '', commodities: new Map() } as never, rates: new Map(), fixed: [] },
  }))
  assert.equal(noRate.marginOf?.([]), null, 'no exposure rate: partial too')
})

test('the real worker runs searchPlans on the job — the same bytes as in this thread — and a repair on it still runs', async () => {
  const w = workerRunner(1)
  try {
    const chain = repairJob()
    const j: PlanSearchJob = { ...job(chain), spec: presetObjective(['neutralize-delta'], null, false), opts: { topN: 3 } }
    const out = await w.runSearch(j)
    assert.equal(out.refused, null)
    assert.ok(out.plans.length >= 1)
    assert.equal(out.plans.at(-1)?.key, 'baseline', 'the do-nothing baseline comes last')
    assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse(JSON.stringify(searchPlans(planSearchContextOf(j), j.spec, { topN: 3, allowClose: false }))))
    const plans = await w.run(repairJob())
    assert.ok(Array.isArray(plans) && plans.length > 0)
  } finally {
    await w.close()
  }
})
