import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OrderSocketSupervisor, type OrderSocketHandle } from '../src/order-socket.ts'

/** A socket that records whether it was closed, so a leak is visible. */
class FakeSocket implements OrderSocketHandle {
  closed = 0
  readonly token: string
  // A parameter property would be nicer, but Node runs these sources in
  // strip-only mode and rejects that syntax outright.
  constructor(token: string) {
    this.token = token
  }
  close(): void {
    this.closed += 1
  }
}

function build(opts: { wire?: (t: string, u: string) => Promise<OrderSocketHandle | null> } = {}) {
  const built: FakeSocket[] = []
  const logs: string[] = []
  const sup = new OrderSocketSupervisor({
    wire:
      opts.wire ??
      (async (token: string) => {
        const s = new FakeSocket(token)
        built.push(s)
        return s
      }),
    log: (m) => void logs.push(m),
  })
  return { sup, built, logs }
}

test('the socket is rebuilt when the token rotates', async () => {
  // THE 2026-08-10 FAILURE. The socket carries its token in the handshake query
  // string, so after a re-login it reconnects forever with the dead one. It
  // stayed down through an entire live session because nothing rewired it.
  const { sup, built } = build()

  await sup.sync('token-day-1', 'ZZJ11574')
  assert.equal(built.length, 1)
  assert.equal(sup.wiredToken, 'token-day-1')

  await sup.sync('token-day-2', 'ZZJ11574')
  assert.equal(built.length, 2, 'the new token did not get its own socket')
  assert.equal(built[0]?.closed, 1, 'the stale socket was left retrying with a dead token')
  assert.equal(sup.wiredToken, 'token-day-2')
})

test('an unchanged token does not churn the connection', async () => {
  // `onToken` also fires on a relogin that hands back the token we already
  // hold. Rebuilding then would drop a working socket for nothing.
  const { sup, built } = build()
  await sup.sync('same', 'u')
  await sup.sync('same', 'u')
  await sup.sync('same', 'u')
  assert.equal(built.length, 1)
  assert.equal(built[0]?.closed, 0)
})

test('an empty token leaves a working socket alone', async () => {
  // A read that comes back without a token means "not logged in right now",
  // not "disconnect the socket that is currently delivering fills".
  const { sup, built } = build()
  await sup.sync('real', 'u')
  await sup.sync('', '')
  assert.equal(built.length, 1)
  assert.equal(built[0]?.closed, 0)
  assert.equal(sup.wiredToken, 'real')
})

test('a wiring failure is degraded, not fatal, and the next token retries', async () => {
  // Without a socket the gateway still places orders and learns their fate from
  // the sweep. Throwing here would take down the login path instead.
  let attempt = 0
  const { sup, logs } = build({
    wire: async (token) => {
      attempt += 1
      if (attempt === 1) throw new Error('socket.io handshake refused')
      return new FakeSocket(token)
    },
  })

  await sup.sync('token-a', 'u')
  assert.equal(sup.wiredToken, '', 'a failed wire must not be recorded as wired')
  assert.ok(logs.some((m) => /rewire failed/.test(m)))

  await sup.sync('token-b', 'u')
  assert.equal(sup.wiredToken, 'token-b', 'the next rotation never got a second chance')
})

test('a wire that yields no socket is recorded as unwired, not as success', async () => {
  // `wire` returns null when it swallowed its own error. Recording the token
  // anyway would make the NEXT rotation a no-op and strand the gateway.
  const { sup } = build({ wire: async () => null })
  await sup.sync('token-a', 'u')
  assert.equal(sup.wiredToken, '')
})

test('concurrent rotations do not orphan a socket', async () => {
  // The snapshot loop's relogin and the adapter's single-flight relogin can
  // both announce a token at once; two overlapping rewires would leave one
  // socket alive and retrying with nobody holding its handle.
  const built: FakeSocket[] = []
  // A deferred rather than a captured `let`: assigning inside the executor
  // leaves TS narrowing the variable to `null` at the call site below.
  const gate: { release: () => void; wait: Promise<void> } = (() => {
    let release = (): void => {}
    const wait = new Promise<void>((r) => {
      release = r
    })
    return { release, wait }
  })()
  const sup = new OrderSocketSupervisor({
    wire: async (token) => {
      if (built.length === 0) await gate.wait
      const s = new FakeSocket(token)
      built.push(s)
      return s
    },
    log: () => {},
  })

  const first = sup.sync('token-a', 'u')
  const second = sup.sync('token-b', 'u')
  // Let the first wiring finish only once the second is already queued.
  await new Promise<void>((r) => setTimeout(r, 0))
  gate.release()
  await Promise.all([first, second])

  assert.equal(built.length, 2)
  assert.equal(sup.wiredToken, 'token-b')
  assert.equal(built[0]?.closed, 1, 'the first socket was orphaned by the overlapping rewire')
})

test('close tears the socket down on shutdown', async () => {
  const { sup, built } = build()
  await sup.sync('t', 'u')
  sup.close()
  assert.equal(built[0]?.closed, 1)
  assert.equal(sup.wiredToken, '')
  sup.close()
  assert.equal(built[0]?.closed, 1, 'close must be idempotent')
})
