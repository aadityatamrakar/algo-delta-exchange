/**
 * The `state` port: durable per-strategy state.
 *
 * This is the file that closes the legacy system's worst structural gap. Its
 * own conventions admit that an open position cannot be restored, because
 * positions lived in process memory — so a pm2 restart at 12:30 left a real
 * position with nothing managing it until somebody noticed. Anything a strategy
 * must survive a restart with is written here and read back by `onRecover()`
 * before job catch-up runs.
 *
 * Keys are namespaced by SCOPE, not by strategy class. Two strategies of the
 * same class (ORB_SCALP_BN and ORB_SCALP_NIFTY are the same class with
 * different configs) must never read each other's position.
 *
 * THE SCOPE IS `tag:mode`, NOT THE BARE TAG (`runner.ts:instanceKey`). A row
 * switched on for paper and live runs twice, and the second hazard is the same
 * as the first one degree further in: the live instance recovering the paper
 * instance's position would manage — and eventually flatten — a position that
 * does not exist on its rail, which places a real order against nothing. This
 * class does not know about modes; it namespaces by whatever string it is
 * given, and `main.ts` is where the two are kept apart.
 */

import type { StateStore } from '@algomaker/strategy-kit'

/** The narrow slice of the Mongo driver this needs. Same port style as `store.ts`. */
export interface StateCollection {
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>
  deleteOne(filter: Record<string, unknown>): Promise<unknown>
  createIndex(
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean; name?: string },
  ): Promise<unknown>
}

export const STATE_COLLECTION = 'desk-strategy-state'

export class MongoStateStore implements StateStore {
  readonly #c: StateCollection
  readonly #tag: string

  constructor(collection: StateCollection, tag: string) {
    this.#c = collection
    this.#tag = tag
  }

  /**
   * `(tag, key)` is UNIQUE. Without it a retried write could leave two
   * documents for one key and `get` would return whichever Mongo found first —
   * i.e. a position that flickers between two values across restarts.
   */
  static async ensureIndexes(collection: StateCollection): Promise<void> {
    await collection.createIndex({ tag: 1, key: 1 }, { unique: true })
  }

  async get<T>(key: string): Promise<T | null> {
    const doc = await this.#c.findOne({ tag: this.#tag, key })
    if (doc === null) return null
    const value = doc['value']
    return value === undefined ? null : (value as T)
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.#c.updateOne(
      { tag: this.#tag, key },
      { $set: { tag: this.#tag, key, value, updatedAt: Date.now() } },
      { upsert: true },
    )
  }

  async delete(key: string): Promise<void> {
    await this.#c.deleteOne({ tag: this.#tag, key })
  }
}
