/**
 * What the feed should be subscribed to, derived from the open books.
 *
 * Pure: books in, tokens out. The host re-runs this on a timer and hands the
 * result to the feed pool, which diffs it — so a book that has not changed
 * produces no socket traffic at all.
 *
 * SPOT IS NON-NEGOTIABLE. Every underlying with an open book contributes its
 * spot token, because greeks cannot be computed without one and a book whose
 * spot is missing reports no delta whatsoever. When an underlying has no
 * resolvable spot instrument that is returned as a named problem rather than
 * quietly producing a smaller token set.
 */

export interface BookLike {
  readonly symbol: string
  // `| undefined` explicitly: under `exactOptionalPropertyTypes` an optional
  // property is not the same as one that may hold undefined, and callers build
  // these by reading a possibly-empty legs array.
  readonly expiry?: string | undefined
  readonly legs: readonly {
    readonly instrument: { readonly instrumentToken?: number | undefined }
    readonly expiry?: string | undefined
  }[]
}

export interface SubscriptionResolver {
  spotToken(underlying: string): number | null
  strikes(underlying: string, expiry: string): readonly number[]
  resolve(
    underlying: string,
    expiry: string,
    strike: number,
    type: 'CE' | 'PE',
  ): { instrumentToken?: number } | null
  /**
   * The near-expiry future. It is the research FORWARD (spec D9): options are
   * priced Black-76 off it, so an unsubscribed future means the live ctx
   * cannot reproduce the backtest's own numbers.
   */
  futureToken(underlying: string): number | null
}

export interface SubscriptionPlan {
  readonly tokens: readonly number[]
  /** token -> underlying, for the spot instruments only. */
  readonly spotTokens: ReadonlyMap<number, string>
  /** Underlyings with an open book but NO resolvable spot instrument. */
  readonly missingSpot: readonly string[]
  readonly perUnderlying: ReadonlyMap<string, number>
}

export interface SubscriptionInputs {
  readonly books: readonly BookLike[]
  readonly resolver: SubscriptionResolver
  /** Strikes each side of spot to keep marked as roll candidates. 0 disables. */
  readonly rollWindow?: number
  /** Latest spot per underlying, for centring the roll window. */
  readonly spotPrices?: ReadonlyMap<string, number>
  /**
   * Subscribe the WHOLE chain of each book's expiry rather than a window.
   *
   * Verified against the live system: with a window, an action opening a strike
   * outside it is skipped as "no mark" — the bridge correctly refuses to invent
   * a price, but the desk simply cannot open that leg. Since the desk chooses
   * its own strikes (far wings, repair candidates) and we cannot predict them,
   * a window is the wrong shape. One expiry's chain is ~100-200 contracts, and
   * the socket pool shards at 900 each, so ten symbols is a couple of sockets.
   */
  readonly fullChain?: boolean
}

export function planSubscriptions(input: SubscriptionInputs): SubscriptionPlan {
  const tokens = new Set<number>()
  const spotTokens = new Map<number, string>()
  const missingSpot: string[] = []
  const perUnderlying = new Map<string, number>()
  const rollWindow = input.rollWindow ?? 0

  const underlyings = new Set(input.books.map((b) => b.symbol))

  for (const underlying of underlyings) {
    const before = tokens.size
    const spot = input.resolver.spotToken(underlying)
    if (spot === null) missingSpot.push(underlying)
    else {
      tokens.add(spot)
      spotTokens.set(spot, underlying)
    }

    const fut = input.resolver.futureToken(underlying)
    if (fut !== null) tokens.add(fut)

    for (const book of input.books.filter((b) => b.symbol === underlying)) {
      for (const leg of book.legs) {
        if (leg.instrument.instrumentToken !== undefined) tokens.add(leg.instrument.instrumentToken)
      }

      const expiry = book.expiry ?? book.legs[0]?.expiry
      const spotPrice = input.spotPrices?.get(underlying)

      // The whole chain of the traded expiry. Preferred over a window because
      // the desk picks its own strikes and an unsubscribed one cannot be opened.
      if (input.fullChain === true && expiry !== undefined) {
        for (const strike of input.resolver.strikes(underlying, expiry)) {
          for (const type of ['CE', 'PE'] as const) {
            const ref = input.resolver.resolve(underlying, expiry, strike, type)
            if (ref?.instrumentToken !== undefined) tokens.add(ref.instrumentToken)
          }
        }
      }

      // Roll candidates around spot, walked on the LISTED grid so we never ask
      // for a strike that does not exist.
      if (input.fullChain !== true && rollWindow > 0 && expiry !== undefined && spotPrice !== undefined) {
        const listed = [...input.resolver.strikes(underlying, expiry)].sort((a, b) => a - b)
        if (listed.length > 0) {
          let atm = 0
          let best = Number.POSITIVE_INFINITY
          for (let i = 0; i < listed.length; i++) {
            const d = Math.abs((listed[i] as number) - spotPrice)
            if (d < best) {
              best = d
              atm = i
            }
          }
          const lo = Math.max(0, atm - rollWindow)
          const hi = Math.min(listed.length - 1, atm + rollWindow)
          for (let i = lo; i <= hi; i++) {
            for (const type of ['CE', 'PE'] as const) {
              const ref = input.resolver.resolve(underlying, expiry, listed[i] as number, type)
              if (ref?.instrumentToken !== undefined) tokens.add(ref.instrumentToken)
            }
          }
        }
      }
    }
    perUnderlying.set(underlying, tokens.size - before)
  }

  return {
    tokens: [...tokens],
    spotTokens,
    missingSpot,
    perUnderlying,
  }
}
