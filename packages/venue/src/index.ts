/**
 * THE VENUE A DESK TRADES ON — NSE (INR, whole lots) or Delta Exchange
 * (USD BTC options, 0.001 BTC contracts). Everything that differs between the
 * two is one field here, so hosts ask the venue rather than hard-coding NSE.
 *
 * Pure: milliseconds in, values out. No clock, no IO.
 */
// The leaf module, not '.': desk-engine's engine imports this package, and
// '.' would make the two a load-order cycle.
import { isTradingDay } from '@algomaker/desk-engine/session';

export type VenueId = 'nse' | 'dx';

export interface VenueSpec {
  readonly id: VenueId;
  readonly currency: 'INR' | 'USD';
  /** INR per one currency unit: NSE 1, DX 85. */
  readonly inrPerUnit: number;
  /** Smallest tradable quantity on the desk side: NSE 1, DX 0.001 BTC. */
  readonly qtyStep: number;
  readonly defaultTick: number;
  readonly rate: number;
  isOpen(ms: number): boolean;
  /** The settlement day a moment belongs to, as `YYYY-MM-DD`. */
  dayKey(ms: number): string;
  expiryInstantMs(expiry: string): number;
}

const MIN = 60_000;
const DAY = 86_400_000;
const IST_OFFSET_MS = 330 * MIN;
const NSE_OPEN_MIN = 555; // 09:15 IST
const NSE_CLOSE_MIN = 930; // 15:30 IST, exclusive

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function parseExpiry(expiry: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!m) throw new RangeError(`bad expiry date: ${expiry}`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

export const NSE: VenueSpec = {
  id: 'nse',
  currency: 'INR',
  inrPerUnit: 1,
  qtyStep: 1,
  defaultTick: 0.05,
  rate: 0.065,
  isOpen(ms) {
    if (!Number.isFinite(ms)) return false;
    const ist = ms + IST_OFFSET_MS;
    if (!isTradingDay(isoDate(ist))) return false;
    const minute = Math.floor((((ist % DAY) + DAY) % DAY) / MIN);
    return minute >= NSE_OPEN_MIN && minute < NSE_CLOSE_MIN;
  },
  dayKey: (ms) => isoDate(ms + IST_OFFSET_MS),
  // 15:30 IST = 10:00 UTC
  expiryInstantMs(expiry) {
    const [y, m, d] = parseExpiry(expiry);
    return Date.UTC(y, m, d, 10);
  },
};

export const DX: VenueSpec = {
  id: 'dx',
  currency: 'USD',
  inrPerUnit: 85,
  qtyStep: 0.001,
  defaultTick: 0.1,
  rate: 0,
  isOpen: () => true,
  // The first 12:00 UTC strictly after ms: at exactly 12:00:00 the day has
  // already settled, so the moment belongs to the next one.
  dayKey: (ms) => isoDate(Math.floor((ms - 12 * 60 * MIN) / DAY) * DAY + DAY),
  expiryInstantMs(expiry) {
    const [y, m, d] = parseExpiry(expiry);
    return Date.UTC(y, m, d, 12);
  },
};

export function venueFromEnv(
  env: Record<string, string | undefined> = process.env,
): VenueSpec {
  const v = env['DESK_VENUE'];
  if (v === undefined || v === '' || v === 'nse') return NSE;
  if (v === 'dx') return DX;
  throw new Error(`DESK_VENUE must be 'nse' or 'dx', got '${v}'`);
}

function decimalsOf(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) {
    throw new RangeError(`step must be a positive number, got ${step}`);
  }
  let d = 0;
  while (d < 12 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-9) d++;
  return d;
}

/** Nearest multiple of `step`, float-clean (no 0.15000000000000002). */
export function roundToStep(x: number, step: number): number {
  const d = decimalsOf(step);
  const r = Math.round(x / step) * step;
  const out = Number(r.toFixed(d));
  return out === 0 ? 0 : out; // never -0
}

export function isOnStep(x: number, step: number): boolean {
  if (!Number.isFinite(x)) return false;
  return Math.abs(x - roundToStep(x, step)) <= step * 1e-6;
}

/** Whole exchange contracts for a desk quantity; throws if off the grid. */
export function contractsOf(qty: number, step: number): number {
  if (!isOnStep(qty, step)) {
    throw new RangeError(`quantity ${qty} is not a multiple of ${step}`);
  }
  const n = Math.round(qty / step);
  return n === 0 ? 0 : n;
}
