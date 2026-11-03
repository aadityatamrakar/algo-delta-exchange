/**
 * Delta India option fee (delta-api-reference.md §10).
 *
 *   fee = min(0.01 % × notional, 3.5 % × premium) ; gst = 18 % × fee
 *   notional = contracts × 0.001 × index ; premium = contracts × 0.001 × price
 *
 * USD. `index` is the .DEXBTUSD spot, `premium` the option price per 1 BTC.
 * Rounded to 8 decimals (the settling asset's precision) so sums are clean.
 */

export interface OptionFeeRates {
  readonly notionalRate: number
  readonly premiumCap: number
  readonly gstRate: number
  readonly contractValue: number
}

export const DX_OPTION_FEE_RATES: OptionFeeRates = {
  notionalRate: 0.0001,
  premiumCap: 0.035,
  gstRate: 0.18,
  contractValue: 0.001,
}

const r8 = (x: number): number => Number(x.toFixed(8))

export function optionFee(
  a: { contracts: number; index: number; premium: number },
  rates: OptionFeeRates = DX_OPTION_FEE_RATES,
): { fee: number; gst: number; total: number } {
  if (!Number.isInteger(a.contracts) || a.contracts < 0) {
    throw new RangeError(`contracts must be a non-negative integer, got ${a.contracts}`)
  }
  if (!Number.isFinite(a.index) || a.index < 0 || !Number.isFinite(a.premium) || a.premium < 0) {
    throw new RangeError(`index and premium must be finite and non-negative (index ${a.index}, premium ${a.premium})`)
  }
  const btc = a.contracts * rates.contractValue
  const fee = r8(Math.min(rates.notionalRate * btc * a.index, rates.premiumCap * btc * a.premium))
  const gst = r8(rates.gstRate * fee)
  return { fee, gst, total: r8(fee + gst) }
}
