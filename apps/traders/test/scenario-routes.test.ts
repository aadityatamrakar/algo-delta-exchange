import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { TRADERS_COLLECTIONS } from '../src/db.ts'
import { L1, R2_NOW, R2_OCT, TM, r2Legs, r2Quotes, shareLeg } from './fixtures/r2-book.ts'
import { startTraders, type TradersHarness } from './harness.ts'

// The whole app (createApp binds scenarioOf), the pinned TCS book of Release 2 for asha and one
// BSTOCK share leg for bala. The clock stays at R2_NOW, so every request reads the same snapshot.
const h: TradersHarness | null = await startTraders({ suite: 'scenario', master: TM, quotes: r2Quotes(), now: () => R2_NOW })
after(async () => { await h?.close() })

const P = '/v1/traders/books/TCS/scenario'
const HYP = { id: 'h1', instrument: 'option', expiry: R2_OCT, strike: 3100, optType: 'PE', qty: -175, price: null, iv: null }
let asha: (path: string, init?: RequestInit) => Promise<Response>
let boss: (path: string, init?: RequestInit) => Promise<Response>
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })
const post = (who: typeof asha, path: string, body: unknown): Promise<Response> =>
  who(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

before(async () => {
  if (h === null) return
  await h.addUser('asha'); await h.addUser('bala'); await h.addUser('boss', 'admin')
  asha = h.as('asha'); boss = h.as('boss')
  await h.handle.db.collection('traders-legs').insertMany([
    ...r2Legs().map((l) => ({ ...l })),
    { ...shareLeg(10, 'manual:b1'), trader: 'bala', stock: 'BSTOCK' },
  ])
})

test('POST scenario {}: 200 with the ScenarioView of the book', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await post(asha, P, {}))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.stock, 'TCS')
  assert.equal(r.body.legs.length, 5)
  assert.deepEqual(r.body.grid.labels, ['19 Oct', '21 Oct', '22 Oct', '23 Oct', '26 Oct', '27 Oct', 'Expiry'])
  assert.deepEqual([r.body.resolved.spot, r.body.resolved.middle, r.body.grid.spots.length, r.body.grid.currentRow], [3000, 3000, 101, 50])
  assert.deepEqual(r.body.totals, r.body.grid.cells[50][0])
  // no NSE file in the harness: yesterday's close is unknown, so the grid is on net price
  assert.equal(r.body.baseNote, 'Grid, chart and table: P&L against net price — yesterday\'s close is unknown (see the MTM block)')
  assert.equal(r.body.chart.points.length, 121)
  // an empty body is {}
  const empty = await json(await asha(P, { method: 'POST' }))
  assert.deepEqual(empty, r)
})

test('a hypothetical is priced in and never stored', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const all = async () => Promise.all([...TRADERS_COLLECTIONS, 'instrument', 'desk-marks'].map(async (n) =>
    [n, JSON.stringify(await h.handle.db.collection(n).find({}).toArray())]))
  const legCount = async () => ((await json(await asha('/v1/traders/books'))).body as { stock: string; legCount: number }[]).find((b) => b.stock === 'TCS')?.legCount
  const viewLegs = async () => (await json(await asha('/v1/traders/books/TCS'))).body.legs.length
  await post(asha, P, {})   // signed in, and every first-read seed done
  const [stored, count, inView, before] = [await h.handle.db.collection('traders-legs').countDocuments({}), await legCount(), await viewLegs(), await all()]

  const r = await json(await post(asha, P, { hypothetical: [HYP, { ...HYP, id: 'h2', strike: 3050, optType: 'CE' }] }))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.hypothetical.map((x: { id: string; accepted: boolean; reason: string | null; entry: number | null }) => [x.id, x.accepted, x.reason, x.entry]),
    [['h1', true, null, 120], ['h2', false, 'TCS 2026-10-27 3050 CE is not listed', null]])
  assert.deepEqual(r.body.legs.map((l: { id: string; hypothetical: boolean }) => [l.id, l.hypothetical]).slice(-2), [[r2Legs()[4]!.key, false], ['h1', true]])

  assert.equal(await h.handle.db.collection('traders-legs').countDocuments({}), stored)
  assert.deepEqual([await legCount(), await viewLegs()], [count, inView])
  assert.deepEqual(await all(), before)
})

test('a stock with no open book is 404; another trader’s stock is 404; a bad stock is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const none = await json(await post(asha, '/v1/traders/books/ZZZ/scenario', {}))
  assert.deepEqual([none.status, none.body], [404, { error: 'no open book ZZZ' }])
  const theirs = await json(await post(asha, '/v1/traders/books/BSTOCK/scenario', {}))
  assert.deepEqual([theirs.status, theirs.body], [404, { error: 'no open book BSTOCK' }])
  assert.equal((await post(asha, '/v1/traders/books/b!d/scenario', {})).status, 400)
  assert.equal((await post(asha, '/v1/traders/books/tcs/scenario', {})).status, 200)   // upper-cased, as books.view does
})

test('a book with no listed expiry is 409', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await post(boss, '/v1/traders/books/BSTOCK/scenario?as=bala', {}))
  assert.deepEqual([r.status, r.body], [409, { error: 'BSTOCK has no listed expiry' }])
})

test('a bad body is 400 and names the field', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const cases: [unknown, RegExp][] = [
    [{ volShift: 60 }, /^volShift/],                                   // the parser
    [{ hypothetical: Array(21).fill(HYP) }, /^hypothetical/],
    [{ count: 101 }, /^count/],                                         // the grid's axes
    [{ targetDate: '2026-12-01' }, /^targetDate/],                     // after the last held expiry
    [[1, 2], /^the body/],
    ['{not json', /^body is not valid JSON/],
  ]
  for (const [body, re] of cases) {
    const r = await json(await post(asha, P, body))
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.match(r.body.error, re)
  }
})

test('a body over 64 KB is 413', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const big = JSON.stringify({ exclude: [L1], pad: 'x'.repeat(65 * 1024) })
  assert.equal((await post(asha, P, big)).status, 413)
})

test('an admin with ?as=asha reads exactly what asha reads; no session is 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const body = { volShift: 1, hypothetical: [HYP] }
  const mine = await json(await post(asha, P, body))
  const admin = await json(await post(boss, `${P}?as=asha`, body))
  assert.equal(admin.status, 200)
  assert.deepEqual(admin.body, mine.body)
  assert.equal((await post(boss, P, {})).status, 400)   // an admin must name a trader
  assert.equal((await fetch(h.url + P, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
})
