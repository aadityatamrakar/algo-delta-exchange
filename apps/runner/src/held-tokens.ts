/**
 * THE TOKENS OF LEGS THE RUNNER ACTUALLY HOLDS.
 *
 * WHY THIS EXISTS. `main.ts:declareAll` published `md.subscriptionSet()` alone —
 * the CATALOGUE's declared needs, i.e. spot plus a chain window centred on it.
 * A position outside that window was therefore never subscribed, never ticked
 * and could not be marked. On 2026-09-07 MIRROR_A010 held NIFTY 24050 CE/PE
 * against a ~23850 spot and BULL_SNX_1 held SENSEX 76700 CE/PE: all four read
 * `no mark`, and because an unmarked OPEN leg makes `unpriced` non-empty, both
 * tags reported their total as unknown rather than as a number. Every leg
 * inside the window was marking fine, one minute old, at the same moment.
 *
 * A MIRROR IS THE STRUCTURAL CASE, NOT AN EDGE ONE. It follows whatever strike
 * upstream traded, so its legs sit under no chain window this process chose.
 * The same is true of any leg carried across a session while spot moved away.
 *
 * THE TOKEN IS RESOLVED FROM THE INSTRUMENT DUMP, NOT TAKEN FROM THE LEG. A
 * mirror's persisted `instrument` carries no `instrumentToken` — the ledger
 * documents written by that path record only tradingsymbol/lotSize/exchange —
 * so trusting the leg alone would fix nothing for exactly the books that need
 * it most. The leg's own token is preferred when it has one, being the direct
 * answer, and the dump is the fallback.
 *
 * AN UNRESOLVABLE LEG IS RETURNED, NOT SWALLOWED. A held position nobody can
 * price is the condition this file exists to end; discovering one and saying
 * nothing would move the blindness one layer along rather than remove it.
 */

/** One open leg, as `PositionLedger.open()` yields it. */
export interface HeldLeg {
  readonly tradingsymbol: string
  readonly instrument?: { readonly instrumentToken?: number | undefined } | undefined
}

/** The slice of an instrument-dump row this needs. */
export interface InstrumentLookupRow {
  readonly instrument_token: number
  readonly tradingsymbol: string
}

export interface HeldTokenResult {
  /** Deduped tokens to add to the subscription declaration. */
  readonly tokens: readonly number[]
  /** Symbols held but not resolvable to a token — the caller must say so. */
  readonly unresolved: readonly string[]
}

export function heldLegTokens(
  legs: Iterable<HeldLeg>,
  instruments: Iterable<InstrumentLookupRow>,
): HeldTokenResult {
  const bySymbol = new Map<string, number>()
  for (const row of instruments) {
    const token = Number(row.instrument_token)
    const symbol = row.tradingsymbol
    // FIRST WRITER WINS. The dump has one row per contract; a duplicate is a
    // dirty sync, and picking a later row would make the choice depend on
    // Mongo's return order.
    if (Number.isFinite(token) && token > 0 && symbol !== '' && !bySymbol.has(symbol)) {
      bySymbol.set(symbol, token)
    }
  }

  const tokens = new Set<number>()
  const unresolved = new Set<string>()
  for (const leg of legs) {
    const symbol = leg.tradingsymbol
    if (typeof symbol !== 'string' || symbol === '') continue
    const own = leg.instrument?.instrumentToken
    const token =
      typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : bySymbol.get(symbol)
    if (token === undefined) unresolved.add(symbol)
    else tokens.add(token)
  }
  return { tokens: [...tokens], unresolved: [...unresolved] }
}
