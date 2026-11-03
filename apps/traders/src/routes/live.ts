/**
 * `GET /books/:stock/live` — the book as Server-Sent Events: a `frame` event at once, then one each second the frame
 * changes (prices and MTM from the quote cache; analytics/live.ts), and a `ping` event when nothing else went out for
 * 5 s — an event, not a comment, because EventSource hides comments and the page counts a stream silent for 10 s as
 * delayed. Outside the session nothing changes, so after the first frame only the pings go out. Whose book it is comes from `whose()`;
 * the session is checked again every few seconds and a stream whose session has ended is closed.
 *
 * Limits: LIVE_PER_USER streams per signed-in user (a fifth closes the oldest, as a forgotten tab would) and
 * LIVE_TOTAL in all (past it a new one is refused with 503). No compression: Caddy passes text/event-stream through.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { whose } from '../auth/whose.ts'
import type { TraderStore } from '../auth/users.ts'
import type { TradersDeps } from '../deps.ts'
import { STOCK_RE } from '../books/manual.ts'
import { LIVE_BASE_MS, liveBaseOf, liveFrame, sameFrame, type LiveBase } from '../analytics/live.ts'
import type { LiveFrame } from '../analytics/r3-wire.ts'
import { BadRequest, NotFound, type Route, type RouteCtx, type TradersGate } from './kit.ts'

export const LIVE_TICK_MS = 1_000
export const LIVE_PING_MS = 5_000
export const LIVE_AUTH_MS = 5_000
export const LIVE_PER_USER = 4
export const LIVE_TOTAL = 64

interface Stream { readonly user: string; close(): void }

/** Every open stream, so the caps hold and the app's stop() can end them. */
export class LiveStreams {
  readonly #open: Stream[] = []
  get size(): number { return this.#open.length }
  /** False when the total cap is reached. A user's oldest stream past LIVE_PER_USER is closed. */
  add(s: Stream, perUser = LIVE_PER_USER, total = LIVE_TOTAL): boolean {
    if (this.#open.length >= total) return false
    const mine = this.#open.filter((o) => o.user === s.user)
    if (mine.length >= perUser) mine[0]!.close()
    this.#open.push(s)
    return true
  }
  remove(s: Stream): void {
    const i = this.#open.indexOf(s)
    if (i >= 0) this.#open.splice(i, 1)
  }
  closeAll(): void {
    for (const s of [...this.#open]) s.close()
  }
}

export interface LiveRouteDeps {
  readonly deps: TradersDeps
  readonly users: TraderStore
  readonly gate: TradersGate
  readonly streams: LiveStreams
  readonly now: () => number
  /** Tests shorten the clocks. */
  readonly tickMs?: number; readonly pingMs?: number; readonly authMs?: number; readonly baseMs?: number
}

function write(res: ServerResponse, chunk: string): void {
  if (!res.writableEnded && !res.destroyed) res.write(chunk)
}

export function liveRoutes(d: LiveRouteDeps): Route {
  const tickMs = d.tickMs ?? LIVE_TICK_MS
  const pingMs = d.pingMs ?? LIVE_PING_MS
  const authMs = d.authMs ?? LIVE_AUTH_MS
  const baseMs = d.baseMs ?? LIVE_BASE_MS

  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.endpoint.id !== 'books.live') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    const base = await liveBaseOf(d.deps, trader, stock, d.now())
    if (base === null) throw new NotFound(`no open book ${stock}`)
    const user = ctx.principal?.name ?? trader
    stream(ctx.req, ctx.res, user, trader, stock, base)
    return true
  }

  function stream(req: IncomingMessage, res: ServerResponse, user: string, trader: string, stock: string, first: LiveBase): void {
    let base = first
    let baseAt = d.now()
    let last: LiveFrame | null = null
    let lastWrite = d.now()
    let lastAuth = d.now()
    let busy = false
    let ended = false
    const timer = setInterval(() => { void tick() }, tickMs)
    const self: Stream = { user, close }
    if (!d.streams.add(self)) {
      clearInterval(timer)
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'too many live streams; refreshing every 15–60 s instead' }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    write(res, `retry: 3000\n\n`)
    send(liveFrame(base, d.deps.quotes, d.deps.master(), d.now()))
    req.on('close', close)
    res.on('error', close)

    function send(f: LiveFrame): void {
      last = f
      lastWrite = d.now()
      write(res, `event: frame\ndata: ${JSON.stringify(f)}\n\n`)
    }

    function close(): void {
      if (ended) return
      ended = true
      clearInterval(timer)
      d.streams.remove(self)
      if (!res.writableEnded) res.end()
    }

    async function tick(): Promise<void> {
      if (busy || ended) return
      busy = true
      try {
        const now = d.now()
        if (now - lastAuth >= authMs) {
          lastAuth = now
          const p = await d.gate.authenticate(req)
          if (p === null || ended) { close(); return }
        }
        // the legs, trades and rates again on a new upload (the version moved) or every baseMs
        if (now - baseAt >= baseMs || d.deps.legs.version(trader) !== base.version) {
          const next = await liveBaseOf(d.deps, trader, stock, now)
          if (ended) return
          if (next === null) { write(res, `event: gone\ndata: {}\n\n`); close(); return }
          base = next
          baseAt = now
        }
        const f = liveFrame(base, d.deps.quotes, d.deps.master(), now)
        if (!sameFrame(last, f)) send(f)
        else if (now - lastWrite >= pingMs) { lastWrite = now; write(res, `event: ping\ndata: {}\n\n`) }
      } catch {
        // one bad tick is skipped; the next tries again
      } finally {
        busy = false
      }
    }
  }
}
