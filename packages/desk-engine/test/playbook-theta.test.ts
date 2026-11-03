/**
 * WING STRADDLE (id 2) and EXPIRY THETA FLY (id 5) — six-playbooks spec v2
 * §5.2 and §5.5, pinned rule by rule, then run through whole sessions.
 *
 * One factory, `thetaFly`, two presets; the dials decide every difference:
 *
 *   ENTER   the slow regime quiet or chop, held `pb_confirm_s`; with
 *           `pb_max_move_k` on, the open seen (Wing Straddle: `dayComplete`;
 *           Theta Fly, whose calm filter is on: `dayRobust`) and the index
 *           within k x `Dday` of it; with `pb_calm_min` on, the last
 *           `pb_calm_min` minutes covered and ranging under `pb_calm_mult` x
 *           their implied move. The plan is the kit's iron fly, side `none`,
 *           `pb_lots` a leg, `entryStr` stamped.
 *   EXITS   the combined stop (shorts' ask-side value at (1 + k) x entry,
 *           rupee-debounced), the index stop (|S - entrySpot| >= k x entryStr,
 *           held `pb_stop_hold_s`), the trend exit (a trend held
 *           `pb_trend_exit_s`), all urgent; the credit take profit, passive.
 *           None final.
 *   ADDS    none.
 *
 * Every scenario asserts D1 (`nakedShortPasses === 0`) and a book flat by
 * 15:00.
 *
 * THE HARNESS'S CLOCK, AND WHY A CALM WING STRADDLE DAY LETS THE VOL DRIFT.
 * The scenario board prices a contract that expires on a LATER day off a
 * calendar-day tenor (`yearFrac` = days / 365) that does not move from 09:15 to
 * 15:30. A Wing Straddle trades a contract six sessions out, so inside one
 * simulated session it earns NO theta at all: a flat index at a flat vol quotes
 * the same fly all day, and the trade is the spread it paid plus its gamma. A
 * real session takes about one session of trading time off the straddle,
 * sqrt(MTE at the close / MTE at the open), 0.926 six sessions out. So the calm
 * Wing Straddle day (M5) is modelled with the ATM vol drifting down by exactly
 * that factor — the one lever the harness offers — and the same tape at a flat
 * vol is run beside it, its result asserted for what it is. On an EXPIRY day the
 * tenor is in minutes and the decay is real, so the Theta Fly's calm days hold
 * the vol flat.
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { Dials } from '../src/dials.ts'
import type { MarkContext } from '../src/guards.ts'
import { atmStraddleMid, impliedWindowMove } from '../src/delta-lean/regime.ts'
import { decidePlaybook } from '../src/delta-lean/playbook/decide.ts'
import { PLAYBOOKS } from '../src/delta-lean/playbook/registry.ts'
import { EXPIRY_THETA, WING_STRADDLE } from '../src/delta-lean/playbook/theta-fly.ts'
import type { PlaybookCtx, PlaybookStep } from '../src/delta-lean/playbook/types.ts'
import type { DeltaLeanInputs } from '../src/delta-lean/decide.ts'
import type { ChainSnap, EngineAction, EngineDecision, LegView, OptType, PlaybookState, Quote, RuleState } from '../src/types.ts'
import { buildChain, STEP } from './scenario/chain-model.ts'
import { indexPath, istMs, type ScenarioSpec, type Segment } from './scenario/paths.ts'
import { minutesToExpiry, presetDials, runSession, type DecideFn, type SimResult } from './scenario/sim.ts'
import { at, chainAt, ctxOf, DATE, inputsAt, legOn, OPEN, stateWith, Tape, tapeRead } from './playbook-fixture.ts'

const WING = presetDials('pb-wing-straddle')
const THETA = presetDials('pb-expiry-theta')
const MARK: MarkContext = { isNewMark: true, markIndexToday: 9 }

/** A `Dday` for the hand-built contexts: a round number the gates can be read against. */
const DDAY = 160

/**
 * The slack on a rupee bound: what can land between a stop's condition and
 * the book being flat. The rupee stops fire on the first pass at least
 * `pb_rupee_hold_s` (3 s) into their zone — one 4 s pass — and the D2 close
 * takes a second pass for the wings after the shorts; at one or two lots, on
 * tapes moving at most ~1 point a second, both are tens of rupees, and the
 * close pays the spread once more. Stated once, and never sized off a result.
 */
const SLACK = 1_000

// ── the hand-built contexts of the unit tests ──────────────────────────────

/**
 * The context a FLAT book is handed at `ms` on the fixture's tape (calm by
 * default), every entry condition met: quiet for 130 s, the open seen at
 * `OPEN` from 09:15:00, `Dday` 160, no hole. A test closes the one gate it is
 * about by overriding it.
 */
function entryCtx(dials: Dials, ms: number, over: Partial<PlaybookCtx> = {}, pb: Partial<PlaybookState> = {}, tape = new Tape()): PlaybookCtx {
  const inputs = inputsAt(tape, ms)
  const base = ctxOf(inputs, dials, { dayOpen: OPEN, statsFromMs: at(555), dayImplied: DDAY, ...pb })
  const str = base.str
  return {
    ...base,
    regime: 'quiet',
    regimeHeldMs: 130_000,
    dayComplete: true,
    dayRobust: true,
    dayImplied: DDAY,
    imp: (m) => (str === null ? null : impliedWindowMove(str, inputs.minutesToExpiry, m * 60)),
    ...over,
  }
}

const quoteOf = (chain: ChainSnap, bid: number | null, ask: number | null): Quote =>
  ({ bid, ask, ltp: ask ?? bid, asOf: chain.asOf })

/**
 * A whole one-lot fly held on `chain`: wings at `centre ± wing`, the shorts
 * sold at `shortEntry` and asked at `shortAsk` now (null = no ask). Every mtm
 * is 0, so `totalPnl` is `cumRealized` exactly and a test scripts the P&L
 * there.
 */
function flyHeld(
  chain: ChainSnap,
  o: { readonly centre?: number; readonly wing?: number; readonly lots?: number; readonly shortEntry?: number; readonly shortAsk?: number | null; readonly wingEntry?: number } = {},
): LegView[] {
  const centre = o.centre ?? 25_000
  const wing = o.wing ?? 450
  const lots = o.lots ?? 1
  const entry = o.shortEntry ?? 200
  const ask = o.shortAsk === undefined ? entry : o.shortAsk
  const short = (t: OptType): LegView =>
    legOn(chain, centre, t, 'Sell', lots, { entry, exit: quoteOf(chain, ask === null ? entry - 1 : ask - 1, ask), mtm: 0 })
  const long = (k: number, t: OptType): LegView =>
    legOn(chain, k, t, 'Buy', lots, { entry: o.wingEntry ?? 10, mtm: 0 })
  return [long(centre + wing, 'CE'), long(centre - wing, 'PE'), short('CE'), short('PE')]
}

/** A trade open since 09:30 on the fixture's money, staged whole. */
const TRADE: Partial<PlaybookState> = {
  entries: 1, tradeOpenMs: at(570), side: 'none', planLots: 1, stageMs: at(570), stageSpot: OPEN,
  stageReadyMs: at(570) + 4_000, entrySpot: OPEN, entryStr: 250, basePnl: 0,
}

/** The context a HELD fly is handed at `ms`: the fixture's calm tape, `legs`
 * held, `cumRealized` the scripted P&L. */
function heldCtx(
  dials: Dials,
  ms: number,
  legsOf: (chain: ChainSnap) => LegView[],
  over: Partial<PlaybookCtx> = {},
  pb: Partial<PlaybookState> = {},
  cumRealized = 0,
): PlaybookCtx {
  const tape = new Tape()
  const level = tape.advanceTo(ms)
  const chain = chainAt(ms, level)
  const inputs = inputsAt(tape, ms, { chain, legs: legsOf(chain), cumRealized })
  const base = ctxOf(inputs, dials, { ...TRADE, ...pb })
  // The slow window reads the label the test sets (fixture `tapeRead`): the
  // trend exit acts only on a trend the tape still shows (kit `onTape`, M11).
  return { ...base, regime: 'quiet', regimeHeldMs: 600_000, read: tapeRead(base.read, over.regime ?? 'quiet'), ...over }
}

const exitOf = (s: PlaybookStep): NonNullable<PlaybookStep['exit']> => {
  assert.ok(s.exit !== undefined, `an exit, got ${JSON.stringify(s)}`)
  return s.exit
}

// ── the registry ────────────────────────────────────────────────────────────

test('the registry: pb_playbook 2 is wing-straddle and 5 is expiry-theta, one factory, no adds', () => {
  assert.equal(PLAYBOOKS.get(2), WING_STRADDLE)
  assert.equal(PLAYBOOKS.get(5), EXPIRY_THETA)
  assert.deepEqual([WING_STRADDLE.id, WING_STRADDLE.name, EXPIRY_THETA.id, EXPIRY_THETA.name], [2, 'wing-straddle', 5, 'expiry-theta'])
  for (const p of [WING_STRADDLE, EXPIRY_THETA]) {
    const ctx = heldCtx(p === WING_STRADDLE ? WING : THETA, at(630), (c) => flyHeld(c))
    assert.deepEqual(p.adds(ctx), {}, `${p.name}: a fly never pyramids`)
  }
})

// ── enter: the regime ───────────────────────────────────────────────────────

test('enter: only into quiet or chop, held pb_confirm_s (inclusive) — never a trend, never unknown', () => {
  for (const [p, dials, ms] of [[WING_STRADDLE, WING, at(600)], [EXPIRY_THETA, THETA, at(800)]] as const) {
    for (const regime of ['trend-up', 'trend-down', 'unknown'] as const) {
      const v = p.enter(entryCtx(dials, ms, { regime, regimeHeldMs: 3_600_000 }))
      assert.equal(v.kind, 'wait', regime)
      assert.match(v.kind === 'wait' ? v.reason : '', new RegExp(`^the slow regime is ${regime}, not quiet or chop`))
    }
    const young = p.enter(entryCtx(dials, ms, { regime: 'chop', regimeHeldMs: 119_999 }))
    assert.equal(young.kind, 'wait')
    assert.match(young.kind === 'wait' ? young.reason : '', /^chop has held 119s of the 120s it needs/)
    for (const regime of ['quiet', 'chop'] as const) {
      const v = p.enter(entryCtx(dials, ms, { regime, regimeHeldMs: 120_000 }))
      assert.equal(v.kind, 'open', `${p.name}: ${regime} held exactly pb_confirm_s opens`)
    }
  }
})

// ── enter: the day gate, by the dials ───────────────────────────────────────

test('enter: with pb_max_move_k on, the Wing Straddle (calm filter off) needs dayComplete; the Theta Fly (calm filter on) needs dayRobust', () => {
  const wingNoOpen = WING_STRADDLE.enter(entryCtx(WING, at(600), { dayComplete: false, dayRobust: false }))
  assert.equal(wingNoOpen.kind, 'wait')
  assert.match(wingNoOpen.kind === 'wait' ? wingNoOpen.reason : '', /did not see the open/)
  const wingHole = WING_STRADDLE.enter(entryCtx(WING, at(600), { dayComplete: true, dayRobust: false }))
  assert.equal(wingHole.kind, 'open', 'a hole in the tape does not stop the Wing Straddle: spec §5.2 asks dayComplete only')

  const thetaHole = EXPIRY_THETA.enter(entryCtx(THETA, at(800), { dayComplete: true, dayRobust: false }, { maxGapMs: 6 * 60_000 }))
  assert.equal(thetaHole.kind, 'wait')
  assert.match(thetaHole.kind === 'wait' ? thetaHole.reason : '', /hole of 6\.0 min in today's tape, past the 5 min/)
  const thetaNoOpen = EXPIRY_THETA.enter(entryCtx(THETA, at(800), { dayComplete: false, dayRobust: false }))
  assert.equal(thetaNoOpen.kind, 'wait')
  assert.match(thetaNoOpen.kind === 'wait' ? thetaNoOpen.reason : '', /did not see the open/)
  assert.equal(EXPIRY_THETA.enter(entryCtx(THETA, at(800))).kind, 'open')

  // pb_max_move_k 0 switches the whole day gate off, open seen or not.
  const off = WING_STRADDLE.enter(entryCtx({ ...WING, pb_max_move_k: 0 }, at(600), { dayComplete: false, dayRobust: false, dayImplied: null }))
  assert.equal(off.kind, 'open')
  const noDday = WING_STRADDLE.enter(entryCtx(WING, at(600), { dayImplied: null }))
  assert.equal(noDday.kind, 'wait')
  assert.match(noDday.kind === 'wait' ? noDday.reason : '', /no Dday yet/)
})

test('enter: |S - O| <= pb_max_move_k x Dday, inclusive — 0.75 on the Wing Straddle, 1.2 on the Theta Fly; a stale S measures nothing', () => {
  const flat = (): Tape => new Tape(() => OPEN)
  for (const [p, dials, ms, k] of [[WING_STRADDLE, WING, at(600), 0.75], [EXPIRY_THETA, THETA, at(800), 1.2]] as const) {
    const limit = k * DDAY
    for (const sign of [1, -1]) {
      const edge = p.enter(entryCtx(dials, ms, {}, { dayOpen: OPEN - sign * limit }, flat()))
      assert.equal(edge.kind, 'open', `${p.name}: exactly ${limit} from the open still opens`)
      const past = p.enter(entryCtx(dials, ms, {}, { dayOpen: OPEN - sign * (limit + 0.5) }, flat()))
      assert.equal(past.kind, 'wait')
      assert.match(past.kind === 'wait' ? past.reason : '', new RegExp(`the index is ${(limit + 0.5).toFixed(1)} from the ${(OPEN - sign * (limit + 0.5)).toFixed(1)} open, past ${k} x the 160\\.0 Dday \\(${limit.toFixed(1)}\\)`))
    }
    const stale = p.enter(entryCtx(dials, ms, { spotFresh: false }, {}, flat()))
    assert.equal(stale.kind, 'wait')
    assert.match(stale.kind === 'wait' ? stale.reason : '', /the index is stale/)
  }
})

test('enter: the move from the open is measured on the STEADIED index — one bad print can neither close the day gate nor open it (M11, engine review finding 5)', () => {
  for (const [p, dials, ms, k] of [[WING_STRADDLE, WING, at(600), 0.75], [EXPIRY_THETA, THETA, at(800), 1.2]] as const) {
    const limit = k * DDAY
    // At the open, this pass's one print three limits away: still opens.
    const spike = new Tape((t) => (t === ms ? OPEN + 3 * limit : OPEN))
    const opened = p.enter(entryCtx(dials, ms, {}, {}, spike))
    assert.equal(opened.kind, 'open', `${p.name}: ${opened.kind === 'wait' ? opened.reason : ''}`)
    // Two limits away, this pass's one print back at the open: still waits.
    const back = new Tape((t) => (t === ms ? OPEN : OPEN + 2 * limit))
    const waited = p.enter(entryCtx(dials, ms, {}, {}, back))
    assert.equal(waited.kind, 'wait', `${p.name}: one print at the open opened the gate`)
    assert.match(waited.kind === 'wait' ? waited.reason : '', new RegExp(`^the index is ${(2 * limit).toFixed(1)} from the ${OPEN.toFixed(1)} open`))
  }
})

// ── enter: the calm filter (Theta Fly) ──────────────────────────────────────

test('enter: the calm filter — the last pb_calm_min minutes covered and ranging <= pb_calm_mult x imp(pb_calm_min); off on the Wing Straddle', () => {
  const ms = at(810) // 13:30
  const calmCtx = entryCtx(THETA, ms)
  const imp30 = calmCtx.imp(30)
  assert.ok(imp30 !== null && imp30 > 0)
  assert.equal(EXPIRY_THETA.enter(calmCtx).kind, 'open', 'the fixture tape ranges 8 points in 30 minutes')

  // A 100-point lurch at 13:10-13:15, back by 13:30: wider than 1.5 x imp(30).
  const lurch = new Tape((t) => OPEN + 4 * Math.sin((2 * Math.PI * (t - at(555))) / 200_000) + (t >= at(790) && t < at(795) ? 100 : 0))
  const wide = EXPIRY_THETA.enter(entryCtx(THETA, ms, {}, {}, lurch))
  assert.equal(wide.kind, 'wait')
  assert.match(wide.kind === 'wait' ? wide.reason : '', new RegExp(`not calm: the last 30 min ranged 10\\d\\.\\d, past 1\\.5 x the ${imp30.toFixed(1)} implied move \\(${(1.5 * imp30).toFixed(1)}\\)`))
  assert.equal(WING_STRADDLE.enter(entryCtx(WING, ms, {}, {}, lurch)).kind, 'open', 'pb_calm_min 0: the Wing Straddle has no calm filter')

  // A ten-minute hole inside the window: the ring does not cover it.
  const holed = new Tape()
  holed.advanceTo(at(790))
  holed.skipTo(at(800))
  const blind = EXPIRY_THETA.enter(entryCtx(THETA, ms, {}, {}, holed))
  assert.equal(blind.kind, 'wait')
  assert.match(blind.kind === 'wait' ? blind.reason : '', /the ring does not cover the last 30 min/)

  const noImp = EXPIRY_THETA.enter(entryCtx(THETA, ms, { imp: () => null }))
  assert.equal(noImp.kind, 'wait')
  assert.match(noImp.kind === 'wait' ? noImp.reason : '', /no implied move over 30 min/)
})

// ── enter: the plan ─────────────────────────────────────────────────────────

test('enter: the plan is the kit\'s iron fly — side none, pb_lots a leg, each short covered by its own wing, entryStr stamped', () => {
  // The wing distance is the preset's own (presets.test.ts pins the values).
  for (const [p, dials, ms, lots] of [[WING_STRADDLE, WING, at(600), 1], [EXPIRY_THETA, THETA, at(800), 2]] as const) {
    const minSteps = dials.pb_wing_min_steps
    const k = dials.pb_wing_str_k
    const ctx = entryCtx(dials, ms)
    const v = p.enter(ctx)
    assert.ok(v.kind === 'open', `${p.name} opens`)
    const str = ctx.str
    assert.ok(str !== null)
    const step = ctx.inputs.chain.step
    const centre = 25_000
    const w = Math.max(minSteps, Math.round((k * str) / step)) * step
    const plan = v.plan
    assert.equal(plan.side, 'none')
    assert.equal(plan.lots, lots)
    assert.deepEqual(plan.protective.map((a) => [a.strike, a.optType, a.side, a.lots]), [[centre + w, 'CE', 'Buy', 1], [centre - w, 'PE', 'Buy', 1]])
    assert.deepEqual(plan.shorts, [
      { strike: centre, optType: 'CE', cover: centre + w },
      { strike: centre, optType: 'PE', cover: centre - w },
    ])
    assert.deepEqual(plan.stamps, { entryStr: str })
    assert.match(plan.reason, new RegExp(`an iron fly at ${centre}, wings ${centre - w}PE / ${centre + w}CE`))
  }
})

test('enter: no fly on the board — a wing without a two-sided quote — is a wait, never half a fly', () => {
  const tape = new Tape()
  const level = tape.advanceTo(at(600))
  const board = chainAt(at(600), level)
  // Every CE four or more steps above the money has lost its bid.
  const oneSided: ChainSnap = {
    ...board,
    strikes: board.strikes.map((r) => (r.strike >= 25_200 && r.ce !== null ? { ...r, ce: { ...r.ce, bid: null } } : r)),
  }
  const ctx: PlaybookCtx = { ...entryCtx(WING, at(600)), inputs: inputsAt(tape, at(600), { chain: oneSided }) }
  const v = WING_STRADDLE.enter(ctx)
  assert.equal(v.kind, 'wait')
  assert.match(v.kind === 'wait' ? v.reason : '', /no fly on this board/)
})

// ── exits: the combined stop ────────────────────────────────────────────────

test('exits: the combined stop — the shorts\' ask-side value at or past (1 + pb_combined_stop) x entry, held pb_rupee_hold_s: urgent, not final', () => {
  const ms = at(630)
  const under = WING_STRADDLE.exits(heldCtx(WING, ms, (c) => flyHeld(c, { shortEntry: 200, shortAsk: 249.95 })))
  assert.equal(under.exit, undefined)
  assert.equal(under.patch?.rupeeSinceMs, undefined, 'out of its zone it says nothing: the frame resets the shared clock')

  const zone = WING_STRADDLE.exits(heldCtx(WING, ms, (c) => flyHeld(c, { shortEntry: 200, shortAsk: 250 })))
  assert.equal(zone.exit, undefined, 'exactly 1.25x is in the zone, but not yet held')
  assert.equal(zone.patch?.rupeeSinceMs, ms, 'the first pass in the zone stamps the clock')
  assert.match(zone.note ?? '', /combined stop in its zone: the shorts at 1\.25x their entry value, held 0s of 3s/)

  const almost = WING_STRADDLE.exits(heldCtx(WING, ms, (c) => flyHeld(c, { shortAsk: 250 }), {}, { rupeeSinceMs: ms - 2_999 }))
  assert.equal(almost.exit, undefined)
  assert.equal(almost.patch?.rupeeSinceMs, ms - 2_999, 'the clock is kept, not restamped')

  const fired = WING_STRADDLE.exits(heldCtx(WING, ms, (c) => flyHeld(c, { shortAsk: 260 }), {}, { rupeeSinceMs: ms - 3_000 }))
  const e = exitOf(fired)
  assert.deepEqual([e.urgency, e.final], ['urgent', false])
  assert.match(e.reason, /^combined stop: the shorts' ask-side value Rs33,800 is 1\.30x their Rs26,000 entry value, at or past 1\.25x, held 3s$/)

  const blind = WING_STRADDLE.exits(heldCtx(WING, ms, (c) => flyHeld(c, { shortAsk: null }), {}, { rupeeSinceMs: ms - 60_000 }))
  assert.equal(blind.exit, undefined, 'a short with no ask is no reading: half a straddle is not a cheap one')
  assert.equal(blind.patch?.rupeeSinceMs, undefined)

  const off = EXPIRY_THETA.exits(heldCtx(THETA, ms, (c) => flyHeld(c, { shortAsk: 400 }), {}, { rupeeSinceMs: ms - 60_000 }))
  assert.equal(off.exit, undefined, 'pb_combined_stop 0: the Theta Fly has none')
})

// ── exits: the index stop ───────────────────────────────────────────────────

test('exits: the index stop — |S - entrySpot| >= pb_stop_str_k x entryStr, held pb_stop_hold_s on condSinceMs: urgent, not final; skipped while S is stale', () => {
  const ms = at(630)
  const legs = (c: ChainSnap): LegView[] => flyHeld(c)
  const near = WING_STRADDLE.exits(heldCtx(WING, ms, legs, {}, { entrySpot: OPEN - 240, entryStr: 250, condSinceMs: ms - 60_000 }))
  assert.equal(near.exit, undefined)
  assert.equal(near.patch?.condSinceMs, 0, 'out of its zone the index clock resets')

  const first = WING_STRADDLE.exits(heldCtx(WING, ms, legs, {}, { entrySpot: OPEN - 300, entryStr: 250 }))
  assert.equal(first.exit, undefined)
  assert.equal(first.patch?.condSinceMs, ms)
  assert.match(first.note ?? '', /index stop in its zone: the index is 300\.0 from the entry, held 0s of 20s/)

  const held = WING_STRADDLE.exits(heldCtx(WING, ms, legs, {}, { entrySpot: OPEN + 300, entryStr: 250, condSinceMs: ms - 20_000 }))
  const e = exitOf(held)
  assert.deepEqual([e.urgency, e.final], ['urgent', false])
  assert.match(e.reason, /^index stop: the index is 300\.0 from the 25300\.0 entry, at or past 1 x the 250\.0 entry straddle \(250\.0\), held 20s$/)
  assert.equal(held.patch?.condSinceMs, ms - 20_000)

  const stale = WING_STRADDLE.exits(heldCtx(WING, ms, legs, { spotFresh: false }, { entrySpot: OPEN - 300, entryStr: 250, condSinceMs: ms - 60_000 }))
  assert.equal(stale.exit, undefined, 'a stale S measures nothing')
  assert.equal(stale.patch?.condSinceMs, 0)
  const unitless = WING_STRADDLE.exits(heldCtx(WING, ms, legs, {}, { entrySpot: OPEN - 300, entryStr: 0, condSinceMs: ms - 60_000 }))
  assert.equal(unitless.exit, undefined, 'no entry straddle is no unit: never k x 0')

  const off = EXPIRY_THETA.exits(heldCtx(THETA, ms, legs, {}, { entrySpot: OPEN - 2_000, entryStr: 50, condSinceMs: ms - 60_000 }))
  assert.equal(off.exit, undefined, 'pb_stop_str_k 0: the Theta Fly has no index stop (spec §5.5)')
  assert.equal(off.patch?.condSinceMs, undefined, 'and does not touch its clock')
})

// ── exits: the trend exit ───────────────────────────────────────────────────

test('exits: the trend exit — a trend held pb_trend_exit_s (inclusive): urgent, not final; off on the Wing Straddle', () => {
  const ms = at(820)
  const legs = (c: ChainSnap): LegView[] => flyHeld(c, { lots: 2 })
  for (const regime of ['trend-up', 'trend-down'] as const) {
    const young = EXPIRY_THETA.exits(heldCtx(THETA, ms, legs, { regime, regimeHeldMs: 59_999 }))
    assert.equal(young.exit, undefined)
    const e = exitOf(EXPIRY_THETA.exits(heldCtx(THETA, ms, legs, { regime, regimeHeldMs: 60_000 })))
    assert.deepEqual([e.urgency, e.final], ['urgent', false])
    assert.match(e.reason, new RegExp(`^trend exit: the slow regime is ${regime}, held 60s \\(the 60s bar\\) — a fly is the wrong book in a trend$`))
  }
  for (const regime of ['quiet', 'chop', 'unknown'] as const) {
    assert.equal(EXPIRY_THETA.exits(heldCtx(THETA, ms, legs, { regime, regimeHeldMs: 3_600_000 })).exit, undefined, regime)
  }
  assert.equal(WING_STRADDLE.exits(heldCtx(WING, at(630), (c) => flyHeld(c), { regime: 'trend-up', regimeHeldMs: 3_600_000 })).exit, undefined)
  // A trend LABEL the tape no longer shows — the detector's dwell after one bad
  // print — is no gamma blast: the fly is held (M11).
  const dwell = heldCtx(THETA, ms, legs, { regime: 'trend-up', regimeHeldMs: 90_000 })
  assert.equal(EXPIRY_THETA.exits({ ...dwell, read: tapeRead(dwell.read, 'chop') }).exit, undefined)
})

// ── exits: the credit take profit ───────────────────────────────────────────

test('exits: the take profit — trade P&L at or past pb_target_frac of the credit, held pb_rupee_hold_s: passive, not final; never on a debit, off on the Wing Straddle', () => {
  const ms = at(840)
  // Two lots of 65: wings bought at 2, shorts sold at 20 — a credit of
  // (40 - 4) x 130 = Rs4,680, half of it Rs2,340.
  const legs = (c: ChainSnap): LegView[] => flyHeld(c, { lots: 2, wing: 100, shortEntry: 20, wingEntry: 2 })
  const ctx = heldCtx(THETA, ms, legs, {}, {}, 2_340)
  assert.equal(ctx.cost, -4_680)
  // One mark at the line — a briefly wide ask on an ATM short reads as profit
  // too — starts the shared rupee clock and banks nothing (O19, engine review
  // finding 4).
  const first = EXPIRY_THETA.exits(ctx)
  assert.equal(first.exit, undefined)
  assert.equal(first.patch?.rupeeSinceMs, ms)
  assert.match(first.note ?? '', /^take profit in its zone: 50% of the Rs4,680 credit, held 0s of 3s — trade P&L Rs2,340$/)
  const e = exitOf(EXPIRY_THETA.exits(heldCtx(THETA, ms, legs, {}, { rupeeSinceMs: ms - 3_000 }, 2_340)))
  assert.deepEqual([e.urgency, e.final], ['passive', false])
  assert.match(e.reason, /^take profit: trade P&L Rs2,340 is 50% of the Rs4,680 credit, at or past 50%, held 3s$/)
  const under = EXPIRY_THETA.exits(heldCtx(THETA, ms, legs, {}, { rupeeSinceMs: ms - 3_000 }, 2_339))
  assert.equal(under.exit, undefined)
  assert.deepEqual(under.patch, {}, 'under the line: no claim on the clock, so the frame resets it')

  const debit = (c: ChainSnap): LegView[] => [legOn(c, 25_100, 'CE', 'Buy', 2, { entry: 30, mtm: 0 })]
  assert.equal(EXPIRY_THETA.exits(heldCtx(THETA, ms, debit, {}, {}, 50_000)).exit, undefined, 'a debit has no credit to take a share of')
  assert.equal(WING_STRADDLE.exits(heldCtx(WING, ms, legs, {}, {}, 50_000)).exit, undefined, 'pb_target_frac 0 on the Wing Straddle')
})

test('exits: in spec order — the combined stop before the index stop, the trend exit before the passive take profit', () => {
  const ms = at(630)
  const both = WING_STRADDLE.exits(heldCtx(WING, ms, (c) => flyHeld(c, { shortAsk: 260 }), {}, { rupeeSinceMs: ms - 3_000, entrySpot: OPEN - 300, entryStr: 250, condSinceMs: ms - 20_000 }))
  assert.match(exitOf(both).reason, /^combined stop/)
  assert.equal(both.patch?.condSinceMs, ms - 20_000, 'the index clock still rides the patch')
  const legs = (c: ChainSnap): LegView[] => flyHeld(c, { lots: 2, wing: 100, shortEntry: 20, wingEntry: 2 })
  const trendAndProfit = EXPIRY_THETA.exits(heldCtx(THETA, at(840), legs, { regime: 'trend-down', regimeHeldMs: 90_000 }, {}, 3_000))
  assert.match(exitOf(trendAndProfit).reason, /^trend exit/)
  assert.equal(exitOf(trendAndProfit).urgency, 'urgent')
})

// ── through the frame ───────────────────────────────────────────────────────

const WING_DATE = '2026-10-16' // a Friday
const WING_EXPIRY = '2026-10-27' // NIFTY's weekly six sessions out (20 Oct is Dussehra)
const THETA_DATE = '2026-10-27' // that weekly's own expiry day, a Tuesday

/** Two passes of the production frame on the fixture tape, `gapS` apart: the
 * first stamps whatever regime the frame reads, the second is decided on it. */
function twoPasses(dials: Dials, fromMs: number, gapS: number, over: { readonly expiry?: string } = {}): { readonly first: EngineDecision; readonly second: EngineDecision } {
  const tape = new Tape()
  const pass = (ms: number, state: RuleState): EngineDecision => {
    const level = tape.advanceTo(ms)
    const chain = chainAt(ms, level, over.expiry === undefined ? {} : { expiry: over.expiry })
    return decidePlaybook(inputsAt(tape, ms, { chain, expiry: chain.expiry }), dials, state, MARK)
  }
  const first = pass(fromMs, stateWith())
  return { first, second: pass(fromMs + gapS * 1000, first.markState) }
}

test('through the frame: a Wing Straddle on a calm morning stages its two wings first, at one lot, the shorts kept as planShorts', () => {
  const { first, second } = twoPasses(WING, at(595), 300, { expiry: WING_EXPIRY })
  assert.equal(first.action, 'hold')
  assert.match(first.reason, /^wing-straddle: (quiet|chop) has held 0s of the 120s it needs/)
  assert.equal(second.trigger, 'dl-open')
  const buys = second.actions.flatMap((a: EngineAction) => (a.op === 'open' ? [[a.strike, a.optType, a.side, a.lots]] : []))
  assert.equal(buys.length, 2)
  assert.ok(buys.every(([, , side, lots]) => side === 'Buy' && lots === 1), JSON.stringify(buys))
  const pb = second.stateAfter.pb
  assert.equal(pb.stage, 1)
  assert.equal(pb.planLots, 1)
  assert.equal(pb.side, 'none')
  assert.deepEqual(pb.planShorts.map((s) => [s.strike, s.optType]), [[25_050, 'CE'], [25_050, 'PE']])
  assert.deepEqual(pb.planShorts.map((s) => s.cover), buys.map(([k]) => k))
  assert.ok(pb.entryStr > 400, `entryStr is the 27 Oct straddle, ${pb.entryStr}`)
  assert.equal(second.markState.pb.entries, 0, 'markState is the book before the open (a refusal refunds it)')
})

test('through the frame: an Expiry Theta Fly opens on a calm 0-DTE afternoon at two lots — and not before 13:00', () => {
  const { second } = twoPasses(THETA, at(796), 240, { expiry: DATE })
  assert.equal(second.trigger, 'dl-open')
  const buys = second.actions.flatMap((a: EngineAction) => (a.op === 'open' ? [[a.optType, a.side, a.lots]] : []))
  assert.deepEqual(buys, [['CE', 'Buy', 2], ['PE', 'Buy', 2]])
  const morning = twoPasses(THETA, at(700), 240, { expiry: DATE }).second
  assert.equal(morning.action, 'hold')
  assert.match(morning.reason, /^expiry-theta: no new risk — 11:4\d is outside the 13:00-14:15 entry window/)
})

test('through the frame: the combined stop\'s rupee clock rides markState — stamped in its zone, fired one 4 s pass later, reset out of it; the close buys the shorts back first', () => {
  const tape = new Tape()
  const pass = (ms: number, ask: number, state: RuleState): EngineDecision => {
    const level = tape.advanceTo(ms)
    const chain = chainAt(ms, level, { expiry: WING_EXPIRY })
    return decidePlaybook(inputsAt(tape, ms, { chain, expiry: WING_EXPIRY, legs: flyHeld(chain, { shortAsk: ask }) }), WING, state, MARK)
  }
  const st = stateWith({ ...TRADE, entrySpot: OPEN }, { dlRegime: 'quiet', dlRegimeSinceMs: at(560) })
  const t0 = at(630)
  const zone = pass(t0, 255, st)
  assert.equal(zone.action, 'hold')
  assert.equal(zone.markState.pb.rupeeSinceMs, t0)
  assert.match(zone.reason, /^wing-straddle: combined stop in its zone/)
  const fired = pass(t0 + 4_000, 255, zone.markState)
  assert.equal(fired.trigger, 'dl-exit')
  assert.equal(fired.urgency, 'urgent')
  assert.match(fired.reason, /^wing-straddle: combined stop: .* — buying back 2 short\(s\) first, 2 long\(s\) after$/)
  assert.deepEqual(fired.actions.map((a) => (a.op === 'close' ? a.instrument : '')), [`NIFTY-${WING_EXPIRY}-25000CE`, `NIFTY-${WING_EXPIRY}-25000PE`])
  const out = pass(t0 + 4_000, 240, zone.markState)
  assert.equal(out.action, 'hold')
  assert.equal(out.markState.pb.rupeeSinceMs, 0, 'one pass out of the zone and the clock is gone')
})

test('through the frame: the index stop\'s clock is condSinceMs — stamped, kept on markState, fired once held pb_stop_hold_s', () => {
  const tape = new Tape()
  const pass = (ms: number, state: RuleState): EngineDecision => {
    const level = tape.advanceTo(ms)
    const chain = chainAt(ms, level, { expiry: WING_EXPIRY })
    return decidePlaybook(inputsAt(tape, ms, { chain, expiry: WING_EXPIRY, legs: flyHeld(chain) }), WING, state, MARK)
  }
  const st = stateWith({ ...TRADE, entrySpot: OPEN - 300, entryStr: 250 }, { dlRegime: 'quiet', dlRegimeSinceMs: at(560) })
  const t0 = at(630)
  const first = pass(t0, st)
  assert.equal(first.action, 'hold')
  assert.equal(first.markState.pb.condSinceMs, t0)
  const mid = pass(t0 + 12_000, first.markState)
  assert.equal(mid.action, 'hold')
  assert.equal(mid.markState.pb.condSinceMs, t0)
  const fired = pass(t0 + 20_000, mid.markState)
  assert.equal(fired.trigger, 'dl-exit')
  assert.match(fired.reason, /^wing-straddle: index stop: /)
})

// ── the scenario suite ──────────────────────────────────────────────────────

function wingDay(name: string, segments: readonly Segment[], over: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    name, symbol: 'NIFTY', dateIst: WING_DATE, expiry: WING_EXPIRY, open: 25_000, baseIv: 0.12, seed: 11,
    prevClose: 24_980, // a 0.08% gap: under the 0.25% "range day" line
    segments, ...over,
  }
}

function thetaDay(name: string, segments: readonly Segment[], over: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    name, symbol: 'NIFTY', dateIst: THETA_DATE, expiry: THETA_DATE, open: 25_000, baseIv: 0.15, seed: 21,
    prevClose: 24_990, segments, ...over,
  }
}

/** A calm Wing Straddle tape at a flat vol: 4 points per sqrt(minute), a
 * day's range of about half a percent. */
const CALM: readonly Segment[] = [{ minutes: 375, drift: 0, noise: 4 }]

/** One session's trading-time decay of a six-session straddle, as a vol: the
 * ATM vol at 15:30 that quotes the straddle sqrt(MTE 15:30 / MTE 09:15) of its
 * 09:15 price (see the file header). */
const DECAYED_IV = 0.12 * Math.sqrt(minutesToExpiry(WING_DATE, 930, WING_EXPIRY) / minutesToExpiry(WING_DATE, 555, WING_EXPIRY))

/** The ATM straddle the harness quotes at `minute` on `spec`'s path. */
function strAt(spec: ScenarioSpec, minute: number): number {
  const ms = istMs(spec.dateIst, minute)
  const chain = buildChain({
    symbol: spec.symbol, expiry: spec.expiry, dateIst: spec.dateIst, minuteOfDay: minute,
    index: indexPath(spec)(ms), atmIv: spec.baseIv, nowMs: ms,
  })
  const s = atmStraddleMid(chain)
  assert.ok(s !== null)
  return s
}

/** `Dday` as the fold freezes it: the straddle at 09:16 scaled to one session. */
function ddayOf(spec: ScenarioSpec): number {
  const mte = minutesToExpiry(spec.dateIst, 556, spec.expiry)
  return strAt(spec, 556) * Math.sqrt(Math.min(375, mte) / mte)
}

const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** D1 and the clock, on every scenario. */
function invariants(r: SimResult, what: string): void {
  assert.equal(r.nakedShortPasses, 0, `${what}: ${r.nakedShortPasses} pass(es) short an option not covered lot for lot (D1)`)
  for (const t of r.trades) {
    assert.ok(t.closeMin !== null && t.closeMin <= 900, `${what}: a trade still open after 15:00 — ${JSON.stringify(t)}`)
  }
}

/** Each trade as a line in the test's diagnostics: when, why it closed, what it made. */
function report(t: TestContext, r: SimResult): void {
  if (r.trades.length === 0) t.diagnostic('no trade')
  for (const x of r.trades) {
    t.diagnostic(`${hhmm(x.openMin)}-${x.closeMin === null ? 'open' : hhmm(x.closeMin)} ${x.closeTrigger ?? '-'} pnl ${Math.round(x.pnl)} | ${x.closeReason}`)
  }
  t.diagnostic(`day ${Math.round(r.finalPnl)}, low ${Math.round(r.minPnl)}, high ${Math.round(r.maxPnl)}`)
}

/** The passes that sent a stage 1: the trade's protective buys. */
const stageOnes = (r: SimResult): number[] =>
  r.decisions.flatMap((d, i) => (d.trigger === 'dl-open' && d.actions.some((a) => a.op === 'open' && a.side === 'Buy') ? [i] : []))
/** The passes that routed a short sale. */
const sales = (r: SimResult): number[] =>
  r.decisions.flatMap((d, i) => (d.actions.some((a) => a.op === 'open' && a.side === 'Sell') ? [i] : []))
const reasons = (r: SimResult, re: RegExp): number => r.decisions.filter((d) => re.test(d.reason)).length

/** The worst the held structure can lose at expiry, from its legs at their
 * entries: the wings' maximum. */
function wingsMax(legs: readonly LegView[], step: number): number {
  const cost = legs.reduce((c, l) => c + (l.side === 'Buy' ? 1 : -1) * l.entry * l.lots * l.lotSize, 0)
  const value = (s: number): number => legs.reduce((v, l) => v + (l.side === 'Buy' ? 1 : -1) * l.lots * l.lotSize * Math.max(0, l.optType === 'CE' ? s - l.strike : l.strike - s), 0)
  const ks = legs.map((l) => l.strike)
  const grid = [...ks, Math.min(...ks) - 10 * step, Math.max(...ks) + 10 * step]
  return -Math.min(...grid.map((s) => value(s) - cost))
}

/** The production frame, remembering the fullest book it was ever handed. */
function recording(): { readonly decide: DecideFn; readonly whole: () => readonly LegView[] } {
  let best: readonly LegView[] = []
  return {
    decide: (inputs, dials, state, markCtx) => {
      if (inputs.legs.length > best.length) best = inputs.legs
      return decidePlaybook(inputs, dials, state, markCtx)
    },
    whole: () => best,
  }
}

/** The production frame on a board `edit` rewrites, pass by pass. */
const editing = (edit: (chain: ChainSnap, inputs: DeltaLeanInputs, state: RuleState) => ChainSnap): DecideFn =>
  (inputs, dials, state, markCtx) => decidePlaybook({ ...inputs, chain: edit(inputs.chain, inputs, state) }, dials, state, markCtx)

// ── M: the market ───────────────────────────────────────────────────────────

test('M5 — a tight range after a 0.08% gap, the straddle decaying a session: the Wing Straddle sells by 10:30 and is in profit at the close', (t) => {
  const r = runSession(decidePlaybook, WING, wingDay('M5', [{ minutes: 375, drift: 0, noise: 4, ivTo: DECAYED_IV }]))
  report(t, r)
  invariants(r, 'M5')
  const first = r.trades[0]
  assert.ok(first !== undefined, 'the Wing Straddle sold the range')
  assert.ok(first.openMin <= 630, `entered ${hhmm(first.openMin)}, after 10:30`)
  assert.equal(first.side, 'none')
  assert.ok(first.closeTrigger === 'eod' || /trailing floor|take profit/.test(first.closeReason), `closed by ${first.closeReason}`)
  assert.ok(first.pnl > 0, `trade P&L ${first.pnl}`)
  assert.ok(r.finalPnl > 0, `day ${r.finalPnl}`)
})

test('M5 at a flat vol — the harness has no intraday decay before expiry day, so the same calm day cannot pay the Wing Straddle: it gives back its spread and its gamma', (t) => {
  // With the tenor and the vol fixed, the fly's value is a function of the
  // forward alone, lowest at its centre — the ATM nearest the forward when it
  // was sold. Wherever the index closes, buying it back costs at least what it
  // sold for, plus the spread both ways.
  const r = runSession(decidePlaybook, WING, wingDay('M5 flat vol', CALM))
  report(t, r)
  invariants(r, 'M5 flat vol')
  const first = r.trades[0]
  assert.ok(first !== undefined && first.openMin <= 630)
  assert.equal(first.closeTrigger, 'eod', 'no stop on a calm day')
  assert.ok(first.pnl < 0, `trade P&L ${first.pnl}: no theta to pay for the spread`)
})

test('M3 — a gap of one Dday and go: no Wing Straddle on the 0.6% gap gate; with the close unknown, the trend and then the move from the open keep it out', (t) => {
  // The go: a burst of nearly one Dday from 09:20, then a slow climb that
  // never comes back within 0.75 Dday of the open.
  const go: readonly Segment[] = [
    { minutes: 5, drift: 0, noise: 3 },
    { minutes: 10, drift: 150, noise: 2 },
    { minutes: 360, drift: 60, noise: 4 },
  ]
  const dday = ddayOf(wingDay('M3 probe', go))
  t.diagnostic(`Dday ${dday.toFixed(1)}: the gap is ${((100 * dday) / (25_000 - dday)).toFixed(2)}%`)
  const gapped = runSession(decidePlaybook, WING, wingDay('M3', go, { prevClose: 25_000 - dday }))
  report(t, gapped)
  invariants(gapped, 'M3')
  assert.equal(stageOnes(gapped).length, 0, 'no entry')
  assert.ok(reasons(gapped, /no new risk — the opening gap is 0\.63%, at or over the 0\.60% maximum/) > 0)

  const { prevClose: _, ...rest } = wingDay('M3, close unknown', go)
  const blind = runSession(decidePlaybook, WING, rest)
  report(t, blind)
  invariants(blind, 'M3 close unknown')
  assert.equal(stageOnes(blind).length, 0, 'no entry without the gap either')
  assert.ok(reasons(blind, /wing-straddle: the slow regime is trend-up, not quiet or chop/) > 0, 'the trend kept it out')
  assert.ok(reasons(blind, /wing-straddle: the index is \d+\.\d from the [\d.]+ open, past 0\.75 x the/) > 0, 'then the move from the open')
})

test('M20 — a 0.8% gap, quiet until 10:30: the Wing Straddle stands down on the gap all morning; the same tape without the gap is sold', (t) => {
  const tape: readonly Segment[] = [{ minutes: 75, drift: 0, noise: 3 }, { minutes: 300, drift: 60, noise: 4 }]
  const r = runSession(decidePlaybook, WING, wingDay('M20', tape, { prevClose: 25_000 / 1.008 }))
  report(t, r)
  invariants(r, 'M20')
  assert.equal(stageOnes(r).length, 0)
  assert.ok(reasons(r, /no new risk — the opening gap is 0\.80%, at or over the 0\.60% maximum/) > 0)
  const control = runSession(decidePlaybook, WING, wingDay('M20 control', tape))
  invariants(control, 'M20 control')
  assert.ok(stageOnes(control).length >= 1, 'the gap, and nothing else, kept it out')
})

/** M8's tape: quiet to 11:00, then 600 points in an hour. */
const M8_TAPE: readonly Segment[] = [{ minutes: 105, drift: 0, noise: 3 }, { minutes: 60, drift: 600, noise: 4 }, { minutes: 210, drift: 0, noise: 4 }]

test('M8 — a quiet morning, then a trend after 11:00: the morning\'s Wing Straddle is stopped by its combined, index or hard stop, inside Rs8,000', (t) => {
  const r = runSession(decidePlaybook, WING, wingDay('M8', M8_TAPE))
  report(t, r)
  invariants(r, 'M8')
  const first = r.trades[0]
  assert.ok(first !== undefined && first.openMin < 660, 'sold in the quiet morning')
  assert.equal(first.closeTrigger, 'dl-exit')
  assert.match(first.closeReason, /^wing-straddle: (combined stop|index stop|hard stop)/)
  assert.ok(first.closeMin !== null && first.closeMin >= 660 && first.closeMin < 720, 'stopped inside the trend')
  assert.ok(first.pnl >= -(8_000 + SLACK), `trade P&L ${first.pnl}`)
  assert.ok(r.finalPnl >= -(8_000 + SLACK), 'and no second trade into the trend')
})

test('M8 with the shorts\' asks gone from 11:00: both rupee stops are blind (spec G15), and the index stop takes the trade out at 1 x entryStr, inside Rs8,000', (t) => {
  // The desk's marks for the two held shorts lose their ask as the trend
  // starts. With no ask, `markLeg` marks a short at its entry (mtm 0) and
  // `shortsValue` is no reading, so the hard stop and the combined stop see
  // nothing. The index stop needs no quote.
  const blind: DecideFn = (inputs, dials, state, markCtx) => {
    const legs = inputs.minuteOfDay < 660 ? inputs.legs : inputs.legs.map((l): LegView => (l.side === 'Sell' ? { ...l, exit: { ...l.exit, ask: null }, mtm: 0 } : l))
    return decidePlaybook({ ...inputs, legs }, dials, state, markCtx)
  }
  const r = runSession(blind, WING, wingDay('M8 blind shorts', M8_TAPE))
  report(t, r)
  invariants(r, 'M8 blind shorts')
  const first = r.trades[0]
  assert.ok(first !== undefined && first.openMin < 660)
  assert.equal(first.closeTrigger, 'dl-exit')
  assert.match(first.closeReason, /^wing-straddle: index stop: the index is 4\d\d\.\d from the [\d.]+ entry, at or past 1 x the 41\d\.\d entry straddle/)
  assert.ok(first.pnl >= -(8_000 + SLACK), `trade P&L ${first.pnl}, marked at the real quotes`)
})

test('M9 — the vol up 30% in five minutes with a 1% move: the Wing Straddle exits on a rupee stop, the loss bounded by the hard stop', (t) => {
  const r = runSession(decidePlaybook, WING, wingDay('M9', [
    { minutes: 75, drift: 0, noise: 3 },
    { minutes: 5, drift: 250, noise: 2, ivTo: 0.156 },
    { minutes: 295, drift: 0, noise: 3 },
  ]))
  report(t, r)
  invariants(r, 'M9')
  const first = r.trades[0]
  assert.ok(first !== undefined && first.openMin < 630)
  assert.equal(first.closeTrigger, 'dl-exit')
  assert.match(first.closeReason, /^wing-straddle: (combined stop|hard stop)/)
  assert.ok(first.closeMin !== null && first.closeMin >= 630 && first.closeMin <= 640, `closed ${first.closeMin}`)
  assert.ok(first.pnl >= -(8_000 + SLACK), `trade P&L ${first.pnl}`)
})

test('M10 — an IV crush after the open: the Wing Straddle and the Theta Fly both gain', (t) => {
  const wing = runSession(decidePlaybook, WING, wingDay('M10 wing', [
    { minutes: 45, drift: 0, noise: 3 },
    { minutes: 30, drift: 0, noise: 3, ivTo: 0.11 },
    { minutes: 300, drift: 0, noise: 3 },
  ], { baseIv: 0.15 }))
  report(t, wing)
  invariants(wing, 'M10 wing')
  const w = wing.trades[0]
  assert.ok(w !== undefined && w.openMin < 600, 'sold before the crush')
  assert.ok(w.pnl > 0, `Wing Straddle trade P&L ${w.pnl}`)
  assert.ok(wing.finalPnl > 0)

  const theta = runSession(decidePlaybook, THETA, thetaDay('M10 theta', [
    { minutes: 235, drift: 0, noise: 2.5 },
    { minutes: 30, drift: 0, noise: 2.5, ivTo: 0.13 },
    { minutes: 110, drift: 0, noise: 2.5 },
  ], { baseIv: 0.2 }))
  report(t, theta)
  invariants(theta, 'M10 theta')
  const f = theta.trades[0]
  assert.ok(f !== undefined && f.openMin >= 780 && f.openMin < 790, 'sold before the crush')
  assert.ok(f.pnl > 0, `Theta Fly trade P&L ${f.pnl}`)
  assert.ok(theta.finalPnl > 0)
})

test('M6 — a wide two-way chop: the Wing Straddle takes at most two trades, each inside its stops, and the day stays inside the Rs12,000 backstop', (t) => {
  const r = runSession(decidePlaybook, WING, wingDay('M6', [
    { minutes: 30, drift: 0, noise: 6 }, // 09:15-09:45 chop at the open
    { minutes: 30, drift: 450, noise: 6 }, // a swing up
    { minutes: 30, drift: -450, noise: 6 }, // and back
    { minutes: 30, drift: 0, noise: 6 }, // chop at the open again
    { minutes: 30, drift: -450, noise: 6 }, // a swing down
    { minutes: 30, drift: 450, noise: 6 }, // and back
    { minutes: 195, drift: 0, noise: 6 },
  ], { seed: 7 }))
  report(t, r)
  invariants(r, 'M6')
  assert.ok(r.trades.length >= 1, 'it sold into the chop')
  assert.ok(r.trades.length <= 2, `${r.trades.length} trades`)
  for (const x of r.trades) assert.ok(x.pnl >= -(8_000 + SLACK), `a trade lost ${x.pnl}`)
  assert.ok(r.minPnl >= -(12_000 + SLACK) && r.finalPnl >= -(12_000 + SLACK), `day low ${r.minPnl}, close ${r.finalPnl}`)
})

test('M6 for the Theta Fly — a whipsaw afternoon: at most two trades, the day inside the Rs8,000 backstop', (t) => {
  const swings: Segment[] = [{ minutes: 225, drift: 0, noise: 2.5 }]
  for (let i = 0; i < 9; i += 1) swings.push({ minutes: 10, drift: i % 4 < 2 ? (i % 2 === 0 ? 60 : -60) : (i % 2 === 0 ? -60 : 60), noise: 3 })
  swings.push({ minutes: 60, drift: 0, noise: 3 })
  const r = runSession(decidePlaybook, THETA, thetaDay('M6 theta', swings))
  report(t, r)
  invariants(r, 'M6 theta')
  assert.ok(r.trades.length >= 1, 'it sold the calm hour before the whipsaw')
  assert.ok(r.trades.length <= 2)
  for (const x of r.trades) assert.ok(x.pnl >= -(4_000 + SLACK), `a trade lost ${x.pnl}`)
  assert.ok(r.minPnl >= -(8_000 + SLACK))
})

/** The fly's net credit per share — at expiry, how far from the centre the
 * index may close and the fly still make money. */
function creditPerShare(legs: readonly LegView[]): number {
  return legs.reduce((c, l) => c + (l.side === 'Sell' ? 1 : -1) * l.entry, 0)
}

test('M12 — expiry day, calm and pinned: the Theta Fly sells inside 13:00-14:15 and is in profit', (t) => {
  const spec = thetaDay('M12', [{ minutes: 375, drift: 0, noise: 2.5 }])
  const rec = recording()
  const r = runSession(rec.decide, THETA, spec)
  report(t, r)
  invariants(r, 'M12')
  const first = r.trades[0]
  assert.ok(first !== undefined, 'the Theta Fly sold the calm afternoon')
  assert.ok(first.openMin >= 780 && first.openMin < 855, `entered ${hhmm(first.openMin)}`)
  assert.equal(first.side, 'none')
  // The premise, checked rather than assumed: this calm tape is also PINNED —
  // it closes inside the fly's breakeven. (A calm tape that is not pinned is
  // the next test's business.)
  const centre = rec.whole().find((l) => l.side === 'Sell')?.strike
  assert.ok(centre !== undefined)
  const off = Math.abs(indexPath(spec)(istMs(THETA_DATE, 890)) - centre)
  t.diagnostic(`centre ${centre}; the index closes ${off.toFixed(1)} from it, inside the ${creditPerShare(rec.whole()).toFixed(2)} credit`)
  assert.ok(off <= creditPerShare(rec.whole()), 'the scenario is pinned')
  assert.ok(first.closeTrigger === 'eod' || /take profit/.test(first.closeReason), first.closeReason)
  assert.ok(first.pnl > 0, `trade P&L ${first.pnl}`)
  assert.ok(r.finalPnl > 0)
})

test('M12 over ten seeds of a calm afternoon, pinned or not: the Theta Fly makes money on average, and its worst day stays inside the hard stop', (t) => {
  const days = Array.from({ length: 10 }, (_, i) => {
    const r = runSession(decidePlaybook, THETA, thetaDay(`M12 seed ${i + 1}`, [{ minutes: 375, drift: 0, noise: 2.5 }], { seed: i + 1 }))
    invariants(r, `M12 seed ${i + 1}`)
    assert.ok(r.trades.length >= 1, `seed ${i + 1}: the calm afternoon was sold`)
    for (const x of r.trades) assert.ok(x.pnl >= -(4_000 + SLACK), `seed ${i + 1}: a trade lost ${x.pnl}`)
    return r.finalPnl
  })
  const mean = days.reduce((s, x) => s + x, 0) / days.length
  t.diagnostic(`days ${days.map((x) => Math.round(x)).join(', ')}; ${days.filter((x) => x > 0).length} of ${days.length} in profit, mean ${Math.round(mean)}`)
  assert.ok(mean > 0, `mean ${mean}`)
})

for (const [symbol, open, date] of [['NIFTY', 25_000, THETA_DATE], ['SENSEX', 82_000, '2026-10-22']] as const) {
  test(`M13 (${symbol}) — expiry day calm, then a 1.5 x STR break at 13:40: the trend exit or the hard stop, the loss within the wings' maximum`, (t) => {
    const calmTo1340: Segment = { minutes: 265, drift: 0, noise: symbol === 'NIFTY' ? 2.5 : 8 }
    const probe = thetaDay('M13 probe', [calmTo1340], { symbol, open, dateIst: date, expiry: date })
    const brk = 1.5 * strAt(probe, 820)
    const spec = thetaDay(`M13 ${symbol}`, [calmTo1340, { minutes: 4, drift: brk, noise: calmTo1340.noise }, { minutes: 106, drift: 0, noise: calmTo1340.noise }], { symbol, open, dateIst: date, expiry: date })
    const rec = recording()
    const r = runSession(rec.decide, THETA, spec)
    report(t, r)
    t.diagnostic(`break ${brk.toFixed(1)} points; wings' maximum Rs${Math.round(wingsMax(rec.whole(), STEP[symbol]))}`)
    invariants(r, `M13 ${symbol}`)
    const first = r.trades[0]
    assert.ok(first !== undefined && first.openMin >= 780 && first.openMin < 820, 'sold before the break')
    assert.equal(first.closeTrigger, 'dl-exit')
    assert.match(first.closeReason, /^expiry-theta: (trend exit|hard stop)/)
    assert.ok(first.closeMin !== null && first.closeMin >= 820 && first.closeMin < 830, `closed ${first.closeMin}`)
    assert.equal(rec.whole().length, 4, 'a whole fly was held')
    assert.ok(-first.pnl <= wingsMax(rec.whole(), STEP[symbol]), `lost ${-first.pnl}, past the wings' ${wingsMax(rec.whole(), STEP[symbol])}`)
    assert.ok(first.pnl >= -(4_000 + SLACK), `trade P&L ${first.pnl}`)
  })
}

// ── O: data and operations ──────────────────────────────────────────────────

test('O3 — a wing with no fresh quote, or a frozen board: no entry; an untradable short at stage 2 aborts once its window ends, no short sold', (t) => {
  // Every strike four or more steps from the money quoted a minute ago: the
  // board is live, the wings are not.
  const staleWings = editing((chain) => ({
    ...chain,
    strikes: chain.strikes.map((row) => {
      if (Math.abs(row.strike - chain.spot) < 4 * chain.step) return row
      const old = (q: Quote | null): Quote | null => (q === null ? null : { ...q, asOf: chain.asOf - 60_000 })
      return { ...row, ce: old(row.ce), pe: old(row.pe) }
    }),
  }))
  const r1 = runSession(staleWings, WING, wingDay('O3 stale wings', CALM))
  report(t, r1)
  invariants(r1, 'O3 stale wings')
  assert.equal(stageOnes(r1).length, 0)
  assert.ok(reasons(r1, /^wing-straddle: no fly on this board/) > 0)

  // The harness freezes the WHOLE board, its future too, so the frame's chain-
  // age gate is the first to see it; a live view whose future still ticks
  // falls to the newest-option-quote gate behind it. Either is "no new risk".
  const frozen = runSession(decidePlaybook, WING, wingDay('O3 frozen board', CALM, { quoteFreezes: [{ fromMin: 565, toMin: 760 }] }))
  invariants(frozen, 'O3 frozen board')
  assert.equal(stageOnes(frozen).length, 0)
  assert.ok(reasons(frozen, /no new risk — (the chain is [\d.]+s old|the newest option quote is [\d.]+s old)/) > 0)

  // Once the wings are bought, the ATM call loses its bid.
  const deadCentre = editing((chain, _inputs, state) => state.pb.stage < 1 ? chain : {
    ...chain,
    strikes: chain.strikes.map((row) => (row.ce !== null && Math.abs(row.strike - state.pb.planShorts[0]!.strike) < 1e-6 ? { ...row, ce: { ...row.ce, bid: null } } : row)),
  })
  const r3 = runSession(deadCentre, WING, wingDay('O3 dead centre', CALM))
  report(t, r3)
  invariants(r3, 'O3 dead centre')
  assert.ok(stageOnes(r3).length >= 1)
  assert.equal(sales(r3).length, 0, 'no short was ever routed')
  assert.ok(reasons(r3, /stage 2 waiting — \d+CE not tradable/) > 0)
  assert.ok(reasons(r3, /stage-2 abort: \d+CE, \d+PE still unsold 12\ds after the protective legs were held/) > 0)
})

test('O4 — the market moves 0.3 x STR between the stages: stage 2 aborts with the D2 close, and coverage holds', (t) => {
  const base = runSession(decidePlaybook, WING, wingDay('O4 baseline', CALM))
  const p = stageOnes(base)[0]
  assert.ok(p !== undefined, 'the baseline enters')
  assert.ok(sales(base)[0] === p + 3, 'the baseline sells its shorts three passes (12 s) after stage 1')
  const spec0 = wingDay('O4', CALM)
  const jump = 0.3 * strAt(spec0, Math.floor(555 + (p * 4) / 60))
  const moved = (startS: number): Segment[] => [
    { minutes: (p * 4 + startS) / 60, drift: 0, noise: 4 },
    { minutes: 16 / 60, drift: jump, noise: 0 },
    { minutes: 375 - (p * 4 + startS + 16) / 60, drift: 0, noise: 4 },
  ]

  // (a) The wings' fills land 32 s late, after the jump: stage 2 never sells.
  const late = runSession(decidePlaybook, WING, wingDay('O4 late wings', moved(8), {
    fills: (pass, a) => (pass === p && a.op === 'open' && a.side === 'Buy' ? { delayPasses: 8 } : 'fill'),
  }))
  report(t, late)
  invariants(late, 'O4 late wings')
  assert.equal(stageOnes(late)[0], p, 'the same entry as the baseline')
  const abortA = late.decisions.findIndex((d) => /stage-2 abort: the index moved/.test(d.reason))
  assert.equal(abortA, p + 8, 'aborted on the pass the wings were held')
  assert.ok(sales(late).every((i) => i > abortA), 'no short routed before the abort')
  assert.deepEqual(late.decisions[abortA]?.actions.map((a) => a.op), ['close', 'close'], 'the wings sold at once: there is no short to buy back first')
  assert.equal(late.trades[0]?.closeTrigger, 'dl-exit')

  // (b) The shorts are routed, then sit unfilled while the market jumps.
  let held = 0
  const working = runSession(decidePlaybook, WING, wingDay('O4 working shorts', moved(16), {
    fills: (_pass, a) => (a.op === 'open' && a.side === 'Sell' && held++ < 2 ? { delayPasses: 10 } : 'fill'),
  }))
  report(t, working)
  invariants(working, 'O4 working shorts')
  assert.equal(sales(working)[0], p + 3)
  assert.ok(reasons(working, /stage-2 abort: the index moved/) > 0)
  assert.equal(working.outcomes.cancelled, 2, 'both pending shorts cancelled by the abort')
  assert.equal(working.trades[0]?.closeTrigger, 'dl-exit')
})

test('O4, after the sale — the shorts fill at once, THEN the market jumps 0.3 x STR: the fly is whole, and no stage-2 abort closes it (engine review finding 1)', (t) => {
  const base = runSession(decidePlaybook, WING, wingDay('O4 baseline', CALM))
  const p = stageOnes(base)[0]
  assert.ok(p !== undefined, 'the baseline enters')
  const sale = sales(base)[0]
  assert.equal(sale, p + 3, 'the shorts sell three passes after stage 1, and fill on that pass')
  const jump = 0.3 * strAt(wingDay('O4', CALM), Math.floor(555 + (p * 4) / 60))
  // Calm to the sale's pass, the jump in the 2 s after it, calm again.
  const toSale = (sale * 4) / 60
  const r = runSession(decidePlaybook, WING, wingDay('O4 after the sale', [
    { minutes: toSale, drift: 0, noise: 4 },
    { minutes: 2 / 60, drift: jump, noise: 0 },
    { minutes: 375 - toSale - 2 / 60, drift: 0, noise: 4 },
  ]))
  report(t, r)
  invariants(r, 'O4 after the sale')
  assert.equal(sales(r)[0], sale, 'the same sale as the baseline')
  assert.equal(reasons(r, /stage-2 abort/), 0, 'a whole fly is not a stage to abort')
  assert.equal(r.decisions[sale + 1]?.trigger, 'none', `the pass after the fill: ${r.decisions[sale + 1]?.reason}`)
  assert.notEqual(r.trades[0]?.closeMin, r.trades[0]?.openMin, 'the fly outlives the minute it was sold in')
})

test('O9 — the supervisor starts at 10:00: the fold never saw the open, so neither the Wing Straddle nor the Theta Fly trades', (t) => {
  const wing = runSession(decidePlaybook, WING, wingDay('O9 wing', CALM, { startMin: 600 }))
  report(t, wing)
  invariants(wing, 'O9 wing')
  assert.equal(stageOnes(wing).length, 0)
  assert.ok(reasons(wing, /^wing-straddle: the fold did not see the open/) > 0)
  const theta = runSession(decidePlaybook, THETA, thetaDay('O9 theta', [{ minutes: 375, drift: 0, noise: 2.5 }], { startMin: 600 }))
  invariants(theta, 'O9 theta')
  assert.equal(stageOnes(theta).length, 0)
  assert.ok(reasons(theta, /^expiry-theta: the fold did not see the open/) > 0)
})

test('O16 — one wing filled and the other skipped: stage 1 aborts and sells the wing it bought; no short is ever sold against the missing one', (t) => {
  let skipped = false
  const r = runSession(decidePlaybook, WING, wingDay('O16', CALM, {
    fills: (_pass, a) => {
      if (!skipped && a.op === 'open' && a.side === 'Buy' && a.optType === 'PE') {
        skipped = true
        return 'skip'
      }
      return 'fill'
    },
  }))
  report(t, r)
  invariants(r, 'O16')
  const p = stageOnes(r)[0]
  assert.ok(p !== undefined)
  const abort = r.decisions.findIndex((d) => /stage-1 abort: protective \d+PE not held, and nothing is working/.test(d.reason))
  assert.equal(abort, p + 1, 'the pass after the skip')
  const closed = r.decisions[abort]?.actions.map((a) => (a.op === 'close' ? a.instrument : a.op)) ?? []
  assert.equal(closed.length, 1, 'one leg to close: the CE wing it did buy')
  assert.match(closed[0] ?? '', /^NIFTY-2026-10-27-\d+CE$/)
  assert.ok(sales(r).every((i) => i > abort), 'no short routed for the broken package')
  assert.equal(r.trades[0]?.closeTrigger, 'dl-exit')
})

test('O17 — stage 2 fills one short and the desk skips the other: re-sent every pb_stage_gap_s, still missing 120 s after readiness, aborted shorts-first', (t) => {
  const r = runSession(decidePlaybook, WING, wingDay('O17', CALM, {
    fills: (_pass, a) => (a.op === 'open' && a.side === 'Sell' && a.optType === 'CE' ? 'skip' : 'fill'),
  }))
  report(t, r)
  invariants(r, 'O17')
  const p = stageOnes(r)[0]
  assert.ok(p !== undefined)
  const abort = r.decisions.findIndex((d) => /stage-2 abort: \d+CE still unsold 12\ds after the protective legs were held/.test(d.reason))
  assert.ok(abort > p)
  const ceSales = r.decisions.slice(p, abort).flatMap((d, i) => (d.actions.some((a) => a.op === 'open' && a.side === 'Sell' && a.optType === 'CE') ? [p + i] : []))
  assert.ok(ceSales.length >= 2, `the CE short routed ${ceSales.length} time(s)`)
  for (let i = 1; i < ceSales.length; i += 1) {
    assert.ok((ceSales[i]! - ceSales[i - 1]!) * 4 >= WING.pb_stage_gap_s, 're-sent no sooner than pb_stage_gap_s')
  }
  const close = r.decisions[abort]?.actions ?? []
  assert.equal(close.length, 1, 'the PE short alone: its wing waits for it (D2)')
  assert.match(String(close.map((a) => (a.op === 'close' ? a.instrument : ''))), /25\d{3}PE$/)
})

test('O19 — a one-pass spread spike on the ATM shorts: the combined stop sees its zone and does not fire; held for two passes, it does', (t) => {
  // The shorts' ask jumps to 1.28 x what they were sold for: inside the 1.25x
  // combined-stop zone, while the trade stays above the Rs8,000 hard stop.
  const spiking = (passes: number): DecideFn => {
    let seen = 0
    return (inputs, dials, state, markCtx) => {
      const whole = inputs.legs.length === 4 && state.pb.stage === 0 && state.pb.tradeOpenMs > 0
      if (!whole || inputs.nowMs < istMs(WING_DATE, 630) || seen >= passes) return decidePlaybook(inputs, dials, state, markCtx)
      seen += 1
      const legs = inputs.legs.map((l): LegView => {
        if (l.side !== 'Sell') return l
        const ask = 1.28 * l.entry
        return { ...l, exit: { ...l.exit, ask }, mtm: -(ask - l.entry) * l.lots * l.lotSize }
      })
      return decidePlaybook({ ...inputs, legs }, dials, state, markCtx)
    }
  }
  const once = runSession(spiking(1), WING, wingDay('O19 one pass', CALM))
  report(t, once)
  invariants(once, 'O19 one pass')
  assert.equal(reasons(once, /^wing-straddle: combined stop in its zone/), 1, 'the spike was seen, once')
  assert.equal(reasons(once, /^wing-straddle: (combined stop|hard stop|trailing floor):/), 0, 'and no rupee stop fired on it')
  assert.equal(once.trades[0]?.closeTrigger, 'eod')

  const twice = runSession(spiking(2), WING, wingDay('O19 two passes', CALM))
  report(t, twice)
  invariants(twice, 'O19 two passes')
  assert.ok(reasons(twice, /^wing-straddle: combined stop: .*held 3s/) > 0, 'the same spike held one pass longer is a stop')
})
