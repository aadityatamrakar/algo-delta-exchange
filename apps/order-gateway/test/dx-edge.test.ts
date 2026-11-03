/**
 * The Delta edge of the gateway (spec §5.4a, §8): which broker a document
 * reaches, what a simulated fill costs, and the two caps that refuse before
 * anything is routed. Pure — no Mongo, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter } from '@algomaker/brokers'
import { DxAdapter, optionFee, type DxTradingClient } from '@algomaker/dx'
import type { OrderIntent } from '@algomaker/order-bus'
import {
  brokerModeFromEnv,
  chooseAdapter,
  chooseRail,
  dxCapRefusal,
  dxCapsFromEnv,
  dxSimFee,
  liveRailEnabled,
  routesToDelta,
} from '../src/dx-edge.ts'

const LIVE_ENV = { DESK_BROKER: 'delta', DESK_DX_LIVE: '1' }

// ------------------------------------------------------------------ routing

test('paper, a missing mode, "Live" and live-without-the-env all route to the simulator', () => {
  const simulator = { name: 'sim' }
  const delta = { name: 'delta' }
  const docs: Record<string, unknown>[] = [{ mode: 'paper' }, {}, { mode: 'Live' }, { mode: 'LIVE' }, { mode: true }]
  for (const doc of docs) {
    assert.equal(chooseAdapter(doc, LIVE_ENV, { simulator, delta }), simulator, JSON.stringify(doc))
    assert.equal(routesToDelta(doc, LIVE_ENV), false)
  }
  for (const env of [{ DESK_BROKER: 'delta' }, { DESK_BROKER: 'delta', DESK_DX_LIVE: 'true' }, { DESK_DX_LIVE: '1' }, {}]) {
    assert.equal(chooseAdapter({ mode: 'live' }, env, { simulator, delta }), simulator, JSON.stringify(env))
  }
})

test("only an exact mode 'live' with DESK_DX_LIVE=1 and a delta broker routes to Delta", () => {
  const simulator = { name: 'sim' }
  const delta = { name: 'delta' }
  assert.equal(routesToDelta({ mode: 'live' }, LIVE_ENV), true)
  assert.equal(chooseAdapter({ mode: 'live' }, LIVE_ENV, { simulator, delta }), delta)
  // No Delta adapter built (simulate mode): the simulator, never a throw.
  assert.equal(chooseAdapter({ mode: 'live' }, LIVE_ENV, { simulator, delta: null }), simulator)
})

// ------------------------------------------------------------ the demo rail

test("chooseRail: a paper order on a 'demo' book goes to the demo rail; everything else is unchanged", () => {
  for (const env of [LIVE_ENV, {}, { DESK_BROKER: 'delta' }]) {
    assert.equal(chooseRail({ mode: 'paper' }, env, 'demo'), 'demo', JSON.stringify(env))
    assert.equal(chooseRail({ mode: 'paper' }, env, 'sim'), 'sim')
    // A doc with no mode is paper (fail-closed), and so follows its book.
    assert.equal(chooseRail({}, env, 'demo'), 'demo')
  }
})

test('chooseRail: a LIVE order never reaches the demo rail, whatever its book says', () => {
  assert.equal(chooseRail({ mode: 'live' }, LIVE_ENV, 'demo'), 'live')
  // Live with the live rail off is the simulator, as it always was — never demo.
  for (const env of [{}, { DESK_BROKER: 'delta' }, { DESK_DX_LIVE: '1' }]) {
    assert.equal(chooseRail({ mode: 'live' }, env, 'demo'), 'sim', JSON.stringify(env))
  }
})

test('chooseRail: a rail stamped on the document wins over the book — one order, one exchange', () => {
  assert.equal(chooseRail({ mode: 'paper', dx_paper_rail: 'demo' }, {}, 'sim'), 'demo')
  assert.equal(chooseRail({ mode: 'paper', dx_paper_rail: 'sim' }, {}, 'demo'), 'sim')
  // A junk stamp is not a rail: the book decides.
  assert.equal(chooseRail({ mode: 'paper', dx_paper_rail: 'Demo' }, {}, 'sim'), 'sim')
  // And a stamp never makes a live order paper.
  assert.equal(chooseRail({ mode: 'live', dx_paper_rail: 'demo' }, LIVE_ENV, 'sim'), 'live')
})

test('the broker modes are simulate (default) and delta; anything else stops the boot', () => {
  assert.equal(brokerModeFromEnv({}), 'simulate')
  assert.equal(brokerModeFromEnv({ DESK_BROKER: 'simulate' }), 'simulate')
  assert.equal(brokerModeFromEnv({ DESK_BROKER: 'delta' }), 'delta')
  assert.throws(() => brokerModeFromEnv({ DESK_BROKER: 'xts' }), /simulate.*delta/)
  assert.equal(liveRailEnabled(LIVE_ENV), true)
  assert.equal(liveRailEnabled({ DESK_BROKER: 'delta' }), false)
  assert.equal(liveRailEnabled({ DESK_DX_LIVE: '1' }), false)
})

// --------------------------------------------------------------------- fees

const DX_INST = {
  tradingsymbol: 'C-BTC-76600-041126',
  instrumentToken: 9001,
  lotSize: 0.001,
  tickSize: 0.1,
  exchange: 'DELTA',
}

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    clientOrderId: 'c1', ts: 1, strategyTag: 'BS', mode: 'live', destinations: ['sim'],
    instrument: DX_INST, side: 'SELL', orderType: 'LIMIT', limitPrice: 205, quantity: 0.1, lots: 100,
    ...over,
  }
}

test('a simulated sell fills at the bid with fee = optionFee(contracts, index, bid)', async () => {
  const sim = new SimulatorAdapter({ feeModel: dxSimFee(() => 76592) })
  const fills: { avg: number | null; fee?: number }[] = []
  sim.onOrderUpdate((o) => {
    if (o.status === 'FILLED') fills.push({ avg: o.avgPrice, ...(o.fee === undefined ? {} : { fee: o.fee }) })
  })
  sim.feedTick(9001, 215, { bid: 212, ask: 218 })
  await sim.placeOrder(intent())
  sim.feedTick(9001, 215, { bid: 212, ask: 218 })
  const expected = optionFee({ contracts: 100, index: 76592, premium: 212 }).total
  assert.deepEqual(fills, [{ avg: 212, fee: expected }])
  // The spec's worked example: min(0.76592, 0.742) = 0.742, + 18 % GST.
  assert.equal(expected, Number((0.742 * 1.18).toFixed(8)))
})

test('with no index price the fee is the premium cap — the upper bound, never zero', () => {
  const said: string[] = []
  const fee = dxSimFee(() => null, (m) => said.push(m))
  const f = fee({ intent: intent(), qty: 0.1, price: 212 })
  assert.equal(f, Number((0.742 * 1.18).toFixed(8)))
  assert.equal(said.length, 1, 'said once')
  fee({ intent: intent(), qty: 0.1, price: 212 })
  assert.equal(said.length, 1, 'not on every fill')
})

// -------------------------------------------------------- the contract edge

function fakeRest(): { rest: DxTradingClient; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const rest = {
    placeOrder: async (o: Record<string, unknown>) => {
      sent.push(o)
      return {
        id: 1, product_id: 9001, product_symbol: DX_INST.tradingsymbol, size: o['size'], unfilled_size: o['size'],
        side: o['side'], state: 'open', client_order_id: o['client_order_id'], limit_price: o['limit_price'],
        average_fill_price: null,
      }
    },
    cancelOrder: async () => ({}),
    editOrder: async () => ({}),
    openOrders: async () => [],
    orderHistory: async () => [],
    positions: async () => [],
  } as unknown as DxTradingClient
  return { rest, sent }
}

test('a 0.15 BTC order is sent to Delta as size 150, price a string on the tick, close reduce-only', async () => {
  const { rest, sent } = fakeRest()
  const dx = new DxAdapter({ rest })
  await dx.placeOrder(intent({ quantity: 0.15, lots: 150, limitPrice: 212.04, meta: { desk_op: 'close' } }))
  assert.equal(sent[0]?.['size'], 150)
  assert.equal(sent[0]?.['limit_price'], '212.1')
  assert.equal(sent[0]?.['reduce_only'], true)
})

// --------------------------------------------------------------------- caps

test('caps default to 200 contracts and 20,000 USD, read "off" as off, and refuse a typo loudly', () => {
  assert.deepEqual(dxCapsFromEnv({}), { maxContractsPerOrder: 200, maxNotionalUsd: 20_000 })
  assert.deepEqual(
    dxCapsFromEnv({ DESK_DX_MAX_CONTRACTS_ORDER: '50', DESK_DX_MAX_NOTIONAL_USD: 'off' }),
    { maxContractsPerOrder: 50, maxNotionalUsd: null },
  )
  assert.throws(() => dxCapsFromEnv({ DESK_DX_MAX_CONTRACTS_ORDER: '2O0' }), /DESK_DX_MAX_CONTRACTS_ORDER/)
  assert.throws(() => dxCapsFromEnv({ DESK_DX_MAX_NOTIONAL_USD: '0' }), /DESK_DX_MAX_NOTIONAL_USD/)
})

test('an order over the contract cap or the notional cap is refused, with the reason', () => {
  const caps = dxCapsFromEnv({})
  const base = { caps, lotSize: 0.001, deskOp: 'open', index: 76_000 }
  assert.equal(dxCapRefusal({ ...base, quantity: 0.2 }), null, '200 contracts, 15,200 USD passes')
  assert.match(dxCapRefusal({ ...base, quantity: 0.201 }) ?? '', /201 contracts.*cap of 200.*DESK_DX_MAX_CONTRACTS_ORDER/)
  assert.match(
    dxCapRefusal({ ...base, quantity: 0.2, index: 120_000 }) ?? '',
    /notional 24000 USD.*cap of 20000.*DESK_DX_MAX_NOTIONAL_USD/,
  )
  assert.match(dxCapRefusal({ ...base, quantity: 0.05, index: null }) ?? '', /no BTC index price/)
})

test('a close is never capped — it goes out reduce-only and cannot add exposure', () => {
  const caps = dxCapsFromEnv({})
  assert.equal(dxCapRefusal({ caps, lotSize: 0.001, deskOp: 'close', index: null, quantity: 5 }), null)
  // A resize or a roll is not a close: it may grow the book.
  assert.notEqual(dxCapRefusal({ caps, lotSize: 0.001, deskOp: 'resize', index: 76_000, quantity: 5 }), null)
})

test('caps switched off refuse nothing', () => {
  const caps = { maxContractsPerOrder: null, maxNotionalUsd: null }
  assert.equal(dxCapRefusal({ caps, lotSize: 0.001, deskOp: 'open', index: null, quantity: 9 }), null)
})

// ------------------------------------------------- fill rows and tokens

test('a fill row carries the fee the update reported, and none when it reported none', async () => {
  const { toFillRecord, packedToExchangeToken } = await import('../src/gateway.ts')
  const base = { brokerOrderId: 'b1', clientOrderId: 'c1', status: 'FILLED' as const, filledQty: 0.1, avgPrice: 212 }
  assert.equal(toFillRecord({ ...base, fee: 0.87556 }, CE_SYM, 1, { tag: 't', mode: 'paper' }).fee, 0.87556)
  assert.equal('fee' in toFillRecord(base, CE_SYM, 1, { tag: 't', mode: 'paper' }), false)
  // A Delta product id is the token as is; an NSE token is unpacked.
  assert.equal(packedToExchangeToken(9001, false), 9001)
  assert.equal(packedToExchangeToken(42 * 256 + 3, true), 42)
})

const CE_SYM = 'C-BTC-76600-041126'

test("a live fill's fee is Delta's reported commission, summed per order — or none at all", async () => {
  const { deltaCommission } = await import('../src/dx-edge.ts')
  const rest = {
    fills: async () => ({
      fills: [
        { order_id: '77', commission: '0.4378' },
        { order_id: '77', commission: '0.4378' },
        { order_id: '78', commission: '9' },
      ],
    }),
  }
  assert.equal(await deltaCommission(rest, '77'), 0.8756)
  assert.equal(await deltaCommission(rest, '79'), null)
  assert.equal(await deltaCommission({ fills: async () => { throw new Error('429') } }, '77'), null)
})
