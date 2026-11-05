/**
 * WHAT DELTA WOULD CHARGE TO CLOSE ONE OPEN LEG NOW — the `closeFeeOf` seam
 * `BridgeService.positions` sums into `closeFees`, wired in `main.ts` on the
 * Delta build only (operator, 5 Nov: "we just want to see actual net pnl
 * which if we close book now, we will get in account").
 *
 * Delta's option fee (`@algomaker/dx` `optionFee`, delta-api-reference §10):
 *
 *   fee = min(rate x qty x index, 3.5 % x qty x premium) ; + 18 % GST
 *
 * THE RATE IS THIS ACCOUNT'S, NOT THE PUBLISHED ONE. Delta's fee page says
 * 0.01 % of notional; every live commission on 4 Nov (14 fills, maker and
 * taker, five strikes, two expiries) came to 0.009 % plus GST, against the
 * `.DEXBTUSD` index at the fill's minute — 10 % under the published rate.
 * Estimating at 0.01 % would overstate the cost of closing by about 11 %. If
 * Delta's rate for the account changes, this is the one number to change.
 *
 * Whether that discount reaches the 3.5 % premium cap is not known (no fill
 * has hit the cap yet); the cap is applied as published.
 *
 * An ESTIMATE of a trade out at the leg's closing price. Holding to expiry
 * costs Delta's settlement fee instead (none on a leg expiring worthless).
 */
import { DX_OPTION_FEE_RATES, optionFee, type OptionFeeRates } from '@algomaker/dx'

/** 0.009 % of notional: the rate on this account's fills, 2026-11-04. */
export const DX_ACCOUNT_FEE_RATES: OptionFeeRates = { ...DX_OPTION_FEE_RATES, notionalRate: 0.00009 }

/**
 * USD, GST included. `qty` is BTC (either sign), `price` the leg's closing
 * price per 1 BTC, `index` the BTC index. Throws on a negative or non-finite
 * price or index, as `optionFee` does — the caller decides what unknown means.
 */
export function dxCloseFee(
  a: { readonly qty: number; readonly price: number; readonly index: number },
  rates: OptionFeeRates = DX_ACCOUNT_FEE_RATES,
): number {
  const contracts = Math.round(Math.abs(a.qty) / rates.contractValue)
  return optionFee({ contracts, index: a.index, premium: a.price }, rates).total
}
