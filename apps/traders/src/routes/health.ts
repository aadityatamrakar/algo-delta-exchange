/** `GET /health` — public. What the operator and the admin page look at to see the app is fed. */

import type { TradersDeps } from '../deps.ts'
import type { Route, RouteCtx } from './kit.ts'

export function healthRoutes(d: Pick<TradersDeps, 'quotes' | 'master' | 'busConnected' | 'subscriptions' | 'config'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'health') return false
    const m = d.master()
    const declared = d.subscriptions.last()
    ctx.send(200, {
      ok: true,
      feedAlive: d.quotes.feedAlive(),
      busConnected: d.busConnected(),
      masterLoadedAt: m.loadedAt,
      masterContracts: m.options.optionCount + m.cash.size,
      declaredTokens: declared.count,
      declaredAt: declared.at,
      tokenCap: d.config.maxTokens,              // TRADERS_MAX_TOKENS
      tokenCapHit: declared.capHit,              // the last declaration was over the cap, so ATM windows were narrowed
    })
    return true
  }
}
