import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mintSession,
  isExpired,
  remainingMs,
  newSessionToken,
  SESSION_TOKEN_BYTES,
  DEFAULT_SESSION_TTL_MS,
} from '../src/index.ts'

// A fixed, injected clock. Nothing in this file calls Date.now().
const T0 = Date.UTC(2026, 6, 27, 3, 45) // 09:15 IST

test('mintSession stamps the injected clock, never the wall clock', () => {
  const s = mintSession('desk', T0, 60_000)
  assert.equal(s.username, 'desk')
  assert.equal(s.createdAt, T0)
  assert.equal(s.expiresAt, T0 + 60_000)
})

test('the token is URL-safe and carries at least 32 bytes of entropy', () => {
  assert.equal(SESSION_TOKEN_BYTES >= 32, true)
  const t = newSessionToken()
  assert.match(t, /^[A-Za-z0-9_-]+$/, `token must be URL-safe, got ${t}`)
  assert.equal(Buffer.from(t, 'base64url').length, SESSION_TOKEN_BYTES)
})

test('tokens are unique across mints', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 500; i++) seen.add(mintSession('desk', T0, 60_000).token)
  assert.equal(seen.size, 500)
})

test('expiry is exact AT the boundary and after it, on an injected clock', () => {
  const ttl = 60_000
  const s = mintSession('desk', T0, ttl)

  assert.equal(isExpired(s, T0), false, 'fresh session must be live')
  assert.equal(isExpired(s, T0 + ttl - 1), false, '1ms before expiry must still be live')
  // The boundary itself: [createdAt, expiresAt) — expired AT expiresAt.
  assert.equal(isExpired(s, T0 + ttl), true, 'must be expired exactly at expiresAt')
  assert.equal(isExpired(s, T0 + ttl + 1), true)
  assert.equal(isExpired(s, T0 + 86_400_000), true)
})

test('remainingMs counts down and floors at zero', () => {
  const s = mintSession('desk', T0, 60_000)
  assert.equal(remainingMs(s, T0), 60_000)
  assert.equal(remainingMs(s, T0 + 59_000), 1_000)
  assert.equal(remainingMs(s, T0 + 60_000), 0)
  assert.equal(remainingMs(s, T0 + 999_999), 0, 'never negative')
})

test('a nonsense TTL throws rather than minting a dead or eternal session', () => {
  assert.throws(() => mintSession('desk', T0, 0), RangeError)
  assert.throws(() => mintSession('desk', T0, -1), RangeError)
  assert.throws(() => mintSession('desk', T0, Number.NaN), RangeError)
  assert.throws(() => mintSession('desk', T0, Number.POSITIVE_INFINITY), RangeError)
  assert.throws(() => mintSession('desk', Number.NaN, 1000), RangeError)
})

test('the default TTL is short-lived — under a day', () => {
  assert.equal(DEFAULT_SESSION_TTL_MS > 0, true)
  assert.equal(DEFAULT_SESSION_TTL_MS <= 24 * 60 * 60 * 1000, true)
})
