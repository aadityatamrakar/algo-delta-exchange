/**
 * THE GATEWAY'S ALERTS — the shared `desk-alerts` contract (every lane writes,
 * the forwarder sends):
 *
 *   insertOne { at, severity: 'critical'|'warn'|'info', source: 'gateway',
 *               mode: 'paper'|'live', tag?, key, message }
 *
 * AT MOST ONE DOCUMENT PER KEY PER 10 MINUTES, decided here in memory — a
 * condition re-checked every chase pass would otherwise write a row every five
 * seconds. A restart says it once more, which is the right amount of noise.
 *
 * FIRE-AND-FORGET. `raise` returns at once and never throws: an alert write
 * that fails, throws or hangs must never block or break the order path it is
 * reporting on. A failed write is logged; nothing retries it.
 */

export const DESK_ALERTS_COLLECTION = 'desk-alerts'
export const ALERT_DEDUPE_MS = 10 * 60_000

export type AlertSeverity = 'critical' | 'warn' | 'info'

export interface Alert {
  readonly severity: AlertSeverity
  readonly mode: 'paper' | 'live'
  /** Dedupe key: one document per key per `ALERT_DEDUPE_MS`. */
  readonly key: string
  readonly message: string
  readonly tag?: string
}

export interface AlertSink {
  raise(a: Alert): void
}

export function createAlertSink(deps: {
  readonly collection: { insertOne(doc: Record<string, unknown>): Promise<unknown> }
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}): AlertSink {
  const lastAt = new Map<string, number>()
  return {
    raise(a: Alert): void {
      try {
        const now = deps.now()
        for (const [k, at] of lastAt) if (now - at >= ALERT_DEDUPE_MS) lastAt.delete(k)
        if (lastAt.has(a.key)) return
        lastAt.set(a.key, now)
        const doc: Record<string, unknown> = {
          at: now,
          severity: a.severity,
          source: 'gateway',
          mode: a.mode,
          ...(a.tag === undefined || a.tag === '' ? {} : { tag: a.tag }),
          key: a.key,
          message: a.message,
        }
        void Promise.resolve()
          .then(() => deps.collection.insertOne(doc))
          .catch((err: unknown) => deps.log('alert write failed', { key: a.key, error: String(err) }))
      } catch (err) {
        try {
          deps.log('alert write failed', { key: a.key, error: String(err) })
        } catch {
          /* nothing an alert can do may reach the order path */
        }
      }
    },
  }
}

/** A sink that drops everything — the default where none is wired. */
export const NO_ALERTS: AlertSink = { raise: () => {} }
