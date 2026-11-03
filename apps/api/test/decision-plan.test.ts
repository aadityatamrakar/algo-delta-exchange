/**
 * The pure half of the order path, tested DIRECTLY.
 *
 * Every one of these behaviours was already covered end-to-end through
 * `flatten.test.ts` / `decision-replay.test.ts` / `service.integration.test.ts`,
 * which stand a Mongo, a fake rail and a clock up to reach them. That coverage
 * stays — it is what proves the wiring. These tests prove the CALCULATION, one
 * argument at a time, so a rule can be pinned down without a fixture and a
 * regression names the function that broke rather than the endpoint that
 * noticed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { InstrumentRef } from '@algomaker/order-bus'
import type { BridgeLeg, DeskAction, Fill } from '../src/contract.ts'
import {
  actionsFullyRouted,
  firstFillOpensPosition,
  flattenDecisionSymbol,
  flattenIsFlat,
  flattenLegResult,
  flattenWindow,
  foldRoutedFillsIntoBook,
  instrumentForFill,
  marketableFallback,
  orderIdFor,
  partitionOpenPositions,
  partitionRoutedFills,
  plannedFlattenFills,
  priceFillsForRoute,
  resolveOpenContracts,
  splitByKillSwitch,
  splitByRisk,
  unresolvedFlattenLegs,
  unresolvedFlattenSkips,
} from '../src/decision-plan.ts'
import {
  exposureLimitsFromEnv,
  NO_EXPOSURE_LIMITS,
  type ExposureState,
} from '@algomaker/order-bus'
import type { FlattenLegPlan, KillSwitchState } from '../src/safety.ts'

// --------------------------------------------------------------- fixtures

const inst = (tradingsymbol: string): InstrumentRef => ({
  exchange: 'NFO',
  tradingsymbol,
  instrumentToken: 1,
  lotSize: 25,
  tickSize: 0.05,
})

const leg = (over: Partial<BridgeLeg> & { deskTag: string; tradingsymbol: string }): BridgeLeg => {
  // `tradingsymbol` names the CONTRACT, which a leg carries inside `instrument`
  // — pulled out so it does not land on the leg as a stray field.
  const { tradingsymbol, ...rest } = over
  return {
    instrument: inst(tradingsymbol),
    underlying: 'NIFTY',
    expiry: '2026-08-06',
    strike: 24000,
    type: 'CE',
    side: 'Sell',
    qty: -50,
    entryPrice: 100,
    openedTs: 1,
    ...rest,
  }
}

const fill = (over: Partial<Fill> & { deskTag: string }): Fill => ({
  op: 'open',
  tradingsymbol: 'NIFTY24000CE',
  side: 'Sell',
  qty: 50,
  price: 100,
  ts: 1,
  ...over,
})

const off: KillSwitchState = { enabled: false, reason: '', setBy: '', setAt: 0 }

const planLeg = (over: Partial<FlattenLegPlan> = {}): FlattenLegPlan => ({
  tradingsymbol: 'NIFTY24000CE',
  positionQty: -50,
  side: 'Buy',
  qty: 50,
  orderType: 'MARKET',
  price: 100,
  degraded: '',
  ...over,
})

// ------------------------------------------------------------ orderIdFor

test('an order id is derived from the decision id, so a replay rebuilds the same one', () => {
  assert.equal(orderIdFor('dec-1', 0), 'dec-1#0')
  assert.equal(orderIdFor('dec-1', 0), orderIdFor('dec-1', 0))
  assert.notEqual(orderIdFor('dec-1', 0), orderIdFor('dec-1', 1))
})

// ------------------------------------------------------ splitByKillSwitch

test('the halt off lets every action through and skips nothing', () => {
  const actions: readonly DeskAction[] = [
    { op: 'open', ts: 'a', strike: 24000, type: 'CE', side: 'Sell', qty: 50 },
    { op: 'close', ts: 'b' },
  ]
  const out = splitByKillSwitch({ halt: off, actions, book: [] })
  assert.equal(out.permitted, actions)
  assert.deepEqual(out.haltSkips, [])
})

test('the halt blocks NEW EXPOSURE and lets an exit through — a trapped position is worse', () => {
  const book = [leg({ deskTag: 'b', tradingsymbol: 'NIFTY24000CE' })]
  const actions: readonly DeskAction[] = [
    { op: 'open', ts: 'a', strike: 24100, type: 'CE', side: 'Sell', qty: 50 },
    { op: 'close', ts: 'b' },
  ]
  const out = splitByKillSwitch({
    halt: { ...off, enabled: true, reason: 'margin' },
    actions,
    book,
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['b'],
  )
  assert.equal(out.haltSkips.length, 1)
  assert.equal(out.haltSkips[0]?.action.ts, 'a')
  assert.match(out.haltSkips[0]?.reason ?? '', /kill switch engaged \(margin\)/)
})

test('a halt with no reason does not render an empty parenthesis', () => {
  const out = splitByKillSwitch({
    halt: { ...off, enabled: true },
    actions: [{ op: 'open', ts: 'a', strike: 1, type: 'CE', side: 'Sell', qty: 1 }],
    book: [],
  })
  assert.equal(
    out.haltSkips[0]?.reason,
    'kill switch engaged; only exposure-reducing actions are allowed',
  )
})

// ------------------------------------------------------------- splitByRisk

const OPEN_A: DeskAction = { op: 'open', ts: 'a', strike: 24100, type: 'CE', side: 'Sell', qty: 50 }
const CLOSE_B: DeskAction = { op: 'close', ts: 'b' }

const EXPOSED: ExposureState = {
  nowMs: 1_700_000_000_000,
  recentOrderTs: [],
  openLotsByUnderlying: { NIFTY: 4 },
  openLotsTotal: 4,
  dayLoss: 0,
}

/** Two lots of a ₹100 contract per action — enough to trip a small cap. */
const sizeOf = (): { lots: number; quantity: number; price: number | null } => ({
  lots: 2,
  quantity: 50,
  price: 100,
})

const riskArgs = {
  mode: 'live' as const,
  underlying: 'NIFTY',
  exposure: EXPOSED,
  sizeOf,
}

test('with nothing configured splitByRisk permits everything and allocates no skips', () => {
  const actions = [OPEN_A, CLOSE_B]
  const out = splitByRisk({ ...riskArgs, limits: NO_EXPOSURE_LIMITS, actions, book: [] })
  assert.equal(out.permitted, actions, 'the array itself, not a copy — the gate is inert')
  assert.deepEqual(out.riskSkips, [])
})

test('a configured cap skips the OPEN and lets the CLOSE through', () => {
  const out = splitByRisk({
    ...riskArgs,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_TOTAL_LOTS: '5' }),
    actions: [OPEN_A, CLOSE_B],
    book: [leg({ deskTag: 'b', tradingsymbol: 'NIFTY24000CE' })],
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['b'],
  )
  assert.equal(out.riskSkips.length, 1)
  assert.equal(out.riskSkips[0]?.action.ts, 'a')
  assert.match(out.riskSkips[0]?.reason ?? '', /MAX_LOTS_TOTAL.*4 \+ 2 > 5/)
  assert.match(out.riskSkips[0]?.reason ?? '', /DESK_RISK_MAX_TOTAL_LOTS/)
})

test('opens in ONE decision accumulate against the cap — the 3rd is what breaches it', () => {
  const opens: DeskAction[] = ['a', 'b', 'c'].map((ts) => ({ ...OPEN_A, ts }))
  const out = splitByRisk({
    ...riskArgs,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_TOTAL_LOTS: '8' }),
    actions: opens,
    book: [],
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['a', 'b'],
    '4 open + 2 + 2 = 8 fits; the third would make 10',
  )
  assert.equal(out.riskSkips.length, 1)
})

test('opens in ONE decision accumulate against the RATE limit too, not only the lots', () => {
  const opens: DeskAction[] = ['a', 'b', 'c', 'd'].map((ts) => ({ ...OPEN_A, ts }))
  const out = splitByRisk({
    ...riskArgs,
    exposure: { ...EXPOSED, recentOrderTs: [EXPOSED.nowMs - 1_000] },
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_ORDERS_PER_MIN: '3' }),
    actions: opens,
    book: [],
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['a', 'b'],
    'one order already sent this minute + two = the limit; the third would exceed it',
  )
  assert.equal(out.riskSkips.length, 2)
  assert.match(out.riskSkips[0]?.reason ?? '', /RATE_LIMIT/)
  assert.match(out.riskSkips[0]?.reason ?? '', /DESK_RISK_MAX_ORDERS_PER_MIN/)
})

test('EXITS in the decision are not counted against the rate limit', () => {
  const out = splitByRisk({
    ...riskArgs,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_ORDERS_PER_MIN: '2' }),
    actions: [CLOSE_B, CLOSE_B, CLOSE_B, OPEN_A],
    book: [leg({ deskTag: 'b', tradingsymbol: 'NIFTY24000CE' })],
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['b', 'b', 'b', 'a'],
    'throttling exits would throttle getting flat',
  )
})

test('PAPER decisions are never risk-gated', () => {
  const actions = [OPEN_A]
  const out = splitByRisk({
    ...riskArgs,
    mode: 'paper',
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_TOTAL_LOTS: '1' }),
    actions,
    book: [],
  })
  assert.equal(out.permitted, actions)
})

test('an action whose size cannot be resolved is not blocked ON THAT — the caps need lots', () => {
  const out = splitByRisk({
    ...riskArgs,
    sizeOf: () => null,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_TOTAL_LOTS: '5' }),
    actions: [OPEN_A],
    book: [],
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['a'],
    'applyActions refuses an unresolvable contract for itself, with a better reason',
  )
})

test('the day loss stop skips every exposure-ADDING action in the decision, exits excepted', () => {
  const out = splitByRisk({
    ...riskArgs,
    exposure: { ...EXPOSED, dayLoss: 61_250 },
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '50000' }),
    actions: [OPEN_A, CLOSE_B, { op: 'roll', ts: 'b', to_ts: 'c', to_strike: 24200 }],
    book: [leg({ deskTag: 'b', tradingsymbol: 'NIFTY24000CE' })],
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['b', 'b'],
    'a roll reduces or replaces — it must not be trapped either',
  )
  assert.match(out.riskSkips[0]?.reason ?? '', /DAILY_LOSS.*61250.*50000/)
})

test('an unmeasurable desk skips new exposure while a limit is configured', () => {
  const out = splitByRisk({
    ...riskArgs,
    exposure: null,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '50000' }),
    actions: [OPEN_A, CLOSE_B],
    book: [leg({ deskTag: 'b', tradingsymbol: 'NIFTY24000CE' })],
  })
  assert.deepEqual(
    out.permitted.map((a) => a.ts),
    ['b'],
  )
  assert.match(out.riskSkips[0]?.reason ?? '', /could not be measured/)
})

// ----------------------------------------------------- marketableFallback

/** 2% or two ticks, whichever is wider — the production default. */
const CROSS = { bufferPct: 0.02, minTicks: 2, tickSize: 0.05 }

test('a MARKET fill becomes a LIMIT that CROSSES the mark, in the closing direction', () => {
  const sell = marketableFallback(
    fill({ deskTag: 'a', side: 'Sell', price: 100, orderType: 'MARKET' }),
    CROSS,
  )
  assert.equal(sell.orderType, 'LIMIT')
  assert.ok((sell.limitPrice ?? 0) < 100, 'a sell crosses DOWN through the mark')

  const buy = marketableFallback(
    fill({ deskTag: 'a', side: 'Buy', price: 100, orderType: 'MARKET' }),
    CROSS,
  )
  assert.equal(buy.orderType, 'LIMIT')
  assert.ok((buy.limitPrice ?? 0) > 100, 'a buy crosses UP through it')
})

test('an ABSENT orderType is a MARKET order — `rail.ts` defaults it to one', () => {
  // The supervisor's actions carry no orderType at all, and the rail sends
  // `fill.orderType ?? 'MARKET'`. Treating absent as "not MARKET" would leave
  // exactly those orders to be rejected.
  const out = marketableFallback(fill({ deskTag: 'a', side: 'Sell', price: 100 }), CROSS)
  assert.equal(out.orderType, 'LIMIT')
})

test('a LIMIT fill is returned untouched — the caller already chose its price', () => {
  const f = fill({ deskTag: 'a', price: 100, orderType: 'LIMIT', limitPrice: 99.5 })
  assert.equal(marketableFallback(f, CROSS), f)
})

test('an unusable mark leaves a MARKET fill exactly as it was, price uninvented', () => {
  const f = fill({ deskTag: 'a', price: 0, orderType: 'MARKET' })
  assert.equal(marketableFallback(f, CROSS), f)
})

test('no marketable config means MARKET stays MARKET — the historical behaviour', () => {
  const f = fill({ deskTag: 'a', price: 100, orderType: 'MARKET' })
  assert.equal(marketableFallback(f, undefined), f)
})

// ------------------------------------------- marketableFallback: expiry day

/**
 * The production dials: 2% base, 10% on a contract that expires today. The mark
 * is 100 throughout so the buffer reads straight off the price — 98 / 102 at 2%,
 * 90 / 110 at 10%.
 */
const WITH_EXPIRY = { ...CROSS, expiryBufferPct: 0.1 }
const unpriced = (side: 'Buy' | 'Sell'): Fill =>
  fill({ deskTag: 'a', side, price: 100, orderType: 'MARKET' })

test('expiresToday gives an unpriced MARKET fill a limit 10% THROUGH the mark', () => {
  const sell = marketableFallback(unpriced('Sell'), WITH_EXPIRY, true)
  assert.equal(sell.orderType, 'LIMIT')
  assert.equal(sell.limitPrice, 90, 'a sell crosses DOWN by the wide buffer')

  const buy = marketableFallback(unpriced('Buy'), WITH_EXPIRY, true)
  assert.equal(buy.orderType, 'LIMIT')
  assert.equal(buy.limitPrice, 110, 'a buy crosses UP by the wide buffer')
})

test('expiresToday false prices the same fill at the base 2%', () => {
  assert.equal(marketableFallback(unpriced('Sell'), WITH_EXPIRY, false).limitPrice, 98)
  assert.equal(marketableFallback(unpriced('Buy'), WITH_EXPIRY, false).limitPrice, 102)
})

test('the flag DEFAULTS to false — every existing caller prices exactly as before', () => {
  // `flattenTag` calls `marketableFallback(f, cfg)` with two arguments, and a
  // default that leaned the other way would move its pricing without anyone
  // touching it. The expiry dial being PRESENT in the config must not matter.
  assert.deepEqual(
    marketableFallback(unpriced('Sell'), WITH_EXPIRY),
    marketableFallback(unpriced('Sell'), WITH_EXPIRY, false),
  )
  assert.equal(marketableFallback(unpriced('Sell'), WITH_EXPIRY).limitPrice, 98)
  assert.equal(marketableFallback(unpriced('Buy'), WITH_EXPIRY).limitPrice, 102)
})

test('expiresToday on a config WITHOUT the expiry dial falls back to the base buffer', () => {
  // ABSENT MEANS `bufferPct` — a hand-built config that never opted in is
  // unchanged even when the caller asserts expiry day.
  assert.equal(marketableFallback(unpriced('Sell'), CROSS, true).limitPrice, 98)
})

test('expiresToday never touches a price the caller already chose', () => {
  const f = fill({ deskTag: 'a', price: 100, orderType: 'LIMIT', limitPrice: 99.5 })
  assert.equal(marketableFallback(f, WITH_EXPIRY, true), f)
})

test('expiresToday with an unusable mark or no config still invents nothing', () => {
  const dead = fill({ deskTag: 'a', price: 0, orderType: 'MARKET' })
  assert.equal(marketableFallback(dead, WITH_EXPIRY, true), dead)
  const live = unpriced('Sell')
  assert.equal(marketableFallback(live, undefined, true), live)
})

// ---------------------------------------------------- priceFillsForRoute

test('no pricing and no marketable config leaves the fills EXACTLY as booked', () => {
  const fills = [fill({ deskTag: 'a' })]
  assert.equal(priceFillsForRoute(fills, undefined, undefined), fills)
})

test("the supervisor's unpriced fills become marketable limits — the broker rejects MARKET", () => {
  const out = priceFillsForRoute([fill({ deskTag: 'a', side: 'Sell', price: 100 })], undefined, {
    bufferPct: 0.02,
    minTicks: 1,
    tickSize: 0.05,
  })
  assert.equal(out[0]?.orderType, 'LIMIT')
  // A sell crosses DOWN through the mark, never up.
  assert.ok((out[0]?.limitPrice ?? 0) < 100)
})

test('an unusable mark leaves the fill alone rather than inventing a price', () => {
  const out = priceFillsForRoute([fill({ deskTag: 'a', price: 0 })], undefined, {
    bufferPct: 0.02,
    minTicks: 1,
    tickSize: 0.05,
  })
  assert.equal(out[0]?.orderType, undefined)
  assert.equal(out[0]?.limitPrice, undefined)
})

test("close-all's per-leg pricing is applied by desk tag, and a MARKET entry is a no-op", () => {
  const fills = [fill({ deskTag: 'a' }), fill({ deskTag: 'b' }), fill({ deskTag: 'c' })]
  const out = priceFillsForRoute(
    fills,
    new Map([
      ['a', { orderType: 'LIMIT' as const, limitPrice: 99.5 }],
      ['b', { orderType: 'MARKET' as const }],
    ]),
    undefined,
  )
  assert.equal(out[0]?.orderType, 'LIMIT')
  assert.equal(out[0]?.limitPrice, 99.5)
  assert.equal(out[1], fills[1])
  // Unnamed tags are untouched, not defaulted.
  assert.equal(out[2], fills[2])
})

test("a MARKET pricing entry becomes a marketable limit — 'fast' must still fill", () => {
  const out = priceFillsForRoute(
    [fill({ deskTag: 'a', side: 'Buy', price: 100 })],
    new Map([['a', { orderType: 'MARKET' as const }]]),
    { bufferPct: 0.02, minTicks: 2, tickSize: 0.05 },
  )
  assert.equal(out[0]?.orderType, 'LIMIT')
  // A buy crosses UP through the mark.
  assert.ok((out[0]?.limitPrice ?? 0) > 100)
})

test('a MARKET pricing entry with an unusable mark is left exactly as it was', () => {
  const fills = [fill({ deskTag: 'a', price: 0 })]
  const out = priceFillsForRoute(fills, new Map([['a', { orderType: 'MARKET' as const }]]), {
    bufferPct: 0.02,
    minTicks: 2,
    tickSize: 0.05,
  })
  assert.equal(out[0], fills[0])
})

test('caller pricing wins over the marketable config — close-all already chose', () => {
  const out = priceFillsForRoute(
    [fill({ deskTag: 'a', price: 100 })],
    new Map([['a', { orderType: 'LIMIT' as const, limitPrice: 77 }]]),
    { bufferPct: 0.5, minTicks: 1, tickSize: 0.05 },
  )
  assert.equal(out[0]?.limitPrice, 77)
})

// ---------------------------------- priceFillsForRoute: the expiry-day flag

test("expiresToday prices the supervisor's UNPRICED fills 10% through the mark", () => {
  // The branch with no pricing map at all — `marketableFallback` is called
  // from here, and the flag has to ride along.
  const out = priceFillsForRoute(
    [fill({ deskTag: 'a', side: 'Sell', price: 100 }), fill({ deskTag: 'b', side: 'Buy', price: 100 })],
    undefined,
    WITH_EXPIRY,
    true,
  )
  assert.equal(out[0]?.limitPrice, 90)
  assert.equal(out[1]?.limitPrice, 110)
})

test('expiresToday prices a MARKET pricing entry — and an unnamed tag — 10% through the mark', () => {
  // The engine endpoint's branch: every action has an entry, an unpriced one is
  // MARKET, and it must take the same buffer as a fill with no entry at all.
  const out = priceFillsForRoute(
    [fill({ deskTag: 'a', side: 'Sell', price: 100 }), fill({ deskTag: 'b', side: 'Sell', price: 100 })],
    new Map([['a', { orderType: 'MARKET' as const }]]),
    WITH_EXPIRY,
    true,
  )
  assert.equal(out[0]?.limitPrice, 90, 'a MARKET entry')
  assert.equal(out[1]?.limitPrice, 90, 'a tag the map does not name')
})

test('expiresToday false, and the flag omitted, both leave the base 2% on either branch', () => {
  const fills = [fill({ deskTag: 'a', side: 'Sell', price: 100 })]
  const entry = new Map([['a', { orderType: 'MARKET' as const }]])
  assert.equal(priceFillsForRoute(fills, undefined, WITH_EXPIRY, false)[0]?.limitPrice, 98)
  assert.equal(priceFillsForRoute(fills, undefined, WITH_EXPIRY)[0]?.limitPrice, 98)
  assert.equal(priceFillsForRoute(fills, entry, WITH_EXPIRY, false)[0]?.limitPrice, 98)
  assert.equal(priceFillsForRoute(fills, entry, WITH_EXPIRY)[0]?.limitPrice, 98)
})

test('expiresToday never overrides a price the supervisor chose', () => {
  const out = priceFillsForRoute(
    [fill({ deskTag: 'a', side: 'Sell', price: 100 })],
    new Map([['a', { orderType: 'LIMIT' as const, limitPrice: 96 }]]),
    WITH_EXPIRY,
    true,
  )
  assert.equal(out[0]?.orderType, 'LIMIT')
  assert.equal(out[0]?.limitPrice, 96, 'the wide buffer buys the FILL of an unpriced order, not a new price')
})

test('expiresToday with nothing to apply still returns the very same array', () => {
  const fills = [fill({ deskTag: 'a' })]
  assert.equal(priceFillsForRoute(fills, undefined, undefined, true), fills)
})

// ------------------------------------------------------ instrumentForFill

test('a fill resolves against the NEW book first', () => {
  const next = [leg({ deskTag: 'a', tradingsymbol: 'NEW' })]
  const prior = [leg({ deskTag: 'a', tradingsymbol: 'OLD' })]
  const got = instrumentForFill(fill({ deskTag: 'a' }), next, prior, () => null)
  assert.equal(got?.tradingsymbol, 'NEW')
})

test("a CLOSE's leg is gone from the new book, so the prior one answers", () => {
  const prior = [leg({ deskTag: 'a', tradingsymbol: 'OLD' })]
  const got = instrumentForFill(fill({ deskTag: 'a', op: 'close' }), [], prior, () => null)
  assert.equal(got?.tradingsymbol, 'OLD')
})

test('neither book carries the tag: the master is asked, and only then', () => {
  let asked = 0
  const got = instrumentForFill(
    fill({ deskTag: 'a', tradingsymbol: 'SYM' }),
    [leg({ deskTag: 'a', tradingsymbol: 'HELD' })],
    [],
    (s) => {
      asked++
      return inst(s)
    },
  )
  assert.equal(got?.tradingsymbol, 'HELD')
  assert.equal(asked, 0, 'the master must not be consulted when a book already answers')

  const fallback = instrumentForFill(fill({ deskTag: 'z', tradingsymbol: 'SYM' }), [], [], (s) => {
    asked++
    return inst(s)
  })
  assert.equal(fallback?.tradingsymbol, 'SYM')
  assert.equal(asked, 1)
})

test('an unresolvable fill is null, never a fabricated instrument', () => {
  assert.equal(instrumentForFill(fill({ deskTag: 'z' }), [], [], () => null), null)
})

// --------------------------------------------------- partitionRoutedFills

test('a fill whose route threw is NOT routed — an attempt is not a position', () => {
  const fills = [fill({ deskTag: 'a' }), fill({ deskTag: 'b' }), fill({ deskTag: 'c' })]
  const out = partitionRoutedFills(fills, [{ fill: fills[1] as Fill, error: 'refused' }])
  assert.deepEqual(
    out.routedFills.map((f) => f.deskTag),
    ['a', 'c'],
  )
  assert.ok(out.failedTags.has('b'))
})

test('with no route errors every fill routed', () => {
  const fills = [fill({ deskTag: 'a' })]
  const out = partitionRoutedFills(fills, [])
  assert.deepEqual(out.routedFills, fills)
  assert.equal(out.failedTags.size, 0)
})

// ---------------------------------------------------- actionsFullyRouted

test("a roll whose REPLACEMENT leg failed is dropped whole — the book must not claim a strike no order reached", () => {
  const actions: readonly DeskAction[] = [
    { op: 'roll', ts: 'a', to_ts: 'a2', to_strike: 24100 },
    { op: 'close', ts: 'b' },
  ]
  assert.deepEqual(
    actionsFullyRouted(actions, new Set(['a2'])).map((a) => a.ts),
    ['b'],
  )
})

test("a roll whose BUY-BACK failed is dropped too", () => {
  const actions: readonly DeskAction[] = [{ op: 'roll', ts: 'a', to_ts: 'a2', to_strike: 24100 }]
  assert.deepEqual(actionsFullyRouted(actions, new Set(['a'])), [])
})

test('actions untouched by a failure survive', () => {
  const actions: readonly DeskAction[] = [
    { op: 'roll', ts: 'a', to_ts: 'a2', to_strike: 24100 },
    { op: 'close', ts: 'b' },
  ]
  assert.deepEqual(
    actionsFullyRouted(actions, new Set(['zzz'])).map((a) => a.ts),
    ['a', 'b'],
  )
})

// ---------------------------------------------------------- flattenWindow

test('the flatten window extends PAST now, so the most recent order is not dropped', () => {
  const w = flattenWindow(1_000_000, 500)
  assert.equal(w.from, 500)
  assert.equal(w.to, 1_000_001)
})

test('a POSITIONAL book with no sinceMs reads every fill; an explicit one still wins', () => {
  const now = Date.UTC(2026, 9, 19, 4, 41)
  assert.equal(flattenWindow(now, undefined, true).from, 0)
  assert.equal(flattenWindow(now, 500, true).from, 500)
})

test('with no sinceMs the window opens at the start of the IST trading day', () => {
  const w = flattenWindow(Date.UTC(2026, 6, 30, 6, 0, 0))
  assert.ok(w.from < Date.UTC(2026, 6, 30, 6, 0, 0))
  // Midnight IST on the 30th is 18:30 UTC on the 29th.
  assert.equal(new Date(w.from).toISOString(), '2026-07-29T18:30:00.000Z')
})

// ------------------------------------------------- firstFillOpensPosition

test('a window that starts on a BUY-BACK is not treated as an open', () => {
  const out = firstFillOpensPosition([
    { tradingsymbol: 'A', op: 'close', ts: 1 },
    { tradingsymbol: 'A', op: 'open', ts: 2 },
  ])
  assert.equal(out.get('A'), false)
})

test('a resize cannot open by definition, and an ABSENT op is never guessed at', () => {
  const out = firstFillOpensPosition([
    { tradingsymbol: 'A', op: 'resize', ts: 1 },
    { tradingsymbol: 'B', ts: 1 },
  ])
  assert.equal(out.get('A'), false)
  assert.equal(out.get('B'), false)
})

test("a roll's two halves are told apart by POSITION, not by op — out, in, out, in", () => {
  const out = firstFillOpensPosition([
    { tradingsymbol: 'OLD', op: 'roll', ts: 5 },
    { tradingsymbol: 'NEW', op: 'roll', ts: 5 },
    { tradingsymbol: 'OLD2', op: 'roll', ts: 5 },
    { tradingsymbol: 'NEW2', op: 'roll', ts: 5 },
  ])
  assert.equal(out.get('OLD'), false)
  assert.equal(out.get('NEW'), true)
  assert.equal(out.get('OLD2'), false)
  assert.equal(out.get('NEW2'), true)
})

test('a new instant restarts the roll run, so the next buy-back is not read as an open', () => {
  const out = firstFillOpensPosition([
    { tradingsymbol: 'A', op: 'roll', ts: 5 },
    { tradingsymbol: 'B', op: 'roll', ts: 5 },
    { tradingsymbol: 'C', op: 'roll', ts: 9 },
  ])
  assert.equal(out.get('C'), false)
})

test('only the FIRST fill for a symbol decides it', () => {
  const out = firstFillOpensPosition([
    { tradingsymbol: 'A', op: 'open', ts: 1 },
    { tradingsymbol: 'A', op: 'close', ts: 2 },
  ])
  assert.equal(out.get('A'), true)
})

// --------------------------------------------------- partitionOpenPositions

test('a position rebuilt from buy-backs alone is held back as TRUNCATED, never flattened', () => {
  const out = partitionOpenPositions(
    [
      { tradingsymbol: 'GOOD', qty: -50, avgCost: 100 },
      { tradingsymbol: 'SUSPECT', qty: 50, avgCost: 100 },
    ],
    [
      { tradingsymbol: 'GOOD', op: 'open', ts: 1 },
      { tradingsymbol: 'SUSPECT', op: 'close', ts: 1 },
    ],
  )
  assert.deepEqual(
    out.open.map((p) => p.tradingsymbol),
    ['GOOD'],
  )
  assert.deepEqual(out.truncated, ['SUSPECT'])
})

test('a flat contract is dropped, not reported — a closed round trip has nothing to flatten', () => {
  const out = partitionOpenPositions(
    [{ tradingsymbol: 'A', qty: 0, avgCost: 100 }],
    [{ tradingsymbol: 'A', op: 'open', ts: 1 }],
  )
  assert.deepEqual(out.open, [])
  assert.deepEqual(out.truncated, [])
})

test('a position with no fill evidence at all is suspect, not open', () => {
  const out = partitionOpenPositions([{ tradingsymbol: 'GHOST', qty: -50, avgCost: 100 }], [])
  assert.deepEqual(out.open, [])
  assert.deepEqual(out.truncated, ['GHOST'])
})

// ---------------------------------------------------- resolveOpenContracts

test('an unknown symbol is NAMED rather than routed against a fabricated instrument', () => {
  const out = resolveOpenContracts(
    [{ tradingsymbol: 'KNOWN' }, { tradingsymbol: 'UNKNOWN' }],
    (s) => (s === 'KNOWN' ? inst(s) : null),
  )
  assert.deepEqual(
    out.resolvable.map((p) => p.tradingsymbol),
    ['KNOWN'],
  )
  assert.deepEqual(out.unresolved, ['UNKNOWN'])
  assert.equal(out.instruments.get('KNOWN')?.tradingsymbol, 'KNOWN')
  assert.equal(out.instruments.has('UNKNOWN'), false)
})

// --------------------------------------------------- plannedFlattenFills

test('a planned exit carries the derived order id as its desk tag, so a fill matches its order', () => {
  const out = plannedFlattenFills([planLeg(), planLeg({ tradingsymbol: 'B' })], 'dec-9', 1234)
  assert.deepEqual(
    out.map((f) => f.deskTag),
    ['dec-9#0', 'dec-9#1'],
  )
  assert.equal(out[0]?.op, 'close')
  assert.equal(out[0]?.ts, 1234)
  assert.equal(out[0]?.side, 'Buy')
  // Absent rather than undefined: `exactOptionalPropertyTypes` and Mongo both care.
  assert.equal('limitPrice' in (out[0] as object), false)
})

test('a limit-priced plan carries its limit onto the fill', () => {
  const out = plannedFlattenFills([planLeg({ orderType: 'LIMIT', limitPrice: 98.5 })], 'd', 1)
  assert.equal(out[0]?.orderType, 'LIMIT')
  assert.equal(out[0]?.limitPrice, 98.5)
})

// ----------------------------------------- unresolvedFlattenSkips / legs

test('an unresolvable leg is reported as a skip in the SAME shape as every other skip', () => {
  const [skip] = unresolvedFlattenSkips(['WEIRD'])
  assert.equal(skip?.action.op, 'close')
  assert.equal(skip?.action.ts, 'WEIRD')
  assert.match(skip?.reason ?? '', /not in the instrument master/)
})

test('an unresolvable SHORT is reported with the side that would have closed it', () => {
  const [row] = unresolvedFlattenLegs(['A'], [{ tradingsymbol: 'A', qty: -75 }])
  assert.equal(row?.positionQty, -75)
  assert.equal(row?.side, 'Buy')
  assert.equal(row?.qty, 75)
  assert.equal(row?.routed, false)
  assert.match(row?.error ?? '', /close it manually/)
})

test('an unresolvable LONG is reported as a sell, and a vanished position as zero', () => {
  const [long] = unresolvedFlattenLegs(['A'], [{ tradingsymbol: 'A', qty: 75 }])
  assert.equal(long?.side, 'Sell')
  const [gone] = unresolvedFlattenLegs(['B'], [])
  assert.equal(gone?.positionQty, 0)
  assert.equal(gone?.qty, 0)
})

// -------------------------------------------------------- flattenLegResult

test("a leg that routed reports routed:true and no error; one that did not reports both", () => {
  const ok = flattenLegResult(planLeg({ degraded: 'no mark' }), { orderType: 'MARKET' }, '')
  assert.equal(ok.routed, true)
  assert.equal(ok.error, '')
  assert.equal(ok.degraded, 'no mark')

  const bad = flattenLegResult(planLeg(), { orderType: 'MARKET' }, 'rail refused')
  assert.equal(bad.routed, false)
  assert.equal(bad.error, 'rail refused')
})

test('the reported order is the FILL that went out, not the plan it was built from', () => {
  // The plan says MARKET; `marketableFallback` sent a crossing limit. Reporting
  // the plan would tell the operator one thing while the broker saw another.
  const out = flattenLegResult(
    planLeg({ orderType: 'MARKET' }),
    { orderType: 'LIMIT', limitPrice: 102.4 },
    '',
  )
  assert.equal(out.orderType, 'LIMIT')
  assert.equal(out.limitPrice, 102.4)
})

test('a fill with NO orderType still reports MARKET — the rail sends one', () => {
  const out = flattenLegResult(planLeg(), {}, '')
  assert.equal(out.orderType, 'MARKET')
  assert.equal(out.limitPrice, undefined)
})

// --------------------------------------------------- flattenDecisionSymbol

test('one underlying is named; a MIXED flatten names none rather than misfiling the rest', () => {
  assert.equal(flattenDecisionSymbol([planLeg({ tradingsymbol: 'NIFTY26AUG24000CE' })]), 'NIFTY')
  assert.equal(
    flattenDecisionSymbol([
      planLeg({ tradingsymbol: 'NIFTY26AUG24000CE' }),
      planLeg({ tradingsymbol: 'BANKNIFTY26AUG55000PE' }),
    ]),
    '',
  )
  assert.equal(flattenDecisionSymbol([]), '')
})

// -------------------------------------------------- foldRoutedFillsIntoBook

test('a routed exit reduces the leg the book holds', () => {
  const book = [leg({ deskTag: 'a', tradingsymbol: 'SYM', qty: -50 })]
  const out = foldRoutedFillsIntoBook(
    book,
    [fill({ deskTag: 'x', tradingsymbol: 'SYM', side: 'Buy', qty: 25 })],
    9,
  )
  assert.equal(out.touched, true)
  assert.equal(out.legs[0]?.qty, -25)
})

test('a full exit removes the leg, which is what stops a flattened book reading as open', () => {
  const book = [leg({ deskTag: 'a', tradingsymbol: 'SYM', qty: -50 })]
  const out = foldRoutedFillsIntoBook(
    book,
    [fill({ deskTag: 'x', tradingsymbol: 'SYM', side: 'Buy', qty: 50 })],
    9,
  )
  assert.equal(out.touched, true)
  assert.deepEqual(out.legs, [])
})

test('a fill for a contract the book does not hold is NOT invented into it', () => {
  const book = [leg({ deskTag: 'a', tradingsymbol: 'SYM' })]
  const out = foldRoutedFillsIntoBook(
    book,
    [fill({ deskTag: 'x', tradingsymbol: 'OTHER', side: 'Buy', qty: 50 })],
    9,
  )
  assert.equal(out.touched, false)
  assert.equal(out.legs, book)
})

test('no routed fills means no write to make', () => {
  const book = [leg({ deskTag: 'a', tradingsymbol: 'SYM' })]
  assert.equal(foldRoutedFillsIntoBook(book, [], 9).touched, false)
})

// ------------------------------------------------------------ flattenIsFlat

test('flat only when every leg routed AND the reconstruction was complete', () => {
  const routed = flattenLegResult(planLeg(), { orderType: 'MARKET' }, '')
  assert.equal(
    flattenIsFlat({
      legs: [routed],
      truncated: [],
      malformedFills: [],
      fillsTruncated: false,
      fillCount: 1,
    }),
    true,
  )
})

test('a MALFORMED stored fill forces flat:false — the two must never disagree', () => {
  const routed = flattenLegResult(planLeg(), { orderType: 'MARKET' }, '')
  assert.equal(
    flattenIsFlat({
      legs: [routed],
      truncated: [],
      malformedFills: ['id-1'],
      fillsTruncated: false,
      fillCount: 1,
    }),
    false,
  )
})

test('a truncated READ and a held-back contract each force flat:false', () => {
  const routed = flattenLegResult(planLeg(), { orderType: 'MARKET' }, '')
  assert.equal(
    flattenIsFlat({
      legs: [routed],
      truncated: [],
      malformedFills: [],
      fillsTruncated: true,
      fillCount: 1,
    }),
    false,
  )
  assert.equal(
    flattenIsFlat({
      legs: [routed],
      truncated: ['A'],
      malformedFills: [],
      fillsTruncated: false,
      fillCount: 1,
    }),
    false,
  )
})

test('a leg that did not route forces flat:false', () => {
  assert.equal(
    flattenIsFlat({
      legs: [flattenLegResult(planLeg(), { orderType: 'MARKET' }, 'refused')],
      truncated: [],
      malformedFills: [],
      fillsTruncated: false,
      fillCount: 1,
    }),
    false,
  )
})

test('zero legs beside a malformed fill is NOT flat — the vacuous-truth bug that shipped a short', () => {
  assert.equal(
    flattenIsFlat({
      legs: [],
      truncated: [],
      malformedFills: ['bad'],
      fillsTruncated: false,
      fillCount: 1,
    }),
    false,
  )
})

test('an EMPTY reconstruction over an empty window is NOT flat — it proves nothing', () => {
  assert.equal(
    flattenIsFlat({
      legs: [],
      truncated: [],
      malformedFills: [],
      fillsTruncated: false,
      fillCount: 0,
    }),
    false,
  )
})

test('zero legs from fills that NETTED to zero is flat — a real round trip', () => {
  assert.equal(
    flattenIsFlat({
      legs: [],
      truncated: [],
      malformedFills: [],
      fillsTruncated: false,
      fillCount: 4,
    }),
    true,
  )
})
