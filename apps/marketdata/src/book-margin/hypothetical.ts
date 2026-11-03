/**
 * What the broker would hold against a book that DOES NOT EXIST YET.
 *
 * `refresh.ts` prices the books the desk already holds, on the sweep's own
 * schedule, and publishes to Mongo. This answers a question nobody has a
 * position for: the cockpit's repair menu proposes a plan, an operator is about
 * to take one row of it to the order box, and the only honest way to know what
 * that plan costs to hold is to ask the broker to price it. `spanLiteMargin` in
 * `@algomaker/payoff` estimates it — 21 scenario cells and a floor — but the
 * number the counter actually blocks is Zerodha's, and the gap between the two
 * is the difference between a plan that places and one that is refused.
 *
 * IT LIVES IN THIS PROCESS FOR THE SAME REASON THE SWEEP DOES: the Kite
 * enctoken exists only in `feed-pool.ts` memory and is persisted nowhere, so
 * desk-api asking Kite itself would mean a second IJ0574 login — and a second
 * login invalidates the first, which is the 2026-08-04 feed outage. The bridge
 * asks over HTTP; this borrows the token already held.
 *
 * THE LEGS ARE NAMED SEMANTICALLY — `underlying/expiry/strike/type/qty` — and
 * resolved HERE, through the instrument master this process syncs daily. The
 * caller does not spell `BHEL26AUG415CE`: that string is the exchange's to
 * define, and a client reconstructing its month code is exactly the fabrication
 * that produced the C4 phantom PE and the legacy 0.05 fills. `OptionMaster.
 * resolve` returns null for a strike that is not listed, and null is the point.
 *
 * AN UNRESOLVABLE LEG FAILS THE WHOLE REQUEST. Dropping it would price a naked
 * short at a hedged book's margin — a strangle missing one wing is a fraction
 * of the real figure — and the operator would read the difference as headroom.
 * Kite failing fails it too: `refresh.ts`'s own rule is that a failed refresh
 * never overwrites a good figure with a fabricated one, and there is even less
 * excuse here, where there is no previous figure to age.
 *
 * READ-ONLY, structurally. The one vendor call reachable from here is the
 * basket-margin endpoint, which is Kite's own calculator: it prices orders, it
 * cannot place them.
 *
 * THE ANSWER IS THE TILE'S ARITHMETIC, not the calculator's. `span + exposure +
 * premiumPaid`, because the broker blocks the long legs' premium as margin too
 * — see `handleMarginBasket`. Two definitions of "margin used" on one screen is
 * the defect this desk keeps re-finding.
 */
import type { OptionType } from '@algomaker/greeks'
import type { InstrumentRef } from '@algomaker/order-bus'
import type { BridgeLeg } from '../../../api/src/contract.ts'
import { basketOrders } from './basket.ts'
import type { KiteMarginClient } from './kite.ts'

export const MARGIN_BASKET_PATH = '/v1/md/margin-basket'

/** One leg of a book somebody is thinking about. `qty` is SIGNED units. */
export interface HypotheticalLeg {
  readonly underlying: string
  readonly expiry: string
  readonly strike: number
  readonly type: OptionType
  readonly qty: number
}

export interface MarginBasketDeps {
  /** The instrument master this process syncs. Null for a strike not listed. */
  resolve(underlying: string, expiry: string, strike: number, type: OptionType): InstrumentRef | null
  /** Null until the Kite login has landed, so boot order cannot 500 on itself. */
  client(): KiteMarginClient | null
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Read the posted legs, field by field.
 *
 * TYPE-CHECKED, NEVER COERCED, for the reason `history.ts` gives about `token`:
 * `Number('')` is 0 and `Number(null)` is 0, so a strike that coerced would
 * reach `resolve` as a real-looking 0 and come back "not listed" — a
 * misdiagnosis of what is really a malformed request. An empty list is refused
 * for the same reason: zero is a true answer for a flat book and a lie for a
 * body that failed to serialise, and the caller asked what a PLAN costs.
 */
export function parseHypotheticalLegs(raw: unknown): readonly HypotheticalLeg[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'legs must be an array of {underlying, expiry, strike, type, qty}' }
  if (raw.length === 0) return { error: 'legs is empty — there is no book to price' }
  const out: HypotheticalLeg[] = []
  for (const [i, row] of raw.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { error: `legs[${i}] is not an object` }
    }
    const r = row as Record<string, unknown>
    const underlying = str(r['underlying'])
    const expiry = str(r['expiry'])
    const strike = r['strike']
    const type = r['type']
    const qty = r['qty']
    if (underlying === '') return { error: `legs[${i}] has no underlying` }
    if (expiry === '') return { error: `legs[${i}] has no expiry` }
    if (typeof strike !== 'number' || !Number.isFinite(strike) || strike <= 0) {
      return { error: `legs[${i}].strike must be a positive number` }
    }
    if (type !== 'CE' && type !== 'PE') return { error: `legs[${i}].type must be CE or PE` }
    if (typeof qty !== 'number' || !Number.isFinite(qty)) {
      return { error: `legs[${i}].qty must be a signed number of units` }
    }
    out.push({ underlying, expiry, strike, type, qty })
  }
  return out
}

/**
 * `HypotheticalLeg` -> the shape `basketOrders` already speaks.
 *
 * The rest of `BridgeLeg` is filled with values the basket never reads —
 * `basket.ts` touches `instrument.exchange`, `instrument.tradingsymbol` and
 * `qty`, and nothing else. Passing through the SAME function the live sweep
 * uses is the whole point: the wire shape Kite is sent is written in exactly
 * one place, and getting a `transaction_type` wrong there turns a short
 * strangle into a long one and collapses the margin to the premium.
 */
function asBridgeLeg(leg: HypotheticalLeg, instrument: InstrumentRef): BridgeLeg {
  return {
    deskTag: instrument.tradingsymbol,
    instrument,
    underlying: leg.underlying,
    expiry: leg.expiry,
    strike: leg.strike,
    type: leg.type,
    side: leg.qty > 0 ? 'Buy' : 'Sell',
    qty: leg.qty,
    entryPrice: 0,
    openedTs: 0,
  }
}

/**
 * Price a hypothetical book. Returns the status and body rather than writing
 * them, so it is testable with a plain object and an injected Kite client.
 *
 * NEVER A NUMBER IT DID NOT GET FROM THE BROKER. Every failure — a strike that
 * is not listed, a login that has not landed, a Kite rejection — answers with
 * `{error}` and no figures at all, so a caller cannot mistake a refusal for a
 * cheap book. The bridge renders that as "the broker could not be asked" beside
 * its own estimate; see `apps/api/src/routes/payoff.ts`.
 */
export async function handleMarginBasket(
  deps: MarginBasketDeps,
  raw: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, body: { error: 'body must be {legs: [{underlying, expiry, strike, type, qty}]}' } }
  }
  const parsed = parseHypotheticalLegs((raw as Record<string, unknown>)['legs'])
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } }

  const legs: BridgeLeg[] = []
  for (const leg of parsed) {
    // A zero-qty leg is dropped by `basketOrders` anyway (Kite rejects a zero
    // quantity for the WHOLE basket); resolving it first would fail the request
    // over a contract that was never going to be sent.
    if (leg.qty === 0) continue
    const instrument = deps.resolve(leg.underlying, leg.expiry, leg.strike, leg.type)
    if (instrument === null) {
      return {
        status: 400,
        body: {
          error:
            `${leg.underlying} ${leg.expiry} ${String(leg.strike)}${leg.type} is not listed in the ` +
            'instrument master — the whole basket is refused rather than priced one leg short',
        },
      }
    }
    legs.push(asBridgeLeg(leg, instrument))
  }

  const orders = basketOrders(legs)
  if (orders.length === 0) {
    return { status: 400, body: { error: 'every posted leg had zero quantity — there is nothing to price' } }
  }

  const client = deps.client()
  if (client === null) {
    // 503, not 500, exactly as the history endpoint answers: the Kite login has
    // simply not finished, and the caller retries on its own schedule.
    return { status: 503, body: { error: 'the market-data login is not ready yet' } }
  }

  try {
    const quote = await client.basketMargin(orders)
    /**
     * THE HEADLINE IS `span + exposure + premiumPaid`, NOT `MarginQuote.total`.
     *
     * `parseBasketReply` sets `total = span + exposure`, which is what Zerodha's
     * calculator prints — and it is NOT what holding the book costs. The broker
     * BLOCKS the long legs' premium as margin too: the XTS account's
     * `MarginUsed` is `span + exposure + option_premium`, exact to the paisa
     * (measured 2026-08-04, and the reason `MarginQuote.premiumPaid` exists at
     * all). `apps/api/src/book-margin.ts`'s `brokerFigures` computes the
     * per-book tile's headline the same way.
     *
     * Reporting `span + exposure` here would have made the verify panel and the
     * tile disagree on every book holding a long leg, with the SMALLER number
     * on the panel an operator reads as headroom before placing.
     *
     * All three components ride along, so nothing is hidden behind the sum and
     * a reader comparing against Kite's own calculator can still find its
     * figure.
     */
    return {
      status: 200,
      body: {
        total: quote.span + quote.exposure + quote.premiumPaid,
        span: quote.span,
        exposure: quote.exposure,
        premiumPaid: quote.premiumPaid,
      },
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    deps.log?.('hypothetical basket margin failed', { legs: orders.length, error })
    // 502: the failure is upstream at Kite, which lets the caller say "the
    // broker could not be asked" rather than "the desk is broken".
    return { status: 502, body: { error } }
  }
}
