/**
 * `GET /market/:stock` — Market Watch's three chains for one underlying, stock
 * or index (`MarketWatchView`). Market data, not trader data: it never calls
 * `whose`. Each poll keeps the underlying on screen for another minute, so
 * its tokens stay in the declaration while the page is open, within
 * TRADERS_MARKET_WATCH_MAX_TOKENS across all viewers (P3). One view per
 * underlying is built every 2 s and shared by every viewer.
 */

import type { EodStore } from '../analytics/eod.ts'
import { TtlCache } from '../analytics/cache.ts'
import { buildMarketWatch, marketExpiries, marketInputOf, marketTokens, type MarketWatchView } from '../analytics/market-watch.ts'
import { contractsOf } from '../market/master.ts'
import { STOCK_RE } from '../books/manual.ts'
import { BadRequest, NotFound, istDate, type Route, type RouteCtx } from './kit.ts'
import type { R3RouteDeps } from './r3-deps.ts'

export const MARKET_VIEW_TTL_MS = 2_000

export function marketRoutes(
  d: Pick<R3RouteDeps, 'master' | 'quotes' | 'subscriptions' | 'onScreen' | 'now'> & { eod: Pick<EodStore, 'close' | 'oi' | 'status'> },
): Route {
  const views = new TtlCache<MarketWatchView>(MARKET_VIEW_TTL_MS)

  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'market.watch' && ctx.endpoint.id !== 'market.contracts') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    if (ctx.endpoint.id === 'market.contracts') {
      // market data for the Add leg dialog's pick lists: nothing is subscribed, nothing is a trader's
      const view = contractsOf(d.master(), stock, istDate(d.now()))
      if (view.expiries.length === 0) throw new NotFound(`no F&O contracts listed for ${stock}`)
      ctx.send(200, view)
      return true
    }
    const nowMs = d.now()
    const m = d.master()
    const today = istDate(nowMs)
    if (marketExpiries(m, stock, today).length === 0) throw new NotFound(`no F&O contracts listed for ${stock}`)

    const tokens = marketTokens(m, d.quotes, stock, today)
    const wasOn = d.onScreen.underlyings(nowMs).includes(stock)
    const isOn = d.onScreen.touch(stock, tokens, nowMs)
    // Full when every token this view needs is in the on-screen set, whatever `touch` answered.
    const held = new Set(d.onScreen.tokens(nowMs))
    const fullChains = tokens.every((t) => held.has(t))
    // an underlying that came on screen or lost its grant is declared now, not at the next 15 s pass; refreshNow never throws
    if (wasOn !== isOn) void d.subscriptions.refreshNow()

    const view = await views.get(`${stock}|${fullChains ? 'full' : 'capped'}`, nowMs, async () => {
      const input = marketInputOf(m, d.quotes, d.eod, stock, nowMs, fullChains)
      if (input === null) throw new NotFound(`no F&O contracts listed for ${stock}`)
      return buildMarketWatch({ ...input, maxTokens: d.onScreen.maxTokens })
    })
    ctx.send(200, view)
    return true
  }
}
