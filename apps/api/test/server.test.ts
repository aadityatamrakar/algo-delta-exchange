/**
 * End-to-end HTTP tests: a real server, real Mongo, real fetch.
 *
 * The unit tests cover the book semantics and the integration tests cover the
 * database guarantees. What is left, and what this file covers, is the wire:
 * auth, validation rejections, and the exact JSON a Python client will parse.
 * Those are the things that break silently between the two sides.
 */

import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import { healthRoutes } from '../src/routes/health.ts'
import { deskRoutes } from '../src/routes/desk.ts'
import { isAdded, isOn } from '../src/strategies.ts'
import { DEFAULT_BOOK } from '../src/books-registry.ts'
import { REPAIR_HOLD_MS } from '../src/repair-apply.ts'

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_http_test'
const TOKEN = 'test-token-do-not-use-in-prod'
const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'
const TAG = 'DESK_BHEL'
/** The one instant this server's clock is fixed at, for both the service and the routes. */
const NOW = Date.UTC(2026, 6, 27, 5, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  // BHEL's real grid is 2.5 wide — the reason strike step is inferred, not set.
  for (let strike = 380; strike <= 470; strike += 2.5) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: Math.round(strike * 100) + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BHEL26AUG${strike}${type}`,
        name: SYMBOL,
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: 2625,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  return new OptionMaster(rows)
}

const MARKS = new StaticMarks(
  Object.fromEntries(
    Array.from({ length: 37 }, (_, i) => 380 + i * 2.5).flatMap((k) => [
      [`BHEL26AUG${k}CE`, 12],
      [`BHEL26AUG${k}PE`, 11],
    ]),
  ),
  { BHEL: 417 },
)

/**
 * ONLY THE CONNECT IS CAUGHT — see `service.integration.test.ts` for the full
 * argument. An index that cannot be built, or a server that will not listen,
 * must FAIL this file rather than skip it into a green run.
 */
before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle.db), live: new LiveRail(handle.db, []) },
    master: { current: master },
    marks: MARKS,
    clock: { now: () => NOW },
  })
  const gate = bearerGate(TOKEN)
  const apiDeps: ApiDeps = {
    db: handle.db,
    store,
    service,
    master: { current: master },
    log: () => {},
    now: () => NOW,
  }
  server = createBridgeServer({
    gate,
    publicRoutes: [healthRoutes(apiDeps)],
    routes: [deskRoutes({ ...apiDeps, gate })],
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  await store.ensureIndexes()
  // Decisions are gated on a registry row and an unregistered tag is refused
  // outright, so the fixture registers its own tag exactly as a deployment does.
  await store.registerStrategy(
    { tag: TAG, kind: 'external', modes: { paper: { enabled: true }, live: { enabled: true } } },
    Date.now(),
  )
})

function itHttp(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const post = (path: string, body: unknown, headers: Record<string, string> = auth): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

/**
 * PUT A BOOK ON THE TAG, without routing anything.
 *
 * These tests are about the READ surface — positions, greeks, the books
 * listing, diff, close-all's validation — and every one of them needs legs to
 * read. They used to get them by posting `POST /v1/desk/actions`, which the D9
 * cutover removed; `/v1/desk/seed` is the endpoint that exists to record a
 * position the account already holds, it writes the book directly with no
 * orders, and it is a better fixture besides: what is under test here is what
 * the read serves, not how the legs got there.
 *
 * `rate` is the entry price the seed records; the marks fixture prices every CE
 * at 12 and every PE at 11, so a leg seeded at its own mark reads as flat.
 */
const seedLegs = (
  legs: readonly { strike: number; type: 'CE' | 'PE'; qty?: number; rate?: number }[],
  over: Record<string, unknown> = {},
): Promise<Response> =>
  post('/v1/desk/seed', {
    tag: TAG,
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'paper',
    legs: legs.map((l) => ({
      strike: l.strike,
      type: l.type,
      // Short 5 lots, the size the greeks assertions below are computed at.
      qty: l.qty ?? -13125,
      rate: l.rate ?? (l.type === 'CE' ? 12 : 11),
    })),
    ...over,
  })

/** The one-leg book most of these tests want: 5 lots short the 420CE. */
const seedOneLeg = (over: Record<string, unknown> = {}): Promise<Response> =>
  seedLegs([{ strike: 420, type: 'CE' }], over)

itHttp('health needs no token', async () => {
  const res = await fetch(`${base}/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

itHttp('every desk route requires a bearer token', async () => {
  const body = { tag: TAG, symbol: SYMBOL, legs: [{ strike: 420, type: 'CE', qty: -13125 }] }
  const noAuth = await post('/v1/desk/declare', body, { 'content-type': 'application/json' })
  assert.equal(noAuth.status, 401)
  const wrong = await post('/v1/desk/declare', body, {
    authorization: 'Bearer wrong-token-same-length!!',
    'content-type': 'application/json',
  })
  assert.equal(wrong.status, 401)
  assert.equal((await post('/v1/desk/declare', body)).status, 200)
})

itHttp('malformed JSON gets a 400, not a 500', async () => {
  const res = await fetch(`${base}/v1/desk/declare`, { method: 'POST', headers: auth, body: '{oops' })
  assert.equal(res.status, 400)
})

/**
 * THE PYTHON-FACING WRITE SURFACE IS GONE (D9), and a client that still calls
 * it must be told so rather than answered.
 *
 * A 404 is the honest answer and the safe one: a 200 on a dead path would let a
 * publisher believe a decision was applied, and the desk would look like it was
 * holding when nothing had reached it at all.
 */
itHttp('POST /v1/desk/actions is a 404 — the Python decision path is removed', async () => {
  const res = await post('/v1/desk/actions', {
    symbol: SYMBOL, expiry: EXPIRY, mode: 'paper', tag: TAG, decisionId: 'd-1',
    actions: [{ op: 'open', ts: 'CE420#0', strike: 420, type: 'CE', side: 'Sell', qty: 13125 }],
  })
  assert.equal(res.status, 404)
  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 0, 'and nothing was booked')
})

itHttp('positions returns greeks a client can parse', async () => {
  await seedLegs([{ strike: 420, type: 'CE' }, { strike: 415, type: 'PE' }])
  const res = await fetch(`${base}/v1/desk/positions?tag=${TAG}&mode=paper`, { headers: auth })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal((body['legs'] as unknown[]).length, 2)
  const greeks = body['greeks'] as Record<string, unknown>
  assert.equal((greeks['legs'] as unknown[]).length, 2)
  assert.equal(body['spot'], 417)
  /**
   * THE VALUE, not `typeof === 'number'`.
   *
   * The fixture is deterministic — 13125 short of the 420CE at 12 and of the
   * 415PE at 11, spot 417, a fixed clock — so the net delta has exactly one
   * right answer, and `typeof` was satisfied by every wrong one: a sign
   * inversion booking a short as a long (+926), a leg silently dropped from the
   * total (-6619), or the 0 an unpriced book returns. Rounded to one decimal so
   * the assertion is about the arithmetic and not about float formatting; a
   * change to it must be a deliberate change to `@algomaker/greeks`. (-926.7 ->
   * -926.9 on 2026-10-23: `yearsToExpiry` prices to the 15:40 F&O close, ten
   * minutes more tenor; spec 2026-10-23 G6.)
   */
  const netDelta = greeks['netDelta']
  assert.equal(typeof netDelta, 'number')
  assert.equal(Number((netDelta as number).toFixed(1)), -926.9, 'both legs SHORT: the net is negative')
  // ...and the total is the sum of the QTY-SCALED per-leg deltas it reports, so
  // the headline number and the rows under it can never drift apart.
  const legDeltas = (greeks['legs'] as { positionDelta: number }[]).reduce(
    (n, l) => n + l.positionDelta,
    0,
  )
  assert.equal(Number(legDeltas.toFixed(1)), -926.9)
  assert.equal(typeof greeks['netTheta'], 'number')
  assert.ok((greeks['netTheta'] as number) > 0, 'a short book earns theta')
})

itHttp('positions?tag= returns exactly one book', async () => {
  await seedOneLeg()
  const res = await fetch(`${base}/v1/desk/positions?tag=${TAG}&mode=paper`, { headers: auth })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['tag'], TAG)
  assert.equal(body['symbol'], SYMBOL)
})

/**
 * A repair run exactly as `RepairApplyService` writes it, seeded straight into
 * the register. What is under test here is not how a run is started — that is
 * `repair-apply.test.ts` — but that the payload the PYTHON DRIVER polls reads
 * the register at all, and reads it by the service's own rule.
 */
async function seedApply(state: string, createdAt: number, tag = TAG): Promise<string> {
  const id = `apply-${tag}-${state}-${createdAt}`
  await store.collection(COLLECTIONS.repairApplies).insertOne({
    _id: id,
    tag,
    mode: 'paper',
    style: 'fast',
    bookPrint: 'print-1',
    state,
    orders: [],
    createdAt,
    updatedAt: createdAt,
  })
  return id
}

itHttp('positions says when a repair is mid-flight on the tag', async () => {
  await seedOneLeg()
  const heldAt = NOW - 60_000
  const applyId = await seedApply('RUNNING', heldAt)

  const res = await fetch(`${base}/v1/desk/positions?tag=${TAG}&mode=paper`, { headers: auth })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  const hold = body['repairHold'] as Record<string, unknown> | null
  assert.notEqual(hold, null, 'a RUNNING apply on this tag must reach the driver')
  assert.equal(hold?.['applyId'], applyId)
  assert.equal(hold?.['heldAt'], heldAt, 'the hold started when the run did')
  assert.equal(hold?.['untilMs'], heldAt + REPAIR_HOLD_MS, 'and it expires on the run\'s TTL')
  // The hold rides ALONGSIDE the book; it does not replace it. A driver that
  // stands down still needs the positions it is standing down over.
  assert.equal((body['legs'] as unknown[]).length, 1)
})

itHttp('a finished run, and another tag\'s run, leave the tag unheld', async () => {
  await seedOneLeg()
  await seedApply('DONE', NOW - 60_000)
  await seedApply('RUNNING', NOW - 60_000, 'DESK_OTHER')

  const res = await fetch(`${base}/v1/desk/positions?tag=${TAG}&mode=paper`, { headers: auth })
  const body = (await res.json()) as Record<string, unknown>
  // PRESENT AND NULL, never absent: the Python side reads one stable key, and
  // `missing` would be indistinguishable from a bridge that cannot answer.
  assert.ok('repairHold' in body, 'the key is on every positions payload')
  assert.equal(body['repairHold'], null)
})

itHttp('a HALTED run releases the tag — the driver takes the book back', async () => {
  await seedOneLeg()
  // The state a wave lands in when it will not guess: the repair stopped
  // half-placed and a human has to look at it. The DRIVER, though, must resume
  // — a halted run is not running, and a book left unmanaged because nothing
  // ever cleared the hold is the worse of the two failures.
  await seedApply('HALTED', NOW - 60_000)

  const res = await fetch(`${base}/v1/desk/positions?tag=${TAG}&mode=paper`, { headers: auth })
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['repairHold'], null)
})

itHttp('a run still RUNNING past its TTL holds nothing — the payload agrees with the apply service', async () => {
  await seedOneLeg()
  // A desk-api that died mid-run leaves this document behind forever. The
  // service would let a new apply start against it; a driver standing down on
  // it would leave the book unmanaged for the rest of the session.
  await seedApply('RUNNING', NOW - REPAIR_HOLD_MS - 1)

  const res = await fetch(`${base}/v1/desk/positions?tag=${TAG}&mode=paper`, { headers: auth })
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['repairHold'], null)
})

itHttp('positions?symbol= returns every book on that symbol, as an array', async () => {
  const TAG2 = 'DESK_BHEL_2'
  await store.registerStrategy(
    { tag: TAG2, kind: 'external', modes: { paper: { enabled: true }, live: { enabled: true } } },
    Date.now(),
  )
  await seedOneLeg()
  await seedLegs([{ strike: 415, type: 'PE' }], { tag: TAG2 })

  const res = await fetch(`${base}/v1/desk/positions?symbol=${SYMBOL}&mode=paper`, { headers: auth })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  const books = body['books'] as Record<string, unknown>[]
  assert.ok(Array.isArray(books))
  assert.equal(books.length, 2, 'both tags carry a book on BHEL')
  const tags = books.map((b) => b['tag']).sort()
  assert.deepEqual(tags, [TAG, TAG2].sort())
  // Each entry is fully priced (it went through positions()), not just a stub.
  for (const b of books) assert.equal(typeof (b['greeks'] as Record<string, unknown>)['netDelta'], 'number')
})

itHttp('positions?symbol= isolates a book that cannot be priced — its siblings still return', async () => {
  const TAG2 = 'DESK_BHEL_BROKEN'
  await seedOneLeg()
  // A genuinely malformed book, inserted directly rather than mocked: no
  // `instrument` on the leg, which is exactly the shape `positions()` cannot
  // read — it dereferences `l.instrument.instrumentToken` unconditionally, so
  // this leg throws rather than merely pricing badly.
  await store.collection(COLLECTIONS.books).insertOne({
    tag: TAG2,
    mode: 'paper',
    symbol: SYMBOL,
    expiry: EXPIRY,
    legs: [
      { underlying: SYMBOL, expiry: EXPIRY, strike: 415, type: 'PE', side: 'Sell', qty: -13125, entryPrice: 11, openedTs: 1 },
    ],
    updatedAt: Date.now(),
  })

  const res = await fetch(`${base}/v1/desk/positions?symbol=${SYMBOL}&mode=paper`, { headers: auth })
  assert.equal(res.status, 200, 'one unreadable book must not 500 the whole symbol view')
  const body = (await res.json()) as Record<string, unknown>
  const books = body['books'] as Record<string, unknown>[]
  assert.equal(books.length, 2, 'both the healthy and the broken book are reported')
  const healthy = books.find((b) => b['tag'] === TAG)
  const broken = books.find((b) => b['tag'] === TAG2)
  assert.ok(healthy !== undefined, 'the healthy book survives its sibling failing')
  assert.equal(healthy?.['complete'], true)
  assert.equal((healthy?.['legs'] as unknown[]).length, 1)
  assert.ok(broken !== undefined, 'the unreadable book is reported degraded, not dropped')
  assert.equal(broken?.['complete'], false, 'a book that could not be priced must not claim completeness')
})

itHttp('positions with neither tag nor symbol is a 400', async () => {
  const res = await fetch(`${base}/v1/desk/positions?mode=paper`, { headers: auth })
  assert.equal(res.status, 400)
  const body = (await res.json()) as Record<string, unknown>
  assert.match(String(body['error']), /tag or symbol/)
})

itHttp('diff with no tag is still a 400 — symbol is not a valid key here', async () => {
  const res = await fetch(`${base}/v1/desk/diff?symbol=${SYMBOL}&mode=paper`, { headers: auth })
  assert.equal(res.status, 400)
  const body = (await res.json()) as Record<string, unknown>
  assert.match(String(body['error']), /tag is required/)
})

itHttp('declare then diff round-trips', async () => {
  await seedOneLeg()
  const dec = await post('/v1/desk/declare', {
    tag: TAG,
    symbol: SYMBOL,
    legs: [{ strike: 420, type: 'CE', qty: -13125 }],
  })
  assert.equal(dec.status, 200)
  const res = await fetch(`${base}/v1/desk/diff?tag=${TAG}`, { headers: auth })
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['inSync'], true)
})

itHttp('the instruments listing names every underlying with a chain', async () => {
  const res = await fetch(`${base}/v1/desk/instruments`, { headers: auth })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.deepEqual(body['underlyings'], [SYMBOL])
  // Every name it offers must answer the endpoint below it. The picker this
  // feeds exists so a symbol cannot be mistyped, and a name here that 404s
  // there would put the operator straight back at the failure it removes.
  for (const u of body['underlyings'] as string[]) {
    assert.equal((await fetch(`${base}/v1/desk/instruments/${u}`, { headers: auth })).status, 200)
  }
})

itHttp('the listing is not reachable without a token — it names the desk universe', async () => {
  assert.equal((await fetch(`${base}/v1/desk/instruments`)).status, 401)
})

itHttp('the instruments endpoint reports the INFERRED strike step', async () => {
  const res = await fetch(`${base}/v1/desk/instruments/${SYMBOL}?expiry=${EXPIRY}`, { headers: auth })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['lotSize'], 2625)
  assert.equal(body['strikeStep'], 2.5, "BHEL's grid is 2.5, not the 5 its round strikes suggest")
  assert.ok((body['strikes'] as number[]).includes(417.5))
})

itHttp('seed records an already-held position WITHOUT routing orders', async () => {
  const res = await post('/v1/desk/seed', {
    tag: TAG,
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'paper',
    legs: [
      { strike: 420, type: 'CE', qty: -13125, rate: 15 },
      { strike: 470, type: 'CE', qty: 39375, rate: 2.9 },
    ],
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal((body['booked'] as unknown[]).length, 2)

  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 2)
  assert.equal(book[0]?.entryPrice, 15, 'the entry price paid, not the live mark')

  // The whole point: these legs are already at the broker.
  const orders = await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()
  assert.equal(orders.length, 0, 'seeding must not route any order')
})

/**
 * The `replace` half of this moved behind re-auth on 2026-08-16 (F-30): a seed
 * that overwrites a book's legs is the erasure the DELETE route refuses on
 * principle, and it used to be reachable by any credential that got to the API
 * — the shared machine bearer included. This fixture IS that bearer, and a
 * machine principal can never satisfy `reauth` by design, so the last step now
 * pins the refusal rather than the overwrite. The operator's path is
 * `a live seed and a replace both cost the password` below.
 */
itHttp('seeding over a non-empty book is refused unless replace is set — and replace now costs a password', async () => {
  const seed = {
    tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper',
    legs: [{ strike: 420, type: 'CE', qty: -13125, rate: 15 }],
  }
  assert.equal((await post('/v1/desk/seed', seed)).status, 200)

  const again = await post('/v1/desk/seed', seed)
  assert.equal(again.status, 409, 'a re-seed would discard every fill since')
  assert.match(String(((await again.json()) as Record<string, unknown>)['error']), /already holds/)

  const replaced = await post('/v1/desk/seed', { ...seed, replace: true })
  assert.equal(replaced.status, 403, 'the machine bearer cannot overwrite a book on its own')
  const body = (await replaced.json()) as Record<string, unknown>
  assert.equal(body['reauthRequired'], true)
  // And it really did not overwrite: the book is still the one seeded first.
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1)
})

itHttp('seed rejects a quantity that is not a whole number of lots', async () => {
  // 13000 is not a multiple of BHEL's 2625 lot, so it cannot have been traded.
  const res = await post('/v1/desk/seed', {
    tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper',
    legs: [{ strike: 420, type: 'CE', qty: -13000, rate: 15 }],
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal((body['booked'] as unknown[]).length, 0)
  assert.match(
    String((body['unresolved'] as Record<string, unknown>[])[0]?.['reason']),
    /not a multiple of lot size 2625/,
  )
})

itHttp('seed rejects a zero or negative entry rate', async () => {
  for (const rate of [0, -5]) {
    const res = await post('/v1/desk/seed', {
      tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper',
      legs: [{ strike: 420, type: 'CE', qty: -13125, rate }],
    })
    assert.equal(res.status, 400, `rate ${rate} must be rejected`)
  }
})

itHttp('books lists every book with its net delta', async () => {
  await seedOneLeg()
  const res = await fetch(`${base}/v1/desk/books?mode=paper`, { headers: auth })
  assert.equal(res.status, 200)
  const books = ((await res.json()) as Record<string, unknown>)['books'] as Record<string, unknown>[]
  assert.equal(books.length, 1)
  assert.equal(books[0]?.['symbol'], SYMBOL)
  assert.equal(books[0]?.['legs'], 1)
  assert.equal(books[0]?.['complete'], true, 'every leg priced, so the delta is authoritative')
  // The VALUE. `typeof === 'number'` was equally satisfied by the 0 an entirely
  // unpriced book used to report, which reads as "flat" beside a book that is
  // short 13125 of the 420CE. -6619.5 since the greeks price to the 15:40 F&O
  // close (was -6619.4 to 15:30; spec 2026-10-23 G6).
  assert.equal(Number((books[0]?.['netDelta'] as number).toFixed(1)), -6619.5)
})

/**
 * A BOOK NOBODY CAN PRICE REPORTS `null`, NEVER 0.
 *
 * `positions()` does not throw for an unmarked leg — it drops the leg and names
 * it — and `bookGreeks([])` returns `netDelta: 0`. So a book whose feed is dead
 * advertised `+0` beside its tab, identical to a book that is genuinely flat.
 * On a delta dashboard that reads as "no action needed" while the book is
 * carrying real risk, which is the exact failure `positions()` documents in its
 * own comment and had fixed for `unpriced` but not for the number.
 */
itHttp('a book with no usable marks reports netDelta null, not zero', async () => {
  await seedOneLeg()
  // A second service over the SAME store, with a mark source that knows nothing
  // — the shape of a feed outage, without taking the fixture's server down.
  const blind = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle!.db), live: new LiveRail(handle!.db, []) },
    master: { current: master },
    marks: new StaticMarks({}, {}),
    clock: { now: () => NOW },
  })
  const [book] = await blind.books('paper')
  assert.equal(book?.symbol, SYMBOL)
  assert.equal(book?.legs, 1, 'the book is still listed — the position has not gone anywhere')
  assert.equal(book?.complete, false)
  assert.equal(book?.netDelta, null, '0 here is indistinguishable from genuinely flat')
})

/**
 * OFF-SESSION STALENESS TRAVELS WITH THE ROW.
 *
 * The listing computed `positions()` per book — which knows whether every mark
 * came off a live tick or off the persisted snapshot, and when — and then threw
 * both away. The Books page was left showing a last-mark time with nothing
 * saying it was a weekend snapshot rather than a tick, on the page an operator
 * scans to decide whether anything is wrong.
 */
itHttp('the books listing forwards WHETHER the marks are live, and as of when', async () => {
  await seedOneLeg()
  const SNAPSHOT_AT = Date.UTC(2026, 6, 24, 10, 0) // Friday's close, IST 15:30
  // A display source answering from the PERSISTED SNAPSHOT — the shape of a
  // book read out of hours, without taking the fixture's feed down.
  const closed = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle!.db), live: new LiveRail(handle!.db, []) },
    master: { current: master },
    marks: MARKS,
    displayMarks: () => ({ price: 12, asOf: SNAPSHOT_AT, live: false }),
    clock: { now: () => NOW },
  })
  const [book] = await closed.books('paper')
  assert.equal(book?.complete, true, 'the snapshot priced every leg — the delta is still real')
  assert.equal(book?.stale, true, 'not one of these marks came off a tick')
  assert.equal(book?.marksAsOf, SNAPSHOT_AT)

  // A live-marked book says so, rather than leaving the reader to infer it.
  const [live] = await (
    await fetch(`${base}/v1/desk/books?mode=paper`, { headers: auth })
  ).json().then((b) => (b as Record<string, unknown>)['books'] as Record<string, unknown>[])
  assert.equal(live?.['stale'], false)
  assert.equal(live?.['marksAsOf'], null)
})

/**
 * WHY THE SNAPSHOT FAILED, AND WHETHER THE MARKET WAS OPEN WHEN IT DID.
 *
 * Both are stamped by the gateway (`broker-snapshot.ts`) and both are useless
 * unless they reach the page. An expired token at 03:00 on a Sunday and an
 * expired token at 11:00 on a Tuesday are the same document otherwise, and the
 * second one means live orders are failing right now.
 */
itHttp('the broker view forwards the failure class and the session flag', async () => {
  await handle!.db.collection('desk-broker-snapshot').updateOne(
    { _id: 'xts' as unknown as never },
    {
      $set: {
        asOf: Date.UTC(2026, 6, 26, 5, 0), // Sunday
        ok: false,
        error: 'orders: Invalid Token',
        orders: [], positions: [], trades: [],
        errorClass: 'session',
        sessionOpenAtSnapshot: false,
      },
    },
    { upsert: true },
  )
  const res = await fetch(`${base}/v1/desk/broker`, { headers: auth })
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['ok'], false)
  assert.equal(body['errorClass'], 'session')
  assert.equal(body['sessionOpenAtSnapshot'], false)
  await handle!.db.collection('desk-broker-snapshot').deleteMany({})
})

itHttp('an OLDER snapshot carries neither field, and nothing is invented for it', async () => {
  // A gateway that has not been redeployed writes the doc without them. The
  // page's fail-loud default depends on their ABSENCE being visible — a
  // fabricated `errorClass: 'fatal'` or `sessionOpen: true` here would be a
  // claim about a snapshot nobody classified.
  await handle!.db.collection('desk-broker-snapshot').updateOne(
    { _id: 'xts' as unknown as never },
    { $set: { asOf: Date.UTC(2026, 6, 27, 4, 0), ok: false, error: 'boom', orders: [], positions: [], trades: [] } },
    { upsert: true },
  )
  const body = (await (await fetch(`${base}/v1/desk/broker`, { headers: auth })).json()) as Record<string, unknown>
  assert.equal('errorClass' in body, false)
  assert.equal('sessionOpenAtSnapshot' in body, false)
  await handle!.db.collection('desk-broker-snapshot').deleteMany({})
})

/**
 * MARGIN AT THE ACCOUNT — and, above all, the honest answer when there is none.
 *
 * The gateway publishes an order book, positions and trades; it does not publish
 * the account's balance. So the DEFAULT answer from this endpoint is "no figure,
 * and here is why", and the dashboard renders a dash. These tests pin that the
 * absence is reported rather than filled in — a 0%, a null read as zero, or a
 * utilisation derived from one half of the pair would all be a fabricated margin
 * reading on the tile an operator sizes the next trade from.
 */
itHttp('a snapshot with no funds says so, at 200, and invents no figure', async () => {
  await handle!.db.collection('desk-broker-snapshot').updateOne(
    { _id: 'xts' as unknown as never },
    { $set: { asOf: Date.UTC(2026, 6, 27, 4, 0), ok: true, orders: [], positions: [], trades: [] } },
    { upsert: true },
  )
  const res = await fetch(`${base}/v1/desk/broker/funds`, { headers: auth })
  assert.equal(res.status, 200, 'an absent balance is a state to render, not an error')
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['available'], false)
  assert.equal('utilisation' in body, false)
  assert.match(String(body['reason']), /no funds/)
  await handle!.db.collection('desk-broker-snapshot').deleteMany({})
})

itHttp('the margin figures are found wherever XTS buried them, commas and all', async () => {
  /*
    The real reply nests them at `BalanceList[0].limitObject.RMSSubLimits` and
    quotes money as a comma-grouped STRING. A hard-coded path answers null the
    day the vendor reshuffles it, and `Number('4,86,350.00')` is NaN — both would
    read on screen as "this account has no margin data".
  */
  await handle!.db.collection('desk-broker-snapshot').updateOne(
    { _id: 'xts' as unknown as never },
    {
      $set: {
        asOf: Date.UTC(2026, 6, 27, 4, 0),
        ok: true,
        orders: [], positions: [], trades: [],
        funds: {
          BalanceList: [
            { limitObject: { RMSSubLimits: { marginUtilized: '4,86,350.00', netMarginAvailable: '2,83,900.00' } } },
          ],
        },
      },
    },
    { upsert: true },
  )
  const body = (await (await fetch(`${base}/v1/desk/broker/funds`, { headers: auth })).json()) as Record<string, unknown>
  assert.equal(body['available'], true)
  assert.equal(body['utilised'], 486350)
  assert.equal(body['availableMargin'], 283900)
  assert.ok(Math.abs(Number(body['utilisation']) - 486350 / 770250) < 1e-12)
  await handle!.db.collection('desk-broker-snapshot').deleteMany({})
})

itHttp('one half of the pair is not a utilisation, and is not reported as one', async () => {
  // Utilised with no limit published is a rupee amount, not a percentage. `used
  // / 0` is not 100% either — both must read as unknown.
  await handle!.db.collection('desk-broker-snapshot').updateOne(
    { _id: 'xts' as unknown as never },
    {
      $set: {
        asOf: Date.UTC(2026, 6, 27, 4, 0),
        ok: true,
        orders: [], positions: [], trades: [],
        funds: { marginUtilized: 486350 },
      },
    },
    { upsert: true },
  )
  const body = (await (await fetch(`${base}/v1/desk/broker/funds`, { headers: auth })).json()) as Record<string, unknown>
  assert.equal(body['available'], true)
  assert.equal(body['utilised'], 486350)
  assert.equal(body['availableMargin'], null)
  assert.equal(body['utilisation'], null)
  await handle!.db.collection('desk-broker-snapshot').deleteMany({})
})

itHttp('an unknown route is a 404 with a message', async () => {
  const res = await fetch(`${base}/v1/desk/nope`, { headers: auth })
  assert.equal(res.status, 404)
})

/**
 * `runtime` is attached to HOSTED rows only (API contract §6).
 *
 * The external Python desk is not ours to supervise, so we cannot observe its
 * state — and reporting `stopped` for a desk that is running fine would be
 * worse than reporting nothing, because it invites someone to "restart" a
 * process we do not control. An absent `runtime` is the honest answer, and the
 * dashboard renders it as "not supervised".
 */
itHttp('the strategy listing joins runner state onto hosted rows, and only those', async () => {
  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
  const both = { paper: { enabled: true } }
  await store.registerStrategy({ tag: 'HOSTED_ONE', kind: 'hosted', modes: both }, Date.now())
  await store.registerStrategy({ tag: 'EXTERNAL_ONE', kind: 'external', modes: both }, Date.now())
  // Both tags have a runtime document; only the hosted one may surface it.
  await handle!.db.collection('desk-strategy-runtime').insertMany([
    { tag: 'HOSTED_ONE', mode: 'paper', state: 'running', startedAt: 111, lastError: '', openPositions: 2, updatedAt: 9 },
    { tag: 'EXTERNAL_ONE', mode: 'paper', state: 'running', startedAt: 222, lastError: '', openPositions: 5, updatedAt: 9 },
  ])

  const res = await fetch(`${base}/v1/desk/strategies`, { headers: auth })
  assert.equal(res.status, 200)
  const rows = ((await res.json()) as Record<string, unknown>)['strategies'] as Record<string, unknown>[]

  const hosted = rows.find((r) => r['tag'] === 'HOSTED_ONE')
  assert.deepEqual(hosted?.['runtime'], {
    state: 'running', startedAt: 111, lastError: null, openPositions: 2, stale: true,
  },
    'the RAW updatedAt is still dropped — it changes every second and would make every poll ' +
    'look like a change — but its AGE is answered, because a document last written in 1970 ' +
    'says "running" about a runner that has not existed for years',
  )

  const external = rows.find((r) => r['tag'] === 'EXTERNAL_ONE')
  assert.equal(external?.['runtime'], undefined, 'we do not supervise Python processes')

  // A hosted row with no runtime document is ABSENT, never a fabricated state.
  await store.registerStrategy(
    { tag: 'HOSTED_QUIET', kind: 'hosted', modes: { paper: { enabled: true } } },
    Date.now(),
  )
  const again = await fetch(`${base}/v1/desk/strategies`, { headers: auth })
  const rows2 = ((await again.json()) as Record<string, unknown>)['strategies'] as Record<string, unknown>[]
  assert.equal(rows2.find((r) => r['tag'] === 'HOSTED_QUIET')?.['runtime'], undefined)

  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
})

/**
 * A RUNNER THAT IS STILL BREATHING READS AS CURRENT.
 *
 * The flag has to be able to say NO, or it is just a second word for `running`.
 * The runner rewrites each document about once a second, so anything inside the
 * 90s window (the same three-missed-polls tolerance the broker snapshot uses)
 * is a publisher that is demonstrably alive.
 */
itHttp('a runtime document the runner is still writing is NOT flagged stale', async () => {
  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
  await store.registerStrategy(
    { tag: 'HOSTED_FRESH', kind: 'hosted', modes: { paper: { enabled: true } } },
    Date.now(),
  )
  await handle!.db.collection('desk-strategy-runtime').insertOne({
    tag: 'HOSTED_FRESH', mode: 'paper', state: 'running', startedAt: 111, lastError: '',
    openPositions: 0, updatedAt: Date.now() - 5_000,
  })

  const res = await fetch(`${base}/v1/desk/strategies`, { headers: auth })
  const rows = ((await res.json()) as Record<string, unknown>)['strategies'] as Record<string, unknown>[]
  assert.deepEqual(rows.find((r) => r['tag'] === 'HOSTED_FRESH')?.['runtime'], {
    state: 'running', startedAt: 111, lastError: null, openPositions: 0, stale: false,
  })

  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
})

/**
 * A hosted strategy CAN now be switched live — the three audit defects that
 * blocked it are fixed — but only with the operator's password.
 *
 * The `bearerGate` this fixture uses is a MACHINE principal, and a machine can
 * never satisfy re-auth. So this asserts the thing that actually matters: an
 * automated client cannot turn live trading on by itself, no matter what it
 * sends in the body.
 */
itHttp('a hosted strategy can go live, but never without the operator password', async () => {
  await store.registerStrategy(
    { tag: 'HOSTED_LIVE', kind: 'hosted', modes: { paper: { enabled: false }, live: { enabled: false } } },
    Date.now(),
  )
  const patch = (body: unknown): Promise<Response> =>
    fetch(`${base}/v1/desk/strategies/HOSTED_LIVE`, {
      method: 'PATCH', headers: auth, body: JSON.stringify(body),
    })

  const res = await patch({ modes: { live: { enabled: true } } })
  assert.equal(res.status, 403, 'a machine token must not be able to enable live trading')
  assert.equal(((await res.json()) as Record<string, unknown>)['reauthRequired'], true)
  assert.equal(
    isOn((await store.loadStrategy('HOSTED_LIVE'))?.modes ?? {}, 'live'),
    false,
    'nothing was written',
  )

  // Paper needs no password: it cannot move money.
  assert.equal((await patch({ modes: { paper: { enabled: true } } })).status, 200)
  assert.equal(isOn((await store.loadStrategy('HOSTED_LIVE'))?.modes ?? {}, 'paper'), true)

  // And turning live off never needs one either — a password in front of a
  // stop is the same mistake as putting one in front of the kill switch.
  assert.equal((await patch({ modes: { live: { enabled: false } } })).status, 200)
})

/**
 * THE DAY GUARD'S LINES ARE GATED LIKE THE LIVE SWITCH — on a live row.
 *
 * Widening or clearing a stop-loss on a strategy that is trading real money is
 * not an edit to a setting, it is the removal of the control that stops it, and
 * unlike the switch it leaves nothing on the page to notice. The fixture is a
 * MACHINE principal, which can never satisfy re-auth, so this pins the thing
 * that matters: an automated client cannot disarm a live strategy's guard.
 */
itHttp('editing the day guard on a LIVE row needs the operator password', async () => {
  await store.registerStrategy(
    {
      tag: 'GUARD_LIVE',
      kind: 'external',
      modes: { paper: { enabled: true }, live: { enabled: true } },
      dailyLimits: { stop: 3_000 },
    },
    Date.now(),
  )
  const patch = (body: unknown): Promise<Response> =>
    fetch(`${base}/v1/desk/strategies/GUARD_LIVE`, {
      method: 'PATCH', headers: auth, body: JSON.stringify(body),
    })

  const cleared = await patch({ dailyLimits: null })
  assert.equal(cleared.status, 403)
  assert.equal(((await cleared.json()) as Record<string, unknown>)['reauthRequired'], true)
  assert.deepEqual(
    (await store.loadStrategy('GUARD_LIVE'))?.dailyLimits,
    { stop: 3_000 },
    'the stop is still armed — nothing was written',
  )

  const widened = await patch({ dailyLimits: { stop: 500_000 } })
  assert.equal(widened.status, 403, 'widening is the same act as clearing')

  // And a PAPER-ONLY row is not gated: nothing there can move money, and a
  // password in front of an edit that cannot is how an operator learns to type
  // it without reading the dialog.
  await store.registerStrategy(
    { tag: 'GUARD_PAPER', kind: 'external', modes: { paper: { enabled: true } } },
    Date.now(),
  )
  const paper = await fetch(`${base}/v1/desk/strategies/GUARD_PAPER`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ dailyLimits: { target: 10_000, stop: 3_000 } }),
  })
  assert.equal(paper.status, 200)
  assert.deepEqual((await store.loadStrategy('GUARD_PAPER'))?.dailyLimits, {
    target: 10_000,
    stop: 3_000,
  })
})

itHttp('a forged disabledByGuard stamp is refused, not stored', async () => {
  // The stamp decides whether tomorrow's 08:45 re-arm switches a rail back on.
  // A client able to write it could undo an operator's deliberate stop.
  await store.registerStrategy(
    { tag: 'GUARD_FORGE', kind: 'external', modes: { paper: { enabled: false } } },
    Date.now(),
  )
  const res = await fetch(`${base}/v1/desk/strategies/GUARD_FORGE`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ disabledByGuard: { paper: { day: '2000-01-01', trigger: 'stop' } } }),
  })
  assert.equal(res.status, 400)
  assert.equal((await store.loadStrategy('GUARD_FORGE'))?.disabledByGuard, undefined)
})

itHttp("the strategies listing carries the limits AND today's guard record", async () => {
  // The fixture's clock, not the wall clock: the route keys the lookup on the
  // IST day `deps.now()` says it is, which is the whole point of the key.
  const today = new Date(Date.UTC(2026, 6, 27, 5, 0) + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)
  await store.registerStrategy(
    {
      tag: 'GUARD_FIRED',
      kind: 'external',
      modes: { paper: { enabled: false } },
      dailyLimits: { target: 10_000, stop: 3_000 },
    },
    Date.now(),
  )
  await handle!.db.collection('desk-daily-guard').insertOne({
    _id: `GUARD_FIRED|paper|${today}`,
    tag: 'GUARD_FIRED',
    mode: 'paper',
    day: today,
    firedAt: 1_700_000_000_000,
    trigger: 'stop',
    pnlAtTrigger: -3_150,
    incomplete: false,
    actions: [],
  })

  const body = (await (
    await fetch(`${base}/v1/desk/strategies?mode=paper`, { headers: auth })
  ).json()) as { strategies: Record<string, unknown>[] }
  const row = body.strategies.find((r) => r['tag'] === 'GUARD_FIRED')
  assert.deepEqual(row?.['dailyLimits'], { target: 10_000, stop: 3_000 })
  // Fired says WHY the switch beside it is off — otherwise it is
  // indistinguishable from an operator's own stop.
  assert.deepEqual(row?.['dayGuard'], {
    fired: true,
    trigger: 'stop',
    pnlAtTrigger: -3_150,
    firedAt: 1_700_000_000_000,
    incomplete: false,
  })

  await handle!.db.collection('desk-daily-guard').deleteMany({})
})

itHttp('a PATCH cannot ADD a mode — it says so rather than returning a silent 200', async () => {
  // A toggle that created membership would make "add to live" reachable
  // without the add form's own runner-catalogue check.
  await store.registerStrategy(
    { tag: 'PAPER_ONLY', kind: 'external', modes: { paper: { enabled: true } } }, Date.now(),
  )
  const res = await fetch(`${base}/v1/desk/strategies/PAPER_ONLY`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ modes: { live: { enabled: true } } }),
  })
  assert.equal(res.status, 400)
  assert.match(String(((await res.json()) as Record<string, unknown>)['error']), /is not added to live/)
  assert.deepEqual((await store.loadStrategy('PAPER_ONLY'))?.modes, { paper: { enabled: true } })
})

/**
 * WHAT THIS TEST ACTUALLY PINS — and what it does not.
 *
 * It pins the RE-AUTH gate: the fixture authenticates as a MACHINE, so
 * `gate.reauth` refuses the live half before `patchStrategy` is ever reached,
 * concurrently with a permitted paper patch. That is worth having, and the
 * assertions below now name the mechanism (`reauthRequired`) rather than just a
 * status code, so a 403 arriving from somewhere else would fail.
 *
 * It does NOT pin the compare-and-set: delete `expectedUpdatedAt` from the
 * PATCH handler and this test still passes, because the live half never gets as
 * far as the write. `RACE_TWO` below is the one that pins it, with two writes
 * that are BOTH individually permitted — that is why the two tests exist.
 */
itHttp('a machine token cannot smuggle live in beside a permitted paper patch', async () => {
  await store.registerStrategy(
    {
      tag: 'RACE_ONE',
      kind: 'external',
      modes: { paper: { enabled: false }, live: { enabled: false } },
    },
    Date.now(),
  )
  const patch = (body: unknown): Promise<Response> =>
    fetch(`${base}/v1/desk/strategies/RACE_ONE`, {
      method: 'PATCH', headers: auth, body: JSON.stringify(body),
    })

  const [a, b] = await Promise.all([
    patch({ modes: { paper: { enabled: true } } }),
    patch({ modes: { live: { enabled: true } } }),
  ])
  const codes = [a.status, b.status].sort()
  // The live half is 403 on its own (machine principal, no password); the paper
  // half is 200 or 409 depending on which won. What must never happen is a live
  // row emerging from a pair of individually-permitted writes.
  assert.ok(codes.includes(403), 'the live half is refused on its own merits')
  // FROM THE RE-AUTH GATE specifically. A bare status check would be satisfied
  // by a 403 thrown for any other reason — including one that fired after the
  // write had already landed.
  const refused = a.status === 403 ? a : b
  assert.equal(
    ((await refused.json()) as Record<string, unknown>)['reauthRequired'],
    true,
    'the refusal must be the password gate, not an incidental 403',
  )

  const row = await store.loadStrategy('RACE_ONE')
  assert.equal(isOn(row?.modes ?? {}, 'live'), false, 'live must never arrive without a password')
})

/**
 * The version pin itself, isolated from re-auth: two writes that are BOTH
 * individually permitted must not silently merge. Mutation-tested by dropping
 * `expectedUpdatedAt` from the PATCH handler, at which point both return 200.
 */
itHttp('two concurrent permitted patches resolve to one 200 and one 409, never a merge', async () => {
  await store.registerStrategy(
    {
      tag: 'RACE_TWO',
      kind: 'external',
      modes: { paper: { enabled: false }, live: { enabled: false } },
    },
    Date.now(),
  )
  const patch = (body: unknown): Promise<Response> =>
    fetch(`${base}/v1/desk/strategies/RACE_TWO`, {
      method: 'PATCH', headers: auth, body: JSON.stringify(body),
    })
  const [a, b] = await Promise.all([patch({ modes: { paper: { enabled: true } } }), patch({ liveLots: 7 })])
  assert.deepEqual(
    [a.status, b.status].sort(),
    [200, 409],
    'the loser of the race must be told to reload, not merged in',
  )
})

// ------------------------------------------- per-mode listing, create, bulk

itHttp('the listing is filtered by mode, and ?all=1 is the management surface', async () => {
  await handle!.db.collection(COLLECTIONS.strategies).deleteMany({})
  const now = Date.now()
  await store.registerStrategy({ tag: 'P_ONLY', modes: { paper: { enabled: true } } }, now)
  await store.registerStrategy({ tag: 'L_ONLY', modes: { live: { enabled: true } } }, now)
  await store.registerStrategy({ tag: 'BOTH', modes: { paper: { enabled: true }, live: { enabled: true } } }, now)
  // Added to paper but SWITCHED OFF: it must still be listed, or the switch
  // that turns it back on would not be on the page.
  await store.registerStrategy({ tag: 'P_OFF', modes: { paper: { enabled: false } } }, now)
  // Added to nothing at all — the third state. Only the management page.
  await store.registerStrategy({ tag: 'NEITHER', modes: {} }, now)

  const tagsOf = async (query: string): Promise<string[]> => {
    const res = await fetch(`${base}/v1/desk/strategies${query}`, { headers: auth })
    assert.equal(res.status, 200)
    const rows = ((await res.json()) as Record<string, unknown>)['strategies'] as {
      tag: string
    }[]
    return rows.map((r) => r.tag).sort()
  }

  // FILTERED BY MEMBERSHIP, NOT BY THE SWITCH. `P_OFF` is added and off, and it
  // is on the page: filtering on `enabled` would take a strategy out of the
  // table the moment it was paused, and the only way back would be to delete
  // and re-add the row.
  assert.deepEqual(await tagsOf('?mode=paper'), ['BOTH', 'P_OFF', 'P_ONLY'])
  assert.deepEqual(await tagsOf('?mode=live'), ['BOTH', 'L_ONLY'])
  // A row added to both appears on BOTH pages. That is the point of the change,
  // not a duplicate to de-dupe.
  assert.deepEqual(await tagsOf('?all=1'), ['BOTH', 'L_ONLY', 'NEITHER', 'P_OFF', 'P_ONLY'])
  // Contract §0: an absent mode means paper.
  assert.deepEqual(await tagsOf(''), ['BOTH', 'P_OFF', 'P_ONLY'])
})

itHttp('an added row arrives SWITCHED OFF, whatever the body asks for', async () => {
  // Adding a strategy to a page and granting it permission to trade there are
  // separate acts; a form that did both would make a typo a live order.
  const res = await post('/v1/desk/strategies', {
    tag: 'PORTAL_ADDED',
    kind: 'external',
    mode: 'live',
    label: 'Added from the portal',
    liveLots: 3,
  })
  assert.equal(res.status, 201)
  const body = (await res.json()) as Record<string, unknown>
  assert.deepEqual(body['modes'], { live: { enabled: false } }, 'added to live, and OFF')
  assert.equal(body['liveLots'], 3, 'sizing is configuration, not a permission')
  assert.deepEqual((await store.loadStrategy('PORTAL_ADDED'))?.modes, { live: { enabled: false } })

  // A body that tries to arrive armed is refused outright rather than trimmed.
  const armed = await post('/v1/desk/strategies', {
    tag: 'PORTAL_ARMED', kind: 'external', mode: 'live', modes: { live: { enabled: true } },
  })
  assert.equal(armed.status, 400)
  assert.equal(await store.loadStrategy('PORTAL_ARMED'), null)

  // And the mode is never guessed: the page being added to is the whole point.
  const noMode = await post('/v1/desk/strategies', { tag: 'PORTAL_NO_MODE', kind: 'external' })
  assert.equal(noMode.status, 400)
  assert.match(String(((await noMode.json()) as Record<string, unknown>)['error']), /mode must be stated/)
})

itHttp('adding an EXISTING tag to a second mode keeps everything it already had', async () => {
  // "Add BN_BREAKOUT to live" must not reset the label, kind, live lots or
  // autostart it has been running on paper with.
  await store.registerStrategy(
    {
      tag: 'GROWN',
      kind: 'hosted',
      label: 'Its real label',
      modes: { paper: { enabled: true } },
      liveLots: 9,
      autostartAt: '0930',
    },
    Date.now(),
  )
  const res = await post('/v1/desk/strategies', {
    tag: 'GROWN', kind: 'external', mode: 'live', label: 'the form default', liveLots: 0,
  })
  assert.equal(res.status, 201)
  const row = await store.loadStrategy('GROWN')
  assert.deepEqual(row?.modes, { paper: { enabled: true }, live: { enabled: false } })
  assert.equal(row?.kind, 'hosted', 'the existing row is otherwise untouched')
  assert.equal(row?.label, 'Its real label')
  assert.equal(row?.liveLots, 9)
  assert.equal(row?.autostartAt, '0930')
})

itHttp('POST is a 409 when the tag is already added to that mode', async () => {
  await store.registerStrategy(
    { tag: 'TAKEN', kind: 'hosted', modes: { paper: { enabled: true }, live: { enabled: true } }, liveLots: 9 },
    Date.now(),
  )
  const res = await post('/v1/desk/strategies', { tag: 'TAKEN', kind: 'external', mode: 'live' })
  assert.equal(res.status, 409)
  const row = await store.loadStrategy('TAKEN')
  assert.equal(row?.kind, 'hosted', 'the existing row is untouched')
  assert.equal(row?.liveLots, 9)
  assert.deepEqual(row?.modes, { paper: { enabled: true }, live: { enabled: true } }, 'and its switches survive')
})

// ------------------------------------------------------ removing from a mode

itHttp('DELETE takes a strategy off one page and leaves the other alone', async () => {
  await store.registerStrategy(
    {
      tag: 'REMOVE_ME',
      kind: 'external',
      modes: { paper: { enabled: true }, live: { enabled: false } },
      liveLots: 4,
    },
    Date.now(),
  )
  const del = (): Promise<Response> =>
    fetch(`${base}/v1/desk/strategies/REMOVE_ME/modes/live`, { method: 'DELETE', headers: auth })

  assert.equal((await del()).status, 200)
  const row = await store.loadStrategy('REMOVE_ME')
  // The ROW survives with its other mode and its configuration: "remove from
  // live" is not "delete this strategy".
  assert.deepEqual(row?.modes, { paper: { enabled: true } })
  assert.equal(row?.liveLots, 4)
  assert.equal(isAdded(row?.modes ?? {}, 'live'), false)

  // Removing something that is not there is a 404, never a silent success.
  assert.equal((await del()).status, 404)
})

itHttp("DELETE of an external row's LAST mode leaves the row (modes {}) while its book is still registered", async () => {
  /**
   * THE SUPERVISOR READS A MISSING ROW AS UNKNOWN, AND UNKNOWN IS NOT OFF.
   *
   * Every registered book's strategy row is `kind: 'external'`
   * (`routes/books.ts`), and this route does not ask a registered book whether
   * it is running — `open` is 0 for an external row. So an operator taking a
   * live recenter book's only mode off the Strategies page, with the book
   * still `desired: 'running'`, is a real path. The supervisor's registry poll
   * reads that row's switch through `isOn` (`apps/supervisor/src/registry-
   * poll.ts`): a row with `modes: {}` reads OFF and a flat book stands down
   * quietly; NO row reads UNKNOWN, and unknown deliberately keeps deciding
   * (a blip on one collection must not stand every book down) — so the host
   * posts, desk-api answers `UnknownStrategy` 403, and the book rolls back
   * and re-posts every cooldown with an ERROR a minute. The row also vanishes
   * from the `?all=1` picker, so the gate's own remedy ("add it on the live
   * strategies page") no longer offers it.
   *
   * Deleting an orphaned external row is the book ERASE route's job
   * (`routes/books.ts`), where the registry row is known to be gone. Here the
   * row stays, emptied, exactly as it always did.
   */
  await store.registerStrategy(
    { tag: 'LIVE_BOOK', kind: 'external', modes: { live: { enabled: true } } },
    Date.now(),
  )
  await store.upsertBook({
    ...DEFAULT_BOOK,
    tag: 'LIVE_BOOK',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'live',
    variant: 'recenter-r',
    series: `${SYMBOL}-recenter-r`,
    desired: 'running',
    createdAt: NOW,
    updatedAt: NOW,
  })
  const res = await fetch(`${base}/v1/desk/strategies/LIVE_BOOK/modes/live`, { method: 'DELETE', headers: auth })
  assert.equal(res.status, 200)

  const row = await store.loadStrategy('LIVE_BOOK')
  assert.ok(row !== null, 'the row was DELETED — the supervisor now reads this running book as UNKNOWN')
  assert.deepEqual(row.modes, {}, 'the mode is gone, the row is not')
  assert.equal(isOn(row.modes, 'live'), false, 'and the poll reads it as OFF, not unknown')
  assert.equal((await store.getBook('LIVE_BOOK', 'live'))?.desired, 'running', 'the book itself is untouched')
})

itHttp('DELETE is REFUSED while the runner still reports an open position', async () => {
  // A row that vanishes off the page while holding risk is the trapped-position
  // failure again, and worse: the operator cannot even see the row to switch it
  // back on. The refusal names close-all rather than flattening for them.
  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
  await store.registerStrategy(
    { tag: 'BN_BREAKOUT', kind: 'hosted', modes: { live: { enabled: true } } }, Date.now(),
  )
  await handle!.db.collection('desk-strategy-runtime').insertOne({
    tag: 'BN_BREAKOUT', mode: 'live', state: 'running', startedAt: 1, lastError: '',
    openPositions: 2, updatedAt: 1,
  })
  const del = (): Promise<Response> =>
    fetch(`${base}/v1/desk/strategies/BN_BREAKOUT/modes/live`, { method: 'DELETE', headers: auth })

  const res = await del()
  assert.equal(res.status, 409)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['openPositions'], 2)
  assert.match(String(body['error']), /close-all/)
  assert.equal(isAdded((await store.loadStrategy('BN_BREAKOUT'))?.modes ?? {}, 'live'), true)

  // The PAPER instance's position is a different ledger and must not block a
  // live removal (nor the other way round).
  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
  await handle!.db.collection('desk-strategy-runtime').insertOne({
    tag: 'BN_BREAKOUT', mode: 'paper', state: 'running', startedAt: 1, lastError: '',
    openPositions: 3, updatedAt: 1,
  })
  assert.equal((await del()).status, 200, "the paper instance's position is not the live one's")
  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
})

itHttp('a HOSTED tag the runner has no implementation for is a 400', async () => {
  // A hosted row nothing matches is a switch that LOOKS ARMED and runs nothing:
  // the runner reports `stopped`, the operator reads "not started yet", and the
  // strategy they believe is trading has never existed.
  const res = await post('/v1/desk/strategies', {
    tag: 'NO_SUCH_STRATEGY', kind: 'hosted', mode: 'paper',
  })
  assert.equal(res.status, 400)
  assert.match(String(((await res.json()) as Record<string, unknown>)['error']), /no hosted implementation/)
  assert.equal(await store.loadStrategy('NO_SUCH_STRATEGY'), null)

  // The same tag as `external` is fine — an external row names a Python process
  // we deliberately do not know about.
  const external = await post('/v1/desk/strategies', {
    tag: 'NO_SUCH_STRATEGY', kind: 'external', mode: 'paper',
  })
  assert.equal(external.status, 201)
})

itHttp('/available lists catalogue tags not yet added TO THAT MODE', async () => {
  await handle!.db.collection(COLLECTIONS.strategies).deleteMany({})
  const list = async (mode: string): Promise<{ tag: string; registered: boolean }[]> => {
    const res = await fetch(`${base}/v1/desk/strategies/available?mode=${mode}`, { headers: auth })
    assert.equal(res.status, 200)
    return ((await res.json()) as Record<string, unknown>)['available'] as {
      tag: string
      registered: boolean
    }[]
  }
  const before = await list('paper')
  assert.ok(before.some((r) => r.tag === 'BULL_S_1'), 'a catalogue tag with no row is offered')
  assert.equal(
    before.some((r) => r.tag === 'NOT_A_REAL_STRATEGY'),
    false,
    'and only tags some runner path can actually run',
  )
  // Everything offered must actually be addable, or the form offers a 400.
  const added = await post('/v1/desk/strategies', {
    tag: 'BULL_S_1', kind: 'hosted', mode: 'paper',
  })
  assert.equal(added.status, 201)
  assert.equal(
    (await list('paper')).some((r) => r.tag === 'BULL_S_1'),
    false,
    'a tag already added to paper is not offered on the paper form again',
  )

  // ...but it IS still offered for LIVE, flagged as already registered. A
  // strategy running on paper is exactly the one an operator wants to add to
  // live, and excluding it because a row exists would make that impossible.
  const live = (await list('live')).find((r) => r.tag === 'BULL_S_1')
  assert.equal(live?.registered, true)
})

itHttp('the bulk switch turns a mode on and off, one mode at a time', async () => {
  await handle!.db.collection(COLLECTIONS.strategies).deleteMany({})
  const now = Date.now()
  await store.registerStrategy({ tag: 'B_ONE', modes: { paper: { enabled: false } } }, now)
  await store.registerStrategy({ tag: 'B_TWO', modes: { paper: { enabled: true } } }, now)

  const on = await post('/v1/desk/strategies/bulk', { mode: 'paper', on: true })
  assert.equal(on.status, 200)
  const body = (await on.json()) as Record<string, unknown>
  assert.deepEqual(body['changed'], ['B_ONE'])
  assert.deepEqual(body['unchanged'], ['B_TWO'], 'a row already on is reported, not silently counted')
  assert.deepEqual(body['skipped'], [])
  // ONE MODE PER CALL: live membership is untouched. A single click that armed
  // fifteen strategies on both rails is the one action where the mode is the
  // easiest thing to lose track of.
  for (const tag of ['B_ONE', 'B_TWO']) {
    assert.deepEqual((await store.loadStrategy(tag))?.modes, { paper: { enabled: true } }, tag)
  }

  const off = await post('/v1/desk/strategies/bulk', { mode: 'paper', on: false })
  assert.equal(off.status, 200)
  assert.deepEqual(((await off.json()) as Record<string, unknown>)['changed'], ['B_ONE', 'B_TWO'])
  assert.deepEqual((await store.loadStrategy('B_ONE'))?.modes, { paper: { enabled: false } })
})

itHttp('bulk ON in LIVE needs the password; bulk OFF never does', async () => {
  await handle!.db.collection(COLLECTIONS.strategies).deleteMany({})
  await store.registerStrategy({ tag: 'B_ONE', modes: { paper: { enabled: false } } }, Date.now())

  const armed = await post('/v1/desk/strategies/bulk', { mode: 'live', on: true })
  assert.equal(armed.status, 403, 'one click must not arm live trading on every row')
  assert.equal(((await armed.json()) as Record<string, unknown>)['reauthRequired'], true)
  assert.equal(isOn((await store.loadStrategy('B_ONE'))?.modes ?? {}, 'live'), false, 'nothing was written')

  // Paper-on and live-off are both unauthenticated beyond the session itself.
  assert.equal((await post('/v1/desk/strategies/bulk', { mode: 'paper', on: true })).status, 200)
  assert.equal((await post('/v1/desk/strategies/bulk', { mode: 'live', on: false })).status, 200)
})

itHttp('bulk-on SKIPS a hosted row with no implementation, and says why', async () => {
  // A bulk action that says "3 changed" while one silently did nothing is how
  // an operator ends up believing a strategy is running when it is not.
  await handle!.db.collection(COLLECTIONS.strategies).deleteMany({})
  const now = Date.now()
  // A tag no host implements.
  await store.registerStrategy(
    { tag: 'GHOST_STRATEGY', kind: 'hosted', modes: { paper: { enabled: false } } }, now,
  )
  await store.registerStrategy(
    { tag: 'BULL_S_1', kind: 'hosted', modes: { paper: { enabled: false } } }, now,
  )

  const res = await post('/v1/desk/strategies/bulk', { mode: 'paper', on: true })
  const body = (await res.json()) as Record<string, unknown>
  assert.deepEqual(body['changed'], ['BULL_S_1'])
  assert.deepEqual(body['skipped'], [
    {
      tag: 'GHOST_STRATEGY',
      reason: 'no hosted implementation is registered for this tag — nothing would run',
    },
  ])
  assert.equal(isOn((await store.loadStrategy('GHOST_STRATEGY'))?.modes ?? {}, 'paper'), false)

  // Switching OFF is never skipped: an unimplemented row that is somehow on
  // must still be stoppable.
  await store.patchStrategy('GHOST_STRATEGY', { modes: { paper: { enabled: true } } }, Date.now())
  const off = await post('/v1/desk/strategies/bulk', { mode: 'paper', on: false })
  assert.deepEqual(((await off.json()) as Record<string, unknown>)['skipped'], [])
  assert.equal(isOn((await store.loadStrategy('GHOST_STRATEGY'))?.modes ?? {}, 'paper'), false)
})

itHttp('bulk-off WARNS about rows switched off while still holding a position', async () => {
  /**
   * Switching a strategy off blocks its EXITS as well as its entries. So a
   * bulk-off over open positions STRANDS them — nothing will close them but
   * `close-all`, which runs as the operator. The endpoint reports that and
   * flattens nothing: mass-liquidating on a switch flip would be far worse.
   */
  await handle!.db.collection(COLLECTIONS.strategies).deleteMany({})
  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
  const now = Date.now()
  await store.registerStrategy(
    { tag: 'BN_BREAKOUT', kind: 'hosted', modes: { paper: { enabled: true } } }, now,
  )
  await store.registerStrategy(
    { tag: 'ORB_FUT_BN', kind: 'hosted', modes: { paper: { enabled: true } } }, now,
  )
  await handle!.db.collection('desk-strategy-runtime').insertMany([
    { tag: 'BN_BREAKOUT', mode: 'paper', state: 'running', startedAt: 1, lastError: '', openPositions: 2, updatedAt: 1 },
    { tag: 'ORB_FUT_BN', mode: 'paper', state: 'running', startedAt: 1, lastError: '', openPositions: 0, updatedAt: 1 },
  ])

  const res = await post('/v1/desk/strategies/bulk', { mode: 'paper', on: false })
  const body = (await res.json()) as Record<string, unknown>
  assert.deepEqual(body['strandedPositions'], [{ tag: 'BN_BREAKOUT', openPositions: 2 }])
  assert.match(String(body['warning']), /blocks their EXITS too/)
  assert.match(String(body['warning']), /close-all/)

  // Nothing was flattened — the operator chooses that, deliberately.
  assert.equal(
    (await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()).length,
    0,
  )
  await handle!.db.collection('desk-strategy-runtime').deleteMany({})
})

itHttp('a bulk switch must state its mode explicitly', async () => {
  const res = await post('/v1/desk/strategies/bulk', { on: true })
  assert.equal(res.status, 400)
  assert.match(String(((await res.json()) as Record<string, unknown>)['error']), /mode must be stated/)
})

// ----------------------------------------- F-30: the seed is an erasure too

/**
 * A gate that authenticates a PERSON, so the password path can be driven at
 * all. `bearerGate` only ever produces a MACHINE principal, and `reauth`
 * refuses every one of those — which is the point of F-30 and is pinned above.
 */
const seedPassword = 'the-operator-typed-this-again'
const operatorGate = {
  authenticate: async () => ({ kind: 'user' as const, name: 'aaditya' }),
  reauth: async (principal: { kind: string }, password: unknown) => {
    if (principal.kind === 'machine') return 'an automated client cannot re-authenticate'
    return password === seedPassword ? null : 'that password is not correct'
  },
}

/** Serve `deskRoutes` to an operator, on its own port, for one test. */
async function asOperator(fn: (at: string) => Promise<void>): Promise<void> {
  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle!.db), live: new LiveRail(handle!.db, []) },
    master: { current: master },
    marks: MARKS,
    clock: { now: () => NOW },
  })
  const deps: ApiDeps = {
    db: handle!.db,
    store,
    service,
    master: { current: master },
    log: () => {},
    now: () => NOW,
  }
  const srv = createBridgeServer({
    gate: operatorGate,
    routes: [deskRoutes({ ...deps, gate: operatorGate })],
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)
  } finally {
    await new Promise<void>((r) => srv.close(() => r()))
  }
}

const asOperatorPost = async (at: string, path: string, body: unknown): Promise<Response> =>
  await fetch(`${at}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

itHttp('a LIVE seed costs the password, even on a book that holds nothing', async () => {
  await asOperator(async (at) => {
    const seed = {
      tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'live',
      legs: [{ strike: 420, type: 'CE', qty: -13125, rate: 15 }],
    }
    const denied = await asOperatorPost(at, '/v1/desk/seed', seed)
    assert.equal(denied.status, 403)
    assert.equal(((await denied.json()) as Record<string, unknown>)['reauthRequired'], true)
    assert.equal((await store.loadBook(TAG, 'live')).length, 0, 'nothing was written')

    const allowed = await asOperatorPost(at, '/v1/desk/seed', { ...seed, password: seedPassword })
    assert.equal(allowed.status, 200)
    assert.equal((await store.loadBook(TAG, 'live')).length, 1)
  })
})

itHttp('a PAPER seed with no replace still needs no password — the create wizard is untouched', async () => {
  await asOperator(async (at) => {
    const res = await asOperatorPost(at, '/v1/desk/seed', {
      tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper',
      legs: [{ strike: 420, type: 'CE', qty: -13125, rate: 15 }],
    })
    assert.equal(res.status, 200)
  })
})

/**
 * REPLACE IS REFUSED WHILE THE FILLS SAY SOMETHING IS OPEN.
 *
 * The legs handed to a replace ARE the book afterwards, so replacing while a
 * real position is open rewrites the desk's only record of it — the same
 * argument the book DELETE makes, on a route that had no guard at all.
 */
itHttp('replace is refused while the fills-derived position is non-zero, password or not', async () => {
  await asOperator(async (at) => {
    const seed = {
      tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper',
      legs: [{ strike: 420, type: 'CE', qty: -13125, rate: 15 }],
      password: seedPassword,
    }
    assert.equal((await asOperatorPost(at, '/v1/desk/seed', seed)).status, 200)
    // A real open, journalled the way `/v1/desk/submit` journals one.
    await store.collection(COLLECTIONS.decisions).insertOne({
      decisionId: 'd-open-1',
      symbol: SYMBOL,
      expiry: EXPIRY,
      mode: 'paper',
      tag: TAG,
      fills: [{
        op: 'open', deskTag: 'CE420#0', tradingsymbol: 'BHEL26AUG420CE',
        side: 'Sell', qty: 13125, price: 15, ts: 1,
      }],
      skips: [],
      createdAt: Date.UTC(2026, 6, 27, 4, 0),
      status: 'DONE',
      source: 'submit',
    })

    const res = await asOperatorPost(at, '/v1/desk/seed', { ...seed, replace: true })
    assert.equal(res.status, 409)
    const body = (await res.json()) as Record<string, unknown>
    assert.match(String(body['error']), /BHEL26AUG420CE/)
    // The legs are untouched, so the position is still findable.
    assert.equal((await store.loadBook(TAG, 'paper')).length, 1)
  })
})

// -------------------------------------- F-34: aggression is a fraction, capped

itHttp('close-all refuses an aggression outside [0, 0.25] on the TAG path', async () => {
  const res = await post('/v1/desk/close-all', {
    tag: TAG, mode: 'paper', style: 'limit', decisionId: 'agg-1', aggressionPct: 5,
  })
  assert.equal(res.status, 400)
  const error = String(((await res.json()) as Record<string, unknown>)['error'])
  assert.match(error, /aggressionPct/)
  assert.match(error, /0\.25/)
})

itHttp('close-all refuses the same aggression on the SYMBOL path', async () => {
  const res = await post('/v1/desk/close-all', {
    symbol: SYMBOL, mode: 'paper', style: 'limit', decisionId: 'agg-2', aggressionPct: -0.5,
  })
  assert.equal(res.status, 400)
  assert.match(String(((await res.json()) as Record<string, unknown>)['error']), /aggressionPct/)
})

itHttp('close-all still accepts a sane aggression', async () => {
  await seedOneLeg()
  const res = await post('/v1/desk/close-all', {
    tag: TAG, mode: 'paper', style: 'limit', decisionId: 'agg-3', aggressionPct: 0.02,
  })
  assert.equal(res.status, 200)
})

/**
 * CLEARING AN OPTIONAL FIELD HAS TO REACH THE DOCUMENT.
 *
 * `$set` writes only the keys it is given, so a patch that drops `dailyLimits`
 * used to leave the old value in Mongo and the next read resurrected it. For
 * this field that is the difference between "the operator disarmed the stop"
 * and a stop that quietly stays armed — and for `disabledByGuard`, between a
 * rail that re-arms tomorrow and one that re-arms every morning forever.
 */
itHttp('disarming the day guard actually removes it from the document', async () => {
  await store.registerStrategy(
    {
      tag: 'GUARD_CLEAR',
      kind: 'external',
      modes: { paper: { enabled: true } },
      dailyLimits: { target: 10_000, stop: 3_000 },
      disabledByGuard: { paper: { day: '2026-07-26', trigger: 'stop' } },
    },
    Date.now(),
  )
  const res = await fetch(`${base}/v1/desk/strategies/GUARD_CLEAR`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ dailyLimits: null }),
  })
  assert.equal(res.status, 200)

  assert.equal((await store.loadStrategy('GUARD_CLEAR'))?.dailyLimits, undefined)
  const doc = await handle!.db.collection('desk-strategies').findOne({ tag: 'GUARD_CLEAR' })
  assert.equal('dailyLimits' in (doc ?? {}), false, 'the key is GONE, not left at its old value')

  // And the stamp goes when the rail is switched back on by hand.
  await fetch(`${base}/v1/desk/strategies/GUARD_CLEAR`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ modes: { paper: { enabled: true } } }),
  })
  const after = await handle!.db.collection('desk-strategies').findOne({ tag: 'GUARD_CLEAR' })
  assert.equal('disabledByGuard' in (after ?? {}), false)
})
