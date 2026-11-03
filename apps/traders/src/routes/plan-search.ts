/**
 * `POST /books/:stock/plan-search` — the objective search with no model in it
 * (spec §6.4): the goal chips (first = the goal, the rest = keep no worse), an
 * optional market view and the "Allow closing legs" checkbox → `{ card }`, a
 * plans card. It works with the assistant switched off (R4), runs in the
 * repair workers like every search (429 when they are busy), and every run is
 * kept in `traders-assistant` as a plan-search record (§6.5a). Read only:
 * nothing is placed.
 */

import { z } from 'zod'
import { PRESET_IDS, type PresetId } from '@algomaker/payoff'
import { bookPlanBase, plansCardOf, pricedOn, searchInPool, specFromPresets } from '../agent/planning.ts'
import type { AssistantStore } from '../agent/store.ts'
import type { AgentDeps } from '../agent/tools/ctx.ts'
import { resolveView, viewChoiceOf, viewChoiceSchema } from '../agent/view.ts'
import type { TraderStore } from '../auth/users.ts'
import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import { BadRequest, NotFound, type Log, type Route, type RouteCtx } from './kit.ts'

export const PLAN_SEARCH_TOP_N = 3

const bodySchema = z.object({
  presets: z.array(z.enum(PRESET_IDS as readonly [string, ...string[]])).min(1, 'pick at least one goal').max(4),
  view: viewChoiceSchema.optional(),
  allowClose: z.boolean().optional(),
}).strict()

export interface PlanSearchRouteDeps {
  readonly users: TraderStore
  readonly agent: AgentDeps
  readonly store: AssistantStore
  readonly now: () => number
  readonly log: Log
}

export function planSearchRoutes(d: PlanSearchRouteDeps): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'books.plan-search') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    const parsed = bodySchema.safeParse(await ctx.readJson())
    if (!parsed.success) {
      const i = parsed.error.issues[0]
      throw new BadRequest(i === undefined ? 'body must be { presets, view?, allowClose? }' : `${i.path.join('.') || 'body'}: ${i.message}`)
    }
    const body = parsed.data
    const allowClose = body.allowClose === true
    const nowMs = d.now()
    const base = await bookPlanBase(d.agent, trader, stock, nowMs)
    if ('noBook' in base) throw new NotFound(`no open book ${stock}`)
    if ('blocked' in base) {
      ctx.send(422, { error: base.blocked, code: 'blocked' })
      return true
    }
    const view = await resolveView(d.agent, stock, viewChoiceOf(body.view), nowMs)
    if ('error' in view) throw new BadRequest(view.error)
    const presets = body.presets as PresetId[]
    const spec = specFromPresets(presets, view.view, allowClose)
    if ('error' in spec) throw new BadRequest(spec.error)
    let out: Awaited<ReturnType<typeof searchInPool>>
    try {
      out = await searchInPool(d.agent, trader, base, spec.spec, allowClose, PLAN_SEARCH_TOP_N)
    } catch (err) {
      // as the repair route: a failed search is a blocked answer the page can show, never a 500
      d.log('plan search failed', { stock, error: err instanceof Error ? err.message : String(err) })
      ctx.send(422, { error: 'the plan search failed — try again', code: 'blocked' })
      return true
    }
    if ('busyMs' in out) {
      ctx.res.setHeader('retry-after', String(Math.ceil(out.busyMs / 1000)))
      ctx.send(429, { error: 'the search workers are busy — try again in a moment', code: 'busy' })
      return true
    }
    if (out.result.refused !== null) throw new BadRequest(out.result.refused)
    let n = 0
    const { card } = await plansCardOf(d.agent, trader, base, pricedOn(stock, out.job), out.result, {
      cardId: `ps-${nowMs}`, title: `${stock}: plan search`, viewLabel: view.label, nextId: () => `P${++n}`, at: nowMs,
    })
    try {
      await d.store.recordPlanSearch({ trader, stock, request: { presets, view: body.view ?? null, allowClose }, card })
    } catch (err) {
      d.log('plan search not recorded', { stock, error: err instanceof Error ? err.message : String(err) })
    }
    ctx.send(200, { card })
    return true
  }
}
