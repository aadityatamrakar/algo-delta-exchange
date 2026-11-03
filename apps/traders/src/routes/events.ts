/**
 * `GET /events` — the results-event risk of each held book (`EventRiskView`, risk spec R10–R12, R15): the next
 * results date from NSE's calendar (`<nseDir>/events.json`), the stock's past reactions, the implied move of the
 * series that carries the results, and what the book would change by on the morning after.
 *
 * Access as `/vol`: a trader gets their own open books; an admin names a trader with `?as=`, or without it gets every
 * held stock (`trader: null`), each stock's books summed by repricing every trader's legs of that stock as one leg
 * list (R15, as the admin Portfolio rolls up per underlying). One view per (trader | null) a minute (`eventsReader`),
 * shared by the page, the assistant and the results-ahead alert. Nothing is written.
 *
 * The implied move (R11): the ATM straddle at the strike nearest the series' future, from the book's minute snapshot
 * when the book holds that month, else from the live quotes; each side at its mid when bid and ask are both above 0,
 * else its LTP.
 */

import { TtlCache, MINUTE_MS } from '../analytics/cache.ts'
import type { DailyBar } from '../analytics/context-wire.ts'
import { eventRiskRow, sortRows } from '../analytics/event-risk.ts'
import { shortDate } from '../analytics/levels.ts'
import { forwardFor } from '../analytics/month-chain.ts'
import type { EventRiskRow, EventRiskView } from '../analytics/risk-wire.ts'
import { priceBook, type BookSnapshot, type SnapshotCache } from '../analytics/snapshot.ts'
import { whose } from '../auth/whose.ts'
import type { TraderStore } from '../auth/users.ts'
import type { LegStore } from '../books/legs.ts'
import type { EventsStore } from '../market/events-store.ts'
import { heldStocks } from '../market/held.ts'
import { MAX_HISTORY_DAYS } from '../market/history.ts'
import { spotTokenOf, type TradersMaster } from '../market/master.ts'
import type { TradersQuotes } from '../market/quotes.ts'
import { isOpenLeg, type TraderLeg } from '../types.ts'
import { istDate, type Route, type RouteCtx } from './kit.ts'

export const NO_CALENDAR = 'No results calendar yet (scripts/nse_vol_job.py events step): no results dates.'
/** A calendar older than this is said: the job runs each weekday evening. */
const CALENDAR_OLD_MS = 4 * 86_400_000

export interface EventRiskDeps {
  readonly legs: Pick<LegStore, 'open' | 'allOpen' | 'version'>
  readonly calendar: Pick<EventsStore, 'upcoming' | 'past' | 'status'>
  /** Daily bars, oldest → newest (HistoryStore.bars). */
  readonly bars: (stock: string, n: number) => readonly DailyBar[]
  readonly master: () => TradersMaster
  readonly quotes: TradersQuotes
  /** The minute snapshot a trader's book is priced on (Analysis and Scenario read the same). */
  readonly snapshots: Pick<SnapshotCache, 'get'>
}

/** One view per (trader | null) a minute. */
export type EventsReader = (trader: string | null, nowMs: number) => Promise<EventRiskView>

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/**
 * The implied move of `expiry`'s ATM straddle, and why when null. `s` = the book's snapshot; it is read when the book
 * holds a leg of that month (its future and, for a side with no live quote, its chain quote).
 */
export function straddleMove(
  m: TradersMaster, q: TradersQuotes, s: BookSnapshot | null, stock: string, expiry: string, nowMs: number,
): { readonly move: number | null; readonly warning: string | null } {
  const held = s !== null && s.legs.some((l) => l.leg.instrument !== 'share' && l.leg.expiry === expiry)
  let future: number | null = null
  let fromForward = false
  if (held) {
    future = s.futures[expiry] ?? null
    if (future === null) { future = s.optionFutures[expiry] ?? null; fromForward = future !== null }
  } else {
    const token = spotTokenOf(m, stock)
    const spotQ = token === null ? null : q.quote(token)
    const fwd = forwardFor(m, q, stock, expiry, positive(spotQ?.price) ? spotQ.price : null, nowMs)
    future = fwd?.price ?? null
    fromForward = fwd !== null && fwd.source !== 'future'
  }
  if (!positive(future)) return { move: null, warning: `no price for the ${shortDate(expiry)} future: no implied move` }
  const strike = m.options.atmStrike(stock, expiry, future)
  if (strike === null) return { move: null, warning: `no ${shortDate(expiry)} strikes listed: no implied move` }
  const side = (type: 'CE' | 'PE'): number | null => {
    const token = m.options.resolve(stock, expiry, strike, type)?.instrumentToken
    const got = token === undefined ? null : q.quote(token)
    if (got !== null && positive(got.bid) && positive(got.ask)) return (got.bid + got.ask) / 2
    if (got !== null && positive(got.price)) return got.price
    const snap = held ? s.quotes[expiry]?.find((x) => x.strike === strike && x.type === type)?.price : undefined
    return positive(snap) ? snap : null
  }
  const ce = side('CE')
  const pe = side('PE')
  const missing = [ce === null ? 'CE' : null, pe === null ? 'PE' : null].filter((x) => x !== null)
  if (ce === null || pe === null) return { move: null, warning: `no quote for the ${shortDate(expiry)} ${strike} ${missing.join(' or ')}: no implied move` }
  return {
    move: (ce + pe) / future,
    warning: fromForward ? `the ${shortDate(expiry)} future is not quoted: the implied move is off its forward` : null,
  }
}

/** The view, as the route answers it and the assistant's get_events and the results-ahead alert read it. */
export async function eventRiskView(d: EventRiskDeps, trader: string | null, nowMs: number): Promise<EventRiskView> {
  const today = istDate(nowMs)
  const version = trader === null ? 0 : d.legs.version(trader)   // before the read, as Analysis
  const legs: readonly TraderLeg[] = (trader === null ? await d.legs.allOpen() : await d.legs.open(trader)).filter((l) => isOpenLeg(l, today))
  const m = d.master()
  const market = { master: d.master, quotes: d.quotes, now: () => nowMs }
  const rows: EventRiskRow[] = heldStocks(legs, today).map((stock) => {
    const book = legs.filter((l) => l.stock === stock)
    // an admin's stock: every trader's legs of it priced together, as one book
    const snapshot = trader === null ? priceBook('', stock, book, market) : d.snapshots.get(trader, stock, book, version)
    return eventRiskRow({
      stock, today, upcoming: d.calendar.upcoming(stock), past: d.calendar.past(stock), bars: d.bars(stock, MAX_HISTORY_DAYS),
      expiries: m.options.expiries(stock).filter((e) => e >= today), legs: book,
      implied: (expiry) => straddleMove(m, d.quotes, snapshot, stock, expiry, nowMs), snapshot,
    })
  })
  const st = d.calendar.status()
  const warnings: string[] = []
  if (st.writtenAt === null) warnings.push(NO_CALENDAR)
  else if (nowMs - Date.parse(st.writtenAt) > CALENDAR_OLD_MS) warnings.push(`The results calendar was written ${istDate(Date.parse(st.writtenAt))}: newer board meetings may be missing.`)
  if (st.writtenAt !== null && st.nseErrors > 0) {
    warnings.push(`NSE did not answer ${st.nseErrors} ${st.nseErrors === 1 ? 'request' : 'requests'} on the run of ${istDate(Date.parse(st.writtenAt))}: some results dates are an older run's.`)
  }
  warnings.push(...st.problems)
  return { asOf: nowMs, trader, calendarAsOf: st.writtenAt, rows: sortRows(rows), warnings }
}

/** One view per (trader | null) a minute: the page polls, the assistant asks and the alert runner reads the same one. */
export function eventsReader(d: EventRiskDeps): EventsReader {
  const cache = new TtlCache<EventRiskView>(MINUTE_MS)
  // '' cannot be a username: the admin's every-trader view
  return (trader, nowMs) => cache.get(trader ?? '', nowMs, () => eventRiskView(d, trader, nowMs))
}

export interface EventsRouteDeps {
  readonly users: TraderStore
  readonly eventRisk: EventsReader
  readonly now: () => number
}

export function eventsRoutes(d: EventsRouteDeps): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'events.view') return false
    const as = ctx.url.searchParams.get('as')
    const everyone = ctx.principal?.kind === 'admin' && (as === null || as.trim() === '')
    const trader = everyone ? null : await whose(ctx, d.users)
    ctx.send(200, await d.eventRisk(trader, d.now()))
    return true
  }
}
