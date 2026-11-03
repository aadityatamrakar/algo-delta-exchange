import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseExposureFile, parseSpanFile, spanMargin } from '../src/index.ts'
import type { SpanPosition } from '../src/index.ts'

interface GoldenBook { name: string; positions: SpanPosition[]; brokerSpan: number; brokerExposure: number }
interface GoldenCase { taken: string; broker: string; books: GoldenBook[] }

const DIR = fileURLToPath(new URL('./golden/', import.meta.url))
const cases = existsSync(DIR)
  ? readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(d.name)).map((d) => d.name).sort()
  : []

if (cases.length === 0) {
  test('golden SPAN cases', { skip: 'no Phase 0 golden portfolios yet (spec Q6) — see packages/span/test/golden/README.md' }, () => {})
}
for (const folder of cases) {
  const read = (f: string): string => readFileSync(`${DIR}${folder}/${f}`, 'utf8')
  const meta = JSON.parse(read('case.json')) as GoldenCase
  const file = parseSpanFile(read('span.spn'))
  const elm = parseExposureFile(read('ael.csv'))
  for (const book of meta.books) {
    test(`golden ${folder} ${meta.broker} ${book.name}`, () => {
      const ours = spanMargin(book.positions, file, elm)
      const theirs = book.brokerSpan + book.brokerExposure
      assert.ok(Math.abs(ours.total - theirs) <= 0.01 * theirs,
        `missing [${ours.missing.join(", ")}]; span ours ${ours.initial} vs broker ${book.brokerSpan}; exposure ours ${ours.exposure} vs broker ${book.brokerExposure}; total ours ${ours.total} vs broker ${theirs}`)
    })
  }
}
