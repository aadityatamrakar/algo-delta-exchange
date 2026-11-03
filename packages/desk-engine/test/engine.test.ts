/**
 * `decide()` — THE ORDER, AND WHAT EACH GATE COSTS TO GET WRONG.
 *
 * The parity suite already proves the two PHASES answer a Python board mark for
 * mark, through this same function. What it cannot prove is the ORDER, because
 * the recorded fixtures never reach a guard, a settle or a working-package hold
 * — 1,152 marks, and none of them is over target, over cap, at the last mark of
 * expiry day, or carrying a pending package. So the order is what this file is
 * for, and every test here is a mark the fixtures do not contain.
 *
 * The shed book is `shed.test.ts`'s, unchanged, because the point of these
 * tests is what happens AROUND phase R rather than inside it: one short PE,
 * 4 lots of 25, per-share δ 0.9 and Γ 0.1 →
 *
 *   netΔ = +90, netΓ = −10, allowed = 10 × 0.02 × 300 = 60, excess = 30
 *
 * which sells 104 lots of the 330 CE (the furthest, finest candidate). Any test
 * below that ends in that package is a test that reached phase R; any test that
 * does not is a test that a gate stopped first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  RISK_FREE,
  corridor,
  decide,
  phaseShift,
  rollForward,
  scrapKey,
  shedTrigger,
  type ChainSnap,
  type Dials,
  type EngineAction,
  type EngineInputs,
  type LegView,
  type MarkContext,
  type OptType,
  type Quote,
  type RuleState,
} from '@algomaker/desk-engine'
import { b76Price } from '@algomaker/greeks'

const DATE = '2026-08-21' // a Friday
const SUNDAY = '2026-08-23'
const HOLIDAY = '2026-12-25' // Christmas, in `MARKET_HOLIDAYS_2026`
const EXPIRY = '2026-08-28'
const MINUTE = 600 // 10:00 IST
const T7 = 7 / 365
const VOL = 0.3
const NOW = 1_755_000_000_000

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })

function bookAt(spot: number, strike: number, type: OptType): Quote {
  const px = b76Price({ future: spot, strike, t: T7, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.98, px * 1.02)
}

const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * 10)

function chainOf(spot = 300): ChainSnap {
  return {
    symbol: 'TEST',
    expiry: EXPIRY,
    step: 10,
    lotSize: 25,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: LADDER.map((k) => ({ strike: k, ce: bookAt(spot, k, 'CE'), pe: bookAt(spot, k, 'PE') })),
    asOf: NOW,
  }
}

let seq = 0
function leg(over: Partial<LegView> = {}): LegView {
  seq += 1
  return {
    instrument: `LEG${seq}`,
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

function inputsOf(legs: LegView[], over: Partial<EngineInputs> = {}): EngineInputs {
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: NOW,
    dateIst: DATE,
    minuteOfDay: MINUTE,
    dte: 7,
    chain: chainOf(),
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

/** `margin_cap: 0` unless a test is ABOUT the cap: `DEFAULT_DIALS` carries the
 * ₹10cr relief-r figure, and a book this small never comes near it. */
const dialsOf = (over: Partial<Dials> = {}): Dials => ({
  ...DEFAULT_DIALS,
  shift_enabled: false,
  margin_cap: 0,
  ...over,
})

const mark = (over: Partial<MarkContext> = {}): MarkContext => ({
  isNewMark: true,
  markIndexToday: 5,
  ...over,
})

/** The book of the header: sheds 104 lots of the 330 CE. */
const shedBook = () => [leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 25, delta: 0.9, gamma: 0.1 })]
const THE_SHED: EngineAction = { op: 'open', strike: 330, optType: 'CE', side: 'Sell', lots: 104, add: true }

test('the baseline: an ordinary mark reaches phase R and sheds', () => {
  const out = decide(inputsOf(shedBook()), dialsOf(), EMPTY_RULE_STATE, mark())
  assert.equal(out.action, 'adjust')
  assert.equal(out.trigger, 'shed')
  assert.deepEqual(out.actions, [THE_SHED])
  assert.equal(out.creditCommit, null)
  // The chain would take this sale at the touch: nothing to quote.
  assert.equal(out.makerQuote, false)
})

// ── the liquidity gate's refusal, carried out to the supervisor ─────────────

test('a package the chain would not CROSS is reported as a maker quote', () => {
  /**
   * `shed.ts` §4: gate failure never becomes a silent hold — the phase sizes the
   * sale it wanted and says the market would not take it. Until this flag
   * existed the supervisor could not tell that package from an ordinary one and
   * routed it into exactly the book the gate refused (spec §8).
   *
   * The books below are widened SYMMETRICALLY around the same model price, so
   * every mid — and therefore every greek, and therefore the whole package — is
   * identical to the baseline above. The only thing that changed is whether the
   * desk is willing to cross it.
   */
  const wide = chainOf()
  const widen = (quote: Quote | null): Quote | null => {
    if (quote === null || quote.bid === null || quote.ask === null) return quote
    const mid = (quote.bid + quote.ask) / 2
    return { ...quote, bid: mid * 0.5, ask: mid * 1.5 }
  }
  const chain: ChainSnap = {
    ...wide,
    strikes: wide.strikes.map((row) => ({ ...row, ce: widen(row.ce) })),
  }

  const out = decide(inputsOf(shedBook(), { chain }), dialsOf(), EMPTY_RULE_STATE, mark())
  assert.equal(out.action, 'adjust')
  // THE SAME PACKAGE, not a smaller one and not a hold.
  assert.deepEqual(out.actions, [THE_SHED])
  assert.equal(out.makerQuote, true)
})

test('a GUARD exit is never a maker quote, however wide the book', () => {
  // An urgency exit crosses whatever is there (spec §8). `sell_max_spread_pct`
  // governs what phase R may SELL into, never whether a decided exit may leave —
  // a target lock that waited for a tighter book is the desk's one hard rule,
  // deferred.
  const out = decide(
    inputsOf(shedBook(), { cumRealized: 10_000_000 }),
    dialsOf({ target_pnl: 1000, target_confirm_marks: 1, target_snap_multiple: 1 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.trigger, 'lock')
  assert.equal(out.makerQuote, false)
})

// ── 0. the expiry settle, which beats everything ────────────────────────────

test('THE EXPIRY SETTLE BEATS A REPAIR HOLD, A WORKING PACKAGE AND THE GUARDS', () => {
  // `driver.py:30-37`: once the contract's expiry passes it leaves the master
  // and can never be closed again by ANY means, "including a manual close-all".
  // A hold lasts seconds and expires on its own; a missed settle is permanent.
  // So every one of these — each of which stops the pass on its own — is
  // overruled on the last mark of expiry day.
  const book = shedBook()
  const first = book[0]
  assert.ok(first !== undefined)
  const out = decide(
    inputsOf(book, {
      dte: 0,
      minuteOfDay: 930,
      repairHold: true,
      pendingLots: 50,
      margin: { value: 99_000_000, source: 'broker', asOf: NOW, fresh: true },
    }),
    dialsOf({ margin_cap: 1_000_000, target_pnl: 250_000 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.action, 'flatten')
  assert.equal(out.trigger, 'expiry')
  assert.deepEqual(out.actions, [{ op: 'close', instrument: first.instrument }])
  assert.match(out.reason, /expiry settle/)

  // The SAME inputs one day before expiry: the repair hold is what speaks, which
  // is the evidence that the settle was doing the overruling.
  const notYet = decide(
    inputsOf(book, { dte: 1, minuteOfDay: 930, repairHold: true }),
    dialsOf(),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(notYet.action, 'hold')
  assert.match(notYet.reason, /repair-Apply/)
})

test('the settle is the LAST MARK of expiry day, not the whole of it', () => {
  // `session.py:97-109` (`is_final_mark`). Settling at 09:20 would flatten a
  // 0-DTE book at the open and delete the one session the corridor is entirely
  // delta and gamma — the day `marking.yearFrac` refines its tenor intraday
  // specifically so the greeks stay alive.
  const morning = decide(
    inputsOf(shedBook(), { dte: 0, minuteOfDay: 560 }),
    dialsOf(),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.notEqual(morning.trigger, 'expiry')
  // (dte 0 is under `min_sell_dte`, so phase R holds rather than selling — but
  // it is phase R holding, not a settle.)
  assert.equal(morning.action, 'hold')

  for (const minute of [925, 929]) {
    assert.notEqual(
      decide(inputsOf(shedBook(), { dte: 0, minuteOfDay: minute }), dialsOf(), EMPTY_RULE_STATE, mark())
        .trigger,
      'expiry',
      `${minute} is not the last mark`,
    )
  }
  // At the close and past it — a tick-driven supervisor must not miss the window
  // by landing a second late.
  for (const minute of [930, 935]) {
    assert.equal(
      decide(inputsOf(shedBook(), { dte: 0, minuteOfDay: minute }), dialsOf(), EMPTY_RULE_STATE, mark())
        .trigger,
      'expiry',
    )
  }
})

test('an already-flat book has nothing to settle', () => {
  const out = decide(inputsOf([], { dte: 0, minuteOfDay: 930 }), dialsOf(), EMPTY_RULE_STATE, mark())
  assert.notEqual(out.trigger, 'expiry')
  assert.equal(out.action, 'hold')
})

// ── 1. the session gate ─────────────────────────────────────────────────────

test('the rules do not run on a weekend or an NSE holiday', () => {
  for (const date of [SUNDAY, HOLIDAY]) {
    const out = decide(inputsOf(shedBook(), { dateIst: date }), dialsOf(), EMPTY_RULE_STATE, mark())
    assert.equal(out.action, 'hold')
    assert.match(out.reason, /not an NSE trading day/)
  }
})

test('09:20 is the first minute the rules may act, and 15:30 is the last', () => {
  // `engine.py:894-900`, user-directed 2026-08-03: the 09:15 option prints move
  // too much to trade on, and no streak advances there either.
  const early = decide(inputsOf(shedBook(), { minuteOfDay: 559 }), dialsOf(), EMPTY_RULE_STATE, mark())
  assert.equal(early.action, 'hold')
  assert.match(early.reason, /09:19 mark skipped — the rules start at 09:20/)

  assert.equal(
    decide(inputsOf(shedBook(), { minuteOfDay: 560 }), dialsOf(), EMPTY_RULE_STATE, mark()).action,
    'adjust',
  )
  // INCLUSIVE at the close: the 15:30 mark is a real mark the desk journals and
  // trades — 12 of the recorded fixture marks sit on it and all 12 are adjusts.
  assert.equal(
    decide(inputsOf(shedBook(), { minuteOfDay: 930 }), dialsOf(), EMPTY_RULE_STATE, mark()).action,
    'adjust',
  )
  const late = decide(inputsOf(shedBook(), { minuteOfDay: 931 }), dialsOf(), EMPTY_RULE_STATE, mark())
  assert.equal(late.action, 'hold')
  assert.match(late.reason, /15:31 is past 15:30, where the desk's decisions end/)
})

// ── 2/3/4. repair hold, guards, working package ─────────────────────────────

test('a repair hold stands the whole action pass down', () => {
  const out = decide(inputsOf(shedBook(), { repairHold: true }), dialsOf(), EMPTY_RULE_STATE, mark())
  assert.equal(out.action, 'hold')
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /repair-Apply/)
})

test('A GUARD PREEMPTS A WORKING PACKAGE — that is why it is read first', () => {
  // Spec §8: "guards always preempt working orders". The lock is over target on
  // a book with 50 lots still being worked, and it flattens rather than waiting.
  const book = [leg({ mtm: 300_000, lots: 4 })]
  const out = decide(
    inputsOf(book, { pendingLots: 50 }),
    dialsOf({ target_pnl: 250_000, target_confirm_marks: 1 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(out.action, 'flatten')
  assert.equal(out.trigger, 'lock')
})

test('a working package suppresses the PLAYBOOK, and the scrap tier with it', () => {
  // `engine.py:904-918`: the pending check is read BEFORE the scrap tier, so a
  // paise short is bought back when the queue is clear and not on top of a
  // package already in flight.
  const spent = leg({ side: 'Sell', optType: 'PE', lots: 4, delta: 0.9, gamma: 0.1, exit: q(0.05, 0.07) })
  const dials = dialsOf({ scrap_close_px: 0.1 })

  const busy = decide(inputsOf([spent], { pendingLots: 12 }), dials, EMPTY_RULE_STATE, mark())
  assert.equal(busy.action, 'hold')
  assert.match(busy.reason, /working package: 12 lots/)
  assert.deepEqual(busy.stateAfter.scrapBanned, [], 'no ban is written for a scrap that did not happen')

  const clear = decide(inputsOf([spent]), dials, EMPTY_RULE_STATE, mark())
  assert.equal(clear.trigger, 'scrap')
})

// ── 5. the scrap tier, ahead of the phases ──────────────────────────────────

test('a spent short is bought back BEFORE the playbook forms a new package', () => {
  // The same book that would otherwise shed 104 lots of the 330 CE.
  const spent = leg({ side: 'Sell', optType: 'PE', lots: 4, delta: 0.9, gamma: 0.1, exit: q(0.05, 0.07) })
  const out = decide(inputsOf([spent]), dialsOf({ scrap_close_px: 0.1 }), EMPTY_RULE_STATE, mark())
  assert.equal(out.action, 'adjust')
  assert.equal(out.trigger, 'scrap')
  assert.deepEqual(out.actions, [{ op: 'close', instrument: spent.instrument }])
  assert.deepEqual(out.stateAfter.scrapBanned, [scrapKey(300, 'PE', EXPIRY)])
})

test('THE BAN THEN STRIPS THE RE-SELL: scrap on one mark, gate on the next', () => {
  // The two halves of the 2026-07-21 directive, end to end through `decide`.
  // Mark 1 scraps the 330 CE and bans it; mark 2's phase R picks that exact
  // strike again and the sell gate takes it out.
  const spent = leg({ side: 'Sell', optType: 'CE', strike: 330, lots: 1, exit: q(0.05, 0.07), delta: 0.0115 })
  const steering = leg({ side: 'Sell', optType: 'PE', lots: 4, lotSize: 25, delta: 0.9, gamma: 0.1 })
  const dials = dialsOf({ scrap_close_px: 0.1 })

  const first = decide(inputsOf([spent, steering]), dials, EMPTY_RULE_STATE, mark())
  assert.equal(first.trigger, 'scrap')
  assert.deepEqual(first.stateAfter.scrapBanned, [scrapKey(330, 'CE', EXPIRY)])

  // Mark 2, the spent leg gone, the ban carried forward.
  const second = decide(inputsOf([steering]), dials, first.stateAfter, mark())
  assert.equal(second.action, 'hold', 'the shed was all sells and every one of them was banned')
  assert.match(second.reason, /scrap gate: nothing worth selling/)
  assert.match(second.reason, /330CE \(scrap-banned\)/)

  // …and without the ban, the very same mark sells.
  const unbanned = decide(inputsOf([steering]), dials, EMPTY_RULE_STATE, mark())
  assert.deepEqual(unbanned.actions, [THE_SHED])
})

// ── 6/7. the two phases and the roll-forward ────────────────────────────────

test('`hedge_after_shift` false returns on the shift alone', () => {
  // `playbooks.py:4021-4027`: a mark that just shifted has already moved the
  // book's delta by moving its strikes, and hedging the same mark is a second
  // adjustment against one move.
  const itm = leg({ side: 'Sell', optType: 'CE', strike: 280, lots: 4, delta: 0.7, gamma: 0.02 })
  const dials = dialsOf({
    shift_enabled: true,
    shift_itm_steps: 0.5,
    shift_land_steps: 2,
    shift_margin_frac: 0,
    hedge_after_shift: false,
  })
  const out = decide(inputsOf([itm]), dials, EMPTY_RULE_STATE, mark())
  assert.equal(out.trigger, 'shift')
  assert.match(out.reason, /^shift: 1 ITM short\(s\) re-centred on spot/)
  assert.deepEqual(out.actions, [
    { op: 'close', instrument: itm.instrument },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 4 },
  ])
})

test('`hedge_after_shift` true sizes phase R off the POST-shift band', () => {
  // The whole reason `rollForward` exists: landing on a spot-anchored strike
  // lands on different gamma, and the allowance is keyed to gamma
  // (`playbooks.py:4008-4009`). Sizing phase R off the pre-shift corridor would
  // answer with a band that belongs to strikes the shift just sold.
  const itm = leg({ side: 'Sell', optType: 'CE', strike: 280, lots: 4, delta: 0.7, gamma: 0.02 })
  const dials = dialsOf({
    shift_enabled: true,
    shift_itm_steps: 0.5,
    shift_land_steps: 2,
    shift_margin_frac: 0,
    hedge_after_shift: true,
  })
  const inputs = inputsOf([itm])
  const before = corridor(inputs, dials)
  const after = rollForward(before, phaseShift(inputs, dials, EMPTY_RULE_STATE), inputs, dials)
  assert.notEqual(before.netGamma, after.netGamma, 'the shift moved the convexity')
  assert.notEqual(before.allowed, after.allowed, 'and therefore the band')

  const out = decide(inputs, dials, EMPTY_RULE_STATE, mark())
  assert.equal(out.trigger, 'shift', 'a mark that shifted is named for the shift')
  assert.match(out.reason, /^shift: /)
  assert.match(out.reason, /netΔ|allowed|no convexity/, 'and phase R’s own line rides along')
})

test('rollForward leaves the tolerance, the floor and hasGreeks alone', () => {
  // A shift does not change the tolerance, does not re-measure the ladder and
  // does not un-mark a leg. Only the two nets, the allowance and the excess move.
  const itm = leg({ side: 'Sell', optType: 'CE', strike: 280, lots: 4, delta: 0.7, gamma: 0.02 })
  const dials = dialsOf({ shift_enabled: true, shift_itm_steps: 0.5, shift_land_steps: 2, shift_margin_frac: 0 })
  const inputs = inputsOf([itm])
  const before = corridor(inputs, dials)
  const after = rollForward(before, phaseShift(inputs, dials, EMPTY_RULE_STATE), inputs, dials)
  assert.equal(after.tol, before.tol)
  assert.equal(after.floorRef, before.floorRef)
  assert.equal(after.hasGreeks, before.hasGreeks)
  assert.equal(after.excess, Math.abs(after.netDelta) - after.allowed)
})

// ── 9. the margin projection, inside the pass ───────────────────────────────

test('the cap downsizes phase R’s package without touching its exits', () => {
  // Phase R wants 104 lots of the 330 CE against a book that already carries a
  // short PE. The cap admits fewer, and what comes out is the same package at a
  // size that fits — not a hold, and not a bare close.
  const book = shedBook()
  const uncapped = decide(inputsOf(book), dialsOf({ margin_cap: 0 }), EMPTY_RULE_STATE, mark())
  assert.deepEqual(uncapped.actions, [THE_SHED])

  const capped = decide(inputsOf(book), dialsOf({ margin_cap: 40_000 }), EMPTY_RULE_STATE, mark())
  assert.equal(capped.action, 'adjust')
  const [only] = capped.actions
  assert.ok(only !== undefined && only.op === 'open')
  assert.ok(only.lots > 0 && only.lots < 104, `expected a downsize, got ${only.lots} lots`)
  assert.match(capped.reason, /downsized for the margin cap/)
})

test('no headroom at all makes phase R’s all-sells package a HOLD', () => {
  // A cap under the book's own SPAN leaves the scale factor at zero, so not
  // even one lot survives and there is no exit to keep the package alive.
  const out = decide(inputsOf(shedBook()), dialsOf({ margin_cap: 1_000 }), EMPTY_RULE_STATE, mark())
  assert.equal(out.action, 'hold')
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /no headroom for new shorts/)
})

// ── 10. the deferred commit, scaled ─────────────────────────────────────────

/** `tiers.test.ts`'s crossfill book, which is the one that banks: the unwind
 * takes 5 of the PE's 10 lots, the realized loss is ₹5,000, the credit is half
 * of it (₹2,500), and the recycle spends it on 4 lots of the 320 CE — leaving
 * ₹100 in the bank if all four fill. */
const BANK_DATE = '2026-06-02'
const BANK_EXPIRY = '2026-06-30'
const BANK_LOT = 100
const BANK_LADDER = [260, 270, 280, 290, 300, 310, 320, 330, 340]
const bankPx = (ltp: number): Quote => ({ bid: null, ask: null, ltp, asOf: NOW })
const bankChain: ChainSnap = {
  symbol: 'TEST',
  expiry: BANK_EXPIRY,
  step: 10,
  lotSize: BANK_LOT,
  future: bankPx(300),
  spot: 300,
  strikes: BANK_LADDER.map((k) => ({ strike: k, ce: bankPx(6), pe: bankPx(6) })),
  asOf: NOW,
}
const bankGreeks = (strike: number, optType: OptType) => {
  const call = Math.min(0.98, Math.max(0.02, 0.5 - (strike - 300) / 100))
  const delta = optType === 'CE' ? call : call - 1
  return { delta: Math.round(delta * 100) / 100, gamma: 0.02 }
}
function bankInputs(): EngineInputs {
  return {
    tag: 'TEST',
    mode: 'paper',
    nowMs: NOW,
    dateIst: BANK_DATE,
    minuteOfDay: 560,
    dte: 20,
    chain: bankChain,
    legs: [
      { ...leg(), instrument: 'PE290', optType: 'PE', strike: 290, lots: 10, lotSize: BANK_LOT, entry: 5, iv: 0.18, delta: 0.55, gamma: 0.0231, mtm: -10_000, exit: bankPx(5) },
      { ...leg(), instrument: 'CE310', optType: 'CE', strike: 310, lots: 10, lotSize: BANK_LOT, entry: 5, iv: 0.18, delta: 0.025, gamma: 0.0231, mtm: 0, exit: bankPx(5) },
    ],
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'broker', asOf: NOW, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'parity',
    strikeGreeksOverride: bankGreeks,
  }
}
const bankDials = (cap: number) =>
  dialsOf({
    shed_scan_strikes: 0,
    unwind_enabled: true,
    recycle_frac: 0.5,
    recycle_bank: true,
    recycle_opposite: true,
    margin_cap: cap,
  })

test('a package that fills WHOLE spends the whole deferred credit', () => {
  const out = decide(bankInputs(), bankDials(0), EMPTY_RULE_STATE, mark())
  assert.deepEqual(out.actions, [
    { op: 'resize', instrument: 'PE290', targetLots: 5 },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 4 },
  ])
  assert.deepEqual(out.creditCommit, {
    base: 2_500,
    value: 100,
    lots: 4,
    optType: 'CE',
    strike: 320,
    keptLots: 4,
  })
  assert.equal(out.stateAfter.rcCredit, 100, 'base + (value − base) × 4/4')
})

test('A DOWNSIZED PACKAGE SPENDS A PROPORTIONAL SLICE, and the rest keeps accumulating', () => {
  // The measured failure this prevents (`engine.py:946-973`): a playbook that
  // advanced its high-water mark when it DECIDED to sell would bank a spend it
  // never made — 22 lots of an intended 710 was the case on the record — and
  // then never fund that loss again.
  //
  // Cap 85,000: base 71,873.31, projected 94,445.23, so f = 13,126.69 / 22,571.92
  // = 0.5816 and `int(4 × 0.5816)` is 2. Half the sale, half the spend:
  // 2,500 + (100 − 2,500) × 2/4 = 1,300.
  const out = decide(bankInputs(), bankDials(85_000), EMPTY_RULE_STATE, mark())
  assert.deepEqual(out.actions, [
    { op: 'resize', instrument: 'PE290', targetLots: 5 },
    { op: 'open', strike: 320, optType: 'CE', side: 'Sell', lots: 2 },
  ])
  assert.equal(out.stateAfter.rcCredit, 1_300)
  // The DEPOSIT is untouched by the downsize — only the debit scales, and
  // `keptLots` is the field that says by how much.
  assert.deepEqual(out.creditCommit, {
    base: 2_500,
    value: 100,
    lots: 4,
    optType: 'CE',
    strike: 320,
    keptLots: 2,
  })
})

test('a package whose sale is DROPPED banks nothing at all', () => {
  // Cap 72,000 leaves no headroom for the sale; the unwind's buy-back survives
  // (it is an exit), the recycle does not, and the bank keeps its ₹2,500.
  const out = decide(bankInputs(), bankDials(72_000), EMPTY_RULE_STATE, mark())
  assert.deepEqual(out.actions, [{ op: 'resize', instrument: 'PE290', targetLots: 5 }])
  assert.equal(out.stateAfter.rcCredit, 2_500)
  assert.match(out.reason, /sell opens dropped for the margin cap/)
  // AND THE DECISION SAYS SO. The proposal is still reported — a ledger row
  // showing nothing here could not tell "the bank did not move" from "no bank
  // rule ran" — but `keptLots: 0` is what makes it un-mistakable for a spend
  // (`types.ts`'s `AppliedCredit`). Without this assertion the field could
  // claim a 2,400 debit on a mark that banked nothing and no test would fail.
  assert.deepEqual(out.creditCommit, {
    base: 2_500,
    value: 100,
    lots: 4,
    optType: 'CE',
    strike: 320,
    keptLots: 0,
  })
  assert.equal(
    out.creditCommit === null
      ? 0
      : out.creditCommit.base +
        (out.creditCommit.value - out.creditCommit.base) *
          Math.min(1, out.creditCommit.keptLots / out.creditCommit.lots),
    out.stateAfter.rcCredit,
    'the amount a ledger computes off the commit IS the bank the state carries',
  )
})

// ── the journal label ───────────────────────────────────────────────────────

test('shedTrigger names the tier that acted, structurally where it can', () => {
  const sell: EngineAction = { op: 'open', strike: 330, optType: 'CE', side: 'Sell', lots: 4 }
  const buyBack: EngineAction = { op: 'close', instrument: 'X' }

  assert.equal(shedTrigger('balance: sell 3 290PE to rebuild the missing side', [sell]), 'balance')
  assert.equal(shedTrigger('15:15 sweep at tolerance 0 (whole book); sell 3 330CE', [sell]), 'eod')
  // Buy-backs only — the LIFO unwind covered the whole budget.
  assert.equal(shedTrigger('unwind: buy back 4 290PE (sheds 100 of the 100 budget)', [buyBack]), 'unwind')
  assert.equal(
    shedTrigger('unwind: buy back 4 290PE; the buy-back covered it — no CE sale needed; recycle: sell 2 330CE', [sell]),
    'recycle',
  )
  assert.equal(shedTrigger('sell 104 330CE (netΔ +90 vs allowed 60, shed 30)', [sell]), 'shed')
})

test('the trigger vocabulary the reason markers depend on is the one shed.ts writes', () => {
  // `shedTrigger` reads two markers out of prose, and a reworded reason must
  // fail HERE rather than drift into a mislabelled ledger. These two strings are
  // built by `shed.ts:441` and `:602`.
  const balance = decide(
    inputsOf([leg({ side: 'Sell', optType: 'PE', lots: 4, delta: 0.9, gamma: 0.000001 })]),
    dialsOf({ balance_enabled: true, balance_min_dte: 1, shed_scan_strikes: 0 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(balance.trigger, 'balance')
  assert.match(balance.reason, /^balance: /)

  const swept = decide(
    inputsOf(shedBook(), { minuteOfDay: 920 }),
    dialsOf({ eod_flat_min: 915 }),
    EMPTY_RULE_STATE,
    mark(),
  )
  assert.equal(swept.trigger, 'eod')
  assert.match(swept.reason, /sweep at tolerance 0 \(whole book\)/)
})

// ── the state a hold still carries ──────────────────────────────────────────

test('a hold still returns the state the pass reached', () => {
  // Three of `RuleState`'s fields move on marks that do nothing — that is the
  // whole reason they are state. A `decide` that returned `EMPTY_RULE_STATE` on
  // every hold would silently reset the anchor EMA and re-arm the EOD sweep.
  const anchored: RuleState = { ...EMPTY_RULE_STATE, gkAnchor: 291.5 }
  const out = decide(
    inputsOf([leg({ side: 'Sell', optType: 'PE', lots: 4, delta: 0.2, gamma: 0.1 })]),
    dialsOf({ anchor_ema_marks: 5 }),
    anchored,
    mark(),
  )
  assert.equal(out.action, 'hold')
  assert.notEqual(out.stateAfter.gkAnchor, 0)
  assert.notEqual(out.stateAfter.gkAnchor, 291.5, 'the EMA advanced on a mark that did nothing')
})

// ── PORTED FROM PYTHON — the INVARIANTS of `test_sim_recenter.py` ───────────
//
// These are the four claims the recenter contract is written in terms of, and
// none of them is about a particular number. They are cheap to state and they
// are what a refactor breaks first.

test('PORTED: the same context twice gives the SAME decision', () => {
  // `test_same_context_twice_gives_the_same_decision`. `decide` is a pure
  // function of a snapshot, a dial set and a state — no clock read, no random
  // tie-break, no hidden accumulator. A supervisor that re-POSTs an inFlight
  // decision on boot depends on exactly this (§7).
  const inputs = inputsOf(shedBook())
  const a = decide(inputs, dialsOf(), EMPTY_RULE_STATE, mark())
  const b = decide(inputs, dialsOf(), EMPTY_RULE_STATE, mark())
  assert.deepEqual(a.actions, b.actions)
  assert.equal(a.reason, b.reason)
  assert.equal(a.trigger, b.trigger)
  assert.deepEqual(a.stateAfter, b.stateAfter)
})

test('PORTED: the delta phase NEVER BUYS and never closes', () => {
  // `test_never_buys_and_never_closes`. recenter is sell-only: `close_ids` is
  // always empty and every open is a Sell. The unwind and the shift are the two
  // tiers that close, and both are off here.
  const out = decide(inputsOf(shedBook()), dialsOf({ unwind_enabled: false }), EMPTY_RULE_STATE, mark())
  assert.equal(out.actions.length, 1)
  for (const a of out.actions) {
    assert.equal(a.op, 'open')
    if (a.op === 'open') assert.equal(a.side, 'Sell')
  }
})

test('PORTED: a book deep in the red but INSIDE the band trades nothing', () => {
  // `test_never_recycles_a_loss`: "there is no loss-driven behaviour in this
  // rule at all". The trigger is the delta band and nothing else — a P&L that
  // would fund a recycle on another variant funds nothing here.
  const bleeding = leg({
    side: 'Sell',
    optType: 'PE',
    lots: 4,
    lotSize: 25,
    delta: 0.2,
    gamma: 0.1,
    mtm: -800_000,
  })
  const out = decide(inputsOf([bleeding]), dialsOf(), EMPTY_RULE_STATE, mark())
  assert.equal(out.action, 'hold')
  assert.deepEqual(out.actions, [])
  assert.match(out.reason, /inside allowed/)
})

test('PORTED: with the shift OFF an ITM short is neither closed nor re-sold', () => {
  // `test_never_shifts_an_itm_short`: "the ITM 290PE is neither closed nor
  // re-sold further out; the only leg in the decision is the fresh hedge". Phase
  // S is a DIAL, and a book that has not switched it on gets phase R alone.
  const itm = leg({ side: 'Sell', optType: 'PE', strike: 340, lots: 4, lotSize: 25, delta: 0.9, gamma: 0.1 })
  const out = decide(inputsOf([itm]), dialsOf({ shift_enabled: false }), EMPTY_RULE_STATE, mark())
  assert.equal(out.action, 'adjust')
  assert.equal(out.actions.length, 1)
  const [only] = out.actions
  assert.ok(only !== undefined && only.op === 'open')
  assert.equal(only.side, 'Sell')
  assert.equal(only.optType, 'CE', 'the fresh hedge, on the delta-reducing side')
})
