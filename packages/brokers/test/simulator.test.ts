import test from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter } from '../src/index.ts'
import type { OrderIntent } from '@algomaker/order-bus'

const INST = { tradingsymbol: 'NIFTY_CE', instrumentToken: 42, lotSize: 25, tickSize: 0.05, exchange: 'NFO' }

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    clientOrderId: 'c1', ts: 1, strategyTag: 'T', mode: 'sim', destinations: ['sim'],
    instrument: INST, side: 'BUY', orderType: 'MARKET', quantity: 25, lots: 1,
    ...over,
  }
}

test('a MARKET order fills immediately at the last tick', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const o = await sim.placeOrder(intent())
  assert.equal(o.status, 'FILLED')
  assert.equal(o.avgPrice, 120)
  assert.equal(o.filledQty, 25)
})

test('a MARKET order with no tick fed yet is REJECTED, never a priceless FILLED', async () => {
  // types.ts states the invariant: avgPrice is "Broker-reported average fill.
  // NEVER inferred locally — D3 depends on it." A MARKET order placed before
  // any tick arrives has no real price to report, so it must not fabricate a
  // FILLED with avgPrice: null — the resting path already refuses on the same
  // principle when trigger is missing.
  const sim = new SimulatorAdapter()
  const o = await sim.placeOrder(intent())
  assert.equal(o.status, 'REJECTED')
  assert.equal(o.avgPrice, null)
  assert.equal(o.filledQty, 0)
  assert.ok(o.rejectReason)
})

test('capabilities declare orders and modify but not market data', () => {
  const sim = new SimulatorAdapter()
  assert.equal(sim.capabilities.orders, true)
  assert.equal(sim.capabilities.modify, true)
  assert.equal(sim.capabilities.marketData, false)
})

test('an SL_MARKET order RESTS and does not fill immediately', async () => {
  // This is what the legacy simulator could not do: paperstream.js:353 drops
  // every 'Pending' order, so resting SL/target were untestable in paper.
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const o = await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  assert.equal(o.status, 'WORKING')
  assert.equal(o.filledQty, 0)
})

test('a resting SELL SL_MARKET fills when a tick crosses DOWN through the trigger', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })

  await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  sim.feedTick(42, 105)
  assert.deepEqual(fills, [], 'above the trigger, must not fill')

  sim.feedTick(42, 99)
  assert.deepEqual(fills, ['sl'], 'crossing down through the trigger fills it')
})

test('a resting BUY SL_MARKET fills when a tick crosses UP through the trigger', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 100)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })

  await sim.placeOrder(intent({ clientOrderId: 'buysl', side: 'BUY', orderType: 'SL_MARKET', triggerPrice: 120 }))
  sim.feedTick(42, 119)
  assert.deepEqual(fills, [])
  sim.feedTick(42, 121)
  assert.deepEqual(fills, ['buysl'])
})

test('a LIMIT SELL fills only when the tick trades THROUGH the limit', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 100)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })

  await sim.placeOrder(intent({ clientOrderId: 'tgt', side: 'SELL', orderType: 'LIMIT', limitPrice: 150 }))
  sim.feedTick(42, 149)
  assert.deepEqual(fills, [], 'below the limit, a sell must not fill')
  sim.feedTick(42, 151)
  assert.deepEqual(fills, ['tgt'])
})

test('SL_MARKET fills at the crossing tick, with configurable slippage', async () => {
  const sim = new SimulatorAdapter({ slippage: 0.5 })
  sim.feedTick(42, 120)
  let price: number | null = null
  sim.onFill((o) => { if (o.status === 'FILLED') price = o.avgPrice })
  await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  sim.feedTick(42, 98)
  // A SELL stop slips DOWN — against the seller.
  assert.equal(price, 97.5)
})

test('a tick exactly ON the trigger does not fire (strict inequality, not touch-or-cross)', async () => {
  // Documents the deliberate choice in #crosses: this delays the fill rather
  // than making it optimistic, but it is a real deviation from typical broker
  // touch-or-cross semantics.
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })

  await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  sim.feedTick(42, 100) // exactly on the trigger
  assert.deepEqual(fills, [], 'a tick exactly on the trigger must not fire yet')
  sim.feedTick(42, 99.99)
  assert.deepEqual(fills, ['sl'], 'crossing past it does fire')
})

test('cancelling a resting order stops it filling', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })
  const o = await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  assert.equal(await sim.cancelOrder(o.brokerOrderId), true)
  sim.feedTick(42, 90)
  assert.deepEqual(fills, [])
})

test('positions() reflects net quantity after a MARKET fill', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  await sim.placeOrder(intent({ clientOrderId: 'a', side: 'BUY', quantity: 25 }))
  const positions = await sim.positions()
  assert.deepEqual(positions, [{ tradingsymbol: 'NIFTY_CE', netQty: 25, avgPrice: 120 }])
})

test('positions() nets to flat and drops the symbol after an equal-and-opposite fill', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  await sim.placeOrder(intent({ clientOrderId: 'a', side: 'BUY', quantity: 25 }))
  sim.feedTick(42, 130)
  await sim.placeOrder(intent({ clientOrderId: 'b', side: 'SELL', quantity: 25 }))
  assert.deepEqual(await sim.positions(), [])
})

test('orderBook() lists resting orders, not filled or cancelled ones', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const resting = await sim.placeOrder(
    intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }),
  )
  await sim.placeOrder(intent({ clientOrderId: 'mkt', side: 'BUY', quantity: 25 })) // fills immediately
  const book = await sim.orderBook()
  assert.equal(book.length, 1)
  assert.equal(book[0]?.brokerOrderId, resting.brokerOrderId)
  assert.equal(book[0]?.clientOrderId, 'sl')
  assert.equal(book[0]?.status, 'WORKING')
})

test('onOrderUpdate forwards WORKING, CANCELLED and REJECTED, not just FILLED', async () => {
  // Per the interface contract: every onOrderUpdate should drive a WAL STATUS
  // record, and OCO-pair cancellation depends on seeing the other leg's
  // status change — an adapter that forwards only fills silently drops
  // broker rejections and cancels.
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const seen: string[] = []
  sim.onOrderUpdate((o) => seen.push(o.status))

  const resting = await sim.placeOrder(
    intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }),
  )
  await sim.cancelOrder(resting.brokerOrderId)
  await sim.placeOrder(intent({ clientOrderId: 'bad', orderType: 'LIMIT' })) // no limitPrice -> rejected

  assert.deepEqual(seen, ['WORKING', 'CANCELLED', 'REJECTED'])
})

test('onFill is still a working alias for onOrderUpdate', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const seen: string[] = []
  sim.onFill((o) => seen.push(o.status))
  await sim.placeOrder(intent({ clientOrderId: 'a' }))
  assert.deepEqual(seen, ['FILLED'])
})

test('modifyOrder reprices a resting order atomically', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })
  const o = await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))

  assert.equal(await sim.modifyOrder(o.brokerOrderId, 110), true)
  sim.feedTick(42, 109)
  assert.deepEqual(fills, ['sl'], 'the NEW trigger applies')
})

// ------------------------------------------------------- paper fills on the touch
//
// A marketable limit TAKES THE TOUCH — a buy at the ask, a sell at the bid — the way an exchange
// fills it, instead of resting until a print trades through it. That wait is how the 2026-10-01
// SENSEX hedge was stranded: its close sat under the bid, the put kept falling, and no print above
// the limit ever came (docs/reports/2026-10-04-delta-lean-review.md §2.5). Everything else — the
// through-print rule and the stops — is pinned below to be exactly what it was.

/** Every FILLED update as [clientOrderId, avgPrice], in the order they landed. */
function fillLog(sim: SimulatorAdapter): [string, number | null][] {
  const log: [string, number | null][] = []
  sim.onFill((o) => {
    if (o.status === 'FILLED') log.push([o.clientOrderId, o.avgPrice])
  })
  return log
}

/** A LIMIT on the test token. */
function limitOrder(clientOrderId: string, side: 'BUY' | 'SELL', limitPrice: number): OrderIntent {
  return intent({ clientOrderId, side, orderType: 'LIMIT', limitPrice })
}

test('the 1 Oct close: a sell limit under the bid fills at the bid though no print ever trades above it', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 140)
  await sim.placeOrder(limitOrder('close', 'SELL', 136.65))
  // The put is falling: the last print (136.2) is under the limit, so the old rule waited for a print
  // above it for ever — while the book still bid 137.35, which a real exchange fills at once.
  sim.feedTick(42, 136.2, { bid: 137.35, ask: 137.7 })
  assert.deepEqual(fills, [['close', 137.35]])
})

test('a resting BUY LIMIT fills at the ASK when the touch is inside its limit, not at the print', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 120)
  await sim.placeOrder(limitOrder('b', 'BUY', 105))
  // The print (103) is under the limit, so the old rule filled at 103. The ask is what a marketable
  // limit takes.
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [['b', 101]])
  // Filled once: the order is gone, so a second crossing tick has nothing to fill.
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [['b', 101]])
  assert.equal(sim.restingCount, 0)
})

test('a BUY LIMIT fills on the ask with NO print through it', async () => {
  // The case the old rule could never fill: the last print (103) is ABOVE the limit (102), so no tick
  // trades through it — yet the ask (101) is inside the limit.
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 120)
  await sim.placeOrder(limitOrder('b', 'BUY', 102))
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [['b', 101]])
})

test('a resting SELL LIMIT fills at the BID when the bid is inside its limit', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 100)
  await sim.placeOrder(limitOrder('s', 'SELL', 100))
  // The print (99) is not over the limit, so nothing has traded through it; the bid (102) is over it.
  sim.feedTick(42, 99, { bid: 102, ask: 103 })
  assert.deepEqual(fills, [['s', 102]])
})

for (const c of [
  { side: 'BUY', limit: 105, print: 100, quote: { bid: 103, ask: 104 }, takes: 104 },
  { side: 'SELL', limit: 100, print: 105, quote: { bid: 102, ask: 103 }, takes: 102 },
] as const) {
  test(`a marketable ${c.side} limit pays the spread: it takes the touch, not the kinder print`, async () => {
    const sim = new SimulatorAdapter()
    const fills = fillLog(sim)
    sim.feedTick(42, 110)
    await sim.placeOrder(limitOrder('o', c.side, c.limit))
    // The print would have filled it at a better price than the book offers now. The book is the market
    // that exists when the order arrives; the print is a memory of one that has moved.
    sim.feedTick(42, c.print, c.quote)
    assert.deepEqual(fills, [['o', c.takes]])
  })
}

for (const c of [
  // The ask (100.5) is over the buy limit and the print (100.2) is not under it: neither rule fires.
  { side: 'BUY', print: 100.2, quote: { bid: 100, ask: 100.5 } },
  // The mirror: the bid (99.5) is under the sell limit and the print (99.8) is not over it.
  { side: 'SELL', print: 99.8, quote: { bid: 99.5, ask: 100 } },
] as const) {
  test(`a ${c.side} limit the touch does not cross and no print has traded through does not fill`, async () => {
    const sim = new SimulatorAdapter()
    const fills = fillLog(sim)
    sim.feedTick(42, 100)
    await sim.placeOrder(limitOrder('o', c.side, 100))
    sim.feedTick(42, c.print, c.quote)
    assert.deepEqual(fills, [])
    assert.equal(sim.restingCount, 1)
  })
}

test('the old rule is untouched: a limit still fills at the print on a trade-through tick with no quote', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 100)
  await sim.placeOrder(limitOrder('b', 'BUY', 100))
  sim.feedTick(42, 99.5)
  assert.deepEqual(fills, [['b', 99.5]])

  await sim.placeOrder(limitOrder('s', 'SELL', 100))
  sim.feedTick(42, 100.5)
  assert.deepEqual(fills, [['b', 99.5], ['s', 100.5]])
})

test('a print through the limit still fills when the quote does not cross it', async () => {
  // The quote adds a way to fill; it must never take one away. Here the book (ask 101 / bid 99) is
  // outside both limits, so only the through-print rule fires — at the print.
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 100)
  await sim.placeOrder(limitOrder('b', 'BUY', 100))
  await sim.placeOrder(limitOrder('s', 'SELL', 100))
  sim.feedTick(42, 99.5, { bid: 99, ask: 101 })
  assert.deepEqual(fills, [['b', 99.5]])
  sim.feedTick(42, 100.5, { bid: 99, ask: 101 })
  assert.deepEqual(fills, [['b', 99.5], ['s', 100.5]])
})

test('the touch rule is touch-or-cross; the through-print rule stays strict', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 100)
  await sim.placeOrder(limitOrder('b', 'BUY', 100))
  await sim.placeOrder(limitOrder('s', 'SELL', 100))
  // A print exactly ON the limit has not traded through it (the deliberate choice in #crosses).
  sim.feedTick(42, 100)
  assert.deepEqual(fills, [])
  // An ask exactly AT the buy limit is a seller at the buyer's price: that is a match. Likewise a bid.
  sim.feedTick(42, 100, { bid: 99.5, ask: 100 })
  assert.deepEqual(fills, [['b', 100]])
  sim.feedTick(42, 100, { bid: 100, ask: 100.5 })
  assert.deepEqual(fills, [['b', 100], ['s', 100]])
})

for (const orderType of ['SL_MARKET', 'SL_LIMIT'] as const) {
  test(`${orderType} is unchanged by a quote: only a print through the trigger fires it, at the print less slippage`, async () => {
    const sim = new SimulatorAdapter({ slippage: 0.5 })
    const fills = fillLog(sim)
    sim.feedTick(42, 110)
    await sim.placeOrder(
      intent({ clientOrderId: 'sell-stop', side: 'SELL', orderType, triggerPrice: 100, limitPrice: 99 }),
    )
    await sim.placeOrder(
      intent({ clientOrderId: 'buy-stop', side: 'BUY', orderType, triggerPrice: 120, limitPrice: 121 }),
    )

    // The BOOK is through both triggers (a bid under 100, an ask over 120) while the PRINT is through
    // neither: a stop is armed by what traded, so a quote must not fire it.
    sim.feedTick(42, 110, { bid: 99, ask: 121 })
    assert.deepEqual(fills, [])

    // The PRINT is through the sell stop while the book sits far above it: it fires at the print less
    // slippage, not at the bid.
    sim.feedTick(42, 98, { bid: 130, ask: 131 })
    assert.deepEqual(fills, [['sell-stop', 97.5]])

    // And the buy stop likewise, at the print plus slippage, not at the ask.
    sim.feedTick(42, 121, { bid: 90, ask: 91 })
    assert.deepEqual(fills, [['sell-stop', 97.5], ['buy-stop', 121.5]])
  })
}

for (const c of [
  // No bid, so no sell-touch fill (and the print 99 is not over the sell limit).
  { side: 'SELL', missing: 'bid', print: 99, quote: { bid: null, ask: 99 } },
  // No ask, so no buy-touch fill (and the print 101 is not under the buy limit).
  { side: 'BUY', missing: 'ask', print: 101, quote: { bid: 101, ask: null } },
] as const) {
  test(`a quote with a null ${c.missing} does not trigger a ${c.side.toLowerCase()}-touch fill`, async () => {
    const sim = new SimulatorAdapter()
    const fills = fillLog(sim)
    sim.feedTick(42, 100)
    await sim.placeOrder(limitOrder('o', c.side, 100))
    sim.feedTick(42, c.print, c.quote)
    assert.deepEqual(fills, [])
  })
}

test('the previous tick’s bid is not kept when the next quote has none', async () => {
  // "Last known touch" is one book, replaced whole: a bid the market no longer shows must not fill a sell.
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 99, { bid: 102, ask: 103 })
  await sim.placeOrder(limitOrder('s', 'SELL', 100))
  sim.feedTick(42, 99, { bid: null, ask: 103 })
  assert.deepEqual(fills, [])
})

test('a one-sided quote still fills from the side it has', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 110)
  await sim.placeOrder(limitOrder('b', 'BUY', 105))
  sim.feedTick(42, 110, { bid: null, ask: 101 })
  assert.deepEqual(fills, [['b', 101]])

  await sim.placeOrder(limitOrder('s', 'SELL', 100))
  sim.feedTick(42, 90, { bid: 102, ask: null })
  assert.deepEqual(fills, [['b', 101], ['s', 102]])
})

test('a quote side that is zero, negative or not finite is no touch — never a fill at 0 or Infinity', async () => {
  // Absent is never zero. Unguarded, `0 <= 100` fills a buy for nothing and `Infinity >= 100` fills a
  // sell at Infinity; every comparison against NaN is false, so NaN only ever means "no". The other
  // side is null so that nothing but the side's own value can be what stops the fill — beside a real
  // bid, an ask of 0 would read as a crossed book and be refused for that reason instead.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const sim = new SimulatorAdapter()
    const fills = fillLog(sim)
    sim.feedTick(42, 100)
    await sim.placeOrder(limitOrder('b', 'BUY', 100))
    await sim.placeOrder(limitOrder('s', 'SELL', 100))
    sim.feedTick(42, 100, { bid: null, ask: bad })
    sim.feedTick(42, 100, { bid: bad, ask: null })
    assert.deepEqual(fills, [], `a ${bad} side must not fill anything`)
    assert.equal(sim.restingCount, 2)
  }
})

test('a crossed quote (ask under bid) is a bad frame, not a touch', async () => {
  // The gateway's QuoteMap drops the same frame; a fill model that acted on it would be testing a
  // market the peg never saw.
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 100)
  await sim.placeOrder(limitOrder('b', 'BUY', 100))
  await sim.placeOrder(limitOrder('s', 'SELL', 100))
  sim.feedTick(42, 100, { bid: 99, ask: 98 })
  sim.feedTick(42, 100, { bid: 102, ask: 101 })
  assert.deepEqual(fills, [])
})

test('a locked market (bid equal to ask) is a real touch', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 101)
  await sim.placeOrder(limitOrder('b', 'BUY', 100))
  sim.feedTick(42, 101, { bid: 100, ask: 100 })
  assert.deepEqual(fills, [['b', 100]])
})

test('an order placed while the touch already crosses it rests, then fills on the next tick for its token', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  const placed = await sim.placeOrder(limitOrder('b', 'BUY', 102))
  // Placement is unchanged: a limit answers WORKING and a tick delivers the fill, as it always did.
  assert.equal(placed.status, 'WORKING')
  assert.deepEqual(fills, [])
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [['b', 101]])
})

test('the next tick may carry no quote: the touch the order was placed against still fills it', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  await sim.placeOrder(limitOrder('b', 'BUY', 102))
  sim.feedTick(42, 103)
  assert.deepEqual(fills, [['b', 101]])
})

test('the touch serves ONE quote-less tick and is then forgotten — it is never a standing price', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  sim.feedTick(42, 103) // the book has gone: the remembered touch gets its one look, then it is stale
  await sim.placeOrder(limitOrder('late', 'BUY', 102))
  sim.feedTick(42, 103)
  assert.deepEqual(fills, [], 'an order placed after the book vanished has no touch to take')
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [['late', 101]], 'a fresh quote fills it')
})

test('one token’s touch never fills another token’s order', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 103)
  await sim.placeOrder(limitOrder('b', 'BUY', 105))
  sim.feedTick(43, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [])
  sim.feedTick(42, 106, { bid: 105.5, ask: 106.5 })
  assert.deepEqual(fills, [], 'and its own touch (ask 106.5) is over the limit')
})

test('a limit repriced into the book fills on the next tick at the touch, not at its new limit', async () => {
  const sim = new SimulatorAdapter()
  const fills = fillLog(sim)
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  const o = await sim.placeOrder(limitOrder('b', 'BUY', 95))
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [])
  assert.equal(await sim.modifyOrder(o.brokerOrderId, 102), true)
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(fills, [['b', 101]])
})

test('a touch fill books the position at the touch price', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  await sim.placeOrder(limitOrder('b', 'BUY', 105))
  sim.feedTick(42, 103, { bid: 100, ask: 101 })
  assert.deepEqual(await sim.positions(), [{ tradingsymbol: 'NIFTY_CE', netQty: 25, avgPrice: 101 }])
})
