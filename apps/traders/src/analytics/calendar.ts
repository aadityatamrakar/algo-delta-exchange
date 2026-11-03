/**
 * The NSE trading day after or before a day, the day of the next open, and
 * whether the market is open at a moment, on the desk's own calendar plus
 * NSE's 2025 holidays (`isNseTradingDay`: weekends and the 2025 and 2026
 * holidays; outside those years it knows only weekends). The Gap Up/Down panel
 * values at the next open; yesterday's close comes from the previous trading
 * day's end-of-day files.
 */

import { FNO_CLOSE_MIN } from '@algomaker/core'
import { isTradingDay } from '@algomaker/desk-engine'
import { IST_OFFSET_MS, isIsoDate, istDate } from '../routes/kit.ts'

/**
 * NSE's published 2025 trading holidays (equity and F&O). The desk engine's calendar (the live desk's) knows 2026
 * only; the daily history reaches back into 2025, where a holiday must not read as a missing day.
 */
export const NSE_HOLIDAYS_2025: ReadonlySet<string> = new Set([
  '2025-02-26', // Mahashivratri
  '2025-03-14', // Holi
  '2025-03-31', // Id-Ul-Fitr (Ramadan Eid)
  '2025-04-10', // Shri Mahavir Jayanti
  '2025-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2025-04-18', // Good Friday
  '2025-05-01', // Maharashtra Day
  '2025-08-15', // Independence Day
  '2025-08-27', // Ganesh Chaturthi
  '2025-10-02', // Mahatma Gandhi Jayanti / Dussehra
  '2025-10-21', // Diwali Laxmi Pujan (muhurat session only)
  '2025-10-22', // Diwali Balipratipada
  '2025-11-05', // Prakash Gurpurb Sri Guru Nanak Dev
  '2025-12-25', // Christmas
])

/**
 * A weekday NSE trades on: the desk engine's calendar (weekends, 2026) and NSE's 2025 holidays.
 *
 * TODO(2027): NSE has not published its 2027 holidays yet. Until they are added here (or to the desk engine), every
 * 2027 weekday reads as a trading day. Expiry settlement's record guard (ingest/settlement.ts) then sees a 2027
 * holiday as a day with no trade, and holds a contract open across it.
 */
export function isNseTradingDay(day: string): boolean {
  return isTradingDay(day) && !NSE_HOLIDAYS_2025.has(day)
}

/** No run of closed days is this long: the bound that keeps a bad day from spinning. */
const MAX_STEPS = 30
const DAY_MS = 86_400_000
/** NSE's open, 09:15 IST, in minutes after midnight. */
const OPEN_MINUTES = 9 * 60 + 15
/**
 * NSE's F&O close, 15:40 IST since 3 Aug 2026 (core's `FNO_CLOSE_MIN`), and the instant a contract expires: the
 * greeks price to it. Core's `MARKET_CLOSE_MIN` and the desk engine's `DECISIONS_END_MIN` stay 15:30: that is where
 * the live desk stops trading, not where F&O does.
 */
export const CLOSE_MINUTES = FNO_CLOSE_MIN
/** NSE's cash closing auction for F&O stocks starts at 15:15 IST (since 3 Aug 2026). */
const CLOSING_AUCTION_MINUTES = 15 * 60 + 15

function istMinutes(ms: number): number {
  const ist = new Date(ms + IST_OFFSET_MS)
  return ist.getUTCHours() * 60 + ist.getUTCMinutes()
}

/** '' when `day` is not a date, or no trading day is found within the bound. */
function step(day: string, dir: 1 | -1): string {
  if (!isIsoDate(day)) return ''
  let t = Date.parse(`${day}T00:00:00Z`)
  for (let i = 0; i < MAX_STEPS; i++) {
    t += dir * DAY_MS
    const d = new Date(t).toISOString().slice(0, 10)
    if (isNseTradingDay(d)) return d
  }
  return ''
}

export function nextTradingDay(day: string): string {
  return step(day, 1)
}

export function previousTradingDay(day: string): string {
  return step(day, -1)
}

/** The session a day's figures are of: the day itself when it trades, else the last trading day before it. */
export function sessionDay(day: string): string {
  return isNseTradingDay(day) ? day : previousTradingDay(day)
}

/**
 * The day of the next 09:15 IST open from `nowMs`: today while it is a trading
 * day and the open is still ahead — on an expiry morning its legs then still
 * have the day — else the next trading day.
 */
export function nextOpenDay(nowMs: number): string {
  const today = istDate(nowMs)
  const beforeOpen = istMinutes(nowMs) < OPEN_MINUTES
  return beforeOpen && isNseTradingDay(today) ? today : nextTradingDay(today)
}

/**
 * In session at `ms`: 09:15 to before 15:40 IST on an NSE trading day (the desk's
 * `isNseTradingDay`: on a weekday holiday a weekday check alone would read a quiet
 * feed as a dead one). Every "is the market open" in this app asks here.
 */
export function marketOpenAt(ms: number): boolean {
  const m = istMinutes(ms)
  return isNseTradingDay(istDate(ms)) && m >= OPEN_MINUTES && m < CLOSE_MINUTES
}

/**
 * In session and from 15:15 IST: a stock with derivatives no longer trades continuously in the cash market
 * (its closing auction matches once, 15:30 to 15:35), so its spot stops ticking while its F&O still trades.
 */
export function closingAuctionAt(ms: number): boolean {
  return marketOpenAt(ms) && istMinutes(ms) >= CLOSING_AUCTION_MINUTES
}
