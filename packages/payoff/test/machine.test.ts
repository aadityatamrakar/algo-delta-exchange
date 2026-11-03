/**
 * THE MACHINE'S MIND, READ BACK TO THE OPERATOR.
 *
 * Every assertion here is measured against the live rules in
 * `sensibull-desk/sensibull_tools/sim/rules/playbooks.py` — the file the desk's
 * own bot decides by — and every case cites the line it is pinning. That is the
 * whole point of this suite: the card is worthless if it states a plausible
 * guess about the bot instead of the bot's actual arithmetic, and a plausible
 * guess is exactly what a hand-written panel drifts into.
 *
 * The numbers in the two delta cases are not invented. They are the live
 * TCS-2026-08-25 book as recorded in playbooks.py:430-440 (per-leg greeks
 * reconstructed by Black-Scholes, landing on the dashboard's netΓ to within
 * 0.04), which is also the book the shorts-only dials were introduced for:
 *
 *   net            -3.04 gamma   +422 delta   allowance 141 — UNDER the 225 lot
 *   shorts only    -5.62 gamma   +601 delta   allowance 262 — over it
 *
 * Both rows appear below, because they are the two halves of the confusion this
 * card exists to end: the same book fires or holds depending on WHICH pair of
 * greeks the rule is reading, and every live relief-r book reads the second.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reliefTriggers, type ReliefState } from '../src/machine.ts'

/** The live `recenter-relief` defaults, verbatim from playbooks.py:472-477. */
const RELIEF_DIALS = {
  delta_tol_pct: 0.02,
  strikes_out: 2,
  min_sell_dte: 1,
  target_pnl: 250_000,
  cooldown_min: 0,
  shift_itm_steps: 0.5,
  shift_land_steps: 2,
  shift_margin_frac: 0.6,
  hedge_after_shift: false,
  no_buy: true,
  no_close: true,
  // Set on every LIVE relief-r book (user-directed 2026-08-12; engine.py:223-260
  // reports the shorts-only pair to the dashboard as the steering greeks).
  gamma_shorts_only: true,
  delta_shorts_only: true,
  margin_cap: 10_000_000,
} as const

const TCS_SPOT = 2335

function state(over: Partial<ReliefState> = {}): ReliefState {
  return {
    steering: { delta: 601, gamma: -5.62 },
    dials: { ...RELIEF_DIALS },
    marginUsed: 4_100_000,
    spot: TCS_SPOT,
    ...over,
  }
}

/** The first note matching `re`, or `undefined` — assertions read better on it. */
function note(notes: readonly string[], re: RegExp): string | undefined {
  return notes.find((n) => re.test(n))
}

// ------------------------------------------------------------ the margin gate

test('the shift gate is shut at 41% of the cap, and the note says so in figures', () => {
  // playbooks.py:3910-3918 — `_mfrac = shift_margin_frac`, and when it is > 0:
  //     _margin_ok = _cap > 0 and (_mgn / _cap) >= _mfrac
  // 4.1M / 10M = 0.41, which is under 0.60, so phase 1 does not run at all.
  const t = reliefTriggers(state())
  assert.equal(t.shiftEnabled, false)
  assert.ok(t.marginFrac !== null && Math.abs(t.marginFrac - 0.41) < 1e-12, `marginFrac ${t.marginFrac}`)
  const n = note(t.notes, /shift/i)
  assert.ok(n, `expected a shift note, got ${JSON.stringify(t.notes)}`)
  assert.match(n, /41%/)
  assert.match(n, /60%/)
})

test('at 72% of the cap the gate is open, and the shift is described', () => {
  const t = reliefTriggers(state({ marginUsed: 7_200_000 }))
  assert.equal(t.shiftEnabled, true)
  assert.ok(t.marginFrac !== null && Math.abs(t.marginFrac - 0.72) < 1e-12)
  const n = note(t.notes, /shift/i)
  assert.ok(n)
  assert.match(n, /72%/)
})

test('a mark that shifts does not also hedge — the operator is told', () => {
  // playbooks.py:3979-3981: with `hedge_after_shift` False (the relief default,
  // :476) a mark that emitted a shift RETURNS THERE and never reaches the delta
  // phase. So "would rebalance" and "shift armed" can both be true and still
  // only one of them happens on the mark.
  const t = reliefTriggers(state({ marginUsed: 7_200_000 }))
  assert.equal(t.shiftEnabled, true)
  assert.ok(note(t.notes, /same mark|no hedge|skip/i), JSON.stringify(t.notes))
})

test('margin EXACTLY at the gate shifts — the comparison is >=, not >', () => {
  // playbooks.py:3918 is `(_mgn / _cap) >= _mfrac`. 6M of a 10M cap is 0.60 on
  // the nose, and the bot shifts there. Nothing else in this suite touches the
  // boundary, so without this case the header's ">=, not >" is an unpinned claim.
  const t = reliefTriggers(state({ marginUsed: 6_000_000 }))
  assert.equal(t.marginFrac, 0.6)
  assert.equal(t.shiftEnabled, true)
})

test('the shift note admits what it cannot see, like the delta note does', () => {
  // Phase 1 is skipped WHOLESALE when `dte <= min_sell_dte` (playbooks.py:3920)
  // and only touches shorts at least `shift_itm_steps` steps ITM (:3921-3933).
  // An open gate is not a shift.
  const t = reliefTriggers(state({ marginUsed: 7_200_000 }))
  assert.equal(t.shiftEnabled, true)
  assert.ok(note(t.notes, /ITM/i), JSON.stringify(t.notes))
  assert.ok(
    t.notes.some((n) => /ITM/i.test(n) && /expiry/i.test(n)),
    JSON.stringify(t.notes),
  )
})

test('margin unknown is unknown, not zero', () => {
  const t = reliefTriggers(state({ marginUsed: null }))
  assert.equal(t.marginFrac, null)
  assert.equal(t.shiftEnabled, null)
  assert.ok(note(t.notes, /margin/i))
  // Everything the state DOES know still comes back.
  assert.equal(t.deltaTolPct, 0.02)
  assert.equal(t.targetPnl, 250_000)
})

test('shift_margin_frac 0 disables the GATE, not the shifting', () => {
  // playbooks.py:3910-3918 again, read exactly: `_margin_ok` starts True and is
  // only overwritten when `_mfrac > 0`. The docstring's "0 disables" (3907)
  // means the gate is disabled — with the dial at 0 the bot shifts at ANY
  // margin. Reading it the other way round would put a false "disabled" on a
  // card in front of an operator.
  const dials = { ...RELIEF_DIALS, shift_margin_frac: 0 }
  const t = reliefTriggers(state({ dials }))
  assert.equal(t.shiftEnabled, true)
  assert.ok(note(t.notes, /no margin gate|whatever the margin|any margin/i), JSON.stringify(t.notes))
})

test('an uncapped book never shifts while the gate is set', () => {
  // playbooks.py:3908-3909 + 3918 (`_cap > 0 and …`): "An UNCAPPED book has no
  // ceiling to be a fraction of, so the gate has no meaning and the safe
  // reading is do not shift."
  const { margin_cap: _drop, ...noCap } = RELIEF_DIALS
  const t = reliefTriggers(state({ dials: noCap }))
  assert.equal(t.shiftEnabled, false)
  assert.equal(t.marginFrac, null)
  assert.ok(note(t.notes, /cap/i))
})

// ------------------------------------------------------- the delta-shed rule

test('the shorts-only pair is over the band: the delta rule would fire', () => {
  // WHAT delta_tol_pct IS A TOLERANCE OF (playbooks.py:3399-3404, and the
  // arithmetic at 4014 / 4072 / 4085-4087):
  //     allowed = |netΓ| x delta_tol_pct x spot
  //     excess  = |netΔ| - allowed        → act when excess > 0
  // Divide both sides by |netΓ|·spot and it is a tolerance of MOVE: the book's
  // zero-delta point may not sit more than delta_tol_pct of spot away from
  // spot, either side. The bot prints exactly that quantity itself at :4114 —
  // `off = abs(nd / ng) / spot` — so `deltaImbalance` is that number, signed.
  //
  //   601 / (5.62 x 2335) = 0.04580…  → 4.6% of spot out, against a 2% band.
  const t = reliefTriggers(state())
  assert.ok(t.deltaImbalance !== null)
  assert.ok(Math.abs(t.deltaImbalance - 601 / (5.62 * TCS_SPOT)) < 1e-12, `${t.deltaImbalance}`)
  assert.equal(t.wouldRebalance, true)
  // The sign is kept because it names the side the bot sells (playbooks.py:4056,
  // `side = "CE" if nd > 0 else "PE"`).
  assert.ok(t.deltaImbalance > 0)
  assert.ok(note(t.notes, /CE/), JSON.stringify(t.notes))
})

test('the dials are named in the steering note, because they change the answer', () => {
  const t = reliefTriggers(state())
  assert.ok(note(t.notes, /shorts/i), JSON.stringify(t.notes))
  const whole = reliefTriggers(
    state({ dials: { ...RELIEF_DIALS, gamma_shorts_only: false, delta_shorts_only: false } }),
  )
  assert.ok(!note(whole.notes, /shorts only/i), JSON.stringify(whole.notes))
})

test('a dial encoded as 1 or 0 means what Python means by it', () => {
  // `dials` is assembled from Mongo, where a boolean often arrives as 1/0, and
  // the Python asks `p.get("delta_shorts_only")` — plain truthiness, so 1 IS the
  // dial being on. Reading only the literal `true` would print "the whole book,
  // longs included" over a shorts-only book: the exact sentence this card exists
  // to prevent.
  const on = reliefTriggers(
    state({ dials: { ...RELIEF_DIALS, delta_shorts_only: 1, gamma_shorts_only: 1 } }),
  )
  assert.ok(note(on.notes, /shorts only/i), JSON.stringify(on.notes))
  const off = reliefTriggers(
    state({ dials: { ...RELIEF_DIALS, delta_shorts_only: 0, gamma_shorts_only: 0 } }),
  )
  assert.ok(!note(off.notes, /shorts only/i), JSON.stringify(off.notes))
  assert.ok(note(off.notes, /whole book/i))
})

test('hedge_after_shift reads as Python reads it, including 0 and absent', () => {
  const armed = { marginUsed: 7_200_000 }
  const zero = reliefTriggers(state({ ...armed, dials: { ...RELIEF_DIALS, hedge_after_shift: 0 } }))
  assert.ok(note(zero.notes, /does NOT also hedge/i), JSON.stringify(zero.notes))
  // playbooks.py:3979 defaults it to TRUE when absent — an absent dial hedges,
  // so claiming the delta phase is skipped would be a lie about a live book.
  const { hedge_after_shift: _drop, ...absent } = RELIEF_DIALS
  const gone = reliefTriggers(state({ ...armed, dials: absent }))
  assert.ok(!note(gone.notes, /does NOT also hedge/i), JSON.stringify(gone.notes))
  const one = reliefTriggers(state({ ...armed, dials: { ...RELIEF_DIALS, hedge_after_shift: 1 } }))
  assert.ok(!note(one.notes, /does NOT also hedge/i), JSON.stringify(one.notes))
})

test('on a -free arm there is no one-lot floor to caveat about', () => {
  // The registry points -b1/-b2/-free at this same playbook (playbooks.py:5397-
  // 5399; DEFAULTS spread at :558-560). `no_band_floor` removes the under-one-
  // lot guard outright — :4073 reads `if not (mbl > 0 or free)` — so the
  // tolerance test IS the whole test, and repeating the one-lot caveat would
  // describe a rule this book does not run.
  const t = reliefTriggers(state({ dials: { ...RELIEF_DIALS, no_band_floor: true } }))
  assert.equal(t.wouldRebalance, true)
  assert.ok(!note(t.notes, /one lot/i), JSON.stringify(t.notes))
  assert.ok(note(t.notes, /no_band_floor|no under-one-lot floor/i), JSON.stringify(t.notes))
})

test('on a -b arm the band is clamped, so "past tolerance" is not a verdict', () => {
  // playbooks.py:4015 — `allowed = max(measured, min_band_lots x lot_size)`. The
  // clamp only ever WIDENS the band, and the lot size is not in this state, so a
  // delta past the tolerance may still be inside the clamped band. Unknowable
  // here, and a card must not promise a shed it cannot verify.
  const past = reliefTriggers(state({ dials: { ...RELIEF_DIALS, min_band_lots: 4 } }))
  assert.equal(past.wouldRebalance, null)
  assert.ok(note(past.notes, /4 lot|clamp/i), JSON.stringify(past.notes))
  assert.ok(!note(past.notes, /one lot/i), JSON.stringify(past.notes))

  // The other direction IS knowable: inside the measured tolerance is inside a
  // band that can only be wider.
  const inside = reliefTriggers(
    state({ steering: { delta: 100, gamma: -5.62 }, dials: { ...RELIEF_DIALS, min_band_lots: 4 } }),
  )
  assert.equal(inside.wouldRebalance, false)
})

test('the whole-book pair is over the band too — but the bot held', () => {
  // The same book, net of its two long legs (playbooks.py:439): netΓ -3.04,
  // netΔ +422, allowance 141. 422 > 141, so the tolerance test PASSES the mark
  // through — and the bot still did nothing, because the under-one-lot floor at
  // :4073-4084 refuses an allowance thinner than one lot (225 here) with "no
  // convexity to centre". This card cannot see the lot size, so it must say the
  // firing is conditional rather than promise a sale.
  const t = reliefTriggers(state({ steering: { delta: 422, gamma: -3.04 } }))
  assert.equal(t.wouldRebalance, true)
  assert.ok(note(t.notes, /one lot|convexity/i), JSON.stringify(t.notes))
})

test('inside the band, nothing happens', () => {
  // 100 / (5.62 x 2335) = 0.76% of spot — inside the 2% tolerance, so
  // `excess <= 0` (playbooks.py:4085) and the mark holds.
  const t = reliefTriggers(state({ steering: { delta: 100, gamma: -5.62 } }))
  assert.equal(t.wouldRebalance, false)
  assert.ok(note(t.notes, /inside/i), JSON.stringify(t.notes))
})

test('netGamma exactly zero holds the delta phase whatever the delta is', () => {
  // allowed = 0 (playbooks.py:4014), so the under-one-lot floor at :4073 always
  // bites; and on the arms that remove that floor, :4017-4027 hard-codes the
  // same hold ("the sim's missing-mark zero-fill, not a thin book"). Every
  // configuration holds — and the ratio is a division by zero, which is a
  // number this card must not print.
  const t = reliefTriggers(state({ steering: { delta: 900, gamma: 0 } }))
  assert.equal(t.deltaImbalance, null)
  assert.equal(t.wouldRebalance, false)
  assert.ok(note(t.notes, /convexity|zero/i), JSON.stringify(t.notes))
})

test('no steering greeks, no verdict', () => {
  const t = reliefTriggers(state({ steering: null }))
  assert.equal(t.deltaImbalance, null)
  assert.equal(t.wouldRebalance, null)
  assert.ok(note(t.notes, /steering/i))
})

test('no spot, no band — the band is a fraction OF spot', () => {
  const t = reliefTriggers(state({ spot: null }))
  assert.equal(t.deltaImbalance, null)
  assert.equal(t.wouldRebalance, null)
  assert.ok(note(t.notes, /spot/i))
})

// ------------------------------------------------------------------- target

test('the target is echoed and named as the hard rule it is', () => {
  // engine.py:453-457 — the one hard rule: the moment total P&L (realised +
  // open mark) reaches target_pnl the engine flattens EVERYTHING and banks it.
  const t = reliefTriggers(state())
  assert.equal(t.targetPnl, 250_000)
  const n = note(t.notes, /target/i)
  assert.ok(n, JSON.stringify(t.notes))
  assert.match(n, /2,50,000/)
})

// -------------------------------------------------------------- fail-soft

test('an empty state answers nulls and never throws', () => {
  const t = reliefTriggers({ steering: null, dials: {}, marginUsed: null })
  assert.deepEqual(
    {
      deltaTolPct: t.deltaTolPct,
      deltaImbalance: t.deltaImbalance,
      wouldRebalance: t.wouldRebalance,
      shiftEnabled: t.shiftEnabled,
      marginFrac: t.marginFrac,
      targetPnl: t.targetPnl,
    },
    {
      deltaTolPct: null,
      deltaImbalance: null,
      wouldRebalance: null,
      // No `shift_margin_frac` dial is no gate (playbooks.py:3910 defaults it to
      // 0.0), which is "shifts whenever a short is deep enough".
      shiftEnabled: true,
      marginFrac: null,
      targetPnl: null,
    },
  )
  assert.ok(t.notes.length > 0)
})

test('rubbish in the dials is ignored, not coerced', () => {
  // `Record<string, number | boolean>` is the declared type, but this state is
  // assembled from Mongo at runtime. A `true` must never read as a 1% delta
  // tolerance, and a non-finite margin must not become a fraction.
  const t = reliefTriggers({
    steering: { delta: Number.NaN, gamma: 1 },
    dials: { delta_tol_pct: true, margin_cap: true, target_pnl: true, shift_margin_frac: 0.6 },
    marginUsed: Number.POSITIVE_INFINITY,
    spot: TCS_SPOT,
  })
  assert.equal(t.deltaTolPct, null)
  assert.equal(t.targetPnl, null)
  assert.equal(t.marginFrac, null)
  assert.equal(t.deltaImbalance, null)
  assert.equal(t.wouldRebalance, null)
})

test('a garbage state object is survivable', () => {
  // No state at all is different from a state whose dials happen to be empty:
  // the second is a book that declares no margin gate (and the bot really does
  // shift freely then), the first is a card with nothing to say.
  const t = reliefTriggers(null as unknown as ReliefState)
  assert.equal(t.marginFrac, null)
  assert.equal(t.deltaImbalance, null)
  assert.equal(t.shiftEnabled, null)
  assert.ok(Array.isArray(t.notes))
})
