import test from 'node:test'
import assert from 'node:assert/strict'
import { WsTransportServer, WsTransportClient } from '../src/index.ts'

/** Wait for a condition, or fail loudly rather than hanging the suite. */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a client receives what the server publishes', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  const seen: unknown[] = []
  client.subscribe('md.index.NIFTY', (m) => seen.push(m.payload))

  await until(() => server.clientCount === 1)
  server.publish('md.index.NIFTY', { lastPrice: 24500 }, 1000)

  await until(() => seen.length === 1)
  assert.deepEqual(seen[0], { lastPrice: 24500 })

  await client.close()
  await server.close()
})

test('wildcard subscriptions work across the wire', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  const topics: string[] = []
  client.subscribe('md.#', (m) => topics.push(m.topic))
  await until(() => server.clientCount === 1)

  server.publish('md.index.NIFTY', {}, 1)
  server.publish('md.opt.NIFTY.2026-07-30', {}, 2)
  server.publish('sys.error.x', {}, 3)

  await until(() => topics.length === 2)
  assert.deepEqual(topics, ['md.index.NIFTY', 'md.opt.NIFTY.2026-07-30'])

  await client.close()
  await server.close()
})

test('a client that is not subscribed receives nothing', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  let count = 0
  client.subscribe('md.opt.#', () => count++)
  await until(() => server.clientCount === 1)
  server.publish('md.index.NIFTY', {}, 1)

  await new Promise((r) => setTimeout(r, 100))
  assert.equal(count, 0)

  await client.close()
  await server.close()
})

test('a malformed frame does not kill the connection', async () => {
  // A publisher bug must not take down every consumer.
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  const seen: string[] = []
  client.subscribe('t.#', (m) => seen.push(m.topic))
  await until(() => server.clientCount === 1)

  server.sendRaw('this is not json')
  server.publish('t.a', {}, 1)

  await until(() => seen.length === 1)
  assert.deepEqual(seen, ['t.a'], 'the good message still arrives')

  await client.close()
  await server.close()
})

test('two clients both receive a published message', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const a = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  const b = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await a.ready()
  await b.ready()

  let ca = 0
  let cb = 0
  a.subscribe('t.a', () => ca++)
  b.subscribe('t.a', () => cb++)
  await until(() => server.clientCount === 2)

  server.publish('t.a', {}, 1)
  await until(() => ca === 1 && cb === 1)
  assert.equal(ca, 1)
  assert.equal(cb, 1)

  await a.close()
  await b.close()
  await server.close()
})

test('server.close() resolves even with a client still attached', async () => {
  // ws's own WebSocketServer.close() does not terminate existing sockets — it
  // only stops accepting new connections and waits for clients.size to reach
  // zero on its own. A shutdown path that closes the server first (client
  // still connected) would hang forever without the fix. This test would time
  // out (and fail via the 2000ms `until` cap, or the outer test-runner
  // timeout) if that regressed.
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()
  await until(() => server.clientCount === 1)

  // Deliberately do NOT close the client first.
  await server.close()

  await client.close()
})

test('ready() reflects "not connected" immediately after a server-initiated disconnect', async () => {
  // Before the fix, #openPromise was only reassigned INSIDE the delayed
  // reconnect's setTimeout, so ready() kept resolving off the OLD (already
  // fulfilled) promise for up to `reconnectMs` after the drop — a false
  // "connected" during which publish() silently drops every message.
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}`, reconnectMs: 300 })
  await client.ready()
  await until(() => server.clientCount === 1)

  server.disconnectClients()
  // Give the client's socket a moment to actually observe the drop and fire
  // its 'close' handler (which is where #openPromise gets reassigned).
  await new Promise((r) => setTimeout(r, 30))

  // Well before reconnectMs (300ms) elapses, a fresh ready() call must NOT
  // resolve as "connected".
  let resolvedImmediately = false
  void client.ready().then(() => {
    resolvedImmediately = true
  })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(resolvedImmediately, false, 'ready() must not falsely report connected right after a drop')

  // ...and it does eventually resolve once the delayed reconnect succeeds.
  await client.ready()
  assert.equal(resolvedImmediately, true)

  await client.close()
  await server.close()
})
