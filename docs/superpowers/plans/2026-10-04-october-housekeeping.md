# October Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire expired paper books automatically, give the Reports page a stable strategy/series view, review and fix delta-lean's expiry-day behaviour, reach optionbhai at its origin with sane retries, and script the October stock books.

**Architecture:** Five independent workstreams on five branches, one Opus subagent each in its own worktree. Shared surfaces are isolated into new modules so branches merge cleanly: the settle route in `apps/api/src/settle-expired.ts`, the series store in `apps/api/src/book-series.ts`, the runner's connection options in `apps/runner/src/optionbhai-env.ts`, the stock-book planner in `scripts/stock-books.mjs`. The orchestrator merges, runs the single `make check`, pushes and builds.

**Tech Stack:** Node 24 (`node --test`, TypeScript run directly), MongoDB, React/Vite dashboard (`vitest`), pm2. ESM `.mjs` operator scripts that import `@algomaker/desk-engine`.

**Spec:** `docs/superpowers/specs/2026-10-04-october-housekeeping-design.md`

## Global Constraints

- Paper only. Every new call sends the literal `mode: 'paper'`; a live row is a refusal. The scripts keep the `PAPER` import from `scripts/delta-lean-books.mjs`.
- Never parse a tag. Membership and grouping come from `variant`, `series`, `symbol`, `expiry`, `createdAt`.
- Nothing in a worktree touches the running desk: no API writes against `:8790`, no pm2, no writes to the `algomaker` database. Reads of `algomaker` are fine for analysis.
- Worktrees need their own `npm ci`. Api Mongo suites use fixed db names: run one test file at a time with `DESK_TEST_MONGO=mongodb://127.0.0.1:27017/algomaker_<branch>_test`; never `npm test` in a worktree. The orchestrator runs `make check` once on the merged tree.
- Tests on this box reach live ports: new route tests use the nudge sink (`apps/api/test/nudge-sink.ts`) so they never nudge the live supervisor.
- Commit small and often on the branch; message style is the repo's (`feat(api): …`, `fix(roll): …`, `test(api): …`).
- Each branch ends with a self-review against its spec section and a written hand-back: what shipped, what did not, how it was verified, exact commands the operator must run.

## Review Focus

1. A book holding one expired leg and one live leg: only the expired leg settles; the erase is still refused and alarmed. (WS1 test.)
2. A settle request on a day with no closing mark for the underlying on the expiry date: 409 naming the leg, nothing written. (WS1 test.)
3. A series history day where one tag reported `total: null`: the aggregated day shows `total: null`, not a partial sum. (WS2 test.)
4. `OPTIONBHAI_HOST_HEADER` set with an `http://<ip>` base: fetch carries `Host: optionbhai.com`, the WebSocket options carry the same header, and the log line never prints the token. (WS4 test.)
5. `--open` run outside market hours or on a book that already holds legs: refuses before any order is built. (WS5 test.)

---

### Task WS1: Expiry cleanup — settle route, roll loop, orphan prune, workspace, log noise

Branch: `ws1-expiry-cleanup`. Spec §WS1.

**Files:**
- Create: `apps/api/src/settle-expired.ts` — pure planner `planSettlement(book, marksByDate, todayIst)` → `{ settle: SettledLeg[], blocked: string[] }` and the store-touching `settleExpiredLegs(deps, tag, mode)`.
- Modify: `apps/api/src/routes/books.ts` — one dispatch line for `POST /v1/desk/books/registry/:tag/settle-expired` into the new module; the DELETE guard unchanged.
- Modify: `apps/api/src/store.ts` — only if a new store method is unavoidable (cancel of a resting gateway order goes through the existing gateway client).
- Modify: `scripts/delta-lean-roll.mjs` — `planRoll` gains `expiredLegs` classification (`action: 'settle-then-stop' | 'settle-then-erase'`) and a FOURTH loop over non-delta-lean paper rows with `expiry < previousTradingDay(today)`; `--prune-orphans` lists `desk-strategies` rows with a dated tag shape AND no registry row (match on registry absence, not on the tag text) and deletes them via `DELETE /v1/desk/strategies/:tag/modes/:mode`.
- Modify: `docs/runbooks/delta-lean-paper.md` §7 — the expiry rule and the settle action.
- Modify: `.gitignore` — `optionConfig_*.json`, `cancelledOrders.json`, `rejectedOrders.json`.
- Modify: the one desk-api log site that fires ~1/sec on a quiet weekend (find it: `logs/desk-api-out.log` shows `engine decision applied` 1,464 times in the 10 minutes after boot, and 10 MB per 3 h 20 min all weekend) — demote to debug or rate-limit; say which in the hand-back.
- Test: `apps/api/test/settle-expired.test.ts`, extend `apps/api/test/delta-lean-roll.test.ts`.

**Interfaces:**
- Produces: `POST /v1/desk/books/registry/:tag/settle-expired?mode=paper` → 200 `{ tag, mode, settled: [{tradingsymbol, qty, price, source:'intrinsic', expiry}], remaining: number }`; 400 for live; 404 unknown book; 409 `{ error, leg }` when a settlement price cannot be established.
- Settlement price: intrinsic = `max(0, close − strike)` for CE, `max(0, strike − close)` for PE, where `close` is the last `desk-marks` price for the underlying's spot/future token on the expiry date (IST). Tick-round to the instrument's `tickSize`.
- The synthetic close is booked exactly as the EOD flatten books a fill (find how `flatten.ts` and `pnlstore.ts` record a close; reuse the same writer with `desk_op: 'settle'`), so `desk-daily-reports` for the settlement day and the book's realised P&L include it.
- Consumes: `previousTradingDay`, `istDate` from `scripts/delta-lean-books.mjs`; `requestJson` for the calls.

**Done when:** route test covers settle/partial/409/idempotent; roll test pins the fourth loop's order (settle → stop → erase, after the delta-lean loops) and that a live-contract leg still alarms; `node scripts/delta-lean-roll.mjs --help` documents `--prune-orphans`; the stray JSON files are deleted on the branch (they are untracked, so simply delete them and add the ignore lines); the three merged local branches are NOT deleted by the subagent (orchestrator does it).

### Task WS2: Series and strategy rollups in reports and on the Books page

Branch: `ws2-series-reports`. Spec §WS2.

**Files:**
- Create: `apps/api/src/book-series.ts` — `deriveSeries(symbol, variant)`, `SeriesRow` type, `recordSeries(store, row)`, `listSeries(store, mode)`, `tagsFor(store, {series?|variant?, mode})`, backfill `backfillSeriesFromAudit(store)`.
- Modify: `apps/api/src/books-registry.ts` — `series?: string` on `BookCreate`/`BookRow`, validated with the tag charset, max 64, derived when absent, added to the PATCH forbid list, included by `bookFromDoc`.
- Modify: `apps/api/src/routes/books.ts` new-row branch (`:374-444`) — call `recordSeries` after the registry insert.
- Modify: `apps/api/src/store.ts` — register collection `desk-book-series` with unique `{tag, mode}`. `eraseBook` and purge do NOT touch it (add a test asserting that).
- Modify: `apps/api/src/migrate.ts` — backfill step, idempotent.
- Modify: `apps/api/src/pnlstore.ts` — `reportHistoryForTags(tags, mode, from, to)` returning per-date rows with the null discipline (`total` null if any contributing total is null) and `tags` per row.
- Modify: `apps/api/src/routes/reports.ts` — `/v1/desk/reports/series?mode=` and `history` accepting exactly one of `tag|series|variant` (400 for two); `/reports/tags` honours `mode`.
- Modify: `apps/web/src/api.ts`, `apps/web/src/reports.tsx`, `apps/web/src/books.tsx` — picker (strategy → series → unlabelled tags), summary strip (total realised, days, winning days, best, worst), cumulative column, expiry-day marker (the book's `expiry` equals the date; fetch expiry from the series row's registry/audit snapshot — add `expiry` to `SeriesRow`), day rows link each contributing tag's order log; `BookCell` shows series; Books rows grouped by series, running first.
- Modify: `scripts/delta-lean-books.mjs` `planBooks` emits `series`; `apps/api/test/delta-lean-registration.test.ts` payload pin updated.
- Test: `apps/api/test/book-series.test.ts`, extend `pnl-routes.test.ts`/`pnlstore.test.ts`, web `reports.test.tsx` for the picker and summary strip.

**Interfaces:**
- Produces: `GET /v1/desk/reports/series?mode=paper` → `{ series: [{series, symbol, variant, tags:[...], expiries: {tag: expiry}, firstDate, lastDate}], variants: [string] }`.
- `GET /v1/desk/reports/history?series=NIFTY-delta-lean-aggressive&mode=paper&from&to` and `?variant=delta-lean-aggressive…` → `[{date, realised, total|null, maxProfit, maxLoss, orderCount, tags:[...], expiryDay: boolean}]`.
- WS5 reads: registry GET returns `series` on every row once this lands.

**Done when:** backfill on a copy of the live data (use `mongodump`/restore into `algomaker_ws2_test`, or a fixture built from `desk-audit-log` shapes seen in the spec) labels every delta-lean tag including the legacy weekly shapes; the Reports page opens on the strategy view; typecheck clean for api and web.

### Task WS3: Delta-lean review since the cut-over, and the two defects

Branch: `ws3-delta-lean-review`. Spec §WS3.

**Files:**
- Create: `docs/reports/2026-10-04-delta-lean-review.md` — the review, with every query used in fenced blocks (`mongosh --quiet mongodb://127.0.0.1:27017/algomaker --eval '…'`, read-only).
- Modify (defect a): the delta-lean flatten path — find where `dl_flatten_passive_min` / `dl_flatten_urgent_min` / `dl_flat_by_min` are evaluated (`packages/desk-engine/src/delta-lean/*.ts`, `apps/supervisor/src/engine-host.ts`) and why a resting passive package suppresses the urgent decision ("A wedged working package resets the stuck clock", runbook §3.2). The urgent flatten must cancel-and-cross at 14:55 regardless of a resting package. Test in the engine package pins: passive at 890 rests → urgent at 895 is emitted with `workMode: 'urgent'` (or whatever the existing crossing mode is called) for every still-held leg.
- Modify (defect b): whichever side is wrong about `SENSEX-delta-lean-aggressive-2026-10-01:paper:5#4` — `desk-gateway-orders` says COMPLETE 80 @ 149.15, `desk-fills`/`desk-order-events` say WORKING then orphaned. Read `apps/order-gateway/src` and `apps/api/src/paper-fold.ts`/`fills.ts`; reproduce in a unit test; fix the side that is wrong. If the fill was real, state the realised P&L correction for both SENSEX books in the review.
- Test: engine test for (a); gateway or api test for (b).

**Interfaces:** none produced; consumes read-only Mongo.

**Done when:** the review answers spec §WS3 items 1–4 with numbers and tables; recommendations carry exact PATCH bodies and are NOT applied; both defects have a failing-then-passing test; hand-back states clearly which recommendation the author would apply first and why.

### Task WS4: optionbhai at the origin, with backoff and diagnostics

Branch: `ws4-mirror-origin`. Spec §WS4.

**Files:**
- Create: `apps/runner/src/optionbhai-env.ts` — `optionbhaiOptionsFromEnv(env)` → `{ baseUrl, socketUrl, hostHeader?, userAgent }` with the defaults `https://optionbhai.com` / `wss://optionbhai.com`; rejects a `baseUrl` that is not `http(s)://` and a `socketUrl` that is not `ws(s)://`.
- Modify: `apps/runner/src/optionbhai.ts` — accept `hostHeader`, `userAgent` in `OptionbhaiClientDeps`; send `Host` (when set) and `User-Agent` on login and instruments fetch; pass `{ headers: { Host, 'User-Agent' } }` to `new WebSocket(url, opts)`; replace fixed `RETRY_MS` with `nextRetryMs(attempt, lastStatus)`: 5 s doubling to 300 s with ±20 % jitter, and ≥ 600 s after a 403; on a non-2xx login log once per burst: status, `cf-ray` header if present, first 200 chars of the body, never the credentials or token.
- Modify: `apps/runner/src/main.ts:647-678` — build deps from `optionbhaiOptionsFromEnv(process.env)`.
- Modify: `docs/DEPLOYMENT.md` — the three variables, and fix `OPTIONBHAI_TEST3_*` naming and the missing A010 line.
- Do NOT edit `.env.local` (orchestrator does; it holds credentials).
- Test: `apps/runner/test/optionbhai-env.test.ts`, extend `apps/runner/test/mirrors.test.ts` or add `optionbhai-client.test.ts` using the injectable `fetch`/`openSocket`.

**Interfaces:**
- Produces: env contract `OPTIONBHAI_BASE_URL`, `OPTIONBHAI_SOCKET_URL`, `OPTIONBHAI_HOST_HEADER`; log shape `login rejected {status, cfRay, bodyHead, retryMs}`.

**Done when:** tests cover header injection, backoff schedule including the 403 cool-off, and that the socket URL with the token is never logged; runner typecheck clean; hand-back lists the `.env.local` lines and the four PATCH commands.

### Task WS5: October stock books as a script

Branch: `ws5-stock-books`. Spec §WS5.

**Files:**
- Create: `scripts/stock-books.mjs` — pure: `planStockBooks(expiry)` (the three tags, dials, series), `chooseStrikes({spot, strikes, step})` → `{ atm, wingLo, wingHi }` (ATM = nearest strike to spot; wings = nearest strike to spot × (1 ∓ 0.09)), `sizeLots(symbol)` = 5 / 5 / 2; `--register` (create → start → PATCH switch on, exactly the September calls, converging on 200 for a row that exists), `--open` (refuse outside 09:20–15:00 IST or on a non-trading day or when `desk-books` already holds legs; read the October future's last mark via the api's instruments/marks endpoints; submit four entry orders through `POST /v1/desk/submit` with the same body shape the Strategies page uses — read `apps/api/src/routes/submit.ts` and `apps/api/src/validate.ts` for it; poll fills; then `POST /v1/desk/seed {symbol, expiry, tag, mode:'paper', legs:[{strike,type,qty,rate}]}` with the filled rates, short legs negative).
- Create: `docs/runbooks/stock-books.md` — register today, open Monday 09:35 IST, what to check after.
- Create: `apps/api/test/stock-books.test.ts` — pins the plan payloads, strike choice on the three Friday marks (TCS 2076.8 → ATM 2080, wings 1880/2280 given step 40; TATASTEEL 178.65 → 180, wings 162.5→ nearest 160 or 165 (pin whichever the rounding rule gives) / 195; KALYANKJIL 528 → 520, wings 480/580 given step 20 — compute, do not guess), the sizes, the refusals, and the exact call order with a recording `request` like `delta-lean-roll.test.ts` does.

**Interfaces:**
- Consumes: `PAPER`, `requestJson`, `istDate` from `scripts/delta-lean-books.mjs`; `isTradingDay` from `@algomaker/desk-engine`; `series` on the registry GET (WS2) — send `series` only when the GET already returns that field.
- Produces: the runbook commands the operator runs.

**Done when:** `node scripts/stock-books.mjs --register` dry run prints the three books with expiry 2026-10-27 and September's dials; tests green; nothing applied against the desk from the worktree.

---

## Orchestrator steps (main session)

- [ ] Dispatch WS1–WS5 as Opus subagents in worktrees, concurrently.
- [ ] On each hand-back: fresh reviewer subagent on the branch (correctness first); fix loop until approved.
- [ ] Merge in order WS4, WS5, WS3, WS1, WS2 (WS2 last: it touches the most shared files); resolve conflicts; `npm ci` not needed on the main tree.
- [ ] `make check` once on master; `npm run build --workspace @algomaker/web`.
- [ ] `.env.local`: add the three OPTIONBHAI lines.
- [ ] Workspace: delete the three merged local branches; verify the stray JSON files are gone.
- [ ] Push master.
- [ ] Ops (API calls, attempted from the session, handed over if refused): `node scripts/stock-books.mjs --register --apply`; the 1b retirement sequence AFTER the operator's restart; the mirror PATCHes AFTER the runner restart.
- [ ] Hand-over message: restart commands, retirement commands, mirror switch-on, Monday's `--open`, the review's first recommendation.
