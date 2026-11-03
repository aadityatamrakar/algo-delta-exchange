/**
 * The settlement booking port against a real Mongo: one decision record, one
 * fold into desk-books, idempotent on a re-run. No supervisor nudge leaves the
 * process (the notifier is injected).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { connectMongo, type MongoHandle } from '../../api/src/mongo.ts'
import { DeskStore } from '../../api/src/store.ts'
import { DX } from '@algomaker/venue'
import { listOpenBooks, mongoSettlementBooker, planDxSettlement, countWorking } from '../src/dx-settlement.ts'

const URL_MONGO = process.env['DESK_TEST_MONGO_GW_SETTLE'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_gw_settle_test'
const EXPIRY = '2026-11-04'
const INSTANT = Date.UTC(2026, 10, 4, 12)
const CE = 'C-BTC-76600-041126'

let handle: MongoHandle | null = null

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO)
  } catch {
    handle = null
  }
  if (handle !== null) await new DeskStore(handle.db as never).ensureIndexes()
})
after(async () => {
  await handle?.close()
})
beforeEach(async () => {
  if (handle === null) return
  for (const c of ['desk-books', 'desk-decisions', 'desk-gateway-orders']) await handle.db.collection(c).deleteMany({})
})

test('a settled short leg is closed on desk-books at Delta\'s price, once', async (t) => {
  if (handle === null) return skipUnlessMongo(t)
  const db = handle.db
  await db.collection('desk-books').insertOne({
    tag: 'BS-D1', mode: 'paper', symbol: 'BTC', expiry: EXPIRY, updatedAt: 1,
    legs: [{
      deskTag: 'ce1', instrument: { tradingsymbol: CE, instrumentToken: 501, lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA' },
      underlying: 'BTC', expiry: EXPIRY, strike: 76600, type: 'CE', side: 'Sell', qty: -0.05, entryPrice: 300, openedTs: 1,
    }],
  })
  const books = await listOpenBooks(db as never)
  assert.equal(books.length, 1)
  assert.equal(await countWorking(db as never, 'BS-D1', 'paper', CE), 0)
  const plan = planDxSettlement(books, [{ _id: 501, symbol: CE, expiry: EXPIRY, price: 412.3, publishedAt: INSTANT + 60_000 }], INSTANT + 120_000)
  assert.equal(plan.book.length, 1)
  const nudges: string[] = []
  const book = mongoSettlementBooker({
    db: db as never, now: () => INSTANT + 120_000, log: () => {},
    notify: async (tag) => { nudges.push(tag) },
  })
  assert.equal(await book(plan.book[0]!), 'booked')
  assert.equal(await book(plan.book[0]!), 'already', 'a re-run books nothing')

  const decisions = await db.collection('desk-decisions').find({}).toArray()
  assert.equal(decisions.length, 1)
  const fill = (decisions[0]?.['fills'] as Record<string, unknown>[])[0]
  assert.deepEqual(
    { op: fill?.['op'], side: fill?.['side'], qty: fill?.['qty'], price: fill?.['price'], ts: fill?.['ts'] },
    { op: 'close', side: 'Buy', qty: 0.05, price: 412.3, ts: INSTANT - 1 },
  )
  assert.ok(Number(fill?.['fee']) > 0)
  assert.equal(decisions[0]?.['createdAt'], INSTANT - 1, 'booked on the last ms of the settled day')
  assert.equal(DX.dayKey(Number(decisions[0]?.['createdAt'])), EXPIRY)
  const after = await db.collection('desk-books').findOne({ tag: 'BS-D1', mode: 'paper' })
  const open = ((after?.['legs'] ?? []) as { qty: number }[]).filter((l) => l.qty !== 0)
  assert.equal(open.length, 0, 'the leg is gone')
  assert.deepEqual(nudges, ['BS-D1'])
  assert.equal((await listOpenBooks(db as never)).length, 0)
})

test('an order still working on the contract is counted on its own rail', async (t) => {
  if (handle === null) return skipUnlessMongo(t)
  const db = handle.db
  await db.collection('desk-gateway-orders').insertMany([
    { clientOrderId: 'a', tag: 'BS-D1', tradingsymbol: CE, state: 'PLACED' },
    { clientOrderId: 'b', tag: 'BS-D1', tradingsymbol: CE, state: 'PLACED', mode: 'live' },
    { clientOrderId: 'c', tag: 'BS-D1', tradingsymbol: CE, state: 'FILLED' },
  ])
  assert.equal(await countWorking(db as never, 'BS-D1', 'paper', CE), 1)
  assert.equal(await countWorking(db as never, 'BS-D1', 'live', CE), 1)
})
