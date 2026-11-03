/**
 * `GET /booked?from=YYYY-MM&to=YYYY-MM` — the resolved trader's Booked P&L (`BookedView`) over a range of expiry
 * months, by default the current month and the two before it. A trader always gets their own; an admin names the
 * trader with `?trader=<username>` (or the page's `?as=`, as on every trader-data read).
 * `GET /admin/booked?from&to` — every trader's months and the desk's (`AdminBookedView`; admin only, enforced by
 * the endpoint table), one trader at a time, so an admin's poll never walks every history at once.
 *
 * Each open series' open MTM is its book's Series P&L `open` (the BookView's, over its own caches), so an open
 * row's net equals the Series P&L block on the stock's tab. A range that ends before the current month holds no open
 * series and asks no book. Writes nothing.
 */

import { adminBookedOf, bookedKey, bookedView, defaultRange, isMonth, type BookedReader } from '../analytics/booked.ts'
import type { BookedView } from '../analytics/booked-wire.ts'
import { normaliseUsername, type TraderStore } from '../auth/users.ts'
import { whose } from '../auth/whose.ts'
import type { LegStore } from '../books/legs.ts'
import type { TradersDeps } from '../deps.ts'
import { isOpenLeg } from '../types.ts'
import { BadRequest, istDate, NotFound, type Route, type RouteCtx } from './kit.ts'

export interface BookedRouteDeps {
  readonly users: TraderStore
  readonly legs: Pick<LegStore, 'open'>
  readonly booked: BookedReader
  readonly bookView: TradersDeps['bookView']
  readonly now: () => number
}

/** The months asked for: `from` and `to` as given, `to` the current month and `from` two before `to` when not. */
export function bookedRange(q: URLSearchParams, today: string): { readonly from: string; readonly to: string } {
  const read = (k: 'from' | 'to'): string | null => {
    const v = q.get(k)
    if (v === null || v === '') return null
    if (!isMonth(v)) throw new BadRequest(`${k} must be a month, YYYY-MM`)
    return v
  }
  const to = read('to') ?? defaultRange(today).to
  const from = read('from') ?? defaultRange(`${to}-01`).from
  if (from > to) throw new BadRequest('from must not be after to')
  return { from, to }
}

/** A trader is themselves; an admin names one with `?trader=`, or `?as=` as `whose()` reads it. */
async function traderOf(ctx: RouteCtx, users: TraderStore): Promise<string> {
  const named = ctx.url.searchParams.get('trader')
  if (ctx.principal?.kind !== 'admin' || named === null || named.trim() === '') return await whose(ctx, users)
  const u = await users.find(normaliseUsername(named))
  if (u === null || u.role !== 'trader') throw new NotFound(`no trader "${normaliseUsername(named)}"`)
  return u.username
}

/**
 * Each held book's open series' MTM (its Series P&L `open`) and its open shares' (Σ the share legs' MTM column), by
 * `bookedKey`. Only series with an open leg are listed: a closed one has no open part.
 */
export async function openMtmOf(d: Pick<BookedRouteDeps, 'legs' | 'bookView'>, trader: string, nowMs: number): Promise<Map<string, number | null>> {
  const today = istDate(nowMs)
  const stocks = [...new Set((await d.legs.open(trader)).filter((l) => isOpenLeg(l, today)).map((l) => l.stock))]
  const views = await Promise.all(stocks.map((s) => d.bookView(trader, s, nowMs)))
  const out = new Map<string, number | null>()
  for (const v of views) {
    if (v === null) continue
    for (const s of v.series ?? []) if (s.openLegs > 0) out.set(bookedKey(v.stock, s.expiry), s.open)
    const shares = v.legs.filter((l) => l.instrument === 'share' && l.qty !== 0)
    if (shares.length > 0) {
      out.set(bookedKey(v.stock, ''), shares.some((l) => l.mtm === null) ? null : shares.reduce((t, l) => t + (l.mtm as number), 0))
    }
  }
  return out
}

/** One trader's Booked P&L over `range`, as the route answers it. */
export async function traderBooked(d: Omit<BookedRouteDeps, 'users'>, trader: string, range: { readonly from: string; readonly to: string }, nowMs: number): Promise<BookedView> {
  const ledger = await d.booked(trader, nowMs)
  // no open series before the current month: a past range prices nothing
  const openMtm = range.to < istDate(nowMs).slice(0, 7) ? new Map<string, number | null>() : await openMtmOf(d, trader, nowMs)
  return bookedView(ledger, { asOf: nowMs, ...range, openMtm })
}

export function bookedRoutes(d: BookedRouteDeps): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    const id = ctx.endpoint.id
    if (id !== 'booked.view' && id !== 'admin.booked') return false
    const nowMs = d.now()
    const range = bookedRange(ctx.url.searchParams, istDate(nowMs))
    if (id === 'booked.view') {
      const trader = await traderOf(ctx, d.users)
      ctx.send(200, await traderBooked(d, trader, range, nowMs))
      return true
    }
    // one trader at a time: each walks a whole history
    const views: BookedView[] = []
    for (const u of await d.users.list('trader')) views.push(await traderBooked(d, u.username, range, nowMs))
    ctx.send(200, adminBookedOf(views, { asOf: nowMs, ...range }))
    return true
  }
}
