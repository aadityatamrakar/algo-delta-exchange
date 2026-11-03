/**
 * The venue this dashboard is built for: NSE (the default) or Delta Exchange
 * (DX, BTC options). Chosen at BUILD time by `VITE_DESK_VENUE` — the dx build
 * sets `dx` — so one bundle never shows two venues' rules.
 *
 * TODO(T1): replace the local copy below with a relative import of
 * `packages/venue/src/index.ts` once lane T1 is merged. The interface is the
 * plan's `VenueSpec` exactly, so the swap is an import change. NSE `isOpen`
 * here is weekday 09:15–15:30 IST without the holiday list — the browser
 * cannot read `desk-engine/session.ts`'s calendar; T1's will.
 */

export type VenueId = 'nse' | 'dx'

export interface VenueSpec {
  readonly id: VenueId
  readonly currency: 'INR' | 'USD'
  readonly inrPerUnit: number
  readonly qtyStep: number
  readonly defaultTick: number
  readonly rate: number
  isOpen(ms: number): boolean
  dayKey(ms: number): string
  expiryInstantMs(expiry: string): number
}

const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
})
const IST_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
})

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export const NSE: VenueSpec = {
  id: 'nse',
  currency: 'INR',
  inrPerUnit: 1,
  qtyStep: 1,
  defaultTick: 0.05,
  rate: 0.065,
  isOpen(ms) {
    const parts = IST_CLOCK.formatToParts(new Date(ms))
    const part = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
    if (part('weekday') === 'Sat' || part('weekday') === 'Sun') return false
    const mins = Number(part('hour')) * 60 + Number(part('minute'))
    return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30
  },
  dayKey(ms) {
    return IST_DAY.format(new Date(ms))
  },
  expiryInstantMs(expiry) {
    return Date.parse(`${expiry}T15:30:00+05:30`)
  },
}

export const DX: VenueSpec = {
  id: 'dx',
  currency: 'USD',
  inrPerUnit: 85,
  qtyStep: 0.001,
  defaultTick: 0.1,
  rate: 0,
  isOpen() {
    return true
  },
  /** The UTC date of the first 12:00 UTC settlement at or after `ms`. */
  dayKey(ms) {
    const d = new Date(ms)
    return d.getUTCHours() >= 12 ? utcDate(ms + 86_400_000) : utcDate(ms)
  },
  expiryInstantMs(expiry) {
    return Date.parse(`${expiry}T12:00:00Z`)
  },
}

export function venueFromEnv(env: Record<string, string | undefined> = {}): VenueSpec {
  const v = env['DESK_VENUE']
  if (v === undefined || v === '' || v === 'nse') return NSE
  if (v === 'dx') return DX
  throw new Error(`DESK_VENUE must be 'nse' or 'dx', not '${v}'`)
}

function decimalsOf(step: number): number {
  const s = String(step)
  const e = /e-(\d+)$/.exec(s)
  if (e !== null) return Number(e[1])
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

export function roundToStep(x: number, step: number): number {
  return Number((Math.round(x / step) * step).toFixed(decimalsOf(step)))
}

export function isOnStep(x: number, step: number): boolean {
  return Math.abs(roundToStep(x, step) - x) < step * 1e-6
}

export function contractsOf(qty: number, step: number): number {
  if (!isOnStep(qty, step)) throw new RangeError(`${qty} is not a multiple of ${step}`)
  return Math.round(qty / step)
}

// ---------------------------------------------------------- web-only extras

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
 * This build's venue. `import.meta.env` is vite's; the plain-function suites
 * under `node --test` have none, and get NSE.
 */
export const VENUE: VenueSpec = venueFromEnv({
  DESK_VENUE: (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_DESK_VENUE'],
})
