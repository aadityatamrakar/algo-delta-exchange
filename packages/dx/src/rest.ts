/**
 * Delta India REST — a thin native-fetch client (delta-api-reference.md §2–§9).
 *
 * Every method returns the parsed `result`. Every failure is a `DxApiError`
 * whose `status` says what kind it was: 0 = the request may never have
 * arrived or its answer never came back (transport, timeout), 4xx = Delta
 * refused it, 5xx = Delta failed. A caller placing orders must treat 0 and 5xx
 * as "outcome unknown", never as "not placed".
 */
import { signRequest } from './sign.ts'
import type { DxBalance, DxFill, DxOrder, DxOrderRequest, DxPosition, DxProduct, DxTicker } from './types.ts'

export interface DxRestOptions {
  readonly baseUrl: string
  readonly apiKey?: string
  readonly apiSecret?: string
  /** Mandatory: the CDN blocks requests without one (403). */
  readonly userAgent: string
  readonly fetch?: typeof fetch
  readonly nowMs?: () => number
  /** Per request; default 10 s. */
  readonly timeoutMs?: number
  /** Dead-man's-switch id; default `algomaker-dx`. */
  readonly heartbeatId?: string
}

export class DxApiError extends Error {
  /** HTTP status, or 0 when no response was received. */
  readonly status: number
  /**
   * Delta's `error.code` / `error`, else `http_<status>`, `network`, `timeout`,
   * or `not_sent` (refused locally before any request — provably not placed).
   */
  readonly code: string
  /** On a 429: ms until the next call is allowed (`X-RATE-LIMIT-RESET`). */
  readonly retryAfterMs?: number
  readonly context?: unknown
  constructor(a: { status: number; code: string; message: string; retryAfterMs?: number; context?: unknown }) {
    super(a.message)
    this.name = 'DxApiError'
    this.status = a.status
    this.code = a.code
    if (a.retryAfterMs !== undefined) this.retryAfterMs = a.retryAfterMs
    if (a.context !== undefined) this.context = a.context
  }
}

type QueryValue = string | number | undefined
type Query = Readonly<Record<string, QueryValue>>

/** `?a=1&b=2` in insertion order, undefined dropped; '' when nothing is left. */
export function buildQuery(q: Query): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.append(k, String(v))
  const s = p.toString()
  return s === '' ? '' : `?${s}`
}

const csv = (xs: readonly string[] | undefined): string | undefined =>
  xs === undefined || xs.length === 0 ? undefined : xs.join(',')

/** `2026-11-04` → `04-11-2026` (the tickers endpoint's format); anything else passes through. */
const tickerDate = (d: string | undefined): string | undefined => {
  if (d === undefined) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d
}

interface Envelope<T> {
  readonly success?: boolean
  readonly result?: T
  readonly meta?: { readonly after?: string | null; readonly before?: string | null }
  readonly error?: unknown
  readonly message?: string
}

export class DxRest {
  readonly #o: DxRestOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number

  constructor(opts: DxRestOptions) {
    if (opts.userAgent.trim() === '') throw new Error('DxRest: userAgent is mandatory')
    this.#o = opts
    this.#fetch = opts.fetch ?? fetch
    this.#now = opts.nowMs ?? Date.now
  }

  // ---------------------------------------------------------------- public

  /**
   * All pages of `/v2/products` for the filter. `expiryDate` (YYYY-MM-DD) is
   * sent as `expiry`, which matches the settlement date across EVERY
   * underlying and settlement time — keep `underlying` set alongside it.
   */
  async products(
    q: { contractTypes?: string[]; states?: string[]; underlying?: string[]; expiryDate?: string } = {},
  ): Promise<DxProduct[]> {
    const out: DxProduct[] = []
    let after: string | undefined
    for (let page = 0; page < 1000; page++) {
      const env = await this.#request<DxProduct[]>('GET', '/v2/products', {
        contract_types: csv(q.contractTypes),
        states: csv(q.states),
        underlying_asset_symbols: csv(q.underlying),
        expiry: q.expiryDate,
        page_size: 500,
        after,
      }, undefined, false)
      out.push(...(env.result ?? []))
      const next = env.meta?.after
      if (next === null || next === undefined || next === '') return out
      after = next
    }
    throw new DxApiError({ status: 0, code: 'pagination', message: 'products: cursor did not terminate' })
  }

  /** `/v2/tickers`; `expiryDate` as `YYYY-MM-DD`. */
  async tickers(q: { contractTypes?: string[]; underlying?: string[]; expiryDate?: string } = {}): Promise<DxTicker[]> {
    const env = await this.#request<DxTicker[]>('GET', '/v2/tickers', {
      contract_types: csv(q.contractTypes),
      underlying_asset_symbols: csv(q.underlying),
      expiry_date: tickerDate(q.expiryDate),
    }, undefined, false)
    return env.result ?? []
  }

  // ---------------------------------------------------------------- signed

  async placeOrder(o: DxOrderRequest): Promise<DxOrder> {
    return this.#result(await this.#request<DxOrder>('POST', '/v2/orders', {}, o, true))
  }

  async cancelOrder(id: number, productId: number): Promise<DxOrder> {
    return this.#result(await this.#request<DxOrder>('DELETE', '/v2/orders', {}, { id, product_id: productId }, true))
  }

  async editOrder(o: { id: number; productId: number; limitPrice: string }): Promise<DxOrder> {
    const body = { id: o.id, product_id: o.productId, limit_price: o.limitPrice }
    return this.#result(await this.#request<DxOrder>('PUT', '/v2/orders', {}, body, true))
  }

  /** Open and untriggered orders. */
  async openOrders(): Promise<DxOrder[]> {
    const env = await this.#request<DxOrder[]>('GET', '/v2/orders', { states: 'open,pending', page_size: 50 }, undefined, true)
    return env.result ?? []
  }

  /** Closed and cancelled orders, newest first (one page, at most 50). */
  async orderHistory(q: { after?: string } = {}): Promise<DxOrder[]> {
    const env = await this.#request<DxOrder[]>('GET', '/v2/orders/history', { page_size: 50, after: q.after }, undefined, true)
    return env.result ?? []
  }

  async fills(q: { after?: string } = {}): Promise<{ fills: DxFill[]; after?: string }> {
    const env = await this.#request<DxFill[]>('GET', '/v2/fills', { page_size: 50, after: q.after }, undefined, true)
    const after = env.meta?.after
    return after === null || after === undefined || after === ''
      ? { fills: env.result ?? [] }
      : { fills: env.result ?? [], after }
  }

  /** Real-time positions for one underlying (default BTC). */
  async positions(q: { underlying?: string } = {}): Promise<DxPosition[]> {
    const env = await this.#request<DxPosition[]>('GET', '/v2/positions', { underlying_asset_symbol: q.underlying ?? 'BTC' }, undefined, true)
    return env.result ?? []
  }

  async walletBalances(): Promise<DxBalance[]> {
    const env = await this.#request<DxBalance[]>('GET', '/v2/wallet/balances', {}, undefined, true)
    return env.result ?? []
  }

  /**
   * Dead-man's switch. `create` registers a switch that cancels every open
   * BTC option order when an ack is missed; `ack` renews it for `ttlMs`.
   */
  async heartbeat(op: 'create' | 'ack', ttlMs = 30000): Promise<void> {
    const id = this.#o.heartbeatId ?? 'algomaker-dx'
    if (op === 'create') {
      await this.#request('POST', '/v2/heartbeat/create', {}, {
        heartbeat_id: id,
        impact: 'contracts',
        contract_types: ['call_options', 'put_options'],
        underlying_assets: ['BTC'],
        config: [{ action: 'cancel_orders', unhealthy_count: 1 }],
        default_ttl: ttlMs,
      }, true)
    } else {
      await this.#request('POST', '/v2/heartbeat', {}, { heartbeat_id: id, ttl: ttlMs }, true)
    }
  }

  // ---------------------------------------------------------------- core

  #result<T>(env: Envelope<T>): T {
    if (env.result === undefined) {
      throw new DxApiError({ status: 200, code: 'no_result', message: 'Delta answered success with no result' })
    }
    return env.result
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query: Query,
    body: unknown,
    signed: boolean,
  ): Promise<Envelope<T>> {
    const qs = buildQuery(query)
    const bodyStr = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { 'User-Agent': this.#o.userAgent, Accept: 'application/json' }
    if (bodyStr !== '') headers['Content-Type'] = 'application/json'
    if (signed) {
      const key = this.#o.apiKey ?? ''
      const secret = this.#o.apiSecret ?? ''
      if (key === '' || secret === '') {
        throw new DxApiError({ status: 0, code: 'not_sent', message: `DxRest: ${method} ${path} needs API credentials` })
      }
      // Fresh per request: the signature is valid for 5 s, and a retry must re-sign.
      const ts = Math.floor(this.#now() / 1000)
      headers['api-key'] = key
      headers['timestamp'] = String(ts)
      headers['signature'] = signRequest(secret, method, path, qs, bodyStr, ts)
    }

    let res: Response
    try {
      res = await this.#fetch(this.#o.baseUrl.replace(/\/+$/, '') + path + qs, {
        method,
        headers,
        ...(bodyStr === '' ? {} : { body: bodyStr }),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
      })
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new DxApiError({
        status: 0,
        code: timeout ? 'timeout' : 'network',
        message: `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    const text = await res.text().catch(() => '')
    let env: Envelope<T> | null = null
    try {
      env = text === '' ? null : (JSON.parse(text) as Envelope<T>)
    } catch {
      env = null
    }

    if (!res.ok || env === null || env.success === false || (env.success === undefined && env.error !== undefined)) {
      throw errorOf(method, path, res, env)
    }
    return env
  }
}

function errorOf(method: string, path: string, res: Response, env: Envelope<unknown> | null): DxApiError {
  let code = `http_${res.status}`
  let context: unknown
  let message = ''
  const e = env?.error
  if (typeof e === 'string') {
    code = e
    message = env?.message ?? e
  } else if (e !== null && typeof e === 'object') {
    const o = e as { code?: unknown; context?: unknown; message?: unknown }
    if (typeof o.code === 'string' && o.code !== '') code = o.code
    context = o.context
    if (typeof o.message === 'string') message = o.message
  } else if (res.ok && env === null) {
    code = 'bad_body'
  }
  const reset = res.headers.get('X-RATE-LIMIT-RESET')
  const retryAfterMs = res.status === 429 && reset !== null && Number.isFinite(Number(reset)) ? Number(reset) : undefined
  return new DxApiError({
    status: res.status,
    code,
    message: `${method} ${path}: ${res.status} ${code}${message !== '' && message !== code ? ` — ${message}` : ''}`,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(context === undefined ? {} : { context }),
  })
}
