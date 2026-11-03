import { test } from 'node:test'
import assert from 'node:assert/strict'
import { XtsRestClient, createXtsRestSession } from '../src/xts-rest.ts'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** Records every request so the wire format is assertable without a broker. */
function fakeFetch(responses: unknown[], status = 200): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const body = responses.shift() ?? { type: 'success', result: {} }
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const LOGIN_OK = { type: 'success', result: { token: 'tok-123', userID: 'BCM757' } }

const opts = (fn: typeof fetch, over: Record<string, unknown> = {}) => ({
  baseUrl: 'https://xts.example.com',
  appKey: 'APPKEY',
  secretKey: 'SECRET',
  fetchImpl: fn,
  ...over,
})

test('login POSTs to /interactive/user/session and keeps the token', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK])
  const c = new XtsRestClient(opts(fn))
  const r = await c.login()
  assert.equal(r.token, 'tok-123')
  assert.equal(calls[0]?.url, 'https://xts.example.com/interactive/user/session')
  assert.equal(calls[0]?.method, 'POST')
  assert.deepEqual(calls[0]?.body, { appKey: 'APPKEY', secretKey: 'SECRET', source: 'WEBAPI' })
})

test('uniqueKey is OMITTED entirely when the broker issues none', async () => {
  // Sending an empty one is rejected, so absent must mean absent.
  const { fn, calls } = fakeFetch([LOGIN_OK])
  await new XtsRestClient(opts(fn)).login()
  assert.equal('uniqueKey' in (calls[0]?.body as object), false)

  const { fn: fn2, calls: calls2 } = fakeFetch([LOGIN_OK])
  await new XtsRestClient(opts(fn2, { uniqueKey: 'UK1' })).login()
  assert.equal((calls2[0]?.body as { uniqueKey?: string }).uniqueKey, 'UK1')
})

test('the token goes in a BARE Authorization header, not Bearer', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: { AppOrderID: 5 } }])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  await c.placeOrder({
    clientID: 'BCM757', exchangeSegment: 'NSEFO', exchangeInstrumentID: 1, productType: 'NRML',
    orderType: 'Market', orderSide: 'SELL', timeInForce: 'DAY', disclosedQuantity: 0,
    limitPrice: 0, stopPrice: 0, orderQuantity: 13125, orderUniqueIdentifier: 'T|ord-1',
  })
  assert.equal(calls[1]?.headers['authorization'], 'tok-123')
  assert.ok(!String(calls[1]?.headers['authorization']).startsWith('Bearer'))
})

test('a stored token is REUSED — no login call', async () => {
  // XTS invalidates the previous session on each login, so logging in on every
  // boot would kill the session a sibling process is trading on.
  const { fn, calls } = fakeFetch([{ type: 'success', result: {} }])
  const s = createXtsRestSession(opts(fn, { existingToken: 'stored-tok' }))
  assert.equal(s.client.hasToken, true)
  await s.ensureSession()
  assert.equal(calls.length, 0, 'no login should have been issued')
})

test('ensureSession logs in only when there is no token', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK])
  const s = createXtsRestSession(opts(fn))
  await s.ensureSession()
  assert.equal(calls.length, 1)
  await s.ensureSession()
  assert.equal(calls.length, 1, 'the second call must be a no-op')
})

test('onToken fires so the caller can persist it', async () => {
  const { fn } = fakeFetch([LOGIN_OK])
  const seen: string[] = []
  await new XtsRestClient(opts(fn, { onToken: (t: string) => seen.push(t) })).login()
  assert.deepEqual(seen, ['tok-123'])
})

test('host lookup redirects the base URL and supplies the uniqueKey', async () => {
  const { fn, calls } = fakeFetch([
    { result: { connectionString: 'https://real.broker.com/', uniqueKey: 'UK-FROM-LOOKUP' } },
    LOGIN_OK,
  ])
  const c = new XtsRestClient(opts(fn, { hostLookupUrl: 'https://lookup.example.com/lookup' }))
  await c.login()
  assert.equal(calls[0]?.url, 'https://lookup.example.com/lookup')
  assert.equal(calls[1]?.url, 'https://real.broker.com/interactive/user/session', 'base was redirected')
  assert.equal((calls[1]?.body as { uniqueKey?: string }).uniqueKey, 'UK-FROM-LOOKUP')
})

test('place/modify/cancel/orderbook/positions hit the documented paths', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK, {}, {}, {}, {}, {}])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  await c.placeOrder({} as never)
  await c.modifyOrder({ appOrderID: '9' })
  await c.cancelOrder({ appOrderID: '9' })
  await c.getOrderBook()
  await c.getPosition({ dayOrNet: 'NetWise' })

  assert.equal(calls[1]?.method, 'POST')
  assert.match(calls[1]?.url ?? '', /\/interactive\/orders$/)
  assert.equal(calls[2]?.method, 'PUT')
  assert.equal(calls[3]?.method, 'DELETE')
  assert.match(calls[3]?.url ?? '', /appOrderID=9/)
  assert.equal(calls[4]?.method, 'GET')
  assert.match(calls[5]?.url ?? '', /\/portfolio\/positions\?dayOrNet=NetWise/)
})

test('a broker error keeps its description instead of collapsing to a status code', async () => {
  const { fn } = fakeFetch([LOGIN_OK, { type: 'error', description: 'e-session-0005 expired' }])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  const r = await c.placeOrder({} as never)
  assert.equal(r.type, 'error')
  assert.match(r.error?.message ?? '', /e-session-0005/)
})

test('a non-JSON body is surfaced verbatim, not as a parse error', async () => {
  // An HTML error page or proxy timeout is itself the diagnosis; "unexpected
  // token < in JSON" tells you nothing.
  const { fn } = fakeFetch(['<html>502 Bad Gateway</html>'], 502)
  const c = new XtsRestClient(opts(fn))
  const r = await c.placeOrder({} as never)
  assert.equal(r.type, 'error')
  assert.match(r.error?.message ?? '', /502 Bad Gateway/)
})

test('a failed login THROWS — an adapter with no session cannot do anything', async () => {
  const { fn } = fakeFetch([{ type: 'error', description: 'bad credentials' }])
  await assert.rejects(() => new XtsRestClient(opts(fn)).login(), /bad credentials/)
})

test('a login returning no token throws rather than half-succeeding', async () => {
  const { fn } = fakeFetch([{ type: 'success', result: { userID: 'X' } }])
  await assert.rejects(() => new XtsRestClient(opts(fn)).login(), /no token/)
})

test('clientCodes falls back to the userID, as the production login does', async () => {
  const { fn } = fakeFetch([LOGIN_OK])
  const c = new XtsRestClient(opts(fn))
  const r = await c.login()
  assert.deepEqual(r.clientCodes, ['BCM757'])
})

test('the prefix is configurable — deployments mount XTS differently', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK])
  await new XtsRestClient(opts(fn, { prefix: '/1interactive' })).login()
  assert.match(calls[0]?.url ?? '', /\/1interactive\/user\/session$/)
})

// ------------------------------------------------- the dealer client code

/**
 * G5. The client code was ONLY ever derived: `login -> result.clientCodes[] ??
 * userID -> #clientCodes[0] -> every order`. There was no env var, nothing in
 * the broker store, nothing in the portal. On a DEALER account the login
 * response need not carry the right code, and an order under the wrong
 * `clientID` is rejected — or routed to somebody else's account.
 */
test('a configured clientId OVERRIDES the login-derived code', async () => {
  const { fn } = fakeFetch([LOGIN_OK])
  const c = new XtsRestClient(opts(fn, { clientId: '*****' }))
  await c.login()
  assert.deepEqual(c.clientCodes, ['*****'], 'the configured code wins')
  assert.deepEqual(c.loginClientCodes, ['BCM757'], 'what the login said is still visible')
})

test('with nothing configured the derived code is still the default', async () => {
  const { fn } = fakeFetch([LOGIN_OK])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  assert.deepEqual(c.clientCodes, ['BCM757'])
})

test('the override is an OVERRIDE, not a fallback — it wins over a real clientCodes', async () => {
  // A fallback would be untestable from the outside: you could not tell by
  // reading the config which code the order actually went out with.
  const { fn } = fakeFetch([
    { type: 'success', result: { token: 't', userID: 'BCM757', clientCodes: ['FROMLOGIN'] } },
  ])
  const c = new XtsRestClient(opts(fn, { clientId: 'DEALER01' }))
  await c.login()
  assert.deepEqual(c.clientCodes, ['DEALER01'])
})

test("isInvestorClient is derived exactly as the legacy account model derives it", async () => {
  // common/models/xts-account.js:70-74. The '*****' literal is the operator's
  // own dealer client code and is compared as a literal there and here.
  const investor = async (over: Record<string, unknown>) => {
    const { fn } = fakeFetch([LOGIN_OK])
    const c = new XtsRestClient(opts(fn, over))
    await c.login()
    return c.isInvestorClient
  }
  assert.equal(await investor({}), true, 'no code configured -> investor')
  assert.equal(await investor({ clientId: 'BCM757' }), true, 'code === username -> investor')
  assert.equal(await investor({ clientId: '*****' }), false, 'the dealer literal')
  assert.equal(await investor({ clientId: 'OTHER' }), false, 'code !== username -> dealer')
  // An explicit setting still wins, for an account the derivation gets wrong.
  assert.equal(await investor({ clientId: '*****', investorClient: true }), true)
})

test('a DEALER reads the dealer order book, not the investor one', async () => {
  // xts-account.js:499/:601 branch on this and the port dropped it entirely
  // (`grep -rn isInvestorClient packages/brokers` returned nothing). A dealer
  // calling /orders gets the wrong data or none — which is how an order fills
  // at the broker while reconciliation concludes nothing happened.
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: [] }])
  const c = new XtsRestClient(opts(fn, { clientId: '*****' }))
  await c.login()
  await c.getOrderBook()
  assert.equal(
    calls[1]?.url,
    'https://xts.example.com/interactive/orders/dealerorderbook?clientID=*****',
  )
})

test('an INVESTOR still reads /orders', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: [] }])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  await c.getOrderBook()
  assert.equal(calls[1]?.url, 'https://xts.example.com/interactive/orders?clientID=BCM757')
})

test('a DEALER reads /portfolio/dealerpositions', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: { positionList: [] } }])
  const c = new XtsRestClient(opts(fn, { clientId: '*****' }))
  await c.login()
  await c.getPosition({ dayOrNet: 'NetWise' })
  assert.equal(
    calls[1]?.url,
    'https://xts.example.com/interactive/portfolio/dealerpositions?dayOrNet=NetWise&clientID=*****',
  )
})

test('an INVESTOR reads /portfolio/positions', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: { positionList: [] } }])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  await c.getPosition({ dayOrNet: 'DayWise' })
  assert.equal(
    calls[1]?.url,
    'https://xts.example.com/interactive/portfolio/positions?dayOrNet=DayWise&clientID=BCM757',
  )
})

test('a cancel goes out under the configured code too', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: {} }])
  const c = new XtsRestClient(opts(fn, { clientId: 'DEALER01' }))
  await c.login()
  await c.cancelOrder({ appOrderID: '987' })
  assert.match(calls[1]?.url ?? '', /clientID=DEALER01/)
})

test('a modify goes out under the session code when the body carries none', async () => {
  // The same `e-orders-0002 ClientID cannot be empty` the cancel learned from,
  // on the same DEALER account. `XtsAdapter.modifyOrder` sources the client
  // from the order's own row and omits it when the row has none; the session's
  // code is the second line of defence so the failure never reaches the wire.
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: {} }])
  const c = new XtsRestClient(opts(fn, { clientId: 'DEALER01' }))
  await c.login()
  await c.modifyOrder({ appOrderID: '987', modifiedLimitPrice: 15 })
  assert.equal(calls[1]?.method, 'PUT')
  assert.deepEqual(calls[1]?.body, {
    appOrderID: '987',
    modifiedLimitPrice: 15,
    clientID: 'DEALER01',
  })
})

test("the body's own clientID WINS over the session's", async () => {
  // A multi-client dealer login must modify each order against the client it
  // was placed for, which is the one on the order's row — not the one the
  // session happens to be configured with.
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: {} }])
  const c = new XtsRestClient(opts(fn, { clientId: 'DEALER01' }))
  await c.login()
  await c.modifyOrder({ appOrderID: '987', clientID: 'FROMROW' })
  assert.equal((calls[1]?.body as { clientID: string }).clientID, 'FROMROW')
})

test('the full modified* set passes through the transport untouched', async () => {
  // The transport injects a client and changes NOTHING else: the adapter built
  // this body off the broker's own row and every field in it is load-bearing.
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: {} }])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  const req = {
    appOrderID: 987654,
    modifiedProductType: 'NRML',
    modifiedOrderType: 'Limit',
    modifiedOrderQuantity: 13125,
    modifiedDisclosedQuantity: 0,
    modifiedLimitPrice: 15.2,
    modifiedStopPrice: 0,
    modifiedTimeInForce: 'DAY',
    orderUniqueIdentifier: 'DESK_BHEL|ord-1',
    clientID: 'DEALER01',
  }
  await c.modifyOrder(req)
  assert.deepEqual(calls[1]?.body, req)
})

test('a DEALER reads the dealer TRADE book', async () => {
  // Same split as the order book, same failure if it is dropped: a dealer on
  // the investor route reads the wrong data or none, and an empty trade book
  // is indistinguishable from "nothing filled".
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: [] }])
  const c = new XtsRestClient(opts(fn, { clientId: '*****' }))
  await c.login()
  await c.getTradeBook()
  assert.equal(
    calls[1]?.url,
    'https://xts.example.com/interactive/orders/dealertradebook?clientID=*****',
  )
})

test('an INVESTOR reads /orders/trades', async () => {
  const { fn, calls } = fakeFetch([LOGIN_OK, { type: 'success', result: [] }])
  const c = new XtsRestClient(opts(fn))
  await c.login()
  await c.getTradeBook()
  assert.equal(calls[1]?.url, 'https://xts.example.com/interactive/orders/trades?clientID=BCM757')
})
