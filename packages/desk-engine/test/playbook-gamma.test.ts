/**
 * EXPIRY GAMMA BREAKOUT (id 6) — six-playbooks spec v2 §5.6, rule by rule,
 * then whole 0-DTE sessions through the scenario harness (spec v2 §7).
 *
 * The playbook is long gamma on the afternoon of expiry: a box the index has
 * held for most of an hour, narrow against what the options charge for an
 * hour, then a break of it by half a 5-minute implied move, at the day's own
 * extreme, with the slow regime trending that way. It buys ONE out-of-the-
 * money option — the first listed strike beyond the forward — as many lots as
 * a ₹6,000 premium budget buys, at most four, and leaves on a premium stop
 * (half the premium), the index back inside the box, or a premium trail that
 * arms at 80% of the premium in profit and keeps 60% of the peak.
 *
 * THE UNIT TESTS call `EXPIRY_GAMMA.enter` / `exits` on a hand-built context
 * over a deterministic tape — a ±10-point sine around 25,000 for the box,
 * then a straight ramp out of it — and a 0-DTE board priced at the ramp's
 * end, so every threshold is pinned at its own edge. The dials are the
 * PRESET's (`pb-expiry-gamma`).
 *
 * THE SCENARIOS run `decidePlaybook` over a NIFTY expiry Tuesday. On 0-DTE at
 * 12% the board charges about 7.4 points for five minutes and 25.6 for an
 * hour, all afternoon, so the box may be 38 points wide and the buffer is
 * about 3.7. A calm, pinned day is built as a slow swing around the open with
 * little noise — a random walk with real noise is not pinned: it wanders a
 * few dozen points over a session and sets the day's extremes in the morning.
 * Each scenario asserts defined risk on every pass and a book flat by 15:00.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeltaLeanInputs } from '../src/delta-lean/decide.ts'
import { atmStraddleMid, type Regime } from '../src/delta-lean/regime.ts'
import { decidePlaybook } from '../src/delta-lean/playbook/decide.ts'
import { EXPIRY_GAMMA } from '../src/delta-lean/playbook/gamma-breakout.ts'
import { windowRange } from '../src/delta-lean/playbook/kit.ts'
import type { PlaybookCtx } from '../src/delta-lean/playbook/types.ts'
import type { ChainSnap, EngineDecision, LegView, PlaybookState, Quote, RuleState } from '../src/types.ts'
import { at, chainAt, ctxOf, DATE, inputsAt, legOn, OPEN, stateWith, Tape, tapeRead } from './playbook-fixture.ts'
import { buildChain } from './scenario/chain-model.ts'
import { indexPath, istMs, type ScenarioSpec, type Segment } from './scenario/paths.ts'
import { presetDials, runSession, type DecideFn, type SimResult } from './scenario/sim.ts'

const G = presetDials('pb-expiry-gamma')
const NOW = at(820) // 13:40, inside the 12:30-14:30 window
const MARK = { isNewMark: true, markIndexToday: 53 }
const MIN = 60_000

// ── a deterministic tape and a hand-built context ───────────────────────────

/** ±`amp` on a 10-minute sine around 25,000 until 13:35 (a whole number of
 * cycles from 09:15, so it is AT 25,000 then), then a straight line to `to`
 * at 13:40. */
function breakTape(to: number, amp = 10, fromMs = at(555)): Tape {
  const turn = at(815)
  return new Tape((ms) => {
    if (ms <= turn) return OPEN + amp * Math.sin((2 * Math.PI * (ms - at(555))) / (10 * MIN))
    return OPEN + ((to - OPEN) * Math.min(1, (ms - turn) / (5 * MIN)))
  }, fromMs)
}

interface Over {
  readonly to?: number // where the ramp ends: S at 13:40
  readonly amp?: number
  readonly tape?: Tape
  readonly S?: number
  readonly pb?: Partial<PlaybookState>
  readonly regime?: Regime
  readonly heldS?: number
  readonly dayRobust?: boolean
  readonly spotFresh?: boolean
  readonly iv?: number
  readonly chain?: (c: ChainSnap) => ChainSnap
  readonly legs?: (c: ChainSnap) => readonly LegView[]
  readonly imp?: (minutes: number) => number | null
  readonly tradePnl?: number
  readonly cost?: number
  readonly nowMs?: number
  readonly dials?: typeof G
  /** The slow window's reading, when it must disagree with the label. */
  readonly onTape?: Regime
}

/** The day: open 25,000, and the box's extremes as the day's own. */
const DAY: Partial<PlaybookState> = { dayOpen: OPEN, dayHigh: OPEN + 10, dayLow: OPEN - 10, dayImplied: 64 }

/** The implied move a hand-built pass reads: the 0-DTE NIFTY board's at 12%
 * (3.3 points a root-minute — 7.4 for five minutes, 25.6 for the hour). Fixed,
 * so a threshold is the same number on every board a test prices at its own
 * index level; the frame tests below read the board's own. */
const IMP = (minutes: number): number => 3.3 * Math.sqrt(minutes)

function ctx(o: Over = {}): PlaybookCtx {
  const nowMs = o.nowMs ?? NOW
  const to = o.to ?? OPEN + 30
  const tape = o.tape ?? breakTape(to, o.amp)
  tape.advanceTo(nowMs)
  const S = o.S ?? tape.ring.latest()?.spot ?? to
  const board = chainAt(nowMs, S, { expiry: DATE, ...(o.iv === undefined ? {} : { atmIv: o.iv }) })
  const chain = o.chain?.(board) ?? board
  const inputs = inputsAt(tape, nowMs, { chain, expiry: DATE, legs: o.legs?.(chain) ?? [] })
  const dials = o.dials ?? G
  const base = ctxOf(inputs, dials, { ...DAY, ...o.pb })
  return {
    ...base,
    spot: S,
    spotFresh: o.spotFresh ?? true,
    imp: o.imp ?? IMP,
    regime: o.regime ?? (S >= OPEN ? 'trend-up' : 'trend-down'),
    read: tapeRead(base.read, o.onTape ?? o.regime ?? (S >= OPEN ? 'trend-up' : 'trend-down')),
    regimeHeldMs: (o.heldS ?? 40) * 1000,
    dayComplete: o.dayRobust ?? true,
    dayRobust: o.dayRobust ?? true,
    ...(o.tradePnl === undefined ? {} : { tradePnl: o.tradePnl }),
    ...(o.cost === undefined ? {} : { cost: o.cost }),
  }
}

const reasonOf = (c: PlaybookCtx): string => {
  const v = EXPIRY_GAMMA.enter(c)
  assert.equal(v.kind, 'wait', `expected a wait, got ${JSON.stringify(v)}`)
  return v.kind === 'wait' ? v.reason : ''
}
const quoteOf = (chain: ChainSnap, strike: number, t: 'CE' | 'PE'): Quote => {
  const row = chain.strikes.find((r) => r.strike === strike)
  const q = t === 'CE' ? row?.ce : row?.pe
  assert.ok(q !== null && q !== undefined, `${strike}${t} is listed`)
  return q
}
const boxOf = (c: PlaybookCtx): { hi: number; lo: number } => {
  const b = windowRange(c, c.nowMs - G.pb_box_min * MIN, c.nowMs - 5 * MIN)
  assert.ok(b !== null, 'the box is covered')
  return b
}
const bufOf = (c: PlaybookCtx): number => G.pb_brk_buf_k * (c.imp(5) ?? Number.NaN)

// ── enter ───────────────────────────────────────────────────────────────────

test('enter: the box must be covered by the tape — a ring restarted 40 minutes ago is no box (O8)', () => {
  // The day survives the restart (dayRobust), the ring does not: it holds
  // 13:00-13:40, and the box is 12:40-13:35.
  const late = breakTape(OPEN + 30, 10, at(780))
  assert.match(reasonOf(ctx({ tape: late })), /the tape does not cover the box 12:40-13:35/)
  assert.equal(EXPIRY_GAMMA.enter(ctx()).kind, 'open', 'the same break on a whole tape trades')
})

test('enter: a box wider than pb_box_max_k x the box-length implied move is no consolidation', () => {
  const c = ctx({ amp: 25 })
  const imp60 = c.imp(60) ?? Number.NaN
  assert.ok(50 > 1.5 * imp60, `a 50-point box against ${imp60.toFixed(1)}`)
  assert.match(reasonOf(c), /the box 24975\.0-25025\.0 is 50\.0 wide, past 1\.5 x the 60-minute implied move \(\d+\.\d\)/)
  assert.match(reasonOf({ ...ctx(), imp: () => null }), /no implied move/)
})

test('enter: S must clear the box by pb_brk_buf_k x the 5-minute implied move — inclusive', () => {
  const c = ctx()
  const box = boxOf(c)
  const buf = bufOf(c)
  assert.ok(buf > 3 && buf < 4.5, `buffer ${buf}`)
  assert.match(reasonOf(ctx({ S: box.hi + buf - 0.01 })), /inside the box: the index 25013\.\d is within 24986\.\d-25013\.\d/)
  assert.equal(EXPIRY_GAMMA.enter(ctx({ S: box.hi + buf })).kind, 'open')
  assert.match(reasonOf(ctx({ S: box.lo - buf + 0.01, regime: 'trend-down' })), /inside the box/)
  assert.equal(EXPIRY_GAMMA.enter(ctx({ S: box.lo - buf, regime: 'trend-down' })).kind, 'open')
})

test('enter: a break needs a robust day and S at the day\'s own extreme, less the buffer', () => {
  assert.match(reasonOf(ctx({ dayRobust: false })), /the day is not robust/)
  const c = ctx()
  const buf = bufOf(c)
  // S = 25,030: a day high a hair under 25,030 + buf is in reach, a hair over is not.
  assert.equal(EXPIRY_GAMMA.enter(ctx({ pb: { dayHigh: OPEN + 30 + buf - 0.01 } })).kind, 'open')
  assert.match(reasonOf(ctx({ pb: { dayHigh: OPEN + 30 + buf + 0.01 } })), /broke the box up, but the index 25030\.0 is \d+\.\d short of the day's high 250\d\d\.\d/)
  assert.match(reasonOf(ctx({ to: OPEN - 30, pb: { dayLow: OPEN - 45 } })), /broke the box down, but the index 24970\.0 is \d+\.\d short of the day's low 24955\.0/)
})

test('enter: the slow regime must trend the break\'s way, held pb_confirm_s — inclusive', () => {
  assert.match(reasonOf(ctx({ regime: 'chop' })), /the regime is chop, not trend-up/)
  assert.match(reasonOf(ctx({ regime: 'trend-down' })), /the regime is trend-down, not trend-up/)
  assert.match(reasonOf(ctx({ heldS: 29.999 })), /trend-up held 29s of the 30s/)
  assert.equal(EXPIRY_GAMMA.enter(ctx({ heldS: 30 })).kind, 'open')
  assert.match(reasonOf(ctx({ to: OPEN - 30, regime: 'trend-up' })), /not trend-down/)
})

test('enter: an up-break buys ONE call — the first listed strike above the forward — sized by the premium budget, capped, single stage', () => {
  const c = ctx()
  const v = EXPIRY_GAMMA.enter(c)
  assert.equal(v.kind, 'open')
  if (v.kind !== 'open') return
  assert.ok(c.fwd > OPEN + 30 && c.fwd < OPEN + 50, `forward ${c.fwd}`)
  const ask = quoteOf(c.inputs.chain, 25_050, 'CE').ask ?? Number.NaN
  const lots = Math.min(G.pb_gamma_max_lots, Math.floor(G.pb_premium_budget / (ask * c.inputs.chain.lotSize)))
  assert.equal(lots, 4, `at ${ask} a lot costs ${ask * 65}: the 4-lot cap binds`)
  assert.deepEqual(v.plan.protective, [{ op: 'open', strike: 25_050, optType: 'CE', side: 'Buy', lots: 1 }])
  assert.deepEqual(v.plan.shorts, [], 'one stage: a long option sells nothing')
  assert.equal(v.plan.side, 'up')
  assert.equal(v.plan.lots, lots)
  const box = boxOf(c)
  assert.deepEqual(v.plan.stamps, { boxHi: box.hi, boxLo: box.lo })
  assert.doesNotMatch(v.plan.reason, /^expiry-gamma: /)
  assert.match(v.plan.reason, /^the index 25030\.0 broke the 24990\.0-25010\.0 box up by 20\.0 \(buffer \d\.\d\), at the day's high, trend-up held 40s — buying the 25050CE at \d+\.\d\d, 4 lot\(s\) inside the Rs6,000 budget/)
})

test('enter: "beyond the forward" is STRICTLY beyond it, and pb_otm_steps walks further out', () => {
  // The forward exactly on a listed strike: that strike is the money, not beyond it.
  const on = EXPIRY_GAMMA.enter(ctx({ chain: (b) => ({ ...b, spot: 25_050 }) }))
  assert.ok(on.kind === 'open')
  assert.equal(on.plan.protective[0]?.strike, 25_100)
  const two = EXPIRY_GAMMA.enter(ctx({ dials: { ...G, pb_otm_steps: 2 } }))
  assert.ok(two.kind === 'open')
  assert.equal(two.plan.protective[0]?.strike, 25_100)
  assert.match(reasonOf(ctx({ dials: { ...G, pb_otm_steps: 0 } })), /pb_otm_steps 0 is not a strike count/)
  assert.match(reasonOf(ctx({ dials: { ...G, pb_otm_steps: 40 } })), /no listed strike 40 step\(s\) beyond the forward/)
})

test('enter: a down-break is the mirror — a put, the first listed strike below the forward', () => {
  const c = ctx({ to: OPEN - 30 })
  const v = EXPIRY_GAMMA.enter(c)
  assert.ok(v.kind === 'open')
  assert.ok(c.fwd < OPEN - 20 && c.fwd > OPEN - 50, `forward ${c.fwd}`)
  assert.deepEqual(v.plan.protective, [{ op: 'open', strike: 24_950, optType: 'PE', side: 'Buy', lots: 1 }])
  assert.equal(v.plan.side, 'down')
  assert.match(v.plan.reason, /broke the 24990\.0-25010\.0 box down by 20\.0 .* at the day's low, trend-down held 40s — buying the 24950PE/)
})

test('enter: the budget sizes the lots — fewer when the premium is rich, none when it cannot buy one (no trade)', () => {
  const rich = ctx({ iv: 0.3 })
  const v = EXPIRY_GAMMA.enter(rich)
  assert.ok(v.kind === 'open')
  const ask = quoteOf(rich.inputs.chain, 25_050, 'CE').ask ?? Number.NaN
  const want = Math.floor(G.pb_premium_budget / (ask * 65))
  assert.ok(want >= 1 && want < G.pb_gamma_max_lots, `at ${ask} the budget buys ${want}`)
  assert.equal(v.plan.lots, want)
  const broke = { ...G, pb_premium_budget: 100 }
  assert.match(reasonOf(ctx({ dials: broke })), /the Rs100 budget buys no lot of 25050CE at \d+\.\d\d x 65 \(Rs\d+ a lot\)/)
})

test('enter: the option must be tradable — a two-sided quote, fresh by the protective-leg bar', () => {
  const oneSided = (b: ChainSnap): ChainSnap => ({
    ...b,
    strikes: b.strikes.map((r) => (r.strike === 25_050 && r.ce !== null ? { ...r, ce: { ...r.ce, bid: null } } : r)),
  })
  assert.match(reasonOf(ctx({ chain: oneSided })), /25050CE is not tradable/)
  const stale = (b: ChainSnap): ChainSnap => ({
    ...b,
    strikes: b.strikes.map((r) => (r.strike === 25_050 && r.ce !== null ? { ...r, ce: { ...r.ce, asOf: b.asOf - (G.pb_wing_fresh_s * 1000 + 1) } } : r)),
  })
  assert.match(reasonOf(ctx({ chain: stale })), /25050CE is not tradable/)
  assert.match(reasonOf(ctx({ spotFresh: false })), /the index is stale/)
})

// ── exits ───────────────────────────────────────────────────────────────────

/** A call bought on an up-break of the 24,990-25,010 box: 4 lots at 6.00. */
const TRADE: Partial<PlaybookState> = {
  entries: 1, tradeOpenMs: at(818), side: 'up', boxHi: OPEN + 10, boxLo: OPEN - 10, planLots: 4, stage: 0, basePnl: 0,
}
const COST = 6 * 4 * 65
const callLeg = (c: ChainSnap): readonly LegView[] => [legOn(c, 25_050, 'CE', 'Buy', 4, { entry: 6, mtm: 0 })]

test('exits — the premium stop: pb_prem_stop_frac of the premium, inclusive, rupee-debounced, urgent', () => {
  const pass = (tradePnl: number, rupeeSinceMs: number, nowMs = NOW): ReturnType<typeof EXPIRY_GAMMA.exits> =>
    EXPIRY_GAMMA.exits(ctx({ pb: { ...TRADE, rupeeSinceMs }, legs: callLeg, tradePnl, nowMs }))
  assert.equal(ctx({ pb: TRADE, legs: callLeg }).cost, COST, 'cost is the premium paid')
  const first = pass(-0.5 * COST, 0)
  assert.equal(first.exit, undefined)
  assert.equal(first.patch?.rupeeSinceMs, NOW)
  const fired = pass(-0.5 * COST, NOW, NOW + 3_000)
  assert.deepEqual([fired.exit?.urgency, fired.exit?.final], ['urgent', false])
  assert.match(fired.exit?.reason ?? '', /^premium stop: trade P&L Rs-780 at or through 0\.5 x the Rs1,560 paid \(Rs-780\), held 3s/)
  const above = pass(-0.5 * COST + 1, NOW, NOW + 3_000)
  assert.equal(above.exit, undefined)
  assert.equal('rupeeSinceMs' in (above.patch ?? {}), false)
})

test('exits — back in the box: S inside the box by the CURRENT buffer, held pb_stop_hold_s, urgent; skipped while S is stale', () => {
  const c0 = ctx({ pb: TRADE, legs: callLeg })
  const buf = bufOf(c0)
  const line = OPEN + 10 - buf
  const first = EXPIRY_GAMMA.exits(ctx({ pb: TRADE, legs: callLeg, S: line }))
  assert.equal(first.exit, undefined)
  assert.equal(first.patch?.condSinceMs, NOW)
  const armed = { ...TRADE, condSinceMs: NOW - G.pb_stop_hold_s * 1000 }
  const fired = EXPIRY_GAMMA.exits(ctx({ pb: armed, legs: callLeg, S: line }))
  assert.deepEqual([fired.exit?.urgency, fired.exit?.final], ['urgent', false])
  assert.match(fired.exit?.reason ?? '', /^back in the box: the index 2500\d\.\d is back inside the 24990\.0-25010\.0 box by \d\.\d \(the buffer \d\.\d\), held 30s/)
  const out = EXPIRY_GAMMA.exits(ctx({ pb: armed, legs: callLeg, S: line + 0.01 }))
  assert.equal(out.exit, undefined)
  assert.equal(out.patch?.condSinceMs, 0)
  // The buffer is today's: a richer 5-minute implied move moves the line.
  const wide = EXPIRY_GAMMA.exits(ctx({ pb: armed, legs: callLeg, S: line, imp: (m) => (m === 5 ? 20 : 30) }))
  assert.equal(wide.exit, undefined, 'a 10-point buffer: 25,006 is not yet back in the box')
  assert.equal(EXPIRY_GAMMA.exits(ctx({ pb: armed, legs: callLeg, S: line, spotFresh: false })).exit, undefined)
  // The mirror: a put on a down-break leaves at boxLo + buffer.
  const put = { ...armed, side: 'down' as const }
  const putLeg = (c: ChainSnap): readonly LegView[] => [legOn(c, 24_950, 'PE', 'Buy', 4, { entry: 6, mtm: 0 })]
  assert.equal(EXPIRY_GAMMA.exits(ctx({ to: OPEN - 30, pb: put, legs: putLeg, S: OPEN - 10 + buf })).exit?.urgency, 'urgent')
  assert.equal(EXPIRY_GAMMA.exits(ctx({ to: OPEN - 30, pb: put, legs: putLeg, S: OPEN - 10 + buf - 0.01 })).exit, undefined)
})

test('exits — the premium trail ARMS at pb_prem_trail_arm x the premium in profit; the frame\'s floor does the firing', () => {
  const arm = EXPIRY_GAMMA.exits(ctx({ pb: TRADE, legs: callLeg, tradePnl: 0.8 * COST }))
  assert.equal(arm.exit, undefined)
  assert.equal(arm.patch?.trailArmed, true)
  assert.match(arm.note ?? '', /premium trail armed at Rs1,248 \(0\.8 x the Rs1,560 paid\)/)
  const shy = EXPIRY_GAMMA.exits(ctx({ pb: TRADE, legs: callLeg, tradePnl: 0.8 * COST - 0.01 }))
  assert.equal('trailArmed' in (shy.patch ?? {}), false)
  const already = EXPIRY_GAMMA.exits(ctx({ pb: { ...TRADE, trailArmed: true, peakPnl: 3_000 }, legs: callLeg, tradePnl: 1_000 }))
  assert.equal(already.exit, undefined, 'the floor is the frame\'s to fire, not the playbook\'s')
})

test('adds: none — a long option is never pyramided', () => {
  assert.deepEqual(EXPIRY_GAMMA.adds(ctx({ pb: TRADE, legs: callLeg, tradePnl: 5_000 })), {})
  assert.equal(EXPIRY_GAMMA.id, 6)
  assert.equal(EXPIRY_GAMMA.name, 'expiry-gamma')
})

// ── through the frame ───────────────────────────────────────────────────────

test('through the frame: on a 0-DTE board the gates pass, the break opens one call in ONE stage, and the box is stamped', () => {
  const tape = breakTape(OPEN + 30)
  const inputs = inputsAt(tape, NOW, { chain: chainAt(NOW, OPEN + 30, { expiry: DATE }), expiry: DATE })
  const state: RuleState = stateWith({}, { dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 40_000 })
  const d: EngineDecision = decidePlaybook(inputs, G, state, MARK)
  assert.equal(d.trigger, 'dl-open', d.reason)
  assert.match(d.reason, /^expiry-gamma: the index 25030\.0 broke the 24990\.0-25010\.0 box up/)
  assert.deepEqual(d.actions, [{ op: 'open', strike: 25_050, optType: 'CE', side: 'Buy', lots: 4 }])
  const pb = d.stateAfter.pb
  assert.deepEqual([pb.side, pb.stage, pb.planLots], ['up', 0, 4])
  assert.ok(Math.abs(pb.boxHi - (OPEN + 10)) < 0.01 && Math.abs(pb.boxLo - (OPEN - 10)) < 0.01, `box ${pb.boxLo}-${pb.boxHi}`)
  // The preset's contract rule: the same day on a weekly that is not today's is no trade.
  const weekly = inputsAt(tape, NOW, { chain: chainAt(NOW, OPEN + 30) })
  assert.match(decidePlaybook(weekly, G, state, MARK).reason, /wrong contract: the preset trades only today's expiry/)
})

test('through the frame: once the playbook arms the trail, the frame\'s common floor fires it at pb_trail_keep x peak, held', () => {
  const tape = breakTape(OPEN + 30)
  const pass = (ms: number, mtm: number, st: RuleState): EngineDecision => {
    const chain = chainAt(ms, OPEN + 30, { expiry: DATE })
    const legs = [legOn(chain, 25_050, 'CE', 'Buy', 4, { entry: 6, mtm })]
    return decidePlaybook(inputsAt(tape, ms, { chain, legs, expiry: DATE }), G, st, MARK)
  }
  const st0 = stateWith({ ...TRADE, ...DAY, statsFromMs: at(555), maxGapMs: 1_000 }, { dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 60_000 })
  const a = pass(NOW, 2_000, st0)
  assert.equal(a.action, 'hold', a.reason)
  assert.equal(a.markState.pb.trailArmed, true, 'armed by the playbook\'s patch')
  assert.equal(a.markState.pb.peakPnl, 2_000)
  const b = pass(NOW + 4_000, 1_200, a.markState) // 60% of 2,000: in the floor's zone
  assert.equal(b.action, 'hold')
  assert.equal(b.markState.pb.rupeeSinceMs, NOW + 4_000)
  const c = pass(NOW + 8_000, 1_150, b.markState)
  assert.equal(c.trigger, 'dl-exit', c.reason)
  assert.equal(c.urgency, 'urgent')
  assert.match(c.reason, /^expiry-gamma: trailing floor: trade P&L Rs1,150 at or under 60% of the Rs2,000 peak/)
})

// ── scenarios (spec v2 §7) ──────────────────────────────────────────────────

const EXPIRY_DAY = '2026-10-27' // a NIFTY expiry Tuesday

/** A pinned stretch: a slow swing of ±`amp`/2 around where it starts, a
 * `period`-minute cycle, `noise` points per root-minute, ending where it began. */
function pinned(minutes: number, amp = 8, period = 20, noise = 0.6): Segment[] {
  const out: Segment[] = [{ minutes: period / 4, drift: amp / 2, noise }]
  let left = minutes - period / 4
  let sign = -1
  while (left > period / 4 + 1e-9) {
    const m = Math.min(period / 2, left - period / 4)
    out.push({ minutes: m, drift: (sign * amp * m) / (period / 2), noise })
    left -= m
    sign = -sign
  }
  // Home: whatever the swing left over, back to the level it started from.
  const offset = out.reduce((s, g) => s + g.drift, 0)
  out.push({ minutes: left, drift: -offset, noise })
  return out
}

function expiryDay(name: string, segments: readonly Segment[], over: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return { name, symbol: 'NIFTY', dateIst: EXPIRY_DAY, expiry: EXPIRY_DAY, open: OPEN, baseIv: 0.12, seed: 7, segments, ...over }
}

interface Pass {
  readonly inputs: DeltaLeanInputs
  readonly state: RuleState
  readonly decision: EngineDecision
}
function run(spec: ScenarioSpec): { readonly r: SimResult; readonly passes: Pass[] } {
  const passes: Pass[] = []
  const decide: DecideFn = (inputs, dials, state, markCtx) => {
    const decision = decidePlaybook(inputs, dials, state, markCtx)
    passes.push({ inputs, state, decision })
    return decision
  }
  return { r: runSession(decide, G, spec), passes }
}

function assertSafe(r: SimResult, what: string): void {
  assert.equal(r.nakedShortPasses, 0, `${what}: ${r.nakedShortPasses} naked pass(es)`)
  for (const t of r.trades) {
    assert.ok(t.closeMin !== null && t.closeMin <= 900, `${what}: a trade still open after 15:00: ${JSON.stringify(t)}`)
  }
}

const entriesOf = (passes: readonly Pass[]): Pass[] =>
  passes.filter((p) => p.decision.trigger === 'dl-open' && p.decision.actions.length > 0)

/** The premium each trade paid: the most the book held long, at its fills. */
function premiumByTrade(passes: readonly Pass[]): Map<number, number> {
  const paid = new Map<number, number>()
  for (const p of passes) {
    const id = p.state.pb.tradeOpenMs
    if (id === 0 || p.inputs.legs.length === 0) continue
    let cost = 0
    for (const l of p.inputs.legs) cost += (l.side === 'Buy' ? 1 : -1) * l.entry * l.lots * l.lotSize
    paid.set(id, Math.max(paid.get(id) ?? 0, cost))
  }
  return paid
}

/** The pinned day the three expiry scenarios share, until `breakAt`. */
const pinnedUntil = (minute: number): Segment[] => pinned(minute - 555)

/** The pinned morning M13 breaks out of. */
const PRE_1340 = pinnedUntil(820)

/** The ATM straddle the board quotes at 13:40 on that tape — the unit M13's
 * break is sized in. Read off the board itself rather than assumed: the pinned
 * walk is not at a strike by 13:40, and the straddle at the strike nearest the
 * forward is dearer than the at-the-money one by the distance between them.
 * The walk draws one shock per sample in order (`paths.ts`), so the level at
 * 13:40 does not depend on the segments after it. */
function straddleAt1340(): number {
  const level = indexPath(expiryDay('probe', PRE_1340))(istMs(EXPIRY_DAY, 820))
  const board = buildChain({
    symbol: 'NIFTY', expiry: EXPIRY_DAY, dateIst: EXPIRY_DAY, minuteOfDay: 820,
    index: level, atmIv: 0.12, nowMs: istMs(EXPIRY_DAY, 820),
  })
  const str = atmStraddleMid(board)
  if (str === null) throw new Error('no straddle on the 13:40 board')
  return str
}
const STR_1340 = straddleAt1340()

/** M13: pinned to 13:40, then 1.5 x the 13:40 straddle in ten minutes, and held. */
const M13: readonly Segment[] = [
  ...PRE_1340,
  { minutes: 10, drift: 1.5 * STR_1340, noise: 0.6 },
  ...pinned(100, 6, 20, 0.6),
]

test('M13 — 0-DTE, calm, then a 1.5 x STR break at 13:40: Gamma enters in the break\'s direction, after it, and ends positive', () => {
  const { r, passes } = run(expiryDay('M13 late break', M13))
  assertSafe(r, 'M13')
  // The tape is what the row says: 1.5 x the straddle the board quotes at 13:40.
  const at1340 = passes.find((p) => p.inputs.minuteOfDay === 820)
  assert.ok(at1340 !== undefined)
  const str = atmStraddleMid(at1340.inputs.chain) ?? Number.NaN
  assert.ok(Math.abs(str - STR_1340) < 1e-9, `the scenario's 13:40 straddle is ${str.toFixed(2)}, the break was sized on ${STR_1340.toFixed(2)}`)
  const opens = entriesOf(passes)
  assert.equal(opens.length, 1, opens.map((p) => p.decision.reason).join(' | '))
  const open = opens[0]
  assert.ok(open !== undefined)
  assert.ok(open.inputs.minuteOfDay >= 820, `entered at ${open.inputs.minuteOfDay}`)
  assert.equal(open.decision.stateAfter.pb.side, 'up')
  const a = open.decision.actions[0]
  assert.ok(a?.op === 'open' && a.optType === 'CE' && a.side === 'Buy')
  assert.ok(r.finalPnl > 0, `P&L ${r.finalPnl.toFixed(0)}: ${r.trades.map((t) => t.closeReason).join(' | ')}`)
})

test('M12 — 0-DTE, calm and pinned all day: the box forms, the break never comes, and Gamma stays out', () => {
  const { r, passes } = run(expiryDay('M12 pinned', pinned(375)))
  assertSafe(r, 'M12')
  assert.equal(entriesOf(passes).length, 0, entriesOf(passes).map((p) => p.decision.reason).join(' | '))
  assert.equal(r.trades.length, 0)
  // Honest about WHY: inside the window the playbook was asked, the box was
  // a real consolidation, and the index sat inside it.
  const asked = passes.filter((p) => p.inputs.minuteOfDay >= 750 && p.inputs.minuteOfDay < 870)
  const inside = asked.filter((p) => /expiry-gamma: inside the box/.test(p.decision.reason))
  assert.ok(inside.length >= 0.9 * asked.length, `${inside.length} of ${asked.length} window passes read "inside the box"`)
})

/** M15: pinned, then a false break up at 13:10 and a false break down at
 * 14:00, each three times the 5-minute implied move out and straight back. */
const M15: readonly Segment[] = [
  ...pinnedUntil(790),
  { minutes: 4, drift: 24, noise: 0.6 },
  { minutes: 4, drift: -24, noise: 0.6 },
  ...pinned(42),
  { minutes: 4, drift: -24, noise: 0.6 },
  { minutes: 4, drift: 24, noise: 0.6 },
  ...pinned(82),
]

/** M15's slack, per trade. The premium stop holds `pb_rupee_hold_s` (3 s) and
 * fills on the next 4 s pass; an index falling back into the box at 6 points a
 * minute moves under a point in those 7 s, which at 4 lots and a 0.3-0.5 delta
 * is ₹50-90. Measured over seeds 1-10 of this tape, the worst trade lost ₹45
 * more than half its premium. */
const M15_SLACK_PER_TRADE = 150

test('M15 — 0-DTE, two false breaks: Gamma takes at most two trades and loses at most half of what each one paid, plus slack', () => {
  const { r, passes } = run(expiryDay('M15 false breaks', M15))
  assertSafe(r, 'M15')
  const opens = entriesOf(passes)
  assert.ok(opens.length >= 1 && opens.length <= 2, `${opens.length} entries: ${opens.map((p) => p.decision.reason).join(' | ')}`)
  assert.ok(r.trades.length <= 2)
  const paid = [...premiumByTrade(passes).values()]
  assert.equal(paid.length, opens.length)
  const bound = paid.reduce((s, c) => s + G.pb_prem_stop_frac * c, 0) + M15_SLACK_PER_TRADE * paid.length
  assert.ok(r.finalPnl >= -bound, `P&L ${r.finalPnl.toFixed(0)} against -${bound.toFixed(0)} (paid ${paid.map((c) => c.toFixed(0)).join(', ')})`)
  for (const t of r.trades) assert.ok(t.pnl < 0, `a false break is a loss: ${JSON.stringify(t)}`)
})

test('O8 — the ring starts at 13:30 (startMin 810): no entry before the box window is covered, and none on the break inside it', () => {
  const { r, passes } = run(expiryDay('O8 late ring', M13, { startMin: 810 }))
  assertSafe(r, 'O8')
  assert.equal(entriesOf(passes).length, 0, entriesOf(passes).map((p) => p.decision.reason).join(' | '))
  // The box [now - 60, now - 5] is 90% covered by a ring that began at 13:30
  // once its samples span 49.5 of its 55 minutes: from 14:24:30. Every pass
  // the playbook itself answered before then names the box.
  const covered = istMs(EXPIRY_DAY, 810 + 5 + 0.9 * 55)
  const early = passes.filter((p) => p.inputs.nowMs < covered && /^expiry-gamma: (?!no new risk)/.test(p.decision.reason))
  assert.ok(early.length > 0, 'the playbook was asked')
  for (const p of early) assert.match(p.decision.reason, /the tape does not cover the box/, `at ${p.inputs.minuteOfDay}`)
  assert.ok(early.some((p) => p.inputs.minuteOfDay >= 820 && p.inputs.minuteOfDay < 830), 'including through the break itself')
})

test('fills — the entry held back three passes: in flight nothing more is routed, one entry only, and the trade still pays', () => {
  let first = true
  const { r, passes } = run(expiryDay('M13 delayed entry', M13, {
    fills: (_pass, a) => {
      if (first && a.op === 'open') {
        first = false
        return { delayPasses: 3 }
      }
      return 'fill'
    },
  }))
  assertSafe(r, 'delayed')
  assert.equal(r.outcomes.delayed, 1)
  const i = passes.findIndex((p) => p.decision.trigger === 'dl-open' && p.decision.actions.length > 0)
  assert.ok(i >= 0)
  for (const p of passes.slice(i + 1, i + 3)) {
    assert.equal(p.inputs.inFlight, true)
    assert.equal(p.decision.actions.length, 0, `routed while in flight: ${p.decision.reason}`)
  }
  assert.equal(entriesOf(passes).length, 1)
  assert.ok(r.finalPnl > 0, `P&L ${r.finalPnl.toFixed(0)}`)
})

test('fills — the entry part-fills (1 of 4 lots): the trade runs at what filled, and is still positive', () => {
  let first = true
  const { r, passes } = run(expiryDay('M13 part-filled entry', M13, {
    fills: (_pass, a) => {
      if (first && a.op === 'open') {
        first = false
        return { fillLots: 1 }
      }
      return 'fill'
    },
  }))
  assertSafe(r, 'part-filled')
  assert.equal(r.outcomes.partial, 1)
  assert.equal(entriesOf(passes).length, 1, 'no top-up: an entry is one package')
  const held = passes.filter((p) => p.inputs.legs.length > 0)
  assert.ok(held.length > 0 && held.every((p) => p.inputs.legs.every((l) => l.lots === 1)), 'one lot held throughout')
  assert.ok(r.finalPnl > 0, `P&L ${r.finalPnl.toFixed(0)}`)
})

test('the preset this suite trades is spec v2 §8.2\'s Expiry Gamma column', () => {
  assert.deepEqual(
    [G.pb_playbook, G.pb_min_dte, G.pb_expiry_day_only, G.pb_entry_start_min, G.pb_entry_end_min, G.pb_max_entries, G.pb_reentry_cooldown_s, G.pb_confirm_s],
    [6, 0, true, 750, 870, 2, 600, 30],
  )
  assert.deepEqual(
    [G.pb_trade_max_loss, G.pb_trade_target, G.pb_trail_start, G.pb_late_trail_start, G.pb_trail_keep],
    [4_000, 0, 0, 0, 0.6],
  )
  assert.deepEqual(
    [G.pb_box_min, G.pb_box_max_k, G.pb_brk_buf_k, G.pb_premium_budget, G.pb_gamma_max_lots, G.pb_otm_steps, G.pb_prem_stop_frac, G.pb_prem_trail_arm, G.pb_stop_hold_s],
    [60, 1.5, 0.5, 6_000, 4, 1, 0.5, 0.8, 30],
  )
  assert.deepEqual([G.dl_day_max_loss, G.dl_day_target], [8_000, 15_000])
})

test('enter: a breakout counts only while the TAPE shows the trend — a 30 s confirm inside the 120 s dwell is not enough (M11)', () => {
  // The default context is a clean break above the box with the label held 40 s.
  assert.equal(EXPIRY_GAMMA.enter(ctx()).kind, 'open')
  // Same label, same 40 s — but the slow window reads chop: one bad print turned
  // the label and the detector's dwell is holding it. No breakout.
  const v = EXPIRY_GAMMA.enter(ctx({ onTape: 'chop' }))
  assert.equal(v.kind, 'wait')
  assert.match(v.kind === 'wait' ? v.reason : '', /the slow window now reads chop: the detector's dwell, not the tape/)
})

