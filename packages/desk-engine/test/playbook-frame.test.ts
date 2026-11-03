/**
 * THE PLAYBOOK FRAME — every step of six-playbooks spec §4.3, every gate, the
 * exit latch, the staging and the session fold, pinned one rule a test.
 *
 * The frame is the only author of a playbook book's orders, so each test below
 * is one way a defined-risk book stops being one:
 *
 *   - a SHORT SOLD WITHOUT ITS WING (review focus 1): stage 2 sells only once
 *     each short's own cover is held, only as many lots as it holds, and
 *     aborts — closing what was bought — when the wing never comes;
 *   - an EXIT THAT NEVER FINISHES (review focus 2): the latch re-sends the D2
 *     close (shorts first, longs only after) every pass until the book is
 *     flat and nothing is working, whatever the condition that fired it does;
 *   - a RESTART MID-TRADE (review focus 3): `pb` survives JSON and the
 *     hydrator, and the next pass decides exactly as it would have;
 *   - a WRONG CONTRACT (review focus 4): no entry, journalled, exits running;
 *   - the PAPER-FOLD RACE (O18): `inFlight` with `pendingLots` 0 blocks the
 *     finish, the stage-1 readiness and the stage-2 sale alike;
 *   - a REFUSED OPEN (O5, O24): rolled back to `markState`, the entry is
 *     refunded and the retry waits `pb_retry_s`.
 *
 * THE STRATEGY is a scripted fake registered under id 99 through
 * `makeDecidePlaybook`, so every test drives the frame's own rules and none of
 * the six playbooks' (those have suites of their own). THE MARKET is the
 * shared fixture: a calm NIFTY tape around 25,000 and the harness's Black-76
 * board, one trading day to the Monday weekly.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { MarkContext } from '../src/guards.ts'
import { atmStraddleMid } from '../src/delta-lean/regime.ts'
import { hydratePlaybookState } from '../src/delta-lean/playbook/state.ts'
import type { OpenPlan, Playbook, PlaybookCtx, PlaybookStep } from '../src/delta-lean/playbook/types.ts'
import { decidePlaybook, makeDecidePlaybook } from '../src/delta-lean/playbook/decide.ts'
import { PLAYBOOKS } from '../src/delta-lean/playbook/registry.ts'
import { dayComplete, foldSession, sessionOpenMs } from '../src/delta-lean/playbook/session.ts'
import {
  EMPTY_PLAYBOOK_STATE,
  type ChainSnap,
  type EngineAction,
  type EngineDecision,
  type LegView,
  type PlaybookState,
  type RuleState,
} from '../src/types.ts'
import {
  at,
  calm,
  chainAt,
  DATE,
  dialsOf,
  fake,
  FLY,
  inputsAt,
  legOn,
  OPEN,
  SPREAD,
  stateWith,
  Tape,
  type InputsOver,
} from './playbook-fixture.ts'

const NOW = at(600) // 10:00
const MARK: MarkContext = { isNewMark: true, markIndexToday: 9 }
const DIALS = dialsOf()
const median3 = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))

const run = (p: Playbook, inputs: Parameters<typeof decidePlaybook>[0], state: RuleState, dials = DIALS): EngineDecision =>
  makeDecidePlaybook(new Map([[p.id, p]]))(inputs, dials, state, MARK)

const opener = (plan: OpenPlan): Playbook => fake({ enter: () => ({ kind: 'open', plan }) })

/** The decision's opens, as [strike, type, side, lots, add]. */
const opens = (d: EngineDecision): Array<[number, string, string, number, boolean]> =>
  d.actions.flatMap((a: EngineAction) => (a.op === 'open' ? [[a.strike, a.optType, a.side, a.lots, a.add === true]] : []))
const closes = (d: EngineDecision): string[] =>
  d.actions.flatMap((a: EngineAction) => (a.op === 'close' ? [a.instrument] : []))

/** A fresh tape and the board at `ms` on it. */
function market(ms = NOW): { tape: Tape; chain: ChainSnap } {
  const tape = new Tape()
  const level = tape.advanceTo(ms)
  return { tape, chain: chainAt(ms, level) }
}

/** Legs with a scripted P&L: mtm 0, so `totalPnl` is `cumRealized` exactly. */
const flatMtm = (chain: ChainSnap, k: number, t: 'CE' | 'PE', s: 'Buy' | 'Sell', lots: number): LegView =>
  legOn(chain, k, t, s, lots, { mtm: 0 })
const spreadLegs = (chain: ChainSnap, longLots = 2, shortLots = 2): LegView[] => [
  ...(longLots > 0 ? [flatMtm(chain, 24_950, 'CE', 'Buy', longLots)] : []),
  ...(shortLots > 0 ? [flatMtm(chain, 25_150, 'CE', 'Sell', shortLots)] : []),
]

/** A spread trade opened at 09:45, fully staged. */
const TRADE: Partial<PlaybookState> = {
  entries: 1, tradeOpenMs: at(585), side: 'up', planShorts: [], planLots: 2,
  stageMs: at(585), stageSpot: OPEN, stageReadyMs: at(585) + 12_000,
  entrySpot: OPEN, entryStr: 217, basePnl: 0,
}
const SPREAD_PLAN = [{ strike: 25_150, optType: 'CE' as const, cover: 24_950 }]
const FLY_PLAN = FLY.shorts.map((s) => ({ ...s }))

// ── steps 1-4: the frame's day exits ────────────────────────────────────────

test('step 1: a latched stop closes what is left, shorts first, urgently — above the clock', () => {
  const { tape, chain } = market(at(892))
  for (const minute of [600, 892]) {
    const d = run(fake(), inputsAt(tape, at(minute), { chain, legs: spreadLegs(chain) }), stateWith(TRADE, { dlStopped: true }))
    assert.equal(d.trigger, 'dl-stop')
    assert.equal(d.urgency, 'urgent')
    assert.deepEqual(closes(d), [spreadLegs(chain)[1]?.instrument], 'the short alone: its long waits for it')
  }
  const longOnly = run(fake(), inputsAt(tape, at(892), { chain, legs: spreadLegs(chain, 2, 0) }), stateWith(TRADE, { dlStopped: true }))
  assert.deepEqual(closes(longOnly), [spreadLegs(chain)[0]?.instrument], 'no short left: now the long')
  const flat = run(fake(), inputsAt(tape, at(892), { chain }), stateWith(TRADE, { dlStopped: true }))
  assert.equal(flat.action, 'hold')
  assert.match(flat.reason, /^fake: stopped for the day — flat already/)
})

test('step 2: the clock — 14:50 passive, 14:55 urgent, 15:00 ladder — sends the D2 close and latches only once flat', () => {
  const { tape, chain } = market(at(905))
  const cases = [[890, 'passive'], [895, 'urgent'], [900, 'ladder']] as const
  for (const [minute, urgency] of cases) {
    const d = run(fake(), inputsAt(tape, at(minute), { chain, legs: spreadLegs(chain) }), stateWith(TRADE))
    assert.equal(d.trigger, 'eod')
    assert.equal(d.urgency, urgency)
    assert.deepEqual(closes(d), [spreadLegs(chain)[1]?.instrument])
    assert.equal(d.stateAfter.dlStopped, false, 'the clock survives its flatten: no latch yet')
  }
  const flat = run(fake(), inputsAt(tape, at(896), { chain }), stateWith(TRADE))
  assert.equal(flat.trigger, 'eod')
  assert.equal(flat.stateAfter.dlStopped, true, 'flat: latched')
  // The clock outranks the day backstop, as on decideDeltaLean.
  const both = run(fake(), inputsAt(tape, at(891), { chain, legs: spreadLegs(chain), cumRealized: -60_000 }), stateWith(TRADE))
  assert.equal(both.trigger, 'eod')
  // ...but never works a latched urgent stop more gently than the stop did.
  const stopped = stateWith({ ...TRADE, exiting: true, exitReason: 'hard stop', exitUrgency: 'urgent', exitMs: at(889) })
  const kept = run(fake(), inputsAt(tape, at(891), { chain, legs: spreadLegs(chain, 2, 0) }), stopped)
  assert.equal(kept.trigger, 'eod')
  assert.equal(kept.urgency, 'urgent', '14:50 is passive, the latched stop is not')
  const worked = stateWith({ ...TRADE, exiting: true, exitReason: 'take profit', exitUrgency: 'passive', exitMs: at(889) })
  assert.equal(run(fake(), inputsAt(tape, at(891), { chain, legs: spreadLegs(chain, 2, 0) }), worked).urgency, 'passive')
})

test('steps 3-4: the day backstop (urgent) and the day target (ladder) fire once held pb_rupee_hold_s, latch on both states, and outrank any playbook exit', () => {
  const { tape, chain } = market()
  const legs = spreadLegs(chain)
  const exiting = fake({ exits: () => ({ exit: { reason: 'scripted', urgency: 'passive', final: false } }) })
  const pass = (ms: number, pnl: number, st: RuleState, p: Playbook = fake()): EngineDecision =>
    run(p, inputsAt(tape, ms, { chain, legs, cumRealized: pnl }), st)
  // ONE MARK through the floor is not the day's loss (spec O19, engine review
  // finding 4): the day's own clock starts, and nothing latches.
  const first = pass(NOW, -50_000, stateWith(TRADE))
  assert.equal(first.action, 'hold')
  assert.equal(first.markState.dlStopped, false)
  assert.equal(first.markState.pb.dayLineSinceMs, NOW)
  const back = pass(NOW + 1_000, -49_999, first.markState)
  assert.equal(back.markState.pb.dayLineSinceMs, 0, 'back over the floor: the clock resets')
  // Held: urgent, latched on both states, above the playbook's own exit.
  const stop = pass(NOW + 3_000, -50_000, first.markState, exiting)
  assert.equal(stop.trigger, 'dl-stop')
  assert.equal(stop.urgency, 'urgent')
  assert.match(stop.reason, /^fake: day backstop: Rs-50,000 through the Rs-50,000 floor, held 3s — buying back 1 short\(s\) first, 1 long\(s\) after$/)
  assert.equal(stop.stateAfter.dlStopped, true)
  assert.equal(stop.markState.dlStopped, true, 'a dropped package must not un-latch the backstop')
  assert.deepEqual(closes(stop), [legs[1]?.instrument])
  // 1.25 x the floor or worse is no wide quote: at once.
  const deep = pass(NOW, -62_500, stateWith(TRADE))
  assert.equal(deep.trigger, 'dl-stop')
  assert.match(deep.reason, /through the Rs-50,000 floor — 1\.25 x it or worse, at once/)
  assert.equal(deep.markState.dlStopped, true)
  // A FLAT book's P&L is banked, with no mark in it to doubt: at once.
  const flat = run(fake(), inputsAt(tape, NOW, { chain, cumRealized: -50_000 }), stateWith())
  assert.equal(flat.trigger, 'dl-stop')
  assert.equal(flat.stateAfter.dlStopped, true)

  const t0 = pass(NOW, 100_000, stateWith(TRADE))
  assert.equal(t0.action, 'hold')
  assert.equal(t0.markState.dlStopped, false)
  const target = pass(NOW + 3_000, 100_000, t0.markState, exiting)
  assert.equal(target.trigger, 'dl-target')
  assert.equal(target.urgency, 'ladder')
  assert.match(target.reason, /^fake: day target: Rs100,000 at or past Rs100,000, held 3s — banking it/)
  assert.equal(target.markState.dlStopped, true)
  // The clock is the DAY's, apart from the trade's: a playbook exit latching on
  // the same pass clears the trade's rupee clock and leaves this one running.
  const both = pass(NOW, -50_000, stateWith(TRADE), exiting)
  assert.equal(both.trigger, 'dl-exit')
  assert.equal(both.stateAfter.pb.rupeeSinceMs, 0)
  assert.equal(both.stateAfter.pb.dayLineSinceMs, NOW)
  const later = pass(NOW + 3_000, -50_000, both.stateAfter)
  assert.equal(later.trigger, 'dl-stop', 'held across the latch: the backstop takes the close over, urgently')
})

test('a ₹0 day target is OFF on this path too (delta-lean-zero spec D4): no line, no clock, no latch', () => {
  // The dial means one thing on both delta-lean paths. Without the guard a
  // flat book's banked 0 is "at or past" a ₹0 target and ends the day unopened.
  const { tape, chain } = market()
  const off = dialsOf({ dl_day_target: 0 })
  const flat = run(fake(), inputsAt(tape, NOW, { chain, cumRealized: 0 }), stateWith(), off)
  assert.notEqual(flat.trigger, 'dl-target')
  assert.equal(flat.markState.dlStopped, false)
  const legs = spreadLegs(chain)
  const rich = run(fake(), inputsAt(tape, NOW, { chain, legs, cumRealized: 1_000_000 }), stateWith(TRADE), off)
  assert.notEqual(rich.trigger, 'dl-target')
  assert.equal(rich.markState.dlStopped, false)
  assert.equal(rich.markState.pb.dayLineSinceMs, 0, 'no line, so no clock starts behind it')
})

// ── step 6: the exit latch ──────────────────────────────────────────────────

test('the exit latch re-sends the D2 close every pass until flat, after its condition has gone (review focus 2)', () => {
  const { tape, chain } = market()
  let fire = true
  const pbk = fake({ exits: () => (fire ? { exit: { reason: 'scripted stop at Rs-1', urgency: 'passive', final: false } } : {}) })
  const first = run(pbk, inputsAt(tape, NOW, { chain, legs: spreadLegs(chain) }), stateWith(TRADE))
  assert.equal(first.trigger, 'dl-exit')
  assert.equal(first.action, 'flatten')
  assert.equal(first.urgency, 'passive')
  assert.deepEqual(closes(first), [spreadLegs(chain)[1]?.instrument])
  const latched = first.stateAfter.pb
  assert.deepEqual(
    [latched.exiting, latched.exitReason, latched.exitUrgency, latched.exitMs],
    [true, 'scripted stop at Rs-1', 'passive', NOW],
  )
  assert.deepEqual(first.markState.pb, latched, 'the latch rides on markState too')

  fire = false
  // A partial fill: one short lot bought back, the condition gone.
  const again = run(pbk, inputsAt(tape, NOW + 4_000, { chain, legs: spreadLegs(chain, 2, 1) }), first.stateAfter)
  assert.equal(again.trigger, 'dl-exit')
  assert.deepEqual(closes(again), [spreadLegs(chain)[1]?.instrument], 'still the short first')
  assert.match(again.reason, /^fake: scripted stop at Rs-1 — buying back/)
  const longs = run(pbk, inputsAt(tape, NOW + 8_000, { chain, legs: spreadLegs(chain, 2, 0) }), again.stateAfter)
  assert.deepEqual(closes(longs), [spreadLegs(chain)[0]?.instrument], 'no short held: the long goes')
  const done = run(pbk, inputsAt(tape, NOW + 12_000, { chain }), longs.stateAfter)
  assert.equal(done.action, 'hold')
  assert.match(done.reason, /^fake: trade finished/)
  assert.equal(done.stateAfter.pb.exiting, false)
  assert.equal(done.stateAfter.pb.tradeOpenMs, 0)
  assert.equal(done.stateAfter.pb.lastExitMs, NOW + 12_000)
  assert.equal(done.stateAfter.pb.entries, 1, 'trade counting survives the finish')
})

test('a worked exit escalates to urgent after 60 s, and at once on the hard-stop condition (D4)', () => {
  const { tape, chain } = market()
  const latch = (ms: number): RuleState =>
    stateWith({ ...TRADE, exiting: true, exitReason: 'take profit', exitUrgency: 'passive', exitMs: ms })
  const young = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain) }), latch(NOW - 59_999))
  assert.equal(young.urgency, 'passive')
  assert.equal(young.stateAfter.pb.exitUrgency, 'passive')
  const old = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain) }), latch(NOW - 60_000))
  assert.equal(old.urgency, 'urgent')
  assert.equal(old.stateAfter.pb.exitUrgency, 'urgent', 'the escalation is persisted')
  assert.equal(old.markState.pb.exitUrgency, 'urgent')
  assert.match(old.reason, /escalated to urgent/)
  const stopped = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain), cumRealized: -6_000 }), latch(NOW - 5_000))
  assert.equal(stopped.urgency, 'urgent', 'the hard stop does not wait out the minute')
})

test('finishing waits while anything is working — the paper-fold race (O18) — and the exit asks the host to cancel what is working', () => {
  const { tape, chain } = market()
  const latched = stateWith({ ...TRADE, exiting: true, exitReason: 'scripted', exitUrgency: 'urgent', exitMs: NOW - 4_000 })
  for (const over of [{ inFlight: true }, { pendingLots: 2 }] as const) {
    const d = run(fake(), inputsAt(tape, NOW, { chain, ...over }), latched)
    // An exit with nothing to close is still an EXIT, not a hold: the host
    // pre-empts a working package only for a decision that acts, and a
    // resting buy left on the market could fill into the exited trade.
    assert.equal(d.trigger, 'dl-exit')
    assert.equal(d.action, 'flatten')
    assert.deepEqual(d.actions, [])
    assert.match(d.reason, /flat, cancelling the working package/)
    assert.equal(d.stateAfter.pb.exiting, true, `${JSON.stringify(over)}: not finished`)
    assert.equal(d.markState.pb.exiting, true)
    assert.equal(d.markState.pb.tradeOpenMs, TRADE.tradeOpenMs)
  }
  const free = run(fake(), inputsAt(tape, NOW, { chain }), latched)
  assert.equal(free.action, 'hold')
  assert.equal(free.stateAfter.pb.exiting, false)
})

// ── step 7: stage 1 ─────────────────────────────────────────────────────────

test('stage 1: the protective buys go out alone, the trade and the plan stamped on stateAfter, and markState is the book before it', () => {
  const { tape, chain } = market()
  const inputs = inputsAt(tape, NOW, { chain })
  // The trade's anchors are `S` steadied — the median of the newest three
  // prints — so one bad print at the moment of routing cannot anchor it.
  const S = median3(calm(NOW - 2_000), calm(NOW - 1_000), calm(NOW))
  const d = run(opener(SPREAD), inputs, stateWith())
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.action, 'adjust')
  assert.equal(d.urgency, 'passive')
  assert.deepEqual(opens(d), [[24_950, 'CE', 'Buy', 2, false]], 'the long alone, at pb_lots')
  assert.match(d.reason, /^fake: a CE debit spread — stage 1/)
  const pb = d.stateAfter.pb
  assert.deepEqual(
    [pb.entries, pb.tradeOpenMs, pb.side, pb.stage, pb.planLots, pb.stageMs, pb.stageReadyMs, pb.stageSpot, pb.entrySpot],
    [1, NOW, 'up', 1, 2, NOW, 0, S, S],
  )
  assert.deepEqual(pb.planShorts, SPREAD_PLAN)
  assert.equal(pb.entryStr, atmStraddleMid(chain))
  assert.equal(pb.basePnl, 0)
  assert.equal(d.stateAfter.dlLastAdjustMs, NOW, 'every open stamps the retry clock')
  assert.equal(d.markState.pb.entries, 0, 'a refusal refunds the entry')
  assert.equal(d.markState.pb.tradeOpenMs, 0)
  assert.equal(d.markState.dlLastAdjustMs, 0)

  const single = run(opener({ ...SPREAD, shorts: [], reason: 'a long call' }), inputs, stateWith())
  assert.equal(single.stateAfter.pb.stage, 0, 'no shorts: a single-stage trade')
  assert.deepEqual(single.stateAfter.pb.planShorts, [])
})

test('stage 1 waits while working and does not stamp readiness; the hard stop runs first', () => {
  const { tape, chain } = market()
  const staged = stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageMs: NOW - 8_000, stageReadyMs: 0 }, { dlLastAdjustMs: NOW - 8_000 })
  for (const over of [{ inFlight: true }, { pendingLots: 1 }] as const) {
    const d = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain, 2, 0), ...over }), staged)
    assert.equal(d.action, 'hold')
    assert.match(d.reason, /^fake: stage 1 working/)
    assert.equal(d.stateAfter.pb.stageReadyMs, 0)
  }
  const stop = { chain, legs: spreadLegs(chain, 2, 0), inFlight: true, cumRealized: -6_000 }
  const armed = run(fake(), inputsAt(tape, NOW, stop), staged)
  assert.equal(armed.action, 'hold', 'the rupee clock starts; one mark is not a loss')
  assert.equal(armed.stateAfter.pb.rupeeSinceMs, NOW)
  const fired = run(fake(), inputsAt(tape, NOW + 3_000, stop), armed.stateAfter)
  assert.equal(fired.trigger, 'dl-exit')
  assert.match(fired.reason, /hard stop/)
})

test('stage 1: a protective leg missing with nothing working aborts and closes what was bought — no short is ever sold (review focus 1, O16)', () => {
  const { tape, chain } = market()
  const staged = stateWith({ ...TRADE, side: 'none', stage: 1, planShorts: FLY_PLAN, stageMs: NOW - 20_000, stageReadyMs: 0 })
  const ceWing = flatMtm(chain, 25_250, 'CE', 'Buy', 2)
  const d = run(fake(), inputsAt(tape, NOW, { chain, legs: [ceWing] }), staged)
  assert.equal(d.trigger, 'dl-exit')
  assert.equal(d.urgency, 'urgent')
  assert.match(d.reason, /^fake: stage-1 abort: protective 24750PE not held/)
  assert.deepEqual(closes(d), [ceWing.instrument])
  assert.deepEqual(opens(d), [], 'nothing sold')
  assert.equal(d.stateAfter.pb.exiting, true)
})

test('stage 1 that never filled finishes the trade with the entry spent; 300 s without readiness aborts even while working', () => {
  const { tape, chain } = market()
  const staged = (since: number): RuleState =>
    stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageMs: since, stageReadyMs: 0 })
  const never = run(fake(), inputsAt(tape, NOW, { chain }), staged(NOW - 30_000))
  assert.equal(never.action, 'hold')
  assert.match(never.reason, /^fake: trade finished/)
  assert.equal(never.stateAfter.pb.entries, 1, 'a FAILED or fill-less stage 1 spends the entry')
  assert.equal(never.stateAfter.pb.tradeOpenMs, 0)

  const slow = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain, 1, 0), inFlight: true }), staged(NOW - 300_001))
  assert.equal(slow.trigger, 'dl-exit')
  assert.match(slow.reason, /stage-1 abort: .*300s/)
  // Nothing filled at all and the buys still rest: the abort must take them
  // off the market, so it acts (no close to send) rather than holding.
  const resting = run(fake(), inputsAt(tape, NOW, { chain, pendingLots: 2 }), staged(NOW - 300_001))
  assert.equal(resting.trigger, 'dl-exit')
  assert.equal(resting.action, 'flatten')
  assert.deepEqual(resting.actions, [])
  assert.equal(resting.markState.pb.exiting, true)
  const inTime = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain, 1, 0), inFlight: true }), staged(NOW - 300_000))
  assert.equal(inTime.action, 'hold')
})

// ── step 8: stage 2 ─────────────────────────────────────────────────────────

test('stage 2: readiness is stamped with nothing working, then each short sells at min(planLots, its cover\'s lots) once pb_stage_gap_s has run', () => {
  const { tape, chain } = market(NOW + 6_000)
  const staged = stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageMs: NOW - 5_000, stageReadyMs: 0 }, { dlLastAdjustMs: NOW - 5_000 })
  const legs = spreadLegs(chain, 1, 0) // the long filled ONE of its two lots
  const early = run(fake(), inputsAt(tape, NOW, { chain, legs }), staged)
  assert.equal(early.action, 'hold')
  assert.match(early.reason, /^fake: stage 2 waiting — 5s left of the 10s stage gap/)
  assert.equal(early.markState.pb.stageReadyMs, NOW, 'readiness stamped on the mark')
  const sale = run(fake(), inputsAt(tape, NOW + 6_000, { chain, legs }), early.markState)
  assert.equal(sale.trigger, 'dl-open')
  assert.deepEqual(opens(sale), [[25_150, 'CE', 'Sell', 1, false]], 'one lot: all its cover holds')
  assert.match(sale.reason, /^fake: stage 2 — selling 1 short\(s\)/)
  assert.equal(sale.stateAfter.pb.stage, 2)
  assert.equal(sale.stateAfter.dlLastAdjustMs, NOW + 6_000)
  assert.equal(sale.markState.pb.stage, 1, 'a refused sale leaves stage 1, ready')
  assert.equal(sale.markState.pb.stageReadyMs, NOW)

  // Every short held at its size, nothing working: the trade is complete.
  const complete = run(fake(), inputsAt(tape, NOW + 10_000, { chain, legs: spreadLegs(chain, 1, 1) }), sale.stateAfter)
  assert.equal(complete.action, 'hold')
  assert.equal(complete.stateAfter.pb.stage, 0)
  assert.match(complete.reason, /^fake: holding/)
})

test('stage 2: a cover at 0 aborts, buying back any short first', () => {
  const { tape, chain } = market()
  const ready = stateWith({ ...TRADE, side: 'none', stage: 2, planShorts: FLY_PLAN, stageReadyMs: NOW - 30_000 })
  const legs = [flatMtm(chain, 24_750, 'PE', 'Buy', 2), flatMtm(chain, 25_000, 'PE', 'Sell', 2)] // the CE wing is gone
  const d = run(fake(), inputsAt(tape, NOW, { chain, legs }), ready)
  assert.equal(d.trigger, 'dl-exit')
  assert.match(d.reason, /^fake: stage-2 abort: the 25250CE cover of the 25000CE short is not held/)
  assert.deepEqual(closes(d), [legs[1]?.instrument])
})

test('stage 2: a missing short is re-sent no sooner than pb_stage_gap_s, topped up as an add, and aborted 120 s after readiness (O17)', () => {
  const { tape, chain } = market()
  const wings = [flatMtm(chain, 25_250, 'CE', 'Buy', 2), flatMtm(chain, 24_750, 'PE', 'Buy', 2)]
  const ceShort = flatMtm(chain, 25_000, 'CE', 'Sell', 2)
  const at2 = (sinceAdjust: number, sinceReady: number): RuleState =>
    stateWith({ ...TRADE, side: 'none', stage: 2, planShorts: FLY_PLAN, stageReadyMs: NOW - sinceReady }, { dlLastAdjustMs: NOW - sinceAdjust })
  const legs = [...wings, ceShort]
  const wait = run(fake(), inputsAt(tape, NOW, { chain, legs }), at2(5_000, 30_000))
  assert.equal(wait.action, 'hold')
  assert.match(wait.reason, /stage gap/)
  const resend = run(fake(), inputsAt(tape, NOW, { chain, legs }), at2(10_000, 30_000))
  assert.deepEqual(opens(resend), [[25_000, 'PE', 'Sell', 2, false]])
  const partial = run(fake(), inputsAt(tape, NOW, { chain, legs: [...legs, flatMtm(chain, 25_000, 'PE', 'Sell', 1)] }), at2(10_000, 30_000))
  assert.deepEqual(opens(partial), [[25_000, 'PE', 'Sell', 1, true]], 'the missing lot, onto the held short')
  const late = run(fake(), inputsAt(tape, NOW, { chain, legs }), at2(10_000, 120_001))
  assert.equal(late.trigger, 'dl-exit')
  assert.match(late.reason, /stage-2 abort: 25000PE still unsold 120s after/)
  assert.deepEqual(closes(late), [ceShort.instrument], 'the sold short is bought back before the wings')
})

test('stage 2 aborts on an index move past pb_stage_abort_k x STR; a stale index or a missing straddle waits instead (O4)', () => {
  const { tape, chain } = market()
  const legs = spreadLegs(chain, 2, 0)
  const S = tape.ring.latest()?.spot ?? Number.NaN
  const str = atmStraddleMid(chain) ?? Number.NaN
  const ready = (stageSpot: number): RuleState =>
    stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageSpot, stageReadyMs: NOW - 20_000 }, { dlLastAdjustMs: NOW - 20_000 })
  const moved = run(fake(), inputsAt(tape, NOW, { chain, legs }), ready(S - 0.3 * str))
  assert.equal(moved.trigger, 'dl-exit')
  assert.match(moved.reason, /^fake: stage-2 abort: the index moved/)
  assert.deepEqual(closes(moved), [legs[0]?.instrument])
  const within = run(fake(), inputsAt(tape, NOW, { chain, legs }), ready(S - 0.2 * str))
  assert.equal(within.trigger, 'dl-open', 'inside the band the sale goes out')

  const stale = run(fake(), inputsAt(tape, NOW, { chain, legs, spotAsOf: NOW - 11_000 }), ready(S - 0.3 * str))
  assert.equal(stale.action, 'hold', 'a stale index cannot measure the move: wait')
  assert.match(stale.reason, /stage 2 waiting — the index is 11.0s stale/)
  const row = chain.strikes.find((r) => r.strike === 25_000)
  const noStr = { ...chain, strikes: chain.strikes.map((r) => (r === row ? { ...r, ce: null } : r)) }
  const blind = run(fake(), inputsAt(tape, NOW, { chain: noStr, legs }), ready(S - 0.3 * str))
  assert.equal(blind.action, 'hold', 'no straddle, no yardstick: wait')
  assert.match(blind.reason, /straddle/)
})

test('stage 2: one bad index print cannot abort it — the move is measured on the median of the newest three prints (M11)', () => {
  const chain = chainAt(NOW, OPEN)
  const ready = stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageSpot: OPEN, stageReadyMs: NOW - 20_000 }, { dlLastAdjustMs: NOW - 20_000 })
  const bad = (prints: readonly number[]): Tape => new Tape((ms) => (prints.includes(ms) ? OPEN + 250 : calm(ms)))
  const one = run(fake(), inputsAt(bad([NOW]), NOW, { chain, legs: spreadLegs(chain, 2, 0) }), ready)
  assert.equal(one.trigger, 'dl-open', `one print 250 away aborted the stage: ${one.reason}`)
  const two = run(fake(), inputsAt(bad([NOW - 1_000, NOW]), NOW, { chain, legs: spreadLegs(chain, 2, 0) }), ready)
  assert.equal(two.trigger, 'dl-exit', 'two prints there are the market')
  assert.match(two.reason, /stage-2 abort: the index moved 250.0/)
})

test('stage 2: every short held is a whole trade — the move abort guards the SALE, and a market that moved since stage 1 cannot close one (engine review finding 1)', () => {
  const { tape, chain } = market()
  const S = tape.ring.latest()?.spot ?? Number.NaN
  const str = atmStraddleMid(chain) ?? Number.NaN
  // Stage 2 routed and the index 0.3 x STR from where stage 1 went out.
  const sold = stateWith(
    { ...TRADE, stage: 2, planShorts: SPREAD_PLAN, stageSpot: S - 0.3 * str, stageReadyMs: NOW - 20_000 },
    { dlLastAdjustMs: NOW - 10_000 },
  )
  // Both short lots held, nothing working: stage 0, and the trade is managed.
  const whole = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain, 2, 2) }), sold)
  assert.notEqual(whole.trigger, 'dl-exit', whole.reason)
  assert.equal(whole.stateAfter.pb.stage, 0)
  assert.match(whole.reason, /^fake: holding/)
  // Held while the package is still clearing: it waits for the package.
  const clearing = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain, 2, 2), inFlight: true }), sold)
  assert.equal(clearing.action, 'hold')
  assert.match(clearing.reason, /stage 2 working — every short is held, waiting for the package to clear/)
  // A short lot still unsold: the abort still speaks (O4).
  const part = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain, 2, 1) }), sold)
  assert.equal(part.trigger, 'dl-exit')
  assert.match(part.reason, /^fake: stage-2 abort: the index moved/)
})

test('stage 2 waits while working — inFlight with pendingLots 0 included — and does not complete (O18)', () => {
  const { tape, chain } = market()
  const legs = spreadLegs(chain)
  const st2 = stateWith({ ...TRADE, stage: 2, planShorts: SPREAD_PLAN, stageReadyMs: NOW - 20_000 })
  const racing = run(fake(), inputsAt(tape, NOW, { chain, legs, inFlight: true, pendingLots: 0 }), st2)
  assert.equal(racing.action, 'hold')
  assert.equal(racing.stateAfter.pb.stage, 2)
  // A ready stage 1 whose cover is held but a package is in flight sells nothing.
  const st1 = stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageReadyMs: NOW - 20_000 })
  const held = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain, 2, 0), inFlight: true }), st1)
  assert.deepEqual(opens(held), [])
  assert.match(held.reason, /working/)
})

test('stage 2 runs the new-risk gates minus the window: past the window it still sells, on a futures forward it waits', () => {
  const { tape, chain } = market(at(880))
  const legs = spreadLegs(chain, 2, 0)
  const ready = stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageSpot: tape.ring.latest()?.spot ?? 0, stageReadyMs: at(880) - 20_000 })
  const late = run(fake(), inputsAt(tape, at(880), { chain, legs }), ready)
  assert.equal(late.trigger, 'dl-open', '14:40 is past the 14:30 window end, and stage 2 is not an entry')
  const future = run(fake(), inputsAt(tape, at(880), { chain, legs, forwardSource: 'future' }), ready)
  assert.equal(future.action, 'hold')
  assert.match(future.reason, /stage 2 waiting — the chain's forward is future/)
})

test('stage 2 never sells an untradable short, and aborts once the window ends with it unsold (O3)', () => {
  const { tape, chain } = market()
  const oneSided = {
    ...chain,
    strikes: chain.strikes.map((r) => (r.strike === 25_150 && r.ce !== null ? { ...r, ce: { ...r.ce, bid: null, ask: null } } : r)),
  }
  const ready = (sinceReady: number): RuleState =>
    stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageSpot: tape.ring.latest()?.spot ?? 0, stageReadyMs: NOW - sinceReady })
  const wait = run(fake(), inputsAt(tape, NOW, { chain: oneSided, legs: spreadLegs(oneSided, 2, 0) }), ready(30_000))
  assert.equal(wait.action, 'hold')
  assert.match(wait.reason, /25150CE not tradable/)
  const late = run(fake(), inputsAt(tape, NOW, { chain: oneSided, legs: spreadLegs(oneSided, 2, 0) }), ready(120_001))
  assert.equal(late.trigger, 'dl-exit')
})

// ── step 9: managing a trade ────────────────────────────────────────────────

test('unknown legs: legs held with no trade open are closed urgently, shorts first', () => {
  const { tape, chain } = market()
  const d = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain) }), stateWith())
  assert.equal(d.trigger, 'dl-exit')
  assert.equal(d.urgency, 'urgent')
  assert.match(d.reason, /^fake: 2 leg\(s\) held with no trade open/)
  assert.deepEqual(closes(d), [spreadLegs(chain)[1]?.instrument])
  assert.equal(d.stateAfter.pb.exiting, true)
})

test('the hard stop is inclusive at -pb_trade_max_loss, fires only once held pb_rupee_hold_s, and a one-pass dip resets its clock (O19)', () => {
  const { tape, chain } = market(NOW + 10_000)
  const legs = spreadLegs(chain)
  const pass = (ms: number, pnl: number, st: RuleState): EngineDecision =>
    run(fake(), inputsAt(tape, ms, { chain, legs, cumRealized: pnl }), st)
  const a = pass(NOW, -6_000, stateWith(TRADE))
  assert.equal(a.action, 'hold')
  assert.equal(a.stateAfter.pb.rupeeSinceMs, NOW)
  const b = pass(NOW + 2_000, -6_100, a.stateAfter)
  assert.equal(b.action, 'hold')
  const c = pass(NOW + 3_000, -6_000, b.stateAfter)
  assert.equal(c.trigger, 'dl-exit')
  assert.equal(c.urgency, 'urgent')
  assert.match(c.reason, /^fake: hard stop: trade P&L Rs-6,000 at or through the Rs-6,000 stop/)
  // A dip that recovers before the hold clears the clock.
  const back = pass(NOW + 2_000, -5_999, a.stateAfter)
  assert.equal(back.stateAfter.pb.rupeeSinceMs, 0)
  const again = pass(NOW + 4_000, -6_000, back.stateAfter)
  assert.equal(again.action, 'hold', 'a new stretch, a new clock')
})

test('the playbook\'s own exit runs after the hard stop and before the trail, and its patch is kept on a hold', () => {
  const { tape, chain } = market()
  const legs = spreadLegs(chain)
  const seen: PlaybookCtx[] = []
  const pbk = fake({
    exits: (ctx): PlaybookStep => {
      seen.push(ctx)
      return ctx.tradePnl <= -4_000
        ? { exit: { reason: 'debit stop', urgency: 'urgent', final: false } }
        : { patch: { condSinceMs: 12_345 }, note: 'fake: watching the debit' }
    },
  })
  const quiet = run(pbk, inputsAt(tape, NOW, { chain, legs, cumRealized: -1_000 }), stateWith(TRADE))
  assert.equal(quiet.reason, 'fake: watching the debit')
  assert.equal(quiet.stateAfter.pb.condSinceMs, 12_345)
  assert.equal(seen[0]?.tradePnl, -1_000)
  const own = run(pbk, inputsAt(tape, NOW, { chain, legs, cumRealized: -4_500 }), stateWith(TRADE))
  assert.equal(own.trigger, 'dl-exit')
  assert.equal(own.reason.startsWith('fake: debit stop — buying back'), true)
  assert.equal(own.stateAfter.pb.condSinceMs, 0, 'the latch resets the debounces')
  // The hard stop, held, wins over the playbook's exit.
  const hard = run(pbk, inputsAt(tape, NOW, { chain, legs, cumRealized: -6_000 }), stateWith({ ...TRADE, rupeeSinceMs: NOW - 3_000 }))
  assert.match(hard.reason, /hard stop/)
  // A strategy's patch writes its own bookkeeping, never the frame's latch,
  // staging or counting.
  const meddler = fake({
    exits: () => ({ patch: { trailArmed: true, boxHi: 25_100, exiting: true, entries: 0, stage: 1, tradeOpenMs: 0, doneForDay: true } }),
  })
  const m = run(meddler, inputsAt(tape, NOW, { chain, legs }), stateWith(TRADE))
  assert.equal(m.action, 'hold')
  assert.deepEqual(
    [m.stateAfter.pb.trailArmed, m.stateAfter.pb.boxHi, m.stateAfter.pb.exiting, m.stateAfter.pb.entries, m.stateAfter.pb.stage, m.stateAfter.pb.tradeOpenMs, m.stateAfter.pb.doneForDay],
    [true, 25_100, false, 1, 0, TRADE.tradeOpenMs, false],
  )
})

test('the trailing floor: armed by the late start from pb_late_min, its peak restarts where it armed, and it fires at keep x that peak once held', () => {
  const { tape, chain } = market(at(781))
  const legs = spreadLegs(chain)
  const pass = (ms: number, pnl: number, st: RuleState): EngineDecision =>
    run(fake(), inputsAt(tape, ms, { chain, legs, cumRealized: pnl }), st)
  const before = pass(at(779), 2_500, stateWith(TRADE))
  assert.equal(before.stateAfter.pb.trailArmed, false, 'pb_trail_start 0: no floor before 13:00')
  assert.equal(before.stateAfter.pb.peakPnl, 2_500, 'the peak is tracked from the entry until a floor arms')
  const armed = pass(at(780), 2_400, before.stateAfter)
  assert.equal(armed.stateAfter.pb.trailArmed, true)
  assert.equal(armed.stateAfter.pb.peakPnl, 2_400, 'armed LATE: the peak restarts at the P&L it armed on')
  const above = pass(at(780) + 15_000, 1_441, armed.stateAfter)
  assert.equal(above.action, 'hold')
  assert.equal(above.stateAfter.pb.rupeeSinceMs, 0)
  const touch = pass(at(780) + 30_000, 1_440, above.stateAfter)
  assert.equal(touch.action, 'hold', 'at 60% of 2,400 the clock starts')
  const fired = pass(at(780) + 33_000, 1_420, touch.stateAfter)
  assert.equal(fired.trigger, 'dl-exit')
  assert.equal(fired.urgency, 'urgent')
  assert.match(fired.reason, /trailing floor: trade P&L Rs1,420 at or under 60% of the Rs2,400 peak/)
})

test('a floor armed at 13:00 does not close a winner on its morning peak; one armed earlier keeps the peak it tracked from the entry (D5, engine review finding 2)', () => {
  const { tape, chain } = market(at(781))
  const legs = spreadLegs(chain)
  const pass = (ms: number, pnl: number, st: RuleState, dials = DIALS): EngineDecision =>
    run(fake(), inputsAt(tape, ms, { chain, legs, cumRealized: pnl }), st, dials)
  // +9,000 at 11:00, +4,000 at 12:59: the late floor arms at 13:00 on 4,000.
  const morning = pass(at(660), 9_000, stateWith(TRADE))
  const lunch = pass(at(779), 4_000, morning.stateAfter)
  assert.equal(lunch.stateAfter.pb.peakPnl, 9_000)
  const armed = pass(at(780), 4_000, lunch.stateAfter)
  assert.equal(armed.stateAfter.pb.trailArmed, true)
  assert.equal(armed.stateAfter.pb.peakPnl, 4_000)
  const later = pass(at(780) + 3_000, 4_000, armed.stateAfter)
  assert.equal(later.action, 'hold', `closed at 13:00:03 on the morning's peak: ${later.reason}`)
  assert.equal(later.stateAfter.pb.rupeeSinceMs, 0)
  // A floor ARMED BEFORE 13:00 (Expiry Drive's morning start) keeps the peak it
  // has tracked since the entry: 60% of 9,000 is 5,400, and 4,000 is under it.
  const early = dialsOf({ pb_trail_start: 3_000, pb_late_trail_start: 3_000 })
  const armedAm = pass(at(640), 3_500, stateWith(TRADE), early)
  assert.equal(armedAm.stateAfter.pb.trailArmed, true)
  const peakAm = pass(at(660), 9_000, armedAm.stateAfter, early)
  const at13 = pass(at(780), 4_000, peakAm.stateAfter, early)
  assert.equal(at13.stateAfter.pb.peakPnl, 9_000)
  const fired = pass(at(780) + 3_000, 4_000, at13.stateAfter, early)
  assert.equal(fired.trigger, 'dl-exit')
  assert.match(fired.reason, /trailing floor: trade P&L Rs4,000 at or under 60% of the Rs9,000 peak/)
})

test('take profit on a whole debit spread is capped at pb_target_max_frac x its maximum; a naked long beside it, or a short not all held, keeps the plain target (engine review finding 3)', () => {
  const { tape, chain } = market()
  // The 24,950/25,150 call spread at 2 lots of 65, bought for 80 a share: at
  // most (200 - 80) x 130 = Rs15,600, so 0.7 of it, Rs10,920, is the line —
  // under the Rs12,000 target.
  const pair = (longLots = 2, shortLots = 2): LegView[] => [
    legOn(chain, 24_950, 'CE', 'Buy', longLots, { entry: 120, mtm: 0 }),
    legOn(chain, 25_150, 'CE', 'Sell', shortLots, { entry: 40, mtm: 0 }),
  ]
  const capped = dialsOf({ pb_target_max_frac: 0.7 })
  const held = stateWith({ ...TRADE, rupeeSinceMs: NOW - 3_000 })
  const pass = (legs: LegView[], pnl: number, dials: typeof DIALS = capped): EngineDecision =>
    run(fake(), inputsAt(tape, NOW, { chain, legs, cumRealized: pnl }), held, dials)
  const tp = pass(pair(), 10_920)
  assert.equal(tp.trigger, 'dl-exit')
  assert.equal(tp.urgency, 'passive')
  assert.match(tp.reason, /take profit: trade P&L Rs10,920 at or past Rs10,920 \(70% of the spread's Rs15,600 maximum\), held 3s/)
  assert.equal(pass(pair(), 10_919).action, 'hold')
  // 0 is off: the plain Rs12,000 target.
  assert.equal(pass(pair(), 11_999, DIALS).action, 'hold')
  // A ceiling over the target leaves the target alone.
  const loose = dialsOf({ pb_target_max_frac: 0.9 })
  assert.equal(pass(pair(), 11_999, loose).action, 'hold')
  assert.match(pass(pair(), 12_000, loose).reason, /take profit: trade P&L Rs12,000 at or past Rs12,000, held 3s/)
  // The pyramid's naked long beside the pair has no ceiling: the plain target.
  assert.equal(pass(pair(3, 2), 11_999).action, 'hold')
  assert.equal(pass(pair(3, 2), 12_000).trigger, 'dl-exit')
  // A short lot not yet held leaves a long option: the plain target.
  assert.equal(pass(pair(2, 1), 11_999).action, 'hold')
})

test('take profit is passive and held pb_rupee_hold_s; the time exit is passive and final, and the day stops once flat', () => {
  const { tape, chain } = market(at(721))
  const legs = spreadLegs(chain)
  const tp = (ms: number, pnl: number, st: RuleState): EngineDecision =>
    run(fake(), inputsAt(tape, ms, { chain, legs, cumRealized: pnl }), st)
  // One mark at the target is not a profit (O19): the shared rupee clock starts.
  const first = tp(NOW, 12_000, stateWith(TRADE))
  assert.equal(first.action, 'hold')
  assert.equal(first.stateAfter.pb.rupeeSinceMs, NOW)
  assert.equal(tp(NOW + 2_000, 11_999, first.stateAfter).stateAfter.pb.rupeeSinceMs, 0, 'back under the line: the clock resets')
  const held = tp(NOW + 3_000, 12_000, first.stateAfter)
  assert.equal(held.trigger, 'dl-exit')
  assert.equal(held.urgency, 'passive')
  assert.match(held.reason, /take profit: trade P&L Rs12,000 at or past Rs12,000, held 3s/)
  assert.equal(held.stateAfter.pb.doneForDay, false)

  const dials = dialsOf({ pb_time_exit_min: 720, pb_max_entries: 5 })
  const tx = run(fake(), inputsAt(tape, at(720), { chain, legs }), stateWith(TRADE), dials)
  assert.equal(tx.urgency, 'passive')
  assert.match(tx.reason, /time exit: 12:00 at or past 12:00/)
  assert.equal(tx.stateAfter.pb.doneForDay, true)
  const flat = run(fake(), inputsAt(tape, at(721), { chain }), tx.stateAfter, dials)
  assert.match(flat.reason, /trade finished .*— done for the day/)
  assert.equal(flat.stateAfter.dlStopped, true, 'entries left, but a final exit ends the day')
})

test('the index rules are the playbook\'s to skip while S is stale; the rupee stops still run (O1)', () => {
  const { tape, chain } = market()
  const legs = spreadLegs(chain)
  let sawStale = false
  const pbk = fake({
    exits: (ctx) => {
      if (!ctx.spotFresh) {
        sawStale = true
        return {}
      }
      return { exit: { reason: 'index stop', urgency: 'urgent', final: false } }
    },
  })
  const stale = run(pbk, inputsAt(tape, NOW, { chain, legs, spotAsOf: NOW - 11_000 }), stateWith(TRADE))
  assert.equal(sawStale, true)
  assert.equal(stale.action, 'hold', 'no index exit on a stale index')
  const hard = run(pbk, inputsAt(tape, NOW, { chain, legs, spotAsOf: NOW - 11_000, cumRealized: -7_000 }), stateWith({ ...TRADE, rupeeSinceMs: NOW - 5_000 }))
  assert.match(hard.reason, /hard stop/, 'a rupee stop does not need the index')
})

test('adds: a single-stage buy, add:true onto a held strike, capped by pb_max_adds and gated minus the window (D6)', () => {
  const { tape, chain } = market(at(880))
  const legs = spreadLegs(chain)
  let asked = 0
  const add: OpenPlan = { side: 'up', protective: [{ op: 'open', strike: 24_950, optType: 'CE', side: 'Buy', lots: 1 }], shorts: [], lots: 1, reason: 'pyramid' }
  const pbk = fake({ adds: () => { asked += 1; return { add } } })
  const dials = dialsOf({ pb_max_adds: 1 })
  const d = run(pbk, inputsAt(tape, at(880), { chain, legs, cumRealized: 1_000 }), stateWith(TRADE), dials)
  assert.equal(d.trigger, 'dl-add')
  assert.deepEqual(opens(d), [[24_950, 'CE', 'Buy', 1, true]], 'onto the held long: an add')
  assert.equal(d.stateAfter.pb.adds, 1)
  assert.equal(d.stateAfter.dlLastAdjustMs, at(880))
  assert.equal(d.markState.pb.adds, 0)
  assert.equal(asked, 1)

  const capped = run(pbk, inputsAt(tape, at(880), { chain, legs }), stateWith({ ...TRADE, adds: 1 }), dials)
  assert.equal(capped.action, 'hold')
  assert.equal(asked, 1, 'at the cap the playbook is not even asked')
  const paced = run(pbk, inputsAt(tape, at(880), { chain, legs }), stateWith(TRADE, { dlLastAdjustMs: at(880) - 10_000 }), dials)
  assert.equal(paced.action, 'hold')
  assert.match(paced.reason, /^fake: add wanted \(pyramid\) — 20s left of the 30s retry interval/)
  const selling = fake({ adds: () => ({ add: { ...add, shorts: [{ strike: 25_300, optType: 'CE', cover: 24_950 }] } }) })
  const refused = run(selling, inputsAt(tape, at(880), { chain, legs }), stateWith(TRADE), dials)
  assert.equal(refused.action, 'hold')
  assert.match(refused.reason, /an add is a single-stage buy/)
  // Buying the strike the book is SHORT would net the short away: refused.
  const netting = fake({ adds: () => ({ add: { ...add, protective: [{ op: 'open', strike: 25_150, optType: 'CE', side: 'Buy', lots: 1 }] } }) })
  const opposite = run(netting, inputsAt(tape, at(880), { chain, legs }), stateWith(TRADE), dials)
  assert.equal(opposite.action, 'hold')
  assert.match(opposite.reason, /plan refused: 25150CE is held short/)
})

// ── step 10: finishing, and re-entry ────────────────────────────────────────

test('a flat trade with nothing working finishes; re-entry waits for the cooldown; at pb_max_entries the day stops', () => {
  const { tape, chain } = market(NOW + 601_000)
  const done = run(opener(SPREAD), inputsAt(tape, NOW, { chain }), stateWith(TRADE))
  assert.match(done.reason, /^fake: trade finished/)
  assert.equal(done.stateAfter.dlStopped, false, '1 of 2 entries: the day goes on')
  assert.equal(done.stateAfter.pb.lastExitMs, NOW)
  const soon = run(opener(SPREAD), inputsAt(tape, NOW + 60_000, { chain }), done.stateAfter)
  assert.equal(soon.action, 'hold')
  assert.match(soon.reason, /^fake: no new risk — 540s left of the 600s re-entry cooldown/)
  const later = run(opener(SPREAD), inputsAt(tape, NOW + 600_000, { chain }), done.stateAfter)
  assert.equal(later.trigger, 'dl-open')
  assert.equal(later.stateAfter.pb.entries, 2)

  const last = run(opener(SPREAD), inputsAt(tape, NOW, { chain }), stateWith({ ...TRADE, entries: 2 }))
  assert.equal(last.stateAfter.dlStopped, true, 'the last entry finished: stopped for the day')
  const working = run(opener(SPREAD), inputsAt(tape, NOW, { chain, inFlight: true }), stateWith(TRADE))
  assert.match(working.reason, /^fake: the trade's package is working/)
  assert.equal(working.stateAfter.pb.tradeOpenMs, TRADE.tradeOpenMs)
})

// ── step 11: the new-risk gates ─────────────────────────────────────────────

test('every new-risk gate holds with a reason that names the playbook, the rule and the numbers', () => {
  const { tape, chain } = market()
  const pbk = opener(SPREAD)
  const gate = (over: InputsOver, st: RuleState = stateWith(), dials = DIALS): string => {
    const d = run(pbk, inputsAt(tape, NOW, { chain, ...over }), st, dials)
    assert.equal(d.action, 'hold', `${JSON.stringify(over)} should hold`)
    return d.reason
  }
  assert.match(gate({ dateIst: '2026-10-17' }), /^fake: no new risk — 2026-10-17 is not an NSE trading day$/)
  assert.match(gate({}, stateWith(), dialsOf({ pb_expiry_day_only: true, pb_min_dte: 0 })), /^fake: no new risk — wrong contract: the preset trades only today's expiry, and 2026-10-19 is 1 trading day\(s\) out$/)
  assert.match(gate({}, stateWith(), dialsOf({ pb_min_dte: 5 })), /^fake: no new risk — wrong contract: 2026-10-19 is 1 trading day\(s\) out, under the 5 the preset needs$/)
  assert.match(gate({}, stateWith(), dialsOf({ pb_entry_start_min: 620 })), /^fake: no new risk — 10:00 is outside the 10:20-14:30 entry window$/)
  assert.match(gate({}, stateWith(), dialsOf({ dl_warmup_min: 610 })), /^fake: no new risk — warm-up: 10:00 is before 10:10$/)
  assert.match(gate({}, stateWith({ doneForDay: true })), /^fake: no new risk — done for the day$/)
  assert.match(gate({}, stateWith({ entries: 2 })), /^fake: no new risk — 2 of 2 trade\(s\) taken today$/)
  assert.match(gate({}, stateWith({ lastExitMs: NOW - 60_000 })), /540s left of the 600s re-entry cooldown$/)
  assert.match(gate({}, stateWith({}, { dlLastAdjustMs: NOW - 10_000 })), /^fake: no new risk — 20s left of the 30s retry interval since the last package$/)
  assert.match(gate({ repairHold: true }), /^fake: no new risk — repair-Apply is working this tag$/)
  assert.match(gate({ pendingLots: 3 }), /^fake: no new risk — a package is working \(3 lot\(s\) pending\)$/)
  assert.match(gate({ inFlight: true }), /^fake: no new risk — a package is working \(0 lot\(s\) pending, a decision in flight\)$/)
  assert.match(gate({ spotAsOf: NOW - 11_000 }), /^fake: no new risk — the index is 11.0s stale, past 10s$/)
  const old = chainAt(NOW, OPEN, { quoteAsOf: NOW - 11_000 })
  assert.match(gate({ chain: old }), /^fake: no new risk — the chain is 11.0s old, past 10s$/)
  assert.match(gate({ chain: { ...old, asOf: NOW } }), /^fake: no new risk — the newest option quote is 11.0s old, past 10s: the option feed is frozen$/)
  assert.match(gate({ forwardSource: 'future' }), /^fake: no new risk — the chain's forward is future, not the contract's own \(parity or index-carry\)$/)
  assert.match(gate({ forwardSource: undefined }), /^fake: no new risk — the chain's forward is unknown, not the contract's own/)
  const noAtm = { ...chain, strikes: chain.strikes.map((r) => (r.strike === 25_000 ? { ...r, pe: null } : r)) }
  assert.match(gate({ chain: noAtm }), /^fake: no new risk — no ATM straddle reading$/)
  // A tape seconds old reads 'unknown': no regime, no risk.
  const young = new Tape(undefined, NOW - 5_000)
  const d = run(pbk, inputsAt(young, NOW, { chain }), stateWith())
  assert.match(d.reason, /^fake: no new risk — the regime is unknown$/)
})

test('the gap gates bind only when the gap is known (D10)', () => {
  const { tape, chain } = market()
  const pbk = opener(SPREAD)
  const open = run(fake(), inputsAt(tape, NOW, { chain }), stateWith()).markState.pb.dayOpen
  assert.ok(open > 0 && sessionOpenMs(DATE) === at(555))
  const prev = (pct: number): number => open / (1 + pct / 100)
  const min = dialsOf({ pb_gap_min_pct: 0.25 })
  const max = dialsOf({ pb_gap_max_pct: 0.6 })
  const small = run(pbk, inputsAt(tape, NOW, { chain, prevClose: prev(0.1) }), stateWith(), min)
  assert.match(small.reason, /^fake: no new risk — the opening gap is 0.10%, under the 0.25% minimum$/)
  const down = run(pbk, inputsAt(tape, NOW, { chain, prevClose: prev(-0.4) }), stateWith(), min)
  assert.equal(down.trigger, 'dl-open', 'a 0.4% gap DOWN is a gap: the size is absolute')
  const big = run(pbk, inputsAt(tape, NOW, { chain, prevClose: prev(0.8) }), stateWith(), max)
  assert.match(big.reason, /^fake: no new risk — the opening gap is 0.80%, at or over the 0.60% maximum$/)
  const unknown = run(pbk, inputsAt(tape, NOW, { chain, prevClose: null }), stateWith(), min)
  assert.equal(unknown.trigger, 'dl-open', 'an unknown previous close is not a small gap')
  // A book whose first fold came after 09:16 never saw the open, so it has no
  // opening gap at all — its first print is not the open (O9).
  const late = run(pbk, inputsAt(new Tape(undefined, at(590)), NOW, { chain, prevClose: prev(0.1) }), stateWith(), min)
  assert.equal(late.trigger, 'dl-open', `a late start read a gap: ${late.reason}`)
})

test('a wrong contract opens nothing every pass, while the exits still run (review focus 4, O11)', () => {
  const { tape, chain } = market()
  const expiryOnly = dialsOf({ pb_expiry_day_only: true, pb_min_dte: 0 })
  for (const ms of [NOW, NOW + 4_000, NOW + 8_000]) {
    const d = run(opener(SPREAD), inputsAt(tape, ms, { chain }), stateWith(), expiryOnly)
    assert.match(d.reason, /wrong contract/)
  }
  const exit = run(fake(), inputsAt(tape, NOW, { chain, legs: spreadLegs(chain), cumRealized: 12_000 }), stateWith({ ...TRADE, rupeeSinceMs: NOW - 3_000 }), expiryOnly)
  assert.equal(exit.trigger, 'dl-exit', 'take profit, wrong contract or not')
})

// ── refusals, retries and restarts ──────────────────────────────────────────

test('refund semantics: a refused stage 1 rolled back to markState keeps the entry; the retry waits pb_retry_s (O5, O24)', () => {
  const { tape, chain } = market(NOW + 30_000)
  const first = run(opener(SPREAD), inputsAt(tape, NOW, { chain }), stateWith())
  assert.equal(first.trigger, 'dl-open')
  // The host's rollback: markState, keeping the adjust stamp of an open.
  const rolled: RuleState = { ...first.markState, dlLastAdjustMs: first.stateAfter.dlLastAdjustMs }
  assert.equal(rolled.pb.entries, 0, 'refunded')
  assert.equal(rolled.pb.tradeOpenMs, 0)
  const soon = run(opener(SPREAD), inputsAt(tape, NOW + 4_000, { chain }), rolled)
  assert.equal(soon.action, 'hold')
  assert.match(soon.reason, /26s left of the 30s retry interval/)
  const retry = run(opener(SPREAD), inputsAt(tape, NOW + 30_000, { chain }), rolled)
  assert.equal(retry.trigger, 'dl-open')
  assert.equal(retry.stateAfter.pb.entries, 1, 'one entry, not two')
})

test('a quiet pass hands back the very state it was given: nothing to write', () => {
  const { tape, chain } = market()
  const legs = spreadLegs(chain)
  const warm = run(fake(), inputsAt(tape, NOW, { chain, legs }), stateWith(TRADE))
  const again = run(fake(), inputsAt(tape, NOW, { chain, legs }), warm.stateAfter)
  assert.equal(again.stateAfter, warm.stateAfter)
  assert.equal(again.markState, warm.stateAfter)
})

test('pb survives a JSON round trip mid-trade, and the next pass decides identically (review focus 3)', () => {
  const { tape, chain } = market(NOW + 4_000)
  const legs = spreadLegs(chain, 2, 0)
  const staged = stateWith({ ...TRADE, stage: 1, planShorts: SPREAD_PLAN, stageSpot: tape.ring.latest()?.spot ?? 0, stageReadyMs: 0, rupeeSinceMs: 0 }, { dlLastAdjustMs: NOW - 20_000 })
  const a = run(fake(), inputsAt(tape, NOW, { chain, legs }), staged)
  const raw = JSON.parse(JSON.stringify(a.stateAfter)) as RuleState
  const back: RuleState = { ...raw, pb: hydratePlaybookState(raw.pb) }
  assert.equal(JSON.stringify(back), JSON.stringify(a.stateAfter), 'key for key, in order')
  const next = run(fake(), inputsAt(tape, NOW + 4_000, { chain, legs }), a.stateAfter)
  const nextRestored = run(fake(), inputsAt(tape, NOW + 4_000, { chain, legs }), back)
  assert.deepEqual(nextRestored, next)
})

test('an id the registry does not hold trades nothing, and closes whatever is held', () => {
  const { tape, chain } = market()
  const none = makeDecidePlaybook(new Map())
  const flat = none(inputsAt(tape, NOW, { chain }), DIALS, stateWith(), MARK)
  assert.equal(flat.action, 'hold')
  assert.match(flat.reason, /^pb_playbook 99: names no playbook on this build/)
  const held = none(inputsAt(tape, NOW, { chain, legs: spreadLegs(chain) }), DIALS, stateWith(TRADE), MARK)
  assert.equal(held.trigger, 'dl-exit')
  assert.deepEqual(closes(held), [spreadLegs(chain)[1]?.instrument])
})

test('a plan the frame cannot stage safely is refused, and so is one that does not fit the cap or the order budget', () => {
  const { tape, chain } = market()
  const inputs = inputsAt(tape, NOW, { chain })
  const refused = (plan: OpenPlan, over: InputsOver = {}, dials = DIALS): string => {
    const d = run(opener(plan), Object.keys(over).length === 0 ? inputs : inputsAt(tape, NOW, { chain, ...over }), stateWith(), dials)
    assert.equal(d.action, 'hold')
    return d.reason
  }
  assert.match(refused({ ...SPREAD, shorts: [{ strike: 25_150, optType: 'CE', cover: 24_900 }] }), /plan refused: the 25150CE short names no protective CE at 24900/)
  assert.match(refused({ ...SPREAD, shorts: [{ strike: 25_150, optType: 'PE', cover: 24_950 }] }), /plan refused/)
  assert.match(refused({ ...SPREAD, shorts: [...SPREAD.shorts, { strike: 25_200, optType: 'CE', cover: 24_950 }] }), /plan refused: 2 CE short\(s\) against 1 CE long\(s\)/)
  assert.match(refused({ ...SPREAD, protective: [{ op: 'open', strike: 24_950, optType: 'CE', side: 'Sell', lots: 1 }] }), /plan refused: 24950CE is not a buy/)
  assert.match(refused({ ...SPREAD, lots: 0 }), /plan refused/)
  assert.match(refused(SPREAD, {}, dialsOf({ margin_cap: 1 })), /^fake: a CE debit spread — not one lot fits the Rs1 SPAN cap$/)
  assert.match(refused(SPREAD, { ordersThisMinute: DIALS.dl_max_orders_min }), /\[order budget\]$/)
})

// ── step 5: the session fold ────────────────────────────────────────────────

test('foldSession: the open, the filtered high and low, the longest hole, and the SAME object on a pass with nothing new', () => {
  const path = (ms: number): number => OPEN + (ms - at(555)) / 6_000 // +10 points a minute
  const tape = new Tape(path)
  tape.advanceTo(at(560))
  const fold = (ms: number, pb: PlaybookState): PlaybookState =>
    foldSession(pb, inputsAt(tape, ms), 705, 217)
  const a = fold(at(560), EMPTY_PLAYBOOK_STATE)
  assert.ok(Math.abs(a.dayOpen - (OPEN + 1 / 6)) < 1e-9, `the median of the first three prints from 09:15:00: ${a.dayOpen}`)
  assert.equal(a.statsFromMs, at(555))
  assert.ok(Math.abs(a.dayHigh - (OPEN + 50)) <= 0.2 && Math.abs(a.dayLow - OPEN) <= 0.2, JSON.stringify(a))
  assert.equal(a.maxGapMs, 1_000)
  assert.equal(dayComplete(a, DATE), true)
  assert.equal(fold(at(560), a), a, 'nothing new on the tape: the same object')

  // One bad print is outvoted by its neighbours.
  const spiky = new Tape((ms) => (ms === at(562) ? OPEN + 900 : path(ms)))
  spiky.advanceTo(at(562))
  const s1 = foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(spiky, at(562)), 705, 217)
  const s2 = foldSession(s1, inputsAt(spiky, at(563)), 705, 217)
  assert.ok(s1.dayHigh < OPEN + 100 && s2.dayHigh < OPEN + 100, `the spike leaked: ${s1.dayHigh} ${s2.dayHigh}`)
  // ...and so is a bad print AT 09:15:00, which would otherwise BE the open
  // every gap gate and excursion is measured from, all day.
  const badOpen = new Tape((ms) => (ms === at(555) ? OPEN + 250 : path(ms)))
  const o = foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(badOpen, at(556)), 705, 217)
  assert.ok(Math.abs(o.dayOpen - OPEN) < 1, `the bad opening print became the open: ${o.dayOpen}`)
  assert.ok(o.dayHigh < OPEN + 100)

  // A six-minute hole in the feed is the day's longest gap.
  const holed = new Tape()
  holed.advanceTo(at(570))
  holed.skipTo(at(576))
  const h1 = foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(holed, at(570)), 705, 217)
  const h2 = foldSession(h1, inputsAt(holed, at(580)), 705, 217)
  assert.ok(h2.maxGapMs >= 6 * 60_000, `${h2.maxGapMs}`)
  // Before 09:15 there is no session to fold.
  const pre = new Tape(undefined, at(540))
  assert.equal(foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(pre, at(550)), 705, 217), EMPTY_PLAYBOOK_STATE)
})

test('dayComplete needs the first fold by 09:16; Dday is frozen once, at the first straddle at or after 09:16', () => {
  const late = new Tape(undefined, at(600))
  const l = foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(late, at(605)), 705, 217)
  assert.equal(dayComplete(l, DATE), false, 'a supervisor that started at 10:00 never saw the open (O9)')
  assert.equal(dayComplete(EMPTY_PLAYBOOK_STATE, DATE), false)
  assert.equal(sessionOpenMs(DATE), at(555))

  const tape = new Tape()
  const early = foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(tape, at(555.5)), 750, 217)
  assert.equal(early.dayImplied, 0, '09:15 is not yet 09:16')
  const frozen = foldSession(early, inputsAt(tape, at(556)), 749, 217)
  assert.ok(Math.abs(frozen.dayImplied - 217 * Math.sqrt(375 / 749)) < 1e-9)
  const later = foldSession(frozen, inputsAt(tape, at(600)), 705, 300)
  assert.equal(later.dayImplied, frozen.dayImplied, 'frozen: a later straddle does not move it')
  const expiry = foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(tape, at(601)), 300, 120)
  assert.equal(expiry.dayImplied, 120, 'with under a session left, Dday is the straddle itself')
  const none = foldSession(EMPTY_PLAYBOOK_STATE, inputsAt(tape, at(602)), 705, null)
  assert.equal(none.dayImplied, 0, 'no straddle, nothing frozen')
})

test('the fold and the regime stamp ride on markState as well as stateAfter', () => {
  const tape = new Tape()
  const chain = chainAt(NOW, tape.advanceTo(NOW))
  const d = run(opener(SPREAD), inputsAt(tape, NOW, { chain }), stateWith({}, { dlRegime: '' }))
  assert.equal(d.trigger, 'dl-open')
  assert.ok(d.markState.pb.dayOpen > 0)
  assert.equal(d.markState.pb.dayOpen, d.stateAfter.pb.dayOpen)
  assert.equal(d.markState.dlRegime, d.stateAfter.dlRegime)
  assert.notEqual(d.markState.dlRegime, '')
})

// ── the registry ────────────────────────────────────────────────────────────

test('the registry names the six playbooks by pb_playbook, and decidePlaybook runs on it', () => {
  assert.deepEqual(
    [...PLAYBOOKS.entries()].map(([id, p]) => [id, p.id, p.name]),
    [
      [1, 1, 'trend-drive'], [2, 2, 'wing-straddle'], [3, 3, 'reversal'],
      [4, 4, 'expiry-drive'], [5, 5, 'expiry-theta'], [6, 6, 'expiry-gamma'],
    ],
  )
  const { tape, chain } = market()
  const d = decidePlaybook(inputsAt(tape, NOW, { chain }), dialsOf({ pb_playbook: 1 }), stateWith(), MARK)
  assert.equal(d.action, 'hold')
  assert.match(d.reason, /^trend-drive: /)
})
