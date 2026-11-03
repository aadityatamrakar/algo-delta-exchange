import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newLoginState,
  recordFailure,
  recordSuccess,
  isLockedOut,
  lockoutRemainingMs,
  DEFAULT_LOCKOUT_POLICY,
  type LoginState,
} from '../src/index.ts'

const T0 = Date.UTC(2026, 6, 27, 3, 45)
const POLICY = { maxFailures: 3, lockoutMs: 60_000 }

/** Apply n failures one second apart starting at `from`. */
const failTimes = (state: LoginState, n: number, from: number): LoginState => {
  let s = state
  for (let i = 0; i < n; i++) s = recordFailure(s, from + i * 1000, POLICY)
  return s
}

test('a fresh state is not locked out', () => {
  const s = newLoginState()
  assert.equal(s.failedAttempts, 0)
  assert.equal(s.lockedUntil, null)
  assert.equal(isLockedOut(s, T0), false)
})

test('failures below the threshold count but do not lock', () => {
  const s = failTimes(newLoginState(), 2, T0)
  assert.equal(s.failedAttempts, 2)
  assert.equal(s.lockedUntil, null)
  assert.equal(isLockedOut(s, T0 + 2000), false)
})

test('the Nth failure locks out for the cooling period', () => {
  const s = failTimes(newLoginState(), 3, T0)
  assert.equal(s.failedAttempts, 3)
  assert.equal(s.lockedUntil, T0 + 2000 + POLICY.lockoutMs)
  assert.equal(isLockedOut(s, T0 + 2000), true)
  assert.equal(lockoutRemainingMs(s, T0 + 2000), 60_000)
})

test('the lockout clears when the cooling period has passed, on an injected clock', () => {
  const s = failTimes(newLoginState(), 3, T0)
  const until = s.lockedUntil ?? 0
  assert.equal(isLockedOut(s, until - 1), true, '1ms before the boundary: still locked')
  // "until" is exclusive, matching session expiry.
  assert.equal(isLockedOut(s, until), false, 'at the boundary: cleared')
  assert.equal(isLockedOut(s, until + 1), false)
  assert.equal(lockoutRemainingMs(s, until), 0)
})

test('a failure after the lockout expires restarts the counter instead of re-locking instantly', () => {
  const locked = failTimes(newLoginState(), 3, T0)
  const after = (locked.lockedUntil ?? 0) + 1
  const s = recordFailure(locked, after, POLICY)
  assert.equal(s.failedAttempts, 1)
  assert.equal(s.lockedUntil, null)
  assert.equal(isLockedOut(s, after), false)
})

test('hammering during a lockout does not extend the window', () => {
  // Otherwise anyone on the internet could keep the real operator locked out.
  const locked = failTimes(newLoginState(), 3, T0)
  const until = locked.lockedUntil ?? 0
  let s = locked
  for (let i = 1; i <= 20; i++) s = recordFailure(s, T0 + 2000 + i * 100, POLICY)
  assert.equal(s.lockedUntil, until, 'lockedUntil must not move')
  assert.equal(s.failedAttempts, 23, 'attempts are still counted')
  assert.equal(isLockedOut(s, until), false)
})

test('recordSuccess resets the counter and clears an active lockout', () => {
  const two = failTimes(newLoginState(), 2, T0)
  const cleared = recordSuccess(two)
  assert.deepEqual(cleared, newLoginState())
  assert.equal(isLockedOut(cleared, T0), false)

  const locked = failTimes(newLoginState(), 3, T0)
  assert.equal(isLockedOut(locked, T0 + 2000), true)
  const unlocked = recordSuccess(locked)
  assert.equal(unlocked.failedAttempts, 0)
  assert.equal(unlocked.lockedUntil, null)
  assert.equal(isLockedOut(unlocked, T0 + 2000), false)
})

test('the state is never mutated in place — it is a value the caller persists', () => {
  const before = newLoginState()
  const snapshot = { ...before }
  const after = recordFailure(before, T0, POLICY)
  assert.deepEqual(before, snapshot)
  assert.notEqual(after, before)
  // Round-trips through JSON, because it lives in a Mongo document.
  assert.deepEqual(JSON.parse(JSON.stringify(after)), after)
})

test('the default policy locks after 5 failures for 15 minutes', () => {
  assert.deepEqual(DEFAULT_LOCKOUT_POLICY, { maxFailures: 5, lockoutMs: 15 * 60 * 1000 })
  const s = (() => {
    let st = newLoginState()
    for (let i = 0; i < 4; i++) st = recordFailure(st, T0 + i * 1000)
    return st
  })()
  assert.equal(isLockedOut(s, T0 + 3000), false, '4 failures: not yet locked')
  const fifth = recordFailure(s, T0 + 4000)
  assert.equal(isLockedOut(fifth, T0 + 4000), true)
  assert.equal(fifth.lockedUntil, T0 + 4000 + 15 * 60 * 1000)
})
