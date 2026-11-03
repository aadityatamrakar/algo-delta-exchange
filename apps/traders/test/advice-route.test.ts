import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { P4_NOTE, SHIFT_NOTE, historyNote } from '../src/analytics/advice.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const M = r3Master()
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)   // the harness clock: Monday 09:30 IST, in session
const quotes = fakeQuotes()
quotes.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: T0 })
quotes.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: T0 })
priceChain(quotes, M, 'TCS', OCT, 3400, 0.25, T0)

const h: TradersHarness | null = await startTraders({ suite: 'advice', master: M, quotes })
after(async () => { await h?.close() })

const ADVICE = '/v1/traders/books/TCS/advice'
let ravi: (path: string, init?: RequestInit) => Promise<Response>
let boss: (path: string, init?: RequestInit) => Promise<Response>
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })
const addLeg = (body: unknown) => ravi('/v1/traders/books/TCS/legs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

before(async () => {
  if (h === null) return
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
  ravi = h.as('ravi'); boss = h.as('boss')
  // short 10 lots of the 3300 PE: long delta past its band, so relief-r sells calls
  const r = await addLeg({ instrument: 'option', expiry: OCT, strike: 3300, optType: 'PE', qty: -1750, avgPrice: 40 })
  assert.equal(r.status, 201, await r.text())
  await h.deps.ledger.noteHistory('ravi', '2026-10-01')
})

test('GET advice returns the card with its band and historyFrom', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await ravi(ADVICE))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const c = r.body
  assert.deepEqual([c.stock, c.status, c.trigger, c.computedAt, c.historyFrom], ['TCS', 'advice', 'shed', h.clock.now, '2026-10-01'])
  assert.deepEqual(c.lines, ['Sell 2 lots TCS OCT 3500 CE'])
  assert.equal(c.headline, c.lines[0])
  assert.match(c.reason, /^sell 2 3,500CE \(netΔ \+\d+ vs allowed \d+/)
  assert.deepEqual(c.whatIf.map((l: any) => [l.instrument, l.expiry, l.strike, l.optType, l.qty]), [['option', OCT, 3500, 'CE', -350]])
  assert.ok(c.whatIf[0].price > 0)
  assert.deepEqual([c.band.state, c.band.source, c.band.lotSize, c.band.marketOpen], ['out', 'engine', 175, true])
  assert.match(c.band.sentence, /^Out of band by 1 lot — To neutralize: Sell \d+ lots TCS OCT FUT$/)
  assert.deepEqual(c.notes, [historyNote('2026-10-01'), P4_NOTE, SHIFT_NOTE, 'Advises on the 27 Oct expiry only.'])
})

test('two viewers in one minute share one decide', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  h.clock.now += 120_000   // past the last test's minute: this reading starts here
  const first = h.clock.now
  const mine = await json(await ravi(ADVICE))
  assert.equal(mine.body.computedAt, first)
  h.clock.now += 30_000
  const theirs = await json(await boss(`${ADVICE}?as=ravi`))
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body))
  // relief-r ran once, at the first GET: the admin's card is that pass, not a second one
  assert.deepEqual(theirs.body, mine.body)
  assert.equal(theirs.body.computedAt, first)
  assert.deepEqual((await json(await boss(ADVICE))).body, { error: 'pick a trader: ?as=<username>' })
})

test('a new upload inside the minute gives a new card', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const before = (await json(await ravi(ADVICE))).body
  assert.equal(before.status, 'advice')
  h.clock.now += 10_000
  // the sale relief-r asked for, entered as a manual leg: the version moves and the next GET reads the new book
  const r = await addLeg({ instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, avgPrice: 20 })
  assert.equal(r.status, 201, await r.text())
  const after = (await json(await ravi(ADVICE))).body
  assert.equal(after.computedAt, h.clock.now)
  assert.notEqual(after.computedAt, before.computedAt)
  assert.deepEqual([after.status, after.headline, after.lines, after.whatIf, after.band.state], ['hold', 'Hold', [], [], 'in'])
  assert.match(after.reason, /inside allowed/)
})

test('a book the trader does not hold is 404; a bad stock is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const sita = h.as('sita')
  assert.deepEqual(await json(await sita(ADVICE)), { status: 404, body: { error: 'no open book TCS' } })
  assert.deepEqual(await json(await ravi('/v1/traders/books/INFY/advice')), { status: 404, body: { error: 'no open book INFY' } })
  assert.equal((await ravi('/v1/traders/books/a.b/advice')).status, 400)
  // read only: no other method reaches it
  assert.equal((await ravi(ADVICE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404)
})
