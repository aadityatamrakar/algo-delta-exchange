/**
 * VolHedge v50's MTM block (spec item 14; the operator's definitions,
 * 2026-10-19), as the DAY's view and nothing else (spec G5): what the position
 * made since yesterday's close, not since it was opened; the series P&L
 * (series-pnl.ts) is that, and the open legs against their net price are the
 * "Open P&L". Rows Gross MTM, Expense and Current MTM (gross − expense), each
 * as Previous, Today and Total; the square-off cost, the projected MTM, Pay In
 * Out and CF balance. Current MTM's total is "Day MTM". It is the account's
 * money, so it covers the whole book: viewer ticks, exclusions and month tabs
 * do not apply.
 *
 * The block's contracts are the open legs and every contract traded today.
 * For each, `carried` is the quantity held at the start of the day: qty now −
 * today's signed trades (a manual leg has no trades, so it counts as carried
 * from before today, and a note says so). Previous values the carried quantity
 * from yesterday's close to LTP; Today values each of today's trades from its
 * fill to LTP. Expense Today is the charges on today's fills, and the only
 * charges Day MTM bears: one day's move is not set against the cost of a whole
 * cycle. The charges on each contract's cycle as at the start of today (the
 * trades R1's ledger averaged into its net price by then) are `openCycleCharges`,
 * in no Day figure (the series P&L has them), so a book that did nothing today
 * has a Day MTM of its move alone.
 *
 * A contract flat now (closed today) needs no LTP: it cancels out of its total
 * (carried + today's trades = 0), so with no quote its last fill of today
 * stands in for it in the Previous/Today split.
 *
 * The day figures exist only once the session has begun (`dayReasonAt`). Before
 * 09:15 IST the only LTP there is, is yesterday's last tick (from about 08:00
 * the feed's pre-open price, which is the close), and "yesterday's last tick −
 * yesterday's NSE close" is basis noise, not P&L: Σ qty × (last tick − close)
 * read −7,813 on one book before the open. So before the open, and on a day
 * the market is closed (a weekend, a holiday), Previous, Today, Total, Current
 * and Projected are null with the reason in `dayReason` and a note. After the
 * close the day's figures stay (the final LTP against yesterday's close is the
 * day's move). Between the open and a contract's first trade its LTP is still
 * the last session's, as for any LTP; that is the feed's, not guessed at here.
 *
 * Nothing is guessed. Yesterday's close comes only from NSE's end-of-day files
 * (EodStore, the CLOSE not the settlement price — Phase 0 Q3): when a file the
 * book needs is missing (the F&O file for a carried future or option, the CM
 * file for a carried share), or the underlying trades on BSE, Previous and
 * Total are null (shown —) and a note says why. Named in `partial`, and left
 * out of what needs them: a contract with no close, or held now with no LTP; a
 * contract with a trade whose price or quantity is not a positive number (the
 * trade itself is skipped everywhere); and an unmatched leg, which is left out
 * of the block altogether, never taken for a contract closed today.
 */

import { eodKey, type EodContract } from '@algomaker/span'
import type { PayoffLeg } from '@algomaker/payoff'
import type { TradersDeps } from '../deps.ts'
import { ledgerWalk, type OpeningBalance } from '../ingest/ledger.ts'
import { lotSizeOf as masterLotSize, matchLeg } from '../market/master.ts'
import { istDate } from '../routes/kit.ts'
import { isOpenLeg, legKey, type Instrument, type TraderTrade } from '../types.ts'
import { isNseTradingDay, nextOpenDay, sessionDay } from './calendar.ts'
import { chargesFor, type Fill } from './charges.ts'
import { eodFileOf, missingEodNote } from './eod.ts'
import type { BookSnapshot, PricedLeg } from './snapshot.ts'
import type { ChargeRates, MtmBlock } from './wire.ts'

export interface MtmInputs {
  /** Open legs (ltp, avgPrice). */
  readonly legs: readonly PricedLeg[]
  /** The keys of the open legs the master could not match (BookSnapshot.unmatchedKeys): left out, named in `partial`. */
  readonly unmatchedKeys: readonly string[]
  /** This stock, today: the session's day (`pastSession` when the market is closed today). */
  readonly todayTrades: readonly TraderTrade[]
  /** This stock, before today: each contract's cycle as at the start of today (openCycleTrades). Only the block's contracts count. */
  readonly earlierTrades: readonly TraderTrade[]
  /** Live LTP of any contract of the book (contracts closed today included). */
  readonly ltpOf: (c: EodContract) => number | null
  /** EodStore.close. */
  readonly closeOf: (c: EodContract) => number | null
  /** EodStore.status().missing. */
  readonly eodMissing: readonly string[]
  /** The underlying's chain is on BFO (master.options.chain(stock, e).exchange): NSE files never cover it. */
  readonly bse: boolean
  readonly lotSizeOf: (instrument: Instrument, expiry: string) => number | null
  readonly rates: ChargeRates; readonly trader: string
  /** Today is not a trading day: `todayTrades` are of this last trading day's session (Pay In Out reads them); null on a trading day. */
  readonly pastSession: string | null
  /**
   * The moment the block is worked out at: whether the day has begun is decided from it, not from when the inputs
   * were read (the live frame re-prices a base read up to 10 s earlier, and the open falls between the two).
   */
  readonly nowMs: number
}

/** `MtmBlock.dayReason` before the open on a trading day. */
export const PRE_OPEN_REASON = 'market opens 09:15'
/** `MtmBlock.dayReason` on a day the market is closed (a weekend, a holiday). */
export const CLOSED_DAY_REASON = 'market closed today'

/**
 * Why the day figures are unknown at `nowMs`, null once they can be known: the open of a trading day has passed (the
 * rest of that day, after the 15:40 close too). A closed day has none, whatever session its trades are of
 * (`pastSession`).
 */
export function dayReasonAt(nowMs: number, pastSession: string | null): string | null {
  const day = istDate(nowMs)
  if (pastSession !== null || !isNseTradingDay(day)) return CLOSED_DAY_REASON
  return nextOpenDay(nowMs) === day ? PRE_OPEN_REASON : null   // the next 09:15 is still today's
}

const MANUAL_NOTE = 'Manual legs count as carried from before today'
const MTM_NOTES: readonly string[] = [
  'Previous = the carried legs\' move today, yesterday\'s close to LTP (NSE end-of-day CLOSE, not settlement — Phase 0 Q3), not their P&L since entry; Today = today\'s trades, fill to LTP',
  'Day MTM = Previous + Today - the charges on today\'s fills; the charges on the open cycle before today are not in it (the series P&L has them)',
  'Projected = Day MTM - square-off cost',
  'Pay In Out = premium received - paid on today\'s option trades (our reading; Phase 0 Q3)',
  'CF balance = net premium of the open option legs at net price (our reading; Phase 0 Q3)',
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const NO_ID = { projection: { _id: 0 } } as const

const sign = (side: 'Buy' | 'Sell'): 1 | -1 => (side === 'Buy' ? 1 : -1)
const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
/** A price is a positive finite number; anything else is no price. */
const price = (x: number | null | undefined): number | null => (positive(x) ? x : null)
/** A trade the block can count: a positive quantity and price. */
const usable = (t: TraderTrade): boolean => positive(t.qty) && positive(t.price)
/** The leg a trade belongs to, keyed as R1's ledger keys it (client codes upper-cased). */
const keyOf = (t: TraderTrade): string => legKey({ ...t, clientCode: t.clientCode.toUpperCase() })
const contractOf = (c: EodContract): EodContract => ({ stock: c.stock, instrument: c.instrument, expiry: c.expiry, strike: c.strike, optType: c.optType })

interface Contract {
  readonly key: string
  readonly contract: EodContract
  readonly qtyNow: number
  readonly open: PricedLeg | null
  /** Today's usable trades. */
  readonly today: TraderTrade[]
  /** A trade of today was not usable: the contract's gross and day base are unknown. */
  unpriced: boolean
}

interface Book {
  /** The open legs, in their order, then each contract traded today that no open leg holds (closed today); never an unmatched one. */
  readonly contracts: readonly Contract[]
  /** The `eodMissing` entries this book needs: the F&O file when it carries a future or option, the CM file when it carries a share. */
  readonly missing: readonly string[]
  /** Yesterday's close can be read for the carried contracts: no needed file missing, and not BSE. */
  readonly known: boolean
}

const carriedOf = (c: Contract): number => c.qtyNow - c.today.reduce((s, t) => s + sign(t.side) * t.qty, 0)
/** The price the block marks a contract at: its LTP; for one flat now with none, its last fill of today (the LTP cancels out of its total). */
const markOf = (c: Contract, i: MtmInputs): number | null =>
  price(i.ltpOf(c.contract)) ?? (c.qtyNow === 0 ? ledgerWalk(null, c.today).at(-1)?.price ?? null : null)

function bookOf(i: MtmInputs): Book {
  const unmatched = new Set(i.unmatchedKeys)
  const byKey = new Map<string, Contract>()
  for (const l of i.legs) {
    if (!unmatched.has(l.leg.key)) byKey.set(l.leg.key, { key: l.leg.key, contract: contractOf(l.leg), qtyNow: l.leg.qty, open: l, today: [], unpriced: false })
  }
  for (const t of i.todayTrades) {
    const key = keyOf(t)
    if (unmatched.has(key)) continue
    let c = byKey.get(key)
    if (c === undefined) {
      c = { key, contract: contractOf(t), qtyNow: 0, open: null, today: [], unpriced: false }
      byKey.set(key, c)
    }
    if (usable(t)) c.today.push(t)
    else c.unpriced = true
  }
  const contracts = [...byKey.values()]
  const carried = contracts.filter((c) => carriedOf(c) !== 0)
  const needFo = carried.some((c) => c.contract.instrument !== 'share')
  const needCm = carried.some((c) => c.contract.instrument === 'share')
  // a name that is neither file counts: nothing is assumed about it
  const missing = i.eodMissing.filter((m) => (eodFileOf(m).includes('_FO_') ? needFo : eodFileOf(m).includes('_CM_') ? needCm : true))
  return { contracts, missing, known: !i.bse && missing.length === 0 }
}

/** Order numbers repeat across days, so a fill's order is its day's. */
function fillsOf(trades: readonly TraderTrade[], i: MtmInputs): Fill[] {
  return trades.map((t) => ({
    instrument: t.instrument, side: t.side, qty: t.qty, price: t.price, orderNo: `${t.day}|${t.orderNo}`, lotSize: i.lotSizeOf(t.instrument, t.expiry),
  }))
}

/** '2026-10-23' -> '23 Oct'. */
const dayMonth = (day: string): string => `${day.slice(8, 10)} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`

export function mtmBlock(i: MtmInputs): MtmBlock {
  const b = bookOf(i)
  const dayReason = dayReasonAt(i.nowMs, i.pastSession)
  const began = dayReason === null
  const partial = new Set<string>()
  let grossPrev = 0
  let grossToday = 0
  // before the open there is no day figure to work out, nor a contract to blame for lacking one
  if (began) {
    for (const c of b.contracts) {
      const ltp = markOf(c, i)
      if (c.unpriced || ltp === null) { partial.add(c.key); continue }
      for (const t of c.today) grossToday += sign(t.side) * t.qty * (ltp - t.price)
      const carried = carriedOf(c)
      if (carried === 0 || !b.known) continue
      const close = price(i.closeOf(c.contract))
      if (close === null) { partial.add(c.key); continue }
      grossPrev += carried * (ltp - close)
    }
  }

  // the block's contracts only; an unusable trade is skipped and, once the day has begun, its contract named: before
  // it nothing is left out of a figure that is not being worked out
  const inBlock = new Set(b.contracts.map((c) => c.key))
  const counted = (trades: readonly TraderTrade[]): TraderTrade[] => trades.filter((t) => {
    const key = keyOf(t)
    if (!inBlock.has(key)) return false
    if (!usable(t) && began) partial.add(key)
    return usable(t)
  })
  const earlier = counted(i.earlierTrades)
  const today = counted(i.todayTrades)
  if (began) for (const key of i.unmatchedKeys) partial.add(key)

  // two horizons, kept apart: today's fills' charges are the day's; the open cycle's are the series' (G5)
  const openCycleCharges = chargesFor(fillsOf(earlier, i), i.rates, i.trader).total
  const expToday = chargesFor(fillsOf(today, i), i.rates, i.trader).total
  const closing: Fill[] = []
  for (const c of b.contracts) {
    const ltp = price(i.ltpOf(c.contract))
    if (c.open === null || c.qtyNow === 0 || ltp === null) continue   // nothing to close, or named in partial above
    closing.push({
      instrument: c.contract.instrument, side: c.qtyNow > 0 ? 'Sell' : 'Buy', qty: Math.abs(c.qtyNow), price: ltp,
      orderNo: `close:${c.key}`, lotSize: i.lotSizeOf(c.contract.instrument, c.contract.expiry),
    })
  }
  const squareOff = chargesFor(closing, i.rates, i.trader).total
  const grossPrevious = began && b.known ? grossPrev : null
  const grossTotal = grossPrevious === null ? null : grossPrev + grossToday
  const currentTotal = grossTotal === null ? null : grossTotal - expToday

  const stock = i.legs[0]?.leg.stock ?? i.todayTrades[0]?.stock ?? i.earlierTrades[0]?.stock ?? ''
  const notes: string[] = []
  if (dayReason !== null) {
    notes.push(`Day MTM is not shown — ${dayReason}${i.pastSession === null ? '' : ` (Pay In Out is of ${dayMonth(i.pastSession)}'s session)`}`)
  }
  if (i.bse) notes.push(`${stock} trades on BSE; NSE's end-of-day files do not cover it — carried legs' figure unknown`)
  else for (const m of b.missing) notes.push(missingEodNote(m, "carried legs' figure unknown"))
  if (b.contracts.some((c) => c.open?.leg.source === 'manual')) notes.push(MANUAL_NOTE)

  return {
    gross: { previous: grossPrevious, today: began ? grossToday : null, total: grossTotal },
    expense: { previous: null, today: began ? expToday : null, total: began ? expToday : null },
    current: { previous: grossPrevious, today: began ? grossToday - expToday : null, total: currentTotal },
    squareOff,
    projected: currentTotal === null ? null : currentTotal - squareOff,
    payInOut: today.reduce((s, t) => (t.instrument === 'option' ? s - sign(t.side) * t.qty * t.price : s), 0),
    cfBalance: b.contracts.reduce((s, c) => (c.open?.leg.instrument === 'option' ? s - c.qtyNow * c.open.leg.avgPrice : s), 0),
    openCycleCharges,
    dayReason,
    partial: [...partial],
    ratesConfirmed: i.rates.confirmedBy !== null,
    notes: [...notes, ...MTM_NOTES],
  }
}

/**
 * The book's legs on the day's base, for Scenario's grid: entry = (carried ×
 * yesterday's close + today's signed qty × fill) / qty, and `offset` = what the
 * contracts flat now realised since that base. Priced at LTP, the legs plus the
 * offset are Gross MTM total. Needs no LTP; an unmatched leg is left out, as in
 * the block. Null when a day base is unknown: yesterday's close (a file the
 * book needs missing, a BSE underlying, a carried contract with no close), or
 * a fill of today (a trade with no usable price or quantity).
 */
export function dayLegs(i: MtmInputs): { readonly legs: readonly PayoffLeg[]; readonly offset: number } | null {
  const b = bookOf(i)
  if (!b.known) return null
  const legs: PayoffLeg[] = []
  let offset = 0
  for (const c of b.contracts) {
    if (c.unpriced) return null
    const carried = carriedOf(c)
    let base = c.today.reduce((s, t) => s + sign(t.side) * t.qty * t.price, 0)
    if (carried !== 0) {
      const close = price(i.closeOf(c.contract))
      if (close === null) return null
      base += carried * close
    }
    if (c.qtyNow === 0) offset -= base   // flat now: worth nothing at any price
    if (c.open !== null) legs.push(c.qtyNow === 0 ? c.open.payoff : { ...c.open.payoff, entry: base / c.qtyNow })
  }
  return { legs, offset }
}

/**
 * Each contract's cycle as at the START of today: its trades since its net
 * quantity was last 0 at a day's end (what R1's ledger had averaged into its
 * net price by then), for every contract held at the start of today (a non-zero
 * quantity, not expired). Only days before today are walked, in the ledger's
 * order (`ledgerWalk`). With the trader's opening balance, trades on or before
 * its day are skipped and its positions start the walk, as the ledger does.
 */
export function openCycleTrades(trades: readonly TraderTrade[], today: string, balance: OpeningBalance | null = null): readonly TraderTrade[] {
  const q = new Map<string, number>()
  const cycle = new Map<string, TraderTrade[]>()
  const contract = new Map<string, Pick<TraderTrade, 'instrument' | 'expiry'>>()
  for (const p of balance?.positions ?? []) {
    const key = legKey({ ...p, clientCode: p.clientCode.toUpperCase() })
    q.set(key, (q.get(key) ?? 0) + p.qty)
    contract.set(key, p)
  }
  const walk = ledgerWalk(balance, trades).filter((t) => t.day < today)
  let n = 0
  while (n < walk.length) {
    const day = (walk[n] as TraderTrade).day
    const touched = new Set<string>()
    for (; n < walk.length && (walk[n] as TraderTrade).day === day; n++) {
      const t = walk[n] as TraderTrade
      const key = keyOf(t)
      q.set(key, (q.get(key) ?? 0) + sign(t.side) * t.qty)
      const ts = cycle.get(key)
      if (ts === undefined) cycle.set(key, [t])
      else ts.push(t)
      if (!contract.has(key)) contract.set(key, t)
      touched.add(key)
    }
    for (const key of touched) if (q.get(key) === 0) cycle.set(key, [])
  }
  const keep = new Set<TraderTrade>()
  for (const [key, ts] of cycle) {
    const c = contract.get(key) as Pick<TraderTrade, 'instrument' | 'expiry'>
    if (isOpenLeg({ qty: q.get(key) ?? 0, instrument: c.instrument, expiry: c.expiry }, today)) for (const t of ts) keep.add(t)
  }
  return walk.filter((t) => keep.has(t))
}

/**
 * The trades the block can need, as two ranges on `{ trader, stock, expiry }` (db.ts): contracts not yet expired
 * (everything traded today, and every cycle still open, is one) and shares (expiry ''). An expired contract's
 * trades are never read: `openCycleTrades` would drop them anyway.
 */
export function mtmTradesFilters(trader: string, stock: string, today: string): readonly Record<string, unknown>[] {
  return [
    { trader, stock, expiry: { $gte: today }, day: { $lte: today } },
    { trader, stock, expiry: '', day: { $lte: today } },
  ]
}

/**
 * Today's and the open cycles' trades from traders-trades, the live quotes,
 * `d.eod` and the rates. Reads only. "Today" is the session's day: on a day
 * the market is closed, the last trading day.
 */
export async function mtmInputsOf(d: TradersDeps, s: BookSnapshot, nowMs: number): Promise<MtmInputs> {
  const calendar = istDate(nowMs)
  const today = sessionDay(calendar)
  const col = d.db.collection<TraderTrade>('traders-trades')
  const [ranges, balance, rates] = await Promise.all([
    Promise.all(mtmTradesFilters(s.trader, s.stock, today).map((f) => col.find(f, NO_ID).toArray())),
    d.ledger.balance(s.trader),
    d.charges.get(),
  ])
  const trades = ranges.flat()
  const master = d.master()
  // the snapshot's price for a held contract, so the block agrees with the leg table; a live quote for one closed today
  const held = new Map(s.legs.map((l) => [eodKey(l.leg), l.ltp]))
  const ltpOf = (c: EodContract): number | null => {
    const k = eodKey(c)
    if (held.has(k)) return held.get(k) ?? null
    const token = matchLeg(master, c)
    return token === null ? null : price(d.quotes.quote(token)?.price)
  }
  const expiry = s.nearExpiry ?? s.expiries[0] ?? null
  return {
    legs: s.legs,
    unmatchedKeys: s.unmatchedKeys,
    todayTrades: trades.filter((t) => t.day === today),
    earlierTrades: openCycleTrades(trades, today, balance),
    ltpOf,
    closeOf: (c) => d.eod.close(c),
    eodMissing: d.eod.status().missing,
    bse: expiry !== null && master.options.chain(s.stock, expiry)?.exchange.toUpperCase() === 'BFO',
    lotSizeOf: (instrument, e) => masterLotSize(master, { stock: s.stock, instrument, expiry: e, strike: null, optType: null }),
    rates,
    trader: s.trader,
    pastSession: today === calendar ? null : today,
    nowMs,
  }
}

/** Null = no open book. Analysis and R3's Portfolio (its N2.4) call it. */
export async function mtmOf(d: TradersDeps, trader: string, stock: string, nowMs: number): Promise<MtmBlock | null> {
  const version = d.legs.version(trader)   // before the read: a write during it leaves this version stale (recomputed next time), never old legs under the new one
  const legs = await d.legs.open(trader, stock)
  const today = istDate(nowMs)
  if (!legs.some((l) => isOpenLeg(l, today))) return null
  const s = d.snapshots.get(trader, stock, legs, version)
  return mtmBlock(await mtmInputsOf(d, s, nowMs))
}
