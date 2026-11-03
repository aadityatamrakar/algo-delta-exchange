/**
 * PHASE S, PINNED TO A LADDER A HUMAN CAN COUNT ON THEIR FINGERS.
 *
 * The chain is a 10-wide ladder from 250 to 350 and spot is 305, which puts the
 * ATM snap at 300 (a 5-point tie that `nearestStrike`'s first-wins rule breaks
 * downward) and makes a short 300 CE sit EXACTLY `shift_itm_steps` 0.5 x step 10
 * = 5 points inside spot. Every depth test below is therefore a boundary test as
 * well as a behaviour test: Python's gate is `depth < need -> skip`, so a leg at
 * exactly the threshold MUST shift, and a port that wrote `<=` fails here rather
 * than three tickets later on a live book.
 *
 * The four things that would otherwise pass silently:
 *
 *   1. THE MARGIN GATE'S THREE OFF-STATES. `shift_margin_frac` 0 (gate absent),
 *      `margin_cap` 0 (nothing to be a fraction of) and a margin figure we do
 *      not trust are three different reasons and only one of them means "shift
 *      anyway". Python has the first two (`playbooks.py:3950-3958`); the third
 *      is new and is the BHEL case in its own block below.
 *   2. THE MERGE. Two ITM legs landing on one spot-anchored strike must become
 *      ONE order. Python's `shift_slot` (`:4011-4018`) exists because a
 *      leg-relative family never collides and a spot-anchored one routinely
 *      does; drop it and the gateway gets two orders for the same contract.
 *   3. THE ROLL-FORWARD. `rolledDelta`/`rolledGamma` are DELTAS, not totals —
 *      what phase R must add to the corridor's numbers to size off the book it
 *      is about to hold rather than the one it is holding. A port that returned
 *      absolute post-shift greeks type-checks identically and mis-sizes every
 *      hedge on a shift mark.
 *   4. PROTECTED QUANTITY. Exempt at SELECTION, never at the close, because a
 *      shift is atomic: drop only the close half and the fresh sell stands
 *      alone (`playbooks.py:2962-2967`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  RISK_FREE,
  phaseShift,
  unprotectedLots,
  EMPTY_RULE_STATE,
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
const STEP = 10
const LOT = 25
const SPOT = 305 // 5 points above the 300 strike = exactly 0.5 steps
const LADDER = [250, 260, 270, 280, 290, 300, 310, 320, 330, 340, 350]

const CAP = 10_000_000

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: 1 })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so every
 * strike on the chain solves back to that vol and its greeks are the model's. */
function bookAt(spot: number, strike: number, type: OptType): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.98, px * 1.02)
}

function chainOf(
  spot = SPOT,
  strikes: number[] = LADDER,
  over: Partial<ChainSnap> = {},
): ChainSnap {
  return {
    symbol: 'BHEL',
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: strikes.map((k) => ({ strike: k, ce: bookAt(spot, k, 'CE'), pe: bookAt(spot, k, 'PE') })),
    asOf: 1,
    ...over,
  }
}

/** The model's own per-share greeks at a strike — what `strikeGreeks` will
 * answer for this chain, derived here independently so the roll-forward test
 * is arithmetic rather than a restatement of the implementation. */
function modelGreeks(strike: number, type: OptType, spot = SPOT) {
  return b76Greeks({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
}

/**
 * `strikeGreeks` reaches the model the long way round — mid → implied vol →
 * greeks — and the recovered vol only matches `VOL` to the solver's own
 * tolerance, so a greek taken through it differs from the model's in the eighth
 * significant figure. The roll-forward is checked to a RELATIVE 1e-6: still six
 * orders of magnitude finer than one share of delta, and it fails outright if
 * either sign factor is applied differently.
 */
function assertClose(actual: number, expected: number, what: string): void {
  const tol = Math.max(1e-9, Math.abs(expected) * 1e-6)
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: ${actual} is not within ${tol} of ${expected}`,
  )
}

let legSeq = 0
function leg(over: Partial<LegView> = {}): LegView {
  legSeq += 1
  const strike = over.strike ?? 300
  const optType = over.optType ?? 'CE'
  const g = modelGreeks(strike, optType)
  // The id is derived from the RESOLVED strike/wing plus a sequence number, so
  // two legs in one book never share one by accident — `close` actions are
  // matched on the instrument and a collision would read as a merge.
  const base: LegView = {
    instrument: `BHEL26AUG${strike}${optType}#${legSeq}`,
    strike,
    optType,
    side: 'Sell',
    lots: 4,
    lotSize: LOT,
    entry: 10,
    openedByEngine: true,
    // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
    leanId: '',
    iv: VOL,
    delta: Math.abs(g.delta),
    gamma: g.gamma,
    // Inert on every recenter path — nothing here reads either greek. Carried
    // because `LegView` requires them (`types.ts`): theta per calendar day,
    // vega per vol point, both per-share.
    theta: 0,
    vega: 0,
    hasGreeks: true,
    mtm: 0,
    exit: q(9, 11),
  }
  return { ...base, ...over }
}

function inputsOf(legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  return {
    tag: 'BHEL-2026-08-25',
    mode: 'paper',
    nowMs: 1_755_000_000_000,
    dateIst: DATE,
    minuteOfDay: MINUTE,
    dte: 7,
    chain: chainOf(),
    legs,
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0.65 * CAP, source: 'broker', asOf: 1, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
    ...over,
  }
}

/** The relief-r shift dials: 0.5 steps in, land 2 out, gate at 60% of a ₹1cr
 * cap (`dials.ts` DEFAULT_DIALS, playbooks.py:472-477). */
const relief = (over: Partial<Dials> = {}): Dials => ({
  ...DEFAULT_DIALS,
  shift_enabled: true,
  shift_itm_steps: 0.5,
  shift_land_steps: 2,
  shift_margin_frac: 0.6,
  hedge_after_shift: false,
  margin_cap: CAP,
  min_sell_dte: 1,
  ...over,
})

// ── (a) the shift itself ────────────────────────────────────────────────────

test('a short CE exactly 0.5 steps ITM at 65% of cap shifts: one close, one open 2 steps OTM, lots preserved', () => {
  const itm = leg({ strike: 300, optType: 'CE', lots: 4 })
  const out = phaseShift(inputsOf([itm]), relief(), EMPTY_RULE_STATE)

  assert.equal(out.fired, true)
  assert.deepEqual(out.actions, [
    { op: 'close', instrument: itm.instrument },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 4 },
  ])
})

test('the landing strike is keyed to SPOT, not to how deep the leg is', () => {
  // 300 is 5 points in, 260 is 45 points in. Both land on the same 320.
  const shallow = phaseShift(inputsOf([leg({ strike: 300 })]), relief(), EMPTY_RULE_STATE)
  const deep = phaseShift(inputsOf([leg({ strike: 260 })]), relief(), EMPTY_RULE_STATE)
  assert.deepEqual(
    shallow.actions.filter((a) => a.op === 'open'),
    deep.actions.filter((a) => a.op === 'open'),
  )
})

test('shift_land_steps 0 lands on the ATM snap itself, which is NOT pushed OTM', () => {
  // recenter-atm (playbooks.py:404-407): `land <= 0 -> nk = atm`, with no
  // strictly-OTM push. At spot 305 the ATM snap is 300, which is ITM for a call
  // — Python lands there anyway and the fixtures record it (310 -> 330 at spot
  // 330). A port that routed `land <= 0` through `otmSellStrike` would push to
  // 310 and diverge on every recenter-atm mark.
  const out = phaseShift(
    inputsOf([leg({ strike: 280, optType: 'CE' })]),
    relief({ shift_land_steps: 0, shift_itm_steps: 1 }),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions.filter((a) => a.op === 'open'), [
    { op: 'open', strike: 300, optType: 'CE', side: 'Sell', lots: 4 },
  ])
})

test('an OTM leg gives a NEGATIVE depth and is never touched', () => {
  // signed depth (`playbooks.py:3976-3980`): a 320 CE against spot 305 is
  // -15, which fails `depth >= need` for any non-negative `need`.
  const out = phaseShift(inputsOf([leg({ strike: 320, optType: 'CE' })]), relief(), EMPTY_RULE_STATE)
  assert.deepEqual(out.actions, [])
  assert.equal(out.fired, false)
})

test('a short PE measures depth on the other side of spot', () => {
  const itm = leg({ strike: 310, optType: 'PE', lots: 3 })
  const out = phaseShift(inputsOf([itm]), relief(), EMPTY_RULE_STATE)
  assert.deepEqual(out.actions, [
    { op: 'close', instrument: itm.instrument },
    { op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 3 },
  ])
})

test('a leg one point short of the threshold does not shift', () => {
  // need = 0.5 x 10 = 5. A 301 CE is 4 points in. (301 is not on the ladder —
  // the DEPTH test reads the leg's own strike, only the LANDING snaps.)
  const out = phaseShift(inputsOf([leg({ strike: 301, optType: 'CE' })]), relief(), EMPTY_RULE_STATE)
  assert.deepEqual(out.actions, [])
})

test('a leg already standing on its own landing strike is a no-op, not a churn order', () => {
  // `playbooks.py:3985-3986` — `if nk == k: continue`. Contrived by landing on
  // ATM with a leg already at ATM.
  const out = phaseShift(
    inputsOf([leg({ strike: 300, optType: 'CE' })]),
    relief({ shift_land_steps: 0 }),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('a long leg is never a shift candidate — phase S spends SHORTS', () => {
  const out = phaseShift(
    inputsOf([leg({ strike: 300, optType: 'CE', side: 'Buy' })]),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

// ── (b)(c)(d) the margin gate, and its three off-states ─────────────────────

test('50% of cap is under the 60% gate — no shift', () => {
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], { margin: { value: 0.5 * CAP, source: 'broker', asOf: 1, fresh: true } }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
  assert.equal(out.fired, false)
})

test('exactly the gate fraction arms it — the comparison is >=, not >', () => {
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], { margin: { value: 0.6 * CAP, source: 'broker', asOf: 1, fresh: true } }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.equal(out.fired, true)
})

test('a MODEL margin at 90% of cap does NOT shift — the BHEL 20.8L-vs-42.9L case', () => {
  // Design spec §6. The Python desk steered this gate off SPAN-lite, and on
  // BHEL-2026-08-25 SPAN-lite said 20.8L where the broker said 42.9L — a
  // factor of 2.06 on the one number the gate is a fraction OF. A model figure
  // that happens to read 90% could be any true load at all, so it may not arm a
  // rule whose action is a FRESH SHORT SALE. Held, not guessed.
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], { margin: { value: 0.9 * CAP, source: 'model', asOf: 1, fresh: false } }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('a STALE broker margin at 90% of cap does not shift either', () => {
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], { margin: { value: 0.9 * CAP, source: 'broker', asOf: 1, fresh: false } }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('parity pricing takes the margin figure as-is — Python had no freshness concept', () => {
  // §12: `pricing: 'parity'` replays Python decisions, and Python's ctx carried
  // one `margin` float with no provenance. Requiring a broker stamp there would
  // make every recorded shift mark unreproducible.
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], {
      pricing: 'parity',
      margin: { value: 0.9 * CAP, source: 'model', asOf: 1, fresh: false },
    }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.equal(out.fired, true)
})

test('margin_cap 0 never shifts, however loaded the book — an uncapped book has no ceiling to be a fraction of', () => {
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], { margin: { value: 50 * CAP, source: 'broker', asOf: 1, fresh: true } }),
    relief({ margin_cap: 0 }),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('shift_margin_frac 0 turns the GATE off, not the shifting — recenter-atm/otm shift at any margin', () => {
  // `playbooks.py:3950-3952`: the gate only exists while `_mfrac > 0`. This is
  // what makes the recenter-atm and recenter-otm fixtures shift on their
  // below-gate and uncapped rows.
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], { margin: { value: 0, source: 'model', asOf: 1, fresh: false } }),
    relief({ shift_margin_frac: 0, margin_cap: 0 }),
    EMPTY_RULE_STATE,
  )
  assert.equal(out.fired, true)
})

// ── (e) protected quantity ──────────────────────────────────────────────────

test('protectedQty covering the whole ITM leg skips it — exempt at SELECTION, so the fresh sell never stands alone', () => {
  const itm = leg({ strike: 300, optType: 'CE', lots: 4 })
  const out = phaseShift(
    inputsOf([itm], { protectedQty: { [itm.instrument]: 4 } }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('protectedQty over-claiming is clamped to what is held, not netted negative', () => {
  const itm = leg({ strike: 300, optType: 'CE', lots: 4 })
  const out = phaseShift(
    inputsOf([itm], { protectedQty: { [itm.instrument]: 99 } }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('a PARTLY protected leg shifts only the spendable lots — a RESIZE down to the protected tail, never a close', () => {
  // Python's `unprotected` is a per-leg BOOLEAN and cannot express this; the
  // engine's `protectedQty` is a quantity, so the honest atomic package is
  // "leave the operator's 1 lot standing, move ours".
  const itm = leg({ strike: 300, optType: 'CE', lots: 4 })
  const out = phaseShift(
    inputsOf([itm], { protectedQty: { [itm.instrument]: 1 } }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [
    { op: 'resize', instrument: itm.instrument, targetLots: 1 },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 3 },
  ])
})

test('the netting helper phase S selects through is the SHARED one', () => {
  // Ticket 08 lifted `shiftSpendableLots` into `guards.unprotectedLots` so the
  // shift, the scrap tier and the margin trim can never disagree about what a
  // protected leg is (`guards.ts` §1). This asserts the two behaviours phase S
  // depends on, at the seam; the helper's own cases live in `guards.test.ts`.
  const l = leg({ strike: 300, lots: 4 })
  assert.deepEqual(
    unprotectedLots([l], { [l.instrument]: 1 }).map((x) => x.steerableLots),
    [3],
  )
  // A wholly claimed leg is not a candidate AT ALL — it does not reach the ITM
  // scan as a zero-lot row that some later branch might still act on.
  assert.deepEqual(unprotectedLots([l], { [l.instrument]: 4 }), [])
})

// ── (f) the merge ───────────────────────────────────────────────────────────

test('two ITM legs landing on the same spot-anchored strike merge into ONE open', () => {
  const a = leg({ strike: 300, optType: 'CE', lots: 4 })
  const b = leg({ strike: 280, optType: 'CE', lots: 3 })
  const out = phaseShift(inputsOf([a, b]), relief(), EMPTY_RULE_STATE)

  assert.deepEqual(out.actions, [
    { op: 'close', instrument: a.instrument },
    { op: 'close', instrument: b.instrument },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 7 },
  ])
})

test('two ITM legs on DIFFERENT wings do not merge', () => {
  const ce = leg({ strike: 300, optType: 'CE', lots: 4 })
  const pe = leg({ strike: 310, optType: 'PE', lots: 2 })
  const out = phaseShift(inputsOf([ce, pe]), relief(), EMPTY_RULE_STATE)

  assert.deepEqual(out.actions.filter((a) => a.op === 'open'), [
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 4 },
    { op: 'open', strike: 280, optType: 'PE', side: 'Sell', lots: 2 },
  ])
})

// ── the gates that come before any of it ────────────────────────────────────

test('shift_enabled false is silent', () => {
  const out = phaseShift(inputsOf([leg({ strike: 300 })]), relief({ shift_enabled: false }), EMPTY_RULE_STATE)
  assert.deepEqual(out.actions, [])
})

test('dte at or under min_sell_dte holds — a shift CONTAINS a fresh sell', () => {
  const armed = inputsOf([leg({ strike: 300 })])
  assert.equal(phaseShift({ ...armed, dte: 2 }, relief(), EMPTY_RULE_STATE).fired, true)
  assert.equal(phaseShift({ ...armed, dte: 1 }, relief(), EMPTY_RULE_STATE).fired, false)
  assert.equal(phaseShift({ ...armed, dte: 0 }, relief(), EMPTY_RULE_STATE).fired, false)
})

test('spot 0 holds — every short PE would otherwise read as infinitely ITM', () => {
  // `playbooks.py:3907-3913`. The parent holds here and so does phase S: with
  // the chain missing too, the opens are dropped on no_mark while the closes
  // still land, and the book is left naked.
  const out = phaseShift(
    inputsOf([leg({ strike: 300 })], { chain: chainOf(0) }),
    relief(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('a flat book is silent', () => {
  assert.deepEqual(phaseShift(inputsOf([]), relief(), EMPTY_RULE_STATE).actions, [])
})

// ── the roll-forward ────────────────────────────────────────────────────────

test('rolledDelta and rolledGamma are the ADJUSTMENTS phase R adds, not post-shift totals', () => {
  const lots = 4
  const shares = lots * LOT
  const itm = leg({ strike: 300, optType: 'CE', lots })
  const out = phaseShift(inputsOf([itm]), relief(), EMPTY_RULE_STATE)

  // The leg's contribution to the corridor's sums, by corridor.ts's rule:
  // delta takes the wing sign AND the position sign, gamma the position sign
  // only. `LegView.delta` is an unsigned magnitude.
  const oldD = 1 * -1 * itm.delta * shares
  const oldG = -1 * itm.gamma * shares
  // The 320 CE it is about to hold, short. `strikeGreeks` returns the RAW
  // wing-signed delta, so the short's contribution is its negation.
  const g = modelGreeks(320, 'CE')
  const newD = -g.delta * shares
  const newG = -g.gamma * shares

  assertClose(out.rolledDelta, newD - oldD, 'rolledDelta')
  assertClose(out.rolledGamma, newG - oldG, 'rolledGamma')
  // Moving a 300 CE out to 320 sheds negative delta from a short book, so the
  // adjustment is POSITIVE and smaller in magnitude than the old contribution.
  assert.ok(out.rolledDelta > 0)
  assert.ok(Math.abs(out.rolledDelta) < Math.abs(oldD))
})

test('a target strike the chain cannot price leaves the running totals UNCHANGED, and the shift still happens', () => {
  // `playbooks.py:3994-4009` — the fallback is the leg's own figure, which
  // cancels to a zero adjustment rather than zeroing the book's greeks.
  const bare = chainOf()
  const blind: ChainSnap = {
    ...bare,
    strikes: bare.strikes.map((s) => (s.strike === 320 ? { ...s, ce: null } : s)),
  }
  const itm = leg({ strike: 300, optType: 'CE', lots: 4 })
  const out = phaseShift(inputsOf([itm], { chain: blind }), relief(), EMPTY_RULE_STATE)

  assert.equal(out.fired, true)
  assert.deepEqual(out.actions.filter((a) => a.op === 'open'), [
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 4 },
  ])
  assert.equal(out.rolledDelta, 0)
  assert.equal(out.rolledGamma, 0)
})

test('the roll-forward sums over every shifted leg', () => {
  const a = leg({ strike: 300, optType: 'CE', lots: 4 })
  const b = leg({ strike: 280, optType: 'CE', lots: 3 })
  const each = [a, b].map((l) => phaseShift(inputsOf([l]), relief(), EMPTY_RULE_STATE))
  const both = phaseShift(inputsOf([a, b]), relief(), EMPTY_RULE_STATE)

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
  assert.ok(Math.abs(both.rolledDelta - sum(each.map((e) => e.rolledDelta))) < 1e-9)
  assert.ok(Math.abs(both.rolledGamma - sum(each.map((e) => e.rolledGamma))) < 1e-9)
})

test('phase S is STATELESS — it reads no RuleState field and returns none', () => {
  // `playbooks.py:3893` says so in as many words. The signature takes the state
  // for uniformity with the other phases; a shift mark that mutated it would
  // break the fixture invariant `state_after == state` that parity-shift asserts.
  const armed = inputsOf([leg({ strike: 300 })])
  const fresh = phaseShift(armed, relief(), EMPTY_RULE_STATE)
  const loaded = phaseShift(armed, relief(), {
    ...EMPTY_RULE_STATE,
    rcCredit: 12_345,
    rcEodDay: DATE,
    gkStreak: 7,
    targetLocked: true,
    scrapBanned: ['300:CE:2026-08-28'],
    lastActionMs: 99,
  })
  assert.deepEqual(fresh, loaded)
})

// ── PORTED FROM PYTHON — `test_sim_recenter_shift.py` ───────────────────────
//
// The Python fixtures run on a FIVE-point grid around spot 300 with a lot of
// 100 — `recenter-atm` and `recenter-otm` at `shift_itm_steps` 1.0, landing on
// the ATM snap and one strike beyond it. This file's own harness is BHEL's
// (10-point grid, lot 25, spot 305), so the ported block builds the Python
// geometry beside it rather than bending either.
//
// `shift_margin_frac` 0 throughout: neither shipped variant carries the dial,
// and 0 means the GATE is absent, NOT the shifting (`shift.ts` §1 — a port that
// read 0 as "never arm" silently deletes two playbooks).

const PY_STEP = 5
const PY_LOT = 100
const PY_LADDER = Array.from({ length: 21 }, (_, i) => 250 + i * PY_STEP)

function pyChain(spot: number): ChainSnap {
  return {
    symbol: 'PY',
    expiry: EXPIRY,
    step: PY_STEP,
    lotSize: PY_LOT,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: PY_LADDER.map((k) => ({ strike: k, ce: q(5.9, 6.1), pe: q(5.9, 6.1) })),
    asOf: 1,
  }
}

let pySeq = 0
/** `_itm_ce` / `_itm_pe` (`test_sim_recenter_shift.py:70-76`). */
function pyLeg(strike: number, optType: OptType, lots = 10): LegView {
  pySeq += 1
  return {
    instrument: `${optType.toLowerCase()}${strike}#${pySeq}`,
    strike,
    optType,
    side: 'Sell',
    lots,
    lotSize: PY_LOT,
    entry: 5,
    openedByEngine: true,
    // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
    leanId: '',
    iv: 0.18,
    delta: 0.7,
    gamma: 0.02,
    // Inert on every recenter path — nothing here reads either greek. Carried
    // because `LegView` requires them (`types.ts`): theta per calendar day,
    // vega per vol point, both per-share.
    theta: 0,
    vega: 0,
    hasGreeks: true,
    mtm: 0,
    exit: q(8.9, 9.1),
  }
}

function pyInputs(legs: LegView[], spot = 300, over: Partial<EngineInputs> = {}): EngineInputs {
  return inputsOf(legs, { chain: pyChain(spot), dte: 20, pricing: 'parity', ...over })
}

/** `DEFAULTS["recenter-atm"]` / `["recenter-otm"]`: 1.0 steps in, land 0 / 1
 * out, NO margin fraction (`playbooks.py:404-411`). */
const atmDials = (over: Partial<Dials> = {}): Dials =>
  relief({ shift_itm_steps: 1, shift_land_steps: 0, shift_margin_frac: 0, ...over })
const otmDials = (over: Partial<Dials> = {}): Dials => atmDials({ shift_land_steps: 1, ...over })

test('PORTED: a leg EXACTLY one step ITM shifts, and lands on the money', () => {
  // `test_leg_exactly_one_step_itm_shifts` + `test_atm_variant_lands_on_the_money`.
  const itm = pyLeg(295, 'CE')
  const out = phaseShift(pyInputs([itm]), atmDials(), EMPTY_RULE_STATE)
  assert.deepEqual(out.actions, [
    { op: 'close', instrument: itm.instrument },
    { op: 'open', strike: 300, optType: 'CE', side: 'Sell', lots: 10 },
  ])
})

test('PORTED: 0.6 steps in is left alone; 1.6 steps in on the same grid shifts', () => {
  // `test_leg_under_the_threshold_does_not_shift` + its positive control. Spot
  // moves OFF the grid rather than the strike, so the 5-point step is unchanged.
  const shallow = phaseShift(pyInputs([pyLeg(300, 'CE')], 303), atmDials(), EMPTY_RULE_STATE)
  assert.deepEqual(shallow.actions, [])
  assert.equal(shallow.fired, false)

  const deep = pyLeg(295, 'CE')
  const out = phaseShift(pyInputs([deep], 303), atmDials(), EMPTY_RULE_STATE)
  assert.equal(out.actions[0]?.op === 'close' ? out.actions[0].instrument : '', deep.instrument)
})

test('PORTED: OTM legs are NEVER touched', () => {
  // `test_otm_legs_are_never_touched`. The depth test is SIGNED, so an OTM leg
  // gives a negative depth and fails it.
  const out = phaseShift(
    pyInputs([pyLeg(310, 'CE'), pyLeg(290, 'PE')]),
    atmDials(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('PORTED: the OTM variant lands ONE strike beyond ATM, and strictly OTM', () => {
  // `test_otm_variant_lands_one_strike_beyond_and_strictly_otm`.
  const out = phaseShift(pyInputs([pyLeg(290, 'CE')]), otmDials(), EMPTY_RULE_STATE)
  const open = out.actions.find((a) => a.op === 'open')
  assert.ok(open !== undefined && open.op === 'open')
  assert.equal(open.strike, 305)
  assert.ok(open.strike > 300)
})

test('PORTED: the put side lands the MIRROR IMAGE', () => {
  // `test_put_side_lands_the_mirror_image`: ATM 300, one beyond 295.
  const atm = phaseShift(pyInputs([pyLeg(310, 'PE')]), atmDials(), EMPTY_RULE_STATE)
  const otm = phaseShift(pyInputs([pyLeg(310, 'PE')]), otmDials(), EMPTY_RULE_STATE)
  assert.equal(atm.actions.find((a) => a.op === 'open')?.op === 'open' ? 1 : 0, 1)
  assert.deepEqual(
    atm.actions.filter((a) => a.op === 'open').map((a) => (a.op === 'open' ? a.strike : 0)),
    [300],
  )
  assert.deepEqual(
    otm.actions.filter((a) => a.op === 'open').map((a) => (a.op === 'open' ? a.strike : 0)),
    [295],
  )
})

test('PORTED: THE DIFFERENTIATOR — the target is anchored to SPOT, not to the leg', () => {
  // `test_target_is_anchored_to_spot_not_to_the_leg`: a 3-steps-ITM leg lands
  // where a 1-step one does. "hold-recycle-shift would send 285 → 290 and
  // shift-atm 285 → 295. These ARE that jump."
  const deep = phaseShift(pyInputs([pyLeg(285, 'CE')]), atmDials(), EMPTY_RULE_STATE)
  const shallow = phaseShift(pyInputs([pyLeg(295, 'CE')]), atmDials(), EMPTY_RULE_STATE)
  const strikeOf = (r: ReturnType<typeof phaseShift>) =>
    r.actions.filter((a) => a.op === 'open').map((a) => (a.op === 'open' ? a.strike : 0))
  assert.deepEqual(strikeOf(deep), [300])
  assert.deepEqual(strikeOf(shallow), [300])
})

test('PORTED: the shift re-sells the SAME lots, and closes every shifted leg and no other', () => {
  // `test_shift_re_sells_the_same_lots` + `test_every_shifted_leg_is_closed_and_none_other`.
  const seven = phaseShift(pyInputs([pyLeg(290, 'CE', 7)]), atmDials(), EMPTY_RULE_STATE)
  const open = seven.actions.find((a) => a.op === 'open')
  assert.ok(open !== undefined && open.op === 'open')
  assert.equal(open.lots, 7)
  assert.equal(open.side, 'Sell')

  const itmCe = pyLeg(290, 'CE')
  const itmPe = pyLeg(312, 'PE')
  const otmCe = pyLeg(310, 'CE')
  const otmPe = pyLeg(290, 'PE')
  const mixed = phaseShift(
    pyInputs([itmCe, itmPe, otmCe, otmPe]),
    atmDials(),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(
    mixed.actions.filter((a) => a.op === 'close').map((a) => (a.op === 'close' ? a.instrument : '')),
    [itmCe.instrument, itmPe.instrument],
  )
})

test('PORTED: no shift at or under min_sell_dte, and never a BUY', () => {
  // `test_no_shift_at_or_under_min_sell_dte` + `test_never_emits_a_buy`. A shift
  // CONTAINS a fresh sale, so the near-expiry sell ban covers it.
  const near = phaseShift(pyInputs([pyLeg(290, 'CE')], 300, { dte: 1 }), atmDials(), EMPTY_RULE_STATE)
  assert.deepEqual(near.actions, [])

  for (const dials of [atmDials(), otmDials()]) {
    const out = phaseShift(pyInputs([pyLeg(285, 'CE'), pyLeg(315, 'PE')]), dials, EMPTY_RULE_STATE)
    for (const a of out.actions) {
      if (a.op === 'open') assert.equal(a.side, 'Sell')
    }
    assert.ok(out.actions.some((a) => a.op === 'open'))
  }
})

test('PORTED: phase S is STATELESS', () => {
  // `test_is_stateless`. A shift mark that mutated state would break the
  // fixture invariant `state_after == state` the parity harness asserts.
  const before = EMPTY_RULE_STATE
  phaseShift(pyInputs([pyLeg(290, 'CE')]), atmDials(), before)
  assert.deepEqual(before, EMPTY_RULE_STATE)
})

test('PORTED: NO SPOT holds instead of shifting the whole put book to the bottom', () => {
  // `test_no_spot_holds_instead_of_shifting_the_whole_put_book`: at spot 0 every
  // short PE reads as infinitely ITM, and with the chain missing too the opens
  // are dropped while the closes land — leaving the book naked.
  for (const dials of [atmDials(), otmDials()]) {
    const out = phaseShift(
      pyInputs([pyLeg(310, 'CE'), pyLeg(290, 'PE')], 0),
      dials,
      EMPTY_RULE_STATE,
    )
    assert.deepEqual(out.actions, [])
    assert.equal(out.fired, false)
  }
})

test('PORTED: two legs landing on the same spot-anchored strike MERGE into one order', () => {
  // `test_two_legs_landing_on_the_same_strike_merge_into_one_order`. Spot-
  // anchored targets collide by construction; leg-relative ones never do. Two
  // orders at the same strike would also be downsized independently by the
  // margin projection.
  const a = pyLeg(285, 'CE', 10)
  const b = pyLeg(290, 'CE', 4)
  const out = phaseShift(pyInputs([a, b]), atmDials(), EMPTY_RULE_STATE)
  assert.deepEqual(out.actions, [
    { op: 'close', instrument: a.instrument },
    { op: 'close', instrument: b.instrument },
    { op: 'open', strike: 300, optType: 'CE', side: 'Sell', lots: 14 },
  ])
})

test('PORTED: the margin gate blocks at 40% of cap, allows at 60% and above', () => {
  // `test_margin_gate_blocks_the_shift_below_the_threshold` and its two
  // companions — relief's 0.60 fraction, on the ₹1cr cap the fixtures use.
  const gated = (frac: number) =>
    phaseShift(
      pyInputs([pyLeg(290, 'CE')], 300, {
        margin: { value: frac * 10_000_000, source: 'broker', asOf: 1, fresh: true },
      }),
      relief({ shift_itm_steps: 1, shift_land_steps: 0, shift_margin_frac: 0.6, margin_cap: 10_000_000 }),
      EMPTY_RULE_STATE,
    )
  assert.deepEqual(gated(0.4).actions, [], '40% is under the gate')
  assert.equal(gated(0.6).actions.length, 2, 'AT the threshold arms — the test is `>=`')
  assert.equal(gated(0.7).actions.length, 2)
})

test('PORTED: an UNCAPPED book disables shifting rather than enabling it', () => {
  // `test_uncapped_book_disables_shifting_rather_than_enabling_it`: there is no
  // ceiling to be a fraction of, so the safe reading is "do not shift" — and it
  // is also what stops `margin / 0` (`shift.ts` §1).
  const out = phaseShift(
    pyInputs([pyLeg(290, 'CE')], 300, {
      margin: { value: 9_000_000, source: 'broker', asOf: 1, fresh: true },
    }),
    relief({ shift_itm_steps: 1, shift_land_steps: 0, shift_margin_frac: 0.6, margin_cap: 0 }),
    EMPTY_RULE_STATE,
  )
  assert.deepEqual(out.actions, [])
})

test('PORTED: the gate is INERT for the shipped shift variants, at any margin', () => {
  // `test_margin_gate_is_inert_for_the_shipped_shift_variants`: recenter-atm and
  // recenter-otm carry no `shift_margin_frac`, so a book at 1% of cap shifts.
  const out = phaseShift(
    pyInputs([pyLeg(290, 'CE')], 300, {
      margin: { value: 100_000, source: 'broker', asOf: 1, fresh: true },
    }),
    atmDials({ margin_cap: 10_000_000 }),
    EMPTY_RULE_STATE,
  )
  assert.equal(out.actions.length, 2)
})
