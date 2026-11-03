/**
 * `traders-alerts`: every alert raised, whether or not a phone took it, for the bell and the record. One row per
 * dedupe key (unique), so a rule repeating itself, a second process or a restart never alerts twice. Rows expire
 * ALERT_TTL_DAYS after the alert (a TTL index, which reads a BSON Date: `expiresAt`, beside the epoch-ms `at`).
 */

import type { TradersDb } from '../db.ts'
import type { AlertKind, TraderAlert } from '../types.ts'
import type { AlertDraft } from './rules.ts'

export const ALERT_TTL_DAYS = 30
const DAY_MS = 86_400_000
/** The bell reads at most this many, newest first. */
export const FEED_MAX = 200

interface AlertDoc extends AlertDraft {
  readonly sentAt: number | null
  readonly expiresAt: Date
}

const isDuplicateKey = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 11000

export class AlertStore {
  readonly #db: TradersDb

  constructor(db: TradersDb) {
    this.#db = db
  }

  async ensureIndexes(): Promise<void> {
    await this.#col().createIndex({ dedupeKey: 1 }, { unique: true })
    await this.#col().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    await this.#col().createIndex({ trader: 1, at: -1 })
  }

  /** True when this is the first alert with its key (and so is to be sent); false when it was raised before. */
  async add(d: AlertDraft): Promise<boolean> {
    const doc: AlertDoc = { ...d, sentAt: null, expiresAt: new Date(d.at + ALERT_TTL_DAYS * DAY_MS) }
    try {
      await this.#col().insertOne(doc)
      return true
    } catch (err) {
      if (isDuplicateKey(err)) return false
      throw err
    }
  }

  async sent(dedupeKey: string, at: number): Promise<void> {
    await this.#col().updateOne({ dedupeKey }, { $set: { sentAt: at } })
  }

  /** The alerts of `owners` (a trader's name; null = the admin-wide ones) from `since`, newest first. */
  async feed(owners: readonly (string | null)[], since: number, limit = FEED_MAX): Promise<TraderAlert[]> {
    const rows = await this.#col()
      .find({ trader: { $in: [...owners] }, at: { $gte: since } }, { projection: { _id: 0, dedupeKey: 0, expiresAt: 0 } })
      .sort({ at: -1 })
      .limit(limit)
      .toArray()
    return rows.map((r) => ({
      kind: r.kind, stock: r.stock ?? null, title: r.title, body: r.body, url: r.url, at: r.at,
      sentAt: typeof r.sentAt === 'number' ? r.sentAt : null, admin: r.trader === null,
    }))
  }

  /** When the trader's newest alert of `kind` on `stock` was raised; null = none kept. */
  async lastAt(kind: AlertKind, trader: string, stock: string): Promise<number | null> {
    const [r] = await this.#col().find({ trader, kind, stock }, { projection: { _id: 0, at: 1 } }).sort({ at: -1 }).limit(1).toArray()
    return r === undefined ? null : r.at
  }

  #col() {
    return this.#db.collection<AlertDoc>('traders-alerts')
  }
}
