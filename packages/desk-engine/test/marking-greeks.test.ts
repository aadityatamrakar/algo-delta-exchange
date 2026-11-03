/**
 * THETA AND VEGA WERE ALWAYS THERE, AND ALWAYS DROPPED.
 *
 * `b76Greeks` returns four greeks. `marking.ts`'s single Black-76 call site —
 * the one both public greek paths route through, precisely so a leg and a
 * candidate strike can never be solved at different rates, forwards or tenors
 * — kept two of them and threw `theta` and `vega` away. Nothing complained,
 * because no recenter rule reads either one. The cost only shows up when a
 * second decide path needs them: the obvious repair is a SECOND Black-76 call
 * somewhere else, which is the exact drift `solveGreeks` exists to prevent.
 *
 * The three failures this file prevents:
 *
 *   1. The mark drops a greek the solver already computed and paid for.
 *   2. An unsolvable leg reports a theta of 0, which reads as "this leg costs
 *      nothing to hold" — the absent-vs-zero trap `hasGreeks` was added for
 *      (`types.ts` §2). `hasGreeks: false` is the whole answer; the 0 beside
 *      it is a zero-init, and the contract is that no consumer reads it.
 *   3. The units slip. Theta is per CALENDAR DAY, not per year (a factor of
 *      365), and vega is per 1 POINT of vol, not per 1.0 of vol (a factor of
 *      100). Either slip leaves every downstream threshold wrong by a
 *      constant, which looks like a bad strategy rather than a bad divisor.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RISK_FREE,
  markLeg,
  strikeGreeks,
  type ChainSnap,
  type LegView,
  type OptType,
  type Quote,
  type Side,
} from '@algomaker/desk-engine'
import { b76Greeks, b76Price } from '@algomaker/greeks'

const DATE = '2026-08-21' // a Friday
const EXPIRY = '2026-08-28' // seven calendar days out — no intraday refinement
const MINUTE = 600 // 10:00 IST
const T7 = 7 / 365
const VOL = 0.3
const SPOT = 300
const NOW = 1_755_000_000_000

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })
const NONE: Quote = { bid: null, ask: null, ltp: null, asOf: NOW }

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so the
 * IV the mark solves back out is `VOL` to solver tolerance. */
function bookAt(spot: number, strike: number, type: OptType): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.98, px * 1.02)
}

const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * 10)

function chainOf(spot = SPOT): ChainSnap {
  return {
    symbol: 'TEST',
    expiry: EXPIRY,
    step: 10,
    lotSize: 25,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: LADDER.map((k) => ({
      strike: k,
      ce: bookAt(spot, k, 'CE'),
      pe: bookAt(spot, k, 'PE'),
    })),
    asOf: NOW,
  }
}

const leg = (over: Partial<Parameters<typeof markLeg>[0]> = {}) => ({
  instrument: 'TEST26AUG300CE',
  strike: 300,
  optType: 'CE' as OptType,
  side: 'Buy' as Side,
  lots: 1,
  lotSize: 25,
  entry: 5,
  openedByEngine: true,
  // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
  leanId: '',
  ...over,
})

/** The mark of a leg against its own strike's book in this chain. */
function marked(over: Partial<Parameters<typeof markLeg>[0]> = {}): LegView {
  const l = leg(over)
  return markLeg(l, bookAt(SPOT, l.strike, l.optType), chainOf(), DATE, MINUTE, 'live')
}

// ── markLeg ─────────────────────────────────────────────────────────────────

test('a marked leg carries the theta and vega b76Greeks computed', () => {
  const v = marked()
  assert.equal(v.hasGreeks, true)
  assert.notEqual(v.iv, null)
  // Re-derive at the leg's OWN solved IV, not at VOL: the mark solves the IV
  // off the mid and any difference there must not be read as a greek defect.
  const want = b76Greeks({
    future: SPOT,
    strike: 300,
    t: T7,
    vol: v.iv as number,
    rate: RISK_FREE,
    type: 'CE',
  })
  assert.ok(Math.abs(v.theta - want.theta) < 1e-12, `theta ${v.theta} vs ${want.theta}`)
  assert.ok(Math.abs(v.vega - want.vega) < 1e-12, `vega ${v.vega} vs ${want.vega}`)
})

test('theta is negative and sized per CALENDAR DAY, not per year', () => {
  const v = marked()
  assert.ok(v.theta < 0, `a long option decays: ${v.theta}`) // §3 of the header
  // Hand-check: an ATM 7-DTE 30%-vol call on a 300 future is worth about
  // 0.4 x 300 x 0.3 x sqrt(7/365) = 4.98, so it sheds roughly 4.98/(2 x 7)
  // = 0.36 a day. The same number per YEAR would be near -130, which this
  // band excludes outright.
  assert.ok(v.theta > -0.6 && v.theta < -0.2, `per-day theta out of band: ${v.theta}`)
})

test('vega is per 1 POINT of vol, not per 1.0 of vol', () => {
  const v = marked()
  // F x e^{-rt} x phi(d1) x sqrt(t) / 100 = 300 x 0.9987 x 0.3979 x 0.1384 / 100
  // = 0.165. Dropping the /100 gives 16.5, two orders of magnitude out.
  assert.ok(v.vega > 0.1 && v.vega < 0.25, `per-point vega out of band: ${v.vega}`)
})

test('theta and vega belong to the CONTRACT, not the position', () => {
  // `delta` is stored as an unsigned magnitude with the sign applied by
  // consumers (`marking.ts` header); theta and vega follow the same rule, so a
  // short leg carries the same negative theta as the long. A consumer that
  // wants the book's theta multiplies by the side, exactly as it does for
  // delta. Baking the side in here would double-apply it downstream.
  const long = marked({ side: 'Buy' })
  const short = marked({ side: 'Sell', instrument: 'TEST26AUG300CE-S' })
  assert.equal(long.theta, short.theta)
  assert.equal(long.vega, short.vega)
  assert.ok(short.theta < 0, 'a SHORT leg still reports the contract theta, negative')
})

test('a put and a call at the same strike share a vega', () => {
  // Both wings read the same pdf(d1) x sqrt(t) term, so vega is identical.
  // This pins that the PE branch of b76Greeks is reached at all — a solveGreeks
  // that hard-coded the CE branch would pass every other test in this file.
  const ce = marked({ optType: 'CE' })
  const pe = marked({ optType: 'PE', instrument: 'TEST26AUG300PE' })
  assert.ok(Math.abs(ce.vega - pe.vega) < 1e-3, `${ce.vega} vs ${pe.vega}`)
  assert.ok(pe.theta < 0)
})

test('an unsolvable leg reports hasGreeks false, and its theta and vega are zero-init', () => {
  // A 260 CE against a 300 future is 40 intrinsic; a book at 30 cannot solve.
  // The VALUE of theta here is not the point — the CONTRACT is that no
  // consumer may read it, which is what `hasGreeks` is for. It is pinned at 0
  // only so it matches how `delta` and `gamma` are already spelled on this
  // path, never as a number a rule may believe.
  const v = markLeg(leg({ strike: 260 }), q(29, 31), chainOf(), DATE, MINUTE, 'live')
  assert.equal(v.hasGreeks, false)
  assert.equal(v.iv, null)
  assert.equal(v.theta, 0)
  assert.equal(v.vega, 0)
})

test('an unpriced leg is unmarked on all four greeks at once', () => {
  // Never a partial greek set: hasGreeks is one flag over the whole quartet.
  const v = markLeg(leg(), NONE, chainOf(), DATE, MINUTE, 'live')
  assert.equal(v.hasGreeks, false)
  assert.equal(v.delta, 0)
  assert.equal(v.gamma, 0)
  assert.equal(v.theta, 0)
  assert.equal(v.vega, 0)
})

// ── strikeGreeks ────────────────────────────────────────────────────────────

test('strikeGreeks reports theta and vega for a strike the book does not hold', () => {
  const g = strikeGreeks(chainOf(), 320, 'CE', DATE, MINUTE)
  assert.notEqual(g, null)
  const want = b76Greeks({
    future: SPOT,
    strike: 320,
    t: T7,
    vol: g!.iv,
    rate: RISK_FREE,
    type: 'CE',
  })
  assert.ok(Math.abs(g!.theta - want.theta) < 1e-12, `theta ${g!.theta} vs ${want.theta}`)
  assert.ok(Math.abs(g!.vega - want.vega) < 1e-12, `vega ${g!.vega} vs ${want.vega}`)
  assert.ok(g!.theta < 0)
  assert.ok(g!.vega > 0)
})

test('a leg and its own strike solve to the SAME four greeks', () => {
  // The one Black-76 call site, proved. Two call sites would drift on the
  // forward, the rate or the tenor and nothing would say which was right.
  const v = marked({ strike: 310, instrument: 'TEST26AUG310CE' })
  const g = strikeGreeks(chainOf(), 310, 'CE', DATE, MINUTE)
  assert.notEqual(g, null)
  assert.equal(v.theta, g!.theta)
  assert.equal(v.vega, g!.vega)
  assert.equal(v.gamma, g!.gamma)
  assert.equal(v.delta, g!.delta) // a CE delta is already positive; no abs needed
  assert.ok(v.theta < 0 && v.vega > 0, 'both are real numbers, not two undefineds compared')
})

test('an unmeasurable strike is still null — theta and vega gain no fallback', () => {
  // Widening the result must not turn "not a candidate" into "a candidate with
  // a zero theta". There is no 0.30-delta stand-in behind this type and there
  // is no 0-theta one either (spec §5).
  assert.equal(strikeGreeks(chainOf(), 9_999, 'CE', DATE, MINUTE), null)
  const noBook: ChainSnap = {
    ...chainOf(),
    strikes: [{ strike: 300, ce: null, pe: bookAt(SPOT, 300, 'PE') }],
  }
  assert.equal(strikeGreeks(noBook, 300, 'CE', DATE, MINUTE), null)
})
