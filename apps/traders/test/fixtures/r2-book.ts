// The pinned TCS book of Release 2 (Tasks 9–13): one master, one set of quotes,
// six legs. Every number the analytics tests assert is worked from what is
// written here, so change nothing without re-deriving those numbers.
//
// 10:00 IST Mon 19 Oct 2026. Spot 3000; Oct future 3010, Nov 3030, Dec unquoted.
// Oct 3100 CE last traded 11 minutes ago: in session it is no longer evidence.
import type { InstrumentRow } from '@algomaker/instruments'
import { buildTradersMaster, type TradersMaster } from '../../src/market/master.ts'
import type { TraderQuote, TradersQuotes } from '../../src/market/quotes.ts'
import type { SnapshotMarket } from '../../src/analytics/snapshot.ts'
import { legKey, type OptType, type TraderLeg } from '../../src/types.ts'

export const R2_NOW = Date.UTC(2026, 9, 19, 4, 30)

export const R2_OCT = '2026-10-27'
export const R2_NOV = '2026-11-23'
export const R2_DEC = '2026-12-29'
const MONTHS = [R2_OCT, R2_NOV, R2_DEC] as const
const STRIKES = [2900, 3000, 3100] as const
const LOT = 175
const TICK = 0.05

export const SPOT_TOKEN = 1
export const FUT_TOKEN: Readonly<Record<string, number>> = { [R2_OCT]: 10, [R2_NOV]: 11, [R2_DEC]: 12 }
/** Oct 100–105, Nov 200–205, Dec 300–305: 2900 CE, 2900 PE, 3000 CE, … */
export function optToken(expiry: string, strike: number, type: OptType): number {
  return 100 * (MONTHS.indexOf(expiry as (typeof MONTHS)[number]) + 1) + 2 * ((strike - 2900) / 100) + (type === 'PE' ? 1 : 0)
}

/** The rows as the desk's `instrument` collection holds them. */
export function r2Master(): readonly InstrumentRow[] {
  const rows: InstrumentRow[] = [{
    instrument_token: SPOT_TOKEN, tradingsymbol: 'TCS', name: 'TATA CONSULTANCY SERV LT', expiry: '', strike: 0,
    tick_size: TICK, lot_size: 1, instrument_type: 'EQ', segment: 'NSE', exchange: 'NSE',
  }]
  for (const expiry of MONTHS) {
    const yymm = `${expiry.slice(2, 4)}${['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(expiry.slice(5, 7))]}`
    rows.push({
      instrument_token: FUT_TOKEN[expiry] as number, tradingsymbol: `TCS${yymm}FUT`, name: 'TCS', expiry, strike: 0,
      tick_size: TICK, lot_size: LOT, instrument_type: 'FUT', segment: 'NFO-FUT', exchange: 'NFO',
    })
    for (const strike of STRIKES) {
      for (const type of ['CE', 'PE'] as const) {
        rows.push({
          instrument_token: optToken(expiry, strike, type), tradingsymbol: `TCS${yymm}${strike}${type}`, name: 'TCS', expiry, strike,
          tick_size: TICK, lot_size: LOT, instrument_type: type, segment: 'NFO-OPT', exchange: 'NFO',
        })
      }
    }
  }
  return rows
}

export const TM: TradersMaster = buildTradersMaster(r2Master(), 0)

interface Q { readonly price: number; readonly ageMs: number; readonly bid?: number; readonly ask?: number }
const AGE = 1_000
const BASE: ReadonlyMap<number, Q> = new Map<number, Q>([
  [SPOT_TOKEN, { price: 3000, ageMs: AGE }],
  [10, { price: 3010, ageMs: AGE }],
  [11, { price: 3030, ageMs: AGE }],
  [optToken(R2_OCT, 2900, 'PE'), { price: 25, ageMs: AGE }],
  [optToken(R2_OCT, 3000, 'CE'), { price: 60, ageMs: AGE, bid: 59.5, ask: 60.5 }],
  [optToken(R2_OCT, 3000, 'PE'), { price: 50, ageMs: AGE }],
  [optToken(R2_OCT, 3100, 'CE'), { price: 30, ageMs: 11 * 60_000 }],
  [optToken(R2_OCT, 3100, 'PE'), { price: 120, ageMs: AGE }],
  [optToken(R2_NOV, 3000, 'CE'), { price: 95, ageMs: AGE }],
  [optToken(R2_NOV, 3000, 'PE'), { price: 75, ageMs: AGE }],
])

/**
 * The quotes above as R1's `TradersQuotes`. `prices` maps token → price over
 * them (`null` removes the quote; an overridden quote has no depth and is 1 s
 * old); `ageMs` sets every age; `now` is what each `asOf` counts back from.
 */
export function r2Quotes(
  prices: Readonly<Record<number, number | null>> = {}, opts: { ageMs?: number; feedAlive?: boolean; now?: number } = {},
): TradersQuotes {
  const book = new Map(BASE)
  for (const [k, p] of Object.entries(prices)) {
    if (p === null) book.delete(Number(k))
    else book.set(Number(k), { price: p, ageMs: AGE })
  }
  const now = opts.now ?? R2_NOW
  return {
    quote(token: number): TraderQuote | null {
      const q = book.get(token)
      if (q === undefined) return null
      const ageMs = opts.ageMs ?? q.ageMs
      return { price: q.price, bid: q.bid ?? null, ask: q.ask ?? null, oi: null, volume: null, asOf: now - ageMs, ageMs, stale: ageMs > 60_000 }
    },
    feedAlive: () => opts.feedAlive ?? true,
  }
}

export function r2Market(
  over: { now?: number; ageMs?: number; feedAlive?: boolean; quotes?: Readonly<Record<number, number | null>> } = {},
): SnapshotMarket {
  const now = over.now ?? R2_NOW
  const opts = { now, ...(over.ageMs === undefined ? {} : { ageMs: over.ageMs }), ...(over.feedAlive === undefined ? {} : { feedAlive: over.feedAlive }) }
  return { master: () => TM, quotes: r2Quotes(over.quotes, opts), now: () => now }
}

function odin(instrument: TraderLeg['instrument'], expiry: string, strike: number | null, optType: OptType | null, qty: number, avgPrice: number, clientCode = 'C1'): TraderLeg {
  const c = { clientCode, instrument, stock: 'TCS', expiry, strike, optType }
  const token = instrument === 'future' ? (FUT_TOKEN[expiry] ?? null) : strike !== null && optType !== null && STRIKES.includes(strike as (typeof STRIKES)[number]) ? optToken(expiry, strike, optType) : null
  return { trader: 'asha', ...c, qty, avgPrice, source: 'odin', key: legKey(c), token, note: '', updatedAt: 0 }
}

/** One ODIN option leg of asha's (client C1); its token is null when the master does not list the strike. */
export const optLeg = (expiry: string, strike: number, optType: OptType, qty: number, avgPrice: number): TraderLeg =>
  odin('option', expiry, strike, optType, qty, avgPrice)
/** One more Oct future @3000, under client C2 so its key is not L4's. */
export const futLeg = (qty: number): TraderLeg => odin('future', R2_OCT, null, null, qty, 3000, 'C2')
/** One more manual share leg @2950. */
export const shareLeg = (qty: number, key = 'manual:s2'): TraderLeg => ({
  trader: 'asha', stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null, qty, avgPrice: 2950,
  clientCode: '', source: 'manual', key, token: SPOT_TOKEN, note: '', updatedAt: 0,
})

export function r2Legs(): readonly TraderLeg[] {
  return [
    optLeg(R2_OCT, 3000, 'CE', -175, 50),
    optLeg(R2_NOV, 3000, 'CE', 175, 80),
    optLeg(R2_OCT, 3100, 'CE', -175, 35),
    odin('future', R2_OCT, null, null, 175, 3000),
    shareLeg(1000, 'manual:s1'),
    optLeg(R2_OCT, 3050, 'CE', -175, 20),
  ]
}

const KEYS = r2Legs().map((l) => l.key)
export const L1 = KEYS[0] as string
export const L2 = KEYS[1] as string
export const L3 = KEYS[2] as string
export const L4 = KEYS[3] as string
export const L5 = KEYS[4] as string
export const L6 = KEYS[5] as string
