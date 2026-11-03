/**
 * The objective search counts what the job expiry's series already booked
 * (the operator's ruling on Series P&L): `bookPlanBase` reads it off the
 * BookView, the job carries it to the worker, and max loss, the run's POP and
 * EV move by it. A view with no series searches on 0 and says so, as a repair.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMultiMonthView, scorePlan } from '@algomaker/payoff'
import { baselineOf, bookedCounted, bookPlanBase, buildPlan, type BookPlanBase, type PlanningDeps } from '../src/agent/planning.ts'
import { payoffBaseline } from '../src/agent/tools/adjust.ts'
import type { ToolCtx } from '../src/agent/tools/ctx.ts'
import { comparePlans, PlanCache, toSeriesBasis } from '../src/agent/tools/plans.ts'
import { bookView } from '../src/analytics/book-view.ts'
import { SEED_RATES } from '../src/analytics/charges.ts'
import { planSearchContextOf } from '../src/analytics/plan-search-job.ts'
import { REALISED_NOT_COUNTED } from '../src/analytics/repair.ts'
import type { TraderQuote, TradersQuotes } from '../src/market/quotes.ts'
import { legKey, type BookView, type TraderLeg } from '../src/types.ts'
import { OCT, TCS_OCT_FUT, TCS_SPOT, octCE, octPE, testMaster } from './fixtures/master.ts'

const MASTER = testMaster()
const NOW = Date.UTC(2026, 9, 19, 5, 0)          // Mon 10:30 IST
const PRICES = new Map<number, number>([[TCS_SPOT, 3490], [TCS_OCT_FUT, 3500]])
for (const k of [3400, 3450, 3500, 3550, 3600]) { PRICES.set(octCE(k), Math.max(5, 3500 - k + 45)); PRICES.set(octPE(k), Math.max(5, k - 3500 + 45)) }
const quotes: TradersQuotes = {
  quote: (t): TraderQuote | null => {
    const price = PRICES.get(t)
    return price === undefined ? null : { price, bid: price - 0.5, ask: price + 0.5, oi: 100, volume: 10, asOf: NOW, ageMs: 0 }
  },
  feedAlive: () => true,
}

function optLeg(strike: number, optType: 'CE' | 'PE', qty: number, avgPrice: number): TraderLeg {
  const c = { clientCode: 'C1', instrument: 'option' as const, stock: 'TCS', expiry: OCT, strike, optType }
  return { trader: 'ravi', ...c, qty, avgPrice, source: 'odin', key: legKey(c), token: null, note: '', updatedAt: 0 }
}
const LEGS = [optLeg(3500, 'CE', -350, 40), optLeg(3500, 'PE', -350, 42)]

/** A 3400 PE sold at 12 and bought back at 40: -4,900 booked in the Oct series. */
const CLOSED = (['Sell', 'Buy'] as const).map((side, n) => ({
  clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: OCT, strike: 3400, optType: 'PE' as const,
  side, qty: 175, price: side === 'Sell' ? 12 : 40, day: n === 0 ? '2026-10-14' : '2026-10-15', time: Date.parse(`2026-10-1${4 + n}T10:00:00+05:30`), seq: n, orderNo: `o${n}`,
}))

function viewOf(series: boolean): BookView {
  return bookView({
    stock: 'TCS', legs: LEGS, master: MASTER, quotes, asOf: NOW, watcher: null, files: [], historyFrom: null, payoff: buildMultiMonthView,
    ...(series ? { series: { trader: 'ravi', trades: CLOSED, balance: null, historyFrom: '2026-09-01', rates: SEED_RATES } } : {}),
  })
}

const deps = (view: BookView): PlanningDeps => ({
  bookView: async () => view, master: () => MASTER, quotes, legs: { version: () => 4 },
  span: { span: () => null, exposure: () => null }, now: () => NOW,
}) as unknown as PlanningDeps

async function baseOf(view: BookView): Promise<BookPlanBase> {
  const b = await bookPlanBase(deps(view), 'ravi', 'TCS', NOW)
  assert.ok('ctx' in b, JSON.stringify(b))
  return b
}

test('the search counts the job expiry\'s booked P&L: the job carries it, and the run\'s max loss moves by it', async () => {
  const view = viewOf(true)
  assert.equal(view.series?.[0]?.booked, -4900)
  const b = await baseOf(view)
  assert.equal(b.job.realised, -4900)
  assert.equal(b.ctx.realised, -4900)
  assert.equal(planSearchContextOf(structuredClone({ ...b.job, spec: {} as never, allowClose: false })).realised, -4900, 'it crosses to the worker')
  assert.ok(b.warnings.includes(bookedCounted(OCT, -4900)))
  assert.equal(b.warnings.includes(REALISED_NOT_COUNTED), false)
  assert.equal(bookedCounted(OCT, -4900), 'P&L already booked in the 2026-10-27 series (-₹4,900) is counted in max loss, POP and EV')

  const plain = await baseOf(viewOf(false))
  assert.equal(plain.job.realised, undefined)
  assert.equal(plain.ctx.realised, 0)
  assert.ok(plain.warnings.includes(REALISED_NOT_COUNTED), 'no series: the repair\'s line stays')
  const counted = scorePlan(b.ctx, [], null)
  const without = scorePlan(plain.ctx, [], null)
  assert.ok(counted !== null && without !== null)
  assert.ok(Math.abs(counted.maxLoss - (without.maxLoss - 4900)) < 1e-6, `${counted.maxLoss} vs ${without.maxLoss}`)
  assert.equal(counted.credit, without.credit, 'credit is the plan\'s own cash: realised stays out of it')
})

test('a series that booked nothing drops the line: nothing is left out', async () => {
  const view = bookView({
    stock: 'TCS', legs: LEGS, master: MASTER, quotes, asOf: NOW, watcher: null, files: [], historyFrom: null, payoff: buildMultiMonthView,
    series: { trader: 'ravi', trades: [], balance: null, historyFrom: null, rates: SEED_RATES },
  })
  const b = await baseOf(view)
  assert.deepEqual([b.job.realised, b.ctx.realised], [0, 0])
  assert.equal(b.warnings.some((w) => w.startsWith('P&L already booked')), false)
})

test('a plan remembers its basis: a search counts the series\' booked P&L, a view with no series counts none', async () => {
  const d = { charges: { get: async () => SEED_RATES } } as unknown as Pick<PlanningDeps, 'charges'>
  const plan = async (b: BookPlanBase) => (await buildPlan(d, 'ravi', b, {
    planId: '', rank: 1, moves: [], metrics: scorePlan(b.ctx, [], null)!, baseline: baselineOf(b, null)!, flags: [], binding: [], title: 't', source: 'search', at: NOW,
  })).cache
  const booked = await plan(await baseOf(viewOf(true)))
  assert.deepEqual([booked.realisedBasis, booked.seriesBooked], [-4900, -4900])
  const plain = await plan(await baseOf(viewOf(false)))
  assert.deepEqual([plain.realisedBasis, plain.seriesBooked], [0, null])
})

test('compare_plans puts every plan on the series basis: a repair (booked 0) and a search (booked in) differ by nothing but the plan', async () => {
  const plans = new PlanCache()
  const at = NOW
  const common = { stock: 'TCS', title: 't', lines: [], flags: [], whatIf: [], at }
  plans.add({ ...common, source: 'repair', metrics: { maxLoss: -100_000, worstShock: -40_000, popPct: 61 }, realisedBasis: 0, seriesBooked: -51_344 })
  plans.add({ ...common, source: 'search', metrics: { maxLoss: -151_344, worstShock: -91_344, pop: 55 }, realisedBasis: -51_344, seriesBooked: -51_344 })
  plans.add({ ...common, source: 'search', metrics: { maxLoss: -90_000 } })   // cached before the series: not known
  plans.add({ ...common, source: 'search', metrics: { maxLoss: -95_000 }, realisedBasis: 0, seriesBooked: null })   // a view with no series
  const ctx = { plans, deps: { now: () => NOW, quotes } } as unknown as ToolCtx
  const out = await comparePlans.run(ctx, { planIds: ['P1', 'P2', 'P3', 'P4'] })
  const r = out.result as { metrics: string[]; basis: string; plans: { bookedIncluded: number | null; values: (number | null)[] }[] }
  const col = (m: string) => r.plans.map((p) => p.values[r.metrics.indexOf(m)])
  assert.deepEqual(col('maxLoss'), [-151_344, -151_344, -90_000, -95_000])
  assert.deepEqual(col('worstShock'), [-91_344, -91_344, null, null])
  assert.deepEqual(col('popPct'), [61, null, null, null], 'a probability is never shifted')
  assert.deepEqual(r.plans.map((p) => p.bookedIncluded), [-51_344, -51_344, null, null])
  assert.match(r.basis, /series basis/)
  assert.deepEqual([toSeriesBasis({}), toSeriesBasis({ realisedBasis: 0, seriesBooked: -1 }), toSeriesBasis({ realisedBasis: -1, seriesBooked: -1 })], [null, -1, 0])
})

test('a book the search cannot price gets its payoff\'s baseline on the series basis: booked added to the run figures, POP the open legs\'', () => {
  const view = viewOf(true)
  const s = view.payoff!.summary
  const b = payoffBaseline(view, 175, 175)
  assert.deepEqual([b.maxLoss, b.worstShock, b.pop], [Math.round((s.maxLoss - 4900) * 100) / 100, Math.round((s.worstShock - 4900) * 100) / 100, Math.round(s.pop * 1e4) / 100])
  const plain = payoffBaseline(viewOf(false), 175, 175)
  assert.equal(plain.maxLoss, Math.round(s.maxLoss * 100) / 100)
  assert.equal(b.deltaLots, 1)
})
