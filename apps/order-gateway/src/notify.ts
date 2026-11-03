/**
 * Telling `desk-api` that an order event just happened.
 *
 * WHY THIS EXISTS AT ALL. `desk-api`'s OWN fills are journalled inside that
 * process, so it knows about them at the moment of the write. Anything this
 * gateway works is placed HERE, in another process, and production Mongo is a
 * standalone — there are no change streams to watch and none may be depended
 * on. One HTTP call at the point we journal is the whole mechanism.
 *
 * IT IS NOT LIVE-ONLY ANY MORE (D14). The engine's PAPER orders go through this
 * gateway's queue, so the frame carries the rail the ORDER is on — see
 * `modeOf`. Sending them all as live put a rehearsal's every step in front of
 * an operator watching real money.
 *
 * IT IS BEST EFFORT, AND THAT IS THE POINT OF THE FILE.
 *
 * This process places real orders. A dashboard that missed an update is an
 * inconvenience; a gateway that stalled on a notify is an outage. So:
 *
 *   - `notify()` returns `void`, not a promise. There is nothing for the order
 *     path to `await`, so there is nothing for it to be blocked by. A caller
 *     cannot accidentally make this synchronous.
 *   - Every failure — unreachable API, a 500, a DNS blip, an abort — is
 *     swallowed and logged. Nothing thrown here can reach a call site.
 *   - The request carries a short timeout. Without one, a `desk-api` that
 *     accepts the connection and then hangs would leave sockets accumulating in
 *     the only process that can place orders.
 *   - Failures are logged at most once a minute. A bridge that is down produces
 *     one event per journal write, and a log line per failure would bury the
 *     broker errors that actually matter.
 *
 * The credential is `DESK_API_TOKEN`, the same machine bearer this gateway's
 * siblings already hold. `POST /v1/desk/stream/notify` accepts it as a `machine`
 * principal and refuses a session cookie, so a browser cannot inject an event.
 */

import { orderMode, type OrderEvent } from './journal.ts'

export interface NotifierDeps {
  /** Base URL of `desk-api`, e.g. `http://127.0.0.1:8890`. */
  readonly url: string
  /** `DESK_API_TOKEN`. An empty token disables the notifier entirely. */
  readonly token: string
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** Injected by the tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly now?: () => number
}

/**
 * WHICH TAB THIS EVENT BELONGS ON — read off the event, not fixed per process.
 *
 * It used to be the constant `'live'`, on the premise that this gateway reads
 * only the live queue. D14 ended that: the engine's PAPER orders are worked
 * through the same queue, so a rehearsal's every PLANNED/ACK/STATUS became a
 * nudge on the LIVE tab, telling an operator watching real money that something
 * had just happened to it.
 *
 * The event says which rail it is on — `OrderEvent.mode`, folded into
 * `detail.mode` by `OrderJournal.record`, which is why both are read here: the
 * journal hands this notifier its STAMPED event, while `order-chaser.ts` and
 * `broker-sweep.ts` build an `OrderEvent` and notify from it directly.
 *
 * FAIL-CLOSED TO PAPER, the same direction as every other reader of this
 * field on the Delta desk (`orderMode`): only an exact `'live'` is live.
 */
function modeOf(event: OrderEvent): 'paper' | 'live' {
  // `orderMode` is the rule, asked of each place the rail can be stated rather
  // than re-spelled here. The top-level field wins when present; otherwise the
  // journal's folded `detail.mode`.
  return orderMode({ mode: event.mode ?? event.detail?.['mode'] })
}

const NOTIFY_PATH = '/v1/desk/stream/notify'
const LOG_EVERY_MS = 60_000

/**
 * Build the notifier. Returns a function that never throws and never blocks.
 *
 * A missing token or URL yields a NO-OP with one line in the log at startup,
 * rather than a function that fails a request per event: an operator who has not
 * configured the bridge URL should see one sentence, not a log full of them.
 */
export function createDeskNotifier(deps: NotifierDeps): (event: OrderEvent) => void {
  const base = deps.url.replace(/\/$/, '')
  if (base === '' || deps.token === '') {
    deps.log('desk-api notify DISABLED — no URL or token; the dashboard will fall back to polling')
    return () => {}
  }

  const doFetch = deps.fetch ?? globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? 2000
  const now = deps.now ?? ((): number => Date.now())
  // `null`, not 0: "never logged" and "logged at time 0" are different states,
  // and conflating them swallows the FIRST failure — the one that says the
  // bridge went down, which is the only one anybody needs.
  let lastLoggedAt: number | null = null

  const complain = (reason: string): void => {
    const at = now()
    if (lastLoggedAt !== null && at - lastLoggedAt < LOG_EVERY_MS) return
    lastLoggedAt = at
    deps.log('desk-api notify failed — orders are unaffected, the dashboard falls back to polling', {
      reason,
    })
  }

  return (event: OrderEvent): void => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      // Unref'd: a pending notify must never hold the process open through a
      // shutdown. This is the least important thing this gateway does.
      timer.unref?.()
      void doFetch(`${base}${NOTIFY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.token}`,
        },
        body: JSON.stringify({ mode: modeOf(event), event }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) complain(`HTTP ${res.status}`)
        })
        .catch((err: unknown) => {
          complain(err instanceof Error ? err.message : String(err))
        })
        .finally(() => clearTimeout(timer))
    } catch (err) {
      // Reachable if `fetch` itself throws synchronously — a bad URL, a missing
      // global on an older runtime. Swallowed like everything else here: the
      // order this event describes has already been placed.
      complain(err instanceof Error ? err.message : String(err))
    }
  }
}
