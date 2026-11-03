/**
 * The pure half of the repair Apply button, exercised directly.
 *
 * `repair-routes.test.ts` proves the endpoint end to end; this file pins the
 * decisions at the level they are MADE — a move becoming an order, a size
 * walking the book for its price — with no store, no chain service and no
 * clock beyond the one passed in. Everything under test is a total function,
 * so every case is a literal in and a literal out.
 *
 * What these tests are really guarding is IDENTITY: the leg a `close` names is
 * the leg the operator saw on the card, and the only join between the two is
 * the id `assemble` hands out (`routes/payoff.ts:640-648`). A drift of one in
 * that counter closes the wrong pocket of a doubled contract, for real money,
 * with every screen still reading correct.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deltaPictures, estimateFill, legsPrint, resolveOrders } from '../src/repair-plan.ts'
import { DEFAULT_RATE, type Move } from '@algomaker/payoff'
import { bookGreeks, carryYield, yearsToExpiry, type PositionLeg } from '@algomaker/greeks'
import type { BridgeLeg } from '../src/contract.ts'
import type { ChainResponse } from '../src/chain.ts'

const EXPIRY = '2026-08-26'

const leg = (ts: string, strike: number, type: 'CE' | 'PE', qty: number): BridgeLeg => ({
  deskTag: `py:${ts}:${qty}`,
  underlying: 'TCS',
  expiry: EXPIRY,
  strike,
  type,
  side: qty < 0 ? 'Sell' : 'Buy',
  qty,
  entryPrice: 10,
  openedTs: 1,
  instrument: { tradingsymbol: ts, instrumentToken: 1, lotSize: 175, tickSize: 0.05, exchange: 'NFO' },
})

/**
 * A chain listing exactly ONE contract — the one an open has to resolve
 * against. Every other strike is absent, which is the state a `dropped` move
 * has to be able to tell apart from "present but unquoted".
 */
const chainFixtureWithContract = (
  strike: number,
  type: 'CE' | 'PE',
  tradingsymbol: string,
  instrumentToken: number,
): ChainResponse => ({
  underlying: 'TCS',
  expiry: EXPIRY,
  spot: 2300,
  spotAsOf: 1,
  future: 2310,
  futureAsOf: 1,
  step: 20,
  lotSize: 175,
  rows: [
    {
      strike,
      CE: null,
      PE: null,
      ...(type === 'CE'
        ? { ceContract: { tradingsymbol, instrumentToken, lotSize: 175, tickSize: 0.05, exchange: 'NFO' } }
        : { peContract: { tradingsymbol, instrumentToken, lotSize: 175, tickSize: 0.05, exchange: 'NFO' } }),
    },
  ],
  feedAlive: true,
})

// ------------------------------------------------------ moves become orders

test('close of a short leg is a Buy for its full size, wave close', () => {
  const r = resolveOrders({
    legs: [leg('TCS26AUG2280PE', 2280, 'PE', -175)],
    moves: [{ op: 'close', legId: 'TCS26AUG2280PE' }],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.dropped.length, 0)
  assert.deepEqual(
    r.orders.map((o) => [o.wave, o.side, o.lots, o.reducesExposure]),
    [['close', 'Buy', 1, true]],
  )
})

test('close of a LONG leg is a Sell — the sign is the side, never the stored word', () => {
  const long = { ...leg('TCS26AUG2400CE', 2400, 'CE', 350), side: 'Sell' as const }
  const r = resolveOrders({
    legs: [long],
    moves: [{ op: 'close', legId: 'TCS26AUG2400CE' }],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(
    r.orders.map((o) => [o.side, o.lots, o.strike, o.type, o.expiry]),
    [['Sell', 2, 2400, 'CE', EXPIRY]],
  )
})

test('a shift is two orders: close the leg, open at the new strike from the chain', () => {
  const chain = chainFixtureWithContract(2260, 'PE', 'TCS26AUG2260PE', 222)
  const r = resolveOrders({
    legs: [leg('TCS26AUG2440PE', 2440, 'PE', -350)],
    moves: [{ op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2260 }],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => [o.wave, o.side, o.instrument.tradingsymbol, o.lots]), [
    ['close', 'Buy', 'TCS26AUG2440PE', 2],
    ['open', 'Sell', 'TCS26AUG2260PE', 2],
  ])
  assert.equal(r.orders[1]!.moveIndex, 0)
  assert.deepEqual(
    { token: r.orders[1]!.instrument.instrumentToken, strike: r.orders[1]!.strike, type: r.orders[1]!.type },
    { token: 222, strike: 2260, type: 'PE' },
  )
})

test('a close carries the leg it closes — the driver books its P&L off that id', () => {
  // `absorb_bridge_closes` books a leg's realized P&L only when a confirmed
  // close trade carries the leg's OWN id (`translate.py`). Without this the
  // fill is tagged with the repair's clientOrderId, the driver drops the leg
  // "P&L is NOT booked", and the money vanishes out of `cum_realized`.
  const chain = chainFixtureWithContract(2260, 'PE', 'TCS26AUG2260PE', 222)
  const held = leg('TCS26AUG2440PE', 2440, 'PE', -350)
  const r = resolveOrders({
    legs: [held, leg('TCS26AUG2280PE', 2280, 'PE', -175)],
    moves: [
      { op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2260 },
      { op: 'close', legId: 'TCS26AUG2280PE' },
      { op: 'hedge', strike: 2260, type: 'PE', qty: -175 },
    ],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })

  assert.deepEqual(r.dropped, [])
  assert.deepEqual(
    r.orders.map((o) => [o.wave, o.deskTag]),
    [
      // A shift's close is a close: it takes a leg off, and the P&L of taking
      // it off is the leg's.
      ['close', held.deskTag],
      ['close', 'py:TCS26AUG2280PE:-175'],
      // An OPEN closes no leg, so it carries none. It is a new leg, and the
      // bridge mints its identity when the fill folds.
      ['open', undefined],
      ['open', undefined],
    ],
  )
})

test('a close of a leg with no desk tag carries none rather than an empty one', () => {
  const bare = { ...leg('TCS26AUG2280PE', 2280, 'PE', -175), deskTag: '' }
  const r = resolveOrders({
    legs: [bare],
    moves: [{ op: 'close', legId: 'TCS26AUG2280PE' }],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders[0]?.deskTag, undefined)
})

test('the #n id addresses the SECOND pocket of a doubled contract', () => {
  const legs = [leg('TCS26AUG2340CE', 2340, 'CE', -175), leg('TCS26AUG2340CE', 2340, 'CE', -350)]
  const r = resolveOrders({
    legs,
    moves: [{ op: 'close', legId: 'TCS26AUG2340CE#2' }],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => o.lots), [2])
})

test('a zero-qty leg holds no id — the counter skips it exactly as assemble does', () => {
  const legs = [leg('TCS26AUG2340CE', 2340, 'CE', 0), leg('TCS26AUG2340CE', 2340, 'CE', -350)]
  const r = resolveOrders({
    legs,
    moves: [{ op: 'close', legId: 'TCS26AUG2340CE' }],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => o.lots), [2])
})

test('add with signed shares: negative qty sells, lots = |qty|/lotSize', () => {
  const chain = chainFixtureWithContract(2600, 'CE', 'TCS26AUG2600CE', 223)
  const r = resolveOrders({
    legs: [],
    moves: [{ op: 'add', strike: 2600, type: 'CE', qty: -350 }],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(
    r.orders.map((o) => [o.wave, o.side, o.lots, o.reducesExposure]),
    [['open', 'Sell', 2, false]],
  )
})

test('hedge is add by another name — the sign decides, not the word', () => {
  const chain = chainFixtureWithContract(2600, 'CE', 'TCS26AUG2600CE', 223)
  const r = resolveOrders({
    legs: [],
    moves: [{ op: 'hedge', strike: 2600, type: 'CE', qty: 175 }],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => [o.wave, o.side, o.lots]), [['open', 'Buy', 1]])
})

test('every close goes before every open, whatever order the moves arrive in', () => {
  const chain = chainFixtureWithContract(2600, 'CE', 'TCS26AUG2600CE', 223)
  const r = resolveOrders({
    legs: [leg('TCS26AUG2280PE', 2280, 'PE', -175)],
    moves: [
      { op: 'add', strike: 2600, type: 'CE', qty: -175 },
      { op: 'close', legId: 'TCS26AUG2280PE' },
    ],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => [o.wave, o.moveIndex]), [
    ['close', 1],
    ['open', 0],
  ])
})

// --------------------------------------------------------- drops, not guesses

test('drops, never guesses: unknown legId; non-integer lots; strike missing from the chain; lotSize 0', () => {
  const r1 = resolveOrders({
    legs: [],
    moves: [{ op: 'close', legId: 'NOPE' }],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r1.orders.length, 0)
  assert.equal(r1.dropped.length, 1)
  assert.match(r1.dropped[0]!, /close "NOPE": no such leg in the book/)

  const r2 = resolveOrders({
    legs: [leg('X', 100, 'CE', -100)],
    moves: [{ op: 'close', legId: 'X' }],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r2.dropped.length, 1) // 100 shares over lot 175 is not a whole number of lots
  assert.equal(r2.orders.length, 0)

  const r3 = resolveOrders({
    legs: [],
    moves: [{ op: 'add', strike: 2600, type: 'CE', qty: -175 }],
    chain: chainFixtureWithContract(2620, 'CE', 'TCS26AUG2620CE', 224),
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r3.orders.length, 0)
  assert.equal(r3.dropped.length, 1)

  const r4 = resolveOrders({
    legs: [],
    moves: [{ op: 'add', strike: 2600, type: 'CE', qty: -175 }],
    chain: chainFixtureWithContract(2600, 'CE', 'TCS26AUG2600CE', 224),
    lotSize: 0,
    bookExpiry: EXPIRY,
  })
  assert.equal(r4.orders.length, 0)
  assert.equal(r4.dropped.length, 1)
})

test('a move this bridge cannot read is DROPPED, never silently skipped', () => {
  // The apply route refuses on a non-empty `dropped`, so a move nothing here
  // understands has to stop the plan rather than quietly shrink it by one.
  const r = resolveOrders({
    legs: [],
    moves: [{ op: 'teleport' } as unknown as Move],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders.length, 0)
  assert.equal(r.dropped.length, 1)
})

test('a shift whose destination is unlisted drops BOTH halves, never half-applied', () => {
  const r = resolveOrders({
    legs: [leg('TCS26AUG2440PE', 2440, 'PE', -350)],
    moves: [{ op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2260 }],
    chain: chainFixtureWithContract(2260, 'CE', 'TCS26AUG2260CE', 225), // CE only: no 2260PE
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders.length, 0)
  assert.equal(r.dropped.length, 1)
  assert.match(r.dropped[0]!, /never half-applied/)
})

test('a shift onto the strike the leg already holds is two fills and no change — dropped', () => {
  const r = resolveOrders({
    legs: [leg('TCS26AUG2440PE', 2440, 'PE', -350)],
    moves: [{ op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2440 }],
    chain: chainFixtureWithContract(2440, 'PE', 'TCS26AUG2440PE', 226),
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders.length, 0)
  assert.equal(r.dropped.length, 1)
})

test('an add of nothing is not a tradeable leg', () => {
  const r = resolveOrders({
    legs: [],
    moves: [{ op: 'add', strike: 2600, type: 'CE', qty: 0 }],
    chain: chainFixtureWithContract(2600, 'CE', 'TCS26AUG2600CE', 227),
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders.length, 0)
  assert.equal(r.dropped.length, 1)
})

// ----------------------------------------------------------- exposure intent

test('an open that reduces an opposite holding is reducesExposure', () => {
  const chain = chainFixtureWithContract(2340, 'CE', 'TCS26AUG2340CE', 224)
  const r = resolveOrders({
    legs: [leg('TCS26AUG2340CE', 2340, 'CE', -350)],
    moves: [{ op: 'add', strike: 2340, type: 'CE', qty: 175 }],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders[0]!.reducesExposure, true) // buying against a short
})

test('exposure is NETTED across every leg on the contract, as the dialog nets it', () => {
  const chain = chainFixtureWithContract(2340, 'CE', 'TCS26AUG2340CE', 224)
  const r = resolveOrders({
    // 350 short against 350 long is flat: a further Buy adds, it does not reduce.
    legs: [leg('TCS26AUG2340CE', 2340, 'CE', -350), leg('TCS26AUG2340CE', 2340, 'CE', 350)],
    moves: [{ op: 'add', strike: 2340, type: 'CE', qty: 175 }],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders[0]!.reducesExposure, false)
})

test('an open larger than the holding it faces still reads as reducing — classifyExposure’s own rule', () => {
  // `manual-order-plan.ts:207` compares SIGNS and not sizes, and this is the
  // server-side twin of that call: the two screens must not disagree about
  // what the same order is. Netting is the only conservatism it claims.
  const chain = chainFixtureWithContract(2340, 'CE', 'TCS26AUG2340CE', 224)
  const r = resolveOrders({
    legs: [leg('TCS26AUG2340CE', 2340, 'CE', -175)],
    moves: [{ op: 'add', strike: 2340, type: 'CE', qty: 700 }],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.equal(r.orders[0]!.reducesExposure, true)
})

test('the shift’s open reduces nothing — it is the same size, the other way, on a strike the book does not hold', () => {
  const chain = chainFixtureWithContract(2260, 'PE', 'TCS26AUG2260PE', 222)
  const r = resolveOrders({
    legs: [leg('TCS26AUG2440PE', 2440, 'PE', -350)],
    moves: [{ op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2260 }],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => o.reducesExposure), [true, false])
})

// --------------------------------------------- what the size actually pays

/** A quote with a book behind it: `[price, qty]` per level, best first. */
const q = (buy: [number, number][], sell: [number, number][], ageMs = 500) => ({
  ageMs,
  depth: {
    buy: buy.map(([price, qty]) => ({ price, qty })),
    sell: sell.map(([price, qty]) => ({ price, qty })),
  },
})

test('level 1 covers: the touch is the estimate', () => {
  const e = estimateFill('Buy', 175, q([[12.3, 500]], [[12.5, 500]]))
  assert.deepEqual(e, { price: 12.5, coveredQty: 500, exceedsDepth: false, quoteAgeMs: 500 })
})

test('VWAP across levels when level 1 is thin', () => {
  const e = estimateFill('Sell', 400, q([[12.3, 100], [12.2, 300]], []))
  // 100@12.3 + 300@12.2 → (100*12.3 + 300*12.2)/400 = 12.225
  assert.equal(e?.price, 12.225)
  assert.equal(e?.exceedsDepth, false)
})

test('size past the visible book flags exceedsDepth and prices what it can see', () => {
  const e = estimateFill('Buy', 1000, q([], [[12.5, 200], [12.6, 300]]))
  assert.equal(e?.exceedsDepth, true)
  assert.equal(e?.coveredQty, 500)
  assert.equal(e?.price, (200 * 12.5 + 300 * 12.6) / 500)
})

test('no depth on the walked side → price null, coveredQty 0', () => {
  const e = estimateFill('Buy', 175, q([[12.3, 500]], []))
  assert.deepEqual(e, { price: null, coveredQty: 0, exceedsDepth: true, quoteAgeMs: 500 })
})

test('a tick that carried no book at all prices nothing, and says so', () => {
  const e = estimateFill('Sell', 175, { ageMs: 42 })
  assert.deepEqual(e, { price: null, coveredQty: 0, exceedsDepth: true, quoteAgeMs: 42 })
})

test('no quote at all → null', () => {
  assert.equal(estimateFill('Buy', 175, null), null)
  assert.equal(estimateFill('Buy', 175, undefined), null)
})

test('a level with no size and a level with no price are not levels', () => {
  const e = estimateFill('Buy', 200, q([], [[12.5, 0], [0, 500], [12.7, 200]]))
  assert.deepEqual(e, { price: 12.7, coveredQty: 200, exceedsDepth: false, quoteAgeMs: 500 })
})

// ------------------------------------- the book as it would stand, in delta

const NOW = Date.UTC(2026, 7, 21, 6, 0) // 2026-08-21 11:30 IST, five days out
const SPOT = 2300
const FUTURE = 2310

/** service.ts:1385-1397's recipe, not a restatement of its numbers. */
const carry = carryYield(SPOT, FUTURE, yearsToExpiry(EXPIRY, NOW), DEFAULT_RATE)
const OPTS = { rate: DEFAULT_RATE, ...(carry === null ? {} : { dividendYield: carry }) }

const priced = (ts: string, strike: number, type: 'CE' | 'PE', qty: number, markPrice: number): PositionLeg => ({
  tradingsymbol: ts,
  underlying: 'TCS',
  strike,
  type,
  expiry: EXPIRY,
  qty,
  spot: SPOT,
  markPrice,
})

const SHORT_PE = priced('TCS26AUG2280PE', 2280, 'PE', -350, 30)
const LONG_CE = priced('TCS26AUG2400CE', 2400, 'CE', 175, 12)
const BOOK = [SHORT_PE, LONG_CE]

test('the panel answers in the Positions page’s own engine, not a second one', () => {
  const p = deltaPictures({ current: BOOK, after: BOOK, spot: SPOT, nowMs: NOW, greekOpts: OPTS })
  const g = bookGreeks(BOOK, NOW, OPTS)
  assert.equal(p.current.all.netDelta, g.netDelta)
  assert.equal(p.current.all.netGamma, g.netGamma)
  assert.ok(g.netDelta !== 0) // the fixture prices, or the equality above is vacuous
})

test('shortsOnly is the same engine over the short legs — the longs are the hedges', () => {
  const p = deltaPictures({ current: BOOK, after: BOOK, spot: SPOT, nowMs: NOW, greekOpts: OPTS })
  const g = bookGreeks(BOOK.filter((l) => l.qty < 0), NOW, OPTS)
  assert.equal(p.current.shortsOnly.netDelta, g.netDelta)
  assert.equal(p.current.shortsOnly.netGamma, g.netGamma)
  assert.notEqual(p.current.shortsOnly.netDelta, p.current.all.netDelta)
})

test('Δ0 is spot − netΔ/netΓ, and the pct is its distance from spot', () => {
  const p = deltaPictures({ current: BOOK, after: BOOK, spot: SPOT, nowMs: NOW, greekOpts: OPTS })
  const g = bookGreeks(BOOK, NOW, OPTS)
  const price = SPOT - g.netDelta / g.netGamma
  assert.deepEqual(p.current.all.neutral, { price, pct: ((price - SPOT) / SPOT) * 100 })
})

test('no spot, no Δ0 — the formula is denominated in it', () => {
  const p = deltaPictures({ current: BOOK, after: BOOK, spot: null, nowMs: NOW, greekOpts: OPTS })
  assert.equal(p.current.all.neutral, null)
  assert.notEqual(p.current.all.netDelta, null) // the greeks still hold; only Δ0 needs spot
})

test('a book with no convexity has no price that neutralises it', () => {
  const flat = [SHORT_PE, { ...SHORT_PE, qty: 350 }]
  const p = deltaPictures({ current: flat, after: flat, spot: SPOT, nowMs: NOW, greekOpts: OPTS })
  assert.equal(p.current.all.netGamma, 0)
  assert.equal(p.current.all.neutral, null)
})

test('nothing priced reports null, never a 0 that reads as flat', () => {
  const unpriceable = [priced('TCS26AUG2280PE', 2280, 'PE', -350, 0)]
  const p = deltaPictures({ current: unpriceable, after: [], spot: SPOT, nowMs: NOW, greekOpts: OPTS })
  assert.deepEqual(p.current.all, { netDelta: null, netGamma: null, neutral: null })
  assert.deepEqual(p.after.all, { netDelta: null, netGamma: null, neutral: null })
})

test('closing the short in the hypothetical book moves delta by exactly that leg’s own', () => {
  const p = deltaPictures({ current: BOOK, after: [LONG_CE], spot: SPOT, nowMs: NOW, greekOpts: OPTS })
  const one = bookGreeks([SHORT_PE], NOW, OPTS).netDelta
  const moved = (p.current.all.netDelta ?? 0) - (p.after.all.netDelta ?? 0)
  assert.ok(Math.abs(moved - one) < 1e-9, `${moved} vs ${one}`)
  // And the shorts-only picture empties out with it.
  assert.deepEqual(p.after.shortsOnly, { netDelta: null, netGamma: null, neutral: null })
})

test('fallbackVol is DECLARED on the options this module passes down, not smuggled through', () => {
  // A leg whose mark admits no vol is out of `bookGreeks` altogether — the test
  // above pins that. The Positions engine rescues it at the book's median vol,
  // and the panel has to be able to say so IN ITS TYPE: `deltaPictures` hands
  // its `greekOpts` straight to `bookGreeks`, so a caller passing the model vol
  // as an object literal must compile rather than be told the key is excess.
  const unpriceable = [priced('TCS26AUG2280PE', 2280, 'PE', -350, 0)]
  const opts = { ...OPTS, fallbackVol: 0.28 }
  const p = deltaPictures({ current: unpriceable, after: unpriceable, spot: SPOT, nowMs: NOW, greekOpts: opts })
  assert.equal(typeof p.current.all.netDelta, 'number')
  assert.equal(p.current.all.netDelta, bookGreeks(unpriceable, NOW, opts).netDelta)
})

// -------------------------------------------- one leg, one move, and no more

test('a legId addressed twice places ONE order — the repeat is dropped and named', () => {
  const r = resolveOrders({
    legs: [leg('TCS26AUG2280PE', 2280, 'PE', -350)],
    moves: [
      { op: 'close', legId: 'TCS26AUG2280PE' },
      { op: 'close', legId: 'TCS26AUG2280PE' },
    ],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  // TWO full-size closes of a two-lot short is a two-lot LONG, opened by the
  // repair that was closing it. One order, and the second move named.
  assert.deepEqual(r.orders.map((o) => [o.wave, o.side, o.lots]), [['close', 'Buy', 2]])
  assert.equal(r.dropped.length, 1)
  assert.match(r.dropped[0]!, /close "TCS26AUG2280PE": that leg is already taken by an earlier move/)
})

test('shift then close of the same leg: the shift stands, the close is the repeat', () => {
  const chain = chainFixtureWithContract(2260, 'PE', 'TCS26AUG2260PE', 222)
  const r = resolveOrders({
    legs: [leg('TCS26AUG2440PE', 2440, 'PE', -350)],
    moves: [
      { op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2260 },
      { op: 'close', legId: 'TCS26AUG2440PE' },
    ],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => [o.wave, o.instrument.tradingsymbol]), [
    ['close', 'TCS26AUG2440PE'],
    ['open', 'TCS26AUG2260PE'],
  ])
  assert.equal(r.dropped.length, 1)
  assert.match(r.dropped[0]!, /already taken by an earlier move/)
})

test('the two pockets of a doubled contract are two legs — neither is the other’s repeat', () => {
  const legs = [leg('TCS26AUG2340CE', 2340, 'CE', -175), leg('TCS26AUG2340CE', 2340, 'CE', -350)]
  const r = resolveOrders({
    legs,
    moves: [
      { op: 'close', legId: 'TCS26AUG2340CE' },
      { op: 'close', legId: 'TCS26AUG2340CE#2' },
    ],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.dropped, [])
  assert.deepEqual(r.orders.map((o) => o.lots), [1, 2])
})

test('a repeat of a move that was itself dropped is not a repeat — nothing claimed the leg', () => {
  const r = resolveOrders({
    // 2440 onto 2440 is a no-op shift and is dropped; the close behind it is
    // then the only move that ever addressed the leg, and must still resolve.
    legs: [leg('TCS26AUG2440PE', 2440, 'PE', -350)],
    moves: [
      { op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2440 },
      { op: 'close', legId: 'TCS26AUG2440PE' },
    ],
    chain: null,
    lotSize: 175,
    bookExpiry: EXPIRY,
  })
  assert.deepEqual(r.orders.map((o) => [o.wave, o.lots]), [['close', 2]])
  assert.equal(r.dropped.length, 1)
  assert.doesNotMatch(r.dropped[0]!, /already taken/)
})

// ------------------------------------------- the menu's legs, fingerprinted

test('legsPrint moves when the book does, and only then', () => {
  const a = [
    { tradingsymbol: 'TCS26AUG2440PE', qty: -350, entryPrice: 41.2 },
    { tradingsymbol: 'TCS26AUG2400CE', qty: 175, entryPrice: 12.05 },
  ]
  assert.equal(legsPrint(a), legsPrint([...a]), 'the same book prints the same')
  assert.notEqual(legsPrint(a), legsPrint([a[1]!, a[0]!]), 'ORDER is identity — the ids are positional')
  assert.notEqual(
    legsPrint(a),
    legsPrint([{ ...a[0]!, qty: -175 }, a[1]!]),
    'a resized leg is a different book',
  )
  assert.notEqual(legsPrint(a), legsPrint([a[0]!]), 'a closed leg is a different book')
  assert.notEqual(
    legsPrint(a),
    legsPrint([{ ...a[0]!, entryPrice: 40 }, a[1]!]),
    're-entered at another price is a different book',
  )
})

test('legsPrint reads a served leg id and a raw tradingsymbol as the same leg', () => {
  // The menu serves `#2`-suffixed ids; the book a preflight recomputes from
  // carries bare tradingsymbols. Two spellings of one book must print alike, or
  // the guard fires on every doubled contract, forever.
  assert.equal(
    legsPrint([
      { tradingsymbol: 'TCS26AUG2340CE', qty: -175, entryPrice: 9 },
      { tradingsymbol: 'TCS26AUG2340CE#2', qty: -350, entryPrice: 8 },
    ]),
    legsPrint([
      { tradingsymbol: 'TCS26AUG2340CE', qty: -175, entryPrice: 9 },
      { tradingsymbol: 'TCS26AUG2340CE', qty: -350, entryPrice: 8 },
    ]),
  )
})

test('legsPrint skips a flattened pocket, exactly as the id counter does', () => {
  assert.equal(
    legsPrint([
      { tradingsymbol: 'TCS26AUG2340CE', qty: 0, entryPrice: 9 },
      { tradingsymbol: 'TCS26AUG2280PE', qty: -350, entryPrice: 30 },
    ]),
    legsPrint([{ tradingsymbol: 'TCS26AUG2280PE', qty: -350, entryPrice: 30 }]),
  )
})

test('untrusted leg ids drop every close and shift BY NAME, and leave the adds alone', () => {
  const chain = chainFixtureWithContract(2600, 'CE', 'TCS26AUG2600CE', 223)
  const r = resolveOrders({
    legs: [leg('TCS26AUG2280PE', 2280, 'PE', -175)],
    moves: [
      { op: 'close', legId: 'TCS26AUG2280PE' },
      { op: 'shift', legId: 'TCS26AUG2280PE', toStrike: 2600 },
      { op: 'add', strike: 2600, type: 'CE', qty: -175 },
    ],
    chain,
    lotSize: 175,
    bookExpiry: EXPIRY,
    legIdsStale: 'the book has changed since this menu was drawn — search again',
  })
  // The add still resolves: nothing about it is addressed by a leg id. And its
  // `moveIndex` still names the sentence the operator read.
  assert.deepEqual(r.orders.map((o) => [o.wave, o.moveIndex, o.instrument.tradingsymbol]), [
    ['open', 2, 'TCS26AUG2600CE'],
  ])
  assert.equal(r.dropped.length, 2)
  assert.match(r.dropped[0]!, /close "TCS26AUG2280PE": the book has changed since this menu was drawn/)
  assert.match(r.dropped[1]!, /shift "TCS26AUG2280PE" to 2600: the book has changed since this menu was drawn/)
})
