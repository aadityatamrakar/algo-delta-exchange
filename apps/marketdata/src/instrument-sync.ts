/**
 * Active instrument/token sync — the replacement for `server/tools/exchangeToken.js`.
 *
 * That file has three defects that block stock options outright:
 *
 *  1. **Hardcoded to 5 index names** (`exchangeToken.js:46-50`). Stock contracts
 *     never enter the `instrument` collection, so `xtsOrder.js:288`'s
 *     `loadInstruments` cannot resolve `KALYANKJIL...` and a live order dies in
 *     a caught exception with only a Telegram line to show for it.
 *  2. **Upsert-only, never deletes.** Expired contracts accumulate forever.
 *     `loadInstruments` keys its map by `tradingsymbol`, and NSE reuses symbols
 *     across years — so a stale row can shadow the live contract and route an
 *     order against a dead token.
 *  3. No failure signal, and it boots all of LoopBack to write one collection.
 *
 * The planning half here is PURE: given the dump, the configured universe and
 * today's date, it returns what to upsert and what to delete. That is the part
 * with the decisions in it, so that is the part under test — no network, no
 * Mongo, no clock.
 *
 * DELETION IS GUARDED. Nothing referenced by an open position is ever removed,
 * however expired it looks. A book held through expiry still needs its contracts
 * resolvable to be closed out, and deleting them would strand the position with
 * no way to route the exit.
 */

import { INDEX_SPOT_TOKENS, type InstrumentRow } from '@algomaker/instruments'

export interface SyncUniverse {
  /** Underlying names to keep, e.g. ['NIFTY','BANKNIFTY','KALYANKJIL']. */
  readonly names: readonly string[]
  /** Keep options and futures; the dump also carries cash, currency, commodity. */
  readonly instrumentTypes?: readonly string[]
}

export interface SyncPlan {
  readonly toUpsert: readonly InstrumentRow[]
  /** Instrument tokens to remove — expired and unreferenced. */
  readonly toDelete: readonly number[]
  /** Expired but RETAINED because a position still references them. */
  readonly retainedExpired: readonly number[]
  readonly counts: {
    readonly dumpRows: number
    readonly inUniverse: number
    readonly upserts: number
    readonly deletes: number
    readonly retained: number
  }
}

export interface PlanInputs {
  /** Every row of the freshly-fetched exchange dump. */
  readonly dump: readonly InstrumentRow[]
  /** Rows currently stored, so expiry can be evaluated against what we hold. */
  readonly existing: readonly Pick<InstrumentRow, 'instrument_token' | 'expiry'>[]
  readonly universe: SyncUniverse
  /** 'YYYY-MM-DD' in IST. Contracts expiring BEFORE this are expired. */
  readonly today: string
  /** Tokens referenced by any open position, in either book. Never deleted. */
  readonly referencedTokens: ReadonlySet<number>
}

/**
 * 'EQ' is included, and it is not optional.
 *
 * Greeks need a SPOT price, and for a stock underlying the spot instrument is
 * its cash-market EQ row — there is nowhere else to get it. Syncing only
 * derivatives (as the first version did, and as `exchangeToken.js` does) leaves
 * `marks.spot('BHEL')` permanently null, so every leg drops as unpriceable and
 * the book reports no delta at all. Caught against the live dump: the BHEL
 * universe returned 0 EQ rows.
 *
 * Index underlyings carry their spot on a separate INDICES row rather than EQ,
 * which the name filter picks up the same way.
 */
const DEFAULT_TYPES = ['CE', 'PE', 'FUT', 'EQ'] as const

/**
 * Decide what to write and what to remove. Pure.
 *
 * Note the asymmetry: upserts are driven by the DUMP (what the exchange lists
 * now), deletions by what we ALREADY STORE. A contract absent from the dump is
 * not deleted on that basis alone — a truncated or partially-failed download
 * would otherwise wipe the collection, and a bad sync must degrade to "stale
 * data" rather than "no data".
 */
export function planSync(input: PlanInputs): SyncPlan {
  const names = new Set(input.universe.names)
  const types = new Set(input.universe.instrumentTypes ?? DEFAULT_TYPES)

  // Index spot rows are keyed by TOKEN, not name: `NIFTY` options list against
  // an index row named "NIFTY 50", so a name filter drops it and the underlying
  // ends up with no spot at all. Only SENSEX survives name matching, which is
  // why it was the one index that resolved.
  const spotTokens = new Set(
    [...names].map((n) => INDEX_SPOT_TOKENS[n]).filter((t): t is number => t !== undefined),
  )

  const toUpsert: InstrumentRow[] = []
  for (const row of input.dump) {
    const wantedByToken = spotTokens.has(row.instrument_token)
    if (!wantedByToken) {
      // A CASH EQUITY ROW CARRIES THE COMPANY NAME, NOT THE SYMBOL: Bajaj
      // Finance's NSE row is `tradingsymbol=BAJFINANCE, name="BAJAJ FINANCE"`,
      // while every one of its options lists under `name=BAJFINANCE`. Matching
      // on `name` alone therefore admitted the derivatives and dropped the very
      // spot row they need, for every stock whose company name differs from its
      // symbol — 10 of the desk's 13. BHEL, ITC and DLF hid the gap by being
      // cases where the two strings happen to be equal.
      //
      // This is the same divergence `INDEX_SPOT_TOKENS` handles for indices
      // ('NIFTY' options against a 'NIFTY 50' spot row), but it needs no
      // hardcoded list: for a cash row the tradingsymbol IS the underlying.
      const wantedByName = names.has(row.name)
      const wantedByCashSymbol = row.instrument_type === 'EQ' && names.has(row.tradingsymbol)
      if (!wantedByName && !wantedByCashSymbol) continue
      // Still type-filtered: the tradingsymbol path is a second way to identify
      // a wanted row, never a second way to bypass the type filter.
      if (!types.has(row.instrument_type)) continue
    }
    toUpsert.push(row)
  }

  const live = new Set(toUpsert.map((r) => r.instrument_token))
  const toDelete: number[] = []
  const retainedExpired: number[] = []
  for (const row of input.existing) {
    // Still listed in today's dump: keep, regardless of what its expiry says.
    if (live.has(row.instrument_token)) continue
    if (row.expiry === '' || row.expiry >= input.today) continue
    if (input.referencedTokens.has(row.instrument_token)) {
      retainedExpired.push(row.instrument_token)
      continue
    }
    toDelete.push(row.instrument_token)
  }

  return {
    toUpsert,
    toDelete,
    retainedExpired,
    counts: {
      dumpRows: input.dump.length,
      inUniverse: toUpsert.length,
      upserts: toUpsert.length,
      deletes: toDelete.length,
      retained: retainedExpired.length,
    },
  }
}

/**
 * Tokens the feed should be subscribed to for a set of books.
 *
 * Every open leg, plus a window of strikes each side of spot on the same expiry
 * so roll candidates are already marked when the desk asks for them. Returning a
 * SET means re-declaring is idempotent, which is what lets a Python process call
 * it on every tick without churning the socket.
 */
export interface BookTokenInputs {
  readonly legs: readonly { readonly instrumentToken?: number }[]
  readonly underlying: string
  readonly expiry: string
  readonly spot: number | null
  readonly rollWindow: number
  readonly resolve: (strike: number, type: 'CE' | 'PE') => { instrumentToken?: number } | null
  readonly strikes: readonly number[]
}

export function tokensForBook(input: BookTokenInputs): number[] {
  const out = new Set<number>()
  for (const leg of input.legs) {
    if (leg.instrumentToken !== undefined) out.add(leg.instrumentToken)
  }
  if (input.spot !== null && input.rollWindow > 0 && input.strikes.length > 0) {
    // Nearest listed strike to spot, then N strikes each side ON THE LISTED
    // GRID — not an arithmetic grid, which would ask for contracts that do not
    // exist (the same phantom-strike failure `OptionMaster.atmStrike` avoids).
    const sorted = [...input.strikes].sort((a, b) => a - b)
    let atmIdx = 0
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < sorted.length; i++) {
      const d = Math.abs((sorted[i] as number) - input.spot)
      if (d < best) {
        best = d
        atmIdx = i
      }
    }
    const lo = Math.max(0, atmIdx - input.rollWindow)
    const hi = Math.min(sorted.length - 1, atmIdx + input.rollWindow)
    for (let i = lo; i <= hi; i++) {
      for (const type of ['CE', 'PE'] as const) {
        const ref = input.resolve(sorted[i] as number, type)
        if (ref?.instrumentToken !== undefined) out.add(ref.instrumentToken)
      }
    }
  }
  return [...out]
}
