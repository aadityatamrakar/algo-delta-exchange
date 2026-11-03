/**
 * `GET /vol` — end-of-day volatility for each held stock (`VolView`): IV and its rank and percentile, HV, the
 * volatility risk premium, term and skew. A trader gets their own open books' stocks; an admin names a trader with
 * `?as=`, or without it gets every held stock (`trader: null`). The figures are market data; only which stocks are
 * listed is the trader's. Spec: docs/superpowers/specs/2026-10-23-traders-vol-addendum.md.
 *
 * Each row carries the stock's next results (risk spec R13): the date, the first listed expiry on or after it, and
 * `inNear` when the near IV the row ranks (its nearExpiry, else the first listed expiry a week or more out) includes
 * it — the page's cue is then "event", not rich or cheap.
 */

import type { DailyBar, VolRow, VolView } from '../analytics/context-wire.ts'
import { rankedNear, resultsCue } from '../analytics/event-risk.ts'
import { volMetrics } from '../analytics/vol-metrics.ts'
import { whose } from '../auth/whose.ts'
import type { TraderStore } from '../auth/users.ts'
import type { LegStore } from '../books/legs.ts'
import type { EventsStore } from '../market/events-store.ts'
import type { Adjustment } from '../market/history.ts'
import { heldStocks } from '../market/held.ts'
import type { VolStore } from '../market/vol-store.ts'
import { istDate, type Route, type RouteCtx } from './kit.ts'

/** Bars asked of the history: the 252-day window, the 20 closes HV20 needs before its first day, and room. */
export const VOL_BARS = 300

export const NO_VOL_SNAPSHOT = 'No NSE chain snapshot yet (scripts/nse_vol_job.py): IV is the bhavcopy history\'s, no term or skew.'

export interface VolRouteDeps {
  readonly users: TraderStore
  readonly legs: Pick<LegStore, 'open' | 'allOpen'>
  readonly vol: Pick<VolStore, 'days' | 'status'>
  /** Daily bars, oldest → newest (Lane 2's HistoryStore.bars); `() => []` until that store is wired. */
  readonly bars: (stock: string, n: number) => readonly DailyBar[]
  /** The corporate actions those bars were back-adjusted across (HistoryStore.adjustments); said on the row. */
  readonly adjustments?: (stock: string, n: number) => readonly Adjustment[]
  /** The results calendar and the stock's listed option expiries (the master's); without both, rows carry no `results`. */
  readonly calendar?: Pick<EventsStore, 'upcoming'>
  readonly expiries?: (stock: string) => readonly string[]
  readonly now: () => number
}

/** One held stock's end-of-day vol row — what `/vol` lists, and the assistant's `vol` dataset reads. */
export function volRowOf(d: Pick<VolRouteDeps, 'vol' | 'bars' | 'adjustments' | 'calendar' | 'expiries'>, stock: string, today: string): VolRow {
  const m = volMetrics(d.bars(stock, VOL_BARS), d.vol.days(stock), today)
  const adj = (d.adjustments?.(stock, VOL_BARS) ?? []).filter((a) => a.kind === 'corporate')
    .map((a) => `closes before ${a.date} scaled ×${a.ratio.toFixed(4)} for a corporate action`)
  const row: VolRow = { stock, ...m, warnings: [...m.warnings, ...adj] }
  if (d.calendar === undefined || d.expiries === undefined) return row
  const listed = d.expiries(stock).filter((e) => e >= today)
  const near = m.nearExpiry !== null && m.nearExpiry >= today ? m.nearExpiry : rankedNear(listed, today)
  return { ...row, results: resultsCue(d.calendar.upcoming(stock), today, listed, near) }
}

export function volRoutes(d: VolRouteDeps): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'vol.view') return false
    const nowMs = d.now()
    const today = istDate(nowMs)
    const as = ctx.url.searchParams.get('as')
    const everyone = ctx.principal?.kind === 'admin' && (as === null || as.trim() === '')
    const trader = everyone ? null : await whose(ctx, d.users)
    const legs = trader === null ? await d.legs.allOpen() : await d.legs.open(trader)
    const rows: VolRow[] = heldStocks(legs, today).map((stock) => volRowOf(d, stock, today))
    const warnings = d.vol.status().latest === null ? [NO_VOL_SNAPSHOT] : []
    const view: VolView = { asOf: nowMs, trader, rows, warnings }
    ctx.send(200, view)
    return true
  }
}
