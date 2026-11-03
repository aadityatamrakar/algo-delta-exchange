/**
 * THE SIX TIERS, PINNED TO ARITHMETIC A HUMAN CAN CHECK.
 *
 * Every number below is hand-derived in the comment beside it, off a chain
 * whose greeks are DECLARED rather than solved: the book is priced
 * `pricing: 'parity'` with a `strikeGreeksOverride`, so a strike's delta is the
 * literal in this file and not a Black-76 round trip. That is the point — these
 * tests are about the tiers' arithmetic, and a solver in the middle would turn
 * every assertion into a claim about `@algomaker/greeks` instead.
 *
 * The ladder is 260…340 by 10 around spot 300 with a 100 lot, so with
 * `strikes_out` 2 the CE sale lands on 320 and the PE sale on 280, and one
 * strike step is a round 10.
 *
 * Four things would otherwise pass silently and each has its own block:
 *
 *   1. THE UNWIND'S SECOND BOUND. `budget` is easy and `gamma_budget` is the one
 *      that was learned the expensive way: a buy-back REMOVES the short gamma
 *      that widens the very band the rule steers by, and unbounded that is a
 *      spiral measured at 7% → 46% of marks outside the band
 *      (`playbooks.py:2828-2842`). A port that honoured only the delta budget
 *      passes every happy-path test.
 *   2. THE BANK IS A DEPOSIT AND A DEFERRED DEBIT. `rcCredit` moves on emit;
 *      the spend rides on `creditCommit` because the sale has not happened yet
 *      and the caller's gates may drop it (`:3755-3760`). A port that debited
 *      immediately loses ~₹2L of credit per board to sales that never filled.
 *   3. THE SWEEP CONSUMES THE SESSION, NOT THE SALE. Once per date, outcome
 *      blind (`:3470-3474`).
 *   4. THE ANCHOR EMA ADVANCES ON A HOLD. "An EMA sampled only when the rule
 *      acts is not an EMA of spot" (`:3510-3512`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  RISK_FREE,
  applyAnchor,
  applyConfirm,
  applyEodSweep,
  applyRecycle,
  applyTrendTarget,
  balanceTier,
  corridor,
  lifoUnwind,
  phaseShed,
  recycleLoss,
  recycleStrike,
  unwindStack,
  type ChainSnap,
  type Corridor,
  type Dials,
  type EngineInputs,
  type LegView,
  type OptType,
  type Quote,
  type RuleState,
} from '@algomaker/desk-engine'

const DATE = '2026-06-02'
const NEXT_DAY = '2026-06-03'
const EXPIRY = '2026-06-30'
const MINUTE = 560 // 09:20 IST
const EOD_MIN = 915 // 15:15, `recenter-eod`'s dial
const NOW = 1_770_000_000_000
const LOT = 100
const LADDER = [260, 270, 280, 290, 300, 310, 320, 330, 340]

/** Python's chain row: ONE price per contract, no book at all (`types.ts` §1 is
 * the defect this reproduces). `midOf` reads the ltp straight back in parity. */
const px = (ltp: number): Quote => ({ bid: null, ask: null, ltp, asOf: NOW })

/** Every strike quoted at a round 6.00 unless named — the recycle sizes off
 * this number and nothing else does. */
function chainOf(spot = 300, prices: ReadonlyMap<number, number> = new Map()): ChainSnap {
  return {
    symbol: 'TEST',
    expiry: EXPIRY,
    step: 10,
    lotSize: LOT,
    future: px(spot),
    spot,
    strikes: LADDER.map((k) => ({ strike: k, ce: px(prices.get(k) ?? 6), pe: px(prices.get(k) ?? 6) })),
    asOf: NOW,
  }
}

/**
 * The DECLARED chain greeks — a linear delta ladder, 0.5 at the money and
 * 0.1 per strike step, capped into [0.02, 0.98] exactly as the fixture
 * generator's own clamp does. Gamma is a flat 0.02 everywhere, so a gamma
 * assertion is never about the shape of a bell.
 *
 * Rounded to 2dp because `0.7 − 1` is `−0.30000000000000004` in IEEE 754, and a
 * `floor(room / perLot)` one ulp the wrong side of a whole number turns a
 * hand-checked 10 into a 9. The recorded fixtures carry decimals that are exact
 * in the file; this reproduces that property rather than the float noise of
 * generating them here.
 */
const declared = (spot: number) => (strike: number, optType: OptType) => {
  const call = Math.min(0.98, Math.max(0.02, 0.5 - (strike - spot) / 100))
  const delta = optType === 'CE' ? call : call - 1
  return { delta: Math.round(delta * 100) / 100, gamma: 0.02 }
}

let legSeq = 0
function leg(over: Partial<LegView> = {}): LegView {
  legSeq += 1
  return {
    instrument: `L${legSeq}`,
    strike: 300,
    optType: 'PE',
    side: 'Sell',
    lots: 10,
    lotSize: LOT,
    entry: 5,
    openedByEngine: true,
    // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
    leanId: '',
    iv: 0.18,
    delta: 0.5,
    gamma: 0.02,
    // Inert on every recenter path — nothing here reads either greek. Carried
    // because `LegView` requires them (`types.ts`): theta per calendar day,
    // vega per vol point, both per-share.
    theta: 0,
    vega: 0,
    hasGreeks: true,
    mtm: 0,
    exit: px(5),
    ...over,
  }
}

function inputsOf(legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  const chain = over.chain ?? chainOf()
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: NOW,
    dateIst: DATE,
    minuteOfDay: MINUTE,
    dte: 20,
    chain,
    legs,
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'broker', asOf: NOW, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'parity',
    strikeGreeksOverride: declared(chain.spot),
    ...over,
  }
}

const dialsOf = (over: Partial<Dials> = {}): Dials => ({
  ...DEFAULT_DIALS,
  // The recenter family's shape: no scan, no band dial, every tier off until a
  // test switches one on. `DEFAULT_DIALS` is the relief-r LIVE set, which is a
  // different book (`dials.ts` header).
  shed_scan_strikes: 0,
  shift_enabled: false,
  ...over,
})

const stateOf = (over: Partial<RuleState> = {}): RuleState => ({ ...EMPTY_RULE_STATE, ...over })

/**
 * A LIVE chain: every wing two-sided at ±2% around its Black-76 price, so the
 * spread gate passes and `greekReader` can solve a real greek off the mid —
 * named wings replaced by a ONE-SIDED book (`ltp` set, no bid/ask), which is
 * exactly what a contract that has quotes but no depth looks like on the feed.
 *
 * Used only by the live-pricing gate tests. Everything else in this file runs
 * `pricing: 'parity'` with declared greeks, because the tiers' arithmetic is
 * the subject there and a solver in the middle would make every assertion a
 * claim about `@algomaker/greeks` instead.
 */
const T7 = 7 / 365
const VOL = 0.3
function liveChain(oneSided: ReadonlyArray<`${number}${OptType}`> = []): ChainSnap {
  const bare = new Set<string>(oneSided)
  const wing = (k: number, ot: OptType): Quote => {
    const p = b76Price({ future: 300, strike: k, t: T7, vol: VOL, rate: RISK_FREE, type: ot })
    return bare.has(`${k}${ot}`)
      ? { bid: null, ask: null, ltp: p, asOf: NOW }
      : { bid: p * 0.98, ask: p * 1.02, ltp: p, asOf: NOW }
  }
  return {
    symbol: 'TEST',
    expiry: EXPIRY,
    step: 10,
    lotSize: LOT,
    future: { bid: 299.5, ask: 300.5, ltp: 300, asOf: NOW },
    spot: 300,
    strikes: LADDER.map((k) => ({ strike: k, ce: wing(k, 'CE'), pe: wing(k, 'PE') })),
    asOf: NOW,
  }
}

/** The book both live-gate tests run: a short 290 PE deep enough to matter and
 * ₹10,000 under water, plus a short 310 CE.
 *   netΔ = +550 − 25 = +525    netΓ = −(0.0231 × 1,000) × 2 = −46.2
 *   allowed = 46.2 × 0.02 × 300 = 277.2 */
const recycleBook = () => [
  leg({ instrument: 'PE290', optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231, mtm: -10_000 }),
  leg({ instrument: 'CE310', optType: 'CE', strike: 310, delta: 0.025, gamma: 0.0231 }),
]

/** A corridor literal, for the tiers that take one as a measurement rather than
 * computing it. Only the fields each tier reads are meaningful. */
const corOf = (over: Partial<Corridor> = {}): Corridor => ({
  allowed: 0,
  netDelta: 0,
  netGamma: 0,
  hasGreeks: true,
  floorRef: LOT,
  excess: 0,
  tol: 0.02,
  ...over,
})

// ════════════════════════════════════════════════════════════════════════════
// 1. THE EOD SWEEP — arms once per session, outcome-blind
// ════════════════════════════════════════════════════════════════════════════

test('the EOD sweep arms on the first mark at or after the dial, and NOT before it', () => {
  const d = dialsOf({ eod_flat_min: EOD_MIN })
  const before = applyEodSweep(inputsOf([leg()], { minuteOfDay: 910 }), d, EMPTY_RULE_STATE)
  assert.equal(before.armed, false, '15:10 is before 15:15')
  assert.equal(before.rcEodDay, '', 'and it consumes nothing')

  const at = applyEodSweep(inputsOf([leg()], { minuteOfDay: EOD_MIN }), d, EMPTY_RULE_STATE)
  assert.equal(at.armed, true, 'the comparison is >=, not >')
  assert.equal(at.rcEodDay, DATE)
})

test('EOD arms EXACTLY ONCE per date — the second eligible mark is an ordinary one', () => {
  // playbooks.py:3470-3474: "the first eligible mark consumes the day whether
  // the sale is emitted, downsized by the margin projection, dropped by the
  // scrap gate or comes out sub-lot. Retrying in the session tail would chase
  // the gamma the sweep itself just added."
  const d = dialsOf({ eod_flat_min: EOD_MIN })
  const first = applyEodSweep(inputsOf([leg()], { minuteOfDay: EOD_MIN }), d, EMPTY_RULE_STATE)
  const consumed = stateOf({ rcEodDay: first.rcEodDay })

  for (const minuteOfDay of [EOD_MIN, 920, 925, 930]) {
    const again = applyEodSweep(inputsOf([leg()], { minuteOfDay }), d, consumed)
    assert.equal(again.armed, false, `re-armed at minute ${minuteOfDay}`)
    assert.equal(again.rcEodDay, DATE, 'and the stamp is unchanged')
  }

  // A NEW session arms again — the stamp is a date, not a latch.
  const tomorrow = applyEodSweep(
    inputsOf([leg()], { minuteOfDay: EOD_MIN, dateIst: NEXT_DAY }),
    d,
    consumed,
  )
  assert.equal(tomorrow.armed, true)
  assert.equal(tomorrow.rcEodDay, NEXT_DAY)
})

test('eod_flat_min 0 is the off-state, not a sweep at midnight', () => {
  const off = applyEodSweep(inputsOf([leg()], { minuteOfDay: 930 }), dialsOf(), EMPTY_RULE_STATE)
  assert.equal(off.armed, false)
  assert.equal(off.rcEodDay, '')
})

test('THE SWEEP SHEDS THE WHOLE netΔ, and the next mark sheds only the excess', () => {
  // Book: short 290 PE (δ 0.55/share) + short 310 CE (δ 0.025/share), 10 lots of
  // 100 each, γ 0.0231/share on both.
  //   netΔ = +550 − 25 = +525      netΓ = −(0.0231 × 1000) × 2 = −46.2
  //   allowed = 46.2 × 0.02 × 300 = 277.2   excess = 247.8
  // The sale is the fixed strikes_out strike, 320 CE, declared δ 0.30 → 30/lot.
  //   ordinary mark: round(247.8 / 30) =  8 lots
  //   swept  mark:   round(525.0 / 30) = 18 lots   (tolerance 0, whole book)
  const book = [
    leg({ optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231 }),
    leg({ optType: 'CE', strike: 310, delta: 0.025, gamma: 0.0231 }),
  ]
  const d = dialsOf({ eod_flat_min: EOD_MIN })

  const ordinary = inputsOf(book, { minuteOfDay: 910 })
  const plain = phaseShed(ordinary, d, EMPTY_RULE_STATE, corridor(ordinary, d))
  assert.deepEqual(plain.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 8, add: true }])
  assert.equal(plain.stateAfter.rcEodDay, '', 'an ordinary mark consumes nothing')

  const swept = inputsOf(book, { minuteOfDay: EOD_MIN })
  const sweep = phaseShed(swept, d, EMPTY_RULE_STATE, corridor(swept, d))
  assert.deepEqual(sweep.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 18, add: true }])
  assert.match(sweep.reason, /15:15 sweep/)
  assert.equal(sweep.stateAfter.rcEodDay, DATE)

  // Threading that state into the next mark gives the ordinary sale back.
  const after = phaseShed(
    inputsOf(book, { minuteOfDay: 920 }),
    d,
    sweep.stateAfter,
    corridor(inputsOf(book, { minuteOfDay: 920 }), d),
  )
  assert.deepEqual(after.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 8, add: true }])
})

test('the sweep bypasses the convexity floor — a book with no gamma left is the one to flatten', () => {
  // playbooks.py:3564-3566. netΓ −0.5 × 1000 shares… no: γ 0.0002/share over
  // 1,000 shares is netΓ −0.2, so allowed = 0.2 × 0.02 × 300 = 1.2, far under
  // the 100 lot — the floor would hold, and does without the dial.
  const thin = [leg({ optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0002 })]
  const held = inputsOf(thin, { minuteOfDay: EOD_MIN })
  const floored = phaseShed(held, dialsOf(), EMPTY_RULE_STATE, corridor(held, dialsOf()))
  assert.deepEqual(floored.actions, [])
  assert.match(floored.reason, /no convexity to centre/)

  const d = dialsOf({ eod_flat_min: EOD_MIN })
  const swept = phaseShed(held, d, EMPTY_RULE_STATE, corridor(held, d))
  // netΔ +550, 320 CE at 0.30 → 30/lot → round(550/30) = 18.
  assert.deepEqual(swept.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 18, add: true }])
})

// ════════════════════════════════════════════════════════════════════════════
// 2. THE gk-ANCHOR — an EMA of SPOT, and a streak that resets in the band
// ════════════════════════════════════════════════════════════════════════════

test('the anchor EMA is seeded to spot and then lags it at alpha = 2/(n+1)', () => {
  const d = dialsOf({ anchor_ema_marks: 4 }) // alpha = 2/5 = 0.4
  const first = applyAnchor(inputsOf([leg()]), d, EMPTY_RULE_STATE)
  assert.equal(first.anchor, 300, 'unset seeds to spot — the arm degrades to its parent')
  assert.equal(first.gkAnchor, 300)

  // 0.4 × 300 + 0.6 × 280 = 120 + 168 = 288
  const next = applyAnchor(inputsOf([leg()]), d, stateOf({ gkAnchor: 280 }))
  assert.equal(next.anchor, 288)
  assert.equal(next.gkAnchor, 288)
})

test('anchor_ema_marks 0 leaves the anchor AT spot and never writes the key', () => {
  const r = applyAnchor(inputsOf([leg()]), dialsOf(), stateOf({ gkAnchor: 280 }))
  assert.equal(r.anchor, 300)
  assert.equal(r.gkAnchor, 280, 'the dial is off; an operator arm is not cleared behind their back')
})

test('THE EMA ADVANCES ON A HOLD MARK — an EMA sampled only when the rule acts is not an EMA', () => {
  // playbooks.py:3510-3512. Book INSIDE its band, so the mark holds:
  //   one short 300 PE, δ 0.10/share over 1,000 shares → netΔ +100
  //   γ 0.02/share → netΓ −20 → allowed = 20 × 0.02 × 300 = 120 > 100. Hold.
  const inside = [leg({ optType: 'PE', strike: 300, delta: 0.1, gamma: 0.02 })]
  const d = dialsOf({ anchor_ema_marks: 4 })
  const inputs = inputsOf(inside)
  const r = phaseShed(inputs, d, stateOf({ gkAnchor: 280 }), corridor(inputs, d))
  assert.deepEqual(r.actions, [], 'this mark did nothing')
  assert.match(r.reason, /inside allowed/)
  assert.equal(r.stateAfter.gkAnchor, 288, 'and still moved the anchor')
})

test('the anchor moves WHERE the sale lands, and never lands it ITM', () => {
  // Anchor 260, spot 300, strikes_out 2 → 260 + 20 = 280, which is INSIDE spot
  // for a call, so `otmSellStrike` pushes it out to 310 (`ladder.ts`). Without
  // the dial the same book sells 320.
  const book = [leg({ optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231 })]
  const plain = phaseShed(inputsOf(book), dialsOf(), EMPTY_RULE_STATE, corridor(inputsOf(book), dialsOf()))
  assert.equal(plain.actions[0]?.op === 'open' ? plain.actions[0].strike : 0, 320)

  const d = dialsOf({ anchor_ema_marks: 1 }) // alpha = 1: the anchor IS the prev-blend
  const anchored = phaseShed(inputsOf(book), d, stateOf({ gkAnchor: 260 }), corridor(inputsOf(book), d))
  // alpha 1 ⇒ anchor = spot = 300, so this arm sells 320 too — the interesting
  // case is a genuinely lagged anchor:
  assert.equal(anchored.actions[0]?.op === 'open' ? anchored.actions[0].strike : 0, 320)

  const lagged = dialsOf({ anchor_ema_marks: 99 }) // alpha ≈ 0.02: the anchor barely moves
  const r = phaseShed(inputsOf(book), lagged, stateOf({ gkAnchor: 260 }), corridor(inputsOf(book), lagged))
  const sold = r.actions[0]
  assert.equal(sold?.op === 'open' ? sold.strike : 0, 310, 'anchored at ~261, pushed out to strictly OTM')
})

test('the breach streak counts CONSECUTIVE breaches and an in-band mark resets it', () => {
  const d = dialsOf({ confirm_marks: 3 })
  const one = applyConfirm(d, EMPTY_RULE_STATE, true)
  assert.deepEqual(one, { streak: 1, confirmed: false })
  const two = applyConfirm(d, stateOf({ gkStreak: 1 }), true)
  assert.deepEqual(two, { streak: 2, confirmed: false })
  const three = applyConfirm(d, stateOf({ gkStreak: 2 }), true)
  assert.deepEqual(three, { streak: 3, confirmed: true }, 'the comparison is >=')

  // playbooks.py:3603-3607: maintained BEFORE the in-band return, so a spike
  // that reverts inside the window costs nothing at all.
  assert.deepEqual(applyConfirm(d, stateOf({ gkStreak: 2 }), false), { streak: 0, confirmed: false })

  // Off: always confirmed, and the streak is left exactly as it was.
  assert.deepEqual(applyConfirm(dialsOf(), stateOf({ gkStreak: 2 }), true), {
    streak: 2,
    confirmed: true,
  })
})

test('an unconfirmed breach holds, and the streak zeroes on the mark that EMITS', () => {
  const book = [leg({ optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231 })]
  const d = dialsOf({ confirm_marks: 2 })
  const inputs = inputsOf(book)
  const cor = corridor(inputs, d)

  const first = phaseShed(inputs, d, EMPTY_RULE_STATE, cor)
  assert.deepEqual(first.actions, [], 'one mark old — unconfirmed')
  assert.match(first.reason, /1\/2 marks old/)
  assert.equal(first.stateAfter.gkStreak, 1)

  const second = phaseShed(inputs, d, first.stateAfter, cor)
  assert.ok(second.actions.length > 0, 'the second consecutive breach acts')
  assert.equal(second.stateAfter.gkStreak, 0, 'reset on EMIT, not on execution')
})

// ════════════════════════════════════════════════════════════════════════════
// 3. THE TREND-SKEWED TARGET
// ════════════════════════════════════════════════════════════════════════════

test('with the dial off the budget IS the excess and the target is the near edge', () => {
  // playbooks.py:3653-3656 — `tdir = 1 if nd < 0 else -1`, `target = -tdir ×
  // allowed`. netΔ +500 means spot FELL (we sell calls), so `dir` is −1 and the
  // near edge is +200: the edge the book is already leaning toward, which on a
  // reversal is the edge AGAINST the new move. That is the whole complaint the
  // trend dial answers.
  assert.deepEqual(applyTrendTarget(dialsOf(), 500, 200, 300), {
    budget: 300,
    target: 200,
    dir: -1,
  })
  // Mirror: netΔ −500 leans short, so the move was UP, `dir` is +1 and the mark
  // ends at −allowed.
  assert.deepEqual(applyTrendTarget(dialsOf(), -500, 200, 300), {
    budget: 300,
    target: -200,
    dir: 1,
  })
})

test('trend_skew crosses the band instead of stopping at its lip', () => {
  // playbooks.py:3639-3659. netΔ +500 (spot FELL, we sell CE), allowed 200,
  // skew 0.5 ⇒ target = −1 × 0.5 × 200 = −100 and the budget is |500 − (−100)| =
  // 600 — double the 300 the plain rule would move.
  const d = dialsOf({ trend_enabled: true, trend_skew: 0.5 })
  assert.deepEqual(applyTrendTarget(d, 500, 200, 300), { budget: 600, target: -100, dir: -1 })

  // 0.0 is a LEGAL value — shed to flat — and is NOT the off-state.
  const flat = dialsOf({ trend_enabled: true, trend_skew: 0 })
  assert.deepEqual(applyTrendTarget(flat, 500, 200, 300), { budget: 500, target: -0, dir: -1 })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. THE LIFO UNWIND — the delta budget AND the gamma floor
// ════════════════════════════════════════════════════════════════════════════

/** One short PE, 10 lots × 100 shares, δ 0.50/share (50 a lot) and γ 0.02/share
 * (2 a lot). Its whole contribution to netΓ is −20. */
const stackLeg = () => leg({ instrument: 'PE290', optType: 'PE', strike: 290, delta: 0.5, gamma: 0.02 })

test('the unwind takes whole legs against the delta budget', () => {
  // gFloor = lot / (tol × spot) = 100 / (0.02 × 300) = 16.667.
  // |netΓ| 60 ⇒ gLeft = 43.33, and 43.33 / 2 = 21 lots of headroom — the floor
  // does not bind. budget 500 ⇒ round(500/50) = 10 lots = the whole leg.
  const l = stackLeg()
  const r = lifoUnwind(
    inputsOf([l]),
    dialsOf({ unwind_enabled: true }),
    EMPTY_RULE_STATE,
    corOf({ netGamma: -60, tol: 0.02 }),
    { stackSide: 'PE', budget: 500, lotSize: LOT },
  )
  assert.deepEqual(r.actions, [{ op: 'close', instrument: 'PE290' }])
  // Compared on the identity and the size rather than on the whole leg: since
  // ticket 08 the row `unwindStack` returns is the shared `SteerableLeg`, which
  // carries the spendable count alongside the position (`guards.ts` §1).
  assert.deepEqual(
    r.taken.map((t) => [t.leg.instrument, t.lots]),
    [[l.instrument, 10]],
  )
  assert.equal(r.shed, 500)
})

test('THE GAMMA FLOOR BOUNDS A FULL UNWIND — the whole leg would take the band with it', () => {
  // Same leg and the same 500-share budget, which alone buys the WHOLE 10 lots.
  // But |netΓ| is 20 here, so gLeft = 20 − 16.667 = 3.333 and the walk may spend
  // floor(3.333 / 2) = 1 lot. Taking ten would leave netΓ at 0 and the rule
  // would trip its own "no convexity to centre" guard on the next mark
  // (playbooks.py:2828-2842, measured 7% → 46% of marks outside the band).
  const l = stackLeg()
  const r = lifoUnwind(
    inputsOf([l]),
    dialsOf({ unwind_enabled: true }),
    EMPTY_RULE_STATE,
    corOf({ netGamma: -20, tol: 0.02 }),
    { stackSide: 'PE', budget: 500, lotSize: LOT },
  )
  assert.deepEqual(
    r.actions,
    [{ op: 'resize', instrument: 'PE290', targetLots: 9 }],
    'one lot, as a resize — a partial ends the walk',
  )
  assert.deepEqual(
    r.taken.map((t) => [t.leg.instrument, t.lots]),
    [[l.instrument, 1]],
  )
  assert.equal(r.shed, 50, 'one lot of 0.50-delta × 100 shares')
})

test('the floor can refuse the unwind outright, and then it takes nothing', () => {
  // |netΓ| 16 is UNDER the 16.667 floor: there is no convexity to spend.
  const r = lifoUnwind(
    inputsOf([stackLeg()]),
    dialsOf({ unwind_enabled: true }),
    EMPTY_RULE_STATE,
    corOf({ netGamma: -16, tol: 0.02 }),
    { stackSide: 'PE', budget: 500, lotSize: LOT },
  )
  assert.deepEqual(r.actions, [])
  assert.equal(r.shed, 0)
})

test('ONE LOT IS ALWAYS TAKEN while excess remains — the VEDL Dec-25 forced lot', () => {
  // playbooks.py:2874-2882. budget 3 shares against a 50-share lot rounds to
  // ZERO, "the walk broke and the rule sold the other side with its own legs
  // sitting right there (VEDL Dec-25: 12 times against a 10-leg CE stack)".
  const r = lifoUnwind(
    inputsOf([stackLeg()]),
    dialsOf({ unwind_enabled: true }),
    EMPTY_RULE_STATE,
    corOf({ netGamma: -60, tol: 0.02 }),
    { stackSide: 'PE', budget: 3, lotSize: LOT },
  )
  assert.deepEqual(r.actions, [{ op: 'resize', instrument: 'PE290', targetLots: 9 }])
  assert.equal(r.shed, 50, 'it overshoots INSIDE the band, which is where the sale would have put it')
})

test('unwind_enabled false takes nothing at all', () => {
  const r = lifoUnwind(
    inputsOf([stackLeg()]),
    dialsOf(),
    EMPTY_RULE_STATE,
    corOf({ netGamma: -60, tol: 0.02 }),
    { stackSide: 'PE', budget: 500, lotSize: LOT },
  )
  assert.deepEqual(r, { actions: [], taken: [], shed: 0 })
})

test('the stack is NEWEST first, then DEEPEST ITM — and never a long, a wing or a protected leg', () => {
  // Three short PEs at 280/290/300 against spot 300. Depth for a put is
  // (k − spot), so 300 is the deepest and 280 the furthest OTM.
  const pe280 = leg({ instrument: 'PE280', strike: 280 })
  const pe290 = leg({ instrument: 'PE290', strike: 290 })
  const pe300 = leg({ instrument: 'PE300', strike: 300 })
  const ce310 = leg({ instrument: 'CE310', strike: 310, optType: 'CE' })
  const longPe = leg({ instrument: 'LONG', strike: 270, side: 'Buy' })
  const legs = [pe280, pe290, pe300, ce310, longPe]

  const entry = unwindStack(inputsOf(legs), EMPTY_RULE_STATE, 'PE')
  assert.deepEqual(
    entry.map((l) => l.instrument),
    ['PE300', 'PE290', 'PE280'],
    'entry book is all sequence 0, so DEEPEST cuts first (ASHOKLEY 2026-08-03)',
  )

  // `rcStack` in ADD order: the 280 was added last, so it sorts FIRST however
  // shallow it is — that is the LIFO contract (`tiers.ts` §6).
  const added = unwindStack(
    inputsOf(legs),
    stateOf({ rcStack: [{ strike: 290, optType: 'PE', lots: 10 }, { strike: 280, optType: 'PE', lots: 10 }] }),
    'PE',
  )
  assert.deepEqual(
    added.map((l) => l.instrument),
    ['PE280', 'PE290', 'PE300'],
  )

  // Protected quantity is exempt at SELECTION — this stack IS the victim pool.
  const guarded = unwindStack(inputsOf(legs, { protectedQty: { PE300: 10 } }), EMPTY_RULE_STATE, 'PE')
  assert.deepEqual(
    guarded.map((l) => l.instrument),
    ['PE290', 'PE280'],
  )
})

test('a leg whose greeks did not mark is SKIPPED, never sized off a stand-in', () => {
  // Python fell back to the chain and then to `default_dps = 0.30` for DELTA
  // while already skipping the leg on a missing GAMMA. The same argument covers
  // both, and `hasGreeks` is what says so (`marking.ts` §2).
  const blind = leg({ instrument: 'BLIND', strike: 290, delta: 0, gamma: 0, hasGreeks: false })
  const r = lifoUnwind(
    inputsOf([blind]),
    dialsOf({ unwind_enabled: true }),
    EMPTY_RULE_STATE,
    corOf({ netGamma: -60, tol: 0.02 }),
    { stackSide: 'PE', budget: 500, lotSize: LOT },
  )
  assert.deepEqual(r.actions, [])
})

test('a partly protected leg resizes down to the tail the operator owns', () => {
  const l = stackLeg()
  const r = lifoUnwind(
    inputsOf([l], { protectedQty: { PE290: 4 } }),
    dialsOf({ unwind_enabled: true }),
    EMPTY_RULE_STATE,
    corOf({ netGamma: -60, tol: 0.02 }),
    { stackSide: 'PE', budget: 500, lotSize: LOT },
  )
  // 6 spendable lots; the budget wants 10, so it takes all 6 and stops at the tail.
  assert.deepEqual(r.actions, [{ op: 'resize', instrument: 'PE290', targetLots: 4 }])
  assert.equal(r.shed, 300)
})

// ════════════════════════════════════════════════════════════════════════════
// 5. THE RECYCLE — the credit bank and its DEFERRED debit
// ════════════════════════════════════════════════════════════════════════════

/** A short PE marked ₹10,000 under water, closed whole. */
const lossLeg = () => leg({ instrument: 'PE290', optType: 'PE', strike: 290, mtm: -10_000 })

const recycleOpts = (over: Partial<Parameters<typeof applyRecycle>[4]> = {}) => ({
  taken: [{ leg: lossLeg(), lots: 10 }],
  shedSide: 'CE' as OptType,
  stackSide: 'PE' as OptType,
  sellStrike: 320,
  sellLots: 0,
  sellDps: 0.3,
  shed: 0,
  lotSize: LOT,
  trendDir: -1,
  ...over,
})

test('recycleLoss prorates a partial and refuses to fund itself from a WINNER', () => {
  const l = lossLeg()
  assert.equal(recycleLoss([{ leg: l, lots: 10 }]), 10_000)
  assert.equal(recycleLoss([{ leg: l, lots: 3 }]), 3_000, 'take/lots, exactly')
  // playbooks.py:2907-2909: "a buyback at a PROFIT funds nothing… a winning
  // close must not become a reason to sell more" — and it may not net off a
  // loser in the same package either, because the max() is per leg.
  const winner = leg({ mtm: +50_000 })
  assert.equal(recycleLoss([{ leg: winner, lots: 10 }]), 0)
  assert.equal(recycleLoss([{ leg: winner, lots: 10 }, { leg: l, lots: 10 }]), 10_000)
})

test('the re-sell strike is pushed strictly BEYOND the leg just bought back', () => {
  const inputs = inputsOf([leg()])
  // The rule's own PE sale is 2 out = 280, and a 290 just bought back is already
  // cleared by it. Closing the 280 ITSELF makes re-selling there a wash trade,
  // so the walk pushes to 270.
  assert.equal(recycleStrike(inputs, 'PE', [], 2), 280)
  assert.equal(recycleStrike(inputs, 'PE', [290], 2), 280)
  assert.equal(recycleStrike(inputs, 'PE', [280], 2), 270)
  assert.equal(recycleStrike(inputs, 'PE', [260], 2), null, 'the chain ends at 260 — degrade to a plain unwind')
  // Calls push the other way; the bound is the FURTHEST closed strike.
  assert.equal(recycleStrike(inputs, 'CE', [320, 330], 2), 340)
})

test('THE BANK TAKES A SUB-LOT CREDIT AND CARRIES IT — the ASHOKLEY ₹2L that used to vanish', () => {
  // playbooks.py:3746-3755. frac 0.5 of a ₹10,000 loss is ₹5,000 of credit; the
  // 280 PE is quoted 60 here, so one lot costs 60 × 100 = ₹6,000 and `want` is
  // ⌊5000/6000⌋ = 0. Without the bank that credit is discarded; with it, it is
  // deposited and the sale simply waits.
  const chain = chainOf(300, new Map([[280, 60]]))
  const r = applyRecycle(
    inputsOf([leg()], { chain }),
    dialsOf({ recycle_frac: 0.5, recycle_bank: true }),
    EMPTY_RULE_STATE,
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts({ shed: 500 }),
  )
  assert.deepEqual(r.actions, [], 'nothing affordable this mark')
  assert.equal(r.credit, 5_000)
  assert.equal(r.rcCredit, 5_000, 'banked, not discarded')
  assert.equal(r.commit, null, 'nothing was spent, so there is nothing to debit')

  // Next mark, same loss: the bank now affords a lot. ⌊10,000/6,000⌋ = 1.
  const again = applyRecycle(
    inputsOf([leg()], { chain }),
    dialsOf({ recycle_frac: 0.5, recycle_bank: true }),
    stateOf({ rcCredit: 5_000 }),
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts({ shed: 500 }),
  )
  assert.deepEqual(again.actions, [{ op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 1 }])
  assert.equal(again.rcCredit, 10_000, 'the DEPOSIT is in the state…')
  assert.deepEqual(again.commit, { base: 10_000, value: 4_000, lots: 1, optType: 'PE', strike: 280 })
  // …and the DEBIT is not: the sale has not happened, and the caller's scrap
  // gate or margin projection may still drop or downsize it (`tiers.ts` §4).
  assert.notEqual(again.rcCredit, again.commit?.value)
})

test('without the bank each mark can spend only what it earned that mark', () => {
  const chain = chainOf(300, new Map([[280, 60]]))
  const r = applyRecycle(
    inputsOf([leg()], { chain }),
    dialsOf({ recycle_frac: 0.5 }),
    stateOf({ rcCredit: 5_000 }), // a bank the dial cannot see
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts({ shed: 500 }),
  )
  assert.deepEqual(r.actions, [], '⌊5,000 / 6,000⌋ = 0 — the standing bank is not spendable')
  assert.equal(r.rcCredit, 5_000, 'and it is not written either')
  assert.equal(r.commit, null)
})

test('the recycle is CLIPPED to the room its own landing point leaves in the band', () => {
  // frac 1.0 of ₹10,000 buys ⌊10,000 / (6 × 100)⌋ = 16 lots of the 280 PE at 6.
  // Closed-side arm: room = allowed + landed, where the package moved `shed`
  // 500 shares off netΔ +500, so landed = −1 × (500 + (−1 × 500)) = 0 and the
  // room is the whole 300-share band. The 280 PE's declared δ is −0.30, so a
  // lot is 30 shares and only ⌊300/30⌋ = 10 of the 16 fit.
  const r = applyRecycle(
    inputsOf([leg()]),
    dialsOf({ recycle_frac: 1 }),
    EMPTY_RULE_STATE,
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts({ shed: 500 }),
  )
  assert.deepEqual(r.actions, [{ op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 10 }])
})

test('the room is measured off where the PACKAGE landed, sale included — not off the target', () => {
  // playbooks.py:3793-3797: `got = shed + lots × dps × lot_size`. The gamma
  // floor can truncate the unwind and the residual sale rounds to whole lots,
  // so where the package ACTUALLY lands is what is measured (user-directed
  // 2026-08-03, "recenter ±2%").
  //
  // shed 500 plus a 4-lot sale of a 0.30-delta strike (4 × 0.30 × 100 = 120)
  // moves 620 off netΔ +500, landing at −120 — so `landed` is +120 and the
  // closed-side arm has allowed + 120 = 420 shares of room. At 30 a lot that is
  // 14 of the 16 lots the ₹10,000 credit could buy. Dropping the sale's own
  // contribution reads the landing point as 0 and clips to 10.
  const r = applyRecycle(
    inputsOf([leg()]),
    dialsOf({ recycle_frac: 1 }),
    EMPTY_RULE_STATE,
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts({ shed: 500, sellLots: 4, sellDps: 0.3 }),
  )
  assert.deepEqual(r.actions, [{ op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 14 }])
})

test('recycle_opposite sells the side the residual sale is already using, one strike further out', () => {
  // The crossfill arm: r_side is the SHED side (CE) and the bound is the
  // residual sale's own strike, 320 — so the recycle lands on 330.
  const r = applyRecycle(
    inputsOf([leg()]),
    dialsOf({ recycle_frac: 1, recycle_opposite: true }),
    EMPTY_RULE_STATE,
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts({ sellLots: 4, shed: 500 }),
  )
  // want = ⌊10,000 / (6 × 100)⌋ = 16; the FAR edge leaves allowed − landed =
  // 300 − 120 = 180 shares, and the 330 CE's declared δ is 0.20 → 20 a lot → 9.
  assert.deepEqual(r.actions, [{ op: 'open', strike: 330, optType: 'CE', side: 'Sell', lots: 9 }])
})

test('recycle_frac 0 and an unwind that took nothing both emit nothing', () => {
  const off = applyRecycle(
    inputsOf([leg()]),
    dialsOf(),
    EMPTY_RULE_STATE,
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts(),
  )
  assert.deepEqual(off.actions, [])
  assert.equal(off.rcCredit, 0)

  const nothingClosed = applyRecycle(
    inputsOf([leg()]),
    dialsOf({ recycle_frac: 1, recycle_bank: true }),
    stateOf({ rcCredit: 9_999 }),
    corOf({ netDelta: 500, allowed: 300 }),
    recycleOpts({ taken: [] }),
  )
  assert.deepEqual(nothingClosed.actions, [])
  assert.equal(nothingClosed.rcCredit, 9_999, 'the standing bank is untouched')
})

// ════════════════════════════════════════════════════════════════════════════
// 6. THE BALANCE TIER — a book that lost a side is rebuilt, not abandoned
// ════════════════════════════════════════════════════════════════════════════

const oneSided = () => [leg({ optType: 'PE', strike: 290, lots: 3, delta: 0.5, gamma: 0.0002 })]

test('a book missing a side is rebuilt, matched to the live side lots', () => {
  const r = balanceTier(
    inputsOf(oneSided(), { dte: 20 }),
    dialsOf({ balance_enabled: true, balance_min_dte: 7 }),
    corOf({ allowed: 12 }),
  )
  assert.deepEqual(r?.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 3 }])
  assert.match(r?.reason ?? '', /3 lot\(s\) of PE only/)
})

test('BALANCE REFUSES AT dte <= balance_min_dte — the comparison is strict', () => {
  const d = dialsOf({ balance_enabled: true, balance_min_dte: 7 })
  assert.equal(balanceTier(inputsOf(oneSided(), { dte: 7 }), d, corOf()), null, 'exactly 7 is refused')
  assert.equal(balanceTier(inputsOf(oneSided(), { dte: 6 }), d, corOf()), null)
  assert.notEqual(balanceTier(inputsOf(oneSided(), { dte: 8 }), d, corOf()), null, '8 rebuilds')
})

test('balance is not consulted on a book that still has both sides, or has neither', () => {
  const d = dialsOf({ balance_enabled: true, balance_min_dte: 7 })
  const strangle = [leg({ optType: 'PE', strike: 290 }), leg({ optType: 'CE', strike: 310 })]
  assert.equal(balanceTier(inputsOf(strangle), d, corOf()), null, 'both sides on: the floor is right')
  assert.equal(balanceTier(inputsOf([]), d, corOf()), null, 'nothing to match a rebuild to')
  const longOnly = [leg({ optType: 'PE', side: 'Buy' })]
  assert.equal(balanceTier(inputsOf(longOnly), d, corOf()), null, 'a long is not a side to match')
})

test('balance_enabled false leaves the convexity hold exactly as it was', () => {
  assert.equal(balanceTier(inputsOf(oneSided(), { dte: 20 }), dialsOf(), corOf()), null)
})

test("the rebuild answers to the SAME liquidity gate as phase R's own sale", () => {
  // A fresh sell is a fresh sell (`shed.ts` §4). The rebuild still stands so the
  // supervisor can maker-quote it — gate failure is never a silent hold — and
  // `sheddable` is what says the book was not one we would cross.
  const inputs = inputsOf(oneSided(), { dte: 20, pricing: 'live' })
  const d = dialsOf({ balance_enabled: true, balance_min_dte: 7 })
  const r = phaseShed(inputs, d, EMPTY_RULE_STATE, corridor(inputs, d))
  // The parity chain carries an ltp and no book at all, so nothing crosses.
  assert.deepEqual(r.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 3 }])
  assert.equal(r.sheddable, false)
  assert.match(r.reason, /quote it, do not cross/)
})

test('THE VEDL REBUILD, END TO END: the floor holds without the tier and sells with it', () => {
  // 3 lots of a 290 PE at γ 0.0002/share over 300 shares → netΓ −0.06, so
  // allowed = 0.06 × 0.02 × 300 = 0.36, far under the 100 lot. Python answered
  // "no convexity" for 879 of VEDL Dec-25's remaining 911 marks in exactly this
  // shape (`playbooks.py:3567-3577`).
  const inputs = inputsOf(oneSided(), { dte: 20 })
  const held = phaseShed(inputs, dialsOf(), EMPTY_RULE_STATE, corridor(inputs, dialsOf()))
  assert.deepEqual(held.actions, [])
  assert.match(held.reason, /no convexity to centre/)

  const d = dialsOf({ balance_enabled: true, balance_min_dte: 7 })
  const rebuilt = phaseShed(inputs, d, EMPTY_RULE_STATE, corridor(inputs, d))
  assert.deepEqual(rebuilt.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 3 }])
  assert.match(rebuilt.reason, /balance/)
})

// ════════════════════════════════════════════════════════════════════════════
// COMPOSITION — the tiers meeting inside phaseShed
// ════════════════════════════════════════════════════════════════════════════

test('the unwind sizes the sale: the residual is what the candidate scan is fed', () => {
  // Book: short 290 PE (δ 0.55, γ 0.0231) + short 310 CE (δ 0.025, γ 0.0231),
  // 10 lots of 100 each → netΔ +525, netΓ −46.2, allowed 277.2, excess 247.8.
  // The stack side is PE. One PE lot is 0.55 × 100 = 55 shares of delta, and
  // gFloor = 100/(0.02×300) = 16.667 so gLeft = 46.2 − 16.667 = 29.53 against
  // 2.31 a lot = 12 lots of headroom. round(247.8/55) = 5 lots ≤ 10, so it is a
  // PARTIAL: resize to 5, shed 275. remaining = max(0, 247.8 − 275) = 0, and
  // round(0/30) = 0 lots — the buy-back covered it and no CE is sold.
  const book = [
    leg({ instrument: 'PE290', optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231 }),
    leg({ instrument: 'CE310', optType: 'CE', strike: 310, delta: 0.025, gamma: 0.0231 }),
  ]
  const d = dialsOf({ unwind_enabled: true })
  const inputs = inputsOf(book)
  const r = phaseShed(inputs, d, EMPTY_RULE_STATE, corridor(inputs, d))
  assert.deepEqual(r.actions, [{ op: 'resize', instrument: 'PE290', targetLots: 5 }])
  assert.match(r.reason, /buy-back covered it/)

  // Without the tier the same mark sells the other side instead: round(247.8/30) = 8.
  const plain = phaseShed(inputs, dialsOf(), EMPTY_RULE_STATE, corridor(inputs, dialsOf()))
  assert.deepEqual(plain.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 8, add: true }])
})

test('a wider trend budget takes the whole leg AND still sells the residual', () => {
  // Same book, trend_skew 0.5: target = −1 × 0.5 × 277.2 = −138.6 and the budget
  // is |525 − (−138.6)| = 663.6. round(663.6/55) = 12 lots ≥ the leg's 10, so
  // the whole PE closes for 550, and remaining = 113.6 → round(113.6/30) = 4
  // lots of the 320 CE.
  const book = [
    leg({ instrument: 'PE290', optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231 }),
    leg({ instrument: 'CE310', optType: 'CE', strike: 310, delta: 0.025, gamma: 0.0231 }),
  ]
  const d = dialsOf({ unwind_enabled: true, trend_enabled: true, trend_skew: 0.5 })
  const inputs = inputsOf(book)
  const r = phaseShed(inputs, d, EMPTY_RULE_STATE, corridor(inputs, d))
  assert.deepEqual(r.actions, [
    { op: 'close', instrument: 'PE290' },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 4, add: true },
  ])
  assert.match(r.reason, /trend-skew 50%/)
})

test('phaseShed carries the deposit in stateAfter and the spend in creditCommit', () => {
  const book = [
    leg({ instrument: 'PE290', optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231, mtm: -10_000 }),
    leg({ instrument: 'CE310', optType: 'CE', strike: 310, delta: 0.025, gamma: 0.0231 }),
  ]
  // The crossfill arm, because it is the one with room here: the unwind takes 5
  // of the PE's 10 lots (shed 275) so the realized loss is 5/10 × ₹10,000 =
  // ₹5,000 and the credit is half of that, ₹2,500. netΔ +525 landed at −250, so
  // the far edge leaves 277.2 + 250 = 527 shares of room; the 320 CE is quoted
  // 6, so ⌊2,500 / 600⌋ = 4 lots, and 4 × 0.30 × 100 = 120 shares fits easily.
  const d = dialsOf({
    unwind_enabled: true,
    recycle_frac: 0.5,
    recycle_bank: true,
    recycle_opposite: true,
  })
  const inputs = inputsOf(book)
  const r = phaseShed(inputs, d, EMPTY_RULE_STATE, corridor(inputs, d))
  assert.deepEqual(r.actions, [
    { op: 'resize', instrument: 'PE290', targetLots: 5 },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 4 },
  ])
  assert.equal(r.stateAfter.rcCredit, 2_500, 'the DEPOSIT is state')
  assert.deepEqual(
    r.creditCommit,
    { base: 2_500, value: 100, lots: 4, optType: 'CE', strike: 320 },
    'the DEBIT is deferred — the sale has not happened yet',
  )
})

test('THE RECYCLE ANSWERS TO THE SAME CANDIDACY ROW AS THE SHED, on its own strike', () => {
  // The recycle lands somewhere the shed's candidate scan never looked — the
  // closed-side arm one strike INSIDE the ladder it walked, the crossfill arm
  // strictly further OTM than the strike that was gated, which is the thinner
  // book and not the better one. So a package whose shed candidates all pass
  // can still be about to cross a book we refused.
  //
  // trend_skew 0.5 widens the budget to |525 − (−138.6)| = 663.6, which takes
  // the WHOLE 10-lot PE (55 a lot, and the gamma floor allows 12) for a shed of
  // 550 and leaves 113.6 for the 320 CE. The closed-side recycle then re-sells
  // beyond the 290 just bought back, i.e. the 280 PE — and that is the only
  // wing quoted one-sided here.
  const d = dialsOf({ unwind_enabled: true, trend_enabled: true, trend_skew: 0.5, recycle_frac: 1 })

  const control = inputsOf(recycleBook(), { pricing: 'live', chain: liveChain() })
  const ok = phaseShed(control, d, EMPTY_RULE_STATE, corridor(control, d))
  const okOpens = ok.actions.filter((a) => a.op === 'open')
  assert.equal(okOpens.length, 2, 'the residual 320 CE sale and the 280 PE recycle')
  assert.equal(okOpens.at(-1)?.op === 'open' ? okOpens.at(-1)?.strike : 0, 280)
  assert.equal(ok.sheddable, true, 'every book here is one we would cross')

  // Same book, same package — with the 280 PE's depth gone.
  const inputs = inputsOf(recycleBook(), { pricing: 'live', chain: liveChain(['280PE']) })
  const r = phaseShed(inputs, d, EMPTY_RULE_STATE, corridor(inputs, d))

  // NOT DROPPED: the recycle still sized and still stands, so the supervisor
  // has a strike and a size to maker-quote (spec §6/§8 — gate failure never
  // becomes a silent hold). `sellPrice` has no bid to read and falls back to the
  // valuation price, which is what lets the package form at all.
  const opens = r.actions.filter((a) => a.op === 'open')
  assert.deepEqual(
    opens.map((a) => (a.op === 'open' ? `${a.lots}x ${a.strike}${a.optType}` : '')),
    okOpens.map((a) => (a.op === 'open' ? `${a.lots}x ${a.strike}${a.optType}` : '')),
    'the same package, sized the same way',
  )
  // NOT CROSSED, and SURFACED by name.
  assert.equal(r.sheddable, false)
  assert.match(r.reason, /the recycle's 280PE one-sided book/)
  assert.match(r.reason, /quote it, do not cross/)

  // And the shed's own candidates are NOT what failed — the reason must not
  // blame them, or an operator fixes the wrong book.
  assert.doesNotMatch(r.reason, /no candidate has a book we would cross/)
})

test('a gated recycle on a mark with NO residual sale still surfaces rather than vanishing', () => {
  // The commonest recycling mark: the buy-back covers the whole budget, so
  // there is no shed sale to carry the gate — the recycle IS the only fresh
  // sell in the package, and before this it reported sheddable: true whatever
  // book it was about to cross.
  const d = dialsOf({ unwind_enabled: true, recycle_frac: 1 })
  const inputs = inputsOf(recycleBook(), { pricing: 'live', chain: liveChain(['280PE']) })
  const r = phaseShed(inputs, d, EMPTY_RULE_STATE, corridor(inputs, d))

  assert.match(r.reason, /buy-back covered it/)
  const opens = r.actions.filter((a) => a.op === 'open')
  assert.equal(opens.length, 1, 'the recycle alone')
  assert.equal(opens[0]?.op === 'open' ? opens[0].strike : 0, 280)
  assert.equal(r.sheddable, false)
  assert.match(r.reason, /the recycle's 280PE one-sided book/)
})

test('THE SWEEP OUTRANKS A BAND-FLOOR CLAMP — the one combination Python never shipped', () => {
  // `min_band_lots` is a floor UNDER the tolerance and `eod_flat_min` sets the
  // tolerance to 0, so the two contradict each other and no Python preset ever
  // carried both (`shed.ts`'s header records the ruling; this pins it).
  //
  // Book netΔ +525, netΓ −46.2, measured band 277.2. A 5-lot clamp raises it to
  // max(277.2, 5 × 100) = 500, so an ordinary mark carries an excess of 25 and
  // sells round(25 / 30) = 1 lot of the 320 CE. A clamp that survived the sweep
  // would leave 500 shares of delta on the book overnight — the one thing the
  // sweep exists to prevent — so the sweep wins: allowed 0, excess 525,
  // round(525 / 30) = 18 lots, the whole book.
  const book = [
    leg({ optType: 'PE', strike: 290, delta: 0.55, gamma: 0.0231 }),
    leg({ optType: 'CE', strike: 310, delta: 0.025, gamma: 0.0231 }),
  ]
  const d = dialsOf({ eod_flat_min: EOD_MIN, min_band_lots: 5 })

  const ordinary = inputsOf(book, { minuteOfDay: 910 })
  const clamped = phaseShed(ordinary, d, EMPTY_RULE_STATE, corridor(ordinary, d))
  assert.deepEqual(clamped.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 1, add: true }])

  const swept = inputsOf(book, { minuteOfDay: EOD_MIN })
  const sweep = phaseShed(swept, d, EMPTY_RULE_STATE, corridor(swept, d))
  assert.deepEqual(sweep.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 18, add: true }])
  assert.match(sweep.reason, /15:15 sweep/)
  assert.equal(sweep.stateAfter.rcEodDay, DATE, 'and it still consumes the session')
})

test('every hold still returns a RuleState — three of its four fields move on marks that do nothing', () => {
  const inputs = inputsOf([])
  const flat = phaseShed(inputs, dialsOf(), EMPTY_RULE_STATE, corridor(inputs, dialsOf()))
  assert.deepEqual(flat.stateAfter, EMPTY_RULE_STATE, 'a flat book is held BEFORE any tier writes')
  assert.equal(flat.creditCommit, null)
})

// ── PORTED FROM PYTHON — `test_sim_recenter_eod.py`, `_eod3.py`, ────────────
//    `_reshift.py` and `_unwind.py`.
//
// The Python fixtures declare a `marked_book["net"]`; `corridor()` sums the
// legs. So each net below is BUILT — one short leg of 100 lots × 100 shares
// whose per-share δ and Γ land the book on the recorded figures. The chain is
// this file's own (step 10, deltas decaying 0.10 a step from 0.50 ATM), on which
// ATM±2 is 320 CE / 280 PE and both carry |δ| 0.30 — the same 0.30 a lot the
// Python fixture's 310/290 carry, so every recorded lot count ports unchanged.

/** A book whose net delta and net gamma are exactly `nd` / `ng`. A short CE
 * contributes `−δ·S` of delta, a short PE `+δ·S`; gamma takes the position sign
 * alone. */
function netBook(nd: number, ng: number, shares = 10_000): LegView[] {
  const optType: OptType = nd <= 0 ? 'CE' : 'PE'
  return [
    leg({
      instrument: 'NET',
      optType,
      strike: optType === 'CE' ? 310 : 290,
      side: 'Sell',
      lots: shares / LOT,
      lotSize: LOT,
      delta: Math.abs(nd) / shares,
      gamma: -ng / shares,
    }),
  ]
}

/** `DEFAULTS["recenter"]`'s shape — whole-book greeks, fixed ATM±2, no scan. */
const pyDials = (over: Partial<Dials> = {}): Dials =>
  dialsOf({ delta_shorts_only: false, gamma_shorts_only: false, ...over })

function pyRun(
  legs: LegView[],
  dials: Dials,
  state: RuleState = EMPTY_RULE_STATE,
  over: Partial<EngineInputs> = {},
) {
  const inputs = inputsOf(legs, over)
  return phaseShed(inputs, dials, state, corridor(inputs, dials))
}

const EOD = pyDials({ eod_flat_min: EOD_MIN })
const PLAIN = pyDials({ eod_flat_min: 0 })

test('PORTED: the 15:15 sweep fires from INSIDE the tolerance, where plain recenter holds', () => {
  // `test_sweeps_at_1515_from_inside_the_tolerance`: allowed = 1,000 × 0.02 ×
  // 300 = 6,000, so netΔ −5,000 is inside it. At the bell the tolerance is 0.
  const book = netBook(-5000, -1000)
  const held = pyRun(book, PLAIN, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN })
  assert.deepEqual(held.actions, [])
  assert.match(held.reason, /inside allowed 6,000/)

  const swept = pyRun(book, EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN })
  assert.match(swept.reason, /sweep at tolerance 0 \(whole book\)/)
  // The WHOLE netΔ, not the excess: round(5,000 / (0.30 × 100)) = 167.
  assert.deepEqual(swept.actions, [
    { op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 167, add: true },
  ])
})

test('PORTED: it does not arm before 15:15, and a THRESHOLD is not an equality', () => {
  // `test_does_not_arm_before_1515` + `test_arms_on_a_later_tail_mark_when_1515_was_missed`
  // — "a session whose 15:15 mark is absent from the lake still gets its sweep
  // at 15:20".
  const book = netBook(-5000, -1000)
  const early = pyRun(book, EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN - 5 })
  assert.deepEqual(early.actions, [])
  assert.match(early.reason, /inside allowed/)

  const late = pyRun(book, EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN + 5 })
  assert.match(late.reason, /sweep at tolerance 0/)
  assert.equal(late.actions.length, 1)
})

test('PORTED: ONE sweep per session, and the day is consumed in state', () => {
  // `test_only_one_sweep_per_session` + `test_the_day_is_consumed_in_state`.
  const book = netBook(-5000, -1000)
  const first = pyRun(book, EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN })
  assert.equal(first.actions.length, 1)
  assert.equal(first.stateAfter.rcEodDay, DATE)

  const later = pyRun(book, EOD, first.stateAfter, { minuteOfDay: EOD_MIN + 5 })
  assert.deepEqual(later.actions, [], 'back to plain recenter: inside the 2% band')
  assert.match(later.reason, /inside allowed/)
})

test('PORTED: a NEW session re-arms the sweep', () => {
  // `test_a_new_session_rearms_the_sweep`.
  const book = netBook(-5000, -1000)
  const day1 = pyRun(book, EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN, dateIst: DATE })
  const day2 = pyRun(book, EOD, day1.stateAfter, { minuteOfDay: EOD_MIN, dateIst: NEXT_DAY })
  assert.match(day2.reason, /sweep at tolerance 0/)
  assert.equal(day2.stateAfter.rcEodDay, NEXT_DAY)
})

test('PORTED: a GAMMA-COLLAPSED book still sweeps — that is the book the sweep is for', () => {
  // `test_a_gamma_collapsed_book_still_sweeps`: allowed = 10 × 0.02 × 300 = 60,
  // under the 100 lot. Plain recenter says "no convexity to centre"; the sweep
  // runs anyway, "because that is precisely the book whose overnight gap risk is
  // worst".
  const book = netBook(-8000, -10)
  const held = pyRun(book, PLAIN, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN })
  assert.deepEqual(held.actions, [])
  assert.match(held.reason, /no convexity to centre/)

  const swept = pyRun(book, EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN })
  const [open] = swept.actions
  assert.ok(open !== undefined && open.op === 'open')
  assert.equal(open.optType, 'PE')
})

test('PORTED: the sweep is OUTCOME-BLIND — a sub-lot delta still consumes the day', () => {
  // `test_sub_one_lot_delta_emits_nothing_and_still_consumes_the_day`: netΔ 10
  // shares against 30 a lot → round(0.33) = 0 lots, and the session is spent.
  const out = pyRun(netBook(-10, -1000), EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN })
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /under one lot/)
  assert.equal(out.stateAfter.rcEodDay, DATE)
})

test('PORTED: no sweep at or under min_sell_dte — the gamma guard is bypassed, this one is not', () => {
  // `test_no_sweep_at_or_under_min_sell_dte`.
  const out = pyRun(netBook(-9000, -1000), EOD, EMPTY_RULE_STATE, {
    minuteOfDay: EOD_MIN,
    dte: 1,
  })
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /no fresh sells/)
})

test('PORTED: a flat book sweeps NOTHING', () => {
  // `test_a_flat_book_sweeps_nothing`.
  const out = pyRun([], EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN })
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /flat book/)
})

test('PORTED: the sweep sheds the WHOLE delta, not just the excess — 300 lots against 100', () => {
  // `test_sheds_the_whole_delta_not_just_the_excess`: allowed 6,000 against netΔ
  // −9,000. recenter sells the 3,000 excess (100 lots); the sweep sells all
  // 9,000 (300 lots). The 0.30-a-share strike and the 100 lot are both Python's.
  const book = netBook(-9000, -1000)
  const [plainOpen] = pyRun(book, PLAIN, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN }).actions
  const [sweptOpen] = pyRun(book, EOD, EMPTY_RULE_STATE, { minuteOfDay: EOD_MIN }).actions
  assert.ok(plainOpen !== undefined && plainOpen.op === 'open')
  assert.ok(sweptOpen !== undefined && sweptOpen.op === 'open')
  assert.equal(plainOpen.lots, 100)
  assert.equal(sweptOpen.lots, 300)
})

test('PORTED: eod3’s wider 3% band holds a drift the 2% parent sheds — and the SWEEP ignores both', () => {
  // `test_sim_recenter_eod3.py:test_a_drift_the_parent_sheds_is_held_inside_the_3pct_band`
  // and `test_the_1515_sweep_ignores_the_wider_tolerance`: allowed = 1,000 × tol
  // × 300, so 6,000 at 2% and 9,000 at 3%; netΔ −7,500 sits between them.
  const book = netBook(-7500, -1000)
  const noon = { minuteOfDay: 720 }
  assert.equal(pyRun(book, PLAIN, EMPTY_RULE_STATE, noon).actions.length, 1, '2%: sheds')
  assert.deepEqual(
    pyRun(book, pyDials({ delta_tol_pct: 0.03 }), EMPTY_RULE_STATE, noon).actions,
    [],
    '3%: holds',
  )
  // …and at the bell the tolerance is 0 whatever the dial said, so the whole
  // 7,500 goes: round(7,500 / 30) = 250.
  const swept = pyRun(book, pyDials({ delta_tol_pct: 0.03, eod_flat_min: EOD_MIN }), EMPTY_RULE_STATE, {
    minuteOfDay: EOD_MIN,
  })
  assert.deepEqual(swept.actions, [
    { op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 250, add: true },
  ])
})

test('PORTED: the trend skew NEVER MANUFACTURES a firing mark', () => {
  // `test_sim_recenter_reshift.py:test_the_skew_never_manufactures_a_firing_mark`
  // — "netΔ 5,000 inside allowance 6,000 holds, dial or no dial: the skew moves
  // the TARGET, never the trigger."
  const book = netBook(-5000, -1000)
  assert.deepEqual(pyRun(book, PLAIN).actions, [])
  assert.deepEqual(pyRun(book, pyDials({ trend_enabled: true, trend_skew: 0.5 })).actions, [])
})

test('PORTED: skew 0 is a LEGAL skew meaning shed to flat, not the dial switched off', () => {
  // `test_zero_is_a_legal_skew_meaning_shed_to_flat`: target 0 → shed the whole
  // 20,000 → round(20,000 / 30) = 667 lots. Off-by-absence is a different thing
  // from a zero, which is the trap `dials.ts` exists to close.
  const book = netBook(-20_000, -1000)
  const swept = pyRun(book, pyDials({ trend_enabled: true, trend_skew: 0 }))
  assert.deepEqual(swept.actions, [
    { op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 667, add: true },
  ])
  // With the tier OFF the target is the band edge: (20,000 − 6,000) / 30 = 467.
  const [edge] = pyRun(book, PLAIN).actions
  assert.ok(edge !== undefined && edge.op === 'open')
  assert.equal(edge.lots, 467)
})

test('PORTED: the balance tier respects the dte floor, and is off by absence', () => {
  // `test_sim_recenter_unwind.py:test_the_balance_tier_respects_the_dte_floor`
  // and `test_the_balance_tier_is_off_without_the_dial`. A one-sided book with
  // no convexity is rebuilt — but not inside `balance_min_dte`, and not at all
  // until someone turns the tier on.
  const oneSided = netBook(-1200, 0)
  const noDial = pyRun(oneSided, pyDials({ balance_enabled: false }))
  assert.deepEqual(noDial.actions, [])
  assert.match(noDial.reason, /no convexity to centre/)

  const tooNear = pyRun(oneSided, pyDials({ balance_enabled: true, balance_min_dte: 7 }), EMPTY_RULE_STATE, {
    dte: 7,
  })
  assert.deepEqual(tooNear.actions, [], 'the comparison is STRICT: dte 7 is not > 7')

  const rebuilt = pyRun(oneSided, pyDials({ balance_enabled: true, balance_min_dte: 7 }))
  assert.equal(rebuilt.actions.length, 1)
  assert.match(rebuilt.reason, /^balance: /)
})

// ── the review's IMP-3: ONE definition of "lots the rules may spend" ────────

test('the unwind stack is netted by the SHARED helper and carries its count', () => {
  // `tiers.ts` used to keep a private `spendableLots` byte-equivalent to
  // `shift.ts`'s, which is how four copies of one rule come to disagree the
  // first time one of them is corrected. `unwindStack` now returns
  // `guards.ts`'s `SteerableLeg` rows and `lifoUnwind` reads the count off them
  // instead of recomputing it (`guards.ts` §1).
  const mine = leg({ instrument: 'PE290', strike: 290, lots: 10 })
  const part = leg({ instrument: 'PE280', strike: 280, lots: 10 })
  const stack = unwindStack(
    inputsOf([mine, part], { protectedQty: { PE280: 4 } }),
    stateOf({
      rcStack: [
        { strike: 290, optType: 'PE', lots: 10 },
        { strike: 280, optType: 'PE', lots: 10 },
      ],
    }),
    'PE',
  )
  assert.deepEqual(
    stack.map((l) => [l.instrument, l.lots, l.steerableLots]),
    [
      ['PE280', 10, 6],
      ['PE290', 10, 10],
    ],
    'newest first, and the operator’s four lots netted off the row itself',
  )
})
