/**
 * The venue this dashboard is built for: NSE (the default) or Delta Exchange
 * (DX, BTC options). Chosen at BUILD time by `VITE_DESK_VENUE` — the dx build
 * sets `dx` — so one bundle never shows two venues' rules.
 *
 * THE SPEC IS `packages/venue`, imported relatively the way web already
 * imports `apps/traders/src/types.ts`: the same NSE session (holidays
 * included), the same 12:00 UTC DX day and the same step arithmetic the api,
 * supervisor and gateway use. A second copy here would be a second answer to
 * "is the market open?". Only the web-side extras below live in this file.
 */
import { venueFromEnv, type VenueSpec } from '../../../packages/venue/src/index.ts'

export {
  DX, NSE, contractsOf, isOnStep, roundToStep, venueFromEnv,
  type VenueId, type VenueSpec,
} from '../../../packages/venue/src/index.ts'

/**
 * Quantity over lot size, snapped to the integer it is within float noise of.
 * `0.57 / 0.001` is `569.9999999999999` in IEEE doubles; truncating that sells
 * one contract short. A genuine fraction (`0.0005 / 0.001`) is returned as is,
 * so a caller that prints "shares" for a non-whole lot count still can.
 */
export function lotsOf(qty: number, lotSize: number): number {
  const r = qty / lotSize
  const n = Math.round(r)
  return Math.abs(r - n) < 1e-9 * Math.max(1, Math.abs(n)) ? n : r
}

/** The exchange segment an order names: NFO on NSE, DELTA on DX. */
export function exchangeOf(venue: VenueSpec): string {
  return venue.id === 'dx' ? 'DELTA' : 'NFO'
}

/**
 * This build's venue. The env is passed EXPLICITLY: the package's default is
 * `process.env`, which a browser does not have. `import.meta.env` is vite's;
 * the plain-function suites under `node --test` have none, and get NSE.
 */
export const VENUE: VenueSpec = venueFromEnv({
  DESK_VENUE: (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_DESK_VENUE'],
})
