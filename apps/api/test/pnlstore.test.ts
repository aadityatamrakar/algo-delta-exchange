/**
 * `PnlStore.loadFills` AGAINST A REAL MONGODB.
 *
 * WHY THE DRIVER AND NOT A FAKE. The property under test here is a DATABASE
 * property and nothing else: Mongo orders a mixed-type field BY BSON TYPE
 * FIRST, so `sort({createdAt: -1})` over a window holding both numeric and
 * `Date` stampings returns two type-bracketed runs rather than one
 * chronological stream. No fake in this directory ordered by type — they all
 * coerce with `Number()` — so every one of them answered the question the wrong
 * way round and the defect could not be seen from inside them. The fakes are
 * now bracketed for MATCHING (F-53), which is what makes the two-query read
 * safe there; the ORDERING can only honestly be proven here.
 *
 * WHY IT MATTERS ENOUGH TO STAND A DATABASE UP FOR. Average cost is
 * path-dependent. A buy at 100 and a sell at 120 booked in the wrong order is a
 * different realised P&L and a different average on what remains — and this
 * collection genuinely holds both stampings, because the Python desk, the
 * driver and every hand-repair through the shell write it. So the read that
 * both P&L and positions are built on returned fills in an order that never
 * happened, silently, on exactly the days somebody had been in the shell.
 *
 * Skips itself when no Mongo is reachable — unless `DESK_REQUIRE_MONGO=1`, see
 * `require-mongo.ts`. Its own database: node:test runs these files in parallel
 * and each wipes its own collections.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { COLLECTIONS } from '../src/store.ts'
import { PnlStore, pnlKey } from '../src/pnlstore.ts'

const URL =
  process.env['DESK_TEST_MONGO_PNLSTORE'] ??
  'mongodb://127.0.0.1:27017/algomaker_dx_bridge_pnlstore_test'

const TAG = 'DESK_BHEL'
const KEY = pnlKey(TAG, 'paper')
const SYMBOL = 'BHEL26AUG300CE'
/** 2026-08-14 09:15 IST. */
const T0 = Date.parse('2026-08-14T03:45:00.000Z')
const T = (minutes: number): number => T0 + minutes * 60_000

let handle: MongoHandle | null = null
let available = false
let store: PnlStore

before(async () => {
  try {
    handle = await connectMongo(URL, { serverSelectionTimeoutMS: 2500 })
    store = new PnlStore(handle.db)
    available = true
  } catch {
    available = false
  }
})

after(async () => {
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (available) await handle!.db.collection(COLLECTIONS.decisions).deleteMany({})
})

/**
 * One decision, stamped EXACTLY as asked — a number or a `Date`, never coerced.
 * The whole point of these fixtures is that the two types coexist in one window.
 */
async function decision(
  createdAt: number | Date,
  fills: readonly { side: 'Buy' | 'Sell'; qty: number; price: number }[],
  over: Record<string, unknown> = {},
): Promise<void> {
  await handle!.db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: `d-${String(createdAt instanceof Date ? createdAt.getTime() : createdAt)}-${
      typeof createdAt === 'number' ? 'n' : 'd'
    }`,
    tag: TAG,
    mode: 'paper',
    symbol: 'BHEL',
    expiry: '2026-08-27',
    skips: [],
    createdAt,
    fills: fills.map((f) => ({ tradingsymbol: SYMBOL, ...f })),
    ...over,
  })
}

/** The prices, in the order the read handed them over. Prices are the fixture's id. */
const priceOrder = (fills: readonly { price: number }[] | undefined): number[] =>
  (fills ?? []).map((f) => f.price)

test('fills come back in CHRONOLOGICAL order across numeric and Date stampings', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  // Interleaved on purpose: alternating types, one minute apart. Type-bracketed
  // ordering returns 1,3,5 then 2,4 — a sequence that never happened.
  await decision(T(1), [{ side: 'Sell', qty: 100, price: 1 }])
  await decision(new Date(T(2)), [{ side: 'Buy', qty: 100, price: 2 }])
  await decision(T(3), [{ side: 'Sell', qty: 100, price: 3 }])
  await decision(new Date(T(4)), [{ side: 'Buy', qty: 100, price: 4 }])
  await decision(T(5), [{ side: 'Sell', qty: 100, price: 5 }])

  const load = await store.loadFills({ from: T(0), to: T(10) })
  assert.deepEqual(priceOrder(load.byKey.get(KEY)), [1, 2, 3, 4, 5])
  assert.equal(load.truncated, false)
  assert.deepEqual(load.malformed, [])
})

test('a Date-stamped decision’s fills carry the DECISION’s instant when they have no own `ts`', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  await decision(new Date(T(2)), [{ side: 'Sell', qty: 100, price: 20 }])
  const load = await store.loadFills({ from: T(0), to: T(10) })
  const fills = load.byKey.get(KEY) ?? []
  assert.equal(fills.length, 1)
  // `Number(new Date(...))` is epoch ms — the fallback stamp must be the
  // instant, not `NaN` and not zero, or the fill files under 1970 and leaves
  // every window it belongs to.
  assert.equal(fills[0]?.ts, T(2))
})

test('fills WITHIN one decision keep their own order, whatever the stamping', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  // A roll is two fills in ONE document, and the close must stay ahead of the
  // open — re-sorting on a per-fill `ts` would shuffle them into a different
  // average whenever both landed in the same millisecond.
  await decision(new Date(T(2)), [
    { side: 'Buy', qty: 100, price: 21 },
    { side: 'Sell', qty: 100, price: 22 },
  ])
  await decision(T(1), [
    { side: 'Sell', qty: 100, price: 11 },
    { side: 'Buy', qty: 100, price: 12 },
  ])
  const load = await store.loadFills({ from: T(0), to: T(10) })
  assert.deepEqual(priceOrder(load.byKey.get(KEY)), [11, 12, 21, 22])
})

test('the CAP is taken from the newest end of the MERGED stream, not per type', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  await decision(T(1), [{ side: 'Sell', qty: 100, price: 1 }])
  await decision(new Date(T(2)), [{ side: 'Buy', qty: 100, price: 2 }])
  await decision(T(3), [{ side: 'Sell', qty: 100, price: 3 }])
  await decision(new Date(T(4)), [{ side: 'Buy', qty: 100, price: 4 }])
  await decision(T(5), [{ side: 'Sell', qty: 100, price: 5 }])

  const load = await store.loadFills({ from: T(0), to: T(10), limit: 3 })
  // The three NEWEST decisions, still in ascending order. A per-type cap would
  // keep the newest three numbers (1,3,5) and throw away today's Date rows —
  // which is the direction that reads as a flat book with no error anywhere.
  assert.deepEqual(priceOrder(load.byKey.get(KEY)), [3, 4, 5])
  assert.equal(load.truncated, true, 'a partial read must never read as a small book')
})

test('a window holding only one type is unchanged — and says nothing was truncated', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  await decision(T(1), [{ side: 'Sell', qty: 100, price: 1 }])
  await decision(T(2), [{ side: 'Buy', qty: 100, price: 2 }])
  const numeric = await store.loadFills({ from: T(0), to: T(10) })
  assert.deepEqual(priceOrder(numeric.byKey.get(KEY)), [1, 2])
  assert.equal(numeric.truncated, false)

  await handle!.db.collection(COLLECTIONS.decisions).deleteMany({})
  await decision(new Date(T(1)), [{ side: 'Sell', qty: 100, price: 1 }])
  await decision(new Date(T(2)), [{ side: 'Buy', qty: 100, price: 2 }])
  const dated = await store.loadFills({ from: T(0), to: T(10) })
  assert.deepEqual(priceOrder(dated.byKey.get(KEY)), [1, 2])
  assert.equal(dated.truncated, false)
})

test('the window still excludes both types outside it', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  await decision(T(-5), [{ side: 'Sell', qty: 100, price: 90 }])
  await decision(new Date(T(-4)), [{ side: 'Sell', qty: 100, price: 91 }])
  await decision(T(1), [{ side: 'Sell', qty: 100, price: 1 }])
  await decision(new Date(T(2)), [{ side: 'Buy', qty: 100, price: 2 }])
  await decision(T(99), [{ side: 'Sell', qty: 100, price: 92 }])
  await decision(new Date(T(98)), [{ side: 'Sell', qty: 100, price: 93 }])

  const load = await store.loadFills({ from: T(0), to: T(10) })
  assert.deepEqual(priceOrder(load.byKey.get(KEY)), [1, 2])
})

test('an unbounded upper bound still reads BOTH stampings', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  // `to: MAX_SAFE_INTEGER` is what the book-delete and seed guards pass, and
  // `new Date(MAX_SAFE_INTEGER)` is an INVALID DATE — clamped, or the Date
  // branch of the range silently matches nothing at all.
  await decision(T(1), [{ side: 'Sell', qty: 100, price: 1 }])
  await decision(new Date(T(2)), [{ side: 'Buy', qty: 100, price: 2 }])
  const load = await store.loadFills({ from: 0, to: Number.MAX_SAFE_INTEGER })
  assert.deepEqual(priceOrder(load.byKey.get(KEY)), [1, 2])
})

test('tag and mode narrow BOTH stampings, not just the numeric one', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  await decision(new Date(T(2)), [{ side: 'Buy', qty: 100, price: 2 }])
  await decision(new Date(T(3)), [{ side: 'Buy', qty: 100, price: 3 }], {
    tag: 'OTHER',
    mode: 'live',
  })
  await decision(T(4), [{ side: 'Buy', qty: 100, price: 4 }], { tag: 'OTHER', mode: 'live' })

  const mine = await store.loadFills({ from: T(0), to: T(10), tag: TAG, mode: 'paper' })
  assert.deepEqual(priceOrder(mine.byKey.get(KEY)), [2])
  assert.deepEqual([...mine.byKey.keys()], [KEY])

  const theirs = await store.loadFills({ from: T(0), to: T(10), tag: 'OTHER', mode: 'live' })
  assert.deepEqual(priceOrder(theirs.byKey.get(pnlKey('OTHER', 'live'))), [3, 4])
})

test('a malformed fill on a Date-stamped decision is counted, not thrown', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)
  await decision(new Date(T(2)), [{ side: 'Sell', qty: 100, price: 2 }])
  await handle!.db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'bad-1',
    tag: TAG,
    mode: 'paper',
    createdAt: new Date(T(3)),
    fills: [{ tradingsymbol: SYMBOL, side: 'Sell', qty: 100, price: 'not a number' }],
  })
  const load = await store.loadFills({ from: T(0), to: T(10) })
  assert.deepEqual(priceOrder(load.byKey.get(KEY)), [2])
  assert.deepEqual(load.malformed, [`${TAG}:${SYMBOL}`])
  assert.deepEqual(load.malformedByKey.get(KEY), [`${TAG}:${SYMBOL}`])
})
