/**
 * ONE SUPERVISOR STEERS, THE OTHER WAITS.
 *
 * Two supervisors on one book is the worst failure this process has. They do
 * not fight over a lock and stall — they both work, perfectly, against the
 * same broker position: two recenters off the same shift, two sells of the
 * same strike, and a book that ends the day at twice the size anybody chose.
 * Nothing downstream can tell the difference, because each decision is
 * individually correct and individually idempotent. The Python desk's answer
 * was a pm2 process name and a human remembering; a deploy that started the
 * new supervisor before the old one had finished dying is all it took.
 *
 * The lease is a single document, `{key, owner, expiresAt}`, and the claim is
 * a CONDITIONAL update: `key` matches, AND (the owner is already us, OR the
 * lease has EXPIRED). Of two supervisors racing for a free lease exactly one
 * wins — the loser's filter matches nothing, its upsert collides with the
 * `key` UNIQUE INDEX, and it is told `false` rather than being handed a second
 * document. That index is load bearing; `ensureIndexes()` must run first.
 *
 * ── WHY A TTL AND NOT A FLAG ────────────────────────────────────────────────
 * A supervisor that is SIGKILLed, wedged on a socket, or paused by the OS
 * never releases anything. A flag would be held forever by a process that no
 * longer exists and the book would go unsteered for the rest of the session —
 * which, on a short-premium book, is not the safe direction. So the lease
 * lapses on its own and `heartbeat()` is what keeps it alive.
 *
 * ── WHY heartbeat() RETURNS A BOOLEAN ───────────────────────────────────────
 * Because the holder has to be able to LEARN IT LOST. A process paused past
 * the TTL wakes up believing it steers; its heartbeat is fenced on `owner`, so
 * once somebody else has taken over it matches nothing and answers `false`.
 * That is the caller's signal to stop deciding — the same fencing discipline
 * as `apps/order-gateway/src/queue.ts`, where an unfenced write let a stalled
 * worker overwrite the reclaimer's outcome. `release()` is fenced for the same
 * reason: a zombie shutting down cleanly must not delete the lease of the
 * supervisor that replaced it.
 *
 * A heartbeat whose own lease has quietly lapsed but which NOBODY has taken
 * still succeeds, deliberately: a GC pause that outran the TTL should cost a
 * beat, not the book.
 */

import { isDuplicateKey } from '../../api/src/errors.ts'

/** THE collection. This file owns the name. */
export const SUPERVISOR_LEASE_COLLECTION = 'desk-supervisor-lease'

/** Minimal Mongo surface — same narrow-port reasoning as `state-store.ts`. */
export interface LeaseCollection {
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>
  deleteOne(filter: Record<string, unknown>): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

export interface LeaseDeps {
  readonly collection: LeaseCollection
  /**
   * WHAT THIS LEASE MAKES EXCLUSIVE. One key, one steering process: the
   * supervisor takes a process-wide key today, and the same class scopes to
   * `${tag}:${mode}` the day books are spread across machines.
   */
  readonly key: string
  /** Injected so a test can jump a TTL instead of sleeping through one. */
  readonly now: () => number
}

/**
 * Did the update reach a document?
 *
 * `undefined` where the driver reports nothing is read as NOT OURS — the
 * opposite of `queue.ts`'s reading of the same silence, and deliberately so.
 * There, guessing wrong abandons a healthy placement; here, guessing wrong
 * leaves two supervisors steering one book. The unsafe direction is different,
 * so the default is too.
 */
function matchedOne(res: unknown): boolean {
  if (res === null || typeof res !== 'object' || !('matchedCount' in res)) return false
  return (res as { matchedCount?: unknown }).matchedCount === 1
}

export class Lease {
  readonly #d: LeaseDeps
  /** The owner id of the lease we currently believe we hold. */
  #owner: string | null = null
  #ttlMs = 0
  /** The in-flight-or-finished index build; see `#indexed`. */
  #indexes: Promise<void> | null = null

  constructor(deps: LeaseDeps) {
    this.#d = deps
  }

  /** The owner id we hold the lease under, or null. For `/health`. */
  get owner(): string | null {
    return this.#owner
  }

  /**
   * The unique index the claim is built on. See the header: without it the
   * loser of a race inserts a second lease document instead of being refused,
   * and both supervisors then hold "the" lease.
   *
   * Idempotent, and cheap to call — the build happens ONCE per instance and
   * every later call awaits the same promise.
   */
  async ensureIndexes(): Promise<void> {
    await this.#indexed()
  }

  /**
   * The index, guaranteed, before any claim — WITHOUT depending on a boot path
   * remembering to ask for it.
   *
   * The exclusion this class exists for IS the unique key: with the index
   * missing, two supervisors racing for a free lease both insert, both are
   * told `true`, and both steer. That is the failure mode the whole file is
   * about, and it must not be reachable by forgetting a call. Cached, so it is
   * one `createIndex` per instance; cleared on failure so the next claim
   * retries instead of inheriting a rejection, and until it succeeds no claim
   * goes out unguarded.
   */
  async #indexed(): Promise<void> {
    this.#indexes ??= this.#d.collection
      .createIndex({ key: 1 }, { unique: true })
      .then(() => undefined)
      .catch((err: unknown) => {
        this.#indexes = null
        throw err
      })
    await this.#indexes
  }

  /**
   * Take the lease, or find out somebody else has it.
   *
   * `false` is not an error and not a reason to exit: the caller waits and
   * asks again (a second supervisor is a STANDBY, not a crash). Re-acquiring
   * under an owner id we already hold RENEWS — it is not a self-deadlock.
   */
  async acquire(owner: string, ttlMs: number): Promise<boolean> {
    /**
     * A TTL that is not a positive number is not a lease.
     *
     * `now + NaN` is `NaN`, and `NaN` compares false against every `$lte` — so
     * a TTL fumbled out of an unset env var writes a lease that NEVER expires
     * and no supervisor, including this one after a restart, can ever take the
     * book again. It fails silently and it fails for the rest of the session,
     * so it is refused here where the mistake is.
     */
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`lease ttlMs must be a positive number, got ${String(ttlMs)}`)
    }
    await this.#indexed()
    const now = this.#d.now()
    try {
      await this.#d.collection.findOneAndUpdate(
        {
          key: this.#d.key,
          $or: [
            { owner },
            // Free means EXPIRED, because a dead holder never says so itself.
            { expiresAt: { $lte: now } },
            // A lease with no expiry at all — an older document, a hand-repair
            // in the shell — would otherwise be held forever by nobody. Mongo
            // reads `null` as "missing or null", which is both of those cases.
            { expiresAt: null },
          ],
        },
        { $set: { key: this.#d.key, owner, acquiredAt: now, expiresAt: now + ttlMs } },
        // Upsert, so the very first supervisor has a path at all. The loser of
        // that race collides with the unique key rather than getting its own.
        { upsert: true },
      )
    } catch (err) {
      if (isDuplicateKey(err)) return false
      throw err
    }
    this.#owner = owner
    this.#ttlMs = ttlMs
    return true
  }

  /**
   * Push the expiry out — and report whether the lease is still ours.
   *
   * `false` means somebody took it while we were away. The caller must stop
   * steering; it may `acquire` again, but only as a fresh claim.
   */
  async heartbeat(): Promise<boolean> {
    const owner = this.#owner
    if (owner === null) return false
    const res = await this.#d.collection.updateOne(
      { key: this.#d.key, owner },
      { $set: { expiresAt: this.#d.now() + this.#ttlMs } },
    )
    if (matchedOne(res)) return true
    // Forget it here, so a later `release()` cannot delete the new holder's.
    this.#owner = null
    return false
  }

  /**
   * Hand the lease straight over, without the next supervisor waiting out a
   * TTL. Fenced on `owner`: a process that has already lost the lease releases
   * NOTHING. Silent when we never held one — shutdown is not the place to
   * throw.
   */
  async release(): Promise<void> {
    const owner = this.#owner
    if (owner === null) return
    this.#owner = null
    await this.#d.collection.deleteOne({ key: this.#d.key, owner })
  }
}
