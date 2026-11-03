import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BROKER_LINK,
  addsExposure,
  brokerLinkRefusal,
  planCloseAll,
  planFlatten,
  readBrokerLinkDoc,
  type NetPosition,
} from '../src/safety.ts'
import type { BridgeLeg, DeskAction } from '../src/contract.ts'
import { aggressionPctError, MAX_AGGRESSION_PCT } from '../src/validate.ts'

const leg = (deskTag: string, qty: number, symbol = `SYM${deskTag}`): BridgeLeg => ({
  deskTag,
  instrument: { tradingsymbol: symbol, instrumentToken: 1, lotSize: 2625, tickSize: 0.05, exchange: 'NFO' },
  underlying: 'BHEL',
  expiry: '2026-08-25',
  strike: 420,
  type: 'CE',
  side: qty < 0 ? 'Sell' : 'Buy',
  qty,
  entryPrice: 15,
  openedTs: 0,
})

// ------------------------------------------------------------ kill switch

test('open ADDS exposure and is blocked by a halt', () => {
  const a: DeskAction = { op: 'open', ts: 'x', strike: 420, type: 'CE', side: 'Sell', qty: 2625 }
  assert.equal(addsExposure(a, []), true)
})

test('close and roll NEVER count as adding exposure', () => {
  // A halt that blocks exits traps the position. A roll blocked mid-halt
  // strands a tested short exactly when it most needs moving.
  const book = [leg('L1', -13125)]
  assert.equal(addsExposure({ op: 'close', ts: 'L1' }, book), false)
  assert.equal(addsExposure({ op: 'roll', ts: 'L1', to_ts: 'L2', to_strike: 430 }, book), false)
})

test('resize adds exposure only when it GROWS the leg', () => {
  const book = [leg('L1', -13125)]
  assert.equal(addsExposure({ op: 'resize', ts: 'L1', qty: 15750 }, book), true, 'growing a short')
  assert.equal(addsExposure({ op: 'resize', ts: 'L1', qty: 5250 }, book), false, 'shrinking is an exit')
  assert.equal(addsExposure({ op: 'resize', ts: 'L1', qty: 0 }, book), false, 'to zero is an exit')
})

test('a resize of an unknown leg is not treated as new exposure', () => {
  assert.equal(addsExposure({ op: 'resize', ts: 'GHOST', qty: 99 }, []), false)
})

// -------------------------------------------------------------- close all

const marks = (m: Record<string, number>) => (l: BridgeLeg): number | null =>
  m[l.instrument.tradingsymbol] ?? null

test('close-all emits one close per leg, in a single decision', () => {
  const book = [leg('A', -13125, 'X1'), leg('B', -13125, 'X2'), leg('C', 39375, 'X3')]
  const plan = planCloseAll({ book, style: 'fast', marks: marks({}) })
  assert.equal(plan.actions.length, 3)
  assert.equal(plan.legCount, 3)
  assert.ok(plan.actions.every((a) => a.op === 'close'))
})

test('fast style is MARKET for every leg — no price needed', () => {
  const book = [leg('A', -13125, 'X1')]
  const plan = planCloseAll({ book, style: 'fast', marks: marks({}) })
  assert.equal(plan.pricing.get('A')?.orderType, 'MARKET')
  assert.equal(plan.unpriceable.length, 0, 'fast never needs a mark, so nothing is unpriceable')
})

test('limit style prices THROUGH the mark so it still crosses', () => {
  // Closing a SHORT means buying, so the limit must sit ABOVE the mark.
  const book = [leg('A', -13125, 'X1')]
  const plan = planCloseAll({ book, style: 'limit', aggressionPct: 0.02, marks: marks({ X1: 10 }) })
  const p = plan.pricing.get('A')
  assert.equal(p?.orderType, 'LIMIT')
  assert.ok((p?.limitPrice ?? 0) > 10, `expected a bid above the mark, got ${String(p?.limitPrice)}`)
  assert.equal(p?.limitPrice, 10.2)
})

test('closing a LONG offers below the mark', () => {
  const book = [leg('A', 39375, 'X1')]
  const plan = planCloseAll({ book, style: 'limit', aggressionPct: 0.02, marks: marks({ X1: 10 }) })
  assert.equal(plan.pricing.get('A')?.limitPrice, 9.8)
})

test('aggression never rounds to nothing on a cheap contract', () => {
  // 2% of Rs.2.90 is 6 paise — barely one tick. A limit that lands ON the mark
  // is a limit that does not fill, which turns "close everything" into a book
  // that is half open and looks closed.
  const book = [leg('A', -13125, 'X1')]
  const plan = planCloseAll({ book, style: 'limit', aggressionPct: 0.001, marks: marks({ X1: 2.9 }) })
  const price = plan.pricing.get('A')?.limitPrice ?? 0
  assert.ok(price >= 2.95, `expected at least one tick through, got ${price}`)
})

test('an UNMARKED leg degrades to MARKET and is named — never skipped', () => {
  // Refusing to close because we cannot price it is exactly the trap this
  // module exists to avoid. An uncontrolled exit is bad; no exit is worse.
  const book = [leg('A', -13125, 'X1'), leg('B', -13125, 'X2')]
  const plan = planCloseAll({ book, style: 'limit', marks: marks({ X1: 10 }) })
  assert.equal(plan.actions.length, 2, 'BOTH legs must still be closed')
  assert.equal(plan.pricing.get('B')?.orderType, 'MARKET')
  assert.deepEqual(plan.unpriceable, ['X2'])
})

test('a zero or negative mark is treated as no mark', () => {
  const book = [leg('A', -13125, 'X1')]
  const plan = planCloseAll({ book, style: 'limit', marks: marks({ X1: 0 }) })
  assert.equal(plan.pricing.get('A')?.orderType, 'MARKET')
  assert.deepEqual(plan.unpriceable, ['X1'])
})

test('limit prices land on the tick grid', () => {
  const book = [leg('A', -13125, 'X1')]
  const plan = planCloseAll({ book, style: 'limit', aggressionPct: 0.037, marks: marks({ X1: 12.47 }) })
  const price = plan.pricing.get('A')?.limitPrice ?? 0
  assert.equal(Math.round((price / 0.05) * 1e6) % 1e6, 0, `${price} is not on the 0.05 grid`)
})

test('an empty book plans nothing rather than erroring', () => {
  const plan = planCloseAll({ book: [], style: 'fast', marks: marks({}) })
  assert.equal(plan.actions.length, 0)
  assert.equal(plan.legCount, 0)
})

// ------------------------------------------------- flatten by net position

/**
 * The hosted-strategy planner. Same contract as `planCloseAll` — one order per
 * open contract, degrade rather than skip, name everything degraded — but keyed
 * by exchange symbol, because a hosted strategy has no book and no leg tags.
 */
const pos = (tradingsymbol: string, qty: number, avgCost = 100): NetPosition => ({
  tradingsymbol,
  qty,
  avgCost,
})
const bySymbol = (m: Record<string, number>) => (s: string): number | null => m[s] ?? null

test('flatten closes a short by BUYING and a long by SELLING', () => {
  const plan = planFlatten({
    positions: [pos('X1', -175), pos('X2', 70)],
    style: 'fast',
    marks: bySymbol({}),
  })
  assert.equal(plan.legs.length, 2)
  assert.deepEqual(
    plan.legs.map((l) => [l.tradingsymbol, l.side, l.qty]),
    [['X1', 'Buy', 175], ['X2', 'Sell', 70]],
  )
})

test('a FLAT contract gets no order — it would be a naked SELL of nothing', () => {
  // `buildPositions` retains a closed contract at qty 0 because it still carries
  // the day's realised P&L. Sending an order for it would pick its side from
  // `0 < 0` being false, i.e. SELL, and open a brand-new short.
  const plan = planFlatten({ positions: [pos('X1', 0)], style: 'fast', marks: bySymbol({}) })
  assert.equal(plan.legs.length, 0)
})

test('flatten limit style prices THROUGH the mark, both directions', () => {
  const plan = planFlatten({
    positions: [pos('X1', -175), pos('X2', 70)],
    style: 'limit',
    aggressionPct: 0.02,
    marks: bySymbol({ X1: 10, X2: 10 }),
  })
  assert.equal(plan.legs[0]?.limitPrice, 10.2, 'buying back a short bids above')
  assert.equal(plan.legs[1]?.limitPrice, 9.8, 'selling a long offers below')
})

test('flatten: an UNMARKED leg degrades to MARKET and is NAMED — never skipped', () => {
  const plan = planFlatten({
    positions: [pos('X1', -175), pos('X2', -175)],
    style: 'limit',
    marks: bySymbol({ X1: 10 }),
  })
  assert.equal(plan.legs.length, 2, 'BOTH legs must still be closed')
  assert.equal(plan.legs[1]?.orderType, 'MARKET')
  assert.deepEqual(plan.unpriceable, ['X2'])
  assert.match(plan.legs[1]?.degraded ?? '', /no mark/)
})

test('flatten: fast style never needs a mark, so nothing is unpriceable', () => {
  const plan = planFlatten({ positions: [pos('X1', -175)], style: 'fast', marks: bySymbol({}) })
  assert.equal(plan.legs[0]?.orderType, 'MARKET')
  assert.equal(plan.unpriceable.length, 0)
})

test('flatten books an unmarked leg at AVERAGE COST, never at zero', () => {
  // A fill journalled at 0 does not fail; it silently reports the entire premium
  // as profit. Average cost books it at no gain and no loss, and says so.
  const plan = planFlatten({
    positions: [pos('X1', -175, 42.5)],
    style: 'fast',
    marks: bySymbol({}),
  })
  assert.equal(plan.legs[0]?.price, 42.5)
  assert.match(plan.legs[0]?.degraded ?? '', /average cost/)
})

test('flatten prices a marked leg at the LIVE mark, not at what it was opened at', () => {
  const plan = planFlatten({
    positions: [pos('X1', -175, 42.5)],
    style: 'fast',
    marks: bySymbol({ X1: 61 }),
  })
  assert.equal(plan.legs[0]?.price, 61)
  assert.equal(plan.legs[0]?.degraded, '')
})

/**
 * A MARK OF EXACTLY 0 IS A MARK, and this module used to disagree with the two
 * others that read the same number.
 *
 * `@algomaker/pnl` accepts 0 deliberately — a worthless far-OTM option genuinely
 * marks at zero — and so does `pnlstore.ts:toStampedFill`. `planFlatten` tested
 * `mark > 0`, so it reclassified that genuine zero as "no mark", journalled the
 * exit at the AVERAGE COST instead, and attached a `degraded` note saying there
 * was no mark when there had been one. The same contract then booked two
 * different prices depending on which path closed it.
 */
test('flatten: a mark of exactly 0 is a real mark and is journalled as one', () => {
  const plan = planFlatten({
    positions: [pos('X1', -175, 42.5)],
    style: 'limit',
    marks: bySymbol({ X1: 0 }),
  })
  assert.equal(plan.legs[0]?.price, 0, 'the true mark, not the average cost')
  // Still not LIMIT-priceable: a closing sell priced through 0 lands at or below
  // zero, which no exchange accepts. MARKET is the honest degradation...
  assert.equal(plan.legs[0]?.orderType, 'MARKET')
  assert.deepEqual(plan.unpriceable, ['X1'])
  // ...but the reason must say what was actually true.
  assert.doesNotMatch(plan.legs[0]?.degraded ?? '', /no mark/)
  assert.match(plan.legs[0]?.degraded ?? '', /cannot be priced as a crossing limit/)
})

test('flatten: a NEGATIVE mark is still no mark — it cannot be a price', () => {
  const plan = planFlatten({
    positions: [pos('X1', -175, 42.5)],
    style: 'limit',
    marks: bySymbol({ X1: -5 }),
  })
  assert.equal(plan.legs[0]?.orderType, 'MARKET')
  assert.deepEqual(plan.unpriceable, ['X1'])
  assert.equal(plan.legs[0]?.price, 42.5, 'booked at no gain and no loss, never at a nonsense price')
  assert.match(plan.legs[0]?.degraded ?? '', /average cost/)
})

test('flatten: an empty position list plans nothing rather than erroring', () => {
  const plan = planFlatten({ positions: [], style: 'fast', marks: bySymbol({}) })
  assert.equal(plan.legs.length, 0)
  assert.equal(plan.unpriceable.length, 0)
})

test('the full BHEL book closes in one plan', () => {
  const book = [
    leg('CE420', -13125, 'BHEL26AUG420CE'), leg('CE425', -13125, 'BHEL26AUG425CE'),
    leg('CE430', -13125, 'BHEL26AUG430CE'), leg('CE470', 39375, 'BHEL26AUG470CE'),
    leg('PE415', -13125, 'BHEL26AUG415PE'), leg('PE410', -13125, 'BHEL26AUG410PE'),
    leg('PE405', -13125, 'BHEL26AUG405PE'), leg('PE380', 39375, 'BHEL26AUG380PE'),
  ]
  const plan = planCloseAll({ book, style: 'fast', marks: marks({}) })
  assert.equal(plan.actions.length, 8)
  assert.deepEqual(
    plan.actions.map((a) => (a.op === 'close' ? a.ts : '')),
    ['CE420', 'CE425', 'CE430', 'CE470', 'PE415', 'PE410', 'PE405', 'PE380'],
  )
})

// ------------------------------------------ F-34: the aggression a route accepts

/**
 * `priceExit` above has no ceiling of its own — it is handed a fraction and
 * trusts it. These pin the check that stands in front of it on all three
 * flatten call sites: `aggressionPct: 5`, the natural way to mistype "5%",
 * buys a ₹40 short back at a ₹240 limit.
 */
test('aggression is optional — absent is not an error, it means none', () => {
  assert.equal(aggressionPctError(undefined), null)
})

test('a sane fraction passes, at both ends of the range', () => {
  assert.equal(aggressionPctError(0), null)
  assert.equal(aggressionPctError(0.02), null)
  assert.equal(aggressionPctError(MAX_AGGRESSION_PCT), null)
})

test('a percentage sent as a whole number is refused, and the message says what a fraction is', () => {
  const why = aggressionPctError(5)
  assert.notEqual(why, null)
  assert.match(String(why), /0\.02/)
})

test('negative aggression is refused — it would price an exit AWAY from the market', () => {
  assert.notEqual(aggressionPctError(-0.01), null)
})

test('NaN and Infinity are refused, which typeof alone would not catch', () => {
  assert.notEqual(aggressionPctError(Number.NaN), null)
  assert.notEqual(aggressionPctError(Number.POSITIVE_INFINITY), null)
  assert.notEqual(aggressionPctError('0.02'), null)
})

/**
 * The ceiling is only meaningful if it is BELOW the mistype it exists to stop
 * and ABOVE what the desk actually uses (0.02 is the dashboard's default).
 */
test('the ceiling sits between the desk\'s own aggression and the mistyped percentage', () => {
  assert.ok(MAX_AGGRESSION_PCT > 0.02)
  assert.ok(MAX_AGGRESSION_PCT < 1)
})

// ------------------------------------------------------------ broker link

test('the broker link refuses LIVE only, exits included, and names the reason and the way back', () => {
  const released = { desired: 'released' as const, reason: 'key needed elsewhere' }
  const live = brokerLinkRefusal('live', released)
  assert.ok(live !== null)
  assert.match(live, /^broker link:/)
  assert.match(live, /key needed elsewhere/)
  assert.match(live, /exits included/)
  assert.match(live, /Controls/)
  // Paper never spoke to XTS.
  assert.equal(brokerLinkRefusal('paper', released), null)
  // And a connected link is no gate at all.
  assert.equal(brokerLinkRefusal('live', { desired: 'connected', reason: '' }), null)
  // No reason, no empty parentheses.
  assert.doesNotMatch(brokerLinkRefusal('live', { desired: 'released', reason: '' }) ?? '', /\(\)/)
})

test('the stored link document is read defensively — only the literal words mean anything', () => {
  assert.deepEqual(readBrokerLinkDoc(null), DEFAULT_BROKER_LINK)
  assert.deepEqual(readBrokerLinkDoc('nonsense'), DEFAULT_BROKER_LINK)
  assert.equal(readBrokerLinkDoc({ desired: 'RELEASED' }).desired, 'connected')
  assert.equal(readBrokerLinkDoc({ desired: true }).desired, 'connected')
  const full = readBrokerLinkDoc({
    _id: 'broker-link',
    desired: 'released',
    reason: 'x',
    setBy: 'op',
    setAt: 5,
    applied: 'released',
    appliedAt: 7,
    appliedError: 'logout failed: fetch failed',
  })
  assert.deepEqual(full, {
    desired: 'released',
    reason: 'x',
    setBy: 'op',
    setAt: 5,
    applied: 'released',
    appliedAt: 7,
    appliedError: 'logout failed: fetch failed',
  })
  // A wish the gateway has not answered yet: `applied` is null, never a guess.
  assert.equal(readBrokerLinkDoc({ desired: 'released' }).applied, null)
})
