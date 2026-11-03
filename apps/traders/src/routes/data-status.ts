/**
 * `GET /admin/data-status?days=20` — per trader and trading day, what data arrived and whether the watcher is up
 * (`DataStatusView`; admin only, enforced by the endpoint table). Default 20 trading days, at most 60. Reads only.
 */

import { DATA_STATUS_DEFAULT_DAYS, DATA_STATUS_MAX_DAYS, readDataStatus } from '../analytics/data-status.ts'
import type { TradersDeps } from '../deps.ts'
import { daysParam } from './daily.ts'
import type { Route, RouteCtx } from './kit.ts'

export function dataStatusRoutes(d: Pick<TradersDeps, 'db' | 'users' | 'status' | 'now'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'admin.data-status') return false
    const days = daysParam(ctx, DATA_STATUS_DEFAULT_DAYS, DATA_STATUS_MAX_DAYS)
    ctx.send(200, await readDataStatus(d, days, d.now()))
    return true
  }
}
