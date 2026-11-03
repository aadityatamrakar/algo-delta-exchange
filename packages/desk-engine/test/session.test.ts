/**
 * THE CALENDAR AND THE CLOCK, PINNED TO REAL DATES.
 *
 * A session gate that is wrong in either direction is expensive: open on a
 * holiday and the supervisor forms decisions against a frozen book and a stale
 * chain; closed on a trading day and a live short book runs a whole session
 * unmanaged. Both failures are silent — nothing throws — so the only thing
 * that catches them is a test naming actual dates.
 *
 * Every date below is checked against the ported list in `src/session.ts`,
 * which is itself a verbatim copy of the NSE 2026 calendar in
 * `sensibull-desk/sensibull_tools/universe.py:397-414`. The mark cases pin the
 * two boundaries the grid gets wrong when it is written as plain arithmetic:
 * a minute that IS a mark must stay on it (not round back a whole grid step),
 * and a minute past the close must clamp to the close rather than emit a mark
 * the session never had.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isTradingDay,
  markOf,
  isSameMark,
  MARKET_HOLIDAYS_2026,
  SESSION_OPEN_MIN,
  DECISIONS_END_MIN,
  DECISION_CLOCK_CLOSE_MIN,
  RULES_START_MIN,
} from '@algomaker/desk-engine'

test('session boundaries are the NSE clock in IST minutes', () => {
  assert.equal(SESSION_OPEN_MIN, 555) // 09:15
  assert.equal(RULES_START_MIN, 560) // 09:20
})

test('the live desk stops at 15:30 though F&O trades to 15:40 (spec 2026-10-23 G6)', () => {
  // Both stay 15:30 on purpose: moving the first lets the desk place orders to
  // 15:40, moving the second moves when live books enter and exit. Each is its
  // own decision, so a change to either must fail here first.
  assert.equal(DECISIONS_END_MIN, 930)
  assert.equal(DECISION_CLOCK_CLOSE_MIN, 930)
  assert.equal(markOf(939), 930, 'no mark after 15:30')
})

test('a weekday that is not a holiday is a trading day', () => {
  assert.equal(isTradingDay('2026-08-24'), true) // Monday
})

test('the weekend is not a trading day', () => {
  assert.equal(isTradingDay('2026-08-23'), false) // Sunday
  assert.equal(isTradingDay('2026-08-22'), false) // Saturday
})

test('a listed NSE holiday is not a trading day', () => {
  // Republic Day 2026 falls on a Monday, so only the holiday list can
  // exclude it — a weekday-only gate would trade straight through it.
  assert.equal(new Date('2026-01-26T00:00:00Z').getUTCDay(), 1)
  assert.equal(isTradingDay('2026-01-26'), false)
  assert.equal(isTradingDay('2026-12-25'), false) // Christmas, a Friday
})

test('the ported holiday list is the 2026 NSE calendar verbatim', () => {
  // universe.py:397-414 — sixteen full-day closures. A name changing is
  // cosmetic; a date going missing is a session traded on a dead book.
  assert.deepEqual(Object.keys(MARKET_HOLIDAYS_2026), [
    '2026-01-15',
    '2026-01-26',
    '2026-03-03',
    '2026-03-26',
    '2026-03-31',
    '2026-04-03',
    '2026-04-14',
    '2026-05-01',
    '2026-05-28',
    '2026-06-26',
    '2026-09-14',
    '2026-10-02',
    '2026-10-20',
    '2026-11-10',
    '2026-11-24',
    '2026-12-25',
  ])
  assert.equal(MARKET_HOLIDAYS_2026['2026-11-10'], 'Diwali Balipratipada')
})

test('the calendar FAILS OPEN on a year nobody has filled in', () => {
  // universe.py:423-427 — a weekday of an uncovered year reports as a
  // trading day. Copied deliberately: the alternative is a supervisor that
  // silently stops managing live books the moment the year rolls over.
  assert.equal(isTradingDay('2027-01-04'), true) // Monday, uncovered year
  assert.equal(isTradingDay('2027-01-03'), false) // Sunday still weekend
})

test('a date it cannot parse is not a trading day', () => {
  // The one place this is stricter than Python, which raises: a supervisor
  // that cannot read its own date string should hold, not act.
  assert.equal(isTradingDay('24-08-2026'), false)
  assert.equal(isTradingDay(''), false)
  assert.equal(isTradingDay('2026-13-45'), false) // right shape, no such day
})

test('markOf floors to the 5-minute grid inside the session', () => {
  assert.equal(markOf(557), 555)
  assert.equal(markOf(555), 555)
  assert.equal(markOf(559), 555)
  assert.equal(markOf(560), 560)
})

test('markOf clamps outside the session rather than inventing a mark', () => {
  assert.equal(markOf(931), 930)
  assert.equal(markOf(1439), 930)
  assert.equal(markOf(554), 555)
  assert.equal(markOf(0), 555)
})

test('isSameMark answers whether two minutes share a decision pass', () => {
  assert.equal(isSameMark(557, 559), true)
  assert.equal(isSameMark(559, 560), false)
  assert.equal(isSameMark(931, 935), true) // both clamped to the close
})
