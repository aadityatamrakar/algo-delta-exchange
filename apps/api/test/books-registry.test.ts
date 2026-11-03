/**
 * The book registry (T5) and the variant catalogue (T6).
 *
 * Pure validation is tested with no Mongo at all. The store and route
 * behaviour — the compound `{tag, mode}` key, the create-also-registers-a-
 * strategy rule, and the wholesale variant replace — need a real MongoDB, so
 * those tests skip themselves when none is reachable (see `itMongo` below,
 * copied from `service.integration.test.ts`).
 *
 * OWN DATABASE NAME: `algomaker_dx_books_registry_test`, distinct from every
 * other Mongo test file, so this file can run concurrently with the others
 * without racing over shared collections.
 */

import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate, type AuthGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { booksRoutes } from '../src/routes/books.ts'
import {
  DEFAULT_BOOK,
  validateActualReport,
  validateBookCreate,
  bookFromDoc,
  engineSwitchChanges,
  validateBookDialsPatch,
  validateDialsAgainstCatalogue,
} from '../src/books-registry.ts'

// --------------------------------------------------------------- pure logic

test('a created book starts stopped', () => {
  assert.equal(DEFAULT_BOOK.desired, 'stopped')
  assert.equal(DEFAULT_BOOK.actual, 'stopped')
  assert.deepEqual(DEFAULT_BOOK.dials, {})
})

test('create requires tag, symbol, expiry, mode and variant', () => {
  const bad = validateBookCreate({ symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /tag/)
})

test('create rejects a mode that was not stated explicitly', () => {
  const bad = validateBookCreate({
    tag: 'BHEL-2026-08-25-hold-recycle-r',
    symbol: 'BHEL',
    expiry: '2026-08-25',
    variant: 'hold-recycle-r',
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /mode/)
})

test('a valid create carries its dials through', () => {
  const ok = validateBookCreate({
    tag: 'BHEL-2026-08-25-hold-recycle-r',
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    variant: 'hold-recycle-r',
    dials: { target_pnl: 250000, margin_cap: 100000000 },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok === true ? ok.value.dials['target_pnl'] : 0, 250000)
})

test('create rejects a tag with characters that would break the order-bus namespace', () => {
  const bad = validateBookCreate({
    tag: 'BHEL 2026/08/25',
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    variant: 'hold-recycle-r',
  })
  assert.equal(bad.ok, false)
})

test('create refuses a body that tries to set desired or actual directly', () => {
  const bad = validateBookCreate({
    tag: 'BHEL-2026-08-25-hold-recycle-r',
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    variant: 'hold-recycle-r',
    desired: 'running',
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /always created stopped/)
})

test('a non-finite dial is rejected by name', () => {
  const bad = validateBookCreate({
    tag: 'BHEL-2026-08-25-hold-recycle-r',
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    variant: 'hold-recycle-r',
    dials: { target_pnl: Number.NaN },
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /target_pnl/)
})

test('the dials patch requires at least one knob', () => {
  const bad = validateBookDialsPatch({ dials: {} })
  assert.equal(bad.ok, false)
})

test('the dials patch refuses to touch the lifecycle or the identity', () => {
  const bad = validateBookDialsPatch({ dials: { target_pnl: 1 }, desired: 'running' })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /desired/)
})

test('the dials patch accepts a plain numeric knob change', () => {
  const ok = validateBookDialsPatch({ dials: { target_pnl: 300000 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok === true ? ok.value.dials['target_pnl'] : 0, 300000)
})

/**
 * Decision: this PATCH can only ADD or OVERWRITE named dials, never REMOVE
 * one. `null` (the natural "delete this knob" spelling) is rejected the same
 * way any other non-finite value is — `validateDials` requires every dial to
 * be a finite number — so there is no way to ask this endpoint to delete a
 * dial at all, explicit or otherwise. Removing a knob (if ever needed) is
 * deliberately a different, more explicit operation than this merge patch.
 */
test('the dials patch cannot be used to remove a knob — null is rejected like any other non-number', () => {
  const bad = validateBookDialsPatch({ dials: { target_pnl: null } })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /target_pnl/)
})

/**
 * BOOLEANS ARE DIALS TOO. Numbers were the whole vocabulary while dials meant
 * `margin_cap` and `target_pnl`, and that quietly made half the playbook
 * knobs unreachable: `hedge_after_shift`, `no_buy`, `no_close`,
 * `gamma_shorts_only` and `delta_shorts_only` are all booleans, and a
 * number-only validator answered "must be a finite number" — which reads as a
 * mistake in the operator's JSON rather than a gap in the type.
 */
test('a boolean dial is accepted, both true and false', () => {
  const on = validateBookDialsPatch({ dials: { gamma_shorts_only: true } })
  assert.equal(on.ok, true)
  assert.equal(on.ok === true ? on.value.dials['gamma_shorts_only'] : null, true)

  // FALSE specifically: it is the value that turns a switch OFF, and any
  // truthiness-based check would drop it and leave the dial on.
  const off = validateBookDialsPatch({ dials: { hedge_after_shift: false } })
  assert.equal(off.ok, true)
  assert.equal(off.ok === true ? off.value.dials['hedge_after_shift'] : null, false)
})

test('numbers and booleans mix in one patch', () => {
  const ok = validateBookDialsPatch({
    dials: { shift_margin_frac: 0.02, delta_shorts_only: true, target_pnl: 55000 },
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok === true ? ok.value.dials : null, {
    shift_margin_frac: 0.02, delta_shorts_only: true, target_pnl: 55000,
  })
})

/**
 * Widening to booleans must not widen to everything. These are forwarded
 * verbatim to the Python supervisor, so the set stays small enough that both
 * sides agree on it without a schema.
 */
test('strings and nested objects are still refused', () => {
  for (const bad of [{ variant_name: 'recenter' }, { nested: { a: 1 } }, { list: [1, 2] }]) {
    const res = validateBookDialsPatch({ dials: bad })
    assert.equal(res.ok, false, JSON.stringify(bad))
    assert.match(res.ok === false ? res.error : '', /finite number or a boolean/)
  }
})

test('an actual report must name a real state', () => {
  const bad = validateActualReport({ actual: 'paused' })
  assert.equal(bad.ok, false)
})

test('an actual report defaults lastMarkAt and lastDecision when absent', () => {
  const ok = validateActualReport({ actual: 'running' })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.value.lastMarkAt, 0)
    assert.equal(ok.value.lastDecision, '')
  }
})

// ------------------------------------------------------------ series (WS2)

const SERIES_BASE = {
  tag: 'NIFTY-delta-lean-aggressive-2026-10-01',
  symbol: 'NIFTY',
  expiry: '2026-10-06',
  mode: 'paper',
  variant: 'delta-lean-aggressive',
}

test('a create with no series is given symbol-variant, never anything read off the tag', () => {
  const ok = validateBookCreate(SERIES_BASE)
  assert.equal(ok.ok, true)
  assert.equal(ok.ok === true ? ok.value.series : '', 'NIFTY-delta-lean-aggressive')
  // A tag whose text says something else entirely: the series still comes
  // from the fields, because nothing parses a tag.
  const odd = validateBookCreate({ ...SERIES_BASE, tag: 'SOMETHING_ELSE' })
  assert.equal(odd.ok === true ? odd.value.series : '', 'NIFTY-delta-lean-aggressive')
})

test('a stated series is kept as stated', () => {
  const ok = validateBookCreate({ ...SERIES_BASE, series: 'NIFTY-dl-agg' })
  assert.equal(ok.ok === true ? ok.value.series : '', 'NIFTY-dl-agg')
})

test('a series must use the tag charset and be at most 64 characters', () => {
  for (const bad of ['', 'has space', 'semi;colon', 'a'.repeat(65), 42, true, {}]) {
    const res = validateBookCreate({ ...SERIES_BASE, series: bad })
    assert.equal(res.ok, false, `accepted ${JSON.stringify(bad)}`)
    assert.match(res.ok === false ? res.error : '', /series/)
  }
  assert.equal(validateBookCreate({ ...SERIES_BASE, series: 'a'.repeat(64) }).ok, true)
})

test('series is immutable — the dials patch refuses it', () => {
  const bad = validateBookDialsPatch({ dials: { target_pnl: 1 }, series: 'other' })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /series/)
})

test('a stored row reads its series back, and a row written before series existed derives it', () => {
  const stored = bookFromDoc({ ...SERIES_BASE, series: 'NIFTY-dl-agg' })
  assert.equal(stored?.series, 'NIFTY-dl-agg')
  const legacy = bookFromDoc({ ...SERIES_BASE })
  assert.equal(legacy?.series, 'NIFTY-delta-lean-aggressive')
  const junk = bookFromDoc({ ...SERIES_BASE, series: 7 })
  assert.equal(junk?.series, 'NIFTY-delta-lean-aggressive')
})

test('engineSwitchChanges: only a change the ENGINE would see — resolved before and after, never raw', () => {
  // A recenter row that never stated either switch already runs both at the
  // engine's defaults (false, 0): restating them is no change.
  const recenter = { target_pnl: 250000 }
  assert.deepEqual(engineSwitchChanges(recenter, { delta_lean_enabled: false, pb_playbook: 0 }), [])
  assert.deepEqual(engineSwitchChanges(recenter, { target_pnl: 1 }), [], 'not a switch at all')
  assert.deepEqual(engineSwitchChanges(recenter, { delta_lean_enabled: true }), [
    { key: 'delta_lean_enabled', before: false, after: true },
  ])
  const playbook = { delta_lean_enabled: true, pb_playbook: 2 }
  assert.deepEqual(engineSwitchChanges(playbook, { pb_playbook: 2, delta_lean_enabled: true }), [])
  assert.deepEqual(engineSwitchChanges(playbook, { pb_playbook: 5, dl_open_lots: 0 }), [
    { key: 'pb_playbook', before: 2, after: 5 },
  ])
  assert.deepEqual(
    engineSwitchChanges(playbook, { delta_lean_enabled: false, pb_playbook: 0 }).map((c) => c.key),
    ['delta_lean_enabled', 'pb_playbook'],
  )
  // The forward a book is priced on is the third (spec F1): a row registered
  // before the dial existed resolves it off, so turning it on is a change.
  assert.deepEqual(engineSwitchChanges(playbook, { dl_parity_forward: true }), [
    { key: 'dl_parity_forward', before: false, after: true },
  ])
  const parity = { delta_lean_enabled: true, dl_parity_forward: true }
  assert.deepEqual(engineSwitchChanges(parity, { dl_parity_forward: true }), [], 'restating it is no change')
  assert.deepEqual(engineSwitchChanges(parity, { dl_parity_forward: false }).map((c) => c.key), ['dl_parity_forward'])
  // The fourth: BULL-S (Delta spec §6.3). Off by default, so turning it on is a
  // change, and restating it on a BULL-S row is not.
  assert.deepEqual(engineSwitchChanges(recenter, { bs_enabled: true, bs_strike_step: 200 }), [
    { key: 'bs_enabled', before: false, after: true },
  ])
  const bullS = { bs_enabled: true, bs_strike_step: 200 }
  assert.deepEqual(engineSwitchChanges(bullS, { bs_enabled: true, bs_lots_cap: 30 }), [])
  assert.deepEqual(engineSwitchChanges(bullS, { bs_enabled: false }).map((c) => c.key), ['bs_enabled'])
})

// -------------------------------------------------------------- over Mongo

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_books_registry_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
let NOW = Date.UTC(2026, 6, 28, 5, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false

/**
 * The SUPERVISOR's nudge endpoint, as a real loopback server (`./nudge-sink.ts`).
 *
 * A real one rather than a stubbed `fetch`, because the route passes no
 * `fetch` override — the point of these assertions is that the call site
 * reaches the port the supervisor actually listens on, which a stub would
 * assume rather than test. `notifySupervisor` resolves the port from
 * `DESK_SUPERVISOR_PORT` per call, so pointing the env at this server is
 * enough.
 */
let sink: NudgeSink | null = null
let nudges: Record<string, unknown>[] = []

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function patch(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function del(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** One held leg, for the "still holds a position" refusal. */
const LEG = {
  deskTag: 'CE430#seed',
  instrument: {
    tradingsymbol: 'BHEL26AUG430CE',
    instrumentToken: 19674882,
    lotSize: 2625,
    tickSize: 0.05,
    exchange: 'NFO' as const,
  },
  underlying: 'BHEL',
  expiry: '2026-08-25',
  strike: 430,
  type: 'CE' as const,
  side: 'Buy' as const,
  qty: 2625,
  entryPrice: 8,
  openedTs: 0,
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  // The gate goes in because `booksRoutes` now re-authenticates a LIVE dials
  // patch (F-29). This fixture's is `bearerGate`, so its principal is a
  // MACHINE — which can never satisfy re-auth, and that is what the live-dials
  // refusal below pins. The operator's side is exercised by `asOperator`.
  const apiDeps = {
    db: handle.db,
    store,
    log: () => {},
    now: () => NOW,
    gate: bearerGate(TOKEN),
  } as unknown as Parameters<typeof booksRoutes>[0]
  server = createBridgeServer({ gate: bearerGate(TOKEN), routes: [booksRoutes(apiDeps)] })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

  sink = await startNudgeSink()
  nudges = sink.nudges
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) {
    await handle!.db.collection(c).deleteMany({})
  }
  await store.ensureIndexes()
  NOW = Date.UTC(2026, 6, 28, 5, 0)
  nudges.length = 0
})

const CREATE_BODY = {
  tag: 'BHEL-2026-08-25-hold-recycle-r',
  symbol: 'BHEL',
  expiry: '2026-08-25',
  mode: 'paper',
  variant: 'hold-recycle-r',
  dials: { target_pnl: 250000, margin_cap: 100000000 },
}

itMongo('a created book is returned stopped, on both desired and actual', async () => {
  const res = await post('/v1/desk/books/registry', CREATE_BODY)
  assert.equal(res.status, 201)
  assert.equal(res.body['desired'], 'stopped')
  assert.equal(res.body['actual'], 'stopped')
  assert.equal(res.body['variant'], 'hold-recycle-r')
})

itMongo(
  'creating a book ALSO registers a strategy row for the tag, added and ON for paper — a fresh book is never born switched off',
  async () => {
    /**
     * Was "added and OFF". A registry create is the operator asking for a
     * book; the switch exists to STOP one, and a fresh row has nothing to
     * stop. Born OFF, a fresh daily paper book (spec D1) decides all day and
     * fills nothing — the 09-16..09-18 storm, and the memory note "purged book
     * comes back switched off". Paper only: turning paper on "cannot move
     * money" (`routes/desk.ts`); live keeps its password (the test below).
     */
    await post('/v1/desk/books/registry', CREATE_BODY)
    const strategy = await store.loadStrategy(CREATE_BODY.tag)
    assert.ok(strategy, 'no strategy row was created alongside the book')
    assert.deepEqual(strategy?.modes, { paper: { enabled: true } })
  },
)

itMongo('a LIVE create leaves modes.live OFF — the password gate is not bypassed by a script', async () => {
  // `routes/desk.ts` gates turning `modes.live` ON behind the operator's
  // password. A registry create must not be a second door to it.
  const res = await post('/v1/desk/books/registry', { ...CREATE_BODY, mode: 'live' })
  assert.equal(res.status, 201)
  assert.deepEqual((await store.loadStrategy(CREATE_BODY.tag))?.modes, { live: { enabled: false } })
})

itMongo('a converge on an operator-OFF row leaves it OFF', async () => {
  // The switch is the operator's stop control. A re-run of the register
  // script against a book they switched off must not switch it back on: only
  // a NEW row is born on, an existing one is converged and left alone.
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.patchStrategy(CREATE_BODY.tag, { modes: { paper: { enabled: false } } }, NOW)
  const again = await post('/v1/desk/books/registry', CREATE_BODY)
  assert.equal(again.status, 200, 'a converge, not a create')
  assert.deepEqual((await store.loadStrategy(CREATE_BODY.tag))?.modes, { paper: { enabled: false } })
})

itMongo('creating the same tag+mode twice never overwrites the row, and never duplicates it', async () => {
  // The guarantee this test has always carried. The STATUS changed on
  // 2026-07-31 (see the re-register tests below); "not overwritten" did not.
  const first = await post('/v1/desk/books/registry', CREATE_BODY)
  assert.equal(first.status, 201)
  const second = await post('/v1/desk/books/registry', CREATE_BODY)
  assert.equal(second.status, 200, 'an identical re-register CONVERGES rather than failing')
  const rows = await get('/v1/desk/books/registry?mode=paper')
  assert.equal((rows.body['books'] as unknown[]).length, 1)
  assert.equal(second.body['createdAt'], first.body['createdAt'], 'the original row survived')
})

/**
 * DELETE, THEN BUILD THE BOOK AGAIN. Reported from prod on 2026-07-31.
 *
 * Removing a book from the Strategies page removes the STRATEGY row's mode and
 * leaves the registry row alone — they are separate records on purpose. So the
 * next Build run finds the registry row already there, and the 409 used to
 * return BEFORE `addStrategyMode`, which is the only thing that could have put
 * the strategy row back. The tag was then stuck: registered, with no switch.
 * The operator saw "registered" on step 2 and then
 *
 *   'BHEL-2026-08-25-recenter-r' is not added to paper, so there is no switch
 *   to flip — POST /v1/desk/strategies { tag, kind, mode: 'paper' } adds it first
 *
 * on step 3, with no way forward from the UI at all.
 *
 * This route's own docstring says the strategy row exists so the supervisor's
 * first decision does not 403 with `UnknownStrategy`. The 409 defeated exactly
 * that, so re-registering now converges the strategy row instead of refusing.
 */
itMongo('re-registering restores a strategy row that was removed from the Strategies page', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.removeStrategyMode(CREATE_BODY.tag, 'paper', NOW)
  assert.equal(
    (await store.loadStrategy(CREATE_BODY.tag))?.modes['paper'],
    undefined,
    'precondition: the mode really is gone',
  )

  const again = await post('/v1/desk/books/registry', CREATE_BODY)
  assert.equal(again.status, 200)
  assert.deepEqual(
    (await store.loadStrategy(CREATE_BODY.tag))?.modes,
    { paper: { enabled: false } },
    'the switch is back — and OFF, because registering is never a trading permission',
  )
})

itMongo('a re-register that CHANGES the book is still refused — that is a real conflict', async () => {
  // Converging is not the same as overwriting. A different variant against a
  // book that may already hold a position must not be applied silently.
  await post('/v1/desk/books/registry', CREATE_BODY)
  const res = await post('/v1/desk/books/registry', { ...CREATE_BODY, variant: 'recenter-r' })
  assert.equal(res.status, 409)
  assert.match(String(res.body['error']), /variant/)
  const rows = await get('/v1/desk/books/registry?mode=paper')
  assert.equal((rows.body['books'] as Record<string, unknown>[])[0]?.['variant'], 'hold-recycle-r')
})

itMongo('the same tag can be registered independently on the other mode', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  const live = await post('/v1/desk/books/registry', { ...CREATE_BODY, mode: 'live' })
  assert.equal(live.status, 201)
  const paperRows = await get('/v1/desk/books/registry?mode=paper')
  const liveRows = await get('/v1/desk/books/registry?mode=live')
  assert.equal((paperRows.body['books'] as unknown[]).length, 1)
  assert.equal((liveRows.body['books'] as unknown[]).length, 1)
})

// ------------------------------------------------------------------ delete

/**
 * DELETE, so a book can actually be cleared and rebuilt.
 *
 * Before this there was no way to remove a book at all: the Strategies page
 * removes the STRATEGY row's mode, the registry row and the stored position
 * survive it, and nothing anywhere deleted either. A book you were finished
 * with stayed on the Books page forever.
 */
itMongo('deleting a book removes the registry row, the position record and the switch', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [], NOW)

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 200)

  assert.equal(await store.getBook(CREATE_BODY.tag, 'paper'), null, 'registry row survived')
  assert.equal(await store.bookDoc(CREATE_BODY.tag, 'paper'), null, 'position record survived')
  assert.equal(
    (await store.loadStrategy(CREATE_BODY.tag))?.modes['paper'],
    undefined,
    'the switch survived — the tag would still look tradable',
  )
})

/**
 * AN ERASED BOOK LEAVES NO STRATEGY ROW BEHIND.
 *
 * Under the daily roll every delta-lean book is erased two sessions after it
 * is born, and every erase used to leave a `desk-strategies` row with
 * `modes: {}` and its `dailyLimits` — four new orphans a trading day, hidden
 * from the Strategies list but surfacing in its `?all=1` add picker. A row
 * that is added to nothing, was created by a registration (`kind:
 * 'external'`) and has no book is not a strategy any more; it goes with the
 * membership that was the only reason it existed.
 */
itMongo('erasing a paper-only book deletes its strategy row outright, not just the mode', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  assert.ok((await store.loadStrategy(CREATE_BODY.tag)) !== null, 'precondition: the row exists')

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 200)
  assert.equal(await store.loadStrategy(CREATE_BODY.tag), null, 'an orphan row with modes {} was left behind')
})

itMongo('erasing the paper book keeps a strategy row that is still added to live', async () => {
  // "Remove from paper" is not "delete this strategy" when the tag still
  // trades the other rail: the live membership, its lots and its switch are
  // the operator's, and a paper erase must not reach them.
  await post('/v1/desk/books/registry', CREATE_BODY)
  const added = await store.addStrategyMode(
    { tag: CREATE_BODY.tag, kind: 'external', label: CREATE_BODY.tag },
    'live',
    NOW,
  )
  assert.notEqual(added, 'exists')

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 200)
  const row = await store.loadStrategy(CREATE_BODY.tag)
  assert.ok(row !== null, 'the row went with the paper mode although live was still on it')
  assert.deepEqual(row.modes, { live: { enabled: false } })
})

itMongo('erasing the paper book keeps an emptied row while the tag still has a LIVE book registered', async () => {
  /**
   * The row is deleted only once NO registry row remains for the tag on
   * either rail. A live book whose mode was taken off the Strategies page
   * leaves the row with `modes: {}` (server.test.ts pins why: the supervisor
   * reads an emptied row as OFF and a missing row as UNKNOWN, and unknown
   * keeps deciding). A paper erase that then found the row added to nothing
   * must not turn that live book's quiet stand-down into a 403 storm.
   */
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.upsertBook({
    ...DEFAULT_BOOK,
    tag: CREATE_BODY.tag,
    symbol: CREATE_BODY.symbol,
    expiry: CREATE_BODY.expiry,
    mode: 'live',
    variant: CREATE_BODY.variant,
    series: `${CREATE_BODY.symbol}-${CREATE_BODY.variant}`,
    desired: 'running',
    createdAt: NOW,
    updatedAt: NOW,
  })

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 200)
  const row = await store.loadStrategy(CREATE_BODY.tag)
  assert.ok(row !== null, 'the row went although a live book is still registered under the tag')
  assert.deepEqual(row.modes, {})
})

itMongo('removing the last mode from a HOSTED row keeps the row — only external rows are erased with their membership', async () => {
  // A hosted row is the desk's record of a strategy the runner starts, with
  // its autostart and its live lots; taking it off both pages is a stop, not
  // a delete, and it is put back from the Strategies page, not by a
  // registration. `deleteOrphanStrategy`'s filter names `kind: 'external'`,
  // so an emptied hosted row never matches it either.
  await store.registerStrategy(
    { tag: 'HOSTED_ONE', kind: 'hosted', modes: { paper: { enabled: false } }, autostartAt: '0914' },
    NOW,
  )
  const removed = await store.removeStrategyMode('HOSTED_ONE', 'paper', NOW)
  assert.ok(removed !== null && removed !== 'absent')
  assert.equal(await store.deleteOrphanStrategy('HOSTED_ONE'), false, 'a hosted row is not an orphan')
  const row = await store.loadStrategy('HOSTED_ONE')
  assert.ok(row !== null, 'a hosted row was deleted by a mode removal')
  assert.deepEqual(row.modes, {})
  assert.equal(row.autostartAt, '0914')
})

/** One journalled fill, the shape `PnlStore.loadFills` reads. */
async function journalFill(side: 'Buy' | 'Sell', qty: number, at: number): Promise<void> {
  await store.collection(COLLECTIONS.decisions).insertOne({
    decisionId: `d-${side}-${qty}-${at}`,
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    tag: CREATE_BODY.tag,
    fills: [{
      op: side === 'Buy' ? 'open' : 'close',
      deskTag: `d-${side}-${at}#0`,
      tradingsymbol: 'BHEL26AUG430CE',
      side,
      qty,
      price: 8,
      ts: at,
    }],
    skips: [],
    createdAt: at,
    status: 'DONE',
    source: 'submit',
  })
}

itMongo('deleting a book that still holds a REAL position is refused, and names it', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
  await journalFill('Buy', 2625, NOW)

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 409)
  assert.match(String(res.body['error']), /BHEL26AUG430CE/)
  assert.match(String(res.body['error']), /close-all/)
  // The whole point: nothing was erased, so the position is still findable.
  assert.ok(await store.getBook(CREATE_BODY.tag, 'paper'))
  assert.equal((await store.loadBook(CREATE_BODY.tag, 'paper')).length, 1)
})

/**
 * THE STALE BOOK. The first version of this guard read `desk-books` and refused
 * while it listed any leg — the same record the delete erases — so a book that
 * had gone stale could never be deleted BECAUSE it was stale. BAJFINANCE and
 * BHEL both flattened cleanly on 2026-07-31 and were left permanently
 * undeletable, every leg netting to zero in the trade log while the book still
 * described the opens.
 */
itMongo('a book whose legs are STALE — the fills net to zero — deletes cleanly', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
  await journalFill('Buy', 2625, NOW)
  await journalFill('Sell', 2625, NOW + 1000)

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 200, 'the position is demonstrably closed — the legs are a stale record')
  assert.equal(await store.getBook(CREATE_BODY.tag, 'paper'), null)
})

itMongo('a position opened on an EARLIER day still blocks the delete', async () => {
  // The window is the book's whole life, not the trading day: a positional book
  // is held across sessions, and a short window would UNDERSTATE the position
  // and delete the record of a real one.
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
  await journalFill('Buy', 2625, NOW - 5 * 86_400_000)

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 409, 'an open from five days ago is still an open position')
})

itMongo('deleting a book the supervisor is still driving is refused', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/start`, { mode: 'paper' })

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 409)
  assert.match(String(res.body['error']), /stop it first/i)
  assert.ok(await store.getBook(CREATE_BODY.tag, 'paper'))
})

itMongo('deleting requires the mode, and 404s on a tag that has no book there', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  assert.equal((await del(`/v1/desk/books/registry/${CREATE_BODY.tag}`)).status, 400)
  assert.equal((await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=live`)).status, 404)
  // The paper book is untouched by either refusal.
  assert.ok(await store.getBook(CREATE_BODY.tag, 'paper'))
})

/**
 * PURGE — for rebuilding a structure the same day.
 *
 * Trades, decisions and P&L are keyed by TAG, not by book, so they survive a
 * delete and the next book on the same tag inherits them. Since the tag is
 * `symbol-expiry-variant`, rebuilding the same structure the same day
 * necessarily reuses it.
 */
itMongo('purge=1 erases the tag\'s history so a rebuild starts clean', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await journalFill('Buy', 2625, NOW)
  await journalFill('Sell', 2625, NOW + 1000)

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&purge=1`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body['purged'], { decisions: 2, orders: 0 })
  assert.equal(
    await store.collection(COLLECTIONS.decisions).countDocuments({ tag: CREATE_BODY.tag }),
    0,
  )
})

itMongo('a delete WITHOUT purge keeps the history — that is the default', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await journalFill('Buy', 2625, NOW)
  await journalFill('Sell', 2625, NOW + 1000)

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 200)
  assert.equal(res.body['purged'], undefined)
  assert.equal(
    await store.collection(COLLECTIONS.decisions).countDocuments({ tag: CREATE_BODY.tag }),
    2,
    'the orders really happened — a delete does not unmake them',
  )
})

itMongo('purge is REFUSED on the live rail, and erases nothing', async () => {
  // These rows are the desk's copy of orders that reached a real broker, whose
  // record cannot be deleted. Purging would leave the two permanently out of
  // step with no way to tell which is right.
  await post('/v1/desk/books/registry', { ...CREATE_BODY, mode: 'live' })
  await journalFill('Buy', 2625, NOW)
  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=live&purge=1`)
  assert.equal(res.status, 409)
  assert.match(String(res.body['error']), /broker/)
  assert.ok(await store.getBook(CREATE_BODY.tag, 'live'), 'the book survives the refusal too')
  assert.equal(
    await store.collection(COLLECTIONS.decisions).countDocuments({ tag: CREATE_BODY.tag }),
    1,
  )
})

itMongo('purge cannot run while the tag still holds a position', async () => {
  // The fills ARE the source of truth for what a tag holds. Erasing them while
  // something is open makes the position unknowable, not merely unrecorded —
  // the existing guard already stops this, and this pins that it covers purge.
  await post('/v1/desk/books/registry', CREATE_BODY)
  await journalFill('Buy', 2625, NOW)
  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&purge=1`)
  assert.equal(res.status, 409)
  assert.equal(
    await store.collection(COLLECTIONS.decisions).countDocuments({ tag: CREATE_BODY.tag }),
    1,
  )
})

itMongo('a deleted book can be registered again from scratch', async () => {
  // The reason this endpoint exists.
  await post('/v1/desk/books/registry', CREATE_BODY)
  await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  const again = await post('/v1/desk/books/registry', CREATE_BODY)
  assert.equal(again.status, 201, 'a fresh registration, not a converge')
  assert.deepEqual(
    (await store.loadStrategy(CREATE_BODY.tag))?.modes,
    { paper: { enabled: true } },
    'a deleted book registered again is ON — it is a fresh registration',
  )
})

itMongo('start requires mode to be stated explicitly', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  const res = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/start`, {})
  assert.equal(res.status, 400)
})

itMongo('start flips desired to running and leaves actual untouched', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  const res = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/start`, { mode: 'paper' })
  assert.equal(res.status, 200)
  assert.equal(res.body['desired'], 'running')
  assert.equal(res.body['actual'], 'stopped', 'only the supervisor writes actual')
})

itMongo('stop flips desired back to stopped', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/start`, { mode: 'paper' })
  const res = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/stop`, { mode: 'paper' })
  assert.equal(res.status, 200)
  assert.equal(res.body['desired'], 'stopped')
})

/**
 * THE `registry` NUDGE ACTUALLY FIRES (I-1).
 *
 * `NudgeKind` has had a `registry` member since the supervisor landed and
 * NOTHING SENT ONE — so a start or a stop sat in the row until the
 * supervisor's next convergence pass found it. The stop is the half that
 * matters: it is an operator taking a book off the desk, and a strategy that
 * keeps deciding for another convergence interval is exactly the window they
 * pressed the button to close.
 */
itMongo('STOP nudges the supervisor, naming the tag, mode and desired state', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/start`, { mode: 'paper' })
  nudges.length = 0

  const res = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/stop`, { mode: 'paper' })
  assert.equal(res.status, 200)

  assert.equal(nudges.length, 1, 'the stop announced itself')
  assert.equal(nudges[0]?.['kind'], 'registry')
  assert.equal(nudges[0]?.['tag'], CREATE_BODY.tag)
  assert.equal(nudges[0]?.['mode'], 'paper')
  // The state the supervisor should converge to, so it need not re-read to
  // learn which way the row moved.
  assert.equal(nudges[0]?.['desired'], 'stopped')
})

itMongo('START nudges too — the operator is watching for the book to come up', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  nudges.length = 0

  await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/start`, { mode: 'paper' })

  assert.equal(nudges.length, 1)
  assert.equal(nudges[0]?.['kind'], 'registry')
  assert.equal(nudges[0]?.['desired'], 'running')
})

itMongo('a start that 404s announces NOTHING — nothing changed', async () => {
  // The nudge belongs after the write, not beside the request. A supervisor
  // woken for a book that does not exist would converge nothing and log noise.
  const res = await post('/v1/desk/books/registry/NOBODY/start', { mode: 'paper' })
  assert.equal(res.status, 404)
  assert.deepEqual(nudges, [])
})

itMongo('start on an unregistered tag is a 404, not a phantom row', async () => {
  const res = await post('/v1/desk/books/registry/NOBODY/start', { mode: 'paper' })
  assert.equal(res.status, 404)
})

itMongo('the supervisor reports actual state independently of desired', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  const res = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/actual`, {
    mode: 'paper',
    actual: 'running',
    lastMarkAt: NOW,
    lastDecision: 'held: within target band',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body['actual'], 'running')
  assert.equal(res.body['desired'], 'stopped', 'the operator never asked it to run')
  assert.equal(res.body['lastDecision'], 'held: within target band')
})

itMongo('PATCH changes dials only, and merges over the existing ones', async () => {
  // CREATE_BODY seeds TWO dials (target_pnl, margin_cap). Patching only one
  // must leave the other exactly as it was — a replace instead of a merge
  // would silently delete it, and for margin_cap/target_pnl that is not a
  // cosmetic loss: it changes what the strategy does.
  await post('/v1/desk/books/registry', CREATE_BODY)
  const res = await patch(`/v1/desk/books/registry/${CREATE_BODY.tag}`, {
    mode: 'paper',
    dials: { target_pnl: 300000 },
  })
  assert.equal(res.status, 200)
  const dials = res.body['dials'] as Record<string, number>
  assert.equal(dials['target_pnl'], 300000, 'the patched knob changed')
  assert.equal(dials['margin_cap'], 100000000, 'the untouched knob must survive the patch')
})

itMongo('PATCH on an unregistered tag is a 404', async () => {
  const res = await patch('/v1/desk/books/registry/NOBODY', { mode: 'paper', dials: { x: 1 } })
  assert.equal(res.status, 404)
})

// ------------------------------------- F9: no engine switch under held legs

/**
 * SIX-PLAYBOOKS F9. `delta_lean_enabled` and `pb_playbook` are not tuning
 * knobs: they choose WHICH engine steers the book — recenter or delta-lean,
 * and which of the six playbooks. Flipped under open legs, the new engine
 * inherits a position it did not open and whose exits it does not know. So a
 * patch that CHANGES either (as the engine resolves them) is refused while
 * the book's `desk-books` document holds a leg with a nonzero qty. Every
 * other dial stays patchable on a holding book — retightening a running book
 * is what this PATCH is for.
 */
const PLAYBOOK_BODY = {
  tag: 'NIFTY-pb-trend-drive-2026-10-16',
  symbol: 'NIFTY',
  expiry: '2026-10-19',
  mode: 'paper',
  variant: 'pb-trend-drive',
  dials: { delta_lean_enabled: true, pb_playbook: 1, dl_open_lots: 0 },
}

/** A long call on the Trend Drive book's contract. */
const NIFTY_LEG = {
  ...LEG,
  deskTag: 'CE25000#pb',
  instrument: {
    tradingsymbol: 'NIFTY26O1925000CE',
    instrumentToken: 10245378,
    lotSize: 65,
    tickSize: 0.05,
    exchange: 'NFO' as const,
  },
  underlying: 'NIFTY',
  expiry: '2026-10-19',
  strike: 25000,
  qty: 130,
}

const holdingPlaybook = async (legs: readonly (typeof NIFTY_LEG)[]): Promise<void> => {
  await post('/v1/desk/books/registry', PLAYBOOK_BODY)
  await store.saveBook({ tag: PLAYBOOK_BODY.tag, symbol: 'NIFTY', expiry: '2026-10-19', mode: 'paper' }, legs, NOW)
}

itMongo('F9: changing delta_lean_enabled, pb_playbook or dl_parity_forward on a book that HOLDS legs is a 409 naming each — nothing is written, nobody is nudged', async () => {
  await holdingPlaybook([NIFTY_LEG])
  for (const dials of [
    { delta_lean_enabled: false },
    { pb_playbook: 2 },
    { pb_playbook: 0 },
    { delta_lean_enabled: false, pb_playbook: 0, dl_day_max_loss: 5_000 },
    // The forward the book is priced on (spec F1): every delta would move at once.
    { dl_parity_forward: true },
  ]) {
    nudges.length = 0
    const res = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials })
    assert.equal(res.status, 409, JSON.stringify(dials))
    const error = String(res.body['error'])
    assert.match(error, /holds 1 open leg/)
    assert.match(error, /NIFTY26O1925000CE/)
    assert.match(error, /flatten/i)
    for (const key of ['delta_lean_enabled', 'pb_playbook', 'dl_parity_forward'].filter((k) => k in dials)) {
      assert.match(error, new RegExp(key), `${key} is not named`)
    }
    assert.deepEqual(res.body['legs'], ['NIFTY26O1925000CE'])
    assert.equal(nudges.length, 0, 'a refused patch nudged the supervisor')
  }
  // Not a key was written — the day budget riding with the switch included.
  const row = await store.getBook(PLAYBOOK_BODY.tag, 'paper')
  assert.equal(row?.dials['delta_lean_enabled'], true)
  assert.equal(row?.dials['pb_playbook'], 1)
  assert.equal(row?.dials['dl_day_max_loss'], undefined)
  assert.equal(row?.dials['dl_parity_forward'], undefined)

  // Onto the delta-lean path, too: a recenter book holding its BHEL call.
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
  const onto = await patch(`/v1/desk/books/registry/${CREATE_BODY.tag}`, { mode: 'paper', dials: { delta_lean_enabled: true } })
  assert.equal(onto.status, 409)
  assert.match(String(onto.body['error']), /BHEL26AUG430CE/)
  assert.equal((await store.getBook(CREATE_BODY.tag, 'paper'))?.dials['delta_lean_enabled'], undefined)
})

itMongo('F9: a book flat on file with a decision still WORKING refuses a switch too — its stage-1 wings may yet fill', async () => {
  await post('/v1/desk/books/registry', PLAYBOOK_BODY)
  const states = handle!.db.collection('desk-supervisor-state')
  const key = `${PLAYBOOK_BODY.tag}:paper`
  try {
    for (const doc of [
      { key, inFlight: `${PLAYBOOK_BODY.tag}:paper:3`, workingPackage: null },
      { key, inFlight: null, workingPackage: { decisionId: `${PLAYBOOK_BODY.tag}:paper:4`, remaining: [] } },
    ]) {
      await states.deleteMany({ key })
      await states.insertOne(doc)
      nudges.length = 0
      const res = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials: { pb_playbook: 2 } })
      assert.equal(res.status, 409, JSON.stringify(res.body))
      assert.match(String(res.body['error']), /still has decision .*:paper:[34] working/)
      assert.equal(nudges.length, 0)
    }
    assert.equal((await store.getBook(PLAYBOOK_BODY.tag, 'paper'))?.dials['pb_playbook'], 1, 'nothing was written')
    // Every other dial still goes through, and the switch does once nothing works.
    const tune = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials: { pb_lots: 1 } })
    assert.equal(tune.status, 200, JSON.stringify(tune.body))
    await states.deleteMany({ key })
    await states.insertOne({ key, inFlight: null, workingPackage: null })
    const done = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials: { pb_playbook: 2 } })
    assert.equal(done.status, 200, JSON.stringify(done.body))
  } finally {
    await states.deleteMany({ key })
  }
})

itMongo('F9: a FLAT book changes either switch freely — no desk-books document, or every leg at zero', async () => {
  // Never traded: no document at all.
  await post('/v1/desk/books/registry', PLAYBOOK_BODY)
  const off = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials: { pb_playbook: 2 } })
  assert.equal(off.status, 200, JSON.stringify(off.body))
  assert.equal((off.body['dials'] as Record<string, unknown>)['pb_playbook'], 2)
  // Traded and closed out: the leg is on file at zero.
  await store.saveBook(
    { tag: PLAYBOOK_BODY.tag, symbol: 'NIFTY', expiry: '2026-10-19', mode: 'paper' },
    [{ ...NIFTY_LEG, qty: 0 }],
    NOW,
  )
  const back = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, {
    mode: 'paper',
    dials: { delta_lean_enabled: false, pb_playbook: 0 },
  })
  assert.equal(back.status, 200, JSON.stringify(back.body))
  const dials = back.body['dials'] as Record<string, unknown>
  assert.equal(dials['delta_lean_enabled'], false)
  assert.equal(dials['pb_playbook'], 0)
})

itMongo('F9: an UNCHANGED switch, or any other dial, passes on a holding book', async () => {
  await holdingPlaybook([NIFTY_LEG])
  // A save that restates the values the book already runs on is not a switch.
  for (const dials of [{ delta_lean_enabled: true }, { pb_playbook: 1 }, { delta_lean_enabled: true, pb_playbook: 1, pb_lots: 1 }]) {
    const res = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials })
    assert.equal(res.status, 200, `${JSON.stringify(dials)}: ${JSON.stringify(res.body)}`)
  }
  assert.equal((await store.getBook(PLAYBOOK_BODY.tag, 'paper'))?.dials['pb_lots'], 1, 'the tuning knob landed')

  // A recenter book whose dials never stated either switch resolves both to
  // the engine's defaults (false, 0); spelling those out — as the dials panel
  // does when a copied preset states them, since it diffs raw values — is no
  // change.
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
  for (const dials of [{ delta_lean_enabled: false }, { pb_playbook: 0 }, { target_pnl: 300000 }]) {
    const res = await patch(`/v1/desk/books/registry/${CREATE_BODY.tag}`, { mode: 'paper', dials })
    assert.equal(res.status, 200, `${JSON.stringify(dials)}: ${JSON.stringify(res.body)}`)
  }
})

itMongo('F9: a desk-books document whose legs cannot be read refuses the switch — unknown is never flat', async () => {
  await post('/v1/desk/books/registry', PLAYBOOK_BODY)
  await store
    .collection(COLLECTIONS.books)
    .insertOne({ tag: PLAYBOOK_BODY.tag, mode: 'paper', symbol: 'NIFTY', expiry: '2026-10-19', legs: [{ deskTag: 'CE25000#pb' }], updatedAt: NOW })
  const res = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials: { delta_lean_enabled: false } })
  assert.equal(res.status, 409)
  assert.match(String(res.body['error']), /cannot tell/i)
  assert.equal((await store.getBook(PLAYBOOK_BODY.tag, 'paper'))?.dials['delta_lean_enabled'], true)
  // ...while a tuning knob on the same book is still a plain save.
  const knob = await patch(`/v1/desk/books/registry/${PLAYBOOK_BODY.tag}`, { mode: 'paper', dials: { pb_lots: 1 } })
  assert.equal(knob.status, 200)
})

// ---------------------------------------------------------- variant catalogue

/**
 * READ-ONLY SINCE THE D9 CUTOVER. `POST /v1/desk/variants` was the Python
 * supervisor's sync point — it published its whole `list_variants()` output
 * wholesale on every start — and went with the process. The stored rows stay:
 * they are the only statement of what dials a book registered under a published
 * variant had, and `routes/payoff.ts` and the dials PATCH still read them.
 *
 * So what is pinned here is the READ, over rows inserted the way the retired
 * writer left them, plus the property that matters after the writer is gone:
 * the POST is a 404, not a silent 200 that writes nothing.
 */
itMongo('GET /v1/desk/variants serves the stored catalogue', async () => {
  await store.collection(COLLECTIONS.variants).insertMany([
    { key: 'hold-recycle-r', decider: 'rule-engine', playbook: 'hold-recycle', defaults: { target_pnl: 250000 } },
    { key: 'guard-r', decider: 'rule-engine', playbook: 'guard', defaults: {} },
  ])
  const res = await get('/v1/desk/variants')
  assert.equal(res.status, 200)
  const rows = res.body['variants'] as { key: string; defaults: Record<string, unknown> }[]
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.key).sort(), ['guard-r', 'hold-recycle-r'])
  assert.equal(rows.find((r) => r.key === 'hold-recycle-r')?.defaults['target_pnl'], 250000)
})

itMongo('the catalogue POST is GONE — a publisher that still calls it gets a 404, not a silent 200', async () => {
  const res = await post('/v1/desk/variants', {
    variants: [{ key: 'guard-r', decider: 'rule-engine', playbook: 'guard', defaults: {} }],
  })
  assert.equal(res.status, 404)
  assert.equal((await store.listVariants()).length, 0, 'and nothing was written')
})

/**
 * THE ROUND TRIP, WHICH IS WHERE THIS ACTUALLY BROKE.
 *
 * `validateDials` was widened to booleans and this reader was not, so a boolean
 * dial was accepted, written to Mongo, and then dropped on every read back:
 * `gamma_shorts_only: true` was visibly in the database, absent from every API
 * response, never reached the supervisor, and the running book ignored it —
 * while the desk's "dials applied" log reported an empty diff, because only the
 * numeric keys ever arrived and those already matched. Widening a writer
 * without its reader is worse than widening neither.
 */
test('a boolean dial survives the read back, not just the write', () => {
  const row = bookFromDoc({
    tag: 'TCS-2026-08-25-recenter-relief-r', symbol: 'TCS', expiry: '2026-08-25',
    mode: 'live', variant: 'recenter-relief-r',
    dials: { gamma_shorts_only: true, hedge_after_shift: false, shift_margin_frac: 0.02 },
  })
  assert.notEqual(row, null)
  assert.deepEqual(row?.dials, {
    gamma_shorts_only: true, hedge_after_shift: false, shift_margin_frac: 0.02,
  })
})

test('the read back still drops what was never a dial', () => {
  const row = bookFromDoc({
    tag: 'T', symbol: 'TCS', expiry: '2026-08-25', mode: 'live', variant: 'v',
    dials: { ok: 1, alsoOk: true, nope: 'string', nested: { a: 1 }, nan: Number.NaN },
  })
  assert.deepEqual(row?.dials, { ok: 1, alsoOk: true })
})

// ------------------------------------------------ F-29: the dials guardrails

/**
 * A DIAL THE SUPERVISOR WILL NEVER READ MUST NOT SAVE CLEANLY.
 *
 * The audit's F-29: `validateDials` accepted any finite-number/boolean key, so
 * `targetPnl` (the real knob is `target_pnl`) answered 200, sat in Mongo and was
 * silently ignored by the running book — the same "a control that lies about
 * having worked" failure the live-dials seam exists to end. A DOTTED key is
 * worse than ignored: `store.patchBookDials` writes `$set: {'dials.a.b': v}`,
 * which Mongo stores NESTED, and `bookFromDoc` then drops the whole subtree on
 * read — so it disappears between the write and the next GET.
 */
test('a dotted dial key is refused — Mongo would store it nested and the read would drop it', () => {
  const bad = validateBookDialsPatch({ dials: { 'shift.margin_frac': 0.02 } })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /shift\.margin_frac/)
})

test('a $-prefixed dial key is refused — it would reach Mongo as an update operator', () => {
  const bad = validateBookDialsPatch({ dials: { $set: 1 } })
  assert.equal(bad.ok, false)
})

const CATALOGUE_DEFAULTS = { target_pnl: 250000, shift_margin_frac: 0.6, gamma_shorts_only: false }

test('a dial the variant does not have is refused BY NAME, with the variant that was checked', () => {
  const bad = validateDialsAgainstCatalogue({
    dials: { targetPnl: 200 },
    current: { target_pnl: 250000 },
    variant: 'hold-recycle-r',
    defaults: CATALOGUE_DEFAULTS,
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /targetPnl/)
  assert.match(bad.ok === false ? bad.error : '', /hold-recycle-r/)
})

test('a dial the catalogue publishes is accepted even though the row never set it', () => {
  const good = validateDialsAgainstCatalogue({
    dials: { shift_margin_frac: 0.02 },
    current: {},
    variant: 'hold-recycle-r',
    defaults: CATALOGUE_DEFAULTS,
  })
  assert.equal(good.ok, true)
})

/**
 * A key already ON THE ROW stays editable whatever the catalogue says. The
 * catalogue is republished by a process we do not control; a deploy that
 * renamed a dial must not strand the value a live book is running on with no
 * way to change it.
 */
test('a dial already set on the book is editable even when the catalogue has never heard of it', () => {
  const good = validateDialsAgainstCatalogue({
    dials: { legacy_knob: 3 },
    current: { legacy_knob: 1 },
    variant: 'hold-recycle-r',
    defaults: CATALOGUE_DEFAULTS,
  })
  assert.equal(good.ok, true)
})

test('a boolean sent for a numeric dial is refused, and the other way round', () => {
  const asBool = validateDialsAgainstCatalogue({
    dials: { target_pnl: true },
    current: { target_pnl: 250000 },
    variant: 'hold-recycle-r',
    defaults: CATALOGUE_DEFAULTS,
  })
  assert.equal(asBool.ok, false)
  assert.match(asBool.ok === false ? asBool.error : '', /target_pnl/)

  const asNumber = validateDialsAgainstCatalogue({
    dials: { gamma_shorts_only: 1 },
    current: {},
    variant: 'hold-recycle-r',
    defaults: CATALOGUE_DEFAULTS,
  })
  assert.equal(asNumber.ok, false)
})

test('an unpublished catalogue says SO in the refusal — it is not the operator\'s typo', () => {
  // A knob that is in NO schema: the sentence about the catalogue is only
  // reachable once the engine's own dials are ruled out (see below).
  const bad = validateDialsAgainstCatalogue({
    dials: { unwind_share: 1 },
    current: {},
    variant: 'never-published-r',
    defaults: null,
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /catalogue/i)
  assert.match(bad.ok === false ? bad.error : '', /never-published-r/)
})

/**
 * THE ENGINE'S OWN SCHEMA IS KNOWN WITHOUT A CATALOGUE — which is what makes
 * the dials panel usable on a book built from a preset. Those rows carry only
 * the preset's dials, and the Python variant catalogue that used to vouch for
 * the rest is being retired (spec §5).
 */
test('a dial the ENGINE schema declares is editable with no catalogue and an empty row', () => {
  const good = validateDialsAgainstCatalogue({
    dials: { confirm_ms: 8000, shift_enabled: false },
    current: {},
    variant: 'recenter-relief-r',
    defaults: null,
  })
  assert.equal(good.ok, true)
})

test('the engine schema types are enforced too — a boolean for a number is still refused', () => {
  const bad = validateDialsAgainstCatalogue({
    dials: { confirm_ms: true },
    current: {},
    variant: 'recenter-relief-r',
    defaults: null,
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /confirm_ms/)
})

/**
 * THE ROW WINS THE TYPE CHECK. A live book running a knob as a number is
 * running it as a number, whatever the schema says it should be — refusing the
 * edit would strand the value rather than correct it.
 */
test('a row that disagrees with the schema about a dial\'s type keeps its own', () => {
  const good = validateDialsAgainstCatalogue({
    dials: { no_band_floor: 1 },
    current: { no_band_floor: 0 },
    variant: 'legacy-r',
    defaults: null,
  })
  assert.equal(good.ok, true)
})

// --------------------------------------------- the operator's own connection

const PASSWORD = 'the-operator-typed-this-again'

/**
 * A gate that authenticates a PERSON. `bearerGate` (the fixture above) can only
 * ever produce a machine principal, and a machine principal can never satisfy
 * `reauth` by design — so the password-passes path needs its own gate.
 */
const operatorGate: AuthGate = {
  authenticate: async () => ({ kind: 'user', name: 'aaditya' }),
  reauth: async (principal, password) => {
    if (principal.kind === 'machine') return 'an automated client cannot re-authenticate'
    return password === PASSWORD ? null : 'that password is not correct'
  },
}

interface FlattenCall { tag: string; mode: string; decisionId: string; style: string }
let flattenCalls: FlattenCall[] = []
let closeLegCalls: Record<string, unknown>[] = []
/**
 * The ids the double actually ROUTED under, as opposed to replayed.
 *
 * `flattenTag` returns the stored record without touching a rail when the id has
 * already been claimed, so this is what separates "the retry was safe" from "the
 * retry sent a second exit set".
 */
let routedIds: string[] = []

/** Serve `booksRoutes` to an OPERATOR, with a service double that records exits. */
async function asOperator(fn: (at: string) => Promise<void>): Promise<void> {
  flattenCalls = []
  closeLegCalls = []
  routedIds = []
  const service = {
    flattenTag: async (args: FlattenCall) => {
      flattenCalls.push(args)
      /**
       * THE REPLAY-ON-EXISTENCE RULE, modelled because it is the whole point of
       * the id: `flattenTag` checks `desk-decisions` before it reads a position
       * or routes anything, and returns the stored outcome when the id is spent.
       */
      const spent = await store.collection(COLLECTIONS.decisions).findOne({ decisionId: args.decisionId })
      if (spent !== null) {
        const flatten = (spent['flatten'] ?? {}) as Record<string, unknown>
        return { tag: args.tag, mode: args.mode, replayed: true, flat: flatten['flat'] === true, legs: [], fills: [], unpriceable: [], unresolved: [], malformedFills: [] }
      }
      routedIds.push(args.decisionId)
      return { tag: args.tag, mode: args.mode, flat: false, legs: [], fills: [], unpriceable: [], unresolved: [], malformedFills: [] }
    },
    closeLeg: async (args: Record<string, unknown>) => {
      closeLegCalls.push(args)
      return { ok: true, closed: [], fills: [], skips: [], unpriceable: [] }
    },
  }
  const deps = {
    db: handle!.db,
    store,
    service,
    log: () => {},
    now: () => NOW,
    gate: operatorGate,
  } as unknown as Parameters<typeof booksRoutes>[0]
  const srv = createBridgeServer({ gate: operatorGate, routes: [booksRoutes(deps)] })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)
  } finally {
    await new Promise<void>((r) => srv.close(() => r()))
  }
}

async function call(
  at: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${at}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const LIVE_BODY = { ...CREATE_BODY, mode: 'live' }

itMongo('retuning a LIVE book costs the password — and changes nothing without it', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', LIVE_BODY)
    const res = await call(at, 'PATCH', `/v1/desk/books/registry/${LIVE_BODY.tag}`, {
      mode: 'live',
      dials: { target_pnl: 1 },
    })
    assert.equal(res.status, 403)
    assert.equal(res.body['reauthRequired'], true)
    const row = await store.getBook(LIVE_BODY.tag, 'live')
    assert.equal(row?.dials['target_pnl'], 250000, 'the live book kept the dial it was running on')
  })
})

itMongo('the right password lets it through, and the row records WHO and WHEN', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', LIVE_BODY)
    const res = await call(at, 'PATCH', `/v1/desk/books/registry/${LIVE_BODY.tag}`, {
      mode: 'live',
      dials: { target_pnl: 300000 },
      password: PASSWORD,
    })
    assert.equal(res.status, 200)
    const doc = await store.getBookRaw(LIVE_BODY.tag, 'live')
    assert.equal((doc?.['dials'] as Record<string, unknown>)['target_pnl'], 300000)
    assert.equal(doc?.['dialsSetBy'], 'aaditya', 'the AUTHENTICATED principal, never the body')
    assert.equal(doc?.['dialsSetAt'], NOW)
  })
})

itMongo('a wrong password is refused as re-auth, not as a bad request', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', LIVE_BODY)
    const res = await call(at, 'PATCH', `/v1/desk/books/registry/${LIVE_BODY.tag}`, {
      mode: 'live', dials: { target_pnl: 1 }, password: 'not it',
    })
    assert.equal(res.status, 403)
    assert.equal(res.body['reauthRequired'], true, 'the prompt must re-open, not show a dead error')
  })
})

itMongo('a PAPER book is retuned with no password — and still records who did it', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    const res = await call(at, 'PATCH', `/v1/desk/books/registry/${CREATE_BODY.tag}`, {
      mode: 'paper', dials: { target_pnl: 300000 },
    })
    assert.equal(res.status, 200)
    assert.equal((await store.getBookRaw(CREATE_BODY.tag, 'paper'))?.['dialsSetBy'], 'aaditya')
  })
})

itMongo('a dial the variant does not carry is a 400 naming it — nothing is written', async () => {
  // The catalogue row is INSERTED rather than published: `POST /v1/desk/variants`
  // went with the Python supervisor (D9), and the rows it left behind are still
  // what this check reads a variant's known dials from.
  await store.collection(COLLECTIONS.variants).insertOne({
    key: 'hold-recycle-r', decider: 'rule-engine', playbook: 'hold-recycle',
    defaults: CATALOGUE_DEFAULTS,
  })
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    const res = await call(at, 'PATCH', `/v1/desk/books/registry/${CREATE_BODY.tag}`, {
      mode: 'paper', dials: { targetPnl: 200 },
    })
    assert.equal(res.status, 400)
    assert.match(String(res.body['error']), /targetPnl/)
    const row = await store.getBook(CREATE_BODY.tag, 'paper')
    assert.equal(row?.dials['targetPnl'], undefined, 'the typo was never stored')
  })
})

itMongo('the shared MACHINE bearer can never retune a live book, whatever it sends', async () => {
  // The fixture server's gate is `bearerGate`, so this is the Python desk's own
  // credential. F-29's point: it reached this endpoint with no second factor at
  // all, and `reauth` refuses a machine principal by design.
  await post('/v1/desk/books/registry', LIVE_BODY)
  const res = await patch(`/v1/desk/books/registry/${LIVE_BODY.tag}`, {
    mode: 'live', dials: { target_pnl: 1 }, password: PASSWORD,
  })
  assert.equal(res.status, 403)
  assert.equal(res.body['reauthRequired'], true)
})

// ------------------------------------ F-33: one flatten per day, not per click

/**
 * THE RETRIED CLICK. `?flatten=1` minted `delete-flatten-${tag}-${now()}`, so a
 * proxy timeout plus a second click routed a SECOND full exit set — while every
 * other flatten caller must supply an id precisely to make a retry safe.
 */
itMongo('delete-with-flatten derives one decisionId per day, so a retried click cannot flatten twice', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
    await journalFill('Buy', 2625, NOW)

    await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)
    // The service double closes nothing, so the position is still there — the
    // operator clicks again, exactly as they would after a proxy timeout.
    await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)

    assert.equal(flattenCalls.length, 2, 'both clicks reached the service')
    // NOW is 2026-07-28 10:30 IST.
    assert.equal(flattenCalls[0]?.decisionId, `delete-flatten-${CREATE_BODY.tag}-paper-2026-07-28`)
    assert.equal(
      flattenCalls[1]?.decisionId,
      flattenCalls[0]?.decisionId,
      'the same id, so the order rail dedupes the second exit set',
    )
  })
})

/**
 * THE SPENT ID. A day-keyed id is retry-PROTECTION only while the flatten it
 * names actually worked. `flattenTag` claims the id before it routes and
 * replays it forever after, so a flatten that FAILED — the live switch off, the
 * allowlist refusing the tag, the rail down — spends the id having routed
 * nothing: every retry for the rest of the IST day replays the FAILED record,
 * routes nothing, and the re-read still finds the position, so `DELETE
 * ?flatten=1` 409s until midnight. The control the operator reaches for after a
 * failure is the one control that cannot work after a failure.
 */
const DELETE_FLATTEN_ID = `delete-flatten-${CREATE_BODY.tag}-paper-2026-07-28`

/** A `desk-decisions` record shaped like the one `flattenTag` leaves behind. */
async function journalFlattenOutcome(
  decisionId: string,
  outcome: 'success' | 'failure' | 'partial',
): Promise<void> {
  await store.collection(COLLECTIONS.decisions).insertOne({
    decisionId,
    symbol: 'BHEL26AUG430CE',
    expiry: '',
    mode: 'paper',
    tag: CREATE_BODY.tag,
    fills: [],
    skips: [],
    createdAt: NOW,
    // DONE means every leg routed and resolved; FAILED means at least one did
    // not. `flat` is the second, independent fact — a DONE flatten over an empty
    // window is `flat: false` and closed nothing.
    status: outcome === 'failure' ? 'FAILED' : 'DONE',
    source: 'flatten',
    ...(outcome === 'failure'
      ? { routeErrors: [{ fill: {}, error: 'BHEL-2026-08-25-hold-recycle-r is not on the live allowlist' }] }
      : {}),
    flatten: {
      legs: [],
      unpriceable: [],
      unresolved: [],
      truncated: [],
      malformedFills: [],
      fillsTruncated: false,
      flat: outcome === 'success',
      window: { from: 0, to: NOW },
    },
  })
}

itMongo('a retry after a flatten that FULLY SUCCEEDED reuses the id — a replay routes nothing', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
    await journalFill('Buy', 2625, NOW)
    // Today's flatten already ran and closed everything it found.
    await journalFlattenOutcome(DELETE_FLATTEN_ID, 'success')

    const res = await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)

    assert.equal(flattenCalls[0]?.decisionId, DELETE_FLATTEN_ID, 'F-33 still holds: a success is never re-minted')
    assert.deepEqual(routedIds, [], 'the retry replayed — no second exit set reached a rail')
    assert.equal(res.status, 409, 'and the delete is still refused, because the position is still there')
  })
})

itMongo('a retry after a FAILED flatten mints -r2 and actually routes — the button is not dead', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
    await journalFill('Buy', 2625, NOW)
    await journalFlattenOutcome(DELETE_FLATTEN_ID, 'failure')

    await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)

    assert.equal(flattenCalls[0]?.decisionId, `${DELETE_FLATTEN_ID}-r2`)
    assert.deepEqual(routedIds, [`${DELETE_FLATTEN_ID}-r2`], 'the second attempt reached a rail')
  })
})

itMongo('a flatten that ran but closed NOTHING (DONE, not flat) also mints the next id', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
    await journalFill('Buy', 2625, NOW)
    // Every leg it found routed — but it found none, so nothing was closed.
    await journalFlattenOutcome(DELETE_FLATTEN_ID, 'partial')

    await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)

    assert.equal(flattenCalls[0]?.decisionId, `${DELETE_FLATTEN_ID}-r2`)
  })
})

itMongo('successive failures walk the suffixes, and the fifth refuses rather than minting a sixth', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
    await journalFill('Buy', 2625, NOW)
    for (const id of [
      DELETE_FLATTEN_ID,
      `${DELETE_FLATTEN_ID}-r2`,
      `${DELETE_FLATTEN_ID}-r3`,
      `${DELETE_FLATTEN_ID}-r4`,
    ]) {
      await journalFlattenOutcome(id, 'failure')
    }

    const fifth = await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)
    assert.equal(flattenCalls[0]?.decisionId, `${DELETE_FLATTEN_ID}-r5`, 'the last attempt this day is allowed')
    assert.equal(fifth.status, 409, 'the double still closes nothing, so the delete is refused')

    // The fifth is now spent and failed too. There is no sixth.
    await journalFlattenOutcome(`${DELETE_FLATTEN_ID}-r5`, 'failure')
    flattenCalls = []
    const sixth = await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)

    assert.equal(sixth.status, 409)
    assert.equal(flattenCalls.length, 0, 'nothing is routed once the attempts are spent')
    assert.match(String(sixth.body['error']), /close-all/, 'the refusal names the control that still works')
    assert.match(String(sixth.body['error']), /5/)
  })
})

itMongo('an id consumed by some OTHER caller is treated as spent, never as a success', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
    await journalFill('Buy', 2625, NOW)
    // `applyDecision`'s shape: DONE, and no `flatten` block at all. Nothing here
    // says a position was closed, so reusing the id would replay a non-result.
    await store.collection(COLLECTIONS.decisions).insertOne({
      decisionId: DELETE_FLATTEN_ID,
      symbol: 'BHEL',
      expiry: '2026-08-25',
      mode: 'paper',
      tag: CREATE_BODY.tag,
      fills: [],
      skips: [],
      createdAt: NOW,
      status: 'DONE',
    })

    await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)

    assert.equal(flattenCalls[0]?.decisionId, `${DELETE_FLATTEN_ID}-r2`)
  })
})

itMongo('an id claimed but never completed (ROUTING) is REUSED — an in-flight flatten is not doubled', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
    await journalFill('Buy', 2625, NOW)
    // The claim `flattenTag` writes BEFORE it routes. A retry that arrives while
    // the first one is still routing must not mint a fresh id.
    await store.collection(COLLECTIONS.decisions).insertOne({
      decisionId: DELETE_FLATTEN_ID,
      symbol: 'BHEL26AUG430CE',
      expiry: '',
      mode: 'paper',
      tag: CREATE_BODY.tag,
      fills: [],
      skips: [],
      createdAt: NOW,
      status: 'ROUTING',
      source: 'flatten',
    })

    await call(at, 'DELETE', `/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper&flatten=1`)

    assert.equal(flattenCalls[0]?.decisionId, DELETE_FLATTEN_ID)
    assert.deepEqual(routedIds, [], 'nothing was routed a second time under a new id')
  })
})

// ---------------------------- F-32: an incomplete fill read blocks the delete

/** A fill the P&L reader refuses — the position rebuilt from it may be wrong. */
async function journalMalformedFill(at: number): Promise<void> {
  await store.collection(COLLECTIONS.decisions).insertOne({
    decisionId: `d-bad-${at}`,
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    tag: CREATE_BODY.tag,
    fills: [{ op: 'open', deskTag: 'bad#0', tradingsymbol: 'BHEL26AUG430CE', side: 'Buy', qty: 'lots', price: 8, ts: at }],
    skips: [],
    createdAt: at,
    status: 'DONE',
    source: 'submit',
  })
}

itMongo('a delete is refused while the fill read is INCOMPLETE — the same flags flattenIsFlat blocks on', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await journalFill('Buy', 2625, NOW)
  await journalFill('Sell', 2625, NOW + 1000)
  // Nets to zero on the readable fills, so the position guard alone would say
  // "stale, delete it" — while one fill in the window could not be read at all.
  await journalMalformedFill(NOW + 2000)

  const res = await del(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  assert.equal(res.status, 409, 'the hardest-to-reverse action must not run on a fill read it distrusts')
  assert.match(String(res.body['error']), /could not be read/i)
  assert.ok(await store.getBook(CREATE_BODY.tag, 'paper'), 'nothing was erased')
})

// ------------------------------------------- F-34: aggression has a ceiling

itMongo('close-leg refuses an aggression that is not a fraction, naming the range', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await call(at, 'POST', `/v1/desk/books/registry/${CREATE_BODY.tag}/actual`, {
      mode: 'paper', actual: 'running',
    })
    // 5 meaning "5%" prices a ₹40 short at ₹240.
    const res = await call(at, 'POST', `/v1/desk/books/registry/${CREATE_BODY.tag}/close-leg`, {
      mode: 'paper', tradingsymbol: 'BHEL26AUG430CE', style: 'limit', decisionId: 'x-1', aggressionPct: 5,
    })
    assert.equal(res.status, 400)
    assert.match(String(res.body['error']), /0\.25/)
    assert.equal(closeLegCalls.length, 0, 'nothing reached the exit pricer')
  })
})

itMongo('close-leg still accepts a real aggression, and passes it through', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await call(at, 'POST', `/v1/desk/books/registry/${CREATE_BODY.tag}/actual`, {
      mode: 'paper', actual: 'running',
    })
    const res = await call(at, 'POST', `/v1/desk/books/registry/${CREATE_BODY.tag}/close-leg`, {
      mode: 'paper', tradingsymbol: 'BHEL26AUG430CE', style: 'limit', decisionId: 'x-2', aggressionPct: 0.02,
    })
    assert.equal(res.status, 200)
    assert.equal(closeLegCalls[0]?.['aggressionPct'], 0.02)
  })
})

itMongo('close-leg refuses a NaN aggression too — finiteness is not implied by typeof', async () => {
  await asOperator(async (at) => {
    await call(at, 'POST', '/v1/desk/books/registry', CREATE_BODY)
    await call(at, 'POST', `/v1/desk/books/registry/${CREATE_BODY.tag}/actual`, {
      mode: 'paper', actual: 'running',
    })
    const res = await call(at, 'POST', `/v1/desk/books/registry/${CREATE_BODY.tag}/close-leg`, {
      // JSON has no NaN; the string is what a form sends, and `typeof 'x'` is
      // not 'number' — so this is the shape check, and the -1 below is the range.
      mode: 'paper', tradingsymbol: 'BHEL26AUG430CE', style: 'limit', decisionId: 'x-3', aggressionPct: -1,
    })
    assert.equal(res.status, 400)
  })
})

// ------------------------------------------------- the paper rail (demo)

test('dx_paper_rail: every row carries it; only an exact "demo" is demo', () => {
  assert.equal(DEFAULT_BOOK.dx_paper_rail, 'sim')
  const base = { tag: 'T', symbol: 'BTC', expiry: '2026-11-04', mode: 'paper', variant: 'v' }
  assert.equal(bookFromDoc(base)?.dx_paper_rail, 'sim')
  assert.equal(bookFromDoc({ ...base, dx_paper_rail: 'demo' })?.dx_paper_rail, 'demo')
  for (const junk of ['Demo', 'DEMO', true, 1, 'live', '']) {
    assert.equal(bookFromDoc({ ...base, dx_paper_rail: junk })?.dx_paper_rail, 'sim', String(junk))
  }
})

itMongo('paper-rail: a paper book switches sim -> demo -> sim, recorded with who set it', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  const created = await get(`/v1/desk/books/registry/${CREATE_BODY.tag}?mode=paper`)
  if (created.status === 200) assert.equal(created.body['dx_paper_rail'], 'sim')

  const on = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/paper-rail`, { mode: 'paper', rail: 'demo' })
  assert.equal(on.status, 200, JSON.stringify(on.body))
  assert.equal(on.body['dx_paper_rail'], 'demo')
  const raw = await handle!.db.collection(COLLECTIONS.booksRegistry).findOne({ tag: CREATE_BODY.tag, mode: 'paper' })
  assert.equal(raw?.['dx_paper_rail'], 'demo')
  assert.equal(typeof raw?.['paperRailSetBy'], 'string')

  const off = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/paper-rail`, { mode: 'paper', rail: 'sim' })
  assert.equal(off.status, 200)
  assert.equal(off.body['dx_paper_rail'], 'sim')
})

itMongo('paper-rail: refused for live, for a bad rail, and for an unknown book', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  const live = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/paper-rail`, { mode: 'live', rail: 'demo' })
  assert.equal(live.status, 400)
  assert.match(String(live.body['error']), /paper books only/)
  const bad = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/paper-rail`, { mode: 'paper', rail: 'testnet' })
  assert.equal(bad.status, 400)
  assert.match(String(bad.body['error']), /'sim' or 'demo'/)
  const none = await post('/v1/desk/books/registry/NOPE/paper-rail', { mode: 'paper', rail: 'demo' })
  assert.equal(none.status, 404)
  assert.equal((await store.getBook(CREATE_BODY.tag, 'paper'))?.dx_paper_rail, 'sim')
})

itMongo('paper-rail: refused while the book holds legs or has a decision working — a close must go where the open went', async () => {
  await post('/v1/desk/books/registry', CREATE_BODY)
  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [LEG], NOW)
  const held = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/paper-rail`, { mode: 'paper', rail: 'demo' })
  assert.equal(held.status, 409)
  assert.match(String(held.body['error']), /BHEL26AUG430CE/)
  assert.equal((await store.getBook(CREATE_BODY.tag, 'paper'))?.dx_paper_rail, 'sim')

  await store.saveBook({ tag: CREATE_BODY.tag, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' }, [], NOW)
  const states = handle!.db.collection('desk-supervisor-state')
  const key = `${CREATE_BODY.tag}:paper`
  try {
    await states.insertOne({ key, inFlight: `${CREATE_BODY.tag}:paper:7`, workingPackage: null })
    const working = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/paper-rail`, { mode: 'paper', rail: 'demo' })
    assert.equal(working.status, 409)
    assert.match(String(working.body['error']), /:paper:7/)
  } finally {
    await states.deleteMany({ key })
  }
  const flat = await post(`/v1/desk/books/registry/${CREATE_BODY.tag}/paper-rail`, { mode: 'paper', rail: 'demo' })
  assert.equal(flat.status, 200, JSON.stringify(flat.body))
})
