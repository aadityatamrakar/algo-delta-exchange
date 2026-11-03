/**
 * Broker credentials at rest.
 *
 * THE WHOLE CREDENTIAL BLOB IS ONE SEALED VALUE under `secret` (spec §3). Not a
 * sealed field per credential: adding a field to a broker's login then costs a
 * schema change and a migration, and a field somebody forgot to seal looks
 * exactly like one they did. One opaque blob makes "is this row encrypted?" a
 * property of the row rather than of each key in it.
 *
 * `meta` is the mirror-image decision — it holds ONLY non-sensitive values (base
 * URL, user id) so the Brokers page can render a useful card without opening
 * anything, and so a page that fails to open the ciphertext still shows which
 * account it was for.
 */

import {
  keyFromEnvValue,
  open,
  seal,
  MASTER_KEY_MISMATCH,
  SecretKeyError,
  SecretOpenError,
} from '@algomaker/secrets'
import type { Database } from './store.ts'

export const BROKER_COLLECTION = 'desk-brokers'

/** The brokers this desk can hold credentials for. Delta routes orders (the
 *  Delta desk, spec §5.4); Zerodha is market data only (spec D1) but still
 *  needs a verifiable login. XTS is gone from this desk. */
export type BrokerKind = 'delta' | 'zerodha'

export const BROKER_KINDS: readonly BrokerKind[] = ['delta', 'zerodha']

export function isBrokerKind(v: unknown): v is BrokerKind {
  return v === 'delta' || v === 'zerodha'
}

/**
 * `unreadable` is DISTINCT from `absent` and that distinction is the reason this
 * type exists. "No XTS configured" is fixed by entering credentials; "XTS
 * configured but the ciphertext will not open" means the master key was rotated
 * or the row was tampered with, and entering credentials over the top would
 * destroy the evidence of which it was.
 */
export type BrokerState = 'absent' | 'ok' | 'error' | 'unreadable'

export interface BrokerRow {
  readonly kind: BrokerKind
  readonly label: string
  readonly meta: Record<string, string | number | boolean>
  readonly configured: boolean
  readonly state: BrokerState
  readonly lastVerifiedAt: number | null
  readonly lastError: string
}

export type BrokerSecretRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly secret: Record<string, unknown> }
  | { readonly kind: 'unreadable'; readonly reason: string }

interface BrokerDoc {
  readonly kind: BrokerKind
  readonly label?: string
  readonly secret?: string
  readonly meta?: Record<string, unknown>
  readonly updatedAt?: number
  readonly lastVerifiedAt?: number | null
  readonly lastError?: string
}

/**
 * Keys that never belong in `meta`.
 *
 * `meta` is echoed back by `GET /v1/desk/brokers`, so a credential that lands
 * there is a credential the API returns — the one invariant this module has.
 * Filtering on write AND on read is deliberate: the read-side filter also
 * protects rows written before this check existed, or by hand in a Mongo shell.
 */
const SENSITIVE_META_KEY = /pass|secret|token|key|totp|auth|pin|otp|cred/i

/**
 * `DESK_MASTER_KEY` as a validated 32-byte key, or a thrown error naming the
 * problem.
 *
 * Spec §7: this fails at BOOT, loudly. Starting with credentials that cannot be
 * opened would surface hours later as an inexplicable broker login failure in
 * the middle of a trading session. Called from the route factory and from
 * `createAuthGate`, both of which `main.ts` invokes before it listens.
 */
export function requireMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['DESK_MASTER_KEY']
  if (raw === undefined || raw.trim() === '') {
    throw new SecretKeyError(
      'DESK_MASTER_KEY is required — broker credentials are sealed with it and cannot be read without it. ' +
        'Generate one with: openssl rand -hex 32',
    )
  }
  try {
    return keyFromEnvValue(raw)
  } catch (err) {
    throw new SecretKeyError(
      `DESK_MASTER_KEY is malformed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Generate one with: openssl rand -hex 32',
    )
  }
}

export class BrokerStore {
  readonly #db: Database
  readonly #key: Buffer

  constructor(db: Database, key: Buffer) {
    this.#db = db
    this.#key = key
  }

  /** UNIQUE on `kind`: two rows for one broker would make "which credentials are
   *  live?" depend on Mongo's return order, and half a rotation would look like
   *  a working configuration. */
  async ensureIndexes(): Promise<void> {
    await this.#db.collection(BROKER_COLLECTION).createIndex({ kind: 1 }, { unique: true })
  }

  /**
   * Every known broker, configured or not, so the UI can render a card for one
   * that has never been set up. Order is `BROKER_KINDS`, not insertion order —
   * the page must not reshuffle between polls.
   */
  async list(): Promise<BrokerRow[]> {
    const docs = await this.#db.collection<BrokerDoc>(BROKER_COLLECTION).find({}).toArray()
    const byKind = new Map(docs.filter((d) => isBrokerKind(d.kind)).map((d) => [d.kind, d]))
    return BROKER_KINDS.map((kind) => this.#rowOf(kind, byKind.get(kind)))
  }

  async get(kind: BrokerKind): Promise<BrokerRow> {
    const doc = await this.#db.collection<BrokerDoc>(BROKER_COLLECTION).findOne({ kind })
    return this.#rowOf(kind, doc ?? undefined)
  }

  /**
   * Store a broker's configuration.
   *
   * `secret` omitted or empty LEAVES THE STORED CREDENTIAL UNTOUCHED (contract
   * §2). The form can never display what is stored — the API refuses to return
   * it — so an operator changing a label would otherwise have to retype a
   * password they may not have, and would be one blank submit away from wiping
   * a working broker login.
   */
  async save(
    kind: BrokerKind,
    input: { label?: string; meta?: Record<string, unknown>; secret?: Record<string, unknown> },
    nowMs: number,
  ): Promise<void> {
    const set: Record<string, unknown> = { kind, updatedAt: nowMs }
    if (input.label !== undefined) set['label'] = input.label
    if (input.meta !== undefined) set['meta'] = sanitiseMeta(input.meta)
    if (input.secret !== undefined && Object.keys(input.secret).length > 0) {
      set['secret'] = seal(JSON.stringify(input.secret), this.#key)
      // New credentials invalidate the old verdict. Leaving `lastVerifiedAt` in
      // place would show a green tick against a password nobody has tested.
      set['lastVerifiedAt'] = null
      set['lastError'] = ''
    }
    await this.#db
      .collection(BROKER_COLLECTION)
      .updateOne({ kind }, { $set: set }, { upsert: true })
  }

  /**
   * Open the sealed blob.
   *
   * Three outcomes, never two: absent, opened, or present-but-unreadable. The
   * caller must not collapse the third into the first — see `BrokerState`.
   */
  async readSecret(kind: BrokerKind): Promise<BrokerSecretRead> {
    const doc = await this.#db.collection<BrokerDoc>(BROKER_COLLECTION).findOne({ kind })
    const sealed = doc?.secret
    if (typeof sealed !== 'string' || sealed === '') return { kind: 'absent' }
    try {
      const parsed: unknown = JSON.parse(open(sealed, this.#key))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { kind: 'unreadable', reason: 'stored credential is not an object' }
      }
      return { kind: 'ok', secret: parsed as Record<string, unknown> }
    } catch (err) {
      return { kind: 'unreadable', reason: describeOpenFailure(err) }
    }
  }

  /**
   * Record the outcome of a real broker login.
   *
   * Never upserts: a `test` against a broker with no row must not create one, or
   * the Brokers page would grow a card for something nobody configured.
   * `lastVerifiedAt` survives a later failure on purpose — "worked at 09:05,
   * failing since 14:20" is a far more useful thing to show an operator than a
   * bare error.
   */
  async recordTest(
    kind: BrokerKind,
    result: { ok: true } | { ok: false; error: string },
    nowMs: number,
  ): Promise<void> {
    const set: Record<string, unknown> = result.ok
      ? { lastVerifiedAt: nowMs, lastError: '' }
      : { lastError: result.error, lastFailedAt: nowMs }
    await this.#db.collection(BROKER_COLLECTION).updateOne({ kind }, { $set: set })
  }

  #rowOf(kind: BrokerKind, doc: BrokerDoc | undefined): BrokerRow {
    const sealed = doc?.secret
    const configured = typeof sealed === 'string' && sealed !== ''
    const lastError = typeof doc?.lastError === 'string' ? doc.lastError : ''
    let state: BrokerState = 'absent'
    if (configured) {
      // Opening is the only way to distinguish `unreadable` from `ok`, and it is
      // cheap. The plaintext is discarded here and never reaches a response.
      try {
        open(sealed, this.#key)
        state = lastError === '' ? 'ok' : 'error'
      } catch {
        state = 'unreadable'
      }
    }
    return {
      kind,
      label: typeof doc?.label === 'string' && doc.label !== '' ? doc.label : defaultLabel(kind),
      meta: sanitiseMeta(doc?.meta ?? {}),
      configured,
      state,
      lastVerifiedAt: typeof doc?.lastVerifiedAt === 'number' ? doc.lastVerifiedAt : null,
      // An unreadable row reports WHY even when nothing has been tested: it is
      // not a broker error, it is a key problem, and the operator needs to know
      // that re-entering credentials is not the fix they are looking for.
      lastError:
        state === 'unreadable' && lastError === ''
          ? 'stored credential will not decrypt with the current DESK_MASTER_KEY'
          : lastError,
    }
  }
}

function defaultLabel(kind: BrokerKind): string {
  return kind === 'delta' ? 'Delta Exchange India' : 'Zerodha (market data)'
}

/**
 * Keep only scalar, non-sensitive entries.
 *
 * Nested objects are dropped as well as sensitive keys: a nested blob is exactly
 * where a whole credential set would hide from a top-level key check, and `meta`
 * has no legitimate use for one.
 */
export function sanitiseMeta(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_META_KEY.test(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

function describeOpenFailure(err: unknown): string {
  if (err instanceof SecretOpenError) {
    // `MASTER_KEY_MISMATCH` rather than a local sentence: the XTS session store
    // and the Zerodha cookie jar report the same failure about the same key, and
    // an operator greps `pm2 logs` for one phrase, not three paraphrases of it.
    return err.reason === 'auth'
      ? `stored credential ${MASTER_KEY_MISMATCH}`
      : `stored credential is malformed: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
