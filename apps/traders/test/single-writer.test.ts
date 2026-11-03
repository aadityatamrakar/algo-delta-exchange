/**
 * No Mongo: the source of apps/traders is read, never run.
 *
 * TradersDb's runtime guard (ALLOWED_WRITE / ALLOWED_READ, ForbiddenCollection)
 * is the real enforcement of the single writer. The source scans below are a
 * backstop that catches a bypass at review time; they match text, so they are
 * deliberately strict about anything they cannot read.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESK_READ_COLLECTIONS, TRADERS_COLLECTIONS } from '../src/db.ts'
import { BANNED_FOR_TRADERS, listSources, walkRuntimeImports } from './import-walk.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../..')
const read = (f: string): string => readFileSync(resolve(ROOT, f), 'utf8')

test('only db.ts, main.ts and user-cli.ts reach the Mongo adapter', () => {
  const touching = listSources('apps/traders/src').filter((f) => /api\/src\/(mongo|store)\.ts['"]/.test(read(f)))
  assert.deepEqual(touching.sort(), ['apps/traders/src/db.ts', 'apps/traders/src/main.ts', 'apps/traders/src/user-cli.ts'])
})

test('no file but db.ts names the driver; every collection literal is an allowed one', () => {
  const sources = listSources('apps/traders/src').filter((f) => f !== 'apps/traders/src/db.ts')
  assert.deepEqual(sources.filter((f) => /require\(\s*['"]mongodb['"]|from\s+['"]mongodb['"]/.test(read(f))), [])
  // writes go through TradersDb.collection(): only traders-* names; the desk is read through .desk(): instrument, desk-marks
  const bad: string[] = []
  for (const f of sources) {
    for (const m of read(f).matchAll(/\.collection(?:<[^>(]*>)?\(\s*['"`]([^'"`]+)['"`]/g)) {
      if (!/^traders-[a-z-]+$/.test(m[1] as string) || !(TRADERS_COLLECTIONS as readonly string[]).includes(m[1] as string)) bad.push(`${f}: ${m[1]}`)
    }
    for (const m of read(f).matchAll(/\.desk(?:<[^>(]*>)?\(\s*['"`]([^'"`]+)['"`]/g)) {
      if (!(DESK_READ_COLLECTIONS as readonly string[]).includes(m[1] as string)) bad.push(`${f}: desk ${m[1]}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('no .collection( or .desk( call takes anything but a quoted literal, outside db.ts', () => {
  // Allowances: none. db.ts forwards a typed name its own guard has already checked; every
  // other file (main.ts and user-cli.ts included) was read by hand and uses literals only.
  const dynamic: string[] = []
  for (const f of listSources('apps/traders/src').filter((x) => x !== 'apps/traders/src/db.ts')) {
    const src = read(f)
    for (const m of src.matchAll(/\.(?:collection|desk)\s*(?:<[^>(]*>)?\s*\(\s*([^'"`\s][^)\n]*)/g)) dynamic.push(`${f}: ${m[0]}`)
    for (const m of src.matchAll(/\[\s*['"`](?:collection|desk)['"`]\s*\]/g)) dynamic.push(`${f}: ${m[0]}`)
  }
  assert.deepEqual(dynamic, [])
})

test('main.ts, the production entry, reaches no order code', () => {
  const { files } = walkRuntimeImports(['apps/traders/src/main.ts'])
  assert.ok(files.has('apps/traders/src/db.ts'), 'the walk from main.ts reached db.ts')
  assert.ok(files.size > 20, `the walk from main.ts saw only ${files.size} files`)
  assert.deepEqual([...files].filter((f) => BANNED_FOR_TRADERS.some((re) => re.test(f))), [])
})

test('TradersDb is closed over its collections: sixteen traders-* writes, one subscription document', () => {
  assert.equal(TRADERS_COLLECTIONS.length, 16)
  assert.ok((TRADERS_COLLECTIONS as readonly string[]).includes('traders-assistant'), 'the assistant\'s conversations (spec §6.5)')
  for (const c of ['traders-alerts', 'traders-push']) assert.ok((TRADERS_COLLECTIONS as readonly string[]).includes(c), `${c}: the phone alerts (gaps G7)`)
  const src = read('apps/traders/src/db.ts')
  assert.match(src, /const ALLOWED_WRITE[^\n]*new Set\(TRADERS_COLLECTIONS\)/)
  assert.match(src, /const ALLOWED_READ[^\n]*new Set\(DESK_READ_COLLECTIONS\)/)
  assert.match(src, /SUBSCRIPTION_SOURCE = 'traders'/)
})

test('TradersDb refuses a desk collection for writing and a traders collection for the read-only door', async () => {
  const { ForbiddenCollection, TradersDb } = await import('../src/db.ts')
  const db = new TradersDb({ collection: () => ({}) } as never)
  for (const name of ['desk-marks', 'desk-books-registry', 'desk-subscriptions', 'instrument', 'users']) {
    assert.throws(() => db.collection(name as never), ForbiddenCollection, name)
  }
  assert.throws(() => db.desk('traders-users' as never), ForbiddenCollection)
  assert.throws(() => db.desk('desk-books-registry' as never), ForbiddenCollection)
  assert.throws(() => db.desk('desk-subscriptions' as never), ForbiddenCollection)
})
