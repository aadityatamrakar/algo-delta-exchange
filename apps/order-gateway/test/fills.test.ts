import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlacedOrder } from '@algomaker/brokers'
import { FillWatcher, sameIstDay, type FillsCollection } from '../src/fills.ts'
import { aggregateTranches } from '../src/gateway.ts'
import { OrderQueue, type QueueCollection } from '../src/queue.ts'
import type { OrderEvent } from '../src/journal.ts'

/**
 * These exercise THE PATH THE GATEWAY RUNS, which is the whole point.
 *
 * The suite this replaces asserted four properties of `aggregateTranches` — a
 * function production never called. It was green while the running gateway
 * marked a 30-lot order FILLED on its first tranche, at the wrong price, and
 * REJECTED while 24 lots were live at the broker. `FillWatcher` is what
 * `main.ts` subscribes to the broker with, so a regression in it fails here.
 */

/** Real numbers: 30 lots of NIFTY, lot 75, freeze 1800 -> 24 lots per order. */
const BASE = 'ord-9'
const T1 = 'ord-9.1'
const T2 = 'ord-9.2'
const SYMBOL = 'NIFTY26AUG25000CE'
const EXPECTED = 2250

/**
 * Equality, plus array containment on `brokerOrderIds` — Mongo's reading of
 * `{ brokerOrderIds: id }` against a multikey field, which is the query
 * `getByBrokerOrderId` builds. Without it the broker-id arm of the watcher's
 * resolution can never match here, and a test of that arm tests the fake.
 */
const matches = (d: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([k, v]) => {
    // `$or` / `$in`: the shape `#fillsFor` reads with once a doc carries
    // broker ids, so a row recovered by broker id is visible to the aggregate.
    if (k === '$or') return (v as Record<string, unknown>[]).some((sub) => matches(d, sub))
    if (v !== null && typeof v === 'object' && '$in' in (v as object)) {
      return (v as { $in: unknown[] }).$in.includes(d[k])
    }
    if (k === 'brokerOrderIds') return Array.isArray(d[k]) && (d[k] as unknown[]).includes(v)
    return d[k] === v
  })

class FakeQueueCollection implements QueueCollection {
  docs: Record<string, unknown>[] = []
  find(filter: Record<string, unknown>) {
    const match = this.docs.filter((d) => matches(d, filter))
    return { sort: () => ({ limit: (n: number) => ({ toArray: async () => match.slice(0, n) }) }) }
  }
  async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.docs.find((d) => matches(d, filter)) ?? null
  }
  async findOneAndUpdate(): Promise<null> {
    return null
  }
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void> {
    const doc = this.docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v))
    if (doc !== undefined) Object.assign(doc, (update['$set'] as Record<string, unknown>) ?? {})
  }
  async createIndex(): Promise<void> {}
}

class FakeFills implements FillsCollection {
  rows: Record<string, unknown>[] = []
  async insertOne(doc: Record<string, unknown>): Promise<void> {
    this.rows.push(doc)
  }
  find(filter: Record<string, unknown>) {
    const match = this.rows.filter((d) => matches(d, filter))
    return { toArray: async () => match }
  }
  async createIndex(): Promise<void> {}
}

interface Harness {
  watcher: FillWatcher
  fills: FakeFills
  orders: FakeQueueCollection
  events: OrderEvent[]
  /** Every line the watcher logged, for the tests about what it SAYS. */
  logs: string[]
  order(): Record<string, unknown>
}

function harness(over: Record<string, unknown> = {}, now = 1_000): Harness {
  const orders = new FakeQueueCollection()
  orders.docs.push({
    clientOrderId: BASE,
    tradingsymbol: SYMBOL,
    tag: 'DESK_NIFTY',
    quantity: EXPECTED,
    expectedQty: EXPECTED,
    trancheIds: [T1, T2],
    failedTrancheIds: [],
    state: 'PLACED',
    // These are LIVE orders; on the Delta desk a live document says so.
    mode: 'live',
    ...over,
  })
  const fills = new FakeFills()
  const events: OrderEvent[] = []
  const logs: string[] = []
  const watcher = new FillWatcher({
    fills,
    queue: new OrderQueue({ collection: orders, workerId: 'w', now: () => now }),
    journal: { record: async (e: OrderEvent) => void events.push(e) },
    now: () => now,
    log: (m: string) => void logs.push(m),
  })
  return { watcher, fills, orders, events, logs, order: () => orders.docs[0] as Record<string, unknown> }
}

const update = (over: Partial<PlacedOrder> & { clientOrderId: string }): PlacedOrder => ({
  brokerOrderId: 'b1',
  status: 'FILLED',
  filledQty: 0,
  avgPrice: null,
  ...over,
})

// --------------------------------------------------------------------- G1

test('the FIRST tranche filling does NOT resolve the desk order', async () => {
  // X.1 (1800) fills, X.2 (450) is still working at the broker. Marking the
  // order FILLED here understates nothing and overstates everything: the desk
  // books 30 lots when it has 24.
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  assert.equal(h.order()['state'], 'PLACED', 'still working — 450 qty is live at the broker')
  assert.equal(h.order()['avgPrice'], undefined)
})

test('a split order is FILLED only when EVERY tranche is, at the weighted average', async () => {
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  await h.watcher.handle(update({ clientOrderId: T2, filledQty: 450, avgPrice: 130 }))

  assert.equal(h.order()['state'], 'FILLED')
  assert.equal(h.order()['filledQty'], 2250)
  // (1800*100 + 450*130) / 2250 = 106. The old code overwrote avgPrice with the
  // last tranche's 130 — Rs.54,000 wrong on one order.
  assert.equal(h.order()['avgPrice'], 106)
})

test('a REJECTED later tranche does not mark the order REJECTED while lots are live', async () => {
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  await h.watcher.handle(
    update({ clientOrderId: T2, status: 'REJECTED', rejectReason: 'RMS: margin' }),
  )

  assert.equal(h.order()['state'], 'PARTIAL', '24 lots ARE on; the desk must not be told otherwise')
  assert.equal(h.order()['filledQty'], 1800)
  assert.equal(h.order()['avgPrice'], 100)
  assert.match(String(h.order()['reason']), /RMS: margin/)
})

test('every tranche rejected resolves the order REJECTED', async () => {
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, status: 'REJECTED', rejectReason: 'RMS: margin' }))
  assert.equal(h.order()['state'], 'PLACED', 'one of two rejected is not the order rejected')
  await h.watcher.handle(update({ clientOrderId: T2, status: 'REJECTED', rejectReason: 'RMS: margin' }))
  assert.equal(h.order()['state'], 'REJECTED')
  assert.equal(h.order()['filledQty'], 0)
})

test('a tranche that never reached the broker still lets the order resolve', async () => {
  // Placement threw for T2, so no update will ever arrive for it. Without the
  // failed list the order would wait on it for the rest of the session.
  const h = harness({ failedTrancheIds: [T2] })
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  assert.equal(h.order()['state'], 'PARTIAL')
  assert.equal(h.order()['filledQty'], 1800)
})

test('an UNSPLIT order still resolves on its single update', async () => {
  const h = harness({ trancheIds: [], failedTrancheIds: [] })
  await h.watcher.handle(update({ clientOrderId: BASE, filledQty: 2250, avgPrice: 106 }))
  assert.equal(h.order()['state'], 'FILLED')
  assert.equal(h.order()['avgPrice'], 106)
})

test('partial fills WITHIN one tranche keep the order working', async () => {
  const h = harness()
  await h.watcher.handle(
    update({ clientOrderId: T1, status: 'PARTIALLY_FILLED', filledQty: 900, avgPrice: 100 }),
  )
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  await h.watcher.handle(update({ clientOrderId: T2, filledQty: 450, avgPrice: 130 }))
  assert.equal(h.order()['state'], 'FILLED')
  // The tranche's own progress must not be summed with its final fill.
  assert.equal(h.order()['filledQty'], 2250)
})

test('a repeated identical update is not persisted twice', async () => {
  const h = harness()
  const u = update({ clientOrderId: T1, status: 'WORKING', filledQty: 0 })
  await h.watcher.handle(u)
  await h.watcher.handle({ ...u })
  assert.equal(h.fills.rows.length, 1)
})

test('a sweep replay of a row first seen unattributed is written under the real base once the doc carries the broker id', async () => {
  // The socket beats markPlaced: the echo carries the truncated wire id and
  // an AppOrderID no document holds yet, so the row lands under the wire id,
  // unattributed. 45 s later the broker-book sweep replays the SAME raw row.
  // A dedup keyed on the RAW ids swallows that replay as a repeat for the
  // life of the process — although attribution has changed in between and
  // the replay is the first chance to write the row under the real order.
  const h = harness({ trancheIds: [BASE], brokerOrderIds: [] })
  // The document is not findable by 'A' yet: simulate that by holding the id
  // off the doc until markPlaced "runs" below.
  const raw = update({ clientOrderId: 'NIFT', brokerOrderId: 'A', filledQty: 2250, avgPrice: 106 })
  await h.watcher.handle(raw)
  assert.equal(h.fills.rows.length, 1)
  assert.equal(h.fills.rows[0]?.['baseClientOrderId'], 'NIFT')
  assert.equal(h.fills.rows[0]?.['tag'], '')

  Object.assign(h.order(), { brokerOrderIds: ['A'] })
  await h.watcher.handle({ ...raw })

  assert.equal(h.fills.rows.length, 2, 'the replay is news: it is attributed now')
  assert.equal(h.fills.rows[1]?.['baseClientOrderId'], BASE)
  assert.equal(h.fills.rows[1]?.['tag'], 'DESK_NIFTY')
  assert.equal(h.order()['state'], 'FILLED')
})

// ------------------------------------------ a recycled broker id, resolved

/**
 * THE BROKER-ID FALLBACK MUST NOT LAND A FILL ON A DEAD OR FOREIGN-RAIL DOC.
 *
 * XTS's AppOrderID is not unique across days. When the only document holding
 * one is yesterday's FILLED order of another book, a truncated echo that can
 * be resolved by nothing else was written under THAT order — tagged with
 * yesterday's book, journalled under it — and the real order sat PLACED (F3).
 * Likewise the paper and live rails share one watcher: a paper simulator id
 * that happens to equal a live AppOrderID must never resolve across rails.
 */
const TWO_DAYS = 2 * 86_400_000
/** A real clock: the age gate reads a negative `placedAt` as "no timestamp". */
const TODAY = 1_789_980_557_008

test("an update whose broker id resolves only to a two-day-old FILLED order is recorded unattributed, not under that order's tag", async () => {
  const h = harness(
    {
      state: 'FILLED',
      brokerOrderIds: ['R'],
      trancheIds: [BASE],
      placedAt: TODAY - TWO_DAYS,
      filledQty: EXPECTED,
      avgPrice: 100,
    },
    TODAY,
  )
  await h.watcher.handle(update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: 75, avgPrice: 12 }))

  assert.equal(h.fills.rows.length, 1, 'recorded — the sweep may still want it')
  assert.equal(h.fills.rows[0]?.['tag'], '', "not stamped with the old order's book")
  assert.equal(h.fills.rows[0]?.['baseClientOrderId'], 'DESK')
  assert.equal(h.events.some((e) => e.tag === 'DESK_NIFTY'), false, 'no STATUS under the old tag')
  assert.equal(h.order()['filledQty'], EXPECTED, 'the old document is untouched')
  assert.equal(h.order()['avgPrice'], 100)
})

test("a FILLED document from YESTERDAY's session (18 h) does not absorb today's raced fill by a reused broker id", async () => {
  // The realistic recycle: an NSE session is 09:15–15:30 IST, so a reused
  // AppOrderID is 17.75–18.5 h from its previous owner — a 24 h gate never
  // fired. Yesterday's 15:20 fill, today's 09:20 raced echo (today's doc is
  // still CLAIMED, holds no id yet), same contract.
  const h = harness(
    {
      state: 'FILLED',
      brokerOrderIds: ['R'],
      trancheIds: [BASE],
      placedAt: TODAY - 18 * 3_600_000,
      filledQty: EXPECTED,
      avgPrice: 100,
    },
    TODAY,
  )
  await h.watcher.handle(update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: 75, avgPrice: 12 }))

  assert.equal(h.fills.rows.length, 1, 'recorded — the post-placement reconcile recovers it')
  assert.equal(h.fills.rows[0]?.['tag'], '', "not stamped with yesterday's book")
  assert.equal(h.events.some((e) => e.tag === 'DESK_NIFTY'), false, 'no STATUS under the old tag')
  assert.equal(h.order()['filledQty'], EXPECTED, 'the old document is untouched')
})

for (const state of ['PLACED', 'AMBIGUOUS']) {
  test(`a ${state} document from YESTERDAY's session holding a reused broker id does not absorb today's raced fill either`, async () => {
    // The stale gate used to apply to TERMINAL documents only, while
    // `getByBrokerOrderId` prefers a NON-terminal one among the two newest —
    // so a yesterday's order that never settled (a PLACED left resting into
    // the close, an AMBIGUOUS nobody resolved) and holds a recycled id beat
    // today's document in the markPlaced race, took today's fill under its
    // tag, and could be pushed to FILLED by `reconcile` a session late. A
    // day order cannot fill in the next session; an update this long after
    // the document's stamp is a recycled id whatever the document's state.
    const h = harness(
      { state, brokerOrderIds: ['R'], trancheIds: [BASE], placedAt: TODAY - 18 * 3_600_000 },
      TODAY,
    )
    await h.watcher.handle(update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: EXPECTED, avgPrice: 12 }))

    assert.equal(h.fills.rows.length, 1, 'recorded — the post-placement reconcile recovers it')
    assert.equal(h.fills.rows[0]?.['tag'], '', "not stamped with yesterday's book")
    assert.equal(h.fills.rows[0]?.['baseClientOrderId'], 'DESK')
    assert.equal(h.events.some((e) => e.tag === 'DESK_NIFTY'), false, 'no STATUS under the old tag')
    assert.equal(h.order()['state'], state, "yesterday's document is untouched")
    assert.ok(
      h.logs.some((l) => l.includes('NOT adopted') && l.includes(state)),
      `the refusal is LOUD and names the state:\n${h.logs.join('\n')}`,
    )
  })
}

test('a working document whose stamp is RECENT still resolves by broker id — the gate is the session window, not the state', async () => {
  const h = harness({ brokerOrderIds: ['R'], trancheIds: [BASE], placedAt: TODAY - 6 * 3_600_000 }, TODAY)
  await h.watcher.handle(update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: EXPECTED, avgPrice: 106 }))
  assert.equal(h.fills.rows[0]?.['tag'], 'DESK_NIFTY')
  assert.equal(h.order()['state'], 'FILLED')
})

test("a working document placed THIS IST DAY still resolves after the 8 h window — an evening restart replaying the close-cancel of a 09:15 order", async () => {
  // The session window (8 h) separates yesterday's owner of a recycled id
  // from today's order, and once it covered documents of every state it also
  // refused a genuine same-session update that simply arrived LATE: a live
  // PLACED from 09:15 IST whose exchange close-cancel is first seen by the
  // 45 s sweep after 17:15 IST — the gateway down across the close and
  // restarted in the evening — aged past the window and the document stayed
  // PLACED, where master let it settle. An id cannot be recycled within one
  // session, so a NON-terminal document stamped on today's IST date is this
  // session's order whatever the clock says, and the gate stands aside for
  // it. A previous-day document, working or not, is still refused (the
  // yesterday's-PLACED tests above), and a terminal document keeps the plain
  // window: it has nothing left to settle, so refusing its replay costs
  // nothing.
  const placedAt = Date.parse('2026-09-21T09:15:00+05:30')
  const evening = Date.parse('2026-09-21T17:20:00+05:30')
  assert.ok(evening - placedAt > 8 * 3_600_000, 'the replay is outside the session window')
  const h = harness({ state: 'PLACED', brokerOrderIds: ['R'], trancheIds: [BASE], placedAt }, evening)
  await h.watcher.handle(
    update({ clientOrderId: 'DESK', brokerOrderId: 'R', status: 'CANCELLED', filledQty: 0, avgPrice: null }),
    { rail: 'live' },
  )

  assert.equal(h.fills.rows.length, 1)
  assert.equal(h.fills.rows[0]?.['tag'], 'DESK_NIFTY', 'adopted: the row is stamped with its own book')
  assert.equal(h.fills.rows[0]?.['baseClientOrderId'], BASE)
  assert.notEqual(h.order()['state'], 'PLACED', 'the close-cancel settles the document')
  assert.equal(h.logs.some((l) => l.includes('NOT adopted')), false, `no refusal:\n${h.logs.join('\n')}`)

  // The same document from the PREVIOUS IST day, seen at the same hour of the
  // next session, is a recycled id and stays refused — the exemption is the
  // IST date, not a longer window.
  const yesterday = harness(
    { state: 'PLACED', brokerOrderIds: ['R'], trancheIds: [BASE], placedAt: Date.parse('2026-09-20T15:20:00+05:30') },
    Date.parse('2026-09-21T09:20:00+05:30'),
  )
  await yesterday.watcher.handle(
    update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: EXPECTED, avgPrice: 12 }),
    { rail: 'live' },
  )
  assert.equal(yesterday.fills.rows[0]?.['tag'], '', "not stamped with yesterday's book")
  assert.equal(yesterday.order()['state'], 'PLACED', "yesterday's document is untouched")
})

test('sameIstDay splits on IST midnight, not UTC midnight', () => {
  // 23:59 IST and 00:01 IST the next day are 18:29Z and 18:31Z of the SAME
  // UTC date — a UTC-keyed check would call them one day and let a
  // yesterday's document through; an IST-keyed one must not.
  assert.equal(sameIstDay(Date.parse('2026-09-21T23:59:00+05:30'), Date.parse('2026-09-22T00:01:00+05:30')), false)
  // 00:01 IST and 23:59 IST are 18:31Z the previous day and 18:29Z — two UTC
  // dates, one IST date.
  assert.equal(sameIstDay(Date.parse('2026-09-21T00:01:00+05:30'), Date.parse('2026-09-21T23:59:00+05:30')), true)
  assert.equal(sameIstDay(Date.parse('2026-09-20T15:20:00+05:30'), Date.parse('2026-09-21T09:20:00+05:30')), false)
})

test('resolve({ quiet }) refuses exactly as before but says nothing — the sweep asks it every 45 s', async () => {
  // The broker sweep calls `resolve` on every pass BEFORE its own once-per-id
  // `reportedForeign` guard, so each of resolve's refusal lines repeated per
  // row per pass for as long as the XTS day book listed the order — every
  // same-day FILLED live order became a `NOT adopted` line every 45 s from
  // the moment it aged past the session window. The verdict is the sweep's to
  // announce once; `quiet` hands it the verdict without the line.
  const stale = harness(
    { state: 'FILLED', brokerOrderIds: ['R'], trancheIds: [BASE], placedAt: TODAY - 18 * 3_600_000 },
    TODAY,
  )
  const raced = update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: 75, avgPrice: 12 })
  assert.equal(await stale.watcher.resolve(raced, { rail: 'live', quiet: true }), null)
  assert.equal(stale.logs.length, 0, `quiet: the stale refusal is not logged:\n${stale.logs.join('\n')}`)
  assert.equal(await stale.watcher.resolve(raced, { rail: 'live' }), null)
  assert.equal(stale.logs.filter((l) => l.includes('NOT adopted')).length, 1, 'not quiet: it still is')

  // The same for the rail and the contract refusals: `quiet` covers every
  // line `resolve` owns, not just the stale one.
  const live = harness({ brokerOrderIds: ['R'], trancheIds: [BASE], instrument_token: 61_623 * 256 + 2 })
  assert.equal(await live.watcher.resolve(raced, { rail: 'paper', quiet: true }), null)
  assert.equal(
    await live.watcher.resolve({ ...raced, exchangeToken: 99_999 }, { rail: 'live', quiet: true }),
    null,
  )
  assert.equal(live.logs.length, 0, live.logs.join('\n'))
  assert.notEqual(await live.watcher.resolve(raced, { rail: 'live', quiet: true }), null, 'quiet does not refuse MORE')
})

test('a broker-id match on ANOTHER contract is not resolved — the update itself is judged, not only the stored rows', async () => {
  // `#fillsFor` takes a row written under this base as it stands, so a row
  // that resolves here is booked for good. The update carries the exchange
  // token the broker reported; a token that is not this document's contract
  // is a recycled id, whatever document holds it right now.
  const h = harness({ brokerOrderIds: ['R'], trancheIds: [BASE], instrument_token: 61_623 * 256 + 2 })
  await h.watcher.handle(
    update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: EXPECTED, avgPrice: 106, exchangeToken: 99_999 }),
  )
  assert.equal(h.fills.rows.length, 1)
  assert.equal(h.fills.rows[0]?.['tag'], '', 'recorded unattributed')
  assert.equal(h.fills.rows[0]?.['baseClientOrderId'], 'DESK')
  assert.equal(h.order()['state'], 'PLACED', "another contract's fill cannot settle this order")

  // The same id on the SAME token still resolves: the token is the verdict.
  await h.watcher.handle(
    update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: EXPECTED, avgPrice: 106, exchangeToken: 61_623 }),
  )
  assert.equal(h.fills.rows[1]?.['tag'], 'DESK_NIFTY')
  assert.equal(h.order()['state'], 'FILLED')
})

test('a terminal document that is RECENT still resolves by broker id — a late replay of its own fill', async () => {
  // The age gate is for a recycled id, not for the ordinary case of the sweep
  // replaying a fill the order already settled on.
  const h = harness(
    { state: 'FILLED', brokerOrderIds: ['R'], trancheIds: [BASE], placedAt: TODAY - 60_000 },
    TODAY,
  )
  await h.watcher.handle(update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: EXPECTED, avgPrice: 106 }))
  assert.equal(h.fills.rows[0]?.['tag'], 'DESK_NIFTY')
  assert.equal(h.fills.rows[0]?.['baseClientOrderId'], BASE)
})

test('an update from the paper rail never resolves to a live document by broker id', async () => {
  const h = harness({ brokerOrderIds: ['R'], trancheIds: [BASE] })
  await h.watcher.handle(
    update({ clientOrderId: 'DESK', brokerOrderId: 'R', filledQty: EXPECTED, avgPrice: 106 }),
    { rail: 'paper' },
  )
  assert.equal(h.fills.rows.length, 1)
  assert.equal(h.fills.rows[0]?.['tag'], '')
  assert.equal(h.order()['state'], 'PLACED', 'a paper update cannot settle a live order')
})

test('an unattributed paper-rail row is stamped paper', async () => {
  // It used to be stamped live, fail-closed — right when the rail is unknown,
  // wrong when the emitting adapter IS known to be the simulator: a paper
  // raced row labelled live is read by the live reconciler and shown on the
  // live tab.
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: 'nobody.1', filledQty: 75, avgPrice: 12 }), { rail: 'paper' })
  assert.equal(h.fills.rows[0]?.['mode'], 'paper')
  const status = h.events.find((e) => e.phase === 'STATUS')
  assert.equal(status?.mode, 'paper')

  // And with NO rail given, the fail-closed default holds — paper on the Delta desk.
  await h.watcher.handle(update({ clientOrderId: 'nobody.2', filledQty: 75, avgPrice: 12 }))
  assert.equal(h.fills.rows[1]?.['mode'], 'paper')
})

test('reconcile() resolves an order whose fills landed before markPlaced did', async () => {
  // The socket is faster than the write. At fill time the tranche list was not
  // there yet, so nothing could be decided; main.ts calls reconcile after
  // markPlaced for exactly this.
  const h = harness({ trancheIds: [], expectedQty: 0, quantity: 0 })
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  await h.watcher.handle(update({ clientOrderId: T2, filledQty: 450, avgPrice: 130 }))
  assert.equal(h.order()['state'], 'PLACED', 'undecidable until the plan is written')

  Object.assign(h.order(), { trancheIds: [T1, T2], expectedQty: EXPECTED })
  await h.watcher.reconcile(BASE)
  assert.equal(h.order()['state'], 'FILLED')
  assert.equal(h.order()['avgPrice'], 106)
})

// --------------------------------------------------------------------- G2

test('the fill row names the CONTRACT, not the correlation id', async () => {
  // `toFillRecord(update, update.clientOrderId, …)` put an order id in the
  // symbol column of every row the portal renders, and made broker fills
  // unjoinable to contracts.
  const h = harness()
  h.watcher.rememberSymbol(T1, SYMBOL)
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))

  const row = h.fills.rows[0] as Record<string, unknown>
  assert.equal(row['tradingsymbol'], SYMBOL)
  assert.notEqual(row['tradingsymbol'], T1)
  assert.equal(row['baseClientOrderId'], BASE, 'the join key back to the desk order')
})

test("the BROKER's own symbol wins when it sends one", async () => {
  const h = harness()
  h.watcher.rememberSymbol(T1, 'STALE_CACHE_SYMBOL')
  await h.watcher.handle(
    update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100, tradingsymbol: SYMBOL }),
  )
  assert.equal(h.fills.rows[0]?.['tradingsymbol'], SYMBOL)
})

test('after a RESTART the symbol comes from the order document', async () => {
  // The cache is empty and the broker sent no symbol — the desk order still
  // knows which contract it is for.
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  assert.equal(h.fills.rows[0]?.['tradingsymbol'], SYMBOL)
})

test('the STATUS journal row names the contract and the tag', async () => {
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  const status = h.events.find((e) => e.phase === 'STATUS')
  assert.equal(status?.tradingsymbol, SYMBOL)
  assert.equal(status?.tag, 'DESK_NIFTY', 'the tag was hardcoded empty')
})

test('the fill row carries the exchange token the broker named', async () => {
  // The token is the one name for a contract that the doc (Zerodha-packed
  // `instrument_token`) and XTS (`ExchangeInstrumentID`) agree on, and the
  // broker-id adoption in `#fillsFor` judges a row by it — so a row written
  // without it can only ever be judged by two spellings that never match.
  const h = harness()
  await h.watcher.handle(
    update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100, exchangeToken: 61623 }),
  )
  assert.equal(h.fills.rows[0]?.['exchangeToken'], 61623)

  // Absent on the update means absent on the row: 0 is not "unknown", it is a
  // token, and a guard would read it as one.
  await h.watcher.handle(update({ clientOrderId: T2, filledQty: 450, avgPrice: 130 }))
  assert.ok(!('exchangeToken' in (h.fills.rows[1] as object)), 'absent, never 0')
})

// --------------------------------------------------------------- resilience

test('a fill for an order we have no record of is stored, never adopted', async () => {
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: 'someone-elses.1', filledQty: 75, avgPrice: 12 }))
  assert.equal(h.fills.rows.length, 1)
  assert.equal(h.order()['state'], 'PLACED', 'a manual order must not resolve ours')
})

test('handle() NEVER rejects, whatever Mongo does', async () => {
  // It is invoked as `void handle(update)` from a socket callback. A rejection
  // escaping it is an unhandled rejection, and Node 24 kills the process — the
  // gateway would die mid-session on a Mongo blip (G4).
  const events: OrderEvent[] = []
  const logs: string[] = []
  const watcher = new FillWatcher({
    fills: {
      insertOne: async () => {
        throw new Error('connection 4 to mongo closed')
      },
      find: () => ({ toArray: async () => [] }),
      createIndex: async () => undefined,
    },
    queue: new OrderQueue({ collection: new FakeQueueCollection(), workerId: 'w', now: () => 1 }),
    journal: { record: async (e: OrderEvent) => void events.push(e) },
    now: () => 1,
    log: (m) => logs.push(m),
  })

  await watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  assert.equal(logs.some((l) => l.includes('fill handling FAILED')), true)
})

test('an order already resolved is not re-resolved by a late duplicate', async () => {
  const h = harness({ state: 'FILLED' })
  await h.watcher.handle(update({ clientOrderId: T1, status: 'REJECTED', rejectReason: 'late' }))
  assert.equal(h.order()['state'], 'FILLED')
})

// --------------------------------------------------------------- provenance

/**
 * `desk-fills` MUST CARRY `desk_tag`, and this is not cosmetic.
 *
 * The Python desk's `translate.reconcile` — the pass that corrects an
 * optimistically-booked entry price, un-books a REJECTED open and resizes a
 * PARTIAL one — keys every row on `desk_tag` and skips outright when it is
 * absent (`if tag is None: continue`). It reads these rows through
 * `/v1/desk/trades`, which serves `desk-paper-trade` on paper (written by
 * `rail.ts orderDocument`, which DOES carry the field) and `desk-fills` on
 * live.
 *
 * So while this field was missing, reconcile was a COMPLETE NO-OP on the live
 * rail: no price correction, no rejected-open un-booking, no partial resize —
 * silently, on the only rail with real money on it. The order document already
 * holds `desk_tag`; it just was not being carried across into the fill.
 */
test('a fill carries desk_tag and desk_op through from the order document', async () => {
  const h = harness({ desk_tag: 'open-2026-08-14-09:20-0', desk_op: 'close' })
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))

  const row = h.fills.rows[0] as Record<string, unknown>
  assert.equal(row['desk_tag'], 'open-2026-08-14-09:20-0')
  assert.equal(row['desk_op'], 'close')
})

/**
 * An order document with no desk tag — a manual order on the same account, or
 * one placed before this field existed — must not write `desk_tag: ''`. An
 * empty string is a tag that matches no leg, where an absent field reads as
 * "this fill has no desk provenance", which is the truth.
 */
test('a fill for an order with no desk tag omits the field rather than blanking it', async () => {
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))

  const row = h.fills.rows[0] as Record<string, unknown>
  assert.ok(!('desk_tag' in row), 'absent, not empty')
  assert.ok(!('desk_op' in row), 'absent, not empty')
})

// ------------------------------------------- out-of-order broker replays

/**
 * THE BROKER REPLAYS STATUSES OUT OF ORDER, AND IT STRANDS THE ORDER.
 *
 * Observed on prod 2026-08-14. `desk-fills` for one unsplit BHEL order — a
 * single tranche, a single AppOrderID — holds, in insertion order:
 *
 *   PENDING_NEW 0, PARTIAL 2625, PARTIAL 5250, FILLED 7875,
 *   PARTIAL 5250, FILLED 7875, PARTIAL 2625
 *
 * `isMeaningfulUpdate` only suppresses an exact repeat of the IMMEDIATELY
 * PREVIOUS state, so a replayed-out-of-order 5250 after a 7875 is "meaningful"
 * and is written again. `aggregateTranches` then took the LAST record per
 * tranche — and `#fillsFor` reads with no sort, so last means last inserted:
 * PARTIAL 2625.
 *
 * The desk order therefore read 2625 of an expected 7875, never reached a
 * terminal state, and sat PLACED forever while the broker held it filled. Two
 * such rows were stranded, one for three days.
 *
 * The position itself was never wrong — that comes from `desk-decisions`,
 * written when the order routed — and nothing re-sends a PLACED order, since
 * `claimNext` filters on PENDING. What was wrong is the order's own record of
 * itself, which is what the Broker page shows and what any future logic keyed
 * on order state would read.
 */
test('the aggregate is INDEPENDENT of the order the fill rows come back in', () => {
  // `#fillsFor` reads with NO sort, so the array order is whatever the storage
  // engine yields — not insertion order. Depending on it is the bug: this is
  // the prod row set with the FILLED row NOT last.
  const rows = (
    [
      ['PENDING_NEW', 0, null],
      ['PARTIALLY_FILLED', 2625, 3.65],
      ['FILLED', 7875, 3.63],
      ['PARTIALLY_FILLED', 5250, 3.65],
      ['FILLED', 7875, 3.63],
      ['PARTIALLY_FILLED', 2625, 3.65],
    ] as [string, number, number | null][]
  ).map(([status, filledQty, avgPrice]) => ({
    clientOrderId: BASE, baseClientOrderId: BASE, brokerOrderId: 'b1',
    tradingsymbol: SYMBOL, status, filledQty, avgPrice,
    ts: 1_000, tag: 'DESK_NIFTY', mode: 'live' as const,
  }))

  const agg = aggregateTranches(rows, 7875, { ids: [BASE], failed: [] })
  assert.equal(agg.filledQty, 7875, 'the furthest-progressed row, not the last one')
  assert.equal(agg.avgPrice, 3.63)
  assert.equal(agg.complete, true)
  assert.equal(agg.allTerminal, true, 'the broker holds it filled; it is not still working')
})

test('every permutation of those rows gives the same answer', () => {
  // Order-independence is the property, so it is asserted as one rather than
  // on the single arrangement that happened to be observed.
  const base = { clientOrderId: BASE, baseClientOrderId: BASE, brokerOrderId: 'b1',
    tradingsymbol: SYMBOL, ts: 1_000, tag: 'DESK_NIFTY', mode: 'live' as const }
  const rows = [
    { ...base, status: 'PARTIALLY_FILLED', filledQty: 2625, avgPrice: 3.65 },
    { ...base, status: 'FILLED', filledQty: 7875, avgPrice: 3.63 },
    { ...base, status: 'PARTIALLY_FILLED', filledQty: 5250, avgPrice: 3.65 },
  ]
  const perms: [number, number, number][] = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]
  for (const [i, j, k] of perms) {
    const agg = aggregateTranches([rows[i]!, rows[j]!, rows[k]!], 7875, { ids: [BASE], failed: [] })
    assert.equal(agg.filledQty, 7875, `permutation ${i}${j}${k}`)
    assert.equal(agg.allTerminal, true, `permutation ${i}${j}${k}`)
  }
})

test('a REJECTED tranche is still terminal even when a partial fill outranks it', async () => {
  // The refusal must not be lost just because a PARTIAL row carries more
  // quantity than the REJECTED one — otherwise the order works forever.
  const h = harness({ trancheIds: [], expectedQty: 7875, quantity: 7875 })
  await h.watcher.handle(update({ clientOrderId: BASE, status: 'PARTIALLY_FILLED', filledQty: 2625, avgPrice: 3.65 }))
  await h.watcher.handle(
    update({ clientOrderId: BASE, status: 'REJECTED', filledQty: 0, rejectReason: 'RMS: margin' }),
  )

  assert.equal(h.order()['state'], 'PARTIAL', '2625 IS on; the desk must not be told otherwise')
  assert.equal(h.order()['filledQty'], 2625)
})

test('the fills\' fee reaches the terminal document — the desk folds net, never gross', async () => {
  // 3 Nov: four Delta paper straddles filled and the supervisor banked
  // cumRealized 0 on each — the fee rode the fill rows, but the reader that
  // turned rows into records dropped it, so the order document had none.
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100, fee: 0.4 }))
  await h.watcher.handle(update({ clientOrderId: T2, filledQty: 450, avgPrice: 130, brokerOrderId: 'b2', fee: 0.12 }))
  assert.equal(h.order()['state'], 'FILLED')
  assert.equal(h.order()['fee'], 0.52)
})

test('fill rows with no fee leave the terminal document without one', async () => {
  const h = harness()
  await h.watcher.handle(update({ clientOrderId: T1, filledQty: 1800, avgPrice: 100 }))
  await h.watcher.handle(update({ clientOrderId: T2, filledQty: 450, avgPrice: 130, brokerOrderId: 'b2' }))
  assert.equal(h.order()['state'], 'FILLED')
  assert.equal('fee' in h.order(), false)
})
