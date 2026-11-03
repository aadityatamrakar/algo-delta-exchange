/**
 * THE DESK'S ALERT WRITER — the shared `desk-alerts` contract (3 Nov, lanes
 * A/B/C): every process that sees something an operator must hear about
 * inserts one document; the watchdog forwards each one it has not forwarded
 * (`forwardedAt`) and desk-api serves and acks them (`ackedAt`). The writer
 * never sets either.
 *
 *   { at, severity, source, mode, tag?, key, message }
 *
 * AT MOST ONE DOC PER KEY PER `ALERT_DEDUPE_MS`, counted in this process: a
 * condition that holds for an hour is six alerts, not 1,800. A write that
 * fails does not consume the window, so the next pass tries again.
 *
 * FIRE-AND-FORGET. `raise` returns nothing and never throws, whatever the
 * collection does: trading code calls it inline, and an alert that cannot be
 * written must never be the reason a stop does not go out.
 *
 * Zero dependencies: the collection is anything with an `insertOne`.
 */

export type AlertSeverity = 'critical' | 'warn' | 'info'

export interface DeskAlert {
  readonly severity: AlertSeverity
  /** The writing process: 'supervisor', 'api', 'gateway', 'watchdog'. */
  readonly source: string
  readonly mode: 'paper' | 'live'
  readonly tag?: string
  /** The dedupe key, e.g. `<tag>:stale-quote`. */
  readonly key: string
  readonly message: string
}

export interface DeskAlertDoc extends DeskAlert {
  /** Epoch ms. */
  readonly at: number
}

export interface AlertCollection {
  insertOne(doc: DeskAlertDoc): unknown
}

export const DESK_ALERTS_COLLECTION = 'desk-alerts'
export const ALERT_DEDUPE_MS = 10 * 60_000

export type RaiseAlert = (alert: DeskAlert) => void

export function createAlertSink(
  collection: AlertCollection,
  opts: { now?: () => number; log?: (message: string) => void; dedupeMs?: number } = {},
): RaiseAlert {
  const now = opts.now ?? Date.now
  const dedupeMs = opts.dedupeMs ?? ALERT_DEDUPE_MS
  const last = new Map<string, number>()
  const fail = (key: string, err: unknown): void => {
    last.delete(key)
    try {
      opts.log?.(`desk-alerts: could not write ${key}: ${err instanceof Error ? err.message : String(err)}`)
    } catch {
      // A log that throws is still not the caller's problem.
    }
  }
  return (alert) => {
    try {
      const at = now()
      const prev = last.get(alert.key)
      if (prev !== undefined && at - prev < dedupeMs) return
      last.set(alert.key, at)
      const doc: DeskAlertDoc = {
        at,
        severity: alert.severity,
        source: alert.source,
        mode: alert.mode,
        ...(alert.tag === undefined ? {} : { tag: alert.tag }),
        key: alert.key,
        message: alert.message,
      }
      let pending: unknown
      try {
        pending = collection.insertOne(doc)
      } catch (err) {
        fail(alert.key, err)
        return
      }
      if (pending !== null && typeof pending === 'object' && typeof (pending as Promise<unknown>).then === 'function') {
        ;(pending as Promise<unknown>).then(undefined, (err: unknown) => fail(alert.key, err))
      }
    } catch {
      // Never into trading code.
    }
  }
}
