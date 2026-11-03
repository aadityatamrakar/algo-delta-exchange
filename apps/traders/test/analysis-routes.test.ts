import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { TRADERS_COLLECTIONS } from '../src/db.ts'
import { L1, R2_NOW, TM, r2Legs, r2Quotes, shareLeg } from './fixtures/r2-book.ts'
import { startTraders, type TradersHarness } from './harness.ts'

// The whole app (createApp binds analysisOf), the pinned TCS book of Release 2 for asha and one
// BSTOCK share leg for bala. The clock stays at R2_NOW, so every request reads the same snapshot.
const h: TradersHarness | null = await startTraders({ suite: 'analysis', master: TM, quotes: r2Quotes(), now: () => R2_NOW })
after(async () => { await h?.close() })

const A = '/v1/traders/books/TCS/analysis'
let asha: (path: string, init?: RequestInit) => Promise<Response>
let boss: (path: string, init?: RequestInit) => Promise<Response>
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })

before(async () => {
  if (h === null) return
  await h.addUser('asha'); await h.addUser('bala'); await h.addUser('boss', 'admin')
  asha = h.as('asha'); boss = h.as('boss')
  await h.handle.db.collection('traders-legs').insertMany([
    ...r2Legs().map((l) => ({ ...l })),
    { ...shareLeg(10, 'manual:b1'), trader: 'bala', stock: 'BSTOCK' },
  ])
})

test('GET analysis: 200 with the AnalysisView of the book', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await asha(A))
  assert.equal(r.status, 200)
  assert.equal(r.body.stock, 'TCS')
  assert.equal(r.body.legs.length, 5)
  assert.equal(r.body.unmatched.length, 1)
  assert.equal(r.body.legs.find((l: { key: string }) => l.key === L1).timeValue, 8750)
  assert.equal(typeof r.body.mtm.gross.today, 'number')
  assert.equal(r.body.gapPanel.on, '2026-10-21')   // the next open after Mon 19 Oct: Tue 20 Oct is Dussehra
})

test('the query reaches the view: a typed IV and an unticked leg', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await asha(`${A}?exclude=${encodeURIComponent(L1)}&iv=${encodeURIComponent(`${L1}@0.3`)}&callVol=1`))
  assert.equal(r.status, 200)
  const l1 = r.body.legs.find((l: { key: string }) => l.key === L1)
  assert.deepEqual([l1.included, l1.ivSource, l1.ivUsed, r.body.params.callVol], [false, 'override', 0.31, 1])
})

test('a stock with no open book is 404; another trader’s stock is 404; a bad stock is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const none = await json(await asha('/v1/traders/books/ZZZ/analysis'))
  assert.deepEqual([none.status, none.body], [404, { error: 'no open book ZZZ' }])
  const theirs = await json(await asha('/v1/traders/books/BSTOCK/analysis'))
  assert.deepEqual([theirs.status, theirs.body], [404, { error: 'no open book BSTOCK' }])
  assert.equal((await asha('/v1/traders/books/b!d/analysis')).status, 400)
  // the stock is upper-cased, as books.view does
  assert.equal((await asha('/v1/traders/books/tcs/analysis')).status, 200)
})

test('an admin with ?as=asha reads exactly what asha reads', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const mine = await json(await asha(A))
  const admin = await json(await boss(`${A}?as=asha`))
  assert.equal(admin.status, 200)
  assert.deepEqual(admin.body, mine.body)
  assert.equal((await boss(A)).status, 400)   // an admin must name a trader
})

test('a bad query is 400 and names the parameter', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await asha(`${A}?callVol=x`))
  assert.equal(r.status, 400)
  assert.match(r.body.error, /^callVol/)
  assert.equal((await asha(`${A}?gap=5,0`)).status, 400)
})

test('no session is 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await fetch(h.url + A)).status, 401)
})

test('reading the analysis writes nothing', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const all = async () => Promise.all([...TRADERS_COLLECTIONS, 'instrument', 'desk-marks'].map(async (n) =>
    [n, JSON.stringify(await h.handle.db.collection(n).find({}).toArray())]))
  await asha(A)   // signed in, and every first-read seed done
  const before = await all()
  await asha(`${A}?callVol=2&basis=cash&gapLtp=0&illiquid=${encodeURIComponent(L1)}`)
  assert.deepEqual(await all(), before)
})
