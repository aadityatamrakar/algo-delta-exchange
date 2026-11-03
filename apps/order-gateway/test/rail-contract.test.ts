import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gatewayOrderDocument, orderDocument, routedCollection } from '../../api/src/rail.ts'
import type { Fill } from '../../api/src/contract.ts'
import { OrderQueue, type QueueCollection } from '../src/queue.ts'
import { baseClientOrderId } from '../src/gateway.ts'

/**
 * THE CONTRACT BETWEEN THE RAIL AND THIS GATEWAY, asserted from the gateway's
 * side because that is the side that breaks.
 *
 * `apps/api/src/rail.ts` writes the order documents; the gateway claims them,
 * keys every state transition on `clientOrderId`, and `submit.ts`'s stale-
 * `ROUTING` reconcile joins on that same field
 * (`submit.ts:772 findOne({clientOrderId: order.clientOrderId})`). Nothing
 * anywhere tested that the written document HAS the field — `grep -rn
 * "orderDocument\|gatewayOrderDocument" apps/api/test packages/*​/test` returned
 * nothing — so dropping or renaming it would leave every reconcile answering
 * "nothing routed" for orders sitting live at the broker, which is the one
 * answer that talks a caller into re-routing them.
 *
 * The writers are NOT edited from here; this only pins their shape.
 */

const fill: Fill = {
  tradingsymbol: 'NIFTY26AUG25000CE',
  side: 'Buy' as const,
  qty: 2250,
  price: 106,
  op: 'open',
  deskTag: 'leg-1',
  ts: 1_700_000_000_000,
}

const ctx = {
  tag: 'DESK_NIFTY',
  underlying: 'NIFTY',
  instrument: {
    tradingsymbol: 'NIFTY26AUG25000CE',
    instrumentToken: 12345,
    lotSize: 75,
    tickSize: 0.05,
    exchange: 'NFO',
  },
  nowMs: 1_700_000_000_000,
  clientOrderId: 'sub-9#0',
}

test('the gateway order document CARRIES clientOrderId', async () => {
  const doc = gatewayOrderDocument(fill, ctx)
  assert.equal(doc['clientOrderId'], 'sub-9#0')
  // The queue's unique index is on this field, and it is what makes a retried
  // decision a no-op rather than a second broker order.
  assert.equal(typeof doc['clientOrderId'], 'string')
  assert.notEqual(doc['clientOrderId'], '')
})

test('the order document carries the instrument’s OWN tick size', () => {
  // The chaser rounds every reprice onto a tick grid and, until this field
  // existed, assumed NFO's 0.05 for everything — `order-chaser.ts` said so out
  // loud ("no doc writer stamps a tick today"). Peg mode makes that assumption
  // expensive: a passive order joining the touch on the wrong grid rounds
  // itself off the market. Omitted rather than zeroed when unknown.
  assert.equal(gatewayOrderDocument(fill, ctx)['tickSize'], 0.05)
  const noTick = { ...ctx, instrument: { ...ctx.instrument, tickSize: 0 } }
  assert.equal('tickSize' in gatewayOrderDocument(fill, noTick), false)
})

test('the order document carries the BOOK’S EXECUTION DIALS', () => {
  /**
   * Three fields, three readers in this app, and none of them can recover the
   * value from anywhere else:
   *
   *   `trancheLots`          → `gateway.ts:planTranches`, which decides how much
   *                            of a large order the market is shown at a time;
   *   `chaseMaxMs`           → `order-chaser.ts:580`, the peg deadline;
   *   `chaseCrossBufferPct`  → `order-chaser.ts:577`, the one reach across.
   *
   * The chaser has read the last two off the document since peg mode shipped
   * and NOTHING has ever written them, so every passive order took the env
   * default while the book's own dial sat unread. Pinned from the gateway's
   * side because the gateway is the side that breaks.
   */
  const worked: Fill = {
    ...fill,
    workMode: 'passive',
    trancheLots: 3,
    chaseMaxMs: 20_000,
    chaseCrossBufferPct: 0.004,
  }
  const doc = gatewayOrderDocument(worked, ctx)
  assert.equal(doc['trancheLots'], 3)
  assert.equal(doc['chaseMaxMs'], 20_000)
  assert.equal(doc['chaseCrossBufferPct'], 0.004)
  assert.equal(doc['workMode'], 'passive')
})

test('a fill with no dials writes NO dial keys — absent, never zero', () => {
  // A `trancheLots: 0` reads as "slice into nothing" and a `chaseMaxMs: 0` as
  // "cross immediately". Both are decisions; neither was made.
  const doc = gatewayOrderDocument(fill, ctx)
  for (const k of ['trancheLots', 'chaseMaxMs', 'chaseCrossBufferPct', 'workMode']) {
    assert.equal(k in doc, false, `${k} must be absent when nobody chose it`)
  }
})

test('the PAPER document carries it too — the reconcile probes either collection', () => {
  // `submit.ts` picks the collection by mode and joins on the same key, so a
  // paper submission whose record went missing must be answerable as well.
  assert.equal(orderDocument(fill, ctx)['clientOrderId'], 'sub-9#0')
})

/**
 * WHICH COLLECTION AN ORDER LANDS IN, pinned from the side that has to find it
 * (D14, plan Task 18).
 *
 * `routedCollection` is read twice and by two different people: `PaperRail`
 * picks its target with it, and `service.#resolveRouting` — the crash-recovery
 * probe — asks it where to go looking. A reader that disagreed with the writer
 * would find nothing and report a routed order as LOST, which is the one answer
 * that talks a caller into routing it a second time.
 */
test('an ENGINE paper order lands in the queue this gateway claims from', () => {
  const paper = { mode: 'paper' as const, collection: 'desk-paper-trade' }
  assert.equal(routedCollection(paper, 'engine'), 'desk-gateway-orders')
  // Everything else keeps the instant-fill rail: the manual box, the runner,
  // close-all. A rehearsal lifecycle is the supervisor's to opt into.
  assert.equal(routedCollection(paper), 'desk-paper-trade')
  assert.equal(routedCollection(paper, undefined), 'desk-paper-trade')
})

test('the LIVE rail is unmoved by the flag — it has exactly one collection', () => {
  // A `via` that could redirect a LIVE order is a `via` that could send one
  // somewhere the executor is not watching, or somewhere two executors are.
  const live = { mode: 'live' as const, collection: 'desk-gateway-orders' }
  assert.equal(routedCollection(live, 'engine'), 'desk-gateway-orders')
  assert.equal(routedCollection(live), 'desk-gateway-orders')
  const legacy = { mode: 'live' as const, collection: 'positional' }
  assert.equal(routedCollection(legacy, 'engine'), 'positional')
})

test('the gateway can actually claim what the rail writes', async () => {
  // The two halves were once written to different contracts: without `state`
  // and `createdAt`, claimNext() matches nothing and orders pile up while the
  // gateway looks healthy.
  const doc = gatewayOrderDocument(fill, ctx)
  const docs: Record<string, unknown>[] = [{ ...doc }]
  const collection: QueueCollection = {
    find: (f) => ({
      sort: () => ({
        limit: (n: number) => ({
          toArray: async () =>
            docs.filter((d) => Object.entries(f).every(([k, v]) => d[k] === v)).slice(0, n),
        }),
      }),
    }),
    findOne: async (f) =>
      docs.find((d) => Object.entries(f).every(([k, v]) => d[k] === v)) ?? null,
    findOneAndUpdate: async (f, u) => {
      const or = (f['$or'] as Record<string, unknown>[] | undefined) ?? [f]
      const d = docs.find((doc2) => or.some((c) => Object.entries(c).every(([k, v]) => typeof v === 'object' ? true : doc2[k] === v)))
      if (d === undefined) return { value: null }
      Object.assign(d, u['$set'] as Record<string, unknown>)
      return { value: d }
    },
    updateOne: async (f, u) => {
      const d = docs.find((doc2) => Object.entries(f).every(([k, v]) => doc2[k] === v))
      if (d !== undefined) Object.assign(d, u['$set'] as Record<string, unknown>)
    },
    createIndex: async () => undefined,
  }
  const q = new OrderQueue({ collection, workerId: 'w', now: () => 2_000 })

  const claimed = await q.claimNext()
  assert.equal(claimed?.['clientOrderId'], 'sub-9#0', 'the rail writes state:PENDING for this')
  assert.equal(claimed?.['tradingsymbol'], 'NIFTY26AUG25000CE')
  assert.equal(claimed?.['quantity'], 2250)
  assert.equal(claimed?.['tag'], 'DESK_NIFTY')

  // And every state transition keys on the SAME field the reconcile joins on.
  await q.markTerminal('sub-9#0', 'FILLED', { filledQty: 2250, avgPrice: 106 })
  assert.equal(docs[0]?.['state'], 'FILLED')
  assert.equal((await q.get('sub-9#0'))?.['avgPrice'], 106)
})

test("a tranche of a submit id keeps the submit id as its base", () => {
  // The API splits into `<coid>#<i>` and the gateway then splits THAT into
  // `.1`/`.2`. The reconcile joins on the API's id, so the tranche suffix must
  // be the only thing stripped.
  const doc = gatewayOrderDocument(fill, ctx)
  assert.equal(baseClientOrderId(`${String(doc['clientOrderId'])}.2`), 'sub-9#0')
})

test('the underlying is carried, so the gateway does not have to guess it', () => {
  // `deriveUnderlying` cannot distinguish NIFTYNXT50 from NIFTYNXT + digits.
  assert.equal(gatewayOrderDocument(fill, ctx)['underlying'], 'NIFTY')
})

/**
 * THE QUEUE DOCUMENT IS AN ORDER, NOT A FILL (2026-10-01).
 *
 * `orderDocument` is the legacy positional shape — `status: 'COMPLETE'`,
 * `filled_quantity: qty`, `price: <mark>` — and on the two collections it was
 * written for that is the truth: a `desk-paper-trade` row IS a booked fill, and
 * `xtsOrder.js` reads exactly those keys off `positional`. Spread into the
 * gateway's queue document it is a claim made at ENQUEUE, before anything has
 * traded, sitting beside the gateway's own lifecycle (`state`, `filledQty`,
 * `avgPrice`). `SENSEX-delta-lean-aggressive-2026-10-01:paper:5#4` therefore
 * read "COMPLETE, 80 filled @ 149.15" with `state: REJECTED, filledQty: 0`
 * right next to it — and was read as a fill the desk had lost.
 */
test('the gateway queue document claims no fill — the mark it was planned at is markPrice', async () => {
  const doc = gatewayOrderDocument(fill, ctx)
  for (const k of ['status', 'filled_quantity', 'price']) {
    assert.equal(k in doc, false, `${k} is a fill field; nothing has filled at enqueue`)
  }
  assert.equal(doc['markPrice'], 106, 'the decision-time mark is kept, under a name that is not a fill')
  assert.equal(doc['quantity'], 2250, 'what was ASKED stays')

  // And once the gateway says REJECTED, no field on the document says otherwise.
  const docs: Record<string, unknown>[] = [{ ...doc }]
  const collection = {
    updateOne: async (_f: Record<string, unknown>, u: Record<string, unknown>) => {
      Object.assign(docs[0]!, u['$set'] as Record<string, unknown>)
    },
    createIndex: async () => undefined,
  } as unknown as QueueCollection
  const q = new OrderQueue({ collection, workerId: 'w', now: () => 2_000 })
  await q.markTerminal('sub-9#0', 'REJECTED', { filledQty: 0, avgPrice: null, reason: 'orphaned' })
  const after = docs[0]!
  assert.equal(after['state'], 'REJECTED')
  assert.equal(after['filledQty'], 0)
  assert.notEqual(after['status'], 'COMPLETE')
  assert.equal(after['filled_quantity'], undefined)
})

test('the legacy rails keep the legacy fill shape — there it IS the fill', () => {
  const doc = orderDocument(fill, ctx)
  assert.equal(doc['status'], 'COMPLETE')
  assert.equal(doc['filled_quantity'], 2250)
  assert.equal(doc['price'], 106)
})
