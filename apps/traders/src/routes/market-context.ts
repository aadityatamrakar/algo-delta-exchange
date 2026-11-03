/**
 * `GET /market/:stock/context` — one underlying's `MarketContext` (trend,
 * levels, ATR/HV/IV rank, expected move, OI view, today's figures), and
 * `GET /market/:stock/bars?interval=day|15m|5m&n=&of=spot|future` — its bars
 * as `BarsView`. Market data, not trader data: neither calls `whose`, and an
 * `?as=` means nothing here. The assistant (spec §6) reads the same things
 * through `deps.marketContext`, `deps.history` and `deps.intraday`.
 *
 * Daily bars come from the history summaries (`t` = that day's 09:15 IST);
 * intraday bars are today's, built in memory from the quote cache since the
 * app began sampling. `of` picks the spot or the near future for intraday
 * bars; it defaults to what the context measures from — the spot, or the
 * future for an underlying whose daily bars are the future's (an index).
 * Daily bars are what the summaries hold, whatever `of` says.
 */

import type { Bar, BarInterval, BarsView } from '../analytics/context-wire.ts'
import { shortDate } from '../analytics/levels.ts'
import { STOCK_RE } from '../books/manual.ts'
import type { TradersDeps } from '../deps.ts'
import { spotTokenOf } from '../market/master.ts'
import { BadRequest, NotFound, istClock, istDate, type Route, type RouteCtx } from './kit.ts'

/** The most bars one call returns (spec §5). */
export const MAX_BARS = 400
const INTERVALS: readonly BarInterval[] = ['day', '15m', '5m']

export function marketContextRoutes(d: Pick<TradersDeps, 'master' | 'history' | 'intraday' | 'marketContext' | 'now'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'market.context' && ctx.endpoint.id !== 'market.bars') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const nowMs = d.now()
    const unknown = `no such underlying in the instrument master: ${stock}`

    if (ctx.endpoint.id === 'market.context') {
      const view = await d.marketContext(stock, nowMs)
      if (view === null) throw new NotFound(unknown)
      ctx.send(200, view)
      return true
    }

    const q = ctx.url.searchParams
    const interval = (q.get('interval') ?? 'day') as BarInterval
    if (!INTERVALS.includes(interval)) throw new BadRequest('interval must be day, 15m or 5m')
    const nRaw = q.get('n')
    if (nRaw !== null && (!/^\d{1,4}$/.test(nRaw) || Number(nRaw) < 1 || Number(nRaw) > MAX_BARS)) {
      throw new BadRequest(`n must be a whole number from 1 to ${MAX_BARS}`)
    }
    const n = nRaw === null ? MAX_BARS : Number(nRaw)
    const ofRaw = q.get('of')
    if (ofRaw !== null && ofRaw !== 'spot' && ofRaw !== 'future') throw new BadRequest('of must be spot or future')
    const m = d.master()
    if (m.options.expiries(stock).length === 0 && spotTokenOf(m, stock) === null) throw new NotFound(unknown)

    const warnings: string[] = []
    let of: 'spot' | 'future'
    let bars: readonly Bar[]
    if (interval === 'day') {
      const daily = d.history.bars(stock, n)
      const fut = daily.filter((b) => b.src === 'fut').length
      of = daily.length > 0 && daily.at(-1)?.src === 'fut' ? 'future' : 'spot'
      bars = daily.map((b) => ({ t: Date.parse(`${b.date}T09:15:00+05:30`), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
      if (daily.length === 0) warnings.push(`no daily history for ${stock} yet (no end-of-day summary lists it)`)
      else if (of === 'future') warnings.push(`NSE's end-of-day files carry no OHLC for ${stock}: these are its near future's bars`)
      else if (fut > 0) warnings.push(`${fut} of these days had no cash row for ${stock}: their bars are the near future's`)
    } else {
      of = ofRaw ?? (d.history.latest(stock)?.src === 'fut' ? 'future' : 'spot')
      const cov = d.intraday.coverage()
      const today = istDate(nowMs)
      bars = cov.day === today ? d.intraday.bars(stock, interval, of).slice(-n) : []
      if (bars.length === 0) warnings.push(`no ticks of ${stock}'s ${of} sampled today (${shortDate(today)})`)
      else if (cov.since !== null && cov.since > Date.parse(`${today}T09:15:00+05:30`)) {
        warnings.push(`today's bars are built in memory from ${istClock(cov.since)} IST, when the app began sampling; earlier ones are lost`)
      }
    }
    const view: BarsView = { stock, interval, of, bars, warnings }
    ctx.send(200, view)
    return true
  }
}
