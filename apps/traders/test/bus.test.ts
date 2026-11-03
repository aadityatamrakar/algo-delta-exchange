import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WsTransportServer } from '@algomaker/bus'
import { openBus } from '../src/market/bus.ts'

const until = async (ok: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('openBus opens the socket: a tick published on the desk bus reaches a subscriber', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const logs: string[] = []
  const bus = openBus(`ws://127.0.0.1:${port}`, (m) => { logs.push(m) })
  try {
    const got = new Promise<unknown>((resolve) => { bus.subscribe('md.tick', (m) => { resolve(m.payload) }) })
    await until(() => bus.connected, 'the socket')
    server.publish('md.tick', { token: 7, price: 45 }, 1_000)
    assert.deepEqual(await got, { token: 7, price: 45 })
    await until(() => logs.includes('bus connected'), 'the log line')
  } finally {
    await bus.close()
    await server.close()
  }
})

test('a bus that is not up yet is logged and retried, not thrown', async () => {
  const probe = new WsTransportServer({ port: 0 })
  const port = await probe.ready()
  await probe.close()
  const logs: string[] = []
  const bus = openBus(`ws://127.0.0.1:${port}`, (m) => { logs.push(m) })
  try {
    await until(() => logs.includes('bus not reachable yet, will retry'), 'the log line')
    assert.equal(bus.connected, false)
  } finally {
    await bus.close()
  }
})
