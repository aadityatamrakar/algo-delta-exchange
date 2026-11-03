/**
 * The option chain as the Python desk consumes it.
 *
 * RAW PRICES ONLY, and deliberately. Greeks are not served here as inputs: the
 * desk computes IV and greeks itself, Black-76 off the near future, exactly as
 * `GfdlStore.mark` does in the backtest (spec D9). Serving a Black-Scholes-on-
 * cash-spot delta from here and letting it reach `ctx` would produce a book
 * marked by a model that matches neither engine.
 *
 * EVERY LISTED STRIKE IS RETURNED. A strike absent from the exchange and a
 * strike that simply has not traded are different facts, and the desk must be
 * able to tell them apart: the first cannot be opened at all, the second can
 * be opened once it prints.
 */

import type { OptionMaster } from '@algomaker/instruments'
import type { InstrumentRef } from '@algomaker/order-bus'
import type { QuoteCache } from './marks.ts'

/** One price level of the book, one side. */
export interface DepthLevel {
  readonly price: number
  readonly qty: number
}

/** The top few levels of the book on each side, as the feed retains them. */
export interface DepthBook {
  readonly buy: DepthLevel[]
  readonly sell: DepthLevel[]
}

export interface ChainQuote {
  readonly price: number
  readonly oi: number | null
  readonly volume: number | null
  /**
   * Best bid/ask, both-or-neither — see `Quote`. On an illiquid strike the
   * LTP is a memory while the depth is the market; a client that can print
   * "0.20 / 0.24" beside an aged mark can price a wing the LTP cannot.
   */
  readonly bid: number | null
  readonly ask: number | null
  /**
   * The book behind the touch, when the tick carried it — up to 5 levels a
   * side. Omitted rather than empty arrays when the feed sent none, so a
   * consumer estimating an execution price can tell "no depth on this tick"
   * from "the book is genuinely one level deep".
   */
  readonly depth?: DepthBook
  /**
   * DELTA'S OPTION FIELDS, for the option chain page: the exchange's own mark
   * price, the size at the touch, mark IV, and the exchange's greeks. ABSENT
   * on NSE — its feed sends none, and the Python desk computes its own greeks
   * off the near future (the header's rule stands there). On DX these are
   * display figures, not inputs to any decision.
   */
  readonly mark?: number
  readonly bidSize?: number
  readonly askSize?: number
  readonly iv?: number
  readonly delta?: number
  readonly gamma?: number
  readonly theta?: number
  readonly vega?: number
  readonly asOf: number
  readonly ageMs: number
}

export interface ChainRow {
  readonly strike: number
  readonly CE: ChainQuote | null
  readonly PE: ChainQuote | null
  /**
   * The CONTRACT behind each side — tradingsymbol and token — present only when
   * the master lists it. Omitted rather than null so a consumer spreading the
   * row never manufactures a contract that does not exist.
   *
   * Here so a caller can ACT on a strike without reconstructing the exchange's
   * own symbol format client-side.
   */
  readonly ceContract?: InstrumentRef
  readonly peContract?: InstrumentRef
}

export interface ChainResponse {
  readonly underlying: string
  readonly expiry: string
  readonly spot: number | null
  readonly spotAsOf: number | null
  readonly future: number | null
  readonly futureAsOf: number | null
  readonly step: number | null
  readonly lotSize: number | null
  readonly rows: readonly ChainRow[]
  readonly feedAlive: boolean
}

export interface ChainDeps {
  readonly master: OptionMaster
  readonly marks: QuoteCache
  readonly now: () => number
}

export interface ChainOptions {
  /**
   * Read through `displayQuote` — past the feed-dead gate, down to the
   * persisted snapshot — instead of the decision path's `quote`. For the
   * closed-market cockpit ONLY: the desk's own chain endpoint must keep
   * refusing on a dead feed, because the desk DECIDES off it. `feedAlive`
   * is reported truthfully either way.
   */
  readonly display?: boolean
}

function quoteFor(deps: ChainDeps, token: number | undefined, display: boolean): ChainQuote | null {
  if (token === undefined) return null
  const q = display ? deps.marks.displayQuote(token) : deps.marks.quote(token)
  if (q === null) return null
  return {
    price: q.price,
    oi: q.oi,
    volume: q.volume,
    bid: q.bid,
    ask: q.ask,
    asOf: q.asOf,
    ageMs: q.ageMs,
    ...(q.depth === undefined ? {} : { depth: q.depth }),
    ...(q.option ?? {}),
  }
}

/** `GET /v1/desk/chain/:symbol/expiries` — the listed option expiries, ascending. */
export function chainExpiries(
  master: OptionMaster,
  underlying: string,
): { readonly underlying: string; readonly expiries: readonly string[] } {
  return { underlying, expiries: master.expiries(underlying) }
}

export function buildChain(
  deps: ChainDeps,
  underlying: string,
  expiry: string,
  opts: ChainOptions = {},
): ChainResponse {
  const display = opts.display === true
  const master = deps.master
  const meta = master.chain(underlying, expiry)

  const rows: ChainRow[] = []
  for (const strike of master.strikes(underlying, expiry)) {
    /**
     * The CONTRACT is carried alongside the quote, not just its token.
     *
     * `resolve` was already being called here and its reference thrown away
     * after taking the token. A caller that wants to ACT on a strike — the
     * Build-book screen places an order per leg — otherwise has to reconstruct
     * `BAJFINANCE26AUG1150CE` itself from symbol, expiry and strike. That
     * string is the exchange's to define, and a client guessing at its month
     * code is a silent wrong-instrument bug waiting for the one month the
     * format differs.
     */
    const ce = master.resolve(underlying, expiry, strike, 'CE')
    const pe = master.resolve(underlying, expiry, strike, 'PE')
    rows.push({
      strike,
      CE: quoteFor(deps, ce?.instrumentToken, display),
      PE: quoteFor(deps, pe?.instrumentToken, display),
      ...(ce === null || ce === undefined ? {} : { ceContract: ce }),
      ...(pe === null || pe === undefined ? {} : { peContract: pe }),
    })
  }

  const spotToken = master.spotToken(underlying)
  const tokenQuote =
    spotToken === null ? null : display ? deps.marks.displayQuote(spotToken) : deps.marks.quote(spotToken)
  // An underlying with NO index row (Delta's BTC) is priced off `md.spot`.
  // One that has a row keeps reading it, exactly as before.
  const spotQuote = spotToken === null ? deps.marks.spotQuote(underlying, display) : tokenQuote
  const futureToken = master.future(underlying)?.instrumentToken
  const futureQuote = quoteFor(deps, futureToken, display)

  return {
    underlying,
    expiry,
    spot: spotQuote?.price ?? null,
    spotAsOf: spotQuote?.asOf ?? null,
    future: futureQuote?.price ?? null,
    futureAsOf: futureQuote?.asOf ?? null,
    step: meta?.strikeStep ?? null,
    lotSize: meta?.lotSize ?? null,
    rows,
    feedAlive: deps.marks.feedAlive(),
  }
}
