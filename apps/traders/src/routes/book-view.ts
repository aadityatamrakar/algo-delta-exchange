/**
 * `GET /books/:stock` — one book's view (`BookView`). The stock arrives
 * percent-decoded (`M%26M` is `M&M`) and is upper-cased; whose book it is
 * comes only from `whose()`.
 */

import { whose } from '../auth/whose.ts'
import type { TraderStore } from '../auth/users.ts'
import { STOCK_RE } from '../books/manual.ts'
import type { BookView } from '../types.ts'
import { BadRequest, NotFound, type Route, type RouteCtx } from './kit.ts'

export function bookViewRoutes(d: {
  users: TraderStore; bookView: (trader: string, stock: string, nowMs: number) => Promise<BookView | null>; now: () => number
}): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'books.view') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    const view = await d.bookView(trader, stock, d.now())
    if (view === null) throw new NotFound(`no open book ${stock}`)
    ctx.send(200, view)
    return true
  }
}
