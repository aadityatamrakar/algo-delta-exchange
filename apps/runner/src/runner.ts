/**
 * The hosted-strategy runner. ONE process, N strategies, no strategy-specific
 * code anywhere in this file.
 *
 * It loads the switched-on `hosted` rows from `desk-strategies`, asks an
 * injected factory to build each one with its ports already attached, and then
 * does exactly four time-driven things: start at the row's own time, fire cron
 * jobs, square off and stop at day end, and start a fresh session the next day.
 * If adding a strategy ever requires editing this file, the design has failed
 * (Phase C §3).
 *
 * A ROW IS NOT AN INSTANCE. The registry switch is per mode, so a row switched
 * on for paper AND live is supervised twice — two `StrategyBase` objects, two
 * ledgers, two state-store scopes, two order gateways, keyed `tag:mode`
 * throughout (`HostedInstance`). Nothing below shares mutable state between
 * them, because a paper fill that is indistinguishable from a live one makes
 * every square-off decision after it wrong.
 *
 * WHAT THIS REPLACES, and why each difference is deliberate:
 *
 *  - **`process.exit()` at 15:30.** The legacy engines ended the day by killing
 *    themselves and relying on pm2 to bring them back in the morning. Day end
 *    here is a STATE TRANSITION (`running` -> `squared-off`), which is simpler,
 *    observable from the portal, and does not make "is the strategy healthy?"
 *    indistinguishable from "the strategy exited on purpose six hours ago".
 *  - **Positions in process memory.** A 12:30 restart lost them, and the legacy
 *    conventions admit an open position cannot be restored. State persists
 *    through the `StateStore` port and `StrategyBase.start()` calls
 *    `onRecover()` BEFORE job catch-up — so an entry job that is already past
 *    is suppressed (it is `replayable: false`) and the position comes back from
 *    storage instead of being opened a second time.
 *  - **One strategy taking down its neighbours.** Every call into a strategy is
 *    guarded here as well as inside `StrategyBase`, and a strategy that throws
 *    is parked in `failed` with the message on its runtime row rather than
 *    propagating.
 *
 * THE CLOCK IS INJECTED AND `tick()` IS THE ONLY MOVING PART. `main.ts` calls
 * `tick()` from a `setInterval`; a test calls it with a synthetic clock. That is
 * what makes autostart, delay-start, catch-up and day-end assertable without
 * waiting six and a half hours.
 */

import { MARKET_CLOSE_MIN, MARKET_OPEN_MIN, isWeekday, type Clock } from '@algomaker/core'
import { occurrencesBetween, type Logger, type Quote, type StrategyBase } from '@algomaker/strategy-kit'

/** Contract §6's vocabulary, verbatim. Rendered on the strategies page. */
export type RuntimeState = 'stopped' | 'waiting' | 'running' | 'squared-off' | 'failed'

export interface RuntimeSnapshot {
  readonly tag: string
  /** Which rail this instance runs on. Half the identity — see `RunMode`. */
  readonly mode: RunMode
  readonly state: RuntimeState
  readonly startedAt: number | null
  readonly lastError: string | null
  readonly openPositions: number
  readonly updatedAt: number
}

export type RunMode = 'paper' | 'live'

/**
 * The registry fields the runner actually reads.
 *
 * A narrow structural subset of `StrategyRow` rather than an import from
 * `apps/api`: the runner is a separate process that happens to read the same
 * collection, and coupling it to the bridge's internal types would mean a
 * change to an unrelated API field forces a runner release.
 */
export interface HostedRow {
  readonly tag: string
  readonly kind: 'external' | 'hosted'
  /**
   * The per-mode switch, THREE-STATE: an absent key means the strategy was
   * never added to that page, a present one carries whether it trades. Both may
   * be on at once; that is the whole feature.
   *
   * The runner cares about only one of the three distinctions — it supervises
   * `enabled === true` and nothing else — but it must read the shape correctly,
   * because "added but switched off" and "not added" are both NOT-trading and
   * an optional-chained read is the only thing keeping them from being truthy.
   */
  readonly modes: {
    readonly paper?: { readonly enabled: boolean }
    readonly live?: { readonly enabled: boolean }
  }
  readonly liveLots: number
  /** IST 'HHmm', or '' for "start with the process". */
  readonly autostartAt: string
}

/**
 * ONE SUPERVISED INSTANCE: a registry row projected onto ONE rail.
 *
 * A row switched on for both modes becomes TWO of these, and they are as
 * separate as two different strategies. They must not share a `StateStore` key
 * or a position ledger: the state store is where `onRecover()` rebuilds an open
 * position from, and the ledger is the only durable record of what a hosted
 * strategy holds — so a shared one would make a paper fill indistinguishable
 * from a live one. The day-end backstop would then flatten the paper leg
 * through the live rail (a real order nobody placed) or read the live leg as
 * already closed and leave it open at the broker overnight. Everything
 * per-instance is therefore keyed `tag:mode`, the same way the order gateway
 * already was.
 */
export interface HostedInstance {
  readonly tag: string
  readonly mode: RunMode
  readonly liveLots: number
  /** IST 'HHmm', or '' for "start with the process". */
  readonly autostartAt: string
}

/** The key every per-instance map uses. `tag` alone is no longer an identity. */
export function instanceKey(tag: string, mode: RunMode): string {
  return `${tag}:${mode}`
}

/**
 * Builds a strategy for one instance, ports already injected.
 *
 * Returns null when no hosted implementation is registered for the tag. That is
 * a real case rather than an error — a row seeded ahead of the class that runs
 * it — and it is reported as `stopped` with a reason, never rendered as if the
 * runner were supervising it.
 *
 * The three `MIRROR_*` rows used to be the standing example and no longer are:
 * they are hosted by `mirrors.ts` (they are `SignalSource` adapters, not
 * `StrategyBase` objects) and `main.ts` withholds them from `loadRows`, so the
 * runner never sees them at all.
 */
export interface StrategyFactory {
  create(instance: HostedInstance): StrategyBase | null
}

/**
 * The runner's own record of what it has put on the books, and the means to
 * take it off again.
 *
 * `openCount` is the runtime column on the strategies page. `flattenAll` is the
 * SQUARE-OFF BACKSTOP: `endDay()` returning is not evidence that anything was
 * placed (`onDayEnd()` is an optional hook and no catalogue strategy overrode
 * it, so the runner used to report `squared-off` over a silent no-op), and this
 * is what makes the report true.
 *
 * `mode` is passed per call rather than captured once because it decides WHICH
 * RAIL the reversing orders go to. Flattening a live position through the paper
 * rail books a fictional exit and leaves the real one open at the broker, which
 * is the worst possible version of the defect this port exists to fix — so the
 * caller states the rail the position was opened on and the implementation
 * honours it instead of reading a registry row that may already have changed.
 */
export interface PositionBackstop {
  /**
   * Open legs for ONE INSTANCE. Keyed by mode as well as tag, because a tag
   * running in both rails has two ledgers: a count that summed them would make
   * a live instance that is genuinely flat report the paper instance's open
   * position and refuse to say `squared-off` forever, and a paper instance
   * holding nothing report the live one's and be "flattened" against a book it
   * does not own.
   */
  openCount(tag: string, mode: RunMode): number
  /**
   * Reverse every leg the ledger still shows open for this instance. Resolves
   * once every leg has been ATTEMPTED; a refused leg stays in the ledger, which
   * is how the caller tells a completed exit from a claimed one.
   */
  flattenAll(tag: string, mode: RunMode, reason: string): Promise<void>
}

/**
 * How long to wait before re-attempting an exit that did not complete.
 *
 * A flatten refused because the bridge is down is worth retrying — a position
 * is open and nothing else is going to close it — but not once a second. One
 * minute is the same order as the legacy `setTimeout(fn, 30000)` re-arm, and
 * the error log line each attempt emits is the alert.
 *
 * The interval DOUBLES per consecutive failure up to `EXIT_RETRY_MAX_MS`, and
 * resets the moment an exit completes. Attempts are deliberately UNBOUNDED —
 * giving up is a position nobody is trying to close — but the CADENCE is not:
 * on 2026-08-04 a flatten the bridge refused on every attempt was re-tried at
 * a fixed beat for hours, and the megabytes of identical refusals were the
 * incident's noise floor. A cause that clears (the feed returns, a gate fix
 * deploys) is picked up at worst `EXIT_RETRY_MAX_MS` late, which an exit that
 * has already failed for ten minutes can afford.
 */
const EXIT_RETRY_MS = 60_000
/** Ceiling for the doubling above: one attempt every ten minutes, forever. */
const EXIT_RETRY_MAX_MS = 10 * 60_000

export interface RunnerDeps {
  readonly clock: Clock
  readonly log: Logger
  /** Reads `desk-strategies`. Called on every `sync()`. */
  loadRows(): Promise<readonly HostedRow[]>
  readonly factory: StrategyFactory
  /** The position ledger, for the runtime snapshot AND the square-off backstop. */
  positions?: PositionBackstop
  /** Where runtime snapshots go. Absent in tests. */
  publish?(snapshots: readonly RuntimeSnapshot[]): Promise<void>
  /**
   * IST minute at which the session ends: square off, then stop.
   *
   * Defaults to 15:30, the market close. Individual strategies square off
   * EARLIER through their own `squareOff` job (15:15, 15:20, 15:24 — it is
   * config, and the runner has no business knowing it). This is the backstop
   * that guarantees nothing is left running into the evening.
   */
  readonly dayEndIstMinute?: number
}

interface Supervised {
  readonly tag: string
  readonly mode: RunMode
  inst: HostedInstance
  strategy: StrategyBase | null
  state: RuntimeState
  startedAt: number | null
  lastError: string | null
  /** Upper bound of the last cron window evaluated, so no occurrence is missed. */
  lastCronMs: number
  /**
   * An exit is OWED and must not be re-attempted before this instant; null when
   * nothing is owed.
   *
   * Non-null means the last square-off did not complete — the strategy threw,
   * or the ledger still shows a position the bridge refused to flatten. It is
   * retried on every tick from then on (subject to `EXIT_RETRY_MS`) rather than
   * only at the next day end, because otherwise a Friday 15:30 flatten failure
   * would sit open across the whole weekend.
   */
  retryExitAtMs: number | null
  /**
   * Consecutive failed exit attempts, driving the backoff doubling. Reset to 0
   * the moment an exit completes, so the next failure starts the ladder over.
   */
  exitAttempts: number
  /** Set once a null factory result has been logged, so it is not logged per tick. */
  unimplementedLogged: boolean
  /**
   * The `#stopOne` IN FLIGHT for this instance, or null.
   *
   * `#stopOne` writes `state` and `retryExitAtMs` only on return, so for the
   * whole duration of a flatten — several HTTP round trips — a second pass
   * still reads `running` and still reads a ledger holding the legs the first
   * pass is closing, and would reverse them again under fresh
   * `clientOrderId`s. This is the only thing that says "this is already being
   * handled", and it has to be per instance because the overlapping passes
   * arrive from different entry points (`tick` and `sync` run on different
   * intervals, and a signal can land on top of either).
   *
   * IT IS THE PROMISE, NOT A BOOLEAN, and that distinction is the whole point:
   * a second caller must not place a second set of orders AND must not be told
   * the exit is done. `stopAll` is the SIGTERM path — `main.ts` closes mongo
   * and exits the moment it resolves — so a guard that resolved early would
   * truncate the very flatten it deferred to, under a log line saying the book
   * was closed. Handing back this promise makes every caller wait for the one
   * exit that is actually happening.
   */
  stopPromise: Promise<void> | null
}

/** `'0918'` -> 558. `''` -> 0, i.e. "start with the process". */
export function autostartMinute(hhmm: string): number {
  if (hhmm === '') return 0
  if (!/^\d{4}$/.test(hhmm)) return 0
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2))
}

/**
 * The minute a supervised strategy may first start today.
 *
 * IDENTICAL to `autostartMinute` for an EXPLICIT time — an operator who typed
 * `0914` gets 09:14, because a strategy that wants to be ready before the bell
 * has a reason and this is not the place to overrule it.
 *
 * The floor exists for `''` alone, which means "as soon as possible" and
 * returns minute 0. Minute 0 is MIDNIGHT, and `tick()` resets every strategy to
 * `waiting` at the IST day roll — so `nowMin >= 0` was true the instant the day
 * turned and every `''` strategy started at 00:00, nine hours before the open.
 * Measured on prod: on 2026-07-30 and again on 2026-07-31,
 *
 *   18:30:00.620Z runner: new trading day {"day":"2026-07-31"}
 *   18:30:00.624Z runner: LION_S25_2 started {"istMinute":0,"autostartAt":"at boot"}
 *
 * and BULL_S_1, BULL_SNX_1, EAGLE_S_1 and LION_S25_2 then sold BANKNIFTY and
 * SENSEX straddles at 01:00 IST against the previous session's marks — each
 * one carrying a cost basis that never traded into the real session. Their own
 * configs say `session.startAt: "09:15:00"`; nothing consulted it.
 *
 * WHY NOT GATE THE BOOT INSTEAD: because that is the 2026-07-06 bug. A pm2
 * restart at 11:00 must start a `''` strategy immediately, and `main.ts` and
 * `StrategyBase.start()` are both deliberately unconditional about it. A FLOOR
 * keeps that — at 11:00, `660 >= 555` still starts at once — while making the
 * one case that was never a boot at all, the midnight day-roll, wait for the
 * session it belongs to.
 */
export function sessionStartMinute(autostartAt: string): number {
  // Keyed on the RESULT being 0, not on the input being empty, so the garbage
  // fallback — which `autostartMinute` also maps to "as soon as possible" —
  // gets the same floor rather than quietly keeping midnight.
  const min = autostartMinute(autostartAt)
  return min === 0 ? MARKET_OPEN_MIN : min
}

/** IST calendar day, `YYYY-MM-DD`. The unit a trading session is keyed by. */
function istDay(nowMs: number): string {
  return new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10)
}

/** Epoch ms of IST minute-of-day `min` on the IST day containing `nowMs`. */
function istMinuteMs(nowMs: number, min: number): number {
  const shifted = nowMs + 330 * 60_000
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000
  return dayStart + min * 60_000 - 330 * 60_000
}

export class Runner {
  readonly #d: RunnerDeps
  readonly #supervised = new Map<string, Supervised>()
  readonly #dayEnd: number
  /** The IST day the current session belongs to; a change starts a new one. */
  #sessionDay: string
  /**
   * A pass is already running. `main.ts` drives `tick()` from a 1-second
   * interval and `sync()` from a 15-second one, and neither waits for the
   * previous pass — so a flatten that takes 1.5 seconds is enough for two
   * passes to be inside the day-end exit at once, each reversing the same
   * legs. `MirrorHost.sync` guards the identical hazard for the same reason.
   *
   * Dropping the overlapping pass rather than queueing it is deliberate: both
   * of these are IDEMPOTENT reconciliations against the clock and the registry,
   * so the pass a second later does everything the dropped one would have.
   */
  #ticking = false
  #syncing = false

  constructor(deps: RunnerDeps) {
    this.#d = deps
    this.#dayEnd = deps.dayEndIstMinute ?? MARKET_CLOSE_MIN
    this.#sessionDay = istDay(deps.clock.now())
  }

  /**
   * Reconcile the supervised set with the registry.
   *
   * ONE ROW CAN BECOME TWO INSTANCES. A row switched on for paper and live is
   * expanded into a paper instance and a live instance, each supervised
   * independently and each with its own ledger, state store and order gateway.
   * That is the whole per-mode feature: proving a change out on paper no longer
   * requires taking the live book off the air.
   *
   * Safe to call repeatedly (main.ts polls it), because everything it does is
   * a set difference: an instance that appeared is added as `waiting`, one
   * whose mode was switched off or whose row was deleted is squared off and
   * stopped. An instance already running is left strictly alone — re-creating a
   * live strategy would discard its in-memory position and re-run its entry
   * logic from scratch.
   */
  async sync(): Promise<void> {
    if (this.#syncing) return
    this.#syncing = true
    try {
      await this.#sync()
    } finally {
      this.#syncing = false
    }
  }

  async #sync(): Promise<void> {
    let rows: readonly HostedRow[]
    try {
      rows = await this.#d.loadRows()
    } catch (err) {
      // A registry read failure must not stop the strategies already running:
      // they are mid-session and hold positions. Keep the current set.
      this.#d.log.error('runner: could not read the strategy registry, keeping the current set', {
        error: message(err),
      })
      return
    }

    const wanted = new Map<string, HostedInstance>()
    for (const row of rows) {
      // `external` rows are Python processes we do not supervise (spec §11).
      if (row.kind !== 'hosted') continue
      for (const mode of ['paper', 'live'] as const) {
        // Not added, or added and switched off — both are "do not run it", and
        // both must be answered by the same `=== true` so a truthy stored value
        // can never start a strategy nobody armed.
        if (row.modes[mode]?.enabled !== true) continue
        wanted.set(instanceKey(row.tag, mode), {
          tag: row.tag,
          mode,
          liveLots: row.liveLots,
          autostartAt: row.autostartAt,
        })
      }
    }

    for (const [key, s] of [...this.#supervised]) {
      if (wanted.has(key)) continue
      // An exit is already in flight (the tick path started it). Leaving it
      // alone is not just about the duplicate flatten `#stopOne` now refuses:
      // the collection below reads `state` to decide whether the instance may
      // be forgotten, and while a flatten is running that state is still the
      // PRE-exit one — so a sync landing mid-flatten would drop the last thing
      // that knows the position exists. The next sync collects it.
      //
      // SKIPPED, NOT AWAITED — deliberately, and unlike the shutdown path.
      // This is a collection pass over a registry snapshot; blocking it on a
      // flatten would hold the whole reconciliation (every other row's changes
      // included) behind one slow bridge round trip, and the pass 15 seconds
      // later does everything this one would have.
      if (s.stopPromise !== null) continue
      /**
       * An instance already parked in `failed` owes an exit that the TICK path
       * retries under the exit backoff. Honour that backoff here too: sync runs
       * every 15 seconds, and re-attempting the stop on each pass regardless is
       * what turned one refused flatten into four log lines per leg per 15s on
       * 2026-08-04 — megabytes of the same refusal while nothing changed. One
       * attempt per backoff window, whichever path fires it, is the alert; the
       * repetition was only noise.
       */
      if (s.state === 'failed' && !this.#exitDue(s, this.#d.clock.now())) continue
      await this.#stopOne(s, 'switched off in the registry')
      // Forget it only once the exit ACTUALLY happened. Deleting an instance
      // whose flatten was refused would drop the last thing that knows the
      // position exists — the runtime row disappears from the portal and
      // nothing ever retries. It stays supervised, `failed`, and the tick path
      // keeps trying; a later sync collects it once it is genuinely flat.
      if (s.state === 'failed') continue
      this.#supervised.delete(key)
    }

    for (const [key, inst] of wanted) {
      const existing = this.#supervised.get(key)
      if (existing !== undefined) {
        /**
         * A row change that does not change the MODE, because the mode is now
         * part of this instance's identity: switching paper off and live on is
         * one instance disappearing from `wanted` and another appearing, and
         * the disappearing one is squared off on its own rail above.
         *
         * That is strictly safer than the rebuild this used to do. The old code
         * squared off and re-created a single instance in place, and if the
         * exit failed it had to abandon the swap and keep the OLD row so the
         * retry still aimed at the rail the position was on. Now the failed
         * instance simply stays supervised and `failed` on its own rail, and
         * the new one starts flat beside it.
         *
         * `liveLots` genuinely is nothing to restart for — sizing is applied by
         * `/v1/desk/submit` off the row it reads itself, not from this copy.
         */
        existing.inst = inst
        continue
      }
      this.#supervised.set(key, {
        tag: inst.tag,
        mode: inst.mode,
        inst,
        strategy: null,
        state: 'waiting',
        startedAt: null,
        lastError: null,
        lastCronMs: this.#d.clock.now(),
        retryExitAtMs: null,
        exitAttempts: 0,
        unimplementedLogged: false,
        stopPromise: null,
      })
      this.#d.log.info(`runner: supervising ${inst.tag}`, {
        mode: inst.mode,
        autostartAt: inst.autostartAt === '' ? 'at boot' : inst.autostartAt,
      })
    }

    await this.#publish()
  }

  /**
   * One pass of time-driven work. The whole clock surface of the runner.
   *
   * Ordering inside a tick is deliberate: a day rollover is handled first (so a
   * strategy is not started into yesterday's session), then starts, then cron
   * jobs, and the day-end exit LAST.
   *
   * THE DUE CRON WINDOW IS DRAINED BEFORE THE EXIT, not instead of it. This
   * used to be an `if (past day end) stop() else fireDueJobs()`, and since
   * `lastCronMs` advances to `now` either way, the skipped window was closed
   * forever: a tick that slept from 15:23 to 15:31 dropped a 15:24 `squareOff`
   * — a strategy's own, price-aware exit — and replaced it with a blind
   * flatten. The window is clamped at day end (`#cronWindowEnd`) so draining it
   * still cannot place an order into a session that has already closed.
   *
   * The two halves are guarded SEPARATELY. A job that throws must not cost the
   * strategy its square-off in the same tick; one strategy's failure must never
   * affect its neighbours, and one phase's failure must not swallow that
   * strategy's exit.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      await this.#tick()
    } finally {
      this.#ticking = false
    }
  }

  async #tick(): Promise<void> {
    const now = this.#d.clock.now()
    const day = istDay(now)
    if (day !== this.#sessionDay) {
      this.#sessionDay = day
      await this.#rollSession(day)
    }

    const nowMin = this.#d.clock.istMinutes()
    for (const s of this.#supervised.values()) {
      await this.#guarded(s, async () => {
        if (s.state === 'waiting') await this.#maybeStart(s, nowMin, now)
        if (s.state === 'running') await this.#fireDueJobs(s, this.#cronWindowEnd(now))
      })
      await this.#guarded(s, async () => {
        // An exit that did not complete is retried on EVERY tick, not only at
        // the next day end: the position is open, nothing else is going to
        // close it, and a Friday 15:30 failure would otherwise sit there until
        // Monday. Note this half is deliberately NOT weekday-gated — the guard
        // in `#maybeStart` is about opening a session, and a position that is
        // still on the books over a weekend is precisely the one that must keep
        // being retried.
        const owed = s.retryExitAtMs !== null
        if (!owed && nowMin < this.#dayEnd) return
        if (!this.#exitDue(s, now)) return
        await this.#stopOne(s, owed ? 'retrying an exit that did not complete' : 'day end')
      })
      s.lastCronMs = now
    }
    await this.#publish()
  }

  /**
   * Run one phase of a tick with its error contained on the strategy it belongs
   * to.
   *
   * `StrategyBase` already contains its own errors, so reaching the catch means
   * the failure was in the runner's own bookkeeping. It is still parked per
   * strategy — one throwing must never affect its neighbours.
   */
  async #guarded(s: Supervised, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      s.state = 'failed'
      s.lastError = message(err)
      this.#d.log.error(`runner: ${s.tag} failed`, { mode: s.mode, error: s.lastError })
    }
  }

  /**
   * Upper bound of the cron window for this tick.
   *
   * Normally `now`. On the tick that CROSSES day end it is clamped to the
   * day-end instant: everything the runner slept through still fires, but an
   * occurrence scheduled after 15:30 belongs to a session that is over, and
   * firing it would place an order into a closed market.
   */
  #cronWindowEnd(now: number): number {
    const dayEndMs = istMinuteMs(now, this.#dayEnd)
    return now > dayEndMs ? dayEndMs : now
  }

  /**
   * Whether an exit is owed for this strategy right now.
   *
   * `failed` is in the set, and that is half the fix: `#maybeStart` runs only
   * from `waiting`, the day-end stop used to run only from `running`, and
   * `#rollSession` stopped only `running` strategies before resetting
   * everything to `waiting` — so a strategy parked in `failed` was never
   * squared off, never retried, and its open position was carried silently into
   * the next session. A failed strategy stops TRADING (it gets no ticks and
   * fires no jobs); it does not stop OWING an exit.
   */
  #exitDue(s: Supervised, now: number): boolean {
    if (s.state !== 'running' && s.state !== 'failed') return false
    // A construction failure has no strategy and (normally) nothing on the
    // books. Retrying it would be a crash loop with nothing to gain — but if
    // the ledger DOES show a position for it, that position still has to go.
    if (s.strategy === null && (this.#d.positions?.openCount(s.tag, s.mode) ?? 0) === 0) return false
    return s.retryExitAtMs === null || now >= s.retryExitAtMs
  }

  /**
   * Deliver a tick. The strategy decides what to do with it; the caller decides
   * which strategies subscribe to which token.
   *
   * `handleTick` is queued on `StrategyBase`'s concurrency-1 chain and never
   * throws, so this stays synchronous and cheap — exit checks run off ticks and
   * latency is the whole reason ticks are pushed rather than pulled.
   */
  /**
   * EVERY instance of the tag gets the tick, not just one of them.
   *
   * A row running in paper and live is two independent strategies watching the
   * same instrument, and a tick is how each of them checks its own stop. The
   * feed routes by TAG (`md.routesFor`), because the two instances declared the
   * same tokens, so the fan-out happens here. Delivering to only the first would
   * leave the other blind to price for the whole session — its entries would
   * never trigger and, far worse, its exits would never fire.
   */
  handleTick(tag: string, quote: Quote): void {
    for (const s of this.#supervised.values()) {
      if (s.tag !== tag || s.state !== 'running' || s.strategy === null) continue
      s.strategy.handleTick(quote)
    }
  }

  /** Every supervised instance, for the runtime column on the strategies page. */
  snapshots(): readonly RuntimeSnapshot[] {
    const now = this.#d.clock.now()
    return [...this.#supervised.values()].map((s) => ({
      tag: s.tag,
      mode: s.mode,
      state: s.state,
      startedAt: s.startedAt,
      lastError: s.lastError,
      openPositions: this.#d.positions?.openCount(s.tag, s.mode) ?? 0,
      updatedAt: now,
    }))
  }

  /**
   * Shutdown. Squares off through each strategy's own `onDayEnd`, then flattens
   * whatever that left behind, then stops.
   *
   * Every strategy is attempted regardless of state and regardless of the retry
   * backoff — a SIGTERM is the last chance this process gets. A tag that comes
   * back `failed` here is still holding a position; `main.ts` logs that
   * explicitly before it exits rather than letting the process die quietly.
   */
  async stopAll(reason: string): Promise<void> {
    // ALL AT ONCE, not a serial for-await: instances share no mutable state
    // (this file's own invariant), and `main.ts` hard-exits 15 seconds after
    // the signal — so serially, one slow bridge round trip means the tags at
    // the back of the map are never even ATTEMPTED, and the process dies with
    // no record that they were skipped. `allSettled` because `#stopOne`
    // already contains its own errors and one rejection must not abandon the
    // rest either.
    await Promise.allSettled(
      [...this.#supervised.values()].map((s) => this.#stopOne(s, reason)),
    )
    await this.#publish()
  }

  /**
   * Wait for every exit ALREADY IN FLIGHT. Starts nothing.
   *
   * A shutdown must not truncate a flatten the tick path began. The 15:30
   * backstop takes several HTTP round trips, and a SIGTERM landing inside one
   * of them — a `make restart`, a reboot, pm2's `max_memory_restart` — used to
   * find `#stopOne`'s guard, be told "already handled", and then close mongo
   * and `process.exit(0)` on top of orders that had not been accepted yet. The
   * position survived the night; the log said it had been squared off.
   *
   * `#stopOne` now shares its promise, so `stopAll` already waits. This exists
   * for the path that does NOT square off: the default stop deliberately
   * leaves the book open, but an exit the runner itself started at 15:30 is
   * not something it may abandon halfway, and its last log line has to describe
   * the book as it will actually be left.
   *
   * ONE PASS, snapshotted: the callers clear the intervals first, so nothing
   * can start a new exit behind this one. `allSettled` because a failed exit is
   * still a finished exit — it has parked its instance in `failed` and the
   * caller's own report is what names it.
   */
  async quiesce(): Promise<void> {
    const inFlight = [...this.#supervised.values()]
      .map((s) => s.stopPromise)
      .filter((p): p is Promise<void> => p !== null)
    if (inFlight.length === 0) return
    this.#d.log.warn(`runner: waiting for ${inFlight.length} exit(s) already in flight`)
    await Promise.allSettled(inFlight)
  }

  // ------------------------------------------------------------- internals

  async #maybeStart(s: Supervised, nowMin: number, now: number): Promise<void> {
    /**
     * NOT A TRADING DAY: do not start at all.
     *
     * Every other gate here is a MINUTE OF DAY, and a minute of day cannot tell
     * a Saturday from a Tuesday — so at 09:15 on a Saturday every switched-on
     * strategy started, fired its cron jobs against a feed with no ticks in it,
     * and sat `running` until the 15:30 backstop stopped it. The portal showed a
     * green badge for the whole weekend, which is the single most misleading
     * thing that column can say.
     *
     * `isWeekday` from `@algomaker/core` is the one weekday definition in this
     * repo (`isMarketOpen` and the web's `inSession` both go through it or state
     * the same rule); a second one here is how the two drift apart. It is
     * deliberately NOT `isMarketOpen`, which also demands 09:15–15:30: an
     * operator who typed `0914` wants to be ready before the bell and
     * `sessionStartMinute` honours that exactly. Nor does it know about trading
     * HOLIDAYS — there is no holiday calendar in this process, and the strategies
     * simply find no ticks — but a weekend is two days in seven and needs no
     * calendar to recognise.
     */
    if (!isWeekday(this.#d.clock.istDay())) return

    // `sessionStartMinute`, NOT `autostartMinute`: the raw mapping sends "as
    // soon as possible" to minute 0, which the day roll reads as midnight.
    const from = sessionStartMinute(s.inst.autostartAt)
    if (nowMin < from) return
    /**
     * Past day end: do NOT start. Not a guard on startup in general — gating
     * boot behind a time window is the 2026-07-06 bug and `StrategyBase.start()`
     * is deliberately unconditional — but starting a session that is already
     * over would run every catch-up job and then immediately square off.
     */
    if (nowMin >= this.#dayEnd) return

    const strategy = s.strategy ?? this.#build(s)
    if (strategy === null) return
    s.strategy = strategy

    /**
     * `start()` runs `onDayStart()`, then `onRecover()`, then job catch-up.
     * That order is what makes a mid-session restart correct: state is back
     * before any job decides whether it is already due, and the jobs that place
     * orders are `replayable: false` so catch-up SUPPRESSES them and relies on
     * the recovered position instead. Replaying an entry would duplicate it.
     *
     * The suppression cuts both ways: a start at 15:25 with a 15:20 `squareOff`
     * job suppresses the EXIT too, and `#markFired` records the occurrence so
     * it can never fire again today. Nothing here can fix that — re-firing it
     * would be replaying an order-placing job — so the day-end backstop in
     * `#stopOne` is what closes that position.
     */
    await strategy.start()
    s.state = 'running'
    s.startedAt = now
    s.lastError = null
    // The cron window opens at the start instant. Anything earlier today was
    // handled by catch-up, and re-firing it here would double-run it.
    s.lastCronMs = now
    this.#d.log.info(`runner: ${s.tag} started`, {
      mode: s.mode,
      istMinute: nowMin,
      autostartAt: s.inst.autostartAt === '' ? 'at boot' : s.inst.autostartAt,
    })
  }

  #build(s: Supervised): StrategyBase | null {
    let strategy: StrategyBase | null = null
    try {
      strategy = this.#d.factory.create(s.inst)
    } catch (err) {
      s.state = 'failed'
      s.lastError = message(err)
      this.#d.log.error(`runner: could not construct ${s.tag}`, { mode: s.mode, error: s.lastError })
      return null
    }
    if (strategy === null) {
      s.state = 'stopped'
      s.lastError = 'no hosted implementation is registered for this tag'
      if (!s.unimplementedLogged) {
        s.unimplementedLogged = true
        this.#d.log.warn(
          `runner: ${s.tag} (${s.mode}) is switched on but has no hosted implementation — not supervising it`,
        )
      }
      return null
    }
    return strategy
  }

  /**
   * Fire every cron occurrence in `(lastCronMs, now]`, oldest first.
   *
   * A WINDOW rather than "does the expression match right now": the interval
   * that drives `tick()` can be late (event-loop pressure, a slow Mongo read),
   * and a missed 13:31:00 entry deadline is a day's trading. Occurrences are
   * sorted across jobs so the deliberate deadline-after-poller ordering all four
   * legacy engines depend on (13:30:10 poller, then 13:31:00 deadline, so the
   * last scheduled check can still trade) survives a late tick.
   *
   * `StrategyBase` dedups by occurrence, so a job cannot double-fire even if
   * this window overlaps a catch-up.
   *
   * `windowEnd` is `now` except on the tick that crosses day end, where it is
   * clamped — see `#cronWindowEnd`.
   *
   * NO WEEKDAY GUARD HERE, and that is a decision rather than an omission. Jobs
   * fire only from `running`, and `running` is reachable only through
   * `#maybeStart` — which refuses a non-weekday — so nothing can be running on a
   * Saturday for this to drive. A second gate would also be actively harmful:
   * `lastCronMs` advances to `now` at the end of every tick whether or not this
   * ran, so a window this method declines to evaluate is closed forever, which
   * is the exact defect the "drain before the exit" ordering in `tick()` exists
   * to prevent.
   */
  async #fireDueJobs(s: Supervised, windowEnd: number): Promise<void> {
    const strategy = s.strategy
    if (strategy === null || windowEnd <= s.lastCronMs) return

    const due: { ts: number; name: string }[] = []
    for (const job of strategy.jobs()) {
      for (const ts of occurrencesBetween(job.cron, s.lastCronMs, windowEnd)) {
        due.push({ ts, name: job.name })
      }
    }
    if (due.length === 0) return
    due.sort((a, b) => a.ts - b.ts)
    for (const d of due) await strategy.fireJob(d.name)
  }

  /**
   * SQUARE OFF, THEN STOP, THEN VERIFY — in that order.
   *
   * This looks redundant (`stop()` calls `endDay()` itself) and is not.
   * `StrategyBase.stop()` sets its `#stopped` flag BEFORE calling `endDay()`,
   * and `StrategyBase.submit()` refuses outright once that flag is set:
   *
   *     if (this.#stopped) return { accepted: false, reason: 'strategy stopped' }
   *
   * So any square-off order a strategy tries to place from inside `onDayEnd()`
   * during `stop()` is silently refused — the exact "flatten does nothing"
   * failure a day-end is supposed to prevent. Calling `endDay()` first, while
   * the strategy is still live, is what lets the exit actually reach a rail.
   *
   * `stop()` then re-runs `endDay()`, which is why the base documents it as
   * idempotent; the second pass places nothing because the position is already
   * closed (and would be refused anyway). Logged as a defect in
   * `packages/strategy-kit/src/base.ts` rather than fixed here.
   *
   * THEN THE BACKSTOP, which is the part that used to be missing entirely.
   * `endDay()` returning is not evidence that anything was placed: `onDayEnd()`
   * is an OPTIONAL hook on `StrategyBase` and no catalogue strategy overrides
   * it, so setting `state = 'squared-off'` on the strength of those two calls
   * returning was a success report over a silent no-op — at 15:30, on operator
   * switch-off, on session rollover and on SIGTERM alike, with the ledger
   * write-only and `flattenAll()` never called by anything. So once the
   * strategy has had its chance, the runner asks its OWN ledger what is still
   * open and reverses it through the gateway (which, unlike
   * `StrategyBase.submit()`, is not gated by the `#stopped` flag `stop()` has
   * just set). A strategy that squared off properly leaves nothing to flatten,
   * so this is a no-op in the good case.
   *
   * It is also the only thing that covers a start after a strategy's own
   * square-off time: a runner coming up at 15:25 with a 15:20 `squareOff` job
   * has that job SUPPRESSED by catch-up (it is `replayable: false`) and
   * `#markFired` records the occurrence, so it can never fire for the rest of
   * the day. The position comes back from `onRecover()` and nothing but this
   * closes it.
   *
   * `squared-off` is reported ONLY when the ledger is empty afterwards. A leg
   * the bridge refused stays in the ledger and the state is `failed` with the
   * count in the message, because reporting an exit that did not happen is the
   * entire defect this method exists to remove — reproducing it one layer up
   * would be no better than the no-op it replaced.
   */
  async #stopOne(s: Supervised, reason: string): Promise<void> {
    // ONE EXIT AT A TIME PER INSTANCE — AND EVERY CALLER AWAITS THAT ONE EXIT.
    //
    // Everything below reads the ledger and then acts on it, and nothing it
    // decides is written back until it returns, so a second pass entering here
    // mid-flatten would read the legs the first is already reversing and
    // reverse them a second time, taking the position past flat. Hence one
    // exit at a time.
    //
    // But the second caller is JOINED to that exit, not dropped. Returning
    // early would be indistinguishable, to the caller, from "the exit is
    // finished" — and on the shutdown path that caller is `stopAll`, whose
    // resolution is `main.ts`'s cue to close mongo and `process.exit(0)`. A
    // resolved-immediately guard therefore kills the process mid-flatten and
    // logs that everything is squared off, which is the same lie the backstop
    // exists to remove. Sharing the promise costs nothing and makes the report
    // true: by the time it resolves, `state` and the ledger are settled.
    if (s.stopPromise !== null) return s.stopPromise
    const exiting = this.#stop(s, reason).finally(() => {
      s.stopPromise = null
    })
    s.stopPromise = exiting
    await exiting
  }

  async #stop(s: Supervised, reason: string): Promise<void> {
    let failure: string | null = null
    if (s.strategy !== null) {
      try {
        await s.strategy.endDay(reason)
        await s.strategy.stop(reason)
      } catch (err) {
        failure = message(err)
        this.#d.log.error(`runner: ${s.tag} failed to stop cleanly`, { mode: s.mode, error: failure })
      }
    }

    const positions = this.#d.positions
    const before = positions?.openCount(s.tag, s.mode) ?? 0
    if (positions !== undefined && before > 0) {
      this.#d.log.warn(
        `runner: ${s.tag} still holds ${before} position(s) after its own square-off — flattening`,
        { reason, mode: s.mode },
      )
      try {
        // The mode the position was OPENED on: `#applyRowChange` squares off
        // before it lets a mode change through, so this row still describes the
        // rail the ledger's legs are sitting on.
        await positions.flattenAll(s.tag, s.mode, reason)
      } catch (err) {
        failure = `flatten failed: ${message(err)}`
        this.#d.log.error(`runner: ${s.tag} flatten threw`, { mode: s.mode, error: message(err) })
      }
    }

    // With no ledger injected there is nothing to verify against, and claiming
    // otherwise would be inventing evidence: `left` is 0 and the report is the
    // strategy's own word. Production always injects one (`main.ts`).
    const left = positions?.openCount(s.tag, s.mode) ?? 0
    if (left > 0 || failure !== null) {
      const stillOpen =
        `${left} position(s) still open after '${reason}'` +
        (failure === null ? ' — the bridge refused the flatten' : `: ${failure}`)
      s.state = 'failed'
      s.lastError = left > 0 ? stillOpen : (failure ?? 'stop failed')
      // Doubling, capped — see EXIT_RETRY_MS. `exitAttempts` is the number of
      // failures BEFORE this one, so the first failure re-arms at the base.
      s.retryExitAtMs =
        this.#d.clock.now() + Math.min(EXIT_RETRY_MS * 2 ** s.exitAttempts, EXIT_RETRY_MAX_MS)
      s.exitAttempts += 1
      this.#d.log.error(`runner: ${s.tag} did NOT square off (${reason})`, {
        mode: s.mode,
        error: s.lastError,
        attempt: s.exitAttempts,
        nextRetryInMs: s.retryExitAtMs - this.#d.clock.now(),
      })
      return
    }

    // `stopped` (nothing was ever built and nothing was on the books) is kept
    // distinct from `squared-off` (an exit actually happened) — the strategies
    // page renders the two differently on purpose.
    s.state = s.strategy === null && before === 0 ? 'stopped' : 'squared-off'
    s.lastError = null
    s.retryExitAtMs = null
    s.exitAttempts = 0
    this.#d.log.info(`runner: ${s.tag} squared off and stopped (${reason})`, { mode: s.mode })
  }

  /**
   * A new IST day: every strategy gets a FRESH instance.
   *
   * `StrategyBase` is stopped permanently once `stop()` has run — there is no
   * un-stop, deliberately, so a stopped strategy cannot be resurrected by a
   * stray tick. Rebuilding is therefore how a new session begins, and it also
   * guarantees the day starts from `onDayStart()`'s reset rather than from
   * whatever the previous session left behind.
   *
   * `#exitDue` rather than `state === 'running'`: a strategy parked in `failed`
   * used to be reset straight to `waiting` here, which is how an open position
   * was carried into the next session — the new `onDayStart()` reset then
   * erased the last in-memory trace of it and the ledger was the only thing
   * left that knew.
   */
  async #rollSession(day: string): Promise<void> {
    this.#d.log.info('runner: new trading day', { day })
    const now = this.#d.clock.now()
    for (const s of this.#supervised.values()) {
      if (this.#exitDue(s, now)) await this.#stopOne(s, 'new session')
      if (s.state === 'failed') {
        // The exit did not complete, so something is still on the books. Do NOT
        // open a fresh session on top of it: the retry on the tick path keeps
        // trying, and the runtime row keeps saying why, until it succeeds or an
        // operator switches the row off (which flattens too).
        //
        // Nor is it re-armed when a retry later succeeds mid-session. A
        // strategy whose square-off had to be retried is exactly the one a
        // human should look at before it takes another position; toggling the
        // registry row off and on is the deliberate way back in.
        this.#d.log.error(`runner: ${s.tag} is NOT starting a new session — its exit is unfinished`, {
          mode: s.mode,
          error: s.lastError,
        })
        continue
      }
      s.strategy = null
      s.state = 'waiting'
      s.startedAt = null
      s.lastCronMs = now
    }
  }

  async #publish(): Promise<void> {
    if (this.#d.publish === undefined) return
    try {
      await this.#d.publish(this.snapshots())
    } catch (err) {
      // The portal losing a status update is cosmetic; failing a tick over it
      // would stop the strategies this file exists to run.
      this.#d.log.warn('runner: runtime snapshot publish failed', { error: message(err) })
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
