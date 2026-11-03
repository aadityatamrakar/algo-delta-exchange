/**
 * Seeds `desk-strategies` with the hosted intraday strategies (Phase C §2).
 *
 * Called once at boot from `main.ts`.
 *
 * TWO RULES, and the whole file exists to keep them:
 *
 *  1. **It only ever INSERTS.** A row that already exists is left completely
 *     alone — `enabled`, `mode`, `liveLots`, `autostartAt`, everything. A
 *     redeploy that silently re-enables something an operator turned off is
 *     worse than no seeding at all: the operator's last action is the one that
 *     should still be in force in the morning, and a deployment is not an
 *     instruction to trade. This is also why `store.registerStrategy` (an
 *     upsert that overwrites) is only reached for tags that are absent.
 *  2. **Every seeded row is ADDED TO PAPER AND SWITCHED OFF.** A row created by
 *     a deployment is a NAME, not a trading permission. Turning one on is a
 *     deliberate human act in the portal, which is exactly the property the
 *     switch was introduced for. It is added to the PAPER page (and never to
 *     live) so an operator can find it and switch it on there without first
 *     having to know it exists — the same place the old `mode: 'paper'` seed
 *     put it. Live membership is always the operator's own act.
 *  3. **A seeded row carries NO `disabledReason` unless there is a real one.**
 *     Off with no reason is the correct representation of a row nobody has
 *     switched on yet. See `LEGACY_SEEDED_REASON` for what filling it in cost.
 *
 * WHY THE TABLE IS HERE AND NOT IN THE RUNNER: the runner must know nothing
 * about any individual strategy (Phase C §3). This is a seed list — data about
 * which names exist and when they historically started — read once at boot.
 * Adding a strategy is a row here plus a config in `packages/strategies`; it is
 * never a change to the runner's lifecycle code.
 *
 */

import { isOn, type StrategyRow } from './strategies.ts'
import type { Log } from './routes/kit.ts'
import { venueFromEnv, type VenueSpec } from '@algomaker/venue'

/**
 * The persistence this needs, as a narrow port — `DeskStore` satisfies it.
 * Two methods rather than the whole store, so the idempotency rule above is
 * testable against a fake with no Mongo anywhere near it.
 */
export interface SeedStore {
  loadStrategy(tag: string): Promise<StrategyRow | null>
  registerStrategy(
    row: Partial<StrategyRow> & { tag: string },
    nowMs: number,
  ): Promise<StrategyRow>
  /**
   * Narrow repair for an `autostartAt` the seed has since changed. Matches the
   * exact old value, so an operator's own choice is never overwritten.
   */
  repairSeededAutostart(tag: string, from: string, to: string): Promise<boolean>
  /** Narrow repair for `LEGACY_SEEDED_REASON`. Returns whether it cleared one. */
  clearSeededDisabledReason(tag: string, seeded: string): Promise<boolean>
  /**
   * Delete a HOSTED row only if no registry book and no trade names its tag.
   * Returns whether a row went.
   */
  deleteUnusedHostedRow(tag: string): Promise<boolean>
}

/**
 * The filler this seeder used to write into `disabledReason`, and now removes.
 *
 * It said "not yet enabled by an operator", which only restates a switch that
 * is off — something the control beside it already shows. Fifteen rows carrying it turned the strategies page into
 * fifteen lines of the same non-reason, and that is not merely noisy: once
 * every row has a reason, the field stops meaning anything and a REAL one
 * ("disabled for margin", "misfiring on gap days") is invisible in it.
 *
 * The rows already in Mongo would keep the text forever, because seeding is
 * insert-only by design (rule 1) and must stay that way — so the repair below
 * is a separate, narrow write that matches this EXACT string on a row still
 * switched off everywhere. An operator's own note cannot collide with it.
 */
export const LEGACY_SEEDED_REASON = 'not yet enabled by an operator'

export interface HostedSeed {
  readonly tag: string
  readonly label: string
  /** IST 'HHmm', or '' for "start with the process" (legacy `autostart: true`). */
  readonly autostartAt: string
  /** Pre-filled when the strategy must not go live yet. Surfaced in the portal. */
  readonly disabledReason?: string
}

/**
 * The hosted rows: the `premium-leg-book` family, the only one the Delta desk
 * keeps (3 Nov 2026 — the other NSE families and the optionbhai signal mirrors
 * were removed). Each row here must have a `CATALOGUE` entry in
 * `apps/runner/src/catalogue.ts`; `apps/runner/test/catalogue.test.ts` checks it.
 *
 * 0918, not '' (start with the process): '' was the legacy `autostart: true`,
 * which the day-roll floor turned into an entry at the 09:15 bell, selling
 * straddles into the opening auction's first prints. 0918 lets the open settle.
 */
export const HOSTED_STRATEGIES: readonly HostedSeed[] = [
  { tag: 'LION_S25_2', label: 'Lion S25-2 BANKNIFTY straddle', autostartAt: '0918' },
  { tag: 'BULL_S_1', label: 'Bull S-1 BANKNIFTY straddle', autostartAt: '0918' },
  { tag: 'BULL_SNX_1', label: 'Bull SNX-1 SENSEX straddle', autostartAt: '0918' },
]

/**
 * The premium sellers' old seeded value — '' meant "start with the process",
 * which `sessionStartMinute`'s floor turns into an entry at the 09:15 bell.
 * Repaired to the seed's 0918 on exact-old-value terms: rows already in Mongo
 * keep '' forever otherwise, and an
 * operator who chose a real time of their own is never touched.
 */
export const LEGACY_BELL_AUTOSTART = ''
export const LEGACY_BELL_TAGS: readonly string[] = ['LION_S25_2', 'BULL_S_1', 'BULL_SNX_1']

/**
 * Insert any missing hosted row, and clear the legacy filler reason from rows
 * that already have it. Returns how many were created and how many repaired.
 *
 * Idempotent by construction: the second run finds every tag, inserts nothing
 * and repairs nothing, so it is safe on every boot and every redeploy.
 */
export async function seedHostedStrategies(
  store: SeedStore,
  nowMs: number,
  log: Log,
  venue: VenueSpec = venueFromEnv(),
): Promise<{ added: number; cleared: number }> {
  let added = 0
  let cleared = 0
  if (venue.id === 'dx') {
    // The catalogue is NSE BANKNIFTY/SENSEX straddles: nothing for DX to host.
    // Rows an earlier boot seeded are removed unless a book or a trade uses them.
    const removed: string[] = []
    for (const seed of HOSTED_STRATEGIES) {
      if (await store.deleteUnusedHostedRow(seed.tag)) removed.push(seed.tag)
    }
    if (removed.length > 0) log('removed unused NSE catalogue rows', { tags: removed })
    return { added, cleared }
  }
  for (const seed of HOSTED_STRATEGIES) {
    const existing = await store.loadStrategy(seed.tag)
    if (existing !== null) {
      /**
       * The repair, and it is the only write this function makes to an
       * existing row.
       *
       * Guarded three ways, because rule 1 says a redeploy must never undo an
       * operator's decision: the text must be the exact legacy filler, this
       * seed must not have declared a real reason of its own, and the row must
       * still be off in BOTH modes. A row someone switched on and back off with a
       * note of their own matches none of those.
       */
      // The premium sellers' '' -> 0918, and DELIBERATELY no switched-on
      // guard: the field is honoured, and the rows an operator runs are
      // precisely the ones entering at the bell,
      // which is the behaviour being retired. '' was the seed's own value,
      // never an operator's choice of time, so the exact-match still protects
      // every deliberately chosen start.
      if (
        LEGACY_BELL_TAGS.includes(seed.tag) &&
        existing.autostartAt === LEGACY_BELL_AUTOSTART &&
        seed.autostartAt !== LEGACY_BELL_AUTOSTART
      ) {
        if (await store.repairSeededAutostart(seed.tag, LEGACY_BELL_AUTOSTART, seed.autostartAt)) {
          log('premium-seller autostart corrected — no more entries at the bell', {
            tag: seed.tag,
            autostartAt: seed.autostartAt,
          })
        }
      }

      if (
        seed.disabledReason === undefined &&
        existing.disabledReason === LEGACY_SEEDED_REASON &&
        !isOn(existing.modes, 'paper') &&
        !isOn(existing.modes, 'live')
      ) {
        if (await store.clearSeededDisabledReason(seed.tag, existing.disabledReason)) {
          cleared++
          log('cleared the legacy seeded disabledReason', { tag: seed.tag })
        }
      }
      continue
    }

    await store.registerStrategy(
      {
        tag: seed.tag,
        kind: 'hosted',
        label: seed.label,
        // Rule 2. Added to paper, switched off. Never on, not even for a
        // strategy that was running in the legacy system — the switch is the
        // whole point of the registry — and never added to live.
        modes: { paper: { enabled: false } },
        // Zero, not one. `liveLots` is the LIVE size override, and a default of
        // 1 would mean flipping a row to live silently authorised a real lot.
        // submit.ts refuses a live entry while this is 0, so the operator has
        // to state the size deliberately.
        liveLots: 0,
        autostartAt: seed.autostartAt,
        // Rule 3: '' unless this seed states a genuine blocker.
        disabledReason: seed.disabledReason ?? '',
      },
      nowMs,
    )
    added++
    log('hosted strategy registered (switched off)', {
      tag: seed.tag,
      autostartAt: seed.autostartAt === '' ? 'at boot' : seed.autostartAt,
    })
  }
  return { added, cleared }
}
