/**
 * The optionbhai signal feed — the live half of `ExternalSignalMirror`.
 *
 * `ExternalSignalMirrorAdapter` (packages/strategies) already knows how to turn
 * an EXECUTED upstream order into a submission on our own order bus. What it
 * cannot do is talk to optionbhai: it takes a `SignalSource` and an
 * `InstrumentResolver` as injected ports. This file is the only implementation
 * of those two ports, and it is deliberately the ONLY place in the repo that
 * knows optionbhai exists.
 *
 * WHAT IT REPLACES. `archive` / `master:server/slive/candlestrategy.js` and its
 * two siblings (`-a006`, `-test3`) — three files identical apart from a
 * username, a password and a tag. Each was its own pm2 process that booted the
 * whole LoopBack app, logged in, and called `PaperTrade.trackOrder()` directly.
 * Four differences here, each deliberate:
 *
 *  - **The credentials are not in the file.** All three legacy files carry a
 *    plaintext password, and they are in git history — see `.gitignore`'s note
 *    about the four credential sets already leaked this way. `credentialsRef`
 *    on the config names a pair of ENVIRONMENT VARIABLES instead; see
 *    `credentialEnvNames`. Nothing here is ever logged.
 *  - **Orders go through `/v1/desk/submit`.** The legacy files wrote to the
 *    order collection directly, so the strategy switch, the kill switch, the
 *    live allowlist and the journal did not apply to a single mirrored order.
 *    They do now, because this file produces `SignalOrderExecution`s and
 *    something else entirely decides whether they may trade.
 *  - **An unknown symbol is dropped, not guessed.** Legacy did
 *    `trackOrder(ALL_INSTRUMENTS[order.symbol], ...)` with no lookup check, so
 *    a symbol missing from the instruments map placed an order against
 *    `undefined`. The adapter's `onUnknownSymbol: 'drop-and-alert'` is what
 *    that turns into; `bySymbol` returning null is how it gets there.
 *  - **A reconnect cannot leak the previous socket.** Legacy called
 *    `removeAllListeners()` before reopening and that rule is kept verbatim
 *    (`#closeSocket`), plus a generation counter so a close event from a
 *    superseded socket cannot schedule a second reconnect.
 *
 * THE RECONNECT IS A FULL RE-LOGIN, as legacy: the socket is authenticated by
 * a token in its URL, so a dropped socket whose token has since expired can
 * only come back by logging in again. Legacy waited a fixed 5 s every time;
 * between 8 and 10 September that produced ~134,000 `login rejected with HTTP
 * 403` lines against Cloudflare. The wait now BACKS OFF — see `nextRetryMs` —
 * and a 403 cools off for at least ten minutes. The
 * instrument map is NOT rebuilt from a reconnect alone — it is refreshed on its
 * own timer (`instrumentRefreshMinutes`) and replaced only on success, because
 * a refresh that failed must leave the previous map in place. An empty map
 * mirrors nothing, silently.
 */

import { WebSocket } from 'ws'
import type { InstrumentRef, Logger } from '@algomaker/strategy-kit'
import type {
  InstrumentResolver,
  SignalOrderExecution,
  SignalSource,
} from '@algomaker/strategies'
import { hostFetch } from './host-fetch.ts'
import { DEFAULT_BASE_URL, DEFAULT_SOCKET_URL, runnerUserAgent } from './optionbhai-env.ts'

/** The slice of `fetch` this file uses. `globalThis.fetch` and `hostFetch` both satisfy it. */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>

export interface OptionbhaiCredentials {
  readonly username: string
  readonly password: string
}

/**
 * `credentialsRef` -> the two environment variables that hold the credentials.
 *
 * `'optionbhai/1pbuy'` -> `OPTIONBHAI_1PBUY_USER` / `OPTIONBHAI_1PBUY_PASS`.
 * Uppercased, with every non-alphanumeric run collapsed to a single `_`, so the
 * mapping is total and reversible by eye — an operator reading
 * `credentialsRef` on the config knows exactly which two variables to set
 * without consulting a table that could drift.
 *
 * This is what keeps the existing indirection meaningful. The alternative
 * considered and rejected was deleting `credentialsRef` and inlining the two
 * variable names in the config: it would have put the credential's IDENTITY in
 * the same file as its tag, one edit away from someone pasting the value in.
 */
export function credentialEnvNames(credentialsRef: string): { user: string; pass: string } {
  const base = credentialsRef
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return { user: `${base}_USER`, pass: `${base}_PASS` }
}

/**
 * Thrown when a mirror's credentials are absent. It NAMES BOTH VARIABLES.
 *
 * A mirror that cannot log in must not start: it would sit in a reconnect loop
 * reporting nothing useful, and an operator who believes their signals are
 * being mirrored while they are not is worse off than one who can see the
 * mirror never came up. So this is a hard refusal, said once, with the two
 * strings the operator has to act on.
 */
export class MissingMirrorCredentials extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingMirrorCredentials'
  }
}

export function credentialsFromEnv(
  credentialsRef: string,
  env: NodeJS.ProcessEnv = process.env,
): OptionbhaiCredentials {
  const names = credentialEnvNames(credentialsRef)
  const username = env[names.user]
  const password = env[names.pass]
  // Empty is treated as absent: a variable exported as `OPTIONBHAI_A006_PASS=`
  // is a half-finished configuration, and letting it through would produce a
  // login rejection every 5 seconds instead of one clear refusal at boot.
  if (username === undefined || username.trim() === '' || password === undefined || password === '') {
    throw new MissingMirrorCredentials(
      `${credentialsRef}: set ${names.user} and ${names.pass} in the environment ` +
        '(.env.local — never in a file in the repo); this mirror will NOT run until both are present',
    )
  }
  return { username, password }
}

// --------------------------------------------------------------- the socket

/**
 * The socket as this file uses it. Four callbacks and two verbs.
 *
 * A port rather than `ws.WebSocket` directly so the reconnect behaviour can be
 * driven from a test without a server — the failure being guarded against
 * (a leaked socket that keeps delivering into a live handler after a reconnect)
 * is exactly the one that is untestable against a real endpoint.
 */
export interface SignalSocketHandlers {
  onOpen(): void
  onMessage(raw: string): void
  onError(error: unknown): void
  onClose(): void
}

export interface SignalSocket {
  /**
   * Drop every listener. Legacy's `removeAllListeners()`, and the reason it is
   * a first-class verb here: a socket that is closing still delivers events,
   * and a superseded socket that is still wired to the live handler list
   * double-mirrors every order for as long as it takes to finish closing.
   */
  detach(): void
  close(): void
}

/** What the handshake carries besides the URL. `Host` and `User-Agent`, today. */
export interface SignalSocketOptions {
  readonly headers: Readonly<Record<string, string>>
  /** Wall-clock limit on connect + upgrade. Default `HANDSHAKE_TIMEOUT_MS`. */
  readonly handshakeTimeoutMs?: number
}

export const HANDSHAKE_TIMEOUT_MS = 30_000

export type SignalSocketFactory = (
  url: string,
  handlers: SignalSocketHandlers,
  options?: SignalSocketOptions,
) => SignalSocket

/**
 * The real one. `ws` is already a dependency; no native addon is involved.
 *
 * `headers` go on the upgrade request as given — Node's `http.request` only
 * derives `Host` from the URL when the caller has not set one, which is what
 * lets a socket opened to a bare origin IP still name optionbhai's vhost. Over
 * `wss:` the same name goes into SNI (`servername`), or a connection to the
 * IP would be offered the wrong certificate.
 *
 * THE HANDSHAKE HAS A WALL-CLOCK DEADLINE. `ws`'s own `handshakeTimeout` is a
 * socket idle timer, which a blackholed origin (SYNs dropped) outlasts for
 * the kernel's ~2 min of retries; until the socket closes the client cannot
 * schedule its next attempt. Past the deadline the socket is terminated, which
 * `ws` reports as error + close like any failed handshake.
 */
export const wsSignalSocket: SignalSocketFactory = (url, handlers, options) => {
  const timeoutMs = options?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const host = Object.entries(options?.headers ?? {}).find(([k]) => k.toLowerCase() === 'host')?.[1]
  const sni = url.startsWith('wss:') && host !== undefined ? { servername: host.replace(/:\d+$/, '') } : {}
  const socket = new WebSocket(url, {
    headers: { ...(options?.headers ?? {}) },
    handshakeTimeout: timeoutMs,
    ...sni,
  })
  const deadline = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
  }, timeoutMs)
  deadline.unref?.()
  socket.on('open', () => {
    clearTimeout(deadline)
    handlers.onOpen()
  })
  // `RawData` is a Buffer for a text frame under `ws`; optionbhai sends JSON.
  socket.on('message', (data: unknown) => handlers.onMessage(String(data)))
  socket.on('error', (error: unknown) => handlers.onError(error))
  socket.on('close', () => {
    clearTimeout(deadline)
    handlers.onClose()
  })
  return {
    detach: () => {
      clearTimeout(deadline)
      socket.removeAllListeners()
      // A socket terminated mid-handshake still emits 'error' on the next
      // tick; with no listener at all that is an uncaught exception.
      socket.on('error', () => {})
    },
    close: () => {
      // `terminate()` rather than `close()` once the handshake is over or still
      // in flight: `close()` waits for the peer's close frame, and a peer that
      // has already gone away leaves the socket — and the process — held open.
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else socket.terminate()
    },
  }
}

// --------------------------------------------------------------- the retry

/** The first wait, and legacy's fixed one. */
export const RETRY_BASE_MS = 5_000
/** The longest the ordinary backoff ever waits. */
export const RETRY_CAP_MS = 300_000
/** The least a 403 (or 429) waits: the upstream has said no, and asking again soon only deepens the block. */
export const RETRY_FORBIDDEN_MS = 600_000
const JITTER = 0.2

/**
 * How long to wait before the next attempt, given that `attempt` consecutive
 * attempts have already failed before this one (0 = the first failure).
 *
 * 5 s, doubling, capped at 5 min, each +/-20 % so four mirrors that failed
 * together do not retry in lockstep. After an HTTP 403 — Cloudflare's block,
 * the September incident — or a 429, at least 10 min (10-12 min: the jitter
 * only goes upward there, so the floor holds). `random` is `Math.random` in
 * production.
 */
export function nextRetryMs(
  attempt: number,
  lastStatus: number | null,
  random: () => number = Math.random,
): number {
  const r = Math.min(1, Math.max(0, random()))
  const n = Math.max(0, Math.floor(attempt))
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(n, 30))
  const jittered = base * (1 + (r * 2 - 1) * JITTER)
  if (lastStatus === 403 || lastStatus === 429) {
    return Math.round(Math.max(jittered, RETRY_FORBIDDEN_MS * (1 + r * JITTER)))
  }
  return Math.round(jittered)
}

/**
 * A non-2xx answer from optionbhai, with what is needed to diagnose it.
 *
 * `message` is what reaches `status().lastError` and the runtime row, so it is
 * the status ONLY. `cfRay` and `bodyHead` go to one log line per failure burst;
 * `bodyHead` has the credentials and the token cut out before it is truncated.
 */
export class HttpRejected extends Error {
  readonly what: 'login' | 'instruments'
  readonly status: number
  readonly cfRay: string | null
  readonly bodyHead: string
  constructor(what: 'login' | 'instruments', status: number, cfRay: string | null, bodyHead: string) {
    super(
      what === 'login'
        ? `login rejected with HTTP ${status}`
        : `instruments request failed with HTTP ${status}`,
    )
    this.name = 'HttpRejected'
    this.what = what
    this.status = status
    this.cfRay = cfRay
    this.bodyHead = bodyHead
  }
}

const BODY_HEAD_CHARS = 200

/**
 * The first 200 characters of a rejected response, safe to log.
 *
 * A login response can echo what was posted to it, so every secret this
 * client holds — username, password, token — is replaced in each form it
 * could come back in (raw, JSON-escaped, URL-encoded) BEFORE truncating, so a
 * cut can never leave half a password at the end of the line.
 */
export function safeBodyHead(text: string, secrets: readonly (string | null)[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret === null || secret === '') continue
    const forms = new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])
    for (const form of forms) out = out.split(form).join('[redacted]')
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, BODY_HEAD_CHARS)
}

// --------------------------------------------------------------- the client

export interface OptionbhaiClientDeps {
  /** The REGISTRY tag, for log lines only. */
  readonly tag: string
  readonly credentials: OptionbhaiCredentials
  readonly log: Logger
  /** How often the instrument map is rebuilt. `instrumentRefreshMinutes` (15). */
  readonly instrumentRefreshMinutes: number
  /** `OPTIONBHAI_BASE_URL`. Default `https://optionbhai.com`. See `optionbhai-env.ts`. */
  readonly baseUrl?: string
  /** `OPTIONBHAI_SOCKET_URL`. Default `wss://optionbhai.com`. */
  readonly socketUrl?: string
  /**
   * `OPTIONBHAI_HOST_HEADER`. When set, sent as `Host` on every request and on
   * the socket handshake, so a connection to the origin IP reaches the right
   * virtual host. Absent: the URL's own host, as before.
   */
  readonly hostHeader?: string
  /** Sent on every request and the handshake. Default `algomaker-desk-runner/<version>`. */
  readonly userAgent?: string
  /** Injected so the tests never touch the real optionbhai. */
  fetch?: typeof globalThis.fetch
  openSocket?: SignalSocketFactory
  /**
   * A FIXED login-retry and reconnect delay, overriding the backoff. Tests
   * that assert what a reconnect does (not how long it waited) set 0;
   * production leaves it unset and gets `nextRetryMs`.
   */
  readonly retryMs?: number
  /** The jitter source for `nextRetryMs`. Injected so a test can pin the schedule. */
  readonly random?: () => number
  /** Wall clock, for how long a socket stayed open. `Date.now` in production. */
  readonly now?: () => number
}

/**
 * How long a socket must stay open, with no frame, before its close counts as
 * a healthy session ending rather than one more failure. A peer that accepts
 * the upgrade and drops it at once must keep backing off.
 */
export const SOCKET_HEALTHY_MS = 60_000

export interface MirrorSourceStatus {
  readonly connected: boolean
  readonly instruments: number
  /** The last failure, or null. Rendered on the runtime row. Never a token. */
  readonly lastError: string | null
}

/**
 * One logged-in optionbhai session: instruments + a signal socket.
 *
 * ONE PER MIRROR INSTANCE. Three mirrors are three different upstream accounts,
 * and a mirror running on both rails is two sessions — sharing a socket between
 * rails would mean one upstream disconnect silently stopped both, and the
 * per-rail state would have nowhere to live.
 */
export class OptionbhaiClient implements SignalSource, InstrumentResolver {
  readonly #d: OptionbhaiClientDeps
  readonly #handlers: ((msg: SignalOrderExecution) => void)[] = []
  #instruments: ReadonlyMap<string, InstrumentRef> = new Map()
  #socket: SignalSocket | null = null
  /**
   * The live token. PRIVATE AND NEVER LOGGED — legacy printed it on every
   * connect (`console.log('Access token:', token)`), which put a bearer
   * credential into a log file that is rotated, shipped and read by people who
   * have no business holding it.
   */
  #token: string | null = null
  #connected = false
  #lastError: string | null = null
  #stopped = false
  /**
   * Bumped every time a socket is superseded. A close event carrying an old
   * generation is IGNORED, so a socket that finishes closing after its
   * replacement is already open cannot schedule a second reconnect — which
   * would end with two live sockets and every mirrored order placed twice.
   */
  #generation = 0
  #retryTimer: NodeJS.Timeout | null = null
  #refreshTimer: NodeJS.Timeout | null = null
  /** Consecutive failed attempts since the socket was last open. Drives `nextRetryMs`. */
  #failures = 0
  /** The HTTP status of the last failure, or null for a network error or a clean drop. */
  #lastStatus: number | null = null
  /**
   * The status the current failure burst was diagnosed under; undefined when
   * no burst is open. The full diagnostic is logged once per burst (and again
   * only if the status changes within it), never once per attempt.
   */
  #burstStatus: number | undefined = undefined
  /** When the current socket opened; null when it is not open. */
  #openedAt: number | null = null

  constructor(deps: OptionbhaiClientDeps) {
    this.#d = deps
  }

  /**
   * `SignalSource`. Subscribing is independent of the socket's state on
   * purpose: the adapter subscribes once, at start, and stays subscribed across
   * every reconnect. Re-subscribing per socket is how a reconnect would come to
   * double-submit.
   */
  onMessage(handler: (msg: SignalOrderExecution) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const i = this.#handlers.indexOf(handler)
      if (i >= 0) this.#handlers.splice(i, 1)
    }
  }

  /** `InstrumentResolver`. Null means "not in the upstream map" — never a guess. */
  bySymbol(symbol: string): InstrumentRef | null {
    return this.#instruments.get(symbol) ?? null
  }

  status(): MirrorSourceStatus {
    return { connected: this.#connected, instruments: this.#instruments.size, lastError: this.#lastError }
  }

  /**
   * Log in, load the instruments, open the socket.
   *
   * NEVER REJECTS. A failed attempt schedules the next one and resolves, for
   * the same reason `main.ts` boots unconditionally: an optionbhai outage at
   * 09:14 must not take the runner's boot down with it, and a mirror that comes
   * back at 09:20 is worth far more than a process that refused to start.
   * `status().lastError` is how the failure stays visible in the meantime.
   */
  async start(): Promise<void> {
    if (this.#stopped) return
    let phase: 'login' | 'instruments' = 'login'
    try {
      const token = await this.#login()
      // stop() may have landed while the login was in flight. Opening a socket
      // now would leave an upstream session nothing ever closes.
      if (this.#stopped) return
      // The login worked, so whatever status the last failure carried is
      // history: a later refused connect must not inherit a 403's cool-off.
      this.#lastStatus = null
      this.#token = token
      phase = 'instruments'
      const instruments = await this.#fetchInstruments(token)
      if (this.#stopped) return
      this.#instruments = instruments
      this.#d.log.info(`${this.#d.tag}: optionbhai instruments loaded`, {
        symbols: this.#instruments.size,
      })
      this.#openSocket(token)
      this.#armRefresh()
      this.#lastError = null
    } catch (err) {
      if (this.#stopped) return
      this.#lastError = message(err)
      this.#lastStatus = err instanceof HttpRejected ? err.status : null
      const attempt = this.#failures + 1
      const retryMs = this.#scheduleRetry()
      if (err instanceof HttpRejected && this.#burstStatus !== err.status) {
        // ONE diagnostic per burst: enough to tell a Cloudflare block (cf-ray,
        // an HTML challenge page) from a bad password (a JSON error from the
        // origin), without writing the body out again on every attempt.
        this.#burstStatus = err.status
        this.#d.log.error(`${this.#d.tag}: optionbhai ${err.what} rejected`, {
          status: err.status,
          cfRay: err.cfRay,
          bodyHead: err.bodyHead,
          retryMs,
          attempt,
        })
      } else {
        this.#d.log.error(`${this.#d.tag}: optionbhai ${phase} failed, retrying`, {
          error: this.#lastError,
          retryMs,
          attempt,
        })
      }
    }
  }

  /**
   * Stop for good. Idempotent, and it cancels the timers — an unref'd timer
   * still fires if the process is alive, and a mirror switched off in the
   * portal that reconnected 5 seconds later would be a switch that does not
   * switch anything off.
   */
  stop(): void {
    this.#stopped = true
    this.#closeSocket()
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    if (this.#refreshTimer !== null) clearInterval(this.#refreshTimer)
    this.#retryTimer = null
    this.#refreshTimer = null
    this.#handlers.length = 0
    this.#token = null
  }

  // ------------------------------------------------------------- internals

  /**
   * The injected fetch, else `hostFetch` when a `Host` override is configured
   * (Node's own fetch silently replaces a caller's `Host` with the URL's —
   * see `host-fetch.ts`), else the global fetch exactly as before.
   */
  get #fetch(): FetchLike {
    if (this.#d.fetch !== undefined) return this.#d.fetch
    return this.#d.hostHeader === undefined ? globalThis.fetch : hostFetch
  }

  /** `Host` (when configured) and `User-Agent`, for every request and the handshake. */
  get #headers(): Record<string, string> {
    return {
      ...(this.#d.hostHeader === undefined ? {} : { Host: this.#d.hostHeader }),
      'User-Agent': this.#d.userAgent ?? runnerUserAgent(),
    }
  }

  #now(): number {
    return (this.#d.now ?? Date.now)()
  }

  /**
   * A session proved itself healthy: the next drop starts again at 5 s, and
   * the next rejection is diagnosed afresh.
   */
  #endBurst(): void {
    this.#failures = 0
    this.#lastStatus = null
    this.#burstStatus = undefined
  }

  /** Arm the next attempt and return how long it will wait. Counts the failure. */
  #scheduleRetry(): number {
    const delay = this.#d.retryMs ?? nextRetryMs(this.#failures, this.#lastStatus, this.#d.random)
    this.#failures++
    if (this.#stopped) return delay
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.start()
    }, delay)
    // Never hold the process open for a reconnect. Shutdown squares off through
    // the runner; a pending mirror retry must not delay it.
    this.#retryTimer.unref?.()
    return delay
  }

  /** A rejected response as an `HttpRejected`. A body that cannot be read never fails the path. */
  async #rejected(what: 'login' | 'instruments', res: Response, token: string | null): Promise<HttpRejected> {
    let text = ''
    try {
      text = await res.text()
    } catch {
      // The status is the diagnosis that matters; an unreadable body is not one.
    }
    const cfRay = res.headers?.get?.('cf-ray') ?? null
    const head = safeBodyHead(text, [this.#d.credentials.username, this.#d.credentials.password, token])
    return new HttpRejected(what, res.status, cfRay, head)
  }

  #armRefresh(): void {
    if (this.#refreshTimer !== null) return
    const ms = Math.max(1, this.#d.instrumentRefreshMinutes) * 60_000
    this.#refreshTimer = setInterval(() => void this.#refreshInstruments(), ms)
    this.#refreshTimer.unref?.()
  }

  /**
   * Rebuild the instrument map in place.
   *
   * A FAILURE KEEPS THE PREVIOUS MAP. Assigning the result of a failed fetch
   * would empty it, and an empty map makes every mirrored symbol unknown — the
   * mirror would then log "unknown symbol, dropped" for every signal and place
   * nothing, which looks like a quiet market rather than a broken refresh.
   */
  async #refreshInstruments(): Promise<void> {
    const token = this.#token
    if (token === null || this.#stopped) return
    try {
      const next = await this.#fetchInstruments(token)
      this.#instruments = next
      this.#d.log.debug(`${this.#d.tag}: optionbhai instruments refreshed`, { symbols: next.size })
    } catch (err) {
      // Not fatal and NOT a reconnect trigger: the socket is independent of
      // this call, and dropping a healthy signal feed because a side request
      // failed would lose orders the mirror could still have placed. An expired
      // token surfaces as a socket close, which re-logs in.
      this.#d.log.warn(`${this.#d.tag}: optionbhai instrument refresh failed, keeping the previous map`, {
        error: message(err),
        symbols: this.#instruments.size,
      })
    }
  }

  async #login(): Promise<string> {
    const doFetch = this.#fetch
    const res = await doFetch(`${this.#d.baseUrl ?? DEFAULT_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify({
        username: this.#d.credentials.username,
        password: this.#d.credentials.password,
      }),
    })
    // The error MESSAGE is the status only: it is published on the runtime row.
    // The body goes to one log line per burst with the credentials cut out —
    // a login response can echo the request. See `safeBodyHead`.
    if (!res.ok) throw await this.#rejected('login', res, null)
    const body = parseJson(await res.text(), 'login response')
    const token = record(body)?.['token']
    if (typeof token !== 'string' || token === '') {
      throw new Error('login response carried no token')
    }
    return token
  }

  /**
   * `GET /api/instruments` -> tradingsymbol -> `InstrumentRef`.
   *
   * The legacy reduce kept three fields (`tradingsymbol`, `instrument_token`,
   * `lot_size`) out of a richer row. Two more are kept here because the ORDER
   * PATH needs them:
   *
   *  - `lot_size` is mandatory and must be positive. It is the multiplier
   *    between "1 lot" and the quantity that reaches the exchange, and a
   *    fabricated `lotSize: 1` is precisely the C5 synthetic-instrument defect.
   *    A row without one is dropped rather than defaulted.
   *  - `exchange` is mandatory for the same reason and is NEVER inferred from
   *    the symbol: 'NFO' guessed for a SENSEX contract routes to the wrong
   *    exchange, and the symbol prefix cannot tell them apart reliably.
   *
   * `tick_size` falls back to 0.05, which is not a guess but the SAME default
   * `apps/api/src/submit.ts#resolve` already applies — and in practice the
   * bridge prefers its own instrument master over everything sent here anyway,
   * so these fields are the fallback for a contract the master has not synced.
   */
  async #fetchInstruments(token: string): Promise<ReadonlyMap<string, InstrumentRef>> {
    const doFetch = this.#fetch
    const res = await doFetch(`${this.#d.baseUrl ?? DEFAULT_BASE_URL}/api/instruments`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, ...this.#headers },
    })
    if (!res.ok) throw await this.#rejected('instruments', res, token)
    const body = record(parseJson(await res.text(), 'instruments response'))
    const data = body?.['data']
    if (data === null || typeof data !== 'object') throw new Error('instruments response carried no data')

    const map = new Map<string, InstrumentRef>()
    let skipped = 0
    let sample = ''
    // `Object.values` handles both shapes the endpoint has been seen in — an
    // array and a symbol-keyed object — exactly as the legacy reduce did.
    for (const raw of Object.values(data as Record<string, unknown>)) {
      const row = record(raw)
      if (row === null) continue
      const tradingsymbol = str(row['tradingsymbol'])
      const lotSize = num(row['lot_size'])
      const exchange = str(row['exchange'])
      if (tradingsymbol === null || lotSize === null || lotSize <= 0 || exchange === null) {
        skipped++
        if (sample === '') sample = tradingsymbol ?? '(no tradingsymbol)'
        continue
      }
      const instrumentToken = num(row['instrument_token'])
      map.set(tradingsymbol, {
        tradingsymbol,
        lotSize,
        tickSize: num(row['tick_size']) ?? 0.05,
        exchange,
        ...(instrumentToken === null ? {} : { instrumentToken }),
      })
    }
    if (skipped > 0) {
      // Loud, because every skipped row is a symbol this mirror will drop with
      // "unknown symbol" if the upstream ever trades it — and that warning
      // alone would not say why.
      this.#d.log.warn(`${this.#d.tag}: optionbhai rows without a usable lot size or exchange were skipped`, {
        skipped,
        kept: map.size,
        sample,
      })
    }
    if (map.size === 0) throw new Error('instruments response contained no usable contracts')
    return map
  }

  #openSocket(token: string): void {
    // ALWAYS close the previous one first — legacy's `removeAllListeners()`
    // before `new ws(...)`, kept verbatim. See `#closeSocket`.
    this.#closeSocket()
    const generation = this.#generation
    const open = this.#d.openSocket ?? wsSignalSocket
    const url = `${this.#d.socketUrl ?? DEFAULT_SOCKET_URL}/ws?token=${encodeURIComponent(token)}`
    this.#socket = open(url, {
      onOpen: () => {
        if (generation !== this.#generation) return
        this.#connected = true
        this.#lastError = null
        // An OPEN is not yet a recovery: a peer that accepts the upgrade and
        // drops it at once would otherwise loop login + instruments + handshake
        // every 5 s forever. The burst ends on the first frame, or at the close
        // of a socket that stayed up `SOCKET_HEALTHY_MS` — see `#endBurst`.
        this.#openedAt = this.#now()
        // The URL is NOT logged: it carries the token as a query parameter.
        this.#d.log.info(`${this.#d.tag}: optionbhai signal socket open`, {
          symbols: this.#instruments.size,
        })
      },
      onMessage: (raw) => {
        if (generation !== this.#generation) return
        this.#onFrame(raw)
      },
      onError: (error) => {
        if (generation !== this.#generation) return
        // `ws` emits 'error' and then 'close', so the reconnect is driven from
        // the close alone — scheduling one here too would produce two.
        this.#lastError = message(error)
        // `ws` reports a refused upgrade as "Unexpected server response: 403".
        // Kept, so a socket blocked the way the login was cools off the same way.
        const status = /Unexpected server response: (\d{3})/.exec(this.#lastError)?.[1]
        if (status !== undefined) this.#lastStatus = Number(status)
        this.#d.log.warn(`${this.#d.tag}: optionbhai signal socket error`, { error: this.#lastError })
      },
      onClose: () => {
        if (generation !== this.#generation || this.#stopped) return
        this.#connected = false
        const openedAt = this.#openedAt
        this.#openedAt = null
        if (openedAt !== null && this.#now() - openedAt >= SOCKET_HEALTHY_MS) this.#endBurst()
        // `#socket` is deliberately NOT nulled here. The reconnect goes through
        // `#openSocket` -> `#closeSocket`, and that is where the dead socket has
        // its listeners removed — legacy's `removeAllListeners()`. Dropping the
        // reference first would skip that step and leave a socket that is still
        // wired to the live handler list, which is how a reconnect comes to
        // deliver every subsequent order twice.
        //
        // A full re-login, as legacy did: the socket is authenticated by a token
        // in its URL, so a token that expired while we were disconnected can
        // only be replaced by logging in again.
        const retryMs = this.#scheduleRetry()
        this.#d.log.warn(`${this.#d.tag}: optionbhai signal socket closed, reconnecting`, { retryMs })
      },
    }, { headers: this.#headers })
  }

  #closeSocket(): void {
    const socket = this.#socket
    this.#socket = null
    this.#connected = false
    // The replacement socket's age is its own; a superseded one's must not
    // make a handshake failure look like a healthy session ending.
    this.#openedAt = null
    // Bumped even when there is no socket, so an in-flight callback captured
    // from an earlier generation can never be honoured after a stop().
    this.#generation++
    if (socket === null) return
    socket.detach()
    socket.close()
  }

  #onFrame(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // The frame CONTENT is not logged — it is an upstream account's order
      // flow. Legacy let this throw out of the socket handler, which took the
      // whole process down on one malformed frame.
      this.#d.log.warn(`${this.#d.tag}: unparseable signal frame ignored`, { bytes: raw.length })
      return
    }
    const msg = toOrderExecution(parsed)
    if (msg === null) return
    // A frame the mirror can ACT on is proof of a live session, and ends the
    // failure burst. A heartbeat, an error frame or a "session replaced"
    // notice followed by a close is not — a peer that sends one such frame
    // and hangs up every 5 s must keep backing off (review 2026-10-04).
    if (this.#failures > 0) this.#endBurst()
    for (const handler of [...this.#handlers]) {
      try {
        handler(msg)
      } catch (err) {
        // One handler throwing must not stop the others, and must not kill the
        // socket. The adapter's own submit path is async and already contained.
        this.#d.log.error(`${this.#d.tag}: signal handler threw`, { error: message(err) })
      }
    }
  }
}

/**
 * Narrow a decoded frame to the one message shape the mirror acts on.
 *
 * Anything else — a heartbeat, a position update, an ORDER_EXECUTION with a
 * status we do not know — returns null and is dropped here rather than being
 * cast into the union and left for the adapter. A status outside the three
 * known values cannot be `'EXECUTED'`, so dropping it is behaviourally
 * identical to legacy's `order.status == "EXECUTED"` while keeping the type
 * honest about what was actually on the wire.
 */
export function toOrderExecution(parsed: unknown): SignalOrderExecution | null {
  const frame = record(parsed)
  if (frame === null || frame['type'] !== 'ORDER_EXECUTION') return null
  const payload = record(frame['payload'])
  if (payload === null) return null
  const symbol = str(payload['symbol'])
  const side = payload['side']
  const status = payload['status']
  if (symbol === null) return null
  if (side !== 'BUY' && side !== 'SELL') return null
  if (status !== 'EXECUTED' && status !== 'PENDING' && status !== 'REJECTED') return null
  return { type: 'ORDER_EXECUTION', payload: { symbol, side, status } }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // The body is deliberately not included: a login response can echo the
    // credentials that were posted to it.
    throw new Error(`${what} was not JSON`)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
