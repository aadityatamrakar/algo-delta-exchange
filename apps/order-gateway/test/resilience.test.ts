import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectWithRetry, installCrashGuards, type ProcessLike } from '../src/resilience.ts'

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

test('an unhandled rejection is LOGGED, not fatal', async () => {
  // Node >=15 exits the process on an unhandled rejection. `void sweep()` and
  // the order-update handler both had promises with no catch, so a Mongo blip
  // inside claimNext() killed the only process that can place orders.
  const proc = new FakeProcess()
  const logs: { msg: string; ctx: Record<string, unknown> | undefined }[] = []
  installCrashGuards({ process: proc, log: (msg, ctx) => void logs.push({ msg, ctx }) })

  assert.equal(proc.handlers.has('unhandledRejection'), true, 'nothing listened for this at all')
  proc.emit('unhandledRejection', new Error('connection 4 to mongo closed'))

  assert.equal(logs.length, 1)
  assert.match(logs[0]?.msg ?? '', /UNHANDLED REJECTION/)
  assert.match(String(logs[0]?.ctx?.['error']), /connection 4 to mongo closed/)
})

test('a non-Error rejection reason is still reported', async () => {
  const proc = new FakeProcess()
  const logs: string[] = []
  installCrashGuards({ process: proc, log: (_m, ctx) => void logs.push(String(ctx?.['error'])) })
  proc.emit('unhandledRejection', 'plain string')
  assert.deepEqual(logs, ['plain string'])
})

test('uncaughtException is NOT swallowed', () => {
  // A synchronous throw out of a call stack can leave torn state; there is no
  // bounded recovery from it the way there is from a rejected promise.
  const proc = new FakeProcess()
  installCrashGuards({ process: proc, log: () => {} })
  assert.equal(proc.handlers.has('uncaughtException'), false)
})

// ------------------------------------------------------------------ G6

test('a boot dependency that is DOWN is retried, never exited on', async () => {
  // Every main() awaited connectMongo (5s serverSelectionTimeoutMS) and exited
  // on failure. Each life was under pm2's min_uptime: 10_000, so ten of them
  // burned the restart budget in ~70 seconds and pm2 gave up. Mongo returning
  // at 09:16 then brought nothing back.
  const slept: number[] = []
  let attempts = 0
  const value = await connectWithRetry(
    async () => {
      attempts++
      if (attempts < 4) throw new Error('server selection timed out after 5000 ms')
      return 'connected'
    },
    {
      what: 'Mongo',
      log: () => {},
      sleep: async (ms) => void slept.push(ms),
    },
  )
  assert.equal(value, 'connected')
  assert.equal(attempts, 4, 'it kept trying instead of dying on the first failure')
})

test('the backoff grows and is CAPPED', async () => {
  // Uncapped, a Mongo that returns after an hour is picked up an hour later.
  const slept: number[] = []
  let attempts = 0
  await connectWithRetry(
    async () => {
      attempts++
      if (attempts < 8) throw new Error('down')
      return 1
    },
    { what: 'Mongo', log: () => {}, sleep: async (ms) => void slept.push(ms), firstDelayMs: 1000, maxDelayMs: 15_000 },
  )
  assert.deepEqual(slept, [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000])
})

test('every failed attempt says WHY, so the log names the outage', async () => {
  const logs: Record<string, unknown>[] = []
  let attempts = 0
  await connectWithRetry(
    async () => {
      attempts++
      if (attempts < 3) throw new Error('ECONNREFUSED 127.0.0.1:27017')
      return 1
    },
    {
      what: 'Mongo',
      log: (_m, ctx) => void logs.push(ctx ?? {}),
      sleep: async () => {},
    },
  )
  assert.equal(logs.length, 3, 'two failures and the recovery')
  assert.match(String(logs[0]?.['error']), /ECONNREFUSED/)
  assert.equal(logs[2]?.['attempt'], 3, 'recovery names the attempt it succeeded on')
})

test('a bounded retry still surfaces the error, for tests and one-shot tools', async () => {
  await assert.rejects(
    connectWithRetry(
      async () => {
        throw new Error('down')
      },
      { what: 'Mongo', log: () => {}, sleep: async () => {}, maxAttempts: 3 },
    ),
    /down/,
  )
})
