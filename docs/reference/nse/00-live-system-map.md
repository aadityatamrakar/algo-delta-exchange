# 00 — The live system, mapped

> **Inherited from the NSE desk** (`/opt/algomaker`, copied 3 Nov 2026). It describes the machinery this repo
> shares with the NSE desk as it stood there, and is not maintained here. The process names (`desk-*`), ports
> (87xx), database (`algomaker`) and paths in it are the **live NSE desk's**: in this repo they are `dx-*`,
> 8890–8897 and `algomaker_dx`. Never run a command from this page. Links to other NSE documents point into
> the NSE repo and were not carried over.

**Compiled 2026-08-15** from a four-agent verified audit at commit `9d5e7cff`. Every claim below was
checked against the source; `file:line` refs are relative to this repo unless the section names the
Python repo (`/Users/aaditya/Documents/dev/algo-engine/sensibull-desk`).

This document supersedes the process/data-flow/collection content of
[12-dashboard-data-and-push.md](12-dashboard-data-and-push.md) and the operational half of
[13-development-workflow.md](13-development-workflow.md) where they disagree — §7 lists every
verified staleness in the older docs. The companion severity-ranked findings are in
[14-robustness-audit-2026-08-15.md](14-robustness-audit-2026-08-15.md).

**The one-paragraph system:** Python (`sensibull-desk`) owns all trading logic and holds no
database; algomaker is the bridge + dashboard. Four Node processes under pm2 namespace `desk`
(marketdata, api, order-gateway, runner) plus two Python supervisors (paper, live) talk over
HTTP and one WebSocket bus. All state is 29 Mongo collections on a **standalone** server —
no change streams, no transactions, so every cross-process signal is an explicit HTTP POST or a
poll, and every concurrency guard is a unique index or a compare-and-set.

## 1. Process & runtime map

### Node / pm2 — `ecosystem.desk.config.cjs`, namespace `desk`

Node 24 runs `.ts` directly (type-stripping); **there is no backend build step**. Every
`bin/*.mjs` calls `main()` explicitly because the `import.meta.url === process.argv[1]` guard
never matches under pm2's fork container (failure mode: silent exit 0 + restart loop, empty logs).

| pm2 name | Entry | Owns |
|---|---|---|
| **desk-marketdata** | `bin/desk-marketdata.mjs` → `apps/marketdata/src/main.ts:178` | The **one** Zerodha/Kite login; the socket pool (900 tokens/socket); the WS bus **server** on `:8791`; instrument sync; per-book margin; mark snapshots. Also serves `GET /v1/md/history` on **`:8792`** (`main.ts:303`) — without it, hosted candle series start cold and ATR strategies never form a band. |
| **desk-api** | `bin/desk-bridge.mjs` → `apps/api/src/main.ts:86` | HTTP + WebSocket on `:8790`. The bridge Python POSTs to, the dashboard's only API, both order rails, greeks, P&L jobs, auth, the kill switch. |
| **desk-gateway** | `bin/desk-gateway.mjs` → `apps/order-gateway/src/main.ts:253` | **The only process that can place a live order.** Claims from `desk-gateway-orders`, freeze-splits, places via XTS, correlates fills, journals every attempt, publishes the broker snapshot. |
| **desk-runner** | `bin/desk-runner.mjs` → `apps/runner/src/main.ts:71` | The 14 hosted intraday strategies + 3 signal mirrors. **No broker credentials** — every order is an HTTP POST to `/v1/desk/submit`. `kill_timeout: 20_000`. |

**desk-runner squares off on SIGTERM** — handler `apps/runner/src/main.ts:561-594`
(`shutdown()`), flatten at `apps/runner/src/runner.ts:780` inside `#stopOne`. (Docs citing
`runner.ts:671-681` are stale — that is now the tail of `#build()`.) Mirrors are exempt
(`main.ts:566-571`); hard-exit fuse at `main.ts:591` (15s, under pm2's 20s).

### Python / pm2 — `sensibull-desk/ecosystem.config.js`

Nothing in algomaker code references these; the coupling is HTTP only (§4).

| pm2 name | Role |
|---|---|
| `sensibull-desk` / `sensibull-scheduler` / `sensibull-live` | Python research dashboard, IST scheduler, legacy per-symbol paper tick |
| **`desk-supervisor`** (`DESK_SUPERVISOR_MODE=paper`) | Converges `desk-books-registry` for the paper rail. Long-lived; SIGTERM touches **no book** — restart is a no-op. |
| **`desk-supervisor-live`** (`DESK_SUPERVISOR_MODE=live`, own pidfile) | Same for the live rail. A second **process**, not a setting: `converge()` polls exactly one mode. |

Cadence: `converge()` every **30s** (`supervisor_main.py:110`), catalogue republish every 300s.
The 30s converge vs the 5-minute mark grid is why "dials land at the next mark" is the honest
promise.

### Other runtime pieces

- **Caddy on `:80`** serves `apps/web/dist` as static files. It does **not** proxy the API —
  `API_BASE` is `${protocol}//${hostname}:8790` (`apps/web/src/api.ts:359-361`); hostname
  derivation is the `SameSite=Strict` cookie mechanism, not convenience.
- **CLIs, not daemons:** `bin/desk-reset.mjs`, `bin/desk-user.mjs`, `apps/api/src/cli.ts`,
  `apps/api/src/migrate.ts`, and the `make sync` one-liner (`Makefile:143-149`).

**Ports:** 8790 (api HTTP+WS) · 8791 (bus WS) · 8792 (marketdata history HTTP) · 5174 (vite dev) · 80 (Caddy).

## 2. Feed path — broker socket → bus → api / runner / gateway

1. `apps/marketdata/src/zerodha-login.ts:188-238` resolves credentials (`desk-brokers` store
   first, `ZERODHA_*` env second); `zerodhaLogin` returns the **enctoken**.
2. `apps/marketdata/src/kite-feed.ts:130-149` wraps the vendored
   `packages/marketdata-core/vendor/KiteTicker.js` (`api_key: 'kitefront'`, mode `'full'`).
3. `KiteFeedPool` unions subscribers; `TokenSharder` shards at 900 tokens/socket, sticky.
4. `apps/marketdata/src/main.ts:346-362` publishes to the bus. `WsTransportServer` on `:8791`
   broadcasts every frame to every client; filtering is client-side.
5. **Exactly three topics exist** (verified — 3 publish sites in the whole tree):
   - `md.spot` `{underlying, price, ts}` — `main.ts:354`
   - `md.tick` `{token, price, ts, oi?, volume?}` — `main.ts:356`
   - `md.health` `{sockets, tokens, ts, date, instrumentSyncDay, instrumentsStale}` every 10s — `main.ts:670-687`
6. Consumers: `apps/api` (all three; `md.tick` feeds `QuoteCache` **and** `LiveBook.onTick`);
   `apps/runner` (`md.tick` → candles/strategies); `apps/order-gateway` (`md.tick`, simulate
   mode only — drives simulator fills).

**What gets subscribed** (`apps/marketdata/src/main.ts:419-499`): (a) open books from
`desk-books` + registered-empty books from `desk-books-registry` through `planSubscriptions`
(`DESK_FULL_CHAIN=1` = whole chain of the book's expiry); (b) external declarations from Mongo
`desk-subscriptions` — the runner is the only writer today (source `hosted-runner`). Mongo is the
seam because the bus server registers **no inbound handler**; a client `publish()` reaches nobody.

**Feed recovery** (`apps/marketdata/src/feed-recovery.ts`) covers **two fault kinds** with
separate counters and clearing evidence: `feed` (socket `noreconnect` / health sweep; cleared
when every socket connects) and `token` (REST rejections from basket-margin and history calls;
cleared only by `noteTokenAccepted()`). This closed the 2026-08-05 "enctoken dies for REST while
the feed lives" gap for *demand-driven* calls — but there is still **no periodic REST canary**,
so a desk making no REST calls can carry a dead token for hours (see audit F-13). Token-rejection
classification is deliberately narrow: `401 || body.includes('TokenException')`; a bare 403 is
not enough because `PermissionException` also 403s and no login fixes it.

## 3. Order paths

### Path A — Python decision → broker

1. Supervisor `converge()` → `POST /v1/desk/actions` (`bridge.py:107-108`).
2. `routes/desk.ts:121` → `BridgeService.applyDecision`. Idempotency = unique index on
   `decisionId`, not read-then-write.
3. `decision-plan.ts:85-107` (`priceFillsForRoute`) converts every priceless action to a
   **marketable limit** before routing: priced *through* the mark, directional rounding, ≥1 tick,
   `null` rather than an invented price. Dials: `DESK_MARKETABLE_BUFFER_PCT` 0.02,
   `_MIN_TICKS` 2, `_TICK` 0.05. (The broker rejects MARKET.)
4. Rail split is **by collection, not a flag**: `PaperRail` → `desk-paper-trade`
   (`rail.ts:264`); `LiveRail` → `desk-gateway-orders` (`rail.ts:389-397`). Gate 1 (the live
   allowlist) is checked inside the write.
5. The gateway claims via one `findOneAndUpdate` over `{state:'PENDING'} OR {state:'CLAIMED',
   claimedAt < now-60s}` (`queue.ts:111-126`); Gate 2 re-checks the allowlist in its own process.
6. `planOrder` splits under the NSE freeze limit (tranches `X`, `X.1`, `X.2`…); unknown freeze
   key → explicit `freezeUnknown`, never implicit infinity.
7. `XtsAdapter.placeOrder`. `exchangeInstrumentId` = Zerodha's packed token **÷ 256**
   (`main.ts:462-472`) — sending the packed value ACKs then voids (the 2026-08-04 phantom book).
8. Fills return via the XTS interactive socket (socket.io-client **pinned to v2**,
   `apiType:'INTERACTIVE'`) — correlation by `AppOrderID` when the 45-char
   `orderUniqueIdentifier` truncates. **This socket is the only fill path today** (audit F-1).
9. Every step journals to `desk-order-events`: `ACCEPTED → PLANNED → SUBMITTED → ACK → STATUS`.

⚠️ **The `order.submitted` WS nudge is dead wiring.** The gateway subscribes
(`order-gateway/main.ts:816`) and the constant's docstring says the bridge publishes it — but
**nothing publishes it**. Every live order waits for the idle sweep (`DESK_SWEEP_MS`, default
5000ms). Tolerated by design ("losing a nudge costs latency, never an order") but the fast path
has never existed.

### Path B — hosted strategy → broker

1. Runner tick (1s) → `HttpOrderGateway.submit` → `POST /v1/desk/submit`
   (`apps/runner/src/order-gateway.ts:467-533`; 3 retries 200ms apart, then OUTCOME UNKNOWN with
   the `clientOrderId` held for replay).
2. `SubmitService` claims on `desk-submissions.clientOrderId` (unique index = the lock) before
   routing. Marketable-limit pricing on this path landed only 2026-08-10 (`d7917f89`) — before
   that every hosted/mirror live order was a MARKET order on a never-exercised path.
3. `liveLots` **replaces** the requested size on this endpoint; `/v1/desk/actions` never
   consults it. Then identical to Path A steps 5-9.

### The live gates (in order)

1. Book registry row `{tag, mode:'live'}`, `desired: running`.
2. **`modes.live.enabled` on the strategy row — THE allowlist** (`157b7528`, 2026-07-30). Read
   per order by both desk-api and the gateway; switch-off stops routing on the next order.
   Turning it on is password-gated (machine principals can never enable live —
   `authsvc.ts:217-220`).
3. `DESK_LIVE_TAGS` is only an optional box-level **pin that narrows**; **empty = no extra
   restriction** (inverted from the old meaning — most docs are stale on this, see §7).
4. `liveLots > 0` for `/v1/desk/submit` entries (exits exempt).
5. Kill switch (`desk-safety`), enforced in desk-api only (the gateway does not read it —
   audit F-9). All gates fail closed: a Mongo error answers `false`.

## 4. Python boundary — HTTP only, 9 endpoints

Verified: Python has **no database driver at all** (`grep -rin "mongo|pymongo|MongoClient"
--include="*.py" sensibull_tools` → zero). Everything goes through
`sensibull_tools/live/desk/bridge.py` (~130 lines), configured by `DESK_API_URL` +
`DESK_API_TOKEN` (bearer → machine principal, `timingSafeEqual`).

| Dir | Endpoint | Python site | algomaker handler |
|---|---|---|---|
| → | `POST /v1/desk/actions` | `bridge.py:107` | `routes/desk.ts:121` |
| → | `POST /v1/desk/declare` (carries `greeks.steeringDelta/Gamma` since 08-14) | `bridge.py:110` | `routes/desk.ts:227` |
| → | `POST /v1/desk/variants` (wholesale catalogue) | `bridge.py:123` | `routes/books.ts:81` |
| → | `POST /v1/desk/books/registry/{tag}/actual` | `bridge.py:126` | `routes/books.ts:574` |
| ← | `GET /v1/desk/books/registry?mode=` | `bridge.py:91` | `routes/books.ts:95` |
| ← | `GET /v1/desk/positions?tag=&mode=` | `bridge.py:67` | `routes/desk.ts:191` |
| ← | `GET /v1/desk/chain/{underlying}?expiry=` | `bridge.py:70` | `routes/desk.ts:521` |
| ← | `GET /v1/desk/trades?tag=&mode=&limit=` | `bridge.py:73` | `routes/desk.ts:389` |
| ← | `GET /v1/desk/feed` | `bridge.py:64` | `routes/health.ts:69` |

Reads are fail-soft (`_read` returns the caller's `empty` on any error) — a bridge outage
changes nothing on the Python side. **Python never calls `/v1/desk/diff`** — the desync check
PYTHON-DESk.md calls "the only mechanism that catches a desync" is observable only from the
dashboard. Dials are registry-mediated: `converge()` calls `worker.set_dials(row["dials"])`
before every tick (`supervisor.py:396-400`); `set_dials` refuses `lot_size` by name and forwards
the rest to `decider.set_live_params` — no restart needed (UPDATING-VARIANTS.md predates this).
Python-side state lives under `<sensibull-desk>/data/desk/<TAG>/`, keyed by tag.

## 5. Mongo collections (29)

`COLLECTIONS` const at `apps/api/src/store.ts:91-137`; the rest hold their own names.
⚠️ `bin/desk-reset.mjs` predates 8 of these — a "clean" reset keeps the book registry, variant
catalogue and runner ledger.

| Collection | Writer(s) | Reader(s) |
|---|---|---|
| `desk-decisions` | api (`applyDecision`/`flattenTag`/hosted submit) | P&L, `LiveBook`, flatten reconstruction, delete guard |
| `desk-books` | api only (actions + seed) | api positions/greeks; marketdata subscription planner + margin sweep |
| `desk-books-registry` | api create/patch/start/stop; `actual` **only from Python** | api; marketdata; Python `bridge.books()` |
| `desk-variants` | **Python supervisor only** (wholesale replace) | api create wizard, Dials defaults |
| `desk-declarations` | api, from Python declare | `/v1/desk/diff`, steering delta on positions |
| `desk-paper-trade` | api `PaperRail` | api orders/trades. Nothing forwards from it |
| `desk-gateway-orders` | api `LiveRail` | **gateway claim loop**; api status reads |
| `positional` | nothing today (legacy live-order log — never drop) | `listLiveTrades` |
| `desk-order-events` | gateway journal + api gate refusals | api orders/reports; web order log |
| `desk-fills` | gateway `FillWatcher` | api (read-only) |
| `desk-submissions` | api `SubmitService` (unique `clientOrderId` = the lock) | api |
| `desk-strategies` | api registry | api; gateway live gate; runner (read-only) |
| `desk-strategy-runtime` | runner heartbeat (sibling of `desk-strategies` so a 1Hz write can't clobber switches) | api |
| `desk-strategy-state` | **runner only** — incl. `runner:positions`, the **only durable record of a hosted position** | runner only. `flattenTag` cannot see it |
| `desk-subscriptions` | runner (source `hosted-runner`) | marketdata |
| `desk-safety` | api kill switch | api |
| `desk-pnl-snapshots` / `desk-daily-reports` | api P&L jobs (15s tick / 15:40 IST rollup) | api. Daily reports are **irreplaceable** |
| `desk-users` / `desk-sessions` | api auth | api |
| `desk-brokers` | api, sealed with `DESK_MASTER_KEY` | api; marketdata (zerodha); gateway (xts) |
| `desk-marks` | marketdata 60s snapshot | api boot + 5-min reload (display only) |
| `desk-book-margin` | marketdata margin sweep | api |
| `desk-broker-snapshot` / `-daily` | gateway, 30s / per-IST-day | api display routes only — **nothing reconciles it** |
| `desk-broker-cancels` | api writes request, gateway writes outcome | both |
| `desk-broker-session` | gateway (XTS token, one doc `_id:'xts'` — **sealed** with `DESK_MASTER_KEY` since F-46, 2026-08-16; legacy plaintext read-once-then-sealed; 7-day TTL on `updatedAtDate`) | gateway |
| `desk-freeze-limits` | **only `make sync`** — no daemon refreshes it (audit F-12) | gateway per order; api submit |
| `instrument` | marketdata boot + 08:45 IST daily | api, runner, gateway (`OptionMaster`) |

## 6. Dashboard push path

**WebSocket over an always-running REST polling floor.** No SSE, no change streams (standalone
Mongo — stated with its reason in four file headers).

1. `GET /v1/desk/stream` upgrades on the same `:8790` server, so the httpOnly cookie and
   `AuthGate` apply, plus an explicit Origin allowlist (browsers do not CORS-check websockets).
   50-client cap → 503.
2. **Five frame types** (`stream.ts:143-177`): `subscribed`, `heartbeat` (15s), `order`,
   `pnl-snapshot`, `pnl-delta` (coalesced every `DESK_STREAM_PNL_MS`, default 250ms).
3. **Order frames are nudges** — the client refetches over REST; nothing renders the frame.
4. **P&L frames are data** — the deliberate exception. `mergeRow`/`mergeLeg` distinguish
   absent-means-unchanged from explicit-null-means-unknown. **No arithmetic in the browser.**
5. Producers: paper fills in-process; live fills via **one HTTP POST** from the gateway
   (`POST /v1/desk/stream/notify`, machine-only, live-only, can never fail an order); P&L
   re-marks from `LiveBook.onJournal` + `onTick`.
6. Cadences (current, not what doc 12 says): fallback poll 10s, live poll **15s**, stale
   watchdog 45s, reconnect 1s→15s. One ref-counted socket per `(tab, mode)`.

## 7. Doc corrections — verified staleness in older docs

Every core doc was last touched 2026-07-27…30; **137 commits have landed since.**

### 7.0 — Correction to THIS document, 2026-08-22 (the D9 cutover)

This map was compiled 2026-08-15, before the recenter-supervisor migration landed. **The Python
boundary described in §1, §3 (Path A steps 1-2) and §4 is retired.** The body above is left as
written — it is an accurate record of the system at `9d5e7cff` — and this table states what has
changed since. Read the two together; where they disagree, this table is current.

| §-and-claim above | Reality after the cutover |
|---|---|
| §1 "two Python supervisors (paper, live)" / the `desk-supervisor` + `desk-supervisor-live` pm2 rows / "Cadence: `converge()` every 30s" | **Gone.** The supervisor is NATIVE — `apps/supervisor`, one process, in this repo, evaluating off the WS bus rather than polling. On prod: `pm2 delete desk-supervisor desk-supervisor-live`, both removed from sensibull-desk's `ecosystem.config.js`, and `data/desk/` **tar-archived before removal** (it is the only record of the Python engine's decision history). |
| §3 Path A step 1-2: `converge()` → `POST /v1/desk/actions` → `routes/desk.ts:121` | **`POST /v1/desk/actions` no longer exists.** Decisions arrive at `POST /v1/desk/engine/decisions` (`routes/engine.ts`), whose wire addresses **real instruments and share quantities** instead of `CE530#3` leg tags. It translates and calls the SAME `BridgeService.applyDecision` — steps 3-9 of Path A are unchanged, gates included. |
| §3 Path B step 3: "`/v1/desk/actions` never consults `liveLots`" | Still true of the decision path, now spelled `/v1/desk/engine/decisions`. |
| §4 "Python boundary — HTTP only, 9 endpoints", and its table | **The whole section is historical.** `POST /v1/desk/actions` and `POST /v1/desk/variants` are removed; `GET /v1/desk/variants` remains (the stored `desk-variants` rows are still read for a book's dial defaults, but nothing writes them any more). Every other row in that table is a GET the dashboard or the supervisor still uses, unchanged. `docs/PYTHON-DESK.md`, which §7 below and `context/12` both link, is **deleted** — the contract it described has no second party. |
| §5/§6 collection counts ("29 Mongo collections") | Four new ones, all owned in this repo: `desk-supervisor-state` (protected lots, in-flight ids), `desk-engine-decisions` (what the supervisor asked for, in its own words — replaces `data/desk/*.jsonl`), `desk-supervisor-lease` (which process is steering), `desk-book-marks` (one row per book per 5-min mark; distinct from marketdata's `desk-marks`). `bin/desk-reset.mjs` drops all four. |
| §3 "The live gates (in order)", gate 2 | Unchanged as the allowlist, with one correction of a real defect: `LiveRail` used to re-check the switch with **no reduce-only exemption**, so a switched-off live tag could not be exited by the desk at all — every closing order came back a route error. It now derives "this order only reduces the book" from the stored legs and lets it through; an open, and a resize that grows, are still refused. |
| §9 open question 6 ("is PYTHON-DESK.md's declare→diff contract aspirational?") | **Moot.** No Python side remains to answer it. |

| Doc claim | Reality |
|---|---|
| `DEPLOYMENT.md:162,188,264`, `SERVER-REBUILD.md:486`, `PYTHON-DESK.md:173`: "`DESK_LIVE_TAGS` empty = every live order refused / the outermost gate" | **Inverted since `157b7528` (07-30).** The allowlist is the Strategies-page switch; `DESK_LIVE_TAGS` only narrows; empty = no extra restriction. Only `GOING-LIVE-RUNBOOK.md:17` is right. **Most dangerous drift in the set.** |
| `README.md:61-67`, doc 13, `DEPLOYMENT.md:312`: "root typecheck does NOT cover apps/web" | Fixed — root `typecheck` chains the web workspace (`package.json:19`). |
| Square-off cited at `runner.ts:671-681` | Moved: handler `apps/runner/src/main.ts:561-594`, flatten `runner.ts:780`. Behaviour unchanged. |
| "durable collection + WS nudge + sweep" | The nudge has no publisher; sweep-only (§3). |
| `README.md:35`: marketdata does "instrument + freeze sync" | Freeze sync runs **only** via `make sync`. |
| Docs: marketdata is bus-only on `:8791` | It also serves `/v1/md/history` on `:8792`. |
| Doc 12: 15 collections, 3 frame types, 60s poll, "nothing renders a pushed P&L row", 7 nav links | 29 collections, 5 frame types, 15s poll, P&L frames rendered, 10 routes. |
| `PYTHON-DESK.md:139`: greeks payload example | Incomplete — `declare` now accepts `greeks` (steering figures), served separately labelled. Headline greeks remain the bridge's (`130feeef`). |
| `UPDATING-VARIANTS.md:96-106` on dials | Describes only the build-time path; omits `BookDriver.set_dials` (runtime, every converge, no restart) and that `lot_size` is rejected by name. |
| `DEPLOYMENT.md §12` open question "does a deploy reset the gateway to simulate?" | Resolved by `b074355f`: `DESK_BROKER` in `.env.local` survives every restart. (Which also makes `make up`'s "SIMULATED" claim false on a live box — audit F-24.) |
| `scripts/deploy.sh:17-19`: mid-session bounce "drops whatever it was tracking" | It now **squares off the entire hosted book**. |
| `.env.example` | Entirely legacy; `.env.local.example` is the live one. |
| Repo `MEMORY.md`/`memory/` | Frozen at 07-27; 7 of 8 entries describe the retired system. The session memory (~/.claude) carries ~20 entries current to 08-12. The claim that the repo copy "cannot drift" is itself the drift. |

**Shipped since 07-30 with no operational doc:** feed self-heal (08-04/05/09), live dials
(08-12), book Build screen, broker view + cancel, per-book margin tile (spec only),
decision-reason panel (spec only), per-row P&L + steering-delta cell (08-14).

## 8. packages/ inventory

| Package | Status | Role |
|---|---|---|
| `core`, `instruments`, `bus`, `brokers`, `marketdata-core`, `greeks`, `pnl`, `auth`, `secrets` | **LIVE** | Utilities, contract resolution, WS bus, broker adapters, feed core, BS greeks, avg-cost P&L, argon2 auth, AES-GCM sealing |
| `strategy-kit`, `strategies`, `strategy-config` | **LIVE** (runner's spine) | `StrategyBase` + ports + golden-master harness; the 4 strategy classes + 17 configs; the five policy axes (transitive) |
| `order-bus` | **LIVE, partially** | Only `types.ts` + `splitIntoTranches` are imported. **`risk.ts` (daily loss stop, notional caps), `wal.ts`, `reconcile.ts` are dead** — green tests implying protection that is not wired (audit F-28). |
| `legacy-shadow-runner` | **TEST-ONLY, keep** | Drives unmodified `archive/` strategies for the 7 golden-master parity suites |
| `indicators` | **DEAD** (423 LOC) | Live ATR/crossover math was re-ported inline into `packages/strategies/*/logic.ts` |
| `events` | **DEAD** (259 LOC) | Never wired |
| `execution` | **DEAD** (611 LOC) | Chase + basket sequencing — the real order path has neither |

Cross-app coupling (deliberate, documented at `catalogue.ts:19-22`): `routes/desk.ts` imports
the runner's catalogue; the runner imports from api and marketdata sources directly.

Dead root deps: `kiteconnect`, `async`, `moment`, `cron`, `@stylexjs/stylex`. Live-but-abandoned
(the vendored Zerodha login): `request` (deprecated 2020), `debug@2` (2017, ReDoS CVE),
`tough-cookie-filestore@0.0.1`, `authenticator`. `mongodb` is pinned at 3.7.3 with a comment
citing a LoopBack constraint that no longer exists.

## 9. Open questions

1. Is the dead `order.submitted` nudge intentional (5s order latency accepted) or a regression?
2. What actually runs on prod right now — no `pm2 jlist` from `3.108.231.230` is recorded; is
   `desk-supervisor-live` up, is `DESK_BROKER=xts` set?
3. How is `desk-freeze-limits` kept current on the server? Nothing schedules `make sync`.
4. Are MIRROR_* stuck legs still an accepted trade-off after the A006 incident? (Structural
   root-cause in audit F-6.)
5. `packages/events` + `execution` are provably dead from this repo — any external consumer?
6. Is PYTHON-DESK.md's declare→diff contract aspirational, or is the supervisor missing a
   documented safety check?
