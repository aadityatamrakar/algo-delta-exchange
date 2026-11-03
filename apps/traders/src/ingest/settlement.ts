/**
 * Expiry settlement (spec 2026-10-23-traders-gaps G1/G2): ODIN never sends a closing trade for a contract held to
 * expiry, so the ledger would keep it open forever, and the shares a stock contract delivers would never appear.
 * `settlementOf` makes the fills NSE's final settlement would have made. They are derived at read time from NSE
 * history and never stored, so a late history file or a corrected one changes the answer on the next walk. Pure, no IO.
 *
 *   option   one fill closing the net qty q at intrinsic: CE max(0, S − K), PE max(0, K − S).
 *   future   one fill closing q at S.
 *   delivery a stock (not an index) is physically settled. An ITM option or a future adds one `share` fill at S on
 *            the key ODIN's equity trades use (expiry '', strike null, optType null), so it nets with the cash-market
 *            sells that follow. Long CE / short PE takes delivery (+), long PE / short CE gives it (−), a future +q.
 *            Paying K for the shares is the option fill at S − K plus the share fill at S; nothing else is needed.
 *
 * What is NOT modelled, said where the book shows a delivery: every ITM stock option is taken as exercised (no
 * do-not-exercise), and settlement fills carry no charges (exercise STT and delivery stamp duty are left out).
 *
 * A contract settles when its net qty at the END of its expiry day is not 0 and that day's close S is known. An expiry
 * before `today` with no S is *unsettled*: it stays open (hidden by `isOpenLeg`) and is reported with its reason. An
 * expiry of `today` settles once its close exists (the span job writes it in the evening) and is not reported before.
 *
 * Timing. `ledgerWalk` orders by day, then `time` (epoch ms), then `seq` (the line in the file). A fill is dated on its
 * expiry day at the last millisecond of that IST day with seq MAX_SAFE_INTEGER. A real trade's `day` is `istDate(time)`
 * and ODIN times are whole seconds, so every real trade of the day sorts before it.
 *
 * The opening-balance edge. A balance is the positions at the CLOSE of its day, and the walk drops anything dated on
 * or before that day. So a contract in the balance that expired on or before it cannot be settled on its own day. It
 * is still settled honestly, at its expiry day's close S, but dated the first day after the balance, at that day's
 * 00:00 IST with seq −1. That puts it before every real trade the walk sees, which is when the position was already
 * settled. Leaving it open would keep a dead contract in the book forever.
 *
 * Client codes are upper-cased, as LedgerStore reads them (a hand-typed `c0001` is ODIN's `C0001`), so a caller that
 * hands in raw trades gets fills on the ledger's own keys.
 *
 * The record guard (23 Oct, after the live check). Settling books the whole open cycle at S. If the cycle's qty is
 * wrong, that booking is a loss or gain that never happened. On live data one stored day (lalit's 24 Sep 2025, and
 * jignesh's 28 Aug 2026) has filled orders and no trades: its trade file never arrived. With a `TradeRecord`, a
 * contract is NOT settled, and is reported unsettled with the reason, when:
 *   - it was listed before the trader's record starts and there is no opening balance. Then a position opened
 *     before the record can ride into any later cycle: short 350 before the record, Buy 175 inside it, and the walk
 *     reads long +175. Every cycle of such a contract is held, and a positions file for the day before the record
 *     settles it. Listing is taken as three monthly expiries back (NSE's three serial months). Neither the master
 *     (live contracts only) nor the history (the near expiry only) knows an expired contract's listing.
 *   - a trading day between its open cycle's first trade and its expiry has no F&O trade of the trader's on the
 *     contract's exchange. A missing file may hold a closing trade. A share trade or the other exchange's file
 *     says nothing of this one's.
 * A trader who did not trade on such a day reads the same as a missing file. The guard cannot tell them apart, so
 * it holds the contract and says why. A missing number is said, never invented.
 */

import { INDEX_SPOT_TOKENS } from '@algomaker/instruments'
import { isNseTradingDay, previousTradingDay } from '../analytics/calendar.ts'
import type { TradersMaster } from '../market/master.ts'
import { legKey, type Instrument, type OptType } from '../types.ts'
import type { LedgerTrade, OpeningBalance } from './ledger.ts'

/** Final settlement price of `stock` on `day` (IST), from NSE history; null = not known. */
export type SettlementPrice = (stock: string, day: string) => number | null
/** true = cash-settled index; false = a stock (physically settled). */
export type IsIndex = (stock: string) => boolean

export interface SettlementFill extends LedgerTrade { readonly settlement: true }
export interface Unsettled {
  readonly key: string; readonly stock: string; readonly expiry: string; readonly qty: number; readonly reason: string
}
export interface Settlement { readonly fills: readonly SettlementFill[]; readonly unsettled: readonly Unsettled[] }

/** A SettlementPrice that can also say why a price is missing. `priceFromHistory` returns one. */
export interface ExplainedPrice extends SettlementPrice {
  /** Why `stock` has no settlement price on `day`, without the stock's name (the reader is on its book). */
  readonly missing: (stock: string, day: string) => string
}

/** Shares a stock contract delivered at its expiry: one per settled contract that made a `share` fill. */
export interface Delivery {
  /** The share leg's key (`clientCode|share|STOCK|||`). */
  readonly key: string
  readonly stock: string
  readonly expiry: string
  /** Signed shares: + taken into the account, − given out of it. */
  readonly shares: number
  /** S: the expiry day's close the shares came in at. */
  readonly price: number
  /** The settled contract's key. */
  readonly from: string
}

/** `settlementOf` with the deliveries it made, which the book view names. */
export interface SettlementRun extends Settlement { readonly deliveries: readonly Delivery[] }

/** The exchange an F&O contract trades on: ODIN writes each to its own trade file. */
export type FnoExchange = 'NSE' | 'BSE'
/** BSE's F&O underlyings the traders hold (the BSE trade parser reads index options only). */
const BSE_FNO: ReadonlySet<string> = new Set(['SENSEX', 'BANKEX', 'SENSEX50'])
export const exchangeOf = (stock: string): FnoExchange => (BSE_FNO.has(stock) ? 'BSE' : 'NSE')

/** What the trader's trade record covers, for the record guard. LedgerStore builds it from every trade it holds. */
export interface TradeRecord {
  /** Per exchange, every day with at least one stored F&O trade of the trader's there. */
  readonly days: Readonly<Record<FnoExchange, ReadonlySet<string>>>
  /** The record's first day: the earliest ODIN trade file's (LedgerStore.historyFrom), else the first trade's; null = none. */
  readonly from: string | null
}

/** The record of these trades (every trade the trader has), starting at `from`, else at the first trade. */
export function tradeRecordOf(
  trades: readonly Pick<LedgerTrade, 'day' | 'stock' | 'instrument'>[], from: string | null,
): TradeRecord {
  const days = { NSE: new Set<string>(), BSE: new Set<string>() }
  let first: string | null = null
  for (const t of trades) {
    if (first === null || t.day < first) first = t.day
    if (t.instrument !== 'share') days[exchangeOf(t.stock)].add(t.day)
  }
  return { days, from: from ?? first }
}

/** Approximately when a contract expiring on `expiry` listed: three monthly expiries back (NSE's three serial months). */
export function listedAbout(expiry: string): string {
  const d = new Date(`${expiry}T00:00:00Z`)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 3)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}

const DAY_MS = 86_400_000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
/** 00:00 IST of `day`, epoch ms. */
const istMidnight = (day: string): number => Date.parse(`${day}T00:00:00+05:30`)
/** Rupees to the paisa: S − K in floating point is 32.40000000000009, not 32.4. */
const paise = (x: number): number => Math.round(x * 100) / 100
const noPrice = (_stock: string, day: string): string => `no settlement price for ${day}`

interface Net {
  readonly clientCode: string; readonly stock: string; readonly instrument: Instrument
  readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  /** The opening balance's qty. */
  held: number
  /** Day → the signed qty traded that day, up to the expiry day. */
  readonly moves: Map<string, number>
}

/** Net qty at the end of the expiry day, and the day its open cycle began (null = it is the balance's). */
function walkNet(n: Net): { readonly q: number; readonly from: string | null } {
  let q = n.held
  let from: string | null = null
  for (const day of [...n.moves.keys()].sort()) {
    if (q === 0) from = day   // flat at the end of the day before: a new cycle
    q += n.moves.get(day) as number
  }
  return { q, from }
}

/** The trading days after `from` up to and including `to`. */
function tradingDaysAfter(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = nextDay(from); d <= to; d = nextDay(d)) if (isNseTradingDay(d)) out.push(d)
  return out
}

/** Why the record cannot vouch for the cycle's qty; null = it can. See the module note. */
function recordDoubt(
  record: TradeRecord, stock: string, expiry: string, from: string | null, balance: OpeningBalance | null,
): string | null {
  if (balance === null && record.from !== null && listedAbout(expiry) < record.from) {
    return `opened before the trader's record (${record.from}) with no opening balance — upload a positions file for ${previousTradingDay(record.from)} to settle it`
  }
  const start = from ?? (balance as OpeningBalance).day
  const traded = record.days[exchangeOf(stock)]
  const gaps = tradingDaysAfter(start, expiry).filter((d) => !traded.has(d))
  const first = gaps[0]
  if (first === undefined) return null
  const more = gaps.length > 1 ? ` and ${gaps.length - 1} more trading day(s)` : ''
  return `no trade stored on ${first}${more} while it was open — a trade file may be missing`
}

/**
 * Fills that settle every contract still open at the end of its expiry day, for expiries before `today` (and `today`
 * itself once its history close exists).
 */
export function settlementOf(
  balance: OpeningBalance | null, trades: readonly LedgerTrade[], today: string, price: SettlementPrice, isIndex: IsIndex,
  record?: TradeRecord,
): Settlement {
  const { fills, unsettled } = settlementRun(balance, trades, today, price, isIndex, record)
  return { fills, unsettled }
}

/**
 * `settlementOf`, with the deliveries listed. Fills and unsettled contracts come in contract-key order. Without
 * `record` the record guard is off: a caller holding only part of a trader's trades cannot tell a gap from a stock
 * not traded that day.
 */
export function settlementRun(
  balance: OpeningBalance | null, trades: readonly LedgerTrade[], today: string, price: SettlementPrice, isIndex: IsIndex,
  record?: TradeRecord,
): SettlementRun {
  const why = (price as Partial<ExplainedPrice>).missing ?? noPrice

  // each contract's balance and its trades by day up to its expiry day, as the walk sees them
  const nets = new Map<string, Net>()
  const netOf = (c: Pick<Net, 'clientCode' | 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType'>): Net | null => {
    if (c.instrument === 'share') return null
    const contract = { clientCode: c.clientCode.toUpperCase(), stock: c.stock, instrument: c.instrument, expiry: c.expiry, strike: c.strike, optType: c.optType }
    const key = legKey(contract)
    let n = nets.get(key)
    if (n === undefined) { n = { ...contract, held: 0, moves: new Map() }; nets.set(key, n) }
    return n
  }
  for (const p of balance?.positions ?? []) { const n = netOf(p); if (n !== null) n.held += p.qty }
  for (const t of trades) {
    if (balance !== null && t.day <= balance.day) continue   // in the balance already
    if (t.day > t.expiry) continue                            // a contract cannot trade after its expiry
    const n = netOf(t)
    if (n !== null) n.moves.set(t.day, (n.moves.get(t.day) ?? 0) + (t.side === 'Buy' ? t.qty : -t.qty))
  }

  const fills: SettlementFill[] = []
  const unsettled: Unsettled[] = []
  const deliveries: Delivery[] = []
  for (const key of [...nets.keys()].sort()) {
    const net = nets.get(key) as Net
    const { q, from } = walkNet(net)
    const n = { ...net, q }
    if (n.q === 0 || n.expiry > today) continue
    const off = (reason: string): void => {
      unsettled.push({ key, stock: n.stock, expiry: n.expiry, qty: n.q, reason })
    }
    if (!ISO_DAY.test(n.expiry)) { off('no expiry date'); continue }
    if (n.instrument === 'option' && (n.strike === null || n.optType === null)) { off('no strike or option type'); continue }
    const s = price(n.stock, n.expiry)
    if (s === null || !(s > 0)) {
      if (n.expiry < today) off(why(n.stock, n.expiry))   // today's close is not out yet: still live, not unsettled
      continue
    }
    const doubt = record === undefined ? null : recordDoubt(record, n.stock, n.expiry, from, balance)
    if (doubt !== null) { off(doubt); continue }

    // dated on its expiry day after every real trade of it, or, for a contract the balance already holds past its
    // expiry, first thing on the first day the walk sees
    const edge = balance !== null && n.expiry <= balance.day
    const day = edge ? nextDay((balance as OpeningBalance).day) : n.expiry
    const at = edge
      ? { day, time: istMidnight(day), seq: -1 }
      : { day, time: istMidnight(nextDay(day)) - 1, seq: Number.MAX_SAFE_INTEGER }
    const contract = { clientCode: n.clientCode, stock: n.stock, instrument: n.instrument, expiry: n.expiry, strike: n.strike, optType: n.optType }
    const close = { side: n.q > 0 ? 'Sell' : 'Buy', qty: Math.abs(n.q) } as const

    let itm = n.instrument === 'future'
    let px = s
    if (n.instrument === 'option') {
      const k = n.strike as number
      const intrinsic = n.optType === 'CE' ? s - k : k - s
      itm = intrinsic > 0
      px = itm ? paise(intrinsic) : 0
    }
    fills.push({ ...contract, ...close, price: px, ...at, settlement: true })

    if (!itm || isIndex(n.stock)) continue
    // physical settlement: long CE / short PE / long future take the shares in, long PE / short CE give them out
    const shares = n.instrument === 'option' && n.optType === 'PE' ? -n.q : n.q
    const share = { clientCode: n.clientCode, stock: n.stock, instrument: 'share', expiry: '', strike: null, optType: null } as const
    fills.push({ ...share, side: shares > 0 ? 'Buy' : 'Sell', qty: Math.abs(shares), price: s, ...at, settlement: true })
    deliveries.push({ key: legKey(share), stock: n.stock, expiry: n.expiry, shares, price: s, from: key })
  }
  return { fills, unsettled, deliveries }
}

// ---- the adapters the app wires in --------------------------------------------

/** What `priceFromHistory` reads of the history store (market/history.ts): its closes of every file on disk. */
export interface HistoryCloses {
  /** The day's settlement close of `stock`; null = listed with none (an index bar, no `ic`); undefined = not listed / no file. */
  close(stock: string, day: string): number | null | undefined
  /** Whether the day's file is on disk and read. */
  hasCloses(day: string): boolean
  closeDays(): { readonly days: number; readonly first: string | null }
}

/**
 * S from NSE history (`<nseDir>/history/<day>.json`). For a stock it is `symbols[STOCK].c`, the CM close, which is
 * the final settlement price of stock derivatives. An index's bar is NOT its close: the CM file lists no index, so its
 * OHLC are the near future's (`src: 'fut'`), and on an expiry day that is the NEXT month's future. An index therefore
 * settles only off `ic`, the index close the span job may write (the FO bhavcopy's UndrlygPric). Without it the index
 * contract stays unsettled with that reason. SENSEX is BSE's and not in the NSE files at all.
 */
export function priceFromHistory(history: HistoryCloses): ExplainedPrice {
  const price = (stock: string, day: string): number | null => history.close(stock, day) ?? null
  const missing = (stock: string, day: string): string => {
    if (!history.hasCloses(day)) {
      const first = history.closeDays().first
      return first !== null && day < first ? `no NSE history for ${day} (it starts ${first})` : `no NSE history for ${day}`
    }
    if (history.close(stock, day) === undefined) return `not in the NSE history of ${day}`
    return `no index close in the NSE history of ${day}`
  }
  return Object.assign(price, { missing })
}

/** The indices traders hold, named here too, so a master that lacks one for a moment never makes it a stock. */
const KNOWN_INDICES: ReadonlySet<string> = new Set([
  ...Object.keys(INDEX_SPOT_TOKENS), 'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50',
])

/**
 * Cash-settled or delivered. A known index name is an index. Otherwise an F&O underlying that the master lists with
 * no NSE cash (EQ) row is an index (NIFTYFPI and the like): every F&O stock has its EQ row. A name the master no longer
 * lists at all (a delisted or demerged stock, e.g. TATAMOTORS) is a stock. That is the safe default, since every F&O
 * index is in the list above.
 */
export function isIndexFrom(master: () => TradersMaster): IsIndex {
  return (stock) => {
    if (KNOWN_INDICES.has(stock)) return true
    const m = master()
    if (m.cash.has(stock)) return false
    return m.options.expiries(stock).length > 0 || m.options.future(stock) !== null
  }
}
