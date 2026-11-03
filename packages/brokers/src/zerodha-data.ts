/**
 * Zerodha, market data ONLY (spec D1).
 *
 * Every order method throws. That is the point: the legacy
 * `Account.placeAllAccount` (common/models/account.js:148-152) inserted on the
 * order bus AND placed Zerodha orders in the same call, so one strategy decision
 * could fill on two brokers. Making this adapter incapable of placing an order
 * removes that failure mode by construction rather than by discipline.
 *
 * Tick and candle plumbing lives in apps/marketdata, which owns the single
 * websocket. This adapter exists so Zerodha has a typed place in the
 * BrokerAdapter model and its incapability is explicit and tested.
 */
import type { OrderIntent } from '@algomaker/order-bus'
import {
  CapabilityError,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerOrder,
  type BrokerPosition,
  type PlacedOrder,
} from './types.ts'

export class ZerodhaDataAdapter implements BrokerAdapter {
  readonly name = 'zerodha-data'
  readonly capabilities: BrokerCapabilities = { orders: false, marketData: true, modify: false }

  async placeOrder(_intent: OrderIntent): Promise<PlacedOrder> {
    throw new CapabilityError('zerodha-data is market-data only: order placement goes through the order gateway (spec D1)')
  }

  async modifyOrder(_brokerOrderId: string, _price: number): Promise<boolean> {
    throw new CapabilityError('zerodha-data cannot modify orders')
  }

  async cancelOrder(_brokerOrderId: string): Promise<boolean> {
    throw new CapabilityError('zerodha-data cannot cancel orders')
  }

  async positions(): Promise<readonly BrokerPosition[]> {
    throw new CapabilityError('zerodha-data has no order/position book: order placement goes through the order gateway (spec D1)')
  }

  async orderBook(): Promise<readonly BrokerOrder[]> {
    throw new CapabilityError('zerodha-data has no order/position book: order placement goes through the order gateway (spec D1)')
  }

  onOrderUpdate(_handler: (order: PlacedOrder) => void): () => void {
    return () => {}
  }

  /** @deprecated Alias for {@link onOrderUpdate}. */
  onFill(_handler: (order: PlacedOrder) => void): () => void {
    return () => {}
  }
}
