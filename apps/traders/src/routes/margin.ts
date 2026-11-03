/**
 * `GET /books/:stock/margin` — the book's NSE SPAN + exposure margin
 * (`MarginView`). `?exclude=<key>` (repeated) leaves legs out. Writes nothing.
 */

import { bookMargin } from '../analytics/margin.ts'
import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import type { TradersDeps } from '../deps.ts'
import { BadRequest, NotFound, type Route, type RouteCtx } from './kit.ts'

export function marginRoutes(d: Pick<TradersDeps, 'users' | 'legs' | 'snapshots' | 'span' | 'now'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'books.margin') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    const exclude = new Set(ctx.url.searchParams.getAll('exclude'))
    const view = await bookMargin(d, trader, stock, d.now(), exclude)
    if (view === null) throw new NotFound(`no open book ${stock}`)
    ctx.send(200, view)
    return true
  }
}
