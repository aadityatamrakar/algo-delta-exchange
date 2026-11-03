# Delta Exchange India as a second venue: where the seams are

Read-only survey of `/opt/algomaker` at `0d390c37` (2026-11-03). I changed nothing, ran no tests and probed no external host. Every `file:line` below is relative to the repo root. When a context doc and the code disagree, I give the code.

Throughout, **"dx"** is my working name for the venue. Do not name anything "delta": this tree already uses that word for the delta-lean strategy family (`packages/desk-engine/src/delta-lean/`, the `dl_*` dials), for the option greek, and for the traders domain `delta.optionbhai.com`. A collection called `delta-books` or an env var called `DELTA_*` would be misread.

Delta facts assumed here, which the delta-docs agent should confirm:
- contract value 0.001 BTC, with order size a whole number of contracts;
- premiums quoted in USD per 1 BTC;
- daily, weekly and monthly expiries settling at 17:30 IST (12:00 UTC) against an exchange-published settlement price;
- the market is open 24x7;
- HMAC-SHA256 request signing;
- an edit-order endpoint exists, and orders accept a reduce-only flag;
- unknown and needed before building: the `client_order_id` length limit, the perp funding interval, whether a testnet exists, whether API keys are IP-whitelisted, and whether margin and P&L settle in USD or INR.

---

## 1. Venue assumptions, module by module

Key: **NSE** marks an NSE, IST, rupee, lot or Kite-token assumption. **Neutral** marks code that already works for another venue.

### packages/core
- **NSE.** The session is hard-coded constants:
  - `MARKET_OPEN_MIN` 09:15 (`packages/core/src/index.ts:86`), `MARKET_CLOSE_MIN` 15:30 (`:95`) and `FNO_CLOSE_MIN` 15:40 (`:102`);
  - `isMarketOpen` is weekday plus 09:15–15:30 IST (`:104-111`);
  - `Clock` speaks only IST (`istMinutes`, `istDay`, `:36-43`), with the offset fixed at 330 (`:45`).
- **Neutral.** `roundToTick` (`:119-126`), `Result`, `makeId` and the resilience guards.

### packages/instruments
- **NSE.**
  - `Underlying` (`packages/instruments/src/index.ts:18-36`) has a numeric Kite `spotToken`, `derivativeExchange: 'NFO'|'BFO'`, `spotExchange: 'NSE'|'BSE'|'INDICES'` and a weekly-expiry weekday. `INDEX_UNDERLYINGS` (`:49-110`) lists the five Indian indices.
  - `InstrumentRow` (`master.ts:27-40`) is the Kite dump row: numeric `instrument_token`, an expiry string, `lot_size`, `tick_size`.
  - `OptionType = 'CE'|'PE'` (`master.ts:42`). Spot detection is `EQ` or `INDICES` (`:37-38`), with a preference for NSE (`:49-51`).
  - The exchange token is recovered from the packed Kite token (`exchangeTokenOf`, `master.ts:475`; `INDEX_SPOT_TOKENS`, `:84`).
  - `freeze.ts` is the NSE volume freeze (`qtyfreeze.csv`).
- **Neutral.** The `OptionMaster` chain, strike and expiry indexing is generic once the rows are shaped like the Kite dump. A Delta adapter could emit rows in that shape, but should not write them into the shared `instrument` collection (see marketdata).

### packages/order-bus (types only are live)
- **NSE.**
  - `InstrumentRef.instrumentToken` is documented as the Kite token (`packages/order-bus/src/types.ts:28-35`).
  - `Destination = 'sim'|'zerodha'|'xts'|'fyers'|'spark'` (`:24`).
  - `OrderIntent.quantity` is "contract quantity, already multiplied out from lots" (`:53-55`).
  - `defaultRiskLimits` are rupee- and lot-calibrated: 5,000,000 notional, 100,000 daily loss, 60 lots (`:128-136`).
- **Neutral.** The status machine (`:64-84`) and the exposure-check shapes.

### packages/brokers (the adapter interface)
- **Neutral.** `BrokerAdapter` (`packages/brokers/src/types.ts:86-110`) has `placeOrder`, `modifyOrder`, `cancelOrder`, `positions`, `orderBook`, `onFill` and `onOrderUpdate`, plus `capabilities` with `modify`. A Delta adapter fits this unchanged.
- **NSE, outside the interface.**
  - `BrokerOrder.exchangeToken` exists for the Kite-to-XTS join (`types.ts:37-50`).
  - `xts-protocol.ts:251-257` `exchangeSegment()` **falls back to `NSEFO` for any unknown exchange**. A Delta order that reached the XTS adapter would be sent to NSE F&O. This is the strongest single argument for never sharing `desk-gateway-orders` with Delta.

### packages/bus and the md.* topics
- **Neutral.** The transport is topic strings with any payload (`packages/bus/src/index.ts:10-33`).
- **Shared-bus hazards.**
  - `WsTransportServer` broadcasts every frame to every client, and filtering happens on the client (`ws-transport.ts:9-11`, `:57`).
  - Exactly three topics are published, all from `apps/marketdata/src/main.ts`:
    - `md.spot` (`:991`), payload `{underlying, price, ts, prevClose?}` (`:585-593`);
    - `md.tick` (`:993`), keyed by the numeric Kite `token`; see `tickPayload` (`:546`) and `MdTick` (`tick-recorder.ts:64-70`);
    - `md.health` (`:1489`).
  - Consumers all subscribe to the literal `md.tick` and key by a number:
    - api `QuoteCache` and `LiveBook` (`apps/api/src/main.ts:320-343`; `livebook.ts:209` `Map<number,…>`);
    - the runner (`apps/runner/src/main.ts:700`);
    - the gateway simulator (`apps/order-gateway/src/main.ts:2532`);
    - the supervisor (`apps/supervisor/src/main.ts:853,859`);
    - traders (`apps/traders/src/market/quotes.ts:61,65`).
  - Delta product ids are also numbers, so they can collide with Kite tokens: SENSEX spot is token `265`.
  - A Delta `md.health` would overwrite the api's feed-health frame (`apps/api/src/main.ts:365-368`).

### apps/marketdata
- **NSE throughout.**
  - One Kite login (`zerodha-login.ts:188-238`, `:423`) and the KiteTicker pool.
  - The 08:45 IST daily sync (`SYNC_IST_MINUTE`, `main.ts:114`; `syncDue`, `:140`). `DESK_UNIVERSE` defaults to NSE names (`:613`).
  - `planSync` deletes stored rows whose expiry has passed, keyed by numeric token (`instrument-sync.ts:127-138`). Delta rows written into `instrument` would be pruned by NSE logic and would collide on tokens.
  - Freeze limits are refreshed only by `make sync`, history is served on `:8792`, and per-book margin comes from Kite basket margins.
- **Reusable as a pattern.** Feed recovery (two fault kinds), the stale-token watchdog, `TokenSharder` and the marks snapshot.

### apps/api
- **rail.ts.** Rails are separated by collection (`:1-14`):
  - `PaperRail` writes `desk-paper-trade`; `LiveRail` writes `desk-gateway-orders` (`LIVE_COLLECTION`, `:667-670`).
  - **Exception:** paper orders from the engine go into `desk-gateway-orders` with `mode:'paper'` (`routedCollection`, `:162-169`; `PaperRail.route`, `:560-592`). The constraint "paper and live separate by collection" is already bent on the NSE side. Do not copy this.
  - `orderDocument` carries `instrument_token`, `exchange`, `tickSize`, and `quantity` (contract quantity = lots × lot_size, `:180-186`, `:260`).
- **marketable.ts / decision-plan.ts.**
  - The marketable-limit tick is **process-global** (`DESK_MARKETABLE_TICK` 0.05, `marketable.ts:87`), not taken from the instrument (`:124`).
  - Prices are rounded to 2 decimals, i.e. paise (`:143`).
  - `priceFillsForRoute` (`decision-plan.ts:270`) applies this to every unpriced fill. Off-grid prices for any instrument whose tick is not 0.05 would be rejected by Delta.
  - `flattenWindow` uses the IST day (`decision-plan.ts:423-429`, through `istDayRange`, `routes/kit.ts:184-195`).
- **submit.ts.**
  - The `liveLots` override.
  - The NSE freeze split (`:729-745`).
  - `quantity = lots × lotSize` (`:766`).
  - The expiry-day buffer keys on `expiryOf(...) === istDate(now)` (`:717-721`).
- **service.ts and the engine wire.** `POST /v1/desk/engine/decisions` demands a **positive integer contract quantity** (`routes/engine.ts:148`, `:268-269`, `:292`, `:345`) and resolves symbols against the Kite `OptionMaster`.
- **livebook.ts / marks.ts.** Keyed by numeric token (`marks.ts:110`, `:150-456`).
- **pnl-jobs.ts / rollup.ts.**
  - The snapshot tick runs only in `inTradingSession`: weekdays 09:15–15:40 IST, with no holidays modelled (`rollup.ts:605-610`).
  - The daily rollup runs at or after 15:40 IST (`pnl-jobs.ts:720`); the prune at 01:30 (`:721`).
  - The choice between valuation and display read uses `isMarketOpen` (`:193-198`).
  - It loops over both `MODES` across every book (`:47`).
- **day-guard.ts.**
  - Fires once per `<tag>|<mode>|<IST day>` (`:82`, `:311`); paper re-arms at 08:45 IST (`REARM_AFTER_IST_MINUTES`, `:71`).
  - Reads P&L from the NSE journal (`pnlFor`, `:46`) and formats it in rupees, en-IN (`:249`).
- **settle-expired.ts.**
  - Settles paper legs only, at intrinsic value against the underlying's close on the expiry date.
  - The close window opens at 15:29 IST and the settlement is booked at 15:30 IST (`:255-265`).
  - Index membership is checked against `INDEX_UNDERLYINGS`.
- **main.ts exposure (a cross-venue hazard).** `measureOpenLots` (`main.ts:138-164`) names any held symbol the NSE master cannot size as "unmeasured", and `checkExposureLimits` then refuses new exposure (`UNMEASURED_EXPOSURE`, `packages/order-bus/src/risk.ts:162`). That gate is active only when a `DESK_RISK_*` variable is set (`submit.ts:442-447`). Then **one Delta leg journaled into `desk-decisions` would block every new NSE live open on the desk.**
- **Neutral or reusable.**
  - The kill switch (`desk-safety {_id:'killswitch'}`, `store.ts:784-800`).
  - The strategy switches and live allowlist (`liveAllowlistFromStrategies`, `strategies.ts:142`; live-enable is password-gated and refused to machine principals, `authsvc.ts:217-220`).
  - Auth (`authgate.ts`, `packages/auth`).
  - The broker credential store (§3d).
  - The pure planners: `planCloseAll`, `planFlatten`, `guardTrigger`, `guardRecordId`.

### apps/order-gateway
- **The interface it consumes is neutral.** It drives `BrokerAdapter` and builds a `SimulatorAdapter` unconditionally for paper (`main.ts:1757`).
- **XTS is wired directly in `main.ts`.**
  - `DESK_BROKER` selects xts or simulate (`:1744`); `new XtsAdapter` with `exchangeInstrumentId = packed ÷ 256` (`:1916-1934`); the session, broker link and order socket live in the xts branch.
- **NSE elsewhere.**
  - `planOrder` refuses any quantity that is not a whole multiple of `lotSize` (`gateway.ts:226-246`), and freeze tranches come from `desk-freeze-limits` (`main.ts:1693`).
  - `packedToExchangeToken` (`gateway.ts:624-627`) is used by fills and the broker sweep (`fills.ts:783`, `broker-sweep.ts:332`).
  - The chaser's `DEFAULT_TICK` is 0.05 (`order-chaser.ts:169`).
  - The claim loop is over one collection (`main.ts:1641`).
- **Reusable as patterns.** The claim compare-and-set, the journal shapes, the peg chaser and tranche cursor, the kill-switch re-read in-process (`main.ts:1620-1633`), and stale-order refusal.

### apps/supervisor and packages/desk-engine (positional books)
- **desk-engine session (NSE, hard-coded).**
  - Constants: `SESSION_OPEN_MIN` 555 (09:15), `DECISIONS_END_MIN` 930 (15:30), `DECISION_CLOCK_CLOSE_MIN` 930, `RULES_START_MIN` 560 (09:20), `MARK_STEP_MIN` 5 (`packages/desk-engine/src/session.ts:59-102`).
  - The 2026 NSE holiday list (`:109-126`) and `isTradingDay` (`:138-146`).
  - `markOf` clamps to 09:15–15:30 (`:154-163`).
- **These are read inside `decide()`.**
  - Expiry settle when `dte === 0 && minuteOfDay >= 930` (`engine.ts:247`).
  - Session gate: `!isTradingDay`, before 09:20, after 15:30 (`engine.ts:269-279`).
  - The delta-lean paths use `isTradingDay` too (`delta-lean/decide.ts:1123`, `delta-lean/playbook/decide.ts:594`, `playbook/calendar.ts:62`).
- **Tenor.**
  - `marking.yearFrac` is calendar days / 365, ignoring the clock, except on expiry day, where it uses minutes to 15:30 (`marking.ts:212-225`).
  - `RISK_FREE = 0.065` is a constant (`marking.ts:103`, used at `:409` and `:465`).
- **Units.**
  - `EngineInputs` carries `dateIst`, `minuteOfDay` in IST and `dte` in calendar days (`types.ts:155-167`); `LegView` carries integer `lots` and `lotSize` (`types.ts:89-90`).
  - Money dials are "₹" but mean book currency, e.g. `margin_cap` ₹10cr (`dials.ts:504`).
  - `margin-project.ts:225` **truncates `lotSize`**: `Math.trunc(leg.lots) * Math.trunc(leg.lotSize)` gives 0 shares for 0.001.
  - Presets (`presets.ts`) are NSE-calibrated.
- **Supervisor host.**
  - `MasterPort` (`apps/supervisor/src/main.ts:242-253`) is a clean seam, but production builds it from the Kite `instrument` collection (`:1562`).
  - The bus URL is the NSE bus (`:1542`). Collections are hard-coded: `desk-books-registry`, `desk-books`, `desk-gateway-orders`, `desk-marks`, `desk-supervisor-state`, `desk-book-marks` (`:533-572`, `:1001`, `:1122`, `:1197`).
  - The lease takes a `key`, so a second instance can coexist (`lease.ts:59-66`).
  - The decision wire **rounds share quantity**: `Math.round(action.lots * chain.lotSize)`, then `if (!(qty > 0)) continue` (`engine-host.ts:2416-2417`, `:2508`). With lotSize 0.001, every open is silently dropped.
  - `istDateOf` is IST (`engine-host.ts:629`).
- **Also consumed by apps/traders.** `advice.ts:16-17` and `adjust.ts:22` import `isTradingDay`, `DECISIONS_END_MIN` and others. Any desk-engine change ships to traders too.

### apps/runner, packages/strategy-kit, packages/strategies, packages/strategy-config (hosted intraday)
- **Neutral ports.** `MarketData`, `OrderGateway`, `FillStream`, `StateStore` and `FeedHealthPort` in `StrategyContext` (`packages/strategy-kit/src/ports.ts:211-222`).
- **NSE inside the ports.**
  - Tokens are `number` (`ports.ts:36`, `:92`, `:98`); `SubmitRequest.lots` (`:133`).
- **NSE in StrategyBase.**
  - Job catch-up is gated on `isMarketOpen` (`base.ts:302-305`); `pastClose` is `MARKET_CLOSE_MIN` (`:509-511`).
  - The IST cron (`schedule.ts`) defaults to weekdays 1-5 (`cronAtIstMinute`, `:301`).
- **NSE in candles.** Hourly bars are anchored at 09:15 IST and day bars at IST midnight (`packages/marketdata-core/src/candles.ts:114-123`). Delta history is UTC-aligned.
- **NSE in configs.**
  - `Underlying = 'NIFTY'|'BANKNIFTY'|'SENSEX'`, with `STRIKE_STEP` validated (`packages/strategy-config/src/index.ts:17-31`, `:143-146`).
  - `Rail.destinations: 'sim'|'xts'` (`:74`); `Risk.dayLossRupees`.
  - Square-off and entry minutes are hard-coded IST: 15:15–15:24 squareoff, a 09:45 opening range (`configs/*.ts`; `range-breakout-directional/logic.ts:179`).
- **Runner wire.** It POSTs `{instrument:{tradingsymbol, lotSize, tickSize, exchange, instrumentToken}, side, lots, …}` to `/v1/desk/submit` (`apps/runner/src/order-gateway.ts:1285-1300`).
- **SIGTERM.** Square-off is now **opt-in** with `DESK_SQUAREOFF_ON_STOP=1`; the default stops without flattening and resumes on restart (`apps/runner/src/main.ts:800-845`). `context/00` §1 predates this. The flat-book rule for restarts stands either way.

### packages/greeks
- **NSE defaults.**
  - The header says "for NSE options" (`index.ts:2`). `OptionType` is `'CE'|'PE'` (`:28`).
  - `bookGreeks` defaults the rate to 0.065 (`:313`).
  - `yearsToExpiry` prices to **15:40 IST on the expiry date** (`:428-433`).
- **Neutral.** Calendar-day theta (`/365`, `:170`, `:185`), BS and Black-76 (`black76.ts`), `carryYield` and bisection IV are all fine for BTC.

### packages/pnl
- **Neutral and unit-free.** Average-cost P&L on signed quantity times price.
- One trap: flat is `qty === 0` (`packages/pnl/src/index.ts:171`, `:196`). With fractional quantities (0.001 + 0.002 − 0.003) float noise means a book never reads as flat. Keep stored and netted quantities as integer contracts.

### packages/payoff
- **NSE.**
  - `DEFAULT_RATE 0.065` (`legs.ts:35`); `lotSize` is truncated in `legs.ts:99` and `candidates.ts:307`, `:363`.
  - The "₹1 / 10%" spread test (`candidates.ts:272-276`).
  - Scenario dates are clamped to 09:15–15:40 IST (`scenario.ts:88-135`).
  - `margin.ts` is an NSE SPAN-like proxy with 5% exposure and 5% floor (`:48-92`); `packages/span` is NSE SPAN.
- **Neutral.** `scenario-grid.ts` already **injects** `isTradingDay` (`:43`, `:99`); `distribution.ts` uses calendar /365.

### packages/secrets and the desk-brokers store
- **Neutral.** AES-256-GCM `v1.` sealing under `DESK_MASTER_KEY` (`packages/secrets/src/index.ts:92-101`, `:126`, `:159`, `:187`).
- **Two kinds only.** `BrokerKind = 'xts'|'zerodha'` (`apps/api/src/brokerstore.ts:30-36`); see §3d.

### Kill switch (desk-safety)
- **Neutral.** One document, `desk-safety {_id:'killswitch'}`, read and written by the api (`store.ts:784-800`) and re-read per order by the gateway (`order-gateway/src/main.ts:1620-1633`).
- A Delta executor that reads the same document gets a cross-venue halt for free.
- The broker-link (`_id:'broker-link'`) is XTS-specific (one session per key).

### apps/web
Merged from my greps and the Explore sub-agent's survey (`delta-web-survey.md`). Paths are under `apps/web/src`.

- **Currency (NSE).**
  - `format.ts:20` `inr()` formats en-IN. `signed`, `money` and `inrCompact` (lakh/crore) all route through it, at roughly 142, 50, 46 and 4 call sites.
  - Seven copies bypass it:
    - `strategies.tsx:178,211`
    - `traders/repair-card.tsx:41-44`
    - `traders/assistant/metrics.ts:31-34`
    - `traders/book-strip.tsx:34`
    - `traders/results-badge.tsx:27`
    - `traders/booked.tsx:64`
    - `traders/wire.ts:88`
  - Rupee labels: `dials-plan.ts:318,805`; "Daily target (₹)" at `strategies.tsx:678-693`. `₹` appears 58 times across 18 files.
- **Lots × lotSize and integer quantities (NSE).**
  - Sizing multiplies lots by lot size at `payoff.tsx:259,909,1068,1209`, `book-build.tsx:895,903` (default lot 750 at `:583`), `manual-order.tsx:369-603`, `protect.tsx:64-154`, `report-orders.ts:170,327` and `broker-view.tsx:329`.
  - Integer-only checks: `payoff.tsx:973`, `strategies.tsx:659`, `protect.tsx:148`.
  - `liveLots` is an integer (`api.ts:1013,1042,1073`).
- **Tick 0.05 hard-coded (NSE).** `entry-plan.ts:49-50`, `book-build.tsx:904`, `payoff.tsx:990`. No strike step is hard-coded; strikes come from the chain.
- **IST and the session (NSE).**
  - `istDate`, `istDaysBefore`, `istDayLabel` and `istTime` live at `api.ts:3289-3330`.
  - `inSession()` (`api.ts:3410-3435`) is weekdays 09:15–15:30. It is used at `books.tsx:79,113,157,570`, `strategies.tsx:1169`, `pages.tsx:1044,1051` and `broker-view.tsx:87`.
  - `books.tsx:85` checks expiry by date only; a 17:30 IST expiry needs the time.
- **Instrument identity (NSE).**
  - `contract.ts:14-83` `parseContract`/`formatContract` handle NSE formats only, at 22 call sites; an unparsable symbol is shown raw.
  - `book-build.tsx:80-81` builds an NSE symbol, and `:905` sets exchange `'NFO'`.
  - Numeric `instrumentToken` at `entry-plan.ts:22` and `manual-order-plan.ts:249`.
  - `BrokerKind` is `'xts'|'zerodha'` (`api.ts:743`).
- **Mode.**
  - `api.ts:15` `DeskMode` is paper or live.
  - `mode.tsx:15-188` is a localStorage-backed provider, the pattern for a venue switch.
  - The route builders (`api.ts:2324-2467`) send `?mode=` and no venue.
- **Neutral or cheap.**
  - `sign`/`RED`/`GREEN`, `money`'s null handling, `ago`/`localTime`/`localStamp`.
  - Legs already carry strike, optType and expiry as separate fields.
  - A hash router with a flat `ROUTES` table (`shell.tsx:50-96`), so a `#/dx` section is additive.
  - The Dials panel is **schema-driven from desk-engine's `DIAL_SECTIONS` and presets** (`dials-plan.ts` header). New engine dials and presets appear without web edits.
  - Caddy serves `apps/web/dist` straight off disk, so a web-only change needs no restart.
- **Fewest-edit route.**
  1. A currency parameter on `format.ts`; fix the seven bypass copies, or leave the traders ones since that is another product.
  2. `sessionFor(venue)` replacing `inSession`.
  3. A Delta branch in `contract.ts` `formatContract`/`parseContract`.
  4. A venue context beside `mode.tsx`, plus a venue-aware API base in the route builders.
  5. Then `books.tsx`, `book-build.tsx` and `dials-panel.tsx` can serve dx books unchanged against a dx API with the same response shapes.

---

## 2. Integration shapes

### (A) Deep: a venue dimension through every layer

Seams it touches:
1. **instruments.** A `venue` on `InstrumentRow`/`InstrumentRef`, a contract multiplier, C/P to CE/PE mapping, string or namespaced ids.
2. **core.** A `SessionCalendar` replacing `MARKET_*` and `isMarketOpen` at about 30 call sites.
3. **bus.** Venue-namespaced tokens through every `Map<number,…>`: api QuoteCache and LiveBook, runner, gateway simulator, supervisor `chain-view`, traders `quotes.ts`.
4. **marketdata.** A Delta socket inside `desk-marketdata`; venue-aware sync and pruning.
5. **api.**
   - Rails route by venue.
   - Marketable tick taken per instrument.
   - Freeze bypass; venue day windows in `flattenWindow`, `pnl-jobs`, `rollup`, `day-guard` and `settle-expired`.
   - A multiplier in every money computation.
   - A venue-aware `measureOpenLots`.
   - The engine wire accepting non-share quantities.
6. **gateway.** `adapterFor(doc)` by venue; skip the freeze for Delta; Delta fill correlation, sweep and snapshot.
7. **supervisor and desk-engine.** An injected session, expiry instant and rate; no `Math.round(qty)`.
8. **runner and strategy-kit.** An injected session and candle anchor.
9. **web.** Currency and venue threaded through about 190 money call sites and the lot labels.

Size: about 8–12k changed lines over about 120 files in the five live NSE processes plus traders, on top of about 3k of new adapter code.

Reusable as-is: almost nothing untouched. Every live process changes.

Risk to NSE: **high**.
- Every NSE process is redeployed repeatedly, and restarts are operator-only and only while books are flat.
- desk-engine parity fixtures are at stake.
- Every cross-venue hazard in §1 has to be closed correctly:
  - the XTS `NSEFO` fallback;
  - `UNMEASURED_EXPOSURE` blocking NSE opens;
  - NSE `planSync` pruning Delta rows;
  - `md.health` overwrite;
  - token collisions;
  - the global 0.05 tick;
  - IST day windows.
- One miss lands on the live rupee desk.

### (B) Isolated: separate Delta processes and collections, reusing the pure packages

**New processes,** with their own pm2 file `ecosystem.dx.config.cjs` so a `startOrRestart` of desk apps never touches them, and vice versa:
- `dx-feed`: Delta WebSocket → its **own** `WsTransportServer` on a new port (e.g. `:8793`). *(Revised in §5: publish the same `md.tick`/`md.spot`/`md.health` names and payload shapes on that port. Isolation comes from the port, and compatibility from the shapes, so the reused supervisor's `chain-view` works unchanged.)* It syncs `dx-instruments` at boot, every 15 minutes and right after each 12:00 UTC settlement, writes `dx-marks`, and serves UTC-aligned history.
- `dx-exec`: the only process holding the trading key.
  - Queues: `dx-orders` (live) and `dx-paper-orders` (paper), as **two collections**.
  - Gates: the shared kill switch, the `desk-strategies` live allowlist with the reduce-only exemption, and a venue halt.
  - Paper goes through `SimulatorAdapter` fed by `dx.tick`; live goes through the Delta adapter.
  - Records: `dx-order-events`, `dx-fills`, positions `dx-positions-paper`/`-live` in **integer contracts**, a reconcile loop against Delta positions, funding cashflows, and settlement booked at the exchange settlement price.
- `dx-books`: desk-engine books on BTC. It needs its own `MasterPort`/`ChainSnap` over `dx.tick`, a `dx-books-registry`, its own lease key, and a decision wire carrying contracts to `dx-exec`. *(Revised in §5: this becomes a second, venue-configured instance of `apps/supervisor` rather than a new app.)*
- `dx-runner`: `StrategyBase` strategies with Delta implementations of `MarketData`, `OrderGateway` and `Clock`, plus a session port, and new BTC configs.
- `dx-api` (optional): read endpoints for the web. It authenticates against `desk-sessions` with `packages/auth` and the `AuthGate` pattern; the cookie is host-scoped, so it works on another port of the same host. Alternatively, a read-only `routes/dx.ts` inside desk-api, at the cost of one desk-api restart.

**Shared, cheap:**
- the kill-switch document;
- `desk-strategies` rows (kind `external`) for the on/off and password-gated live switch;
- `desk-users`/`desk-sessions`;
- `desk-brokers`, with a new kind `delta`;
- the web shell, with a new `#/dx` section.

**Reused unchanged:** `packages/bus`, `secrets`, `auth`, `pnl` (fed integer contracts with the result scaled by contract value, which is exact because P&L is linear in quantity), `greeks` math (B76 and `carryYield`), `brokers` `SimulatorAdapter` and the `BrokerAdapter` type, and `core` `roundToTick`.

**Reused with small additive, default-preserving changes (lane L3):**
- desk-engine:
  - session, calendar and close minute injected;
  - `yearFrac` to an expiry instant;
  - the rate as an input;
  - the `margin-project.ts:225` truncation removed.
- strategy-kit: a session port.
- greeks: an expiry-instant variant beside `yearsToExpiry`.
- payoff: the `lotSize` truncation removed and the scenario window injectable.
- marketdata-core: the candle anchor as a parameter.

Size: about 10k new lines plus about 0.5k changed in shared pure code.

Risk to NSE: **low**.
- No NSE live-path process changes behaviour.
- The only shared-code edits are additive, and the existing golden, parity and fixture suites must stay byte-identical.
- They load at the next operator restart.
- The only forced NSE restart is desk-api for the `BrokerKind` union, and only if credentials are managed through the existing Brokers page.

Remaining shared risks:
- one standalone Mongo, so a runaway dx writer hurts NSE latency; keep dx tick data off Mongo and TTL everything;
- the same box's CPU;
- humans confusing two desks in one dashboard.

### (C) Hybrid, recommended: B's isolation plus a thin venue-neutral spec

This is B, plus one new pure package, `packages/venue` (contract-first, about 300 lines). It defines `VenueSpec`:

```ts
{ id, currency, isOpen(ms), isTradingDay(dateKey), dayKey(ms), dayBoundaryMs(dayKey),
  expiryInstant(expiry), rate, contract: { value, qtyStep, tick } }
```

It ships an `NSE` instance that wraps today's constants exactly, and a `DX` instance:
- open 24x7;
- the day runs from one 12:00 UTC settlement to the next;
- expiry instant 12:00 UTC;
- rate about 0, priced off the perp or future forward with B76;
- contract value 0.001.

The L3 changes take a `VenueSpec` that defaults to `NSE`, rather than ad-hoc parameters, so the two venues share one vocabulary. A later convergence (one dashboard, one P&L page) then becomes a data question rather than a rewrite.

This is better than plain B because it stops the Delta stack from growing a parallel set of magic constants. It is better than A because the NSE live path stays untouched.

---

## 3. The specific questions

### 3a. Can desk-engine and StrategyBase run fractional-BTC contracts priced in USD without forking?

**desk-engine: yes, with additive changes rather than a fork.**

The arithmetic is unit-free: money is premium × lots × lotSize; the corridor is `delta_tol_pct` × spot; strikes are counted in steps. The "₹" dials just mean book currency.

What must change:
1. **Inject the session.** `session.ts` constants and `isTradingDay` are read inside `decide()` (`engine.ts:247`, `:269-279`). Unchanged, a BTC book is unmanaged outside 09:20–15:30 on NSE weekdays, which is the worst case for a short-gamma book over a weekend. Its daily expiry settle would also fire at 15:30 IST, two hours early and every day.
2. **Price to the expiry instant.** `yearFrac` (`marking.ts:212-225`) ignores the clock before expiry day and runs expiry day to 15:30. For 0–2 DTE BTC options that misprices tenor by hours. Price to the instant, using calendar time, which is correct for 24x7.
3. **Mark grid.** `markOf` clamps to the NSE session (`session.ts:154-163`). Confirmation streaks need a 24x7 grid, i.e. marks anchored on the venue day.
4. **Rate and forward.** `RISK_FREE = 0.065` (`marking.ts:103`) becomes a venue input; prefer the B76 forward.
5. **`margin-project.ts:225`.** `Math.trunc(lotSize)` gives 0. Feed Delta's own margin figure through the existing `MarginInput`, or drop the truncation.
6. **New BTC presets.** Calibrate in USD; the NSE presets assume SENSEX-wide wings.

Quantity model: **lots = integer contracts, lotSize = 0.001 (BTC per contract), prices in native USD per BTC.** The engine is fine with this. The host is not:
- the supervisor rounds `lots × lotSize` to an integer share count and drops it as 0 (`engine-host.ts:2416-2417`, `:2508`);
- the api engine wire insists on a positive integer quantity (`routes/engine.ts:148`, `:268`);
- the gateway insists `quantity % lotSize === 0` (`gateway.ts:229`, `:242`).

That is three more reasons the Delta host must be its own (`dx-books`), carrying contracts.

*Revised in §5.2, because the supervisor is now reused:* quantities at every desk-side boundary (the ledger view, the decision wire, fill reports) are BTC on a 0.001 grid, the analogue of NSE shares. Integer contracts are the stored truth and the exchange-edge unit. The host's two rounding sites become step-aware, which is identical for NSE.

Alternative for shape A only: re-denominate at the edge, so 1 unit = 1 contract, lotSize 1, and price, strike and spot are all × 0.001. That keeps every integer check valid, but every displayed price and strike is 1000× off unless every view un-scales it. I do not recommend it.

**StrategyBase: yes, the ports are clean (`ports.ts:211-222`).**

What must change:
1. **A session port on `StrategyContext`, defaulting to NSE.** Needed by `isMarketOpen` catch-up (`base.ts:302`), `pastClose` (`:509`) and the weekday cron (`schedule.ts:301`).
2. **A candle anchor parameter** (`candles.ts:114-123`).
3. **New BTC configs.** The `Underlying` union and `STRIKE_STEP` check (`strategy-config/src/index.ts:17-31`, `:143`) are NSE-only, and every config hard-codes IST minutes.

Numeric product ids work as `token: number` provided the Delta runner has its own `MarketData` and does not share a token cache with Kite.

The intraday strategy shapes (opening range, square-off before the close) need a defined artificial session on BTC. That is a strategy decision for the delta-strategies agent, not plumbing.

### 3b. What in greeks and payoff assumes NSE?

**Rate.**
- greeks `bookGreeks` defaults to 0.065 (`greeks/src/index.ts:313`).
- payoff `DEFAULT_RATE` is 0.065 (`legs.ts:35`).
- desk-engine `RISK_FREE` is 0.065 (`marking.ts:103`).
- For BTC, price Black-76 off the perp or future mark. `b76*` and `carryYield` already exist. The discount rate is about the USD short rate, or 0 if premium is cash-settled at expiry; delta-docs should confirm when premium is paid and settled.

**Expiry instant.**
- greeks `yearsToExpiry` prices to 15:40 IST (`index.ts:428-433`).
- desk-engine prices to 15:30 IST on expiry day and in whole days before it (`marking.ts:212-225`).
- payoff scenario columns are clamped to 09:15–15:40 IST (`scenario.ts:88-135`).
- Delta needs 17:30 IST (12:00 UTC), taken from the instrument's own `settlement_time` rather than from a date.

**Time basis.**
- greeks and payoff already use calendar time (`/365`), which is right for 24x7.
- NSE trading-day counting appears in:
  - desk-engine's `isTradingDay` (holiday list, `session.ts:109-146`);
  - delta-lean playbook session counts and "trading minutes to expiry / session length" (`playbook/calendar.ts:62`, `session.ts:74-80`);
  - payoff `scenario-grid` (already injectable, `:43`).

**Option type.** `'CE'|'PE'` in greeks (`:28`) and instruments (`master.ts:42`). Map Delta's call and put at the adapter boundary.

**Margin.** payoff `margin.ts` and `packages/span` are NSE SPAN proxies. For Delta, use the exchange's margin.

### 3c. How does a 24x7 market interact with the day-guard, daily P&L rollups, daily limits and the 08:45 sync?

**Day-guard.**
- Its "day" is the IST calendar date (`day-guard.ts:82`, `:311`), and paper re-arms at 08:45 IST (`:71`).
- On Delta, an IST-midnight day splits the 17:30-to-17:30 expiry cycle. A paper book stopped at 23:00 sits out about 10 hours of live market.
- It reads P&L only from `desk-decisions` (`:46`), so it would never see Delta fills, and must not (§1, the exposure hazard).
- Live never auto-re-arms, which is fine and should be kept.
- **Plan:** a dx day guard reusing the pure pieces (`guardTrigger`, `guardRecordId`, the record shape), keyed by `VenueSpec.dayKey`, with the day boundary at 12:00 UTC.

**Daily rollups.**
- Snapshots run only during `inTradingSession`: weekdays 09:15–15:40 IST (`rollup.ts:605-610`). There would be no Delta snapshots at night or at weekends.
- The rollup runs at or after 15:40 IST for the IST day (`pnl-jobs.ts:720`), mid-cycle for Delta.
- **Plan:**
  - `dx-pnl-snapshots` taken around the clock at a slower cadence;
  - `dx-daily-reports` per venue day, written just after each settlement, so the report includes that day's expiries;
  - never write Delta rows into `desk-daily-reports`, which hold one currency and are irreplaceable.

**Daily limits.**
- `dailyLimits` on `desk-strategies` rows are bare numbers, formatted as ₹ (`day-guard.ts:249`).
- Delta tags can live in `desk-strategies` for the switches, but leave `dailyLimits` unset there, so the api guard stays inert, and keep USD limits in the dx registry with an explicit currency.

**The 08:45 sync.**
- It is once per IST day (`marketdata/src/main.ts:114`, `:140`), and `planSync` prunes expired rows by numeric token from `instrument` (`instrument-sync.ts:127-138`).
- Delta lists and expires contracts daily, so its sync must run at boot, every 15 minutes and right after each settlement, into `dx-instruments`, keeping expired rows that open positions still reference (the same guard NSE uses).

**Also affected:**
- `flattenWindow` uses the IST day (`decision-plan.ts:423-429`).
- `settle-expired` books at 15:30 IST (`:255-265`).
- `submit.ts` treats "expires today" as an IST date (`:717-721`).
- On Delta, the exchange settles every expiry itself, so the dx ledger should book settlement from the exchange's settlement price (paper and live alike) rather than inventing a close.

### 3d. How broker credentials are sealed and read, and how to store the Delta key the same way

**Storage.**
- Collection `desk-brokers`, one document per `kind`, with a unique index (`brokerstore.ts:122`).
- `meta` (base URL, labels) is stored in clear, guarded by a sensitive-key regex (`:80`).
- The whole credential object is sealed as **one** blob: `seal(JSON.stringify(secret), key)` (`:158-159`). That is AES-256-GCM, written as `v1.<base64(iv‖tag‖ct)>` (`secrets/src/index.ts:92-101`), with the key from `DESK_MASTER_KEY` via `requireMasterKey()` (`brokerstore.ts:91-104`) and `keyFromEnvValue` (`secrets/src/index.ts:159`).

**Reading.**
- `readSecret(kind)` returns `absent`, `ok` or `unreadable`, never just two outcomes (`brokerstore.ts:176-189`).
- Consumers construct `new BrokerStore(db, requireMasterKey())`; see `order-gateway/src/main.ts:471-494` and `marketdata/src/zerodha-login.ts:423`. They fall back to env when the store is unreadable.
- The api manages it through `routes/brokers.ts`, which includes a real-login `test` action (`:114-130`).

**To add Delta:**
1. Extend `BrokerKind`, `BROKER_KINDS` and `isBrokerKind` (`brokerstore.ts:30-36`).
2. Add `testDelta` (a signed read, e.g. a wallet balance) to the `test` dispatch (`routes/brokers.ts:126-129`).
3. Extend web `BrokerKind` (`web/src/api.ts:743`) and the Brokers card.
4. Store `secret: {apiKey, apiSecret}` and `meta: {baseUrl, label}`.
5. `dx-exec` reads it with the same three-state handling.

Two notes:
- Because the store is unique by kind, give testnet and production keys separate kinds (`delta`, `delta-testnet`) if both are needed.
- Give `dx-feed` either no key (public channels) or a separate read-only kind, so only `dx-exec` holds trade permission.

Cost: the union change needs one desk-api restart, by the operator, with books flat.

---

## 4. Recommendation and build order

**Recommendation: shape C,** isolated Delta processes and collections plus a thin shared `packages/venue` spec, sharing only the control plane: the kill switch, `desk-strategies` switches, auth and sessions, `desk-brokers`, and the web shell.

The reasons, from what the code shows:
1. The NSE assumptions that matter are not in the pure engines. They sit in the live order path of five running processes:
   - integer share quantities in the supervisor wire, the engine route and the gateway;
   - the global 0.05 tick and paise rounding;
   - Kite numeric tokens on one broadcast bus;
   - IST day windows in P&L, guard and flatten.
2. I found **concrete cross-venue failure modes** that only isolation removes by construction:
   - the XTS `exchangeSegment` fallback to `NSEFO` (`xts-protocol.ts:256`);
   - `UNMEASURED_EXPOSURE` blocking NSE opens if Delta legs touch `desk-decisions` (`api/main.ts:138-164`);
   - NSE `planSync` pruning, and token collisions in `instrument`;
   - `md.health` overwrite and numeric token collisions on `md.tick`;
   - IST-anchored rollups and guards.
3. The pure engines are about 90% venue-neutral already. The rest is a handful of additive, default-to-NSE parameters, provable by the existing parity and golden suites.
4. Paper/live separation by collection can be done properly from scratch. The NSE side already bends it for engine paper orders (`rail.ts:162-169`, `:560-592`).
5. Restarts stay the operator's and touch Delta only. A separate pm2 file means a Delta deploy never bounces an NSE book.

**Top risks:**
- Positional BTC books unmanaged over nights and weekends unless the session injection lands before the first paper book.
- Quantity units. Store integer contracts and derive BTC; never net fractional quantities, because `qty === 0` flat checks break.
- Shared standalone Mongo and CPU. Keep dx ticks off Mongo; TTL dx marks.
- Operator confusion between two desks in one UI. Show currency on every dx figure and keep a separate `#/dx` section.
- Delta specifics still unverified: the `client_order_id` length limit (XTS already truncates at 45), whether size is an integer, the settlement price source, funding cadence and margin currency.

### Lanes (original split, superseded by §5.5 for the BULL-S scope)

Agree `packages/venue`'s interface and `packages/dx`'s client interface in the lane briefs first (contract-first), so the lanes can code against them before they merge.

| Lane | Scope (new files unless noted) | Depends on | Touches NSE live path? |
|---|---|---|---|
| **L0 venue** | `packages/venue`: `VenueSpec`, `NSE` (wraps current constants verbatim), `DX`; pure, with tests | none | No consumers yet |
| **L1 dx client** | `packages/dx`: HMAC signer, REST client (rate-limit aware), WS client (public and private), symbol/contract normaliser (C/P→CE/PE, contracts↔lots), `DeltaAdapter implements BrokerAdapter` (modify: true, reduce-only); fixture-recorded tests, no network | none | No |
| **L2 dx-feed** | `apps/dx-feed`: own bus server (env port, ephemeral in tests), `dx.*` topics, `dx-instruments` sync (boot, every 15 min, after settlement), `dx-marks` with TTL, UTC history endpoint | L1 interface | No |
| **L3 engine params** | *Edits:* desk-engine (`session.ts`, `engine.ts`, `marking.ts`, `margin-project.ts:225`, delta-lean calendar), strategy-kit (session port on `StrategyContext`, `base.ts`, `schedule.ts`), greeks (instant-based `yearsToExpiryAt`), payoff (`legs.ts:99`, `candidates.ts:307,363`, scenario window), marketdata-core (candle anchor). All take `VenueSpec`, default NSE; parity, golden and traders suites unchanged | L0 interface | **Yes, additive and behaviour-identical**; picked up at the next operator restart; one `make check` on the merged tree |
| **L4 dx-exec** | `apps/dx-exec`: `dx-orders` and `dx-paper-orders` queues (claim compare-and-set), gates (shared `desk-safety` kill switch, `liveAllowlistFromStrategies`, venue halt, reduce-only exits), simulator over `dx.tick`, journal, integer-contract ledger, broker reconcile, funding, exchange settlement, submit endpoint | L1 | No (reads `desk-safety` and `desk-strategies` only) |
| **L5 dx-books** | `apps/dx-books`: desk-engine host with a Delta `MasterPort`/`ChainSnap`, `dx-books-registry`, own lease key, decisions in contracts to dx-exec, USD BTC presets | L3, L4 interface | No |
| **L6 dx-runner** | `apps/dx-runner` plus BTC strategy configs on `StrategyBase` with Delta ports and a 24x7 session (coordinate with delta-strategies) | L3, L4 interface | No |
| **L7 control plane and UI** | *Edits:* `brokerstore.ts` kind `delta` and `routes/brokers.ts` `testDelta`; web `BrokerKind`, Brokers card, `format.ts` `usd()`, `#/dx` pages. *New:* `dx-api` (auth via `desk-sessions`), `ecosystem.dx.config.cjs` | L4 and L8 read shapes | One desk-api restart (operator, flat). Web is live on build |
| **L8 dx P&L and guard** | `apps/dx-exec/src/pnl/*` or `apps/dx-pnl`: 24x7 snapshots, per-venue-day rollups at settlement, dx day guard reusing `day-guard.ts`'s pure functions, USD daily limits | L4 ledger shape, L0 | No |

**Order.**
- Phase 1, in parallel: L0, L1, L2, L3, L7 (credentials and web shell).
- Phase 2: L4, L8.
- Phase 3: L5 and L6, both paper only.
- Live: a separate trade-permission key, a `desk-strategies` row per tag, the password-gated live switch and a reduce-only drill. Flip one tag after an agreed paper period.

**Lane hygiene (from this repo's history):**
- Each worktree needs its own `npm ci`, and must fast-forward-merge the integration branch first, because worktrees start at the session head.
- api Mongo suites use fixed db names. New dx suites must use unique, lane-suffixed db names from day one, and ports from env with ephemeral defaults, never `:8790`/`:8791`.
- Watch hand merges of shared `.ts` and CSS files for dropped closing braces.
- Only L3 and L7 edit existing files, and they edit disjoint ones.

---

## 5. Scope update (operator, via lead): BULL-S as a desk-engine book first

The first BTC strategy is **BULL-S** as a desk-engine book. It is supervisor-managed, with editable Dials and presets, one book per expiry (daily, weekly or monthly), and a strike-jump dial of 1 or 2. It is **not** a hosted runner strategy. This changes what to reuse.

### 5.1 What BULL-S is today, and where it does not fit the existing engine paths

Today BULL-S is a hosted `StrategyBase` class, `PremiumLegBookStrategy` (`packages/strategies/src/premium-leg-book/strategy.ts`), with config `BULL_S_1` (`configs/bull-s.ts:3-18`):
- **Trigger.** The reference (the current future) crosses the ATM strike (`logic.ts` `isCrossover`, `strategy.ts:186-200`).
- **Entry.** Sell an ATM straddle, CE and PE at the same strike, at the current pyramid size. Only one live group per ATM (`#openAtms`).
- **Stop.** Each group has a combined stop: `trunc((ce+pe) × 1.25)` at entry (`logic.ts` `combinedStopTrigger`), checked against the summed LTPs on every tick. On a hit it buys back PE then CE, and the ATM gate clears so the next crossover can re-open there.
- **Sizing.** `pyramid-up` from 1, step 1, **uncapped by owner decision D9** (`bull-s.ts:8`, `logic.ts` `nextPyramidSize`).
- **Session.** Square-off at 15:20 IST; groups and size reset at day start (`strategy.ts:76-81`).
- **Golden test.** A legacy-parity golden test exists: `packages/strategies/test/golden/premium-leg-book-bull.test.ts`.

None of the three existing decide paths can express it:
- **Recenter `decide()`** (`engine.ts`) is a corridor/shed/shift strangle manager with no crossover-straddle entry.
- **The playbook frame** (`delta-lean/playbook/decide.ts`) enforces defined risk.
  - `uncovered short` is an urgent exit (`:506-507`), and every short needs a held `cover` long (D1/D2, `:347-364`, `:413-417`).
  - It runs one trade at a time (`pb.tradeOpenMs`, `pb_max_entries`, `:283`, `:695`) on a hard IST clock (14:50/14:55/15:00, header step 2).
  - BULL-S is naked short straddles, with several concurrent groups at different strikes.
- **`decideDeltaLean`** is hold-and-adjust with a single lean.

**So BULL-S needs a fourth decide path, `decideBullS`,** selected by its own dial, beside `delta_lean_enabled` and `pb_playbook`. It follows the pattern `engine-host.ts:1859-1866` already uses to dispatch.

Because it is pure and venue-neutral, it can also run on NSE paper. Better still, the existing BULL golden tape becomes its acceptance test.

### 5.2 Revised reuse: run the supervisor as a second instance

Building BULL-S as a desk-engine book pulls in the whole book machinery: the registry, Dials and presets UI, working packages, preemption, the fold and the actual report. That machinery lives in `apps/supervisor` (`engine-host.ts`, 3,122 lines) and in the web Books, Build and Dials screens. Rewriting it for dx would duplicate about 10k lines. So:

**`apps/supervisor`, venue-configured, runs as a second pm2 process `dx-supervisor`** (`DESK_VENUE=dx`). This replaces the new `dx-books` app from §2(B) and §4. The seams it needs are all enumerable:

- **Collections.** The names hard-coded today become a config map:
  - `desk-books-registry`, `desk-strategies` (`main.ts:568-572`);
  - `desk-books` (`:1197`), `desk-gateway-orders` (`:1122`, `working-orders.ts:50`);
  - `desk-marks` (`:1001`), `desk-subscriptions` (`:1032`);
  - `desk-supervisor-state`, `desk-book-marks`, `desk-supervisor-lease` (`state-store.ts:90`, `marks-journal.ts:42`, `lease.ts:45`).
  - Working orders become **per mode**: dx paper and live orders sit in different collections (§5.4).
  - The lease uses its own collection or `key` (`lease.ts:59-66`).
- **Bus, API and master.** Bus and API URLs are env already (`main.ts:1541-1542`). `MasterPort` must be built from `dx-instruments` instead of the Kite `instrument` collection (`main.ts:1439`, `:1562`).
- **Time.** `istDateOf`, `minuteOfDay`, `dteOf` (`engine-host.ts:629`, `:655`, `:2098`) and `tradingMinutesToExpiry` move to `VenueSpec`.
- **Quantity rounding.** `lotsOf` becomes `Math.round(qty/lotSize)` (`:822`). The wire quantity becomes `roundToStep(lots×lotSize, venue.qtyStep)` (`:2416`, `:2508`). With qtyStep 1 both are identical for NSE; for dx the step is 0.001. Audit the other qty↔lots sites too: `:1015-1032`, `:2251`, `:2486`, `:2940-2952`, `:3017-3038`.
- **Dispatch.** Add `bs_enabled` to `#decide` (`:1859`). Let BULL-S stop and flatten triggers preempt a working entry, as `DL_EXIT_TRIGGERS` does (`:618`, `:1605`). Hydrate `ruleState.bs` in `state-store.ts:373-378`.
- **Margin.** `book-margin.ts` reads Kite margins (`desk-book-margin`). For dx, either dx-gateway writes Delta's margin in the same shape, or the guard runs without it.
- **Fallback.** If the operator wants **zero edits** to `apps/supervisor`, fork it into `apps/dx-supervisor`. That is about 8.6k duplicated lines and permanent drift. I would not.

**Units, final rule.**
- On the desk side of the exchange edge, quantity is BTC on a 0.001 grid, exactly as NSE quantity is shares: in the `desk-books`-shaped ledger view, on the decision wire and in fill reports.
- lots = contracts, lotSize = 0.001, prices in native USD per BTC.
- dx-gateway converts with `contracts = Math.round(qty/0.001)` and **stores integer contracts as the truth**. When contracts is 0, the view's quantity is exactly 0, so flat checks stay safe.
- The dx decision endpoint validates "a positive multiple of 0.001" where NSE validates "a positive integer".

**The dx API mirrors desk-api's shapes,** so both the reused supervisor and the reused web screens work against it:
- What the supervisor calls (`DeskApiPort`, `main.ts:256-275`; `decisions-client.ts:127`):
  - `POST …/engine/decisions`
  - `POST …/books/registry/:tag/actual`
  - `POST …/broker/orders/:id/cancel`
- What the Books, Build and Dials screens call (`api.books`, `api.chain`, `api.instruments`, `api.underlyings`, `api.seed`, `api.positions`, `api.pnl`, the dials PATCH and start/stop): the same response shapes.
- It reuses the pure modules: `apps/api/src/books-registry.ts` (validation, `engineSwitchChanges`) and desk-engine's `resolveDials`, `DIAL_SECTIONS` and `PRESETS`.

**The dx feed publishes `md.tick`/`md.spot`/`md.health` with the NSE payload shapes on its own port** (`:8793`). The supervisor's `chain-view` and spot ring then consume it unchanged; NSE consumers never connect to that port.

`dx-instruments` uses `InstrumentRow` shape:
- `instrument_token` is the Delta product id; `tradingsymbol` is the Delta symbol; `name` is `BTC`;
- `expiry` is the IST date of the 12:00 UTC settlement; `lot_size` 0.001; `tick_size` is the exchange's;
- `CE`/`PE` are mapped from call and put.

That lets an `OptionMaster` or a small `DxMasterPort` answer `MasterPort`'s five questions.

### 5.3 The BULL-S decide path, as a lane brief

The dial names are proposals. Every `bs_*` dial gets a typed off-state, the house rule in `dials.ts:1-23`:

| Dial | Meaning | Default (off) | Notes |
|---|---|---|---|
| `bs_enabled` | Selects `decideBullS` | false | Goes into `ENGINE_SWITCH_DIALS` (`books-registry.ts`), so the switch is guarded like `delta_lean_enabled` |
| `bs_strike_jump` | Crossover grid in **listed strikes**: 1 = every strike, 2 = every second strike; the straddle sells the grid strike crossed | 1 | Integer, validated to {1,2} in `resolveDials` |
| `bs_reference` | Price whose crossing triggers: 0 = chain forward (`ChainSnap.spot`), 1 = index spot ring | 0 | NSE BULL-S uses the future; BTC options settle on the index |
| `bs_stop_mult` | Combined stop = (ce+pe entry) × mult | 1.25 | No `trunc`: that was a rupee artefact (`logic.ts`) |
| `bs_stop_basis` | 0 = summed LTP (legacy), 1 = summed exit side (ask) | 0 for NSE parity, 1 suggested for BTC | |
| `bs_lots_start` / `bs_lots_step` / `bs_lots_cap` | Pyramid; cap 0 = uncapped (D9) | 1 / 1 / 0 | **Operator decision for BTC:** D9's "uncapped" was signed off for NSE |
| `bs_reset_each_day` | Reset groups and size at the venue-day boundary | true | Legacy `onDayStart`; weekly and monthly books may want false |
| `bs_flat_before_expiry_min` | Flatten N minutes before the expiry instant; 0 = hold to cash settlement | 30 suggested | Replaces the 15:20 square-off |
| `bs_no_entry_before_expiry_min` | No new groups this close to expiry | 60 suggested | |

**State.** `RuleState.bs` holds:
- `groups[{strike, lots, ceEntry, peEntry, trigger, openedMs, ceOpen, peOpen}]`;
- `size`, `lastRef`, `lastRefMs`.

A `hydrateBullState` beside `hydratePlaybookState` fills it. Recovery re-baselines when `lastRefMs` is stale, the analogue of `#reBaseline` (`strategy.ts:55-64`), so a restart never fires a phantom crossover.

**Actions.** Only the existing `EngineAction` ops: two `open` (Sell), then two `close`, in PE-then-CE order for parity.

**Triggers.** Add `bs-entry`, `bs-stop`, `bs-flat` to `TRIGGERS` (`types.ts:241`), which desk-api and dx-api validate against.

**Session and expiry.** Taken from `VenueSpec`: 24x7 for dx, NSE hours for NSE.

**Acceptance.**
1. Replay the existing BULL golden tape through `decideBullS` with NSE `VenueSpec`, `bs_strike_jump` 1, `bs_stop_basis` 0 and an uncapped pyramid. It must emit the same open/close sequence as `PremiumLegBookStrategy`, modulo marketable pricing.
2. Synthetic BTC tapes covering:
   - jump 2;
   - crossings across midnight and weekends;
   - an entry blackout near expiry;
   - the flatten before 17:30 IST;
   - hold-to-settlement;
   - recovery after a restart.

**One book per expiry.** Registry rows look like `{tag: BTC-bull-s-<cls>-<expiry>, symbol: 'BTC', expiry, preset: bull-s-daily|weekly|monthly}`. A `scripts/dx-roll.mjs` modelled on `scripts/delta-lean-roll.mjs` (create, start, switch on, then settle, stop, erase, in separate loops) creates a book for each newly listed expiry of each class. It retires a book after its settlement, booking the **exchange's** settlement price, never an invented close.

### 5.4 Data plane, unchanged in spirit from §2(B) but mirroring NSE's split

- **`dx-api`** (the desk-api analogue):
  - the decision endpoint, folding the ledger (`dx-books` in `desk-books` shape, contracts stored);
  - the registry routes;
  - rails into **`dx-gateway-orders` (live) and `dx-paper-orders` (paper)**: two collections. This does not copy NSE's `mode:'paper'` field (`rail.ts:560-592`).
  - gate 1: the kill switch, the allowlist and the venue halt;
  - web read routes;
  - auth against `desk-sessions`.
- **`dx-gateway`** (the order-gateway analogue):
  - It claims from both queues with a **fixed adapter per collection**: the simulator only for paper, Delta only for live. Paper cannot reach Delta by construction.
  - Reuse `OrderQueue` with an injected collection (`order-gateway/src/queue.ts`).
  - Fills, journal (`dx-order-events`, `dx-fills`), reconcile against Delta positions, cancels, and settlement booking.
  - Gate 2: re-read `desk-safety` and `desk-strategies` per order, as `order-gateway/src/main.ts:1610-1633` does.
- **`dx-feed`:** as in §5.2.
- **Deferred:** `dx-runner` (hosted strategies), perps as traded instruments, and funding.

### 5.5 Revised lanes, weighted to the first paper BULL-S book

**Contract-first:** the lead writes four short briefs before the lanes start:
1. the `VenueSpec` interface;
2. the BULL-S dial table above, the `decideBullS` signature, the `RuleState.bs` shape and the trigger names;
3. the dx collection shapes (the `desk-books`, `desk-gateway-orders` and `desk-books-registry` shapes) plus the BTC-on-a-0.001-grid quantity rule;
4. the dx-api endpoint list, with the same paths and response shapes as the desk-api calls named in §5.2.

| Lane | Files (new unless *edit*) | Starts | NSE exposure |
|---|---|---|---|
| **B1 BULL-S engine** (critical path) | New `packages/desk-engine/src/bull-s/*`. *Edit:* `dials.ts` (`bs_*`, `DIAL_SECTIONS`, `DEFAULT_DIALS` off, `resolveDials` checks), `presets.ts` (`bull-s-daily`/`-weekly`/`-monthly`), `types.ts` (`RuleState.bs`, `hydrateBullState`, `TRIGGERS`, `EngineInputs.venue?`), `index.ts` exports (B1 owns `index.ts`). Tests: golden-tape parity and BTC tapes | now | Additive. The NSE Dials panel gains an inert BULL-S section. Default off, so no NSE book changes |
| **B2 venue and engine time** | New `packages/venue` (NSE + DX). *Edit:* desk-engine `session.ts`, `engine.ts`, `marking.ts`, `margin-project.ts:225`, the delta-lean calendar and session reads; greeks `yearsToExpiryAt`. Everything defaults to NSE | now | Behaviour-identical: the 1,152 parity marks, decision fixtures and traders advice suites must not move |
| **B3 supervisor venue config** | *Edit:* `apps/supervisor/*` (the collection map, `MasterPort` source, the time and rounding sites, the `bs_enabled` dispatch and preemption, state hydrate). *Edit:* `apps/api/src/books-registry.ts` (`ENGINE_SWITCH_DIALS += bs_enabled`) | against briefs now; merges after B1 and B2 | Behaviour-identical for NSE: supervisor lifecycle tests unchanged. The NSE supervisor picks it up only at an operator restart; `dx-supervisor` is a new process |
| **X1 dx client** | `packages/dx`: signer, REST, WS, normaliser to `InstrumentRow`, `DeltaAdapter`; fixture tests, no network | now | None |
| **X2 dx-feed** | `apps/dx-feed`: `md.*` shapes on `:8793`, `dx-instruments` sync (boot, every 15 min, after settlement), `dx-subscriptions` → WS subscriptions, index spot, `dx-marks` with TTL | after X1 interface | None |
| **X3 dx-gateway** | `apps/dx-gateway` (§5.4) | after X1 | Reads `desk-safety`/`desk-strategies` only |
| **X4 dx-api** | `apps/dx-api` (§5.4): decisions, ledger fold, registry, rails, web reads, auth | against briefs now | None |
| **W1 web and credentials** | *Edit:* `apps/web` (a venue context beside `mode.tsx`, a venue API base, a `format.ts` currency, `sessionFor`, the `contract.ts` Delta branch, `#/dx` mounting the Books, Build, Dials, Positions and P&L screens) and the broker kind `delta` (`brokerstore.ts`, `routes/brokers.ts` `testDelta`, the web Brokers card) | now | One desk-api restart for the broker kind (operator, flat). Web is live on build |
| **R1 roll, P&L and guard** | `scripts/dx-roll.mjs` (one book per expiry); dx P&L snapshots around the clock; venue-day rollups at 12:00 UTC; dx day guard reusing `day-guard.ts`'s pure functions; USD limits | after X4 | None |

Shared-file ownership:
- B1 owns desk-engine `dials.ts`, `presets.ts`, `types.ts` and `index.ts`.
- B2 owns `session.ts`, `engine.ts`, `marking.ts`, `margin-project.ts` and `delta-lean/*`.
- B3 owns `apps/supervisor/*`.
- W1 owns `apps/web/*` and `brokerstore.ts`/`routes/brokers.ts`.

**Critical path to the first paper BULL-S book:** B1 + B2 → B3, with X1 → X2 + X3 + X4 alongside → integration: `dx-supervisor` + `dx-feed` + `dx-api` + `dx-gateway`, one daily book created by hand → R1 for book-per-expiry automation.

W1 runs alongside throughout.

Live comes later, separately: a trade-permission key, a `desk-strategies` row per tag, the password-gated switch, a reduce-only drill and a desk-level contract cap in dx-gateway.

**Open decisions for the operator (BULL-S on BTC):**
1. What "strike jump" means. I read it as the crossover grid, every 1st or 2nd **listed** strike. Delta's strike spacing may be non-uniform by expiry and by distance from ATM; delta-docs should confirm.
2. The reference: index spot or chain forward.
3. Whether to keep the D9 uncapped pyramid on BTC. I recommend a finite `bs_lots_cap` plus a gateway contract cap.
4. Whether to flatten before the 17:30 settlement or hold to cash settlement.
5. Whether weekly and monthly books reset each venue day.
6. The stop basis: LTP (legacy parity) or exit side.
