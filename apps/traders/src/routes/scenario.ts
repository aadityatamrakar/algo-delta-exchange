/**
 * `POST /books/:stock/scenario` — VolHedge's Scenario window for one book, with
 * Sensibull's target/expiry curve and table (`ScenarioView`). The viewer's
 * inputs and hypothetical legs arrive in the body (`parseScenarioRequest`;
 * POST only because they do not fit a query) and are never stored. Writes
 * nothing.
 */

import { noListedExpiry, parseScenarioRequest } from '../analytics/scenario-view.ts'
import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import type { TradersDeps } from '../deps.ts'
import { BadRequest, Conflict, NotFound, type Route, type RouteCtx } from './kit.ts'

export function scenarioRoutes(d: Pick<TradersDeps, 'users' | 'scenarioOf' | 'now'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'books.scenario') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    const req = parseScenarioRequest(await ctx.readJson())
    if ('error' in req) throw new BadRequest(req.error)
    const view = await d.scenarioOf(trader, stock, req, d.now())
    if (view === null) throw new NotFound(`no open book ${stock}`)
    if ('error' in view) throw view.error === noListedExpiry(stock) ? new Conflict(view.error) : new BadRequest(view.error)
    ctx.send(200, view)
    return true
  }
}
