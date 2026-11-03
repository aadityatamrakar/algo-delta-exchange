/** The traders page reaches only its own code and the shared chart — never the desk's client. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSources, walkRuntimeImports } from '../../traders/test/import-walk.ts'

test('the traders page reaches only its own code and the shared chart', () => {
  const { files, externals } = walkRuntimeImports(['apps/web/src/traders/main.tsx'])
  const allowedFile = (f: string): boolean =>
    f.startsWith('apps/web/src/traders/') ||
    ['apps/web/src/payoff-curves.tsx', 'apps/web/src/format.ts', 'apps/web/src/venue.ts', 'apps/web/src/theme-mode.ts', 'apps/web/src/boundary.tsx', 'apps/traders/src/types.ts',
      // format.ts -> venue.ts -> the pure venue spec and the NSE calendar leaf it reads.
      'packages/venue/src/index.ts', 'packages/desk-engine/src/session.ts'].includes(f) ||
    /^apps\/web\/src\/[^/]+\.css$/.test(f)
  assert.deepEqual([...files].filter((f) => !allowedFile(f)), [])
  assert.deepEqual([...externals].filter((e) => !/^(react|react-dom|recharts|@astryxdesign\/)/.test(e)), [])
})

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
/** The server modules the page may name: types only, each naming only the others and @algomaker/payoff. */
const SERVER_WIRE = [
  'apps/traders/src/agent/wire.ts', 'apps/traders/src/analytics/booked-wire.ts', 'apps/traders/src/analytics/context-wire.ts',
  'apps/traders/src/analytics/daily-wire.ts',
  'apps/traders/src/analytics/r3-wire.ts', 'apps/traders/src/analytics/risk-wire.ts', 'apps/traders/src/analytics/wire.ts', 'apps/traders/src/types.ts',
]

/**
 * Every module a file names, `import type` and `export … from` included — the
 * runtime walk above skips type imports, which is how a server module could
 * slip into the page's type program unseen. Multi-line import lists match too.
 */
function namedModules(file: string): string[] {
  const src = readFileSync(resolve(ROOT, file), 'utf8')
  const re = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
  const out: string[] = []
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const spec = (m[1] ?? m[2]) as string
    out.push(spec.startsWith('.') ? relative(ROOT, resolve(ROOT, dirname(file), spec)).split('\\').join('/') : spec)
  }
  return out
}

test('the web names exactly the server\'s wire files, and they name only each other and @algomaker/payoff (R3-9)', () => {
  const named = new Set<string>()
  for (const f of listSources('apps/web/src')) for (const m of namedModules(f)) if (m.startsWith('apps/traders/')) named.add(m)
  assert.deepEqual([...named].sort(), SERVER_WIRE)
  for (const f of SERVER_WIRE) {
    assert.deepEqual(namedModules(f).filter((m) => !SERVER_WIRE.includes(m) && m !== '@algomaker/payoff'), [], f)
  }
})
