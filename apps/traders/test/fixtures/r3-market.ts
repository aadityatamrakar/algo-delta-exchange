// The Release 3 market: four underlyings whose shapes differ on purpose - a stock with
// three monthlies and futures, an index with three weeklies and one future, a BSE index
// with a single weekly and no future, and a stock with one month. Tokens are synthetic;
// each contract has its own number, and the helpers say which.
import { INDEX_SPOT_TOKENS } from '@algomaker/instruments'
import type { InstrumentRow } from '@algomaker/instruments'
import { b76Price, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import { buildTradersMaster } from '../../src/market/master.ts'
import type { TradersMaster } from '../../src/market/master.ts'
import type { TraderQuote, TradersQuotes } from '../../src/market/quotes.ts'

export const OCT = '2026-10-27'
export const NOV = '2026-11-24'
export const DEC = '2026-12-29'
export const NIFTY_W1 = '2026-10-20'
export const NIFTY_W2 = '2026-10-27'
export const NIFTY_W3 = '2026-11-03'
export const SENSEX_W1 = '2026-10-22'

const TICK = 0.05
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const TCS_SPOT = 2953217
const MM_SPOT = 519937

function eq(token: number, symbol: string, name: string): InstrumentRow {
  return { instrument_token: token, tradingsymbol: symbol, name, expiry: '', strike: 0, tick_size: TICK, lot_size: 1, instrument_type: 'EQ', segment: 'NSE', exchange: 'NSE' }
}

function index(token: number, symbol: string, exchange: 'NSE' | 'BSE'): InstrumentRow {
  return { instrument_token: token, tradingsymbol: symbol, name: symbol, expiry: '', strike: 0, tick_size: TICK, lot_size: 0, instrument_type: 'EQ', segment: 'INDICES', exchange }
}

function fut(token: number, name: string, expiry: string, lot: number): InstrumentRow {
  return { instrument_token: token, tradingsymbol: `${name}${expiry.slice(2, 4)}${MONTHS[Number(expiry.slice(5, 7)) - 1]}FUT`, name, expiry, strike: 0, tick_size: TICK, lot_size: lot, instrument_type: 'FUT', segment: 'NFO-FUT', exchange: 'NFO' }
}

/** CE at `base + 2i`, PE at `base + 2i + 1` for the i-th strike. */
function chain(
  name: string, expiry: string, lot: number, base: number, first: number, last: number, step: number, exchange: 'NFO' | 'BFO',
): InstrumentRow[] {
  const out: InstrumentRow[] = []
  for (let i = 0, k = first; k <= last; i++, k += step) {
    for (const t of ['CE', 'PE'] as const) {
      out.push({
        instrument_token: base + 2 * i + (t === 'CE' ? 0 : 1),
        tradingsymbol: `${name}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8)}${k}${t}`,
        name, expiry, strike: k, tick_size: TICK, lot_size: lot, instrument_type: t,
        segment: exchange === 'NFO' ? 'NFO-OPT' : 'BFO-OPT', exchange,
      })
    }
  }
  return out
}

function rows(): InstrumentRow[] {
  const niftySpot = INDEX_SPOT_TOKENS['NIFTY']
  const sensexSpot = INDEX_SPOT_TOKENS['SENSEX']
  if (niftySpot === undefined || sensexSpot === undefined) throw new Error('INDEX_SPOT_TOKENS lacks NIFTY or SENSEX')
  return [
    eq(TCS_SPOT, 'TCS', 'TATA CONSULTANCY SERV LT'),
    eq(MM_SPOT, 'M&M', 'MAHINDRA & MAHINDRA'),
    index(niftySpot, 'NIFTY 50', 'NSE'),
    index(sensexSpot, 'SENSEX', 'BSE'),
    fut(1001, 'TCS', OCT, 175),
    fut(1002, 'TCS', NOV, 175),
    fut(1003, 'TCS', DEC, 175),
    fut(1010, 'NIFTY', NIFTY_W2, 75),
    fut(1020, 'M&M', OCT, 700),
    ...chain('TCS', OCT, 175, 100_000, 3300, 3500, 50, 'NFO'),
    ...chain('TCS', NOV, 175, 101_000, 3300, 3500, 50, 'NFO'),
    ...chain('TCS', DEC, 175, 102_000, 3300, 3500, 50, 'NFO'),
    ...chain('NIFTY', NIFTY_W1, 75, 200_000, 20000, 30000, 50, 'NFO'),
    ...chain('NIFTY', NIFTY_W2, 75, 201_000, 20000, 30000, 50, 'NFO'),
    ...chain('NIFTY', NIFTY_W3, 75, 202_000, 20000, 30000, 50, 'NFO'),
    ...chain('SENSEX', SENSEX_W1, 20, 300_000, 80000, 82000, 100, 'BFO'),
    ...chain('M&M', OCT, 700, 400_000, 3000, 3200, 50, 'NFO'),
  ]
}

export function r3Master(): TradersMaster {
  return buildTradersMaster(rows(), 0)
}

const BLANK: TraderQuote = { price: 0, bid: null, ask: null, oi: null, volume: null, asOf: 0, ageMs: 0 }

export function fakeQuotes(opts?: { feedAlive?: boolean }): TradersQuotes & { set(token: number, q: Partial<TraderQuote>): void } {
  const quotes = new Map<number, TraderQuote>()
  const alive = opts?.feedAlive ?? true
  return {
    quote: (token) => quotes.get(token) ?? null,
    feedAlive: () => alive,
    set(token, q) {
      quotes.set(token, { ...(quotes.get(token) ?? BLANK), ...q })
    },
  }
}

/** Every listed CE/PE of the expiry: price is its Black-76 value, bid/ask 1% either side, age 0. */
export function priceChain(
  q: ReturnType<typeof fakeQuotes>, m: TradersMaster, stock: string, expiry: string, forward: number, vol: number, asOf: number,
): void {
  const t = yearsToExpiry(expiry, asOf)
  for (const strike of m.options.strikes(stock, expiry)) {
    for (const type of ['CE', 'PE'] as const) {
      const ref = m.options.resolve(stock, expiry, strike, type)
      if (ref?.instrumentToken === undefined) continue
      const price = b76Price({ future: forward, strike, t, vol, rate: DEFAULT_RATE, type })
      q.set(ref.instrumentToken, { price, bid: price * 0.99, ask: price * 1.01, asOf, ageMs: 0 })
    }
  }
}
