import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RepairPlan } from '@algomaker/payoff'
import { runRepairJob, type RepairJob } from '../src/analytics/repair.ts'
import {
  REPAIR_CACHE_MS, REPAIR_MAX_RUNNING, REPAIR_RUN_TIMEOUT_MS, REPAIR_WAIT_MS, RepairPool, workerRunner, type PoolAnswer,
} from '../src/analytics/repair-pool.ts'
import { tcsJob } from './fixtures/repair-book.ts'

interface Call { readonly job: RepairJob; resolve(plans: readonly RepairPlan[]): void; reject(err: Error): void }

/** A runner resolved by hand: each call waits until the test answers it. */
function handRun(): { run: (job: RepairJob) => Promise<readonly RepairPlan[]>; calls: Call[] } {
  const calls: Call[] = []
  return { calls, run: (job) => new Promise((resolve, reject) => { calls.push({ job, resolve, reject }) }) }
}

const job = (n: number): RepairJob => ({ n } as unknown as RepairJob)   // the pool never reads a job, it hands it on
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
const BUSY = { busy: true, retryAfterMs: 2000 }

function plans(a: PoolAnswer): readonly RepairPlan[] {
  if ('busy' in a) throw new Error('busy')
  return a.plans
}

test('the caps are two searches, a minute, twenty seconds to wait, thirty to run', () => {
  assert.deepEqual([REPAIR_MAX_RUNNING, REPAIR_CACHE_MS, REPAIR_WAIT_MS, REPAIR_RUN_TIMEOUT_MS], [2, 60_000, 20_000, 30_000])
})

test('two run at once, a third waits', async () => {
  const h = handRun()
  const pool = new RepairPool({ run: h.run, now: () => 0 })
  const a = pool.request('ravi|TCS', 'ravi|TCS|0|', job(1))
  const b = pool.request('ravi|NIFTY', 'ravi|NIFTY|0|', job(2))
  const c = pool.request('sita|TCS', 'sita|TCS|0|', job(3))
  await flush()
  assert.equal(pool.running(), 2)
  assert.deepEqual(h.calls.map((x) => x.job), [job(1), job(2)])
  h.calls[0]?.resolve([])
  assert.deepEqual(plans(await a), [])
  await flush()
  assert.equal(pool.running(), 2)
  assert.deepEqual(h.calls.map((x) => x.job), [job(1), job(2), job(3)])
  h.calls[1]?.resolve([]); h.calls[2]?.resolve([])
  await Promise.all([b, c])
  assert.equal(pool.running(), 0)
})

test('one search per book: the same request shares the run', async () => {
  const h = handRun()
  const pool = new RepairPool({ run: h.run, now: () => 0 })
  const first = pool.request('ravi|TCS', 'ravi|TCS|3|', job(1))
  const second = pool.request('ravi|TCS', 'ravi|TCS|3|', job(2))
  await flush()
  assert.equal(h.calls.length, 1)
  h.calls[0]?.resolve([])
  const [x, y] = await Promise.all([first, second])
  assert.deepEqual(x, y)
  assert.deepEqual(x, { plans: [], computedAt: 0, cached: false, job: job(1) })
  assert.equal(h.calls.length, 1)
})

test('the same book with a different key is busy', async () => {
  const h = handRun()
  const pool = new RepairPool({ run: h.run, now: () => 0 })
  const first = pool.request('ravi|TCS', 'ravi|TCS|3|', job(1))
  assert.deepEqual(await pool.request('ravi|TCS', 'ravi|TCS|4|', job(2)), BUSY)
  assert.deepEqual(await pool.request('ravi|TCS', 'ravi|TCS|3|50000', job(3)), BUSY)
  await flush()
  h.calls[0]?.resolve([])
  await first
  // once it is done the book is free again
  const next = pool.request('ravi|TCS', 'ravi|TCS|4|', job(2))
  await flush()
  h.calls[1]?.resolve([])
  assert.equal('busy' in await next, false)
})

test('a result is kept 60 s', async () => {
  const h = handRun()
  const clock = { now: 1_000_000 }
  const pool = new RepairPool({ run: h.run, now: () => clock.now })
  const p = pool.request('ravi|TCS', 'k', job(1))
  await flush()
  h.calls[0]?.resolve([])
  await p
  clock.now += 59_999
  assert.deepEqual(await pool.request('ravi|TCS', 'k', job(2)), { plans: [], computedAt: 1_000_000, cached: true, job: job(1) })
  assert.equal(h.calls.length, 1)
  clock.now += 1
  const again = pool.request('ravi|TCS', 'k', job(3))
  await flush()
  assert.equal(h.calls.length, 2)
  h.calls[1]?.resolve([])
  assert.deepEqual(await again, { plans: [], computedAt: 1_060_000, cached: false, job: job(3) })
})

test('waiting past 20 s answers busy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = handRun()
  const pool = new RepairPool({ run: h.run, now: () => 0, maxRunning: 1 })
  const running = pool.request('ravi|TCS', 'a', job(1))
  let answer: PoolAnswer | null = null
  const waiting = pool.request('sita|TCS', 'b', job(2)).then((a) => { answer = a })
  t.mock.timers.tick(19_999)
  await flush()
  assert.equal(answer, null)
  t.mock.timers.tick(1)
  await waiting
  assert.deepEqual(answer, BUSY)
  assert.equal(h.calls.length, 1, 'the refused search never ran')
  // its book is free to ask again; the slot is still the first search's
  assert.equal(pool.running(), 1)
  h.calls[0]?.resolve([])
  await running
  assert.equal(pool.running(), 0)
})

test('a waiting search that gets a slot in time runs', async () => {
  const h = handRun()
  const pool = new RepairPool({ run: h.run, now: () => 0, maxRunning: 1, waitMs: 60_000 })
  const a = pool.request('ravi|TCS', 'a', job(1))
  const b = pool.request('sita|TCS', 'b', job(2))
  await flush()
  h.calls[0]?.resolve([])
  await a
  await flush()
  h.calls[1]?.resolve([])
  assert.equal('busy' in await b, false)
})

test('a run that throws is not cached and frees its slot', async () => {
  const h = handRun()
  const pool = new RepairPool({ run: h.run, now: () => 0, maxRunning: 1 })
  const p = pool.request('ravi|TCS', 'k', job(1))
  await flush()
  h.calls[0]?.reject(new Error('worker died'))
  await assert.rejects(p, /worker died/)
  assert.equal(pool.running(), 0)
  const again = pool.request('ravi|TCS', 'k', job(1))
  await flush()
  assert.equal(h.calls.length, 2, 'not cached: it ran again')
  h.calls[1]?.resolve([])
  assert.equal('busy' in await again, false)
})

test('a runner that throws before it starts frees the book too', async () => {
  const pool = new RepairPool({ run: () => { throw new Error('no runner') }, now: () => 0 })
  await assert.rejects(pool.request('ravi|TCS', 'k', job(1)), /no runner/)
  await assert.rejects(pool.request('ravi|TCS', 'other', job(1)), /no runner/)   // not busy: the first left no flight behind
  assert.equal(pool.running(), 0)
})

test('close answers every waiting search busy at once, and every later one', async () => {
  const h = handRun()
  const pool = new RepairPool({ run: h.run, now: () => 0, maxRunning: 1 })
  const running = pool.request('ravi|TCS', 'a', job(1))
  const waiting = pool.request('sita|TCS', 'b', job(2))
  pool.close()
  assert.deepEqual(await waiting, BUSY)   // at once: not after the 20 s wait
  assert.deepEqual(await pool.request('sita|NIFTY', 'c', job(3)), BUSY)
  await flush()
  h.calls[0]?.resolve([])   // a running search ends with its runner (app.stop() closes the workers next)
  assert.equal('busy' in await running, false)
  assert.equal(h.calls.length, 1)
  assert.equal(pool.running(), 0)
})

test('a search past its deadline is stopped, its worker replaced, and the job fails', async () => {
  const w = workerRunner(1, { timeoutMs: 1000, entry: new URL('./fixtures/hang-worker.ts', import.meta.url) })
  try {
    const t0 = Date.now()
    await assert.rejects(w.run({ hang: true } as unknown as RepairJob), /^Error: the repair search took longer than 1 s and was stopped$/)
    assert.ok(Date.now() - t0 >= 990, 'not before its deadline')
    assert.deepEqual(await w.run(job(1)), [], 'a new worker answers the next job')
  } finally {
    await w.close()
  }
})

test('the pool frees the slot of a search stopped at its deadline', async () => {
  const w = workerRunner(1, { timeoutMs: 200, entry: new URL('./fixtures/hang-worker.ts', import.meta.url) })
  const pool = new RepairPool({ run: w.run, now: () => 0, maxRunning: 1 })
  try {
    await assert.rejects(pool.request('ravi|TCS', 'a', { hang: true } as unknown as RepairJob), /took longer than 0.2 s/)
    assert.equal(pool.running(), 0)
  } finally {
    pool.close()
    await w.close()
  }
})

test('workerRunner really runs in a worker', async () => {
  const w = workerRunner(1)
  try {
    const small = tcsJob()
    const [a, b] = await Promise.all([w.run(small), w.run(small)])   // one worker: the second waits its turn
    assert.deepEqual(a, runRepairJob(small))
    assert.deepEqual(b, a)
  } finally {
    await w.close()
  }
  await assert.rejects(w.run(tcsJob()), /the repair workers are closed/)
})

test('a job that cannot be sent to a worker is refused, and the worker serves the next', async () => {
  const w = workerRunner(1)
  try {
    await assert.rejects(w.run({ ...tcsJob(), dials: (() => 0) as never }), /could not be cloned/)
    assert.equal((await w.run(tcsJob())).length > 0, true, 'the worker still serves the next job')
  } finally {
    await w.close()
  }
})
