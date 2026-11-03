/**
 * THE VENUE THIS BRIDGE RUNS ON, read once at process start, and the day
 * arithmetic every P&L, guard and report site keys on.
 *
 * NSE's day is the IST calendar date. Delta's is the settlement cycle: the
 * day `D` runs from 12:00 UTC on `D-1` up to (not including) 12:00 UTC on `D`,
 * which is what `VenueSpec.dayKey` answers. An IST-midnight day on Delta would
 * split one expiry cycle in two, so every site here asks the venue instead.
 *
 * Every helper takes the venue as a defaulted last argument: production passes
 * nothing and gets the process venue; a test passes `DX` and needs no env.
 */
import { fixedClock, isMarketOpen } from '@algomaker/core'
import { NSE, venueFromEnv, type VenueSpec } from '@algomaker/venue'

export { DX, NSE, type VenueSpec } from '@algomaker/venue'

/** `DESK_VENUE`, read once. Unset is NSE, so the upstream suites run as before. */
export const API_VENUE: VenueSpec = venueFromEnv()

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** The venue day a moment belongs to, `YYYY-MM-DD`. */
export function venueDay(ms: number, venue: VenueSpec = API_VENUE): string {
  return venue.dayKey(ms)
}

/** Inclusive-exclusive `[from, to)` epoch ms of a venue day. */
export function venueDayRange(day: string, venue: VenueSpec = API_VENUE): { from: number; to: number } {
  const midnightUtc = Date.parse(`${day}T00:00:00.000Z`)
  // NSE: IST midnight. DX: 12:00 UTC on the day before.
  const from = venue.id === 'dx' ? midnightUtc - 12 * HOUR_MS : midnightUtc - IST_OFFSET_MS
  return { from, to: from + DAY_MS }
}

/** Minutes since the current venue day began. */
export function minutesIntoVenueDay(ms: number, venue: VenueSpec = API_VENUE): number {
  return Math.floor((ms - venueDayRange(venue.dayKey(ms), venue).from) / 60_000)
}

/** The venue day before `day`. */
export function previousVenueDay(day: string, venue: VenueSpec = API_VENUE): string {
  return venue.dayKey(venueDayRange(day, venue).from - 1)
}

/** `true` when this bridge runs the NSE clock — the upstream behaviour, unchanged. */
export function isNse(venue: VenueSpec = API_VENUE): boolean {
  return venue.id === NSE.id
}

/**
 * Money in the venue's currency, for log and journal text. NSE keeps its
 * upstream `en-IN` rupee form byte for byte; DX is dollars to the cent with the
 * sign in front (`-$312.50`).
 */
export function formatMoney(n: number, venue: VenueSpec = API_VENUE, opts: { symbol?: boolean } = {}): string {
  const symbol = opts.symbol ?? true
  if (venue.currency === 'INR') return `${symbol ? '₹' : ''}${n.toLocaleString('en-IN')}`
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '-' : ''}${symbol ? '$' : ''}${abs}`
}

/**
 * Is the venue's session open at `ms`. NSE keeps the core rule the runner gates
 * on (hours, weekends, holidays); every other venue answers for itself, and
 * DX is always open.
 */
export function venueSessionOpen(ms: number, venue: VenueSpec = API_VENUE): boolean {
  return isNse(venue) ? isMarketOpen(fixedClock(ms)) : venue.isOpen(ms)
}
