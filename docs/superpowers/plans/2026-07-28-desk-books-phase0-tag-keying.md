# Desk Books Phase 0 — Tag-Keyed Books Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key the bridge's books and declarations from `symbol` to `tag`, so two variants can run on one symbol at once, and add the per-tag fill queries the live driver's reconciliation needs.

**Architecture:** The bridge already gates every decision on `tag` (`service.ts:302`) but stores the resulting book under `{symbol, mode}` (`store.ts:161`). Two variants on one symbol therefore pass the gate independently and then silently upsert over each other's book. This plan moves the book and declaration keys to `tag`, keeps `symbol` as a non-unique attribute for listing, and migrates the one existing BHEL paper book explicitly rather than by inference.

**Tech Stack:** TypeScript, Node 24 (`node --test`, `.ts` executed directly — no build step), MongoDB via the official driver, npm workspaces.

## Global Constraints

- **Node >= 22**, ESM only (`"type": "module"`). Import local modules **with the `.ts` extension** (`import { DeskStore } from '../src/store.ts'`) — this codebase runs TypeScript directly.
- **Tests are `node:test`** — `import { test } from 'node:test'` and `import assert from 'node:assert/strict'`. Run with `npm test -w @algomaker/api`.
- **Mongo integration tests skip themselves** when no Mongo is reachable, following `apps/api/test/service.integration.test.ts:26`. Never make a test that requires Mongo fail on a machine without it.
- **`exactOptionalPropertyTypes` is on.** An optional property is not the same as one that may hold `undefined`; declare `readonly x?: string | undefined` when a caller may pass `undefined`.
- **Tag convention:** `<SYMBOL>-<EXPIRY>-<variant>`, e.g. `BHEL-2026-08-25-hold-recycle-r`.
- **Prod MongoDB is STANDALONE** (no change streams). Nothing in this plan may introduce a change stream.
- **Never restart `desk-runner` casually — it squares off positions on SIGTERM.** No task here requires restarting it; if a step seems to, stop and ask.
- Commit after every task. Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/api/src/store.ts` | Mongo persistence for books, declarations, decisions, trades | **Modify.** `StoredBook` gains `tag`/`expiry`; `BookKey` added; book + declaration methods re-keyed; `ensureIndexes` drops the old unique index |
| `apps/api/src/migrate.ts` | One-shot data migrations, invoked from the CLI | **Create.** `migrateBookToTag` — explicit, verifiable, reversible |
| `apps/api/src/service.ts` | The bridge's behaviour: decisions, positions, diff, seed, flatten | **Modify.** 14 call sites move from `(symbol, mode)` to `(tag, mode)` |
| `apps/api/src/seed.ts` | Seeds an already-held position | **Modify.** `SeedRequest` gains `tag` |
| `apps/api/src/validate.ts` | Request validation | **Modify.** `tag` required on seed and declare |
| `apps/api/src/routes/desk.ts` | HTTP routing | **Modify.** `?tag=` primary; `?symbol=` becomes a list filter |
| `apps/api/src/cli.ts` | Operator commands | **Modify.** `positions`/`diff` take a tag; add `migrate-book` |
| `apps/marketdata/src/main.ts` | Feed host | **Modify (1 line).** Pass book-level `expiry` into `planSubscriptions` |
| `apps/order-gateway/src/fills.ts` | Broker fill watcher | **Modify.** Stamp `tag` and `mode` onto `desk-fills` rows |
| `apps/api/test/store-tag.test.ts` | Book/declaration keying, against real Mongo | **Create** |
| `apps/api/test/migrate.test.ts` | Migration correctness and idempotency | **Create** |

**Not in this plan** (they are phases 1–2, planned separately): the chain endpoint, `oi`/`volume` on `md.tick`, the near-future subscription, the `desk-books` registry, the variant catalogue.

---

### Task 1: Tag-keyed book and declaration storage

**Files:**
- Modify: `apps/api/src/store.ts:129-141` (types), `:157-168` (`ensureIndexes`), `:172-187` (books), `:219-230` (declarations)
- Test: `apps/api/test/store-tag.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface BookKey { readonly tag: string; readonly mode: DeskMode; readonly symbol: string; readonly expiry: string }`
  - `StoredBook` = `{ tag, symbol, expiry, mode, legs, updatedAt }`
  - `loadBook(tag: string, mode: DeskMode): Promise<BridgeLeg[]>`
  - `bookDoc(tag: string, mode: DeskMode): Promise<StoredBook | null>` — the whole document, so a caller that needs `symbol`/`expiry` does not have to be told them
  - `saveBook(key: BookKey, legs: readonly BridgeLeg[], nowMs: number): Promise<void>`
  - `allBooks(mode: DeskMode): Promise<StoredBook[]>` (unchanged signature)
  - `booksForSymbol(symbol: string, mode: DeskMode): Promise<StoredBook[]>`
  - `saveDeclaration(tag: string, symbol: string, legs: readonly DeclaredLeg[], nowMs: number): Promise<void>`
  - `loadDeclaration(tag: string): Promise<StoredDeclaration | null>` where `StoredDeclaration` = `{ tag, symbol, legs, declaredAt }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/store-tag.test.ts`:

```ts
/**
 * Book keying, against a REAL MongoDB.
 *
 * The property under test is a database property — that two tags on one symbol
 * are two documents — so a fake store would only assert that the code does what
 * it was written to do. Skips itself when no Mongo is reachable, matching
 * `service.integration.test.ts:26`.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS, type BookKey } from '../src/store.ts'
import type { BridgeLeg } from '../src/contract.ts'

const URL = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_bridge_test'

let handle: MongoHandle | null = null
let store: DeskStore
let available = false

const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'

function key(tag: string): BookKey {
  return { tag, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY }
}

function leg(strike: number, qty: number): BridgeLeg {
  return {
    deskTag: `CE${strike}#1`,
    instrument: { tradingsymbol: `BHEL26AUG${strike}CE`, exchange: 'NFO', instrumentToken: 700000 + strike },
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike,
    type: 'CE',
    side: qty < 0 ? 'Sell' : 'Buy',
    qty,
    entryPrice: 15,
    openedTs: 1,
  }
}

before(async () => {
  try {
    handle = await connectMongo(URL)
    store = new DeskStore(handle.db)
    await store.ensureIndexes()
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
})

test('two tags on one symbol are two independent books', async (t) => {
  if (!available) return t.skip('no mongo')
  await store.saveBook(key('BHEL-2026-08-25-hold-recycle-r'), [leg(420, -13125)], 1)
  await store.saveBook(key('BHEL-2026-08-25-hold-recycle-shift-r'), [leg(425, -26250)], 2)

  const a = await store.loadBook('BHEL-2026-08-25-hold-recycle-r', 'paper')
  const b = await store.loadBook('BHEL-2026-08-25-hold-recycle-shift-r', 'paper')

  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(a[0]?.qty, -13125)
  assert.equal(b[0]?.qty, -26250)
  assert.equal((await store.booksForSymbol(SYMBOL, 'paper')).length, 2)
})

test('one tag can hold a paper and a live book at once', async (t) => {
  if (!available) return t.skip('no mongo')
  const tag = 'BHEL-2026-08-25-hold-recycle-r'
  await store.saveBook({ tag, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY }, [leg(420, -13125)], 1)
  await store.saveBook({ tag, mode: 'live', symbol: SYMBOL, expiry: EXPIRY }, [leg(430, -2625)], 2)

  assert.equal((await store.loadBook(tag, 'paper'))[0]?.qty, -13125)
  assert.equal((await store.loadBook(tag, 'live'))[0]?.qty, -2625)
})

test('declarations are keyed by tag, not symbol', async (t) => {
  if (!available) return t.skip('no mongo')
  await store.saveDeclaration('tag-a', SYMBOL, [{ strike: 420, type: 'CE', qty: -13125 }], 1)
  await store.saveDeclaration('tag-b', SYMBOL, [{ strike: 425, type: 'CE', qty: -26250 }], 2)

  assert.equal((await store.loadDeclaration('tag-a'))?.legs[0]?.qty, -13125)
  assert.equal((await store.loadDeclaration('tag-b'))?.legs[0]?.qty, -26250)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="two tags on one symbol"`

Expected: FAIL. With Mongo up, a TypeScript error that `BookKey` is not exported and `saveBook` takes 4 arguments. Without Mongo, the test skips — **start Mongo first** (`docker start algomaker-mongo`) or this step proves nothing.

- [ ] **Step 3: Add the types**

In `apps/api/src/store.ts`, replace the `StoredBook` and `StoredDeclaration` interfaces (currently at `:129-141`):

```ts
/** The identity of a book. `tag` is the key; `symbol`/`expiry` are attributes. */
export interface BookKey {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
}

export interface StoredBook {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly legs: readonly BridgeLeg[]
  readonly updatedAt: number
}

export interface StoredDeclaration {
  readonly tag: string
  readonly symbol: string
  readonly legs: readonly DeclaredLeg[]
  readonly declaredAt: number
}
```

- [ ] **Step 4: Re-key the book and declaration methods**

Replace the book methods (`:172-187`) and declaration methods (`:219-230`):

```ts
  // ---------------------------------------------------------------- books

  async loadBook(tag: string, mode: DeskMode): Promise<BridgeLeg[]> {
    const doc = await this.#db.collection<StoredBook>(COLLECTIONS.books).findOne({ tag, mode })
    return doc === null ? [] : [...doc.legs]
  }

  /** The whole document, for callers that need `symbol` or `expiry` too. */
  async bookDoc(tag: string, mode: DeskMode): Promise<StoredBook | null> {
    return await this.#db.collection<StoredBook>(COLLECTIONS.books).findOne({ tag, mode })
  }

  async saveBook(key: BookKey, legs: readonly BridgeLeg[], nowMs: number): Promise<void> {
    await this.#db.collection(COLLECTIONS.books).updateOne(
      { tag: key.tag, mode: key.mode },
      {
        $set: {
          tag: key.tag,
          mode: key.mode,
          symbol: key.symbol,
          expiry: key.expiry,
          legs,
          updatedAt: nowMs,
        },
      },
      { upsert: true },
    )
  }

  async allBooks(mode: DeskMode): Promise<StoredBook[]> {
    return await this.#db.collection<StoredBook>(COLLECTIONS.books).find({ mode }).toArray()
  }

  /**
   * Every book on one symbol. NOT unique any more — that is the whole point of
   * this key change, and callers that want one book must ask by tag.
   */
  async booksForSymbol(symbol: string, mode: DeskMode): Promise<StoredBook[]> {
    return await this.#db.collection<StoredBook>(COLLECTIONS.books).find({ symbol, mode }).toArray()
  }
```

```ts
  // --------------------------------------------------------- declarations

  /** What the desk says it holds (D2). Overwritten each declare; it is a snapshot. */
  async saveDeclaration(
    tag: string,
    symbol: string,
    legs: readonly DeclaredLeg[],
    nowMs: number,
  ): Promise<void> {
    await this.#db
      .collection(COLLECTIONS.declarations)
      .updateOne({ tag }, { $set: { tag, symbol, legs, declaredAt: nowMs } }, { upsert: true })
  }

  async loadDeclaration(tag: string): Promise<StoredDeclaration | null> {
    return await this.#db
      .collection<StoredDeclaration>(COLLECTIONS.declarations)
      .findOne({ tag })
  }
```

- [ ] **Step 5: Change the indexes, dropping the old ones first**

Replace the two book/declaration lines inside `ensureIndexes` (`:161-162`):

```ts
    /**
     * Books are keyed by TAG, not by symbol.
     *
     * The old index was `{symbol, mode}` UNIQUE, which meant two variants on one
     * symbol — the entire point of running an A/B — upserted over each other with
     * no error, because `saveBook` is an upsert. `symbol` survives as a NON-unique
     * index so "every book on BHEL" is still one query.
     *
     * `dropIndex` runs first because Mongo rejects `createIndex` on the same keys
     * with different options, and it is tolerant of the index being absent so this
     * is safe to run on a fresh database and on every boot.
     */
    await dropIfPresent(this.#db.collection(COLLECTIONS.books), 'symbol_1_mode_1')
    await dropIfPresent(this.#db.collection(COLLECTIONS.declarations), 'symbol_1')
    await this.#db.collection(COLLECTIONS.books).createIndex({ tag: 1, mode: 1 }, { unique: true })
    await this.#db.collection(COLLECTIONS.books).createIndex({ symbol: 1, mode: 1 })
    await this.#db.collection(COLLECTIONS.declarations).createIndex({ tag: 1 }, { unique: true })
```

Add this helper above the `DeskStore` class:

```ts
/**
 * Drop an index if it exists, tolerating both "no such index" and "no such
 * collection". Boot must not fail on a database that has never been written to.
 */
async function dropIfPresent(collection: { dropIndex(name: string): Promise<unknown> }, name: string): Promise<void> {
  try {
    await collection.dropIndex(name)
  } catch {
    // IndexNotFound (27) or NamespaceNotFound (26). Both mean "already absent".
  }
}
```

Widen the `Collection` port at `store.ts:66-69` so `dropIndex` type-checks:

```ts
  dropIndex(name: string): Promise<unknown>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @algomaker/api -- --test-name-pattern="tags on one symbol|paper and a live book|keyed by tag"`

Expected: 3 passing. If they skip, Mongo is not running and the task is unverified.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/store.ts apps/api/test/store-tag.test.ts
git commit -m "refactor(api): key books and declarations by tag, not symbol

Two variants on one symbol carried different tags, passed the strategy
gate independently, then upserted over each other's book with no error.
symbol survives as a non-unique index for listing."
```

---

### Task 2: Migrate the existing BHEL book

**Files:**
- Create: `apps/api/src/migrate.ts`
- Modify: `apps/api/src/cli.ts` (add a `migrate-book` command)
- Test: `apps/api/test/migrate.test.ts` (create)

**Interfaces:**
- Consumes: `BookKey`, `StoredBook`, `COLLECTIONS` from Task 1.
- Produces: `migrateBookToTag(db, opts): Promise<MigrationResult>` where
  `opts = { symbol: string; mode: DeskMode; tag: string; expiry?: string | undefined }` and
  `MigrationResult = { migrated: boolean; tag: string; legs: number; expiry: string; reason?: string }`.

**Why an explicit command rather than an automatic upgrade:** the tag encodes the **variant**, which no existing document records. Only the operator knows that the BHEL paper book is to be managed by `hold-recycle-r`. Inferring it would be guessing at the identity of a live position.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/migrate.test.ts`:

```ts
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { migrateBookToTag } from '../src/migrate.ts'

const URL = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_bridge_test'
const TAG = 'BHEL-2026-08-25-hold-recycle-r'

let handle: MongoHandle | null = null
let available = false

before(async () => {
  try {
    handle = await connectMongo(URL)
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="migration"`
Expected: FAIL — `Cannot find module '../src/migrate.ts'`.

- [ ] **Step 3: Write the migration**

Create `apps/api/src/migrate.ts`:

```ts
/**
 * One-shot data migrations.
 *
 * Explicit and reversible by construction: a migration reads the old document,
 * writes the new one, and only then deletes the old. It never infers identity —
 * the tag encodes the VARIANT, which no stored document records, so the operator
 * supplies it. Guessing the identity of a live position is not a migration.
 */

import type { DeskMode } from './contract.ts'
import { COLLECTIONS, type Database } from './store.ts'

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

  const legs = Array.isArray(old['legs']) ? (old['legs'] as Record<string, unknown>[]) : []
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
```

`Database` and `Collection` in `store.ts` must expose `findOne`, `deleteOne` and `countDocuments`. Add whichever are missing to the port at `store.ts:60-70`:

```ts
  deleteOne(filter: Record<string, unknown>): Promise<unknown>
  countDocuments(filter?: Record<string, unknown>): Promise<number>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @algomaker/api -- --test-name-pattern="migration"`
Expected: 3 passing.

- [ ] **Step 5: Add the CLI command**

In `apps/api/src/cli.ts`, add a case beside the existing `seed-bhel` (`:68`):

```ts
      case 'migrate-book': {
        const symbol = arg('--symbol')
        const tag = arg('--tag')
        const mode = (arg('--mode') ?? 'paper') as DeskMode
        if (symbol === undefined || tag === undefined) {
          console.error('usage: migrate-book --symbol BHEL --tag BHEL-2026-08-25-hold-recycle-r [--mode paper] [--expiry YYYY-MM-DD]')
          process.exitCode = 2
          break
        }
        const expiry = arg('--expiry')
        // `mongo.db` — `main()` already holds the handle at cli.ts:38. `DeskStore`
        // exposes no public `db` accessor; do not add one for this.
        const result = await migrateBookToTag(
          mongo.db,
          expiry === undefined ? { symbol, mode, tag } : { symbol, mode, tag, expiry },
        )
        console.log(JSON.stringify(result, null, 2))
        if (!result.migrated) process.exitCode = 1
        break
      }
```

Import it at the top: `import { migrateBookToTag } from './migrate.ts'`. Update the usage line at `:146` to include `migrate-book`.

- [ ] **Step 6: Verify the CLI end to end against the real book**

```bash
node apps/api/src/cli.ts positions BHEL          # BEFORE: record the legs and entry prices
node apps/api/src/cli.ts migrate-book --symbol BHEL --tag BHEL-2026-08-25-hold-recycle-r
node apps/api/src/cli.ts migrate-book --symbol BHEL --tag BHEL-2026-08-25-hold-recycle-r   # idempotent
```

Expected: the first `migrate-book` prints `"migrated": true`, `"legs": 8`, `"expiry": "2026-08-25"`. The second prints `"migrated": false` with reason `no untagged book for BHEL/paper` and exits 1. **Compare the leg count and every `entryPrice` against the BEFORE output** — the cost basis is what makes every subsequent P&L number right.

**Rollback if wrong:** the migration only ever writes a new document and deletes the old one, so to reverse it, re-seed from `apps/api/src/seed.ts:131`'s `BHEL_SEED` (which is still in the tree at this point in the plan) after deleting the tagged document.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/migrate.ts apps/api/src/cli.ts apps/api/test/migrate.test.ts
git commit -m "feat(api): migrate a symbol-keyed book to its tag

Explicit rather than inferred: the tag encodes the variant, which no
stored document records. Writes the new document before deleting the
old, so a crash mid-migration leaves both rather than neither."
```

---

### Task 3: Rewire `service.ts` to tag-keyed books

**Files:**
- Modify: `apps/api/src/service.ts` — `:264`, `:512`, `:574`, `:604`, `:765`, `:1147`, `:1215`, `:1223`, `:1314`
- Modify: `apps/api/src/seed.ts:20-40` (`SeedRequest`), `:102`, `:109`
- Modify: `apps/api/src/validate.ts:155-193` (seed), `:200-215` (declare)
- Test: `apps/api/test/service.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `BookKey`, `loadBook(tag, mode)`, `saveBook(key, legs, now)`, `booksForSymbol`, `saveDeclaration(tag, symbol, legs, now)`, `loadDeclaration(tag)` from Task 1.
- Produces:
  - `service.positions(tag: string, mode: DeskMode): Promise<PositionsResponse>` — `PositionsResponse` gains `readonly tag: string`
  - `service.diff(tag: string, mode: DeskMode)`
  - `service.books(mode)` rows gain `readonly tag: string` and `readonly expiry: string`
  - `SeedRequest` gains `readonly tag: string`
  - `DeclareRequest` gains `readonly tag: string`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/service.integration.test.ts`:

```ts
test('two tags on one symbol keep independent books through applyDecision', async (t) => {
  if (!available) return t.skip('no mongo')
  const svc = service()   // the existing helper in this file
  await store.upsertStrategy({ tag: 'BHEL-A', kind: 'external', modes: { paper: 'on' } })
  await store.upsertStrategy({ tag: 'BHEL-B', kind: 'external', modes: { paper: 'on' } })

  await svc.applyDecision({
    symbol: SYMBOL, expiry: EXPIRY, mode: 'paper', tag: 'BHEL-A', decisionId: 'a-1',
    actions: [{ op: 'open', ts: 'CE500#1', strike: 500, type: 'CE', side: 'Sell', qty: 1350 }],
  })
  await svc.applyDecision({
    symbol: SYMBOL, expiry: EXPIRY, mode: 'paper', tag: 'BHEL-B', decisionId: 'b-1',
    actions: [{ op: 'open', ts: 'CE505#1', strike: 505, type: 'CE', side: 'Sell', qty: 2700 }],
  })

  const a = await svc.positions('BHEL-A', 'paper')
  const b = await svc.positions('BHEL-B', 'paper')
  assert.equal(a.legs.length, 1)
  assert.equal(b.legs.length, 1)
  assert.equal(a.legs[0]?.strike, 500)
  assert.equal(b.legs[0]?.strike, 505)
})
```

Adjust `upsertStrategy`/`service()` to whatever the existing helpers in that file are actually named — read the file first; do not invent helpers.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="independent books through applyDecision"`
Expected: FAIL — `positions` takes a symbol, so both calls resolve to the same book and the second assertion reports 2 legs (or a type error).

- [ ] **Step 3: Rewire the book reads and writes**

In `service.ts`, at each site:

| Line | From | To |
|---|---|---|
| `:264` | `loadBook(req.symbol, req.mode)` | `loadBook(req.tag, req.mode)` |
| `:512` | `saveBook(req.symbol, req.mode, savedBook, now)` | `saveBook({ tag: req.tag, mode: req.mode, symbol: req.symbol, expiry: req.expiry }, savedBook, now)` |
| `:574` | `loadBook(req.symbol, req.mode)` | `loadBook(req.tag, req.mode)` |
| `:604` | `loadBook(req.symbol, req.mode)` | `loadBook(req.tag, req.mode)` |
| `:765` | `loadBook(params.symbol, params.mode)` | `loadBook(params.tag, params.mode)` — add `tag` to that params type |
| `:1147` | `loadBook(symbol, mode)` in `positions` | `loadBook(tag, mode)`; signature becomes `positions(tag, mode)` |
| `:1215` | `loadBook(symbol, mode)` in `diff` | `loadBook(tag, mode)`; signature becomes `diff(tag, mode)` |
| `:1223` | `saveDeclaration(symbol, legs, now)` | `saveDeclaration(tag, symbol, legs, now)`; signature becomes `declare(tag, symbol, legs)` |

`positions` needs the underlying for spot and greeks, and it no longer receives it. Read it off the stored document:

```ts
  async positions(tag: string, mode: DeskMode): Promise<PositionsResponse> {
    const doc = await this.#d.store.bookDoc(tag, mode)
    const legs = doc?.legs ?? []
    const symbol = doc?.symbol ?? ''
    // ... the rest of the existing body, with `symbol` now a local rather than a parameter
    return { tag, symbol, legs: priced, greeks: { ... }, spot, complete, ... }
  }
```

`bookDoc` was added to `DeskStore` in Task 1:

```ts
  async bookDoc(tag: string, mode: DeskMode): Promise<StoredBook | null> {
    return await this.#db.collection<StoredBook>(COLLECTIONS.books).findOne({ tag, mode })
  }
```

- [ ] **Step 4: Add `tag` to seed and declare**

`apps/api/src/seed.ts` — add to `SeedRequest`:

```ts
export interface SeedRequest {
  /** The book's identity. Books are keyed by tag; see store.ts. */
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly legs: readonly SeedLeg[]
}
```

At `:102` and `:109`, swap to the tag key:

```ts
  const existing = await deps.store.loadBook(req.tag, req.mode)
  // ...
  await deps.store.saveBook(
    { tag: req.tag, mode: req.mode, symbol: req.symbol, expiry: req.expiry },
    result.booked,
    deps.nowMs,
  )
```

`apps/api/src/validate.ts` — in `validateSeedRequest`, after the `symbol` check (`:157`):

```ts
  if (!isNonEmptyString(raw['tag'])) return fail('tag is required')
```

and add `tag: raw['tag']` to the returned object at `:186`. Do the same in `validateDeclareRequest` (`:200`), adding `tag` to `DeclareRequest`.

`BHEL_SEED` at `seed.ts:131` gains a tag:

```ts
export const BHEL_SEED: SeedRequest = {
  tag: 'BHEL-2026-08-25-hold-recycle-r',
  symbol: 'BHEL',
  // ... unchanged
}
```

- [ ] **Step 5: Add `tag` and `expiry` to the books listing**

At `service.ts:1314`, the `books(mode)` rows come from `allBooks(mode)`. Add the two fields to both the return type and the mapping:

```ts
  async books(mode: DeskMode): Promise<
    readonly {
      tag: string
      symbol: string
      expiry: string
      legs: number
      netDelta: number | null
      complete: boolean
      updatedAt: number
    }[]
  > {
```

and in the body, carry `tag: stored.tag` and `expiry: stored.expiry` through, calling `this.positions(stored.tag, mode)` rather than by symbol.

- [ ] **Step 6: Run the whole API suite**

Run: `npm test -w @algomaker/api`

Expected: all pass. Existing tests that call `positions(SYMBOL, ...)` or `saveBook(SYMBOL, ...)` will fail to compile — **update them to pass a tag**; do not weaken an assertion to make it go green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/service.ts apps/api/src/seed.ts apps/api/src/validate.ts apps/api/src/store.ts apps/api/test/
git commit -m "refactor(api): service reads and writes books by tag

positions and diff take a tag; the underlying is read off the stored
document rather than passed in. seed and declare now require a tag."
```

---

### Task 4: Routes — `?tag=` primary, `?symbol=` as a list filter

**Files:**
- Modify: `apps/api/src/routes/desk.ts:120-138` (positions, diff), `:814-829` (trades, books)
- Test: `apps/api/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `service.positions(tag, mode)`, `service.diff(tag, mode)`, `service.books(mode)` from Task 3.
- Produces: HTTP contract — `GET /v1/desk/positions?tag=X&mode=paper` returns one book; `GET /v1/desk/positions?symbol=BHEL&mode=paper` returns `{ books: [...] }`; a request with neither is `400`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/server.test.ts`, following the request helper already in that file:

```ts
test('GET /v1/desk/positions?tag= returns one book', async () => {
  const res = await request('/v1/desk/positions?tag=BHEL-A&mode=paper')
  assert.equal(res.status, 200)
  assert.equal(res.body.tag, 'BHEL-A')
})

test('GET /v1/desk/positions?symbol= returns every book on that symbol', async () => {
  const res = await request('/v1/desk/positions?symbol=BHEL&mode=paper')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body.books))
})

test('GET /v1/desk/positions with neither tag nor symbol is a 400', async () => {
  const res = await request('/v1/desk/positions?mode=paper')
  assert.equal(res.status, 400)
  assert.match(res.body.error, /tag or symbol/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="desk/positions"`
Expected: FAIL — the handler requires `symbol` and returns a single book for it.

- [ ] **Step 3: Rewrite the positions and diff handlers**

Replace `routes/desk.ts:120-138`:

```ts
    if (path === '/v1/desk/positions' && method === 'GET') {
      const tag = url.searchParams.get('tag')
      const symbol = url.searchParams.get('symbol')
      const mode = modeOf(url)
      if (tag !== null) {
        send(200, await service.positions(tag, mode))
        return true
      }
      /**
       * `symbol` is a LIST filter now, not a key. It used to name one book,
       * which is exactly the assumption that let two variants overwrite each
       * other. Answering with an array rather than picking one is the honest
       * shape — there is no "the" book for a symbol any more.
       */
      if (symbol !== null) {
        const rows = await service.booksForSymbol(symbol, mode)
        send(200, { books: rows })
        return true
      }
      send(400, { error: 'tag or symbol is required' })
      return true
    }

    if (path === '/v1/desk/diff' && method === 'GET') {
      const tag = url.searchParams.get('tag')
      if (tag === null) {
        send(400, { error: 'tag is required' })
        return true
      }
      send(200, await service.diff(tag, modeOf(url)))
      return true
    }
```

Add `booksForSymbol` to `BridgeService`, beside `books` (`service.ts:1305`):

```ts
  /** Every book on one symbol, each fully priced. The symbol tab's data. */
  async booksForSymbol(symbol: string, mode: DeskMode): Promise<readonly PositionsResponse[]> {
    const rows = await this.#d.store.booksForSymbol(symbol, mode)
    return await Promise.all(rows.map(async (r) => await this.positions(r.tag, mode)))
  }
```

The `/v1/desk/trades` handler is **not** touched here — it needs `service.fills`'s new
signature, which Task 5 introduces. Changing it now would not compile.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @algomaker/api`
Expected: all pass, including the three new route tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/desk.ts apps/api/src/service.ts apps/api/test/server.test.ts
git commit -m "feat(api): positions and diff take a tag; symbol lists books

symbol was a key and is now a filter, so it answers with an array. A
request naming neither is a 400 rather than a guess."
```

---

### Task 5: Per-tag fill queries on both rails

**Files:**
- Modify: `apps/order-gateway/src/fills.ts` (stamp `tag` and `mode` onto `desk-fills`)
- Modify: `apps/api/src/service.ts:1295-1302` (`fills`, `paperTrades`)
- Modify: `apps/api/src/store.ts:233` (`listPaperTrades`)
- Test: `apps/api/test/pnl-routes.test.ts` or a new `apps/api/test/trades-tag.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `service.fills(opts: { tag?: string | null; limit?: number }): Promise<readonly Record<string, unknown>[]>`
  - `service.paperTrades(opts: { tag?: string | null; symbol?: string | null; limit?: number }): Promise<readonly Record<string, unknown>[]>`
  - `desk-fills` documents gain `tag: string` and `mode: 'live'`

**Why this is here and not in the Python phase:** the live driver reconciles **every mark** against `/v1/desk/trades?tag=`. Without a tag on the rows, a two-variant symbol returns the sibling book's fills mixed in, and the reconcile corrects the wrong legs.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/trades-tag.test.ts`:

Put this in `apps/order-gateway/test/gateway.test.ts` (it tests gateway code, so it belongs in
that workspace):

```ts
test('a fill record carries the tag of the order that produced it', () => {
  const record = toFillRecord(
    {
      clientOrderId: 'dec-1#0',
      brokerOrderId: 'B1',
      status: 'FILLED',
      filledQty: 2625,
      avgPrice: 15.4,
    } as PlacedOrder,
    'BHEL26AUG420CE',
    1_700_000_000_000,
    { tag: 'BHEL-2026-08-25-hold-recycle-r', mode: 'live' },
  )
  assert.equal(record.tag, 'BHEL-2026-08-25-hold-recycle-r')
  assert.equal(record.mode, 'live')
})
```

The real signature today is
`toFillRecord(update: PlacedOrder, tradingsymbol: string, nowMs: number): FillRecord`
(`gateway.ts:277`). Add a **fourth** parameter `ctx: { tag: string; mode: 'live' }` — do not
reorder the existing three, and update every existing call site.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @algomaker/order-gateway -- --test-name-pattern="carries the tag"`
Expected: FAIL — `toFillRecord` takes one argument and the record has no `tag`.

- [ ] **Step 3: Stamp the tag at the write site**

In `apps/order-gateway/src/gateway.ts:277`, add the fourth parameter and spread both fields onto
the returned record (also add `tag` and `mode` to the `FillRecord` interface). In
`apps/order-gateway/src/fills.ts`, the order is already loaded at `:124` and its tag already
journalled at `:132`, so pass `{ tag: order.tag, mode: 'live' }` through.

- [ ] **Step 4: Add the filters**

`apps/api/src/service.ts:1295`:

```ts
  /**
   * Broker fills. `tag` is required for per-book reconciliation — without it a
   * two-variant symbol returns the sibling book's fills and the reconcile
   * corrects the wrong legs.
   */
  async fills(opts: { tag?: string | null; limit?: number } = {}): Promise<readonly Record<string, unknown>[]> {
    const filter: Record<string, unknown> = {}
    if (opts.tag !== undefined && opts.tag !== null) filter['tag'] = opts.tag
    return await this.#d.store
      .collection('desk-fills')
      .find(filter)
      .sort({ ts: -1 })
      .limit(opts.limit ?? 200)
      .toArray()
  }

  async paperTrades(opts: { tag?: string | null; symbol?: string | null; limit?: number } = {}): Promise<readonly Record<string, unknown>[]> {
    return await this.#d.store.listPaperTrades(opts)
  }
```

`apps/api/src/store.ts:233`:

```ts
  async listPaperTrades(
    opts: { tag?: string | null; symbol?: string | null; limit?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const filter: Record<string, unknown> = {}
    if (opts.tag !== undefined && opts.tag !== null) filter['tag'] = opts.tag
    if (opts.symbol !== undefined && opts.symbol !== null) filter['underlying'] = opts.symbol
    return await this.#db
      .collection(COLLECTIONS.paperTrade)
      .find(filter)
      .sort({ order_timestamp: -1 })
      .limit(opts.limit ?? 200)
      .toArray()
  }
```

The paper side needs no write change: `orderDocument` already emits `tag: ctx.tag`
(`rail.ts:100`), and `PaperRail.route` builds its document from it. Only the **query** is new.

- [ ] **Step 5: Wire the trades route**

Now that both signatures exist, replace `routes/desk.ts:814-825`:

```ts
    if (path === '/v1/desk/trades' && method === 'GET') {
      const limit = limitOf(url, 200)
      const mode = modeOf(url)
      const tag = url.searchParams.get('tag')
      const symbol = url.searchParams.get('symbol')
      send(200, {
        trades:
          mode === 'live'
            ? await service.fills({ tag, limit })
            : await service.paperTrades({ tag, symbol, limit }),
      })
      return true
    }
```

- [ ] **Step 6: Run the suites**

Run: `npm test -w @algomaker/order-gateway && npm test -w @algomaker/api`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/order-gateway/src apps/api/src apps/api/test apps/order-gateway/test
git commit -m "feat: tag every fill and filter trades by it on both rails

The live driver reconciles per book on every mark. Untagged rows made a
two-variant symbol return the sibling book's fills."
```

---

### Task 6: The flat-book subscription fix

**Files:**
- Modify: `apps/marketdata/src/main.ts:273-290`
- Test: `apps/marketdata/test/subscription-source.test.ts` (extend)

**Interfaces:**
- Consumes: `StoredBook.expiry` from Task 1.
- Produces: no new API. Behavioural: a book with zero legs still subscribes its expiry's chain.

**Why:** `planSubscriptions` derives the expiry as `book.expiry ?? book.legs[0]?.expiry` (`subscription-source.ts:90`), and `main.ts` never passes a book-level `expiry`. For a book with legs it works by accident. For a **flat** book — every new book created through the phase-2 registry — there are no legs, so no expiry, so no chain, so the desk can never open its first leg.

- [ ] **Step 1: Write the failing test**

Append to `apps/marketdata/test/subscription-source.test.ts`:

```ts
test('a flat book still subscribes its expiry chain', () => {
  const plan = planSubscriptions({
    books: [{ symbol: 'BHEL', expiry: '2026-08-25', legs: [] }],
    resolver: testResolver(),   // the helper already in this file
    fullChain: true,
  })
  assert.ok(plan.tokens.length > 1, 'expected the chain plus spot, got only spot')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @algomaker/marketdata -- --test-name-pattern="flat book"`
Expected: this test may PASS — `planSubscriptions` already honours a book-level expiry. That is the point: the unit is correct and **the caller** is not. Confirm the gap at the caller instead:

```bash
grep -n "symbol: b.symbol" -A 4 apps/marketdata/src/main.ts
```

Expected: the mapping passes `symbol` and `legs` but no `expiry`.

- [ ] **Step 3: Fix the caller**

In `apps/marketdata/src/main.ts:273-290`, in the `books.map(...)` passed to `planSubscriptions`, add the expiry:

```ts
        books: books.map((b) => ({
          symbol: b.symbol,
          // Book-level expiry, so a FLAT book still subscribes its chain. Without
          // it the expiry is only ever inferred from legs[0], and a book with no
          // legs subscribes nothing — so it can never open its first leg.
          expiry: b.expiry ?? b.legs[0]?.expiry,
          legs: b.legs,
        })),
```

- [ ] **Step 4: Run the suite**

Run: `npm test -w @algomaker/marketdata`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/marketdata/src/main.ts apps/marketdata/test/subscription-source.test.ts
git commit -m "fix(marketdata): pass book-level expiry into planSubscriptions

A flat book inferred its expiry from legs[0], had none, and subscribed
no chain — so it could never open its first leg."
```

---

### Task 7: Secrets and the stale live-gate comment

**Files:**
- Modify: `.env.prod` (on the server; **not** committed)
- Modify: `apps/api/src/rail.ts:225-228` (comment only)

**Interfaces:** none.

- [ ] **Step 1: Generate a real token**

```bash
openssl rand -hex 32
```

Set `DESK_API_TOKEN` in `.env.prod` on the server to the output. It is currently a readable placeholder. Every client — the Python driver, the dashboard's machine calls — uses this value.

- [ ] **Step 2: Restart ONLY the API and marketdata**

```bash
pm2 restart desk-api desk-marketdata
```

**Do NOT restart `desk-runner`** — it squares off positions on SIGTERM. It does not read `DESK_API_TOKEN` for this purpose and must be left alone.

- [ ] **Step 3: Verify the token is enforced**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/v1/desk/books
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $DESK_API_TOKEN" http://127.0.0.1:8790/v1/desk/books
```

Expected: `401` then `200`.

- [ ] **Step 4: Correct the stale comment**

`apps/api/src/rail.ts:225-228` says the second live gate is `account.strategy[tag]` in `xtsOrder.js:99`. That executor is **retired**. Replace with:

```ts
 * This is the FIRST of two independent gates. The second is the ORDER-GATEWAY's
 * own `DESK_LIVE_TAGS` check (`apps/order-gateway/src/main.ts:495`) — a separate
 * process refusing independently. Both read the same variable from the shared
 * ecosystem env, but each needs its OWN restart to pick up a change. Neither
 * defaults to on.
```

Verify the gateway line number before writing it: `grep -n "DESK_LIVE_TAGS" apps/order-gateway/src/main.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/rail.ts
git commit -m "docs(api): correct the second live gate to the gateway's allowlist

The comment described xtsOrder.js's account.strategy[tag], which is the
retired executor's mechanism."
```

---

## Phase exit condition

### DEPLOY ORDER: MIGRATE FIRST, THEN RESTART THE API

**The new code cannot boot on a pre-migration database.** `ensureIndexes` builds UNIQUE indexes on
`{tag, mode}` (`desk-books`) and `{tag}` (`desk-declarations`), and **Mongo indexes a missing field
as `null`** — so two untagged documents in one collection are two rows with the same key and the
build fails:

```
E11000 duplicate key error ... index: tag_1_mode_1 dup key: { tag: null, mode: "paper" }
```

`apps/api/src/main.ts:101` calls `ensureIndexes()` and does not catch it, so the API **does not
start**. It is a crash loop, not a degraded boot, and the first sight of it is `pm2 logs`.

Run this on the server, in this order, **before** restarting anything:

```bash
cd /opt/algomaker-delta

# 1. WHAT MUST BE MIGRATED. Read-only; exits 1 while anything is outstanding.
node apps/api/src/cli.ts migrate-check

# 2. Migrate every line it printed. One command per document — the tag encodes the VARIANT,
#    which no stored document records, so the operator supplies it. There is no bulk mode and
#    there must not be one: guessing the identity of a live position is not a migration.
node apps/api/src/cli.ts migrate-book --symbol BHEL --tag BHEL-2026-08-25-hold-recycle-r --mode paper
node apps/api/src/cli.ts migrate-declaration --symbol BHEL --tag BHEL-2026-08-25-hold-recycle-r

# 3. Confirm. Only when this says "nothing untagged" may the API be restarted.
node apps/api/src/cli.ts migrate-check

# 4. NOW restart.
pm2 restart desk-api
```

**`cli.ts` deliberately does not call `ensureIndexes`** (see the header comment in that file). That
is what makes step 2 possible at all: a tool that built the new indexes on connect would refuse to
run against precisely the database it exists to repair. Do not "helpfully" add it.

Both migrations write the new document **before** deleting the old one, delete by `_id`, refuse
rather than overwrite an occupied tag, and are idempotent — a re-run of a completed migration
reports "no untagged book/declaration", not a collision. A migration that refuses leaves the source
untouched; fix what it names and run it again.

**Rollback:** the previous release keys books by `{symbol, mode}` and will not find a migrated book.
Rolling the code back therefore means rolling the data back too — there is no reverse migration, so
take a `mongodump` of `desk-books` and `desk-declarations` before step 2.

### Verification

All of the following must hold before phase 1 starts:

```bash
npm test -w @algomaker/api && npm test -w @algomaker/marketdata && npm test -w @algomaker/order-gateway
node apps/api/src/cli.ts positions BHEL-2026-08-25-hold-recycle-r --mode paper
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" 'http://127.0.0.1:8790/v1/desk/positions?symbol=BHEL&mode=paper' | jq '.books | length'
```

Expected: every suite green; the CLI prints the 8 BHEL legs with their original entry prices (420CE @15, 425CE @13, 430CE @11, 470CE @2.9, 415PE @14, 410PE @12, 405PE @9, 380PE @3.55); the curl prints `1`.

## Self-review

**Spec coverage** — this plan implements the phase-0 row of spec §8 and these spec requirements: §2 (book identity, all of it), §3.1's `desk-fills` tag / `?tag=` on trades / `expiry` on the `allBooks` mapping / real `DESK_API_TOKEN`, and §7.2's gate-2 correction. Spec §9 test 7 ("two variants on one symbol produce two independent books") is Task 1 Step 1 and Task 3 Step 1.

**Deliberately deferred to later plans:** the chain endpoint, `oi`/`volume` on `md.tick`, the near-future subscription and per-quote `asOf` (phase 1); the `desk-books` registry and variant catalogue (phase 2); everything Python (phase 3+). `BHEL_SEED` at `seed.ts:131` is left in place here — it is the migration's rollback path — and is removed in phase 2 when the registry replaces it.

**Known follow-up:** `apps/web/src/{api,pages,App}.tsx` still call `?symbol=` for positions. The `?symbol=` route keeps working (returning `{books:[...]}` instead of one book), so the dashboard will render wrongly until the phase-5 UI work. Verify this before starting phase 5 and treat it as the first task there. Root typecheck skips `apps/web`, so run `npx tsc -p apps/web --noEmit` explicitly when that lands.
