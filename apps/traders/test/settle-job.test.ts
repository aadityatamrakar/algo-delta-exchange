import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { SEED_RATES } from '../src/analytics/charges.ts'
import { seriesPnl, seriesReader } from '../src/analytics/series-pnl.ts'
import { LegStore } from '../src/books/legs.ts'
import { LedgerStore } from '../src/ingest/ledger-store.ts'
import { serialised, type IngestDeps } from '../src/ingest/pipeline.ts'
import { recomputeSettlement, settlementJob, type SettleJobDeps } from '../src/ingest/settle-job.ts'
import type { SettlementPrice } from '../src/ingest/settlement.ts'
import { matchLeg } from '../src/market/master.ts'
import type { TraderTrade } from '../src/types.ts'
import { testMaster } from './fixtures/master.ts'
import { connectSuite, wipe } from './mongo.ts'

const MASTER = testMaster()
const h = await connectSuite('settle_job')
if (h !== null) await h.db.ensureIndexes()
after(async () => { await h?.handle.close() })
beforeEach(async () => { if (h !== null) await wipe(h.handle) })

const SEP = '2026-09-29'
const NOW = Date.parse('2026-10-23T10:30:00+05:30')
let closes: Record<string, number> = {}
const price: SettlementPrice = (stock, day) => closes[`${stock}|${day}`] ?? null
const isIndex = (s: string): boolean => s === 'NIFTY'

/** Opened on the expiry day itself, so no day of the open cycle lacks a trade (the record guard, settlement.ts). */
function trade(trader: string, n: number, o: Partial<TraderTrade>): TraderTrade {
  const day = o.day ?? SEP
  return {
    trader, tradeNo: `T${n}`, orderNo: `O${n}`, clientCode: 'C0001', stock: 'TCS', instrument: 'option', expiry: SEP, strike: 2000, optType: 'CE',
    side: 'Buy', qty: 175, price: 20, time: Date.parse(`${day}T10:00:00+05:30`), day, seq: n, ...o,
  }
}

/** The trade history starts long before the September contracts list: no cycle opened in its first days. */
async function history(db: NonNullable<typeof h>['db'], ...traders: string[]): Promise<void> {
  for (const trader of traders) await new LedgerStore(db).noteHistory(trader, '2026-05-04')
}

function setup() {
  const db = h!.db
  const legs = new LegStore(db, () => NOW)
  const ledger = new LedgerStore(db, { price, isIndex, now: () => NOW })
  const lines: { msg: string; fields: unknown }[] = []
  const ingest: IngestDeps = { files: null!, apply: async () => {}, log: () => {} }
  const deps: SettleJobDeps = { ledger, legs, master: () => MASTER, ingest, log: (msg, fields) => { lines.push({ msg, fields }) }, now: () => NOW }
  return { db, legs, ledger, deps, lines }
}

test('the ledger folds the settlement in: the expired call ends at 0 beside the delivered shares, and the run is kept for the book', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { db, ledger } = setup()
  closes = { [`TCS|${SEP}`]: 2032.4 }
  // a hand-typed lower-case code is ODIN's upper-case one
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 1, { clientCode: 'c0001' }))
  await history(db, 'ravi')
  const run = await ledger.odinLedger('ravi')
  assert.deepEqual(run.legs.map((l) => [l.instrument, l.qty, l.avgPrice]), [['option', 0, 0], ['share', 175, 2032.4]])
  assert.deepEqual(await ledger.odinLegs('ravi'), run.legs)
  const kept = await ledger.settlement('ravi')
  assert.equal(kept.fills.length, 2)
  assert.deepEqual(kept.deliveries.map((d) => [d.stock, d.expiry, d.shares, d.price]), [['TCS', SEP, 175, 2032.4]])
  // without a settlement wired, the ledger is as it was
  assert.deepEqual((await new LedgerStore(db).odinLegs('ravi')).map((l) => [l.instrument, l.qty]), [['option', 175]])
})

test('a fresh store works the settlement out once however many books ask, and again on a new day', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { db } = setup()
  closes = { [`TCS|${SEP}`]: 2032.4 }
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 1, {}))
  await history(db, 'ravi')
  let now = NOW
  const ledger = new LedgerStore(db, { price, isIndex, now: () => now })
  const [a, b, c] = await Promise.all([ledger.settlement('ravi'), ledger.settlement('ravi'), ledger.settlement('ravi')])
  assert.ok(a === b && b === c)
  assert.equal(await ledger.settlement('ravi'), a)
  now += 86_400_000
  const next = await ledger.settlement('ravi')
  assert.notEqual(next, a)
  assert.deepEqual(next, a)
})

test('the recompute settles stored legs once; a second run writes nothing', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { db, legs, deps, lines } = setup()
  closes = {}
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 1, {}))
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 2, { stock: 'NIFTY', strike: 24500, qty: 75, price: 120 }))
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('asha', 1, { optType: 'PE', strike: 2100 }))
  await history(db, 'ravi', 'asha')
  // the legs as an apply before G2 left them: the expired contracts open
  for (const trader of ['ravi', 'asha']) await legs.replaceOdin(trader, await new LedgerStore(db).odinLegs(trader), (c) => matchLeg(MASTER, c))
  const before = { ravi: legs.version('ravi'), asha: legs.version('asha') }

  // no history yet: every contract is unsettled and nothing is written
  assert.deepEqual(pick(await recomputeSettlement(deps)), { traders: 2, fills: 0, unsettled: 3, failed: 0 })
  assert.deepEqual({ ravi: legs.version('ravi'), asha: legs.version('asha') }, before)

  // the history day arrives: TCS settles (and delivers), the index has no close and stays open
  closes = { [`TCS|${SEP}`]: 2032.4 }
  assert.deepEqual(pick(await recomputeSettlement(deps)), { traders: 2, fills: 4, unsettled: 1, failed: 0 })
  const stored = await db.collection('traders-legs').find({}, { projection: { _id: 0, trader: 1, instrument: 1, stock: 1, qty: 1, avgPrice: 1 } }).sort({ trader: 1, stock: 1, instrument: 1 }).toArray()
  assert.deepEqual(stored, [
    { trader: 'asha', instrument: 'option', stock: 'TCS', qty: 0, avgPrice: 0 },
    { trader: 'asha', instrument: 'share', stock: 'TCS', qty: -175, avgPrice: 2032.4 },
    { trader: 'ravi', instrument: 'option', stock: 'NIFTY', qty: 75, avgPrice: 120 },
    { trader: 'ravi', instrument: 'option', stock: 'TCS', qty: 0, avgPrice: 0 },
    { trader: 'ravi', instrument: 'share', stock: 'TCS', qty: 175, avgPrice: 2032.4 },
  ])
  const settled = { ravi: legs.version('ravi'), asha: legs.version('asha') }
  assert.deepEqual(settled, { ravi: before.ravi + 1, asha: before.asha + 1 })

  // idempotent: the same history again writes no leg
  assert.deepEqual(pick(await recomputeSettlement(deps)), { traders: 2, fills: 4, unsettled: 1, failed: 0 })
  assert.deepEqual({ ravi: legs.version('ravi'), asha: legs.version('asha') }, settled)

  // one line a run, counts only: no client code anywhere in the log
  assert.deepEqual(lines.map((l) => l.msg), ['settlement recomputed', 'settlement recomputed', 'settlement recomputed'])
  assert.equal(JSON.stringify(lines).includes('C0001'), false)
})

test('the recompute waits for the trader\'s ingest chain, and runs queue behind each other', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { db, deps } = setup()
  closes = { [`TCS|${SEP}`]: 2032.4 }
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 1, {}))
  const order: string[] = []
  const recording: SettleJobDeps = {
    ...deps,
    legs: { replaceOdin: async () => { order.push('recompute') } },
  }
  let release: () => void = () => {}
  const held = serialised(deps.ingest, 'ravi', () => new Promise<void>((r) => { release = () => { order.push('apply'); r() } }))
  const job = settlementJob(recording)
  const first = job()
  const second = job()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(order, [])   // the apply holds the chain
  release()
  await Promise.all([held, first, second])
  assert.deepEqual(order, ['apply', 'recompute', 'recompute'])
})

test('a trader whose run fails is logged and skipped; the others are settled', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { db, deps, lines } = setup()
  closes = { [`TCS|${SEP}`]: 2032.4 }
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('asha', 1, {}))
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 1, {}))
  await history(db, 'ravi', 'asha')
  const written: string[] = []
  const flaky: SettleJobDeps = {
    ...deps,
    legs: { replaceOdin: async (trader) => { if (trader === 'asha') throw new Error('write failed'); written.push(trader) } },
  }
  assert.deepEqual(pick(await recomputeSettlement(flaky)), { traders: 2, fills: 2, unsettled: 0, failed: 1 })
  assert.deepEqual(written, ['ravi'])
  assert.deepEqual(lines.map((l) => l.msg), ['settlement recompute failed for a trader', 'settlement recomputed'])
})

const pick = (s: { traders: number; fills: number; unsettled: number; failed: number }) =>
  ({ traders: s.traders, fills: s.fills, unsettled: s.unsettled, failed: s.failed })

test('on the expiry evening the series of the expiring month books the ledger\'s settlement (its live filter keeps today)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { db } = setup()
  closes = { [`TCS|${SEP}`]: 2032.4 }
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 1, { day: '2026-09-28', time: Date.parse('2026-09-28T10:00:00+05:30') }))
  // the trader's F&O file of the expiry day came (another stock's trade): the record vouches for the day
  await db.collection<TraderTrade>('traders-trades').insertOne(trade('ravi', 2, { stock: 'INFY', expiry: '2026-10-27', strike: 1500 }))
  await history(db, 'ravi')
  // 20:00 IST on the expiry day: the close is in, the series is still live today, its contract is settled
  const evening = Date.parse(`${SEP}T20:00:00+05:30`)
  const ledger = new LedgerStore(db, { price, isIndex, now: () => evening })
  const legs = (await ledger.odinLegs('ravi')).filter((l) => l.qty !== 0 && l.stock === 'TCS')
  assert.deepEqual(legs.map((l) => [l.instrument, l.qty]), [['share', 175]])
  const base = await seriesReader({ db, ledger, charges: { get: async () => SEED_RATES } })('ravi', 'TCS', 0, evening)
  assert.equal(base.settlement?.length, 1)
  const { series } = seriesPnl({ ...base, trader: 'ravi', stock: 'TCS', today: SEP, legs: [], lotSizeOf: () => 175 })
  assert.deepEqual(series.map((x) => [x.expiry, x.open, x.booked, x.closedContracts, x.openLegs]), [[SEP, 0, 2170, 1, 0]])   // 175 × (32.40 − 20)
})
