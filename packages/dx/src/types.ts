/**
 * Delta wire shapes — the fields this package reads, named as Delta names them
 * (delta-api-reference.md §3–§8). Prices, IVs and greeks arrive as STRINGS;
 * order sizes as integer contracts. Objects carry more fields than listed.
 */

export interface DxAssetRef {
  readonly id: number
  readonly symbol: string
}

export interface DxSpotIndexRef {
  readonly id: number
  readonly symbol: string
  readonly tick_size?: string
}

/**
 * `product_specs` fields that decide whether a NEW position may be opened.
 * `oi_reduce_only_mode` is present (true) only while the product's open
 * interest is over `max_oi_usd`; Delta then rejects every opening order with
 * `only_reduce_only_orders_allowed` (observed on the India testnet, 3 Nov 2026).
 */
export interface DxProductSpecs {
  readonly oi_reduce_only_mode?: boolean
  readonly only_reduce_only_orders_allowed?: boolean
  readonly max_oi_usd?: number
  readonly [k: string]: unknown
}

export interface DxProduct {
  readonly id: number
  readonly symbol: string
  /** `call_options | put_options | perpetual_futures | futures | spot | …` */
  readonly contract_type: string
  readonly state?: string
  readonly trading_status?: string
  readonly strike_price?: string | null
  /** ISO, e.g. `2026-11-04T12:00:00Z`; the authoritative expiry instant. */
  readonly settlement_time?: string | null
  readonly settlement_price?: string | number | null
  /** BTC per contract, `"0.001"`. */
  readonly contract_value: string
  readonly tick_size: string
  readonly underlying_asset?: DxAssetRef
  readonly spot_index?: DxSpotIndexRef
  readonly product_specs?: DxProductSpecs
  /** The leverage Delta margins a position at by default, e.g. `"100"`; varies by moneyness. */
  readonly default_leverage?: string | number | null
}

export interface DxTickerQuotes {
  readonly best_bid?: string | null
  readonly best_ask?: string | null
  readonly bid_size?: string | null
  readonly ask_size?: string | null
  readonly bid_iv?: string | null
  readonly ask_iv?: string | null
  readonly mark_iv?: string | null
}

export interface DxTickerGreeks {
  readonly delta?: string | null
  readonly gamma?: string | null
  readonly theta?: string | null
  readonly vega?: string | null
  readonly rho?: string | null
}

/** REST `/v2/tickers` row. */
export interface DxTicker {
  readonly symbol: string
  readonly product_id: number
  readonly contract_type?: string
  readonly strike_price?: string
  readonly mark_price?: string | null
  readonly mark_vol?: string | null
  readonly spot_price?: string | null
  readonly oi_contracts?: string | null
  readonly oi_value_usd?: string | null
  /** True while open interest is over the product's cap: closing orders only. */
  readonly oi_reduce_only_mode?: boolean
  readonly quotes?: DxTickerQuotes | null
  readonly greeks?: DxTickerGreeks | null
  /** MICROseconds. */
  readonly timestamp?: number
}

export type DxSide = 'buy' | 'sell'

/** `POST /v2/orders` body. Send `product_id` OR `product_symbol`, not both. */
export interface DxOrderRequest {
  readonly product_id?: number
  readonly product_symbol?: string
  /** Integer contracts. */
  readonly size: number
  readonly side: DxSide
  readonly order_type: 'limit_order' | 'market_order'
  /** On the tick, as a string. */
  readonly limit_price?: string
  readonly time_in_force?: 'gtc' | 'ioc'
  readonly post_only?: boolean
  readonly reduce_only?: boolean
  /** ≤ 32 chars, unique among OPEN orders. */
  readonly client_order_id?: string
}

export interface DxOrder {
  readonly id: number
  readonly product_id: number
  readonly product_symbol?: string
  readonly size: number
  readonly unfilled_size: number
  readonly side: string
  readonly order_type?: string
  readonly limit_price?: string | null
  readonly average_fill_price?: string | null
  /** `open | pending | closed | cancelled` */
  readonly state: string
  readonly client_order_id?: string | null
  readonly reduce_only?: boolean
  readonly cancellation_reason?: string | null
  readonly paid_commission?: string | null
}

export interface DxFill {
  readonly id: string
  readonly size?: string | number
  readonly price?: string
  readonly side?: string
  readonly role?: string
  readonly fill_type?: string
  readonly commission?: string
  readonly order_id?: string
  readonly product_id?: number
  readonly product_symbol?: string
  readonly created_at?: string
}

export interface DxPosition {
  readonly product_id: number
  readonly product_symbol: string
  /** Signed contracts: negative is short. */
  readonly size: number
  readonly entry_price: string | null
}

export interface DxBalance {
  readonly asset_id?: number
  readonly asset_symbol: string
  readonly balance: string
  readonly available_balance?: string
  [k: string]: unknown
}
