/**
 * Where and when repair searches run (P13). A search is a beam over hundreds
 * of candidate books, seconds of CPU on an index chain, so it runs off the
 * request path: at most two at once across every trader, one per book, each
 * result kept a minute and shared by every viewer of that book. A request that
 * waits 20 s for a slot is refused, and the page offers a retry (Decision 10).
 *
 * `RepairPool` decides when a search runs; `workerRunner` runs it in a
 * node:worker_threads worker, so the server keeps answering meanwhile.
 *
 * Two kinds of job share the two slots: a repair (`request`, a `RepairJob`)
 * and the assistant's objective search (`search`, a `PlanSearchJob`, spec §4
 * and R10). Each kind keeps its own one-minute results and its own search in
 * flight per book; a slot is a slot, whichever kind holds it.
 */

import { Worker } from 'node:worker_threads'
import type { PlanSearchResult, RepairPlan } from '@algomaker/payoff'
import type { PlanSearchJob } from './plan-search-job.ts'
import type { RepairJob } from './repair.ts'

export const REPAIR_MAX_RUNNING = 2
export const REPAIR_CACHE_MS = 60_000
export const REPAIR_WAIT_MS = 20_000
/** What a refused request is told to wait before it asks again. */
export const REPAIR_RETRY_MS = 2_000
/** A search still running after this is stopped and its worker replaced: one that never answers must not hold a slot for ever. */
export const REPAIR_RUN_TIMEOUT_MS = 30_000

export type RepairRunner = (job: RepairJob) => Promise<readonly RepairPlan[]>
export type PlanSearchRunner = (job: PlanSearchJob) => Promise<PlanSearchResult>

type Busy = { busy: true; retryAfterMs: number }

/** `job` is the one the plans were searched on: a cached or shared answer's is the first request's. */
export type PoolAnswer =
  | { plans: readonly RepairPlan[]; computedAt: number; cached: boolean; job: RepairJob }
  | Busy

/** A plan search's answer, kept and shared like a repair's. */
export type SearchAnswer =
  | { result: PlanSearchResult; computedAt: number; cached: boolean; job: PlanSearchJob }
  | Busy

interface Done<J, R> { readonly job: J; readonly out: R; readonly computedAt: number }
interface Flight<A> { readonly key: string; promise: Promise<A> }

/** One kind of job: how it runs, how its answer reads, and its own results and flights. */
interface Kind<J, R, A> {
  readonly run: (job: J) => Promise<R>
  readonly answer: (out: R, computedAt: number, cached: boolean, job: J) => A
  /** Finished searches by cache key, pruned as they age past `cacheMs`. */
  readonly done: Map<string, Done<J, R>>
  /** The search each book has in flight (waiting for a slot or running), by book id. */
  readonly flights: Map<string, Flight<A | Busy>>
}

const busy = (): Busy => ({ busy: true, retryAfterMs: REPAIR_RETRY_MS })
const NO_SEARCH = 'this pool runs no plan search'

export class RepairPool {
  readonly #now: () => number
  readonly #maxRunning: number
  readonly #cacheMs: number
  readonly #waitMs: number
  readonly #repairs: Kind<RepairJob, readonly RepairPlan[], PoolAnswer>
  readonly #searches: Kind<PlanSearchJob, PlanSearchResult, SearchAnswer>
  /** Searches waiting for a slot, first come first served: each is answered once, true = the slot is its. */
  readonly #waiting: ((granted: boolean) => void)[] = []
  #running = 0
  #closed = false

  constructor(opts: { run: RepairRunner; runSearch?: PlanSearchRunner; now?: () => number; maxRunning?: number; cacheMs?: number; waitMs?: number }) {
    this.#now = opts.now ?? Date.now
    this.#maxRunning = opts.maxRunning ?? REPAIR_MAX_RUNNING
    this.#cacheMs = opts.cacheMs ?? REPAIR_CACHE_MS
    this.#waitMs = opts.waitMs ?? REPAIR_WAIT_MS
    this.#repairs = {
      run: opts.run, answer: (plans, computedAt, cached, job) => ({ plans, computedAt, cached, job }), done: new Map(), flights: new Map(),
    }
    const runSearch = opts.runSearch ?? ((): Promise<PlanSearchResult> => Promise.reject(new Error(NO_SEARCH)))
    this.#searches = {
      run: runSearch, answer: (result, computedAt, cached, job) => ({ result, computedAt, cached, job }), done: new Map(), flights: new Map(),
    }
  }

  /**
   * A result for `cacheKey` from the last `cacheMs` is answered as it is. A
   * book with a search in flight under the same key shares it; under another
   * key (its legs or tail cap changed) it is busy. A run that throws rejects
   * every caller sharing it and is not kept.
   */
  request(bookId: string, cacheKey: string, job: RepairJob): Promise<PoolAnswer> {
    return this.#ask(this.#repairs, bookId, cacheKey, job)
  }

  /** A plan search (spec §4), by the same rules as `request`, in the same slots. */
  search(bookId: string, cacheKey: string, job: PlanSearchJob): Promise<SearchAnswer> {
    return this.#ask(this.#searches, bookId, cacheKey, job)
  }

  /** Searches running now (not those waiting), of either kind. */
  running(): number {
    return this.#running
  }

  /** Stopping: every search waiting for a slot, and every later one, is answered busy at once. Running ones end with their runner. */
  close(): void {
    this.#closed = true
    for (const answer of [...this.#waiting]) answer(false)
  }

  #ask<J, R, A>(k: Kind<J, R, A>, bookId: string, cacheKey: string, job: J): Promise<A | Busy> {
    const now = this.#now()
    for (const [key, d] of k.done) if (now - d.computedAt >= this.#cacheMs) k.done.delete(key)
    const hit = k.done.get(cacheKey)
    if (hit !== undefined) return Promise.resolve(k.answer(hit.out, hit.computedAt, true, hit.job))
    const flying = k.flights.get(bookId)
    if (flying !== undefined) return flying.key === cacheKey ? flying.promise : Promise.resolve(busy())
    // In the map before the search starts: a runner that throws at once must not leave the book busy for ever.
    const flight: Flight<A | Busy> = { key: cacheKey, promise: Promise.resolve(busy()) }
    k.flights.set(bookId, flight)
    flight.promise = this.#search(k, bookId, flight, job)
    return flight.promise
  }

  async #search<J, R, A>(k: Kind<J, R, A>, bookId: string, flight: Flight<A | Busy>, job: J): Promise<A | Busy> {
    try {
      if (!(await this.#slot())) return busy()
      try {
        const out = await k.run(job)
        const computedAt = this.#now()
        k.done.set(flight.key, { job, out, computedAt })
        return k.answer(out, computedAt, false, job)
      } finally {
        this.#release()
      }
    } finally {
      if (k.flights.get(bookId) === flight) k.flights.delete(bookId)
    }
  }

  /** true once a slot is this search's; false after `waitMs` without one, or once the pool is closed. */
  #slot(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    if (this.#running < this.#maxRunning) {
      this.#running++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const answer = (granted: boolean): void => {
        clearTimeout(timer)
        const i = this.#waiting.indexOf(answer)
        if (i >= 0) this.#waiting.splice(i, 1)
        resolve(granted)
      }
      // unref'd: a waiting request never holds the process open on its own
      const timer = setTimeout(() => answer(false), this.#waitMs)
      timer.unref()
      this.#waiting.push(answer)
    })
  }

  /** A finished search's slot passes straight to the next one waiting. */
  #release(): void {
    const next = this.#waiting[0]
    if (next === undefined) this.#running--
    else next(true)
  }
}

type Reply =
  | { readonly ok: true; readonly plans: readonly RepairPlan[] }
  | { readonly ok: true; readonly result: PlanSearchResult }
  | { readonly ok: false; readonly error: string }
/** `job` is posted as it is: the worker tells a plan search by its `kind`. */
interface Task { readonly job: RepairJob | PlanSearchJob; resolve(out: unknown): void; reject(err: Error): void }
interface Running { readonly task: Task; readonly deadline: ReturnType<typeof setTimeout> }

const WORKER = new URL('./repair-worker.ts', import.meta.url)
const CLOSED = 'the repair workers are closed'

/**
 * Up to `size` worker threads, each running one job at a time; a job waits
 * for a free one. A worker starts on the first job that needs it and is
 * unref'd while idle, so it never holds the process open. A worker that dies
 * fails its job and the next job starts a new one; so does one still running
 * at `timeoutMs`, which is ended. `close()` fails what is queued or running and
 * ends every worker. `run` takes a repair, `runSearch` a plan search, on the
 * same workers. `entry` is a test seam: the worker's script.
 */
export function workerRunner(
  size: number = REPAIR_MAX_RUNNING, opts: { timeoutMs?: number; entry?: URL } = {},
): { run: RepairRunner; runSearch: PlanSearchRunner; close(): Promise<void> } {
  const timeoutMs = opts.timeoutMs ?? REPAIR_RUN_TIMEOUT_MS
  const entry = opts.entry ?? WORKER
  const workers = new Map<Worker, Running | null>()   // each worker's job; null = idle
  const ending = new Set<Promise<number>>()           // workers past their deadline, being terminated
  const queue: Task[] = []
  let closed = false

  const assign = (w: Worker, t: Task): void => {
    try {
      w.postMessage(t.job)
    } catch (err) {   // a job that does not clone never reaches the worker, which stays idle
      t.reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const deadline = setTimeout(() => {
      if (workers.get(w)?.task !== t) return
      workers.delete(w)   // out of the map first: nothing is handed to it while it ends
      t.reject(new Error(`the ${'kind' in t.job ? 'plan' : 'repair'} search took longer than ${timeoutMs / 1000} s and was stopped`))
      const end = w.terminate()
      ending.add(end)
      end.then(() => ending.delete(end), () => ending.delete(end))
      pump()
    }, timeoutMs)
    deadline.unref()   // the worker is ref'd while it runs
    workers.set(w, { task: t, deadline })
    w.ref()
  }

  const pump = (): void => {
    while (!closed && queue.length > 0) {
      let w = [...workers].find(([, t]) => t === null)?.[0]
      if (w === undefined && workers.size < size) w = spawn()
      if (w === undefined) return
      assign(w, queue.shift() as Task)
    }
  }

  const spawn = (): Worker => {
    const w = new Worker(entry)
    w.unref()
    workers.set(w, null)
    w.on('message', (r: Reply) => {
      const run = workers.get(w)
      if (run === undefined || run === null) return
      clearTimeout(run.deadline)
      workers.set(w, null)
      w.unref()
      if (!r.ok) run.task.reject(new Error(r.error))
      else run.task.resolve('result' in r ? r.result : r.plans)
      pump()
    })
    const gone = (why: Error): void => {
      const run = workers.get(w)
      if (run === undefined) return   // 'error' then 'exit', or a worker ended at its deadline: said once
      workers.delete(w)
      if (run !== null) {
        clearTimeout(run.deadline)
        run.task.reject(closed ? new Error(CLOSED) : why)
      }
      pump()
    }
    w.on('error', (err) => gone(err instanceof Error ? err : new Error(String(err))))
    w.on('exit', (code) => gone(new Error(`a repair worker stopped (exit code ${code})`)))
    return w
  }

  const enqueue = <T>(job: RepairJob | PlanSearchJob): Promise<T> => {
    if (closed) return Promise.reject(new Error(CLOSED))
    return new Promise<T>((resolve, reject) => {
      queue.push({ job, resolve: (out) => resolve(out as T), reject })
      pump()
    })
  }

  return {
    run: (job) => enqueue<readonly RepairPlan[]>(job),
    runSearch: (job) => enqueue<PlanSearchResult>(job),
    async close() {
      closed = true
      for (const t of queue.splice(0)) t.reject(new Error(CLOSED))
      await Promise.all([...[...workers.keys()].map((w) => w.terminate()), ...ending])
    },
  }
}
