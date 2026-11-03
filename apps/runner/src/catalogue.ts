/**
 * The catalogue: registry tag -> ported config + the class that runs it.
 *
 * THIS IS DATA, NOT LOGIC, and that distinction is the whole design. Adding a
 * strategy is one row here plus a config in `packages/strategies`; it is never
 * a change to `runner.ts`, which knows only that a factory hands it something
 * implementing `StrategyBase`. Phase C §3: "if adding a strategy requires
 * touching the runner, the runner is wrong."
 *
 * WHY THE REGISTRY TAG AND THE CONFIG TAG DIFFER. The registry tag is the
 * Phase C §2 column ('CHEETAH_B1_1'); the config carries the LEGACY tag
 * ('CheetahB1-1'), which is what its golden-master fixtures and the legacy XTS
 * account map are keyed on. Renaming either would break something real, so the
 * two are kept and joined here. `ctx.tag` is the REGISTRY tag, because that is
 * what every gate on the bridge keys on — the switch, the allowlist, the
 * journal and the P&L rollup all have to agree on one name.
 *
 * The configs are imported by RELATIVE PATH because `@algomaker/strategies`
 * exports only its barrel, and the barrel deliberately exports the four classes
 * and their schemas rather than the 17 concrete config records. Same pattern as
 * `apps/api/src/main.ts` importing `../../marketdata/src/sync-runner.ts`.
 */

import type { StrategyBase, StrategyContext } from '@algomaker/strategy-kit'
import {
  MomentumFlipDirectionalStrategy,
  PremiumDistanceAccumulatorStrategy,
  PremiumLegBookStrategy,
  RangeBreakoutDirectionalStrategy,
} from '@algomaker/strategies'
import { MIRRORS } from './mirrors.ts'
import { ATR_BAND_NIFTY } from '../../../packages/strategies/src/range-breakout-directional/configs/atr-band-nifty.ts'
import { BN_BREAKOUT } from '../../../packages/strategies/src/range-breakout-directional/configs/bn-breakout.ts'
import {
  ORB_FUT_BN,
  ORB_FUT_NIFTY,
  ORB_FUT_SNX,
} from '../../../packages/strategies/src/range-breakout-directional/configs/orb-fut.ts'
import {
  ORB_SCALP_BN,
  ORB_SCALP_NIFTY,
  ORB_SCALP_SNX,
} from '../../../packages/strategies/src/range-breakout-directional/configs/orb-scalp.ts'
import {
  CHEETAH_B1_1,
  CHEETAH_B1_SNX,
} from '../../../packages/strategies/src/momentum-flip-directional/configs/cheetah-b1.ts'
import { EAGLE_S_1 } from '../../../packages/strategies/src/premium-distance-accumulator/configs/eagle-s.ts'
import {
  BULL_S_1,
  BULL_SNX_1,
} from '../../../packages/strategies/src/premium-leg-book/configs/bull-s.ts'
import { LION_S25_2 } from '../../../packages/strategies/src/premium-leg-book/configs/lion-s25.ts'
import type { DataNeed } from '@algomaker/strategy-kit'

export interface CatalogueEntry {
  /** The Phase C §2 registry tag. Unique; the key everything else joins on. */
  readonly tag: string
  /** The legacy tag the config carries, kept for provenance in the logs. */
  readonly configTag: string
  /** Underlying, sent on every order so the freeze table is keyed exactly. */
  readonly underlying: string
  readonly dataNeeds: readonly DataNeed[]
  build(ctx: StrategyContext): StrategyBase
}

function rangeBreakout(
  tag: string,
  cfg: typeof BN_BREAKOUT,
): CatalogueEntry {
  return {
    tag,
    configTag: cfg.tag,
    underlying: cfg.underlying.symbol,
    dataNeeds: cfg.data,
    build: (ctx) => new RangeBreakoutDirectionalStrategy(ctx, cfg),
  }
}

function momentumFlip(tag: string, cfg: typeof CHEETAH_B1_1): CatalogueEntry {
  return {
    tag,
    configTag: cfg.tag,
    underlying: cfg.underlying.symbol,
    dataNeeds: cfg.data,
    build: (ctx) => new MomentumFlipDirectionalStrategy(ctx, cfg),
  }
}

function premiumLegBook(tag: string, cfg: typeof BULL_S_1): CatalogueEntry {
  return {
    tag,
    configTag: cfg.tag,
    underlying: cfg.underlying.symbol,
    dataNeeds: cfg.data,
    build: (ctx) => new PremiumLegBookStrategy(ctx, cfg),
  }
}

function premiumDistance(tag: string, cfg: typeof EAGLE_S_1): CatalogueEntry {
  return {
    tag,
    configTag: cfg.tag,
    underlying: cfg.underlying.symbol,
    dataNeeds: cfg.data,
    build: (ctx) => new PremiumDistanceAccumulatorStrategy(ctx, cfg),
  }
}

/**
 * Every hosted implementation, by registry tag.
 *
 * The three `MIRROR_*` rows are deliberately ABSENT. An external signal mirror
 * has no entry/exit logic, no position state and no market-data need — it is a
 * `SignalSource` adapter, not a `StrategyBase` (see
 * `packages/strategies/src/external-signal-mirror/adapter.ts`). Giving it a
 * fake lifecycle so it appears in this table would mean `Runner` supervising
 * something it cannot drive: there is no session to start, no cron to fire and
 * no square-off to back-stop.
 *
 * THEY ARE STILL HOSTED, just not here. `mirrors.ts` runs them — same registry
 * rows, same per-mode switch, same `HttpOrderGateway`, and its own runtime
 * snapshot derived from the upstream socket's real state. `main.ts` withholds
 * the MIRROR rows from `Runner` so the two hosts cannot publish over each
 * other. Adding one here would double-run it.
 */
export const CATALOGUE: ReadonlyMap<string, CatalogueEntry> = new Map(
  [
    rangeBreakout('BN_BREAKOUT', BN_BREAKOUT),
    rangeBreakout('ATR_BAND_NIFTY', ATR_BAND_NIFTY),
    rangeBreakout('ORB_FUT_NIFTY', ORB_FUT_NIFTY),
    rangeBreakout('ORB_FUT_BN', ORB_FUT_BN),
    rangeBreakout('ORB_FUT_SNX', ORB_FUT_SNX),
    rangeBreakout('ORB_SCALP_BN', ORB_SCALP_BN),
    rangeBreakout('ORB_SCALP_NIFTY', ORB_SCALP_NIFTY),
    rangeBreakout('ORB_SCALP_SNX', ORB_SCALP_SNX),
    momentumFlip('CHEETAH_B1_1', CHEETAH_B1_1),
    momentumFlip('CHEETAH_B1_SNX', CHEETAH_B1_SNX),
    premiumLegBook('LION_S25_2', LION_S25_2),
    premiumLegBook('BULL_S_1', BULL_S_1),
    premiumLegBook('BULL_SNX_1', BULL_SNX_1),
    premiumDistance('EAGLE_S_1', EAGLE_S_1),
  ].map((e) => [e.tag, e]),
)

/**
 * Every tag the runner can actually host, across BOTH hosting paths.
 *
 * THE REASON THIS EXISTS: `CATALOGUE` is not the whole answer, and callers kept
 * assuming it was. The three `MIRROR_*` tags are hosted by `MirrorHost`, not by
 * `Runner`, and are deliberately absent from `CATALOGUE` — they are
 * `SignalSource` adapters with no session, no cron schedule and no square-off,
 * so listing them there would have `Runner` supervise a lifecycle that does not
 * exist.
 *
 * But "is there an implementation for this tag?" is a different question from
 * "does `Runner` build it?", and `apps/api` was answering the first by asking
 * the second. The visible symptom: the portal refused to switch a mirror on
 * with "no hosted implementation is registered — nothing would run", about
 * three strategies that are fully implemented and whose credentials were
 * already in the environment.
 *
 * Anything asking whether a tag can run must use THIS, not `CATALOGUE`.
 */
export function isHostedTag(tag: string): boolean {
  return CATALOGUE.has(tag) || MIRRORS.has(tag)
}

/** Sorted, for the portal's add form. Both paths, one list. */
export function hostedTags(): string[] {
  return [...CATALOGUE.keys(), ...MIRRORS.keys()].sort()
}
