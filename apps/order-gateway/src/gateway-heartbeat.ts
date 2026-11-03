/**
 * THE GATEWAY'S PROOF OF LIFE, and Delta's positions as the gateway sees them.
 *
 * Two small writers the bridge's Status page reads (`apps/api/src/routes/
 * system.ts`, `positions-compare.ts`):
 *
 *   - `desk-gateway-heartbeat` `_id: 'gateway'`, every 15 s in EVERY broker
 *     mode: when it beat, which broker it routes live orders to (`simulate` or
 *     `delta`, plus the Delta host so a demo/testnet host is visible), and the
 *     newest order event it journalled. A gateway that stopped writing this has
 *     stopped, whatever pm2 says.
 *   - `desk-broker-snapshot` `_id: 'delta'`, every 30 s on the LIVE rail only:
 *     Delta's `/v2/positions` in BTC, keyed by Delta's product symbol — which IS
 *     the desk's tradingsymbol (`symbolSpace: 'desk'`), so the comparison joins
 *     on it directly. A failed read is written as `ok: false` with the error and
 *     NO positions, so a stale list can never be compared as current.
 *   - `desk-broker-snapshot` `_id: 'delta-demo'`, the same, for the DEMO rail's
 *     testnet account (`dx-demo.ts`) once that rail is built from a
 *     `delta-demo` key. Testnet product symbols are the desk's tradingsymbols.
 *
 * NEVER THROWS. A failed write is logged and retried on the next beat; the
 * caller owns the timers.
 */
import type { BrokerPosition } from '@algomaker/order-bus'

export const GATEWAY_HEARTBEAT_COLLECTION = 'desk-gateway-heartbeat'
export const GATEWAY_HEARTBEAT_ID = 'gateway'
export const GATEWAY_HEARTBEAT_MS = 15_000

export const BROKER_SNAPSHOT_COLLECTION = 'desk-broker-snapshot'
export const DELTA_SNAPSHOT_ID = 'delta'
export const DELTA_DEMO_SNAPSHOT_ID = 'delta-demo'
export const DELTA_SNAPSHOT_MS = 30_000

export type GatewayBroker = 'simulate' | 'delta'

export interface GatewayHeartbeatDoc {
  readonly at: number
  readonly startedAt: number
  readonly pid: number
  readonly broker: GatewayBroker
  /** The Delta REST host live orders go to; null in simulate mode. */
  readonly host: string | null
  /** Newest journalled order event (not a desk-api `INVALID` refusal); null when none. */
  readonly lastOrderAt: number | null
  /** Delta's dead-man heartbeat: true/false on the live rail, null in simulate mode. */
  readonly deltaHeartbeatOk: boolean | null
  /** The demo (testnet) rail: built from a `delta-demo` key or not; null off DX. */
  readonly demoReady: boolean | null
}

interface UpsertCollection {
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
}

interface EventsCollection {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): { limit(n: number): { toArray(): Promise<unknown[]> } }
  }
}

type Log = (msg: string, ctx?: Record<string, unknown>) => void
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The host of a base URL, or the URL itself when it does not parse. */
export function hostOf(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl === '') return null
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function createGatewayHeartbeat(deps: {
  readonly collection: UpsertCollection
  readonly events: EventsCollection
  readonly now: () => number
  readonly startedAt: number
  readonly pid: number
  readonly broker: GatewayBroker
  readonly host: string | null
  readonly deltaHeartbeatOk: () => boolean | null
  readonly demoReady?: () => boolean | null
  readonly log: Log
}): { beat(): Promise<void> } {
  let failing = false
  return {
    async beat(): Promise<void> {
      try {
        let lastOrderAt: number | null = null
        try {
          const rows = (await deps.events.find({}).sort({ ts: -1 }).limit(25).toArray()) as Record<string, unknown>[]
          for (const r of rows) {
            const ts = r['ts']
            if (r['phase'] === 'INVALID' || typeof ts !== 'number' || !(ts > 0)) continue
            if (lastOrderAt === null || ts > lastOrderAt) lastOrderAt = ts
          }
        } catch {
          lastOrderAt = null
        }
        const doc: GatewayHeartbeatDoc = {
          at: deps.now(),
          startedAt: deps.startedAt,
          pid: deps.pid,
          broker: deps.broker,
          host: deps.host,
          lastOrderAt,
          deltaHeartbeatOk: deps.deltaHeartbeatOk(),
          demoReady: deps.demoReady?.() ?? null,
        }
        await deps.collection.updateOne({ _id: GATEWAY_HEARTBEAT_ID }, { $set: doc }, { upsert: true })
        if (failing) deps.log('gateway heartbeat written again')
        failing = false
      } catch (err) {
        if (!failing) deps.log('gateway heartbeat write FAILED — Status will read the gateway as stale', { error: errorText(err) })
        failing = true
      }
    },
  }
}

export function createDeltaPositionsSnapshot(deps: {
  readonly positions: () => Promise<readonly BrokerPosition[]>
  readonly collection: UpsertCollection
  readonly now: () => number
  readonly host: string | null
  readonly log: Log
  /** Default the production account: `_id: 'delta'`, broker `delta`. */
  readonly id?: string
  readonly broker?: 'delta' | 'delta-demo'
}): { take(): Promise<void> } {
  const id = deps.id ?? DELTA_SNAPSHOT_ID
  const broker = deps.broker ?? 'delta'
  let running = false
  return {
    async take(): Promise<void> {
      if (running) return
      running = true
      try {
        let set: Record<string, unknown>
        try {
          const rows = await deps.positions()
          set = {
            asOf: deps.now(),
            ok: true,
            error: '',
            broker,
            host: deps.host,
            symbolSpace: 'desk',
            positions: rows.map((p) => ({ tradingsymbol: p.tradingsymbol, netQty: p.netQty, avgPrice: p.avgPrice })),
            emptyDiagnostic: { positions: `array(${rows.length})` },
          }
        } catch (err) {
          set = {
            asOf: deps.now(),
            ok: false,
            error: `Delta${broker === 'delta-demo' ? ' testnet' : ''} /v2/positions failed: ${errorText(err)}`,
            broker,
            host: deps.host,
            symbolSpace: 'desk',
            positions: null,
          }
        }
        await deps.collection.updateOne({ _id: id }, { $set: set }, { upsert: true })
      } catch (err) {
        deps.log('Delta positions snapshot write failed', { id, error: errorText(err) })
      } finally {
        running = false
      }
    },
  }
}
