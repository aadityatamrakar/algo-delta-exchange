import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// The span job's own unittest suite (injected fetcher, no network).
test('scripts/test_span_job.py passes', { skip: hasPython() ? false : 'python3 is not available' }, () => {
  execFileSync('python3', ['-I', 'scripts/test_span_job.py'], { cwd: repoRoot, stdio: 'pipe' })
  assert.ok(true)
})
