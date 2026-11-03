/**
 * THE OI-CAP GATE — an opening package is refused WHOLE when Delta would take
 * only part of it.
 *
 * Delta caps each product's open interest (`product_specs.max_oi_usd`). While a
 * product is over it (`oi_reduce_only_mode`), Delta accepts reduce-only orders
 * on it and rejects every opening one `only_reduce_only_orders_allowed`. On
 * 3 Nov 2026 two testnet straddles each filled one leg and had the other
 * rejected that way, leaving a half straddle the engine then had to buy back.
 *
 * So, before the FIRST leg of an opening package goes out, every opening leg of
 * the package is checked against the cap on the venue the order is going to
 * (the testnet's product for the demo rail, production's for live — their OI
 * differs). One capped leg refuses every leg of the package, with nothing sent.
 *
 *   - The package is the engine decision the order belongs to: its order id is
 *     `<decisionId>#<leg>`, and the api parks the decision's whole plan
 *     (`desk-decisions.plannedFills`) BEFORE it routes any leg. An order with no
 *     plan to read (a manual submit) is a package of one.
 *   - The verdict is decided once per package and remembered, so every leg gets
 *     the same answer even if the OI moves between them.
 *   - Closes and other exposure-reducing ops are never checked, never blocked.
 *   - The simulator rail is not checked.
 *   - A failed read lets the order through (logged): Delta's own refusal is the
 *     backstop, and an unreachable endpoint must not stop every entry.
 *
 * Products and tickers are cached per venue and symbol for `ttlMs` (20 s).
 */
import { oiCapStatus, type DxProduct, type DxTicker, type OiCapStatus } from '@algomaker/dx'
import { baseClientOrderId } from './gateway.ts'
import { reducesExposure } from './queue.ts'

/** The two public reads the gate needs of a venue. `DxRest` satisfies this. */
export interface OiCapVenue {
  product(symbol: string): Promise<DxProduct>
  ticker(symbol: string): Promise<DxTicker>
}

/** One leg of a package, as the api planned it. */
export interface PackageLeg {
  readonly tradingsymbol: string
  /** `open` | `close` | `roll` | `resize`; absent is treated as opening. */
  readonly op?: string
  /** Desk quantity (BTC). */
  readonly qty: number
}

export interface OiCapGateDeps {
  /** The venue for a rail (`live` | `demo`); null when that rail has none. */
  readonly venueFor: (rail: string) => OiCapVenue | null
  /** The decision's planned legs, or null when there is no plan to read. */
  readonly loadPackage: (decisionId: string) => Promise<readonly PackageLeg[] | null>
  /** The BTC index for an order's notional; null when unknown. */
  readonly index: () => number | null
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** Product and ticker cache life. Default 20 s. */
  readonly ttlMs?: number
  /** How long a package's verdict is remembered. Default 10 min. */
  readonly verdictTtlMs?: number
}

export interface OiCapOrder {
  readonly tradingsymbol: string
  readonly quantity: number
  readonly desk_op?: string
}

/** The engine decision an order id belongs to: `<decisionId>#<leg>`, tranche suffix stripped. */
export function decisionIdOf(clientOrderId: string): string | null {
  const base = baseClientOrderId(clientOrderId)
  const hash = base.lastIndexOf('#')
  return hash <= 0 ? null : base.slice(0, hash)
}

/** `$4,233,772` — whole dollars, as an operator reads a cap. */
const usd = (x: number): string => `$${Math.round(x).toLocaleString('en-US')}`

/** The journalled reason for one capped leg. */
export function oiCapReason(symbol: string, s: OiCapStatus): string {
  const figures =
    s.oiUsd !== null && s.capUsd !== null ? `OI ${usd(s.oiUsd)} ≥ cap ${usd(s.capUsd)}` : 'OI over its cap (figures not reported)'
  return `oi-cap: ${symbol} ${figures} — Delta accepts reduce-only only`
}

interface Cached<T> {
  readonly at: number
  readonly value: T
}

interface Verdict {
  readonly at: number
  /** null = the package may go. */
  readonly refusal: string | null
}

export class OiCapGate {
  readonly #d: OiCapGateDeps
  readonly #products = new Map<string, Cached<DxProduct>>()
  readonly #tickers = new Map<string, Cached<DxTicker>>()
  readonly #verdicts = new Map<string, Verdict>()
  readonly #pending = new Map<string, Promise<string | null>>()

  constructor(deps: OiCapGateDeps) {
    this.#d = deps
  }

  /**
   * Why this order must not be sent, or null. `rail` is where the order is
   * going (`live` | `demo` | `sim`).
   */
  async refusal(order: OiCapOrder, clientOrderId: string, rail: string | null): Promise<string | null> {
    if (reducesExposure(order.desk_op)) return null
    if (rail === null || rail === 'sim') return null
    const venue = this.#d.venueFor(rail)
    if (venue === null) return null

    const decisionId = decisionIdOf(clientOrderId)
    const key = `${rail}|${decisionId ?? baseClientOrderId(clientOrderId)}`
    const now = this.#d.now()
    this.#prune(now)
    const known = this.#verdicts.get(key)
    if (known !== undefined) return this.#forLeg(known.refusal, order.tradingsymbol)
    const inFlight = this.#pending.get(key)
    if (inFlight !== undefined) return this.#forLeg(await inFlight, order.tradingsymbol)

    const p = this.#decide(venue, rail, decisionId, order)
    this.#pending.set(key, p)
    try {
      const refusal = await p
      this.#verdicts.set(key, { at: this.#d.now(), refusal })
      return this.#forLeg(refusal, order.tradingsymbol)
    } finally {
      this.#pending.delete(key)
    }
  }

  /** The package refusal, worded for one leg of it. */
  #forLeg(refusal: string | null, symbol: string): string | null {
    if (refusal === null) return null
    return refusal.includes(`: ${symbol} `)
      ? `${refusal}; the whole opening package is refused, no leg sent`
      : `${refusal}; ${symbol} is refused with it — the whole opening package is refused, no leg sent`
  }

  async #decide(venue: OiCapVenue, rail: string, decisionId: string | null, order: OiCapOrder): Promise<string | null> {
    let legs: readonly PackageLeg[] = [{ tradingsymbol: order.tradingsymbol, qty: order.quantity, ...(order.desk_op === undefined ? {} : { op: order.desk_op }) }]
    if (decisionId !== null) {
      try {
        const planned = await this.#d.loadPackage(decisionId)
        if (planned !== null && planned.length > 0) legs = planned
      } catch (err) {
        this.#d.log('oi-cap: package read failed, checking this leg alone', { decisionId, error: msgOf(err) })
      }
    }
    const opening = new Map<string, number>()
    for (const l of legs) {
      if (reducesExposure(l.op)) continue
      opening.set(l.tradingsymbol, (opening.get(l.tradingsymbol) ?? 0) + Math.abs(l.qty))
    }
    // The order in hand is opening (checked above) even if the plan disagrees.
    if (!opening.has(order.tradingsymbol)) opening.set(order.tradingsymbol, Math.abs(order.quantity))

    for (const [symbol, qty] of opening) {
      let product: DxProduct
      let ticker: DxTicker
      try {
        ;[product, ticker] = await Promise.all([this.#product(venue, rail, symbol), this.#ticker(venue, rail, symbol)])
      } catch (err) {
        this.#d.log('oi-cap: read failed, not blocking (Delta refuses a capped order itself)', { rail, symbol, error: msgOf(err) })
        continue
      }
      const index = this.#d.index() ?? num(ticker.spot_price)
      const notional = index === null ? 0 : qty * index
      const s = oiCapStatus(product, ticker, notional)
      if (s.capped) {
        this.#d.log('oi-cap: package refused', { rail, decisionId, symbol, oiUsd: s.oiUsd, capUsd: s.capUsd })
        return oiCapReason(symbol, s)
      }
    }
    return null
  }

  async #product(venue: OiCapVenue, rail: string, symbol: string): Promise<DxProduct> {
    return await this.#cached(this.#products, `${rail}|${symbol}`, () => venue.product(symbol))
  }

  async #ticker(venue: OiCapVenue, rail: string, symbol: string): Promise<DxTicker> {
    return await this.#cached(this.#tickers, `${rail}|${symbol}`, () => venue.ticker(symbol))
  }

  async #cached<T>(map: Map<string, Cached<T>>, key: string, read: () => Promise<T>): Promise<T> {
    const hit = map.get(key)
    const now = this.#d.now()
    if (hit !== undefined && now - hit.at < (this.#d.ttlMs ?? 20_000)) return hit.value
    const value = await read()
    map.set(key, { at: this.#d.now(), value })
    return value
  }

  #prune(now: number): void {
    const life = this.#d.verdictTtlMs ?? 600_000
    for (const [k, v] of this.#verdicts) if (now - v.at >= life) this.#verdicts.delete(k)
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
