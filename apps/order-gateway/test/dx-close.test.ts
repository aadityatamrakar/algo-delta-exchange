import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter, type PlacedOrder } from '@algomaker/brokers'
import { FreezeLimits } from '@algomaker/instruments'
import type { OrderIntent } from '@algomaker/order-bus'
import type { DxTicker } from '@algomaker/dx'
import { FakeCollection, FakeFills, FakeJournal } from './mongo-harness.ts'
import { createOrderPlacer } from '../src/main.ts'
import { OrderQueue, createSweeper } from '../src/queue.ts'
import { FillWatcher } from '../src/fills.ts'
import { OrderJournal } from '../src/journal.ts'
import type { ResolvedContract } from '../src/gateway.ts'
import {
  closeDialsFromEnv,
  closeEscalationPrice,
  closeLimitPrice,
  createCloseBookSource,
  type CloseBook,
} from '../src/dx-close.ts'

/**
 * A DELTA EXIT KEEPS WORKING UNTIL IT FILLS. Priced off the TOUCH (best ask
 * for a buy-back, best bid for a sell) plus a buffer, never off the mark and
 * never MARKET; the book is the gateway's WS quote when ≤ 5 s old, else Delta
 * REST.
 */

const NOW = 1_793_696_000_000
const SYMBOL = 'C-BTC-77200-041126'
const TOKEN = 161400
const book = (bid: number | null, ask: number | null, band: { lower?: number; upper?: number } = {}): CloseBook => ({
  bid, ask, lower: band.lower ?? null, upper: band.upper ?? null, source: 'ws',
})
const dials = { bufferPct: 0.02, minTicks: 2, tickSize: 0.1 }

test('closeLimitPrice: a buy-back is the ASK plus the buffer, ceiled; a sell is the BID minus it, floored', () => {
  assert.equal(closeLimitPrice('BUY', book(95, 100), dials), 102)
  assert.equal(closeLimitPrice('SELL', book(100, 105), dials), 98)
  // The tick floor does the work on a cheap contract: 2% of 1.0 is under a tick.
  assert.equal(closeLimitPrice('BUY', book(0.8, 1), dials), 1.2)
  assert.equal(closeLimitPrice('SELL', book(1, 1.2), dials), 0.8)
  // Off-grid touch still lands on the grid, away from the market.
  assert.equal(closeLimitPrice('BUY', book(95, 100.04), dials), 102.1)
})

test('closeLimitPrice: the price band caps a buy and floors a sell; no far side is no price', () => {
  assert.equal(closeLimitPrice('BUY', book(95, 100, { upper: 101 }), dials), 101)
  assert.equal(closeLimitPrice('SELL', book(100, 105, { lower: 99.5 }), dials), 99.5)
  assert.equal(closeLimitPrice('SELL', book(0.1, 0.5), dials), 0.1, 'a sell never goes below one tick')
  assert.equal(closeLimitPrice('BUY', book(95, null), dials), null)
  assert.equal(closeLimitPrice('SELL', book(null, 100), dials), null)
})

const esc = { stepPct: 0.05, maxMult: 3, tickSize: 0.1, lastPrice: 0, limitPrice: 102 }

test('closeEscalationPrice: each step is +5% beyond the touch, capped at 3x the touch (buy)', () => {
  assert.equal(closeEscalationPrice('BUY', 1, { ...esc, book: book(95, 100) }), 105)
  assert.equal(closeEscalationPrice('BUY', 4, { ...esc, book: book(95, 100) }), 120)
  assert.equal(closeEscalationPrice('BUY', 100, { ...esc, book: book(95, 100) }), 300)
  // …and at the band's upper limit when Delta states one.
  assert.equal(closeEscalationPrice('BUY', 100, { ...esc, book: book(95, 100, { upper: 250 }) }), 250)
})

test('closeEscalationPrice: a sell steps 5% under the bid, floored at bid/3, the band, and one tick', () => {
  assert.equal(closeEscalationPrice('SELL', 1, { ...esc, book: book(100, 105) }), 95)
  assert.equal(closeEscalationPrice('SELL', 100, { ...esc, book: book(100, 105) }), 33.4)
  assert.equal(closeEscalationPrice('SELL', 100, { ...esc, book: book(100, 105, { lower: 50 }) }), 50)
})

test('closeEscalationPrice: with no book at all it steps blind off the last accepted price, capped off the original limit', () => {
  assert.equal(closeEscalationPrice('BUY', 1, { ...esc, book: null, lastPrice: 110 }), 115.5)
  assert.equal(closeEscalationPrice('BUY', 1, { ...esc, book: null, lastPrice: 0 }), 107.1)
  assert.equal(closeEscalationPrice('BUY', 1, { ...esc, book: null, lastPrice: 300 }), 306, 'cap is 3x the original limit')
  assert.equal(closeEscalationPrice('SELL', 1, { ...esc, book: null, lastPrice: 50, limitPrice: 60 }), 47.5)
  assert.equal(closeEscalationPrice('SELL', 1, { ...esc, book: book(null, 105), lastPrice: 21, limitPrice: 60 }), 20, 'floor 60/3')
})

test('dials: defaults, and a typo falls back rather than becoming NaN', () => {
  assert.deepEqual(closeDialsFromEnv({}), { bufferPct: 0.02, minTicks: 2, stepPct: 0.05, maxMult: 3, stepMs: 3_000, wsMaxAgeMs: 5_000 })
  assert.equal(closeDialsFromEnv({ DESK_DX_CLOSE_STEP_PCT: 'oops' }).stepPct, 0.05)
  assert.equal(closeDialsFromEnv({ DESK_DX_CLOSE_MAX_MULT: '0.5' }).maxMult, 3, 'a cap under 1x would price inside the touch')
  assert.equal(closeDialsFromEnv({ DESK_DX_CLOSE_BUFFER_PCT: '0.05' }).bufferPct, 0.05)
})

// -------------------------------------------------------------- the book

const ticker = (over: Partial<DxTicker> = {}): DxTicker => ({
  symbol: SYMBOL, product_id: TOKEN,
  quotes: { best_bid: '18', best_ask: '20' },
  price_band: { lower_limit: '0.1', upper_limit: '340.68' },
  ...over,
})

test('book: a WS quote at most 5 s old is used and REST is not called', async () => {
  const calls: string[] = []
  const src = createCloseBookSource({
    touch: () => ({ bid: 18.5, ask: 19.5, ts: NOW - 5_000 }),
    now: () => NOW,
    wsMaxAgeMs: 5_000,
    ticker: async (s) => {
      calls.push(s)
      return ticker()
    },
  })
  assert.deepEqual(await src.book({ instrument_token: TOKEN, tradingsymbol: SYMBOL }), {
    bid: 18.5, ask: 19.5, lower: null, upper: null, source: 'ws',
  })
  assert.deepEqual(calls, [])
})

test('book: a WS quote older than 5 s, or none, reads L1 + the band from Delta REST', async () => {
  const calls: string[] = []
  for (const touch of [() => ({ bid: 18.5, ask: 19.5, ts: NOW - 5_001 }), () => null]) {
    const src = createCloseBookSource({
      touch,
      now: () => NOW,
      wsMaxAgeMs: 5_000,
      ticker: async (s) => {
        calls.push(s)
        return ticker()
      },
    })
    assert.deepEqual(await src.book({ instrument_token: TOKEN, tradingsymbol: SYMBOL }), {
      bid: 18, ask: 20, lower: 0.1, upper: 340.68, source: 'rest',
    })
  }
  assert.deepEqual(calls, [SYMBOL, SYMBOL])
})

test('book: an empty side reads null; a REST failure, or no REST at all, is no book (never a throw)', async () => {
  const oneSided = createCloseBookSource({ touch: () => null, now: () => NOW, wsMaxAgeMs: 5_000, ticker: async () => ticker({ quotes: { best_bid: '', best_ask: '20' } }) })
  assert.deepEqual(await oneSided.book({ instrument_token: TOKEN, tradingsymbol: SYMBOL }), { bid: null, ask: 20, lower: 0.1, upper: 340.68, source: 'rest' })
  const failing = createCloseBookSource({ touch: () => null, now: () => NOW, wsMaxAgeMs: 5_000, ticker: async () => { throw new Error('503') } })
  assert.equal(await failing.book({ instrument_token: TOKEN, tradingsymbol: SYMBOL }), null)
  const wsOnly = createCloseBookSource({ touch: () => null, now: () => NOW, wsMaxAgeMs: 5_000 })
  assert.equal(await wsOnly.book({ instrument_token: TOKEN, tradingsymbol: SYMBOL }), null)
})

// ------------------------------------------------- through the real placer

const contract: ResolvedContract = { tradingsymbol: SYMBOL, instrumentToken: TOKEN, lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA', underlying: 'BTC' }

async function place(doc: Record<string, unknown>, closePrice: (o: { desk_op?: string }) => Promise<{ limitPrice: number; note: string } | null>) {
  const orders = new FakeCollection()
  orders.docs.push({ clientOrderId: 'dec-C#0', state: 'PENDING', createdAt: NOW, tradingsymbol: SYMBOL, quantity: 0.005, tag: 'BULLS-BTC-D1', underlying: 'BTC', mode: 'paper', ...doc })
  const events = new FakeJournal()
  const sim = new SimulatorAdapter({ runId: 'test' })
  const placed: OrderIntent[] = []
  const broker = {
    placeOrder: async (i: OrderIntent): Promise<PlacedOrder> => {
      placed.push(i)
      return await sim.placeOrder(i)
    },
  }
  const now = (): number => NOW
  const queue = new OrderQueue({ collection: orders, workerId: 'w1', now })
  const journal = new OrderJournal({ collection: events, now })
  const watcher = new FillWatcher({ fills: new FakeFills(), queue, journal, now, log: () => {}, wake: () => {} })
  const asked: string[] = []
  const placer = createOrderPlacer({
    queue,
    journal,
    fills: watcher,
    adapterFor: () => ({ adapter: broker, rail: 'live', note: '' }),
    resolveContract: (s) => (s === SYMBOL ? contract : null),
    freeze: () => new FreezeLimits([]),
    closePrice: async (o, id) => {
      asked.push(id)
      return closePrice(o)
    },
    allowsLive: async () => true,
    readHalt: async () => ({ state: 'off' as const, reason: '' }),
    linkRefusal: () => null,
    orderMaxAgeMs: 300_000,
    sweepArmed: () => false,
    now,
    log: () => {},
  })
  const sweeper = createSweeper({ claimNext: () => queue.claimNext(), handle: (d) => placer.processOne(d), log: () => {}, now })
  await sweeper.sweep()
  return { placed, asked, events }
}

test('placer: a close goes out at the touch-based LIMIT, a MARKET close included, reduce-only stays on', async () => {
  for (const priced of [
    { order_type: 'LIMIT', limitPrice: 15 },
    { order_type: 'MARKET' },
  ]) {
    const { placed, asked, events } = await place(
      { transaction_type: 'BUY', desk_op: 'close', ...priced },
      async () => ({ limitPrice: 20.4, note: 'ask 20 + 2% (ws)' }),
    )
    assert.deepEqual(asked, ['dec-C#0'])
    assert.equal(placed.length, 1)
    assert.equal(placed[0]?.orderType, 'LIMIT')
    assert.equal(placed[0]?.limitPrice, 20.4)
    assert.equal(placed[0]?.meta?.['desk_op'], 'close', 'the adapter sends reduce_only off desk_op close')
    const planned = events.rows.find((r) => r['phase'] === 'PLANNED')
    assert.match(String((planned?.['detail'] as Record<string, unknown>)?.['closePriced'] ?? ''), /ask 20 \+ 2%/)
  }
})

test('placer: an open is never asked; a close with no book keeps its own price', async () => {
  const open = await place({ transaction_type: 'SELL', desk_op: 'open', order_type: 'LIMIT', limitPrice: 15 }, async () => ({ limitPrice: 1, note: '' }))
  assert.deepEqual(open.asked, [])
  assert.equal(open.placed[0]?.limitPrice, 15)
  const none = await place({ transaction_type: 'BUY', desk_op: 'close', order_type: 'LIMIT', limitPrice: 15 }, async () => null)
  assert.equal(none.placed[0]?.limitPrice, 15)
})

test('placer: a pricer that throws does not stop the exit — it goes out at its own price', async () => {
  const r = await place({ transaction_type: 'BUY', desk_op: 'close', order_type: 'LIMIT', limitPrice: 15 }, async () => {
    throw new Error('boom')
  })
  assert.equal(r.placed.length, 1)
  assert.equal(r.placed[0]?.limitPrice, 15)
})
