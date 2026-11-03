import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cancelBrokerOrder, isCancellable } from '../src/cancel-queue.ts'

const live = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  AppOrderID: 1240043411,
  OrderStatus: 'New',
  ClientID: 'DEALER01',
  OrderUniqueIdentifier: 'BAJFINANCE-2026-08-25-recenter-r|smoke-8#0',
  ...over,
})

function fakeClient(resp: Record<string, unknown> = { type: 'success' }) {
  const sent: Record<string, unknown>[] = []
  return {
    sent,
    async cancelOrder(req: Record<string, unknown>) {
      sent.push(req)
      return resp
    },
  }
}

test('isCancellable follows the legacy terminal-status list', () => {
  for (const s of ['Filled', 'Replaced', 'Cancelled', 'Rejected']) {
    assert.equal(isCancellable({ OrderStatus: s }), false, s)
  }
  for (const s of ['New', 'Open', 'PendingNew', 'PartiallyFilled']) {
    assert.equal(isCancellable({ OrderStatus: s }), true, s)
  }
})

test('THE CLIENT ID COMES FROM THE ORDER ROW, not from config', async () => {
  // The failure this fixes: a cancel without clientID returns
  // `e-orders-0002 ClientID cannot be empty` on a dealer account. Sourcing it
  // from the order also cancels each order against the right client on a
  // multi-client dealer login.
  const c = fakeClient()
  const out = await cancelBrokerOrder(c, [live()], '1240043411')
  assert.equal(out.ok, true)
  assert.deepEqual(c.sent[0], {
    appOrderID: 1240043411,
    clientID: 'DEALER01',
    orderUniqueIdentifier: 'BAJFINANCE-2026-08-25-recenter-r|smoke-8#0',
  })
})

test('an absent clientID is OMITTED, never sent empty', async () => {
  // `clientID: ''` is precisely what produced e-orders-0002. Omitting lets the
  // broker apply its own default instead of rejecting outright.
  const c = fakeClient()
  await cancelBrokerOrder(c, [live({ ClientID: '' })], '1240043411')
  assert.equal('clientID' in (c.sent[0] as object), false)
})

test('an order that is not in the book is ALREADY GONE, not a failure', async () => {
  // Cancelling something that no longer exists IS the desired end state.
  // Reporting it as an error trains an operator to ignore cancel results.
  const c = fakeClient()
  const out = await cancelBrokerOrder(c, [], '1240043411')
  assert.equal(out.ok, true)
  assert.match(out.error, /already gone/)
  assert.equal(c.sent.length, 0, 'must not call the broker for an order it does not have')
})

test('an already-terminal order is not re-cancelled', async () => {
  const c = fakeClient()
  const out = await cancelBrokerOrder(c, [live({ OrderStatus: 'Filled' })], '1240043411')
  assert.equal(out.ok, true)
  assert.match(out.error, /already Filled/)
  assert.equal(c.sent.length, 0)
})

test('an XTS error payload is a failure even though the call resolved', async () => {
  const c = fakeClient({ type: 'error', error: { message: 'ClientID cannot be empty.' } })
  const out = await cancelBrokerOrder(c, [live()], '1240043411')
  assert.equal(out.ok, false)
  assert.match(out.error, /ClientID cannot be empty/)
})

test('it never throws — a broker that is down reports, it does not explode', async () => {
  const c = {
    sent: [],
    async cancelOrder() {
      throw new Error('ECONNREFUSED')
    },
  }
  const out = await cancelBrokerOrder(c, [live()], '1240043411')
  assert.equal(out.ok, false)
  assert.match(out.error, /ECONNREFUSED/)
})

test('the id is matched as a string, so a numeric AppOrderID still matches', async () => {
  // The row carries a number; the request carries whatever came off an HTTP
  // path segment. Comparing them raw would silently never match.
  const c = fakeClient()
  const out = await cancelBrokerOrder(c, [live({ AppOrderID: 1240043411 })], '1240043411')
  assert.equal(out.ok, true)
  assert.equal(c.sent.length, 1)
})
