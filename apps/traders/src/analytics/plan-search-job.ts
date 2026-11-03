/**
 * A plan search (the objective search, spec §4) as plain data, so it crosses
 * to a repair worker thread and runs in the same two slots, under the same
 * 30 s limit, as a repair search (R10). The job carries the book and its
 * chain exactly as a `RepairJob` does (`repairJobOf`), the traded future's
 * mark and the lot size for 'future' moves, each contract's two-sided quote
 * for the liquidity rule (R8), the normalised objective, the request's own
 * `allowClose` (R6: `searchPlans` asks for it again, never trusting the spec),
 * and the real SPAN: the day's file cut to this one stock (its `commodities`
 * Map clones), that stock's exposure rate, and the book's legs outside the
 * job's expiry as fixed positions. It also carries what the job's expiry
 * series already booked (`realised`): the run-level figures count it
 * (goals.ts doctrine), which a repair job does not.
 *
 * `planSearchContextOf` rebuilds the `PlanSearchContext` from the job alone —
 * in the worker for a search, on the main thread for `scorePlan` — the way
 * `runRepairJob` rebuilds a repair's lookups: `priceOf`/`ivOf` from
 * `lookupsOf`, `quoteOf` from a map keyed `${strike}|${type}`, and `marginOf`
 * as the real SPAN of the plan's legs (the offset leg left out: it stands for
 * the fixed positions) plus the fixed positions.
 */

import type { OptionType } from '@algomaker/greeks'
import type { ObjectiveSpec, PayoffLeg, PlanQuote, PlanSearchContext, PlanSearchResult } from '@algomaker/payoff'
import { spanMargin, type SpanFile, type SpanPosition } from '@algomaker/span'
import { lookupsOf, OFFSET_LEG_ID, type RepairJob } from './repair.ts'

export interface PlanSearchQuote {
  readonly strike: number
  readonly type: OptionType
  readonly bid: number | null
  readonly ask: number | null
  readonly stale: boolean
}

/** The real SPAN of one stock's book, as plain data. */
export interface PlanSearchSpan {
  readonly symbol: string
  /** The newest SPAN file with `commodities` cut to `symbol`. */
  readonly file: SpanFile
  /** `symbol`'s exposure (ELM) rate; empty when the exposure file has none. */
  readonly rates: ReadonlyMap<string, number>
  /** The book's options and futures outside the job's expiry: margined with every plan, traded by none. */
  readonly fixed: readonly SpanPosition[]
}

/** Structured-cloneable: no functions. */
export interface PlanSearchJob {
  readonly kind: 'plan-search'
  /** The book and the chain it is searched on, as a repair job carries them. */
  readonly chain: RepairJob
  /** The traded future's mark, for 'future' moves; null = no future moves. */
  readonly futureMark: number | null
  readonly lotSize: number
  readonly quotes: readonly PlanSearchQuote[]
  /** null = no SPAN file yet: the search ranks on SPAN-lite and says so (`marginSource`). */
  readonly span: PlanSearchSpan | null
  /** P&L the job expiry's series already booked (`SeriesPnl.booked`): max loss, the run's POP and EV count it. Absent = the chain's 0. */
  readonly realised?: number
  /** As `normaliseObjective` left it. */
  readonly spec: ObjectiveSpec
  /** The REQUEST's permission to close (R6), passed to `searchPlans` again. */
  readonly allowClose: boolean
  readonly opts?: { readonly topN?: number; readonly beamWidth?: number }
}

/** The objective search's signature (Lane 1's `searchPlans`). */
export type PlanSearchFn = (
  ctx: PlanSearchContext, spec: ObjectiveSpec, opts?: { topN?: number; beamWidth?: number; allowClose?: boolean },
) => PlanSearchResult

export function isPlanSearchJob(m: unknown): m is PlanSearchJob {
  return typeof m === 'object' && m !== null && (m as { kind?: unknown }).kind === 'plan-search'
}

/** A book leg as a SPAN position. */
export function spanPositionOf(symbol: string, l: Pick<PayoffLeg, 'instrument' | 'expiry' | 'strike' | 'type' | 'qty'>): SpanPosition {
  return { symbol, kind: l.instrument === 'future' ? 'future' : 'option', expiry: l.expiry, strike: l.strike, optType: l.type, qty: l.qty }
}

/** The search's context, rebuilt from the job alone. */
export function planSearchContextOf(job: PlanSearchJob): PlanSearchContext {
  const c = job.chain
  const { priceOf, ivOf } = lookupsOf(c)
  const quotes = new Map<string, PlanQuote>()
  for (const q of job.quotes) quotes.set(`${q.strike}|${q.type}`, { bid: q.bid, ask: q.ask, stale: q.stale })
  const span = job.span
  // a PART of the real SPAN — a contract the file does not price, or no exposure rate — is never ranked on: null sends
  // the search back to SPAN-lite for the baseline (and drops a plan that only part-prices), and the card says partial
  const marginOf = span === null ? undefined : (legs: readonly PayoffLeg[]): number | null => {
    if (!span.rates.has(span.symbol)) return null
    const positions = [...legs.filter((l) => l.id !== OFFSET_LEG_ID).map((l) => spanPositionOf(span.symbol, l)), ...span.fixed]
    const r = spanMargin(positions, span.file, span.rates)
    return r.missing.length > 0 || !Number.isFinite(r.total) ? null : r.total
  }
  return {
    legs: c.legs, future: c.future, today: c.today, expiry: c.expiry, realised: job.realised ?? c.realised, dials: c.dials,
    priceOf, ivOf, strikes: c.strikes, triggers: null,
    ...(c.tailCapRupees === undefined ? {} : { tailCapRupees: c.tailCapRupees }),
    futureMark: job.futureMark, lotSize: job.lotSize,
    quoteOf: (strike, type) => quotes.get(`${strike}|${type}`) ?? null,
    ...(marginOf === undefined ? {} : { marginOf }),
  }
}

export function runPlanSearchJob(job: PlanSearchJob, search: PlanSearchFn): PlanSearchResult {
  return search(planSearchContextOf(job), job.spec, {
    ...(job.opts?.topN === undefined ? {} : { topN: job.opts.topN }),
    ...(job.opts?.beamWidth === undefined ? {} : { beamWidth: job.opts.beamWidth }),
    allowClose: job.allowClose,
  })
}
