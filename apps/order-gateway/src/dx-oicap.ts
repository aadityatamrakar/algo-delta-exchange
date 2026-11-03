/**
 * THE OI-CAP GATE — an opening package is refused WHOLE when Delta would take
 * only part of it.
 *
 * Delta caps each product's open interest (`product_specs.max_oi_usd`). Once a
 * product's OI value is at or over it, Delta accepts reduce-only orders on it
 * and rejects every opening one `only_reduce_only_orders_allowed`. On 3 Nov 2026
 * two testnet straddles each filled one leg and had the other rejected that
 * way, leaving a half straddle the engine then had to buy back.
 *
 *   OI value = oi contracts × contract value (0.001) × index
 *   capped   = OI value + this order's notional ≥ max_oi_usd
 *
 * (verified against Delta's own `oi_value_usd`). A listed cap is enforced
 * whether or not Delta's reduce-only flag is showing; the flag decides only a
 * check with a figure missing. Which rule applied is logged.
 *
 * WHERE THE FIGURES COME FROM — never a background poll:
 *   live — all from data the gateway already holds: the cap and flag off the
 *          instrument master (the marketdata sync writes `dx_max_oi_usd` and
 *          `dx_oi_reduce_only`), OI contracts off `md.tick`, the index off
 *          `md.spot`. No REST.
 *   demo — testnet's OI differs from production's, so at entry only: one REST
 *          ticker per opening leg (`/v2/tickers/{symbol}`), the cap and flag
 *          from the demo rail's cached testnet listing.
 *   sim  — not checked.
 *
 * THE PACKAGE is the engine decision the order belongs to (`<decisionId>#<leg>`;
 * the api parks the decision's whole plan in `desk-decisions.plannedFills`
 * before it routes any leg). An order with no plan to read is a package of one.
 * The verdict is decided once per package and remembered, so every leg gets
 * the same answer. Closes and other exposure-reducing ops are never checked.
 * A failed read lets the order through (logged): Delta's own rejection is the
 * backstop, and an unreachable endpoint must not stop every entry.
 */
import { num, oiCapCheck, oiUsdOf, type DxProduct, type DxTicker, type OiCapStatus } from '@algomaker/dx'
import { baseClientOrderId } from './gateway.ts'
import { reducesExposure } from './queue.ts'

/** The cap figures of one contract on one venue. */
export interface LegFigures {
  readonly oiUsd: number | null
  readonly capUsd: number | null
  readonly reduceOnly: boolean
}

/** Figures for a set of symbols on one rail; a symbol it knows nothing of is absent. */
export interface OiCapSource {
  figures(symbols: readonly string[]): Promise<ReadonlyMap<string, LegFigures>>
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
  /** The figure source for a rail (`live` | `demo`); null when that rail has none. */
  readonly sourceFor: (rail: string) => OiCapSource | null
  /** The decision's planned legs, or null when there is no plan to read. */
  readonly loadPackage: (decisionId: string) => Promise<readonly PackageLeg[] | null>
  /** The BTC index, for an order's own notional; null when unknown. */
  readonly index: () => number | null
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
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
    s.oiUsd !== null && s.capUsd !== null ? `OI ${usd(s.oiUsd)} ≥ cap ${usd(s.capUsd)}` : 'OI over its cap (figures not on hand)'
  return `oi-cap: ${symbol} ${figures} — Delta accepts reduce-only only`
}

// ------------------------------------------------------------- sources

/** What the live source reads off the instrument master for one symbol. */
export interface MasterCap {
  readonly token: number
  readonly lotSize: number
  readonly capUsd: number | null
  readonly reduceOnly: boolean
}

/**
 * LIVE: no IO. Cap and flag from the master, OI contracts from the last
 * `md.tick` for the token, the index from `md.spot`.
 */
export function liveOiCapSource(d: {
  readonly capOf: (symbol: string) => MasterCap | null
  readonly oiContractsOf: (token: number) => number | null
  readonly index: () => number | null
}): OiCapSource {
  return {
    async figures(symbols) {
      const out = new Map<string, LegFigures>()
      for (const s of symbols) {
        const c = d.capOf(s)
        if (c === null) continue
        out.set(s, {
          oiUsd: oiUsdOf(d.oiContractsOf(c.token), c.lotSize > 0 ? c.lotSize : 0.001, d.index()),
          capUsd: c.capUsd,
          reduceOnly: c.reduceOnly,
        })
      }
      return out
    },
  }
}

/**
 * DEMO: at entry only — one testnet ticker per symbol (REST), the cap and
 * flag from testnet's product as the demo rail's cached listing has it.
 */
export function demoOiCapSource(d: {
  readonly ticker: (symbol: string) => Promise<DxTicker>
  readonly productOf: (symbol: string) => Promise<DxProduct | null>
  readonly index: () => number | null
}): OiCapSource {
  return {
    async figures(symbols) {
      const out = new Map<string, LegFigures>()
      await Promise.all(
        symbols.map(async (s) => {
          const product = await d.productOf(s)
          if (product === null) return
          const t = await d.ticker(s)
          const specs = product.product_specs
          out.set(s, {
            oiUsd: oiUsdOf(num(t.oi_contracts), num(product.contract_value) ?? 0.001, num(t.spot_price) ?? d.index()),
            capUsd: num(specs?.max_oi_usd),
            reduceOnly:
              specs?.oi_reduce_only_mode === true ||
              specs?.only_reduce_only_orders_allowed === true ||
              t.oi_reduce_only_mode === true,
          })
        }),
      )
      return out
    },
  }
}

// ------------------------------------------------------------- the gate

interface Verdict {
  readonly at: number
  /** null = the package may go. */
  readonly refusal: string | null
}

export class OiCapGate {
  readonly #d: OiCapGateDeps
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
    const source = this.#d.sourceFor(rail)
    if (source === null) return null

    const decisionId = decisionIdOf(clientOrderId)
    const key = `${rail}|${decisionId ?? baseClientOrderId(clientOrderId)}`
    this.#prune(this.#d.now())
    const known = this.#verdicts.get(key)
    if (known !== undefined) return this.#forLeg(known.refusal, order.tradingsymbol)
    const inFlight = this.#pending.get(key)
    if (inFlight !== undefined) return this.#forLeg(await inFlight, order.tradingsymbol)

    const p = this.#decide(source, rail, decisionId, order)
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

  async #decide(source: OiCapSource, rail: string, decisionId: string | null, order: OiCapOrder): Promise<string | null> {
    let legs: readonly PackageLeg[] = [
      { tradingsymbol: order.tradingsymbol, qty: order.quantity, ...(order.desk_op === undefined ? {} : { op: order.desk_op }) },
    ]
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

    let figures: ReadonlyMap<string, LegFigures>
    try {
      figures = await source.figures([...opening.keys()])
    } catch (err) {
      this.#d.log('oi-cap: read failed, not blocking (Delta refuses a capped order itself)', { rail, decisionId, error: msgOf(err) })
      return null
    }
    const index = this.#d.index()
    for (const [symbol, qty] of opening) {
      const f = figures.get(symbol)
      if (f === undefined) {
        this.#d.log('oi-cap: no cap figures for the leg, not checked', { rail, symbol })
        continue
      }
      const s = oiCapCheck({ ...f, orderNotionalUsd: index === null ? 0 : qty * index })
      if (s.basis === 'no-figures') this.#d.log('oi-cap: OI or cap unknown and no reduce-only flag, not checked', { rail, symbol })
      if (s.capped) {
        // `cap` = enforced on a listed cap with no flag showing; `flag` = Delta flagged it too.
        this.#d.log('oi-cap: package refused', { rail, decisionId, symbol, basis: s.basis, oiUsd: s.oiUsd, capUsd: s.capUsd })
        return oiCapReason(symbol, s)
      }
    }
    return null
  }

  #prune(now: number): void {
    const life = this.#d.verdictTtlMs ?? 600_000
    for (const [k, v] of this.#verdicts) if (now - v.at >= life) this.#verdicts.delete(k)
  }
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
