/**
 * THE OPERATOR AUDIT LOG — one append-only record of every mutation a human
 * (or the day guard) made through this bridge.
 *
 * WHY IT EXISTS. Until now the desk recorded WHO for exactly one control: the
 * kill switch's `setBy`. Everything else — a book deleted, a dial retuned, a
 * strategy armed live, a position seeded, a runner ledger cleared — left a line
 * in a log file that rotates and nothing in the database at all. "Who stopped
 * BHEL yesterday, and what were the dials before?" was not answerable from the
 * desk itself, only from whatever pm2 had not yet thrown away. Audit roadmap 17.
 *
 * THE REDACTION RULE, and it is the reason this module owns the writing rather
 * than each route formatting its own document:
 *
 *   **NO CREDENTIAL, PASSWORD, TOKEN OR SEALED SECRET MAY EVER REACH THIS
 *   COLLECTION, in any field, at any depth, on any path.**
 *
 * `detail` is a SMALL before/after summary, never a request body. The brokers
 * routes are the sharp case: their PUT carries `secret` and their `test` carries
 * a password and a TOTP seed, one field away from anything a handler might pass
 * along — and unlike a log file, this collection is append-only, unpruned, and
 * read back over HTTP. So `redactDetail` runs on the way IN (not at the call
 * sites, which would make the invariant something twenty edits have to
 * remember): every key that looks like a credential has its value replaced with
 * `'[redacted]'`, recursively, and the summary is bounded in size besides. A
 * call site that hands over a whole body still cannot leak one — but the rule
 * for call sites remains: pass a SUMMARY (what changed, from what, to what),
 * never the body you were given.
 *
 * FAIL-SOFT, exactly like `notify`. `record` never rejects and never throws: an
 * audit write that fails logs and is dropped. Bookkeeping must not be able to
 * fail an operator's flatten — the entire point of the entry is that the action
 * happened, and refusing the action to protect its record would be backwards.
 *
 * WHAT IS AND IS NOT AUDITED. Operator-shaped mutations, and the day guard's
 * automatic ones. NOT the high-frequency machine reports — the engine decision
 * endpoint, `POST .../actual` — which the supervisor posts every few seconds
 * and which have their own records (`desk-decisions`, `desk-engine-decisions`,
 * the order journal, the registry row itself). An audit log that fills with
 * supervisor heartbeats is an audit log nobody reads.
 *
 * BEFORE/AFTER IS RECORDED WHERE THE HANDLER ALREADY HOLDS THE "BEFORE".
 * Several handlers read the current row anyway to validate against it (dials,
 * the strategy patch, start/stop), and those record both sides. The ones that
 * do not — the kill switch, a seed — record the resulting state and say what
 * they did, rather than paying for an extra read on the money path to decorate
 * a log line.
 *
 * Shaped like `day-guard.ts`: a narrow collection port, a pure builder beside
 * it, and one adapter that reaches the real collection.
 */

import type { DeskMode } from './contract.ts'
import type { ApiDeps, Principal } from './routes/kit.ts'

/** Append-only. Nothing in this tree updates or deletes a row of it. */
export const AUDIT_COLLECTION = 'desk-audit-log'

/** What `GET /v1/desk/audit` answers with when the caller names no limit. */
export const AUDIT_DEFAULT_LIMIT = 50

/** And the most it will ever answer with, however large a limit is asked for. */
export const AUDIT_MAX_LIMIT = 500

/**
 * The day guard is not a person and must not be filed as one.
 *
 * `'system'` beside the name keeps "the desk stopped this rail" and "an operator
 * stopped this rail" distinguishable in the one record that has to answer
 * exactly that question a week later.
 */
export type AuditPrincipal = Principal | { readonly kind: 'system'; readonly name: string }

/** One recorded act. `detail` is a summary; see the header's redaction rule. */
export interface AuditEntry {
  readonly at: number
  /** The AUTHENTICATED principal's name, never one the body claimed. */
  readonly principal: string
  readonly principalKind?: 'user' | 'machine' | 'system'
  /** Where it happened — the route path, or `'day-guard'` for the loop. */
  readonly source: string
  /** A short verb phrase: "engaged the kill switch", "deleted a book". */
  readonly action: string
  readonly tag?: string
  readonly mode?: DeskMode
  readonly detail: Record<string, unknown>
}

export interface AuditInput {
  readonly principal: AuditPrincipal
  readonly source: string
  readonly action: string
  readonly tag?: string
  readonly mode?: DeskMode
  /** A SMALL before/after summary. Redacted on the way in regardless. */
  readonly detail?: Record<string, unknown>
  /** Overrides the clock, for a caller that already stamped the moment. */
  readonly at?: number
}

export interface AuditLog {
  /** NEVER REJECTS. A failed write logs and is dropped — see the header. */
  record(input: AuditInput): Promise<void>
  /** Newest first, clamped to `AUDIT_MAX_LIMIT`. Never throws. */
  recent(limit?: number): Promise<readonly AuditEntry[]>
}

// ------------------------------------------------------------- the redactor

/**
 * Any key whose VALUE is a secret. Matched loosely and on purpose: a false
 * positive costs one redacted field in a summary, a false negative copies a
 * credential into a collection that is never pruned.
 */
const SENSITIVE = /pass|secret|token|totp|otp|pin|cred|key|auth|cookie|session|signature|hash/i

const REDACTED = '[redacted]'

/** A summary, not a payload — so every dimension of it is bounded. */
const MAX_STRING = 200
const MAX_ITEMS = 20
const MAX_KEYS = 24
const MAX_DEPTH = 4

/**
 * The detail, made safe and made small.
 *
 * Cycles are survived rather than trusted not to exist: a redactor that hangs is
 * a redactor that never runs, and this one sits on the path of every mutation.
 *
 * THE GUARD IS SCOPED TO THE PATH, NOT TO THE WHOLE WALK — `seen` holds the
 * ancestors of the value being rendered and nothing else, which is the only set
 * a cycle can be found in. Held for the whole traversal instead, it also caught
 * every value REACHED TWICE BY DIFFERENT ROUTES, and the summaries this module
 * exists to keep are exactly that shape: `{before: dials, after: dials}` from a
 * handler that read the row once, a leg listed under two keys, one shared
 * config object. Those are DAGs. They were rendered as `'[cycle]'` — half of a
 * before/after record replaced by a diagnostic string, silently, in the one
 * place an operator goes to find out what a value used to be.
 */
export function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  /** The ANCESTORS of the value being walked. Added on the way down, removed on the way up. */
  const seen = new WeakSet<object>()

  const walk = (value: unknown, depth: number, sensitive: boolean): unknown => {
    if (sensitive) return REDACTED
    if (value === null || value === undefined) return null
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'string') {
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
    }
    if (typeof value !== 'object') return String(value).slice(0, MAX_STRING)
    // An ancestor of itself is a loop and nothing else can be — a repeat that is
    // not on this path is a second sighting, and is rendered.
    if (seen.has(value)) return '[cycle]'
    // Checked BEFORE the value joins the path, so the early return cannot leave
    // it behind: an un-removed ancestor is the very bug this rewrite fixes.
    if (depth >= MAX_DEPTH) return '[deep]'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const head = value.slice(0, MAX_ITEMS).map((v) => walk(v, depth + 1, false))
        return value.length > MAX_ITEMS ? [...head, `…${value.length - MAX_ITEMS} more`] : head
      }
      const out: Record<string, unknown> = {}
      let keys = 0
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (keys >= MAX_KEYS) {
          out['…'] = 'truncated'
          break
        }
        keys += 1
        out[k] = walk(v, depth + 1, SENSITIVE.test(k))
      }
      return out
    } finally {
      // `finally`, so a throw from anywhere below cannot leave this module's
      // idea of "the current path" wrong for the rest of the walk.
      seen.delete(value)
    }
  }

  const result = walk(detail, 0, false)
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {}
}

// --------------------------------------------------------------- the writer

/** The document one entry becomes. Pure, so the shape is testable alone. */
export function auditDoc(input: AuditInput, at: number): Record<string, unknown> {
  return {
    at: input.at ?? at,
    principal: input.principal.name,
    principalKind: input.principal.kind,
    source: input.source,
    action: input.action,
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    detail: redactDetail(input.detail ?? {}),
  }
}

/**
 * A stored entry, read defensively — the Status page renders these.
 *
 * A row missing its principal or its action is DROPPED rather than rendered
 * with a guess. "someone did something" over a real mutation is worse than a
 * shorter list, and this collection is written by code that will change.
 */
export function auditEntryFromDoc(doc: Record<string, unknown> | null): AuditEntry | null {
  if (doc === null) return null
  const at = doc['at']
  const principal = doc['principal']
  const source = doc['source']
  const action = doc['action']
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (typeof principal !== 'string' || principal === '') return null
  if (typeof source !== 'string' || typeof action !== 'string' || action === '') return null
  const kind = doc['principalKind']
  const tag = doc['tag']
  const mode = doc['mode']
  const detail = doc['detail']
  return {
    at,
    principal,
    ...(kind === 'user' || kind === 'machine' || kind === 'system'
      ? { principalKind: kind }
      : {}),
    source,
    action,
    ...(typeof tag === 'string' && tag !== '' ? { tag } : {}),
    ...(mode === 'paper' || mode === 'live' ? { mode } : {}),
    detail:
      typeof detail === 'object' && detail !== null && !Array.isArray(detail)
        ? (detail as Record<string, unknown>)
        : {},
  }
}

/**
 * `desk-audit-log`, behind the `AuditLog` port.
 *
 * Takes the three things it uses rather than the whole `ApiDeps` bag, so a
 * caller with a database and a clock can construct one — and so a test does not
 * have to build a service to write a line.
 */
export function auditLog(deps: Pick<ApiDeps, 'db' | 'log' | 'now'>): AuditLog {
  return {
    record: async (input) => {
      try {
        await deps.db.collection(AUDIT_COLLECTION).insertOne(auditDoc(input, deps.now()))
      } catch (err) {
        /**
         * SAID, NEVER SWALLOWED — and never rethrown. The mutation this
         * describes has already happened; failing it now would be the worst of
         * both worlds. The log line is what makes the gap in the record
         * findable afterwards.
         */
        deps.log('audit entry could NOT be written — the action happened, the record did not', {
          source: input.source,
          action: input.action,
          principal: input.principal.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    recent: async (limit) => {
      const capped = Math.min(
        Math.max(1, Math.floor(limit ?? AUDIT_DEFAULT_LIMIT)),
        AUDIT_MAX_LIMIT,
      )
      try {
        const docs = await deps.db
          .collection(AUDIT_COLLECTION)
          .find({})
          .sort({ at: -1 })
          .limit(capped)
          .toArray()
        return docs
          .map((d) => auditEntryFromDoc(d as Record<string, unknown>))
          .filter((e): e is AuditEntry => e !== null)
      } catch (err) {
        // The same rule `loadRuntime` holds: a decoration must not be able to
        // take down the page an operator reaches for when something is wrong.
        deps.log('audit log unreadable', {
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    },
  }
}

/**
 * The one index this collection needs, created best-effort at boot.
 *
 * `recent` sorts by `at` descending over a collection that is APPEND-ONLY and
 * pruned by nothing — it grows for the life of the desk. An unindexed sort is
 * fine at a thousand rows and is a hard failure at the point where Mongo's
 * 32MB in-memory sort limit is reached, which is exactly the point at which
 * somebody is trying to find out what happened. `{at: -1}` is the only access
 * pattern there is.
 *
 * FIRE-AND-FORGET, and it can fail: the same shape `brokerRoutes` uses for its
 * own indexes. Boot must not wait on a Mongo round trip, and a desk whose audit
 * index could not be created must still trade.
 */
export function ensureAuditIndex(deps: Pick<ApiDeps, 'db' | 'log'>): void {
  const failed = (err: unknown): void => {
    deps.log('audit log index creation failed — reads will scan', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    void deps.db.collection(AUDIT_COLLECTION).createIndex({ at: -1 }).catch(failed)
  } catch (err) {
    // A database port without `createIndex` (every route test builds one) is
    // not a fault — it is a fake, and it must behave like a desk with no index
    // rather than taking the route module's construction down with it.
    failed(err)
  }
}

/** A no-op sink, for a caller that has no database to write to. */
export const noAudit: AuditLog = {
  record: async () => {},
  recent: async () => [],
}
