/**
 * The adjustment tools (spec §6.2): the model turns the trader's words into
 * trades or an objective; the engines do every number (R2).
 *
 *   search_adjustments  the objective search (Lane 1's searchPlans) in the repair
 *                       workers → a plans card; a search under R10's cap of 3.
 *   neutralize_delta    the exact futures lots (To Neutralize) ALWAYS, beside the
 *                       searched option plans → a neutralize card.
 *   evaluate_adjustment the trader's own idea, scored exactly as the search scores
 *                       a plan (scorePlan) → an evaluation card. It may close a
 *                       leg the trader names: that is their idea, not a proposal.
 *   scenario_grid       a small P&L/delta grid (≤ 9 × 5) of the book or a plan.
 *
 * Closing in a SEARCH needs the request's allowClose (R6): the model's
 * objective can name 'close' and `normaliseObjective` strips it, and
 * `searchPlans` asks for the request's flag again. Legs are named by alias;
 * the untouchable list is mapped back to leg ids here, and the offset leg is
 * always untouchable.
 */

import { z } from 'zod'
import { isTradingDay } from '@algomaker/desk-engine'
import {
  normaliseObjective, OBJECTIVE_PRESETS, PLAN_METRICS, PRESET_IDS, scorePlan, type Move, type ObjectiveSpec, type PlanMetrics, type PresetId,
} from '@algomaker/payoff'
import { parseAnalysisQuery, toNeutralize } from '../../analytics/analysis.ts'
import { liveExpiryFrom } from '../../analytics/near-expiry.ts'
import { nearestFutureWithExpiry } from '../../market/master.ts'
import { istDate } from '../../routes/kit.ts'
import type { BookView } from '../../types.ts'
import {
  baselineOf, bookPlanBase, buildPlan, cardMetrics, isIndicative, plansCardOf, pricedOn, searchInPool, specFromPresets, withOffsetUntouchable, type BookPlanBase,
} from '../planning.ts'
import type { CachedPlan } from './plans.ts'
import { resolveView, viewChoiceOf, viewChoiceSchema } from '../view.ts'
import type { AssistantCard, CardMetrics, PlanCard } from '../wire.ts'
import { noBook, stockOf } from './book.ts'
import { envelope, r2, r4, safeWarnings, ToolRefusal, type AgentTool, type ToolCtx } from './ctx.ts'

const DAY_MS = 86_400_000
const METRIC = z.enum(PLAN_METRICS as readonly [string, ...string[]])
const PRESET = z.enum(PRESET_IDS as readonly [string, ...string[]])

async function baseOf(ctx: ToolCtx, stock: string): Promise<BookPlanBase> {
  const b = await bookPlanBase(ctx.deps, ctx.trader, stock, ctx.deps.now())
  if ('noBook' in b) throw noBook(stock)
  if ('blocked' in b) throw new ToolRefusal(b.blocked)
  return b
}

async function viewFor(ctx: ToolCtx, stock: string, given: z.infer<typeof viewChoiceSchema> | undefined): Promise<{ view: Awaited<ReturnType<typeof resolveView>> }> {
  return { view: await resolveView(ctx.deps, stock, viewChoiceOf(given) ?? ctx.view, ctx.deps.now()) }
}

/** The model's leg aliases as leg ids; an alias this conversation never handed out is refused. */
function untouchableIds(ctx: ToolCtx, aliases: readonly string[]): string[] {
  return aliases.map((a) => {
    const key = ctx.aliases.keyOf(a)
    if (key === null) throw new ToolRefusal(`no leg ${a} in this conversation: read the book first (get_book) and use its leg aliases`)
    return key
  })
}

/** The model-facing view of a plans or neutralize card's plans: the card's own numbers, no moves (they name legs by key). */
const planRows = (plans: readonly PlanCard[]): unknown[] =>
  plans.map((p) => ({ planId: p.planId, rank: p.rank, lines: p.lines, after: p.after, change: p.change, flags: p.flags, binding: p.binding }))

// ---------------------------------------------------------------- search_adjustments

const objectiveSchema = z.object({
  primary: z.object({ metric: METRIC, dir: z.enum(['min', 'max']).optional() }).strict(),
  hard: z.array(z.object({
    metric: METRIC, op: z.enum(['<=', '>=']), value: z.number().finite(), unit: z.enum(['abs', 'pctOfNow', 'changeFromNow']),
  }).strict()).max(8).optional(),
  keep: z.array(z.object({ metric: METRIC, tolerancePct: z.number().min(0).max(100) }).strict()).max(8).optional(),
  rules: z.object({
    ops: z.array(z.enum(['add', 'hedge', 'shift', 'future', 'close'])).max(5).optional(),
    maxMoves: z.number().int().min(1).max(4).optional(),
    maxLotsPerMove: z.number().int().min(1).max(5).optional(),
    maxMarginAddPct: z.number().min(0).max(100).optional(),
    floorGuard: z.object({ maxLossWorsenPct: z.number().min(0).max(25), shockWorsenPct: z.number().min(0).max(25) }).strict().optional(),
    untouchable: z.array(z.string().max(8)).max(20).optional().describe('leg aliases (L1…) no plan may shift or close'),
    maxDebit: z.number().positive().optional(),
  }).strict().optional(),
  pareto: z.tuple([METRIC, METRIC]).optional(),
}).strict()

const searchInput = z.object({
  stock: z.string().min(1).max(20),
  objective: objectiveSchema.optional().describe('one primary metric to rank on, hard constraints, keep-no-worse guards and rules; or give presets'),
  presets: z.array(PRESET).min(1).max(4).optional().describe('goal chips: the first ranks, the rest are kept no worse'),
  view: viewChoiceSchema.optional().describe('the market view behind EV/CVaR: implied, hv20, { shiftPts } or { annual } (decimal); default the page\'s'),
  topN: z.number().int().min(1).max(5).optional(),
}).strict()

export const searchAdjustments: AgentTool<z.infer<typeof searchInput>> = {
  name: 'search_adjustments',
  description: 'The objective search: ranked plans (add, hedge, shift, future; close only if the trader allowed it on the page) that best meet ONE goal under '
    + 'constraints, with the do-nothing baseline. Every plan keeps max loss and the ±5/±10% shock no worse than now (unless relaxed ≤ 25%) and margin up ≤ 10% by default. '
    + 'metrics: margin, pop (percent), ev and cvar (need a view), maxLoss, worstShock, absDelta, delta0Gap, gamma, vega, absVega, theta, credit. '
    + 'Give an objective or preset ids. Plans get ids (P1…) for compare_plans and scenario_grid. Counts as a search (3 a turn).',
  input: searchInput,
  label: (i) => `searching ${i.stock.toUpperCase()}`,
  search: true,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const base = await baseOf(ctx, stock)
    const { view } = await viewFor(ctx, stock, input.view)
    if ('error' in view) throw new ToolRefusal(view.error)
    let spec: ObjectiveSpec
    let title: string
    if (input.objective !== undefined) {
      const raw = JSON.parse(JSON.stringify(input.objective)) as Record<string, unknown>
      const rules = (raw['rules'] ?? {}) as Record<string, unknown>
      raw['rules'] = { ...rules, untouchable: untouchableIds(ctx, (rules['untouchable'] as string[] | undefined) ?? []) }
      const n = normaliseObjective({ ...withOffsetUntouchable(raw), view: view.view }, ctx.allowClose)
      if ('error' in n) throw new ToolRefusal(n.error)
      spec = n.spec
      title = `${stock}: your objective`
    } else {
      const ids = (input.presets ?? ctx.presets) as readonly PresetId[]
      if (ids.length === 0) throw new ToolRefusal('give an objective or at least one preset id')
      const n = specFromPresets(ids, view.view, ctx.allowClose)
      if ('error' in n) throw new ToolRefusal(n.error)
      spec = n.spec
      title = `${stock}: ${OBJECTIVE_PRESETS[ids[0] as PresetId].label}`
    }
    const out = await searchInPool(ctx.deps, ctx.trader, base, spec, ctx.allowClose, input.topN ?? 3)
    if ('busyMs' in out) throw new ToolRefusal(`the search workers are busy; it can be asked again in ${Math.ceil(out.busyMs / 1000)} s`)
    const r = out.result
    const env = envelope(ctx, { asOf: base.view.asOf, closed: base.closed, warnings: base.warnings })
    if (r.refused !== null) return { result: { ...env, stock, refused: r.refused, plans: [] }, summary: `${stock}: refused — ${r.refused}` }
    const { card, planIds } = await plansCardOf(ctx.deps, ctx.trader, base, pricedOn(stock, out.job), r, {
      cardId: ctx.nextCardId(), title, viewLabel: view.label, nextId: (p: Omit<CachedPlan, 'id'>) => ctx.plans.add(p).id, at: ctx.deps.now(),
    })
    return {
      result: {
        ...env, stock, refused: null, objective: card.objective, view: view.label, indicative: card.indicative,
        units: { money: 'rupees', pop: 'percent', delta: 'shares', gamma: 'shares per rupee', vega: 'rupees per vol point', theta: 'rupees a day' },
        baseline: card.baseline, plans: planRows(card.plans),
        pareto: r.pareto.flatMap((k) => planIds.get(k) ?? []), rejected: r.rejected,
        note: card.plans.length === 0 ? 'no plan meets the goal under the rules: doing nothing is the answer' : undefined,
      },
      cards: [card],
      summary: `${stock}: ${card.plans.length} ${card.plans.length === 1 ? 'plan' : 'plans'}`,
    }
  },
}

// ---------------------------------------------------------------- neutralize_delta

const neutralizeInput = z.object({
  stock: z.string().min(1).max(20),
  target: z.enum(['zero', 'band', 'delta0']).optional().describe("zero: flat delta; band: back inside the delta band; delta0: Δ0 back on the future. Default zero"),
  prefer: z.enum(['futures', 'options', 'either']).optional().describe('futures: the exact futures lots only; options: option plans only; either (default): both'),
  view: viewChoiceSchema.optional(),
}).strict()

/**
 * The futures route: the lots that take the book to its target, sized from the book's delta and the nearest
 * future's own lot (`toNeutralize`, the Analysis window's figure, which needs no spot), or — for the band — the
 * band chip's own reading (`outByLots` past the band). Priced at the side the trade crosses: the bid for a sell,
 * the ask for a buy, else the mark, and said. Null, with a warning, whenever no figure stands behind the lots.
 */
async function futuresRoute(ctx: ToolCtx, stock: string, target: 'zero' | 'band' | 'delta0', nowMs: number) {
  const params = parseAnalysisQuery(new URLSearchParams())
  if ('error' in params) throw new Error(params.error)
  const [a, view] = await Promise.all([ctx.deps.analysisOf(ctx.trader, stock, params, nowMs), ctx.deps.bookView(ctx.trader, stock, nowMs)])
  if (a === null || view === null) throw noBook(stock)
  const warnings: string[] = []
  // the book's delta as get_book reads it (each month off its own forward: no spot needed); a live option leg with no
  // vol, or one the master does not know, leaves it unknown — and then no lots are claimed
  const live = liveExpiryFrom(nowMs)
  const unpriced = view.legs.filter((l) => l.instrument === 'option' && l.expiry >= live && (!l.matched || l.iv === null)).length
  const delta = view.totals.delta
  const nf = nearestFutureWithExpiry(ctx.deps.master(), stock, istDate(nowMs))
  const lot = nf?.ref.lotSize ?? 0
  type Route = { readonly lots: number; readonly side: 'BUY' | 'SELL'; readonly expiry: string; readonly price: number | null }
  let futures: Route | null = null
  let priced: { readonly priceSide: 'bid' | 'ask' | 'mark' | null; readonly stale: boolean } = { priceSide: null, stale: false }
  let text: string | null = null
  if (nf === null || !(lot > 0)) {
    warnings.push(`no futures route: ${stock} lists no future with a lot size`)
  } else if (unpriced > 0) {
    warnings.push(`no futures route: the book's delta is not fully priced (${unpriced} option ${unpriced === 1 ? 'leg' : 'legs'} without a vol or a known contract)`)
  } else {
    let lots: number | null
    let side: 'BUY' | 'SELL'
    if (target === 'band') {
      const band = await ctx.deps.risk.band(ctx.trader, stock, nowMs)
      if (band === null || band.state === 'unknown' || band.netDelta === null) {
        lots = null
        side = delta > 0 ? 'SELL' : 'BUY'
        warnings.push(`no futures route to the band: ${band?.sentence ?? 'the band is not read yet'}`)
      } else {
        // the band chip's own figures: in band = nothing to trade; out = its lots past the band
        lots = band.state === 'out' ? band.outByLots : 0
        side = band.netDelta > 0 ? 'SELL' : 'BUY'
        text = band.sentence
      }
    } else {
      const tn = toNeutralize(delta, stock, nf.expiry, lot)
      lots = Math.abs(tn.lots)
      side = tn.side === 'Buy' ? 'BUY' : tn.side === 'Sell' ? 'SELL' : delta > 0 ? 'SELL' : 'BUY'
      text = tn.text
    }
    if (lots !== null) {
      const token = nf.ref.instrumentToken
      const q = token === undefined ? null : ctx.deps.quotes.quote(token)
      const crossing = side === 'SELL' ? q?.bid ?? null : q?.ask ?? null
      const price = crossing !== null && crossing > 0 ? crossing : q !== null && q.price > 0 ? q.price : null
      const stale = q === null || q.stale === true || !ctx.deps.quotes.feedAlive()
      priced = { priceSide: price === null ? null : crossing !== null && crossing > 0 ? (side === 'SELL' ? 'bid' : 'ask') : 'mark', stale }
      if (price === null) warnings.push(`no price for the ${nf.expiry} future yet`)
      else if (priced.priceSide === 'mark') warnings.push(`the ${nf.expiry} future has no two-sided quote: priced at its last price`)
      if (stale && price !== null) warnings.push(`the ${nf.expiry} future's price is not live`)
      futures = { lots, side, expiry: nf.expiry, price: r2(price) }
    }
  }
  return { a, view, delta, lot, futures, priced, text, warnings }
}

/**
 * The baseline of a book the search cannot price: its own payoff summary — open legs only, every month — with every
 * live series' booked P&L added to the run-level figures, so it is on the series basis as a searched baseline is,
 * whether the search ran, was busy or failed. POP stays the open legs'.
 */
export function payoffBaseline(view: BookView, delta: number, lot: number): CardMetrics {
  const s = view.payoff?.summary ?? null
  const booked = view.seriesTotal?.booked ?? 0
  const run = (x: number | undefined): number => r2(x === undefined ? null : x + booked) ?? 0
  return {
    margin: null, pop: s === null ? null : r2(s.pop * 100), ev: null, maxLoss: run(s?.maxLoss), worstShock: run(s?.worstShock),
    deltaShares: r2(delta) ?? 0, deltaLots: lot > 0 ? r2(delta / lot) : null, delta0Gap: null,
    gamma: r4(view.totals.gamma) ?? 0, vega: r2(view.totals.vega) ?? 0, theta: r2(view.totals.theta) ?? 0, credit: 0, charges: null,
    marginSource: 'span-lite', marginPartial: false,
  }
}

export const neutralizeDelta: AgentTool<z.infer<typeof neutralizeInput>> = {
  name: 'neutralize_delta',
  description: 'How to take the book\'s delta off: the futures lots that take it to the target (sized from its delta and the future\'s lot; adds no gamma, vega or theta) always, '
    + 'and option plans from the objective search (they change gamma, vega and theta) unless prefer is futures. Shows delta in shares and lots, Δ0 and spot. Counts as a search.',
  input: neutralizeInput,
  label: (i) => `neutralizing ${i.stock.toUpperCase()}`,
  search: true,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const nowMs = ctx.deps.now()
    const target = input.target ?? 'zero'
    const prefer = input.prefer ?? 'either'
    const f = await futuresRoute(ctx, stock, target, nowMs)
    const { view } = await viewFor(ctx, stock, input.view)
    if ('error' in view) throw new ToolRefusal(view.error)
    const b = await bookPlanBase(ctx.deps, ctx.trader, stock, nowMs)
    if ('noBook' in b) throw noBook(stock)
    const base = 'blocked' in b ? null : b
    const warnings: string[] = [...f.warnings]
    if (base === null) warnings.push(`no option plans: ${(b as { blocked: string }).blocked}`)
    let plans: PlanCard[] = []
    let baseline: CardMetrics | null = base === null ? null : baselineOf(base, view.view)
    if (base !== null && prefer !== 'futures') {
      const ops = prefer === 'options' ? ['add', 'hedge', 'shift', ...(ctx.allowClose ? ['close'] : [])] : undefined
      const n = specFromPresets([target === 'delta0' ? 'recentre-delta0' : 'neutralize-delta'], view.view, ctx.allowClose, ops)
      if ('error' in n) throw new ToolRefusal(n.error)
      // a search that fails still leaves the futures route standing
      try {
        const out = await searchInPool(ctx.deps, ctx.trader, base, n.spec, ctx.allowClose, 3)
        if ('busyMs' in out) warnings.push(`the search workers were busy: no option plans this time (ask again in ${Math.ceil(out.busyMs / 1000)} s)`)
        else if (out.result.refused !== null) warnings.push(`no option plans: ${out.result.refused}`)
        else {
          const built = await plansCardOf(ctx.deps, ctx.trader, base, pricedOn(stock, out.job), out.result, {
            cardId: '', title: `${stock}: neutralize`, viewLabel: view.label, nextId: (p: Omit<CachedPlan, 'id'>) => ctx.plans.add(p).id, at: nowMs,
          })
          plans = [...built.card.plans]
          baseline = built.card.baseline
        }
      } catch (e) {
        ctx.deps.log('neutralize search failed', { stock, error: e instanceof Error ? e.message : String(e) })
        warnings.push('the option search failed: only the futures route this time')
      }
    }
    // a book the search cannot price (futures and shares only) still has a baseline
    baseline ??= payoffBaseline(f.view, f.delta, f.lot)
    const indicative = (base === null ? f.a.closed || !ctx.deps.quotes.feedAlive() : isIndicative(base, plans.flatMap((p) => p.flags)))
      || f.priced.stale || f.priced.priceSide === 'mark'
    const card: AssistantCard = {
      kind: 'neutralize', id: ctx.nextCardId(), stock, deltaShares: r2(f.delta) ?? 0, deltaLots: f.lot > 0 ? r2(f.delta / f.lot) : null,
      futures: f.futures, delta0: r2(f.a.toNeutralize?.price ?? null), spot: r2(f.view.spot), plans, baseline, indicative,
    }
    return {
      result: {
        ...envelope(ctx, { asOf: f.a.asOf, closed: f.a.closed, warnings: [...safeWarnings(f.a.warnings), ...warnings] }),
        stock, target, prefer, deltaShares: card.deltaShares, deltaLots: card.deltaLots, delta0: card.delta0, spot: card.spot,
        futures: f.futures === null ? null : { ...f.futures, ...f.priced, sizedBy: f.text, note: 'adds no gamma, vega or theta' },
        baseline, plans: planRows(plans), indicative,
      },
      cards: [card],
      summary: `${stock}: ${f.futures === null ? 'no futures route' : `${f.futures.side} ${f.futures.lots} fut lots`}, ${plans.length} option plans`,
    }
  },
}

// ---------------------------------------------------------------- evaluate_adjustment

const trade = z.union([
  z.object({
    do: z.enum(['buy', 'sell']), what: z.enum(['CE', 'PE', 'FUT']), strike: z.number().positive().optional().describe('options only'),
    lots: z.number().int().min(1).max(20),
  }).strict(),
  z.object({ do: z.literal('close'), leg: z.string().max(8).describe('leg alias, e.g. L3') }).strict(),
  z.object({ do: z.literal('shift'), leg: z.string().max(8), toStrike: z.number().positive() }).strict(),
])

const evaluateInput = z.object({
  stock: z.string().min(1).max(20),
  trades: z.array(trade).min(1).max(4).describe("the trader's idea, in the book's near expiry: buy/sell CE, PE or FUT in lots; close or shift a leg by alias"),
  view: viewChoiceSchema.optional(),
}).strict()

/** The trader's trades as moves on the base; a refusal names what does not fit. */
function movesOf(ctx: ToolCtx, base: BookPlanBase, trades: z.infer<typeof evaluateInput>['trades']): Move[] {
  const lot = base.job.lotSize
  const strikes = new Set(base.job.chain.strikes.map((s) => s.strike))
  return trades.map((t): Move => {
    if ('what' in t) {
      if (lot <= 0) throw new ToolRefusal(`no lot size for ${base.stock} ${base.job.chain.expiry}`)
      const qty = (t.do === 'sell' ? -1 : 1) * t.lots * lot
      if (t.what === 'FUT') {
        if (base.job.futureMark === null) throw new ToolRefusal(`no live price for the ${base.job.chain.expiry} future`)
        return { op: 'future', qty }
      }
      if (t.strike === undefined || !strikes.has(t.strike)) throw new ToolRefusal(`${t.strike ?? 'no strike'} ${t.what} is not quoted on the ${base.job.chain.expiry} chain`)
      return { op: t.do === 'sell' ? 'add' : 'hedge', strike: t.strike, type: t.what, qty }
    }
    const key = ctx.aliases.keyOf(t.leg)
    if (key === null) throw new ToolRefusal(`no leg ${t.leg} in this conversation: read the book first (get_book)`)
    const leg = base.ctx.legs.find((l) => l.id === key)
    if (leg === undefined) throw new ToolRefusal(`${t.leg} is not in the ${base.job.chain.expiry} expiry the evaluation prices; other expiries are held fixed`)
    const notAsked = closeNotAsked(ctx, t.leg, { strike: leg.strike, type: leg.type })
    if (notAsked !== null) throw new ToolRefusal(notAsked)
    return t.do === 'close' ? { op: 'close', legId: key } : { op: 'shift', legId: key, toStrike: t.toStrike }
  })
}

/**
 * The words a trader uses to take a position off (R6). "cut" and "book" only as they mean it — cut a loss or a
 * position, book a profit — never "cut margin" or "my TCS book".
 */
const CLOSE_WORDS = new RegExp([
  '\\b(close|closing|exit|exiting|square[\\s-]?off|squaring[\\s-]?off)\\b',
  '\\bcut\\s+(the\\s+|my\\s+|our\\s+)?(loss|losses|position|positions|leg|legs|it|them|this|that)\\b',
  '\\bbook\\s+(the\\s+|my\\s+|some\\s+)?(profit|profits|loss|losses|gain|gains|it|them|this|that)\\b',
].join('|'), 'i')

/**
 * R6 in code: without the page's "Allow closing legs", a close or a shift is evaluated only when it is the
 * trader's own idea — their message names the leg (its alias, or its strike with CE/PE, call or put) or says to
 * take something off. Null when it may run, else the reason.
 */
export function closeNotAsked(ctx: Pick<ToolCtx, 'allowClose' | 'userText'>, alias: string, leg: { readonly strike: number | null; readonly type: 'CE' | 'PE' | null } | undefined): string | null {
  if (ctx.allowClose) return null
  const text = ctx.userText
  if (CLOSE_WORDS.test(text)) return null
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\b${esc(alias.trim())}\\b`, 'i').test(text)) return null
  if (leg !== undefined && leg.strike !== null && leg.type !== null) {
    const kind = leg.type === 'CE' ? '(ce|call|calls)' : '(pe|put|puts)'
    if (new RegExp(`\\b${esc(String(leg.strike))}\\s*${kind}\\b`, 'i').test(text)) return null
  }
  return `closing or shifting ${alias.toUpperCase()} is not the trader's idea: their message does not name that leg or ask to close, `
    + 'and "Allow closing legs" is off on the page — ask the trader first'
}

const EPS = 1e-6

/** The flags a scored idea earns, in PlanFlag's order. */
function ideaFlags(base: BookPlanBase, moves: readonly Move[], after: PlanMetrics, before: PlanMetrics, viewBased: boolean): string[] {
  const flags: string[] = []
  if (after.maxLoss < before.maxLoss - EPS || after.worstShock < before.worstShock - EPS) flags.push('degrades-floor')
  if (after.margin > before.margin + EPS) flags.push('margin-up')
  const live = (k: number, t: 'CE' | 'PE'): boolean => base.job.quotes.some((q) => q.strike === k && q.type === t && !q.stale && q.bid !== null && q.ask !== null && q.bid > 0 && q.ask >= q.bid)
  const touched = moves.flatMap((m) => {
    if (m.op === 'add' || m.op === 'hedge') return [[m.strike, m.type] as const]
    if (m.op === 'future') return []
    const leg = base.ctx.legs.find((l) => l.id === m.legId)
    if (leg === undefined || leg.strike === null || leg.type === null) return []
    return m.op === 'shift' ? [[leg.strike, leg.type] as const, [m.toStrike, leg.type] as const] : [[leg.strike, leg.type] as const]
  })
  if (touched.some(([k, t]) => !live(k, t))) flags.push('indicative-price')
  if (viewBased) flags.push('view-based')
  return flags
}

export const evaluateAdjustment: AgentTool<z.infer<typeof evaluateInput>> = {
  name: 'evaluate_adjustment',
  description: "What-if of the trader's own idea, scored exactly as the search scores a plan: before, after and change of margin (NSE SPAN), POP, EV/CVaR (with a view), "
    + 'max loss, worst shock, delta (shares, lots), Δ0 gap, gamma, vega, theta, credit and charges; the trades as lines and Scenario rows; a plan id. '
    + 'It may close or shift a leg only when the trader\'s message names that leg or asks to close (their idea, not a proposal), or the page allows closing.',
  input: evaluateInput,
  label: (i) => `evaluating ${i.stock.toUpperCase()}`,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const base = await baseOf(ctx, stock)
    const { view } = await viewFor(ctx, stock, input.view)
    if ('error' in view) throw new ToolRefusal(view.error)
    const moves = movesOf(ctx, base, input.trades)
    const before = scorePlan(base.ctx, [], view.view)
    const after = scorePlan(base.ctx, moves, view.view)
    if (before === null) throw new ToolRefusal(`${stock}'s book cannot be priced on the ${base.job.chain.expiry} chain`)
    if (after === null) throw new ToolRefusal('a trade did not land: no price on the chain for one of them, or no future price — nothing was evaluated')
    const baseline = cardMetrics(before, base.job.lotSize, 0, base.job.span !== null)
    const flags = ideaFlags(base, moves, after, before, view.view !== null)
    const built = await buildPlan(ctx.deps, ctx.trader, base, {
      planId: '', rank: 1, moves, metrics: after, baseline, flags, binding: [], title: `${stock}: your idea`, source: 'evaluation', at: ctx.deps.now(),
    })
    const planId = ctx.plans.add(built.cache).id
    const plan: PlanCard = { ...built.card, planId }
    const card: AssistantCard = { kind: 'evaluation', id: ctx.nextCardId(), stock, title: 'Your idea', indicative: isIndicative(base, flags), plan, baseline }
    return {
      result: {
        ...envelope(ctx, { asOf: base.view.asOf, closed: base.closed, warnings: base.warnings }),
        stock, view: view.label, indicative: card.indicative, note: "the trader's own idea, evaluated — not a proposal",
        baseline, plan: planRows([plan])[0],
      },
      cards: [card],
      summary: `${stock}: your idea is ${planId}`,
    }
  },
}

// ---------------------------------------------------------------- scenario_grid

const gridInput = z.object({
  stock: z.string().min(1).max(20),
  planId: z.string().regex(/^[Pp]\d{1,4}$/).optional().describe('a plan of this conversation, applied on top of the book'),
  stepPct: z.number().min(0.25).max(10).optional().describe('spot step between rows, percent; default 2.5'),
  steps: z.number().int().min(1).max(4).optional().describe('rows each side of spot; default 4 (9 rows)'),
  volShift: z.number().min(-20).max(20).optional().describe('vol points on every leg'),
  columns: z.number().int().min(2).max(5).optional().describe('columns: dates from today, the last one the expiry close; default 5'),
}).strict()

/** Every `n`th trading day from `from` to `to`, so that with the expiry's own close column at most `columns` are shown. */
function everyNthFor(from: string, to: string, columns: number): number {
  const dated = Math.max(1, columns - 1)
  let days = 0
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`) && days < 400; ms += DAY_MS) {
    if (isTradingDay(new Date(ms).toISOString().slice(0, 10))) days++
  }
  return Math.max(1, Math.ceil(days / dated))
}

export const scenarioGrid: AgentTool<z.infer<typeof gridInput>> = {
  name: 'scenario_grid',
  description: 'A small grid of the book (or the book with a plan on top): rows of spot ±steps × stepPct, columns of dates to the near expiry; P&L and delta in each cell, with an optional vol shift.',
  input: gridInput,
  label: (i) => `scenario ${i.stock.toUpperCase()}${i.planId === undefined ? '' : ` ${i.planId.toUpperCase()}`}`,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const nowMs = ctx.deps.now()
    const plan = input.planId === undefined ? null : ctx.plans.get(input.planId)
    if (input.planId !== undefined && plan === null) throw new ToolRefusal(`no plan ${input.planId} in this conversation`)
    if (plan !== null && plan.stock !== stock) throw new ToolRefusal(`${plan.id} is a plan for ${plan.stock}, not ${stock}`)
    const hyps = (plan?.whatIf ?? []).map((w, i) => ({ id: `h${i + 1}`, instrument: w.instrument, expiry: w.expiry, strike: w.strike, optType: w.optType, qty: w.qty, price: w.price, iv: w.iv ?? null }))
    const params = parseAnalysisQuery(new URLSearchParams())
    if ('error' in params) throw new Error(params.error)
    const a = await ctx.deps.analysisOf(ctx.trader, stock, params, nowMs)
    if (a === null) throw noBook(stock)
    const today = istDate(nowMs)
    const end = a.nearExpiry ?? today
    const v = await ctx.deps.scenarioOf(ctx.trader, stock, {
      stepPct: input.stepPct ?? 2.5, count: input.steps ?? 4, start: today, end, everyNth: everyNthFor(today, end, input.columns ?? 5),
      ...(input.volShift === undefined ? {} : { volShift: input.volShift }), ...(hyps.length === 0 ? {} : { hypothetical: hyps }),
      ...(a.spot === null ? {} : { middle: a.spot }),
    }, nowMs)
    if (v === null) throw noBook(stock)
    if ('error' in v) throw new ToolRefusal(v.error)
    const spot = v.resolved.spot
    const refused = v.hypothetical.filter((h) => !h.accepted).length
    return {
      result: {
        ...envelope(ctx, { asOf: v.asOf, closed: v.closed, warnings: [...safeWarnings(v.warnings), ...(refused > 0 ? [`${refused} of the plan's trades could not be priced and are left out`] : [])] }),
        stock, plan: plan?.id ?? null, volShift: v.resolved.volShift, units: { pnl: 'rupees', delta: 'shares' },
        spots: v.grid.spots.map((s) => r2(s)), pctFromSpot: v.grid.spots.map((s) => r2(((s - spot) / spot) * 100)), currentRow: v.grid.currentRow,
        dates: v.grid.dates,
        pnl: v.grid.cells.map((row) => row.map((c) => Math.round(c.pnl))),
        delta: v.grid.cells.map((row) => row.map((c) => r2(c.delta))),
        now: { pnl: Math.round(v.totals.pnl), delta: r2(v.totals.delta), gamma: r2(v.totals.gamma), vega: r2(v.totals.vega), theta: r2(v.totals.theta) },
      },
      summary: `${stock}: ${v.grid.spots.length} × ${v.grid.dates.length} grid`,
    }
  },
}
