/**
 * The ledger's cycles: ONE walk for every P&L that books them — the Series P&L block (series-pnl.ts) and the Booked
 * page (booked.ts) both read it, so the two can never disagree on what a contract booked.
 *
 * WHY its own walk beside `legsFromTrades`: the ledger keeps only each contract's state at the end; a P&L needs
 * every cycle it closed on the way — what it booked, the day it went flat, the fills it took to get there, and
 * whether NSE's expiry settlement closed it. The rule is the ledger's own (ingest/ledger.ts): per contract keep the
 * signed quantity q and value v; when q is 0 at the END of a day the cycle closes, −v is what it booked, and v
 * starts again from 0. Flat and reopened within one day is one cycle (v carries in the net price, as the ledger
 * has it), so it books nothing until a day ends flat.
 *
 * A contract is the ledger's key (`legKey`) with the client code upper-cased, as LedgerStore reads it: a hand-typed
 * balance spelling `c0001` and ODIN's `C0001` stay one contract. The opening balance starts each contract's first
 * cycle (positions at the CLOSE of its day); trades on or before that day are already in it (`ledgerWalk`).
 *
 * Settlement fills (ingest/settlement.ts, spec G1/G2) are NSE's expiry settlement, derived at read time. They are
 * walked after every real trade of their day, whatever time they carry, so an expiry-day close always lands before
 * them. They are not trades: they are kept out of a cycle's `fills` (charges are over real fills only, and they
 * carry none) and only mark the cycle they close as `settled`.
 */

import { ledgerWalk, type LedgerTrade, type OpeningBalance } from '../ingest/ledger.ts'
import type { SettlementFill } from '../ingest/settlement.ts'
import { legKey, type Instrument, type OptType } from '../types.ts'

/** A real trade as the walk needs it: the ledger's fields and its order number (charges count orders). */
export interface WalkTrade extends LedgerTrade { readonly orderNo: string }

/** One contract, as the ledger keys it (client code upper-cased). */
export interface CycleContract {
  readonly key: string
  readonly stock: string; readonly instrument: Instrument; readonly expiry: string
  readonly strike: number | null; readonly optType: OptType | null
}

/** One cycle of a contract: from flat (or the opening balance) to flat at a day's end, or still open. */
export interface Cycle {
  readonly contract: CycleContract
  /** Its real fills, in walk order; never a settlement fill. */
  readonly fills: readonly WalkTrade[]
  /** The day it ended flat; null = still open when the walk ends. */
  readonly closedOn: string | null
  /** −v at that close: what it booked. 0 while open. */
  readonly booked: number
  /** NSE's settlement closed it: a settlement fill was walked on its closing day. */
  readonly settled: boolean
  /** Signed quantity and value still held (0 and 0 once closed). */
  readonly qty: number
  readonly value: number
}

/** Which contracts a walk keeps; the rest are never walked (each contract's cycles are its own). */
export type CycleKeep = (c: Pick<LedgerTrade, 'stock' | 'instrument' | 'expiry'>) => boolean

const everything: CycleKeep = () => true

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const DAY_MS = 86_400_000

/** -0 reads as 0. */
export const fold = (x: number): number => (x === 0 ? 0 : x)
/** '2026-10-13' -> '13 Oct 2026'. */
export const dayText = (day: string): string => `${day.slice(8, 10)} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''} ${day.slice(0, 4)}`
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)

/**
 * The first day whose closes the walk can see: the day after the opening balance (trades on or before it are in it),
 * or the first trade file's day, whichever is later; null with neither. Every figure the walk books counts from it.
 */
export function historyStart(balance: OpeningBalance | null, historyFrom: string | null): string | null {
  const after = balance === null ? null : nextDay(balance.day)
  if (after === null || historyFrom === null) return after ?? historyFrom
  return after > historyFrom ? after : historyFrom
}

const isSettlement = (t: WalkTrade | SettlementFill): t is SettlementFill => (t as Partial<SettlementFill>).settlement === true

interface State {
  readonly contract: CycleContract
  q: number; v: number
  fills: WalkTrade[]
  settled: boolean
}

function contractOf(c: Pick<LedgerTrade, 'clientCode' | 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType'>): CycleContract {
  return {
    key: legKey({ ...c, clientCode: c.clientCode.toUpperCase() }),
    stock: c.stock, instrument: c.instrument, expiry: c.expiry, strike: c.strike, optType: c.optType,
  }
}

/**
 * Real trades and settlement fills in the ledger's order (after the balance's day; by day, time, line), each day's
 * settlement fills after that day's real trades. Both lists come out of `ledgerWalk` sorted, so this is a merge.
 */
function walkOrder(balance: OpeningBalance | null, trades: readonly WalkTrade[], fills: readonly SettlementFill[]): (WalkTrade | SettlementFill)[] {
  const real = ledgerWalk(balance, trades)
  if (fills.length === 0) return real
  const settle = ledgerWalk(balance, fills)
  const out: (WalkTrade | SettlementFill)[] = []
  let s = 0
  for (const t of real) {
    while (s < settle.length && (settle[s] as SettlementFill).day < t.day) out.push(settle[s++] as SettlementFill)
    out.push(t)
  }
  while (s < settle.length) out.push(settle[s++] as SettlementFill)
  return out
}

/**
 * Every cycle of every kept contract: the closed ones in the order they closed, then the ones still open (in the
 * order their contract first appeared). Pure; the inputs are not changed.
 */
export function cycleWalk(
  balance: OpeningBalance | null, trades: readonly WalkTrade[], settlement: readonly SettlementFill[] = [], keep: CycleKeep = everything,
): Cycle[] {
  const states = new Map<string, State>()   // insertion order = balance order, then first-walk order
  const stateOf = (c: Pick<LedgerTrade, 'clientCode' | 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType'>): State => {
    const contract = contractOf(c)
    let st = states.get(contract.key)
    if (st === undefined) {
      st = { contract, q: 0, v: 0, fills: [], settled: false }
      states.set(contract.key, st)
    }
    return st
  }
  for (const p of balance?.positions ?? []) {
    if (!keep(p)) continue
    const st = stateOf(p)
    st.q += p.qty   // a duplicate row summarises more trades: sum it in, as the ledger does
    st.v += p.qty * p.avgPrice
  }

  const walk = walkOrder(balance, trades.filter(keep), settlement.filter(keep))
  const closed: Cycle[] = []
  let n = 0
  while (n < walk.length) {
    const day = (walk[n] as WalkTrade).day
    const touched = new Set<State>()
    for (; n < walk.length && (walk[n] as WalkTrade).day === day; n++) {
      const t = walk[n] as WalkTrade | SettlementFill
      const st = stateOf(t)
      const s = t.side === 'Buy' ? 1 : -1
      st.q += s * t.qty
      st.v += s * t.qty * t.price
      if (isSettlement(t)) st.settled = true
      else st.fills.push(t)
      touched.add(st)
    }
    // the ledger's reset: flat at the day's end closes the cycle, and what it made is booked
    for (const st of touched) {
      if (st.q === 0) {
        closed.push({ contract: st.contract, fills: st.fills, closedOn: day, booked: fold(-st.v), settled: st.settled, qty: 0, value: 0 })
        st.v = 0
        st.fills = []
      }
      st.settled = false   // a settlement fill only ever closes; one that left a quantity (it cannot) marks nothing
    }
  }

  const open: Cycle[] = []
  for (const st of states.values()) {
    if (st.q !== 0) open.push({ contract: st.contract, fills: st.fills, closedOn: null, booked: 0, settled: false, qty: st.q, value: st.v })
  }
  return [...closed, ...open]
}
