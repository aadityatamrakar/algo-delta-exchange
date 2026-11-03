/**
 * `GET /portfolio` — the resolved trader's Portfolio (`PortfolioView`).
 * `GET /admin/portfolio` — every trader's, rolled up per trader and per
 * underlying (`AdminPortfolioView`; admin only, enforced by the endpoint
 * table). Each book reads what its own tabs read — the BookView, R2's MTM block
 * and margin, and the band — over their caches (the payoff, the market
 * snapshot and the band are each built at most once a minute per book).
 * Writes nothing.
 */

import { bookMargin } from '../analytics/margin.ts'
import { mtmOf } from '../analytics/mtm.ts'
import { adminPortfolioOf, portfolioOf, type PortfolioInput, type PortfolioView } from '../analytics/portfolio.ts'
import { whose } from '../auth/whose.ts'
import type { TradersDeps } from '../deps.ts'
import { nearestFutureWithExpiry } from '../market/master.ts'
import { isOpenLeg } from '../types.ts'
import { istDate, type Route, type RouteCtx } from './kit.ts'
import type { R3RouteDeps } from './r3-deps.ts'

/**
 * One trader's Portfolio, as the route answers it — and as the assistant's
 * get_portfolio tool reads it, so the two can never disagree.
 */
export async function traderPortfolio(d: TradersDeps & Pick<R3RouteDeps, 'risk'>, trader: string, nowMs: number): Promise<PortfolioView> {
  /** Null when the book closed since the trader's legs were read. */
  async function bookOf(stock: string): Promise<PortfolioInput | null> {
    const [view, mtm, margin, band] = await Promise.all([
      d.bookView(trader, stock, nowMs), mtmOf(d, trader, stock, nowMs), bookMargin(d, trader, stock, nowMs), d.risk.band(trader, stock, nowMs),
    ])
    if (view === null) return null
    const lot = nearestFutureWithExpiry(d.master(), stock, istDate(nowMs))?.ref.lotSize ?? null
    return { view, lotSize: lot !== null && lot > 0 ? lot : null, mtm, margin, band }
  }
  const today = istDate(nowMs)
  const stocks = new Set((await d.legs.open(trader)).filter((l) => isOpenLeg(l, today)).map((l) => l.stock))
  const books = await Promise.all([...stocks].map((s) => bookOf(s)))
  return portfolioOf(trader, books.filter((b) => b !== null), nowMs)
}

export function portfolioRoutes(d: TradersDeps & Pick<R3RouteDeps, 'risk'>): Route {
  const portfolio = (trader: string, nowMs: number): Promise<PortfolioView> => traderPortfolio(d, trader, nowMs)

  return async (ctx: RouteCtx): Promise<boolean> => {
    const id = ctx.endpoint.id
    if (id === 'portfolio.view') {
      const trader = await whose(ctx, d.users)
      ctx.send(200, await portfolio(trader, d.now()))
      return true
    }
    if (id === 'admin.portfolio') {
      const nowMs = d.now()
      // one trader at a time: an admin's poll never builds every book at once
      const views: PortfolioView[] = []
      for (const u of await d.users.list('trader')) views.push(await portfolio(u.username, nowMs))
      ctx.send(200, adminPortfolioOf(views, nowMs))
      return true
    }
    return false
  }
}
