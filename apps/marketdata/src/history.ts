/**
 * Historical bars, served over HTTP to whoever needs a WARM series.
 *
 * WHY THIS EXISTS. `apps/runner` constructed its `RunnerMarketData` with no
 * `HistoryFetcher`, which made `seed()` a documented no-op: every candle series
 * started COLD and filled only from the live tick stream. `ATR_BAND_NIFTY` wants
 * `atrPeriod` completed HOURLY bars, so on a cold start it logged "not enough
 * hourly candles, retrying in 30s" from 09:15 until 15:30 and traded nothing —
 * every day, not just the first one, because a pm2 restart resets the store.
 * `market-data.ts`'s own header admitted this and named the injection point.
 *
 * WHY IT LIVES HERE AND IS REACHED OVER HTTP. Only this process holds the Kite
 * login, and it holds exactly ONE (that is the whole point of the app). The
 * runner deliberately has no broker credentials — "there is deliberately no way
 * to make this process dangerous on its own" — so it cannot fetch history
 * itself, and giving it a second Kite session to do so would undo the property.
 * A read-only endpoint on the process that already has the session is the small
 * change; a credential in the runner is the large one.
 *
 * READ-ONLY BY CONSTRUCTION. The handler can call exactly one vendor method,
 * `historyData`, which is a GET against Kite's chart endpoint. There is no code
 * path from here to an order.
 *
 * IT NOW CARRIES A SIBLING, for the same reason and under the same bearer:
 * `POST /v1/md/margin-basket` prices a HYPOTHETICAL book against Kite's basket
 * calculator (`book-margin/hypothetical.ts`). Same premise — this process holds
 * the only Kite login, and desk-api opening a second one is the 2026-08-04
 * outage — and the same property: Kite's basket endpoint prices orders, it
 * cannot place them, so there is still no path from this port to an order.
 *
 * `handleMdRequest` is the dispatcher over the two, and it exists so the ONE
 * bearer check is written once. `handleHistoryRequest` keeps its own check as
 * well: it is called directly by its suite, and an endpoint whose authentication
 * depends on which door it was reached through is a hole waiting for the next
 * caller.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Candle, Interval } from '@algomaker/marketdata-core'
import { isKiteAuthFailure } from './kite-auth.ts'
import { MARGIN_BASKET_PATH } from './book-margin/hypothetical.ts'

/** The one method this needs off a `ZerodhaSession`. */
export interface HistorySource {
  historyData(token: number, interval: string, from: string, to: string): Promise<unknown>
}

export interface HistoryQuery {
  readonly token: number
  readonly interval: Interval
  readonly count: number
}

/**
 * Kite's historical interval names. `1minute` is `minute` there and nowhere
 * else, which is exactly the kind of mismatch that returns an empty array
 * rather than an error.
 */
const KITE_INTERVAL: Record<Interval, string> = {
  '1minute': 'minute',
  '3minute': '3minute',
  '5minute': '5minute',
  '15minute': '15minute',
  '60minute': '60minute',
  day: 'day',
}

/**
 * Completed bars an NSE session yields per interval. 09:15-15:30 is 375
 * minutes, so the hourly series is 7 bars (the last one short).
 *
 * Used only to turn "give me N bars" into a date range. Over-fetching is
 * harmless (the store keeps what it is given); under-fetching is not, because a
 * strategy short of one bar retries all day.
 */
const BARS_PER_SESSION: Record<Interval, number> = {
  '1minute': 375,
  '3minute': 125,
  '5minute': 75,
  '15minute': 25,
  '60minute': 7,
  day: 1,
}

/**
 * Kite's per-request span limit per interval, in calendar days. Asking for more
 * returns an error rather than a truncated answer, so the window is clamped.
 */
const MAX_SPAN_DAYS: Record<Interval, number> = {
  '1minute': 60,
  '3minute': 100,
  '5minute': 100,
  '15minute': 200,
  '60minute': 400,
  day: 2000,
}

/** A finite number, or null. Never a coercion — see `toCandles`. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function isInterval(v: string): v is Interval {
  return Object.prototype.hasOwnProperty.call(KITE_INTERVAL, v)
}

/** 'YYYY-MM-DD' in IST — the timezone every Kite date parameter is in. */
export function istDate(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10)
}

/**
 * The date range that will contain at least `count` completed bars.
 *
 * SESSIONS, NOT DAYS. Five trading sessions live in seven calendar days, and
 * exchange holidays eat more, so the session count is inflated by 7/5 and then
 * given a fixed cushion. A window that is too short is the failure mode that
 * matters: it returns fewer bars than asked for, the strategy decides it has
 * "no data yet", and retries — which is precisely the symptom this whole file
 * exists to remove.
 */
export function historyWindow(
  interval: Interval,
  count: number,
  nowMs: number,
): { from: string; to: string } {
  const perSession = BARS_PER_SESSION[interval]
  const sessions = Math.max(1, Math.ceil(count / perSession))
  const days = Math.min(MAX_SPAN_DAYS[interval], Math.ceil(sessions * 1.4) + 7)
  return { from: istDate(nowMs - days * 86_400_000), to: istDate(nowMs) }
}

/**
 * Kite bar timestamps are `2026-07-24T09:15:00+0530` — an offset with no colon,
 * which is outside the ISO form `Date.parse` is REQUIRED to accept. V8 happens
 * to take it; a colon is spliced in when it does not, because falling back to
 * `NaN` here would seed the candle store with bars at epoch 0 and every
 * indicator built on them would be silently wrong rather than absent.
 */
export function parseBarTs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return null
  const direct = Date.parse(raw)
  if (Number.isFinite(direct)) return direct
  const withColon = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const retry = Date.parse(withColon)
  return Number.isFinite(retry) ? retry : null
}

/**
 * Map the vendor's rows onto `Candle`.
 *
 * A row missing any OHLC value is DROPPED, not defaulted to 0: a zero low turns
 * an ATR into a number several thousand points wide and a breakout band with it.
 */
export function toCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const row of raw as readonly Record<string, unknown>[]) {
    if (row === null || typeof row !== 'object') continue
    const ts = parseBarTs(row['ts'])
    if (ts === null) continue
    // Type-checked, not coerced: `Number(null)` is 0 and so is `Number('')`, so
    // a null low would pass a `Number.isFinite` test on its coercion and look
    // like a perfectly ordinary bar.
    const values = (['open', 'high', 'low', 'close'] as const).map((k) => num(row[k]))
    if (values.some((v) => v === null)) continue
    const [open, high, low, close] = values as [number, number, number, number]
    const volume = num(row['vol']) ?? num(row['volume'])
    out.push({
      ts,
      open,
      high,
      low,
      close,
      ...(volume === null ? {} : { volume }),
    })
  }
  // Oldest -> newest, the order `CandleStore.seed` and every indicator assume.
  out.sort((a, b) => a.ts - b.ts)
  return out
}

/**
 * Fetch and normalise. Returns AT MOST `count` bars, newest-aligned, so a
 * caller asking for 15 hourly bars is not handed 400 of them to hold.
 */
export async function fetchHistory(
  source: HistorySource,
  query: HistoryQuery,
  nowMs: number,
): Promise<readonly Candle[]> {
  const { from, to } = historyWindow(query.interval, query.count, nowMs)
  const raw = await source.historyData(query.token, KITE_INTERVAL[query.interval], from, to)
  const candles = toCandles(raw)
  return candles.length > query.count ? candles.slice(candles.length - query.count) : candles
}

/**
 * Parse `/v1/md/history?token=..&interval=..&count=..`.
 *
 * Every field is validated rather than coerced. `Number('abc')` is NaN, and a
 * NaN token reaches Kite as the literal string `NaN` — a 400 from the broker
 * for what is really our own bad request.
 */
export function parseHistoryQuery(url: string): HistoryQuery | { error: string } {
  const parsed = new URL(url, 'http://localhost')
  const token = Number(parsed.searchParams.get('token'))
  const interval = parsed.searchParams.get('interval') ?? ''
  const countRaw = parsed.searchParams.get('count')
  const count = countRaw === null ? 200 : Number(countRaw)
  if (!Number.isInteger(token) || token <= 0) return { error: 'token must be a positive integer' }
  if (!isInterval(interval)) {
    return { error: `interval must be one of ${Object.keys(KITE_INTERVAL).join(', ')}` }
  }
  if (!Number.isInteger(count) || count <= 0 || count > 2000) {
    return { error: 'count must be an integer between 1 and 2000' }
  }
  return { token, interval, count }
}

export const HISTORY_PATH = '/v1/md/history'

/**
 * The vendored client REJECTS WITH THE RAW REPLY BODY, not an Error — see
 * `historyData`'s `reject(body)` — so `String(err)` on a token rejection is
 * the literal `[object Object]` and the 502 says nothing at all. Everything
 * below reads the object.
 */
export function describeHistoryError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    const body = err as Record<string, unknown>
    const message = typeof body['message'] === 'string' ? body['message'] : ''
    const kind = typeof body['error_type'] === 'string' ? body['error_type'] : ''
    if (message !== '' || kind !== '') return [kind, message].filter((s) => s !== '').join(': ')
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/**
 * Has Kite rejected the SESSION, as opposed to failing for any other reason?
 *
 * Literally the same question `book-margin/kite.ts` asks — it decides whether a
 * real password+TOTP login is spent — so it is now literally the same answer:
 * both delegate to `isKiteAuthFailure`. Only the SHAPE differs here, because
 * the vendored client rejects with the parsed body rather than a response, and
 * `describeHistoryError` is what flattens that into something to match on.
 *
 * WHAT THE LOCAL MATCHER USED TO MISS (and this file's callers with it): the
 * regex here knew `TokenException` and the exact "Incorrect api_key or
 * access_token" string and nothing else, so `SessionException: Invalid session
 * token` and the login PAGE a web host answers a dead session with — the other
 * documented wordings of the 2026-08-05 outage — were logged as "not a token
 * rejection" and dropped. The enctoken canary classifies through this function,
 * so the guardrail built for that outage could not see most of it.
 *
 * NO STATUS IS AVAILABLE HERE, which is why the shared classifier treats status
 * as optional: the vendored client throws the body away from its response.
 */
export function isHistoryTokenRejection(err: unknown): boolean {
  return isKiteAuthFailure({ body: describeHistoryError(err) })
}

export interface HistoryServerDeps {
  readonly port: number
  /** `DESK_API_TOKEN`. The runner authenticates as the same machine principal. */
  readonly token: string
  /** Null until the Kite login has completed, so boot order cannot 500 on itself. */
  source(): HistorySource | null
  /**
   * Kite rejected the enctoken: re-login and rotate it, then this retries once.
   * Resolves TRUE only if the token actually rotated.
   *
   * THE SECOND REST CONSUMER OF THE ENCTOKEN, and it has the same blind spot
   * the margin path had before 2026-08-05: an established websocket survives
   * its token being invalidated, so the feed stays up, `FeedRecovery` never
   * fires, and this endpoint 502s all session. The cost lands on the runner —
   * `seed()` returns nothing, and an ATR strategy logs "not enough hourly
   * candles" from 09:15 to 15:30 and trades nothing, which is the exact
   * failure this file's header says the endpoint exists to remove.
   *
   * The margin sweep cannot cover for it: it runs only for LIVE books, only on
   * a SPAN slot or a leg change, so a desk holding nothing exercises the token
   * nowhere else.
   */
  onAuthFailure?(): Promise<boolean>
  /** A history call succeeded on the token held: the REST session is proven live. */
  onTokenAccepted?(): void
  /**
   * Price a HYPOTHETICAL book against Kite's basket calculator — the parsed
   * request body in, `{status, body}` out. See `book-margin/hypothetical.ts`.
   *
   * OPTIONAL, and absent is a 501 rather than a zero. A process wired without
   * a Kite margin client genuinely cannot answer, and answering 0 would read on
   * the verify screen as "this plan is free to hold".
   */
  marginBasket?(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  readonly now?: () => number
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

/**
 * The request half, separated from the socket so it is testable with two plain
 * objects. Returns the status and body rather than writing them.
 */
export async function handleHistoryRequest(
  deps: HistoryServerDeps,
  req: { method?: string | undefined; url?: string | undefined; authorization?: string | undefined },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
  const url = req.url ?? ''
  if (!url.startsWith(HISTORY_PATH)) return { status: 404, body: { error: 'not found' } }
  // Same bearer the bridge uses. History is not a secret, but an unauthenticated
  // endpoint on the process holding the Kite session is a free rate-limit
  // exhaustion — and Kite throttles the whole login, so an outsider hammering
  // this would stop the DESK fetching its own history.
  if (req.authorization !== `Bearer ${deps.token}`) {
    return { status: 401, body: { error: 'unauthorized' } }
  }
  const query = parseHistoryQuery(url)
  if ('error' in query) return { status: 400, body: { error: query.error } }

  const source = deps.source()
  if (source === null) {
    // 503, not 500: the login simply has not finished. The caller retries on its
    // own schedule and the series stays cold for one cycle rather than the day.
    return { status: 503, body: { error: 'the market-data login is not ready yet' } }
  }
  const now = deps.now ?? Date.now
  try {
    const candles = await fetchHistory(source, query, now())
    deps.onTokenAccepted?.()
    return { status: 200, body: { candles } }
  } catch (err) {
    const error = describeHistoryError(err)
    deps.log?.('history fetch failed', { token: query.token, interval: query.interval, error })

    if (deps.onAuthFailure !== undefined && isHistoryTokenRejection(err)) {
      /**
       * Rotate the token and try ONCE more, exactly as the margin path does —
       * and only if it really rotated, since a gated or failed recovery leaves
       * the same dead token in place.
       *
       * `deps.source()` is re-read rather than reusing `source`: the login
       * replaces the whole session object, and retrying through the old one
       * would re-send the token that was just rejected.
       */
      const rotated = await deps.onAuthFailure()
      const fresh = rotated ? deps.source() : null
      if (fresh !== null) {
        try {
          const candles = await fetchHistory(fresh, query, now())
          deps.onTokenAccepted?.()
          deps.log?.('history fetch recovered after a fresh login', { token: query.token })
          return { status: 200, body: { candles } }
        } catch (retryErr) {
          const retryError = describeHistoryError(retryErr)
          deps.log?.('history fetch failed again after a fresh login', {
            token: query.token,
            error: retryError,
          })
          return { status: 502, body: { error: `${retryError} (after re-login)` } }
        }
      }
    }

    // 502: the failure is upstream at Kite. Saying so lets the caller log
    // "history unavailable" instead of "the market-data service is broken".
    return { status: 502, body: { error } }
  }
}

/**
 * The :8892 port's whole route table: history, and the hypothetical basket.
 *
 * Dispatched on PATH FIRST so a POST to the margin route is not met by
 * `handleHistoryRequest`'s blanket 405, and so a GET on the margin path answers
 * 405 rather than falling through to a 404 that says the endpoint is not there.
 *
 * The bearer is checked here for the margin route and AGAIN inside the history
 * handler. That duplication is deliberate: the history handler is reached
 * directly by its own suite and by any future caller, and an endpoint that is
 * only authenticated by its dispatcher is one refactor away from being open.
 */
export async function handleMdRequest(
  deps: HistoryServerDeps,
  req: {
    method?: string | undefined
    url?: string | undefined
    authorization?: string | undefined
    /**
     * The RAW bytes of a POST body — deliberately not parsed by the caller.
     *
     * `JSON.parse` is a real amount of work on attacker-chosen input, and this
     * port binds every interface. Handing the dispatcher the bytes is what lets
     * the bearer be checked BEFORE anything is parsed; a caller that parsed
     * first would have spent that work on a request it was about to refuse.
     */
    body?: string | Buffer
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = req.url ?? ''
  if (url.split('?')[0] === MARGIN_BASKET_PATH) {
    if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }
    // FIRST, and before the body is even looked at: this endpoint spends the
    // desk's own rate limit at a broker that throttles the whole login, so an
    // outsider must not be able to make it call out — or parse — at all.
    if (req.authorization !== `Bearer ${deps.token}`) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    if (deps.marginBasket === undefined) {
      return { status: 501, body: { error: 'this market-data process serves no basket margin' } }
    }
    const raw = req.body
    const text = raw === undefined ? '' : typeof raw === 'string' ? raw : raw.toString('utf8')
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      // Only an AUTHENTICATED caller can reach this. A malformed body is their
      // bug, not ours, and it is a 400 rather than the 500 an escaping
      // SyntaxError would have produced.
      return { status: 400, body: { error: 'body is not valid JSON' } }
    }
    return deps.marginBasket(parsed)
  }
  return handleHistoryRequest(deps, {
    method: req.method,
    url: req.url,
    ...(req.authorization === undefined ? {} : { authorization: req.authorization }),
  })
}

/**
 * The largest body this port will read.
 *
 * `server.listen(deps.port)` binds EVERY interface, so whatever an
 * unauthenticated sender can make this process do, it can make it do from
 * anywhere the box is reachable. Exactly one thing happens before the bearer is
 * checked — bytes are read into a buffer — and this cap is what bounds it. A
 * basket is a few dozen legs, so 256KB is orders of magnitude more than any
 * honest request and far too little to be worth streaming at.
 *
 * NOTHING IS PARSED, RESOLVED OR SENT TO KITE UNTIL THE BEARER IS CHECKED, and
 * that is now literally true rather than nearly: `readBody` returns the raw
 * buffer and `handleMdRequest` parses it AFTER the 401 gate. Parsing here — as
 * this did until the review — spent attacker-chosen `JSON.parse` work on
 * requests that were about to be refused, in the process holding the desk's
 * entire market data feed.
 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * The RAW body. Deliberately no parsing — see `MAX_BODY_BYTES`.
 *
 * The size cap is the one refusal that cannot be deferred behind the bearer:
 * refusing to read is the only way to bound the read.
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export function createHistoryServer(deps: HistoryServerDeps): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const auth = req.headers.authorization
      let body: Buffer | undefined
      if (req.method === 'POST') {
        try {
          body = await readBody(req)
        } catch {
          // 413, and the ONE answer that precedes the bearer check: the cap is
          // what bounds the read, so it has to refuse before there is anything
          // to authenticate against. It leaks nothing — an unauthenticated
          // sender learns only that this port has a size limit.
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'request body is too large' }))
          return
        }
      }
      const out = await handleMdRequest(deps, {
        method: req.method,
        url: req.url,
        authorization: auth,
        ...(body === undefined ? {} : { body }),
      })
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.body))
    })().catch((err: unknown) => {
      deps.log?.('history request threw', { error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal error' }))
    })
  })
  server.listen(deps.port)
  return server
}
