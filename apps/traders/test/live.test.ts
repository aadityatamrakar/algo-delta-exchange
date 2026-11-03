import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eodKey, type EodContract } from '@algomaker/span'
import { SEED_RATES } from '../src/analytics/charges.ts'
import { analysisSeries } from '../src/analytics/analysis.ts'
import { liveFrame, liveSeriesClosed, sameFrame, type LiveBase } from '../src/analytics/live.ts'
import type { MtmInputs } from '../src/analytics/mtm.ts'
import { seriesPnl, type SeriesBase } from '../src/analytics/series-pnl.ts'
import { priceBook } from '../src/analytics/snapshot.ts'
import { matchLeg } from '../src/market/master.ts'
import type { TraderLeg, TraderTrade } from '../src/types.ts'
import { FUT_TOKEN, R2_NOW, R2_OCT, SPOT_TOKEN, TM, optToken, r2Legs, r2Market, r2Quotes } from './fixtures/r2-book.ts'

const LEGS = r2Legs()
const OCT3000 = LEGS[0]!   // short 175 Oct 3000 CE at 50
const BASE: LiveBase = {
  trader: 'asha', stock: 'TCS', version: 1, legs: LEGS,
  tokens: new Map(LEGS.map((l) => [l.key, matchLeg(TM, l)] as const)),
  spotToken: SPOT_TOKEN, futureToken: FUT_TOKEN[R2_OCT]!, mtm: null,
}
const T3000 = optToken(R2_OCT, 3000, 'CE')
// the short Oct 3000 CE, sold on Friday at 50
const OPENED: TraderTrade = {
  trader: 'asha', tradeNo: 'T1', orderNo: 'O1', clientCode: OCT3000.clientCode, stock: 'TCS', instrument: 'option', expiry: R2_OCT,
  strike: 3000, optType: 'CE', side: 'Sell', qty: 175, price: 50, time: Date.parse('2026-10-16T10:00:00+05:30'), day: '2026-10-16', seq: 1,
}

test("a frame: each leg's price and gross MTM from the quote cache, the spot and the near future", () => {
  const q = r2Quotes()
  const f = liveFrame(BASE, q, TM, R2_NOW)
  const p = q.quote(T3000)!.price
  const leg = f.legs.find((l) => l.key === OCT3000.key)!
  assert.equal(leg.ltp, p)
  assert.equal(leg.grossMtm, -175 * (p - 50))
  assert.equal(leg.stale, false)
  assert.equal(f.spot, q.quote(SPOT_TOKEN)!.price)
  assert.equal(f.future, q.quote(FUT_TOKEN[R2_OCT]!)!.price)
  assert.equal(f.closed, false)          // Mon 19 Oct, 10:00 IST
  assert.equal(f.feedAlive, true)
  assert.deepEqual([f.mtmToday, f.mtmTotal, f.mtmReason], [null, null, null])   // no MTM inputs in this base: the frame says nothing about the block
  assert.equal(f.legs.length, LEGS.length)
})

test('an unchanged market is the same frame (the stream sends nothing); a moved price is a new one', () => {
  const a = liveFrame(BASE, r2Quotes(), TM, R2_NOW)
  assert.equal(sameFrame(a, liveFrame(BASE, r2Quotes(), TM, R2_NOW + 1_000)), true)   // only asOf differs
  assert.equal(sameFrame(a, liveFrame(BASE, r2Quotes({ [T3000]: 61.5 }), TM, R2_NOW + 1_000)), false)
  assert.equal(sameFrame(null, a), false)
})

test('a dead feed marks every leg stale; a contract with no quote has no price and no gross MTM', () => {
  const dead = liveFrame(BASE, r2Quotes({}, { feedAlive: false }), TM, R2_NOW)
  assert.ok(dead.legs.every((l) => l.stale))
  assert.equal(dead.feedAlive, false)
  const gone = liveFrame(BASE, r2Quotes({ [T3000]: null }), TM, R2_NOW).legs.find((l) => l.key === OCT3000.key)!
  assert.deepEqual([gone.ltp, gone.grossMtm, gone.stale], [null, null, true])
})

test('outside the session the frame says closed (the stream then only pings)', () => {
  assert.equal(liveFrame(BASE, r2Quotes(), TM, Date.UTC(2026, 9, 18, 6)).closed, true)   // Sunday
})

test('the MTM block is re-priced each tick: a leg moving by Δ moves Current MTM total by qty × Δ', () => {
  const book = priceBook('asha', 'TCS', LEGS, r2Market())
  const held = new Map(book.legs.map((l) => [eodKey(l.leg), l.ltp]))
  const mtm: MtmInputs = {
    legs: book.legs, unmatchedKeys: book.unmatchedKeys, todayTrades: [], earlierTrades: [OPENED],
    ltpOf: (c: EodContract) => held.get(eodKey(c)) ?? null, closeOf: () => 52, eodMissing: [], bse: false,
    lotSizeOf: (instrument) => (instrument === 'share' ? 1 : 175), rates: SEED_RATES, trader: 'asha', pastSession: null, nowMs: R2_NOW,
  }
  const base = { ...BASE, mtm }
  const q = r2Quotes()
  const p = q.quote(T3000)!.price
  const before = liveFrame(base, q, TM, R2_NOW).mtmTotal
  const after = liveFrame(base, r2Quotes({ [T3000]: p + 2 }), TM, R2_NOW).mtmTotal
  assert.ok(before !== null && after !== null, `${before} ${after}`)
  assert.ok(Math.abs((after - before) - (-175 * 2)) < 1e-6, `${after} − ${before}`)
})

// ---- the day begins at 09:15 IST (G5): the frame decides it at its own moment, not the base's ----------------------

const IST = (iso: string): number => Date.parse(`${iso}+05:30`)

/** The block's inputs as the base read them (the short Oct 3000 CE, sold on Friday at 50, carried today). */
function blockInputs(nowMs: number): MtmInputs {
  const book = priceBook('asha', 'TCS', LEGS, r2Market())
  const held = new Map(book.legs.map((l) => [eodKey(l.leg), l.ltp]))
  return {
    legs: book.legs, unmatchedKeys: book.unmatchedKeys, todayTrades: [], earlierTrades: [OPENED],
    ltpOf: (c: EodContract) => held.get(eodKey(c)) ?? null, closeOf: () => 52, eodMissing: [], bse: false,
    lotSizeOf: (instrument) => (instrument === 'share' ? 1 : 175), rates: SEED_RATES, trader: 'asha', pastSession: null, nowMs,
  }
}

test('before the open the frame carries no day figure and says why; the first second after it has them', () => {
  // the base was read at 09:14:55, the frame is cut at 09:14:59 and at 09:15:01: it is the frame's moment that counts
  const base = { ...BASE, mtm: blockInputs(IST('2026-10-19T09:14:55')) }
  const before = liveFrame(base, r2Quotes(), TM, IST('2026-10-19T09:14:59'))
  assert.deepEqual([before.mtmToday, before.mtmTotal, before.mtmCharges, before.mtmReason], [null, null, null, 'market opens 09:15'])
  const after = liveFrame(base, r2Quotes(), TM, IST('2026-10-19T09:15:01'))
  assert.deepEqual([after.mtmReason, after.mtmCharges], [null, 0])   // no fill today: no charges of today's
  assert.ok(after.mtmToday !== null && after.mtmTotal !== null, JSON.stringify(after))
  // Day MTM: every priced leg carried against yesterday's close (52), no charges of today's fills (it has none)
  const carried = after.legs.reduce((s, l) => s + (l.ltp === null ? 0 : (LEGS.find((x) => x.key === l.key)?.qty ?? 0) * (l.ltp - 52)), 0)
  assert.ok(Math.abs(after.mtmTotal - carried) < 1e-6, `${after.mtmTotal} vs ${carried}`)
  assert.equal(sameFrame(before, after), false)   // the stream sends the change the second the day begins
})

test('on a closed day the frame carries no day figure either', () => {
  const sat = IST('2026-10-24T12:00:00')
  const f = liveFrame({ ...BASE, mtm: blockInputs(sat) }, r2Quotes(), TM, sat)
  assert.deepEqual([f.mtmToday, f.mtmTotal, f.mtmReason], [null, null, 'market closed today'])
})

// ---- P&L: the series net at the frame's prices (spec 2026-10-23 R2) ------------------------------------------------

/** The Oct 3000 CE sold on Friday (still open), and an Oct 2900 PE bought and sold back the same day (booked +1,750). */
const SERIES: SeriesBase = {
  trades: [
    OPENED,
    { ...OPENED, tradeNo: 'T2', orderNo: 'O2', strike: 2900, optType: 'PE', side: 'Buy', price: 30, seq: 2 },
    { ...OPENED, tradeNo: 'T3', orderNo: 'O3', strike: 2900, optType: 'PE', side: 'Sell', price: 40, seq: 3 },
  ],
  balance: null, historyFrom: '2026-10-01', rates: SEED_RATES,
}
/** The legs the master places (the Oct 3050 CE has no token, so no LTP). */
const PRICED = LEGS.filter((l) => matchLeg(TM, l) !== null)
const priced = (legs: readonly TraderLeg[] = PRICED): LiveBase => ({ ...BASE, legs, tokens: new Map(legs.map((l) => [l.key, matchLeg(TM, l)] as const)), series: SERIES })

test("the frame's P&L is the views' seriesTotal at the same LTPs, its parts with it", () => {
  const f = liveFrame(priced(), r2Quotes(), TM, R2_NOW)
  const view = analysisSeries(priceBook('asha', 'TCS', PRICED, r2Market()), PRICED, SERIES, TM).total
  assert.ok(view.net !== null && view.booked !== 0 && view.charges > 0, JSON.stringify(view))
  assert.deepEqual([f.seriesNet, f.seriesOpen, f.seriesBooked, f.seriesCharges], [view.net, view.open, view.booked, view.charges])
  // a tick moves P&L by the leg's move, as it moves the leg
  const p = r2Quotes().quote(T3000)!.price
  const moved = liveFrame(priced(), r2Quotes({ [T3000]: p + 2 }), TM, R2_NOW)
  assert.ok(Math.abs((moved.seriesNet as number) - (f.seriesNet as number) - (-175 * 2)) < 1e-6)
  assert.equal(sameFrame(f, moved), false)
})

test('an open leg of a live series with no LTP: P&L and its open part are null; booked and charges stay', () => {
  const f = liveFrame(priced(), r2Quotes({ [T3000]: null }), TM, R2_NOW)
  assert.deepEqual([f.seriesNet, f.seriesOpen], [null, null])
  assert.ok(typeof f.seriesBooked === 'number' && typeof f.seriesCharges === 'number')
  // the unplaced Oct 3050 CE has no LTP either
  assert.equal(liveFrame(priced(LEGS), r2Quotes(), TM, R2_NOW).seriesNet, null)
})

test('no series reader: the frame carries no P&L fields at all', () => {
  const f = liveFrame(BASE, r2Quotes(), TM, R2_NOW)
  for (const k of ['seriesNet', 'seriesOpen', 'seriesBooked', 'seriesCharges']) assert.equal(k in f, false, k)
})

test("each tick adds only the open legs to the base's closed part, kept per series object: the same as seriesPnl, tick after tick", () => {
  const base = priced()
  const today = '2026-10-19'
  const closed = liveSeriesClosed({ ...base, series: SERIES }, TM, today)
  assert.equal(liveSeriesClosed({ ...base, series: SERIES }, TM, today), closed, 'worked out once per series object')
  assert.notEqual(liveSeriesClosed({ ...base, series: { ...SERIES } }, TM, today), closed, 'a new base reads again')
  const p = r2Quotes().quote(T3000)!.price
  for (const move of [0, 2, -3.5, 11]) {
    const q = r2Quotes({ [T3000]: p + move })
    const f = liveFrame(base, q, TM, R2_NOW)
    const gross = new Map(f.legs.map((l) => [l.key, l.grossMtm] as const))
    const fresh = seriesPnl({
      ...SERIES, trader: 'asha', stock: 'TCS', today,
      legs: PRICED.map((l) => ({ key: l.key, instrument: l.instrument, expiry: l.expiry, strike: l.strike, optType: l.optType, mtm: gross.get(l.key) ?? null })),
      lotSizeOf: (instrument, expiry) => (instrument === 'share' ? 1 : TM.options.chain('TCS', expiry)?.lotSize ?? null),
    }).total
    assert.deepEqual([f.seriesNet, f.seriesOpen, f.seriesBooked, f.seriesCharges], [fresh.net, fresh.open, fresh.booked, fresh.charges], `move ${move}`)
  }
})

test('a book with no live series (shares only) gets no P&L fields, not a 0', () => {
  const shares = LEGS.filter((l) => l.instrument === 'share')
  const f = liveFrame({ ...priced(shares), series: { ...SERIES, trades: [] } }, r2Quotes(), TM, R2_NOW)
  for (const k of ['seriesNet', 'seriesOpen', 'seriesBooked', 'seriesCharges']) assert.equal(k in f, false, k)
})

test("a series that cannot be worked out: no P&L fields, and the log says so once per base, counts only", () => {
  const said: { msg: string; ctx: Record<string, unknown> | undefined }[] = []
  const broken = { ...priced(), series: { ...SERIES, balance: { positions: null } as unknown as SeriesBase['balance'] }, log: (msg: string, ctx?: Record<string, unknown>) => { said.push({ msg, ctx }) } }
  for (let i = 0; i < 3; i++) assert.equal('seriesNet' in liveFrame(broken, r2Quotes(), TM, R2_NOW + i * 1_000), false)
  assert.equal(said.length, 1)
  assert.deepEqual(Object.keys(said[0]!.ctx ?? {}).sort(), ['error', 'legs', 'stock', 'trader', 'trades'])
  assert.equal(JSON.stringify(said).includes(OCT3000.clientCode), false)
  liveFrame({ ...broken }, r2Quotes(), TM, R2_NOW)   // a new base: said again
  assert.equal(said.length, 2)
})
