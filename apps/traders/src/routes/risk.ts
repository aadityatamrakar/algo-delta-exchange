/**
 * `GET /risk` — the portfolio stress, the historical replay, concentration and correlation of the held books
 * (`RiskView`, spec 2026-10-24-traders-risk-design.md R2–R8, R15). A trader gets their own open books; an admin names
 * a trader with `?as=`, or without it gets every held stock with all traders' legs of it repriced together as one
 * book (`trader: null`), the way the admin Portfolio rolls up per underlying. Writes nothing.
 *
 * Each book is read where its own tabs read it: the minute snapshot (Analysis and Scenario's), the book view's net
 * delta, the market context's HV20 and near ATM IV, and the history's 260 daily bars. The view is kept 60 s per
 * trader (or the admin's all), shared by the route and the assistant's get_risk (`riskView`), so a poll every 60 s
 * reprices each book once.
 */

import { MINUTE_MS, TtlCache } from '../analytics/cache.ts'
import { buildRiskView, NIFTY, type RiskBookInput } from '../analytics/portfolio-risk.ts'
import type { RiskView } from '../analytics/risk-wire.ts'
import { priceBook, type BookSnapshot } from '../analytics/snapshot.ts'
import { whose } from '../auth/whose.ts'
import type { TradersDeps } from '../deps.ts'
import { heldStocks } from '../market/held.ts'
import { nearestFutureWithExpiry, spotTokenOf } from '../market/master.ts'
import type { TraderLeg } from '../types.ts'
import { istDate, type Route, type RouteCtx } from './kit.ts'

/** Daily bars asked of the history: 250 returns and room (R3). */
export const RISK_BARS = 260
export const RISK_TTL_MS = MINUTE_MS

export type RiskDeps = Pick<TradersDeps, 'users' | 'legs' | 'snapshots' | 'bookView' | 'master' | 'quotes' | 'history' | 'marketContext' | 'now'>

/** One 60 s cache per app (keyed by its one LegStore), so the route and the assistant share it. */
const caches = new WeakMap<object, TtlCache<RiskView>>()
function cacheOf(d: RiskDeps): TtlCache<RiskView> {
  let c = caches.get(d.legs)
  if (c === undefined) {
    c = new TtlCache<RiskView>(RISK_TTL_MS, { maxEntries: 200 })
    caches.set(d.legs, c)
  }
  return c
}

async function bookInput(d: RiskDeps, snapshot: BookSnapshot, deltaShares: number | null, nowMs: number): Promise<RiskBookInput> {
  const ctx = await d.marketContext(snapshot.stock, nowMs)
  return {
    snapshot, deltaShares, hv20: ctx?.vol.hv20 ?? null, nearIv: ctx?.vol.nearIv ?? ctx?.vol.atmIv ?? null,
    bars: d.history.bars(snapshot.stock, RISK_BARS),
  }
}

/** The view, uncached: one trader's books, or (null) every trader's legs of each stock priced as one book. */
export async function buildRiskViewOf(d: RiskDeps, trader: string | null, nowMs: number): Promise<RiskView> {
  const today = istDate(nowMs)
  const books: RiskBookInput[] = []
  if (trader !== null) {
    const version = d.legs.version(trader)   // before the read, as Analysis: a write during it leaves the version stale, never old legs under a new one
    const legs = await d.legs.open(trader)
    for (const stock of heldStocks(legs, today)) {
      const snapshot = d.snapshots.get(trader, stock, legs.filter((l) => l.stock === stock), version)
      const view = await d.bookView(trader, stock, nowMs)
      books.push(await bookInput(d, snapshot, view?.totals.delta ?? null, nowMs))
    }
  } else {
    const all = await d.legs.allOpen()
    const m = { master: d.master, quotes: d.quotes, now: () => nowMs }
    for (const stock of heldStocks(all, today)) {
      const legs: TraderLeg[] = all.filter((l) => l.stock === stock)
      // every trader's legs of the stock as one leg list: one snapshot, one reprice (R15)
      const snapshot = priceBook('', stock, legs, m)
      let delta: number | null = null
      for (const t of [...new Set(legs.map((l) => l.trader))].sort()) {
        const v = await d.bookView(t, stock, nowMs)
        if (v !== null) delta = (delta ?? 0) + v.totals.delta
      }
      books.push(await bookInput(d, snapshot, delta, nowMs))
    }
  }
  const master = d.master()
  const token = spotTokenOf(master, NIFTY)
  const spot = token === null ? null : d.quotes.quote(token)?.price ?? null
  const lot = nearestFutureWithExpiry(master, NIFTY, today)?.ref.lotSize ?? null
  return buildRiskView({ asOf: nowMs, trader, books, nifty: { bars: d.history.bars(NIFTY, RISK_BARS), spot, lotSize: lot } })
}

/** The view as the route answers it, and as the assistant's get_risk reads it: 60 s per trader (null = the admin's all). */
export function riskView(d: RiskDeps, trader: string | null, nowMs: number): Promise<RiskView> {
  return cacheOf(d).get(trader === null ? '*' : `t:${trader}`, nowMs, () => buildRiskViewOf(d, trader, nowMs))
}

export function riskRoutes(d: RiskDeps): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'risk.view') return false
    const as = ctx.url.searchParams.get('as')
    const everyone = ctx.principal?.kind === 'admin' && (as === null || as.trim() === '')
    const trader = everyone ? null : await whose(ctx, d.users)
    ctx.send(200, await riskView(d, trader, d.now()))
    return true
  }
}
