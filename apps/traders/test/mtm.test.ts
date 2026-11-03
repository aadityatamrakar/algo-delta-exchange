import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eodKey, parseCmBhavcopy, parseFoBhavcopy, type EodContract } from '@algomaker/span'
import { SEED_RATES, chargesFor } from '../src/analytics/charges.ts'
import { EodStore } from '../src/analytics/eod.ts'
import {
  CLOSED_DAY_REASON, PRE_OPEN_REASON, dayLegs, dayReasonAt, mtmBlock, mtmInputsOf, mtmOf, mtmTradesFilters, openCycleTrades, type MtmInputs,
} from '../src/analytics/mtm.ts'
import { SnapshotCache, priceBook } from '../src/analytics/snapshot.ts'
import type { MtmBlock, MtmCols } from '../src/analytics/wire.ts'
import { TradersDb } from '../src/db.ts'
import type { TradersDeps } from '../src/deps.ts'
import { legsFromTrades, ledgerTradeOf, type OpeningBalance } from '../src/ingest/ledger.ts'
import { buildTradersMaster, type TradersMaster } from '../src/market/master.ts'
import { isOpenLeg, legKey, type TraderLeg, type TraderTrade } from '../src/types.ts'
import { L1, L4, L6, R2_NOV, R2_NOW, R2_OCT, TM, optLeg, optToken, r2Legs, r2Market, r2Master, shareLeg } from './fixtures/r2-book.ts'

function close(a: number | null, b: number, eps: number): void {
  assert.ok(typeof a === 'number' && Math.abs(a - b) <= eps, `${a} vs ${b} (eps ${eps})`)
}

// MTM fixture: legs CE 3000 Oct −350 @47.5 (ltp 40, yesterday's close 44) and FUT Oct +175 @3000 (ltp 3010, close 3005) —
// closeOf over Task 5's eod fixture values; today: Sell 175 CE @45 order A1; earlier (2026-10-16, open cycle):
// Sell 175 CE @50 order P1, Buy 175 FUT @3000 order P2; SEED_RATES. Worked out at R2_NOW, Mon 19 Oct 10:00 IST: the day has begun.
const TODAY = '2026-10-19'
const IST = (iso: string): number => Date.parse(`${iso}+05:30`)
const EOD_FIXTURES = fileURLToPath(new URL('../../../packages/span/test/fixtures/eod', import.meta.url))
const FO_NAME = 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'
const CM_NAME = 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv'
const EOD = new Map([
  ...parseFoBhavcopy(readFileSync(join(EOD_FIXTURES, 'fo-udiff.csv'), 'utf8')),
  ...parseCmBhavcopy(readFileSync(join(EOD_FIXTURES, 'cm-udiff.csv'), 'utf8')),
].map((r) => [eodKey(r), r.close]))
const closeOf = (c: EodContract): number | null => EOD.get(eodKey(c)) ?? null

const CE_LEG = optLeg(R2_OCT, 3000, 'CE', -350, 47.5)
const FUT_LEG = r2Legs()[3] as TraderLeg
const CE_QUOTE = { [optToken(R2_OCT, 3000, 'CE')]: 40 }
const BOOK = priceBook('asha', 'TCS', [CE_LEG, FUT_LEG], r2Market({ quotes: CE_QUOTE }))
const LIVE = new Map(BOOK.legs.map((l) => [eodKey(l.leg), l.ltp]))
const ltpOf = (c: EodContract): number | null => LIVE.get(eodKey(c)) ?? null

type C = Pick<TraderTrade, 'instrument' | 'expiry' | 'strike' | 'optType'>
const CE: C = { instrument: 'option', expiry: R2_OCT, strike: 3000, optType: 'CE' }
const PE: C = { instrument: 'option', expiry: R2_OCT, strike: 3000, optType: 'PE' }
const PE2900: C = { instrument: 'option', expiry: R2_OCT, strike: 2900, optType: 'PE' }
const FUT: C = { instrument: 'future', expiry: R2_OCT, strike: null, optType: null }
let seq = 0
function trade(day: string, side: 'Buy' | 'Sell', qty: number, price: number, orderNo: string, c: C = CE, clientCode = 'C1'): TraderTrade {
  seq++
  return {
    trader: 'asha', tradeNo: `T${seq}`, orderNo, clientCode, stock: 'TCS', ...c, side, qty, price,
    time: Date.parse(`${day}T10:00:00+05:30`) + seq, day, seq,
  }
}
const A1 = trade(TODAY, 'Sell', 175, 45, 'A1')
const P1 = trade('2026-10-16', 'Sell', 175, 50, 'P1')
const P2 = trade('2026-10-16', 'Buy', 175, 3000, 'P2', FUT)

const INPUTS: MtmInputs = {
  legs: BOOK.legs, unmatchedKeys: [], todayTrades: [A1], earlierTrades: [P1, P2], ltpOf, closeOf, eodMissing: [], bse: false,
  lotSizeOf: (instrument) => (instrument === 'share' ? 1 : 175), rates: SEED_RATES, trader: 'asha', pastSession: null, nowMs: R2_NOW,
}
const m = mtmBlock(INPUTS)
const NOTES = [
  'Previous = the carried legs\' move today, yesterday\'s close to LTP (NSE end-of-day CLOSE, not settlement — Phase 0 Q3), not their P&L since entry; Today = today\'s trades, fill to LTP',
  'Day MTM = Previous + Today - the charges on today\'s fills; the charges on the open cycle before today are not in it (the series P&L has them)',
  'Projected = Day MTM - square-off cost',
  'Pay In Out = premium received - paid on today\'s option trades (our reading; Phase 0 Q3)',
  'CF balance = net premium of the open option legs at net price (our reading; Phase 0 Q3)',
]
const BSE_NOTE = "TCS trades on BSE; NSE's end-of-day files do not cover it — carried legs' figure unknown"
const MANUAL_NOTE = 'Manual legs count as carried from before today'
const fileNote = (name: string) => `NSE end-of-day file ${name} for 16 Oct is missing — carried legs' figure unknown`

/** Every number in the block is finite, or null where the wire allows it. */
function allFinite(b: MtmBlock): void {
  for (const row of [b.gross, b.expense, b.current]) {
    for (const v of [row.previous, row.today, row.total]) assert.ok(v === null || Number.isFinite(v), JSON.stringify(b))
  }
  for (const v of [b.squareOff, b.payInOut, b.cfBalance]) assert.ok(Number.isFinite(v), JSON.stringify(b))
  assert.ok(b.projected === null || Number.isFinite(b.projected))
}

test('the MTM block: Previous / Today / Total', () => {
  // Day MTM (current.total) = gross previous + gross today − the charges of TODAY's fills (34.739…): the open cycle's
  // 81.414… is no part of it (spec G5), and Expense Previous is not a figure of the day view
  const want = { gross: [1575, 875, 2450], expense: [null, 34.73945525, 34.73945525], current: [1575, 840.26054475, 2415.26054475] } as const
  for (const row of ['gross', 'expense', 'current'] as const) {
    ;(['previous', 'today', 'total'] as const).forEach((c, k) => {
      const w = want[row][k] as number | null
      if (w === null) assert.equal(m[row][c], null, `${row}.${c}`)
      else close(m[row][c], w, 1e-9)
    })
  }
  close(m.squareOff, 170.1481155, 1e-9); close(m.projected, 2415.26054475 - 170.1481155, 1e-9); assert.deepEqual([m.payInOut, m.cfBalance], [7875, 16625])
  close(m.openCycleCharges, 81.4140225, 1e-9)
  assert.deepEqual([m.dayReason, m.partial, m.ratesConfirmed, m.notes], [null, [], false, NOTES])
  allFinite(m)
})

test('the day base reproduces Gross MTM total at LTP', () => {
  const d = dayLegs(INPUTS)!; assert.deepEqual([d.legs.map((l) => l.entry), d.offset], [[44.5, 3005], 0])
  assert.deepEqual(d.legs.map((l) => [l.id, l.qty, l.iv]), BOOK.legs.map((l) => [l.payoff.id, l.payoff.qty, l.payoff.iv]))
  const atLtp = d.legs.reduce((s, l, k) => s + l.qty * (BOOK.legs[k]!.ltp! - l.entry), d.offset)
  close(atLtp, m.gross.total!, 1e-9)
})

test('a contract closed today: realised in the offset, split across Previous and Today', () => {
  // + PE carried +175 (close 30, ltp 31), sold today 175 @33: previous += 175, today += 350, offset = 525
  const isPe = (c: EodContract) => eodKey(c) === eodKey({ stock: 'TCS', ...PE2900 })
  const sold = trade(TODAY, 'Sell', 175, 33, 'A2', PE2900)
  const i: MtmInputs = {
    ...INPUTS, todayTrades: [A1, sold],
    ltpOf: (c) => (isPe(c) ? 31 : ltpOf(c)), closeOf: (c) => (isPe(c) ? 30 : closeOf(c)),
  }
  const x = mtmBlock(i)
  close(x.gross.previous, 1575 + 175, 1e-9); close(x.gross.today, 875 + 350, 1e-9); close(x.gross.total, 2450 + 525, 1e-9)
  close(x.expense.today, chargesFor([
    { instrument: 'option', side: 'Sell', qty: 175, price: 45, orderNo: 'A1', lotSize: 175 },
    { instrument: 'option', side: 'Sell', qty: 175, price: 33, orderNo: 'A2', lotSize: 175 },
  ], SEED_RATES, 'asha').total, 1e-9)
  close(x.squareOff, m.squareOff, 1e-9)                       // nothing left to square off on the PE
  assert.deepEqual([x.payInOut, x.cfBalance, x.partial], [7875 + 5775, 16625, []])
  const d = dayLegs(i)!
  assert.deepEqual([d.legs.map((l) => l.entry), d.offset], [[44.5, 3005], 525])
  close(d.legs.reduce((s, l, k) => s + l.qty * (BOOK.legs[k]!.ltp! - l.entry), d.offset), x.gross.total!, 1e-9)
  // the realised P&L needs no LTP: the day base is the same without one
  assert.deepEqual(dayLegs({ ...i, ltpOf: (c) => (isPe(c) ? null : ltpOf(c)) }), d)
  assert.equal(dayLegs({ ...i, closeOf: (c) => (isPe(c) ? null : closeOf(c)) }), null)
  // Ruling (fix round 1): the open cycle's charges cover the PE too — its cycle as at the start of today — but not a
  // contract outside the block (the Nov CE: no open leg, not traded today); and (G5) they are in no day figure
  const peBought = trade('2026-10-16', 'Buy', 175, 28, 'P3', PE2900)
  const outside = trade('2026-10-16', 'Buy', 175, 90, 'P4', { instrument: 'option', expiry: R2_NOV, strike: 3000, optType: 'CE' })
  const withPe = mtmBlock({ ...i, earlierTrades: [P1, P2, peBought, outside] })
  close(withPe.openCycleCharges, chargesFor([
    { instrument: 'option', side: 'Sell', qty: 175, price: 50, orderNo: 'P1', lotSize: 175 },
    { instrument: 'future', side: 'Buy', qty: 175, price: 3000, orderNo: 'P2', lotSize: 175 },
    { instrument: 'option', side: 'Buy', qty: 175, price: 28, orderNo: 'P3', lotSize: 175 },
  ], SEED_RATES, 'asha').total, 1e-9)
  assert.ok(withPe.openCycleCharges > x.openCycleCharges)
  assert.deepEqual([withPe.current, withPe.expense], [x.current, x.expense])
})

test('a contract flat now needs no LTP: its realised gross stands, it is not partial (final fix M1)', () => {
  // the review's probe: Oct 2900 PE bought 175 @20 and sold 175 @30 today, no quote — +1750, whatever the LTP
  const isPe = (c: EodContract) => eodKey(c) === eodKey({ stock: 'TCS', ...PE2900 })
  const noQuote = (c: EodContract) => (isPe(c) ? null : ltpOf(c))
  const roundTrip = [trade(TODAY, 'Buy', 175, 20, 'A6', PE2900), trade(TODAY, 'Sell', 175, 30, 'A7', PE2900)]
  for (const quote of [ltpOf, noQuote]) {
    const x = mtmBlock({ ...INPUTS, todayTrades: [A1, ...roundTrip], ltpOf: quote })
    close(x.gross.today, 875 + 1750, 1e-9); close(x.gross.previous, 1575, 1e-9); close(x.gross.total, 2450 + 1750, 1e-9)
    assert.deepEqual(x.partial, [])
    allFinite(x)
  }
  // carried +175 (close 30) and sold today 175 @33 with no quote: 525 realised; the last fill stands in for the LTP
  const sold = trade(TODAY, 'Sell', 175, 33, 'A8', PE2900)
  const carried: MtmInputs = { ...INPUTS, todayTrades: [A1, sold], ltpOf: noQuote, closeOf: (c) => (isPe(c) ? 30 : closeOf(c)) }
  const y = mtmBlock(carried)
  close(y.gross.previous, 1575 + 175 * (33 - 30), 1e-9); close(y.gross.today, 875, 1e-9); close(y.gross.total, 2450 + 525, 1e-9)
  assert.deepEqual(y.partial, [])
  // with no close it is still named: the carried quantity's base is unknown
  assert.deepEqual(mtmBlock({ ...carried, closeOf: (c) => (isPe(c) ? null : closeOf(c)) }).partial, [legKey({ clientCode: 'C1', stock: 'TCS', ...PE2900 })])
  // the grid's offset never needed one
  assert.equal(dayLegs(carried)!.offset, 525)
})

test('a contract opened today needs no close', () => {
  const bought = trade(TODAY, 'Buy', 175, 80, 'A3', { instrument: 'option', expiry: R2_NOV, strike: 3000, optType: 'CE' })
  const nov = priceBook('asha', 'TCS', [CE_LEG, FUT_LEG, optLeg(R2_NOV, 3000, 'CE', 175, 80)], r2Market({ quotes: CE_QUOTE }))
  const live = new Map(nov.legs.map((l) => [eodKey(l.leg), l.ltp]))
  const i: MtmInputs = { ...INPUTS, legs: nov.legs, todayTrades: [A1, bought], ltpOf: (c) => live.get(eodKey(c)) ?? null }
  const x = mtmBlock(i)
  close(x.gross.previous, 1575, 1e-9); close(x.gross.today, 875 + 175 * (95 - 80), 1e-9)
  assert.deepEqual(x.partial, [])
  assert.deepEqual(dayLegs(i)!.legs.map((l) => l.entry), [44.5, 3005, 80])
})

test('the open cycle starts after the last end-of-day flat, as R1’s ledger', () => {
  // CE: Sell 175 on 10-14, Buy 175 on 10-14 (flat at that day's end), Sell 175 on 10-16 → only the 10-16 trade is in openCycleTrades(…, '2026-10-19')
  // and Σ signed qty × price / net qty over the cycle (plus today's) equals legsFromTrades(null, trades.map(ledgerTradeOf)) avgPrice for every contract
  const ce16 = trade('2026-10-16', 'Sell', 175, 50, 'Q3')
  const fut = [trade('2026-10-15', 'Buy', 175, 2990, 'Q4', FUT), trade('2026-10-16', 'Sell', 175, 3000, 'Q5', FUT), trade('2026-10-16', 'Buy', 175, 3002, 'Q6', FUT)]
  const c2 = trade('2026-10-16', 'Buy', 175, 49, 'Q7', CE, 'c2')   // another client's leg; a lower-case code is the same leg as R1 reads it
  const trades: TraderTrade[] = [
    trade('2026-10-14', 'Sell', 175, 40, 'Q1'), trade('2026-10-14', 'Buy', 175, 42, 'Q2'), ce16,
    ...fut, c2,
    trade('2026-10-15', 'Buy', 175, 50, 'Q8', PE), trade(TODAY, 'Sell', 175, 52, 'Q9', PE),                    // PE: closed today
    trade('2026-09-20', 'Buy', 175, 2900, 'Q10', { instrument: 'future', expiry: '2026-09-29', strike: null, optType: null }),   // expired, never closed
    trade(TODAY, 'Sell', 175, 45, 'Q11'),
  ]
  const cycle = openCycleTrades([...trades].reverse(), TODAY)
  // Ruling (fix round 1): the cycle as at the START of today, so the PE closed today keeps its 10-15 trade Q8
  assert.deepEqual(cycle.map((t) => t.orderNo), ['Q4', 'Q8', 'Q3', 'Q5', 'Q6', 'Q7'])
  // only days before today are walked: today's trades neither join a cycle nor end one
  assert.deepEqual(openCycleTrades(trades.filter((t) => t.day < TODAY), TODAY), cycle)
  const today = trades.filter((t) => t.day === TODAY)
  const upper = (t: TraderTrade) => ({ ...t, clientCode: t.clientCode.toUpperCase() })
  const r1 = legsFromTrades(null, trades.map((t) => ledgerTradeOf(upper(t)))).filter((p) => isOpenLeg(p, TODAY))
  assert.equal(r1.length, 3)
  for (const p of r1) {
    const mine = [...cycle, ...today].filter((t) => legKey(upper(t)) === legKey(p))
    const q = mine.reduce((s, t) => s + (t.side === 'Buy' ? 1 : -1) * t.qty, 0)
    const v = mine.reduce((s, t) => s + (t.side === 'Buy' ? 1 : -1) * t.qty * t.price, 0)
    assert.equal(q, p.qty, legKey(p)); close(v / q, p.avgPrice, 1e-9)
  }
})

test('the open cycle with an opening balance: trades on or before its day are skipped, its positions count, as R1’s ledger', () => {
  const balance: OpeningBalance = {
    day: '2026-10-14',
    positions: [{ clientCode: 'C1', stock: 'TCS', ...CE, qty: -175, avgPrice: 40 }, { clientCode: 'C1', stock: 'TCS', ...FUT, qty: 175, avgPrice: 2990 }],
  }
  const trades = [
    trade('2026-10-13', 'Sell', 999, 1, 'B0'),                            // before the balance: skipped
    trade('2026-10-15', 'Buy', 175, 41, 'B1'),                            // CE flat at the end of 10-15
    trade('2026-10-16', 'Sell', 175, 50, 'B2'),
    trade('2026-10-16', 'Buy', 175, 3000, 'B3', FUT),                     // FUT: on top of the balance's 175
  ]
  assert.deepEqual(openCycleTrades(trades, TODAY, balance).map((t) => t.orderNo), ['B2', 'B3'])
  const r1 = legsFromTrades(balance, trades.map(ledgerTradeOf))
  assert.deepEqual(r1.map((p) => [p.instrument, p.qty, p.avgPrice]), [['option', -175, 50], ['future', 350, 2995]])
})

test('a leg without an LTP or close is named, not guessed', () => {
  /* FUT ltp null → gross.previous 700, partial names its key */
  const isFut = (c: EodContract) => c.instrument === 'future'
  const noFut = mtmBlock({ ...INPUTS, ltpOf: (c) => (isFut(c) ? null : ltpOf(c)) })
  close(noFut.gross.previous, 700, 1e-9); close(noFut.gross.today, 875, 1e-9); close(noFut.gross.total, 1575, 1e-9)
  assert.deepEqual(noFut.partial, [L4])
  close(noFut.squareOff, 29.823476, 1e-9)                    // only the CE is squared off: Buy 350 @40
  const noClose = mtmBlock({ ...INPUTS, closeOf: (c) => (c.instrument === 'option' ? null : closeOf(c)) })
  close(noClose.gross.previous, 875, 1e-9); close(noClose.gross.today, 875, 1e-9)
  assert.deepEqual(noClose.partial, [L1])
  assert.equal(dayLegs({ ...INPUTS, closeOf: (c) => (c.instrument === 'option' ? null : closeOf(c)) }), null)
  // a non-finite price is no price: named, and no NaN anywhere
  const bad = mtmBlock({ ...INPUTS, ltpOf: (c) => (isFut(c) ? Number.NaN : ltpOf(c)), closeOf: (c) => (isFut(c) ? closeOf(c) : Number.POSITIVE_INFINITY) })
  assert.deepEqual(bad.partial, [L1, L4])
  allFinite(bad)
})

test('yesterday\'s file missing: Previous MTM is unknown and says which file', () => {
  const x = mtmBlock({ ...INPUTS, eodMissing: ['BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'] })
  assert.deepEqual([x.gross.previous, x.gross.total, x.current.previous, x.current.total, x.projected, x.gross.today], [null, null, null, null, null, 875])
  assert.ok(x.notes.includes('NSE end-of-day file BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv for 16 Oct is missing — carried legs\' figure unknown'))
  assert.equal(dayLegs({ ...INPUTS, closeOf: () => null }), null)
  // expenses, today's columns and the square-off are still known
  assert.deepEqual([x.expense, x.squareOff, x.payInOut, x.cfBalance, x.partial], [m.expense, m.squareOff, m.payInOut, m.cfBalance, []])
  close(x.current.today, m.current.today!, 1e-12)
  assert.deepEqual(x.notes, ['NSE end-of-day file BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv for 16 Oct is missing — carried legs\' figure unknown', ...NOTES])
  assert.equal(dayLegs({ ...INPUTS, eodMissing: [FO_NAME] }), null)
  allFinite(x)
})

test('a file that did not parse: the carried legs figure unknown, with its error', () => {
  // Ruling (fix round 1): the CM file is missing too, but this book carries no share, so it is not named
  const x = mtmBlock({ ...INPUTS, eodMissing: [`${FO_NAME}: no row could be read — first bad row: row 2: unreadable close ''`, CM_NAME] })
  assert.equal(x.gross.previous, null)
  assert.deepEqual(x.notes, [
    `NSE end-of-day file ${FO_NAME} for 16 Oct could not be read (no row could be read — first bad row: row 2: unreadable close '') — carried legs' figure unknown`,
    ...NOTES,
  ])
})

test('a missing file the book does not need leaves Previous known (Ruling, fix round 1)', () => {
  // an F&O-only book: the CM file does not matter
  const fo = mtmBlock({ ...INPUTS, eodMissing: [CM_NAME] })
  assert.deepEqual(fo, m)
  assert.deepEqual(dayLegs({ ...INPUTS, eodMissing: [CM_NAME] }), dayLegs(INPUTS))
  // a share-only book (a manual leg: carried): the F&O file does not matter, the CM file does
  const shares = priceBook('asha', 'TCS', [shareLeg(1000)], r2Market())
  const i: MtmInputs = { ...INPUTS, legs: shares.legs, todayTrades: [], earlierTrades: [], ltpOf: (c) => (c.instrument === 'share' ? 3000 : null) }
  const noFo = mtmBlock({ ...i, eodMissing: [FO_NAME] })
  close(noFo.gross.previous, 1000 * (3000 - 2990), 1e-9)
  assert.deepEqual(noFo.notes, [MANUAL_NOTE, ...NOTES])
  assert.deepEqual(dayLegs({ ...i, eodMissing: [FO_NAME] })!.legs.map((l) => l.entry), [2990])
  const noCm = mtmBlock({ ...i, eodMissing: [`${CM_NAME}: no row could be read`] })
  assert.deepEqual([noCm.gross.previous, noCm.gross.total, noCm.projected], [null, null, null])
  assert.deepEqual(noCm.notes, [`NSE end-of-day file ${CM_NAME} for 16 Oct could not be read (no row could be read) — carried legs' figure unknown`, MANUAL_NOTE, ...NOTES])
  assert.equal(dayLegs({ ...i, eodMissing: [CM_NAME] }), null)
  // a book that carries nothing (every leg opened today) needs neither file
  const fresh = mtmBlock({ ...INPUTS, legs: [BOOK.legs[0]!], todayTrades: [{ ...A1, qty: 350 }], eodMissing: [FO_NAME, CM_NAME] })
  close(fresh.gross.previous, 0, 0); assert.deepEqual(fresh.notes, NOTES)
})

test('manual legs count as carried from before today, and say so (Ruling, fix round 1)', () => {
  const book = priceBook('asha', 'TCS', [CE_LEG, FUT_LEG, shareLeg(1000)], r2Market({ quotes: CE_QUOTE }))
  const live = new Map(book.legs.map((l) => [eodKey(l.leg), l.ltp]))
  const i: MtmInputs = { ...INPUTS, legs: book.legs, ltpOf: (c) => live.get(eodKey(c)) ?? null }
  const x = mtmBlock(i)
  close(x.gross.previous, 1575 + 1000 * (3000 - 2990), 1e-9)
  assert.deepEqual(x.notes, [MANUAL_NOTE, ...NOTES])
  assert.deepEqual(mtmBlock({ ...i, eodMissing: [CM_NAME] }).notes, [fileNote(CM_NAME), MANUAL_NOTE, ...NOTES])
  assert.deepEqual(dayLegs(i)!.legs.map((l) => l.entry), [44.5, 3005, 2990])
})

test('an unmatched leg is left out of everything and named, never treated as closed today (Ruling, fix round 1)', () => {
  const book = priceBook('asha', 'TCS', [CE_LEG, FUT_LEG, r2Legs()[5] as TraderLeg], r2Market({ quotes: CE_QUOTE }))
  assert.deepEqual(book.unmatchedKeys, [L6])
  const C3050: C = { instrument: 'option', expiry: R2_OCT, strike: 3050, optType: 'CE' }
  const i: MtmInputs = {
    ...INPUTS, legs: book.legs, unmatchedKeys: book.unmatchedKeys,
    todayTrades: [A1, trade(TODAY, 'Sell', 175, 22, 'A6', C3050)], earlierTrades: [P1, P2, trade('2026-10-16', 'Buy', 175, 18, 'P5', C3050)],
    ltpOf: (c) => (c.strike === 3050 ? 21 : ltpOf(c)), closeOf: (c) => (c.strike === 3050 ? 19 : closeOf(c)),
  }
  const x = mtmBlock(i)
  assert.deepEqual([x.gross, x.expense, x.current, x.squareOff, x.projected, x.payInOut, x.cfBalance], [m.gross, m.expense, m.current, m.squareOff, m.projected, m.payInOut, m.cfBalance])
  assert.deepEqual(x.partial, [L6])
  assert.deepEqual(dayLegs(i), dayLegs(INPUTS))                // no offset from the 3050 CE
  assert.deepEqual(mtmBlock({ ...i, todayTrades: [A1], earlierTrades: [P1, P2] }).partial, [L6])   // named with no trade today too
})

test('a trade with no usable price or quantity is skipped and its contract named; nothing is NaN (fix round 1)', () => {
  const ZK = 'C9|option|TCS|2026-10-27|3000|CE'
  const zeroLeg = { ...BOOK.legs[0]!, leg: { ...CE_LEG, clientCode: 'C9', key: ZK, qty: 0 }, payoff: { ...BOOK.legs[0]!.payoff, id: ZK, qty: 0 } }
  const i: MtmInputs = {
    ...INPUTS, legs: [...BOOK.legs, zeroLeg],
    todayTrades: [A1, trade(TODAY, 'Sell', 175, Number.NaN, 'A7'), trade(TODAY, 'Buy', Number.NaN, 3001, 'A8', FUT)],
    earlierTrades: [P1, P2, trade('2026-10-16', 'Buy', 175, Number.NaN, 'P6', FUT), trade('2026-10-16', 'Buy', 0, 3000, 'P7', FUT)],
  }
  const x = mtmBlock(i)
  allFinite(x)
  assert.deepEqual(x.partial, [L1, L4])
  assert.deepEqual([x.gross.previous, x.gross.today], [0, 0])   // both contracts' gross is unknown: left out
  assert.deepEqual([x.openCycleCharges, x.expense.today, x.payInOut], [m.openCycleCharges, m.expense.today, m.payInOut])
  close(x.squareOff, m.squareOff, 1e-9)                         // the qty-0 leg squares off nothing
  assert.equal(dayLegs(i), null)                                // a day base with an unknown fill is unknown
  // a qty-0 leg alone: finite, no division by zero, nothing squared off
  const z = { ...INPUTS, legs: [...BOOK.legs, zeroLeg] }
  allFinite(mtmBlock(z))
  const d = dayLegs(z)!
  assert.deepEqual([d.legs.map((l) => l.entry), d.offset], [[44.5, 3005, 47.5], 0])
  for (const l of d.legs) assert.ok(Number.isFinite(l.entry))
})

test('a BSE underlying: the carried legs figure unknown, with the sentence', () => {
  assert.ok(mtmBlock({ ...INPUTS, bse: true }).notes.includes("TCS trades on BSE; NSE's end-of-day files do not cover it — carried legs' figure unknown"))
  const x = mtmBlock({ ...INPUTS, bse: true, eodMissing: [FO_NAME] })
  assert.deepEqual([x.gross.previous, x.gross.total, x.current.previous, x.current.total, x.projected], [null, null, null, null, null])
  assert.deepEqual(x.notes, [BSE_NOTE, ...NOTES])             // NSE's files say nothing about a BSE book, present or not
  assert.equal(dayLegs({ ...INPUTS, bse: true }), null)
})

test('rates the admin has confirmed', () => {
  assert.equal(mtmBlock({ ...INPUTS, rates: { ...SEED_RATES, confirmedBy: 'admin', confirmedAt: 1 } }).ratesConfirmed, true)
})

// ---- the day (G5): it begins at 09:15 IST, and bears its own charges only ------------------------------

const OPEN = IST('2026-10-19T09:15:00')
const NO_DAY: MtmCols = { previous: null, today: null, total: null }

test('before the open every day figure is null with its reason, whatever the LTP (G5)', () => {
  // the LTPs are yesterday's last ticks (CE 40 against a close of 44, FUT 3010 against 3005): in session that is +1,575
  // from the carried legs; before the open it is basis noise, not P&L
  assert.equal(m.gross.previous, 1575)
  for (const nowMs of [IST('2026-10-19T00:00:00'), IST('2026-10-19T08:30:00'), OPEN - 1]) {
    const x = mtmBlock({ ...INPUTS, nowMs })
    assert.deepEqual([x.gross, x.expense, x.current, x.projected, x.dayReason], [NO_DAY, NO_DAY, NO_DAY, null, PRE_OPEN_REASON], String(nowMs))
    // what is not a day figure is not lost: the square-off, Pay In Out, the CF balance and the cycle's charges
    assert.deepEqual([x.squareOff, x.payInOut, x.cfBalance, x.openCycleCharges, x.partial], [m.squareOff, m.payInOut, m.cfBalance, m.openCycleCharges, []])
    assert.deepEqual(x.notes, ['Day MTM is not shown — market opens 09:15', ...NOTES])
    allFinite(x)
  }
  // a contract with no LTP or close is not blamed for a figure that is not being worked out
  const bare = mtmBlock({ ...INPUTS, nowMs: OPEN - 1, ltpOf: () => null, closeOf: () => null })
  assert.deepEqual([bare.partial, bare.gross, bare.dayReason], [[], NO_DAY, PRE_OPEN_REASON])
  // nor is an unmatched leg or a trade with no usable price: "leaves out N" would be said of a figure that is not there;
  // the same inputs after the open name both
  const book = priceBook('asha', 'TCS', [CE_LEG, FUT_LEG, r2Legs()[5] as TraderLeg], r2Market({ quotes: CE_QUOTE }))
  const flawed = { ...INPUTS, legs: book.legs, unmatchedKeys: book.unmatchedKeys, todayTrades: [A1, trade(TODAY, 'Sell', 175, Number.NaN, 'A9', FUT)] }
  assert.deepEqual(mtmBlock({ ...flawed, nowMs: OPEN - 1 }).partial, [])
  assert.deepEqual(mtmBlock(flawed).partial, [L4, L6])
  // the Scenario grid's day base is a what-if, not a day figure: it is the same
  assert.deepEqual(dayLegs({ ...INPUTS, nowMs: OPEN - 1 }), dayLegs(INPUTS))
})

test('the first moment of the session has the numbers, and they stay to midnight (G5)', () => {
  assert.equal(dayReasonAt(OPEN - 1, null), PRE_OPEN_REASON)
  assert.equal(dayReasonAt(OPEN, null), null)
  for (const at of ['2026-10-19T09:15:00', '2026-10-19T09:15:01', '2026-10-19T15:39:59', '2026-10-19T15:41:00', '2026-10-19T23:59:59']) {
    assert.deepEqual(mtmBlock({ ...INPUTS, nowMs: IST(at) }), m, at)   // after the 15:40 close it is the day's final move
  }
})

test('a closed day has no day figure: a weekend, a holiday, whatever session its reading carries (G5)', () => {
  // Sat 24 and Sun 25 Oct; Tue 20 Oct 2026 is Dussehra
  for (const at of ['2026-10-24T12:00:00', '2026-10-25T10:00:00', '2026-10-20T11:00:00']) {
    assert.equal(dayReasonAt(IST(at), null), CLOSED_DAY_REASON, at)
    const x = mtmBlock({ ...INPUTS, nowMs: IST(at) })
    assert.deepEqual([x.gross, x.current, x.projected, x.dayReason], [NO_DAY, NO_DAY, null, CLOSED_DAY_REASON], at)
  }
  // a reading of a past session says the same on a day that trades: the market is not open today
  assert.equal(dayReasonAt(R2_NOW, '2026-10-16'), CLOSED_DAY_REASON)
})

test('Day MTM bears the charges of today\'s fills only, never the open cycle\'s (G5)', () => {
  // Expense Previous used to be the whole cycle's charges (81.41 here) set against one day's move
  assert.ok(m.openCycleCharges > 0)
  assert.equal(m.expense.previous, null)
  close(m.current.total, m.gross.total! - m.expense.today!, 1e-12)
  close(m.expense.total, m.expense.today!, 1e-12)
  // a book that did nothing today: its Day MTM is its carried move alone, whatever the cycle cost
  const quiet = mtmBlock({ ...INPUTS, todayTrades: [] })
  close(quiet.gross.previous, 350 * (44 - 40) + 175 * (3010 - 3005), 1e-9)
  assert.deepEqual([quiet.gross.today, quiet.expense.today, quiet.expense.total], [0, 0, 0])
  assert.equal(quiet.current.total, quiet.gross.total)
  close(quiet.current.total, 2275, 1e-9)
  close(quiet.openCycleCharges, m.openCycleCharges, 1e-12)
  // and the cycle's charges change nothing else: the same block with no earlier trades is the same but for them
  assert.deepEqual(mtmBlock({ ...INPUTS, todayTrades: [], earlierTrades: [] }), { ...quiet, openCycleCharges: 0 })
})

// ---- mtmInputsOf / mtmOf: the book's trades, the end-of-day files and the live quotes ----------------

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

/** Task 5's end-of-day fixtures saved as `day`'s files, read at `now`. */
async function eodStore(day = '2026-10-16', now = R2_NOW): Promise<EodStore> {
  const root = mkdtempSync(join(tmpdir(), 'traders-mtm-'))
  roots.push(root)
  mkdirSync(join(root, day))
  const ymd = day.replaceAll('-', '')
  copyFileSync(join(EOD_FIXTURES, 'fo-udiff.csv'), join(root, day, FO_NAME.replace('20261016', ymd)))
  copyFileSync(join(EOD_FIXTURES, 'cm-udiff.csv'), join(root, day, CM_NAME.replace('20261016', ymd)))
  const s = new EodStore({ dir: root, now: () => now })
  await s.refresh()
  return s
}

/** Just what mtmOf reads, over a traders-trades that answers from `trades`. */
async function depsOf(o: {
  trades: readonly TraderTrade[]; legs: readonly TraderLeg[]; master?: TradersMaster; balance?: OpeningBalance
  now?: number; eodDay?: string
}) {
  const finds: unknown[] = []
  const db = new TradersDb({
    collection: (name: string) => {
      assert.equal(name, 'traders-trades')
      return {
        find: (f: { trader: string; stock: string; day: { $lte: string }; expiry: string | { $gte: string } }) => {
          finds.push(f)
          const expiry = (t: TraderTrade): boolean => (typeof f.expiry === 'string' ? t.expiry === f.expiry : t.expiry >= f.expiry.$gte)
          return { toArray: async () => o.trades.filter((t) => t.trader === f.trader && t.stock === f.stock && t.day <= f.day.$lte && expiry(t)) }
        },
      }
    },
  } as never)
  const now = o.now ?? R2_NOW
  const market = { ...r2Market({ quotes: CE_QUOTE, now }), ...(o.master === undefined ? {} : { master: () => o.master as TradersMaster }) }
  const d = {
    db, eod: await eodStore(o.eodDay, now), master: market.master, quotes: market.quotes, snapshots: new SnapshotCache(market),
    legs: { open: async (trader: string, stock: string) => o.legs.filter((l) => l.trader === trader && l.stock === stock), version: () => 0 },
    ledger: { balance: async () => o.balance ?? null },
    charges: { get: async () => SEED_RATES },
  } as unknown as TradersDeps
  return { d, finds }
}

const STORED = [P1, P2, A1, { ...A1, trader: 'bala', tradeNo: 'X1' }, { ...A1, stock: 'INFY', tradeNo: 'X2' }]

test('mtmOf: traders-trades, the end-of-day files and the live quotes give the same block', async () => {
  const { d, finds } = await depsOf({ trades: STORED, legs: [CE_LEG, FUT_LEG] })
  assert.deepEqual(await mtmOf(d, 'asha', 'TCS', R2_NOW), m)
  // the live contracts and the shares, two ranges on the { trader, stock, expiry } index: never an expired contract
  assert.deepEqual(finds, mtmTradesFilters('asha', 'TCS', TODAY))
  assert.deepEqual(finds, [
    { trader: 'asha', stock: 'TCS', expiry: { $gte: TODAY }, day: { $lte: TODAY } }, { trader: 'asha', stock: 'TCS', expiry: '', day: { $lte: TODAY } },
  ])
  const i = await mtmInputsOf(d, BOOK, R2_NOW)
  assert.deepEqual([i.todayTrades, i.earlierTrades, i.eodMissing, i.bse, i.trader, i.rates], [[A1], [P1, P2], [], false, 'asha', SEED_RATES])
  assert.deepEqual([i.lotSizeOf('option', R2_OCT), i.lotSizeOf('future', R2_OCT), i.lotSizeOf('share', ''), i.lotSizeOf('option', '2027-01-26')], [175, 175, 1, null])
  assert.deepEqual([i.closeOf(CE_LEG), i.closeOf(FUT_LEG), i.ltpOf(CE_LEG), i.ltpOf(FUT_LEG)], [44, 3005, 40, 3010])
})

test('mtmOf: a contract traded and closed today is priced off the live quote', async () => {
  // Oct 2900 PE (live 25): bought 175 @20 and sold 175 @24 today — +700 whatever the LTP
  const pe = [trade(TODAY, 'Buy', 175, 20, 'A4', PE2900), trade(TODAY, 'Sell', 175, 24, 'A5', PE2900)]
  const { d } = await depsOf({ trades: [...STORED, ...pe], legs: [CE_LEG, FUT_LEG] })
  const x = (await mtmOf(d, 'asha', 'TCS', R2_NOW))!
  close(x.gross.today, 875 + 700, 1e-9); close(x.gross.previous, 1575, 1e-9)
  assert.deepEqual(x.partial, [])
  assert.equal((await mtmInputsOf(d, BOOK, R2_NOW)).ltpOf({ stock: 'TCS', ...PE2900 }), 25)
})

test('mtmOf: the snapshot\'s unmatched legs reach the block', async () => {
  const { d } = await depsOf({ trades: STORED, legs: [CE_LEG, FUT_LEG, r2Legs()[5] as TraderLeg] })
  const x = (await mtmOf(d, 'asha', 'TCS', R2_NOW))!
  assert.deepEqual([x.partial, x.gross], [[L6], m.gross])
  const s = priceBook('asha', 'TCS', [CE_LEG, FUT_LEG, r2Legs()[5] as TraderLeg], r2Market({ quotes: CE_QUOTE }))
  assert.deepEqual((await mtmInputsOf(d, s, R2_NOW)).unmatchedKeys, [L6])
})

test('mtmOf on a Saturday: Friday\'s session is read, but no day figure is shown, with the reason (G5)', async () => {
  const SAT = IST('2026-10-24T12:00:00')
  const FRI = '2026-10-23'
  const friday = { ...A1, day: FRI, time: IST(`${FRI}T10:00:00`), tradeNo: 'F1' }
  const { d, finds } = await depsOf({ trades: [P1, P2, friday], legs: [CE_LEG, FUT_LEG], now: SAT, eodDay: '2026-10-22' })
  assert.equal(d.eod.status().day, '2026-10-22')
  const x = (await mtmOf(d, 'asha', 'TCS', SAT))!
  assert.deepEqual(finds, mtmTradesFilters('asha', 'TCS', FRI))
  // the LTP is Friday's last tick: a Friday move that is not today's, so Previous, Today, Total, Current and Projected are '—'
  assert.deepEqual([x.gross, x.expense, x.current, x.projected, x.dayReason], [NO_DAY, NO_DAY, NO_DAY, null, CLOSED_DAY_REASON])
  // what needs no day stays: Friday's trades give Pay In Out, the open legs the square-off and CF balance, the cycle its charges
  assert.deepEqual([x.squareOff, x.payInOut, x.cfBalance, x.partial, x.openCycleCharges], [m.squareOff, m.payInOut, m.cfBalance, [], m.openCycleCharges])
  assert.deepEqual(x.notes, ["Day MTM is not shown — market closed today (Pay In Out is of 23 Oct's session)", ...m.notes])
  const i = await mtmInputsOf(d, d.snapshots.get('asha', 'TCS', [CE_LEG, FUT_LEG], 0), SAT)
  assert.deepEqual([i.todayTrades, i.earlierTrades, i.pastSession, i.nowMs], [[friday], [P1, P2], FRI, SAT])
  assert.deepEqual(dayLegs(i)!.legs.map((l) => l.entry), [44.5, 3005])   // the Scenario grid's base is not a day figure
  // a trading day says nothing of the kind
  assert.equal(m.notes.some((n) => n.startsWith('Day MTM is not shown')), false)
})

test('mtmOf: no open book is null', async () => {
  const { d } = await depsOf({ trades: STORED, legs: [] })
  assert.equal(await mtmOf(d, 'asha', 'TCS', R2_NOW), null)
  const expired = { ...FUT_LEG, expiry: '2026-09-29' }
  assert.equal(await mtmOf((await depsOf({ trades: STORED, legs: [expired] })).d, 'asha', 'TCS', R2_NOW), null)
})

test('mtmInputsOf: an opening balance starts the cycle, as R1’s ledger', async () => {
  const balance: OpeningBalance = { day: '2026-10-16', positions: [{ clientCode: 'C1', stock: 'TCS', ...CE, qty: -175, avgPrice: 50 }, { clientCode: 'C1', stock: 'TCS', ...FUT, qty: 175, avgPrice: 3000 }] }
  const { d } = await depsOf({ trades: STORED, legs: [CE_LEG, FUT_LEG], balance })
  const i = await mtmInputsOf(d, BOOK, R2_NOW)
  assert.deepEqual([i.earlierTrades, i.todayTrades], [[], [A1]])
})

test('mtmOf: an underlying whose chain is on BFO says NSE does not cover it', async () => {
  const bse = buildTradersMaster(r2Master().map((r) => (r.exchange === 'NFO' ? { ...r, exchange: 'BFO' } : r)), 0)
  const { d } = await depsOf({ trades: STORED, legs: [CE_LEG, FUT_LEG], master: bse })
  const x = (await mtmOf(d, 'asha', 'TCS', R2_NOW))!
  assert.deepEqual([x.gross.previous, x.notes[0]], [null, BSE_NOTE])
  assert.equal((await mtmInputsOf(d, BOOK, R2_NOW)).bse, true)
  assert.equal(TM.options.chain('TCS', R2_OCT)?.exchange, 'NFO')
})
