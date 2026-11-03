// Shared instrument-master fixture for the traders suites. Tokens are chosen so a
// wrong match is visible: every contract has its own number, and the helpers
// below say which one it is.
import { INDEX_SPOT_TOKENS } from '@algomaker/instruments'
import type { InstrumentRow } from '@algomaker/instruments'
import { buildTradersMaster } from '../../src/market/master.ts'
import type { TradersMaster } from '../../src/market/master.ts'

export const OCT = '2026-10-27'
export const NOV = '2026-11-24'
export const DEC = '2026-12-29'
export const NIFTY_WK = '2026-10-20'

export const TCS_SPOT = 2953217
export const TCS_BSE_SPOT = 134540
export const BAJ_SPOT = 81153
export const MM_SPOT = 519937
export const JSL_SPOT = 1723649
export const NIFTY_SPOT = INDEX_SPOT_TOKENS['NIFTY'] as number
export const TCS_OCT_FUT = 1001
export const TCS_NOV_FUT = 1002
export const MM_OCT_FUT = 1003
export const TCS_DEC_FUT = 1004
export const JSL_OCT_FUT = 1005
export const NIFTY_OCT_FUT = 1010

export const octCE = (k: number): number => 20000 + 2 * ((k - 3000) / 25)
export const octPE = (k: number): number => octCE(k) + 1
export const novCE = (k: number): number => 30000 + 2 * ((k - 3000) / 25)
export const novPE = (k: number): number => novCE(k) + 1
export const decCE = (k: number): number => 50000 + 2 * ((k - 3000) / 25)
export const decPE = (k: number): number => decCE(k) + 1
export const mmCE = (k: number): number => 40000 + 2 * ((k - 3000) / 50)
export const mmPE = (k: number): number => mmCE(k) + 1
export const jslCE = (k: number): number => 70000 + 2 * ((k - 900) / 20)
export const jslPE = (k: number): number => jslCE(k) + 1
export const niftyWkCE = (k: number): number => 60000 + 2 * ((k - 25000) / 50)
export const niftyWkPE = (k: number): number => niftyWkCE(k) + 1
export const niftyOctCE = (k: number): number => 61000 + 2 * ((k - 25000) / 50)
export const niftyOctPE = (k: number): number => niftyOctCE(k) + 1

const TICK = 0.05

function eq(token: number, symbol: string, name: string, exchange: 'NSE' | 'BSE'): InstrumentRow {
  return { instrument_token: token, tradingsymbol: symbol, name, expiry: '', strike: 0, tick_size: TICK, lot_size: 1, instrument_type: 'EQ', segment: exchange, exchange }
}

function fut(token: number, name: string, expiry: string, lot: number): InstrumentRow {
  return { instrument_token: token, tradingsymbol: `${name}${expiry.slice(2, 4)}FUT`, name, expiry, strike: 0, tick_size: TICK, lot_size: lot, instrument_type: 'FUT', segment: 'NFO-FUT', exchange: 'NFO' }
}

function chain(
  name: string, expiry: string, lot: number, first: number, last: number, step: number, ceOf: (k: number) => number,
): InstrumentRow[] {
  const out: InstrumentRow[] = []
  for (let k = first; k <= last; k += step) {
    for (const t of ['CE', 'PE'] as const) {
      out.push({
        instrument_token: t === 'CE' ? ceOf(k) : ceOf(k) + 1,
        tradingsymbol: `${name}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8)}${k}${t}`,
        name, expiry, strike: k, tick_size: TICK, lot_size: lot, instrument_type: t, segment: 'NFO-OPT', exchange: 'NFO',
      })
    }
  }
  return out
}

export const TEST_ROWS: readonly InstrumentRow[] = [
  eq(TCS_SPOT, 'TCS', 'TATA CONSULTANCY SERV LT', 'NSE'),
  eq(TCS_BSE_SPOT, 'TCS', 'TATA CONSULTANCY SERV LT', 'BSE'),
  eq(BAJ_SPOT, 'BAJFINANCE', 'BAJAJ FINANCE', 'NSE'),
  eq(MM_SPOT, 'M&M', 'MAHINDRA & MAHINDRA', 'NSE'),
  eq(JSL_SPOT, 'JINDALSTEL', 'JINDAL STEEL', 'NSE'),
  { instrument_token: NIFTY_SPOT, tradingsymbol: 'NIFTY 50', name: 'NIFTY 50', expiry: '', strike: 0, tick_size: TICK, lot_size: 0, instrument_type: 'EQ', segment: 'INDICES', exchange: 'NSE' },
  fut(TCS_OCT_FUT, 'TCS', OCT, 175),
  fut(TCS_NOV_FUT, 'TCS', NOV, 175),
  fut(TCS_DEC_FUT, 'TCS', DEC, 175),
  fut(MM_OCT_FUT, 'M&M', OCT, 350),
  fut(JSL_OCT_FUT, 'JINDALSTEL', OCT, 625),
  fut(NIFTY_OCT_FUT, 'NIFTY', OCT, 65),
  ...chain('TCS', OCT, 175, 3000, 4000, 25, octCE),
  ...chain('TCS', NOV, 175, 3000, 4000, 25, novCE),
  ...chain('TCS', DEC, 175, 3000, 4000, 25, decCE),
  ...chain('M&M', OCT, 350, 3000, 3400, 50, mmCE),
  ...chain('JINDALSTEL', OCT, 625, 900, 1160, 20, jslCE),
  ...chain('NIFTY', NIFTY_WK, 65, 25000, 26000, 50, niftyWkCE),
  ...chain('NIFTY', OCT, 65, 25000, 26000, 50, niftyOctCE),
]

export function testMaster(loadedAt = 0): TradersMaster {
  return buildTradersMaster(TEST_ROWS, loadedAt)
}
