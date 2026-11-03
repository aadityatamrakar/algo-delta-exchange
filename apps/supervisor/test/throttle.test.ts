/**
 * ONE LINE A MINUTE, WITH THE COUNT — the helper every "this fires on every
 * pass" ERROR/WARN in the supervisor goes through.
 *
 * A delta-lean book evaluates every 2 s and the registry polls every 5 s, so a
 * condition that persists for a session (a spent order budget, a strategy row
 * that cannot be read, a book that cannot be started, a bad nudge token) is a
 * thousand identical lines by lunch. `repair-hold.ts`'s `sayOnce` solved that
 * for one caller by dropping the repeats; this helper does the same and also
 * REPORTS how many were dropped, because "one line per minute with
 * `suppressed: 30`" is what tells an operator the condition never cleared.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Throttle } from '../src/throttle.ts'

const T0 = Date.UTC(2026, 8, 16, 4, 30)

test('first claim emits with suppressed 0', () => {
  const t = new Throttle()
  assert.equal(t.claim(T0), 0, 'nothing was ever suppressed before the first line')
})

test('claims inside the window answer null and are counted', () => {
  const t = new Throttle(60_000)
  assert.equal(t.claim(T0), 0)
  assert.equal(t.claim(T0 + 1_000), null)
  assert.equal(t.claim(T0 + 30_000), null)
  assert.equal(t.claim(T0 + 59_999), null, 'the window is closed up to, not including, its end')
})

test('the claim after the window carries the count and starts a new window', () => {
  const t = new Throttle(60_000)
  assert.equal(t.claim(T0), 0)
  for (let i = 1; i <= 30; i += 1) assert.equal(t.claim(T0 + i * 1_000), null)
  assert.equal(t.claim(T0 + 60_000), 30, 'the line names every repeat it swallowed')
  // A fresh window from the emission, and a fresh count.
  assert.equal(t.claim(T0 + 61_000), null)
  assert.equal(t.claim(T0 + 120_000), 1)
})

test('reset() makes the next claim emit at once', () => {
  const t = new Throttle(60_000)
  assert.equal(t.claim(T0), 0)
  assert.equal(t.claim(T0 + 1_000), null)
  t.reset()
  assert.equal(t.claim(T0 + 2_000), 0, 'the count is dropped with the window: the condition cleared')
})

test('a custom window is honoured', () => {
  const t = new Throttle(5_000)
  assert.equal(t.claim(T0), 0)
  assert.equal(t.claim(T0 + 4_999), null)
  assert.equal(t.claim(T0 + 5_000), 1)
})
