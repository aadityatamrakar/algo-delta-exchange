/**
 * The terminal-state reconciler — broker truth joined back onto the desk.
 *
 * THE ARGUMENT THIS FILE DEFENDS (audit F-2, and the "booked-but-refused"
 * residual). `service.ts` writes `desk-decisions.fills` at RAIL-WRITE time, at
 * the FULL requested quantity and the decision-time mark, because that is the
 * only moment it knows anything. `pnlstore.loadFills` then makes that document
 * the sole input to P&L, the daily rollup, `LiveBook`'s held set and
 * `flattenTag`'s position reconstruction. Nothing ever read the gateway's
 * terminal `filledQty` / `avgPrice` / `REJECTED` back. So a margin-403 on a
 * recenter leg left the book carrying a leg no order backs, and tomorrow's
 * `close-all` sent a REAL order in the opposite direction against it.
 *
 * Every test here is a money-path invariant, not a formatting one:
 *
 *   - a refused order is un-booked (qty 0) and the phantom leg is folded away;
 *   - a partial is restated to what actually filled, at the price it filled at;
 *   - a refused CLOSE restores the leg that is really still open;
 *   - a correction never runs twice, and never grows a position;
 *   - paper is never read and never written;
 *   - one unreadable document never stops the pass.
 *
 * Mongo-free: the fakes model the two behaviours the argument rests on — the
 * `$set` of a dotted path into one element of the `fills` array, and
 * `saveBook`'s compare-and-set on `updatedAt`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { createLiveReconciler, splitOrderId, type ReconcileMaster } from '../src/reconcile-live.ts'
import { COLLECTIONS, DeskStore, type Collection, type Database, type FindCursor, type UpdateOutcome } from '../src/store.ts'
import type { BridgeLeg, DeskSide } from '../src/contract.ts'

// ------------------------------------------------------------------ fixtures

const SYMBOL = 'BANKNIFTY'
const EXPIRY = '2026-08-27'
const TAG = 'DESK_BANKNIFTY'
const LOT = 35
const T0 = Date.UTC(2026, 7, 14, 6, 30)
const NOW = T0 + 60_000

const PE = 'BANKNIFTY26AUG56000PE'
const CE = 'BANKNIFTY26AUG57000CE'

function master(): OptionMaster & ReconcileMaster {
  const rows: InstrumentRow[] = [
    {
      instrument_token: 1,
      tradingsymbol: PE,
      name: SYMBOL,
      expiry: EXPIRY,
      strike: 56_000,
      tick_size: 0.05,
      lot_size: LOT,
      instrument_type: 'PE',
      segment: 'NFO-OPT',
      exchange: 'NFO',
    },
    {
      instrument_token: 2,
      tradingsymbol: CE,
      name: SYMBOL,
      expiry: EXPIRY,
      strike: 57_000,
      tick_size: 0.05,
      lot_size: LOT,
      instrument_type: 'CE',
      segment: 'NFO-OPT',
      exchange: 'NFO',
    },
  ]
  return new OptionMaster(rows)
}

const MASTER = master()

function leg(over: Partial<BridgeLeg> & { tradingsymbol?: string } = {}): BridgeLeg {
  const symbol = over.tradingsymbol ?? PE
  const instrument = MASTER.resolveSymbol(symbol)
  assert.ok(instrument !== null, `fixture symbol ${symbol} must be in the master`)
  const { tradingsymbol: _drop, ...rest } = over
  return {
    deskTag: 'L1',
    instrument,
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike: symbol === PE ? 56_000 : 57_000,
    type: symbol === PE ? 'PE' : 'CE',
    side: 'Sell',
    qty: -500,
    entryPrice: 100,
    openedTs: T0,
    ...rest,
  }
}

function fill(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: 'open',
    deskTag: 'L1',
    tradingsymbol: PE,
    side: 'Sell' as DeskSide,
    qty: 500,
    price: 100,
    ts: T0,
    ...over,
  }
}

function decision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionId: 'd1',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'live',
    tag: TAG,
    fills: [fill()],
    skips: [],
    createdAt: T0,
    status: 'DONE',
    ...over,
  }
}

function gatewayOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientOrderId: 'd1#0',
    state: 'REJECTED',
    filledQty: 0,
    avgPrice: null,
    tag: TAG,
    desk_tag: 'L1',
    tradingsymbol: PE,
    transaction_type: 'SELL',
    quantity: 500,
    createdAt: T0,
    ...over,
  }
}

function book(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: TAG,
    mode: 'live',
    symbol: SYMBOL,
    expiry: EXPIRY,
    legs: [leg()],
    updatedAt: T0,
    ...over,
  }
}

// ------------------------------------------------------------- the db fake

/**
 * Only the operators this reconciler actually issues. An unsupported one
 * THROWS rather than returning "no rows": a fake that answers empty to a
 * filter it does not understand turns a broken query into a passing test.
 */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, want]) => {
    const got = doc[k]
    if (typeof want !== 'object' || want === null || Array.isArray(want)) return got === want
    return Object.entries(want as Record<string, unknown>).every(([op, v]) => {
      switch (op) {
        case '$gt':
          return Number(got) > Number(v)
        case '$gte':
          return Number(got) >= Number(v)
        case '$lt':
          return Number(got) < Number(v)
        case '$ne':
          return got !== v
        case '$in':
          return (v as unknown[]).includes(got)
        default:
          throw new Error(`fake db: unsupported operator ${op}`)
      }
    })
  })
}

/** `$set: {'fills.0.qty': 3}` — the surgical write the reconciler makes. */
function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = doc
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string
    const next = cursor[key]
    if (typeof next !== 'object' || next === null) {
      throw new Error(`fake db: $set path '${path}' does not exist`)
    }
    cursor = next as Record<string, unknown>
  }
  cursor[parts[parts.length - 1] as string] = value
}

/**
 * `$push: { appliedCorrections: { $each: ['d1#0'], $slice: -200 } }` — the fold
 * nonce riding along in the SAME `updateOne` as the legs.
 *
 * Modelled rather than stubbed because that atomicity IS the property under
 * test: a fake that applied the legs and dropped the receipt would turn the
 * crash window this closes back into a passing test.
 */
function applyPush(doc: Record<string, unknown>, push: Record<string, unknown>): void {
  for (const [k, raw] of Object.entries(push)) {
    const spec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const each = Array.isArray(spec['$each']) ? (spec['$each'] as unknown[]) : [raw]
    const slice = spec['$slice']
    const existing = Array.isArray(doc[k]) ? (doc[k] as unknown[]) : []
    let next = [...existing, ...each]
    if (typeof slice === 'number') {
      next = slice < 0 ? next.slice(slice) : next.slice(0, slice)
    }
    doc[k] = next
  }
}

class FakeCursor<T extends Record<string, unknown>> implements FindCursor<T> {
  #rows: T[]
  constructor(rows: T[]) {
    this.#rows = rows
  }
  sort(spec: Record<string, 1 | -1>): FindCursor<T> {
    const [key, dir] = Object.entries(spec)[0] ?? ['', 1 as const]
    this.#rows = this.#rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const av = Number(a.r[key] ?? 0)
        const bv = Number(b.r[key] ?? 0)
        return av === bv ? a.i - b.i : (av < bv ? -1 : 1) * (dir === -1 ? -1 : 1)
      })
      .map((x) => x.r)
    return this
  }
  limit(n: number): FindCursor<T> {
    this.#rows = this.#rows.slice(0, n)
    return this
  }
  skip(n: number): FindCursor<T> {
    this.#rows = this.#rows.slice(n)
    return this
  }
  async toArray(): Promise<T[]> {
    return this.#rows
  }
}

class FakeCollection<T extends Record<string, unknown>> implements Collection<T> {
  readonly docs: T[] = []
  writes = 0
  /** Set by a test to make one read blow up, for the fail-soft pass. */
  failFindOne: string | null = null
  /**
   * Runs INSIDE `updateOne`, BEFORE the filter is matched — the window a
   * concurrent writer lands in. A lost compare-and-set cannot be reproduced any
   * other way here: the fake is single-threaded by construction.
   */
  beforeUpdateOne: (() => void) | null = null

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    if (this.failFindOne !== null && JSON.stringify(filter).includes(this.failFindOne)) {
      throw new Error('fake db: read failed')
    }
    return this.docs.find((d) => matches(d, filter)) ?? null
  }
  find(filter: Record<string, unknown>): FindCursor<T> {
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)))
  }
  async insertOne(doc: T): Promise<unknown> {
    this.writes++
    this.docs.push(structuredClone(doc))
    return {}
  }
  async insertMany(docs: readonly T[]): Promise<unknown> {
    for (const d of docs) await this.insertOne(d)
    return {}
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<UpdateOutcome> {
    this.beforeUpdateOne?.()
    const i = this.docs.findIndex((d) => matches(d, filter))
    const set = (update['$set'] ?? {}) as Record<string, unknown>
    const push = (update['$push'] ?? {}) as Record<string, unknown>
    if (i < 0) {
      if (options?.upsert === true) {
        this.writes++
        const created = structuredClone({ ...filter, ...set }) as Record<string, unknown>
        applyPush(created, push)
        this.docs.push(created as T)
      }
      return { matchedCount: 0 }
    }
    this.writes++
    const doc = structuredClone(this.docs[i]) as Record<string, unknown>
    for (const [k, v] of Object.entries(set)) setPath(doc, k, structuredClone(v))
    applyPush(doc, push)
    this.docs[i] = doc as T
    return { matchedCount: 1 }
  }
  async deleteOne(): Promise<unknown> {
    return {}
  }
  async deleteMany(): Promise<unknown> {
    this.docs.length = 0
    return {}
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length
  }
  async createIndex(): Promise<unknown> {
    return {}
  }
  async dropIndex(): Promise<unknown> {
    return {}
  }
}

class FakeDb implements Database {
  readonly collections = new Map<string, FakeCollection<Record<string, unknown>>>()
  collection<T = Record<string, unknown>>(name: string): Collection<T> {
    let c = this.collections.get(name)
    if (c === undefined) {
      c = new FakeCollection()
      this.collections.set(name, c)
    }
    return c as unknown as Collection<T>
  }
  col(name: string): FakeCollection<Record<string, unknown>> {
    this.collection(name)
    return this.collections.get(name) as FakeCollection<Record<string, unknown>>
  }
  docs(name: string): Record<string, unknown>[] {
    return this.col(name).docs
  }
}

// ------------------------------------------------------------------ harness

interface Harness {
  readonly db: FakeDb
  readonly store: DeskStore
  readonly notified: { mode: string; event: Record<string, unknown> }[]
  readonly logs: string[]
  run(): Promise<{ scanned: number; corrected: number; failed: number; busy: boolean }>
  reconciler: ReturnType<typeof createLiveReconciler>
  decisionDoc(): Record<string, unknown> | undefined
  bookLegs(): BridgeLeg[]
  events(): Record<string, unknown>[]
  order(id?: string): Record<string, unknown> | undefined
}

function harness(seed: {
  orders?: Record<string, unknown>[]
  decisions?: Record<string, unknown>[]
  books?: Record<string, unknown>[]
  now?: number
  lookbackMs?: number
  batchSize?: number
}): Harness {
  const db = new FakeDb()
  for (const d of seed.orders ?? [gatewayOrder()]) db.col(COLLECTIONS.gatewayOrders).docs.push(d)
  for (const d of seed.decisions ?? [decision()]) db.col(COLLECTIONS.decisions).docs.push(d)
  for (const d of seed.books ?? [book()]) db.col(COLLECTIONS.books).docs.push(d)
  const store = new DeskStore(db)
  const notified: { mode: string; event: Record<string, unknown> }[] = []
  const logs: string[] = []
  const reconciler = createLiveReconciler(
    {
      store,
      master: () => MASTER,
      notify: (mode, event) => notified.push({ mode, event }),
      now: () => seed.now ?? NOW,
      log: (m) => logs.push(m),
    },
    {
      ...(seed.lookbackMs === undefined ? {} : { lookbackMs: seed.lookbackMs }),
      ...(seed.batchSize === undefined ? {} : { batchSize: seed.batchSize }),
    },
  )
  return {
    db,
    store,
    notified,
    logs,
    reconciler,
    run: () => reconciler.run(),
    decisionDoc: () => db.docs(COLLECTIONS.decisions)[0],
    bookLegs: () => (db.docs(COLLECTIONS.books)[0]?.['legs'] ?? []) as BridgeLeg[],
    events: () => db.docs(COLLECTIONS.orderEvents),
    order: (id = 'd1#0') =>
      db.docs(COLLECTIONS.gatewayOrders).find((d) => d['clientOrderId'] === id),
  }
}

function fillOf(h: Harness, i = 0): Record<string, unknown> {
  const fills = h.decisionDoc()?.['fills'] as Record<string, unknown>[]
  return fills[i] as Record<string, unknown>
}

// --------------------------------------------------- a refused open un-books

test('a REJECTED open is un-booked: qty 0, corrected stamp, phantom leg folded away', async () => {
  const h = harness({})
  const pass = await h.run()

  assert.equal(pass.scanned, 1)
  assert.equal(pass.corrected, 1)

  const f = fillOf(h)
  assert.equal(f['qty'], 0, 'the refused order booked nothing')
  assert.equal(f['price'], 100, 'no broker price to restate to — the booked one stands')
  // The stamp names the ORDER that wrote it, which is what tells two tranches
  // of one split close apart when they share a desk tag. See `shareTheKey`.
  assert.deepEqual(f['corrected'], {
    at: NOW,
    fromQty: 500,
    fromPrice: 100,
    state: 'REJECTED',
    clientOrderId: 'd1#0',
  })

  assert.deepEqual(h.bookLegs(), [], 'the phantom short is gone from desk-books')

  const events = h.events()
  assert.equal(events.length, 1)
  assert.equal(events[0]?.['phase'], 'STATUS')
  assert.equal(events[0]?.['ok'], false)
  assert.equal(events[0]?.['tag'], TAG)
  // Prices are printed to the paisa grid — "100.00", never a float's dust.
  assert.match(String(events[0]?.['error']), /reconciled: booked 500@100\.00, broker says 0@100\.00/)
  assert.equal(h.notified.length, 1)
  assert.equal(h.notified[0]?.mode, 'live')

  const order = h.order()
  assert.equal(order?.['deskReconciled'], true)
  assert.equal(order?.['deskReconciledAt'], NOW)
})

// ------------------------------------------------------------- partial fill

test('a PARTIAL restates qty and price and shrinks the book by the shortfall', async () => {
  const h = harness({
    orders: [gatewayOrder({ state: 'PARTIAL', filledQty: 300, avgPrice: 101.5 })],
    decisions: [decision({ fills: [fill({ qty: 500, price: 100 })] })],
    books: [book({ legs: [leg({ qty: -500 })] })],
  })
  await h.run()

  const f = fillOf(h)
  assert.equal(f['qty'], 300)
  assert.equal(f['price'], 101.5, 'the price the broker actually got')
  assert.deepEqual(f['corrected'], {
    at: NOW,
    fromQty: 500,
    fromPrice: 100,
    state: 'PARTIAL',
    clientOrderId: 'd1#0',
  })

  const legs = h.bookLegs()
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.qty, -300, 'the 200 that never filled is folded off the leg')
  assert.equal(h.events()[0]?.['ok'], false)
})

test('a HALTED order is scanned, and its part-filled tranches shrink the book', async () => {
  /**
   * A fill-gated order the gateway stopped part-way (a rejected tranche, a
   * kill switch thrown between slices). It is TERMINAL — nothing will place
   * the rest — and while this state was missing from the scan the 60-second
   * fold-back never looked at one: a halted nine-lot open of which three lots
   * traded left the book carrying nine, permanently, which is the "leg no
   * order backs" this whole file exists to end.
   *
   * It reconciles exactly like a PARTIAL, because that is what it is on the
   * broker's side: the document's `filledQty` is a real fill, not a rejection.
   */
  const h = harness({
    orders: [gatewayOrder({ state: 'HALTED', filledQty: 300, avgPrice: 101.5 })],
    decisions: [decision({ fills: [fill({ qty: 500, price: 100 })] })],
    books: [book({ legs: [leg({ qty: -500 })] })],
  })
  const pass = await h.run()

  assert.equal(pass.scanned, 1, 'a HALTED document is in the scan at all')
  assert.equal(pass.corrected, 1)

  const f = fillOf(h)
  assert.equal(f['qty'], 300, 'what actually traded')
  assert.equal(f['price'], 101.5)
  assert.equal((f['corrected'] as Record<string, unknown>)['state'], 'HALTED')

  const legs = h.bookLegs()
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.qty, -300, 'the 200 that was never placed is folded off the leg')
  assert.equal(h.order()?.['deskReconciled'], true)
})

// --------------------------------------------------------------- full fill

test('a FILLED order restates the price only and never touches the book', async () => {
  const h = harness({
    orders: [gatewayOrder({ state: 'FILLED', filledQty: 500, avgPrice: 99.25 })],
    books: [book({ legs: [leg({ qty: -500 })], updatedAt: 4242 })],
  })
  await h.run()

  const f = fillOf(h)
  assert.equal(f['qty'], 500, 'everything we booked actually traded')
  assert.equal(f['price'], 99.25)
  assert.equal(h.bookLegs()[0]?.qty, -500)
  assert.equal(h.db.docs(COLLECTIONS.books)[0]?.['updatedAt'], 4242, 'no book write at all')
  assert.equal(h.events()[0]?.['ok'], true, 'the broker did exactly what we booked')
})

// ------------------------------------------------- a refused close restores

test('a REJECTED close RESTORES the leg that is really still open', async () => {
  const h = harness({
    orders: [gatewayOrder({ state: 'REJECTED', desk_tag: 'L1', transaction_type: 'BUY' })],
    decisions: [
      decision({ fills: [fill({ op: 'close', side: 'Buy', qty: 500, price: 105 })] }),
    ],
    // The close routed, so `applyDecision` already removed the leg.
    books: [book({ legs: [] })],
  })
  await h.run()

  assert.equal(fillOf(h)['qty'], 0)
  const legs = h.bookLegs()
  assert.equal(legs.length, 1, 'the position the broker refused to close is back on the book')
  assert.equal(legs[0]?.qty, -500)
  assert.equal(legs[0]?.instrument.tradingsymbol, PE)
  assert.equal(legs[0]?.strike, 56_000)
  assert.equal(legs[0]?.type, 'PE')
})

// ------------------------------------------------------------- idempotency

test('a second pass over the same document writes nothing', async () => {
  const h = harness({})
  await h.run()
  const writesAfterFirst =
    h.db.col(COLLECTIONS.decisions).writes +
    h.db.col(COLLECTIONS.books).writes +
    h.db.col(COLLECTIONS.orderEvents).writes +
    h.db.col(COLLECTIONS.gatewayOrders).writes

  const second = await h.run()
  assert.equal(second.scanned, 0, 'the marked document is not read again')
  const writesAfterSecond =
    h.db.col(COLLECTIONS.decisions).writes +
    h.db.col(COLLECTIONS.books).writes +
    h.db.col(COLLECTIONS.orderEvents).writes +
    h.db.col(COLLECTIONS.gatewayOrders).writes
  assert.equal(writesAfterSecond, writesAfterFirst)
})

test('a crash between the correction and the mark does not correct twice', async () => {
  const h = harness({})
  await h.run()
  // Exactly the state a crash leaves: the fill carries `corrected`, the
  // gateway document was never marked. The mark is written LAST for this.
  const order = h.order() as Record<string, unknown>
  delete order['deskReconciled']
  delete order['deskReconciledAt']
  const legsBefore = h.bookLegs()
  const eventsBefore = h.events().length

  const pass = await h.run()
  assert.equal(pass.scanned, 1)
  assert.equal(pass.corrected, 0, 'the corrected stamp makes the re-run a no-op')
  assert.equal(fillOf(h)['qty'], 0)
  assert.deepEqual(h.bookLegs(), legsBefore, 'the compensating fold is NOT applied twice')
  assert.equal(h.events().length, eventsBefore)
  assert.equal(h.order()?.['deskReconciled'], true)
})

// ------------------------------------------------ the fold nonce (WP-L)

/**
 * THE WINDOW `foldDone` COULD NOT CLOSE (the Tier-2 verifier's residual).
 *
 * `foldDone` lives on `desk-decisions` and the fold lands on `desk-books`: two
 * documents, two writes. A process that died between them left a book that HAD
 * been folded and a record that said it had not, so the next pass folded the
 * same compensation a second time. For a refused CLOSE — the one regime allowed
 * to CREATE a leg — that is the reconciler inventing the position it exists to
 * remove, which is the failure this whole file is about, arriving through its
 * own repair.
 *
 * The receipt therefore travels WITH the fold: the gateway `clientOrderId` is
 * appended to the book's own `appliedCorrections` inside the same `saveBook`
 * write. One document, one `updateOne`. A nonce already present means the fold
 * landed, whatever the decision record says, so the pass skips straight to
 * `markFoldDone` and repairs the stamp instead of the book.
 */
test('a compensating fold records its nonce ON THE BOOK, in the same write', async () => {
  const h = harness({ books: [book({ legs: [leg({ qty: -500 })] })] })
  await h.run()

  assert.deepEqual(h.bookLegs(), [], 'the phantom leg is folded away')
  assert.deepEqual(
    h.db.docs(COLLECTIONS.books)[0]?.['appliedCorrections'],
    ['d1#0'],
    'the receipt is the gateway clientOrderId of the order that was corrected',
  )
})

test('a fold that landed before the crash is NOT applied twice', async () => {
  /**
   * Exactly the state a crash in the window leaves behind, and the reason the
   * scenario is a refused CLOSE: the restore may create a leg, so a second fold
   * is a second position — 1000 short where the desk holds 500.
   */
  const corrected = {
    ...fill({ op: 'close', side: 'Buy', qty: 0, price: 105 }),
    corrected: { at: T0, fromQty: 500, fromPrice: 105, state: 'REJECTED' },
  }
  const h = harness({
    orders: [gatewayOrder({ state: 'REJECTED', transaction_type: 'BUY' })],
    decisions: [decision({ fills: [corrected] })],
    // Pass 1 restored the leg AND wrote its receipt, then died.
    books: [book({ legs: [leg({ qty: -500 })], appliedCorrections: ['d1#0'] })],
  })
  const writesBefore = h.db.col(COLLECTIONS.books).writes

  await h.run()

  const legs = h.bookLegs()
  assert.equal(legs.length, 1, 'the restore must not run a second time')
  assert.equal(legs[0]?.qty, -500, 'a second restore is 1000 short the desk never sold')
  assert.equal(h.db.col(COLLECTIONS.books).writes, writesBefore, 'the book is not written at all')
  assert.equal(fillOf(h)['foldDone'], true, 'the missing stamp is what actually gets repaired')
  assert.equal(h.order()?.['deskReconciled'], true, 'and the job is finished, not retried forever')
  assert.match(
    String(h.events()[0]?.['error']),
    /already/,
    'the operator is told the fold was already on the book, not that one happened',
  )
})

test('a nonce for a DIFFERENT order never blocks this fold', async () => {
  // The book carries a receipt from an unrelated correction. Matching loosely
  // here would silently abandon a real compensation.
  const h = harness({
    books: [book({ legs: [leg({ qty: -500 })], appliedCorrections: ['d0#9', 'd2#0'] })],
  })
  await h.run()

  assert.deepEqual(h.bookLegs(), [], 'the phantom leg is folded away as usual')
  assert.deepEqual(h.db.docs(COLLECTIONS.books)[0]?.['appliedCorrections'], ['d0#9', 'd2#0', 'd1#0'])
})

test('a book written before appliedCorrections existed still folds', async () => {
  // No array on the document at all: absence must read as "no fold has landed",
  // never as "already folded".
  const legacy = book({ legs: [leg({ qty: -500 })] })
  delete legacy['appliedCorrections']
  const h = harness({ books: [legacy] })
  await h.run()

  assert.deepEqual(h.bookLegs(), [])
  assert.deepEqual(h.db.docs(COLLECTIONS.books)[0]?.['appliedCorrections'], ['d1#0'])
})

// ------------------------------------------------------------------- paper

test('a paper decision is never read and never written', async () => {
  const h = harness({
    orders: [gatewayOrder()],
    decisions: [decision({ mode: 'paper' })],
    books: [book({ mode: 'paper' })],
  })
  await h.run()

  const f = fillOf(h)
  assert.equal(f['qty'], 500, 'the paper record is untouched')
  assert.equal(f['corrected'], undefined)
  assert.equal(h.bookLegs().length, 1, 'the paper book is untouched')
  assert.equal(h.order()?.['deskReconciled'], true, 'but the document is not retried forever')
  assert.equal(h.events().length, 1)
  assert.match(String(h.events()[0]?.['error']), /no matching live decision/)
})

/**
 * A PAPER ORDER IN THIS COLLECTION IS NOT SCANNED AT ALL (D14).
 *
 * The test above describes the world as it was: paper orders could not
 * physically reach `desk-gateway-orders`, so the only defence needed was the
 * `mode: 'live'` pin on the decision lookup — and the cost of one arriving was
 * a loud, WRONG "no matching live decision" alert plus a mark that took it out
 * of every future pass.
 *
 * The engine's paper lifecycle now puts them here by design, one per paper
 * order the desk works. Prime directive 2 is therefore enforced in the SCAN,
 * not discovered at the join: the pass must not see the document at all, must
 * not journal anything about it, and must NOT mark it — `paper-fold.ts` owns it
 * and reads the very same `deskFolded`-shaped mark on its own.
 */
test('a PAPER gateway order is not scanned, not journalled and NOT marked', async () => {
  const h = harness({
    orders: [gatewayOrder({ mode: 'paper', state: 'FILLED', filledQty: 500, avgPrice: 101 })],
    decisions: [decision({ mode: 'paper' })],
    books: [book({ mode: 'paper' })],
  })
  const pass = await h.run()

  assert.equal(pass.scanned, 0, 'the query never returned it')
  assert.equal(h.events().length, 0, 'no alert about an order this pass does not own')
  assert.equal(
    h.order()?.['deskReconciled'],
    undefined,
    'unmarked — the paper fold pass has not run yet, and this one must not speak for it',
  )
  assert.equal(fillOf(h)['qty'], 500, 'the paper record is untouched')
  assert.equal(h.bookLegs().length, 1, 'the paper book is untouched')
})

// ------------------------------------------------------------------- clamp

test('a broker filledQty larger than what we booked is clamped and journalled loudly', async () => {
  const h = harness({
    orders: [gatewayOrder({ state: 'PARTIAL', filledQty: 700, avgPrice: 101 })],
    decisions: [decision({ fills: [fill({ qty: 500 })] })],
  })
  await h.run()

  const f = fillOf(h)
  assert.equal(f['qty'], 500, 'a correction may only REDUCE — never grow the booked size')
  assert.equal(f['price'], 101)
  assert.equal(h.bookLegs()[0]?.qty, -500, 'nothing to fold')
  const event = h.events()[0] as Record<string, unknown>
  assert.equal(event['ok'], false)
  assert.match(String(event['error']), /clamped/i)
  assert.ok(h.logs.some((l) => /more filled than we booked/i.test(l)))
})

// -------------------------------------------------------- missing decision

test('a gateway order with no decision is journalled once and marked', async () => {
  const h = harness({ decisions: [] })
  await h.run()

  assert.equal(h.events().length, 1)
  assert.match(String(h.events()[0]?.['error']), /no matching live decision/)
  const order = h.order()
  assert.equal(order?.['deskReconciled'], true)
  assert.equal(order?.['deskReconcileNote'], 'no matching decision')

  const second = await h.run()
  assert.equal(second.scanned, 0)
  assert.equal(h.events().length, 1, 'journalled ONCE, not forever')
})

test('marking a missing decision never overwrites the gateway refusal reason', async () => {
  const h = harness({
    orders: [gatewayOrder({ state: 'INVALID', reason: 'kill switch engaged' })],
    decisions: [],
  })
  await h.run()
  assert.equal(h.order()?.['reason'], 'kill switch engaged')
})

// --------------------------------------------------------- window and batch

test('the lookback keeps a first deploy from rewriting months of history', async () => {
  const old = gatewayOrder({ clientOrderId: 'old#0', createdAt: NOW - 30 * 86_400_000 })
  const h = harness({
    orders: [old, gatewayOrder()],
    lookbackMs: 7 * 86_400_000,
  })
  const pass = await h.run()
  assert.equal(pass.scanned, 1)
  assert.equal(h.order('old#0')?.['deskReconciled'], undefined)
})

test('a pass reads at most `batchSize` documents, oldest first', async () => {
  const orders = [5, 1, 3, 2, 4].map((n) =>
    gatewayOrder({ clientOrderId: `d1#${n}`, createdAt: T0 + n }),
  )
  const h = harness({ orders, decisions: [], batchSize: 3 })
  const pass = await h.run()
  assert.equal(pass.scanned, 3)
  assert.deepEqual(
    h.db
      .docs(COLLECTIONS.gatewayOrders)
      .filter((d) => d['deskReconciled'] === true)
      .map((d) => String(d['clientOrderId']))
      .sort(),
    ['d1#1', 'd1#2', 'd1#3'],
    'the OLDEST three, never the newest',
  )
})

// --------------------------------------------------------------- fail-soft

test('one unreadable document never stops the pass', async () => {
  const h = harness({
    orders: [gatewayOrder({ clientOrderId: 'bad#0', createdAt: T0 - 1 }), gatewayOrder()],
    decisions: [decision()],
  })
  h.db.col(COLLECTIONS.decisions).failFindOne = 'bad'
  const pass = await h.run()

  assert.equal(pass.failed, 1)
  assert.equal(pass.corrected, 1, 'the good document was still corrected')
  assert.equal(fillOf(h)['qty'], 0)
  assert.equal(
    h.order('bad#0')?.['deskReconciled'],
    undefined,
    'a document that FAILED is not marked — it retries next pass',
  )
})

// ------------------------------------------------------------ single flight

test('a pass already in flight is not started twice', async () => {
  const h = harness({})
  const first = h.run()
  const second = await h.run()
  assert.equal(second.busy, true)
  assert.equal(second.scanned, 0)
  const done = await first
  assert.equal(done.busy, false)
  assert.equal(done.corrected, 1)
})

// ------------------------------------------- the book may never be grown

test('a refused OPEN never adds to a same-signed leg it cannot reduce', async () => {
  // The book holds the contract LONG (some other leg opened it). Undoing a
  // refused SELL by folding a BUY would GROW that long — the one thing a
  // correction may never do.
  const h = harness({
    books: [book({ legs: [leg({ deskTag: 'OTHER', side: 'Buy', qty: 300 })] })],
  })
  await h.run()

  assert.equal(fillOf(h)['qty'], 0, 'the decision record is still corrected')
  const legs = h.bookLegs()
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.qty, 300, 'the long leg is untouched')
  assert.match(String(h.events()[0]?.['error']), /book NOT corrected/)
})

test('a refused open whose leg is gone leaves the book alone and says so', async () => {
  const h = harness({ books: [book({ legs: [] })] })
  await h.run()

  assert.deepEqual(h.bookLegs(), [], 'no leg invented for a contract nothing holds')
  assert.match(String(h.events()[0]?.['error']), /book NOT corrected/)
})

// ------------------------------------------------------ id mapping shapes

test('the hosted-submit shape (deskTag === clientOrderId) reconciles', async () => {
  // `submit.ts` journals under `decisionId = <submission id>` with each
  // tranche's `deskTag` equal to its own `<submission id>#<i>`.
  const h = harness({
    orders: [gatewayOrder({ clientOrderId: 'SUB-9#1', desk_tag: 'SUB-9#1' })],
    decisions: [
      decision({
        decisionId: 'SUB-9',
        source: 'submit',
        fills: [
          fill({ deskTag: 'SUB-9#0', qty: 500 }),
          fill({ deskTag: 'SUB-9#1', qty: 200 }),
        ],
      }),
    ],
    books: [book({ legs: [leg({ qty: -700 })] })],
  })
  await h.run()

  const fills = h.decisionDoc()?.['fills'] as Record<string, unknown>[]
  assert.equal(fills[0]?.['qty'], 500, 'the sibling tranche is untouched')
  assert.equal(fills[1]?.['qty'], 0)
  assert.equal(h.bookLegs()[0]?.qty, -500)
})

/**
 * THE REPAIR SHAPE: every tranche of one close carries the SAME desk tag.
 *
 * A repair close is journalled under the driver's LEG id rather than under each
 * tranche's own order id (`submit.ts:fillDeskTag`), because that equality is
 * what makes the Python side book the leg's realized P&L. The join key is then
 * no longer unique inside the decision, and a reader that demanded exactly one
 * match filed BOTH tranches unjoinable — so the broker's real avgPrice and
 * filledQty were never booked back for any split repair close.
 */
function splitClose(over: { orders?: Record<string, unknown>[] } = {}): Harness {
  return harness({
    orders: over.orders ?? [
      gatewayOrder({
        clientOrderId: 'repair:dec-1:0#0',
        desk_tag: 'py-leg-7',
        transaction_type: 'BUY',
        quantity: 500,
        state: 'FILLED',
        filledQty: 500,
        avgPrice: 101.5,
      }),
      gatewayOrder({
        clientOrderId: 'repair:dec-1:0#1',
        desk_tag: 'py-leg-7',
        transaction_type: 'BUY',
        quantity: 200,
        state: 'FILLED',
        filledQty: 200,
        avgPrice: 102.5,
        createdAt: T0 + 1,
      }),
    ],
    decisions: [
      decision({
        decisionId: 'repair:dec-1:0',
        source: 'submit',
        fills: [
          fill({ deskTag: 'py-leg-7', op: 'close', side: 'Buy', qty: 500, price: 100 }),
          fill({ deskTag: 'py-leg-7', op: 'close', side: 'Buy', qty: 200, price: 100 }),
        ],
      }),
    ],
    books: [book({ legs: [] })],
  })
}

const unjoinable = (h: Harness): Record<string, unknown>[] =>
  h.events().filter((e) => /no matching live decision fill/.test(String(e['error'])))

test('a freeze-split repair close books BOTH tranches, though both fills carry the leg’s tag', async () => {
  const h = splitClose()
  await h.run()

  const fills = h.decisionDoc()?.['fills'] as Record<string, unknown>[]
  // Each tranche's own broker price lands on the fill it was sized for — the
  // 500 on the 500, the 200 on the 200. Pairing them the other way round would
  // book an 18-lot shortfall that never happened.
  assert.equal(fills[0]?.['price'], 101.5)
  assert.equal(fills[1]?.['price'], 102.5)
  assert.equal(fills[0]?.['qty'], 500)
  assert.equal(fills[1]?.['qty'], 200)
  assert.deepEqual(unjoinable(h), [], 'neither tranche may be condemned as unjoinable')
  assert.equal(h.order('repair:dec-1:0#0')?.['deskReconciled'], true)
  assert.equal(h.order('repair:dec-1:0#1')?.['deskReconciled'], true)
})

test('the pairing is by SIZE, not by the order the pass happens to read them in', async () => {
  // The smaller tranche is read FIRST here. Claiming "the next unclaimed fill"
  // blindly would put the 200-lot broker answer onto the 500-lot fill, and the
  // 300 difference would be folded into the book as a compensating trade
  // nobody made.
  const h = splitClose({
    orders: [
      gatewayOrder({
        clientOrderId: 'repair:dec-1:0#1',
        desk_tag: 'py-leg-7',
        transaction_type: 'BUY',
        quantity: 200,
        state: 'FILLED',
        filledQty: 200,
        avgPrice: 102.5,
        createdAt: T0,
      }),
      gatewayOrder({
        clientOrderId: 'repair:dec-1:0#0',
        desk_tag: 'py-leg-7',
        transaction_type: 'BUY',
        quantity: 500,
        state: 'FILLED',
        filledQty: 500,
        avgPrice: 101.5,
        createdAt: T0 + 1,
      }),
    ],
  })
  await h.run()

  const fills = h.decisionDoc()?.['fills'] as Record<string, unknown>[]
  assert.equal(fills[0]?.['price'], 101.5)
  assert.equal(fills[1]?.['price'], 102.5)
  assert.deepEqual(h.bookLegs(), [], 'nothing was folded — every lot the desk booked traded')
})

test('a repair close that was never split joins exactly as it always did', async () => {
  const h = harness({
    orders: [
      gatewayOrder({
        clientOrderId: 'repair:dec-2:0#0',
        desk_tag: 'py-leg-7',
        transaction_type: 'BUY',
        state: 'REJECTED',
      }),
    ],
    decisions: [
      decision({
        decisionId: 'repair:dec-2:0',
        source: 'submit',
        fills: [fill({ deskTag: 'py-leg-7', op: 'close', side: 'Buy', qty: 500, price: 105 })],
      }),
    ],
    books: [book({ legs: [] })],
  })
  await h.run()

  assert.equal(fillOf(h)['qty'], 0)
  assert.equal(h.bookLegs()[0]?.qty, -500, 'the leg the broker refused to close is back')
})

test('a crash mid-correction re-finds THIS tranche’s fill, never its sibling', async () => {
  const h = splitClose()
  await h.run()
  // Exactly what a crash leaves: the fill is corrected, the document is not
  // marked. The re-run must land on the SAME fill — taking "the next unclaimed
  // one" would correct the sibling a second time off one broker answer.
  const order = h.order('repair:dec-1:0#0') as Record<string, unknown>
  delete order['deskReconciled']
  delete order['deskReconciledAt']
  const before = JSON.stringify(h.decisionDoc()?.['fills'])

  const pass = await h.run()
  assert.equal(pass.scanned, 1)
  assert.equal(JSON.stringify(h.decisionDoc()?.['fills']), before, 'no fill is corrected twice')
  assert.equal(h.order('repair:dec-1:0#0')?.['deskReconciled'], true)
  // AND IT IS NOT CONDEMNED EITHER. Both fills are claimed by now, so a reader
  // that only took UNCLAIMED candidates would find none and file this order
  // unjoinable — a false alarm, and a fold that could never be retried.
  assert.deepEqual(unjoinable(h), [])
})

test('the order id survives a decision id containing dots', () => {
  // `/v1/desk/submit` takes the CALLER's own clientOrderId as the decision id,
  // and a caller may legitimately put a dot in it. Stripping at the FIRST dot
  // filed every one of those orders as unjoinable, forever.
  assert.deepEqual(splitOrderId('atr.v2-171#3'), { decisionId: 'atr.v2-171', index: 3 })
  assert.deepEqual(splitOrderId('atr.v2-171#3.2'), { decisionId: 'atr.v2-171', index: 3 })
})

test('only a TRAILING numeric suffix is a tranche — the gateway’s own rule', () => {
  // `gateway.ts:baseClientOrderId` is the writer of these suffixes and this is
  // its regex. The two must not disagree about what an order id means.
  assert.deepEqual(splitOrderId('d1#0'), { decisionId: 'd1', index: 0 })
  assert.deepEqual(splitOrderId('d1#0.12'), { decisionId: 'd1', index: 0 })
  // A NON-numeric suffix is not a tranche, so it stays part of the id and the
  // index reads as unknown — the desk-tag match is then the only answer.
  assert.deepEqual(splitOrderId('d1#0.x'), { decisionId: 'd1', index: -1 })
  assert.deepEqual(splitOrderId('SUB#9#1'), { decisionId: 'SUB#9', index: 1 })
  assert.deepEqual(splitOrderId('plain'), { decisionId: 'plain', index: -1 })
})

// -------------------------------------- a routing decision is not unjoinable

test('a terminal order whose decision is still ROUTING waits, it is not condemned', async () => {
  // `service.ts` claims the id with `fills: []` and fills them in at the
  // completion write. An order that reaches a terminal state inside that window
  // has no fill to join to YET — filing it unjoinable excludes it FOREVER.
  const h = harness({
    decisions: [decision({ status: 'ROUTING', fills: [], plannedFills: [fill()] })],
  })
  const pass = await h.run()

  assert.equal(pass.scanned, 1)
  assert.equal(pass.corrected, 0)
  assert.deepEqual(h.events(), [], 'nothing journalled about a decision still in flight')
  assert.equal(h.order()?.['deskReconciled'], undefined, 'and NOT marked — a later pass retries')
  assert.equal(h.bookLegs().length, 1, 'the book is untouched while routing')
})

test('once the decision completes, the same order reconciles normally', async () => {
  const h = harness({
    decisions: [decision({ status: 'ROUTING', fills: [], plannedFills: [fill()] })],
  })
  await h.run()
  // The completion write lands: `service.ts:621`.
  const d = h.decisionDoc() as Record<string, unknown>
  d['status'] = 'DONE'
  d['fills'] = [fill()]
  d['completedAt'] = NOW

  const pass = await h.run()
  assert.equal(pass.corrected, 1)
  assert.equal(fillOf(h)['qty'], 0)
  assert.deepEqual(h.bookLegs(), [])
  assert.equal(h.order()?.['deskReconciled'], true)
})

// ------------------------- a lost race must never cross zero into a new leg

test('a compensation that loses its race is re-capped against the FRESH legs', async () => {
  // The reduce was sized 500 against the book we read. A winner lands and takes
  // 300 off the leg. Re-applying the full 500 consumes the 200 that is left and
  // then OPENS a +300 leg nobody ordered.
  const h = harness({ books: [book({ legs: [leg({ qty: -500 })] })] })
  const books = h.db.col(COLLECTIONS.books)
  let won = false
  books.beforeUpdateOne = (): void => {
    if (won) return
    won = true
    const doc = books.docs[0] as Record<string, unknown>
    doc['legs'] = [leg({ qty: -200 })]
    doc['updatedAt'] = T0 + 1
  }

  await h.run()

  const legs = h.bookLegs()
  assert.equal(
    legs.filter((l) => l.qty > 0).length,
    0,
    'a correction may never open the other side of the market',
  )
  assert.deepEqual(legs, [], 'exactly the 200 that was left, and not one contract more')
  assert.match(String(h.events()[0]?.['error']), /book reduced by 200/, 'the ACTUAL quantity')
})

test('a compensation whose leg the winner already closed says so honestly', async () => {
  const h = harness({ books: [book({ legs: [leg({ qty: -500 })] })] })
  const books = h.db.col(COLLECTIONS.books)
  let won = false
  books.beforeUpdateOne = (): void => {
    if (won) return
    won = true
    const doc = books.docs[0] as Record<string, unknown>
    doc['legs'] = []
    doc['updatedAt'] = T0 + 1
  }

  await h.run()

  assert.deepEqual(h.bookLegs(), [])
  const event = h.events()[0] as Record<string, unknown>
  assert.match(String(event['error']), /nothing left to reduce/)
  assert.equal(
    (event['detail'] as Record<string, unknown>)['book'],
    'unchanged',
    'reporting "book reduced" when zero was applied is a lie the desk acts on',
  )
})

// ------------------------------------------- a failed fold is never abandoned

test('a fold that loses both races leaves the document for the next pass', async () => {
  const h = harness({ books: [book({ legs: [leg({ qty: -500 })] })] })
  const books = h.db.col(COLLECTIONS.books)
  // Every attempt loses: the version moves under each write.
  books.beforeUpdateOne = (): void => {
    const doc = books.docs[0] as Record<string, unknown>
    doc['updatedAt'] = Number(doc['updatedAt']) + 1
  }

  await h.run()

  const f = fillOf(h)
  assert.equal(f['qty'], 0, 'the decision record is corrected — that write DID land')
  assert.notEqual(f['corrected'], undefined)
  assert.equal(f['foldDone'], false, 'but the book fold did not')
  assert.equal(h.bookLegs()[0]?.qty, -500, 'the phantom leg is still there')
  assert.equal(
    h.order()?.['deskReconciled'],
    undefined,
    'marking it here would abandon the fold FOREVER',
  )
})

test('the next pass retries JUST the fold and finishes the job', async () => {
  const h = harness({ books: [book({ legs: [leg({ qty: -500 })] })] })
  const books = h.db.col(COLLECTIONS.books)
  books.beforeUpdateOne = (): void => {
    const doc = books.docs[0] as Record<string, unknown>
    doc['updatedAt'] = Number(doc['updatedAt']) + 1
  }
  await h.run()
  books.beforeUpdateOne = null

  const pass = await h.run()

  assert.equal(pass.corrected, 1)
  assert.equal(fillOf(h)['qty'], 0, 'the numbers were already corrected — not corrected twice')
  assert.deepEqual(fillOf(h)['corrected'], {
    at: NOW,
    fromQty: 500,
    fromPrice: 100,
    state: 'REJECTED',
    clientOrderId: 'd1#0',
  })
  assert.equal(fillOf(h)['foldDone'], true)
  assert.deepEqual(h.bookLegs(), [], 'the phantom leg is finally gone')
  assert.equal(h.order()?.['deskReconciled'], true)
})

test('a document needing no fold is marked done on the first pass', async () => {
  const h = harness({
    orders: [gatewayOrder({ state: 'FILLED', filledQty: 500, avgPrice: 99.25 })],
  })
  await h.run()
  assert.equal(fillOf(h)['foldDone'], true, 'nothing to fold IS folding done')
  assert.equal(h.order()?.['deskReconciled'], true)
})

test('two fills sharing a desk tag are told apart by the order index', async () => {
  // `applyActions` can emit a resize and a close on the SAME leg tag inside one
  // decision, so `desk_tag` alone is ambiguous. `clientOrderId` is not: its
  // suffix indexes `plannedFills`.
  const planned = [
    fill({ op: 'resize', side: 'Buy', qty: 200, price: 100 }),
    fill({ op: 'close', side: 'Buy', qty: 300, price: 100 }),
  ]
  const h = harness({
    orders: [gatewayOrder({ clientOrderId: 'd1#1', transaction_type: 'BUY' })],
    decisions: [decision({ fills: planned, plannedFills: planned, routeErrors: [] })],
    books: [book({ legs: [] })],
  })
  await h.run()

  const fills = h.decisionDoc()?.['fills'] as Record<string, unknown>[]
  assert.equal(fills[0]?.['qty'], 200, 'the resize is untouched')
  assert.equal(fills[1]?.['qty'], 0, 'the close is the one that was refused')
})
