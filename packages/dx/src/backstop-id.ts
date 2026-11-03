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

export const DX_BACKSTOP_PREFIX = 'bkstp'

export function backstopClientOrderId(rail: 'live' | 'demo', tag: string, symbol: string): string {
  const h = createHash('sha256').update(`${rail}|${tag}|${symbol}`).digest('base64url')
  return DX_BACKSTOP_PREFIX + h.slice(0, 32 - DX_BACKSTOP_PREFIX.length)
}

export function isBackstopOrderId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DX_BACKSTOP_PREFIX)
}
