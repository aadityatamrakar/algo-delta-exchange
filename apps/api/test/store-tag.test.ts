/**
 * Book keying, against a REAL MongoDB.
 *
 * The property under test is a database property — that two tags on one symbol
 * are two documents — so a fake store would only assert that the code does what
 * it was written to do. Skips itself when no Mongo is reachable, matching
 * `service.integration.test.ts:26`.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// For its import-time guards only: a DESK_TEST_MONGO* URL outside algomaker_dx_* is refused before this suite connects.
import './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS, dropIfPresent, type BookKey, type Database } from '../src/store.ts'
import type { BridgeLeg } from '../src/contract.ts'

// Its own database, not `algomaker_dx_bridge_test` — `service.integration.test.ts`
// runs against that one concurrently (`node --test` parallelizes test files) and
// clears the very collections (`desk-books`, `desk-declarations`) this suite
// writes to in its own `beforeEach`, so sharing it makes this suite flaky by
// construction. Every other real-Mongo suite in this package (`brokers.test.ts`,
// `auth-routes.test.ts`, `server.test.ts`) follows the same one-DB-per-file rule.
const URL = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_bridge_tag_test'

let handle: MongoHandle | null = null
let store: DeskStore
let available = false

const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'

function key(tag: string): BookKey {
  return { tag, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY }
}

function leg(strike: number, qty: number): BridgeLeg {
  return {
    deskTag: `CE${strike}#1`,
    instrument: {
      tradingsymbol: `BHEL26AUG${strike}CE`,
      exchange: 'NFO',
      instrumentToken: 700000 + strike,
      lotSize: 2625,
      tickSize: 0.05,
    },
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike,
    type: 'CE',
    side: qty < 0 ? 'Sell' : 'Buy',
    qty,
    entryPrice: 15,
    openedTs: 1,
  }
}

before(async () => {
  try {
    handle = await connectMongo(URL)
    store = new DeskStore(handle.db)
    await store.ensureIndexes()
    available = true
  } catch {
    available = false
  }
})

after(async () => {
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available || handle === null) return
  await handle.db.collection(COLLECTIONS.books).deleteMany({})
  await handle.db.collection(COLLECTIONS.declarations).deleteMany({})
  // The F-42 suites below write orders. A row left behind by a failed run would
  // block the very index build the next run's `before` hook depends on.
  await handle.db.collection(COLLECTIONS.gatewayOrders).deleteMany({})
  await handle.db.collection(COLLECTIONS.paperTrade).deleteMany({})
})

test('two tags on one symbol are two independent books', async (t) => {
  if (!available) return t.skip('no mongo')
  await store.saveBook(key('BHEL-2026-08-25-hold-recycle-r'), [leg(420, -13125)], 1)
  await store.saveBook(key('BHEL-2026-08-25-hold-recycle-shift-r'), [leg(425, -26250)], 2)

  const a = await store.loadBook('BHEL-2026-08-25-hold-recycle-r', 'paper')
  const b = await store.loadBook('BHEL-2026-08-25-hold-recycle-shift-r', 'paper')

  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(a[0]?.qty, -13125)
  assert.equal(b[0]?.qty, -26250)
  assert.equal((await store.booksForSymbol(SYMBOL, 'paper')).length, 2)
})

test('one tag can hold a paper and a live book at once', async (t) => {
  if (!available) return t.skip('no mongo')
  const tag = 'BHEL-2026-08-25-hold-recycle-r'
  await store.saveBook({ tag, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY }, [leg(420, -13125)], 1)
  await store.saveBook({ tag, mode: 'live', symbol: SYMBOL, expiry: EXPIRY }, [leg(430, -2625)], 2)

  assert.equal((await store.loadBook(tag, 'paper'))[0]?.qty, -13125)
  assert.equal((await store.loadBook(tag, 'live'))[0]?.qty, -2625)
})

// ----------------------------------------------- compare-and-set (audit F-27)

/**
 * `desk-books` is read at `service.ts:353`, gated, routed, and written back at
 * `:554` — a whole-document read-modify-write with N round trips in between and
 * no serialisation of any kind. An operator's "Close leg" landing inside that
 * window used to be silently discarded by the supervisor's 5-minute POST: the
 * closed leg came back. That is the 2026-08-03 ITC desync shape, and the guard
 * is the same version pin `patchStrategy` already carries.
 */
test('a stale expectedUpdatedAt CONFLICTS and writes nothing', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-cas')
  await store.saveBook(k, [leg(420, -13125)], 100)
  const before = await store.bookDoc(k.tag, 'paper')
  // Somebody else's write lands in the window.
  assert.equal(await store.saveBook(k, [leg(425, -26250)], 200, before?.updatedAt), 'ok')

  const conflict = await store.saveBook(k, [leg(430, -2625)], 300, before?.updatedAt)
  assert.equal(conflict, 'conflict')
  const after = await store.loadBook(k.tag, 'paper')
  assert.equal(after[0]?.strike, 425, 'the loser must not overwrite the winner')
})

test('a fresh expectedUpdatedAt lands and STRICTLY advances the version', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-cas')
  await store.saveBook(k, [leg(420, -13125)], 100)
  const first = (await store.bookDoc(k.tag, 'paper'))?.updatedAt as number
  assert.equal(first, 100)

  // Same millisecond, twice: `updatedAt` IS the version, so an identical
  // version would wave the next compare-and-set through.
  assert.equal(await store.saveBook(k, [leg(425, -26250)], 100, first), 'ok')
  const second = (await store.bookDoc(k.tag, 'paper'))?.updatedAt as number
  assert.equal(second, 101)
  assert.equal(await store.saveBook(k, [leg(430, -2625)], 100, second), 'ok')
  assert.equal((await store.bookDoc(k.tag, 'paper'))?.updatedAt, 102)
})

test('a compare-and-set NEVER upserts — a deleted book stays deleted', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-cas')
  assert.equal(await store.saveBook(k, [leg(420, -13125)], 100, 100), 'conflict')
  assert.equal((await store.bookDoc(k.tag, 'paper')), null, 'no phantom document')
})

test('WITHOUT an expected version the write still upserts — that is the seed path', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-cas')
  assert.equal(await store.saveBook(k, [leg(420, -13125)], 100), 'ok')
  assert.equal((await store.loadBook(k.tag, 'paper')).length, 1)
  assert.equal(await store.saveBook(k, [], 200), 'ok')
  assert.equal((await store.loadBook(k.tag, 'paper')).length, 0)
})

/**
 * CREATE-ONLY (`expectedUpdatedAt: null`).
 *
 * The compare-and-set covered every window except the one with no row in it. A
 * first decision on a fresh tag read `undefined`, fell through to the blind
 * upsert, and `$set` right over the book an operator created from the Build
 * screen while the orders were routing — the very lost update F-27 exists to
 * prevent, at the one moment the guard was missing.
 */
test('a create-only write CONFLICTS instead of overwriting a row somebody else made', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-create')
  assert.equal(await store.saveBook(k, [leg(420, -13125)], 100, null), 'ok')
  assert.equal((await store.bookDoc(k.tag, 'paper'))?.updatedAt, 100)

  assert.equal(await store.saveBook(k, [leg(425, -26250)], 200, null), 'conflict')
  const after = await store.loadBook(k.tag, 'paper')
  assert.equal(after.length, 1)
  assert.equal(after[0]?.strike, 420, 'a create must never $set over a row it did not make')
})

test('the {tag,mode} unique index is what makes create-only safe, not the read', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-create-race')
  const outcomes = await Promise.all([
    store.saveBook(k, [leg(420, -13125)], 100, null),
    store.saveBook(k, [leg(425, -26250)], 100, null),
    store.saveBook(k, [leg(430, -2625)], 100, null),
  ])
  assert.equal(outcomes.filter((o) => o === 'ok').length, 1, 'exactly one creator wins')
  assert.equal(outcomes.filter((o) => o === 'conflict').length, 2)
  assert.equal((await store.booksForSymbol(SYMBOL, 'paper')).length, 1, 'one row, not three')
})

test('an unconditional write never REGRESSES the version', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-cas')
  await store.saveBook(k, [leg(420, -13125)], 1000)
  assert.equal(await store.saveBook(k, [leg(425, -26250)], 1000, 1000), 'ok')
  assert.equal((await store.bookDoc(k.tag, 'paper'))?.updatedAt, 1001, 'the CAS advanced it')

  // A writer whose clock is a moment behind — a seed, a legacy path — used to
  // stamp `nowMs` flat and push the version DOWN, which makes a pin taken
  // before it match all over again.
  assert.equal(await store.saveBook(k, [leg(430, -2625)], 1000), 'ok')
  assert.equal((await store.bookDoc(k.tag, 'paper'))?.updatedAt, 1002)
  assert.equal(
    await store.saveBook(k, [leg(420, -13125)], 1000, 1001),
    'conflict',
    'a version that was already superseded must never match again',
  )
})

test('declarations are keyed by tag, not symbol', async (t) => {
  if (!available) return t.skip('no mongo')
  await store.saveDeclaration('tag-a', SYMBOL, [{ strike: 420, type: 'CE', qty: -13125 }], 1)
  await store.saveDeclaration('tag-b', SYMBOL, [{ strike: 425, type: 'CE', qty: -26250 }], 2)

  assert.equal((await store.loadDeclaration('tag-a'))?.legs[0]?.qty, -13125)
  assert.equal((await store.loadDeclaration('tag-b'))?.legs[0]?.qty, -26250)
})

// --------------------------------------------- the fold nonce (WP-L, verifier)

/**
 * `appliedCorrections` — the reconciler's idempotency key, on the BOOK.
 *
 * The reconciler used to stamp `foldDone` on the DECISION after folding the
 * compensation into the BOOK: two documents, two writes, and a crash in the gap
 * left a book that had already been folded and a record that said it had not.
 * The next pass re-folded it — a refused CLOSE restored the same leg twice, so
 * a repair invented the exposure it exists to remove.
 *
 * The nonce closes that window by making the fold and the proof-of-fold ONE
 * document and ONE `updateOne`. There is no gap left to crash in.
 */
test('a fold nonce is appended in the SAME write as the legs, on every path', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-nonce')

  // create-only
  assert.equal(await store.saveBook(k, [leg(420, -13125)], 100, null, 'd1#0'), 'ok')
  assert.deepEqual((await store.bookDoc(k.tag, 'paper'))?.appliedCorrections, ['d1#0'])

  // compare-and-set
  const v = (await store.bookDoc(k.tag, 'paper'))?.updatedAt as number
  assert.equal(await store.saveBook(k, [leg(425, -26250)], 200, v, 'd1#1'), 'ok')
  const casDoc = await store.bookDoc(k.tag, 'paper')
  assert.deepEqual(casDoc?.appliedCorrections, ['d1#0', 'd1#1'])
  assert.equal(casDoc?.legs[0]?.strike, 425, 'the legs and the nonce land together or not at all')

  // unconditional (the pre-F-27 document's path)
  assert.equal(await store.saveBook(k, [leg(430, -2625)], 300, undefined, 'd1#2'), 'ok')
  assert.deepEqual((await store.bookDoc(k.tag, 'paper'))?.appliedCorrections, [
    'd1#0',
    'd1#1',
    'd1#2',
  ])
})

test('a LOST compare-and-set writes no nonce — nothing was folded', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-nonce-lost')
  await store.saveBook(k, [leg(420, -13125)], 100)
  assert.equal(await store.saveBook(k, [leg(425, -26250)], 200, 99, 'd9#0'), 'conflict')
  const doc = await store.bookDoc(k.tag, 'paper')
  assert.equal(doc?.legs[0]?.strike, 420)
  assert.equal(
    (doc?.appliedCorrections ?? []).includes('d9#0'),
    false,
    'a nonce for a fold that never landed would make the retry skip it forever',
  )
})

test('the nonce list is capped at 200, oldest dropped', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-nonce-cap')
  await store.saveBook(k, [leg(420, -13125)], 100, null, 'n-0')
  for (let i = 1; i < 205; i++) {
    await store.saveBook(k, [leg(420, -13125)], 100 + i, undefined, `n-${i}`)
  }
  const applied = (await store.bookDoc(k.tag, 'paper'))?.appliedCorrections ?? []
  assert.equal(applied.length, 200, 'an unbounded array on a hot document is a document that dies')
  assert.equal(applied[0], 'n-5', 'the OLDEST go first')
  assert.equal(applied[199], 'n-204')
})

test('saveBook without a nonce leaves the list exactly as it was', async (t) => {
  if (!available) return t.skip('no mongo')
  const k = key('BHEL-nonce-none')
  await store.saveBook(k, [leg(420, -13125)], 100, null, 'd1#0')
  await store.saveBook(k, [leg(425, -26250)], 200)
  assert.deepEqual((await store.bookDoc(k.tag, 'paper'))?.appliedCorrections, ['d1#0'])
})

// ------------------------------------------------------ F-42: the API's own indexes

/**
 * F-42. `rail.ts` calls the `{clientOrderId}` unique index its duplicate-order
 * protection, and only the GATEWAY ever created it. A restored database, or an
 * API that boots before the gateway does, wrote live orders unprotected — and
 * `desk-paper-trade` had no uniqueness at all. A safety property that depends
 * on which process happened to start first is not one.
 */
test('ensureIndexes creates the clientOrderId unique index the API depends on', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  for (const name of [COLLECTIONS.gatewayOrders, COLLECTIONS.paperTrade]) {
    const col = handle.db.collection(name)
    await col.deleteMany({})
    await col.insertOne({ clientOrderId: 'dup#0', tag: 'T' })
    await assert.rejects(
      () => col.insertOne({ clientOrderId: 'dup#0', tag: 'T' }),
      /duplicate key|E11000/,
      `${name} must refuse a second order under one clientOrderId`,
    )
    await col.deleteMany({})
  }
})

test('ensureIndexes is idempotent — a second boot builds the same indexes', async (t) => {
  if (!available) return t.skip('no mongo')
  await store.ensureIndexes()
  await store.ensureIndexes()
})

/**
 * A DUPLICATE ALREADY IN HISTORY MUST NOT STOP THE DESK BOOTING.
 *
 * `main.ts` awaits `ensureIndexes`, so a build Mongo refuses is not "no index",
 * it is "the API does not start" — at 09:14, with live books to mark, over a
 * defect that is already in the past. The guard protects the NEXT duplicate;
 * the right answer to an old one is a loud line and a desk that runs.
 */
test('an old duplicate is reported, not turned into a failed boot', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  const col = handle.db.collection(COLLECTIONS.gatewayOrders)
  await col.deleteMany({})
  await dropIfPresent(col, 'clientOrderId_1')
  await col.insertOne({ clientOrderId: 'old-dup#0' })
  await col.insertOne({ clientOrderId: 'old-dup#0' })

  await store.ensureIndexes()

  assert.equal(await col.countDocuments({}), 2, 'and nothing of the operator’s data is touched')
  await col.deleteMany({})
})

/**
 * A paper row written before `clientOrderId` existed has none, and Mongo reads
 * a missing key as `null` — two of them collide on a plain unique index and the
 * build fails, which on this path means the API does not boot. The index is
 * SPARSE for exactly that reason: legacy rows are outside it, live ones are not.
 */
test('legacy paper rows with no clientOrderId do not break the unique index', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  const col = handle.db.collection(COLLECTIONS.paperTrade)
  await col.deleteMany({})
  await col.insertOne({ tag: 'legacy-a', tradingsymbol: 'X' })
  await col.insertOne({ tag: 'legacy-b', tradingsymbol: 'Y' })
  await store.ensureIndexes()
  assert.equal(await col.countDocuments({}), 2)
  await col.deleteMany({})
})

// ------------------------------------------- dials attribution (WP-I's F-29)

/**
 * WHO changed a dial, written in the SAME `updateOne` as the dial.
 *
 * A live book's dials change what the strategy does with real money. Recording
 * the values without the principal — or recording them in a second write that a
 * crash can lose — leaves a book behaving differently from yesterday with
 * nothing to say who did it. One document, one write.
 *
 * Fake-backed: the property is "one update carrying all of it", which a real
 * Mongo cannot show and a call recorder can.
 */
test('patchBookDials stamps who and when in the SAME update as the dials', async () => {
  const calls: { filter: Record<string, unknown>; update: Record<string, unknown> }[] = []
  const fakeDb = {
    collection() {
      return {
        async findOne() {
          return null
        },
        async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
          calls.push({ filter, update })
          return { matchedCount: 1 }
        },
      }
    },
  }
  const s = new DeskStore(fakeDb as unknown as Database)
  await s.patchBookDials('BHEL-x', 'live', { target_pnl: 15_000 }, 4242, 'aaditya')

  assert.equal(calls.length, 1, 'attribution in a second write is attribution a crash can lose')
  const set = calls[0]?.update['$set'] as Record<string, unknown>
  assert.equal(set['dials.target_pnl'], 15_000)
  assert.equal(set['dialsSetBy'], 'aaditya')
  assert.equal(set['dialsSetAt'], 4242)
  assert.equal(set['updatedAt'], 4242)
})
