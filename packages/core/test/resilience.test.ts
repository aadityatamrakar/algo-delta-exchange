/**
 * The shared staying-up primitives (audit F-41).
 *
 * These were written for, and lived in, `apps/order-gateway/src/resilience.ts`
 * — the two incidents they document are that process's incidents. They are
 * asserted HERE as well because they now belong to `@algomaker/core` and three
 * processes boot through them: a regression would not take one app down, it
 * would take the desk down. `apps/order-gateway/test/resilience.test.ts` keeps
 * its own suite pointed at `../src/resilience.ts`, which is how the re-export
 * stays honest.
 *
 * Imported from `../src/index.ts` DELIBERATELY, not from `../src/resilience.ts`:
 * what `apps/api` and `apps/runner` import is the package, so the package
 * surface is what has to be pinned. A file that exists but is not re-exported
 * is a file nobody can install.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectWithRetry, installCrashGuards, type ProcessLike } from '../src/index.ts'

class FakeProcess implements ProcessLike {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
    return this
  }
  emit(event: string, ...args: unknown[]): number {
    const list = this.handlers.get(event) ?? []
    for (const h of list) h(...args)
    return list.length
  }
}

// ------------------------------------------------------------------ G4

test('the package exports the guards — installing them from @algomaker/core works', () => {
  assert.equal(typeof installCrashGuards, 'function')
  assert.equal(typeof connectWithRetry, 'function')
})

test('an unhandled rejection is LOGGED, not fatal', () => {
  const proc = new FakeProcess()
  const logs: { msg: string; ctx: Record<string, unknown> | undefined }[] = []
  installCrashGuards({ process: proc, log: (msg, ctx) => void logs.push({ msg, ctx }) })

  assert.equal(proc.handlers.has('unhandledRejection'), true, 'nothing listened for this at all')
  proc.emit('unhandledRejection', new Error('mongo blip inside claimNext'))
  assert.equal(logs.length, 1)
  assert.match(logs[0]?.msg ?? '', /UNHANDLED REJECTION/)
  assert.match(String(logs[0]?.ctx?.['error'] ?? ''), /mongo blip inside claimNext/)
})

test('uncaughtException is deliberately NOT swallowed', () => {
  // A synchronous throw out of a call stack really can leave torn state, and
  // there is no bounded recovery from it the way there is from a rejection.
  const proc = new FakeProcess()
  installCrashGuards({ process: proc, log: () => {} })
  assert.equal(proc.handlers.has('uncaughtException'), false)
})

// ------------------------------------------------------------------ G6

test('a boot that cannot reach Mongo RETRIES instead of exiting', async () => {
  // The whole of G6: each 5s failure died inside pm2's `min_uptime`, so ten of
  // them spent the restart budget in ~70 seconds and pm2 stopped trying. Mongo
  // returning at 09:16 then brought nothing back with it.
  let attempts = 0
  const slept: number[] = []
  const value = await connectWithRetry(
    async () => {
      attempts++
      if (attempts < 4) throw new Error('server selection timed out')
      return 'connected'
    },
    {
      log: () => {},
      what: 'Mongo',
      sleep: async (ms) => void slept.push(ms),
      firstDelayMs: 100,
      maxDelayMs: 250,
    },
  )
  assert.equal(value, 'connected')
  assert.equal(attempts, 4)
  // Exponential, then CAPPED: a Mongo that returns after an hour is picked up
  // within maxDelayMs, not an hour later.
  assert.deepEqual(slept, [100, 200, 250])
})

test('a bounded caller still gets the error — the infinite default is a default, not a law', async () => {
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          throw new Error('refused')
        },
        { log: () => {}, what: 'Mongo', sleep: async () => {}, maxAttempts: 3 },
      ),
    /refused/,
  )
})

test('coming back is stated, so an operator can see the outage ended', async () => {
  const logs: string[] = []
  let attempts = 0
  await connectWithRetry(
    async () => {
      attempts++
      if (attempts === 1) throw new Error('down')
      return 1
    },
    { log: (m) => void logs.push(m), what: 'Mongo', sleep: async () => {} },
  )
  assert.equal(logs.some((l) => /not reachable/.test(l)), true)
  assert.equal(logs.some((l) => /reachable again/.test(l)), true)
})
