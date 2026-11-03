/**
 * Every traders stylesheet closes each block it opens. The bundler joins them into one file, so one lost `}` (a
 * merge resolution dropped one in shell.css, 82ac5837) nests every later rule — the grid, the tables, the strip —
 * inside the unclosed block and the page renders unstyled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../src/traders', import.meta.url))

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? stylesheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [])
}

/** The first place the nesting goes wrong — a `}` with nothing open, or blocks still open at the end — else null. */
function unbalanced(css: string): string | null {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  let depth = 0
  for (const ch of bare) {
    if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return 'a } closes nothing'
  }
  return depth === 0 ? null : `${depth} block(s) never closed`
}

test('every stylesheet under apps/web/src/traders closes each block it opens', () => {
  const files = stylesheets(DIR)
  assert.ok(files.length >= 3, 'the traders stylesheets were found')
  assert.deepEqual(files.map((f) => [f.slice(DIR.length + 1), unbalanced(readFileSync(f, 'utf8'))]).filter(([, e]) => e !== null), [])
})
