/**
 * TAKING A PACKAGE BACK OFF THE MARKET — the cancel half of spec §8's "guards
 * always preempt working orders (cancel first, then act)".
 *
 * The supervisor knows a `decisionId`; the broker knows order ids. This file is
 * the join, and it is deliberately the only place in this process that knows a
 * gateway order document exists.
 *
 * ── IT ASKS desk-api, IT DOES NOT CANCEL ────────────────────────────────────
 * `POST /v1/desk/broker/orders/:id/cancel` records a REQUEST; the order-gateway
 * performs it, because that process owns the XTS session and a second session
 * here would share the one token document and could invalidate the gateway's
 * mid-order (`routes/desk.ts`). The paper drain does the same for a simulated
 * order. So this returns "how many cancels were REQUESTED", never "how many
 * orders were cancelled" — the honest thing, since the endpoint answers 202.
 *
 * ── WHICH ID, AND WHY NOT ALL OF THEM ───────────────────────────────────────
 * A desk order accumulates one `brokerOrderIds` entry per tranche as the fill
 * gate releases them, newest LAST. Only the newest can still be working: the
 * gate places the next tranche only when the previous is terminal. Cancelling
 * every id in the array would file a cancel against tranches that have already
 * filled, and each of those comes back `CANCEL FAILED` on the Broker page —
 * telling an operator something went wrong when nothing did. One id per
 * non-terminal desk order is the precise act.
 *
 * ── THE JOIN IS THE WRITER'S OWN SPLIT ──────────────────────────────────────
 * `clientOrderId` is `<decisionId>#<i>[.<tranche>]` and `splitOrderId` is the
 * shared reader for it (`reconcile-live.ts`). Matching by prefix instead would
 * disagree with the writer the first time a tag contains a `#` or a `.` — which
 * is exactly the defect that reader documents.
 *
 * ── FAILURE IS PARTIAL, COUNTED, AND SAID ───────────────────────────────────
 * One order that will not cancel must not stop the rest — but the caller has to
 * be able to tell a clean sweep from a partial one. So `requested` is what
 * really went out, `failed` is what did not, `unplaced` is what is not at the
 * broker right now, and `asked` names the ids filed. The host sweeps every pass
 * and skips the ids it has asked about recently, so a refused one is simply
 * filed again next pass. (It used to LATCH per decision, and that latch is what
 * left 2026-10-01's hedge close resting — see `CancelOutcome`.)
 *
 * A read that throws propagates: the host treats an unknown cancel as NOT done.
 */

import { NON_TERMINAL_STATES, splitOrderId } from '../../api/src/reconcile-live.ts'
import { COLLECTIONS } from '../../api/src/store.ts'
import type { Mode } from '@algomaker/desk-engine'
import type { CancelOutcome, HostLog } from './engine-host.ts'

/** The one collection this reads. Both rails' engine orders live here. */
export const GATEWAY_ORDERS_COLLECTION = COLLECTIONS.gatewayOrders

/** The narrow Mongo surface: one query shape. */
export interface OrdersCollection {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
}

export interface WorkingOrdersDeps {
  readonly collection: OrdersCollection
  /**
   * `POST /v1/desk/broker/orders/:id/cancel`. Throwing means the request did
   * not land — the caller counts it as not cancelled and says so.
   */
  cancel(brokerOrderId: string): Promise<void>
  readonly log: HostLog
}

/** The newest broker order id on a document, or `''` when it has none. */
function newestBrokerOrderId(doc: Record<string, unknown>): string {
  const ids = doc['brokerOrderIds']
  if (!Array.isArray(ids)) return ''
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    if (typeof id === 'string' && id !== '') return id
  }
  return ''
}

/**
 * Cancel every order still working under one decision, for one book.
 *
 * The returned function is what `EngineHost.cancelWorking` is wired to; bind it
 * per (tag, mode) so a paper package can never reach a live order id.
 *
 * `skip` is the broker ids the host asked about recently. The host sweeps EVERY
 * pass while it wants the package gone (it no longer latches a decision), so
 * this is what keeps a sweep from re-filing the same cancel each second. The
 * ids actually filed come back in `asked`.
 *
 * ONLY A `PLACED` ORDER IS CANCELLABLE. Anything else not yet terminal —
 * PENDING, CLAIMED — is `unplaced`, including a CLOSE the gateway is advancing
 * between tranches: `advanceTranche` re-queues it PENDING with the finished
 * tranche's broker id still on it, and a cancel filed against that id reaches a
 * terminal order while the next tranche goes out and rests.
 */
export function workingOrderCanceller(
  deps: WorkingOrdersDeps,
  tag: string,
  mode: Mode,
): (decisionId: string, skip?: ReadonlySet<string>) => Promise<CancelOutcome> {
  return async (decisionId: string, skip: ReadonlySet<string> = new Set()): Promise<CancelOutcome> => {
    const docs = await deps.collection
      .find({ tag, mode, state: { $in: NON_TERMINAL_STATES } })
      .toArray()

    const ids: string[] = []
    let unplaced = 0
    for (const doc of docs) {
      const clientOrderId = String(doc['clientOrderId'] ?? '')
      if (splitOrderId(clientOrderId).decisionId !== decisionId) continue
      const state = String(doc['state'] ?? '')
      const brokerOrderId = newestBrokerOrderId(doc)
      if (state !== 'PLACED' || brokerOrderId === '') {
        // Not at the broker right now: claimed and not yet placed, or a close
        // between two tranches. Nothing to cancel THIS pass — but it is about to
        // reach the broker and rest there, so it is COUNTED and the host sweeps
        // again next pass. Debug, not warn: the host asks every second.
        unplaced += 1
        deps.log.debug('a working order is not placed right now — nothing to cancel this pass', {
          tag,
          mode,
          decisionId,
          clientOrderId,
          state,
        })
        continue
      }
      if (skip.has(brokerOrderId)) continue
      ids.push(brokerOrderId)
    }

    const asked: string[] = []
    let failed = 0
    let lastError: unknown = null
    for (const id of ids) {
      try {
        await deps.cancel(id)
        asked.push(id)
      } catch (err) {
        failed += 1
        lastError = err
        // Partial and SAID. Not in `asked`, so the next pass files it again.
        deps.log.error('a cancel request could not be filed — that order is STILL WORKING', {
          tag,
          mode,
          decisionId,
          brokerOrderId: id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    /**
     * NOTHING GOT THROUGH AT ALL: throw, so the host says so at ERROR. A partial
     * sweep comes back as a COUNT instead, with the ids that did go in `asked`.
     */
    if (asked.length === 0 && lastError !== null) throw lastError
    return { requested: asked.length, failed, unplaced, asked }
  }
}
