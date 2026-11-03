/**
 * `desk-marks` keeps a row per token forever unless something deletes it, and
 * every row was a scan for every snapshot upsert until it had an index. These
 * pin the two halves: the prune deletes ONLY a row that is both missing from the
 * master AND unpriced for the grace, and neither function can throw into the
 * sync or the boot that calls it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureMarksIndex,
  MARKS_ORPHAN_GRACE_MS,
  pruneOrphanMarks,
  type MarksCollection,
} from '../src/marks-store.ts'

const NOW = Date.UTC(2026, 9, 19, 3, 15) // Mon 08:45 IST, the daily sync
const DAY = 24 * 60 * 60_000

interface Row {
  token: number
  price: number
  ts: number
}

/** Evaluates exactly the filter the prune sends: `token $nin` AND `ts $lt`. */
function fakeMarks(rows: Row[]): MarksCollection & { rows: Row[]; indexes: unknown[] } {
  const state = { rows: [...rows], indexes: [] as unknown[] }
  return {
    get rows() {
      return state.rows
    },
    indexes: state.indexes,
    deleteMany: async (filter) => {
      const nin = new Set((filter['token'] as { $nin: number[] }).$nin)
      const lt = (filter['ts'] as { $lt: number }).$lt
      const before = state.rows.length
      state.rows = state.rows.filter((r) => nin.has(r.token) || !(r.ts < lt))
      return { deletedCount: before - state.rows.length }
    },
    createIndex: async (spec, options) => {
      state.indexes.push({ spec, options })
      return 'token_1'
    },
  }
}

test('prunes a row only when its token left the master AND it has not been priced for the grace', async () => {
  const marks = fakeMarks([
    { token: 256265, price: 25000, ts: NOW - 60 * DAY }, // in master, old: an index spot out of a long break — KEEP
    { token: 111, price: 10, ts: NOW - 30 * DAY }, // expired, unpriced for a month — DELETE
    { token: 222, price: 12, ts: NOW - 3 * DAY }, // expired, priced 3 days ago — KEEP until the grace passes
    { token: 333, price: 99, ts: NOW - 60_000 }, // in master, live — KEEP
  ])
  const result = await pruneOrphanMarks({ marks, masterTokens: [256265, 333], nowMs: NOW, log: () => {} })

  assert.equal(result.deleted, 1)
  assert.deepEqual(
    marks.rows.map((r) => r.token),
    [256265, 222, 333],
  )
})

test('a row exactly at the grace boundary is kept — strictly older is the rule', async () => {
  const marks = fakeMarks([{ token: 111, price: 10, ts: NOW - MARKS_ORPHAN_GRACE_MS }])
  const result = await pruneOrphanMarks({ marks, masterTokens: [999], nowMs: NOW, log: () => {} })
  assert.equal(result.deleted, 0)
  assert.equal(marks.rows.length, 1)
})

test('an EMPTY master deletes nothing — `$nin: []` would match every row', async () => {
  const marks = fakeMarks([{ token: 111, price: 10, ts: NOW - 30 * DAY }])
  const lines: string[] = []
  const result = await pruneOrphanMarks({ marks, masterTokens: [], nowMs: NOW, log: (m) => lines.push(m) })

  assert.deepEqual(result, { deleted: 0, skipped: 'empty master' })
  assert.equal(marks.rows.length, 1)
  assert.match(lines.join('\n'), /skipped/)
})

test('a failing delete is logged and returned, never thrown into the sync', async () => {
  const lines: string[] = []
  const marks: MarksCollection = {
    deleteMany: async () => {
      throw new Error('not primary')
    },
    createIndex: async () => 'token_1',
  }
  const result = await pruneOrphanMarks({ marks, masterTokens: [1], nowMs: NOW, log: (m) => lines.push(m) })

  assert.deepEqual(result, { deleted: 0, skipped: 'error' })
  assert.match(lines.join('\n'), /prune FAILED/)
})

test('the index is {token: 1} UNIQUE', async () => {
  const marks = fakeMarks([])
  await ensureMarksIndex(marks, () => {})
  assert.deepEqual(marks.indexes, [{ spec: { token: 1 }, options: { unique: true } }])
})

test('an index that cannot be built (a duplicate token) is logged, and boot carries on', async () => {
  const lines: string[] = []
  const marks: MarksCollection = {
    deleteMany: async () => ({ deletedCount: 0 }),
    createIndex: async () => {
      throw new Error('E11000 duplicate key error collection: algomaker.desk-marks index: token_1')
    },
  }
  await ensureMarksIndex(marks, (m) => lines.push(m))
  assert.match(lines.join('\n'), /index NOT built/)
})
