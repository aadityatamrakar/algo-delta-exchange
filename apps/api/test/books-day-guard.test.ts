/**
 * A STOP THE OPERATOR CANNOT REACH IS NOT A STOP (T12).
 *
 * `day-guard.ts` never imports `books-registry.ts`. `runGuards` iterates
 * `listStrategies()` and filters on `isArmed`, and only a `StrategyRow` carries
 * `dailyLimits`. Registering a book DOES create the companion `desk-strategies`
 * row — but with no limits, so `isArmed()` is false and every book is skipped in
 * SILENCE. A delta-lean book therefore had exactly one stop: the engine's own.
 *
 * This file pins the second one. It is defence in depth BEHIND the engine's day
 * stop, for the case where the engine is the thing that is wrong — not a
 * replacement for it, and never a change to how an already-armed strategy is
 * judged.
 *
 * The stop is read through `resolveDials`, never off the raw override document:
 * a book that switches the path on and says nothing else has NO `dl_day_max_loss`
 * key at all, and reading the raw document would arm it at `undefined` — which
 * is an unarmed guard that looks armed.
 *
 * OWN DATABASE NAME: `algomaker_dx_books_day_guard_test`, distinct from every other
 * Mongo suite, because `node:test` runs files in parallel processes and each one
 * wipes its collections between tests.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { skipUnlessMongo } from './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { booksRoutes, guardStopFor } from '../src/routes/books.ts'
import { isArmed } from '../src/day-guard.ts'
import { DEFAULT_DIALS } from '@algomaker/desk-engine'
import type { StrategyRow } from '../src/strategies.ts'

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_books_day_guard_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
/** A real date, never `Date.now()`: 2026-09-15 10:30 IST, mid-session. */
let NOW = Date.UTC(2026, 8, 15, 5, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let nudgeServer: Server | null = null
let priorSupervisorPort: string | undefined
let base = ''
let available = false

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

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
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

  // The dials PATCH best-effort nudges the supervisor. Without a listener the
  // call still cannot fail the patch, but it would spend its timeout on every
  // test in this file; a loopback sink keeps the suite quick.
  nudgeServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((r) => nudgeServer!.listen(0, '127.0.0.1', r))
  priorSupervisorPort = process.env['DESK_SUPERVISOR_PORT']
  process.env['DESK_SUPERVISOR_PORT'] = String((nudgeServer!.address() as AddressInfo).port)
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (nudgeServer !== null) await new Promise<void>((r) => nudgeServer!.close(() => r()))
  if (priorSupervisorPort === undefined) delete process.env['DESK_SUPERVISOR_PORT']
  else process.env['DESK_SUPERVISOR_PORT'] = priorSupervisorPort
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) {
    await handle!.db.collection(c).deleteMany({})
  }
  await store.ensureIndexes()
  NOW = Date.UTC(2026, 8, 15, 5, 0)
})

const LEAN_TAG = 'NIFTY-2026-09-17-delta-lean-aggressive'
const RECENTER_TAG = 'BHEL-2026-08-25-hold-recycle-r'

/** A delta-lean book, with only the dials the caller states. */
function leanBook(dials: Record<string, number | boolean>): Record<string, unknown> {
  return {
    tag: LEAN_TAG,
    symbol: 'NIFTY',
    expiry: '2026-09-17',
    mode: 'paper',
    variant: 'delta-lean-aggressive',
    dials: { delta_lean_enabled: true, ...dials },
  }
}

/** The recenter book this desk has always registered. Nothing delta-lean in it. */
const RECENTER_BODY = {
  tag: RECENTER_TAG,
  symbol: 'BHEL',
  expiry: '2026-08-25',
  mode: 'paper',
  variant: 'hold-recycle-r',
  dials: { target_pnl: 250000, margin_cap: 100000000 },
}

async function strategy(tag: string): Promise<StrategyRow> {
  const row = await store.loadStrategy(tag)
  assert.ok(row, `no strategy row for ${tag}`)
  return row
}

// ------------------------------------------------------------ registration

itMongo('registering a delta-lean book arms the day guard, at the dial it states', async () => {
  const res = await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 40_000 }))
  assert.equal(res.status, 201)
  const row = await strategy(LEAN_TAG)
  assert.equal(isArmed(row), true, 'the companion row must be one runGuards actually looks at')
  assert.equal(row.dailyLimits?.stop, 60_000, '1.5 x the engine budget')
  // A stop, never a target: the guard is a backstop on the LOSS. Arming a
  // target would switch a book off on a good day, which nobody asked for.
  assert.equal(row.dailyLimits?.target, undefined)
})

itMongo('the guard sits BEHIND the engine: dl_day_max_loss 30,000 arms the desk stop at 45,000', async () => {
  // The two stops must not fire on the same line. A delta-lean tag has no
  // runtime row, so the guard's exit is `flattenTag`, which does not look for
  // orders already out and rebuilds the book from fills the paper fold may not
  // have landed yet. If it fires beside the engine's own dl-stop flatten, both
  // closes can fill and the book flips. 1.5 x, rounded up to the next 1,000,
  // leaves the engine the first exit and the guard the backstop.
  await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 30_000 }))
  assert.equal((await strategy(LEAN_TAG)).dailyLimits?.stop, 45_000)
})

test('guardStopFor: 1.5 x, rounded UP to the next 1,000', () => {
  assert.equal(guardStopFor(30_000), 45_000)
  assert.equal(guardStopFor(15_000), 23_000)
  assert.equal(guardStopFor(25_000), 38_000)
  assert.equal(guardStopFor(200_000), 300_000)
  assert.equal(guardStopFor(1), 1_000)
})

itMongo('the stop is RESOLVED, so a book that states only the switch still gets the real number', async () => {
  // The raw override document here has ONE key. Reading `dials.dl_day_max_loss`
  // off it would find `undefined` and arm nothing; `resolveDials` folds it onto
  // DEFAULT_DIALS, which IS spec §9's aggressive column.
  await post('/v1/desk/books/registry', leanBook({}))
  const row = await strategy(LEAN_TAG)
  assert.equal(row.dailyLimits?.stop, guardStopFor(DEFAULT_DIALS.dl_day_max_loss))
  assert.equal(row.dailyLimits?.stop, 45_000, '1.5 x the aggressive column (R1: 30,000), restated so a silent drift is visible here')
})

itMongo('a recenter book is registered exactly as it was — no limits, and the guard skips it', async () => {
  const res = await post('/v1/desk/books/registry', RECENTER_BODY)
  assert.equal(res.status, 201)
  const row = await strategy(RECENTER_TAG)
  assert.equal(isArmed(row), false)
  // ABSENT, not an empty object: a present `dailyLimits` is a shape every
  // reader would then have to normalise, and `patchStrategy` unsets it exactly
  // because a stored empty one resurrects on the next read.
  assert.equal(row.dailyLimits, undefined)
  // ON: a fresh paper row is born switched on (`books-registry.test.ts`). The
  // point of THIS assertion is that the day guard is still absent for it.
  assert.deepEqual(row.modes, { paper: { enabled: true } })
})

itMongo('a book that names delta-lean dials but leaves the SWITCH off is not armed', async () => {
  // `dl_day_max_loss` alone does not put a book on the delta-lean path — only
  // `delta_lean_enabled` does (the engine branches on nothing else). Arming off
  // an inert dial would put a stop on a recenter book nobody asked to stop.
  await post('/v1/desk/books/registry', {
    ...leanBook({}),
    dials: { delta_lean_enabled: false, dl_day_max_loss: 40_000 },
  })
  assert.equal(isArmed(await strategy(LEAN_TAG)), false)
})

itMongo('re-registering after the strategy row was removed puts the GUARD back too', async () => {
  // The converge path (books-registry.test.ts pins it for `modes`). A book
  // deleted from the Strategies page and rebuilt used to come back with a
  // switch and no stop — unguarded, and indistinguishable from a guarded one.
  await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 40_000 }))
  await store.removeStrategyMode(LEAN_TAG, 'paper', NOW)
  await handle!.db.collection(COLLECTIONS.strategies).updateOne({ tag: LEAN_TAG }, { $unset: { dailyLimits: '' } })
  assert.equal(isArmed(await strategy(LEAN_TAG)), false, 'precondition: the stop really is gone')

  const again = await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 40_000 }))
  assert.equal(again.status, 200, 'an identical re-register converges')
  assert.equal((await strategy(LEAN_TAG)).dailyLimits?.stop, 60_000)
})

itMongo("registering never overwrites a limit already on the row", async () => {
  // Same discipline as `addStrategyMode` itself, which touches nothing but the
  // mode key on a row that exists. An operator who hand-tightened this tag to
  // 20,000 must not have it LOOSENED back to the dial by a re-register — and a
  // re-register does not apply the incoming dials to the book either, so
  // moving the limit derived from them would be the one inconsistent write.
  await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 40_000 }))
  await store.patchStrategy(LEAN_TAG, { dailyLimits: { stop: 20_000 } }, NOW)
  const again = await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 40_000 }))
  assert.equal(again.status, 200)
  assert.equal((await strategy(LEAN_TAG)).dailyLimits?.stop, 20_000, "the operator's own stop survived")
})

itMongo('a day budget the strategies API would refuse arms NOTHING rather than a bad shape', async () => {
  // `validateDailyLimits` is the one judge of what a limit may be — positive
  // rupees, at most DAILY_LIMIT_MAX. This path writes through the store rather
  // than over the wire, so it asks that same validator rather than writing a
  // row `PATCH /v1/desk/strategies/:tag` could never have produced.
  await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 0 }))
  const row = await strategy(LEAN_TAG)
  assert.equal(isArmed(row), false)
  assert.equal(row.dailyLimits, undefined)
})

// ------------------------------------------------------------- dials patch

itMongo('patching dl_day_max_loss moves the guard with it — no stale second stop', async () => {
  // The trap this closes: the engine's budget says 25,000 and the guard is
  // still holding the 45,000 registration wrote. Two stops that disagree is
  // worse than one, because the dashboard shows the operator only the dial.
  await post('/v1/desk/books/registry', leanBook({}))
  assert.equal((await strategy(LEAN_TAG)).dailyLimits?.stop, 45_000)

  const res = await patch(`/v1/desk/books/registry/${LEAN_TAG}`, {
    mode: 'paper',
    dials: { dl_day_max_loss: 25_000 },
  })
  assert.equal(res.status, 200)
  assert.equal((await strategy(LEAN_TAG)).dailyLimits?.stop, 38_000, '1.5 x 25,000, rounded UP to the next 1,000')
})

itMongo('patching an UNRELATED dial leaves the guard limit exactly where it was', async () => {
  // Only a patch that restates the day budget (or the switch) may move the
  // stop. Rewriting it on every dials save would silently clobber a limit an
  // operator set by hand on the strategy row.
  await post('/v1/desk/books/registry', leanBook({}))
  await store.patchStrategy(LEAN_TAG, { dailyLimits: { stop: 20_000 } }, NOW)
  const res = await patch(`/v1/desk/books/registry/${LEAN_TAG}`, {
    mode: 'paper',
    dials: { chase_max_ms: 1500 },
  })
  assert.equal(res.status, 200)
  assert.equal((await strategy(LEAN_TAG)).dailyLimits?.stop, 20_000)
})

itMongo('switching a recenter book ONTO the delta-lean path arms it at that moment', async () => {
  await post('/v1/desk/books/registry', RECENTER_BODY)
  assert.equal(isArmed(await strategy(RECENTER_TAG)), false)
  const res = await patch(`/v1/desk/books/registry/${RECENTER_TAG}`, {
    mode: 'paper',
    dials: { delta_lean_enabled: true },
  })
  assert.equal(res.status, 200)
  assert.equal((await strategy(RECENTER_TAG)).dailyLimits?.stop, guardStopFor(DEFAULT_DIALS.dl_day_max_loss))
})

itMongo('switching the path OFF leaves the stop armed — a guard is never disarmed by a side effect', async () => {
  // Deliberate, and stated here so it cannot be mistaken for an oversight.
  // Removing a stop is the one direction that can only cost money; an operator
  // who wants it gone sends `dailyLimits: null` to the strategies PATCH, which
  // is the surface built for exactly that and asks for it out loud.
  await post('/v1/desk/books/registry', leanBook({ dl_day_max_loss: 40_000 }))
  const res = await patch(`/v1/desk/books/registry/${LEAN_TAG}`, {
    mode: 'paper',
    dials: { delta_lean_enabled: false },
  })
  assert.equal(res.status, 200)
  assert.equal((await strategy(LEAN_TAG)).dailyLimits?.stop, 60_000)
})

itMongo('a dials patch never touches the switches — arming a stop is not arming a rail', async () => {
  await post('/v1/desk/books/registry', leanBook({}))
  await patch(`/v1/desk/books/registry/${LEAN_TAG}`, { mode: 'paper', dials: { dl_day_max_loss: 25_000 } })
  const row = await strategy(LEAN_TAG)
  // ON because the create left it on; the dials patch touched no switch.
  assert.deepEqual(row.modes, { paper: { enabled: true } })
  assert.equal(row.liveLots, 0)
})
