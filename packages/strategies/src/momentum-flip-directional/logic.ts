/**
 * MomentumFlipDirectional — pure decision logic, ported from cheetah-b1-1.js.
 */

/** Direction from a vs-day-open comparison (cheetah-b1-1.js:115). */
export function directionFromOpen(ltp: number, dayOpen: number): 'CE' | 'PE' {
  return ltp > dayOpen ? 'CE' : 'PE'
}

/** Martingale, capped. cheetah-b1-1.js:145: `if (quantity < 12) quantity += 1;` */
export function nextMartingaleQty(current: number, cap: number): number {
  return current < cap ? current + 1 : current
}

export interface FlipPosition {
  readonly type: 'CE' | 'PE'
  readonly entry: number
  readonly slTrigger: number
  readonly targetPrice: number
  readonly quantity: number
}

export type FlipExit = { readonly exit: false } | { readonly exit: true; readonly reason: 'TARGET' | 'SL' }

/** cheetah-b1-1.js checkSL: TARGET checked first, then SL (checkSL.js:154,163). */
export function evaluateFlipExit(position: FlipPosition, currentPrice: number): FlipExit {
  if (currentPrice >= position.targetPrice) return { exit: true, reason: 'TARGET' }
  if (currentPrice < position.slTrigger) return { exit: true, reason: 'SL' }
  return { exit: false }
}

/** Levels at entry (cheetah-b1-1.js:140-141): sl = entry - trailSl, target = entry + targetPts. */
export function computeFlipLevels(entry: number, trailSl: number, targetPts: number): { readonly slTrigger: number; readonly targetPrice: number } {
  return { slTrigger: entry - trailSl, targetPrice: entry + targetPts }
}
