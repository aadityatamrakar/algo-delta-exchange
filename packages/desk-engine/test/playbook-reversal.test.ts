/**
 * REVERSAL SPREAD (id 3) — six-playbooks spec v2 §5.3, rule by rule, then
 * whole sessions through the scenario harness (spec v2 §7).
 *
 * The playbook fades a morning excursion once the tape has turned: the day
 * ran at least `pb_rev_min_ext` x `Dday` away from its open, gave back
 * `pb_rev_retrace` of that, is still on the excursion's side of the open, and
 * the slow regime has been the counter-trend for `pb_confirm_s`. It buys a
 * debit spread on the delta bands in the reversal direction, and leaves on a
 * new extreme, a flip back to the original trend while losing, a debit stop,
 * or — the profit exit — the index back at the open.
 *
 * THE UNIT TESTS call `REVERSAL.enter` / `exits` on a hand-built context: the
 * shared fixture's board priced at the test's own index level, with the day's
 * statistics, the regime and the clocks stated outright, so each rule is
 * pinned at its own edge. The dials are the PRESET's (`pb-reversal`), never
 * test values, so a rule is measured at the numbers the book will trade.
 *
 * THE SCENARIOS run `decidePlaybook` over a simulated NIFTY Friday against the
 * Monday weekly (one trading day to expiry), every move sized in the board's
 * own day move (`Dday` about 154 points, the 5-minute implied move about 18).
 * Each one asserts defined risk on every pass (`nakedShortPasses` 0) and a
 * book flat by 15:00, whatever else it is about.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeltaLeanInputs } from '../src/delta-lean/decide.ts'
import type { Regime } from '../src/delta-lean/regime.ts'
import { decidePlaybook } from '../src/delta-lean/playbook/decide.ts'
import { debitByBands } from '../src/delta-lean/playbook/kit.ts'
import { REVERSAL } from '../src/delta-lean/playbook/reversal-spread.ts'
import type { PlaybookCtx } from '../src/delta-lean/playbook/types.ts'
import type { EngineDecision, LegView, PlaybookState, RuleState } from '../src/types.ts'
import { at, calm, chainAt, ctxOf, DATE, EXPIRY, inputsAt, legOn, OPEN, stateWith, Tape, tapeRead } from './playbook-fixture.ts'
import { indexPath, type ScenarioSpec, type Segment } from './scenario/paths.ts'
import { presetDials, runSession, type DecideFn, type SimResult } from './scenario/sim.ts'

const D = presetDials('pb-reversal')
const NOW = at(630) // 10:30, inside the 10:00-13:30 window
const DDAY = 150
const MARK = { isNewMark: true, markIndexToday: 15 }

// ── a hand-built context ────────────────────────────────────────────────────

interface Over {
  readonly S?: number
  readonly pb?: Partial<PlaybookState>
  readonly regime?: Regime
  readonly heldS?: number
  readonly dayRobust?: boolean
  readonly dayComplete?: boolean
  readonly dayImplied?: number | null
  readonly spotFresh?: boolean
  readonly legs?: (chain: ReturnType<typeof chainAt>) => readonly LegView[]
  readonly tradePnl?: number
  readonly cost?: number
  readonly nowMs?: number
  /** The tape's level by time; defaults to `S` for the last 5 s over a calm tape. */
  readonly level?: (ms: number, nowMs: number, S: number) => number
  /** The slow window's reading, when it must disagree with the label. */
  readonly tape?: Regime
}

/** The morning that ran 150 up from 25,000 and gave back 70: a fade's day. */
const UP_DAY: Partial<PlaybookState> = { dayOpen: OPEN, dayHigh: OPEN + 150, dayLow: OPEN - 20 }
/** Its mirror: 150 down, 70 back. */
const DOWN_DAY: Partial<PlaybookState> = { dayOpen: OPEN, dayHigh: OPEN + 20, dayLow: OPEN - 150 }

/** One pass's context at `S`, with the fixture's board priced there. */
function ctx(o: Over = {}): PlaybookCtx {
  const nowMs = o.nowMs ?? NOW
  const S = o.S ?? OPEN + 80
  // The ring's newest prints ARE `S` — as in production, where `ctx.spot` is the
  // ring's latest — so the steadied spot (median of the last three) reads S too.
  const tape = new Tape((ms) => (o.level ? o.level(ms, nowMs, S) : ms >= nowMs - 5_000 ? S : calm(ms)))
  tape.advanceTo(nowMs)
  const chain = chainAt(nowMs, S)
  const inputs = inputsAt(tape, nowMs, { chain, legs: o.legs?.(chain) ?? [] })
  const base = ctxOf(inputs, D, { dayImplied: DDAY, ...UP_DAY, ...o.pb })
  return {
    ...base,
    spot: S,
    spotFresh: o.spotFresh ?? true,
    regime: o.regime ?? 'trend-down',
    read: tapeRead(base.read, o.tape ?? o.regime ?? 'trend-down'),
    regimeHeldMs: (o.heldS ?? 130) * 1000,
    dayComplete: o.dayComplete ?? true,
    dayRobust: o.dayRobust ?? true,
    dayImplied: o.dayImplied === undefined ? DDAY : o.dayImplied,
    ...(o.tradePnl === undefined ? {} : { tradePnl: o.tradePnl }),
    ...(o.cost === undefined ? {} : { cost: o.cost }),
  }
}

const reasonOf = (c: PlaybookCtx): string => {
  const v = REVERSAL.enter(c)
  assert.equal(v.kind, 'wait', `expected a wait, got ${JSON.stringify(v)}`)
  return v.kind === 'wait' ? v.reason : ''
}

// ── enter ───────────────────────────────────────────────────────────────────

test('enter: a day the fold cannot trust is no day to fade — dayRobust and Dday are required', () => {
  assert.match(reasonOf(ctx({ dayRobust: false, dayComplete: false })), /never saw the open/)
  assert.match(reasonOf(ctx({ dayRobust: false, dayComplete: true, pb: { maxGapMs: 6 * 60_000 } })), /a 6-minute hole, past 5 min/)
  assert.match(reasonOf(ctx({ dayImplied: null })), /no day move \(Dday\)/)
  assert.match(reasonOf(ctx({ spotFresh: false })), /the index is stale/)
})

test('enter: the larger excursion must reach pb_rev_min_ext x Dday — inclusive at the bar', () => {
  // 0.6 x 150 = 90: an excursion of 89.9 waits, one of 90 trades.
  const short = reasonOf(ctx({ pb: { dayHigh: OPEN + 89.9 }, S: OPEN + 30 }))
  assert.match(short, /the morning excursion is 89\.9 points \(up\), under 0\.6 x the 150\.0 day move \(90\.0\)/)
  // S at +35: 55 of the 90 given back (61%), inside the [0.35, 0.65] room band.
  assert.equal(REVERSAL.enter(ctx({ pb: { dayHigh: OPEN + 90 }, S: OPEN + 35 })).kind, 'open')
})

test('enter: an up-excursion fades only once pb_rev_retrace of it is given back — inclusive — and while S is still above the open', () => {
  // 0.35 x 150 = 52.5 back from 25,150: S at 25,097.5 qualifies, 25,097.6 does not.
  assert.match(reasonOf(ctx({ S: OPEN + 97.6 })), /fading the up excursion of 150\.0: 52\.4 given back, under the 52\.5 \(0\.35 x\) it takes/)
  assert.equal(REVERSAL.enter(ctx({ S: OPEN + 97.5 })).kind, 'open')
  // At the open, the fade has already happened: nothing is left to take.
  assert.match(reasonOf(ctx({ S: OPEN })), /the index 25000\.0 is back through the open 25000\.0/)
  // THE ROOM BAND (Task 11 finding): the target is the open, so the give-back
  // must leave at least pb_rev_retrace of the excursion to come back —
  // 0.65 x 150 = 97.5 given back at most, inclusive: S 25,052.5 trades, 25,052.4
  // waits, and a fade a hair above the open is no trade at all.
  assert.equal(REVERSAL.enter(ctx({ S: OPEN + 52.5 })).kind, 'open')
  assert.match(reasonOf(ctx({ S: OPEN + 52.4 })), /97\.6 already given back, past 0\.65 x — too little room left to the open/)
  assert.match(reasonOf(ctx({ S: OPEN + 0.5 })), /too little room left to the open/)
})

test('enter: the slow regime must be the counter-trend, held pb_confirm_s — inclusive', () => {
  assert.match(reasonOf(ctx({ regime: 'chop' })), /the regime is chop, not trend-down/)
  assert.match(reasonOf(ctx({ regime: 'trend-up' })), /the regime is trend-up, not trend-down/)
  assert.match(reasonOf(ctx({ heldS: 119.999 })), /trend-down held 119s of the 120s/)
  assert.equal(REVERSAL.enter(ctx({ heldS: 120 })).kind, 'open')
})

test('enter: an up-excursion opens a PUT debit spread on the delta bands, side down, pb_lots, stamping the high it fades', () => {
  const c = ctx({ S: OPEN + 80 })
  const v = REVERSAL.enter(c)
  assert.equal(v.kind, 'open')
  if (v.kind !== 'open') return
  const want = debitByBands(c, 'down')
  assert.ok(want !== null, 'the board has a put spread on the bands')
  assert.equal(v.plan.side, 'down')
  assert.deepEqual(v.plan.protective, want.protective)
  assert.deepEqual(v.plan.shorts, want.shorts)
  assert.equal(v.plan.protective[0]?.optType, 'PE')
  assert.equal(v.plan.lots, D.pb_lots)
  assert.deepEqual(v.plan.stamps, { entryExtreme: OPEN + 150 })
  assert.doesNotMatch(v.plan.reason, /^reversal: /, 'a bare reason: the frame adds the name')
  assert.match(v.plan.reason, /fading the morning's 150-point up-move from 25150\.0: 70\.0 given back \(47%\), trend-down held 130s — a PE debit spread/)
})

test('enter: a down-excursion is the mirror — trend-up, S below the open, a CALL spread, side up, stamping the low', () => {
  const c = ctx({ pb: DOWN_DAY, S: OPEN - 80, regime: 'trend-up' })
  const v = REVERSAL.enter(c)
  assert.equal(v.kind, 'open')
  if (v.kind !== 'open') return
  const want = debitByBands(c, 'up')
  assert.ok(want !== null)
  assert.equal(v.plan.side, 'up')
  assert.deepEqual(v.plan.protective, want.protective)
  assert.deepEqual(v.plan.shorts, want.shorts)
  assert.equal(v.plan.protective[0]?.optType, 'CE')
  assert.deepEqual(v.plan.stamps, { entryExtreme: OPEN - 150 })
  // The mirror's edges: 52.5 back up from 24,850 is 24,902.5.
  assert.match(reasonOf(ctx({ pb: DOWN_DAY, S: OPEN - 97.6, regime: 'trend-up' })), /fading the down excursion of 150\.0: 52\.4 given back, under the 52\.5/)
  assert.equal(REVERSAL.enter(ctx({ pb: DOWN_DAY, S: OPEN - 97.5, regime: 'trend-up' })).kind, 'open')
  assert.match(reasonOf(ctx({ pb: DOWN_DAY, S: OPEN, regime: 'trend-up' })), /back through the open/)
  assert.match(reasonOf(ctx({ pb: DOWN_DAY, S: OPEN - 80, regime: 'trend-down' })), /the regime is trend-down, not trend-up/)
})

test('enter: on a two-way morning the LARGER excursion is the one faded', () => {
  // Up 100, down 120: the down-move is the excursion, so the fade is UP.
  const pb = { dayOpen: OPEN, dayHigh: OPEN + 100, dayLow: OPEN - 120 }
  assert.match(reasonOf(ctx({ pb, S: OPEN - 70, regime: 'trend-down' })), /not trend-up/)
  const v = REVERSAL.enter(ctx({ pb, S: OPEN - 70, regime: 'trend-up' }))
  assert.equal(v.kind, 'open')
  if (v.kind === 'open') assert.equal(v.plan.side, 'up')
})

test('enter: no spread on the bands is a wait, never half a structure', () => {
  const c = ctx()
  const dead = { ...c, inputs: { ...c.inputs, chain: { ...c.inputs.chain, strikes: [] } } }
  assert.match(reasonOf(dead), /no PE debit spread on the delta bands/)
})

// ── exits ───────────────────────────────────────────────────────────────────

/** A put-spread trade fading the 25,150 high, opened at 10:10. */
const SHORT_TRADE: Partial<PlaybookState> = {
  ...UP_DAY, entries: 1, tradeOpenMs: at(610), side: 'down', entrySpot: OPEN + 80, entryExtreme: OPEN + 150,
  planLots: 2, stage: 0, basePnl: 0,
}
const LONG_TRADE: Partial<PlaybookState> = {
  ...DOWN_DAY, entries: 1, tradeOpenMs: at(610), side: 'up', entrySpot: OPEN - 80, entryExtreme: OPEN - 150,
  planLots: 2, stage: 0, basePnl: 0,
}

test('exits — new extreme: S at or past the faded extreme + pb_rev_stop_k x Dday, held pb_stop_hold_s, is urgent and not final', () => {
  // 25,150 + 0.1 x 150 = 25,165.
  const first = REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN + 165, regime: 'chop', tradePnl: -1_000 }))
  assert.equal(first.exit, undefined, 'the first pass only starts the clock')
  assert.equal(first.patch?.condSinceMs, NOW)
  const early = REVERSAL.exits(ctx({ pb: { ...SHORT_TRADE, condSinceMs: NOW }, nowMs: NOW + 19_999, S: OPEN + 170, regime: 'chop' }))
  assert.equal(early.exit, undefined)
  assert.equal(early.patch?.condSinceMs, NOW)
  const fired = REVERSAL.exits(ctx({ pb: { ...SHORT_TRADE, condSinceMs: NOW }, nowMs: NOW + 20_000, S: OPEN + 170, regime: 'chop' }))
  assert.deepEqual([fired.exit?.urgency, fired.exit?.final], ['urgent', false])
  assert.match(fired.exit?.reason ?? '', /^new extreme: the index 25170\.0 is 20\.0 beyond the 25150\.0 the trade faded, past 0\.1 x Dday \(15\.0\), held 20s/)
  assert.equal(fired.patch?.condSinceMs, NOW, 'the patch rides on the exit too')
  // Just inside the stop: the clock is cleared.
  const inside = REVERSAL.exits(ctx({ pb: { ...SHORT_TRADE, condSinceMs: NOW }, nowMs: NOW + 20_000, S: OPEN + 164.9, regime: 'chop' }))
  assert.equal(inside.exit, undefined)
  assert.equal(inside.patch?.condSinceMs, 0)
})

test('exits — new extreme mirrors for a fade of a down-move, and is skipped while S is stale', () => {
  // 24,850 - 15 = 24,835.
  const armed = { ...LONG_TRADE, condSinceMs: NOW - 20_000 }
  const fired = REVERSAL.exits(ctx({ pb: armed, S: OPEN - 165, regime: 'chop' }))
  assert.equal(fired.exit?.urgency, 'urgent')
  assert.match(fired.exit?.reason ?? '', /^new extreme: the index 24835\.0 is 15\.0 beyond the 24850\.0/)
  assert.equal(REVERSAL.exits(ctx({ pb: armed, S: OPEN - 164.9, regime: 'chop' })).exit, undefined)
  // A stale S measures nothing: no stop, and the clock does not run on it.
  const stale = REVERSAL.exits(ctx({ pb: armed, S: OPEN - 200, regime: 'chop', spotFresh: false }))
  assert.equal(stale.exit, undefined)
  assert.equal(stale.patch?.condSinceMs, 0)
})

test('exits — flip back: the ORIGINAL trend held pb_flip_confirm_s while the trade is not winning, urgent; a winner is let run', () => {
  const pass = (regime: Regime, heldS: number, tradePnl: number): ReturnType<typeof REVERSAL.exits> =>
    REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN + 100, regime, heldS, tradePnl, cost: 10_000 }))
  const flip = pass('trend-up', 90, 0)
  assert.deepEqual([flip.exit?.urgency, flip.exit?.final], ['urgent', false])
  assert.match(flip.exit?.reason ?? '', /^flip back: trend-up held 90s \(>= 90s\) with the trade at Rs0/)
  assert.equal(pass('trend-up', 89.999, -500).exit, undefined, 'not held long enough')
  assert.equal(pass('trend-up', 300, 1).exit, undefined, 'a winning trade is let run (D5)')
  assert.equal(pass('trend-down', 300, -500).exit, undefined, 'the fade direction is no flip')
  // The mirror: a fade of a down-move flips back on trend-down.
  const mirror = REVERSAL.exits(ctx({ pb: LONG_TRADE, S: OPEN - 100, regime: 'trend-down', heldS: 95, tradePnl: -200, cost: 10_000 }))
  assert.match(mirror.exit?.reason ?? '', /^flip back: trend-down held 95s/)
})

test('exits — debit stop: pb_debit_stop_frac of the debit, inclusive, rupee-debounced on the shared clock, urgent', () => {
  const pass = (tradePnl: number, rupeeSinceMs: number, nowMs = NOW): ReturnType<typeof REVERSAL.exits> =>
    REVERSAL.exits(ctx({ pb: { ...SHORT_TRADE, rupeeSinceMs }, S: OPEN + 100, regime: 'chop', tradePnl, cost: 10_000, nowMs }))
  const first = pass(-4_000, 0)
  assert.equal(first.exit, undefined, 'one mark is not a loss')
  assert.equal(first.patch?.rupeeSinceMs, NOW)
  const fired = pass(-4_000, NOW, NOW + 3_000)
  assert.deepEqual([fired.exit?.urgency, fired.exit?.final], ['urgent', false])
  assert.match(fired.exit?.reason ?? '', /^debit stop: trade P&L Rs-4,000 at or through 0\.4 x the Rs10,000 debit \(Rs-4,000\), held 3s/)
  const above = pass(-3_999, NOW, NOW + 3_000)
  assert.equal(above.exit, undefined)
  assert.equal('rupeeSinceMs' in (above.patch ?? {}), false, 'off, it says nothing: the frame owns the reset')
  // A credit (or nothing held) has no debit to lose a share of.
  const credit = REVERSAL.exits(ctx({ pb: { ...SHORT_TRADE, rupeeSinceMs: NOW - 9_000 }, S: OPEN + 100, regime: 'chop', tradePnl: -9_000, cost: -500 }))
  assert.equal(credit.exit, undefined)
  // The rupee stop does not need the index.
  const blind = REVERSAL.exits(ctx({ pb: { ...SHORT_TRADE, rupeeSinceMs: NOW - 3_000 }, S: OPEN + 100, regime: 'chop', tradePnl: -5_000, cost: 10_000, spotFresh: false }))
  assert.match(blind.exit?.reason ?? '', /^debit stop/)
})

test('exits — back to the open is the PASSIVE profit exit: S at or through the open on the fade\'s side', () => {
  const down = REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN, regime: 'trend-down', tradePnl: 3_000, cost: 10_000 }))
  assert.deepEqual([down.exit?.urgency, down.exit?.final], ['passive', false])
  assert.match(down.exit?.reason ?? '', /^back to the open: the index 25000\.0 \(median of the last three prints\) reached the open 25000\.0/)
  assert.equal(REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN + 0.1, regime: 'trend-down', tradePnl: 3_000, cost: 10_000 })).exit, undefined)
  const up = REVERSAL.exits(ctx({ pb: LONG_TRADE, S: OPEN + 2, regime: 'trend-up', tradePnl: 3_000, cost: 10_000 }))
  assert.equal(up.exit?.urgency, 'passive')
  assert.equal(REVERSAL.exits(ctx({ pb: LONG_TRADE, S: OPEN - 0.1, regime: 'trend-up', tradePnl: 3_000, cost: 10_000 })).exit, undefined)
  // An index rule: not on a stale S.
  assert.equal(REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN - 50, regime: 'trend-down', tradePnl: 3_000, cost: 10_000, spotFresh: false })).exit, undefined)
})

test('exits — the urgent stops outrank the passive exit, and every path returns its debounce clocks', () => {
  // At the open AND flipped back while not winning: the flip (urgent) wins.
  const both = REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN, regime: 'trend-up', heldS: 100, tradePnl: -100, cost: 10_000 }))
  assert.equal(both.exit?.urgency, 'urgent')
  assert.match(both.exit?.reason ?? '', /^flip back/)
  // The index clock is returned with a rupee exit, and the rupee clock with a hold.
  const debit = REVERSAL.exits(ctx({ pb: { ...SHORT_TRADE, rupeeSinceMs: NOW - 3_000 }, S: OPEN + 165, regime: 'chop', tradePnl: -4_500, cost: 10_000 }))
  assert.match(debit.exit?.reason ?? '', /^debit stop/)
  assert.equal(debit.patch?.condSinceMs, NOW)
  const quiet = REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN + 100, regime: 'chop', tradePnl: -4_500, cost: 10_000 }))
  assert.equal(quiet.exit, undefined)
  assert.deepEqual(quiet.patch, { condSinceMs: 0, rupeeSinceMs: NOW })
  assert.match(quiet.note ?? '', /^holding — trade P&L Rs-4,500/)
})

test('adds: none — the Reversal never pyramids', () => {
  assert.deepEqual(REVERSAL.adds(ctx({ pb: SHORT_TRADE, tradePnl: 5_000 })), {})
  assert.equal(REVERSAL.id, 3)
  assert.equal(REVERSAL.name, 'reversal')
})

// ── through the frame ───────────────────────────────────────────────────────

/** A clean tape: 25,000 to 25,150 by 09:45, flat to 10:20, then down 9 a minute. */
const fadeLevel = (ms: number): number => {
  const m = (ms - at(555)) / 60_000 // minutes since 09:15
  if (m <= 30) return OPEN + 5 * m
  if (m <= 65) return OPEN + 150
  return OPEN + 150 - 9 * (m - 65)
}

test('through the frame: the fold, the regime and the gates hand the Reversal its day, and the open stamps entryExtreme on stateAfter', () => {
  const tape = new Tape(fadeLevel)
  const nowMs = at(630) // ten minutes into the fall: S = 25,060
  const inputs = inputsAt(tape, nowMs)
  // The regime read off this tape is trend-down; say it has been for 150 s.
  const state: RuleState = stateWith({}, { dlRegime: 'trend-down', dlRegimeSinceMs: nowMs - 150_000 })
  const d: EngineDecision = decidePlaybook(inputs, D, state, MARK)
  assert.equal(d.trigger, 'dl-open', d.reason)
  assert.match(d.reason, /^reversal: fading the morning's 150-point up-move from 25150\.0/)
  const pb = d.stateAfter.pb
  assert.equal(pb.side, 'down')
  assert.equal(pb.entryExtreme, OPEN + 150, 'the high it fades, as the fold saw it')
  assert.equal(pb.dayHigh, OPEN + 150)
  assert.equal(pb.stage, 1, 'a two-stage spread: the long first')
  assert.equal(d.actions.length, 1)
  const a = d.actions[0]
  assert.ok(a?.op === 'open' && a.side === 'Buy' && a.optType === 'PE' && a.lots === D.pb_lots)
  assert.equal(d.markState.pb.entries, 0, 'a refused stage 1 refunds the entry')
})

test('through the frame: a held trade\'s new-extreme clock persists pass to pass and fires after pb_stop_hold_s', () => {
  // The fade went wrong: the index sits at 25,170, past 25,150 + 15. A flat
  // tape reads `quiet`, so no flip back can fire first and muddy the clock.
  const tape = new Tape(() => OPEN + 170)
  const chain = chainAt(at(645), OPEN + 170)
  const legs = [legOn(chain, 25_150, 'PE', 'Buy', 2, { mtm: -800 }), legOn(chain, 24_950, 'PE', 'Sell', 2, { mtm: 300 })]
  let state: RuleState = stateWith({ ...SHORT_TRADE, dayImplied: DDAY, statsFromMs: at(555), maxGapMs: 1_000 }, { dlRegime: 'quiet', dlRegimeSinceMs: at(600) })
  const seen: EngineDecision[] = []
  for (let ms = at(645); ms <= at(645) + 24_000; ms += 4_000) {
    const d = decidePlaybook(inputsAt(tape, ms, { chain, legs }), D, state, MARK)
    seen.push(d)
    state = d.actions.length > 0 ? d.stateAfter : d.markState
  }
  const fired = seen.findIndex((d) => d.trigger === 'dl-exit')
  assert.equal(fired, 5, `fires on the pass 20 s after the first: ${seen.map((d) => d.reason).join(' | ')}`)
  assert.match(seen[fired]?.reason ?? '', /^reversal: new extreme: /)
  assert.equal(seen[fired]?.urgency, 'urgent')
  assert.equal(seen[0]?.markState.pb.condSinceMs, at(645), 'the clock rides on the mark')
})

// ── scenarios (spec v2 §7) ──────────────────────────────────────────────────

const SCEN_DATE = DATE // Friday 16 Oct 2026, one trading day to the Monday weekly
const SCEN_EXPIRY = EXPIRY

function day(name: string, segments: readonly Segment[], over: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return { name, symbol: 'NIFTY', dateIst: SCEN_DATE, expiry: SCEN_EXPIRY, open: OPEN, baseIv: 0.12, seed: 11, segments, ...over }
}

/** Every pass the harness ran: its inputs, the state it was given, the answer. */
interface Pass {
  readonly inputs: DeltaLeanInputs
  readonly state: RuleState
  readonly decision: EngineDecision
}
function recorded(): { readonly decide: DecideFn; readonly passes: Pass[] } {
  const passes: Pass[] = []
  return {
    passes,
    decide: (inputs, dials, state, markCtx) => {
      const decision = decidePlaybook(inputs, dials, state, markCtx)
      passes.push({ inputs, state, decision })
      return decision
    },
  }
}

function run(spec: ScenarioSpec): { readonly r: SimResult; readonly passes: Pass[] } {
  const { decide, passes } = recorded()
  return { r: runSession(decide, D, spec), passes }
}

/** Defined risk on every pass, and nothing held past the 15:00 flat-by. */
function assertSafe(r: SimResult, what: string): void {
  assert.equal(r.nakedShortPasses, 0, `${what}: ${r.nakedShortPasses} pass(es) short an option not covered lot for lot`)
  for (const t of r.trades) {
    assert.ok(t.closeMin !== null && t.closeMin <= 900, `${what}: a trade still open after 15:00: ${JSON.stringify(t)}`)
  }
}

/** The stage-1 opens: entries, as the book counted them. */
const entriesOf = (passes: readonly Pass[]): Pass[] =>
  passes.filter((p) => p.decision.trigger === 'dl-open' && p.decision.actions.length > 0 && !/: stage 2 —/.test(p.decision.reason))

const minuteOf = (p: Pass): number => p.inputs.minuteOfDay

/** M7 — a morning trend up in three bursts to about 1 Dday, then a V that
 * falls through the open at about 2.8 x the 5-minute implied move. */
const M7: readonly Segment[] = [
  { minutes: 5, drift: 0, noise: 3 },
  { minutes: 5, drift: 55, noise: 3 },
  { minutes: 8, drift: 5, noise: 3 },
  { minutes: 5, drift: 50, noise: 3 },
  { minutes: 8, drift: 0, noise: 3 },
  { minutes: 5, drift: 50, noise: 3 },
  { minutes: 14, drift: -5, noise: 3 }, // the top, 09:51-10:05
  { minutes: 25, drift: -260, noise: 4 }, // the V, 10:05-10:30
  { minutes: 60, drift: -30, noise: 4 },
  { minutes: 240, drift: 20, noise: 4 },
]

test('M7 — a morning trend up, then a V below the open: the Reversal enters DOWN after 10:00 and ends positive', () => {
  const { r, passes } = run(day('M7 V-reversal', M7))
  assertSafe(r, 'M7')
  const opens = entriesOf(passes)
  assert.equal(opens.length, 1, `one entry: ${opens.map((p) => p.decision.reason).join(' | ')}`)
  const open = opens[0]
  assert.ok(open !== undefined)
  assert.ok(minuteOf(open) >= 600, `entered at ${minuteOf(open)}, before 10:00`)
  assert.equal(open.decision.stateAfter.pb.side, 'down')
  assert.equal(r.trades.length, 1)
  assert.equal(r.trades[0]?.side, 'down')
  assert.ok(r.finalPnl > 0, `P&L ${r.finalPnl.toFixed(0)}: ${r.trades[0]?.closeReason}`)
})

/** M4 — a 0.8% gap up that runs another 0.8 Dday, then fades to the previous
 * close in three sharp legs and a grind. */
const M4: readonly Segment[] = [
  { minutes: 5, drift: 10, noise: 3 },
  { minutes: 6, drift: 60, noise: 3 },
  { minutes: 9, drift: 5, noise: 3 },
  { minutes: 6, drift: 50, noise: 3 },
  { minutes: 24, drift: -5, noise: 3 }, // the top, 09:41-10:05
  { minutes: 6, drift: -60, noise: 3 }, // leg 1, 10:05-10:11
  { minutes: 11, drift: 5, noise: 3 },
  { minutes: 6, drift: -60, noise: 3 }, // leg 2, 10:22-10:28
  { minutes: 8, drift: 0, noise: 3 },
  { minutes: 6, drift: -60, noise: 3 }, // leg 3, through the open
  { minutes: 108, drift: -145, noise: 4 }, // the grind to the previous close
  { minutes: 180, drift: 0, noise: 4 },
]

test('M4 — the gap fade: the Reversal enters DOWN and leaves back at the open (or on the trail), positive', () => {
  const { r, passes } = run(day('M4 gap fade', M4, { prevClose: 24_800 }))
  assertSafe(r, 'M4')
  const opens = entriesOf(passes)
  assert.equal(opens.length, 1, opens.map((p) => p.decision.reason).join(' | '))
  assert.equal(opens[0]?.decision.stateAfter.pb.side, 'down')
  const t = r.trades[0]
  assert.ok(t !== undefined && t.closeMin !== null)
  assert.match(t.closeReason, /back to the open|trailing floor/, `closed by: ${t.closeReason}`)
  assert.ok(r.finalPnl > 0, `P&L ${r.finalPnl.toFixed(0)}: ${t.closeReason}`)
})

/** M1 — a 0.4% gap, then a trend up in bursts of 2.8 x the 5-minute implied
 * move, with pauses, consolidating higher through the afternoon. */
function m1(): Segment[] {
  const s: Segment[] = [{ minutes: 5, drift: 5, noise: 3 }]
  for (let i = 0; i < 5; i += 1) s.push({ minutes: 4, drift: 50, noise: 3 }, { minutes: 6, drift: 3, noise: 3 })
  s.push({ minutes: 50, drift: 40, noise: 4 }, { minutes: 4, drift: 50, noise: 3 }, { minutes: 56, drift: 30, noise: 4 }, { minutes: 210, drift: 60, noise: 4 })
  return s
}

test('M1 — a trend day in bursts after a 0.4% gap: no Reversal entry, ever', () => {
  const { r, passes } = run(day('M1 trend up', m1(), { prevClose: 24_900 }))
  assertSafe(r, 'M1')
  assert.equal(entriesOf(passes).length, 0, entriesOf(passes).map((p) => p.decision.reason).join(' | '))
  assert.equal(r.trades.length, 0)
  // The day really was an excursion the rule saw — it is the turn that never came.
  const last = passes[passes.length - 1]
  assert.ok(last !== undefined)
  const pb = last.decision.markState.pb
  assert.ok(pb.dayHigh - pb.dayOpen >= D.pb_rev_min_ext * pb.dayImplied, `a ${(pb.dayHigh - pb.dayOpen).toFixed(0)}-point excursion`)
})

/** M6 — a wide two-way chop: swings of about 1.3 Dday all day. The first turn
 * is faded, and the next swing runs straight back through the extreme. */
const M6: readonly Segment[] = [
  { minutes: 15, drift: 70, noise: 4 },
  { minutes: 10, drift: 5, noise: 4 },
  { minutes: 10, drift: 70, noise: 4 }, // 25,145 by 09:50
  { minutes: 12, drift: 0, noise: 4 },
  { minutes: 8, drift: -75, noise: 4 }, // the first turn, 10:02-10:10
  { minutes: 6, drift: -5, noise: 4 },
  { minutes: 12, drift: 110, noise: 4 }, // straight back through the high
  { minutes: 12, drift: 10, noise: 4 },
  { minutes: 30, drift: -250, noise: 5 },
  { minutes: 30, drift: 200, noise: 5 },
  { minutes: 40, drift: -230, noise: 5 },
  { minutes: 40, drift: 190, noise: 5 },
  { minutes: 40, drift: -200, noise: 5 },
  { minutes: 40, drift: 180, noise: 5 },
  { minutes: 70, drift: -60, noise: 5 },
]

/** M6's slack over the ₹6,000 hard stop. The stop holds `pb_rupee_hold_s` (3 s)
 * and fills on the next 4 s pass, and the D2 close holds the long one pass
 * more after the short is bought back: two passes of a 2-lot spread's ~45
 * rupees a point on an index moving ~2 points a pass is about ₹200, and ₹500
 * leaves room for a faster tape. (Measured over seeds 1-10 of this tape the
 * flip back fires first, at -₹481 to -₹1,807: the hard stop never comes near.) */
const M6_SLACK = 500

test('M6 — a wide two-way chop: at most one trade, and the day no worse than the hard stop plus slack', () => {
  const { r, passes } = run(day('M6 two-way chop', M6))
  assertSafe(r, 'M6')
  assert.ok(entriesOf(passes).length <= 1)
  assert.ok(r.trades.length <= 1)
  assert.ok(r.finalPnl >= -(D.pb_trade_max_loss + M6_SLACK), `P&L ${r.finalPnl.toFixed(0)}, min ${r.minPnl.toFixed(0)}`)
  assert.ok(r.minPnl >= -(D.pb_trade_max_loss + M6_SLACK), `worst mark ${r.minPnl.toFixed(0)}`)
})

/** M11 — a morning that rises 70 (under 0.6 Dday) and turns, with ONE bad
 * print 1% (250 points) above the index at 10:20. `rise` is the morning's climb. */
function m11(rise: number): Segment[] {
  return [
    { minutes: 30, drift: rise / 2, noise: 1 },
    { minutes: 30, drift: rise / 2, noise: 1 }, // the high, 10:15
    { minutes: 7, drift: 0, noise: 1 },
    { minutes: 8, drift: -64, noise: 1 }, // a real trend-down, 10:22-10:30
    { minutes: 300, drift: 0, noise: 1 },
  ]
}

test('M11 — one bad print cannot make an excursion: H takes the median-of-3, and no Reversal enters on the spike', () => {
  const spike = { atMin: 620, pts: 250 }
  const spec = day('M11 one bad print', m11(70), { spikes: [spike] })
  const { r, passes } = run(spec)
  assertSafe(r, 'M11')
  // The feed DID print it, and unfiltered it would have been an excursion.
  const printed = indexPath(spec)
  const pb = passes[passes.length - 1]?.decision.markState.pb
  assert.ok(pb !== undefined && pb.dayImplied > 0)
  const bar = D.pb_rev_min_ext * pb.dayImplied
  assert.ok(printed(at(620)) - pb.dayOpen >= bar, 'the bad print alone clears the excursion bar')
  assert.ok(pb.dayHigh - pb.dayOpen < bar, `the folded high ${pb.dayHigh.toFixed(1)} took the spike`)
  assert.equal(entriesOf(passes).length, 0, entriesOf(passes).map((p) => p.decision.reason).join(' | '))
  // The control: the same turn after a REAL excursion is faded — so the spike
  // was the only thing missing, not the regime or the retrace.
  const control = run(day('M11 control', m11(110)))
  assertSafe(control.r, 'M11 control')
  assert.equal(entriesOf(control.passes).length, 1, 'the turn is a trade once the excursion is real')
})

test('M11 — a bad print 1% past the faded extreme, mid-trade: the new-extreme stop holds pb_stop_hold_s, so the day is the clean day', () => {
  const clean = run(day('M7', M7))
  assertSafe(clean.r, 'M7 clean')
  const { r, passes } = run(day('M7 + a bad print above', M7, { spikes: [{ atMin: 615, pts: 250 }] }))
  assertSafe(r, 'M11 mid-trade')
  const t = r.trades[0]
  assert.ok(t !== undefined && t.openMin <= 615 && (t.closeMin ?? 0) > 615, 'the print lands inside the trade')
  assert.equal(passes.some((p) => /new extreme/.test(p.decision.reason) && p.decision.trigger === 'dl-exit'), false)
  assert.equal(r.finalPnl, clean.r.finalPnl, 'the bad print changed nothing')
})

test('fills — a stage-1 long that part-fills (1 of 2 lots): stage 2 sells 1 short against it, coverage holds, still positive', () => {
  let first = true
  const spec = day('M7 part-filled long', M7, {
    fills: (_pass, a) => {
      if (first && a.op === 'open' && a.side === 'Buy') {
        first = false
        return { fillLots: 1 }
      }
      return 'fill'
    },
  })
  const { r, passes } = run(spec)
  assertSafe(r, 'part-filled')
  assert.equal(r.outcomes.partial, 1)
  const stage2 = passes.filter((p) => /reversal: stage 2 — selling/.test(p.decision.reason))
  assert.equal(stage2.length, 1, stage2.map((p) => p.decision.reason).join(' | '))
  const sale = stage2[0]?.decision.actions[0]
  assert.ok(sale?.op === 'open' && sale.side === 'Sell' && sale.lots === 1, `sold ${JSON.stringify(sale)}`)
  assert.ok(r.finalPnl > 0, `P&L ${r.finalPnl.toFixed(0)}`)
})

test('fills — a stage-1 long held back four passes: the book is in flight, nothing more is routed, then stage 2 completes', () => {
  let first = true
  const spec = day('M7 delayed long', M7, {
    fills: (_pass, a) => {
      if (first && a.op === 'open' && a.side === 'Buy') {
        first = false
        return { delayPasses: 4 }
      }
      return 'fill'
    },
  })
  const { r, passes } = run(spec)
  assertSafe(r, 'delayed')
  assert.equal(r.outcomes.delayed, 1)
  const i = passes.findIndex((p) => p.decision.trigger === 'dl-open' && p.decision.actions.length > 0)
  assert.ok(i >= 0)
  for (const p of passes.slice(i + 1, i + 4)) {
    assert.equal(p.inputs.inFlight, true)
    assert.equal(p.decision.actions.length, 0, `routed while in flight: ${p.decision.reason}`)
  }
  assert.equal(entriesOf(passes).length, 1, 'one entry, never a second open over the first')
  assert.ok(passes.some((p) => /reversal: stage 2 — selling 1 short\(s\): 2 /.test(p.decision.reason)), 'stage 2 sells both lots once the long is held')
  assert.ok(r.finalPnl > 0, `P&L ${r.finalPnl.toFixed(0)}`)
})

test('the preset this suite trades is spec v2 §8.2\'s Reversal column', () => {
  assert.deepEqual(
    [D.pb_playbook, D.pb_min_dte, D.pb_lots, D.pb_entry_start_min, D.pb_entry_end_min, D.pb_max_entries, D.pb_confirm_s],
    [3, 1, 2, 600, 810, 1, 120],
  )
  assert.deepEqual(
    [D.pb_trade_max_loss, D.pb_trade_target, D.pb_target_max_frac, D.pb_trail_start, D.pb_late_trail_start, D.pb_late_min, D.pb_trail_keep],
    [6_000, 12_000, 0.7, 0, 2_000, 780, 0.6],
  )
  assert.deepEqual(
    [D.pb_strike_mode, D.pb_debit_stop_frac, D.pb_flip_confirm_s, D.pb_max_adds, D.pb_rev_min_ext, D.pb_rev_retrace, D.pb_rev_stop_k, D.pb_stop_hold_s],
    [0, 0.4, 90, 0, 0.6, 0.35, 0.1, 20],
  )
  assert.deepEqual([D.dl_day_max_loss, D.dl_day_target], [9_000, 15_000])
})

// ── robustness to one bad print (spec M11; the Task 11 findings) ────────────

test('exits — back to the open reads the STEADIED index: one bad print through the open banks nothing', () => {
  // The fade of an up-move holds a put spread; the true index sits 60 above the
  // open, and only the NEWEST print — a bad one — reads at the open itself.
  const badPrint = (ms: number, nowMs: number): number => (ms === nowMs ? OPEN : OPEN + 60)
  const one = REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN, regime: 'chop', level: badPrint }))
  assert.equal(one.exit, undefined, 'the median of the last three prints is 25,060 — not the open')
  // Three prints at the open are the open: the trade banks, passively.
  const real = REVERSAL.exits(ctx({ pb: SHORT_TRADE, S: OPEN, regime: 'chop' }))
  assert.equal(real.exit?.urgency, 'passive')
  assert.match(real.exit?.reason ?? '', /^back to the open/)
})

test('enter and flip-back act only on a trend the TAPE shows, not one the detector dwell holds', () => {
  // The label says trend-down (held 130 s) but the slow window now reads chop:
  // the dwell after a bad print, not a counter-trend — no fade opens.
  assert.match(reasonOf(ctx({ regime: 'trend-down', tape: 'chop' })), /the slow window now reads chop: the detector's dwell, not the tape/)
  assert.equal(REVERSAL.enter(ctx({ regime: 'trend-down', tape: 'trend-down' })).kind, 'open')
  // A losing fade of an up-move, the ORIGINAL trend-up label held 95 s past the
  // 90 s flip: with the tape showing it, the flip fires; with the tape showing
  // chop, it is the dwell talking and the trade is held.
  const losing = { pb: SHORT_TRADE, S: OPEN + 100, regime: 'trend-up' as Regime, heldS: 95, tradePnl: -200, cost: 10_000 }
  assert.match(REVERSAL.exits(ctx({ ...losing, tape: 'trend-up' })).exit?.reason ?? '', /^flip back/)
  assert.equal(REVERSAL.exits(ctx({ ...losing, tape: 'chop' })).exit, undefined)
})

