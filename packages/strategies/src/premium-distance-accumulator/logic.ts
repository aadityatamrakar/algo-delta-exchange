/**
 * PremiumDistanceAccumulator — pure decision logic, ported from eagle-s-1.js.
 * D9: this class has NO exit logic anywhere, by design — do not add one.
 */

export function isCrossover(lastPrice: number, previousPrice: number, atmStrike: number): boolean {
  if (lastPrice >= atmStrike && previousPrice <= atmStrike) return true
  if (lastPrice <= atmStrike && previousPrice >= atmStrike) return true
  return false
}

export type PendingTrigger = { readonly trigger: number; readonly action: 'add_ce' | 'add_pe' }

/** Initial pair triggers (eagle-s-1.js:136-143): trg = trunc(futLtp -+ legLtp). */
export function initialTriggers(futLtp: number, ceLtp: number, peLtp: number): readonly PendingTrigger[] {
  return [
    { trigger: Math.trunc(futLtp - ceLtp), action: 'add_ce' },
    { trigger: Math.trunc(futLtp + peLtp), action: 'add_pe' },
  ]
}

/**
 * A fired 'add_ce'/'add_pe' trigger pushes TWO new triggers if the new leg's
 * premium clears premiumFloor (eagle-s-1.js:144-158) — net +1 pending trigger
 * per fill, so leg count is super-linear in path length. A rejected add
 * prunes its branch permanently (returns an empty array).
 */
export function nextTriggers(
  action: 'add_ce' | 'add_pe',
  futLtp: number,
  legLtp: number,
  premiumFloor: number,
): readonly PendingTrigger[] {
  if (legLtp <= premiumFloor) return []
  if (action === 'add_ce') {
    return [
      { trigger: Math.trunc(futLtp - legLtp), action: 'add_ce' },
      { trigger: Math.trunc(futLtp + legLtp), action: 'add_pe' },
    ]
  }
  return [
    { trigger: Math.trunc(futLtp + legLtp), action: 'add_pe' },
    { trigger: Math.trunc(futLtp - legLtp), action: 'add_ce' },
  ]
}

/** A pending trigger fires once the price crosses it in EITHER direction (eagle-s-1.js:184). */
export function triggerCrossed(trigger: number, previousPrice: number, currentPrice: number): boolean {
  return (trigger >= previousPrice && trigger <= currentPrice) || (trigger <= previousPrice && trigger >= currentPrice)
}
