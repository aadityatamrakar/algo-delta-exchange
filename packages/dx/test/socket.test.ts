import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { DxPrivateSocket, DxPublicSocket, signWsAuth, type DxFrame } from '../src/index.ts'

/** A local stand-in for Delta's socket: records each connection's messages. */
function fakeServer(): Promise<{ url: string; conns: { ws: WebSocket; msgs: Record<string, unknown>[] }[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const conns: { ws: WebSocket; msgs: Record<string, unknown>[] }[] = []
    wss.on('connection', (ws) => {
      const c = { ws, msgs: [] as Record<string, unknown>[] }
      conns.push(c)
      ws.on('message', (d) => c.msgs.push(JSON.parse(String(d)) as Record<string, unknown>))
    })
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port
      resolve({
        url: `ws://127.0.0.1:${port}`,
        conns,
        close: () =>
          new Promise<void>((r) => {
            for (const c of wss.clients) c.terminate()
            wss.close(() => r())
          }),
      })
    })
  })
}

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const subs = (msgs: Record<string, unknown>[]) =>
  msgs
    .filter((m) => m['type'] === 'subscribe')
    .flatMap((m) => (m['payload'] as { channels: { name: string; symbols: string[] }[] }).channels)

test('public socket: enables heartbeat, subscribes with the NEW channel names, parses frames', async () => {
  const srv = await fakeServer()
  const frames: DxFrame[] = []
  const s = new DxPublicSocket(srv.url, { onFrame: (f) => frames.push(f), reconnectMs: 20 })
  try {
    s.subscribe('ticker', ['BTC-041126'])
    s.subscribe('spot_price', ['.DEXBTUSD'])
    await until(() => subs(srv.conns[0]?.msgs ?? []).length === 2, 'two subscriptions')
    const c0 = srv.conns[0]
    assert.ok(c0)
    assert.equal(c0.msgs[0]?.['type'], 'enable_heartbeat')
    assert.deepEqual(subs(c0.msgs), [
      { name: 'ticker', symbols: ['BTC-041126'] },
      { name: 'spot_price', symbols: ['.DEXBTUSD'] },
    ])
    for (const ch of subs(c0.msgs)) assert.ok(!ch.name.startsWith('v2/'), 'no retired v2/ channel names')

    c0.ws.send(JSON.stringify({ type: 'spot_price', sy: '.DEXBTUSD', p: '76588.6', ts: 1793690000123456 }))
    await until(() => frames.some((f) => f.kind === 'spot'), 'spot frame')
    assert.deepEqual(frames.find((f) => f.kind === 'spot'), { kind: 'spot', symbol: '.DEXBTUSD', price: 76588.6, tsMs: 1793690000123 })
  } finally {
    s.close()
    await srv.close()
  }
})

test('public socket: resubscribes everything after a reconnect, and a later subscribe is sent once', async () => {
  const srv = await fakeServer()
  const states: string[] = []
  const s = new DxPublicSocket(srv.url, { onState: (st) => states.push(st), reconnectMs: 20 })
  try {
    s.subscribe('ticker', ['BTC-041126'])
    await until(() => subs(srv.conns[0]?.msgs ?? []).length === 1, 'first subscription')
    s.subscribe('ob_l1', ['BTC-041126'])
    await until(() => subs(srv.conns[0]?.msgs ?? []).length === 2, 'second subscription on the open socket')

    srv.conns[0]?.ws.terminate()
    await until(() => srv.conns.length === 2 && subs(srv.conns[1]?.msgs ?? []).length >= 2, 'resubscribe after reconnect')
    const names = subs(srv.conns[1]?.msgs ?? []).map((c) => c.name).sort()
    assert.deepEqual(names, ['ob_l1', 'ticker'])
    assert.equal(srv.conns[1]?.msgs[0]?.['type'], 'enable_heartbeat')
    assert.ok(states.includes('reconnecting'))
    assert.equal(states.filter((x) => x === 'open').length, 2)
  } finally {
    s.close()
    await srv.close()
  }
})

test('public socket: silence past the heartbeat timeout forces a reconnect', async () => {
  const srv = await fakeServer()
  const s = new DxPublicSocket(srv.url, { reconnectMs: 20, heartbeatTimeoutMs: 150 })
  try {
    s.subscribe('ticker', ['BTC-041126'])
    await until(() => srv.conns.length >= 2, 'reconnect after silence')
    await until(() => subs(srv.conns[1]?.msgs ?? []).length === 1, 'resubscribe')
  } finally {
    s.close()
    await srv.close()
  }
})

test('close() stops reconnecting', async () => {
  const srv = await fakeServer()
  const s = new DxPublicSocket(srv.url, { reconnectMs: 20 })
  await until(() => srv.conns.length === 1, 'connect')
  s.close()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(srv.conns.length, 1)
  await srv.close()
})

test('private socket: key-auth first, subscribe only after auth, re-auth on reconnect', async () => {
  const srv = await fakeServer()
  let nowMs = 1793690000_900
  const raws: unknown[] = []
  const s = new DxPrivateSocket(srv.url, {
    apiKey: 'KEY', apiSecret: 'test-secret', nowMs: () => nowMs, reconnectMs: 20,
    onFrame: (f) => { if (f.kind === 'other') raws.push(f.raw) },
  })
  try {
    s.subscribe('orders', ['all'])
    await until(() => (srv.conns[0]?.msgs.length ?? 0) >= 1, 'auth message')
    const c0 = srv.conns[0]
    assert.ok(c0)
    assert.deepEqual(c0.msgs[0], {
      type: 'key-auth',
      payload: { 'api-key': 'KEY', signature: signWsAuth('test-secret', 1793690000), timestamp: '1793690000' },
    })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(subs(c0.msgs).length, 0, 'no subscribe before the server says authenticated')

    c0.ws.send(JSON.stringify({ type: 'key-auth', success: true, status_code: 200, status: 'authenticated' }))
    await until(() => subs(c0.msgs).length === 1, 'subscribe after auth')
    assert.deepEqual(subs(c0.msgs), [{ name: 'orders', symbols: ['all'] }])

    c0.ws.send(JSON.stringify({ type: 'orders', action: 'update', order_id: 1 }))
    await until(() => raws.length === 1, 'private frame delivered raw')

    nowMs = 1793690100_000
    c0.ws.terminate()
    await until(() => (srv.conns[1]?.msgs.length ?? 0) >= 1, 're-auth')
    const auth2 = srv.conns[1]?.msgs[0] as { type: string; payload: { timestamp: string } }
    assert.equal(auth2.type, 'key-auth')
    assert.equal(auth2.payload.timestamp, '1793690100', 'a fresh timestamp each connect')
    srv.conns[1]?.ws.send(JSON.stringify({ type: 'key-auth', success: true }))
    await until(() => subs(srv.conns[1]?.msgs ?? []).length === 1, 'resubscribe after re-auth')
  } finally {
    s.close()
    await srv.close()
  }
})
