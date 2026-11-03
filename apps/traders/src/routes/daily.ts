/**
 * `GET /daily?days=30` — the resolved trader's daily record (`DailyView`): the rows `analytics/daily.ts` wrote at
 * each close, newest day first, with each day's totals. `days` counts calendar days back from today (default 30,
 * at most 366). An admin names the trader with `?trader=<username>` (or the page's `?as=`); a trader's own session
 * ignores both. Reads only; the rows are written by the recorder's timer, never by a request.
 */

import { dailyViewOf, type DailyStore } from '../analytics/daily.ts'
import { whose } from '../auth/whose.ts'
import { normaliseUsername, type TraderStore } from '../auth/users.ts'
import { BadRequest, istDate, NotFound, type Route, type RouteCtx } from './kit.ts'

export const DAILY_DEFAULT_DAYS = 30
export const DAILY_MAX_DAYS = 366
const DAY_MS = 86_400_000

/** `?days=` as a whole number from 1 to `max`; `fallback` when absent. */
export function daysParam(ctx: RouteCtx, fallback: number, max: number): number {
  const raw = ctx.url.searchParams.get('days')
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > max) throw new BadRequest(`days must be a whole number from 1 to ${max}`)
  return n
}

export function dailyRoutes(d: { users: TraderStore; daily: DailyStore; now: () => number }): Route {
  /** An admin's `?trader=` wins over `?as=`; everyone else is `whose()`. */
  async function traderOf(ctx: RouteCtx): Promise<string> {
    const named = ctx.url.searchParams.get('trader')
    if (ctx.principal?.kind === 'admin' && named !== null && named !== '') {
      const u = await d.users.find(normaliseUsername(named))
      if (u === null || u.role !== 'trader') throw new NotFound(`no trader "${named}"`)
      return u.username
    }
    return await whose(ctx, d.users)
  }

  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'daily.list') return false
    const days = daysParam(ctx, DAILY_DEFAULT_DAYS, DAILY_MAX_DAYS)
    const trader = await traderOf(ctx)
    const nowMs = d.now()
    const [rows, first] = await Promise.all([d.daily.since(trader, istDate(nowMs - (days - 1) * DAY_MS)), d.daily.firstDay(trader)])
    ctx.send(200, dailyViewOf(trader, rows, nowMs, first))
    return true
  }
}
