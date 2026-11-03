/**
 * Broker credentials over the wire.
 *
 * The controlling assertion is `assertNoSecret`, applied to the FULL JSON TEXT of
 * every response this module can produce, including the error paths. Checking
 * named fields would pass while a credential travelled inside `meta`, inside a
 * broker's echoed error message, or inside a field added later — and the whole
 * module exists so that the API cannot hand a broker password back.
 *
 * The Delta test endpoint is exercised against a local stub speaking Delta's
 * envelope, so the signed request that runs here is the same `DxRest` the order
 * gateway trades through, not a mock of it — and the stub checks the signature.
 */

import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { seal } from '@algomaker/secrets'
import { DX_DEMO_REST_URL, DX_PROD_REST_URL, isDemoHost, signRequest } from '@algomaker/dx'
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
  apiKey: 'api-key-3f9c2b1a',
  apiSecret: 'api-secret-7d4e8a55',
}

let handle: MongoHandle | null = null
let server: Server | null = null
let broker: Server | null = null
let base = ''
let brokerBase = ''
let available = false
/** What the stub Delta host answers with. */
let dxReply: { status: number; body: unknown } = { status: 200, body: {} }
/** Every request the stub saw, with whether its signature verified. */
let dxSeen: { method: string; url: string; apiKey: string; signed: boolean; userAgent: string }[] = []
/**
 * Every URL the credential test fetched. A testnet URL is answered by the same
 * local stub (rewritten onto it), so the demo test is a real signed request
 * with no network; anything else goes where it says.
 */
let fetched: string[] = []
const routedFetch: typeof fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  fetched.push(url)
  if (isDemoHost(url)) return fetch(url.replace(DX_DEMO_REST_URL, brokerBase), init)
  return fetch(input, init)
}

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
  server = createBridgeServer({ gate: bearerGate(TOKEN), routes: [brokerRoutes(apiDeps, { fetch: routedFetch })] })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

  broker = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const ts = Number(req.headers['timestamp'])
    const expected = signRequest(SECRETS.apiSecret, req.method ?? '', url.pathname, url.search, '', ts)
    dxSeen.push({
      method: req.method ?? '',
      url: url.pathname + url.search,
      apiKey: String(req.headers['api-key'] ?? ''),
      signed: req.headers['signature'] === expected,
      userAgent: String(req.headers['user-agent'] ?? ''),
    })
    res.writeHead(dxReply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(dxReply.body))
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
  dxReply = { status: 200, body: {} }
  dxSeen = []
  fetched = []
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

const dxConfig = {
  label: 'Delta India',
  meta: { baseUrl: '', account: 'desk-1' },
  secret: SECRETS,
}

const configured = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...dxConfig,
  meta: { ...dxConfig.meta, baseUrl: brokerBase },
  ...over,
})

itMongo('an unconfigured deployment lists every broker as absent', async () => {
  const res = await get('/v1/desk/brokers')
  assert.equal(res.status, 200)
  const body = await assertNoSecret(res, 'GET empty')
  const brokers = body['brokers'] as Record<string, unknown>[]
  assert.deepEqual(brokers.map((b) => b['kind']), ['delta', 'zerodha', 'delta-demo'])
  assert.equal(brokers[2]?.['label'], 'Delta Demo (testnet)')
  for (const b of brokers) {
    assert.equal(b['state'], 'absent')
    assert.equal(b['configured'], false)
    assert.equal(b['lastVerifiedAt'], null)
  }
})

itMongo('PUT stores credentials and the list never returns them', async () => {
  const saved = await put('/v1/desk/brokers/delta', configured())
  assert.deepEqual(await assertNoSecret(saved, 'PUT'), { ok: true, kind: 'delta' })

  const body = await assertNoSecret(await get('/v1/desk/brokers'), 'GET configured')
  const row = (body['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(row['configured'], true)
  assert.equal(row['state'], 'ok')
  assert.equal(row['label'], 'Delta India')
  assert.deepEqual(row['meta'], { baseUrl: brokerBase, account: 'desk-1' })

  // The sealed blob is in Mongo and is not the plaintext.
  const doc = await handle!.db.collection(BROKER_COLLECTION).findOne({ kind: 'delta' })
  const sealed = String((doc as Record<string, unknown>)['secret'])
  assert.match(sealed, /^v1\./)
  assert.ok(!sealed.includes(SECRETS.apiKey))
  assert.ok(!sealed.includes(SECRETS.apiSecret))
})

itMongo('a credential-shaped key in meta is stripped rather than echoed', async () => {
  // `meta` is the one part of a broker row the API hands back, so an operator
  // (or a form) that puts a password there must not turn it into a response.
  await put('/v1/desk/brokers/delta', {
    ...configured(),
    meta: { baseUrl: brokerBase, apiSecret: SECRETS.apiSecret, apiToken: 'x', nested: { a: 1 } },
  })
  const body = await assertNoSecret(await get('/v1/desk/brokers'), 'GET with dirty meta')
  const meta = (body['brokers'] as Record<string, unknown>[])[0]?.['meta'] as Record<string, unknown>
  assert.deepEqual(meta, { baseUrl: brokerBase })
})

itMongo('PUT without a secret leaves the stored credential untouched', async () => {
  await put('/v1/desk/brokers/delta', configured())
  const relabel = await put('/v1/desk/brokers/delta', { label: 'Renamed' })
  assert.equal(relabel.status, 200)

  const body = await assertNoSecret(await get('/v1/desk/brokers'), 'GET after relabel')
  const row = (body['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(row['label'], 'Renamed')
  assert.equal(
    row['configured'],
    true,
    'the form cannot display the secret, so a blank submit must not wipe it',
  )

  // And an explicitly empty object is the same "no change", not a wipe.
  await put('/v1/desk/brokers/delta', { label: 'Again', secret: {} })
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
  const res = await post('/v1/desk/brokers/delta/test')
  assert.equal(res.status, 200)
  const body = await assertNoSecret(res, 'POST test absent')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /no delta credentials configured/)
})

itMongo('Test is a SIGNED wallet read; a key Delta rejects is 200 ok:false with Delta s own code', async () => {
  dxReply = { status: 401, body: { success: false, error: { code: 'invalid_api_key' } } }
  await put('/v1/desk/brokers/delta', configured())

  const res = await post('/v1/desk/brokers/delta/test')
  assert.equal(res.status, 200, 'a refused KEY is not a failed REQUEST')
  const body = await assertNoSecret(res, 'POST test rejected')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /invalid_api_key/)
  assert.equal(dxSeen.length, 1)
  assert.deepEqual(
    { method: dxSeen[0]?.method, url: dxSeen[0]?.url, apiKey: dxSeen[0]?.apiKey, signed: dxSeen[0]?.signed },
    { method: 'GET', url: '/v2/wallet/balances', apiKey: SECRETS.apiKey, signed: true },
  )
  assert.notEqual(dxSeen[0]?.userAgent, '', 'Delta refuses a request with no User-Agent')

  const list = await assertNoSecret(await get('/v1/desk/brokers'), 'GET after failure')
  const row = (list['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(row['state'], 'error')
  assert.equal(row['lastVerifiedAt'], null)
  assert.match(String(row['lastError']), /invalid_api_key/)
})

itMongo('a Delta error that echoes the credential back is redacted before it is sent', async () => {
  dxReply = { status: 400, body: { success: false, error: { code: 'bad_request', message: `key ${SECRETS.apiKey} refused` } } }
  await put('/v1/desk/brokers/delta', configured())
  const body = await assertNoSecret(await post('/v1/desk/brokers/delta/test'), 'POST test echoed secret')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /\*\*\*/)
})

itMongo('a successful signed wallet read records lastVerifiedAt and reports the balances seen', async () => {
  dxReply = {
    status: 200,
    body: { success: true, result: [{ asset_symbol: 'USD', balance: '1250.5', available_balance: '1200' }] },
  }
  await put('/v1/desk/brokers/delta', configured())

  const body = await assertNoSecret(await post('/v1/desk/brokers/delta/test'), 'POST test ok')
  assert.equal(body['ok'], true)
  assert.equal(body['verifiedAt'], NOW)
  assert.match(String(body['note']), /USD 1250\.5/)
  assert.equal(dxSeen[0]?.signed, true)

  const list = await assertNoSecret(await get('/v1/desk/brokers'), 'GET after success')
  const row = (list['brokers'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(row['state'], 'ok')
  assert.equal(row['lastVerifiedAt'], NOW)
  assert.equal(row['lastError'], '')
})

itMongo('a Delta host that is unreachable is still 200 ok:false', async () => {
  await put('/v1/desk/brokers/delta', {
    ...configured(),
    // Port 1 is reserved and refuses instantly; a DNS name would hang.
    meta: { baseUrl: 'http://127.0.0.1:1' },
  })
  const body = await assertNoSecret(await post('/v1/desk/brokers/delta/test'), 'POST test unreachable')
  assert.equal(body['ok'], false)
  assert.equal(typeof body['error'], 'string')
})

itMongo('a missing baseUrl is reported rather than attempted — the India host is never assumed in a test', async () => {
  await put('/v1/desk/brokers/delta', { secret: SECRETS })
  const body = await assertNoSecret(await post('/v1/desk/brokers/delta/test'), 'POST test no baseUrl')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /meta\.baseUrl is required/)
  assert.equal(dxSeen.length, 0)
})

// ------------------------------------------------------------ delta-demo

itMongo('delta-demo is stored sealed like delta and never returned', async () => {
  await put('/v1/desk/brokers/delta-demo', { secret: SECRETS })
  const list = await assertNoSecret(await get('/v1/desk/brokers'), 'GET demo stored')
  const row = (list['brokers'] as Record<string, unknown>[]).find((b) => b['kind'] === 'delta-demo')
  assert.equal(row?.['configured'], true)
  assert.equal(row?.['state'], 'ok')
  const doc = await handle!.db.collection(BROKER_COLLECTION).findOne({ kind: 'delta-demo' })
  assert.equal(typeof doc?.['secret'], 'string')
  assert.equal(JSON.stringify(doc).includes(SECRETS.apiSecret), false)
})

itMongo('delta-demo Test is a signed wallet read against the TESTNET by default', async () => {
  dxReply = { status: 200, body: { success: true, result: [{ asset_symbol: 'USD', balance: '10000' }] } }
  await put('/v1/desk/brokers/delta-demo', { secret: SECRETS })
  const body = await assertNoSecret(await post('/v1/desk/brokers/delta-demo/test'), 'POST demo test')
  assert.equal(body['ok'], true, JSON.stringify(body))
  assert.match(String(body['note']), /testnet/)
  assert.deepEqual(fetched, [`${DX_DEMO_REST_URL}/v2/wallet/balances`])
  assert.equal(dxSeen[0]?.signed, true)
  assert.equal(dxSeen[0]?.apiKey, SECRETS.apiKey)
})

itMongo('demo credentials are refused for the production host, before any request', async () => {
  await put('/v1/desk/brokers/delta-demo', { meta: { baseUrl: DX_PROD_REST_URL }, secret: SECRETS })
  const body = await assertNoSecret(await post('/v1/desk/brokers/delta-demo/test'), 'POST demo prod host')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /demo credentials may only be sent to the testnet/)
  assert.deepEqual(fetched, [])
  // A local host is not testnet either: the demo rail is an allowlist.
  await put('/v1/desk/brokers/delta-demo', { meta: { baseUrl: brokerBase } })
  const local = await assertNoSecret(await post('/v1/desk/brokers/delta-demo/test'), 'POST demo local host')
  assert.equal(local['ok'], false)
  assert.deepEqual(fetched, [])
  assert.equal(dxSeen.length, 0)
})

itMongo('production credentials are refused for the testnet host, before any request', async () => {
  await put('/v1/desk/brokers/delta', { meta: { baseUrl: DX_DEMO_REST_URL }, secret: SECRETS })
  const body = await assertNoSecret(await post('/v1/desk/brokers/delta/test'), 'POST delta testnet host')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /production credentials must never be sent to the testnet/)
  assert.deepEqual(fetched, [])
  assert.equal(dxSeen.length, 0)
})

itMongo('an incomplete Delta credential is refused before any request is signed', async () => {
  await put('/v1/desk/brokers/delta', { meta: { baseUrl: brokerBase }, secret: { apiKey: 'k' } })
  const body = await assertNoSecret(await post('/v1/desk/brokers/delta/test'), 'POST test no secret')
  assert.equal(body['ok'], false)
  assert.match(String(body['error']), /secret\.apiKey and secret\.apiSecret are required/)
  assert.equal(dxSeen.length, 0)
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
    const res = await put('/v1/desk/brokers/delta', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    await assertNoSecret(res, 'PUT malformed')
  }
  assert.equal(await handle!.db.collection(BROKER_COLLECTION).countDocuments({}), 0)
})

itMongo('every broker endpoint requires authentication', async () => {
  for (const [path, init] of [
    ['/v1/desk/brokers', {}],
    ['/v1/desk/brokers/delta', { method: 'PUT', body: '{}' }],
    ['/v1/desk/brokers/delta/test', { method: 'POST' }],
  ] as const) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 401, path)
  }
})
