// Hand-built BookViews over the Release 3 market for the repair suites: a job's legs, the
// position deltas the offset sums and the chain it is priced on are all written down here.
import { monthQuotes, type MonthQuotes } from '../../src/analytics/month-chain.ts'
import { repairJobOf, type RepairJob } from '../../src/analytics/repair.ts'
import type { TradersMaster } from '../../src/market/master.ts'
import { legKey, type BookView, type Instrument, type LegView, type OptType } from '../../src/types.ts'
import { NIFTY_W1, NIFTY_W2, NOV, OCT, fakeQuotes, priceChain, r3Master } from './r3-market.ts'

/** 10:00 IST Mon 19 Oct 2026: in session. */
export const REPAIR_NOW = Date.UTC(2026, 9, 19, 4, 30)
export const TCS_OCT_FWD = 3420
export const TCS_NOV_FWD = 3440
export const NIFTY_FWD = 25010
export const TCS_LOT = 175

export function repairMarket(): { m: TradersMaster; q: ReturnType<typeof fakeQuotes> } {
  const m = r3Master()
  const q = fakeQuotes()
  priceChain(q, m, 'TCS', OCT, TCS_OCT_FWD, 0.25, REPAIR_NOW)
  priceChain(q, m, 'TCS', NOV, TCS_NOV_FWD, 0.24, REPAIR_NOW)
  priceChain(q, m, 'NIFTY', NIFTY_W1, NIFTY_FWD, 0.15, REPAIR_NOW)
  for (const [expiry, price] of [[OCT, TCS_OCT_FWD], [NOV, TCS_NOV_FWD]] as const) {
    const token = m.options.future('TCS', expiry)?.instrumentToken
    if (token === undefined) throw new Error(`the R3 master lists no TCS ${expiry} future`)
    q.set(token, { price, asOf: REPAIR_NOW, ageMs: 0 })
  }
  return { m, q }
}

export function keyOf(stock: string, instrument: Instrument, expiry: string, strike: number | null, optType: OptType | null): string {
  return legKey({ clientCode: 'C1', instrument, stock, expiry, strike, optType })
}

/** A matched leg; greeks are the position's, as R1's book view gives them. */
export function leg(stock: string, p: Pick<LegView, 'instrument' | 'expiry' | 'qty' | 'delta'> & Partial<LegView>): LegView {
  const strike = p.strike ?? null
  const optType = p.optType ?? null
  return {
    key: keyOf(stock, p.instrument, p.expiry, strike, optType), source: 'odin', clientCode: 'C1', note: '', lotSize: TCS_LOT,
    strike, optType, avgPrice: 0, ltp: null, iv: null, gamma: 0, vega: 0, theta: 0, mtm: null, matched: true, ...p,
  }
}

/** The forward R1's book view gives each held month: the ones priced above; a month not listed has none (null). */
const FORWARDS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  TCS: { [OCT]: TCS_OCT_FWD, [NOV]: TCS_NOV_FWD },
  NIFTY: { [NIFTY_W1]: NIFTY_FWD, [NIFTY_W2]: NIFTY_FWD + 10 },
}

export function book(
  stock: string, legs: readonly LegView[],
  o: { closed?: boolean; warnings?: readonly string[]; forwards?: Readonly<Record<string, number | null>> } = {},
): BookView {
  const forwards = o.forwards ?? Object.fromEntries(legs.filter((l) => l.instrument !== 'share').map((l) => [l.expiry, FORWARDS[stock]?.[l.expiry] ?? null]))
  return {
    stock, asOf: REPAIR_NOW, closed: o.closed ?? false, spot: null, futures: {}, forwards, legs,
    totals: { delta: legs.reduce((s, l) => s + l.delta, 0), gamma: 0, vega: 0, theta: 0, mtm: 0 },
    payoff: null, unmatched: [], mismatch: null, historyFrom: null, warnings: o.warnings ?? [],
  }
}

/** The brief's TCS book: OCT short 3400 CE −350 (Δ −140), NOV long 3500 CE +175 (Δ +80), 1000 shares. */
export function tcsBook(o: { closed?: boolean; warnings?: readonly string[] } = {}): BookView {
  return book('TCS', [
    leg('TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: -350, avgPrice: 80, iv: 0.25, delta: -140 }),
    leg('TCS', { instrument: 'option', expiry: NOV, strike: 3500, optType: 'CE', qty: 175, avgPrice: 40, iv: 0.24, delta: 80 }),
    leg('TCS', { instrument: 'share', expiry: '', qty: 1000, avgPrice: 3300, delta: 1000, lotSize: 1 }),
  ], o)
}

export function monthOf(m: TradersMaster, q: ReturnType<typeof fakeQuotes>, stock: string, expiry: string, closed = false): MonthQuotes {
  return monthQuotes(m, q, stock, expiry, null, REPAIR_NOW, closed)
}

/** The TCS book's job, on its October chain (five strikes): small enough for a suite to search. */
export function tcsJob(): RepairJob {
  const { m, q } = repairMarket()
  const r = repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null)
  if ('blocked' in r) throw new Error(`the TCS job is blocked: ${r.blocked}`)
  return r.job
}
