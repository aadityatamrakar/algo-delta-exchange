import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ON_SCREEN_TTL_MS, OnScreenSet } from '../src/market/on-screen.ts'

const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i)

test('a touched underlying stays for the ttl and then leaves', () => {
  const s = new OnScreenSet({ maxTokens: 100 })
  assert.equal(ON_SCREEN_TTL_MS, 60_000)
  assert.equal(s.touch('TCS', range(1, 34), 0), true)
  assert.deepEqual(s.underlyings(59_999), ['TCS'])
  assert.deepEqual(s.underlyings(60_000), [])
  assert.deepEqual(s.tokens(60_000), [])
})

test('the cap counts tokens, first come first served', () => {
  const s = new OnScreenSet({ maxTokens: 100 })
  assert.equal(s.touch('TCS', range(1, 34), 0), true)
  assert.equal(s.touch('INFY', range(100, 50), 0), true)
  assert.equal(s.touch('SBIN', range(200, 30), 0), false)
  assert.equal(s.touch('TCS', range(1, 34), 0), true)
  assert.deepEqual(s.underlyings(0), ['TCS', 'INFY'])
})

test('room frees when an underlying goes quiet', () => {
  const s = new OnScreenSet({ maxTokens: 100 })
  s.touch('TCS', range(1, 34), 0)
  s.touch('INFY', range(100, 50), 30_000)
  assert.equal(s.touch('SBIN', range(200, 30), 30_000), false)
  assert.equal(s.touch('SBIN', range(200, 30), 60_001), true)
})

test('a token two underlyings share is counted once', () => {
  const s = new OnScreenSet({ maxTokens: 90 })
  assert.equal(s.touch('A', range(1, 60), 0), true)
  assert.equal(s.touch('B', range(31, 60), 0), true)
  assert.equal(s.tokens(0).length, 90)
})

test('one underlying larger than the cap is refused', () => {
  const s = new OnScreenSet({ maxTokens: 10 })
  assert.equal(s.touch('BIG', range(1, 11), 0), false)
  assert.deepEqual(s.underlyings(0), [])
})

test('tokens returns a fresh array each call', () => {
  const s = new OnScreenSet({ maxTokens: 10 })
  s.touch('A', [1, 2], 0)
  const t = s.tokens(0) as number[]
  t.push(99)
  assert.deepEqual(s.tokens(0), [1, 2])
})

test('a refresh renews the ttl and replaces the set', () => {
  const s = new OnScreenSet({ maxTokens: 10, ttlMs: 1000 })
  s.touch('A', [1, 2], 0)
  s.touch('A', [3], 900)
  assert.deepEqual(s.tokens(1500), [3])
  assert.deepEqual(s.tokens(1900), [])
})

test('an underlying already in whose new set no longer fits loses its grant', () => {
  const s = new OnScreenSet({ maxTokens: 100 })
  assert.equal(s.touch('NIFTY', range(1, 50), 0), true)
  assert.equal(s.touch('TCS', range(100, 34), 0), true)
  // NIFTY's window moved: 70 new tokens and TCS's 34 are over 100. Its old 50 are not kept declaring strikes it no longer shows.
  assert.equal(s.touch('NIFTY', range(1, 70), 1_000), false)
  assert.deepEqual(s.underlyings(1_000), ['TCS'])
  assert.deepEqual(s.tokens(1_000), range(100, 34))
  // the room it left is anyone's, first come first served
  assert.equal(s.touch('SBIN', range(200, 60), 2_000), true)
  assert.equal(s.touch('NIFTY', range(1, 50), 3_000), false)
})

test("the room is the cap, or what TRADERS_MAX_TOKENS leaves beside the books' full windows when that is less (Ruling R3-18)", () => {
  let room = 50
  const s = new OnScreenSet({ maxTokens: 100, feedRoom: () => room })
  assert.equal(s.touch('TCS', range(1, 60), 0), false)      // within the 100, not the 50 the books leave
  assert.equal(s.touch('TCS', range(1, 34), 0), true)
  room = 1_000
  assert.equal(s.touch('INFY', range(100, 70), 0), false)   // 104 is over the cap
  assert.equal(s.touch('INFY', range(100, 60), 0), true)
  assert.equal(s.touch('SBIN', range(200, 6), 0), true)
  // the books grew: the last comers leave first, until the rest fit
  room = 95
  assert.deepEqual(s.underlyings(0), ['TCS', 'INFY'])
  room = 40
  assert.deepEqual(s.underlyings(0), ['TCS'])
  assert.deepEqual(s.tokens(0), range(1, 34))
  room = -5   // the books alone are over TRADERS_MAX_TOKENS
  assert.deepEqual(s.tokens(0), [])
  assert.equal(s.touch('TCS', range(1, 34), 0), false)
})
