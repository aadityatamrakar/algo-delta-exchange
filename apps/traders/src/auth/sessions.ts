/**
 * Browser sessions (`traders-sessions`). The cookie holds a random token; the
 * database holds only its sha256, so a leaked collection is not a set of logins.
 */

import { mintSession } from '@algomaker/auth'
import type { TradersDb } from '../db.ts'
import { sha256hex } from '../hash.ts'
import { normaliseUsername } from './users.ts'

export interface SessionRow {
  readonly tokenHash: string
  readonly username: string
  readonly expiresAt: number
  readonly lastSeenAt: number
}

const PURGE_INTERVAL_MS = 15 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 1000

export class SessionStore {
  readonly #db: TradersDb
  #lastPurgeAt = 0

  constructor(db: TradersDb) {
    this.#db = db
  }

  #col() {
    return this.#db.collection<Partial<SessionRow> & { createdAt?: number }>('traders-sessions')
  }

  async create(username: string, nowMs: number, ttlMs: number): Promise<{ token: string; expiresAt: number }> {
    const s = mintSession(username, nowMs, ttlMs)
    await this.#col().insertOne({
      tokenHash: sha256hex(s.token), username, createdAt: nowMs, expiresAt: s.expiresAt, lastSeenAt: nowMs,
    })
    return { token: s.token, expiresAt: s.expiresAt }
  }

  /** Expiry is the caller's call, so the gate can delete an expired row. */
  async find(token: string): Promise<SessionRow | null> {
    if (typeof token !== 'string' || token === '') return null
    const d = await this.#col().findOne({ tokenHash: sha256hex(token) })
    if (d === null || typeof d.tokenHash !== 'string' || typeof d.username !== 'string') return null
    // A row with no expiry is already expired, never eternal.
    return { tokenHash: d.tokenHash, username: d.username, expiresAt: d.expiresAt ?? 0, lastSeenAt: d.lastSeenAt ?? 0 }
  }

  async revoke(token: string): Promise<void> {
    if (typeof token !== 'string' || token === '') return
    await this.#col().deleteOne({ tokenHash: sha256hex(token) })
  }

  async revokeAll(username: string): Promise<void> {
    const name = normaliseUsername(username)
    if (name === '') return
    await this.#col().deleteMany({ username: name })
  }

  /** Only when `lastSeenAt` is 60 s stale: not a write per request. */
  async touch(s: { tokenHash: string; lastSeenAt: number }, nowMs: number): Promise<void> {
    if (nowMs - s.lastSeenAt < TOUCH_INTERVAL_MS) return
    await this.#col().updateOne({ tokenHash: s.tokenHash }, { $set: { lastSeenAt: nowMs } })
  }

  /** At most every 15 minutes; never throws, an expired row is refused anyway. */
  async purgeExpiredIfDue(nowMs: number): Promise<void> {
    if (nowMs - this.#lastPurgeAt < PURGE_INTERVAL_MS) return
    this.#lastPurgeAt = nowMs
    try {
      await this.#col().deleteMany({ expiresAt: { $lte: nowMs } })
    } catch {
      // swallowed on purpose
    }
  }
}
