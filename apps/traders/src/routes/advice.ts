/**
 * `PUT /books/:stock/band` — a trader's own band for one book, in lots
 * (`{ lots: null }` hands it back to the engine). Answers the book's band with
 * the new override. A trader sets their own; an admin names one with `?as=`.
 *
 * `GET /books/:stock/advice` — relief-r's card for the book (`AdviceCard`),
 * the minute's reading every viewer shares. Read only: nothing is submitted,
 * and no route takes a card back.
 */

import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import { isOpenLeg } from '../types.ts'
import { BadRequest, NotFound, isObject, istDate, type Route, type RouteCtx } from './kit.ts'
import type { R3RouteDeps } from './r3-deps.ts'

const LOTS_MAX = 1000
const LOTS_RULE = `lots must be a number above 0 and at most ${LOTS_MAX}, or null to clear the override`

/** `{ lots }`: null, or finite, > 0 and ≤ 1000, kept to one decimal (a value that rounds to 0 is refused). */
function parseLots(body: unknown): number | null {
  if (!isObject(body) || !('lots' in body)) throw new BadRequest('body must be { lots }')
  const v = body['lots']
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v > LOTS_MAX) throw new BadRequest(LOTS_RULE)
  const lots = Math.round(v * 10) / 10
  if (!(lots > 0)) throw new BadRequest(LOTS_RULE)
  return lots
}

export function adviceRoutes(d: Pick<R3RouteDeps, 'users' | 'legs' | 'bands' | 'risk' | 'now'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'books.band': return await band(ctx)
      case 'books.advice': return await advice(ctx)
      default: return false
    }
  }

  function stockOf(ctx: RouteCtx): string {
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    return stock
  }

  async function advice(ctx: RouteCtx): Promise<boolean> {
    const stock = stockOf(ctx)
    const trader = await whose(ctx, d.users)
    const card = await d.risk.advice(trader, stock, d.now())
    if (card === null) throw new NotFound(`no open book ${stock}`)
    ctx.send(200, card)
    return true
  }

  async function band(ctx: RouteCtx): Promise<boolean> {
    const stock = stockOf(ctx)
    const trader = await whose(ctx, d.users)
    const lots = parseLots(await ctx.readJson())
    const nowMs = d.now()
    // a book the trader does not hold is refused before anything is written
    const today = istDate(nowMs)
    if (!(await d.legs.open(trader, stock)).some((l) => isOpenLeg(l, today))) throw new NotFound(`no open book ${stock}`)
    await d.bands.set(trader, stock, lots)
    const status = await d.risk.band(trader, stock, nowMs)
    if (status === null) throw new NotFound(`no open book ${stock}`)
    ctx.send(200, status)
    return true
  }
}
