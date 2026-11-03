/**
 * `@algomaker/payoff` — what a book is worth, now and at expiry.
 *
 * Ten files, and the questions are answered by different arithmetic on purpose:
 *
 *   `legs.ts`    NOW. Mark-to-market off the traded future, Black-76, greeks
 *                already scaled by a signed share count.
 *   `expiry.ts`  AT EXPIRY. Pure intrinsic value — no model, no vol — plus the
 *                exact piecewise-linear breakevens that fall out of it.
 *   `surface.ts` BOTH, ON A GRID. Every price on the ladder x every date from
 *                today to expiry, reduced to the ten numbers a desk acts on.
 *   `margin.ts`  WHAT IT COSTS TO HOLD. The same repricing walked over a
 *                21-point price x vol shock grid: the worst loss is the SPAN.
 *   `ivs.ts`     WHAT VOL TO PRICE IT AT. Sticky-strike IVs solved off the live
 *                chain, neighbour-interpolated where a quote will not solve.
 *   `view.ts`    THE ANSWER A HUMAN READS. Three curves, one table, and the one
 *                place where P&L already BANKED is added back in.
 *   `machine.ts` WHAT THE BOT IS ABOUT TO DO. The two triggers the live
 *                `recenter-relief` playbook gates on, evaluated and explained.
 *   `moves.ts`   WHAT A PROPOSAL WOULD COST. Adds, hedges, shifts and closes
 *                applied to a book — booking every close, faking no fill.
 *   `candidates.ts` WHICH MOVES ARE EVEN ALLOWED. The alphabet a repair is
 *                spelled in: delta-banded sells, cheap-wing buys, rolls further
 *                out, and a close for every leg — nothing stale, nothing unpriced.
 *   `goals.ts`   WHAT TO DO ABOUT IT. Four goals in the operator's own words,
 *                a beam search over four-move plans, and the do-nothing baseline
 *                every one of them is ranked against. It suggests; nobody here
 *                decides.
 *   `objective.ts` WHAT THE TRADER ASKED FOR. Any one goal plus constraints
 *                (`ObjectiveSpec`, types in `objective-types.ts`) compiled onto
 *                the same beam, under the floor guard, the margin cap, the
 *                liquidity rule and fills at the side a trade crosses.
 *   `distribution.ts` WHAT IT IS EXPECTED TO MAKE. POP, EV and CVaR at a
 *                horizon under a view the trader stated — never a house view.
 *   `pareto.ts`  THE TRADE-OFF. The plans no other plan beats on two figures.
 *
 * The whole package is PURE: no clock, no feed, no Mongo. It takes a future
 * price and a time-to-expiry as arguments precisely so the payoff surface, the
 * scenario grid and the dashboard can all ask it about prices that do not exist
 * yet. Fail-soft throughout — a leg it cannot value contributes zero and never
 * a NaN, because every consumer sums these into a number a human then trades on.
 */
export { fromPyLeg, legPnl, legGreeks, DEFAULT_RATE, type PayoffLeg } from './legs.ts'
export { expiryPnlAt, expiryBreakevens, type ExpiryBreakevens } from './expiry.ts'
export {
  buildSurface,
  lognormalProbBetween,
  type Surface,
  type SurfaceInputs,
} from './surface.ts'
export { spanLiteMargin, type SpanLiteMargin, type SpanLiteOptions } from './margin.ts'
export { solveChainIvs, ivFor, type ChainQuoteLite, type SolvedIv } from './ivs.ts'
export { liquidIv, type LiquidIv, type LiquidIvSource } from './illiquid.ts'
export {
  buildPayoffView,
  type PayoffView,
  type PayoffViewInputs,
  type PayoffPoint,
  type PayoffRow,
} from './view.ts'
export { reliefTriggers, type ReliefState, type ReliefTriggers } from './machine.ts'
export { applyMoves, type Move, type AppliedBook, type FillOf } from './moves.ts'
export {
  atomicMoves,
  planMoves,
  liquidQuote,
  DEFAULT_REPAIR_DIALS,
  type RepairDials,
  type StrikeInfo,
  type PlanMoveRules,
  type PlanAlphabet,
} from './candidates.ts'
export {
  searchRepairs,
  type Goal,
  type PlanScore,
  type RepairPlan,
  type RepairContext,
  type SearchOptions,
} from './goals.ts'
export { buildMultiMonthView, type MultiMonthInputs } from './multi-month.ts'
export {
  PRESET_IDS,
  type PlanMetric,
  type MarketView,
  type ViewStats,
  type PlanOp,
  type HardConstraint,
  type KeepGuard,
  type ObjectiveRules,
  type ObjectiveSpec,
  type PlanMetrics,
  type PlanQuote,
  type PlanSearchContext,
  type PlanFlag,
  type SearchedPlan,
  type PlanSearchResult,
  type PresetId,
} from './objective-types.ts'
export {
  normaliseObjective,
  presetObjective,
  OBJECTIVE_PRESETS,
  searchPlans,
  scorePlan,
  planFill,
} from './objective.ts'
export { evaluateUnderView } from './distribution.ts'
export { paretoFront, metricOf, METRIC_BETTER, PLAN_METRICS } from './pareto.ts'
export {
  scenario,
  legPoints,
  valuationAt,
  forwardAt,
  ivUsed,
  rawIv,
  IV_FLOOR,
  istDay,
  type ScenarioMarket,
  type VolShifts,
  type ScenarioGreeks,
  type ScenarioCell,
  type LegPoint,
  type ValuationPoint,
  type ScenarioResult,
} from './scenario.ts'
export {
  scenarioAxes,
  gapRows,
  breakevenRange,
  payoffCurve,
  payoffTable,
  GRID_MAX_COUNT,
  GRID_MAX_DATES,
  PAYOFF_TABLE_PCTS,
  type AxesSpec,
  type Axes,
  type GapInput,
  type GapResult,
  type PayoffPointTE,
  type PayoffTableRow,
} from './scenario-grid.ts'
