/**
 * `hostFetch` — the `node:http` fetch the optionbhai client uses when a `Host`
 * override is configured. Against a server on 127.0.0.1 with an ephemeral
 * port; nothing here leaves the box.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { hostFetch } from '../src/host-fetch.ts'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

test('the Host header goes on the wire as given, with the body and its length', async (t) => {
  let seen: { headers: IncomingHttpHeaders; method: string | undefined; body: string } | null = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      seen = { headers: req.headers, method: req.method, body }
      res.writeHead(200, { 'content-type': 'application/json', 'cf-ray': 'r-1' })
      res.end('{"token":"t"}')
    })
  })
  const port = await listen(server)
  t.after(() => server.close())

  const res = await hostFetch(`http://127.0.0.1:${port}/auth/login`, {
    method: 'POST',
    headers: { Host: 'optionbhai.com', 'content-type': 'application/json', 'User-Agent': 'ua/1' },
    body: '{"username":"u"}',
  })
  assert.equal(res.ok, true)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cf-ray'), 'r-1')
  assert.equal(await res.text(), '{"token":"t"}')
  assert.ok(seen !== null)
  const s = seen as { headers: IncomingHttpHeaders; method: string | undefined; body: string }
  assert.equal(s.method, 'POST')
  assert.equal(s.headers.host, 'optionbhai.com')
  assert.equal(s.headers['user-agent'], 'ua/1')
  assert.equal(s.headers['content-length'], '16')
  assert.equal(s.body, '{"username":"u"}')
})

test('a non-2xx answer resolves with its status — it is not an exception', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(403)
    res.end('blocked')
  })
  const port = await listen(server)
  t.after(() => server.close())
  const res = await hostFetch(`http://127.0.0.1:${port}/x`)
  assert.equal(res.ok, false)
  assert.equal(res.status, 403)
  assert.equal(await res.text(), 'blocked')
})

test('a server that never answers is abandoned at the deadline', async (t) => {
  const server = createServer(() => {
    // Never respond.
  })
  const port = await listen(server)
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  await assert.rejects(hostFetch(`http://127.0.0.1:${port}/auth/login`, { method: 'POST', body: '{}' }, 50), /timed out/)
})

/**
 * The deadline is WALL-CLOCK, not a socket idle timer: a server that keeps the
 * connection busy with one byte at a time must not keep the request alive.
 */
test('a server that drips its body a byte at a time is abandoned at the deadline', async (t) => {
  const timers: NodeJS.Timeout[] = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('x')
    timers.push(setInterval(() => res.write('x'), 400))
  })
  const port = await listen(server)
  t.after(() => {
    for (const timer of timers) clearInterval(timer)
    server.closeAllConnections()
    server.close()
  })
  const started = Date.now()
  await assert.rejects(hostFetch(`http://127.0.0.1:${port}/api/instruments`, {}, 1_000), /timed out/)
  const took = Date.now() - started
  assert.ok(took >= 900 && took < 2_500, `took ${took} ms`)
})

/**
 * A listener that never ACCEPTS: a stopped child process whose backlog is
 * already full, so the kernel drops our SYN and the connect itself hangs —
 * the blackholed-origin case, where an idle timer armed at connect never runs.
 */
test('a connect that never completes is abandoned at the deadline', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const s = require('node:net').createServer();
       s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
         process.stdout.write(String(s.address().port) + '\\n');
         process.kill(process.pid, 'SIGSTOP');
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const fillers: Socket[] = []
  t.after(() => {
    for (const f of fillers) f.destroy()
    child.kill('SIGKILL')
  })
  const port = await new Promise<number>((resolve) =>
    child.stdout?.once('data', (d: Buffer) => resolve(Number(String(d).trim()))),
  )
  // Fill the accept queue of the stopped listener (backlog 1 holds two).
  for (let i = 0; i < 4; i++) {
    const f = connect(port, '127.0.0.1')
    f.on('error', () => {})
    fillers.push(f)
  }
  await new Promise((r) => setTimeout(r, 200))

  const started = Date.now()
  await assert.rejects(hostFetch(`http://127.0.0.1:${port}/auth/login`, { method: 'POST', body: '{}' }, 1_000), /timed out/)
  const took = Date.now() - started
  assert.ok(took >= 900 && took < 2_500, `took ${took} ms`)
})
