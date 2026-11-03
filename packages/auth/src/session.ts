/**
 * Session tokens for the desk portal.
 *
 * The token is the whole credential — there is no signature and no payload,
 * because the server looks the token up in `desk-sessions` anyway. A random
 * opaque string beats a self-validating JWT here for one reason: logout and
 * "kill every session" are a delete, not a revocation list.
 *
 * Every function takes `now` as an argument. Nothing in this file reads the
 * clock, so expiry is testable without waiting.
 */

import { randomBytes } from 'node:crypto'

/**
 * 32 bytes == 256 bits of entropy, base64url-encoded to 43 URL/cookie-safe
 * characters. Well past the point where guessing is the attacker's best move.
 */
export const SESSION_TOKEN_BYTES = 32

/**
 * 8 hours — one trading day. Short enough that a session left open on a laptop
 * dies overnight, long enough that the operator is not re-authenticating during
 * market hours. The two dangerous actions (enabling a live tag, releasing the
 * kill switch) re-ask for the password regardless of session age; see spec §5.
 */
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000

export interface Session {
  readonly token: string
  readonly username: string
  readonly createdAt: number
  readonly expiresAt: number
}

/** Everything expiry needs. Lets callers pass a Mongo document without reshaping it. */
export interface Expiring {
  readonly expiresAt: number
}

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

/**
 * Mint a session valid for `ttlMs` from `now`.
 *
 * A non-positive or non-finite TTL throws rather than minting: a config typo
 * would otherwise produce either a session that is dead on arrival or one that
 * never expires, and the second failure mode is silent.
 */
export function mintSession(username: string, now: number, ttlMs: number): Session {
  if (!Number.isFinite(now)) throw new RangeError(`mintSession: now must be finite, got ${now}`)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`mintSession: ttlMs must be a positive finite number, got ${ttlMs}`)
  }
  return {
    token: newSessionToken(),
    username,
    createdAt: now,
    expiresAt: now + ttlMs,
  }
}

/**
 * Validity is the half-open interval [createdAt, expiresAt): a session is
 * expired AT its expiry instant, not one millisecond later. The boundary is
 * defined explicitly because "expires at 17:00" that still works at 17:00 is
 * the kind of off-by-one nobody notices until an audit.
 */
export function isExpired(session: Expiring, now: number): boolean {
  return now >= session.expiresAt
}

/** Milliseconds of life left, floored at 0. For rendering a countdown. */
export function remainingMs(session: Expiring, now: number): number {
  return Math.max(0, session.expiresAt - now)
}
