/**
 * `POST /books/:stock/repair` — the repair card for one book (`RepairView`).
 * Body `{ tailCap?: number }`: CHEAP-TAIL-CAP's floor, a positive rupee loss.
 * The search runs in the repair pool, shared by every viewer of the book for a
 * minute; 429 `{ error: 'busy', retryAfterMs }` when it cannot get a slot.
 * Read only: nothing here is stored or placed.
 */

import { monthQuotes } from '../analytics/month-chain.ts'
import type { PoolAnswer } from '../analytics/repair-pool.ts'
import { repairExpiryOf, repairJobOf, repairViewOf } from '../analytics/repair.ts'
import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import { BadRequest, NotFound, isObject, type Route, type RouteCtx } from './kit.ts'
import type { R3RouteDeps } from './r3-deps.ts'

/** A request's tail cap: absent or null = the search's default. */
function tailCapOf(body: unknown): number | null {
  if (!isObject(body)) throw new BadRequest('body must be { tailCap? }')
  const v = body['tailCap']
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new BadRequest('tailCap must be a positive number of rupees')
  return v
}

export function repairRoutes(d: Pick<R3RouteDeps, 'users' | 'legs' | 'bookView' | 'master' | 'quotes' | 'repair' | 'now' | 'log'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'books.repair') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    const tailCap = tailCapOf(await ctx.readJson())
    const nowMs = d.now()
    // Read before the legs, as the book view does: a write landing between the two only misses this key.
    const version = d.legs.version(trader)
    const view = await d.bookView(trader, stock, nowMs)
    if (view === null) throw new NotFound(`no open book ${stock}`)

    const expiry = repairExpiryOf(view, nowMs)
    const m = d.master()
    const month = expiry === null ? null : monthQuotes(m, d.quotes, stock, expiry, view.spot, nowMs, view.closed)
    const lotSize = expiry === null ? 0 : m.options.chain(stock, expiry)?.lotSize ?? 0
    const r = repairJobOf(view, month, lotSize, nowMs, tailCap)
    if ('blocked' in r) {
      ctx.send(200, repairViewOf(stock, r, [], nowMs, false, nowMs))
      return true
    }

    let answer: PoolAnswer
    try {
      answer = await d.repair.request(`${trader}|${stock}`, `${trader}|${stock}|${version}|${tailCap ?? ''}`, r.job)
    } catch (err) {
      d.log('repair search failed', { stock, error: err instanceof Error ? err.message : String(err) })
      ctx.send(200, repairViewOf(stock, { blocked: 'the repair search failed — try again' }, [], nowMs, false, nowMs))
      return true
    }
    if ('busy' in answer) {
      ctx.res.setHeader('retry-after', String(Math.ceil(answer.retryAfterMs / 1000)))
      ctx.send(429, { error: 'busy', retryAfterMs: answer.retryAfterMs })
      return true
    }
    // The plans' own job: a cached or shared answer is shown with the chain it was searched on.
    ctx.send(200, repairViewOf(stock, { ...r, job: answer.job }, answer.plans, answer.computedAt, answer.cached, nowMs))
    return true
  }
}
