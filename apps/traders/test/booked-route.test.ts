/** GET /booked and /admin/booked through the whole app: a trader's series of every stock, priced off the book views. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { matchLeg } from '../src/market/master.ts'
import type { TraderTrade } from '../src/types.ts'
import { fakeQuotes } from './fixtures/r3-market.ts'
import { OCT, TCS_OCT_FUT, TCS_SPOT, octCE, testMaster } from './fixtures/master.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const M = testMaster()
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)   // the harness clock: Monday 19 Oct 09:30 IST
const quotes = fakeQuotes()
quotes.set(TCS_SPOT, { price: 3490, asOf: T0 })
quotes.set(TCS_OCT_FUT, { price: 3500, asOf: T0 })
quotes.set(octCE(3500), { price: 45, asOf: T0 })

const h: TradersHarness | null = await startTraders({ suite: 'booked', master: M, quotes })
after(async () => { await h?.close() })

type Who = (path: string, init?: RequestInit) => Promise<Response>
let ravi: Who
let sita: Who
let boss: Who
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })

let n = 0
const trade = (trader: string, side: 'Buy' | 'Sell', qty: number, price: number, day: string, o: Partial<TraderTrade> = {}): TraderTrade => {
  n++
  return {
    trader, tradeNo: String(n), orderNo: `o${n}`, clientCode: 'c0001', stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE',
    side, qty, price, time: Date.parse(`${day}T10:00:00+05:30`), day, seq: n, ...o,
  }
}

before(async () => {
  if (h === null) return
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
  ravi = h.as('ravi'); sita = h.as('sita'); boss = h.as('boss')
  const docs = [
    // TCS Oct: the 3400 PE sold and bought back (+1,400), the 3500 CE still short 175 at 40
    trade('ravi', 'Sell', 175, 30, '2026-10-14', { strike: 3400, optType: 'PE' }), trade('ravi', 'Buy', 175, 22, '2026-10-15', { strike: 3400, optType: 'PE' }),
    trade('ravi', 'Sell', 175, 40, '2026-10-16'),
    // TCS Sep, expired and closed (+4,900); INFY, a stock with no tab, closed (−500)
    trade('ravi', 'Sell', 175, 30, '2026-09-20', { expiry: '2026-09-29' }), trade('ravi', 'Buy', 175, 2, '2026-09-25', { expiry: '2026-09-29' }),
    trade('ravi', 'Sell', 100, 10, '2026-10-05', { stock: 'INFY', strike: 1500 }), trade('ravi', 'Buy', 100, 15, '2026-10-06', { stock: 'INFY', strike: 1500 }),
    // sita: one closed July series, out of the default range
    trade('sita', 'Sell', 50, 10, '2026-07-10', { expiry: '2026-07-28' }), trade('sita', 'Buy', 50, 4, '2026-07-11', { expiry: '2026-07-28' }),
  ]
  for (const doc of docs) await h.db.collection<TraderTrade>('traders-trades').insertOne(doc)
  for (const who of ['ravi', 'sita']) {
    await h.deps.ledger.noteHistory(who, who === 'ravi' ? '2026-09-20' : '2026-07-10')
    await h.deps.legs.replaceOdin(who, await h.deps.ledger.odinLegs(who), (c) => matchLeg(M, c))
  }
})

test('a trader\'s booked series of every stock; an open one is priced off its book, so its net is the Series P&L block\'s', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await ravi('/v1/traders/booked?trader=sita&as=sita'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.trader, r.body.from, r.body.to, r.body.asOf, r.body.historyStart], ['ravi', '2026-08', '2026-10', h.clock.now, '2026-09-20'])
  assert.deepEqual(r.body.rows.map((x: any) => [x.month, x.stock, x.expiry, x.status, x.booked]), [
    ['2026-10', 'INFY', OCT, 'closed', -500], ['2026-10', 'TCS', OCT, 'open', 1400], ['2026-09', 'TCS', '2026-09-29', 'closed', 4900],
  ])
  const book = (await json(await ravi('/v1/traders/books/TCS'))).body
  const series = book.series[0]
  const oct = r.body.rows[1]
  assert.deepEqual([oct.openMtm, oct.booked, oct.closedCycles, oct.openContracts], [(45 - 40) * -175, series.booked, series.closedContracts, 1])
  assert.equal(oct.openMtm, series.open)
  assert.ok(Math.abs(oct.charges - series.charges) < 1e-9 && oct.charges > 0)
  assert.ok(Math.abs(oct.net - series.net) < 1e-9, `${oct.net} vs ${series.net}`)
  assert.ok(r.body.notes.includes('Figures count from 20 Sep 2026: the trade history the app holds starts there, and nothing before it is in them.'), JSON.stringify(r.body.notes))
  assert.equal(r.body.ratesConfirmed, false)
  assert.equal(JSON.stringify(r.body).includes('sita'), false)
  assert.equal(JSON.stringify(r.body).includes('c0001') || JSON.stringify(r.body).includes('C0001'), false)
})

test('a range of months, each trader\'s own; a bad month is refused', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const sep = (await json(await ravi('/v1/traders/booked?from=2026-09&to=2026-09'))).body
  assert.deepEqual(sep.rows.map((x: any) => [x.stock, x.expiry, x.net]), [['TCS', '2026-09-29', sep.rows[0].booked - sep.rows[0].charges]])
  assert.deepEqual(sep.months, ['2026-10', '2026-09'])
  const mine = (await json(await sita('/v1/traders/booked?from=2026-07&to=2026-07'))).body
  assert.deepEqual(mine.rows.map((x: any) => [x.stock, x.booked]), [['TCS', 300]])
  for (const q of ['from=2026-13', 'to=2026-9', 'from=2026-10&to=2026-08']) {
    const bad = await json(await ravi(`/v1/traders/booked?${q}`))
    assert.equal(bad.status, 400, q)
  }
})

test('an admin names the trader; the roll-up is every trader\'s months and the desk\'s', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const own = (await json(await ravi('/v1/traders/booked'))).body
  assert.deepEqual((await json(await boss('/v1/traders/booked?trader=ravi'))).body, own)
  assert.deepEqual((await json(await boss('/v1/traders/booked?as=ravi'))).body, own)
  assert.equal((await boss('/v1/traders/booked')).status, 400)
  assert.equal((await ravi('/v1/traders/admin/booked')).status, 403)

  const all = (await json(await boss('/v1/traders/admin/booked?from=2026-07&to=2026-10'))).body
  assert.deepEqual([all.from, all.to], ['2026-07', '2026-10'])
  assert.deepEqual(all.traders.map((x: any) => [x.trader, x.total.booked, x.byMonth.map((m: any) => m.month)]), [
    ['ravi', 1400 - 500 + 4900, ['2026-10', '2026-09']], ['sita', 300, ['2026-07']],
  ])
  assert.deepEqual(all.byMonth.map((m: any) => [m.month, m.booked]), [['2026-10', 900], ['2026-09', 4900], ['2026-07', 300]])
  assert.equal(all.total.booked, 1400 - 500 + 4900 + 300)
  assert.ok(Math.abs(all.total.net - (all.traders[0].total.net + all.traders[1].total.net)) < 1e-9)
})

test('the walk is kept per leg version: a trade file (which writes the legs) shows at once, a stray read never re-walks', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const before = (await json(await ravi('/v1/traders/booked'))).body
  // trades stored with no leg write (only ingest stores trades, and it then writes the legs): the kept walk stands
  await h.db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 'Sell', 10, 50, '2026-10-16', { stock: 'WIPRO', strike: 250 }))
  await h.db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 'Buy', 10, 20, '2026-10-17', { stock: 'WIPRO', strike: 250 }))
  h.clock.now += 4 * 60_000
  assert.deepEqual((await json(await ravi('/v1/traders/booked'))).body.rows.map((x: any) => x.stock), before.rows.map((x: any) => x.stock))
  // the leg write, as applying the file does: the new version is walked at once
  await h.deps.legs.replaceOdin('ravi', await h.deps.ledger.odinLegs('ravi'), (c) => matchLeg(M, c))
  const after = (await json(await ravi('/v1/traders/booked'))).body
  assert.equal(after.rows.find((x: any) => x.stock === 'WIPRO')?.booked, 300)
  h.clock.now = T0
})
