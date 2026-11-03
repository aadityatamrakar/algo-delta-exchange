/**
 * `readZipEntry` — the dependency-free reader BSE's Abridged_CO.ZIP needs.
 *
 * No zip library is installed and none is being added for one daily 300 KB
 * download; Node's `zlib.inflateRawSync` does the only hard part. The zips
 * here are BUILT LOCALLY by `buildZip` (local headers, central directory,
 * end-of-central-directory), so nothing in this file touches the network and
 * every byte offset the reader depends on is exercised.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readZipEntry } from '../src/zip.ts'
import { buildZip } from './zip-fixture.ts'

const CSV = 'FinInstrmNm,TckrSymb,MinLot,MaxTradQty\nIF,SENSEX,20,500\n'

test('reads a deflated entry by name', () => {
  const zip = buildZip([{ name: 'BSE_EQD_CONTRACT_abr_21092026.csv', data: Buffer.from(CSV), method: 8 }])
  assert.equal(readZipEntry(zip, /^BSE_EQD_CONTRACT_abr_\d{8}\.csv$/i).toString('utf8'), CSV)
})

test('reads a stored (method 0) entry', () => {
  const zip = buildZip([{ name: 'plain.csv', data: Buffer.from(CSV), method: 0 }])
  assert.equal(readZipEntry(zip, /^plain\.csv$/).toString('utf8'), CSV)
})

test('picks the entry matching a RegExp among several', () => {
  // The real archive carries two CSVs and the one we want is not first.
  const zip = buildZip([
    { name: 'EQD_CO_abr_210926.csv', data: Buffer.from('garbage,body\n'), method: 8 },
    { name: 'BSE_EQD_CONTRACT_abr_21092026.csv', data: Buffer.from(CSV), method: 8 },
    { name: 'readme.txt', data: Buffer.from('hello'), method: 0 },
  ])
  assert.equal(readZipEntry(zip, /^BSE_EQD_CONTRACT_abr_/).toString('utf8'), CSV)
  assert.equal(readZipEntry(zip, /readme/).toString('utf8'), 'hello')
})

test('throws on a buffer with no end-of-central-directory', () => {
  // An HTML error page, a truncated download, an empty body: none of these
  // may be mistaken for an archive with no matching entry.
  assert.throws(() => readZipEntry(Buffer.from('<html>blocked</html>'), /csv/), /end-of-central-directory|not a zip/i)
  assert.throws(() => readZipEntry(Buffer.alloc(0), /csv/), /end-of-central-directory|not a zip/i)
})

test('throws when no entry matches', () => {
  const zip = buildZip([{ name: 'other.csv', data: Buffer.from(CSV), method: 8 }])
  assert.throws(() => readZipEntry(zip, /^BSE_EQD_CONTRACT_abr_/), /no entry matching/)
})
