/**
 * The frozen-socket verdict, in isolation (F-14).
 *
 * `frozenSockets` is the pure part of the health sweep: given what each socket's
 * watchdog says, is this a socket whose ticks have STOPPED while the connection
 * stayed up — the failure that looks perfectly healthy from every other angle?
 * Extracted so the decision is testable without a Kite login, a bus or Mongo.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frozenSockets, positiveEnvMs, sweepFrozenSockets, DEFAULT_FREEZE_STALE_MS } from '../src/main.ts'
import type { SocketHealth } from '../src/feed-pool.ts'

const socket = (over: Partial<SocketHealth> = {}): SocketHealth => ({
  socket: 0,
  connected: true,
  tokens: 100,
  staleTokens: 90,
  oldestAgeMs: 120_000,
  state: 'stale',
  ...over,
})

test('a frozen socket is reported only after TWO consecutive sweeps', () => {
  const streaks = new Map<number, number>()
  const s = [socket()]
  assert.deepEqual(frozenSockets(s, true, streaks), [], 'one sweep is a hiccup, not a diagnosis')
  const second = frozenSockets(s, true, streaks)
  assert.equal(second.length, 1)
  assert.equal(second[0]?.socket, 0)
})

test('one healthy sweep RESETS the streak', () => {
  const streaks = new Map<number, number>()
  frozenSockets([socket()], true, streaks)
  frozenSockets([socket({ staleTokens: 0, state: 'ok' })], true, streaks)
  assert.deepEqual(frozenSockets([socket()], true, streaks), [], 'the count starts again')
})

test('a CLOSED market never reports frozen ticks', () => {
  // Outside 09:15-15:30 IST every token is legitimately stale. Alarming then
  // would make the signal noise, and noise is how a real freeze goes unseen.
  const streaks = new Map<number, number>()
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(frozenSockets([socket()], false, streaks), [])
  }
})

test('a DISCONNECTED socket is not a frozen one', () => {
  // A dead socket is loud and already has its own repair path (the dead-feed
  // sweep + FeedRecovery). This alarm is only for the silent case.
  const streaks = new Map<number, number>()
  const s = [socket({ connected: false })]
  frozenSockets(s, true, streaks)
  assert.deepEqual(frozenSockets(s, true, streaks), [])
})

test('a MINORITY of stale tokens is illiquidity, not a freeze', () => {
  // Half a socket's tokens going quiet is a stock chain doing what stock chains
  // do (measured: BHEL wings tick once a minute). The threshold is MORE than
  // half, which no natural cadence reaches while the wire is alive.
  const streaks = new Map<number, number>()
  const s = [socket({ staleTokens: 50, tokens: 100 })]
  frozenSockets(s, true, streaks)
  assert.deepEqual(frozenSockets(s, true, streaks), [])
})

test('a socket holding NO tokens is never frozen', () => {
  const streaks = new Map<number, number>()
  const s = [socket({ tokens: 0, staleTokens: 0, state: 'ok' })]
  frozenSockets(s, true, streaks)
  assert.deepEqual(frozenSockets(s, true, streaks), [])
})

test('sockets are tracked independently', () => {
  const streaks = new Map<number, number>()
  const both = [socket({ socket: 0 }), socket({ socket: 1, staleTokens: 0, state: 'ok' })]
  frozenSockets(both, true, streaks)
  const out = frozenSockets(both, true, streaks)
  assert.deepEqual(out.map((s) => s.socket), [0])
})

// ------------------------------------------------------- the repair, and its
// consequence for the streak

function recorder(streaks: Map<number, number>, autoRepair: boolean): {
  sweep: (perSocket?: readonly SocketHealth[]) => void
  alarms: number[]
  repaired: number[]
} {
  const alarms: number[] = []
  const repaired: number[] = []
  const sweep = (perSocket: readonly SocketHealth[] = [socket()]): void => {
    sweepFrozenSockets({
      perSocket,
      session: true,
      streaks,
      repair: autoRepair ? (s) => repaired.push(s) : null,
      onAlarm: (s) => alarms.push(s.socket),
    })
  }
  return { sweep, alarms, repaired }
}

test('a repaired socket is RE-OBSERVED, never repaired again on the next sweep', () => {
  // The repair replays the whole subscription set on a new socket, and the
  // exchange needs longer than one 10s sweep to start printing again. Carrying
  // the streak across the repair would make the very next sweep repair the same
  // socket, forever — a healthy socket rebuilt every 10s all session.
  const streaks = new Map<number, number>()
  const { sweep, repaired } = recorder(streaks, true)
  sweep()
  sweep()
  assert.deepEqual(repaired, [0], 'two frozen sweeps, one repair')
  sweep()
  assert.deepEqual(repaired, [0], 'the sweep straight after a repair repairs nothing')
  sweep()
  assert.deepEqual(repaired, [0, 0], 'two FRESH sweeps later, a still-frozen socket is repaired again')
})

test('with auto-repair OFF the alarm keeps stating the fault', () => {
  // Nothing was repaired, so nothing was re-observed: the operator must keep
  // being told, every sweep, that the socket is still frozen.
  const streaks = new Map<number, number>()
  const { sweep, alarms, repaired } = recorder(streaks, false)
  for (let i = 0; i < 4; i++) sweep()
  assert.deepEqual(repaired, [])
  assert.deepEqual(alarms, [0, 0, 0], 'silent for the first sweep, loud from the second on')
})

test('a healthy socket is neither alarmed on nor repaired', () => {
  const streaks = new Map<number, number>()
  const { sweep, alarms, repaired } = recorder(streaks, true)
  const ok = [socket({ staleTokens: 0, state: 'ok', oldestAgeMs: 0 })]
  for (let i = 0; i < 4; i++) sweep(ok)
  assert.deepEqual(alarms, [])
  assert.deepEqual(repaired, [])
})

// ------------------------------------------------------------- the threshold

test('the freeze window defaults to three minutes', () => {
  // 3-6x the documented natural gap on a stock chain's wings (30-60s), and far
  // short of a session-long freeze.
  assert.equal(DEFAULT_FREEZE_STALE_MS, 180_000)
})

test('a mistyped freeze window falls back instead of becoming NaN', () => {
  // Every comparison against NaN is false, so a typo would silently DISABLE the
  // alarm it configures rather than fail loudly.
  const name = 'DESK_FREEZE_STALE_MS_TEST_ONLY'
  const restore = process.env[name]
  try {
    process.env[name] = 'three minutes'
    assert.equal(positiveEnvMs(name, 180_000), 180_000)
    process.env[name] = '0'
    assert.equal(positiveEnvMs(name, 180_000), 180_000, 'zero would mark every token stale')
    process.env[name] = '-5'
    assert.equal(positiveEnvMs(name, 180_000), 180_000)
    process.env[name] = '  '
    assert.equal(positiveEnvMs(name, 180_000), 180_000)
    process.env[name] = '240000'
    assert.equal(positiveEnvMs(name, 180_000), 240_000, 'a real override is honoured')
  } finally {
    if (restore === undefined) delete process.env[name]
    else process.env[name] = restore
  }
})
