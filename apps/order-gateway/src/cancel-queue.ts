/**
 * CANCELLING A BROKER ORDER, from the desk instead of a hand-rolled curl.
 *
 * On 2026-07-30 a smoke-test order rested at the broker and there was no way to
 * kill it from here: the adapter has `cancelOrder`, but nothing exposed it. The
 * raw curl that stood in for it failed with `e-orders-0002 ClientID cannot be
 * empty`, because this is a DEALER account.
 *
 * THE CLIENT ID COMES FROM THE ORDER ROW, not from configuration. That is how
 * the legacy `xts-account.js:523` did it, and it is the more robust source: the
 * order carries the client it was placed for, so a multi-client dealer account
 * cancels each order against the right one without any lookup. It also carries
 * `OrderUniqueIdentifier`, which the legacy sent too.
 *
 * WHY A QUEUE. desk-api serves the dashboard but has no XTS session; the
 * gateway owns it and is documented as the only process that may place orders.
 * A second session in desk-api would share the one token document and the two
 * could invalidate each other mid-order. So desk-api records the REQUEST and
 * the gateway performs it — the same split `desk-gateway-orders` already uses
 * for placements.
 */

/** Terminal states, per the legacy's own list (`xts-account.js:509`). */
export const CLOSED_ORDER_STATUS: readonly string[] = [
  'Filled',
  'Replaced',
  'Cancelled',
  'Rejected',
]

/** Is this order still live at the broker, i.e. worth cancelling? */
export function isCancellable(row: Record<string, unknown>): boolean {
  return !CLOSED_ORDER_STATUS.includes(String(row['OrderStatus'] ?? ''))
}

export interface CancelRequest {
  /** `AppOrderID` as a string; the collection `_id`, so a repeat is idempotent. */
  readonly _id: string
  readonly requestedAt: number
  readonly status: 'pending' | 'done' | 'failed'
  readonly requestedBy?: string
  readonly finishedAt?: number
  readonly error?: string
}

/** The XTS surface a cancel needs. */
export interface CancelClient {
  cancelOrder(req: Record<string, unknown>): Promise<{ type?: string; error?: { message?: string } }>
  getOrderBook?(req?: Record<string, unknown>): Promise<{ result?: unknown }>
}

export interface CancelOutcome {
  readonly ok: boolean
  readonly error: string
}

/**
 * Cancel one order, looking it up in `orders` to source `clientID` and
 * `orderUniqueIdentifier` from the row itself.
 *
 * An order that is not in the book, or is already terminal, is reported as
 * ALREADY GONE rather than as a failure — cancelling something that no longer
 * exists is the desired end state, and calling it an error trains an operator
 * to ignore the result.
 *
 * Never throws: the caller is a poll loop.
 */
export async function cancelBrokerOrder(
  client: CancelClient,
  orders: readonly Record<string, unknown>[],
  appOrderId: string,
): Promise<CancelOutcome> {
  const row = orders.find((o) => String(o['AppOrderID'] ?? '') === String(appOrderId))
  if (row === undefined) {
    return { ok: true, error: `order ${appOrderId} is not in the broker's book — already gone` }
  }
  if (!isCancellable(row)) {
    return {
      ok: true,
      error: `order ${appOrderId} is already ${String(row['OrderStatus'])} — nothing to cancel`,
    }
  }

  const req: Record<string, unknown> = { appOrderID: row['AppOrderID'] }
  // Both sourced from the ORDER, exactly as the legacy did. Omitted rather than
  // sent empty when absent: `clientID: ''` is what produced e-orders-0002.
  if (row['ClientID'] !== undefined && String(row['ClientID']) !== '') {
    req['clientID'] = row['ClientID']
  }
  if (row['OrderUniqueIdentifier'] !== undefined) {
    req['orderUniqueIdentifier'] = row['OrderUniqueIdentifier']
  }

  try {
    const resp = await client.cancelOrder(req)
    const message = resp.error?.message ?? ''
    if (message !== '') return { ok: false, error: message }
    return { ok: true, error: '' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
