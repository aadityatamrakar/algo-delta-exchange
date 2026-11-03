import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// For its import-time guards only: a DESK_TEST_MONGO* URL outside algomaker_dx_* is refused before this suite connects.
import './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { migrateBookToTag, migrateDeclarationToTag, migrationCheck } from '../src/migrate.ts'

// Its own database, not `algomaker_dx_bridge_test` — this package runs test files
// concurrently, and `service.integration.test.ts` / `store-tag.test.ts` already
// each claim their own database for exactly that reason.
const URL = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_bridge_migrate_test'
const TAG = 'BHEL-2026-08-25-hold-recycle-r'

let handle: MongoHandle | null = null
let available = false

before(async () => {
  try {
    handle = await connectMongo(URL)
    // CLEARED BEFORE THE INDEXES ARE BUILT, and that order is the point of this
    // file's subject matter: an untagged document left behind by a previous run
    // is exactly what the new UNIQUE `{tag, mode}` / `{tag}` indexes cannot be
    // built over — Mongo indexes a missing field as `null`, so two of them
    // collide with E11000. Indexing first would make this suite skip itself
    // ("no mongo") for the very condition it exists to test.
    await handle.db.collection(COLLECTIONS.books).deleteMany({})
    await handle.db.collection(COLLECTIONS.declarations).deleteMany({})
    await new DeskStore(handle.db).ensureIndexes()
    available = true
  } catch {
    available = false
  }
})

after(async () => {
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available || handle === null) return
  await handle.db.collection(COLLECTIONS.books).deleteMany({})
  await handle.db.collection(COLLECTIONS.declarations).deleteMany({})
  // A pre-migration document: keyed by symbol, no tag, no expiry.
  await handle.db.collection(COLLECTIONS.books).insertOne({
    symbol: 'BHEL',
    mode: 'paper',
    legs: [
      { deskTag: 'CE420#seed', underlying: 'BHEL', expiry: '2026-08-25', strike: 420, type: 'CE', side: 'Sell', qty: -13125, entryPrice: 15, openedTs: 1, instrument: { tradingsymbol: 'BHEL26AUG420CE', exchange: 'NFO', instrumentToken: 700420 } },
      { deskTag: 'PE415#seed', underlying: 'BHEL', expiry: '2026-08-25', strike: 415, type: 'PE', side: 'Sell', qty: -13125, entryPrice: 14, openedTs: 1, instrument: { tradingsymbol: 'BHEL26AUG415PE', exchange: 'NFO', instrumentToken: 700415 } },
    ],
    updatedAt: 100,
  })
})

test('migration re-keys the book under its tag, preserving legs and entry prices', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  const result = await migrateBookToTag(handle.db, { symbol: 'BHEL', mode: 'paper', tag: TAG })

  assert.equal(result.migrated, true)
  assert.equal(result.legs, 2)
  assert.equal(result.expiry, '2026-08-25')

  const doc = await handle.db.collection(COLLECTIONS.books).findOne({ tag: TAG, mode: 'paper' })
  assert.ok(doc)
  assert.equal(doc['symbol'], 'BHEL')
  assert.equal(doc['expiry'], '2026-08-25')
  assert.equal((doc['legs'] as unknown[]).length, 2)
  // Entry prices are the cost basis. Losing them silently rewrites the P&L.
  assert.equal((doc['legs'] as { entryPrice: number }[])[0]?.entryPrice, 15)

  // The untagged original is gone, so nothing can read the book two ways.
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: { $exists: false } }), 0)
})

test('migration is idempotent — a second run changes nothing', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await migrateBookToTag(handle.db, { symbol: 'BHEL', mode: 'paper', tag: TAG })
  const second = await migrateBookToTag(handle.db, { symbol: 'BHEL', mode: 'paper', tag: TAG })

  assert.equal(second.migrated, false)
  assert.equal(second.reason, 'no untagged book for BHEL/paper')
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({}), 1)
})

test('migration refuses to overwrite an existing tagged book', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await handle.db.collection(COLLECTIONS.books).insertOne({
    tag: TAG, mode: 'paper', symbol: 'BHEL', expiry: '2026-08-25', legs: [], updatedAt: 1,
  })
  const result = await migrateBookToTag(handle.db, { symbol: 'BHEL', mode: 'paper', tag: TAG })

  assert.equal(result.migrated, false)
  assert.match(result.reason ?? '', /already exists/)
  // The untagged original must still be there — nothing was destroyed.
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: { $exists: false } }), 1)
})

// ------------------------------------------------- validation, not coercion

/**
 * A LEG WITH NO EXPIRY IS CORRUPTION, AND THIS FUNCTION DELETES ITS SOURCE.
 *
 * The expiry used to be derived with `String(l['expiry'])`, which turns a
 * missing field into the literal `'undefined'` — non-empty, so it sailed past
 * the `expiry === ''` guard, was written into the migrated book, and the
 * original was then deleted. One irreversible run against a live options book.
 */
test('migration REFUSES a leg whose expiry is missing rather than writing "undefined"', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await handle.db.collection(COLLECTIONS.books).deleteMany({})
  await handle.db.collection(COLLECTIONS.books).insertOne({
    symbol: 'BHEL',
    mode: 'paper',
    legs: [
      { deskTag: 'CE420#seed', strike: 420, type: 'CE', qty: -13125, expiry: '2026-08-25' },
      { deskTag: 'PE415#seed', strike: 415, type: 'PE', qty: -13125 },
    ],
    updatedAt: 100,
  })

  const result = await migrateBookToTag(handle.db, { symbol: 'BHEL', mode: 'paper', tag: TAG })

  assert.equal(result.migrated, false)
  assert.match(result.reason ?? '', /legs 1 carry no valid/)
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: TAG }), 0)
  // The source survives: a refusal must leave the operator with the book.
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: { $exists: false } }), 1)
})

test('migration REFUSES a non-array legs even when --expiry is supplied', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await handle.db.collection(COLLECTIONS.books).deleteMany({})
  await handle.db.collection(COLLECTIONS.books).insertOne({
    symbol: 'BHEL', mode: 'paper', legs: { CE420: 1 }, updatedAt: 100,
  })

  // `--expiry` used to make this the WORST case: `legs` degraded to `[]`, the
  // expiry came from the flag, so an EMPTY book was written and the source
  // deleted — a live position erased by a field the function declined to read.
  const result = await migrateBookToTag(handle.db, {
    symbol: 'BHEL', mode: 'paper', tag: TAG, expiry: '2026-08-25',
  })

  assert.equal(result.migrated, false)
  assert.match(result.reason ?? '', /legs is not an array/)
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: TAG }), 0)
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: { $exists: false } }), 1)
})

// ------------------------------------------------------ declarations (B2)

/** A pre-migration declaration: keyed by symbol, no tag. */
async function seedDeclaration(symbol = 'BHEL'): Promise<void> {
  await handle?.db.collection(COLLECTIONS.declarations).insertOne({
    symbol,
    legs: [
      { strike: 420, type: 'CE', qty: -13125 },
      { strike: 415, type: 'PE', qty: -13125 },
    ],
    declaredAt: 100,
  })
}

test('declaration migration re-keys under its tag, preserving the declared legs', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await seedDeclaration()

  const result = await migrateDeclarationToTag(handle.db, { symbol: 'BHEL', tag: TAG })

  assert.equal(result.migrated, true)
  assert.equal(result.legs, 2)
  const doc = await handle.db.collection(COLLECTIONS.declarations).findOne({ tag: TAG })
  assert.ok(doc)
  assert.equal(doc['symbol'], 'BHEL')
  assert.equal(doc['declaredAt'], 100)
  assert.equal((doc['legs'] as unknown[]).length, 2)
  assert.equal((doc['legs'] as { qty: number }[])[0]?.qty, -13125)
  // Nothing untagged left: the unique `tag` index can now be built, and `diff`
  // finds the declaration where `loadDeclaration(tag)` looks for it.
  assert.equal(
    await handle.db.collection(COLLECTIONS.declarations).countDocuments({ tag: { $exists: false } }),
    0,
  )
})

test('declaration migration is idempotent — a second run changes nothing', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await seedDeclaration()
  await migrateDeclarationToTag(handle.db, { symbol: 'BHEL', tag: TAG })
  const second = await migrateDeclarationToTag(handle.db, { symbol: 'BHEL', tag: TAG })

  assert.equal(second.migrated, false)
  assert.equal(second.reason, 'no untagged declaration for BHEL')
  assert.equal(await handle.db.collection(COLLECTIONS.declarations).countDocuments({}), 1)
})

test('declaration migration refuses to overwrite an existing tagged declaration', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await seedDeclaration()
  await handle.db.collection(COLLECTIONS.declarations).insertOne({
    tag: TAG, symbol: 'BHEL', legs: [], declaredAt: 1,
  })

  const result = await migrateDeclarationToTag(handle.db, { symbol: 'BHEL', tag: TAG })

  assert.equal(result.migrated, false)
  assert.match(result.reason ?? '', /already exists/)
  // Both survive: the operator resolves the collision, not the migration.
  assert.equal(
    await handle.db.collection(COLLECTIONS.declarations).countDocuments({ tag: { $exists: false } }),
    1,
  )
  const kept = await handle.db.collection(COLLECTIONS.declarations).findOne({ tag: TAG })
  assert.equal((kept?.['legs'] as unknown[]).length, 0, 'the destination was not overwritten')
  assert.equal(kept?.['declaredAt'], 1)
})

test('declaration migration REFUSES a non-array legs rather than declaring nothing', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await handle.db.collection(COLLECTIONS.declarations).insertOne({
    symbol: 'BHEL', legs: 'CE420', declaredAt: 100,
  })

  const result = await migrateDeclarationToTag(handle.db, { symbol: 'BHEL', tag: TAG })

  assert.equal(result.migrated, false)
  assert.match(result.reason ?? '', /legs is not an array/)
  assert.equal(await handle.db.collection(COLLECTIONS.declarations).countDocuments({ tag: TAG }), 0)
  assert.equal(
    await handle.db.collection(COLLECTIONS.declarations).countDocuments({ tag: { $exists: false } }),
    1,
  )
})

// ------------------------------------------------------- the pre-flight check

/**
 * WHY THIS EXISTS. `ensureIndexes` builds UNIQUE `{tag, mode}` and `{tag}`
 * indexes, and Mongo indexes a missing field as `null` — so two untagged
 * documents in one collection fail the build with E11000 and `main.ts:101`
 * throws before the API listens. The operator's first sight of the problem was
 * a crash loop. This is the same information, obtainable BEFORE the restart.
 */
test('migrate-check names every untagged book and declaration, and changes nothing', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await seedDeclaration()
  // A second untagged BOOK is legal here only because it is in the OTHER mode:
  // `{tag: null, mode: 'paper'}` and `{tag: null, mode: 'live'}` are distinct
  // keys. Two in ONE mode is precisely the E11000 this check exists to warn
  // about, and cannot be inserted once the index is built.
  await handle.db.collection(COLLECTIONS.books).insertOne({
    symbol: 'NIFTY', mode: 'live', legs: [], updatedAt: 1,
  })

  const check = await migrationCheck(handle.db)

  assert.equal(check.clear, false)
  assert.equal(check.books.length, 2)
  assert.deepEqual(
    [...check.books].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [
      { symbol: 'BHEL', mode: 'paper', legs: 2 },
      { symbol: 'NIFTY', mode: 'live', legs: 0 },
    ],
  )
  assert.deepEqual(check.declarations, [{ symbol: 'BHEL', legs: 2 }])
  // READ-ONLY. A pre-flight check that migrates something is not a check.
  assert.equal(await handle.db.collection(COLLECTIONS.books).countDocuments({}), 2)
  assert.equal(await handle.db.collection(COLLECTIONS.declarations).countDocuments({}), 1)
  assert.equal(
    await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: { $exists: false } }),
    2,
    'nothing was tagged by looking at it',
  )
})

test('migrate-check is clear once everything carries a tag', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await seedDeclaration()
  await migrateBookToTag(handle.db, { symbol: 'BHEL', mode: 'paper', tag: TAG })
  await migrateDeclarationToTag(handle.db, { symbol: 'BHEL', tag: TAG })

  const check = await migrationCheck(handle.db)
  assert.equal(check.clear, true, 'this is the signal that the API may be restarted')
  assert.deepEqual(check.books, [])
  assert.deepEqual(check.declarations, [])
})
