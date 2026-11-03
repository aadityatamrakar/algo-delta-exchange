import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FillWatcher, type FillsCollection } from '../src/fills.ts'
import { OrderQueue, type QueueCollection } from '../src/queue.ts'
import { SimulatorAdapter } from '@algomaker/brokers'
import type { OrderEvent } from '../src/journal.ts'

/**
 * FILL ATTRIBUTION ACROSS A RECYCLED BROKER ORDER ID.
 *
 * `desk-fills` outlives the gateway process; the paper simulator's order ids do
 * not. `SimulatorAdapter` numbered from `sim-1` on every construction, so a
 * restart reissued ids that `desk-fills` still held rows for — and `#fillsFor`
 * ORs `brokerOrderId` into its lookup with nothing scoping it to the order that
 * actually owns the row.
 *
 * THE TRACE (2026-09-16). `sim-5` was TATASTEEL26SEP182.5PE filled 2750 @1.72
 * on Sep 8 and SENSEX2691778000CE filled 60 @2.05 on Sep 16. The SENSEX order
 * aggregated BOTH and booked 2750 @1.72 — another contract's quantity, at
 * another contract's price. Its successor then read 1350 of 2060 filled
 * (KALYANKJIL's `sim-6`), believed 710 shares were outstanding, and emitted a
 * cut for 710 — not a multiple of the 20-share lot, so the gateway refused it
 * INVALID every 6 seconds for 45 minutes.
 *
 * Two guards, because either alone still admits the bug: unique ids stop the
 * collision being created, and the symbol scope stops a row that collides
 * anyway (a live broker recycling ids, or the rows already in the database)
 * from being adopted.
 */

const BASE = 'SENSEX-2026-09-17-delta-lean-conservative:paper:1#0'
const SYMBOL = 'SENSEX2691778000CE'
/** What this order really traded: 3 lots of 20. */
const REAL_QTY = 60
/** The id the simulator reissued after a restart. */
const RECYCLED_ID = 'sim-5'

/** Mongo's `$or`/`$in` semantics — the query `#fillsFor` actually builds. */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return (v as Record<string, unknown>[]).some((sub) => matches(doc, sub))
    if (v !== null && typeof v === 'object' && '$in' in (v as Record<string, unknown>)) {
      return (v as { $in: unknown[] }).$in.includes(doc[k])
    }
    // Array containment, as Mongo reads `{ brokerOrderIds: id }` against a
    // multikey field — the query `getByBrokerOrderId` builds. Without it the
    // broker-id arm of the resolution can never match in this harness, and a
    // test of that arm would be testing the fake.
    if (k === 'brokerOrderIds') return Array.isArray(doc[k]) && (doc[k] as unknown[]).includes(v)
    return doc[k] === v
  })
}

class FakeFills implements FillsCollection {
  rows: Record<string, unknown>[] = []
  async insertOne(doc: Record<string, unknown>): Promise<void> {
    this.rows.push(doc)
  }
  find(filter: Record<string, unknown>) {
    return { toArray: async () => this.rows.filter((r) => matches(r, filter)) }
  }
  async createIndex(): Promise<void> {}
}

class FakeQueueCollection implements QueueCollection {
  docs: Record<string, unknown>[] = []
  find(filter: Record<string, unknown>) {
    const m = this.docs.filter((d) => matches(d, filter))
    return { sort: () => ({ limit: (n: number) => ({ toArray: async () => m.slice(0, n) }) }) }
  }
  async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.docs.find((d) => matches(d, filter)) ?? null
  }
  async findOneAndUpdate(): Promise<null> {
    return null
  }
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<void> {
    const doc = this.docs.find((d) => matches(d, filter))
    if (doc !== undefined) Object.assign(doc, (update['$set'] as Record<string, unknown>) ?? {})
  }
  async createIndex(): Promise<void> {}
}

interface Harness {
  watcher: FillWatcher
  fills: FakeFills
  orders: FakeQueueCollection
  events: OrderEvent[]
  logs: string[]
  order(): Record<string, unknown>
}

function harness(over: Record<string, unknown> = {}): Harness {
  const orders = new FakeQueueCollection()
  orders.docs.push({
    clientOrderId: BASE,
    tradingsymbol: SYMBOL,
    tag: 'SENSEX-2026-09-17-delta-lean-conservative',
    quantity: REAL_QTY,
    expectedQty: REAL_QTY,
    trancheIds: [],
    failedTrancheIds: [],
    brokerOrderIds: [RECYCLED_ID],
    state: 'PLACED',
    mode: 'paper',
    ...over,
  })
  const fills = new FakeFills()
  const events: OrderEvent[] = []
  const logs: string[] = []
  const watcher = new FillWatcher({
    fills,
    queue: new OrderQueue({ collection: orders, workerId: 'w', now: () => 1_000 }),
    journal: { record: async (e: OrderEvent) => void events.push(e) },
    now: () => 1_000,
    log: (m) => void logs.push(m),
  })
  return { watcher, fills, orders, events, logs, order: () => orders.docs[0] as Record<string, unknown> }
}

const ignoredLines = (logs: readonly string[]): number =>
  logs.filter((l) => l.startsWith('IGNORED a fill row')).length

test("a fill row whose broker id was recycled from another contract is not this order's fill", async () => {
  const { watcher, fills } = harness()

  // Sep 8: a DIFFERENT contract traded under this id, in a previous process.
  await fills.insertOne({
    baseClientOrderId: 'TATASTEEL-2026-09-29-recenter-relief-r:paper:2#0',
    brokerOrderId: RECYCLED_ID,
    tradingsymbol: 'TATASTEEL26SEP182.5PE',
    status: 'FILLED',
    filledQty: 2750,
    avgPrice: 1.72,
    ts: 1_788_930_906_485,
  })
  // Sep 16: what THIS order actually traded.
  await fills.insertOne({
    baseClientOrderId: BASE,
    brokerOrderId: RECYCLED_ID,
    tradingsymbol: SYMBOL,
    status: 'FILLED',
    filledQty: REAL_QTY,
    avgPrice: 2.05,
    ts: 1_789_531_267_138,
  })

  const traded = await watcher.filledSoFar(BASE)

  assert.equal(traded.filledQty, REAL_QTY)
  assert.equal(traded.avgPrice, 2.05)
})

test('two simulator instances never issue the same broker order id', async () => {
  const instrument = {
    tradingsymbol: SYMBOL,
    instrumentToken: 1,
    lotSize: 20,
    exchange: 'BFO',
  }
  const intent = {
    clientOrderId: 'c-1',
    instrument,
    side: 'BUY',
    quantity: REAL_QTY,
    orderType: 'MARKET',
    product: 'NRML',
  }

  // Two adapters, as a restart makes them.
  const first = new SimulatorAdapter()
  first.feedTick(1, 2.05)
  const second = new SimulatorAdapter()
  second.feedTick(1, 2.05)

  const a = await first.placeOrder(intent as never)
  const b = await second.placeOrder(intent as never)

  assert.notEqual(a.brokerOrderId, b.brokerOrderId)
})

// ------------------------------------------------- the live rail's spelling

/**
 * ON LIVE THE TWO SIDES NEVER SPELL THE CONTRACT THE SAME WAY.
 *
 * The order document carries the instrument master's symbol
 * (`NIFTY2692223150PE`); every XTS order-book row and socket update carries the
 * broker's (`NIFTY 22SEP2026 PE 23150`), and `#symbolOf` prefers the broker's
 * for the fill row. Mongo, 2026-09: 793 live `desk-fills` rows spelled the
 * broker's way, 0 the master's. So a guard that compares the two strings is
 * not a guard on live — it is a rule that refuses EVERY row it is asked about,
 * and the one place it is asked is the raced-row recovery: a fill that landed
 * before `markPlaced` wrote the AppOrderID sits under the truncated wire id,
 * and the broker-id arm of `#fillsFor` is the only way back to its order.
 *
 * The exchange token is what both sides agree on: the doc's Zerodha-packed
 * `instrument_token` (`exchange_token * 256 + segment`) and XTS's
 * `ExchangeInstrumentID` name the same integer.
 */
const LIVE_TAG = 'NIFTY-2026-09-22-delta-lean-conservative'
const LIVE_BASE = `${LIVE_TAG}:live:7#0`
const MASTER_SYMBOL = 'NIFTY2692223150PE'
const XTS_SYMBOL = 'NIFTY 22SEP2026 PE 23150'
const EXCHANGE_TOKEN = 61623
const PACKED_TOKEN = EXCHANGE_TOKEN * 256 + 2
const APP_ORDER_ID = '1240099001'
/** What XTS echoes for a 40-char tag: `tag|id` cut at 45 leaves 4 chars of id. */
const WIRE_ID = 'NIFT'

const liveDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientOrderId: LIVE_BASE,
  tradingsymbol: MASTER_SYMBOL,
  instrument_token: PACKED_TOKEN,
  tag: LIVE_TAG,
  quantity: 65,
  expectedQty: 65,
  trancheIds: [],
  failedTrancheIds: [],
  brokerOrderIds: [],
  state: 'CLAIMED',
  mode: 'live',
  ...over,
})

test('a live fill that raced markPlaced is adopted although the broker spells the contract differently', async () => {
  const h = harness(liveDoc())

  // 1. The socket update lands first: truncated wire id, broker spelling, no
  //    doc resolvable by AppOrderID yet — recorded unattributed.
  await h.watcher.handle({
    brokerOrderId: APP_ORDER_ID, clientOrderId: WIRE_ID, status: 'FILLED',
    filledQty: 65, avgPrice: 101.5, tradingsymbol: XTS_SYMBOL, exchangeToken: EXCHANGE_TOKEN,
  })
  assert.equal(h.fills.rows.length, 1)
  assert.equal(h.fills.rows[0]!['baseClientOrderId'], WIRE_ID)

  // 2. markPlaced writes the ACKed id and the placer reconciles.
  await h.orders.updateOne(
    { clientOrderId: LIVE_BASE },
    { $set: { state: 'PLACED', brokerOrderIds: [APP_ORDER_ID], trancheIds: [LIVE_BASE] } },
  )
  await h.watcher.reconcile(LIVE_BASE)

  assert.equal(h.order()['state'], 'FILLED')
  assert.equal(h.order()['filledQty'], 65)
  assert.equal(h.order()['avgPrice'], 101.5)
  assert.equal(ignoredLines(h.logs), 0, h.logs.join('\n'))
})

test('a row on a different exchange token is refused even when its symbol is missing', async () => {
  const h = harness(liveDoc({ state: 'PLACED', brokerOrderIds: [APP_ORDER_ID], trancheIds: [LIVE_BASE] }))
  await h.fills.insertOne({
    baseClientOrderId: WIRE_ID, clientOrderId: WIRE_ID, brokerOrderId: APP_ORDER_ID,
    tradingsymbol: '', exchangeToken: 61646, status: 'FILLED', filledQty: 65, avgPrice: 101.5,
    tag: '', mode: 'live',
  })

  const traded = await h.watcher.filledSoFar(LIVE_BASE)

  assert.equal(traded.filledQty, 0)
  assert.equal(ignoredLines(h.logs), 1)
})

test('a row with neither token nor symbol is not evidence of a mismatch', async () => {
  // The v2 `trade` socket event drops `TradingSymbol`; a row may carry
  // neither. No evidence is not evidence against: the row passes here and the
  // time/tag guards are what stand between it and a wrong order.
  const h = harness(liveDoc({ state: 'PLACED', brokerOrderIds: [APP_ORDER_ID], trancheIds: [LIVE_BASE] }))
  await h.fills.insertOne({
    baseClientOrderId: WIRE_ID, clientOrderId: WIRE_ID, brokerOrderId: APP_ORDER_ID,
    tradingsymbol: '', status: 'FILLED', filledQty: 65, avgPrice: 101.5, tag: '', mode: 'live',
  })

  const traded = await h.watcher.filledSoFar(LIVE_BASE)

  assert.equal(traded.filledQty, 65)
  assert.equal(traded.avgPrice, 101.5)
  assert.equal(ignoredLines(h.logs), 0)
})

// ------------------------------------------ two books on the same contract

/**
 * THE CONTRACT SCOPE DOES NOT SEPARATE TWO BOOKS ON THE SAME CONTRACT.
 *
 * NIFTY aggressive and NIFTY conservative both trade the ATM weekly strike,
 * so a row from the sibling book passes the token guard on merit — it IS the
 * same contract. What tells them apart is the row's own provenance: a live
 * broker recycling AppOrderIDs across days (or a stale row) puts a fill from
 * two days ago, tagged with the other book, under an id this order now holds.
 * So a row adopted by broker id must ALSO be no older than the order and,
 * when it carries a tag at all, carry this order's.
 *
 * The caveats are as binding as the guards. A raced row — the one the whole
 * arm exists to recover — is written with `tag: ''` and `mode: 'live'` (every
 * one of the 21 live tag-'' rows in Mongo) and a `ts` up to 5 ms BEFORE
 * `placedAt`, because `placedAt` is written after the tranche loop. So `''`
 * is no evidence, the mode is judged only on a tagged row, the time anchor is
 * `createdAt` (written by desk-api at route time, always before any fill) with
 * a skew, and a missing timestamp on either side passes: the fixtures in
 * `fills.test.ts` and legacy documents carry none.
 */
const NOW = 1_789_980_557_008
const DAY = 86_400_000
const CONS_TAG = 'NIFTY-delta-lean-conservative-2026-09-22'
const AGG_TAG = 'NIFTY-delta-lean-aggressive-2026-09-22'
const CONS_BASE = `${CONS_TAG}:paper:7#0`
const SHARED_ID = 'X-reused'

const siblingDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientOrderId: CONS_BASE,
  tradingsymbol: MASTER_SYMBOL,
  instrument_token: PACKED_TOKEN,
  tag: CONS_TAG,
  quantity: 65,
  expectedQty: 65,
  trancheIds: [CONS_BASE],
  failedTrancheIds: [],
  brokerOrderIds: [SHARED_ID],
  state: 'PLACED',
  mode: 'paper',
  createdAt: NOW - 5_000,
  placedAt: NOW,
  ...over,
})

/** A row under the shared id on the SAME contract, as the sibling book's fill. */
const sharedRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseClientOrderId: 'NIFTY-delta-lean-aggressive-2026-09-20:paper:3#0',
  clientOrderId: 'NIFTY-delta-lean-aggressive-2026-09-20:paper:3#0',
  brokerOrderId: SHARED_ID,
  tradingsymbol: MASTER_SYMBOL,
  exchangeToken: EXCHANGE_TOKEN,
  status: 'FILLED',
  filledQty: 130,
  avgPrice: 100,
  ts: NOW,
  tag: AGG_TAG,
  mode: 'paper',
  ...over,
})

test('a row two days older than the order is refused even on the same contract', async () => {
  const h = harness(siblingDoc())
  await h.fills.insertOne(sharedRow({ tag: '', ts: NOW - 5_000 - 2 * DAY }))

  const traded = await h.watcher.filledSoFar(CONS_BASE)

  assert.equal(traded.filledQty, 0)
  assert.equal(ignoredLines(h.logs), 1)
})

test('a row tagged with the sibling book on the same contract is refused', async () => {
  const h = harness(siblingDoc())
  await h.fills.insertOne(sharedRow({ tag: AGG_TAG }))
  // This order's own, smaller, real fill — which the sibling's 130 would
  // outrank per tranche if it were adopted.
  await h.fills.insertOne({
    baseClientOrderId: CONS_BASE, clientOrderId: CONS_BASE, brokerOrderId: SHARED_ID,
    tradingsymbol: MASTER_SYMBOL, exchangeToken: EXCHANGE_TOKEN, status: 'FILLED',
    filledQty: 65, avgPrice: 90, ts: NOW, tag: CONS_TAG, mode: 'paper',
  })

  const traded = await h.watcher.filledSoFar(CONS_BASE)

  assert.equal(traded.filledQty, 65, "the order's own row, not the sibling's 130")
  assert.equal(traded.avgPrice, 90)
  assert.equal(ignoredLines(h.logs), 1)
})

test('a row on the same contract whose tag names this order but whose rail does not is refused', async () => {
  // A tagged row is judged on its rail too. `''` is stamped live on a raced
  // row, which is why the mode is only ever asked of a row with a tag.
  const h = harness(siblingDoc())
  await h.fills.insertOne(sharedRow({ tag: CONS_TAG, mode: 'live' }))

  const traded = await h.watcher.filledSoFar(CONS_BASE)

  assert.equal(traded.filledQty, 0)
  assert.equal(ignoredLines(h.logs), 1)
})

test('a raced row — untagged, live-stamped, seconds before placedAt — is still adopted', async () => {
  // Exactly what the socket writes when it beats markPlaced on a PAPER order
  // in simulate mode, where the rail is unknown: no doc to resolve, so
  // `tag: ''` and the fail-closed `mode: 'live'` (a named rail would stamp
  // `'paper'`, and neither says anything about the order), at a `ts` a few ms
  // before `placedAt` lands.
  const h = harness(siblingDoc())
  await h.fills.insertOne(
    sharedRow({ baseClientOrderId: 'NIFT', clientOrderId: 'NIFT', tag: '', mode: 'live', ts: NOW - 5, filledQty: 65 }),
  )

  const traded = await h.watcher.filledSoFar(CONS_BASE)

  assert.equal(traded.filledQty, 65)
  assert.equal(traded.avgPrice, 100)
  assert.equal(ignoredLines(h.logs), 0, h.logs.join('\n'))
})

// ------------------------------------------------------------ the proof

/**
 * THE REAL ROWS. `desk-fills` for AppOrderID 1240030151, 2026-08-04: one
 * unsplit TCS order of 1125, whose six socket updates all beat `markPlaced`
 * and were recorded under the truncated wire id `entry-TCS-20` with `tag: ''`,
 * `mode: 'live'` and XTS's spelling `TCS 25AUG2026 CE 2660`, at `ts` up to
 * 5 ms BEFORE the document's `placedAt`. Against the symbol-string guard this
 * replays to `{ state: 'PLACED', ignored: 6 }`. It must resolve FILLED 1125
 * @7.85 with nothing ignored — through the token guard (the rows and the doc
 * carry the token the live rail now carries), the time guard (anchored on
 * `createdAt`, with the skew) and the tag guard (`''` is no evidence).
 */
test('the six real 2026-08-04 TCS rows recorded under a truncated base resolve the order FILLED 1125 @7.85', async () => {
  const TCS_BASE = 'entry-TCS-2026-08-25-recenter-relief-r-TCS26AUG2660CE#0'
  const TCS_TOKEN = 153898
  const h = harness({
    clientOrderId: TCS_BASE,
    tradingsymbol: 'TCS26AUG2660CE',
    instrument_token: TCS_TOKEN * 256 + 2,
    tag: 'TCS-2026-08-25-recenter-relief-r',
    quantity: 1125,
    expectedQty: 1125,
    state: 'PLACED',
    mode: undefined,
    trancheIds: [TCS_BASE],
    failedTrancheIds: [],
    brokerOrderIds: ['1240030151'],
    createdAt: 1_785_825_233_950,
    placedAt: 1_785_825_234_107,
  })
  const rows = [
    ['PENDING_NEW', 0, 1_785_825_234_102],
    ['PARTIALLY_FILLED', 225, 1_785_825_234_105],
    ['PARTIALLY_FILLED', 450, 1_785_825_234_109],
    ['PARTIALLY_FILLED', 675, 1_785_825_234_113],
    ['PARTIALLY_FILLED', 900, 1_785_825_234_117],
    ['FILLED', 1125, 1_785_825_234_121],
  ] as const
  for (const [status, filledQty, ts] of rows) {
    await h.fills.insertOne({
      clientOrderId: 'entry-TCS-20',
      baseClientOrderId: 'entry-TCS-20',
      brokerOrderId: '1240030151',
      tradingsymbol: 'TCS 25AUG2026 CE 2660',
      exchangeToken: TCS_TOKEN,
      status,
      filledQty,
      avgPrice: filledQty > 0 ? 7.85 : null,
      ts,
      tag: '',
      mode: 'live',
    })
  }

  await h.watcher.reconcile(TCS_BASE)

  assert.equal(h.order()['state'], 'FILLED')
  assert.equal(h.order()['filledQty'], 1125)
  assert.equal(h.order()['avgPrice'], 7.85)
  assert.equal(ignoredLines(h.logs), 0, h.logs.join('\n'))
})

test('an order document without timestamps adopts on tag and contract alone', async () => {
  // Legacy and hand-written documents carry no `createdAt`/`placedAt`
  // (queue.ts `isStaleOrder` says so), and neither do most fixtures. A guard
  // that read a missing anchor as "now" would refuse every historical row.
  const h = harness(siblingDoc({ createdAt: undefined, placedAt: undefined }))
  await h.fills.insertOne(sharedRow({ tag: '', ts: NOW - 30 * DAY, filledQty: 65 }))

  const traded = await h.watcher.filledSoFar(CONS_BASE)

  assert.equal(traded.filledQty, 65)
  assert.equal(ignoredLines(h.logs), 0)
})
