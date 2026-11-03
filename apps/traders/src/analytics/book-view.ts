/**
 * What a trader sees on a stock's tab: every open leg priced (LTP, IV off its
 * own month's chain against that month's forward, position greeks, MTM), the
 * totals, a multi-month payoff, the rows we could not match, where the trade
 * history starts, and warnings that say exactly what is not live or not known.
 *
 * `bookView` is pure. `buildBookView` reads the stores and caches the payoff.
 * Each live expiry's series P&L (series-pnl.ts) rides along when its inputs
 * are given: its open part is the legs' own MTM column, so the two agree.
 * A leg stored without a token (its contract was not in the master when its
 * file was applied) is matched again here against today's master; one that
 * still does not match is listed as not understood and kept out of every
 * number, never dropped.
 *
 * Expired contracts (spec 2026-10-23 G2): the ledger settles them at NSE's
 * final settlement, so an expired leg that is still open here is one the
 * settlement could not price, and the tab says why. Shares a stock contract
 * delivered are in the share leg, and the tab says from which expiry and at
 * what price, and warns when a manual share leg sits beside them.
 */

import { buildMultiMonthView, legGreeks, liquidIv } from '@algomaker/payoff'
import type { MultiMonthInputs, PayoffLeg, PayoffView } from '@algomaker/payoff'
import type { LegStore } from '../books/legs.ts'
import type { FileStore } from '../ingest/files.ts'
import type { LedgerStore } from '../ingest/ledger-store.ts'
import type { SettlementRun } from '../ingest/settlement.ts'
import { lotSizeOf, matchLeg, notUnderstood, spotTokenOf, type TradersMaster } from '../market/master.ts'
import { FEED_NOT_TICKING, type TradersQuotes } from '../market/quotes.ts'
import { IST_OFFSET_MS, istClock, istDate } from '../routes/kit.ts'
import { contractText, isOpenLeg } from '../types.ts'
import type { BookView, LegView, StoredFile, TraderLeg, WatcherStatus } from '../types.ts'
import type { WatcherStatusStore } from '../watcher-status.ts'
import { closingAuctionAt, marketOpenAt } from './calendar.ts'
import { monthQuotes, monthWarning, type MonthQuotes } from './month-chain.ts'
import type { PayoffCache } from './payoff-cache.ts'
import { seriesPnl, type SeriesBase, type SeriesReader } from './series-pnl.ts'
import { toPayoffLeg } from './snapshot.ts'

export const WATCHER_OFFLINE_MS = 180_000
/** `ingest/pipeline.ts` keeps the first 20 skipped lines of a file; a full list may stand for more. */
const SKIPPED_KEPT = 20
/** Problem files named on the tab; the rest are counted and left to `GET /v1/traders/files`, which lists every file. */
const FILE_WARNINGS_SHOWN = 5
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export interface BookViewInputs {
  readonly stock: string
  readonly legs: readonly TraderLeg[]
  readonly master: TradersMaster
  readonly quotes: TradersQuotes
  readonly asOf: number
  readonly watcher: WatcherStatus | null
  /** The trader's files; only those whose last parse failed or skipped lines are named (they never age out). */
  readonly files: readonly StoredFile[]
  /** How many problem files there are in all, when `files` holds only the newest of them. */
  readonly problemFiles?: number
  readonly historyFrom: string | null
  readonly payoff: (i: MultiMonthInputs) => PayoffView | null
  /** TRADERS_MAX_TOKENS when the last declaration narrowed this book's ATM window to fit it, else null. */
  readonly feedCap?: number | null
  /** The series' trades, balance, history and rates, for `trader`; absent = the view carries no series (an older bag, a group's subset). */
  readonly series?: SeriesBase & { readonly trader: string }
  /** The trader's expiry settlement as the ledger last made it (LedgerStore.settlement); absent = none. */
  readonly settlement?: SettlementRun
}

interface Greeks { delta: number; gamma: number; vega: number; theta: number }
const ZERO: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 }

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)
const INSTRUMENT_RANK = { future: 0, option: 1, share: 2 } as const

/** By expiry (shares last), futures before options, strike, CE before PE, key. */
function bookOrder(a: TraderLeg, b: TraderLeg): number {
  return cmp(a.instrument === 'share' ? 1 : 0, b.instrument === 'share' ? 1 : 0)
    || cmp(a.expiry, b.expiry)
    || cmp(INSTRUMENT_RANK[a.instrument], INSTRUMENT_RANK[b.instrument])
    || cmp(a.strike ?? 0, b.strike ?? 0)
    || cmp(a.optType === 'PE' ? 1 : 0, b.optType === 'PE' ? 1 : 0)
    || cmp(a.key, b.key)
}

/** How the view names a spot and a held month's future in its stale-price line. */
export const spotPriceName = (stock: string): string => `${stock} spot`
export const futurePriceName = (stock: string, expiry: string): string => `${stock} FUT ${expiry}`

/** The stale-price line up to the last tick's time: `<name> price is stale — last tick HH:MM`. The band reads it (`risk.ts`). */
export function stalePricePrefix(name: string): string {
  return `${name} price is stale — last tick `
}

/** When the quote's last tick was, if the cache calls it stale; null for a fresh quote or none. */
function staleSince(q: TradersQuotes, token: number | null | undefined): number | null {
  if (token === null || token === undefined) return null
  const quote = q.quote(token)
  return quote?.stale === true ? quote.asOf : null
}

function priceOf(q: TradersQuotes, token: number | null): number | null {
  if (token === null) return null
  const p = q.quote(token)?.price
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null
}

export const SETTLEMENT_NOTE =
  'settlement takes every ITM stock option as exercised, and charges no exercise STT or stamp duty on delivery'

const rupees = (x: number): string => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The expired legs the book hides, and why: the settlement's reason for each it could not price (one line per
 * reason), the ones it has not seen (legs stored before it ran) and manual ones (never settled). Then the shares the
 * settlement delivered into an open share leg of this book, and a manual share leg beside them (a possible double
 * count: a trader who typed the delivery in by hand before G2 now has it twice).
 */
function settlementLines(stock: string, legs: readonly TraderLeg[], today: string, s: SettlementRun | null): string[] {
  const out: string[] = []
  const reasons = new Map((s?.unsettled ?? []).filter((u) => u.stock === stock).map((u) => [u.key, u.reason]))
  const byReason = new Map<string, number>()
  let unseen = 0
  let manual = 0
  for (const l of legs) {
    if (l.qty === 0 || isOpenLeg(l, today)) continue
    const reason = reasons.get(l.key)
    if (l.source === 'manual') manual++
    else if (reason === undefined) unseen++
    else byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  for (const [reason, n] of [...byReason].sort(([a], [b]) => cmp(a, b))) out.push(`${n} expired leg(s) hidden — not settled: ${reason}`)
  if (unseen > 0) out.push(`${unseen} expired leg(s) hidden — not settled yet: the ledger settles them when it next reads the NSE history`)
  if (manual > 0) out.push(`${manual} expired leg(s) hidden — manual legs are never settled: delete them, and add a manual share leg for any delivery`)

  const shareLegs = legs.filter((l) => l.instrument === 'share' && l.qty !== 0)
  const odinShares = new Set(shareLegs.filter((l) => l.source === 'odin').map((l) => l.key))
  const all = (s?.deliveries ?? []).filter((d) => d.stock === stock)
  const delivered = new Map<string, { expiry: string; price: number; shares: number }>()
  for (const d of all) {
    if (!odinShares.has(d.key)) continue   // delivered and since sold: nothing of it is in the book
    const k = `${d.expiry}|${d.price}`
    const g = delivered.get(k)
    if (g === undefined) delivered.set(k, { expiry: d.expiry, price: d.price, shares: d.shares })
    else g.shares += d.shares
  }
  const lines = [...delivered.values()].sort((a, b) => cmp(b.expiry, a.expiry))
  for (const g of lines) {
    out.push(`delivered shares from the ${g.expiry} expiry are in the book at ${rupees(g.price)} (${g.shares > 0 ? '+' : ''}${g.shares} shares)`)
  }
  if (lines.length > 0) out.push(SETTLEMENT_NOTE)
  if (all.length > 0 && shareLegs.some((l) => l.source === 'manual')) {
    out.push('a manual share leg is in this book beside delivered shares the settlement booked — if it stands for that delivery, the shares are counted twice: delete it')
  }
  return out
}

/** IST `HH:MM` today, `DD Mon HH:MM` on any other day. */
function fileTime(ms: number, today: string): string {
  if (istDate(ms) === today) return istClock(ms)
  const d = new Date(ms + IST_OFFSET_MS)
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${istClock(ms)}`
}

function fileProblem(f: StoredFile, today: string): string | null {
  if (f.parseError !== null) {
    const reason = f.parseError.startsWith('internal:') ? 'internal error — the server will retry' : f.parseError
    return `${f.path} did not parse at ${fileTime(f.receivedAt, today)}: ${reason} — showing the last good one`
  }
  const s = f.skipped ?? []
  const first = s[0]
  if (first === undefined) return null
  const n = s.length >= SKIPPED_KEPT ? `${SKIPPED_KEPT} or more lines` : s.length === 1 ? '1 line' : `${s.length} lines`
  return `${n} of ${f.path} ${s.length === 1 ? 'was' : 'were'} skipped: line ${first.lineNo}: ${first.reason}`
}

/** One line per problem file, newest first, at most five, then how many more. */
function fileWarnings(files: readonly StoredFile[], total: number | undefined, today: string): string[] {
  const lines = [...files]
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .flatMap((f) => fileProblem(f, today) ?? [])
  const more = Math.max(total ?? 0, lines.length) - FILE_WARNINGS_SHOWN
  const out = lines.slice(0, FILE_WARNINGS_SHOWN)
  if (more > 0) out.push(`and ${more} more ${more === 1 ? 'file' : 'files'} with problems — /v1/traders/files lists every file`)
  return out
}

export function bookView(i: BookViewInputs): BookView {
  const m = i.master
  const today = istDate(i.asOf)
  const closed = !marketOpenAt(i.asOf)
  const open = i.legs.filter((l) => isOpenLeg(l, today)).sort(bookOrder)
  const spot = priceOf(i.quotes, spotTokenOf(m, i.stock))

  const resolved = open.map((leg) => ({ leg, token: leg.token ?? matchLeg(m, leg) }))
  // One solve per held month, each against its own forward (the legs are in expiry order already).
  const months = new Map<string, MonthQuotes>()
  for (const { leg, token } of resolved) {
    if (token === null || leg.instrument === 'share' || months.has(leg.expiry)) continue
    months.set(leg.expiry, monthQuotes(m, i.quotes, i.stock, leg.expiry, spot, i.asOf, closed))
  }

  const legs: LegView[] = []
  const unmatched: string[] = []
  const legWarnings: string[] = []
  const priced: PayoffLeg[] = []
  const totals = { delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0 }
  for (const { leg, token } of resolved) {
    const base = {
      key: leg.key, source: leg.source, clientCode: leg.clientCode, note: leg.note, lotSize: lotSizeOf(m, leg),
      instrument: leg.instrument, expiry: leg.expiry, strike: leg.strike, optType: leg.optType, qty: leg.qty, avgPrice: leg.avgPrice,
    }
    if (token === null) {
      unmatched.push(notUnderstood(leg))
      legs.push({ ...base, ltp: null, iv: null, ...ZERO, mtm: null, matched: false })
      continue
    }
    const ltp = priceOf(i.quotes, token)
    const mtm = ltp === null ? null : (ltp - leg.avgPrice) * leg.qty
    const month = months.get(leg.expiry)
    // A share with no spot, or a leg whose month has no price, is already named by its book or month line.
    const covered = leg.instrument === 'share' ? spot === null : month === undefined || month.forward === null
    if (ltp === null && !covered) legWarnings.push(`${contractText(leg)}: no price yet — left out of Today and Leg P&L`)
    let iv: number | null = null
    let g: Greeks = { ...ZERO, delta: leg.qty }
    if (leg.instrument === 'option') {
      g = ZERO
      if (month !== undefined && leg.strike !== null && leg.optType !== null) {
        iv = liquidIv(month.ivs, leg.strike, leg.optType, false).iv
        if (month.forward !== null && iv !== null) g = legGreeks(toPayoffLeg(leg, iv), month.forward, month.tYears)
        else if (month.forward !== null) {
          legWarnings.push(month.tYears === 0
            ? `${contractText(leg)}: expired at today's close — left out of the greeks`
            : `${contractText(leg)}: no vol solved from the ${leg.expiry} chain — left out of the greeks`)
        }
      }
    }
    legs.push({ ...base, ltp, iv, delta: g.delta, gamma: g.gamma, vega: g.vega, theta: g.theta, mtm, matched: true })
    totals.delta += g.delta; totals.gamma += g.gamma; totals.vega += g.vega; totals.theta += g.theta
    if (mtm !== null) totals.mtm += mtm
    const priceable = leg.instrument === 'share' ? spot !== null : month !== undefined && month.forward !== null
    if (priceable) priced.push(toPayoffLeg(leg, iv))
  }

  const expiries = [...months.keys()].sort()
  const futures: Record<string, number | null> = {}
  const forwards: Record<string, number | null> = {}
  const pricedForwards: Record<string, number> = {}
  for (const e of expiries) {
    const mq = months.get(e) as MonthQuotes
    futures[e] = mq.future
    forwards[e] = mq.forward
    if (mq.forward !== null) pricedForwards[e] = mq.forward
  }

  const warnings: string[] = []
  // A closed market is not a warning: the page prints it from `closed`.
  const feedDead = !closed && !i.quotes.feedAlive()
  if (feedDead) warnings.push(FEED_NOT_TICKING)
  if (i.watcher === null) warnings.push('no watcher has reported for this trader yet — positions come only from manual uploads')
  else if (i.asOf - i.watcher.lastHeartbeatAt > WATCHER_OFFLINE_MS) {
    warnings.push(`the watcher has not reported since ${istClock(i.watcher.lastHeartbeatAt)} — positions may be out of date`)
  }
  warnings.push(...fileWarnings(i.files, i.problemFiles, today))
  if (spot === null) warnings.push(`no spot price for ${i.stock} yet`)
  // In session, while the feed ticks, a spot or held month's future that has not is named (a dead feed is said once above);
  // the spot only until the 15:15 closing auction, from which it stops ticking by design.
  const stale = (name: string, since: number | null) => { if (since !== null) warnings.push(`${stalePricePrefix(name)}${istClock(since)}`) }
  if (!closed && !feedDead && !closingAuctionAt(i.asOf)) stale(spotPriceName(i.stock), staleSince(i.quotes, spotTokenOf(m, i.stock)))
  for (const e of expiries) {
    const mq = months.get(e) as MonthQuotes
    const line = monthWarning(mq)
    if (line !== null) warnings.push(line)
    if (!closed && !feedDead) stale(futurePriceName(i.stock, e), staleSince(i.quotes, m.options.future(i.stock, e)?.instrumentToken))
  }
  if (typeof i.feedCap === 'number') warnings.push(`price coverage reduced — the traders feed cap (${i.feedCap} tokens) is reached`)
  warnings.push(...legWarnings)
  warnings.push(...settlementLines(i.stock, i.legs, today, i.settlement ?? null))

  // the payoff stays VolHedge's open-leg view (realised 0); what the series booked is beside it, never in its curve
  const series = i.series === undefined ? null : seriesPnl({
    ...i.series, stock: i.stock, today, legs,
    lotSizeOf: (instrument, expiry) => lotSizeOf(m, { stock: i.stock, instrument, expiry, strike: null, optType: null }),
  })

  return {
    stock: i.stock, asOf: i.asOf, closed, spot, futures, forwards, legs, totals,
    payoff: priced.length === 0 ? null : i.payoff({ legs: priced, futures: pricedForwards, spot, today, realised: 0, targetPnl: null }),
    unmatched, mismatch: null, historyFrom: i.historyFrom, warnings,
    ...(series === null ? {} : { series: series.series, seriesTotal: series.total }),
  }
}

export interface BookViewDeps {
  legs: LegStore; ledger: LedgerStore; files: FileStore; status: WatcherStatusStore
  master: () => TradersMaster; quotes: TradersQuotes; payoffCache: PayoffCache
  /** See `BookViewInputs.feedCap`. */
  feedCap?: (stock: string) => number | null
  /** The series' inputs; absent = no series on the view. */
  series?: SeriesReader
}

/** Null when the trader has no open leg in `stock` (within `keys`, when given). */
export async function buildBookView(
  d: BookViewDeps, trader: string, stock: string, nowMs: number, opts: { keys?: ReadonlySet<string> } = {},
): Promise<BookView | null> {
  // Read before the legs: a write landing between the two reads then misses this key, and the next read rebuilds.
  const version = d.legs.version(trader)
  const keys = opts.keys
  // a subset of the legs (a group) has no series of its own: the series is every contract of the expiry
  const seriesOf = keys === undefined ? d.series : undefined
  const [all, historyFrom, watcher, problems, series, settlement] = await Promise.all([
    d.legs.open(trader, stock), d.ledger.historyFrom(trader), d.status.get(trader), d.files.problems(trader, FILE_WARNINGS_SHOWN + 1),
    seriesOf?.(trader, stock, version, nowMs), d.ledger.settlement(trader),
  ])
  const legs = keys === undefined ? all : all.filter((l) => keys.has(l.key))
  const today = istDate(nowMs)
  if (!legs.some((l) => isOpenLeg(l, today))) return null
  const cacheKey = `${trader}|${stock}|${version}|${keys === undefined ? '*' : [...keys].sort().join(',')}`
  return bookView({
    stock, legs, master: d.master(), quotes: d.quotes, asOf: nowMs, watcher,
    files: problems.files, problemFiles: problems.total, historyFrom, feedCap: d.feedCap?.(stock) ?? null, settlement,
    ...(series === undefined ? {} : { series: { ...series, trader } }),
    payoff: (inputs) => d.payoffCache.get(cacheKey, () => buildMultiMonthView(inputs)),
  })
}
