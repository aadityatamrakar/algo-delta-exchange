import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BANNED_FOR_TRADERS, listSources, walkRuntimeImports } from './import-walk.ts'

test('apps/traders reaches no order code at runtime', () => {
  const { files } = walkRuntimeImports(listSources('apps/traders/src'))
  assert.deepEqual([...files].filter((f) => BANNED_FOR_TRADERS.some((re) => re.test(f))), [])
})
test('the walker would see it: desk-api main reaches submit and order-bus', () => {
  const { files } = walkRuntimeImports(['apps/api/src/main.ts'])
  assert.ok([...files].some((f) => f.startsWith('apps/api/src/submit')))
  assert.ok([...files].some((f) => f.startsWith('packages/order-bus/')))
})
test('a type-only import is not followed', () => {
  const { files } = walkRuntimeImports(['packages/instruments/src/master.ts'])
  assert.equal([...files].some((f) => f.startsWith('packages/order-bus/')), false)
})
test('the repair worker, loaded by URL and imported by nothing, is walked too: no order code, nothing of apps/api', () => {
  const worker = 'apps/traders/src/analytics/repair-worker.ts'
  assert.ok(listSources('apps/traders/src').includes(worker), 'the walk above starts from it')
  const { files } = walkRuntimeImports([worker])
  assert.ok(files.has('apps/traders/src/analytics/repair.ts'))
  assert.deepEqual([...files].filter((f) => f.startsWith('apps/api/') || BANNED_FOR_TRADERS.some((re) => re.test(f))), [])
})
