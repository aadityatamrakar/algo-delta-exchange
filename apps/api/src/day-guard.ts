/**
 * THE DAY GUARD: a per-strategy daily target and stop-loss, enforced by the
 * bridge rather than by the strategy.
 *
 * A strategy's own stops are inside its logic, where they belong. This is the
 * one outside them: "whatever you think you are doing, you have made ₹10,000
 * today / lost ₹3,000 today, and you are done until tomorrow." It exists
 * because every in-strategy stop shares a fate with the strategy — a book
 * mispricing its own legs computes its own stop from the same wrong numbers,
 * and the operator watching the P&L card is the only one who can see it.
 *
 * FOUR PROPERTIES, each of which cost something to get right elsewhere in this
 * tree and none of which is negotiable:
 *
 *  1. IT FIRES ONCE PER TAG, RAIL AND IST DAY. The idempotency is a create-only
 *     insert into `desk-daily-guard` keyed `<tag>|<mode>|<day>` — the same
 *     unique-index-as-a-lock the decision path uses, for the same reason: this
 *     loop runs every ten seconds, and a read-then-write would let two ticks
 *     both decide to flatten and send two sets of exits.
 *
 *  2. IT DOES NOT DOUBLE-FLATTEN. Switching a HOSTED tag off is already an
 *     order to square off — `runner.ts:#stopOne` flattens as it stops, and that
 *     is the tested path. A MIRROR is the opposite: `mirrors.ts` deliberately
 *     never squares off (the upstream account owns the exit), so switching one
 *     off strands whatever it holds and NOTHING else will close it. So the
 *     guard reads `desk-strategy-runtime.host` and flattens only the mirrors —
 *     plus anything it cannot identify, because a stopped runner cannot flatten
 *     either and "we could not tell, so we left the position" has no upside.
 *
 *  3. LIVE IS NEVER AUTO-RE-ARMED. Paper comes back the next morning by itself;
 *     live does not, and the comment at `rearm` says why.
 *
 *  4. AN INCOMPLETE P&L ROW STILL COUNTS. When a leg is unpriced the row's
 *     `total` is null by design (`pnl-jobs.ts`) — and a stop-loss that stops
 *     working exactly when the feed does is not a stop-loss. It falls back to
 *     REALISED, which understates the loss, and says so once a day in the log
 *     and permanently in the guard record.
 *
 * Everything that decides anything is behind `DayGuardPorts`, so all of it is
 * testable without Mongo. `dayGuardPorts` is the one adapter that reaches the
 * real collections.
 */

import type { DeskMode } from './contract.ts'
import { auditLog, type AuditLog } from './audit.ts'
import type { PnlRow, PnlSummary } from './pnl-jobs.ts'
import { pnlFor } from './pnl-jobs.ts'
import { PnlStore } from './pnlstore.ts'
import { istDate, type ApiDeps } from './routes/kit.ts'
import { istMinutesOfDay } from './rollup.ts'
import { RUNTIME_COLLECTION } from '../../runner/src/runtime.ts'
import {
  isOn,
  type DailyLimits,
  type GuardTrigger,
  type StrategyPatch,
  type StrategyRow,
} from './strategies.ts'

/** One document per tag, rail and IST day. `_id` IS the idempotency. */
export const DAY_GUARD_COLLECTION = 'desk-daily-guard'

/**
 * The IST minute after which the morning re-arm may run.
 *
 * 08:45 rather than midnight: it is after the instrument sync and well before
 * the 09:15 open, so a rail that comes back is back in time for its autostart,
 * and an operator arriving at 09:00 sees the state the session will run with
 * rather than one that changes under them.
 */
export const REARM_AFTER_IST_MINUTES = 8 * 60 + 45

/** One step the guard took, in the order it took them. */
export interface GuardAction {
  readonly step: 'switch-off' | 'flatten'
  readonly at: number
  /** What actually happened. Never elided — a step that did nothing says so. */
  readonly note: string
}

export interface GuardRecord {
  /** `<tag>|<mode>|<istDate>`. */
  readonly _id: string
  readonly tag: string
  readonly mode: DeskMode
  /** IST 'YYYY-MM-DD'. */
  readonly day: string
  readonly firedAt: number
  readonly trigger: GuardTrigger
  readonly pnlAtTrigger: number
  /** The number above came from REALISED alone — see property 4 in the header. */
  readonly incomplete: boolean
  readonly actions: readonly GuardAction[]
}

/** What the guard needs of `desk-daily-guard`. */
export interface GuardStore {
  /**
   * CREATE-ONLY. `false` means the id already exists, which means today has
   * already fired — that is the whole idempotency, and it must not be a
   * read-then-write.
   */
  claim(record: GuardRecord): Promise<boolean>
  appendAction(id: string, action: GuardAction): Promise<void>
  /** Every record for one IST day, for the Strategies page's badge. */
  today(day: string): Promise<readonly GuardRecord[]>
}

/** The flatten's outcome, narrowed to what the guard records. */
export interface GuardFlatten {
  readonly decisionId: string
  readonly replayed: boolean
  readonly flat: boolean
  readonly legs: readonly unknown[]
}

export interface DayGuardPorts {
  now(): number
  log(msg: string, ctx?: Record<string, unknown>): void
  listStrategies(): Promise<readonly StrategyRow[]>
  loadStrategy(tag: string): Promise<StrategyRow | null>
  /** THE SAME SEAM `/v1/desk/pnl` READS — see `pnlFor`. One call per rail. */
  pnl(mode: DeskMode, nowMs: number): Promise<PnlSummary>
  patchStrategy(
    tag: string,
    patch: StrategyPatch,
    expectedUpdatedAt: number,
  ): Promise<StrategyRow | null | 'conflict'>
  readonly guards: GuardStore
  /**
   * The ORDER JOURNAL — `DeskStore.journalBlocked`, the same seam a switched-off
   * strategy's refusals go through. Never throws.
   */
  journal(events: readonly Record<string, unknown>[]): Promise<void>
  /**
   * Which host publishes this instance's runtime document: `'runner'`,
   * `'mirror'`, or `null` when there is no document at all.
   */
  runtimeHost(tag: string, mode: DeskMode): Promise<'runner' | 'mirror' | null>
  flattenTag(params: {
    tag: string
    mode: DeskMode
    decisionId: string
    style: 'limit'
    /**
     * Start of the fill window. The guard ALWAYS passes 0 — see `#exit`. It is
     * on the port rather than left to `flattenTag`'s default so that the window
     * this loop exits over is visible here, next to the number it acts on.
     */
    sinceMs: number
  }): Promise<GuardFlatten>
  /**
   * THE OPERATOR AUDIT LOG (roadmap 17), which this loop writes to under the
   * principal `'day-guard'`.
   *
   * A rail that is off tomorrow morning was switched off by SOMEBODY, and "the
   * desk did it, at 11:04, because the stop was hit" is exactly the sentence
   * the audit log exists to be able to produce — otherwise the guard's stop is
   * indistinguishable from an operator's in the one record that is supposed to
   * tell them apart.
   *
   * OPTIONAL, and absent means no sink is attached: every test builds these
   * ports without one, and a guard with no audit collection must behave
   * identically to one with it. Like every other write here it is fail-soft.
   */
  readonly audit?: AuditLog
}

const MODES: readonly DeskMode[] = ['paper', 'live']

export function guardRecordId(tag: string, mode: DeskMode, day: string): string {
  return `${tag}|${mode}|${day}`
}

/**
 * The decision id the flatten runs under.
 *
 * DETERMINISTIC, so a retry — this process crashing between the claim and the
 * route, or two of them racing — replays through `flattenTag`'s own
 * `decisionId` unique index rather than sending a second set of exits. It
 * carries the day for the same reason the record does: tomorrow's trip on the
 * same tag is a different exit, and a timeless id would silently replay it.
 */
export function guardDecisionId(tag: string, mode: DeskMode, day: string): string {
  return `daily-guard-${tag}-${mode}-${day}`
}

/**
 * The number the lines are compared against, and whether it is degraded.
 *
 * `total` when the row is complete, REALISED when it is not — never null and
 * never zero. See property 4 in the header for why the fallback exists and why
 * it is announced rather than absorbed.
 */
export function guardNumber(row: PnlRow): { value: number; incomplete: boolean } {
  if (row.complete && row.total !== null) return { value: row.total, incomplete: false }
  return { value: row.realised, incomplete: true }
}

/**
 * Which line, if either, this number has crossed.
 *
 * `>=` and `<=`, so the line itself trips. An operator who typed 10,000 means
 * "stop at ten thousand", and a guard that waits for 10,000.01 is one that can
 * sit on the number all afternoon without firing.
 *
 * THE STOP IS CHECKED FIRST. Both can never be true at once (one needs a
 * positive number and the other a negative), but if a hand-edited row ever made
 * them so, stopping is the answer that cannot cost money.
 */
export function guardTrigger(
  limits: DailyLimits | undefined,
  value: number,
): GuardTrigger | null {
  if (limits === undefined) return null
  if (limits.stop !== undefined && value <= -limits.stop) return 'stop'
  if (limits.target !== undefined && value >= limits.target) return 'target'
  return null
}

/**
 * The trip, as a row of the ORDER FEED.
 *
 * THE LOG IS NOT ENOUGH. "Why did nothing trade this afternoon?" is a question
 * the portal has to answer on its own — that is the whole reason `blockedSkips`
 * journals a switched-off strategy's refusals rather than only logging them —
 * and a strategy that stopped at 11:04 for a reason nobody can see from the
 * dashboard is exactly the same failure. Shaped like `blockedEvents`' output so
 * the existing order feed renders it with no changes, `detail.mode` included:
 * an unstamped event is read as LIVE, and a paper stop appearing under the live
 * log is the 2026-07-28 defect all over again.
 */
export function guardJournalEvent(record: GuardRecord, limits: DailyLimits | undefined): Record<string, unknown> {
  const line = record.trigger === 'stop' ? 'daily stop-loss' : 'daily target'
  const limit = record.trigger === 'stop' ? limits?.stop : limits?.target
  return {
    // The flatten's id, so a mirror's exit orders and the reason for them line
    // up in the journal under one identifier.
    clientOrderId: guardDecisionId(record.tag, record.mode, record.day),
    phase: 'INVALID',
    ok: false,
    tag: record.tag,
    // There is no contract here — this is the strategy being stopped, not an
    // order being refused — so the tag is the only honest identifier.
    tradingsymbol: record.tag,
    ts: record.firedAt,
    error:
      `day guard: ${record.tag} hit its ${line}` +
      `${limit === undefined ? '' : ` of ₹${limit.toLocaleString('en-IN')}`} at ` +
      `${record.pnlAtTrigger.toLocaleString('en-IN')} — switched off for ${record.mode} ` +
      `for the rest of ${record.day}` +
      `${record.incomplete ? ' (judged on REALISED only; a leg was unpriced)' : ''}`,
    detail: {
      mode: record.mode,
      op: 'day-guard',
      trigger: record.trigger,
      day: record.day,
      pnlAtTrigger: record.pnlAtTrigger,
      incomplete: record.incomplete,
    },
  }
}

/** Is the guard armed on this row at all? */
export function isArmed(row: StrategyRow): boolean {
  const l = row.dailyLimits
  return l !== undefined && (l.target !== undefined || l.stop !== undefined)
}

/**
 * The guard itself. A CLASS because two things must survive between ticks: the
 * once-a-day log budget and the day the re-arm last ran. Free functions holding
 * that state in module scope would make two bridges in one test process share
 * it.
 */
export class DayGuard {
  readonly #d: DayGuardPorts
  /** `<tag>|<mode>|<day>` already named as degraded in the log. */
  readonly #degraded = new Set<string>()
  /** `<tag>|<mode>|<day>` already reported as fired-but-still-on. */
  readonly #stuck = new Set<string>()
  /** IST day the re-arm last completed, so it runs once. */
  #rearmedFor = ''
  #running = false

  constructor(ports: DayGuardPorts) {
    this.#d = ports
  }

  /**
   * One pass: guard, then re-arm. SINGLE-FLIGHT — a pass that overruns its
   * interval must not have a second one land on top of it, because the two
   * would both read a row as still-enabled and both try to stop it. Dropping
   * the overlapping pass rather than queueing it is safe for the same reason it
   * is in the runner: this is an idempotent reconciliation, and the pass ten
   * seconds later does everything the dropped one would have.
   */
  async tick(nowMs: number): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      await this.runGuards(nowMs)
      await this.rearm(nowMs)
    } finally {
      this.#running = false
    }
  }

  /** Every armed, enabled rail, judged against today's P&L. */
  async runGuards(nowMs: number): Promise<GuardRecord[]> {
    const day = istDate(nowMs)
    const rows = (await this.#d.listStrategies()).filter(isArmed)
    if (rows.length === 0) return []

    /**
     * ONE P&L READ PER RAIL, for every armed tag on it.
     *
     * `pnlFor` answers from the in-memory book when there is one and rescans
     * `desk-decisions` when there is not — per TAG that would be one 30-day
     * scan per armed strategy every ten seconds. The summary already carries a
     * row per tag, which is the cheapest read that exists here, and it is the
     * SAME one `/v1/desk/pnl` and the 15s snapshot serve, so the number that
     * stops a strategy is the number the operator was looking at.
     */
    const wanted = MODES.filter((mode) => rows.some((r) => isOn(r.modes, mode)))
    const byMode = new Map<DeskMode, Map<string, PnlRow>>()
    for (const mode of wanted) {
      const summary = await this.#d.pnl(mode, nowMs)
      byMode.set(mode, new Map(summary.strategies.map((s) => [s.tag, s])))
    }

    const fired: GuardRecord[] = []
    for (const row of rows) {
      for (const mode of MODES) {
        // A rail that is off has nothing left to stop, and a rail that was
        // never added has no switch to flip.
        if (!isOn(row.modes, mode)) continue
        const pnl = byMode.get(mode)?.get(row.tag)
        // No row means the tag has not traded on this rail today. There is no
        // number, and a missing number is not zero.
        if (pnl === undefined) continue
        const { value, incomplete } = guardNumber(pnl)
        if (incomplete) this.#noteDegraded(row.tag, mode, day, pnl)
        const trigger = guardTrigger(row.dailyLimits, value)
        if (trigger === null) continue
        const record = await this.#trip({ row, mode, day, trigger, value, incomplete, nowMs })
        if (record !== null) fired.push(record)
      }
    }
    return fired
  }

  /**
   * Fire, once. Returns null when today's record already existed.
   *
   * THE RECORD IS WRITTEN FIRST, before anything is switched or routed. It is
   * the lock, not the report: a crash after it lands leaves a row still enabled
   * and a record that says what was owed, which is recoverable and visible. A
   * crash after a flatten with no record would re-flatten on the next tick.
   */
  async #trip(input: {
    row: StrategyRow
    mode: DeskMode
    day: string
    trigger: GuardTrigger
    value: number
    incomplete: boolean
    nowMs: number
  }): Promise<GuardRecord | null> {
    const { row, mode, day, trigger, nowMs } = input
    const id = guardRecordId(row.tag, mode, day)
    const record: GuardRecord = {
      _id: id,
      tag: row.tag,
      mode,
      day,
      firedAt: nowMs,
      trigger,
      pnlAtTrigger: input.value,
      incomplete: input.incomplete,
      actions: [],
    }
    if (!(await this.#d.guards.claim(record))) {
      /**
       * Today already fired. Normally that means the last tick did it and the
       * rail is already off, in which case this line is unreachable — the
       * `isOn` check above skipped it.
       *
       * Reaching it means the record exists AND the rail is enabled AND it is
       * back past its line: either the switch-off failed after the claim
       * landed, or an operator turned the rail back on afterwards. Both leave
       * the rail running UNGUARDED for the rest of the day, because the record
       * is the idempotency and it will not fire twice. Said once a day —
       * silence here is the one way this state stays invisible, since the
       * idempotency working correctly looks exactly the same from outside.
       */
      if (!this.#stuck.has(id)) {
        this.#stuck.add(id)
        this.#d.log(
          'day guard already fired for this rail today and it is ON and past its line again — ' +
            'it will NOT fire a second time today, so this rail is unguarded until tomorrow',
          { tag: row.tag, mode, day, trigger, pnl: input.value },
        )
      }
      return null
    }

    this.#d.log(
      `day guard: ${row.tag} hit its ${trigger} on ${mode} — stopping it for the day`,
      {
        tag: row.tag,
        mode,
        trigger,
        pnl: input.value,
        limits: row.dailyLimits,
        incomplete: input.incomplete,
      },
    )
    // Into the ORDER FEED as well as the log — see `guardJournalEvent`. Before
    // the switch, so the journal carries the reason even if the write below
    // fails; `journalBlocked` never throws, so this cannot cost the stop.
    await this.#d.journal([guardJournalEvent(record, row.dailyLimits)])

    const off = await this.#switchOff(row, mode, day, trigger)
    await this.#d.guards.appendAction(id, { step: 'switch-off', at: this.#d.now(), note: off })
    const exit = await this.#exit(row.tag, mode, day)
    await this.#d.guards.appendAction(id, { step: 'flatten', at: this.#d.now(), note: exit })
    /**
     * ONE LINE PER TRIP, written LAST — after both steps, so it carries what
     * actually happened rather than what was about to be attempted. The guard
     * record in `desk-daily-guard` is the authoritative account; this is the
     * entry that puts the automatic stop in the same list, in the same order,
     * as the human ones an operator is scanning it beside.
     */
    await this.#d.audit?.record({
      principal: { kind: 'system', name: 'day-guard' },
      source: 'day-guard',
      action: trigger === 'stop' ? 'STOPPED a rail on its daily stop-loss' : 'stopped a rail on its daily target',
      tag: row.tag,
      mode,
      detail: {
        trigger,
        pnlAtTrigger: input.value,
        limits: row.dailyLimits ?? null,
        incomplete: input.incomplete,
        switchOff: off,
        flatten: exit,
      },
    })
    return { ...record, actions: [
      { step: 'switch-off', at: nowMs, note: off },
      { step: 'flatten', at: nowMs, note: exit },
    ] }
  }

  /**
   * Turn the rail off and stamp WHY, through the registry's own compare-and-set.
   *
   * Version-pinned like every other writer of this row: the runner heartbeats a
   * sibling collection but the operator's own PATCH writes this one, and a
   * guard that read a row, then wrote a whole row back, would undo a lot-size
   * edit made in between. On a conflict it re-reads and re-decides, up to three
   * times — the row moved, so the answer is recomputed rather than re-applied.
   *
   * The patch names ONLY the switch and the stamp. `disabledReason` is
   * deliberately not written: it is where a HUMAN records why they stopped
   * something, and filling it from a machine is how that field stopped meaning
   * anything the last time (`clearSeededDisabledReason`). The badge on the
   * Strategies page is what says the guard did this.
   */
  async #switchOff(
    row: StrategyRow,
    mode: DeskMode,
    day: string,
    trigger: GuardTrigger,
  ): Promise<string> {
    let current: StrategyRow | null = row
    for (let attempt = 0; attempt < 3; attempt++) {
      if (current === null) return 'the row vanished before it could be switched off'
      if (!isOn(current.modes, mode)) return 'already off'
      const patch: StrategyPatch = {
        modes: mode === 'live' ? { live: { enabled: false } } : { paper: { enabled: false } },
        disabledByGuard: mode === 'live' ? { live: { day, trigger } } : { paper: { day, trigger } },
      }
      const result = await this.#d.patchStrategy(current.tag, patch, current.updatedAt)
      if (result === 'conflict') {
        current = await this.#d.loadStrategy(row.tag)
        continue
      }
      if (result === null) return 'the row vanished before it could be switched off'
      return 'off'
    }
    // Three losers in a row is not a race any more. Said, not swallowed: the
    // record is the only place anyone will find out the switch did not move.
    this.#d.log('day guard could NOT switch a rail off — it is still trading', {
      tag: row.tag,
      mode,
      day,
    })
    return 'FAILED — the row kept changing under the write; it is still on'
  }

  /**
   * Close what the rail holds, but only where nothing else will.
   *
   * See property 2 in the header. The asymmetry is the whole of this method.
   */
  async #exit(tag: string, mode: DeskMode, day: string): Promise<string> {
    let host: 'runner' | 'mirror' | null = null
    try {
      host = await this.#d.runtimeHost(tag, mode)
    } catch (err) {
      // Unreadable is treated exactly like absent: we flatten. See below.
      this.#d.log('day guard could not read the runtime host — treating it as unknown', {
        tag,
        mode,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (host === 'runner') {
      return 'not flattened here — the runner squares off as it stops a switched-off tag'
    }
    const why =
      host === 'mirror'
        ? 'mirror: nothing else squares it off'
        : 'host unknown (no runtime row) — a stopped runner cannot flatten either'
    const decisionId = guardDecisionId(tag, mode, day)
    try {
      /**
       * EVERY FILL THAT EXISTS (`sinceMs: 0`), not `flattenTag`'s one-IST-day
       * default — the same window `routes/books.ts` gives the delete guard's
       * flatten, for the same reason.
       *
       * The default is right for the caller it was written for: a hosted
       * strategy is intraday by contract, so a day is its whole life. It is
       * WRONG here, because the two halves of this loop disagreed about time.
       * The number that fires the guard comes from `pnlFor`, which answers from
       * `LiveBook` and carries a position across sessions; the exit read one
       * day. A leg opened on an earlier session therefore counts toward a limit
       * that the exit cannot then close, and — worse — `flattenTag` rebuilds
       * "the position" from an incomplete window and reports `flat: true` over
       * legs it never read.
       *
       * MIRROR_A010, paper, 2026-09-07: fired on its ₹10,000 target, recorded
       * `2 leg(s), flat`, and left NIFTY 24050 CE and 24050 PE open. On
       * 2026-09-04 the same tag recorded `0 leg(s), NOT flat` — every rupee
       * that tripped the stop belonged to legs outside the window.
       *
       * Widening is safe in the direction that matters (`FlattenParams.sinceMs`
       * spells this out): a round trip that already closed nets to zero and is
       * dropped by `planFlatten`, whereas a window that starts after the opens
       * and before the closes nets to a long that was never held and would send
       * a SELL. Reading everything cannot produce that shape.
       */
      const result = await this.#d.flattenTag({ tag, mode, decisionId, style: 'limit', sinceMs: 0 })
      return (
        `flattened (${why}) — ${result.legs.length} leg(s), ` +
        `${result.flat ? 'flat' : 'NOT flat'}${result.replayed ? ', replayed' : ''}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#d.log('day guard flatten FAILED — the position is still open', { tag, mode, error: message })
      return `flatten FAILED (${why}): ${message}`
    }
  }

  /** Once a day, per instance, naming what the number is missing. */
  #noteDegraded(tag: string, mode: DeskMode, day: string, pnl: PnlRow): void {
    const key = `${tag}|${mode}|${day}`
    if (this.#degraded.has(key)) return
    this.#degraded.add(key)
    this.#d.log(
      `day guard is judging ${tag} on REALISED only — its P&L row is incomplete, ` +
        'so the loss it can see UNDERSTATES the real one',
      { tag, mode, day, unpriced: pnl.unpriced, openLegs: pnl.openLegs },
    )
  }

  /**
   * The morning re-arm. PAPER ONLY, once a day, after 08:45 IST.
   *
   * AUTO-ARMING LIVE WOULD BYPASS THE PASSWORD GATE. Turning `modes.live` on is
   * the one action on the Strategies page that costs an operator their password
   * (`routes/desk.ts:handleStrategyPatch`), and a background job that did it at
   * 08:45 would put real money back on the wire with nobody's confirmation
   * behind it — for a strategy whose last recorded act was losing its daily
   * stop. Live comes back when the operator re-enables it with the badge in
   * view; the stamp is cleared by that patch, not by this loop.
   *
   * THE STAMP IS THE DISCRIMINATOR, and it is why a row an operator switched
   * off is never touched here: it carries no stamp, so it is invisible to this
   * pass. A row stamped TODAY is equally untouched — the day it was stopped for
   * is not over.
   */
  async rearm(nowMs: number): Promise<string[]> {
    const day = istDate(nowMs)
    if (this.#rearmedFor === day) return []
    if (istMinutesOfDay(nowMs) < REARM_AFTER_IST_MINUTES) return []

    const rearmed: string[] = []
    for (const row of await this.#d.listStrategies()) {
      const stamp = row.disabledByGuard?.paper
      if (stamp === undefined || stamp.day >= day) continue
      // Already back on — an operator got there first. The stamp is cleared
      // anyway, so the page stops showing a "stopped for the day" badge over a
      // strategy that is trading.
      const back = !isOn(row.modes, 'paper')
      const patch: StrategyPatch = {
        ...(back ? { modes: { paper: { enabled: true } } } : {}),
        disabledByGuard: { paper: null },
      }
      const result = await this.#d.patchStrategy(row.tag, patch, row.updatedAt)
      if (result === 'conflict' || result === null) {
        // Not retried: the next pass is tomorrow, but a conflict means someone
        // is editing the row right now, and their edit is the more current
        // intention. Said so it is not silent.
        this.#d.log('day guard could not re-arm a paper rail — the row changed under the write', {
          tag: row.tag,
          day,
        })
        continue
      }
      if (back) rearmed.push(row.tag)
    }
    this.#rearmedFor = day
    if (rearmed.length > 0) {
      this.#d.log('day guard re-armed paper strategies stopped on an earlier day', {
        tags: rearmed,
        day,
      })
    }
    return rearmed
  }
}

// ------------------------------------------------------------------ the wiring

/**
 * `desk-daily-guard`, behind the `GuardStore` port.
 *
 * Exported on its own because the Strategies route reads the same collection to
 * render today's badge, and a second copy of "what a guard document is" would
 * be a second thing to keep in step with the writer.
 */
export function guardStore(db: ApiDeps['db']): GuardStore {
  const guards = db.collection(DAY_GUARD_COLLECTION)
  return {
    claim: async (record) => {
      try {
        await guards.insertOne({ ...record })
        return true
      } catch (err) {
        // A duplicate `_id` IS the answer, not an error: today already fired.
        // Anything else is a real failure and must not read as "already
        // handled", which would skip the switch-off silently.
        if (isDuplicateId(err)) return false
        throw err
      }
    },
    appendAction: async (id, action) => {
      await guards.updateOne({ _id: id }, { $push: { actions: { ...action } } })
    },
    today: async (day) => {
      const docs = await guards.find({ day }).toArray()
      return docs.map(guardRecordFromDoc).filter((r): r is GuardRecord => r !== null)
    },
  }
}

/** The real collections behind `DayGuardPorts`. */
export function dayGuardPorts(deps: ApiDeps): DayGuardPorts {
  const store = new PnlStore(deps.db)
  return {
    now: () => deps.now(),
    log: deps.log,
    listStrategies: async () => await deps.store.listStrategies(),
    loadStrategy: async (tag) => await deps.store.loadStrategy(tag),
    pnl: async (mode, nowMs) => await pnlFor(deps, store, {}, mode, nowMs),
    patchStrategy: async (tag, patch, expectedUpdatedAt) =>
      await deps.service.patchStrategy(tag, patch, expectedUpdatedAt),
    guards: guardStore(deps.db),
    journal: async (events) => {
      await deps.store.journalBlocked(events)
    },
    runtimeHost: async (tag, mode) => {
      const doc = (await deps.db
        .collection(RUNTIME_COLLECTION)
        .findOne({ tag, mode })) as Record<string, unknown> | null
      const host = doc?.['host']
      return host === 'mirror' || host === 'runner' ? host : null
    },
    flattenTag: async (params) => await deps.service.flattenTag(params),
    audit: auditLog(deps),
  }
}

/**
 * A stored guard record, read defensively — the Strategies page renders it.
 *
 * A document missing its trigger or its number is dropped rather than rendered
 * with a guess: "guard: stop hit +₹0" over a strategy that made money is worse
 * than no badge at all.
 */
export function guardRecordFromDoc(doc: Record<string, unknown> | null): GuardRecord | null {
  if (doc === null) return null
  const id = doc['_id']
  const tag = doc['tag']
  const mode = doc['mode']
  const day = doc['day']
  const trigger = doc['trigger']
  const pnl = doc['pnlAtTrigger']
  if (typeof id !== 'string' || typeof tag !== 'string' || typeof day !== 'string') return null
  if (mode !== 'paper' && mode !== 'live') return null
  if (trigger !== 'target' && trigger !== 'stop') return null
  if (typeof pnl !== 'number' || !Number.isFinite(pnl)) return null
  const actions = Array.isArray(doc['actions']) ? doc['actions'] : []
  return {
    _id: id,
    tag,
    mode,
    day,
    firedAt: typeof doc['firedAt'] === 'number' ? doc['firedAt'] : 0,
    trigger,
    pnlAtTrigger: pnl,
    incomplete: doc['incomplete'] === true,
    actions: actions.filter(isGuardAction),
  }
}

function isGuardAction(v: unknown): v is GuardAction {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  return (a['step'] === 'switch-off' || a['step'] === 'flatten') && typeof a['note'] === 'string'
}

function isDuplicateId(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 11000 || code === 11001
}

export interface DayGuardOptions {
  readonly intervalMs?: number
}

/**
 * Start the guard loop. Returns a stop function.
 *
 * Nothing is awaited at call time, and the timer is `unref`ed, for the two
 * reasons `pnl-jobs.ts` states at length: boot must not depend on a Mongo round
 * trip, and a referenced interval turns every `pm2 restart` into a ten-second
 * stall. The `.catch` is not optional either — an unhandled rejection inside a
 * timer is fatal on Node >= 15, and losing the whole bridge because one P&L
 * read failed would take the order path down to protect it.
 */
export function startDayGuard(deps: ApiDeps, opts: DayGuardOptions = {}): () => void {
  const guard = new DayGuard(dayGuardPorts(deps))
  const intervalMs = opts.intervalMs ?? 10_000
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) return
    void guard.tick(deps.now()).catch((err: unknown) => {
      deps.log('day guard pass failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, intervalMs)
  timer.unref()

  return (): void => {
    stopped = true
    clearInterval(timer)
  }
}
