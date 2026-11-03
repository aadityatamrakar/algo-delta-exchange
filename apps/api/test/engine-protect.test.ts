/**
 * `POST /v1/desk/engine/protect` — the operator pinning lots the engine may
 * not spend (spec §4, D12), and the read that renders it back on the leg rows.
 *
 * AGAINST A REAL MONGODB, for the reason `state-store.test.ts` gives about
 * itself: what is interesting here is a DATABASE property. The route is a
 * load → merge → compare-and-set into a document the supervisor is also
 * writing, and "the losing writer is told, and writes nothing" is decided by
 * the server matching a filter. A fake that modelled the race would be a
 * second implementation of the thing under test.
 *
 * OWN DATABASE NAME, so this file can run beside the other Mongo suites.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { skipUnlessMongo } from './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { type AuthGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { engineRoutes, validateProtectRequest } from '../src/routes/engine.ts'
import { AUDIT_COLLECTION } from '../src/audit.ts'
import {
  StateStore,
  SUPERVISOR_STATE_COLLECTION,
  nextVersion,
  type StateCollection,
} from '../../supervisor/src/state-store.ts'

const URL_MONGO =
  process.env['DESK_TEST_MONGO_ENGINE_PROTECT'] ??
  'mongodb://127.0.0.1:27017/algomaker_dx_engine_protect_test'

const TAG = 'BHEL-2026-08-25-recenter-relief-r'
const INSTRUMENT = 'BHEL26AUG415CE'
const PASSWORD = 'the-operator-typed-this-again'
const NOW = Date.UTC(2026, 7, 21, 5, 0)

let handle: MongoHandle | null = null
let server: Server | null = null
let base = ''
let store: DeskStore
let state: StateStore
let available = true

/** A PERSON at the keyboard — a machine principal can never satisfy re-auth. */
const gate: AuthGate = {
  authenticate: async () => ({ kind: 'user', name: 'aaditya' }),
  reauth: async (principal, password) => {
    if (principal.kind === 'machine') return 'an automated client cannot re-authenticate'
    return password === PASSWORD ? null : 'that password is not correct'
  },
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
  state = new StateStore(
    handle.db.collection(SUPERVISOR_STATE_COLLECTION) as unknown as StateCollection,
  )
  await state.ensureIndexes()
  const deps = {
    db: handle.db,
    store,
    log: () => {},
    now: () => NOW,
    gate,
  } as unknown as Parameters<typeof engineRoutes>[0]
  server = createBridgeServer({ gate, routes: [engineRoutes(deps)] })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).deleteMany({})
  await handle!.db.collection(AUDIT_COLLECTION).deleteMany({})
  await store.upsertBook({
    tag: TAG,
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    variant: 'recenter-relief-r',
    series: 'BHEL-recenter-relief-r',
    dials: {},
    desired: 'stopped',
    actual: 'stopped',
    lastMarkAt: 0,
    lastDecision: '',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await store.upsertBook({
    tag: TAG,
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'live',
    variant: 'recenter-relief-r',
    series: 'BHEL-recenter-relief-r',
    dials: {},
    desired: 'stopped',
    actual: 'stopped',
    lastMarkAt: 0,
    lastDecision: '',
    createdAt: NOW,
    updatedAt: NOW,
  })
})

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const protect = (over: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> =>
  call('POST', '/v1/desk/engine/protect', {
    tag: TAG, mode: 'paper', instrument: INSTRUMENT, protectedQty: 3, ...over,
  })

// ------------------------------------------------------------- pure checks

test('a quantity that is not a whole number of lots is refused', () => {
  for (const protectedQty of [1.5, -1, Number.NaN, '3']) {
    const bad = validateProtectRequest({ tag: TAG, mode: 'paper', instrument: INSTRUMENT, protectedQty })
    assert.equal(bad.ok, false, `${String(protectedQty)} was accepted`)
  }
})

test('mode is never defaulted — paper and live are two books under one tag', () => {
  const bad = validateProtectRequest({ tag: TAG, instrument: INSTRUMENT, protectedQty: 1 })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /mode/)
})

test('zero is a valid request: it is how a claim is removed', () => {
  const ok = validateProtectRequest({ tag: TAG, mode: 'live', instrument: INSTRUMENT, protectedQty: 0 })
  assert.equal(ok.ok, true)
})

// ------------------------------------------------------------- the route

itMongo('a protect lands in supervisor state, and comes back on the read', async () => {
  const res = await protect()
  assert.equal(res.status, 200)
  assert.deepEqual(res.body['protectedQty'], { [INSTRUMENT]: 3 })

  // Through the STORE, not the route's own answer: the point is the document.
  const saved = await state.load(TAG, 'paper')
  assert.deepEqual(saved.protectedQty, { [INSTRUMENT]: 3 })

  const read = await call('GET', `/v1/desk/engine/protect?tag=${TAG}&mode=paper`)
  assert.equal(read.status, 200)
  assert.deepEqual(read.body['protectedQty'], { [INSTRUMENT]: 3 })
})

itMongo('a second instrument JOINS the map — it does not replace it', async () => {
  await protect()
  const res = await protect({ instrument: 'BHEL26AUG400PE', protectedQty: 1 })
  assert.deepEqual(res.body['protectedQty'], { [INSTRUMENT]: 3, BHEL26AUG400PE: 1 })
})

itMongo('zero REMOVES the key rather than storing a zeroed claim', async () => {
  await protect()
  const res = await protect({ protectedQty: 0 })
  assert.deepEqual(res.body['protectedQty'], {})
  assert.deepEqual((await state.load(TAG, 'paper')).protectedQty, {})
})

/**
 * THE REST OF THE STATE IS NOT TOUCHED. The route reads, merges one key and
 * writes the whole document back — so a working package or a realised figure
 * the supervisor put there has to survive a protect, or an operator pinning a
 * leg would erase the desk's memory of what it owes.
 */
itMongo('everything else the supervisor stored survives the write', async () => {
  const prev = await state.load(TAG, 'paper')
  await state.save(prev, {
    ...prev,
    cumRealized: -4500,
    inFlight: `${TAG}:paper:7`,
    seq: 7,
    updatedAt: nextVersion(prev, NOW),
  })

  await protect()

  const after = await state.load(TAG, 'paper')
  assert.equal(after.cumRealized, -4500)
  assert.equal(after.inFlight, `${TAG}:paper:7`)
  assert.equal(after.seq, 7)
  assert.deepEqual(after.protectedQty, { [INSTRUMENT]: 3 })
})

itMongo('the version ADVANCES, so the next compare-and-set can tell', async () => {
  const before = await state.load(TAG, 'paper')
  await protect()
  const after = await state.load(TAG, 'paper')
  assert.ok(after.updatedAt > before.updatedAt)
})

itMongo('a tag with no registry row is refused — protection nothing will read', async () => {
  const res = await protect({ tag: 'NOT-A-BOOK' })
  assert.equal(res.status, 404)
  assert.equal(await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).countDocuments({}), 0)
})

itMongo('a bad quantity is refused before anything is written', async () => {
  const res = await protect({ protectedQty: -2 })
  assert.equal(res.status, 400)
  assert.deepEqual((await state.load(TAG, 'paper')).protectedQty, {})
})

/**
 * LIVE COSTS THE PASSWORD, and the request is checked BEFORE the prompt is
 * demanded — the same order `routes/books.ts` holds for a dials patch, so a
 * typo is answered without an operator typing their password for nothing.
 */
itMongo('a LIVE protect without the password is refused, and writes nothing', async () => {
  const res = await protect({ mode: 'live' })
  assert.equal(res.status, 403)
  assert.equal(res.body['reauthRequired'], true)
  assert.deepEqual((await state.load(TAG, 'live')).protectedQty, {})
})

itMongo('a LIVE protect WITH the password applies', async () => {
  const res = await protect({ mode: 'live', password: PASSWORD })
  assert.equal(res.status, 200)
  assert.deepEqual((await state.load(TAG, 'live')).protectedQty, { [INSTRUMENT]: 3 })
  // ...and it landed on the LIVE book only. Two ledgers, one tag.
  assert.deepEqual((await state.load(TAG, 'paper')).protectedQty, {})
})

itMongo('a malformed LIVE request is answered before the password is asked for', async () => {
  const res = await protect({ mode: 'live', protectedQty: 1.5 })
  assert.equal(res.status, 400)
})

itMongo('paper asks for no password at all', async () => {
  assert.equal((await protect()).status, 200)
})

itMongo('the write is recorded in the audit log, with who and what it was before', async () => {
  await protect()
  await protect({ protectedQty: 5 })
  const rows = await handle!.db.collection(AUDIT_COLLECTION).find({ tag: TAG }).toArray()
  assert.equal(rows.length, 2)
  const last = rows.at(-1) as Record<string, unknown>
  assert.equal(last['principal'], 'aaditya')
  assert.deepEqual(last['detail'], { instrument: INSTRUMENT, before: 3, after: 5 })
})

itMongo('a GET without a mode is refused rather than guessing paper', async () => {
  const res = await call('GET', `/v1/desk/engine/protect?tag=${TAG}`)
  assert.equal(res.status, 400)
})

itMongo('a book nobody has protected reads as an empty map, not a 404', async () => {
  const res = await call('GET', `/v1/desk/engine/protect?tag=${TAG}&mode=paper`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body['protectedQty'], {})
})
