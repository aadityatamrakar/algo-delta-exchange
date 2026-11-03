# Traders Release 2 — Analysis, Scenario, SPAN margin, charges — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every trader book VolHedge's Analysis and Scenario screens, Sensibull's target-date and IV sliders, real NSE SPAN + exposure margin, and charges/expenses — read-only analytics on top of Release 1.

**Architecture:** All pricing stays in the pure packages: `@algomaker/greeks` gains vanna/volga, `@algomaker/payoff` gains `scenario.ts` (one function prices any leg set at any (spot, date, vol shift)) plus the grid/gap/table builders and an illiquid-IV rule, and a new zero-dependency `@algomaker/span` parses NSE's SPAN and exposure files and computes margin. `apps/traders` adds one cached per-book market snapshot (each leg's IV from its own month's chain, P5) and four thin endpoints over it; a Python job only downloads and saves NSE files. The web traders page gets Analysis and Scenario sub-tabs, a slider chart and an admin charges editor; the desk's own pages are not touched.

**Tech Stack:** TypeScript on Node 24 type-stripping (`node:test`), MongoDB 3.7 driver through R1's `TradersDb`, React 19 + Astryx + recharts (vitest + jsdom), Python 3.12 stdlib (`unittest`, `zipfile`) + `nsepythonserver` (operator-installed venv), pm2 cron.

**Spec:** `docs/superpowers/specs/2026-10-19-traders-design.md` as of `56ad235b` — including the VolHedge v50 revisions of items 8, 16, 20 and 22 and the index books of item 3a (items 8–23, 14a, 28, P5, P11, P13). **Contract:** `docs/superpowers/plans/2026-10-19-traders-contract.md` — every name in it is used as written.

## Contract changes requested

None. Names this plan ADDS (allowed by the contract): package `@algomaker/span`; pm2 app `desk-traders-span`; env `TRADERS_NSE_DIR` (default `<repo>/data/nse`), `TRADERS_NSE_PYTHON` (default `<repo>/.venv-nse/bin/python`); `traders-settings` document `{ kind: 'charges', trader: null }`; endpoint ids `books.analysis`, `books.scenario`, `books.margin`, `admin.settings.get`, `admin.settings.put`; files listed in File Structure.

## Needs from Release 1

Reconciled with `docs/superpowers/plans/2026-10-19-traders-release-1.md` (24 tasks; its "Seams for Releases 2 and 3" table answers every row here). Every name below is R1's, used as written; R2 defines none of them again.

| # | What R2 uses | R1 name and signature | R1 task |
|---|---|---|---|
| N1 | The deps bag | `TradersDeps` (`apps/traders/src/deps.ts`), built by `createApp(d: AppDeps): Promise<App>` (`src/app.ts`); factories take `Pick<TradersDeps, …>`. R2 EXTENDS it there: `snapshots` (Task 9), `charges` and `eod` (Task 10), `analysisOf` (Task 11), `scenarioOf` (Task 12), `span` (Task 13) | 18 |
| N2 | The one resolver | `whose(ctx: RouteCtx, users: TraderStore): Promise<string>` (`src/auth/whose.ts`); throws `BadRequest` / `NotFound` / `Forbidden` | 3 |
| N3 | Admin-only routes | `kind: 'admin'` in `ENDPOINTS`, enforced by the server | 2 |
| N4 | Legs and trades | `LegStore.open(trader, stock?)`, `allOpen()`, `openBooks()`, `version(trader)`; trades read through `db.collection('traders-trades')`; `TraderTrade.qty` positive shares, `side` carries the sign, `seq` = line in its file (contract) | 13 |
| N5 | Quotes | `TradersQuotes { quote(token): TraderQuote \| null; feedAlive() }`, `TraderQuote { price, bid, ask, oi, volume, asOf, ageMs }` (`src/market/quotes.ts`). No previous close: the bus carries none, so yesterday's close comes from NSE's end-of-day files through R2's own `EodStore` (Task 10) | 15 |
| N6 | Master | `deps.master: () => TradersMaster` (never null), `spotTokenOf(m, stock)`, `lotSizeOf(m, leg)`, `nearestFuture(m, stock, today)`, `matchLeg` (`src/market/master.ts`); `isOpenLeg`, `contractText` (`src/types.ts`) | 1, 6 |
| N7 | Declaration | `wantedTokens` always declares the NEAREST listed future, held or not | 15 |
| N8 | One chain solve per month | `monthQuotes(m, q, stock, expiry, spot, asOf, closed): MonthQuotes { expiry, future, forward, source, quotes, ivs, tYears }`; `forwardFor(m, q, stock, expiry, spot, asOf)` — the ONE forward (own future, else parity, else spot carried); `BookView.forwards` (`src/analytics/month-chain.ts`). Task 9 changes one line of R1's `book-view.ts`: `iv = ivFor(…)` → `liquidIv(…, false).iv` | 17 |
| N9 | Ownership walk | `ENDPOINTS` (`src/routes/endpoints.ts`, `{ id, method, pattern, kind, raw? }`); `CASES: Record<id, Case>` in `apps/traders/test/ownership-cases.ts` (`Case = (w: Walk) => Promise<void>`). R2 adds `books.analysis`, `books.scenario`, `books.margin` (kind `trader`), `admin.settings.get`, `admin.settings.put` (kind `admin`) and a case for each | 2, 19 |
| N10 | Test harness | `startTraders({ suite, master?, quotes?, now?, deps?: Partial<TradersDeps> })` and `startHarness(suite, routes)` (`apps/traders/test/harness.ts`); R1's own fixture `test/fixtures/master.ts` exists, R2 keeps its pinned `test/fixtures/r2-book.ts` | 3, 6, 18 |
| N11 | JSON body cap | `JSON_BODY_MAX = 64 * 1024`, 413 above | 2 |
| N12 | Web seams | `tapi`, `tradersApi.get/post/put/patch/del`, `setAsTrader` (`traders/api.ts`); `BOOK_SUBTABS: readonly BookSubTab[]` (`{ id, label, render({ stock, view, reload }) }`) in `book.tsx`; `ADMIN_SECTIONS: readonly { id, label, render() }[]` in `admin.tsx`; `usePoll` (`hooks.ts`); `useTradersRoute` (`route.ts`); `format.ts`; server types by `import type` | 22, 23 |
| N13 | Boot | `createApp` / `App.start()` in `src/app.ts` — R2 builds `SnapshotCache`, `ChargeSettingsStore`, `EodStore`, `SpanStore` there and starts their 60 s refreshes in `start()` | 18 |
| N14 | Runbook | `docs/runbooks/traders.md` | 24 |
| N15 | Settings, `.gitignore` | `traders-settings` keyed `{ kind, trader }` with a unique index (R1: `watcher`, `ledger`); R2 adds `{ kind: 'charges', trader: null }`. R1's `.gitignore` gains `!apps/traders/test/fixtures/**`; R2 adds `!packages/span/test/**` | 1 |
| N16 | Desk chart | `PayoffCurves` in `apps/web/src/payoff-curves.tsx`, formatters in `apps/web/src/format.ts`; R2 touches neither and checks desk files from `R2_BASE` (the `feat/traders` commit where Release 1 was merged) | 22 |

## Global Constraints

- Node runs `.ts` by type stripping: no enums, namespaces, parameter properties or decorators (`erasableSyntaxOnly`); ESM imports carry the `.ts` extension; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on.
- apps/traders imports nothing from `apps/api/src/submit*`, `apps/api/src/repair-apply*`, `apps/order-gateway`, `packages/order-bus`, `packages/brokers`; R1's import-rule test stays green. `@algomaker/span` has zero dependencies.
- `TradersDb` is the only writer. R2 writes exactly one collection: `traders-settings` (document `{ kind: 'charges', trader: null }`). Analysis, scenario and margin write nothing; hypothetical legs are never stored.
- Desk unchanged: no edit to `apps/web/src/payoff.tsx`, `payoff-curves.tsx`, `format.ts` (as R1 leaves them), `apps/web/src/chart.tsx`, `packages/payoff/src/{legs,surface,view,margin,ivs}.ts`, `packages/desk-engine/**`; `b76Greeks` and `legGreeks` outputs keep their exact shape; no existing test expectation is edited. The ONE desk-side edit allowed is two zero fields in the degraded literal at `apps/api/src/service.ts:2162-2174` (typecheck only, no behaviour change).
- Tests on this box reach live ports: no traders test calls desk-api (:8790) or the supervisor (:8793); servers listen on port 0; every Mongo suite uses `algomaker_traders_test_<suite>` (names fixed per task below); the span job's tests use an injected fetcher. No task makes a network call to an external host (NSE, brokers, optionbhai).
- No restarts from a task. `desk-traders` restart, venv creation and the first NSE download are operator steps (Task 19).
- Wire units: IV is a decimal everywhere on the wire (0.245); vol SHIFTS are vol points (2 = +2%); vega per 1 vol point; theta per calendar day; vanna = Δdelta per 1 vol point; volga = Δvega per 1 vol point (vega per vol point); `qty`/units are signed shares; money in rupees; dates `YYYY-MM-DD` IST.
- Every column whose meaning is a guess (P15) ships with its label: T/N rows, "value" columns, Greeks Comparison, the Gap Up/Down valuation time, Previous MTM, Pay In Out, CF balance, To Neutralize %, peak margin, per-lot units, NOV handling. Exact label strings are fixed in the tasks.
- Charges seed values are NOT asserted as current statutory rates: they ship with `confirmedBy: null` and every screen that uses them says "rates not confirmed" until admin saves them.
- P13 caps: one market snapshot per (trader, stock, legs stamp) per 60 s shared by all viewers; grid ≤ 201 rows + spot × 60 dates; ≤ 20 hypothetical legs; ≤ 5 targets; scenario body ≤ 64 KB; web requests debounced 300 ms and polled ≥ 60 s.
- A book is keyed by its underlying, stock OR index (spec 3a): index books have weekly option expiries, so a month label is unique only when the book holds one expiry in that month (else `DD MMM`), and "near-month future" means the nearest listed FUTURE, not the nearest option expiry.
- Execution: each implementer first `git merge --ff-only feat/traders` (fresh worktrees start at the session head), runs its own `npm ci`, and the final `make check` runs once on the merged tree.

## Review Focus

1. **A two-month book around rollover with a thin far month, or an index weekly with no future** — every leg must price off its own month's forward (future, else parity, else carry — R1's `forwardFor`) and tenor; never be re-dated to the near expiry or the monthly future silently. Pinned in Task 9 ("a month with no future prices off R1's parity forward") and Task 12 ("the Expiry column is the near month and far legs keep time value").
2. **Closed market or dead feed** — Analysis and Scenario show last session's prices labelled as such, never as live (anti-goal). Pinned in Task 9 (closed, dead feed) and Task 15 (banner text rendered).
3. **Viewer params naming legs that are not this trader's** (trader B's key, a key from before the last upload) — ignored; the response equals the no-params response and leaks nothing. Pinned in Task 11 ("unknown keys are ignored").
4. **Inputs that would make NaN or Infinity** (a vol shift through zero IV, spot 0, every-Nth 0, end before start, grid too large, target date past the last expiry) — floor-and-warn or 400 naming the field; no non-finite number in any response. Pinned in Tasks 3, 4 and Task 12 ("every number in the view is finite").
5. **A held contract missing from the SPAN file, or a stale file** — margin is marked partial and names the contract; a stale file shows amber with its time; the figure is never silently lower. Pinned in Tasks 6 and 13.

## Verification items — facts this plan could not check (no NSE access from the box)

Each is built as the best reading below and confirmed by the operator's first download (O2) or the Phase 0 golden books (Q6). Where a task depends on one, it names it.

| Id | Unknown | Best reading used |
|---|---|---|
| V-J1 | which `nsepythonserver` call returns raw archive bytes | a lazy import in `nse_fetcher()`; if it only returns JSON, use its session headers with `urllib` |
| V-J2 | archive URLs and names | SPAN `https://nsearchives.nseindia.com/archives/nsccl/span/nsccl.YYYYMMDD.s.zip` (end of day) and `…i1.zip`–`…i5.zip` (intraday); exposure `https://nsearchives.nseindia.com/archives/exp_lim/ael_DDMMYYYY.csv`; F&O end of day `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip`; cash end of day `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip` |
| V-J3 | intraday SPAN count and times | up to 5; the cron polls every 15 min 08:30–20:15 IST regardless |
| V-J4 | unzipped `.spn` size | tens of MB; 7-day retention |
| V-SP1 | SPAN XML element names | the `SPAN_TAGS` table in Task 5 |
| V-SP2 | risk-array unit and sign | per 1 unit (share), positive = loss for a LONG unit |
| V-SP3 | inter-month spread encoding | delta-based tiers (`intrTiers`) + priority-ordered `dSpread` legs, rate per spread of 1 delta unit |
| V-SP4 | net option value | NOT netted into SPAN (NSCCL credits it to liquid net worth); reported separately |
| V-SP5 | exposure-file columns | header-driven: a `Symbol` column and a "total applicable ELM %" column |
| V-SP6 | exposure base on short options; calendar spreads | short options on the same month's future price × qty; calendar-spread futures pay 1/3 on the far leg, 0 on the near |
| V-SP7 | contract period format (`YYYYMMDD` or `YYYYMM`) | a contract is keyed by its period as the file gives it (`YYYY-MM-DD` or `YYYY-MM`); a position is looked up by its full expiry first, then by its month — index weeklies need the full date |
| V-SP8 | BSE contracts (SENSEX, spec 3a) | not in NSE's SPAN files: those legs show as "not in the SPAN file" and the figure is partial; a BSE (ICCL) file is out of this release |
| V-VH1 | Is 20 Oct 2026 a trading day? | VolHedge v50's scenario shows a 20-Oct column; the desk's NSE calendar (`packages/desk-engine/src/session.ts`) has 2026-10-20 as Dussehra. R2 skips holidays per spec 20 using the desk calendar; the operator confirms the date (if NSE trades that day, the desk calendar is wrong too) |
| V-VH2 | VolHedge's `Cal ON`, `No of Day`, the To Neutralize percentage's base, the Gap Up Down valuation time | not built / null / next open — Phase 0 Q3 |

## File Structure

```
packages/greeks/src/black76.ts          + B76SecondOrder, b76SecondOrder
packages/greeks/src/index.ts            Greeks/LegGreeks/BookGreeks gain vanna, volga
packages/greeks/test/vanna-volga.test.ts
packages/payoff/src/illiquid.ts         liquidIv: own quote, other side, nearest liquid strike
packages/payoff/src/scenario.ts         the pure scenario: forwards per month, vol shifts, legPoints, scenario()
packages/payoff/src/scenario-grid.ts    grid axes, gap up/down rows, breakevens, payoff curve + Sensibull table
packages/payoff/src/index.ts            exports the three files above
packages/payoff/test/{illiquid,scenario,scenario-grid}.test.ts
packages/span/                          NEW @algomaker/span, zero deps
  src/xml.ts  src/spn.ts  src/exposure.ts  src/eod.ts  src/margin.ts  src/trim.ts  src/index.ts
  test/{xml,spn,exposure,margin,trim,golden,span-job}.test.ts
  test/fixtures/mini.spn  test/fixtures/ael_19102026.csv  test/golden/README.md
scripts/span_job.py  scripts/test_span_job.py
apps/traders/src/analytics/wire.ts       every R2 wire type (types only; the web imports these)
apps/traders/src/analytics/snapshot.ts   per-book market snapshot, vol basis, SnapshotCache (P5, items 10, 16, P13)
apps/traders/src/analytics/charges.ts    rates table, seed, chargesFor, parseRates, ChargeSettingsStore (14a)
apps/traders/src/analytics/eod.ts        EodStore: yesterday's close and OI from NSE's F&O + CM bhavcopies (14; R3 reads it too)
apps/traders/src/analytics/mtm.ts        MTM block (14)
apps/traders/src/analytics/analysis.ts   buildAnalysis + parseAnalysisQuery (8–17, 22)
apps/traders/src/analytics/scenario-view.ts  buildScenario + parseScenarioRequest + hypotheticals (18–21, 23)
apps/traders/src/analytics/units.ts      bookLotGcd (23)
apps/traders/src/analytics/calendar.ts   nextTradingDay, previousTradingDay (16/22, 28)
apps/traders/src/analytics/margin.ts     SpanStore + bookMargin (15, 28)
apps/traders/src/routes/{settings,analysis,scenario,margin}.ts
apps/traders/src/deps.ts                 R1's TradersDeps: R2 adds snapshots, charges, eod, analysisOf, scenarioOf, span
apps/traders/src/app.ts  routes/endpoints.ts  test/ownership-cases.ts   R1's files: R2 appends its routes, 5 ENDPOINTS rows, 5 CASES
apps/traders/src/analytics/book-view.ts  R1's file: one line, iv through liquidIv (N8)
apps/traders/test/fixtures/r2-book.ts    the shared TCS book used by Tasks 9–13
apps/traders/test/{snapshot,units-calendar,charges,mtm,analysis,scenario-view,margin}.test.ts
apps/traders/test/{settings,analysis,scenario,margin}-routes.test.ts
apps/web/src/traders/{viewer.ts,units.tsx}    + R1's api.ts (tapi methods), book.tsx (2 BOOK_SUBTABS entries), admin.tsx (1 ADMIN_SECTIONS entry)
apps/web/src/traders/{analysis-tab,leg-table,greek-panels,gap-panel,margin-box}.tsx
apps/web/src/traders/{scenario-tab,scenario-grid,hypothetical-rows,payoff-sliders,admin-charges}.tsx
apps/web/test/traders-{units,r2-api,analysis,scenario,payoff-sliders,admin-charges}.test.tsx
ecosystem.desk.config.cjs                + desk-traders-span (cron, autorestart false)
.gitignore                               + /data/  /.venv-nse/  !packages/span/test/**
apps/api/src/service.ts:2162-2174        + netVanna: 0, netVolga: 0 (typecheck only)
```

## Order and parallel waves

- **Wave 1 — no Release 1 needed:** Tasks 1, 2, 5, 7 in parallel; then 3 (after 1) and 6 (after 5); then 4 (after 3) and 8 (after 6; its golden step stays gated on Q6).
- **Wave 2 — after Release 1 is merged into `feat/traders`:** Task 9 (needs 2, 4); then 10 (needs 5) and 13 (needs 6) in parallel; then 11 and 12 in parallel (both need 10).
- **Wave 3 — web:** Task 14 (needs 9); then 15 (needs 11, 13), 16 (needs 12) and 18 (needs 10) in parallel; 17 after 16. Tasks 15 and 16 each append one entry to R1's `BOOK_SUBTABS` — merge by hand.
- **Task 19** last.

---

### Task 1: vanna and volga in `@algomaker/greeks`

**Files:**
- Modify: `packages/greeks/src/black76.ts` (append), `packages/greeks/src/index.ts` (`Greeks`, `greeks()`, `LegGreeks`, `BookGreeks`, `bookGreeks()`)
- Modify: `apps/api/src/service.ts:2162-2174` — add `netVanna: 0, netVolga: 0` to the degraded `greeks` literal
- Test: `packages/greeks/test/vanna-volga.test.ts`

**Interfaces:**
- Produces:
```ts
export interface B76SecondOrder { readonly vanna: number; readonly volga: number }
export function b76SecondOrder(i: B76Inputs): B76SecondOrder          // black76.ts
// index.ts — additive fields
interface Greeks     { …; readonly vanna: number; readonly volga: number }
interface LegGreeks  { …; readonly positionVanna: number; readonly positionVolga: number }
interface BookGreeks { …; readonly netVanna: number; readonly netVolga: number }
```
- Closed forms (raw derivative ÷ 100 for vanna, ÷ 10⁴ for volga): Black-76 `vanna = −e^{−rt}·φ(d1)·d2/σ`, `volga = F·e^{−rt}·φ(d1)·√t·d1·d2/σ`; `greeks()` the same with `e^{−qt}` and `S`. Degenerate input (t ≤ 0, σ ≤ 0, F/S ≤ 0, K ≤ 0) → both 0.
- `b76Greeks` is deliberately NOT widened: its exact 4-field shape is `deepEqual`'d in `black76.test.ts:42,107-110,226,231`, `legs.test.ts:123-159`, `surface.test.ts:306`.

- [ ] **Step 1: Write the failing test**

```ts
const rel = (a: number, b: number, r = 1e-4) => assert.ok(Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * r), `${a} vs ${b}`)
const B = { future: 100, strike: 105, t: 0.25, vol: 0.3, rate: 0.065 } as const

test('b76SecondOrder is the closed form, identical for CE and PE', () => {
  const ce = b76SecondOrder({ ...B, type: 'CE' })
  rel(ce.vanna, 0.005075529401, 1e-9); rel(ce.volga, 0.0006351206899, 1e-9)
  assert.deepEqual(b76SecondOrder({ ...B, type: 'PE' }), ce)
})
test('b76SecondOrder matches finite differences of b76Greeks', () => {
  for (const type of ['CE', 'PE'] as const) for (const vol of [0.12, 0.3, 0.6]) for (const t of [0.02, 0.25]) {
    const i = { ...B, vol, t, type }, h = 1e-4
    const up = b76Greeks({ ...i, vol: vol + h }), dn = b76Greeks({ ...i, vol: vol - h })
    rel(b76SecondOrder(i).vanna, (up.delta - dn.delta) / (2 * h) / 100)
    rel(b76SecondOrder(i).volga, (up.vega - dn.vega) / (2 * h) / 100)
  }
})
test('degenerate inputs give zeros, never NaN', () => {
  for (const bad of [{ t: 0 }, { vol: 0 }, { future: 0 }, { strike: 0 }])
    assert.deepEqual(b76SecondOrder({ ...B, type: 'CE', ...bad }), { vanna: 0, volga: 0 })
})
test('greeks() carries vanna and volga (spot, dividend yield)', () => {
  const g = greeks({ spot: 521, strike: 530, t: 0.05, vol: 0.32, rate: 0.065, dividendYield: 0.01, type: 'CE' })
  rel(g.vanna, 0.002909518781, 1e-9); rel(g.volga, 0.0005597767438, 1e-9)
  // plus the same finite-difference loop against greeks().delta / .vega
  const expired = greeks({ spot: 540, strike: 530, t: 0, vol: 0.3, rate: 0.065, type: 'CE' })
  assert.equal(expired.vanna, 0); assert.equal(expired.volga, 0)
})
test('bookGreeks sums positionVanna and positionVolga', () => {
  // two PositionLegs: 3000 CE qty −175 mark 60 and 2900 PE qty +175 mark 30, spot 3000, expiry 2026-10-27, now Date.UTC(2026, 9, 19, 4, 30)
  assert.equal(bk.netVanna, bk.legs.reduce((s, l) => s + l.positionVanna, 0))
  for (const l of bk.legs) assert.equal(l.positionVolga, l.volga * l.qty)
})
```

- [ ] **Step 2: Run it to make sure it fails** — `node --test packages/greeks/test/vanna-volga.test.ts` → FAIL (`b76SecondOrder` is not exported).
- [ ] **Step 3: Implement** the Interfaces above in `black76.ts` and `index.ts`; add the two zero fields to `apps/api/src/service.ts:2162-2174`.
- [ ] **Step 4: Run the new test and every suite that reads these types, unchanged** — `node --test packages/greeks/test/*.test.ts packages/payoff/test/*.test.ts packages/desk-engine/test/*.test.ts && npm run typecheck` → all PASS, no expectation edited.
- [ ] **Step 5: Commit** — `git add packages/greeks apps/api/src/service.ts && git commit -m "feat(greeks): vanna and volga — b76SecondOrder, greeks(), bookGreeks"`

---

### Task 2: the illiquid IV rule (item 10)

**Files:**
- Create: `packages/payoff/src/illiquid.ts`; Modify: `packages/payoff/src/index.ts` (export)
- Test: `packages/payoff/test/illiquid.test.ts`

**Interfaces:**
- Consumes: `SolvedIv` from `packages/payoff/src/ivs.ts`.
- Produces:
```ts
export type LiquidIvSource = 'quote' | 'other-side' | 'nearest' | 'none'
export interface LiquidIv { readonly iv: number | null; readonly source: LiquidIvSource; readonly from: { readonly strike: number; readonly type: OptionType } | null }
export function liquidIv(solved: readonly SolvedIv[], strike: number, type: OptionType, illiquid: boolean): LiquidIv
```
- Rule: if `!illiquid` and the own (strike, type) row is measured (`source === 'quote'`) → own. Otherwise — ticked by the viewer, or own row missing/stale/unsolved ("auto-illiquid") — the other side at the same strike if measured; else the nearest measured row by |strike − K| excluding the own row, ties to the same side, then the lower strike; else `none`. Never interpolates (that stays `ivFor`'s, for the desk).

- [ ] **Step 1: Write the failing test**

```ts
const S: SolvedIv[] = [
  { strike: 100, type: 'CE', iv: 0.30, source: 'quote' }, { strike: 100, type: 'PE', iv: 0.32, source: 'quote' },
  { strike: 105, type: 'CE', iv: null, source: 'none' },  { strike: 105, type: 'PE', iv: 0.34, source: 'quote' },
  { strike: 110, type: 'CE', iv: 0.28, source: 'quote' },
]
test('a liquid leg keeps its own vol', () =>
  assert.deepEqual(liquidIv(S, 100, 'CE', false), { iv: 0.30, source: 'quote', from: null }))
test('ticked illiquid takes the other side at the same strike', () =>
  assert.deepEqual(liquidIv(S, 100, 'CE', true), { iv: 0.32, source: 'other-side', from: { strike: 100, type: 'PE' } }))
test('an unsolved own row is illiquid without a tick', () =>
  assert.deepEqual(liquidIv(S, 105, 'CE', false), { iv: 0.34, source: 'other-side', from: { strike: 105, type: 'PE' } }))
test('no other side: the nearest liquid strike, either side', () =>
  assert.deepEqual(liquidIv(S, 110, 'CE', true), { iv: 0.34, source: 'nearest', from: { strike: 105, type: 'PE' } }))
test('a tie on distance goes to the same side', () =>
  assert.deepEqual(liquidIv(S, 102, 'PE', false), { iv: 0.32, source: 'nearest', from: { strike: 100, type: 'PE' } }))
test('nothing measured anywhere is none', () =>
  assert.deepEqual(liquidIv([], 100, 'CE', true), { iv: null, source: 'none', from: null }))
```

- [ ] **Step 2: Run** `node --test packages/payoff/test/illiquid.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `liquidIv` per the rule; export it and its types from `index.ts`.
- [ ] **Step 4: Run** `node --test packages/payoff/test/*.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(payoff): liquidIv — other side, then nearest liquid strike (traders item 10)"`

---

### Task 3: the pure scenario function (item 18)

**Files:**
- Create: `packages/payoff/src/scenario.ts`; Modify: `packages/payoff/src/index.ts`
- Test: `packages/payoff/test/scenario.test.ts`

**Interfaces:**
- Consumes: `PayoffLeg`, `legPnl`, `DEFAULT_RATE` (`legs.ts`); `b76Price`, `b76Greeks`, `b76SecondOrder`, `yearsToExpiry` (`@algomaker/greeks`, Task 1).
- Produces:
```ts
export interface ScenarioMarket {
  readonly spot: number                                   // live CASH price of the stock
  readonly futures: Readonly<Record<string, number>>      // expiry -> live future; a missing month prices off spot (warned)
  readonly optionFutures?: Readonly<Record<string, number>>  // the vol basis options price against (Task 9 `rebase`); default `futures`
  readonly now: number                                    // epoch ms: the valuation instant for today's IST date
  readonly rate?: number                                  // default DEFAULT_RATE
}
export interface VolShifts {
  readonly callVolShift?: number                          // vol points added to every CE
  readonly putVolShift?: number                           // vol points added to every PE
  readonly volShift?: number                              // vol points added to every option, on top
  readonly ivOverrides?: Readonly<Record<string, number>> // leg id -> IV decimal; REPLACES leg.iv before the shifts
}
export interface ScenarioGreeks { readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number; readonly vanna: number; readonly volga: number }
export interface ScenarioCell extends ScenarioGreeks { readonly pnl: number }   // position: Σ qty × per-share
export interface LegPoint extends ScenarioGreeks { readonly id: string; readonly price: number; readonly pnl: number; readonly iv: number | null }  // greeks PER SHARE; pnl = qty × (price − entry)
export interface ValuationPoint { readonly date: string; readonly ms: number }   // a column: its IST date and the instant it is valued at
export interface ScenarioResult { readonly spots: readonly number[]; readonly at: readonly ValuationPoint[]; readonly cells: readonly (readonly ScenarioCell[])[]; readonly warnings: readonly string[] }  // cells[spotIdx][pointIdx]

export function istDay(ms: number): string
export function valuationAt(date: string, now: number, mode: 'time' | 'open' | 'close'): ValuationPoint | null
  // 'time': today (IST) -> now; a later date -> that date at now's IST time of day, clamped into 09:15–15:30; 'open' -> 09:15 IST; 'close' -> 15:30 IST; a date before today or unreadable -> null
export function forwardAt(market: ScenarioMarket, expiry: string, spot: number, instrument: 'option' | 'future'): number  // '' -> spot; else (options: optionFutures ?? futures)[e] × spot / market.spot
export function ivUsed(leg: PayoffLeg, shifts: VolShifts): number | null  // options only; floored at 0.0001 (warned by the caller)
export function legPoints(legs: readonly PayoffLeg[], market: ScenarioMarket, at: { readonly spot: number; readonly point: ValuationPoint }, shifts: VolShifts): readonly LegPoint[]
export function scenario(legs: readonly PayoffLeg[], market: ScenarioMarket, spots: readonly number[], at: readonly ValuationPoint[], shifts: VolShifts): ScenarioResult
```
- Conventions, fixed here: a `future` leg with `expiry: ''` is a share (prices at spot). Tenor = `yearsToExpiry(leg.expiry, point.ms)` — the INTRADAY clock, deliberately not `surface.ts`'s calendar clock, so the scenario's "today" column agrees with Analysis's live greeks; later dates keep today's time of day so columns are exactly one day apart and the expiry DATE column still has time value, while the `Expiry` column is valued at the close (VolHedge v50 shows both; state this in the file header). Delta is per point of the leg's own month future. Futures/shares: delta 1 per share, other greeks 0. Nothing NaN leaves: junk spot or date → empty cells + warning.

- [ ] **Step 1: Write the failing test** (shared: `NOW = Date.UTC(2026, 9, 19, 4, 30)` = Mon 10:00 IST; `OCT = '2026-10-27'`, `NOV = '2026-11-23'`; `leg(id, instrument, qty, strike, type, expiry, entry, iv)` builds a `PayoffLeg`; `close(a, b, eps)` is a LOCAL assertion `assert.ok(Math.abs(a - b) <= eps)` — `test/helpers.ts`'s `close` has another signature. Tasks 4 and 9–13 use the same two helpers.)

```ts
const M: ScenarioMarket = { spot: 3000, futures: { [OCT]: 3010, [NOV]: 3030 }, now: NOW }
const SHARE = leg('s', 'future', 1000, null, null, '', 2950, null)
const FUT = leg('f', 'future', 175, null, null, OCT, 3000, null)
const OCT_CE = leg('oc', 'option', -175, 3000, 'CE', OCT, 50, 0.25)
const NOV_CE = leg('nc', 'option', 175, 3000, 'CE', NOV, 80, 0.22)
const OCT_PE = leg('op', 'option', -175, 2900, 'PE', OCT, 30, 0.27)

test('share and future legs are linear in spot', () => {
  const c = scenario([SHARE, FUT], M, [3030], [NOW_PT], {}).cells[0]![0]!
  close(c.pnl, 1000 * 80 + 175 * (3010 * 3030 / 3000 - 3000), 1e-6)   // 87017.5
  assert.equal(c.delta, 1175); assert.deepEqual([c.gamma, c.vega, c.theta, c.vanna, c.volga], [0, 0, 0, 0, 0])
})
const NOW_PT = valuationAt('2026-10-19', NOW, 'time')!
test('each option prices off its own month future and tenor', () => {
  const c = scenario([OCT_CE, NOV_CE], M, [3000], [NOW_PT], {}).cells[0]![0]!
  close(c.pnl, legPnl(OCT_CE, 3010, yearsToExpiry(OCT, NOW)) + legPnl(NOV_CE, 3030, yearsToExpiry(NOV, NOW)), 1e-9)
})
test('valuation instants: today is now; later dates keep the time of day; open and close', () => {
  assert.deepEqual(valuationAt('2026-10-22', NOW, 'time'), { date: '2026-10-22', ms: Date.UTC(2026, 9, 22, 4, 30) })
  assert.equal(valuationAt('2026-10-22', Date.UTC(2026, 9, 19, 11, 30), 'time')!.ms, Date.UTC(2026, 9, 22, 10, 0))   // 17:00 IST clamps to 15:30
  assert.equal(valuationAt('2026-10-21', NOW, 'open')!.ms, Date.UTC(2026, 9, 21, 3, 45))
  assert.equal(valuationAt('2026-10-27', NOW, 'close')!.ms, Date.UTC(2026, 9, 27, 10, 0))
  assert.equal(valuationAt('2026-10-18', NOW, 'time'), null)
})
test('a later date prices at its own instant', () => {
  const pt = valuationAt('2026-10-22', NOW, 'time')!, c = scenario([OCT_CE, NOV_CE], M, [3000], [pt], {}).cells[0]![0]!
  close(c.pnl, legPnl(OCT_CE, 3010, yearsToExpiry(OCT, pt.ms)) + legPnl(NOV_CE, 3030, yearsToExpiry(NOV, pt.ms)), 1e-9)
})
test('shifts apply by side; an override replaces the base before the shifts', () => {
  const p = legPoints([OCT_CE, OCT_PE], M, { spot: 3000, point: NOW_PT }, { callVolShift: 2, volShift: 1, ivOverrides: { oc: 0.30 } })
  close(p[0]!.iv!, 0.33, 1e-12); close(p[1]!.iv!, 0.28, 1e-12)
})
test('vanna and volga are b76SecondOrder × qty', () => { /* compare cell.vanna to −175 × b76SecondOrder({future:3010,…}).vanna */ })
test('a shift through zero floors IV at 0.0001 and warns', () => { /* volShift: -30 on OCT_CE → iv 0.0001, warning names 'oc' */ })
test('an option with no IV contributes nothing and is named', () => { /* iv null → pnl 0, greeks 0, warning names the id */ })
test('junk spot gives empty cells and a warning, never NaN', () => {
  for (const s of [NaN, 0, -1]) { const r = scenario([FUT], { ...M, spot: s }, [3000], [NOW_PT], {}); assert.deepEqual(r.cells, []); assert.ok(r.warnings.length > 0) }
})
```

- [ ] **Step 2: Run** `node --test packages/payoff/test/scenario.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `scenario.ts` per the Interfaces; `scenario()` is `legPoints` per (spot, point) summed × qty.
- [ ] **Step 4: Run** `node --test packages/payoff/test/*.test.ts` → PASS (existing suites untouched).
- [ ] **Step 5: Commit** — `git commit -m "feat(payoff): scenario — every leg on its own month, vol shifts, vanna/volga (traders item 18)"`

---

### Task 4: grid axes, gap rows, breakevens, payoff curve and Sensibull table (items 16, 20–22)

**Files:**
- Create: `packages/payoff/src/scenario-grid.ts`; Modify: `packages/payoff/src/index.ts`
- Test: `packages/payoff/test/scenario-grid.test.ts`

**Interfaces:**
- Consumes: Task 3's `scenario`, `legPoints`, `valuationAt`, `ValuationPoint`, `ScenarioMarket`, `VolShifts`, `istDay`.
- Produces:
```ts
export interface AxesSpec {
  readonly middle: number; readonly stepPct: number; readonly count: number   // VolHedge v50: "Interval" % and "Strike +/-" rows each side, around M.Strike
  readonly spot: number; readonly start: string; readonly end: string; readonly everyNth: number; readonly expiry: string; readonly now: number
  readonly isTradingDay: (day: string) => boolean                             // injected: this package stays free of the desk calendar
}
export interface Axes { readonly spots: readonly number[]; readonly currentRow: number; readonly columns: readonly ValuationPoint[]; readonly labels: readonly string[] }
export const GRID_MAX_COUNT = 100, GRID_MAX_DATES = 60
export function scenarioAxes(spec: AxesSpec): Axes | { readonly error: string }
export interface GapInput { readonly movePct: number; readonly volPts: number }
export interface GapResult extends GapInput { readonly price: number; readonly pnl: number; readonly change: number }
export function gapRows(legs: readonly PayoffLeg[], market: ScenarioMarket, nextDay: string, rows: readonly GapInput[], ivOverrides: Readonly<Record<string, number>>, useVol: boolean, base: number): readonly GapResult[]
export function breakevenRange(legs: readonly PayoffLeg[], market: ScenarioMarket, expiryDate: string, shifts: VolShifts): { readonly low: number | null; readonly high: number | null }
export interface PayoffPointTE { readonly price: number; readonly target: number; readonly expiry: number }
export function payoffCurve(legs: readonly PayoffLeg[], market: ScenarioMarket, targetDate: string, expiryDate: string, shifts: VolShifts): readonly PayoffPointTE[]
export const PAYOFF_TABLE_PCTS = [1, 2, 3, 5, 8] as const
export interface PayoffTableRow extends PayoffPointTE { readonly label: string }
export function payoffTable(legs: readonly PayoffLeg[], market: ScenarioMarket, targetDate: string, expiryDate: string, targets: readonly number[], shifts: VolShifts): readonly PayoffTableRow[]
```
- Rules: rows `middle * (100 + k * stepPct) / 100`, k = −count…count, rows ≤ 0 dropped; the current spot inserted unless within 0.01 of a row; ascending; `currentRow` = spot's index. Columns: every `everyNth`-th TRADING day from `start` while ≤ min(end, expiry) (spec 20: weekends and holidays skipped), each `valuationAt(day, now, 'time')`, then one more column `valuationAt(expiry, now, 'close')` labelled `Expiry` — the expiry date can appear twice, as on VolHedge v50's screen (`27-Oct` and `Expiry`); other labels `DD Mon`. Gap rows (the Gap Up/Down panel, items 16 + 22): price `spot × (100 + movePct)/100`, valued at the next open — 09:15 IST of `nextDay` (call `scenario` with `market.now` moved to that instant) — with every option's IV shifted by `volPts` when `useVol`; `pnl` vs entry, `change = pnl − base` (the caller's current MTM). Breakevens: P&L at `valuationAt(expiryDate, now, 'close')` on 1,001 points `spot × (0.5 + k/1000)`, zero crossings linearly interpolated; `low` = nearest crossing below spot, `high` = nearest above, null when none. Curve: 121 points `spot × (1 + 0.1·(k − 60)/60)`; `target` at `valuationAt(targetDate, now, 'time')`, `expiry` at the expiry's close. Table: `spot`, ±`PAYOFF_TABLE_PCTS` (`-8%` … `+8%`), `target <price>`; deduped within 0.01, priority spot > target > pct; ascending.

- [ ] **Step 1: Write the failing test** (`TD` = a trading-day predicate with 2026-10-20 a holiday, weekends off)

```ts
const BASE = { middle: 3000, stepPct: 0.5, count: 2, spot: 3012, start: '2026-10-19', end: '2026-10-27', everyNth: 1, expiry: '2026-10-27', now: NOW, isTradingDay: TD }
test('% rows around M.Strike, spot inserted, trading-day columns, the expiry date and then Expiry', () => {
  const a = scenarioAxes(BASE) as Axes
  assert.deepEqual([a.spots, a.currentRow], [[2970, 2985, 3000, 3012, 3015, 3030], 3])
  assert.deepEqual(a.columns.map((c) => c.date), ['2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-27'])
  assert.deepEqual(a.labels, ['19 Oct', '21 Oct', '22 Oct', '23 Oct', '26 Oct', '27 Oct', 'Expiry'])
  assert.deepEqual([a.columns[0]!.ms, a.columns[5]!.ms, a.columns[6]!.ms], [NOW, Date.UTC(2026, 9, 27, 4, 30), Date.UTC(2026, 9, 27, 10, 0)])
})
test('VolHedge’s defaults give ±25 % in 101 rows', () => {
  const a = scenarioAxes({ ...BASE, count: 50, spot: 3000 }) as Axes
  assert.deepEqual([a.spots.length, a.spots[0], a.spots[100], a.currentRow], [101, 2250, 3750, 50])
})
test('every 2nd trading day still ends on Expiry', () =>
  assert.deepEqual((scenarioAxes({ ...BASE, everyNth: 2 }) as Axes).labels, ['19 Oct', '22 Oct', '26 Oct', 'Expiry']))
test('bad specs are errors that name the field', () => {
  const err = (x: unknown) => (x as { error: string }).error
  assert.match(err(scenarioAxes({ ...BASE, count: 101 })), /count/); assert.match(err(scenarioAxes({ ...BASE, stepPct: 0 })), /stepPct/)
  assert.match(err(scenarioAxes({ ...BASE, everyNth: 0 })), /everyNth/); assert.match(err(scenarioAxes({ ...BASE, start: '2026-10-28' })), /start/)
  assert.match(err(scenarioAxes({ ...BASE, end: '2027-03-31', expiry: '2027-03-31' })), /60/)
})
const M = { spot: 3000, futures: { '2026-10-27': 3010 }, now: NOW }
const FUT = leg('f', 'future', 175, null, null, '2026-10-27', 3000, null)
const OCT_CE = leg('oc', 'option', -175, 3000, 'CE', '2026-10-27', 50, 0.25)
test('gap rows: price move and vol change at the next open', () => {
  const [up] = gapRows([FUT], M, '2026-10-21', [{ movePct: 10, volPts: -10 }], {}, true, 1750)
  close(up!.price, 3300, 1e-9); close(up!.pnl, 54425, 1e-6); close(up!.change, 52675, 1e-6)   // 175 × (3311 − 3000)
  const open = Date.UTC(2026, 9, 21, 3, 45), t = yearsToExpiry('2026-10-27', open)
  close(gapRows([OCT_CE], M, '2026-10-21', [{ movePct: 10, volPts: -10 }], {}, true, 0)[0]!.pnl, legPnl(OCT_CE, 3311, t, DEFAULT_RATE, 0.15), 1e-9)
  close(gapRows([OCT_CE], M, '2026-10-21', [{ movePct: 10, volPts: -10 }], {}, false, 0)[0]!.pnl, legPnl(OCT_CE, 3311, t, DEFAULT_RATE, 0.25), 1e-9)
})
test('breakeven range of a short straddle', () => {
  const be = breakevenRange([leg('c', 'option', -175, 3000, 'CE', '2026-10-27', 60, 0.25), leg('p', 'option', -175, 3000, 'PE', '2026-10-27', 50, 0.27)],
    { spot: 3000, futures: { '2026-10-27': 3000 }, now: NOW }, '2026-10-27', {})
  close(be.low!, 2890, 1e-6); close(be.high!, 3110, 1e-6)
})
test('payoff curve: 121 points across ±10%', () => {
  const c = payoffCurve([FUT], M, '2026-10-19', '2026-10-27', {})
  assert.equal(c.length, 121); close(c[0]!.price, 2700, 1e-9); close(c[120]!.expiry, 54425, 1e-6)
})
test('Sensibull table rows, deduped and ordered', () => assert.deepEqual(
  payoffTable([FUT], M, '2026-10-19', '2026-10-27', [3100, 3000.004], {}).map((r) => r.label),
  ['-8%', '-5%', '-3%', '-2%', '-1%', 'spot', '+1%', '+2%', '+3%', 'target 3100', '+5%', '+8%']))
```

- [ ] **Step 2: Run** `node --test packages/payoff/test/scenario-grid.test.ts` → FAIL.
- [ ] **Step 3: Implement** `scenario-grid.ts` on top of `scenario()`.
- [ ] **Step 4: Run** `node --test packages/payoff/test/*.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(payoff): scenario grid axes, gap up/down rows, breakevens, target/expiry curve and table"`

---

### Task 5: `@algomaker/span` — SPAN, exposure and end-of-day file parsers

**Files:**
- Create: `packages/span/package.json` (`"name": "@algomaker/span"`, `"version": "1.0.0"`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, `"scripts": { "test": "node --test test/*.test.ts" }`, no dependencies), `src/index.ts`, `src/xml.ts`, `src/spn.ts`, `src/exposure.ts`, `src/eod.ts`
- Create: `test/xml.test.ts`, `test/spn.test.ts`, `test/exposure.test.ts`, `test/eod.test.ts`, `test/fixtures/mini.spn`, `test/fixtures/ael_19102026.csv`, `test/fixtures/arrays.ts` (the four risk arrays of Task 6, exported), `test/fixtures/eod/` (four short bhavcopies: F&O and CM, UDiFF and legacy)
- Modify: `.gitignore` (append `!packages/span/test/**`), `package-lock.json` (via `npm install --offline --no-audit --no-fund`; if it needs the network, stop and report)

**Interfaces:**
- Produces:
```ts
// xml.ts — a scanner, not a DOM: a real file is tens of MB (V-J4)
export interface XmlHandler { open(name: string, at: number): void; close(name: string, text: string, end: number): void }
export function scanXml(xml: string, h: XmlHandler): void   // elements only; attributes, comments, <?…?>, <!…> skipped; <a/> = open+close(''); &amp; &lt; &gt; &quot; &apos; decoded; unbalanced → SpanParseError
// spn.ts
export class SpanParseError extends Error {}
export interface SpanContract { readonly kind: 'future' | 'option'; readonly period: string /* 'YYYY-MM-DD', or 'YYYY-MM' when the file gives only a month */; readonly strike: number | null; readonly optType: 'CE' | 'PE' | null; readonly price: number; readonly delta: number; readonly riskArray: readonly number[] /* exactly 16 */ }
export interface SpanTier { readonly tier: number; readonly startMonth: string; readonly endMonth: string }
export interface SpanSpread { readonly priority: number; readonly rate: number; readonly legs: readonly { readonly tier: number; readonly side: 'A' | 'B'; readonly ratio: number }[] }
export interface SpanCommodity { readonly symbol: string; readonly contracts: ReadonlyMap<string, SpanContract>; readonly tiers: readonly SpanTier[]; readonly spreads: readonly SpanSpread[]; readonly somRate: number }
export interface SpanFile { readonly businessDate: string; readonly settlement: boolean; readonly created: string | null; readonly commodities: ReadonlyMap<string, SpanCommodity> }
export function spanKey(kind: 'future' | 'option', period: string, strike: number | null, optType: 'CE' | 'PE' | null): string  // `${kind}|${period}|${strike ?? ''}|${optType ?? ''}`
export function findContract(c: SpanCommodity, kind: 'future' | 'option', expiry: string, strike: number | null, optType: 'CE' | 'PE' | null): SpanContract | null  // full expiry first, then its month (V-SP7)
export const SPAN_TAGS: Readonly<Record<string, string>>   // every element name read, in ONE place (V-SP1)
export function parseSpanFile(xml: string, only?: ReadonlySet<string>): SpanFile   // `only`: keep just these commodities (memory: Task 13 keeps several files of a day)
// exposure.ts
export function parseExposureFile(csv: string): ReadonlyMap<string, number>   // symbol -> fraction (3.5% -> 0.035)
// eod.ts — NSE end-of-day bhavcopies; yesterday's close and OI for Previous MTM (Task 10) and R3's Market Watch
export interface EodContract { readonly stock: string; readonly instrument: 'option' | 'future' | 'share'; readonly expiry: string /* '' for a share */; readonly strike: number | null; readonly optType: 'CE' | 'PE' | null }
export interface EodRow extends EodContract { readonly close: number; readonly oi: number | null }   // oi null on cash rows
export class EodParseError extends Error {}
export function eodKey(c: EodContract): string                     // `${stock}|${instrument}|${expiry}|${strike ?? ''}|${optType ?? ''}`
export function parseFoBhavcopy(csv: string): readonly EodRow[]    // F&O: UDiFF or legacy header, detected; options and futures, stock and index
export function parseCmBhavcopy(csv: string): readonly EodRow[]    // cash: UDiFF or legacy header; series EQ only, as instrument 'share'
```
- `SPAN_TAGS`, best reading (V-SP1; header comment says "verify against a real file before trusting"): business date `pointInTime/date` (YYYYMMDD), settlement `pointInTime/isSetl`, created `created`; futures `futPf` (symbol `pfCode`) → `fut` (`pe` period, `p` price, `ra` with 16 × `a` and `d` delta); options `oopPf` (`pfCode`) → `series` (`pe`) → `opt` (`o` C/P, `k` strike, `p`, `ra`); commodity `ccDef` (`cc` symbol) → `intrTiers/tier` (`tn`, `sPe`, `ePe`), `dSpread` (`spread` priority, `rate/val`, `tLeg`: `tn`, `rs` A/B, `i` ratio), `somTiers/tier/rate/val`. `pe` of `YYYYMMDD` maps to `YYYY-MM-DD`, of `YYYYMM` to `YYYY-MM` (V-SP7); tiers compare by month.
- End-of-day columns (V-J2, verify on the operator's first download), header-driven, either generation accepted: F&O UDiFF `TckrSymb`, `FinInstrmTp` (`STO`/`IDO` option, `STF`/`IDF` future), `XpryDt` (`YYYY-MM-DD`), `StrkPric`, `OptnTp`, `ClsPric`, `OpnIntrst`; F&O legacy `INSTRUMENT` (`OPTSTK`/`OPTIDX`/`FUTSTK`/`FUTIDX`), `SYMBOL`, `EXPIRY_DT` (`27-Oct-2026`), `STRIKE_PR`, `OPTION_TYP` (`XX` on futures), `CLOSE`, `OPEN_INT`; CM UDiFF `TckrSymb`, `SctySrs`, `ClsPric`; CM legacy `SYMBOL`, `SERIES`, `CLOSE`. The CLOSE price is used, never the settlement price (`SttlmPric`/`SETTLE_PR`) — whether VolHedge's "previous" basis is the close or the settlement is Phase 0 Q3. A header with neither generation's columns throws `EodParseError` naming the missing column.
- `mini.spn`: hand-written to that map, matching Task 9's TCS book — commodity `TCS`; futures period `20261027` (p 3010, d 1) and period `202611` (month only — exercises V-SP7; p 3030, d 1); options `20261027` 3000 CE (p 60, d 0.5) and 3000 PE (p 50, d −0.5); risk arrays exactly Task 6's `RA_FUT_OCT`, `RA_FUT_NOV`, `RA_CE`, `RA_PE`; tiers 1 = 2026-10…2026-10, 2 = 2026-11…2026-11; one spread priority 1, rate 3, legs `{1,'A',1}`, `{2,'B',1}`; som rate 1.5; business date 20261019. `ael_19102026.csv`: header `Sr No,Symbol,Instrument Type,Normal ELM Margin %,Additional ELM %,Total applicable ELM %`, rows `1,TCS,OTH,3.5,0,3.5` and `2,NIFTY,IDX,2,0,2` (V-SP5).

- [ ] **Step 1: Write the failing tests**

```ts
test('scanXml reports elements in order with decoded text and offsets', () => {
  const ev: string[] = []
  scanXml('<?xml version="1.0"?><a x="1"><b>1 &amp; 2</b><c/></a>', { open: (n) => ev.push(`+${n}`), close: (n, t) => ev.push(`-${n}:${t}`) })
  assert.deepEqual(ev, ['+a', '+b', '-b:1 & 2', '+c', '-c:', '-a:'])
})
test('unbalanced tags throw SpanParseError', () => assert.throws(() => scanXml('<a><b></a>', { open() {}, close() {} }), SpanParseError))
test('mini.spn parses to one commodity with four contracts', () => {
  const f = parseSpanFile(readFileSync(fixture('mini.spn'), 'utf8'))
  assert.equal(f.businessDate, '2026-10-19')
  const tcs = f.commodities.get('TCS')!
  assert.equal(tcs.contracts.size, 4)
  assert.deepEqual(tcs.contracts.get(spanKey('future', '2026-10-27', null, null))!.riskArray, RA_FUT_OCT)
  assert.deepEqual(tcs.contracts.get(spanKey('option', '2026-10-27', 3000, 'PE'))!.delta, -0.5)
  assert.equal(findContract(tcs, 'future', '2026-11-23', null, null)!.period, '2026-11')   // month-only period, found by month
  assert.deepEqual(tcs.tiers, [{ tier: 1, startMonth: '2026-10', endMonth: '2026-10' }, { tier: 2, startMonth: '2026-11', endMonth: '2026-11' }])
  assert.equal(tcs.spreads[0]!.rate, 3); assert.equal(tcs.somRate, 1.5)
})
test('a risk array that is not 16 values names the contract', () =>
  assert.throws(() => parseSpanFile(miniWithFifteenValues()), /TCS.*2026-10/))
test('only= keeps just the named commodities', () =>
  assert.equal(parseSpanFile(readFileSync(fixture('mini.spn'), 'utf8'), new Set(['INFY'])).commodities.size, 0))
test('exposure file: symbol -> fraction', () => {
  const m = parseExposureFile(readFileSync(fixture('ael_19102026.csv'), 'utf8'))
  assert.equal(m.get('TCS'), 0.035); assert.equal(m.get('NIFTY'), 0.02)
})
test('an exposure file without a Symbol column throws', () => assert.throws(() => parseExposureFile('a,b\n1,2'), /Symbol/))
// read(f) = readFileSync(fixture(f), 'utf8'). eod fixtures: TCS on 2026-10-16 — 2026-10-27 3000 CE close 44 OI 525000, 2026-10-27 FUT close 3005 OI 1750000, 2026-11-23 FUT close 3025; cash TCS EQ close 2990 (plus a TCS BE row)
test('F&O bhavcopy, both generations, the same rows', () => {
  const u = parseFoBhavcopy(read('eod/fo-udiff.csv')), l = parseFoBhavcopy(read('eod/fo-legacy.csv'))
  const ce = { stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3000, optType: 'CE' } as const
  for (const rows of [u, l]) {
    const by = new Map(rows.map((r) => [eodKey(r), r]))
    assert.deepEqual([by.get(eodKey(ce))!.close, by.get(eodKey(ce))!.oi], [44, 525000])
    assert.equal(by.get(eodKey({ stock: 'TCS', instrument: 'future', expiry: '2026-10-27', strike: null, optType: null }))!.close, 3005)
  }
})
test('CM bhavcopy keeps series EQ only, as shares', () => {
  for (const f of ['eod/cm-udiff.csv', 'eod/cm-legacy.csv']) assert.deepEqual(parseCmBhavcopy(read(f)).map((r) => [r.stock, r.instrument, r.expiry, r.close, r.oi]), [['TCS', 'share', '', 2990, null]])
})
test('an unknown header names the missing column', () => assert.throws(() => parseFoBhavcopy('a,b\n1,2'), /ClsPric|CLOSE/))
```

- [ ] **Step 2: Run** `node --test packages/span/test/*.test.ts` → FAIL.
- [ ] **Step 3: Implement** the scanner (indexOf-based, no per-char regex), `parseSpanFile` (a path stack over `SPAN_TAGS`), `parseExposureFile` (header-driven: `/symbol/i`, then `/total.*elm|applicable.*elm/i`, else the last numeric column), `parseFoBhavcopy` / `parseCmBhavcopy` (header-driven, both generations); `npm install --offline --no-audit --no-fund` to link the workspace.
- [ ] **Step 4: Run** `node --test packages/span/test/*.test.ts && npm run typecheck && git check-ignore packages/span/test/fixtures/ael_19102026.csv` → tests PASS; `check-ignore` prints nothing (the fixture is tracked).
- [ ] **Step 5: Commit** — `git add packages/span package-lock.json .gitignore && git commit -m "feat(span): NSE SPAN XML, exposure and end-of-day bhavcopy parsers (traders items 14, 28)"`

---

### Task 6: SPAN calculator

**Files:**
- Create: `packages/span/src/margin.ts`; Modify: `packages/span/src/index.ts`
- Test: `packages/span/test/margin.test.ts`

**Interfaces:**
- Consumes: Task 5's `SpanFile`, `spanKey`, `findContract`.
- Produces:
```ts
export interface SpanPosition { readonly symbol: string; readonly kind: 'future' | 'option'; readonly expiry: string /* YYYY-MM-DD */; readonly strike: number | null; readonly optType: 'CE' | 'PE' | null; readonly qty: number /* signed units */ }
export interface SpanResult {
  readonly scanningRisk: number; readonly worstScenario: number   // 1–16; 0 when nothing priced
  readonly interMonthSpread: number; readonly shortOptionMinimum: number
  readonly netOptionValue: number      // long option value − short option value, at file prices; REPORTED, not netted (V-SP4)
  readonly initial: number             // max(scanningRisk + interMonthSpread, shortOptionMinimum)
  readonly exposure: number; readonly total: number                // total = initial + exposure
  readonly missing: readonly string[]  // spanKey(kind, expiry, …) of positions `findContract` cannot place; 'exposure rate for <SYM>' when the ELM rate is absent
}
export function spanMargin(positions: readonly SpanPosition[], file: SpanFile, elm: ReadonlyMap<string, number>): SpanResult
```
- Algorithm (best reading, V-SP2/3/6): per commodity, scenario loss `L[s] = Σ qty × riskArray[s]`; scanning risk `max(0, max_s L[s])`, `worstScenario` the first argmax. Tier net delta `Σ qty × delta` over contracts whose month is in the tier; spreads in ascending priority: when an A-leg tier and a B-leg tier have opposite non-zero net deltas, `n = min(|ΔA|/ratioA, |ΔB|/ratioB)`, charge `n × rate`, both |Δ| reduced by `n × ratio`. SOM `Σ |qty| × somRate` over short options. Exposure: futures `|qty| × price × elm`; short options `|qty| × same-month future price × elm`; long options 0; opposite-sign futures in different months: `min(|long|, |short|)` of the far leg charged at 1/3, of the near leg at 0, the remainder at full.

- [ ] **Step 1: Write the failing test** (`RA_*` live in `test/fixtures/arrays.ts`, the same values `mini.spn` carries; `MINI = parseSpanFile(readFileSync(fixture('mini.spn'), 'utf8'))`)

```ts
const RA_FUT_OCT = [10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 60, -60, 70, -70, 35, -35]
const RA_FUT_NOV = RA_FUT_OCT.map((v) => v * 1.01)
const RA_CE = [4, -4, 8, -8, 12, -12, 16, -16, 20, -20, 24, -24, 28, -28, 14, -14]
const RA_PE = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))
const ELM = new Map([['TCS', 0.035]])
const pos = (kind, expiry, strike, optType, qty) => ({ symbol: 'TCS', kind, expiry, strike, optType, qty })
const OCT = '2026-10-27', NOV = '2026-11-23'

test('scanning risk is the worst of 16 scenarios', () => {
  const r = spanMargin([pos('future', OCT, null, null, 100)], MINI, ELM)
  assert.deepEqual([r.scanningRisk, r.worstScenario], [7000, 13])
})
test('a short call offsets a long future', () =>
  assert.equal(spanMargin([pos('future', OCT, null, null, 100), pos('option', OCT, 3000, 'CE', -100)], MINI, ELM).scanningRisk, 4200))
test('calendar spread: scan + inter-month charge, exposure 1/3 on the far leg', () => {
  const r = spanMargin([pos('future', OCT, null, null, 100), pos('future', NOV, null, null, -100)], MINI, ELM)
  close(r.scanningRisk, 70, 1e-9); assert.equal(r.worstScenario, 14); close(r.interMonthSpread, 300, 1e-9)
  close(r.initial, 370, 1e-9); close(r.exposure, 3535, 1e-6)                 // 100 × 3030 × 0.035 / 3
})
test('the short option minimum floors SPAN', () => {
  const r = spanMargin([pos('option', OCT, 3000, 'PE', -350)], MINI, ELM)
  assert.deepEqual([r.scanningRisk, r.shortOptionMinimum, r.initial], [175, 525, 525])
})
test('net option value is reported, not netted', () => {
  const r = spanMargin([pos('option', OCT, 3000, 'CE', 100), pos('option', OCT, 3000, 'PE', -350)], MINI, ELM)
  assert.equal(r.netOptionValue, 6000 - 17500); assert.equal(r.initial, Math.max(r.scanningRisk + r.interMonthSpread, r.shortOptionMinimum))
})
test('exposure: futures and short options; long options none', () => {
  close(spanMargin([pos('future', OCT, null, null, 175)], MINI, ELM).exposure, 18436.25, 1e-6)   // 175 × 3010 × 0.035
  close(spanMargin([pos('option', OCT, 3000, 'CE', -175)], MINI, ELM).exposure, 18436.25, 1e-6)
  assert.equal(spanMargin([pos('option', OCT, 3000, 'CE', 175)], MINI, ELM).exposure, 0)
})
test('a contract not in the file is named and not counted', () => {
  const r = spanMargin([pos('future', '2026-12-29', null, null, 100)], MINI, ELM)
  assert.deepEqual([r.missing, r.initial], [['future|2026-12-29||'], 0])
})
test('no ELM rate for the symbol is named', () =>
  assert.ok(spanMargin([pos('future', OCT, null, null, 100)], MINI, new Map()).missing.includes('exposure rate for TCS')))
```

- [ ] **Step 2: Run** `node --test packages/span/test/margin.test.ts` → FAIL.
- [ ] **Step 3: Implement** `spanMargin` per the algorithm; header comment lists V-SP2/3/4/6 and says the golden suite (Task 8) is the proof.
- [ ] **Step 4: Run** `node --test packages/span/test/*.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(span): scanning risk, inter-month spread, SOM floor, exposure margin"`

---

### Task 7: the span job — download and save only (P11, P12)

**Files:**
- Create: `scripts/span_job.py`, `scripts/test_span_job.py`, `packages/span/test/span-job.test.ts`
- Modify: `ecosystem.desk.config.cjs` (append one app object), `.gitignore` (append `/data/` and `/.venv-nse/`), `docs/runbooks/traders.md` (append section "SPAN job")

**Interfaces:**
- Produces (Python, stdlib only at import time):
```python
class FileSpec(NamedTuple): key: str; name: str; url: str; member: str | None   # member: suffix of the ONE zip member to extract ('.spn', '.csv'); None = save as is
def files_for(day: date) -> list[FileSpec]                     # V-J2
def run_once(day: date, fetch: Callable[[str], bytes | None], root: Path, now: Callable[[], float], log: Callable[[str], None]) -> int  # files saved; None from fetch = "not yet"
def prune(root: Path, today: date, keep_days: int = 7) -> list[str]   # removes dated folders older than today − keep_days
def nse_fetcher() -> Callable[[str], bytes | None]             # lazy `import nsepythonserver` (V-J1); 404 -> None
def main(argv: list[str]) -> int                               # --dir, --date, default today IST
```
- Behaviour: fetch today's files and the previous weekday's end-of-day SPAN, F&O and CM (cash) files; each file lands in the folder of ITS OWN business date, `<root>/<YYYY-MM-DD>/` (the date in its name) — R3 reads yesterday's OI and close from `<root>/<previous trading day>/BhavCopy_NSE_FO_0_0_0_<YYYYMMDD>_F_0000.csv`, NSE's UDiFF format (`TckrSymb`, `XpryDt`, `StrkPric`, `OptnTp`, `OpnIntrst`, `ClsPric`; V-J2), saved UNZIPPED, and the cash-market bhavcopy beside it, `BhavCopy_NSE_CM_0_0_0_<YYYYMMDD>_F_0000.csv`, also unzipped — the two files R2's `EodStore` (Task 10) reads for yesterday's close and OI; skip any key already in that folder's `manifest.json` (`{key: {name, url, savedAt, bytes, sha256}}`); from a zip extract exactly one member whose basename ends with `member`, refusing a name containing `/`, `\` or `..` and any member over `MAX_BYTES = 200 * 1024 * 1024`; write `<name>.tmp` then `os.replace` (the TS reader never sees half a file), the manifest the same way; one log line per file `saved | not yet | failed: <reason>`; exit 0 unless an unexpected exception (exit 1). Root: env `TRADERS_NSE_DIR`, default `<repo>/data/nse` — one folder for every NSE file, shared with R3.
- pm2 entry (not through `app()`, which pins the node interpreter):
```js
{ name: 'desk-traders-span', namespace: 'desk', script: 'scripts/span_job.py', cwd: ROOT,
  interpreter: secrets.TRADERS_NSE_PYTHON ?? path.join(ROOT, '.venv-nse/bin/python'),
  autorestart: false, cron_restart: '*/15 3-14 * * 1-5',  // box is UTC: every 15 min, 08:30–20:15 IST, Mon–Fri
  time: true, merge_logs: true, out_file: 'logs/desk-traders-span-out.log', error_file: 'logs/desk-traders-span-err.log',
  env: { TRADERS_NSE_DIR: secrets.TRADERS_NSE_DIR ?? path.join(ROOT, 'data/nse') } }
```

- [ ] **Step 1: Write the failing tests** — `scripts/test_span_job.py` (`unittest`, a temp dir, a fake fetcher that records URLs; loads `span_job.py` by path with `importlib.util.spec_from_file_location`; builds zips in memory with `zipfile`):
  - `test_files_for_names`: names for `date(2026,10,19)` include `nsccl.20261019.s.zip`, `nsccl.20261019.i1.zip` … `i5.zip`, `ael_19102026.csv`, `BhavCopy_NSE_FO_0_0_0_20261019_F_0000.csv.zip` (saved as the member `BhavCopy_NSE_FO_0_0_0_20261019_F_0000.csv`) and `BhavCopy_NSE_CM_0_0_0_20261019_F_0000.csv.zip` (saved as its `.csv`).
  - `test_previous_day_files_go_to_their_own_folder`: on 2026-10-19 the 2026-10-16 F&O and CM files land in `root/2026-10-16/`, unzipped.
  - `test_saves_into_dated_folder`: fetcher serves a zip holding `nsccl.20261019.i1.spn` for the i1 URL and CSV bytes for the ael URL, `None` for the rest → returns 2; `root/2026-10-19/nsccl.20261019.i1.spn` and `ael_19102026.csv` exist; manifest has both keys with correct `sha256`.
  - `test_idempotent`: a second `run_once` makes zero fetches for the saved keys and returns 0.
  - `test_not_yet_is_not_an_error`: all `None` → returns 0, every log line is `not yet`, folder empty of data files.
  - `test_refuses_traversal`: member `../evil.spn` → nothing written outside the folder, log `failed`, key absent from manifest.
  - `test_refuses_oversize`: with `MAX_BYTES` patched to 10 → `failed`, no file.
  - `test_no_tmp_left`: no `*.tmp` anywhere after a run.
  - `test_prune`: folders `2026-10-11`, `2026-10-12`, `2026-10-19`, today `2026-10-19` → removes only `2026-10-11`.
  - Node wrapper `packages/span/test/span-job.test.ts`: `execFileSync('python3', ['scripts/test_span_job.py'], { cwd: repoRoot })` exits 0; skipped with a reason when `python3 --version` fails.
- [ ] **Step 2: Run** `python3 scripts/test_span_job.py -v` → FAIL (no `span_job.py`).
- [ ] **Step 3: Implement** `span_job.py`; add the pm2 entry and `.gitignore` lines; append the runbook section: operator creates the venv (`python3 -m venv /opt/algomaker-delta/.venv-nse && /opt/algomaker-delta/.venv-nse/bin/pip install nsepythonserver` — needs the network, operator only), runs one download by hand (O2: `.venv-nse/bin/python scripts/span_job.py`), ticks V-J1–V-J4 against what landed, then `npx pm2 start ecosystem.desk.config.cjs --only desk-traders-span`; where files land; the 7-day retention and the disk check.
- [ ] **Step 4: Run** `python3 scripts/test_span_job.py -v && node --test packages/span/test/span-job.test.ts && node -e "require('./ecosystem.desk.config.cjs')"` → PASS, config loads. Do NOT run `span_job.py` itself.
- [ ] **Step 5: Commit** — `git commit -m "feat(span): span job — download and save NSE SPAN, exposure and F&O files; pm2 cron"`

---

### Task 8: golden SPAN cases — harness now, cases when Q6 arrives (gated)

**Files:**
- Create: `packages/span/src/trim.ts`, `packages/span/test/trim.test.ts`, `packages/span/test/golden.test.ts`, `packages/span/test/golden/README.md`
- Modify: `packages/span/src/index.ts`

**Interfaces:**
- Consumes: `scanXml` offsets, `SPAN_TAGS`, `parseSpanFile`, `parseExposureFile`, `spanMargin`.
- Produces: `export function trimSpanXml(xml: string, symbols: ReadonlySet<string>): string` — drops every `ccDef`/`futPf`/`oopPf`/`phyPf` block whose symbol is not in `symbols`, keeps everything else byte for byte.
- Fixed location: `packages/span/test/golden/<YYYY-MM-DD>-<HHMM>/` holding `span.spn` (trimmed), `ael.csv`, `case.json` = `{ "taken": "<ISO+05:30>", "broker": "<name>", "books": [{ "name": "…", "positions": SpanPosition[], "brokerSpan": number, "brokerExposure": number }] }`. README states the Q6 rules: 3–5 real books, SPAN and exposure given separately, a known day and time, outside expiry week, client codes scrubbed.

- [ ] **Step 1: Write the failing tests** — `trim.test.ts`: trimming `mini.spn` to `{'TCS'}` re-parses with 4 contracts; to `{'OTHER'}` re-parses with 0 commodities and `businessDate` `'2026-10-19'`. `golden.test.ts`: discovers case folders; with none, a single `test('golden SPAN cases', { skip: 'no Phase 0 golden portfolios yet (spec Q6) — see packages/span/test/golden/README.md' })`; per book asserts `Math.abs(ours.total − (brokerSpan + brokerExposure)) ≤ 0.01 × (brokerSpan + brokerExposure)` and its failure message prints ours vs broker for span and exposure separately.
- [ ] **Step 2: Run** `node --test packages/span/test/trim.test.ts packages/span/test/golden.test.ts` → trim FAILS; golden reports one skipped test.
- [ ] **Step 3: Implement** `trimSpanXml`; the README.
- [ ] **Step 4: Run** the same command → trim PASS; golden skipped with the message above.
- [ ] **Step 5: Commit** — `git commit -m "test(span): golden-case harness and SPAN file trimmer (cases arrive with Q6)"`
- [ ] **Step 6 (GATED on Phase 0 Q6 and one real SPAN file from O2):** add each case (trim with `trimSpanXml`); run `node --test packages/span/test/golden.test.ts`; resolve V-SP1–V-SP7 by what the cases show (fix `SPAN_TAGS`, NOV handling, exposure base, regenerate `mini.spn` to the corrected map); record the outcome in the headers of `spn.ts` and `margin.ts`. Item 28 is done when every case is within 1%. Commit `test(span): Phase 0 golden cases — within 1% of <broker>`.

---

### Task 9: the per-book market snapshot — each leg on its own month (P5), illiquid IV (10), 60 s cache (P13), and every R2 wire type

**Files:**
- Create: `apps/traders/src/analytics/snapshot.ts`, `apps/traders/src/analytics/wire.ts`, `apps/traders/src/analytics/units.ts`, `apps/traders/src/analytics/calendar.ts`, `apps/traders/test/fixtures/r2-book.ts`, `apps/traders/test/snapshot.test.ts`, `apps/traders/test/units-calendar.test.ts`
- Modify: `apps/traders/package.json` (dependencies `@algomaker/payoff`, `@algomaker/greeks`, `@algomaker/core`, `@algomaker/desk-engine`, `@algomaker/span` — whichever R1 lacks; then `npm install --offline --no-audit --no-fund`); R1's `apps/traders/src/analytics/book-view.ts` (one line, N8: `iv` through `liquidIv`); `apps/traders/src/deps.ts` + `app.ts` (N1, N13: `snapshots: SnapshotCache`)

**Interfaces:**
- Consumes: contract `TraderLeg`, `Instrument`, `OptType`; R1's `monthQuotes`, `MonthQuotes`, `forwardFor`, `ForwardSource`, `spotTokenOf`, `nearestFuture`, `lotSizeOf`, `matchLeg`, `isOpenLeg`, `istDate`, `TradersDeps`, `createApp`, `TradersQuotes`, `TradersMaster`, `TraderStore`, `LegStore`, `TradersDb` (N1, N4–N6, N8); `solveChainIvs`, `ChainQuoteLite`, `SolvedIv`, `liquidIv` (Task 2), `PayoffLeg`, `DEFAULT_RATE`; `yearsToExpiry`; `isMarketOpen`, `fixedClock` (`@algomaker/core`).
- Produces (`snapshot.ts`):
```ts
export type VolBasis = 'future' | 'synthetic' | 'cash'
export interface SnapshotMarket { readonly master: () => TradersMaster; readonly quotes: TradersQuotes /* R1's: price, bid, ask, oi, volume, asOf, ageMs (N5) */; readonly now: () => number }
export interface PricedLeg {
  readonly leg: TraderLeg
  readonly payoff: PayoffLeg              // id = leg.key; a share is instrument 'future', expiry ''; iv = marketIv
  readonly ltp: number | null; readonly bid: number | null; readonly ask: number | null
  readonly syntheticFuture: number | null // options: strike + CE LTP − PE LTP at this strike and month; null otherwise or when a side has no quote
  readonly marketIv: number | null
  readonly ivSource: 'quote' | 'other-side' | 'nearest' | 'none'
  readonly ivFrom: { readonly strike: number; readonly optType: OptType } | null
  readonly illiquidAuto: boolean          // own row not measured by monthQuotes: missing, older than its window (120 s in session), or unsolved
  readonly lotSize: number | null         // the leg's own month chain
}
export interface BookSnapshot {
  readonly trader: string; readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly spot: number | null
  readonly futures: Readonly<Record<string, number | null>>  // every held month + nearExpiry + nearFuture: the TRADED futures
  readonly optionFutures: Readonly<Record<string, number | null>>   // what options are solved and priced against: = futures for basis 'future'
  readonly nearExpiry: string | null; readonly lastExpiry: string | null   // nearest listed OPTION expiry ≥ today (an index's is a weekly); latest held expiry
  readonly nearFuture: { readonly expiry: string; readonly price: number | null } | null   // nearest listed FUTURE: To Neutralize's contract
  readonly basis: VolBasis                                   // 'future' from priceBook
  readonly quotes: Readonly<Record<string, readonly ChainQuoteLite[]>>   // raw chain quotes per month, kept for rebase
  readonly expiries: readonly string[]                        // listed option expiries for the stock
  readonly lotSize: number | null; readonly strikeStep: number | null      // the near month's chain
  readonly atm: Readonly<Record<string, number | null>>      // expiry -> master.atmStrike at that month's future
  readonly chains: Readonly<Record<string, readonly SolvedIv[]>>
  readonly legs: readonly PricedLeg[]                         // matched legs only
  readonly unmatched: readonly string[]
  readonly warnings: readonly string[]
}
export const SNAPSHOT_TTL_MS = 60_000
export function toPayoffLeg(l: TraderLeg, iv: number | null): PayoffLeg   // R1 exports none; share → { instrument: 'future', expiry: '' }, as R1's bookView builds them
export function priceBook(trader: string, stock: string, legs: readonly TraderLeg[], m: SnapshotMarket): BookSnapshot
export function withIlliquid(s: BookSnapshot, forced: ReadonlySet<string>): BookSnapshot  // re-stamps forced keys via liquidIv(…, true)
export function rebase(s: BookSnapshot, basis: VolBasis): BookSnapshot   // re-solves every month's MonthQuotes.quotes against: its forward ('future', R1's forwardFor) | its synthetic future (ATM strike + CE − PE LTPs, else the forward, warned) | cash spot
export function chainIvs(d: Pick<TradersDeps, 'master' | 'quotes'>, stock: string, expiry: string, nowMs: number): { readonly future: number | null; readonly forward: number | null; readonly source: ForwardSource | null; readonly tYears: number; readonly solved: readonly SolvedIv[] } | null
  // R3's seam (its N2.2): R1's monthQuotes for any listed (stock, expiry), held or not, spot from spotTokenOf; null when the expiry is not listed — Market Watch and repair read the same solve as Analysis
export class SnapshotCache {
  constructor(m: SnapshotMarket, ttlMs?: number)
  get(trader: string, stock: string, legs: readonly TraderLeg[], version: number): BookSnapshot   // key `${trader}|${stock}|${version}` (LegStore.version), as R1's PayoffCache
}
// deps.ts (R1's TradersDeps) gains `readonly snapshots: SnapshotCache`; createApp builds one from its `master`, `quotes` and `now`
// Task 10 adds `charges` and `eod`, Task 11 `analysisOf`, Task 12 `scenarioOf`, Task 13 `span`
```
- Produces (`units.ts`, `calendar.ts` — here so Tasks 11, 12, 13 can run in parallel):
```ts
export function bookLotGcd(legs: readonly PayoffLeg[], lotSize: number | null): number   // gcd of |lots|; any non-whole-lot leg or unknown lot size → 1; no legs → 1
export function nextTradingDay(day: string): string        // first later day with isTradingDay (@algomaker/desk-engine); past its 2026 calendar: weekends only
export function previousTradingDay(day: string): string    // first earlier such day
```
- Pricing rules: legs not `isOpenLeg(l, today)` are dropped, as R1's bookView does; spot = `quote(spotTokenOf(m, stock))`; `nearFuture` = `nearestFuture(m, stock, today)` (N6, N7); `lotSize` per leg = `lotSizeOf`. Per held month `e` (and the near month) one `monthQuotes(master, quotes, stock, e, spot, now, closed)` (N8 — no second solver, no second forward): `futures[e]` = its `future`, `optionFutures[e]` = its `forward` (own future, else parity, else carry), `quotes[e]` = its `quotes`, `chains[e]` = its `ivs`; a month on `carry` gets R1's warning sentence for it. Option legs take `liquidIv(chains[e], strike, optType, false)`. Warnings (exact prefixes, Review Focus 2): closed → `market closed — last session's prices`; open and `!feedAlive()` → R1's own sentence, `the price feed is not ticking: every price below is the last one seen, not a live one`.
- Produces (`wire.ts`, types only; imports type-only from `../types.ts` and `@algomaker/payoff`; re-exports `ScenarioCell`, `GapInput`, `GapResult`, `PayoffTableRow`, and `VolBasis` from `snapshot.ts`):
```ts
export type IvSource = 'quote' | 'other-side' | 'nearest' | 'override' | 'none'
export interface GreekTotals { readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number; readonly vanna: number; readonly volga: number }
export interface AnalysisParams {
  readonly expiry: string | null; readonly exclude: readonly string[]; readonly illiquid: readonly string[]
  readonly ivOverrides: Readonly<Record<string, number>>; readonly callVol: number; readonly putVol: number; readonly future: number | null
  readonly gap: readonly GapInput[]                       // exactly 2; default [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }]
  readonly gapUseLtp: boolean; readonly gapUseVol: boolean; readonly volBasis: VolBasis   // defaults true, true, 'future'
}
export interface AnalysisLeg {                            // VolHedge v50's columns in its order, then ours
  readonly key: string; readonly source: 'odin' | 'manual'; readonly included: boolean; readonly illiquid: boolean; readonly illiquidAuto: boolean
  readonly maturity: string; readonly maturityDate: string; readonly strike: number | null; readonly type: 'F' | 'C' | 'P' | 'EQ'
  readonly units: number; readonly lots: number | null; readonly ltp: number | null; readonly netPrice: number
  readonly buyPrice: number | null; readonly salePrice: number | null                    // best bid / best ask
  readonly grossMtm: number | null; readonly syntheticFuture: number | null
  readonly timeValue: number | null       // POSITION: −units × (LTP − intrinsic against the leg's own month future), so time value the book is short counts positive (VolHedge v50)
  readonly ivUsed: number | null; readonly marketIv: number | null
  readonly delta: number; readonly deltaValue: number; readonly vega: number; readonly vegaValue: number   // plain = per share (T); value = × units
  readonly remarks: string
  readonly gamma: number; readonly gammaValue: number; readonly theta: number; readonly thetaValue: number
  readonly vanna: number; readonly vannaValue: number; readonly volga: number; readonly volgaValue: number
  readonly ivSource: IvSource; readonly ivFrom: { readonly strike: number; readonly optType: OptType } | null
}
export interface ToNeutralize { readonly units: number; readonly pct: number | null /* VolHedge prints one (420 → −1.14 %); its base is unknown, so null until confirmed */; readonly lots: number; readonly side: 'Buy' | 'Sell' | null; readonly contract: string; readonly text: string }
export interface MtmCols { readonly previous: number | null; readonly today: number; readonly total: number | null }   // null = yesterday's close unknown: shown '—'
export interface MtmBlock {                                  // VolHedge v50's block: rows Gross MTM, Expense, Current MTM × columns Previous, Today, Total
  readonly gross: MtmCols; readonly expense: MtmCols; readonly current: MtmCols
  readonly squareOff: number; readonly projected: number | null
  readonly payInOut: number; readonly cfBalance: number
  readonly partial: readonly string[]; readonly ratesConfirmed: boolean; readonly notes: readonly string[]
}
export interface AnalysisView {
  readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly spot: number | null; readonly future: number | null; readonly futureOverridden: boolean
  readonly nearExpiry: string | null; readonly daysToExpiry: number | null; readonly nearFuture: string | null; readonly lotSize: number | null; readonly lotGcd: number
  readonly months: readonly { readonly expiry: string; readonly label: string }[]
  readonly params: AnalysisParams; readonly legs: readonly AnalysisLeg[]
  readonly totals: { readonly T: GreekTotals; readonly N: GreekTotals; readonly note: string }
  readonly monthWise: readonly { readonly label: string; readonly expiry: string; readonly totals: GreekTotals }[]
  readonly optionGreeks: GreekTotals
  readonly comparison: { readonly T: GreekTotals; readonly N: GreekTotals; readonly diff: GreekTotals; readonly note: string }   // "Greeks Comparison" tab
  readonly toNeutralize: ToNeutralize | null
  readonly bookTimeValue: number
  readonly breakevens: { readonly low: number | null; readonly high: number | null; readonly expiry: string | null; readonly text: string }
  readonly gapPanel: { readonly on: string; readonly basis: VolBasis; readonly useLtp: boolean; readonly useVol: boolean; readonly rows: readonly GapResult[]; readonly note: string }
  readonly mtm: MtmBlock; readonly unmatched: readonly string[]; readonly warnings: readonly string[]
}
export interface HypotheticalLeg { readonly id: string; readonly instrument: Instrument; readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null; readonly qty: number; readonly price: number | null; readonly iv: number | null }
export interface ScenarioRequest {
  readonly exclude?: readonly string[]; readonly illiquid?: readonly string[]; readonly ivOverrides?: Readonly<Record<string, number>>
  readonly spot?: number; readonly callVolShift?: number; readonly putVolShift?: number; readonly volShift?: number
  readonly start?: string; readonly end?: string; readonly everyNth?: number
  readonly middle?: number; readonly stepPct?: number; readonly count?: number      // VolHedge v50: M.Strike, Interval %, Strike +/-
  readonly targetDate?: string; readonly targets?: readonly number[]; readonly hypothetical?: readonly HypotheticalLeg[]
}
export interface ScenarioLegRow {                         // VolHedge v50 scenario leg table, per share unless 'value'
  readonly id: string; readonly hypothetical: boolean; readonly expiry: string; readonly type: 'F' | 'C' | 'P' | 'EQ'; readonly underlying: number; readonly strike: number | null
  readonly qty: number; readonly rate: number; readonly vol: number | null; readonly ltp: number | null
  readonly delta: number; readonly deltaValue: number; readonly gamma: number; readonly gammaValue: number; readonly vega: number; readonly vegaValue: number; readonly theta: number; readonly thetaValue: number
}
export interface ScenarioResolved { readonly spot: number; readonly callVolShift: number; readonly putVolShift: number; readonly volShift: number; readonly start: string; readonly end: string; readonly everyNth: number; readonly middle: number; readonly stepPct: number; readonly count: number; readonly targetDate: string }
export interface ScenarioView {
  readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly nearExpiry: string; readonly lastExpiry: string; readonly expiries: readonly string[]
  readonly lotSize: number | null; readonly lotGcd: number; readonly resolved: ScenarioResolved
  readonly totals: ScenarioCell                           // the top row: P&L and greeks at CMP on the first column
  readonly legs: readonly ScenarioLegRow[]                 // the leg table: book legs, then hypothetical rows
  readonly grid: { readonly spots: readonly number[]; readonly currentRow: number; readonly dates: readonly string[]; readonly labels: readonly string[]; readonly cells: readonly (readonly ScenarioCell[])[] }
  readonly baseNote: string
  readonly chart: { readonly targetDate: string; readonly expiryDate: string; readonly spot: number; readonly points: readonly { readonly price: number; readonly target: number; readonly expiry: number }[] }
  readonly table: readonly PayoffTableRow[]
  readonly hypothetical: readonly { readonly id: string; readonly accepted: boolean; readonly reason: string | null; readonly entry: number | null; readonly iv: number | null }[]
  readonly warnings: readonly string[]
}
export interface SpanSourceView { readonly file: string; readonly label: string; readonly businessDate: string; readonly savedAt: number | null }
export interface MarginView {
  readonly available: boolean; readonly initial: number | null; readonly exposure: number | null; readonly total: number | null
  readonly peak: { readonly total: number; readonly label: string } | null     // highest total over today's SPAN files
  readonly parts: { readonly scanningRisk: number; readonly worstScenario: number; readonly interMonthSpread: number; readonly shortOptionMinimum: number; readonly netOptionValue: number } | null
  readonly span: SpanSourceView | null; readonly exposureFile: SpanSourceView | null
  readonly stale: boolean; readonly missing: readonly string[]; readonly notes: readonly string[]
}
export interface SegmentRates { readonly sttBuyPct: number; readonly sttSellPct: number; readonly exchangePct: number; readonly stampBuyPct: number }
export interface Brokerage { readonly mode: 'order' | 'lot'; readonly amount: number }
export interface ChargeRates {
  readonly option: SegmentRates; readonly future: SegmentRates; readonly share: SegmentRates
  readonly sebiPerCrore: number; readonly gstPct: number
  readonly brokerage: { readonly default: Brokerage; readonly byTrader: Readonly<Record<string, Brokerage>> }
  readonly confirmedBy: string | null; readonly confirmedAt: number | null
}
```
- Produces (`test/fixtures/r2-book.ts`, reused by Tasks 10–13): `R2_NOW = Date.UTC(2026, 9, 19, 4, 30)`; `r2Master()` — TCS spot (token 1), futures 2026-10-27 (10), 2026-11-23 (11), 2026-12-29 (12), options 2900/3000/3100 CE+PE in all three months, lot 175 (rows built the way `packages/instruments/test` builds them); `r2Quotes(over?)` — age 1 s unless noted: spot 3000, FUT Oct 3010, FUT Nov 3030, Oct 2900 PE 25, Oct 3000 CE 60 (bid 59.5, ask 60.5; every other quote has no depth;), Oct 3000 PE 50, Oct 3100 CE 30 (age 11 min), Oct 3100 PE 120, Nov 3000 CE 95, Nov 3000 PE 75, nothing for December; `r2Legs()` for trader `asha`, client `C1` — L1 Oct 3000 CE −175 @50, L2 Nov 3000 CE +175 @80, L3 Oct 3100 CE −175 @35, L4 Oct FUT +175 @3000, L5 manual share +1000 @2950 key `manual:s1`, L6 unmatched Oct 3050 CE (token null), with their keys exported as `L1`…`L6`; `futLeg(qty)`, `shareLeg(qty)` build one more Oct-future / manual-share `TraderLeg`; `TM` = a `TradersMaster` wrapping `r2Master()`; `r2Quotes(prices?: Readonly<Record<number, number | null>>, opts?: { ageMs?: number; feedAlive?: boolean })` → a fake `TradersQuotes` (`prices` maps token → price, `null` removes it; `ageMs` overrides every age); `r2Market(over?: { now?: number; ageMs?: number; feedAlive?: boolean; quotes?: Readonly<Record<number, number | null>> })` → a `SnapshotMarket` over `TM` and `r2Quotes`.

- [ ] **Step 1: Write the failing test** (`snapshot.test.ts`)

```ts
const s = priceBook('asha', 'TCS', r2Legs(), r2Market())
const by = (k: string) => s.legs.find((l) => l.leg.key === k)!
test('each month is solved against its own future and tenor', () => {
  assert.equal(by(L1).marketIv, b76ImpliedVol(60, { future: 3010, strike: 3000, t: yearsToExpiry('2026-10-27', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
  assert.equal(by(L2).marketIv, b76ImpliedVol(95, { future: 3030, strike: 3000, t: yearsToExpiry('2026-11-23', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
  assert.equal(by(L1).ivSource, 'quote')
})
test('a stale own quote is auto-illiquid and takes the other side', () =>
  assert.deepEqual([by(L3).illiquidAuto, by(L3).ivSource, by(L3).ivFrom], [true, 'other-side', { strike: 3100, optType: 'PE' }]))
test('a viewer tick forces the fallback', () => {
  const f = withIlliquid(s, new Set([L1])).legs.find((l) => l.leg.key === L1)!
  assert.deepEqual([f.ivSource, f.ivFrom], ['other-side', { strike: 3000, optType: 'PE' }])
})
test('a month with no future prices off R1’s parity forward (Review Focus 1)', () => {
  const n = priceBook('asha', 'TCS', r2Legs(), r2Market({ quotes: { 11: null } }))
  const fwd = forwardFor(TM, r2Quotes({ 11: null }), 'TCS', '2026-11-23', 3000, R2_NOW)!     // parity at 3000: 3000 + (95 − 75)·e^{rt}
  assert.deepEqual([n.futures['2026-11-23'], n.optionFutures['2026-11-23'], fwd.source], [null, fwd.price, 'parity'])
  assert.equal(n.legs.find((l) => l.leg.key === L2)!.marketIv, b76ImpliedVol(95, { future: fwd.price, strike: 3000, t: yearsToExpiry('2026-11-23', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
})
test('shares and futures carry no IV; the share prices at spot', () => {
  assert.deepEqual([by(L5).payoff.instrument, by(L5).payoff.expiry, by(L5).ltp, by(L5).marketIv], ['future', '', 3000, null])
})
test('unmatched legs are listed and left out', () => { assert.equal(s.legs.length, 5); assert.equal(s.unmatched.length, 1) })
test('buy/sale price and synthetic future per leg', () => {
  assert.deepEqual([by(L1).bid, by(L1).ask, by(L1).syntheticFuture, by(L3).syntheticFuture, by(L4).syntheticFuture], [59.5, 60.5, 3010, 3010, null])
})
test('the near future is the nearest listed future', () => assert.deepEqual(s.nearFuture, { expiry: '2026-10-27', price: 3010 }))
test('chainIvs is the same solve, for a month nobody holds too', () => {
  assert.deepEqual(chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', '2026-10-27', R2_NOW)!.solved, s.chains['2026-10-27'])
  const dec = chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', '2026-12-29', R2_NOW)!                                   // listed, nothing quoted
  assert.deepEqual([dec.source, dec.solved.length], ['carry', 0])
  assert.equal(chainIvs({ master: () => TM, quotes: r2Quotes() }, 'TCS', '2027-01-26', R2_NOW), null)                               // not listed
})
test('rebase: cash prices every month off spot; synthetic off ATM strike + CE − PE', () => {
  const cash = rebase(s, 'cash'), syn = rebase(s, 'synthetic')
  assert.equal(cash.legs.find((l) => l.leg.key === L2)!.marketIv, b76ImpliedVol(95, { future: 3000, strike: 3000, t: yearsToExpiry('2026-11-23', R2_NOW), rate: DEFAULT_RATE, type: 'CE' }))
  assert.deepEqual([syn.basis, syn.optionFutures['2026-10-27'], syn.optionFutures['2026-11-23'], syn.futures['2026-11-23']], ['synthetic', 3010, 3020, 3030])   // Nov: 3000 + 95 − 75; traded futures untouched
})
test('the near month is known even when no leg holds it', () => {
  const n = priceBook('asha', 'TCS', r2Legs().filter((l) => l.key === L2), r2Market())
  assert.deepEqual([n.nearExpiry, n.futures['2026-10-27'], n.lotSize], ['2026-10-27', 3010, 175])
})
test('market closed: last session prices, labelled', () => {
  const c = priceBook('asha', 'TCS', r2Legs(), r2Market({ now: Date.UTC(2026, 9, 24, 6, 0), ageMs: 2 * 86_400_000 }))
  assert.equal(c.closed, true); assert.notEqual(c.legs[0]!.marketIv, null)
  assert.ok(c.warnings.includes("market closed — last session's prices"))
})
test('a dead feed in session is said', () =>
  assert.ok(priceBook('asha', 'TCS', r2Legs(), r2Market({ feedAlive: false })).warnings.some((w) => w.startsWith('the price feed is not ticking'))))
test('the cache serves one snapshot per minute and recomputes on a new upload', () => {
  // counting TradersQuotes: second get within 60 s → same object, zero quote() calls; version + 1 → new object; now + 60_001 → new object
})
```
  `units-calendar.test.ts`:
```ts
test('lot gcd', () => {
  assert.equal(bookLotGcd([opt(-525), opt(-525)], 175), 3); assert.equal(bookLotGcd([opt(-1225), opt(525)], 175), 1)
  assert.equal(bookLotGcd([share(1000)], 175), 1); assert.equal(bookLotGcd([], 175), 1); assert.equal(bookLotGcd([opt(-525)], null), 1)
})
test('trading days skip weekends and NSE holidays', () => {
  assert.equal(nextTradingDay('2026-10-19'), '2026-10-21')      // 20 Oct is Dussehra
  assert.equal(nextTradingDay('2026-10-23'), '2026-10-26')
  assert.equal(previousTradingDay('2026-10-19'), '2026-10-16')
})
```

- [ ] **Step 2: Run** `node --test apps/traders/test/snapshot.test.ts apps/traders/test/units-calendar.test.ts` → FAIL.
- [ ] **Step 3: Implement** `snapshot.ts` (incl. `chainIvs`), `wire.ts`, `units.ts`, `calendar.ts`; add `snapshots` to `TradersDeps` and build one `SnapshotCache` in `createApp` (N13) from R1's `master`, `quotes` and `now`.
- [ ] **Step 4: One IV on both tabs** — in R1's `book-view.ts` replace `iv = ivFor(month.ivs, strike, optType)` with `liquidIv(month.ivs, strike, optType, false).iv` (N8); run `node --test apps/traders/test/*.test.ts` → PASS. An R1 assertion that pinned an interpolated IV for a leg with no fresh quote of its own was asserting the rule item 10 replaces: update it and say so in the commit message.
- [ ] **Step 5: Run** `npm run typecheck` → PASS. **Commit** — `git commit -m "feat(traders): book snapshot — each leg's IV from its own month, illiquid fallback, 60 s cache; R2 wire types"`

---

### Task 10: charges (14a), the end-of-day reader, the MTM block (14) and `GET|PUT /admin/settings`

**Files:**
- Create: `apps/traders/src/analytics/charges.ts`, `apps/traders/src/analytics/eod.ts`, `apps/traders/src/analytics/mtm.ts`, `apps/traders/src/routes/settings.ts`
- Modify: `apps/traders/src/deps.ts` + `app.ts` (`charges`, `eod`; `start()` refreshes `eod` at once and every 60 s; route list), `apps/traders/src/routes/endpoints.ts` (ids `admin.settings.get` GET and `admin.settings.put` PUT, pattern `/v1/traders/admin/settings`, kind `admin`), `apps/traders/test/ownership-cases.ts` (their `CASES`: a trader gets 403)
- Test: `apps/traders/test/charges.test.ts`, `apps/traders/test/eod.test.ts`, `apps/traders/test/mtm.test.ts`, `apps/traders/test/settings-routes.test.ts` (suite `settings`, i.e. db `algomaker_traders_test_settings`)

**Interfaces:**
- Consumes: `ChargeRates`, `SegmentRates`, `Brokerage`, `MtmBlock`, `MtmCols` (wire.ts); `PricedLeg`, `TradersDeps`, `SnapshotCache`, `previousTradingDay` (Task 9); `EodContract`, `parseFoBhavcopy`, `parseCmBhavcopy` (Task 5); `PayoffLeg`; R1's `legsFromTrades`, `ledgerTradeOf` (Task 7, in the cycle test); contract `TraderTrade`, `Instrument`; `TradersDb` (N4), N3, N9, N10.
- Produces:
```ts
export interface Fill { readonly instrument: Instrument; readonly side: 'Buy' | 'Sell'; readonly qty: number /* shares, > 0 */; readonly price: number; readonly orderNo: string; readonly lotSize: number | null }
export interface ChargeBreakdown { readonly brokerage: number; readonly stt: number; readonly exchange: number; readonly sebi: number; readonly stamp: number; readonly gst: number; readonly total: number }
export const SEED_RATES: ChargeRates
export function brokerageFor(rates: ChargeRates, trader: string): Brokerage
export function chargesFor(fills: readonly Fill[], rates: ChargeRates, trader: string): ChargeBreakdown
export function parseRates(raw: unknown): ChargeRates | { readonly error: string }   // client confirmedBy/confirmedAt ignored → null
// eod.ts — THE end-of-day reader (R3's Market Watch reads OI and close through it too, as deps.eod)
export interface EodStatus { readonly day: string /* previousTradingDay(today) */; readonly fo: string | null; readonly cm: string | null; readonly missing: readonly string[] /* file names not found for that day */ }
export class EodStore {
  constructor(opts: { readonly dir: string /* TRADERS_NSE_DIR */; readonly now: () => number })
  refresh(): Promise<void>                        // reads <dir>/<previousTradingDay(today)>/ BhavCopy_NSE_FO_…csv and BhavCopy_NSE_CM_…csv (parseFoBhavcopy / parseCmBhavcopy); re-parses only when the day or a file changes; a file that fails to parse counts as missing, named with its error
  status(): EodStatus
  close(c: EodContract): number | null            // yesterday's CLOSE; null when that day's file is missing or has no such row
  oi(c: EodContract): number | null               // yesterday's OI (F&O only)
}
// deps.ts: TradersDeps gains `readonly eod: EodStore`
export interface MtmInputs {
  readonly legs: readonly PricedLeg[]                       // open legs (ltp, avgPrice)
  readonly todayTrades: readonly TraderTrade[]              // this stock, today
  readonly earlierTrades: readonly TraderTrade[]            // this stock, before today, inside each open contract's current cycle
  readonly ltpOf: (c: EodContract) => number | null         // live LTP of any contract of the book (contracts closed today included)
  readonly closeOf: (c: EodContract) => number | null       // EodStore.close
  readonly eodMissing: readonly string[]                    // EodStore.status().missing
  readonly bse: boolean                                     // the underlying's chain is on BFO (master.options.chain(stock, e).exchange): NSE files never cover it
  readonly lotSizeOf: (instrument: Instrument, expiry: string) => number | null
  readonly rates: ChargeRates; readonly trader: string
}
export function openCycleTrades(trades: readonly TraderTrade[], today: string): readonly TraderTrade[]   // the trades R1's legsFromTrades (Task 7) averages for each open contract — since its net qty was last 0 at a day's end — dated before today; R1 exports positions only, so this returns the trades
export function dayLegs(i: MtmInputs): { readonly legs: readonly PayoffLeg[]; readonly offset: number } | null   // entry = the day's base: (carried × close + today's signed qty × price) / qty; offset = today's realised P&L on contracts closed today; null when any carried contract has no close
export function mtmBlock(i: MtmInputs): MtmBlock
export async function mtmInputsOf(d: TradersDeps, s: BookSnapshot, nowMs: number): Promise<MtmInputs>   // today's and open-cycle trades from traders-trades, live quotes, d.eod, rates
export async function mtmOf(d: TradersDeps, trader: string, stock: string, nowMs: number): Promise<MtmBlock | null>   // null = no open book; Analysis and R3's Portfolio (its N2.4) call it
export class ChargeSettingsStore {                                  // traders-settings { kind: 'charges', trader: null, value, updatedAt, updatedBy } through TradersDb.collection (R1's unique { kind, trader } index keeps it single)
  constructor(db: TradersDb, now: () => number)
  get(): Promise<ChargeRates>                                       // SEED_RATES when none stored; a stored value that fails parseRates → SEED_RATES + logged
  put(rates: ChargeRates, by: string): Promise<ChargeRates>         // stamps confirmedBy = by, confirmedAt = now
}
// routes/settings.ts
export function settingsRoutes(d: Pick<TradersDeps, 'charges'>): Route   // GET → { charges }; PUT { charges } → parseRates → 200 { charges } stamped by the admin
// deps.ts: TradersDeps gains `readonly charges: ChargeSettingsStore`; createApp builds one
```
- `SEED_RATES` — every value is for the operator to confirm; the file comment and the UI say so; none is asserted as today's statutory rate:

| segment | STT buy % | STT sell % | exchange % | stamp buy % |
|---|---|---|---|---|
| option (on premium) | 0 | 0.1 | 0.03503 | 0.003 |
| future | 0 | 0.02 | 0.00173 | 0.002 |
| share (delivery) | 0.1 | 0.1 | 0.00297 | 0.015 |

  `sebiPerCrore: 10`, `gstPct: 18`, `brokerage.default: { mode: 'order', amount: 20 }`, `byTrader: {}`, `confirmedBy: null`, `confirmedAt: null`.
- Formulas: turnover `qty × price`; STT `turnover × (Buy ? sttBuyPct : sttSellPct)/100`; exchange `turnover × exchangePct/100`; SEBI `turnover × sebiPerCrore / 1e7`; stamp `Buy ? turnover × stampBuyPct/100 : 0`; brokerage `'order'` → amount × distinct `orderNo`, `'lot'` → amount × qty/lotSize per F&O fill (a share fill, or unknown lot size, pays amount once per order); GST `(brokerage + exchange + SEBI) × gstPct/100`. `parseRates` limits: pct fields 0–5, `sebiPerCrore` 0–1000, `gstPct` 0–50, brokerage amount 0–10000, `byTrader` keys `[a-z0-9._-]{2,32}`, ≤ 100 entries; errors name the field path (`option.sttSellPct`).
- MTM (VolHedge v50's block; the operator's definitions, 2026-10-19): per contract (open legs ∪ contracts traded today), `carried = qty now − Σ today's signed trade qty`. Gross MTM: `previous = Σ carried × (ltp − close)` with `close` = yesterday's close from `EodStore` (legs carried from before today, valued from yesterday's close), `today = Σ (Buy ? 1 : −1) × qty × (ltp − price)` over today's trades, `total = previous + today`. Expense: `previous = chargesFor(earlierTrades)`, `today = chargesFor(todayTrades)`, `total` = their sum. Current MTM = gross − expense, per column. `squareOff = chargesFor(one closing fill per open leg at LTP, orderNo 'close:'+key)`; `projected = current.total − squareOff`. `payInOut = Σ (Sell ? 1 : −1) × qty × price` over today's OPTION trades; `cfBalance = Σ −qty × avgPrice` over open OPTION legs.
- When yesterday's close is unknown, nothing is guessed: if `eodMissing` is non-empty, gross and current `previous` and `total` and `projected` are null (shown `—`) and each missing file adds the note `'NSE end-of-day file <name> for <DD Mon> is missing — Previous MTM unknown'`; if `bse`, the same nulls and the note `"<STOCK> trades on BSE; NSE's end-of-day files do not cover it — Previous MTM unknown"`. A carried contract with no row in a present file is left out of `previous` and named in `partial`; a contract with no LTP likewise. `notes` then end with, in order: `'Previous = legs carried from before today, from yesterday\'s close (NSE end-of-day CLOSE, not settlement — Phase 0 Q3); Today = today\'s trades'`, `'Projected = current MTM total - square-off cost'`, `'Pay In Out = premium received - paid on today\'s option trades (our reading; Phase 0 Q3)'`, `'CF balance = net premium of the open option legs at net price (our reading; Phase 0 Q3)'`. The block covers the whole book (ticks and month tabs do not apply — it is the account's money).

- [ ] **Step 1: Write the failing tests**

```ts
test('charges on one sold option (seed rates)', () => {
  const c = chargesFor([{ instrument: 'option', side: 'Sell', qty: 175, price: 45, orderNo: 'A1', lotSize: 175 }], SEED_RATES, 'asha')
  close(c.brokerage, 20, 1e-9); close(c.stt, 7.875, 1e-9); close(c.exchange, 2.7586125, 1e-9); close(c.sebi, 0.007875, 1e-12)
  close(c.stamp, 0, 1e-12); close(c.gst, 4.09796775, 1e-9); close(c.total, 34.73945525, 1e-9)
})
test('square-off of a short call and a long future', () => {
  const c = chargesFor([{ instrument: 'option', side: 'Buy', qty: 175, price: 40, orderNo: 'x1', lotSize: 175 }, { instrument: 'future', side: 'Sell', qty: 175, price: 3010, orderNo: 'x2', lotSize: 175 }], SEED_RATES, 'asha')
  const want = { brokerage: 40, stt: 105.35, exchange: 11.564875, sebi: 0.53375, stamp: 0.21, gst: 9.3777525, total: 167.0363775 }
  for (const k of Object.keys(want) as (keyof ChargeBreakdown)[]) close(c[k], want[k], 1e-9)
})
test('per-lot brokerage and a per-trader override', () => {
  const r = { ...SEED_RATES, brokerage: { default: SEED_RATES.brokerage.default, byTrader: { asha: { mode: 'lot', amount: 10 } } } } as ChargeRates
  assert.equal(chargesFor([{ instrument: 'option', side: 'Sell', qty: 525, price: 45, orderNo: 'A1', lotSize: 175 }], r, 'asha').brokerage, 30)
  assert.equal(brokerageFor(r, 'bala').amount, 20)
})
test('parseRates names the bad field and ignores confirmedBy', () => {
  assert.match((parseRates({ ...SEED_RATES, option: { ...SEED_RATES.option, sttSellPct: -1 } }) as { error: string }).error, /option\.sttSellPct/)
  assert.equal((parseRates({ ...SEED_RATES, confirmedBy: 'mallory' }) as ChargeRates).confirmedBy, null)
})
// MTM fixture: legs CE 3000 Oct −350 @47.5 (ltp 40, yesterday's close 44) and FUT Oct +175 @3000 (ltp 3010, close 3005) — closeOf over Task 5's eod fixture values;
// today: Sell 175 CE @45 order A1; earlier (2026-10-16, open cycle): Sell 175 CE @50 order P1, Buy 175 FUT @3000 order P2; SEED_RATES.
// INPUTS = that fixture as MtmInputs (eodMissing [], bse false); m = mtmBlock(INPUTS); NOTES = the four fixed notes
test('the MTM block: Previous / Today / Total', () => {
  const want = { gross: [1575, 875, 2450], expense: [81.4140225, 34.73945525, 116.15347775], current: [1493.5859775, 840.26054475, 2333.84652225] } as const
  for (const row of ['gross', 'expense', 'current'] as const) ['previous', 'today', 'total'].forEach((c, k) => close(m[row][c as keyof MtmCols], want[row][k]!, 1e-9))
  close(m.squareOff, 170.1481155, 1e-9); close(m.projected, 2163.69840675, 1e-9); assert.deepEqual([m.payInOut, m.cfBalance], [7875, 16625])
  assert.deepEqual([m.partial, m.ratesConfirmed, m.notes], [[], false, NOTES])
})
test('the day base reproduces Gross MTM total at LTP', () => {
  const d = dayLegs(INPUTS)!; assert.deepEqual([d.legs.map((l) => l.entry), d.offset], [[44.5, 3005], 0])
})
test('a contract closed today: realised in the offset, split across Previous and Today', () => {
  // + PE carried +175 (close 30, ltp 31), sold today 175 @33: previous += 175, today += 350, offset = 525
})
test('the open cycle starts after the last end-of-day flat, as R1’s ledger', () => {
  // CE: Sell 175 on 10-14, Buy 175 on 10-14 (flat at that day's end), Sell 175 on 10-16 → only the 10-16 trade is in openCycleTrades(…, '2026-10-19')
  // and Σ signed qty × price / net qty over the cycle (plus today's) equals legsFromTrades(null, trades.map(ledgerTradeOf)) avgPrice for every contract
})
test('a leg without an LTP or close is named, not guessed', () => { /* FUT ltp null → gross.previous 700, partial names its key */ })
test('yesterday\'s file missing: Previous MTM is unknown and says which file', () => {
  const x = mtmBlock({ ...INPUTS, eodMissing: ['BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'] })
  assert.deepEqual([x.gross.previous, x.gross.total, x.current.previous, x.current.total, x.projected, x.gross.today], [null, null, null, null, null, 875])
  assert.ok(x.notes.includes('NSE end-of-day file BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv for 16 Oct is missing — Previous MTM unknown'))
  assert.equal(dayLegs({ ...INPUTS, closeOf: () => null }), null)
})
test('a BSE underlying: Previous MTM unknown, with the sentence', () => {
  assert.ok(mtmBlock({ ...INPUTS, bse: true }).notes.includes("TCS trades on BSE; NSE's end-of-day files do not cover it — Previous MTM unknown"))
})
```
  `eod.test.ts` (a temp dir with Task 5's eod fixtures copied in as `2026-10-16/BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv` and `…CM…`; clock 2026-10-19 10:00 IST): `status()` → `{ day: '2026-10-16', fo: 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv', cm: 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv', missing: [] }`; `close` of the Oct 3000 CE → 44, `oi` → 525000, `close` of the TCS share → 2990, of an unknown strike → null; with the clock at 2026-10-21 10:00 IST the day is `2026-10-19` (20 Oct is a holiday) and, with no such folder, both files are in `missing` and every `close` is null; a truncated F&O file is listed in `missing` with its parse error.
  `settings-routes.test.ts` (N10): admin GET with nothing stored → `charges` deepEqual `SEED_RATES`; admin PUT valid → 200, then GET returns it with `confirmedBy: 'admin'` and `confirmedAt` = harness clock; trader PUT → 403 and the stored doc is unchanged; PUT `{ charges: { …, gstPct: 90 } }` → 400 naming `gstPct`.
- [ ] **Step 2: Run** `node --test apps/traders/test/charges.test.ts apps/traders/test/eod.test.ts apps/traders/test/mtm.test.ts apps/traders/test/settings-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces; wire `settingsRoutes` in `createApp`; add both `ENDPOINTS` rows and their ownership `CASES`.
- [ ] **Step 4: Run** `node --test apps/traders/test/*.test.ts` → PASS, including R1's ownership walk and the TradersDb write-guard test.
- [ ] **Step 5: Commit** — `git commit -m "feat(traders): charges rates table (operator-confirmed), end-of-day reader, MTM block, admin settings"`

---

### Task 11: `GET /v1/traders/books/:stock/analysis` (items 8–17, 16 as revised, 22)

**Files:**
- Create: `apps/traders/src/analytics/analysis.ts`, `apps/traders/src/routes/analysis.ts`
- Modify: `apps/traders/src/app.ts` (route list); `apps/traders/src/routes/endpoints.ts` (id `books.analysis`, GET `/v1/traders/books/:stock/analysis`, kind `trader`); `apps/traders/test/ownership-cases.ts` (its case: trader A on B's stock → 404)
- Test: `apps/traders/test/analysis.test.ts`, `apps/traders/test/analysis-routes.test.ts` (suite `analysis`)

**Interfaces:**
- Consumes: `BookSnapshot`, `withIlliquid`, `rebase`, `SnapshotCache`, `bookLotGcd`, `nextTradingDay` (Task 9); `legPoints`, `ivUsed`, `istDay` (Task 3); `gapRows`, `breakevenRange` (Task 4); `mtmOf` (Task 10); N1, N2, N4.
- Produces:
```ts
export function parseAnalysisQuery(q: URLSearchParams): AnalysisParams | { readonly error: string }
export function maturityLabel(expiry: string): string   // VolHedge v50's Maturity column: '2026-10-27' -> 'Oct 26'; '' -> 'EQ'
export function expiryTab(expiry: string): string       // its month tabs: '2026-10-27' -> '27OCT' (unique for index weeklies too); '' -> 'EQ'
export function legTimeValue(units: number, ltp: number | null, strike: number, optType: OptType, future: number): number | null   // −units × (ltp − intrinsic vs future)
export function toNeutralize(delta: number, stock: string, futureExpiry: string, lotSize: number): ToNeutralize   // R3's band chip calls this too
export function buildAnalysis(s: BookSnapshot, p: AnalysisParams, mtm: MtmBlock, nextDay: string): AnalysisView
export async function buildAnalysisView(d: TradersDeps, trader: string, stock: string, p: AnalysisParams, nowMs: number): Promise<AnalysisView | null>   // null = no open book
// deps.ts: TradersDeps gains `readonly analysisOf: (trader: string, stock: string, p: AnalysisParams, nowMs: number) => Promise<AnalysisView | null>`
//   = buildAnalysisView bound to the bag in createApp, the way R1 binds deps.bookView — R3's minute cache wraps it (its N2.8)
export function analysisRoutes(d: Pick<TradersDeps, 'users' | 'analysisOf'>): Route
```
- Query encoding (the web builds exactly this): `expiry=YYYY-MM-DD`; `exclude=<key>` and `illiquid=<key>` repeated; `iv=<key>@<decimal>` repeated (split on the LAST `@`, 0 < iv ≤ 5); `callVol`, `putVol` vol points (|x| ≤ 50); `future` > 0; `gap=<movePct>,<volPts>` exactly twice or not at all (|x| ≤ 50 each); `gapLtp=0|1`, `gapVol=0|1`; `basis=future|synthetic|cash`. ≤ 100 entries per list (keeps the URL well under Node's 16 KB header limit). Errors name the parameter.
- Leg rows (VolHedge v50, spec item 8): `maturity` = `maturityLabel`, `maturityDate` = expiry, `months` and `monthWise` labels = `expiryTab`; `buyPrice`/`salePrice` = best bid/ask; `grossMtm = units × (ltp − netPrice)`; `syntheticFuture` from the snapshot; `timeValue` (options) = `legTimeValue(units, ltp, K, optType, F)` with F the leg's own month future — on VolHedge's JINDALSTEL screen the column is −units × LTP for out-of-the-money legs and sums to the book's TimeValue 156031.25; plain greeks are T per share, value = × units; `ivSource: 'override'` for typed IVs. `remarks` = these parts joined by `' · '`, in order: `'manual'`; `'illiquid (ticked)'` or `'illiquid (no fresh quote)'`; for options only, `'IV from other side 3100 PE'` / `'IV from nearest 3000 PE'` / `'IV typed'` / `'no IV — marks flat'` (nothing for an own-quote IV).
- **T** = `legPoints` at today, spot `× future / nearFuture.price` when `future` is given, IV `ivUsed(leg, { callVolShift: callVol, putVolShift: putVol, ivOverrides })`; **N** = market spot, market IV, no shifts. Visible legs = not month-filtered (shares only under All); excluded legs stay listed with `included: false`. `totals` over visible included legs; `comparison` = the same T, N and `diff = T − N`; `monthWise` per expiry plus `'EQ'` over included legs of every month; `optionGreeks` over included options (T); `bookTimeValue = Σ timeValue` over visible included options; `daysToExpiry` = calendar days from today to `nearExpiry` (VolHedge's `Expiry/Days/Rate1`).
- `toNeutralize` from the T delta of included legs of EVERY month (the whole book, item 13), in the NEAREST FUTURE's lots: `units = −round(delta)`, `lots = −sign(delta) × round(|delta| / lotSize)`, `pct = null` (VolHedge's percentage has an unknown base — Phase 0 Q3); text `Buy 7 lots TCS OCT FUT` / `Sell 1 lot TCS OCT FUT` / `Neutral — within half a lot (-80 shares)`.
- `breakevens` = `breakevenRange` over included legs at `nearExpiry` with T's shifts; `text` `BEP = 2880.4 - 3099.7` (one decimal, `—` for a missing side).
- `gapPanel` (spec 16 revised; item 22 folded in): `on = nextDay`; the book `rebase`d to `volBasis` when it is not `'future'` (options only — futures and shares keep their own prices); `rows = gapRows(included legs, that market, nextDay, gap, ivOverrides, gapUseVol, base)` with `base` = `Σ qty × (ltp − netPrice)` over included legs when `gapUseLtp`, else today's model P&L at spot.
- Fixed notes: `totals.note = 'T = at IV used · N = at market IV — our reading of VolHedge (Phase 0 Q3)'`; `comparison.note = "diff = T - N — our reading of VolHedge's Greeks Comparison (Phase 0 Q3)"`; `gapPanel.note = "At the next open, 09:15 IST <DD Mon> — our reading of VolHedge's Gap Up/Down (Phase 0 Q3)"`. Keys in `exclude`/`illiquid`/`iv` that are not this book's legs are ignored.
- `buildAnalysisView`: `legs.open(trader, stock)` (N4) → null when none → `snapshots.get(…, legs.version(trader))` → `withIlliquid` → `mtmOf(…, nowMs)` → `buildAnalysis(…, nextTradingDay(istDay(nowMs)))`. Route: `whose` (N2) → `parseAnalysisQuery` (400) → `deps.analysisOf(trader, stock, p, deps.now())` → 404 `{ error: 'no open book <STOCK>' }` on null, else 200; `:stock` is upper-cased and checked with R1's `STOCK_RE` (400), as `books.view` does — the same for the scenario and margin routes.

- [ ] **Step 1: Write the failing tests** (fixture of Task 9; `S = priceBook('asha','TCS', r2Legs(), r2Market())`; `P0 = parseAnalysisQuery(new URLSearchParams(''))`; `MTM` any `MtmBlock` literal; `A(s, p) = buildAnalysis(s, p, MTM, '2026-10-21')`; `row(v, k)` = the leg row with key `k`)

```ts
test('the leg table carries VolHedge v50’s columns', () => {
  const r = row(A(S, P0), L1)
  assert.deepEqual([r.type, r.maturity, r.maturityDate, r.strike, r.units, r.lots, r.ltp, r.netPrice, r.buyPrice, r.salePrice, r.grossMtm, r.syntheticFuture, r.timeValue, r.ivSource, r.remarks],
    ['C', 'Oct 26', '2026-10-27', 3000, -175, -1, 60, 50, 59.5, 60.5, -1750, 3010, 8750, 'quote', ''])   // time value 175 × (60 − 10): 10 in the money on the 3010 future
  assert.equal(r.ivUsed, r.marketIv); close(r.deltaValue, r.delta * -175, 1e-9)
  assert.equal(row(A(S, P0), L3).remarks, 'illiquid (no fresh quote) · IV from other side 3100 PE')
  assert.equal(row(A(S, P0), L5).remarks, 'manual')
})
test('an unticked leg leaves every total but keeps its row', () => {
  const a = A(S, P0), b = A(S, { ...P0, exclude: [L1] })
  assert.equal(row(b, L1).included, false); close(b.totals.T.delta, a.totals.T.delta - row(a, L1).deltaValue, 1e-9)
})
test('month tab filters legs, not the month-wise panel', () => {
  const v = A(S, { ...P0, expiry: '2026-11-23' })
  assert.deepEqual(v.legs.map((l) => l.key), [L2]); assert.deepEqual(v.monthWise.map((m) => m.label), ['27OCT', '23NOV', 'EQ'])
})
test('VolHedge’s labels', () => assert.deepEqual([maturityLabel('2026-10-27'), expiryTab('2026-10-27'), expiryTab('2026-10-20'), expiryTab('')], ['Oct 26', '27OCT', '20OCT', 'EQ']))
test('time value reproduces VolHedge’s JINDALSTEL screen (19 Oct 2026, future 1042.70)', () => {
  const rows = [[-10625, 13.8, 1060, 'CE'], [3750, 7.6, 1080, 'CE'], [7500, 4.2, 1100, 'CE'], [1875, 1.55, 940, 'PE'], [5625, 2.65, 960, 'PE'], [5000, 4.6, 980, 'PE'], [-625, 7.35, 1000, 'PE'], [-8125, 13, 1020, 'PE']] as const
  const tv = rows.map(([u, ltp, k, t]) => legTimeValue(u, ltp, k, t, 1042.7)!)
  close(tv[0]!, 146625, 1e-6); close(tv.reduce((a, b) => a + b, 0), 156031.25, 1e-6)
})
test('call vol moves T, never N; a typed IV is the base and is marked; comparison is T − N', () => {
  const v = A(S, { ...P0, callVol: 2, ivOverrides: { [L1]: 0.245 } })
  assert.deepEqual(v.totals.N, A(S, P0).totals.N)
  const r = row(v, L1); close(r.ivUsed!, 0.265, 1e-12); assert.deepEqual([r.ivSource, r.remarks], ['override', 'IV typed'])
  close(v.comparison.diff.vega, v.totals.T.vega - v.totals.N.vega, 1e-9)
})
test('a future override reprices T against it', () => {
  const v = A(S, { ...P0, future: 3040 })
  assert.deepEqual([v.future, v.futureOverridden], [3040, true]); assert.notEqual(v.totals.T.delta, v.totals.N.delta)
})
test('To Neutralize in the nearest future’s lots', () => {
  assert.deepEqual(toNeutralize(-1234, 'TCS', '2026-10-27', 175), { units: 1234, pct: null, lots: 7, side: 'Buy', contract: 'TCS OCT FUT', text: 'Buy 7 lots TCS OCT FUT' })
  assert.equal(toNeutralize(262.5, 'TCS', '2026-10-27', 175).text, 'Sell 2 lots TCS OCT FUT')
  assert.equal(toNeutralize(175, 'TCS', '2026-10-27', 175).text, 'Sell 1 lot TCS OCT FUT')
  assert.equal(toNeutralize(-420, 'JINDALSTEL', '2026-10-27', 625).units, 420)                    // VolHedge: "420.00"
  assert.deepEqual(toNeutralize(80, 'TCS', '2026-10-27', 175), { units: -80, pct: null, lots: 0, side: null, contract: 'TCS OCT FUT', text: 'Neutral — within half a lot (-80 shares)' })
})
test('1,000 shares by hand move delta by 1,000 and To Neutralize by the right lots (spec 4a)', () => {
  const fut = futLeg(-1750), share = shareLeg(1000)                          // Oct FUT −10 lots @3000; manual +1000 shares
  const a = A(priceBook('asha', 'TCS', [fut], r2Market()), P0), b = A(priceBook('asha', 'TCS', [fut, share], r2Market()), P0)
  assert.equal(b.totals.T.delta - a.totals.T.delta, 1000)
  assert.deepEqual([a.toNeutralize!.text, b.toNeutralize!.text], ['Buy 10 lots TCS OCT FUT', 'Buy 4 lots TCS OCT FUT'])
})
test('breakeven range at the near expiry', () => {
  const straddle = priceBook('asha', 'TCS', [optLeg('2026-10-27', 3000, 'CE', -175, 60), optLeg('2026-10-27', 3000, 'PE', -175, 50)], r2Market())
  assert.equal(A(straddle, P0).breakevens.text, 'BEP = 2880.4 - 3099.7')   // F = 2890 / 3110 on the Oct future, × 3000/3010 to spot
})
test('Gap Up/Down: two rows at the next open', () => {
  const g = A(priceBook('asha', 'TCS', [futLeg(-1750)], r2Market()), P0).gapPanel
  assert.deepEqual([g.on, g.rows.map((r) => [r.movePct, r.volPts])], ['2026-10-21', [[10, -10], [-10, -10]]])
  close(g.rows[0]!.price, 3300, 1e-9); close(g.rows[0]!.pnl, -544250, 1e-6); close(g.rows[0]!.change, -526750, 1e-6)   // base = −1750 × (3010 − 3000)
})
test('the vol basis moves options only', () => {
  const fut = priceBook('asha', 'TCS', [futLeg(-1750)], r2Market())
  assert.deepEqual(A(fut, { ...P0, volBasis: 'cash' }).gapPanel.rows, A(fut, P0).gapPanel.rows)
  assert.notDeepEqual(A(S, { ...P0, volBasis: 'cash' }).gapPanel.rows, A(S, P0).gapPanel.rows)
})
test('unknown keys are ignored (Review Focus 3)', () =>
  assert.deepEqual(A(S, { ...P0, exclude: ['bala|option|TCS|2026-10-27|3000|CE'], illiquid: ['nope'], ivOverrides: { nope: 0.5 } }).totals, A(S, P0).totals))
test('query parsing', () => {
  assert.deepEqual(parseAnalysisQuery(new URLSearchParams('exclude=a&exclude=b&iv=manual%3Ax1%400.245&callVol=2&gap=5,0&gap=-5,2&gapLtp=0&basis=synthetic')),
    { expiry: null, exclude: ['a', 'b'], illiquid: [], ivOverrides: { 'manual:x1': 0.245 }, callVol: 2, putVol: 0, future: null,
      gap: [{ movePct: 5, volPts: 0 }, { movePct: -5, volPts: 2 }], gapUseLtp: false, gapUseVol: true, volBasis: 'synthetic' })
  for (const bad of ['iv=k@0', 'callVol=x', 'expiry=OCT', 'future=-1', 'putVol=51', 'gap=5,0', 'gap=60,0&gap=1,1', 'basis=spot', 'gapVol=yes'])
    assert.ok('error' in parseAnalysisQuery(new URLSearchParams(bad)), bad)
})
```
  `analysis-routes.test.ts` (N10): asha `GET /v1/traders/books/TCS/analysis` → 200 with 5 legs and `unmatched.length === 1`; `/books/ZZZ/analysis` → 404; admin `?as=asha` → the same body; asha `/books/BSTOCK/analysis` → 404; `?callVol=x` → 400.
- [ ] **Step 2: Run** `node --test apps/traders/test/analysis.test.ts apps/traders/test/analysis-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces; wire the route; add the `ENDPOINTS` row and its ownership case.
- [ ] **Step 4: Run** `node --test apps/traders/test/*.test.ts && npm run typecheck` → PASS (the ownership walk includes `books.analysis`).
- [ ] **Step 5: Commit** — `git commit -m "feat(traders): Analysis endpoint — VolHedge v50 leg table, T/N, To Neutralize, BEP, Gap Up/Down, MTM"`

---

### Task 12: `POST /v1/traders/books/:stock/scenario` (items 18–21, 23)

**Files:**
- Create: `apps/traders/src/analytics/scenario-view.ts`, `apps/traders/src/routes/scenario.ts`
- Modify: `apps/traders/src/app.ts` (route list); `apps/traders/src/routes/endpoints.ts` (id `books.scenario`, POST `/v1/traders/books/:stock/scenario`, kind `trader`); `apps/traders/test/ownership-cases.ts` (its case, body `{}`)
- Test: `apps/traders/test/scenario-view.test.ts`, `apps/traders/test/scenario-routes.test.ts` (suite `scenario`)

**Interfaces:**
- Consumes: Tasks 3, 4 (`scenario`, `scenarioAxes`, `payoffCurve`, `payoffTable`), Task 9 (`BookSnapshot`, `withIlliquid`, `toPayoffLeg`, `SnapshotMarket`, `bookLotGcd`), Task 10 (`mtmInputsOf`, `dayLegs`), `legPoints`, `forwardAt`, `ivUsed` (Task 3), `isTradingDay` (`@algomaker/desk-engine`, passed into `scenarioAxes`), `liquidIv`, `solveChainIvs`, `b76Price`; N1, N2, N11.
- Produces:
```ts
export function parseScenarioRequest(raw: unknown): ScenarioRequest | { readonly error: string }   // shape and limits
export function resolveHypothetical(h: HypotheticalLeg, s: BookSnapshot, m: SnapshotMarket): { readonly leg: PayoffLeg | null; readonly view: ScenarioView['hypothetical'][number] }
export function buildScenario(s: BookSnapshot, req: ScenarioRequest, hyps: readonly PayoffLeg[], hypViews: ScenarioView['hypothetical'], day: { readonly legs: readonly PayoffLeg[]; readonly offset: number } | null): ScenarioView | { readonly error: string }  // range checks needing the book; day null = grid on net price
export async function buildScenarioView(d: TradersDeps, trader: string, stock: string, req: ScenarioRequest, nowMs: number): Promise<ScenarioView | { readonly error: string } | null>   // null = no open book
// deps.ts: TradersDeps gains `readonly scenarioOf: (trader: string, stock: string, req: ScenarioRequest, nowMs: number) => Promise<ScenarioView | { readonly error: string } | null>`, bound in createApp (R3's N2.8)
export function scenarioRoutes(d: Pick<TradersDeps, 'users' | 'scenarioOf'>): Route
```
- Defaults (echoed in `resolved`; VolHedge v50's grid, spec 20): `spot` = snapshot spot; shifts 0; `start` = today; `end` = `nearExpiry`; `everyNth` 1 (every trading day); `middle` (M.Strike) = `atm[nearExpiry] ?? spot`; `stepPct` (Interval) 0.5; `count` (Strike +/-) 50, i.e. ±25 %; `targetDate` = today; `targets` []. The Expiry column and the chart's expiry curve are `nearExpiry`; `targetDate` ∈ [today, lastExpiry]. Limits: ≤ 20 hypotheticals (`id` `[A-Za-z0-9_-]{1,32}`, qty a non-zero integer), ≤ 5 targets, |shifts| ≤ 50, plus `scenarioAxes`' errors; 64 KB body (N11). The Gap Up/Down panel lives in Analysis (Task 11), not here. No snapshot `nearExpiry` → 409 `{ error: '<STOCK> has no listed expiry' }`.
- Hypotheticals: an option must be listed (`master.resolve`), else `accepted: false`, `reason: 'TCS 2026-10-27 3050 CE is not listed'`; IV = `iv ?? liquidIv(chain of its month, …, false)` — a month outside the snapshot's chains is solved on demand from whatever quotes exist; none → `reason: 'no IV for 2026-12-29 — type one'`; entry = `price ?? LTP ?? b76Price at that IV` (futures: `price ?? future quote ?? forward`; shares: `price ?? spot`). Hypotheticals join every grid, chart and table computation; they are never written anywhere.
- P&L base (VolHedge v50: its grid's Profit/Loss 16188 equals its MTM Total): the grid and `totals` price the `dayLegs` legs plus `offset` — since yesterday's close for carried legs, since the fill for today's trades; the chart and the Sensibull table price against net price, as Sensibull does. `baseNote` exactly: `'Grid: P&L since yesterday\'s close (carried legs) and since the fill (today\'s trades), as VolHedge. Chart and table: P&L against net price, as Sensibull.'`; when `dayLegs` is null (yesterday's file missing, a BSE underlying, a carried contract with no close) the grid prices against net price too and `baseNote` is `'Grid, chart and table: P&L against net price — yesterday\'s close is unknown (see the MTM block)'`. `totals` = the cell at (`currentRow`, first column). `legs` rows (VolHedge's scenario leg table) at CMP and the first column via `legPoints`: `underlying` = the leg's forward (`forwardAt`), `rate` = entry, `vol` = IV used, per-share greeks and value = × qty.
- `lotGcd` covers included book legs plus accepted hypotheticals. Viewer `exclude`/`illiquid`/`ivOverrides` apply as in Task 11.
- `buildScenarioView`: Task 11's flow up to `withIlliquid`, then `resolveHypothetical` per row, `dayLegs(await mtmInputsOf(d, s, nowMs))`, then `buildScenario`. Route: `whose` → `parseScenarioRequest` (400) → `deps.scenarioOf(trader, stock, req, deps.now())` → 404 on null; `{ error }` → 400, except no listed expiry → 409.

- [ ] **Step 1: Write the failing tests** (Task 9 fixture; `S = priceBook('asha', 'TCS', r2Legs(), r2Market())`; `H` = any valid `HypotheticalLeg`)

```ts
test('defaults are resolved and echoed', () => {
  const v = buildScenario(S, {}, [], [], null) as ScenarioView
  assert.deepEqual(v.resolved, { spot: 3000, callVolShift: 0, putVolShift: 0, volShift: 0, start: '2026-10-19', end: '2026-10-27', everyNth: 1, middle: 3000, stepPct: 0.5, count: 50, targetDate: '2026-10-19' })
  assert.deepEqual([v.grid.labels, v.grid.spots.length, v.grid.currentRow], [['19 Oct', '21 Oct', '22 Oct', '23 Oct', '26 Oct', '27 Oct', 'Expiry'], 101, 50])
  assert.deepEqual(v.totals, v.grid.cells[50]![0]); assert.equal(v.legs.length, 5)
})
test('the grid’s top row equals Gross MTM total at LTP, as VolHedge (16188 = 16188 on its screen)', () => {
  const book = priceBook('asha', 'TCS', [futLeg(-1750)], r2Market())                  // carried; previous close 3005, LTP 3010
  const v = buildScenario(book, {}, [], [], dayLegs(inputsFor(book))!) as ScenarioView   // inputsFor: MtmInputs with no trades today, closeOf(Oct FUT) = 3005
  close(v.totals.pnl, mtmBlock(inputsFor(book)).gross.total, 1e-9); close(v.totals.pnl, -8750, 1e-9)
})
test('grid cells are scenario() at the axes', () => { /* v.grid.cells[r][c].pnl === scenario(legs, market, v.grid.spots, scenarioAxes(…).columns, shifts).cells[r][c].pnl */ })
test('the Expiry column is the near month and far legs keep time value (Review Focus 1)', () => {
  // L2-only book: cell at (3000, 'Expiry') === legPnl(L2 payoff, 3030, 27/365)
})
test('an excluded leg leaves the grid', () => { /* exclude [L1] → every cell differs by exactly L1's own pnl at that point */ })
test('a hypothetical joins the scenario', () => {
  const r = resolveHypothetical({ id: 'h1', instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: null, iv: null }, S, r2Market())
  assert.deepEqual([r.view.accepted, r.view.entry], [true, 120]); assert.equal(r.view.iv, S.chains['2026-10-27']!.find((x) => x.strike === 3100 && x.type === 'PE')!.iv)
})
test('an unlisted strike is refused with a reason', () =>
  assert.equal(resolveHypothetical({ id: 'h2', instrument: 'option', expiry: '2026-10-27', strike: 3050, optType: 'CE', qty: -175, price: null, iv: null }, S, r2Market()).view.reason, 'TCS 2026-10-27 3050 CE is not listed'))
test('a month with no IV needs one typed', () => {
  const h = { id: 'h3', instrument: 'option', expiry: '2026-12-29', strike: 3000, optType: 'CE', qty: 175, price: null, iv: null } as const
  assert.equal(resolveHypothetical(h, S, r2Market()).view.reason, 'no IV for 2026-12-29 — type one')
  assert.equal(resolveHypothetical({ ...h, iv: 0.25 }, S, r2Market()).view.accepted, true)
})
test('chart and Sensibull table present', () => {
  const v = buildScenario(S, {}, [], [], null) as ScenarioView
  assert.deepEqual([v.chart.points.length, v.chart.expiryDate], [121, '2026-10-27']); assert.ok(v.table.some((r) => r.label === 'spot'))
})
test('every number in the view is finite (Review Focus 4)', () => {
  // walkNumbers(json, fn) visits every number in a JSON value
  for (const req of [{ volShift: -50 }, { spot: 0.01 }, { targetDate: '2026-11-23' }]) walkNumbers(buildScenario(S, req, [], [], null), (n) => assert.ok(Number.isFinite(n)))
})
test('request limits name the field', () => {
  const err = (x: unknown) => (x as { error: string }).error
  assert.match(err(parseScenarioRequest({ hypothetical: Array(21).fill(H) })), /hypothetical/)
  assert.match(err(parseScenarioRequest({ volShift: 60 })), /volShift/)
  assert.match(err(buildScenario(S, { targetDate: '2026-12-01' }, [], [], null)), /targetDate/)   // after the last held expiry
  assert.match(err(buildScenario(S, { count: 101 }, [], [], null)), /count/)
})
```
  `scenario-routes.test.ts` (N10): asha `POST /books/TCS/scenario {}` → 200; with one hypothetical → 200 and afterwards `traders-legs` count and `GET /books/TCS` `legCount` are unchanged; `/books/ZZZ/scenario` → 404; asha → `/books/BSTOCK/scenario` → 404; a 65 KB body → 413.
- [ ] **Step 2: Run** `node --test apps/traders/test/scenario-view.test.ts apps/traders/test/scenario-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces; wire the route (R1's `JSON_BODY_MAX` is already 64 KB, N11); add the `ENDPOINTS` row and its ownership case.
- [ ] **Step 4: Run** `node --test apps/traders/test/*.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(traders): Scenario endpoint — VolHedge grid, target/expiry curve, Sensibull table, hypothetical legs"`

---

### Task 13: `GET /v1/traders/books/:stock/margin` (items 15, 28)

**Files:**
- Create: `apps/traders/src/analytics/margin.ts`, `apps/traders/src/routes/margin.ts`
- Modify: `apps/traders/src/app.ts` (N13: `new SpanStore({ dir: process.env.TRADERS_NSE_DIR ?? path.resolve('data/nse'), now })`; in `start()`, `refresh(new Set((await legs.allOpen()).map((l) => l.stock)))` at once and every 60 s; route list); `apps/traders/src/routes/endpoints.ts` (id `books.margin`, GET `/v1/traders/books/:stock/margin`, kind `trader`); `apps/traders/test/ownership-cases.ts` (its case)
- Test: `apps/traders/test/margin.test.ts`, `apps/traders/test/margin-routes.test.ts` (suite `margin`)

**Interfaces:**
- Consumes: `parseSpanFile`, `parseExposureFile`, `spanMargin`, `SpanPosition` (Tasks 5–6); `BookSnapshot`, `previousTradingDay` (Task 9); `isMarketOpen`, `fixedClock`; Task 7's folder layout and `manifest.json`.
- Produces:
```ts
export interface SpanFileName { readonly kind: 'eod' | 'intraday'; readonly businessDate: string; readonly seq: number }   // eod seq = 99
export function parseSpanFileName(name: string): SpanFileName | null   // 'nsccl.20261019.i2.spn' -> { 'intraday', '2026-10-19', 2 }
export class SpanStore {
  constructor(opts: { readonly dir: string; readonly now: () => number })
  refresh(symbols: ReadonlySet<string>): Promise<void>   // rescans; parses the newest file and every file of its business date, keeping only `symbols` (parseSpanFile's `only`); re-parses when `symbols` grows; on failure keeps the last good and records lastError
  span(): { readonly file: SpanFile; readonly source: SpanSourceView } | null          // the newest
  today(): readonly { readonly file: SpanFile; readonly source: SpanSourceView }[]   // every parsed file of the newest business date, oldest first
  exposure(): { readonly rates: ReadonlyMap<string, number>; readonly source: SpanSourceView } | null
  lastError(): string | null
}
export function spanPositions(s: BookSnapshot, exclude: ReadonlySet<string>): readonly SpanPosition[]   // included option + future legs, with their full expiry
export function marginFor(s: BookSnapshot, exclude: ReadonlySet<string>, store: SpanStore, now: number): MarginView
export async function bookMargin(d: TradersDeps, trader: string, stock: string, nowMs: number, exclude?: ReadonlySet<string>): Promise<MarginView | null>   // null = no open book; the route and R3's Portfolio (its N2.3) call it
export function marginRoutes(d: TradersDeps): Route   // ?exclude=<key> repeated
// deps.ts: TradersDeps gains `readonly span: SpanStore | null` (null when TRADERS_NSE_DIR is unreadable)
```
- `bookMargin`: Task 11's flow up to the snapshot, then `marginFor`; `span` null in the deps → the no-file answer below. Route: `whose` → `exclude` from repeated query params → `bookMargin(d, trader, stock, d.now(), exclude)` → 404 on null.
- Rules: newest SPAN = max by (businessDate, seq) across `<dir>/*/`; exposure = newest `ael_DDMMYYYY.csv`. Labels: intraday `NSE SPAN HH:MM` (IST, from the manifest's `savedAt`), end of day `NSE SPAN end of day DD Mon`, exposure `NSE exposure DD Mon`. `stale` when the SPAN business date is before the previous trading day, or the market is open, it is 13:00 IST or later, and no intraday file of today exists. Share legs and excluded legs are left out, with notes `'Shares are cash segment: not in SPAN'` and `'<n> unticked leg(s) left out'`. `missing` from `spanMargin` is passed through and each one adds a note `'not in the SPAN file: <key> — the figure is partial'`. `peak` = the highest `total` over `today()` files with that file's label, note `"Peak = highest of today's NSE SPAN files (our reading of VolHedge's peak-margin line)"`; null when `today()` is empty. No SPAN file → `available: false`, all figures null, `notes` exactly `['No NSE SPAN file yet — margin appears once the span job has saved one']` (spec item 15: show nothing rather than an estimate). `lastError` → note `'<file> did not parse: <reason>; showing <previous file>'`.

- [ ] **Step 1: Write the failing tests** (a temp dir; `mini.spn` and the ael fixture copied in under the names below with a `manifest.json`; `S` = Task 9's TCS book — `mini.spn` carries L1 and L4's contracts, not L2's or L3's)

```ts
test('file names', () => {
  assert.deepEqual(parseSpanFileName('nsccl.20261019.i2.spn'), { kind: 'intraday', businessDate: '2026-10-19', seq: 2 })
  assert.deepEqual(parseSpanFileName('nsccl.20261016.s.spn'), { kind: 'eod', businessDate: '2026-10-16', seq: 99 })
  assert.equal(parseSpanFileName('notes.txt'), null)
})
test('the newest file wins and is named', async () => {
  // 2026-10-16/nsccl.20261016.s.spn; 2026-10-19/nsccl.20261019.i1.spn (mini.spn with every risk array × 2, savedAt 11:01 IST) and …i2.spn (mini.spn, 13:31 IST)
  await store.refresh(new Set(['TCS'])); assert.deepEqual([store.span()!.source.file, store.span()!.source.label], ['nsccl.20261019.i2.spn', 'NSE SPAN 13:31'])
})
test('the book’s margin equals spanMargin on its positions', () => {
  const m = marginFor(S, new Set(), store, R2_NOW)
  const direct = spanMargin(spanPositions(S, new Set()), store.span()!.file, store.exposure()!.rates)
  assert.deepEqual([m.initial, m.exposure, m.total], [direct.initial, direct.exposure, direct.total])
  assert.ok(m.notes.includes('Shares are cash segment: not in SPAN'))
})
test('a contract not in the file is named and the figure marked partial (Review Focus 5)', () => {
  assert.ok(marginFor(S, new Set(), store, R2_NOW).notes.some((n) => n.startsWith('not in the SPAN file: option|2026-10-27|3100|CE')))
})
test('peak is the highest of today’s files', async () => {
  const m = marginFor(S, new Set(), store, R2_NOW)
  assert.equal(m.span!.file, 'nsccl.20261019.i2.spn'); assert.equal(m.peak!.label, 'NSE SPAN 11:01'); assert.ok(m.peak!.total > m.total!)
})
test('only the books’ symbols are kept in memory', async () => {
  await store.refresh(new Set(['INFY'])); assert.equal(store.span()!.file.commodities.size, 0)
})
test('stale: past 13:00 IST with no intraday file today', async () => {
  // only 2026-10-16/nsccl.20261016.s.spn present
  assert.equal(marginFor(S, new Set(), store, Date.UTC(2026, 9, 19, 8, 30)).stale, true)    // 14:00 IST
  assert.equal(marginFor(S, new Set(), store, Date.UTC(2026, 9, 19, 4, 30)).stale, false)   // 10:00 IST, Friday's EOD is current
})
test('a file that does not parse keeps the last good one', async () => {
  // add a truncated nsccl.20261019.i3.spn → span() still i2; lastError names i3; the note says so
})
test('no file yet shows nothing, with the sentence', () => {
  const m = marginFor(S, new Set(), emptyStore, R2_NOW)
  assert.deepEqual([m.available, m.initial, m.notes], [false, null, ['No NSE SPAN file yet — margin appears once the span job has saved one']])
})
```
  `margin-routes.test.ts` (N10, the store pointed at a temp dir): asha `GET /books/TCS/margin` → 200 `MarginView`; `?exclude=<L4>` → `initial` differs from the unexcluded figure; asha → `/books/BSTOCK/margin` → 404.
- [ ] **Step 2: Run** `node --test apps/traders/test/margin.test.ts apps/traders/test/margin-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces; the `createApp`/`start` wiring; the `ENDPOINTS` row and its ownership case.
- [ ] **Step 4: Run** `node --test apps/traders/test/*.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(traders): margin endpoint — NSE SPAN + exposure per book, peak, file named, stale in amber"`

---

### Task 14: web — R2 client, viewer state, units toggle (item 23)

**Files:**
- Create: `apps/web/src/traders/viewer.ts`, `apps/web/src/traders/units.tsx`
- Modify: `apps/web/src/traders/api.ts` (R1's: `analysisQuery` and five `tapi` methods)
- Test: `apps/web/test/traders-r2-api.test.tsx`, `apps/web/test/traders-units.test.tsx`

**Interfaces:**
- Consumes: `import type` from `apps/traders/src/analytics/wire.ts` (Task 9, N12); R1's `tapi` request path, `setAsTrader` (`?as=`) (N12).
- Produces:
```ts
// api.ts additions
export interface AnalysisQueryInput {
  readonly expiry: string | null; readonly exclude: readonly string[]; readonly illiquid: readonly string[]; readonly ivOverrides: Readonly<Record<string, number>> /* decimal */
  readonly callVol: number; readonly putVol: number; readonly future: number | null
  readonly gap?: readonly GapInput[]; readonly gapUseLtp?: boolean; readonly gapUseVol?: boolean; readonly volBasis?: VolBasis
}
export function analysisQuery(p: AnalysisQueryInput): string   // order: expiry, exclude…, illiquid…, iv…, callVol, putVol, future, gap×2, gapLtp, gapVol, basis; zero/null/default omitted
// tapi gains (over R1's tradersApi.get/post/put): analysis(stock, p: AnalysisQueryInput): Promise<AnalysisView>; scenario(stock, body: ScenarioRequest): Promise<ScenarioView>
//             margin(stock, exclude: readonly string[]): Promise<MarginView>; chargeSettings(): Promise<{ charges: ChargeRates }>; putChargeSettings(c: ChargeRates): Promise<{ charges: ChargeRates }>
// (stock path segment encodeURIComponent'd, as R1's book(); `?as=` appended by R1's helper)
// viewer.ts — an in-memory store keyed by stock (never persisted), so the Analysis and Scenario sub-tabs — separate BOOK_SUBTABS entries — share one set of ticks
export interface ViewerState { readonly exclude: readonly string[]; readonly illiquid: readonly string[]; readonly ivOverrides: Readonly<Record<string, number>> }
export function useViewer(stock: string): { state: ViewerState; toggleExclude(key: string): void; toggleIlliquid(key: string): void; setIv(key: string, iv: number | null): void; units: Units; setUnits(u: Units): void }   // units are page-wide
// units.tsx
export type Units = 'share' | 'lot' | 'position'
export function scaleBook(value: number, u: Units, lotSize: number | null, lotGcd: number): number   // position: v; lot: v / lotGcd; share: v / (lotGcd × lotSize); lotSize null → v
export function scaleLeg(perShare: number, u: Units, lotSize: number | null, qty: number): number   // share: v; lot: v × lotSize; position: v × qty
export function UnitsToggle(props: { readonly lotSize: number | null }): React.ReactElement  // SegmentedControl 'Per share | Per lot | Whole position'; default 'position'; share/lot disabled with title 'Lot size unknown' when lotSize is null
```
- The per-lot definition is ours (labelled under the toggle): `'Per lot = this book ÷ its common lot count; per share = per lot ÷ lot size'`.

- [ ] **Step 1: Write the failing tests**

```ts
test('analysisQuery builds exactly what the server parses', () => expect(analysisQuery({ expiry: null, exclude: ['A|option|TCS|2026-10-27|3000|CE'], illiquid: [], ivOverrides: { 'manual:x1': 0.245 }, callVol: 2, putVol: 0, future: null }))
  .toBe('exclude=A%7Coption%7CTCS%7C2026-10-27%7C3000%7CCE&iv=manual%3Ax1%400.245&callVol=2'))
test('analysisQuery carries the Gap Up/Down panel', () => expect(analysisQuery({ expiry: null, exclude: [], illiquid: [], ivOverrides: {}, callVol: 0, putVol: 0, future: null,
  gap: [{ movePct: 5, volPts: 0 }, { movePct: -5, volPts: 2 }], gapUseLtp: false, volBasis: 'synthetic' })).toBe('gap=5%2C0&gap=-5%2C2&gapLtp=0&basis=synthetic'))
test('tapi.analysis hits the contract path, M&M encoded', async () => { /* installFetch; path '/v1/traders/books/M%26M/analysis' */ })
test('scaleBook / scaleLeg', () => {
  expect([scaleBook(5250, 'position', 175, 3), scaleBook(5250, 'lot', 175, 3), scaleBook(5250, 'share', 175, 3), scaleBook(5250, 'share', null, 3)]).toEqual([5250, 1750, 10, 5250])
  expect([scaleLeg(0.45, 'share', 175, -525), scaleLeg(0.45, 'lot', 175, -525), scaleLeg(0.45, 'position', 175, -525)]).toEqual([0.45, 78.75, -236.25])
})
test('viewer state is per stock and survives switching sub-tabs', () => { /* toggleExclude('k') under TCS → INFY's exclude is []; unmount and remount a TCS consumer → still ['k'] */ })
test('UnitsToggle disables per share/lot without a lot size', () => { /* lotSize null → the two options are disabled */ })
```
- [ ] **Step 2: Run** `cd apps/web && npx vitest run test/traders-r2-api.test.tsx test/traders-units.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the three files (Astryx `SegmentedControl`; no raw `<div>` layout, tokens only — `apps/web/AGENTS.md`).
- [ ] **Step 4: Run** the same + `npm run typecheck --workspace @algomaker/web` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web/traders): R2 client, per-book viewer state, units toggle"`

---

### Task 15: web — the Analysis tab (VolHedge v50 layout)

**Files:**
- Create: `apps/web/src/traders/analysis-tab.tsx`, `leg-table.tsx`, `greek-panels.tsx`, `gap-panel.tsx`, `margin-box.tsx`
- Modify: `apps/web/src/traders/book.tsx` (R1's, N12) — append `{ id: 'analysis', label: 'Analysis', render: ({ stock }) => <AnalysisTab stock={stock} /> }` to `BOOK_SUBTABS`
- Test: `apps/web/test/traders-analysis.test.tsx`

**Interfaces:**
- Consumes: Task 14 (`tapi.analysis`, `tapi.margin`, `useViewer`, `scaleBook`, `scaleLeg`, `UnitsToggle`); R1's `usePoll`; `AnalysisView`, `MarginView`.
- Produces: `export function AnalysisTab(props: { readonly stock: string }): React.ReactElement`.
- Layout (VolHedge v50, `trader-data-sample/anydesk00004.png`): header — `Expiry/Days/Rate1` (`maturityLabel(nearExpiry)`, `daysToExpiry`, `future`), `Call Vol %`, `Put Vol %`, `Future` (override), `Equity` (`spot`), `Stop` / `Start Future Update` (Stop freezes the shown future as the override until Start), a price-basis control showing `LTP` (the only basis in R2), `Lot Size`; `Cal ON` and `No of Day` are not built (meaning unknown, Phase 0 Q3). Month tabs `All` + `months` (`27OCT`), `UnitsToggle`. Leg table: a select-all checkbox column, then headers exactly `['Illiq.', 'Maturity', 'MDate', 'Strike', 'Type', 'Units', 'Lots', 'LTP', 'Net Price', 'Buy Price', 'Sale Price', 'GrossMTM', 'Synfut', 'TimeValue', 'Vol (%)', 'Mkt Vol (%)', 'Delta', 'D.V', 'Vega', 'V.V', 'Remarks', 'Gamma', 'G.V', 'Theta', 'T.V']`; `Vol (%)` is a `NumberInput` in vol points (sent as a decimal); plain greek columns through `scaleLeg`, value columns as served. Bottom tabs `Total | Month Wise | Option Greeks | Greeks Comparison`: rows `T`, `N` (and `T − N` on Comparison) × `Delta Gamma Vega Theta Volga Vanna` through `scaleBook`, plus `Pay In Out` (`mtm.payInOut`) on Total, the matching note under each. Left box: `To Neutralize` as `units` to 2 decimals and `(— %)` titled `base to confirm` while `pct` is null, with `text` under it; `Online Update` (pauses the 60 s poll), `Calculate` (refetch now), `CF Balance` (`mtm.cfBalance`), `TimeValue` (`bookTimeValue`), `breakevens.text`. Margin box: `Tot. Marg. (in Lacs)` (`total / 1e5`, 2 decimals), `Init.`, `Exp.`, `EQ.` (`—`, titled `cash-segment margin is not computed`), `PM.` (`peak`), the SPAN and exposure labels, amber `Token` when `stale`, the server's sentence when `!available`, `notes`. MTM table: rows `Gross MTM`, `Expense` (shown negative), `Current MTM` × `Previous`, `Today`, `Total`, then `Sq. off Exp.` (negative) and `Proj. MTM`; a null prints `—` and the block's notes (which file is missing, or the BSE sentence) print under it; Banner `Rates not confirmed by admin — expenses are estimates` when `!ratesConfirmed`; the partial list. `Gap Up Down` panel: ticks `Ltp` (`gapUseLtp`) and `Vol` (`gapUseVol`), rows `Scenario-1`, `Scenario-2` (price %, vol pts) with the server's P&L, `Calculate (Alt+C)`, ticks `Cal Vol Using EQ` (`basis=cash`) and `Cal Vol Using syn future` (`basis=synthetic`), at most one on; `gapPanel.note`. `warnings` in a Banner; `closed` → `Market closed — last session's prices`. Refetch 300 ms after any input change; poll every 60 s unless Online Update is off.

- [ ] **Step 1: Write the failing tests** (`installFetch` from `test/http.tsx`, a hand-written `AnalysisView`/`MarginView` body)
  - `renders the leg table headers in VolHedge v50's order` — the header cells after the checkbox column equal the array above.
  - `unticking a leg sends exclude` — click the first row's include checkbox → after 300 ms the last request's `url.searchParams.getAll('exclude')` equals `[legs[0].key]`.
  - `typing a vol sends it as a decimal` — type `24.5` in the first `Vol (%)` → `iv` param `<key>@0.245`.
  - `the 23NOV month tab sends expiry` — `expiry=2026-11-23`.
  - `To Neutralize prints units and the server's sentence` — `1234.00`, `(— %)` and `Buy 7 lots TCS OCT FUT` visible.
  - `the Gap Up Down rows are editable` — set Scenario-1 to `5` / `0` → `gap=5,0` then the unchanged `gap=-10,-10`; untick `Ltp` → `gapLtp=0`; tick `Cal Vol Using EQ` → `basis=cash`, then `Cal Vol Using syn future` → `basis=synthetic` and the EQ tick clears.
  - `margin box states` — `available: false` shows the sentence; `stale: true` shows the label in an amber Token; `available: true, total: 125000` shows `1.25` lacs, `NSE SPAN 13:31` and the `PM.` value.
  - `the MTM table` — nine cells in VolHedge's order from `mtm.gross`/`expense`/`current`, expenses printed negative; with `gross.previous: null` the Previous and Total cells print `—` and the missing-file note shows; `Sq. off Exp.` and `Proj. MTM`; the rates banner, `Market closed — last session's prices` and `BEP = 2880.4 - 3099.7` render from the body.
  - `Per lot rescales the Total row` — with `lotGcd: 3`, the T Delta cell changes from `-525` to `-175`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run test/traders-analysis.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the five components and the `BOOK_SUBTABS` entry.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run && npm run typecheck --workspace @algomaker/web` → PASS (every desk test unchanged).
- [ ] **Step 5: Commit** — `git commit -m "feat(web/traders): Analysis tab — VolHedge v50 leg table, greeks tabs, To Neutralize, Gap Up/Down, MTM, margin"`

---

### Task 16: web — the Scenario tab (grid, hypothetical rows)

**Files:**
- Create: `apps/web/src/traders/scenario-tab.tsx`, `scenario-grid.tsx`, `hypothetical-rows.tsx`, `what-if.ts`
- Modify: `apps/web/src/traders/book.tsx` — append `{ id: 'scenario', label: 'Scenario', … }` to `BOOK_SUBTABS`, and make `BookTab` select the sub-tab named by an optional third hash segment (`#/books/TCS/scenario`), the one-line seam `openWhatIf` needs
- Test: `apps/web/test/traders-scenario.test.tsx`

**Interfaces:**
- Consumes: Task 14 (`tapi.scenario`, `useViewer`, `scaleBook`); `sign` from `apps/web/src/format.ts` (N16); `ScenarioView`, `ScenarioRequest`, `HypotheticalLeg`.
- Produces: `export function ScenarioTab(props: { readonly stock: string }): React.ReactElement` holding the request state (Task 17 reads and sets `targetDate`, `volShift` through it); `export const METRICS: readonly { readonly label: string; readonly key: keyof ScenarioCell; readonly value: boolean }[]`; `openWhatIf`, `WhatIfLeg` (below).
- Layout (VolHedge v50, `trader-data-sample/anydesk00003.png`): inputs `CMP`, `Call Vol`, `Put Vol`, `Vol` with `+`/`−` (step 1), `Start`, `Exp` (= `end`), `Interval` (`stepPct`), `Strike +/-` (`count`), `M.Strike` (`middle`), plus ours, `Every Nth day` — each initialised from `resolved`. The leg table: headers `['Expiry', 'C/P/F', 'Underlying', 'Strike', 'Qty', 'Rate', 'Vol(%)', 'LTP', 'Delta', 'Del Val', 'Gamma', 'Gam Val', 'Vega', 'Vg Val', 'Theta', 'Th Val']` over `legs` — book rows read-only, hypothetical rows editable (instrument, expiry from `expiries`, strike, C/P/F, lots → `qty = lots × lotSize`, `Rate` = price and `Vol(%)` optional), a blank row last that becomes a row when filled, a refused row showing `reason`. The top row `Profit/Loss`, `Delta`, `Gamma`, `Vega`, `Theta`, `Volga`, `Vanna` from `totals`. The date-tick row (one checkbox per `labels` entry: hides that column client-side). `METRICS` labels exactly VolHedge's `['Profit & Loss', 'P & L Value', 'Delta', 'Delta Value', 'Gamma', 'Gamma Value', 'Vega', 'Vega Value', 'Theta', 'Theta Value', 'Volga', 'Volga Value', 'Vanna', 'Vanna Value']`; a plain metric goes through `scaleBook`, a Value metric is the whole position (note: `'Value = whole position (greek × units); the plain metric follows the units toggle — our reading of VolHedge (Phase 0 Q3)'`), and `baseNote` under the grid. Grid columns `SpotValue`, `Percent(%)` (from `M.Strike`), then `labels`; `currentRow` has `aria-current="true"` and is scrolled into view; losses red, profits green through `sign()` (`apps/web/src/format.ts`). POST 300 ms after any input change with the viewer's `exclude`, `illiquid`, `ivOverrides`.
- `openWhatIf` (for R3's "show on payoff"): `export type WhatIfLeg = Omit<HypotheticalLeg, 'id' | 'iv'> & { readonly iv?: number | null }`; `export function openWhatIf(stock: string, legs: readonly WhatIfLeg[], label: string): void` in `apps/web/src/traders/what-if.ts` — stores the legs for that stock (ids `w1`, `w2`, …), navigates to `#/books/<stock>/scenario` (R1's `useTradersRoute`), and the tab shows them as hypothetical rows under `From: <label>`.

- [ ] **Step 1: Write the failing tests**
  - `fourteen metric tabs in VolHedge's order` — tab labels equal the array above; the top row prints `totals`.
  - `Delta Value shows the position; Delta follows Per lot` — with `lotGcd 3`, cell (0,0) `delta: -525` shows `-525` on `Delta Value`, `-175` on `Delta` under Per lot.
  - `the expiry date and Expiry are both columns; hiding one sends no request` — `27 Oct` and `Expiry` headers present; untick `21 Oct` → column gone, request count unchanged.
  - `the current spot row is marked` — the row at `currentRow` has `aria-current="true"`.
  - `Interval % and Strike +/- go in the body` — set `0.25` and `20` → body `stepPct: 0.25, count: 20`.
  - `a hypothetical row is sent in lots × lot size and its refusal shown` — fill 3100 PE, lots −1 → body `hypothetical[0].qty === -175`; a reply with `accepted: false, reason: 'TCS 2026-10-27 3050 CE is not listed'` shows that text.
  - `the + button raises the overall vol by 1` — next body `volShift: 1`.
  - `openWhatIf loads hypothetical rows` — `openWhatIf('TCS', [{ instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: 120 }], 'Repair plan 2')` → location `#/books/TCS/scenario`, Scenario active, `From: Repair plan 2`, and the next body's `hypothetical[0]` is `{ id: 'w1', …, iv: null }`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run test/traders-scenario.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the three components, `what-if.ts`, the `BOOK_SUBTABS` entry and the hash seam.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run && npm run typecheck --workspace @algomaker/web` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web/traders): Scenario tab — VolHedge grid with metric tabs and hypothetical rows"`

---

### Task 17: web — payoff chart with target-date and IV-shift sliders, Sensibull table (item 21)

**Files:**
- Create: `apps/web/src/traders/payoff-sliders.tsx`
- Modify: `apps/web/src/traders/scenario-tab.tsx` (mount it above the grid)
- Test: `apps/web/test/traders-payoff-sliders.test.tsx`

**Interfaces:**
- Consumes: `ScenarioView['chart']`, `ScenarioView['table']`, the Scenario tab's request state (`targetDate`, `volShift` setters), `scaleBook`.
- Produces: `export function PayoffSliders(props: { readonly view: ScenarioView; readonly today: string; readonly onTarget: (date: string) => void; readonly onVolShift: (pts: number) => void }): React.ReactElement`.
- Chart: recharts `LineChart` with the desk chart's idioms (colours from `useTheme().token(...)`, `connectNulls={false}`, `isAnimationActive={false}`; formatters from `apps/web/src/format.ts`), two lines `Target <DD Mon>` (dashed) and `Expiry <DD Mon>` (solid) over `chart.points`, a vertical line at `chart.spot`. Astryx `Slider` for the date (integer days from `today` to `lastExpiry`, the label shows the date) and for IV shift (−20…+20 vol points, step 1) — the IV slider IS the overall vol input of Task 16 (one state). Under it the Sensibull table: columns `['Price', 'Label', 'P&L on <DD Mon target>', 'P&L at expiry <DD Mon near>']` over `table`, values through `scaleBook`. Imports nothing from `payoff.tsx`, `payoff-curves.tsx` or `chart.tsx`: those draw three fixed dates and stay as they are.

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`)
  - `the date slider sends a target date after the debounce` — move to 5 days → after 300 ms the body has `targetDate: '2026-10-24'`.
  - `the IV slider and the overall vol input are one state` — slide to +3 → body `volShift: 3` and the overall vol input shows `3`.
  - `the Sensibull table follows the server's rows` — row labels in order; headers contain `24 Oct` and `27 Oct`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run test/traders-payoff-sliders.test.tsx` → FAIL.
- [ ] **Step 3: Implement** `PayoffSliders` and mount it.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run && git diff --quiet "$R2_BASE" HEAD -- src/payoff.tsx src/payoff-curves.tsx src/chart.tsx src/format.ts && echo desk-chart-untouched` → PASS and `desk-chart-untouched` (`R2_BASE`, N16).
- [ ] **Step 5: Commit** — `git commit -m "feat(web/traders): payoff chart with target-date and IV sliders, Sensibull P&L table"`

---

### Task 18: web — admin charges editor (14a)

**Files:**
- Create: `apps/web/src/traders/admin-charges.tsx`
- Modify: `apps/web/src/traders/admin.tsx` (R1's, N12) — append `{ id: 'charges', label: 'Charges', render: () => <AdminCharges /> }` to `ADMIN_SECTIONS`
- Test: `apps/web/test/traders-admin-charges.test.tsx`

**Interfaces:**
- Consumes: `tapi.chargeSettings`, `tapi.putChargeSettings` (Task 14), R1's `tapi.adminTraders()` for the trader picker; `ChargeRates`.
- Produces: `export function AdminCharges(): React.ReactElement`.
- Form: a table Option / Future / Share × `STT buy %`, `STT sell %`, `Exchange %`, `Stamp buy %`; `SEBI ₹ per crore`; `GST %`; default brokerage (mode `Per order | Per lot` + amount); per-trader brokerage rows (add from the trader list, remove). Save → PUT. While `confirmedBy === null` a Banner `Seed values — not confirmed. Check each against the current rates before saving.`; after a save `Confirmed by <name> on <DD Mon YYYY>`; a 400 shows the server's `error` text.

- [ ] **Step 1: Write the failing tests** — seed banner shown for `confirmedBy: null`; changing Option `STT sell %` to `0.0625` and Save sends `charges.option.sttSellPct === 0.0625`; a 400 `{ error: 'gstPct must be 0–50' }` shows that text; after a 200 with `confirmedBy: 'admin'` the banner is replaced by `Confirmed by admin on …`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run test/traders-admin-charges.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the component and the section.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run && npm run typecheck --workspace @algomaker/web` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web/traders): admin charges editor — seed rates flagged until confirmed"`

---

### Task 19: whole-branch verification and the operator hand-over

**Files:**
- Modify: `docs/runbooks/traders.md` — section "Release 2" (what to do after merge, below)

- [ ] **Step 1: Typecheck and every suite on the merged tree** — `npm run typecheck && DESK_REQUIRE_MONGO=1 npm test && python3 scripts/test_span_job.py` → all PASS; the golden SPAN test reports skipped until Q6.
- [ ] **Step 2: Builds** — `cd apps/web && npx vite build --config vite.traders.config.ts && npx vite build` → both succeed (traders page into `dist-traders/`, desk into `dist/`).
- [ ] **Step 3: The desk is untouched** — `git diff --stat "$R2_BASE" HEAD -- apps/web/src/payoff.tsx apps/web/src/payoff-curves.tsx apps/web/src/chart.tsx packages/payoff/src/legs.ts packages/payoff/src/surface.ts packages/payoff/src/view.ts packages/payoff/src/margin.ts packages/payoff/src/ivs.ts packages/desk-engine apps/api` prints nothing (`R2_BASE` = the `feat/traders` commit where Release 1 was merged, N16), and Task 1's commit is the only R2 commit under `apps/api`: `git show --stat <task-1 sha> -- apps/api` lists `apps/api/src/service.ts | 2 ++`.
- [ ] **Step 4: Walk coverage** — `grep -c "books.analysis\|books.scenario\|books.margin\|admin.settings" apps/traders/src/routes/endpoints.ts` prints 5 and the ownership suite in Step 1 ran a case for each; R1's import-rule and write-guard tests are in the Step 1 run.
- [ ] **Step 5: Runbook "Release 2" section and commit** — operator steps, in order: (1) restart `desk-traders` onto the new build (operator restart; the desk's processes are not involved); (2) create `.venv-nse` and run one download by hand (O2), tick V-J1–V-J4; (3) `npx pm2 start ecosystem.desk.config.cjs --only desk-traders-span` and check the next quarter-hour's log line; (4) admin opens Charges, checks every seed value against the current rates and each trader's brokerage (Q5), saves; (5) when Q6 arrives, Task 8 Step 6. `git commit -m "docs(runbook): traders Release 2 — span job, charges confirmation, restart"`.

---

## Spec coverage

| Spec | Task(s) |
|---|---|
| 8 leg table (v50 columns) and the strip below it · 9 include tick · 10 illiquid · 11 month tabs and month-wise | 2, 9, 11, 15 |
| 12 totals with volga/vanna, T and N | 1, 3, 11, 15 |
| 13 To Neutralize · 4a shares move it | 11, 15 (N7) |
| 14 MTM block (yesterday's close from NSE end-of-day files) · 14a charges, admin-editable | 5, 7, 10, 11, 15, 18 |
| 15 margin box (nothing until SPAN; peak line) · 28 SPAN + exposure, file named · P11 | 5, 6, 7, 8, 13, 15 |
| 16 Gap Up/Down panel, with 22 folded in · 17 call/put/future overrides | 4, 9, 11, 15 |
| 18 scenario inputs · 19 hypothetical legs · 20 grid (v50: Interval %, Strike +/-, trading days) · 23 units | 3, 4, 12, 14, 16 |
| 21 target-date and IV sliders + Sensibull table | 4, 12, 17 |
| P5 each leg on its own month · 3a index books (weekly expiries) · P12 yesterday's F&O file saved for R3 · P13 caps | 5, 7, 9, 11, 12 |
| Safety: ownership walk, import rule, one writer, no live ports | 10–13, 19 |
