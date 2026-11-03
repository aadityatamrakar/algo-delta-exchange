/**
 * The wave state machine, driven against fakes — no Mongo, no rail, no clock.
 *
 * Everything this file pins is a SEQUENCING property, and sequencing is the
 * only thing `RepairApplyService` owns: the closes go first, the opens wait for
 * the closes to actually FILL, and anything that is not a fill stops the run
 * where it stands. Each of those is invisible in a passing manual test and
 * catastrophic when wrong — an open that fires before its close lands is a book
 * carrying both legs at once, on real money, with the modal still reading
 * "in progress".
 *
 * The gates (kill switch, allowlist, freeze split, risk caps) are NOT tested
 * here and are not this service's to hold: every order goes through
 * `SubmitService`, so the fake rail's job is to answer like it does — including
 * refusing — and the assertions are about what the service DOES with the
 * answer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketableFromEnv, marketableLimit } from '../src/marketable.ts'
import type { PlannedOrder } from '../src/repair-plan.ts'
import type { SubmitRequestBody, SubmitResponse } from '../src/submit.ts'
import type { Collection, Database, FindCursor, UpdateOutcome } from '../src/store.ts'
import { COLLECTIONS, DeskStore } from '../src/store.ts'
import {
  REPAIR_HOLD_GRACE_MS,
  REPAIR_HOLD_MS,
  RepairApplyService,
  repairHoldLookup,
  type OrderRail,
  type RepairQuote,
  type RunDoc,
} from '../src/repair-apply.ts'

// ------------------------------------------------------------------ the store

class FakeCursor<T> implements FindCursor<T> {
  readonly #rows: T[]
  constructor(rows: T[]) {
    this.#rows = rows
  }
  sort(): FindCursor<T> {
    return this
  }
  limit(): FindCursor<T> {
    return this
  }
  skip(): FindCursor<T> {
    return this
  }
  async toArray(): Promise<T[]> {
    return this.#rows
  }
}

/**
 * What `createIndex` was asked to build, as the fake enforces it.
 *
 * ALL the spec's fields, not the first: `harness` builds the REAL index set, so
 * a fake that read `{tag, mode}` as unique on `tag` alone would raise 11000 on
 * the second variant of one tag — a duplicate Mongo would never report, failing
 * a test over the fake's own shortcut.
 */
interface FakeIndex {
  readonly keys: string[]
  /** The partial filter, or null for a whole-collection unique index. */
  readonly filter: Record<string, unknown> | null
  /** Sparse leaves documents MISSING the key out of the index entirely. */
  readonly sparse: boolean
}

/**
 * Just enough Mongo to be honest about the two claims the run doc leans on.
 *
 * `_id` is UNIQUE — that is the whole-run idempotency claim. And a UNIQUE index
 * with a `partialFilterExpression` is unique only among the documents that
 * MATCH it, which is what makes "one RUNNING run per tag" a claim rather than a
 * hope. Both throw 11000 exactly as the driver does. A fake that let either
 * second insert through would prove a race safe that in production is not, and
 * the race is the whole reason the index exists.
 */
class FakeCollection<T extends Record<string, unknown>> implements Collection<T> {
  readonly docs: T[] = []
  /**
   * Fires INSIDE `insertOne`, before the write, once.
   *
   * It is the only way to stand inside the window a concurrent process races
   * through — between this executor's read and its write — and both claims
   * this module makes (the `_id` claim and the tag claim) are only worth
   * anything if they hold in exactly that window.
   */
  beforeInsert: (() => Promise<void>) | null = null
  /** Set to make reads fail, the way an unreachable Mongo does. */
  failReads = false
  /** Every `createIndex` this collection was asked for, in order. */
  readonly built: { spec: Record<string, 1 | -1>; options?: Record<string, unknown> }[] = []
  /** Set to make an index BUILD fail, the way a dirty collection does. */
  failIndexWith: Error | null = null
  readonly #unique: FakeIndex[] = []

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    if (this.failReads) throw new Error('no primary available')
    return this.docs.find((d) => matches(d, filter)) ?? null
  }
  find(filter: Record<string, unknown>): FindCursor<T> {
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)))
  }
  async insertOne(doc: T): Promise<unknown> {
    const hook = this.beforeInsert
    if (hook !== null) {
      this.beforeInsert = null
      await hook()
    }
    if (this.docs.some((d) => d['_id'] === doc['_id'])) throw duplicateKey()
    for (const index of this.#unique) {
      // A partial index ignores documents outside its filter, and a sparse one
      // ignores documents missing the key — on BOTH sides of the comparison.
      const covered = (d: Record<string, unknown>): boolean =>
        (index.filter === null || matches(d, index.filter)) &&
        !(index.sparse && index.keys.some((k) => d[k] === undefined))
      if (!covered(doc)) continue
      // Every field of the spec, and a missing one compares as Mongo indexes
      // it — as null, so two documents both missing it DO collide.
      const same = (d: Record<string, unknown>): boolean =>
        index.keys.every((k) => d[k] === doc[k])
      if (this.docs.some((d) => covered(d) && same(d))) throw duplicateKey()
    }
    this.docs.push({ ...doc })
    return {}
  }
  async insertMany(docs: readonly T[]): Promise<unknown> {
    for (const d of docs) await this.insertOne(d)
    return {}
  }
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<UpdateOutcome> {
    const i = this.docs.findIndex((d) => matches(d, filter))
    if (i < 0) return { matchedCount: 0 }
    const set = (update['$set'] ?? {}) as Record<string, unknown>
    this.docs[i] = { ...this.docs[i], ...set } as T
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
  async createIndex(
    spec: Record<string, 1 | -1>,
    options?: {
      unique?: boolean
      sparse?: boolean
      partialFilterExpression?: Record<string, unknown>
    },
  ): Promise<unknown> {
    /**
     * A DUPLICATE-KEY REFUSAL IS A UNIQUE INDEX'S ANSWER, and only its.
     *
     * The dirty-collection case is "these rows are what the UNIQUE index
     * forbids"; a plain index has nothing to be duplicate about, and a fake
     * that raised 11000 for one would fail a build Mongo completes without
     * comment. Any OTHER failure — no permission, no connection — is about the
     * database and applies to every build.
     */
    const fail = this.failIndexWith
    const duplicate = (fail as { code?: unknown } | null)?.code === 11000
    if (fail !== null && (!duplicate || options?.unique === true)) throw fail
    this.built.push({ spec, ...(options === undefined ? {} : { options }) })
    if (options?.unique === true) {
      this.#unique.push({
        keys: Object.keys(spec),
        filter: options.partialFilterExpression ?? null,
        sparse: options.sparse === true,
      })
    }
    return {}
  }
  async dropIndex(): Promise<unknown> {
    return {}
  }
}

function duplicateKey(): Error {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
}

/**
 * Equality, plus the two operators the HOLD read actually makes: `$or` (the
 * running claim, or a run that ended inside the adoption grace) and a numeric
 * `$gte` on `updatedAt`. Deliberately nothing else — a fake that grew a query
 * language would stop being evidence about the queries this module writes.
 */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') {
      return Array.isArray(v) && v.some((sub) => matches(doc, sub as Record<string, unknown>))
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const actual = doc[k]
      return Object.entries(v as Record<string, unknown>).every(
        ([op, operand]) =>
          op === '$gte' && typeof actual === 'number' && typeof operand === 'number' && actual >= operand,
      )
    }
    return doc[k] === v
  })
}

class FakeDb implements Database {
  readonly #cols = new Map<string, FakeCollection<Record<string, unknown>>>()
  collection<T = Record<string, unknown>>(name: string): Collection<T> {
    let col = this.#cols.get(name)
    if (col === undefined) {
      col = new FakeCollection()
      this.#cols.set(name, col)
    }
    return col as unknown as Collection<T>
  }
  runs(): FakeCollection<Record<string, unknown>> {
    return this.collection(COLLECTIONS.repairApplies) as unknown as FakeCollection<
      Record<string, unknown>
    >
  }
}

// ------------------------------------------------------------------- the rail

const acceptedBy = (req: SubmitRequestBody): SubmitResponse => ({
  accepted: true,
  status: 'DONE',
  clientOrderId: req.clientOrderId,
  orders: [],
  replayed: false,
  routedLots: req.lots,
  lots: req.lots,
  intendedLots: req.lots,
  requestedLots: req.lots,
  freezeMaxLots: null,
  errors: [],
})

class FakeRail implements OrderRail {
  readonly seen: SubmitRequestBody[] = []
  reply: (req: SubmitRequestBody) => SubmitResponse = acceptedBy
  async submit(req: SubmitRequestBody): Promise<SubmitResponse> {
    this.seen.push(req)
    return this.reply(req)
  }
  ids(): string[] {
    return this.seen.map((r) => r.clientOrderId)
  }
}

// --------------------------------------------------------------- the fixtures

const TAG = 'TCS_REPAIR'
const EXPIRY = '2026-08-26'
const T0 = 1_755_760_000_000
const QUOTE: RepairQuote = { bid: 12.3, ask: 12.5, mid: 12.4, tickSize: 0.05 }

const contract = (tradingsymbol: string): PlannedOrder['instrument'] => ({
  tradingsymbol,
  instrumentToken: 42,
  lotSize: 175,
  tickSize: 0.05,
  exchange: 'NFO',
})

const planned = (
  wave: 'close' | 'open',
  side: 'Buy' | 'Sell',
  tradingsymbol: string,
  extra: Partial<PlannedOrder> = {},
): PlannedOrder => ({
  wave,
  moveIndex: 0,
  side,
  instrument: contract(tradingsymbol),
  strike: 2280,
  type: 'PE',
  expiry: EXPIRY,
  lots: 1,
  reducesExposure: wave === 'close',
  ...extra,
})

const CLOSE = planned('close', 'Buy', 'TCS26AUG2280PE')
const OPEN = planned('open', 'Sell', 'TCS26AUG2260PE')

/** A run doc as some OTHER process left it — seeded straight into the store. */
const runningDoc = (
  id: string,
  tag: string = TAG,
  createdAt: number = T0,
): Record<string, unknown> => ({
  _id: id,
  tag,
  mode: 'paper',
  style: 'fast',
  bookPrint: 'print-0',
  state: 'RUNNING',
  orders: [],
  createdAt,
  updatedAt: createdAt,
})

/**
 * A run as it stands once it has ENDED, carrying the ledger a real one carries.
 *
 * The orders matter: the grace exists for the legs a run actually placed, and a
 * run that placed nothing never owned the book to begin with.
 */
const endedDoc = (
  id: string,
  state: 'DONE' | 'HALTED',
  updatedAt: number,
  createdAt: number = T0,
): Record<string, unknown> => ({
  ...runningDoc(id, TAG, createdAt),
  state,
  updatedAt,
  orders: [{ clientOrderId: `repair:${id}:0`, wave: 'close', planned: CLOSE, status: 'FILLED' }],
})

interface Harness {
  readonly svc: RepairApplyService
  readonly rail: FakeRail
  readonly db: FakeDb
  /** Per-`clientOrderId` script for `fillState`; anything unlisted fills. */
  readonly fills: Map<string, 'PENDING' | 'FILLED' | 'FAILED'>
}

/**
 * The fake carries the REAL index set: `DeskStore.ensureIndexes` builds it, the
 * same call the API makes on boot.
 *
 * Declaring the indexes by hand here would be the flaw the tag race got through
 * the first time — a fake whose uniqueness is whatever the test remembered to
 * model proves nothing about the claim the database actually enforces.
 */
async function harness(
  over: { quote?: (tradingsymbol: string) => RepairQuote | null; maxWaveMs?: number } = {},
): Promise<Harness> {
  const db = new FakeDb()
  await new DeskStore(db).ensureIndexes()
  const rail = new FakeRail()
  const fills = new Map<string, 'PENDING' | 'FILLED' | 'FAILED'>()
  const svc = new RepairApplyService({
    db,
    rail,
    now: () => T0,
    log: () => undefined,
    quote: over.quote ?? ((): RepairQuote | null => QUOTE),
    fillState: async (_mode, clientOrderId): Promise<'PENDING' | 'FILLED' | 'FAILED'> =>
      fills.get(clientOrderId) ?? 'FILLED',
    pollMs: 1,
    maxWaveMs: over.maxWaveMs ?? 300_000,
  })
  return { svc, rail, db, fills }
}

/** The modal's own loop: poll `status` until the run leaves RUNNING. */
async function settle(svc: RepairApplyService, applyId: string): Promise<RunDoc> {
  for (let i = 0; i < 3000; i += 1) {
    const doc = await svc.status(applyId)
    if (doc !== null && doc.state !== 'RUNNING') return doc
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`run ${applyId} never left RUNNING`)
}

const start = async (
  h: Harness,
  applyId: string,
  orders: readonly PlannedOrder[],
  style: 'fast' | 'limit' = 'fast',
): ReturnType<RepairApplyService['start']> =>
  await h.svc.start({ tag: TAG, mode: 'paper', style, bookPrint: 'print-1', applyId, orders })

// ------------------------------------------------------------------ the tests

test('the open wave waits for the closes to FILL, and the run ends DONE', async () => {
  const h = await harness()
  const closeId = 'repair:A1:0'
  /**
   * The close reports PENDING twice before it fills, and every one of those
   * polls records what the rail had seen by then. This is the whole point of
   * the service: an open that goes out during that window is a book holding
   * both legs at once.
   */
  let polls = 0
  const seenWhilePending: number[] = []
  const svc = new RepairApplyService({
    db: h.db,
    rail: h.rail,
    now: () => T0,
    log: () => undefined,
    quote: () => QUOTE,
    fillState: async (_mode, id) => {
      if (id !== closeId) return 'FILLED'
      polls += 1
      if (polls <= 2) {
        seenWhilePending.push(h.rail.seen.length)
        return 'PENDING'
      }
      return 'FILLED'
    },
    pollMs: 1,
  })

  const started = await svc.start({
    tag: TAG,
    mode: 'paper',
    style: 'fast',
    bookPrint: 'print-1',
    applyId: 'A1',
    orders: [CLOSE, OPEN],
  })
  assert.equal(started.ok, true)
  const done = await settle(svc, 'A1')

  assert.deepEqual(seenWhilePending, [1, 1])
  assert.equal(done.state, 'DONE')
  assert.equal(done.haltReason, undefined)
  assert.deepEqual(
    done.orders.map((o) => o.status),
    ['FILLED', 'FILLED'],
  )
  assert.deepEqual(h.rail.ids(), ['repair:A1:0', 'repair:A1:1'])
  assert.deepEqual(
    h.rail.seen.map((r) => r.side),
    ['Buy', 'Sell'],
  )
})

test('a second run on a tag that is already RUNNING is refused, and nothing is submitted', async () => {
  // The ORDINARY case — an operator clicking Apply while their own run is
  // going — answered by the courtesy scan, before any insert is attempted. The
  // race that scan cannot see is the index's job, two tests below.
  const h = await harness()
  await h.db.runs().insertOne(runningDoc('EARLIER'))

  const refused = await start(h, 'A2', [CLOSE, OPEN])
  assert.equal(refused.ok, false)
  if (refused.ok) throw new Error('unreachable')
  assert.match(refused.reason, /EARLIER/)
  assert.deepEqual(h.rail.ids(), [])
  assert.equal(await h.svc.status('A2'), null)
})

test('a close that does not fill halts the run, and the open never leaves QUEUED', async () => {
  const h = await harness()
  h.fills.set('repair:A3:0', 'FAILED')

  await start(h, 'A3', [CLOSE, OPEN])
  const halted = await settle(h.svc, 'A3')

  assert.equal(halted.state, 'HALTED')
  assert.match(halted.haltReason ?? '', /repair:A3:0/)
  assert.equal(halted.orders[0]?.status, 'FAILED')
  assert.equal(halted.orders[1]?.status, 'QUEUED')
  assert.deepEqual(h.rail.ids(), ['repair:A3:0'])
})

test('a rail refusal is recorded verbatim on the order and halts the run', async () => {
  const h = await harness()
  h.rail.reply = (req): SubmitResponse => ({
    accepted: false,
    status: 'DONE',
    clientOrderId: req.clientOrderId,
    reason: 'live not allowed',
    replayed: false,
    routedLots: 0,
  })

  await start(h, 'A4', [CLOSE, OPEN])
  const halted = await settle(h.svc, 'A4')

  assert.equal(halted.state, 'HALTED')
  assert.equal(halted.orders[0]?.status, 'FAILED')
  assert.equal(halted.orders[0]?.detail, 'live not allowed')
  assert.equal(halted.orders[1]?.status, 'QUEUED')
  assert.match(halted.haltReason ?? '', /live not allowed/)
  assert.deepEqual(h.rail.ids(), ['repair:A4:0'])
})

test('a wave that never fills ages out rather than waiting forever', async () => {
  const h = await harness({ maxWaveMs: 300_000 })
  let clock = T0
  const svc = new RepairApplyService({
    db: h.db,
    rail: h.rail,
    now: () => clock,
    log: () => undefined,
    quote: () => QUOTE,
    // Every poll advances the clock, so the run reaches the age limit in a
    // handful of iterations instead of in real seconds.
    fillState: async () => {
      clock += 100_000
      return 'PENDING'
    },
    pollMs: 1,
    maxWaveMs: 300_000,
  })

  await svc.start({
    tag: TAG,
    mode: 'paper',
    style: 'fast',
    bookPrint: 'print-1',
    applyId: 'A5',
    orders: [CLOSE, OPEN],
  })
  const halted = await settle(svc, 'A5')

  assert.equal(halted.state, 'HALTED')
  assert.match(halted.haltReason ?? '', /aged out waiting on fills/)
  assert.equal(halted.orders[0]?.status, 'SUBMITTED')
  assert.equal(halted.orders[1]?.status, 'QUEUED')
  assert.deepEqual(h.rail.ids(), ['repair:A5:0'])
})

test('clientOrderIds are the applyId and the index, in WAVE order whatever order the plan arrived in', async () => {
  const h = await harness()
  // Deliberately open-first: the ids number the EXECUTION order, and the
  // executor owns that order rather than inheriting the caller's array.
  await start(h, 'A6', [OPEN, CLOSE])
  const done = await settle(h.svc, 'A6')

  assert.deepEqual(
    done.orders.map((o) => o.clientOrderId),
    ['repair:A6:0', 'repair:A6:1'],
  )
  assert.deepEqual(
    done.orders.map((o) => o.wave),
    ['close', 'open'],
  )
  assert.deepEqual(h.rail.ids(), ['repair:A6:0', 'repair:A6:1'])
})

test('fast prices through the touch; limit prices the mid on the tick', async () => {
  const cfg = { ...marketableFromEnv(), tickSize: 0.05 }

  const fast = await harness()
  await start(fast, 'A7', [CLOSE, OPEN], 'fast')
  await settle(fast.svc, 'A7')
  // The BUY lifts the ask and the SELL hits the bid — each stepped through by
  // the same buffer every other desk order pays.
  assert.equal(fast.rail.seen[0]?.limitPrice, marketableLimit('Buy', 12.5, cfg, false))
  assert.equal(fast.rail.seen[1]?.limitPrice, marketableLimit('Sell', 12.3, cfg, false))

  const mid = await harness()
  await start(mid, 'A7L', [CLOSE, OPEN], 'limit')
  await settle(mid.svc, 'A7L')
  // Half-to-nearest, never toward the operator: rounding a buy DOWN and a sell
  // UP would quietly improve the price and stop the order filling.
  assert.equal(mid.rail.seen[0]?.limitPrice, 12.4)
  assert.equal(mid.rail.seen[1]?.limitPrice, 12.4)
})

test('an unquoted contract halts the wave BEFORE anything in it is submitted', async () => {
  const h = await harness({
    quote: (tradingsymbol) => (tradingsymbol === OPEN.instrument.tradingsymbol ? null : QUOTE),
  })
  // The close still executes — it is a wave of its own and it priced fine —
  // and the open wave stops dead rather than pricing off a guess.
  await start(h, 'A8', [CLOSE, OPEN])
  const halted = await settle(h.svc, 'A8')

  assert.equal(halted.state, 'HALTED')
  assert.match(halted.haltReason ?? '', /no quote/)
  assert.equal(halted.orders[1]?.status, 'FAILED')
  assert.deepEqual(h.rail.ids(), ['repair:A8:0'])

  // And the same refusal inside the FIRST wave places nothing at all.
  const cold = await harness({ quote: () => null })
  await start(cold, 'A8C', [CLOSE, OPEN])
  const dead = await settle(cold.svc, 'A8C')
  assert.equal(dead.state, 'HALTED')
  assert.deepEqual(cold.rail.ids(), [])
})

test('the hold is the RUNNING run, and it expires with the TTL', async () => {
  const h = await harness()
  await h.db.runs().insertOne(runningDoc('HOLD1'))

  assert.deepEqual(await h.svc.activeHold(TAG), {
    applyId: 'HOLD1',
    heldAt: T0,
    untilMs: T0 + REPAIR_HOLD_MS,
  })
  assert.equal(await h.svc.activeHold('SOMEONE_ELSE'), null)

  // The standalone lookup answers identically — it is what the positions route
  // reads, and a second implementation there would be a hold that disagrees
  // with the run that owns it.
  const lookup = repairHoldLookup(h.db, () => T0)
  assert.deepEqual(await lookup(TAG), { applyId: 'HOLD1', heldAt: T0, untilMs: T0 + REPAIR_HOLD_MS })
  assert.equal(await repairHoldLookup(h.db, () => T0 + REPAIR_HOLD_MS + 1)(TAG), null)

  // This one placed NOTHING, so ending it releases the book at once — there
  // are no legs for the driver to adopt and so no grace to serve. A run that
  // did place something goes on holding; see the grace tests below.
  await h.db.runs().updateOne({ _id: 'HOLD1' }, { $set: { state: 'DONE' } })
  assert.equal(await h.svc.activeHold(TAG), null)
})

// ------------------------------------------------ the hold after the run ends

test('a DONE run goes on holding its book for the driver’s adoption grace', async () => {
  const h = await harness()
  // The closes landed on the bridge's book the moment they filled; the driver
  // adopts the legs the opens created only on a LATER tick (`adopt_manual_legs`
  // needs the same id twice). A hold that ended with the run would put the
  // supervisor in front of a book missing what was closed and not yet holding
  // what was opened — and it decides.
  await h.db.runs().insertOne(endedDoc('ENDED', 'DONE', T0))

  assert.deepEqual(await repairHoldLookup(h.db, () => T0 + REPAIR_HOLD_GRACE_MS - 1)(TAG), {
    applyId: 'ENDED',
    heldAt: T0,
    untilMs: T0 + REPAIR_HOLD_GRACE_MS,
  })
  // And it ends there — the grace is a window, not a second TTL.
  assert.equal(await repairHoldLookup(h.db, () => T0 + REPAIR_HOLD_GRACE_MS + 1)(TAG), null)
})

test('a HALTED run holds for the same grace — a half-executed plan needs it most', async () => {
  const h = await harness()
  await h.db.runs().insertOne(endedDoc('STOPPED', 'HALTED', T0))

  assert.equal((await repairHoldLookup(h.db, () => T0 + 1)(TAG))?.applyId, 'STOPPED')
  assert.equal(await repairHoldLookup(h.db, () => T0 + REPAIR_HOLD_GRACE_MS + 1)(TAG), null)
})

test('the grace never extends the TTL — the absolute backstop still wins', async () => {
  const h = await harness()
  // A run that ended exactly at its hold window. `updatedAt + GRACE` would say
  // another 90 seconds; the TTL is the number that must survive, because it is
  // what stops a stranded document speaking for a live book.
  await h.db.runs().insertOne(endedDoc('LATE', 'HALTED', T0, T0 - REPAIR_HOLD_MS))

  assert.equal((await repairHoldLookup(h.db, () => T0)(TAG))?.untilMs, T0)
  assert.equal(await repairHoldLookup(h.db, () => T0 + 1)(TAG), null)
})

test('the grace holds the DRIVER and blocks no new apply — two predicates, deliberately', async () => {
  const h = await harness()
  await h.db.runs().insertOne(endedDoc('ENDED', 'DONE', T0))

  // Held, for the supervisor…
  assert.equal((await h.svc.activeHold(TAG))?.applyId, 'ENDED')
  // …and not held at all against the operator, whose next plan is resolved
  // against the bridge's own book, which is up to date the instant a fill lands.
  const started = await start(h, 'NEXT', [CLOSE, OPEN])
  assert.equal(started.ok, true)
  assert.equal((await settle(h.svc, 'NEXT')).state, 'DONE')
  assert.deepEqual(h.rail.ids(), ['repair:NEXT:0', 'repair:NEXT:1'])
})

test('a run that placed nothing holds nothing — an empty plan never owned the book', async () => {
  const h = await harness()
  const started = await start(h, 'NOTHING', [])
  assert.equal(started.ok, true)
  assert.equal(await h.svc.activeHold(TAG), null)
})

test('a restart halts every run that was in flight', async () => {
  const h = await harness()
  for (const id of ['B1', 'B2']) await h.db.runs().insertOne(runningDoc(id, `${TAG}_${id}`))
  await h.db.runs().insertOne({ ...runningDoc('B3', `${TAG}_B3`), state: 'DONE' })

  await h.svc.haltStaleRunsOnBoot()

  for (const id of ['B1', 'B2']) {
    const doc = await h.svc.status(id)
    assert.equal(doc?.state, 'HALTED')
    assert.match(doc?.haltReason ?? '', /restart/)
  }
  assert.equal((await h.svc.status('B3'))?.state, 'DONE')
  assert.equal((await h.svc.status('B3'))?.haltReason, undefined)
})

test('every order goes out as a repair-authored, exactly-sized, non-resting LIMIT', async () => {
  const h = await harness()
  await start(h, 'A10', [CLOSE, OPEN])
  await settle(h.svc, 'A10')

  assert.equal(h.rail.seen.length, 2)
  for (const req of h.rail.seen) {
    assert.equal(req.origin, 'repair')
    assert.equal(req.orderType, 'LIMIT')
    assert.equal(req.exactLots, true)
    assert.equal(req.tag, TAG)
    assert.equal(req.mode, 'paper')
    assert.equal(req.lots, 1)
    assert.ok((req.limitPrice ?? 0) > 0)
    // A resting fill never folds into the book (submit.ts's F12 gap), and a leg
    // the book does not hold is a leg the Python driver cannot adopt.
    assert.equal('resting' in req, false)
    assert.deepEqual(req.instrument, contract(req.instrument.tradingsymbol))
  }
  // The close asserts it is an exit — that is what carries it past the kill
  // switch. The open carries whatever the plan netted out.
  assert.equal(h.rail.seen[0]?.reducesExposure, true)
  assert.equal(h.rail.seen[1]?.reducesExposure, false)
})

test('a close rides the leg’s own desk tag onto its fill; an open carries none', async () => {
  const h = await harness()
  const close = planned('close', 'Buy', 'TCS26AUG2280PE', { deskTag: 'py-leg-7' })
  await start(h, 'A10-TAG', [close, OPEN])
  await settle(h.svc, 'A10-TAG')

  // The equality the Python driver's absorb path keys on: the fill's deskTag
  // IS the driver's leg id, so the close it just saw books that leg's realized
  // P&L instead of dropping it with "P&L is NOT booked".
  assert.equal(h.rail.seen[0]?.fillDeskTag, 'py-leg-7')
  // An open closes nothing, so it names nothing — the fill's own tranche id
  // becomes the new leg's identity, exactly as every other order's does.
  assert.equal('fillDeskTag' in (h.rail.seen[1] ?? {}), false)
})

test('a PARTIAL route halts the run, and the routed size is read in LOTS', async () => {
  const twoLots = planned('close', 'Buy', 'TCS26AUG2280PE', { lots: 2 })

  const h = await harness()
  h.rail.reply = (req): SubmitResponse => ({
    accepted: true,
    // `accepted: true, status: 'FAILED'` is submit.ts's PARTIAL: one tranche of
    // two reached a rail, so the book moved by a size nobody chose.
    status: 'FAILED',
    clientOrderId: req.clientOrderId,
    orders: [],
    replayed: false,
    routedLots: 1,
    lots: 1,
    intendedLots: req.lots,
    requestedLots: req.lots,
    freezeMaxLots: null,
    errors: ['tranche 2 was rejected'],
  })

  await start(h, 'A13', [twoLots, OPEN])
  const halted = await settle(h.svc, 'A13')
  assert.equal(halted.state, 'HALTED')
  assert.equal(halted.orders[0]?.status, 'FAILED')
  assert.equal(halted.orders[0]?.detail, 'only 1 of 2 lots reached the rail')
  assert.equal(halted.orders[1]?.status, 'QUEUED')
  assert.deepEqual(h.rail.ids(), ['repair:A13:0'])

  // LOTS on both sides of that comparison. The default reply routes `req.lots`
  // — 2 — and the run proceeds; 350, the same size in SHARES, would not.
  const whole = await harness()
  await start(whole, 'A13W', [twoLots])
  assert.equal((await settle(whole.svc, 'A13W')).state, 'DONE')
  assert.equal(whole.rail.seen[0]?.lots, 2)
})

test('an unknown submit outcome is recorded as unknown, never as "refused"', async () => {
  // A THROW. `submit` answers refusals in the body, so a throw means something
  // broke around it — and by then the claim may be written and the order may be
  // at the broker. "Nothing was sent" is what talks an operator into sending it
  // a second time.
  const threw = await harness()
  threw.rail.reply = (): SubmitResponse => {
    throw new Error('mongo went away mid-claim')
  }
  await start(threw, 'A14', [CLOSE, OPEN])
  const afterThrow = await settle(threw.svc, 'A14')
  assert.equal(afterThrow.state, 'HALTED')
  assert.equal(afterThrow.orders[0]?.status, 'FAILED')
  assert.match(afterThrow.orders[0]?.detail ?? '', /submit outcome unknown/)
  assert.match(afterThrow.orders[0]?.detail ?? '', /mongo went away mid-claim/)
  assert.match(afterThrow.haltReason ?? '', /submit outcome unknown/)
  assert.equal(afterThrow.orders[1]?.status, 'QUEUED')

  // The INDETERMINATE reply is the same fact in the body instead of in a throw.
  const routing = await harness()
  routing.rail.reply = (req): SubmitResponse => ({
    accepted: false,
    status: 'ROUTING',
    indeterminate: true,
    clientOrderId: req.clientOrderId,
    reason: 'claimed but has not reported back',
    replayed: true,
    intendedLots: req.lots,
    plannedOrders: [],
  })
  await start(routing, 'A15', [CLOSE, OPEN])
  const afterRouting = await settle(routing.svc, 'A15')
  assert.equal(afterRouting.state, 'HALTED')
  assert.match(afterRouting.orders[0]?.detail ?? '', /submit outcome unknown/)
  assert.match(afterRouting.orders[0]?.detail ?? '', /claimed but has not reported back/)
  assert.equal(afterRouting.orders[1]?.status, 'QUEUED')
})

test('a duplicate claim on one applyId hands back the winner and executes nothing', async () => {
  const h = await harness()
  // Another process claims the id between our read and our write — the exact
  // window the `_id` unique index exists for.
  h.db.runs().beforeInsert = async () => {
    await h.db.runs().insertOne({ ...runningDoc('A16'), bookPrint: 'the-winner' })
  }

  const started = await start(h, 'A16', [CLOSE, OPEN])
  assert.equal(started.ok, true)
  if (!started.ok) throw new Error('unreachable')
  assert.equal(started.run.bookPrint, 'the-winner')
  assert.deepEqual(started.run.orders, [])

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(h.rail.ids(), [])
})

test('the tag claim is the INDEX: a rival that inserts first wins, whatever its createdAt', async () => {
  const h = await harness()
  /**
   * The race an advisory scan could not close, reproduced: the rival is OLDER
   * (`createdAt` before ours) and it lands in the window between our read and
   * our write. A rule that compared ages after the fact would have each side
   * decide it had won — this one is decided by the write, and the writer that
   * gets there first keeps the book.
   */
  h.db.runs().beforeInsert = async () => {
    await h.db.runs().insertOne(runningDoc('EARLIER', TAG, T0 - 1))
  }

  const refused = await start(h, 'LATER', [CLOSE, OPEN])
  assert.equal(refused.ok, false)
  if (refused.ok) throw new Error('unreachable')
  assert.match(refused.reason, /already running/)
  assert.match(refused.reason, /EARLIER/)
  assert.deepEqual(h.rail.ids(), [])
  // Refused means UNCLAIMED: no document is left behind under our applyId for
  // a later poll to find and mistake for a run.
  assert.equal(await h.svc.status('LATER'), null)

  // And the same when the rival is YOUNGER. Age has no vote: the index does
  // not have one to give it.
  const younger = await harness()
  younger.db.runs().beforeInsert = async () => {
    await younger.db.runs().insertOne(runningDoc('NEWER', TAG, T0 + 5_000))
  }
  const alsoRefused = await start(younger, 'OURS', [CLOSE, OPEN])
  assert.equal(alsoRefused.ok, false)
  assert.deepEqual(younger.rail.ids(), [])
})

test('a run on ANOTHER tag is never blocked, and a finished run releases its own', async () => {
  const h = await harness()
  await h.db.runs().insertOne(runningDoc('OTHER_BOOK', 'DESK_ELSEWHERE'))
  // The partial filter is what keeps this true: every past run keeps its row,
  // so a plain unique index on `tag` would let a book be repaired exactly once.
  await h.db.runs().insertOne({ ...runningDoc('YESTERDAY', TAG, T0 - 86_400_000), state: 'DONE' })

  const started = await start(h, 'TODAY', [CLOSE, OPEN])
  assert.equal(started.ok, true)
  assert.equal((await settle(h.svc, 'TODAY')).state, 'DONE')

  // And with that one finished, the tag takes another run.
  const next = await start(h, 'TOMORROW', [CLOSE])
  assert.equal(next.ok, true)
  assert.equal((await settle(h.svc, 'TOMORROW')).state, 'DONE')
})

test('a stranded claim is reaped rather than locking its book out of repair forever', async () => {
  const h = await harness()
  // The index knows nothing about the hold window, so a RUNNING row from a
  // dead process would refuse every future apply on this book. It is HALTED —
  // which releases it from the partial index — and the insert retried.
  await h.db.runs().insertOne(runningDoc('STRANDED', TAG, T0 - REPAIR_HOLD_MS - 1))

  const started = await start(h, 'A20', [CLOSE, OPEN])
  assert.equal(started.ok, true)
  assert.equal((await settle(h.svc, 'A20')).state, 'DONE')
  assert.deepEqual(h.rail.ids(), ['repair:A20:0', 'repair:A20:1'])

  const reaped = await h.svc.status('STRANDED')
  assert.equal(reaped?.state, 'HALTED')
  assert.match(reaped?.haltReason ?? '', /aged out of its hold window/)
})

test('an empty plan claims nothing, so it neither conflicts nor holds the book', async () => {
  const h = await harness()
  await h.db.runs().insertOne(runningDoc('BUSY'))

  // Nothing to place means no book to protect: it is DONE on arrival, outside
  // the partial index, and it reports that consistently in the doc and in hand.
  const started = await start(h, 'EMPTY', [])
  assert.equal(started.ok, true)
  if (!started.ok) throw new Error('unreachable')
  assert.equal(started.run.state, 'DONE')
  assert.equal(started.run.haltReason, undefined)
  assert.equal((await h.svc.status('EMPTY'))?.state, 'DONE')
  assert.deepEqual(h.rail.ids(), [])
  // The busy run still owns the tag — an empty plan did not take it away.
  assert.equal((await h.svc.activeHold(TAG))?.applyId, 'BUSY')
})

test('ensureIndexes builds the claim as a UNIQUE index partial on RUNNING', async () => {
  const db = new FakeDb()
  await new DeskStore(db).ensureIndexes()

  // Found by its OPTIONS, not by its key: the collection carries a second
  // `{tag, …}` index now, and a positional `find` would silently start
  // asserting about whichever one was built first.
  const claim = db.runs().built.find((i) => i.options?.['unique'] === true)
  assert.notEqual(claim, undefined, 'desk-repair-applies must carry a {tag} claim index')
  assert.deepEqual(claim?.spec, { tag: 1 })
  assert.deepEqual(claim?.options, {
    unique: true,
    partialFilterExpression: { state: 'RUNNING' },
  })
})

test('and a {tag, updatedAt} index, because the hold read cannot use the partial one', async () => {
  const db = new FakeDb()
  await new DeskStore(db).ensureIndexes()

  // The grace fallback asks for runs that are RUNNING *or* were updated inside
  // the window — a query the RUNNING-only partial index cannot serve — and it
  // is asked on essentially every positions poll of every book.
  const hold = db.runs().built.find((i) => i.spec['updatedAt'] === -1)
  assert.notEqual(hold, undefined, 'the hold read must have an index of its own')
  assert.deepEqual(hold?.spec, { tag: 1, updatedAt: -1 })
  assert.equal(hold?.options?.['unique'], undefined, 'many runs per tag — that is the point')
})

test('the fake enforces the real index set — compound keys compound, sparse stays sparse', async () => {
  // The fake is load-bearing now: `harness` builds the REAL indexes against it,
  // so a shortcut here becomes a duplicate-key error Mongo would never raise,
  // in some other test, over data that is perfectly legal.
  const db = new FakeDb()
  await new DeskStore(db).ensureIndexes()

  const books = db.collection(COLLECTIONS.books)
  await books.insertOne({ _id: 'b1', tag: TAG, mode: 'paper' })
  // {tag, mode} is UNIQUE on BOTH fields: two variants of one tag in different
  // modes are the point of running an A/B, and must not collide.
  await books.insertOne({ _id: 'b2', tag: TAG, mode: 'live' })
  await assert.rejects(
    async () => await books.insertOne({ _id: 'b3', tag: TAG, mode: 'paper' }),
    /E11000/,
  )

  // SPARSE: rows written before `clientOrderId` existed carry none, and two
  // missing keys must not collide — that is the whole reason it is sparse.
  const paper = db.collection(COLLECTIONS.paperTrade)
  await paper.insertOne({ _id: 'p1' })
  await paper.insertOne({ _id: 'p2' })
  await paper.insertOne({ _id: 'p3', clientOrderId: 'x' })
  await assert.rejects(
    async () => await paper.insertOne({ _id: 'p4', clientOrderId: 'x' }),
    /E11000/,
  )
})

test('a collection too dirty for the claim index says so LOUDLY and still boots', async () => {
  const db = new FakeDb()
  // What a restore, a hand-dropped index, or a run started through a path that
  // never called ensureIndexes leaves behind: rows the index forbids.
  db.runs().failIndexWith = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })

  const said: unknown[] = []
  const real = console.error
  console.error = (...args: unknown[]): void => {
    said.push(args[0])
  }
  try {
    // The desk BOOTS. Throwing here turns a pair of rows that are already in
    // the past into exit 1 and a pm2 crash-loop, at 09:14, with live books.
    await new DeskStore(db).ensureIndexes()
  } finally {
    console.error = real
  }

  const complaint = String(said.find((s) => String(s).includes('repair-claim')) ?? '')
  assert.match(complaint, /COULD NOT build/)
  assert.match(complaint, /desk-repair-applies/)
  // Naming the rows and how to end them, because the operator reading a boot
  // log at that hour needs the query, not the diagnosis.
  assert.match(complaint, /aggregate/)
  assert.match(complaint, /HALTED/)
})

test('an index failure that is NOT a duplicate key is a real fault and is rethrown', async () => {
  const db = new FakeDb()
  // No connection, no permission — nothing else in ensureIndexes would have
  // worked either, so swallowing it would hide a broken database behind a
  // desk that looks up.
  db.runs().failIndexWith = new Error('not authorized on desk to execute createIndexes')

  await assert.rejects(async () => await new DeskStore(db).ensureIndexes(), /not authorized/)
})

test('a run whose document was HALTED under it stands down instead of resurrecting it', async () => {
  const h = await harness()
  const svc = new RepairApplyService({
    db: h.db,
    rail: h.rail,
    now: () => T0,
    log: () => undefined,
    quote: () => QUOTE,
    // The close fills, but a restart sweep (or an operator) ended the run
    // between the submit and the write that would record the fill.
    fillState: async () => {
      await h.db
        .runs()
        .updateOne({ _id: 'A17' }, { $set: { state: 'HALTED', haltReason: 'restart' } })
      return 'FILLED'
    },
    pollMs: 1,
  })

  await svc.start({
    tag: TAG,
    mode: 'paper',
    style: 'fast',
    bookPrint: 'print-1',
    applyId: 'A17',
    orders: [CLOSE, OPEN],
  })
  await settle(svc, 'A17')
  await new Promise((resolve) => setTimeout(resolve, 25))

  const after = await svc.status('A17')
  assert.equal(after?.state, 'HALTED')
  // The verdict is not written back over: state and reason stay as the halt
  // that ended this run left them.
  assert.equal(after?.haltReason, 'restart')
  // But the LEDGER still lands. That close reached the broker and filled, and
  // the halted document is what the operator reads to decide what to finish by
  // hand — a row still saying SUBMITTED there is a lie about a live order.
  assert.equal(after?.orders[0]?.status, 'FILLED')
  // And above all, the open wave never fired under a document that had already
  // told everyone this run was over.
  assert.deepEqual(h.rail.ids(), ['repair:A17:0'])
})

test('a run halts at its hold window rather than outliving the hold it set', async () => {
  const h = await harness()
  let clock = T0
  const svc = new RepairApplyService({
    db: h.db,
    rail: h.rail,
    now: () => clock,
    log: () => undefined,
    quote: () => QUOTE,
    fillState: async () => {
      clock += 200_000
      return 'PENDING'
    },
    pollMs: 1,
    // A per-wave cap far beyond the hold. Without the whole-run deadline this
    // run would still be placing orders long after the Python driver, reading
    // the expired hold, had resumed managing the same book.
    maxWaveMs: 10_000_000,
  })

  await svc.start({
    tag: TAG,
    mode: 'paper',
    style: 'fast',
    bookPrint: 'print-1',
    applyId: 'A18',
    orders: [CLOSE, OPEN],
  })
  const halted = await settle(svc, 'A18')

  assert.equal(halted.state, 'HALTED')
  assert.match(halted.haltReason ?? '', /exceeded its hold window/)
  assert.ok(clock - halted.createdAt <= REPAIR_HOLD_MS + 200_000)
  assert.equal(halted.orders[1]?.status, 'QUEUED')
  assert.deepEqual(h.rail.ids(), ['repair:A18:0'])
})

test('a close that fills at the deadline does not get to fire a whole open wave past it', async () => {
  const h = await harness()
  let clock = T0
  const svc = new RepairApplyService({
    db: h.db,
    rail: h.rail,
    now: () => clock,
    log: () => undefined,
    quote: () => QUOTE,
    // The close fills — but the hold window has passed while it did. The poll
    // loop never sees this: it returns the moment nothing is pending, so the
    // deadline has to be checked again before the next wave is PLACED.
    fillState: async () => {
      clock = T0 + REPAIR_HOLD_MS + 1
      return 'FILLED'
    },
    pollMs: 1,
    maxWaveMs: 10_000_000,
  })

  await svc.start({
    tag: TAG,
    mode: 'paper',
    style: 'fast',
    bookPrint: 'print-1',
    applyId: 'A21',
    orders: [CLOSE, OPEN],
  })
  const halted = await settle(svc, 'A21')

  assert.equal(halted.state, 'HALTED')
  assert.match(halted.haltReason ?? '', /before the open wave was placed/)
  assert.equal(halted.orders[0]?.status, 'FILLED')
  assert.equal(halted.orders[1]?.status, 'QUEUED')
  assert.deepEqual(h.rail.ids(), ['repair:A21:0'])
})

test('an unreadable register THROWS rather than answering "nothing is running"', async () => {
  const h = await harness()
  await h.db.runs().insertOne(runningDoc('HELD'))
  h.db.runs().failReads = true

  // Both readers, because both feed a screen that places orders: a swallowed
  // error here becomes an Apply button that opens over a live repair.
  await assert.rejects(async () => await h.svc.activeHold(TAG), /no primary available/)
  await assert.rejects(
    async () => await repairHoldLookup(h.db, () => T0)(TAG),
    /no primary available/,
  )
})

test('a stranded row cannot hide the live run behind it', async () => {
  const h = await harness()
  /**
   * Two RUNNING rows on one tag, which the unique partial index makes
   * impossible — so they are pushed in BEHIND it, the way a collection restored
   * without its indexes would carry them. That is the case the hold read's
   * fallback exists for: insertion order is what a natural-order `findOne`
   * walks, the stale row is the one it meets first, and answering "unheld" off
   * it would release the supervisor onto a book that is mid-repair.
   */
  h.db.runs().docs.push(runningDoc('STRANDED', TAG, T0 - REPAIR_HOLD_MS - 1))
  h.db.runs().docs.push(runningDoc('REAL', TAG, T0 - 1_000))

  assert.deepEqual(await h.svc.activeHold(TAG), {
    applyId: 'REAL',
    heldAt: T0 - 1_000,
    untilMs: T0 - 1_000 + REPAIR_HOLD_MS,
  })
  assert.deepEqual(await repairHoldLookup(h.db, () => T0)(TAG), await h.svc.activeHold(TAG))
})

test('a RUNNING run older than the hold window neither holds the book nor blocks the next apply', async () => {
  const h = await harness()
  // The row a dead desk-api left behind. It released the Python driver on the
  // TTL; it must release the operator too, or the book can never be repaired.
  await h.db.runs().insertOne(runningDoc('STRANDED', TAG, T0 - REPAIR_HOLD_MS - 1))

  assert.equal(await h.svc.activeHold(TAG), null)
  assert.equal(await repairHoldLookup(h.db, () => T0)(TAG), null)

  const started = await start(h, 'A19', [CLOSE, OPEN])
  assert.equal(started.ok, true)
  assert.equal((await settle(h.svc, 'A19')).state, 'DONE')
  assert.deepEqual(h.rail.ids(), ['repair:A19:0', 'repair:A19:1'])
})

test('replaying the same applyId returns the run it already has, and places nothing twice', async () => {
  const h = await harness()
  const first = await start(h, 'A11', [CLOSE, OPEN])
  assert.equal(first.ok, true)
  const done = await settle(h.svc, 'A11')
  assert.equal(done.state, 'DONE')

  const again = await start(h, 'A11', [CLOSE, OPEN])
  assert.equal(again.ok, true)
  if (!again.ok) throw new Error('unreachable')
  assert.equal(again.run.state, 'DONE')
  assert.deepEqual(h.rail.ids(), ['repair:A11:0', 'repair:A11:1'])
})
