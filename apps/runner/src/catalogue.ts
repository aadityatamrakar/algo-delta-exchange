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
 * Phase C §2 column ('BULL_S_1'); the config carries the LEGACY tag
 * ('Bull_S-1'), which is what its golden-master fixtures and the legacy XTS
 * account map are keyed on. Renaming either would break something real, so the
 * two are kept and joined here. `ctx.tag` is the REGISTRY tag, because that is
 * what every gate on the bridge keys on — the switch, the allowlist, the
 * journal and the P&L rollup all have to agree on one name.
 *
 * The configs are imported by RELATIVE PATH because `@algomaker/strategies`
 * exports only its barrel, and the barrel deliberately exports the class and
 * its schema rather than the concrete config records. Same pattern as
 * `apps/api/src/main.ts` importing `../../marketdata/src/sync-runner.ts`.
 */

import type { StrategyBase, StrategyContext } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '@algomaker/strategies'
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

function premiumLegBook(tag: string, cfg: typeof BULL_S_1): CatalogueEntry {
  return {
    tag,
    configTag: cfg.tag,
    underlying: cfg.underlying.symbol,
    dataNeeds: cfg.data,
    build: (ctx) => new PremiumLegBookStrategy(ctx, cfg),
  }
}

/**
 * Every hosted implementation, by registry tag.
 *
 * Only the `premium-leg-book` family is kept in the Delta desk: it is the NSE
 * BULL/LION port and the parity reference for the BULL-S decide path. The
 * other NSE families and the optionbhai signal mirrors were removed with the
 * NSE strategies (3 Nov 2026).
 */
export const CATALOGUE: ReadonlyMap<string, CatalogueEntry> = new Map(
  [
    premiumLegBook('LION_S25_2', LION_S25_2),
    premiumLegBook('BULL_S_1', BULL_S_1),
    premiumLegBook('BULL_SNX_1', BULL_SNX_1),
  ].map((e) => [e.tag, e]),
)

/**
 * Every tag the runner can host. Callers asking "can this tag run?" use this
 * rather than reading `CATALOGUE` directly, so a second hosting path can be
 * added in one place.
 */
export function isHostedTag(tag: string): boolean {
  return CATALOGUE.has(tag)
}

/** Sorted, for the portal's add form. */
export function hostedTags(): string[] {
  return [...CATALOGUE.keys()].sort()
}
