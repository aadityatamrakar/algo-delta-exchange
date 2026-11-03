/**
 * The strategy registry and its on/off switch.
 *
 * Every trading source gets a row — the external Python desk today, hosted
 * strategies in Phase C — and a row that is off stops that source dead. One
 * surface, not two: `kind` is the only thing that differs between a book run by
 * a Python process and one run by our own runner.
 *
 * THE ASYMMETRY WITH THE KILL SWITCH IS DELIBERATE (spec §4, and it is the
 * reason this lives beside `safety.ts` rather than inside it):
 *
 *   - The halt in safety.ts blocks NEW EXPOSURE and never an exit, because
 *     trapping a position behind a safety control is worse than whatever the
 *     control was protecting against.
 *   - This switch blocks EXITS TOO. "Stop this strategy trading" means exactly
 *     that, and a strategy still closing and rolling legs while switched off is
 *     still trading — the operator turned it off precisely because they no
 *     longer trust its judgement about when to be out.
 *
 * The escape hatch is `close-all`, which runs as the OPERATOR rather than as
 * the strategy and is therefore exempt from this gate — the same exemption it
 * already has from the kill switch. So "off means off" never traps a position:
 * it just means the human, not the strategy, decides how it comes off.
 *
 * AN UNKNOWN TAG IS REJECTED, never implicitly allowed. A client with a typo in
 * its tag has no row and therefore no switch anywhere in the portal; letting it
 * through would put real orders on the wire under a name nobody configured,
 * with no way to stop them short of killing the process.
 *
 * THE SWITCH IS PER MODE (contract addendum 2026-07-27b). A strategy runs in
 * paper and live AT THE SAME TIME, so one boolean pair — not an `enabled` flag
 * beside a `mode` — is the switch. See `StrategyModes` for why the old pair
 * cannot survive as an alias.
 *
 * Everything here is PURE: the gate takes a row (or null) and returns a verdict,
 * the patch takes a row and returns a row. The store does all the reading and
 * writing, so the whole of the switch's behaviour is testable without Mongo.
 */

import type { DeskAction, DeskMode, Skip } from './contract.ts'
import type { Validated } from './validate.ts'
import { API_VENUE, formatMoney, type VenueSpec } from './venue.ts'

/** Who runs the process. Nothing else about a row depends on this. */
export type StrategyKind = 'external' | 'hosted'

/**
 * Membership of one mode. Present means ADDED to that rail's page.
 *
 * A separate type rather than a bare boolean because there is a third state
 * below, and collapsing it back would take the pause button away.
 */
export interface ModeMembership {
  readonly enabled: boolean
}

/**
 * The switch: per rail, and THREE STATES, not two.
 *
 *   key absent            — not added to that mode. Invisible on its page.
 *   key present, off      — added, listed in the table, not trading.
 *   key present, enabled  — trading.
 *
 * WHY MEMBERSHIP AND ENABLEMENT ARE SEPARATE. Each mode's page lists only the
 * strategies added to it, because the registry grows well past what is useful
 * to scroll. With one boolean carrying both meanings, switching a strategy off
 * would remove it from the very table its switch lives in — so pausing a
 * strategy for an afternoon would mean deleting the row and recreating it, and
 * the operator would lose its live lots and autostart in the process. Adding
 * and permitting are separate acts, and so are removing and pausing.
 *
 * THIS REPLACES `enabled` + `mode`, and neither of those survives as an alias.
 * Two fields that can disagree about whether live trading is on is precisely
 * the state a gate must never have to arbitrate — the re-auth bypass fixed in
 * `routes/desk.ts` (two concurrent patches, `{enabled:true}` and
 * `{mode:'live'}`, each individually harmless, combining into an unconfirmed
 * live enable) came from exactly that split. One field, one answer, one write.
 *
 * It is also what the operator actually asked for: a strategy running in paper
 * and live at once. Under the old pair that was unrepresentable, so proving out
 * a change on paper meant taking the live book off the air.
 */
export interface StrategyModes {
  readonly paper?: ModeMembership
  readonly live?: ModeMembership
}

/** Added to nothing. The value every unreadable or half-written row falls back to. */
export const MODES_NONE: StrategyModes = {}

/** Is this mode on the row's page at all? Membership, not permission. */
export function isAdded(modes: StrategyModes, mode: DeskMode): boolean {
  return modes[mode] !== undefined
}

/**
 * THE PERMISSION. Added AND switched on — nothing else trades.
 *
 * `?.enabled === true`, so both "not added" and "added but off" answer false,
 * and neither can be reached by a truthy value out of a hand-edited document.
 */
export function isOn(modes: StrategyModes, mode: DeskMode): boolean {
  return modes[mode]?.enabled === true
}

/** The one method of `desk-strategies` the live allowlist needs. */
export interface StrategyLookup {
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>
}

/**
 * THE LIVE ALLOWLIST, read from the strategy row rather than from the
 * environment.
 *
 * It used to be `DESK_LIVE_TAGS`, an env var each of the two gating processes
 * read once at boot. That made enabling a tag a two-place, restart-requiring
 * operation, and the restart is easy to get wrong: `pm2 restart <name>
 * --update-env` does NOT re-parse the ecosystem file that reads `.env.local`,
 * so the change silently does not land and the refusal still names the
 * allowlist.
 *
 * The `modes.live` switch on the Strategies page is already the
 * password-gated action (`routes/desk.ts` re-auths before turning it on), so
 * it is the stronger control and the one an operator actually uses. Sourcing
 * the allowlist from it removes the duplicate, and takes effect immediately.
 *
 * **This narrows defence in depth, deliberately.** Enabling live used to need
 * shell access to the box AND the operator password; now the password alone
 * does it. `envRestriction` is what remains of the box-level lock: when
 * non-empty it can only NARROW the set, never widen it, so a machine can still
 * be pinned to a subset regardless of what the dashboard says. Empty — the
 * default — means no extra restriction, which is the OPPOSITE of the old
 * meaning of an empty `DESK_LIVE_TAGS`.
 *
 * Queried per order rather than cached: an operator switching a tag off
 * mid-session must stop it routing on the very next order, and a cache is
 * exactly the thing that would let one more through.
 *
 * FAILS CLOSED. A store that throws answers `false`, because an unreachable
 * database must never read as "no restriction" — that would turn a Mongo
 * outage into an open live rail.
 */
export function liveAllowlistFromStrategies(
  strategies: StrategyLookup,
  envRestriction: ReadonlySet<string>,
): (tag: string) => Promise<boolean> {
  return async (tag: string): Promise<boolean> => {
    if (envRestriction.size > 0 && !envRestriction.has(tag)) return false
    try {
      const row = await strategies.findOne({ tag })
      if (row === null) return false
      const modes = row['modes']
      if (typeof modes !== 'object' || modes === null) return false
      const live = (modes as Record<string, unknown>)['live']
      if (typeof live !== 'object' || live === null) return false
      return (live as Record<string, unknown>)['enabled'] === true
    } catch {
      return false
    }
  }
}

/** Set one mode's membership without disturbing the other. */
export function withMode(
  modes: StrategyModes,
  mode: DeskMode,
  membership: ModeMembership | null,
): StrategyModes {
  const next: { paper?: ModeMembership; live?: ModeMembership } = {}
  for (const m of ['paper', 'live'] as const) {
    const value = m === mode ? membership : (modes[m] ?? null)
    // Assigned only when present: `exactOptionalPropertyTypes` makes an
    // explicit `undefined` a different thing from an absent key, and the whole
    // three-state model rests on that distinction being real.
    if (value !== null) next[m] = value
  }
  return next
}

/**
 * THE DAY GUARD'S LINES, in the venue currency (rupees on NSE, USD on DX), both POSITIVE.
 *
 * `stop` is a positive number and the guard compares against `-stop`. A signed
 * field would let an operator type `3000` meaning "stop me at minus three
 * thousand" and arm a control that can only fire on a PROFIT — the one typo in
 * this feature that silently disables the protection it looks like it enabled.
 * Absent means unarmed: there is no zero that means "no limit", because zero is
 * a line a book crosses on its first tick.
 *
 * Enforced in `day-guard.ts`, which is the only writer of `disabledByGuard`.
 */
export interface DailyLimits {
  readonly target?: number
  readonly stop?: number
}

/**
 * The ceiling on either line. Ten million rupees is far past any book this desk
 * runs, and a fat-fingered `100000000` is a limit that would never fire — which
 * looks exactly like an armed guard and behaves exactly like an unarmed one.
 */
export const DAILY_LIMIT_MAX = 10_000_000

/** Which line the guard crossed. */
export type GuardTrigger = 'target' | 'stop'

/**
 * The mark the day guard leaves when IT, rather than the operator, switched a
 * rail off.
 *
 * IT IS THE DISCRIMINATOR THE MORNING RE-ARM READS. A row switched off by a
 * human ("misfiring on gap days") and a row stopped by its own stop-loss look
 * identical on the switch, and re-arming the first at 08:45 would put back
 * something the operator deliberately took down.
 *
 * PER RAIL, not one stamp on the row. A strategy running on both rails can hit
 * its stop on paper and its target on live in the same session, and a single
 * field would have to lose one of them — after which the paper re-arm would be
 * deciding on the live rail's evidence.
 */
export interface GuardStamp {
  /** IST 'YYYY-MM-DD' of the trip. `< today` is what makes a row re-armable. */
  readonly day: string
  readonly trigger: GuardTrigger
}

export interface GuardStamps {
  readonly paper?: GuardStamp
  readonly live?: GuardStamp
}

export interface StrategyRow {
  /** The order-bus tag every decision arrives under. Unique; the primary key. */
  readonly tag: string
  readonly kind: StrategyKind
  readonly label: string
  /** The switch, per rail. Replaces `enabled` + `mode`; see `StrategyModes`. */
  readonly modes: StrategyModes
  /** Lots to trade when live. Read by the Phase C runner, not by this gate. */
  readonly liveLots: number
  /** IST 'HHmm', or '' for "start with the process". */
  readonly autostartAt: string
  readonly lastSeenAt: number
  /** Why it was switched off. Surfaced in the skip reason so the desk sees it. */
  readonly disabledReason: string
  /** Absent = unarmed. Applies to BOTH rails, judged per rail. */
  readonly dailyLimits?: DailyLimits
  /** Written only by `day-guard.ts`; cleared when the rail is switched back on. */
  readonly disabledByGuard?: GuardStamps
  readonly updatedAt: number
}

export const DEFAULT_STRATEGY: Omit<StrategyRow, 'tag'> = {
  kind: 'external',
  label: '',
  // ADDED TO NOTHING. A row created by anything other than a deliberate
  // per-mode add-then-enable must not be a trading permission — that is why
  // POST /v1/desk/strategies cannot create a row that is already switched on.
  modes: MODES_NONE,
  liveLots: 0,
  autostartAt: '',
  lastSeenAt: 0,
  disabledReason: '',
  updatedAt: 0,
}

/**
 * Raised when a decision arrives under a tag that has no registry row.
 *
 * A thrown error rather than a skip, because the two situations need different
 * responses and must not look alike: "the operator switched me off" is a normal
 * state the desk should wait out, while "nobody has ever heard of this tag" is a
 * misconfiguration only a human can fix. The HTTP layer turns this into a 403 so
 * the typo shows up in the CLIENT's own log rather than only in ours.
 */
export class UnknownStrategy extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'UnknownStrategy'
  }
}

export type StrategyGate =
  | { readonly allowed: true; readonly row: StrategyRow }
  | {
      readonly allowed: false
      /** False only for a tag with no row at all — see UnknownStrategy. */
      readonly registered: boolean
      readonly reason: string
    }

/**
 * The whole of the switch. Pure, and the only place the verdict is decided.
 *
 * PER MODE. `modes.paper` and `modes.live` are answered independently, so a row
 * switched on for paper and off for live refuses the live order and passes the
 * paper one — with no third state anywhere that could disagree about which.
 * The mode comes from the request being gated, never from the row: the row says
 * what is PERMITTED, the request says what is being attempted.
 *
 * A REDUCE-ONLY ORDER PASSES A SWITCHED-OFF ROW (`opts.reducesExposure`). This
 * used to be the one deliberate difference from the kill switch — "a close is
 * treated exactly like an open" — and 2026-08-04 is why it no longer is. The
 * runner's own switch-off path SQUARES OFF as it stops (`runner.ts:#stopOne`),
 * so the flatten this gate was refusing was the one the switch itself had just
 * ordered: every closing order came back "switched off for paper", four
 * strategies parked in `failed` with their positions stranded, and the retry
 * loop spammed the log for hours. A switch that cannot be turned off without
 * trapping what it holds is the same trap the kill switch's exemption exists
 * to avoid, so the same asymmetry applies: OFF stops new exposure; it never
 * refuses an exit.
 *
 * The exemption is claimed by the CALLER (`reducesExposure` on the submit
 * body), exactly as the kill switch's is — the gate has no book to check it
 * against, and the same trust already decides GATE 3. It applies ONLY to the
 * switched-off branch: an unregistered tag has no switch an operator could
 * ever have used, and a mode that was never added has no positions a
 * legitimate exit could be closing — both keep refusing everything.
 *
 * WHO CLAIMS IT, AS OF THE ENGINE ENDPOINT (2026-08-21):
 *
 *   - `/v1/desk/submit` — the claim is a FIELD ON THE REQUEST BODY, trusted,
 *     as it always was.
 *   - `/v1/desk/engine/decisions` — the recenter supervisor's path, and the
 *     first `applyDecision` caller to claim the exemption at all. It is
 *     DERIVED, NEVER TRUSTED: `routes/engine.ts` computes it from the book
 *     with `addsExposure`, and `applyDecision` then ANDs that claim against a
 *     fresh check on its own, later book read — so a leg that appeared between
 *     the two reads downgrades the claim rather than riding it. A body field
 *     could not have been checked at all.
 *   - A caller that claims nothing gets `reducesExposure: false` and is
 *     refused on every action, closes included — absent is not an exemption.
 *
 * THE LIVE RAIL AGREES NOW, and used to not (fixed with the D9 cutover).
 * `LiveRail` re-checks this very switch when it writes, which is deliberate —
 * the second of two independent gates has to be able to answer for itself —
 * and it had NO reduce-only exemption at all. So a switched-off LIVE tag's
 * exit passed THIS gate and was refused by that one, as a route error: "off"
 * meant "cannot get out", which is precisely the trap this exemption exists to
 * avoid. The rail now runs its own version of the same rule (`rail.ts:#exits`),
 * DERIVED from the stored legs rather than claimed by a caller, because a rail
 * that took anyone's word for "this is an exit" would be a live-order gate
 * that any caller could open by saying so.
 */
export function gateStrategy(
  tag: string,
  row: StrategyRow | null,
  mode: DeskMode,
  opts: { readonly reducesExposure?: boolean } = {},
): StrategyGate {
  if (row === null) {
    return {
      allowed: false,
      registered: false,
      reason:
        `strategy ${tag} is not registered — add it to desk-strategies before it can trade ` +
        `(an unregistered tag has no switch in the portal, so it could not be stopped)`,
    }
  }
  if (!isAdded(row.modes, mode)) {
    return {
      allowed: false,
      registered: true,
      // Distinguished from "switched off" because the fixes differ: one is a
      // toggle on the page the operator is already looking at, the other means
      // the strategy is not on that page at all and has to be added first.
      reason:
        `strategy ${tag} is not added to ${mode} — add it on the ${mode} strategies page ` +
        `before it can trade there`,
    }
  }
  if (!isOn(row.modes, mode)) {
    // The reduce-only exemption — see the header. Placed AFTER the added
    // check on purpose: "added and switched off" is the operator's routine
    // stop control and must release what it holds; "never added" is not a
    // state a legitimate position can be exiting from.
    if (opts.reducesExposure === true) return { allowed: true, row }
    const why = row.disabledReason.trim() === '' ? '' : ` (${row.disabledReason.trim()})`
    return {
      allowed: false,
      registered: true,
      // The mode is NAMED. "strategy X is switched off" on a row that is
      // happily trading paper would send an operator looking for a fault that
      // is not there; the refusal has to say which switch it read.
      reason: `strategy ${tag} is switched off for ${mode}${why}`,
    }
  }
  return { allowed: true, row }
}

/**
 * Every action in the decision, as a skip carrying the same reason.
 *
 * ALL of them, including closes and rolls. Reported per action rather than once
 * per decision so the desk's existing skip handling sees exactly what did not
 * happen, in the same shape as every other skip.
 */
export function blockedSkips(actions: readonly DeskAction[], reason: string): Skip[] {
  return actions.map((action) => ({ action, reason }))
}

/**
 * Journal rows for a blocked decision, shaped like `apps/order-gateway`'s
 * `OrderEvent` so the portal's order feed renders them with no changes.
 *
 * Built here, written by the store: the point of the feed is that "why did
 * nothing trade this morning?" is answerable from the portal, and a rejection
 * that leaves no trace makes a switched-off strategy indistinguishable from a
 * dead one.
 */
export function blockedEvents(input: {
  readonly tag: string
  readonly symbol: string
  readonly decisionId: string
  readonly actions: readonly DeskAction[]
  readonly reason: string
  readonly nowMs: number
  /**
   * WHICH RAIL WAS REFUSED. Stamped into `detail` because the order log is
   * scoped by mode (`PnlStore.orderEvents`) and an event that does not say
   * which mode it belongs to is read as LIVE — so an unstamped paper refusal
   * would vanish from the paper log and appear under a rail that never saw it.
   * That is the 2026-07-28 defect this whole change is about; leaving one
   * writer unstamped reintroduces it for exactly the rows an operator asking
   * "why did nothing trade this morning?" is looking for.
   */
  readonly mode: DeskMode
}): Record<string, unknown>[] {
  return input.actions.map((action, i) => ({
    // Same derivation as a routed order's id, so a blocked attempt and a later
    // successful retry of the same decision line up in the journal.
    clientOrderId: `${input.decisionId}#${i}`,
    phase: 'INVALID',
    ok: false,
    tag: input.tag,
    // The underlying, NOT the action's `ts`: that is a desk leg id, not an
    // exchange symbol (see contract.ts), and nothing here resolved a contract.
    tradingsymbol: input.symbol,
    ts: input.nowMs,
    error: input.reason,
    detail: {
      mode: input.mode,
      op: action.op,
      deskTag: action.ts,
      decisionId: input.decisionId,
    },
  }))
}

// ------------------------------------------------------------------ patching

/** Set one rail's guard stamp without disturbing the other. `null` removes it. */
export function withStamp(
  stamps: GuardStamps,
  mode: DeskMode,
  stamp: GuardStamp | null,
): GuardStamps {
  const next: { paper?: GuardStamp; live?: GuardStamp } = {}
  for (const m of ['paper', 'live'] as const) {
    const value = m === mode ? stamp : (stamps[m] ?? null)
    // Same `exactOptionalPropertyTypes` discipline as `withMode`: an explicit
    // `undefined` is a different thing from an absent key, and "no stamp" has
    // to be the absent key or the re-arm's `.day` read would see it.
    if (value !== null) next[m] = value
  }
  return next
}

export interface StrategyPatch {
  /**
   * Partial by mode: `{ live: { enabled: false } }` turns live off and leaves
   * paper exactly as it was. An operator stopping live trading must not have to
   * restate the paper switch, or the restatement itself becomes a way to flip
   * it by accident.
   *
   * IT ONLY EVER FLIPS A SWITCH — it cannot ADD a mode or REMOVE one. A patch
   * naming a mode the row has not been added to is a no-op here and a 400 at
   * the route, because a toggle that silently created membership would make
   * "add to live" reachable without the add form's own checks (the catalogue
   * check especially). Removal is `DELETE .../modes/:mode`.
   */
  readonly modes?: { readonly paper?: ModeMembership; readonly live?: ModeMembership }
  readonly liveLots?: number
  readonly autostartAt?: string
  readonly disabledReason?: string
  /**
   * The day guard's lines. `null` CLEARS them (disarms the guard); an object
   * replaces them wholesale, so `{ target: 10000 }` leaves no stop behind.
   *
   * Wholesale rather than field-by-field because the two lines are read
   * together: a partial merge would make "raise the target and drop the stop"
   * an edit an operator cannot express, and the shape they end up with would
   * depend on what the row happened to hold.
   */
  readonly dailyLimits?: DailyLimits | null
  /**
   * WRITTEN ONLY BY `day-guard.ts`. `validateStrategyPatch` refuses it, so no
   * HTTP client can forge the mark that decides whether a row is re-armable in
   * the morning — a forged stamp is an operator's deliberate stop being undone
   * at 08:45.
   */
  readonly disabledByGuard?: { readonly paper?: GuardStamp | null; readonly live?: GuardStamp | null }
}

/**
 * Apply an operator's edit. Pure, so the merge rules are testable on their own.
 *
 * `disabledReason` follows two rules, in this order:
 *
 *  1. A reason STATED in the patch always wins. There is one reason field on a
 *     row with two switches, so an operator turning paper off while live keeps
 *     running has nowhere else to write "misfiring on gap days" — and refusing
 *     to record it because another rail is on would lose the only note anyone
 *     will ever see.
 *  2. Otherwise, switching ON in either mode CLEARS it. A strategy that is
 *     trading somewhere while still carrying a stale "disabled for margin" is
 *     a worse lie than no reason at all.
 */
export function applyStrategyPatch(
  row: StrategyRow,
  patch: StrategyPatch,
  nowMs: number,
): StrategyRow {
  let modes = row.modes
  for (const mode of ['paper', 'live'] as const) {
    const next = patch.modes?.[mode]
    // Membership is untouched: a patch for a mode the row was never added to
    // changes nothing, so a toggle can never smuggle in an add.
    if (next === undefined || !isAdded(modes, mode)) continue
    modes = withMode(modes, mode, { enabled: next.enabled })
  }

  /**
   * The guard stamps, by the same two rules as `disabledReason` above.
   *
   *  1. A stamp STATED in the patch wins — that is the day guard writing its
   *     own mark, and `null` is it clearing one on the morning re-arm.
   *  2. Otherwise, switching a rail ON CLEARS that rail's stamp. The stamp
   *     means "the guard stopped this and it may be re-armed"; a row an
   *     operator has just turned back on by hand is neither, and leaving the
   *     mark would show a "stopped for the day" badge over a running strategy.
   */
  let stamps: GuardStamps = row.disabledByGuard ?? {}
  for (const mode of ['paper', 'live'] as const) {
    const stated = patch.disabledByGuard?.[mode]
    if (stated !== undefined) {
      stamps = withStamp(stamps, mode, stated)
      continue
    }
    if (patch.modes?.[mode]?.enabled === true && isAdded(row.modes, mode)) {
      stamps = withStamp(stamps, mode, null)
    }
  }

  const limits = patch.dailyLimits === undefined ? row.dailyLimits : (patch.dailyLimits ?? undefined)
  const armed = limits !== undefined && (limits.target !== undefined || limits.stop !== undefined)
  const on = isOn(modes, 'paper') || isOn(modes, 'live')
  // Destructured OFF rather than overwritten: these two are optional, and
  // `{ ...row, dailyLimits: undefined }` is a PRESENT key holding undefined —
  // which `exactOptionalPropertyTypes` treats as a different value from absent,
  // and which Mongo would store as an explicit null. Clearing has to remove.
  const { dailyLimits: _limits, disabledByGuard: _stamps, ...rest } = row
  return {
    ...rest,
    modes,
    liveLots: patch.liveLots ?? row.liveLots,
    autostartAt: patch.autostartAt ?? row.autostartAt,
    disabledReason: patch.disabledReason ?? (on ? '' : row.disabledReason),
    ...(armed ? { dailyLimits: limits } : {}),
    ...(Object.keys(stamps).length === 0 ? {} : { disabledByGuard: stamps }),
    updatedAt: nowMs,
  }
}

/**
 * The stored `enabled` + `mode` pair, mapped FORWARD onto `modes`.
 *
 * The old pair carried both meanings in a way that separates cleanly: `mode`
 * says which page the row was on (MEMBERSHIP) and `enabled` says whether it
 * traded there (PERMISSION). So an `enabled: true, mode: 'live'` row becomes
 * `live: { enabled: true }` with NO paper key, and a disabled paper row becomes
 * `paper: { enabled: false }` — still listed on the paper page, still off,
 * which is exactly what the operator sees today and what they would expect to
 * still see after a deploy.
 *
 * There is no mapping back, deliberately. Writing both shapes would recreate
 * the two-fields-one-question split the addendum removed, and the first write
 * that updated one and not the other would leave a row whose live permission
 * depended on which field the reader happened to trust.
 *
 * `enabled` falls back to false and an unrecognised `mode` reads as paper, so
 * every unreadable combination lands OFF, and off on the rail that cannot lose
 * money.
 */
function legacyModes(doc: Record<string, unknown>): StrategyModes {
  const mode: DeskMode = doc['mode'] === 'live' ? 'live' : 'paper'
  return withMode({}, mode, { enabled: doc['enabled'] === true })
}

/**
 * Read a stored document defensively, exactly like `loadKillSwitch`.
 *
 * EVERY unreadable field falls back to the SAFE value, and `modes` in
 * particular falls back to `{}` — added to nothing, permitted nothing. A row
 * half-written by a failed migration is not a permission to trade.
 *
 * A document carrying `modes` is a document a new writer produced, so it wins;
 * anything else is read through `legacyModes`. The two cannot be merged — a doc
 * with `modes.live: { enabled: false }` beside a stale `enabled: true,
 * mode: 'live'` has to resolve to OFF, and any merge that ORs them resolves it
 * to live.
 */
export function strategyFromDoc(doc: Record<string, unknown> | null): StrategyRow | null {
  if (doc === null) return null
  const tag = doc['tag']
  // A row without a tag cannot be matched against any decision, so it is not a
  // strategy — treating it as one would be granting an anonymous permission.
  if (typeof tag !== 'string' || tag === '') return null
  const liveLots = doc['liveLots']
  const rawModes = doc['modes']
  let modes: StrategyModes = MODES_NONE
  if (isObject(rawModes)) {
    for (const mode of ['paper', 'live'] as const) {
      const entry = rawModes[mode]
      // A present-but-unreadable value is dropped to NOT ADDED, the least
      // granting of the three states. `=== true`, not truthiness: a string
      // 'false' out of a hand-edited document is truthy and would otherwise
      // read as a live permission.
      if (!isObject(entry)) continue
      modes = withMode(modes, mode, { enabled: entry['enabled'] === true })
    }
  } else {
    modes = legacyModes(doc)
  }
  const limits = dailyLimitsFromDoc(doc['dailyLimits'])
  const stamps = guardStampsFromDoc(doc['disabledByGuard'])
  return {
    tag,
    kind: doc['kind'] === 'hosted' ? 'hosted' : 'external',
    label: typeof doc['label'] === 'string' ? doc['label'] : tag,
    modes,
    liveLots: typeof liveLots === 'number' && Number.isFinite(liveLots) ? liveLots : 0,
    autostartAt: typeof doc['autostartAt'] === 'string' ? doc['autostartAt'] : '',
    lastSeenAt: typeof doc['lastSeenAt'] === 'number' ? doc['lastSeenAt'] : 0,
    disabledReason: typeof doc['disabledReason'] === 'string' ? doc['disabledReason'] : '',
    ...(limits === null ? {} : { dailyLimits: limits }),
    ...(stamps === null ? {} : { disabledByGuard: stamps }),
    updatedAt: typeof doc['updatedAt'] === 'number' ? doc['updatedAt'] : 0,
  }
}

/**
 * A stored `dailyLimits`, read defensively. `null` when nothing in it is usable.
 *
 * AN UNREADABLE LIMIT IS DROPPED, NOT DEFAULTED, and it falls to UNARMED. There
 * is no safe number to invent here: a made-up target would stop a strategy that
 * was doing nothing wrong, and a made-up stop would claim a protection that was
 * never configured. Unarmed is the state the operator can see and fix.
 */
function dailyLimitsFromDoc(raw: unknown): DailyLimits | null {
  if (!isObject(raw)) return null
  const out: { target?: number; stop?: number } = {}
  for (const key of ['target', 'stop'] as const) {
    const v = raw[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > DAILY_LIMIT_MAX) continue
    out[key] = v
  }
  return out.target === undefined && out.stop === undefined ? null : out
}

/** Stored guard stamps. A stamp missing either half is not evidence of anything. */
function guardStampsFromDoc(raw: unknown): GuardStamps | null {
  if (!isObject(raw)) return null
  const out: { paper?: GuardStamp; live?: GuardStamp } = {}
  for (const mode of ['paper', 'live'] as const) {
    const v = raw[mode]
    if (!isObject(v)) continue
    const day = v['day']
    const trigger = v['trigger']
    if (typeof day !== 'string' || day === '') continue
    if (trigger !== 'target' && trigger !== 'stop') continue
    out[mode] = { day, trigger }
  }
  return out.paper === undefined && out.live === undefined ? null : out
}

// --------------------------------------------------------------- validation

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** '' (start with the process) or IST 'HHmm'. '0914' is a time; '9:14' is not. */
function isAutostart(v: string): boolean {
  if (v === '') return true
  if (!/^\d{4}$/.test(v)) return false
  const hh = Number(v.slice(0, 2))
  const mm = Number(v.slice(2))
  return hh < 24 && mm < 60
}

/**
 * Validate a PATCH body. Hand-written, for the reasons in validate.ts.
 *
 * An EMPTY patch is rejected rather than treated as a no-op: an operator who
 * meant to flip a switch and mistyped the field name must not get a 200 back
 * saying the strategy is still running.
 */
export function validateStrategyPatch(raw: unknown): Validated<StrategyPatch> {
  if (!isObject(raw)) return { ok: false, error: 'body must be a JSON object' }
  const patch: {
    modes?: { paper?: ModeMembership; live?: ModeMembership }
    liveLots?: number
    autostartAt?: string
    disabledReason?: string
    dailyLimits?: DailyLimits | null
  } = {}

  /**
   * `enabled` and `mode` are REJECTED, not ignored and not translated.
   *
   * A portal or script still sending the old pair is asking for a state this
   * row can no longer express, and quietly dropping it would return a 200
   * saying the edit landed while the switch it named never moved. Failing with
   * the replacement named is the only answer that cannot be misread.
   */
  for (const dead of ['enabled', 'mode'] as const) {
    if (raw[dead] !== undefined) {
      return {
        ok: false,
        error:
          `'${dead}' was replaced by 'modes' — send { modes: { paper?: boolean, live?: boolean } } ` +
          `(a strategy now runs in paper and live independently)`,
      }
    }
  }

  if (raw['modes'] !== undefined) {
    const modes = raw['modes']
    if (!isObject(modes)) return { ok: false, error: 'modes must be an object' }
    const next: { paper?: ModeMembership; live?: ModeMembership } = {}
    for (const mode of ['paper', 'live'] as const) {
      const v = modes[mode]
      if (v === undefined) continue
      if (v === null) {
        return {
          ok: false,
          error:
            `modes.${mode} cannot be removed by a patch — use ` +
            `DELETE /v1/desk/strategies/:tag/modes/${mode}, which refuses while a position is open`,
        }
      }
      // `{ enabled: boolean }`, not a bare boolean, and a real boolean at that:
      // 'false' out of a form field is truthy, and this is the field that
      // authorises live trading.
      if (!isObject(v) || typeof v['enabled'] !== 'boolean') {
        return { ok: false, error: `modes.${mode} must be { enabled: boolean }` }
      }
      next[mode] = { enabled: v['enabled'] }
    }
    if (Object.keys(next).length === 0) {
      return { ok: false, error: 'modes must state paper and/or live' }
    }
    patch.modes = next
  }
  if (raw['liveLots'] !== undefined) {
    const lots = raw['liveLots']
    if (typeof lots !== 'number' || !Number.isInteger(lots) || lots < 0) {
      return { ok: false, error: 'liveLots must be a non-negative integer number of lots' }
    }
    patch.liveLots = lots
  }
  if (raw['autostartAt'] !== undefined) {
    const at = raw['autostartAt']
    if (typeof at !== 'string' || !isAutostart(at)) {
      return { ok: false, error: "autostartAt must be IST 'HHmm' (e.g. '0914') or '' for none" }
    }
    patch.autostartAt = at
  }
  if (raw['disabledReason'] !== undefined) {
    if (typeof raw['disabledReason'] !== 'string') {
      return { ok: false, error: 'disabledReason must be a string' }
    }
    patch.disabledReason = raw['disabledReason']
  }

  /**
   * `disabledByGuard` is REFUSED, never accepted and never ignored.
   *
   * It is the only thing that distinguishes "the day guard stopped this and it
   * may be re-armed at 08:45" from "the operator stopped this deliberately". A
   * client able to write it could have tomorrow morning's re-arm switch a rail
   * back on that a human took down — and ignoring the field would return a 200
   * to a caller who believes they set it.
   */
  if (raw['disabledByGuard'] !== undefined) {
    return {
      ok: false,
      error:
        'disabledByGuard is written by the day guard alone — it is what says the guard, ' +
        'rather than you, switched a rail off, and the morning re-arm reads it',
    }
  }

  if (raw['dailyLimits'] !== undefined) {
    const limits = validateDailyLimits(raw['dailyLimits'])
    if (!limits.ok) return limits
    patch.dailyLimits = limits.value
  }

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error:
        'patch is empty — expected one of modes, liveLots, autostartAt, disabledReason, dailyLimits',
    }
  }
  return { ok: true, value: patch }
}

/**
 * The day guard's two lines, off the wire. `null` in, `null` out: that is the
 * operator disarming the guard, and it has to be expressible.
 *
 * BOTH LINES ARE POSITIVE RUPEES. `stop: -3000` is refused with the rule
 * stated, rather than silently negated: an operator who typed the sign they
 * expect to see in the P&L is reasonable, and a control that quietly reversed
 * their meaning is how a stop-loss ends up armed to fire on a profit.
 */
export function validateDailyLimits(
  raw: unknown,
  venue: VenueSpec = API_VENUE,
): Validated<DailyLimits | null> {
  if (raw === null) return { ok: true, value: null }
  if (!isObject(raw)) {
    return { ok: false, error: 'dailyLimits must be an object, or null to disarm the day guard' }
  }
  const out: { target?: number; stop?: number } = {}
  // The numbers are bare; the venue says what they are. DX: USD. NSE: rupees.
  const unit = venue.currency === 'INR' ? 'rupees' : 'USD'
  const stopExample = venue.currency === 'INR' ? '3000' : '300'
  for (const key of ['target', 'stop'] as const) {
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return {
        ok: false,
        error:
          `dailyLimits.${key} must be a positive number of ${unit} ` +
          `(a stop is stated as ${key === 'stop' ? `${stopExample}, not -${stopExample}` : 'a positive gain'}); ` +
          'send null to clear it',
      }
    }
    if (v > DAILY_LIMIT_MAX) {
      return {
        ok: false,
        error:
          `dailyLimits.${key} may not exceed ${formatMoney(DAILY_LIMIT_MAX, venue)} — ` +
          'a limit past anything this desk can lose or make is an unarmed guard that looks armed',
      }
    }
    out[key] = v
  }
  // `{}` and `{ target: null }` both mean "no lines left", which is the same
  // state as `null`: unarmed. Two spellings of it on the row would be one more
  // thing every reader has to normalise.
  return { ok: true, value: out.target === undefined && out.stop === undefined ? null : out }
}

// ----------------------------------------------------------------- creation

/**
 * What `POST /v1/desk/strategies` accepts: ADD THIS STRATEGY TO ONE MODE.
 *
 * `mode` is required and there is no default, for the same reason `/submit`
 * has none: guessing paper silently fails to add the live row the operator
 * asked for, guessing live is catastrophic.
 *
 * An `enabled`/`modes` field is NOT accepted, and its absence is the design.
 * Adding a strategy to a page and granting it permission to trade there are
 * separate acts: a form that did both would make a typo in a tag a live order,
 * with no moment at which a human confirmed the switch. The row arrives added
 * and OFF, and the operator flips it afterwards — which for live also costs
 * them a password.
 */
export interface StrategyCreate {
  readonly tag: string
  readonly kind: StrategyKind
  readonly mode: DeskMode
  readonly label: string
  readonly autostartAt: string
  readonly liveLots: number
}

export function validateStrategyCreate(raw: unknown): Validated<StrategyCreate> {
  if (!isObject(raw)) return { ok: false, error: 'body must be a JSON object' }
  if (raw['mode'] !== 'paper' && raw['mode'] !== 'live') {
    return {
      ok: false,
      error: "mode must be stated explicitly as 'paper' or 'live' — it is the page being added to",
    }
  }
  const tag = raw['tag']
  if (typeof tag !== 'string' || tag.trim() === '') {
    return { ok: false, error: 'tag is required — it is the name every order is gated on' }
  }
  // The tag is a primary key that appears in order ids, journal rows and the
  // live allowlist. Whitespace or a stray comma in it would silently fail to
  // match `DESK_LIVE_TAGS` (comma-separated) while looking correct in the UI.
  if (!/^[A-Za-z0-9_-]+$/.test(tag)) {
    return {
      ok: false,
      error: 'tag may contain only letters, digits, underscore and hyphen (it is a key, not a label)',
    }
  }
  if (raw['kind'] !== 'external' && raw['kind'] !== 'hosted') {
    return { ok: false, error: "kind must be 'external' or 'hosted'" }
  }
  const label = raw['label']
  if (label !== undefined && typeof label !== 'string') {
    return { ok: false, error: 'label must be a string when present' }
  }
  const autostartAt = raw['autostartAt']
  if (autostartAt !== undefined && (typeof autostartAt !== 'string' || !isAutostart(autostartAt))) {
    return { ok: false, error: "autostartAt must be IST 'HHmm' (e.g. '0914') or '' for none" }
  }
  const liveLots = raw['liveLots']
  if (
    liveLots !== undefined &&
    (typeof liveLots !== 'number' || !Number.isInteger(liveLots) || liveLots < 0)
  ) {
    return { ok: false, error: 'liveLots must be a non-negative integer number of lots' }
  }
  if (raw['modes'] !== undefined || raw['enabled'] !== undefined) {
    return {
      ok: false,
      error:
        'a strategy is always added switched OFF — turn it on with PATCH once it is added ' +
        '(adding a strategy and granting it permission to trade are separate acts)',
    }
  }
  return {
    ok: true,
    value: {
      tag,
      kind: raw['kind'],
      mode: raw['mode'],
      label: label === undefined || label.trim() === '' ? tag : label,
      autostartAt: autostartAt ?? '',
      liveLots: liveLots ?? 0,
    },
  }
}

// -------------------------------------------------------------- bulk switch

/** What `POST /v1/desk/strategies/bulk` accepts. */
export interface BulkSwitch {
  readonly mode: DeskMode
  readonly on: boolean
}

/**
 * ONE MODE PER CALL, always stated.
 *
 * There is deliberately no "everything, everywhere" form. A single click that
 * armed fifteen strategies on both rails is the one action where the mode — the
 * whole thing the operator is trying to keep straight — would be the easiest
 * thing to lose track of. And there is no default: guessing paper silently
 * fails to stop a live book, guessing live is catastrophic.
 */
export function validateBulkSwitch(raw: unknown): Validated<BulkSwitch> {
  if (!isObject(raw)) return { ok: false, error: 'body must be a JSON object' }
  if (raw['mode'] !== 'paper' && raw['mode'] !== 'live') {
    return { ok: false, error: "mode must be stated explicitly as 'paper' or 'live'" }
  }
  if (typeof raw['on'] !== 'boolean') {
    return { ok: false, error: 'on must be a boolean — true switches every row on, false off' }
  }
  return { ok: true, value: { mode: raw['mode'], on: raw['on'] } }
}
