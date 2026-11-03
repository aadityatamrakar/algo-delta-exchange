import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { RATES_NOT_CONFIRMED } from '../src/analytics/portfolio.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { NIFTY_W2, OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const M = r3Master()
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)   // the harness clock: Monday 09:30 IST, in session
const quotes = fakeQuotes()
quotes.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: T0 })
quotes.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: T0 })
priceChain(quotes, M, 'TCS', OCT, 3400, 0.25, T0)
quotes.set(spotTokenOf(M, 'NIFTY') as number, { price: 25000, asOf: T0 })
quotes.set(M.options.future('NIFTY', NIFTY_W2)?.instrumentToken as number, { price: 25010, bid: 25009, ask: 25011, asOf: T0 })
priceChain(quotes, M, 'NIFTY', NIFTY_W2, 25010, 0.15, T0)

const h: TradersHarness | null = await startTraders({ suite: 'portfolio', master: M, quotes })
after(async () => { await h?.close() })

type Who = (path: string, init?: RequestInit) => Promise<Response>
let ravi: Who
let sita: Who
let boss: Who
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })
const addLeg = async (who: Who, stock: string, leg: Record<string, unknown>): Promise<void> => {
  const r = await who(`/v1/traders/books/${stock}/legs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(leg) })
  assert.equal(r.status, 201, await r.text())
}

before(async () => {
  if (h === null) return
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
  ravi = h.as('ravi'); sita = h.as('sita'); boss = h.as('boss')
  // ravi: short 10 lots of the TCS 3300 CE (far past any band) and a lot of the NIFTY 25000 PE; sita: long a lot of the TCS 3400 CE
  await addLeg(ravi, 'TCS', { instrument: 'option', expiry: OCT, strike: 3300, optType: 'CE', qty: -1750, avgPrice: 120 })
  await addLeg(ravi, 'NIFTY', { instrument: 'option', expiry: NIFTY_W2, strike: 25000, optType: 'PE', qty: -75, avgPrice: 150 })
  await addLeg(sita, 'TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: 175, avgPrice: 60 })
  // ravi's NIFTY book on a band of his own, wide enough to hold it
  const band = await ravi('/v1/traders/books/NIFTY/band', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lots: 5 }) })
  assert.equal(band.status, 200, await band.text())
})

test('a trader sees only their own books', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await ravi('/v1/traders/portfolio?as=sita'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.trader, 'ravi')
  assert.equal(r.body.asOf, h.clock.now)
  assert.deepEqual(r.body.rows.map((x: any) => [x.stock, x.lotSize, x.spot]), [['NIFTY', 75, 25000], ['TCS', 175, 3395]])

  // each row is its book: the BookView's greeks, the nearest future's lots, the band the books list reads
  const tcs = r.body.rows[1]
  const view = (await json(await ravi('/v1/traders/books/TCS'))).body
  assert.deepEqual([tcs.delta, tcs.gamma, tcs.vega, tcs.theta], [view.totals.delta, view.totals.gamma, view.totals.vega, view.totals.theta])
  assert.equal(tcs.deltaLots, view.totals.delta / 175)
  assert.deepEqual([r.body.rows[0].band, r.body.rows[0].bandSentence], ['in', 'In band (±5 lots)'])
  assert.equal(tcs.band, 'out')
  assert.match(tcs.bandSentence, /^Out of band by \d+ lots — To neutralize: Buy \d+ lots TCS OCT FUT$/)
  assert.deepEqual(tcs.months.map((m: any) => [m.expiry, m.delta]), [[OCT, view.totals.delta]])
  // P&L is the BookView's series net (the one cached series reader): the same figure on the book and the Portfolio
  assert.equal(typeof tcs.pnl, 'number')
  assert.deepEqual([tcs.pnl, tcs.pnlReason, tcs.months[0].pnl], [view.seriesTotal.net, null, view.series[0].net])
  assert.equal(r.body.totals.pnl, r.body.rows[0].pnl + tcs.pnl)

  // no NSE file in this suite: no margin, and no Day MTM (yesterday's close unknown) — the Open P&L is its own figure, not a stand-in
  assert.deepEqual([tcs.margin, tcs.marginLabel, tcs.mtmDay, tcs.mtmDayReason, tcs.openPnl], [null, null, null, null, view.totals.mtm])
  assert.deepEqual(r.body.totals.marginMissing, ['NIFTY', 'TCS'])
  assert.deepEqual([r.body.totals.books, r.body.totals.outOfBand], [2, 1])
  assert.equal(r.body.totals.deltaValue, r.body.rows[0].delta * 25000 + tcs.delta * 3395)
  for (const w of [
    "TCS: Today is not shown — yesterday's close is unknown",
    "NIFTY: Today is not shown — yesterday's close is unknown",
    RATES_NOT_CONFIRMED,
  ]) assert.ok(r.body.warnings.includes(w), w)
  assert.equal(JSON.stringify(r.body).includes('sita'), false)

  const s = await json(await sita('/v1/traders/portfolio'))
  assert.deepEqual([s.body.trader, s.body.rows.map((x: any) => x.stock)], ['sita', ['TCS']])
  assert.equal(s.body.rows[0].delta, (await json(await sita('/v1/traders/books/TCS'))).body.totals.delta)
})

test("admin ?as= sees that trader's", async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await boss('/v1/traders/portfolio?as=sita'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.trader, r.body.rows.map((x: any) => x.stock)], ['sita', ['TCS']])
  assert.deepEqual(r.body, (await json(await sita('/v1/traders/portfolio'))).body)
  assert.equal((await boss('/v1/traders/portfolio')).status, 400)   // an admin must name a trader
  assert.equal((await boss('/v1/traders/portfolio?as=boss')).status, 404)
})

test('GET /admin/portfolio as a trader → 403', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const who of [ravi, sita]) {
    const r = await json(await who('/v1/traders/admin/portfolio'))
    assert.equal(r.status, 403, JSON.stringify(r.body))
    assert.equal(JSON.stringify(r.body).includes('TCS'), false)
  }
})

test('as admin → every trader', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await boss('/v1/traders/admin/portfolio'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const mine = (await json(await ravi('/v1/traders/portfolio'))).body
  const hers = (await json(await sita('/v1/traders/portfolio'))).body
  assert.equal(r.body.asOf, h.clock.now)
  assert.deepEqual(r.body.traders, [{ trader: 'ravi', totals: mine.totals }, { trader: 'sita', totals: hers.totals }])

  const tcs = mine.rows[1].delta + hers.rows[0].delta
  assert.deepEqual(r.body.stocks.map((s: any) => [s.stock, s.traders]), [['NIFTY', 1], ['TCS', 2]])
  const across = r.body.stocks[1]
  assert.deepEqual([across.delta, across.deltaLots, across.margin], [tcs, tcs / 175, 0])
  assert.deepEqual([across.vega, across.mtmDay, across.openPnl], [mine.rows[1].vega + hers.rows[0].vega, null, mine.rows[1].openPnl + hers.rows[0].openPnl])
  assert.ok(r.body.warnings.includes('TCS: margin leaves out ravi, sita (not available)'), JSON.stringify(r.body.warnings))
  assert.ok(r.body.warnings.includes(`sita: ${RATES_NOT_CONFIRMED}`))
})
