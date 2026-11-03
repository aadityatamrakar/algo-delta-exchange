import test from 'node:test'
import assert from 'node:assert/strict'
import { ZerodhaDataAdapter, CapabilityError, assertCanPlaceOrders } from '../src/index.ts'
import type { OrderIntent } from '@algomaker/order-bus'

const intent: OrderIntent = {
  clientOrderId: 'c1', ts: 1, strategyTag: 'T', mode: 'live', destinations: ['zerodha'],
  instrument: { tradingsymbol: 'X', instrumentToken: 1, lotSize: 25, tickSize: 0.05, exchange: 'NFO' },
  side: 'BUY', orderType: 'MARKET', quantity: 25, lots: 1,
}

test('zerodha-data declares market data only', () => {
  const z = new ZerodhaDataAdapter()
  assert.equal(z.capabilities.marketData, true)
  assert.equal(z.capabilities.orders, false)
  assert.equal(z.capabilities.modify, false)
})

test('placeOrder REJECTS structurally — this is the dual-rail fix', async () => {
  // The legacy Account.placeAllAccount could place Zerodha orders AND insert on
  // the bus. Making Zerodha incapable of ordering removes that by construction.
  const z = new ZerodhaDataAdapter()
  await assert.rejects(() => z.placeOrder(intent), CapabilityError)
})

test('modify and cancel also reject', async () => {
  const z = new ZerodhaDataAdapter()
  await assert.rejects(() => z.modifyOrder('x', 1), CapabilityError)
  await assert.rejects(() => z.cancelOrder('x'), CapabilityError)
})

test('assertCanPlaceOrders throws for it and passes for an order-capable adapter', () => {
  const z = new ZerodhaDataAdapter()
  assert.throws(() => assertCanPlaceOrders(z), CapabilityError)
})

test('onFill returns an unsubscribe and never fires', () => {
  const z = new ZerodhaDataAdapter()
  let n = 0
  const off = z.onFill(() => n++)
  off()
  assert.equal(n, 0, 'a data-only adapter has no fills')
})

test('onOrderUpdate behaves the same as the onFill alias: unsubscribe, never fires', () => {
  const z = new ZerodhaDataAdapter()
  let n = 0
  const off = z.onOrderUpdate(() => n++)
  off()
  assert.equal(n, 0)
})

test('positions and orderBook also reject — no order/position book without XTS', async () => {
  const z = new ZerodhaDataAdapter()
  await assert.rejects(() => z.positions(), CapabilityError)
  await assert.rejects(() => z.orderBook(), CapabilityError)
})
