// The desk's instrument master, read-only, and the match from a trader's leg to a
// Kite instrument token. A leg matches on (stock, expiry, strike, CE/PE/FUT/EQ) -
// never on display text. A share matches the NSE cash row by SYMBOL: a cash row's
// `name` is the company name ('BAJAJ FINANCE'), which is not what a trader holds.
// Nothing here assumes a future or a monthly expiry exists: an index weekly lists
// options only.
import { INDEX_SPOT_TOKENS, OptionMaster } from '@algomaker/instruments'
import type { InstrumentRow } from '@algomaker/instruments'
import type { TradersDb } from '../db.ts'
import { contractText, type TraderLeg } from '../types.ts'
import type { ContractsView } from '../analytics/r3-wire.ts'

export interface TradersMaster {
  readonly options: OptionMaster
  /** NSE cash-segment rows keyed by tradingsymbol. */
  readonly cash: ReadonlyMap<string, InstrumentRow>
  readonly loadedAt: number
}

export type LegContract = Pick<TraderLeg, 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType'>

/** One stored document as an InstrumentRow: the mapping `loadStoredInstruments` (apps/marketdata) applies. */
export function instrumentRowOf(d: Record<string, unknown>): InstrumentRow {
  return {
    instrument_token: Number(d['instrument_token']),
    tradingsymbol: String(d['tradingsymbol'] ?? ''),
    name: String(d['name'] ?? ''),
    expiry: String(d['expiry'] ?? ''),
    strike: Number(d['strike'] ?? 0),
    tick_size: Number(d['tick_size'] ?? 0),
    lot_size: Number(d['lot_size'] ?? 0),
    instrument_type: String(d['instrument_type'] ?? ''),
    segment: String(d['segment'] ?? ''),
    exchange: String(d['exchange'] ?? ''),
  }
}

const isNseShare = (r: InstrumentRow): boolean =>
  r.instrument_type === 'EQ' && r.exchange.toUpperCase() === 'NSE' && !r.segment.toUpperCase().includes('INDICES')

export function buildTradersMaster(rows: readonly InstrumentRow[], loadedAt: number): TradersMaster {
  const cash = new Map<string, InstrumentRow>()
  for (const r of rows) if (isNseShare(r) && r.tradingsymbol !== '' && !cash.has(r.tradingsymbol)) cash.set(r.tradingsymbol, r)
  return { options: new OptionMaster(rows), cash, loadedAt }
}

export async function loadTradersMaster(db: TradersDb, nowMs: number): Promise<TradersMaster> {
  const docs = await db.desk('instrument').find({}).toArray()
  return buildTradersMaster(docs.map(instrumentRowOf), nowMs)
}

/** The Kite token of the leg's contract, or null when the master does not list it. */
export function matchLeg(m: TradersMaster, leg: LegContract): number | null {
  if (leg.instrument === 'share') return m.cash.get(leg.stock)?.instrument_token ?? null
  if (leg.instrument === 'future') return m.options.future(leg.stock, leg.expiry)?.instrumentToken ?? null
  if (leg.strike === null || leg.optType === null) return null
  return m.options.resolve(leg.stock, leg.expiry, leg.strike, leg.optType)?.instrumentToken ?? null
}

/** The line a screen shows for a leg `matchLeg` cannot place. */
export function notUnderstood(leg: LegContract & Pick<TraderLeg, 'clientCode'>): string {
  return `not understood: ${leg.stock} ${contractText(leg)} (client ${leg.clientCode === '' ? 'manual' : leg.clientCode}) — no such contract in the instrument master`
}

/** Spot token of a stock (its NSE cash row) or an index (its canonical spot). */
export function spotTokenOf(m: TradersMaster, stock: string): number | null {
  return m.cash.get(stock)?.instrument_token ?? INDEX_SPOT_TOKENS[stock] ?? null
}

/** Shares per lot: the chain's or future's lot, 1 for a share, null when unlisted. */
export function lotSizeOf(m: TradersMaster, leg: LegContract): number | null {
  if (leg.instrument === 'share') return 1
  if (leg.instrument === 'future') return m.options.future(leg.stock, leg.expiry)?.lotSize ?? null
  return m.options.chain(leg.stock, leg.expiry)?.lotSize ?? null
}

/**
 * The first listed future whose expiry is on or after `today`, with that expiry
 * (the instrument ref carries none). Expiries come from the option chains; one
 * with no future (an index weekly) is skipped.
 */
export function nearestFutureWithExpiry(
  m: TradersMaster, stock: string, today: string,
): { readonly expiry: string; readonly ref: NonNullable<ReturnType<OptionMaster['future']>> } | null {
  for (const e of m.options.expiries(stock)) {
    if (e < today) continue
    const ref = m.options.future(stock, e)
    if (ref !== null) return { expiry: e, ref }
  }
  return null
}

/** The first listed future whose expiry is on or after `today`; see `nearestFutureWithExpiry`. */
/** The stock's listed option expiries on or after `today`, each with its lot, strikes and whether a future lists on it (ascending). */
export function contractsOf(m: TradersMaster, stock: string, today: string): ContractsView {
  return {
    stock,
    expiries: m.options.expiries(stock).filter((e) => e >= today).map((expiry) => ({
      expiry,
      future: m.options.future(stock, expiry) !== null,
      lotSize: m.options.chain(stock, expiry)?.lotSize ?? null,
      strikes: m.options.strikes(stock, expiry),
    })),
  }
}

export function nearestFuture(m: TradersMaster, stock: string, today: string): ReturnType<OptionMaster['future']> {
  return nearestFutureWithExpiry(m, stock, today)?.ref ?? null
}
