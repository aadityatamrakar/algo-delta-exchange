# Delta desk — BULL-S on BTC options (paper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paper BULL-S books on Delta Exchange India BTC options (daily/weekly/monthly × jump 1/2), managed 24x7 by the
supervisor, Dials editable, P&L net of Delta fees in USD, in the separate `/opt/algomaker-delta` desk.

**Architecture:** The clone keeps the NSE process topology and collection names (its own db `algomaker_dx`), adds a
pure `packages/venue` that every time/quantity/currency site reads, a Delta client `packages/dx`, a fourth desk-engine
decide path `decideBullS`, and re-points marketdata (feed + products) and the gateway (live adapter, fees, settlement)
at Delta. Everything selects DX through `DESK_VENUE=dx`; the pure packages default to NSE so upstream parity suites
keep running as regression tests.

**Tech Stack:** Node 24 (type-stripping — erasable TS only: no `enum`, `namespace`, parameter properties), node:test,
vitest+jsdom (web), mongodb driver 3.7.3, `ws` 8, React 19 + Vite. No new runtime dependencies.

**Spec:** `docs/specs/2026-11-03-dx-bull-s-design.md` (research in `docs/research/delta/`).

## Global Constraints

- Repo `/opt/algomaker-delta` only. Never edit, run or restart anything of `/opt/algomaker`. Never push (`upstream`
  push URL is disabled on purpose). Mongo db `algomaker_dx`; test dbs `algomaker_dx_*`; ports 8890–8897; pm2 `dx-*`,
  namespace `dx`. The isolation guard test from commit 1 must stay green.
- No network in tests: Delta REST/WS are exercised through fixtures (`packages/dx/test/fixtures/*.json`, captured from
  the 3 Nov public snapshot in `docs/research/delta/`).
- Delta facts, verbatim from the spec §4: REST `https://api.india.delta.exchange`; public WS
  `wss://public-socket.india.delta.exchange` channels `ticker`, `ob_l1`, `ob_l2`, `trades`, `spot_price`; private WS
  `wss://socket.india.delta.exchange` (`key-auth`, sign `GET<ts>/live`); signature
  `hex(HMAC_SHA256(secret, METHOD + ts + path + query(with '?') + body))`, headers `api-key`/`timestamp`/`signature`,
  ts in seconds, 5 s validity, `User-Agent` mandatory; contract 0.001 BTC; size = integer contracts; price USD per BTC;
  tick 0.1; settlement 12:00 UTC (17:30 IST) on the 30-min TWAP of `.DEXBTUSD`; `client_order_id` ≤ 32 chars; prices
  sent as strings; tif `gtc`/`ioc`; batch ≤ 50; rate limit 20,000 units / 5 min, 429 + `X-RATE-LIMIT-RESET`;
  fee = min(0.01 % × notional, 3.5 % × premium) + 18 % GST; 1 USD = 85 INR.
- Paper can never reach Delta: the dx gateway sends to the Delta adapter only when `mode === 'live'` exactly AND
  `DESK_DX_LIVE=1`; anything else → simulator.
- Quantity on the desk side is BTC on a 0.001 grid (`lots` = contracts, `lotSize` = 0.001); integer contracts at the
  exchange edge. No site may turn a non-zero quantity into 0 silently.
- House rules kept: required state fields over optional ones; a typed off-state for every dial; unique-index locks for
  idempotency; nothing incomplete presented as complete.
- Each commit message ends with `Claude-Session: https://claude.ai/code/session_01RxihRU7Qnr979tvZyWUmsZ`.
- Tests on this box: run `nice -n 19`, node `--test-concurrency=2`, vitest `--maxWorkers=2`, `DESK_REQUIRE_MONGO=1`.
  Lanes that run api/supervisor Mongo suites (T2, T6, T7) never run them at the same time as each other.

## Review Focus

1. **Stale or missing index price** (feed gap, WS reconnect, Delta maintenance): BULL-S must neither enter nor count a
   crossing off a reference older than `bs_ref_max_age_s`, and on the first fresh price after a gap it re-baselines
   (no phantom crossing, no burst). → T3 test `stale ref neither enters nor crosses; fresh ref after a gap re-baselines`.
2. **Missing ask on a leg** (thin wing, quote not yet received): the stop must not fire on a null/zero exit price and
   must not treat the straddle as safe either — it holds and says so in the reason. → T3 test `null ask holds the stop
   and names the leg`.
3. **Float drift in 0.001 quantities** (0.05 + 0.05 + 0.05, partial fills of 1 contract): flat must be exactly 0 and
   contracts must round-trip. → T1 tests on `roundToStep`/`contractsOf`; T2 test `three 50-contract fills then a
   150-contract close leaves qty exactly 0`.
4. **The settlement minute** (book evaluated at 11:59:59 and 12:00:01 UTC; Delta's settlement price published late):
   no entry inside the blackout, no close order after the instant, legs booked only at Delta's published price, an
   alert (not an invented close) if it is missing 30 min after. → T3 test `no orders at or after the expiry instant`;
   T6 test `settlement waits for Delta's price and never invents one`.
5. **Restart with an entry still working** (supervisor restarts while a straddle's PE filled and CE is working): no
   second straddle at that level, the half-filled group is rebuilt and either completed or closed. → T3 test
   `hydrated state with ceOpen=false peOpen=true does not re-enter the level`; T7 test on host restart.

---

### Task 0: Isolation (commit 1) — agent `dx-isolate`

Own db/ports/pm2/cookies + guard test.

### Task 0b: fresh history (operator, 3 Nov: "remove old git history, start fresh from here")

After Task 0: one orphan root commit of the isolated tree (`Initial commit: Delta desk — from algomaker 0d390c37,
isolated`), replacing `master`, force-pushed to `origin` (`aadityatamrakar/algo-delta-exchange`). `upstream` stays
fetchable, so an NSE fix still comes across with `git fetch upstream && git cherry-pick <sha>`. Every later task
branches from this root.

### Task P: prune and organize (operator, 3 Nov: "organize context/docs/memory", "refactor, remove dead code, streamline")

Runs beside T1/T3/T4; T8 starts after it. Owns deletions outside `apps/marketdata`, `apps/order-gateway` and
`packages/desk-engine` (T5/T6 remove the Kite and XTS code themselves when they replace it; the desk-engine decide
paths stay — they are venue-neutral book machinery and the BULL-S host).
- Delete: `archive/`, `packages/legacy-shadow-runner` and every golden suite that executes `archive/`, the dead
  packages `indicators`, `events`, `execution`, order-bus's dead `risk.ts`/`wal.ts`/`reconcile.ts`, `apps/traders` (the
  Odin traders desk + AI desk) and the web's `traders/` UI and `traders.html`, `packages/span`, NSE hosted strategy
  families and configs except `premium-leg-book` (its BULL golden tape is T3's parity reference), the runner's
  optionbhai mirrors, NSE-only scripts (`delta-lean-*`, `stock-books`, `traders-*`, NSE sync one-liners), Python
  leftovers, the dev deps kept only for the golden suites (`async`, `cron`, `moment`).
- Organize: `README.md` rewritten for the Delta desk; `docs/` = `specs/` (Delta), `plans/`, `runbooks/` (dx),
  `research/delta/`, `reference/nse/` (the inherited architecture docs still true of the shared machinery —
  `context/00`, `10`, `11`, `13`, `15` — each with a one-line "inherited from the NSE desk" banner); `context/`,
  `memory/` (frozen 07-27, describes the retired system) and the remaining NSE specs/plans/reports/runbooks removed.
- Each deletion keeps `npm run typecheck`, the node suites and the web suite green; a removed import site is fixed,
  never stubbed. One commit per area (`chore(prune): …`).

### Task 1: `packages/venue` — the venue spec and quantity steps

**Files:** Create `packages/venue/package.json` (`@algomaker/venue`), `packages/venue/src/index.ts`; Test
`packages/venue/test/venue.test.ts`.

**Interfaces — Produces:**
```ts
export type VenueId = 'nse' | 'dx'
export interface VenueSpec {
  readonly id: VenueId
  readonly currency: 'INR' | 'USD'
  readonly inrPerUnit: number        // NSE 1, DX 85
  readonly qtyStep: number           // NSE 1, DX 0.001
  readonly defaultTick: number       // NSE 0.05, DX 0.1
  readonly rate: number              // NSE 0.065, DX 0
  isOpen(ms: number): boolean        // NSE: trading day 09:15–15:30 IST; DX: true
  dayKey(ms: number): string         // NSE: IST date; DX: UTC date of the first 12:00 UTC at or after ms
  expiryInstantMs(expiry: string): number // NSE: expiry 15:30 IST; DX: expiry 12:00:00 UTC
}
export const NSE: VenueSpec
export const DX: VenueSpec
export function venueFromEnv(env?: Record<string, string | undefined>): VenueSpec // unset|'nse' → NSE, 'dx' → DX, else throw
export function roundToStep(x: number, step: number): number   // nearest multiple, float-clean (decimals of step)
export function isOnStep(x: number, step: number): boolean
export function contractsOf(qty: number, step: number): number  // integer; RangeError when !isOnStep
```

- [ ] **Step 1: Failing tests** — DX `dayKey('2026-11-03T11:59:59Z')` → `'2026-11-03'`, `…T12:00:00Z` → `'2026-11-04'`;
  NSE `dayKey('2026-11-03T20:00:00Z')` → `'2026-11-04'`. `expiryInstantMs('2026-11-06')` DX = `Date.UTC(2026,10,6,12)`,
  NSE = `Date.UTC(2026,10,6,10)`. `isOpen`: DX Sunday 03:00Z true; NSE Saturday false, `2026-11-03T04:00Z` true.
  `roundToStep(0.05+0.05+0.05, 0.001) === 0.15`; `contractsOf(0.15, 0.001) === 150`; `contractsOf(0.0005, 0.001)`
  throws; `venueFromEnv({DESK_VENUE:'x'})` throws.
- [ ] **Step 2:** `node --test packages/venue/test/venue.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.** NSE `isOpen` reuses the holiday list and session minutes in
  `packages/desk-engine/src/session.ts` (import, no second copy).
- [ ] **Step 4:** PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(venue): VenueSpec (NSE, DX), dayKey on the 12:00 UTC settlement, quantity steps`.

### Task 2: Engine time and step-aware quantity at every host site

Depends on Task 1. Owns `packages/desk-engine/src/{session,engine,marking,margin-project}.ts`,
`packages/greeks/src/index.ts`, `apps/supervisor/src/engine-host.ts` (rounding sites only), `apps/api/src/routes/engine.ts`,
`apps/order-gateway/src/gateway.ts` (quantity check only), `apps/api/src/{decision-plan,marketable}.ts` (tick).

**Interfaces — Consumes:** Task 1. **Produces:** `EngineInputs.venue?: VenueSpec` (absent = NSE); greeks
`yearsToExpiryAt(nowMs: number, expiryInstantMs: number): number`; host wire quantity `roundToStep(lots × lotSize,
venue.qtyStep)`, `lotsOf = Math.round(qty / lotSize)`.

- [ ] **Step 1: Failing tests** — `engine.ts` expiry settle at `venue.expiryInstantMs` (not minute 930) with DX;
  `marking.yearFrac` DX at 2026-11-06 06:00Z = `6 / (365 × 24)`; `margin-project` `lotSize 0.001 × lots 50` → 0.05
  (today 0); supervisor wire `lots 50 × 0.001` posts `qty 0.05` (today dropped); api engine route accepts `0.05` on DX
  and rejects `0.0505`; gateway accepts `quantity 0.15, lotSize 0.001`; marketable limit on a DX instrument rounds to
  tick 0.1; `three 50-contract fills then a 150-contract close leaves qty exactly 0` (api fold).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** — sites read `inputs.venue ?? NSE` or `venueFromEnv()` once at process start; audit the other
  qty↔lots sites in `docs/research/delta/delta-seams.md` §5.2 (`engine-host.ts:1015-1032, 2251, 2486, 2940-2952,
  3017-3038`). Web is not in this task.
- [ ] **Step 4:** desk-engine, greeks, supervisor, api engine-route, gateway suites + typecheck PASS; NSE parity suites
  and decision fixtures pass **unchanged**.
- [ ] **Step 5: Commit** `feat(engine): venue time and 0.001 quantity steps through engine, supervisor, api, gateway`.

### Task 3: `decideBullS` — the BULL-S decide path

Independent of Tasks 1–2. Owns `packages/desk-engine/src/bull-s/*`, `dials.ts` (bs_* only), `presets.ts` (bull-s
presets only), `types.ts` (`RuleState.bs`, `TRIGGERS`), desk-engine `index.ts` exports,
`apps/api/src/books-registry.ts` (`ENGINE_SWITCH_DIALS += 'bs_enabled'`).

**Interfaces — Produces:**
```ts
// packages/desk-engine/src/bull-s/decide.ts
export interface BullSInputs extends EngineInputs {
  readonly ref: number | null      // DX: .DEXBTUSD index; NSE parity: the future
  readonly refAsOf: number         // ms, 0 = never
  readonly minutesToExpiry: number // to the venue expiry instant
}
export function decideBullS(inputs: BullSInputs, dials: Dials, state: RuleState, markCtx: MarkContext): EngineDecision
// packages/desk-engine/src/bull-s/state.ts
export interface BullSGroup { readonly strike: number; readonly lots: number; readonly ceEntry: number;
  readonly peEntry: number; readonly openedMs: number; readonly ceOpen: boolean; readonly peOpen: boolean;
  readonly breachSinceMs: number /* 0 = not breaching */ }
export interface BullSState { readonly groups: ReadonlyArray<BullSGroup>; readonly size: number;
  readonly lastRef: number /* 0 = none */; readonly lastRefMs: number; readonly halted: boolean;
  readonly haltReason: '' | 'target' | 'loss' | 'close' | 'flat' | 'expiry'; readonly armedAtMs: number;
  readonly pnlBaseline: number; readonly closeReqSeen: number; readonly rearmReqSeen: number }
export const BS_EMPTY: BullSState
export function hydrateBullState(raw: unknown): BullSState
// RuleState gains `readonly bs: BullSState` (required; hydrate fills BS_EMPTY)
// TRIGGERS gains 'bs-entry','bs-stop','bs-target','bs-loss','bs-flat','bs-close','bs-rearm','bs-expiry'
```
Dials (`Dials` + `DEFAULT_DIALS` off + a "BULL-S" `DIAL_SECTIONS` entry + `resolveDials` validation):
`bs_enabled` false · `bs_strike_step` 0 (price units, > 0 required when enabled) · `bs_strike_jump` 1 (∈ {1,2}) ·
`bs_stop_mult` 1.25 · `bs_stop_basis` 1 (0 = summed LTP with legacy `trunc`, 1 = summed ask) · `bs_stop_confirm_s` 3 ·
`bs_lots_start` 1 · `bs_lots_step` 1 · `bs_lots_cap` 0 (0 = uncapped — NSE parity only; every DX preset sets it) ·
`bs_max_open` 0 (0 = unlimited) · `bs_target` 0 · `bs_loss_cap` 0 · `bs_after_halt` 0 · `bs_enter_on_start` true ·
`bs_entry_from_min` 0 · `bs_entry_to_min` 1440 · `bs_entry_weekdays` 127 (bit 0 = Sunday, IST) ·
`bs_no_entry_before_expiry_min` 0 · `bs_flat_before_expiry_min` 0 · `bs_ref_max_age_s` 10 · `bs_close_req` 0 ·
`bs_rearm_req` 0 (counters: the dashboard PATCHes +1; the engine acts once when `dial > state.*ReqSeen`).

Presets (spec §6.2): `bull-s-btc-daily` {step 200, start 50, lot step 50, cap 150, max_open 4, loss_cap 250,
no_entry_before_expiry 60}; `bull-s-btc-weekly` {500, 10, 10, 30, 4, 500, 60}; `bull-s-btc-monthly` {1000, 10, 10, 30,
4, 500, 60}; each with `bs_strike_jump 1`, and a `-2` twin identical but `bs_strike_jump 2`. All: `bs_enabled true,
bs_stop_mult 1.25, bs_stop_basis 1, bs_stop_confirm_s 3, bs_target 0, bs_after_halt 0, bs_enter_on_start true`.

Rules: spec §6.1 items 1–9 exactly. Grid = `bs_strike_jump × bs_strike_step`; at most one new straddle per decision, at
the crossed level nearest `ref`; the level must be listed in `inputs.chain.strikes` with CE and PE quotes; target/loss
P&L = `totalPnl(inputs) − state.bs.pnlBaseline` (reuse delta-lean's `totalPnl`); opens Sell PE then CE, closes PE then
CE; stop/halt/close/expiry-flat pre-empt entries; `inputs.pendingLots > 0` blocks a new entry, never a stop.

- [ ] **Step 1: Failing tests** (`packages/desk-engine/test/bull-s/*.test.ts`): `first fresh ref after start sells the
  nearest level when bs_enter_on_start`; `crossing one grid level sells that strike at the current size, size steps,
  cap holds`; `jump 2 ignores the in-between strike`; `price gapping three levels sells only the nearest level`;
  `unlisted strike at the level is skipped, never substituted`; `stop fires only after the summed ask has held ≥ mult ×
  entry for confirm_s; recovery resets the clock`; `a Dials change to bs_stop_mult applies to an open straddle at the
  next decision`; `null ask holds the stop and names the leg`; `stale ref neither enters nor crosses; fresh ref after a
  gap re-baselines`; `target halts and closes all; after_halt 0 stays flat; after_halt 1 re-arms with a new baseline
  and size reset`; `loss cap mirrors target`; `bs_close_req +1 closes all and halts once; bs_rearm_req +1 clears the
  halt once`; `entry window and weekday mask gate entries but never stops`; `no entry inside the expiry blackout;
  flat_before_expiry closes at the minute; no orders at or after the expiry instant`; `hydrated state with
  ceOpen=false peOpen=true does not re-enter the level`; `max_open caps concurrent straddles`; `pendingLots > 0 blocks
  a new entry but not a stop`.
- [ ] **Step 2: NSE parity** `packages/desk-engine/test/bull-s/parity-golden.test.ts`: replay the tape used by
  `packages/strategies/test/golden/premium-leg-book-bull.test.ts` through `decideBullS` (step 100, jump 1, basis 0,
  mult 1.25, start 1, lot step 1, cap 0, max_open 0, enter_on_start true) and assert the same ordered
  `(op, strike, optType, side, lots)` list as `PremiumLegBookStrategy` on that tape (fills at the tape price).
- [ ] **Step 3:** FAIL. · **Step 4: Implement** `bull-s/{grid,state,decide}.ts` + the dial/preset/trigger/state additions;
  reasons in plain words.
- [ ] **Step 5:** desk-engine suites (existing parity untouched) + typecheck PASS.
- [ ] **Step 6: Commit** `feat(engine): BULL-S decide path — crossover straddle pyramid with caps, halts, commands`.

### Task 4: `packages/dx` — Delta client, normaliser, adapter, fees

Independent. Owns `packages/dx/**`.

**Interfaces — Produces:**
```ts
export function signRequest(secret: string, method: string, path: string, query: string, body: string, tsSec: number): string
export interface DxRestOptions { readonly baseUrl: string; readonly apiKey?: string; readonly apiSecret?: string;
  readonly userAgent: string; readonly fetch?: typeof fetch; readonly nowMs?: () => number }
export class DxRest { // returns the parsed `result`; throws DxApiError {status, code, retryAfterMs?}
  products(q: { contractTypes?: string[]; states?: string[]; underlying?: string[] }): Promise<DxProduct[]>
  tickers(q: { contractTypes?: string[]; underlying?: string[]; expiryDate?: string }): Promise<DxTicker[]>
  placeOrder(o: DxOrderRequest): Promise<DxOrder>
  cancelOrder(id: number, productId: number): Promise<DxOrder>
  editOrder(o: { id: number; productId: number; limitPrice: string }): Promise<DxOrder>
  openOrders(): Promise<DxOrder[]>
  fills(q?: { after?: string }): Promise<{ fills: DxFill[]; after?: string }>
  positions(): Promise<DxPosition[]>
  walletBalances(): Promise<DxBalance[]>
  heartbeat(op: 'create' | 'ack', ttlMs?: number): Promise<void> }
export class DxPublicSocket { constructor(url: string, opts?: { onFrame?: (f: DxFrame) => void; onState?: (s: string) => void });
  subscribe(channel: 'ticker' | 'spot_price' | 'ob_l1', symbols: string[]): void; close(): void }
export class DxPrivateSocket { /* key-auth; channels orders, user_trades, positions */ }
export function toInstrumentRow(p: DxProduct): InstrumentRow | null // BTC call/put → CE/PE, name 'BTC', lot_size 0.001,
  // expiry = settlement UTC date, instrument_token = product id, exchange 'DELTA', segment 'DX-OPT'; a spot row for .DEXBTUSD
export function optionFee(a: { contracts: number; index: number; premium: number }): { fee: number; gst: number; total: number }
  // fee = min(0.0001 × contracts × 0.001 × index, 0.035 × contracts × 0.001 × premium); gst = 0.18 × fee
export class DxAdapter implements BrokerAdapter // limit only; prices as strings on tick; size = contractsOf;
  // client_order_id ≤ 32 (stable hash of longer ids); reduce_only on closes; 429 back-off
```
- [ ] **Step 1: Failing tests** — the signature of the documented example (copy it from
  `docs/research/delta/delta-api-reference.md` §2); query string includes `?`; body is compact JSON; `toInstrumentRow`
  on `C-BTC-76600-041126` → `{instrument_type:'CE', strike:76600, expiry:'2026-11-04', lot_size:0.001, tick_size:0.1,
  name:'BTC'}`; `optionFee({contracts:100, index:76592, premium:212})` → fee `min(0.76592, 0.742) = 0.742`, gst
  `0.13356`; a 429 surfaces `retryAfterMs` from `X-RATE-LIMIT-RESET`; adapter refuses a non-step quantity; a 45-char id
  maps to a stable 32-char id; the public socket subscribes with the new channel names and resubscribes after a
  reconnect (fake WS server on an ephemeral port).
- [ ] **Steps 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(dx): Delta India client — signer, REST, WS, normaliser, fees, broker adapter`.

### Task 5: marketdata on Delta — products and the price feed

Depends on Tasks 1, 4. Owns `apps/marketdata/src/dx-*.ts` and the `DESK_VENUE` branch in `apps/marketdata/src/main.ts`.

**Produces:** with `DESK_VENUE=dx`: no Kite login; `instrument` filled from Delta at boot, every 15 min and right after
12:00 UTC; expired rows kept while a `desk-books-registry` row or an open `desk-books` leg references them; `md.spot`
`{underlying:'BTC', price, ts}` from `spot_price` `.DEXBTUSD`; `md.tick` in **exactly the shape the Kite path publishes
today** (read `apps/marketdata/src/main.ts:346-362` and the api QuoteCache consumer for the fields read — bid/ask
included) keyed by product id, plus the option fields the chain page needs — `mark`, `bid`, `ask`, `bidSize`,
`askSize`, `iv` (mark IV), `oi`, `delta`, `gamma`, `theta`, `vega` — as optional fields NSE never sends; `md.health` unchanged; subscriptions = every BTC option of every listed expiry;
settlement prices of expired products written to `dx-settlements` `{_id: productId, symbol, expiry, price,
publishedAt}`.

- [ ] **Step 1: Failing tests** (fake DxRest/WS): sync writes rows, prunes an unreferenced expired row, keeps a
  referenced one; a `ticker` frame becomes the Kite-shaped `md.tick`; `spot_price` becomes `md.spot`; reconnect
  resubscribes; a settled product writes one `dx-settlements` row (idempotent).
- [ ] **Steps 2–4:** FAIL → implement → PASS (marketdata suites + typecheck).
- [ ] **Step 5: Commit** `feat(marketdata): Delta products sync, settlement prices and price feed behind DESK_VENUE=dx`.

### Task 6: gateway on Delta — routing rule, contract edge, fees, settlement, caps

Depends on Tasks 1, 4. Owns `apps/order-gateway/src/*` (not Task 2's quantity check), `packages/brokers/src/simulator.ts`
(fee), `apps/api/src/brokerstore.ts` + `routes/brokers.ts` (kind `delta`).

**Produces:** `adapterFor(order)` = DxAdapter iff `order.mode === 'live' && env.DESK_DX_LIVE === '1'`, else the
simulator (journalled); broker kind `delta` (`secret {apiKey, apiSecret}`, `meta {baseUrl, label}`) whose `test` does
a signed `walletBalances()`; every fill row carries `fee` (simulator: `optionFee` at the touch — sell at bid, buy at
ask; live: Delta's reported commission); a settlement job at 12:00 UTC books each expired open leg at the
`dx-settlements` price (paper and live), retries until it exists, alerts at +30 min, never invents one; caps
`DESK_DX_MAX_CONTRACTS_ORDER` (200) and `DESK_DX_MAX_NOTIONAL_USD` (20000) refuse before routing; live only: Delta
heartbeat create/ack every 10 s, ttl 30 s.

- [ ] **Step 1: Failing tests** — `mode:'paper'`, missing mode, `'Live'`, and `'live'` without the env all route to the
  simulator; only `'live'` + env routes to Delta; a simulated sell fills at bid with `fee = optionFee(...)`; a 0.15 BTC
  order is sent as `size: 150`; caps refuse with a journalled reason; `settlement waits for Delta's price and never
  invents one`; kind `delta` stores sealed and `test` returns ok against a fake REST.
- [ ] **Steps 2–4:** FAIL → implement → PASS (gateway, brokers, api brokers suites + typecheck).
- [ ] **Step 5: Commit** `feat(gateway): Delta routing (exact live + DESK_DX_LIVE), fees, settlement booking, caps`.

### Task 7: api + supervisor wiring for DX and BULL-S

Depends on Tasks 2, 3, 6. Owns `apps/api/src/{day-guard,pnl-jobs,rollup,settle-expired,submit,paper-fold,pnlstore}.ts`
and `apps/supervisor/src/*` (not Task 2's rounding sites).

**Produces:** api and supervisor read `venueFromEnv()` once; day guard, daily limits, P&L snapshots and daily reports
key on `venue.dayKey` (DX snapshots 24x7; daily report just after 12:00 UTC); `settle-expired` defers to the gateway's
Delta settlement on DX; `submit.ts` "expires today" on the expiry instant; realised P&L net of `fee` (gross, fees, net
reported; `cumRealized` net); supervisor `MasterPort` from the DX `instrument` rows, `ring` fed by `md.spot` BTC,
`#decide` → `if (dials.bs_enabled) return decideBullS({...inputs, ref, refAsOf, minutesToExpiry}, dials, state,
markCtx)` before the delta-lean branch; `GET /v1/desk/chain/:symbol?expiry=` returns the T5 option fields (mark,
bid/ask + sizes, IV, OI, greeks) per strike, and `GET /v1/desk/chain/BTC/expiries` lists the listed expiries; `bs-stop|bs-target|bs-loss|bs-flat|bs-close|bs-expiry` pre-empt a working
entry (as `DL_EXIT_TRIGGERS`); `ruleState.bs` via `hydrateBullState`.

- [ ] **Step 1: Failing tests** — DX day guard keys `2026-11-04` at 12:00:00Z; a DX book with legs at 20:00 IST is marked
  and decided; a P&L row shows gross/fees/net; supervisor routes a BULL-S open as `qty 0.05` per leg and a stop
  pre-empts a working entry; a restart with a half-filled group neither re-enters nor drops the open leg; the same
  suites with `DESK_VENUE` unset behave exactly as before.
- [ ] **Steps 2–4:** FAIL → implement → PASS (api + supervisor suites + typecheck).
- [ ] **Step 5: Commit** `feat(dx): api and supervisor run on the venue day and drive BULL-S books`.

### Task 8: dashboard for DX

Depends on Task 1 (relative import of `packages/venue`, as web already imports `../../traders/src/types.ts`). Owns
`apps/web/src/**`.

**Produces:** venue from `VITE_DESK_VENUE` (the dx build sets `dx`); `format.ts` money in the venue currency (`$`, 2
decimals; a ₹ second figure at 85 on totals) with the seven bypass copies moved onto it
(`docs/research/delta/delta-web-survey.md` §1); `inSession` → `venue.isOpen`; expiry checks on `venue.expiryInstantMs`;
`contract.ts` parses/prints Delta symbols (`C-BTC-76600-041126` → `BTC 04 Nov 76600 CE`); 0.001-step quantities (no
`isIntegerOnly`), tick 0.1; Brokers card kind `delta`; an **Option chain page** (operator, 3 Nov): expiry tabs
(dailies, weeklies, monthlies, from the instrument list), the index price and the ATM row highlighted, per strike CE |
strike | PE with bid, ask, mark, IV, delta, OI (gamma/theta/vega on hover), live through the existing stream/poll,
read from the api chain endpoint (T7 extends it with the new tick fields); on a book whose dials have `bs_enabled`, **Close book** and
**Re-arm** buttons PATCH `bs_close_req` / `bs_rearm_req` +1 after a confirm; traders desk and NSE broker view hidden on dx.

- [ ] **Step 1: Failing tests** (vitest): format, contract parse, the two buttons' PATCH bodies, `inSession` on DX.
- [ ] **Steps 2–4:** FAIL → implement → PASS (`npm run test --workspace @algomaker/web -- --maxWorkers=2`,
  `cd apps/web && npx tsc -b`).
- [ ] **Step 5: Commit** `feat(web): Delta desk — USD, Delta contracts, 24x7 session, BULL-S close/re-arm`.

### Task 9: ops — config, scripts, runbook, first books

Depends on Tasks 5–8. Owns `ecosystem.desk.config.cjs`, `scripts/dx-*.{sh,mjs}`, `docs/runbooks/dx-bull-s.md`.

**Produces:** ecosystem base env `DESK_VENUE: 'dx'`; `dx-runner` and `dx-traders` out of the default start;
`scripts/dx-bootstrap-env.sh` (writes the clone's `.env.local` once — fresh `DESK_MASTER_KEY`, `DESK_API_TOKEN` and every
other secret the dx processes require, derived from the code's required-env reads; refuses to overwrite; prints names
only); `scripts/dx-start.sh` (checked `pm2 start` of the dx apps, stop on first error); the dx dashboard Caddy snippet
in the runbook (operator applies); `scripts/dx-books.mjs` (dry run by default; `--apply` creates, starts and
paper-enables one book per preset on the nearest daily, weekly and monthly expiry, tags `BTC-<expiry>-bull-s-<cls>[-2]`,
refuses when the feed is not ready or the kill switch is on); the runbook: bootstrap → start → first dashboard user
(operator's own SSH terminal, never `!`) → Brokers → Delta → Test → books → what to watch.

- [ ] **Step 1: Test** `scripts/dx-books.mjs --dry-run` against a seeded test db prints six bodies with the right tags/dials.
- [ ] **Steps 2–4:** FAIL → implement → PASS; `bash -n` on the shell scripts.
- [ ] **Step 5: Commit** `chore(dx): bootstrap, start and first-books scripts; dx runbook`.

### Task 10: integration on paper (operator + lead)

Operator: bootstrap → start → user → key. Lead verifies `md.health` ready, `instrument` holds the BTC chain, six books
register and decide, the first straddle opens on paper with fees, a stop and a Close book behave, P&L shows in USD.
Defects become their own fix tasks.

### Task 11 (later): the roll — next-expiry books created after each settlement.

## Execution order

T0 → T0b. Wave 1 in parallel (own worktrees under `/opt/algomaker-delta/.worktrees/`, each `npm ci --ignore-scripts`):
P, T1, T3, T4; the dx-web server on :5000 (lead, see the runbook) beside them. T8 after P. Wave 2: T2 (after T1), T5 and T6 (after T1+T4). Wave 3: T7 (after T2, T3, T6), then T9. Each task: implementer →
spec/quality reviewer → merge to the clone's `master` (`--no-ff`), full `make check` on the merged tree once per wave.
