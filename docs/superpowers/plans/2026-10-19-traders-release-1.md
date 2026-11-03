# Traders Release 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Traders log in, see one tab per open book (stock or index) with legs, LTP, IV, greeks, MTM and a multi-month payoff chart, built from the ODIN trade files their PC syncs; they add legs by hand and read their orders; one admin sees every trader; nothing can trade.

**Architecture:** A new Node process `apps/traders` (port 8794, behind Caddy) with its own `traders-*` collections, one write gate (`TradersDb`), an endpoint table that every request is matched against, parsers for ODIN's `OnLineBackup` files, a ledger that derives legs from trades with VolHedge's net-price rule, and pure analytics on `@algomaker/payoff`/`greeks`/`instruments`. A pure-Go `watcher.exe` uploads the files as they grow (new lines only). A second Vite page `traders.html` builds to `apps/web/dist-traders/`. Market data arrives through the desk's bus and a `desk-subscriptions` declaration; no desk code path changes.

**Tech Stack:** Node ≥ 24 running `.ts` by type stripping, `node:test`, MongoDB driver 3.7.3 (through `apps/api/src/mongo.ts`), `@algomaker/auth` (argon2id), `@algomaker/bus`, React 19 + recharts + `@astryxdesign/core`, Vitest + Testing Library, Go 1.27.1 + `github.com/fsnotify/fsnotify`.

**Spec:** `docs/superpowers/specs/2026-10-19-traders-design.md` (approved). **Contract:** `docs/superpowers/plans/2026-10-19-traders-contract.md`. **ODIN facts:** the coordinator's message of 2026-10-19 (OnLineBackup sample, live appends confirmed) — authoritative until the contract is updated; this plan follows it.

## Contract changes requested

No name in the contract is renamed. Items 1–9 were accepted by the coordinator on 2026-10-19 and are in the contract; item 10 maps the R2/R3 seams.

1. **There is no positions file.** ODIN legs (source `odin`) are derived from `traders-trades` with the net-price rule (Task 7). `BookView.mismatch` and `BookSummary.mismatch` stay in the types and are always `null` in R1. A canonical positions CSV uploaded by admin is an **opening balance** as of its day — positions opened before the trade history — and later trades fold on top of it, as the contract's working copy says. (The coordinator accepted this over turning the upload into manual legs: later trades close an opening balance correctly.)
2. **`BookView.historyFrom: string | null`** — the `day` of the earliest ODIN trade file seen (parser ids `odin-*-trades` only; a canonical upload never moves it), `null` before any. The book says "Trade history starts <date>; positions opened before it, and shares delivered at expiry, must be added by hand."
3. **`BookView.forwards`** — the forward each held expiry is valued off: its own future, else put-call parity at the money, else spot carried (`forwardFor`, Task 17). `futures` is that expiry's own future mark, `null` for an index weekly.
4. **Trades:** `TraderTrade.seq` = 1-based line number in its file; `qty` is positive shares, the sign is in `side`; de-dup key `(trader, day, tradeNo, orderNo)` with `orderNo` = the exchange order number.
5. **Orders:** `TraderOrder.filledQty: number | null`, `TraderOrder.updateTime: number`; `status` reads `"<label> (<ODIN code>)"`, e.g. `Traded (4)`; an older row never overwrites a newer one.
6. **Parsers:** ids `odin-nse-fo-trades`, `odin-nse-eq-trades`, `odin-nse-orders`, `odin-bse-fo-trades`, plus the three canonical ones. BSE order files (pipe-delimited) are stored, not parsed, in R1.
7. **Watcher:** include patterns `*/Trades/*TRD.TXT`, `*/Orders/*.txt`, `*/Orders/*.TXT`, relative to ODIN's `OnLineBackup` (the watched folder). Zero-byte files are not uploaded. A file that only grew is sent as an `offset` append (the normal path for the day's trade file); anything else whole; an unterminated last line is held back by the watcher and ignored by the ODIN parsers.
8. **Clarification (accepted):** `TradersDb.desk(name)` is a READ-ONLY view of exactly `instrument` and `desk-marks`; writes stay limited to the traders list.
9. **Additions (accepted):** `packages/payoff/src/multi-month.ts` (`buildMultiMonthView`); the desk's payoff chart in `apps/web/src/payoff-curves.tsx` and formatters in `apps/web/src/format.ts`; `traders-settings.kind` with a unique `{kind, trader}` index (R1 uses `watcher` and `ledger`); `LegView.clientCode`, `LegView.note`, `LegView.lotSize`; admin rows' `token`; `GET /v1/traders/health` and `GET /v1/traders/files`.
10. **Seams for Releases 2 and 3:** the table below.

### Seams for Releases 2 and 3

R2's "Needs from Release 1" (N1–N16) and R3's "Needs from Releases 1–2" (N1.1–N1.12), each mapped to what R1 ships. R1 adds the small seams; R2/R3 features stay in their plans.

| Row | R1 name and signature | Task |
|---|---|---|
| R2 N1 | `TradersDeps` (`src/deps.ts`) — the one bag; R1 factories take `Pick<TradersDeps, …>`; `createApp(d: AppDeps): Promise<App>` in `src/app.ts` builds it and the routes list (R2 appends its routes and extends `TradersDeps` there, it does not define its own) | 18 |
| R2 N2 / R3 N1.7 | `whose(ctx: RouteCtx, users: TraderStore): Promise<string>` (`src/auth/whose.ts`), throws `BadRequest`/`NotFound`/`Forbidden`; no `ownerOf` | 3 |
| R2 N3 / R3 N1.7 | admin-only = `kind: 'admin'` in `ENDPOINTS`, enforced by the server; no `requireAdmin` | 2 |
| R2 N4 | `LegStore.open(trader, stock?)`, `LegStore.allOpen()`, `LegStore.openBooks()`, `LegStore.version(trader)`; trades read through `db.collection('traders-trades')`; `TraderTrade.qty` is POSITIVE shares, `side` carries the sign (contract) | 13 |
| R2 N5 / R3 N1.1 | `TradersQuotes { quote(token): TraderQuote \| null; feedAlive(): boolean }`, `TraderQuote { price, bid, ask, oi, volume, asOf, ageMs }` (`tradersQuotes(cache)` in `src/market/quotes.ts`). **No `close`:** the bus does not carry it — `md.tick` (`tickPayload`, `apps/marketdata/src/main.ts:546`) forwards token, price, ts, oi, volume, bid, ask and depth; Kite's `ohlc.close` reaches the bus only as `md.spot.prevClose`, and only for the desk's own spot underlyings. Plumbing it needs a desk-marketdata code change and an operator restart, which R1 does not make — R2's MTM design picks its source | 15 |
| R2 N6 / R3 N1.2 | `deps.master: () => TradersMaster` (`{options: OptionMaster; cash; loadedAt}`), never null (loaded before listen); `spotTokenOf(m, stock)`, `matchLeg`, `lotSizeOf` (`src/market/master.ts`) | 6, 18 |
| R2 N7 | `wantedTokens` always declares the underlying's NEAREST listed future, held or not | 15 |
| R2 N8 | `monthQuotes(m, q, stock, expiry, spot, asOf, closed): MonthQuotes`, `MonthQuotes { expiry, future, forward, source, quotes: readonly ChainQuoteLite[], ivs, tYears }` | 17 |
| R3 forward | `forwardFor(m, q, stock, expiry, spot, asOf)` — exported, callable for ANY listed (underlying, expiry), held or not | 17 |
| R2 N9 / R3 N1.8 | `ENDPOINTS` (`src/routes/endpoints.ts`, `{id, method, pattern, kind, raw?}`); cases in `apps/traders/test/ownership-cases.ts` `CASES: Record<id, Case>`; no `'market-data'` kind — such an endpoint is kind `trader` and its case asserts no `trader`/`legs`/`key` field | 2, 19 |
| R2 N10 / R3 N1.9 | `startHarness(suite, routes)` (route level) and `startTraders({suite, master?: TradersMaster, quotes?: TradersQuotes, now?, deps?: Partial<TradersDeps>})` (full app) in `apps/traders/test/harness.ts`; fixture `test/fixtures/master.ts` (TCS on OCT/NOV/DEC, NIFTY weekly + OCT, M&M, BAJFINANCE, JINDALSTEL) | 3, 6, 18 |
| R2 N11 | `JSON_BODY_MAX = 64 * 1024` (413 above) | 2 |
| R2 N12 / R3 N1.11 | web: `tapi`, `tradersApi.get/post/put/patch/del`, `setAsTrader` (`traders/api.ts`); `PAGES` (`pages.tsx`); `BookTab`, `BOOK_SUBTABS`, `BOOK_HEADER_CHIPS` (`book.tsx`); `BOOK_TAB_BADGES` (`books.tsx`); `ADMIN_SECTIONS` (`admin.tsx`); `usePoll` (`hooks.ts`); `format.ts`; server types by `import type` from `apps/traders/src/types.ts` | 22, 23 |
| R2 N13 | `createApp` / `App.start()` in `src/app.ts` | 18 |
| R2 N14 | `docs/runbooks/traders.md` | 24 |
| R2 N15 | `traders-settings` keyed `{kind, trader}` (R1: `watcher`, `ledger`); `.gitignore` gains `!apps/traders/test/fixtures/**` and keeps `trader-data-sample/` | 1 |
| R2 N16 | `PayoffCurves` in `apps/web/src/payoff-curves.tsx`, formatters in `apps/web/src/format.ts` | 22 |
| R3 N1.3 | `deps.subscriptions: Declarer { addTokenSource(name, fn: (nowMs) => readonly number[]); refreshNow(): Promise<readonly number[]>; last(); stop() }` | 15 |
| R3 N1.4 | `buildBookView(d, trader, stock, nowMs, opts?: {keys?: ReadonlySet<string>}): Promise<BookView \| null>`; `deps.bookView(trader, stock, nowMs, opts?)` (deps bound) | 17, 18 |
| R3 N1.5 | `deps.legs.open(trader, stock?)`, `deps.legs.openBooks(): Promise<{trader, stock}[]>`, `deps.users.list('trader')` (not `db.legs`/`db.openBooks`/`db.traders`) | 3, 13 |
| R3 N1.6 | new collections through a store class calling `db.collection('traders-events' \| 'traders-groups')`; no per-collection methods on `TradersDb` | 1 |
| R3 N1.10 | `GET /books` in `src/routes/books.ts` returns `BookSummary[]` (`src/types.ts`) — R3 adds `band` there | 14 |
| R3 N1.12 | `BookView.historyFrom: string \| null` | 13, 17 |

## Global Constraints

- Node runs `.ts` directly: `erasableSyntaxOnly` and `verbatimModuleSyntax` are on — no enums, namespaces, parameter properties or decorators; every relative import carries its `.ts`/`.tsx` extension; type-only imports use `import type`.
- The Mongo driver is reached only through `connectMongo` in `apps/api/src/mongo.ts` (driver pinned 3.7.3). Only `src/db.ts`, `src/main.ts` and `src/user-cli.ts` in apps/traders may import it or name the raw `Database` type.
- apps/traders never imports at runtime (transitively) `apps/api/src/submit*`, `apps/api/src/repair-apply*`, `apps/order-gateway/`, `packages/order-bus/`, `packages/brokers/`. Type-only imports are erased and allowed. The Task 1 test enforces it; every task keeps it green.
- `TradersDb` is the only object that writes: `traders-users`, `traders-sessions`, `traders-tokens`, `traders-files`, `traders-file-versions`, `traders-legs`, `traders-orders`, `traders-trades`, `traders-log`, `traders-settings`, `traders-events`, `traders-groups`, plus the one `desk-subscriptions` document `{source: 'traders'}` written through `publishSubscription`.
- Every query for trader data goes through `whose(ctx, users)`: a trader is always themselves (`?as=` ignored); an admin must name a trader with `?as=`. No endpoint takes a trader name from a trader's request body or path.
- No endpoint, button or code path places, changes or cancels an order. No UI text offers to (item 6).
- **The ODIN sample** is the operator's zip `/opt/algomaker-delta/trader-data-sample/OnLineBackup-19oct.zip` (gitignored, readable from any worktree). A fixture task unzips it into its OWN scratch directory, never inside the repo: `unzip -q /opt/algomaker-delta/trader-data-sample/OnLineBackup-19oct.zip -d <scratch>/odin-sample` — `<sample>` below is `<scratch>/odin-sample/OnLineBackup`. (Alternative while this session lasts: the unpacked copy at `/tmp/claude-1000/-opt-algomaker/edfe3045-5443-4038-9060-d99d025f7849/scratchpad/odin-sample/OnLineBackup`.) It holds real client codes: it is read to build fixtures and is NEVER committed or copied into the repo whole. Fixtures are scrubbed excerpts: the real client code → `C0001`, the real user id → `U0001`, the real BSE client code → `C0001`, any other personal or member id → zeros. No real code may appear in any committed file, test included (tests assert the scrubbed shape, never the real value).
- A book is keyed by its underlying — a stock or an index (NIFTY, BANKNIFTY, SENSEX). Nothing assumes a stock, a monthly expiry or a future for every expiry.
- Exact values: port `TRADERS_PORT` default `8794`, bound to `127.0.0.1`; cookie `traders_session` (`HttpOnly; SameSite=Strict; Path=/`, `Secure` only over TLS); session TTL `TRADERS_SESSION_TTL_MS` default 8 h (`DEFAULT_SESSION_TTL_MS`); lockout `DEFAULT_LOCKOUT_POLICY` (5 failures, 15 min); passwords ≥ 8 characters; usernames `/^[a-z0-9._-]{2,32}$/` after trim + lower-case; JSON bodies ≤ 64 KiB; file bodies ≤ 20 MiB (20,971,520 bytes); file versions kept 7 days; watcher quiet 2 s, rescan 5 min, heartbeat 60 s, retry 30 s; subscription declaration every 15 s, ATM ± 15 strikes per held expiry; watcher "offline" after 180 s without a heartbeat; payoff recomputed at most once per 60 s per book.
- Days are IST calendar days `YYYY-MM-DD`; times shown as IST `HH:MM`. ODIN times are IST.
- Tests: `node:test`, real Mongo, a distinct database per suite named `algomaker_traders_test_<suite>` (or `DESK_TEST_MONGO` when running one file), never `algomaker`; skip through `skipUnlessMongo` from `apps/api/test/require-mongo.ts`; run Mongo suites with `DESK_REQUIRE_MONGO=1` so a skip is a failure. Servers listen on port 0. Tests never construct `WsTransportClient` (the live bus is on 8791) and never call ports 8790–8793.
- Desk behaviour does not change: every existing suite (`npm test`, web suite, payoff suite) stays green with no expectation edited.
- No task restarts a desk process, runs `scripts/`, or reaches an external host. The one network fetch (the fsnotify Go module, Task 21) asks first.
- Execution: each task's worktree starts from the current `feat/traders` head (fast-forward it first — earlier tasks' commits must be present). Mongo suites of different tasks use different databases; run the whole `make check` once on the merged tree at the end.
- Web: astryx components per `apps/web/AGENTS.md`; DOM tests are `.test.tsx` (vitest), plain `.test.ts` in `apps/web/test` runs under `node:test`.
- Watcher: pure Go, `CGO_ENABLED=0`, built `GOOS=windows GOARCH=amd64`; Go at `/usr/local/go/bin/go`.
- Every commit message ends with the attribution lines your session's system reminder gives.

## Review Focus

1. **A trade line caught half-written** (ODIN appends during the session, no CRLF yet) — it must not land as a truncated trade, and must land whole once complete. Tests: Task 8 (`an unterminated last line is held back`), Task 21 (`TestPartialLastLineHeldBack`), Task 13 (`an append lands only its new lines`).
2. **An index book on a weekly expiry with no future of its own** (the trader holds NIFTY/BANKNIFTY/SENSEX weeklies) — it must be priced off a forward, not left unpriced or priced off the monthly future. Tests: Task 17 (`a weekly with no future is valued off the parity forward`), Task 15 (`an index weekly declares spot, its window and the nearest monthly future`).
3. **Symbols with URL-special characters (`M&M`, `BAJAJ-AUTO`)** in paths (`/books/M%26M`) — they must round-trip. Tests: Task 14 (`POST /books/M%26M/legs`), Task 17 (`GET /books/M%26M`), Task 22 (tab click requests `/v1/traders/books/M%26M`).
4. **The trade history still holds expired contracts** — a contract past its expiry with net quantity left (an option that expired, or one physically settled into shares) is closed: never priced, counted or declared as live. Tests: Task 14 (`expired legs are not counted`), Task 15 (`expired legs are not declared`), Task 17 (`expired legs are hidden with a warning`).
5. **An admin with no trader picked** opening a trader screen — a prompt, not an error page. Tests: Task 3 (`whose()` rules), Task 22 (`an admin with no trader picked sees a prompt`).

---

## File Structure

```
apps/traders/
  package.json                    @algomaker/traders, "type": "module"
  src/types.ts                    contract types (+ additions) + legKey, isOpenLeg, contractText
  src/hash.ts                     sha256hex
  src/db.ts                       TradersDb — the only writer (P16)
  src/server.ts                   createTradersServer: CORS, origin rule, content types, caps, endpoint gate
  src/routes/kit.ts               RouteCtx, Route, TradersGate, errors, IST helpers
  src/routes/endpoints.ts         ENDPOINTS table + matchEndpoint — every endpoint lives here
  src/routes/{auth,admin,uploads,books,records,book-view,health}.ts
  src/auth/{cookies,users,sessions,tokens,gate,whose}.ts
  src/watcher-status.ts           WatcherStatusStore (traders-settings kind 'watcher')
  src/ingest/{csv,parsers,canonical,files,pipeline,ledger,ledger-store,apply}.ts
  src/ingest/odin/{common,nse-fo-trades,nse-eq-trades,nse-orders,bse-fo-trades}.ts
  src/books/{legs,manual}.ts      LegStore, manual-leg validation
  src/market/{master,quotes,subscriptions}.ts
  src/analytics/{month-chain,book-view,payoff-cache}.ts
  src/config.ts  src/deps.ts  src/app.ts  src/main.ts  src/user-cli.ts
  test/…                          one suite per area; harness.ts, mongo.ts, import-walk.ts,
                                  ownership-cases.ts, fixtures/master.ts, fixtures/odin/<Segment>/<Trades|Orders>/…
bin/desk-traders.mjs  bin/traders-user.mjs
packages/payoff/src/multi-month.ts (+ index export, test)
apps/watcher/                     go.mod, main.go, internal/{config,uploader,syncer}
apps/web/traders.html  apps/web/vite.traders.config.ts
apps/web/src/format.ts  apps/web/src/payoff-curves.tsx      (moved out of api.ts / payoff.tsx)
apps/web/src/traders/{main,app,pages,api,wire,route,hooks,login,books,book,add-leg,orders,admin}.tsx|ts
apps/web/test/traders/*.test.tsx  apps/web/test/traders-imports.test.ts
ecosystem.desk.config.cjs (desk-traders entry)  Makefile (watcher targets)  .gitignore
docs/runbooks/traders.md
```

**Task order and parallelism** (a task may start once the tasks it names are merged):

| Wave | Tasks | Waits on |
|---|---|---|
| 1 | 1 scaffold · 16 multi-month payoff · 20 watcher config+uploader | — |
| 2 | 2 server · 5 parser registry · 6 master · 22 web core · 21 watcher syncer | 1 (2, 5, 6, 22); 20 (21) |
| 3 | 3 auth · 7 ledger · 15 market · 23 web orders+admin | 2 (3); 5 (7); 6 (15); 22 (23) |
| 4 | 4 admin · 8 ODIN common + NSE F&O trades | 3 (4); 5, 7 (8) |
| 5 | 9 NSE equity trades · 10 NSE orders · 11 BSE F&O trades · 12 file store + uploads | 8 (9, 10, 11); 3, 4, 5 (12) |
| 6 | 13 apply parsed files | 6, 7, 8, 12 |
| 7 | 14 books, manual legs, records | 13 |
| 8 | 17 book view | 14, 15, 16 |
| 9 | 18 boot | 17, 9, 10, 11 |
| 10 | 19 safety walk · 24 runbook | 18 (19); 18, 21, 23 (24) |

Task 11 (BSE) is the lowest priority: SENSEX is an index and NSE plus equities come first. If it slips, Task 18 registers the parsers that exist.

---

### Task 1: Scaffold, shared types, `TradersDb`, the import rule

**Files:**
- Create: `apps/traders/package.json`, `apps/traders/src/types.ts`, `apps/traders/src/hash.ts`, `apps/traders/src/db.ts`
- Create: `apps/traders/test/mongo.ts`, `apps/traders/test/import-walk.ts`
- Test: `apps/traders/test/types.test.ts`, `apps/traders/test/db.test.ts`, `apps/traders/test/import-rule.test.ts`
- Modify: `package-lock.json` (new workspace entry only), `.gitignore` (`!apps/traders/test/fixtures/**` — `*.csv`, `*.log`, `*.dat` are ignored repo-wide)

**Interfaces:**
- Consumes: `publishSubscription` from `apps/marketdata/src/subscription-store.ts`; `type Database` from `apps/api/src/store.ts`.
- Produces:
  - `types.ts`: every type in the contract's "Shared types" block, with the additions `TraderTrade.seq: number`, `TraderOrder.filledQty: number | null`, `TraderOrder.updateTime: number`, plus
    ```ts
    export function legKey(l: Pick<TraderLeg, 'clientCode'|'instrument'|'stock'|'expiry'|'strike'|'optType'>): string
    export function isOpenLeg(l: Pick<TraderLeg, 'qty'|'instrument'|'expiry'>, today: string): boolean // qty !== 0 && (share || expiry >= today)
    export function contractText(l: Pick<TraderLeg, 'instrument'|'expiry'|'strike'|'optType'>): string // '3500 CE 2026-10-27' | 'FUT 2026-10-27' | 'shares'
    export interface WatcherStatus { readonly lastHeartbeatAt: number; readonly lastUploadAt: number | null; readonly version: string; readonly folder: string; readonly fileCount: number }
    export interface BookSummary { readonly stock: string; readonly legCount: number; readonly mismatch: string | null; readonly lastFileAt: number | null }
    export interface AdminTraderRow { readonly username: string; readonly disabled: boolean; readonly lastLoginAt: number | null; readonly watcher: WatcherStatus | null; readonly token: { readonly createdAt: number; readonly lastUsedAt: number | null } | null }
    export interface ManualLegInput { readonly stock: string; readonly instrument: Instrument; readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null; readonly qty: number; readonly avgPrice: number; readonly note: string }
    // LegView and BookView as the contract, with additions:
    //   LegView: readonly clientCode: string; readonly note: string; readonly lotSize: number | null
    //   BookView: readonly forwards: Readonly<Record<string, number | null>>; readonly historyFrom: string | null
    ```
    `BookView.payoff` is `import type { PayoffView } from '@algomaker/payoff'`. `types.ts` has no runtime imports.
  - `hash.ts`: `export function sha256hex(data: string | Buffer): string` (lower-case hex).
  - `db.ts`:
    ```ts
    export const TRADERS_COLLECTIONS: readonly [ /* the 12 names in the Global Constraints, in that order */ ]
    export type TradersCollection = (typeof TRADERS_COLLECTIONS)[number]
    export const DESK_READ_COLLECTIONS: readonly ['instrument', 'desk-marks']
    export type DeskReadCollection = (typeof DESK_READ_COLLECTIONS)[number]
    export const SUBSCRIPTION_SOURCE = 'traders'
    export class ForbiddenCollection extends Error {}
    export interface Cursor<T> { sort(s: Record<string, 1 | -1>): Cursor<T>; limit(n: number): Cursor<T>; toArray(): Promise<T[]> }
    export interface FindOptions { readonly projection?: Record<string, 0 | 1> }
    export interface TradersCollectionPort<T> {
      findOne(f: Record<string, unknown>, o?: FindOptions): Promise<T | null>
      find(f: Record<string, unknown>, o?: FindOptions): Cursor<T>
      insertOne(doc: T): Promise<unknown>
      updateOne(f: Record<string, unknown>, u: Record<string, unknown>, o?: { upsert?: boolean }): Promise<{ matchedCount?: number; upsertedCount?: number }>
      updateMany(f: Record<string, unknown>, u: Record<string, unknown>): Promise<unknown>
      deleteOne(f: Record<string, unknown>): Promise<unknown>
      deleteMany(f: Record<string, unknown>): Promise<unknown>
      countDocuments(f: Record<string, unknown>): Promise<number>
      createIndex(spec: Record<string, 1 | -1>, o?: { unique?: boolean; name?: string; partialFilterExpression?: Record<string, unknown> }): Promise<unknown>
    }
    export interface ReadOnlyCollection<T> { findOne: TradersCollectionPort<T>['findOne']; find: TradersCollectionPort<T>['find']; countDocuments: TradersCollectionPort<T>['countDocuments'] }
    export class TradersDb {
      constructor(raw: Database)
      collection<T = Record<string, unknown>>(name: TradersCollection): TradersCollectionPort<T> // throws ForbiddenCollection for any other string at runtime
      desk<T = Record<string, unknown>>(name: DeskReadCollection): ReadOnlyCollection<T>        // a new object holding ONLY the three read methods
      publishSubscription(tokens: readonly number[], nowMs: number): Promise<void>                 // desk-subscriptions, source 'traders', via publishSubscription
      ensureIndexes(): Promise<void>
    }
    ```
    New collections (R3's events, groups) are reached by store classes calling `db.collection('traders-…')`; `TradersDb` gains no per-collection methods.
    Indexes (`ensureIndexes`): users `{username:1}` unique; sessions `{tokenHash:1}` unique, `{expiresAt:1}`; tokens `{tokenHash:1}` unique, `{trader:1}` unique with `partialFilterExpression: {revokedAt: {$type: 'null'}}` named `one_active_token_per_trader`; files `{trader:1,path:1}` unique; file-versions `{trader:1,path:1,receivedAt:-1}`, `{receivedAt:1}`; legs `{trader:1,key:1}` unique, `{trader:1,stock:1}`; orders `{trader:1,day:1,orderNo:1}` unique; trades `{trader:1,day:1,tradeNo:1,orderNo:1}` unique, `{trader:1,day:1}`; log `{trader:1,day:1,seq:1}` unique; settings `{kind:1,trader:1}` unique.
  - `test/mongo.ts`: `suiteUrl(suite: string): string` (throws `never the desk database` when the resolved db name is `algomaker`); `connectSuite(suite: string): Promise<{ handle: MongoHandle; db: TradersDb } | null>` (null when unreachable, `serverSelectionTimeoutMS: 1500`); `wipe(handle: MongoHandle, extra?: readonly string[]): Promise<void>` (`deleteMany({})` on every traders collection and each `extra`).
  - `test/import-walk.ts`: `walkRuntimeImports(entries: readonly string[]): { files: Set<string>; externals: Set<string> }` (repo-relative POSIX paths), `listSources(dir: string): string[]` (every `.ts`/`.tsx` under it), `BANNED_FOR_TRADERS: readonly RegExp[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/traders/test/types.test.ts
test('legKey is the contract format', () => {
  assert.equal(legKey({ clientCode: 'C1', instrument: 'option', stock: 'TCS', expiry: '2026-10-27', strike: 3500, optType: 'CE' }), 'C1|option|TCS|2026-10-27|3500|CE')
  assert.equal(legKey({ clientCode: 'C1', instrument: 'future', stock: 'TCS', expiry: '2026-10-27', strike: null, optType: null }), 'C1|future|TCS|2026-10-27||')
  assert.equal(legKey({ clientCode: '', instrument: 'share', stock: 'TCS', expiry: '', strike: null, optType: null }), '|share|TCS|||')
})
test('isOpenLeg drops zero and expired legs, never shares by date', () => {
  assert.equal(isOpenLeg({ qty: 0, instrument: 'option', expiry: '2026-10-27' }, '2026-10-19'), false)
  assert.equal(isOpenLeg({ qty: -350, instrument: 'option', expiry: '2026-10-27' }, '2026-10-28'), false)
  assert.equal(isOpenLeg({ qty: -350, instrument: 'option', expiry: '2026-10-27' }, '2026-10-27'), true)
  assert.equal(isOpenLeg({ qty: 1000, instrument: 'share', expiry: '' }, '2030-01-01'), true)
})
test('contractText', () => {
  assert.equal(contractText({ instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE' }), '3500 CE 2026-10-27')
  assert.equal(contractText({ instrument: 'future', expiry: '2026-10-27', strike: null, optType: null }), 'FUT 2026-10-27')
  assert.equal(contractText({ instrument: 'share', expiry: '', strike: null, optType: null }), 'shares')
})

// apps/traders/test/db.test.ts — a recording fake Database for the first three
test('collection() refuses every name outside the traders list', () => {
  const tdb = new TradersDb(fakeDatabase().db)
  for (const n of ['desk-books-registry', 'desk-subscriptions', 'instrument', 'positional', 'traders-unknown', 'Traders-users', ''])
    assert.throws(() => tdb.collection(n as never), ForbiddenCollection)
  assert.doesNotThrow(() => tdb.collection('traders-legs'))
})
test('desk() is read-only and limited to instrument and desk-marks', () => {
  const ro = new TradersDb(fakeDatabase().db).desk('instrument')
  for (const m of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'createIndex', 'drop'])
    assert.equal(m in ro, false)
  assert.throws(() => new TradersDb(fakeDatabase().db).desk('desk-books-registry' as never), ForbiddenCollection)
})
test('publishSubscription writes exactly the traders document', async () => {
  const fake = fakeDatabase()
  await new TradersDb(fake.db).publishSubscription([30, 10, 30, 20], 1000)
  assert.deepEqual(fake.calls, [{ collection: 'desk-subscriptions', method: 'updateOne',
    args: [{ source: 'traders' }, { $set: { source: 'traders', tokens: [10, 20, 30], updatedAt: 1000 } }, { upsert: true }] }])
})
test('ensureIndexes: a second active token for one trader is refused', async (t) => {
  const s = await connectSuite('db'); if (s === null) return skipUnlessMongo(t)
  await wipe(s.handle); await s.db.ensureIndexes()
  const tokens = s.db.collection('traders-tokens')
  await tokens.insertOne({ trader: 'a', tokenHash: 'h1', createdAt: 1, lastUsedAt: null, revokedAt: null })
  await assert.rejects(tokens.insertOne({ trader: 'a', tokenHash: 'h2', createdAt: 2, lastUsedAt: null, revokedAt: null }))
  await tokens.insertOne({ trader: 'a', tokenHash: 'h3', createdAt: 3, lastUsedAt: null, revokedAt: 4 })
  await s.handle.close()
})
test('suiteUrl never names the desk database', () => {
  assert.match(suiteUrl('x'), /\/algomaker_traders_test_x$/)
  process.env['DESK_TEST_MONGO'] = 'mongodb://127.0.0.1:27017/algomaker'
  try { assert.throws(() => suiteUrl('x'), /never the desk database/) } finally { delete process.env['DESK_TEST_MONGO'] }
})

// apps/traders/test/import-rule.test.ts
test('apps/traders reaches no order code at runtime', () => {
  const { files } = walkRuntimeImports(listSources('apps/traders/src'))
  assert.deepEqual([...files].filter((f) => BANNED_FOR_TRADERS.some((re) => re.test(f))), [])
})
test('the walker would see it: desk-api main reaches submit and order-bus', () => {
  const { files } = walkRuntimeImports(['apps/api/src/main.ts'])
  assert.ok([...files].some((f) => f.startsWith('apps/api/src/submit')))
  assert.ok([...files].some((f) => f.startsWith('packages/order-bus/')))
})
test('a type-only import is not followed', () => {
  const { files } = walkRuntimeImports(['packages/instruments/src/master.ts'])
  assert.equal([...files].some((f) => f.startsWith('packages/order-bus/')), false)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/types.test.ts apps/traders/test/db.test.ts apps/traders/test/import-rule.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

- `package.json`: name `@algomaker/traders`, `private`, `"type": "module"`, `"scripts": {"test": "node --test test/*.test.ts"}`, `"engines": {"node": ">=24.9"}`, dependencies `@algomaker/auth`, `@algomaker/bus`, `@algomaker/core`, `@algomaker/greeks`, `@algomaker/instruments`, `@algomaker/payoff`, each `"1.0.0"`.
- `db.ts`: the runtime name check uses a `Set` of `TRADERS_COLLECTIONS`; `desk()` returns `{ findOne, find, countDocuments }` bound to the raw collection and nothing else.
- `import-walk.ts` rules (no comment stripping — a commented-out import is a loud false positive, never a miss):
  - static imports/exports matched by `/(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g`; also `import('x')` and `require('x')` with a string literal. `import { type A } from 'x'` counts as runtime (Node keeps the module load).
  - relative specifiers resolve against the importing file and MUST exist (throw `unresolved import <spec> in <file>`); `@algomaker/<pkg>[/<sub>]` resolves through `packages/<pkg>/package.json` `exports` (`.` or `./<sub>`, string or `{import|default}`); `node:*` is skipped; any other bare specifier goes to `externals` and is not followed; `.css` files are recorded, not read.
  - `BANNED_FOR_TRADERS = [/^apps\/api\/src\/submit/, /^apps\/api\/src\/repair-apply/, /^apps\/order-gateway\//, /^packages\/order-bus\//, /^packages\/brokers\//]`.
- Register the workspace: `npm install --offline --no-audit --no-fund`. Verify `git diff --stat package-lock.json` shows only the `apps/traders` and `node_modules/@algomaker/traders` entries. If `--offline` cannot complete, stop and report — `scripts/deploy.sh` runs `npm ci`, which fails on a lockfile missing a workspace.

- [ ] **Step 4: Run to verify they pass**

Run: the Step 2 command, then `npx tsc -p tsconfig.json`.
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/traders package-lock.json .gitignore
git commit -m "feat(traders): scaffold, shared types, TradersDb write gate, import rule"
```

---

### Task 2: HTTP server and the endpoint table

**Files:**
- Create: `apps/traders/src/routes/kit.ts`, `apps/traders/src/routes/endpoints.ts`, `apps/traders/src/server.ts`
- Test: `apps/traders/test/server.test.ts`

**Interfaces:**
- Consumes: `Principal` from `types.ts`.
- Produces:
  ```ts
  // routes/kit.ts
  export type Log = (msg: string, ctx?: Record<string, unknown>) => void
  export interface TradersGate { authenticate(req: IncomingMessage): Promise<Principal | null> }
  export interface RouteCtx {
    readonly req: IncomingMessage; readonly res: ServerResponse; readonly url: URL; readonly path: string; readonly method: string
    readonly endpoint: Endpoint; readonly params: Readonly<Record<string, string>>
    readonly principal: Principal | null      // null only on a public endpoint
    readonly log: Log
    readJson(): Promise<unknown>              // ≤ JSON_BODY_MAX; '' → {}; bad JSON → BadRequest
    readRaw(): Promise<Buffer>                // raw endpoints only; ≤ RAW_BODY_MAX
    send(status: number, body: unknown): void
  }
  export type Route = (ctx: RouteCtx) => Promise<boolean>
  export class BadRequest extends Error {}  export class NotFound extends Error {}  export class Forbidden extends Error {}
  export class Conflict extends Error {}    export class PayloadTooLarge extends Error {}
  export const JSON_BODY_MAX = 64 * 1024
  export const RAW_BODY_MAX = 20 * 1024 * 1024
  export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
  export function istDate(ms: number): string        // 'YYYY-MM-DD'
  export function istClock(ms: number): string       // 'HH:MM'
  export function isIsoDate(v: unknown): v is string
  export function isObject(v: unknown): v is Record<string, unknown>
  // routes/endpoints.ts
  export type EndpointKind = 'public' | 'watcher' | 'admin' | 'trader'
  export interface Endpoint { readonly id: string; readonly method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; readonly pattern: string; readonly kind: EndpointKind; readonly raw?: true }
  export const ENDPOINTS: readonly Endpoint[]
  export function matchEndpoint(method: string, path: string, table?: readonly Endpoint[]): { endpoint: Endpoint; params: Record<string, string> } | null // ':x' = one segment, percent-decoded; bad escape → BadRequest
  // server.ts
  export interface TradersServerDeps { readonly gate: TradersGate; readonly routes: readonly Route[]; readonly allowedOrigins: readonly string[]; readonly endpoints?: readonly Endpoint[]; readonly log?: Log }
  export function createTradersServer(d: TradersServerDeps): Server
  ```
  `ENDPOINTS` — ids, all under `/v1/traders`. Kind `trader` means "any session" (trader or admin); the route decides with `whose()` whether it reads trader data — a market-data endpoint (R3) is kind `trader` and never calls it.

  | id | method | pattern | kind |
  |---|---|---|---|
  | `health` | GET | `/v1/traders/health` | public |
  | `auth.login` / `auth.logout` | POST | `/v1/traders/auth/login` / `…/auth/logout` | public |
  | `auth.me` | GET | `/v1/traders/auth/me` | public |
  | `watcher.files` | PUT | `/v1/traders/files` | watcher, raw |
  | `watcher.heartbeat` | POST | `/v1/traders/heartbeat` | watcher |
  | `admin.traders.list` / `admin.traders.add` | GET / POST | `/v1/traders/admin/traders` | admin |
  | `admin.traders.patch` | PATCH | `/v1/traders/admin/traders/:name` | admin |
  | `admin.token.issue` / `admin.token.revoke` | POST / DELETE | `/v1/traders/admin/traders/:name/token` | admin |
  | `admin.files.upload` | PUT | `/v1/traders/admin/traders/:name/files` | admin, raw |
  | `books.list` | GET | `/v1/traders/books` | trader |
  | `books.view` | GET | `/v1/traders/books/:stock` | trader |
  | `legs.add` | POST | `/v1/traders/books/:stock/legs` | trader |
  | `legs.patch` / `legs.delete` | PATCH / DELETE | `/v1/traders/legs/:key` | trader |
  | `orders.list` / `trades.list` / `log.list` | GET | `/v1/traders/orders` / `trades` / `log` | trader |
  | `watcher.status` | GET | `/v1/traders/watcher` | trader |
  | `files.list` | GET | `/v1/traders/files` | trader |

- [ ] **Step 1: Write the failing tests** (`server.test.ts`, no Mongo; a stub gate reads `Authorization: Bearer <kind>:<name>`; an `echo` route answers every endpoint with `{id, principal, params}` and, on raw endpoints, `{bytes}`)

```ts
test('the table: unique ids, /v1/traders prefix, exactly two raw endpoints', () => {
  assert.equal(new Set(ENDPOINTS.map((e) => e.id)).size, ENDPOINTS.length)
  assert.ok(ENDPOINTS.every((e) => e.pattern.startsWith('/v1/traders/')))
  assert.deepEqual(ENDPOINTS.filter((e) => e.raw).map((e) => e.id), ['watcher.files', 'admin.files.upload'])
})
test('preflight: allowed origin 204 with credentials, other origin 403', async () => { /* OPTIONS from 'http://traders.test' → 204, access-control-allow-origin echoed, allow-credentials 'true'; from 'http://evil.test' → 403 */ })
test('a write from a foreign Origin is refused; no Origin is allowed', async () => {
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', json: {}, origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', json: {} })).status, 200)
})
test('content types: JSON for writes, octet-stream only on the raw endpoints', async () => {
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', raw: 'x', contentType: 'text/plain' })).status, 415)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'watcher:a', raw: 'abc', contentType: 'application/octet-stream' })).body.bytes, 3)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'watcher:a', json: {} })).status, 415)
})
test('caps: JSON over 64 KiB and files over 20 MiB are 413', async () => {
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', json: { pad: 'x'.repeat(70_000) } })).status, 413)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'watcher:a', raw: Buffer.alloc(RAW_BODY_MAX + 1), contentType: 'application/octet-stream' })).status, 413)
})
test('an unlisted path is 404 and runs no route; a listed one with no handler is 500', async () => {
  assert.equal((await call('GET', '/v1/traders/nope', { bearer: 'trader:a' })).status, 404)
  assert.equal(echoCalls, 0)
  const bare = await start({ routes: [] })
  const r = await bare.call('GET', '/v1/traders/books', { bearer: 'trader:a' })
  assert.equal(r.status, 500); assert.match(r.body.error, /books\.list has no handler/)
})
test('the endpoint kind decides who may call', async () => {
  assert.equal((await call('GET', '/v1/traders/books')).status, 401)
  assert.equal((await call('GET', '/v1/traders/books', { bearer: 'watcher:a' })).status, 403)
  assert.equal((await call('GET', '/v1/traders/admin/traders', { bearer: 'trader:a' })).status, 403)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'trader:a', raw: 'x', contentType: 'application/octet-stream' })).status, 403)
  assert.equal((await call('GET', '/v1/traders/books', { bearer: 'admin:root' })).status, 200)
  assert.equal((await call('GET', '/v1/traders/health')).body.principal, null)
})
test('path params are decoded; a malformed escape is 400', async () => {
  assert.equal((await call('PATCH', '/v1/traders/legs/manual%3Aabc', { bearer: 'trader:a', json: {} })).body.params.key, 'manual:abc')
  assert.equal((await call('GET', '/v1/traders/books/M%26M', { bearer: 'trader:a' })).body.params.stock, 'M&M')
  assert.equal((await call('GET', '/v1/traders/books/%E0%A4%A', { bearer: 'trader:a' })).status, 400)
})
test('errors map: BadRequest 400, NotFound 404, Forbidden 403, Conflict 409', async () => { /* a route throwing each → {error: message} with that status; any other throw → 500 {error:'internal error'} */ })
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test apps/traders/test/server.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** `createTradersServer` with the same order and rules as `apps/api/src/server.ts` (own code): CORS headers only for an allowed origin (methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`, headers `authorization, content-type`, max-age 600); OPTIONS answered before auth; a write carrying a non-allowed Origin → 403 `cross-origin write refused`; then `matchEndpoint` (null → 404 `no route for <METHOD> <path>`); content type: raw endpoints require `application/octet-stream`, other writes JSON or empty (415 otherwise); public endpoints get `principal: null` and no gate call; others authenticate (null → 401 `unauthorised`) and pass the kind check (`watcher` needs kind watcher; `admin` needs admin; `trader` needs trader or admin; a watcher elsewhere → 403 `a watcher token can only upload and heartbeat`). Bodies are read once and memoised; the cap counts streamed bytes. Routes are tried in order; none handling a matched endpoint → 500 `endpoint <id> has no handler`. `kit.ts` imports `Endpoint` with `import type` (no runtime cycle with `endpoints.ts`).

- [ ] **Step 4: Run to verify they pass** — Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/routes/kit.ts apps/traders/src/routes/endpoints.ts apps/traders/src/server.ts apps/traders/test/server.test.ts
git commit -m "feat(traders): HTTP server and the endpoint table every request is matched against"
```

---

### Task 3: Accounts, sessions, watcher tokens, the gate, `whose()`, the admin CLI

**Files:**
- Create: `apps/traders/src/auth/{cookies,users,sessions,tokens,gate,whose}.ts`, `apps/traders/src/routes/auth.ts`, `apps/traders/src/user-cli.ts`, `bin/traders-user.mjs`
- Create: `apps/traders/test/harness.ts`
- Test: `apps/traders/test/auth.test.ts`, `apps/traders/test/user-cli.test.ts`

**Interfaces:**
- Consumes: `TradersDb`, `sha256hex`, kit, `createTradersServer`; `hashPassword`, `verifyPassword`, `mintSession`, `isExpired`, `isLockedOut`, `recordSuccess`, `DEFAULT_LOCKOUT_POLICY`, `DEFAULT_SESSION_TTL_MS` from `@algomaker/auth`.
- Produces:
  ```ts
  // auth/cookies.ts
  export const SESSION_COOKIE = 'traders_session'
  export function cookieOf(req: IncomingMessage, name: string): string   // '' when absent OR present twice (ambiguous)
  export function bearerOf(req: IncomingMessage): string
  export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string
  export function clearedSessionCookie(secure: boolean): string
  export function isSecureRequest(req: IncomingMessage): boolean        // x-forwarded-proto https, or TLS socket
  // auth/users.ts — traders-users, same atomic-$inc lockout as apps/api/src/authstore.ts
  export const MIN_PASSWORD_LENGTH = 8
  export class DuplicateUser extends Error {}  export class InvalidUsername extends Error {}  export class WeakPassword extends Error {}
  export function normaliseUsername(raw: unknown): string
  export function assertUsername(raw: unknown): string
  export function assertPassword(raw: unknown): string
  export class TraderStore {
    constructor(db: TradersDb)
    create(username: unknown, passwordHash: string, role: Role, nowMs: number): Promise<TraderUser>
    find(username: unknown): Promise<TraderUser | null>
    list(role?: Role): Promise<TraderUser[]>                      // sorted by username
    setPassword(username: unknown, passwordHash: string): Promise<boolean>   // also clears lockout
    setDisabled(username: unknown, disabled: boolean): Promise<boolean>
    recordLoginFailure(username: unknown, nowMs: number): Promise<LoginState>
    recordLoginSuccess(username: unknown, nowMs: number): Promise<void>
    clearLoginFailures(username: unknown): Promise<void>
  }
  // auth/sessions.ts — traders-sessions stores sha256hex(token), never the token
  export class SessionStore {
    constructor(db: TradersDb)
    create(username: string, nowMs: number, ttlMs: number): Promise<{ token: string; expiresAt: number }>
    find(token: string): Promise<{ tokenHash: string; username: string; expiresAt: number; lastSeenAt: number } | null>
    revoke(token: string): Promise<void>
    revokeAll(username: string): Promise<void>
    touch(s: { tokenHash: string; lastSeenAt: number }, nowMs: number): Promise<void>   // only when ≥ 60 s stale
    purgeExpiredIfDue(nowMs: number): Promise<void>                                     // at most every 15 min, never throws
  }
  // auth/tokens.ts — traders-tokens
  export class WatcherTokens {
    constructor(db: TradersDb)
    issue(trader: string, nowMs: number): Promise<string>     // revokes the active one, returns randomBytes(32) base64url once
    revoke(trader: string, nowMs: number): Promise<boolean>   // false when none active
    active(trader: string): Promise<WatcherToken | null>
    authenticate(plain: string, nowMs: number): Promise<WatcherToken | null>   // touches lastUsedAt at most every 60 s
  }
  // auth/gate.ts
  export function createTradersGate(d: { users: TraderStore; sessions: SessionStore; tokens: WatcherTokens; now: () => number }): TradersGate
  // auth/whose.ts
  export async function whose(ctx: RouteCtx, users: TraderStore): Promise<string>
  // routes/auth.ts
  export function authRoutes(d: { users: TraderStore; sessions: SessionStore; sessionTtlMs: number; now: () => number; log: Log }): Route
  // user-cli.ts
  export async function main(argv?: readonly string[]): Promise<void>
  export function reportError(err: unknown): void
  // test/harness.ts — the route-level harness (Task 18 adds the full-app `startTraders` beside it)
  export interface HarnessDeps { db: TradersDb; users: TraderStore; sessions: SessionStore; tokens: WatcherTokens; now: () => number; log: Log }
  export interface CallOpts { cookie?: string; bearer?: string; json?: unknown; raw?: Buffer | string; contentType?: string; origin?: string; headers?: Record<string, string> }
  export interface Harness {
    readonly base: string; readonly db: TradersDb; readonly handle: MongoHandle; readonly clock: { now: number }
    readonly users: TraderStore; readonly tokens: WatcherTokens
    addUser(name: string, role?: Role): Promise<void>   // password `${name}-password`
    login(name: string): Promise<string>                 // 'traders_session=<value>' for a Cookie header
    watcherToken(name: string): Promise<string>
    call(method: string, path: string, o?: CallOpts): Promise<{ status: number; body: any; headers: Headers }>
    reset(extra?: readonly string[]): Promise<void>
    close(): Promise<void>
  }
  export async function startHarness(suite: string, routes: (d: HarnessDeps) => readonly Route[]): Promise<Harness | null>
  ```
  Gate rules: the session cookie first — hash, find, expired → delete and null; user missing or disabled → null; else `{kind: user.role, name}`. Otherwise `Authorization: Bearer` → `WatcherTokens.authenticate` → the trader must exist, be role `trader` and not disabled → `{kind: 'watcher', name: trader}`. `whose`: watcher → `Forbidden`; trader → `principal.name`; admin → `?as=` required (`BadRequest('pick a trader: ?as=<username>')`), and it must name an existing role-`trader` user (`NotFound('no trader "<as>"')`). Login: body strings required (400 `username and password are required`); at most 4 logins hashing at once (503 `too many logins in progress, try again shortly`); attempts serialised per username; unknown user verifies against a decoy hash and answers 401 `invalid credentials`; locked → 429 `{error, lockedUntil}`; wrong → count, 429 if that locked it else 401; correct but disabled → 403 `this account is disabled`; success → `Set-Cookie`, 200 `{username, role, expiresAt}`. Logout always 200 and clears the cookie. `me` → 200 `{username, role}` for a live session, else 401.
  CLI (`TRADERS_MONGO_URL` required): `create-admin <username> [--password <pw>]`, `reset <username> [--password]`, `unlock <username>`, `list` (username, role, disabled, last login; never hashes). Hidden-prompt password reading copied from `apps/api/src/user-cli.ts` (not exported there). Traders are created on the admin page, not here.

- [ ] **Step 1: Write the failing tests** (`auth.test.ts`, suite `auth`; harness routes = `[authRoutes(...)]` plus a test route on `books.list` that answers `{whose: await whose(ctx, users)}`)

```ts
test('login sets the session cookie; Secure only behind https', async () => {
  const r = await h.call('POST', '/v1/traders/auth/login', { json: { username: 'Ravi', password: 'ravi-password' } })
  assert.equal(r.status, 200); assert.deepEqual(pick(r.body, ['username', 'role']), { username: 'ravi', role: 'trader' })
  assert.match(r.headers.get('set-cookie') ?? '', /^traders_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/)
  const s = await h.call('POST', '/v1/traders/auth/login', { json: { username: 'ravi', password: 'ravi-password' }, headers: { 'x-forwarded-proto': 'https' } })
  assert.match(s.headers.get('set-cookie') ?? '', /; Secure$/)
})
test('wrong password and unknown user answer identically', async () => { /* both 401 {error:'invalid credentials'} */ })
test('five failures lock the account for 15 minutes, even against the right password', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await login('ravi', 'wrong-password')).status, 401)
  assert.equal((await login('ravi', 'wrong-password')).status, 429)
  assert.equal((await login('ravi', 'ravi-password')).status, 429)
  h.clock.now += 15 * 60_000 + 1
  assert.equal((await login('ravi', 'ravi-password')).status, 200)
})
test('a disabled trader cannot log in, and their open session dies', async () => {
  const cookie = await h.login('ravi'); await h.users.setDisabled('ravi', true)
  assert.equal((await login('ravi', 'ravi-password')).status, 403)
  assert.equal((await h.call('GET', '/v1/traders/auth/me', { cookie })).status, 401)
})
test('me, logout, expiry', async () => { /* me → {username:'ravi', role:'trader'}; after logout 401; new login, clock += TTL + 1 → 401 and the session row is gone */ })
test('two session cookies is no session', async () => { /* Cookie 'traders_session=a; traders_session=b' → me 401 */ })
test('the session token is stored hashed', async () => {
  const cookie = await h.login('ravi'); const token = decodeURIComponent(cookie.split('=')[1]!)
  const doc = await h.db.collection('traders-sessions').findOne({})
  assert.equal(JSON.stringify(doc).includes(token), false); assert.equal(doc?.['tokenHash'], sha256hex(token))
})
test('watcher tokens: hashed, one active, revocable, dead with a disabled trader', async () => {
  const t1 = await h.tokens.issue('ravi', h.clock.now); assert.match(t1, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(await gateOf(h).authenticate(bearerReq(t1)), { kind: 'watcher', name: 'ravi' })
  const t2 = await h.tokens.issue('ravi', h.clock.now)
  assert.equal(await gateOf(h).authenticate(bearerReq(t1)), null)
  await h.tokens.revoke('ravi', h.clock.now); assert.equal(await gateOf(h).authenticate(bearerReq(t2)), null)
  const t3 = await h.tokens.issue('ravi', h.clock.now); await h.users.setDisabled('ravi', true)
  assert.equal(await gateOf(h).authenticate(bearerReq(t3)), null)
})
test('whose(): a trader is always themselves; an admin must pick a trader', async () => {
  assert.equal((await h.call('GET', '/v1/traders/books?as=sita', { cookie: await h.login('ravi') })).body.whose, 'ravi')
  const admin = await h.login('boss')
  assert.equal((await h.call('GET', '/v1/traders/books', { cookie: admin })).status, 400)
  assert.equal((await h.call('GET', '/v1/traders/books?as=sita', { cookie: admin })).body.whose, 'sita')
  assert.equal((await h.call('GET', '/v1/traders/books?as=boss2', { cookie: admin })).status, 404)   // an admin is not a trader
  assert.equal((await h.call('GET', '/v1/traders/books?as=nobody', { cookie: admin })).status, 404)
})

// user-cli.test.ts (suite 'cli'; TRADERS_MONGO_URL = suiteUrl('cli'))
test('create-admin makes an admin; a short password is refused; list shows roles', async () => {
  await main(['create-admin', 'boss', '--password', 'long-enough'])
  assert.equal((await store.find('boss'))?.role, 'admin')
  await assert.rejects(main(['create-admin', 'x2', '--password', 'short']), /at least 8/)
  /* list prints a line starting 'boss' containing 'admin' (capture console.log with t.mock.method) */
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/auth.test.ts apps/traders/test/user-cli.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** the files above. `bin/traders-user.mjs` calls `main(process.argv.slice(2))` explicitly, as `bin/desk-user.mjs` does.

- [ ] **Step 4: Run to verify they pass** — Step 2 command, plus `node --test apps/traders/test/import-rule.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/auth apps/traders/src/routes/auth.ts apps/traders/src/user-cli.ts bin/traders-user.mjs apps/traders/test/harness.ts apps/traders/test/auth.test.ts apps/traders/test/user-cli.test.ts
git commit -m "feat(traders): accounts, hashed sessions and watcher tokens, whose(), admin CLI"
```

---

### Task 4: Admin — trader management, tokens, watcher status store

**Files:**
- Create: `apps/traders/src/watcher-status.ts`, `apps/traders/src/routes/admin.ts`
- Test: `apps/traders/test/admin.test.ts`

**Interfaces:**
- Consumes: Task 3 stores (admin routes name the trader in the path; the admin is the caller).
- Produces:
  ```ts
  // watcher-status.ts — traders-settings {kind:'watcher', trader, ...WatcherStatus}
  export function parseHeartbeat(body: unknown): Omit<WatcherStatus, 'lastHeartbeatAt'>  // version string ≤ 32, folder string ≤ 260, lastUploadAt number|null, fileCount integer ≥ 0; else BadRequest
  export class WatcherStatusStore {
    constructor(db: TradersDb)
    record(trader: string, hb: Omit<WatcherStatus, 'lastHeartbeatAt'>, nowMs: number): Promise<void>
    get(trader: string): Promise<WatcherStatus | null>
    all(): Promise<ReadonlyMap<string, WatcherStatus>>
  }
  // routes/admin.ts — handles admin.traders.list|add|patch, admin.token.issue|revoke
  export function adminRoutes(d: { users: TraderStore; sessions: SessionStore; tokens: WatcherTokens; status: WatcherStatusStore; now: () => number; log: Log }): Route
  ```
  Rules: list → `AdminTraderRow[]` for role `trader` only, sorted; add `{username, password}` → 201 `{username}` (409 duplicate, 400 invalid username/password); patch `{disabled?: boolean, password?: string}` on a role-`trader` user only (404 otherwise; 400 `nothing to change` when neither) — disabling or a new password revokes every session of that trader, a new password also clears the lockout; token issue → 200 `{token}`; revoke → 200 `{revoked: true}`, 404 `no active token` when none. A token never appears in any response but the issue call.

- [ ] **Step 1: Write the failing tests** (suite `admin`)

```ts
test('add a trader; duplicates and bad input refused', async () => {
  assert.deepEqual((await adminCall('POST', '/v1/traders/admin/traders', { username: 'Ravi', password: 'pass-1234' })).body, { username: 'ravi' })
  assert.equal((await adminCall('POST', '/v1/traders/admin/traders', { username: 'ravi', password: 'pass-1234' })).status, 409)
  assert.equal((await adminCall('POST', '/v1/traders/admin/traders', { username: 'x', password: 'pass-1234' })).status, 400)
  assert.equal((await adminCall('POST', '/v1/traders/admin/traders', { username: 'sita', password: 'short' })).status, 400)
})
test('the list holds traders only, with token and watcher state', async () => {
  await h.tokens.issue('ravi', h.clock.now); await status.record('ravi', { version: '1.0.0', folder: 'C:\\ODIN\\OnLineBackup', lastUploadAt: null, fileCount: 3 }, h.clock.now)
  const rows = (await adminCall('GET', '/v1/traders/admin/traders')).body
  assert.deepEqual(rows.map((r: AdminTraderRow) => r.username), ['ravi', 'sita'])
  assert.equal(rows[0].token.lastUsedAt, null); assert.equal(rows[0].watcher.fileCount, 3); assert.equal(rows[1].token, null)
})
test('disable revokes sessions; a new password revokes sessions and clears the lockout', async () => { /* PATCH {disabled:true} → ravi's cookie → me 401; PATCH {password:'new-pass-99'} after 5 failures → login with new password 200 */ })
test('patch refuses admins, unknown names and empty bodies', async () => { /* PATCH /admin/traders/boss → 404; /nobody → 404; {} → 400 */ })
test('issue shows the token once; issuing again kills the old one; revoke', async () => {
  const { token } = (await adminCall('POST', '/v1/traders/admin/traders/ravi/token')).body
  assert.equal(JSON.stringify((await adminCall('GET', '/v1/traders/admin/traders')).body).includes(token), false)
  await adminCall('POST', '/v1/traders/admin/traders/ravi/token')
  assert.equal(await h.tokens.authenticate(token, h.clock.now), null)
  assert.equal((await adminCall('DELETE', '/v1/traders/admin/traders/ravi/token')).status, 200)
  assert.equal((await adminCall('DELETE', '/v1/traders/admin/traders/ravi/token')).status, 404)
})
test('parseHeartbeat', () => { /* valid → object; {version: 5} → BadRequest; fileCount -1 → BadRequest; folder 300 chars → BadRequest */ })
```

- [ ] **Step 2: Run to verify they fail** — `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/admin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `watcher-status.ts` and `routes/admin.ts`.
- [ ] **Step 4: Run to verify they pass** — Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/watcher-status.ts apps/traders/src/routes/admin.ts apps/traders/test/admin.test.ts
git commit -m "feat(traders): admin endpoints for traders, watcher tokens and watcher status"
```

---

### Task 5: Parser registry and the three canonical CSV parsers

**Files:**
- Create: `apps/traders/src/ingest/csv.ts`, `apps/traders/src/ingest/parsers.ts`, `apps/traders/src/ingest/canonical.ts`
- Test: `apps/traders/test/parsers.test.ts`

**Interfaces:**
- Consumes: types.
- Produces: the contract's `ParsedPosition`, `ParsedFile`, `FileParser`, `ParseError`, `parserFor` in `parsers.ts`, plus
  ```ts
  export function registerParsers(list: readonly FileParser[]): void   // R1: the ODIN parsers (Tasks 8–11) then the canonical three; first match wins; called once by createApp
  export const CANONICAL_PARSERS: readonly FileParser[]                // [canonicalPositions, canonicalOrders, canonicalTrades] — parserFor uses these until registerParsers is called
  export function decodeText(body: Buffer): string                     // UTF-16LE BOM → utf16le; else UTF-8 with any BOM stripped
  export function firstLineOf(text: string): string                    // first line, '\r' trimmed
  // csv.ts
  export function splitCsvLine(line: string): string[]                 // RFC 4180 double quotes, "" escapes
  // canonical.ts
  export const CANONICAL_HEADERS: { readonly positions: string; readonly orders: string; readonly trades: string }  // the contract's exact first lines
  export const canonicalPositions: FileParser                          // id 'canonical-positions'
  export const canonicalOrders: FileParser                             // id 'canonical-orders'
  export const canonicalTrades: FileParser                             // id 'canonical-trades'
  ```
  Rules: `matches` is `firstLine === header` (path ignored). Blank lines skipped; a final line without a newline IS read (these are hand-made files). Any bad row throws `ParseError('line <n>: <reason>')` (1-based, header is line 1) and the whole file fails. `stock` upper-cased, `/^[A-Z0-9&-]{1,20}$/`. `instrument`: `option` needs ISO `expiry`, `strike` > 0 and `type` CE|PE; `future` needs ISO `expiry` and empty `strike`/`type`; `share` needs all three empty. `qty` an integer (positions: signed shares, zero allowed; orders/trades: positive). Prices finite (orders/trades ≥ 0; a position's `avg_price` may be negative — a net price can be). `side` case-insensitive → `Buy`|`Sell`. `time` ISO 8601 with an offset or `Z` (else `time "<v>" needs an ISO 8601 offset`) → ms; row `day` = `istDate(time)`; trades get `seq` = their line number; orders get `filledQty: null`, `updateTime = time`. `ParsedFile.day` = the first `YYYY-MM-DD` in the file's base name, else the latest row day, else `''`.

- [ ] **Step 1: Write the failing tests**

```ts
const P = CANONICAL_HEADERS.positions
test('parserFor picks by exact first line, BOM and CRLF tolerated', () => {
  assert.equal(parserFor('x.csv', P)?.id, 'canonical-positions')
  assert.equal(parserFor('x.csv', firstLineOf(decodeText(Buffer.from('\uFEFF' + P + '\r\nrow'))))?.id, 'canonical-positions')
  assert.equal(parserFor('x.csv', 'something,else'), null)
})
test('positions rows', () => {
  const f = canonicalPositions.parse([P, 'C1,tcs,option,2026-10-27,3500,CE,-350,41.25', '', 'C1,TCS,future,2026-10-27,,,175,3480', 'C1,TCS,share,,,,1000,3000'].join('\n'), 'positions-2026-10-19.csv')
  assert.equal(f.kind, 'positions'); assert.equal(f.day, '2026-10-19')
  assert.deepEqual(f.positions, [
    { clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE', qty: -350, avgPrice: 41.25 },
    { clientCode: 'C1', stock: 'TCS', instrument: 'future', expiry: '2026-10-27', strike: null, optType: null, qty: 175, avgPrice: 3480 },
    { clientCode: 'C1', stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null, qty: 1000, avgPrice: 3000 },
  ])
})
test('positions errors name the line', () => {
  const bad = (row: string) => () => canonicalPositions.parse(`${P}\n${row}`, 'p.csv')
  assert.throws(bad('C1,TCS,opt,2026-10-27,3500,CE,-350,40'), { name: 'ParseError', message: 'line 2: instrument "opt" must be option, future or share' })
  assert.throws(bad('C1,TCS,option,2026-10-27,3500,,-350,40'), { message: 'line 2: an option needs type CE or PE' })
  assert.throws(bad('C1,TCS,share,2026-10-27,,,10,40'), { message: 'line 2: a share has no expiry, strike or type' })
  assert.throws(bad('C1,TCS,future,2026-10-27,,,x,40'), { message: 'line 2: qty "x" is not a whole number' })
  assert.throws(bad('C1,TCS,future,2026-10-27,,,1'), { message: 'line 2: expected 8 columns, got 7' })
})
test('orders: quoted reason, side normalised, IST day from the offset time', () => {
  const f = canonicalOrders.parse([CANONICAL_HEADERS.orders,
    'O1,X1,C1,TCS,option,2026-10-27,3500,CE,BUY,175,30,Rejected,"RMS: margin, exceeded",2026-10-19T10:15:00+05:30'].join('\n'), 'orders.csv')
  const o = f.orders![0]!
  assert.equal(o.side, 'Buy'); assert.equal(o.reason, 'RMS: margin, exceeded'); assert.equal(o.filledQty, null)
  assert.equal(o.time, Date.parse('2026-10-19T04:45:00Z')); assert.equal(o.updateTime, o.time); assert.equal(o.day, '2026-10-19')
  assert.throws(() => canonicalOrders.parse(`${CANONICAL_HEADERS.orders}\nO1,X1,C1,TCS,future,2026-10-27,,,Sell,175,3500,Complete,,2026-10-19 10:15`, 'o.csv'), { message: 'line 2: time "2026-10-19 10:15" needs an ISO 8601 offset' })
})
test('trades carry their line number as seq', () => { /* two rows → seq 2 and 3; negative qty refused 'line 2: qty must be positive' */ })
test('decodeText reads UTF-16LE with a BOM', () => {
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b', 'utf16le')])), 'a,b')
})
```

- [ ] **Step 2: Run to verify they fail** — `node --test apps/traders/test/parsers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run to verify they pass** — Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/ingest/csv.ts apps/traders/src/ingest/parsers.ts apps/traders/src/ingest/canonical.ts apps/traders/test/parsers.test.ts
git commit -m "feat(traders): parser registry and the canonical positions/orders/trades CSV parsers"
```

---

### Task 6: Instrument master and leg matching (P8)

**Files:**
- Create: `apps/traders/src/market/master.ts`, `apps/traders/test/fixtures/master.ts`
- Test: `apps/traders/test/master.test.ts`

**Interfaces:**
- Consumes: `OptionMaster`, `InstrumentRow`, `INDEX_SPOT_TOKENS` from `@algomaker/instruments`; `TradersDb.desk('instrument')`.
- Produces:
  ```ts
  export interface TradersMaster { readonly options: OptionMaster; readonly cash: ReadonlyMap<string, InstrumentRow>; readonly loadedAt: number }
  export type LegContract = Pick<TraderLeg, 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType'>
  export function instrumentRowOf(doc: Record<string, unknown>): InstrumentRow   // same mapping as loadStoredInstruments (apps/marketdata/src/sync-runner.ts:290)
  export function buildTradersMaster(rows: readonly InstrumentRow[], loadedAt: number): TradersMaster   // cash = NSE EQ rows keyed by tradingsymbol
  export async function loadTradersMaster(db: TradersDb, nowMs: number): Promise<TradersMaster>
  export function matchLeg(m: TradersMaster, leg: LegContract): number | null    // option: options.resolve; future: options.future(stock, expiry); share: cash.get(stock)
  export function spotTokenOf(m: TradersMaster, stock: string): number | null    // cash.get(stock) ?? INDEX_SPOT_TOKENS[stock] ?? null
  export function lotSizeOf(m: TradersMaster, leg: LegContract): number | null   // option: chain lotSize; future: future lotSize; share: 1
  export function nearestFuture(m: TradersMaster, stock: string, today: string): ReturnType<OptionMaster['future']>  // (no type import from order-bus) the first options.expiries(stock) ≥ today with options.future(stock, e) listed
  ```
  Fixture (`test/fixtures/master.ts`) exports `OCT = '2026-10-27'`, `NOV = '2026-11-24'`, `DEC = '2026-12-29'`, `NIFTY_WK = '2026-10-20'`, `TEST_ROWS`, `testMaster()`, and tokens: `TCS_SPOT = 2953217` (NSE EQ, `name: 'TATA CONSULTANCY SERV LT'`), a BSE TCS EQ row (`134540`), `BAJFINANCE` NSE EQ `81153` (`name: 'BAJAJ FINANCE'`), `MM_SPOT = 519937` (`M&M` NSE EQ), `TCS_OCT_FUT = 1001`, `TCS_NOV_FUT = 1002`, `TCS_DEC_FUT = 1004`, `MM_OCT_FUT = 1003` (lot 350); TCS options on OCT, NOV, DEC for strikes 3000..4000 step 25 (lot 175) with `octCE(k) = 20000 + 2*((k-3000)/25)`, `octPE(k) = octCE(k) + 1`, `novCE`/`novPE` from 30000, `decCE`/`decPE` from 50000; M&M OCT options 3000..3400 step 50 (from 40000); `JINDALSTEL` (NSE EQ `JSL_SPOT = 1723649`, OCT future `1005`, OCT options 900..1160 step 20, lot 625, from 70000 — matches the ODIN fixture of Task 8); NIFTY (index spot `256265` from `INDEX_SPOT_TOKENS`, lot 65): options on `NIFTY_WK` (no future for that expiry) and on OCT (future `NIFTY_OCT_FUT = 1010`) for strikes 25000..26000 step 50 with `niftyWkCE(k) = 60000 + 2*((k-25000)/50)`, `niftyWkPE = +1`, `niftyOctCE`/`niftyOctPE` from 61000. F&O rows: `exchange 'NFO'`, segments `NFO-OPT`/`NFO-FUT`, `name` = the symbol; EQ rows `segment`/`exchange` `NSE` or `BSE`.

- [ ] **Step 1: Write the failing tests**

```ts
const m = testMaster()
test('options and futures match on (stock, expiry, strike, type)', () => {
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE' }), octCE(3500))
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3550, optType: 'CE' }), null)
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'future', expiry: NOV, strike: null, optType: null }), TCS_NOV_FUT)
  assert.equal(matchLeg(m, { stock: 'TCS', instrument: 'future', expiry: '2027-01-26', strike: null, optType: null }), null)
  assert.equal(matchLeg(m, { stock: 'NIFTY', instrument: 'option', expiry: NIFTY_WK, strike: 25500, optType: 'PE' }), niftyWkPE(25500))
})
test('shares match the NSE cash row by symbol, never by company name', () => {
  assert.equal(matchLeg(m, share('TCS')), TCS_SPOT)
  assert.equal(matchLeg(m, share('BAJFINANCE')), 81153)
  assert.equal(matchLeg(m, share('TATA CONSULTANCY SERV LT')), null)
  assert.equal(matchLeg(m, share('M&M')), MM_SPOT)
})
test('nearestFuture skips expired months and weeklies', () => {
  assert.equal(nearestFuture(m, 'TCS', '2026-10-19')?.instrumentToken, TCS_OCT_FUT); assert.equal(nearestFuture(m, 'TCS', '2026-10-28')?.instrumentToken, TCS_NOV_FUT)
  assert.equal(nearestFuture(m, 'NIFTY', '2026-10-19')?.instrumentToken, NIFTY_OCT_FUT)   // the 2026-10-20 weekly lists no future
})
test('spot for stocks and indices; lot size', () => {
  assert.equal(spotTokenOf(m, 'TCS'), TCS_SPOT); assert.equal(spotTokenOf(m, 'NIFTY'), 256265)
  assert.equal(lotSizeOf(m, { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'PE' }), 175)
  assert.equal(lotSizeOf(m, share('TCS')), 1)
})
test('instrumentRowOf reads documents exactly as loadStoredInstruments does', async () => {
  const docs = TEST_ROWS.map((r) => ({ ...r, _id: String(r.instrument_token) }))
  const theirs = await loadStoredInstruments({ find: () => ({ toArray: async () => docs }) } as never)
  assert.deepEqual(docs.map(instrumentRowOf), theirs)
})
```

- [ ] **Step 2: Run to verify they fail** — `node --test apps/traders/test/master.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `master.ts` and the fixture.
- [ ] **Step 4: Run to verify they pass** — Step 2 command and the import-rule test. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/market/master.ts apps/traders/test/fixtures/master.ts apps/traders/test/master.test.ts
git commit -m "feat(traders): instrument master view and leg matching, shares by NSE symbol (P8)"
```

---

### Task 7: The ledger — legs from trades, VolHedge's net-price rule

**Files:**
- Create: `apps/traders/src/ingest/ledger.ts`
- Test: `apps/traders/test/ledger.test.ts`

**Interfaces:**
- Consumes: `ParsedPosition` (parsers.ts), `TraderTrade`, `legKey`.
- Produces:
  ```ts
  export interface LedgerTrade extends Pick<TraderTrade, 'clientCode'|'stock'|'instrument'|'expiry'|'strike'|'optType'|'side'|'qty'|'price'|'time'|'day'|'seq'> {}
  export function ledgerTradeOf(t: TraderTrade): LedgerTrade
  export interface OpeningBalance { readonly day: string; readonly positions: readonly ParsedPosition[] }
  export function legsFromTrades(balance: OpeningBalance | null, trades: readonly LedgerTrade[]): ParsedPosition[]
  ```
  The net-price rule (matches VolHedge on 7 of 8 real legs to the paisa):
  - Trades with `day <= balance.day` are ignored (the balance already holds them). The rest are walked in file order, day by day: sorted by `(day, time, seq)` (lines in a day's file are in time order; `seq` breaks ties within a second).
  - Per `legKey`: state `q` (net signed qty) and `v` (net value), starting at the balance's `q` and `q × avgPrice`, else 0. Each trade: `q += s·qty`, `v += s·qty·price` (s = +1 Buy, −1 Sell).
  - After a key's last trade of a day, if `q === 0` then `v = 0`. Going flat intraday and reopening the same day does NOT reset.
  - `avgPrice = q !== 0 ? v / q : 0` (may be negative). Output: the balance's order, then new keys in first-trade order; zero-qty keys are kept.
  There is no mismatch check: ODIN keeps no net-position file.

- [ ] **Step 1: Write the failing tests**

```ts
const tr = (side: 'Buy' | 'Sell', qty: number, price: number, day: string, hhmm: string, seq: number, over: Partial<LedgerTrade> = {}): LedgerTrade =>
  ({ clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE', side, qty, price, day, time: Date.parse(`${day}T${hhmm}:00+05:30`), seq, ...over })
const one = (legs: ParsedPosition[]) => { assert.equal(legs.length, 1); return [legs[0]!.qty, Number(legs[0]!.avgPrice.toFixed(4))] }
test('a short carries a positive net price', () => assert.deepEqual(one(legsFromTrades(null, [tr('Sell', 175, 40, '2026-10-19', '09:20', 1)])), [-175, 40]))
test('flat at the END of a day resets the value', () => {
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 10, '2026-10-16', '10:00', 1), tr('Sell', 100, 12, '2026-10-16', '11:00', 2), tr('Buy', 100, 11, '2026-10-19', '10:00', 1)])), [100, 11])
})
test('flat intraday and reopened the same day does not reset', () => {
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 10, '2026-10-19', '10:00', 1), tr('Sell', 100, 12, '2026-10-19', '11:00', 2), tr('Buy', 100, 11, '2026-10-19', '12:00', 3)])), [100, 9])
})
test('the net price can be negative', () => {
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 5, '2026-10-19', '10:00', 1), tr('Sell', 50, 20, '2026-10-19', '10:05', 2)])), [50, -10])
})
test('file order: time, then line number', () => {
  const same = '10:00'
  assert.deepEqual(one(legsFromTrades(null, [tr('Buy', 100, 11, '2026-10-19', same, 3), tr('Sell', 100, 10, '2026-10-19', same, 2)])), [0, 0])   // flat at the day's end either way
  assert.deepEqual(one(legsFromTrades(null, [tr('Sell', 100, 12, '2026-10-16', '11:00', 2), tr('Buy', 100, 10, '2026-10-16', '10:00', 1), tr('Buy', 50, 11, '2026-10-19', '09:30', 1)])), [50, 11])
})
test('an opening balance seeds the walk; trades on or before its day are not counted again', () => {
  const balance = { day: '2026-10-16', positions: [{ clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: '2026-10-27', strike: 3500, optType: 'CE' as const, qty: -350, avgPrice: 40 }] }
  assert.deepEqual(one(legsFromTrades(balance, [tr('Sell', 999, 1, '2026-10-16', '15:00', 9), tr('Buy', 175, 30, '2026-10-19', '10:15', 1)])), [-175, 50])
})
test('two client codes on one contract stay apart', () => {
  const legs = legsFromTrades(null, [tr('Sell', 350, 40, '2026-10-19', '09:20', 1), tr('Buy', 175, 38, '2026-10-19', '09:21', 2, { clientCode: 'C2' })])
  assert.deepEqual(legs.map((l) => [l.clientCode, l.qty]), [['C1', -350], ['C2', 175]])
})
```

- [ ] **Step 2: Run to verify they fail** — `node --test apps/traders/test/ledger.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ledger.ts` (pure, no IO).
- [ ] **Step 4: Run to verify they pass** — Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/ingest/ledger.ts apps/traders/test/ledger.test.ts
git commit -m "feat(traders): ledger — legs from trades with VolHedge's net-price rule"
```

---

### Task 8: ODIN common rules and the NSE derivatives trade parser (with the JINDALSTEL golden test)

**Files:**
- Create: `apps/traders/src/ingest/odin/common.ts`, `apps/traders/src/ingest/odin/nse-fo-trades.ts`
- Create (scrubbed excerpts — see Step 1): `apps/traders/test/fixtures/odin/Nse Derivatives/Trades/{1006,1012,1013,1014,1015,1016,1019}TRD.TXT` (JINDALSTEL lines only), `…/Trades/0825TRD.TXT` (two NIFTY lines, 28-field layout), `…/Trades/0915TRD.TXT` (one HDFCBANK FUTSTK line)
- Test: `apps/traders/test/odin-nse-fo.test.ts`

**Interfaces:**
- Consumes: `ParseError`, `ParsedFile`, `istDate`, Task 7 `legsFromTrades`, `ledgerTradeOf`.
- Produces:
  ```ts
  // ingest/odin/common.ts — the rules every ODIN file shares
  export interface OdinLine { readonly lineNo: number; readonly fields: readonly string[] }
  export function odinLines(text: string): OdinLine[]   // CRLF or LF; an UNTERMINATED last line is held back (ODIN appends live); blank lines skipped; split on ',', every field trimmed
  export function odinTime(v: string): number           // 'DD MON YYYY HH:MM:SS' or 'DD Mon YY HH:MM:SS' (month any case, YY → 20YY), IST → epoch ms; else throws Error('time "<v>" is not an ODIN time')
  export function odinExpiry(v: string): string         // '27OCT2026' | '08 OCT 2026' → '2026-10-27'; else throws
  export function odinSide(v: string): 'Buy' | 'Sell'   // '1' → Buy, '2' → Sell; else throws Error('side "<v>" must be 1 (buy) or 2 (sell)')
  export function odinInt(v: string, what: string): number; export function odinNum(v: string, what: string): number
  export function atLine(n: number, fn: () => void): void   // runs fn, rethrowing any Error as ParseError('line <n>: <message>')
  // ingest/odin/nse-fo-trades.ts
  export const odinNseFoTrades: FileParser               // id 'odin-nse-fo-trades'
  ```
  Format (pinned against the sample): CSV, CRLF, no header, every field space-padded. **25 or 28 fields** (the 28-field files add `NSE OPT`/`NSE FUT` and two blanks; both layouts occur). 1-based: 1 trade no · 2 `11` · 3 instrument `OPTSTK|OPTIDX|FUTSTK|FUTIDX` · 4 symbol · 5 expiry `27OCT2026` · 6 strike `1060.00` (blank for futures) · 7 `CE|PE` (blank for futures) · 8 trading symbol (ignored — P8) · 12 user id · 14 side 1/2 · 15 qty in shares · 16 price · 18 client code · 20 `OPEN` · 22 trade time `19 OCT 2026 09:21:09` · 23 order time · 24 exchange order no · 25 `NIL`.
  `matches(path, firstLine)`: path matches `/(^|\/)nse derivatives\/trades\/\d{4}trd\.txt$/i` and the first line has 25 or 28 fields with field 2 `11` and field 3 one of the four instruments. Each row → `{tradeNo: f1, orderNo: f24, clientCode: f18, stock: f4, instrument: OPT* → option | FUT* → future, expiry, strike: option ? f6 : null, optType: option ? f7 : null, side, qty, price, time: odinTime(f22), day: istDate(time), seq: lineNo}`; `ParsedFile = {kind: 'trades', day: first row's day or '', trades}`. A wrong field count → `line <n>: expected 25 or 28 fields, got <k>`; an unknown instrument → `line <n>: instrument "<x>" is not OPTSTK, OPTIDX, FUTSTK or FUTIDX`.

- [ ] **Step 1: Build the fixtures from the sample** (unzip the sample into your scratch directory as the Global Constraints say; scrub rules there; never copy other lines; if the zip is missing, ask the coordinator — do not hand-invent these lines). From `<sample>/Nse Derivatives/Trades/`: every line whose field 4, trimmed, is `JINDALSTEL` from `1006`, `1012`–`1016` and `1019TRD.TXT` (64 + 30 + 30 + 8 + 22 + 21 + 27 = 202 lines, 25-field layout) into files of the same names; the first two NIFTY lines of `0825TRD.TXT` (28-field); one `FUTSTK` HDFCBANK line from any September file into `0915TRD.TXT`. Replace the client code (fields 18 and 19) with `C0001` and the user id (field 12) with `U0001`, keeping each field's padded width; keep CRLF. Then check: a `grep -rlE` over `apps/traders/test/fixtures` for the real client code, user id and BSE client code (kept out of the repo; the coordinator has them) prints nothing.

- [ ] **Step 2: Write the failing tests**

```ts
const DIR = 'apps/traders/test/fixtures/odin/Nse Derivatives/Trades'
const parseFile = (name: string) => odinNseFoTrades.parse(readFileSync(`${DIR}/${name}`, 'latin1'), `Nse Derivatives/Trades/${name}`)
test('the 28- and 25-field layouts parse to the same row shape', () => {
  const a = parseFile('0825TRD.TXT').trades![0]!, b = parseFile('1019TRD.TXT').trades![0]!
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort())
  assert.equal(a.stock, 'NIFTY'); assert.equal(a.instrument, 'option'); assert.equal(a.expiry, '2026-08-25'); assert.equal(a.day, '2026-08-25')
  assert.equal(b.stock, 'JINDALSTEL'); assert.equal(b.expiry, '2026-10-27'); assert.match(b.clientCode, /^C\d{4}$/)
})
test('a futures line has no strike or type', () => {
  const t = parseFile('0915TRD.TXT').trades![0]!
  assert.deepEqual([t.instrument, t.strike, t.optType], ['future', null, null])
})
test('an unterminated last line is held back', () => {
  const text = readFileSync(`${DIR}/1019TRD.TXT`, 'latin1'); const n = odinNseFoTrades.parse(text, 'Nse Derivatives/Trades/1019TRD.TXT').trades!.length
  assert.equal(odinNseFoTrades.parse(text.replace(/\r\n$/, ''), 'Nse Derivatives/Trades/1019TRD.TXT').trades!.length, n - 1)
  assert.equal(odinNseFoTrades.parse(text + text.split('\r\n')[0]!.slice(0, 40), 'Nse Derivatives/Trades/1019TRD.TXT').trades!.length, n)
})
test('JINDALSTEL net quantities and net prices match VolHedge', () => {
  const trades = ['1006', '1012', '1013', '1014', '1015', '1016', '1019'].flatMap((d) => parseFile(`${d}TRD.TXT`).trades!.map((t) => ledgerTradeOf({ ...t, trader: 'x' })))
  const legs = new Map(legsFromTrades(null, trades).map((l) => [`${l.strike} ${l.optType}`, l]))
  const want: [string, number, number][] = [['1060 CE', -10625, 11.91], ['1080 CE', 3750, 9.33], ['1100 CE', 7500, 5.46],
    ['940 PE', 1875, 5.62], ['960 PE', 5625, 4.57], ['980 PE', 5000, -13.07], ['1020 PE', -8125, 12.23]]   // VolHedge shows 980 PE at -13.08 (rounding); 1000 PE is left out — the copy appears to miss a trade
  for (const [k, q, p] of want) { assert.equal(legs.get(k)?.qty, q, k); assert.equal(Number(legs.get(k)!.avgPrice.toFixed(2)), p, k) }
  for (const k of ['1040 PE', '1120 CE', '1140 CE', '1160 CE', '900 PE']) assert.equal(legs.get(k)?.qty, 0, k)
})
test('only Nse Derivatives trade files are claimed', () => {
  const line = readFileSync(`${DIR}/1019TRD.TXT`, 'latin1').split('\r\n')[0]!
  assert.equal(odinNseFoTrades.matches('Nse Derivatives/Trades/1019TRD.TXT', line), true)
  for (const p of ['Nse Derivatives/Trades/DOCOMMiocp.log', 'Nse Derivatives/Spread/Logs/20260825112750086_CrossCurr.csv', 'MCX Derivatives/Trades/0928TRD.TXT', 'Nse Equities/Trades/0825TRD.TXT'])
    assert.equal(odinNseFoTrades.matches(p, line), false, p)
})
test('a bad line names its number', () => {
  const lines = readFileSync(`${DIR}/1019TRD.TXT`, 'latin1').split('\r\n')
  const f = lines[1]!.split(','); f[13] = '3 '
  assert.throws(() => odinNseFoTrades.parse([lines[0], f.join(','), ''].join('\r\n'), 'Nse Derivatives/Trades/1019TRD.TXT'), { message: 'line 2: side "3" must be 1 (buy) or 2 (sell)' })
})
test('odinTime reads both ODIN date styles as IST', () => {
  assert.equal(odinTime('19 OCT 2026 09:21:09'), Date.parse('2026-10-19T09:21:09+05:30'))
  assert.equal(odinTime('19 Oct 26 09:18:42  '.trim()), Date.parse('2026-10-19T09:18:42+05:30'))
})
```

- [ ] **Step 3: Run to verify they fail** — `node --test apps/traders/test/odin-nse-fo.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `common.ts` and `nse-fo-trades.ts`.
- [ ] **Step 5: Run to verify they pass** — Step 3 command. Expected: PASS, including the seven VolHedge net prices.
- [ ] **Step 6: Commit**

```bash
git add apps/traders/src/ingest/odin apps/traders/test/odin-nse-fo.test.ts "apps/traders/test/fixtures/odin/Nse Derivatives/Trades"
git commit -m "feat(traders): ODIN NSE derivatives trade parser; JINDALSTEL net prices match VolHedge"
```

---

### Task 9: ODIN NSE equities trade parser

**Files:**
- Create: `apps/traders/src/ingest/odin/nse-eq-trades.ts`, `apps/traders/test/fixtures/odin/Nse Equities/Trades/0825TRD.TXT` (the sample's BAJFINANCE sell line, scrubbed, plus one hand-made buy line in the same layout)
- Test: `apps/traders/test/odin-nse-eq.test.ts`

**Interfaces:**
- Consumes: Task 8 `common.ts`.
- Produces: `export const odinNseEqTrades: FileParser` (id `odin-nse-eq-trades`).
  Format (pinned against the sample): **26 fields**. 1 trade no · 2 `11` · 3 symbol · 4 series (`EQ`, `BE`, …) · 5 company name (ignored) · 9 exchange token (ignored) · 11 side 1/2 · 12 qty · 13 price · 15 client code · 20 trade time · 22 exchange order no · 24 `NSE Eq`. `matches`: path `/(^|\/)nse equities\/trades\/\d{4}trd\.txt$/i` and a 26-field first line with field 2 `11` and a non-empty field 4. Rows → `instrument: 'share'`, `expiry: ''`, `strike: null`, `optType: null`, `stock` = field 3, `seq` = line number.

- [ ] **Step 1: Build the fixture** as in Task 8 Step 1 (client fields 15 and 16 → `C0001`).
- [ ] **Step 2: Write the failing tests**

```ts
test('an equity trade is a share row', () => {
  const t = parse('0825TRD.TXT').trades![0]!
  assert.deepEqual(pick(t, ['stock', 'instrument', 'expiry', 'strike', 'optType', 'side', 'qty', 'price']), { stock: 'BAJFINANCE', instrument: 'share', expiry: '', strike: null, optType: null, side: 'Sell', qty: 1, price: 1083 })
  assert.equal(t.day, '2026-08-25'); assert.match(t.clientCode, /^C\d{4}$/)
})
test('shares bought and sold net into one share leg', () => { /* legsFromTrades over the fixture's buy and sell → one leg with instrument 'share' */ })
test('derivative files are not claimed', () => { /* matches('Nse Derivatives/Trades/0825TRD.TXT', <eq line>) → false; a 25-field F&O line under Nse Equities → false */ })
```

- [ ] **Step 3: Run to verify they fail** — `node --test apps/traders/test/odin-nse-eq.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `nse-eq-trades.ts`.
- [ ] **Step 5: Run to verify they pass** — Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add apps/traders/src/ingest/odin/nse-eq-trades.ts apps/traders/test/odin-nse-eq.test.ts "apps/traders/test/fixtures/odin/Nse Equities"
git commit -m "feat(traders): ODIN NSE equities trade parser — share legs"
```

---

### Task 10: ODIN NSE orders parser (derivatives and equities layouts)

**Files:**
- Create: `apps/traders/src/ingest/odin/nse-orders.ts`
- Create (scrubbed excerpts): `apps/traders/test/fixtures/odin/Nse Derivatives/Orders/NSE_25082026Ord.txt` (two lines: a status-5 line and a status-4 line whose field 18 reads 0), `…/Orders/0825ORD.TXT` (two lines: the status-3 partly traded line, then a status-1 line — both occur only in this file of the two 25 Aug files), `…/Orders/1019ORD.TXT` (three lines: exchange no `0` with blank client, status 4, status 6 — the `19 Oct 26` time style), `apps/traders/test/fixtures/odin/Nse Equities/Orders/NSE_25082026Ord.txt` (the one equities line)
- Test: `apps/traders/test/odin-nse-orders.test.ts`

**Interfaces:**
- Consumes: Task 8 `common.ts`, `sha256hex`.
- Produces: `export const odinNseOrders: FileParser` (id `odin-nse-orders`) and `export const ODIN_ORDER_STATUS: Readonly<Record<string, string>>` = `{'1': 'Open', '3': 'Partly traded', '4': 'Traded', '5': 'Cancelled', '6': 'Rejected'}`.
  Both name styles (`MMDDORD.TXT`, `NSE_DDMMYYYYOrd.txt`) hold the same columns. `matches`: path `/(^|\/)nse (derivatives|equities)\/orders\/[^/]+\.txt$/i` and a first line of 35 fields (derivatives) or 34 fields (equities).
  Derivatives layout, **35 fields**, pinned against 5,189 sample rows: 1 exchange order no (`0` before the exchange accepts) · 2 status code · 3–8 as in trades · 14 side · 17 pending qty · 18 order qty (reads 0 on some fully traded rows) · 21 filled qty · 22 price · 23 client code (blank before acceptance) · 32 last update time · 34 order entry time. Equities layout, **34 fields** (three sample rows — mark "unconfirmed" in a code comment): 1 exchange order no · 2 status · 3 symbol · 4 series · 11 side · 15 order qty · 18 filled qty · 19 price · 26 client code · 30 last update time · 33 order entry time.
  Row → `TraderOrder` minus trader: `exchOrderNo` = field 1; `orderNo` = field 1 unless it is `0`, then `'local:' + sha256hex(<fields 3–8, side, order qty, price, entry time joined by '|'>).slice(0, 16)`; `qty = max(orderQty, pending + filled)`; `filledQty = filled`; `status = "<label> (<code>)"` from `ODIN_ORDER_STATUS`, else `"code <code>"`; `reason = ''` (no column in the sample carries one — field 25 is always blank; recorded in a code comment); `time` = entry time, `updateTime` = last update time, `day = istDate(time)`. The status labels are our reading (4 = filled equals qty; 5 = cancelled with nothing filled; 3 = pending + filled = qty; 1 = open at the file's last write; 6 = rejected) — the runbook asks the trader to confirm 1 and 6.

- [ ] **Step 1: Build the fixtures** as in Task 8 Step 1 (client fields 23 and 29, user id field 12; equities client fields 26).
- [ ] **Step 2: Write the failing tests**

```ts
test('status labels and quantities', () => {
  const [cancelled, tradedZeroQty] = parse('Nse Derivatives/Orders/NSE_25082026Ord.txt').orders!
  assert.deepEqual([cancelled!.status, cancelled!.qty, cancelled!.filledQty], ['Cancelled (5)', 3200, 0])
  assert.deepEqual([tradedZeroQty!.status, tradedZeroQty!.qty, tradedZeroQty!.filledQty], ['Traded (4)', 325, 325])
  const [partly, open] = parse('Nse Derivatives/Orders/0825ORD.TXT').orders!
  assert.deepEqual([partly!.status, partly!.qty, partly!.filledQty], ['Partly traded (3)', 9600, 6400])
  assert.equal(open!.status, 'Open (1)')
})
test('both ODIN time styles; entry vs last update', () => {
  const [, traded] = parse('Nse Derivatives/Orders/1019ORD.TXT').orders!
  assert.equal(traded!.time, Date.parse('2026-10-19T09:21:00+05:30')); assert.equal(traded!.updateTime, Date.parse('2026-10-19T09:21:09+05:30'))
})
test('an order the exchange never numbered gets a stable local number', () => {
  const a = parse('Nse Derivatives/Orders/1019ORD.TXT').orders![0]!, b = parse('Nse Derivatives/Orders/1019ORD.TXT').orders![0]!
  assert.equal(a.exchOrderNo, '0'); assert.match(a.orderNo, /^local:[0-9a-f]{16}$/); assert.equal(a.orderNo, b.orderNo); assert.equal(a.clientCode, '')
})
test('code 6 reads Rejected; an unknown code is shown as itself', () => { /* third 1019 line → 'Rejected (6)'; a line with status 9 → 'code 9' */ })
test('the equities layout gives share orders', () => { /* Nse Equities/Orders/NSE_25082026Ord.txt → instrument 'share', stock 'BAJFINANCE', side 'Sell', price 1083 */ })
```

- [ ] **Step 3: Run to verify they fail** — `node --test apps/traders/test/odin-nse-orders.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `nse-orders.ts`.
- [ ] **Step 5: Run to verify they pass** — Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add apps/traders/src/ingest/odin/nse-orders.ts apps/traders/test/odin-nse-orders.test.ts "apps/traders/test/fixtures/odin/Nse Derivatives/Orders" "apps/traders/test/fixtures/odin/Nse Equities/Orders"
git commit -m "feat(traders): ODIN NSE orders parser, both layouts and both name styles"
```

---

### Task 11: ODIN BSE derivatives trade parser (low priority)

**Files:**
- Create: `apps/traders/src/ingest/odin/bse-fo-trades.ts`
- Create (scrubbed excerpts): `apps/traders/test/fixtures/odin/BSE Derivatives/Trades/0827TRD.TXT` (two buy lines and one sell line, 51 fields), `…/Trades/0924TRD.TXT` (one buy line, 48 fields, and one sell line)
- Test: `apps/traders/test/odin-bse-fo.test.ts`

**Interfaces:**
- Consumes: Task 8 `common.ts`.
- Produces: `export const odinBseFoTrades: FileParser` (id `odin-bse-fo-trades`).
  Format (SENSEX options; **48 or 51 fields**; the layout is positional and some columns move between buy and sell lines): 1 trade no · 2 trade time · 3 `11` · 6 `IO` (index option; anything else → `line <n>: BSE instrument "<x>" not understood`) · 7 symbol · 9 expiry `08 OCT 2026` · 10 strike `71500.0000` · 11 `CE|PE` · 15 price · 16 qty · order no = the first field matching `/^\d{19}$/` · client code = the field two before it.
  **Side — to confirm from the fixture and the trader's BSE Trade Book:** our reading of the sample's 4 buy and 23 sell lines is the last code before the `BSE OPT` field (or the last field when there is none): `1` Buy, `2` Sell; cross-checked by which of fields 13/14 carries the member code (13 on a buy, 14 on a sell). When the two disagree → `line <n>: side code and member-code column disagree`. A code comment records this as our reading.
  `matches`: path `/(^|\/)bse derivatives\/trades\/\d{4}trd\.txt$/i` and a first line of 48 or 51 fields with field 3 `11`.

- [ ] **Step 1: Build the fixtures** as in Task 8 Step 1 (the real BSE client code → `C0001`; field 18's 16-digit id and field 17's number → zeros of the same width).
- [ ] **Step 2: Write the failing tests**

```ts
test('buy and sell lines of both widths', () => {
  const rows = [...parse('0827TRD.TXT').trades!, ...parse('0924TRD.TXT').trades!]
  assert.deepEqual(rows.map((t) => t.side), ['Buy', 'Buy', 'Sell', 'Buy', 'Sell'])
  assert.deepEqual(pick(rows[0]!, ['stock', 'instrument', 'expiry', 'strike', 'optType', 'qty', 'price']), { stock: 'SENSEX', instrument: 'option', expiry: '2026-08-27', strike: 77000, optType: 'CE', qty: 20, price: 20.05 })
  assert.ok(rows.every((t) => /^\d{19}$/.test(t.orderNo) && /^C\d{4}$/.test(t.clientCode)))
})
test('a side code that disagrees with the member-code column is refused', () => { /* flip the trailing code on a buy line → 'line 1: side code and member-code column disagree' */ })
```

- [ ] **Step 3: Run to verify they fail** — `node --test apps/traders/test/odin-bse-fo.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `bse-fo-trades.ts`.
- [ ] **Step 5: Run to verify they pass** — Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add apps/traders/src/ingest/odin/bse-fo-trades.ts apps/traders/test/odin-bse-fo.test.ts "apps/traders/test/fixtures/odin/BSE Derivatives"
git commit -m "feat(traders): ODIN BSE derivatives trade parser (side read from the sample, to confirm)"
```

---

### Task 12: File store and the upload endpoints

**Files:**
- Create: `apps/traders/src/ingest/files.ts`, `apps/traders/src/ingest/pipeline.ts`, `apps/traders/src/routes/uploads.ts`
- Test: `apps/traders/test/files.test.ts`, `apps/traders/test/uploads.test.ts`

**Interfaces:**
- Consumes: `TradersDb`, `sha256hex`, parsers (Task 5), `WatcherStatusStore` + `parseHeartbeat` (Task 4), `TraderStore` (Task 3), harness.
- Produces:
  ```ts
  // ingest/files.ts — traders-files: StoredFile + content (gzip, base64); traders-file-versions: every new content for 7 days
  export const FILE_VERSION_MS = 7 * 24 * 60 * 60 * 1000
  export class OffsetMismatch extends Error { readonly storedSize: number }
  export function validRelPath(p: unknown): string     // BadRequest unless 1..260 chars, forward slashes, no '..'/'.'/empty segment, not absolute, no drive letter, no control chars (spaces allowed: 'DOR011026-01.0000 .TXT')
  export interface PutResult { readonly file: StoredFile; readonly changed: boolean; readonly text: string }
  export class FileStore {
    constructor(db: TradersDb, now: () => number)
    put(trader: string, up: Upload): Promise<PutResult>  // offset must equal the stored size (0 when absent) else OffsetMismatch; with an offset, content = stored + body; sha256 of the WHOLE resulting file must equal up.sha256 else BadRequest('sha256 does not match the file'); assembled > RAW_BODY_MAX → PayloadTooLarge; unchanged sha → changed false, nothing written
    setParse(trader: string, path: string, parser: string | null, parseError: string | null): Promise<void>
    list(trader: string): Promise<StoredFile[]>          // projection excludes content; newest receivedAt first
  }
  // ingest/pipeline.ts
  export interface Upload { readonly path: string; readonly mtime: number; readonly sha256: string; readonly body: Buffer; readonly offset: number | null }
  export type ApplyParsed = (trader: string, parsed: ParsedFile, file: StoredFile) => Promise<void>
  export interface IngestDeps { readonly files: FileStore; readonly apply: ApplyParsed; readonly log: Log }
  export interface IngestResult { readonly stored: true; readonly parser: string | null; readonly parseError: string | null }
  export async function ingestUpload(d: IngestDeps, trader: string, up: Upload): Promise<IngestResult>  // serialised per trader
  // routes/uploads.ts — watcher.files, watcher.heartbeat, admin.files.upload
  export function uploadRoutes(d: { ingest: IngestDeps; status: WatcherStatusStore; users: TraderStore; now: () => number; log: Log }): Route
  ```
  Pipeline: `put` → unchanged returns the stored parse status without re-parsing → `parserFor(path, firstLineOf(text))` → none: `setParse(null, null)` → `parse(text)` — always the WHOLE stored text, also after an offset append: the ODIN parsers hold back an unterminated last line and every row is de-duplicated on insert (Task 13), so only the new lines land — → `ParseError`: record `parseError`, keep everything previously applied (P7), log → any other throw: record `internal: <message>`, log loudly → success: `apply(...)`, then `setParse(id, null)`. The watcher endpoint takes the trader from the token; query `path`, `mtime` (integer ms ≥ 0), `sha256` (`/^[0-9a-f]{64}$/`), optional `offset` (integer ≥ 0); 409 `{error: 'offset'}` on `OffsetMismatch`; 200 `{stored: true, parser, parseError}`. Heartbeat: `parseHeartbeat` → `status.record` → 200 `{ok: true}`. Admin upload: `:name` must be an existing role-`trader` user (404); `mtime = now()`, `sha256` computed, `offset: null`.

- [ ] **Step 1: Write the failing tests** (suites `files`, `uploads`; for this task `apply` is a recorder `applied.push({trader, kind: parsed.kind})`)

```ts
// files.test.ts
test('validRelPath', () => {
  for (const ok of ['orders.csv', 'Nse Derivatives/Trades/1019TRD.TXT', 'BSE Derivatives/Orders/DOR011026-01.0000 .TXT']) assert.equal(validRelPath(ok), ok)
  for (const bad of ['', '../x.csv', 'a/../x', '/etc/passwd', 'C:/x.csv', 'a//b', 'a/./b', 'a\\b', 'x'.repeat(261), 'a\u0000b']) assert.throws(() => validRelPath(bad), BadRequest)
})
test('put stores latest + a version; same bytes store nothing new', async () => { /* two puts of 'abc' → one traders-file-versions row, second changed false */ })
test('offset appends; the hash is of the whole file', async () => {
  await store.put('ravi', up('Nse Derivatives/Trades/1019TRD.TXT', 'a\r\n'))
  const r = await store.put('ravi', { ...up('Nse Derivatives/Trades/1019TRD.TXT', 'b\r\n'), sha256: sha256hex('a\r\nb\r\n'), offset: 3 })
  assert.equal(r.text, 'a\r\nb\r\n'); assert.equal(r.file.size, 6)
  await assert.rejects(store.put('ravi', { ...up('Nse Derivatives/Trades/1019TRD.TXT', 'c'), sha256: sha256hex('x'), offset: 99 }), OffsetMismatch)
  await assert.rejects(store.put('ravi', { ...up('Nse Derivatives/Trades/1019TRD.TXT', 'c\r\n'), sha256: sha256hex('zzz'), offset: 6 }), BadRequest)
})
test('versions older than 7 days are pruned on the next put', async () => { /* puts at t, t+1d, t+8d → versions only the t+1d and t+8d ones */ })
test('list never carries content', async () => { /* list()[0] has no 'content' key */ })

// uploads.test.ts
test('a watcher PUT stores, parses and applies', async () => {
  const token = await h.watcherToken('ravi')
  const r = await putFile(token, 'trades.csv', TRADES)
  assert.deepEqual(r.body, { stored: true, parser: 'canonical-trades', parseError: null })
  assert.deepEqual(applied, [{ trader: 'ravi', kind: 'trades' }])
})
test('a file that does not parse reports why and applies nothing', async () => {
  const r = await putFile(token, 'positions.csv', `${CANONICAL_HEADERS.positions}\nC1,TCS,opt,2026-10-27,3500,CE,-350,40`)
  assert.equal(r.body.parseError, 'line 2: instrument "opt" must be option, future or share'); assert.deepEqual(applied, [])
})
test('a file no parser claims is stored with parser null', async () => { /* 'Nse Derivatives/Trades/DOCOMMiocp.log' → {parser: null, parseError: null} */ })
test('wrong sha256 is 400; a bad offset is 409 {error:"offset"}', async () => { /* … */ })
test('heartbeat records status; a bad body is 400', async () => { /* then status.get('ravi').fileCount === 3 and lastHeartbeatAt === h.clock.now */ })
test('admin manual upload runs the same pipeline for the named trader', async () => {
  const r = await h.call('PUT', '/v1/traders/admin/traders/ravi/files?path=trades.csv', { cookie: admin, raw: TRADES, contentType: 'application/octet-stream' })
  assert.equal(r.body.parser, 'canonical-trades'); assert.deepEqual(applied, [{ trader: 'ravi', kind: 'trades' }])
  assert.equal((await h.call('PUT', '/v1/traders/admin/traders/nobody/files?path=p.csv', { cookie: admin, raw: TRADES, contentType: 'application/octet-stream' })).status, 404)
})
test('a watcher token cannot read, a session cannot upload', async () => {
  assert.equal((await h.call('GET', '/v1/traders/files', { bearer: token })).status, 403)
  assert.equal((await h.call('PUT', '/v1/traders/files?path=a.csv&mtime=1&sha256=' + sha256hex('a'), { cookie: await h.login('ravi'), raw: 'a', contentType: 'application/octet-stream' })).status, 403)
})
```

- [ ] **Step 2: Run to verify they fail** — `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/files.test.ts apps/traders/test/uploads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files (gzip with `node:zlib` `gzipSync`/`gunzipSync`; content stored as base64 text).
- [ ] **Step 4: Run to verify they pass** — Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/ingest/files.ts apps/traders/src/ingest/pipeline.ts apps/traders/src/routes/uploads.ts apps/traders/test/files.test.ts apps/traders/test/uploads.test.ts
git commit -m "feat(traders): file store with 7-day versions, watcher PUT/offset/heartbeat, admin manual upload"
```

---

### Task 13: Applying parsed files — trades, legs, orders, log

**Files:**
- Create: `apps/traders/src/books/legs.ts`, `apps/traders/src/ingest/ledger-store.ts`, `apps/traders/src/ingest/apply.ts`
- Test: `apps/traders/test/apply.test.ts`

**Interfaces:**
- Consumes: Task 6 `matchLeg`/`TradersMaster`, Task 7 ledger, Task 12 `ApplyParsed`/`ingestUpload`/`FileStore`.
- Produces:
  ```ts
  // books/legs.ts — traders-legs
  export class LegStore {
    constructor(db: TradersDb, now: () => number)
    replaceOdin(trader: string, legs: readonly ParsedPosition[], match: (c: LegContract) => number | null): Promise<void>  // upsert by key; ODIN legs not in `legs` set to qty 0; never touches source 'manual'
    open(trader: string, stock?: string): Promise<TraderLeg[]>          // qty !== 0 (expiry not considered — callers apply isOpenLeg)
    allOpen(): Promise<TraderLeg[]>                                      // every trader, qty !== 0
    openBooks(): Promise<{ trader: string; stock: string }[]>           // distinct pairs with a leg open today (isOpenLeg), all traders
    addManual(trader: string, input: ManualLegInput, token: number | null): Promise<TraderLeg>   // key 'manual:' + randomUUID(), clientCode ''
    patchManual(trader: string, key: string, patch: { qty?: number; avgPrice?: number; note?: string }): Promise<TraderLeg>  // NotFound; Conflict for an ODIN leg
    deleteManual(trader: string, key: string): Promise<void>            // NotFound; Conflict for an ODIN leg
    version(trader: string): number                                     // in-memory counter, bumped by every write for that trader
  }
  // ingest/ledger-store.ts — traders-settings {kind:'ledger', trader, balance: OpeningBalance | null, historyFrom: string | null}
  export class LedgerStore {
    constructor(db: TradersDb)
    setBalance(trader: string, balance: OpeningBalance): Promise<void>
    odinLegs(trader: string): Promise<ParsedPosition[]>                  // legsFromTrades(balance, every stored trade of the trader)
    noteHistory(trader: string, day: string): Promise<void>              // $min into historyFrom
    historyFrom(trader: string): Promise<string | null>                  // the earliest ODIN trade file's day, null if none
  }
  // ingest/apply.ts
  export function makeApply(d: { db: TradersDb; legs: LegStore; ledger: LedgerStore; master: () => TradersMaster }): ApplyParsed
  ```
  Apply rules: trades → `updateOne({trader, day, tradeNo, orderNo}, {$setOnInsert: row}, {upsert: true})` (a re-sent or re-parsed line changes nothing); orders → keyed `{trader, day, orderNo}`, written only when the incoming `updateTime` ≥ the stored one (read, compare, write — ingest is serialised per trader, so no race); log → insert-if-new on `{trader, day, seq}`; positions (canonical only) → `ledger.setBalance(trader, {day: parsed.day || istDate(file.mtime), positions})`; a trades file from an `odin-*-trades` parser with a non-empty `day` → `ledger.noteHistory(trader, parsed.day)`; after trades or positions → `legs.replaceOdin(trader, await ledger.odinLegs(trader), (c) => matchLeg(master(), c))`.

- [ ] **Step 1: Write the failing tests** (suite `apply`; uploads go through `ingestUpload` with `makeApply`; master = `testMaster()`; the ODIN parsers registered)

```ts
test('trades become ODIN legs with the net price and a matched token', async () => {
  await upload('trades.csv', tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20']]))   // TCS 3500 CE OCT, client C1
  const [leg] = await legStore.open('ravi', 'TCS')
  assert.deepEqual([leg!.key, leg!.qty, leg!.avgPrice, leg!.token, leg!.source], ['C1|option|TCS|2026-10-27|3500|CE', -350, 40, octCE(3500), 'odin'])
})
test('an append lands only its new lines', async () => {
  const base = readFixture('Nse Derivatives/Trades/1019TRD.TXT'), lines = base.split('\r\n')
  const first = lines.slice(0, 10).join('\r\n') + '\r\n', next = lines.slice(10, 12).join('\r\n') + '\r\n'
  await uploadAs('Nse Derivatives/Trades/1019TRD.TXT', first)
  await appendAs('Nse Derivatives/Trades/1019TRD.TXT', next, Buffer.byteLength(first))
  assert.equal(await h.db.collection('traders-trades').countDocuments({ trader: 'ravi' }), 12)
  await uploadAs('Nse Derivatives/Trades/1019TRD.TXT', first + next + lines[12]!.slice(0, 30))   // a half-written line: held back
  assert.equal(await h.db.collection('traders-trades').countDocuments({ trader: 'ravi' }), 12)
})
test('the same trade number on another day or another order is another trade', async () => { /* T1/O1 on 10-16 and T1/O1 on 10-19 and T1/O2 on 10-19 → 3 rows */ })
test('a canonical positions file is an opening balance', async () => {
  await upload('positions-2026-10-16.csv', positionsCsv([['C1', 'TCS', 'option', OCT, 3500, 'CE', -350, 40]]))
  await upload('trades.csv', tradesCsv([['T0', 'O0', 'Sell', 999, 1, '2026-10-16 15:00'], ['T1', 'O1', 'Buy', 175, 30, '2026-10-19 10:15']]))
  const [leg] = await legStore.open('ravi'); assert.deepEqual([leg!.qty, leg!.avgPrice], [-175, 50])
})
test('positions and trades uploaded at once land the same in either order', async () => {
  await Promise.all([upload('trades.csv', tradesCsv([['T1', 'O1', 'Buy', 175, 30, '2026-10-19 10:15']])), upload('positions-2026-10-16.csv', positionsCsv([['C1', 'TCS', 'option', OCT, 3500, 'CE', -350, 40]]))])
  assert.equal((await legStore.open('ravi'))[0]!.qty, -175)
})
test('an ODIN upload never touches a manual leg', async () => {
  const manual = await legStore.addManual('ravi', shares('TCS', 1000, 3000), TCS_SPOT)
  await upload('trades.csv', tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20'], ['T2', 'O2', 'Buy', 350, 30, '09:30']]))
  assert.deepEqual((await legStore.open('ravi')).map((l) => l.key), [manual.key])
})
test('two client codes on one contract are two legs', async () => { /* C1 sells 350, C2 buys 175 on 3500 CE → two open legs, keys differ by client code */ })
test('an older orders file never overwrites a newer state', async () => { /* O1 'Traded (4)' updateTime 10:00, then a file with O1 'Open (1)' updateTime 09:30 → stays 'Traded (4)' */ })
test('historyFrom is the earliest ODIN trade file\'s day', async () => { /* ODIN files for 10-16 and 10-19 → '2026-10-16'; a canonical trades upload dated 2026-08-01 does not move it; none → null */ })
test('editing or deleting an ODIN leg is a Conflict', async () => { /* patchManual / deleteManual on an odin key → Conflict; unknown key → NotFound; version() increments on each write */ })
test('openBooks lists every trader\'s open (trader, stock)', async () => { /* … expired-only stock absent */ })
```

- [ ] **Step 2: Run to verify they fail** — `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/apply.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run to verify they pass** — Step 2 command plus `apps/traders/test/uploads.test.ts` and the import-rule test. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/books/legs.ts apps/traders/src/ingest/ledger-store.ts apps/traders/src/ingest/apply.ts apps/traders/test/apply.test.ts
git commit -m "feat(traders): apply parsed files — ODIN legs from trades, orders newest-wins, opening balance"
```

---

### Task 14: Books list, manual legs (4a), orders/trades/log/watcher/files

**Files:**
- Create: `apps/traders/src/books/manual.ts`, `apps/traders/src/routes/books.ts`, `apps/traders/src/routes/records.ts`
- Test: `apps/traders/test/books.test.ts`, `apps/traders/test/records.test.ts`

**Interfaces:**
- Consumes: `whose`, `LegStore`, `FileStore`, `WatcherStatusStore`, `matchLeg`, `isOpenLeg`, `istDate`.
- Produces:
  ```ts
  // books/manual.ts
  export function parseManualLeg(stock: string, body: unknown): ManualLegInput   // BadRequest with a sentence
  export function parseManualPatch(body: unknown): { qty?: number; avgPrice?: number; note?: string }
  export const STOCK_RE = /^[A-Z0-9&-]{1,20}$/
  // routes/books.ts — books.list, legs.add, legs.patch, legs.delete
  export function booksRoutes(d: { users: TraderStore; legs: LegStore; files: FileStore; master: () => TradersMaster; now: () => number; log: Log }): Route
  // routes/records.ts — orders.list, trades.list, log.list, watcher.status, files.list
  export function recordsRoutes(d: { users: TraderStore; db: TradersDb; status: WatcherStatusStore; files: FileStore; now: () => number }): Route
  ```
  Rules: `books.list` → `BookSummary[]` sorted by stock: every underlying (stock or index) with an open leg (`isOpenLeg(l, istDate(now))`), `legCount` = open legs (matched or not), `mismatch: null` (no ODIN net-position file), `lastFileAt` = newest `receivedAt` of the trader's files or null. `legs.add` (path stock upper-cased, `STOCK_RE`): option needs ISO expiry, strike > 0, CE|PE; future needs ISO expiry; share takes none; `qty` a non-zero integer with |qty| ≤ 10,000,000; `avgPrice` finite; `note` ≤ 200 chars (default `''`); a contract the master does not list → 400 `no <stock> <contractText> in the instrument master`; → 201 `TraderLeg`. `legs.patch` accepts only `qty`, `avgPrice`, `note` → 200; 409 `an ODIN leg cannot be edited; it follows the ODIN files`; 404 for a key the trader does not own. `legs.delete` → 200 `{deleted: true}`, same 409/404. `orders.list`/`trades.list` `?day=` (default today IST; not ISO → 400) and optional `?stock=`, newest first, at most 5000; `log.list` `?day=`, by `seq` ascending; `watcher.status` → `WatcherStatus | null`; `files.list` → `StoredFile[]`.

- [ ] **Step 1: Write the failing tests** (suites `books`, `records`; legs seeded through `LegStore`, records through `TradersDb` inserts; clock 2026-10-19 10:30 IST)

```ts
test('books lists every underlying with an open leg, manual-only and index books included', async () => {
  // ravi: TCS odin legs (one qty 0), INFY manual share leg, NIFTY weekly odin leg, RELIANCE legs all qty 0
  assert.deepEqual((await get('/v1/traders/books')).body, [
    { stock: 'INFY', legCount: 1, mismatch: null, lastFileAt: null }, { stock: 'NIFTY', legCount: 1, mismatch: null, lastFileAt: null },
    { stock: 'TCS', legCount: 2, mismatch: null, lastFileAt: null }])
})
test('expired legs are not counted', async () => { /* a TCS option expiring 2026-10-18 with qty left → not in legCount; a stock holding only expired legs is absent */ })
test('adding 1,000 TCS shares by hand', async () => {
  const r = await post('/v1/traders/books/TCS/legs', { instrument: 'share', qty: 1000, avgPrice: 3000 })
  assert.equal(r.status, 201); assert.match(r.body.key, /^manual:/)
  assert.deepEqual(pick(r.body, ['stock', 'instrument', 'expiry', 'strike', 'optType', 'qty', 'avgPrice', 'clientCode', 'source', 'token', 'note']),
    { stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null, qty: 1000, avgPrice: 3000, clientCode: '', source: 'manual', token: TCS_SPOT, note: '' })
})
test('a symbol with & survives the path', async () => {
  assert.equal((await post('/v1/traders/books/M%26M/legs', { instrument: 'share', qty: 50, avgPrice: 3100 })).body.stock, 'M&M')
})
test('manual leg validation', async () => {
  assert.equal((await post('/v1/traders/books/TCS/legs', { instrument: 'option', expiry: OCT, strike: 3550, optType: 'CE', qty: -175, avgPrice: 20 })).body.error, 'no TCS 3550 CE 2026-10-27 in the instrument master')
  assert.equal((await post('/v1/traders/books/TCS/legs', { instrument: 'share', qty: 0, avgPrice: 1 })).status, 400)
  assert.equal((await post('/v1/traders/books/TCS/legs', { instrument: 'share', qty: 10, avgPrice: 1, note: 'x'.repeat(201) })).status, 400)
})
test('only manual legs can be edited or deleted', async () => { /* PATCH manual {qty:500} → 200 qty 500; PATCH odin → 409 exact message; DELETE odin → 409; DELETE manual → {deleted:true}; PATCH sita's manual key as ravi → 404 */ })
test('an admin reads a trader with ?as=', async () => { /* admin GET /books?as=ravi → ravi's list; without as → 400 */ })
// records.test.ts
test('orders filter by day and stock, newest first; default day is today', async () => { /* … */ })
test('a day that is not ISO is 400', async () => { /* ?day=19-10-2026 → 400 */ })
test('log is in seq order', async () => { /* … */ })
test('watcher status is null before a heartbeat; files never carry content', async () => { /* … */ })
```

- [ ] **Step 2: Run to verify they fail** — `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/books.test.ts apps/traders/test/records.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run to verify they pass** — Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/books/manual.ts apps/traders/src/routes/books.ts apps/traders/src/routes/records.ts apps/traders/test/books.test.ts apps/traders/test/records.test.ts
git commit -m "feat(traders): books list, manual legs, orders/trades/log/watcher/files endpoints"
```

---

### Task 15: Market data — quotes and the `desk-subscriptions` declaration (item 7)

**Files:**
- Create: `apps/traders/src/market/quotes.ts`, `apps/traders/src/market/subscriptions.ts`
- Test: `apps/traders/test/feed.test.ts`, `apps/traders/test/subscriptions.test.ts`

**Interfaces:**
- Consumes: `QuoteCache` from `apps/api/src/marks.ts` (runtime-import-free); `Transport` from `@algomaker/bus`; `TradersMaster`, `matchLeg`, `spotTokenOf`, `nearestFuture`; `isOpenLeg`; `TradersDb.publishSubscription`, `TradersDb.desk('desk-marks')`.
- Produces:
  ```ts
  // market/quotes.ts
  export interface TraderQuote { readonly price: number; readonly bid: number | null; readonly ask: number | null; readonly oi: number | null; readonly volume: number | null; readonly asOf: number; readonly ageMs: number }
  export interface TradersQuotes { quote(token: number): TraderQuote | null; feedAlive(): boolean }
  export function tradersQuotes(cache: QuoteCache): TradersQuotes          // quote = cache.displayQuote (past the dead-feed gate, down to the snapshot): screens say when it is not live
  export interface FeedHealth { payload: Record<string, unknown> | null; receivedAt: number | null }
  export function attachFeed(bus: Transport, marks: QuoteCache, health: FeedHealth, now: () => number): () => void  // md.tick → marks.update(token, price, ts, {oi, volume, bid, ask, depth}); md.health → health; returns unsubscribe
  export async function seedSnapshot(db: TradersDb, marks: QuoteCache): Promise<number>   // desk-marks rows → marks.loadSnapshot, as apps/api/src/main.ts does
  // market/subscriptions.ts
  export const DECLARE_EVERY_MS = 15_000
  export const ATM_WINDOW = 15
  export function wantedTokens(legs: readonly TraderLeg[], m: TradersMaster, priceOf: (token: number) => number | null, today: string): number[]   // sorted, unique
  export interface Declarer {
    addTokenSource(name: string, fn: (nowMs: number) => readonly number[]): void   // R3's on-screen Market Watch set; a source that throws is logged and skipped
    refreshNow(): Promise<readonly number[]>                                       // build and publish now; failures logged, never thrown
    last(): { count: number; at: number | null }
    stop(): void
  }
  export function startDeclaring(d: { db: TradersDb; legs: () => Promise<readonly TraderLeg[]>; master: () => TradersMaster; priceOf: (token: number) => number | null; now: () => number; log: Log; everyMs?: number }): Declarer
  ```
  `wantedTokens` per underlying over its open legs (every trader): the spot token (`spotTokenOf` — NSE cash for a stock, the index token for NIFTY/BANKNIFTY/SENSEX); the NEAREST listed future (`nearestFuture(m, stock, today)`), held or not (R2's To Neutralize); for each expiry held by an option or future leg: that expiry's future token when the master lists one (an index weekly has none), every held leg's token (`leg.token ?? matchLeg`), and the CE and PE tokens of `ATM_WINDOW` listed strikes either side of the ATM strike (clipped at the chain's ends). ATM = `options.atmStrike(stock, expiry, ref)` with `ref` = spot price, else that expiry's future price, else the mean of the strikes held on that expiry; no ref → no window. A share-only book declares spot and the nearest future. Not the full chain (P3). Each publish is the union with every added source.

- [ ] **Step 1: Write the failing tests**

```ts
// subscriptions.test.ts — testMaster(); OCT chain 3000..4000 step 25 (41 strikes)
const price = (map: Record<number, number>) => (t: number) => map[t] ?? null
test('spot, the future, ATM ± 15 and the held strike: 64 tokens', () => {
  const tokens = wantedTokens([leg({ instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', token: octCE(3500) })], m, price({ [TCS_SPOT]: 3510 }), '2026-10-19')
  assert.equal(tokens.length, 64)
  for (const t of [TCS_SPOT, TCS_OCT_FUT, octCE(3125), octPE(3125), octCE(3875), octPE(3875)]) assert.ok(tokens.includes(t))
  assert.equal(tokens.includes(octCE(3100)), false); assert.equal(tokens.includes(octCE(3900)), false)
})
test('a held strike outside the window is added: 65', () => { /* + 3950 PE leg */ })
test('no prices yet: the window centres on the held strikes', () => { /* legs 3400 CE and 3600 PE, priceOf → null → window 3125..3875 present */ })
test('two expiries declare both futures and both windows', () => { /* OCT + NOV legs → TCS_NOV_FUT and novCE(3500) present */ })
test('the nearest future is declared even when no leg holds that month', () => { /* NOV-only legs → TCS_OCT_FUT present; a share-only book → [TCS_OCT_FUT, TCS_SPOT] */ })
test('an index weekly declares spot, its window and the nearest monthly future', () => {
  const tokens = wantedTokens([leg({ stock: 'NIFTY', instrument: 'option', expiry: NIFTY_WK, strike: 25500, optType: 'PE', token: niftyWkPE(25500) })], m, price({ 256265: 25510 }), '2026-10-19')
  assert.ok(tokens.includes(256265)); assert.ok(tokens.includes(niftyWkCE(25250))); assert.ok(tokens.includes(NIFTY_OCT_FUT))   // the weekly has no future of its own
})
test('expired legs are not declared', () => { /* OCT leg, today '2026-10-28' → [TCS_SPOT, TCS_NOV_FUT] only (spot and the then-nearest future) */ })
test('refreshNow publishes the union with added sources; a failure is logged, not thrown', async () => {
  /* fake TradersDb records publishSubscription(tokens, now); addTokenSource('mw', () => [7, 8]) → published set includes 7 and 8; a throwing source → logged, others still published; a throwing publish → log called, resolves */
})
// feed.test.ts — InProcessTransport, never the live bus
test('ticks feed the quote cache; health is stamped on arrival', () => {
  const bus = new InProcessTransport(); const marks = new QuoteCache({ now: () => 5_000 }); const health: FeedHealth = { payload: null, receivedAt: null }
  attachFeed(bus, marks, health, () => 5_000)
  bus.publish('md.tick', { token: octCE(3500), price: 45, ts: 4_000, bid: 44, ask: 46 }, 4_000)
  bus.publish('md.health', { tokens: 120 }, 4_000)
  const q = tradersQuotes(marks).quote(octCE(3500)); assert.equal(q?.price, 45); assert.equal(q?.bid, 44); assert.equal(q?.ask, 46); assert.deepEqual(health, { payload: { tokens: 120 }, receivedAt: 5_000 })
})
test('the desk-marks snapshot seeds display prices', async () => { /* fake desk('desk-marks') rows → quote(t).price set, ageMs large */ })
```

- [ ] **Step 2: Run to verify they fail** — `node --test apps/traders/test/feed.test.ts apps/traders/test/subscriptions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two files.
- [ ] **Step 4: Run to verify they pass** — Step 2 command and the import-rule test. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/market/quotes.ts apps/traders/src/market/subscriptions.ts apps/traders/test/feed.test.ts apps/traders/test/subscriptions.test.ts
git commit -m "feat(traders): quotes from the bus and the desk-subscriptions declaration (item 7)"
```

---

### Task 16: `buildMultiMonthView` — each leg on its own month (P5)

**Files:**
- Create: `packages/payoff/src/multi-month.ts`
- Modify: `packages/payoff/src/index.ts` (one export line)
- Test: `packages/payoff/test/multi-month.test.ts`

**Interfaces:**
- Consumes: `legPnl`, `legGreeks`, `DEFAULT_RATE`, `PayoffLeg` (`legs.ts`); `expiryPnlAt` (`expiry.ts`); `lognormalProbBetween` (`surface.ts`); `PayoffView` and friends (`view.ts`).
- Produces:
  ```ts
  export interface MultiMonthInputs {
    readonly legs: readonly PayoffLeg[]                  // a SHARE is { instrument: 'future', expiry: '' }
    readonly futures: Readonly<Record<string, number>>   // expiry -> the forward that month is valued off
    readonly spot: number | null
    readonly today: string                               // ISO date
    readonly realised: number
    readonly targetPnl: number | null
    readonly rate?: number
  }
  export function buildMultiMonthView(i: MultiMonthInputs): PayoffView
  ```
  The algorithm (`buildPayoffView` stays untouched; this is its multi-month sibling, same fail-soft rules, nothing NaN out):
  - Each leg's **reference** is its own month's forward (`futures[leg.expiry]`), or `spot` for a share. A leg without a positive finite reference is left out with `leg "<id>": no future price for <expiry>; left out` (shares: `no spot price; left out`).
  - **Base** `x0` = `spot` if positive and finite, else the near month's forward; neither → the empty view with warning `no spot and no future price: nothing to price`.
  - **Near date** `N` = the earliest expiry ≥ `today` among dated legs; none (shares only) → `today`. `midDate` = `today` + floor(days(today→N)/2), as `view.ts` computes it.
  - **Scan**: the same 121 ratios as `view.ts` (`m = 1 + 0.1·(k−60)/60`); point price `x0·m`; every leg priced at `ref·m`. `t0` uses `legPnl(leg, ref·m, yearFrac(today, leg.expiry))`, `mid` the same from `midDate`; `expiry` (the near-date column) uses `expiryPnlAt([leg], ref·m)` for legs expiring on `N` and `legPnl(leg, ref·m, yearFrac(N, leg.expiry))` for later ones. `yearFrac` = calendar days / 365, floored at 0 (the `view.ts` clock); a share's `t` is always 0 (`legPnl` returns 0 for a non-finite `t`). All three columns + `realised`.
  - **Summary**: `maxProfit`/`maxLoss`/`maxLossAt` over the near-date column (ties to the lower price); `breakevens` = the near-date column's zero crossings nearest below and above `x0`, linearly interpolated between rungs, null when none on the scan; `pop` = Σ over adjacent rung pairs whose mean near-date value (unshifted) ≥ 0 of `lognormalProbBetween(x0, p_i, p_{i+1}, σ, yearFrac(today, N))`, with the first/last pair's outer bound open (`null`), σ = mean IV of option legs carrying one (0.2 when none); `netCredit` = Σ over options −qty·entry; `worstShock`/`worstShockAt` = the worst `t0` at `x0·{0.9, 0.95, 1.05, 1.1}` (+ realised, ties lower); `floor` = `maxLoss`; `booked` = realised; `targetPnl` echoed.
  - **Table**: the `view.ts` candidates in its priority order (`spot` at `x0`, `BE …`, `strike K` for each option strike, `±1/2/3/5/8%`), deduped at 0.01.
  - **Greeks** = Σ `legGreeks(leg, ref, yearFrac(today, leg.expiry), rate)`.

- [ ] **Step 1: Write the failing tests**

```ts
const OCT = '2026-10-27', NOV = '2026-11-24', TODAY = '2026-10-19'
const opt = (id: string, expiry: string, qty: number, entry: number, strike = 3500, type: 'CE' | 'PE' = 'CE', iv: number | null = 0.2): PayoffLeg => ({ id, instrument: 'option', qty, strike, type, expiry, entry, iv })
const fut = (id: string, expiry: string, qty: number, entry: number): PayoffLeg => ({ id, instrument: 'future', qty, strike: null, type: null, expiry, entry, iv: null })
test('one month, no spot: identical to buildPayoffView', () => {
  const legs = [opt('c', OCT, -350, 40, 3500, 'CE', 0.22), fut('f', OCT, 175, 3480)]
  const ours = buildMultiMonthView({ legs, futures: { [OCT]: 3500 }, spot: null, today: TODAY, realised: 0, targetPnl: null })
  const desk = buildPayoffView({ legs, future: 3500, expiry: OCT, today: TODAY, realised: 0, targetPnl: null })
  assert.equal(ours.curve.length, desk.curve.length); assert.equal(ours.midDate, desk.midDate)
  ours.curve.forEach((p, i) => { for (const k of ['price', 'expiry', 't0', 'mid'] as const) assert.ok(Math.abs(p[k] - desk.curve[i]![k]) < 1e-6, `${k}@${i}`) })
  for (const g of ['delta', 'gamma', 'vega', 'theta'] as const) assert.ok(Math.abs(ours.greeks[g] - desk.greeks[g]) < 1e-9)
  const rung = 3500 * 0.1 / 60
  for (const s of ['down', 'up'] as const) { const a = ours.summary.breakevens[s], b = desk.summary.breakevens[s]; assert.ok(a === b || (a !== null && b !== null && Math.abs(a - b) <= rung)) }
})
test('a far-month future is marked off its own month', () => {
  const v = buildMultiMonthView({ legs: [fut('n', NOV, 175, 3500)], futures: { [OCT]: 3490, [NOV]: 3510 }, spot: 3480, today: TODAY, realised: 0, targetPnl: null })
  assert.equal(v.curve[60]!.price, 3480); assert.ok(Math.abs(v.curve[60]!.t0 - 1750) < 1e-9)
})
test('a calendar keeps the far leg\'s time value at the near expiry', () => {
  const v = buildMultiMonthView({ legs: [opt('o', OCT, -350, 40), opt('n', NOV, 350, 80)], futures: { [OCT]: 3500, [NOV]: 3520 }, spot: null, today: TODAY, realised: 0, targetPnl: null })
  const far = b76Price({ future: 3520, strike: 3500, t: 28 / 365, vol: 0.2, rate: DEFAULT_RATE, type: 'CE' })
  assert.ok(Math.abs(v.curve[60]!.expiry - (14000 + 350 * (far - 80))) < 1e-6)
})
test('a share leg moves with spot', () => {
  const v = buildMultiMonthView({ legs: [fut('s', '', 1000, 3000)], futures: {}, spot: 3100, today: TODAY, realised: 0, targetPnl: null })
  assert.ok(Math.abs(v.curve[60]!.t0 - 100000) < 1e-9); assert.equal(v.greeks.delta, 1000); assert.equal(v.midDate, TODAY)
})
test('a month with no forward is left out, named', () => {
  const v = buildMultiMonthView({ legs: [opt('d', '2026-12-29', -175, 30), fut('f', OCT, 175, 3480)], futures: { [OCT]: 3500 }, spot: null, today: TODAY, realised: 0, targetPnl: null })
  assert.ok(v.warnings.includes('leg "d": no future price for 2026-12-29; left out'))
})
test('nothing to price', () => { /* spot null, futures {} with a share leg → curve [] and warning 'no spot and no future price: nothing to price' */ })
test('realised shifts every column; nothing is NaN even with an IV-less option', () => { /* realised 5000 → each point +5000 vs realised 0; a leg with iv null → all numbers finite */ })
```

- [ ] **Step 2: Run to verify they fail** — `node --test packages/payoff/test/multi-month.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `multi-month.ts`; add `export { buildMultiMonthView, type MultiMonthInputs } from './multi-month.ts'` to `index.ts`.
- [ ] **Step 4: Run to verify they pass** — `node --test 'packages/payoff/test/*.test.ts'`. Expected: PASS, every existing payoff test unchanged and green.
- [ ] **Step 5: Commit**

```bash
git add packages/payoff/src/multi-month.ts packages/payoff/src/index.ts packages/payoff/test/multi-month.test.ts
git commit -m "feat(payoff): buildMultiMonthView — each leg priced off its own month's forward and tenor"
```

---

### Task 17: The book view and `GET /books/:stock`

**Files:**
- Create: `apps/traders/src/analytics/month-chain.ts`, `apps/traders/src/analytics/book-view.ts`, `apps/traders/src/analytics/payoff-cache.ts`, `apps/traders/src/routes/book-view.ts`
- Test: `apps/traders/test/book-view.test.ts`, `apps/traders/test/book-view-route.test.ts`

**Interfaces:**
- Consumes: `buildMultiMonthView`; `solveChainIvs`, `ivFor`, `legGreeks`, `DEFAULT_RATE`, `DEFAULT_REPAIR_DIALS` from `@algomaker/payoff`; `yearsToExpiry` from `@algomaker/greeks`; `isMarketOpen`, `fixedClock` from `@algomaker/core`; `TradersQuotes` (Task 15); Tasks 6, 13, 14 stores.
- Produces:
  ```ts
  // analytics/month-chain.ts
  export type ForwardSource = 'future' | 'parity' | 'carry'
  export function forwardFor(m: TradersMaster, q: TradersQuotes, stock: string, expiry: string, spot: number | null, asOf: number): { price: number; source: ForwardSource } | null
  export interface MonthQuotes { readonly expiry: string; readonly future: number | null; readonly forward: number | null; readonly source: ForwardSource | null; readonly quotes: readonly ChainQuoteLite[]; readonly ivs: readonly SolvedIv[]; readonly tYears: number }
  export function monthQuotes(m: TradersMaster, q: TradersQuotes, stock: string, expiry: string, spot: number | null, asOf: number, closed: boolean): MonthQuotes
  // analytics/book-view.ts
  export const WATCHER_OFFLINE_MS = 180_000
  export interface BookViewInputs {
    readonly stock: string; readonly legs: readonly TraderLeg[]; readonly master: TradersMaster; readonly quotes: TradersQuotes; readonly asOf: number
    readonly watcher: WatcherStatus | null; readonly files: readonly StoredFile[]; readonly historyFrom: string | null
    readonly payoff: (i: MultiMonthInputs) => PayoffView | null
  }
  export function bookView(i: BookViewInputs): BookView                                    // pure
  export interface BookViewDeps { legs: LegStore; ledger: LedgerStore; files: FileStore; status: WatcherStatusStore; master: () => TradersMaster; quotes: TradersQuotes; payoffCache: PayoffCache }
  export async function buildBookView(d: BookViewDeps, trader: string, stock: string, nowMs: number, opts?: { keys?: ReadonlySet<string> }): Promise<BookView | null>   // null = no open legs; keys restricts to a subset (R3 groups)
  // analytics/payoff-cache.ts
  export const PAYOFF_TTL_MS = 60_000
  export class PayoffCache { constructor(now: () => number); get(key: string, build: () => PayoffView | null): PayoffView | null }
  // routes/book-view.ts — books.view
  export function bookViewRoutes(d: { users: TraderStore; bookView: (trader: string, stock: string, nowMs: number) => Promise<BookView | null>; now: () => number }): Route
  ```
  Rules:
  - `closed = !isMarketOpen(fixedClock(asOf))`; `today = istDate(asOf)`; every price is `quotes.quote(token)?.price` (the display path — the screen says when it is not live).
  - `forwardFor`: the expiry's own future (`options.future(stock, expiry)`) when listed and quoted → `future`; else put-call parity at the listed strike nearest the reference — spot, else the nearest listed future's price, else the chain's middle strike — where both CE and PE are quoted: `K + (C − P)·e^{r·t}` with `r = DEFAULT_RATE`, `t = yearsToExpiry` → `parity`; else `spot·e^{r·t}` → `carry`; else null. An index weekly is normally `parity`. Callable for ANY listed (underlying, expiry), held or not (R3's Market Watch and repair use it).
  - `monthQuotes`: every listed strike's CE/PE quote on that expiry (returned as `quotes: ChainQuoteLite[]` — the exact input of the solve); `future` = that expiry's future mark or null; `forward` from `forwardFor`; `tYears = yearsToExpiry(expiry, asOf)`; `ivs = solveChainIvs(quotes, forward, tYears, DEFAULT_RATE, {maxAgeMs: closed ? 4 days : DEFAULT_REPAIR_DIALS.maxQuoteAgeMs})` (empty when no forward). Each month is solved against ITS OWN forward.
  - Legs not `isOpenLeg(l, today)` are dropped; when any were, warning `<n> expired leg(s) hidden — options that expired, or were settled into shares, need a manual share leg if delivered`.
  - Per leg: `token = leg.token ?? matchLeg`; unmatched → `matched: false`, `ltp`/`iv`/`mtm` null, zero greeks, and an `unmatched` line `not understood: <stock> <contractText> (client <clientCode or 'manual'>) — no such contract in the instrument master`. Matched: `ltp = quote(token)?.price ?? null`; option `iv = ivFor(month.ivs, strike, optType)`, greeks = `legGreeks(payoffLeg, month.forward, month.tYears)` when both exist, else zeros; future and share: `delta = qty`, other greeks 0; `mtm = (ltp − avgPrice) × qty` or null; `lotSize = lotSizeOf`.
  - Leg order: by expiry ascending (shares last), then futures before options, then strike, then CE before PE, then key.
  - `totals` = sums over matched legs (mtm over non-null). `futures[e]` = the future mark or null; `forwards[e]` = the forward or null. `mismatch: null`. `historyFrom` passed through. `payoff` = `i.payoff({legs: priceable matched legs as PayoffLeg — share → {instrument:'future', expiry:''} — , futures: non-null forwards, spot, today, realised: 0, targetPnl: null})`, null when no leg is priceable.
  - `warnings`, in this order: (1) `!closed && !quotes.feedAlive()` → `the price feed is not ticking: every price below is the last one seen, not a live one`; (2) watcher null → `no watcher has reported for this trader yet — positions come only from manual uploads`, or older than `WATCHER_OFFLINE_MS` → `the watcher has not reported since <HH:MM> — positions may be out of date`; (3) each file with a `parseError` → `<path> did not parse at <HH:MM>: <parseError> — showing the last good one`; (4) spot null → `no spot price for <stock> yet`; (5) each month with no forward → `no price for <expiry> yet — that month's legs are not priced`, and each month on `carry` → `<expiry> is valued off spot carried to expiry — no future and no two-sided quote at the money`; (6) each matched option with a forward but no iv → `<contractText>: no vol solved from the <expiry> chain — left out of the greeks`; (7) the expired line.
  - `buildBookView`: `legs.open(trader, stock)` filtered by `opts.keys`; none open → null; payoff through `payoffCache.get(`${trader}|${stock}|${legs.version(trader)}|${keys ? [...keys].sort().join(',') : '*'}`, …)` — at most one rebuild per 60 s per book, immediately on any leg write (P13). Route: stock upper-cased and `STOCK_RE`-checked (400); `whose`; null → 404 `no open book <stock>`.

- [ ] **Step 1: Write the failing tests** (`book-view.test.ts` pure: `testMaster()`, a fake `TradersQuotes`, `asOf = Date.UTC(2026, 9, 19, 5, 0)` = Mon 10:30 IST; quotes: spot 3490, OCT fut 3500, NOV fut 3520, OCT 3400/3500/3600 CE+PE and NOV 3500 CE quoted; NIFTY spot 25510, NIFTY_WK 25500 CE 120 and PE 105)

```ts
const book = [odinCE(OCT, 3500, -350, 40), odinFut(OCT, 175, 3480), odinFut(NOV, 175, 3500), manualShares(1000, 3000)]
test('legs carry LTP, IV off their own month, position greeks and MTM', () => {
  const v = bookView(inputs(book))
  assert.deepEqual(v.legs.map((l) => l.key), [book[1]!.key, book[0]!.key, book[2]!.key, book[3]!.key])
  const ce = v.legs[1]!
  assert.ok(Math.abs(ce.iv! - b76ImpliedVol(45, { future: 3500, strike: 3500, t: yearsToExpiry(OCT, asOf), rate: DEFAULT_RATE, type: 'CE' })!) < 1e-6)
  assert.equal(v.legs[0]!.mtm, (3500 - 3480) * 175); assert.equal(v.legs[2]!.mtm, (3520 - 3500) * 175)
  assert.equal(v.legs[3]!.delta, 1000); assert.equal(v.legs[3]!.mtm, (3490 - 3000) * 1000)
  assert.deepEqual(v.futures, { [OCT]: 3500, [NOV]: 3520 }); assert.deepEqual(v.forwards, { [OCT]: 3500, [NOV]: 3520 }); assert.equal(v.spot, 3490)
  assert.ok(Math.abs(v.totals.delta - (175 + 175 + 1000 + ce.delta)) < 1e-9); assert.ok(v.payoff !== null && v.payoff.curve.length > 0)
  assert.equal(v.mismatch, null)
})
test('a far-month option is solved against the far month', () => { /* NOV 3500 CE quoted 70 → iv equals b76ImpliedVol(70, {future: 3520, …t: yearsToExpiry(NOV, asOf)}) */ })
test('a weekly with no future is valued off the parity forward', () => {
  const v = bookView(inputs([odinOpt('NIFTY', NIFTY_WK, 25500, 'PE', -65, 110)], { stock: 'NIFTY' }))
  const t = yearsToExpiry(NIFTY_WK, asOf), fwd = 25500 + (120 - 105) * Math.exp(DEFAULT_RATE * t)
  assert.equal(v.futures[NIFTY_WK], null); assert.ok(Math.abs(v.forwards[NIFTY_WK]! - fwd) < 1e-9)
  assert.ok(v.legs[0]!.iv !== null); assert.equal(v.warnings.some((w) => w.includes('carried to expiry')), false)
})
test('1,000 manual shares move delta by exactly 1,000', () => {
  assert.ok(Math.abs(bookView(inputs(book)).totals.delta - bookView(inputs(book.slice(0, 3))).totals.delta - 1000) < 1e-9)
})
test('an unmatched row is listed and kept out of the numbers', () => {
  const v = bookView(inputs([...book, odinCE(OCT, 3550, -175, 10)]))
  assert.deepEqual(v.unmatched, ['not understood: TCS 3550 CE 2026-10-27 (client C1) — no such contract in the instrument master'])
  assert.equal(v.legs.find((l) => l.strike === 3550)!.matched, false); assert.deepEqual(v.totals, bookView(inputs(book)).totals)
})
test('a dead feed in session says so first; a closed market does not', () => {
  assert.equal(bookView(inputs(book, { feedAlive: false })).warnings[0], 'the price feed is not ticking: every price below is the last one seen, not a live one')
  const sunday = bookView(inputs(book, { feedAlive: false, asOf: Date.UTC(2026, 9, 18, 5, 0) }))
  assert.equal(sunday.closed, true); assert.equal(sunday.warnings.some((w) => w.startsWith('the price feed')), false)
})
test('watcher offline and a file that did not parse are named', () => {
  const v = bookView(inputs(book, { watcher: { lastHeartbeatAt: asOf - 240_000, lastUploadAt: null, version: '1', folder: 'C:\\ODIN\\OnLineBackup', fileCount: 2 },
    files: [storedFile('Nse Derivatives/Trades/1019TRD.TXT', { parseError: 'line 2: side "3" must be 1 (buy) or 2 (sell)', receivedAt: asOf - 60_000 })] }))
  assert.ok(v.warnings.includes('the watcher has not reported since 10:26 — positions may be out of date'))
  assert.ok(v.warnings.includes('Nse Derivatives/Trades/1019TRD.TXT did not parse at 10:29: line 2: side "3" must be 1 (buy) or 2 (sell) — showing the last good one'))
})
test('expired legs are hidden with a warning', () => { /* + odinCE('2026-10-18', 3500, -175, …) → not in legs; warning starts '1 expired leg(s) hidden' */ })
test('historyFrom passes through', () => { /* inputs({historyFrom: '2026-08-25'}) → v.historyFrom === '2026-08-25' */ })
// book-view-route.test.ts (suite 'book_view')
test('GET /books/TCS answers a BookView; another trader\'s stock is 404', async () => { /* … */ })
test('GET /books/M%26M works', async () => { /* manual M&M shares → 200, stock 'M&M' */ })
test('the payoff is rebuilt at most once a minute, and at once on a leg write', async () => {
  const a = (await get('/v1/traders/books/TCS')).body.payoff; quotes.set(TCS_OCT_FUT, 3600); h.clock.now += 10_000
  assert.deepEqual((await get('/v1/traders/books/TCS')).body.payoff, a)
  await post('/v1/traders/books/TCS/legs', { instrument: 'share', qty: 10, avgPrice: 3000 })
  assert.notDeepEqual((await get('/v1/traders/books/TCS')).body.payoff, a)
})
test('buildBookView with keys builds a view of that subset only', async () => { /* keys = {manual key} → legs.length 1, cache key distinct from the whole book's */ })
```

- [ ] **Step 2: Run to verify they fail** — `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/book-view.test.ts apps/traders/test/book-view-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four files.
- [ ] **Step 4: Run to verify they pass** — Step 2 command and the import-rule test. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/analytics apps/traders/src/routes/book-view.ts apps/traders/test/book-view.test.ts apps/traders/test/book-view-route.test.ts
git commit -m "feat(traders): book view — legs, per-month forward and IV, greeks, MTM, multi-month payoff, warnings"
```

---

### Task 18: Boot — `TradersDeps`, config, `createApp`, health, `main`, pm2 entry, `startTraders`

**Files:**
- Create: `apps/traders/src/deps.ts`, `apps/traders/src/config.ts`, `apps/traders/src/app.ts`, `apps/traders/src/routes/health.ts`, `apps/traders/src/main.ts`, `bin/desk-traders.mjs`
- Modify: `ecosystem.desk.config.cjs` (one new app entry), `apps/traders/test/harness.ts` (add `startTraders`)
- Test: `apps/traders/test/app.test.ts`, `apps/traders/test/ecosystem.test.ts`

**Interfaces:**
- Consumes: everything above; `connectMongo`; `connectWithRetry`, `installCrashGuards` from `@algomaker/core`; `WsTransportClient` (main only).
- Produces:
  ```ts
  // deps.ts — the one bag every route factory may take (R1's take Pick<TradersDeps, …>)
  export interface TradersDeps {
    readonly db: TradersDb; readonly users: TraderStore; readonly sessions: SessionStore; readonly tokens: WatcherTokens
    readonly status: WatcherStatusStore; readonly files: FileStore; readonly legs: LegStore; readonly ledger: LedgerStore
    readonly ingest: IngestDeps; readonly master: () => TradersMaster; readonly quotes: TradersQuotes; readonly subscriptions: Declarer
    readonly payoffCache: PayoffCache
    readonly bookView: (trader: string, stock: string, nowMs: number, opts?: { keys?: ReadonlySet<string> }) => Promise<BookView | null>
    readonly feed: FeedHealth; readonly busConnected: () => boolean | null
    readonly config: TradersConfig; readonly log: Log; now(): number
  }
  // config.ts
  export interface TradersConfig { readonly port: number; readonly mongoUrl: string; readonly busUrl: string; readonly origins: readonly string[]; readonly sessionTtlMs: number }
  export function configFromEnv(env?: NodeJS.ProcessEnv): TradersConfig  // TRADERS_MONGO_URL required ('TRADERS_MONGO_URL is required'); TRADERS_PORT default 8794; DESK_BUS_URL default ws://127.0.0.1:8791; TRADERS_ORIGINS comma list, trimmed, empties dropped; TRADERS_SESSION_TTL_MS positive else DEFAULT_SESSION_TTL_MS
  // app.ts — the ONE composition point (main, the harness and the safety walk all use it)
  export interface AppDeps { readonly db: TradersDb; readonly bus: Transport | null; readonly config: TradersConfig; readonly now: () => number; readonly log: Log; readonly master?: TradersMaster; readonly quotes?: TradersQuotes; readonly declare?: boolean; readonly override?: Partial<TradersDeps> }
  export interface App { readonly server: Server; readonly deps: TradersDeps; readonly routes: readonly Route[]; start(): Promise<void>; stop(): Promise<void> }
  export async function createApp(d: AppDeps): Promise<App>
  // routes/health.ts — health
  export function healthRoutes(d: Pick<TradersDeps, 'quotes' | 'master' | 'busConnected' | 'subscriptions'>): Route
  // main.ts
  export async function main(): Promise<void>
  // test/harness.ts (added)
  export interface TradersHarness {
    readonly url: string; readonly db: TradersDb; readonly deps: TradersDeps; readonly clock: { now: number }
    addUser(name: string, role?: Role): Promise<void>; token(name: string): Promise<string>
    as(user: string): (path: string, init?: RequestInit) => Promise<Response>   // logs in once, sends the cookie (an admin adds ?as= itself)
    close(): Promise<void>
  }
  export async function startTraders(o: { suite: string; master?: TradersMaster; quotes?: TradersQuotes; now?: () => number; deps?: Partial<TradersDeps> }): Promise<TradersHarness | null>
  ```
  `createApp`: `registerParsers([odinNseFoTrades, odinNseEqTrades, odinNseOrders, odinBseFoTrades, ...CANONICAL_PARSERS])` (those that exist); every store from `d.db`; `QuoteCache({feedDeadAfterMs: 120_000, staleAfterMs: 60_000, now})` wrapped by `tradersQuotes` as `deps.quotes` unless `d.quotes` is given; the gate; `bookView` bound over `buildBookView`; `override` replaces any member; routes `[healthRoutes, authRoutes, adminRoutes, uploadRoutes, booksRoutes, bookViewRoutes, recordsRoutes]` into `createTradersServer` (R2/R3 append theirs here). `start()`: `ensureIndexes`; the master (injected, else `loadTradersMaster`, refreshed every 15 min, a failed refresh keeps the old one) — loaded before `start()` resolves, so `deps.master()` never returns null; `seedSnapshot` and `attachFeed` (when a bus is given) on the built `QuoteCache` — skipped when `d.quotes` was injected; `startDeclaring` unless `declare === false` (the `Declarer` exists either way). `health` → `{ok: true, feedAlive, busConnected, masterLoadedAt, masterContracts, declaredTokens, declaredAt}`. `main()`: `installCrashGuards` first, `configFromEnv`, `connectWithRetry(connectMongo)` with a stoppable boot, `WsTransportClient({url})` not awaited, `createApp`, `start`, `server.listen(config.port, '127.0.0.1')`, SIGTERM/SIGINT → stop, close server, close Mongo. `bin/desk-traders.mjs` calls `main()` explicitly (pm2 wrapper rule, as `bin/desk-runner.mjs`).
  Ecosystem entry — its env is REPLACED, not merged with `base`, so the internet-facing process never holds the desk's secrets:
  ```js
  app('desk-traders', 'bin/desk-traders.mjs', {}, {
    env: {
      NODE_ENV: 'production',
      TRADERS_PORT: secrets.TRADERS_PORT ?? '8794',
      TRADERS_MONGO_URL: secrets.TRADERS_MONGO_URL ?? base.DESK_MONGO_URL,
      DESK_BUS_URL: base.DESK_BUS_URL,
      TRADERS_ORIGINS: secrets.TRADERS_ORIGINS ?? '',
      ...(secrets.TRADERS_SESSION_TTL_MS === undefined ? {} : { TRADERS_SESSION_TTL_MS: secrets.TRADERS_SESSION_TTL_MS }),
    },
  }),
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// app.test.ts (suite 'app'; startTraders with testMaster(), a fake TradersQuotes, InProcessTransport, declare: false)
test('configFromEnv', () => {
  assert.throws(() => configFromEnv({}), /TRADERS_MONGO_URL is required/)
  const c = configFromEnv({ TRADERS_MONGO_URL: 'mongodb://x/y', TRADERS_ORIGINS: ' http://a , ,http://b', TRADERS_SESSION_TTL_MS: 'abc' })
  assert.deepEqual([c.port, c.busUrl, c.origins, c.sessionTtlMs], [8794, 'ws://127.0.0.1:8791', ['http://a', 'http://b'], DEFAULT_SESSION_TTL_MS])
})
test('health answers without a login', async () => { /* GET /v1/traders/health → 200 {ok:true, …} */ })
test('every endpoint in the table has a handler', async () => {
  for (const e of ENDPOINTS) {
    const r = await callAs(e)            // admin cookie for admin/trader (with ?as=ravi), ravi's token for watcher, nothing for public
    assert.equal(/has no handler/.test(String(r.body?.error ?? '')), false, e.id)
  }
})
test('an ODIN trade file uploaded by the watcher shows on the book', async () => {
  /* ravi's token PUTs the fixture 'Nse Derivatives/Trades/1019TRD.TXT' → GET /v1/traders/books lists JINDALSTEL; GET /books/JINDALSTEL legs are matched (JINDALSTEL is in the Task 6 master fixture) */
})
// ecosystem.test.ts
test('desk-traders runs bin/desk-traders.mjs with its own env and none of the desk secrets', () => {
  const eco = createRequire(import.meta.url)('../../../ecosystem.desk.config.cjs')
  const app = eco.apps.find((a: { name: string }) => a.name === 'desk-traders')
  assert.equal(app.script, 'bin/desk-traders.mjs')
  assert.deepEqual(Object.keys(app.env).filter((k) => !['NODE_ENV', 'TRADERS_PORT', 'TRADERS_MONGO_URL', 'DESK_BUS_URL', 'TRADERS_ORIGINS', 'TRADERS_SESSION_TTL_MS'].includes(k)), [])
  for (const secret of ['DESK_API_TOKEN', 'DESK_MASTER_KEY', 'DESK_BROKER']) assert.equal(app.env[secret], undefined)
})
```

- [ ] **Step 2: Run to verify they fail** — `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/app.test.ts apps/traders/test/ecosystem.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files, the harness addition and the ecosystem entry (after `desk-supervisor`). Do NOT start or restart anything — starting `desk-traders` is the operator's (Task 24 runbook).
- [ ] **Step 4: Run to verify they pass** — Step 2 command, then `DESK_REQUIRE_MONGO=1 npm run test:node` and `npx tsc -p tsconfig.json`. Expected: PASS, whole node suite green.
- [ ] **Step 5: Commit**

```bash
git add apps/traders/src/deps.ts apps/traders/src/config.ts apps/traders/src/app.ts apps/traders/src/routes/health.ts apps/traders/src/main.ts bin/desk-traders.mjs ecosystem.desk.config.cjs apps/traders/test/harness.ts apps/traders/test/app.test.ts apps/traders/test/ecosystem.test.ts
git commit -m "feat(traders): boot, TradersDeps, createApp, health, startTraders, desk-traders pm2 entry (operator starts it)"
```

---

### Task 19: Safety walk — ownership over every endpoint, and a single writer (item 2, P16)

**Files:**
- Create: `apps/traders/test/ownership-cases.ts`
- Test: `apps/traders/test/ownership.test.ts`, `apps/traders/test/single-writer.test.ts`

**Interfaces:**
- Consumes: `startTraders`, `ENDPOINTS`, `walkRuntimeImports`/`listSources`.
- Produces: `ownership-cases.ts` exports `interface Walk { asA(method, path, body?); asAdmin(…); tokenA: string; b: { stocks: string[]; manualKey: string; day: string; legKeys(): Promise<string[]>; files(): Promise<string[]> } }`, `type Case = (w: Walk) => Promise<void>`, and `CASES: Record<string, Case>` — one entry per endpoint id. R2/R3 add their endpoints' cases to this file; a new endpoint without one fails the suite. A market-data endpoint's case asserts the response carries no `trader`, `legs` or `key` field.

- [ ] **Step 1: Write the tests** (suite `ownership`; `startTraders` with `declare: false`; setup also calls `db.publishSubscription([TCS_SPOT], now)` so the traders declaration document exists; the raw driver via `createRequire(import.meta.url)('mongodb')` for `listCollections`)

Setup: traders `ravi` (A) and `sita` (B), admin `boss`. B's watcher token PUTs the fixtures `Nse Derivatives/Trades/1019TRD.TXT` (JINDALSTEL legs) and `Nse Derivatives/Orders/1019ORD.TXT` (orders on 2026-10-19) and sends a heartbeat; B also holds a manual `M&M` share leg. A holds a manual TCS share leg only. Seed sentinel desk documents: `desk-books-registry` `{_id: 'sentinel', v: 1}`, `desk-subscriptions` `{source: 'hosted-runner', tokens: [1], updatedAt: 1}`, `instrument` = `TEST_ROWS`, `desk-marks` two rows. Snapshot every desk document.

```ts
// ownership-cases.ts (excerpt — every id gets one)
export const CASES: Record<string, Case> = {
  'books.list':   async (w) => { assert.deepEqual((await w.asA('GET', '/v1/traders/books?as=sita')).body.map((b: BookSummary) => b.stock), ['TCS']) },
  'books.view':   async (w) => { assert.equal((await w.asA('GET', '/v1/traders/books/JINDALSTEL?as=sita')).status, 404) },
  'legs.add':     async (w) => { const before = await w.b.legKeys(); await w.asA('POST', '/v1/traders/books/M%26M/legs?as=sita', { instrument: 'share', qty: 1, avgPrice: 1 }); assert.deepEqual(await w.b.legKeys(), before) },
  'legs.patch':   async (w) => { assert.equal((await w.asA('PATCH', `/v1/traders/legs/${encodeURIComponent(w.b.manualKey)}?as=sita`, { qty: 5 })).status, 404) },
  'legs.delete':  async (w) => { assert.equal((await w.asA('DELETE', `/v1/traders/legs/${encodeURIComponent(w.b.manualKey)}?as=sita`)).status, 404) },
  'orders.list':  async (w) => { assert.deepEqual((await w.asA('GET', `/v1/traders/orders?day=${w.b.day}&as=sita`)).body, []) },
  'trades.list':  async (w) => { assert.deepEqual((await w.asA('GET', `/v1/traders/trades?day=${w.b.day}&as=sita`)).body, []) },
  'log.list':     async (w) => { assert.deepEqual((await w.asA('GET', `/v1/traders/log?day=${w.b.day}&as=sita`)).body, []) },
  'watcher.status': async (w) => { assert.equal((await w.asA('GET', '/v1/traders/watcher?as=sita')).body, null) },
  'files.list':   async (w) => { assert.deepEqual((await w.asA('GET', '/v1/traders/files?as=sita')).body, []) },
  'watcher.files': async (w) => { /* A's token PUTs a trades file → lands in ravi's account; sita's legs and files unchanged; A's session → 403 */ },
  'watcher.heartbeat': async (w) => { /* A's token → only ravi's status changes */ },
  // every admin.* id: as A → 403;  health, auth.*: never name sita (me → {username:'ravi', role:'trader'})
}
// ownership.test.ts
test('every endpoint has an ownership case', () => { for (const e of ENDPOINTS) assert.ok(e.id in CASES, `endpoint ${e.id} has no ownership case — add one to test/ownership-cases.ts`) })
for (const e of ENDPOINTS) test(`ownership: ${e.id}`, async (t) => { if (!ready) return skipUnlessMongo(t); await CASES[e.id]!(walk) })
test('after the walk, no desk collection changed', async () => {
  const names = (await rawDb.listCollections().toArray()).map((c: { name: string }) => c.name)
  assert.deepEqual(names.filter((n: string) => !TRADERS_COLLECTIONS.includes(n as never) && !['desk-books-registry', 'desk-subscriptions', 'instrument', 'desk-marks'].includes(n)), [])
  assert.deepEqual(await snapshotDesk({ ignore: { 'desk-subscriptions': { source: 'traders' } } }), deskBefore)
})
// single-writer.test.ts (no Mongo)
test('only db.ts, main.ts and user-cli.ts reach the Mongo adapter', () => {
  const touching = listSources('apps/traders/src').filter((f) => /api\/src\/(mongo|store)\.ts['"]/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(touching.sort(), ['apps/traders/src/db.ts', 'apps/traders/src/main.ts', 'apps/traders/src/user-cli.ts'])
})
```

- [ ] **Step 2: Run** — `DESK_REQUIRE_MONGO=1 node --test apps/traders/test/ownership.test.ts apps/traders/test/single-writer.test.ts`. Expected: PASS. If any case fails, the defect is in the route it names — fix that route (through `whose`), never the case.
- [ ] **Step 3: Commit**

```bash
git add apps/traders/test/ownership-cases.ts apps/traders/test/ownership.test.ts apps/traders/test/single-writer.test.ts
git commit -m "test(traders): ownership walk over every endpoint and the single-writer rule"
```

---

### Task 20: Watcher — Go module, config, uploader (item 3, part 1)

**Files:**
- Create: `apps/watcher/go.mod`, `apps/watcher/internal/config/config.go`, `apps/watcher/internal/uploader/uploader.go`
- Test: `apps/watcher/internal/config/config_test.go`, `apps/watcher/internal/uploader/uploader_test.go`

**Interfaces:**
- Produces:
  ```go
  // module github.com/algomaker/watcher, go 1.27 — standard library only in this task
  package config
  type Config struct { Server string `json:"server"`; Token string `json:"token"`; Folder string `json:"folder"`; Include []string `json:"include"` }
  func Load(path string) (Config, error)        // reads JSON then Validate
  func (c Config) Validate() error              // server http(s) URL with no path but '/', token ≥ 20 chars, folder non-empty, include non-empty and each a valid path.Match pattern
  func DefaultPath(exe string) string           // filepath.Join(filepath.Dir(exe), "watcher.json")
  func VirtualStoreTwin(folder string, env func(string) string) (string, bool)
    // Windows path logic as plain strings (testable on Linux): when folder is under %ProgramFiles%, %ProgramFiles(x86)% or %SystemRoot%
    // (defaults C:\Program Files, C:\Program Files (x86), C:\Windows; case-insensitive), the twin is
    // %LOCALAPPDATA%\VirtualStore\<folder without its drive>
  package uploader
  type Client struct { Server, Token, Version string; HTTP *http.Client }
  type PutResult struct { Stored bool `json:"stored"`; Parser *string `json:"parser"`; ParseError *string `json:"parseError"` }
  var ErrOffset = errors.New("server refused the offset")     // 409
  var ErrRejected = errors.New("server rejected the token")   // 401, 403
  type HTTPError struct { Status int; Body string }            // any other non-2xx; Error() includes both
  func (c *Client) PutFile(ctx context.Context, rel string, mtime time.Time, sha string, body []byte, offset int64) (PutResult, error) // offset < 0 = whole file
  type Heartbeat struct { Version string `json:"version"`; Folder string `json:"folder"`; LastUploadAt *int64 `json:"lastUploadAt"`; FileCount int `json:"fileCount"` }
  func (c *Client) SendHeartbeat(ctx context.Context, hb Heartbeat) error
  type Queue struct{ … }                                        // latest-wins set of rel paths, first-queued order
  func (q *Queue) Put(rel string); func (q *Queue) Take() []string; func (q *Queue) Len() int
  ```
  Wire (the contract): `PUT {server}/v1/traders/files?path=<rel>&mtime=<ms>&sha256=<hex>[&offset=<n>]`, `Authorization: Bearer <token>`, `Content-Type: application/octet-stream`, `User-Agent: traders-watcher/<version>`, no Origin; `sha256` is always of the WHOLE content the server will hold after the request, also when only the tail is sent. `POST {server}/v1/traders/heartbeat` JSON. Request timeout 60 s.

- [ ] **Step 1: Write the failing tests** (table tests; `httptest.NewServer` recording requests)

```go
func TestVirtualStoreTwin(t *testing.T) {
  env := map[string]string{"ProgramFiles(x86)": `C:\Program Files (x86)`, "LOCALAPPDATA": `C:\Users\ravi\AppData\Local`}
  got, ok := VirtualStoreTwin(`C:\Program Files (x86)\ODIN\Diet\OnLineBackup`, func(k string) string { return env[k] })
  if !ok || got != `C:\Users\ravi\AppData\Local\VirtualStore\Program Files (x86)\ODIN\Diet\OnLineBackup` { t.Fatalf("got %q %v", got, ok) }
  if _, ok := VirtualStoreTwin(`C:\ODIN\Diet\OnLineBackup`, func(k string) string { return env[k] }); ok { t.Fatal("C:\\ODIN is not virtualised") }
}
func TestValidate(t *testing.T) { /* missing token, ftp:// server, server with a path, empty include, bad pattern "[" → each an error naming the field */ }
func TestPutFileWhole(t *testing.T) { /* method PUT, path /v1/traders/files, query path=Nse+Derivatives%2FTrades%2F1019TRD.TXT mtime sha256, no offset, body exact, headers exact; result parsed */ }
func TestPutFileOffset(t *testing.T) { /* offset=4096 in the query, body = tail only */ }
func TestStatuses(t *testing.T) { /* 409 → errors.Is(err, ErrOffset); 401/403 → ErrRejected; 500 → *HTTPError{Status:500}; closed server → a non-nil error that is neither */ }
func TestHeartbeatBody(t *testing.T) {
  // body exactly {"version":"1.0.0","folder":"C:\\ODIN\\OnLineBackup","lastUploadAt":null,"fileCount":3}, Content-Type application/json, no Origin header
}
func TestQueueLatestWins(t *testing.T) { var q Queue; q.Put("a"); q.Put("b"); q.Put("a"); if got := q.Take(); !reflect.DeepEqual(got, []string{"a", "b"}) || q.Len() != 0 { t.Fatal(got) } }
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/watcher && /usr/local/go/bin/go test ./...`. Expected: FAIL (no packages yet / undefined).
- [ ] **Step 3: Implement** `go.mod`, `config.go`, `uploader.go`.
- [ ] **Step 4: Run to verify they pass** — `cd apps/watcher && CGO_ENABLED=0 /usr/local/go/bin/go vet ./... && CGO_ENABLED=0 /usr/local/go/bin/go test ./...`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/watcher
git commit -m "feat(watcher): Go module, watcher.json config with the VirtualStore twin, uploader client"
```

---

### Task 21: Watcher — syncer, `main`, Windows build and make targets (item 3, part 2)

**Files:**
- Create: `apps/watcher/internal/syncer/syncer.go`, `apps/watcher/internal/syncer/watch.go`, `apps/watcher/internal/syncer/open_windows.go`, `apps/watcher/internal/syncer/open_other.go`, `apps/watcher/main.go`
- Modify: `apps/watcher/go.mod`/`go.sum`, `Makefile`, `.gitignore` (`apps/watcher/dist/`)
- Test: `apps/watcher/internal/syncer/syncer_test.go`, `apps/watcher/main_test.go`

**Interfaces:**
- Consumes: Task 20 packages.
- Produces:
  ```go
  package syncer
  type Clock interface{ Now() time.Time }
  type Uploader interface {
    PutFile(ctx context.Context, rel string, mtime time.Time, sha string, body []byte, offset int64) (uploader.PutResult, error)
    SendHeartbeat(ctx context.Context, hb uploader.Heartbeat) error
  }
  type Options struct {
    Roots []string; Include []string; Folder string; Version string
    Quiet time.Duration      // 2s
    Rescan time.Duration     // 5m
    Heartbeat time.Duration  // 60s
    Retry time.Duration      // 30s
    MaxSize int64            // 20 << 20
    Clock Clock; Up Uploader; Log *log.Logger
  }
  func New(o Options) *Syncer
  func (s *Syncer) Notice(abs string)              // a change event (from fsnotify or a test)
  func (s *Syncer) Scan() error                    // walk every root; Notice each included file whose size or mtime differs from its last upload; counts files
  func (s *Syncer) Tick(ctx context.Context)       // do whatever is due: quiet files, queue retries, heartbeat, rescan
  func (s *Syncer) Run(ctx context.Context) error  // Scan, fsnotify on every root recursively (new subfolders added), Tick every 500 ms
  func openShared(path string) (*os.File, error)   // windows: CreateFile GENERIC_READ with FILE_SHARE_READ|WRITE|DELETE; elsewhere os.Open
  // main.go
  var version = "dev"                               // -ldflags "-X main.version=…"
  func run(args []string) error                     // -config <path> (default next to the exe), -version; log to watcher.log beside the config, rotated to watcher.log.1 at 5 MiB
  ```
  Rules (ODIN appends the day's trade file during the session — the append path is the NORMAL path):
  - Include patterns without `/` match the lower-cased base name; with `/` the lower-cased forward-slash relative path (`path.Match`). Zero-byte files are never uploaded.
  - A noticed file is due once no event has arrived for `Quiet` AND its size and mtime are unchanged since the last event.
  - At upload: stat every root holding that relative path and take the newest mtime (the VirtualStore twin usually); open shared; read whole (over `MaxSize` → log and skip). **Complete lines only:** the content sent is everything up to and including the last `\n`; a trailing partial line is held back until it is complete; no `\n` at all → nothing to send yet. `sha` = sha256 of that content; equal to the last upload's → nothing.
  - If the content is longer than the last upload and its first `last.size` bytes hash to `last.sha`, send only the tail with `offset = last.size` (any size — not only large files); `ErrOffset` → resend whole. Anything else (a rewritten orders file, a first upload, a restart) → whole. Success records `{size, sha, mtime}` of what was sent and `lastUploadAt`.
  - Network error or 5xx → queue (latest wins; the file on disk IS the latest version). `ErrRejected` → queue and log at most once an hour. Any other 4xx → log and remember that sha so the same bytes are not retried until they change. Retries every `Retry`; heartbeat every `Heartbeat` with `fileCount` from the last scan; full rescan every `Rescan`. No history on the PC; no tray icon in R1 (the local log and the admin page's heartbeat are the status, spec item 3).

- [ ] **Step 1: Fetch fsnotify — ask first.** This needs `proxy.golang.org`. Ask the coordinator before running `cd apps/watcher && /usr/local/go/bin/go get github.com/fsnotify/fsnotify@v1.9.0 && /usr/local/go/bin/go mod tidy`. If the fetch is refused, stop and report; do not vendor by hand or replace fsnotify with polling without the coordinator's word.

- [ ] **Step 2: Write the failing tests** (temp dirs, a fake clock, the real `uploader.Client` against `httptest`)

```go
func TestNewFileUploadsOnceAfterQuiet(t *testing.T)   { /* write 1019TRD.TXT (two CRLF lines); Notice; Tick at +1.9s → 0 PUTs; Tick at +2s → 1 PUT whole with sha of the bytes; Tick again → still 1 */ }
func TestExcludedFileNeverUploads(t *testing.T)       { /* Nse Derivatives/Trades/DOCOMMiocp.log and Spread/Logs/x_CrossCurr.csv with the runbook's include patterns → 0 PUTs after Scan + Tick */ }
func TestZeroByteSkipped(t *testing.T)                { /* an empty MCX Derivatives/Trades/0928TRD.TXT → 0 PUTs */ }
func TestQuietResetsOnNewEvents(t *testing.T)         { /* Notice t0, Notice t0+1.5s, Tick t0+2.5s → 0; Tick t0+3.6s → 1 */ }
func TestAppendSendsOnlyNewLines(t *testing.T)        { /* 300-byte file uploaded; append one CRLF line; Notice; Tick → PUT offset=300, body = the new line only, sha of all bytes */ }
func TestPartialLastLineHeldBack(t *testing.T)        { /* append 'abc' with no newline → no PUT; append '\r\n' → PUT offset=prev with body 'abc\r\n' */ }
func TestRewrittenFileSendsWhole(t *testing.T)        { /* an orders file whose first line changes → PUT without offset */ }
func TestOffsetRefusedResendsWhole(t *testing.T)      { /* server 409 on the offset PUT → next PUT has no offset and the whole body */ }
func TestOfflineLatestWins(t *testing.T)              { /* server 503; append twice; server 200; Tick at +Retry → exactly 1 PUT, sha of the LAST content */ }
func TestRescanCatchesMissedChange(t *testing.T)      { /* change without Notice; Tick at +5m → PUT */ }
func TestHeartbeat(t *testing.T)                      { /* Tick at +60s → POST heartbeat {version, folder, fileCount:2, lastUploadAt:<ms>} */ }
func TestTwinNewerWins(t *testing.T)                  { /* roots [orig, twin]; same Nse Derivatives/Trades/1019TRD.TXT in both, twin newer → PUT path=Nse Derivatives/Trades/1019TRD.TXT with the twin's bytes */ }
func TestRejectedTokenDoesNotSpin(t *testing.T)       { /* 401: within 5 minutes of Ticks every 500 ms → at most 1 + 5min/Retry PUTs */ }
func TestRunRejectsBadConfig(t *testing.T)            { /* main_test: run([]string{"-config", missing}) returns an error naming the file */ }
```

- [ ] **Step 3: Run to verify they fail** — `cd apps/watcher && /usr/local/go/bin/go test ./...`. Expected: FAIL.
- [ ] **Step 4: Implement** the syncer files and `main.go`. Makefile:
  ```make
  GO ?= $(shell command -v go 2>/dev/null || echo /usr/local/go/bin/go)
  WATCHER_VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
  watcher: ## Build apps/watcher/dist/watcher.exe (Windows amd64, pure Go)
  	cd apps/watcher && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags "-H=windowsgui -X main.version=$(WATCHER_VERSION)" -o dist/watcher.exe .
  watcher-test: ## Go vet (linux + windows) and tests for the watcher
  	cd apps/watcher && CGO_ENABLED=0 $(GO) vet ./... && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) vet ./... && CGO_ENABLED=0 $(GO) test ./...
  check: typecheck test watcher-test ## Typecheck + tests
  ```
  Add `watcher watcher-test` to `.PHONY`; add `apps/watcher/dist/` to `.gitignore`.
- [ ] **Step 5: Run to verify they pass** — `make watcher-test && make watcher && file apps/watcher/dist/watcher.exe`. Expected: PASS; `PE32+ executable … x86-64 … (GUI)`.
- [ ] **Step 6: Commit**

```bash
git add apps/watcher Makefile .gitignore
git commit -m "feat(watcher): folder syncer — new lines as offset appends, partial lines held, offline queue, watcher.exe build"
```

---

### Task 22: Web — shared chart, the traders page, login, book tabs, add-leg

**Files:**
- Create: `apps/web/src/format.ts`, `apps/web/src/payoff-curves.tsx`
- Modify: `apps/web/src/api.ts` (move the formatters out, re-export them), `apps/web/src/payoff.tsx` (import `PayoffCurves` from `./payoff-curves.tsx`)
- Create: `apps/web/traders.html`, `apps/web/vite.traders.config.ts`, `apps/web/src/traders/{main.tsx,app.tsx,pages.tsx,api.ts,wire.ts,route.ts,hooks.ts,login.tsx,books.tsx,book.tsx,add-leg.tsx}`
- Modify: `apps/web/package.json` (`build`, `dev:traders`), `apps/web/tsconfig.json` (include `vite.traders.config.ts`), `.gitignore` (`apps/web/dist-traders/`)
- Test: `apps/web/test/traders/login.test.tsx`, `apps/web/test/traders/books.test.tsx`, `apps/web/test/traders-imports.test.ts`

**Interfaces:**
- Consumes: wire types from `apps/traders/src/types.ts` (type-only); `contractText`, `isOpenLeg` (runtime, pure).
- Produces:
  ```ts
  // apps/web/src/format.ts — moved verbatim from api.ts: inr, signed, inrCompact, RED, GREEN, sign, money (api.ts: export { … } from './format.ts')
  // apps/web/src/payoff-curves.tsx — moved verbatim from payoff.tsx: PayoffCurves (now exported), LegendToggles, sampleAt, dated, price
  export function PayoffCurves(props: { view: PayoffView; markAt: number | null; markLabel: string; expiryDate: string; overlay: readonly PayoffPoint[] | null }): React.ReactElement
  // apps/web/src/traders/api.ts
  export const TRADERS_BASE: string   // import.meta.env.VITE_TRADERS_API ?? (DEV ? `${protocol}//${hostname}:8794` : '')
  export class TradersApiError extends Error { readonly status: number }
  export function setAsTrader(name: string | null): void          // admin picker; appended as ?as= to every call outside /admin/ and /auth/
  export function setUnauthorized(fn: () => void): void
  export const tradersApi: { get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T>; put<T>(path: string, body: unknown | Blob): Promise<T>; patch<T>(path: string, body: unknown): Promise<T>; del<T>(path: string): Promise<T> }
  export const tapi: {   // typed calls over tradersApi; path segments always encodeURIComponent
    me(): Promise<{ username: string; role: Role }>; login(u: string, p: string): Promise<{ username: string; role: Role }>; logout(): Promise<void>
    books(): Promise<BookSummary[]>; book(stock: string): Promise<BookView>
    addLeg(stock: string, body: Omit<ManualLegInput, 'stock'>): Promise<TraderLeg>; patchLeg(key: string, p: { qty?: number; avgPrice?: number; note?: string }): Promise<TraderLeg>; deleteLeg(key: string): Promise<void>
    orders(q: { day?: string; stock?: string }): Promise<TraderOrder[]>; trades(q: { day?: string; stock?: string }): Promise<TraderTrade[]>; log(q: { day?: string }): Promise<LogLine[]>
    watcher(): Promise<WatcherStatus | null>; files(): Promise<StoredFile[]>
    adminTraders(): Promise<AdminTraderRow[]>; addTrader(u: string, p: string): Promise<void>; patchTrader(name: string, p: { disabled?: boolean; password?: string }): Promise<void>
    issueToken(name: string): Promise<{ token: string }>; revokeToken(name: string): Promise<void>
    uploadFile(name: string, path: string, file: Blob): Promise<{ stored: true; parser: string | null; parseError: string | null }>
  }
  // pages.tsx — the top-level nav registry (R3 appends Market Watch, Range, Portfolio)
  export interface TradersPage { readonly id: string; readonly label: string; readonly adminOnly?: true; render(): React.ReactElement }
  export const PAGES: readonly TradersPage[]                       // R1: books, orders, admin(adminOnly)
  // book.tsx — the book tab and its extension points (R2 adds Analysis/Scenario sub-tabs, R3 Advice and the band chip)
  export interface BookSubTab { readonly id: string; readonly label: string; render(p: { stock: string; view: BookView; reload(): void }): React.ReactElement }
  export const BOOK_SUBTABS: readonly BookSubTab[]                 // R1: [{ id: 'legs', label: 'Legs & payoff' }]
  export const BOOK_HEADER_CHIPS: readonly ((p: { stock: string; view: BookView }) => React.ReactElement | null)[]   // R1: []
  export function BookTab(props: { stock: string }): React.ReactElement
  // books.tsx — the stock tab strip
  export const BOOK_TAB_BADGES: readonly ((s: BookSummary) => React.ReactElement | null)[]   // R1: []
  // route.ts: useTradersRoute(): [{ page: string; stock: string | null }, (to: string) => void]  — hash router '#/books/TCS', '#/orders', '#/admin'
  // hooks.ts: usePoll<T>(fn: () => Promise<T>, everyMs: number, deps: unknown[]): { data: T | null; error: string | null; reload(): void }
  ```
  Build: `vite.traders.config.ts` = react plugin, `build.outDir: 'dist-traders'`, `emptyOutDir: true`, `rollupOptions.input: 'traders.html'`, dev port 5175. `package.json`: `"build": "tsc -b && vite build && vite build --config vite.traders.config.ts"`, `"dev:traders": "vite --config vite.traders.config.ts"`. `traders/main.tsx` mounts like `src/main.tsx` (astryx CSS, neutral theme, `comfort.css`, `responsive.css`).
  Screens: login page says "Traders login — separate from the desk login" (spec item 1); top bar: user, Logout, nav from `PAGES` (admin-only hidden from traders), and for an admin a trader `Selector` that calls `setAsTrader`; Books: a `TabList` with one tab per `BookSummary` (each tab renders `BOOK_TAB_BADGES`), polled every 15 s, empty state "No open books"; `BookTab`: header (stock, as-of `HH:MM`, "Market closed — last session's prices" when `closed`, `BOOK_HEADER_CHIPS`), the line "Trade history starts <historyFrom>; positions opened before it, and shares delivered at expiry, must be added by hand." (or "No ODIN trade files yet" when null), a warning `Banner` per warning, a sub-tab list from `BOOK_SUBTABS`. The `legs` sub-tab: totals row (Δ, Γ, Vega, Θ, MTM), legs `Table` (Source `ODIN`/`manual`, Type `FUT`/`CE`/`PE`/`EQ`, Expiry, Strike, Qty, Lots, Avg, LTP, IV %, Δ, Γ, Vega, Θ, MTM; unmatched rows greyed with "not understood"; Edit/Delete on manual rows only), `PayoffCurves` (`markAt` = spot ?? first forward, `markLabel` 'spot', `expiryDate` = first expiry) when `payoff` is not null, and a "Not understood" list from `unmatched`; "Add leg" opens a `Dialog` form (instrument, expiry, strike, CE/PE, signed qty in shares with the lot count shown, avg price, note) that posts and reloads. Polls the book every 15 s.

- [ ] **Step 1: Move the chart, unchanged.** Create `format.ts` and `payoff-curves.tsx` by moving the named code; `api.ts` re-exports the formatters; `payoff.tsx` imports `PayoffCurves`. Run `npm run test --workspace @algomaker/web && npm run typecheck --workspace @algomaker/web`. Expected: PASS with no test file edited. Commit:

```bash
git add apps/web/src/format.ts apps/web/src/payoff-curves.tsx apps/web/src/api.ts apps/web/src/payoff.tsx
git commit -m "refactor(web): payoff chart and formatters into leaf modules the traders page can share"
```

- [ ] **Step 2: Write the failing tests** (`installFetch` from `apps/web/test/http.tsx`)

```tsx
// traders/books.test.tsx
test('one tab per open book; clicking a tab loads that book', async () => {
  const sent = installFetch(({ path }) => path === '/v1/traders/auth/me' ? { body: { username: 'ravi', role: 'trader' } }
    : path === '/v1/traders/books' ? { body: ['JINDALSTEL', 'NIFTY', 'TCS'].map((stock) => ({ stock, legCount: 1, mismatch: null, lastFileAt: null })) }
    : { body: BOOK_TCS })
  render(<TradersApp />)
  for (const s of ['JINDALSTEL', 'NIFTY', 'TCS']) await screen.findByRole('tab', { name: new RegExp(s) })
  fireEvent.click(screen.getByRole('tab', { name: /NIFTY/ }))
  await waitFor(() => expect(sent.some((r) => r.path === '/v1/traders/books/NIFTY')).toBe(true))
})
test('a symbol with & is encoded in the request', async () => { /* tab 'M&M' → request path '/v1/traders/books/M%26M' */ })
test('the book tab shows manual and not-understood legs, the history line and the warnings', async () => {
  /* BOOK_TCS has a manual share leg, an unmatched leg, historyFrom '2026-08-25', one warning
     → row with text 'manual'; 'not understood: TCS 3550 CE 2026-10-27 (client C1) …'; 'Trade history starts 2026-08-25'; the warning text */
})
test('add leg posts the form and reloads the book', async () => {
  /* fill instrument share, qty 1000, avg 3000 → POST /v1/traders/books/TCS/legs with body
     {instrument:'share', expiry:'', strike:null, optType:null, qty:1000, avgPrice:3000, note:''}; then GET /v1/traders/books/TCS again */
})
test('an admin with no trader picked sees a prompt, not an error', async () => {
  /* me → admin; books request answers 400 'pick a trader' → text 'Pick a trader to see their books' and no error banner */
})
test('an admin\'s pick is sent as ?as=', async () => { /* select 'sita' → next books request url has as=sita; an /admin/ call has no as */ })
// traders/login.test.tsx
test('login shows the separate-login note and enters on success', async () => { /* … */ })
test('a 401 mid-session returns to login', async () => { /* … */ })

// apps/web/test/traders-imports.test.ts (node:test)
test('the traders page reaches only its own code and the shared chart', () => {
  const { files, externals } = walkRuntimeImports(['apps/web/src/traders/main.tsx'])
  const allowedFile = (f: string) => f.startsWith('apps/web/src/traders/') || ['apps/web/src/payoff-curves.tsx', 'apps/web/src/format.ts', 'apps/traders/src/types.ts'].includes(f) || /^apps\/web\/src\/[^/]+\.css$/.test(f)
  assert.deepEqual([...files].filter((f) => !allowedFile(f)), [])
  assert.deepEqual([...externals].filter((e) => !/^(react|react-dom|recharts|@astryxdesign\/)/.test(e)), [])
})
```

- [ ] **Step 3: Run to verify they fail** — `npm run test --workspace @algomaker/web -- test/traders && node --test apps/web/test/traders-imports.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the traders page files, configs and `.gitignore` line.
- [ ] **Step 5: Run to verify they pass** — Step 3 command, then `npm run typecheck --workspace @algomaker/web` and `npm run build --workspace @algomaker/web && ls apps/web/dist-traders/traders.html apps/web/dist/index.html`. Expected: PASS; both outputs exist; `dist/` holds no `traders.html`.
- [ ] **Step 6: Commit**

```bash
git add apps/web/traders.html apps/web/vite.traders.config.ts apps/web/package.json apps/web/tsconfig.json apps/web/src/traders apps/web/test/traders apps/web/test/traders-imports.test.ts .gitignore
git commit -m "feat(web): traders page — login, one tab per open book, book tab with payoff, add leg"
```

---

### Task 23: Web — orders/trades page, admin page, no trading anywhere

**Files:**
- Create: `apps/web/src/traders/orders.tsx`, `apps/web/src/traders/admin.tsx`
- Modify: `apps/web/src/traders/pages.tsx` (register them)
- Test: `apps/web/test/traders/orders.test.tsx`, `apps/web/test/traders/admin.test.tsx`, `apps/web/test/traders/no-trading.test.tsx`

**Interfaces:**
- Consumes: Task 22 `tapi`, `usePoll`, `PAGES`.
- Produces: `OrdersPage(): React.ReactElement` (tabs Orders · Trades · Log; a day `DateInput` defaulting to today IST and a stock filter from the trader's books; order rows show status (e.g. `Traded (4)`), side, qty, filled, price, entry time `HH:MM:SS`, reason when present; trades show trade no, side, qty, price, time; polled every 30 s; the Log tab says "ODIN's message log is not in its OnLineBackup files" when empty), `AdminPage(): React.ReactElement` (trader table: username, disabled, last login, watcher "last heartbeat HH:MM · v<version> · <fileCount> files" or "never", token "issued <date>, last used <HH:MM|never>"; actions Add trader, Disable/Enable, Reset password, Issue token, Revoke token, Upload file), and `export const ADMIN_SECTIONS: readonly { id: string; label: string; render(): React.ReactElement }[]` rendered below the table (R1: `[]`; R2 adds charges there).
  Rules: the issued token appears in a `Dialog` once ("Copy it now — it is not shown again") and is gone from the DOM when the dialog closes; Upload takes a `FileInput` plus a relative-path field (default the file name, e.g. `Nse Derivatives/Trades/1019TRD.TXT` for an ODIN file) and PUTs the raw file (`content-type: application/octet-stream`), then shows the parser or the parse error.

- [ ] **Step 1: Write the failing tests**

```tsx
test('orders default to today and filter by stock', async () => { /* first request /v1/traders/orders?day=<today>; choose TCS → ?day=<today>&stock=TCS; rows show 'Cancelled (5)' and filled 0 */ })
test('trades and log tabs', async () => { /* trades rows; empty log → the OnLineBackup sentence */ })
test('admin lists traders with watcher and token state', async () => { /* 'last heartbeat 10:27 · v1.0.0 · 3 files'; 'never' for sita */ })
test('add, disable and reset send the right calls', async () => { /* POST /admin/traders {username,password}; PATCH {disabled:true}; PATCH {password} */ })
test('an issued token is shown once', async () => {
  /* click Issue token → POST …/ravi/token → dialog shows 'tok_123…'; close → queryByText('tok_123…') is null */
})
test('manual upload PUTs the raw file and shows the parse result', async () => {
  /* choose File([…], '1019TRD.TXT'), path 'Nse Derivatives/Trades/1019TRD.TXT' → PUT /v1/traders/admin/traders/ravi/files?path=Nse%20Derivatives%2FTrades%2F1019TRD.TXT, content-type application/octet-stream; shows 'odin-nse-fo-trades' */
})
// no-trading.test.tsx
test('no screen offers to trade', async () => {
  for (const screen of [booksScreen, orderScreen, adminScreen]) {
    await screen.render()
    const names = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')].map((e) => e.textContent ?? '')
    expect(names.filter((n) => /place|apply|square ?off|kill|flatten|submit order|cancel order|exit position|buy now|sell now/i.test(n))).toEqual([])
  }
})
```

- [ ] **Step 2: Run to verify they fail** — `npm run test --workspace @algomaker/web -- test/traders`. Expected: FAIL.
- [ ] **Step 3: Implement** `orders.tsx`, `admin.tsx`, register both in `PAGES`.
- [ ] **Step 4: Run to verify they pass** — Step 2 command, `node --test apps/web/test/traders-imports.test.ts`, `npm run typecheck --workspace @algomaker/web`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/traders apps/web/test/traders
git commit -m "feat(web): traders orders/trades page and admin page; no screen offers to trade"
```

---

### Task 24: Runbook — `docs/runbooks/traders.md`

**Files:**
- Create: `docs/runbooks/traders.md`

**Interfaces:**
- Consumes: the names fixed above (ports, env, commands, endpoints, file formats).

- [ ] **Step 1: Write the runbook** with these sections, every command exact:
  1. **What runs** — `desk-traders` (pm2, :8794 on 127.0.0.1), Caddy site, `apps/web/dist-traders`, `desk-subscriptions` `{source:'traders'}`; it never touches the desk and can be stopped any time.
  2. **Before first start (operator)** — O1: hostname; HTTPS needs port 443 open (Caddy then gets the certificate itself). On port 80 alone every watcher token, password and position crosses the internet unencrypted and the session cookie cannot be `Secure`. `.env.local`: `TRADERS_ORIGINS=http://<host>` (or `https://<host>`), optional `TRADERS_PORT`.
  3. **Caddy** (operator; `sudo systemctl reload caddy`):
     ```
     http://<traders-host> {
         request_body /v1/traders/* {
             max_size 21MB
         }
         handle /v1/traders/* {
             reverse_proxy 127.0.0.1:8794
         }
         handle {
             root * /opt/algomaker-delta/apps/web/dist-traders
             try_files {path} /traders.html
             file_server
         }
     }
     ```
     It sits beside the existing `http://:80` block, which keeps serving the desk unchanged. With 443 open: drop the `http://` prefix (`<traders-host> { … }`) and set `TRADERS_ORIGINS=https://<traders-host>`.
  4. **Widen `DESK_UNIVERSE` — OPERATOR STEP, one restart of desk-marketdata only, while the desk's books are flat (P10).** Checked in code: the universe drives the instrument sync's row filter and the enctoken canary's spot token (first name in the list) — not subscriptions, which come from books and declarations. Keep `NIFTY,BANKNIFTY,SENSEX,BHEL` first. Build the list on a machine that may reach Kite: `curl -s https://api.kite.trade/instruments/NFO | awk -F, 'NR>1 && $11=="NFO-OPT" {gsub(/"/,"",$4); print $4}' | sort -u | paste -sd,`. Before: record `curl -s http://127.0.0.1:8790/v1/desk/feed` `subscribedTokens` and `mongosh algomaker --quiet --eval 'db.instrument.countDocuments({})'`. Set `DESK_UNIVERSE=` in `.env.local`, then `npx pm2 startOrRestart ecosystem.desk.config.cjs --only desk-marketdata --update-env`. After: `subscribedTokens` unchanged (desk-traders not started yet), instrument count larger, `pm2 ls` memory of desk-api/runner/supervisor watched through their next 15-minute master refresh.
  5. **Start desk-traders (operator)** — `npm run build --workspace @algomaker/web` (live on build; Caddy serves off disk), `npx pm2 start ecosystem.desk.config.cjs --only desk-traders`, `curl -s http://127.0.0.1:8794/v1/traders/health`.
  6. **First admin** — `TRADERS_MONGO_URL=mongodb://127.0.0.1:27017/algomaker node bin/traders-user.mjs create-admin <username>`; also `reset`, `unlock`, `list`.
  7. **Add a trader and issue a token** — admin page: Add trader → Issue token (shown once, copy it into that trader's `watcher.json`); Revoke/replace any time; last-used time on the page.
  8. **Install the watcher on a trader's PC** — `make watcher` → `apps/watcher/dist/watcher.exe`; copy `watcher.exe` and `watcher.json` to `C:\Traders\`. The watched folder is ODIN's `OnLineBackup` (inside the ODIN install, e.g. `C:\ODIN\Diet\OnLineBackup`; under Program Files its VirtualStore twin is watched automatically):
     ```json
     { "server": "http://<traders-host>", "token": "<token>", "folder": "C:\\ODIN\\Diet\\OnLineBackup",
       "include": ["*/Trades/*TRD.TXT", "*/Orders/*.txt", "*/Orders/*.TXT"] }
     ```
     Scheduled task: `schtasks /Create /TN "Traders Watcher" /TR "C:\Traders\watcher.exe" /SC ONLOGON /RL LIMITED /F`; start now `schtasks /Run /TN "Traders Watcher"`; status = `C:\Traders\watcher.log` and the heartbeat on the admin page within 60 s. On first start it uploads the folder's whole history (every daily `MMDDTRD.TXT`); during the session it sends each new trade line as it is appended. New versions are installed by hand (copy over, `schtasks /End` then `/Run`).
  9. **What the files give, and what must be added by hand** — legs are the sum of every trade in the folder (VolHedge's net-price rule); the book shows "Trade history starts <date>". Positions opened before that date, and shares delivered by physical settlement of stock options at expiry, are in no trade file: add them as manual legs (Add leg on the book tab), or upload a canonical positions file as an opening balance. Expired contracts drop off the tabs the day after expiry. Orders: the status labels (`Open (1)`, `Partly traded (3)`, `Traded (4)`, `Cancelled (5)`, `Rejected (6)`) are our reading of the codes — ask a trader to confirm 1 and 6 against ODIN's Order Book. BSE order files are stored but not parsed in R1; the BSE trade side is our reading — confirm one SENSEX trade against the BSE Trade Book.
  10. **Manual upload** — the three canonical CSV formats (exact header lines from the contract, one example row each, `qty` signed shares, `time` ISO 8601 with offset; a positions file named `positions-YYYY-MM-DD.csv` is the opening balance as of that day) and the admin page's Upload, which also takes an ODIN file with its relative path.
  11. **Verification** (table: check · command · expected): health 200; the `desk-subscriptions` traders document refreshed every 15 s (`mongosh algomaker --quiet --eval "db['desk-subscriptions'].findOne({source:'traders'}).updatedAt"`); the desk's own subscription unchanged (`subscribedTokens` before − after = the traders declaration size); a trade in ODIN shows on the tab within 10 s; pulling the network cable for 10 minutes loses nothing (the queue drains on reconnect); the JINDALSTEL-style check: a trader's leg quantities and net prices equal VolHedge's for the same book; a new stock is priced within a minute of its first leg with no restart (item 7); `make check` green; the import rule and ownership suites green.
  12. **Restarts and stops** — `npx pm2 restart desk-traders` / `npx pm2 stop desk-traders` touch no desk process; desk-marketdata restarts remain the operator's.
  13. **Troubleshooting** — token rejected (revoked or trader disabled), "did not parse" (open `GET /v1/traders/files`), "not understood" (underlying missing from `DESK_UNIVERSE` or a strike not listed), a leg's quantity short of ODIN's (a position from before the history start — add it by hand).
- [ ] **Step 2: Check** — every command's names match the code (`grep -n "TRADERS_\|desk-traders\|traders-user\|OnLineBackup" docs/runbooks/traders.md` against `config.ts`, the ecosystem entry, `bin/` and Task 21's include rules).
- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/traders.md
git commit -m "docs(runbook): traders — Caddy, HTTPS note, DESK_UNIVERSE operator step, watcher install, checks"
```

---

## Self-review

- **Spec coverage (R1 = §8 Phase 1, items 1–7 + 4a, updated by the ODIN facts):** 1 accounts/admin → Tasks 3, 4, 23; 2 one trader's data → `whose` (3), ownership walk (19); 3 watcher → 20, 21 (append path normal, partial lines held), upload/heartbeat 12, runbook 24; 4 books/tabs → 7 (net-price rule), 8–11 (parsers), 13, 14, 17, 22; 4a manual legs → 13, 14, 17 (delta +1,000), 22, and the history line; 5 orders/trades/log → 10, 13, 14, 23 (ODIN keeps no message log in OnLineBackup: the log endpoint stays, empty unless a canonical upload fills it); 6 no trading → import rule (1), no endpoint exists (2 table), no button (23); 7 market data → 15, runbook 24. P6 → 3, 4; P7 → 8 (held lines), 12, 13; P8 → 6, 17; P9 → replaced by the trade ledger (7) and `historyFrom`; P13 → payoff cache (17); P14 → 24; P16 → 1, 19; §10 tests → 1, 19, Global Constraints. P1's fallbacks are no longer needed and are not planned.
- **Left out on purpose (R2/R3):** vanna/volga, scenario, Analysis/Scenario screens, charges, SPAN, range, market watch, portfolio, groups, band, advice, repair, any desk-engine change; BSE order parsing.
- **Type consistency:** `TradersMaster`, `matchLeg`, `LegStore`, `LedgerStore`, `WatcherStatusStore`, `TradersQuotes`, `Declarer`, `PayoffCache`, `buildBookView`, `TradersDeps`, `ApplyParsed`, `Upload`, `ENDPOINTS` ids, `CASES` are named once in their producing task and used unchanged by consumers.
- **Settled since the first draft:** ODIN's formats (the operator's OnLineBackup sample) and live writes (ODIN appends to the day's TRD file during the session) — no gated task and no P1 fallback remain.
- **Still open:** the traders' hostname and the 443 decision (O1 — runbook gives both forms); whether `proxy.golang.org` may be reached for fsnotify (Task 21 Step 1 asks); ODIN order codes 1 and 6 and the BSE trade side (our readings, runbook asks a trader to confirm); VolHedge-specific semantics (Q3) do not touch R1.
