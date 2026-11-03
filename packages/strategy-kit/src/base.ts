/**
 * StrategyBase — the lifecycle every strategy runs inside.
 *
 * Generalised from the best existing code (`bn-breakout.js`, `orb-fut-core.js`),
 * preserving the hard-won properties those files have and making them structural
 * rather than a convention each new file has to remember:
 *
 *  - **Job catch-up on restart.** `bn-breakout.js:309-320` runs `bootstrap()`
 *    unconditionally on load and replays the setup work that should already have
 *    happened, because `ob_start` restarts the process at ~09:15:30 and a 09:00
 *    init cron would never fire. Getting this wrong cost a real bug on 2026-07-06
 *    (login gated behind a time window, so strategies silently never logged in).
 *    Here it is the base class's job, not the author's.
 *  - **Re-entrancy guard before any await.** `closePosition` sets
 *    `status = 'CLOSING'` synchronously before its first await
 *    (`bn-breakout.js:246`), so a tick arriving mid-close cannot double-exit.
 *  - **Serialised candle polling.** An `async.queue` of concurrency 1 around
 *    `historyData` (`bn-breakout.js:288-290`) so overlapping polls cannot race.
 *    Both of the above are `#queue`: ONE concurrency-1 queue that ticks, candles,
 *    jobs, fills and the day-end all pass through. It defers; it never drops.
 *  - **Flags flip only after a successful order** (`bn-breakout.js:202`), so a
 *    failed submit leaves the opportunity available instead of silently burning it.
 *  - **A failed `start()` resets** (`bn-breakout.js:81-107`'s `started = false` in
 *    its catch), so a retry can happen instead of the strategy being wedged for
 *    the day.
 *  - **Self-retrying setup.** Anatomy row 9: a phase that finds missing data
 *    re-arms itself with `setTimeout(fn, 30000)` — the live log line is "not
 *    enough hourly candles for ATR, retrying in 30s". Without it one slow
 *    instrument feed means the band never forms and the strategy silently does
 *    nothing all day. A job returns `{ retry: true }` and the base reschedules.
 *
 * Scheduling is CRON, not `atIstMinute`. See `schedule.ts` for why: the real
 * schedules carry seconds and repeats (`10 *\/5 9-13 * * 1-5` — the backslash is
 * only there so this block comment does not end at the step operator), and the
 * deadline-after-poller ordering all four engines depend on (13:30:10 poller,
 * then 13:31:00 deadline, so the last scheduled check can still trade) is a
 * sub-minute distinction whole minutes cannot express.
 *
 * Subclasses implement pure-ish hooks and never touch I/O directly — everything
 * goes through the injected ports, which is what lets the same class be driven by
 * a live feed or a historical replay.
 */

import { isMarketOpen, MARKET_CLOSE_MIN } from '@algomaker/core'
import type {
  Candle,
  Fill,
  Interval,
  Quote,
  StrategyContext,
  DataNeed,
  SubmitRequest,
  SubmitResult,
} from './ports.ts'
import { firstIstMinuteOfDay, nextAfter, parseCron } from './schedule.ts'

/** What a job returns when its data is not there yet and it wants another go. */
export interface JobRetry {
  readonly retry: true
}

export type JobOutcome = void | JobRetry

/** The legacy `setTimeout(fn, 30000)` re-arm, as a default. */
export const DEFAULT_JOB_RETRY_MS = 30_000

export interface JobSpec {
  /** Stable name. Used for restart catch-up bookkeeping and for `fireJob`. */
  readonly name: string
  /** 6-field IST cron, `s m h dom mon dow`. See `schedule.ts`. */
  readonly cron: string
  /**
   * IST minute-of-day from which a mid-session restart should replay this job.
   * Defaults to the cron's own first firing minute, which is what the legacy
   * `bootstrap()` thresholds almost always are (`0 21 9 * * 1-5` -> 561, exactly
   * `bn-breakout`'s `mins >= 561`). Set it explicitly only where an engine's
   * threshold deliberately differs from its cron — orb-fut fires at 09:45:20 but
   * bootstraps from 09:46.
   */
  readonly catchUpFrom?: number
  /**
   * Whether the job is safe to replay on a mid-session restart.
   *
   * True for idempotent setup (compute a band, set a range, flip a deadline
   * flag). FALSE for anything that places an order — replaying an entry after a
   * restart DUPLICATES the position, so those must be re-derived from recovered
   * state instead.
   */
  readonly replayable: boolean
  /** Override the 30s self-retry delay. */
  readonly retryAfterMs?: number
  /**
   * Cap on self-retries. Unset means "keep retrying until the day ends", which is
   * the legacy behaviour: a band that never forms retries all session and the log
   * line is the alert. Retries are always dropped by `endDay()`/`stop()`.
   */
  readonly maxRetries?: number
  readonly run: () => Promise<JobOutcome> | JobOutcome
}

/** A completed bar on a series the strategy declared in `dataNeeds()`. */
export interface CandleEvent {
  readonly token: number
  readonly interval: Interval
  readonly candle: Candle
}

/** The IST minute from which a restart replays this job. */
export function jobCatchUpMinute(job: JobSpec): number {
  return job.catchUpFrom ?? firstIstMinuteOfDay(job.cron)
}

export abstract class StrategyBase {
  protected readonly ctx: StrategyContext
  /**
   * Occurrences already executed, keyed `name@<next occurrence ms>`.
   *
   * Keying on the occurrence rather than the name is what lets a REPEATING job
   * (the 5-minute poller) fire many times a day while a once-a-day job still
   * cannot be double-fired by catch-up and the scheduler both deciding it is due.
   * `nextAfter` is used as the identity because every instant inside one gap
   * between fires maps to the same value.
   */
  readonly #firedOccurrences = new Set<string>()
  /**
   * Occurrences CLAIMED but not yet entered.
   *
   * Separate from `#firedOccurrences` because of the defect this split fixes:
   * `#execute` used to record the occurrence as fired BEFORE running it, and the
   * run could then be thrown away by the re-entrancy guard. A `squareOff` that
   * never executed was permanently marked done for the day, so the 15:15 exit
   * could never fire again — and the only trace was one `debug` line.
   *
   * The claim exists ONLY to stop two callers (restart catch-up and the live
   * scheduler) queueing the same occurrence twice. It is converted into a real
   * "fired" record at the moment `run()` is entered, and released either way.
   */
  readonly #claimedOccurrences = new Set<string>()
  /** Job names that ran (or were suppressed as unsafe) today. Reporting only. */
  readonly #firedNames = new Set<string>()
  /** Outstanding `{ retry: true }` re-arms, so they can be dropped at EOD/stop. */
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * THE serial work queue — concurrency 1, the legacy `async.queue(fn, 1)`.
   *
   * Ticks, candles, jobs, fills and the day-end all mutate the same strategy
   * state, so they must not interleave; that is what `status = 'CLOSING'` before
   * the first await was protecting. What changed is HOW: this used to be a
   * `#busy` boolean, and anything that arrived while another handler was
   * mid-await was DROPPED (`#guard` returned `undefined`). Since `onTick` can
   * await a multi-second HTTP submit, that dropped whole cron jobs — `formBand`
   * (no band means no trades at all) and `squareOff` (the strategy's own priced
   * 15:15 exit) — and it dropped exit-check ticks, contradicting the design
   * spec's "exits are never blocked".
   *
   * Work now WAITS its turn instead of being discarded. Serialisation (the
   * property worth keeping) is preserved exactly; loss (the bug) is not. Widening
   * the guard so overlapping work runs concurrently would have kept the loss and
   * added a race.
   */
  #queue: Promise<unknown> = Promise.resolve()
  /** Tasks enqueued and not yet finished. Backlog is a symptom worth logging. */
  #queueDepth = 0
  #started = false
  #stopped = false
  /**
   * Shutting down, but NOT yet stopped.
   *
   * The distinction is load-bearing. `stop()` used to set `#stopped` before
   * running `endDay()`, and `submit()` refuses everything once that flag is set
   * — so any square-off a strategy placed from `onDayEnd()` was silently
   * REFUSED. A flatten that quietly does nothing is the exact failure a day-end
   * exists to prevent, and it would present as an open position nobody could
   * explain the next morning.
   *
   * During the shutdown window: no NEW work starts (jobs, ticks and candles are
   * all gated on this), but orders `onDayEnd()` places still reach the gateway.
   * `#stopped` is set only once `endDay()` has finished.
   */
  #stopping = false

  constructor(ctx: StrategyContext) {
    this.ctx = ctx
  }

  get tag(): string {
    return this.ctx.tag
  }

  get isStopped(): boolean {
    return this.#stopped
  }

  // ---- required subclass surface -----------------------------------------

  /** What market data this strategy needs. The service dedups across all. */
  abstract dataNeeds(): readonly DataNeed[]

  /** Scheduled work, as IST cron expressions. */
  abstract jobs(): readonly JobSpec[]

  /** Called for every tick on a subscribed token. Must be cheap. */
  protected abstract onTick(quote: Quote): void | Promise<void>

  // ---- optional hooks ----------------------------------------------------

  /** Called when a declared series completes a bar. */
  protected async onCandle(_ev: CandleEvent): Promise<void> {}

  /** Idempotent daily reset. Called on start and at each new session. */
  protected async onDayStart(): Promise<void> {}

  /** Square-off / cleanup. Called at EOD and on stop. */
  protected async onDayEnd(_reason: string): Promise<void> {}

  protected async onFill(_fill: Fill): Promise<void> {}

  /**
   * Reconstruct in-memory state after a restart. Called before job catch-up.
   * This is where an open position is recovered — the thing the legacy system
   * structurally could not do.
   */
  protected async onRecover(): Promise<void> {}

  /**
   * The hardcoded config this instance is running, echoed on start (anatomy
   * row 20 — every engine ends with a `console.log` of its effective config,
   * because "which parameters is the running process actually using?" is
   * otherwise unanswerable from the logs).
   */
  protected effectiveConfig(): unknown {
    return null
  }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * Start the strategy.
   *
   * Runs unconditionally, exactly like the working legacy strategies
   * (`cheetah-b1-1.js:181`, `eagle-s-1.js:199` call `runStrategy()` bare at file
   * end). Only JOB catch-up is time-gated. Gating startup itself behind a time
   * window is the 2026-07-06 bug and must not be reintroduced.
   *
   * On failure `#started` is reset so a later retry can get through — the legacy
   * `catch { started = false }`. The error is contained rather than rethrown, for
   * the same reason `#run` contains one: in a shared runner process, one
   * strategy failing to start must not abort the others.
   */
  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true

    try {
      const jobs = this.jobs()
      // Validate every cron up front. A malformed expression is a programming
      // error, and it must surface at start with the job's name attached rather
      // than at 10:15 on a Tuesday from inside a timer.
      for (const j of jobs) {
        try {
          parseCron(j.cron)
        } catch (err) {
          throw new Error(`job '${j.name}': ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      this.ctx.log.info(`${this.tag}: starting`, { mode: this.ctx.mode })
      this.ctx.log.info(`${this.tag}: effective config`, {
        mode: this.ctx.mode,
        destinations: this.ctx.destinations.join(','),
        jobs: jobs.map((j) => `${j.name}[${j.cron}]`).join(' '),
        config: this.effectiveConfig(),
      })

      await this.onDayStart()
      await this.onRecover()

      this.ctx.fills.onFill((fill) => {
        void this.#run(() => this.onFill(fill), 'onFill')
      })

      await this.#catchUpJobs()
    } catch (err) {
      this.#started = false
      this.ctx.log.error(`${this.tag}: start failed, will retry`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Replay jobs whose IST time has already passed, so a mid-session restart lands
   * in the right state. Only `replayable` jobs are replayed — order-placing jobs
   * must be re-derived from recovered state, never replayed.
   *
   * Ordering is by catch-up minute, which preserves the deliberate
   * deadline-after-poller sequencing: the poller's threshold is the start of its
   * window, the deadline's is later, so a restart evaluates before it closes
   * entries rather than after.
   */
  async #catchUpJobs(): Promise<void> {
    const nowMin = this.ctx.clock.istMinutes()
    if (!isMarketOpen(this.ctx.clock)) {
      this.ctx.log.info(`${this.tag}: outside market hours, no job catch-up`)
      return
    }
    const due = this.jobs()
      .map((job) => ({ job, from: jobCatchUpMinute(job) }))
      .filter((x) => x.from <= nowMin)
      .sort((a, b) => a.from - b.from)

    for (const { job } of due) {
      if (!job.replayable) {
        this.ctx.log.warn(
          `${this.tag}: job '${job.name}' already due but is not replay-safe; ` +
            `relying on recovered state instead`,
        )
        this.#markFired(job)
        continue
      }
      this.ctx.log.info(`${this.tag}: catching up job '${job.name}'`)
      await this.#execute(job)
    }
  }

  /** Called by the scheduler when a job's cron fires. */
  async fireJob(name: string): Promise<void> {
    const job = this.jobs().find((x) => x.name === name)
    if (job === undefined) {
      this.ctx.log.warn(`${this.tag}: unknown job '${name}'`)
      return
    }
    await this.#execute(job)
  }

  /** @deprecated Jobs replaced phases; kept so existing callers keep working. */
  async firePhase(name: string): Promise<void> {
    await this.fireJob(name)
  }

  /** The occurrence identity for "now" — see `#firedOccurrences`. */
  #occurrenceKey(job: JobSpec): string {
    return `${job.name}@${nextAfter(job.cron, this.ctx.clock.now())}`
  }

  #markFired(job: JobSpec): void {
    this.#firedOccurrences.add(this.#occurrenceKey(job))
    this.#firedNames.add(job.name)
  }

  async #execute(job: JobSpec): Promise<void> {
    if (this.#halting) return
    const key = this.#occurrenceKey(job)
    if (this.#firedOccurrences.has(key)) {
      this.ctx.log.debug(`${this.tag}: job '${job.name}' already fired for this occurrence`)
      return
    }
    if (this.#claimedOccurrences.has(key)) {
      this.ctx.log.debug(`${this.tag}: job '${job.name}' already queued for this occurrence`)
      return
    }
    this.#claimedOccurrences.add(key)
    try {
      // The occurrence is marked fired INSIDE the attempt, once run() is
      // actually entered — never here, before the work has happened.
      await this.#attempt(job, 0, key)
    } finally {
      this.#claimedOccurrences.delete(key)
    }
  }

  /**
   * Run a job once. A `{ retry: true }` return re-arms it — the generalisation of
   * every engine's `setTimeout(computeWidth, 30000)` when the candles it needs
   * have not arrived yet.
   *
   * `occurrenceKey` is present only for the FIRST attempt of an occurrence; the
   * self-retries that follow are the same occurrence and must not re-mark it.
   */
  async #attempt(job: JobSpec, retriesSoFar: number, occurrenceKey?: string): Promise<void> {
    if (this.#halting) return
    // `unknown` rather than the union: a `void`-typed value cannot be narrowed by
    // comparison, and the whole point of the check is "did it ask for a retry?".
    const outcome: unknown = await this.#run(() => {
      // Re-checked at DEQUEUE time, not only at enqueue: `stop()` can be called
      // while this job waits its turn, and a queued entry must not fire into a
      // shutdown. Deliberately NOT marked fired in that case, so a restart can
      // still catch it up.
      if (this.#halting) return undefined
      // "Fired" is recorded HERE — inside the queued task, at the instant the
      // job's own code is entered. A job that threw still counts as fired (it
      // may have placed an order before throwing); a job that never ran does
      // not, which is the whole point.
      if (occurrenceKey !== undefined) {
        this.#firedOccurrences.add(occurrenceKey)
        this.#firedNames.add(job.name)
      }
      return job.run()
    }, `job:${job.name}`)
    const wantsRetry =
      typeof outcome === 'object' && outcome !== null && (outcome as JobRetry).retry === true
    if (!wantsRetry) return

    const max = job.maxRetries
    if (max !== undefined && retriesSoFar >= max) {
      this.ctx.log.warn(`${this.tag}: job '${job.name}' gave up after ${max} retries`)
      return
    }
    const delayMs = job.retryAfterMs ?? DEFAULT_JOB_RETRY_MS
    this.ctx.log.info(`${this.tag}: job '${job.name}' has no data yet, retrying in ${delayMs / 1000}s`)
    this.#scheduleRetry(job, retriesSoFar + 1, delayMs)
  }

  #scheduleRetry(job: JobSpec, attempt: number, delayMs: number): void {
    const existing = this.#retryTimers.get(job.name)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#retryTimers.delete(job.name)
      void this.#attempt(job, attempt)
    }, delayMs)
    // A pending retry must never be the reason a process (or a test) stays alive.
    ;(timer as { unref?: () => void }).unref?.()
    this.#retryTimers.set(job.name, timer)
  }

  #clearRetries(): void {
    for (const t of this.#retryTimers.values()) clearTimeout(t)
    this.#retryTimers.clear()
  }

  /**
   * Feed a tick in. Serialised through the concurrency-1 queue so a slow handler
   * cannot interleave with the next tick — the generalisation of the legacy
   * `async.queue(..., 1)` around candle polling.
   *
   * A tick that arrives while other work is in flight is DEFERRED, not dropped.
   * The exit check runs off the tick (design spec §2 row 10) and "exits are never
   * blocked" (§6), so discarding a tick because a cron job happened to be mid-await
   * silently disables the exit path for the duration of that job. Deferring costs
   * latency; dropping costs the position. StrategyBase cannot tell the exit part
   * of `onTick` from the entry part, so exempting "just the exit path" is not
   * implementable here — deferring the whole handler is.
   */
  handleTick(quote: Quote): void {
    if (this.#halting) return
    void this.#run(() => this.onTick(quote), 'onTick')
  }

  /** Feed a completed bar in. Serialised on the same queue as ticks. */
  handleCandle(ev: CandleEvent): void {
    if (this.#halting) return
    void this.#run(() => this.onCandle(ev), 'onCandle')
  }

  /** Wait for all queued work to drain. Used by tests, replay and `stop()`. */
  async drain(): Promise<void> {
    // A loop rather than one await: a queued handler can enqueue more work (a
    // fill arriving from a submit inside `onTick`), and awaiting only the tail
    // as it was on entry would return while that follow-on work is still
    // pending — which is exactly the window `stop()` must not race.
    let seen: Promise<unknown> | null = null
    while (seen !== this.#queue) {
      seen = this.#queue
      await seen
    }
  }

  /** End of day. Idempotent. */
  async endDay(reason: string): Promise<void> {
    this.#clearRetries()
    // Queued like everything else, so a job or tick already waiting its turn
    // completes BEFORE the square-off rather than racing it.
    await this.#run(() => this.onDayEnd(reason), 'onDayEnd')
    this.#firedOccurrences.clear()
    this.#firedNames.clear()
    this.#claimedOccurrences.clear()
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopped || this.#stopping) return
    // Blocks new work immediately; does NOT block `submit()`. See `#stopping`.
    this.#stopping = true
    this.ctx.log.info(`${this.tag}: stopping (${reason})`)
    this.#clearRetries()
    await this.drain()
    try {
      // The square-off runs while orders can still be placed.
      await this.endDay(reason)
    } finally {
      // In a `finally` so a throwing `onDayEnd` still leaves the strategy
      // stopped. The alternative is a strategy that failed to flatten AND is
      // still accepting orders, which is strictly worse than either alone.
      this.#stopped = true
      this.#stopping = false
    }
  }

  /**
   * No new work should be started: either shutting down or already stopped.
   *
   * Gates jobs, ticks and candles — but deliberately NOT `submit()`, so the
   * square-off `onDayEnd()` places during shutdown still reaches the gateway.
   */
  get #halting(): boolean {
    return this.#stopped || this.#stopping
  }

  /** True once the session is past close. */
  protected pastClose(): boolean {
    return this.ctx.clock.istMinutes() >= MARKET_CLOSE_MIN
  }

  /**
   * Whether this strategy may open NEW exposure right now.
   *
   * Deliberately does NOT gate exits: blocking an exit on a stale feed would
   * trap an open position, which is worse than the stale feed itself.
   *
   * Exposed for strategies that want to short-circuit before doing other work
   * (e.g. skip a whole entry-evaluation branch), but it is no longer the only
   * thing standing between a strategy and a stale-feed entry: `submit()` below
   * enforces this centrally, the same way the desk API enforces the kill
   * switch centrally rather than trusting every call site to remember it.
   */
  protected canEnter(): boolean {
    if (this.#halting) return false
    if (!this.ctx.feed.isTrustworthy()) {
      const reason = this.ctx.feed.reason() ?? 'unknown'
      this.ctx.log.warn(`${this.tag}: entry blocked — feed not trustworthy (${reason})`)
      return false
    }
    return true
  }

  // ---- helpers -----------------------------------------------------------

  /**
   * Submit an order. Returns the result rather than throwing, so a caller can
   * follow the legacy discipline of only flipping its "used" flag AFTER a
   * successful submit.
   *
   * The staleness gate is enforced HERE, centrally, rather than left to each
   * strategy remembering to call `canEnter()` first — the same reasoning as the
   * exposure limits' `isReducingExposure` check in `checkExposureLimits()`: no strategy
   * bug can bypass it, and it does not have to be relearned per file. Exits
   * (`reducesExposure: true`) are exempt for the same reason a stale feed must
   * never trap an open position.
   */
  protected async submit(req: SubmitRequest): Promise<SubmitResult> {
    if (this.#stopped) return { accepted: false, clientOrderId: null, reason: 'strategy stopped' }
    if (!req.reducesExposure && !this.canEnter()) {
      return { accepted: false, clientOrderId: null, reason: 'feed not trustworthy' }
    }
    const res = await this.ctx.orders.submit(req)
    if (!res.accepted) {
      this.ctx.log.warn(`${this.tag}: order rejected`, {
        reason: res.reason ?? 'unknown',
        symbol: req.instrument.tradingsymbol,
      })
    }
    return res
  }

  /**
   * Enqueue `fn` on the serial queue and resolve with its value (or `undefined`
   * if it threw).
   *
   * A strategy error is contained and logged: one strategy throwing must never
   * take down its neighbours in a shared runner process. Critically the error is
   * swallowed BEFORE it reaches the queue tail — a rejected tail would wedge the
   * queue permanently and every subsequent tick, job and square-off with it.
   */
  #run<T>(fn: () => T | Promise<T>, what = 'handler'): Promise<T | undefined> {
    this.#queueDepth++
    // 50 is far above anything a healthy strategy produces (ticks are handled in
    // microseconds) and far below "we have a memory problem". It is the signal
    // that a handler is awaiting something slow — the condition that USED to
    // silently eat jobs, so it must at least be visible now.
    if (this.#queueDepth > 50) {
      this.ctx.log.warn(`${this.tag}: work queue backlog`, { depth: this.#queueDepth, waiting: what })
    }
    const queued = this.#queue.then(async (): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err) {
        this.ctx.log.error(`${this.tag}: ${what} threw`, {
          error: err instanceof Error ? err.message : String(err),
        })
        return undefined
      } finally {
        this.#queueDepth--
      }
    })
    // Belt and braces: `queued` already absorbs `fn`'s error, but a throw from
    // the LOGGER itself would otherwise reject the tail and wedge everything.
    this.#queue = queued.then(undefined, () => undefined)
    return queued
  }

  /** Exposed for tests and diagnostics: work enqueued and not yet finished. */
  queueDepth(): number {
    return this.#queueDepth
  }

  /** Exposed for tests: which jobs have fired today. */
  firedJobs(): readonly string[] {
    return [...this.#firedNames]
  }

  /** @deprecated Use `firedJobs()`. */
  firedPhases(): readonly string[] {
    return this.firedJobs()
  }

  /** Exposed for tests: job names with a self-retry currently armed. */
  pendingRetries(): readonly string[] {
    return [...this.#retryTimers.keys()]
  }
}
