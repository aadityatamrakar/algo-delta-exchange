/**
 * Adjustments on one book, the engines' way (spec §6.2, §4): the book's
 * search base, the objective search run in the repair workers, a plan scored
 * exactly as the search scores it, and the cards (§7) — shared by the
 * assistant's tools and the deterministic plan-search route, so a plan reads
 * the same from the chat and from the form.
 *
 * The base is the repair job of the book (`repairJobOf`: the near expiry's
 * options and futures, everything else as one fixed offset future) plus what
 * the objective search needs: each strike's two-sided quote (R8), the traded
 * future's mark, the lot size and the real SPAN cut to the stock. Every number
 * on a card comes from `searchPlans`/`scorePlan` (R2); `pop` is the run's
 * (`popRun`, percent), `delta0Gap` null when infinite, charges from the
 * admin's rates (`chargesFor`), and a card is `indicative` when the market is
 * shut, the feed is not live, or any fill is priced at the mark.
 *
 * Unlike a repair, the search counts what the job expiry's series already
 * booked (`realised`, from the BookView's series): max loss, the run's POP and
 * EV are the run's, money banked included (packages/payoff/src/goals.ts). A
 * view with no series (an older bag) searches on 0 and says so, as a repair.
 */

import { createHash } from 'node:crypto'
import {
  normaliseObjective, OBJECTIVE_PRESETS, planFill, presetObjective, scorePlan,
  type MarketView, type Move, type ObjectiveSpec, type PlanMetric, type PlanMetrics, type PlanSearchContext, type PlanSearchResult, type PresetId,
} from '@algomaker/payoff'
import { chargesFor, type Fill } from '../analytics/charges.ts'
import { monthQuotes } from '../analytics/month-chain.ts'
import { liveExpiryFrom } from '../analytics/near-expiry.ts'
import { planSearchContextOf, type PlanSearchJob, type PlanSearchQuote, type PlanSearchSpan } from '../analytics/plan-search-job.ts'
import { OFFSET_LEG_ID, planLines, planWhatIf, REALISED_NOT_COUNTED, repairExpiryOf, repairJobOf, type PlanLineInputs } from '../analytics/repair.ts'
import { istDate } from '../routes/kit.ts'
import type { BookView } from '../types.ts'
import type { AgentDeps } from './tools/ctx.ts'
import type { CachedPlan } from './tools/plans.ts'
import type { AssistantCard, AssistantWhatIfLeg, CardMetrics, PlanCard } from './wire.ts'

export type PlanningDeps = Pick<AgentDeps, 'bookView' | 'master' | 'quotes' | 'legs' | 'span' | 'charges' | 'repair' | 'marketContext' | 'now'>

/** What a search or a score of one book starts from. */
export interface BookPlanBase {
  readonly stock: string
  readonly view: BookView
  /** The job minus the objective: plain data for the worker. */
  readonly job: Omit<PlanSearchJob, 'spec' | 'allowClose' | 'opts'>
  /** The same context rebuilt here, for `scorePlan`. */
  readonly ctx: PlanSearchContext
  /** The trader's leg version when the book was read: part of the pool's cache key. */
  readonly version: number
  readonly closed: boolean
  /** The feed is not ticking. */
  readonly feedDead: boolean
  readonly warnings: readonly string[]
}

export type BaseResult = BookPlanBase | { readonly blocked: string } | { readonly noBook: true }

/** What replaces REALISED_NOT_COUNTED when the series' booked P&L is in the figures. */
export function bookedCounted(expiry: string, booked: number): string {
  const rupees = `${booked < 0 ? '-' : ''}₹${Math.round(Math.abs(booked)).toLocaleString('en-IN')}`
  return `P&L already booked in the ${expiry} series (${rupees}) is counted in max loss, POP and EV`
}

/** The day's SPAN cut to one stock, its exposure rate, and the book's other-expiry legs; null without a file carrying the stock. */
function spanOf(d: Pick<PlanningDeps, 'span'>, stock: string, view: BookView, expiry: string, nowMs: number): PlanSearchSpan | null {
  const cur = d.span.span()
  const c = cur?.file.commodities.get(stock)
  if (cur === null || c === undefined) return null
  const rate = d.span.exposure()?.rates.get(stock)
  // what repairJobOf holds in its offset: from the 15:40 F&O close on an expiry day that day's options are settled, a future
  // trades to the day's end
  const live = liveExpiryFrom(nowMs)
  const today = istDate(nowMs)
  const fixed = view.legs
    .filter((l) => l.matched && l.qty !== 0 && l.instrument !== 'share' && l.expiry !== expiry && l.expiry >= (l.instrument === 'option' ? live : today))
    .map((l) => ({
      symbol: stock, kind: l.instrument === 'future' ? 'future' as const : 'option' as const, expiry: l.expiry,
      strike: l.instrument === 'option' ? l.strike : null, optType: l.instrument === 'option' ? l.optType : null, qty: l.qty,
    }))
  return { symbol: stock, file: { ...cur.file, commodities: new Map([[stock, c]]) }, rates: new Map(rate === undefined ? [] : [[stock, rate]]), fixed }
}

export async function bookPlanBase(d: PlanningDeps, trader: string, stock: string, nowMs: number): Promise<BaseResult> {
  // read before the legs, as the repair route does: a write landing between the two only misses this key
  const version = d.legs.version(trader)
  const view = await d.bookView(trader, stock, nowMs)
  if (view === null) return { noBook: true }
  const expiry = repairExpiryOf(view, nowMs)
  const m = d.master()
  const month = expiry === null ? null : monthQuotes(m, d.quotes, stock, expiry, view.spot, nowMs, view.closed)
  const lotSize = expiry === null ? 0 : m.options.chain(stock, expiry)?.lotSize ?? 0
  const r = repairJobOf(view, month, lotSize, nowMs, null)
  if ('blocked' in r) return { blocked: r.blocked }
  const chain = r.job
  const quotes: PlanSearchQuote[] = chain.strikes.map((s) => {
    const token = m.options.resolve(stock, chain.expiry, s.strike, s.type)?.instrumentToken
    const q = token === undefined ? null : d.quotes.quote(token)
    return { strike: s.strike, type: s.type, bid: q?.bid ?? null, ask: q?.ask ?? null, stale: q === null || q.stale === true }
  })
  const futToken = m.options.future(stock, chain.expiry)?.instrumentToken
  const fq = futToken === undefined ? null : d.quotes.quote(futToken)
  const futureMark = fq !== null && fq.price > 0 ? fq.price : null
  const booked = view.series?.find((s) => s.expiry === chain.expiry)?.booked
  const job = {
    kind: 'plan-search' as const, chain, futureMark, lotSize, quotes, span: spanOf(d, stock, view, chain.expiry, nowMs),
    ...(booked === undefined ? {} : { realised: booked }),
  }
  const ctx = planSearchContextOf({ ...job, spec: presetObjective(['neutralize-delta'], null, false), allowClose: false })
  // nothing booked is nothing left out: the line goes
  const warnings = booked === undefined ? r.warnings
    : r.warnings.flatMap((w) => (w !== REALISED_NOT_COUNTED ? [w] : booked === 0 ? [] : [bookedCounted(chain.expiry, booked)]))
  return { stock, view, job, ctx, version, closed: view.closed, feedDead: !d.quotes.feedAlive(), warnings }
}

// ---------------------------------------------------------------- objectives

/** The objective as the model or the form gives it, untouchable legs already mapped to their ids. 'offset' is always untouchable. */
export function withOffsetUntouchable(raw: Record<string, unknown>): Record<string, unknown> {
  const rules = (typeof raw['rules'] === 'object' && raw['rules'] !== null ? raw['rules'] : {}) as Record<string, unknown>
  const u = Array.isArray(rules['untouchable']) ? rules['untouchable'].filter((x): x is string => typeof x === 'string') : []
  return { ...raw, rules: { ...rules, untouchable: [...new Set([...u, OFFSET_LEG_ID])] } }
}

/** A spec from preset chips: the first ranks, the rest keep. */
export function specFromPresets(ids: readonly PresetId[], view: MarketView | null, allowClose: boolean, ops?: readonly string[]): { spec: ObjectiveSpec } | { error: string } {
  const base = presetObjective(ids, view, allowClose)
  const raw = withOffsetUntouchable(JSON.parse(JSON.stringify(base)) as Record<string, unknown>)
  if (ops !== undefined) raw['rules'] = { ...(raw['rules'] as object), ops }
  return normaliseObjective({ ...raw, view }, allowClose)
}

const METRIC_WORDS: Readonly<Record<PlanMetric, string>> = {
  margin: 'margin', pop: 'POP', ev: 'expected value', cvar: 'the worst-5% average', maxLoss: 'max loss', worstShock: 'the worst ±5/±10% shock',
  absDelta: '|delta|', delta0Gap: 'the Δ0 gap', gamma: 'gamma', vega: 'vega', absVega: '|vega|', theta: 'theta', credit: 'credit',
}

/** The objective in one sentence, as the search ran it. */
export function objectiveSentence(spec: ObjectiveSpec): string {
  const preset = Object.values(OBJECTIVE_PRESETS).find((p) => p.metric === spec.primary.metric && p.dir === spec.primary.dir)
  const parts = [preset?.label ?? `${spec.primary.dir === 'min' ? 'Lower' : 'Raise'} ${METRIC_WORDS[spec.primary.metric]}`]
  if (spec.keep.length > 0) parts.push(`keep ${spec.keep.map((k) => `${METRIC_WORDS[k.metric]}${k.tolerancePct > 0 ? ` (within ${k.tolerancePct}%)` : ''}`).join(', ')} no worse`)
  for (const hc of spec.hard) parts.push(`${METRIC_WORDS[hc.metric]} ${hc.op} ${hc.value}${hc.unit === 'pctOfNow' ? '% of now' : hc.unit === 'changeFromNow' ? ' from now' : ''}`)
  const r = spec.rules
  parts.push(`up to ${r.maxMoves} ${r.maxMoves === 1 ? 'move' : 'moves'} of ${r.maxLotsPerMove} ${r.maxLotsPerMove === 1 ? 'lot' : 'lots'} at most (${r.ops.join(', ')})`)
  parts.push(`margin up at most ${r.maxMarginAddPct}%`)
  if (r.floorGuard.maxLossWorsenPct > 0 || r.floorGuard.shockWorsenPct > 0) {
    parts.push(`floor guard relaxed: max loss by ${r.floorGuard.maxLossWorsenPct}%, shock by ${r.floorGuard.shockWorsenPct}%`)
  } else parts.push('max loss and shock no worse than now')
  return `${parts.join('; ')}.`
}

// ---------------------------------------------------------------- the search, in the workers

/**
 * `job` is the one the plans were searched on — a cached or shared answer's is
 * the first request's, up to a minute old — so a card's lines, Scenario rows
 * and charges are priced on the very fills its figures were (`pricedOn`).
 */
export type SearchOutcome = { readonly result: PlanSearchResult; readonly cached: boolean; readonly job: PlanSearchJob } | { readonly busyMs: number }

export async function searchInPool(
  d: Pick<PlanningDeps, 'repair'>, trader: string, base: BookPlanBase, spec: ObjectiveSpec, allowClose: boolean, topN: number,
): Promise<SearchOutcome> {
  const job: PlanSearchJob = { ...base.job, spec, allowClose, opts: { topN } }
  const key = createHash('sha256').update(JSON.stringify([trader, base.stock, base.version, spec, allowClose, topN])).digest('hex')
  const answer = await d.repair.search(`${trader}|${base.stock}`, key, job)
  if ('busy' in answer) return { busyMs: answer.retryAfterMs }
  return { result: answer.result, cached: answer.cached, job: answer.job }
}

/** What plans are priced on: a book's chain, its fills and its lot, from one job. */
export interface PricedOn {
  readonly stock: string
  readonly ctx: PlanSearchContext
  readonly job: Omit<PlanSearchJob, 'spec' | 'allowClose' | 'opts'>
}

/** A search's own job, rebuilt as `routes/repair.ts` renders a shared repair answer on the job it was searched on. */
export function pricedOn(stock: string, job: PlanSearchJob): PricedOn {
  return { stock, ctx: planSearchContextOf(job), job }
}

// ---------------------------------------------------------------- cards

const fin = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null)
const fin4 = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)

/**
 * A plan's figures for a card. `spanFile`: the day's SPAN carried this stock. A SPAN-lite margin with a SPAN file
 * there is a PARTIAL one — the real SPAN could not price every contract (or the exposure rate is missing), so the
 * search fell back to the estimate rather than rank on a part-figure (`planSearchContextOf`).
 */
export function cardMetrics(m: PlanMetrics, lotSize: number, charges: number | null, spanFile: boolean): CardMetrics {
  return {
    margin: fin(m.margin), pop: fin(m.popRun), ev: fin(m.ev), maxLoss: fin(m.maxLoss) ?? 0, worstShock: fin(m.worstShock) ?? 0,
    deltaShares: fin(m.delta) ?? 0, deltaLots: lotSize > 0 ? fin(m.delta / lotSize) : null, delta0Gap: fin(m.delta0Gap),
    gamma: fin4(m.gamma) ?? 0, vega: fin(m.vega) ?? 0, theta: fin(m.theta) ?? 0, credit: fin(m.credit) ?? 0, charges: fin(charges),
    marginSource: m.marginSource, marginPartial: m.marginSource === 'span-lite' && spanFile,
  }
}

/** after − baseline, per figure both have. */
export function changeOf(after: CardMetrics, base: CardMetrics): Partial<CardMetrics> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(after) as (keyof CardMetrics)[]) {
    const a = after[k], b = base[k]
    if (typeof a === 'number' && typeof b === 'number') out[k] = Math.round((a - b) * 1e4) / 1e4
  }
  return out as Partial<CardMetrics>
}

/** What a plan's trades cost to put on, by the admin's rates; null when a trade has no price. */
export async function chargesOf(d: Pick<PlanningDeps, 'charges'>, trader: string, rows: readonly AssistantWhatIfLeg[], lotSize: number): Promise<number | null> {
  if (rows.length === 0) return 0
  if (rows.some((r) => r.price === null)) return null
  const fills: Fill[] = rows.map((r, i) => ({
    instrument: r.instrument, side: r.qty > 0 ? 'Buy' : 'Sell', qty: Math.abs(r.qty), price: r.price as number, orderNo: `p${i}`, lotSize: lotSize > 0 ? lotSize : null,
  }))
  return chargesFor(fills, await d.charges.get(), trader).total
}

export function lineInputs(on: PricedOn): PlanLineInputs {
  return {
    legs: on.ctx.legs, lotSize: on.job.lotSize, priceOf: planFill(on.ctx), futureMark: on.job.futureMark, expiry: on.job.chain.expiry, stock: on.stock,
  }
}

/** A card's numeric figures, for the plan cache (compare_plans compares numbers). */
const numbersOf = (m: CardMetrics): Record<string, number | null> =>
  Object.fromEntries(Object.entries(m).filter(([, v]) => v === null || typeof v === 'number')) as Record<string, number | null>

export interface BuiltPlan {
  readonly card: PlanCard
  readonly cache: Omit<CachedPlan, 'id'>
}

/** One plan as a card and as a cache entry, priced on `on` (the job its figures came from); `planId` comes from whoever numbers the plans. */
export async function buildPlan(
  d: Pick<PlanningDeps, 'charges'>, trader: string, on: PricedOn, o: {
    readonly planId: string; readonly rank: number; readonly moves: readonly Move[]; readonly metrics: PlanMetrics
    readonly baseline: CardMetrics; readonly flags: readonly string[]; readonly binding: readonly string[]; readonly title: string
    readonly source: CachedPlan['source']; readonly at: number
  },
): Promise<BuiltPlan> {
  const inp = lineInputs(on)
  const lines = planLines(o.moves, inp)
  const whatIf = planWhatIf(o.moves, inp)
  const after = cardMetrics(o.metrics, on.job.lotSize, await chargesOf(d, trader, whatIf, on.job.lotSize), on.job.span !== null)
  const card: PlanCard = { planId: o.planId, rank: o.rank, lines, after, change: changeOf(after, o.baseline), flags: o.flags, binding: o.binding, whatIf }
  // the search's figures count what the job expiry's series booked (`job.realised`); a job from a view with no series counts 0
  const realised = on.job.realised
  return {
    card,
    cache: {
      stock: on.stock, source: o.source, title: o.title, lines, metrics: numbersOf(after), flags: o.flags, whatIf, moves: o.moves, at: o.at,
      realisedBasis: realised ?? 0, seriesBooked: realised ?? null,
    },
  }
}

export const isIndicative = (base: BookPlanBase, flags: readonly string[]): boolean => base.closed || base.feedDead || flags.includes('indicative-price')

/** The do-nothing book, scored like a plan. */
export function baselineOf(base: BookPlanBase, view: MarketView | null): CardMetrics | null {
  const m = scorePlan(base.ctx, [], view)
  return m === null ? null : cardMetrics(m, base.job.lotSize, 0, base.job.span !== null)
}

/**
 * A search's ranked plans as a plans card, priced on `on` — the job the search ran on — while `base` (now) says
 * whether the card is indicative. `nextId` numbers the plans (the conversation's plan cache, or the route's own).
 */
export async function plansCardOf(
  d: Pick<PlanningDeps, 'charges'>, trader: string, base: BookPlanBase, on: PricedOn, r: PlanSearchResult, o: {
    readonly cardId: string; readonly title: string; readonly viewLabel: string | null; readonly nextId: (plan: Omit<CachedPlan, 'id'>) => string; readonly at: number
  },
): Promise<{ readonly card: Extract<AssistantCard, { kind: 'plans' }>; readonly planIds: ReadonlyMap<string, string> }> {
  const baseline = cardMetrics(r.baseline, on.job.lotSize, 0, on.job.span !== null)
  const plans: PlanCard[] = []
  const planIds = new Map<string, string>()
  for (const p of r.plans) {
    if (p.rank === 0 || p.key === 'baseline') continue
    const built = await buildPlan(d, trader, on, {
      planId: '', rank: p.rank, moves: p.moves, metrics: p.metrics, baseline, flags: p.flags, binding: p.binding, title: o.title, source: 'search', at: o.at,
    })
    const id = o.nextId(built.cache)
    planIds.set(p.key, id)
    plans.push({ ...built.card, planId: id })
  }
  const flags = plans.flatMap((p) => p.flags)
  return {
    card: {
      kind: 'plans', id: o.cardId, stock: base.stock, title: o.title, objective: objectiveSentence(r.spec), view: o.viewLabel,
      indicative: isIndicative(base, flags), baseline, plans, rejected: r.rejected,
    },
    planIds,
  }
}
