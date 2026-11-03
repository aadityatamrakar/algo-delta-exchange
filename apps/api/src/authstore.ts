/**
 * Persistence for operator accounts and their sessions.
 *
 * `@algomaker/auth` owns every decision (hash, expiry, lockout arithmetic) and
 * this file owns only the two collections they are stored in. The split is
 * deliberate: the policy is pure and tested in milliseconds against an injected
 * clock, and nothing here has to be re-tested to prove that five failures lock
 * an account.
 *
 * Reached through the narrow `Database` port for the same reason as
 * `store.ts` — the mongo driver is pinned to 3.7.3 by LoopBack and is confined
 * to `mongo.ts`.
 */

import type { Database } from './store.ts'
import {
  DEFAULT_LOCKOUT_POLICY,
  isLockedOut,
  recordFailure,
  recordSuccess,
  type LockoutPolicy,
  type LoginState,
  type Session,
} from '@algomaker/auth'

export const AUTH_COLLECTIONS = {
  users: 'desk-users',
  sessions: 'desk-sessions',
} as const

/**
 * One row of `desk-users` (spec §3). `null` rather than an absent field for
 * every "not yet" value: `exactOptionalPropertyTypes` is on, and a document read
 * back from Mongo with a missing key would otherwise be a different type from
 * the one just written.
 */
export interface UserDoc {
  readonly username: string
  readonly passwordHash: string
  readonly createdAt: number
  readonly lastLoginAt: number | null
  readonly failedAttempts: number
  readonly lastFailureAt: number | null
  readonly lockedUntil: number | null
}

export interface SessionDoc {
  readonly token: string
  readonly username: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
}

/** Thrown by `createUser` when the account already exists. */
export class DuplicateUser extends Error {}

/** Thrown when a username would not round-trip through the normaliser. */
export class InvalidUsername extends Error {}

/**
 * `anonymous` is the principal name `server.ts` hands to PUBLIC routes before
 * anyone has authenticated. An account by that name would make a real operator
 * indistinguishable from a caller who presented nothing at all.
 */
const RESERVED_USERNAMES = new Set(['anonymous', 'bearer'])

/**
 * Usernames are lower-cased and trimmed on the way in AND on every lookup, so
 * `Admin` and `admin` cannot become two accounts with two passwords — with a
 * single operator, that would be an account nobody can log into and nobody can
 * see is wrong.
 */
export function normaliseUsername(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase()
}

export function assertUsername(raw: unknown): string {
  const username = normaliseUsername(raw)
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new InvalidUsername(
      'username must be 3-32 characters of a-z, 0-9, dot, underscore or hyphen',
    )
  }
  if (RESERVED_USERNAMES.has(username)) {
    throw new InvalidUsername(`"${username}" is reserved and cannot be an account name`)
  }
  return username
}

/** The lockout columns of a user row, in the shape `@algomaker/auth` operates on. */
export function loginStateOf(user: UserDoc): LoginState {
  return {
    failedAttempts: user.failedAttempts,
    lastFailureAt: user.lastFailureAt,
    lockedUntil: user.lockedUntil,
  }
}

/**
 * Expired sessions are swept lazily, at most this often, on the authentication
 * path. A `setInterval` would be tidier to read and worse to own: it keeps a
 * handle alive in every test that constructs a gate, and the work is trivial.
 */
const PURGE_INTERVAL_MS = 15 * 60 * 1000

/**
 * `lastSeenAt` is only rewritten when it is this stale. Without the floor every
 * authenticated request — the dashboard polls several endpoints a second — would
 * be a database write, which is a lot of IO to record a number nothing reads in
 * real time.
 */
const TOUCH_INTERVAL_MS = 60 * 1000

export class AuthStore {
  readonly #db: Database
  #lastPurgeAt = 0

  constructor(db: Database) {
    this.#db = db
  }

  /**
   * Both indexes are UNIQUE, and both are correctness rather than speed.
   *
   * Two rows for one username would make "what is this operator's password?"
   * depend on which document Mongo returns first — including after a password
   * reset that only rewrote one of them. Two rows for one session token is the
   * same problem for "when does this session expire?".
   */
  async ensureIndexes(): Promise<void> {
    await this.#db.collection(AUTH_COLLECTIONS.users).createIndex({ username: 1 }, { unique: true })
    await this.#db.collection(AUTH_COLLECTIONS.sessions).createIndex({ token: 1 }, { unique: true })
    await this.#db.collection(AUTH_COLLECTIONS.sessions).createIndex({ expiresAt: 1 })
  }

  // ----------------------------------------------------------------- users

  async countUsers(): Promise<number> {
    return await this.#db.collection(AUTH_COLLECTIONS.users).countDocuments({})
  }

  async listUsernames(): Promise<UserDoc[]> {
    const docs = await this.#db
      .collection<Partial<UserDoc>>(AUTH_COLLECTIONS.users)
      .find({})
      .sort({ username: 1 })
      .toArray()
    return docs.map((d) => normaliseUser(d)).filter((u): u is UserDoc => u !== null)
  }

  /** Null when the account does not exist. Callers must not turn that into a
   *  different HTTP response from a wrong password — see `routes/auth.ts`. */
  async findUser(username: unknown): Promise<UserDoc | null> {
    const name = normaliseUsername(username)
    if (name === '') return null
    const doc = await this.#db
      .collection<Partial<UserDoc>>(AUTH_COLLECTIONS.users)
      .findOne({ username: name })
    return doc === null ? null : normaliseUser(doc)
  }

  /**
   * Create the account. Throws `DuplicateUser` rather than upserting: there is
   * no signup endpoint, so the only caller is an operator at a terminal, and
   * silently overwriting an existing password on a typo'd `create` would lock
   * the real operator out of a live trading account.
   */
  async createUser(username: unknown, passwordHash: string, nowMs: number): Promise<UserDoc> {
    const name = assertUsername(username)
    const existing = await this.findUser(name)
    if (existing !== null) throw new DuplicateUser(`user "${name}" already exists`)
    const doc: UserDoc = {
      username: name,
      passwordHash,
      createdAt: nowMs,
      lastLoginAt: null,
      failedAttempts: 0,
      lastFailureAt: null,
      lockedUntil: null,
    }
    try {
      await this.#db.collection<UserDoc>(AUTH_COLLECTIONS.users).insertOne(doc)
    } catch (err) {
      // The unique index is the real guard; the read above only produces a
      // better message. Two `create` commands racing land here.
      throw new DuplicateUser(
        `user "${name}" already exists (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    return doc
  }

  /**
   * Replace the password and clear any lockout. Returns false when the account
   * does not exist — a reset must never conjure one, or a typo'd username would
   * create a second account while the real one keeps its old password.
   *
   * Every session is revoked: the point of a reset is usually that the old
   * password is compromised, and leaving live sessions running would defeat it.
   */
  async setPassword(username: unknown, passwordHash: string, nowMs: number): Promise<boolean> {
    const name = normaliseUsername(username)
    const user = await this.findUser(name)
    if (user === null) return false
    await this.#db.collection(AUTH_COLLECTIONS.users).updateOne(
      { username: name },
      { $set: { passwordHash, failedAttempts: 0, lastFailureAt: null, lockedUntil: null, passwordSetAt: nowMs } },
    )
    await this.revokeAllForUser(name)
    return true
  }

  /**
   * Count a failed attempt and return the state it produced, so the caller can
   * tell the operator when the lockout lifts.
   *
   * THE INCREMENT IS ATOMIC (`$inc`), not a read-modify-write.
   *
   * With `$set` from a value computed off our own read, N simultaneous attempts
   * each read `failedAttempts: 0` and each write `1` — so a burst of 200
   * concurrent guesses advanced the counter by one and every one of them got a
   * verdict. That turned a 5-attempts-per-15-minutes policy into roughly 200,
   * and lockout is the primary compensating control for this deployment's
   * accepted password-only risk (spec §7). `$inc` makes each attempt cost
   * exactly one attempt no matter how they interleave.
   *
   * The lockout instant is then derived from the true post-increment count, so
   * a burst that crosses the threshold locks on the request that crossed it.
   */
  async recordLoginFailure(
    username: unknown,
    nowMs: number,
    policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
  ): Promise<LoginState> {
    const name = normaliseUsername(username)
    const users = this.#db.collection(AUTH_COLLECTIONS.users)
    const res = await users.updateOne(
      { username: name },
      { $inc: { failedAttempts: 1 }, $set: { lastFailureAt: nowMs } },
    )
    if (res.matchedCount === 0) {
      return { failedAttempts: 0, lastFailureAt: nowMs, lockedUntil: null }
    }
    // Re-read to learn the TRUE count after every concurrent increment landed.
    const user = await this.findUser(name)
    if (user === null) return { failedAttempts: 0, lastFailureAt: nowMs, lockedUntil: null }
    const failedAttempts = user.failedAttempts
    const lockedUntil =
      failedAttempts >= policy.maxFailures ? nowMs + policy.lockoutMs : user.lockedUntil
    if (lockedUntil !== user.lockedUntil) {
      await users.updateOne({ username: name }, { $set: { lockedUntil } })
    }
    return { failedAttempts, lastFailureAt: nowMs, lockedUntil }
  }

  /** Clear the counters and stamp the login. */
  async recordLoginSuccess(username: unknown, nowMs: number): Promise<void> {
    const name = normaliseUsername(username)
    const user = await this.findUser(name)
    if (user === null) return
    await this.#db.collection(AUTH_COLLECTIONS.users).updateOne(
      { username: name },
      { $set: { ...recordSuccess(loginStateOf(user)), lastLoginAt: nowMs } },
    )
  }

  /**
   * Clear the counters WITHOUT stamping a login.
   *
   * A successful re-authentication (spec §5) proves the operator is still at the
   * keyboard, so it must reset the failure count — otherwise four fat-fingered
   * re-auth prompts would lock the account mid-session. It is not a login, so
   * `lastLoginAt` is left alone: that field is what tells an operator when
   * someone last got in.
   */
  async clearLoginFailures(username: unknown): Promise<void> {
    const name = normaliseUsername(username)
    await this.#db.collection(AUTH_COLLECTIONS.users).updateOne(
      { username: name },
      { $set: { failedAttempts: 0, lastFailureAt: null, lockedUntil: null } },
    )
  }

  isLockedOut(user: UserDoc, nowMs: number): boolean {
    return isLockedOut(loginStateOf(user), nowMs)
  }

  // -------------------------------------------------------------- sessions

  async saveSession(session: Session, nowMs: number): Promise<SessionDoc> {
    const doc: SessionDoc = {
      token: session.token,
      username: session.username,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: nowMs,
    }
    await this.#db.collection<SessionDoc>(AUTH_COLLECTIONS.sessions).insertOne(doc)
    return doc
  }

  /**
   * Look a token up verbatim.
   *
   * Expiry is NOT applied here — the caller decides, because the gate wants to
   * delete an expired row while the operator screen wants to say "expired" and
   * not "never existed".
   */
  async findSession(token: string): Promise<SessionDoc | null> {
    if (typeof token !== 'string' || token === '') return null
    const doc = await this.#db
      .collection<Partial<SessionDoc>>(AUTH_COLLECTIONS.sessions)
      .findOne({ token })
    if (doc === null || typeof doc.token !== 'string' || typeof doc.username !== 'string') return null
    return {
      token: doc.token,
      username: doc.username,
      createdAt: doc.createdAt ?? 0,
      // A row with no expiry is treated as ALREADY EXPIRED rather than eternal.
      // A missing field must never be the one that grants an unlimited session.
      expiresAt: doc.expiresAt ?? 0,
      lastSeenAt: doc.lastSeenAt ?? 0,
    }
  }

  async revokeSession(token: string): Promise<void> {
    if (typeof token !== 'string' || token === '') return
    await this.#db.collection(AUTH_COLLECTIONS.sessions).deleteOne({ token })
  }

  async revokeAllForUser(username: unknown): Promise<void> {
    const name = normaliseUsername(username)
    if (name === '') return
    await this.#db.collection(AUTH_COLLECTIONS.sessions).deleteMany({ username: name })
  }

  /** Touch `lastSeenAt`, but only when it is already stale — see `TOUCH_INTERVAL_MS`. */
  async touchSession(session: SessionDoc, nowMs: number): Promise<void> {
    if (nowMs - session.lastSeenAt < TOUCH_INTERVAL_MS) return
    await this.#db
      .collection(AUTH_COLLECTIONS.sessions)
      .updateOne({ token: session.token }, { $set: { lastSeenAt: nowMs } })
  }

  async purgeExpired(nowMs: number): Promise<number> {
    this.#lastPurgeAt = nowMs
    const before = await this.#db
      .collection(AUTH_COLLECTIONS.sessions)
      .countDocuments({ expiresAt: { $lte: nowMs } })
    await this.#db.collection(AUTH_COLLECTIONS.sessions).deleteMany({ expiresAt: { $lte: nowMs } })
    return before
  }

  /**
   * Purge at most once per `PURGE_INTERVAL_MS`. Never throws: a sweep that fails
   * because Mongo blipped must not turn an otherwise valid request into a 500 —
   * the rows it would have deleted are already refused on expiry.
   */
  async purgeExpiredIfDue(nowMs: number): Promise<void> {
    if (nowMs - this.#lastPurgeAt < PURGE_INTERVAL_MS) return
    this.#lastPurgeAt = nowMs
    try {
      await this.purgeExpired(nowMs)
    } catch {
      // Deliberately swallowed — see above.
    }
  }
}

/** A document straight out of Mongo, with every field defaulted. Returns null
 *  when the two fields that have no sane default are missing. */
function normaliseUser(doc: Partial<UserDoc>): UserDoc | null {
  if (typeof doc.username !== 'string' || typeof doc.passwordHash !== 'string') return null
  return {
    username: doc.username,
    passwordHash: doc.passwordHash,
    createdAt: doc.createdAt ?? 0,
    lastLoginAt: doc.lastLoginAt ?? null,
    failedAttempts: doc.failedAttempts ?? 0,
    lastFailureAt: doc.lastFailureAt ?? null,
    lockedUntil: doc.lockedUntil ?? null,
  }
}
