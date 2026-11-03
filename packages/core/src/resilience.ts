/**
 * Staying up: crash guards and a boot that survives an outage.
 *
 * SHARED, and it did not use to be (audit F-41). Both of the incidents below
 * are the ORDER GATEWAY'S incidents — this file was written there, and lived
 * there. Meanwhile `apps/api` and `apps/runner` each awaited a bare
 * `connectMongo` and installed no guards at all, so the same Mongo arriving 20
 * seconds late at 09:14 burned pm2's whole restart budget in ~70 seconds and
 * left the bridge down for the session: the process that had learned the lesson
 * stayed up, and the two that had not did not. `apps/order-gateway/src/
 * resilience.ts` is now a re-export of this module, so there is one copy and
 * one place to fix.
 *
 * G4 — UNHANDLED REJECTIONS KILLED IT. `void sweep()` and `void (async …)()` in
 * the order-update handler had no catch. A Mongo blip inside `claimNext()`
 * rejected, nothing was listening, and Node (>=15, and firmly so on 24) treats
 * an unhandled rejection as a fatal error. A momentary network fault therefore
 * took the only process that can place orders down mid-session. Each site now
 * catches its own errors AND this guard is installed, because "each site
 * catches" is a property that lasts exactly until the next call site is added.
 *
 * G6 — THE RESTART GAVE UP AFTER ~70 SECONDS. Boot awaited `connectMongo`, whose
 * `serverSelectionTimeoutMS` is 5s, and exited on failure. With pm2's
 * `min_uptime: 10_000` every one of those 5-second lives counts as unstable, so
 * after `max_restarts: 10` (~70s including `restart_delay`) pm2 stops trying
 * entirely. Mongo coming back at 09:16 then brings nothing back with it. A
 * process that RETRIES instead of exiting stays alive past `min_uptime`, so the
 * restart budget is never spent and recovery is automatic.
 */

/** The part of `process` these guards need. Injected so they are testable. */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * Log unhandled rejections instead of dying of them.
 *
 * DELIBERATELY DOES NOT EXIT. The alternative reading — "an unhandled rejection
 * means unknown state, so die" — is the safer default for most processes, and it
 * is the wrong one for every process on this desk: the gateway is the only one
 * that can place or resolve an order, the bridge is the only one that can serve
 * the dashboard and the routes, the runner holds the strategy state, all of
 * their work is claim-based or resumable, and their supervisor gives up after
 * ten fast restarts. Dying loses every subsequent fill; staying up loses one
 * operation and says so.
 *
 * `uncaughtException` is deliberately NOT swallowed — a synchronous throw out of
 * a call stack really can leave torn state, and there is no bounded recovery
 * from it the way there is from a rejected promise.
 */
export function installCrashGuards(deps: {
  process: ProcessLike
  log: (msg: string, ctx?: Record<string, unknown>) => void
}): void {
  deps.process.on('unhandledRejection', (...args: unknown[]) => {
    const reason = args[0]
    deps.log('UNHANDLED REJECTION — this process is staying up deliberately', {
      error: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
    })
  })
}

export interface RetryOptions {
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** What is being connected to, for the log line. */
  readonly what: string
  readonly sleep?: (ms: number) => Promise<void>
  readonly firstDelayMs?: number
  readonly maxDelayMs?: number
  /**
   * Give up after this many attempts. Default INFINITE, which is the point:
   * see the G6 note above. Tests pass a bound so they terminate.
   */
  readonly maxAttempts?: number
}

/**
 * Keep trying until it works, with exponential backoff.
 *
 * The backoff is capped rather than unbounded so a Mongo that returns after an
 * hour is picked up within `maxDelayMs`, not an hour later.
 */
export async function connectWithRetry<T>(
  connect: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const first = opts.firstDelayMs ?? 1000
  const max = opts.maxDelayMs ?? 15_000
  const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY

  for (let attempt = 1; ; attempt++) {
    try {
      const value = await connect()
      if (attempt > 1) opts.log(`${opts.what} reachable again`, { attempt })
      return value
    } catch (err) {
      if (attempt >= maxAttempts) throw err
      const delay = Math.min(max, first * 2 ** (attempt - 1))
      opts.log(`${opts.what} not reachable — retrying rather than exiting`, {
        attempt,
        retryInMs: delay,
        error: err instanceof Error ? err.message : String(err),
      })
      await sleep(delay)
    }
  }
}
