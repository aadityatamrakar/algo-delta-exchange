import type { BaseConfig } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'

export interface PremiumDistanceAccumulatorConfig extends BaseConfig {
  readonly class: 'premium-distance-accumulator'
  readonly premiumFloor: number
  /** D9: MUST be 'none'. eagle-s-1 has never had an intraday stop — the resting-
   *  broker-stop rollout (decision 3) explicitly does NOT apply here (owner,
   *  2026-07-26). This is enforced below, not left to convention. */
  readonly stopPolicy: 'none'
  readonly squareOffIstMinute: number
}

export function assertValidPremiumDistanceAccumulatorConfig(
  cfg: PremiumDistanceAccumulatorConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags)
  if (cfg.stopPolicy !== 'none') {
    // Unreachable given the type, but kept as a runtime guard: if this class is
    // ever constructed from untyped JSON config, a stray 'resting' value must
    // fail loudly rather than silently invent a stop eagle-s-1 never had.
    throw new Error("PremiumDistanceAccumulatorConfig.stopPolicy must be 'none' (D9) — got " + String(cfg.stopPolicy))
  }
}
