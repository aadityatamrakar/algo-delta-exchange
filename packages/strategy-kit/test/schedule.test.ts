import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cronAtIstMinute,
  firstIstMinuteOfDay,
  matches,
  nextAfter,
  occurrencesBetween,
  parseCron,
} from '../src/index.ts'

/** Epoch ms for an IST wall-clock instant. IST is UTC+05:30 with no DST. */
const ist = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s) - 330 * 60_000

const istString = (ms: number): string =>
  new Date(ms + 330 * 60_000).toISOString().replace('T', ' ').replace('.000Z', ' IST')

// 2026-07-24 is a Friday; 25 Sat, 26 Sun, 27 Mon. 22 is a Wednesday.
const FRI = { y: 2026, mo: 7, d: 24 }
const SAT = { y: 2026, mo: 7, d: 25 }
const MON = { y: 2026, mo: 7, d: 27 }
const WED = { y: 2026, mo: 7, d: 22 }

// The three expressions are verbatim from context/strategy-specs/modern.md §2
// "Cron schedules, exactly as written".
const WIDTH = '20 15 10 * * 1-5' // atr-band-nifty band width, 10:15:20
const POLLER = '10 */5 9-13 * * 1-5' // 09:00:10 … 13:55:10
const DEADLINE = '0 31 13 * * 1-5' // bn-breakout entry deadline, 13:31:00

// --- matching ---------------------------------------------------------------

test('`20 15 10 * * 1-5` matches 10:15:20 on a weekday and nothing else', () => {
  assert.equal(matches(WIDTH, ist(FRI.y, FRI.mo, FRI.d, 10, 15, 20)), true)
  // A second either side must NOT match — the whole reason atIstMinute was replaced.
  assert.equal(matches(WIDTH, ist(FRI.y, FRI.mo, FRI.d, 10, 15, 19)), false)
  assert.equal(matches(WIDTH, ist(FRI.y, FRI.mo, FRI.d, 10, 15, 21)), false)
  assert.equal(matches(WIDTH, ist(FRI.y, FRI.mo, FRI.d, 10, 16, 20)), false)
  assert.equal(matches(WIDTH, ist(SAT.y, SAT.mo, SAT.d, 10, 15, 20)), false, 'weekends are not trading days')
})

test('`10 */5 9-13 * * 1-5` fires at HH:MM:10 for MM in {0,5,…,55}, HH in 9..13', () => {
  for (const [h, mi, expected] of [
    [9, 0, true],
    [9, 5, true],
    [11, 40, true],
    [13, 30, true], // the last poll before the 13:31 deadline
    [13, 55, true], // the last poll of the window
    [9, 3, false], // not a 5-minute boundary
    [14, 0, false], // outside the hour range
    [8, 55, false],
  ] as const) {
    assert.equal(
      matches(POLLER, ist(FRI.y, FRI.mo, FRI.d, h, mi, 10)),
      expected,
      `${String(h)}:${String(mi)}:10 should be ${String(expected)}`,
    )
  }
  // :00 seconds is NOT a fire — the poller runs 10 seconds past the minute.
  assert.equal(matches(POLLER, ist(FRI.y, FRI.mo, FRI.d, 9, 5, 0)), false)
})

test('`0 31 13 * * 1-5` matches 13:31:00 exactly', () => {
  assert.equal(matches(DEADLINE, ist(FRI.y, FRI.mo, FRI.d, 13, 31, 0)), true)
  assert.equal(matches(DEADLINE, ist(FRI.y, FRI.mo, FRI.d, 13, 31, 10)), false)
  assert.equal(matches(DEADLINE, ist(FRI.y, FRI.mo, FRI.d, 13, 30, 0)), false)
})

// --- nextAfter --------------------------------------------------------------

test('nextAfter is strictly after, so an instant that fires does not return itself', () => {
  const fires = ist(FRI.y, FRI.mo, FRI.d, 10, 15, 20)
  assert.equal(nextAfter(WIDTH, fires), ist(MON.y, MON.mo, MON.d, 10, 15, 20))
})

test('nextAfter crosses a DAY boundary', () => {
  // Wednesday afternoon, past today's 10:15:20 -> Thursday's.
  const got = nextAfter(WIDTH, ist(WED.y, WED.mo, WED.d, 14, 0, 0))
  assert.equal(got, ist(2026, 7, 23, 10, 15, 20), `got ${istString(got)}`)
})

test('nextAfter skips the WEEKEND', () => {
  // Friday afternoon -> Monday, not Saturday.
  const got = nextAfter(WIDTH, ist(FRI.y, FRI.mo, FRI.d, 14, 0, 0))
  assert.equal(got, ist(MON.y, MON.mo, MON.d, 10, 15, 20), `got ${istString(got)}`)
  // ...and from inside the weekend itself.
  assert.equal(nextAfter(WIDTH, ist(SAT.y, SAT.mo, SAT.d, 10, 0, 0)), ist(MON.y, MON.mo, MON.d, 10, 15, 20))
})

test('nextAfter rolls a repeating poller past the end of its hour window', () => {
  // Last fire of the day is 13:55:10; the next is the following morning's 09:00:10.
  assert.equal(
    nextAfter(POLLER, ist(WED.y, WED.mo, WED.d, 13, 55, 10)),
    ist(2026, 7, 23, 9, 0, 10),
  )
  // Within the window it just steps 5 minutes.
  assert.equal(
    nextAfter(POLLER, ist(WED.y, WED.mo, WED.d, 13, 30, 10)),
    ist(WED.y, WED.mo, WED.d, 13, 35, 10),
  )
})

test('nextAfter crosses a MONTH and a YEAR boundary', () => {
  assert.equal(
    nextAfter(WIDTH, ist(2026, 7, 31, 12, 0, 0)), // Fri 31 Jul, past today's fire
    ist(2026, 8, 3, 10, 15, 20), // Mon 3 Aug
  )
  assert.equal(
    nextAfter(WIDTH, ist(2026, 12, 31, 12, 0, 0)), // Thu 31 Dec
    ist(2027, 1, 1, 10, 15, 20), // Fri 1 Jan
  )
})

// --- the ordering all four engines depend on --------------------------------

test('the DEADLINE fires AFTER the last poller tick of its window', () => {
  // "Deadline crons are deliberately placed after the last poller tick of the
  // window (13:30:10 < 13:31:00), so the final scheduled check is still allowed
  // to trade." — modern.md §2. If this inverts, the last opportunity of the day
  // is silently closed before it is ever evaluated.
  const before = ist(FRI.y, FRI.mo, FRI.d, 13, 29, 0)
  const lastPoll = nextAfter(POLLER, before)
  const deadline = nextAfter(DEADLINE, before)
  assert.equal(lastPoll, ist(FRI.y, FRI.mo, FRI.d, 13, 30, 10))
  assert.equal(deadline, ist(FRI.y, FRI.mo, FRI.d, 13, 31, 0))
  assert.ok(lastPoll < deadline, 'the poller must get one more evaluation before entries close')
  // No poller tick exists between them, so 13:30:10 really is the last one.
  assert.deepEqual(occurrencesBetween(POLLER, lastPoll, deadline), [])
})

test('orb-fut/orb-scalp keep the same ordering at 14:00 (14:00:10 poll, 14:00:30 deadline)', () => {
  const before = ist(FRI.y, FRI.mo, FRI.d, 13, 59, 0)
  const lastPoll = nextAfter('10 0 14 * * 1-5', before)
  const deadline = nextAfter('30 0 14 * * 1-5', before)
  assert.equal(lastPoll, ist(FRI.y, FRI.mo, FRI.d, 14, 0, 10))
  assert.equal(deadline, ist(FRI.y, FRI.mo, FRI.d, 14, 0, 30))
  assert.ok(lastPoll < deadline)
})

// --- occurrencesBetween -----------------------------------------------------

test('occurrencesBetween lists every fire in an open-closed interval', () => {
  const from = ist(FRI.y, FRI.mo, FRI.d, 9, 0, 10) // exclusive: this fire is NOT included
  const to = ist(FRI.y, FRI.mo, FRI.d, 9, 20, 10) // inclusive
  assert.deepEqual(
    occurrencesBetween(POLLER, from, to),
    [
      ist(FRI.y, FRI.mo, FRI.d, 9, 5, 10),
      ist(FRI.y, FRI.mo, FRI.d, 9, 10, 10),
      ist(FRI.y, FRI.mo, FRI.d, 9, 15, 10),
      ist(FRI.y, FRI.mo, FRI.d, 9, 20, 10),
    ],
  )
  assert.deepEqual(occurrencesBetween(POLLER, to, from), [], 'a backwards interval is empty, not an error')
})

test('occurrencesBetween is capped so a long replay gap cannot explode', () => {
  const from = ist(FRI.y, FRI.mo, FRI.d, 9, 0, 0)
  const to = from + 365 * 24 * 3_600_000
  assert.equal(occurrencesBetween(POLLER, from, to, 7).length, 7)
})

// --- catch-up thresholds ----------------------------------------------------

test('firstIstMinuteOfDay reproduces the hand-written bootstrap() thresholds', () => {
  // modern.md §2 "bootstrap() catch-up thresholds".
  assert.equal(firstIstMinuteOfDay('0 21 9 * * 1-5'), 9 * 60 + 21) // bn-breakout, 561
  assert.equal(firstIstMinuteOfDay(WIDTH), 10 * 60 + 15) // atr-band width, 615
  assert.equal(firstIstMinuteOfDay('20 40 11 * * 1-5'), 11 * 60 + 40) // atr-band lines, 700
  assert.equal(firstIstMinuteOfDay(DEADLINE), 13 * 60 + 31) // bn-breakout deadline, 811
  assert.equal(firstIstMinuteOfDay('0 15 14 * * 1-5'), 14 * 60 + 15) // atr-band deadline, 855
  // A repeating poller's threshold is the START of its window.
  assert.equal(firstIstMinuteOfDay(POLLER), 9 * 60)
  // orb-fut is the exception the `catchUpFrom` override exists for: it fires at
  // 09:45:20 but bootstraps from 09:46, one minute later.
  assert.equal(firstIstMinuteOfDay('20 45 9 * * 1-5'), 9 * 60 + 45)
})

test('cronAtIstMinute builds a once-a-day weekday cron', () => {
  assert.equal(cronAtIstMinute(9 * 60 + 21), '0 21 9 * * 1-5')
  assert.equal(cronAtIstMinute(15 * 60 + 15), '0 15 15 * * 1-5')
  assert.equal(firstIstMinuteOfDay(cronAtIstMinute(13 * 60 + 30)), 13 * 60 + 30)
  assert.equal(matches(cronAtIstMinute(9 * 60 + 21), ist(FRI.y, FRI.mo, FRI.d, 9, 21, 0)), true)
  assert.throws(() => cronAtIstMinute(-1), /out of range/)
  assert.throws(() => cronAtIstMinute(24 * 60), /out of range/)
})

// --- parsing ----------------------------------------------------------------

test('parseCron expands ranges, steps and lists', () => {
  const s = parseCron('0,30 */15 9-11 * * 1-5')
  assert.deepEqual([...s.seconds], [0, 30])
  assert.deepEqual([...s.minutes], [0, 15, 30, 45])
  assert.deepEqual([...s.hours], [9, 10, 11])
  assert.deepEqual([...s.daysOfWeek], [1, 2, 3, 4, 5])
  assert.equal(s.dowRestricted, true)
  assert.equal(s.domRestricted, false)
})

test('parseCron accepts a 5-field expression as second 0, and rejects nonsense loudly', () => {
  assert.deepEqual([...parseCron('21 9 * * 1-5').seconds], [0])
  assert.throws(() => parseCron('0 21 9 *'), /expected 6 fields/)
  assert.throws(() => parseCron('0 0 21 9 * * *'), /expected 6 fields/)
  assert.throws(() => parseCron('0 21 99 * * 1-5'), /hours/)
  assert.throws(() => parseCron('0 21 9 * * MON'), /day-of-week/)
  assert.throws(() => parseCron('0 21 9 * * 1-5/0'), /step/)
})

test('day-of-week 7 is Sunday, and an unrestricted dow matches every day', () => {
  assert.equal(matches('0 0 12 * * 7', ist(2026, 7, 26, 12, 0, 0)), true) // Sunday
  assert.equal(matches('0 0 12 * * *', ist(SAT.y, SAT.mo, SAT.d, 12, 0, 0)), true)
})
