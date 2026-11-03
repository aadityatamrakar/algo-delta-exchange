import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const M = r3Master()
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)   // the harness clock: Monday 09:30 IST, in session
const quotes = fakeQuotes()
quotes.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: T0 })
quotes.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: T0 })
priceChain(quotes, M, 'TCS', OCT, 3400, 0.25, T0)

const h: TradersHarness | null = await startTraders({ suite: 'band', master: M, quotes })
after(async () => { await h?.close() })

const BAND = '/v1/traders/books/TCS/band'
let ravi: (path: string, init?: RequestInit) => Promise<Response>
let boss: (path: string, init?: RequestInit) => Promise<Response>
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })
const put = (who: typeof ravi, path: string, body: unknown) =>
  who(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const bandDocs = async (trader: string) => (await h?.db.collection('traders-settings').find({ kind: 'band', trader }, { projection: { _id: 0, updatedAt: 0 } }).toArray()) ?? []

before(async () => {
  if (h === null) return
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
  ravi = h.as('ravi'); boss = h.as('boss')
  // short 10 lots of the 3300 CE, a hundred points in the money: far past any band of 2 lots
  const r = await ravi('/v1/traders/books/TCS/legs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instrument: 'option', expiry: OCT, strike: 3300, optType: 'CE', qty: -1750, avgPrice: 120 }),
  })
  assert.equal(r.status, 201, await r.text())
})

test("PUT { lots: 2 } then GET /books shows the row's band", async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const p = await json(await put(ravi, BAND, { lots: 2 }))
  assert.equal(p.status, 200, JSON.stringify(p.body))
  assert.deepEqual([p.body.source, p.body.bandLots, p.body.bandShares, p.body.lotSize, p.body.state, p.body.marketOpen], ['override', 2, 350, 175, 'out', true])
  assert.match(p.body.sentence, /^Out of band by \d+ lots — To neutralize: Buy \d+ lots TCS OCT FUT$/)
  assert.ok(p.body.netDelta < -350)
  assert.deepEqual(await bandDocs('ravi'), [{ kind: 'band', trader: 'ravi', bands: { TCS: 2 } }])

  // the books list reads the board, which has not ticked yet
  assert.deepEqual((await json(await ravi('/v1/traders/books'))).body.map((b: any) => b.band), [null])
  assert.equal(await h.app.board.tick(h.clock.now), 1)
  assert.deepEqual((await json(await ravi('/v1/traders/books'))).body, [{ stock: 'TCS', legCount: 1, mismatch: null, lastFileAt: null, band: 'out' }])
  const events = await h.db.collection('traders-events').find({ trader: 'ravi' }, { projection: { _id: 0 } }).toArray()
  assert.deepEqual(events.map((e: any) => [e.stock, e.kind, e.from, e.to, e.source, e.bandShares, e.at]), [['TCS', 'band', 'in', 'out', 'override', 350, h.clock.now]])
  assert.equal(await h.app.board.tick(h.clock.now + 60_000), 0)   // still out: nothing new
})

test('PUT { lots: null } clears', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await put(ravi, BAND, { lots: 2 })).status, 200)
  const p = await json(await put(ravi, BAND, { lots: null }))
  assert.equal(p.status, 200, JSON.stringify(p.body))
  assert.equal(p.body.source, 'engine')
  assert.notEqual(p.body.bandLots, 2)
  assert.deepEqual(await bandDocs('ravi'), [{ kind: 'band', trader: 'ravi', bands: {} }])
})

test("lots 0, -1, 1001, 'x' → 400", async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await put(ravi, BAND, { lots: 4 })).status, 200)
  for (const body of [{ lots: 0 }, { lots: -1 }, { lots: 1001 }, { lots: 'x' }, { lots: 0.04 }, { lots: true }, {}, { lot: 2 }]) {
    const r = await json(await put(ravi, BAND, body))
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(typeof r.body.error, 'string')
  }
  assert.deepEqual(await bandDocs('ravi'), [{ kind: 'band', trader: 'ravi', bands: { TCS: 4 } }])
  // 1000 is allowed, and a value is kept to one decimal
  assert.equal((await json(await put(ravi, BAND, { lots: 1000 }))).body.bandLots, 1000)
  assert.equal((await json(await put(ravi, BAND, { lots: 2.345 }))).body.bandLots, 2.3)
  assert.deepEqual(await bandDocs('ravi'), [{ kind: 'band', trader: 'ravi', bands: { TCS: 2.3 } }])
})

test("admin with ?as= sets the trader's override", async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const p = await json(await put(boss, `${BAND}?as=ravi`, { lots: 3 }))
  assert.equal(p.status, 200, JSON.stringify(p.body))
  assert.deepEqual([p.body.source, p.body.bandLots], ['override', 3])
  assert.deepEqual(await bandDocs('ravi'), [{ kind: 'band', trader: 'ravi', bands: { TCS: 3 } }])
  assert.deepEqual(await bandDocs('boss'), [])
  assert.equal((await put(boss, BAND, { lots: 3 })).status, 400)   // an admin must name a trader
})

test('a book the trader does not hold is 404 and writes nothing', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const sita = h.as('sita')
  const r = await json(await put(sita, BAND, { lots: 2 }))
  assert.deepEqual([r.status, r.body], [404, { error: 'no open book TCS' }])
  assert.deepEqual(await bandDocs('sita'), [])
  assert.equal((await put(ravi, '/v1/traders/books/a.b/band', { lots: 2 })).status, 400)
})
