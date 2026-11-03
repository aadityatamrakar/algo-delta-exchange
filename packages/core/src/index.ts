/**
 * Shared primitives. Zero dependencies.
 *
 * The `Clock` abstraction is the important part: every time-dependent decision
 * goes through it, so a test or a port-verification replay can drive strategies
 * with a synthetic clock instead of wall time. The legacy code calls
 * `moment()`/`new Date()` inline throughout, which is the main reason none of its
 * behaviour can be reproduced without a live market.
 */

/**
 * Crash guards and a retrying Mongo boot, re-exported so every app installs the
 * SAME ones. They were the order gateway's alone until audit F-41 — see
 * `resilience.ts` for the two incidents and why "still zero dependencies" holds
 * (it injects `process`; it does not import it).
 */
export * from './resilience.ts'

// ---------------------------------------------------------------- ids

/**
 * Monotonic, human-sortable id: <prefix>-<base36 ms>-<counter>-<rand>.
 * Sortable ids make WAL and log files readable in order without parsing.
 */
let counter = 0
export function makeId(prefix: string, nowMs: number): string {
  counter = (counter + 1) % 0xffff
  const t = nowMs.toString(36)
  const c = counter.toString(36).padStart(3, '0')
  const r = Math.floor(Math.random() * 0xffff).toString(36).padStart(3, '0')
  return `${prefix}-${t}-${c}-${r}`
}

// ---------------------------------------------------------------- clock

export interface Clock {
  /** Epoch milliseconds. */
  now(): number
  /** Minutes since IST midnight — the unit market schedules are written in. */
  istMinutes(): number
  /** 0 = Sunday … 6 = Saturday, in IST. */
  istDay(): number
}

const IST_OFFSET_MIN = 330 // UTC+05:30, no DST in India

/** IST fields for an epoch ms value. Pure; no timezone database needed. */
export function istParts(epochMs: number): {
  day: number
  hours: number
  minutes: number
  minuteOfDay: number
} {
  const shifted = new Date(epochMs + IST_OFFSET_MIN * 60_000)
  const hours = shifted.getUTCHours()
  const minutes = shifted.getUTCMinutes()
  return {
    day: shifted.getUTCDay(),
    hours,
    minutes,
    minuteOfDay: hours * 60 + minutes,
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  istMinutes: () => istParts(Date.now()).minuteOfDay,
  istDay: () => istParts(Date.now()).day,
}

/** Deterministic clock for tests and replay-based port verification. */
export function fixedClock(epochMs: number): Clock & { set(ms: number): void } {
  let t = epochMs
  return {
    now: () => t,
    istMinutes: () => istParts(t).minuteOfDay,
    istDay: () => istParts(t).day,
    set: (ms: number) => {
      t = ms
    },
  }
}

// ---------------------------------------------------------------- market hours

export const MARKET_OPEN_MIN = 9 * 60 + 15 // 09:15 IST
/**
 * 15:30 IST: the end of the window in which this desk's strategies may trade
 * (`isMarketOpen`, strategy-kit's market-closed check, the runner's day end).
 * NOT the F&O close: since 3 Aug 2026 NSE derivatives trade to 15:40
 * (`FNO_CLOSE_MIN`). It stays 15:30 on purpose: from 15:15 an F&O stock's cash
 * spot is its closing auction's, not a continuous print, and letting the desk
 * place orders until 15:40 is a separate decision from valuing to 15:40.
 */
export const MARKET_CLOSE_MIN = 15 * 60 + 30
/**
 * 15:40 IST: NSE's F&O close since 3 Aug 2026, the instant an F&O contract
 * expires and stops being valued. The one source for 15:40; greeks and
 * payoff sit below core in the dependency graph and carry the same literal,
 * pinned to this by apps/traders/test/fno-close.test.ts.
 */
export const FNO_CLOSE_MIN = 15 * 60 + 40

export function isWeekday(day: number): boolean {
  return day >= 1 && day <= 5
}

export function isMarketOpen(clock: Clock): boolean {
  const m = clock.istMinutes()
  return isWeekday(clock.istDay()) && m >= MARKET_OPEN_MIN && m < MARKET_CLOSE_MIN
}

// ---------------------------------------------------------------- numbers

/**
 * Round to a tick grid. Snaps on-grid values exactly, guarding the float error
 * that makes `100.1 / 0.05 === 2001.9999999999998`.
 */
export function roundToTick(price: number, tickSize: number, dir: 'down' | 'up' | 'nearest' = 'nearest'): number {
  if (tickSize <= 0) return price
  const q = price / tickSize
  const nearest = Math.round(q)
  const n =
    Math.abs(q - nearest) < 1e-9 ? nearest : dir === 'down' ? Math.floor(q) : dir === 'up' ? Math.ceil(q) : nearest
  return Number((n * tickSize).toFixed(10))
}

/** Paise-accurate comparison; avoids float noise in P&L and limit checks. */
export function nearlyEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps
}

// ---------------------------------------------------------------- Result

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error })
