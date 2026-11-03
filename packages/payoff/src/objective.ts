/**
 * THE OBJECTIVE SEARCH: a trader's goal, in their own terms, run on the
 * repairer's beam.
 *
 * `goals.ts` answers four fixed questions. A trader asks others — "get me delta
 * flat", "cut my margin but don't give up theta", "more POP, and do not touch the
 * 3600 call" — and the assistant turns each into an `ObjectiveSpec`: ONE primary
 * metric to rank on, HARD constraints a plan must satisfy, and KEEP guards that
 * say "and do not make this worse than it is now". This file compiles that spec
 * into the repairer's own `GoalSpec { feasible, distance, objective }` and runs
 * the SAME scorer, beam, comparator and distinctness rules (`goals.ts`, THE
 * SEAM). Everything `goals.ts`' header says about determinism, about ranking
 * feasibility instead of pruning it, and about a menu of three being three ideas
 * holds here unchanged — it is the same code.
 *
 * ─ STILL A GOAL, NOT A SCORE ────────────────────────────────────────────────
 *
 * There is no weighted sum anywhere. Stacked goals become constraints, never
 * weights: `presetObjective(['neutralize-delta', 'cut-margin'])` ranks on |delta|
 * and REQUIRES margin no higher than now. The ranking is lexicographic: the
 * primary metric, then credit (between two plans equally good at the goal, the
 * one that costs less to put on), then `goals.ts`' universal tie-breaks.
 *
 * ─ SAFER BY DEFAULT (spec R6–R8) ────────────────────────────────────────────
 *
 *   NO CLOSING unless the trader's REQUEST said so (`allowClose`, a checkbox on
 *   the page). `normaliseObjective` strips 'close' otherwise; the model writing
 *   the spec cannot put it back.
 *
 *   THE FLOOR GUARD. Every plan must leave the scan floor (`maxLoss`) and the
 *   ±5/±10% shock (`worstShock`) no worse than doing nothing, unless the spec
 *   relaxes each by at most 25% of its own size. A plan that buys delta-flat
 *   with a worse tail is not "safer", whatever its delta says.
 *
 *   MARGIN may grow by at most `maxMarginAddPct` (default 10%) over now.
 *
 *   LIQUIDITY and THE SIDE A TRADE CROSSES: opens and shift landings only on
 *   live two-sided quotes inside the spread limit (`candidates.ts`), and every
 *   option fill at the ask for a buy, the bid for a sell. A fill priced at the
 *   mark because no live quote existed is flagged `indicative-price`.
 *
 * All of these are FEASIBILITY, ranked rather than pruned, exactly as in
 * `goals.ts`: no constraint here is monotone in the move list (a sold option
 * adds credit back; a long wing takes margin back), so none of them may cut a
 * state from the beam — they only push it behind the states that satisfy them.
 *
 * ─ TWO MARGINS ──────────────────────────────────────────────────────────────
 *
 * The beam ranks on SPAN-lite — milliseconds a book, so it can price every
 * state. The real NSE SPAN (`ctx.marginOf`) is too slow for that and too
 * important to skip, so it re-scores the FINAL pool only: the best 200 states
 * that satisfy every non-margin constraint. The margin constraints (the cap, and
 * any hard or keep guard on margin) are then judged on the REAL figure against
 * the REAL baseline, a plan the real SPAN refuses is dropped and counted in
 * `rejected`, and `marginSource` says which figure a plan's `margin` is.
 *
 * ─ ONE DISTRIBUTION ─────────────────────────────────────────────────────────
 *
 * EV, CVaR and the view's POP are drawn from ONE distribution per search — from
 * the do-nothing book, at the chain's ATM vol — and every plan is scored against
 * it. Were each plan to draw its own (say at its legs' mean IV), buying a 45-vol
 * wing would widen the very distribution its own EV is judged on.
 *
 * ─ WHAT COMES BACK ──────────────────────────────────────────────────────────
 *
 * `plans` is the ranked menu followed by the do-nothing baseline (rank 0, key
 * 'baseline'), exactly as `searchRepairs` returns a goal: when nothing is
 * feasible the baseline stands alone flagged `no-feasible-plan`, because "do
 * nothing" is then the answer. `change` is after − baseline per metric (only the
 * finite ones); `binding` names each constraint a plan sits within 2% of; flags
 * are in `PlanFlag`'s order. A spec that cannot be searched is REFUSED, with the
 * reason, and `plans` is empty.
 *
 * `rejected` counts CANDIDATE PLANS THE WALK SCORED — every distinct move set,
 * one-move prefixes of longer plans included, since each is a legal plan — under
 * the first constraint each failed, in a fixed order (floor, shock, margin cap,
 * debit, hard, keep, then the real SPAN's refusals). It says how hard the rules
 * bit, not how many distinct ideas were lost; the R8 line counts CONTRACTS.
 *
 * A `future` move fills at `ctx.futureMark` while the book is valued at
 * `ctx.future`; when the two differ (a traded future against a forward) the new
 * leg starts at `qty · (future − futureMark)` — the cost of the fill, exactly as
 * an option bought at the ask starts below its mark.
 *
 * Pure, deterministic and fail-soft, like the rest of the package.
 */
import type { OptionType } from '@algomaker/greeks'
import type { PayoffLeg } from './legs.ts'
import type { FillOf, Move } from './moves.ts'
import { spanLiteMargin } from './margin.ts'
import { isoDayMs } from './surface.ts'
import { DEFAULT_REPAIR_DIALS, liquidQuote, planMoves, type RepairDials } from './candidates.ts'
import {
  clampInt,
  comparator,
  EPS,
  guard,
  pickDistinct,
  scoreBook,
  walkBeam,
  ZERO_SCORE,
  type BookScore,
  type GoalSpec,
  type ScoreBase,
  type Scored,
  type State,
} from './goals.ts'
import { drawDistribution, statsOf, type Distribution } from './distribution.ts'
import { METRIC_BETTER, metricOf, paretoFront, PLAN_METRICS } from './pareto.ts'
import {
  PRESET_IDS,
  type HardConstraint,
  type KeepGuard,
  type MarketView,
  type ObjectiveRules,
  type ObjectiveSpec,
  type PlanFlag,
  type PlanMetric,
  type PlanMetrics,
  type PlanOp,
  type PlanQuote,
  type PlanSearchContext,
  type PlanSearchResult,
  type PresetId,
  type SearchedPlan,
} from './objective-types.ts'

// ---------------------------------------------------------------- the presets

/**
 * The goal chips, in the operator's words. Each is ONE metric and a direction;
 * the signs are worth spelling out because two of them are not the obvious ones:
 *
 *   neutralize-delta     min |delta|                       shares
 *   recentre-delta0      min |Δ/Γ|: put the zero-delta price back on the future
 *   cut-margin           min margin
 *   raise-pop            max the RUN's POP (`popRun`, percent, realised in) —
 *                        never the open legs' `PlanScore.pop`, which a plan raises
 *                        just by banking a loser's loss out of the open legs.
 *   cut-vega             min |vega| — toward vega-flat, not "more short vol"
 *   cut-gamma            max gamma. A short-premium book is SHORT gamma (negative);
 *                        "cut gamma" means less short, i.e. higher. On a book that
 *                        is already long gamma it asks for more convexity, which is
 *                        protection and never risk — there is no |gamma| metric
 *                        because flattening a long-gamma book is not "safer".
 *   cap-max-loss         max maxLoss (a loss is negative: higher = smaller loss)
 *   keep-theta           max theta (rupees a day earned)
 *   collect-credit-safe  max credit, and keep maxLoss no worse than now
 *   max-ev               max EV — needs a view, refused without one
 */
export const OBJECTIVE_PRESETS: Readonly<
  Record<PresetId, { readonly label: string; readonly metric: PlanMetric; readonly dir: 'min' | 'max' }>
> = Object.freeze({
  'neutralize-delta': Object.freeze({ label: 'Neutralize delta', metric: 'absDelta', dir: 'min' }),
  'recentre-delta0': Object.freeze({ label: 'Recentre Δ0 on the future', metric: 'delta0Gap', dir: 'min' }),
  'cut-margin': Object.freeze({ label: 'Cut margin', metric: 'margin', dir: 'min' }),
  'raise-pop': Object.freeze({ label: 'Raise POP', metric: 'pop', dir: 'max' }),
  'cut-vega': Object.freeze({ label: 'Cut vega', metric: 'absVega', dir: 'min' }),
  'cut-gamma': Object.freeze({ label: 'Cut short gamma', metric: 'gamma', dir: 'max' }),
  'cap-max-loss': Object.freeze({ label: 'Cap max loss', metric: 'maxLoss', dir: 'max' }),
  'keep-theta': Object.freeze({ label: 'Keep theta', metric: 'theta', dir: 'max' }),
  'collect-credit-safe': Object.freeze({ label: 'Collect credit, floor kept', metric: 'credit', dir: 'max' }),
  'max-ev': Object.freeze({ label: 'Raise expected value (needs a view)', metric: 'ev', dir: 'max' }),
} as const)

// ------------------------------------------------------------ normalisation

/** The fixed op order, so a normalised spec's `ops` reads the same however it was written. */
const OP_ORDER: readonly PlanOp[] = Object.freeze(['add', 'hedge', 'shift', 'future', 'close'] as const)
/** No closing unless the request allowed it (spec R6). */
const DEFAULT_OPS: readonly PlanOp[] = Object.freeze(['add', 'hedge', 'shift', 'future'] as const)
const DEFAULT_MAX_MOVES = 3
const DEFAULT_LOTS_PER_MOVE = 2
const DEFAULT_MAX_MARGIN_ADD_PCT = 10
const MAX_CONSTRAINTS = 8
const MAX_UNTOUCHABLE = 64

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function isMetric(v: unknown): v is PlanMetric {
  return typeof v === 'string' && (PLAN_METRICS as readonly string[]).includes(v)
}

/** A finite number within [lo, hi], the fallback when absent; an error string when present and not a number. */
function numberIn(v: unknown, fallback: number, lo: number, hi: number, where: string): number | string {
  if (v === undefined) return fallback
  const n = finite(v)
  if (n === null) return `${where} must be a number`
  return clamp(n, lo, hi)
}

function needsView(m: PlanMetric): boolean {
  return m === 'ev' || m === 'cvar'
}

function viewOf(raw: unknown): { view: MarketView | null } | { error: string } {
  if (raw === undefined || raw === null) return { view: null }
  if (!isRecord(raw) || !isRecord(raw['vol'])) return { error: 'view must be { vol: { kind: implied | shift | flat }, driftAnnual?, horizon? }' }
  const vol = raw['vol']
  let v: MarketView['vol']
  if (vol['kind'] === 'implied') v = { kind: 'implied' }
  else if (vol['kind'] === 'shift') {
    const pts = finite(vol['points'])
    if (pts === null) return { error: 'view.vol.points must be a number of vol points' }
    v = { kind: 'shift', points: clamp(pts, -50, 50) }
  } else if (vol['kind'] === 'flat') {
    const annual = finite(vol['annual'])
    if (annual === null || !(annual > 0)) return { error: 'view.vol.annual must be a positive decimal vol (0.22 = 22%)' }
    v = { kind: 'flat', annual: clamp(annual, 0.01, 3) }
  } else return { error: "view.vol.kind must be 'implied', 'shift' or 'flat'" }
  const out: { vol: MarketView['vol']; driftAnnual?: number; horizon?: string } = { vol: v }
  if (raw['driftAnnual'] !== undefined) {
    const d = finite(raw['driftAnnual'])
    if (d === null) return { error: 'view.driftAnnual must be a decimal per year' }
    out.driftAnnual = clamp(d, -1, 1)
  }
  if (raw['horizon'] !== undefined) {
    const h = raw['horizon']
    if (typeof h !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(h) || isoDayMs(h) === null) {
      return { error: 'view.horizon must be an ISO date, YYYY-MM-DD' }
    }
    out.horizon = h
  }
  return { view: out }
}

/**
 * A spec from anywhere — the model's tool call, the page's form, a caller's
 * literal — made safe to search: every field validated by hand (this package
 * has no schema library), defaults filled, numbers clamped to the spec's ranges
 * (maxMoves 1–4, maxLotsPerMove 1–5, floor guard 0–25%), 'close' stripped
 * unless `allowClose`, and EV or CVaR refused without a view. The output is in
 * one canonical shape, so two spellings of one objective serialise identically.
 */
export function normaliseObjective(raw: unknown, allowClose: boolean): { spec: ObjectiveSpec } | { error: string } {
  try {
    if (!isRecord(raw)) return { error: 'the objective must be an object' }

    const p = raw['primary']
    if (!isRecord(p) || !isMetric(p['metric'])) {
      return { error: `primary.metric must be one of ${PLAN_METRICS.join(', ')}` }
    }
    const metric = p['metric']
    const dir = p['dir'] === undefined ? METRIC_BETTER[metric] : p['dir']
    if (dir !== 'min' && dir !== 'max') return { error: "primary.dir must be 'min' or 'max'" }

    const rawHard = raw['hard'] ?? []
    if (!Array.isArray(rawHard)) return { error: 'hard must be a list' }
    if (rawHard.length > MAX_CONSTRAINTS) return { error: `at most ${MAX_CONSTRAINTS} hard constraints` }
    const hard: HardConstraint[] = []
    for (const [i, h] of rawHard.entries()) {
      if (!isRecord(h) || !isMetric(h['metric'])) return { error: `hard[${i}].metric must be one of ${PLAN_METRICS.join(', ')}` }
      if (h['op'] !== '<=' && h['op'] !== '>=') return { error: `hard[${i}].op must be '<=' or '>='` }
      const value = finite(h['value'])
      if (value === null) return { error: `hard[${i}].value must be a number` }
      const unit = h['unit'] ?? 'abs'
      if (unit !== 'abs' && unit !== 'pctOfNow' && unit !== 'changeFromNow') {
        return { error: `hard[${i}].unit must be 'abs', 'pctOfNow' or 'changeFromNow'` }
      }
      hard.push({ metric: h['metric'], op: h['op'], value, unit })
    }

    const rawKeep = raw['keep'] ?? []
    if (!Array.isArray(rawKeep)) return { error: 'keep must be a list' }
    if (rawKeep.length > MAX_CONSTRAINTS) return { error: `at most ${MAX_CONSTRAINTS} keep guards` }
    const keep: KeepGuard[] = []
    for (const [i, k] of rawKeep.entries()) {
      if (!isRecord(k) || !isMetric(k['metric'])) return { error: `keep[${i}].metric must be one of ${PLAN_METRICS.join(', ')}` }
      const tol = numberIn(k['tolerancePct'], 0, 0, 100, `keep[${i}].tolerancePct`)
      if (typeof tol === 'string') return { error: tol }
      keep.push({ metric: k['metric'], tolerancePct: tol })
    }

    const r = raw['rules'] ?? {}
    if (!isRecord(r)) return { error: 'rules must be an object' }
    let ops: PlanOp[]
    if (r['ops'] === undefined) {
      ops = allowClose ? [...DEFAULT_OPS, 'close'] : [...DEFAULT_OPS]
    } else {
      if (!Array.isArray(r['ops'])) return { error: 'rules.ops must be a list' }
      for (const op of r['ops']) {
        if (!(OP_ORDER as readonly unknown[]).includes(op)) return { error: `rules.ops: '${String(op)}' is not one of ${OP_ORDER.join(', ')}` }
      }
      const asked = new Set(r['ops'] as PlanOp[])
      // R6: the REQUEST decides closing, never the spec's author.
      if (!allowClose) asked.delete('close')
      ops = OP_ORDER.filter((op) => asked.has(op))
      if (ops.length === 0) return { error: "rules.ops leaves nothing to search with ('close' needs the trader's Allow closing legs)" }
    }
    const maxMoves = numberIn(r['maxMoves'], DEFAULT_MAX_MOVES, 1, 4, 'rules.maxMoves')
    if (typeof maxMoves === 'string') return { error: maxMoves }
    const maxLots = numberIn(r['maxLotsPerMove'], DEFAULT_LOTS_PER_MOVE, 1, 5, 'rules.maxLotsPerMove')
    if (typeof maxLots === 'string') return { error: maxLots }
    const marginAdd = numberIn(r['maxMarginAddPct'], DEFAULT_MAX_MARGIN_ADD_PCT, 0, 100, 'rules.maxMarginAddPct')
    if (typeof marginAdd === 'string') return { error: marginAdd }
    const fg = r['floorGuard'] ?? {}
    if (!isRecord(fg)) return { error: 'rules.floorGuard must be { maxLossWorsenPct, shockWorsenPct }' }
    const lossPct = numberIn(fg['maxLossWorsenPct'], 0, 0, 25, 'rules.floorGuard.maxLossWorsenPct')
    if (typeof lossPct === 'string') return { error: lossPct }
    const shockPct = numberIn(fg['shockWorsenPct'], 0, 0, 25, 'rules.floorGuard.shockWorsenPct')
    if (typeof shockPct === 'string') return { error: shockPct }
    const rawUntouchable = r['untouchable'] ?? []
    if (!Array.isArray(rawUntouchable) || rawUntouchable.some((s) => typeof s !== 'string')) {
      return { error: 'rules.untouchable must be a list of leg ids' }
    }
    const untouchable = [...new Set(rawUntouchable as string[])]
    if (untouchable.length > MAX_UNTOUCHABLE) return { error: `at most ${MAX_UNTOUCHABLE} untouchable legs` }
    const rules: { -readonly [K in keyof ObjectiveRules]: ObjectiveRules[K] } = {
      ops,
      maxMoves: Math.trunc(maxMoves),
      maxLotsPerMove: Math.trunc(maxLots),
      maxMarginAddPct: marginAdd,
      floorGuard: { maxLossWorsenPct: lossPct, shockWorsenPct: shockPct },
      untouchable,
    }
    if (r['maxDebit'] !== undefined) {
      const d = finite(r['maxDebit'])
      if (d === null) return { error: 'rules.maxDebit must be rupees' }
      rules.maxDebit = Math.max(0, d)
    }

    const v = viewOf(raw['view'])
    if ('error' in v) return { error: v.error }

    let pareto: readonly [PlanMetric, PlanMetric] | undefined
    if (raw['pareto'] !== undefined) {
      const pr = raw['pareto']
      if (!Array.isArray(pr) || pr.length !== 2 || !isMetric(pr[0]) || !isMetric(pr[1]) || pr[0] === pr[1]) {
        return { error: 'pareto must be two different metrics' }
      }
      pareto = [pr[0], pr[1]]
    }

    // EV and CVaR are a bet on where the price goes; without a stated view there
    // is nothing to compute them against, and a default view would be the
    // search placing that bet for the trader.
    const named = [metric, ...hard.map((h) => h.metric), ...keep.map((k) => k.metric), ...(pareto ?? [])]
    const blind = named.find(needsView)
    if (blind !== undefined && v.view === null) return { error: `${blind} needs a view` }

    const spec: ObjectiveSpec = {
      primary: { metric, dir },
      hard,
      keep,
      rules,
      view: v.view,
      ...(pareto === undefined ? {} : { pareto }),
    }
    return { spec }
  } catch {
    return { error: 'the objective could not be read' }
  }
}

/**
 * The goal chips as a spec. `ids[0]` is the primary; every further id becomes a
 * `keep` guard (tolerance 0) on its metric — "and do not make that worse" — a
 * metric already ranked or kept is not kept twice. `collect-credit-safe` brings
 * its own floor (keep maxLoss) when it is the primary. Unknown ids are skipped;
 * none left means `neutralize-delta`, the first chip. `max-ev` without a view
 * still returns its spec — `searchPlans` refuses it, with the reason.
 */
export function presetObjective(ids: readonly PresetId[], view: MarketView | null, allowClose: boolean): ObjectiveSpec {
  const known = (Array.isArray(ids) ? ids : []).filter((id): id is PresetId => (PRESET_IDS as readonly unknown[]).includes(id))
  const [first = PRESET_IDS[0] as PresetId, ...rest] = known
  const head = OBJECTIVE_PRESETS[first]
  const seen = new Set<PlanMetric>([head.metric])
  const keep: KeepGuard[] = []
  const guardOn = (m: PlanMetric): void => {
    if (seen.has(m)) return
    seen.add(m)
    keep.push({ metric: m, tolerancePct: 0 })
  }
  if (first === 'collect-credit-safe') guardOn('maxLoss')
  for (const id of rest) guardOn(OBJECTIVE_PRESETS[id].metric)
  return {
    primary: { metric: head.metric, dir: head.dir },
    hard: [],
    keep,
    rules: {
      ops: allowClose ? [...DEFAULT_OPS, 'close'] : [...DEFAULT_OPS],
      maxMoves: DEFAULT_MAX_MOVES,
      maxLotsPerMove: DEFAULT_LOTS_PER_MOVE,
      maxMarginAddPct: DEFAULT_MAX_MARGIN_ADD_PCT,
      floorGuard: { maxLossWorsenPct: 0, shockWorsenPct: 0 },
      untouchable: [],
    },
    view: view ?? null,
  }
}

// ------------------------------------------------------------- the scoring

const ZERO_METRICS: PlanMetrics = Object.freeze({
  ...ZERO_SCORE,
  delta: 0,
  gamma: 0,
  vega: 0,
  theta: 0,
  absDelta: 0,
  absVega: 0,
  delta0Gap: 0,
  ev: null,
  cvar5: null,
  popView: null,
  popRun: 0,
  margin: 0,
  marginSource: 'span-lite',
})

function fold(v: number): number {
  return v === 0 ? 0 : v
}

/** |Δ/Γ| in rupees of the future; 0 when Δ is 0, Infinity when Γ is 0 and Δ is not (spec §4). */
function delta0GapOf(delta: number, gamma: number): number {
  if (delta === 0) return 0
  if (gamma === 0) return Infinity
  return Math.abs(delta / gamma)
}

/**
 * The two distributions a search reads plans against: the trader's view, and the no-view one `popRun` uses.
 * `run: 'later'` skips `popRun` — only ever when the spec does not name 'pop', so nothing ranks on the
 * stand-in — and `withRun` fills it on the plans returned: a 241-point pass saved on every state the beam
 * scores and throws away.
 */
interface Dists {
  readonly view: Distribution | null
  readonly run: Distribution | null | 'later'
}

/** The run's own POP, 0–100; with no drawable vol at all, the surface's open-legs figure is the only one there is. */
function runPopOf(b: BookScore, run: Distribution | null): number {
  const stats = run === null ? null : statsOf(b.legs, run, b.runRealised)
  return stats === null ? 100 * b.scored.score.pop : stats.pop
}

/** `m` with its `popRun` read for real (it was scored with `run: 'later'`). Key order is unchanged. */
function withRun(m: PlanMetrics, b: BookScore, run: Distribution | null): PlanMetrics {
  return { ...m, popRun: runPopOf(b, run) }
}

/**
 * A scored book, read out in every figure the objective search ranks or constrains on.
 *
 * `marginBefore`, `marginAfter` and `marginDelta` (inherited from `PlanScore`) are ALWAYS SPAN-lite — the
 * comparator's tie-break reads them, and it must not change meaning between the walk and the final pool.
 * `margin` is the figure the ranking and the margin constraints used, real SPAN when `marginSource` says so;
 * a card shows `margin` and `change.margin`, never `marginDelta` beside them.
 */
function metricsOf(b: BookScore, dists: Dists, margin: number, source: 'span' | 'span-lite'): PlanMetrics {
  const s = b.scored.score
  const { delta, gamma, vega, theta } = b.greeks
  const view = dists.view === null ? null : statsOf(b.legs, dists.view, b.runRealised)
  return {
    credit: s.credit,
    maxLoss: s.maxLoss,
    maxLossAt: s.maxLossAt,
    breakevens: s.breakevens,
    worstShock: s.worstShock,
    worstShockAt: s.worstShockAt,
    marginBefore: s.marginBefore,
    marginAfter: s.marginAfter,
    marginDelta: s.marginDelta,
    profitableWidthPct: s.profitableWidthPct,
    pop: s.pop,
    delta: fold(delta),
    gamma: fold(gamma),
    vega: fold(vega),
    theta: fold(theta),
    absDelta: Math.abs(delta),
    absVega: Math.abs(vega),
    delta0Gap: delta0GapOf(delta, gamma),
    ev: view === null ? null : view.ev,
    cvar5: view === null ? null : view.cvar5,
    popView: view === null ? null : view.pop,
    popRun: dists.run === 'later' ? 100 * s.pop : runPopOf(b, dists.run),
    margin: fold(margin),
    marginSource: source,
  }
}

/** Two-sided and live: the quote a fill can cross. The spread limit is for OPENING (R8), not for getting out. */
function crossable(q: PlanQuote | null): q is PlanQuote & { bid: number; ask: number } {
  return (
    q !== null &&
    typeof q === 'object' &&
    q.stale === false &&
    finite(q.bid) !== null &&
    finite(q.ask) !== null &&
    (q.bid as number) > 0 &&
    (q.ask as number) >= (q.bid as number)
  )
}

/**
 * The price `searchPlans` and `scorePlan` fill an option trade at: the ask for a
 * buy and the bid for a sell when the contract has a live two-sided quote, else
 * the chain's mark (and the plan is then `indicative-price`). `qty` is the
 * trade's signed shares. Exported so a card can quote the very fills a plan was
 * scored on.
 */
export function planFill(ctx: PlanSearchContext): FillOf {
  const quote = guard<PlanQuote>(ctx?.quoteOf)
  const mark = guard<number>(ctx?.priceOf)
  return (strike: number, type: OptionType, qty: number): number | null => {
    const q = quote(strike, type)
    if (crossable(q)) return qty > 0 ? q.ask : q.bid
    return mark(strike, type)
  }
}

/** Does any option fill in this plan land on the mark rather than a live two-sided quote? */
function indicativeOf(moves: readonly Move[], legs: readonly PayoffLeg[], ctx: PlanSearchContext): boolean {
  const quote = guard<PlanQuote>(ctx?.quoteOf)
  const live = (k: number | null, t: OptionType | null): boolean => k !== null && t !== null && crossable(quote(k, t))
  for (const m of moves) {
    if (m.op === 'future') continue
    if (m.op === 'add' || m.op === 'hedge') {
      if (!live(m.strike, m.type)) return true
      continue
    }
    const leg = legs.find((l) => l.id === m.legId)
    if (leg === undefined || leg.instrument !== 'option') continue
    if (!live(leg.strike, leg.type)) return true
    if (m.op === 'shift' && !live(m.toStrike, leg.type)) return true
  }
  return false
}

/** The chain's ATM vol — the strike nearest the future, mean of its CE and PE — for the view's distribution. */
function atmIvOf(ctx: PlanSearchContext, future: number): number | undefined {
  const rows = Array.isArray(ctx?.strikes) ? ctx.strikes : []
  let best: number | null = null
  for (const s of rows) {
    const k = s !== null && typeof s === 'object' ? finite(s.strike) : null
    if (k === null || k <= 0) continue
    if (best === null || Math.abs(k - future) < Math.abs(best - future) || (Math.abs(k - future) === Math.abs(best - future) && k < best)) {
      best = k
    }
  }
  if (best === null) return undefined
  const ivOf = guard<number>(ctx?.ivOf)
  const ivs: number[] = []
  for (const t of ['CE', 'PE'] as const) {
    const row = rows.find((s) => s !== null && typeof s === 'object' && s.strike === best && s.type === t)
    const iv = finite(row?.iv ?? null) ?? finite(ivOf(best, t))
    if (iv !== null && iv > 0) ivs.push(iv)
  }
  return ivs.length === 0 ? undefined : ivs.reduce((a, b) => a + b, 0) / ivs.length
}

/** Everything one search (or one `scorePlan`) prices against, read once off the caller's context. */
interface Prepared {
  readonly base: ScoreBase
  readonly legs: readonly PayoffLeg[]
  readonly dials: RepairDials
  readonly futureMark: number | null
  readonly atmIv: number | undefined
  readonly marginOf: (legs: readonly PayoffLeg[]) => number | null
  /** The no-view distribution `popRun` is read on: zero drift, ATM vol, to the book's expiry. */
  readonly runDist: Distribution | null
}

/** The no-view distribution: what "probability of profit" means when nobody has stated a view. */
const NO_VIEW: MarketView = Object.freeze({ vol: Object.freeze({ kind: 'implied' as const }) })

function prepare(ctx: PlanSearchContext): Prepared {
  const rawLegs = ctx?.legs
  const legs = (Array.isArray(rawLegs) ? rawLegs : []).filter((l): l is PayoffLeg => l !== null && typeof l === 'object')
  const given = (ctx?.dials ?? {}) as Partial<RepairDials>
  const lot = finite(ctx?.lotSize)
  // The context's own lot wins; a missing one is the dials', and a missing
  // dial is 0 — no opens at all, never a plan sized in single shares.
  const lotSize = lot !== null && lot > 0 ? Math.trunc(lot) : Math.trunc(finite(given.lotSize) ?? 0)
  const dials: RepairDials = { ...DEFAULT_REPAIR_DIALS, ...given, lotSize }
  const future = finite(ctx?.future) ?? 0
  const today = typeof ctx?.today === 'string' ? ctx.today : ''
  const mark = finite(ctx?.futureMark)
  const futureMark = mark !== null && mark > 0 ? mark : null
  const marginBefore = finite(spanLiteMargin(legs, future, today).total) ?? 0
  const base: ScoreBase = {
    legs,
    future,
    today,
    expiry: typeof ctx?.expiry === 'string' ? ctx.expiry : '',
    realised: finite(ctx?.realised) ?? 0,
    priceOf: guard<number>(ctx?.priceOf),
    ivOf: guard<number>(ctx?.ivOf),
    marginBefore,
    // A futures close marks at the future's own price when the caller has one,
    // else at the forward the book is scored on — `searchRepairs`' rule.
    futureMark: futureMark ?? future,
    fillOf: planFill(ctx),
  }
  const marginOf = (book: readonly PayoffLeg[]): number | null => {
    if (typeof ctx?.marginOf !== 'function') return null
    try {
      const m = ctx.marginOf(book)
      return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : null
    } catch {
      return null
    }
  }
  const atmIv = atmIvOf(ctx, future)
  const runDist = drawDistribution(legs, future, today, NO_VIEW, atmIv)
  return { base, legs, dials, futureMark, atmIv, marginOf, runDist }
}

/**
 * One plan, scored the way `searchPlans` scores it — the same fills, the same
 * distribution, and the real SPAN (`ctx.marginOf`) when given. `moves: []` is
 * the do-nothing baseline. Null when a move does not land (no price, no such
 * leg, a future move with no `futureMark`) or the book cannot be priced.
 */
export function scorePlan(ctx: PlanSearchContext, moves: readonly Move[], view: MarketView | null): PlanMetrics | null {
  try {
    if (!Array.isArray(moves) || moves.some((m) => m === null || typeof m !== 'object')) return null
    const prep = prepare(ctx)
    if (prep.futureMark === null && moves.some((m) => m.op === 'future')) return null
    const scored = scoreBook(prep.base, moves)
    if (!scored.scored.ok) return null
    const dist = view === null || view === undefined ? null : drawDistribution(prep.legs, prep.base.future, prep.base.today, view, prep.atmIv)
    const real = prep.marginOf(scored.legs)
    return real === null
      ? metricsOf(scored, { view: dist, run: prep.runDist }, scored.scored.score.marginAfter, 'span-lite')
      : metricsOf(scored, { view: dist, run: prep.runDist }, real, 'span')
  } catch {
    return null
  }
}

// --------------------------------------------------------- the compiled goal

/** One constraint, resolved against a baseline: `value op limit`, and how to say so. */
interface Check {
  readonly metric: PlanMetric
  readonly op: '<=' | '>='
  readonly limit: number
  /** Judged on the real SPAN when there is one: the cap and any margin guard. */
  readonly margin: boolean
  /** What a rejected plan is counted under. */
  readonly reason: string
  /** Where it came from, for `binding`. */
  readonly source: string
}

const LABEL: Readonly<Record<PlanMetric, string>> = Object.freeze({
  margin: 'margin',
  pop: 'POP',
  ev: 'EV',
  cvar: 'CVaR 5%',
  maxLoss: 'max loss',
  worstShock: 'worst shock',
  absDelta: '|delta|',
  delta0Gap: 'Δ0 gap',
  gamma: 'gamma',
  vega: 'vega',
  absVega: '|vega|',
  theta: 'theta',
  credit: 'credit',
})

/** A figure as a binding line prints it: rupees and shares whole, POP to a tenth, the rest to four figures. */
function show(metric: PlanMetric, v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞'
  switch (metric) {
    case 'pop':
      return v.toFixed(1)
    case 'gamma':
      return v.toPrecision(4)
    case 'delta0Gap':
      return v.toFixed(2)
    default:
      return v.toFixed(0)
  }
}

/** The tolerance a limit is met within: rupee noise, scaled up for big figures. */
function slack(limit: number): number {
  return EPS * Math.max(1, Math.abs(limit))
}

function satisfied(c: Check, v: number | null): boolean {
  if (v === null || Number.isNaN(c.limit)) return false
  if (c.limit === Infinity) return c.op === '<='
  if (c.limit === -Infinity) return c.op === '>='
  return c.op === '<=' ? v <= c.limit + slack(c.limit) : v >= c.limit - slack(c.limit)
}

/** How far outside a check a value sits, relative to the limit's own size. 0 when inside. */
function violation(c: Check, v: number | null): number {
  if (satisfied(c, v)) return 0
  if (v === null || !Number.isFinite(c.limit) || !Number.isFinite(v)) return 1e6
  const over = c.op === '<=' ? v - c.limit : c.limit - v
  return Math.max(0, over) / Math.max(1, Math.abs(c.limit))
}

/**
 * The run-level money figures: they carry the P&L already booked (`ctx.realised`, goals.ts' doctrine). A PERCENT
 * of one is a percent of its OPEN part (now − realised): "max loss at 50% of now" halves the tail still at risk,
 * and a 10% floor relaxation is 10% of the open floor, whatever the series booked before. An absolute limit or a
 * change from now needs no such care: the booked money is on both sides of it.
 */
const RUN_LEVEL: ReadonlySet<PlanMetric> = new Set<PlanMetric>(['maxLoss', 'worstShock', 'ev', 'cvar'])

/** Every constraint of a spec, resolved against `base`, in the fixed order rejections are counted in. */
function checksOf(spec: ObjectiveSpec, base: PlanMetrics, realised: number): readonly Check[] {
  const out: Check[] = []
  const at = (m: PlanMetric): number => metricOf(base, m) ?? Number.NaN
  /** What a percent of `m` is taken of: its open part for a run-level figure. */
  const scaleOf = (m: PlanMetric): number => (RUN_LEVEL.has(m) ? at(m) - realised : at(m))
  const fg = spec.rules.floorGuard
  // R7, the floor guard: relaxed only by the spec's own percent of the (open) floor's size.
  const allowance = (m: PlanMetric, pct: number): number => (pct > 0 ? (Math.abs(scaleOf(m)) * pct) / 100 : 0)
  out.push({
    metric: 'maxLoss', op: '>=', limit: at('maxLoss') - allowance('maxLoss', fg.maxLossWorsenPct), margin: false,
    reason: 'worsens the floor (max loss on the ±10% scan)', source: fg.maxLossWorsenPct > 0 ? `floor guard, ${fg.maxLossWorsenPct}% relaxed` : 'floor guard',
  })
  out.push({
    metric: 'worstShock', op: '>=', limit: at('worstShock') - allowance('worstShock', fg.shockWorsenPct), margin: false,
    reason: 'worsens the ±5/±10% shock', source: fg.shockWorsenPct > 0 ? `floor guard, ${fg.shockWorsenPct}% relaxed` : 'floor guard',
  })
  out.push({
    metric: 'margin', op: '<=', limit: at('margin') * (1 + spec.rules.maxMarginAddPct / 100), margin: true,
    reason: `adds more than ${spec.rules.maxMarginAddPct}% margin`, source: `margin cap +${spec.rules.maxMarginAddPct}%`,
  })
  if (spec.rules.maxDebit !== undefined) {
    out.push({ metric: 'credit', op: '>=', limit: -spec.rules.maxDebit, margin: false, reason: `costs more than ₹${spec.rules.maxDebit.toFixed(0)}`, source: 'max debit' })
  }
  for (const h of spec.hard) {
    const now = at(h.metric)
    const limit = h.unit === 'abs' ? h.value : h.unit === 'pctOfNow' ? now - scaleOf(h.metric) + (scaleOf(h.metric) * h.value) / 100 : now + h.value
    const unit = h.unit === 'abs' ? '' : h.unit === 'pctOfNow' ? '% of now' : ' from now'
    out.push({
      metric: h.metric, op: h.op, limit, margin: h.metric === 'margin',
      reason: `fails ${LABEL[h.metric]} ${h.op === '<=' ? '≤' : '≥'} ${h.value}${unit}`, source: 'hard',
    })
  }
  for (const k of spec.keep) {
    const now = at(k.metric)
    const give = k.tolerancePct > 0 ? (Math.abs(scaleOf(k.metric)) * k.tolerancePct) / 100 : 0
    const max = METRIC_BETTER[k.metric] === 'max'
    out.push({
      metric: k.metric, op: max ? '>=' : '<=', limit: max ? now - give : now + give, margin: k.metric === 'margin',
      reason: `makes ${LABEL[k.metric]} worse than now`, source: k.tolerancePct > 0 ? `keep, ${k.tolerancePct}% give` : 'keep',
    })
  }
  return out
}

/** A finite stand-in for an unbounded figure, so the comparator's subtraction stays a number (see `GoalSpec`). */
function bounded(v: number | null): number {
  if (v === null || Number.isNaN(v)) return -Number.MAX_VALUE
  if (v === Infinity) return Number.MAX_VALUE
  if (v === -Infinity) return -Number.MAX_VALUE
  return v
}

/** The spec as the repairer's three functions, over the given checks. */
function goalOf(spec: ObjectiveSpec, checks: readonly Check[]): GoalSpec<PlanMetrics> {
  const sign = spec.primary.dir === 'max' ? 1 : -1
  return {
    feasible: (s) => checks.every((c) => satisfied(c, metricOf(s, c.metric))),
    distance: (s) => {
      let total = 0
      for (const c of checks) total += violation(c, metricOf(s, c.metric))
      return -Math.min(total, 1e12)
    },
    objective: (s) => {
      const v = metricOf(s, spec.primary.metric)
      return [v === null ? -Number.MAX_VALUE : bounded(sign * v), s.credit]
    },
  }
}

// ---------------------------------------------------------------- the search

const DEFAULT_TOP_N = 3
const DEFAULT_BEAM_WIDTH = 8
/** The states the real SPAN re-scores (spec §4). */
const FINAL_POOL = 200
/** Front plans added to the menu beyond `topN` when the spec asks for a Pareto front. */
const PARETO_EXTRA = 5
/**
 * Distinct plans the front is looked for among, beyond the menu itself: in
 * practice every feasible idea the walk found (a pool is a few hundred states),
 * bounded so a 64-wide, 4-deep walk cannot make the distinctness pass quadratic
 * in tens of thousands.
 */
const PARETO_CANDIDATES = 400
/** A constraint a plan sits within this share of is `binding`. */
const BINDING_SHARE = 0.02
const ILLIQUID = 'contracts left out: no live two-sided quote within max(10% of mid, ₹1) (R8)'
const SPAN_FAILED = 'NSE SPAN could not price the plan'

/** What a plan consumes, so it opens each contract once, trades the future once, and moves each leg once. */
function touches(m: Move): string | null {
  switch (m.op) {
    case 'add':
    case 'hedge':
      return `open:${m.strike}${m.type}`
    case 'future':
      return 'future'
    case 'shift':
    case 'close':
      return `leg:${m.legId}`
  }
}

function refusal(spec: ObjectiveSpec, baseline: PlanMetrics, why: string): PlanSearchResult {
  return { baseline, plans: [], pareto: [], rejected: [], spec, refused: why }
}

/**
 * Search a book for the plans that best serve `spec`, under its constraints and
 * the safety rules (see the header). `opts.topN` (default 3, ≤ 20) distinct
 * plans, `opts.beamWidth` (default 8, ≤ 64) states carried per depth.
 *
 * `opts.allowClose` is the trader's REQUEST permission (spec R6), and it is
 * asked for again here rather than read off the spec: a spec is something a
 * model can write, so a 'close' in it is honoured only when the caller passes
 * the request's own `allowClose: true` too. Absent, closes are stripped — the
 * safe way for a forgotten flag to fail.
 */
export function searchPlans(
  ctx: PlanSearchContext,
  spec: ObjectiveSpec,
  opts?: { readonly topN?: number; readonly beamWidth?: number; readonly allowClose?: boolean },
): PlanSearchResult {
  // The spec is re-read here, not trusted: a caller-built literal gets the same
  // clamps, and the same R6 strip, as the model's.
  const norm = normaliseObjective(spec, opts?.allowClose === true)
  try {
    const prep = prepare(ctx)
    const baseScore = scoreBook(prep.base, [])
    if ('error' in norm) {
      const base = baseScore.scored.ok ? metricsOf(baseScore, { view: null, run: prep.runDist }, baseScore.scored.score.marginAfter, 'span-lite') : ZERO_METRICS
      return refusal(spec, base, norm.error)
    }
    const s = norm.spec
    // IF THE DO-NOTHING BOOK CANNOT BE PRICED, NOTHING CAN — `goals.ts`' rule:
    // every constraint here is relative to it.
    if (!baseScore.scored.ok) return refusal(s, ZERO_METRICS, 'the book cannot be priced: no usable future, date or legs')

    const named = [s.primary.metric, ...s.hard.map((h) => h.metric), ...s.keep.map((k) => k.metric), ...(s.pareto ?? [])]
    const viewBased = named.some(needsView)
    const dist = s.view === null ? null : drawDistribution(prep.legs, prep.base.future, prep.base.today, s.view, prep.atmIv)
    const dists: Dists = { view: dist, run: prep.runDist }
    // The walk's states: `popRun` is read on every state when the spec ranks or
    // constrains on 'pop' (it IS that metric); otherwise it is filled on the
    // plans returned only, not on every state scored and thrown away.
    const walkDists: Dists = { view: dist, run: named.includes('pop') ? prep.runDist : 'later' }
    const liteBase = metricsOf(baseScore, dists, baseScore.scored.score.marginAfter, 'span-lite')
    if (viewBased && (dist === null || liteBase.ev === null)) {
      return refusal(s, liteBase, 'the view cannot be drawn on this book: no usable vol or horizon')
    }
    const realBaseMargin = prep.marginOf(prep.legs)
    const finalBase = realBaseMargin === null ? liteBase : metricsOf(baseScore, dists, realBaseMargin, 'span')

    const topN = clampInt(opts?.topN, DEFAULT_TOP_N, 0, 20)
    const beamWidth = clampInt(opts?.beamWidth, DEFAULT_BEAM_WIDTH, 1, 64)
    const alphabet = planMoves(prep.legs, Array.isArray(ctx?.strikes) ? ctx.strikes : [], prep.dials, {
      ops: s.rules.ops,
      maxLotsPerMove: s.rules.maxLotsPerMove,
      futureMark: prep.futureMark,
      untouchable: s.rules.untouchable,
      ...(typeof ctx?.quoteOf === 'function' ? { quoteOf: ctx.quoteOf } : {}),
    })

    // ---- the walk, on SPAN-lite, against the SPAN-lite baseline -----------
    const beamChecks = checksOf(s, liteBase, prep.base.realised)
    const beamGoal = goalOf(s, beamChecks)
    const cmpBeam = comparator(beamGoal)
    const books = new Map<string, BookScore>()
    const memo = new Map<string, Scored<PlanMetrics>>()
    const scoreOf = (moves: readonly Move[], key: string): Scored<PlanMetrics> => {
      const hit = memo.get(key)
      if (hit !== undefined) return hit
      const b = scoreBook(prep.base, moves)
      const out: Scored<PlanMetrics> = b.scored.ok
        ? { ...b.scored, score: metricsOf(b, walkDists, b.scored.score.marginAfter, 'span-lite') }
        : { ...b.scored, score: ZERO_METRICS }
      memo.set(key, out)
      if (b.scored.ok) books.set(key, b)
      return out
    }
    const seed: State<PlanMetrics> = {
      moves: [],
      last: -1,
      touched: new Set(),
      key: '',
      scored: { ...baseScore.scored, score: liteBase },
    }
    const pool = walkBeam<PlanMetrics>({
      seed,
      universe: alphabet.moves,
      maxMoves: s.rules.maxMoves,
      beamWidth,
      scoreOf,
      // Nothing here is monotone in the move list: no prune (see the header).
      admit: () => true,
      touches,
      cmp: cmpBeam,
    })

    // ---- the final pool: the real SPAN, when there is one ----------------
    const counts = new Map<string, number>()
    const count = (reason: string): void => {
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
    }
    const firstFailing = (checks: readonly Check[], m: PlanMetrics, which: (c: Check) => boolean): Check | undefined =>
      checks.find((c) => which(c) && !satisfied(c, metricOf(m, c.metric)))

    let finalChecks = beamChecks
    let feasible: State<PlanMetrics>[]
    if (realBaseMargin === null) {
      feasible = []
      for (const st of pool) {
        const bad = firstFailing(beamChecks, st.scored.score, () => true)
        if (bad === undefined) feasible.push(st)
        else count(bad.reason)
      }
    } else {
      finalChecks = checksOf(s, finalBase, prep.base.realised)
      const nonMargin: State<PlanMetrics>[] = []
      for (const st of pool) {
        const bad = firstFailing(beamChecks, st.scored.score, (c) => !c.margin)
        if (bad === undefined) nonMargin.push(st)
        else count(bad.reason)
      }
      // The cut is ranked WITHOUT the margin checks: SPAN-lite's verdict on
      // margin is exactly what this pass replaces, so a state it alone refused
      // must still compete for one of the 200 places on the objective.
      nonMargin.sort(comparator(goalOf(s, beamChecks.filter((c) => !c.margin))))
      feasible = []
      for (const st of nonMargin.slice(0, FINAL_POOL)) {
        const b = books.get(st.key)
        const real = b === undefined ? null : prep.marginOf(b.legs)
        if (b === undefined || real === null) {
          count(SPAN_FAILED)
          continue
        }
        const rescored: State<PlanMetrics> = { ...st, scored: { ...st.scored, score: metricsOf(b, walkDists, real, 'span') } }
        const bad = firstFailing(finalChecks, rescored.scored.score, (c) => c.margin)
        if (bad === undefined) feasible.push(rescored)
        else count(bad.reason)
      }
    }
    const finalGoal = goalOf(s, finalChecks)
    feasible.sort(comparator(finalGoal))

    // ---- the menu ---------------------------------------------------------
    // Greedy in rank order, so the first `topN` distinct plans are the same
    // whether or not more are asked for; the front is looked for among the rest.
    const distinct = pickDistinct(feasible, s.pareto === undefined ? topN : topN + PARETO_CANDIDATES)
    const chosen = distinct.slice(0, topN)
    if (s.pareto !== undefined) {
      const [x, y] = s.pareto
      const asPlans = distinct.map((st) => ({ key: st.key, metrics: st.scored.score }) as SearchedPlan)
      const front = new Set(paretoFront(asPlans, x, y, [METRIC_BETTER[x], METRIC_BETTER[y]]))
      let extra = 0
      for (const st of distinct.slice(topN)) {
        if (extra >= PARETO_EXTRA) break
        if (!front.has(st.key)) continue
        chosen.push(st)
        extra += 1
      }
    }

    const flagsOf = (st: State<PlanMetrics> | null): PlanFlag[] => {
      const flags: PlanFlag[] = []
      const m = st === null ? finalBase : st.scored.score
      if (st === null) flags.push('baseline')
      if (st === null && feasible.length === 0) flags.push('no-feasible-plan')
      if (st !== null && (m.maxLoss < finalBase.maxLoss - EPS || m.worstShock < finalBase.worstShock - EPS)) {
        flags.push('degrades-floor')
      }
      if (st !== null && m.margin > finalBase.margin + EPS) flags.push('margin-up')
      if (st !== null && indicativeOf(st.moves, prep.legs, ctx)) flags.push('indicative-price')
      if (alphabet.illiquid > 0) flags.push('illiquid-excluded')
      if (viewBased) flags.push('view-based')
      return flags
    }
    const changeOf = (m: PlanMetrics): Partial<Record<PlanMetric, number>> => {
      const out: Partial<Record<PlanMetric, number>> = {}
      for (const metric of PLAN_METRICS) {
        const a = metricOf(m, metric)
        const b = metricOf(finalBase, metric)
        if (a === null || b === null) continue
        const d = a - b
        if (Number.isFinite(d)) out[metric] = fold(d)
      }
      return out
    }
    const bindingOf = (m: PlanMetrics): string[] => {
      const out: string[] = []
      for (const c of finalChecks) {
        const v = metricOf(m, c.metric)
        if (v === null || !Number.isFinite(c.limit) || !satisfied(c, v)) continue
        if (Math.abs(v - c.limit) <= Math.max(BINDING_SHARE * Math.abs(c.limit), slack(c.limit))) {
          out.push(`${LABEL[c.metric]} ${c.op === '<=' ? '≤' : '≥'} ${show(c.metric, c.limit)} (${c.source})`)
        }
      }
      return out
    }

    const plans: SearchedPlan[] = chosen.map((st, i) => {
      const b = books.get(st.key)
      const metrics = b === undefined ? st.scored.score : withRun(st.scored.score, b, prep.runDist)
      return {
        key: st.key,
        rank: i + 1,
        moves: st.moves,
        metrics,
        change: changeOf(metrics),
        flags: flagsOf(st),
        binding: bindingOf(metrics),
      }
    })
    plans.push({ key: 'baseline', rank: 0, moves: [], metrics: finalBase, change: changeOf(finalBase), flags: flagsOf(null), binding: [] })

    const rejected: { reason: string; count: number }[] = []
    if (alphabet.illiquid > 0) rejected.push({ reason: ILLIQUID, count: alphabet.illiquid })
    const reasons = [...new Set([...finalChecks, ...beamChecks].map((c) => c.reason)), SPAN_FAILED]
    for (const reason of reasons) {
      const n = counts.get(reason)
      if (n !== undefined && n > 0) rejected.push({ reason, count: n })
    }

    const pareto = s.pareto === undefined ? [] : paretoFront(plans, s.pareto[0], s.pareto[1], [METRIC_BETTER[s.pareto[0]], METRIC_BETTER[s.pareto[1]]])
    return { baseline: finalBase, plans, pareto, rejected, spec: s, refused: null }
  } catch {
    // Unreachable by design, kept for the reason `goals.ts` keeps its own: a
    // malformed book must cost the trader the suggestions, never the page.
    return refusal('spec' in norm ? norm.spec : spec, ZERO_METRICS, 'the search failed on this book')
  }
}
