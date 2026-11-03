/**
 * THE OBJECTIVE SEARCH: A TRADER'S GOAL ON THE REPAIRER'S BEAM.
 *
 * `searchPlans` is the second thing in this package that RECOMMENDS, and the
 * one a language model drives, so the suite is built around the ways it could
 * mislead a trader who did not write the spec by hand:
 *
 *   1. THE SPEC IS NOT WHAT RAN. A model sends `maxMoves: 9`, a close it was
 *      never allowed, EV with no view. Normalisation must clamp, strip and
 *      refuse — and say what it refused.
 *   2. THE GOAL IS NOT THE GOAL. Each preset gets its direction checked on a
 *      real book: "cut gamma" must make gamma LESS SHORT, not more.
 *   3. SAFER IS ADVISORY. The floor guard, the margin cap, liquidity and the
 *      crossing side are each checked on the output, not on the code path.
 *   4. THE ANSWER MOVES. Same inputs, same bytes.
 *
 * THE BOOK: a short strangle gone wrong on the call side — short 780CE and
 * short 720PE, two lots of a thousand, 36 days out, future at 786. Delta about
 * −770 shares, floor about −₹1.1L at the top of the scan.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, b76Greeks, b76ImpliedVol, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE, type PayoffLeg } from '../src/legs.ts'
import { DEFAULT_REPAIR_DIALS, type StrikeInfo } from '../src/candidates.ts'
import { spanLiteMargin } from '../src/margin.ts'
import {
  normaliseObjective,
  OBJECTIVE_PRESETS,
  planFill,
  presetObjective,
  scorePlan,
  searchPlans,
} from '../src/objective.ts'
import { METRIC_BETTER, metricOf, paretoFront } from '../src/pareto.ts'
import {
  PRESET_IDS,
  type ObjectiveSpec,
  type PlanFlag,
  type PlanMetric,
  type PlanQuote,
  type PlanSearchContext,
  type PlanSearchResult,
  type SearchedPlan,
} from '../src/objective-types.ts'

const FUTURE = 786
const TODAY = '2026-08-19'
const EXPIRY = '2026-09-24'
const T = 36 / 365
const VOL = 0.3
const LOT = 1000
const FUT_MARK = 786.4

const STRIKES = Array.from({ length: 31 }, (_, i) => 640 + i * 10)
function row(strike: number, type: OptionType): StrikeInfo {
  const price = b76Price({ future: FUTURE, strike, t: T, vol: VOL, rate: DEFAULT_RATE, type })
  const iv = b76ImpliedVol(price, { future: FUTURE, strike, t: T, rate: DEFAULT_RATE, type })
  const delta = iv === null ? null : b76Greeks({ future: FUTURE, strike, t: T, vol: iv, rate: DEFAULT_RATE, type }).delta
  return { strike, type, price, ageMs: 0, iv, delta }
}
const CHAIN = STRIKES.flatMap((k) => [row(k, 'CE'), row(k, 'PE')])
const BY = new Map(CHAIN.map((s) => [`${s.strike}${s.type}`, s]))
const mark = (k: number, t: OptionType): number | null => BY.get(`${k}${t}`)?.price ?? null
/** A 6%-wide market around every mark: inside R8's 10%, so every strike is tradeable. */
const tight = (k: number, t: OptionType): PlanQuote | null => {
  const p = mark(k, t)
  return p === null ? null : { bid: p * 0.97, ask: p * 1.03, stale: false }
}

const leg = (id: string, qty: number, strike: number | null, type: OptionType | null, entry: number): PayoffLeg => ({
  id,
  instrument: type === null ? 'future' : 'option',
  qty,
  strike,
  type,
  expiry: EXPIRY,
  entry,
  iv: type === null ? null : VOL,
})
const STRANGLE = [leg('ce780', -2000, 780, 'CE', 20), leg('pe720', -2000, 720, 'PE', 9)]

function ctxOf(over: Partial<PlanSearchContext> = {}): PlanSearchContext {
  return {
    legs: STRANGLE,
    future: FUTURE,
    today: TODAY,
    expiry: EXPIRY,
    realised: 0,
    dials: { ...DEFAULT_REPAIR_DIALS, lotSize: LOT },
    priceOf: mark,
    ivOf: (k, t) => BY.get(`${k}${t}`)?.iv ?? null,
    strikes: CHAIN,
    triggers: null,
    futureMark: FUT_MARK,
    lotSize: LOT,
    quoteOf: tight,
    ...over,
  }
}
const CTX = ctxOf()

const proposals = (r: PlanSearchResult): readonly SearchedPlan[] => r.plans.filter((p) => p.rank > 0)
const base = (r: PlanSearchResult): SearchedPlan => {
  const b = r.plans.find((p) => p.key === 'baseline')
  assert.ok(b !== undefined, 'no baseline row')
  return b
}
const at = (p: { metrics: SearchedPlan['metrics'] }, m: PlanMetric): number => metricOf(p.metrics, m) as number

/** A spec as a caller's plain object, before normalisation: every field writable. */
interface Draft {
  primary: { metric: PlanMetric; dir: 'min' | 'max' }
  rules: { ops: string[]; [k: string]: unknown }
  pareto?: unknown
}

/** One spec, edited, then normalised as the route would. */
function specOf(edit: (s: Draft) => unknown): ObjectiveSpec {
  const raw = JSON.parse(JSON.stringify(presetObjective(['neutralize-delta'], null, false))) as Draft
  edit(raw)
  const n = normaliseObjective(raw, raw.rules.ops.includes('close'))
  assert.ok('spec' in n, JSON.stringify(n))
  return n.spec
}

// ------------------------------------------------------------ normalisation

test('normalise: defaults filled, ranges clamped, one canonical shape', () => {
  const n = normaliseObjective(
    {
      primary: { metric: 'absDelta' },
      rules: { maxMoves: 9, maxLotsPerMove: 0, maxMarginAddPct: 500, floorGuard: { maxLossWorsenPct: 40, shockWorsenPct: -3 }, maxDebit: -10 },
      keep: [{ metric: 'theta', tolerancePct: 250 }],
      view: { vol: { kind: 'shift', points: 80 }, driftAnnual: 3 },
    },
    false,
  )
  assert.ok('spec' in n, JSON.stringify(n))
  assert.deepEqual(n.spec, {
    primary: { metric: 'absDelta', dir: 'min' },
    hard: [],
    keep: [{ metric: 'theta', tolerancePct: 100 }],
    rules: {
      ops: ['add', 'hedge', 'shift', 'future'],
      maxMoves: 4,
      maxLotsPerMove: 1,
      maxMarginAddPct: 100,
      floorGuard: { maxLossWorsenPct: 25, shockWorsenPct: 0 },
      untouchable: [],
      maxDebit: 0,
    },
    view: { vol: { kind: 'shift', points: 50 }, driftAnnual: 1 },
  })
  // Two spellings of one objective serialise identically.
  const a = normaliseObjective({ primary: { metric: 'margin', dir: 'min' }, rules: { ops: ['future', 'add'] } }, false)
  const b = normaliseObjective({ hard: [], rules: { ops: ['add', 'future', 'add'] }, primary: { dir: 'min', metric: 'margin' } }, false)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('normalise: closing only when the REQUEST allowed it', () => {
  const ask = { primary: { metric: 'maxLoss', dir: 'max' }, rules: { ops: ['add', 'close'] } }
  const strip = normaliseObjective(ask, false)
  assert.ok('spec' in strip)
  assert.deepEqual(strip.spec.rules.ops, ['add'])
  const keep = normaliseObjective(ask, true)
  assert.ok('spec' in keep)
  assert.deepEqual(keep.spec.rules.ops, ['add', 'close'])
  // Omitted ops: the default four, plus close when the trader ticked the box.
  const dflt = normaliseObjective({ primary: { metric: 'maxLoss' } }, true)
  assert.ok('spec' in dflt)
  assert.deepEqual(dflt.spec.rules.ops, ['add', 'hedge', 'shift', 'future', 'close'])
  // A close and nothing else, not allowed: nothing left to search with — said, not silently widened.
  const only = normaliseObjective({ primary: { metric: 'maxLoss' }, rules: { ops: ['close'] } }, false)
  assert.ok('error' in only && /close/.test(only.error))
  // The presets obey the same rule.
  assert.equal(presetObjective(['cut-margin'], null, false).rules.ops.includes('close'), false)
  assert.equal(presetObjective(['cut-margin'], null, true).rules.ops.includes('close'), true)
})

test('searchPlans honours a close in the spec only with the request\'s own allowClose', () => {
  // A spec is something a model can write: 'close' in it is not permission.
  const written = { ...presetObjective(['cap-max-loss'], null, false), rules: { ...presetObjective(['cap-max-loss'], null, false).rules, ops: ['close'] as const } }
  const r = searchPlans(CTX, written as ObjectiveSpec, { topN: 3 })
  assert.match(r.refused ?? '', /close/)
  assert.deepEqual(r.plans, [])
  const mixed = { ...written, rules: { ...written.rules, ops: ['shift', 'close'] as const } }
  const m = searchPlans(CTX, mixed as ObjectiveSpec, { topN: 5, beamWidth: 4 })
  assert.deepEqual(m.spec.rules.ops, ['shift'])
  assert.equal(m.plans.some((p) => p.moves.some((mv) => mv.op === 'close')), false)
  // With the trader's tick, the same spec may close.
  const allowed = searchPlans(CTX, mixed as ObjectiveSpec, { topN: 5, beamWidth: 4, allowClose: true })
  assert.deepEqual(allowed.spec.rules.ops, ['shift', 'close'])
  assert.ok(allowed.plans.some((p) => p.moves.some((mv) => mv.op === 'close')), 'closing the call should cap the loss')
})

test('normalise: refusals name what is wrong', () => {
  const err = (raw: unknown): string => {
    const n = normaliseObjective(raw, false)
    assert.ok('error' in n, JSON.stringify(n))
    return n.error
  }
  assert.match(err(null), /object/)
  assert.match(err({}), /primary\.metric/)
  assert.match(err({ primary: { metric: 'happiness' } }), /primary\.metric/)
  assert.match(err({ primary: { metric: 'pop', dir: 'up' } }), /primary\.dir/)
  assert.match(err({ primary: { metric: 'ev' } }), /^ev needs a view$/)
  assert.match(err({ primary: { metric: 'pop' }, keep: [{ metric: 'cvar' }] }), /^cvar needs a view$/)
  assert.match(err({ primary: { metric: 'pop' }, pareto: ['ev', 'margin'] }), /^ev needs a view$/)
  assert.match(err({ primary: { metric: 'pop' }, hard: [{ metric: 'margin', op: '<', value: 1 }] }), /hard\[0\]\.op/)
  assert.match(err({ primary: { metric: 'pop' }, hard: [{ metric: 'margin', op: '<=', value: 'lots' }] }), /hard\[0\]\.value/)
  assert.match(err({ primary: { metric: 'pop' }, hard: [{ metric: 'margin', op: '<=', value: 1, unit: 'lakh' }] }), /hard\[0\]\.unit/)
  assert.match(err({ primary: { metric: 'pop' }, rules: { ops: ['add', 'sell'] } }), /'sell'/)
  assert.match(err({ primary: { metric: 'pop' }, rules: { maxMoves: 'three' } }), /maxMoves/)
  assert.match(err({ primary: { metric: 'pop' }, rules: { untouchable: [1] } }), /untouchable/)
  assert.match(err({ primary: { metric: 'pop' }, view: { vol: { kind: 'hv' } } }), /kind/)
  assert.match(err({ primary: { metric: 'pop' }, view: { vol: { kind: 'flat', annual: -0.2 } } }), /annual/)
  assert.match(err({ primary: { metric: 'pop' }, view: { vol: { kind: 'implied' }, horizon: '27 Oct' } }), /horizon/)
  assert.match(err({ primary: { metric: 'pop' }, pareto: ['pop', 'pop'] }), /pareto/)
  assert.match(err({ primary: { metric: 'pop' }, hard: Array.from({ length: 9 }, () => ({ metric: 'pop', op: '>=', value: 1 })) }), /at most 8/)
  // With a view, EV is fine.
  assert.ok('spec' in normaliseObjective({ primary: { metric: 'ev' }, view: { vol: { kind: 'implied' } } }, false))
})

test('searchPlans refuses what cannot be searched, and still shows the baseline', () => {
  const r = searchPlans(CTX, presetObjective(['max-ev'], null, false))
  assert.equal(r.refused, 'ev needs a view')
  assert.deepEqual(r.plans, [])
  assert.ok(r.baseline.maxLoss < 0, 'the do-nothing figures are still there to show')
  const broken = searchPlans(ctxOf({ future: Number.NaN }), presetObjective(['cut-margin'], null, false))
  assert.match(broken.refused ?? '', /cannot be priced/)
  assert.deepEqual(broken.plans, [])
  // A caller-built literal is clamped like the model's: maxMoves 9 runs as 4.
  const wild = searchPlans(CTX, { ...presetObjective(['cut-margin'], null, false), rules: { ...presetObjective(['cut-margin'], null, false).rules, maxMoves: 9 } }, { topN: 1 })
  assert.equal(wild.spec.rules.maxMoves, 4)
})

// ------------------------------------------------------------- the presets

test('presets: ids[0] ranks, the rest are keep guards at tolerance 0, a metric kept once', () => {
  const s = presetObjective(['neutralize-delta', 'cut-margin', 'keep-theta', 'cut-margin', 'nonsense' as never], null, false)
  assert.deepEqual(s.primary, { metric: 'absDelta', dir: 'min' })
  assert.deepEqual(s.keep, [
    { metric: 'margin', tolerancePct: 0 },
    { metric: 'theta', tolerancePct: 0 },
  ])
  assert.deepEqual(presetObjective(['collect-credit-safe'], null, false).keep, [{ metric: 'maxLoss', tolerancePct: 0 }])
  assert.deepEqual(presetObjective([], null, false).primary, { metric: 'absDelta', dir: 'min' })
  // Every chip has a label and a metric, and its direction is the metric's "better".
  for (const id of PRESET_IDS) {
    const p = OBJECTIVE_PRESETS[id]
    assert.ok(p.label.length > 0)
    assert.equal(p.dir, METRIC_BETTER[p.metric], id)
  }
  // The two signs worth spelling out.
  assert.deepEqual(OBJECTIVE_PRESETS['cut-gamma'], { label: 'Cut short gamma', metric: 'gamma', dir: 'max' })
  assert.deepEqual(OBJECTIVE_PRESETS['cut-vega'], { label: 'Cut vega', metric: 'absVega', dir: 'min' })
})

test('every preset moves its own metric the right way on a real book', () => {
  const view = { vol: { kind: 'flat' as const, annual: 0.22 } }
  for (const id of PRESET_IDS) {
    const { metric, dir } = OBJECTIVE_PRESETS[id]
    const r = searchPlans(CTX, presetObjective([id], id === 'max-ev' ? view : null, false), { beamWidth: 6 })
    assert.equal(r.refused, null, id)
    const props = proposals(r)
    assert.ok(props.length > 0, `${id}: nothing proposed`)
    const b = at(base(r), metric)
    const top = at(props[0] as SearchedPlan, metric)
    assert.ok(dir === 'max' ? top > b : top < b, `${id}: top ${metric} ${top} is not ${dir === 'max' ? 'above' : 'below'} now (${b})`)
    for (let i = 1; i < props.length; i++) {
      const prev = at(props[i - 1] as SearchedPlan, metric)
      const cur = at(props[i] as SearchedPlan, metric)
      assert.ok(dir === 'max' ? prev >= cur : prev <= cur, `${id}: not ranked by ${metric}`)
    }
  }
})

test('cut-gamma makes a short-gamma book LESS short; cut-vega takes |vega| toward flat', () => {
  const g = searchPlans(CTX, presetObjective(['cut-gamma'], null, false), { beamWidth: 6 })
  assert.ok(g.baseline.gamma < 0, 'the strangle is short gamma')
  for (const p of proposals(g)) assert.ok(p.metrics.gamma > g.baseline.gamma, `gamma ${p.metrics.gamma} vs ${g.baseline.gamma}`)
  const v = searchPlans(CTX, presetObjective(['cut-vega'], null, false), { beamWidth: 6 })
  assert.ok(v.baseline.vega < 0)
  for (const p of proposals(v)) assert.ok(p.metrics.absVega < v.baseline.absVega)
})

test('a stacked goal is a guard: neutralize delta without adding margin', () => {
  const r = searchPlans(CTX, presetObjective(['neutralize-delta', 'cut-margin'], null, false), { beamWidth: 6 })
  assert.ok(proposals(r).length > 0)
  for (const p of proposals(r)) {
    assert.ok(p.metrics.margin <= r.baseline.margin + 1e-6, `margin ${p.metrics.margin} > now ${r.baseline.margin}`)
    assert.ok(p.metrics.absDelta < r.baseline.absDelta)
    assert.equal(p.flags.includes('margin-up'), false)
  }
  // Unguarded, the best |delta| plans DO add margin — the guard is doing work.
  const free = searchPlans(CTX, presetObjective(['neutralize-delta'], null, false), { beamWidth: 6 })
  assert.ok(proposals(free).some((p) => p.metrics.margin > free.baseline.margin))
})

test('the pop metric is the RUN\'s POP in percent; PlanScore.pop stays the open legs\' 0–1', () => {
  const r = searchPlans(CTX, presetObjective(['raise-pop'], null, false), { beamWidth: 6 })
  const top = proposals(r)[0]
  assert.ok(top !== undefined)
  assert.ok(top.metrics.pop >= 0 && top.metrics.pop <= 1, 'the inherited PlanScore.pop stays 0–1')
  assert.ok(top.metrics.popRun >= 0 && top.metrics.popRun <= 100)
  assert.equal(at(top, 'pop'), top.metrics.popRun)
  assert.ok(Math.abs((top.change.pop as number) - (top.metrics.popRun - r.baseline.popRun)) < 1e-9, 'change.pop is run POP points')
  // Every plan and the baseline carry it, ranked on it.
  for (const p of r.plans) assert.equal(typeof p.metrics.popRun, 'number')
  const props = proposals(r)
  for (let i = 1; i < props.length; i++) assert.ok((props[i - 1] as SearchedPlan).metrics.popRun >= (props[i] as SearchedPlan).metrics.popRun)
})

test('raise-pop: a loss-banking shift does NOT win over a plan with a higher run POP', () => {
  // Rolling the threatened 780 call to 850 banks its loss: the open legs then finish green 100% of
  // the time, the run nowhere near that. Ranked on the open legs it would top the menu.
  const shifted = scorePlan(CTX, [{ op: 'shift', legId: 'ce780', toStrike: 850 }], null)
  assert.ok(shifted !== null)
  assert.equal(shifted.pop, 1)
  assert.ok(shifted.popRun < 80, `run POP ${shifted.popRun}`)
  const r = searchPlans(CTX, presetObjective(['raise-pop'], null, false), { beamWidth: 6, topN: 5 })
  const props = proposals(r)
  const top = props[0]
  assert.ok(top !== undefined)
  assert.notEqual(top.key, 'shift|ce780|850')
  assert.ok(top.metrics.popRun > shifted.popRun, `top run POP ${top.metrics.popRun} vs the shift's ${shifted.popRun}`)
  // Wherever the shift lands on the menu, every plan above it has a run POP at least as high.
  const at850 = props.findIndex((p) => p.key === 'shift|ce780|850')
  for (const p of props.slice(0, at850 < 0 ? props.length : at850)) assert.ok(p.metrics.popRun >= shifted.popRun)
})

test('a hard constraint POP ≥ X is X% of RUN POP: it rejects a plan just under it, keeps it just over', () => {
  const theta = specOf((x) => {
    x.primary = { metric: 'theta', dir: 'max' }
  })
  const plan = proposals(searchPlans(CTX, theta, { beamWidth: 6, topN: 3 }))[0]
  assert.ok(plan !== undefined)
  const run = plan.metrics.popRun
  assert.ok(run > 1 && run < 99, `run POP ${run}`)
  const withFloor = (value: number) =>
    specOf((x) => {
      x.primary = { metric: 'theta', dir: 'max' }
      ;(x as unknown as { hard: unknown[] }).hard = [{ metric: 'pop', op: '>=', value, unit: 'abs' }]
    })
  const over = Math.ceil(run) + 1
  const above = searchPlans(CTX, withFloor(over), { beamWidth: 6, topN: 20 })
  assert.equal(above.plans.some((p) => p.key === plan.key), false, `a ${run}% plan passed a ${over}% floor`)
  for (const p of proposals(above)) assert.ok(p.metrics.popRun >= over - 1e-9, `${p.key}: ${p.metrics.popRun}`)
  assert.ok(above.rejected.some((x) => x.reason === `fails POP ≥ ${over}` && x.count > 0), JSON.stringify(above.rejected))
  const under = Math.floor(run) - 1
  assert.ok(searchPlans(CTX, withFloor(under), { beamWidth: 6, topN: 20 }).plans.some((p) => p.key === plan.key), `a ${run}% plan failed a ${under}% floor`)
})

// ------------------------------------------------------- safer by default

test('the floor guard: no plan worsens the floor or the shock unless the spec relaxes it, and then by ≤ the relaxation', () => {
  for (const id of ['neutralize-delta', 'keep-theta', 'collect-credit-safe'] as const) {
    const r = searchPlans(CTX, presetObjective([id], null, false), { beamWidth: 6, topN: 8 })
    for (const p of proposals(r)) {
      assert.ok(p.metrics.maxLoss >= r.baseline.maxLoss - 1e-6, `${id}: floor ${p.metrics.maxLoss} < ${r.baseline.maxLoss}`)
      assert.ok(p.metrics.worstShock >= r.baseline.worstShock - 1e-6, `${id}: shock ${p.metrics.worstShock}`)
      assert.equal(p.flags.includes('degrades-floor'), false)
    }
    assert.ok(r.rejected.some((x) => /floor/.test(x.reason)), `${id}: the guard turned nothing away`)
  }
  // Relaxed by 25%: theta can now be bought with floor, but never more than 25% of it.
  const loose = specOf((s) => {
    s.primary = { metric: 'theta', dir: 'max' }
    s.rules.floorGuard = { maxLossWorsenPct: 25, shockWorsenPct: 25 }
  })
  const r = searchPlans(CTX, loose, { beamWidth: 6, topN: 8 })
  const degraded = proposals(r).filter((p) => p.flags.includes('degrades-floor'))
  assert.ok(degraded.length > 0, 'a 25% relaxation should let some plan trade floor for theta')
  for (const p of proposals(r)) {
    assert.ok(p.metrics.maxLoss >= r.baseline.maxLoss * 1.25 - 1e-6)
    assert.ok(p.metrics.worstShock >= r.baseline.worstShock * 1.25 - 1e-6)
  }
  // A binding floor names the relaxation the trader asked for.
  for (const p of proposals(r)) for (const b of p.binding) if (/floor guard/.test(b)) assert.match(b, /floor guard, 25% relaxed\)$/)
})

// ------------------------------------------------------- money already booked

/**
 * The plans a search answered, their run-level figures taken back to the open legs. (Not the rejection counts: an
 * infeasible state's distance is relative to its limit's size, so the beam wanders differently through what it drops.)
 */
const openPart = (r: PlanSearchResult, realised: number) =>
  r.plans.map((p) => [p.key, p.rank, Math.round(p.metrics.maxLoss - realised), Math.round(p.metrics.worstShock - realised)])

test('booked P&L: "max loss ≥ 50% of now" with +₹4,37,580 booked still halves the open tail, and the same plans pass', () => {
  const R = 437_580
  const half = specOf((x) => {
    x.primary = { metric: 'theta', dir: 'max' }
    ;(x as unknown as { hard: unknown[] }).hard = [{ metric: 'maxLoss', op: '>=', value: 50, unit: 'pctOfNow' }]
  })
  const plain = searchPlans(CTX, half, { beamWidth: 6, topN: 8 })
  const booked = searchPlans(ctxOf({ realised: R }), half, { beamWidth: 6, topN: 8 })
  assert.ok(booked.baseline.maxLoss > 0 && booked.baseline.maxLoss - R < 0, `the run floor ${booked.baseline.maxLoss} is booked money over an open loss`)
  assert.ok(proposals(booked).length > 0, JSON.stringify(booked.rejected))
  for (const p of proposals(booked)) {
    assert.ok(p.metrics.maxLoss - R >= 0.5 * (booked.baseline.maxLoss - R) - 1e-6, `${p.key}: open floor ${p.metrics.maxLoss - R}`)
  }
  // 50% of the RUN floor would have let the open tail grow ~4x; the open part decides, as with nothing booked
  assert.deepEqual(openPart(booked, R), openPart(plain, 0))
})

test('booked P&L: with -₹51,344 booked a 10% floor relaxation is 10% of the open floor, not of the run\'s', () => {
  const R = -51_344
  // buying gamma costs floor, so the best plans sit on the relaxed floor: the limit shows in what they give up
  const loose = specOf((x) => {
    x.primary = { metric: 'gamma', dir: 'max' }
    x.rules.maxLotsPerMove = 5
    x.rules.maxMarginAddPct = 100
    x.rules.floorGuard = { maxLossWorsenPct: 10, shockWorsenPct: 10 }
  })
  const plain = searchPlans(CTX, loose, { beamWidth: 6, topN: 8 })
  const booked = searchPlans(ctxOf({ realised: R }), loose, { beamWidth: 6, topN: 8 })
  const open = booked.baseline.maxLoss - R
  const givenUp = proposals(booked).map((p) => booked.baseline.maxLoss - p.metrics.maxLoss)
  assert.ok(givenUp.length > 0)
  // 10% of the open floor (₹11,120 here), never 10% of the run's (₹16,254), which the booked loss would inflate
  for (const g of givenUp) assert.ok(g <= 0.1 * Math.abs(open) + 1e-6, `gave up ${g} of the floor`)
  assert.ok(Math.max(...givenUp) > 0.09 * Math.abs(open), `the relaxation binds: ${Math.max(...givenUp)}`)
  assert.deepEqual(openPart(booked, R), openPart(plain, 0))
})

test('the margin cap: +10% by default, and a binding plan says so', () => {
  const r = searchPlans(CTX, presetObjective(['neutralize-delta'], null, false), { beamWidth: 6, topN: 6 })
  const cap = r.baseline.margin * 1.1
  for (const p of proposals(r)) assert.ok(p.metrics.margin <= cap + 1e-6)
  assert.ok(r.rejected.some((x) => x.reason === 'adds more than 10% margin' && x.count > 0))
  for (const p of proposals(r)) {
    const near = Math.abs(p.metrics.margin - cap) <= 0.02 * cap
    assert.equal(p.binding.some((b) => b.startsWith('margin ≤ ') && b.endsWith('(margin cap +10%)')), near, JSON.stringify(p.binding))
  }
  assert.ok(proposals(r).some((p) => p.flags.includes('margin-up')))
})

test('the real SPAN re-scores the final pool and its refusals are counted', () => {
  // A "real" SPAN that charges 30% over SPAN-lite for any book holding a hedge, and cannot price a book with 3+ new legs.
  const marginOf = (legs: readonly PayoffLeg[]): number | null => {
    if (legs.length >= 5) return null
    const lite = spanLiteMargin(legs, FUTURE, TODAY).total
    return legs.some((l) => l.id.startsWith('hedge:')) ? lite * 1.3 : lite
  }
  const r = searchPlans(ctxOf({ marginOf }), presetObjective(['cut-vega'], null, false), { beamWidth: 6, topN: 6 })
  assert.equal(r.baseline.marginSource, 'span')
  for (const p of r.plans) assert.equal(p.metrics.marginSource, 'span')
  for (const p of proposals(r)) {
    assert.ok(p.metrics.margin <= r.baseline.margin * 1.1 + 1e-6, 'the cap is judged on the real figure')
    assert.ok(p.moves.length < 3 || p.moves.every((m) => m.op === 'shift'), 'a plan the real SPAN could not price was kept')
  }
  assert.ok(r.rejected.some((x) => x.reason === 'NSE SPAN could not price the plan' && x.count > 0), JSON.stringify(r.rejected))
  // Without it, everything is SPAN-lite.
  const lite = searchPlans(CTX, presetObjective(['cut-vega'], null, false), { beamWidth: 6, topN: 1 })
  assert.equal(lite.baseline.marginSource, 'span-lite')
  assert.equal(lite.baseline.margin, lite.baseline.marginAfter)
})

test('maxDebit and untouchable legs bind', () => {
  const capped = specOf((s) => {
    s.primary = { metric: 'maxLoss', dir: 'max' }
    s.rules.maxDebit = 10_000
  })
  const r = searchPlans(CTX, capped, { beamWidth: 6, topN: 6 })
  assert.ok(proposals(r).length > 0)
  for (const p of proposals(r)) assert.ok(p.metrics.credit >= -10_000 - 1e-6, `credit ${p.metrics.credit}`)
  const guarded = specOf((s) => {
    s.primary = { metric: 'maxLoss', dir: 'max' }
    s.rules.untouchable = ['ce780']
  })
  const g = searchPlans(CTX, guarded, { beamWidth: 6, topN: 6 })
  for (const p of proposals(g)) assert.equal(p.moves.some((m) => (m.op === 'shift' || m.op === 'close') && m.legId === 'ce780'), false)
})

// ---------------------------------------------- futures, sizes, liquidity

test('future moves: the exact delta, no premium, never indicative', () => {
  // A future hedge carries exposure margin both ways: on this book one lot adds ~16% SPAN-lite, so the
  // default +10% cap refuses it (the cap test below) — a trader who wants the futures route lifts the cap.
  const s = specOf((x) => {
    x.rules.ops = ['future']
    x.rules.maxMarginAddPct = 25
  })
  const capped = searchPlans(CTX, specOf((x) => {
    x.rules.ops = ['future']
  }))
  assert.deepEqual(capped.plans.map((p) => p.key), ['baseline'])
  assert.ok(capped.rejected.some((x) => x.reason === 'adds more than 10% margin'))
  const r = searchPlans(CTX, s, { topN: 4 })
  const top = proposals(r)[0]
  assert.ok(top !== undefined)
  // Δ ≈ −770: one lot bought leaves ≈ +230, the closest a 1000-share lot gets.
  assert.deepEqual(top.moves, [{ op: 'future', qty: 1000 }])
  assert.ok(Math.abs(top.metrics.delta - (r.baseline.delta + 1000)) < 1e-6)
  assert.equal(top.metrics.credit, 0)
  assert.equal(top.flags.includes('indicative-price'), false)
  assert.ok(Math.abs((top.change.absDelta ?? 0) - (top.metrics.absDelta - r.baseline.absDelta)) < 1e-9)
  // No future mark: no future moves, and the trader is told nothing helps.
  const none = searchPlans(ctxOf({ futureMark: null }), s)
  assert.deepEqual(none.plans.map((p) => p.key), ['baseline'])
  assert.deepEqual(none.plans[0]?.flags, ['baseline', 'no-feasible-plan'])
})

test('the size ladder: two lots of the future when the book is two lots short', () => {
  const short = [...STRANGLE, leg('fut', -1000, null, null, 790)]
  const s = specOf((x) => {
    x.rules.ops = ['future']
    x.rules.maxMarginAddPct = 25
  })
  const two = searchPlans(ctxOf({ legs: short }), s)
  assert.deepEqual(proposals(two)[0]?.moves, [{ op: 'future', qty: 2000 }])
  const oneLot = specOf((x) => {
    x.rules.ops = ['future']
    x.rules.maxLotsPerMove = 1
    x.rules.maxMarginAddPct = 25
  })
  assert.deepEqual(proposals(searchPlans(ctxOf({ legs: short }), oneLot))[0]?.moves, [{ op: 'future', qty: 1000 }])
})

test('fills cross the spread: a sell takes the bid, the same plan unquoted is indicative at the mark', () => {
  const s = specOf((x) => {
    x.primary = { metric: 'credit', dir: 'max' }
    x.rules.ops = ['add']
    x.rules.maxMoves = 1
  })
  const quoted = searchPlans(CTX, s, { topN: 1 })
  const top = proposals(quoted)[0]
  assert.ok(top !== undefined && top.moves[0]?.op === 'add')
  const m = top.moves[0]
  const bid = (tight(m.strike, m.type) as PlanQuote).bid as number
  assert.ok(Math.abs(top.metrics.credit - -m.qty * bid) < 1e-6, `credit ${top.metrics.credit}, want ${-m.qty * bid}`)
  assert.equal(top.flags.includes('indicative-price'), false)
  // The fill a card would quote is the one the plan was scored on.
  assert.equal(planFill(CTX)(m.strike, m.type, m.qty), bid)
  assert.equal(planFill(CTX)(m.strike, m.type, -m.qty), (tight(m.strike, m.type) as PlanQuote).ask)

  const { quoteOf: _q, ...rest } = CTX
  const unquoted = searchPlans(rest as PlanSearchContext, s, { topN: 1 })
  const u = proposals(unquoted)[0]
  assert.ok(u !== undefined && u.moves[0]?.op === 'add')
  const um = u.moves[0]
  assert.ok(Math.abs(u.metrics.credit - -um.qty * (mark(um.strike, um.type) as number)) < 1e-6)
  assert.ok(u.flags.includes('indicative-price'))
})

test('illiquid strikes never open, are counted, and every row says the menu is narrower', () => {
  const s = specOf((x) => {
    x.primary = { metric: 'credit', dir: 'max' }
    x.rules.ops = ['add']
    x.rules.maxMoves = 1
  })
  const best = proposals(searchPlans(CTX, s, { topN: 1 }))[0]?.moves[0]
  assert.ok(best !== undefined && best.op === 'add')
  // That contract now has no bid; the next is quoted ₹3 wide on a ~₹10 mid.
  const thin = (k: number, t: OptionType): PlanQuote | null =>
    k === best.strike && t === best.type ? { bid: null, ask: 9, stale: false } : tight(k, t)
  const r = searchPlans(ctxOf({ quoteOf: thin }), s, { topN: 5 })
  assert.equal(proposals(r).some((p) => p.moves.some((m) => m.op === 'add' && m.strike === best.strike && m.type === best.type)), false)
  assert.deepEqual(r.rejected[0], { reason: 'contracts left out: no live two-sided quote within max(10% of mid, ₹1) (R8)', count: 1 })
  for (const p of r.plans) assert.ok(p.flags.includes('illiquid-excluded'), p.key)
})

// ------------------------------------------------- the view, and the menu

test('max-ev under a calmer realised vol: EV ranks, the view is said, CVaR rides along', () => {
  const view = { vol: { kind: 'flat' as const, annual: 0.22 } }
  const r = searchPlans(CTX, presetObjective(['max-ev'], view, false), { beamWidth: 6 })
  assert.equal(r.refused, null)
  assert.ok(r.baseline.ev !== null && r.baseline.cvar5 !== null && r.baseline.popView !== null)
  for (const p of r.plans) {
    assert.ok(p.flags.includes('view-based'), p.key)
    assert.ok(p.metrics.ev !== null && p.metrics.cvar5 !== null && p.metrics.cvar5 <= p.metrics.ev)
  }
  // No view-based figure without a view.
  const plain = searchPlans(CTX, presetObjective(['cut-margin'], null, false), { topN: 1 })
  assert.equal(plain.baseline.ev, null)
  assert.equal(plain.plans.some((p) => p.flags.includes('view-based')), false)
})

test('the menu: ranked plans then the baseline, flags in their order, change is after − now', () => {
  const ORDER: readonly PlanFlag[] = ['baseline', 'no-feasible-plan', 'degrades-floor', 'margin-up', 'indicative-price', 'illiquid-excluded', 'view-based']
  const r = searchPlans(CTX, presetObjective(['neutralize-delta'], null, false), { beamWidth: 6, topN: 3 })
  assert.deepEqual(r.plans.map((p) => p.rank), [1, 2, 3, 0])
  const b = base(r)
  assert.deepEqual(b.moves, [])
  assert.equal(b.metrics, r.baseline)
  for (const p of r.plans) {
    const idx = p.flags.map((f) => ORDER.indexOf(f))
    assert.deepEqual([...idx].sort((x, y) => x - y), idx, `flags out of order: ${p.flags.join(',')}`)
    assert.ok(idx.every((i) => i >= 0))
    for (const [metric, d] of Object.entries(p.change)) {
      const want = (metricOf(p.metrics, metric as PlanMetric) as number) - (metricOf(r.baseline, metric as PlanMetric) as number)
      assert.ok(Math.abs((d as number) - want) < 1e-9, `${p.key} ${metric}`)
    }
  }
  assert.ok(Object.values(b.change).every((d) => d === 0))
  // Three plans are three ideas: no two land the same book.
  const keys = new Set(proposals(r).map((p) => p.key))
  assert.equal(keys.size, 3)
})

test('scorePlan scores a plan exactly as the search did', () => {
  const r = searchPlans(CTX, presetObjective(['cut-margin'], null, false), { beamWidth: 6, topN: 3 })
  for (const p of proposals(r)) assert.deepEqual(scorePlan(CTX, p.moves, null), p.metrics)
  assert.deepEqual(scorePlan(CTX, [], null), r.baseline)
  assert.equal(scorePlan(ctxOf({ futureMark: null }), [{ op: 'future', qty: 1000 }], null), null)
  assert.equal(scorePlan(CTX, [{ op: 'close', legId: 'nope' }], null), null)
  assert.equal(scorePlan(CTX, null as never, null), null)
})

test('delta0Gap is |Δ/Γ|: zero on a flat book, infinite with delta and no gamma', () => {
  const futOnly = ctxOf({ legs: [leg('fut', 1000, null, null, 780)] })
  const m = scorePlan(futOnly, [], null)
  assert.ok(m !== null)
  assert.equal(m.delta0Gap, Infinity)
  const flat = scorePlan(futOnly, [{ op: 'future', qty: -1000 }], null)
  assert.ok(flat !== null)
  assert.equal(flat.delta0Gap, 0)
  const s = scorePlan(CTX, [], null)
  assert.ok(s !== null && Math.abs(s.delta0Gap - Math.abs(s.delta / s.gamma)) < 1e-9)
})

// ------------------------------------------------------------------- Pareto

/** A plan with a given margin and run POP (percent, as the 'pop' metric reads it). */
function fake(key: string, margin: number, popRun: number): SearchedPlan {
  const metrics = { ...(scorePlan(CTX, [], null) as SearchedPlan['metrics']), margin, popRun }
  return { key, rank: 1, moves: [], metrics, change: {}, flags: [], binding: [] }
}

test('paretoFront keeps the plans nothing beats on both axes, in their given order', () => {
  const plans = [
    fake('a', 100, 60),
    fake('b', 90, 55), // cheaper, less POP: on the front
    fake('c', 110, 59), // dearer and worse than a: dominated
    fake('d', 100, 60), // a tie with a: both stay
    fake('e', 80, 70), // dominates a, b and d
  ]
  assert.deepEqual(paretoFront(plans, 'margin', 'pop', ['min', 'max']), ['e'])
  assert.deepEqual(paretoFront(plans.slice(0, 4), 'margin', 'pop', ['min', 'max']), ['a', 'b', 'd'])
  // A plan with no figure is never on it; an infinite gap is the worst gap, not a NaN.
  const noPop = { ...fake('n', 1, 50), metrics: { ...fake('n', 1, 50).metrics, ev: null } }
  assert.deepEqual(paretoFront([noPop, fake('a', 100, 60)], 'ev', 'margin', ['max', 'min']), [])
  assert.deepEqual(paretoFront([], 'margin', 'pop', ['min', 'max']), [])
})

test('a spec with a Pareto pair returns its front among the menu', () => {
  // Credit against floor: the classic trade — premium in, or tail bought.
  const s = specOf((x) => {
    x.primary = { metric: 'absDelta', dir: 'min' }
    x.pareto = ['credit', 'maxLoss']
  })
  const r = searchPlans(CTX, s, { beamWidth: 6, topN: 3 })
  assert.ok(r.pareto.length > 1)
  const byKey = new Map(r.plans.map((p) => [p.key, p]))
  for (const k of r.pareto) assert.ok(byKey.has(k), k)
  assert.ok(r.plans.length > 4, 'front plans beyond the top three join the menu')
  // Ranks run on past the top three, the baseline still last.
  assert.deepEqual(r.plans.map((p) => p.rank), [...Array.from({ length: r.plans.length - 1 }, (_, i) => i + 1), 0])
  const beats = (q: SearchedPlan, p: SearchedPlan): boolean => {
    const ge = (m: PlanMetric) => (METRIC_BETTER[m] === 'max' ? at(q, m) >= at(p, m) : at(q, m) <= at(p, m))
    const gt = (m: PlanMetric) => (METRIC_BETTER[m] === 'max' ? at(q, m) > at(p, m) : at(q, m) < at(p, m))
    return ge('credit') && ge('maxLoss') && (gt('credit') || gt('maxLoss'))
  }
  for (const p of r.plans) {
    const onFront = r.pareto.includes(p.key)
    const dominated = r.plans.some((q) => q !== p && beats(q, p))
    assert.equal(onFront, !dominated, `${p.key}: on the front ${onFront}, dominated ${dominated}`)
  }
  // Without a pair, the menu is just the top three.
  assert.deepEqual(searchPlans(CTX, specOf(() => undefined), { beamWidth: 6, topN: 3 }).pareto, [])
})

// -------------------------------------------------------------- determinism

test('same inputs, same bytes', () => {
  const view = { vol: { kind: 'shift' as const, points: -4 }, driftAnnual: 0.05 }
  const spec = presetObjective(['max-ev', 'cut-margin'], view, true)
  const a = JSON.stringify(searchPlans(CTX, spec, { allowClose: true }))
  const b = JSON.stringify(searchPlans(ctxOf(), JSON.parse(JSON.stringify(spec)) as ObjectiveSpec, { allowClose: true }))
  assert.equal(a, b)
  assert.ok((JSON.parse(a) as PlanSearchResult).spec.rules.ops.includes('close'))
  const c = JSON.stringify(searchPlans(CTX, presetObjective(['recentre-delta0'], null, false)))
  const d = JSON.stringify(searchPlans(CTX, presetObjective(['recentre-delta0'], null, false)))
  assert.equal(c, d)
})

test('fail-soft: a throwing lookup costs a figure, never the search', () => {
  const boom = (): never => {
    throw new Error('feed down')
  }
  const r = searchPlans(ctxOf({ quoteOf: boom, marginOf: boom, ivOf: boom }), presetObjective(['cut-margin'], null, false), { topN: 1 })
  assert.equal(r.refused, null)
  assert.equal(r.baseline.marginSource, 'span-lite')
  for (const p of proposals(r)) assert.ok(p.flags.includes('indicative-price'))
  const junk = searchPlans(null as never, null as never)
  assert.ok(typeof junk.refused === 'string')
  assert.deepEqual(junk.plans, [])
})
