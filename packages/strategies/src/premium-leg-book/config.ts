import type { BaseConfig } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'

export type PremiumLegBookStop =
  | { readonly scope: 'combined'; readonly multiplier: number }
  | { readonly scope: 'per-leg'; readonly multiplier: number }

export interface PremiumLegBookConfig extends BaseConfig {
  readonly class: 'premium-leg-book'
  readonly legs: readonly { readonly type: 'CE' | 'PE'; readonly side: 'BUY' | 'SELL' }[]
  readonly stop: PremiumLegBookStop
  /** 'paired': both legs of a group re-sell together (bull). 'per-leg': each leg
   *  re-enters independently on the next crossover at its own strike (lion). */
  readonly reentry: 'paired' | 'per-leg'
  readonly squareOffIstMinute: number
}

/**
 * D9: maxLotsNet MAY be null here — bull-s-1/bull-snx-1 are explicitly
 * uncapped by owner decision. This function must never reject that.
 */
export function assertValidPremiumLegBookConfig(
  cfg: PremiumLegBookConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags)
  if (cfg.legs.length === 0) throw new Error('PremiumLegBookConfig.legs must be non-empty')
}
