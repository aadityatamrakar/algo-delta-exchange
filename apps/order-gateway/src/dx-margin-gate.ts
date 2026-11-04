/**
 * THE PRE-TRADE MARGIN GATE — an opening package is refused WHOLE, before its
 * first leg is sent, when its estimated initial margin is over the account's
 * available balance. Beside the OI-cap gate (`dx-oicap.ts`) and for the same
 * reason: Delta refusing leg 2 `insufficient_margin` after leg 1 filled is a
 * half straddle the engine then has to buy back.
 *
 * THE ESTIMATE, per opening leg (qty in BTC = contracts × 0.001):
 *
 *   short: `shortOptionMargin` (`bull-s/margin.ts`) by the account's margin
 *          mode — isolated: mark × qty + qty × index ÷ leverage; portfolio:
 *          qty × index ÷ leverage × 1.25, the premium never blocked (probed on
 *          demo 4 Nov). Mode unknown = isolated, the larger. Leverage = the
 *          product's `default_leverage`, the instrument row's `dx_leverage`.
 *   long:  mark × qty                            (the premium it pays)
 *
 * The mark is the HIGHER of the live mid and the planned price.
 *
 * AVAILABLE BALANCE: the gateway's own wallet read (`desk-broker-margin`,
 * `available`, at most `DESK_DX_MARGIN_MAX_AGE_MS` old), else a REST wallet
 * read — the caller's `available(rail)`.
 *
 * A FAILED LOOKUP (no fresh balance, no leverage, no mark, no index, no plan):
 *   live — FAIL-CLOSED: `margin: lookup failed — …`, critical alert.
 *   demo — fail-open with a warn: Delta's own `insufficient_margin` is the
 *          backstop.
 *   sim  — not checked.
 *
 * The verdict is decided ONCE per package (`<decisionId>#<leg>`) and
 * remembered, so every leg gets the same answer — leg 1's own margin must not
 * refuse leg 2. Closes and other exposure-reducing ops are never checked.
 *
 * `bs_margin_budget` is not applied here: the order document does not carry
 * the book's dials, and the engine enforces the budget at arm time.
 */
import { baseClientOrderId } from './gateway.ts'
import { reducesExposure } from './queue.ts'
import { decisionIdOf } from './dx-oicap.ts'
import { NO_ALERTS, type AlertSink } from './alert-sink.ts'
import { shortOptionMargin, type MarginMode } from '@algomaker/desk-engine'

/** How old a `desk-broker-margin` read may be and still count. */
export const DEFAULT_MARGIN_MAX_AGE_MS = 60_000

/** One leg of a package, as the api planned it. */
export interface MarginLeg {
  readonly tradingsymbol: string
  /** `open` | `close` | `roll` | `resize`; absent is opening. */
  readonly op?: string
  /** Absent is treated as a SELL — the larger estimate. */
  readonly side?: 'BUY' | 'SELL'
  /** BTC. */
  readonly qty: number
  /** The planned (limit) price, USD per 1 BTC. */
  readonly price?: number
}

export interface MarginOrder {
  readonly tradingsymbol: string
  readonly quantity: number
  readonly desk_op?: string
  readonly transaction_type?: 'BUY' | 'SELL'
  readonly limitPrice?: number
  readonly tag?: string
}

export interface MarginGateDeps {
  /** The decision's planned legs, or null when there is no plan to read. */
  readonly loadPackage: (decisionId: string) => Promise<readonly MarginLeg[] | null>
  /** The live mid for a symbol, null when no fresh quote. */
  readonly markOf: (symbol: string) => number | null
  /** The product's `default_leverage`, null when the master states none. */
  readonly leverageOf: (symbol: string) => number | null
  readonly index: () => number | null
  /** The rail account's fresh available balance (USD), null when none can be read. */
  readonly available: (rail: string) => Promise<number | null>
  /** The rail account's margin mode; absent or null = unknown, priced as isolated. */
  readonly marginMode?: (rail: string) => Promise<MarginMode | null>
  /** Refuse when a lookup fails on this rail (live). */
  readonly failClosed: (rail: string) => boolean
  readonly alerts?: AlertSink
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** How long a package's verdict is remembered. Default 10 min. */
  readonly verdictTtlMs?: number
}

const r8 = (x: number): number => Number(x.toFixed(8))
const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const usd = (x: number): string => `$${x.toFixed(2)}`
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The package's estimated initial margin, USD. PURE. `missing` names the first
 * figure it could not find (and `usd` is then a lower bound, not to be used).
 */
export function estimatePackageMargin(
  legs: readonly MarginLeg[],
  f: {
    readonly markOf: (symbol: string) => number | null
    readonly leverageOf: (symbol: string) => number | null
    readonly index: number | null
    readonly mode?: MarginMode | null
  },
): { readonly usd: number; readonly missing: string | null } {
  let total = 0
  for (const l of legs) {
    if (reducesExposure(l.op)) continue
    const qty = Math.abs(l.qty)
    if (!(qty > 0)) continue
    const live = f.markOf(l.tradingsymbol)
    const mark = Math.max(pos(live) ? live : 0, pos(l.price) ? l.price : 0)
    if (!(mark > 0)) return { usd: r8(total), missing: `no mark for ${l.tradingsymbol}` }
    if (l.side === 'BUY') {
      total += mark * qty
      continue
    }
    const lev = f.leverageOf(l.tradingsymbol)
    if (!pos(lev)) return { usd: r8(total), missing: `no leverage for ${l.tradingsymbol}` }
    if (!pos(f.index)) return { usd: r8(total), missing: 'no BTC index price yet' }
    total += shortOptionMargin({ mark, qty, index: f.index, leverage: lev, mode: f.mode ?? null })
  }
  return { usd: r8(total), missing: null }
}

/** A `desk-broker-margin` row's `available`, when it is ok, numeric and fresh; else null. */
export function freshBalance(
  doc: { readonly ok?: unknown; readonly available?: unknown; readonly asOf?: unknown } | null | undefined,
  now: number,
  maxAgeMs: number,
): number | null {
  if (doc === null || doc === undefined || doc.ok !== true) return null
  const available = doc.available
  const asOf = Number(doc.asOf)
  if (typeof available !== 'number' || !Number.isFinite(available)) return null
  if (!Number.isFinite(asOf) || now - asOf > maxAgeMs) return null
  return available
}

interface Verdict {
  readonly at: number
  readonly refusal: string | null
}

export class MarginGate {
  readonly #d: MarginGateDeps
  readonly #verdicts = new Map<string, Verdict>()
  readonly #pending = new Map<string, Promise<string | null>>()

  constructor(deps: MarginGateDeps) {
    this.#d = deps
  }

  /** Why this order's opening package must not be sent, or null. */
  async refusal(order: MarginOrder, clientOrderId: string, rail: string | null): Promise<string | null> {
    if (reducesExposure(order.desk_op)) return null
    if (rail === null || rail === 'sim') return null

    const decisionId = decisionIdOf(clientOrderId)
    const key = `${rail}|${decisionId ?? baseClientOrderId(clientOrderId)}`
    this.#prune(this.#d.now())
    const known = this.#verdicts.get(key)
    if (known !== undefined) return this.#forLeg(known.refusal)
    const inFlight = this.#pending.get(key)
    if (inFlight !== undefined) return this.#forLeg(await inFlight)

    const p = this.#decide(rail, decisionId, order, key)
    this.#pending.set(key, p)
    try {
      const refusal = await p
      this.#verdicts.set(key, { at: this.#d.now(), refusal })
      return this.#forLeg(refusal)
    } finally {
      this.#pending.delete(key)
    }
  }

  #forLeg(refusal: string | null): string | null {
    return refusal === null ? null : `${refusal}; the whole opening package is refused, no leg sent`
  }

  async #decide(rail: string, decisionId: string | null, order: MarginOrder, key: string): Promise<string | null> {
    const closed = this.#d.failClosed(rail)
    const mode = rail === 'live' ? 'live' : 'paper'
    const alerts = this.#d.alerts ?? NO_ALERTS
    const tag = order.tag ?? ''
    const failed = (detail: string): string | null => {
      this.#d.log(
        closed ? 'margin: lookup failed, package refused (fail-closed)' : 'margin: lookup failed, not blocking (Delta refuses an unfunded order itself)',
        { rail, decisionId, detail },
      )
      alerts.raise({
        severity: closed ? 'critical' : 'warn',
        mode,
        key: `margin-lookup:${key}`,
        tag,
        message: closed
          ? `margin check failed on ${rail} — opening package refused: ${detail}`
          : `margin check failed on ${rail} — not blocking: ${detail}`,
      })
      return closed ? `margin: lookup failed — ${detail}` : null
    }

    let legs: readonly MarginLeg[] = [
      {
        tradingsymbol: order.tradingsymbol,
        qty: order.quantity,
        ...(order.desk_op === undefined ? {} : { op: order.desk_op }),
        ...(order.transaction_type === undefined ? {} : { side: order.transaction_type }),
        ...(pos(order.limitPrice) ? { price: order.limitPrice } : {}),
      },
    ]
    if (decisionId !== null) {
      try {
        const planned = await this.#d.loadPackage(decisionId)
        if (planned !== null && planned.length > 0) legs = planned
      } catch (err) {
        if (closed) return failed(`the package plan for ${decisionId} could not be read: ${msgOf(err)}`)
        this.#d.log('margin: package read failed, checking this leg alone', { decisionId, error: msgOf(err) })
      }
    }

    let marginMode: MarginMode | null = null
    try {
      marginMode = (await this.#d.marginMode?.(rail)) ?? null
    } catch (err) {
      this.#d.log('margin: mode read failed, priced as isolated', { rail, error: msgOf(err) })
    }
    const est = estimatePackageMargin(legs, {
      markOf: this.#d.markOf,
      leverageOf: this.#d.leverageOf,
      index: this.#d.index(),
      mode: marginMode,
    })
    if (est.missing !== null) return failed(est.missing)
    if (!(est.usd > 0)) return null

    let available: number | null
    try {
      available = await this.#d.available(rail)
    } catch (err) {
      return failed(`the ${rail} wallet could not be read: ${msgOf(err)}`)
    }
    if (available === null || !Number.isFinite(available)) return failed(`no fresh ${rail} wallet balance`)

    if (est.usd > available) {
      const refusal = `margin: est initial margin ${usd(est.usd)} > available ${usd(available)} on ${rail} (${marginMode ?? 'isolated, mode unknown'} margin)`
      this.#d.log('margin: package refused', { rail, decisionId, estUsd: est.usd, available })
      alerts.raise({ severity: 'warn', mode, key: `margin:${key}`, tag, message: refusal })
      return refusal
    }
    return null
  }

  #prune(now: number): void {
    const life = this.#d.verdictTtlMs ?? 600_000
    for (const [k, v] of this.#verdicts) if (now - v.at >= life) this.#verdicts.delete(k)
  }
}
