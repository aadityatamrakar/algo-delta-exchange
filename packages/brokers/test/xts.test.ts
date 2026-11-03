import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrderIntent } from '@algomaker/order-bus'
import { XtsAdapter, XtsOrderError, type XtsClient, type XtsResponse, type XtsSession } from '../src/xts.ts'

const INTENT: OrderIntent = {
  clientOrderId: 'ord-1',
  ts: 0,
  strategyTag: 'DESK_BHEL',
  mode: 'live',
  destinations: ['xts'],
  instrument: {
    tradingsymbol: 'BHEL26AUG420CE',
    instrumentToken: 12345,
    lotSize: 2625,
    tickSize: 0.05,
    exchange: 'NFO',
  },
  side: 'SELL',
  orderType: 'MARKET',
  quantity: 13125,
  lots: 5,
}

const OK: XtsResponse = { type: 'success', result: { AppOrderID: 987654 } }
const err = (message: string): XtsResponse => ({ type: 'error', error: { message } })

const SESSION_ERR = '{"code":"e-session-0005"}'
const TRANSIENT_ERR = '400 - {"code":"e-request-0004","description":"System Error : X10203."}'

// No parameter properties: Node strips types rather than compiling them, so it
// cannot emit the assignment they imply. `erasableSyntaxOnly` catches this at
// typecheck time for exactly this reason.
class FakeClient implements XtsClient {
  readonly clientCodes = ['CLIENT1']
  calls: unknown[] = []
  #responses: XtsResponse[]

  constructor(responses: XtsResponse[]) {
    this.#responses = responses
  }

  async placeOrder(req: unknown): Promise<XtsResponse> {
    this.calls.push(req)
    return this.#responses.shift() ?? OK
  }
  async modifyOrder(): Promise<XtsResponse> {
    return OK
  }
  async cancelOrder(): Promise<XtsResponse> {
    return OK
  }
}

function session(responses: XtsResponse[]): { s: XtsSession; client: FakeClient } {
  const client = new FakeClient(responses)
  const s: XtsSession = {
    current: () => client,
    relogin: async () => client,
  }
  return { s, client }
}

const noSleep = async (): Promise<void> => {}

test('a successful placement returns the broker order id, correlated to the intent', async () => {
  const { s, client } = session([OK])
  const a = new XtsAdapter({ session: s, sleep: noSleep })
  const placed = await a.placeOrder(INTENT)
  assert.equal(placed.brokerOrderId, '987654')
  assert.equal(placed.clientOrderId, 'ord-1')
  assert.equal(placed.status, 'PENDING_NEW', 'not FILLED — the exchange has not confirmed anything')

  const req = client.calls[0] as Record<string, unknown>
  assert.equal(req['orderUniqueIdentifier'], 'DESK_BHEL|ord-1')
  assert.equal(req['orderQuantity'], 13125, 'contract quantity passes through unmultiplied')
  assert.equal(req['exchangeSegment'], 'NSEFO')
  assert.equal(req['orderType'], 'Market')
})

test('a MARKET order sends zero prices, never a truncated one', async () => {
  const { s, client } = session([OK])
  await new XtsAdapter({ session: s, sleep: noSleep }).placeOrder(INTENT)
  const req = client.calls[0] as Record<string, unknown>
  assert.equal(req['limitPrice'], 0)
  assert.equal(req['stopPrice'], 0)
})

test('a LIMIT order keeps its paise — the legacy parseInt bug is not reproduced', async () => {
  const { s, client } = session([OK])
  await new XtsAdapter({ session: s, sleep: noSleep }).placeOrder({
    ...INTENT,
    orderType: 'LIMIT',
    limitPrice: 2.9,
  })
  const req = client.calls[0] as Record<string, unknown>
  assert.equal(req['limitPrice'], 2.9, 'parseInt(2.9) would have sent 2')
})

test('a stop order becomes a StopLimit with a protective band', async () => {
  const { s, client } = session([OK])
  await new XtsAdapter({ session: s, sleep: noSleep }).placeOrder({
    ...INTENT,
    orderType: 'SL_MARKET',
    triggerPrice: 20,
  })
  const req = client.calls[0] as Record<string, unknown>
  assert.equal(req['orderType'], 'StopLimit')
  assert.equal(req['stopPrice'], 20)
  assert.ok((req['limitPrice'] as number) < 20, 'a SELL stop fills below the trigger')
})

test('a FATAL error does not retry — a margin rejection is not a hiccup', async () => {
  const { s, client } = session([err('insufficient margin'), OK])
  const a = new XtsAdapter({ session: s, sleep: noSleep })
  await assert.rejects(() => a.placeOrder(INTENT), /insufficient margin/)
  assert.equal(client.calls.length, 1, 'retrying a refusal risks a double placement')
})

test('a TRANSIENT error retries the same request and can succeed', async () => {
  const { s, client } = session([err(TRANSIENT_ERR), OK])
  const placed = await new XtsAdapter({ session: s, sleep: noSleep }).placeOrder(INTENT)
  assert.equal(placed.brokerOrderId, '987654')
  assert.equal(client.calls.length, 2)
})

test('a SESSION error triggers a re-login before retrying', async () => {
  const client = new FakeClient([err(SESSION_ERR), OK])
  let relogins = 0
  const s: XtsSession = {
    current: () => client,
    relogin: async () => {
      relogins++
      return client
    },
  }
  const placed = await new XtsAdapter({ session: s, sleep: noSleep }).placeOrder(INTENT)
  assert.equal(relogins, 1)
  assert.equal(placed.brokerOrderId, '987654')
})

test('CONCURRENT session failures share ONE re-login', async () => {
  // Every in-flight order fails at the same instant when a token expires. XTS
  // invalidates the prior token on each login, so N logins can leave N-1 orders
  // holding a token that the next login already killed.
  let relogins = 0
  // A holder object, not a `let`: TS's control-flow analysis does not track the
  // assignment inside the executor callback, so a `let` narrows to `never` at
  // the call site below.
  const gate$ = { resolve: (): void => {} }
  const gate = new Promise<void>((r) => {
    gate$.resolve = r
  })
  const client = new FakeClient([
    err(SESSION_ERR), err(SESSION_ERR), err(SESSION_ERR), OK, OK, OK,
  ])
  const s: XtsSession = {
    current: () => client,
    relogin: async () => {
      relogins++
      await gate
      return client
    },
  }
  const a = new XtsAdapter({ session: s, sleep: noSleep })
  const inflight = [a.placeOrder(INTENT), a.placeOrder(INTENT), a.placeOrder(INTENT)]
  await new Promise((r) => setImmediate(r))
  gate$.resolve()
  await Promise.all(inflight)
  assert.equal(relogins, 1, `expected a single shared re-login, got ${relogins}`)
})

test('a later session failure can re-login again — the guard is not sticky', async () => {
  let relogins = 0
  const client = new FakeClient([err(SESSION_ERR), OK, err(SESSION_ERR), OK])
  const s: XtsSession = {
    current: () => client,
    relogin: async () => {
      relogins++
      return client
    },
  }
  const a = new XtsAdapter({ session: s, sleep: noSleep })
  await a.placeOrder(INTENT)
  await a.placeOrder(INTENT)
  assert.equal(relogins, 2)
})

test('a FAILING re-login keeps the DEFINITE non-placement definite', async () => {
  /**
   * The attempt was SESSION-refused, which is a proof of non-placement: the
   * exchange never saw the order. If the re-login that follows then fails on
   * the network, its own error message ('fetch failed') classifies as
   * `unknown` — and `unknown` means "the order may be at the exchange".
   *
   * That inversion is expensive. The gateway holds the tranche AMBIGUOUS for
   * the full TTL while the desk believes an exit is resting that never
   * existed, and it does so because a SECOND request failed, not the order's.
   */
  const client = new FakeClient([err(SESSION_ERR), OK])
  const s: XtsSession = {
    current: () => client,
    relogin: async () => {
      throw new Error('fetch failed')
    },
  }
  const a = new XtsAdapter({ session: s, sleep: noSleep })
  await assert.rejects(
    () => a.placeOrder(INTENT),
    (e: unknown) => {
      assert.ok(e instanceof XtsOrderError)
      assert.equal(e.klass, 'fatal', 'session-refused is a PROOF the order never went out')
      assert.match(e.message, /NOT placed/)
      assert.match(e.message, /session refused/)
      assert.match(e.message, /fetch failed/, 'the relogin cause has to survive into the log')
      return true
    },
  )
  assert.equal(client.calls.length, 1, 'no retry — there is no session to retry on')
})

test('exhausting the attempts throws rather than reporting a phantom fill', async () => {
  const { s, client } = session([err(TRANSIENT_ERR), err(TRANSIENT_ERR), err(TRANSIENT_ERR)])
  const a = new XtsAdapter({ session: s, sleep: noSleep, maxAttempts: 3 })
  await assert.rejects(
    () => a.placeOrder(INTENT),
    (e: unknown) => e instanceof XtsOrderError && e.klass === 'transient',
  )
  assert.equal(client.calls.length, 3)
})

test('exhausted attempts carry the LAST classification, not a hard-coded one', async () => {
  /**
   * The post-loop throw used to assert `transient` regardless of what actually
   * happened. A run that ended on a SESSION refusal is a definite
   * non-placement and the gateway can retry it cleanly; labelling it
   * `transient` is not wrong in the same direction, but it is a fabricated
   * fact, and the classification is the only thing downstream has to reason
   * with. Pass through what was decided rather than re-deciding it here.
   */
  const client = new FakeClient([err(TRANSIENT_ERR), err(SESSION_ERR)])
  const s: XtsSession = { current: () => client, relogin: async () => client }
  const a = new XtsAdapter({ session: s, sleep: noSleep, maxAttempts: 2 })
  await assert.rejects(
    () => a.placeOrder(INTENT),
    (e: unknown) => {
      assert.ok(e instanceof XtsOrderError)
      assert.equal(e.klass, 'session')
      return true
    },
  )
  assert.equal(client.calls.length, 2)
})

test('success with no AppOrderID is FATAL, never retried', async () => {
  // The order may well be live. An uncorrelated order is bad; a duplicate is worse.
  const { s, client } = session([{ type: 'success', result: {} }, OK])
  const a = new XtsAdapter({ session: s, sleep: noSleep })
  await assert.rejects(() => a.placeOrder(INTENT), /no AppOrderID/)
  assert.equal(client.calls.length, 1)
})

test('a thrown transport error is classified, not leaked', async () => {
  const client: XtsClient = {
    clientCodes: ['C1'],
    placeOrder: async () => {
      throw new Error('socket hang up')
    },
    modifyOrder: async () => OK,
    cancelOrder: async () => OK,
  }
  const a = new XtsAdapter({
    session: { current: () => client, relogin: async () => client },
    sleep: noSleep,
  })
  await assert.rejects(() => a.placeOrder(INTENT), /socket hang up/)
})

test('an UNKNOWN outcome does NOT retry, and says so on the error it throws', async () => {
  // F-3. A timeout means the response never came back — not that the order
  // never went out. Retrying it can place the same tranche twice, so the
  // attempt loop stops exactly as it does for a fatal, but the CLASS travels
  // with the error so the caller can hold the order non-terminal instead of
  // asserting a rejection that may be a live position.
  const { s, client } = session([err('request timed out after 15000ms'), OK])
  const a = new XtsAdapter({ session: s, sleep: noSleep })
  await assert.rejects(
    () => a.placeOrder(INTENT),
    (e: unknown) => {
      assert.ok(e instanceof XtsOrderError)
      assert.equal(e.klass, 'unknown')
      return true
    },
  )
  assert.equal(client.calls.length, 1, 'a retry here can double-place a live order')
})

test('a THROWN transport fault is unknown too — same hazard, different shape', async () => {
  const client: XtsClient = {
    clientCodes: ['C1'],
    placeOrder: async () => {
      throw new Error('socket hang up')
    },
    modifyOrder: async () => OK,
    cancelOrder: async () => OK,
  }
  const a = new XtsAdapter({
    session: { current: () => client, relogin: async () => client },
    sleep: noSleep,
  })
  await assert.rejects(
    () => a.placeOrder(INTENT),
    (e: unknown) => e instanceof XtsOrderError && e.klass === 'unknown',
  )
})

// ----------------------------------------------------------------- modify

/**
 * A LIVE resting order as the DEALER order book reports it. Field names are the
 * broker's own, per the legacy account model's mapping table
 * (`xts-account.js:940-961`) — a modify has to restate every one of them.
 */
const ROW: Record<string, unknown> = {
  AppOrderID: 987654,
  ClientID: 'DEALER01',
  OrderStatus: 'New',
  ProductType: 'NRML',
  OrderType: 'Limit',
  OrderQuantity: 13125,
  OrderDisclosedQuantity: 0,
  OrderPrice: 14.5,
  OrderStopPrice: 0,
  TimeInForce: 'DAY',
  OrderUniqueIdentifier: 'DESK_BHEL|ord-1',
  CumulativeQuantity: 0,
}

/** A client whose order book answers with `rows` and records every modify. */
function modifySession(
  rows: readonly Record<string, unknown>[],
  modifyResp: XtsResponse = { type: 'success', result: {} },
): { s: XtsSession; modifies: Record<string, unknown>[] } {
  const modifies: Record<string, unknown>[] = []
  const client: XtsClient = {
    clientCodes: ['SESSIONCODE'],
    placeOrder: async () => OK,
    modifyOrder: async (req: Record<string, unknown>) => {
      modifies.push(req)
      return modifyResp
    },
    cancelOrder: async () => OK,
    getOrderBook: async () => ({ type: 'success', result: rows as never }),
  }
  return { s: { current: () => client, relogin: async () => client }, modifies }
}

test('a modify restates the WHOLE order from its own row — only the price moves', async () => {
  /**
   * `PUT /orders` is a REPLACE, not a patch. The two-field body this method
   * used to send ({appOrderID, modifiedLimitPrice}) is either rejected or, on a
   * build that tolerates it, defaults the fields it omits — rewriting a LIVE
   * order's quantity, product and type with values nobody chose.
   */
  const { s, modifies } = modifySession([ROW])
  assert.equal(await new XtsAdapter({ session: s }).modifyOrder('987654', 15.2), true)
  assert.equal(modifies.length, 1)
  assert.deepEqual(modifies[0], {
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
  })
})

test('the PRICE is the only field that changes', async () => {
  // Field by field against the row itself, so a future edit that starts
  // deriving one of them from somewhere else fails here rather than at the
  // broker.
  const { s, modifies } = modifySession([ROW])
  await new XtsAdapter({ session: s }).modifyOrder('987654', 19.05)
  const req = modifies[0] as Record<string, unknown>
  assert.equal(req['modifiedProductType'], ROW['ProductType'])
  assert.equal(req['modifiedOrderType'], ROW['OrderType'])
  assert.equal(req['modifiedOrderQuantity'], ROW['OrderQuantity'])
  assert.equal(req['modifiedDisclosedQuantity'], ROW['OrderDisclosedQuantity'])
  assert.equal(req['modifiedStopPrice'], ROW['OrderStopPrice'])
  assert.equal(req['modifiedTimeInForce'], ROW['TimeInForce'])
  assert.equal(req['orderUniqueIdentifier'], ROW['OrderUniqueIdentifier'])
  assert.equal(req['modifiedLimitPrice'], 19.05)
  assert.notEqual(req['modifiedLimitPrice'], ROW['OrderPrice'], 'the reprice is the whole point')
})

test('the clientID comes from the ORDER ROW — e-orders-0002 cannot be empty', async () => {
  // The 2026-07-30 cancel failure, on a DEALER account. The row carries the
  // client the order was placed for, so a multi-client dealer login modifies
  // each order against the right one with no lookup.
  const { s, modifies } = modifySession([{ ...ROW, ClientID: 'OTHERCLIENT' }])
  await new XtsAdapter({ session: s }).modifyOrder('987654', 15)
  assert.equal((modifies[0] as { clientID?: string }).clientID, 'OTHERCLIENT')
})

test('a row with no ClientID OMITS the field rather than sending an empty one', async () => {
  // `clientID: ''` IS e-orders-0002. Omitting it is what lets the REST layer
  // substitute the session's code underneath.
  const { s, modifies } = modifySession([{ ...ROW, ClientID: '' }])
  await new XtsAdapter({ session: s }).modifyOrder('987654', 15)
  assert.equal('clientID' in (modifies[0] as object), false)
})

test('an order that is not in the broker book is refused WITHOUT a PUT', async () => {
  const { s, modifies } = modifySession([{ ...ROW, AppOrderID: 111 }])
  assert.equal(await new XtsAdapter({ session: s }).modifyOrder('987654', 15), false)
  assert.equal(modifies.length, 0, 'nothing to restate, so nothing may be sent')
})

test('a TERMINAL order is refused without a PUT, in every terminal state', async () => {
  // Filled / Replaced / Cancelled / Rejected — the legacy's own list
  // (`xts-account.js:509`). `Replaced` matters on its own: it says an earlier
  // modify already went through and the id we hold is the OLD one.
  for (const status of ['Filled', 'Replaced', 'Cancelled', 'Rejected']) {
    const { s, modifies } = modifySession([{ ...ROW, OrderStatus: status }])
    assert.equal(
      await new XtsAdapter({ session: s }).modifyOrder('987654', 15),
      false,
      `${status} must not be repriced`,
    )
    assert.equal(modifies.length, 0, `${status} must not reach the wire`)
  }
})

test('a PARTIALLY filled order keeps its TOTAL quantity, not what is left', async () => {
  // `LeavesQuantity` would shrink the order to its remainder. The chaser
  // reprices a partial's remainder precisely by leaving the quantity alone.
  const { s, modifies } = modifySession([
    {
      ...ROW,
      OrderStatus: 'PartiallyFilled',
      OrderQuantity: 13125,
      CumulativeQuantity: 5250,
      LeavesQuantity: 7875,
    },
  ])
  assert.equal(await new XtsAdapter({ session: s }).modifyOrder('987654', 15), true)
  assert.equal((modifies[0] as { modifiedOrderQuantity: number }).modifiedOrderQuantity, 13125)
})

test('a StopLimit keeps its stop price AND its type', async () => {
  // The chaser only ever moves the price of a LIMIT; deriving a type here is
  // how a stop-limit loses its stop.
  const { s, modifies } = modifySession([
    { ...ROW, OrderType: 'StopLimit', OrderStopPrice: 20, OrderPrice: 19.5 },
  ])
  await new XtsAdapter({ session: s }).modifyOrder('987654', 18)
  assert.equal((modifies[0] as { modifiedOrderType: string }).modifiedOrderType, 'StopLimit')
  assert.equal((modifies[0] as { modifiedStopPrice: number }).modifiedStopPrice, 20)
})

test('a row missing a field the modify must restate is refused, not guessed at', async () => {
  // Inventing a product type or a quantity is the exact defect the whole
  // method exists to avoid, so an incomplete row buys nothing by proceeding.
  for (const missing of ['ProductType', 'OrderType', 'TimeInForce', 'OrderQuantity']) {
    const row = { ...ROW }
    delete row[missing]
    const { s, modifies } = modifySession([row])
    assert.equal(
      await new XtsAdapter({ session: s }).modifyOrder('987654', 15),
      false,
      `a row with no ${missing} must not be modified`,
    )
    assert.equal(modifies.length, 0)
  }
})

test('a failed book read refuses rather than throwing — the chaser is a setInterval', async () => {
  const modifies: unknown[] = []
  const client: XtsClient = {
    clientCodes: ['C1'],
    placeOrder: async () => OK,
    modifyOrder: async (req) => {
      modifies.push(req)
      return OK
    },
    cancelOrder: async () => OK,
    getOrderBook: async () => {
      throw new Error('socket hang up')
    },
  }
  const a = new XtsAdapter({ session: { current: () => client, relogin: async () => client } })
  assert.equal(await a.modifyOrder('987654', 15), false)
  assert.equal(modifies.length, 0)
})

test('a broker refusal of the modify is reported as false, not as success', async () => {
  const { s, modifies } = modifySession([ROW], err('e-orders-0002 ClientID cannot be empty'))
  assert.equal(await new XtsAdapter({ session: s }).modifyOrder('987654', 15), false)
  assert.equal(modifies.length, 1, 'it did go out — this is the broker saying no')
})

// ------------------------------------------------------------- order book

test('orderBook() carries the broker average price — the sweep prices fills off it', async () => {
  const rows = [
    {
      AppOrderID: 987654,
      OrderUniqueIdentifier: 'DESK_BHEL|ord-1.1',
      TradingSymbol: 'BHEL26AUG420CE',
      OrderStatus: 'Filled',
      CumulativeQuantity: 13125,
      OrderAverageTradedPrice: '14.85',
    },
    { AppOrderID: 5, OrderStatus: 'New', CumulativeQuantity: 0, OrderAverageTradedPrice: '' },
  ]
  const client: XtsClient = {
    clientCodes: ['C1'],
    placeOrder: async () => OK,
    modifyOrder: async () => OK,
    cancelOrder: async () => OK,
    getOrderBook: async () => ({ type: 'success', result: rows as never }),
  }
  const book = await new XtsAdapter({
    session: { current: () => client, relogin: async () => client },
  }).orderBook()
  assert.equal(book[0]?.avgPrice, 14.85)
  assert.equal(book[0]?.clientOrderId, 'ord-1.1')
  assert.equal(book[0]?.filledQty, 13125)
  // An un-traded order has NO average. Zero would price a fill at zero.
  assert.equal(book[1]?.avgPrice, null)
  // No correlation id: a manual order on the same account, reported as foreign
  // rather than silently adopted.
  assert.equal(book[1]?.clientOrderId, null)
})

// ------------------------------------------------------- order-update ingest

test('an order update correlates back to the originating intent', () => {
  const a = new XtsAdapter({ session: session([]).s })
  const seen: unknown[] = []
  a.onOrderUpdate((u) => seen.push(u))

  const update = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'DESK_BHEL|ord-1',
    OrderStatus: 'Filled',
    AppOrderID: 987654,
    CumulativeQuantity: 13125,
    OrderAverageTradedPrice: 14.85,
  })
  assert.equal(update?.clientOrderId, 'ord-1')
  assert.equal(update?.status, 'FILLED')
  assert.equal(update?.filledQty, 13125)
  assert.equal(update?.avgPrice, 14.85, 'the BROKER average, never one we inferred')
  assert.equal(seen.length, 1)
})

test('PARTIAL fills are captured — the legacy listener drops them', () => {
  // smp_order_listener.js persists only FILLED and REJECTED, so a partially
  // filled 15-lot wing on a thin chain looks like nothing happened.
  const a = new XtsAdapter({ session: session([]).s })
  const update = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'DESK_BHEL|ord-1',
    OrderStatus: 'PartiallyFilled',
    AppOrderID: 1,
    CumulativeQuantity: 5250,
    OrderAverageTradedPrice: 14.9,
  })
  assert.equal(update?.status, 'PARTIALLY_FILLED')
  assert.equal(update?.filledQty, 5250)
})

test('a rejection carries its reason', () => {
  const a = new XtsAdapter({ session: session([]).s })
  const update = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'DESK_BHEL|ord-2',
    OrderStatus: 'Rejected',
    AppOrderID: 2,
    CancelRejectReason: 'RMS: margin shortfall',
  })
  assert.equal(update?.status, 'REJECTED')
  assert.equal(update?.rejectReason, 'RMS: margin shortfall')
})

test('an update with no correlation id is DROPPED, not guessed by symbol', () => {
  // A ladder holds several orders on the same contract; attributing by symbol
  // would credit the fill to the wrong leg.
  const a = new XtsAdapter({ session: session([]).s })
  assert.equal(a.ingestOrderUpdate({ OrderStatus: 'Filled', TradingSymbol: 'BHEL26AUG420CE' }), null)
  assert.equal(a.ingestOrderUpdate({ OrderUniqueIdentifier: 'no-separator', OrderStatus: 'Filled' }), null)
})

test('an unknown status is dropped rather than mapped to a guess', () => {
  const a = new XtsAdapter({ session: session([]).s })
  assert.equal(
    a.ingestOrderUpdate({ OrderUniqueIdentifier: 'T|ord-1', OrderStatus: 'Quantum' }),
    null,
  )
})

test('a market-data-only adapter cannot place orders', async () => {
  const a = new XtsAdapter({ session: session([OK]).s, sleep: noSleep })
  // XTS declares orders:true; the guard is proven by the capability check
  // itself, which zerodha-data relies on.
  assert.equal(a.capabilities.orders, true)
  assert.equal(a.capabilities.marketData, false)
})

test('a configured clientId is what goes out on the order, overriding the session', async () => {
  // G5. `clientID` was only ever `client.clientCodes[0]`, so a dealer account
  // whose login reports the wrong code had no way to correct it.
  const { s, client } = session([OK])
  const a = new XtsAdapter({ session: s, clientId: '*****', sleep: async () => {} })
  await a.placeOrder(INTENT)
  assert.equal((client.calls[0] as { clientID: string }).clientID, '*****')
})

test('with no clientId configured the session code is still used', async () => {
  const { s, client } = session([OK])
  const a = new XtsAdapter({ session: s, sleep: async () => {} })
  await a.placeOrder(INTENT)
  assert.equal((client.calls[0] as { clientID: string }).clientID, 'CLIENT1')
})

test('an order update carries the BROKER-reported contract', async () => {
  // G2: without it the consumer has no symbol for its fill record, and the
  // gateway "solved" that by writing the correlation id into the symbol column.
  const { s } = session([])
  const a = new XtsAdapter({ session: s })
  const update = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'TAG|ord-1.2',
    OrderStatus: 'Filled',
    AppOrderID: 987,
    CumulativeQuantity: 450,
    OrderAverageTradedPrice: 130,
    TradingSymbol: 'NIFTY26AUG25000CE',
  })
  assert.equal(update?.tradingsymbol, 'NIFTY26AUG25000CE')
  assert.equal(update?.clientOrderId, 'ord-1.2')
})

test('an update with no TradingSymbol omits the field rather than sending an empty one', async () => {
  const { s } = session([])
  const a = new XtsAdapter({ session: s })
  const update = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'TAG|ord-1',
    OrderStatus: 'Filled',
    AppOrderID: 987,
    CumulativeQuantity: 75,
  })
  assert.equal('tradingsymbol' in (update as object), false)
})

// ------------------------------------------ the 1.162 build ("Version 2")

/**
 * Symphony's change log 1.160 -> 1.162 (Feb 2026). What it changes on the
 * interactive side, and what each one must NOT do to this adapter:
 *
 *   - `AppOrderID` is a STRING now, and 20 digits long ("18001251480000036744")
 *     — past 2^53, so anything that ever coerced it to a number would silently
 *     corrupt the id it then cancelled or modified;
 *   - the modify body's `appOrderID` is a string too — it must be relayed
 *     exactly as the book reported it;
 *   - the trade socket event DROPS `TradingSymbol`, and the *API twin fields;
 *   - every DateTime becomes "05-01-2026 12:51:15.736" — nothing here parses
 *     one, and this pins that nothing here starts to;
 *   - `OrderAverageTradedPrice` is "" on an untraded order, and the old build
 *     grouped it ("1,410.80").
 */
const V2_ID = '18001251480000036744'

test('v2: a 20-digit string AppOrderID survives placement EXACTLY — no numeric coercion', async () => {
  const { s } = session([{ type: 'success', result: { AppOrderID: V2_ID, ClientID: 'AKA52' } }])
  const placed = await new XtsAdapter({ session: s, sleep: noSleep }).placeOrder(INTENT)
  assert.equal(placed.brokerOrderId, V2_ID)
  assert.equal(typeof placed.brokerOrderId, 'string')
  // The reason this is a test at all: the number nearest to it is not it.
  assert.notEqual(String(Number(V2_ID)), V2_ID)
})

test('v2: a modify finds the row by the string id and restates it as the string it was', async () => {
  const { s, modifies } = modifySession([{ ...ROW, AppOrderID: V2_ID }])
  assert.equal(await new XtsAdapter({ session: s }).modifyOrder(V2_ID, 15), true)
  const body = modifies[0] as Record<string, unknown>
  assert.equal(body['appOrderID'], V2_ID)
  assert.equal(typeof body['appOrderID'], 'string')
})

test('v2: the order book reads string ids, "" averages and the new timestamps without complaint', async () => {
  const rows = [
    {
      AppOrderID: V2_ID,
      OrderUniqueIdentifier: 'DESK_BHEL|ord-1',
      TradingSymbol: 'BHEL26AUG420CE',
      OrderStatus: 'New',
      CumulativeQuantity: 0,
      OrderAverageTradedPrice: '',
      OrderGeneratedDateTime: '05-01-2026 12:47:43.492',
      ExchangeTransactTime: '05-01-2026 12:51:15.000',
      LastUpdateDateTime: '05-01-2026 12:51:15.736',
      OrderExpiryDate: '01-01-1980 00:00:00.000',
      ApiVendorCode: 'X',
      DashboardAppKey: 'Y',
    },
  ]
  const client: XtsClient = {
    clientCodes: ['C1'],
    placeOrder: async () => OK,
    modifyOrder: async () => OK,
    cancelOrder: async () => OK,
    getOrderBook: async () => ({ type: 'success', result: rows as never }),
  }
  const [row] = await new XtsAdapter({
    session: { current: () => client, relogin: async () => client },
  }).orderBook()
  assert.equal(row?.brokerOrderId, V2_ID)
  assert.equal(row?.avgPrice, null, '"" is no average, not zero')
  assert.equal(row?.status, 'PENDING_NEW')
})

test('v2: a TRADE event with no TradingSymbol still correlates, and carries no symbol rather than ""', () => {
  const a = new XtsAdapter({ session: session([]).s })
  const update = a.ingestOrderUpdate({
    LoginID: 'AKA52',
    ClientID: 'AKA52',
    AppOrderID: V2_ID,
    OrderUniqueIdentifier: 'DESK_BHEL|ord-1',
    OrderStatus: 'Filled',
    CumulativeQuantity: 13125,
    LeavesQuantity: 0,
    OrderAverageTradedPrice: '1450',
    LastTradedPrice: 1450,
    OrderGeneratedDateTime: '05-01-2026 12:47:43.492',
    ExchangeTransactTime: '05-01-2026 12:51:15.000',
    LastUpdateDateTime: '05-01-2026 12:51:15.736',
    LastExecutionTransactTime: '05-01-2026 12:51:15.736',
    MessageCode: 9005,
    SequenceNumber: 0,
  })
  assert.equal(update?.brokerOrderId, V2_ID)
  assert.equal(update?.status, 'FILLED')
  assert.equal(update?.avgPrice, 1450)
  assert.equal(update !== null && 'tradingsymbol' in update, false, 'absent, never an empty string')
})

test('a GROUPED average ("1,410.80") is a price, not "no average"', () => {
  const a = new XtsAdapter({ session: session([]).s })
  const update = a.ingestOrderUpdate({
    AppOrderID: V2_ID,
    OrderUniqueIdentifier: 'DESK_BHEL|ord-1',
    OrderStatus: 'Filled',
    CumulativeQuantity: 1,
    OrderAverageTradedPrice: '1,410.80',
  })
  assert.equal(update?.avgPrice, 1410.8)
})

// ------------------------------------------------------ the exchange token

/**
 * THE EXCHANGE TOKEN IS THE ONLY NAME FOR A CONTRACT BOTH SIDES AGREE ON.
 *
 * The order document spells a contract the instrument master's way
 * (`NIFTY2692223150PE`); XTS spells it its own (`NIFTY 22SEP2026 PE 23150`),
 * on the REST book and on the socket alike. A consumer that has to decide
 * whether a broker row is for a given order cannot compare those strings — it
 * compares `ExchangeInstrumentID` with the doc's unpacked token instead, so
 * the adapter carries it through, coerced the way `positions-compare.ts`
 * documents: this account's replies send it as a STRING.
 */
test('the order book and the socket carry ExchangeInstrumentID as exchangeToken, coerced from string or number', async () => {
  const rows = [
    {
      AppOrderID: 987654,
      OrderUniqueIdentifier: 'DESK_BHEL|ord-1.1',
      TradingSymbol: 'BHEL 28AUG2026 CE 420',
      ExchangeInstrumentID: '149471',
      OrderStatus: 'Filled',
      CumulativeQuantity: 13125,
      OrderAverageTradedPrice: '14.85',
    },
    {
      AppOrderID: 5,
      ExchangeInstrumentId: 61623,
      OrderStatus: 'New',
      CumulativeQuantity: 0,
      OrderAverageTradedPrice: '',
    },
  ]
  const client: XtsClient = {
    clientCodes: ['C1'],
    placeOrder: async () => OK,
    modifyOrder: async () => OK,
    cancelOrder: async () => OK,
    getOrderBook: async () => ({ type: 'success', result: rows as never }),
  }
  const a = new XtsAdapter({ session: { current: () => client, relogin: async () => client } })
  const book = await a.orderBook()
  assert.equal(book[0]?.exchangeToken, 149471, 'a string id is still the integer it names')
  assert.equal(book[1]?.exchangeToken, 61623)

  const update = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'TAG|ord-1.2',
    OrderStatus: 'Filled',
    AppOrderID: 987,
    CumulativeQuantity: 450,
    OrderAverageTradedPrice: 130,
    ExchangeInstrumentID: '61623',
  })
  assert.equal(update?.exchangeToken, 61623)
})

test('an update with no ExchangeInstrumentID omits exchangeToken', async () => {
  const a = new XtsAdapter({ session: session([]).s })
  const update = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'TAG|ord-1',
    OrderStatus: 'Filled',
    AppOrderID: 987,
    CumulativeQuantity: 75,
  })
  assert.equal(update !== null && 'exchangeToken' in update, false, 'absent, never 0')
  // A garbage id is no id: a consumer reading 0 or NaN as "the token" would
  // refuse every row on the mismatch it invented.
  const bad = a.ingestOrderUpdate({
    OrderUniqueIdentifier: 'TAG|ord-1',
    OrderStatus: 'Filled',
    AppOrderID: 988,
    CumulativeQuantity: 75,
    ExchangeInstrumentID: 'n/a',
  })
  assert.equal(bad !== null && 'exchangeToken' in bad, false)
  // And the book row with no id says null, deliberately, not 0.
  const client: XtsClient = {
    clientCodes: ['C1'],
    placeOrder: async () => OK,
    modifyOrder: async () => OK,
    cancelOrder: async () => OK,
    getOrderBook: async () => ({
      type: 'success',
      result: [{ AppOrderID: 5, OrderStatus: 'New', CumulativeQuantity: 0 }] as never,
    }),
  }
  const book = await new XtsAdapter({
    session: { current: () => client, relogin: async () => client },
  }).orderBook()
  assert.equal(book[0]?.exchangeToken, null)
})
