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
 * `smp_order_listener` (0914) is the 16th entry in the legacy table and gets NO
 * row: it is infrastructure, not a strategy. The order gateway's fill watcher
 * replaces it, and giving it a registry row would put an on/off switch in the
 * portal that does nothing.
 */

import { isOn, type StrategyRow } from './strategies.ts'
import type { Log } from './routes/kit.ts'

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

/**
 * Reasons the seed USED to write and no longer should, cleared on the same
 * narrow terms as `LEGACY_SEEDED_REASON`.
 *
 * Both were true when written and are now false, which is worse than noise: a
 * row that explains a defect somebody already fixed sends an operator to
 * investigate nothing.
 *
 *  - ATR_BAND_NIFTY's live block. Both port defects are fixed and its golden
 *    test is green; the row was still telling anyone who looked that the test
 *    was failing.
 *  - The three mirrors' "not migrated to the broker store yet", which described
 *    a PLAN rather than a problem — and the plan changed. optionbhai is a
 *    signal source, not a broker, so its credentials live in the environment by
 *    decision, named by the config's `credentialsRef`.
 *
 * Deleting them from the seed only fixes a FRESH deployment. Every desk already
 * running keeps the text forever, because seeding is insert-only by design —
 * which is exactly how "fixed in code, still broken in production" happens.
 */
/** The mirrors' old start time, which `MirrorHost` never honoured. */
export const LEGACY_MIRROR_AUTOSTART = '0914'

export const RETIRED_SEEDED_REASONS: readonly string[] = [
  'BLOCKED FROM LIVE — golden test still failing (Phase C §6); paper only',
  'signal-source credentials not migrated to the broker store yet',
]

export interface HostedSeed {
  readonly tag: string
  readonly label: string
  /** IST 'HHmm', or '' for "start with the process" (legacy `autostart: true`). */
  readonly autostartAt: string
  /** Pre-filled when the strategy must not go live yet. Surfaced in the portal. */
  readonly disabledReason?: string
}

/**
 * The Phase C §2 table.
 *
 * COUNT NOTE: the spec says "15 strategies", which is 15 legacy MODULES. It is
 * 17 rows here because `orb-scalp.js` is a single legacy process that runs
 * three independent configs (BANKNIFTY / NIFTY / SENSEX) off one `CONFIGS`
 * array. Each needs its own switch, its own mode and its own live lot
 * allocation — collapsing them onto one row would mean disabling the SENSEX
 * variant also silently disabled the NIFTY one.
 *
 * `autostartAt` values are the legacy `delay_start` strings from
 * `archive/common/models/strategies.json`; `''` is the legacy
 * `autostart: true`, i.e. start with the process.
 */
export const HOSTED_STRATEGIES: readonly HostedSeed[] = [
  // --- external signal mirrors (delay_start 0914) ---------------------------
  // These carry a ported CONFIG but no StrategyBase implementation: an external
  // signal mirror has no entry/exit logic, no position state and no market data
  // need, so it is a SignalSource adapter rather than a scheduled strategy
  // (packages/strategies/src/external-signal-mirror/adapter.ts). They get rows
  // so their orders can be gated and switched like everything else; the runner
  // reports them as unimplemented rather than pretending to supervise them.
  //
  // Their `autostartAt` is '' — START WITH THE PROCESS — and that is not the
  // legacy 0914 it replaces.
  //
  // `MirrorHost` has no schedule and never had one: a mirror relays another
  // account's EXECUTED orders, so there is no session to open. Delaying it is
  // not merely pointless, it is DANGEROUS. If the upstream account entered at
  // 09:10 and the mirror connected at 09:14, it would miss the entry, see the
  // exit, and place a SELL with no position behind it — opening a short in the
  // wrong direction. You cannot half-mirror a round trip, so the only safe
  // start is the earliest one.
  //
  // Legacy carried that risk because pm2 started those three at delay_start
  // 0914. Keeping the number here would have kept a column telling the operator
  // a time nothing honours.
  //
  // They carry NO `disabledReason`. They used to say the credentials were "not
  // migrated to the broker store yet", which described a plan rather than a
  // problem — and the plan changed: optionbhai is a signal source, not a
  // broker, so its credentials live in the environment by decision. The config's
  // `credentialsRef` names the pair (`optionbhai/1pbuy` ->
  // OPTIONBHAI_1PBUY_USER / _PASS), and a mirror whose pair is absent refuses to
  // start and says so at that moment — which is the honest place to report it,
  // not a permanent line on a registry row.
  {
    tag: 'MIRROR_1PBUY',
    label: 'Mirror 1PBUY (optionbhai)',
    autostartAt: '',
  },
  {
    tag: 'MIRROR_A006',
    label: 'Mirror A006 (optionbhai)',
    autostartAt: '',
  },
  {
    tag: 'MIRROR_A010',
    label: 'Mirror A010 (optionbhai)',
    autostartAt: '',
  },
  {
    tag: 'MIRROR_EMA2050',
    label: 'Mirror EMA2050 (optionbhai)',
    autostartAt: '',
  },

  // --- directional breakout ------------------------------------------------
  { tag: 'BN_BREAKOUT', label: 'BANKNIFTY first-candle breakout', autostartAt: '0916' },

  // --- momentum flip -------------------------------------------------------
  { tag: 'CHEETAH_B1_1', label: 'Cheetah B1 BANKNIFTY', autostartAt: '0917' },
  { tag: 'CHEETAH_B1_SNX', label: 'Cheetah B1 SENSEX', autostartAt: '0917' },

  // --- ATR band ------------------------------------------------------------
  {
    tag: 'ATR_BAND_NIFTY',
    label: 'ATR band NIFTY',
    autostartAt: '0918',
    // Phase C §6's live block is GONE, and so is the reason string that carried
    // it. Both port defects are fixed — the band forms in two steps (60-minute
    // ATR width at 10:15, lines anchored on the 11:40 five-minute close), and
    // the candle-close stop reads the UNDERLYING series rather than the
    // option's own. The golden test is green and is now the regression guard.
    //
    // The string is deleted rather than reworded because `disabledReason` is
    // for a reason a HUMAN recorded. A row that keeps explaining a defect that
    // no longer exists is worse than a blank one: once every row carries text,
    // a real reason is invisible in the noise.
  },

  // --- opening-range futures (delay_start 0918) ----------------------------
  { tag: 'ORB_FUT_NIFTY', label: 'ORB futures NIFTY', autostartAt: '0918' },
  { tag: 'ORB_FUT_BN', label: 'ORB futures BANKNIFTY', autostartAt: '0918' },
  { tag: 'ORB_FUT_SNX', label: 'ORB futures SENSEX', autostartAt: '0918' },

  // --- opening-range option scalps (one legacy process, three configs) ------
  { tag: 'ORB_SCALP_BN', label: 'ORB scalp BANKNIFTY', autostartAt: '0918' },
  { tag: 'ORB_SCALP_NIFTY', label: 'ORB scalp NIFTY', autostartAt: '0918' },
  { tag: 'ORB_SCALP_SNX', label: 'ORB scalp SENSEX', autostartAt: '0918' },

  // --- premium sellers (were legacy `autostart: true`) ----------------------
  // These entered THE INSTANT they started. Legacy `autostart: true` became
  // '', the day-roll floor turned '' into the 09:15 bell, and all four sold
  // straddles into the opening auction's first prints — the thinnest, most
  // whipsaw-prone minutes of the day. 0918 lets the open settle first. The
  // breakout family is different: it needs the bell's ticks to BUILD its
  // opening range and places nothing until the range breaks, so it keeps
  // its earlier starts.
  { tag: 'LION_S25_2', label: 'Lion S25-2 BANKNIFTY straddle', autostartAt: '0918' },
  { tag: 'EAGLE_S_1', label: 'Eagle S-1 BANKNIFTY premium ladder', autostartAt: '0918' },
  { tag: 'BULL_S_1', label: 'Bull S-1 BANKNIFTY straddle', autostartAt: '0918' },
  { tag: 'BULL_SNX_1', label: 'Bull SNX-1 SENSEX straddle', autostartAt: '0918' },
]

/**
 * The premium sellers' old seeded value — '' meant "start with the process",
 * which `sessionStartMinute`'s floor turns into an entry at the 09:15 bell.
 * Repaired to the seed's 0918 on the same exact-old-value terms as the
 * mirrors' 0914: rows already in Mongo keep '' forever otherwise, and an
 * operator who chose a real time of their own is never touched.
 */
export const LEGACY_BELL_AUTOSTART = ''
export const LEGACY_BELL_TAGS: readonly string[] = [
  'LION_S25_2',
  'EAGLE_S_1',
  'BULL_S_1',
  'BULL_SNX_1',
]

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
): Promise<{ added: number; cleared: number }> {
  let added = 0
  let cleared = 0
  for (const seed of HOSTED_STRATEGIES) {
    const existing = await store.loadStrategy(seed.tag)
    if (existing !== null) {
      /**
       * The repair, and it is the only write this function makes to an
       * existing row.
       *
       * Guarded three ways, because rule 1 says a redeploy must never undo an
       * operator's decision: the text must be the exact legacy filler, this
       * seed must not have declared a real reason of its own (the `MIRROR_*`
       * rows keep theirs — an unmigrated credential is a genuine blocker the
       * operator would otherwise have to rediscover), and the row must still
       * be off in BOTH modes. A row someone switched on and back off with a
       * note of their own matches none of those.
       */
      /**
       * The mirrors' 0914 became '' (start with the process) because
       * `MirrorHost` never honoured a schedule — see the block above
       * HOSTED_STRATEGIES. Repaired on the same terms as a retired reason: the
       * exact old value only, and never a row somebody switched on.
       */
      // NO switched-on guard here, unlike every other repair, and the reason is
      // specific rather than a relaxation: `autostartAt` is INERT for a mirror.
      // `MirrorHost` never reads it and `Runner` excludes MIRROR_* entirely, so
      // correcting it cannot change what runs — there is no behaviour to
      // protect. Keeping the guard only meant the rows an operator actually
      // uses were the ones left displaying a time nothing honours, which is
      // exactly backwards.
      if (
        existing.autostartAt === LEGACY_MIRROR_AUTOSTART &&
        seed.autostartAt !== LEGACY_MIRROR_AUTOSTART &&
        seed.tag.startsWith('MIRROR_')
      ) {
        if (await store.repairSeededAutostart(seed.tag, LEGACY_MIRROR_AUTOSTART, seed.autostartAt)) {
          log('mirror autostart corrected — MirrorHost has no schedule', { tag: seed.tag })
        }
      }

      // The premium sellers' '' -> 0918, and DELIBERATELY no switched-on
      // guard — the opposite reasoning from the mirrors'. There the field was
      // inert so correcting it changed nothing; here it is honoured, and the
      // rows an operator runs are precisely the ones entering at the bell,
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
        (existing.disabledReason === LEGACY_SEEDED_REASON ||
          RETIRED_SEEDED_REASONS.includes(existing.disabledReason)) &&
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
