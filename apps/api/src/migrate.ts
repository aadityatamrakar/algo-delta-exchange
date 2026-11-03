/**
 * One-shot data migrations.
 *
 * Explicit and reversible by construction: a migration reads the old document,
 * writes the new one, and only then deletes the old. It never infers identity —
 * the tag encodes the VARIANT, which no stored document records, so the operator
 * supplies it. Guessing the identity of a live position is not a migration.
 */

import type { DeskMode } from './contract.ts'
import { COLLECTIONS, dropIfPresent, type Database } from './store.ts'
import { isIsoDate } from './validate.ts'
import { DAILY_REPORTS } from './pnlstore.ts'
import { AUDIT_COLLECTION } from './audit.ts'
import { bookFromDoc, deriveSeries, type BookRow } from './books-registry.ts'
import { recordSeries, type SeriesRow } from './book-series.ts'

export interface MigrateBookOpts {
  readonly symbol: string
  readonly mode: DeskMode
  readonly tag: string
  /** Overrides the expiry derived from the legs. Needed only for an empty book. */
  readonly expiry?: string | undefined
}

export interface MigrationResult {
  readonly migrated: boolean
  readonly tag: string
  readonly legs: number
  readonly expiry: string
  readonly reason?: string
}

export async function migrateBookToTag(
  db: Database,
  opts: MigrateBookOpts,
): Promise<MigrationResult> {
  const books = db.collection(COLLECTIONS.books)

  // The untagged source is checked BEFORE the tagged destination. Once a
  // migration has succeeded, the untagged document is gone and the tag exists
  // — a second run must read as "already migrated" (no untagged book left),
  // not "destination occupied", which is a distinct condition below reserved
  // for a REAL collision (both documents present at once).
  const old = await books.findOne({ symbol: opts.symbol, mode: opts.mode, tag: { $exists: false } })
  if (old === null) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: 0,
      expiry: '',
      reason: `no untagged book for ${opts.symbol}/${opts.mode}`,
    }
  }

  const existing = await books.findOne({ tag: opts.tag, mode: opts.mode })
  if (existing !== null) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: 0,
      expiry: '',
      reason: `a book for tag '${opts.tag}' (${opts.mode}) already exists`,
    }
  }

  /**
   * A non-array `legs` is REFUSED, not degraded to `[]`.
   *
   * It used to become an empty book, and with `--expiry` supplied that empty
   * book was written and the source document DELETED — a live position erased
   * by a field this function decided not to look at. There is no reading of a
   * malformed `legs` that makes deleting the only copy of the book correct.
   */
  if (!Array.isArray(old['legs'])) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: 0,
      expiry: '',
      reason: `legs is not an array (${typeof old['legs']}); refusing to migrate a malformed book`,
    }
  }
  const legs = old['legs'] as Record<string, unknown>[]

  // Expiry is VALIDATED, never coerced. `String(l['expiry'])` turned a leg with
  // no expiry into the literal 'undefined', which is non-empty and therefore
  // sailed past the `expiry === ''` guard below — the migration would have
  // written `expiry: 'undefined'` and then deleted the source. This runs once,
  // irreversibly, against a live options book; a leg it cannot read is a reason
  // to stop and tell the operator, not to guess.
  const bad = legs
    .map((l, i) => ({ i, expiry: l['expiry'] }))
    .filter((l) => !isIsoDate(l.expiry))
  if (bad.length > 0) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: legs.length,
      expiry: '',
      reason:
        `legs ${bad.map((b) => b.i).join(', ')} carry no valid 'YYYY-MM-DD' expiry ` +
        `(${bad.map((b) => JSON.stringify(b.expiry)).join(', ')}); refusing to migrate`,
    }
  }
  if (opts.expiry !== undefined && !isIsoDate(opts.expiry)) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: legs.length,
      expiry: '',
      reason: `--expiry ${JSON.stringify(opts.expiry)} is not a 'YYYY-MM-DD' date`,
    }
  }

  // Expiry comes from the legs, because that is where it is actually recorded.
  // A book whose legs disagree is a book we must not migrate blind.
  const expiries = new Set(legs.map((l) => String(l['expiry'])))
  if (opts.expiry === undefined && expiries.size > 1) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: legs.length,
      expiry: '',
      reason: `legs span ${expiries.size} expiries (${[...expiries].join(', ')}); pass --expiry`,
    }
  }
  const expiry = opts.expiry ?? [...expiries][0] ?? ''
  if (expiry === '') {
    return { migrated: false, tag: opts.tag, legs: 0, expiry: '', reason: 'cannot derive expiry; pass --expiry' }
  }

  // The migration runs BEFORE the API boots, precisely so `ensureIndexes`
  // never has to build the unique `{tag, mode}` index over untagged
  // documents — which means the OLD unique `symbol_1_mode_1` index is still
  // standing right up until this line. Write-before-delete below needs both
  // documents to coexist for one instant, and under that old index they
  // still share `{symbol, mode}` — an E11000 the migration cannot get past
  // under the exact conditions it exists to run in. Dropping it here is not
  // destructive (an index is not data), it is idempotent (`dropIfPresent`
  // tolerates absence, so a second run or a fresh database is unaffected),
  // and it does only what `ensureIndexes` would do moments later anyway.
  await dropIfPresent(books, 'symbol_1_mode_1')

  // Write the new document BEFORE deleting the old one. A crash between the two
  // leaves both, which the idempotency check above resolves on the next run —
  // the opposite order would lose the book outright.
  await books.updateOne(
    { tag: opts.tag, mode: opts.mode },
    {
      $set: {
        tag: opts.tag,
        mode: opts.mode,
        symbol: opts.symbol,
        expiry,
        legs,
        updatedAt: Number(old['updatedAt'] ?? 0),
      },
    },
    { upsert: true },
  )
  await books.deleteOne({ _id: old['_id'] })

  return { migrated: true, tag: opts.tag, legs: legs.length, expiry }
}

// ------------------------------------------------------------- declarations

export interface MigrateDeclarationOpts {
  readonly symbol: string
  readonly tag: string
}

export interface DeclarationMigrationResult {
  readonly migrated: boolean
  readonly tag: string
  readonly legs: number
  readonly reason?: string
}

/**
 * Re-key ONE declaration from `symbol` to `tag`.
 *
 * A declaration is what the desk says it holds (D2) — the input to `diff`, the
 * one mechanism that catches a desync. Left untagged it is worse than absent:
 * `loadDeclaration(tag)` finds nothing, `diff` reports the whole book as
 * `bridgeOnly`, and the desk reads a desync that is really a migration it never
 * ran.
 *
 * IT ALSO BLOCKS BOOT. `ensureIndexes` puts a UNIQUE index on `tag`, and Mongo
 * indexes a missing field as `null` — so two untagged declarations are two rows
 * with `tag: null`, the index build fails with E11000, and `main.ts` throws
 * before the API listens. Same safety properties as `migrateBookToTag`:
 * write-before-delete, idempotent, refuses rather than overwrites, and deletes
 * by `_id` so it can only ever remove the document it actually read.
 */
export async function migrateDeclarationToTag(
  db: Database,
  opts: MigrateDeclarationOpts,
): Promise<DeclarationMigrationResult> {
  const declarations = db.collection(COLLECTIONS.declarations)

  // Source before destination, for the reason spelled out in `migrateBookToTag`:
  // a second run must read as "already migrated", not as a collision.
  const old = await declarations.findOne({ symbol: opts.symbol, tag: { $exists: false } })
  if (old === null) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: 0,
      reason: `no untagged declaration for ${opts.symbol}`,
    }
  }

  const existing = await declarations.findOne({ tag: opts.tag })
  if (existing !== null) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: 0,
      reason: `a declaration for tag '${opts.tag}' already exists`,
    }
  }

  // Refused rather than degraded to `[]`, exactly as the book migration does: an
  // empty declaration is not "nothing declared", it is "the desk holds nothing",
  // and writing that over a malformed field would report a real position as a
  // clean diff.
  if (!Array.isArray(old['legs'])) {
    return {
      migrated: false,
      tag: opts.tag,
      legs: 0,
      reason: `legs is not an array (${typeof old['legs']}); refusing to migrate a malformed declaration`,
    }
  }
  const legs = old['legs'] as Record<string, unknown>[]

  // Same reasoning as `migrateBookToTag`: the OLD unique `symbol_1` index is
  // still standing before the API's `ensureIndexes` has run, and
  // write-before-delete below needs the tagged and untagged documents to
  // coexist for one instant, which that index forbids. Dropping it here is
  // not destructive and idempotent for the same reasons.
  await dropIfPresent(declarations, 'symbol_1')

  await declarations.updateOne(
    { tag: opts.tag },
    {
      $set: {
        tag: opts.tag,
        symbol: opts.symbol,
        legs,
        declaredAt: Number(old['declaredAt'] ?? 0),
      },
    },
    { upsert: true },
  )
  await declarations.deleteOne({ _id: old['_id'] })

  return { migrated: true, tag: opts.tag, legs: legs.length }
}

// ------------------------------------------------------------------- check

export interface UntaggedBook {
  readonly symbol: string
  readonly mode: string
  readonly legs: number
}

export interface UntaggedDeclaration {
  readonly symbol: string
  readonly legs: number
}

export interface MigrationCheck {
  readonly books: readonly UntaggedBook[]
  readonly declarations: readonly UntaggedDeclaration[]
  /** True when nothing is left untagged — the new code is safe to boot. */
  readonly clear: boolean
}

/**
 * WHAT MUST BE MIGRATED BEFORE THE NEW CODE BOOTS. Reads only.
 *
 * `ensureIndexes` builds UNIQUE indexes on `{tag, mode}` (books) and `{tag}`
 * (declarations). A missing field indexes as `null`, so TWO untagged documents
 * in either collection make that build fail with
 * `E11000 duplicate key ... dup key: { tag: null, mode: "paper" }` and the API
 * does not start. By then the operator is looking at a crash loop rather than a
 * list of things to migrate — this is that list, obtainable BEFORE the restart.
 *
 * `cli.ts` deliberately does not call `ensureIndexes`, which is what makes it
 * usable against exactly the database that would refuse to boot.
 *
 * NOT reported here: the old unique `symbol_1_mode_1` / `symbol_1` indexes
 * that a fresh, never-migrated database still carries. Those used to be a
 * real precondition an operator could trip over mid-migration (E11000
 * against the OLD index, not the new one this function is about); they no
 * longer are, because `migrateBookToTag` / `migrateDeclarationToTag` now drop
 * them themselves, tolerating absence, right before they write. Surfacing
 * them here would describe an obstacle the migration functions already clear
 * on their own — a check that reports a solved problem trains the operator to
 * ignore it.
 */
export async function migrationCheck(db: Database): Promise<MigrationCheck> {
  const bookDocs = await db
    .collection(COLLECTIONS.books)
    .find({ tag: { $exists: false } })
    .toArray()
  const declarationDocs = await db
    .collection(COLLECTIONS.declarations)
    .find({ tag: { $exists: false } })
    .toArray()

  const books = bookDocs.map((d) => ({
    symbol: String(d['symbol'] ?? ''),
    mode: String(d['mode'] ?? ''),
    legs: Array.isArray(d['legs']) ? d['legs'].length : 0,
  }))
  const declarations = declarationDocs.map((d) => ({
    symbol: String(d['symbol'] ?? ''),
    legs: Array.isArray(d['legs']) ? d['legs'].length : 0,
  }))
  return { books, declarations, clear: books.length === 0 && declarations.length === 0 }
}

// ------------------------------------------------------------ book series

export interface SeriesBackfillEntry {
  readonly tag: string
  readonly mode: DeskMode
  readonly series: string
  /** Where symbol and variant came from: the registration's audit line, or the live registry row. */
  readonly source: 'audit' | 'registry'
}

export interface SeriesBackfillResult {
  /** Rows written (or, on a dry run, that would be). */
  readonly recorded: readonly SeriesBackfillEntry[]
  /** Candidates that already had a series row and were left alone. */
  readonly already: number
  /** Reported tags with neither an audit registration nor a registry row: left unlabelled. */
  readonly unresolved: readonly { readonly tag: string; readonly mode: DeskMode }[]
}

const REGISTERED = 'registered a book (stopped)'

const keyOf = (tag: string, mode: DeskMode): string => `${tag}|${mode}`

/**
 * GIVE EVERY BOOK THAT HAS EVER REPORTED ITS SERIES ROW (WS2). Idempotent.
 *
 * `desk-book-series` starts empty on the day it ships, while three weeks of
 * dated tags already sit in `desk-daily-reports`, most of whose registry rows
 * the daily roll has long since erased. Something has to say which series each
 * of those belonged to, and it must not be the tag's text: the box holds two
 * shapes (`NIFTY-delta-lean-aggressive-2026-10-01` and the legacy
 * `NIFTY-2026-09-22-delta-lean-aggressive`), and parsing either is the thing
 * this design exists not to do.
 *
 * THE SOURCES, in order:
 *   1. `desk-audit-log` "registered a book (stopped)" — kept forever, carries
 *      `detail.symbol/variant/expiry` (and `detail.series` once stated). The
 *      LATEST registration of a `{tag, mode}` wins.
 *   2. The registry row, for a tag still registered whose audit line is gone.
 *   3. Neither — a hosted strategy like `ORB_FUT_NIFTY`, or a pre-audit book.
 *      Left unlabelled and listed; the Reports page shows it under its own tag.
 *
 * CANDIDATES are every `{tag, mode}` with a daily report, plus every current
 * registry row (a book registered before this shipped and not yet reported).
 *
 * IDEMPOTENT: a candidate that already has a series row is counted and left
 * alone, and `recordSeries` is insert-only besides — a second run writes
 * nothing. Runs at every desk-api boot (`main.ts`), and by hand through
 * `cli.ts backfill-series [--dry-run]`.
 */
export async function backfillSeriesFromAudit(
  db: Database,
  opts: { readonly dryRun?: boolean } = {},
): Promise<SeriesBackfillResult> {
  const candidates = new Map<string, { tag: string; mode: DeskMode }>()
  const addCandidate = (tag: unknown, mode: unknown): void => {
    if (typeof tag !== 'string' || tag === '') return
    if (mode !== 'paper' && mode !== 'live') return
    candidates.set(keyOf(tag, mode), { tag, mode })
  }
  for (const d of await db.collection(DAILY_REPORTS).find({}).toArray()) addCandidate(d['tag'], d['mode'])
  const registry = new Map<string, BookRow>()
  for (const d of await db.collection(COLLECTIONS.booksRegistry).find({}).toArray()) {
    const row = bookFromDoc(d)
    if (row === null) continue
    registry.set(keyOf(row.tag, row.mode), row)
    addCandidate(row.tag, row.mode)
  }

  const have = new Set<string>()
  for (const d of await db.collection(COLLECTIONS.bookSeries).find({}).toArray()) {
    const tag = d['tag']
    const mode = d['mode']
    if (typeof tag === 'string' && (mode === 'paper' || mode === 'live')) have.add(keyOf(tag, mode))
  }

  // The latest registration per {tag, mode}, with every field it needs.
  const audited = new Map<string, { row: SeriesRow; at: number }>()
  for (const d of await db.collection(AUDIT_COLLECTION).find({ action: REGISTERED }).toArray()) {
    const tag = d['tag']
    const mode = d['mode']
    const rawAt = d['at']
    const at = typeof rawAt === 'number' && Number.isFinite(rawAt) ? rawAt : 0
    const detail = d['detail']
    if (typeof tag !== 'string' || tag === '' || (mode !== 'paper' && mode !== 'live')) continue
    if (detail === null || typeof detail !== 'object') continue
    const det = detail as Record<string, unknown>
    const symbol = det['symbol']
    const variant = det['variant']
    const expiry = det['expiry']
    if (typeof symbol !== 'string' || symbol === '') continue
    if (typeof variant !== 'string' || variant === '') continue
    if (!isIsoDate(expiry)) continue
    const stated = det['series']
    const series = typeof stated === 'string' && stated !== '' ? stated : deriveSeries(symbol, variant)
    const key = keyOf(tag, mode)
    const prior = audited.get(key)
    if (prior !== undefined && prior.at > at) continue
    audited.set(key, { at, row: { tag, mode, series, symbol, variant, expiry, createdAt: at } })
  }

  const recorded: SeriesBackfillEntry[] = []
  const unresolved: { tag: string; mode: DeskMode }[] = []
  let already = 0
  const ordered = [...candidates.values()].sort((a, b) =>
    a.tag === b.tag ? a.mode.localeCompare(b.mode) : a.tag.localeCompare(b.tag),
  )
  for (const c of ordered) {
    const key = keyOf(c.tag, c.mode)
    if (have.has(key)) {
      already++
      continue
    }
    const fromAudit = audited.get(key)?.row
    const reg = registry.get(key)
    const fromRegistry: SeriesRow | undefined =
      reg === undefined
        ? undefined
        : {
            tag: reg.tag,
            mode: reg.mode,
            series: reg.series,
            symbol: reg.symbol,
            variant: reg.variant,
            expiry: reg.expiry,
            createdAt: reg.createdAt,
          }
    const row = fromAudit ?? fromRegistry
    if (row === undefined) {
      unresolved.push(c)
      continue
    }
    if (opts.dryRun !== true && (await recordSeries(db, row)) === 'exists') {
      // Written between the read above and now (a create racing the boot).
      already++
      continue
    }
    recorded.push({
      tag: row.tag,
      mode: row.mode,
      series: row.series,
      source: fromAudit !== undefined ? 'audit' : 'registry',
    })
  }
  return { recorded, already, unresolved }
}
