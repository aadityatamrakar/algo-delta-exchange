# Traders Release 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release 3 of Traders: Market Watch, the Range Calculator, Portfolio and the admin roll-up, named strategy groups, the delta band with its events, relief-r advice from a clean state, and the repair list. All of it is analytics, and nothing in it trades.

**Architecture:** Everything server-side lives in `apps/traders` (Release 1) under `analytics/`, `market/`, `books/` and `routes/`. New collections are reached through small store classes over R1's `TradersDb.collection(...)`. R3 builds on R1's book view (`BookView`, `forwardFor`, `monthQuotes`) and R2's `toNeutralize`, `mtmOf`, `bookMargin` and `openWhatIf`. The engine work in `packages/desk-engine` is two pure additions: a `trader` preset (outside `PRESETS`) and an optional `kind: 'future'` on `LegView`. The corridor measures a future leg and no tier ever acts on one. The engine task goes last, on its own commit, and the full desk-engine and parity suites must pass with no expectation edited. Until it lands, band and advice run only on books whose legs are all options of one expiry (the spec's P2 interim rule). The repair search runs `searchRepairs` from `@algomaker/payoff` in two worker threads. A book is keyed by its underlying, stock or index (NIFTY, BANKNIFTY, SENSEX on BFO), and every expiry is priced off R1's forward.

**Tech Stack:** Node 24 (TypeScript by type stripping), `node:test`, `node:worker_threads`, MongoDB 3.7 driver through R1's `TradersDb`, `@algomaker/desk-engine`, `@algomaker/payoff`, `@algomaker/greeks`, `@algomaker/instruments`, React 19 + Astryx (web), vitest + jsdom (web components), Python 3.12 stdlib `unittest` (optional Task 16 only).

**Spec:** `docs/superpowers/specs/2026-10-19-traders-design.md` (items 24–27, 29–32; problems P2, P3, P4, P5, P12, P13; index books, item 3a).
**Contract:** `docs/superpowers/plans/2026-10-19-traders-contract.md`. **Builds on:** `docs/superpowers/plans/2026-10-19-traders-release-1.md` and `docs/superpowers/plans/2026-10-19-traders-release-2.md`. Every name taken from them is used exactly as written there.

## Contract changes requested

None. This plan only **adds** names:

- Endpoint ids, all under `/v1/traders`, in R1's `ENDPOINTS`:

  | id | method | pattern | kind |
  |---|---|---|---|
  | `market.watch` | GET | `/market/:stock` | `trader` |
  | `portfolio.view` | GET | `/portfolio` | `trader` |
  | `admin.portfolio` | GET | `/admin/portfolio` | `admin` |
  | `books.groups` | GET | `/books/:stock/groups` | `trader` |
  | `books.groups.put` | PUT | `/books/:stock/groups` | `trader` |
  | `books.advice` | GET | `/books/:stock/advice` | `trader` |
  | `books.band` | PUT | `/books/:stock/band` | `trader` |
  | `books.repair` | POST | `/books/:stock/repair` | `trader` |

- `BookSummary.band: BandState | null` and `export type BandState = 'in' | 'out' | 'unknown'` in R1's `apps/traders/src/types.ts`.
- One `traders-settings` document per trader for band overrides: `{ kind: 'band', trader, bands: Record<stock, number /* lots */>, updatedAt }`. It is one per trader because R1's index is unique on `{ kind, trader }`. `books.band` uses `$set`/`$unset` on `bands.<STOCK>`.
- Env: `TRADERS_MARKET_WATCH_MAX_TOKENS` (default `1000`).
- Engine: `TRADER_PRESET` (key `'trader'`), `LegKind = 'option' | 'future'`, `LegView.kind?: LegKind`, `isFutureLeg()`.

## Decisions this plan makes beyond the brief (all accepted by the coordinator, 2026-10-19)

1. **The `trader` preset turns the target lock off (`target_pnl: 0`).** On a clean-state pass, relief-r's lock returns a non-null *hold* ("confirming 1/3") on any book at or above ₹2,50,000, before the corridor runs. Advice would go silent on exactly the profitable books. Everything else is relief-r exactly: `delta_shorts_only: false`, `gamma_shorts_only: true`.
2. **`TRADER_PRESET` is exported beside `PRESETS`, not inside it.** `presets.test.ts` asserts 25 presets, each with target 250000. It would also put a trader preset into the desk's dials picker.
3. **The engine work is two tasks.** The preset (Task 8) goes early. The future leg kind (Task 14) goes last, and Task 15 lifts the P2 interim gate. If Task 14 is held back, the rest of R3 still ships, with band and advice on options-only books.
4. **`LegView.kind` is optional, and absent means `'option'`.** 28 `LegView` construction sites in `apps/supervisor`, `apps/api` and the desk-engine tests stay untouched.
5. **The engine acts only on option legs.** In `decide()`, every tier sees the option legs. Only `corridor()` and `rollForward()` see the whole book. A desk book passes the identical object.
6. **Engine legs are built from the BookView's position greeks.** Each per-share greek is the position greek ÷ qty, and the lot is R1's `LegView.lotSize`. The corridor's `netDelta` is then exactly the BookView delta, so the band and To Neutralize read the same delta.
7. **"Out of band by N lots" is the excess past the band, `ceil((|Δ| − band) / lot)`.** To Neutralize stays R2's `toNeutralize` on the whole delta. On the same book the two lot counts may differ.
8. **Market Watch's on-screen subscriptions are capped at `TRADERS_MARKET_WATCH_MAX_TOKENS` (1,000) tokens across all viewers, first come first served (P3).** An underlying that does not fit shows only the strikes R1 already declares, and a sentence says why.
9. **Market Watch's OI change and price change both come from R2's `EodStore` (`deps.eod`) for the previous trading day.** Kite ticks carry no previous close, and `TraderQuote` has no `close`.
10. **Repair is refused after a 20 s wait for one of the two slots** (429 `{ error: 'busy', retryAfterMs }`). The page offers a retry.
11. **"Near, next, far" is the first three listed expiries on or after today, for any underlying.** For NIFTY or BANKNIFTY these are weeklies. A chain with no future of its own is headed by R1's forward and that forward's source.
12. **An index gets ATM ± 40 strikes per expiry in Market Watch; a stock gets every listed strike.**
13. **SENSEX's OI change and price change are blank, with a sentence.** SENSEX trades on BSE, and NSE's end-of-day file has no SENSEX rows.
14. **The advice card shows `historyFrom`.** Positions come from trade files, so anything opened before the history starts, and shares delivered at expiry, count only as manual legs.
15. **R3 adds no cache around R1's payoff or R2's analysis and scenario.** R1's `PayoffCache` and R2's `SnapshotCache` already rebuild at most once per 60 s per book, and immediately on a leg write. R3's own `TtlCache` covers advice, band and Market Watch.

## Names from Releases 1–2 used here

All resolved; N2.10 is R2's `deps.eod`. R3 starts once Releases 1 and 2 are merged.

| # | Name, signature, file | Rel. | Used by |
|---|---|---|---|
| N1.1 | `TradersQuotes { quote(token): TraderQuote \| null; feedAlive(): boolean }`, `TraderQuote { price; bid; ask; oi; volume; asOf; ageMs }`, `apps/traders/src/market/quotes.ts`. `quote()` is the display path, so check `feedAlive()` yourself | R1 | T3, T7, T9 |
| N1.2 | `deps.master(): TradersMaster` (never null), `.options: OptionMaster`; `matchLeg`, `spotTokenOf`, `lotSizeOf` in `market/master.ts` | R1 | T3, T7, T9, T11 |
| N1.3 | `deps.subscriptions: Declarer` with `addTokenSource(name, fn: (nowMs) => readonly number[])`, `refreshNow(): Promise<readonly number[]>`, `market/subscriptions.ts` | R1 | T3 |
| N1.4 | `deps.bookView(trader, stock, nowMs, opts?: { keys?: ReadonlySet<string> }): Promise<BookView \| null>` (null = no open legs; payoff already cached per 60 s, keyed with `keys`) | R1 | T6, T7, T9, T11 |
| N1.5 | `deps.legs.open(trader, stock?)`, `deps.legs.openBooks(): Promise<{ trader, stock }[]>`, `deps.legs.version(trader): number`, `deps.users.list('trader')` | R1 | T1 keys, T6, T9, T11 |
| N1.6 | new collections via store classes over `db.collection('traders-events' \| 'traders-groups' \| 'traders-settings')` | R1 | T6, T9 |
| N1.7 | `TradersDeps` (`src/deps.ts`); `whose(ctx, deps.users): Promise<string>` throws `BadRequest`/`NotFound`/`Forbidden` (`src/auth/whose.ts`); errors and `istDate` in `src/routes/kit.ts`; `STOCK_RE` in `src/routes/books.ts`; routes appended in `src/app.ts` `createApp` | R1 | every route |
| N1.8 | `ENDPOINTS` rows in `src/routes/endpoints.ts` (unlisted path → 404; `kind: 'admin'` enforced centrally); `CASES` in `apps/traders/test/ownership-cases.ts`. In the `Walk`, trader A = `ravi` (holds a manual TCS share leg) and B = `sita` (JINDALSTEL legs, a manual M&M share leg) | R1 | every route |
| N1.9 | `startTraders({ suite, master?, quotes?, now?, deps? })` → `{ url, db, deps, clock, addUser, token, as(user), close }` (`test/harness.ts`); `test/fixtures/master.ts` | R1 | route tests |
| N1.10 | `BookSummary` (`src/types.ts`) and `src/routes/books.ts`: R3 adds `band` | R1 | T9 |
| N1.11 | web: `PAGES` (`pages.tsx`), `BOOK_SUBTABS`, `BOOK_HEADER_CHIPS` (`book.tsx`), `BOOK_TAB_BADGES` (`books.tsx`), `tradersApi`/`tapi` (`api.ts`, R3 appends methods), `usePoll` (`hooks.ts`); runtime imports only from `src/traders/**`, `payoff-curves.tsx`, `format.ts`, `apps/traders/src/types.ts` (server types by `import type`) | R1 | T4, T5, T12, T13 |
| N1.12 | `BookView.historyFrom: string \| null`, `BookView.forwards`, `BookView.futures`, `LegView.lotSize` | R1 | T9, T10 |
| N1.13 | `forwardFor(m, q, stock, expiry, spot, asOf): { price; source: 'future' \| 'parity' \| 'carry' } \| null` and `monthQuotes(m, q, stock, expiry, spot, asOf, closed): MonthQuotes` (`{ expiry, future, forward, source, ivs, tYears }`, plus `quotes: ChainQuoteLite[]` — R1 Task 17, R1's answer to R2's N8), `analytics/month-chain.ts` | R1 | T3, T7, T9 |
| N2.1 | `TRADERS_NSE_DIR` (default `<repo>/data/nse`), one folder per business date; `previousTradingDay(day)` in `analytics/calendar.ts`. R2 owns reading the end-of-day files (N2.10) | R2 | T16 |
| N2.2 | (replaced by N1.13 `monthQuotes`) | R1 | T3, T7 |
| N2.3 | `bookMargin(d: TradersDeps, trader, stock, exclude?): Promise<MarginView \| null>`, `analytics/margin.ts` (time from `d.now()`); `MarginView { available; total: number \| null; span: { file; label; businessDate; savedAt } \| null; stale; missing; notes; … }` in `analytics/wire.ts` | R2 | T11 |
| N2.4 | `mtmOf(d: TradersDeps, trader, stock): Promise<MtmBlock \| null>`, `analytics/mtm.ts` (time from `d.now()`); `MtmBlock.current: { previous; today; total }` (VolHedge's Current MTM) | R2 | T11 |
| N2.5 | `HypotheticalLeg` in `analytics/wire.ts`; web `openWhatIf(stock, legs: readonly WhatIfLeg[], label)` with `WhatIfLeg = Omit<HypotheticalLeg, 'id' \| 'iv'> & { iv? }`, in `apps/web/src/traders/what-if.ts` (opens the Scenario sub-tab with the legs as hypothetical rows; at most 20) | R2 | T7, T10, T13 |
| N2.6 | `toNeutralize(delta, stock, futureExpiry, lotSize): ToNeutralize` (`{ units, pct: null, lots, side: 'Buy' \| 'Sell' \| null, contract, text }`, never null; 0 lots → `Neutral — within half a lot (…)`), `analytics/analysis.ts`; `futureExpiry` = the nearest listed future | R2 | T9 |
| N2.7 | `traders-settings` documents carry `kind`; unique `{ kind, trader }` (R1), hence one band document per trader with `bands: Record<stock, lots>` | R1/R2 | T9 |
| N2.8 | `analysisOf`, `scenarioOf` on deps: not wrapped (R1 `PayoffCache` and R2 `SnapshotCache` already cap payoff, analysis, scenario and margin; Decision 15) | R2 | — |
| — | `liquidIv(solved, strike, type, illiquid): LiquidIv` (`{ iv, source: 'quote' \| 'other-side' \| 'nearest' \| 'none', from }`), `@algomaker/payoff` `illiquid.ts` | R2 | T3 |
| N2.9 | Python: stdlib only, `nsepythonserver` imported lazily inside the fetcher; `unittest` in `scripts/test_<job>.py` (fake fetcher, module loaded by path) run by a node wrapper test that skips without python3; pm2 plain-object entry, `interpreter: secrets.TRADERS_NSE_PYTHON ?? <repo>/.venv-nse/bin/python` (shared venv), `autorestart: false`, `cron_restart` in UTC | R2 | T16 |
| N2.10 | R2's end-of-day reader: `deps.eod: EodStore` (`apps/traders/src/analytics/eod.ts`, R2 Task 10) — `close(c: EodContract): number \| null`, `oi(c: EodContract): number \| null`, `status(): EodStatus { day, fo, cm, missing: string[] }`, refreshed every 60 s; `EodContract { stock, instrument: 'option' \| 'future' \| 'share', expiry, strike \| null, optType: 'CE' \| 'PE' \| null }`; pure parsers in `packages/span/src/eod.ts` (R2 Task 5) | R2 | T3 |

## Global Constraints

- apps/traders never imports at runtime (transitively) `apps/api/src/submit*`, `apps/api/src/repair-apply*`, `apps/order-gateway`, `packages/order-bus`, `packages/brokers`. R1's import-rule test stays green after every task, `repair-worker.ts` included. R3 imports nothing from `apps/api`.
- Node runs `.ts` directly: no enums, namespaces, parameter properties or decorators. Relative imports carry `.ts`/`.tsx`, and type-only imports use `import type`.
- Nothing a trader account can reach places, changes or cancels an order. No Apply, Place, Submit or Manual Order control. Repair and advice offer **Show on payoff** and nothing else (spec item 6).
- Every query for trader data goes through `whose(ctx, deps.users)`. No endpoint takes a trader name from a trader's request. A book the resolved trader does not hold answers 404 `no open book <STOCK>`, as R1's `books.view` does.
- Only `TradersDb` writes. R3 writes `traders-events`, `traders-groups`, and `traders-settings` documents of `kind: 'band'`. Its only desk write is through R1's `Declarer`.
- Every new endpoint gets an `ENDPOINTS` row and a `CASES` entry; a missing case fails R1's suite.
- Tests: `node:test`, a Mongo database per suite named `algomaker_traders_test_<suite>`, run with `DESK_REQUIRE_MONGO=1`, servers on port 0. Tests never call ports 8790–8793, never construct a bus client, and never reach optionbhai.com, NSE or a broker.
- Engine: every existing test under `packages/desk-engine/test` (parity suites included) passes with **no expectation edited**. New engine tests go in new files only.
- No task restarts a desk process or runs `scripts/`. A step that needs `desk-traders` restarted or a pm2 entry started says "operator restart" and stops.
- P13: payoff (R1 `PayoffCache`), analysis and scenario (R2 `SnapshotCache`) are already capped; advice and band are computed at most once per 60 s per book and shared by every viewer. Repair runs one search per book at a time, at most two across all traders, each result kept 60 s.
- P3: Market Watch subscribes only underlyings on screen, only while the page polls, within the 1,000-token cap.
- A book is keyed by an underlying, stock or index. Lot size, strike step, expiries, futures and forwards come from the master and R1's `forwardFor`. Nothing assumes a stock, a monthly expiry, or a future for every expiry.
- Stale data is shown as stale. A dead feed, a missing end-of-day file or an unpriceable leg is said in words, never shown as a live number.
- Labels: BF, BF2 and Ratio carry "our reading of VolHedge, unconfirmed (Phase 0, Q3)". The advice card says "From where the book stands now" (P4), names the expiry it advises on (P5), and gives `historyFrom`.
- Web: Astryx components and tokens only (`apps/web/AGENTS.md`). Pure functions are tested by `node:test` as `apps/web/test/traders/*.test.ts`, components by vitest as `*.test.tsx`.
- Execution: each implementer first runs `git merge --ff-only feat/traders`, then its own `npm ci`. The final `make check` runs once on the merged tree.
- Every commit message ends with `Claude-Session: https://claude.ai/code/session_01UHNb3EES7AmUB124yn1Vq7`.

## Review Focus

1. **A dead feed, or quotes minutes old, on Market Watch, the band or the advice.** Expect a "feed is dead" sentence, band `unknown` and advice `unavailable`, never a live-looking number. Tests: Task 3 `feed dead`, Task 9 `feed dead → band unknown`, Task 10 `feed dead → advice unavailable`.
2. **An ODIN upload between two polls in the same minute.** Expect the next poll to show the new legs. Tests: Task 1 `a new key recomputes`, Task 10 `a new upload inside the minute gives a new card`.
3. **Fewer than three listed expiries, an index weekly with no future, or a book whose nearest held expiry passed.** Expect the chains that exist, each priced off its own forward, and advice on the earliest expiry still held. Tests: Task 3 `two listed expiries` and `a weekly with no future`, Task 9 `near expiry` and `a NIFTY weekly book`.
4. **Outside the session (weekend, holiday, before 09:20, after 15:30).** Expect "Market closed" or "Advice starts at 09:20", the band marked "(market closed)", and no band event written. Tests: Task 10 Saturday and 09:16, Task 9 `no event outside the session`.
5. **A book with no option in its near expiry (shares only, futures only, far month only).** Expect a band from the whole book (after Task 15), the advice "Nothing to adjust in options", and repair "no option legs to repair", never a crash. Tests: Task 7 `shares-only book`, Task 15 `shares-only book has a band`.

---

## File Structure

Server, `apps/traders/src/`:

| File | Responsibility |
|---|---|
| `analytics/cache.ts` | `TtlCache<T>`: a value computed within the last ttl ms is shared |
| `analytics/near-expiry.ts` | `nearExpiryOf`: the earliest option expiry still held (P5) |
| `analytics/vh-columns.ts` | straddle, BF, BF2, Ratio: one small function each, labelled guesses |
| `analytics/market-watch.ts` | expiries, strike window, tokens, and the pure Market Watch builder |
| `market/on-screen.ts` | on-screen underlyings with a TTL and a token cap, as a token source |
| `routes/market.ts` | `market.watch` |
| `books/groups.ts` | `GroupStore`, group validation, per-group totals |
| `routes/groups.ts` | `books.groups`, `books.groups.put` |
| `analytics/what-if.ts` | repair moves and engine actions → R2's `WhatIfLeg` shape |
| `analytics/repair.ts` | `RepairJob` from a BookView (near expiry plus a fixed delta offset), its card |
| `analytics/repair-worker.ts` | worker-thread entry: runs `searchRepairs` on one job |
| `analytics/repair-pool.ts` | two workers, one search per book, 60 s cache, 20 s wait |
| `routes/repair.ts` | `books.repair` |
| `analytics/engine-book.ts` | BookView + near-expiry `ChainSnap` → `EngineInputs` (P2 gate, later future legs) |
| `analytics/band.ts` | `bandOf`, `BandOverrideStore`, `EventStore` |
| `analytics/advice.ts` | `adviceOf`: `decide()` from `EMPTY_RULE_STATE` → card |
| `analytics/risk.ts` | `BookRisk`: band + advice per book, cached one minute |
| `analytics/band-board.ts` | minute loop over every open book; band events on in↔out |
| `routes/advice.ts` | `books.band` (Task 9), `books.advice` (Task 10) |
| `analytics/portfolio.ts` | portfolio rows, totals, month-wise view, admin roll-up (pure) |
| `routes/portfolio.ts` | `portfolio.view`, `admin.portfolio` |
| `routes/r3-deps.ts` | `R3RouteDeps = TradersDeps & { … }` (types only) |
| R1's `app.ts`, `routes/endpoints.ts`, `routes/books.ts`, `types.ts` (modify) | wiring, 8 rows, `band` on summaries |

Engine, `packages/desk-engine/src/`: `presets.ts` (`TRADER_PRESET`), `types.ts` (`LegKind`, `LegView.kind?`), `ladder.ts` (`isFutureLeg`; `sellLotSize` skips futures), `corridor.ts`, `engine.ts`. New tests: `test/trader-preset.test.ts`, `test/future-leg.test.ts`.

Web, `apps/web/src/traders/`: `market-watch.tsx`, `colour-scale.ts`, `market-columns.ts`, `range.ts`, `range-page.tsx`, `portfolio.tsx`, `groups.tsx`, `advice.tsx`; R1's `api.ts` (`tapi` methods), `pages.tsx`, `book.tsx` and `books.tsx` registries.

Tests: `apps/traders/test/fixtures/r3-market.ts` (Task 1) and one suite per area, named in each task. R1's `test/ownership-cases.ts` gains 8 cases.

## Task order and parallelism

```
T1 cache+fixture ─┬─ T3 market (+T2, +R2 T10 deps.eod) ── T4 web market ── (T16 optional)
T2 columns+on-screen ┘
T1 ─┬─ T7 repair ─────────────────────────┐
T8 preset ─┴─ T9 band ── T10 advice ──────┼─ T13 web advice/repair
             T9 ── T11 portfolio ── T12 web portfolio/groups (+T6)
T6 groups, T5 range (independent)
T14 engine future kind (after T9, T10, T13) ── T15 lift gate ── T17 release check
```

Every R3 task starts on a tree where Releases 1 and 2 are merged, which covers R2 Task 10's `deps.eod` and R1 Task 17's `MonthQuotes.quotes`. These can run in parallel: {T1, T2, T5, T6, T8} at once; {T3, T7, T9} once T1 is merged (T3 also needs T2, T9 also needs T8); T4 next to T10 and T11. Parallel tasks meet in R1's `app.ts`, `routes/endpoints.ts`, `test/ownership-cases.ts`, web `api.ts`, and the registries. Every one of those edits is an append. T14 runs alone.

---

### Task 1: Shared pieces — `TtlCache`, `nearExpiryOf`, and the R3 market fixture

**Files:**
- Create: `apps/traders/src/analytics/cache.ts`, `apps/traders/src/analytics/near-expiry.ts`, `apps/traders/test/fixtures/r3-market.ts`
- Test: `apps/traders/test/cache.test.ts`

**Interfaces:**
- Consumes: `TradersMaster`, `TradersQuotes`, `TraderQuote` (N1.1–N1.2); `OptionMaster`, `InstrumentRow` from `@algomaker/instruments`; `b76Price`, `yearsToExpiry` from `@algomaker/greeks`.
- Produces:
  ```ts
  // analytics/cache.ts
  export const MINUTE_MS = 60_000
  export class TtlCache<T> {
    constructor(ttlMs: number, opts?: { maxEntries?: number })   // default maxEntries 2000
    get(key: string, nowMs: number, compute: () => Promise<T>): Promise<T>
    size(): number
  }
  // analytics/near-expiry.ts
  export function nearExpiryOf(view: BookView, todayIst: string): string | null   // earliest option-leg expiry ≥ today; null = no option leg
  // test/fixtures/r3-market.ts
  export const OCT = '2026-10-27', NOV = '2026-11-24', DEC = '2026-12-29'
  export const NIFTY_W1 = '2026-10-20', NIFTY_W2 = '2026-10-27', NIFTY_W3 = '2026-11-03', SENSEX_W1 = '2026-10-22'
  export function r3Master(): TradersMaster
  // TCS: OCT/NOV/DEC, strikes 3300–3500 step 50, a future each month, lot 175, NSE cash row
  // NIFTY: three weeklies, 201 strikes 20000–30000 step 50, a future only on NIFTY_W2, lot 75
  // SENSEX: exchange BFO, one weekly SENSEX_W1, 21 strikes 80000–82000 step 100, no future, lot 20
  // M&M: OCT, 5 strikes, future, lot 700
  export function fakeQuotes(opts?: { feedAlive?: boolean }): TradersQuotes & { set(token: number, q: Partial<TraderQuote>): void }
  export function priceChain(q: ReturnType<typeof fakeQuotes>, m: TradersMaster, stock: string, expiry: string, forward: number, vol: number, asOf: number): void
  // every listed CE/PE: price (LTP) = its Black-76 value (vol, yearsToExpiry), bid/ask ±1% around it, ageMs 0
  ```

- [ ] **Step 1: Write the failing tests** in `cache.test.ts`, using a counting `compute`:
  - `one compute per key inside the ttl, shared by every caller`: `get('a', 0)` and `get('a', 59_999)` → 1 call, and both resolve the same object.
  - `a call at the ttl recomputes`: `get('a', 60_000)` → 2 calls.
  - `concurrent callers share one in-flight compute`: two `get('a', 0)` before the first resolves → 1 call.
  - `a failed compute is not cached`: the first rejects (`assert.rejects`), then `get('a', 1)` → 2 calls.
  - `a new key recomputes`: `get('ravi|TCS|v1', 0)` then `get('ravi|TCS|v2', 1)` → 2 calls. Callers put `deps.legs.version(trader)` in the key.
  - `past maxEntries the oldest goes first`: `maxEntries: 2`, keys a, b, c → `size() === 2`, and `get('a', 2)` recomputes.
  - `near expiry is the earliest held option expiry on or after today` → option legs on 2026-10-16 (past) and NOV, plus a future on OCT → `nearExpiryOf(view, '2026-10-19') === NOV`; shares only → `null`.
  - `the fixture lists what the tasks rely on`: `r3Master().options.expiries('NIFTY')` deep-equals `[NIFTY_W1, NIFTY_W2, NIFTY_W3]`; `options.future('NIFTY', NIFTY_W1) === null`; `options.chain('SENSEX', SENSEX_W1)!.exchange === 'BFO'`; `options.strikes('NIFTY', NIFTY_W1).length === 201`.
- [ ] **Step 2: Run** `node --test apps/traders/test/cache.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `near-expiry.ts`, `cache.ts` (an entry is `{ at, value: Promise<T> }`, and a rejected promise deletes its own entry) and the fixture (`new OptionMaster(rows)` over `InstrumentRow`s, `cash` from the TCS and M&M EQ rows).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(traders): TtlCache, nearExpiryOf and the Release 3 market fixture`.

### Task 2: Market Watch pieces — VolHedge columns and the on-screen set (item 24, P3)

**Files:**
- Create: `apps/traders/src/analytics/vh-columns.ts`, `apps/traders/src/market/on-screen.ts`
- Test: `apps/traders/test/vh-columns.test.ts`, `apps/traders/test/on-screen.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // vh-columns.ts — every one is OUR READING of VolHedge, unconfirmed (Phase 0, Q3)
  export type PriceAt = (strike: number) => number | null
  export function straddle(ce: number | null, pe: number | null): number | null            // CE + PE
  export function butterfly(p: PriceAt, k: number, step: number): number | null            // p(k−s) − 2p(k) + p(k+s)
  export function butterfly2(p: PriceAt, k: number, step: number): number | null           // p(k−2s) − 2p(k) + p(k+2s)
  export function ratio(p: PriceAt, k: number, step: number, type: 'CE' | 'PE'): number | null // CE: p(k) − 2p(k+s); PE: p(k) − 2p(k−s)
  export const GUESS_LABEL = "our reading of VolHedge, unconfirmed (Phase 0, Q3)"

  // on-screen.ts
  export const ON_SCREEN_TTL_MS = 60_000
  export class OnScreenSet {
    constructor(opts: { maxTokens: number; ttlMs?: number })
    touch(underlying: string, tokens: readonly number[], nowMs: number): boolean   // granted: already in, or the union still fits
    underlyings(nowMs: number): readonly string[]
    tokens(nowMs: number): readonly number[]                                      // union of the live sets
  }
  ```

- [ ] **Step 1: Write the failing tests** in `vh-columns.test.ts`. CE prices {80: 21, 90: 14, 100: 8, 110: 3.5, 120: 2}; PE prices {90: 2.5, 100: 6, 110: 11}; step 10:
  - `butterfly(ce, 100, 10) === 1.5`; `butterfly(pe, 100, 10) === 1.5`; `butterfly2(ce, 100, 10) === 7`
  - `ratio(ce, 100, 10, 'CE') === 1`; `ratio(pe, 100, 10, 'PE') === 1`
  - `straddle(8, 6) === 14`; `straddle(8, null) === null`
  - `butterfly(ce, 80, 10) === null`; `ratio(ce, 120, 10, 'CE') === null`
- [ ] **Step 2: Write the failing tests** in `on-screen.test.ts`:
  - `a touched underlying stays for the ttl and then leaves` → `underlyings(59_999)` = `['TCS']`, `underlyings(60_000)` = `[]`.
  - `the cap counts tokens, first come first served` → `maxTokens: 100`: TCS (34 tokens) true, INFY (50) true, SBIN (30) false, TCS again true.
  - `room frees when an underlying goes quiet` → SBIN at 60_001 is true.
  - `a token two underlyings share is counted once` → two sets of 60 that share 30 fit under `maxTokens: 90`.
  - `one underlying larger than the cap is refused`.
- [ ] **Step 3: Run** `node --test apps/traders/test/vh-columns.test.ts apps/traders/test/on-screen.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** both files. Each column function carries `GUESS_LABEL` in its doc comment and is the only place its formula lives.
- [ ] **Step 5: Run** the tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(traders): VolHedge's BF, BF2, Ratio and straddle columns, and the on-screen subscription set`.

### Task 3: Market Watch endpoint (item 24, P3, P12)

**Files:**
- Create: `apps/traders/src/analytics/market-watch.ts`, `apps/traders/src/routes/market.ts`, `apps/traders/src/routes/r3-deps.ts`
- Modify: `apps/traders/src/app.ts` (build `OnScreenSet`; `deps.subscriptions.addTokenSource('market-watch', …)`; append the route), `apps/traders/src/routes/endpoints.ts` (`market.watch`), `apps/traders/test/ownership-cases.ts`, `docs/runbooks/traders.md`
- Test: `apps/traders/test/market-watch.test.ts`, `apps/traders/test/market-route.test.ts`

**Interfaces:**
- Consumes: N1.1, N1.2, N1.3, N1.7, N1.13 (`monthQuotes`, whose forward is `forwardFor`; `spotTokenOf`); R2's `deps.eod: EodStore` (N2.10: `close(c)`, `oi(c)`, `status()`); `liquidIv` from `@algomaker/payoff` (R2, the per-strike rule Analysis uses); `vh-columns.ts`, `OnScreenSet` (Task 2); `TtlCache`, `r3Master`, `fakeQuotes`, `priceChain` (Task 1); `b76Greeks` from `@algomaker/greeks`; `INDEX_SPOT_TOKENS` from `@algomaker/instruments`.
- Produces:
  ```ts
  // market-watch.ts
  export const INDEX_STRIKES_EACH_SIDE = 40
  export function isIndex(underlying: string): boolean                                       // underlying in INDEX_SPOT_TOKENS
  export function marketExpiries(m: TradersMaster, underlying: string, todayIst: string): string[]   // first three listed on or after today (Decision 11)
  export function marketStrikes(m: TradersMaster, underlying: string, expiry: string, spot: number | null): number[]  // stock: every strike; index: ATM ± 40 around spot; no spot → the middle of the list
  export function marketTokens(m: TradersMaster, q: TradersQuotes, underlying: string, todayIst: string): readonly number[]
  // spotTokenOf + the listed futures of those expiries + the nearest listed future + CE/PE of marketStrikes per expiry
  export interface MarketSide {
    ltp: number | null; change: number | null; changePct: number | null
    oi: number | null; oiChange: number | null; volume: number | null
    iv: number | null; ivSource: LiquidIvSource                                    // 'quote' | 'other-side' | 'nearest' | 'none' (R2)
    delta: number | null; gamma: number | null; vega: number | null; theta: number | null   // per share; vega per vol point, theta per day
    bf: number | null; bf2: number | null; ratio: number | null
    ageMs: number | null
  }
  export interface MarketRow { strike: number; straddle: number | null; ce: MarketSide | null; pe: MarketSide | null }
  export interface MarketChain {
    expiry: string; lotSize: number; step: number | null
    future: { ltp: number | null; change: number | null; changePct: number | null; ageMs: number | null } | null   // null = no future for this expiry
    forward: number | null; forwardSource: 'future' | 'parity' | 'carry' | null       // MonthQuotes.forward / .source (R1)
    rows: MarketRow[]
  }
  export interface MarketWatchView {
    stock: string; asOf: number; spot: number | null; feedAlive: boolean
    fullChains: boolean           // false = the token cap was reached
    oiDay: string | null          // the trade date OI and price change are measured from
    chains: MarketChain[]
    labels: { bf: string; bf2: string; ratio: string }
    warnings: string[]
  }
  export interface MarketWatchInput {
    stock: string; nowMs: number; spot: TraderQuote | null; feedAlive: boolean; fullChains: boolean
    chains: { expiry: string; lotSize: number; step: number | null; future: TraderQuote | null; month: MonthQuotes; rows: { strike: number; ce: TraderQuote | null; pe: TraderQuote | null }[] }[]
    eod: Pick<EodStore, 'close' | 'oi' | 'status'>; bse: boolean      // bse = the chain's exchange is BFO
  }
  export function buildMarketWatch(input: MarketWatchInput): MarketWatchView
  export function marketInputOf(m: TradersMaster, q: TradersQuotes, eod: Pick<EodStore, 'close' | 'oi' | 'status'>, stock: string, nowMs: number, fullChains: boolean): MarketWatchInput | null   // null = no listed expiry
  // r3-deps.ts (types only, grows with later tasks)
  export type R3RouteDeps = TradersDeps & { readonly onScreen: OnScreenSet }
  ```
- Endpoint `market.watch`: `GET /v1/traders/market/:stock` → 200 `MarketWatchView`; 404 `{ error: 'no F&O contracts listed for <NAME>' }`. The name is upper-cased and `STOCK_RE`-checked (400). Indices are valid names. The route never calls `whose` (market data, not trader data). The view is cached per underlying in a `TtlCache(2_000)`.

Pricing:
- Each expiry is priced off R1's `monthQuotes(m, q, stock, expiry, spot, now, closed)`. The forward comes from `forwardFor` (future, else parity, else carry), and `ivs` are solved on LTP against that forward, so Market Watch agrees with Analysis.
- A side's IV is `liquidIv(month.ivs, strike, type, false)`: `iv` and `source`.
- Greeks are `b76Greeks` off `month.forward` at that IV and `month.tYears`. LTP is `quote.price`.
- OI and price change come from `deps.eod` for the previous trading day (N2.10). Kite ticks carry no previous close (Decision 9).
  - Each side's contract is `c = { stock, instrument: 'option', expiry, strike, optType }`; for a future, `instrument: 'future'` with `strike`/`optType` null.
  - `oiChange = quote.oi − eod.oi(c)`, `change = ltp − eod.close(c)`, `changePct = change / eod.close(c) × 100`. A null on either side leaves the cell blank.
- `oiDay = eod.status().day` when `status().fo` is set, else null.
- Each name in `status().missing` adds the warning `NSE end-of-day file <name> for <DD Mon> is missing — OI change and price change unknown` (R2's MTM wording).
- A BFO underlying adds, instead, `<NAME> trades on BSE; NSE's end-of-day files do not cover it — OI change and price change unknown` (R2's BSE sentence).

- [ ] **Step 1: Write the failing tests** in `market-watch.test.ts` (`r3Master`, `fakeQuotes`, `priceChain` at vol 0.30; `asOf` = 2026-10-19 10:30 IST):
  - `three chains in expiry order` → TCS: `chains.map(c => c.expiry)` = `[OCT, NOV, DEC]`, each with `forwardSource 'future'`.
  - `an index takes its first three listed expiries` → `marketExpiries(m, 'NIFTY', '2026-10-19')` = `[NIFTY_W1, NIFTY_W2, NIFTY_W3]`.
  - `an index gets ATM ± 40 strikes; a stock gets every strike` → `marketStrikes(m, 'NIFTY', NIFTY_W1, 25010)` has 81 strikes from 23000 to 27000; `marketStrikes(m, 'TCS', OCT, 3400).length === 5`.
  - `marketTokens counts` → TCS: 1 + 3 + 30 = 34; NIFTY: 1 spot + 1 future + 3 × 81 × 2 = 488.
  - `a weekly with no future is headed by its forward` → NIFTY `NIFTY_W1` priced off F = 25,040, both wings quoted → `future === null`, `forwardSource 'parity'`, and the 25000 CE `iv` within 1e-4 of 0.30.
  - `SENSEX: OI change and price change are blank with the BSE sentence` → `warnings` includes `SENSEX trades on BSE; NSE's end-of-day files do not cover it — OI change and price change unknown`.
  - `the IV solved from a Black-76 price is that vol` → TCS OCT 3400 CE: `|iv − 0.30| < 1e-4`, `ivSource 'quote'`, and `delta` within 1e-6 of `b76Greeks` at 0.30.
  - `OI and price change against the previous day` → a fake `eod` whose `oi(c)` is 125000 and `close(c)` is 61.35 for `{ stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE' }`, with `status()` `{ day: '2026-10-16', fo: 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv', cm: 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv', missing: [] }`; tick `oi` 150000 and LTP 64.4 → `oiChange 25000`, `change` 3.05 (to 1e-9), `changePct` 4.971 (to 1e-3), `oiDay === '2026-10-16'`.
  - `a missing end-of-day file → blanks, with the file named` → `status()` `{ day: '2026-10-16', fo: null, cm: …, missing: ['BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'] }` and `oi`/`close` null → every `change`/`oiChange` null, `oiDay === null`, and `warnings` includes `NSE end-of-day file BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv for 16 Oct is missing — OI change and price change unknown`.
  - `a side with no quote is null, not zeros`.
  - `a side whose own quote does not solve borrows the other side's IV and says so` → `ivSource 'other-side'`; with nothing measured anywhere → `ivSource 'none'` and null greeks.
  - `feed dead` → `feedAlive === false`, and `warnings` includes `the market data feed is dead: every price below is the last one seen`.
  - `two listed expiries` → `chains.length === 2`, with no warning about a third.
  - `labels carry the guess wording` → `labels.bf` contains `unconfirmed (Phase 0, Q3)`.
  - `fullChains false` → `warnings` includes `Market Watch is already watching 1,000 contracts for other screens; this one shows only the strikes already watched for open books`.
- [ ] **Step 2: Run** `node --test apps/traders/test/market-watch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `market-watch.ts`. Chain rows are `marketStrikes(...)`.
- [ ] **Step 4: Wire it.**
  - `routes/market.ts` exports `marketRoutes(d: Pick<R3RouteDeps, 'master' | 'quotes' | 'subscriptions' | 'onScreen' | 'now'> & { eod: Pick<EodStore, 'close' | 'oi' | 'status'> }): Route`.
  - Each request computes `marketTokens(...)` and calls `onScreen.touch(...)`. When that adds a new underlying, it calls `subscriptions.refreshNow()`.
  - In `createApp`: `new OnScreenSet({ maxTokens: Number(process.env.TRADERS_MARKET_WATCH_MAX_TOKENS ?? 1000) })` and `subscriptions.addTokenSource('market-watch', (now) => onScreen.tokens(now))`. The `ENDPOINTS` row.
- [ ] **Step 5: Write the route tests** in `market-route.test.ts` (`startTraders({ suite: 'market', master: r3Master(), quotes })`):
  - `GET /v1/traders/market/TCS as a trader → 200 with three chains`.
  - `GET /v1/traders/market/NIFTY → three weekly chains of 81 rows`.
  - `GET /v1/traders/market/M%26M → the name is M&M`.
  - `an unknown name → 404 with the message`; `TCS;DROP → 400`.
  - `no session → 401`.
  - `the declaration holds the on-screen tokens after a GET and drops them 60 s after the last one` → `deps.subscriptions.refreshNow()` result at `clock.now` and at `+60_001`.
  - Case `'market.watch'` → `w.asA('GET', '/v1/traders/market/JINDALSTEL?as=sita')` is 200, and a deep scan of the body finds no `trader`, `legs` or `key` field.
- [ ] **Step 6: Run** the two suites plus R1's `ownership.test.ts` and import-rule suite. Expected: PASS.
- [ ] **Step 7: Runbook.** Document `TRADERS_MARKET_WATCH_MAX_TOKENS` (default 1000, P3), ATM ± 40 for indices, the SENSEX blank, and that an underlying leaves the declaration 60 s after its last poll. desk-marketdata picks this up on its own 30 s refresh, with no restart.
- [ ] **Step 8: Commit** `feat(traders): Market Watch, three chains with greeks for stocks and indices, on-screen subscriptions (item 24, P3, P12)`.

### Task 4: Web — the Market Watch page

**Files:**
- Create: `apps/web/src/traders/market-watch.tsx`, `apps/web/src/traders/colour-scale.ts`, `apps/web/src/traders/market-columns.ts`
- Modify: `apps/web/src/traders/api.ts` (`tapi.market(stock)`), `apps/web/src/traders/pages.tsx` (append `{ id: 'market', label: 'Market Watch' }`)
- Test: `apps/web/test/traders/colour-scale.test.ts`, `apps/web/test/traders/market-columns.test.ts`, `apps/web/test/traders/market-watch.test.tsx`

**Interfaces:**
- Consumes: `MarketWatchView` (Task 3, `import type`), `tradersApi`/`tapi`, `usePoll`, `PAGES` (N1.11).
- Produces:
  ```ts
  export function colourStep(value: number | null, min: number, max: number): -3 | -2 | -1 | 0 | 1 | 2 | 3 | null   // round(3 × value / max(|min|, |max|)), clamped
  export type MarketColumn = 'oiChange' | 'oi' | 'bf' | 'bf2' | 'straddle' | 'ratio' | 'volume' | 'delta' | 'gamma' | 'vega' | 'theta' | 'change' | 'changePct' | 'iv' | 'ltp'
  export const DEFAULT_COLUMNS: readonly MarketColumn[]     // spec item 24's order
  export function loadColumns(storage: Pick<Storage, 'getItem'> | null): MarketColumn[]
  export function saveColumns(storage: Pick<Storage, 'setItem'> | null, cols: readonly MarketColumn[]): void
  // tapi.market(stock: string): Promise<MarketWatchView>   — GET /v1/traders/market/<encodeURIComponent(stock)>
  ```

The page has an underlying picker (free text, `STOCK_RE`, indices allowed) and three stacked chains. A chain with a future is headed `TCS OCT FUT 3,412.50 +12.30 (0.36%)`; one without is headed `NIFTY 20 OCT · forward 25,040.20 (parity)`. Calls are on the left, strike and straddle in the middle, puts on the right, mirrored. Each column is colour-scaled over the visible rows by `colourStep`, mapped to the theme's success and danger tokens (`npx astryx docs tokens`). A column-settings dialog shows, hides and reorders columns. BF, BF2 and Ratio headers carry a tooltip with `labels.*`. The page polls every 5 s while visible and stops when hidden or unmounted, which is what lets the on-screen set expire.

- [ ] **Step 1: Write the failing tests:**
  - `colourStep`: `(0,-10,10) === 0`; `(10,-10,10) === 3`; `(-10,-10,10) === -3`; `(5,-10,10) === 2`; `(null,…) === null`; `(4,4,4) === 0`.
  - `market-columns`: `loadColumns(null)` deep-equals `DEFAULT_COLUMNS`; `'not json'` → defaults; `['ltp','iv']` round-trips; unknown names dropped; a throwing `getItem` → defaults.
  - `market-watch.test.tsx` (mocked `tapi.market`): three chain headings with the future LTP; a chain with `future: null` headed `forward 25,040.20 (parity)`; the BF header tooltip contains `unconfirmed`; `feedAlive: false` shows a Banner containing `feed is dead`; hidden page → no call during 10 s of fake timers; unmount stops polling.
- [ ] **Step 2: Run** `node --test apps/web/test/traders/colour-scale.test.ts apps/web/test/traders/market-columns.test.ts` and `npm run test --workspace @algomaker/web -- traders/market-watch`. Expected: FAIL.
- [ ] **Step 3: Implement** and register the page.
- [ ] **Step 4: Run** both commands, R1's `apps/web/test/traders-imports.test.ts`, and `npm run typecheck --workspace @algomaker/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(traders-web): Market Watch page with colour scale and column settings`.

### Task 5: Range Calculator, pure and in the page (item 25)

**Files:**
- Create: `apps/web/src/traders/range.ts`, `apps/web/src/traders/range-page.tsx`
- Modify: `apps/web/src/traders/pages.tsx` (append `{ id: 'range', label: 'Range' }`)
- Test: `apps/web/test/traders/range.test.ts`, `apps/web/test/traders/range-page.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface RangeInput { cmp: number; startDate: string; vol: number /* percent, 27.7 */; iterations: number /* default 30 */; step: number /* days, default 1 */ }   // stock or index
  export interface RangeBand { lower: number; upper: number; points: number }
  export interface RangeRow { day: number; date: string; changePct: number; s1: RangeBand; s2: RangeBand; s3: RangeBand }
  export function rangeRows(input: RangeInput): RangeRow[] | { error: string }
  ```
  Row `i` (1..iterations) is `day = i × step` and `date = startDate + day` calendar days. `change = (vol/100) × √(day/365)`, `changePct = change × 100`. For k = 1, 2, 3: `lower = cmp × (1 − k·change)`, `upper = cmp × (1 + k·change)`, `points = cmp × k·change`. Values are unrounded; the page rounds to 2 decimals for % and to whole rupees.

- [ ] **Step 1: Write the failing test** `the VolHedge screenshot, exactly` (spec item 25): `rangeRows({ cmp: 7229, startDate: '2026-10-19', vol: 27.7, iterations: 30, step: 1 })`. Row 0: `day === 1`, `date === '2026-10-20'`, `changePct.toFixed(2) === '1.45'`, `Math.round(s1.lower) === 7124`, `Math.round(s1.upper) === 7334`, `Math.round(s1.points) === 105`. Also `s2.lower` within 1e-3 of 7019.376, `s3.upper` within 1e-3 of 7543.436. Row 29: `day === 30`, `changePct` within 1e-3 of 7.9413, `s1.points` within 1e-2 of 574.08.
- [ ] **Step 2: Write the failing tests** `step 5 gives days 5, 10, 15` (iterations 3), and the errors: `cmp 0`, `vol -1`, `iterations 0`, `iterations 400` (cap 365), and `startDate '19-10-2026'` each return `{ error }` naming the field.
- [ ] **Step 3: Run** `node --test apps/web/test/traders/range.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `rangeRows` and the page. Picking an underlying prefills CMP from `tapi.market` (spot, else the first chain's forward). There is one row per day, with 1σ (68%), 2σ (95%) and 3σ (99%) lower/upper/points.
- [ ] **Step 5: Write `range-page.test.tsx`:** CMP 7229 and vol 27.7 show `7,124` and `7,334` in the first row.
- [ ] **Step 6: Run** both runners. Expected: PASS.
- [ ] **Step 7: Commit** `feat(traders-web): Range Calculator, reproducing VolHedge's 7229/27.7 check (item 25)`.

### Task 6: Named strategy groups (item 27)

**Files:**
- Create: `apps/traders/src/books/groups.ts`, `apps/traders/src/routes/groups.ts`
- Modify: `apps/traders/src/app.ts` (build `GroupStore`, `ensureIndexes` in `start()`, append the route), `apps/traders/src/routes/endpoints.ts` (`books.groups`, `books.groups.put`), `apps/traders/src/routes/r3-deps.ts` (`groups: GroupStore`), `apps/traders/test/ownership-cases.ts`
- Test: `apps/traders/test/groups.test.ts`, `apps/traders/test/groups-route.test.ts`

**Interfaces:**
- Consumes: N1.4 (`keys`), N1.5, N1.6, N1.7, N1.9.
- Produces:
  ```ts
  export interface LegGroup { readonly name: string; readonly keys: readonly string[] }
  export const MAX_GROUPS = 20
  export function validateGroups(raw: unknown, legKeys: ReadonlySet<string>): { ok: true; groups: LegGroup[] } | { ok: false; error: string }
  export function groupTotals(legs: readonly LegView[]): BookView['totals']
  export interface GroupView { name: string; keys: string[]; legCount: number; totals: BookView['totals']; payoff: PayoffView | null }
  export interface GroupsView { stock: string; asOf: number; groups: GroupView[]; ungrouped: GroupView }
  export class GroupStore {                 // traders-groups { trader, stock, groups, updatedAt }, unique { trader: 1, stock: 1 }
    constructor(db: TradersDb, now: () => number)
    ensureIndexes(): Promise<void>
    get(trader: string, stock: string): Promise<LegGroup[]>
    set(trader: string, stock: string, groups: readonly LegGroup[]): Promise<void>
  }
  ```
- Endpoints: `books.groups` (GET) → `GroupsView`. `books.groups.put` (PUT `{ groups }`) → 200 `GroupsView`, or 400 `{ error }`. Both answer 404 `no open book <STOCK>` when `deps.bookView` returns null. A stored key that is no longer open is dropped on read. Per-group payoff is `deps.bookView(trader, stock, now, { keys })`; R1's cache keys on `keys`.

- [ ] **Step 1: Write the failing tests** in `groups.test.ts`:
  - `a valid body` with groups `Oct straddle` [k1, k2] and `hedge` [k3] → ok, with names trimmed.
  - Refusals, each with `error` text: `leg k1 is in two groups`; `unknown leg keys: kX`; `two groups are named "hedge"` (case-insensitive); `"ungrouped" is reserved`; `a group needs a name`; `a group name is at most 40 characters`; `at most 20 groups`; `groups must be an array`.
  - `groupTotals sums position greeks and MTM` → delta 100 and −40, gamma −2 and 1, mtm 500 and null → `{ delta: 60, gamma: -1, …, mtm: 500 }`.
- [ ] **Step 2: Run** `node --test apps/traders/test/groups.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `groups.ts` and `routes/groups.ts` (`groupsRoutes(d: Pick<R3RouteDeps, 'users' | 'bookView' | 'groups' | 'now'>): Route`), and register both rows.
- [ ] **Step 4: Write the route tests** in `groups-route.test.ts` (`startTraders({ suite: 'groups' })`, R1's TCS fixture):
  - `PUT then GET round-trips, and untagged legs are ungrouped` → `ungrouped.legCount` = open legs − tagged.
  - `each group carries its own payoff` → `groups[0].payoff !== null`.
  - `a closed leg's key is dropped on read`.
  - `admin acts with ?as=` → stored under that trader.
  - Cases: `'books.groups'` → `w.asA('GET', '/v1/traders/books/JINDALSTEL/groups?as=sita')` is 404. `'books.groups.put'` → `w.asA('PUT', '/v1/traders/books/TCS/groups?as=sita', { groups: [{ name: 'x', keys: await w.b.legKeys() }] })` is 400 with `unknown leg keys`, and sita's groups (read as admin) stay empty.
- [ ] **Step 5: Run** the two suites plus R1's ownership, import-rule and single-writer suites. Expected: PASS.
- [ ] **Step 6: Commit** `feat(traders): named groups inside a book with per-group totals and payoff (item 27)`.

### Task 7: Repair search on a trader book (item 31, P13)

**Files:**
- Create: `apps/traders/src/analytics/what-if.ts`, `apps/traders/src/analytics/repair.ts`, `apps/traders/src/analytics/repair-worker.ts`, `apps/traders/src/analytics/repair-pool.ts`, `apps/traders/src/routes/repair.ts`
- Modify: `apps/traders/src/app.ts` (`repair: RepairPool` over `workerRunner(2)`, closed in `stop()`; append the route), `apps/traders/src/routes/endpoints.ts` (`books.repair`), `apps/traders/src/routes/r3-deps.ts`, `apps/traders/test/ownership-cases.ts`, `docs/runbooks/traders.md`
- Test: `apps/traders/test/what-if.test.ts`, `apps/traders/test/repair.test.ts`, `apps/traders/test/repair-pool.test.ts`, `apps/traders/test/repair-route.test.ts`

**Interfaces:**
- Consumes: `searchRepairs`, `atomicMoves`, `DEFAULT_REPAIR_DIALS`, `ivFor`, and types `PayoffLeg`, `RepairPlan`, `PlanScore`, `Goal`, `StrikeInfo`, `SolvedIv`, `Move`, `RepairDials` from `@algomaker/payoff`; `b76Greeks` from `@algomaker/greeks`; N1.1, N1.2, N1.4, N1.5, N1.7, N1.13 (`monthQuotes`); `HypotheticalLeg` (N2.5); `nearExpiryOf` and the fixture (Task 1).
- Produces:
  ```ts
  // what-if.ts — R2's WhatIfLeg shape (web what-if.ts), built server-side
  export type WhatIfLeg = Omit<HypotheticalLeg, 'id' | 'iv'>
  export function whatIfOfMoves(moves: readonly Move[], legs: readonly PayoffLeg[], priceOf: (strike: number, type: OptType) => number | null, expiry: string): WhatIfLeg[]
  // add/hedge → that leg at the chain price; close → the leg's opposite qty at the chain price; shift → close + open at toStrike

  // repair.ts
  export interface RepairJob {             // structured-cloneable: no functions
    legs: PayoffLeg[]; future: number; today: string; expiry: string; realised: 0
    dials: RepairDials; strikes: StrikeInfo[]; solved: SolvedIv[]; tailCapRupees?: number
  }
  export const OFFSET_LEG_ID = 'offset'
  export type RepairJobResult = { job: RepairJob; offsetShares: number; warnings: string[] } | { blocked: string }
  export function repairJobOf(view: BookView, month: MonthQuotes, lotSize: number, nowMs: number, tailCap: number | null): RepairJobResult
  export function runRepairJob(job: RepairJob): readonly RepairPlan[]     // rebuilds priceOf/ivOf from strikes/solved, calls searchRepairs
  export interface RepairCardPlan { moves: readonly Move[]; score: PlanScore; flags: readonly string[]; lines: string[]; whatIf: WhatIfLeg[] }
  export interface RepairView {
    stock: string; expiry: string | null; asOf: number; computedAt: number; cached: boolean
    goals: { goal: Goal; plans: RepairCardPlan[] }[]
    offset: { shares: number; note: string } | null
    warnings: string[]; error: string | null
  }
  export function repairViewOf(stock: string, r: RepairJobResult, plans: readonly RepairPlan[], computedAt: number, cached: boolean, nowMs: number): RepairView

  // repair-pool.ts
  export const REPAIR_MAX_RUNNING = 2, REPAIR_CACHE_MS = 60_000, REPAIR_WAIT_MS = 20_000
  export type RepairRunner = (job: RepairJob) => Promise<readonly RepairPlan[]>
  export type PoolAnswer = { plans: readonly RepairPlan[]; computedAt: number; cached: boolean } | { busy: true; retryAfterMs: number }
  export class RepairPool {
    constructor(opts: { run: RepairRunner; now?: () => number; maxRunning?: number; cacheMs?: number; waitMs?: number })
    request(bookId: string, cacheKey: string, job: RepairJob): Promise<PoolAnswer>
    running(): number
  }
  export function workerRunner(size?: number): { run: RepairRunner; close(): Promise<void> }   // node:worker_threads; one job per worker at a time
  ```

The job: its legs are the BookView's matched option legs of the near expiry and its future legs of that same expiry, as `PayoffLeg`s (id = leg key, qty signed, entry = avgPrice, iv from the view). For an index the near expiry is usually a weekly. `month = monthQuotes(...)` for that expiry. `future = month.forward` (null forward → `{ blocked: 'no forward for <expiry> yet' }`). `strikes` come from `month.quotes`, `month.ivs`, and the Black-76 delta at each strike's IV, as the desk's `chainLookups` builds them. `solved = month.ivs`. Every other leg (other expiries, shares, other futures) becomes one future leg with `id: OFFSET_LEG_ID`, `qty: round(Σ their position delta)` and `entry: future`, so its P&L starts at 0 (P5). `realised` is 0, and the view says so. Plans that `close` or `shift` the offset are dropped and counted. `dials = { ...DEFAULT_REPAIR_DIALS, lotSize }`. The pool's `bookId` is `trader|stock`; its `cacheKey` is `trader|stock|legs.version(trader)|tailCap`. A request whose `bookId` is in flight with the same key shares that run; with a different key it is `{ busy: true, retryAfterMs: 2000 }`.

- Endpoint `books.repair`: POST with body `{ tailCap?: number }` (a positive rupee figure, else 400) → 200 `RepairView`; 429 `{ error: 'busy', retryAfterMs }`; 404 `no open book <STOCK>`.

- [ ] **Step 1: Write the failing tests** in `what-if.test.ts`. A `close` on k1 (qty −350, 3400 CE, price 61) → `[{ instrument: 'option', expiry: '2026-10-27', strike: 3400, optType: 'CE', qty: 350, price: 61 }]`. A `shift` k1 → 3500 gives two legs (+350 at 3400, −350 at 3500). An `add` of 3300 PE qty −175 gives one leg. A null price → the move is dropped, with no throw.
- [ ] **Step 2: Write the failing tests** in `repair.test.ts`:
  - `near expiry only, the rest as one offset` → TCS: OCT short 3400 CE −350 (position delta −140), NOV long 3500 CE +175 (+80), 1000 shares → `job.expiry === OCT`, legs `['<oct key>', 'offset']`, offset qty 1080, `offsetShares === 1080`.
  - `a NIFTY weekly book is scored off its forward` → NIFTY `NIFTY_W1` short 25000 CE −750 plus a long `NIFTY_W2` future +75 → `job.expiry === NIFTY_W1`, `job.future === month.forward` (parity), the future goes into the offset (+75), `dials.lotSize === 75`.
  - `a plan that closes the offset is dropped and counted` → `warnings` includes `1 plan touched the other expiries' fixed offset and was dropped`.
  - `shares-only book` → `{ blocked: 'no option legs to repair: TCS holds only shares' }`.
  - `far month only` → `job.expiry` is that month.
  - `runRepairJob on a small fixture returns a baseline per goal` → each of the 4 goals has a plan whose `flags` include `baseline`.
  - `view says realised is not counted` → `warnings` includes `P&L already booked is not counted in these figures`.
- [ ] **Step 3: Write the failing tests** in `repair-pool.test.ts` (a fake `run` resolved by hand):
  - `two run at once, a third waits` → `running() === 2`; resolving one starts the third.
  - `one search per book: the same request shares the run`.
  - `the same book with a different key is busy` → `{ busy: true, retryAfterMs: 2000 }`.
  - `a result is kept 60 s` → 59_999 ms gives `cached: true` with no run; 60_000 ms runs again.
  - `waiting past 20 s answers busy`.
  - `a run that throws is not cached and frees its slot`.
  - `workerRunner really runs in a worker` → `workerRunner(1).run(smallJob)` deep-equals `runRepairJob(smallJob)`; then `close()`.
- [ ] **Step 4: Run** `node --test apps/traders/test/what-if.test.ts apps/traders/test/repair.test.ts apps/traders/test/repair-pool.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement** the five files. `repair-worker.ts` imports only `./repair.ts` and `node:worker_threads`, and posts `{ ok: true, plans }` or `{ ok: false, error }`.
- [ ] **Step 6: Write the route tests** in `repair-route.test.ts` (`startTraders({ suite: 'repair', master: r3Master(), quotes, deps: { repair: new RepairPool({ run: workerRunner(1).run }) } })`):
  - `POST returns four goals and a whatIf per plan`.
  - `a second POST inside 60 s is cached`.
  - `a leg write changes the key and recomputes`.
  - `tailCap -5 → 400`.
  - Case `'books.repair'` → `w.asA('POST', '/v1/traders/books/JINDALSTEL/repair?as=sita', {})` is 404.
- [ ] **Step 7: Run** the four suites plus R1's import-rule suite (which must cover `repair-worker.ts`). Expected: PASS.
- [ ] **Step 8: Runbook:** repair runs in 2 worker threads inside `desk-traders`; note the caps, and that 429 means busy.
- [ ] **Step 9: Commit** `feat(traders): repair search on a trader book in two workers, one per book, cached 60 s (item 31, P13)`.

### Task 8: Engine — the `trader` preset (P2, part 1 of 2)

**Files:**
- Modify: `packages/desk-engine/src/presets.ts` (after `PRESETS`)
- Test: `packages/desk-engine/test/trader-preset.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  /** Trader books (apps/traders): relief-r counting the WHOLE book's delta (spec P2), lock off. NOT in PRESETS. */
  export const TRADER_PRESET: Preset   // key 'trader', label 'Trader (relief-r, whole-book delta)'
  ```
  `dials = { ...RELIEF_BOARD, delta_shorts_only: false, gamma_shorts_only: true, target_pnl: 0 }`. The header comment gives Decisions 1–2.

- [ ] **Step 1: Record the baseline:** `node --test packages/desk-engine/test/*.test.ts 2>&1 | tail -8`. Note `# pass`.
- [ ] **Step 2: Write the failing tests:**
  - `trader is relief-r with two dials changed and nothing else` → diff against `PRESETS.find(p => p.key === 'recenter-relief-r').dials` over the union of keys → exactly `{ delta_shorts_only: false, target_pnl: 0 }`.
  - `gamma stays shorts-only` → `gamma_shorts_only === true`.
  - `trader is not a desk preset` → `PRESETS.some(p => p.key === 'trader') === false`.
  - `it resolves with nothing refused` → `resolveDials(TRADER_PRESET.dials).unknown` deep-equals `[]`.
  - `the clean-state facts advice relies on` → resolved: `anchor_ema_marks 0`, `confirm_marks 0`, `unwind_enabled false`, `recycle_frac 0`, `eod_flat_min 0`, `balance_enabled false`, `target_snap_multiple 0`, `delta_lean_enabled false`.
- [ ] **Step 3: Run** `node --test packages/desk-engine/test/trader-preset.test.ts`. Expected: FAIL.
- [ ] **Step 4: Add `TRADER_PRESET`.** No new import; nothing above it changes.
- [ ] **Step 5: Run the full desk-engine suite and typecheck:** `node --test packages/desk-engine/test/*.test.ts 2>&1 | tail -8` and `npx tsc -p tsconfig.json`. Expected: `# fail 0`, `# pass` = baseline + 5, tsc clean, and `git diff --stat -- packages/desk-engine/test` lists only `trader-preset.test.ts`.
- [ ] **Step 6: Commit on its own:** `feat(desk-engine): trader preset — relief-r on whole-book delta, lock off, outside PRESETS`.

### Task 9: The delta band, its events and its override (item 30)

**Files:**
- Create: `apps/traders/src/analytics/engine-book.ts`, `apps/traders/src/analytics/band.ts`, `apps/traders/src/analytics/risk.ts` (band half), `apps/traders/src/analytics/band-board.ts`, `apps/traders/src/routes/advice.ts` (`books.band`)
- Modify: `apps/traders/src/types.ts` (`BandState`, `BookSummary.band`), `apps/traders/src/routes/books.ts` (`band` from the board), `apps/traders/src/app.ts` (stores, `BookRisk`, `BandBoard`: `load()` and `start()` in `start()`, `stop()` in `stop()`), `apps/traders/src/routes/endpoints.ts` (`books.band`), `apps/traders/src/routes/r3-deps.ts`, `apps/traders/test/ownership-cases.ts`
- Test: `apps/traders/test/engine-book.test.ts`, `apps/traders/test/band.test.ts`, `apps/traders/test/band-board.test.ts`, `apps/traders/test/band-route.test.ts`

**Interfaces:**
- Consumes: `TRADER_PRESET` (Task 8); `corridor`, `resolveDials`, `isTradingDay`, `RULES_START_MIN`, `SESSION_CLOSE_MIN` and types `ChainSnap`, `EngineInputs`, `LegView as EngineLeg`, `Quote`, `StrikeQuote`, `Dials` from `@algomaker/desk-engine`; `toNeutralize`, `ToNeutralize` (N2.6); `nearExpiryOf` (Task 1); N1.1, N1.2, N1.4, N1.5, N1.6, N1.12; `TtlCache`, Task 1 fixture.
- Produces:
  ```ts
  // engine-book.ts
  export function chainSnapOf(m: TradersMaster, q: TradersQuotes, view: BookView, expiry: string, nowMs: number): ChainSnap | null   // null = no forward for that expiry
  export interface EngineBook { inputs: EngineInputs; expiry: string; lotSize: number; nearFuture: { expiry: string; lotSize: number } | null; offsetShares: number; notes: string[] }
  export type EngineBookResult = EngineBook | { blocked: string }
  export function engineBookOf(view: BookView, chain: ChainSnap, nearFuture: EngineBook['nearFuture'], nowMs: number): EngineBookResult
  export const P2_GATE = 'Band and advice read one expiry of options only until the engine learns futures legs (spec P2): '

  // band.ts
  export interface BandStatus {
    state: BandState; netDelta: number | null; bandShares: number | null; bandLots: number | null
    outByLots: number; lotSize: number | null; source: 'engine' | 'override'
    toNeutralize: ToNeutralize | null; marketOpen: boolean; sentence: string
  }
  export const TRADER_DIALS: Dials    // resolveDials(TRADER_PRESET.dials).dials
  export function bandOf(book: EngineBookResult, stock: string, override: number | null, feedAlive: boolean, marketOpen: boolean): BandStatus
  export interface BandEvent { trader: string; stock: string; kind: 'band'; from: 'in' | 'out'; to: 'in' | 'out'; at: number; netDelta: number; bandShares: number; lotSize: number; outByLots: number; source: 'engine' | 'override' }
  export class EventStore { constructor(db: TradersDb); ensureIndexes(): Promise<void>; add(e: BandEvent): Promise<void>; lastBand(): Promise<BandEvent[]> }   // traders-events, index { trader: 1, stock: 1, at: -1 }
  export class BandOverrideStore {      // traders-settings { kind: 'band', trader, bands: Record<stock, number>, updatedAt } — one per trader (R1's unique { kind, trader })
    constructor(db: TradersDb, now: () => number)
    get(trader: string, stock: string): Promise<number | null>
    set(trader: string, stock: string, lots: number | null): Promise<void>   // $set bands.<STOCK> / $unset
  }

  // risk.ts
  export class BookRisk {
    constructor(d: Pick<R3RouteDeps, 'bookView' | 'legs' | 'master' | 'quotes' | 'bands' | 'now'>)
    band(trader: string, stock: string, nowMs: number): Promise<BandStatus | null>   // null = no open book; TtlCache(MINUTE_MS), key trader|stock|legs.version|override
  }
  // band-board.ts
  export class BandBoard {
    constructor(d: { risk: BookRisk; events: EventStore; legs: Pick<LegStore, 'openBooks'>; now: () => number })
    load(): Promise<void>; tick(nowMs: number): Promise<number>; state(trader: string, stock: string): BandState | null
    start(): void; stop(): void         // setInterval 60 s, unref'd
  }
  ```
- Endpoint `books.band`: PUT `{ lots: number | null }` (`null` clears; else finite, > 0, ≤ 1000, rounded to 1 decimal) → 200 `BandStatus`; 400; 404 `no open book <STOCK>`. A trader or an admin (`?as=`) may set it. `GET /books` rows carry `band: board.state(trader, stock)`.

The adapter, before Task 15: the near expiry is `nearExpiryOf(view, today)`. `engineBookOf` returns `{ blocked: P2_GATE + 'this book also holds <futures|shares|options of 3 Nov>.' }` unless every matched leg is an option of that expiry. Each such leg becomes an engine leg:
- `instrument` = the leg key; `side = qty < 0 ? 'Sell' : 'Buy'`; `lotSize` = `LegView.lotSize`; `lots = |qty| / lotSize`; `entry = avgPrice`.
- Per-share greeks are position greek ÷ qty, with `delta = |delta / qty|` (Decision 6).
- `iv`; `hasGreeks = iv !== null`; `mtm = mtm ?? 0`; `exit` = the leg's quote; `openedByEngine: false`; `leanId: ''`.
- Unmatched legs are left out with a note.

`ChainSnap` comes from `chainSnapOf`:
- `spot = view.forwards[expiry]` (R1's forward: the future, else parity, else carry).
- `future` = that expiry's future quote when listed, else the print `{ bid: null, ask: null, ltp: forward, asOf: nowMs }` (the convention in `apps/supervisor/src/chain-view.ts` §5).
- `step` and `lotSize` come from `options.chain(stock, expiry)`; `strikes` are the listed rows from the quote cache (both-or-neither bid/ask).

`EngineInputs`:
- `tag 'traders:<trader>:<stock>'`, `mode 'paper'`, the IST date and minute, `dte` = calendar days to expiry.
- `protectedQty {}`, `cumRealized 0`, `margin { value: 0, source: 'model', asOf: nowMs, fresh: false }`, `pendingLots 0`, `repairHold false`, `pricing 'live'`.

`nearFuture` is `options.future(stock)` (the nearest listed future) with its lot.

Band: `cor = corridor(inputs, TRADER_DIALS)`; `bandShares = override === null ? cor.allowed : override × lotSize`; `bandLots = bandShares / lotSize` to 1 decimal.
- State: `unknown` when blocked, `!feedAlive` or `!cor.hasGreeks`; else `out` iff `|netDelta| > bandShares`.
- `outByLots = ceil((|netDelta| − bandShares) / lotSize)` when out, else 0.
- `toNeutralize = toNeutralize(netDelta, stock, nearFuture.expiry, nearFuture.lotSize)` (never null). It is not called, and stays null, only when the underlying lists no future.

Sentences, exactly:
- in: `In band (±4.8 lots)`
- out: `Out of band by 1 lot — To neutralize: Buy 5 lots TCS OCT FUT`. The tail is `toNeutralize.text`; with no listed future, the dash and tail are dropped.
- unknown: the blocking reason, or `Band unknown: the market data feed is dead`, or `Band unknown: a leg has no IV (<contractText>)`.
- When the market is closed, ` (market closed)` is appended to an in or out sentence.

Board: once a minute, only when `isTradingDay(dateIst)` and `RULES_START_MIN ≤ minute ≤ SESSION_CLOSE_MIN`, it evaluates every `legs.openBooks()` row through `BookRisk.band`. When the state is `in` or `out` and differs from the last (a book with no event starts as `in`), it writes one `BandEvent`. `unknown` never writes and never resets the last state.

- [ ] **Step 1: Write the failing tests** in `engine-book.test.ts` (`r3Master`, `fakeQuotes`, `priceChain`; quotes with `ageMs` 0 and a 2% spread, so the engine's liquidity gate passes):
  - `engine legs carry per-share greeks from the view` → qty −350, position delta −140 → engine `delta 0.4`, `side 'Sell'`, `lots 2`, `lotSize 175`.
  - `netDelta equals the BookView delta` → `corridor(inputs, TRADER_DIALS).netDelta` within 1e-9 of `Σ legs.delta`.
  - `a NIFTY weekly book` → `NIFTY_W1` options only: `chain.spot === view.forwards[NIFTY_W1]`, `chain.future.bid === null`, `chain.lotSize === 75`, `chain.step === 50`, `nearFuture.expiry === NIFTY_W2`.
  - `P2 gate: a future leg blocks` → ends `this book also holds futures.`; `P2 gate: an option of another expiry blocks` → ends `this book also holds options of 24 Nov.`
  - `unmatched legs are left out with a note` → `1 row not understood is left out`.
- [ ] **Step 2: Write the failing tests** in `band.test.ts`. A book of short 10 lots CE (per-share δ 0.8, γ 0.04) and short 10 lots PE (δ 0.3, γ 0.04), lot 25, spot 300, nearest future TCS OCT, built as an `EngineBook` on a bare chain:
  - `the band is the engine's corridor under trader, in lots` → `bandShares 120`, `bandLots 4.8`.
  - `out by the excess, neutralize by the whole delta` → `netDelta -125`, `state 'out'`, `outByLots 1`, `toNeutralize.text 'Buy 5 lots TCS OCT FUT'`, `sentence 'Out of band by 1 lot — To neutralize: Buy 5 lots TCS OCT FUT'`.
  - `an override of 2 lots` → `bandShares 50`, `outByLots 3`, `source 'override'`.
  - `in band` → CE δ 0.5: `sentence 'In band (±4.8 lots)'`.
  - `feed dead → band unknown`; `a leg with no IV → unknown, naming the leg`; `market closed suffix`; `blocked → unknown with the gate sentence`.
  - `BandOverrideStore keeps one document per trader` (Mongo suite `band`) → set TCS 2 and NIFTY 3 for ravi → one `traders-settings` document `{ kind: 'band', trader: 'ravi', bands: { TCS: 2, NIFTY: 3 } }`; setting TCS to null leaves `bands: { NIFTY: 3 }`.
- [ ] **Step 3: Write the failing tests** in `band-board.test.ts` (a fake `BookRisk` with scripted states, an in-memory `EventStore`):
  - `in → out → in writes two events` → ticks at 10:00, 10:01, 10:02 IST on 2026-10-19 → `[{ from: 'in', to: 'out' }, { from: 'out', to: 'in' }]`.
  - `a new book that starts out writes in → out`.
  - `unknown writes nothing and keeps the last state`.
  - `load() restores the last state, so a restart writes no duplicate`.
  - `no event outside the session` → 09:16, 15:31 and Saturday 2026-10-24 → 0 events.
- [ ] **Step 4: Run** `node --test apps/traders/test/engine-book.test.ts apps/traders/test/band.test.ts apps/traders/test/band-board.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement** the files, the stores (indexes in `start()`), the `books.band` route (`adviceRoutes`), and `band` on `GET /books`.
- [ ] **Step 6: Write the route tests** in `band-route.test.ts` (`startTraders({ suite: 'band', master: r3Master(), quotes })`):
  - `PUT { lots: 2 } then GET /books shows the row's band`; `PUT { lots: null } clears`; `lots 0, -1, 1001, 'x' → 400`; `admin with ?as= sets the trader's override`.
  - Case `'books.band'` → `w.asA('PUT', '/v1/traders/books/JINDALSTEL/band?as=sita', { lots: 2 })` is 404, and sita has no band document.
- [ ] **Step 7: Run** the four suites plus R1's ownership and single-writer suites. Expected: PASS.
- [ ] **Step 8: Commit** `feat(traders): delta band from the engine's corridor under trader, events on in↔out, override in lots (item 30)`.

### Task 10: relief-r advice from a clean state (item 32, P4, P5)

**Files:**
- Create: `apps/traders/src/analytics/advice.ts`
- Modify: `apps/traders/src/routes/advice.ts` (`books.advice`), `apps/traders/src/analytics/risk.ts` (`advice()`), `apps/traders/src/routes/endpoints.ts`, `apps/traders/test/ownership-cases.ts`
- Test: `apps/traders/test/advice.test.ts`, `apps/traders/test/advice-route.test.ts`

**Interfaces:**
- Consumes: `decide`, `EMPTY_RULE_STATE`, `markOf`, `SESSION_OPEN_MIN`, `MARK_STEP_MIN`, `PRESETS`, `resolveDials`, `EngineAction` from `@algomaker/desk-engine`; `EngineBookResult`, `BandStatus`, `TRADER_DIALS`, `BookRisk` (Task 9); `WhatIfLeg` (Task 7); N1.12 (`historyFrom`).
- Produces:
  ```ts
  export interface AdviceCard {
    stock: string; asOf: number; computedAt: number
    status: 'advice' | 'hold' | 'unavailable'
    headline: string                 // first action line, 'Hold', 'Market closed', 'Advice starts at 09:20', 'Nothing to adjust in options', or why unavailable
    lines: string[]                  // 'Sell 2 lots TCS OCT 3500 CE', 'Buy back 1 lot TCS OCT 3300 PE'
    reason: string                   // decision.reason, verbatim
    trigger: string
    whatIf: WhatIfLeg[]
    notes: string[]
    band: BandStatus
    historyFrom: string | null
  }
  export function historyNote(historyFrom: string | null): string
  // '2026-10-01' → 'Built from trades since 2026-10-01. Positions opened before then, and shares delivered at expiry, count only if added as manual legs.'
  // null → 'The start of the trade history is not known. Positions opened before it, and shares delivered at expiry, count only if added as manual legs.'
  export const P4_NOTE = 'From where the book stands now: the engine starts clean each time and does not remember earlier suggestions.'
  export const SHIFT_NOTE = "relief-r's margin-gated shift needs a broker margin figure, which a trader book does not have, so this card never suggests a shift."
  export function adviceOf(book: EngineBookResult, band: BandStatus, stock: string, historyFrom: string | null, nowMs: number, feedAlive: boolean): AdviceCard
  export function whatIfOfActions(actions: readonly EngineAction[], book: EngineBook): WhatIfLeg[]
  // BookRisk
  advice(trader: string, stock: string, nowMs: number): Promise<AdviceCard | null>   // shares the one-minute entry with band()
  ```

Rules:
- **The call.** `adviceOf` calls `decide(book.inputs, TRADER_DIALS, EMPTY_RULE_STATE, { isNewMark: true, markIndexToday: (markOf(minute) − SESSION_OPEN_MIN) / MARK_STEP_MIN })` and keeps nothing between calls.
- **Action words.** Open Sell → `Sell`; open Buy → `Buy`; close of a short → `Buy back`; close of a long → `Sell out`; resize → the lots between held and target.
- **Status.** `unavailable` when blocked or the feed is dead; `hold` when `decision.action === 'hold'`; else `advice`.
- **Hold headline.** `Market closed` on a non-trading day or after 15:30; `Advice starts at 09:20` before 09:20; `Nothing to adjust in options` when the book has no option leg; else `Hold`.
- **Notes**, in order:
  1. `historyNote(historyFrom)`
  2. `P4_NOTE`
  3. `SHIFT_NOTE`
  4. `Advises on the 27 Oct expiry only.`
  5. With an override: `Your band is overridden to 2 lots; relief-r acts on its own band of 4.8 lots.`

- Endpoint `books.advice`: GET → 200 `AdviceCard`; 404 `no open book <STOCK>`. Nothing is ever submitted, and no route takes a card back.

- [ ] **Step 1: Write the failing tests** in `advice.test.ts` (Task 9's fixture; 2026-10-19 11:00 IST unless stated):
  - `relief-r's own lock cannot fire from a clean state in one pass` → Σmtm 3,00,000 under `resolveDials(PRESETS 'recenter-relief-r').dials`, through `decide` directly → `action 'hold'`, `trigger 'lock'`, `reason` contains `confirming 1/3` (Decision 1).
  - `under trader the same book gets corridor advice` → `adviceOf(...).trigger !== 'lock'`.
  - `a book out of band gets sells on the shed side` → netDelta > 0 and excess past the floor → `status 'advice'`, every line starts `Sell `, every open is `optType 'CE'`, `reason === decision.reason`.
  - `nothing is carried between passes` → two calls deep-equal apart from `computedAt`.
  - `whatIf mirrors the actions` → one open Sell 2 lots 3500 CE, lot 175 → `[{ instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, price: <chain mid> }]`.
  - `notes start with the history line` → `historyFrom '2026-10-01'`: `card.historyFrom === '2026-10-01'`, and `notes[0]` is the dated sentence; with `null`, the unknown-start sentence; `notes` include `P4_NOTE`, `SHIFT_NOTE` and `Advises on the 27 Oct expiry only.`
  - `a NIFTY weekly book advises on its weekly` → `Advises on the 20 Oct expiry only.`, and any open names `NIFTY_W1` with qty a multiple of 75.
  - `Saturday` → `status 'hold'`, `headline 'Market closed'`, `reason` contains `not an NSE trading day`.
  - `09:16` → `headline 'Advice starts at 09:20'`, `reason` contains `the rules start at 09:20`.
  - `feed dead → advice unavailable` → `headline 'No advice: the market data feed is dead'`.
  - `blocked → unavailable with the P2 sentence`.
- [ ] **Step 2: Run** `node --test apps/traders/test/advice.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `advice.ts` and `BookRisk.advice()`. Band and advice share one cached `{ band, advice }` per book, so the board's minute tick warms the advice for viewers.
- [ ] **Step 4: Write the route tests** in `advice-route.test.ts` (`startTraders({ suite: 'advice', master: r3Master(), quotes })`):
  - `GET advice returns the card with its band and historyFrom`.
  - `two viewers in one minute share one decide` → a spy on `adviceOf`: one call for a GET as the trader plus a GET as admin `?as=`.
  - `a new upload inside the minute gives a new card` → a manual leg add bumps `legs.version`.
  - Case `'books.advice'` → `w.asA('GET', '/v1/traders/books/JINDALSTEL/advice?as=sita')` is 404.
- [ ] **Step 5: Run** the two suites plus R1's ownership and import-rule suites. Expected: PASS.
- [ ] **Step 6: Commit** `feat(traders): relief-r advice from a clean rule state, once a minute per book (item 32, P4)`.

### Task 11: Portfolio and the admin roll-up (item 26)

**Files:**
- Create: `apps/traders/src/analytics/portfolio.ts`, `apps/traders/src/routes/portfolio.ts`
- Modify: `apps/traders/src/app.ts`, `apps/traders/src/routes/endpoints.ts` (`portfolio.view`, `admin.portfolio`), `apps/traders/test/ownership-cases.ts`
- Test: `apps/traders/test/portfolio.test.ts`, `apps/traders/test/portfolio-route.test.ts`

**Interfaces:**
- Consumes: N1.4, N1.5 (`legs.open`, `users.list('trader')`), N1.2 (`lotSizeOf`, `options.future`), `bookMargin` and `MarginView` (N2.3), `mtmOf` and `MtmBlock` (N2.4), `BookRisk.band` (Task 9).
- Produces:
  ```ts
  export interface MonthRow { expiry: string /* '' = shares */; delta: number; gamma: number; vega: number; theta: number; mtm: number }
  export interface PortfolioRow {
    stock: string; spot: number | null; lotSize: number | null
    delta: number; deltaLots: number | null; gamma: number; vega: number; theta: number
    mtmToday: number | null; mtmTotal: number; margin: number | null; marginLabel: string | null
    band: BandState | null; bandSentence: string | null; months: MonthRow[]
  }
  export interface PortfolioTotals { books: number; outOfBand: number; deltaValue: number; vega: number; theta: number; mtmToday: number | null; mtmTotal: number; margin: number; marginMissing: string[] }
  export interface PortfolioView { trader: string; asOf: number; rows: PortfolioRow[]; totals: PortfolioTotals; warnings: string[] }
  export interface PortfolioInput { view: BookView; lotSize: number | null; mtm: MtmBlock | null; margin: MarginView | null; band: BandStatus | null }
  export function portfolioOf(trader: string, books: readonly PortfolioInput[], nowMs: number): PortfolioView
  export interface StockAcross { stock: string; traders: number; delta: number; deltaLots: number | null; gamma: number; vega: number; theta: number; mtmToday: number | null; mtmTotal: number; margin: number }
  export interface AdminPortfolioView { asOf: number; traders: { trader: string; totals: PortfolioTotals }[]; stocks: StockAcross[]; warnings: string[] }
  export function adminPortfolioOf(views: readonly PortfolioView[], nowMs: number): AdminPortfolioView
  ```
  Field rules:
  - `lotSize` is the nearest listed future's lot for the underlying.
  - `deltaValue = Σ delta × spot` (an index uses its level); a row without a spot adds a warning.
  - `mtmToday`/`mtmTotal` come from `mtm.current.today`/`.total` (VolHedge's Current MTM, after charges). With no MtmBlock, `mtmTotal` falls back to `view.totals.mtm`, and `mtmToday` is null. The total's `mtmToday` is null if any row's is. When `mtm.ratesConfirmed` is false, a warning says `charges rates not confirmed`.
  - `margin = margin.total` when `margin.available` and not null, else null; `marginLabel = margin.span?.label`. Totals sum the known margins, and `marginMissing` lists the rest.
  - Rows are sorted by stock. `months` is grouped by leg expiry, ascending, with shares last.
- Endpoints: `portfolio.view` → `PortfolioView` (the resolved trader). `admin.portfolio` → `AdminPortfolioView` (kind `admin`).

- [ ] **Step 1: Write the failing tests** in `portfolio.test.ts`. Two books: TCS (delta 350, lot 175, spot 4000, vega 1200, theta −3000, current MTM total 25,000, today 4,000, margin 6,00,000 `NSE SPAN 13:30`, band out) and NIFTY (delta −150, lot 75, level 25,000, vega 800, theta −1500, current MTM total −10,000, today −2,500, margin not available, band in):
  - `rows carry lots from each underlying's own lot` → TCS `deltaLots 2`, NIFTY `deltaLots -2`.
  - `totals` → `deltaValue -2350000`, `vega 2000`, `theta -4500`, `mtmTotal 15000`, `mtmToday 1500`, `margin 600000`, `marginMissing ['NIFTY']`, `books 2`, `outOfBand 1`.
  - `month-wise` → TCS with an OCT leg (delta 500, gamma −2) and a NOV leg (delta −150, gamma 1) → `months` = `[{ expiry: OCT, delta: 500, gamma: -2, … }, { expiry: NOV, delta: -150, gamma: 1, … }]`.
  - `admin: per stock across traders` → ravi TCS 350, sita TCS −175 → `{ stock: 'TCS', traders: 2, delta: 175, deltaLots: 1, … }`.
  - `admin: one row per trader` with each trader's totals.
- [ ] **Step 2: Run** `node --test apps/traders/test/portfolio.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `portfolio.ts` and the routes.
- [ ] **Step 4: Write the route tests** in `portfolio-route.test.ts` (`startTraders({ suite: 'portfolio' })`):
  - `a trader sees only their own books`; `admin ?as= sees that trader's`; `GET /admin/portfolio as a trader → 403`; `as admin → every trader`.
  - Cases: `'portfolio.view'` → `w.asA('GET', '/v1/traders/portfolio?as=sita')` gives `trader === 'ravi'` and rows `['TCS']`. `'admin.portfolio'` → as A, 403.
- [ ] **Step 5: Run** the two suites plus R1's ownership suite. Expected: PASS.
- [ ] **Step 6: Commit** `feat(traders): Portfolio per trader and the admin roll-up per trader and per underlying (item 26)`.

### Task 12: Web — Portfolio, admin roll-up, groups

**Files:**
- Create: `apps/web/src/traders/portfolio.tsx`, `apps/web/src/traders/groups.tsx`
- Modify: `apps/web/src/traders/api.ts` (`tapi.portfolio()`, `tapi.adminPortfolio()`, `tapi.groups(stock)`, `tapi.putGroups(stock, groups)`), `apps/web/src/traders/pages.tsx` (append `{ id: 'portfolio', label: 'Portfolio' }`), `apps/web/src/traders/book.tsx` (append `{ id: 'groups', label: 'Groups' }` to `BOOK_SUBTABS`)
- Test: `apps/web/test/traders/portfolio.test.tsx`, `apps/web/test/traders/groups.test.tsx`

**Interfaces:**
- Consumes: `PortfolioView`, `AdminPortfolioView` (Task 11), `GroupsView`, `LegGroup` (Task 6), `PayoffCurves` from `apps/web/src/payoff-curves.tsx` (N1.11), `usePoll`.

Portfolio: one row per book with underlying, delta (shares) and lots, gamma, vega, theta, MTM today, MTM total, margin (label in a tooltip), and band (a StatusDot plus the sentence). It has a totals row, a "Month wise" toggle that expands rows into months, and polls every 60 s. An admin sees two tables, "By trader" and "By underlying (all traders)". Groups sub-tab: a legs table with a group picker per leg (a free-text name or "ungrouped"), Save (`tapi.putGroups`), and per-group totals with a `PayoffCurves` per group.

- [ ] **Step 1: Write the failing tests:**
  - `portfolio.test.tsx`: TCS and NIFTY rows; a totals row showing `-23,50,000` delta value and `Margin missing: NIFTY`; the band sentence in the band column; the admin view renders both tables; a trader session never calls `/admin/portfolio`.
  - `groups.test.tsx`: tagging two legs `hedge` and saving sends `PUT /v1/traders/books/TCS/groups` with `{ groups: [{ name: 'hedge', keys: [k1, k2] }] }`; a 400 shows the server's `error` in a Banner; per-group totals render.
- [ ] **Step 2: Run** `npm run test --workspace @algomaker/web -- traders/portfolio traders/groups`. Expected: FAIL.
- [ ] **Step 3: Implement and register.**
- [ ] **Step 4: Run** the tests, R1's `traders-imports.test.ts`, and `npm run typecheck --workspace @algomaker/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(traders-web): Portfolio, admin roll-up and named groups`.

### Task 13: Web — band chip, advice card, repair list, Show on payoff

**Files:**
- Create: `apps/web/src/traders/advice.tsx`
- Modify: `apps/web/src/traders/api.ts` (`tapi.advice(stock)`, `tapi.putBand(stock, lots)`, `tapi.repair(stock, tailCap?)`), `apps/web/src/traders/book.tsx` (append `{ id: 'advice', label: 'Advice' }` to `BOOK_SUBTABS`, and `BandChip` to `BOOK_HEADER_CHIPS`), `apps/web/src/traders/books.tsx` (a band dot in `BOOK_TAB_BADGES` from `BookSummary.band`)
- Test: `apps/web/test/traders/advice.test.tsx`

**Interfaces:**
- Consumes: `AdviceCard`, `BandStatus` (Tasks 9–10), `RepairView` (Task 7), `openWhatIf` from `apps/web/src/traders/what-if.ts` (N2.5), `usePoll`.
- Produces: `BandChip(p: { stock: string; view: BookView }): React.ReactElement | null`; `AdviceCardView(p: { card: AdviceCard }): React.ReactElement`; `RepairList(p: { stock: string }): React.ReactElement`.

The chip shows the band sentence: success tone when in, danger when out, neutral when unknown. It polls `tapi.advice` every 60 s. The Advice sub-tab shows the card (headline, lines, the engine's reason as a muted line, notes with the history line first) with one button, "Show on payoff", which calls `openWhatIf(stock, card.whatIf, 'relief-r suggestion')`. It also has a band override field (lots; empty clears) that calls `tapi.putBand`. Below it, "Find repairs" calls `tapi.repair` and lists plans by goal (move lines, credit, max loss, margin change, flags), each with "Show on payoff" → `openWhatIf(stock, plan.whatIf, 'Repair: <goal> <n>')`. A 429 shows "Two repair searches are already running; try again in a few seconds" with Retry.

- [ ] **Step 1: Write the failing tests** (`advice.test.tsx`):
  - The chip renders `Out of band by 1 lot — To neutralize: Buy 5 lots TCS OCT FUT` in a danger tone.
  - The card renders its lines, its reason, and the history line first among the notes. "Show on payoff" calls `openWhatIf` with `card.whatIf`.
  - **No button whose text matches `/apply|place|submit|order|execute/i` exists anywhere in the Advice sub-tab** (spec item 6).
  - The repair 429 shows Retry, and Retry re-POSTs. A plan's "Show on payoff" passes that plan's `whatIf`.
  - The tab-strip badge renders a danger dot for `band: 'out'` and nothing for `null`.
- [ ] **Step 2: Run** `npm run test --workspace @algomaker/web -- traders/advice`. Expected: FAIL.
- [ ] **Step 3: Implement and register.**
- [ ] **Step 4: Run** the tests, R1's `traders-imports.test.ts`, and `npm run typecheck --workspace @algomaker/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(traders-web): band chip, relief-r advice card and repair list, Show on payoff only`.

### Task 14: Engine — the `future` leg kind (P2, part 2 of 2; edits code the live desk runs)

Run this task alone, on its own commit, after Tasks 9, 10 and 13 are merged.

**Files:**
- Modify: `packages/desk-engine/src/types.ts` (`LegKind`, `LegView.kind?`), `packages/desk-engine/src/ladder.ts` (`isFutureLeg`; `sellLotSize` skips futures), `packages/desk-engine/src/corridor.ts` (`steeringPopulation`, the two sums; the §1 header now says how a futures hedge arrives), `packages/desk-engine/src/engine.ts` (option-only tiers)
- Test: `packages/desk-engine/test/future-leg.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export type LegKind = 'option' | 'future'
  // LegView gains:  readonly kind?: LegKind   — ABSENT = 'option'. A future (or share) leg: delta = sign × shares,
  //   gamma 0; by convention it carries strike 0, optType 'CE', delta 1, gamma/vega/theta 0, which the engine never reads.
  export function isFutureLeg(l: LegView): boolean       // ladder.ts: l.kind === 'future'
  ```
  Rules:
  - `steeringPopulation(legs, true)` keeps `side === 'Sell' && !isFutureLeg(l)` (Python's `K.shorts` is "option and sell").
  - Each future leg adds `positionSign(side) × lots × lotSize` to `netDelta` and nothing to `netGamma`.
  - `sellLotSize` returns the first short **option** leg's lot.
  - `decide()`: `const opts = legs.some(isFutureLeg) ? { ...inputs, legs: legs.filter((l) => !isFutureLeg(l)) } : inputs`. Every step uses `opts`, except `corridor(inputs, dials)` and `rollForward(base, shift, inputs, dials)`. A desk book passes the identical object. A comment says: measured, never acted on.

- [ ] **Step 1: Record the baselines** before any edit: `node --test packages/desk-engine/test/*.test.ts 2>&1 | tail -8`, `node --test 'apps/supervisor/test/**/*.test.ts' 2>&1 | tail -8`, `node --test apps/api/test/engine-decisions.test.ts apps/api/test/book.test.ts 2>&1 | tail -8`. Note each `# pass`, `# fail` and `# skipped`, and record `git rev-parse HEAD` as BASE.
- [ ] **Step 2: Write the failing tests** in `future-leg.test.ts` (fixtures as in `corridor.test.ts`'s `leg()` and `chainOf()`; spot 300, lot 25):
  - `a future leg counts sign × shares in netDelta and nothing in netGamma` → short 2 lots CE (|δ| 0.4, γ 0.01) plus a long future (lots 100, lotSize 1), `TRADER_PRESET` dials → `netDelta 80`, `netGamma -0.5`.
  - `shorts-only keeps a short future out` → relief-r dials, the same CE and a SHORT future of 100 → `netDelta -20`.
  - `under trader a long future hedges the short calls` → short 4 lots CE δ 0.5 plus a long future of 50 → `netDelta 0`.
  - `sellLotSize skips a future even when it is the first short` → `[short future lotSize 1, short CE lotSize 25]` → `25`.
  - `kind 'option' is the same as absent` → six books (flat; short strangle in band; out of band long; out of band short; a short at ₹0.05; expiry day at 15:30): `decide()` with every leg `{ ...l, kind: 'option' }` deep-equals `decide()` on the original.
  - `decide never names a future leg` → (a) the expiry settle (15:30, `dte 0`) closes exactly the option legs; (b) an out-of-band shed names no future instrument; (c) dials `target_pnl 1` with `isNewMark` and a streak of 2 → the flatten closes only option legs.
  - `a futures-only book holds` → `action 'hold'` with no actions.
- [ ] **Step 3: Run** `node --test packages/desk-engine/test/future-leg.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the four edits. No other file changes.
- [ ] **Step 5: Verify the live desk's suites, with no expectation edited.**
  - `node --test packages/desk-engine/test/*.test.ts 2>&1 | tail -8` → `# fail 0`, `# pass` = baseline + 7. `parity.test.ts` and `parity-shift.test.ts` are inside this run and must pass unchanged.
  - The supervisor run and the two api files → `# pass`, `# fail` and `# skipped` equal their baselines.
  - `npx tsc -p tsconfig.json` → clean.
  - `git diff --stat BASE -- packages/desk-engine/test apps/supervisor apps/api` → only `packages/desk-engine/test/future-leg.test.ts` (added). Any other line is a stop: revert and report.
- [ ] **Step 6: Commit on its own:** `feat(desk-engine): future leg kind — measured by the corridor, never acted on (P2)`. The body says desk books carry no future leg, that every existing test is unchanged, and gives the pass counts.

### Task 15: Lift the P2 gate — futures, shares and other expiries in band and advice (P2, P5)

**Files:**
- Modify: `apps/traders/src/analytics/engine-book.ts`, `apps/traders/src/analytics/advice.ts` (the offset note)
- Test: `apps/traders/test/engine-book.test.ts`, `apps/traders/test/band.test.ts`, `apps/traders/test/advice.test.ts` (replace the gate tests)

**Interfaces:**
- Consumes: `LegKind`, `isFutureLeg` (Task 14).
- Produces: `engineBookOf` no longer blocks. Each future or share leg becomes `{ kind: 'future', instrument: key, side, lots: |qty|, lotSize: 1, delta: 1, gamma: 0, vega: 0, theta: 0, strike: 0, optType: 'CE', hasGreeks: true, mtm, exit: its quote or an empty quote, … }`. All options of other expiries become one leg, `instrument 'offset:other-expiries'`, `kind 'future'`, lots `|Σ position delta|`, side by sign, and `hasGreeks: false` if any of them has no IV. `offsetShares` is set. `P2_GATE` is deleted. Notes add `Advises on the 27 Oct expiry only; other expiries' options are carried as a fixed delta of +1,250 shares (spec P5).` when the offset ≠ 0, and `Futures and shares are counted in the band and never adjusted by the advice.` when any are held.

- [ ] **Step 1: Replace the two gate tests with failing ones:**
  - `a future leg is measured` → Task 9's short CE book plus a long future of 175 → `netDelta` equals the BookView delta (to 1e-9), and the band uses it.
  - `other expiries collapse to one offset` → NOV legs with position deltas +900 and +350 → one engine leg `offset:other-expiries`, `lots 1250`, `side 'Buy'`.
  - `shares-only book has a band` → 1,000 shares on the near listed expiry's chain → `state 'out'`, `netDelta 1000`, and the advice `status 'hold'`, `headline 'Nothing to adjust in options'`.
  - `an unpriced NOV leg makes the band unknown` → `Band unknown: a leg has no IV (3600 CE 2026-11-24)`.
  - `advice never names a future, a share or the offset` → over the three books above, no line names `FUT`, `shares` or `offset`.
  - `adding 1,000 TCS shares by hand moves the band by 1,000 shares` (spec item 4a's done-when, through the band).
- [ ] **Step 2: Run** `node --test apps/traders/test/engine-book.test.ts apps/traders/test/band.test.ts apps/traders/test/advice.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the adapter and notes.
- [ ] **Step 4: Run** those suites, plus `node --test packages/desk-engine/test/*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(traders): band and advice on every book — futures, shares and other expiries as measured legs (P2, P5)`.

### Task 16 (optional): NSE's IV column (item 29)

Put this last. Skip it if the operator's NSE download test (O2) has not passed.

**Files:**
- Create: `scripts/nse_iv_job.py` (download and save only; stdlib, with `nsepythonserver` imported lazily inside its fetcher), `scripts/test_nse_iv_job.py` (`unittest`, fake fetcher, module loaded by path; N2.9), `apps/traders/test/nse-iv-job.test.ts` (node wrapper that runs it and skips without python3), `apps/traders/src/market/nse-iv.ts`
- Modify: `apps/traders/src/analytics/market-watch.ts` (`MarketSide.nseIv: number | null`, last column), `apps/web/src/traders/market-columns.ts` (`'nseIv'` last, hidden by default, header `NSE IV (optional)`), `ecosystem.desk.config.cjs` (pm2 plain-object entry `desk-traders-nse-iv`, `interpreter: secrets.TRADERS_NSE_PYTHON ?? <repo>/.venv-nse/bin/python` (R2's venv), `autorestart: false`, `cron_restart: '*/3 3-10 * * 1-5'` (UTC; the job itself exits outside 09:15–15:30 IST); **not started: operator restart**), `docs/runbooks/traders.md`
- Test: `apps/traders/test/nse-iv.test.ts`, `apps/traders/test/nse-iv-job.test.ts`, `scripts/test_nse_iv_job.py`

**Interfaces:**
- apps/traders writes `<TRADERS_NSE_DIR>/iv/wanted.json` = `{ stocks: string[], at }` every 60 s. `stocks` is `onScreen.underlyings(now)`, minus BFO underlyings, which NSE does not list. The job writes `<TRADERS_NSE_DIR>/iv/<STOCK>.json` = `{ fetchedAt, rows: { expiry, strike, ceIv, peIv }[] }`, written as `.tmp` then renamed.
  ```ts
  export function readNseIv(dir: string, stock: string, nowMs: number): Promise<{ fetchedAt: number; get(expiry: string, strike: number, type: 'CE' | 'PE'): number | null } | null>   // null when missing, malformed or older than 10 min
  ```
- [ ] **Step 1: Write the failing tests:** `readNseIv` on a fixture → `ceIv` 0.284 for TCS 2026-10-27 3400 CE (NSE's 28.4 stored as a decimal); 11 minutes old → `null`; malformed → `null`. `buildMarketWatch` with it sets `nseIv`; without it, `nseIv` is `null` and `iv` is unchanged. The Python test: a fixture NSE chain JSON → `rows[0]` = `{ expiry: '2026-10-27', strike: 3400, ceIv: 0.284, peIv: 0.301 }`.
- [ ] **Step 2: Run** `node --test apps/traders/test/nse-iv.test.ts apps/traders/test/nse-iv-job.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The job never runs during a test.
- [ ] **Step 4: Run** both. Expected: PASS.
- [ ] **Step 5: Commit** `feat(traders): NSE's IV per strike as an optional last column (item 29)`.

### Task 17: Release check

**Files:**
- Modify: `docs/runbooks/traders.md` (the Release 3 section)

- [ ] **Step 1: One full check on the merged tree** (not per worktree): `DESK_REQUIRE_MONGO=1 make check`. Expected: typecheck clean, `# fail 0`; the web suite passes.
- [ ] **Step 2: Confirm the guards:**
  - `ENDPOINTS` holds the 8 R3 ids, and R1's `every endpoint has an ownership case` passes.
  - The import-rule and single-writer suites pass.
  - `git diff --stat <release-2 merge>..HEAD -- packages/desk-engine/test` lists only `trader-preset.test.ts` and `future-leg.test.ts`.
- [ ] **Step 3: Runbook section:** "Release 3 needs one `desk-traders` restart (operator) and the web build (`dist-traders`). desk-marketdata needs none. Band events start on the first session minute after the restart."
- [ ] **Step 4: Commit** `docs(traders): Release 3 runbook section`. **Operator restart** of `desk-traders`: stop here.

---

## Self-review

- **Spec coverage:**
  - Item 24 → T2, T3, T4. Item 25 → T5. Item 26 → T11, T12. Item 27 → T6, T12. Item 29 → T16 (optional, last).
  - Item 30 → T9, T13, T15. Item 31 → T7, T13. Item 32 → T10, T13, T15.
  - P2 → T8, T14, T15. P3 → T2, T3. P4 → T10. P5 → T7, T15. P12 → T3, through `deps.eod` (N2.10). P13 → T1, T7, T10 (and Decision 15).
  - Index books → T1 fixture, T3, T7, T9, T10, T11.
  - The ownership walk → 8 `CASES` entries.
  - Items 33–36 are left out.
- **Names from R1 and R2:** every row of the table above is used under its real name, with N2.10 as R2's `deps.eod`. Nothing is invented inside R1's or R2's files. R3 only appends to R1's registries and tables, as R2 does.
- **Type consistency:**
  - `EngineBookResult` (T9) feeds `bandOf` and `adviceOf` and changes in T15.
  - `BandStatus` and `BandState` run through T9–T13.
  - `WhatIfLeg` (T7, R2's shape) feeds T10 and T13.
  - `nearExpiryOf` (T1) is used by T7 and T9.
  - `TtlCache` and the fixture (T1) feed T3, T7, T9 and T10.
- **Proportion:** about 930 lines against the spec's 880. Code appears only as signatures, value-pinned assertions, and the four formulas the spec does not fix (BF, BF2, Ratio, colour steps).
