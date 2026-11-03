# Delta Exchange India API: integration reference (BTC options, TypeScript/Node 24)

Date of research: 2026-11-03. No authenticated call was made; no order placed. Four kinds of source:

- **[DOCS]** the official docs, https://docs.delta.exchange (the page is the India edition: every example uses api.india.delta.exchange; the changelog says separate India and Global doc sites exist). Downloaded in full and read.
- **[LIVE]** unauthenticated GETs against https://api.india.delta.exchange on 2026-11-03 (products, tickers, l2orderbook, trades, candles, indices, rate_limits/quota). Payloads below marked LIVE are real.
- **[CLIENT]** official python client source, github.com/delta-exchange/python-rest-client (pushed 2026-04-23). The official node client (github.com/delta-exchange/node-client, last push 2022) is a swagger wrapper and stale; do not use it. Write a thin fetch client.
- **[HELP]** Delta India help-centre and fee pages (delta.exchange/fees, support articles, guides.delta.exchange).

Anything not confirmed by one of these is marked UNCONFIRMED.

---------------------------------------------------------------------

## 1. Environments

| | REST | WebSocket public (market data, no auth) | WebSocket private (auth: orders, positions, margins, fills) |
|---|---|---|---|
| Prod India | `https://api.india.delta.exchange` | `wss://public-socket.india.delta.exchange` | `wss://socket.india.delta.exchange` |
| Testnet India ("Demo") | `https://cdn-ind.testnet.deltaex.org` | `wss://socket-ind-pub.testnet.deltaex.org` | `wss://socket-ind.testnet.deltaex.org` |

[DOCS]. `https://api.delta.exchange` is Delta GLOBAL; it cannot be used with India keys.

- Each environment is independent: keys, secrets, product_id, asset_id and user_id all differ [CLIENT docstring]. Never hardcode product ids; resolve them from /v2/products per environment.
- Testnet keys: created on the Demo account (demo.delta.exchange; the docs' own wording is "API keys created at Demo account must be used only with testnet apis"). The exact menu path on the Demo site is UNCONFIRMED (the production path is https://www.delta.exchange/app/account/manageapikeys). Using a prod key on testnet, or the reverse, returns `invalid_api_key`.
- Prod REST sits behind CloudFront (`via: ... cloudfront.net`) [LIVE]. Delta's data centre is AWS Tokyo [DOCS].

## 2. Authentication

### Headers (all authenticated requests) [DOCS]
```
api-key:    <key>
timestamp:  <unix SECONDS, integer string>
signature:  <hex HMAC-SHA256>
User-Agent: <anything non-empty>      // mandatory, else 4xx / 403 "Request blocked by CDN"
Content-Type: application/json
```

### Pre-hash string
`method + timestamp + requestPath + queryString + body` (plain concatenation).

- `method` is upper case (`GET`, `POST`, `PUT`, `DELETE`).
- `requestPath` is the path including `/v2`, e.g. `/v2/orders`.
- `queryString` INCLUDES the leading `?` (`?product_id=1&state=open`); empty string if there is none. Docs example: `GET1542110948/v2/orders?product_id=1&state=open`. The client builds it as `'?' + '&'.join(key=quote_plus(str(value)))` in the same order the params are sent. Sign exactly the string you send.
- `body` is the exact raw JSON string sent on the wire. The official client uses compact JSON (`separators=(',',':')`). Build the string once, sign it, and send that same string. Empty string for GET and for DELETE without body.
- HMAC key is the API secret (utf-8), output hex digest. Signing of `DELETE /v2/orders` with a body: body is included in the pre-hash like any other method [CLIENT: same code path for all methods].

### Official signing code [CLIENT, python]
```python
def generate_signature(secret, message):
  message = bytes(message, 'utf-8'); secret = bytes(secret, 'utf-8')
  return hmac.new(secret, message, hashlib.sha256).hexdigest()
def get_time_stamp():            # integer seconds, UTC
  return str(int((datetime.datetime.utcnow() - datetime.datetime(1970,1,1)).total_seconds()))
signature_data = method + timestamp + path + query_string(query) + body_string(payload)
```

### TypeScript equivalent (suggested)
```ts
import { createHmac } from 'node:crypto';
export function sign(secret: string, method: string, path: string, query: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();   // seconds
  const signature = createHmac('sha256', secret).update(method + timestamp + path + query + body).digest('hex');
  return { timestamp, signature };
}
// query = '' or '?a=1&b=2' (exactly as sent); body = JSON.stringify(obj) or ''
// headers: { 'api-key': key, timestamp, signature, 'User-Agent': 'algomaker/1', 'Content-Type': 'application/json' }
```

### Validity window
Signature must reach Delta within **5 seconds** of its timestamp [DOCS]. Generate the timestamp right before each send (never reuse or queue pre-signed requests, and retries need a fresh signature). Server clock skew matters: run chrony/NTP. The error response carries server time and request time.

### Errors [DOCS, verbatim]
| Case | Body |
|---|---|
| Bad / deleted key / wrong env | `{"success":false,"error":{"code":"invalid_api_key"}}` |
| Bad signature | `{"success":false,"error":{"code":"Signature Mismatch"}}` |
| Expired signature (>5 s) | `{"error":"SignatureExpired","message":"your signature has expired"}` (note: different envelope, no `success`) |
| Key lacks permission | `{"error":"UnauthorizedApiAccess","message":"Api Key not authorised to access this endpoint"}` |
| IP not whitelisted | `{"success":false,"error":{"code":"ip_not_whitelisted_for_api_key"}}`; the error response contains the IP Delta saw, so you can whitelist it |
| Missing User-Agent / CDN block | `{"error":"Forbidden","message":"Request blocked by CDN"}` (HTTP 403) |

HTTP codes: 400, 401 (bad key/signature), 403 (CDN), 404, 405, 406, 429, 500, 503 (maintenance).

### Key permissions and IP whitelist [DOCS]
- Two permissions: **Read Data** and **Trading** (trading covers place/cancel orders, close positions, change margin and leverage). The docs text says orders/positions/wallets "require Trading permission"; whether Read-only keys can GET orders and wallet is UNCONFIRMED. Create the key with both.
- A key with Trading permission REQUIRES at least one whitelisted IP (IPv4 or IPv6, comma-separated list allowed). Requests from other IPs fail. Whitelist the production box's static public IPv4 AND make sure Node uses IPv4 (set `dns.setDefaultResultOrder('ipv4first')`, or whitelist both).
- Key creation is blocked for 30 min after more than 5 wrong OTP/MFA entries.

## 3. Products

### Endpoints
- `GET /v2/products` (public). Docs params: `contract_types` (comma list: `perpetual_futures,futures,call_options,put_options,spot`), `states` (`upcoming,live,expired`; `settled` also accepted [LIVE], see below), `after`, `before`, `page_size` (default 100), `expiry` (`YYYY-MM-DD`).
- **Undocumented but verified [LIVE]**: `underlying_asset_symbols=BTC` also filters `/v2/products` (BTC calls: total_count 277). `page_size=1000` returned all 927 live options in one response (3.9 MB), so max page size is at least 1000. `expiry=2026-11-04` returned all products with that expiry date across ALL underlyings and settlement times (including a 16:00 UTC XAUT set), so filter by underlying too.
- `GET /v2/products/{symbol}` (public), e.g. `/v2/products/C-BTC-80400-041126`.
- Pagination is cursor based: response `meta` = `{"after": "...", "before": null, "limit": 100, "total_count": 927}`; pass `after=<cursor>` for the next page; cursor changes each page; `after: null` means last page.

### Symbol format
`C-BTC-80400-041126` = `{C|P}-{UNDERLYING}-{STRIKE}-{DDMMYY}` (call/put, BTC, strike in USD, expiry 04 Nov 2026). Puts start `P-`. Perpetual is `BTCUSD` (product id 27 on prod). Spot index `.DEXBTUSD`. Mark price series are prefixed `MARK:` (e.g. `MARK:C-BTC-80400-041126`), OI series `OI:BTCUSD`, funding `FUNDING:BTCUSD` (candles only).

### Real BTC option product [LIVE 2026-11-03] (nested asset objects trimmed)
```json
{
 "id": 161447, "symbol": "C-BTC-80400-041126", "contract_type": "call_options",
 "description": "BTC call option expiring on 4-11-2026", "short_description": "BTC  Call",
 "state": "live", "trading_status": "operational", "disruption_reason": null,
 "strike_price": "80400", "settlement_time": "2026-11-04T12:00:00Z", "settlement_price": null,
 "launch_time": "2026-11-01T12:10:16Z", "auction_start_time": "2026-11-01T12:10:16Z", "auction_finish_time": null,
 "contract_value": "0.001", "contract_unit_currency": "BTC", "tick_size": "0.1",
 "notional_type": "vanilla", "is_quanto": false, "barrier_price": null,
 "underlying_asset": {"id": 13, "symbol": "BTC", "precision": 8, "minimum_precision": 4},
 "quoting_asset":   {"id": 14, "symbol": "USD", "precision": 8, "minimum_precision": 2},
 "settling_asset":  {"id": 14, "symbol": "USD", "precision": 8, "minimum_precision": 2},
 "spot_index": {"id": 14, "symbol": ".DEXBTUSD", "index_type": "spot_pair", "is_composite": true, "price_method": "orderbook", "tick_size": "0.5", "impact_size": "1"},
 "maker_commission_rate": "0.0001", "taker_commission_rate": "0.0001",
 "position_size_limit": 50000, "position_notional_limit": null,
 "impact_size": 200, "impact_notional": "10000",
 "price_band": "2",
 "initial_margin": "0.5", "maintenance_margin": "0.25",
 "initial_margin_scaling_factor": "0.000002", "maintenance_margin_scaling_factor": "0.000001",
 "default_leverage": "200.000000000000000000", "max_leverage_notional": "200000",
 "liquidation_penalty_factor": "0.5", "insurance_fund_margin_contribution": "5",
 "funding_method": "mark_price", "annualized_funding": "10.95", "basis_factor_max_limit": "10.95",
 "product_specs": {
   "premium_commission_rate": 0.035, "max_oi_usd": 30000000,
   "min_volatility": 0.1, "max_volatility": 3,
   "vol_calculation_method": "orderbook", "vol_expiry_time": 31536000, "backup_vol_expiry_time": 31536000,
   "max_deviation_from_external_vol": 0.75, "max_lower_deviation_from_external_vol": 0.75, "max_upper_deviation_from_external_vol": 1.2,
   "isolated_liq_penalty_factor": 0.0005, "isolated_liq_premium_penalty_factor": 0.2,
   "only_reduce_only_orders_allowed": false, "synth_fut_symbol": "SYN-BTC-041126-1200"
   /* some products also carry "upl_haircut_enabled": true */ },
 "ui_config": {"default_trading_view_candle":"60","leverage_slider_values":[1,2,5,10,25,50,100,200],"price_clubbing_values":[0.1,0.5,1,2.5,5,10],"show_bracket_orders":false,"sort_priority":1,"tags":[]}
}
```
Field meanings that matter:
- **`contract_value: "0.001"` with `contract_unit_currency: "BTC"`: one contract (lot) = 0.001 BTC.** All 533 live BTC options have it. Order `size` is an integer number of lots. Minimum order size = 1 lot (inferred from integer `size`; the exact min is not a product field; `less_than_order_min_size` is the rejection code, UNCONFIRMED value).
- **Premium is quoted in USD per 1 BTC**, not per lot. A lot costs `price * 0.001` USD. Example: mark 18.69 means $18.69 per BTC, i.e. $0.0187 per lot. `tick_size` is 0.1 (USD, per 1 BTC).
- Fees: `maker_commission_rate = taker_commission_rate = 0.0001` = 0.01% of notional (notional = size * 0.001 * spot). Capped at `product_specs.premium_commission_rate` 0.035 = 3.5% of premium [LIVE; HELP page says 3.5%, the fees page text once says "3.5% 10%"; trust the product field]. Perp is 0.02% maker / 0.05% taker.
- `position_size_limit` 50000 lots (= 50 BTC) per product. `max_oi_usd` 30,000,000.
- `price_band: "2"` (percent-style band; the ticker returns the absolute band, see section 4).
- `default_leverage`, `initial_margin` (percent) vary by moneyness: observed values 100/20/200 and 1/5/0.5 across the chain.
- `state`: `live | upcoming | expired` documented [DOCS]; `trading_status`: `operational | disrupted_cancel_only | disrupted_post_only` [DOCS] (post-only = opening auction; cancel-only = halted). Newly launched contracts show `disrupted_post_only` with `disruption_reason: "New Contract Launched"` during their opening auction [LIVE, XAUT sample].
- Expired products: `state: "expired"`, `settlement_price` is `0` for worthless options [LIVE]. Querying `states=settled,expired` returned 10,000 BTC rows, so the history is deep (use pagination).

### Expiry cadence and times [LIVE, derived from 533 live BTC options]
- **Every expiry settles at 12:00:00 UTC = 17:30 IST** (all 533 BTC options). Note XAUT options settle at 16:00 UTC; do not assume one time across underlyings.
- Live on 2026-11-03: 3 consecutive daily expiries (Nov 3, 4, 5), then Fridays (Nov 6, 13, 20, 27), then month-end Fridays (Dec 25, Jan 29). Help page confirms "daily expiries in both BTC and ETH options". New expiries launch at ~12:00-12:20 UTC (launch_time) with an opening auction.
- Strike spacing varies per expiry: dailies 200 (core) / 400 (wings); the Nov 6 weekly 500 / 1000; Nov 13/20 500 / 1000; Nov 27, Dec 25, Jan 29: 1000. Number of strikes per expiry: 21-43 each side-combined. Spacing shifts with spot, so always read the chain, never compute strikes.
- Settlement style: cash-settled in USD against the **30-minute TWAP of the index (.DEXBTUSD)** ending at settlement [HELP: Delta's settlement-price article says "30-minute TWAP of the underlying calculated at the time of contract settlement"; WS channel `spot_30mtwap_price` is documented as "the price used for settlement of options"]. Exercise style (European) is not stated in a primary source I fetched: UNCONFIRMED but consistent with cash settlement at expiry only.
- The product `settlement_time` is the authoritative expiry instant. Existing positions are auto-settled; a settlement fee at taker rate applies to open contracts at settlement, but **no fee for options that expire worthless** [HELP].

## 4. Tickers (option chain)

- `GET /v2/tickers` params: `contract_types` (comma list), `underlying_asset_symbols` (comma list), `expiry_date` (**`DD-MM-YYYY`**, e.g. `04-11-2026`). [DOCS + LIVE: with BTC options and 04-11-2026 returned 56 tickers, success true, no meta]. No pagination: unfiltered BTC options = 533 tickers, 683 KB [LIVE]. Weighted 3 units of quota.
- `GET /v2/tickers/{symbol}`: comma-separated list allowed, max 10 symbols [DOCS].
- Chain call: `/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=BTC&expiry_date=04-11-2026`.

### Real option ticker [LIVE]
```json
{
 "symbol":"C-BTC-80400-041126","product_id":161447,"contract_type":"call_options",
 "underlying_asset_symbol":"BTC","strike_price":"80400","description":"BTC  Call",
 "contract_value":"0.001000000000000000","tick_size":"0.100000000000000000",
 "mark_price":"18.68624892","mark_vol":"0.43500606",
 "spot_price":"76568.3",
 "close":17.9,"open":263.0,"high":263.0,"low":17.9,
 "ltp_change_24h":"-93.1939","mark_change_24h":"-92.9061","mark_high_24h":"276.01613912","mark_low_24h":"15.87566657",
 "volume":89.89000000000001,"size":89890,
 "turnover":6921597.8871,"turnover_symbol":"USD","turnover_usd":6921597.8871,
 "oi":"34.4330","oi_contracts":"34433","oi_value":"34.4330","oi_value_symbol":"BTC","oi_value_usd":"2634744.2940","oi_change_usd_6h":"1946950.1800",
 "oi_reduce_only_mode":false,
 "greeks":{"delta":"0.02601024","gamma":"0.00003164","theta":"-48.09878952","vega":"2.65196498","rho":"0.06483250","spot":"76573.1"},
 "quotes":{"best_bid":"18","bid_size":"2000","bid_iv":"0.43237468","best_ask":"20","ask_size":"11644","ask_iv":"0.43984734","mark_iv":"0.43500606","impact_mid_price":null},
 "price_band":{"lower_limit":"0.10000000","upper_limit":"340.68687866"},
 "product_trading_status":"operational","leverage":200,"tags":[],"top_tag":"","sort_priority":1,
 "time":"2026-11-02T07:06:24.684513964Z","timestamp":1793689974590778
}
```
Notes:
- Prices (mark, best_bid/ask, greeks, iv) are **strings**; `close/open/high/low/volume/size/turnover` are JSON **numbers**; sizes in `quotes` are strings.
- `timestamp` is microseconds. `time` is an ISO string and in this sample did not match `timestamp` (stale by a day, cause unknown): trust `timestamp`, and cross-check staleness on `quotes`, since an illiquid strike can carry old last-trade fields.
- **IV fields are decimals, not percent**: `mark_vol` / `quotes.mark_iv` 0.435 = 43.5%. Bid/ask IV are in `quotes.bid_iv` / `quotes.ask_iv`. `quotes.best_bid/best_ask` are `""`/null when a side is empty (UNCONFIRMED exact empty form).
- Greeks are strings; delta is per 1 BTC of underlying (0.026 on the 80,400 call); theta/vega units (USD per day / per 1.00 vol vs per 1 vol-point) are NOT documented: UNCONFIRMED. Sample theta -48 against a 18.7 mark looks like a different scale (possibly per-1-BTC annualized or stale); validate against your own Black-Scholes before trusting.
- `oi` for options is in BTC (`oi_contracts` * 0.001); `oi_contracts` is lots.
- `price_band.lower/upper_limit` are absolute price limits for orders (here 0.1 to 340.69). Orders outside the band are rejected (error code not documented, UNCONFIRMED).
- `spot_price` is the `.DEXBTUSD` index. The perp ticker `BTCUSD` has the same shape with `greeks` null.
- Underlying index: `.DEXBTUSD` (BTC/USD). `.DEXBTUSDT` is a USDT-flavoured variant being discontinued 18 Oct 2026 (already off).
- **Volatility index**: no Delta-published vol index found. `/v2/indices` returned no symbol containing VOL/DVOL [LIVE]. You must derive vol from `mark_vol` / ATM `mark_iv` yourself. (Option `product_specs` shows `min_volatility 0.1`, `max_volatility 3`, i.e. mark IV is clamped to 10%-300%.)

## 5. Orderbook, trades, candles

### `GET /v2/l2orderbook/{symbol}?depth=N` (public, weight 3) [LIVE]
```json
{"success":true,"result":{"symbol":"C-BTC-80400-041126",
 "buy":[{"size":14710,"depth":"1.471E+4","price":"18.0"},{"size":12743,"depth":"27453","price":"17.0"}],
 "sell":[{"size":11651,"depth":"11651","price":"20.0"},{"size":11673,"depth":"23324","price":"22.0"}],
 "last_updated_at":1793690010071000}}
```
`buy` = bids (best first), `sell` = asks. `size` is an integer lot count, `price` a string, `depth` the cumulative size as a STRING that may be in scientific notation ("1.471E+4"): never parse `depth` as plain integer; compute your own cumulative sum. `last_updated_at` is microseconds.

### `GET /v2/trades/{symbol}` (public) [LIVE]
```json
{"success":true,"result":[{"size":15,"timestamp":1793689473000000,"symbol":"C-BTC-80400-041126","price":"17.9","buyer_role":"maker","seller_role":"taker"}]}
```
Newest first; microsecond timestamps; no cursor documented.

### `GET /v2/history/candles` (public, weight 3)
Params: `resolution`, `symbol`, `start`, `end` (**unix seconds**). Max **2000 candles per response**. Resolutions in docs: `1m,3m,5m,15m,30m,1h,2h,4h,6h,12h,1d,1w` (7d, 2w, 30d removed Oct 2025). Symbol prefixes: `MARK:<symbol>` mark-price candles, `OI:<symbol>` open interest, `FUNDING:<symbol>`, `.DEXBTUSD` index. [LIVE: all four returned data, including option traded candles and option mark candles].
```json
{"success":true,"result":[{"time":1793689200,"open":17.9,"high":17.9,"low":17.9,"close":17.9,"volume":15.0}, {"time":1793685600, ...}]}
```
Result is NEWEST FIRST; `time` is candle start in seconds; numbers are JSON numbers; `volume` is null on mark/index/OI series; **candles with no trades are omitted** (a 2h window returned only 2 of the hourly candles; illiquid options have gaps). Option candles exist, and expired-option candles are presumably retained (UNCONFIRMED).

## 6. Orders

All are signed. Weights: place/edit/delete 5; batch 25; active orders 3; history/fills 10.

### `POST /v2/orders` body (CreateOrderRequest) [DOCS]
| field | type | notes |
|---|---|---|
| `product_id` (int) OR `product_symbol` (string) | | send only one |
| `size` | integer | number of lots (contracts); required |
| `side` | `buy`/`sell` | |
| `order_type` | `limit_order`/`market_order` | |
| `limit_price` | string | required for limit; since 2026-04-15 values <= 0 are rejected; omit the field or send null for market orders. Must be a multiple of `tick_size` (0.1 for BTC options); send as string, never float |
| `time_in_force` | `gtc`/`ioc` | **`fok` was removed 2024-05-01** (the python client enum still lists it; ignore). Default gtc |
| `post_only` | bool | rejected with `immediate_execution_post_only` if it would cross |
| `reduce_only` | bool | |
| `client_order_id` | string | **max 32 chars; must be unique across the user's OPEN orders** (not globally). Allowed charset not documented: use `[A-Za-z0-9_-]` |
| `mmp` | `disabled`,`mmp1`..`mmp5` | market-maker protection tier |
| `cancel_orders_accepted` | bool | if true, cancels existing orders on the product to free margin |
| `stop_order_type` | `stop_loss_order`/`take_profit_order` | `liquidation_order` appears only in responses |
| `stop_price`, `trail_amount`, `stop_trigger_method` (`mark_price`/`last_traded_price`/`spot_price`) | | stop orders |
| `bracket_stop_loss_price`, `bracket_stop_loss_limit_price`, `bracket_take_profit_price`, `bracket_take_profit_limit_price`, `bracket_trail_amount`, `bracket_stop_trigger_method` | strings | bracket attached to the order |

Docs type some booleans as "string"; the example payloads send real JSON booleans (`"post_only": false`). Use booleans.

Sample [CLIENT/DOCS signed example]: `{"order_type":"limit_order","size":3,"side":"buy","limit_price":"0.0005","product_id":16}`.

### Order response (also returned by cancel/edit/get) [DOCS]
```json
{"success":true,"result":{
 "id":123,"user_id":453671,"product_id":27,"product_symbol":"BTCUSD",
 "size":10,"unfilled_size":2,"side":"buy","order_type":"limit_order","limit_price":"59000",
 "average_fill_price":"8999.00","state":"open","time_in_force":"gtc","post_only":false,"reduce_only":false,
 "client_order_id":"my_signal_34521712","cancellation_reason":"cancelled_by_user",
 "stop_order_type":null,"stop_price":null,"stop_trigger_method":"last_traded_price","trail_amount":null,
 "bracket_order":false,"mmp":"disabled",
 "paid_commission":"0.5432","commission":"0.5432",
 "created_at":"1725865012000000","updated_at":"1725865012000000"}}
```
`created_at`/`updated_at` here are microsecond epoch STRINGS (docs examples) whereas product timestamps are ISO. IDs: order `id` is an integer (JS safe-integer risk: parse as string/BigInt if ids can exceed 2^53; UNCONFIRMED, current ids look small). `state` values: `open`, `pending` (untriggered stop), `closed` (fully filled), `cancelled`. Observed `cancellation_reason` e.g. `cancelled_by_user` (full list UNCONFIRMED).

### Other order endpoints [DOCS]
- **Edit** `PUT /v2/orders` body `{id, product_id|product_symbol, limit_price, size, post_only, mmp, stop_price, trail_amount}` (size = new total size). Re-runs all margin/risk checks. Error `open_order_not_found` if already filled/cancelled.
- **Cancel** `DELETE /v2/orders` body `{id, client_order_id, product_id}` (id OR client_order_id). Returns the order object.
- **Active orders** `GET /v2/orders?product_ids=1,2&states=open,pending&contract_types=&order_types=&start_time=&end_time=&after=&before=&page_size=` (max 10 product ids; times in MICROseconds; order_types: `market,limit,stop_market,...`).
- **By id** `GET /v2/orders/{order_id}`; **by client id** `GET /v2/orders/client_order_id/{client_oid}`.
- **Cancel all** `DELETE /v2/orders/all` body `{product_id?, contract_types?: "call_options,put_options", cancel_limit_orders?, cancel_stop_orders?, cancel_reduce_only_orders?}`; product_id wins over contract_types; empty body cancels everything. Returns only `{"success":true}`.
- **Batch create** `POST /v2/orders/batch` body `{product_id|product_symbol, orders:[{limit_price,size,side,order_type,post_only,mmp,client_order_id,...}]}`. **Max 50 orders, all must be the same product (contract)**. Limit orders only; no stops; all orders are GTC (IOC not valid). Weight 25. Product-level engine limit: 500 operations/s/product, each order in a batch counts as one op. Per-order failure semantics (partial success vs all-or-nothing) UNCONFIRMED.
- **Batch edit** `PUT /v2/orders/batch` `{product_id, orders:[{id,limit_price,size,mmp,post_only}]}`; **batch cancel** `DELETE /v2/orders/batch` `{product_id, orders:[{id|client_order_id}]}`.
- **Bracket** `POST /v2/orders/bracket`, `PUT /v2/orders/bracket`. **Close all positions** `POST /v2/positions/close_all` `{close_all_portfolio, close_all_isolated, user_id}`: closes positions in operational products, skips halted or auction products, does NOT cancel open orders (changed 2026-10-16).
- **Order leverage** `POST /v2/products/{product_id}/orders/leverage` `{"leverage":"10"}`; `GET /v2/products/{product_id}/orders/leverage`.
- **Order history** `GET /v2/orders/history` (product_ids, contract_types, order_types, start_time, end_time, after, before, page_size). Since Jan 2026: no `total` in meta; max page_size 50 (planned/at-most; larger values return 50).
- **Fills** `GET /v2/fills` same filter set. Fill object [DOCS]: `id` (UUID string), `size` (string), `notional` (string, price*size*contract_value), `price` (string), `side`, `role` (`maker`/`taker`), `fill_type` (`normal|liquidation|settlement|adl|otc`), `commission` (string), `created_at`, `product_id`, `product_symbol`, `order_id` (string), `settling_asset_symbol`, `product{...}`, `meta_data{effective_commission_rate, order_price, order_size, order_type, order_unfilled_size, total_commission_in_settling_asset, mark, spot, ...}`, `new_position{size, margin, entry_price, liquidation_price, realized_pnl, realized_cashflow, realized_funding, total_commission_paid, last_fill_uuid,...}`. Settlement at expiry shows up as `fill_type: "settlement"`.
- `GET /v2/fills/history/download/csv`: CSV export.

### Market orders on options
`market_order` exists in the enum and a user preference `showMarketOrdersForOptionsInBracket` exists, and error codes `no_liquidity_for_market_order` and `unsupported` ("Market order couldn't be validated for price impact as orderbook data isn't available") imply market orders are price-impact checked. I could not confirm via a primary source that plain market orders are accepted on options: UNCONFIRMED; test on testnet. Safer: marketable limit orders with IOC.

### Order error codes (HTTP 400, `error.code`, with `error.context`) [DOCS]
`insufficient_margin` (context `additional_margin_required`), `close_position_insufficient_margin`, `insufficient_commission`, `order_size_exceed_available` (IOC liquidity), `order_size_not_available_in_orderbook`, `close_order_position_unavailable`, `risk_limits_breached`, `invalid_contract` (expired/missing), `immediate_liquidation`, `out_of_bankruptcy`, `self_matching_disrupted_post_only`, `overlapping_buy_sell_orders` (self-trade prevention), `immediate_execution_post_only`, `naked_short_restricted`, `portfolio_risk_limits_breached`, `liquidation_risk_limits_breached`, `greeks_limits_breached`, `no_position_for_reduce_only`, `no_position_left_for_reduce_only`, `max_leverage_exceeded`, `min_leverage_exceeded`, `leverage_limit_exceeded`, `order_already_filled`, `less_than_order_min_size`, `order_max_size_exceeded`, `reduce_only_orders_allowed(_sell_side)`, `trading_blocked`, `kyc_pending`, `derivatives_trading_blocked`, `account_risk_limits_breached`, `position_under_liquidation`, `stale_order`, `no_orders`, `no_liquidity_for_market_order`, `family_position_limit_exceeded`, `trading_not_allowed_on_current_margin_mode`, `max_orders_count_exceeded` (open-order cap, number UNCONFIRMED), `offset_by_reduce_only`. Edit-only: `open_order_not_found`.

## 7. Positions, money, margin

- `GET /v2/positions?product_id=161447` or `?underlying_asset_symbol=BTC` (real-time; exactly one of the two params; returns `size`, `entry_price`; NO margin fields). Weight 3.
- `GET /v2/positions/margined?product_ids=...&contract_types=call_options,put_options` (max 10 ids). Fields: `user_id, size, entry_price, margin, liquidation_price, bankruptcy_price, adl_level, product_id, product_symbol, realized_pnl, realized_funding, commission, auto_topup, created_at, updated_at, product{...}`. **Lags up to 10 s after a fill**; use `/positions` for real-time. `size` is signed (negative = short), in lots.
- `PUT /v2/positions/auto_topup` `{product_id, auto_topup}`; `POST /v2/positions/change_margin` `{product_id, delta_margin}` (isolated).
- `GET /v2/wallet/balances` -> `result[]` per asset with `asset_id, asset_symbol, balance, available_balance, blocked_margin, order_margin, position_margin, commission, portfolio_margin, cross_order_margin, cross_position_margin, cross_commission, cross_locked_collateral, cross_asset_liability, interest_credit, trading_fee_credit, pending_trading_fee_credit, pending_referral_bonus, unvested_amount, available_balance_for_robo, user_id, id`; `meta: {net_equity, robo_trading_equity}`. All strings. `GET /v2/wallet/transactions` (paginated, weight 10).
- `GET /v2/users/trading_preferences`, `PUT /v2/users/trading_preferences` (`default_auto_topup`, notification prefs).
- **Margin modes**: `PUT /v2/users/margin_mode` body `{"margin_mode":"isolated"|"portfolio","subaccount_user_id":"<id>"}` [DOCS]. `portfolio` = shared risk-based margin (SPAN-like stress matrix, greeks limits; documented via the `portfolio_margins` channel: IM = max(risk_margin, margin_floor) - UCF, MM = 80% of that). `isolated` = per position. Docs describe a cross-collateral set of wallet fields too. Which mode is the default for a new India account, whether retail accounts are allowed to switch to portfolio margin, and eligibility rules are UNCONFIRMED. Query via the margins channel / wallet fields and test on testnet. Expect `trading_not_allowed_on_current_margin_mode` if mismatched. Risk-error codes `portfolio_risk_limits_breached` and `greeks_limits_breached` only fire under portfolio margin.
- Naked short option selling is allowed subject to `naked_short_restricted` limits and margin.
- **MMP** (`PUT /v2/users/update_mmp`, `PUT /v2/users/reset_mmp`, WS `mmp_trigger`): per underlying asset config `{asset, window_interval(s), freeze_interval(s; 0 = manual reset), trade_limit (USD notional), delta_limit, vega_limit, mmp}`; per-order opt-in with the `mmp` field. Since June 2026 docs no longer say you must ask support; availability to ordinary accounts UNCONFIRMED.
- **Dead-man's switch** [DOCS] (REST, authenticated):
  1. `POST /v2/heartbeat/create` `{"heartbeat_id":"bot1","impact":"contracts","contract_types":["call_options","put_options"],"underlying_assets":["BTC"],"config":[{"action":"cancel_orders","unhealthy_count":1}],"default_ttl":30000}` (impact `contracts` or `products`; with `products` give `product_symbols`; action `spreads` needs integer `value`). `default_ttl` ms applies after a system restart until next ack.
  2. `POST /v2/heartbeat` `{"heartbeat_id":"bot1","ttl":30000}` every ~25 s (ttl ms; ttl 0 disables); response `{"heartbeat_timestamp":"<next expiry>","process_enabled":"true"}`.
  3. `GET /v2/heartbeat[?heartbeat_id=]` lists. On expiry with `unhealthy_count` misses the system cancels open orders (positions are not closed). This is the cancel-on-disconnect equivalent; there is no WS-disconnect-triggered cancel documented. Note the docs' Node/Python samples use `https://api.delta.exchange` and paths without `/v2`; on India use `https://api.india.delta.exchange/v2/heartbeat...`.
- Sub-accounts: `GET /v2/sub_accounts`, `POST /v2/wallets/sub_account_balance_transfer`.
- `GET /v2/profile` is no longer accessible with API keys since 2026-08-19.

## 8. WebSocket

### Endpoints and limits [DOCS]
- Public data: `wss://public-socket.india.delta.exchange`. Private data: `wss://socket.india.delta.exchange` (auth required for private channels).
- **150 new connections per 5 min per IP**; excess gets HTTP 429 on upgrade; wait 5-10 min.
- Disconnected if no activity within **60 s** of connecting.
- `ob_l2` and `ob_updates`: max **100 symbols per connection**. Other limits per subscription not documented.
- Generic message envelope: `{"type":"subscribe","payload":{"channels":[{"name":"ticker","symbols":["BTCUSD"]}]}}`; ack `{"type":"subscriptions","channels":[{"name":"...","symbols":[...]}]}` (errors appear per channel as `"error": "subscription forbidden on ...  Unauthorized user"`). Subsequent subscribes add to the list. Unsubscribe is the same shape with `type:"unsubscribe"`, omit `symbols` to drop the whole channel. `symbols:["all"]` works on most channels (no snapshots for "all"). Category names (`call_options`, `put_options`, `perpetual_futures`, `futures`) and option-chain names also work on some channels (see below).
- Heartbeat (recommended): send `{"type":"enable_heartbeat"}` after each connect; server sends `{"type":"heartbeat"}` every 30 s; if none in 35 s reconnect. Alternative: send `{"type":"ping"}` every ~30 s, expect `{"type":"pong"}` within 5 s (also protocol-level ping/pong frames work). Disable with `{"type":"disable_heartbeat"}`.

### Private auth [DOCS], `key-auth`
Pre-hash is `"GET" + timestamp + "/live"` (no query, no body), HMAC-SHA256 hex, timestamp in seconds:
```json
{"type":"key-auth","payload":{"api-key":"<key>","signature":"<hex>","timestamp":"1793690000"}}
```
Response: `{"type":"key-auth","success":true,"status_code":200,"status":"authenticated"}`. Errors (all `type:"key-auth","success":false`): 400 `incomplete_payload`; 408 `request_expired` ("Timestamp header outside of allowed time window", >5 s); 404 `api_key_not_found`; 401 `invalid_signature`; 401 `ip_not_whitelisted` ("IP address not whitelisted. Your IP: x.x.x.x"); 500 `internal_server_error`. The old `{"type":"auth"}` method is deprecated, final removal 31 Oct 2026 (already past), so use only `key-auth`. `{"type":"unauth","payload":{}}` deauthenticates.

### Channel migration (IMPORTANT)
The lead's channel names are the OLD ones. Per the changelog the old public ones on the private endpoint were retired 31 Oct 2026 (final notice 14 Oct; whether they have actually stopped answering is UNCONFIRMED, don't rely on them):
`l1_orderbook`->`ob_l1`, `l2_orderbook`->`ob_l2`, `l2_updates`->`ob_updates`, `v2/ticker`->`ticker`, `all_trades`->`trades`, `v2/spot_price`->`spot_price`. New public endpoint also hosts `mark_price`, `candlesticks`, `spot_price`, `funding_rate`, `system_status`.
Old `l1ob`/`l1ob_c` (compressed chain) channels still appear in the docs as legacy text: skip.

### Public channels (compact keys) [DOCS sample frames]
- **`ticker`** (every 5 s; symbols required; option-chain shorthand `BTC-041126` = all BTC options expiring 04 Nov 2026, format `ASSET-DDMMYY`):
```json
{"type":"ticker","sy":"BTCUSD","s":"BTCUSD","i":27,"m":"72124.5397","m24hc":"1.5902","sp":"72154.6","ts":1775801092453559,
 "g":["delta","gamma","rho","theta","vega"],            // actual: ["0.0194","0.00006","0.0072","-81.48","0.7249"], null for futures
 "ohlc":[71009.0,73135.5,70495.0,72123.5],"oi":["537395","4457821.69"],"pb":["68495.16","75705.18"],
 "q":["72101","822","72100","2123",null],              // best_ask, ask_size, best_bid, bid_size, impact_mid
 "qiv":["0.25","0.25","-0.378"],                        // ask_iv, bid_iv, mark_iv (options only)
 "to":[1153493034.07,1153493034.07]}                    // turnover, turnover_usd
```
Greeks order in `g`: delta, gamma, rho, theta, vega.
- **`ob_l1`** (100 ms, max 5 s if unchanged): `{"type":"ob_l1","sy":"BTCUSD","ap":"68519.0","as":"285","bp":"68518.0","bs":"2452","lts":...,"ts":...}`. Accepts option-chain shorthand (`BTC-310326`).
- **`ob_l2`** (top 15 levels, 500 ms, 10 s max): `{"type":"ob_l2","sy":..,"a":[["68525.0","3313"],...],"b":[...],"lts":..,"ts":..}` (strings; sizes in lots). No "all".
- **`ob_updates`** (snapshot then deltas, 100 ms): `{"type":"ob_updates","action":"snapshot"|"update"|"error","sy","a":[[price,size]],"b":[...],"seq":6199,"ts":..,"cs":2178756498}`. Size "0" deletes the level; `seq` must be +1 each message, else resubscribe; `cs` is CRC32 (unsigned) of `"p:s,p:s,...(top 10 asks)|p:s,...(top 10 bids)"`; `action:"error"` -> resubscribe after a few seconds. No categories or "all".
- **`trades`**: `{"type":"trades","sy":"BTCUSD","p":"72141.5","s":1.0,"r":"m","t":1775800366578410,"ts":1775800367003029}` (`r` = buyer role m/t; categories/chain names/"all" allowed).
- **`mark_price`** (every 2 s, symbols prefixed `MARK:`): `{"type":"mark_price","sy":"MARK:C-BTC-69500-100426","p":"2296.35","ts":..}`; chain shorthand `BTC-310524` allowed.
- **`candlesticks`**: channel name `candlestick_<res>` with res in `1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w`; `MARK:<sym>` for mark candles; frame `{"type":"candlestick_1m","sy":..,"res":"1m","o":..,"h":..,"l":..,"c":..,"v":..,"ts":..}`.
- **`spot_price`**: `{"type":"spot_price","sy":".DEXBTUSD","p":"76588.6","ts":..}`, symbols required. **`spot_30mtwap_price`**: the settlement TWAP feed (`.DEXBTUSD`), frame `{"type":"spot_30mtwap_price","symbol":..,"price":..,"timestamp":..}` (long keys, unlike the others).
- **`funding_rate`** (perps): `{"fr":..,"fi":28800,"nfr":<us>,"sy":..}`.
- **`product_updates`** (no symbols): events `market_disruption` (-> `disrupted_cancel_only`), `start_auction` (-> `disrupted_post_only`), `finish_auction` (-> `operational`), with `product{id,symbol,trading_status,timestamp}`.
- **`system_status`** (no symbols): `status` live/maintenance/api_fallback/degraded_mode; events `maintenance_scheduled` (usually 6-24 h ahead), `maintenance_started`, `maintenance_finished` (followed by a 5-10 min auction), `maintenance_cancelled`; times in microseconds. A snapshot arrives on subscribe.

### Private channels (authenticated connection) [DOCS]
- **`orders`** (symbols or "all"/categories): snapshot `{"type":"orders","action":"snapshot","symbol":..,"result":[...],"meta":{"seq_no":7,"timestamp":..}}`, then `action` create/update/delete, with `reason` (`fill`, `stop_update`, `stop_trigger`, `stop_cancel`, `liquidation`, `self_trade`, null), `order_id`, `client_order_id`, `size`, `unfilled_size`, `average_fill_price`, `limit_price`, `side`, `state`, `cancellation_reason`, `stop_*`, `bracket_*`, `seq_no` (per-symbol, incrementing), `timestamp` (us).
- **`positions`**: snapshot (`action:"snapshot"`, `result[]` with product_id, product_symbol, size, entry_price, margin, liquidation_price, bankruptcy_price, realized_pnl, realized_funding, adl_level, auto_topup...) then `create/update/delete` with `reason` null/`auto_topup`; `size > 0` long.
- **`v2/user_trades`** (fast fills, no commission): `{"type":"v2/user_trades","sy":"BTCUSD","f":"<fill uuid>","R":"normal|adl|liquidation","u":user,"o":order_id,"S":"buy","s":190,"p":"17289.2","po":5,"r":"taker","c":"<client_order_id>","t":us,"se":4}`; `po` = position after the fill; `se` per-symbol sequence resetting to 1 after system restart. **`user_trades`** is the slower variant with commission.
- **`margins`** (no symbols): `{"type":"margins","action":"update","asset_id":..,"asset_symbol":..,"balance":..,"available_balance":..,"blocked_margin":..,"order_margin":..,"position_margin":..,"portfolio_margin":..,"cross_*":..,"commission":..,"timestamp":us,...}`.
- **`portfolio_margins`** (symbols `[".DEXBTUSD"]`, every 2 s, only if the sub-account is in portfolio margin mode): `blocked_margin, im_w_ucf, mm_w_ucf, risk_margin, margin_floor, liquidation_risk, under_liquidation, margin_shortfall, risk_matrix...`.
- **`mmp_trigger`**: `{user_id, asset, frozen_till}` (frozen_till -1 = manual reset needed).

## 9. Rate limits [DOCS + LIVE]
- Fixed (NOT rolling) window: **20,000 units per 5 minutes**, resets to full every 5 min. Unauthenticated calls are throttled per IP; authenticated per user id. A higher quota can be requested from support.
- Weights: **3** = products, orderbook, tickers, open orders, open positions, balances, OHLC candles; **5** = place/edit/delete order, add position margin; **10** = order history, fills, transaction logs; **25** = batch order APIs; every other endpoint 1.
- Product-level engine limit: 500 matching-engine operations/s per product (a 50-order batch = 50 ops). Can 429 even if the REST quota is fine.
- On breach: HTTP **429**; header `X-RATE-LIMIT-RESET` = milliseconds until the next call is allowed. Other quota-related headers are not documented (a normal 200 from the public endpoint shows no rate-limit headers [LIVE]).
- `GET /v2/rate_limits/quota` (works without auth, per IP) returns `{"current_quota":36,"remaining_time_in_milliseconds":88425}` [LIVE]. I read `current_quota` as units used in the current window, but the docs do not say whether it means used or remaining: UNCONFIRMED. Calibrate by making a known-weight call.
- Budget example: polling the 533-ticker BTC chain costs 3 units per call; 1 call/s = 900 units per 5 min. Prefer the WS `ticker`/`ob_l1` chain subscriptions for the book.

## 10. Fees [HELP + product fields LIVE]
- BTC options: maker = taker = **0.01% of notional** (`0.0001`), notional = lots * 0.001 * spot (index). **Capped at 3.5% of the option premium** (`premium_commission_rate: 0.035`); the cap matters for cheap OTM options. Example from the help article: 0.3 BTC at premium $150, strike 90,000: raw fee 0.01% x $27,000 = $2.70, cap 3.5% x $45 = $1.575 -> fee is $1.575.
- **GST 18% on top of the trading (and liquidation) fee** (e.g. $20 fee -> $23.6).
- **Settlement fee**: charged on all open contracts at settlement at taker rate; none if the option expires worthless [HELP]. Whether the cap applies to settlement fee is UNCONFIRMED.
- BTC perp: maker 0.02%, taker 0.05% [LIVE product fields; matches help page].
- Fee is charged in the settling asset (USD); the wallet balance is shown in INR on India (section 11). Scalper/fee-credit promos exist (`trading_fee_credit` wallet fields).

## 11. India specifics [HELP + DOCS]
- Contracts are **notionally quoted, margined and settled in USD, but the platform uses a FIXED USD-INR rate and balances are always held in INR; no INR/USD conversion ever occurs**, so P&L is effectively INR at a constant rate (guides.delta.exchange). The numeric rate is not on the pages I fetched: UNCONFIRMED. Query `GET /v2/wallet/balances` once with a funded account to see which asset(s) appear (the docs' own examples show `asset_symbol` strings only) and how `balance` is denominated (INR or USD-quoted INR).
- Product responses show `quoting_asset` and `settling_asset` as `USD` (id 14) with an `INR_BANKING` network [LIVE]. Don't assume INR in the API; verify with a small deposit.
- Tax (from the India user guide, not tax advice): derivatives never convert crypto, so Delta says the 1% TDS and 30% flat crypto tax are not applicable to F&O and loss offsetting is allowed; both DO apply to Spot buys on Delta India. GST 18% on fees. Have an accountant confirm the treatment for algorithmic trading.
- Spot (INR pairs) exists (`BTC_INR` etc.) but is irrelevant here.
- KYC and `kyc_pending` / `derivatives_trading_blocked` error codes indicate account gating.

## 12. Market hours, maintenance, halts
- 24x7x365 trading [HELP]. No holiday calendar.
- Expiries run at 12:00 UTC (17:30 IST) daily; a daily option dies for new risk at 17:30 IST; new contracts open ~12:00-12:20 UTC via a single-price opening auction (`trading_status: disrupted_post_only`, `auction_start_time`/`auction_finish_time` on the product). During the auction you can post and cancel but nothing matches; self-match errors apply (`self_matching_disrupted_post_only`).
- Halts: `disrupted_cancel_only` (cancel only, no matching), then auction to resume. `product_updates` WS channel announces both.
- Maintenance: announced via WS `system_status` (typically 6-24 h before; unscheduled maintenance may arrive as `maintenance_started` alone), followed by a 5-10 min auction after finish. REST returns 503 during maintenance. Maintenance times are estimates.
- Index outage / mark-price failures are not described. Products have a daily-style price band (`price_band`).

## 13. Gotchas
1. **Signature string includes `?`** and the exact query order/encoding as sent; body is the exact bytes. Compact JSON.
2. **Timestamps are SECONDS in auth** (HTTP header, WS key-auth) but MICROSECONDS in order/ticker/trade/orderbook payloads and in `start_time`/`end_time` of orders/fills queries; candle `start`/`end` and candle `time` are SECONDS; products use ISO strings.
3. **5-second signature window** + fixed (not rolling) rate window. NTP sync is mandatory; re-sign every retry.
4. **User-Agent mandatory** (403 from the CDN otherwise), and the key must come from the IP whitelist; Node/undici may pick IPv6.
5. Prices/IV/greeks are **strings**; send `limit_price` as a string with the correct tick; `size` is an integer (JSON number); candle OHLC and ticker `close/open/high/low/volume/turnover` are numbers; `depth` in the l2 book can be "1.471E+4".
6. **Option price is per 1 BTC, lot = 0.001 BTC.** Cost per lot = price * 0.001. Ticker `volume` is in BTC and `size` in lots; `oi` in BTC, `oi_contracts` in lots.
7. IVs are decimals (0.435). `mark_vol` is also in the ticker top-level. No vol index exists.
8. `product_id` differs per environment; use `product_symbol` in order bodies, but the orderbook/leverage endpoints key on ids in places ("Orders, Orderbook APIs expect Product IDs" in docs; the l2orderbook GET accepts the symbol [LIVE]).
9. `client_order_id` max 32, unique among OPEN orders only; reuse after close is fine. Use it for idempotent retries and as the key in the `orders` stream.
10. `fok` is gone; batch has no IOC; batch is single-product, max 50; limit_price <= 0 rejected; send null/omit for market.
11. `/v2/positions/margined` lags up to 10 s; use `/v2/positions` or the WS `positions` / `v2/user_trades` (`po`) for real-time.
12. Product list default page size 100; request `page_size` explicitly and follow `meta.after` until null. Orders/fills history max page_size 50, no `total`.
13. Cursors change per page; do not reuse.
14. Different expiries have different strike steps and different settlement times by underlying (BTC 12:00 UTC, XAUT 16:00 UTC). Daily options carry 3-ish live expiries; do not assume contiguity.
15. Illiquid strikes: wide or one-sided books, stale last-trade fields; mark price is vol-surface based, not last trade. Use `quotes.*` and `mark_price`.
16. Under auction (`disrupted_post_only`) an option can show overlapping bid/ask; no matching.
17. WS: use the NEW channel names; compact keys (`sy`, `ap`...) differ from REST; check `seq`/`seq_no`/`se` gaps and resync from REST snapshots; sequence resets after system restart; 150 connections/5 min/IP; idle 60 s disconnect; enable heartbeat; re-auth and re-subscribe on every reconnect (subscriptions don't persist).
18. Error envelopes differ: most are `{"success":false,"error":{"code","context"}}`, but SignatureExpired / Forbidden / UnauthorizedApiAccess are `{"error":"...","message":"..."}`. Parse both.
19. Testnet is its own world (own keys, ids, liquidity, wallet); the python client says "Each environment is fully independent". Option chains on testnet may be sparse: UNCONFIRMED.
20. Docs examples elsewhere show `api.delta.exchange` (Global) in the Deadman Switch samples; replace with the India host.
21. There is a Delta MCP server (`uvx delta-exchange-mcp`, github.com/delta-exchange/delta-exchange-mcp) and CCXT (`ccxt.delta` with `urls.api` overridden to the India host, per the docs); I did not inspect CCXT's quirks. Recommend a thin hand-written fetch + `ws` client, signature code above.
22. Swagger JSON: https://docs.delta.exchange/api/swagger_v2.json (referenced in the node client README; not fetched).

## Not confirmed from a primary source (summary)
European/cash-settlement wording; exact min order size; whether market orders work on options; batch partial-failure semantics; numeric USD-INR rate and wallet currency presentation; portfolio-margin eligibility and the default margin mode on India; greeks scaling and units; allowed `client_order_id` charset; open-order count cap; whether the old WS channels still respond; testnet key-creation path and testnet chain depth; MMP availability to ordinary accounts; ccxt quirks; quota-endpoint semantics.
