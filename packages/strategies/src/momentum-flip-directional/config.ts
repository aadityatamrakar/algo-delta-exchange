import type { BaseConfig } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'

export interface MomentumFlipDirectionalConfig extends BaseConfig {
  readonly class: 'momentum-flip-directional'
  readonly trailSlPoints: number
  readonly targetPoints: number
  readonly sizing: { readonly kind: 'martingale-capped'; readonly start: number; readonly cap: number }
  readonly flip: {
    readonly onStop: true
    readonly onTarget: false // asymmetry is deliberate — never make this configurable to true here
    readonly strikeRef: 'frozen-first-atm'
  }
  readonly bootstrapDelayMs: number
  readonly squareOffIstMinute: number
}

/** cheetah-b1-2117's uncapped-martingale sibling is explicitly OUT of the active-15 config
 *  set (design spec section 4.3, OPEN item c) — this assertion is what keeps it out by
 *  construction: martingale-capped ALWAYS requires risk.maxLotsNet === sizing.cap. */
export function assertValidMomentumFlipConfig(
  cfg: MomentumFlipDirectionalConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags)
  if (cfg.risk.maxLotsNet !== cfg.sizing.cap) {
    throw new Error(
      `risk.maxLotsNet (${String(cfg.risk.maxLotsNet)}) must equal sizing.cap (${cfg.sizing.cap}) ` +
        `for martingale-capped sizing — an uncapped martingale config must not enter the active set`,
    )
  }
}
