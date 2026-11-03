/**
 * THE LEASE, AGAINST A REAL MONGODB — because contention is the whole feature.
 *
 * The property under test is "two processes ask, one gets it", and the only
 * thing that can decide it is the server: a unique index refusing the second
 * insert, and a filter that matches nothing while the holder is alive. A fake
 * would be answering its own question.
 *
 * The clock is INJECTED so the TTL lapse is a jump, not a sleep — a test that
 * waited out a real 15-second lease would be a test nobody runs.
 *
 * Skips itself when no Mongo is reachable — unless `DESK_REQUIRE_MONGO=1`, see
 * `require-mongo.ts`. Its own database: node:test runs these files in parallel
 * processes and each wipes its own collections.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../../api/src/mongo.ts'
import { Lease, SUPERVISOR_LEASE_COLLECTION, type LeaseCollection } from '../src/lease.ts'

const URL =
  process.env['DESK_TEST_MONGO_SUPERVISOR_LEASE'] ??
  'mongodb://127.0.0.1:27017/algomaker_dx_supervisor_lease_test'

const KEY = 'desk-supervisor'
const TTL = 15_000
/** 2026-08-21 09:20 IST. */
const T0 = Date.parse('2026-08-21T03:50:00.000Z')

let handle: MongoHandle | null = null
let available = false
let collection: LeaseCollection
let nowMs = T0

const now = (): number => nowMs

/** One supervisor process's view of the lease. */
const supervisor = (): Lease => new Lease({ collection, key: KEY, now })

before(async () => {
  try {
    handle = await connectMongo(URL, { serverSelectionTimeoutMS: 2500 })
    collection = handle.db.collection(SUPERVISOR_LEASE_COLLECTION) as unknown as LeaseCollection
    await supervisor().ensureIndexes()
    available = true
  } catch {
    available = false
  }
})

after(async () => {
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  nowMs = T0
  if (available) await handle!.db.collection(SUPERVISOR_LEASE_COLLECTION).deleteMany({})
})

test('a lease nobody holds is taken', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  assert.equal(await supervisor().acquire('sup-a', TTL), true)
})

test('a second supervisor is REFUSED while the first is alive', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const b = supervisor()
  assert.equal(await a.acquire('sup-a', TTL), true)

  assert.equal(await b.acquire('sup-b', TTL), false)

  // A quarter of the TTL later, and again: the holder heartbeating keeps it out.
  nowMs = T0 + TTL / 4
  assert.equal(await a.heartbeat(), true)
  assert.equal(await b.acquire('sup-b', TTL), false)
})

test('a heartbeat pushes the expiry out — the holder never times itself out', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const b = supervisor()
  assert.equal(await a.acquire('sup-a', TTL), true)

  // Heartbeat past the original expiry, twice.
  for (const step of [TTL - 1000, 2 * TTL - 2000]) {
    nowMs = T0 + step
    assert.equal(await a.heartbeat(), true)
  }
  assert.equal(await b.acquire('sup-b', TTL), false)
})

test('after the TTL lapses the lease is taken, and the dead holder learns it lost', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const b = supervisor()
  assert.equal(await a.acquire('sup-a', TTL), true)

  // `a` is wedged — a stop-the-world GC, a hung socket, a SIGSTOP.
  nowMs = T0 + TTL + 1

  assert.equal(await b.acquire('sup-b', TTL), true)
  // The zombie waking up MUST be told, or it goes on steering a book it no
  // longer owns and two supervisors route against one broker position.
  assert.equal(await a.heartbeat(), false)
})

test('an evicted holder\'s release does not free the NEW holder\'s lease', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const b = supervisor()
  const c = supervisor()
  assert.equal(await a.acquire('sup-a', TTL), true)
  nowMs = T0 + TTL + 1
  assert.equal(await b.acquire('sup-b', TTL), true)

  // The zombie shuts down cleanly and releases "its" lease.
  await a.release()

  assert.equal(await b.heartbeat(), true)
  assert.equal(await c.acquire('sup-c', TTL), false)
})

test('release hands the lease over at once, without waiting out the TTL', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const b = supervisor()
  assert.equal(await a.acquire('sup-a', TTL), true)

  await a.release()

  assert.equal(await b.acquire('sup-b', TTL), true)
  assert.equal(await a.heartbeat(), false)
})

test('the same owner re-acquiring RENEWS rather than deadlocking on itself', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  assert.equal(await a.acquire('sup-a', TTL), true)
  nowMs = T0 + 1000
  assert.equal(await a.acquire('sup-a', TTL), true)

  nowMs = T0 + TTL + 500
  // Renewed at T0+1000, so it is still alive here.
  assert.equal(await supervisor().acquire('sup-b', TTL), false)
})

test('a heartbeat before any acquire is false, not a silent yes', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  assert.equal(await supervisor().heartbeat(), false)
})

test('a supervisor whose acquire was refused cannot heartbeat or release the holder out', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const b = supervisor()
  assert.equal(await a.acquire('sup-a', TTL), true)
  assert.equal(await b.acquire('sup-b', TTL), false)

  assert.equal(await b.heartbeat(), false)
  await b.release()

  assert.equal(await a.heartbeat(), true)
})

// ------------------------------------------------------ genuine races
//
// Every test above drives the two supervisors in an order this file chose. That
// proves the FILTER is right; it cannot prove the claim is atomic, and it would
// not notice a refactor that put a `findOne` pre-check in front of the
// `findOneAndUpdate` — under author-controlled ordering a read-then-write gap
// looks identical to a compare-and-set. These fire both claims at once and
// assert the only shape that may ever come back: EXACTLY ONE WINNER. Which one
// wins is the database's business, and the assertions never name it.

test('two supervisors claiming AT ONCE — exactly one gets the book', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const b = supervisor()

  const won = await Promise.all([a.acquire('sup-a', TTL), b.acquire('sup-b', TTL)])

  assert.equal(won.filter(Boolean).length, 1, `exactly one supervisor may steer, got ${String(won)}`)
  const [winner, loser] = won[0] === true ? [a, b] : [b, a]
  assert.equal(await winner.heartbeat(), true)
  assert.equal(await loser.heartbeat(), false)
  assert.equal(await handle!.db.collection(SUPERVISOR_LEASE_COLLECTION).countDocuments({}), 1)
})

test('two supervisors taking an EXPIRED lease at once — still exactly one', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // The dangerous shape: both claims MATCH the document, so nothing but the
  // server re-evaluating the filter under the write keeps them apart.
  assert.equal(await supervisor().acquire('sup-dead', TTL), true)
  nowMs = T0 + TTL + 1

  const a = supervisor()
  const b = supervisor()
  const won = await Promise.all([a.acquire('sup-a', TTL), b.acquire('sup-b', TTL)])

  assert.equal(won.filter(Boolean).length, 1, `exactly one takeover may land, got ${String(won)}`)
  const [winner, loser] = won[0] === true ? [a, b] : [b, a]
  assert.equal(await winner.heartbeat(), true)
  assert.equal(await loser.heartbeat(), false)
  assert.equal(await handle!.db.collection(SUPERVISOR_LEASE_COLLECTION).countDocuments({}), 1)
})

test('the unique index builds ITSELF — a lease nobody prepared still excludes', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // No `ensureIndexes()` anywhere below: the boot path forgetting to call it
  // must not be the difference between one supervisor and two.
  await handle!.db.collection(SUPERVISOR_LEASE_COLLECTION).dropIndex('key_1')
  const a = supervisor()
  const b = supervisor()

  const won = await Promise.all([a.acquire('sup-a', TTL), b.acquire('sup-b', TTL)])

  assert.equal(won.filter(Boolean).length, 1, `exactly one supervisor may steer, got ${String(won)}`)
  assert.equal(await handle!.db.collection(SUPERVISOR_LEASE_COLLECTION).countDocuments({}), 1)
})

test('a lease document with no expiry is not a lease held forever', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // What an older build or a hand-repair in the shell can leave behind. Without
  // the `expiresAt: null` arm of the claim, nothing could ever take this book.
  await handle!.db.collection(SUPERVISOR_LEASE_COLLECTION).insertOne({ key: KEY, owner: 'ghost' })

  assert.equal(await supervisor().acquire('sup-a', TTL), true)
})

test('a TTL that is not a positive number is refused, not written', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  await assert.rejects(() => a.acquire('sup-a', Number.NaN), /ttlMs/)
  await assert.rejects(() => a.acquire('sup-a', 0), /ttlMs/)

  assert.equal(await handle!.db.collection(SUPERVISOR_LEASE_COLLECTION).countDocuments({}), 0)
  assert.equal(a.owner, null)
})

test('two leases with different keys do not contend', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = supervisor()
  const other = new Lease({ collection, key: 'desk-supervisor-shadow', now })

  assert.equal(await a.acquire('sup-a', TTL), true)
  assert.equal(await other.acquire('sup-b', TTL), true)
  assert.equal(await a.heartbeat(), true)
})
