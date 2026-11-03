/**
 * The ledger: ODIN writes no positions file, so a trader's legs are derived
 * from their trades (plus an optional opening balance). Pure, no IO.
 *
 * The net-price rule reproduces VolHedge's "Net Price": per contract keep net
 * quantity q and net value v (sum of signed qty x price), walking trades day
 * by day in file order. When q is 0 at the END of a day, v resets to 0; going
 * flat and reopening within one day does not. avgPrice = v / q (may be negative).
 * An opening balance is the positions at the CLOSE of its day; trades dated on
 * or before that day are skipped.
 *
 * Contracts held to expiry are closed by the synthetic fills of
 * settlement.ts, walked with the trades: each is dated at the last
 * millisecond of its expiry day with the highest line number, so the walk's
 * own order puts it after every real trade of that day.
 */

import { legKey } from '../types.ts'
import type { TraderTrade } from '../types.ts'
import type { ParsedPosition } from './parsers.ts'

export interface LedgerTrade extends Pick<TraderTrade, 'clientCode' | 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType' | 'side' | 'qty' | 'price' | 'time' | 'day' | 'seq'> {}

export function ledgerTradeOf(t: TraderTrade): LedgerTrade {
  return {
    clientCode: t.clientCode, stock: t.stock, instrument: t.instrument, expiry: t.expiry, strike: t.strike,
    optType: t.optType, side: t.side, qty: t.qty, price: t.price, time: t.time, day: t.day, seq: t.seq,
  }
}

/** Positions at the CLOSE of `day`: trades dated on or before `day` are skipped, later ones fold on top. */
export interface OpeningBalance { readonly day: string; readonly positions: readonly ParsedPosition[] }

interface State { readonly proto: ParsedPosition; q: number; v: number }

/** The ledger's walk: trades after the balance's day, by day, then time, then line in the file. A new array. */
export function ledgerWalk<T extends Pick<LedgerTrade, 'day' | 'time' | 'seq'>>(balance: OpeningBalance | null, trades: readonly T[]): T[] {
  return trades
    .filter((t) => balance === null || t.day > balance.day)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.time - b.time || a.seq - b.seq))
}

export function legsFromTrades(balance: OpeningBalance | null, trades: readonly LedgerTrade[]): ParsedPosition[] {
  const states = new Map<string, State>()   // insertion order = balance order, then first-trade order
  for (const p of balance?.positions ?? []) {
    const st = states.get(legKey(p))
    if (st) { st.q += p.qty; st.v += p.qty * p.avgPrice }   // a duplicate row summarises more trades: sum it in
    else states.set(legKey(p), { proto: p, q: p.qty, v: p.qty * p.avgPrice })
  }

  const walk = ledgerWalk(balance, trades)

  let i = 0
  while (i < walk.length) {
    const day = walk[i]!.day
    const touched = new Set<State>()
    for (; i < walk.length && walk[i]!.day === day; i++) {
      const t = walk[i]!
      const key = legKey(t)
      let st = states.get(key)
      if (!st) {
        st = { proto: { clientCode: t.clientCode, stock: t.stock, instrument: t.instrument, expiry: t.expiry, strike: t.strike, optType: t.optType, qty: 0, avgPrice: 0 }, q: 0, v: 0 }
        states.set(key, st)
      }
      const s = t.side === 'Buy' ? 1 : -1
      st.q += s * t.qty
      st.v += s * t.qty * t.price
      touched.add(st)
    }
    for (const st of touched) if (st.q === 0) st.v = 0
  }

  return [...states.values()].map((st) => ({ ...st.proto, qty: st.q, avgPrice: st.q !== 0 ? st.v / st.q : 0 }))
}
