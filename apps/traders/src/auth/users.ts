/**
 * Accounts of the traders app (`traders-users`): traders and admins.
 *
 * `@algomaker/auth` owns the decisions (hashing, lockout arithmetic); this file
 * owns where they are stored. The lockout counter restarts once a lockout has
 * expired, as the policy says; the desk's authstore.ts does not (deliberate
 * divergence). There is no signup: admins are made by the CLI,
 * traders by an admin.
 */

import {
  DEFAULT_LOCKOUT_POLICY, recordSuccess,
  type LockoutPolicy, type LoginState,
} from '@algomaker/auth'
import type { TradersDb } from '../db.ts'
import type { Role, TraderUser } from '../types.ts'

export const MIN_PASSWORD_LENGTH = 8

export class DuplicateUser extends Error {}
export class InvalidUsername extends Error {}
export class WeakPassword extends Error {}

/** Trimmed and lower-cased, on the way in AND on every lookup; '' for a non-string. */
export function normaliseUsername(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

export function assertUsername(raw: unknown): string {
  const name = normaliseUsername(raw)
  if (!/^[a-z0-9._-]{2,32}$/.test(name)) {
    throw new InvalidUsername('username must be 2-32 characters of a-z, 0-9, dot, underscore or hyphen')
  }
  return name
}

export function assertPassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPassword(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  return raw
}

export function loginStateOf(u: TraderUser): LoginState {
  return { failedAttempts: u.failedAttempts, lastFailureAt: u.lastFailureAt, lockedUntil: u.lockedUntil }
}

export class TraderStore {
  readonly #db: TradersDb

  constructor(db: TradersDb) {
    this.#db = db
  }

  #users() {
    return this.#db.collection<Partial<TraderUser>>('traders-users')
  }

  /** Throws `DuplicateUser` rather than upserting: a typo must not overwrite a password. */
  async create(username: unknown, passwordHash: string, role: Role, nowMs: number): Promise<TraderUser> {
    const name = assertUsername(username)
    if (await this.find(name) !== null) throw new DuplicateUser(`user "${name}" already exists`)
    const doc: TraderUser = {
      username: name, passwordHash, role, disabled: false, createdAt: nowMs,
      lastLoginAt: null, failedAttempts: 0, lastFailureAt: null, lockedUntil: null,
    }
    try {
      await this.#users().insertOne(doc)
    } catch (err) {
      // The unique index is the real guard; two creates racing land here. Any
      // other failure (not primary, write concern) is not a duplicate.
      if ((err as { code?: unknown } | null)?.code === 11000) {
        throw new DuplicateUser(`user "${name}" already exists`, { cause: err })
      }
      throw err
    }
    return doc
  }

  async find(username: unknown): Promise<TraderUser | null> {
    const name = normaliseUsername(username)
    if (name === '') return null
    const doc = await this.#users().findOne({ username: name })
    return doc === null ? null : normaliseUser(doc)
  }

  async list(role?: Role): Promise<TraderUser[]> {
    const docs = await this.#users().find(role === undefined ? {} : { role }).sort({ username: 1 }).toArray()
    return docs.map(normaliseUser).filter((u): u is TraderUser => u !== null)
  }

  /** Also clears any lockout. False when the account does not exist (a reset never conjures one). */
  async setPassword(username: unknown, passwordHash: string): Promise<boolean> {
    const res = await this.#users().updateOne(
      { username: normaliseUsername(username) },
      { $set: { passwordHash, failedAttempts: 0, lastFailureAt: null, lockedUntil: null } },
    )
    return (res.matchedCount ?? 0) > 0
  }

  async setDisabled(username: unknown, disabled: boolean): Promise<boolean> {
    const res = await this.#users().updateOne({ username: normaliseUsername(username) }, { $set: { disabled } })
    return (res.matchedCount ?? 0) > 0
  }

  /**
   * Count a failed attempt and return the state it produced.
   *
   * The increment is atomic (`$inc`), not read-modify-write: with `$set` from a
   * value computed off our own read, a burst of concurrent guesses each read 0
   * and each wrote 1, turning five attempts into hundreds. The lockout instant
   * comes from the true post-increment count.
   */
  async recordLoginFailure(
    username: unknown, nowMs: number, policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
  ): Promise<LoginState> {
    const name = normaliseUsername(username)
    // An expired lockout restarts the counter (the @algomaker/auth policy
    // contract). Deliberate divergence from apps/api authstore.ts, which
    // leaves the stale count and re-locks on one wrong guess.
    await this.#users().updateOne(
      { username: name, lockedUntil: { $ne: null, $lte: nowMs } },
      { $set: { failedAttempts: 0, lockedUntil: null } },
    )
    const res = await this.#users().updateOne(
      { username: name }, { $inc: { failedAttempts: 1 }, $set: { lastFailureAt: nowMs } },
    )
    const none: LoginState = { failedAttempts: 0, lastFailureAt: nowMs, lockedUntil: null }
    if ((res.matchedCount ?? 0) === 0) return none
    const user = await this.find(name)
    if (user === null) return none
    const lockedUntil = user.failedAttempts >= policy.maxFailures ? nowMs + policy.lockoutMs : user.lockedUntil
    if (lockedUntil !== user.lockedUntil) await this.#users().updateOne({ username: name }, { $set: { lockedUntil } })
    return { failedAttempts: user.failedAttempts, lastFailureAt: nowMs, lockedUntil }
  }

  async recordLoginSuccess(username: unknown, nowMs: number): Promise<void> {
    const name = normaliseUsername(username)
    const user = await this.find(name)
    if (user === null) return
    await this.#users().updateOne({ username: name }, { $set: { ...recordSuccess(loginStateOf(user)), lastLoginAt: nowMs } })
  }

  async clearLoginFailures(username: unknown): Promise<void> {
    await this.#users().updateOne(
      { username: normaliseUsername(username) },
      { $set: { failedAttempts: 0, lastFailureAt: null, lockedUntil: null } },
    )
  }
}

/** Every field defaulted; null when a field with no sane default is missing. */
function normaliseUser(d: Partial<TraderUser>): TraderUser | null {
  if (typeof d.username !== 'string' || typeof d.passwordHash !== 'string') return null
  return {
    username: d.username,
    passwordHash: d.passwordHash,
    // A missing role is the LEAST privileged one, never admin.
    role: d.role === 'admin' ? 'admin' : 'trader',
    disabled: d.disabled === true,
    createdAt: d.createdAt ?? 0,
    lastLoginAt: d.lastLoginAt ?? null,
    failedAttempts: d.failedAttempts ?? 0,
    lastFailureAt: d.lastFailureAt ?? null,
    lockedUntil: d.lockedUntil ?? null,
  }
}
