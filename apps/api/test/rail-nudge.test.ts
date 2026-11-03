/**
 * THE NUDGE THAT NEVER FIRED.
 *
 * `apps/order-gateway/src/main.ts` subscribes to `ORDER_NUDGE_TOPIC`
 * unconditionally and sweeps its queue the moment one arrives — and NOTHING in
 * the tree ever published it. Every desk order, paper and live, therefore sat
 * in `desk-gateway-orders` until the 5s idle sweep (`DESK_SWEEP_MS`) happened
 * to come round. A book that decides on a seconds cadence cannot pay that, and
 * the cost was invisible because the idle sweep meant nothing ever FAILED.
 *
 * The two properties these tests exist to keep:
 *
 *   ORDER — the nudge is published only after `insertOne` has RESOLVED. A nudge
 *   that overtakes its own document makes the gateway claim nothing, reset its
 *   idle timer, and go back to sleep for the full interval — strictly worse
 *   than not nudging at all.
 *
 *   SCOPE — exactly one nudge per document that actually lands in the gateway
 *   queue, and none for a document that does not. The plain paper-trade rail
 *   writes to a collection the gateway never reads; nudging on it would wake
 *   the sweeper for work that is not there.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ORDER_NUDGE_TOPIC, type NudgePayload } from '@algomaker/desk-engine'
import { LiveRail, PaperRail, type OrderNudgeBus, type RouteContext } from '../src/rail.ts'
import { COLLECTIONS, type Database } from '../src/store.ts'
import type { Fill } from '../src/contract.ts'

const TAG = 'NIFTY-2026-09-17-delta-lean'
const SYMBOL = 'NIFTY26SEP25000CE'

const ctx: RouteContext = {
  tag: TAG,
  underlying: 'NIFTY',
  instrument: {
    tradingsymbol: SYMBOL,
    instrumentToken: 42001,
    exchange: 'NFO',
    tickSize: 0.05,
    lotSize: 75,
  },
  nowMs: Date.UTC(2026, 8, 15, 4, 30),
  clientOrderId: 'd-77#0',
}

const fill: Fill = {
  op: 'open',
  deskTag: 'CE25000#0',
  tradingsymbol: SYMBOL,
  side: 'Buy',
  qty: 75,
  price: 118.5,
  ts: 1,
}

interface Published {
  readonly topic: string
  readonly payload: NudgePayload
  readonly ts: number
}

/** A bus that records, and optionally explodes. `WsTransportClient` shape. */
function recordingBus(
  into: Published[],
  opts: { onPublish?: () => void; throws?: boolean } = {},
): OrderNudgeBus {
  return {
    publish(topic: string, payload: NudgePayload, ts: number): void {
      opts.onPublish?.()
      if (opts.throws === true) throw new Error('the bus socket exploded')
      into.push({ topic, payload, ts })
    },
  }
}

interface Trace {
  readonly db: Database
  /** Collection name per `insertOne`, in the order they resolved. */
  readonly wrote: string[]
  /** Every step either side of the write, interleaved. */
  readonly steps: string[]
}

/**
 * The write RESOLVES ON A LATER TURN, deliberately.
 *
 * A fake whose `insertOne` returns an already-settled value would let a publish
 * placed BEFORE the await still record itself second, and the ordering test
 * below would pass against the exact bug it names. One real turn of the
 * microtask queue is what makes "after the insert" mean something.
 */
function trace(): Trace {
  const wrote: string[] = []
  const steps: string[] = []
  const db = {
    collection(name: string) {
      return {
        async findOne(): Promise<Record<string, unknown> | null> {
          return null
        },
        async insertOne(_doc: Record<string, unknown>): Promise<void> {
          await Promise.resolve()
          wrote.push(name)
          steps.push(`insert:${name}`)
        },
      }
    },
  }
  return { db: db as unknown as Database, wrote, steps }
}

// ------------------------------------------------------------- the paper rail

test('an engine paper order nudges the gateway exactly once', async () => {
  const t = trace()
  const seen: Published[] = []
  const rail = new PaperRail(t.db, undefined, recordingBus(seen))

  await rail.route(fill, { ...ctx, via: 'engine' })

  assert.deepEqual(t.wrote, [COLLECTIONS.gatewayOrders])
  assert.equal(seen.length, 1)
  // THE TOPIC ITSELF, because the gateway's subscription is the only reader and
  // a rail publishing on some other string would satisfy every count below.
  assert.equal(seen[0]?.topic, 'order.submitted')
  assert.equal(seen[0]?.topic, ORDER_NUDGE_TOPIC)
  // The payload names the document that is now waiting, so a gateway log line
  // can be tied back to the order that woke it.
  assert.equal(seen[0]?.payload.clientOrderId, 'd-77#0')
  assert.equal(seen[0]?.payload.tag, TAG)
  assert.equal(seen[0]?.payload.tradingsymbol, SYMBOL)
  // The caller's clock, not a fresh `Date.now()`.
  assert.equal(seen[0]?.ts, ctx.nowMs)
})

test('the paper nudge is published AFTER the insert, never before', async () => {
  const t = trace()
  const rail = new PaperRail(t.db, undefined, recordingBus([], { onPublish: () => t.steps.push('nudge') }))

  await rail.route(fill, { ...ctx, via: 'engine' })

  assert.deepEqual(t.steps, [`insert:${COLLECTIONS.gatewayOrders}`, 'nudge'])
})

test('a paper order that is NOT queued for the gateway nudges nobody', async () => {
  const t = trace()
  let nudges = 0
  // No `via`, so this is the book-keeping rail: it writes `desk-paper-trade`,
  // which the gateway does not read. Waking the sweeper for it would cost a
  // pointless claim round and reset the idle timer.
  const rail = new PaperRail(t.db, undefined, recordingBus([], { onPublish: () => { nudges += 1 } }))

  await rail.route(fill, ctx)

  assert.deepEqual(t.wrote, [COLLECTIONS.paperTrade])
  assert.equal(nudges, 0)
})

test('a nudge that throws does not fail an order that is already durable', async () => {
  const t = trace()
  const rail = new PaperRail(t.db, undefined, recordingBus([], { throws: true }))

  // The document is written by the time the publish runs. Letting a transport
  // error propagate would report a routed order as a route FAILURE, and the
  // caller's recovery is to route it again.
  await rail.route(fill, { ...ctx, via: 'engine' })

  assert.deepEqual(t.wrote, [COLLECTIONS.gatewayOrders])
})

// -------------------------------------------------------------- the live rail

test('a live order on the gateway executor nudges once, after the insert', async () => {
  const t = trace()
  const seen: Published[] = []
  const rail = new LiveRail(
    t.db,
    [TAG],
    'desk-gateway',
    recordingBus(seen, { onPublish: () => t.steps.push('nudge') }),
  )

  await rail.route(fill, ctx)

  assert.deepEqual(t.steps, [`insert:${COLLECTIONS.gatewayOrders}`, 'nudge'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.topic, ORDER_NUDGE_TOPIC)
  assert.equal(seen[0]?.payload.clientOrderId, 'd-77#0')
})

test('a REFUSED live order nudges nobody', async () => {
  const t = trace()
  let nudges = 0
  // Not on the allowlist and not an exit: `route` throws before any write.
  const rail = new LiveRail(t.db, [], 'desk-gateway', recordingBus([], { onPublish: () => { nudges += 1 } }))

  await assert.rejects(() => rail.route(fill, ctx))

  assert.deepEqual(t.wrote, [])
  assert.equal(nudges, 0)
})

test('the legacy-positional executor nudges nobody', async () => {
  const t = trace()
  let nudges = 0
  // `positional` is watched by `xtsOrder.js`, not by the gateway sweeper.
  const rail = new LiveRail(
    t.db,
    [TAG],
    'legacy-positional',
    recordingBus([], { onPublish: () => { nudges += 1 } }),
  )

  await rail.route(fill, ctx)

  assert.deepEqual(t.wrote, [COLLECTIONS.live])
  assert.equal(nudges, 0)
})
