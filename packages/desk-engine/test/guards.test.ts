/**
 * THE GUARD TIER — the streak that counts MARKS, and the trim that counts LOTS.
 *
 * Two things are worth stating before the assertions, because both are places a
 * plausible-looking port is wrong:
 *
 *  1. THE LOCK'S STREAK IS ANCHORED TO MARKS, AND THIS SUITE FEEDS IT TICKS.
 *     The engine evaluates on every tick; the confirmation streak advances only
 *     on `markCtx.isNewMark`. Ten evaluations inside one 5-minute mark must
 *     advance it ONCE, and the test below feeds exactly that. The defence being
 *     bought is on the record — TCS 2026-06-19, one 09:15 mark printed +17L on
 *     a book that was really −21L and the lock flattened 1,460 lots into the
 *     crash — and tick persistence is not an equivalent defence, because a
 *     phantom print persists perfectly well for five seconds (spec §7).
 *
 *  2. THE TRIM'S REFERENCE NUMBERS ARE PYTHON'S. The margin walk projects with
 *     SPAN-lite, and every figure in these tests came out of
 *     `sensibull_tools.sim.margin.portfolio_margin` in the Python desk's own
 *     venv, on the same book at spot 300 / 2026-08-21 / 2026-08-28 expiry:
 *
 *       Sell 10 × 290 PE @ 0.30 + Sell 4 × 310 CE @ 0.30 → 17,971.05
 *       … minus the PE                                   →  6,638.98
 *       … minus the CE                                   → 16,626.04
 *       … with the PE cut to 5 lots                      →  9,658.03
 *
 *     The PE is the worse short by |Δ/share| (0.30 vs 0.22), so it is the one
 *     the walk takes first — `engine.py:702-707` sorts by exactly that and
 *     nothing else.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  guardTier,
  shortLots,
  totalPnl,
  unprotectedLots,
  type ChainSnap,
  type Dials,
  type EngineInputs,
  type LegView,
  type MarkContext,
  type Quote,
  type RuleState,
} from '@algomaker/desk-engine'

const DATE = '2026-08-21'
const EXPIRY = '2026-08-28'
const NOW = 1_755_000_000_000

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })

let seq = 0
function leg(over: Partial<LegView> = {}): LegView {
  seq += 1
  return {
    instrument: `LEG${seq}`,
    strike: 310,
    optType: 'CE',
    side: 'Sell',
    lots: 4,
    lotSize: 25,
    entry: 10,
    openedByEngine: true,
    // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
    leanId: '',
    iv: 0.3,
    delta: 0.22,
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

const chain: ChainSnap = {
  symbol: 'TEST',
  expiry: EXPIRY,
  step: 10,
  lotSize: 25,
  future: q(299.5, 300.5),
  spot: 300,
  strikes: [],
  asOf: NOW,
}

function inputsOf(legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: NOW,
    dateIst: DATE,
    minuteOfDay: 600,
    dte: 7,
    chain,
    legs,
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'broker', asOf: NOW, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
    ...over,
  }
}

const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })
const mark = (over: Partial<MarkContext> = {}): MarkContext => ({
  isNewMark: true,
  markIndexToday: 5,
  ...over,
})

// ── unprotectedLots: the one definition ─────────────────────────────────────

test('unprotectedLots nets the operator’s claim per instrument', () => {
  // The brief's case: 5 lots held, 2 claimed, 3 steerable.
  const l = leg({ lots: 5 })
  const [row] = unprotectedLots([l], { [l.instrument]: 2 })
  assert.ok(row !== undefined)
  assert.equal(row.steerableLots, 3)
  // …and the row is the LEG, so a caller reading strike/side/greeks off it does
  // not have to carry a parallel lookup.
  assert.equal(row.instrument, l.instrument)
  assert.equal(row.strike, l.strike)
  assert.equal(row.lots, 5, 'the HELD count is untouched — only `steerableLots` is derived')
})

test('a wholly claimed leg is not a candidate AT ALL', () => {
  // `K.unprotected` FILTERS (`conditions.py:87-96`). Returning it with zero
  // steerable lots would leave a later branch free to act on a leg the operator
  // owns outright.
  const l = leg({ lots: 4 })
  assert.deepEqual(unprotectedLots([l], { [l.instrument]: 4 }), [])
  assert.deepEqual(unprotectedLots([l], { [l.instrument]: 9 }), [], 'an over-claim CLAMPS')
})

test('a fractional claim rounds UP — no lot is ever half-spent', () => {
  const l = leg({ lots: 4 })
  assert.deepEqual(
    unprotectedLots([l], { [l.instrument]: 0.2 }).map((x) => x.steerableLots),
    [3],
  )
  assert.deepEqual(
    unprotectedLots([l], { [l.instrument]: 3.1 }).map((x) => x.steerableLots),
    [],
  )
})

test('an absent, zero or nonsense claim leaves the leg whole', () => {
  const l = leg({ lots: 4 })
  assert.deepEqual(unprotectedLots([l], {}).map((x) => x.steerableLots), [4])
  assert.deepEqual(unprotectedLots([l], { [l.instrument]: 0 }).map((x) => x.steerableLots), [4])
  assert.deepEqual(unprotectedLots([l], { [l.instrument]: -3 }).map((x) => x.steerableLots), [4])
  assert.deepEqual(
    unprotectedLots([l], { [l.instrument]: Number.NaN }).map((x) => x.steerableLots),
    [4],
  )
  assert.deepEqual(unprotectedLots([l], { OTHER: 4 }).map((x) => x.steerableLots), [4])
})

test('a leg holding nothing is not a candidate either', () => {
  assert.deepEqual(unprotectedLots([leg({ lots: 0 })], {}), [])
  assert.deepEqual(unprotectedLots([leg({ lots: 0.5 })], {}), [], 'a sub-lot holding truncates')
})

// ── the two measurements ────────────────────────────────────────────────────

test('totalPnl is banked plus the open mark, and the mark is the EXIT side', () => {
  // `K.total_pnl` (`conditions.py:191-199`). `LegView.mtm` is already the
  // exit-side figure in live pricing (`marking.ts`), which is the whole point of
  // the two-sided port: Python marked at mid and the lock fired on money that
  // was never there (`types.ts` §1).
  const inputs = inputsOf([leg({ mtm: 12_000 }), leg({ mtm: -4_000 })], { cumRealized: 90_000 })
  assert.equal(totalPnl(inputs), 98_000)
  assert.equal(totalPnl(inputsOf([], { cumRealized: 7 })), 7)
})

test('shortLots counts PROTECTED shorts too — it measures, it does not spend', () => {
  // `conditions.py:105-113` walks every short. A count that skipped the
  // operator's legs would report a smaller naked position than the desk holds.
  const a = leg({ side: 'Sell', lots: 4 })
  const b = leg({ side: 'Sell', lots: 6 })
  const c = leg({ side: 'Buy', lots: 3 })
  assert.equal(shortLots([a, b, c]), 10)
})

// ── the target lock ─────────────────────────────────────────────────────────

const banking = () => [leg({ mtm: 300_000, lots: 4 })]
const lockDials = (over: Partial<Dials> = {}) =>
  dialsOf({ target_pnl: 250_000, target_confirm_marks: 3, margin_cap: 0, ...over })

test('THE LOCK FIRES ON THE THIRD MARK, AND TEN TICKS INSIDE ONE MARK ARE ONE MARK', () => {
  const inputs = inputsOf(banking())
  const dials = lockDials()
  let state: RuleState = EMPTY_RULE_STATE

  for (let m = 1; m <= 3; m += 1) {
    // The mark's own tick, then nine more inside the same 5-minute window.
    const first = guardTier(inputs, dials, state, mark({ isNewMark: true }))
    state = first.stateAfter
    assert.equal(state.targetStreak, m, `mark ${m}: the streak advances once`)

    if (m < 3) {
      assert.equal(first.decision?.action, 'hold')
      assert.match(first.decision?.reason ?? '', new RegExp(`confirming ${m}/3`))
    }

    for (let tick = 0; tick < 9; tick += 1) {
      const inside = guardTier(inputs, dials, state, mark({ isNewMark: false }))
      assert.equal(
        inside.stateAfter.targetStreak,
        m,
        `mark ${m}, tick ${tick}: a tick inside a counted mark must not advance the streak`,
      )
      if (m < 3) assert.equal(inside.decision?.action, 'hold')
    }

    if (m === 3) {
      assert.equal(first.decision?.action, 'flatten')
      assert.equal(first.decision?.trigger, 'lock')
      assert.match(first.decision?.reason ?? '', /TARGET locked/)
      assert.equal(state.targetLocked, true)
    }
  }
  // 30 evaluations, 3 marks, one flatten.
})

test('the flatten takes EVERY leg, including the operator’s', () => {
  // `engine.py:439-443`: the protected flag exempts a leg from the routine
  // shift/close the rules pick victims for; it does not survive the desk's ONE
  // hard rule. A lock that left a leg behind would report the book flat while
  // it was not.
  const a = leg({ mtm: 300_000 })
  const b = leg({ mtm: 0, strike: 290, optType: 'PE' })
  const inputs = inputsOf([a, b], { protectedQty: { [b.instrument]: 4 } })
  const out = guardTier(inputs, lockDials({ target_confirm_marks: 1 }), EMPTY_RULE_STATE, mark())
  assert.equal(out.decision?.action, 'flatten')
  assert.deepEqual(out.decision?.actions, [
    { op: 'close', instrument: a.instrument },
    { op: 'close', instrument: b.instrument },
  ])
})

test('a DIP under target disarms the streak, and only on a mark', () => {
  const dials = lockDials()
  const over = inputsOf(banking())
  const under = inputsOf([leg({ mtm: 100_000 })])

  let state = guardTier(over, dials, EMPTY_RULE_STATE, mark()).stateAfter
  state = guardTier(over, dials, state, mark()).stateAfter
  assert.equal(state.targetStreak, 2)

  // A tick that dips inside a mark already counted must NOT erase it.
  assert.equal(guardTier(under, dials, state, mark({ isNewMark: false })).stateAfter.targetStreak, 2)
  // The next MARK under target does.
  assert.equal(guardTier(under, dials, state, mark({ isNewMark: true })).stateAfter.targetStreak, 0)
})

test('the lock is TERMINAL: a banked book holds flat and never redeploys', () => {
  const locked: RuleState = { ...EMPTY_RULE_STATE, targetLocked: true }
  const out = guardTier(inputsOf(banking()), lockDials(), locked, mark())
  assert.equal(out.decision?.action, 'hold')
  assert.equal(out.decision?.trigger, 'lock')
  assert.equal(out.decision?.reason, 'target banked — staying flat')
  assert.deepEqual(out.stateAfter, locked)
})

test('an empty book or target_pnl 0 has no lock to fire', () => {
  assert.equal(guardTier(inputsOf([]), lockDials(), EMPTY_RULE_STATE, mark()).decision, null)
  assert.equal(
    guardTier(inputsOf(banking()), lockDials({ target_pnl: 0 }), EMPTY_RULE_STATE, mark()).decision,
    null,
  )
})

test('target_snap_multiple banks IMMEDIATELY, with no streak at all', () => {
  // `engine.py:517-526`. Off by default (0); at 2 a mark printing 2× target
  // bypasses the confirmation gate outright.
  const dials = lockDials({ target_snap_multiple: 2 })
  const under = guardTier(inputsOf([leg({ mtm: 400_000 })]), dials, EMPTY_RULE_STATE, mark())
  assert.equal(under.decision?.action, 'hold', '400k is over target but under 2x — streak only')
  assert.equal(under.stateAfter.targetStreak, 1)

  const out = guardTier(inputsOf([leg({ mtm: 500_000 })]), dials, EMPTY_RULE_STATE, mark())
  assert.equal(out.decision?.action, 'flatten')
  assert.match(out.decision?.reason ?? '', /TARGET SNAP/)
  assert.equal(out.stateAfter.targetLocked, true)
  assert.equal(out.stateAfter.targetStreak, 0, 'the snap never touches the streak')
})

test('lock_exclude_mark0 holds the WHOLE pass on the run’s first mark', () => {
  // `engine.py:509-516`: mark 0 prices legs that have not traded yet — 33 of 147
  // sweep runs carry |m0| > Rs20,000 and the very next mark is exactly 0.0 in 30
  // of them. It can neither arm, count NOR snap, and Python holds rather than
  // letting a later tier act on the same fiction.
  const dials = lockDials({ lock_exclude_mark0: true, target_snap_multiple: 2 })
  const out = guardTier(
    inputsOf([leg({ mtm: 900_000 })]),
    dials,
    EMPTY_RULE_STATE,
    mark({ markIndexToday: 0 }),
  )
  assert.equal(out.decision?.action, 'hold')
  assert.match(out.decision?.reason ?? '', /entry mark/)
  assert.equal(out.stateAfter.targetStreak, 0)
  assert.equal(out.stateAfter.targetLocked, false)

  // Mark 1 of the same session is fully eligible — the exclusion is narrow.
  const next = guardTier(
    inputsOf([leg({ mtm: 900_000 })]),
    dials,
    EMPTY_RULE_STATE,
    mark({ markIndexToday: 1 }),
  )
  assert.equal(next.decision?.action, 'flatten')

  // And with the dial OFF, mark 0 snaps like any other mark.
  const off = guardTier(
    inputsOf([leg({ mtm: 900_000 })]),
    lockDials({ target_snap_multiple: 2 }),
    EMPTY_RULE_STATE,
    mark({ markIndexToday: 0 }),
  )
  assert.equal(off.decision?.action, 'flatten')
})

test('lock_executability suppresses the first two marks WITHOUT resetting the streak', () => {
  // Ported NARROWED — see `guards.ts` §3. Python additionally requires the
  // session to have gapped, and neither `lock_gap_pct` nor the cross-session
  // spot that detects one exists in this schema; the port keeps the
  // suppression, which fires on quiet mornings too.
  const dials = lockDials({ lock_executability: true })
  const inputs = inputsOf(banking())
  const armed: RuleState = { ...EMPTY_RULE_STATE, targetStreak: 2 }

  for (const idx of [0, 1]) {
    const out = guardTier(inputs, dials, armed, mark({ markIndexToday: idx }))
    assert.equal(out.decision?.action, 'hold')
    assert.match(out.decision?.reason ?? '', /executability/)
    assert.equal(out.stateAfter.targetStreak, 2, 'suppressed, NOT reset')
  }
  // The third mark of the session counts, and completes the streak.
  const out = guardTier(inputs, dials, armed, mark({ markIndexToday: 2 }))
  assert.equal(out.decision?.action, 'flatten')
})

test('lock_branch_lots orders the flatten GAMMA-FIRST, and still always banks', () => {
  // `engine.py:453-463`. The ratchet arm is deliberately not ported (§3): the
  // lock banks on every branch, and the dial buys the ordering. Book-scaled
  // gamma is the key, so a small per-share gamma on a big leg can still go first.
  const small = leg({ lots: 1, lotSize: 25, gamma: 0.02 }) // 0.02 × 25   = 0.5
  const big = leg({ lots: 10, lotSize: 25, gamma: 0.01, mtm: 300_000 }) // 0.01 × 250 = 2.5
  const inputs = inputsOf([small, big])

  const plain = guardTier(inputs, lockDials({ target_confirm_marks: 1 }), EMPTY_RULE_STATE, mark())
  assert.deepEqual(
    plain.decision?.actions.map((a) => (a.op === 'close' ? a.instrument : '')),
    [small.instrument, big.instrument],
    'off: book order',
  )

  const branched = guardTier(
    inputs,
    lockDials({ target_confirm_marks: 1, lock_branch_lots: 5 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(branched.decision?.action, 'flatten')
  assert.deepEqual(
    branched.decision?.actions.map((a) => (a.op === 'close' ? a.instrument : '')),
    [big.instrument, small.instrument],
    'on: the most convex leg leaves first',
  )
})

// ── the margin guard ────────────────────────────────────────────────────────

/** The reference book of the header: the PE is the worse short by |Δ/share|. */
function capBook() {
  const pe = leg({ strike: 290, optType: 'PE', side: 'Sell', lots: 10, delta: 0.3, iv: 0.3 })
  const ce = leg({ strike: 310, optType: 'CE', side: 'Sell', lots: 4, delta: 0.22, iv: 0.3 })
  return { pe, ce, legs: [pe, ce] }
}

const capDials = (cap: number) => dialsOf({ margin_cap: cap, target_pnl: 0 })

test('under the cap the guard says NOTHING', () => {
  const { legs } = capBook()
  const out = guardTier(
    inputsOf(legs, { margin: { value: 17_000, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(18_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.decision, null)
})

test('over the cap it trims the WORST short by |Δ/share| and stops when the projection clears', () => {
  // Book 17,971.05 > cap 18,000? No — the guard reads the BROKER figure, and
  // the projection is what it steers the trim by. margin 20,000 > cap 18,000
  // arms it; dropping the PE projects 6,638.98, comfortably under the
  // 0.95 x 18,000 = 17,100 target, so the walk stops after ONE leg.
  const { pe, legs } = capBook()
  const out = guardTier(
    inputsOf(legs, { margin: { value: 20_000, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(18_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.decision?.action, 'adjust')
  assert.equal(out.decision?.trigger, 'margin')
  assert.deepEqual(out.decision?.actions, [{ op: 'close', instrument: pe.instrument }])
  assert.match(out.decision?.reason ?? '', /trim 1 short leg/)
})

test('the walk keeps going, one whole leg at a time, until it clears', () => {
  const { pe, ce, legs } = capBook()
  const out = guardTier(
    inputsOf(legs, { margin: { value: 20_000, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(5_000), // 0.95 x 5,000 = 4,750; even 6,638.98 is over it
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.deepEqual(out.decision?.actions, [
    { op: 'close', instrument: pe.instrument },
    { op: 'close', instrument: ce.instrument },
  ])
  assert.match(out.decision?.reason ?? '', /trim 2 short leg/)
})

test('protected quantity is excluded AT SELECTION, so a partly-owned leg RESIZES', () => {
  // `engine.py:696-701`: the projection is built over the pool that can actually
  // be closed. With 5 of the PE's 10 lots the operator's, the walk cuts 5 and
  // projects 9,658.03 — under 17,100 — and the action is a resize to the tail.
  const { pe, legs } = capBook()
  const out = guardTier(
    inputsOf(legs, {
      margin: { value: 20_000, source: 'broker', asOf: NOW, fresh: true },
      protectedQty: { [pe.instrument]: 5 },
    }),
    capDials(18_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.deepEqual(out.decision?.actions, [
    { op: 'resize', instrument: pe.instrument, targetLots: 5 },
  ])
})

test('with every short PROTECTED the guard DECLINES rather than holding', () => {
  // Returning a hold would freeze this mark and every later one for as long as
  // the book stayed over its cap (`engine.py:708-722`). Declining lets the
  // playbook keep managing while the pre-trade projection blocks fresh sells.
  const { pe, ce, legs } = capBook()
  const out = guardTier(
    inputsOf(legs, {
      margin: { value: 20_000, source: 'broker', asOf: NOW, fresh: true },
      protectedQty: { [pe.instrument]: 10, [ce.instrument]: 4 },
    }),
    capDials(18_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.decision, null)
})

test('a book with no shorts, and an UNCAPPED book, have nothing to trim', () => {
  const long = leg({ side: 'Buy', lots: 4 })
  const over = { margin: { value: 20_000, source: 'broker' as const, asOf: NOW, fresh: true } }
  assert.equal(
    guardTier(inputsOf([long], over), capDials(18_000), EMPTY_RULE_STATE, mark()).decision,
    null,
  )
  // `margin_cap` 0 is UNCAPPED — the same off-state `shift.ts` reads, and what
  // stops a division by nothing.
  assert.equal(
    guardTier(inputsOf(capBook().legs, over), capDials(0), EMPTY_RULE_STATE, mark()).decision,
    null,
  )
})

test('the LOCK outranks the trim: a book both over target and over cap flattens', () => {
  const { legs } = capBook()
  const first = legs[0]
  assert.ok(first !== undefined)
  const inputs = inputsOf([{ ...first, mtm: 300_000 }, ...legs.slice(1)], {
    margin: { value: 20_000, source: 'broker', asOf: NOW, fresh: true },
  })
  const out = guardTier(
    { ...inputs },
    dialsOf({ target_pnl: 250_000, target_confirm_marks: 1, margin_cap: 18_000 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.decision?.action, 'flatten')
  assert.equal(out.decision?.trigger, 'lock')
})

// ── PORTED FROM PYTHON — the guard block of `test_sim_rules.py` and the
//    lock/trim half of `test_protected_legs.py`.

test('PORTED: THE TCS 2026-06-19 PHANTOM MARK, end to end', () => {
  // `test_engine_target_lock_ignores_one_mark_phantom_profit`, the case the
  // whole confirmation streak exists for: "a gap-open can mark stale legs at
  // the prior session's prices and print one mark of phantom profit — the lock
  // must NOT fire on it (+17L for one 09:15 mark on a book that was really
  // −21L)". Three phases, in Python's own order.
  const dials = lockDials()
  const phantom = inputsOf([leg({ mtm: 1_700_000 })])
  const corrected = inputsOf([leg({ mtm: -3_800_000 })])
  const genuine = inputsOf([leg({ mtm: 300_000 })])

  // 1. the phantom mark: over target, and the answer is a confirmation, not a
  //    flatten.
  let state = EMPTY_RULE_STATE
  const first = guardTier(phantom, dials, state, mark())
  assert.equal(first.decision?.action, 'hold')
  assert.match(first.decision?.reason ?? '', /confirming 1\/3/)
  state = first.stateAfter

  // 2. the next mark corrects hard negative: the streak DISARMS and nothing
  //    locked.
  const second = guardTier(corrected, dials, state, mark())
  assert.equal(second.decision, null)
  assert.equal(second.stateAfter.targetStreak, 0)
  assert.equal(second.stateAfter.targetLocked, false)
  state = second.stateAfter

  // 3. a GENUINE sustained breach still locks, after the full streak.
  for (const n of [1, 2]) {
    const step = guardTier(genuine, dials, state, mark())
    assert.match(step.decision?.reason ?? '', new RegExp(`confirming ${n}/3`))
    state = step.stateAfter
  }
  const locked = guardTier(genuine, dials, state, mark())
  assert.equal(locked.decision?.action, 'flatten')
  assert.match(locked.decision?.reason ?? '', /TARGET locked/)
})

test('PORTED: the streak counts 1/3, 2/3, then locks — in those words', () => {
  // `test_engine_bare_rule_engine_now_counts_confirm_streak`. The wording is
  // what an operator reads on the dashboard while a book is a mark away from
  // banking, so it is asserted rather than paraphrased.
  const dials = lockDials()
  let state = EMPTY_RULE_STATE
  const seen: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const out = guardTier(inputsOf(banking()), dials, state, mark())
    seen.push(out.decision?.reason ?? '')
    state = out.stateAfter
  }
  assert.match(seen[0] ?? '', /confirming 1\/3/)
  assert.match(seen[1] ?? '', /confirming 2\/3/)
  assert.match(seen[2] ?? '', /TARGET locked/)
})

test('PORTED: the lock reads REALIZED + open mark, and below target says nothing', () => {
  // `test_engine_hard_target_lock_flattens_and_banks`: mtm +120,000 with
  // +40,000 already banked is +160,000 against a +150,000 target. Reading only
  // the open mark would leave a book that has ALREADY made its number running.
  const dials = lockDials({ target_pnl: 150_000, target_confirm_marks: 1 })
  const a = leg({ mtm: 120_000 })
  const b = leg({ mtm: 0, optType: 'PE', strike: 290 })
  const over = guardTier(
    inputsOf([a, b], { cumRealized: 40_000 }),
    dials,
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(over.decision?.action, 'flatten')
  assert.deepEqual(
    over.decision?.actions.map((x) => (x.op === 'close' ? x.instrument : '')).sort(),
    [a.instrument, b.instrument].sort(),
  )

  const under = guardTier(
    inputsOf([leg({ mtm: 100_000 })], { cumRealized: 0 }),
    dials,
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(under.decision, null, 'nothing to say under target')
})

test('PORTED: the lock is terminal — a banked run NEVER redeploys, even flat', () => {
  // `test_engine_target_lock_is_terminal_never_redeploys`, on the reload-happy
  // variant: next mark, flat book, +200,000 banked, and the answer must still be
  // a hold rather than a fresh sale.
  const locked: RuleState = { ...EMPTY_RULE_STATE, targetLocked: true }
  const out = guardTier(
    inputsOf([], { cumRealized: 200_000 }),
    lockDials(),
    locked,
    mark(),
  )
  assert.equal(out.decision?.action, 'hold')
  assert.deepEqual(out.decision?.actions, [])
  assert.match(out.decision?.reason ?? '', /target banked/)
})

test('PORTED: a book of ONLY protected legs still locks and flattens', () => {
  // `test_protected_legs.py:test_a_book_of_ONLY_protected_legs_still_locks_and_flattens`
  // — the case that used to DECLINE. Routine selection never touches a protected
  // leg; a terminal exit always does.
  const a = leg({ mtm: 300_000 })
  const b = leg({ mtm: 0, optType: 'PE', strike: 290 })
  const out = guardTier(
    inputsOf([a, b], { protectedQty: { [a.instrument]: 4, [b.instrument]: 4 } }),
    lockDials({ target_confirm_marks: 1 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.decision?.action, 'flatten')
  assert.equal(out.decision?.actions.length, 2)
})

test('PORTED: EXACTLY at the cap the margin guard does not fire — `>`, never `>=`', () => {
  // `test_margin_guard_exactly_at_cap_does_not_fire`.
  const { legs } = capBook()
  const at = guardTier(
    inputsOf(legs, { margin: { value: 18_000, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(18_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(at.decision, null)

  const over = guardTier(
    inputsOf(legs, { margin: { value: 18_001, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(18_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(over.decision?.trigger, 'margin')
})

test('PORTED: a target-locked book SHORT-CIRCUITS the margin guard entirely', () => {
  // `test_margin_guard_target_locked_short_circuits`: margin ₹1cr against a ₹1
  // cap, and the answer is still "target banked — staying flat". The terminal
  // read comes first, so a banked book is never churned by a later tier.
  const { legs } = capBook()
  const out = guardTier(
    inputsOf(legs, { margin: { value: 1e9, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(1),
    { ...EMPTY_RULE_STATE, targetLocked: true },
    mark(),
  )
  assert.equal(out.decision?.action, 'hold')
  assert.match(out.decision?.reason ?? '', /target banked/)
})

test('PORTED: the flag is read for TRUTHINESS — a quantity, and a claim of nothing', () => {
  // `test_protected_legs.py:test_the_flag_is_read_for_TRUTHINESS_not_identity`.
  // Python's flag arrives off a JSON rail as 1/0 as readily as True/False; this
  // engine's counterpart is a QUANTITY, so the equivalent question is what a
  // zero, a negative and an absent claim mean. All three mean "not mine".
  const l = leg({ lots: 4 })
  for (const claim of [0, -1, Number.NaN]) {
    assert.deepEqual(
      unprotectedLots([l], { [l.instrument]: claim }).map((x) => x.steerableLots),
      [4],
      `claim ${claim}`,
    )
  }
  assert.deepEqual(unprotectedLots([l], { [l.instrument]: 1 }).map((x) => x.steerableLots), [3])
})

// ── the review's IMP-2: the broker triggers, the MODEL steers ───────────────

test('THE BHEL-SHAPED CASE: a broker figure over cap with the model inside it trims NOTHING', () => {
  // `guards.ts` §4b. The trigger reads `inputs.margin.value` — a BROKER number —
  // and the remedy is steered by SPAN-lite, and spec §6 records how far apart
  // those two get: 20.8L model against 42.9L broker on BHEL-2026-08-25, a factor
  // of 2.06 on the quantity the cap is a ceiling for.
  //
  // This book's model margin is 17,971.05 — 18% of a 100,000 cap — while the
  // broker says 250,000. Without the pre-check the walk is entered on the broker
  // read and removes a whole 10-lot leg before it measures anything, then prints
  // a projection that was true BEFORE the trim.
  const { legs } = capBook()
  const out = guardTier(
    inputsOf(legs, { margin: { value: 250_000, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(100_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.decision, null, 'declines — and declining can only ever trim LESS')
})

test('the trim’s reason says which figure is the broker’s and which is the model’s', () => {
  // A ledger row carrying a rupee figure with no provenance is how a SPAN-lite
  // estimate comes to be read as a broker number six months later.
  const { legs } = capBook()
  const out = guardTier(
    inputsOf(legs, { margin: { value: 20_000, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(18_000),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.decision?.trigger, 'margin')
  assert.match(out.decision?.reason ?? '', /margin Rs20,000 \(broker\)/)
  assert.match(out.decision?.reason ?? '', /projects Rs6,639 \(model\)/)
})

test('the pre-check measures the WHOLE book — a genuine breach still walks', () => {
  // The guard is not switched off by the pre-check: the same book at a cap the
  // MODEL is also over still trims, and stops the moment the projection clears.
  const { pe, legs } = capBook()
  const out = guardTier(
    inputsOf(legs, { margin: { value: 20_000, source: 'broker', asOf: NOW, fresh: true } }),
    capDials(18_000), // 0.95 x 18,000 = 17,100 < the book's own 17,971.05
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.deepEqual(out.decision?.actions, [{ op: 'close', instrument: pe.instrument }])
})
