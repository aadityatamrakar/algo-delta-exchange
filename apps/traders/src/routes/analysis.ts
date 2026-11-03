/**
 * `GET /books/:stock/analysis` — VolHedge's Analysis window for one book
 * (`AnalysisView`). The viewer's ticks, typed IVs and shifts arrive in the
 * query (`parseAnalysisQuery`) and are never stored. Writes nothing.
 */

import { parseAnalysisQuery } from '../analytics/analysis.ts'
import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import type { TradersDeps } from '../deps.ts'
import { BadRequest, NotFound, type Route, type RouteCtx } from './kit.ts'

export function analysisRoutes(d: Pick<TradersDeps, 'users' | 'analysisOf' | 'now'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'books.analysis') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    const p = parseAnalysisQuery(ctx.url.searchParams)
    if ('error' in p) throw new BadRequest(p.error)
    const view = await d.analysisOf(trader, stock, p, d.now())
    if (view === null) throw new NotFound(`no open book ${stock}`)
    ctx.send(200, view)
    return true
  }
}
