/**
 * XTS Interactive transport — direct REST, no SDK.
 *
 * Implements `XtsClient` with plain `fetch` against the documented endpoints
 * (developers.symphonyfintech.in/doc/interactive). Deliberately not the
 * `xts-interactive-api` package: an owner decision, and it also means the wire
 * format is visible here rather than behind a wrapper whose version we would
 * have to track.
 *
 * ENDPOINTS (all under `<base><prefix>`, prefix defaulting to `/interactive`):
 *   POST   /user/session               login    -> token
 *   POST   /orders                     place    -> AppOrderID
 *   PUT    /orders                     modify
 *   DELETE /orders?appOrderID=         cancel
 *   GET    /orders                     order book      (investor)
 *   GET    /orders/dealerorderbook     order book      (DEALER)
 *   GET    /portfolio/positions        positions       (investor)
 *   GET    /portfolio/dealerpositions  positions       (DEALER)
 *
 * The two dealer paths are verbatim from the vendored SDK's own route table
 * (`xts-interactive-api/lib/config/app/settings.json`), which is also where the
 * legacy account model got them. That SDK has NO dealer trade-book route and the
 * legacy code never read a trade book at all, so none is implemented here.
 *
 * Auth is the session token in a bare `Authorization` header — no `Bearer`
 * prefix, which is unusual enough to be worth stating.
 *
 * THREE THINGS THE DOCS DO NOT COVER, taken from the working production login
 * in `common/models/xts-account.js` (read for its knowledge, not its code):
 *
 *  - `uniqueKey` is part of the login payload for brokers that issue one, and
 *    is omitted entirely for those that do not — sending an empty one fails.
 *  - Some deployments require a HOST LOOKUP first, which returns the real
 *    `connectionString` to talk to and the `uniqueKey` to use. The configured
 *    base URL is only the lookup host in that case.
 *  - A token can be REUSED across process restarts. Production stores it and
 *    re-logs in only on `e-session-*` / `e-token-*`, because logging in afresh
 *    every boot invalidates the session a sibling process is holding.
 *
 * Every method returns the raw `{type, result, description}` envelope so
 * `XtsAdapter` can classify failures itself. Nothing is thrown for a broker-level
 * error: a rejection is data, and turning it into an exception would lose the
 * `description` that says why.
 */

import type { XtsClient, XtsOrderRequest, XtsResponse } from './xts.ts'

export interface XtsRestOptions {
  /** Broker host, e.g. `https://xts.compositedge.com`. No trailing slash. */
  readonly baseUrl: string
  readonly appKey: string
  readonly secretKey: string
  /** Issued by some brokers; omitted from the payload entirely when absent. */
  readonly uniqueKey?: string
  /** `WEBAPI` for most deployments. */
  readonly source?: string
  /**
   * Host-lookup endpoint. When set, the client calls it first and uses the
   * returned `connectionString` as its base — the configured `baseUrl` is then
   * only where the lookup lives.
   */
  readonly hostLookupUrl?: string
  /**
   * A previously issued token. Reused as-is, with NO login call, so a restart
   * does not invalidate the session a sibling process is using. Discarded
   * automatically when the broker reports it expired.
   */
  readonly existingToken?: string
  /**
   * The userID and clientCodes that came with `existingToken`'s login.
   *
   * A reused token skips `login()`, and without these the client knows no
   * codes at all: `clientCodes` is empty, `isInvestorClient` defaults to
   * investor, and an order goes out with an EMPTY clientID — the 2026-08-04
   * boot state where a dealer account read investor endpoints and could not
   * have placed a valid order. Whoever persists the token persists these
   * beside it (see `onToken`).
   */
  readonly existingUserID?: string
  readonly existingClientCodes?: readonly string[]
  /**
   * Called whenever a new token is issued, so it can be persisted.
   *
   * `clientCodes` is what the LOGIN returned (no override applied) — persist it
   * beside the token and hand it back as `existingClientCodes` on reuse.
   */
  readonly onToken?: (token: string, userID: string, clientCodes: readonly string[]) => void
  /**
   * The account code every order is sent for. AN OVERRIDE, NOT A FALLBACK.
   *
   * Without it the code is whatever the login returned (`result.clientCodes[0]`,
   * falling back to `userID`) and there was no way to set it at all. On a DEALER
   * account the login response need not carry the right code, and an order sent
   * under the wrong `clientID` is rejected — or routed to somebody else's
   * account. Because it overrides rather than fills a gap, the value in the
   * config is the value that went out on the wire, which is what makes a
   * mis-routed order diagnosable at all.
   *
   * `XTS_CLIENT_ID` in the gateway; `meta.clientId` in the broker store (it is an
   * account identifier, not a secret).
   */
  readonly clientId?: string
  /**
   * Investor vs DEALER account, which selects DIFFERENT ENDPOINTS for the order
   * book and positions. Derived from `clientId` when not set — see
   * `isInvestorClient`.
   */
  readonly investorClient?: boolean
  /**
   * Path prefix. Brokers deploy XTS behind different mounts — the public docs
   * host serves `/1interactive`, most live deployments `/interactive`.
   */
  readonly prefix?: string
  readonly timeoutMs?: number
  /** Injected for tests, so the wire format is verifiable without a broker. */
  readonly fetchImpl?: typeof fetch
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface XtsLoginResult {
  readonly token: string
  readonly userID: string
  readonly clientCodes: readonly string[]
}

export class XtsRestClient implements XtsClient {
  readonly #o: XtsRestOptions
  readonly #fetch: typeof fetch
  #token = ''
  /** What the LOGIN said. `clientCodes` may override it; this never changes. */
  #loginClientCodes: string[] = []
  #userID = ''

  #baseUrl: string
  #uniqueKey: string | undefined

  constructor(opts: XtsRestOptions) {
    this.#o = opts
    this.#fetch = opts.fetchImpl ?? fetch
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.#uniqueKey = opts.uniqueKey
    if (opts.existingToken !== undefined && opts.existingToken !== '') {
      this.#token = opts.existingToken
      this.#userID = opts.existingUserID ?? ''
      this.#loginClientCodes = [...(opts.existingClientCodes ?? [])]
    }
  }

  get hasToken(): boolean {
    return this.#token !== ''
  }

  /**
   * The client code every request is made under.
   *
   * The configured one WINS. A dealer whose login returns nothing usable would
   * otherwise have no way to correct it, and a fallback ("use the config only
   * when the login gave us nothing") is untestable from the outside: you cannot
   * tell by reading the config which code the order actually went out with.
   */
  get clientCodes(): readonly string[] {
    const override = (this.#o.clientId ?? '').trim()
    return override === '' ? this.#loginClientCodes : [override]
  }

  /** What the login itself reported, regardless of any override. For diagnostics. */
  get loginClientCodes(): readonly string[] {
    return this.#loginClientCodes
  }

  get userID(): string {
    return this.#userID
  }

  /**
   * Investor account, or DEALER?
   *
   * Derived exactly as `common/models/xts-account.js:70-74` derives it, because
   * that is the rule the live account has been running under for years:
   *
   *   clientCode === '*****'      -> DEALER
   *   clientCode === username     -> investor
   *   otherwise                   -> DEALER
   *   no clientCode configured    -> investor
   *
   * The `'*****'` literal is the operator's own dealer client code, compared as
   * a literal there and here.
   *
   * It matters because a dealer account must call `/orders/dealerorderbook` and
   * `/portfolio/dealerpositions`; the investor routes return the wrong data or
   * none for it. Getting this wrong is how an order fills at the broker while
   * the gateway's reconciliation never sees it.
   */
  get isInvestorClient(): boolean {
    if (this.#o.investorClient !== undefined) return this.#o.investorClient
    // The EFFECTIVE code — configured override, else what the login returned.
    // Keying on the configured value alone made "no override" mean "investor"
    // even when the login said the account trades as PRO111: the 2026-08-04
    // failure where every book read answered "This APi is not Available for
    // dealer" while orders went out fine.
    const code = (this.clientCodes[0] ?? '').trim()
    if (code === '') return true
    if (code === '*****') return false
    return code === this.#userID
  }

  get token(): string {
    return this.#token
  }

  #url(path: string): string {
    const prefix = this.#o.prefix ?? '/interactive'
    return `${this.#baseUrl}${prefix}${path}`
  }

  /**
   * Resolve the real endpoint and uniqueKey, when the broker requires it.
   *
   * No-op unless `hostLookupUrl` is configured, so deployments that talk
   * directly to their host pay nothing for it.
   */
  async hostLookup(): Promise<void> {
    const url = this.#o.hostLookupUrl
    if (url === undefined || url === '') return
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accesspassword: 'OpenAPI@123', versionName: 'v1' }),
    })
    const body = (await res.json()) as {
      result?: { connectionString?: string; uniqueKey?: string }
      connectionString?: string
      uniqueKey?: string
    }
    const conn = body.result?.connectionString ?? body.connectionString
    const uk = body.result?.uniqueKey ?? body.uniqueKey
    if (typeof conn === 'string' && conn !== '') this.#baseUrl = conn.replace(/\/$/, '')
    if (typeof uk === 'string' && uk !== '') this.#uniqueKey = uk
    this.#o.log?.('XTS host lookup', { baseUrl: this.#baseUrl, uniqueKey: uk !== undefined })
  }

  async #call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<XtsResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#o.timeoutMs ?? 15_000)
    try {
      const res = await this.#fetch(this.#url(path), {
        method,
        headers: {
          'content-type': 'application/json',
          // Bare token, NOT `Bearer <token>` — XTS rejects the Bearer form.
          ...(this.#token === '' ? {} : { authorization: this.#token }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        // A non-JSON body is itself the diagnosis (an HTML error page, a proxy
        // timeout). Surfacing it verbatim beats "unexpected token < in JSON".
        return {
          type: 'error',
          error: { message: `${res.status} ${res.statusText}: ${text.slice(0, 500)}` },
        }
      }
      const env = parsed as XtsResponse & { description?: string; code?: string }
      if (!res.ok && env.type !== 'error') {
        return {
          type: 'error',
          error: { message: `${res.status} ${res.statusText}: ${JSON.stringify(parsed).slice(0, 500)}` },
        }
      }
      // Normalise the two failure shapes XTS uses into the one the adapter
      // classifies on, WITHOUT discarding the description that explains it.
      if (env.type === 'error' && env.error === undefined) {
        return { type: 'error', error: { message: env.description ?? JSON.stringify(parsed).slice(0, 500) } }
      }
      return env
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `request timed out after ${this.#o.timeoutMs ?? 15_000}ms`
          : err instanceof Error
            ? err.message
            : String(err)
      return { type: 'error', error: { message } }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Log in and retain the session token.
   *
   * Throws rather than returning an envelope: an adapter with no session cannot
   * do anything useful, so failing here is clearer than failing on every
   * subsequent order with an auth error.
   */
  async login(): Promise<XtsLoginResult> {
    await this.hostLookup()
    this.#token = ''
    const resp = await this.#call('POST', '/user/session', {
      appKey: this.#o.appKey,
      secretKey: this.#o.secretKey,
      source: this.#o.source ?? 'WEBAPI',
      // Omitted entirely when the broker issues none — an empty one is rejected.
      ...(this.#uniqueKey === undefined || this.#uniqueKey === '' ? {} : { uniqueKey: this.#uniqueKey }),
    })
    if (resp.type !== 'success') {
      throw new Error(`XTS login failed: ${resp.error?.message ?? JSON.stringify(resp)}`)
    }
    const result = (resp.result ?? {}) as {
      token?: string
      userID?: string
      clientCodes?: string[]
    }
    if (typeof result.token !== 'string' || result.token === '') {
      throw new Error('XTS login returned no token')
    }
    this.#token = result.token
    const userID = result.userID ?? ''
    this.#userID = userID
    // clientCodes falls back to the userID, matching how the production login
    // treats a missing clientCode. A CONFIGURED code overrides both — see the
    // `clientCodes` getter.
    this.#loginClientCodes = result.clientCodes ?? (userID === '' ? [] : [userID])
    this.#o.onToken?.(result.token, userID, this.#loginClientCodes)
    this.#o.log?.('XTS session established', {
      userID,
      clientCode: this.clientCodes[0] ?? '',
      clientCodeOverridden: (this.#o.clientId ?? '') !== '',
      isInvestorClient: this.isInvestorClient,
    })
    return { token: result.token, userID, clientCodes: this.clientCodes }
  }

  async logout(): Promise<void> {
    if (this.#token === '') return
    await this.#call('DELETE', '/user/session')
    this.#token = ''
  }

  async placeOrder(req: XtsOrderRequest): Promise<XtsResponse> {
    return await this.#call('POST', '/orders', req)
  }

  /**
   * Modify, with the SAME `clientID` guard the cancel has.
   *
   * A dealer request that carries no client comes back `e-orders-0002 ClientID
   * cannot be empty`, and the caller's body is not always the place that knows
   * one: `XtsAdapter.modifyOrder` sources it from the order's own row and omits
   * it when the row has none. The session's code fills that gap here so the
   * failure cannot reach the wire, exactly as `cancelOrder` fills it — the
   * body's own client still WINS, because a multi-client dealer login must
   * modify each order against the client it was placed for.
   */
  async modifyOrder(req: Record<string, unknown>): Promise<XtsResponse> {
    const onBody = String(req['clientID'] ?? '').trim()
    const client = onBody !== '' ? onBody : this.clientCodes[0] ?? ''
    return await this.#call('PUT', '/orders', client === '' ? req : { ...req, clientID: client })
  }

  async cancelOrder(req: Record<string, unknown>): Promise<XtsResponse> {
    const id = String(req['appOrderID'] ?? '')
    const client = String(req['clientID'] ?? this.clientCodes[0] ?? '')
    const qs = new URLSearchParams({ appOrderID: id })
    if (client !== '') qs.set('clientID', client)
    return await this.#call('DELETE', `/orders?${qs.toString()}`)
  }

  /**
   * The order book. DEALER ACCOUNTS READ A DIFFERENT ENDPOINT.
   *
   * `/orders` for an investor, `/orders/dealerorderbook?clientID=` for a dealer,
   * exactly as `xts-account.js:499` and `:601` branch. The port dropped the
   * distinction, so a dealer account was calling the investor route — which is
   * the failure where the gateway places an order, it fills, and reconciliation
   * against an empty order book concludes nothing happened.
   */
  async getOrderBook(): Promise<XtsResponse> {
    const client = this.clientCodes[0] ?? ''
    if (!this.isInvestorClient) {
      return await this.#call(
        'GET',
        `/orders/dealerorderbook?clientID=${encodeURIComponent(client)}`,
      )
    }
    const qs = client === '' ? '' : `?clientID=${encodeURIComponent(client)}`
    return await this.#call('GET', `/orders${qs}`)
  }

  /**
   * The TRADE BOOK — what actually executed, as opposed to what was ordered.
   *
   * Same investor/dealer split as `getOrderBook`, and for the same reason: a
   * dealer account calling the investor route reads the wrong data or none,
   * and an empty trade book is indistinguishable from "nothing filled".
   *
   * Orders and trades answer different questions and neither substitutes for
   * the other. An order says what was asked for and what the broker currently
   * believes about it; a trade says a quantity changed hands at a price. A
   * partially filled order appears in both, saying different things.
   */
  async getTradeBook(): Promise<XtsResponse> {
    const client = this.clientCodes[0] ?? ''
    if (!this.isInvestorClient) {
      return await this.#call(
        'GET',
        `/orders/dealertradebook?clientID=${encodeURIComponent(client)}`,
      )
    }
    const qs = client === '' ? '' : `?clientID=${encodeURIComponent(client)}`
    return await this.#call('GET', `/orders/trades${qs}`)
  }

  /** Positions, with the same investor/dealer split as `getOrderBook`. */
  async getPosition(req?: Record<string, unknown>): Promise<XtsResponse> {
    const dayOrNet = String(req?.['dayOrNet'] ?? 'NetWise')
    const qs = new URLSearchParams({ dayOrNet })
    const client = this.clientCodes[0] ?? ''
    if (client !== '') qs.set('clientID', client)
    const path = this.isInvestorClient ? '/portfolio/positions' : '/portfolio/dealerpositions'
    return await this.#call('GET', `${path}?${qs.toString()}`)
  }

  /**
   * Funds / margin. `/user/balance` has NO dealer twin — XTS documents it for
   * retail clients and a PRO account may answer "Data Not Available" or an
   * error, so the caller must treat an absent balance as a state, not a
   * failure. The reply's schema varies by XTS build (`BalanceList[0]
   * .limitObject.RMSSubLimits...`), which is why the snapshot stores it
   * verbatim and desk-api digs it by key name instead of either side pinning
   * a shape.
   */
  async getBalance(): Promise<XtsResponse> {
    const client = this.clientCodes[0] ?? ''
    const qs = client === '' ? '' : `?clientID=${encodeURIComponent(client)}`
    return await this.#call('GET', `/user/balance${qs}`)
  }
}

/**
 * A session backed by the REST client, with re-login on expiry.
 *
 * `XtsAdapter` guarantees single-flight around `relogin()`, so this only has to
 * perform it — see the concurrent-re-login reasoning in xts.ts.
 */
export function createXtsRestSession(opts: XtsRestOptions): {
  current(): XtsClient
  relogin(): Promise<XtsClient>
  client: XtsRestClient
  ensureSession(): Promise<void>
} {
  const client = new XtsRestClient(opts)
  return {
    current: () => client,
    relogin: async () => {
      await client.login()
      return client
    },
    client,
    /**
     * Log in only if we do not already hold a token.
     *
     * Reusing a stored token matters: XTS invalidates the previous session on
     * each login, so a gateway that logs in on every boot would kill the
     * session a sibling process is actively trading on.
     */
    ensureSession: async () => {
      if (!client.hasToken) await client.login()
    },
  }
}
