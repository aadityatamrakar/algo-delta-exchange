/**
 * The books list and a trader's manual legs. The list names every underlying
 * (stock or index) with a leg open today; an expired contract is not open.
 * ODIN legs follow the ODIN files and are refused here by `LegStore`.
 */

import type { BandBoard } from '../analytics/band-board.ts'
import { whose } from '../auth/whose.ts'
import type { TraderStore } from '../auth/users.ts'
import { STOCK_RE, parseManualLeg, parseManualPatch } from '../books/manual.ts'
import type { LegStore } from '../books/legs.ts'
import type { FileStore } from '../ingest/files.ts'
import { matchLeg, type TradersMaster } from '../market/master.ts'
import { contractText, isOpenLeg } from '../types.ts'
import type { BookSummary } from '../types.ts'
import { BadRequest, istDate, type Log, type Route, type RouteCtx } from './kit.ts'

export function booksRoutes(d: {
  users: TraderStore; legs: LegStore; files: FileStore; master: () => TradersMaster; now: () => number; log: Log
  /** Each row's band: the band board's last reading (none here = null). */
  board?: Pick<BandBoard, 'state'>
}): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'books.list': return await list(ctx)
      case 'legs.add': return await add(ctx)
      case 'legs.patch': return await patch(ctx)
      case 'legs.delete': return await remove(ctx)
      default: return false
    }
  }

  async function list(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const today = istDate(d.now())
    const counts = new Map<string, number>()
    for (const l of await d.legs.open(trader)) {
      if (isOpenLeg(l, today)) counts.set(l.stock, (counts.get(l.stock) ?? 0) + 1)
    }
    const lastFileAt = await d.files.lastReceivedAt(trader)
    const rows: BookSummary[] = [...counts.keys()].sort().map((stock) => ({
      stock, legCount: counts.get(stock) as number, mismatch: null, lastFileAt, band: d.board?.state(trader, stock) ?? null,
    }))
    ctx.send(200, rows)
    return true
  }

  async function add(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const input = parseManualLeg(stock, await ctx.readJson())
    const token = matchLeg(d.master(), input)
    if (token === null) throw new BadRequest(`no ${stock} ${contractText(input)} in the instrument master`)
    ctx.send(201, await d.legs.addManual(trader, input, token))
    return true
  }

  async function patch(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    const change = parseManualPatch(await ctx.readJson())
    ctx.send(200, await d.legs.patchManual(trader, ctx.params['key'] as string, change))
    return true
  }

  async function remove(ctx: RouteCtx): Promise<boolean> {
    const trader = await whose(ctx, d.users)
    await d.legs.deleteManual(trader, ctx.params['key'] as string)
    ctx.send(200, { deleted: true })
    return true
  }
}
