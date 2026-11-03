/**
 * THE CORRIDOR, PINNED TO ARITHMETIC A HUMAN CAN CHECK.
 *
 * Every band number below is hand-derived, and the two that are not arbitrary
 * are the live books the dials were written against:
 *
 *   - `|netΓ| 1000 x 2% x spot 300 = 6000` — the shape of the formula, chosen
 *     so the excess on either side of it is a round number a reader can verify
 *     without a calculator.
 *   - `netΓ -2.0, netΔ +483, lot 225, spot 2300 → allowance 92` — the live
 *     TCS-2026-08-25-recenter-relief-r book on 2026-08-12, quoted verbatim from
 *     `playbooks.py:4038-4046`. That mark is why `min_band_lots` and
 *     `no_band_floor` exist, and reproducing it here is the only way to know
 *     the port kept the problem they solve.
 *
 * Three things would otherwise pass silently, and each has its own block:
 *
 *   1. THE SIGN RULE. `LegView.delta` is an UNSIGNED magnitude (`types.ts:80`),
 *      so the corridor applies BOTH signs itself — the wing's and the
 *      position's. Get either wrong and a hedged book reads as a naked one.
 *      A short CE and a long CE must cancel; a short CE and a short PE must
 *      cancel; and gamma must take the position sign ONLY, never the wing's.
 *   2. `hasGreeks` VS A ZERO. A book whose gamma genuinely sums to 0.0 and a
 *      book whose greeks were never marked produce the same `netGamma` and must
 *      NOT produce the same `hasGreeks`. That conflation is the sentinel this
 *      field replaces (`playbooks.py:4063-4073`).
 *   3. THE FLOOR REFERENCE. With the scan off it is a whole lot; with the scan
 *      on it is the FINEST lot within the scan — the furthest strike, not the
 *      nearest. Picking the nearest inverts the fix and re-arms the hold.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  RISK_FREE,
  corridor,
  nearestStrike,
  otmSellStrike,
  steeringPopulation,
  type ChainSnap,
  type Dials,
  type EngineInputs,
  type LegView,
  type OptType,
  type Quote,
} from '@algomaker/desk-engine'
import { b76Greeks, b76Price } from '@algomaker/greeks'

const DATE = '2026-08-21'
const EXPIRY = '2026-08-28'
const MINUTE = 600 // 10:00 IST — seven whole days out, no intraday refinement
const T7 = 7 / 365
const VOL = 0.3

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: 1 })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so every
 * strike on the chain solves back to that vol and its greeks are the model's. */
function bookAt(spot: number, strike: number, type: OptType): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.98, px * 1.02)
}

function chainOf(spot: number, strikes: number[], step: number, lotSize: number): ChainSnap {
  return {
    symbol: 'VEDL',
    expiry: EXPIRY,
    step,
    lotSize,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: strikes.map((k) => ({ strike: k, ce: bookAt(spot, k, 'CE'), pe: bookAt(spot, k, 'PE') })),
    asOf: 1,
  }
}

/** A chain with no rows: `strikeGreeks` answers null for every strike, so the
 * scan finds nothing and `floorRef` falls back to the whole lot. */
const bareChain = (spot: number, step = 10, lotSize = 25): ChainSnap =>
  chainOf(spot, [], step, lotSize)

let legSeq = 0
function leg(over: Partial<LegView> = {}): LegView {
  legSeq += 1
  return {
    instrument: `LEG${legSeq}`,
    strike: 300,
    optType: 'CE',
    side: 'Sell',
    lots: 1,
    lotSize: 25,
    entry: 10,
    openedByEngine: true,
    // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
    leanId: '',
    iv: VOL,
    delta: 0.5,
    gamma: 0.01,
    // Inert on every recenter path — nothing here reads either greek. Carried
    // because `LegView` requires them (`types.ts`): theta per calendar day,
    // vega per vol point, both per-share.
    theta: 0,
    vega: 0,
    hasGreeks: true,
    mtm: 0,
    exit: q(9, 11),
    ...over,
  }
}

function inputsOf(chain: ChainSnap, legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: 1_755_000_000_000,
    dateIst: DATE,
    minuteOfDay: MINUTE,
    dte: 7,
    chain,
    legs,
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'model', asOf: 1, fresh: false },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
    ...over,
  }
}

const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })

/** Scan OFF, floor dials OFF — the plain band, so a test that is about the
 * band is not quietly also about the floor. */
const plain = (over: Partial<Dials> = {}): Dials =>
  dialsOf({ shed_scan_strikes: 0, min_band_lots: 0, no_band_floor: false, tol_ref_dte: 0, ...over })

// ── steeringPopulation ──────────────────────────────────────────────────────

test('steeringPopulation false takes the WHOLE book, true takes the shorts', () => {
  const shortCe = leg({ side: 'Sell', optType: 'CE' })
  const longPe = leg({ side: 'Buy', optType: 'PE' })
  const shortPe = leg({ side: 'Sell', optType: 'PE' })
  const legs = [shortCe, longPe, shortPe]

  assert.deepEqual(steeringPopulation(legs, false), legs)
  assert.deepEqual(steeringPopulation(legs, true), [shortCe, shortPe])
})

// ── the sign rule: LegView.delta is an UNSIGNED magnitude ───────────────────

test('a long CE cancels a short CE of the same size — the position sign is applied here', () => {
  const legs = [
    leg({ side: 'Sell', optType: 'CE', lots: 4, lotSize: 2500, delta: 0.4, gamma: 0 }),
    leg({ side: 'Buy', optType: 'CE', lots: 4, lotSize: 2500, delta: 0.4, gamma: 0 }),
  ]
  const whole = corridor(inputsOf(bareChain(300), legs), plain({ delta_shorts_only: false }))
  assert.equal(whole.netDelta, 0)

  // Shorts-only reads the SAME book as one-sided: -0.4 x 10,000.
  const shortsOnly = corridor(inputsOf(bareChain(300), legs), plain({ delta_shorts_only: true }))
  assert.equal(shortsOnly.netDelta, -4000)
})

test('a short CE cancels a short PE of the same size — the WING sign is applied here', () => {
  const legs = [
    leg({ side: 'Sell', optType: 'CE', lots: 4, lotSize: 2500, delta: 0.4, gamma: 0.1 }),
    leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 2500, delta: 0.4, gamma: 0.1 }),
  ]
  const c = corridor(inputsOf(bareChain(300), legs), plain())
  assert.equal(c.netDelta, 0)
  // Gamma takes the POSITION sign only: two shorts, both negative, no cancel.
  assert.equal(c.netGamma, -2000)
})

test('a long wing adds POSITIVE gamma and narrows the band — which is what gamma_shorts_only exists to stop', () => {
  const legs = [
    leg({ side: 'Sell', optType: 'CE', lots: 4, lotSize: 2500, delta: 0.1, gamma: 0.1 }),
    leg({ side: 'Buy', optType: 'PE', lots: 4, lotSize: 2500, delta: 0.1, gamma: 0.05 }),
  ]
  const whole = corridor(inputsOf(bareChain(300), legs), plain({ gamma_shorts_only: false }))
  assert.equal(whole.netGamma, -1000 + 500)
  assert.equal(whole.allowed, 500 * 0.02 * 300) // 3,000 — half the band

  const shortsOnly = corridor(inputsOf(bareChain(300), legs), plain({ gamma_shorts_only: true }))
  assert.equal(shortsOnly.netGamma, -1000)
  assert.equal(shortsOnly.allowed, 6000)
})

// ── the band ────────────────────────────────────────────────────────────────

/** The formula book: 4 lots of 2,500 = 10,000 shares, per-share Γ 0.1, so
 * |netΓ| is 1,000 exactly. Greeks are chosen for round arithmetic, not for
 * internal Black-76 consistency — the corridor never re-derives them. */
const bandBook = (delta: number): LegView[] => [
  leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 2500, delta, gamma: 0.1 }),
]

test('allowed is |netGamma| x tol x spot', () => {
  const c = corridor(inputsOf(bareChain(300), bandBook(0.09)), plain())
  assert.equal(c.netGamma, -1000)
  assert.equal(c.allowed, 6000) // 1,000 x 0.02 x 300
})

test('a book INSIDE the band carries a negative excess', () => {
  const c = corridor(inputsOf(bareChain(300), bandBook(0.09)), plain())
  assert.equal(c.netDelta, 900) // short PE: (-1)(-1) x 0.09 x 10,000
  assert.equal(c.excess, -5100) // 900 - 6,000
})

test('a book PAST the band carries the overshoot as excess', () => {
  const c = corridor(inputsOf(bareChain(300), bandBook(0.9)), plain())
  assert.equal(c.netDelta, 9000)
  assert.equal(c.excess, 3000) // 9,000 - 6,000
})

test('excess is measured on |netDelta| — a short book is symmetric', () => {
  const legs = [leg({ side: 'Sell', optType: 'CE', lots: 4, lotSize: 2500, delta: 0.9, gamma: 0.1 })]
  const c = corridor(inputsOf(bareChain(300), legs), plain())
  assert.equal(c.netDelta, -9000)
  assert.equal(c.excess, 3000)
})

// ── tol_ref_dte: the sqrt(dte) shrink ───────────────────────────────────────

test('tol_ref_dte shrinks the band by sqrt(dte/ref) inside the reference life', () => {
  const c = corridor(inputsOf(bareChain(300), bandBook(0.9), { dte: 5 }), plain({ tol_ref_dte: 20 }))
  assert.equal(c.allowed, 3000) // tol 0.02 x sqrt(5/20) = 0.01
  assert.equal(c.excess, 6000)
})

test('tol_ref_dte never WIDENS the band past the dial', () => {
  const at = (dte: number) =>
    corridor(inputsOf(bareChain(300), bandBook(0.9), { dte }), plain({ tol_ref_dte: 20 })).allowed
  assert.equal(at(20), 6000) // at the reference life: the plain 2%
  assert.equal(at(45), 6000) // beyond it: still the plain 2%
})

test('tol_ref_dte is off at dte 0 and off when the dial is 0', () => {
  // The Python guard is `0 < dte < ref`: the expiry session keeps the full tol.
  const expiryDay = corridor(inputsOf(bareChain(300), bandBook(0.9), { dte: 0 }), plain({ tol_ref_dte: 20 }))
  assert.equal(expiryDay.allowed, 6000)
  const dialOff = corridor(inputsOf(bareChain(300), bandBook(0.9), { dte: 5 }), plain({ tol_ref_dte: 0 }))
  assert.equal(dialOff.allowed, 6000)
})

// ── min_band_lots / no_band_floor ───────────────────────────────────────────

/** A book with almost no convexity left: 25 shares at per-share Γ 0.001, so
 * the measured band is 0.15 against a 25-share lot. */
const thinBook = (): LegView[] => [
  leg({ side: 'Sell', optType: 'PE', lots: 1, lotSize: 25, delta: 0.8, gamma: 0.001 }),
]

test('min_band_lots CLAMPS the band at mbl lots — collapsing gamma widens it instead of silencing the rule', () => {
  const measured = corridor(inputsOf(bareChain(300), thinBook()), plain({ min_band_lots: 0 }))
  assert.ok(Math.abs(measured.allowed - 0.15) < 1e-9, `measured ${measured.allowed}`)

  const clamped = corridor(inputsOf(bareChain(300), thinBook()), plain({ min_band_lots: 2 }))
  assert.equal(clamped.allowed, 50) // max(0.15, 2 x 25)
})

test('min_band_lots is a FLOOR, not a replacement — a wide measured band wins', () => {
  const legs = [leg({ side: 'Sell', optType: 'PE', lots: 1, lotSize: 25, delta: 0.8, gamma: 1 })]
  const c = corridor(inputsOf(bareChain(300), legs), plain({ min_band_lots: 2 }))
  assert.equal(c.netGamma, -25)
  assert.equal(c.allowed, 150) // max(25 x 0.02 x 300, 50)
})

test('no_band_floor does not touch `allowed` — it removes the caller-side floor test', () => {
  const held = corridor(inputsOf(bareChain(300), thinBook()), plain({ no_band_floor: false }))
  const free = corridor(inputsOf(bareChain(300), thinBook()), plain({ no_band_floor: true }))
  assert.deepEqual(free, held)
})

// ── hasGreeks: the replacement for the netΓ == 0.0 sentinel ─────────────────

test('one unmarked leg in the population makes the whole corridor hasGreeks false', () => {
  const legs = [
    leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 2500, delta: 0.9, gamma: 0.1 }),
    leg({ side: 'Sell', optType: 'CE', delta: 0, gamma: 0, hasGreeks: false }),
  ]
  const c = corridor(inputsOf(bareChain(300), legs), plain())
  assert.equal(c.hasGreeks, false)
})

test('an unmarked leg OUTSIDE the population does not poison the corridor', () => {
  const legs = [
    leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 2500, delta: 0.9, gamma: 0.1 }),
    leg({ side: 'Buy', optType: 'PE', delta: 0, gamma: 0, hasGreeks: false }),
  ]
  const shortsOnly = plain({ delta_shorts_only: true, gamma_shorts_only: true })
  assert.equal(corridor(inputsOf(bareChain(300), legs), shortsOnly).hasGreeks, true)

  // Let the delta sum read the whole book and the same leg is now load-bearing.
  const wholeDelta = plain({ delta_shorts_only: false, gamma_shorts_only: true })
  assert.equal(corridor(inputsOf(bareChain(300), legs), wholeDelta).hasGreeks, false)

  // ...and so is it for the gamma sum alone.
  const wholeGamma = plain({ delta_shorts_only: true, gamma_shorts_only: false })
  assert.equal(corridor(inputsOf(bareChain(300), legs), wholeGamma).hasGreeks, false)
})

test('a book whose gamma genuinely sums to 0.0 is MARKED, not missing', () => {
  // The sentinel this replaces read netΓ == 0.0 as "the greeks were never
  // marked" and held. Here both legs are marked and simply offset.
  const legs = [
    leg({ side: 'Sell', optType: 'CE', lots: 4, lotSize: 2500, delta: 0.4, gamma: 0.1 }),
    leg({ side: 'Buy', optType: 'CE', lots: 4, lotSize: 2500, delta: 0.4, gamma: 0.1 }),
  ]
  const c = corridor(inputsOf(bareChain(300), legs), plain({ gamma_shorts_only: false, delta_shorts_only: false }))
  assert.equal(c.netGamma, 0)
  assert.equal(c.allowed, 0)
  assert.equal(c.hasGreeks, true)
})

// ── floorRef ────────────────────────────────────────────────────────────────

test('THE VEDL/TCS CONVEXITY HOLD: scan off, floorRef is one whole lot and the band is under it', () => {
  // The live TCS-2026-08-25-recenter-relief-r book on 2026-08-12
  // (playbooks.py:4038-4046): a short 2440 PE 132 points ITM is synthetic
  // stock, and the long 2220 PE held against it cancels most of the convexity
  // that is left. netΓ -2.0 against a 225 lot gives allowance 92, and the
  // floor then held the delta phase silent all session while the book carried
  // netΔ +483. On VEDL Dec-25 the same guard returned "no convexity" for 879
  // of 911 remaining marks while spot rallied 12% into four naked calls
  // (playbooks.py:3567-3577).
  const SHARES = 3 * 225
  const tcs = [
    leg({
      side: 'Sell',
      optType: 'PE',
      lots: 3,
      lotSize: 225,
      delta: 483 / SHARES,
      gamma: 2.0 / SHARES,
    }),
  ]
  const inputs = inputsOf(bareChain(2300, 20, 25), tcs)
  const c = corridor(inputs, plain({ shed_scan_strikes: 0 }))

  assert.ok(Math.abs(c.netDelta - 483) < 1e-9, `netDelta ${c.netDelta}`)
  assert.ok(Math.abs(c.netGamma + 2.0) < 1e-9, `netGamma ${c.netGamma}`)
  assert.ok(Math.abs(c.allowed - 92) < 1e-9, `allowed ${c.allowed}`) // 2.0 x 0.02 x 2300
  assert.equal(c.floorRef, 225) // the SHORT leg's lot, not the chain's 25
  assert.ok(c.allowed < c.floorRef, 'the caller holds: no convexity to centre')
  assert.ok(Math.abs(c.excess - 391) < 1e-9, `excess ${c.excess}`) // 483 - 92

  // min_band_lots is the escape: 2 lots of 225 clears the floor outright.
  const clamped = corridor(inputs, plain({ shed_scan_strikes: 0, min_band_lots: 2 }))
  assert.equal(clamped.allowed, 450)
  assert.ok(clamped.allowed >= clamped.floorRef, 'the clamp lifts the band over the floor')
})

test('with the scan on, floorRef is the FINEST lot in range — the furthest strike, not the nearest', () => {
  const chain = chainOf(300, [270, 280, 290, 300, 310, 320, 330], 10, 25)
  // netΔ > 0 sheds by selling CALLS, so the scan walks the CE ladder out.
  // The lot is the book's 25 — floorRef is a delta-per-LOT, so the two must
  // come from the same place (see the short-leg-lot test below).
  const legs = [leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 25, delta: 0.9, gamma: 0.1 })]
  const c = corridor(inputsOf(chain, legs), plain({ shed_scan_strikes: 3 }))

  const dpsAt = (k: number, type: OptType) =>
    Math.abs(b76Greeks({ future: 300, strike: k, t: T7, vol: VOL, rate: RISK_FREE, type }).delta)

  // Candidates are 310/320/330; the finest lot is the furthest of the three.
  // Relative, not absolute: the chain's greeks come back through an IV SOLVE
  // off the mid, and on a 0.011-delta strike the solver's residual (~1.5e-5
  // relative) dwarfs any absolute epsilon worth writing.
  assert.ok(Math.abs(c.floorRef / (dpsAt(330, 'CE') * 25) - 1) < 1e-4, `floorRef ${c.floorRef}`)
  assert.ok(c.floorRef < dpsAt(310, 'CE') * 25, 'the nearest strike must not win')
  // Hand-derived: d1 = (ln(300/330) + 0.09 x t/2)/(0.3 x sqrt t) = -2.2732,
  // delta = e^{-rt} N(d1) = 0.99875 x 0.01151 = 0.011496; x 25 = 0.2874.
  assert.ok(Math.abs(c.floorRef - 0.2874) < 5e-4, `floorRef ${c.floorRef}`)
})

test('the scan walks the side whose SALE sheds the delta the book is carrying', () => {
  const chain = chainOf(300, [270, 280, 290, 300, 310, 320, 330], 10, 25)
  // netΔ < 0 sheds by selling PUTS: a short CE book walks the PE ladder down.
  const legs = [leg({ side: 'Sell', optType: 'CE', lots: 4, lotSize: 25, delta: 0.9, gamma: 0.1 })]
  const c = corridor(inputsOf(chain, legs), plain({ shed_scan_strikes: 3 }))
  const dpsAt = (k: number) =>
    Math.abs(b76Greeks({ future: 300, strike: k, t: T7, vol: VOL, rate: RISK_FREE, type: 'PE' }).delta)
  assert.ok(c.netDelta < 0)
  assert.ok(Math.abs(c.floorRef / (dpsAt(270) * 25) - 1) < 1e-4, `floorRef ${c.floorRef}`)
  assert.ok(c.floorRef < dpsAt(290) * 25, 'the nearest strike must not win')
  // Hand-derived: d1 = (ln(300/270) + 0.09 x t/2)/(0.3 x sqrt t) = +2.5567,
  // |delta| = e^{-rt} N(-d1) = 0.99875 x 0.00528 = 0.005273; x 25 = 0.1318.
  assert.ok(Math.abs(c.floorRef - 0.1318) < 5e-4, `floorRef ${c.floorRef}`)
})

test('a scan that finds nothing falls back to the whole lot — never to a 0.30 stand-in', () => {
  // Chain rows exist but neither wing has a book, so no strike solves.
  const chain: ChainSnap = {
    ...chainOf(300, [], 10, 25),
    strikes: [310, 320, 330].map((k) => ({ strike: k, ce: null, pe: null })),
  }
  const legs = [leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 2500, delta: 0.9, gamma: 0.1 })]
  const c = corridor(inputsOf(chain, legs), plain({ shed_scan_strikes: 3 }))
  assert.equal(c.floorRef, 2500) // the short leg's lot
  assert.notEqual(c.floorRef, 0.3 * 2500)
})

test('floorRef takes the SHORT leg lot Python read, and the chain lot only when there is no short', () => {
  const chain = bareChain(300, 10, 50)
  const shorted = corridor(
    inputsOf(chain, [leg({ side: 'Sell', lots: 1, lotSize: 225, delta: 0.5, gamma: 0.01 })]),
    plain(),
  )
  assert.equal(shorted.floorRef, 225)

  const longsOnly = corridor(
    inputsOf(chain, [leg({ side: 'Buy', lots: 1, lotSize: 225, delta: 0.5, gamma: 0.01 })]),
    plain(),
  )
  assert.equal(longsOnly.floorRef, 50) // ChainSnap.lotSize, not Python's 1.0
})

// ── what the corridor deliberately does NOT do ──────────────────────────────

test('protected quantity is COUNTED — protection limits actions, not measurement', () => {
  const held = leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 2500, delta: 0.9, gamma: 0.1 })
  const bare = corridor(inputsOf(bareChain(300), [held]), plain())
  const guarded = corridor(
    inputsOf(bareChain(300), [held], { protectedQty: { [held.instrument]: 4 } }),
    plain(),
  )
  assert.deepEqual(guarded, bare)
})

test('a flat book measures zero and says its greeks are fine — the caller owns the flat-book hold', () => {
  const c = corridor(inputsOf(bareChain(300, 10, 25), []), plain())
  assert.equal(c.netDelta, 0)
  assert.equal(c.netGamma, 0)
  assert.equal(c.allowed, 0)
  assert.equal(c.excess, 0)
  assert.equal(c.hasGreeks, true)
  assert.equal(c.floorRef, 25)
})

// ── the strike ladder the floor scan walks ──────────────────────────────────

test('nearestStrike snaps to a REAL chain strike, and rounds on the step only when there is no chain', () => {
  const chain = chainOf(300, [270, 290, 310, 330], 20, 25)
  assert.equal(nearestStrike(chain, 296), 290)
  assert.equal(nearestStrike(chain, 305), 310)
  assert.equal(nearestStrike(chain, 9999), 330) // clamps at the edge of the chain
  assert.equal(nearestStrike(bareChain(300, 20), 296), 300) // round(296/20) x 20
})

test('otmSellStrike pushes outward until it is STRICTLY OTM against spot', () => {
  // A coarse grid: atm+1 step lands ON spot, so the walk has to push again.
  const chain = chainOf(300, [280, 300, 320, 340], 20, 25)
  assert.equal(otmSellStrike(chain, 300, 'CE', 300, 0), 320)
  assert.equal(otmSellStrike(chain, 300, 'CE', 300, 1), 320)
  assert.equal(otmSellStrike(chain, 300, 'CE', 300, 2), 340)
  assert.equal(otmSellStrike(chain, 300, 'PE', 300, 0), 280)
  assert.equal(otmSellStrike(chain, 300, 'PE', 300, 2), 280) // 260 snaps back to 280
})

test('otmSellStrike stops at the EDGE of the chain rather than walking off it', () => {
  // Nothing above spot to sell: the push runs out of grid and takes what it has
  // rather than looping. A caller that needs "strictly OTM" must re-check.
  const chain = chainOf(300, [280, 300], 20, 25)
  assert.equal(otmSellStrike(chain, 300, 'CE', 300, 1), 300)
  assert.equal(otmSellStrike(chain, 300, 'CE', 300, 4), 300)
})

// ── PORTED FROM PYTHON — the band gate, `tests/test_sim_recenter.py` ────────
//
// The Python fixtures state a DECLARED `marked_book["net"]` and let the legs be
// whatever they are; `corridor()` sums the legs instead, on purpose (a declared
// total that contradicts its own legs is the ambiguity the port retires — see
// `parity-adapter.ts` §1b). So each net below is BUILT: one short leg of 100
// lots x 100 shares, per-share δ and Γ chosen so `δ x 10,000` and `Γ x 10,000`
// land on the recorded figures.
//
// `delta_shorts_only` / `gamma_shorts_only` are FALSE throughout this block:
// they are absent from `DEFAULTS["recenter"]`, so the recorded boards steer off
// the whole book (`playbooks.py:2969-2971`). `DEFAULT_DIALS` is the relief-r
// LIVE set, where they are on, and folding the two together would test the
// defaults instead of the port.

/** The recorded family's dial shape: whole-book greeks, no scan, no floor dial. */
const recenterDials = (over: Partial<Dials> = {}): Dials =>
  plain({ delta_shorts_only: false, gamma_shorts_only: false, ...over })

/** A book whose net delta and net gamma are exactly `nd` / `ng`.
 * A short CE contributes `−δ·S` of delta; a short PE `+δ·S`. Gamma takes the
 * position sign alone, so a short is `−Γ·S` either way. */
function bookNet(nd: number, ng: number, shares = 10_000): LegView[] {
  const optType: OptType = nd <= 0 ? 'CE' : 'PE'
  return [
    leg({
      side: 'Sell',
      optType,
      strike: optType === 'CE' ? 310 : 290,
      lots: shares / 100,
      lotSize: 100,
      delta: Math.abs(nd) / shares,
      gamma: -ng / shares,
    }),
  ]
}

test('PORTED: the allowance is |netΓ| x tol x spot, and 6,000 is what 1,000 buys', () => {
  // `test_holds_inside_the_tolerance`: spot 300, |Γ| 1,000 → 1,000 × 0.02 × 300.
  const cor = corridor(inputsOf(bareChain(300, 5, 100), bookNet(-5000, -1000)), recenterDials())
  assert.equal(cor.netDelta, -5000)
  assert.equal(cor.netGamma, -1000)
  assert.equal(cor.allowed, 6000)
  assert.ok(cor.excess < 0, 'inside the band')
})

test('PORTED: EXACTLY at the allowance holds; a hundred shares past it fires', () => {
  // `test_holds_exactly_at_the_allowance` + `test_fires_just_past_the_allowance`.
  const at = corridor(inputsOf(bareChain(300, 5, 100), bookNet(-6000, -1000)), recenterDials())
  assert.equal(at.excess, 0, 'excess 0 is not a breach — `> allowed`, never `>=`')
  const past = corridor(inputsOf(bareChain(300, 5, 100), bookNet(-6100, -1000)), recenterDials())
  assert.equal(past.excess, 100)
})

test('PORTED: thin gamma leaves an allowance under one lot — no convexity to centre', () => {
  // `test_thin_gamma_holds`: allowed = 10 × 0.02 × 300 = 60, under the 100 lot.
  // "the book is stock, not options, and no option selling moves a delta that
  // cannot move."
  const cor = corridor(inputsOf(bareChain(300, 5, 100), bookNet(-8000, -10)), recenterDials())
  assert.equal(cor.allowed, 60)
  assert.equal(cor.floorRef, 100, 'the whole lot, with the scan off')
  assert.ok(cor.allowed < cor.floorRef)
})

test('PORTED: the 2026-06-29 case — Δ −2,999 against Γ −0.0 does NOT demand a flat book', () => {
  // `test_zero_gamma_with_large_delta_holds`. The raw formula makes the whole
  // net delta an excess; the one-lot allowance floor is what holds instead.
  const cor = corridor(inputsOf(bareChain(977.5, 5, 100), bookNet(-2999, 0)), recenterDials())
  assert.equal(cor.allowed, 0)
  assert.equal(cor.excess, 2999, 'the raw excess IS the whole delta')
  assert.ok(cor.allowed < cor.floorRef, 'and the floor is what refuses it')
  assert.equal(cor.hasGreeks, true, 'a genuinely flat gamma is MARKED, not missing')
})

test('PORTED: a LONG gamma gives the same allowance as its negative twin', () => {
  // `test_long_gamma_uses_the_magnitude`. `allowed` is keyed to |netΓ|.
  const short = corridor(inputsOf(bareChain(300, 5, 100), bookNet(-5000, -1000)), recenterDials())
  const long = corridor(
    inputsOf(
      bareChain(300, 5, 100),
      [leg({ side: 'Buy', optType: 'CE', lots: 100, lotSize: 100, delta: 0.5, gamma: 0.1 })],
    ),
    recenterDials(),
  )
  assert.equal(long.netGamma, 1000)
  assert.equal(long.allowed, short.allowed)
  assert.equal(long.allowed, 6000)
})

test('PORTED: the √dte shrink halves the tolerance at a quarter of the reference life', () => {
  // `test_sim_recenter_unwind.py:test_the_tolerance_shrinks_with_the_square_root_of_time`
  // and its two companions. tol_ref_dte 20, dte 5 → √(5/20) = ½.
  const at5 = corridor(
    inputsOf(bareChain(300, 5, 100), bookNet(-5000, -1000), { dte: 5 }),
    recenterDials({ tol_ref_dte: 20 }),
  )
  assert.equal(at5.tol, 0.01)
  assert.equal(at5.allowed, 3000)

  // `test_the_tolerance_never_widens_past_the_dial`: beyond the reference life
  // it is the plain 2%, never more.
  const at40 = corridor(
    inputsOf(bareChain(300, 5, 100), bookNet(-5000, -1000), { dte: 40 }),
    recenterDials({ tol_ref_dte: 20 }),
  )
  assert.equal(at40.tol, 0.02)
  assert.equal(at40.allowed, 6000)

  // `test_tol_ref_dte_unset_is_the_old_behaviour`: 0 is off, at every dte.
  const off = corridor(
    inputsOf(bareChain(300, 5, 100), bookNet(-5000, -1000), { dte: 5 }),
    recenterDials({ tol_ref_dte: 0 }),
  )
  assert.equal(off.allowed, 6000)
})
