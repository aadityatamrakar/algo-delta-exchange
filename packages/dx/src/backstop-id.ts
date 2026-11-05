/**
 * THE EXCHANGE-BACKSTOP ID — one contract shared by the gateway that rests the
 * stops (`apps/order-gateway/src/dx-backstop.ts`), the watchdog that checks
 * them, and the flatten runbook.
 *
 * `bkstp` + a hash of (rail, book, contract): 32 chars of `[A-Za-z0-9_-]`,
 * deterministic, and never a desk id — `dxClientOrderId` passes a desk id
 * through only when it is ≤ 32 chars of that charset (desk ids carry `|`) and
 * otherwise hashes it to `h…`.
 */
import { createHash } from 'node:crypto'
import type { DxOrder } from './types.ts'

export const DX_BACKSTOP_PREFIX = 'bkstp'

export function backstopClientOrderId(rail: 'live' | 'demo', tag: string, symbol: string): string {
  const h = createHash('sha256').update(`${rail}|${tag}|${symbol}`).digest('base64url')
  return DX_BACKSTOP_PREFIX + h.slice(0, 32 - DX_BACKSTOP_PREFIX.length)
}

export function isBackstopOrderId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DX_BACKSTOP_PREFIX)
}

/**
 * A stop-loss rested on Delta that is NOT a desk backstop — the operator's
 * own, set by hand in Delta's app on a leg they sold there. A reduce-only buy
 * stop protects a short exactly as a backstop does, so the cover checks count
 * it. A take-profit (fires as the price falls) or a plain resting buy does not.
 * The desk never places, moves or cancels one.
 */
export function isManualStop(o: DxOrder): boolean {
  return o.side === 'buy' && o.reduce_only === true && o.stop_order_type === 'stop_loss_order' && !isBackstopOrderId(o.client_order_id)
}

/** Contracts a protecting order still covers: a resting stop its size; a triggered one what is left to fill. */
export function coverOf(o: DxOrder): number {
  return o.state === 'pending' ? o.size : o.unfilled_size
}
