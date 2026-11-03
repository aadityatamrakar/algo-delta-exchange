/**
 * Watcher bearer tokens (`traders-tokens`). Shown once at issue, stored as
 * sha256, one active per trader (a unique partial index enforces it).
 */

import { randomBytes } from 'node:crypto'
import type { TradersDb } from '../db.ts'
import { sha256hex } from '../hash.ts'
import type { WatcherToken } from '../types.ts'
import { normaliseUsername } from './users.ts'

const TOUCH_INTERVAL_MS = 60 * 1000

export class WatcherTokens {
  readonly #db: TradersDb

  constructor(db: TradersDb) {
    this.#db = db
  }

  #col() {
    return this.#db.collection<WatcherToken>('traders-tokens')
  }

  /** Revokes the active token, if any, and returns the new plain token. Never stored. */
  async issue(traderName: string, nowMs: number): Promise<string> {
    const trader = normaliseUsername(traderName)
    await this.revoke(trader, nowMs)
    const plain = randomBytes(32).toString('base64url')
    await this.#col().insertOne({
      trader, tokenHash: sha256hex(plain), createdAt: nowMs, lastUsedAt: null, revokedAt: null,
    })
    return plain
  }

  /** False when none was active. */
  async revoke(traderName: string, nowMs: number): Promise<boolean> {
    const trader = normaliseUsername(traderName)
    const res = await this.#col().updateOne({ trader, revokedAt: null }, { $set: { revokedAt: nowMs } })
    return (res.matchedCount ?? 0) > 0
  }

  async active(traderName: string): Promise<WatcherToken | null> {
    const trader = normaliseUsername(traderName)
    return await this.#col().findOne({ trader, revokedAt: null })
  }

  async authenticate(plain: string, nowMs: number): Promise<WatcherToken | null> {
    if (typeof plain !== 'string' || plain === '') return null
    const tokenHash = sha256hex(plain)
    const t = await this.#col().findOne({ tokenHash, revokedAt: null })
    if (t === null) return null
    if (t.lastUsedAt === null || nowMs - t.lastUsedAt >= TOUCH_INTERVAL_MS) {
      await this.#col().updateOne({ tokenHash }, { $set: { lastUsedAt: nowMs } })
    }
    return t
  }
}
