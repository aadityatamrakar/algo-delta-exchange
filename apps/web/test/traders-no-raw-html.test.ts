/** The traders page prints what the server and ODIN files say as text, never as HTML. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../src/traders', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [])
}

test('nothing under apps/web/src/traders uses dangerouslySetInnerHTML', () => {
  const files = sources(DIR)
  assert.ok(files.length > 5, 'the traders sources were found')
  assert.deepEqual(files.filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML')), [])
})
