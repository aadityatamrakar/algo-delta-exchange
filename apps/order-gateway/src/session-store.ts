/**
 * The XTS session token at rest — sealed, and expiring.
 *
 * WHAT THIS IS. `desk-broker-session` holds ONE document (`_id: 'xts'`) whose
 * `token` field is the bearer that PLACES ORDERS. Audit F-46: it was stored in
 * plaintext, while the app key and secret that mint it were sealed two
 * collections away in `desk-brokers`. A database dump therefore handed over a
 * live order-placing credential without needing `DESK_MASTER_KEY` at all, which
 * is exactly the threat `packages/secrets` exists to defend against.
 *
 * ONE KEY FOR THE WHOLE DESK. The key comes from `requireMasterKey` — the same
 * derivation `BrokerStore` uses, imported rather than re-implemented, so a box
 * with one `DESK_MASTER_KEY` in `.env.local` (every desk process is given it;
 * see `ecosystem.desk.config.cjs`) can open everything the desk sealed.
 *
 * MIGRATION IS A READ, NOT A STEP. Both shapes are accepted: a `v1.`-prefixed
 * value is opened, and anything else is taken as the legacy plaintext token and
 * used once. Every write seals, so the doc on a live box converts itself on the
 * next login with nobody doing anything. There is no migration script to forget
 * to run and no window in which the gateway refuses to log in.
 *
 * A VALUE THAT WILL NOT OPEN IS "NO SESSION", NEVER A THROW. A rotated key, a
 * restored database, a hand-edited row: all of them mean the stored token is not
 * usable, and the correct response is a fresh login and a loud log naming the
 * cause. Throwing here would take down the only process that can place orders,
 * and handing the unopened bytes to XTS would earn a rejection with no
 * explanation at 09:15.
 *
 * NOTHING HERE LOGS A TOKEN — plaintext or ciphertext. The ciphertext is still
 * the credential to anyone holding the key, and pm2 log files are not sealed.
 */

import { MASTER_KEY_MISMATCH, isSealed, open, optionalMasterKey, seal } from '@algomaker/secrets'

export const BROKER_SESSION_COLLECTION = 'desk-broker-session'

/**
 * SEVEN DAYS. Long enough that a Friday-evening restart still reuses Monday's
 * doc if XTS somehow honours it, short enough that a token abandoned by a box
 * taken out of service does not sit in the database forever. The token is dead
 * to XTS long before this — the TTL is about the CIPHERTEXT not outliving any
 * possible use for it, not about session validity.
 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/** Named explicitly so a later options change can drop this exact index. */
export const SESSION_TTL_INDEX = 'brokerSession_updatedAtDate_ttl'

export interface SessionRecord {
  readonly token: string
  readonly userID: string
  readonly clientCodes: readonly string[]
}

/**
 * Three outcomes, never two — the same distinction `BrokerStore.readSecret`
 * draws and for the same reason: "no session" is fixed by logging in, while
 * "a session that will not open" is a key problem, and collapsing the second
 * into the first hides the only fact an operator can act on.
 */
export type TokenRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly token: string; readonly sealed: boolean }
  | { readonly kind: 'unreadable'; readonly reason: string }

type Log = (msg: string, ctx?: Record<string, unknown>) => void

/**
 * `DESK_MASTER_KEY`, or null with a loud line.
 *
 * NOT FATAL, unlike in the API. `readBrokerStore` in `main.ts` already states
 * the rule this follows: the gateway can run entirely on env credentials, and
 * refusing to boot the only process that can place orders over a key a page
 * nobody is using needs would be its own outage. Without a key the token stays
 * plaintext — exactly as it is today — and every boot says so.
 *
 * The derivation AND the wording are `@algomaker/secrets`'s: the cookie jar next
 * door makes the identical trade for the identical reason, and two subsystems
 * that phrase the same warning two ways are one warning an operator cannot grep
 * for.
 */
export function sessionMasterKey(env: NodeJS.ProcessEnv = process.env, log: Log): Buffer | null {
  return optionalMasterKey(env, log, 'the XTS session token')
}

/**
 * Read the `token` field, whichever shape it is in.
 *
 * The discriminator is `isSealed`, ASKED rather than spelled: the `v1.` prefix
 * belongs to the seal format (see `packages/secrets` — it exists to make a sealed
 * value recognisable at a glance, and travels as GCM additional authenticated
 * data), and a copy of the magic string here would go stale the day the scheme
 * grows a v2, in the worst way — an unrecognised sealed value is not "unreadable"
 * on this path, it is a CIPHERTEXT HANDED TO XTS AS A BEARER. A value carrying
 * the prefix is INTENDED to be sealed, so a failure to open is `unreadable`
 * rather than a silent fall-through to using those bytes.
 */
export function readSessionTokenField(value: unknown, key: Buffer | null): TokenRead {
  if (typeof value !== 'string' || value === '') return { kind: 'absent' }
  if (!isSealed(value)) return { kind: 'ok', token: value, sealed: false }
  if (key === null) {
    return {
      kind: 'unreadable',
      reason: 'the stored session token is sealed and DESK_MASTER_KEY is not set',
    }
  }
  try {
    return { kind: 'ok', token: open(value, key), sealed: true }
  } catch (err) {
    return {
      kind: 'unreadable',
      reason:
        `the stored session token ${MASTER_KEY_MISMATCH} ` +
        `(${err instanceof Error ? err.name : 'error'})`,
    }
  }
}

/**
 * The `$set` for a session write.
 *
 * `userID` and `clientCodes` stay PLAINTEXT on purpose: they are account
 * identifiers, not credentials — `routes/system.ts` renders them, the broker
 * sweep matches on them, and sealing them would cost every reader the key while
 * protecting nothing a broker statement does not already say.
 *
 * `updatedAtDate` is written BESIDE the numeric `updatedAt`, not instead of it.
 * Mongo brackets by BSON type before anything else (`pnlstore.ts:249` — the
 * whole reason `loadFills` runs two typed queries), and its TTL monitor ignores
 * a field that is not a `Date` entirely: a TTL index over the existing
 * epoch-millis `updatedAt` would be an expiry that silently never happens. The
 * number stays because `routes/system.ts` and `broker-snapshot.ts` read it.
 */
export function sessionTokenUpdate(
  rec: SessionRecord,
  key: Buffer | null,
  nowMs: number,
): Record<string, unknown> {
  return {
    token: key === null ? rec.token : seal(rec.token, key),
    userID: rec.userID,
    clientCodes: [...rec.clientCodes],
    updatedAt: nowMs,
    updatedAtDate: new Date(nowMs),
  }
}

/**
 * "The token is still in the legacy plaintext form" — SAID ONCE PER PROCESS.
 *
 * The gateway opens this document twice on the way up (`main.ts`: `buildSession`'s
 * `read`, then the order-socket wiring below it) and again on every re-login the
 * snapshot loop or the adapter performs. The line means "nothing is wrong, the
 * migration is happening in place", and a benign line repeated on every read is
 * how an operator is trained to skim past the log. The line beside it has always
 * claimed "said once per boot"; this is what makes that true.
 *
 * MODULE-LEVEL rather than per-call, precisely because the two boot readers are
 * different call sites with no shared state between them — that is the whole
 * defect. The `unreadable` line next door is NOT memoised: it means a fresh login
 * every time and a key somebody must look at, and it has to be visible on the
 * read that hit it.
 */
let legacyPlaintextNoticeSaid = false

/** For tests, and for anything that legitimately re-boots a store in-process. */
export function resetLegacyPlaintextNotice(): void {
  legacyPlaintextNoticeSaid = false
}

/**
 * The stored session, or null — with the reason said out loud when there is one.
 *
 * The clientCodes rule stays at the CALL SITE (see `main.ts`): it is a statement
 * about what a usable XTS session needs, not about how the doc is encoded, and
 * the order-socket read needs the token without it.
 */
export function openSessionDoc(
  doc: Record<string, unknown> | null | undefined,
  key: Buffer | null,
  log: Log,
): SessionRecord | null {
  if (doc === null || doc === undefined) return null
  const read = readSessionTokenField(doc['token'], key)
  if (read.kind === 'absent') return null
  if (read.kind === 'unreadable') {
    log(
      `STORED XTS SESSION UNREADABLE — ${read.reason}. Treating it as no session and logging in ` +
        'fresh; the desk is not broken, but a key was rotated or this database was restored ' +
        'from a box with a different one.',
    )
    return null
  }
  if (!read.sealed && !legacyPlaintextNoticeSaid) {
    // Said once per boot, and only until the next write converts it. Nothing is
    // wrong — this is the F-46 migration happening in place. See the flag above
    // for why "once" is enforced rather than merely intended.
    legacyPlaintextNoticeSaid = true
    log(
      'the stored XTS session token is in the LEGACY PLAINTEXT form — using it, and the next ' +
        'login will write it sealed (F-46)',
    )
  }
  const codes = doc['clientCodes']
  return {
    token: read.token,
    userID: typeof doc['userID'] === 'string' ? doc['userID'] : '',
    clientCodes: Array.isArray(codes) ? codes.map((c) => String(c)) : [],
  }
}

/** The slice of a Mongo collection this module needs to build its index. */
export interface SessionIndexPort {
  createIndex(
    spec: Record<string, 1 | -1>,
    options?: { expireAfterSeconds?: number; name?: string },
  ): Promise<unknown>
}

/**
 * Build the TTL index, and DO NOT take the gateway down if Mongo refuses it.
 *
 * The F-42 boot-safety pattern (`apps/api/src/store.ts:ensureClientOrderIdUnique`):
 * an index is a guard against a future problem, and this runs on the boot path
 * of the only process that can place orders. An existing index on the same field
 * with different options is refused by Mongo outright (code 85/86), and that is a
 * tidy-up for an operator, not a reason for the desk not to start. Idempotent:
 * re-running with identical options is a no-op.
 */
export async function ensureSessionTtlIndex(
  collection: SessionIndexPort,
  log: Log,
): Promise<boolean> {
  try {
    await collection.createIndex(
      { updatedAtDate: 1 },
      { expireAfterSeconds: SESSION_TTL_SECONDS, name: SESSION_TTL_INDEX },
    )
    return true
  } catch (err) {
    log(
      `could not build the ${SESSION_TTL_INDEX} TTL index on '${BROKER_SESSION_COLLECTION}' — ` +
        'the session document will not expire on its own. Booting anyway; drop the conflicting ' +
        `index and restart to fix it (db.getCollection('${BROKER_SESSION_COLLECTION}').getIndexes()).`,
      { error: err instanceof Error ? err.message : String(err) },
    )
    return false
  }
}
