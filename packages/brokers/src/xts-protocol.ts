/**
 * XTS protocol translation: statuses, error classification, order shaping.
 *
 * Pure and synchronous, so every rule here is testable without a broker
 * connection. The adapter (xts.ts) is then a thin layer that performs IO and
 * asks this module what everything means.
 *
 * The error classification is the one piece deliberately carried over from
 * `server/tools/xtsOrder.js`. That file's retry logic was earned through real
 * incidents — three distinct error families that look alike in a log but need
 * completely different responses — and re-deriving it from first principles
 * would mean rediscovering them in production. The CODE is fresh; the knowledge
 * is not, and should not be.
 */

import type { OrderStatus, OrderType, Side } from '@algomaker/order-bus'

// ------------------------------------------------------------------ statuses

/**
 * XTS order statuses, uppercased, mapped onto ours.
 *
 * `PendingNew`/`PendingReplace` map to their in-flight equivalents rather than
 * to WORKING: an order the exchange has not acknowledged is not working, and
 * treating it as such would let a reconciliation loop conclude a position exists
 * before it does.
 */
const STATUS_MAP: Readonly<Record<string, OrderStatus>> = {
  NEW: 'PENDING_NEW',
  PENDINGNEW: 'PENDING_NEW',
  OPEN: 'WORKING',
  WORKING: 'WORKING',
  REPLACED: 'WORKING',
  PENDINGREPLACE: 'AMENDING',
  PENDINGCANCEL: 'CANCELLING',
  PARTIALLYFILLED: 'PARTIALLY_FILLED',
  PARTIALFILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  CANCELED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
}

/**
 * Map an XTS status string. Returns null for anything unrecognised.
 *
 * Null, never a default. Guessing WORKING for an unknown status invents an
 * order that may not exist; guessing REJECTED discards one that does. An
 * unmapped status is an integration gap and must surface as one.
 */
export function mapOrderStatus(raw: string | undefined | null): OrderStatus | null {
  if (raw === undefined || raw === null) return null
  const key = raw.toUpperCase().replace(/[\s_-]/g, '')
  return STATUS_MAP[key] ?? null
}

// -------------------------------------------------------------------- errors

export type XtsErrorClass =
  /** Broker-side hiccup. Retry the SAME request unchanged. */
  | 'transient'
  /** Session died. Re-login, then retry. */
  | 'session'
  /**
   * THE REQUEST MAY HAVE REACHED THE EXCHANGE. A timeout, an abort, a dropped
   * socket — the response never came back, which says nothing at all about
   * whether the order went out.
   *
   * Both obvious responses are wrong. Retrying can place the same tranche
   * TWICE; asserting failure un-books a position that is live at the broker
   * (F-3: the desk then flattens against a leg it believes it does not hold).
   * The only instrument that can settle it is the broker's own order book, so
   * an order carrying this class is held NON-TERMINAL — `ambiguousTrancheIds`
   * — until the broker sweep either finds its trace or times it out.
   */
  | 'unknown'
  /** Retrying will not help. Surface it. */
  | 'fatal'

/**
 * Classify an XTS error response.
 *
 * The three families, from `xtsOrder.js:190-196`, plus a fourth the legacy file
 * never distinguished (`unknown` — see the class doc, and the fallthrough at the
 * end of this function):
 *
 *  - `X10203` / `e-request-0004` — "OMSInjector ... error while sending the
 *    request". The order never reached the exchange, so a retry cannot
 *    duplicate it. Safe and correct to resend.
 *  - `e-user-*` / `e-session-0005` / `e-session-00005` — the session token
 *    expired. Every subsequent order fails identically until re-login, so
 *    retrying without re-authenticating just burns attempts.
 *  - anything else — a real rejection (margin, price band, frozen quantity).
 *    Retrying an order the exchange actively refused risks placing it twice if
 *    the refusal was actually a timeout, so we stop.
 */
export function classifyXtsError(message: string | undefined | null): XtsErrorClass {
  if (message === undefined || message === null || message === '') return 'fatal'
  const m = message.toLowerCase()
  if (m.includes('x10203') || m.includes('e-request-0004') || m.includes('omsinjector')) {
    return 'transient'
  }
  if (m.includes('e-user-') || m.includes('e-session-')) return 'session'
  /**
   * XTS also reports an expired or unknown token in PROSE, with no `e-` code:
   * `"Token/Authorization not found"`, and — for the same dead session — a bare
   * `"Invalid Token"`. Observed on prod 2026-07-30 — the gateway reused a
   * stored token across a restart, every read came back with one of those
   * messages, and because they matched no code prefix they classified as
   * FATAL. Fatal means no relogin, so an expired token would have taken order
   * placement down for the rest of the session instead of recovering, which is
   * exactly the case the relogin path exists for.
   *
   * THE WORD `token` IS LOAD-BEARING in each of these. `"Invalid price"` and
   * `"Instrument not found"` are real rejections, and re-logging in for one of
   * those would retry an order the exchange actively refused.
   */
  if (
    m.includes('token') &&
    (m.includes('not found') || m.includes('expired') || m.includes('invalid'))
  ) {
    return 'session'
  }
  if (m.includes('authorization') && m.includes('not found')) return 'session'
  /**
   * TRANSPORT FAULTS ARE NOT REJECTIONS, and this test sits LAST — below
   * transient and session — on purpose. An OMSInjector error is KNOWN not to
   * have reached the exchange even when its text mentions a timeout, and an
   * expired token still needs a re-login; only a message that matched neither
   * gets read as "we never heard back".
   *
   * Before this class existed every one of these fell through to `fatal`, and
   * `main.ts` writes a fatal tranche into `failedTrancheIds` — terminal, zero
   * fill, REJECTED. A 15s XTS timeout on an order that actually filled
   * therefore un-booked a real position (F-3). See `XtsErrorClass`.
   */
  if (/timed out|timeout|abort|network|fetch failed|socket hang up|econnreset|etimedout|eai_again/.test(m)) {
    return 'unknown'
  }
  return 'fatal'
}

/** True when the response is a success envelope. */
export function isSuccess(resp: { type?: string } | null | undefined): boolean {
  return resp?.type === 'success'
}

// ------------------------------------------------------------------- pricing

/**
 * Round a price to the instrument tick, WITHOUT truncating to whole rupees.
 *
 * `xtsOrder.js:145` uses `parseInt(limitPrice)`, which turns a 2.90 option into
 * 2 — a 31% mispricing on the BHEL 470CE wing, and worse on anything cheaper.
 * MARKET orders hide it because they pass 0, so it lies dormant until the first
 * limit or stop order. Not reproduced here.
 */
export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price
  const q = price / tickSize
  const n = Math.round(q)
  // Guard the float error that makes 100.1/0.05 === 2001.9999999999998.
  const snapped = Math.abs(q - n) < 1e-9 ? n : Math.round(q)
  return Number((snapped * tickSize).toFixed(4))
}

export interface StopBand {
  readonly stopPrice: number
  readonly limitPrice: number
}

/**
 * XTS has no true stop-market, so a StopMarket becomes a StopLimit with a
 * protective band — the limit sits far enough through the stop that it fills
 * like a market order but cannot fill at an absurd price in a gap.
 *
 * The band widens for cheap instruments: 1% of a Rs.3 option is 3 paise, which
 * is well inside a single tick and would make the order behave like a pure
 * limit that never fills. `xtsOrder.js:152-163` splits at 1000 for the same
 * reason; the threshold is expressed here as a parameter rather than a literal.
 */
export function stopLimitBand(
  side: Side,
  stopPrice: number,
  tickSize: number,
  opts: { wideBandBelow?: number; narrowPct?: number; widePct?: number } = {},
): StopBand {
  const wideBandBelow = opts.wideBandBelow ?? 1000
  const pct = stopPrice > wideBandBelow ? (opts.narrowPct ?? 0.01) : (opts.widePct ?? 0.05)
  const limit = side === 'BUY' ? stopPrice * (1 + pct) : stopPrice * (1 - pct)
  return {
    stopPrice: roundToTick(stopPrice, tickSize),
    limitPrice: roundToTick(limit, tickSize),
  }
}

// ------------------------------------------------------------- correlation

const SEP = '|'

/**
 * Build the `orderUniqueIdentifier` XTS echoes back on its order socket.
 *
 * This is the ONLY correlation channel between an intent and the fill it
 * produces — XTS returns its own AppOrderID, which we cannot know in advance.
 * The legacy listener (`smp_order_listener.js:75`) already splits this on '|'
 * into `strategy` + `params`, so keeping the shape means an existing consumer
 * keeps working while the new gateway reads the same field.
 *
 * XTS caps this field, so the id is truncated rather than silently rejected by
 * the broker — a truncated correlation is recoverable, a refused order is not.
 */
export function correlationId(tag: string, clientOrderId: string, maxLength = 45): string {
  const joined = `${sanitise(tag)}${SEP}${sanitise(clientOrderId)}`
  return joined.length <= maxLength ? joined : joined.slice(0, maxLength)
}

export function parseCorrelationId(raw: string | undefined | null): {
  tag: string
  clientOrderId: string
} | null {
  if (raw === undefined || raw === null) return null
  const i = raw.indexOf(SEP)
  if (i < 0) return null
  const tag = raw.slice(0, i)
  const clientOrderId = raw.slice(i + 1)
  if (tag === '' || clientOrderId === '') return null
  return { tag, clientOrderId }
}

/** '|' is the separator, so it cannot appear inside either component. */
function sanitise(s: string): string {
  return s.replace(/\|/g, '-')
}

// ---------------------------------------------------------------- order type

const ORDER_TYPE_MAP: Readonly<Record<OrderType, string>> = {
  MARKET: 'Market',
  LIMIT: 'Limit',
  SL_MARKET: 'StopLimit',
  SL_LIMIT: 'StopLimit',
}

export function mapOrderType(t: OrderType): string {
  return ORDER_TYPE_MAP[t]
}

/** XTS exchange segment from the instrument's exchange. */
export function exchangeSegment(exchange: string): string {
  const e = exchange.toUpperCase()
  if (e === 'BFO' || e === 'BSEFO' || e === 'BSE') return 'BSEFO'
  if (e === 'NFO' || e === 'NSEFO') return 'NSEFO'
  if (e === 'NSE') return 'NSECM'
  return 'NSEFO'
}
