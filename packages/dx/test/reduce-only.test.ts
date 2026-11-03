/**
 * `only_reduce_only_orders_allowed`: Delta rejects an OPENING order on a
 * contract whose open interest is over its `max_oi_usd` cap. Observed on the
 * India testnet, 3 Nov 2026 (read-only GETs after the rejections):
 *
 *   C-BTC-77200-041126  ticker oi_reduce_only_mode true,  OI $4,233,772 > cap $2,000,000 — the call REJECTED
 *   P-BTC-77200-041126  ticker oi_reduce_only_mode false, OI $108,097              — the put FILLED
 *   P-BTC-77000-061126  ticker oi_reduce_only_mode true,  OI $697,913 > cap $500,000   — the put REJECTED
 *   C-BTC-77000-061126  ticker oi_reduce_only_mode false, OI $37,795                — the call FILLED
 *
 * `product_specs.oi_reduce_only_mode` appears (true) only on the capped two;
 * `only_reduce_only_orders_allowed` was false on all four.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrderIntent } from '@algomaker/order-bus'
import {
  DxAdapter,
  DxApiError,
  DxOrderError,
  opensAllowed,
  parseFrame,
  quoteFromTicker,
  type DxProduct,
  type DxTicker,
  type DxTradingClient,
} from '../src/index.ts'

const product = (symbol: string, specs: DxProduct['product_specs']): DxProduct => ({
  id: 207610, symbol, contract_type: 'call_options', state: 'live', trading_status: 'operational',
  strike_price: '77200', settlement_time: '2026-11-04T12:00:00Z', contract_value: '0.001', tick_size: '0.1',
  underlying_asset: { id: 13, symbol: 'BTC' }, ...(specs === undefined ? {} : { product_specs: specs }),
})
const ticker = (symbol: string, mode: boolean | undefined): DxTicker => ({
  symbol, product_id: 207610, mark_price: '742', oi_contracts: '55371', oi_value_usd: '4233771.8649',
  quotes: { best_bid: '735', best_ask: '750', bid_size: '10', ask_size: '10', mark_iv: '0.4' },
  ...(mode === undefined ? {} : { oi_reduce_only_mode: mode }),
})

test('opensAllowed is false while the product or its ticker is in OI reduce-only mode', () => {
  assert.equal(opensAllowed(product('C-BTC-77200-041126', { max_oi_usd: 2000000, oi_reduce_only_mode: true, only_reduce_only_orders_allowed: false })), false)
  assert.equal(opensAllowed(product('P-BTC-77200-041126', { max_oi_usd: 2000000, only_reduce_only_orders_allowed: false })), true)
  assert.equal(opensAllowed(product('X', { only_reduce_only_orders_allowed: true })), false)
  assert.equal(opensAllowed(product('X', undefined)), true)
  assert.equal(opensAllowed(ticker('C-BTC-77200-041126', true)), false)
  assert.equal(opensAllowed(ticker('P-BTC-77200-041126', false)), true)
})

test('the REST quote carries oiReduceOnly; the WS quote says null (it does not carry it)', () => {
  assert.equal(quoteFromTicker(ticker('C-BTC-77200-041126', true)).oiReduceOnly, true)
  assert.equal(quoteFromTicker(ticker('P-BTC-77200-041126', false)).oiReduceOnly, false)
  assert.equal(quoteFromTicker(ticker('X', undefined)).oiReduceOnly, null)
  const f = parseFrame({ type: 'ticker', sy: 'C-BTC-77200-041126', ts: 1, d: [{ s: 'C-BTC-77200-041126', i: 1, m: '742' }] })
  assert.ok(f.kind === 'ticker')
  assert.equal(f.quote.oiReduceOnly, null)
})

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  clientOrderId: 'bs-L1-ce-sell', ts: 0, strategyTag: 'BULL-S', mode: 'sim', destinations: ['sim'],
  instrument: { tradingsymbol: 'C-BTC-77200-041126', instrumentToken: 207610, lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA' },
  side: 'SELL', orderType: 'LIMIT', quantity: 0.005, lots: 5, limitPrice: 735, ...over,
})

const refusing = (calls: unknown[]): DxTradingClient => ({
  async placeOrder(o) {
    calls.push(o)
    throw new DxApiError({ status: 400, code: 'only_reduce_only_orders_allowed', message: 'POST /v2/orders: 400 only_reduce_only_orders_allowed' })
  },
  async cancelOrder() { throw new Error('unused') },
  async editOrder() { throw new Error('unused') },
  async openOrders() { return [] },
  async orderHistory() { return [] },
  async positions() { return [] },
})

test('an opening order refused only_reduce_only_orders_allowed is fatal, sent once, and names the cause', async () => {
  const calls: unknown[] = []
  const a = new DxAdapter({ rest: refusing(calls), sleep: async () => {} })
  await assert.rejects(a.placeOrder(intent()), (e: unknown) => {
    assert.ok(e instanceof DxOrderError)
    assert.equal(e.klass, 'fatal')
    assert.match(e.message, /C-BTC-77200-041126 is in reduce-only mode/)
    assert.match(e.message, /open interest over the contract's cap/)
    assert.match(e.message, /NOT placed/)
    return true
  })
  assert.equal(calls.length, 1, 'not retried')
})

test('the same refusal on a close is still fatal but not explained as an OI cap', async () => {
  const calls: unknown[] = []
  const a = new DxAdapter({ rest: refusing(calls), sleep: async () => {} })
  await assert.rejects(a.placeOrder(intent({ side: 'BUY', meta: { reduceOnly: true } })), (e: unknown) => {
    assert.ok(e instanceof DxOrderError)
    assert.equal(e.klass, 'fatal')
    assert.doesNotMatch(e.message, /reduce-only mode on Delta/)
    return true
  })
})
