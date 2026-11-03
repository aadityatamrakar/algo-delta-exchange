/**
 * The routing seam.
 *
 * `server.ts` owns CORS, authentication and dispatch; it owns no endpoints. Each
 * feature area is a `RouteFactory` in its own file under `routes/`, wired once in
 * `main.ts`. The point is not tidiness — it is that a feature can be built,
 * tested and reviewed without editing a file another feature is also editing.
 *
 * A route returns `true` when it handled the request and `false` when the path
 * was not its own. Returning `false` rather than throwing is what lets the
 * dispatcher fall through to the next module and finally to a real 404, instead
 * of every module having to know the whole route table.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from '../store.ts'
import type { DeskStore } from '../store.ts'
import type { BridgeService, MasterProvider, RiskGatePort } from '../service.ts'
import type { QuoteCache } from '../marks.ts'
import type { LiveBookPort } from '../livebook.ts'
import type { VenueSpec } from '@algomaker/venue'

export type Log = (msg: string, ctx?: Record<string, unknown>) => void

/** Who is making the request. Never null inside an authenticated route. */
export interface Principal {
  /** `machine` is a bearer token (the Python desk, our own pm2 processes). */
  readonly kind: 'machine' | 'user'
  readonly name: string
}

export interface RouteCtx {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly url: URL
  readonly path: string
  readonly method: string
  readonly principal: Principal
  readonly log: Log
  /** Parsed request body. Throws `BadRequest` on malformed JSON. */
  readJson(): Promise<unknown>
  send(status: number, body: unknown): void
}

export type Route = (ctx: RouteCtx) => Promise<boolean>

/**
 * The read-only push socket, as a route module sees it. `DeskStream` satisfies
 * it structurally; see `stream.ts` for what is on the other end.
 *
 * `publish` is SYNCHRONOUS, returns void and never throws. That signature is the
 * contract: there is nothing here for an order path to await and nothing for it
 * to fail on, which is what keeps a dashboard notification incapable of costing
 * an order.
 */
export interface StreamPublisher {
  publish(mode: 'paper' | 'live', event: Record<string, unknown>): void
  subscriberCount(mode: 'paper' | 'live'): number
}

/**
 * Everything a route module may be constructed with.
 *
 * One bag rather than per-module dependency lists, so adding a module never
 * changes `main.ts`'s wiring shape. Modules destructure what they need and
 * ignore the rest.
 */
export interface ApiDeps {
  readonly db: Database
  readonly store: DeskStore
  readonly service: BridgeService
  readonly master: MasterProvider
  readonly marks?: QuoteCache
  readonly feedState?: { subscribedTokens: number }
  /**
   * The LAST `md.health` frame marketdata published, and when it arrived here.
   *
   * A MUTABLE HOLDER, not a value: `main.ts` builds this bag once and the bus
   * subscription writes into it for the process's whole life. It is the only
   * evidence this process has that desk-marketdata is alive at all — that
   * process writes no artifact the bridge reads, so its liveness IS the arrival
   * of its own broadcast. See `routes/system.ts`.
   *
   * `receivedAt` is stamped on ARRIVAL rather than taken from the frame's own
   * `ts`, so a marketdata process with a wrong clock cannot report itself
   * fresh — the age measured is the age of the delivery.
   */
  readonly feedHealth?: {
    payload: Record<string, unknown> | null
    receivedAt: number | null
  }
  /**
   * Whether the bus client's socket is open right now.
   *
   * Optional, and ABSENT IS NOT `false`: every test builds `ApiDeps` without a
   * bus, and so does a bridge in the first moments of its life. A reader must
   * render a missing answer as "not observable", never as "disconnected".
   */
  readonly busConnected?: () => boolean
  /**
   * Absent when no push socket is attached — every test builds `ApiDeps`
   * without one, and a bridge with no dashboard connected must behave
   * identically to one with ten.
   */
  readonly stream?: StreamPublisher
  /**
   * The in-memory positions book (`livebook.ts`), when one is attached.
   *
   * OPTIONAL, and every reader must treat `book.ready === false` exactly like an
   * absent book: `/v1/desk/pnl` is the fallback the push design rests on, so it
   * has to answer correctly from Mongo whenever the book cannot. Every existing
   * test builds `ApiDeps` without one, which is the same path a bridge takes for
   * the first seconds of its life.
   */
  readonly book?: LiveBookPort
  /**
   * The desk-wide RISK LIMITS (audit F-28), for the modules that construct an
   * order path of their own — today `routes/submit.ts`.
   *
   * ABSENT MEANS NO GATE: `main.ts` builds one only when at least one
   * `DESK_RISK_*` variable is set, and every test builds this bag without one.
   */
  readonly risk?: RiskGatePort
  /**
   * The venue this bridge trades on. ABSENT IS THE PROCESS VENUE
   * (`DESK_VENUE`, read once in `venue.ts`), which is NSE when unset — every
   * upstream test builds this bag without one.
   */
  readonly venue?: VenueSpec
  readonly log: Log
  now(): number
}

export type RouteFactory = (deps: ApiDeps) => Route

/** A malformed request, not a bug. The dispatcher turns this into a 400. */
export class BadRequest extends Error {}

/**
 * Read the path segment after a fixed prefix, or null when the path is not
 * under that prefix. Hand-rolled rather than a router: the table is small and
 * fixed, and a regex router is one more thing whose behaviour has to be learned.
 */
export function suffixOf(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  if (rest === '') return null
  try {
    return decodeURIComponent(rest)
  } catch {
    /**
     * A MALFORMED ESCAPE IS A BAD REQUEST, NOT A BUG (audit F-53).
     *
     * `decodeURIComponent('%E0%A4%A')` throws `URIError`, and this runs before
     * any handler on every path-with-an-id route in the system — so one typo'd
     * or truncated URL produced a 500 and an internal-error log line on an
     * endpoint that had not been reached yet. `BadRequest` is what the
     * dispatcher renders as `400 {error}`, which is the honest answer: the
     * caller's URL is not decodable, and nothing here went wrong.
     */
    throw new BadRequest(`'${rest}' is not a valid percent-escape in the request path`)
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `?mode=live` or paper. Paper is the default: guessing wrong in that
 *  direction hides a position; guessing wrong the other way moves money. */
export function modeOf(url: URL): 'paper' | 'live' {
  return url.searchParams.get('mode') === 'live' ? 'live' : 'paper'
}

/** A positive integer query param, clamped, so `?limit=abc` cannot page a
 *  collection into memory. */
export function limitOf(url: URL, fallback: number, max = 5000): number {
  const raw = Number(url.searchParams.get('limit') ?? fallback)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), max)
}

/**
 * An IST calendar date, `YYYY-MM-DD`.
 *
 * Every report in this system is keyed by TRADING DAY, which is an IST day. The
 * host may be on UTC — deriving the date from the host's local zone would file a
 * 15:30 IST trade under the previous day whenever the process runs abroad.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

export function istDate(tsMs: number): string {
  return new Date(tsMs + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** Inclusive [start, end) epoch ms for an IST `YYYY-MM-DD`. */
export function istDayRange(date: string): { from: number; to: number } {
  const from = Date.parse(`${date}T00:00:00.000Z`) - IST_OFFSET_MS
  return { from, to: from + 24 * 60 * 60 * 1000 }
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
}
