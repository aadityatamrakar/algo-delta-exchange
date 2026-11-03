import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLUMNS_KEY, DEFAULT_COLUMNS, loadColumns, saveColumns } from '../../src/traders/market-columns.ts'

const store = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: (k) => (k === COLUMNS_KEY ? value : null) })

test('loadColumns: defaults with no storage, nothing saved, or junk', () => {
  assert.deepEqual(loadColumns(null), [...DEFAULT_COLUMNS])
  assert.deepEqual(loadColumns(store(null)), [...DEFAULT_COLUMNS])
  assert.deepEqual(loadColumns(store('not json')), [...DEFAULT_COLUMNS])
  assert.deepEqual(loadColumns(store('{"a":1}')), [...DEFAULT_COLUMNS])
  assert.deepEqual(loadColumns(store('["nope"]')), [...DEFAULT_COLUMNS])
})

test('saveColumns then loadColumns round-trips a choice and its order', () => {
  let saved = ''
  saveColumns({ setItem: (_k, v) => { saved = v } }, ['ltp', 'iv'])
  assert.deepEqual(loadColumns(store(saved)), ['ltp', 'iv'])
})

test('loadColumns drops unknown names and repeats', () => {
  assert.deepEqual(loadColumns(store('["ltp","bogus","iv","ltp"]')), ['ltp', 'iv'])
})

test('a throwing storage gives the defaults and a failed save does not throw', () => {
  assert.deepEqual(loadColumns({ getItem: () => { throw new Error('blocked') } }), [...DEFAULT_COLUMNS])
  assert.doesNotThrow(() => saveColumns({ setItem: () => { throw new Error('quota') } }, ['ltp']))
})
