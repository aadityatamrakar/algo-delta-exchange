/**
 * The conversation's plan cache (spec §6.2): every plan a tool produced gets
 * an id, `P1`, `P2`…, unique in the conversation, so the model can cite and
 * compare plans without the engines running again. Bounded (oldest dropped);
 * saved with the conversation, so a later turn still knows them.
 *
 * `compare_plans` reads only this cache: no new compute, and every number it
 * shows was already a tool result — but on ONE basis. A search, a neutralize
 * or an evaluation counts what its expiry series had booked in its run-level
 * figures (max loss, worst shock, EV, CVaR); a repair counts 0. Each plan says
 * which (`realisedBasis`) and what the series had booked (`seriesBooked`), and
 * the comparison moves every row onto the series basis, so two plans never
 * differ by booked money alone.
 */

import { z } from 'zod'
import type { Move } from '@algomaker/payoff'
import type { AssistantWhatIfLeg } from '../wire.ts'
import { envelope, ToolRefusal, type AgentTool, type ToolCtx } from './ctx.ts'

export const PLAN_CACHE_MAX = 60

export type PlanSource = 'repair' | 'search' | 'evaluation' | 'neutralize'

export interface CachedPlan {
  readonly id: string
  readonly stock: string
  readonly source: PlanSource
  /** e.g. "repair · cut the loss". */
  readonly title: string
  readonly lines: readonly string[]
  /** After the plan, by metric name, in each metric's own unit. */
  readonly metrics: Readonly<Record<string, number | null>>
  readonly flags: readonly string[]
  readonly whatIf: readonly AssistantWhatIfLeg[]
  /** The plan's moves, server side only: a shift or close names its leg by key. Absent on a repair plan. */
  readonly moves?: readonly Move[]
  readonly at: number
  /** The booked P&L its run-level figures include: the series' for a search, 0 for a repair. Absent = 0 (a plan cached before). */
  readonly realisedBasis?: number
  /** What its expiry series had booked when it was made; null or absent = not known (no series from the book). */
  readonly seriesBooked?: number | null
}

/** The figures booked P&L moves one for one: run-level money (goals.ts). POP, widths and breakevens cannot be moved by adding it. */
export const RUN_MONEY: ReadonlySet<string> = new Set(['maxLoss', 'worstShock', 'ev', 'cvar'])

/** What to add to a plan's run-level figures to put it on its series' basis; null when the series is not known. */
export function toSeriesBasis(p: Pick<CachedPlan, 'realisedBasis' | 'seriesBooked'>): number | null {
  return p.seriesBooked === undefined || p.seriesBooked === null ? null : p.seriesBooked - (p.realisedBasis ?? 0)
}

const BASIS_NOTE = 'maxLoss, worstShock, ev and cvar are on the series basis: each includes what its expiry series had already booked '
  + '(bookedIncluded); null bookedIncluded = not known, open legs only. The other figures are as each plan was produced: a repair\'s '
  + 'popPct, profitableWidthPct and breakevens leave booked P&L out'

export interface PlanCacheState {
  readonly plans: readonly CachedPlan[]
  readonly next: number
}

export class PlanCache {
  readonly #plans = new Map<string, CachedPlan>()
  #next: number
  readonly #max: number

  constructor(saved: PlanCacheState = { plans: [], next: 1 }, max = PLAN_CACHE_MAX) {
    for (const p of saved.plans) this.#plans.set(p.id, p)
    this.#next = saved.next
    this.#max = max
  }

  add(p: Omit<CachedPlan, 'id'>): CachedPlan {
    const plan: CachedPlan = { ...p, id: `P${this.#next++}` }
    this.#plans.set(plan.id, plan)
    while (this.#plans.size > this.#max) {
      const oldest = this.#plans.keys().next().value
      if (oldest === undefined) break
      this.#plans.delete(oldest)
    }
    return plan
  }

  get(id: string): CachedPlan | null {
    return this.#plans.get(id.trim().toUpperCase()) ?? null
  }

  get state(): PlanCacheState {
    return { plans: [...this.#plans.values()], next: this.#next }
  }
}

const compareInput = z.object({
  planIds: z.array(z.string().regex(/^[Pp]\d{1,4}$/, 'a plan id such as P2')).min(1).max(6).describe('plan ids from this conversation, e.g. ["P1", "P3"]'),
}).strict()

export const comparePlans: AgentTool<z.infer<typeof compareInput>> = {
  name: 'compare_plans',
  description: 'Side-by-side metrics of plans already produced in this conversation (by id). Runs no new search.',
  input: compareInput,
  label: (i) => `comparing ${i.planIds.join(', ')}`,
  async run(ctx: ToolCtx, input) {
    const found = input.planIds.map((id) => ctx.plans.get(id))
    const missing = input.planIds.filter((_, i) => found[i] === null)
    if (missing.length > 0) {
      const known = ctx.plans.state.plans.map((p) => p.id)
      throw new ToolRefusal(`no plan ${missing.join(', ')} in this conversation; known plans: ${known.length === 0 ? 'none yet' : known.join(', ')}`)
    }
    const plans = found as CachedPlan[]
    const metrics = [...new Set(plans.flatMap((p) => Object.keys(p.metrics)))]
    const valuesOf = (p: CachedPlan): (number | null)[] => {
      const shift = toSeriesBasis(p)
      return metrics.map((m) => {
        const v = p.metrics[m] ?? null
        return v === null || shift === null || !RUN_MONEY.has(m) ? v : Math.round((v + shift) * 100) / 100
      })
    }
    return {
      result: {
        ...envelope(ctx, { warnings: ['figures are from when each plan was produced; ask for a fresh search to re-price'] }),
        metrics, basis: BASIS_NOTE,
        plans: plans.map((p) => ({
          planId: p.id, stock: p.stock, source: p.source, title: p.title, lines: p.lines, flags: p.flags,
          bookedIncluded: toSeriesBasis(p) === null ? null : (p.seriesBooked as number), values: valuesOf(p),
        })),
      },
      summary: `${plans.length} plans side by side`,
    }
  },
}
