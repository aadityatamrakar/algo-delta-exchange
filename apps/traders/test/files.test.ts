import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { FILE_VERSION_MS, FileStore, OffsetMismatch, validRelPath } from '../src/ingest/files.ts'
import type { Upload } from '../src/ingest/pipeline.ts'
import { sha256hex } from '../src/hash.ts'
import { BadRequest } from '../src/routes/kit.ts'
import { connectSuite, wipe } from './mongo.ts'

const s = await connectSuite('files')
after(async () => { await s?.handle.close() })
let clock = 1_000_000
const store = s === null ? null : new FileStore(s.db, () => clock)
beforeEach(async () => { if (s !== null) { await wipe(s.handle); clock = 1_000_000 } })

const up = (path: string, text: string): Upload => ({ path, mtime: 5, sha256: sha256hex(text), body: Buffer.from(text), offset: null })
const TRD = 'Nse Derivatives/Trades/1019TRD.TXT'

test('validRelPath', () => {
  for (const ok of ['orders.csv', 'Nse Derivatives/Trades/1019TRD.TXT', 'BSE Derivatives/Orders/DOR011026-01.0000 .TXT']) assert.equal(validRelPath(ok), ok)
  for (const bad of ['', '../x.csv', 'a/../x', '/etc/passwd', 'C:/x.csv', 'a//b', 'a/./b', 'a\\b', 'x'.repeat(261), 'a\u0000b', 42]) assert.throws(() => validRelPath(bad), BadRequest)
})

test('put stores latest + a version; same bytes store nothing new', async (t) => {
  if (s === null || store === null) return skipUnlessMongo(t)
  const a = await store.put('ravi', up('a.csv', 'abc'))
  assert.equal(a.changed, true); assert.equal(a.text, 'abc'); assert.equal(a.file.size, 3)
  clock += 1000
  const b = await store.put('ravi', up('a.csv', 'abc'))
  assert.equal(b.changed, false); assert.equal(b.file.receivedAt, 1_000_000)
  assert.equal(await s.db.collection('traders-file-versions').countDocuments({}), 1)
  assert.equal(await s.db.collection('traders-files').countDocuments({}), 1)
})

test('offset appends; the hash is of the whole file', async (t) => {
  if (s === null || store === null) return skipUnlessMongo(t)
  await store.put('ravi', up(TRD, 'a\r\n'))
  const r = await store.put('ravi', { ...up(TRD, 'b\r\n'), sha256: sha256hex('a\r\nb\r\n'), offset: 3 })
  assert.equal(r.text, 'a\r\nb\r\n'); assert.equal(r.file.size, 6)
  await assert.rejects(store.put('ravi', { ...up(TRD, 'c'), sha256: sha256hex('x'), offset: 99 }), OffsetMismatch)
  await assert.rejects(store.put('ravi', { ...up(TRD, 'c\r\n'), sha256: sha256hex('zzz'), offset: 6 }), OffsetMismatch)
  await assert.rejects(store.put('ravi', { ...up('whole.csv', 'q'), sha256: sha256hex('zzz') }), BadRequest)
  assert.equal((await store.list('ravi'))[0]!.size, 6)
})

test('versions older than 7 days are pruned on the next put', async (t) => {
  if (s === null || store === null) return skipUnlessMongo(t)
  const day = FILE_VERSION_MS / 7
  await store.put('ravi', up('a.csv', 'one'))
  clock += day; await store.put('ravi', up('a.csv', 'two'))
  clock += 7 * day; await store.put('ravi', up('a.csv', 'three'))
  const rows = await s.db.collection('traders-file-versions').find({}).sort({ receivedAt: 1 }).toArray()
  assert.deepEqual(rows.map((r) => r['sha256']), [sha256hex('two'), sha256hex('three')])
})

test('list never carries content; setParse records the skips', async (t) => {
  if (s === null || store === null) return skipUnlessMongo(t)
  await store.put('ravi', up('a.csv', 'one'))
  clock += 5; await store.put('ravi', up('b.csv', 'two'))
  await store.setParse('ravi', 'a.csv', 'p', null, [{ lineNo: 2, reason: 'odd' }])
  const l = await store.list('ravi')
  assert.deepEqual(l.map((f) => f.path), ['b.csv', 'a.csv'])
  assert.equal('content' in l[0]!, false); assert.equal('_id' in l[0]!, false)
  assert.deepEqual(l[1]!.skipped, [{ lineNo: 2, reason: 'odd' }])
  assert.equal(l[1]!.parser, 'p')
})
