/**
 * The trader's records, read only: orders, trades and log lines of a day, the
 * watcher's last heartbeat, and the files the watcher has sent (never their
 * content).
 */

import { whose } from '../auth/whose.ts'
import type { TraderStore } from '../auth/users.ts'
import type { TradersDb } from '../db.ts'
import type { FileStore } from '../ingest/files.ts'
import type { LogLine, StoredFile, TraderOrder, TraderTrade } from '../types.ts'
import type { WatcherStatusStore } from '../watcher-status.ts'
import { BadRequest, isIsoDate, istDate, type Route, type RouteCtx } from './kit.ts'

const LIMIT = 5000
const FILES_LIMIT = 500
const NO_ID = { projection: { _id: 0 } } as const
const INTERNAL = 'internal error — the server will retry'

export function recordsRoutes(d: {
  users: TraderStore; db: TradersDb; status: WatcherStatusStore; files: FileStore; now: () => number
}): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'orders.list': return await orders(ctx)
      case 'trades.list': return await trades(ctx)
      case 'log.list': return await log(ctx)
      case 'watcher.status': return await watcher(ctx)
      case 'files.list': return await files(ctx)
      default: return false
    }
  }

  function dayOf(ctx: RouteCtx): string {
    const day = ctx.url.searchParams.get('day')
    if (day === null) return istDate(d.now())
    if (!isIsoDate(day)) throw new BadRequest('day must be a date, YYYY-MM-DD')
    return day
  }

  function filter(trader: string, ctx: RouteCtx): Record<string, unknown> {
    const f: Record<string, unknown> = { trader, day: dayOf(ctx) }
    const stock = ctx.url.searchParams.get('stock')
    if (stock !== null && stock !== '') f['stock'] = stock.toUpperCase()
    return f
  }

  /**
   * At most `limit` rows are answered. One more is read to know whether the cap
   * cut anything; if so the response carries `x-truncated: true`.
   */
  function capped<T>(ctx: RouteCtx, rows: T[], limit: number): T[] {
    if (rows.length <= limit) return rows
    ctx.res.setHeader('x-truncated', 'true')
    return rows.slice(0, limit)
  }

  async function orders(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const f = filter(trader, ctx)
    const rows = await d.db.collection<TraderOrder>('traders-orders').find(f, NO_ID).sort({ time: -1, orderNo: -1 }).limit(LIMIT + 1).toArray()
    ctx.send(200, capped(ctx, rows, LIMIT))
    return true
  }

  async function trades(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const f = filter(trader, ctx)
    const rows = await d.db.collection<TraderTrade>('traders-trades').find(f, NO_ID).sort({ time: -1, seq: -1 }).limit(LIMIT + 1).toArray()
    ctx.send(200, capped(ctx, rows, LIMIT))
    return true
  }

  async function log(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    // a busy day keeps its newest lines: read from the end, answer in seq order
    const newest = await d.db.collection<LogLine>('traders-log').find({ trader, day: dayOf(ctx) }, NO_ID).sort({ seq: -1 }).limit(LIMIT + 1).toArray()
    ctx.send(200, capped(ctx, newest, LIMIT).reverse())
    return true
  }

  async function watcher(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    ctx.send(200, await d.status.get(trader))
    return true
  }

  /** The ingest pipeline logs the raw text of an internal failure; the trader sees a sentence. */
  async function files(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const rows: StoredFile[] = capped(ctx, await d.files.list(trader, FILES_LIMIT + 1), FILES_LIMIT).map((f) =>
      f.parseError !== null && f.parseError.startsWith('internal:') ? { ...f, parseError: INTERNAL } : f)
    ctx.send(200, rows)
    return true
  }
}
