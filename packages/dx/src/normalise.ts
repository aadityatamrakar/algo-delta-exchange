/**
 * Delta → desk shapes: product → instrument row, ticker (REST or WS) → quote,
 * raw WS message → typed frame.
 *
 * A missing number is `null`, never 0: an empty bid is "no bid", and a reader
 * that sees 0 prices the leg at nothing.
 */
import type { InstrumentRow } from '@algomaker/instruments'
import type { DxProduct, DxSpotIndexRef, DxTicker } from './types.ts'

export const DX_EXCHANGE = 'DELTA'
export const DX_OPTION_SEGMENT = 'DX-OPT'
export const DX_INDEX_SEGMENT = 'DX-INDICES'
export const DX_SPOT_SYMBOL = '.DEXBTUSD'

/** Delta's numeric strings → number; '', null, undefined and non-finite → null. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Microseconds → milliseconds (floor), or null. */
const usToMs = (v: unknown): number | null => {
  const n = num(v)
  return n === null ? null : Math.floor(n / 1000)
}

/**
 * One BTC call or put → an instrument row; anything else → null.
 *
 * `expiry` is the UTC date of `settlement_time` (12:00 UTC on Delta), and
 * `instrument_token` is the Delta product id — the integer every order and
 * ticker for the contract carries.
 */
/**
 * An instrument row plus Delta's open-interest cap, from `product_specs`
 * (written by the marketdata sync so every desk process reads it off the
 * instrument master, with no REST on the order path). Both are set on every
 * option row — the flag `false` rather than absent — so an upsert clears a
 * lifted cap. Absent on the spot row.
 */
export type DxInstrumentRow = InstrumentRow & {
  /** `product_specs.max_oi_usd`; null when Delta lists none. */
  readonly dx_max_oi_usd?: number | null
  /** `product_specs.oi_reduce_only_mode` (or `only_reduce_only_orders_allowed`) at sync time. */
  readonly dx_oi_reduce_only?: boolean
}

export function toInstrumentRow(p: DxProduct): DxInstrumentRow | null {
  const type = p.contract_type === 'call_options' ? 'CE' : p.contract_type === 'put_options' ? 'PE' : null
  if (type === null) return null
  if (p.underlying_asset?.symbol !== 'BTC') return null
  const strike = num(p.strike_price)
  const lot = num(p.contract_value)
  const tick = num(p.tick_size)
  const settle = typeof p.settlement_time === 'string' ? new Date(p.settlement_time) : null
  if (strike === null || lot === null || tick === null || settle === null || Number.isNaN(settle.getTime())) return null
  return {
    instrument_token: p.id,
    tradingsymbol: p.symbol,
    name: 'BTC',
    expiry: settle.toISOString().slice(0, 10),
    strike,
    tick_size: tick,
    lot_size: lot,
    instrument_type: type,
    segment: DX_OPTION_SEGMENT,
    exchange: DX_EXCHANGE,
    dx_max_oi_usd: num(p.product_specs?.max_oi_usd),
    dx_oi_reduce_only:
      p.product_specs?.oi_reduce_only_mode === true || p.product_specs?.only_reduce_only_orders_allowed === true,
  }
}

/**
 * Can a NEW position be opened on this contract? False while Delta has it in
 * reduce-only mode — its open interest is over `max_oi_usd` (product or
 * ticker `oi_reduce_only_mode`) or the product is flagged
 * `only_reduce_only_orders_allowed`. Closing orders are still accepted.
 */
export function opensAllowed(x: DxProduct | DxTicker): boolean {
  if ('oi_reduce_only_mode' in x && x.oi_reduce_only_mode === true) return false
  const specs = 'product_specs' in x ? x.product_specs : undefined
  return specs?.oi_reduce_only_mode !== true && specs?.only_reduce_only_orders_allowed !== true
}

/**
 * A product's open interest in USD: `oi_contracts × contract_value × index`.
 * Verified against Delta's own `oi_value_usd` on 3 Nov 2026 (testnet
 * C-BTC-77200-041126: 55,371 × 0.001 × 76,462 = $4,233,772). Null when either
 * input is missing.
 */
export function oiUsdOf(oiContracts: number | null, contractValue: number, index: number | null): number | null {
  if (oiContracts === null || index === null || !Number.isFinite(oiContracts) || !Number.isFinite(index) || index <= 0) return null
  return Number((oiContracts * contractValue * index).toFixed(4))
}

/**
 * Which rule decided a cap check:
 *   flag            — Delta flags the product reduce-only, and the figures confirm it
 *   cap             — no flag, but a cap is listed: enforced anyway (Delta rejected
 *                     at the cap whether or not a flag was showing)
 *   flag-no-figures — flagged, but OI or cap unknown: capped on Delta's word
 *   no-figures      — no flag and OI or cap unknown: cannot be checked, not capped
 */
export type OiCapBasis = 'flag' | 'cap' | 'flag-no-figures' | 'no-figures'

export interface OiCapStatus {
  /** A NEW position here would be refused (`only_reduce_only_orders_allowed`). */
  readonly capped: boolean
  readonly basis: OiCapBasis
  readonly oiUsd: number | null
  readonly capUsd: number | null
  /** capUsd − oiUsd; negative when over. */
  readonly headroomUsd: number | null
}

/**
 * The cap check: capped when OI + this order's notional is at or over the cap.
 * The reduce-only flag only decides the case with a figure missing.
 */
export function oiCapCheck(a: {
  readonly oiUsd: number | null
  readonly capUsd: number | null
  readonly reduceOnly: boolean
  readonly orderNotionalUsd?: number
}): OiCapStatus {
  const { oiUsd, capUsd } = a
  const headroomUsd = oiUsd === null || capUsd === null ? null : Number((capUsd - oiUsd).toFixed(4))
  if (oiUsd === null || capUsd === null) {
    return { capped: a.reduceOnly, basis: a.reduceOnly ? 'flag-no-figures' : 'no-figures', oiUsd, capUsd, headroomUsd }
  }
  const capped = oiUsd + Math.max(0, a.orderNotionalUsd ?? 0) >= capUsd
  return { capped, basis: a.reduceOnly ? 'flag' : 'cap', oiUsd, capUsd, headroomUsd }
}

/**
 * The cap check off a REST product and ticker (the demo rail's path): OI from
 * the ticker's `oi_contracts` × contract value × its `spot_price` (else
 * `index`), cap and flag from the product's specs (the ticker's flag counts too).
 */
export function oiCapStatus(
  product: DxProduct,
  ticker: DxTicker | null,
  orderNotionalUsd = 0,
  index: number | null = null,
): OiCapStatus {
  const specs = product.product_specs
  const cv = num(product.contract_value) ?? 0.001
  const idx = num(ticker?.spot_price) ?? index
  return oiCapCheck({
    oiUsd: oiUsdOf(num(ticker?.oi_contracts), cv, idx),
    capUsd: num(specs?.max_oi_usd),
    reduceOnly:
      specs?.oi_reduce_only_mode === true ||
      specs?.only_reduce_only_orders_allowed === true ||
      ticker?.oi_reduce_only_mode === true,
    orderNotionalUsd,
  })
}

/** The `.DEXBTUSD` index as the chain's spot row (`OptionMaster` matches the INDICES segment). */
export function spotInstrumentRow(idx: DxSpotIndexRef = { id: 14, symbol: DX_SPOT_SYMBOL, tick_size: '0.5' }): InstrumentRow {
  return {
    instrument_token: idx.id,
    tradingsymbol: idx.symbol,
    name: 'BTC',
    expiry: '',
    strike: 0,
    tick_size: num(idx.tick_size) ?? 0.5,
    lot_size: 0.001,
    instrument_type: 'INDEX',
    segment: DX_INDEX_SEGMENT,
    exchange: DX_EXCHANGE,
  }
}

/** Every BTC option row, plus one spot row taken from the first option's `spot_index`. */
export function toInstrumentRows(products: readonly DxProduct[]): DxInstrumentRow[] {
  const rows: DxInstrumentRow[] = []
  let spot: DxSpotIndexRef | undefined
  for (const p of products) {
    const row = toInstrumentRow(p)
    if (row === null) continue
    rows.push(row)
    if (spot === undefined && p.spot_index?.symbol === DX_SPOT_SYMBOL) spot = p.spot_index
  }
  if (rows.length > 0) rows.push(spotInstrumentRow(spot))
  return rows
}

/**
 * A quote for one contract — what the option-chain page and `md.tick` need.
 *
 * Prices USD per 1 BTC; sizes in contracts; IVs decimals (0.46 = 46 %);
 * greeks as Delta reports them (delta per 1 BTC; theta/vega units are not
 * documented by Delta — see the API reference §4).
 *
 * `oi`: from REST this is `oi_contracts` (contracts). From the WS `ticker`
 * frame it is the first element of `oi`, which Delta does not label; treat its
 * unit as UNCONFIRMED until checked against REST on a live frame.
 */
export interface DxQuote {
  readonly symbol: string
  readonly productId: number | null
  readonly mark: number | null
  readonly spot: number | null
  readonly bid: number | null
  readonly ask: number | null
  readonly bidSize: number | null
  readonly askSize: number | null
  /** Mark IV. */
  readonly iv: number | null
  readonly bidIv: number | null
  readonly askIv: number | null
  readonly oi: number | null
  readonly delta: number | null
  readonly gamma: number | null
  readonly theta: number | null
  readonly vega: number | null
  readonly rho: number | null
  /** Exchange timestamp, ms; null when the message carries none. */
  readonly tsMs: number | null
  /**
   * Delta accepts only reduce-only orders on this contract (open interest over
   * its cap): a new short here is rejected `only_reduce_only_orders_allowed`.
   * From REST tickers; null from the WS ticker, which does not carry it.
   */
  readonly oiReduceOnly: boolean | null
}

/** REST `/v2/tickers` row → quote. */
export function quoteFromTicker(t: DxTicker): DxQuote {
  const q = t.quotes ?? {}
  const g = t.greeks ?? {}
  return {
    symbol: t.symbol,
    productId: num(t.product_id),
    mark: num(t.mark_price),
    spot: num(t.spot_price),
    bid: num(q.best_bid),
    ask: num(q.best_ask),
    bidSize: num(q.bid_size),
    askSize: num(q.ask_size),
    iv: num(q.mark_iv ?? t.mark_vol),
    bidIv: num(q.bid_iv),
    askIv: num(q.ask_iv),
    oi: num(t.oi_contracts),
    delta: num(g.delta),
    gamma: num(g.gamma),
    theta: num(g.theta),
    vega: num(g.vega),
    rho: num(g.rho),
    tsMs: usToMs(t.timestamp),
    oiReduceOnly: typeof t.oi_reduce_only_mode === 'boolean' ? t.oi_reduce_only_mode : null,
  }
}

const at = (xs: unknown, i: number): unknown => (Array.isArray(xs) ? xs[i] : undefined)

/**
 * WS `ticker` → quote. Two forms reach here:
 *
 *   COMPACT (what Delta's public socket actually sends, probe 3 Nov 2026):
 *     {type:'ticker', sy, sp, ts, d:[{s, i, m, q, qiv, g, oi, …}, …]}
 *     — one quote per element of `d`; `sp`/`ts` sit on the envelope (an
 *     element's own `sp`/`ts` wins when present).
 *   FLAT (the docs' sample): the same element keys on the envelope itself.
 *
 *   q   = [best_ask, ask_size, best_bid, bid_size, impact_mid]
 *   qiv = [ask_iv, bid_iv, mark_iv]
 *   g   = [delta, gamma, rho, theta, vega]   (null for futures) — order
 *         cross-checked against the REST greeks of the same product
 *   oi  = [contracts, ?] — the first matches REST `oi_contracts` in scale; the
 *         second is not a plain contracts × spot value (UNCONFIRMED), unused
 */
function quoteFromTickerElement(e: Record<string, unknown>, env: Record<string, unknown>): DxQuote {
  const g = e['g']
  const q = e['q']
  const qiv = e['qiv']
  return {
    symbol: String(e['s'] ?? e['sy'] ?? env['sy'] ?? ''),
    productId: num(e['i']),
    mark: num(e['m']),
    spot: num(e['sp'] ?? env['sp']),
    ask: num(at(q, 0)),
    askSize: num(at(q, 1)),
    bid: num(at(q, 2)),
    bidSize: num(at(q, 3)),
    askIv: num(at(qiv, 0)),
    bidIv: num(at(qiv, 1)),
    iv: num(at(qiv, 2)),
    oi: num(at(e['oi'], 0)),
    delta: num(at(g, 0)),
    gamma: num(at(g, 1)),
    rho: num(at(g, 2)),
    theta: num(at(g, 3)),
    vega: num(at(g, 4)),
    tsMs: usToMs(e['ts'] ?? env['ts']),
    oiReduceOnly: null,
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

export type DxFrame =
  /** One contract's quote. A compact message with N symbols is N of these (`parseFrames`). */
  | { readonly kind: 'ticker'; readonly quote: DxQuote }
  | { readonly kind: 'spot'; readonly symbol: string; readonly price: number | null; readonly tsMs: number | null }
  /** `mark_price`; `symbol` without Delta's `MARK:` prefix. */
  | { readonly kind: 'mark'; readonly symbol: string; readonly price: number | null; readonly tsMs: number | null }
  | {
      readonly kind: 'ob_l1'
      readonly symbol: string
      readonly ask: number | null
      readonly askSize: number | null
      readonly bid: number | null
      readonly bidSize: number | null
      readonly tsMs: number | null
    }
  | { readonly kind: 'subscriptions'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'auth'; readonly ok: boolean; readonly raw: Record<string, unknown> }
  /** Everything else — private channels included — untouched. */
  | { readonly kind: 'other'; readonly raw: unknown }

/**
 * A parsed WS message (already JSON-decoded) → typed frames. Usually one; a
 * compact `ticker` yields one per element of `d` (none for an empty `d`).
 * The sockets deliver these one at a time.
 */
export function parseFrames(raw: unknown): DxFrame[] {
  if (!isRecord(raw)) return [{ kind: 'other', raw }]
  const m = raw
  switch (m['type']) {
    case 'ticker': {
      const d = m['d']
      if (Array.isArray(d)) {
        return d.filter(isRecord).map((e) => ({ kind: 'ticker', quote: quoteFromTickerElement(e, m) }) as const)
      }
      return [{ kind: 'ticker', quote: quoteFromTickerElement(m, m) }]
    }
    case 'spot_price':
      return [{ kind: 'spot', symbol: String(m['sy'] ?? ''), price: num(m['p']), tsMs: usToMs(m['ts']) }]
    case 'mark_price':
      return [{ kind: 'mark', symbol: String(m['sy'] ?? '').replace(/^MARK:/, ''), price: num(m['p']), tsMs: usToMs(m['ts']) }]
    case 'ob_l1':
      return [{
        kind: 'ob_l1',
        symbol: String(m['sy'] ?? ''),
        ask: num(m['ap']),
        askSize: num(m['as']),
        bid: num(m['bp']),
        bidSize: num(m['bs']),
        tsMs: usToMs(m['ts']),
      }]
    case 'subscriptions':
      return [{ kind: 'subscriptions', raw: m }]
    case 'heartbeat':
      return [{ kind: 'heartbeat' }]
    case 'key-auth':
      return [{ kind: 'auth', ok: m['success'] === true, raw: m }]
    default:
      return [{ kind: 'other', raw: m }]
  }
}

/**
 * The FIRST frame of a message — exact for every message type except a
 * compact `ticker` carrying several symbols, where only `d[0]` is returned.
 * Use `parseFrames` wherever a message may carry more than one symbol (the
 * sockets do). A compact ticker with an empty `d` is `{kind:'other'}`.
 */
export function parseFrame(raw: unknown): DxFrame {
  return parseFrames(raw)[0] ?? { kind: 'other', raw }
}
