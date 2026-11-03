/**
 * A book's legs -> the basket Kite prices.
 *
 * PURE, and deliberately the only place the wire shape is written. Getting one
 * field wrong here produces a plausible number rather than an error — a `BUY`
 * where a `SELL` belongs turns a short strangle into a long one and the margin
 * collapses to the premium — so this is the piece that carries tests.
 *
 * QTY IS UNITS, NOT LOTS. `BridgeLeg.qty` is already signed contract quantity
 * (negative is short), which is exactly what Kite wants once the sign is split
 * off into `transaction_type`. Multiplying by `lotSize` here would double-count.
 */
import type { BridgeLeg } from '../../../api/src/contract.ts'

export interface BasketOrder {
  readonly exchange: string
  readonly tradingsymbol: string
  readonly transaction_type: 'BUY' | 'SELL'
  readonly variety: 'regular'
  readonly product: 'NRML'
  readonly order_type: 'MARKET'
  readonly quantity: number
}

/**
 * Legs -> basket orders. Zero-qty legs are dropped: a closed leg still sits in
 * the book until the next write, and Kite rejects a zero quantity outright,
 * which would fail the whole basket rather than the one dead leg.
 */
export function basketOrders(legs: readonly BridgeLeg[]): readonly BasketOrder[] {
  const out: BasketOrder[] = []
  for (const leg of legs) {
    if (!Number.isFinite(leg.qty) || leg.qty === 0) continue
    out.push({
      // The leg's own exchange, not a hardcoded 'NFO'. A book on a different
      // segment would otherwise be priced against the wrong one silently.
      exchange: leg.instrument.exchange,
      tradingsymbol: leg.instrument.tradingsymbol,
      transaction_type: leg.qty > 0 ? 'BUY' : 'SELL',
      variety: 'regular',
      product: 'NRML',
      order_type: 'MARKET',
      quantity: Math.abs(leg.qty),
    })
  }
  return out
}
