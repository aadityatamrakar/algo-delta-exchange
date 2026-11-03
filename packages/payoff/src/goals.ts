/**
 * THE REPAIRER: four goals, four moves, and a human who still decides.
 *
 * Everything else in this package answers a question about a book that already
 * exists. This file PROPOSES books that do not — it composes the atomic moves of
 * `candidates.ts` into plans, prices each one through the same surface and
 * margin engines the panel draws, and hands back the best three per goal beside
 * the do-nothing baseline they must beat. Nothing here places an order, and
 * nothing here picks: the output is a ranked menu with its arithmetic attached,
 * because the operator is the one carrying the position.
 *
 * ─ WHY A GOAL AND NOT A SCORE ───────────────────────────────────────────────
 *
 * The Python desk's optimizer ranks one flat list by one weighted objective, and
 * the weights are the whole argument: a repair that halves the tail for ₹4,000
 * and one that collects ₹4,000 of premium are not comparable, and any single
 * number that ranks them has quietly decided what the operator wants. So there
 * are FOUR searches, each with its own objective in the operator's own words,
 * and the answer is four short lists rather than one long one:
 *
 *   REDUCE-LOSS           lift the floor. Nothing else is traded off.
 *   PROFITABLE-BY-EXPIRY  widen the part of the scan that finishes green,
 *                         probability of profit breaking the ties.
 *   CHEAP-TAIL-CAP        get the floor above a stated cap, for the least cash.
 *   MAX-CREDIT-SAFE       collect the most premium that does not drop the floor
 *                         below where it already is.
 *
 * The last two are CONSTRAINED objectives, and that shape is deliberate: it is
 * the difference between "reduce risk a bit and collect a bit" — which is what a
 * weighted sum always answers — and "do not lose more than ₹X, now find me the
 * cheapest way", which is the sentence a desk actually says out loud.
 *
 * ─ WHICH MONEY GOES WHERE, AND IT IS NOT ONE ANSWER ─────────────────────────
 *
 * `view.ts` settled this for the panel and the same doctrine governs the scores:
 *
 *   RUN-LEVEL, realised INCLUDED — `maxLoss`, `maxLossAt`, `breakevens`,
 *     `worstShock`, and the `≥ 0` test behind `profitableWidthPct`. These answer
 *     "how is this RUN doing if I make this trade", and money already banked by
 *     the closes inside the plan (plus whatever the book had banked before) is
 *     part of that answer. A repair search that ranked on open-legs P&L would
 *     rate "close the losing short" by the curve of what is left standing and
 *     never see the ₹42,000 the close just booked.
 *
 *   TRADE-LEVEL, realised EXCLUDED — `credit` and the three margin figures.
 *     `credit` is the CASH THIS PLAN MOVES: premium received less premium paid,
 *     positive in. What last week banked has nothing to do with what these legs
 *     cost, and the hedge budget is a fraction of the OPEN credit for the same
 *     reason.
 *
 *   `pop` is the one asymmetry, inherited knowingly from `buildSurface` and
 *     ledgered in `view.ts`: it is the probability the OPEN LEGS finish green,
 *     not the run. It is a tie-break here and never a constraint.
 *
 * ─ THE SEARCH ───────────────────────────────────────────────────────────────
 *
 * Beam search over move SETS, depth ≤ `maxMoves` (4). A state is extended only
 * by a move with a LATER index in the alphabet than its own last one, so each
 * set is reachable by exactly one path and the beam never spends its width on
 * permutations of a plan it already holds. Extensions may not touch a leg the
 * plan already moves (no closing a leg you just re-struck), and an (op, strike,
 * type) cannot repeat because each appears once in the alphabet.
 *
 * EVERY STATE VISITED AT EVERY DEPTH IS A CANDIDATE, not just the deepest: a
 * one-move plan is a legal plan, so the pool is everything scored and the beam
 * is only the frontier that gets EXTENDED. That is what keeps the answer from
 * being "the best four-move plan" when the best plan has one move in it.
 *
 * THE TWO HARD CONSTRAINTS ARE ENFORCED IN DIFFERENT PLACES, because they behave
 * differently. Hedge spend only ever grows as moves are added, so a state over
 * budget can never come back and it is pruned from the beam outright. Margin
 * does NOT behave like that — a long wing REDUCES the scan loss — so a plan may
 * cross `maxMarginAdd` at its second move and come back under at its third;
 * pruning it would hide the very repair that fixes it. Margin is therefore
 * filtered at the END, over the whole pool, and never inside the walk.
 *
 * FEASIBILITY IS RANKED, NOT PRUNED, for the same reason. A tail cap is usually
 * unreachable in one move; if infeasible states were dropped the search would
 * never reach the two-move plan that satisfies it. So the beam's comparator puts
 * feasible states first, ranks two infeasible ones by how close they got, and
 * only the RESULT is filtered down to what actually satisfies the goal.
 *
 * DETERMINISM IS A REQUIREMENT. Same inputs, same bytes out: the alphabet is
 * ordered, the enumeration is canonical, and every comparator ends in a TOTAL
 * tie-break (simpler plan, then less margin, then the move-set key) so no
 * ranking can depend on the order the beam happened to discover two equals in.
 * A menu that reorders between two identical calls cannot be argued with in a
 * post-mortem.
 *
 * A MENU OF THREE MUST BE THREE IDEAS, which takes two rules and both of them
 * earned their place against real output. TWO PLANS THAT LAND THE SAME BOOK ARE
 * ONE PLAN: distinctness is judged on the resulting position and cash, not the
 * move list, because "shift 760CE to 810" and "close 760CE, sell 810CE" are one
 * trade written twice. And A PLAN THAT IS ONE ALREADY ON THE MENU PLUS MORE LEGS
 * IS NOT A SECOND IDEA: it ranked lower, which by the goal's own objective means
 * the extra legs did not help. Without that rule the top three on a real book
 * came back as "close the loser", "close the loser and buy a ₹100 wing", and
 * "close the loser and buy a different ₹100 wing" — three rows, one idea, and
 * two of them strictly worse than the first.
 *
 * ─ WHAT THE SCORES CANNOT SEE ───────────────────────────────────────────────
 *
 * "Max loss" is the worst point ON THE SCAN, as everywhere in this package: a
 * short strangle's real downside is unbounded and its worst scan point is simply
 * the scan's own edge. `maxLossAt` sitting on the first or last ladder price is
 * the tell, and it is the normal case for short premium.
 *
 * The scan is ±10% in 121 points — the SAME ladder `view.ts` draws, so the floor
 * in this menu is the floor on the chart the operator is about to look at. That
 * still leaves a kink between two rungs invisible: a payoff kink sits at a
 * STRIKE and the ladder does not, so a plan whose worst point is a strike ~₹1.3
 * off a rung is flattered by that much. It is small enough to be noise beside a
 * repair worth doing and large enough to say out loud.
 *
 * Pure and fail-soft: no clock, no feed, nothing thrown. A goal it cannot serve
 * comes back as the baseline flagged `no-feasible-plan`, never as silence.
 *
 * ─ THE SEAM ─────────────────────────────────────────────────────────────────
 *
 * The objective search (`objective.ts`) is THIS search with a different goal,
 * not a second search. It compiles a trader's `ObjectiveSpec` into a `GoalSpec`
 * and runs the same scorer (`scoreBook`), the same walk (`walkBeam`), the same
 * comparator and the same distinctness rules (`pickDistinct`) exported below —
 * so a fix to how a plan is priced, walked or told apart lands in both menus at
 * once, and the doctrine above is the objective search's doctrine too. The
 * pieces are generic over the score a state carries (`S extends PlanScore`)
 * because the objective search scores more than ten figures; everything the
 * comparator reads is still a `PlanScore` field. They are package-internal:
 * `index.ts` exports `searchRepairs` and `searchPlans`, not the parts.
 */
import type { B76Greeks, OptionType } from '@algomaker/greeks'
import type { PayoffLeg } from './legs.ts'
import { applyMoves, type FillOf, type Move } from './moves.ts'
import { expiryBreakevens } from './expiry.ts'
import { buildSurface } from './surface.ts'
import { spanLiteMargin } from './margin.ts'
import type { ReliefTriggers } from './machine.ts'
import { atomicMoves, DEFAULT_REPAIR_DIALS, type RepairDials, type StrikeInfo } from './candidates.ts'

export type Goal = 'REDUCE-LOSS' | 'PROFITABLE-BY-EXPIRY' | 'CHEAP-TAIL-CAP' | 'MAX-CREDIT-SAFE'

/** The order goals are searched and returned in. Part of the output contract. */
const GOALS: readonly Goal[] = Object.freeze([
  'REDUCE-LOSS',
  'PROFITABLE-BY-EXPIRY',
  'CHEAP-TAIL-CAP',
  'MAX-CREDIT-SAFE',
] as const)

/**
 * What a plan would do to the book, in the ten figures a desk ranks on.
 *
 * See the header for which of these carry realised P&L and which do not — the
 * split is not cosmetic and is pinned by the suite.
 */
export interface PlanScore {
  /** Cash THIS PLAN moves: premium in less premium out. Realised is not in it. */
  readonly credit: number
  /** Worst RUN P&L on the ±10% expiry ladder, realised included. */
  readonly maxLoss: number
  /** The ladder price `maxLoss` happens at. Ties go to the lower price. */
  readonly maxLossAt: number
  /**
   * Where the RUN breaks even at expiry, ascending — the nearest crossing each
   * side, walked off the payoff's exact kinks by `expiryBreakevens`, which is
   * the function `view.ts` draws from. Not a crossing of the score ladder, so a
   * breakeven outside the ±10% scan is still reported.
   */
  readonly breakevens: readonly number[]
  /** Worst RUN P&L today at ±5% / ±10%, realised included. */
  readonly worstShock: number
  /** The shocked price it happens at — one of the four future multiples. */
  readonly worstShockAt: number
  /** SPAN-lite total before the plan. Rupees. */
  readonly marginBefore: number
  /** SPAN-lite total after it. */
  readonly marginAfter: number
  /** `marginAfter − marginBefore`. Positive means the plan costs capital. */
  readonly marginDelta: number
  /** Share of the ±10% ladder finishing at or above zero, 0–100, realised in. */
  readonly profitableWidthPct: number
  /** Probability the OPEN LEGS finish green. Not the run — see the header. */
  readonly pop: number
}

export interface RepairPlan {
  readonly goal: Goal
  /** In the order they would be placed. Empty on the baseline. */
  readonly moves: readonly Move[]
  readonly score: PlanScore
  /**
   * `baseline`, `no-feasible-plan`, `degrades-floor`, `bot-may-reshift`,
   * `bot-rebalance-pending` — always in that order, so a rendered chip row does
   * not reshuffle itself.
   *
   * `degrades-floor` is the one that is not about the bot and not about this
   * search: it says the plan leaves the book worse off at the bottom than doing
   * nothing does. Every goal can produce one and three of the four routinely do.
   */
  readonly flags: readonly string[]
}

export interface RepairContext {
  /** The open book, IVs already stamped. */
  readonly legs: readonly PayoffLeg[]
  /** The FUTURE price now — the Black-76 mark, not cash spot. */
  readonly future: number
  /** Valuation date, ISO `YYYY-MM-DD`. */
  readonly today: string
  /** The book's expiry, ISO `YYYY-MM-DD`. Every plan is scored to it. */
  readonly expiry: string
  /** P&L already banked by this run, rupees. Pass 0 when it is genuinely zero. */
  readonly realised: number
  readonly dials: RepairDials
  /** The chain's mark for a contract, `null` when it cannot price one. */
  readonly priceOf: (strike: number, type: OptionType) => number | null
  /** The chain's solved vol for a contract. */
  readonly ivOf: (strike: number, type: OptionType) => number | null
  /** The tradeable chain, one row per (strike, type). */
  readonly strikes: readonly StrikeInfo[]
  /** What the bot is about to do, for the conflict flags. `null` if unknown. */
  readonly triggers: ReliefTriggers | null
  /** CHEAP-TAIL-CAP's target floor, as a POSITIVE number of rupees of loss. */
  readonly tailCapRupees?: number
}

export interface SearchOptions {
  /** Moves per plan. Default 4. */
  readonly maxMoves?: number
  /** Distinct plans per goal, beside the baseline. Default 3. */
  readonly topN?: number
  /** States carried forward per depth. Default 8. */
  readonly beamWidth?: number
  /**
   * The kinds of move a plan may use. Default: all four. The traders app passes add, hedge and shift: its traders
   * asked for repairs that adjust or extend a book, never one that just closes a leg.
   */
  readonly ops?: readonly Move['op'][]
}

const DEFAULT_MAX_MOVES = 4
const DEFAULT_TOP_N = 3
const DEFAULT_BEAM_WIDTH = 8
/** Rupee noise. Two plans within a paisa of a limit are on the same side of it. */
export const EPS = 1e-6

export const ZERO_SCORE: PlanScore = Object.freeze({
  credit: 0,
  maxLoss: 0,
  maxLossAt: 0,
  breakevens: Object.freeze([]),
  worstShock: 0,
  worstShockAt: 0,
  marginBefore: 0,
  marginAfter: 0,
  marginDelta: 0,
  profitableWidthPct: 0,
  pop: 0,
})

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function num(v: unknown): number {
  return finite(v) ?? 0
}

/** `-0` folded: it is a stored value here, and it survives `deepStrictEqual`. */
function fold(v: number): number {
  return v === 0 ? 0 : v
}

export function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = finite(v)
  if (n === null) return fallback
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

/**
 * A caller's lookup that cannot take the search down with it. Same promise
 * `applyMoves` makes internally: a lookup that throws is "no price", never a
 * crash in the middle of a walk over hundreds of candidate books.
 */
export function guard<T>(fn: ((strike: number, type: OptionType) => T | null) | undefined) {
  return (strike: number, type: OptionType): T | null => {
    if (typeof fn !== 'function') return null
    try {
      return fn(strike, type)
    } catch {
      return null
    }
  }
}

/**
 * A move's identity, and with it the memo key of any plan containing it.
 * `qty` is in the key for the opens: two plans that sell different sizes at one
 * strike are two plans — the objective search's size ladder generates exactly
 * that, and `searchRepairs` (one lot per open) never does.
 */
export function moveKey(m: Move): string {
  switch (m.op) {
    case 'add':
    case 'hedge':
      return `${m.op}|${m.strike}|${m.type}|${m.qty}`
    case 'shift':
      return `shift|${m.legId}|${m.toStrike}`
    case 'close':
      return `close|${m.legId}`
    case 'future':
      return `future|${m.qty}`
  }
}

/** The leg a move consumes, so a plan cannot both re-strike and close it. */
function touchedLeg(m: Move): string | null {
  return m.op === 'shift' || m.op === 'close' ? m.legId : null
}

/**
 * The levels the run breaks even at, ascending — EXACTLY the ones `view.ts`
 * reports, by the same function and with the same endpoint guard.
 *
 * Not a grid crossing. `expiryBreakevens` walks the payoff's KINKS, so it puts a
 * breakeven where the break actually is rather than within one rung of it; the
 * menu and the chart underneath it must not name two different levels for the
 * same book. That is also why the 3× endpoint artefact is filtered here as it is
 * at the display boundary (`view.ts`:331-358): when the payoff is flat at
 * exactly zero out at the synthetic far edge, the port faithfully reports that
 * edge as an upside breakeven, and it is not a level any desk defends.
 *
 * At most two numbers — the nearest crossing each side — because that is what
 * `expiryBreakevens` answers and what a desk defends. `realized` shifts the
 * whole curve, so these are RUN-level, like every ₹ score here.
 */
function runBreakevens(
  legs: readonly PayoffLeg[],
  future: number,
  banked: number,
): readonly number[] {
  const be = expiryBreakevens(legs, future, banked)
  const strikes = legs
    .map((l) => l.strike)
    .filter((s): s is number => s !== null && Number.isFinite(s))
  let up = be.up
  if (strikes.length > 0 && up !== null) {
    if (up >= Math.max(Math.max(...strikes), future) * 3) up = null
  }
  return [be.down, up]
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b)
}

/** One scored candidate book. `ok: false` means a move did not land — see below. */
export interface Scored<S extends PlanScore = PlanScore> {
  readonly ok: boolean
  readonly score: S
  /** Premium PAID by this plan's hedges, rupees. Monotone in the move list. */
  readonly hedgeSpend: number
  /** Premium the resulting OPEN legs collected. The hedge budget's base. */
  readonly netCredit: number
  /** The resulting position and cash, for distinctness. */
  readonly bookKey: string
}

export const UNSCORED: Scored = Object.freeze({
  ok: false,
  score: ZERO_SCORE,
  hedgeSpend: 0,
  netCredit: 0,
  bookKey: '',
})

/** A state in the walk: a move set, its score, and what it has already consumed. */
export interface State<S extends PlanScore = PlanScore> {
  readonly moves: readonly Move[]
  /** Index in the alphabet of the last move — extensions must come after it. */
  readonly last: number
  readonly touched: ReadonlySet<string>
  readonly key: string
  readonly scored: Scored<S>
}

/**
 * What a goal wants, in three functions.
 *
 * `distance` is only ever consulted between two INFEASIBLE states — "which of
 * these two failures got closer" — and is what lets the beam walk toward a
 * constraint it cannot satisfy in one move. `objective` is lexicographic and
 * higher-is-better throughout, so "cheapest debit" is expressed as "most credit"
 * and there is exactly one direction in the whole file.
 *
 * FINITE NUMBERS ONLY, from both `distance` and `objective`: the comparator
 * ranks by subtraction, and `Infinity − Infinity` is NaN, which would make the
 * order depend on which side of a comparison a state happened to be on. A goal
 * with an unbounded figure (the objective search's Δ0 gap) clamps it first.
 */
export interface GoalSpec<S extends PlanScore = PlanScore> {
  feasible(s: S): boolean
  distance(s: S): number
  objective(s: S): readonly number[]
}

function specFor(goal: Goal, baseline: PlanScore, tailCap: number): GoalSpec {
  switch (goal) {
    case 'REDUCE-LOSS':
      return {
        feasible: () => true,
        distance: (s) => s.maxLoss,
        // Credit breaks ties: between two plans with the same floor, the one
        // that costs less to put on is strictly better.
        objective: (s) => [s.maxLoss, s.credit],
      }
    case 'PROFITABLE-BY-EXPIRY':
      return {
        feasible: () => true,
        distance: (s) => s.profitableWidthPct,
        objective: (s) => [s.profitableWidthPct, s.pop],
      }
    case 'CHEAP-TAIL-CAP':
      return {
        // The cap is a LOSS, stated positive; the floor must sit above its
        // negation. `EPS` so a plan that lands exactly on the cap is inside it.
        feasible: (s) => s.maxLoss >= -tailCap - EPS,
        distance: (s) => s.maxLoss,
        objective: (s) => [s.credit],
      }
    case 'MAX-CREDIT-SAFE':
      return {
        feasible: (s) => s.maxLoss >= baseline.maxLoss - EPS,
        distance: (s) => s.maxLoss,
        objective: (s) => [s.credit],
      }
  }
}

/**
 * Ranking, and it is a TOTAL order — see the header on determinism.
 *
 * Feasible first; two infeasible states by how close they got; then the goal's
 * own objective; then the universal tie-breaks. Negative means `a` ranks higher.
 */
export function comparator<S extends PlanScore>(spec: GoalSpec<S>): (a: State<S>, b: State<S>) => number {
  return (a, b) => {
    const sa = a.scored.score
    const sb = b.scored.score
    const fa = spec.feasible(sa)
    const fb = spec.feasible(sb)
    if (fa !== fb) return fa ? -1 : 1
    if (!fa) {
      const d = spec.distance(sb) - spec.distance(sa)
      if (d !== 0) return d < 0 ? -1 : 1
    }
    const oa = spec.objective(sa)
    const ob = spec.objective(sb)
    for (let i = 0; i < oa.length; i++) {
      const d = (ob[i] ?? 0) - (oa[i] ?? 0)
      if (d !== 0) return d < 0 ? -1 : 1
    }
    // A simpler plan first: fewer legs to place, fewer to get wrong.
    if (a.moves.length !== b.moves.length) return a.moves.length - b.moves.length
    const m = sa.marginDelta - sb.marginDelta
    if (m !== 0) return m < 0 ? -1 : 1
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  }
}

/**
 * What a scorer needs to know about the book every candidate is applied to.
 * `searchRepairs` fills it from its context; the objective search adds the
 * crossing-side fills (`fillOf`) and the future's own mark.
 */
export interface ScoreBase {
  readonly legs: readonly PayoffLeg[]
  /** The FUTURE price the surface and the margin are read at. */
  readonly future: number
  readonly today: string
  readonly expiry: string
  readonly realised: number
  readonly priceOf: (strike: number, type: OptionType) => number | null
  readonly ivOf: (strike: number, type: OptionType) => number | null
  /** SPAN-lite of the do-nothing book. */
  readonly marginBefore: number
  /** What a futures close, and a `future` move, fills at. `searchRepairs` passes `future`. */
  readonly futureMark: number
  /** The side a trade crosses (`moves.ts`). Absent: every fill is `priceOf`. */
  readonly fillOf?: FillOf
}

/** One candidate book, scored, with the book itself and its greeks beside the score. */
export interface BookScore {
  readonly scored: Scored
  /** The book as the plan leaves it. Empty when the plan did not land. */
  readonly legs: readonly PayoffLeg[]
  /** Its greeks today at the ladder point nearest the future (`buildSurface`'s); zeros for an empty book. */
  readonly greeks: B76Greeks
  /** P&L the run has banked once this plan's closes are in. */
  readonly runRealised: number
}

const ZERO_GREEKS: B76Greeks = Object.freeze({ delta: 0, gamma: 0, theta: 0, vega: 0 })

const UNSCORED_BOOK: BookScore = Object.freeze({
  scored: UNSCORED,
  legs: Object.freeze([]) as readonly PayoffLeg[],
  greeks: ZERO_GREEKS,
  runRealised: 0,
})

/**
 * Score one candidate book: apply the moves, price the result through the same
 * surface and margin engines the panel draws, and reduce it to a `PlanScore`.
 * THE scorer — `searchRepairs` and the objective search both rank on it.
 */
export function scoreBook(base: ScoreBase, moves: readonly Move[]): BookScore {
  const { legs, future, today, expiry, realised, priceOf, ivOf, marginBefore } = base
  // A future mark is passed so a FUTURES leg can be closed: the chain prices
  // options only, and without it "flatten this book" is silently
  // unproposable on precisely the books that most need flattening.
  const applied = applyMoves(legs, moves, priceOf, ivOf, base.futureMark, base.fillOf)
  // A move the chain could not fill is DROPPED by `applyMoves` with a
  // warning, which would leave this state pretending to be a plan it is not
  // — and silently equal to a shorter plan already in the pool. The whole
  // state goes instead.
  if (applied.warnings.length > 0) return UNSCORED_BOOK

  const runRealised = realised + applied.realisedDelta
  const credit = fold(num(applied.creditDelta))
  const marginAfter = num(spanLiteMargin(applied.legs, future, today).total)
  const marginDelta = fold(marginAfter - marginBefore)

  let hedgeSpend = 0
  for (const m of moves) {
    if (m.op !== 'hedge') continue
    hedgeSpend += Math.max(0, num(m.qty)) * num(priceOf(m.strike, m.type))
  }

  // WHAT MAKES TWO PLANS THE SAME PLAN — the run's own payoff, written out:
  //
  //   P&L(v) = Σ_legs qty·(payoff(v) − entry) + realised
  //          = Σ_contracts (Σ qty)·payoff_c(v)  +  (realised − Σ qty·entry)
  //             \_______ net position _______/     \_____ one constant ____/
  //
  // So a book is fully described, at every price, by the NET quantity per
  // contract and that single scalar. Both halves are load-bearing and each
  // has caught a real duplicate:
  //
  //   NETTING catches "buy your short back" against "close your short" — one
  //   leaves two offsetting rows and the other leaves none, and they are the
  //   same position.
  //   THE CONSTANT is what makes that true when the leg was NOT entered at
  //   today's mark. The offsetting pair is not worth zero: short at E against
  //   long at M is worth `qty·(E − M)` at every price forever, which is
  //   exactly the P&L the close BANKS. Keying on `realised` alone would call
  //   them different (one banked it, the other still carries it); keying on
  //   `realised − Σ qty·entry` sees one number in two pockets.
  //
  // `credit` stays in the key beside it because it is not implied by the
  // curve: two plans could in principle reach one payoff for different cash,
  // and the menu ranks on that cash. Both are quantised to the paisa — the
  // two spellings compute the same constant by different routes and must not
  // be split by a float ULP.
  let basis = 0
  const net = new Map<string, number>()
  for (const l of applied.legs) {
    const k = `${l.instrument}|${String(l.strike)}|${String(l.type)}`
    net.set(k, (net.get(k) ?? 0) + num(l.qty))
    basis += num(l.qty) * num(l.entry)
  }
  const bookKey =
    [...net.entries()]
      .filter(([, q]) => q !== 0)
      .map(([k, q]) => `${k}|${q}`)
      .sort()
      .join(';') + `#${(applied.realisedDelta - basis).toFixed(2)}#${credit.toFixed(2)}`

  // EVERY LEG CLOSED is a real, ordinary plan — "flatten and bank" — and the
  // run is then FLAT at what it banked, at every price. It is answered here
  // rather than by the surface because `buildSurface` has nothing to price
  // and correctly says so with a warning, and the branch below cannot tell
  // that warning apart from the ones that mean the score is WRONG.
  if (applied.legs.length === 0) {
    const flat = fold(runRealised)
    const scored: Scored = {
      ok: true,
      hedgeSpend,
      netCredit: 0,
      bookKey,
      score: {
        credit,
        maxLoss: flat,
        // Nowhere in particular: the line is flat. `future` is where the
        // reader is standing.
        maxLossAt: future,
        breakevens: [],
        worstShock: flat,
        // Nowhere in particular, same as maxLossAt: the line is flat.
        worstShockAt: future,
        marginBefore,
        marginAfter,
        marginDelta,
        profitableWidthPct: runRealised >= 0 ? 100 : 0,
        // No open legs, so "will the open legs finish green" has no answer.
        // `buildSurface` returns 0 for an empty book and so does this.
        pop: 0,
      },
    }
    return { scored, legs: applied.legs, greeks: { ...ZERO_GREEKS }, runRealised }
  }

  const surface = buildSurface({
    legs: applied.legs,
    spot: future,
    dates: [today, expiry],
    // THE SAME LADDER `view.ts` DRAWS — ±10% in 121 points — stated here
    // rather than inherited so it cannot drift from the chart. The operator
    // picks a plan off this menu and the panel then redraws the book at that
    // resolution; a menu quoting a floor off a coarser grid would disagree
    // with the curve underneath it by a rung's worth of kink, and "the chart
    // says something else" is not a discrepancy anyone should have to chase
    // with a position on. It is also what makes the floor READ rather than
    // interpolated (see `view.ts`): a payoff kink sits at a strike, and a
    // 21-rung ladder steps over strikes.
    band: 0.1,
    steps: 60,
  })
  const prices = surface.prices
  const expiryCol = surface.cells[expiry] ?? []
  // NO EXPIRY COLUMN, NO SCORE — and it is the one test worth making,
  // because it separates the two things a warning can mean.
  //
  // `buildSurface` answers what it CANNOT PRICE AT ALL — an unusable future,
  // a date that is not ISO — with `empty()`: a zeroed summary and no ladder
  // at all. That is not a degraded reading, it is a WRONG one that outranks
  // every honest plan (a floor of 0 beats every losing book) and it must not
  // rank. An absent expiry column is the same failure by another route: every
  // figure in this file is "at expiry", so scoring a book against whatever
  // other column survived silently answers a different question.
  //
  // But it also warns about things it priced through PERFECTLY WELL — a leg
  // whose entry will not parse, a spare date it dropped. Those keep a full
  // ladder, `view.ts` renders that same book for the same operator, and
  // refusing to rank it would blank the whole menu over one bad row. They
  // score, and the warning is the panel's to show.
  //
  // (The legitimately empty book — every leg closed — returned above, before
  // the surface was ever consulted, which is what makes these two tellable
  // apart at all. And if the do-nothing baseline itself cannot be scored,
  // the whole search returns baselines; see `searchRepairs`.)
  if (prices.length === 0 || expiryCol.length === 0) return UNSCORED_BOOK

  // WHERE it hurts most. Ties go to the lower price, as `view.ts` does.
  let worstIdx = -1
  let worst = Infinity
  for (let i = 0; i < expiryCol.length; i++) {
    const v = expiryCol[i]
    if (v === undefined) continue
    if (v < worst) {
      worst = v
      worstIdx = i
    }
  }

  // A surface that warned is already gone, so the ladder is real here.
  const green = expiryCol.filter((v) => v + runRealised >= 0).length
  const width = (100 * green) / prices.length

  const score: PlanScore = {
    credit,
    maxLoss: fold(num(surface.maxLoss) + runRealised),
    maxLossAt: worstIdx < 0 ? future : num(prices[worstIdx]),
    breakevens: runBreakevens(applied.legs, future, runRealised),
    worstShock: fold(num(surface.worstShock) + runRealised),
    // Realised is a constant shift: it moves the figure, never the argmin.
    worstShockAt: num(surface.worstShockAt),
    marginBefore,
    marginAfter,
    marginDelta,
    profitableWidthPct: width,
    pop: num(surface.pop),
  }

  return {
    scored: { ok: true, score, hedgeSpend, netCredit: num(surface.netCredit), bookKey },
    legs: applied.legs,
    greeks: surface.greeks,
    runRealised,
  }
}

/** One beam walk's inputs. See the header: THE SEARCH. */
export interface Walk<S extends PlanScore> {
  /** The do-nothing state: no moves, `last: -1`, the baseline's score. */
  readonly seed: State<S>
  /** The alphabet, in its canonical order — extensions only ever take a later index. */
  readonly universe: readonly Move[]
  readonly maxMoves: number
  readonly beamWidth: number
  /** Memoised on `key`; a state whose score is not `ok` is never visited. */
  readonly scoreOf: (moves: readonly Move[], key: string) => Scored<S>
  /** A prune for constraints that are MONOTONE in the move list, and only those. */
  readonly admit: (scored: Scored<S>) => boolean
  /** What a move consumes; a plan may consume each thing once. `null` = nothing. */
  readonly touches: (m: Move) => string | null
  readonly cmp: (a: State<S>, b: State<S>) => number
}

/**
 * The walk itself: every state visited at every depth, in visiting order. The
 * caller filters and sorts the pool — see the header for why the pool and the
 * beam are different things.
 */
export function walkBeam<S extends PlanScore>(w: Walk<S>): State<S>[] {
  const { universe, maxMoves, beamWidth, scoreOf, cmp } = w
  const pool: State<S>[] = []
  let beam: readonly State<S>[] = [w.seed]
  for (let depth = 0; depth < maxMoves; depth++) {
    const children: State<S>[] = []
    for (const st of beam) {
      for (let i = st.last + 1; i < universe.length; i++) {
        const mv = universe[i]
        if (mv === undefined) continue
        const leg = w.touches(mv)
        if (leg !== null && st.touched.has(leg)) continue
        const key = st.key === '' ? moveKey(mv) : `${st.key};${moveKey(mv)}`
        const moves = [...st.moves, mv]
        const scored = scoreOf(moves, key)
        if (!scored.ok) continue
        if (!w.admit(scored)) continue
        children.push({
          moves,
          last: i,
          touched: leg === null ? st.touched : new Set([...st.touched, leg]),
          key,
          scored,
        })
      }
    }
    if (children.length === 0) break
    for (const c of children) pool.push(c)
    // The frontier is ranked and cut; the POOL keeps every state, because a
    // one-move plan is a plan.
    beam = [...children].sort(cmp).slice(0, beamWidth)
  }
  return pool
}

/**
 * The menu: the first `topN` states of an already SORTED feasible list that
 * are each a distinct idea — see the header, A MENU OF THREE MUST BE THREE IDEAS.
 */
export function pickDistinct<S extends PlanScore>(feasible: readonly State<S>[], topN: number): State<S>[] {
  const chosen: State<S>[] = []
  const seenBooks = new Set<string>()
  // Key sets already REPRESENTED on the menu — whether they were chosen or
  // skipped as a spelling of something chosen. Both count, because the
  // superset test below is transitive through a duplicate: if "buy back the
  // 830" was skipped for being "close the 830" in two legs, then "buy back
  // the 830 and a ₹2 wing" is still the menu's first row plus decoration.
  const seenSets: Set<string>[] = []
  for (const st of feasible) {
    if (chosen.length >= topN) break
    const keys = new Set(st.key === '' ? [] : st.key.split(';'))
    // A plan that is one already on the menu PLUS more legs is not a second
    // idea. It ranked lower, which by this goal's own objective means the
    // extra legs did not help — and a menu of "close the loser", "close the
    // loser and buy a ₹100 wing", "close the loser and buy a different ₹100
    // wing" reads as three options where there is one.
    const decorates = seenSets.some(
      (prev) => keys.size > prev.size && [...prev].every((k) => keys.has(k)),
    )
    if (decorates || seenBooks.has(st.scored.bookKey)) {
      seenSets.push(keys)
      continue
    }
    seenBooks.add(st.scored.bookKey)
    seenSets.push(keys)
    chosen.push(st)
  }
  return chosen
}

/**
 * Search a book for repairs, four goals at a time.
 *
 * Returns the plans for every goal in one flat array — `RepairPlan.goal` says
 * which — in goal order, and within a goal the ranked proposals followed by the
 * do-nothing baseline they are ranked against. `plans[0]` of a goal is always
 * the best thing to do; when nothing helps, the baseline stands alone carrying
 * `no-feasible-plan`, because "do nothing" IS then the answer.
 */
export function searchRepairs(ctx: RepairContext, opts?: SearchOptions): readonly RepairPlan[] {
  try {
    const maxMoves = clampInt(opts?.maxMoves, DEFAULT_MAX_MOVES, 0, 8)
    const topN = clampInt(opts?.topN, DEFAULT_TOP_N, 0, 50)
    const beamWidth = clampInt(opts?.beamWidth, DEFAULT_BEAM_WIDTH, 1, 64)

    const rawLegs = ctx?.legs
    const legs = (Array.isArray(rawLegs) ? rawLegs : []).filter(
      (l): l is PayoffLeg => l !== null && typeof l === 'object',
    )
    // The shipped policy under whatever the caller actually sent. A missing lot
    // size is 0, not a guess: `candidates.ts` then proposes no opens at all,
    // which is the right refusal — there is no honest default number of shares
    // in a lot, and a plan quietly sized in single shares is worse than none.
    const given = (ctx?.dials ?? {}) as Partial<RepairDials>
    const dials: RepairDials = { ...DEFAULT_REPAIR_DIALS, ...given, lotSize: num(given.lotSize) }
    const strikes = Array.isArray(ctx?.strikes) ? ctx.strikes : []
    const priceOf = guard(ctx?.priceOf)
    const ivOf = guard(ctx?.ivOf)
    const future = num(ctx?.future)
    const today = typeof ctx?.today === 'string' ? ctx.today : ''
    const expiry = typeof ctx?.expiry === 'string' ? ctx.expiry : ''
    const realised = num(ctx?.realised)
    const triggers = ctx?.triggers ?? null

    const marginBefore = num(spanLiteMargin(legs, future, today).total)
    const base: ScoreBase = { legs, future, today, expiry, realised, priceOf, ivOf, marginBefore, futureMark: future }

    // ---- the scorer, memoized on the move-set key ------------------------
    //
    // Four goals walk overlapping regions of the same space over the same book;
    // without this the identical candidate is priced through a 121-point surface
    // and a 21-scenario margin grid once per goal that reaches it.
    const memo = new Map<string, Scored>()
    const scoreOf = (moves: readonly Move[], key: string): Scored => {
      const hit = memo.get(key)
      if (hit !== undefined) return hit
      const out = scoreBook(base, moves).scored
      memo.set(key, out)
      return out
    }

    // ---- the baseline, and the budgets it sets ---------------------------
    //
    // IF THE DO-NOTHING BOOK CANNOT BE PRICED, NOTHING CAN. Every figure below
    // is derived from it — the hedge budget from its credit, the tail cap from
    // its floor, `degrades-floor` and MAX-CREDIT-SAFE's whole constraint from
    // its floor again — so scoring on a zeroed baseline would not degrade the
    // answer, it would invert it: an unusable future or a date that is not ISO
    // gives every plan a floor of 0, which beats every real book's, and the
    // panel would show four confident menus computed from nothing. This is
    // ALSO the validation of `future`, `today` and `expiry`, done by the one
    // parser that already owns it (`buildSurface`) rather than by a fifth copy
    // of `isoDayMs` in this package that could drift from the other four.
    const baseline = scoreOf([], '')
    if (!baseline.ok) return baselinesOnly()

    const openCredit = Math.max(0, baseline.netCredit)
    const hedgeBudget = Math.max(0, num(dials.hedgeBudgetFrac)) * openCredit
    const maxMarginAdd = finite(dials.maxMarginAdd)
    const baselineFloor = baseline.score.maxLoss
    // A CAP MAY NEVER BE LOOSER THAN DOING NOTHING. Left unclamped, the default
    // manufactures a loss allowance out of a PROFIT: a book floored at +₹40,000
    // gets `0.5 · |floor|` = ₹20,000 and CHEAP-TAIL-CAP then certifies a plan
    // that turns +₹40,000 into −₹12,000 as "capped". `max(0, −floor)` is the
    // loss the book already runs — zero when it runs none — and the cap is the
    // tighter of the two. (An explicitly requested cap is clamped the same way,
    // because the goal's promise is about the tail and not about where the
    // number came from. The residual — a plan that stays profitable but less so
    // — is what `degrades-floor` is for.)
    const requestedCap = finite(ctx?.tailCapRupees) ?? 0.5 * Math.abs(baselineFloor)
    const tailCap = Math.max(0, Math.min(requestedCap, Math.max(0, -baselineFloor)))

    const allowed = Array.isArray(opts?.ops) ? new Set(opts.ops) : null
    const universe = atomicMoves(legs, strikes, dials).filter((m) => allowed === null || allowed.has(m.op))
    const seed: State = { moves: [], last: -1, touched: new Set(), key: '', scored: baseline }

    // ---- conflict flags: what the bot is about to do to this same book ----
    const typeOfLeg = new Map<string, OptionType>()
    for (const l of legs) {
      if (l.instrument === 'option' && (l.type === 'CE' || l.type === 'PE')) {
        typeOfLeg.set(l.id, l.type)
      }
    }
    const deltaAt = new Map<string, number>()
    for (const s of strikes) {
      if (s === null || typeof s !== 'object') continue
      const d = finite(s.delta)
      const k = finite(s.strike)
      if (d === null || k === null || (s.type !== 'CE' && s.type !== 'PE')) continue
      const key = `${k}${s.type}`
      if (!deltaAt.has(key)) deltaAt.set(key, Math.abs(d))
    }
    const reshiftable = (moves: readonly Move[]): boolean => {
      if (triggers?.shiftEnabled !== true) return false
      return moves.some((m) => {
        if (m.op !== 'shift') return false
        const t = typeOfLeg.get(m.legId)
        if (t === undefined) return false
        const d = deltaAt.get(`${m.toStrike}${t}`)
        // The landing strike sits where the bot's own re-strike rule would put
        // one, and the bot's margin gate is open: it may undo this tomorrow.
        return d !== undefined && d >= num(dials.shiftDeltaMin) && d <= num(dials.shiftDeltaMax)
      })
    }
    const rebalancing = triggers?.wouldRebalance === true

    const planOf = (goal: Goal, st: State, extra: readonly string[]): RepairPlan => {
      const flags: string[] = []
      if (st.moves.length === 0) flags.push('baseline')
      for (const f of extra) flags.push(f)
      // ON EVERY GOAL, not just the two that constrain the floor. Three of the
      // four objectives can rank a plan first while it leaves the book worse off
      // at the bottom — PROFITABLE-BY-EXPIRY buys width with tail by
      // construction, CHEAP-TAIL-CAP buys cheapness down to the cap, and even
      // REDUCE-LOSS does it on a WINNING book, where closing out banks slightly
      // less than the floor the position already had. Each is arguably correct
      // by its own objective and none of them is something an operator should
      // have to derive by comparing two numbers on a menu they are scrolling.
      if (st.moves.length > 0 && st.scored.score.maxLoss < baselineFloor - EPS) {
        flags.push('degrades-floor')
      }
      if (reshiftable(st.moves)) flags.push('bot-may-reshift')
      if (rebalancing) flags.push('bot-rebalance-pending')
      return { goal, moves: st.moves, score: st.scored.score, flags }
    }

    // ---- the walk, once per goal ----------------------------------------
    const out: RepairPlan[] = []
    for (const goal of GOALS) {
      const spec = specFor(goal, baseline.score, tailCap)
      const cmp = comparator(spec)

      const pool = walkBeam({
        seed,
        universe,
        maxMoves,
        beamWidth,
        scoreOf,
        // MONOTONE, so pruning here is sound: every extension only adds
        // hedges, and spend never comes back down. See the header.
        admit: (scored) => !(scored.hedgeSpend > hedgeBudget + EPS),
        touches: touchedLeg,
        cmp,
      })

      const feasible = pool.filter(
        (st) =>
          spec.feasible(st.scored.score) &&
          st.scored.hedgeSpend <= hedgeBudget + EPS &&
          (maxMarginAdd === null || st.scored.score.marginDelta <= maxMarginAdd + EPS),
      )
      feasible.sort(cmp)

      const chosen = pickDistinct(feasible, topN)

      for (const st of chosen) out.push(planOf(goal, st, []))
      // The flag says the GOAL could not be served, so it hangs off what the
      // search found and not off what the caller asked to be shown: `topN: 0` is
      // a caller who wants the baseline alone, not a book nothing can help.
      out.push(planOf(goal, seed, feasible.length === 0 ? ['no-feasible-plan'] : []))
    }
    return out
  } catch {
    // Unreachable by design, and kept because this runs behind a panel a human
    // is watching with a position on: a malformed book must cost them the
    // SUGGESTIONS, never the page.
    return baselinesOnly()
  }
}

/**
 * Four goals, four do-nothing plans, each saying it has nothing to offer.
 *
 * The answer whenever the BOOK ITSELF could not be priced — an unusable future,
 * a date that is not ISO, a leg that will not parse. The score is zeroed and the
 * `no-feasible-plan` flag is what makes that readable: a zeroed score is only
 * safe next to a flag saying it was never computed, which is exactly why the
 * search refuses to rank on one (see `searchRepairs`).
 */
function baselinesOnly(): readonly RepairPlan[] {
  return GOALS.map((goal) => ({
    goal,
    moves: [],
    score: ZERO_SCORE,
    flags: ['baseline', 'no-feasible-plan'],
  }))
}
