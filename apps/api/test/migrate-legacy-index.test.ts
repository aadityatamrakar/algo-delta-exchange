import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
// For its import-time guards only: a DESK_TEST_MONGO* URL outside algomaker_dx_* is refused before this suite connects.
import './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { COLLECTIONS } from '../src/store.ts'
import { migrateBookToTag, migrateDeclarationToTag } from '../src/migrate.ts'

/**
 * `migrate.test.ts` calls `DeskStore.ensureIndexes()` in its `before()`, which
 * DROPS the old unique `symbol_1_mode_1` / `symbol_1` indexes before any
 * migration test runs. That is not the database `migrate-book` actually faces
 * in production: the CLI runs BEFORE the API boots, precisely so the new
 * unique `{tag, mode}` / `{tag}` indexes are never built over untagged
 * documents — and "before the API boots" means the OLD unique indexes are
 * still standing. `migrateBookToTag` writes the new tagged document before
 * deleting the old untagged one (so a crash mid-migration is recoverable, not
 * silently destructive), and for one instant both documents share
 * `{symbol, mode}`. Under the old unique index that instant is an E11000, not
 * a transient state — the migration cannot complete under the exact
 * conditions it exists to run in.
 *
 * This file recreates that real pre-boot state by hand — the old unique
 * indexes present, `ensureIndexes` never called — rather than relying on
 * whatever the fake or a shared `before()` happens to leave behind.
 *
 * Its own database: this package runs test files concurrently and every other
 * Mongo test file already claims its own database for that reason.
 */
const URL =
  process.env['DESK_TEST_MONGO_LEGACY_INDEX'] ??
  'mongodb://127.0.0.1:27017/algomaker_dx_bridge_migrate_legacy_index_test'
const TAG = 'BHEL-2026-08-25-hold-recycle-r'

let handle: MongoHandle | null = null
let available = false

before(async () => {
  try {
    handle = await connectMongo(URL)
    await handle.db.collection(COLLECTIONS.books).deleteMany({})
    await handle.db.collection(COLLECTIONS.declarations).deleteMany({})
    // The EXACT indexes a fresh, never-migrated production database carries —
    // same keys, same names Mongo derives by default — with `ensureIndexes`
    // never invoked. See `store.ts`'s `ensureIndexes` for why these names
    // matter: `dropIfPresent` targets them by name.
    await handle.db
      .collection(COLLECTIONS.books)
      .createIndex({ symbol: 1, mode: 1 }, { unique: true, name: 'symbol_1_mode_1' })
    await handle.db
      .collection(COLLECTIONS.declarations)
      .createIndex({ symbol: 1 }, { unique: true, name: 'symbol_1' })
    available = true
  } catch {
    available = false
  }
})

after(async () => {
  if (handle !== null) await handle.close()
})

test('migrateBookToTag succeeds against the real pre-boot database: old unique symbol_1_mode_1 index still standing, ensureIndexes never run', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await handle.db.collection(COLLECTIONS.books).deleteMany({})
  await handle.db.collection(COLLECTIONS.books).insertOne({
    symbol: 'BHEL',
    mode: 'paper',
    legs: [
      {
        deskTag: 'CE420#seed',
        underlying: 'BHEL',
        expiry: '2026-08-25',
        strike: 420,
        type: 'CE',
        side: 'Sell',
        qty: -13125,
        entryPrice: 15,
        openedTs: 1,
        instrument: { tradingsymbol: 'BHEL26AUG420CE', exchange: 'NFO', instrumentToken: 700420 },
      },
      {
        deskTag: 'PE415#seed',
        underlying: 'BHEL',
        expiry: '2026-08-25',
        strike: 415,
        type: 'PE',
        side: 'Sell',
        qty: -13125,
        entryPrice: 14,
        openedTs: 1,
        instrument: { tradingsymbol: 'BHEL26AUG415PE', exchange: 'NFO', instrumentToken: 700415 },
      },
    ],
    updatedAt: 100,
  })

  const result = await migrateBookToTag(handle.db, { symbol: 'BHEL', mode: 'paper', tag: TAG })

  assert.equal(result.migrated, true)
  assert.equal(result.legs, 2)
  const doc = await handle.db.collection(COLLECTIONS.books).findOne({ tag: TAG, mode: 'paper' })
  assert.ok(doc)
  assert.equal(doc['symbol'], 'BHEL')
  assert.equal((doc['legs'] as { entryPrice: number }[])[0]?.entryPrice, 15)
  assert.equal(
    await handle.db.collection(COLLECTIONS.books).countDocuments({ tag: { $exists: false } }),
    0,
  )
})

test('migrateDeclarationToTag succeeds against the real pre-boot database: old unique symbol_1 index still standing', async (t) => {
  if (!available || handle === null) return t.skip('no mongo')
  await handle.db.collection(COLLECTIONS.declarations).deleteMany({})
  await handle.db.collection(COLLECTIONS.declarations).insertOne({
    symbol: 'BHEL',
    legs: [
      { strike: 420, type: 'CE', qty: -13125 },
      { strike: 415, type: 'PE', qty: -13125 },
    ],
    declaredAt: 100,
  })

  const result = await migrateDeclarationToTag(handle.db, { symbol: 'BHEL', tag: TAG })

  assert.equal(result.migrated, true)
  assert.equal(result.legs, 2)
  const doc = await handle.db.collection(COLLECTIONS.declarations).findOne({ tag: TAG })
  assert.ok(doc)
  assert.equal(doc['symbol'], 'BHEL')
  assert.equal(
    await handle.db.collection(COLLECTIONS.declarations).countDocuments({ tag: { $exists: false } }),
    0,
  )
})
