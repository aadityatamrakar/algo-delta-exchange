/**
 * PremiumLegBook — pure decision logic.
 *
 * Ported from bull-s-1.js (combined stop, uncapped pyramid — D9) and
 * lion-s25-2.js (per-leg stop, per-leg re-entry, flat sizing).
 */

/** ATM crossover: the future/spot price crosses the rounded strike grid. */
export function isCrossover(lastPrice: number, previousPrice: number, atmStrike: number): boolean {
  if (lastPrice >= atmStrike && previousPrice <= atmStrike) return true
  if (lastPrice <= atmStrike && previousPrice >= atmStrike) return true
  return false
}

/** Combined-premium stop trigger: (ceLtp + peLtp) * multiplier, truncated per legacy parseInt. */
export function combinedStopTrigger(cePremium: number, pePremium: number, multiplier: number): number {
  return Math.trunc((cePremium + pePremium) * multiplier)
}

/** Per-leg stop trigger: legPremium * multiplier (lion-s25-2.js:148, NOT truncated — legacy keeps the float). */
export function perLegStopTrigger(legPremium: number, multiplier: number): number {
  return legPremium * multiplier
}

/** Uncapped-by-default pyramid step. D9: cap === null means unlimited, matching bull-s-1/-snx-1. */
export function nextPyramidSize(current: number, step: number, cap: number | null): number {
  if (cap !== null && current >= cap) return current
  return current + step
}
