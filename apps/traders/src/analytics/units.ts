/**
 * The book's lot unit for the per-lot view: the largest whole number of lots
 * every leg is a multiple of, so a book of −3/+3 lots reads as −1/+1 of it.
 * Anything that is not whole lots — an odd share count, an unknown lot size —
 * leaves the unit at 1, so the view never shows a fraction of a contract.
 */

import type { PayoffLeg } from '@algomaker/payoff'

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

export function bookLotGcd(legs: readonly PayoffLeg[], lotSize: number | null): number {
  if (lotSize === null || !Number.isFinite(lotSize) || lotSize <= 0) return 1
  let g = 0
  for (const l of legs) {
    const lots = Math.abs(l.qty) / lotSize
    if (!Number.isInteger(lots)) return 1
    g = gcd(lots, g)
  }
  return g > 0 ? g : 1
}
