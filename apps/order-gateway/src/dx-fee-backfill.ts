/**
 * DELTA'S COMMISSION, PUT ON AFTER THE FACT (13 / 20 Nov: one leg of each demo
 * straddle booked with no fee).
 *
 * `awaitDeltaFee` waits a few seconds for Delta's `/v2/fills` to list an
 * order's fill before the update is recorded. An order that finished without
 * one anyway is picked up here, every minute: once the fills Delta lists for
 * its broker orders COVER its filled quantity, their summed commission is set
 *
 *   - on the order document's `fee` (what the paper fold books from),
 *   - on its fill rows that carry none (`desk-fills`),
 *   - on the one fill of its folded decision (`desk-decisions`) for the same
 *     contract that carries none — the record P&L is read from.
 *
 * Only ever where there is no fee yet: nothing written is overwritten. Never a
 * guess: a partial listing waits for the next pass.
 */
import type { deltaCommission } from './dx-edge.ts'

type Rest = Parameters<typeof deltaCommission>[0]

export interface FeeBackfillPorts {
  /** Finished Delta orders (live, or the demo rail) that traded and carry no `fee`. */
  readonly pendingOrders: () => Promise<readonly Record<string, unknown>[]>
  /** The REST client of the rail the order was worked on; null when that rail is not up. */
  readonly restFor: (order: Record<string, unknown>) => Rest | null
  readonly setOrderFee: (clientOrderId: string, fee: number) => Promise<void>
  /** Set `fee` on the order's fill rows for this broker order that have none. */
  readonly setFillFee: (baseClientOrderId: string, brokerOrderId: string, fee: number) => Promise<void>
  readonly decisionFor: (
    clientOrderId: string,
  ) => Promise<{ readonly decisionId: string; readonly fills: readonly Record<string, unknown>[] } | null>
  readonly setDecisionFillFee: (decisionId: string, index: number, fee: number) => Promise<void>
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

const STEP = 0.001
const r8 = (x: number): number => Number(x.toFixed(8))

/** One pass. Never throws for one bad order; it is retried next pass. */
export async function backfillDeltaFees(ports: FeeBackfillPorts): Promise<{ orders: number; filled: number }> {
  const orders = await ports.pendingOrders()
  let filled = 0
  for (const o of orders) {
    const base = String(o['clientOrderId'] ?? '')
    try {
      const rest = ports.restFor(o)
      if (rest === null) continue
      const ids = (Array.isArray(o['brokerOrderIds']) ? o['brokerOrderIds'] : []).map(String).filter((x) => x !== '')
      if (ids.length === 0) continue
      const want = Math.round(Number(o['filledQty'] ?? 0) / STEP)
      // One broker order per tranche. Together their listed fills must COVER
      // what the order filled; any order not listed at all, and nothing is set.
      const { fills } = await rest.fills()
      let total = 0
      let size = 0
      const perOrder: [string, number][] = []
      for (const id of ids) {
        const mine = fills.filter((f) => String(f.order_id ?? '') === id)
        if (mine.length === 0) break
        let fee = 0
        for (const f of mine) {
          const c = Number(f.commission)
          const n = Number(f.size)
          if (!Number.isFinite(c)) throw new Error(`Delta listed a fill of ${id} with no readable commission`)
          fee += c
          if (Number.isFinite(n)) size += n
        }
        perOrder.push([id, r8(fee)])
        total += fee
      }
      if (perOrder.length !== ids.length || size < want) continue
      const fee = r8(total)
      await ports.setOrderFee(base, fee)
      for (const [id, f] of perOrder) await ports.setFillFee(base, id, f)
      const decision = await ports.decisionFor(base)
      if (decision !== null) {
        const sym = String(o['tradingsymbol'] ?? '')
        const open = decision.fills
          .map((f, i) => ({ f, i }))
          .filter(({ f }) => f['tradingsymbol'] === sym && typeof f['fee'] !== 'number')
        // Exactly one fill on that contract without a fee, or none touched: two
        // would be a guess about which one this order is.
        if (open.length === 1) await ports.setDecisionFillFee(decision.decisionId, (open[0] as { i: number }).i, fee)
      }
      filled++
      ports.log('DX FEE BACKFILLED — Delta listed the fill after the order finished', { clientOrderId: base, fee })
    } catch (err) {
      ports.log('dx fee backfill failed for one order — retried next pass', {
        clientOrderId: base,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { orders: orders.length, filled }
}

// ------------------------------------------------------------ Mongo wiring

interface Coll {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>
}

/** How far back the backfill looks: a day of finished orders. */
export const DX_FEE_BACKFILL_LOOKBACK_MS = 24 * 60 * 60_000
export const DX_FEE_BACKFILL_MS = 60_000

export function mongoFeeBackfillPorts(deps: {
  readonly orders: Coll
  readonly fills: Coll
  readonly decisions: Coll
  readonly restFor: (order: Record<string, unknown>) => Rest | null
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}): FeeBackfillPorts {
  return {
    pendingOrders: async () =>
      await deps.orders
        .find({
          state: { $in: ['FILLED', 'PARTIAL', 'HALTED'] },
          filledQty: { $gt: 0 },
          fee: { $exists: false },
          resolvedAt: { $gte: deps.now() - DX_FEE_BACKFILL_LOOKBACK_MS },
          $or: [{ mode: 'live' }, { dx_paper_rail: 'demo' }],
        })
        .toArray(),
    restFor: deps.restFor,
    setOrderFee: async (clientOrderId, fee) => {
      await deps.orders.updateOne({ clientOrderId, fee: { $exists: false } }, { $set: { fee } })
    },
    setFillFee: async (base, brokerOrderId, fee) => {
      await deps.fills.updateMany(
        { baseClientOrderId: base, brokerOrderId, filledQty: { $gt: 0 }, fee: { $exists: false } },
        { $set: { fee } },
      )
    },
    decisionFor: async (clientOrderId) => {
      const decisionId = clientOrderId.split('#')[0] ?? ''
      if (decisionId === '' || decisionId === clientOrderId) return null
      const d = await deps.decisions.findOne({ decisionId, foldedOrders: clientOrderId })
      if (d === null) return null
      return { decisionId, fills: (Array.isArray(d['fills']) ? d['fills'] : []) as Record<string, unknown>[] }
    },
    setDecisionFillFee: async (decisionId, index, fee) => {
      await deps.decisions.updateOne(
        { decisionId, [`fills.${index}.fee`]: { $exists: false } },
        { $set: { [`fills.${index}.fee`]: fee } },
      )
    },
    log: deps.log,
  }
}
