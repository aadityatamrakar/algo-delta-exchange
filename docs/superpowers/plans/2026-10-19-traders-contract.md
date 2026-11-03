# Traders — the shared contract for the three release plans

Spec: `docs/superpowers/specs/2026-10-19-traders-design.md` (approved
2026-10-19). Item numbers (1–36) and problem numbers (P1–P16) below are the
spec's.

This file fixes the names every release plan uses, so Release 2 and 3 build on
Release 1 without renaming anything. A plan may ADD names; it may not change
one defined here. If a plan needs a change, it says so at the top of the plan
and the coordinator updates this file first.

## Layout

| Path | What |
|---|---|
| `apps/traders/` | the server. `package.json` name `@algomaker/traders`, `"type": "module"`, runs `.ts` directly like `apps/api` |
| `apps/traders/src/main.ts` | boot: env, Mongo, bus, master, routes, listen |
| `apps/traders/src/server.ts` | HTTP dispatch: CORS allowlist, write-origin rule, JSON-only writes except the upload, body caps — the same rules as `apps/api/src/server.ts`, own code |
| `apps/traders/src/db.ts` | `TradersDb`, the ONLY object in the app that writes to Mongo (P16) |
| `apps/traders/src/types.ts` | the shared types below |
| `apps/traders/src/auth/` | users, sessions, watcher tokens, the request gate |
| `apps/traders/src/routes/` | one route factory per area, `Route = (ctx: RouteCtx) => Promise<boolean>` as in `apps/api/src/routes/kit.ts` |
| `apps/traders/src/ingest/` | file store, parser registry, parsers, ledger |
| `apps/traders/src/books/` | legs → books, manual legs |
| `apps/traders/src/market/` | quote cache fed from the bus, master loader, `desk-subscriptions` declaration |
| `apps/traders/src/analytics/` | book view (R1), analysis + scenario + margin (R2), market watch + portfolio + advice (R3) |
| `apps/traders/test/` | `node:test` suites, `*.test.ts` (picked up by the root `test:node` glob) |
| `apps/watcher/` | Go module `github.com/algomaker/watcher`; `main.go`, `internal/config`, `internal/syncer`, `internal/uploader`; no `package.json`. Watches ODIN's `OnLineBackup` folder; default include patterns `*/Trades/*TRD.TXT`, `*/Orders/*.txt`, `*/Orders/*.TXT` |
| `apps/web/traders.html` + `apps/web/src/traders/` | the traders page; built to `apps/web/dist-traders/` by its own Vite config `apps/web/vite.traders.config.ts` |
| `docs/runbooks/traders.md` | operator runbook (install watcher, issue token, Caddy, restarts) |
| R2: `packages/greeks` (vanna, volga), `packages/payoff/src/scenario.ts`, `packages/span/` (new), `scripts/span_job.py` | |
| R3: `packages/desk-engine` (future leg kind, `trader` preset) | |

## Process, ports, env

- pm2 app `desk-traders` in `ecosystem.desk.config.cjs`; port env `TRADERS_PORT`, default `8794`.
- `TRADERS_MONGO_URL` — the desk's database (same as `DESK_MONGO_URL`).
- `DESK_BUS_URL` — default `ws://127.0.0.1:8791`, read-only `md.tick` / `md.health`, the way `apps/api/src/main.ts` does.
- `TRADERS_ORIGINS` — comma-separated exact browser origins.
- `TRADERS_SESSION_TTL_MS` — default `@algomaker/auth`'s `DEFAULT_SESSION_TTL_MS`.
- Session cookie name `traders_session`, httpOnly, `SameSite=Strict`, `Secure` when the request came over TLS.
- Tests: Mongo URL `process.env.DESK_TEST_MONGO` or `mongodb://127.0.0.1:27017/algomaker_traders_test_<suite>` — a distinct database per suite, never `algomaker`; use the repo's `skipUnlessMongo` pattern (`apps/api/test/require-mongo.ts`).

## Collections (the only ones `TradersDb` may write, plus one desk document)

`traders-users`, `traders-sessions`, `traders-tokens`, `traders-files`,
`traders-file-versions`, `traders-legs`, `traders-orders`, `traders-trades`,
`traders-log`, `traders-settings`, `traders-events` (R3), `traders-groups` (R3).
The one desk write: `desk-subscriptions`, document `{ source: 'traders' }` only,
through `publishSubscription` from `apps/marketdata/src/subscription-store.ts`.

## Shared types (`apps/traders/src/types.ts`)

```ts
export type Role = 'trader' | 'admin'
export type PrincipalKind = 'trader' | 'admin' | 'watcher'
export interface Principal { readonly kind: PrincipalKind; readonly name: string }

export interface TraderUser {
  readonly username: string            // lower-case, [a-z0-9._-]{2,32}
  readonly passwordHash: string        // @algomaker/auth hashPassword
  readonly role: Role
  readonly disabled: boolean
  readonly createdAt: number
  readonly lastLoginAt: number | null
  readonly failedAttempts: number
  readonly lastFailureAt: number | null
  readonly lockedUntil: number | null
}

export interface WatcherToken {
  readonly trader: string
  readonly tokenHash: string           // sha256 hex of the token; the token itself is never stored
  readonly createdAt: number
  readonly lastUsedAt: number | null
  readonly revokedAt: number | null    // at most one token per trader has revokedAt === null
}

export type Instrument = 'option' | 'future' | 'share'
export type OptType = 'CE' | 'PE'

export interface TraderLeg {
  readonly trader: string
  readonly stock: string               // NSE symbol, upper-case: 'TCS'
  readonly instrument: Instrument
  readonly expiry: string              // 'YYYY-MM-DD'; '' for a share
  readonly strike: number | null       // null unless option
  readonly optType: OptType | null     // null unless option
  readonly qty: number                 // SIGNED shares (lots x lot size); negative = short
  readonly avgPrice: number            // per share, rupees
  readonly clientCode: string          // ODIN client code; '' for manual legs
  readonly source: 'odin' | 'manual'
  readonly key: string                 // odin: legKey(...) below; manual: 'manual:' + random id
  readonly token: number | null        // Kite instrument token; null = not matched (P8)
  readonly note: string
  readonly updatedAt: number
}

/** The stable key of an ODIN leg: same contract => same key across uploads. */
export function legKey(l: Pick<TraderLeg, 'clientCode' | 'instrument' | 'stock' | 'expiry' | 'strike' | 'optType'>): string
// `${clientCode}|${instrument}|${stock}|${expiry}|${strike ?? ''}|${optType ?? ''}`

export interface StoredFile {
  readonly trader: string
  readonly path: string                // relative to the watched folder, forward slashes
  readonly sha256: string
  readonly size: number
  readonly mtime: number               // ms, from the PC
  readonly receivedAt: number
  readonly parser: string | null       // id of the parser that took it; null = no parser matched
  readonly parseError: string | null
  readonly skipped?: readonly { readonly lineNo: number; readonly reason: string }[]   // first 20 lines the parser skipped (ParsedFile.skipped)
}

export interface TraderOrder {
  readonly trader: string; readonly orderNo: string; readonly exchOrderNo: string
  readonly clientCode: string; readonly stock: string; readonly instrument: Instrument
  readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  readonly side: 'Buy' | 'Sell'; readonly qty: number; readonly price: number
  readonly status: string; readonly reason: string; readonly time: number; readonly day: string
  readonly filledQty: number | null    // ODIN orders: filled quantity; null when the file has none
  readonly updateTime: number          // last update; an older order row never overwrites a newer one
}
export interface TraderTrade {
  readonly trader: string; readonly tradeNo: string; readonly orderNo: string
  readonly clientCode: string; readonly stock: string; readonly instrument: Instrument
  readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  readonly side: 'Buy' | 'Sell'; readonly qty: number; readonly price: number   // qty: positive shares; sign is in side
  readonly time: number; readonly day: string
  readonly seq: number                 // line number in its file; de-dup key is (trader, day, tradeNo, orderNo)
}
export interface LogLine { readonly trader: string; readonly day: string; readonly seq: number; readonly time: number; readonly text: string }
```

## Parsers (`apps/traders/src/ingest/parsers.ts`)

```ts
export interface ParsedPosition { clientCode: string; stock: string; instrument: Instrument; expiry: string; strike: number | null; optType: OptType | null; qty: number; avgPrice: number }
export interface ParsedFile {
  readonly kind: 'positions' | 'orders' | 'trades' | 'log'
  readonly day: string                                  // 'YYYY-MM-DD' the file is about
  readonly positions?: readonly ParsedPosition[]
  readonly orders?: readonly Omit<TraderOrder, 'trader'>[]
  readonly trades?: readonly Omit<TraderTrade, 'trader'>[]
  readonly log?: readonly Omit<LogLine, 'trader'>[]
  readonly skipped?: readonly { readonly lineNo: number; readonly reason: string }[]   // lines not understood; reported, never silent (ODIN parsers skip a bad line instead of failing the file)
}
export interface FileParser {
  readonly id: string
  matches(path: string, firstLine: string): boolean
  parse(text: string, path: string): ParsedFile         // throws ParseError with a one-line reason
}
export class ParseError extends Error {}
export function parserFor(path: string, firstLine: string): FileParser | null
```

Release 1 ships the **ODIN parsers** — ids `odin-nse-fo-trades`,
`odin-nse-eq-trades`, `odin-nse-orders`, `odin-bse-fo-trades` — for the files
in ODIN's `OnLineBackup` folder (formats in the spec, §6 item 3a, from the
operator's sample of 2026-10-19), and the **canonical CSV** parsers (ids
`canonical-positions`, `canonical-orders`, `canonical-trades`) — our own
format, for admin's manual upload and as test aids.

**ODIN has no positions file.** A canonical positions CSV uploaded by admin is
an OPENING BALANCE as of its day (positions opened before the trade history):
later trades fold on top of it. Legs with `source: 'odin'` are derived by the
ledger from that balance and `traders-trades`: per contract, walk the trades in file order day
by day keeping net qty and net value (Σ signed qty × price); when net qty is 0
at the END of a day, reset value to 0; `avgPrice = value / net qty`. A
contract whose expiry is before today is closed. (This reproduces VolHedge's
Net Price on the sample.) Canonical headers, exact first lines:

- positions: `client_code,stock,instrument,expiry,strike,type,qty,avg_price`
- orders: `order_no,exch_order_no,client_code,stock,instrument,expiry,strike,type,side,qty,price,status,reason,time`
- trades: `trade_no,order_no,client_code,stock,instrument,expiry,strike,type,side,qty,price,time`

(`instrument` ∈ option|future|share, `type` ∈ CE|PE|'' , `expiry` YYYY-MM-DD
or '', `time` ISO 8601 with offset.)

## Endpoints (all under `/v1/traders`)

Watcher — `Authorization: Bearer <token>`, principal kind `watcher`:
- `PUT /v1/traders/files?path=<rel>&mtime=<ms>&sha256=<hex>[&offset=<n>]`, body `application/octet-stream`, cap 20 MB. 200 `{stored:true, parser, parseError}`; 409 `{error:'offset'}` when `offset` ≠ stored size (watcher then resends whole).
- `POST /v1/traders/heartbeat` `{version, folder, lastUploadAt, fileCount}` → 200.

Session — cookie `traders_session`:
- `POST /v1/traders/auth/login` `{username,password}`; `POST /v1/traders/auth/logout`; `GET /v1/traders/auth/me` → `{username, role}`.

Admin only:
- `GET /v1/traders/admin/traders` → `[{username, disabled, lastLoginAt, watcher: WatcherStatus | null}]`
- `POST /v1/traders/admin/traders` `{username, password}`
- `PATCH /v1/traders/admin/traders/:name` `{disabled?, password?}`
- `POST /v1/traders/admin/traders/:name/token` → `{token}` (shown once; revokes the previous)
- `DELETE /v1/traders/admin/traders/:name/token`
- `PUT /v1/traders/admin/traders/:name/files?path=<rel>` — manual upload, same body and pipeline as the watcher's

Trader (admin acts on a trader with `?as=<username>`; a trader's `as` is ignored):
- `GET /v1/traders/books` → `[{stock, legCount, mismatch: string | null, lastFileAt: number | null}]` — every stock with a non-zero leg
- `GET /v1/traders/books/:stock` → `BookView` (R1, below)
- `POST /v1/traders/books/:stock/legs` — manual leg (item 4a); `PATCH`/`DELETE /v1/traders/legs/:key` — manual legs only, 409 on an ODIN leg
- `GET /v1/traders/orders?day=&stock=`, `GET /v1/traders/trades?day=&stock=`, `GET /v1/traders/log?day=`
- `GET /v1/traders/watcher` → `WatcherStatus` `{lastHeartbeatAt, lastUploadAt, version, folder, fileCount} | null`

Added by R2: `GET /books/:stock/analysis`, `POST /books/:stock/scenario`,
`GET /books/:stock/margin`, `GET|PUT /admin/settings` (charges and brokerage).
Added by R3: `GET /market/:stock`, `GET /portfolio`, `GET /admin/portfolio`,
`GET|PUT /books/:stock/groups`, `GET /books/:stock/advice`,
`POST /books/:stock/repair`. (Range calculator is pure and runs in the page.)

## `BookView` (R1; R2 and R3 extend it, never rename)

```ts
export interface LegView {
  readonly key: string; readonly source: 'odin' | 'manual'
  readonly instrument: Instrument; readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  readonly qty: number; readonly avgPrice: number
  readonly ltp: number | null; readonly iv: number | null      // iv decimal; null = unpriceable
  readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number   // position greeks (x qty)
  readonly mtm: number | null; readonly matched: boolean
}
export interface BookView {
  readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly spot: number | null; readonly futures: Readonly<Record<string, number | null>>   // expiry -> that expiry's own future mark; null for a weekly with no future
  readonly forwards: Readonly<Record<string, number | null>>  // expiry -> the forward used: own future, else put-call-parity forward, else spot carried
  readonly legs: readonly LegView[]
  readonly totals: { readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number; readonly mtm: number }
  readonly payoff: PayoffView | null        // from @algomaker/payoff, valued per leg on its own expiry
  readonly unmatched: readonly string[]     // one line per row we could not match (P8)
  readonly mismatch: string | null          // reserved; always null in R1 — ODIN writes no net-position file to compare against
  readonly historyFrom: string | null       // YYYY-MM-DD of the earliest ODIN trade file seen; legs opened before it are manual
  readonly warnings: readonly string[]      // dead feed, watcher offline, last file did not parse, ...
}
```

## Rules every plan inherits

- apps/traders imports nothing from `apps/api/src/submit*`, `apps/api/src/repair-apply*`, `apps/order-gateway`, `packages/order-bus`, `packages/brokers`; a test in R1 enforces it and every later plan keeps it green.
- Every query for trader data goes through one resolver: trader → self; admin → `?as=`. A test walks every endpoint as trader A against trader B's data (R1 writes it; R2/R3 add their endpoints to its list).
- `TradersDb` refuses any collection name outside the list above.
- Desk books, presets and the engine's existing behaviour do not change; R3's engine edit keeps every existing desk-engine and parity test green with no expectation edited.
- No restart of desk processes from a plan task; tasks that need one say "operator restart" and stop there.
