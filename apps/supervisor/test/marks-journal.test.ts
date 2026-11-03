/**
 * THE MARK JOURNAL — one row per book per mark, and the two ways that goes wrong.
 *
 *   1. **A duplicate is not an error.** Two evaluations inside one mark, or a
 *      restart at 10:16, must not produce two rows for 10:15 — and must not
 *      produce a log line every five minutes either. The uniqueness lives in the
 *      INDEX, so it holds across processes rather than across one process's
 *      memory.
 *   2. **A failure must not reach the caller.** This is called from inside the
 *      evaluation path. A Mongo blip costs a history row; it may never cost a
 *      mark's decision.
 *
 * No Mongo: the collection is a fake that records what it was asked to do, which
 * is exactly the surface under test (the index spec and the swallow).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MarksJournal, type BookMark, type MarksCollection } from '../src/marks-journal.ts'
import type { HostLog } from '../src/engine-host.ts'

function logOf(): HostLog & { lines: string[] } {
  const lines: string[] = []
  const push =
    (level: string) =>
    (msg: string): void => {
      lines.push(`${level}: ${msg}`)
    }
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

const ROW: BookMark = {
  tag: 'TCS-2026-09-25-recenter-r',
  mode: 'paper',
  mark: 12,
  dateIst: '2026-08-21',
  ts: 1_755_000_000_000,
  spot: 3100.5,
  netDelta: 483,
  netGamma: -12.5,
  band: 620,
  totalPnl: 41_250,
  marginSource: 'broker',
  reason: 'inside the band',
}

class FakeMarks implements MarksCollection {
  readonly inserted: Record<string, unknown>[] = []
  readonly indexes: { spec: Record<string, 1 | -1>; options?: { unique?: boolean } }[] = []
  /** Set to throw from the next `insertOne`. */
  fail: unknown = null

  async insertOne(doc: Record<string, unknown>): Promise<unknown> {
    if (this.fail !== null) throw this.fail
    const key = `${String(doc['tag'])}|${String(doc['mode'])}|${String(doc['dateIst'])}|${String(doc['mark'])}`
    if (this.inserted.some((d) => `${String(d['tag'])}|${String(d['mode'])}|${String(d['dateIst'])}|${String(d['mark'])}` === key)) {
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
    }
    this.inserted.push(doc)
    return {}
  }

  async createIndex(
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean },
  ): Promise<unknown> {
    this.indexes.push(options === undefined ? { spec } : { spec, options })
    return {}
  }
}

test('a mark is journalled whole, with the engine’s own numbers', async () => {
  const col = new FakeMarks()
  await new MarksJournal(col, logOf()).record(ROW)
  assert.equal(col.inserted.length, 1)
  assert.deepEqual(col.inserted[0], { ...ROW })
})

test('the forward`s source rides beside the spot (six-playbooks spec F1)', async () => {
  // Which of the four sources priced `spot` — the weekly's parity forward, the
  // index carried, the future's mid or the proxy — is what makes a row's spot
  // readable at all once books on one chain are priced differently.
  const col = new FakeMarks()
  await new MarksJournal(col, logOf()).record({ ...ROW, forwardSource: 'parity' })
  assert.equal(col.inserted[0]?.['forwardSource'], 'parity')
  assert.equal(col.inserted[0]?.['spot'], ROW.spot)
})

test('THE UNIQUENESS IS THE INDEX: one row per book per mark, per day', async () => {
  // `markIndexToday` repeats daily, so tag+mode+mark alone would refuse
  // tomorrow's 10:15 row. The date is in the key for exactly that reason.
  const col = new FakeMarks()
  const journal = new MarksJournal(col, logOf())
  await journal.record(ROW)

  const unique = col.indexes.find((i) => i.options?.unique === true)
  assert.ok(unique !== undefined)
  assert.deepEqual(unique.spec, { tag: 1, mode: 1, dateIst: 1, mark: 1 })
  // And a read index, so a per-book history is not a collection scan.
  assert.ok(col.indexes.some((i) => i.options === undefined && i.spec['ts'] === -1))
})

test('a second pass inside one mark writes nothing and says nothing', async () => {
  const col = new FakeMarks()
  const log = logOf()
  const journal = new MarksJournal(col, log)
  await journal.record(ROW)
  await journal.record({ ...ROW, ts: ROW.ts + 90_000, spot: 3101 })

  assert.equal(col.inserted.length, 1)
  // Silent: a warning every five minutes is a warning nobody reads.
  assert.deepEqual(log.lines, [])
  // The NEXT mark is a different row.
  await journal.record({ ...ROW, mark: 13 })
  assert.equal(col.inserted.length, 2)
})

test('a Mongo failure is swallowed and named — the decision is unaffected', async () => {
  const col = new FakeMarks()
  const log = logOf()
  col.fail = new Error('connection reset')

  // Resolves. A throw here would take the evaluation down with it.
  await new MarksJournal(col, log).record(ROW)
  assert.equal(col.inserted.length, 0)
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0] ?? '', /^warn: .*decision is unaffected/)
})

test('an index build that fails is retried, not inherited', async () => {
  // A rejected cached promise would leave the journal permanently unable to
  // write — the same trap `Lease.#indexed` clears for the claim path.
  const col = new FakeMarks()
  let first = true
  col.createIndex = async (spec, options): Promise<unknown> => {
    if (first) {
      first = false
      throw new Error('not primary')
    }
    col.indexes.push(options === undefined ? { spec } : { spec, options })
    return {}
  }
  const journal = new MarksJournal(col, logOf())
  await journal.record(ROW)
  assert.equal(col.inserted.length, 0)
  await journal.record(ROW)
  assert.equal(col.inserted.length, 1)
})
