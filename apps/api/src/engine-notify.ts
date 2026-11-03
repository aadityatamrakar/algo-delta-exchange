/**
 * Telling the recenter SUPERVISOR that something it steers by has changed.
 *
 * WHY THIS EXISTS AT ALL. The supervisor evaluates a book on the 5-minute mark
 * grid. Everything an operator does between two marks — retuning the dials,
 * creating a book, a live fill arriving on a working package — is invisible to
 * it until the next one, and "invisible for up to five minutes" is a different
 * thing for each of those. A dial change that does not land is a risk control
 * the operator believes is in force and is not. Production Mongo is a
 * STANDALONE, so there are no change streams to watch and none may be depended
 * on; one HTTP call at the point of the write is the whole mechanism, exactly
 * as `apps/order-gateway/src/notify.ts` reaches this process.
 *
 * IT IS BEST EFFORT, AND THAT IS THE POINT OF THE FILE.
 *
 *   - It NEVER THROWS and never rejects. Every failure — supervisor not
 *     running, a 500, an abort — is swallowed and logged. A nudge that could
 *     fail a dials PATCH would turn "the supervisor is down" into "the operator
 *     cannot change a limit", which is the wrong way round: the write is
 *     already durable by the time this is called, and the supervisor re-reads
 *     the book at its next mark regardless.
 *   - The request carries a SHORT TIMEOUT (1s). Without one, a supervisor that
 *     accepts the connection and then hangs would hold an operator's request
 *     open, and desk-api is the process the dashboard is talking to.
 *   - The abort timer is `unref`'d. A pending nudge must never be the reason a
 *     shutdown waits.
 *   - Failures are logged at most once a minute, so a supervisor that is simply
 *     not deployed yet does not bury the log in one line per dial write.
 *
 * THE NUDGE CARRIES NO INSTRUCTIONS. `kind` says which of the supervisor's own
 * reads is stale; the payload only narrows it to a book. The supervisor re-reads
 * the truth from Mongo — it must never take a decision input from an HTTP body
 * this process composed, or the two would be able to disagree about the book
 * without either of them being wrong.
 */

import { SUPERVISOR_NUDGE_PORT_DEFAULT } from '@algomaker/desk-engine'

/** What went stale. Each names one of the supervisor's own cached reads. */
export type NudgeKind =
  /** A book's dials were rewritten — the risk controls it sizes orders with. */
  | 'dials'
  /** A fill landed on a package it is working, so its ledger moved. */
  | 'fill'
  /** A book was created, retired, started or stopped. */
  | 'registry'

export const NUDGE_PATH = '/nudge'
const LOG_EVERY_MS = 60_000
const DEFAULT_TIMEOUT_MS = 1000

export interface NudgeDeps {
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** Injected by the tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly now?: () => number
  /**
   * `DESK_SUPERVISOR_PORT`, else the contract's default. Read per call rather
   * than captured at module load so a test — and a boot that reads `.env.local`
   * after this file is imported — sees the value that is actually set.
   */
  readonly port?: number
  /**
   * The bearer to present, defaulting to `DESK_API_TOKEN` — the machine
   * credential every sibling process on this desk already holds.
   *
   * DEFAULTED IN THIS MODULE RATHER THAN PASSED PER CALL SITE, deliberately.
   * `notifySupervisor` will gain call sites (fill nudges, registry nudges), and
   * a credential that each of them has to remember to pass is a credential one
   * of them will forget — at which point the supervisor either has to accept
   * unauthenticated nudges from anything on the box, or starts silently
   * refusing one kind of nudge. Reading it here means every call site is
   * authenticated by construction, and the option stays for tests.
   *
   * An EMPTY string sends no header at all, which is the honest state for a
   * deployment that has not set the variable: the nudge carries no
   * instructions and the endpoint is bound to loopback, so an unauthenticated
   * one is degraded, not dangerous.
   */
  readonly token?: string
}

/** Per-process, so an unreachable supervisor costs one log line a minute. */
let lastLoggedAt: number | null = null

function envPort(): number {
  const raw = Number(process.env['DESK_SUPERVISOR_PORT'] ?? '')
  return Number.isInteger(raw) && raw > 0 ? raw : SUPERVISOR_NUDGE_PORT_DEFAULT
}

/**
 * Nudge the supervisor. Resolves when the call is over, or when it failed —
 * never rejects, so `await`ing this cannot fail the act that prompted it.
 *
 * Awaited rather than fired-and-forgotten at its call sites: the timeout bounds
 * it at 1s, a supervisor that is not running refuses the loopback connection
 * instantly, and an ordered log line is worth more than the microseconds.
 */
export async function notifySupervisor(
  kind: NudgeKind,
  payload: Record<string, unknown>,
  deps: NudgeDeps,
): Promise<void> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = deps.now ?? ((): number => Date.now())
  const port = deps.port ?? envPort()
  // Read per call, not captured at import: `.env.local` is parsed during boot,
  // which can be after this module is first loaded.
  const token = deps.token ?? process.env['DESK_API_TOKEN'] ?? ''

  const complain = (reason: string): void => {
    const at = now()
    if (lastLoggedAt !== null && at - lastLoggedAt < LOG_EVERY_MS) return
    lastLoggedAt = at
    deps.log('supervisor nudge failed — the change is saved; it lands at the next 5-minute mark', {
      kind,
      reason,
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // A pending nudge must never hold the process open through a shutdown. This
  // is the least important thing this process does.
  timer.unref?.()
  try {
    const res = await doFetch(`http://127.0.0.1:${port}${NUDGE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ kind, ...payload }),
      signal: controller.signal,
    })
    if (!res.ok) complain(`HTTP ${res.status}`)
  } catch (err) {
    complain(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }
}

/** Test seam: forget when we last complained, so a suite's runs are independent. */
export function resetNudgeLog(): void {
  lastLoggedAt = null
}
