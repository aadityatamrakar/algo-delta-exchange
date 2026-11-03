/**
 * THE VIEW'S DISTRIBUTION, AGAINST THE CLOSED FORMS IT MUST AGREE WITH.
 *
 * `evaluateUnderView` is the one figure in the objective search that depends on
 * what the trader BELIEVES — vol and drift — rather than on the book alone, so
 * every number it produces is pinned here against an answer that needs no grid:
 *
 *   • A single long call under zero drift at its own implied vol: the expected
 *     payoff is the UNDISCOUNTED Black-76 price, so EV = qty × (B76 at r=0 − paid).
 *   • A long future: EV = qty × (F·e^{μT} − entry), and the worst-5% mean is the
 *     lognormal's partial expectation, F·Φ(z₀.₀₅ − s)/0.05.
 *   • The probability a long call finishes past its breakeven is a lognormal
 *     tail, `lognormalProbBetween`'s answer.
 *
 * The tolerances are the grid's honest error (241 points over ±4σ), not slack:
 * each is stated beside the assertion that uses it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, normCdf } from '@algomaker/greeks'
import { DEFAULT_RATE, type PayoffLeg } from '../src/legs.ts'
import { lognormalProbBetween } from '../src/surface.ts'
import { evaluateUnderView } from '../src/distribution.ts'
import type { MarketView } from '../src/objective-types.ts'

const F = 786
const TODAY = '2026-08-19'
const EXPIRY = '2026-08-25'
const T = 6 / 365
const IV = 0.3
const IMPLIED: MarketView = { vol: { kind: 'implied' } }

const call = (strike: number, qty: number, entry: number, iv: number | null = IV): PayoffLeg => ({
  id: `c${strike}`, instrument: 'option', qty, strike, type: 'CE', expiry: EXPIRY, entry, iv,
})
const put = (strike: number, qty: number, entry: number): PayoffLeg => ({
  id: `p${strike}`, instrument: 'option', qty, strike, type: 'PE', expiry: EXPIRY, entry, iv: IV,
})
const fut = (qty: number, entry: number): PayoffLeg => ({
  id: 'f', instrument: 'future', qty, strike: null, type: null, expiry: EXPIRY, entry, iv: null,
})

test('a long call at its own vol, zero drift: EV is the undiscounted Black-76 price less the premium', () => {
  for (const strike of [740, 786, 800, 840]) {
    const paid = b76Price({ future: F, strike, t: T, vol: IV, rate: DEFAULT_RATE, type: 'CE' })
    const fair = b76Price({ future: F, strike, t: T, vol: IV, rate: 0, type: 'CE' })
    const s = evaluateUnderView([call(strike, 1000, paid)], F, TODAY, 0, IMPLIED)
    assert.ok(s !== null)
    const want = 1000 * (fair - paid)
    // ±₹0.005 a share: the midpoint rule across one kink, one grid step (≈ ₹1 of price) wide
    // (measured ≤ ₹0.0008 on these strikes).
    assert.ok(Math.abs(s.ev - want) <= 5, `${strike}: ev ${s.ev}, closed form ${want}`)
    assert.ok(Math.abs(s.sigma - IV * Math.sqrt(T)) < 1e-12)
  }
})

test('a long put, the same way', () => {
  const paid = b76Price({ future: F, strike: 760, t: T, vol: IV, rate: DEFAULT_RATE, type: 'PE' })
  const fair = b76Price({ future: F, strike: 760, t: T, vol: IV, rate: 0, type: 'PE' })
  const s = evaluateUnderView([put(760, 2000, paid)], F, TODAY, 0, IMPLIED)
  assert.ok(s !== null && Math.abs(s.ev - 2000 * (fair - paid)) <= 10, JSON.stringify(s))
})

test('POP is the lognormal tail past the breakeven, realised included', () => {
  const paid = b76Price({ future: F, strike: 800, t: T, vol: IV, rate: DEFAULT_RATE, type: 'CE' })
  const s = evaluateUnderView([call(800, 1000, paid)], F, TODAY, 0, IMPLIED)
  assert.ok(s !== null)
  const closed = 100 * lognormalProbBetween(F, 800 + paid, null, IV, T)
  // At most half a bin of probability mass either side of the crossing (≈ 0.7 points at the peak).
  assert.ok(Math.abs(s.pop - closed) <= 0.7, `pop ${s.pop}, closed ${closed}`)
  // Banked money is a constant shift of the RUN: ₹paid × 1000 banked makes the run green everywhere.
  const banked = evaluateUnderView([call(800, 1000, paid)], F, TODAY, paid * 1000, IMPLIED)
  assert.ok(banked !== null)
  assert.equal(banked.pop, 100)
  assert.ok(Math.abs(banked.ev - (s.ev + paid * 1000)) < 1e-6)
})

test('a long future: EV is the drift, CVaR the lognormal partial expectation', () => {
  const qty = 1000
  const flat = evaluateUnderView([fut(qty, F)], F, TODAY, 0, { vol: { kind: 'flat', annual: 0.25 } })
  assert.ok(flat !== null)
  assert.ok(Math.abs(flat.ev) <= 0.1, `zero drift, entry at the future: ev ${flat.ev}`)
  const s = 0.25 * Math.sqrt(T)
  const z05 = -1.6448536269514722
  const tail = (F * normCdf(z05 - s)) / 0.05
  // The worst 5% ends inside one bin, split pro rata; the grid's step in price is F·s/30 ≈ ₹0.8,
  // and the measured error is ≈ ₹0.003 a share — ₹0.01 is the bound.
  assert.ok(Math.abs(flat.cvar5 - qty * (tail - F)) <= 10, `cvar ${flat.cvar5}, closed ${qty * (tail - F)}`)
  assert.ok(flat.cvar5 < 0 && Math.abs(flat.pop - 50) < 1)

  const up = evaluateUnderView([fut(qty, F)], F, TODAY, 0, { vol: { kind: 'flat', annual: 0.25 }, driftAnnual: 0.5 })
  assert.ok(up !== null)
  const want = qty * (F * Math.exp(0.5 * T) - F)
  assert.ok(Math.abs(up.ev - want) <= 1, `ev ${up.ev}, closed ${want}`)
  assert.ok(up.pop > 50)
})

test('the vol kinds: implied draws at the book vol, shift adds points, flat replaces it', () => {
  const legs = [call(800, -1000, 6), put(760, -1000, 5)]
  const imp = evaluateUnderView(legs, F, TODAY, 0, IMPLIED)
  const shifted = evaluateUnderView(legs, F, TODAY, 0, { vol: { kind: 'shift', points: 5 } })
  const hv = evaluateUnderView(legs, F, TODAY, 0, { vol: { kind: 'flat', annual: 0.18 } })
  assert.ok(imp !== null && shifted !== null && hv !== null)
  assert.ok(Math.abs(imp.sigma - 0.3 * Math.sqrt(T)) < 1e-12)
  assert.ok(Math.abs(shifted.sigma - 0.35 * Math.sqrt(T)) < 1e-12)
  assert.ok(Math.abs(hv.sigma - 0.18 * Math.sqrt(T)) < 1e-12)
  // A short strangle: a calmer realised vol than implied is worth money; a wilder one costs it.
  assert.ok(hv.ev > imp.ev && imp.ev > shifted.ev, `${hv.ev} > ${imp.ev} > ${shifted.ev}`)
  assert.ok(hv.pop > imp.pop && hv.cvar5 > imp.cvar5)
  // An explicit ATM vol replaces the legs' mean for 'implied' and 'shift' (the search's one distribution).
  const atm = evaluateUnderView(legs, F, TODAY, 0, IMPLIED, 0.22)
  assert.ok(atm !== null && Math.abs(atm.sigma - 0.22 * Math.sqrt(T)) < 1e-12)
})

test('a horizon before expiry values the legs with time left, at the same clock as the surface', () => {
  const paid = b76Price({ future: F, strike: 800, t: T, vol: IV, rate: DEFAULT_RATE, type: 'CE' })
  // Horizon today: no time for the price to move, so the outcome is today's mark.
  const now = evaluateUnderView([call(800, 1000, paid)], F, TODAY, 0, { ...IMPLIED, horizon: TODAY })
  assert.ok(now !== null)
  assert.equal(now.sigma, 0)
  assert.ok(Math.abs(now.ev) < 1e-6, `bought at the mark, valued at the mark: ${now.ev}`)
  // A horizon past the book's expiry is the expiry.
  const late = evaluateUnderView([call(800, 1000, paid)], F, TODAY, 0, { ...IMPLIED, horizon: '2026-09-30' })
  const atExp = evaluateUnderView([call(800, 1000, paid)], F, TODAY, 0, IMPLIED)
  assert.deepEqual(late, atExp)
  // Mid-way: σ grows with √T to the horizon, not to expiry.
  const mid = evaluateUnderView([call(800, 1000, paid)], F, TODAY, 0, { ...IMPLIED, horizon: '2026-08-22' })
  assert.ok(mid !== null && Math.abs(mid.sigma - IV * Math.sqrt(3 / 365)) < 1e-12)
})

test('what it cannot draw is null, never a guess', () => {
  const legs = [call(800, 1000, 5)]
  assert.equal(evaluateUnderView(legs, Number.NaN, TODAY, 0, IMPLIED), null)
  assert.equal(evaluateUnderView(legs, 0, TODAY, 0, IMPLIED), null)
  assert.equal(evaluateUnderView(legs, F, 'yesterday', 0, IMPLIED), null)
  assert.equal(evaluateUnderView(legs, F, TODAY, 0, { ...IMPLIED, horizon: '25 Aug' }), null)
  assert.equal(evaluateUnderView(legs, F, TODAY, 0, { vol: { kind: 'flat', annual: 0 } }), null)
  assert.equal(evaluateUnderView(legs, F, TODAY, 0, null as unknown as MarketView), null)
  // No option leg carries a vol and none was given: 'implied' has nothing to draw with.
  assert.equal(evaluateUnderView([fut(1000, F)], F, TODAY, 0, IMPLIED), null)
  assert.equal(evaluateUnderView([call(800, 1000, 5, null)], F, TODAY, 0, IMPLIED), null)
})

test('an empty book is flat at what it banked', () => {
  const s = evaluateUnderView([], F, TODAY, -1200, { vol: { kind: 'flat', annual: 0.2 } })
  assert.ok(s !== null)
  assert.deepEqual([s.ev, s.cvar5, s.pop], [-1200, -1200, 0])
})

test('same inputs, same bytes', () => {
  const legs = [call(800, -1000, 6), put(760, -1000, 5), fut(500, 780)]
  const a = JSON.stringify(evaluateUnderView(legs, F, TODAY, 300, { vol: { kind: 'shift', points: -3 }, driftAnnual: 0.1 }))
  const b = JSON.stringify(evaluateUnderView(legs, F, TODAY, 300, { vol: { kind: 'shift', points: -3 }, driftAnnual: 0.1 }))
  assert.equal(a, b)
})
