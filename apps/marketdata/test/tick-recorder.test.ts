/**
 * THE TAPE WE NEVER KEPT.
 *
 * Nothing in this tree stores a tick time series. `desk-marks` is a 60-second
 * upsert-in-place of ONE "last known" document per token, and its own header in
 * `main.ts` says DISPLAY ONLY — it is a photograph, not a tape. A delta
 * controller that adds on a new peak and cuts on a drawdown cannot be replayed
 * or tuned against a photograph, so every constant in it would be a guess that
 * nobody could ever check against a real session.
 *
 * `TickRecorder` is that tape. The failures these tests prevent, in order:
 *
 *   - recording tokens no book watches (a full chain, all session, for nothing);
 *   - losing the batching that keeps the write off the feed's hot path, or the
 *     `ordered: false` that stops one bad row from voiding the rest of a batch;
 *   - writing a missing book as `0` — a never-traded strike's absent bid is not
 *     a bid of zero, and a replay that reads it as one prices a fill nobody
 *     could have got;
 *   - and the one that actually takes the desk down: letting a stalled Mongo
 *     turn an unbounded in-memory buffer into an OOM in the ONE process that
 *     holds the Kite login. Every consumer's health check would report "feed
 *     not alive" while the real story was a tape nobody asked for.
 *
 * There is no `require-mongo` helper in this suite and this needs none: the
 * recorder is a buffer with a flush, so the fake below is the entire Mongo
 * surface it touches.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TickRecorder,
  createTickRecorder,
  ensureTickIndexes,
  tickRecordingEnabled,
  DEFAULT_TICK_FLUSH_MS,
  MAX_BUFFERED_TICKS,
  TICK_COLLECTION,
  TICK_TTL_INDEX,
  TICK_TTL_SECONDS,
  type MdTick,
  type TickDb,
  type TickRow,
} from '../src/tick-recorder.ts'

const NOW = Date.UTC(2026, 8, 15, 4, 30) // Tue 10:00 IST
const WATCHED = 111
const UNWATCHED = 222

interface Batch {
  readonly docs: readonly TickRow[]
  readonly options: { ordered?: boolean } | undefined
}

interface FakeDb extends TickDb {
  readonly batches: Batch[]
  readonly indexes: { spec: Record<string, 1 | -1>; options: Record<string, unknown> | undefined }[]
  readonly named: string[]
}

/** The whole Mongo surface the recorder touches. `fail` makes every write reject. */
function fakeDb(opts: { fail?: boolean } = {}): FakeDb {
  const batches: Batch[] = []
  const indexes: { spec: Record<string, 1 | -1>; options: Record<string, unknown> | undefined }[] = []
  const named: string[] = []
  const col = {
    insertMany: async (docs: readonly TickRow[], options?: { ordered?: boolean }) => {
      if (opts.fail === true) throw new Error('not primary and secondaryOk=false')
      batches.push({ docs: [...docs], options })
      return {}
    },
    createIndex: async (
      spec: Record<string, 1 | -1>,
      options?: { expireAfterSeconds?: number; name?: string },
    ) => {
      if (opts.fail === true) throw new Error('Index with name already exists with different options')
      indexes.push({ spec, options })
      return {}
    },
  }
  return {
    batches,
    indexes,
    named,
    collection: (name: string) => {
      named.push(name)
      return col
    },
  }
}

/** A recorder watching exactly one token, with a log the tests can read back. */
function recorder(db: TickDb, lines: string[] = []): TickRecorder {
  return new TickRecorder({
    db,
    tokens: () => new Set([WATCHED]),
    now: () => NOW,
    log: (msg) => lines.push(msg),
  })
}

const tick = (over: Partial<MdTick> = {}): MdTick => ({
  token: WATCHED,
  price: 100,
  ts: NOW,
  ...over,
})

test('only admitted tokens are recorded', async () => {
  const db = fakeDb()
  const rec = recorder(db)
  rec.onTick(tick())
  rec.onTick(tick({ token: UNWATCHED, price: 200 })) // not this book's — the rest of the feed
  assert.equal(await rec.flush(), 1)
  assert.equal(db.batches[0]?.docs.length, 1)
  assert.equal(db.batches[0]?.docs[0]?.token, WATCHED)
  rec.stop()
})

test('the admitted set is re-asked on EVERY tick, never captured once', async () => {
  // The desk re-plans its subscriptions every 30s: a book that rolls to next
  // week stops watching this week's strikes mid-session. A recorder holding a
  // snapshot of the set taken at boot would tape the wrong chain until restart.
  const db = fakeDb()
  let watched = new Set([WATCHED])
  const rec = new TickRecorder({ db, tokens: () => watched, now: () => NOW })
  rec.onTick(tick())
  watched = new Set([UNWATCHED])
  rec.onTick(tick())
  assert.equal(await rec.flush(), 1, 'the second tick is no longer admitted')
  rec.stop()
})

test('ticks batch and flush, and flush is idempotent when empty', async () => {
  const db = fakeDb()
  const rec = recorder(db)
  for (let i = 0; i < 500; i++) rec.onTick(tick({ price: 100 + i, ts: NOW + i }))
  assert.equal(await rec.flush(), 500)
  assert.equal(db.batches.length, 1, '500 ticks are ONE write, not 500')
  assert.equal(await rec.flush(), 0)
  assert.equal(db.batches.length, 1, 'an empty flush must not write an empty batch')
  rec.stop()
})

test('the row is {token, ts, price, bid, ask} on desk-ticks, written UNORDERED', async () => {
  const db = fakeDb()
  const rec = recorder(db)
  rec.onTick(tick({ price: 116, ts: NOW + 7, bid: 115.5, ask: 117.15 }))
  await rec.flush()
  assert.deepEqual(db.named, [TICK_COLLECTION])
  const row = db.batches[0]?.docs[0]
  assert.equal(row?.token, WATCHED)
  assert.equal(row?.ts, NOW + 7, "the FEED's timestamp, not the recorder's clock")
  assert.equal(row?.price, 116)
  assert.equal(row?.bid, 115.5)
  assert.equal(row?.ask, 117.15)
  // `ordered: false` — one duplicate or oversized row must not void the rest of
  // the batch. The tape is append-only; there is no order to preserve in it.
  assert.equal(db.batches[0]?.options?.ordered, false)
  rec.stop()
})

test('a tick with no two-sided book records bid/ask as NULL, never as zero', async () => {
  // A never-traded strike arrives with no depth at all. `tickPayload` already
  // omits bid/ask there rather than inventing zeros; the tape must carry that
  // same absence forward, because a replay reading bid 0 would price an exit
  // nobody could ever have got.
  const db = fakeDb()
  const rec = recorder(db)
  rec.onTick(tick())
  await rec.flush()
  const row = db.batches[0]?.docs[0]
  assert.equal(row?.bid, null)
  assert.equal(row?.ask, null)
  rec.stop()
})

test('a tick with no usable ts falls back to the injected clock, never NaN', async () => {
  // `now` exists for exactly this: a row whose `ts` is undefined or NaN is a row
  // that sorts nowhere and expires never. There is no sentinel zero available —
  // epoch 0 is a real instant and would sort before every other row on the tape.
  const db = fakeDb()
  const rec = recorder(db)
  rec.onTick({ token: WATCHED, price: 100, ts: Number.NaN })
  await rec.flush()
  assert.equal(db.batches[0]?.docs[0]?.ts, NOW)
  rec.stop()
})

test('the flush timer runs on its own, and stop() ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const db = fakeDb()
  const rec = recorder(db)
  rec.onTick(tick())
  t.mock.timers.tick(DEFAULT_TICK_FLUSH_MS)
  await drain()
  assert.equal(db.batches.length, 1, 'nobody called flush() — the timer did')

  rec.stop()
  rec.onTick(tick())
  t.mock.timers.tick(DEFAULT_TICK_FLUSH_MS * 10)
  await drain()
  assert.equal(db.batches.length, 1, 'a stopped recorder writes nothing more')
})

test('a buffer past the hard cap is DROPPED, and the alarm is logged exactly ONCE', async () => {
  // Mongo stalls. The feed does not. Without this the buffer grows for as long
  // as the stall lasts, inside the one process that holds the Kite login — so
  // the tape would kill the feed it was taping. Dropping is the correct trade:
  // a gap in a research tape costs nothing a restart does not already cost.
  const db = fakeDb()
  const lines: string[] = []
  const rec = recorder(db, lines)
  for (let i = 0; i < MAX_BUFFERED_TICKS + 2; i++) rec.onTick(tick({ ts: NOW + i }))
  const written = await rec.flush()
  assert.ok(written <= 2, `the buffer was dropped, not flushed (wrote ${written})`)
  const alarms = lines.filter((l) => l.includes('tick tape'))
  assert.equal(alarms.length, 1)

  // A stall that lasts minutes must not write this line thousands of times per
  // minute into the log the operator reads to diagnose the stall itself.
  for (let i = 0; i < MAX_BUFFERED_TICKS + 2; i++) rec.onTick(tick({ ts: NOW + i }))
  await rec.flush()
  assert.equal(lines.filter((l) => l.includes('tick tape')).length, 1)
  rec.stop()
})

test('a failed insert never throws into the feed, and never re-queues the batch', async () => {
  // `flush()` is called from a timer with `void`, so a rejection here is an
  // unhandled one — which `installCrashGuards` turns into a process exit for
  // the whole market-data host. And re-queueing a failing batch is how a stall
  // becomes the unbounded buffer the cap above exists to prevent.
  const db = fakeDb({ fail: true })
  const lines: string[] = []
  const rec = recorder(db, lines)
  rec.onTick(tick())
  assert.equal(await rec.flush(), 0, 'nothing was written, and nothing threw')
  assert.equal(lines.length, 1)
  assert.equal(await rec.flush(), 0, 'the failed batch is gone, not retried forever')
  rec.stop()
})

test('THE TAPE IS INERT unless DESK_RECORD_TICKS=1', () => {
  // The gate is the whole promise of this task: with the variable unset this
  // process must behave exactly as it does today. The factory returning null is
  // what makes that structural — main.ts has no recorder to subscribe, so no
  // md.tick subscriber is added and the tick path is byte-for-byte unchanged.
  const db = fakeDb()
  const deps = { db, tokens: () => new Set([WATCHED]), now: () => NOW }
  assert.equal(createTickRecorder({ ...deps, env: {} }), null)
  assert.equal(createTickRecorder({ ...deps, env: { DESK_RECORD_TICKS: '0' } }), null)
  assert.equal(createTickRecorder({ ...deps, env: { DESK_RECORD_TICKS: 'true' } }), null)
  assert.equal(db.named.length, 0, 'a disabled recorder never even names the collection')

  assert.equal(tickRecordingEnabled({}), false)
  assert.equal(tickRecordingEnabled({ DESK_RECORD_TICKS: '1' }), true)
  const on = createTickRecorder({ ...deps, env: { DESK_RECORD_TICKS: '1' } })
  assert.ok(on instanceof TickRecorder)
  on.stop()
})

test('the indexes are the replay query index and a 30-day TTL', async () => {
  const db = fakeDb()
  assert.equal(await ensureTickIndexes(db, () => {}), true)
  // `{token, ts}` is how a replay reads one instrument's session in order.
  assert.deepEqual(db.indexes[0]?.spec, { token: 1, ts: 1 })
  // THE TTL RIDES ON A DATE, NOT ON `ts`. Mongo only expires documents whose
  // indexed field is a BSON Date — a TTL index on the epoch-ms NUMBER compiles,
  // builds, reports healthy and deletes nothing, forever. `tsDate` is that
  // anchor and nothing else reads it; `ts` stays the number the replay does
  // arithmetic on. Same split as the gateway's `updatedAtDate` (session-store).
  assert.deepEqual(db.indexes[1]?.spec, { tsDate: 1 })
  assert.equal(db.indexes[1]?.options?.['expireAfterSeconds'], TICK_TTL_SECONDS)
  assert.equal(db.indexes[1]?.options?.['name'], TICK_TTL_INDEX)
  assert.equal(TICK_TTL_SECONDS, 30 * 24 * 60 * 60)
})

test('every row carries the TTL anchor as a real Date', async () => {
  const db = fakeDb()
  const rec = recorder(db)
  rec.onTick(tick({ ts: NOW + 3 }))
  await rec.flush()
  const row = db.batches[0]?.docs[0]
  assert.ok(row?.tsDate instanceof Date, 'a number here expires nothing, ever')
  assert.equal(row?.tsDate.getTime(), NOW + 3, 'the anchor is the same instant as `ts`')
  rec.stop()
})

test('a refused index does NOT take the feed host down', async () => {
  // The F-42 boot-safety rule (`ensureSessionTtlIndex`): an index is a guard
  // against a future problem, and this runs on the boot path of the process
  // holding the only Kite login. A conflicting index left by an earlier build
  // is a tidy-up for an operator, not a reason for the desk to have no feed.
  const lines: string[] = []
  assert.equal(await ensureTickIndexes(fakeDb({ fail: true }), (m) => lines.push(m)), false)
  assert.equal(lines.length, 1, 'it is logged, never silent')
})

/** Let the awaited fake insert settle after a mocked timer tick. */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
