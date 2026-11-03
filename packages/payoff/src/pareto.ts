/**
 * THE TRADE-OFF, WITHOUT A WEIGHT.
 *
 * `goals.ts` refuses to rank on a weighted score because the weights are the
 * whole argument; a Pareto front is the honest answer to "and if I care about
 * two things?". It names the plans no other plan beats on BOTH figures at once —
 * cheaper margin AND a better POP, say — and leaves the trader to pick a point
 * on the curve, which is a decision and therefore theirs.
 *
 * A plan DOMINATES another when it is at least as good on both metrics and
 * strictly better on one. Two plans with identical figures dominate neither and
 * are both on the front. A plan with no figure on a metric (EV without a view)
 * cannot be compared and is never on it. Comparisons are by `<`/`>`, never by
 * subtraction, so an infinite Δ0 gap ranks as the worst gap and not as a NaN.
 *
 * `metricOf` lives here because it is the one place a `PlanMetric` is read off a
 * `PlanMetrics`, and both this file and the search (`objective.ts`) need it.
 * Units are the METRIC's, and they differ from `PlanScore`'s in one place: the
 * metric `pop` is `popRun` — the RUN's chance of finishing green, PERCENT — and
 * not the inherited 0–1 `PlanScore.pop` of the open legs (see `PlanMetric`).
 */
import type { PlanMetric, PlanMetrics, SearchedPlan } from './objective-types.ts'

/** Every metric, in the order the search reports changes in. */
export const PLAN_METRICS: readonly PlanMetric[] = Object.freeze([
  'margin',
  'pop',
  'ev',
  'cvar',
  'maxLoss',
  'worstShock',
  'absDelta',
  'delta0Gap',
  'gamma',
  'vega',
  'absVega',
  'theta',
  'credit',
] as const)

/**
 * Which way is BETTER on each metric — what "no worse than now" and a Pareto
 * front mean for it. Signed greeks are judged from the short-premium book this
 * desk holds: gamma and vega are better LESS SHORT (higher), theta better
 * higher. `absVega` and `absDelta` are distance from flat.
 */
export const METRIC_BETTER: Readonly<Record<PlanMetric, 'min' | 'max'>> = Object.freeze({
  margin: 'min',
  pop: 'max',
  ev: 'max',
  cvar: 'max',
  maxLoss: 'max',
  worstShock: 'max',
  absDelta: 'min',
  delta0Gap: 'min',
  gamma: 'max',
  vega: 'max',
  absVega: 'min',
  theta: 'max',
  credit: 'max',
})

/** A plan's figure on one metric, in the metric's own unit; `null` when it has none. */
export function metricOf(m: PlanMetrics, metric: PlanMetric): number | null {
  const v = ((): number | null => {
    switch (metric) {
      case 'margin':
        return m.margin
      case 'pop':
        return m.popRun
      case 'ev':
        return m.ev
      case 'cvar':
        return m.cvar5
      case 'maxLoss':
        return m.maxLoss
      case 'worstShock':
        return m.worstShock
      case 'absDelta':
        return m.absDelta
      case 'delta0Gap':
        return m.delta0Gap
      case 'gamma':
        return m.gamma
      case 'vega':
        return m.vega
      case 'absVega':
        return m.absVega
      case 'theta':
        return m.theta
      case 'credit':
        return m.credit
      default:
        return null
    }
  })()
  return typeof v === 'number' && !Number.isNaN(v) ? v : null
}

/** `a` is at least as good as `b` on this axis. */
function noWorse(a: number, b: number, dir: 'min' | 'max'): boolean {
  return dir === 'min' ? a <= b : a >= b
}

/** `a` is strictly better than `b` on this axis. */
function better(a: number, b: number, dir: 'min' | 'max'): boolean {
  return dir === 'min' ? a < b : a > b
}

/**
 * The keys of the plans on the non-dominated front of `x` × `y`, in the order
 * the plans were given. Deterministic: no sort, no hashing, O(n²) on a menu
 * that is never more than a few dozen plans.
 */
export function paretoFront(
  plans: readonly SearchedPlan[],
  x: PlanMetric,
  y: PlanMetric,
  dirs: readonly ['min' | 'max', 'min' | 'max'],
): string[] {
  try {
    const [dx, dy] = dirs
    const points = (Array.isArray(plans) ? plans : [])
      .filter((p): p is SearchedPlan => p !== null && typeof p === 'object' && p.metrics !== null && typeof p.metrics === 'object')
      .map((p) => ({ key: p.key, x: metricOf(p.metrics, x), y: metricOf(p.metrics, y) }))
      .filter((p): p is { key: string; x: number; y: number } => p.x !== null && p.y !== null)
    const front: string[] = []
    for (const p of points) {
      const dominated = points.some(
        (q) =>
          q !== p &&
          noWorse(q.x, p.x, dx) &&
          noWorse(q.y, p.y, dy) &&
          (better(q.x, p.x, dx) || better(q.y, p.y, dy)),
      )
      if (!dominated) front.push(p.key)
    }
    return front
  } catch {
    return []
  }
}
