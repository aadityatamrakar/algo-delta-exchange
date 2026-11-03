import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_QUOTE_MAX_AGE_MS,
  createQuoteMap,
  quoteMaxAgeFromEnv,
} from '../src/quote-map.ts'

/**
 * The gateway's touch, in isolation.
 *
 * What these assert is mostly REFUSAL: the map answers `null` far more often
 * than it answers a price, because every wrong answer here becomes a live
 * order repriced at a number the market never showed. A one-sided book, a
 * crossed book, a zero, a frame the wire garbled, a book that stopped
 * updating — each is a `null`, and `null` means the peg pauses.
 */

const TOKEN = 12345
const NOW = 1_700_000_000_000

function mapAt(now: { ms: number }, maxAgeMs = DEFAULT_QUOTE_MAX_AGE_MS) {
  return createQuoteMap({ now: () => now.ms, maxAgeMs })
}

test('a two-sided frame becomes the touch, carrying the frame’s OWN timestamp', () => {
  const clock = { ms: NOW }
  const q = mapAt(clock)
  q.onTick({ token: TOKEN, price: 10.05, ts: NOW - 500, bid: 10, ask: 10.1 })
  assert.deepEqual(q.touch(TOKEN), { bid: 10, ask: 10.1, ts: NOW - 500 })
})

test('a frame with no ts is stamped on arrival — never left ageless', () => {
  const clock = { ms: NOW }
  const q = mapAt(clock)
  q.onTick({ token: TOKEN, price: 10.05, bid: 10, ask: 10.1 })
  assert.deepEqual(q.touch(TOKEN), { bid: 10, ask: 10.1, ts: NOW })
})

test('a later two-sided frame replaces the earlier one', () => {
  const clock = { ms: NOW }
  const q = mapAt(clock)
  q.onTick({ token: TOKEN, ts: NOW - 1000, bid: 10, ask: 10.1 })
  q.onTick({ token: TOKEN, ts: NOW, bid: 10.05, ask: 10.15 })
  assert.deepEqual(q.touch(TOKEN), { bid: 10.05, ask: 10.15, ts: NOW })
})

test('an LTP-ONLY frame neither replaces the book nor refreshes its age', () => {
  // The exit-side-marks lesson (2026-08-21): a book that stopped printing is
  // OLD, not gone — but its age is the BOOK's, not the last trade's. A tick
  // with no depth says nothing about where the touch is, so letting it stamp
  // `ts` would hide a dead book behind a live trade print and peg an order to
  // a spread that no longer exists.
  const clock = { ms: NOW }
  const q = mapAt(clock)
  q.onTick({ token: TOKEN, ts: NOW - 10_000, bid: 10, ask: 10.1 })
  q.onTick({ token: TOKEN, price: 10.5, ts: NOW })
  assert.deepEqual(q.touch(TOKEN), { bid: 10, ask: 10.1, ts: NOW - 10_000 })

  // ...and it goes stale on the BOOK's clock, five seconds later.
  clock.ms = NOW + 5_001
  assert.equal(q.touch(TOKEN), null)
})

test('a book older than the max age is null — the pause signal, not a guess', () => {
  const clock = { ms: NOW }
  const q = mapAt(clock)
  q.onTick({ token: TOKEN, ts: NOW, bid: 10, ask: 10.1 })
  clock.ms = NOW + DEFAULT_QUOTE_MAX_AGE_MS
  assert.notEqual(q.touch(TOKEN), null, 'the boundary itself is still fresh')
  clock.ms = NOW + DEFAULT_QUOTE_MAX_AGE_MS + 1
  assert.equal(q.touch(TOKEN), null)
})

test('a token never ticked has no touch', () => {
  assert.equal(mapAt({ ms: NOW }).touch(999), null)
})

test('a one-sided, zero, negative or CROSSED book is refused outright', () => {
  const q = mapAt({ ms: NOW })
  q.onTick({ token: TOKEN, ts: NOW, bid: 10 })
  q.onTick({ token: TOKEN, ts: NOW, ask: 10.1 })
  q.onTick({ token: TOKEN, ts: NOW, bid: 0, ask: 10.1 })
  q.onTick({ token: TOKEN, ts: NOW, bid: 10, ask: 0 })
  q.onTick({ token: TOKEN, ts: NOW, bid: -1, ask: 10.1 })
  // ask < bid is not a market, it is a bad frame.
  q.onTick({ token: TOKEN, ts: NOW, bid: 10.1, ask: 10 })
  assert.equal(q.touch(TOKEN), null)
  assert.equal(q.size, 0)

  // A locked market (ask === bid) IS a market and is kept.
  q.onTick({ token: TOKEN, ts: NOW, bid: 10, ask: 10 })
  assert.deepEqual(q.touch(TOKEN), { bid: 10, ask: 10, ts: NOW })
})

test('a bad frame REPLACES nothing — the last good book survives it', () => {
  const q = mapAt({ ms: NOW })
  q.onTick({ token: TOKEN, ts: NOW, bid: 10, ask: 10.1 })
  q.onTick({ token: TOKEN, ts: NOW, bid: 10.1, ask: 10 })
  assert.deepEqual(q.touch(TOKEN), { bid: 10, ask: 10.1, ts: NOW })
})

test('garbage off the wire is dropped, never thrown — this runs inside a bus handler', () => {
  const q = mapAt({ ms: NOW })
  for (const junk of [
    null,
    undefined,
    'tick',
    42,
    {},
    { token: 'abc', bid: 10, ask: 10.1 },
    { token: NaN, bid: 10, ask: 10.1 },
    { token: TOKEN, bid: 'ten', ask: 10.1 },
    { token: TOKEN, bid: 10, ask: Infinity },
    { token: TOKEN, ts: 'now', bid: 10, ask: 10.1 },
  ]) {
    assert.doesNotThrow(() => q.onTick(junk))
  }
  assert.equal(q.size, 1, 'only the frame with a garbled ts survived, stamped on arrival')
  assert.deepEqual(q.touch(TOKEN), { bid: 10, ask: 10.1, ts: NOW })
})

test('the max-age dial refuses NaN and out-of-range values rather than propagating them', () => {
  assert.equal(quoteMaxAgeFromEnv({}), DEFAULT_QUOTE_MAX_AGE_MS)
  assert.equal(quoteMaxAgeFromEnv({ DESK_PEG_QUOTE_MAX_AGE_MS: '' }), DEFAULT_QUOTE_MAX_AGE_MS)
  // NaN would make `age > maxAge` false for every quote, so a mistyped dial
  // would peg orders to a book from three hours ago.
  assert.equal(quoteMaxAgeFromEnv({ DESK_PEG_QUOTE_MAX_AGE_MS: '15s' }), DEFAULT_QUOTE_MAX_AGE_MS)
  assert.equal(quoteMaxAgeFromEnv({ DESK_PEG_QUOTE_MAX_AGE_MS: '0' }), DEFAULT_QUOTE_MAX_AGE_MS)
  assert.equal(quoteMaxAgeFromEnv({ DESK_PEG_QUOTE_MAX_AGE_MS: '-1' }), DEFAULT_QUOTE_MAX_AGE_MS)
  assert.equal(quoteMaxAgeFromEnv({ DESK_PEG_QUOTE_MAX_AGE_MS: '3000' }), 3_000)
})
