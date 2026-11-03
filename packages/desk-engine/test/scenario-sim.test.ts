/**
 * THE SCENARIO SIMULATOR'S OWN TESTS — the harness the playbook suites stand on.
 *
 * Three later suites (Trend Drive and Expiry Drive, Wing Straddle and Expiry
 * Theta Fly, Reversal Spread and Expiry Gamma Breakout) assert entries, exits,
 * P&L signs and the no-naked-short rule off `runSession`. Every one of those
 * assertions is only as honest as the tape, the chain and the fills underneath
 * it, so each is pinned here first:
 *
 *   - the TAPE is deterministic for a seed, its drift is exact, a spike is one
 *     print and nothing else, and the vol ramps where the segment says;
 *   - the CHAIN is Black-76 at the carried forward, on ticks, with the stated
 *     spreads, and put-call parity holds at every strike;
 *   - the FILLS pay the spread: a buy at the ask, a sell at the bid;
 *   - the NAKED-SHORT count is lot-for-lot coverage by a long of the same type,
 *     wherever its strike — a debit spread's protective long sits ITM of its
 *     short, a fly's wing OTM of it, and both are defined risk;
 *   - the DRIVER persists `stateAfter` only when actions go out, counts the
 *     book's orders over the last minute, starves the ring inside a hole, holds
 *     the chain inside a quote freeze, and shows a spike to the ring alone;
 *   - and end to end, `decideDeltaLean` reads bursts sized in the chain's own
 *     implied move as a trend and opens on them, which is the proof that the
 *     detector, not the harness, is what fires.
 *
 * THE DAY is Friday 16 Oct 2026 against NIFTY's weekly of Monday 19 Oct (moved
 * off Tuesday by Dussehra): three calendar days, 750 trading minutes at the
 * open, and a pre-expiry tenor that does not shorten intraday — so a flat index
 * and a flat vol quote the same book all day, which is what lets the fill test
 * predict its P&L to the paisa.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RISK_FREE, midOf, yearFrac } from '../src/marking.ts'
import { atmStraddleMid, type WindowStat } from '../src/delta-lean/regime.ts'
import { decideDeltaLean, type DeltaLeanInputs } from '../src/delta-lean/decide.ts'
import type { EngineAction, EngineDecision, OptType, Quote, RuleState, Trigger, Urgency } from '../src/types.ts'
import { indexPath, istMs, ivPath, type ScenarioSpec, type Segment } from './scenario/paths.ts'
import { buildChain, impliedMove, LOT, STEP } from './scenario/chain-model.ts'
import { minutesToExpiry, presetDials, runSession, type DecideFn } from './scenario/sim.ts'

const DATE = '2026-10-16' // a Friday
const EXPIRY = '2026-10-19' // the Monday: NIFTY's weekly, a day early for Dussehra
const OPEN = 25_000
const IV = 0.12
const DIALS = presetDials('delta-lean-conservative')

/** Epoch ms of an IST minute of `DATE` — fractional minutes are seconds. */
const at = (minute: number): number => istMs(DATE, minute)

function spec(over: Partial<ScenarioSpec> & Pick<ScenarioSpec, 'segments'>): ScenarioSpec {
  return {
    name: 'harness', symbol: 'NIFTY', dateIst: DATE, expiry: EXPIRY,
    open: OPEN, baseIv: IV, seed: 1, ...over,
  }
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`)
}

/** The move the detector compares the tape against, read off the chain the day
 * opens on — the yardstick every burst below is sized in. */
function impliedAt(minute: number, windowMin: number): number {
  const chain = buildChain({
    symbol: 'NIFTY', expiry: EXPIRY, dateIst: DATE, minuteOfDay: minute,
    index: OPEN, atmIv: IV, nowMs: at(minute),
  })
  return impliedMove(chain, minutesToExpiry(DATE, minute, EXPIRY), windowMin)
}

// ── scripted decide functions ──────────────────────────────────────────────

const buy = (strike: number, optType: OptType, lots = 1): EngineAction =>
  ({ op: 'open', strike, optType, side: 'Buy', lots })
const sell = (strike: number, optType: OptType, lots = 1): EngineAction =>
  ({ op: 'open', strike, optType, side: 'Sell', lots })
const closeAll = (inputs: DeltaLeanInputs): readonly EngineAction[] =>
  inputs.legs.map((l): EngineAction => ({ op: 'close', instrument: l.instrument }))

function decision(
  state: RuleState, actions: readonly EngineAction[], trigger: Trigger, reason: string,
): EngineDecision {
  return {
    action: actions.length === 0 ? 'hold' : 'adjust', trigger, reason, actions,
    stateAfter: state, markState: state, urgency: 'passive', makerQuote: false, creditCommit: null,
  }
}

interface Step {
  readonly at: number // an IST minute; the pass on that exact instant acts
  readonly trigger: Trigger
  readonly act: (inputs: DeltaLeanInputs) => readonly EngineAction[]
}

/** Plays a script and holds otherwise. `watch` sees every pass's inputs. */
function scripted(steps: readonly Step[], watch?: (inputs: DeltaLeanInputs) => void): DecideFn {
  return (inputs, _dials, state) => {
    watch?.(inputs)
    const step = steps.find((s) => istMs(inputs.dateIst, s.at) === inputs.nowMs)
    return step === undefined
      ? decision(state, [], 'none', 'scripted hold')
      : decision(state, step.act(inputs), step.trigger, `scripted at ${step.at}`)
  }
}

// ── the tape ───────────────────────────────────────────────────────────────

test('indexPath is deterministic for a seed, exact in its drift, and flat after the last segment', () => {
  const segments: Segment[] = [
    { minutes: 30, drift: 60, noise: 4 },
    { minutes: 10, drift: -20, noise: 4 },
  ]
  const s = spec({ seed: 42, segments })
  const a = indexPath(s)
  const b = indexPath(s)
  const other = indexPath({ ...s, seed: 43 })
  let differs = 0
  for (let t = at(555); t <= at(930); t += 2_000) {
    assert.equal(a(t), b(t))
    if (a(t) !== other(t)) differs += 1
  }
  assert.ok(differs > 1_000, `seed 43 moved only ${differs} samples`)
  assert.equal(a(at(700)), a(at(595)), 'the path holds flat after its last segment')

  const clean = indexPath({ ...s, segments: segments.map((g) => ({ ...g, noise: 0 })) })
  near(clean(at(570)), OPEN + 30, 1e-9, 'half the first segment')
  near(clean(at(585)), OPEN + 60, 1e-9, 'the end of the first segment')
  near(clean(at(595)), OPEN + 40, 1e-9, 'the end of the second')
  assert.equal(clean(at(555) - 60_000), OPEN, 'before the open the index is the open')
})

test('a spike changes exactly one sample', () => {
  const s = spec({ seed: 9, segments: [{ minutes: 375, drift: 0, noise: 5 }] })
  const plain = indexPath(s)
  const spiked = indexPath({ ...s, spikes: [{ atMin: 640, pts: 250 }] })
  const changed: number[] = []
  for (let t = at(555); t <= at(930); t += 2_000) if (plain(t) !== spiked(t)) changed.push(t)
  assert.deepEqual(changed, [at(640)])
  near(spiked(at(640)) - plain(at(640)), 250, 1e-9, 'the bad print')
})

test('ivPath ramps linearly to ivTo across its segment and holds it', () => {
  const iv = ivPath(spec({
    segments: [
      { minutes: 60, drift: 0, noise: 0 },
      { minutes: 5, drift: 0, noise: 0, ivTo: 0.156 },
      { minutes: 30, drift: 0, noise: 0 },
    ],
  }))
  assert.equal(iv(at(555)), IV)
  near(iv(at(615)), IV, 1e-12, 'before the ramp')
  near(iv(at(617.5)), 0.138, 1e-12, 'half way up the ramp')
  near(iv(at(620)), 0.156, 1e-12, 'the top of the ramp')
  near(iv(at(800)), 0.156, 1e-12, 'held after the last segment')
})

// ── the chain ──────────────────────────────────────────────────────────────

const NO_QUOTE: Quote = { bid: null, ask: null, ltp: null, asOf: 0 }

test('buildChain: 51 strikes around the forward, ticks of 0.05, the stated spreads, and put-call parity to 0.1 at every strike', () => {
  const cases = [
    { symbol: 'NIFTY', expiry: EXPIRY, minute: 600, index: 25_000, iv: 0.12 }, // 3 calendar days
    { symbol: 'NIFTY', expiry: DATE, minute: 600, index: 25_013, iv: 0.15 }, // 0-DTE, 330 minutes left
    { symbol: 'SENSEX', expiry: '2026-10-22', minute: 700, index: 82_000, iv: 0.14 },
  ] as const
  for (const c of cases) {
    const chain = buildChain({
      symbol: c.symbol, expiry: c.expiry, dateIst: DATE, minuteOfDay: c.minute,
      index: c.index, atmIv: c.iv, nowMs: at(c.minute),
    })
    const t = yearFrac(DATE, c.expiry, c.minute)
    const fwd = c.index * Math.exp(RISK_FREE * t)
    const step = STEP[c.symbol]
    const atm = Math.round(fwd / step) * step
    near(chain.spot, fwd, 1e-9, `${c.symbol} forward`)
    assert.equal(chain.step, step)
    assert.equal(chain.lotSize, LOT[c.symbol])
    assert.equal(chain.asOf, at(c.minute))
    assert.deepEqual(chain.strikes.map((r) => r.strike), Array.from({ length: 51 }, (_, i) => atm + (i - 25) * step))

    for (const row of chain.strikes) {
      const wide = Math.abs(row.strike - atm) > 10 * step
      for (const q of [row.ce, row.pe]) {
        assert.ok(q !== null && q.bid !== null && q.ask !== null && q.ltp !== null, `${row.strike} is two-sided`)
        for (const px of [q.bid, q.ask, q.ltp]) near(px * 20, Math.round(px * 20), 1e-9, `${px} on the 0.05 tick`)
        assert.equal(q.asOf, chain.asOf)
        const mid = q.ltp
        assert.ok(mid >= 0.05, 'the mid is floored at 0.05')
        near(midOf(q) ?? Number.NaN, mid, 1e-9, 'the quote is centred on its mid')
        const rule = Math.max(0.05, 0.004 * mid) * (wide ? 2 : 1)
        const half = (q.ask - q.bid) / 2
        if (q.bid > 0) {
          assert.ok(half >= rule - 1e-9 && half < rule + 0.1 + 1e-9, `${row.strike}: half-spread ${half} against ${rule}`)
        } else {
          near(q.ask, 2 * mid, 1e-9, 'a quote at the floor narrows to stay centred')
        }
      }
      const ce = midOf(row.ce ?? NO_QUOTE) ?? Number.NaN
      const pe = midOf(row.pe ?? NO_QUOTE) ?? Number.NaN
      near(ce - pe, Math.exp(-RISK_FREE * t) * (fwd - row.strike), 0.1, `${c.symbol} ${row.strike} parity`)
    }
  }
  const stale = buildChain({
    symbol: 'NIFTY', expiry: EXPIRY, dateIst: DATE, minuteOfDay: 600,
    index: OPEN, atmIv: IV, nowMs: at(600), quoteAsOf: at(599),
  })
  assert.equal(stale.asOf, at(599))
  assert.ok(stale.strikes.every((r) => r.ce?.asOf === at(599) && r.pe?.asOf === at(599)))
})

test('impliedMove is the ATM straddle scaled by the square root of the window', () => {
  const chain = buildChain({
    symbol: 'NIFTY', expiry: EXPIRY, dateIst: DATE, minuteOfDay: 600,
    index: OPEN, atmIv: IV, nowMs: at(600),
  })
  const mte = minutesToExpiry(DATE, 600, EXPIRY)
  const m5 = impliedMove(chain, mte, 5)
  near(impliedMove(chain, mte, 20) / m5, 2, 1e-12, 'four times the window, twice the move')
  near(impliedMove(chain, mte, 1.25) / m5, 0.5, 1e-12, 'a quarter of the window, half the move')
  near(m5, (atmStraddleMid(chain) ?? Number.NaN) * Math.sqrt(5 / mte), 1e-9, 'the straddle over sqrt(MTE)')
  assert.throws(() => impliedMove(chain, 0, 5), RangeError, 'no time left is no reading, never a zero bar')
})

test('minutesToExpiry counts trading minutes to the 15:30 settle, holidays and weekends out', () => {
  assert.equal(minutesToExpiry(DATE, 555, EXPIRY), 750) // Friday and Monday, whole
  assert.equal(minutesToExpiry(DATE, 600, EXPIRY), 330 + 375)
  assert.equal(minutesToExpiry('2026-10-19', 555, '2026-10-27'), 6 * 375) // Dussehra (20th) and a weekend out
  assert.equal(minutesToExpiry('2026-10-19', 500, '2026-10-19'), 375) // a pre-open minute buys no time
  assert.equal(minutesToExpiry('2026-10-19', 940, '2026-10-19'), 0) // past the close
  assert.equal(minutesToExpiry('2026-10-20', 600, '2026-10-20'), 0) // a holiday contributes nothing
  assert.equal(minutesToExpiry('2026-10-19', 600, DATE), 0) // an expiry already past
})

// ── the driver ─────────────────────────────────────────────────────────────

test('fills at the touch — a buy at the ask, a sell at the bid — and each flat-to-flat round trip is one trade', () => {
  const r = runSession(scripted([
    { at: 600, trigger: 'dl-open', act: () => [buy(25_000, 'CE')] },
    { at: 630, trigger: 'eod', act: closeAll },
    { at: 640, trigger: 'dl-open', act: () => [sell(25_000, 'PE', 2)] },
    { at: 650, trigger: 'dl-stop', act: closeAll },
  ]), DIALS, spec({ segments: [] }))

  const row = buildChain({
    symbol: 'NIFTY', expiry: EXPIRY, dateIst: DATE, minuteOfDay: 600,
    index: OPEN, atmIv: IV, nowMs: at(600),
  }).strikes.find((x) => x.strike === 25_000)
  const spread = (q: Quote | null | undefined): number => (q?.ask ?? Number.NaN) - (q?.bid ?? Number.NaN)
  const callCost = spread(row?.ce) * LOT.NIFTY
  const putCost = spread(row?.pe) * 2 * LOT.NIFTY
  assert.ok(callCost > 0 && putCost > 0)

  assert.deepEqual(
    r.trades.map((x) => [x.openMin, x.closeMin, x.openTrigger, x.closeTrigger, x.side]),
    [[600, 630, 'dl-open', 'eod', ''], [640, 650, 'dl-open', 'dl-stop', '']],
  )
  assert.equal(r.trades[1]?.closeReason, 'scripted at 650')
  near(r.trades[0]?.pnl ?? Number.NaN, -callCost, 1e-9, 'the long call pays its spread')
  near(r.trades[1]?.pnl ?? Number.NaN, -putCost, 1e-9, 'the short puts pay theirs')
  near(r.finalPnl, -callCost - putCost, 1e-9, 'final')
  near(r.minPnl, -callCost - putCost, 1e-9, 'the low is marked on the exit side as the fill lands')
  assert.equal(r.maxPnl, 0)
  assert.equal(r.orders, 4)
  assert.equal(r.nakedShortPasses, 150, 'the short puts were naked for ten minutes of 4-second passes')
})

test('the naked-short count: every short covered lot for lot by a long of its own type, wherever its strike', () => {
  const flat = spec({ segments: [], startMin: 590, endMin: 640 })
  const naked = (steps: readonly Step[]): number => runSession(scripted(steps), DIALS, flat).nakedShortPasses
  // A debit call spread: the protective long is ITM of its short. Defined risk.
  assert.equal(naked([{ at: 600, trigger: 'dl-open', act: () => [buy(24_950, 'CE'), sell(25_150, 'CE')] }]), 0)
  // An iron fly: the wings are OTM of the shorts. Defined risk.
  assert.equal(naked([{
    at: 600, trigger: 'dl-open',
    act: () => [buy(25_200, 'CE'), buy(24_800, 'PE'), sell(25_000, 'CE'), sell(25_000, 'PE')],
  }]), 0)
  // A naked call for ten minutes, then its wing.
  assert.equal(naked([
    { at: 600, trigger: 'dl-open', act: () => [sell(25_150, 'CE')] },
    { at: 610, trigger: 'dl-open', act: () => [buy(25_300, 'CE')] },
  ]), 150)
  // Two lots short against one long is one lot naked.
  assert.equal(naked([
    { at: 600, trigger: 'dl-open', act: () => [buy(25_300, 'CE'), sell(25_150, 'CE', 2)] },
    { at: 605, trigger: 'eod', act: closeAll },
  ]), 75)
  // A long call does not cover a short put.
  assert.equal(naked([
    { at: 600, trigger: 'dl-open', act: () => [buy(25_000, 'CE'), sell(24_800, 'PE')] },
    { at: 601, trigger: 'eod', act: closeAll },
  ]), 15)
})

test('the driver persists stateAfter when actions go out and markState when none do, and counts the last minute\'s orders', () => {
  const seen = new Map<number, number>()
  const acts = new Set([at(600), at(600) + 8_000])
  const decide: DecideFn = (inputs, _dials, state) => {
    seen.set(inputs.nowMs, inputs.ordersThisMinute)
    const acting = acts.has(inputs.nowMs)
    return {
      ...decision(state, acting ? [buy(25_000, 'CE')] : [], acting ? 'dl-add' : 'none', 'counting'),
      stateAfter: { ...state, lastActionMs: inputs.nowMs, gkStreak: state.gkStreak + (acting ? 1_000 : 1) },
      markState: { ...state, gkStreak: state.gkStreak + 1 },
    }
  }
  const r = runSession(decide, DIALS, spec({ segments: [], startMin: 590, endMin: 610 }))
  assert.equal(r.decisions.length, 20 * 15 + 1)
  assert.equal(r.finalState.lastActionMs, at(600) + 8_000)
  assert.equal(r.finalState.gkStreak, 299 + 2 * 1_000, 'every hold banked its markState, every act its stateAfter')
  assert.equal(seen.get(at(600)), 0)
  assert.equal(seen.get(at(600) + 4_000), 1)
  assert.equal(seen.get(at(600) + 12_000), 2)
  assert.equal(seen.get(at(601)), 1, "10:00:00's order has left the minute, 10:00:08's has not")
  assert.equal(seen.get(at(601) + 8_000), 0)
})

test('the feed: a hole starves the ring, a quote freeze holds the chain at its first instant, and a spike reaches the ring but not the chain', () => {
  const s = spec({
    seed: 5,
    segments: [{ minutes: 375, drift: 0, noise: 3 }],
    holes: [{ fromMin: 600, toMin: 605 }],
    quoteFreezes: [{ fromMin: 620, toMin: 625 }],
    spikes: [{ atMin: 640, pts: 120 }],
  })
  interface Seen { readonly spotAsOf: number; readonly chainAsOf: number; readonly spot: number; readonly recent: WindowStat | null }
  const seen = new Map<number, Seen>()
  runSession(scripted([], (inputs) => {
    seen.set(inputs.nowMs, {
      spotAsOf: inputs.spotAsOf, chainAsOf: inputs.chain.asOf, spot: inputs.chain.spot,
      recent: inputs.ring.window(inputs.nowMs, 16),
    })
  }), DIALS, s)
  const pass = (ms: number): Seen => {
    const v = seen.get(ms)
    assert.ok(v !== undefined, `no pass at ${new Date(ms).toISOString()}`)
    return v
  }

  assert.equal(pass(at(600) - 4_000).spotAsOf, at(600) - 4_000)
  assert.equal(pass(at(602)).spotAsOf, at(600) - 2_000, 'the last print before the hole')
  assert.equal(pass(at(605) - 4_000).recent, null, 'nothing printed in the last 16 s of the hole')
  assert.equal(pass(at(605)).spotAsOf, at(605), 'the feed is back at the end of the hole')
  assert.equal(pass(at(610)).chainAsOf, at(610), 'a live chain is stamped now')

  const frozen = pass(at(620))
  for (let ms = at(620); ms < at(625); ms += 4_000) {
    assert.equal(pass(ms).chainAsOf, at(620))
    assert.equal(pass(ms).spot, frozen.spot)
  }
  assert.equal(pass(at(625)).chainAsOf, at(625), 'the quotes move again at the end of the freeze')

  const spike = pass(at(640))
  assert.ok((spike.recent?.displacement ?? 0) > 100, 'the bad print is the ring\'s newest sample')
  const clean = indexPath({ ...s, spikes: [] })(at(640))
  near(spike.spot, clean * Math.exp(RISK_FREE * yearFrac(DATE, EXPIRY, 640)), 1e-6, 'the chain prices the clean index')
  const next = pass(at(640) + 4_000)
  assert.ok(Math.abs(next.recent?.displacement ?? Number.POSITIVE_INFINITY) < 60, 'one print, then normal')
  assert.ok((next.recent?.range ?? 0) > 100, 'the print is still inside the window')
})

// ── fill outcomes ──────────────────────────────────────────────────────────

/** A decide function keyed by exact pass instants, holding otherwise. */
function at_(steps: ReadonlyMap<number, readonly [Trigger, Urgency, (inputs: DeltaLeanInputs) => readonly EngineAction[]]>): DecideFn {
  return (inputs, _dials, state) => {
    const s = steps.get(inputs.nowMs)
    return s === undefined
      ? decision(state, [], 'none', 'scripted hold')
      : { ...decision(state, s[2](inputs), s[0], 'scripted'), urgency: s[1] }
  }
}

test('fills: a skipped all-open package rolls back to markState with the adjust stamp kept; a failed one keeps stateAfter; neither makes a leg', () => {
  const decide: DecideFn = (inputs, _dials, state) => {
    if (inputs.nowMs !== at(600)) return decision(state, [], 'none', 'hold')
    return {
      ...decision(state, [buy(25_000, 'CE')], 'dl-open', 'open'),
      stateAfter: { ...state, dlLastAdjustMs: inputs.nowMs, dlOpenedMs: inputs.nowMs },
      markState: { ...state, gkStreak: 7 },
    }
  }
  const flat = spec({ segments: [], startMin: 595, endMin: 605 })
  const skip = runSession(decide, DIALS, { ...flat, fills: () => 'skip' })
  assert.equal(skip.trades.length, 0)
  assert.equal(skip.finalState.dlOpenedMs, 0, 'rolled back: the open never happened')
  assert.equal(skip.finalState.gkStreak, 7, 'to the mark')
  assert.equal(skip.finalState.dlLastAdjustMs, at(600), 'the adjust stamp kept, so the retry is paced')
  assert.deepEqual(skip.outcomes, { skipped: 1, failed: 0, delayed: 0, partial: 0, cancelled: 0 })
  const fail = runSession(decide, DIALS, { ...flat, fills: () => 'fail' })
  assert.equal(fail.trades.length, 0)
  assert.equal(fail.finalState.dlOpenedMs, at(600), 'a FAILED decision keeps stateAfter')
  assert.equal(fail.outcomes.failed, 1)
  const plain = runSession(decide, DIALS, flat)
  assert.equal(plain.trades.length, 1, 'no hook: it fills at once, as before')
  assert.deepEqual(plain.outcomes, { skipped: 0, failed: 0, delayed: 0, partial: 0, cancelled: 0 })
})

test('fills: a held-back fill lands that many passes later; meanwhile the book is in flight and nothing it decides is routed', () => {
  const seen: Array<readonly [number, boolean | undefined, number, number]> = []
  const decide: DecideFn = (inputs, _dials, state) => {
    seen.push([inputs.nowMs, inputs.inFlight, inputs.pendingLots, inputs.legs.length])
    const acting = inputs.nowMs === at(600) || inputs.nowMs === at(600) + 4_000
    return {
      ...decision(state, acting ? [buy(25_000, 'CE', 2)] : [], acting ? 'dl-open' : 'none', 'opening'),
      markState: { ...state, gkStreak: state.gkStreak + 1 },
    }
  }
  const r = runSession(decide, DIALS, { ...spec({ segments: [], startMin: 599, endMin: 601 }), fills: () => ({ delayPasses: 3 }) })
  const i = seen.findIndex((s) => s[0] === at(600))
  assert.deepEqual(seen.slice(i, i + 5).map((s) => s.slice(1)), [
    [false, 0, 0], // routes, held back three passes
    [true, 2, 0], // in flight: the same open decided again is NOT routed
    [true, 2, 0],
    [false, 0, 1], // landed at the start of the third pass after
    [false, 0, 1],
  ])
  assert.equal(r.orders, 1)
  assert.equal(r.trades[0]?.openTrigger, 'dl-open')
  assert.equal(r.trades[0]?.openMin, 600)
  assert.deepEqual(r.outcomes, { skipped: 0, failed: 0, delayed: 1, partial: 0, cancelled: 0 })
})

test('fills: a partial fill takes that many lots of an open, or off the position a close takes off, and leaves the rest unfilled', () => {
  const lots: number[] = []
  const decide = at_(new Map([
    [at(600), ['dl-open', 'passive', () => [buy(25_000, 'CE', 3)]]],
    [at(601), ['dl-exit', 'urgent', closeAll]],
    [at(602), ['dl-exit', 'urgent', closeAll]],
  ]))
  const watch: DecideFn = (inputs, dials, state, markCtx) => {
    if (inputs.nowMs === at(601) || inputs.nowMs === at(602) || inputs.nowMs === at(603)) lots.push(inputs.legs[0]?.lots ?? 0)
    return decide(inputs, dials, state, markCtx)
  }
  const r = runSession(watch, DIALS, {
    ...spec({ segments: [], startMin: 599, endMin: 604 }),
    fills: (_i, a) => (a.op === 'open' ? { fillLots: 2 } : { fillLots: 1 }),
  })
  assert.deepEqual(lots, [2, 1, 0], 'two of three lots bought; one sold off; the last one then')
  assert.equal(r.outcomes.partial, 3)
  assert.equal(r.trades.length, 1)
  assert.equal(r.trades[0]?.closeMin, 602)
})

test('fills: an exit pre-empts the package in flight and cancels what is pending — unless it is that exit, worked as hard', () => {
  const flat = spec({ segments: [], startMin: 590, endMin: 610 })
  const instrument = `NIFTY-${EXPIRY}-25000CE`
  const cancelled = runSession(at_(new Map([
    [at(600), ['dl-open', 'passive', () => [buy(25_000, 'CE')]]],
    [at(600) + 4_000, ['dl-exit', 'urgent', () => [{ op: 'close', instrument }]]],
  ])), DIALS, { ...flat, fills: (_i, a) => (a.op === 'open' ? { delayPasses: 10 } : 'fill') })
  assert.deepEqual(cancelled.outcomes, { skipped: 0, failed: 0, delayed: 1, partial: 0, cancelled: 1 })
  assert.equal(cancelled.trades.length, 0, 'the cancelled open never filled')
  // An exit with nothing to close pre-empts all the same: the host keys on a
  // decision that ACTS (`action !== 'hold'`), not on its action count.
  const emptyExit: DecideFn = (inputs, _dials, state) => {
    if (inputs.nowMs === at(600)) return decision(state, [buy(25_000, 'CE')], 'dl-open', 'open')
    if (inputs.nowMs !== at(600) + 4_000) return decision(state, [], 'none', 'hold')
    return { ...decision(state, [], 'dl-exit', 'abort, nothing held'), action: 'flatten', urgency: 'urgent' }
  }
  const emptied = runSession(emptyExit, DIALS, { ...flat, fills: (_i, a) => (a.op === 'open' ? { delayPasses: 10 } : 'fill') })
  assert.equal(emptied.outcomes.cancelled, 1)
  assert.equal(emptied.trades.length, 0)

  const escalated = runSession(at_(new Map([
    [at(595), ['dl-open', 'passive', () => [buy(25_000, 'CE')]]],
    [at(600), ['eod', 'passive', closeAll]],
    [at(600) + 4_000, ['eod', 'passive', closeAll]], // the same exit, as hard: stands down
    [at(600) + 8_000, ['eod', 'urgent', closeAll]], // escalated: pre-empts
    [at(600) + 12_000, ['eod', 'urgent', closeAll]], // decided against the real book, routed
  ])), DIALS, { ...flat, fills: (_i, a) => (a.op === 'close' ? { delayPasses: 30 } : 'fill') })
  assert.deepEqual(escalated.outcomes, { skipped: 0, failed: 0, delayed: 2, partial: 0, cancelled: 1 })
  assert.equal(escalated.trades.length, 1)
  assert.equal(escalated.trades[0]?.closeMin, 602, 'the urgent close, 30 passes after it was routed')
  assert.equal(escalated.trades[0]?.closeTrigger, 'eod')
})

// ── end to end ─────────────────────────────────────────────────────────────

/**
 * Three 5-minute up-bursts of `k` x the 5-minute implied move from 09:31,
 * 3 minutes apart, on a tape that is otherwise nearly still.
 *
 * The detector wants |displacement| >= 2x the implied move over its 300 s
 * window, on a path >= 0.6 clean, and the label then held 120 s
 * (`dl_adjust_confirm_s`, conservative). So `k` against 2 is the whole test.
 *
 * The morning before the bursts is a two-way chop, 1.2x the implied move a
 * leg, because a still morning reads 'quiet' and the book would open a
 * strangle at 09:30, before any burst. Its last leg is DOWN into 09:31, so
 * the chop cannot lend the first burst any displacement: whatever reads as
 * a trend reads off the bursts alone.
 */
function burstDay(k: number): ScenarioSpec {
  const imp5 = impliedAt(571, 5)
  const zig = (up: boolean): Segment => ({ minutes: 2, drift: (up ? 1 : -1) * 1.2 * imp5, noise: 1.5 })
  const burst: Segment = { minutes: 5, drift: k * imp5, noise: 1.5 }
  const pause: Segment = { minutes: 3, drift: 0, noise: 1.5 }
  return spec({
    name: `three bursts of ${k}x`,
    seed: 11,
    segments: [
      ...[true, false, true, false, true, false, true, false].map(zig), // 09:15-09:31
      burst, pause, burst, pause, burst, // 09:31-09:52
      { minutes: 360, drift: 0, noise: 1.5 },
    ],
  })
}

test('decideDeltaLean, conservative: bursts of 3x implied open a trend-up debit pair before 09:45, never naked, flat by 15:00', () => {
  const s = burstDay(3)
  const day = runSession(decideDeltaLean, DIALS, s)
  const open = day.decisions.find((d) => d.trigger === 'dl-open')
  assert.ok(open !== undefined, 'the bursts never opened the book')
  assert.ok(open.minute >= 571 && open.minute < 585, `opened at minute ${open.minute}`)
  assert.match(open.reason, /^trend-up: opening up/)
  assert.deepEqual(
    open.actions.map((a) => (a.op === 'open' ? [a.optType, a.side, a.lots] : [a.op])),
    [['CE', 'Buy', 2], ['CE', 'Sell', 2]],
  )
  const strikes = open.actions.map((a) => (a.op === 'open' ? a.strike : Number.NaN))
  assert.ok((strikes[1] ?? Number.NaN) > (strikes[0] ?? Number.NaN), 'the short is further OTM than the long')

  assert.ok(day.trades.length >= 1)
  assert.equal(day.trades[0]?.openTrigger, 'dl-open')
  assert.equal(day.trades[0]?.openMin, open.minute)
  assert.equal(day.trades[0]?.side, '', 'decideDeltaLean keeps no playbook side')
  for (const t of day.trades) {
    assert.ok(t.closeMin !== null && t.closeMin <= 900, `a trade still open after 15:00: ${JSON.stringify(t)}`)
  }

  // The open package alone: the same tape, stopped a minute short of the
  // conservative 900 s cooldown, before which no adjustment can be routed.
  const pkg = runSession(decideDeltaLean, DIALS, { ...s, endMin: open.minute + 14 })
  assert.equal(pkg.orders, 2)
  assert.equal(pkg.trades.length, 1)
  assert.equal(pkg.trades[0]?.closeMin, null, 'still holding the open package')
  assert.equal(pkg.nakedShortPasses, 0)
})

test('the control: the same tape with bursts under the 2x bar never reads as a trend', () => {
  const day = runSession(decideDeltaLean, DIALS, burstDay(1.5))
  const trend = day.decisions.find((d) => /trend-(up|down)/.test(d.reason))
  assert.equal(trend, undefined, `1.5x read as a trend at minute ${trend?.minute}: ${trend?.reason}`)
})

test('a flat, noise-only day opens nothing before 09:30, and its noise never reads as a trend', () => {
  const day = runSession(decideDeltaLean, DIALS, spec({
    name: 'flat noise', seed: 3, segments: [{ minutes: 375, drift: 0, noise: 3 }],
  }))
  assert.deepEqual(day.decisions.filter((d) => d.trigger === 'dl-open' && d.minute < 570), [])
  const trend = day.decisions.find((d) => /trend-(up|down)/.test(d.reason))
  assert.equal(trend, undefined, `noise read as a trend: ${trend?.reason}`)
})
