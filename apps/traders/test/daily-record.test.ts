/**
 * The daily record over a real Mongo: the 15:45 write, from the functions the pages call; idempotent; a book flat
 * at the close; the minute timer's catch-up; and `GET /daily`.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { DailyRecorder, type DailyRow } from '../src/analytics/daily.ts'
import type { EodStore } from '../src/analytics/eod.ts'
import { bookMargin } from '../src/analytics/margin.ts'
import { mtmOf } from '../src/analytics/mtm.ts'
import { R2_OCT, TM, optLeg, r2Legs, r2Quotes } from './fixtures/r2-book.ts'
import { startTraders, type TradersHarness } from './harness.ts'
import { wipe } from './mongo.ts'

const FIX = fileURLToPath(new URL('../../../packages/span/test/fixtures/', import.meta.url))
const nse = mkdtempSync(join(tmpdir(), 'traders-daily-nse-'))
mkdirSync(join(nse, '2026-10-19'))
writeFileSync(join(nse, '2026-10-19', 'nsccl.20261019.i2.spn'), readFileSync(join(FIX, 'mini.spn')))
writeFileSync(join(nse, '2026-10-19', 'ael_19102026.csv'), readFileSync(join(FIX, 'ael_19102026.csv')))
writeFileSync(join(nse, '2026-10-19', 'manifest.json'), JSON.stringify({
  a: { name: 'nsccl.20261019.i2.spn', url: 'x', savedAt: Date.UTC(2026, 9, 19, 8, 1), bytes: 1, sha256: '0' },
}))

/** Yesterday's close: known for the Oct 3000 CE only, so a book holding anything else has no Previous MTM. */
const eod = {
  close: (c: { strike: number | null; optType: string | null; expiry: string }) => (c.strike === 3000 && c.optType === 'CE' && c.expiry === R2_OCT ? 55 : null),
  status: () => ({ day: '2026-10-16', fo: 'fo', cm: 'cm', missing: [] }),
  refresh: async () => {},
} as unknown as EodStore

const DAY = '2026-10-19'                                  // Monday
const AT_1550 = Date.UTC(2026, 9, 19, 10, 20)             // 15:50 IST
const AT_1544 = Date.UTC(2026, 9, 19, 10, 14, 59)
const AT_2100 = Date.UTC(2026, 9, 19, 15, 30)
const AT_SAT = Date.UTC(2026, 9, 17, 10, 20)              // Saturday 15:50

const h: TradersHarness | null = await startTraders({ suite: 'daily', master: TM, quotes: r2Quotes(), nseDir: nse, deps: { eod } })
after(async () => { await h?.close(); rmSync(nse, { recursive: true, force: true }) })

/** A recorder of its own: one remembers the books it has finished, and the suite wipes the data between tests. */
const rec = (): DailyRecorder => new DailyRecorder(h!.app.deps)

const rowsOf = async (): Promise<DailyRow[]> =>
  (await h!.db.collection('traders-daily').find({}, { projection: { _id: 0 } }).sort({ trader: 1, stock: 1 }).toArray()) as unknown as DailyRow[]

let seq = 0
const trade = (trader: string, side: 'Buy' | 'Sell', qty: number, price: number, day = DAY): Record<string, unknown> => {
  seq++
  return {
    trader, tradeNo: `t${seq}`, orderNo: `o${seq}`, clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: R2_OCT, strike: 3000, optType: 'CE',
    side, qty, price, time: Date.parse(`${day}T11:00:00+05:30`) + seq, day, seq,
  }
}

before(async () => {
  if (h === null) return
  await h.app.deps.span.refresh(new Set(['TCS']))
})

beforeEach(async () => {
  if (h === null) return
  await wipe(h.handle)
  h.clock.now = AT_1550
  await h.addUser('asha'); await h.addUser('bela'); await h.addUser('cora'); await h.addUser('boss', 'admin')
  const legs = h.handle.db.collection('traders-legs')
  await legs.insertMany(r2Legs().map((l) => ({ ...l })))                                             // asha: the pinned book, with a leg the master cannot place
  await legs.insertMany([{ ...optLeg(R2_OCT, 3000, 'CE', -175, 50), trader: 'bela' }])               // bela: one short call, nothing unknown
  // cora bought and sold the same call today: flat at the close
  await h.handle.db.collection('traders-trades').insertMany([trade('cora', 'Buy', 175, 50), trade('cora', 'Sell', 175, 58)])
})

test('nothing is written before 15:45 IST, on a closed day, or past midnight', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const at of [AT_1544, AT_SAT, Date.UTC(2026, 9, 19, 18, 31)]) {   // 18:31 UTC = 00:01 IST on Tuesday
    h.clock.now = at
    assert.equal(await rec().tick(), 0, new Date(at).toISOString())
  }
  assert.deepEqual(await rowsOf(), [])
})

test('at 15:50 every book is written once, with the figures its own page reads', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal(await rec().tick(), 3)
  const rows = await rowsOf()
  assert.deepEqual(rows.map((r) => [r.trader, r.stock, r.day, r.at]), [['asha', 'TCS', DAY, AT_1550], ['bela', 'TCS', DAY, AT_1550], ['cora', 'TCS', DAY, AT_1550]])

  // bela: one short call; yesterday's close 55, LTP 60: carried -175 × (60 - 55)
  const bela = rows[1] as DailyRow
  const view = (await h.app.deps.bookView('bela', 'TCS', AT_1550))!
  const mtm = (await mtmOf(h.app.deps, 'bela', 'TCS', AT_1550))!
  const margin = (await bookMargin(h.app.deps, 'bela', 'TCS', AT_1550))!
  assert.equal(bela.dayMtm, -875)
  assert.equal(bela.dayMtm, mtm.current.total)
  assert.equal(bela.openPnl, -1750, '(60 - 50) × -175')
  assert.equal(bela.openPnl, view.totals.mtm)
  assert.deepEqual([bela.delta, bela.gamma, bela.theta, bela.vega], [view.totals.delta, view.totals.gamma, view.totals.theta, view.totals.vega])
  assert.deepEqual([bela.seriesNet, bela.seriesBooked], [view.seriesTotal!.net, view.seriesTotal!.booked])
  assert.equal(bela.spot, 3000)
  assert.ok(margin.available && margin.total !== null && margin.total > 0)
  assert.deepEqual([bela.margin, bela.marginSource], [margin.total, 'NSE SPAN 13:31'])
  assert.deepEqual([bela.legs, bela.warnings], [view.legs.length, view.warnings.length + mtm.partial.length])

  // asha: a leg the master cannot place has no LTP, and most legs have no close. The legs' open P&L and the series are
  // unknown, not 0; the MTM block still totals the one contract it can value and names the rest in `partial` — the row says so in `warnings`
  const asha = rows[0] as DailyRow
  const ashaMtm = (await mtmOf(h.app.deps, 'asha', 'TCS', AT_1550))!
  assert.ok(ashaMtm.partial.length > 0)
  assert.deepEqual([asha.dayMtm, asha.openPnl, asha.seriesNet, asha.seriesBooked], [-875, null, null, 0])
  assert.equal(asha.dayMtm, ashaMtm.current.total)
  assert.equal(asha.legs, 6)
  assert.equal(asha.warnings, (await h.app.deps.bookView('asha', 'TCS', AT_1550))!.warnings.length + ashaMtm.partial.length)
})

test('a book flat at the close is a row: what it made, no legs, no greeks, no margin to find', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await rec().tick()
  const cora = (await rowsOf()).find((r) => r.trader === 'cora') as DailyRow
  assert.deepEqual([cora.legs, cora.openPnl, cora.delta, cora.gamma, cora.theta, cora.vega, cora.margin, cora.marginSource], [0, 0, 0, 0, 0, 0, 0, null])
  // 175 × (58 - 50) = 1400 booked, less the day's charges; opened and closed today, so the day and the series agree
  assert.equal(cora.seriesBooked, 1400)
  assert.ok(cora.dayMtm !== null && cora.dayMtm > 1300 && cora.dayMtm < 1400, String(cora.dayMtm))
  assert.equal(cora.seriesNet, cora.dayMtm)
  assert.equal(cora.spot, 3000)
})

test('a trade on another day does not make a book; an open leg does', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await h.handle.db.collection('traders-trades').deleteMany({})
  await h.handle.db.collection('traders-trades').insertOne(trade('cora', 'Buy', 175, 50, '2026-10-16'))
  assert.equal(await rec().tick(), 2)
  assert.deepEqual((await rowsOf()).map((r) => r.trader), ['asha', 'bela'])
})

test('writing again changes nothing: a second tick, and a restarted recorder at 21:00 on later prices', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const once = rec()
  assert.equal(await once.tick(), 3)
  const first = await rowsOf()
  assert.equal(await once.tick(), 0)
  h.clock.now = AT_2100
  assert.equal(await rec().tick(), 0, 'a restarted recorder: the rows of the close stand')
  assert.deepEqual(await rowsOf(), first)
  // and the unique index holds even against a writer that skips the check
  await assert.rejects(h.handle.db.collection('traders-daily').insertOne({ ...first[0] }), /E11000|duplicate/i)
})

test('a server that was down at 15:45 writes on its first tick that evening', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  h.clock.now = AT_2100
  assert.equal(await rec().tick(), 3)
  assert.ok((await rowsOf()).every((r) => r.at === AT_2100))
})

test('a book that appears after the first pass is written by a later tick of the same recorder, and only it', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await h.addUser('dora')   // a trader with no book at the first pass
  h.clock.now = AT_2100
  const evening = rec()
  assert.equal(await evening.tick(), 3)
  assert.equal(await evening.tick(), 0, 'nothing new: nothing read again, nothing written')

  // bela, who already has a row, trades a second stock (a late trade file), and dora's first leg lands
  const late = (side: 'Buy' | 'Sell', price: number) => ({ ...trade('bela', side, 10, price), stock: 'INFY', instrument: 'share', expiry: '', strike: null, optType: null })
  await h.handle.db.collection('traders-trades').insertMany([late('Buy', 1500), late('Sell', 1510)])
  await h.handle.db.collection('traders-legs').insertOne({ ...optLeg(R2_OCT, 3000, 'CE', -175, 50), trader: 'dora' })
  h.clock.now = AT_2100 + 60_000
  assert.equal(await evening.tick(), 2)
  const rows = await rowsOf()
  assert.deepEqual(rows.map((r) => [r.trader, r.stock, r.at]), [
    ['asha', 'TCS', AT_2100], ['bela', 'INFY', AT_2100 + 60_000], ['bela', 'TCS', AT_2100], ['cora', 'TCS', AT_2100], ['dora', 'TCS', AT_2100 + 60_000],
  ])
  assert.equal(rows[1]!.legs, 0, 'a book flat at the close')
  assert.equal(await evening.tick(), 0)
})

test('a book that fails is logged and retried while the others are written; a trader whose books are all written is not looked at again', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const logged: string[] = []
  let broken = true
  const calls: string[] = []
  const rec = new DailyRecorder({
    ...h.app.deps, log: (m) => { logged.push(m) },
    bookView: async (trader, stock, nowMs) => {
      calls.push(trader)
      if (broken && trader === 'asha') throw new Error('boom')
      return await h.app.deps.bookView(trader, stock, nowMs)
    },
  })
  assert.equal(await rec.tick(), 2)
  assert.deepEqual((await rowsOf()).map((r) => r.trader), ['bela', 'cora'])
  assert.deepEqual(logged, ['daily record failed for a book'])
  broken = false
  calls.length = 0
  assert.equal(await rec.tick(), 1)
  assert.deepEqual((await rowsOf()).map((r) => r.trader), ['asha', 'bela', 'cora'])
  assert.deepEqual(calls, ['asha'], 'bela and cora were done: not read again')
  calls.length = 0
  assert.equal(await rec.tick(), 0)
  assert.deepEqual(calls, [])
})

test('after DAILY_MAX_TRIES failures the evening is given up, said once', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const logged: string[] = []
  const rec = new DailyRecorder({ ...h.app.deps, log: (m) => { logged.push(m) }, bookView: async () => { throw new Error('boom') } })
  for (let i = 0; i < 8; i++) await rec.tick()
  assert.equal(logged.filter((m) => m === 'daily record failed for a book').length, 15, 'five passes, three books')
  assert.equal(logged.filter((m) => m === 'daily record given up for the evening').length, 3)
  assert.deepEqual(await rowsOf(), [])
})

test('the app runs the recorder on a minute timer, clears it on stop, and starts none when switched off', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { createApp } = await import('../src/app.ts')
  const timers: { readonly ms: number; readonly run: () => Promise<void>; cleared: number }[] = []
  const every = (run: () => Promise<void>, ms: number): (() => void) => {
    const timer = { ms, run, cleared: 0 }
    timers.push(timer)
    return () => { timer.cleared++ }
  }
  const make = (daily?: boolean) => createApp({
    db: h.db, bus: null, config: { ...h.deps.config, nseDir: nse }, now: () => AT_1550, log: () => {}, master: TM, quotes: r2Quotes(),
    declare: false, bandBoard: false, eodRefreshMs: 111, spanRefreshMs: 222, historyRefreshMs: 333, every, ...(daily === undefined ? {} : { daily }),
  })
  const app = await make()
  await app.start()
  const minute = timers.filter((x) => x.ms === 60_000)
  assert.equal(minute.length, 1)
  assert.deepEqual(await rowsOf(), [], 'the first pass is a tick, not start()')
  await minute[0]!.run()
  assert.equal((await rowsOf()).length, 3)
  await app.stop()
  assert.equal(minute[0]!.cleared, 1)

  timers.length = 0
  const off = await make(false)
  await off.start()
  assert.deepEqual(timers.filter((x) => x.ms === 60_000), [])
  await off.stop()
})

// ---- GET /daily ----------------------------------------------------------------------

const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })

test('GET /daily: the trader\'s days, newest first, each with its books and totals; never another trader\'s', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await rec().tick()
  // an earlier close, written by hand
  const coll = h.handle.db.collection('traders-daily')
  const old = (await rowsOf()).find((r) => r.trader === 'bela') as DailyRow
  await coll.insertOne({ ...old, day: '2026-10-16', at: 7, dayMtm: 100, openPnl: null })
  const asha = h.as('asha')
  const r = await json(await asha('/v1/traders/daily?trader=bela&as=bela'))
  assert.equal(r.status, 200)
  assert.equal(r.body.trader, 'asha', "a trader's own session ignores both names")
  assert.deepEqual(r.body.days.map((d: any) => [d.day, d.books.map((b: any) => b.stock)]), [[DAY, ['TCS']]])
  assert.equal(JSON.stringify(r.body).includes('bela'), false)
  assert.equal(r.body.recordedFrom, DAY)
  assert.equal(r.body.days[0].totals.books, 1)

  const bela = await json(await h.as('bela')('/v1/traders/daily'))
  assert.deepEqual(bela.body.days.map((d: any) => d.day), [DAY, '2026-10-16'])
  assert.equal(bela.body.recordedFrom, '2026-10-16')
  assert.equal(bela.body.days[0].totals.dayMtm, -875)
  assert.deepEqual(bela.body.days[1].totals.missing.openPnl, ['TCS'])
  assert.ok(bela.body.notes.length >= 2)
})

test('GET /daily?days= bounds the window; a bad one is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await rec().tick()
  const coll = h.handle.db.collection('traders-daily')
  const old = (await rowsOf()).find((r) => r.trader === 'bela') as DailyRow
  await coll.insertOne({ ...old, day: '2026-10-05', at: 7 })
  const bela = h.as('bela')
  assert.deepEqual((await json(await bela('/v1/traders/daily?days=5'))).body.days.map((d: any) => d.day), [DAY])
  assert.deepEqual((await json(await bela('/v1/traders/daily?days=15'))).body.days.map((d: any) => d.day), [DAY, '2026-10-05'])
  for (const bad of ['0', '-1', '1.5', 'x', '367']) assert.equal((await bela(`/v1/traders/daily?days=${bad}`)).status, 400, bad)
})

test('GET /daily for an admin: ?trader= or ?as= names the trader; none is 400, a stranger 404; no session 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await rec().tick()
  const boss = h.as('boss')
  assert.equal((await json(await boss('/v1/traders/daily?trader=cora'))).body.trader, 'cora')
  assert.equal((await json(await boss('/v1/traders/daily?as=bela'))).body.trader, 'bela')
  assert.equal((await json(await boss('/v1/traders/daily?trader=cora&as=bela'))).body.trader, 'cora')
  assert.equal((await boss('/v1/traders/daily')).status, 400)
  assert.equal((await boss('/v1/traders/daily?trader=nobody')).status, 404)
  assert.equal((await boss('/v1/traders/daily?trader=boss')).status, 404, 'an admin is not a trader')
  assert.equal((await fetch(`${h.url}/v1/traders/daily`)).status, 401)
})

test('the daily indexes: the unique book key and a trader\'s days newest first', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const raw = h.handle.db.collection('traders-daily') as unknown as { indexes(): Promise<{ key: Record<string, number>; unique?: boolean }[]> }
  const ix = await raw.indexes()
  assert.ok(ix.some((i) => JSON.stringify(i.key) === JSON.stringify({ trader: 1, stock: 1, day: 1 }) && i.unique === true))
  assert.ok(ix.some((i) => JSON.stringify(i.key) === JSON.stringify({ trader: 1, day: -1 })))
})
