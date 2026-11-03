import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mapOrderStatus,
  classifyXtsError,
  roundToTick,
  stopLimitBand,
  correlationId,
  parseCorrelationId,
  exchangeSegment,
  mapOrderType,
  isSuccess,
} from '../src/xts-protocol.ts'

// ------------------------------------------------------------------ statuses

test('maps XTS statuses regardless of casing or separators', () => {
  assert.equal(mapOrderStatus('Filled'), 'FILLED')
  assert.equal(mapOrderStatus('FILLED'), 'FILLED')
  assert.equal(mapOrderStatus('PartiallyFilled'), 'PARTIALLY_FILLED')
  assert.equal(mapOrderStatus('Partially Filled'), 'PARTIALLY_FILLED')
  assert.equal(mapOrderStatus('Rejected'), 'REJECTED')
  assert.equal(mapOrderStatus('Cancelled'), 'CANCELLED')
  assert.equal(mapOrderStatus('Canceled'), 'CANCELLED', 'both spellings occur in the wild')
})

test('an unacknowledged order is PENDING_NEW, not WORKING', () => {
  // Treating it as working would let reconciliation conclude a position exists
  // before the exchange has accepted anything.
  assert.equal(mapOrderStatus('New'), 'PENDING_NEW')
  assert.equal(mapOrderStatus('PendingNew'), 'PENDING_NEW')
  assert.equal(mapOrderStatus('Open'), 'WORKING')
})

test('an UNKNOWN status returns null rather than guessing', () => {
  assert.equal(mapOrderStatus('SomethingNew'), null)
  assert.equal(mapOrderStatus(undefined), null)
  assert.equal(mapOrderStatus(null), null)
  assert.equal(mapOrderStatus(''), null)
})

// -------------------------------------------------------------------- errors

test('the OMS injector error is transient — the order never reached the exchange', () => {
  const msg =
    '400 - {"type":"error","code":"e-request-0004","description":"System Error : X10203. ' +
    'ApplicationType:OMSInjector. Error : An error occurred while sending the request."}'
  assert.equal(classifyXtsError(msg), 'transient')
  assert.equal(classifyXtsError('X10203'), 'transient')
})

test('session-expiry codes are their own class — retrying without re-login burns attempts', () => {
  assert.equal(classifyXtsError('{"code":"e-session-0005"}'), 'session')
  assert.equal(classifyXtsError('{"code":"e-session-00005"}'), 'session')
  assert.equal(classifyXtsError('{"code":"e-user-0001"}'), 'session')
})

test('a network/timeout fault is UNKNOWN — the order may already be at the exchange', () => {
  // F-3: these all mean "the response never came back", which says NOTHING
  // about whether the request arrived. Retrying can double-place; asserting
  // failure un-books a live position. Only the broker's book can settle it.
  assert.equal(classifyXtsError('request timed out after 15000ms'), 'unknown')
  assert.equal(classifyXtsError('The operation was aborted'), 'unknown')
  assert.equal(classifyXtsError('fetch failed'), 'unknown')
  assert.equal(classifyXtsError('socket hang up'), 'unknown')
  assert.equal(classifyXtsError('network error'), 'unknown')
  assert.equal(classifyXtsError('connect ECONNRESET 1.2.3.4:443'), 'unknown')
  assert.equal(classifyXtsError('connect ETIMEDOUT 1.2.3.4:443'), 'unknown')
  assert.equal(classifyXtsError('getaddrinfo EAI_AGAIN xts.broker.in'), 'unknown')
})

test('a broker REFUSAL that merely mentions a network word stays in its own class', () => {
  // The unknown class sits BELOW transient and session, never above them: an
  // OMSInjector error is known not to have reached the exchange, and an expired
  // token still needs a re-login.
  assert.equal(
    classifyXtsError('System Error : X10203. ApplicationType:OMSInjector. request timed out'),
    'transient',
  )
  assert.equal(classifyXtsError('{"code":"e-session-0005"} socket hang up'), 'session')
})

test('a real rejection is fatal — retrying could double-place it', () => {
  assert.equal(classifyXtsError('insufficient margin'), 'fatal')
  assert.equal(classifyXtsError('price band violation'), 'fatal')
  assert.equal(classifyXtsError('freeze quantity exceeded'), 'fatal')
  assert.equal(classifyXtsError(''), 'fatal')
  assert.equal(classifyXtsError(undefined), 'fatal')
})

test('isSuccess only accepts the success envelope', () => {
  assert.equal(isSuccess({ type: 'success' }), true)
  assert.equal(isSuccess({ type: 'error' }), false)
  assert.equal(isSuccess(null), false)
  assert.equal(isSuccess(undefined), false)
  assert.equal(isSuccess({}), false)
})

// ------------------------------------------------------------------- pricing

test('prices round to the tick and are NOT truncated to whole rupees', () => {
  // The legacy parseInt bug: the BHEL 470CE wing at 2.90 became 2.
  assert.equal(roundToTick(2.9, 0.05), 2.9)
  assert.equal(roundToTick(12.47, 0.05), 12.45)
  assert.equal(roundToTick(12.48, 0.05), 12.5)
  assert.notEqual(roundToTick(2.9, 0.05), 2)
})

test('roundToTick survives the classic float-division error', () => {
  // 100.1 / 0.05 === 2001.9999999999998
  assert.equal(roundToTick(100.1, 0.05), 100.1)
  assert.equal(roundToTick(0.05, 0.05), 0.05)
})

test('a stop-limit band brackets the stop on the correct side', () => {
  const buy = stopLimitBand('BUY', 2000, 0.05)
  assert.equal(buy.stopPrice, 2000)
  assert.ok(buy.limitPrice > 2000, 'a BUY stop must allow filling ABOVE the trigger')

  const sell = stopLimitBand('SELL', 2000, 0.05)
  assert.ok(sell.limitPrice < 2000, 'a SELL stop must allow filling BELOW the trigger')
})

test('cheap instruments get a WIDER band — 1% of Rs.3 is inside one tick', () => {
  const cheap = stopLimitBand('BUY', 3, 0.05)
  const bandPct = (cheap.limitPrice - cheap.stopPrice) / cheap.stopPrice
  assert.ok(bandPct > 0.02, `expected a wide band on a cheap option, got ${bandPct}`)
  // At 1% the band would be 0.03 — smaller than the 0.05 tick, so the order
  // would behave as a pure limit and might never fill.
  assert.ok(cheap.limitPrice - cheap.stopPrice >= 0.05)

  const rich = stopLimitBand('BUY', 5000, 0.05)
  const richPct = (rich.limitPrice - rich.stopPrice) / rich.stopPrice
  assert.ok(richPct <= 0.011, `expected a tight band on an expensive one, got ${richPct}`)
})

// --------------------------------------------------------------- correlation

test('correlationId round-trips through parse', () => {
  const id = correlationId('DESK_BHEL', 'ord-abc123')
  assert.equal(id, 'DESK_BHEL|ord-abc123')
  assert.deepEqual(parseCorrelationId(id), { tag: 'DESK_BHEL', clientOrderId: 'ord-abc123' })
})

test('a clientOrderId containing the separator cannot corrupt the parse', () => {
  const id = correlationId('DESK|BHEL', 'ord|123')
  const parsed = parseCorrelationId(id)
  assert.equal(parsed?.tag, 'DESK-BHEL')
  assert.equal(parsed?.clientOrderId, 'ord-123')
})

test('an over-long id is truncated, because a refused order is worse', () => {
  const id = correlationId('T'.repeat(30), 'c'.repeat(40), 45)
  assert.equal(id.length, 45)
})

test('parseCorrelationId rejects anything without both halves', () => {
  assert.equal(parseCorrelationId('no-separator'), null)
  assert.equal(parseCorrelationId('|missing-tag'), null)
  assert.equal(parseCorrelationId('missing-id|'), null)
  assert.equal(parseCorrelationId(undefined), null)
})

// ------------------------------------------------------------------ mapping

test('exchange segments cover NSE and BSE derivatives', () => {
  assert.equal(exchangeSegment('NFO'), 'NSEFO')
  assert.equal(exchangeSegment('BFO'), 'BSEFO', 'SENSEX options are BSE, not NSE')
  assert.equal(exchangeSegment('NSE'), 'NSECM')
})

test('stop order types become StopLimit — XTS has no true stop-market', () => {
  assert.equal(mapOrderType('MARKET'), 'Market')
  assert.equal(mapOrderType('LIMIT'), 'Limit')
  assert.equal(mapOrderType('SL_MARKET'), 'StopLimit')
  assert.equal(mapOrderType('SL_LIMIT'), 'StopLimit')
})

test('an expired token reported IN PROSE is a session error, not fatal', () => {
  // Observed on prod 2026-07-30: the gateway reused a stored token across a
  // restart and every call answered "Token/Authorization not found". It
  // matches no e- code, so it classified as fatal — and fatal means no
  // relogin, which would take order placement down for the rest of the
  // session rather than recovering from an expired token.
  assert.equal(classifyXtsError('Token/Authorization not found'), 'session')
  assert.equal(classifyXtsError('token expired'), 'session')
  assert.equal(classifyXtsError('Authorization not found'), 'session')
})

test('"Invalid Token" is a session error too — it is the SAME dead session', () => {
  // The other half of the same prod failure. XTS answers a request carrying a
  // token it no longer honours with either "Token/Authorization not found" OR a
  // bare "Invalid Token", and only the first was matched — so the gateway's
  // broker snapshot classified it fatal, never re-logged in, and rewrote the
  // same failed snapshot every 30s while the dashboard screamed red.
  assert.equal(classifyXtsError('Invalid Token'), 'session')
  assert.equal(classifyXtsError('{"description":"Invalid Token"}'), 'session')
  assert.equal(classifyXtsError('orders: Invalid Token; positions: Invalid Token'), 'session')
})

test('genuinely fatal messages are still fatal', () => {
  // The widening must not swallow real rejections into an endless relogin loop.
  assert.equal(classifyXtsError('ClientID cannot be empty.'), 'fatal')
  assert.equal(classifyXtsError('Insufficient funds'), 'fatal')
  assert.equal(classifyXtsError('Instrument not found'), 'fatal')
  // "Invalid" alone is not a session: an invalid PRICE is a real rejection, and
  // re-logging in for it would retry an order the exchange actively refused.
  assert.equal(classifyXtsError('Invalid price'), 'fatal')
  assert.equal(classifyXtsError('Invalid instrument'), 'fatal')
})
