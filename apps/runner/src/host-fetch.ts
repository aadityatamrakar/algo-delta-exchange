/**
 * A minimal `fetch` over `node:http` / `node:https` that honours a `Host`
 * header.
 *
 * WHY NOT `globalThis.fetch`. Node's fetch (undici) replaces a caller's `Host`
 * header with the URL's own host — pinned by
 * `test/optionbhai-client.test.ts` against a local server. Reaching
 * optionbhai's origin by IP only works if the request names the vhost, so the
 * client uses this whenever `OPTIONBHAI_HOST_HEADER` is set, and plain `fetch`
 * otherwise (the pre-existing path, unchanged).
 *
 * It does exactly what the optionbhai client needs and nothing else: one
 * request, string body, no redirects followed, the whole response buffered.
 * And it has a DEADLINE: `node:http` has none of its own, and a login that
 * never answers would hold `MirrorHost.sync()` — which is re-entrancy guarded
 * — so that not even the portal's off switch could get through.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface HostFetchInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export const HOST_FETCH_TIMEOUT_MS = 30_000

/** Statuses a `Response` may not be constructed with a body for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

export function hostFetch(
  url: string,
  init: HostFetchInit = {},
  timeoutMs: number = HOST_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body))
    // A Host override over TLS still needs the vhost in SNI, or the origin
    // presents the wrong certificate (or none).
    const host = Object.entries(headers).find(([k]) => k.toLowerCase() === 'host')?.[1]
    const tls =
      target.protocol === 'https:' && host !== undefined ? { servername: host.replace(/:\d+$/, '') } : {}

    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn()
    }
    const fail = (err: unknown): void =>
      settle(() => reject(err instanceof Error ? err : new Error(String(err))))

    const req = send(target, { method: init.method ?? 'GET', headers, ...tls }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('error', fail)
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const out = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue
          for (const one of Array.isArray(v) ? v : [v]) out.append(k, one)
        }
        try {
          const response = new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), {
            status,
            statusText: res.statusMessage ?? '',
            headers: out,
          })
          settle(() => resolve(response))
        } catch (err) {
          fail(err)
        }
      })
    })
    /**
     * WALL-CLOCK, armed before the connect and covering every phase. Not
     * `req.setTimeout`: that is a socket IDLE timer, so a blackholed origin
     * (SYNs dropped) hangs for the kernel's ~2 min of SYN retries, and a server
     * dripping a byte every few seconds never times out at all.
     */
    const deadline = setTimeout(() => {
      const err = new Error(`${init.method ?? 'GET'} ${target.origin} timed out after ${timeoutMs} ms`)
      fail(err)
      req.destroy(err)
    }, timeoutMs)
    req.on('error', fail)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}
