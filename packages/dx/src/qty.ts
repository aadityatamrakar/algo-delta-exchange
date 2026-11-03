/**
 * Quantity and price grids at the exchange edge.
 *
 * The desk holds BTC on a 0.001 grid; Delta takes integer contracts of 0.001
 * BTC and prices on a 0.1 tick. Every conversion here is float-clean (rounded
 * to the step's own decimals), and none turns a non-zero quantity into 0
 * silently: an off-grid quantity throws.
 */

/** Decimal places of a step written in plain notation: 0.001 → 3, 0.5 → 1, 1 → 0. */
export function decimalsOf(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError(`step must be a positive number, got ${step}`)
  let d = 0
  while (d < 12 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-9) d++
  return d
}

const clean = (x: number, decimals: number): number => {
  const v = Number(x.toFixed(decimals))
  return Object.is(v, -0) ? 0 : v
}

// The step grid itself is the venue's (T1) — one rule for the whole desk.
export { contractsOf, isOnStep, roundToStep } from '@algomaker/venue'

/** Desk quantity of `contracts` contracts at `step`, float-clean. */
export function qtyOfContracts(contracts: number, step: number): number {
  return clean(contracts * step, decimalsOf(step))
}

/**
 * Round a limit price onto the tick, PASSIVELY: a buy rounds down, a sell up,
 * so the order never trades through the price the strategy asked for.
 */
export function priceOnTick(price: number, tick: number, side: 'BUY' | 'SELL'): number {
  const d = decimalsOf(tick)
  const units = clean(price / tick, 6)
  const n = side === 'BUY' ? Math.floor(units) : Math.ceil(units)
  return clean(n * tick, d)
}

/** Price as the string Delta wants: the tick's decimals, never exponent notation. */
export function priceString(price: number, tick: number): string {
  return price.toFixed(Math.max(1, decimalsOf(tick)))
}
