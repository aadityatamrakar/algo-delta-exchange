/** The risk view's pure parts: aligned returns, beta and correlation, the percentile, the clusters, shockBook and the stress grid (spec 2026-10-24-traders-risk-design.md R2–R8). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PayoffLeg } from '@algomaker/payoff'
import { buildRiskView, rupees, type RiskBookInput } from '../src/analytics/portfolio-risk.ts'
import { alignedReturns, betaOf, clustersOf, percentile, type Close } from '../src/analytics/returns.ts'
import { shockBook } from '../src/analytics/shock.ts'
import type { BookSnapshot, PricedLeg } from '../src/analytics/snapshot.ts'
import type { TraderLeg } from '../src/types.ts'

const OCT = '2026-10-27'
const NOW = Date.UTC(2026, 9, 19, 4, 0, 0)   // Monday 19 Oct 09:30 IST
const near = (a: number | null | undefined, b: number, eps = 1e-9): void =>
  assert.ok(typeof a === 'number' && Math.abs(a - b) <= eps, `${a} vs ${b} (eps ${eps})`)

const day = (k: number): string => new Date(Date.UTC(2026, 0, 1) + k * 86_400_000).toISOString().slice(0, 10)
/** Deterministic returns in about ±1.5%. */
const noise = (k: number, seed = 1): number => Math.sin(k * 12.9898 * seed + seed * 78.233) * 0.015
/** Closes from log returns, starting at 100 on day(0). */
function series(returns: readonly number[], skip: ReadonlySet<number> = new Set()): Close[] {
  const out: Close[] = [{ date: day(0), close: 100 }]
  let c = 100
  returns.forEach((r, k) => { c *= Math.exp(r); if (!skip.has(k + 1)) out.push({ date: day(k + 1), close: c }) })
  return out
}
const RS = Array.from({ length: 300 }, (_, k) => noise(k))

test('beta of a doubled-return series is 2, its correlation 1; the last 250 returns are used', () => {
  const b = betaOf(series(RS.map((r) => 2 * r)), series(RS))
  near(b.beta, 2)
  near(b.corr, 1)
  assert.equal(b.days, 250)
})

test('under 60 aligned returns: no beta, no correlation', () => {
  const short = RS.slice(0, 59)
  assert.deepEqual(betaOf(series(short), series(short)), { beta: null, corr: null, days: 59 })
  assert.equal(betaOf(series(RS.slice(0, 60)), series(RS.slice(0, 60))).days, 60)
})

test('alignment keeps only the dates both have a close on: a missing day merges two days in both series', () => {
  const a = series(RS.slice(0, 70))
  const b = series(RS.slice(0, 70), new Set([10]))
  const al = alignedReturns([a, b])
  assert.equal(al.dates.length, 69)
  assert.equal(al.dates.includes(day(10)), false)
  const k = al.dates.indexOf(day(11))
  assert.equal(al.starts[k], day(9))
  near(al.returns[0]?.[k], (RS[9] as number) + (RS[10] as number))
  near(al.returns[1]?.[k], (RS[9] as number) + (RS[10] as number))
})

test('nearest-rank percentile on 100 known values', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i - 100).reverse()   // −1 … −100, unsorted
  assert.equal(percentile(xs, 1), -100)
  assert.equal(percentile(xs, 5), -96)
  assert.equal(percentile(xs, 50), -51)
  assert.equal(percentile(xs, 100), -1)
  assert.equal(percentile([], 5), null)
  assert.equal(percentile(xs, 0), null)
})

test('three stocks chained through ρ ≥ 0.6 are one cluster; a fourth apart is not listed', () => {
  const m = [
    [1, 0.7, 0.2, 0.1],
    [0.7, 1, 0.65, null],
    [0.2, 0.65, 1, 0.59],
    [0.1, null, 0.59, 1],
  ]
  assert.deepEqual(clustersOf(m), [[0, 1, 2]])
  assert.deepEqual(clustersOf([[1, 0.5], [0.5, 1]]), [])
})

/** A snapshot of hand-made legs on one month, spot `spot`, the month's future `fut`. */
function snapshot(stock: string, spot: number | null, fut: number, legs: readonly PayoffLeg[]): BookSnapshot {
  const priced = legs.map((p): PricedLeg => ({
    leg: { trader: 't', stock, instrument: p.instrument === 'future' && p.expiry === '' ? 'share' : p.instrument, expiry: p.expiry, strike: p.strike, optType: p.type, qty: p.qty, avgPrice: p.entry, clientCode: 'C1', source: 'manual', key: p.id, token: 1, note: '', updatedAt: 0 } as TraderLeg,
    payoff: p, ltp: null, bid: null, ask: null, syntheticFuture: null, marketIv: p.iv, ivSource: 'quote', ivFrom: null, illiquidAuto: false, lotSize: 100,
  }))
  return {
    trader: 't', stock, asOf: NOW, closed: false, spot, futures: { [OCT]: fut }, optionFutures: { [OCT]: fut }, nearExpiry: OCT, lastExpiry: OCT,
    nearFuture: null, basis: 'future', quotes: {}, expiries: [OCT], lotSize: 100, strikeStep: 50, atm: {}, chains: {}, legs: priced,
    unmatched: [], unmatchedKeys: [], warnings: [],
  }
}
const future = (qty: number, entry: number): PayoffLeg => ({ id: 'f', instrument: 'future', qty, strike: null, type: null, expiry: OCT, entry, iv: null })
const option = (id: string, type: 'CE' | 'PE', qty: number, strike: number, entry: number, iv: number): PayoffLeg =>
  ({ id, instrument: 'option', qty, strike, type, expiry: OCT, entry, iv })

test('shockBook on a one-leg future book: change = qty × the move, at any instant; vol does nothing', () => {
  const s = snapshot('TCS', 1000, 1000, [future(175, 990)])
  const later = { date: '2026-10-22', ms: Date.UTC(2026, 9, 22, 4, 0, 0) }
  const r = shockBook(s, [
    { spotFactor: 1, volPts: 0, at: null }, { spotFactor: 1.05, volPts: 0, at: null }, { spotFactor: 0.9, volPts: 10, at: null },
    { spotFactor: 1.02, volPts: 0, at: later }, { spotFactor: 0, volPts: 0, at: null },
  ])
  assert.equal(r.changes[0], 0)
  near(r.changes[1], 175 * 50, 1e-6)
  near(r.changes[2], 175 * -100, 1e-6)
  near(r.changes[3], 175 * 20, 1e-6)
  assert.equal(r.changes[4], null)   // a factor of 0 is no price
  assert.deepEqual(r.warnings, [])
})

test('shockBook with no spot is null throughout, said once', () => {
  const r = shockBook(snapshot('TCS', null, 1000, [future(175, 990)]), [{ spotFactor: 1.01, volPts: 0, at: null }])
  assert.deepEqual(r, { changes: [null], warnings: ['no spot price for TCS — not repriced'] })
})

/** NIFTY's book (beta 1 by definition). */
function niftyBook(legs: readonly PayoffLeg[], bars: readonly Close[]): RiskBookInput {
  return { snapshot: snapshot('NIFTY', 25000, 25000, legs), deltaShares: 0, hv20: 0.16, nearIv: null, bars }
}

test('a short straddle\'s grid loses both ways and on vol +5, gains on vol −5; the headline names the worst cell', () => {
  const bars = series(RS.slice(0, 120))
  const straddle = [option('c', 'CE', -75, 25000, 300, 0.15), option('p', 'PE', -75, 25000, 300, 0.15)]
  const v = buildRiskView({ asOf: NOW, trader: 'ravi', books: [niftyBook(straddle, bars)], nifty: { bars, spot: 25000, lotSize: 75 } })
  const g = v.grid
  const cell = (move: number, vol: number): number => g.cells[g.moves.indexOf(move)]?.[g.vols.indexOf(vol)] as number
  assert.equal(cell(0, 0), 0)
  for (const m of [-10, -5, -1, 1, 5, 10]) assert.ok(cell(m, 0) < 0, `move ${m}: ${cell(m, 0)}`)
  assert.ok(cell(0, 5) < 0 && cell(0, 10) < cell(0, 5), `${cell(0, 5)} ${cell(0, 10)}`)
  assert.ok(cell(0, -5) > 0)
  assert.equal(g.worst[g.moves.indexOf(0)]?.[g.vols.indexOf(-5)], null)
  assert.equal(g.worst[g.moves.indexOf(-10)]?.[g.vols.indexOf(10)], 'NIFTY')
  assert.deepEqual(g.excluded, [])

  const b = v.books[0]
  assert.equal(b?.beta, 1)
  assert.ok((b?.twoSigmaLoss as number) < 0)
  assert.equal(b?.sharePct, 100)
  near(v.totals.niftyDown1, b?.niftyDown1 as number)
  // the headline: the worst cell, its move and vol, rupees en-IN with a real minus, the book
  const worst = Math.min(...g.cells.flat().filter((c): c is number => c !== null))
  assert.ok(v.headline?.endsWith(`: ${rupees(worst)}, most from NIFTY`), v.headline ?? '')
  assert.match(v.headline ?? '', /^NIFTY [−+]\d+% with vol [−+]\d+: −₹[\d,]+, most from NIFTY$/)

  // the replay: 120 days, VaR by nearest rank, ES the mean at or below VaR 99, the worst day first
  assert.equal(v.replay.days, 120)
  assert.ok(v.replay.var99 !== null && v.replay.var95 !== null && v.replay.var99 <= v.replay.var95)
  assert.ok((v.replay.es99 as number) <= (v.replay.var99 as number))
  assert.equal(v.replay.worstDays.length, 3)
  const [w1, w2] = v.replay.worstDays
  assert.ok((w1?.change as number) <= (w2?.change as number))
  near(w1?.books[0]?.change, w1?.change as number)
  near(w1?.niftyPct, w1?.books[0]?.movePct as number, 1e-9)
})

test('a book with no beta is left out of the grid and named; under 60 days there is no replay', () => {
  const bars = series(RS.slice(0, 120))
  const tcs: RiskBookInput = { snapshot: snapshot('TCS', 1000, 1000, [future(175, 990)]), deltaShares: 175, hv20: 0.2, nearIv: null, bars: series(RS.slice(0, 30)) }
  const v = buildRiskView({ asOf: NOW, trader: 'ravi', books: [tcs], nifty: { bars, spot: 25000, lotSize: 75 } })
  assert.deepEqual(v.grid.excluded, [{ stock: 'TCS', why: 'no beta (under 60 days aligned with NIFTY)' }])
  assert.equal(v.grid.cells.flat().every((c) => c === null), true)
  assert.equal(v.headline, null)
  assert.deepEqual([v.replay.var95, v.replay.worstDays], [null, []])
  assert.ok(v.books[0]?.warnings.includes('TCS: beta needs 60 days of returns aligned with NIFTY; 30 held'))
  assert.ok(v.books[0]?.warnings.includes('TCS: under 60 days of history — left out of the replay'))
  // the 2σ loss is still there: a long future loses on the way down, 2 × HV20/√252
  near(v.books[0]?.twoSigmaLoss, -175 * 1000 * 2 * (0.2 / Math.sqrt(252)), 1e-6)
  near(v.books[0]?.deltaRupees, 175 * 1000)
  assert.equal(v.books[0]?.betaDeltaRupees, null)
})

test('a cluster\'s together loss is every member at 2σ in its worse direction at once', () => {
  const bars = series(RS.slice(0, 120))
  const mk = (stock: string, qty: number): RiskBookInput =>
    ({ snapshot: snapshot(stock, 1000, 1000, [future(qty, 1000)]), deltaShares: qty, hv20: 0.2, nearIv: null, bars })
  const v = buildRiskView({ asOf: NOW, trader: null, books: [mk('B', 100), mk('A', 100), mk('C', -50)], nifty: { bars, spot: 25000, lotSize: 75 } })
  assert.deepEqual(v.correlation.stocks, ['A', 'B', 'C'])
  assert.equal(v.clusters.length, 1)
  const c = v.clusters[0]
  assert.deepEqual(c?.stocks, ['A', 'B', 'C'])
  near(c?.meanCorr, 1)
  const s = 2 * 1000 * (0.2 / Math.sqrt(252))
  near(c?.togetherLoss, -150 * s, 1e-6)   // all down: −100 −100 +50
  near(c?.standaloneLoss, -250 * s, 1e-6)
  near(v.totals.niftyLots, (150 * 1000) / (25000 * 75))
})
