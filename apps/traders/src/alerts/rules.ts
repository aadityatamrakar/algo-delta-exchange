/**
 * The alert rules (spec 2026-10-23-traders-gaps G7), pure: given what the runner read, the alerts to raise. Each draft
 * carries a dedupe key and the store keeps the first of each key (unique index), so a rule may say the same thing
 * every minute and only its first saying reaches a phone.
 *
 * - Expiring ITM: from 14:30 IST on an expiry day until the 15:40 close, each book's legs of that expiry that are in
 *   the money at the live spot, netted across client codes, with what the close would do: a stock delivers shares, an
 *   index settles in cash. One alert per book and set of ITM contracts.
 * - Order rejected: a rejected order last updated today (IST); older days are history, never alerted, and the dedupe
 *   key keeps a restart from repeating one. The trader and, admin-wide, the admins.
 * - Watcher offline: more than 10 min without a heartbeat between 09:00 and 15:45 on a trading day, counting only
 *   from 09:00. One alert per outage, keyed by its last heartbeat (an outage over days is one). The trader and,
 *   admin-wide, the admins.
 * - Band breach: a band event to "out" (traders-events). The board can flap in and out minute by minute (BHEL wrote
 *   28 outs on 22 Oct), so a book alerts at most once in BAND_QUIET_MS.
 * - Results ahead (risk spec R14): from 09:15 IST on the trading day before a book's next results date, and on the day
 *   itself, when the book holds through it: the date, the series that carries it, and the book's change if the stock
 *   moves its past mean |move| down or up (the results-event view's outcomes). One alert per trader, stock and date.
 *
 * The text carries stocks, strikes, quantities and rupees. Never a client code; never a name in a trader's own alert
 * (an admin's names the trader).
 */

import type { BandEvent } from '../analytics/band.ts'
import { isNseTradingDay, marketOpenAt, previousTradingDay } from '../analytics/calendar.ts'
import { RESULTS_RE } from '../analytics/event-risk.ts'
import { shortDate } from '../analytics/levels.ts'
import type { EventRiskRow } from '../analytics/risk-wire.ts'
import { IST_OFFSET_MS, istClock, istDate } from '../routes/kit.ts'
import { contractText, type AlertKind, type OptType, type TraderLeg, type TraderOrder, type WatcherStatus } from '../types.ts'

export interface AlertDraft {
  /** The trader whose alert it is; null = admin-wide (every admin's phones and bell). */
  readonly trader: string | null
  readonly kind: AlertKind
  readonly stock: string | null
  readonly dedupeKey: string
  readonly title: string
  readonly body: string
  /** Under `/traders/`, the hash route of the book or page. */
  readonly url: string
  readonly at: number
}

/** Expiring ITM alerts start at 14:30 IST on the expiry day. */
export const ITM_FROM_MINUTES = 14 * 60 + 30
/** A watcher is offline after this long without a heartbeat... */
export const WATCHER_QUIET_MS = 10 * 60_000
/** ...counted from 09:00 IST, and alerted on until 15:45 IST, on a trading day. */
export const WATCHER_FROM_MINUTES = 9 * 60
export const WATCHER_UNTIL_MINUTES = 15 * 60 + 45
/** A book's band breach alerts at most once in this long. */
export const BAND_QUIET_MS = 30 * 60_000
/** Results-ahead alerts start at 09:15 IST on the trading day before the results. */
export const RESULTS_FROM_MINUTES = 9 * 60 + 15
/** What a rejected order's status says (ODIN's 'Rejected (6)', a canonical file's own word). */
export const REJECTED = /reject/i

const minuteOf = (ms: number): number => Math.floor((ms + IST_OFFSET_MS) / 60_000) % 1440

/** Midnight IST of the day `ms` falls on. */
export function istDayStart(ms: number): number {
  return Date.parse(`${istDate(ms)}T00:00:00Z`) - IST_OFFSET_MS
}
const bookUrl = (stock: string): string => `/traders/#/books/${encodeURIComponent(stock)}`
const int = (n: number): string => Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })
const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '-' : ''}${int(n)}`
const rupees = (v: number): string => `₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`
const price = (v: number): string => v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const lots = (n: number): string => `${n} ${n === 1 ? 'lot' : 'lots'}`

// ---- expiring ITM ------------------------------------------------------------------------

/** On an expiry day's session from 14:30 IST: when the runner reads the legs at all. */
export function itmWindow(nowMs: number): boolean {
  return marketOpenAt(nowMs) && minuteOf(nowMs) >= ITM_FROM_MINUTES
}

export interface ItmInput {
  readonly nowMs: number
  /** Open legs (qty ≠ 0), every trader's. */
  readonly legs: readonly Pick<TraderLeg, 'trader' | 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType' | 'qty'>[]
  /** The live spot; null = no price (the book is not judged). */
  readonly spotOf: (stock: string) => number | null
  /** A cash-settled index (true) or a physically settled stock (false). */
  readonly isIndex: (stock: string) => boolean
}

interface Contract { readonly label: string; readonly future: boolean; readonly strike: number; readonly optType: OptType | null; qty: number }

export function expiringItm(i: ItmInput): AlertDraft[] {
  if (!itmWindow(i.nowMs)) return []
  const today = istDate(i.nowMs)
  // trader|stock -> contract label -> net qty, across client codes and manual legs
  const books = new Map<string, { trader: string; stock: string; contracts: Map<string, Contract> }>()
  for (const l of i.legs) {
    if (l.qty === 0 || l.expiry !== today || l.instrument === 'share') continue
    if (l.instrument === 'option' && (l.strike === null || l.optType === null)) continue
    const k = `${l.trader}|${l.stock}`
    const book = books.get(k) ?? { trader: l.trader, stock: l.stock, contracts: new Map<string, Contract>() }
    books.set(k, book)
    const future = l.instrument === 'future'
    const label = future ? 'FUT' : `${l.strike as number} ${l.optType as OptType}`
    const c = book.contracts.get(label) ?? { label, future, strike: l.strike ?? 0, optType: l.optType, qty: 0 }
    c.qty += l.qty
    book.contracts.set(label, c)
  }

  const out: AlertDraft[] = []
  for (const { trader, stock, contracts } of books.values()) {
    const spot = i.spotOf(stock)
    if (spot === null || !(spot > 0)) continue
    const index = i.isIndex(stock)
    const itm: { c: Contract; intrinsic: number }[] = []
    for (const c of [...contracts.values()].sort((a, b) => a.strike - b.strike || a.label.localeCompare(b.label))) {
      if (c.qty === 0) continue
      if (c.future) {
        // a stock future is delivered whatever the price; an index future settles in cash like any other day
        if (!index) itm.push({ c, intrinsic: 0 })
        continue
      }
      const intrinsic = c.optType === 'CE' ? spot - c.strike : c.strike - spot
      if (intrinsic > 0) itm.push({ c, intrinsic })
    }
    if (itm.length === 0) continue
    const held = itm.map(({ c }) => `${c.label} ${signed(c.qty)}`).join(', ')
    let close: string
    if (index) {
      const cash = itm.reduce((s, { c, intrinsic }) => s + c.qty * intrinsic, 0)
      close = `cash settlement about ${cash >= 0 ? '+' : '-'}${rupees(cash)}`
    } else {
      // long CE / short PE take shares, long PE / short CE give them, a future takes its own sign (G2)
      const shares = itm.reduce((s, { c }) => s + (c.future || c.optType === 'CE' ? c.qty : -c.qty), 0)
      close = shares === 0 ? 'the deliveries net to 0 shares'
        : `${shares > 0 ? 'take' : 'give'} delivery of ${int(shares)} shares, about ${rupees(shares * spot)} at spot`
    }
    out.push({
      trader, kind: 'expiring-itm', stock,
      dedupeKey: `itm|${trader}|${stock}|${today}|${itm.map(({ c }) => c.label).join(',')}`,
      title: `${stock} expiring in the money`,
      body: `${held} expire today, in the money at spot ${price(spot)}. Held to the close: ${close}.`,
      url: bookUrl(stock), at: i.nowMs,
    })
  }
  return out
}

// ---- order rejected ------------------------------------------------------------------------

export interface RejectedInput {
  readonly nowMs: number
  readonly orders: readonly TraderOrder[]
  /** The IST day's start (`istDayStart`): an order last updated before it is history and never alerted. */
  readonly since: number
}

export function rejectedOrders(i: RejectedInput): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const o of i.orders) {
    if (!REJECTED.test(o.status) || !(o.updateTime >= i.since)) continue
    const at = o.price > 0 ? ` at ₹${price(o.price)}` : ''
    const what = `${o.side} ${int(o.qty)} ${o.stock} ${contractText(o)}${at}`
    const id = `${o.trader}|${o.day}|${o.orderNo}`
    out.push(
      { trader: o.trader, kind: 'order-rejected', stock: o.stock, dedupeKey: `rejected|${id}`, title: `Order rejected: ${o.stock}`, body: what, url: bookUrl(o.stock), at: i.nowMs },
      { trader: null, kind: 'order-rejected', stock: o.stock, dedupeKey: `admin|rejected|${id}`, title: `Order rejected: ${o.trader}, ${o.stock}`, body: what, url: '/traders/#/orders', at: i.nowMs },
    )
  }
  return out
}

// ---- watcher offline -----------------------------------------------------------------------

/** A trading day between 09:00 and 15:45 IST: when the runner reads the heartbeats at all. */
export function watcherWindow(nowMs: number): boolean {
  const m = minuteOf(nowMs)
  return isNseTradingDay(istDate(nowMs)) && m >= WATCHER_FROM_MINUTES && m < WATCHER_UNTIL_MINUTES
}

export interface WatcherInput {
  readonly nowMs: number
  /** Each enabled trader and the watcher's last heartbeat; null = no watcher ever set up (nothing to miss). */
  readonly watchers: readonly { readonly trader: string; readonly status: Pick<WatcherStatus, 'lastHeartbeatAt'> | null }[]
}

export function watcherOffline(i: WatcherInput): AlertDraft[] {
  if (!watcherWindow(i.nowMs)) return []
  const today = istDate(i.nowMs)
  const from = Date.parse(`${today}T00:00:00Z`) - IST_OFFSET_MS + WATCHER_FROM_MINUTES * 60_000
  const out: AlertDraft[] = []
  for (const { trader, status } of i.watchers) {
    if (status === null) continue
    const last = status.lastHeartbeatAt
    if (i.nowMs - Math.max(last, from) <= WATCHER_QUIET_MS) continue
    const since = !(last > 0) ? 'ever' : istDate(last) === today ? `${istClock(last)} IST` : `${istDate(last)} ${istClock(last)} IST`
    const id = `${trader}|${last}`   // the outage is its last heartbeat: one alert however many days it lasts
    out.push(
      {
        trader, kind: 'watcher-offline', stock: null, dedupeKey: `watcher|${id}`, title: 'Watcher offline',
        body: `No heartbeat from your watcher since ${since}: new ODIN files are not reaching the desk.`, url: '/traders/#/books', at: i.nowMs,
      },
      {
        trader: null, kind: 'watcher-offline', stock: null, dedupeKey: `admin|watcher|${id}`, title: `Watcher offline: ${trader}`,
        body: `No heartbeat since ${since}.`, url: '/traders/#/admin', at: i.nowMs,
      },
    )
  }
  return out
}

// ---- band breach ---------------------------------------------------------------------------

export interface BandInput {
  readonly events: readonly BandEvent[]
  /** When the book last raised a band-breach alert; null = never (or not in the quiet window's reach). */
  readonly lastAlertAt: (trader: string, stock: string) => number | null
}

export function bandBreaches(i: BandInput): AlertDraft[] {
  const last = new Map<string, number | null>()
  const out: AlertDraft[] = []
  for (const e of [...i.events].sort((a, b) => a.at - b.at)) {
    if (e.to !== 'out') continue
    const k = `${e.trader}|${e.stock}`
    const prev = last.has(k) ? (last.get(k) as number | null) : i.lastAlertAt(e.trader, e.stock)
    if (prev !== null && e.at - prev < BAND_QUIET_MS) continue
    last.set(k, e.at)
    out.push({
      trader: e.trader, kind: 'band-breach', stock: e.stock, dedupeKey: `band|${e.trader}|${e.stock}|${e.at}`,
      title: `${e.stock} out of band`,
      body: `Out of band by ${lots(e.outByLots)}: net delta ${signed(Math.round(e.netDelta))} shares against a band of ±${int(Math.round(e.bandShares))}.`,
      url: bookUrl(e.stock), at: e.at,
    })
  }
  return out
}

// ---- results ahead -------------------------------------------------------------------------

/** From 09:15 IST on the NSE trading day before `date` until `date` ends (a weekend between the two counts too). */
export function resultsWindow(nowMs: number, date: string): boolean {
  const today = istDate(nowMs)
  if (today > date) return false
  if (today === date) return true
  const before = previousTradingDay(date)
  if (before === '' || today < before) return false
  return today > before || minuteOf(nowMs) >= RESULTS_FROM_MINUTES
}

export interface ResultsInput {
  readonly nowMs: number
  /** Each trader's results-event rows (GET /events, the trader's own view) of the stocks the runner found due. */
  readonly rows: readonly { readonly trader: string; readonly row: EventRiskRow }[]
}

const pct1 = (x: number): string => `${(Math.abs(x) * 100).toFixed(1)}%`
const change = (v: number): string => `${v > 0 ? '+' : v < 0 ? '-' : ''}${rupees(v)}`

export function resultsAhead(i: ResultsInput): AlertDraft[] {
  const out: AlertDraft[] = []
  for (const { trader, row } of i.rows) {
    const n = row.next
    if (n === null || !n.heldThrough || !RESULTS_RE.test(n.purpose) || !resultsWindow(i.nowMs, n.date)) continue
    const series = n.expiry === null ? 'no listed expiry after it' : `the ${shortDate(n.expiry)} expiry${n.inNear ? ' (near)' : ''} carries it`
    const down = row.outcomes.find((o) => o.label === 'down')
    const up = row.outcomes.find((o) => o.label === 'up')
    const moves = down !== undefined && up !== undefined && down.change !== null && up.change !== null
      ? `Down ${pct1(down.move)}: ${change(down.change)}; up ${pct1(up.move)}: ${change(up.change)} (vol ${down.volPts} pts, the morning after).`
      : 'The book\'s change on a move is not known (see the Risk page).'
    out.push({
      trader, kind: 'results-ahead', stock: row.stock, dedupeKey: `results|${trader}|${row.stock}|${n.date}`,
      title: `${row.stock} results ${shortDate(n.date)}`,
      body: `Results ${shortDate(n.date)}; ${series}. ${moves}`,
      url: bookUrl(row.stock), at: i.nowMs,
    })
  }
  return out
}
