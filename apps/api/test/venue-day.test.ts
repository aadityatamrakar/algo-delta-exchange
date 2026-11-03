/**
 * The venue day every P&L, guard and report site keys on. MONGO-FREE.
 *
 * NSE's day is the IST date and its clocks are unchanged; DX's is the
 * settlement cycle, 12:00 UTC to 12:00 UTC, and it never closes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DX, NSE } from '@algomaker/venue'
import {
  API_VENUE,
  formatMoney,
  minutesIntoVenueDay,
  previousVenueDay,
  venueDay,
  venueDayRange,
} from '../src/venue.ts'
import { DX_ROLLUP_AFTER_MIN, dailyPlan } from '../src/pnl-jobs.ts'
import { istDayRange } from '../src/routes/kit.ts'
import { toStampedFill } from '../src/pnlstore.ts'

const ms = (iso: string): number => Date.parse(iso)

test('unset DESK_VENUE is NSE', () => {
  assert.equal(API_VENUE.id, 'nse')
})

test('NSE day range is exactly the IST day range it replaced', () => {
  assert.deepEqual(venueDayRange('2026-11-03', NSE), istDayRange('2026-11-03'))
  assert.equal(venueDay(ms('2026-11-03T20:00:00Z'), NSE), '2026-11-04')
})

test('DX day 2026-11-04 is [11-03 12:00Z, 11-04 12:00Z)', () => {
  const r = venueDayRange('2026-11-04', DX)
  assert.equal(r.from, ms('2026-11-03T12:00:00Z'))
  assert.equal(r.to, ms('2026-11-04T12:00:00Z'))
  assert.equal(venueDay(r.from, DX), '2026-11-04')
  assert.equal(venueDay(r.to - 1, DX), '2026-11-04')
  assert.equal(venueDay(r.to, DX), '2026-11-05')
  // 20:00 IST on 3 Nov is in the day that settles on 4 Nov.
  assert.equal(venueDay(ms('2026-11-03T14:30:00Z'), DX), '2026-11-04')
})

test('previous day and minutes into the day, both venues', () => {
  assert.equal(previousVenueDay('2026-11-04', DX), '2026-11-03')
  assert.equal(previousVenueDay('2026-11-04', NSE), '2026-11-03')
  assert.equal(minutesIntoVenueDay(ms('2026-11-04T12:35:00Z'), DX), 35)
  assert.equal(minutesIntoVenueDay(ms('2026-11-04T03:15:00Z'), NSE), 8 * 60 + 45)
})

test('money: NSE keeps the en-IN rupee text, DX is dollars to the cent', () => {
  assert.equal(formatMoney(3000, NSE), '₹3,000')
  assert.equal(formatMoney(-312.5, DX), '-$312.50')
  assert.equal(formatMoney(1234.5, DX, { symbol: false }), '1,234.50')
})

const plan = (venue: typeof DX, iso: string, rolledUpFor = '', prunedFor = '') =>
  dailyPlan(venue, ms(iso), {
    rollupAfter: 15 * 60 + 40,
    pruneAfter: 90,
    dxRollupAfter: DX_ROLLUP_AFTER_MIN,
    rolledUpFor,
    prunedFor,
  })

test('NSE housekeeping is unchanged: today after 15:40 IST, the prune after 01:30 IST', () => {
  const early = plan(NSE, '2026-11-03T09:00:00Z') // 14:30 IST
  assert.equal(early.needsRollup, false)
  assert.equal(early.needsPrune, true)
  const close = plan(NSE, '2026-11-03T10:10:00Z') // 15:40 IST
  assert.equal(close.rollupDate, '2026-11-03')
  assert.equal(close.needsRollup, true)
  assert.equal(plan(NSE, '2026-11-03T10:10:00Z', '2026-11-03').needsRollup, false)
})

test('DX: the day that settled at 12:00 UTC is rolled up 35 minutes later, once', () => {
  const before = plan(DX, '2026-11-04T12:20:00Z')
  assert.equal(before.needsRollup, false, 'the settlement may not be booked yet')
  assert.equal(before.needsPrune, false)
  const due = plan(DX, '2026-11-04T12:35:00Z')
  assert.equal(due.today, '2026-11-05')
  assert.equal(due.rollupDate, '2026-11-04', 'the day that just settled, expiries included')
  assert.equal(due.needsRollup, true)
  assert.equal(due.needsPrune, true)
  const again = plan(DX, '2026-11-05T02:00:00Z', '2026-11-04', '2026-11-05')
  assert.equal(again.needsRollup, false)
  assert.equal(again.needsPrune, false)
  // Midnight IST and midnight UTC are not boundaries on DX.
  assert.equal(plan(DX, '2026-11-04T18:31:00Z', '2026-11-04', '2026-11-05').needsRollup, false)
})

test('a fill row\'s fee is read, a bad one is dropped, and absent stays absent', () => {
  const base = { tradingsymbol: 'C-BTC-76600-041126', side: 'Sell', qty: 0.05, price: 212, ts: 5 }
  assert.equal(toStampedFill({ ...base, fee: 0.4378 }, 1)?.fee, 0.4378)
  assert.equal(toStampedFill({ ...base, fee: 'x' }, 1)?.fee, undefined)
  assert.equal(toStampedFill({ ...base, fee: -1 }, 1)?.fee, undefined)
  assert.equal('fee' in (toStampedFill(base, 1) ?? {}), false)
})
