/**
 * One-port web front for the dx desk: serves the built dashboard and proxies
 * `/v1` (HTTP and websocket upgrade) to desk-api. node:http and node:net only.
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WebServerOptions {
  port: number
  host?: string
  root: string
  api: string
}
export interface WebServer {
  port: number
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function isProxied(url: string): boolean {
  return url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?')
}

function resolveStatic(root: string, rawPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded))
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return full
}

function statFile(p: string): fs.Stats | null {
  try {
    const s = fs.statSync(p)
    return s.isFile() ? s : null
  } catch {
    return null
  }
}

export async function startWebServer(opts: WebServerOptions): Promise<WebServer> {
  const root = path.resolve(opts.root)
  const indexPath = path.join(root, 'index.html')
  if (statFile(indexPath) === null) throw new Error(`index.html not found in ${root}`)
  const api = new URL(opts.api)
  const apiPort = Number(api.port || 80)

  const send = (res: http.ServerResponse, status: number, msg: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(msg)
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (isProxied(url)) {
      const up = http.request(
        { host: api.hostname, port: apiPort, method: req.method, path: url, headers: req.headers },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers)
          ur.pipe(res)
        },
      )
      up.on('error', () => {
        if (!res.headersSent) send(res, 502, 'api unavailable')
        else res.destroy()
      })
      res.on('close', () => up.destroy())
      req.pipe(up)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return send(res, 405, 'method not allowed')
    }
    const pathname = url.split('?')[0]!.split('#')[0]!
    const full = resolveStatic(root, pathname)
    if (full === null) return send(res, 404, 'not found')
    let file = statFile(full)
    let target = full
    if (file === null) {
      if (path.extname(pathname) !== '') return send(res, 404, 'not found')
      target = indexPath
      file = statFile(indexPath)
      if (file === null) return send(res, 404, 'not found')
    }
    const rel = path.relative(root, target).split(path.sep).join('/')
    const cache = rel === 'index.html' ? 'no-cache' : rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': file.size,
      'cache-control': cache,
    })
    if (req.method === 'HEAD') return void res.end()
    fs.createReadStream(target).on('error', () => res.destroy()).pipe(res)
  })

  const piped = new Set<import("node:stream").Duplex>()
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    if (!isProxied(url)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const up = net.connect(apiPort, api.hostname)
    piped.add(socket).add(up)
    const forget = (): void => void (piped.delete(socket), piped.delete(up))
    socket.on('close', forget)
    up.on('close', forget)
    up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'))
    socket.on('error', () => up.destroy())
    socket.on('close', () => up.destroy())
    up.on('close', () => socket.destroy())
    up.on('connect', () => {
      let raw = `${req.method} ${url} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      up.write(raw + '\r\n')
      if (head.length > 0) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '0.0.0.0', resolve)
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        for (const s of piped) s.destroy()
        server.close(() => resolve())
      }),
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = env['DESK_WEB_ROOT'] ?? path.resolve(here, '../../web/dist')
  const api = env['DESK_WEB_API'] ?? `http://127.0.0.1:${env['DESK_PORT'] ?? 8890}`
  const port = Number(env['DESK_WEB_PORT'] ?? 5000)
  const s = await startWebServer({ port, host: '0.0.0.0', root, api })
  console.log(`[dx-web] listening on ${s.port}, root=${root}, api=${api}`)
}
