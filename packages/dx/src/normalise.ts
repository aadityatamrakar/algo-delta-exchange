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
export function toInstrumentRow(p: DxProduct): InstrumentRow | null {
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
  }
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
export function toInstrumentRows(products: readonly DxProduct[]): InstrumentRow[] {
  const rows: InstrumentRow[] = []
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
  }
}

const at = (xs: unknown, i: number): unknown => (Array.isArray(xs) ? xs[i] : undefined)

/**
 * WS `ticker` frame (compact keys) → quote.
 *   q   = [best_ask, ask_size, best_bid, bid_size, impact_mid]
 *   qiv = [ask_iv, bid_iv, mark_iv]
 *   g   = [delta, gamma, rho, theta, vega]   (null for futures)
 */
function quoteFromTickerFrame(m: Record<string, unknown>): DxQuote {
  const g = m['g']
  const q = m['q']
  const qiv = m['qiv']
  return {
    symbol: String(m['sy'] ?? m['s'] ?? ''),
    productId: num(m['i']),
    mark: num(m['m']),
    spot: num(m['sp']),
    ask: num(at(q, 0)),
    askSize: num(at(q, 1)),
    bid: num(at(q, 2)),
    bidSize: num(at(q, 3)),
    askIv: num(at(qiv, 0)),
    bidIv: num(at(qiv, 1)),
    iv: num(at(qiv, 2)),
    oi: num(at(m['oi'], 0)),
    delta: num(at(g, 0)),
    gamma: num(at(g, 1)),
    rho: num(at(g, 2)),
    theta: num(at(g, 3)),
    vega: num(at(g, 4)),
    tsMs: usToMs(m['ts']),
  }
}

export type DxFrame =
  | { readonly kind: 'ticker'; readonly quote: DxQuote }
  | { readonly kind: 'spot'; readonly symbol: string; readonly price: number | null; readonly tsMs: number | null }
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

/** A parsed WS message (already JSON-decoded) → typed frame. */
export function parseFrame(raw: unknown): DxFrame {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'other', raw }
  const m = raw as Record<string, unknown>
  switch (m['type']) {
    case 'ticker':
      return { kind: 'ticker', quote: quoteFromTickerFrame(m) }
    case 'spot_price':
      return { kind: 'spot', symbol: String(m['sy'] ?? ''), price: num(m['p']), tsMs: usToMs(m['ts']) }
    case 'ob_l1':
      return {
        kind: 'ob_l1',
        symbol: String(m['sy'] ?? ''),
        ask: num(m['ap']),
        askSize: num(m['as']),
        bid: num(m['bp']),
        bidSize: num(m['bs']),
        tsMs: usToMs(m['ts']),
      }
    case 'subscriptions':
      return { kind: 'subscriptions', raw: m }
    case 'heartbeat':
      return { kind: 'heartbeat' }
    case 'key-auth':
      return { kind: 'auth', ok: m['success'] === true, raw: m }
    default:
      return { kind: 'other', raw: m }
  }
}
