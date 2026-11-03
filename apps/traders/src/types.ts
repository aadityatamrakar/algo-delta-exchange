/**
 * The shared shapes of the traders app. No runtime imports: every consumer,
 * including tests and the page, can load this file for free.
 */

import type { PayoffView } from '@algomaker/payoff'

export type Role = 'trader' | 'admin'
export type PrincipalKind = 'trader' | 'admin' | 'watcher'
export interface Principal { readonly kind: PrincipalKind; readonly name: string }

export interface TraderUser {
  readonly username: string            // lower-case, [a-z0-9._-]{2,32}
  readonly passwordHash: string        // @algomaker/auth hashPassword
  readonly role: Role
  readonly disabled: boolean
  readonly createdAt: number
  readonly lastLoginAt: number | null
  readonly failedAttempts: number
  readonly lastFailureAt: number | null
  readonly lockedUntil: number | null
}

export interface WatcherToken {
  readonly trader: string
  readonly tokenHash: string           // sha256 hex of the token; the token itself is never stored
  readonly createdAt: number
  readonly lastUsedAt: number | null
  readonly revokedAt: number | null    // at most one token per trader has revokedAt === null
}

export type Instrument = 'option' | 'future' | 'share'
export type OptType = 'CE' | 'PE'

export interface TraderLeg {
  readonly trader: string
  readonly stock: string               // NSE symbol, upper-case: 'TCS'
  readonly instrument: Instrument
  readonly expiry: string              // 'YYYY-MM-DD'; '' for a share
  readonly strike: number | null       // null unless option
  readonly optType: OptType | null     // null unless option
  readonly qty: number                 // SIGNED shares (lots x lot size); negative = short
  readonly avgPrice: number            // per share, rupees
  readonly clientCode: string          // ODIN client code; '' for manual legs
  readonly source: 'odin' | 'manual'
  readonly key: string                 // odin: legKey(...); manual: 'manual:' + random id
  readonly token: number | null        // Kite instrument token; null = not matched
  readonly note: string
  readonly updatedAt: number
}

/** The stable key of an ODIN leg: same contract => same key across uploads. */
export function legKey(
  l: Pick<TraderLeg, 'clientCode' | 'instrument' | 'stock' | 'expiry' | 'strike' | 'optType'>,
): string {
  return `${l.clientCode}|${l.instrument}|${l.stock}|${l.expiry}|${l.strike ?? ''}|${l.optType ?? ''}`
}

/** Open = a non-zero quantity that has not expired. A share never expires. */
export function isOpenLeg(l: Pick<TraderLeg, 'qty' | 'instrument' | 'expiry'>, today: string): boolean {
  return l.qty !== 0 && (l.instrument === 'share' || l.expiry >= today)
}

/** How a contract reads in a table: '3500 CE 2026-10-27', 'FUT 2026-10-27', 'shares'. */
export function contractText(l: Pick<TraderLeg, 'instrument' | 'expiry' | 'strike' | 'optType'>): string {
  if (l.instrument === 'share') return 'shares'
  if (l.instrument === 'future') return `FUT ${l.expiry}`
  return `${l.strike ?? ''} ${l.optType ?? ''} ${l.expiry}`
}

export interface StoredFile {
  readonly trader: string
  readonly path: string                // relative to the watched folder, forward slashes
  readonly sha256: string
  readonly size: number
  readonly mtime: number               // ms, from the PC
  readonly receivedAt: number
  readonly parser: string | null       // id of the parser that took it; null = no parser matched
  readonly parseError: string | null
  readonly skipped?: readonly { readonly lineNo: number; readonly reason: string }[]   // first 20 lines the parser skipped (ParsedFile.skipped)
}

export interface TraderOrder {
  readonly trader: string; readonly orderNo: string; readonly exchOrderNo: string
  readonly clientCode: string; readonly stock: string; readonly instrument: Instrument
  readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  readonly side: 'Buy' | 'Sell'; readonly qty: number; readonly price: number
  readonly status: string; readonly reason: string; readonly time: number; readonly day: string
  readonly filledQty: number | null    // ODIN orders: filled quantity; null when the file has none
  readonly updateTime: number          // last update; an older order row never overwrites a newer one
}

export interface TraderTrade {
  readonly trader: string; readonly tradeNo: string; readonly orderNo: string
  readonly clientCode: string; readonly stock: string; readonly instrument: Instrument
  readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  readonly side: 'Buy' | 'Sell'; readonly qty: number; readonly price: number   // qty: positive shares; sign is in side
  readonly time: number; readonly day: string
  readonly seq: number                 // line number in its file; de-dup key is (trader, day, tradeNo, orderNo)
}

export interface LogLine { readonly trader: string; readonly day: string; readonly seq: number; readonly time: number; readonly text: string }

export interface WatcherStatus {
  readonly lastHeartbeatAt: number
  readonly lastUploadAt: number | null
  readonly version: string
  readonly folder: string
  readonly fileCount: number
}

/** A book's delta band (R3 item 30): inside it, past it, or not known (blocked, a dead feed, a leg with no IV). */
export type BandState = 'in' | 'out' | 'unknown'

export interface BookSummary {
  readonly stock: string
  readonly legCount: number
  readonly mismatch: string | null
  readonly lastFileAt: number | null
  readonly band: BandState | null      // the band board's last reading; null = not read since the app started
}

export interface AdminTraderRow {
  readonly username: string
  readonly disabled: boolean
  readonly lastLoginAt: number | null
  readonly watcher: WatcherStatus | null
  readonly token: { readonly createdAt: number; readonly lastUsedAt: number | null } | null
}

export interface ManualLegInput {
  readonly stock: string
  readonly instrument: Instrument
  readonly expiry: string
  readonly strike: number | null
  readonly optType: OptType | null
  readonly qty: number
  readonly avgPrice: number
  readonly note: string
}

export interface LegView {
  readonly key: string; readonly source: 'odin' | 'manual'
  readonly clientCode: string; readonly note: string; readonly lotSize: number | null
  readonly instrument: Instrument; readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  readonly qty: number; readonly avgPrice: number
  readonly ltp: number | null; readonly iv: number | null      // iv decimal; null = unpriceable
  readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number   // position greeks (x qty)
  readonly mtm: number | null; readonly matched: boolean
}

/**
 * One expiry series of a book (analytics/series-pnl.ts): every contract of the stock with that expiry, across the
 * trader's client codes, open and closed, from the first trade the app holds. Money in rupees, before tax.
 */
export interface SeriesPnl {
  readonly expiry: string
  /** Σ (LTP − net price) × qty over the expiry's open legs: the GrossMTM column. Null = an open leg has no LTP (`noLtp`). */
  readonly open: number | null
  /** What every cycle closed flat at a day's end realised (the ledger's reset rule): Σ −value at that close. */
  readonly booked: number
  /** open + booked; null with `open`. */
  readonly gross: number | null
  /** `chargesFor` over every fill of the series' trades: an estimate until the admin confirms the rates. */
  readonly charges: number
  /** gross − charges; null with `open`. */
  readonly net: number | null
  /** Cycles closed (a contract closed twice counts twice). */
  readonly closedContracts: number
  readonly openLegs: number
  /** The series' first trade day the app holds; null = none (only balance or manual legs). */
  readonly from: string | null
  /** The day the trade history starts, when that is later than about the series' month start: `booked` counts from it. */
  readonly since: string | null
  /** The keys of the open legs with no LTP. */
  readonly noLtp: readonly string[]
  readonly notes: readonly string[]
}

/** The book's live series together. */
export interface SeriesTotal {
  readonly open: number | null; readonly booked: number; readonly gross: number | null
  readonly charges: number; readonly net: number | null
  readonly closedContracts: number; readonly from: string | null
  /** The admin has saved the rates: `charges` is not an estimate. */
  readonly ratesConfirmed: boolean
  readonly notes: readonly string[]
}

export interface BookView {
  readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly spot: number | null; readonly futures: Readonly<Record<string, number | null>>   // expiry -> that expiry's own future mark; null for a weekly with no future
  readonly forwards: Readonly<Record<string, number | null>>  // expiry -> the forward used: own future, else put-call-parity forward, else spot carried
  readonly legs: readonly LegView[]
  readonly totals: { readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number; readonly mtm: number }
  readonly payoff: PayoffView | null        // from @algomaker/payoff, valued per leg on its own expiry
  readonly unmatched: readonly string[]     // one line per row we could not match
  readonly mismatch: string | null          // reserved; always null in R1 — ODIN writes no net-position file to compare against
  readonly historyFrom: string | null       // YYYY-MM-DD of the earliest ODIN trade file seen; legs opened before it are manual
  readonly warnings: readonly string[]      // dead feed, watcher offline, last file did not parse, ...
  /** One per live expiry the trader has held or traded in this stock, by expiry. Optional: an older server sends none. */
  readonly series?: readonly SeriesPnl[]
  readonly seriesTotal?: SeriesTotal
}

/** An out-of-page alert (spec 2026-10-23-traders-gaps G7; alerts/rules.ts). */
export type AlertKind = 'expiring-itm' | 'order-rejected' | 'watcher-offline' | 'band-breach' | 'results-ahead'

/**
 * One stored alert as the bell reads it (`GET /v1/traders/alerts`): the title, body and link the phones were sent.
 * The text carries stocks, strikes, quantities and rupees, never a client code; only an admin's (`admin: true`) names
 * a trader.
 */
export interface TraderAlert {
  readonly kind: AlertKind
  readonly stock: string | null
  readonly title: string
  readonly body: string
  /** Under `/traders/`: the book, or the page, the alert is about. */
  readonly url: string
  readonly at: number
  /** When it reached at least one phone; null = no phone subscribed, or every send failed. */
  readonly sentAt: number | null
  /** An admin-wide alert (every trader's rejections and watchers), not a trader's own. */
  readonly admin: boolean
}
