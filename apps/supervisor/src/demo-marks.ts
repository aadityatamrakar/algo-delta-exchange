/**
 * A BOOK IS MARKED ON THE EXCHANGE ITS POSITION LIVES ON.
 *
 * A paper book on Delta's DEMO rail (testnet) is filled at testnet prices, and
 * Delta marks that account at testnet prices — so its P&L, and every stop the
 * engine checks, has to read testnet quotes too. Production's (`md.tick`) can
 * sit 25 dollars away on the same contract (P-BTC-77000-131126, 3 Nov), which
 * is a stop that fires on one exchange for a position held on the other.
 *
 * `md.tick.demo` carries testnet ticks keyed by the DESK's token, for the
 * contracts demo-rail books hold or are entering. `main.ts` folds them into a
 * second `ChainView`; this file lays those quotes over a book's production
 * snap, wing by wing.
 *
 * NARROW BY DESIGN. Only the option wings move. `spot` (the forward) and
 * `future` stay production's: the index is one number whichever account holds
 * the legs, and the testnet publishes only the contracts held.
 *
 * A FALLBACK IS NEVER SILENT. A wing with no FRESH demo quote keeps
 * production's — a book with no market at all is worse than one marked off a
 * near neighbour — and every such contract is returned so the host can name the
 * ones it holds or trades in its reason and its log (`marksNoteOf`).
 *
 * PURE: no clock, no bus, no Mongo.
 */

import type { ChainSnap, OptType, Quote } from '@algomaker/desk-engine'
import type { ChainToken } from './chain-view.ts'

/**
 * A demo quote older than this is not a mark. A testnet ticker pushes a fresh
 * book every few seconds while the feed is alive; a minute of silence is a feed
 * that has stopped, and a frozen testnet price would hold a stop off (or set
 * one off) for as long as nobody noticed.
 */
export const DEMO_QUOTE_MAX_AGE_MS = 60_000

/** One contract, as the engine names it: strike and wing. */
export const contractKey = (strike: number, optType: OptType): string => `${String(strike)}|${optType}`

export interface DemoOverlay {
  /** The production snap with every freshly demo-quoted wing replaced. */
  readonly snap: ChainSnap
  /** Contracts marked off PROD for want of a fresh demo quote: `contractKey` → tradingsymbol. */
  readonly fallback: ReadonlyMap<string, string>
}

/**
 * `prod` with each wing whose token has a FRESH demo quote replaced by it.
 *
 * `rows` are the chain's listed contracts (the master's), which is what maps a
 * token to a strike and a wing. `asOf` moves to the newest quote the snap now
 * holds, as `ChainView.snap` defines it.
 */
export function overlayDemo(
  prod: ChainSnap,
  rows: ReadonlyArray<ChainToken>,
  demo: ReadonlyMap<number, Quote>,
  nowMs: number,
  maxAgeMs: number = DEMO_QUOTE_MAX_AGE_MS,
): DemoOverlay {
  const fresh = new Map<string, Quote>()
  const fallback = new Map<string, string>()
  for (const r of rows) {
    const key = contractKey(r.strike, r.optType)
    const q = demo.get(r.token)
    if (q !== undefined && nowMs - q.asOf <= maxAgeMs) {
      if (!fresh.has(key)) fresh.set(key, q)
      fallback.delete(key)
    } else if (!fresh.has(key)) {
      fallback.set(key, r.instrument)
    }
  }
  let asOf = prod.asOf
  const strikes = prod.strikes.map((s) => {
    const ce = fresh.get(contractKey(s.strike, 'CE'))
    const pe = fresh.get(contractKey(s.strike, 'PE'))
    if (ce === undefined && pe === undefined) return s
    if (ce !== undefined && ce.asOf > asOf) asOf = ce.asOf
    if (pe !== undefined && pe.asOf > asOf) asOf = pe.asOf
    return { strike: s.strike, ce: ce ?? s.ce, pe: pe ?? s.pe }
  })
  return { snap: { ...prod, strikes, asOf }, fallback }
}

export interface MarksNote {
  /** Appended to the decision's reason: `marks: Delta demo[, prod fallback on …]`. */
  readonly note: string
  /** The tradingsymbols, sorted, that were marked off prod. Empty = none. */
  readonly fallback: ReadonlyArray<string>
}

/**
 * The line a demo-marked book's reason carries, naming the contracts that
 * matter to THIS pass — the legs held and the strikes being opened — that had
 * no fresh demo quote. The rest of the chain falling back is expected (the
 * testnet publishes only what is held) and is not news.
 */
export function marksNoteOf(
  fallback: ReadonlyMap<string, string>,
  contracts: ReadonlyArray<{ readonly strike: number; readonly optType: OptType }>,
): MarksNote {
  const named = new Set<string>()
  for (const c of contracts) {
    const instrument = fallback.get(contractKey(c.strike, c.optType))
    if (instrument !== undefined) named.add(instrument)
  }
  const list = [...named].sort()
  return {
    note: list.length === 0 ? 'marks: Delta demo' : `marks: Delta demo, prod fallback on ${list.join(', ')}`,
    fallback: list,
  }
}
