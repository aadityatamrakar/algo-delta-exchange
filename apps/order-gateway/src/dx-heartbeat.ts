/**
 * DELTA'S DEAD-MAN SWITCH, while live (spec §8).
 *
 * `create` registers a heartbeat that makes Delta cancel every open BTC option
 * order once an ack is missed; each `ack` renews it for `ttl`. Acked every 10 s
 * with a 30 s ttl, so two missed beats are tolerated and a dead gateway stops
 * quoting within 30 s. Positions are not closed by Delta — only orders.
 *
 * NEVER THROWS: a beat that failed is said and retried on the next one. The
 * caller owns the timer.
 */
import type { DxRest } from '@algomaker/dx'

export const DX_HEARTBEAT_MS = 10_000
export const DX_HEARTBEAT_TTL_MS = 30_000

export interface DxHeartbeat {
  /** One beat: create until it succeeds, ack after. */
  beat(): Promise<void>
  /** False after a failed beat, until the next one lands. */
  readonly healthy: boolean
}

export function createDxHeartbeat(deps: {
  readonly rest: Pick<DxRest, 'heartbeat'>
  readonly ttlMs?: number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}): DxHeartbeat {
  const ttl = deps.ttlMs ?? DX_HEARTBEAT_TTL_MS
  let created = false
  let healthy = false
  let running = false
  return {
    get healthy(): boolean {
      return healthy
    },
    async beat(): Promise<void> {
      if (running) return
      running = true
      const op = created ? 'ack' : 'create'
      try {
        await deps.rest.heartbeat(op, ttl)
        if (!created) deps.log('DX HEARTBEAT armed — Delta cancels open orders if this process stops acking', { ttlMs: ttl })
        created = true
        healthy = true
      } catch (err) {
        healthy = false
        deps.log(`DX HEARTBEAT ${op} FAILED — Delta will cancel open orders when the ttl runs out`, {
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        running = false
      }
    },
  }
}
