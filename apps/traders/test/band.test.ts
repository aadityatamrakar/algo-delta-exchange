import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChainSnap, LegView as EngineLeg } from '@algomaker/desk-engine'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { BandOverrideStore, EventStore, bandOf, type BandEvent } from '../src/analytics/band.ts'
import { bookView, futurePriceName, spotPriceName, stalePricePrefix } from '../src/analytics/book-view.ts'
import { toNeutralize } from '../src/analytics/analysis.ts'
import { OFFSET_INSTRUMENT, type EngineBook } from '../src/analytics/engine-book.ts'
import { BookRisk, engineBookFor } from '../src/analytics/risk.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { FEED_NOT_TICKING } from '../src/market/quotes.ts'
import { legKey, type BookView, type Instrument, type LegView, type OptType } from '../src/types.ts'
import { NIFTY_W1, NIFTY_W2, NOV, OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { connectSuite, wipe } from './mongo.ts'

const NOW = Date.parse('2026-10-19T11:00:00+05:30')

const CHAIN: ChainSnap = {
  symbol: 'TCS', expiry: OCT, step: 10, lotSize: 25, future: { bid: null, ask: null, ltp: 300, asOf: NOW }, spot: 300, strikes: [], asOf: NOW,
}

function short(optType: 'CE' | 'PE', delta: number, over: Partial<EngineLeg> = {}): EngineLeg {
  return {
    instrument: `C1|option|TCS|${OCT}|${optType === 'CE' ? 320 : 280}|${optType}`, strike: optType === 'CE' ? 320 : 280, optType,
    side: 'Sell', lots: 10, lotSize: 25, entry: 5, openedByEngine: false, leanId: '', iv: 0.3, delta, gamma: 0.04, theta: -0.5, vega: 0.2,
    hasGreeks: true, mtm: 0, exit: { bid: 4.9, ask: 5.1, ltp: 5, asOf: NOW }, ...over,
  }
}

/** Short 10 lots CE (δ 0.8) and short 10 lots PE (δ 0.3), γ 0.04 each, lot 25, spot 300; the nearest future is TCS OCT. */
function book(o: { ce?: Partial<EngineLeg>; nearFuture?: EngineBook['nearFuture'] } = {}): EngineBook {
  return {
    inputs: {
      tag: 'traders:ravi:TCS', mode: 'paper', nowMs: NOW, dateIst: '2026-10-19', minuteOfDay: 660, dte: 8, chain: CHAIN,
      legs: [short('CE', 0.8, o.ce), short('PE', 0.3)],
      protectedQty: {}, cumRealized: 0, margin: { value: 0, source: 'model', asOf: NOW, fresh: false }, pendingLots: 0, repairHold: false, pricing: 'live',
    },
    expiry: OCT, lotSize: 25, nearFuture: o.nearFuture === undefined ? { expiry: OCT, lotSize: 25 } : o.nearFuture, offsetShares: 0, offsetUnpriced: [], notes: [],
  }
}

test("the band is the engine's corridor under trader, in lots", () => {
  const b = bandOf(book(), 'TCS', null, true, true)
  assert.equal(b.bandShares, 120)
  assert.equal(b.bandLots, 4.8)
  assert.equal(b.lotSize, 25)
  assert.equal(b.source, 'engine')
  assert.equal(b.marketOpen, true)
})

test('out by the excess, neutralize by the whole delta', () => {
  const b = bandOf(book(), 'TCS', null, true, true)
  assert.equal(b.netDelta, -125)
  assert.equal(b.state, 'out')
  assert.equal(b.outByLots, 1)
  assert.equal(b.toNeutralize?.text, 'Buy 5 lots TCS OCT FUT')
  assert.equal(b.toNeutralize?.lots, 5)
  assert.equal(b.sentence, 'Out of band by 1 lot — To neutralize: Buy 5 lots TCS OCT FUT')
})

test('an override of 2 lots', () => {
  const b = bandOf(book(), 'TCS', 2, true, true)
  assert.deepEqual([b.bandShares, b.bandLots, b.outByLots, b.source, b.state], [50, 2, 3, 'override', 'out'])
  assert.equal(b.sentence, 'Out of band by 3 lots — To neutralize: Buy 5 lots TCS OCT FUT')
  assert.equal(bandOf(book({ ce: { delta: 0.5 } }), 'TCS', 1, true, true).sentence, 'Out of band by 1 lot — To neutralize: Buy 2 lots TCS OCT FUT')
  assert.equal(bandOf(book({ ce: { delta: 0.5 } }), 'TCS', 2.5, true, true).sentence, 'In band (±2.5 lots)')
})

test('in band', () => {
  const b = bandOf(book({ ce: { delta: 0.5 } }), 'TCS', null, true, true)
  assert.deepEqual([b.state, b.netDelta, b.outByLots], ['in', -50, 0])
  assert.equal(b.sentence, 'In band (±4.8 lots)')
  assert.equal(b.toNeutralize?.text, 'Buy 2 lots TCS OCT FUT')
})

test('feed dead → band unknown', () => {
  const b = bandOf(book(), 'TCS', null, false, true)
  assert.equal(b.state, 'unknown')
  assert.equal(b.sentence, 'Band unknown: the market data feed is dead')
  assert.deepEqual([b.netDelta, b.bandShares, b.bandLots, b.outByLots, b.toNeutralize], [null, null, null, 0, null])
  // an override is the trader's own number, not a market read: it is still said
  const o = bandOf(book(), 'TCS', 2, false, true)
  assert.deepEqual([o.state, o.bandLots, o.bandShares, o.netDelta, o.source], ['unknown', 2, 50, null, 'override'])
})

test('a leg with no IV → unknown, naming the leg', () => {
  const b = bandOf(book({ ce: { iv: null, hasGreeks: false, delta: 0, gamma: 0 } }), 'TCS', null, true, true)
  assert.equal(b.state, 'unknown')
  assert.equal(b.sentence, 'Band unknown: a leg has no IV (320 CE 2026-10-27)')
  assert.equal(b.netDelta, null)
  const both = book({ ce: { iv: null, hasGreeks: false } })
  const legs = [both.inputs.legs[0] as EngineLeg, { ...(both.inputs.legs[1] as EngineLeg), iv: null, hasGreeks: false }]
  assert.equal(bandOf({ ...both, inputs: { ...both.inputs, legs } }, 'TCS', null, true, true).sentence,
    'Band unknown: 2 legs have no IV (320 CE 2026-10-27, 280 PE 2026-10-27)')
})

test('market closed suffix', () => {
  assert.equal(bandOf(book(), 'TCS', null, true, false).sentence, 'Out of band by 1 lot — To neutralize: Buy 5 lots TCS OCT FUT (market closed)')
  assert.equal(bandOf(book({ ce: { delta: 0.5 } }), 'TCS', null, true, false).sentence, 'In band (±4.8 lots) (market closed)')
  // outside the session a quiet feed is not a dead one: the last prices are read, and said to be closed
  const quiet = bandOf(book(), 'TCS', null, false, false)
  assert.deepEqual([quiet.state, quiet.marketOpen], ['out', false])
  assert.ok(quiet.sentence.endsWith(' (market closed)'))
})

test('blocked → unknown with the blocking sentence', () => {
  const why = 'Band unknown: no forward for the 27 Oct chain yet'
  const b = bandOf({ blocked: why }, 'TCS', null, true, true)
  assert.deepEqual([b.state, b.sentence, b.lotSize, b.netDelta, b.toNeutralize, b.source], ['unknown', why, null, null, null, 'engine'])
  assert.equal(bandOf({ blocked: why }, 'TCS', null, true, false).sentence, why)   // no suffix on an unknown
})

test('a chain with no lot size is said before anything is measured', () => {
  const b = bandOf({ ...book(), lotSize: 0 }, 'TCS', 2, false, true)   // ahead of the dead feed, too
  assert.deepEqual([b.state, b.sentence, b.lotSize, b.bandShares, b.bandLots], ['unknown', 'Band unknown: the 2026-10-27 chain has no lot size', null, null, 2])
})

test('no listed future: no To Neutralize, and the sentence stops at the lots', () => {
  const b = bandOf(book({ nearFuture: null }), 'SENSEX', null, true, true)
  assert.equal(b.toNeutralize, null)
  assert.equal(b.sentence, 'Out of band by 1 lot')
})

test('BandOverrideStore keeps one document per trader', async (t) => {
  const s = await connectSuite('band_store')
  if (s === null) return skipUnlessMongo(t)
  try {
    await wipe(s.handle)
    await s.db.ensureIndexes()
    let clock = 1000
    const store = new BandOverrideStore(s.db, () => clock)
    const docs = () => s.db.collection('traders-settings').find({ kind: 'band' }, { projection: { _id: 0 } }).toArray()
    await store.set('ravi', 'TCS', 2)
    clock = 2000
    await store.set('ravi', 'NIFTY', 3)
    assert.deepEqual(await docs(), [{ kind: 'band', trader: 'ravi', bands: { TCS: 2, NIFTY: 3 }, updatedAt: 2000 }])
    assert.deepEqual([await store.get('ravi', 'TCS'), await store.get('ravi', 'NIFTY'), await store.get('ravi', 'INFY'), await store.get('sita', 'TCS')], [2, 3, null, null])
    await store.set('ravi', 'TCS', null)
    assert.deepEqual(await docs(), [{ kind: 'band', trader: 'ravi', bands: { NIFTY: 3 }, updatedAt: 2000 }])
    assert.equal(await store.get('ravi', 'TCS'), null)
    // clearing for a trader with no document writes none
    await store.set('sita', 'TCS', null)
    assert.equal((await docs()).length, 1)
    // the charges table and a watcher document share the collection: neither is touched
    await s.db.collection('traders-settings').insertOne({ kind: 'watcher', trader: 'ravi', folder: 'C:\\odin' })
    await store.set('ravi', 'M&M', 1.5)
    assert.equal(await store.get('ravi', 'M&M'), 1.5)
    assert.deepEqual(await s.db.collection('traders-settings').find({ kind: 'watcher' }, { projection: { _id: 0 } }).toArray(), [{ kind: 'watcher', trader: 'ravi', folder: 'C:\\odin' }])
    await assert.rejects(store.set('ravi', 'a.b', 1), /stock/)
  } finally {
    await wipe(s.handle)
    await s.handle.close()
  }
})

test('EventStore keeps every event; lastBand is the newest per book', async (t) => {
  const s = await connectSuite('band_store')
  if (s === null) return skipUnlessMongo(t)
  try {
    await wipe(s.handle)
    const events = new EventStore(s.db)
    await events.ensureIndexes()
    const e = (trader: string, stock: string, from: 'in' | 'out', to: 'in' | 'out', at: number): BandEvent => ({
      trader, stock, kind: 'band', from, to, at, netDelta: -125, bandShares: 120, lotSize: 25, outByLots: to === 'out' ? 1 : 0, source: 'engine',
    })
    const first = e('ravi', 'TCS', 'in', 'out', 1)
    await events.add(first)
    assert.equal('_id' in first, false, 'add() must not stamp the caller\'s object')
    await events.add(e('ravi', 'TCS', 'out', 'in', 3))
    await events.add(e('ravi', 'NIFTY', 'in', 'out', 2))
    await events.add(e('sita', 'TCS', 'in', 'out', 5))
    assert.equal(await s.handle.db.collection('traders-events').countDocuments({}), 4)
    const last = await events.lastBand()
    assert.deepEqual(last.map((x) => [x.trader, x.stock, x.to, x.at]).sort(), [['ravi', 'NIFTY', 'out', 2], ['ravi', 'TCS', 'in', 3], ['sita', 'TCS', 'out', 5]])
    assert.equal(last.some((x) => '_id' in x), false)
    const raw = s.handle.db.collection('traders-events') as unknown as { indexes(): Promise<{ key: Record<string, number> }[]> }
    assert.ok((await raw.indexes()).some((i) => JSON.stringify(i.key) === JSON.stringify({ trader: 1, stock: 1, at: -1 })))
  } finally {
    await wipe(s.handle)
    await s.handle.close()
  }
})

// ---- BookRisk: the one-minute reading over a real BookView -----------------------------

const M = r3Master()
type Row = readonly [Instrument, string, number | null, OptType | null, number, ('odin' | 'manual')?]
const SHORT_ITM: readonly Row[] = [['option', OCT, 3300, 'CE', -1750]]

/** TCS spot 3395, its OCT future 3400 and OCT chain; NIFTY 25000, its W2 future 25020 and W2 chain; every quote fresh. */
function priced(o: { feedAlive?: boolean } = {}): ReturnType<typeof fakeQuotes> {
  const q = fakeQuotes(o)
  q.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: NOW })
  q.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: NOW })
  priceChain(q, M, 'TCS', OCT, 3400, 0.25, NOW)
  q.set(spotTokenOf(M, 'NIFTY') as number, { price: 25000, asOf: NOW })
  q.set(M.options.future('NIFTY', NIFTY_W2)?.instrumentToken as number, { price: 25020, bid: 25019, ask: 25021, asOf: NOW })
  priceChain(q, M, 'NIFTY', NIFTY_W2, 25020, 0.15, NOW)
  return q
}

function viewOf(stock: string, rows: readonly Row[], q: ReturnType<typeof fakeQuotes>, asOf = NOW): BookView {
  const legs = rows.map(([instrument, expiry, strike, optType, qty, source = 'odin']) => {
    const base = { trader: 'ravi', stock, instrument, expiry, strike, optType, qty, avgPrice: 50, clientCode: source === 'odin' ? 'C1' : '', source, token: null, note: '', updatedAt: 0 }
    return { ...base, key: legKey(base) }
  })
  return bookView({ stock, legs, master: M, quotes: q, asOf, watcher: null, files: [], historyFrom: null, payoff: () => null })
}

function tcs(rows: readonly Row[], o: { feedAlive?: boolean } = {}) {
  const q = priced(o)
  return { q, view: viewOf('TCS', rows, q) }
}

function riskOver(view: BookView | null, q: ReturnType<typeof fakeQuotes>) {
  const seen = { views: 0, version: 0, override: null as number | null }
  const risk = new BookRisk({
    bookView: async () => { seen.views++; return view },
    legs: { version: () => seen.version },
    bands: { get: async () => seen.override },
    master: () => M, quotes: q,
  })
  return { risk, seen }
}

test('BookRisk reads a book once a minute; a new leg version or a new override reads it again', async () => {
  const { q, view } = tcs(SHORT_ITM)
  const { risk, seen } = riskOver(view, q)
  const a = await risk.band('ravi', 'TCS', NOW)
  const [b, c] = await Promise.all([risk.band('ravi', 'TCS', NOW + 59_999), risk.band('ravi', 'TCS', NOW + 1)])
  assert.equal(seen.views, 1)
  assert.equal(a, b)
  assert.equal(a, c)
  assert.deepEqual([a?.state, a?.source, a?.lotSize], ['out', 'engine', 175])
  assert.ok(Math.abs((a?.netDelta as number) - view.totals.delta) < 1e-9)
  seen.version = 1
  await risk.band('ravi', 'TCS', NOW + 2)
  assert.equal(seen.views, 2)
  seen.override = 2
  const o = await risk.band('ravi', 'TCS', NOW + 3)
  assert.equal(seen.views, 3)
  assert.deepEqual([o?.source, o?.bandLots, o?.bandShares], ['override', 2, 350])
  await risk.band('ravi', 'TCS', NOW + 60_003)
  assert.equal(seen.views, 4)
  await risk.band('ravi', 'NIFTY', NOW + 60_003)   // another book is its own entry
  assert.equal(seen.views, 5)
})

test('BookRisk: no open book is null; no forward for its month, or no listed chain left, has no band', async () => {
  const { q, view } = tcs(SHORT_ITM)
  assert.equal(await riskOver(null, q).risk.band('ravi', 'TCS', NOW), null)
  const noForward: BookView = { ...view, forwards: { [OCT]: null } }
  assert.equal((await riskOver(noForward, q).risk.band('ravi', 'TCS', NOW))?.sentence, 'Band unknown: no forward for the 27 Oct chain yet')
  // M&M lists one chain, OCT: the day after it, a share book has none to be read on
  const WED = Date.parse('2026-10-28T11:00:00+05:30')
  const mm = viewOf('M&M', [['share', '', null, null, 700]], q, WED)
  assert.equal(mm.legs[0]?.matched, true)
  const b = await riskOver(mm, q).risk.band('ravi', 'M&M', WED)
  assert.deepEqual([b?.state, b?.sentence], ['unknown', 'Band unknown: M&M lists no option chain on or after 2026-10-28'])
})

test('shares-only book has a band', async () => {
  const { q, view } = tcs([['share', '', null, null, 1000]])
  assert.deepEqual(view.forwards, {}, 'a share book prices no month')
  const { risk } = riskOver(view, q)
  const b = await risk.band('ravi', 'TCS', NOW)
  // read on the near listed chain, OCT, at its own future: no gamma, so no band beyond the dial's floor (none)
  assert.deepEqual([b?.state, b?.netDelta, b?.lotSize, b?.bandShares, b?.outByLots], ['out', 1000, 175, 0, 6])
  assert.equal(b?.sentence, 'Out of band by 6 lots — To neutralize: Sell 6 lots TCS OCT FUT')
  const book = engineBookFor(M, q, view, 'ravi', NOW)
  assert.ok(!('blocked' in book), 'blocked' in book ? book.blocked : '')
  assert.deepEqual([book.expiry, book.inputs.chain.spot, book.inputs.legs.map((l) => [l.kind, l.side, l.lots])], [OCT, 3400, [['future', 'Buy', 1000]]])
  const a = await risk.advice('ravi', 'TCS', NOW)
  assert.deepEqual([a?.status, a?.headline, a?.lines, a?.whatIf], ['hold', 'Nothing to adjust in options', [], []])
  assert.equal(a?.band, b)
  // a futures-only book the same way, on its own month
  const fut = tcs([['future', OCT, null, null, -350]])
  const fb = await riskOver(fut.view, fut.q).risk.band('ravi', 'TCS', NOW)
  assert.deepEqual([fb?.state, fb?.netDelta, fb?.sentence], ['out', -350, 'Out of band by 2 lots — To neutralize: Buy 2 lots TCS OCT FUT'])
})

test('an unpriced NOV leg makes the band unknown', async () => {
  const { q, view } = tcs(SHORT_ITM)
  const nov: LegView = {
    key: `C1|option|TCS|${NOV}|3600|CE`, source: 'odin', clientCode: 'C1', note: '', lotSize: 175, instrument: 'option', expiry: NOV, strike: 3600, optType: 'CE',
    qty: 175, avgPrice: 20, ltp: null, iv: null, delta: 0, gamma: 0, vega: 0, theta: 0, mtm: null, matched: true,
  }
  const b = await riskOver({ ...view, legs: [...view.legs, nov] }, q).risk.band('ravi', 'TCS', NOW)
  assert.deepEqual([b?.state, b?.sentence, b?.netDelta], ['unknown', 'Band unknown: a leg has no IV (3600 CE 2026-11-24)', null])
  // through R1's view: TCS NOV is not quoted, so its month is spot carried and no vol is solved for the leg
  const real = tcs([...SHORT_ITM, ['option', NOV, 3500, 'CE', 175]])
  assert.deepEqual(real.view.legs.map((l) => [l.expiry, l.iv === null]), [[OCT, false], [NOV, true]])
  assert.equal((await riskOver(real.view, real.q).risk.band('ravi', 'TCS', NOW))?.sentence, 'Band unknown: a leg has no IV (3500 CE 2026-11-24)')
  // with the near month's own leg unpriced too, both are named, near first
  const near = { ...(view.legs[0] as LegView), iv: null, delta: 0, gamma: 0, vega: 0, theta: 0 }
  const both = engineBookFor(M, q, { ...view, legs: [near, nov] }, 'ravi', NOW)
  assert.ok(!('blocked' in both))
  assert.deepEqual(both.inputs.legs.map((l) => [l.instrument, l.hasGreeks]), [[near.key, false], [OFFSET_INSTRUMENT, false]])
  assert.equal(bandOf(both, 'TCS', null, true, true).sentence, 'Band unknown: 2 legs have no IV (3300 CE 2026-10-27, 3600 CE 2026-11-24)')
})

test('adding 1,000 TCS shares by hand moves the band by 1,000 shares', async () => {
  const q = priced()
  const before = viewOf('TCS', SHORT_ITM, q)
  const after = viewOf('TCS', [...SHORT_ITM, ['share', '', null, null, 1000, 'manual']], q)
  assert.deepEqual(after.legs.filter((l) => l.instrument === 'share').map((l) => [l.source, l.matched]), [['manual', true]])
  const [a, b] = await Promise.all([riskOver(before, q).risk.band('ravi', 'TCS', NOW), riskOver(after, q).risk.band('ravi', 'TCS', NOW)])
  assert.ok(a !== null && b !== null && a.netDelta !== null && b.netDelta !== null)
  assert.ok(Math.abs(b.netDelta - a.netDelta - 1000) < 1e-9, `${a.netDelta} → ${b.netDelta}`)
  assert.ok(Math.abs(b.netDelta - after.totals.delta) < 1e-9)
  // the same band (shares only add delta, no gamma), and To Neutralize sized on the new delta in the nearest future's lots
  assert.equal(b.bandShares, a.bandShares)
  assert.deepEqual([a.toNeutralize, b.toNeutralize], [toNeutralize(before.totals.delta, 'TCS', OCT, 175), toNeutralize(after.totals.delta, 'TCS', OCT, 175)])
  assert.deepEqual([a.toNeutralize?.text, b.toNeutralize?.text], ['Buy 8 lots TCS OCT FUT', 'Buy 2 lots TCS OCT FUT'])
})

test('BookRisk: an unmatched option in an earlier month is left out; the band is the matched month\'s', async () => {
  const q = priced()
  const view = viewOf('NIFTY', [['option', NIFTY_W2, 25000, 'CE', -150], ['option', NIFTY_W1, 99999, 'CE', -75]], q)
  assert.deepEqual(view.legs.map((l) => [l.expiry, l.matched]), [[NIFTY_W1, false], [NIFTY_W2, true]])
  assert.equal(view.forwards[NIFTY_W1], undefined)   // the view prices no month for an unmatched row
  const b = await riskOver(view, q).risk.band('ravi', 'NIFTY', NOW)
  assert.notEqual(b?.state, 'unknown', b?.sentence ?? '')
  assert.equal(b?.lotSize, 75)
  assert.ok(Math.abs((b?.netDelta as number) - view.totals.delta) < 1e-9)
  const book = engineBookFor(M, q, view, 'ravi', NOW)
  assert.ok(!('blocked' in book), 'blocked' in book ? book.blocked : '')
  assert.equal(book.expiry, NIFTY_W2)
  assert.ok(book.notes.includes('1 row not understood is left out'), JSON.stringify(book.notes))
  assert.deepEqual(book.inputs.legs.map((l) => [l.strike, l.lots]), [[25000, 2]])
})

test('BookRisk: a dead feed in session is unknown; a closed market reads the last prices and says so', async () => {
  const dead = tcs(SHORT_ITM, { feedAlive: false })
  assert.equal((await riskOver(dead.view, dead.q).risk.band('ravi', 'TCS', NOW))?.sentence, 'Band unknown: the market data feed is dead')
  const closed: BookView = { ...dead.view, closed: true }
  const b = await riskOver(closed, dead.q).risk.band('ravi', 'TCS', NOW)
  assert.deepEqual([b?.state, b?.marketOpen], ['out', false])
  assert.match(b?.sentence ?? '', / \(market closed\)$/)
})

test('the stale-price lines the band reads are the ones the view writes, from one definition (R3 final fix M4)', () => {
  const q = priced()
  q.set(spotTokenOf(M, 'TCS') as number, { stale: true, asOf: NOW - 5 * 60_000 })
  q.set(M.options.future('TCS', OCT)?.instrumentToken as number, { stale: true, asOf: NOW - 3 * 60_000 })
  const v = viewOf('TCS', SHORT_ITM, q)
  assert.ok(v.warnings.includes(`${stalePricePrefix(spotPriceName('TCS'))}10:55`), v.warnings.join('\n'))
  assert.ok(v.warnings.includes(`${stalePricePrefix(futurePriceName('TCS', OCT))}10:57`), v.warnings.join('\n'))
  assert.equal(stalePricePrefix(spotPriceName('TCS')), 'TCS spot price is stale — last tick ')
})

test('BookRisk: a weekday NSE holiday with no ticks is a closed market, not a dead feed (R3 final fix I1)', async () => {
  const HOLIDAY = Date.parse('2026-10-20T11:00:00+05:30')   // Tuesday, Dussehra
  const q = priced({ feedAlive: false })
  const view = viewOf('TCS', SHORT_ITM, q, HOLIDAY)
  assert.equal(view.closed, true)
  assert.ok(!view.warnings.includes(FEED_NOT_TICKING), view.warnings.join('\n'))
  const b = await riskOver(view, q).risk.band('ravi', 'TCS', HOLIDAY)
  assert.deepEqual([b?.state, b?.marketOpen], ['out', false])
  assert.match(b?.sentence ?? '', / \(market closed\)$/)
})

test('BookRisk: on an expiry evening the band and the advice read the next expiry; the options that settled at the close are left out (R3 final fix M3)', async () => {
  const CLOSE = Date.parse('2026-10-27T15:29:00+05:30')   // the last minute of TCS OCT, quoted
  const q = fakeQuotes()
  q.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: CLOSE })
  q.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3396, bid: 3395.5, ask: 3396.5, asOf: CLOSE })
  q.set(M.options.future('TCS', NOV)?.instrumentToken as number, { price: 3420, bid: 3419.5, ask: 3420.5, asOf: CLOSE })
  priceChain(q, M, 'TCS', OCT, 3396, 0.25, CLOSE)
  priceChain(q, M, 'TCS', NOV, 3420, 0.25, CLOSE)
  const rows: readonly Row[] = [['option', OCT, 3300, 'PE', -1750], ['option', NOV, 3500, 'CE', -175]]

  // in session the book is read on OCT, today's expiry
  const before = engineBookFor(M, q, viewOf('TCS', rows, q, CLOSE), 'ravi', CLOSE)
  assert.ok(!('blocked' in before))
  assert.deepEqual([before.expiry, before.nearFuture?.expiry], [OCT, OCT])

  // 15:30 to 15:40 F&O still trades and the greeks price to 15:40 (G6): the book is still read on OCT, today's options
  // in it with their greeks; the desk's rules have stopped at 15:30, so the advice holds
  const LATE = Date.parse('2026-10-27T15:35:00+05:30')
  const ql = fakeQuotes()
  ql.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: LATE })
  ql.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3396, bid: 3395.5, ask: 3396.5, asOf: LATE })
  ql.set(M.options.future('TCS', NOV)?.instrumentToken as number, { price: 3420, bid: 3419.5, ask: 3420.5, asOf: LATE })
  priceChain(ql, M, 'TCS', OCT, 3396, 0.25, LATE)
  priceChain(ql, M, 'TCS', NOV, 3420, 0.25, LATE)
  const late = viewOf('TCS', rows, ql, LATE)
  assert.ok(!late.warnings.some((w) => w.includes('expired at today')), late.warnings.join('\n'))
  const lateBook = engineBookFor(M, ql, late, 'ravi', LATE)
  assert.ok(!('blocked' in lateBook), 'blocked' in lateBook ? lateBook.blocked : '')
  assert.deepEqual([lateBook.expiry, lateBook.nearFuture?.expiry], [OCT, OCT])
  assert.ok(!lateBook.notes.some((n) => n.includes('expired at today')), JSON.stringify(lateBook.notes))
  assert.deepEqual(lateBook.inputs.legs.map((l) => [l.strike, l.optType, l.hasGreeks]), [[3300, 'PE', true], [0, 'CE', true]])
  const lateRisk = riskOver(late, ql).risk
  const lb = await lateRisk.band('ravi', 'TCS', LATE)
  assert.notEqual(lb?.state, 'unknown', lb?.sentence ?? '')
  assert.equal(lb?.marketOpen, true)
  const la = await lateRisk.advice('ravi', 'TCS', LATE)
  assert.deepEqual([la?.status, la?.headline], ['hold', 'Advice ends at 15:30'])

  // from 15:40, the F&O close and the expiry instant the greeks price to, today's options are out
  for (const at of [Date.parse('2026-10-27T15:40:00+05:30'), Date.parse('2026-10-27T18:00:00+05:30'), Date.parse('2026-10-27T23:59:00+05:30')]) {
    const view = viewOf('TCS', rows, q, at)
    assert.ok(view.warnings.includes("3300 PE 2026-10-27: expired at today's close — left out of the greeks"), view.warnings.join('\n'))
    const book = engineBookFor(M, q, view, 'ravi', at)
    assert.ok(!('blocked' in book), 'blocked' in book ? book.blocked : '')
    assert.deepEqual([book.expiry, book.nearFuture, book.offsetShares, book.offsetUnpriced], [NOV, { expiry: NOV, lotSize: 175 }, 0, []])
    assert.deepEqual(book.inputs.legs.map((l) => [l.strike, l.optType, l.hasGreeks]), [[3500, 'CE', true]])
    assert.ok(book.notes.includes("1 option that expired at today's close is left out"), JSON.stringify(book.notes))
    const { risk } = riskOver(view, q)
    const b = await risk.band('ravi', 'TCS', at)
    assert.notEqual(b?.state, 'unknown', b?.sentence ?? '')
    assert.match(b?.sentence ?? '', / \(market closed\)$/)
    assert.ok(Math.abs((b?.netDelta as number) - view.totals.delta) < 1e-9)
    const a = await risk.advice('ravi', 'TCS', at)
    assert.deepEqual([a?.status, a?.headline], ['hold', 'Market closed'])
    assert.ok(a?.notes.includes('Advises on the 24 Nov expiry only.'), JSON.stringify(a?.notes))
  }

  // a book of today's expiry alone is read on the next listed chain, with no option left to adjust
  const alone = viewOf('TCS', [['option', OCT, 3300, 'PE', -1750]], q, Date.parse('2026-10-27T18:00:00+05:30'))
  const b = await riskOver(alone, q).risk.band('ravi', 'TCS', Date.parse('2026-10-27T18:00:00+05:30'))
  assert.deepEqual([b?.state, b?.netDelta], ['in', 0])
})

test('BookRisk: a stale spot or the month\'s stale future, in session, is unknown in the view\'s own words (R3-12)', async () => {
  const spotStale = priced()
  spotStale.set(spotTokenOf(M, 'TCS') as number, { stale: true, asOf: NOW - 5 * 60_000 })
  const v1 = viewOf('TCS', SHORT_ITM, spotStale)
  const line1 = v1.warnings.find((w) => w.startsWith('TCS spot price is stale'))
  assert.equal(line1, 'TCS spot price is stale — last tick 10:55')
  const b1 = await riskOver(v1, spotStale).risk.band('ravi', 'TCS', NOW)
  assert.deepEqual([b1?.state, b1?.sentence, b1?.netDelta], ['unknown', `Band unknown: ${line1}`, null])

  const futStale = priced()
  futStale.set(M.options.future('TCS', OCT)?.instrumentToken as number, { stale: true, asOf: NOW - 3 * 60_000 })
  const v2 = viewOf('TCS', SHORT_ITM, futStale)
  assert.equal((await riskOver(v2, futStale).risk.band('ravi', 'TCS', NOW))?.sentence, 'Band unknown: TCS FUT 2026-10-27 price is stale — last tick 10:57')
  assert.ok('blocked' in engineBookFor(M, futStale, v2, 'ravi', NOW))   // advice reads the same book: unavailable too

  // the view names no stale price with the market closed, nor with a dead feed (that is said as the dead feed)
  const after = Date.parse('2026-10-19T16:00:00+05:30')
  const v3 = viewOf('TCS', SHORT_ITM, futStale, after)
  const b3 = await riskOver(v3, futStale).risk.band('ravi', 'TCS', after)
  assert.deepEqual([b3?.state, b3?.marketOpen], ['out', false])
  const deadStale = priced({ feedAlive: false })
  deadStale.set(spotTokenOf(M, 'TCS') as number, { stale: true, asOf: NOW - 5 * 60_000 })
  const v4 = viewOf('TCS', SHORT_ITM, deadStale)
  assert.equal((await riskOver(v4, deadStale).risk.band('ravi', 'TCS', NOW))?.sentence, 'Band unknown: the market data feed is dead')
})
