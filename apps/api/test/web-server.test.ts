import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { startWebServer, type WebServer } from '../src/web-server.ts'

let root: string
let upstream: http.Server
let upstreamPort: number
let web: WebServer
let webPort: number
let deadWeb: WebServer
let deadPort: number
const seen: { method?: string | undefined; url?: string | undefined; body: string; headers: http.IncomingHttpHeaders }[] = []

function get(port: number, p: string, opts: http.RequestOptions = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', ...opts }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }))
    })
    req.on('error', reject)
    if (opts.method === 'POST') req.write('{"a":1}')
    req.end()
  })
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as AddressInfo).port
  await new Promise((r) => s.close(r))
  return p
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxweb-'))
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'index.html'), '<html>spa</html>')
  fs.writeFileSync(path.join(root, 'assets', 'app-abc.js'), 'console.log(1)')
  fs.writeFileSync(path.join(root, '..', 'dxweb-secret.txt'), 'secret')
  upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, echo: body }))
    })
  })
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = (upstream.address() as AddressInfo).port
  web = await startWebServer({ port: 0, host: '127.0.0.1', root, api: `http://127.0.0.1:${upstreamPort}` })
  webPort = web.port
  deadPort = await freePort()
  deadWeb = await startWebServer({ port: 0, host: '127.0.0.1', root, api: `http://127.0.0.1:${deadPort}` })
})

after(async () => {
  await web.close()
  await deadWeb.close()
  upstream.closeAllConnections()
  await new Promise((r) => upstream.close(r))
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(path.join(root, '..', 'dxweb-secret.txt'), { force: true })
})

test('serves index with no-cache and assets immutable', async () => {
  const i = await get(webPort, '/')
  assert.equal(i.status, 200)
  assert.equal(i.body, '<html>spa</html>')
  assert.match(String(i.headers['cache-control']), /no-cache/)
  const a = await get(webPort, '/assets/app-abc.js')
  assert.equal(a.status, 200)
  assert.match(String(a.headers['cache-control']), /immutable/)
})

test('SPA fallback for extension-less unknown paths, 404 for missing files', async () => {
  const r = await get(webPort, '/traders/books')
  assert.equal(r.status, 200)
  assert.equal(r.body, '<html>spa</html>')
  assert.equal((await get(webPort, '/missing.js')).status, 404)
})

test('path traversal is a 404', async () => {
  for (const p of ['/../package.json', '/%2e%2e/dxweb-secret.txt', '/%2e%2e%2f%2e%2e%2fetc/passwd', '/assets/../../dxweb-secret.txt']) {
    const r = await get(webPort, p)
    // Either refused, or clamped under the root and answered by the SPA shell: never a file outside it.
    assert.ok(r.status === 404 || r.status === 400 || r.body === '<html>spa</html>', `${p} -> ${r.status}`)
    assert.ok(!r.body.includes('secret') && !r.body.includes('root:'))
  }
})

test('NUL byte is rejected', async () => {
  const r = await get(webPort, '/index.html%00.png')
  assert.ok(r.status === 400 || r.status === 404)
})

test('non-GET on a static path is 405', async () => {
  const r = await get(webPort, '/', { method: 'POST' })
  assert.equal(r.status, 405)
})

test('proxies GET and POST under /v1 with origin and cookie intact', async () => {
  seen.length = 0
  const g = await get(webPort, '/v1/health?x=1', { headers: { origin: 'http://3.108.231.230:5000', cookie: 'sid=abc' } })
  assert.equal(g.status, 200)
  assert.equal(seen[0]?.url, '/v1/health?x=1')
  assert.equal(seen[0]?.headers['origin'], 'http://3.108.231.230:5000')
  assert.equal(seen[0]?.headers['cookie'], 'sid=abc')
  const p = await get(webPort, '/v1/things', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '7' } })
  assert.equal(p.status, 200)
  assert.equal(seen[1]?.method, 'POST')
  assert.equal(seen[1]?.body, '{"a":1}')
})

test('websocket upgrade is piped through to the upstream', async () => {
  const sock = net.connect(webPort, '127.0.0.1')
  await new Promise<void>((r) => sock.once('connect', r))
  sock.write('GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n')
  let buf = ''
  const got = (needle: string) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout ' + buf)), 3000)
      const on = (d: Buffer) => {
        buf += d.toString()
        if (buf.includes(needle)) {
          clearTimeout(t)
          sock.off('data', on)
          resolve()
        }
      }
      sock.on('data', on)
      on(Buffer.alloc(0))
    })
  await got('101 Switching')
  sock.write('hello')
  await got('echo:hello')
  sock.destroy()
})

test('502 when the upstream is down', async () => {
  const r = await get(deadWeb.port, '/v1/health')
  assert.equal(r.status, 502)
})

test('refuses to start without index.html', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dxweb-empty-'))
  await assert.rejects(startWebServer({ port: 0, host: '127.0.0.1', root: empty, api: 'http://127.0.0.1:1' }))
  fs.rmSync(empty, { recursive: true, force: true })
})
