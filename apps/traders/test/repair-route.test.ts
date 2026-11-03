import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { RepairPool, workerRunner } from '../src/analytics/repair-pool.ts'
import { REALISED_NOT_COUNTED } from '../src/analytics/repair.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { legKey, type Instrument, type OptType, type TraderLeg } from '../src/types.ts'
import { NOV, OCT } from './fixtures/r3-market.ts'
import { REPAIR_NOW, repairMarket } from './fixtures/repair-book.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const { m, q } = repairMarket()
q.set(spotTokenOf(m, 'TCS') as number, { price: 3410, asOf: REPAIR_NOW, ageMs: 0 })
const clock = { now: REPAIR_NOW }
// The real worker, behind a gate a test can close to hold one search in flight, or set to fail the search.
const runner = workerRunner(1)
let gate: Promise<void> = Promise.resolve()
let fail: Error | null = null
const pool = new RepairPool({
  run: async (job) => {
    await gate
    if (fail !== null) throw fail
    return await runner.run(job)
  },
  now: () => clock.now,
})
const h: TradersHarness | null = await startTraders({ suite: 'repair', master: m, quotes: q, now: () => clock.now, deps: { repair: pool } })
after(async () => {
  await h?.close()
  await runner.close()
})

type Who = (path: string, init?: RequestInit) => Promise<Response>
let ravi: Who
let boss: Who
const json = async (r: Response): Promise<{ status: number; body: any; headers: Headers }> => ({ status: r.status, body: await r.json(), headers: r.headers })
const post = async (who: Who, path: string, body: unknown) =>
  await json(await who(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const REPAIR = '/v1/traders/books/TCS/repair'
const GOALS = ['REDUCE-LOSS', 'PROFITABLE-BY-EXPIRY', 'CHEAP-TAIL-CAP', 'MAX-CREDIT-SAFE']

function traderLeg(stock: string, instrument: Instrument, expiry: string, strike: number | null, optType: OptType | null, qty: number, avgPrice: number): TraderLeg {
  const contract = { clientCode: 'C1', instrument, stock, expiry, strike, optType }
  return { trader: 'ravi', ...contract, qty, avgPrice, source: 'odin', key: legKey(contract), token: null, note: '', updatedAt: REPAIR_NOW }
}

before(async () => {
  if (h === null) return
  await h.addUser('ravi'); await h.addUser('boss', 'admin')
  ravi = h.as('ravi'); boss = h.as('boss')
  await h.handle.db.collection('traders-legs').insertMany([
    traderLeg('TCS', 'option', OCT, 3400, 'CE', -350, 80),
    traderLeg('TCS', 'option', OCT, 3300, 'PE', 175, 10),
    traderLeg('TCS', 'option', NOV, 3500, 'CE', 175, 40),
    traderLeg('TCS', 'share', '', null, null, 1000, 3300),
    traderLeg('M&M', 'share', '', null, null, 700, 3100),
  ].map((l) => ({ ...l })))
})

let first: any

test('POST returns four goals and a whatIf per plan', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await post(ravi, REPAIR, {})
  assert.equal(r.status, 200, JSON.stringify(r.body))
  first = r.body
  assert.deepEqual([r.body.stock, r.body.expiry, r.body.cached, r.body.computedAt, r.body.asOf, r.body.error], ['TCS', OCT, false, REPAIR_NOW, REPAIR_NOW, null])
  assert.deepEqual(r.body.goals.map((g: any) => g.goal), GOALS)
  const all = r.body.goals.flatMap((g: any) => g.plans)
  assert.ok(all.some((p: any) => p.moves.length > 0), 'the search proposed something')
  for (const p of all) {
    assert.equal(p.lines.length, p.moves.length)
    assert.ok(Array.isArray(p.whatIf))
    if (p.moves.length > 0) assert.ok(p.whatIf.length > 0, JSON.stringify(p))
    for (const w of p.whatIf) assert.deepEqual(Object.keys(w).sort(), ['expiry', 'instrument', 'optType', 'price', 'qty', 'strike'])
  }
  for (const g of r.body.goals) assert.ok(g.plans.some((p: any) => p.flags.includes('baseline')), g.goal)
  // the November call and the shares are the offset: their delta, in shares
  const book = (await json(await ravi('/v1/traders/books/TCS'))).body
  const outside = book.legs.filter((l: any) => l.expiry !== OCT).reduce((s: number, l: any) => s + l.delta, 0)
  assert.equal(r.body.offset.shares, Math.round(outside))
  assert.ok(r.body.warnings.includes(REALISED_NOT_COUNTED))
  assert.equal(JSON.stringify(r.body).includes('"place'), false)
})

test('a second POST inside 60 s is cached, for every viewer of the book', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  clock.now = REPAIR_NOW + 30_000
  const r = await post(ravi, REPAIR, {})
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.cached, r.body.computedAt, r.body.asOf], [true, REPAIR_NOW, REPAIR_NOW + 30_000])
  assert.deepEqual(r.body.goals, first.goals)
  const admin = await post(boss, `${REPAIR}?as=ravi`, {})
  assert.deepEqual([admin.status, admin.body.cached, admin.body.computedAt], [200, true, REPAIR_NOW])
  assert.equal((await post(boss, REPAIR, {})).status, 400, 'an admin names the trader')
})

test('a leg write changes the key and recomputes', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const add = await post(ravi, '/v1/traders/books/TCS/legs', { instrument: 'share', qty: 10, avgPrice: 3400 })
  assert.equal(add.status, 201, JSON.stringify(add.body))
  const r = await post(ravi, REPAIR, {})
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.cached, r.body.computedAt], [false, REPAIR_NOW + 30_000])
  assert.equal(r.body.offset.shares, first.offset.shares + 10)
})

test('tailCap must be a positive number of rupees', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const tailCap of [-5, 0, 'x', true]) {
    const r = await post(ravi, REPAIR, { tailCap })
    assert.deepEqual([r.status, r.body], [400, { error: 'tailCap must be a positive number of rupees' }], String(tailCap))
  }
  assert.deepEqual((await post(ravi, REPAIR, [1])).body, { error: 'body must be { tailCap? }' })
  const capped = await post(ravi, REPAIR, { tailCap: 25_000 })
  assert.deepEqual([capped.status, capped.body.cached], [200, false])
  assert.equal((await post(ravi, REPAIR, { tailCap: null })).body.cached, true, 'null is the default cap, already computed')
})

test('the same book with another key while a search runs is 429 busy', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  let open = (): void => {}
  gate = new Promise((r) => { open = r })
  const running = post(ravi, REPAIR, { tailCap: 30_000 })
  for (let i = 0; i < 400 && pool.running() === 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(pool.running(), 1)
  const busy = await post(ravi, REPAIR, { tailCap: 40_000 })
  assert.deepEqual([busy.status, busy.body, busy.headers.get('retry-after')], [429, { error: 'busy', retryAfterMs: 2000 }, '2'])
  gate = Promise.resolve()
  open()
  const done = await running
  assert.deepEqual([done.status, done.body.cached], [200, false])
  assert.equal(pool.running(), 0)
})

test('a search that fails is a card with its error, and is not kept', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  fail = new Error('a repair worker stopped (exit code 1)')
  const r = await post(ravi, REPAIR, { tailCap: 45_000 })
  fail = null
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, {
    stock: 'TCS', expiry: null, asOf: clock.now, computedAt: clock.now, cached: false, goals: [], offset: null, warnings: [],
    error: 'the repair search failed — try again',
  })
  assert.equal(pool.running(), 0, 'its slot is free')
  const again = await post(ravi, REPAIR, { tailCap: 45_000 })
  assert.deepEqual([again.status, again.body.error, again.body.cached, again.body.expiry], [200, null, false, OCT])
})

test('a book with no option legs, no book, a bad stock', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const mm = await post(ravi, '/v1/traders/books/M%26M/repair', {})
  assert.equal(mm.status, 200)
  assert.deepEqual([mm.body.error, mm.body.goals, mm.body.expiry], ['no option legs to repair: M&M holds only shares', [], null])
  const none = await post(ravi, '/v1/traders/books/INFY/repair', {})
  assert.deepEqual([none.status, none.body], [404, { error: 'no open book INFY' }])
  assert.equal((await post(ravi, '/v1/traders/books/b!d/repair', {})).status, 400)
  assert.equal((await fetch(h.url + REPAIR, { method: 'POST' })).status, 401)
})
