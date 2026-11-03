/**
 * PHASE R, PINNED TO ARITHMETIC A HUMAN CAN CHECK.
 *
 * The chain under test is a 21-strike ladder (200…400 by 10) around spot 300,
 * quoted at the Black-76 price at vol 0.30 with seven days to run, so every
 * strike solves back to that vol and its delta is the model's. The three CE
 * strikes the scan reaches are hand-derived once and reused everywhere:
 *
 *   310 CE  d1 = (ln(300/310) + ½·0.09·t)/(0.3·√t) = -0.76842
 *           δ  = e^{-rt}·N(d1) = 0.99875 × 0.221102 = 0.220826  → 5.5213 / lot
 *   320 CE  d1 = -1.53268, δ = 0.99875 × 0.062679 = 0.062601    → 1.5655 / lot
 *   330 CE  d1 = -2.27338, δ = 0.99875 × 0.011503 = 0.011489    → 0.28727 / lot
 *
 * Four things would otherwise pass silently, and each has its own block:
 *
 *   1. SIZING IS A PLAIN ROUND. `playbooks.py:3710-3715` is explicit that it is
 *      NOT `max(1, …)`: the rule is consulted at every mark, so rounding up
 *      fires on essentially every mark past the tolerance. A sub-one-lot excess
 *      must emit NOTHING and accumulate.
 *   2. BEST FIT, NOT NEAREST. The winner is the candidate whose whole-lot shed
 *      lands closest to the excess — routinely the FURTHEST strike, because a
 *      further-OTM lot is finer. Ties break toward the nearer strike, where the
 *      premium and the liquidity are.
 *   3. THE LIQUIDITY GATE IS `'live'`-ONLY. A wide or stale book must change the
 *      pick in live pricing and change NOTHING in parity, or every Python
 *      fixture re-prices.
 *   4. `sheddable` IS NOT "did anything happen". It is false only when the
 *      excess is real and the CHAIN could not carry the sale. Every hold decided
 *      on the book's own numbers — including the sub-one-lot one — stays true,
 *      because the supervisor maker-quotes on false.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  RISK_FREE,
  bestFit,
  corridor,
  phaseShed,
  shedCandidates,
  type ChainSnap,
  type Dials,
  type EngineInputs,
  type LegView,
  type OptType,
  type Quote,
} from '@algomaker/desk-engine'
import { b76Price } from '@algomaker/greeks'

const DATE = '2026-08-21'
const EXPIRY = '2026-08-28'
const MINUTE = 600 // 10:00 IST — seven whole days out, no intraday refinement
const T7 = 7 / 365
const VOL = 0.3
const NOW = 1_755_000_000_000

const q = (bid: number, ask: number, asOf = NOW): Quote => ({ bid, ask, ltp: null, asOf })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`. `width`
 * is the half-spread as a fraction of that mid, so the spread the sell gate
 * measures is `2 × width` and the greeks are unmoved by widening it. */
function bookAt(spot: number, strike: number, type: OptType, width = 0.02, asOf = NOW): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * (1 - width), px * (1 + width), asOf)
}

const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * 10)

interface RowOver {
  readonly ce?: Quote | null
  readonly pe?: Quote | null
}

/** The 21-strike ladder, with named rows replaced — `{ ce: null }` for a wing
 * with no book at all, a re-built `bookAt` for a wide or stale one. */
function chainOf(
  spot: number,
  over: ReadonlyMap<number, RowOver> = new Map(),
  strikes: number[] = LADDER,
  step = 10,
  lotSize = 25,
): ChainSnap {
  return {
    symbol: 'BHEL',
    expiry: EXPIRY,
    step,
    lotSize,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: strikes.map((k) => {
      const row = over.get(k)
      return {
        strike: k,
        ce: row !== undefined && 'ce' in row ? (row.ce ?? null) : bookAt(spot, k, 'CE'),
        pe: row !== undefined && 'pe' in row ? (row.pe ?? null) : bookAt(spot, k, 'PE'),
      }
    }),
    asOf: NOW,
  }
}

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
    nowMs: NOW,
    dateIst: DATE,
    minuteOfDay: MINUTE,
    dte: 7,
    chain,
    legs,
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'model', asOf: NOW, fresh: false },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
    ...over,
  }
}

const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })

/**
 * THE BOOK EVERY PHASE TEST SHEDS.
 *
 * One short PE, 4 lots of 25 = 100 shares, per-share δ 0.9 and Γ 0.1:
 *   netΔ = (-1)(-1) × 0.9 × 100 = +90   (positive ⇒ the shed sells CALLS)
 *   netΓ = (-1) × 0.1 × 100     = -10
 *   allowed = 10 × 0.02 × 300   =  60
 *   excess  = 90 - 60           =  30 delta-shares
 * Against the three CE candidates that is 5 lots of 310 (miss 2.394), 19 lots
 * of 320 (miss 0.256) and 104 lots of 330 (miss 0.123) — the furthest wins.
 */
const shedBook = (delta = 0.9): LegView[] => [
  leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 25, delta, gamma: 0.1 }),
]

/** Run phase R against a book, taking the corridor from the same inputs — the
 * composer's job in Task 11, and the only honest way to feed `cor`. */
function shed(inputs: EngineInputs, dials: Dials = dialsOf()) {
  return phaseShed(inputs, dials, EMPTY_RULE_STATE, corridor(inputs, dials))
}

// ── bestFit ─────────────────────────────────────────────────────────────────

test('bestFit minimises the residual, and a TIE goes to the nearer strike', () => {
  // The brief's case, hand-computed. lotSize 25:
  //   0.30 → 7.5/lot, 750/7.5 = 100 exactly       → miss 0
  //   0.18 → 4.5/lot, 750/4.5 = 166.67 → 167 lots → miss 1.5
  //   0.12 → 3.0/lot, 750/3.0 = 250 exactly       → miss 0
  // Two candidates miss by nothing; `cands` is nearest-first and the compare is
  // strict, so the FIRST of the pair wins — the nearer strike, where the
  // premium and the liquidity are (playbooks.py:4127-4141).
  const cands = [
    { strike: 310, dps: 0.3 },
    { strike: 320, dps: 0.18 },
    { strike: 330, dps: 0.12 },
  ]
  assert.deepEqual(bestFit(cands, 750, 25), { strike: 310, lots: 100 })
})

test('bestFit lets the FURTHEST strike win when it is the finer fit', () => {
  // excess 790: 105 lots of 0.30 → 787.5 (miss 2.5); 176 of 0.18 → 792
  // (miss 2.0); 263 of 0.12 → 789 (miss 1.0). The outward scan exists for
  // exactly this — a further-OTM lot is FINER granularity, not coarser.
  const cands = [
    { strike: 310, dps: 0.3 },
    { strike: 320, dps: 0.18 },
    { strike: 330, dps: 0.12 },
  ]
  assert.deepEqual(bestFit(cands, 790, 25), { strike: 330, lots: 263 })
})

test('a sub-one-lot excess sizes to NOTHING — never a forced 1 lot', () => {
  // playbooks.py:3710-3715: "Plain round, NOT max(1, ...): the rule is
  // consulted at every mark, so rounding up would fire on essentially every
  // mark past the tolerance." 3 delta-shares against a 7.5-share lot is 0.4
  // lots, which rounds to zero and emits nothing.
  assert.equal(bestFit([{ strike: 310, dps: 0.3 }], 3, 25), null)
  // …and it stays null when EVERY candidate is sub-lot: the finest is 3.0 a
  // lot, so anything under 1.5 rounds to zero everywhere.
  const cands = [
    { strike: 310, dps: 0.3 },
    { strike: 320, dps: 0.18 },
    { strike: 330, dps: 0.12 },
  ]
  assert.equal(bestFit(cands, 1.4, 25), null)
})

test('bestFit refuses the inputs it cannot size off', () => {
  const cands = [{ strike: 310, dps: 0.3 }]
  assert.equal(bestFit(cands, -50, 25), null, 'a book inside its band sheds nothing')
  assert.equal(bestFit(cands, 750, 0), null, 'a zero lot would size an infinite package')
  assert.equal(bestFit([{ strike: 310, dps: 0 }], 750, 25), null, 'a zero-delta strike sheds nothing')
  assert.equal(bestFit([], 750, 25), null)
})

// ── shedCandidates ──────────────────────────────────────────────────────────

test('shedCandidates walks OUTWARD from ATM, nearest first, with the real greeks', () => {
  const c = shedCandidates(chainOf(300), 'CE', 300, 3, DATE, MINUTE)
  assert.deepEqual(
    c.map((x) => x.strike),
    [310, 320, 330],
  )
  // Hand-derived above; the chain greeks come back through an IV SOLVE off the
  // mid, so the comparison is relative.
  const want = [0.220826, 0.062601, 0.011489]
  c.forEach((x, i) => {
    assert.ok(Math.abs(x.dps / want[i]! - 1) < 1e-4, `${x.strike} dps ${x.dps}`)
  })
})

test('shedCandidates walks the PUT ladder DOWN when asked for the put side', () => {
  const c = shedCandidates(chainOf(300), 'PE', 300, 3, DATE, MINUTE)
  assert.deepEqual(
    c.map((x) => x.strike),
    [290, 280, 270],
  )
})

test('a strike whose IV does not solve is EXCLUDED, never defaulted to 0.30', () => {
  // 320 CE has no book at all: Python substituted `0.30` and sized a real
  // package off it (playbooks.py:4109). Here it is simply not a candidate.
  const chain = chainOf(300, new Map([[320, { ce: null }]]))
  const c = shedCandidates(chain, 'CE', 300, 3, DATE, MINUTE)
  assert.deepEqual(
    c.map((x) => x.strike),
    [310, 330],
  )
  assert.ok(c.every((x) => x.dps !== 0.3))
})

test('shedCandidates DEDUPLICATES a coarse grid and is empty when the scan is off', () => {
  // 280/300/320 by 20 with spot on 300: strikes_out 0 and 1 both push to 320,
  // and 2 reaches 340 — which the chain does not carry, so it snaps back to
  // 320 as well. One candidate, not three.
  const coarse = chainOf(300, new Map(), [280, 300, 320], 20)
  assert.deepEqual(
    shedCandidates(coarse, 'CE', 300, 3, DATE, MINUTE).map((x) => x.strike),
    [320],
  )
  assert.deepEqual(shedCandidates(chainOf(300), 'CE', 300, 0, DATE, MINUTE), [])
})

// ── phaseShed: the sale it forms ────────────────────────────────────────────

test('phase R sells the best-fit lot count at the best-fit strike', () => {
  const r = shed(inputsOf(chainOf(300), shedBook()))
  assert.equal(r.sheddable, true)
  assert.deepEqual(r.actions, [{ op: 'open', strike: 330, optType: 'CE', side: 'Sell', lots: 104, add: true }])
  // 104 × 0.28727 = 29.88 against an excess of 30 — the finest of the three.
  assert.match(r.reason, /sell 104 330CE/)
})

test('a book leaning the OTHER way sells the put ladder', () => {
  // netΔ -90: a short CE book sheds by selling PUTS (playbooks.py:4102).
  // 227 lots of 270 PE (0.0052755/share, 0.13189/lot) → 29.94 against 30.
  const legs = [leg({ side: 'Sell', optType: 'CE', lots: 4, lotSize: 25, delta: 0.9, gamma: 0.1 })]
  const r = shed(inputsOf(chainOf(300), legs))
  assert.deepEqual(r.actions, [{ op: 'open', strike: 270, optType: 'PE', side: 'Sell', lots: 227, add: true }])
})

test('with the scan OFF the sale is the single fixed strikes_out strike', () => {
  // No scan: `strikes_out` 2 lands on 320 CE and nothing else is considered,
  // so the pick is 19 lots rather than the scan's 104 of 330.
  const r = shed(inputsOf(chainOf(300), shedBook()), dialsOf({ shed_scan_strikes: 0 }))
  assert.deepEqual(r.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 19, add: true }])
})

test('a sub-one-lot excess HOLDS, and says so without claiming a sale', () => {
  // δ 0.601 → netΔ 60.1, allowed 60, excess 0.1 — under HALF of the finest lot
  // (0.28727), so every candidate rounds to zero and nothing is sold.
  const r = shed(inputsOf(chainOf(300), shedBook(0.601)))
  assert.deepEqual(r.actions, [])
  assert.match(r.reason, /under one lot/)
  assert.equal(r.sheddable, true, 'the chain is fine; the rule is deliberately accumulating')

  // With the scan off there is exactly one strike, and the reason NAMES it —
  // playbooks.py:4143-4145. A hold that says only "2 steps out" is the least
  // actionable line in the journal.
  const off = shed(inputsOf(chainOf(300), shedBook(0.601)), dialsOf({ shed_scan_strikes: 0 }))
  assert.match(off.reason, /excess 0\.1 shares under one lot at 320CE/)
  // …and NOT Python's `{:,.0f}`, which renders the whole subject of this line
  // as "excess 0 shares" — the one value it cannot be.
  assert.doesNotMatch(off.reason, /excess 0 shares/)
})

// ── phaseShed: the liquidity gate, `'live'` only ────────────────────────────

/** The same ladder with named CE rows re-quoted wide (spread 100 % of mid). */
const wideCe = (spot: number, strikes: number[]): ChainSnap =>
  chainOf(spot, new Map(strikes.map((k) => [k, { ce: bookAt(spot, k, 'CE', 0.5) }])))

test('a WIDE strike is no candidate in live pricing — and still is in parity', () => {
  const chain = wideCe(300, [330])
  const live = shed(inputsOf(chain, shedBook(), { pricing: 'live' }))
  assert.deepEqual(live.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 19, add: true }])
  assert.equal(live.sheddable, true, 'two candidates still have a book we would cross')

  // Parity replays Python, which had no gate at all: the pick is unchanged.
  const parity = shed(inputsOf(chain, shedBook(), { pricing: 'parity' }))
  assert.deepEqual(parity.actions, [{ op: 'open', strike: 330, optType: 'CE', side: 'Sell', lots: 104, add: true }])
})

test('a STALE strike is no candidate in live pricing', () => {
  // quote_max_age_ms 120,000: a book last seen 200 s ago is not one we would
  // cross, however good the price looks.
  const chain = chainOf(300, new Map([[330, { ce: bookAt(300, 330, 'CE', 0.02, NOW - 200_000) }]]))
  const r = shed(inputsOf(chain, shedBook()))
  assert.deepEqual(r.actions, [{ op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 19, add: true }])
})

test('EVERY candidate gated out keeps the intended sell and flags it NOT sheddable', () => {
  // The maker-quote handoff (spec §6, §8; Task 15): gate failure routes the
  // sale to a passive quote at theoretical, never to a silent hold. The action
  // is still the best fit over the whole candidate set — the supervisor needs
  // a strike and a size to quote.
  const chain = wideCe(300, [310, 320, 330])
  const r = shed(inputsOf(chain, shedBook()))
  assert.equal(r.sheddable, false)
  assert.deepEqual(r.actions, [{ op: 'open', strike: 330, optType: 'CE', side: 'Sell', lots: 104, add: true }])
  assert.match(r.reason, /spread/)
})

test('a chain that prices NOTHING is not sheddable and forms no sale to quote', () => {
  const bare = chainOf(300, new Map(LADDER.map((k) => [k, { ce: null }])))
  const r = shed(inputsOf(bare, shedBook()))
  assert.equal(r.sheddable, false)
  assert.deepEqual(r.actions, [])
  assert.match(r.reason, /nothing to sell/)
})

test('the gate dials have no silent off-switch — a non-positive dial passes nothing', () => {
  // `sell_max_spread_pct` and `quote_max_age_ms` are NOT in dials.ts's list of
  // numeric off-states. Reading 0 as "gate off" would cross any book at all;
  // reading it as "nothing can pass" routes to the maker quote and is loud.
  const r = shed(inputsOf(chainOf(300), shedBook()), dialsOf({ quote_max_age_ms: 0 }))
  assert.equal(r.sheddable, false)
  assert.match(r.reason, /quote_max_age_ms/)
  // Said ONCE. A dial nothing can satisfy is one fact about the book; repeated
  // per candidate it buries the cause under copies of itself.
  assert.equal(r.reason.match(/quote_max_age_ms/g)?.length, 1)
})

// ── phaseShed: the holds it owes the caller ─────────────────────────────────

test('THE VEDL/TCS CONVEXITY HOLD: an allowance under one lot sheds nothing', () => {
  // The live TCS-2026-08-25-recenter-relief-r book on 2026-08-12
  // (playbooks.py:4030-4046): netΓ -2.0 against a 225 lot gives allowance 92,
  // and the floor held the delta phase silent all session while the book
  // carried netΔ +483. On VEDL Dec-25 the same guard answered "no convexity"
  // for 879 of 911 remaining marks while spot rallied 12 % into four naked
  // calls (:3567-3577).
  const SHARES = 3 * 225
  const tcs = [
    leg({ side: 'Sell', optType: 'PE', lots: 3, lotSize: 225, delta: 483 / SHARES, gamma: 2.0 / SHARES }),
  ]
  // The real book's ladder: spot 2300, 21 strikes by 20, a 225 lot.
  const tcsChain = chainOf(2300, new Map(), Array.from({ length: 21 }, (_, i) => 2100 + i * 20), 20, 225)
  const inputs = inputsOf(tcsChain, tcs)
  const held = shed(inputs, dialsOf({ shed_scan_strikes: 0 }))
  assert.deepEqual(held.actions, [])
  assert.match(held.reason, /no convexity to centre/)
  assert.equal(held.sheddable, true, 'the book, not the chain, is what stopped this')

  // Either band dial removes the floor test — that is what they are for.
  const freed = shed(inputs, dialsOf({ shed_scan_strikes: 0, no_band_floor: true }))
  assert.ok(freed.actions.length > 0, 'no_band_floor frees the phase to shed')
  const clamped = shed(inputs, dialsOf({ shed_scan_strikes: 0, min_band_lots: 2 }))
  assert.doesNotMatch(clamped.reason, /no convexity to centre/)
})

test('a book INSIDE its band holds and names the band it is inside', () => {
  // δ 0.5 → netΔ 50 against allowed 60.
  const r = shed(inputsOf(chainOf(300), shedBook(0.5)))
  assert.deepEqual(r.actions, [])
  assert.match(r.reason, /inside allowed/)
  assert.equal(r.sheddable, true)
})

test('at or under min_sell_dte there are NO fresh sells', () => {
  const r = shed(inputsOf(chainOf(300), shedBook(), { dte: 1 }))
  assert.deepEqual(r.actions, [])
  assert.match(r.reason, /no fresh sells/)
})

test('an unmarked steering book holds rather than steering off a hole', () => {
  // The replacement for Python's `netΓ == 0.0` sentinel (:4063-4073). A leg
  // whose IV did not solve poisons BOTH sums, so the corridor's numbers are
  // not a band — they are an artefact.
  const legs = [...shedBook(), leg({ side: 'Sell', optType: 'CE', delta: 0, gamma: 0, hasGreeks: false })]
  const r = shed(inputsOf(chainOf(300), legs))
  assert.deepEqual(r.actions, [])
  assert.match(r.reason, /greeks/)
  assert.equal(r.sheddable, true)
})

test('a flat book and a zero spot hold on their own terms', () => {
  const flat = shed(inputsOf(chainOf(300), []))
  assert.deepEqual(flat.actions, [])
  assert.match(flat.reason, /flat book/)

  // At spot 0 the band is 0 and the whole netΔ reads as excess — a flatten
  // nobody asked for (playbooks.py:3912-3913). The chain keeps its rows so the
  // guard is what answers, not an empty ladder.
  const noSpot = shed(inputsOf({ ...chainOf(300), spot: 0 }, shedBook()))
  assert.deepEqual(noSpot.actions, [])
  assert.match(noSpot.reason, /no spot/)
})

// ── the fold: corridor's floor and phase R walk the SAME candidates ─────────

test('corridor.floorRef is the finest lot of exactly this candidate set', () => {
  const chain = chainOf(300)
  const inputs = inputsOf(chain, shedBook())
  const cands = shedCandidates(chain, 'CE', 300, 3, DATE, MINUTE)
  const finest = Math.min(...cands.map((c) => c.dps))
  assert.equal(corridor(inputs, dialsOf()).floorRef, finest * 25)
})

// ── PORTED FROM PYTHON — `test_sim_recenter.py` and ─────────────────────────
//    `test_sim_recenter_relief_band.py`, on their own fixture chain.
//
// The Python fixture chain steps 5 either side of spot with per-share deltas
// that decay 0.10 a step and are clamped into [0.02, 0.98]
// (`test_sim_hold_recycle.py:34-46`). Inside three strikes of a 300 spot the PE
// ladder is
//
//   295 → 0.40      290 → 0.30      285 → 0.20      (280 → 0.10, out of reach)
//
// so one lot of 100 carries 40 / 30 / 20 delta-shares respectively. That is the
// whole point of the scan: THE FURTHER STRIKE IS THE FINER INSTRUMENT.
//
// It is replayed in `pricing: 'parity'` through `strikeGreeksOverride`, because
// those deltas are the fixture's own declared numbers and not a Black-76 solve
// of its prices — the same reading `parity-adapter.ts` §1 argues for, and the
// only way `round(excess / (dps × lotSize))` lands on Python's lot count rather
// than a percent away from it.

const PY_LOT = 100
const PY_STEP = 5
const PY_LADDER = Array.from({ length: 21 }, (_, i) => -10 + i)

/** `_chain_rows` (`test_sim_hold_recycle.py:34-46`) as a chain. */
function pyChain(spot: number): ChainSnap {
  return {
    symbol: 'PY',
    expiry: EXPIRY,
    step: PY_STEP,
    lotSize: PY_LOT,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: PY_LADDER.map((i) => ({
      strike: spot + i * PY_STEP,
      ce: q(5.9, 6.1),
      pe: q(5.9, 6.1),
    })),
    asOf: NOW,
  }
}

/** …and its declared per-share deltas, which decay 0.10 a step from 0.50 ATM. */
const pyGreeks = (spot: number) => (strike: number, optType: OptType) => {
  const i = Math.round((strike - spot) / PY_STEP)
  const clamp = (x: number) => Math.max(0.02, Math.min(0.98, x))
  const delta = optType === 'CE' ? clamp(0.5 - i * 0.1) : -clamp(0.5 + i * 0.1)
  return { delta: Math.round(delta * 1000) / 1000, gamma: 0.02 }
}

/** A book on the Python chain whose net delta and net gamma are exactly
 * `nd` / `ng` — see `corridor.test.ts`'s ported block for the construction. */
function pyBook(nd: number, ng: number, shares = 10_000): LegView[] {
  const optType: OptType = nd <= 0 ? 'CE' : 'PE'
  return [
    leg({
      side: 'Sell',
      optType,
      strike: optType === 'CE' ? 310 : 290,
      lots: shares / PY_LOT,
      lotSize: PY_LOT,
      delta: Math.abs(nd) / shares,
      gamma: -ng / shares,
    }),
  ]
}

function pyInputs(spot: number, legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  return inputsOf(pyChain(spot), legs, {
    dte: 20,
    pricing: 'parity',
    strikeGreeksOverride: pyGreeks(spot),
    ...over,
  })
}

/** `DEFAULTS["recenter"]`'s shape: whole-book greeks, the fixed ATM±2 strike,
 * no scan and no floor dial unless a test sets one. */
const pyDials = (over: Partial<Dials> = {}): Dials =>
  dialsOf({
    delta_shorts_only: false,
    gamma_shorts_only: false,
    shift_enabled: false,
    shed_scan_strikes: 0,
    strikes_out: 2,
    min_sell_dte: 1,
    margin_cap: 0,
    ...over,
  })

const pyShed = (
  spot: number,
  legs: LegView[],
  dials = pyDials(),
  over: Partial<EngineInputs> = {},
) => {
  const inputs = pyInputs(spot, legs, over)
  return phaseShed(inputs, dials, EMPTY_RULE_STATE, corridor(inputs, dials))
}

test('PORTED: a flat book holds before anything else is measured', () => {
  // `test_flat_book_holds`.
  const out = pyShed(300, [])
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /flat book/)
})

test('PORTED: netΔ < 0 sells PUTS, netΔ > 0 sells CALLS', () => {
  // `test_sells_puts_when_delta_is_negative` — "netΔ < 0 is short-CE heavy
  // (spot rose): SELLING puts adds +delta" — and its call-side twin.
  const [put] = pyShed(300, pyBook(-8000, -1000)).actions
  assert.ok(put !== undefined && put.op === 'open')
  assert.equal(put.optType, 'PE')
  assert.equal(put.side, 'Sell')

  const [call] = pyShed(300, pyBook(8000, -1000)).actions
  assert.ok(call !== undefined && call.op === 'open')
  assert.equal(call.optType, 'CE')
  assert.equal(call.side, 'Sell')
})

test('PORTED: the strike is two steps out AND strictly OTM', () => {
  // `test_strike_is_two_out_and_strictly_otm`.
  const [put] = pyShed(300, pyBook(-8000, -1000)).actions
  const [call] = pyShed(300, pyBook(8000, -1000)).actions
  assert.ok(put !== undefined && put.op === 'open' && call !== undefined && call.op === 'open')
  assert.equal(put.strike, 290)
  assert.ok(put.strike < 300)
  assert.equal(call.strike, 310)
  assert.ok(call.strike > 300)
})

test('PORTED: the lots size the EXCESS at the sold strike’s own delta — 67', () => {
  // `test_lots_size_the_excess_at_the_sold_strikes_delta`: allowed 6,000, excess
  // 2,000, the 290 PE carries 0.30 per share, lot 100 → round(2000/30) = 67.
  const [open] = pyShed(300, pyBook(-8000, -1000)).actions
  assert.ok(open !== undefined && open.op === 'open')
  assert.equal(open.lots, Math.round(2000 / (0.3 * PY_LOT)))
  assert.equal(open.lots, 67)
})

test('PORTED: it sheds to the EDGE of the band, not to flat', () => {
  // `test_sheds_to_the_edge_not_to_flat` — "the residual is the allowance, not
  // zero, and that is the whole point". Python's own reason strings, verbatim.
  const out = pyShed(300, pyBook(-8000, -1000))
  assert.match(out.reason, /allowed 6,000/)
  assert.match(out.reason, /shed 2,000/)
})

test('PORTED: the user’s worked example — spot 418, allowed 7,064, shed 1,840', () => {
  // `test_the_users_worked_example`: netΔ −8,904 against netΓ −845 →
  // allowed = 845 × 0.02 × 418 = 7,064.2, excess = 1,839.8.
  const out = pyShed(418, pyBook(-8904, -845))
  assert.match(out.reason, /allowed 7,064/)
  assert.match(out.reason, /shed 1,840/)
  const [open] = out.actions
  assert.ok(open !== undefined && open.op === 'open')
  assert.equal(open.optType, 'PE')
})

test('PORTED: a sub-one-lot excess emits NOTHING and accumulates', () => {
  // `test_sub_one_lot_excess_emits_nothing`: excess 10 shares against 30 a lot
  // → round(0.33) = 0. Rounding up here would fire on essentially every mark.
  const out = pyShed(300, pyBook(-6010, -1000))
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /under one lot/)
})

test('PORTED: no fresh sells at or under min_sell_dte', () => {
  // `test_no_fresh_sells_at_or_under_min_sell_dte`. A shed CONTAINS a sale.
  const out = pyShed(300, pyBook(-9000, -1000), pyDials(), { dte: 1 })
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /dte 1 — no fresh sells/)
})

test('PORTED: without the scan a sub-lot band still gives up, in today’s words', () => {
  // `test_without_the_scan_a_sub_lot_band_still_gives_up`: allowance 30 against
  // the 100 lot. Every committed board carries this line.
  const out = pyShed(300, pyBook(-60, -5))
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /allowance 30 under one lot \(100\); no convexity to centre/)
})

test('PORTED: THE SCAN CLEARS A FLOOR THE WHOLE LOT REFUSED — and picks the BEST FIT', () => {
  // `test_the_scan_clears_a_floor_the_whole_lot_refused` +
  // `test_the_scan_picks_the_BEST_FIT_not_the_nearest_strike`. Same book: the
  // finest lot within three strikes is the 285 PE at 0.20 → 20 delta-shares, and
  // an allowance of 30 IS expressible in those units. The PICK is then the 290
  // PE, which sheds exactly 30 — the nearest strike is not the answer, and
  // neither is the finest.
  const out = pyShed(300, pyBook(-60, -5), pyDials({ shed_scan_strikes: 3 }))
  assert.doesNotMatch(out.reason, /no convexity/)
  assert.deepEqual(out.actions, [{ op: 'open', strike: 290, optType: 'PE', side: 'Sell', lots: 1, add: true }])
})

test('PORTED: the scan NEVER REACHES PAST ITS CAP — and the ONE case where the rounding rule differs', () => {
  // `test_it_never_reaches_past_the_cap` + `test_a_wider_scan_would_have_reached_it`.
  // Excess 10 fits one lot of the 280 PE (0.10) exactly, and 280 is FOUR
  // strikes out. Widening the cap to 4 reaches it, and the best fit is exact:
  const reached = pyShed(300, pyBook(-40, -5), pyDials({ shed_scan_strikes: 4 }))
  assert.deepEqual(reached.actions, [
    { op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 1, add: true },
  ])

  // THE DIVERGENCE, AND IT IS THE ONE `bestFit`'s header names. Python HOLDS at
  // a cap of 3 — "every strike within three rounds to zero lots" — because
  // `round(10 / 20)` on the 285 PE is `round(0.5)`, and Python's `round()` is
  // BANKER'S (half to even → 0). JS rounds half away from zero → 1, so this
  // engine sells one lot of the 285 instead of holding.
  //
  // Kept rather than "fixed", for the reason `shed.ts` states: half-up errs
  // toward shedding slightly MORE, which is the safe direction for a book
  // already past its band. The premise there — "an exact .5 is not reachable off
  // a solved greek" — holds for every LIVE mark, because live greeks come out of
  // a Black-76 solve; it is reachable here only because the Python fixture
  // DECLARES round two-decimal deltas. All 1,152 parity marks agree, so no
  // recorded board moves under it. This test is where the difference is written
  // down instead of being a footnote.
  const capped = pyShed(300, pyBook(-40, -5), pyDials({ shed_scan_strikes: 3 }))
  assert.deepEqual(capped.actions, [
    { op: 'open', strike: 285, optType: 'PE', side: 'Sell', lots: 1, add: true },
  ])
  // The CAP still bites: nothing further out than 285 is reachable at 3.
  assert.ok(
    shedCandidates(pyChain(300), 'PE', 300, 3, DATE, MINUTE, { greeks: pyGreeks(300) }).every(
      (c) => c.strike >= 285,
    ),
  )
})

test('PORTED: the scan sheds the OTHER side when the delta is long', () => {
  // `test_the_scan_sheds_the_other_side_when_delta_is_long`.
  const [open] = pyShed(300, pyBook(60, -5), pyDials({ shed_scan_strikes: 3 })).actions
  assert.ok(open !== undefined && open.op === 'open')
  assert.equal(open.optType, 'CE')
})

test('PORTED: candidates are deduplicated and NEAREST FIRST', () => {
  // `test_candidates_are_deduplicated_and_nearest_first`. Nearest-first is what
  // makes the tie-break in `bestFit` mean "the nearer strike, where the premium
  // and the liquidity are".
  const cands = shedCandidates(pyChain(300), 'PE', 300, 3, DATE, MINUTE, {
    greeks: pyGreeks(300),
  })
  assert.deepEqual(
    cands.map((c) => c.strike),
    [295, 290, 285],
  )
  assert.equal(new Set(cands.map((c) => c.strike)).size, cands.length)
  assert.deepEqual(
    cands.map((c) => c.dps),
    [0.4, 0.3, 0.2],
  )
})

/**
 * THE SHED'S OPEN SAYS IT IS AN ADD.
 *
 * `phaseShed` re-emits `open` for whatever strike its scan picks, held or not —
 * a faithful port (`parity.test.ts` replays the legacy emitting `open 3x 310CE`
 * onto a book already at `ce310: 4`, every mark). Downstream, `book.ts` refused
 * it: TCS skipped 267 of 278 decisions that way, KALYANKJIL 125 of 132 and
 * TATASTEEL 16 of 25, for six days, each unable to act on its own shed.
 *
 * "Open 3x 310CE" means two different things — ADD DELIBERATELY and REPEAT
 * ACCIDENTALLY — and the book cannot tell them apart, so it refused both. This
 * flag is the difference, set by the one caller that knows.
 *
 * INVISIBLE TO PARITY BY CONSTRUCTION: `parity.test.ts` keys an open on
 * strike/optType/side/lots and reads no other field, so the legacy comparison
 * is unchanged. `leanId` rides along the same way.
 */
test('the shed marks its open as an ADD, so the book can tell it from a repeat', () => {
  const r = shed(inputsOf(chainOf(300), shedBook()))
  assert.deepEqual(r.actions, [
    { op: 'open', strike: 330, optType: 'CE', side: 'Sell', lots: 104, add: true },
  ])
})
