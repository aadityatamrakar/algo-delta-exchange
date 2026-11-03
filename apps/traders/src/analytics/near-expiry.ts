// The expiry a book's advice and band are read against: the earliest option leg
// still alive. Futures and shares do not set it.
import { FNO_CLOSE_MIN } from '@algomaker/core'
import type { BookView } from '../types.ts'
import { IST_OFFSET_MS, istDate } from '../routes/kit.ts'

const DAY_MS = 86_400_000

/** Earliest option-leg expiry on or after `todayIst` (YYYY-MM-DD), or null when the book holds no such leg. */
export function nearExpiryOf(view: BookView, todayIst: string): string | null {
  let best: string | null = null
  for (const leg of view.legs) {
    if (leg.instrument !== 'option' || leg.expiry < todayIst) continue
    if (best === null || leg.expiry < best) best = leg.expiry
  }
  return best
}

/**
 * The first expiry day whose options still trade at `nowMs`: today until the
 * 15:40 F&O close (since 3 Aug 2026), then tomorrow. From then on today's
 * options have no time left: the greeks price to the same 15:40 expiry
 * (`yearsToExpiry`), and R1's view leaves them out of the greeks.
 */
export function liveExpiryFrom(nowMs: number): string {
  const minute = Math.floor((nowMs + IST_OFFSET_MS) / 60_000) % 1440
  return istDate(minute >= FNO_CLOSE_MIN ? nowMs + DAY_MS : nowMs)
}
