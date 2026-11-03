/**
 * `get_repairs`: the existing four-goal repair menu — the same job, the same
 * worker pool and the same card the book page's repair route builds
 * (`repairJobOf` → `RepairPool.request` → `repairViewOf`), so the assistant
 * and the page show the same plans. It counts as a search (R10).
 *
 * Each plan gets a conversation plan id for `compare_plans`. The model sees
 * the plans' sentences and scores, never their moves: a shift or close names
 * its leg by key, and a key carries the client code (R5).
 */

import { z } from 'zod'
import type { PlanScore } from '@algomaker/payoff'
import { monthQuotes } from '../../analytics/month-chain.ts'
import { repairExpiryOf, repairJobOf, repairViewOf } from '../../analytics/repair.ts'
import { bookViewOf, stockOf } from './book.ts'
import { envelope, r2, ToolRefusal, type AgentTool } from './ctx.ts'

const repairInput = z.object({
  stock: z.string().min(1).max(20).describe('NSE symbol'),
  tailCap: z.number().positive().optional().describe('the cheap-tail-cap goal\'s floor: a positive rupee loss'),
}).strict()

/** PlanScore's numbers, rounded, under the names compare_plans shows. */
export function scoreMetrics(s: PlanScore): Record<string, number | null> {
  return {
    credit: r2(s.credit), maxLoss: r2(s.maxLoss), maxLossAt: r2(s.maxLossAt), worstShock: r2(s.worstShock), worstShockAt: r2(s.worstShockAt),
    popPct: r2(s.pop * 100), profitableWidthPct: r2(s.profitableWidthPct),
    marginBefore: r2(s.marginBefore), marginAfter: r2(s.marginAfter), marginChange: r2(s.marginDelta),
    breakevenDown: r2(s.breakevens[0] ?? null), breakevenUp: r2(s.breakevens[s.breakevens.length - 1] ?? null),
  }
}

export const getRepairs: AgentTool<z.infer<typeof repairInput>> = {
  name: 'get_repairs',
  description: "The book page's repair menu: four goals (REDUCE-LOSS, PROFITABLE-BY-EXPIRY, CHEAP-TAIL-CAP, MAX-CREDIT-SAFE), up to three plans each, and the do-nothing baseline; "
    + 'credit, max loss and worst shock (realised not counted), POP, SPAN-lite margin before and after. Repairs never close a leg. Each plan has an id for compare_plans.',
  input: repairInput,
  label: (i) => `repair search ${i.stock.toUpperCase()}`,
  search: true,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const d = ctx.deps
    const nowMs = d.now()
    const tailCap = input.tailCap ?? null
    // read before the legs, as the route does: a write landing between the two only misses this key
    const version = d.legs.version(ctx.trader)
    const view = await bookViewOf(ctx, stock, nowMs)
    const expiry = repairExpiryOf(view, nowMs)
    const m = d.master()
    const month = expiry === null ? null : monthQuotes(m, d.quotes, stock, expiry, view.spot, nowMs, view.closed)
    const lotSize = expiry === null ? 0 : m.options.chain(stock, expiry)?.lotSize ?? 0
    const r = repairJobOf(view, month, lotSize, nowMs, tailCap)
    if ('blocked' in r) {
      return { result: { ...envelope(ctx, { closed: view.closed }), stock, blocked: r.blocked, goals: [] }, summary: `${stock}: ${r.blocked}` }
    }
    const answer = await d.repair.request(`${ctx.trader}|${stock}`, `${ctx.trader}|${stock}|${version}|${tailCap ?? ''}`, r.job)
    if ('busy' in answer) throw new ToolRefusal(`the repair search is busy; it can be asked again in ${Math.ceil(answer.retryAfterMs / 1000)} s`)
    const rv = repairViewOf(stock, { ...r, job: answer.job }, answer.plans, answer.computedAt, answer.cached, nowMs)
    let baseline: Record<string, number | null> | null = null
    // a repair counts no booked P&L (REALISED_NOT_COUNTED); compare_plans moves it onto the series' basis from this
    const seriesBooked = view.series?.find((s) => s.expiry === rv.expiry)?.booked ?? null
    const goals = rv.goals.map(({ goal, plans }) => ({
      goal,
      plans: plans.flatMap((p) => {
        if (p.moves.length === 0) { baseline ??= scoreMetrics(p.score); return [] }
        const cached = ctx.plans.add({
          stock, source: 'repair', title: `repair · ${goal}`, lines: p.lines, metrics: scoreMetrics(p.score), flags: p.flags, whatIf: p.whatIf, at: nowMs,
          realisedBasis: 0, seriesBooked,
        })
        return [{ planId: cached.id, lines: p.lines, flags: p.flags, ...cached.metrics }]
      }),
    }))
    const shown = goals.reduce((n, g) => n + g.plans.length, 0)
    return {
      result: {
        ...envelope(ctx, { closed: view.closed, warnings: rv.warnings }),
        stock, expiry: rv.expiry, computedAt: rv.computedAt, baseline, goals,
        offset: rv.offset, units: { money: 'rupees', popPct: 'percent', profitableWidthPct: 'percent of the ±10% scan' },
      },
      summary: `${stock}: ${shown} repair ${shown === 1 ? 'plan' : 'plans'}`,
    }
  },
}
