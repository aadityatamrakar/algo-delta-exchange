# Delta desk — BULL-S books on BTC options (paper first)

**Date:** 2026-11-03 · **Repo:** `/opt/algomaker-delta` (cloned from `/opt/algomaker` at `0d390c37`) ·
**Status:** design, for operator approval

Research behind this document (scratchpad, 3 Nov): `delta-api-reference.md` (API), `delta-market-structure.md`
(live chain snapshot), `delta-seams.md` (where the code is NSE-specific, §5 BULL-S), `delta-strategies.md`
(BULL-S on BTC, sim + stress), `delta-web-survey.md` (web NSE assumptions). Copied into
`docs/research/delta/` with this spec.

---

## 1. Intent

Run our own option books on **Delta Exchange India BTC options**, starting with **BULL-S**, on paper, 24x7,
off Delta's live prices, with every setting editable while the book runs, so the operator can watch how it
behaves across expiries and strike jumps before any real money goes in. Positional books and intraday-style
books are the same machinery: a book holds until stop/expiry, and a profit target closes it early "so a fast
day works as intraday".

The live NSE desk on the same box must not be touchable from any of this.

## 2. What the operator decided (as said)

| # | Decision | When |
|---|---|---|
| D1 | Separate codebase: clone the repo into a new directory and make a Delta-specific version. The NSE desk is untouched. | 3 Nov |
| D2 | Venue: Delta Exchange India, BTC options. API key created, server IP whitelisted. Intraday strategies and positional books. | 3 Nov |
| D3 | **BULL-S is the first strategy**, test-run first. | 3 Nov |
| D4 | Variants: today's BULL-S moves on **1 strike**; a new variant **jumps 2 strikes**; and **different expiries**. | 3 Nov |
| D5 | Build it as a **book with changeable settings** (the stock-book / Dials way), a "BULL-S based option management book". | 3 Nov |
| D6 | **Hold** straddles (until stop or expiry); **close by manual trigger**; a **target** — if it is reached fast the book closes, so it works as intraday. | 3 Nov |

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. Paper BULL-S books on BTC daily, weekly and monthly expiries, in 1-strike and 2-strike flavours, running
  side by side, managed 24x7 by the supervisor, with Dials editable from the dashboard (effective at the next
  decision).
- G2. P&L, legs, orders and decisions visible on the dashboard in USD (₹ at Delta's fixed 85 as a second figure).
- G3. Book-level controls: Close book (manual), profit target, loss cap.
- G4. The live path built to the same gates as NSE (switch, password, kill switch, caps) but **off**; going live
  is a later, separate decision.
- G5. Delta API key stored sealed, the same way XTS is, with a "test" that does a signed read.

**Non-goals (this round)**
- Hosted runner strategies on BTC (`apps/runner`), perps hedging/funding, any other playbook port (the analyst's
  secondary list — debit spread, 0-DTE fly, weekly condor — is a later round).
- NSE features in the clone: Kite feed, XTS, Odin traders desk (`apps/traders`), NSE strategies, `archive/`.
  They are removed or left dormant; nothing starts them.
- Tax/TDS reporting, INR ledgers.

**Anti-goals (failure even if it "works")**
- Anything in the clone reaching the live desk's database, ports, pm2 processes, cookies or broker.
- A BTC book unmanaged at night or on a weekend because a session check still thinks in NSE hours.
- A paper order reaching Delta. One queue as on NSE (`desk-gateway-orders` with `mode`), but the dx gateway
  routes to Delta **only** when `mode === 'live'` exactly AND the box flag `DESK_DX_LIVE=1` is set; anything else
  — missing, misspelt, paper — goes to the simulator (NSE's rule, anything not 'paper' is live, is inverted).
- A fractional quantity rounding to 0 and reading as "flat", or an order silently dropped for the same reason.
- An invented settlement: expiries settle at **Delta's** settlement price, never a made-up close.
- An uncapped pyramid preset. (On NSE the uncapped pyramid is an owner decision; on BTC every shipped preset has
  a cap; the operator can raise it per book.)

## 4. Constraints — the facts this rests on

**Delta India (from the API research; UNCONFIRMED items marked)**
- REST `https://api.india.delta.exchange` (India keys only; `api.delta.exchange` is Global and rejects them).
  Testnet REST `https://cdn-ind.testnet.deltaex.org`.
- WebSocket: public `wss://public-socket.india.delta.exchange` with the **new** channel names (`ticker`,
  `ob_l1`, `ob_l2`, `trades`, `spot_price`, compact keys) — the old `v2/ticker`, `l2_orderbook`… were
  retired 31 Oct 2026. Private `wss://socket.india.delta.exchange`, `key-auth`, signing `GET<ts>/live`.
- Auth: `signature = hex(HMAC_SHA256(secret, METHOD + timestamp + path + queryString(with '?') + body))`,
  headers `api-key`, `timestamp` (seconds), `signature`; valid 5 s; `User-Agent` mandatory; IPv4 from the
  whitelisted IP.
- BTC option: **1 contract = 0.001 BTC**; `size` is an integer count of contracts; price is **USD per 1 BTC**
  (a contract costs price × 0.001); tick **$0.10**; European, cash-settled on a 30-min TWAP of `.DEXBTUSD`;
  **every expiry settles 12:00 UTC = 17:30 IST**; new dailies list at 17:30 IST then a 5-min auction.
- Chain on 3 Nov: 3 dailies, Friday weeklies, month-end monthlies. Strike spacing near ATM: **daily $200**
  (wings $400), **weekly $500** (wings $1000), **monthly $1000**. Read strikes from the chain; never compute them.
- Fees 0.01 % of notional, capped at 3.5 % of premium, + 18 % GST; settlement fee at taker rate on contracts
  open at expiry (cap UNCONFIRMED).
- Orders: limit/market (market on options UNCONFIRMED — we only send priced limits), `gtc`/`ioc` (no FOK),
  `post_only`, `reduce_only`, `client_order_id` ≤ 32 chars unique among open orders, prices as strings, batch ≤ 50.
- Rate limit 20,000 units / 5 min (read 3, order 5, batch 25, history 10); 429 + `X-RATE-LIMIT-RESET`.
- Dead-man's switch: `/v2/heartbeat` cancels open orders if acks stop.
- Balances in INR at a fixed **1 USD = 85 INR**. Margin: isolated / cross / portfolio (SPAN-like).
- Liquidity (3 Nov): ATM spreads $3–8 on dailies/weeklies, $55 monthly; 4–15k contracts at top of book.

**The box**
- Same EC2 box as the live NSE desk (pm2 namespace `desk`, Mongo `algomaker`, ports 8790–8797).
- The clone uses Mongo `algomaker_dx`, ports **8890–8897**, pm2 **`dx-*`** in namespace `dx`, its own cookie
  names, its own `.env.local` and its own `DESK_MASTER_KEY`. A guard test fails on any live port / db / pm2 name.
  (Commit 1 in the clone, "isolate".) `git push` to `upstream` (the live repo) is disabled.
- Restarts, `.env.local` edits, Caddy and `pm2 start` of a new app are the operator's (handed over as checked
  scripts); the agent builds, tests, commits, builds the web.

## 5. Shape of the clone

Same process topology as the NSE desk, re-pointed at Delta. Because the clone has **its own database**, every
collection keeps its NSE name (`instrument`, `desk-books`, `desk-books-registry`, `desk-gateway-orders`, …):
no collection map, and upstream fixes cherry-pick cleanly.

| pm2 | Was (NSE) | Becomes (Delta) |
|---|---|---|
| `dx-marketdata` | Kite login + KiteTicker pool + 08:45 sync | Delta public WS feed (no key) + Delta product sync; publishes the same `md.spot` / `md.tick` / `md.health` shapes on its bus (:8891) |
| `dx-api` | desk-api | same code; venue = DX (sessions, day, currency, quantity step, tick); broker kind `delta` |
| `dx-gateway` | XTS placement | **Delta adapter for live** (exact `mode==='live'` + `DESK_DX_LIVE=1`), simulator otherwise; Delta fee model on every fill; integer-contract edge; settlement booking |
| `dx-supervisor` | NSE books | same code, venue = DX, plus the BULL-S decide path |
| web (static) | `apps/web/dist` via Caddy :80 | the clone's `apps/web/dist`, API base :8890 |
| `dx-runner`, `dx-traders` | hosted strategies, Odin desk | **not started** this round |

### 5.1 Venue spec (new `packages/venue`)
One pure module, read by desk-engine, supervisor, api (day-guard, pnl jobs, settle, submit), greeks/payoff and
web. Fields: `id`, `tz` (IST for display), `isOpen(t)` (DX: always), `dayKey(t)` (DX: the venue day runs
17:30 IST → 17:30 IST, keyed by the settlement date it ends on), `expiryInstant(expiryDate)` (DX: 12:00 UTC;
prefer the instrument's own `settlement_time`), `markGrid` (5-min, 24x7), `rate` (DX: 0), `qtyStep` (DX: 0.001),
`defaultTick` (DX: 0.1, but per-instrument `tick_size` wins), `currency` (USD) and `inrRate` (85).
The NSE spec is kept and stays the default inside the pure packages, so the upstream golden/parity suites keep
running unchanged as regression tests; every DX process passes `DESK_VENUE=dx`.

### 5.2 Quantity, price and money
- Desk side (ledger, decision wire, fills, P&L): **quantity in BTC on a 0.001 grid**, the way NSE quantity is
  shares. `lots` = contracts, `lotSize` = 0.001. Prices in USD per BTC. Money = price × quantity — USD, correct
  with no multiplier.
- Exchange edge (gateway): `contracts = round(qty / 0.001)`, integer contracts are the stored truth; `0`
  contracts ⇒ quantity exactly 0, so flat checks stay exact.
- Every integer-share check found in the survey becomes step-aware (`roundToStep(x, venue.qtyStep)`):
  supervisor `engine-host.ts` lots/qty sites, api `routes/engine.ts` positive-integer checks, gateway
  `quantity % lotSize`, `margin-project.ts` lotSize truncation, web `isIntegerOnly`. No site may round a non-zero
  quantity to 0 without refusing loudly.
- Marketable-limit pricing uses the instrument's tick (0.1), not the global 0.05.

### 5.3 Instruments and feed
- `packages/dx`: signer, REST client (rate-limit aware), WS client (public + private), normaliser from Delta
  products to the existing `InstrumentRow` shape (`instrument_token` = Delta product id, `tradingsymbol` = Delta
  symbol e.g. `C-BTC-76600-041126`, `name` 'BTC', `strike`, `instrument_type` CE/PE, `expiry` = the IST date of
  the 12:00 UTC settlement, `lot_size` 0.001, `tick_size`), and a `BrokerAdapter` for orders/fills/positions.
- Sync at boot, every 15 min, and right after each 17:30 settlement; expired rows kept while any book still
  references them.
- Feed: index spot (`.DEXBTUSD`) as `md.spot` underlying `BTC`; option `ticker` frames as `md.tick` (last, mark,
  best bid/ask, IV, OI). Subscriptions = all strikes of every expiry a registered book uses (chains are 25–43
  strikes; the whole BTC chain is a few hundred symbols — subscribe it all if simpler).
- Quote freshness: Delta options trade constantly; the existing staleness rules apply with venue clocks.

### 5.4a Fees
Paper fills are charged Delta's fee model so paper measures the real edge: trade fee = min(0.01 % × notional
(contracts × 0.001 × index), 3.5 % × premium), + 18 % GST; settlement fee at the taker rate on contracts open at
expiry (apply the same cap until Delta confirms otherwise). Simulated fills take the touch (sell at bid, buy at
ask). Fees are stored per fill; P&L shows gross, fees and net; every target, loss cap and guard reads **net**.
Live fills carry Delta's reported commission instead.

### 5.4 Day, P&L, guard, settlement
- Day guard, daily limits, P&L snapshots and daily reports key on `venue.dayKey` (17:30 → 17:30). Snapshots
  around the clock at the existing cadence. Daily report written just after each settlement so it includes that
  day's expiries. Limits in USD.
- Settlement: at 12:00 UTC the expiring legs are booked at **Delta's settlement price** (read from the settled
  product / settlement endpoint), paper and live alike; the book's legs go to zero; the book is then finished.
- Credentials: broker kind `delta` in `desk-brokers`, sealed with the clone's own master key; `meta.baseUrl`.
  The feed holds no key. Only `dx-gateway` reads it. The dashboard Brokers card stores it (typed into the web
  form — never through chat or a `!` command) and "Test" does a signed wallet read.

## 6. The BULL-S book

### 6.1 Rules (same idea as `Bull_S-1`, `docs/reference/nse/strategy-bull.md` §3)
1. **Grid.** The grid step is `bs_strike_jump × bs_strike_step_usd` (e.g. daily: 1 × $200 or 2 × $400). Levels
   are multiples of the grid step.
2. **Entry.** When the reference price (index `.DEXBTUSD`) crosses a grid level, sell the straddle (CE + PE)
   at that level's strike, at the current pyramid size — if: the level has no open straddle; the strike is
   listed for the book's expiry (skip levels with no listed strike; never substitute another); the entry window
   is open; open straddles < `bs_max_open`; the book is not halted; no entry of this book is still working.
   **At most one new straddle per evaluation**: if the price jumped past several levels (feed gap, reconnect,
   cascade), sell only the level nearest the current price — never a burst. With `bs_enter_on_start` on, the
   first price after Start / Re-arm counts as a crossing at the nearest level (legacy behaviour: the first tick
   sells the ATM straddle).
3. **Stop.** Per straddle: buy both legs back when the summed **exit-side (ask)** price ≥ `bs_stop_mult` ×
   summed entry premium, held for `bs_stop_confirm_s` seconds. The straddle stores its entry premiums, not a
   trigger, so a Dials change to the multiple or the hold time applies to open straddles at the next decision.
   A change to the jump or step applies to new entries only; open straddles keep their strikes. The level becomes re-enterable on its next
   crossing, at the then-current size.
4. **Size.** First straddle `bs_lots_start` contracts; each accepted entry adds `bs_lots_step`; never above
   `bs_lots_cap`. Each straddle exits at its own size. Size resets to start when a new book starts.
5. **Hold.** No daily close-out. Straddles stay until stop or expiry (cash settlement at 17:30 IST), unless
   `bs_flat_before_expiry_min` > 0. New entries stop `bs_no_entry_before_expiry_min` before expiry.
6. **Target / loss cap.** Measured on **net** book P&L (realised + open, after fees) **since the last arm**
   (Start or Re-arm stores the baseline). When it is ≥ `bs_target_usd` or ≤ −`bs_loss_cap_usd`, close everything
   and halt; then, per `bs_after_halt`: 0 = stay flat (default), 1 = re-arm automatically — new baseline, size
   back to start — and trade again from the next crossing.
7. **Close book / Re-arm (manual).** Two book actions on the dashboard. Close book closes every straddle at once
   and halts. Re-arm clears a halt: new P&L baseline, size back to start, `bs_enter_on_start` applies. A halt is
   a flag in the book's own state (`RuleState.bs.halted`), not a registry stop: the book stays `running`,
   so settlement and the stop machinery keep working, and Stop keeps its meaning (closes nothing).
8. **Restart safety.** After a process restart the book re-baselines its last reference price (no phantom
   crossing) and rebuilds open straddles from its own state.
9. **Orders.** Priced marketable limits through the mark (venue tick), PE then CE for opens and closes, the
   desk's existing chase/cancel machinery; reduce-only on every close when live.

### 6.2 Dials (all `bs_*`, each with an explicit off-state)
| Dial | Meaning | Daily | Weekly | Monthly |
|---|---|---|---|---|
| `bs_enabled` | selects the BULL-S decide path (guarded engine switch) | on | on | on |
| `bs_strike_step_usd` | one "strike" in USD for this expiry class | 200 | 500 | 1000 |
| `bs_strike_jump` | 1 or 2 strikes per grid step | 1 / 2 | 1 / 2 | 1 / 2 |
| `bs_stop_mult` | combined stop multiple | 1.25 | 1.25 | 1.25 |
| `bs_stop_confirm_s` | stop must hold this long | 3 | 3 | 3 |
| `bs_lots_start` / `_step` / `_cap` | pyramid, contracts (0.001 BTC) | 50 / 50 / 150 | 10 / 10 / 30 | 10 / 10 / 30 |
| `bs_max_open` | max open straddles | 4 | 4 | 4 |
| `bs_target_usd` | book profit target, 0 = off | 0 | 0 | 0 |
| `bs_loss_cap_usd` | book loss cap, 0 = off | 250 | 500 | 500 |
| `bs_after_halt` | 0 stay flat / 1 re-arm automatically | 0 | 0 | 0 |
| `bs_enter_on_start` | first price after Start/Re-arm sells the nearest level | on | on | on |
| `bs_entry_window` | IST from–to + weekday mask for NEW entries (stops run always) | all hours | all hours | all hours |
| `bs_no_entry_before_expiry_min` | entry blackout before expiry | 60 | 60 | 60 |
| `bs_flat_before_expiry_min` | 0 = hold into settlement | 0 | 0 | 0 |

Presets: `bull-s-btc-daily`, `bull-s-btc-daily-2`, `bull-s-btc-weekly`, `bull-s-btc-weekly-2`,
`bull-s-btc-monthly`, `bull-s-btc-monthly-2` — the `-2` flavours differ only in `bs_strike_jump`.
Sizes and loss caps are the analyst's starting numbers (`delta-strategies.md` §1); the target is off until the
operator sets one per book.

### 6.3 Engine placement
A fourth decide path `decideBullS` in `packages/desk-engine/src/bull-s/` (pure, venue-neutral), dispatched by
`bs_enabled` beside `delta_lean_enabled` / `pb_playbook`. State `RuleState.bs` = `{groups[{strike, lots,
ceEntry, peEntry, openedMs, ceOpen, peOpen, breachSinceMs}], size, lastRef, lastRefMs, halted, haltReason,
armedAtMs, pnlBaseline}`. Book actions `bs-close` and `bs-rearm` arrive through the existing dials/registry
PATCH path (a one-shot command field), so no new registry state is needed. Actions are the
existing `open` / `close` ops; triggers `bs-entry`, `bs-stop`, `bs-target`, `bs-loss`, `bs-flat`, `bs-close`.
Stops/flat/close pre-empt a working entry. Acceptance: (a) the existing BULL golden tape replayed through
`decideBullS` with the NSE venue, jump 1, LTP stop basis, uncapped, reproduces `PremiumLegBookStrategy`'s
open/close sequence; (b) synthetic BTC tapes: jump 2, crossings over midnight and a weekend, unlisted strike,
entry blackout, hold into settlement, target and loss halts in both `bs_after_halt` modes, restart recovery.

### 6.4 Books
One book per expiry and flavour: tag `BTC-<expiry>-bull-s-<cls>[-2]` (e.g. `BTC-2026-11-06-bull-s-weekly-2`),
symbol `BTC`, mode paper. First round: books created from the dashboard / a small script by hand; the roll
(create the next expiry's books automatically after each settlement) follows once the first books have run.

## 7. Dashboard
The clone's web, served as its own site. Changes: USD formatting (₹ second figure), Delta contract names in
`contract.ts`, `inSession` → `venue.isOpen` (always open), expiry checks on the 17:30 instant, 0.001-step
quantities, tick 0.1, Brokers card kind `delta`, BULL-S dials shown through the existing dial schema, a Close
book button on a BULL-S book. NSE-only screens (traders desk, NSE broker view) hidden.

## 8. Live, later (built, off)
The Delta order adapter is built and fixture-tested this round, but no live order can leave the box until the
operator sets `DESK_DX_LIVE=1` in the clone's `.env.local` and switches a book live. The key pasted this round is
used only for the signed "Test" read. Same gates as NSE: registry mode live, the password-gated `modes.live.enabled` switch, `liveLots`, the kill
switch; plus a desk-level contract cap and per-order notional cap in `dx-gateway`, Delta's heartbeat dead-man
switch while live, reduce-only exits, a reduce-only drill before the first live book.

## 9. Order of work (lanes)
1. **L0 venue + quantity** — `packages/venue`, step-aware rounding everywhere, engine time to the expiry instant.
2. **L1 BULL-S engine** — `decideBullS`, dials, presets, tests.
3. **L2 Delta client** — `packages/dx` (fixture tests, no network in tests).
4. **L3 feed + products** — `apps/marketdata` re-pointed to Delta.
5. **L4 gateway** — Delta adapter (live), simulator (paper), settlement booking, caps.
6. **L5 api + supervisor wiring** — venue = DX, broker kind `delta`, day guard / P&L on venue day, BULL-S dispatch.
7. **L6 web** — §7.
8. **L7 roll** — automatic next-expiry books (after the first books run).
L0–L3 and L6 in parallel; then L4/L5; then first paper books by hand; then L7.

## 10. Hand-over to the operator
1. Create the clone's `.env.local` (new `DESK_MASTER_KEY`, `DESK_API_TOKEN`, `DESK_VENUE=dx`) — checked script.
2. `pm2 start` the dx processes — checked script; Caddy site for the dx dashboard (and the AWS security group
   for its ports) — the operator's.
3. Log in to the dx dashboard, Brokers → Delta → paste key + secret → Test.
4. Create the first books from the presets, Start, watch.

## 11. Calls made by Claude (not operator decisions — check these)
- C1. Entries 24x7 (minus the last 60 min) and the monthly book kept, for a full paper picture; the analyst
  suggested a 09:30–15:30 IST daily window and the monthly off. Both are one Dials change.
- C2. Hold into the 17:30 settlement by default (operator: "hold"); the analyst suggested flat by 16:30 on the daily.
- C3. After a target/loss halt the book stays flat until Re-arm (`bs_after_halt` 0).
- C4. Reference = the `.DEXBTUSD` index; straddle strike = the grid level crossed (the analyst's forward-centred
  strike, about +$300 on the monthly, is not used this round).
- C5. Stop on the ask side with a 3 s hold, recomputed live from entry premiums.
- C6. One straddle per evaluation; the first price after Start sells the nearest level.
- C7. Paper charges Delta's fees; targets and caps read net.
- C8. One order queue as on NSE, with live only on an exact `mode==='live'` plus `DESK_DX_LIVE=1`.
- C9. Every preset capped (no uncapped pyramid on BTC); sizes from the analyst's table.

## 12. Left to the builder
File-level structure inside each lane; WS reconnect/backoff details; exact preset names; how the dashboard
groups the six books; snapshot cadence; whether to subscribe the whole BTC chain or per book; rounding helpers'
names; test fixture formats.
