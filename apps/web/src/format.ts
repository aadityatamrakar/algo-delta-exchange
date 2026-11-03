/** Number and direction formatting, moved out of api.ts unchanged so a page that talks to another API can share it. api.ts re-exports all of it. */

import { VENUE, type VenueSpec } from './venue.ts'

/*
  EVERY FORMATTER TAKES THE VENUE LAST, defaulting to this build's. On NSE the
  output is exactly what it always was. On DX (USD, BTC options):

    - grouping is en-US (`76,600.1`, not lakhs);
    - a caller that asked for 0 decimals — the NSE "whole rupees, whole
      shares" default — gets up to 3 instead, because a 0.05 BTC leg or a
      0.1-tick price rounded to an integer is a non-zero figure shown as 0;
    - `money` is dollars, 2 decimals, the sign before the `$`.
*/

/** Indian digit grouping, which is what every number on this desk is read in. */
export function inr(n: number, digits = 0, venue: VenueSpec = VENUE): string {
  /**
   * A VALUE THAT IS NOT A NUMBER RENDERS AS "—", IT DOES NOT THROW.
   *
   * This is a monitoring surface for a live trading system, and the worst thing
   * it can do during an incident is show nothing at all. `undefined.toLocaleString`
   * throws, React unmounts the tree, and the operator gets a blank page —
   * which is exactly what happened when the API was still serving an older
   * response shape and a field the page expected was simply absent.
   *
   * The types say these are numbers. The types describe the CURRENT API; a
   * running process can be a deploy behind, and a dashboard that white-screens
   * on a rolling restart is worse than one that shows a dash next to nine
   * correct figures.
   */
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (venue.currency === 'USD') {
    return n.toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits === 0 ? 3 : digits,
    })
  }
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

/** Signed, so a delta's direction reads without hunting for the minus sign. */
export function signed(n: number, digits = 0, venue: VenueSpec = VENUE): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const s = inr(Math.abs(n), digits, venue)
  return n < 0 ? `-${s}` : n > 0 ? `+${s}` : s
}

/**
 * Lakhs and crores, the units this desk actually thinks in: `9.6L`, `1.2Cr`.
 *
 * For figures a tile shows as a HEADLINE — a margin in rupees is seven digits
 * of Indian grouping (`9,60,672`) that reads as noise at 2xl, while "9.6L" is
 * the number the operator would say out loud. Below a lakh the plain grouping
 * returns, where it is short enough to read.
 */
export function inrCompact(n: number, venue: VenueSpec = VENUE): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (venue.currency === 'USD') {
    // Thousands and millions on DX: `$1.25M`, `$12.3K`; below 10k the full figure.
    const short = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    const lead = n < 0 ? '-$' : '$'
    if (a >= 1e6) return `${lead}${short(a / 1e6)}M`
    if (a >= 1e4) return `${lead}${short(a / 1e3)}K`
    return `${lead}${inr(a, 2, venue)}`
  }
  if (a >= 1e7) return `${inr(n / 1e7, n % 1e7 === 0 ? 0 : 2)}Cr`
  if (a >= 1e5) return `${inr(n / 1e5, n % 1e5 === 0 ? 0 : 1)}L`
  return inr(n)
}

/**
 * Direction as colour. These live here rather than in a page module so every
 * surface tints a number the same way and nothing has to import a page to
 * format one.
 */
export const RED = { color: 'var(--color-text-red)' }
export const GREEN = { color: 'var(--color-text-green)' }

/** Undefined at zero: a flat number has no direction to colour. */
export function sign(n: number): Record<string, string> | undefined {
  return n < 0 ? RED : n > 0 ? GREEN : undefined
}

/**
 * The one place a nullable money figure becomes text.
 *
 * It returns an em dash for null and there is no `?? 0` anywhere near it. A P&L
 * of ₹0 and a P&L of "three legs could not be marked" must never render
 * identically — that is the entire reason these fields are nullable.
 */
export function money(n: number | null | undefined, digits?: number, venue: VenueSpec = VENUE): string {
  if (n === null || n === undefined) return '—'
  if (venue.currency === 'USD') {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    const s = `$${inr(Math.abs(n), digits ?? 2, venue)}`
    return n < 0 ? `-${s}` : n > 0 ? `+${s}` : s
  }
  return signed(n, digits ?? 0, venue)
}

/** The venue currency's symbol, for a label: `Daily target (₹)` / `($)`. */
export function currencySymbol(venue: VenueSpec = VENUE): string {
  return venue.currency === 'USD' ? '$' : '₹'
}

/** An UNSIGNED-style amount with its symbol, for a sentence: `₹3,000`, `$3,000.00`. */
export function cash(n: number, venue: VenueSpec = VENUE): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const body = inr(Math.abs(n), venue.currency === 'USD' ? 2 : 0, venue)
  return `${n < 0 ? '-' : ''}${currencySymbol(venue)}${body}`
}

/**
 * THE ₹ SECOND FIGURE beside a USD total, at the venue's fixed rate (85).
 * Null on NSE, where the first figure already is rupees. Whole rupees: it is a
 * reading aid for an operator who thinks in ₹, not a booked amount.
 */
export function inrSecond(n: number | null | undefined, venue: VenueSpec = VENUE): string | null {
  if (venue.currency === 'INR') return null
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const r = Math.round(n * venue.inrPerUnit)
  return `≈ ${r < 0 ? '-' : ''}₹${Math.abs(r).toLocaleString('en-IN')}`
}
