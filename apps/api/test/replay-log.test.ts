/**
 * `engine decision applied`, ONCE PER REPLAY STORM rather than once a second.
 *
 * On a dead weekend desk-api wrote 10 MB of log every 3 h 20 min: 35,904 of
 * the 35,971 lines in one rotated file were `engine decision applied`, every
 * one of them `replayed: true, status: WORKING` for the same three decision
 * ids — the supervisor re-posting a package it holds in flight (the two SENSEX
 * 10-01 books and the TCS 09-29 book, wedged on orders that can never fill),
 * ~1/sec each, all weekend. A replay changes nothing and says nothing new.
 *
 * The gate: a FRESH decision is always logged. A replay is logged the first
 * time it is seen and then at most once per interval per decision id, carrying
 * how many replays it stood for since the last line.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReplayLogGate } from '../src/replay-log.ts'

const MIN = 60_000

test('a fresh decision is always logged', () => {
  const gate = createReplayLogGate({ intervalMs: 10 * MIN })
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(gate('d-1', false, 1_000 + i), { log: true, suppressed: 0 })
  }
})

test('a replay storm is one line, then one line per interval with the count it stood for', () => {
  const gate = createReplayLogGate({ intervalMs: 10 * MIN })
  const t0 = 1_000_000
  assert.deepEqual(gate('d-1', true, t0), { log: true, suppressed: 0 }, 'the first replay is news')
  let logged = 0
  for (let s = 1; s < 600; s++) if (gate('d-1', true, t0 + s * 1_000).log) logged++
  assert.equal(logged, 0, 'ten minutes of 1/sec replays print nothing')
  assert.deepEqual(gate('d-1', true, t0 + 10 * MIN), { log: true, suppressed: 599 })
  assert.deepEqual(gate('d-1', true, t0 + 10 * MIN + 1), { log: false, suppressed: 0 })
})

test('each decision id has its own clock', () => {
  const gate = createReplayLogGate({ intervalMs: 10 * MIN })
  assert.equal(gate('a', true, 0).log, true)
  assert.equal(gate('b', true, 1).log, true)
  assert.equal(gate('a', true, 2).log, false)
  assert.equal(gate('c', true, 3).log, true)
})

test('a replay whose OUTCOME changed is logged at once — WORKING→DONE is never hidden', () => {
  const gate = createReplayLogGate({ intervalMs: 10 * MIN })
  assert.equal(gate('d-1', true, 0, 'WORKING|2|0').log, true)
  assert.equal(gate('d-1', true, 1_000, 'WORKING|2|0').log, false)
  assert.deepEqual(gate('d-1', true, 2_000, 'DONE|2|0'), { log: true, suppressed: 1 })
  assert.equal(gate('d-1', true, 3_000, 'DONE|2|0').log, false)
  // More fills, or a route error, is news too.
  assert.equal(gate('d-1', true, 4_000, 'DONE|3|0').log, true)
  assert.equal(gate('d-1', true, 5_000, 'DONE|3|1').log, true)
})

test('the memory is bounded: ids not seen for a while are forgotten', () => {
  const gate = createReplayLogGate({ intervalMs: MIN, maxIds: 3 })
  for (const id of ['a', 'b', 'c', 'd']) gate(id, true, 0)
  // 'a' was evicted to hold the cap, so its next replay is news again.
  assert.equal(gate('a', true, 1).log, true)
})
