/**
 * The objective search's types, and only its types — the contract the traders
 * app's agent and plan-search route compile against while `objective.ts`,
 * `distribution.ts` and `pareto.ts` are written beside them. Spec:
 * docs/superpowers/specs/2026-10-23-traders-ai-desk-design.md §4.
 *
 * An objective is a GOAL plus CONSTRAINTS, never a weighted score — the
 * doctrine of `goals.ts`' header. `primary` is the one thing ranked on; `hard`
 * is what a plan must satisfy; `keep` is what stacked goals turn into: "and do
 * not make this worse than it is now".
 */
import type { OptionType } from '@algomaker/greeks'
import type { PayoffLeg } from './legs.ts'
import type { Move } from './moves.ts'
import type { PlanScore, RepairContext } from './goals.ts'

/**
 * Everything a plan can be ranked or constrained on. Units: rupees unless said.
 *
 * POP IS THE RUN'S, AND PERCENT, AT THIS LAYER. The metric 'pop' reads `PlanMetrics.popRun` (0–100:
 * the whole run finishes the book's expiry ≥ 0, realised and this plan's closes included). The inherited
 * `PlanScore.pop` stays the surface's 0–1 open-legs probability (an existing contract — the panel and
 * `searchRepairs` read it) and nothing here ranks on it: a plan that banks a loser's loss reads 100% on
 * the open legs. A hard constraint `{ metric: 'pop', op: '>=', value: 60 }` means a 60% run POP, a keep
 * guard's tolerance is a percent of it, and `SearchedPlan.change.pop` is in percent points of it.
 * `ViewStats.pop` and `PlanMetrics.popView` are 0–100 as well.
 */
export type PlanMetric =
  | 'margin' // SPAN total after the plan
  | 'pop' // 0–100: PlanMetrics.popRun, the RUN finishes green at expiry (not the inherited 0–1 PlanScore.pop)
  | 'ev' // expected RUN P&L at the view's horizon — needs a view
  | 'cvar' // mean of the worst 5% at the horizon (negative = loss) — needs a view
  | 'maxLoss' // worst RUN P&L on the ±10% expiry ladder (negative = loss)
  | 'worstShock' // worst RUN P&L today at ±5% / ±10%
  | 'absDelta' // |delta|, shares
  | 'delta0Gap' // |Δ/Γ|, rupees of the future: how far the zero-delta price sits from it
  | 'gamma' // shares per rupee
  | 'vega' // rupees per vol point
  | 'absVega'
  | 'theta' // rupees per day
  | 'credit' // cash this plan moves, premium in less premium out

/** The vol and drift a distribution is drawn with. `null` view = no EV, no CVaR. */
export interface MarketView {
  readonly vol:
    | { readonly kind: 'implied' }
    | { readonly kind: 'shift'; readonly points: number }
    | { readonly kind: 'flat'; readonly annual: number }
  /** Decimal per year. Default 0. */
  readonly driftAnnual?: number
  /** ISO date ≤ the book's expiry. Default the book's expiry. */
  readonly horizon?: string
}

export interface ViewStats {
  /** 0–100: RUN P&L ≥ 0 at the horizon, realised included. */
  readonly pop: number
  readonly ev: number
  /** Mean of the worst 5% of outcomes, rupees, negative = loss. */
  readonly cvar5: number
  /** The distribution's σ of log price at the horizon. */
  readonly sigma: number
}

export type PlanOp = 'add' | 'hedge' | 'shift' | 'future' | 'close'

export interface HardConstraint {
  readonly metric: PlanMetric
  readonly op: '<=' | '>='
  readonly value: number
  /**
   * abs = the metric's own unit; pctOfNow = % of the baseline (for maxLoss, worstShock, ev and cvar, % of its OPEN
   * part, baseline − realised, with the realised added back); changeFromNow = baseline + value.
   */
  readonly unit: 'abs' | 'pctOfNow' | 'changeFromNow'
}

export interface KeepGuard {
  readonly metric: PlanMetric
  /** % of the baseline the plan may give up on this metric (of its open part for a run-level figure). 0 = strictly no worse. */
  readonly tolerancePct: number
}

export interface ObjectiveRules {
  /** 'close' only when the REQUEST allowed it — never the model (spec R6). */
  readonly ops: readonly PlanOp[]
  /** 1–4, default 3. */
  readonly maxMoves: number
  /** 1–5, default 2. */
  readonly maxLotsPerMove: number
  /** Default 10. */
  readonly maxMarginAddPct: number
  /** 0–25 each, default 0/0 (spec R7): % of the OPEN floor and shock (baseline − realised) a plan may give up. */
  readonly floorGuard: { readonly maxLossWorsenPct: number; readonly shockWorsenPct: number }
  /** Leg ids a plan may not shift or close. */
  readonly untouchable: readonly string[]
  /** Rupees. */
  readonly maxDebit?: number
}

export interface ObjectiveSpec {
  readonly primary: { readonly metric: PlanMetric; readonly dir: 'min' | 'max' }
  readonly hard: readonly HardConstraint[]
  readonly keep: readonly KeepGuard[]
  readonly rules: ObjectiveRules
  /** Required when primary, hard or keep name 'ev' or 'cvar'. */
  readonly view: MarketView | null
  readonly pareto?: readonly [PlanMetric, PlanMetric]
}

export interface PlanMetrics extends PlanScore {
  /** Post-plan greeks, in `buildSurface`'s units. */
  readonly delta: number
  readonly gamma: number
  readonly vega: number
  readonly theta: number
  readonly absDelta: number
  readonly absVega: number
  readonly delta0Gap: number
  readonly ev: number | null
  readonly cvar5: number | null
  /** 0–100: `ViewStats.pop` under the spec's view; null without one. */
  readonly popView: number | null
  /**
   * 0–100: the chance the RUN finishes the book's expiry ≥ 0 — zero drift, the chain's ATM vol, realised
   * (and this plan's closes) included. What the 'pop' metric ranks and constrains on. `pop` (inherited,
   * 0–1) is the OPEN legs' figure: a plan that closes or shifts a loser banks the loss out of the open legs
   * and can read 100% there while the run is not much better off. A card's POP is this one. (With no
   * drawable vol at all it falls back to `pop × 100`.)
   */
  readonly popRun: number
  /**
   * The margin the ranking and the margin constraints used, and where it came from. The inherited
   * `marginBefore`/`marginAfter`/`marginDelta` are ALWAYS SPAN-lite; with `marginSource: 'span'` show
   * `margin` and `change.margin`, never `marginDelta` beside them.
   */
  readonly margin: number
  readonly marginSource: 'span' | 'span-lite'
}

export interface PlanQuote {
  readonly bid: number | null
  readonly ask: number | null
  readonly stale: boolean
}

export interface PlanSearchContext extends RepairContext {
  /** The future's mark, for 'future' moves; null = no future moves. */
  readonly futureMark: number | null
  readonly lotSize: number
  /** Two-sided quote per contract, for the liquidity rule and crossing prices (spec R8). */
  readonly quoteOf?: (strike: number, type: OptionType) => PlanQuote | null
  /** Real NSE SPAN over a whole book; applied to the final pool only. */
  readonly marginOf?: (legs: readonly PayoffLeg[]) => number | null
}

export type PlanFlag =
  | 'baseline'
  | 'no-feasible-plan'
  | 'degrades-floor'
  | 'margin-up'
  | 'indicative-price'
  | 'illiquid-excluded'
  | 'view-based'

export interface SearchedPlan {
  readonly key: string
  readonly rank: number
  readonly moves: readonly Move[]
  readonly metrics: PlanMetrics
  /** after − baseline, per metric, in the metric's unit ('pop' in percent points); only the finite ones. */
  readonly change: Partial<Record<PlanMetric, number>>
  /** In PlanFlag's declared order. */
  readonly flags: readonly PlanFlag[]
  /** Constraints within 2% of their limit, as short human strings. */
  readonly binding: readonly string[]
}

export interface PlanSearchResult {
  readonly baseline: PlanMetrics
  readonly plans: readonly SearchedPlan[]
  /** Plan keys on the non-dominated front, when spec.pareto is set. */
  readonly pareto: readonly string[]
  readonly rejected: readonly { readonly reason: string; readonly count: number }[]
  /** As normalised: defaults filled, values clamped. */
  readonly spec: ObjectiveSpec
  /** Why no search ran (e.g. 'ev needs a view'); plans is then []. */
  readonly refused: string | null
}

export type PresetId =
  | 'neutralize-delta'
  | 'recentre-delta0'
  | 'cut-margin'
  | 'raise-pop'
  | 'cut-vega'
  | 'cut-gamma'
  | 'cap-max-loss'
  | 'keep-theta'
  | 'collect-credit-safe'
  | 'max-ev'

export const PRESET_IDS: readonly PresetId[] = Object.freeze([
  'neutralize-delta',
  'recentre-delta0',
  'cut-margin',
  'raise-pop',
  'cut-vega',
  'cut-gamma',
  'cap-max-loss',
  'keep-theta',
  'collect-credit-safe',
  'max-ev',
] as const)
