import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { L1, L2, L3, L5, R2_NOW, TM, r2Legs, r2Quotes } from './fixtures/r2-book.ts'
import { startTraders, type TradersHarness } from './harness.ts'
import type { BookView } from '../src/types.ts'

const h: TradersHarness | null = await startTraders({ suite: 'groups', master: TM, quotes: r2Quotes(), now: () => R2_NOW })
after(async () => { await h?.close() })

const G = '/v1/traders/books/TCS/groups'
let asha: (path: string, init?: RequestInit) => Promise<Response>
let boss: (path: string, init?: RequestInit) => Promise<Response>
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })
const put = (who: typeof asha, path: string, body: unknown) =>
  who(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

before(async () => {
  if (h === null) return
  await h.addUser('asha'); await h.addUser('bala'); await h.addUser('boss', 'admin')
  asha = h.as('asha'); boss = h.as('boss')
  await h.handle.db.collection('traders-legs').insertMany(r2Legs().map((l) => ({ ...l })))
})

test('PUT then GET round-trips, and untagged legs are ungrouped', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const open = (await json(await asha('/v1/traders/books/TCS'))).body.legs.length
  const body = { groups: [{ name: 'Oct straddle', keys: [L1, L3] }, { name: 'hedge', keys: [L2] }] }
  const p = await json(await put(asha, G, body))
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const g = await json(await asha(G))
  assert.deepEqual(g.body, p.body)
  assert.deepEqual(g.body.groups.map((x: any) => [x.name, x.legCount]), [['Oct straddle', 2], ['hedge', 1]])
  assert.equal(g.body.ungrouped.legCount, open - 3)
  assert.equal(g.body.groups[0].totals.delta + g.body.groups[1].totals.delta + g.body.ungrouped.totals.delta,
    (await json(await asha('/v1/traders/books/TCS'))).body.totals.delta)
})

test('each group carries its own payoff', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const g = (await json(await asha(G))).body
  assert.notEqual(g.groups[0].payoff, null)
  assert.notEqual(g.groups[1].payoff, null)
  assert.notDeepEqual(g.groups[0].payoff, g.groups[1].payoff)
})

test('a closed leg’s key is dropped on read', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await put(asha, G, { groups: [{ name: 'mix', keys: [L1, L5] }] })).status, 200)
  assert.deepEqual((await json(await asha(G))).body.groups[0].keys.sort(), [L1, L5].sort())
  assert.equal((await asha(`/v1/traders/legs/${encodeURIComponent(L5)}`, { method: 'DELETE' })).status, 200)
  const g = (await json(await asha(G))).body
  assert.deepEqual(g.groups[0].keys, [L1])
  assert.equal(g.groups[0].legCount, 1)
})

test('refusals are 400 with the text; an unknown book is 404; a bad stock is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await put(asha, G, { groups: [{ name: 'x', keys: ['nope'] }] }))
  assert.deepEqual([r.status, r.body], [400, { error: 'unknown leg keys: nope' }])
  assert.equal((await put(asha, G, {})).status, 400)
  assert.deepEqual((await json(await asha('/v1/traders/books/ZZZ/groups'))).body, { error: 'no open book ZZZ' })
  assert.equal((await put(asha, '/v1/traders/books/ZZZ/groups', { groups: [] })).status, 404)
  assert.equal((await asha('/v1/traders/books/b!d/groups')).status, 400)
  assert.equal((await fetch(h.url + G)).status, 401)
})

test('admin acts with ?as=', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await boss(G)).status, 400)
  const p = await put(boss, `${G}?as=asha`, { groups: [{ name: 'by admin', keys: [L2] }] })
  assert.equal(p.status, 200)
  const stored = await h.handle.db.collection('traders-groups').find({}).toArray()
  assert.deepEqual(stored.map((d) => [d['trader'], (d['groups'] as { name: string }[])[0]?.name]), [['asha', 'by admin']])
  assert.equal((await json(await asha(G))).body.groups[0].name, 'by admin')
})

test('a book that closes between the write and the read back is 404, never 200 with no body (R3 final fix T6)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  // the PUT reads the book to check the keys, writes, then reads it again for the answer: here the last leg went in between
  let reads = 0
  const open = { stock: 'TCS', asOf: R2_NOW, legs: [{ key: 'k1' }] } as unknown as BookView
  const c = await startTraders({ suite: 'groups_race', master: TM, quotes: r2Quotes(), now: () => R2_NOW, deps: { bookView: async () => (reads++ === 0 ? open : null) } })
  assert.ok(c)
  try {
    await c.addUser('asha')
    const r = await json(await put(c.as('asha'), G, { groups: [{ name: 'x', keys: ['k1'] }] }))
    assert.deepEqual([r.status, r.body], [404, { error: 'no open book TCS' }])
    assert.equal(reads, 2)
  } finally {
    await c.close()
  }
})
