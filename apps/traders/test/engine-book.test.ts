import { test } from 'node:test'
import assert from 'node:assert/strict'
import { corridor, type ChainSnap } from '@algomaker/desk-engine'
import { TRADER_DIALS, bandOf } from '../src/analytics/band.ts'
import { bookView } from '../src/analytics/book-view.ts'
import {
  MEASURED_NOTE, OFFSET_INSTRUMENT, chainSnapOf, engineBookOf, nearFutureOf, type EngineBook, type EngineBookResult,
} from '../src/analytics/engine-book.ts'
import { forwardFor } from '../src/analytics/month-chain.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { legKey, type BookView, type Instrument, type LegView, type OptType, type TraderLeg } from '../src/types.ts'
import { NIFTY_W1, NIFTY_W2, NOV, OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'

const NOW = Date.parse('2026-10-19T11:00:00+05:30')
const M = r3Master()

/** TCS spot 3395 and its OCT future 3400 (two-sided), OCT and NOV chains priced; NIFTY 25000 and its first weekly. */
function market(): ReturnType<typeof fakeQuotes> {
  const q = fakeQuotes()
  q.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: NOW })
  q.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: NOW })
  priceChain(q, M, 'TCS', OCT, 3400, 0.25, NOW)
  priceChain(q, M, 'TCS', NOV, 3420, 0.25, NOW)
  q.set(spotTokenOf(M, 'NIFTY') as number, { price: 25000, asOf: NOW })
  priceChain(q, M, 'NIFTY', NIFTY_W1, 25000, 0.15, NOW)
  return q
}

function tl(stock: string, instrument: Instrument, expiry: string, strike: number | null, optType: OptType | null, qty: number): TraderLeg {
  const base = { trader: 'ravi', stock, instrument, expiry, strike, optType, qty, avgPrice: 50, clientCode: 'C1', source: 'odin' as const, token: null, note: '', updatedAt: 0 }
  return { ...base, key: legKey(base) }
}

function viewOf(stock: string, legs: readonly TraderLeg[], q = market()): BookView {
  return bookView({ stock, legs, master: M, quotes: q, asOf: NOW, watcher: null, files: [], historyFrom: null, payoff: () => null })
}

function engineBook(r: EngineBookResult): EngineBook {
  if ('blocked' in r) throw new Error(`blocked: ${r.blocked}`)
  return r
}

const BARE: ChainSnap = {
  symbol: 'TCS', expiry: OCT, step: 50, lotSize: 175, future: { bid: null, ask: null, ltp: 3400, asOf: NOW }, spot: 3400, strikes: [], asOf: NOW,
}

test('engine legs carry per-share greeks from the view', () => {
  const leg: LegView = {
    key: 'C1|option|TCS|2026-10-27|3500|CE', source: 'odin', clientCode: 'C1', note: '', lotSize: 175,
    instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, avgPrice: 40,
    ltp: 30, iv: 0.25, delta: -140, gamma: -0.7, vega: -105, theta: 350, mtm: 3500, matched: true,
  }
  const view: BookView = {
    stock: 'TCS', asOf: NOW, closed: false, spot: 3395, futures: { [OCT]: 3400 }, forwards: { [OCT]: 3400 }, legs: [leg],
    totals: { delta: -140, gamma: -0.7, vega: -105, theta: 350, mtm: 3500 }, payoff: null, unmatched: [], mismatch: null, historyFrom: null, warnings: [],
  }
  const b = engineBook(engineBookOf(view, BARE, { expiry: OCT, lotSize: 175 }, NOW, 'ravi'))
  const l = b.inputs.legs[0]
  assert.ok(l)
  assert.deepEqual(
    { delta: l.delta, gamma: l.gamma, vega: l.vega, theta: l.theta, side: l.side, lots: l.lots, lotSize: l.lotSize },
    { delta: 0.4, gamma: 0.002, vega: 0.3, theta: -1, side: 'Sell', lots: 2, lotSize: 175 },
  )
  assert.deepEqual(
    { instrument: l.instrument, strike: l.strike, optType: l.optType, entry: l.entry, iv: l.iv, hasGreeks: l.hasGreeks, mtm: l.mtm, openedByEngine: l.openedByEngine, leanId: l.leanId },
    { instrument: leg.key, strike: 3500, optType: 'CE', entry: 40, iv: 0.25, hasGreeks: true, mtm: 3500, openedByEngine: false, leanId: '' },
  )
  // no chain row for the strike: the leg's own price, as a print
  assert.deepEqual(l.exit, { bid: null, ask: null, ltp: 30, asOf: NOW })
  const { legs: _legs, chain: _chain, ...rest } = b.inputs
  assert.deepEqual(rest, {
    tag: 'traders:ravi:TCS', mode: 'paper', nowMs: NOW, dateIst: '2026-10-19', minuteOfDay: 660, dte: 8,
    protectedQty: {}, cumRealized: 0, margin: { value: 0, source: 'model', asOf: NOW, fresh: false }, pendingLots: 0, repairHold: false, pricing: 'live',
  })
  assert.deepEqual([b.expiry, b.lotSize, b.nearFuture, b.offsetShares, b.notes], [OCT, 175, { expiry: OCT, lotSize: 175 }, 0, []])
  // an unpriced leg is carried, flagged, never zero-filled into a mark
  const flat = engineBook(engineBookOf({ ...view, legs: [{ ...leg, iv: null, delta: 0, gamma: 0, vega: 0, theta: 0, ltp: null, mtm: null }] }, BARE, null, NOW, 'ravi'))
  assert.deepEqual([flat.inputs.legs[0]?.hasGreeks, flat.inputs.legs[0]?.mtm, flat.inputs.legs[0]?.delta, Object.is(flat.inputs.legs[0]?.gamma, 0)], [false, 0, 0, true])
})

test('netDelta equals the BookView delta', () => {
  const view = viewOf('TCS', [
    tl('TCS', 'option', OCT, 3400, 'CE', -350), tl('TCS', 'option', OCT, 3300, 'PE', 175), tl('TCS', 'option', OCT, 3500, 'PE', -525),
  ])
  const chain = chainSnapOf(M, market(), view, OCT, NOW)
  assert.ok(chain)
  assert.deepEqual([chain.symbol, chain.expiry, chain.spot, chain.lotSize, chain.step], ['TCS', OCT, view.forwards[OCT], 175, 50])
  assert.equal(chain.spot, 3400)
  assert.deepEqual(chain.future, { bid: 3399.5, ask: 3400.5, ltp: 3400, asOf: NOW })
  assert.deepEqual(chain.strikes.map((s) => s.strike), [3300, 3350, 3400, 3450, 3500])
  for (const s of chain.strikes) for (const side of [s.ce, s.pe]) assert.ok(side !== null && side.bid !== null && side.ask !== null && side.asOf === NOW)
  const b = engineBook(engineBookOf(view, chain, nearFutureOf(M, 'TCS', '2026-10-19'), NOW, 'ravi'))
  const cor = corridor(b.inputs, TRADER_DIALS)
  const sum = view.legs.reduce((a, l) => a + l.delta, 0)
  assert.ok(Math.abs(cor.netDelta - sum) < 1e-9, `${cor.netDelta} vs ${sum}`)
  assert.ok(Math.abs(cor.netDelta - view.totals.delta) < 1e-9)
  assert.equal(cor.hasGreeks, true)
  // gamma is read off the shorts only (trader = relief-r's gamma_shorts_only)
  const shortGamma = view.legs.filter((l) => l.qty < 0).reduce((a, l) => a + l.gamma, 0)
  assert.ok(Math.abs(cor.netGamma - shortGamma) < 1e-9)
  // the exit quote is the chain's own row
  const ce = b.inputs.legs.find((l) => l.strike === 3400)
  assert.equal(ce?.exit, chain.strikes.find((s) => s.strike === 3400)?.ce)
})

test('a NIFTY weekly book', () => {
  const view = viewOf('NIFTY', [tl('NIFTY', 'option', NIFTY_W1, 25000, 'CE', -150), tl('NIFTY', 'option', NIFTY_W1, 24800, 'PE', -75)])
  const chain = chainSnapOf(M, market(), view, NIFTY_W1, NOW)
  assert.ok(chain)
  assert.equal(chain.spot, view.forwards[NIFTY_W1])
  assert.equal(typeof chain.spot, 'number')
  assert.equal(chain.future.bid, null)
  assert.equal(chain.future.ask, null)
  assert.equal(chain.future.ltp, chain.spot)
  assert.equal(chain.lotSize, 75)
  assert.equal(chain.step, 50)
  const nf = nearFutureOf(M, 'NIFTY', '2026-10-19')
  assert.deepEqual(nf, { expiry: NIFTY_W2, lotSize: 75 })
  const b = engineBook(engineBookOf(view, chain, nf, NOW, 'ravi'))
  assert.equal(b.nearFuture?.expiry, NIFTY_W2)
  assert.deepEqual(b.inputs.legs.map((l) => [l.lots, l.lotSize]), [[1, 75], [2, 75]])
  assert.equal(b.inputs.dte, 1)
})

test('a future leg is measured', () => {
  const view = viewOf('TCS', [tl('TCS', 'option', OCT, 3400, 'CE', -350), tl('TCS', 'future', OCT, null, null, 175)])
  const chain = chainSnapOf(M, market(), view, OCT, NOW)
  assert.ok(chain)
  const b = engineBook(engineBookOf(view, chain, nearFutureOf(M, 'TCS', '2026-10-19'), NOW, 'ravi'))
  const fut = view.legs.find((l) => l.instrument === 'future')
  assert.ok(fut !== undefined && fut.matched && fut.ltp !== null)
  assert.deepEqual(b.inputs.legs.find((l) => l.instrument === fut.key), {
    kind: 'future', instrument: fut.key, strike: 0, optType: 'CE', side: 'Buy', lots: 175, lotSize: 1, entry: 50, openedByEngine: false, leanId: '',
    iv: null, delta: 1, gamma: 0, theta: 0, vega: 0, hasGreeks: true, mtm: fut.mtm, exit: { bid: null, ask: null, ltp: fut.ltp, asOf: chain.asOf },
  })
  const cor = corridor(b.inputs, TRADER_DIALS)
  assert.ok(Math.abs(cor.netDelta - view.totals.delta) < 1e-9, `${cor.netDelta} vs ${view.totals.delta}`)
  // its 175 shares of delta, and no gamma
  const options = corridor({ ...b.inputs, legs: b.inputs.legs.filter((l) => l.kind !== 'future') }, TRADER_DIALS)
  assert.ok(Math.abs(cor.netDelta - options.netDelta - 175) < 1e-9)
  assert.equal(cor.netGamma, options.netGamma)
  const band = bandOf(b, 'TCS', null, true, true)
  assert.notEqual(band.state, 'unknown', band.sentence)
  assert.equal(band.netDelta, cor.netDelta)
  assert.deepEqual([b.offsetShares, b.notes], [0, [MEASURED_NOTE]])
  assert.equal(MEASURED_NOTE, 'Futures and shares are counted in the band and never adjusted by the advice.')

  // shares, short: the same leg kind, its side by the sign; an unpriced one is still its delta
  const q = market()
  q.set(spotTokenOf(M, 'TCS') as number, { price: 0 })
  const shares = viewOf('TCS', [tl('TCS', 'option', OCT, 3400, 'CE', -350), tl('TCS', 'share', '', null, null, -100)], q)
  const sb = engineBook(engineBookOf(shares, chain, null, NOW, 'ravi'))
  const share = sb.inputs.legs.find((l) => l.kind === 'future')
  assert.deepEqual([share?.side, share?.lots, share?.lotSize, share?.hasGreeks, share?.mtm, share?.exit], ['Sell', 100, 1, true, 0, { bid: null, ask: null, ltp: null, asOf: chain.asOf }])
  assert.ok(Math.abs(corridor(sb.inputs, TRADER_DIALS).netDelta - shares.totals.delta) < 1e-9)
})

test('other expiries collapse to one offset', () => {
  const near: LegView = {
    key: 'C1|option|TCS|2026-10-27|3500|CE', source: 'odin', clientCode: 'C1', note: '', lotSize: 175,
    instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, avgPrice: 40,
    ltp: 30, iv: 0.25, delta: -140, gamma: -0.7, vega: -105, theta: 350, mtm: 3500, matched: true,
  }
  const nov = (strike: number, qty: number, delta: number, iv: number | null = 0.25): LegView => ({
    ...near, key: `C1|option|TCS|${NOV}|${strike}|CE`, expiry: NOV, strike, qty, ltp: 60, iv, delta, gamma: 0.001 * qty, vega: 0.5 * qty, theta: -0.4 * qty, mtm: 10 * qty,
  })
  const view: BookView = {
    stock: 'TCS', asOf: NOW, closed: false, spot: 3395, futures: { [OCT]: 3400, [NOV]: null }, forwards: { [OCT]: 3400, [NOV]: 3420 },
    legs: [near, nov(3400, 1750, 900), nov(3500, 1050, 350)],
    totals: { delta: 1110, gamma: 2.1, vega: 1295, theta: -770, mtm: 31500 }, payoff: null, unmatched: [], mismatch: null, historyFrom: null, warnings: [],
  }
  const b = engineBook(engineBookOf(view, BARE, { expiry: OCT, lotSize: 175 }, NOW, 'ravi'))
  assert.deepEqual(b.inputs.legs.map((l) => l.instrument), [near.key, OFFSET_INSTRUMENT])
  assert.equal(OFFSET_INSTRUMENT, 'offset:other-expiries')
  // a fixed delta and nothing else: entered and valued at the forward, so its P&L is 0 (as repair's offset)
  assert.deepEqual(b.inputs.legs[1], {
    kind: 'future', instrument: 'offset:other-expiries', strike: 0, optType: 'CE', side: 'Buy', lots: 1250, lotSize: 1, entry: 3400, openedByEngine: false, leanId: '',
    iv: null, delta: 1, gamma: 0, theta: 0, vega: 0, hasGreeks: true, mtm: 0, exit: { bid: null, ask: null, ltp: 3400, asOf: NOW },
  })
  assert.deepEqual([b.offsetShares, b.offsetUnpriced, b.notes], [1250, [], []])
  assert.ok(Math.abs(corridor(b.inputs, TRADER_DIALS).netDelta - view.totals.delta) < 1e-9)

  // net short: a Sell of the shares; an unpriced one marks the leg, and is named
  const short = engineBook(engineBookOf({ ...view, legs: [near, nov(3400, -1750, -900), nov(3600, 175, 0, null)] }, BARE, null, NOW, 'ravi'))
  const offset = short.inputs.legs.find((l) => l.instrument === OFFSET_INSTRUMENT)
  assert.deepEqual([offset?.side, offset?.lots, offset?.hasGreeks, short.offsetShares, short.offsetUnpriced], ['Sell', 900, false, -900, ['3600 CE 2026-11-24']])
  // netting to nothing, all priced: no leg at all
  const flat = engineBook(engineBookOf({ ...view, legs: [near, nov(3400, 1750, 900), nov(3500, -1750, -900)] }, BARE, null, NOW, 'ravi'))
  assert.deepEqual([flat.inputs.legs.map((l) => l.instrument), flat.offsetShares], [[near.key], 0])
  // ... but an unpriced one keeps it, at 0 shares, so the band cannot read as measured
  const hole = engineBook(engineBookOf({ ...view, legs: [near, nov(3600, 175, 0, null)] }, BARE, null, NOW, 'ravi'))
  assert.deepEqual(hole.inputs.legs.filter((l) => l.instrument === OFFSET_INSTRUMENT).map((l) => [l.lots, l.hasGreeks]), [[0, false]])
})

test('unmatched legs are left out with a note', () => {
  const view = viewOf('TCS', [tl('TCS', 'option', OCT, 3400, 'CE', -350), tl('TCS', 'option', OCT, 9999, 'CE', -175)])
  assert.equal(view.legs.filter((l) => !l.matched).length, 1)
  const chain = chainSnapOf(M, market(), view, OCT, NOW)
  assert.ok(chain)
  const b = engineBook(engineBookOf(view, chain, null, NOW, 'ravi'))
  assert.deepEqual(b.notes, ['1 row not understood is left out'])
  assert.deepEqual(b.inputs.legs.map((l) => l.strike), [3400])
  const two = viewOf('TCS', [tl('TCS', 'option', OCT, 3400, 'CE', -350), tl('TCS', 'option', OCT, 9999, 'CE', -175), tl('TCS', 'option', OCT, 9998, 'PE', 175)])
  assert.deepEqual(engineBook(engineBookOf(two, chain, null, NOW, 'ravi')).notes, ['2 rows not understood are left out'])
})

test('no forward for the expiry, no chain; a month the book holds nothing in is priced by the same rule', () => {
  const q = market()
  const view = viewOf('TCS', [tl('TCS', 'option', OCT, 3400, 'CE', -350)], q)
  assert.equal(chainSnapOf(M, q, { ...view, forwards: { [OCT]: null } }, OCT, NOW), null)
  // NOV is not held: the view priced no forward for it, and the chain takes R1's forward off the same quotes
  assert.equal(view.forwards[NOV], undefined)
  const nov = chainSnapOf(M, q, view, NOV, NOW)
  const fwd = forwardFor(M, q, 'TCS', NOV, view.spot, NOW)
  assert.ok(nov !== null && fwd !== null)
  assert.deepEqual([nov.expiry, nov.spot, nov.future, fwd.source], [NOV, fwd.price, { bid: null, ask: null, ltp: fwd.price, asOf: NOW }, 'parity'])
  assert.equal(chainSnapOf(M, q, view, '2026-11-03', NOW), null)   // TCS lists no such chain
  // no price anywhere for an unheld month: no chain
  assert.equal(chainSnapOf(M, fakeQuotes(), { ...view, spot: null }, NOV, NOW), null)
})

test('a listed but unquoted future is replaced by the forward as a print', () => {
  const q = market()
  const view = viewOf('TCS', [tl('TCS', 'option', OCT, 3400, 'CE', -350)], q)
  q.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 0, bid: null, ask: null })
  const chain = chainSnapOf(M, q, view, OCT, NOW)
  assert.deepEqual(chain?.future, { bid: null, ask: null, ltp: 3400, asOf: NOW })
})

test('a one-sided quote keeps its print and drops the half book', () => {
  const q = market()
  const view = viewOf('TCS', [tl('TCS', 'option', OCT, 3400, 'CE', -350)], q)
  const token = M.options.resolve('TCS', OCT, 3300, 'CE')?.instrumentToken as number
  q.set(token, { price: 120, bid: 119, ask: null })
  const row = chainSnapOf(M, q, view, OCT, NOW)?.strikes.find((s) => s.strike === 3300)
  assert.deepEqual(row?.ce, { bid: null, ask: null, ltp: 120, asOf: NOW })
})

test('nearFutureOf skips an expiry that lists no future, and is null with none at all', () => {
  assert.deepEqual(nearFutureOf(M, 'TCS', '2026-10-28'), { expiry: NOV, lotSize: 175 })
  assert.equal(nearFutureOf(M, 'SENSEX', '2026-10-19'), null)
})
