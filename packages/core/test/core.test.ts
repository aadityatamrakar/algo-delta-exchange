import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeId,
  istParts,
  fixedClock,
  systemClock,
  isMarketOpen,
  isWeekday,
  roundToTick,
  nearlyEqual,
  Ok,
  Err,
  MARKET_OPEN_MIN,
  MARKET_CLOSE_MIN,
  FNO_CLOSE_MIN,
} from '../src/index.ts'

// --- ids --------------------------------------------------------------------

test('ids are unique and carry a sortable timestamp', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 500; i++) ids.add(makeId('ord', 1_700_000_000_000))
  assert.equal(ids.size, 500, 'no collisions even at an identical timestamp')
  assert.match([...ids][0] as string, /^ord-/)
})

test('ids from later timestamps sort after earlier ones', () => {
  const a = makeId('x', 1_700_000_000_000)
  const b = makeId('x', 1_800_000_000_000)
  // base36 of a larger ms value is lexically greater at equal length
  assert.ok((b.split('-')[1] as string) > (a.split('-')[1] as string))
})

// --- IST time ---------------------------------------------------------------

test('istParts converts UTC to IST (+05:30) without a tz database', () => {
  // 2026-07-25T04:00:00Z == 09:30 IST
  const p = istParts(Date.UTC(2026, 6, 25, 4, 0, 0))
  assert.equal(p.hours, 9)
  assert.equal(p.minutes, 30)
  assert.equal(p.minuteOfDay, 9 * 60 + 30)
})

test('istParts handles the half-hour offset and day rollover', () => {
  // 2026-07-25T19:00:00Z == 00:30 IST on the 26th (a Sunday)
  const p = istParts(Date.UTC(2026, 6, 25, 19, 0, 0))
  assert.equal(p.hours, 0)
  assert.equal(p.minutes, 30)
  assert.equal(p.day, 0, 'must roll into the next IST day')
})

test('market-open minutes match the NSE session', () => {
  assert.equal(MARKET_OPEN_MIN, 555) // 09:15
  assert.equal(MARKET_CLOSE_MIN, 930) // 15:30: the strategies' trading window still ends here
})

test('the F&O close is 15:40, ten minutes after the trading window ends', () => {
  assert.equal(FNO_CLOSE_MIN, 940)
  assert.equal(FNO_CLOSE_MIN - MARKET_CLOSE_MIN, 10)
})

test('isWeekday excludes Saturday and Sunday', () => {
  assert.equal(isWeekday(0), false)
  assert.equal(isWeekday(6), false)
  for (const d of [1, 2, 3, 4, 5]) assert.equal(isWeekday(d), true)
})

test('isMarketOpen is true inside the session on a weekday', () => {
  // 2026-07-24 is a Friday. 04:00Z = 09:30 IST.
  assert.equal(isMarketOpen(fixedClock(Date.UTC(2026, 6, 24, 4, 0, 0))), true)
})

test('isMarketOpen is false before open, after close, and at the close boundary', () => {
  // 03:30Z = 09:00 IST (before open)
  assert.equal(isMarketOpen(fixedClock(Date.UTC(2026, 6, 24, 3, 30, 0))), false)
  // 10:01Z = 15:31 IST (after close)
  assert.equal(isMarketOpen(fixedClock(Date.UTC(2026, 6, 24, 10, 1, 0))), false)
  // 10:00Z = 15:30 IST exactly — close is exclusive
  assert.equal(isMarketOpen(fixedClock(Date.UTC(2026, 6, 24, 10, 0, 0))), false)
  // 03:45Z = 09:15 IST exactly — open is inclusive
  assert.equal(isMarketOpen(fixedClock(Date.UTC(2026, 6, 24, 3, 45, 0))), true)
})

test('isMarketOpen is false on a weekend even at session time', () => {
  // 2026-07-25 is a Saturday. 04:00Z = 09:30 IST.
  assert.equal(isMarketOpen(fixedClock(Date.UTC(2026, 6, 25, 4, 0, 0))), false)
})

test('fixedClock is deterministic and settable (replay driver)', () => {
  const c = fixedClock(Date.UTC(2026, 6, 24, 4, 0, 0))
  assert.equal(c.istMinutes(), 570) // 09:30
  c.set(Date.UTC(2026, 6, 24, 5, 0, 0))
  assert.equal(c.istMinutes(), 630) // 10:30
  assert.equal(c.istDay(), 5, 'Friday')
})

test('systemClock is coherent with istParts', () => {
  const now = systemClock.now()
  assert.equal(systemClock.istMinutes(), istParts(now).minuteOfDay)
})

// --- tick rounding ----------------------------------------------------------

test('roundToTick snaps on-grid values EXACTLY despite float error', () => {
  // 100.1 / 0.05 === 2001.9999999999998 — a naive floor moves it a whole tick.
  for (const p of [100.1, 100.05, 99.9, 0.05, 1234.5, 17.35]) {
    for (const dir of ['down', 'up', 'nearest'] as const) {
      assert.equal(roundToTick(p, 0.05, dir), p, `${dir} moved on-grid ${p}`)
    }
  }
})

test('roundToTick honours the requested direction off-grid', () => {
  assert.equal(roundToTick(100.07, 0.05, 'down'), 100.05)
  assert.equal(roundToTick(100.07, 0.05, 'up'), 100.1)
  assert.equal(roundToTick(100.07, 0.05, 'nearest'), 100.05)
  assert.equal(roundToTick(100.08, 0.05, 'nearest'), 100.1)
})

test('roundToTick is a no-op for a non-positive tick size', () => {
  assert.equal(roundToTick(123.456, 0), 123.456)
  assert.equal(roundToTick(123.456, -1), 123.456)
})

test('nearlyEqual absorbs float noise', () => {
  assert.equal(nearlyEqual(0.1 + 0.2, 0.3), true)
  assert.equal(nearlyEqual(1, 1.001), false)
})

// --- Result -----------------------------------------------------------------

test('Result discriminates on ok', () => {
  const a = Ok(5)
  const b = Err('nope')
  assert.equal(a.ok, true)
  assert.equal(a.ok === true && a.value, 5)
  assert.equal(b.ok, false)
  assert.equal(b.ok === false && b.error, 'nope')
})
