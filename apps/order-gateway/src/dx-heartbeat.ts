/**
 * DELTA'S DEAD-MAN SWITCH (spec §8) — and why, with backstops on, it is RETIRED.
 *
 * `create` registers a heartbeat that makes Delta cancel every open BTC option
 * order once an ack is missed; each `ack` renews it for `ttl`. Acked every 10 s
 * with a 30 s ttl, so two missed beats are tolerated and a dead gateway stops
 * quoting within 30 s. Positions are not closed by Delta — only orders.
 *
 * IT ALSO CANCELS STOP ORDERS. Observed on the India testnet, 3 Nov 2026: an
 * untriggered stop-loss order on a product the switch covered was cancelled
 * with `cancellation_reason: cancelled_due_to_deadman_switch_trigger` when the
 * ttl ran out. The exchange-resident backstops (`dx-backstop.ts`) exist for the
 * moment the desk dies — exactly when this switch fires — so the two cannot
 * both run. With `DX_BACKSTOP` on (the default) the gateway RETIRES the switch
 * (`retireDxHeartbeat`) and `dx-watchdog` cancels the desk's non-stop working
 * orders instead (`DELETE /v2/orders/all` with `cancel_stop_orders: false`).
 * `createDxHeartbeat` remains for `DX_BACKSTOP=0`.
 *
 * NEVER THROWS: a beat that failed is said and retried on the next one. The
 * caller owns the timer.
 */
import { DxApiError, type DxRest } from '@algomaker/dx'

export const DX_HEARTBEAT_MS = 10_000
export const DX_HEARTBEAT_TTL_MS = 30_000

export interface DxHeartbeat {
  /** One beat: create until it succeeds, ack after; re-create after a failed ack. */
  beat(): Promise<void>
  /** False after a failed beat, until the next one lands. */
  readonly healthy: boolean
}

const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createDxHeartbeat(deps: {
  readonly rest: Pick<DxRest, 'heartbeat'>
  readonly ttlMs?: number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}): DxHeartbeat {
  const ttl = deps.ttlMs ?? DX_HEARTBEAT_TTL_MS
  /**
   * Re-armed on every failed ack: Delta can drop the heartbeat (its restart,
   * an expiry), and acking an id it no longer holds then fails forever — the
   * switch looked armed while nothing guarded the orders.
   */
  let created = false
  /** A create has landed once: a later refused re-create ("already exists") still gets its ack. */
  let everCreated = false
  let healthy = false
  let running = false
  return {
    get healthy(): boolean {
      return healthy
    },
    async beat(): Promise<void> {
      if (running) return
      running = true
      try {
        if (!created) {
          try {
            await deps.rest.heartbeat('create', ttl)
            deps.log('DX HEARTBEAT armed — Delta cancels open orders if this process stops acking', { ttlMs: ttl })
            created = true
            everCreated = true
            healthy = true
            return
          } catch (err) {
            if (!everCreated) {
              healthy = false
              deps.log('DX HEARTBEAT create FAILED — Delta will not cancel open orders if this process stops', {
                error: msgOf(err),
              })
              return
            }
            deps.log('DX HEARTBEAT re-create FAILED — acking the existing one', { error: msgOf(err) })
          }
        }
        try {
          await deps.rest.heartbeat('ack', ttl)
          created = true
          healthy = true
        } catch (err) {
          healthy = false
          created = false
          deps.log('DX HEARTBEAT ack FAILED — re-creating on the next beat; Delta cancels open orders when the ttl runs out', {
            error: msgOf(err),
          })
        }
      } finally {
        running = false
      }
    },
  }
}

export interface DxHeartbeatRetirer {
  /** Until retired: ack a live ttl, then ack 0. After: nothing, ever. */
  beat(): Promise<void>
  readonly retired: boolean
}

/**
 * Switch the rest client's heartbeat OFF on Delta, so it cannot cancel the
 * backstops when this process dies.
 *
 * The pair matters (testnet, 3 Nov 2026): `ttl: 0` on an enabled switch
 * disables it; on a disabled one it RE-ENABLES with a zero ttl and fires at
 * once. Acking a live ttl first makes the switch enabled whatever state it was
 * in, so the 0 that follows always lands on an enabled one. Retired only on
 * Delta's own `process_enabled: false`; once retired it is never acked again.
 *
 * A 4xx on the ack is an id Delta does not hold — nothing to retire. Anything
 * else is retried on the next beat, which (at 10 s) comes before the 30 s ttl
 * the first ack set can run out.
 */
export function retireDxHeartbeat(deps: {
  readonly rest: Pick<DxRest, 'heartbeatAck'>
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}): DxHeartbeatRetirer {
  let retired = false
  let running = false
  return {
    get retired(): boolean {
      return retired
    },
    async beat(): Promise<void> {
      if (retired || running) return
      running = true
      try {
        await deps.rest.heartbeatAck(DX_HEARTBEAT_TTL_MS)
        const off = await deps.rest.heartbeatAck(0)
        if (off.process_enabled === false || off.process_enabled === 'false') {
          retired = true
          deps.log('DX HEARTBEAT RETIRED — Delta will not cancel orders (or the backstops) when this process stops')
        } else {
          deps.log('DX HEARTBEAT RETIRE: Delta still reports the switch enabled — retrying', { answer: off.process_enabled })
        }
      } catch (err) {
        if (err instanceof DxApiError && err.status >= 400 && err.status < 500) {
          retired = true
          deps.log('DX HEARTBEAT RETIRE: Delta holds no such heartbeat — nothing to switch off', { error: msgOf(err) })
        } else {
          deps.log('DX HEARTBEAT RETIRE FAILED — retrying on the next beat', { error: msgOf(err) })
        }
      } finally {
        running = false
      }
    },
  }
}
