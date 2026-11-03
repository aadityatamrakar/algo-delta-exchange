/**
 * DESK HEALTH, FROM OUTSIDE THE DESK — the existing freshness signals, read
 * the way Status reads them (`apps/api/src/routes/system.ts`):
 *
 *   dx-gateway     `desk-gateway-heartbeat` `_id: 'gateway'`, written every
 *                  15 s (`gateway-heartbeat.ts`); stale past
 *                  DX_WATCHDOG_GATEWAY_STALE_S (60, four beats).
 *   dx-supervisor  `desk-supervisor-lease`, renewed every 10 s to now + 30 s:
 *                  healthy while unexpired (5 s grace).
 *   dx-api         `GET /v1/desk/system` answering at all (a 401 is still a
 *                  live process).
 *   dx-marketdata  that report's market-data card: desk-api's view of the
 *                  last `md.health` frame. Only read when the report is.
 *
 * Mongo reads go to the same mongod every desk process uses, so a failed
 * read is reported as an unhealthy desk by the caller, never swallowed.
 */
type Doc = Record<string, unknown>

import type { HealthReading } from './watchdog.ts'

export const GATEWAY_HEARTBEAT_COLLECTION = 'desk-gateway-heartbeat'
export const SUPERVISOR_LEASE_COLLECTION = 'desk-supervisor-lease'
export const SUPERVISOR_LEASE_KEY = 'desk-supervisor'
export const DEFAULT_GATEWAY_STALE_MS = 60_000
const LEASE_GRACE_MS = 5_000

const age = (ms: number): string => `${Math.round(ms / 1000)}s`

export function gatewayReading(doc: Doc | null, now: number, staleMs: number): HealthReading {
  const at = typeof doc?.['at'] === 'number' ? doc['at'] : null
  if (at === null) return { component: 'dx-gateway', healthy: false, detail: 'no gateway heartbeat row' }
  const old = now - at
  return old <= staleMs
    ? { component: 'dx-gateway', healthy: true, detail: `heartbeat ${age(old)} old` }
    : { component: 'dx-gateway', healthy: false, detail: `heartbeat ${age(old)} old` }
}

export function supervisorReading(doc: Doc | null, now: number): HealthReading {
  const exp = typeof doc?.['expiresAt'] === 'number' ? doc['expiresAt'] : null
  if (exp === null) return { component: 'dx-supervisor', healthy: false, detail: 'no supervisor lease' }
  return exp + LEASE_GRACE_MS >= now
    ? { component: 'dx-supervisor', healthy: true, detail: 'lease held' }
    : { component: 'dx-supervisor', healthy: false, detail: `lease expired ${age(now - exp)} ago` }
}

export function apiReadings(r: { status: number; body: unknown } | { error: string }): HealthReading[] {
  if ('error' in r) return [{ component: 'dx-api', healthy: false, detail: `unreachable: ${r.error}` }]
  const out: HealthReading[] = [{ component: 'dx-api', healthy: true, detail: `answered ${r.status}` }]
  if (r.status !== 200) return out
  const comps = (r.body as { components?: unknown } | null)?.components
  const md = Array.isArray(comps) ? (comps as Doc[]).find((c) => c['id'] === 'dx-marketdata') : undefined
  if (md !== undefined) {
    const state = String(md['state'] ?? 'unknown')
    out.push({
      component: 'dx-marketdata',
      healthy: state === 'ok' || state === 'attention',
      detail: `${state}${typeof md['detail'] === 'string' ? `: ${md['detail'].slice(0, 120)}` : ''}`,
    })
  }
  return out
}

export async function readDeskHealth(deps: {
  readonly db: { collection(name: string): unknown }
  readonly fetch: typeof fetch
  readonly apiUrl: string
  readonly token: string
  readonly now: () => number
  readonly gatewayStaleMs?: number
}): Promise<HealthReading[]> {
  const one = (name: string, q: Doc): Promise<Doc | null> =>
    (deps.db.collection(name) as { findOne(q: Doc): Promise<Doc | null> }).findOne(q)
  const [gw, lease] = await Promise.all([
    one(GATEWAY_HEARTBEAT_COLLECTION, { _id: 'gateway' }),
    one(SUPERVISOR_LEASE_COLLECTION, { key: SUPERVISOR_LEASE_KEY }),
  ])
  let api: { status: number; body: unknown } | { error: string }
  try {
    const res = await deps.fetch(`${deps.apiUrl.replace(/\/+$/, '')}/v1/desk/system`, {
      headers: deps.token === '' ? {} : { Authorization: `Bearer ${deps.token}` },
      signal: AbortSignal.timeout(5_000),
    })
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    api = { status: res.status, body }
  } catch (err) {
    api = { error: err instanceof Error ? err.message : String(err) }
  }
  const now = deps.now()
  return [
    gatewayReading(gw, now, deps.gatewayStaleMs ?? DEFAULT_GATEWAY_STALE_MS),
    supervisorReading(lease, now),
    ...apiReadings(api),
  ]
}
