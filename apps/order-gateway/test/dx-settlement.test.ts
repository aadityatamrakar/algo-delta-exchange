import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optionFee } from '@algomaker/dx'
import { DX } from '@algomaker/venue'
import {
  createDxSettlementJob,
  planDxSettlement,
  type DxSettlementPorts,
  type DxSettlementRow,
  type OpenBook,
  type SettlementBooking,
} from '../src/dx-settlement.ts'

const EXPIRY = '2026-11-04'
const INSTANT = Date.UTC(2026, 10, 4, 12)
const MIN = 60_000

const CE = 'C-BTC-76600-041126'
const PE = 'P-BTC-76600-041126'

function book(over: Partial<OpenBook> = {}): OpenBook {
  return {
    tag: 'BS-D1',
    mode: 'paper',
    symbol: 'BTC',
    expiry: EXPIRY,
    legs: [
      { deskTag: 'ce1', instrument: { tradingsymbol: CE, instrumentToken: 501 }, expiry: EXPIRY, strike: 76600, type: 'CE', qty: -0.05 },
      { deskTag: 'pe1', instrument: { tradingsymbol: PE, instrumentToken: 502 }, expiry: EXPIRY, strike: 76600, type: 'PE', qty: -0.05 },
    ],
    ...over,
  }
}

function row(id: number, symbol: string, price: number): DxSettlementRow {
  return { _id: id, symbol, expiry: EXPIRY, price, publishedAt: INSTANT + 5 * MIN }
}

test('nothing is settled before the expiry instant, even at 11:59:59 UTC', () => {
  const plan = planDxSettlement([book()], [row(501, CE, 412.3), row(502, PE, 0)], INSTANT - 1000)
  assert.deepEqual(plan.book, [])
  assert.deepEqual(plan.waiting, [])
})

test('after the instant each expired leg is closed at Delta\'s published price, net per contract', () => {
  const plan = planDxSettlement([book()], [row(501, CE, 412.3), row(502, PE, 0)], INSTANT + 1000)
  assert.equal(plan.waiting.length, 0)
  const ce = plan.book.find((b) => b.tradingsymbol === CE) as SettlementBooking
  const pe = plan.book.find((b) => b.tradingsymbol === PE) as SettlementBooking
  // A short is closed by a Buy, at the settlement price, stamped 1 ms before
  // the instant so it is booked on the expiry's own day.
  assert.deepEqual(
    { side: ce.side, qty: ce.qty, price: ce.price, ts: ce.ts, deskTag: ce.deskTag, productId: ce.productId },
    { side: 'Buy', qty: 0.05, price: 412.3, ts: INSTANT - 1, deskTag: 'ce1', productId: 501 },
  )
  // Settlement fee at the taker rate, capped — on the index the price implies
  // (a CE settles at index − strike).
  assert.equal(DX.dayKey(ce.ts), EXPIRY, 'the close is on the expiry day, not the next')
  assert.equal(ce.fee, optionFee({ contracts: 50, index: 76600 + 412.3, premium: 412.3 }).total)
  // Worthless: no settlement fee.
  assert.deepEqual({ price: pe.price, fee: pe.fee }, { price: 0, fee: 0 })
})

test('settlement waits for Delta\'s price and never invents one', async () => {
  const booked: SettlementBooking[] = []
  const alerts: string[] = []
  let rows: DxSettlementRow[] = []
  let now = INSTANT + 1000
  const ports: DxSettlementPorts = {
    listBooks: async () => [book()],
    settlements: async () => rows,
    workingOn: async () => 0,
    book: async (b) => {
      booked.push(b)
      return 'booked'
    },
    alert: async (w) => {
      alerts.push(w.tradingsymbol)
    },
    now: () => now,
    log: () => {},
  }
  const job = createDxSettlementJob(ports)

  // Published late: no row yet → nothing booked, no alert inside 30 min.
  let r = await job.run()
  assert.deepEqual({ booked: r.booked, waiting: r.waiting }, { booked: 0, waiting: 2 })
  now = INSTANT + 29 * MIN
  await job.run()
  assert.equal(booked.length, 0)
  assert.equal(alerts.length, 0)

  // Still missing 30 min after: an ALERT, once per contract — never a close.
  now = INSTANT + 30 * MIN
  await job.run()
  await job.run()
  assert.deepEqual(alerts.sort(), [CE, PE])
  assert.equal(booked.length, 0)

  // A row with no usable price is still no price.
  rows = [{ ...row(501, CE, 0), price: Number.NaN }]
  await job.run()
  assert.equal(booked.length, 0)

  // Published: booked at exactly that price.
  rows = [row(501, CE, 412.3), row(502, PE, 0)]
  r = await job.run()
  assert.equal(r.booked, 2)
  assert.deepEqual(booked.map((b) => [b.tradingsymbol, b.price]).sort(), [[CE, 412.3], [PE, 0]])
})

test('a contract with an order still working is not settled until that order is terminal', async () => {
  const booked: SettlementBooking[] = []
  let working = 1
  const job = createDxSettlementJob({
    listBooks: async () => [book()],
    settlements: async () => [row(501, CE, 412.3), row(502, PE, 0)],
    workingOn: async (_tag, _mode, sym) => (sym === CE ? working : 0),
    book: async (b) => {
      booked.push(b)
      return 'booked'
    },
    alert: async () => {},
    now: () => INSTANT + MIN,
    log: () => {},
  })
  await job.run()
  assert.deepEqual(booked.map((b) => b.tradingsymbol), [PE])
  working = 0
  await job.run()
  assert.ok(booked.slice(1).some((b) => b.tradingsymbol === CE), 'settled once the order is terminal')
})

test('a live book settles the same way, and a settlement row is found by symbol when the leg has no product id', () => {
  const b = book({
    mode: 'live',
    legs: [{ deskTag: 'ce1', instrument: { tradingsymbol: CE }, expiry: EXPIRY, strike: 76600, type: 'CE', qty: 0.1 }],
  })
  const plan = planDxSettlement([b], [row(501, CE, 100)], INSTANT + MIN)
  assert.equal(plan.book.length, 1)
  assert.deepEqual({ mode: plan.book[0]?.mode, side: plan.book[0]?.side, qty: plan.book[0]?.qty }, { mode: 'live', side: 'Sell', qty: 0.1 })
})

test('offsetting legs that net to zero are left alone; a leg in a live expiry is untouched', () => {
  const b = book({
    legs: [
      { deskTag: 'a', instrument: { tradingsymbol: CE, instrumentToken: 501 }, expiry: EXPIRY, strike: 76600, type: 'CE', qty: 0.05 },
      { deskTag: 'b', instrument: { tradingsymbol: CE, instrumentToken: 501 }, expiry: EXPIRY, strike: 76600, type: 'CE', qty: -0.05 },
      { deskTag: 'c', instrument: { tradingsymbol: 'C-BTC-77000-051126', instrumentToken: 777 }, expiry: '2026-11-05', strike: 77000, type: 'CE', qty: -0.05 },
    ],
  })
  const plan = planDxSettlement([b], [row(501, CE, 10)], INSTANT + MIN)
  assert.deepEqual(plan.book, [])
  assert.deepEqual(plan.waiting, [])
})
