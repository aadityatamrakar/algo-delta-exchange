/**
 * The write gate of the traders app.
 *
 * `TradersDb` is the only thing in apps/traders (besides `main.ts` and
 * `user-cli.ts`, which build it) that holds the raw `Database`. It hands out
 * collections by NAME from a closed list, so a bug or a hostile string can not
 * make this app write to a desk collection (`positional`, `desk-books`, ...).
 * The desk's `instrument` and `desk-marks` are reachable read-only, and the one
 * desk write is the traders token-subscription document.
 *
 * The list is checked at RUNTIME, not only by the type: names arrive from
 * store classes today, but a cast is one `as never` away.
 */

import { publishSubscription } from '../../marketdata/src/subscription-store.ts'
import type { Database } from '../../api/src/store.ts'

export const TRADERS_COLLECTIONS = [
  'traders-users',
  'traders-sessions',
  'traders-tokens',
  'traders-files',
  'traders-file-versions',
  'traders-legs',
  'traders-orders',
  'traders-trades',
  'traders-log',
  'traders-settings',
  'traders-events',
  'traders-groups',
  'traders-assistant',
  'traders-daily',
  'traders-alerts',
  'traders-push',
] as const
export type TradersCollection = (typeof TRADERS_COLLECTIONS)[number]

export const DESK_READ_COLLECTIONS = ['instrument', 'desk-marks'] as const
export type DeskReadCollection = (typeof DESK_READ_COLLECTIONS)[number]

/** The `source` of this app's document in `desk-subscriptions`. */
export const SUBSCRIPTION_SOURCE = 'traders'

const SUBSCRIPTIONS = 'desk-subscriptions'

const ALLOWED_WRITE: ReadonlySet<string> = new Set(TRADERS_COLLECTIONS)
const ALLOWED_READ: ReadonlySet<string> = new Set(DESK_READ_COLLECTIONS)

export class ForbiddenCollection extends Error {
  constructor(name: string) {
    super(`collection not allowed for the traders app: ${JSON.stringify(name)}`)
    this.name = 'ForbiddenCollection'
  }
}

export interface Cursor<T> {
  sort(s: Record<string, 1 | -1>): Cursor<T>
  limit(n: number): Cursor<T>
  toArray(): Promise<T[]>
  /** One document at a time, null past the last: a reader that must not hold a whole collection (the assistant's export). */
  next(): Promise<T | null>
  close(): Promise<unknown>
}

export interface FindOptions { readonly projection?: Record<string, 0 | 1> }

export interface TradersCollectionPort<T> {
  findOne(f: Record<string, unknown>, o?: FindOptions): Promise<T | null>
  find(f: Record<string, unknown>, o?: FindOptions): Cursor<T>
  insertOne(doc: T): Promise<unknown>
  updateOne(
    f: Record<string, unknown>,
    u: Record<string, unknown>,
    o?: { upsert?: boolean },
  ): Promise<{ matchedCount?: number; upsertedCount?: number }>
  updateMany(f: Record<string, unknown>, u: Record<string, unknown>): Promise<unknown>
  deleteOne(f: Record<string, unknown>): Promise<unknown>
  deleteMany(f: Record<string, unknown>): Promise<unknown>
  countDocuments(f: Record<string, unknown>): Promise<number>
  /** The driver's distinct (settle-job lists the traders off an index with it). */
  distinct(key: string, f?: Record<string, unknown>): Promise<unknown[]>
  /** A READ pipeline ($match, $group, …), never $out or $merge: the data status counts a trader's rows per day with one. */
  aggregate(pipeline: readonly Record<string, unknown>[]): { toArray(): Promise<Record<string, unknown>[]> }
  createIndex(
    spec: Record<string, 1 | -1>,
    // expireAfterSeconds: a TTL index (traders-alerts); its field must hold a BSON Date, not epoch ms
    o?: { unique?: boolean; name?: string; partialFilterExpression?: Record<string, unknown>; expireAfterSeconds?: number },
  ): Promise<unknown>
}

export interface ReadOnlyCollection<T> {
  findOne: TradersCollectionPort<T>['findOne']
  find: TradersCollectionPort<T>['find']
  countDocuments: TradersCollectionPort<T>['countDocuments']
}

export class TradersDb {
  readonly #raw: Database

  constructor(raw: Database) {
    this.#raw = raw
  }

  collection<T = Record<string, unknown>>(name: TradersCollection): TradersCollectionPort<T> {
    if (!ALLOWED_WRITE.has(name)) throw new ForbiddenCollection(name)
    // The desk's `Collection` port declares fewer methods than the driver has
    // (no updateMany, no find options); the driver 3.7 behind it does.
    return this.#raw.collection<T>(name) as unknown as TradersCollectionPort<T>
  }

  /** A desk collection, read only: a NEW object holding just the three read methods. */
  desk<T = Record<string, unknown>>(name: DeskReadCollection): ReadOnlyCollection<T> {
    if (!ALLOWED_READ.has(name)) throw new ForbiddenCollection(name)
    const c = this.#raw.collection<T>(name) as unknown as TradersCollectionPort<T>
    return {
      findOne: (f, o) => c.findOne(f, o),
      find: (f, o) => c.find(f, o),
      countDocuments: (f) => c.countDocuments(f),
    }
  }

  /** Declare the instrument tokens this app wants on the live feed (complete set, not a delta). */
  async publishSubscription(tokens: readonly number[], nowMs: number): Promise<void> {
    const col = this.#raw.collection(SUBSCRIPTIONS)
    await publishSubscription(col, SUBSCRIPTION_SOURCE, tokens, nowMs)
  }

  async ensureIndexes(): Promise<void> {
    const c = <T>(n: TradersCollection): TradersCollectionPort<T> => this.collection<T>(n)
    await c('traders-users').createIndex({ username: 1 }, { unique: true })
    await c('traders-sessions').createIndex({ tokenHash: 1 }, { unique: true })
    await c('traders-sessions').createIndex({ expiresAt: 1 })
    await c('traders-tokens').createIndex({ tokenHash: 1 }, { unique: true })
    await c('traders-tokens').createIndex(
      { trader: 1 },
      {
        unique: true,
        name: 'one_active_token_per_trader',
        partialFilterExpression: { revokedAt: { $type: 'null' } },
      },
    )
    await c('traders-files').createIndex({ trader: 1, path: 1 }, { unique: true })
    // the data status counts a trader's files by the day their PC wrote them: a covered range, no file content read (analytics/data-status.ts)
    await c('traders-files').createIndex({ trader: 1, mtime: -1, path: 1 })
    await c('traders-file-versions').createIndex({ trader: 1, path: 1, receivedAt: -1 })
    await c('traders-file-versions').createIndex({ receivedAt: 1 })
    await c('traders-legs').createIndex({ trader: 1, key: 1 }, { unique: true })
    await c('traders-legs').createIndex({ trader: 1, stock: 1 })
    await c('traders-orders').createIndex({ trader: 1, day: 1, orderNo: 1 }, { unique: true })
    await c('traders-trades').createIndex(
      { trader: 1, day: 1, tradeNo: 1, orderNo: 1 },
      { unique: true },
    )
    await c('traders-trades').createIndex({ trader: 1, day: 1 })
    // one stock's live contracts (series-pnl.ts, the MTM block): without it each book read walks the trader's whole history
    await c('traders-trades').createIndex({ trader: 1, stock: 1, expiry: 1 })
    await c('traders-log').createIndex({ trader: 1, day: 1, seq: 1 }, { unique: true })
    await c('traders-settings').createIndex({ kind: 1, trader: 1 }, { unique: true })
    // the daily record: one row per book and day, written once; a trader's days newest first for the Daily page
    await c('traders-daily').createIndex({ trader: 1, stock: 1, day: 1 }, { unique: true })
    await c('traders-daily').createIndex({ trader: 1, day: -1 })
  }
}
