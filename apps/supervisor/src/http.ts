/**
 * THE SUPERVISOR'S TWO-ENDPOINT SERVER: "something you read is stale" and "are
 * you alive?".
 *
 * ── WHY A SERVER AT ALL, WHEN EVERYTHING IS POLLED ──────────────────────────
 * Every read this process makes has a poll behind it — the registry every 5 s,
 * the in-flight decision every 1 s — so nothing here is load bearing for
 * CORRECTNESS. It is load bearing for LATENCY, and the difference matters per
 * kind. A dial change that takes five minutes to land is a risk control the
 * operator believes is in force and is not (F-29). A fill that takes a second to
 * be noticed is a package the book thinks is still working. Production Mongo is
 * a standalone, so there are no change streams to watch and none may be depended
 * on; one HTTP call at the point of the write is the whole mechanism, exactly as
 * `apps/order-gateway/src/notify.ts` reaches desk-api.
 *
 * ── THE NUDGE CARRIES NO INSTRUCTIONS ───────────────────────────────────────
 * `kind` names which of THIS process's own reads went stale and the payload
 * narrows it to a book. Nothing in the body is a decision input: the truth is
 * re-read from Mongo, always. A supervisor that took a number out of an HTTP body
 * desk-api composed would be able to disagree with desk-api about a book without
 * either of them being wrong — which is the class of defect this whole migration
 * exists to end. `engine-notify.ts` says the same thing from the other side.
 *
 * ── LOOPBACK, AND A TOKEN WHEN THERE IS ONE ─────────────────────────────────
 * Bound to 127.0.0.1: the only callers are desk-api and an operator's `curl` on
 * the same box, and a nudge port reachable from the network is a way to make a
 * trading process re-read its books on somebody else's schedule. The bearer is
 * `DESK_API_TOKEN`, the machine credential every sibling already holds; a
 * deployment with none configured accepts unauthenticated nudges, which is
 * degraded rather than dangerous for an endpoint that takes no instructions.
 *
 * A REJECTED NUDGE IS LOGGED AT ERROR, and that is deliberate. The failure it
 * describes — desk-api holding a different token from the supervisor — presents
 * as "dial changes take five minutes sometimes", which nobody reports and nobody
 * finds. It has to say so itself.
 *
 * ── /health IS FOR THE HUMAN AND FOR desk-api'S STRIP ────────────────────────
 * `{books, lease, feedAgeMs}` answers the three questions that distinguish a
 * supervisor that is steering from one that is merely running: what it holds,
 * whether it holds the lease at all (a standby answers `null` and is CORRECT to),
 * and how long since the feed last said anything. It is unauthenticated: it
 * carries no book contents and refusing it would make the one thing an operator
 * reaches for at 09:20 the thing that needs a token.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { NUDGE_PATH, type NudgeKind } from '../../api/src/engine-notify.ts'
import type { HostLog } from './engine-host.ts'
import { Throttle } from './throttle.ts'

/**
 * desk-api's OWN path constant, imported rather than restated.
 *
 * The caller composes the URL from it (`engine-notify.ts`) and this server
 * routes on it; two copies agree today and drift the first time one moves —
 * silently, because a nudge that 404s is swallowed by design and presents as
 * "dial changes are sometimes slow". The cross-app import is the house pattern.
 */
export { NUDGE_PATH }
export const HEALTH_PATH = '/health'

/** What `/health` answers. Shapes the strip desk-api renders. */
export interface SupervisorHealth {
  /** `${tag}:${mode}` for every book being steered. */
  readonly books: ReadonlyArray<string>
  /** The lease owner id we hold, or null — a STANDBY answers null. */
  readonly lease: string | null
  /** Since the last tick this process admitted. `null` = nothing yet. */
  readonly feedAgeMs: number | null
}

export interface NudgeServerDeps {
  readonly port: number
  /** Loopback unless a test asks otherwise. Never a public interface. */
  readonly host?: string
  /** `''` accepts unauthenticated nudges — see the header. */
  readonly token: string
  /**
   * A nudge arrived. Fire-and-forget by contract: the caller has a 1 s timeout
   * and the work this triggers (a registry pass, a poll) can outlive it.
   */
  onNudge(kind: NudgeKind, body: Record<string, unknown>): void
  health(): SupervisorHealth
  readonly log: HostLog
}

const KINDS: ReadonlySet<string> = new Set<NudgeKind>(['dials', 'fill', 'registry'])

/** The body, bounded. A nudge is three short fields; anything else is not one. */
const MAX_BODY = 4096

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) throw new Error('nudge body too large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

export interface NudgeServer {
  /** The port actually bound — `0` in a test becomes a real one. */
  readonly port: number
  listen(): Promise<number>
  close(): Promise<void>
}

export function createNudgeServer(deps: NudgeServerDeps): NudgeServer {
  let bound = deps.port
  /** The bad-token ERROR, once a minute with the count. One per server. */
  const badToken = new Throttle()

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(text)
  }

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const path = (req.url ?? '').split('?')[0] ?? ''

      if (req.method === 'GET' && path === HEALTH_PATH) {
        send(res, 200, deps.health())
        return
      }

      if (req.method !== 'POST' || path !== NUDGE_PATH) {
        send(res, 404, { error: 'the supervisor serves POST /nudge and GET /health' })
        return
      }

      if (deps.token !== '') {
        const auth = req.headers['authorization'] ?? ''
        if (auth !== `Bearer ${deps.token}`) {
          // LOUD, ONCE A MINUTE. See the header: this failure presents as
          // latency, not as an error, and nobody ever reports it — but a
          // token mis-set on one of the two processes fails EVERY nudge
          // desk-api sends (every dial write, every fill), and one line per
          // refusal is a page of the same line within minutes. The count says
          // it never cleared; the remote address says who was knocking.
          const suppressed = badToken.claim(Date.now())
          if (suppressed !== null) {
            deps.log.error(
              'a nudge was REFUSED for a bad token — dial and registry changes will land at the ' +
                'next 5-second poll instead of at once. Check DESK_API_TOKEN on both processes.',
              { remote: req.socket.remoteAddress ?? '', suppressed },
            )
          }
          send(res, 401, { error: 'unauthorised' })
          return
        }
      }

      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : 'unreadable body' })
        return
      }

      const kind = body['kind']
      if (typeof kind !== 'string' || !KINDS.has(kind)) {
        send(res, 400, { error: `kind must be one of ${[...KINDS].join(', ')}` })
        return
      }

      // ANSWERED BEFORE THE WORK. The caller holds an operator's request open
      // for as long as this takes and its own timeout is 1 s; the re-read it
      // asks for is a Mongo round trip plus an evaluation.
      send(res, 202, { accepted: true, kind })
      deps.onNudge(kind as NudgeKind, body)
    })().catch((err: unknown) => {
      deps.log.warn('nudge handler failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      if (!res.headersSent) send(res, 500, { error: 'nudge failed' })
    })
  })

  return {
    get port(): number {
      return bound
    },
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(deps.port, deps.host ?? '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const addr = server.address()
      if (addr !== null && typeof addr === 'object') bound = addr.port
      // The server must NEVER be the reason this process stays alive: pm2 stops
      // it by signal, and a held socket would turn a stop into a kill.
      server.unref()
      return bound
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        // Sockets kept alive by a client that has not closed would otherwise
        // hold `close()` open past the shutdown fuse.
        server.closeAllConnections?.()
      })
    },
  }
}
