/**
 * THE FEE FOR THE QUANTITY BEING BOOKED, off the gateway's terminal document —
 * shared by the two writers that put a gateway fill onto `desk-decisions`, the
 * record every P&L figure reads: `paper-fold.ts` (paper and the Delta testnet)
 * and `reconcile-live.ts` (live). Its own module because `paper-fold.ts`
 * imports `reconcile-live.ts`, and a fee rule must not be the reason for a
 * cycle.
 *
 * The document's own `fee` total when it has one, else the sum of its fill
 * rows' `fee`. When the desk books less than the gateway reported (a clamp),
 * the fee is cut in the same proportion — the desk pays for what it books.
 * `undefined` when nothing on the document is a fee: an NSE order, whose fill
 * must not grow a `fee: 0` key it never had.
 */
export function foldedFee(doc: Record<string, unknown>, bookedQty: number, reportedQty: number): number | undefined {
  const asFee = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  let total = asFee(doc['fee'])
  if (total === undefined) {
    const rows = Array.isArray(doc['fills']) ? (doc['fills'] as unknown[]) : []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const f = asFee((row as Record<string, unknown>)['fee'])
      if (f !== undefined) total = (total ?? 0) + f
    }
  }
  if (total === undefined) return undefined
  const share = reportedQty > 0 && bookedQty < reportedQty ? bookedQty / reportedQty : 1
  return Number((total * share).toFixed(8))
}
