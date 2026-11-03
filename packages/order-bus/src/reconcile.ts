/**
 * Compare local WAL-derived state to a broker snapshot.
 *
 * Needed twice:
 *   1. restart recovery — the legacy system could not do this at all, because
 *      positions lived only in process memory;
 *   2. cutover rollback — the legacy stack resumes knowing nothing about resting
 *      SL/target orders the new stack placed at the broker (spec 8.5).
 *
 * Pure: takes snapshots, returns divergences. Fetching them is the caller's job,
 * which keeps every divergence class testable without a broker.
 */
import type { WalRecord } from './types.ts'
import { unresolvedIntents } from './wal.ts'

export interface BrokerPosition {
  readonly tradingsymbol: string
  /** Signed: positive long, negative short. */
  readonly netQty: number
  readonly avgPrice: number
}

export interface BrokerOrder {
  readonly brokerOrderId: string
  /** Null when the broker has no record of our idempotency key. */
  readonly clientOrderId: string | null
  readonly tradingsymbol: string
  readonly status: string
  readonly filledQty: number
}

export type Divergence =
  | { readonly kind: 'UNKNOWN_BROKER_POSITION'; readonly tradingsymbol: string; readonly brokerQty: number }
  | { readonly kind: 'MISSING_BROKER_POSITION'; readonly tradingsymbol: string; readonly expectedQty: number }
  | { readonly kind: 'QTY_MISMATCH'; readonly tradingsymbol: string; readonly expectedQty: number; readonly brokerQty: number }
  | { readonly kind: 'ORPHAN_BROKER_ORDER'; readonly brokerOrderId: string; readonly tradingsymbol: string }
  | { readonly kind: 'UNRESOLVED_INTENT'; readonly clientOrderId: string }

/** Net quantity per symbol implied by FILLED records in the journal. */
function expectedPositions(records: readonly WalRecord[]): Map<string, number> {
  const bySymbol = new Map<string, number>()
  const intents = new Map<string, { symbol: string; side: 'BUY' | 'SELL' }>()

  for (const r of records) {
    if (r.kind === 'INTENT') {
      intents.set(r.intent.clientOrderId, {
        symbol: r.intent.instrument.tradingsymbol,
        side: r.intent.side,
      })
    }
  }

  // filledQty on a STATUS record is a CUMULATIVE snapshot (mirrors
  // OrderState.filledQty), not a delta — one record arrives per onOrderUpdate
  // from the XTS feed. So a tranche fill (WORKING -> PARTIALLY_FILLED(10) ->
  // PARTIALLY_FILLED(20) -> FILLED(25)) must contribute ONE net quantity per
  // order (the LAST, i.e. highest-ts, record) — never a sum over every record.
  const lastStatusByOrder = new Map<string, Extract<WalRecord, { kind: 'STATUS' }>>()
  for (const r of records) {
    if (r.kind !== 'STATUS') continue
    if (r.status !== 'FILLED' && r.status !== 'PARTIALLY_FILLED') continue
    const prev = lastStatusByOrder.get(r.clientOrderId)
    if (prev === undefined || r.ts >= prev.ts) lastStatusByOrder.set(r.clientOrderId, r)
  }

  for (const r of lastStatusByOrder.values()) {
    const meta = intents.get(r.clientOrderId)
    if (meta === undefined) continue
    const signed = meta.side === 'BUY' ? r.filledQty : -r.filledQty
    bySymbol.set(meta.symbol, (bySymbol.get(meta.symbol) ?? 0) + signed)
  }
  // Drop flat symbols — a net-zero symbol is not an expected position.
  for (const [k, v] of [...bySymbol]) if (v === 0) bySymbol.delete(k)
  return bySymbol
}

export function reconcile(
  records: readonly WalRecord[],
  positions: readonly BrokerPosition[],
  orders: readonly BrokerOrder[],
): Divergence[] {
  const out: Divergence[] = []
  const expected = expectedPositions(records)
  const broker = new Map(positions.map((p) => [p.tradingsymbol, p.netQty]))

  for (const [symbol, expectedQty] of expected) {
    const brokerQty = broker.get(symbol)
    if (brokerQty === undefined) {
      out.push({ kind: 'MISSING_BROKER_POSITION', tradingsymbol: symbol, expectedQty })
    } else if (brokerQty !== expectedQty) {
      out.push({ kind: 'QTY_MISMATCH', tradingsymbol: symbol, expectedQty, brokerQty })
    }
  }

  for (const [symbol, brokerQty] of broker) {
    if (brokerQty === 0) continue
    if (!expected.has(symbol)) {
      out.push({ kind: 'UNKNOWN_BROKER_POSITION', tradingsymbol: symbol, brokerQty })
    }
  }

  const known = new Set<string>()
  for (const r of records) if (r.kind === 'INTENT') known.add(r.intent.clientOrderId)
  for (const o of orders) {
    const isOurs = o.clientOrderId !== null && known.has(o.clientOrderId)
    if (!isOurs) {
      out.push({ kind: 'ORPHAN_BROKER_ORDER', brokerOrderId: o.brokerOrderId, tradingsymbol: o.tradingsymbol })
    }
  }

  for (const id of unresolvedIntents(records)) {
    out.push({ kind: 'UNRESOLVED_INTENT', clientOrderId: id })
  }
  return out
}
