/**
 * Broker credentials over the wire.
 *
 * The controlling assertion is `assertNoSecret`, applied to the FULL JSON TEXT of
 * every response this module can produce, including the error paths. Checking
 * named fields would pass while a credential travelled inside `meta`, inside a
 * broker's echoed error message, or inside a field added later — and the whole
 * module exists so that the API cannot hand a broker password back.
 *
 * The XTS test endpoint is exercised against a local stub speaking the real XTS
 * envelope, so the login path that runs here is the same `XtsRestClient` the
 * order gateway trades through, not a mock of it.
 */

import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { seal } from '@algomaker/secrets'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { BROKER_COLLECTION } from '../src/brokerstore.ts'
import { brokerRoutes } from '../src/routes/brokers.ts'
import type { ApiDeps } from '../src/routes/kit.ts'

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_broker_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
const MASTER_KEY = 'b'.repeat(64)
const NOW = Date.UTC(2026, 6, 27, 5, 0)

/** Every one of these must be unfindable in every response body. */
const SECRETS = {
  appKey: 'app-key-3f9c2b1a',
  secretKey: 'secret-key-7d4e8a55',
  uniqueKey: 'unique-key-11223344',
}

let handle: MongoHandle | null = null
let server: Server | null = null
let broker: Server | null = null
let base = ''
let brokerBase = ''
let available = false
/** What the stub XTS host answers `/user/session` with. */
let xtsReply: { status: number; body: unknown } = { status: 200, body: {} }

/**
 * ONLY THE CONNECT IS CAUGHT.
 *
 * `available = false` skips this whole file, and node:test renders a skipped
 * file green. Anything after the connect — the master key being rejected, a
 * route factory throwing, a port that will not bind — is a FAILURE and must
 * read as one; swallowing it turned "the credential module is broken" into a
 * silently passing run of the very tests that exist to prove it is not.
 */
before(async () => {
  process.env['DESK_MASTER_KEY'] = MASTER_KEY
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  const apiDeps = {
    db: handle.db,
    log: () => {},
    now: () => NOW,
  } as unknown as ApiDeps
  server = createBridgeServer({ gate: bearerGate(TOKEN), routes: [brokerRoutes(apiDeps)] })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

  broker = createServer((req, res) => {
    res.writeHead(xtsReply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(xtsReply.body))
  })
  await new Promise<void>((r) => broker!.listen(0, '127.0.0.1', r))
  brokerBase = `http://127.0.0.1:${(broker!.address() as AddressInfo).port}`
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (broker !== null) await new Promise<void>((r) => broker!.close(() => r()))
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  await handle!.db.collection(BROKER_COLLECTION).deleteMany({})
  // The stub's reply is SHARED MUTABLE STATE across every test in this file.
  // Without this reset a test that arms a rejection leaks it into whichever
  // test happens to run next, so what a later test proves depends on the order
  // node:test chose — and the day it changes, a credential test asserts against
  // a broker response nobody in that test wrote.
  xtsReply = { status: 200, body: {} }
})

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, { timeout: 30_000 }, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: auth })
const put = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'PUT', headers: auth, body: JSON.stringify(body) })
const post = (path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })

/**
 * The invariant, asserted on raw text rather than on parsed fields — a secret
 * nested three levels deep in an unexpected key is still a leaked secret.
 */
async function assertNoSecret(res: Response, where: string): Promise<Record<string, unknown>> {
  const text = await res.text()
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `${where} (${res.status}) leaked ${name}: ${text}`)
  }
  return JSON.parse(text) as Record<string, unknown>
}

const xtsConfig = {
  label: 'Composite Edge',
  meta: { baseUrl: '', userId: 'AT1234', prefix: '/interactive' },
  secret: SECRETS,
}

const configured = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...xtsConfig,
  meta: { ...xtsConfig.meta, baseUrl: brokerBase },
  ...over,
})

itMongo('an unconfigured deployment lists every broker as absent', async () => {
  const res = await get('/v1/desk/brokers')
  assert.equal(res.status, 200)
  const body = await assertNoSecret(res, 'GET empty')
  const brokers = body['brokers'] as Record<string, unknown>[]
  assert.deepEqual(brokers.map((b) => b['kind']), ['xts', 'zerodha'])
  for (const b of brokers) {
    assert.equal(b['state'], 'absent')
    assert.equal(b['configured'], false)
    assert.equal(b['lastVerifiedAt'], null)
  }
})

itMongo('PUT stores credentials and the list never returns them', async () => {
  const saved = await put('/v1/desk/brokers/xts', configured())
  assert.deepEqual(await assertNoSecret(saved, 'PUT'), { ok: true, kind: 'xts' })

  const body = await assertNoSecret(await get('/v1/desk/brokers'), 'GET configured')
  const xts = (body['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(xts['configured'], true)
  assert.equal(xts['state'], 'ok')
  assert.equal(xts['label'], 'Composite Edge')
  assert.deepEqual(xts['meta'], { baseUrl: brokerBase, userId: 'AT1234', prefix: '/interactive' })

  // The sealed blob is in Mongo and is not the plaintext.
  const doc = await handle!.db.collection(BROKER_COLLECTION).findOne({ kind: 'xts' })
  const sealed = String((doc as Record<string, unknown>)['secret'])
  assert.match(sealed, /^v1\./)
  assert.ok(!sealed.includes(SECRETS.appKey))
})

itMongo('a credential-shaped key in meta is stripped rather than echoed', async () => {
  // `meta` is the one part of a broker row the API hands back, so an operator
  // (or a form) that puts a password there must not turn it into a response.
  await put('/v1/desk/brokers/xts', {
    ...configured(),
    meta: { baseUrl: brokerBase, secretKey: SECRETS.secretKey, apiToken: 'x', nested: { a: 1 } },
  })
  const body = await assertNoSecret(await get('/v1/desk/brokers'), 'GET with dirty meta')
  const meta = (body['brokers'] as Record<string, unknown>[])[0]?.['meta'] as Record<string, unknown>
  assert.deepEqual(meta, { baseUrl: brokerBase })
})

itMongo('PUT without a secret leaves the stored credential untouched', async () => {
  await put('/v1/desk/brokers/xts', configured())
  const relabel = await put('/v1/desk/brokers/xts', { label: 'Renamed' })
  assert.equal(relabel.status, 200)

  const body = await assertNoSecret(await get('/v1/desk/brokers'), 'GET after relabel')
  const xts = (body['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(xts['label'], 'Renamed')
  assert.equal(
    xts['configured'],
    true,
    'the form cannot display the secret, so a blank submit must not wipe it',
  )

  // And an explicitly empty object is the same "no change", not a wipe.
  await put('/v1/desk/brokers/xts', { label: 'Again', secret: {} })
  const after = await assertNoSecret(await get('/v1/desk/brokers'), 'GET after empty secret')
  assert.equal((after['brokers'] as Record<string, unknown>[])[0]?.['configured'], true)
})

itMongo('UNREADABLE is distinct from ABSENT when the master key no longer opens the row', async () => {
  // Exactly what a rotated DESK_MASTER_KEY leaves behind.
  await handle!.db.collection(BROKER_COLLECTION).insertOne({
    kind: 'zerodha',
    label: 'Kite',
    meta: { userId: 'AB1234' },
    secret: seal(JSON.stringify(SECRETS), Buffer.from('c'.repeat(64), 'hex')),
  })
  const body = await assertNoSecret(await get('/v1/desk/brokers'), 'GET unreadable')
  const zerodha = (body['brokers'] as Record<string, unknown>[])[1] as Record<string, unknown>
  assert.equal(zerodha['state'], 'unreadable')
  assert.notEqual(zerodha['state'], 'absent')
  assert.equal(zerodha['configured'], true)
  assert.match(String(zerodha['lastError']), /DESK_MASTER_KEY/)
  // The account it belongs to still renders, which is the point of `meta`.
  assert.deepEqual(zerodha['meta'], { userId: 'AB1234' })

  const tested = await post('/v1/desk/brokers/zerodha/test')
  assert.equal(tested.status, 200, 'an unopenable row is not a 5xx')
  const result = await assertNoSecret(tested, 'POST test unreadable')
  assert.equal(result['ok'], false)
  assert.match(String(result['error']), /DESK_MASTER_KEY/)
})

itMongo('testing a broker with nothing configured is 200 ok:false, not a 5xx', async () => {
  const res = await post('/v1/desk/brokers/xts/test')
  assert.equal(res.status, 200)
  const body = await assertNoSecret(res, 'POST test absent')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /no xts credentials configured/)
})

itMongo('a REAL XTS login that the broker rejects is 200 ok:false with the broker s own message', async () => {
  xtsReply = { status: 200, body: { type: 'error', code: 'e-user-0001', description: 'Invalid appKey' } }
  await put('/v1/desk/brokers/xts', configured())

  const res = await post('/v1/desk/brokers/xts/test')
  assert.equal(res.status, 200, 'a failed LOGIN is not a failed REQUEST')
  const body = await assertNoSecret(res, 'POST test rejected')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /Invalid appKey/)

  // The verdict is recorded, and the row now reads `error` rather than `ok`.
  const list = await assertNoSecret(await get('/v1/desk/brokers'), 'GET after failure')
  const xts = (list['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(xts['state'], 'error')
  assert.equal(xts['lastVerifiedAt'], null)
  assert.match(String(xts['lastError']), /Invalid appKey/)
})

itMongo('a broker error that echoes the credential back is redacted before it is sent', async () => {
  // XTS does put request values in some descriptions. Forwarding one verbatim
  // would break the invariant through the one field nobody thinks of as ours.
  xtsReply = {
    status: 200,
    body: { type: 'error', description: `rejected payload appKey=${SECRETS.appKey}` },
  }
  await put('/v1/desk/brokers/xts', configured())
  const body = await assertNoSecret(await post('/v1/desk/brokers/xts/test'), 'POST test echoed secret')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /\*\*\*/)
})

itMongo('a successful XTS login records lastVerifiedAt and reports ok', async () => {
  xtsReply = {
    status: 200,
    body: { type: 'success', result: { token: 'session-token', userID: 'AT1234', clientCodes: ['AT1234'] } },
  }
  await put('/v1/desk/brokers/xts', configured())

  const body = await assertNoSecret(await post('/v1/desk/brokers/xts/test'), 'POST test ok')
  assert.equal(body['ok'], true)
  assert.equal(body['verifiedAt'], NOW)

  const list = await assertNoSecret(await get('/v1/desk/brokers'), 'GET after success')
  const xts = (list['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(xts['state'], 'ok')
  assert.equal(xts['lastVerifiedAt'], NOW)
  assert.equal(xts['lastError'], '')
})

itMongo('an XTS host that is unreachable is still 200 ok:false', async () => {
  xtsReply = { status: 200, body: { type: 'success', result: { token: 't', userID: 'u' } } }
  await put('/v1/desk/brokers/xts', {
    ...configured(),
    // Port 1 is reserved and refuses instantly; a DNS name would hang.
    meta: { baseUrl: 'http://127.0.0.1:1', userId: 'AT1234' },
  })
  const body = await assertNoSecret(await post('/v1/desk/brokers/xts/test'), 'POST test unreachable')
  assert.equal(body['ok'], false)
  assert.equal(typeof body['error'], 'string')
})

itMongo('a missing baseUrl is reported rather than attempted', async () => {
  await put('/v1/desk/brokers/xts', { secret: SECRETS })
  const body = await assertNoSecret(await post('/v1/desk/brokers/xts/test'), 'POST test no baseUrl')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /meta\.baseUrl is required/)
})

itMongo('an incomplete Zerodha credential is refused before any login is attempted', async () => {
  await put('/v1/desk/brokers/zerodha', { meta: { userId: 'AB1234' }, secret: { password: 'x' } })
  const body = await assertNoSecret(await post('/v1/desk/brokers/zerodha/test'), 'POST zerodha incomplete')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /totpSecret/)
})

itMongo('an unknown broker kind is a 404, not a new collection row', async () => {
  const res = await put('/v1/desk/brokers/finvasia', { secret: SECRETS })
  assert.equal(res.status, 404)
  await assertNoSecret(res, 'PUT unknown kind')
  assert.equal(await handle!.db.collection(BROKER_COLLECTION).countDocuments({}), 0)
})

itMongo('a malformed PUT body is a 400 and changes nothing', async () => {
  for (const body of [{ label: 5 }, { meta: 'nope' }, { secret: 'nope' }]) {
    const res = await put('/v1/desk/brokers/xts', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    await assertNoSecret(res, 'PUT malformed')
  }
  assert.equal(await handle!.db.collection(BROKER_COLLECTION).countDocuments({}), 0)
})

itMongo('every broker endpoint requires authentication', async () => {
  for (const [path, init] of [
    ['/v1/desk/brokers', {}],
    ['/v1/desk/brokers/xts', { method: 'PUT', body: '{}' }],
    ['/v1/desk/brokers/xts/test', { method: 'POST' }],
  ] as const) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 401, path)
  }
})
