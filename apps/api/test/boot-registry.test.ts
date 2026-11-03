/**
 * A RESTART MUST NOT BRING BACK A STRATEGY ROW THAT WAS REMOVED ON PURPOSE.
 *
 * Until 2026-10-30 the bridge's boot registered — external, SWITCHED ON —
 * every tag in the last 50 decisions of each symbol's books that had no
 * `desk-strategies` row. By then the only tags it ever found were rows
 * removed deliberately, and each restart put them back on with no book
 * behind them.
 *
 * THE SOURCE SCAN is the regression guard. `main.ts` itself writes no
 * strategy row, so the boot's one writer is `seedHostedStrategies`, whose
 * table names hosted tags only. Put a journal seed back in `main()` and this
 * fails; nothing else could, because `main()` cannot be booted in a test (bus,
 * ports, broker keys).
 *
 * (The Mongo half drove the NSE roll script's orphan prune and went with that
 * script, 3 Nov 2026.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOSTED_STRATEGIES } from '../src/registry-seed.ts'

// ------------------------------------------------------------ the source

const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

test('main.ts writes no strategy row of its own: the hosted seed is the boot\'s one writer', () => {
  // Every store method that creates or rewrites a `desk-strategies` row. A
  // read (`loadStrategy`, `listStrategies`) is not a re-creation and is not
  // listed.
  const writes = [...MAIN.matchAll(/\.(registerStrategy|addStrategyMode|patchStrategy|removeStrategyMode)\s*\(/g)]
  assert.deepEqual(
    writes.map((m) => m[1]),
    [],
    'the bridge boot makes strategy rows only through seedHostedStrategies',
  )
  assert.doesNotMatch(MAIN, /kind:\s*['"]external['"]/, 'an external row is a registration\'s, never the boot\'s')
  assert.equal([...MAIN.matchAll(/\bseedHostedStrategies\(/g)].length, 1, 'the hosted seed still runs, once')
})

test('the hosted seed\'s table names hosted tags only, never a dated book', () => {
  // The other half of "the boot's one writer": whatever it writes is hosted,
  // which no erase and no prune ever removes.
  for (const s of HOSTED_STRATEGIES) {
    assert.doesNotMatch(s.tag, /\d{4}-\d{2}-\d{2}/, `${s.tag} reads like a dated book tag`)
  }
})
