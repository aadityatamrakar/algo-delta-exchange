# Desk Payoff Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-house payoff analyzer (expiry/T+0/mid-date curves, payoff table, machine-mind panel, what-if overlay) plus a goal-driven multi-move repairer for live desk books — TypeScript port of sensibull-desk's Black-76 math into algomaker, no Sensibull anywhere.

**Architecture:** A new pure package `@algomaker/payoff` holds all math (Black-76 via a new `black76` module in `@algomaker/greeks`, surface/expiry/margin/candidate/goal-search engines), proven by golden parity fixtures generated from the Python originals. `apps/api` gains `payoffRoutes` (`/v1/desk/payoff`, `/v1/desk/payoff/whatif`, `/v1/desk/repair`, `/v1/desk/repair/verify-margin`) that assemble book + chain + registry dials + declarations and persist snapshots to Mongo. `apps/web` gains a payoff panel on the per-book page (`#/positions/TAG`). One small cross-repo patch adds a per-leg `protected` flag to sensibull-desk's rules engine.

**Tech Stack:** TypeScript (Node 24 type-stripping, `node:test`), React 19 + recharts + `@astryxdesign/core` (vitest/jsdom for web), MongoDB, Python only for one-shot fixture generation and the sensibull-desk patch.

**Spec:** `docs/superpowers/specs/2026-08-19-desk-payoff-cockpit-design.md` (algomaker repo). Read it before any task.

## Global Constraints

- **No Sensibull or third-party analytics calls anywhere.** Quotes come only from algomaker's own chain/feed; the Kite basket-margin endpoint (already in `apps/marketdata`) is the one allowed broker call.
- **All option pricing is Black-76 off the traded future** (`F = future price`), never Black-Scholes-on-spot. Conventions fixed: theta per CALENDAR DAY, vega per 1 VOL POINT (1%), `opt_type` `'CE' | 'PE'`, risk-free `r = 0.065`.
- **Whole-book P&L**: `realised` (banked ₹) shifts every curve/table cell; the booked component is always labeled separately.
- **Leg qty convention (algomaker)**: `BridgeLeg.qty` is SIGNED share-contracts (negative = short). The payoff package uses the same convention (`PayoffLeg.qty` signed shares) — do NOT port the Python `lots`-positive-plus-`side` convention.
- **Fail-soft**: engine functions never throw on bad legs/quotes; they degrade to zeroed summaries with `warnings: string[]` naming what was dropped. API data routes return 200 with an `error`/`warnings` key, not 500 (repo convention).
- Backend tests: `node --test <file>` (Node 24 runs `.ts` directly). Web tests: `npm run -w apps/web test`. Typecheck: `make typecheck` (root; excludes apps/web which has its own project).
- Commits: small, per task, style `feat(payoff): …` / `feat(desk): …`; end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Python originals live in `/Users/aaditya/Documents/dev/algo-engine/sensibull-desk` (venv at `.venv/bin/python`). Port targets are named per task with `file:line`. Implementers MUST read the named Python source before porting — the plan gives signatures and semantics, the source gives the arithmetic.
- Parity tolerance helper (used by all parity tests): pass if `|a-b| <= abs` OR `|a-b| <= rel*max(|a|,|b|)`. Defaults per kind — option price/₹ cell: `abs 1.0, rel 1e-4`; greek: `abs 1e-5, rel 1e-4`; IV: `abs 1e-3`; breakeven price: `abs 0.5`. (The TS `normCdf` is A&S 7.1.26 with 1.5e-7 max error vs Python's exact `erf`; tolerances absorb that.)

## File Structure

```
packages/greeks/src/black76.ts              NEW  Black-76 price/greeks/impliedVol off F
packages/greeks/src/index.ts                MOD  re-export black76 names
packages/greeks/test/black76.test.ts        NEW
packages/payoff/package.json                NEW  @algomaker/payoff (deps: @algomaker/greeks)
packages/payoff/tsconfig.json               NEW  copy shape from packages/pnl
packages/payoff/src/legs.ts                 NEW  PayoffLeg, legPnl, legGreeks
packages/payoff/src/expiry.ts               NEW  expiryPnlAt, expiryBreakevens
packages/payoff/src/surface.ts              NEW  buildSurface (cells + summary + POP)
packages/payoff/src/margin.ts               NEW  spanLiteMargin (SPAN-lite estimator)
packages/payoff/src/ivs.ts                  NEW  solveChainIvs (quote → interp → fallback)
packages/payoff/src/view.ts                 NEW  buildPayoffView (curves + table + summary)
packages/payoff/src/machine.ts              NEW  reliefTriggers (machine-mind arithmetic)
packages/payoff/src/moves.ts                NEW  Move union, applyMoves
packages/payoff/src/candidates.ts           NEW  atomicMoves (delta-band generator)
packages/payoff/src/goals.ts                NEW  4 goal objectives + beam search + flags
packages/payoff/src/index.ts                NEW  public exports
packages/payoff/test/*.test.ts              NEW  one file per src module
packages/payoff/test/fixtures/parity/*.json NEW  committed golden fixtures
scripts/gen-parity-fixtures.py              NEW  one-shot generator (runs in sensibull-desk venv)
apps/api/src/routes/payoff.ts               NEW  payoffRoutes
apps/api/src/store.ts                       MOD  add 'desk-payoff-snapshots' to COLLECTIONS
apps/api/src/main.ts                        MOD  register payoffRoutes (routes array ~line 841-859)
apps/api/test/payoff-routes.test.ts         NEW
apps/marketdata/src/history.ts (or main.ts) MOD  POST /v1/md/margin-basket (hypothetical basket)
apps/marketdata/test/margin-basket.test.ts  NEW
bin/desk-payoff.mjs                         NEW  CLI
apps/web/src/api.ts                         MOD  payoff/repair wrappers
apps/web/src/payoff.tsx                     NEW  PayoffPanel (chart, table, machine, overlay, repair)
apps/web/src/pages.tsx                      MOD  mount <PayoffPanel/> in PositionsPage (~:414+)
apps/web/test/payoff.test.tsx               NEW
--- other repo: /Users/aaditya/Documents/dev/algo-engine/sensibull-desk ---
sensibull_tools/sim/rules/* + live/desk/driver.py  MOD  per-leg protected flag
tests/test_protected_legs.py                NEW
```

Dependency order: T1 → T2 → T3 → T4,T5,T6 (parallelizable) → T7 → T8 → T9 → T10 → T11,T12 → T13. T14 (sensibull-desk) is independent of T2-T13 and can run any time after T1 is understood.

---

### Task 1: Black-76 module in `@algomaker/greeks`

**Files:**
- Create: `packages/greeks/src/black76.ts`
- Modify: `packages/greeks/src/index.ts` (append `export * from './black76.ts'` — check existing import style first; the package may use explicit `.ts` extensions in imports, match it)
- Test: `packages/greeks/test/black76.test.ts` (look at existing test files in `packages/greeks/test/` and match their style)

**Port source:** `/Users/aaditya/Documents/dev/algo-engine/sensibull-desk/sensibull_tools/gfdl/greeks.py` (133 lines, read it whole). Port the pure-Python path only — no opengreeks backend.

**Interfaces (Produces):**
```ts
export interface B76Inputs {
  readonly future: number      // F
  readonly strike: number      // K
  readonly t: number           // years to expiry
  readonly vol: number         // annualised, decimal
  readonly rate: number        // decimal
  readonly type: OptionType    // 'CE' | 'PE' (reuse existing OptionType export)
}
export function b76Price(i: B76Inputs): number
export interface B76Greeks { readonly delta: number; readonly gamma: number; readonly theta: number; readonly vega: number }
export function b76Greeks(i: B76Inputs): B76Greeks
export function b76ImpliedVol(
  price: number,
  i: Omit<B76Inputs, 'vol'>,
  opts?: { loVol?: number; hiVol?: number; tolerance?: number; maxIter?: number },
): number | null
```

Semantics (mirror the Python exactly):
- `b76Price`: degenerate input (`t<=0 || vol<=0 || F<=0 || K<=0`) → discounted intrinsic `exp(-r*t) * max(±(F-K), 0)`. Else `d1 = (ln(F/K) + 0.5·σ²t)/(σ√t)`, `d2 = d1 − σ√t`, `df = e^{-rt}`; call `df(F·N(d1) − K·N(d2))`, put `df(K·N(−d2) − F·N(−d1))`. Use the package's existing `normCdf`/`normPdf`.
- `b76Greeks`: degenerate → all zeros (NOT step delta — that differs deliberately from the spot-BS `greeks()`; the Python returns zeros and the surface engine relies on it). `gamma = df·pdf(d1)/(F·σ√t)`; `vega = F·df·pdf(d1)·√t/100`; call theta `(−F·df·pdf·σ/(2√t) − rK·df·N(d2) + rF·df·N(d1))/365`, put theta per greeks.py:71-72. Do NOT round (Python rounds for display; parity tolerance covers it).
- `b76ImpliedVol`: defaults `loVol=1e-4, hiVol=5.0, tolerance=1e-6, maxIter=80`. Return `null` when `t<=0 || F<=0 || K<=0` or `price <= discountedIntrinsic + 1e-9`. Plain bisection over price; after the loop, accept the midpoint ONLY if it passes the `_solves` check ported from greeks.py:77-93 (strictly inside `(0, hi)`, not pinned within `hi·(1−1e-9)`, and reprices to within `max(tol, tol·|price|)`). This null-on-no-root behaviour is load-bearing — a 500% pinned IV silently poisoning vega was a real bug there.

- [ ] **Step 1: Write the failing test**

```ts
// packages/greeks/test/black76.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, b76Greeks, b76ImpliedVol } from '../src/black76.ts'

const atm = { future: 100, strike: 100, t: 1, vol: 0.2, rate: 0, type: 'CE' as const }

test('ATM call, r=0: classic value', () => {
  assert.ok(Math.abs(b76Price(atm) - 7.9656) < 1e-3)
})
test('put-call parity at F=K, r=0', () => {
  assert.ok(Math.abs(b76Price(atm) - b76Price({ ...atm, type: 'PE' })) < 1e-9)
})
test('greeks at the ATM point', () => {
  const g = b76Greeks(atm)
  assert.ok(Math.abs(g.delta - 0.539828) < 1e-4)
  assert.ok(Math.abs(g.gamma - 0.0198476) < 1e-5)
  assert.ok(Math.abs(g.vega - 0.396953) < 1e-4)   // per 1 vol point
  assert.ok(Math.abs(g.theta - -0.010876) < 1e-5) // per calendar day
})
test('expired option prices at intrinsic, zero greeks', () => {
  assert.equal(b76Price({ ...atm, t: 0, future: 110 }), 10)
  assert.deepEqual(b76Greeks({ ...atm, t: 0 }), { delta: 0, gamma: 0, theta: 0, vega: 0 })
})
test('impliedVol round-trips', () => {
  const px = b76Price(atm)
  const iv = b76ImpliedVol(px, { future: 100, strike: 100, t: 1, rate: 0, type: 'CE' })
  assert.ok(iv !== null && Math.abs(iv - 0.2) < 1e-4)
})
test('impliedVol: sub-intrinsic and above-ceiling quotes → null', () => {
  assert.equal(b76ImpliedVol(9.9, { future: 110, strike: 100, t: 0.1, rate: 0, type: 'CE' }), null)
  assert.equal(b76ImpliedVol(99.0, { future: 100, strike: 100, t: 0.05, rate: 0, type: 'CE' }), null)
})
```

- [ ] **Step 2: Run** `node --test packages/greeks/test/black76.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `black76.ts`** per the semantics above; re-export from `index.ts`. Match the file's existing doc-comment voice (see the header of `packages/greeks/src/index.ts` for tone).
- [ ] **Step 4: Run** the test again — expect PASS. Then `make typecheck` — expect clean.
- [ ] **Step 5: Commit** `feat(greeks): black-76 off the traded future — price, greeks, and an IV that refuses to lie`

---

### Task 2: Golden parity fixtures from the Python originals

**Files:**
- Create: `scripts/gen-parity-fixtures.py`
- Create (generated, then committed): `packages/payoff/test/fixtures/parity/black76.json`, `surface.json`, `expiry.json`, `margin.json`
- Test: `packages/greeks/test/black76-parity.test.ts`

**Interfaces (Produces):** fixture JSON shapes consumed by Tasks 2/4/5:
```jsonc
// black76.json: [{"in": {"opt_type":"CE","F":..,"K":..,"t":..,"r":..,"sig":..},
//                "price": .., "greeks": {"delta":..,"gamma":..,"theta":..,"vega":..},
//                "iv_roundtrip": ..|null}]
// expiry.json:  [{"name":"strangle","legs":[PyLeg...],"spot":..,"realized":..,
//                "pnl_at": {"<price>": ..}, "breakevens": {"down": ..|null, "up": ..|null}}]
// surface.json: [{"name":..,"legs":[PyLeg...],"spot":..,"dates":["YYYY-MM-DD",...],
//                "out": {net_credit,delta,gamma,theta,vega,max_profit,max_loss,breakevens,worst_shock,pop}}]
// margin.json:  [{"name":..,"legs":[PyLeg...],"spot":..,"date":"YYYY-MM-DD",
//                "out": {span,exposure,total,worst_scenario:{price_move_pct,vol_mult},short_notional,n_short_lots}}]
```
`PyLeg` is the Python dict shape (`instrument/side/lots/lot_size/strike/opt_type/expiry/entry/iv/id`) — fixtures keep it verbatim; the TS tests convert to `PayoffLeg` via the adapter defined in Task 3, which doubles as an adapter test.

The script (stdlib + sensibull_tools imports only) hardcodes deterministic cases:
- black76: full grid over `F ∈ {100, 750.5, 24800}`, moneyness `K/F ∈ {0.85, 0.95, 1.0, 1.05, 1.2}`, `t ∈ {0.002, 0.02, 0.08, 0.3}`, `sig ∈ {0.12, 0.25, 0.6}`, both types, `r = 0.065`; for each also `implied_vol(price, ...)` round-trip (may be null near-expiry deep-ITM — keep the null).
- books (used for expiry/surface/margin): (a) `strangle`: short 700CE + short 620PE, 2 lots, lot 1000, entries 8.4/6.1, iv 0.28/0.31, expiry 2026-08-25, spot 660; (b) `repaired`: same plus long 730CE 1 lot entry 2.1 iv 0.26 and short 600PE 1 lot entry 3.3 iv 0.33; (c) `with-future`: (a) plus a Buy future leg, 1 lot, entry 662, expiry 2026-08-25. Dates ladder `["2026-08-19","2026-08-22","2026-08-25"]`, margin date `"2026-08-19"`.
- Calls: `sim.book.expiry_pnl_at` / `expiry_breakevens(legs, spot, realized=125000.0)`; `sim.optimizer.surface.build_surface(legs, spot=…, dates=…)`; `sim.margin.portfolio_margin(legs, spot, date, per_leg=False)`.

- [ ] **Step 1: Write the generator script**, then run it:
```bash
cd /Users/aaditya/Documents/dev/algo-engine/sensibull-desk && .venv/bin/python \
  /Users/aaditya/Documents/dev/algomaker/scripts/gen-parity-fixtures.py \
  --out /Users/aaditya/Documents/dev/algomaker/packages/payoff/test/fixtures/parity
```
Expected: 4 JSON files written, each non-empty; spot-check one black76 entry by eye against Task 1's ATM numbers (an F=100,K=100,t≈?… closest grid point should look sane).
- [ ] **Step 2: Write the failing parity test** `packages/greeks/test/black76-parity.test.ts`: load `black76.json`, for every case assert `b76Price` within (abs 1.0, rel 1e-4), each greek within (abs 1e-5, rel 1e-4), and `b76ImpliedVol(price, …)` null-agreement + value within abs 1e-3 when non-null. Write the `close(a, b, {abs, rel})` helper here and export it from a small `packages/payoff/test/helpers.ts` for later tasks (fine for a test-only cross-import; if workspace resolution complains, duplicate the 6-line helper).
- [ ] **Step 3: Run** `node --test packages/greeks/test/black76-parity.test.ts` — expect PASS (Task 1 is done; if any case fails, the port has a real bug — fix the port, never the tolerance, unless the failing delta is genuinely the normCdf approximation, i.e. < 1e-4 relative).
- [ ] **Step 4: Commit** fixtures + script + test: `test(greeks): golden parity — the TS black-76 answers with the Python desk's own numbers`

---

### Task 3: `@algomaker/payoff` package — legs + expiry payoff

**Files:**
- Create: `packages/payoff/package.json` (name `@algomaker/payoff`; copy the shape of `packages/pnl/package.json`, depend on `@algomaker/greeks`), `packages/payoff/tsconfig.json` (copy from `packages/pnl`)
- Create: `packages/payoff/src/legs.ts`, `packages/payoff/src/expiry.ts`, `packages/payoff/src/index.ts`
- Test: `packages/payoff/test/legs.test.ts`, `packages/payoff/test/expiry.test.ts`

**Port sources:** `sensibull_tools/sim/optimizer/legs.py` (whole file) and `sensibull_tools/sim/book.py:56-160` (`expiry_pnl_at`, `expiry_breakevens`, `breakeven_clearance`).

**Interfaces (Produces):**
```ts
// legs.ts
export interface PayoffLeg {
  readonly id: string
  readonly instrument: 'option' | 'future'
  readonly qty: number                    // SIGNED shares; negative = short
  readonly strike: number | null          // null for futures
  readonly type: OptionType | null        // null for futures
  readonly expiry: string                 // 'YYYY-MM-DD'
  readonly entry: number                  // per-share entry price
  readonly iv: number | null              // per-leg vol; null = unpriceable
}
export function fromPyLeg(py: Record<string, unknown>): PayoffLeg   // lots·lot_size·(side=='Sell'?-1:1) → qty; used by parity tests AND by nothing else
export function legPnl(leg: PayoffLeg, F: number, t: number, rate?: number, ivOverride?: number): number
export function legGreeks(leg: PayoffLeg, F: number, t: number, rate?: number): B76Greeks  // already qty-scaled
// expiry.ts
export function expiryPnlAt(legs: readonly PayoffLeg[], price: number): number
export interface ExpiryBreakevens { readonly down: number | null; readonly up: number | null }
export function expiryBreakevens(legs: readonly PayoffLeg[], spot: number, realized?: number): ExpiryBreakevens
```
Semantics: `legPnl` option = `qty · (b76Price(F,K,t,iv) − entry)`; future = `qty · (F − entry)`; missing strike/type/iv → 0 (fail-soft). `expiryPnlAt` = exact intrinsic arithmetic (no model). `expiryBreakevens` = kinks-only evaluation at `sorted(strikes ∪ {0, spot, 3·max(maxStrike, spot)})` with linear interpolation; `realized` shifts every y; returns crossings NEAREST spot each side, null = unbounded safety that side (port book.py:85-137 faithfully, including the `y0 == 0` and final-point edge cases).

- [ ] **Step 1: Write failing tests.** `legs.test.ts`: hand cases — short CE (`qty:-1000, strike:700, entry:8.4, iv:0.28, expiry:'2026-08-25'`) at `F=700, t=0.02`: `legPnl` < 0 iff `b76Price > entry` (assert against a direct `b76Price` call, exact equality); future leg linearity; `ivOverride` reprices; bad leg (iv null) → 0 pnl, zero greeks; `legGreeks` of a short has negative delta·sign consistent with type. `expiry.test.ts`: parity — load `expiry.json`, convert legs via `fromPyLeg`, assert every `pnl_at` point (abs 1.0, rel 1e-4 — should be near-exact, it's pure arithmetic) and both breakevens (abs 0.5, null-agreement). Plus one hand case: short 100CE qty −100 entry 5 → breakeven up at 105.
- [ ] **Step 2: Run** `node --test packages/payoff/test/legs.test.ts packages/payoff/test/expiry.test.ts` — expect FAIL (package missing).
- [ ] **Step 3: Implement.** Create the package (add to root workspaces automatically via `packages/*`), implement `legs.ts`/`expiry.ts`/`index.ts`. `npm install` at root once so the workspace links.
- [ ] **Step 4: Run** tests — PASS. `make typecheck` — clean. Root `npm test` still green (proves the new package didn't break the glob).
- [ ] **Step 5: Commit** `feat(payoff): the leg speaks black-76 and the expiry curve is exact — kinks, not ladders`

---

### Task 4: Surface engine (price×date grid + summary + POP)

**Files:**
- Create: `packages/payoff/src/surface.ts`; modify `src/index.ts` (export)
- Test: `packages/payoff/test/surface.test.ts`

**Port sources:** `sensibull_tools/sim/optimizer/surface.py` (whole file — the summary), enriched with the cell grid idea from `sensibull_tools/basket/surface.py:112-200` (cells per date; do NOT port its spot-BS pricing or its POP — use optimizer/surface.py's POP), and `sensibull_tools/pricing.py:194-210` (`lognormal_prob_between`).

**Interfaces (Produces):**
```ts
export interface SurfaceInputs {
  readonly legs: readonly PayoffLeg[]
  readonly spot: number                  // the FUTURE price (F), per Black-76 convention
  readonly dates: readonly string[]      // ['today', ..., expiry] ISO; dates[0] = valuation day, last = expiry
  readonly rate?: number                 // default 0.065
  readonly band?: number                 // default 0.10
  readonly steps?: number                // default 10  (21 ladder points)
}
export interface Surface {
  readonly prices: readonly number[]                       // sorted ladder
  readonly cells: Readonly<Record<string, readonly number[]>>  // date → pnl aligned with prices
  readonly netCredit: number
  readonly greeks: B76Greeks                               // book greeks at nearest-spot ladder point, today
  readonly maxProfit: number; readonly maxLoss: number     // over the EXPIRY column
  readonly breakevens: readonly number[]                   // expiry-column zero crossings (ladder-interpolated)
  readonly worstShock: number                              // min P&L today at spot×{0.90,0.95,1.05,1.10}
  readonly pop: number
  readonly warnings: readonly string[]
}
export function buildSurface(i: SurfaceInputs): Surface
export function lognormalProbBetween(S: number, lo: number | null, hi: number | null, sigma: number, T: number): number
```
Semantics: ladder `spot·(1 + band·i/steps), i ∈ [−steps, steps]`; per-date `t` resolved once per leg (`yearsBetween(date, leg.expiry)` — add a tiny local `yearFrac(from, to) = max(0, days/365)` helper matching Python `year_frac`, calendar days / 365, NOT `yearsToExpiry`'s intraday clock — parity depends on it); expiry column drives maxProfit/maxLoss/breakevens; POP via zero-drift lognormal exactly as `_pop` (surface.py:101-130) with `atm_iv` = mean of option-leg IVs (default 0.20 when none); `netCredit` = Σ over option legs of `entry · (−qty)` (sell ⇒ +credit; note the sign falls out naturally from signed qty). All fail-soft.

- [ ] **Step 1: Write failing tests.** Parity: every case in `surface.json` → all 10 summary fields within tolerances (₹ fields abs 1.0/rel 1e-4; greeks abs 1e-4 — book-scaled; pop abs 1e-3; breakevens abs 0.5 element-wise, length equal). Hand tests: single short CE book — `maxProfit == credit` at the expiry column's low arm; `worstShock < 0`; realized-shift is NOT surface's job (assert surface ignores it — the view layer owns it); empty legs → zeroed surface with warning.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `make typecheck` clean.
- [ ] **Step 5: Commit** `feat(payoff): the surface — 21 prices, every date, one worst shock`

---

### Task 5: SPAN-lite margin estimator

**Files:**
- Create: `packages/payoff/src/margin.ts`; export from index.
- Test: `packages/payoff/test/margin.test.ts`

**Port source:** `sensibull_tools/sim/margin.py:35-200` (`_F_MULTS`, `_span_core`, `portfolio_margin` — skip `per_leg_naked`, `margin_benefit`, `wing_relief_candidates`).

**Interfaces (Produces):**
```ts
export interface SpanLiteOptions {
  readonly defaultIv?: number     // 0.35
  readonly priceScanPct?: number  // 0.21
  readonly volScan?: number       // 0.25
  readonly exposurePct?: number   // 0.05
  readonly minShortPct?: number   // 0.05
  readonly rate?: number          // 0.065
}
export interface SpanLiteMargin {
  readonly span: number; readonly exposure: number; readonly total: number
  readonly worstScenario: { readonly priceMovePct: number; readonly volMult: number }
  readonly shortNotional: number
}
export function spanLiteMargin(legs: readonly PayoffLeg[], spot: number, date: string, opts?: SpanLiteOptions): SpanLiteMargin
```
Semantics: 7 price fractions `(0, ±1/3, ±2/3, ±1)·priceScanPct` × 3 vol mults `{1−volScan, 1, 1+volScan}`; per-scenario Σ(legPnl(scenF, ivOverride=iv·vm) − legPnl(spot, ivOverride=iv)); `span = max(0, −worstChange)` floored at `minShortPct·shortNotional`; `exposure = exposurePct·(shortNotional + |futuresNotional|)`; short leg = option with qty<0; futures notional uses |qty|; a book with no short/future exposure → all zeros; `t` floored at `_MIN_T = 1/365/24`. (Drop `n_short_lots` — algomaker has no lots at this layer.)

- [ ] **Step 1: Failing tests.** Parity: `margin.json` cases (span/exposure/total abs 5.0 rel 1e-4 — note fixture has `n_short_lots`, ignore it; worst_scenario fields exact-ish abs 0.01). Hand: long-only book → zeros; adding a long wing to a short strangle strictly reduces `total` (the hedge-benefit property).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(payoff): span-lite — 21 scenarios, hedge benefit for free`

---

### Task 6: Chain IV solving + the payoff view

**Files:**
- Create: `packages/payoff/src/ivs.ts`, `packages/payoff/src/view.ts`; export from index.
- Test: `packages/payoff/test/ivs.test.ts`, `packages/payoff/test/view.test.ts`

**Interfaces (Produces):**
```ts
// ivs.ts — sticky-strike IVs from the live chain (design Q11)
export interface ChainQuoteLite { readonly strike: number; readonly type: OptionType; readonly price: number; readonly ageMs: number }
export interface SolvedIv { readonly strike: number; readonly type: OptionType; readonly iv: number | null; readonly source: 'quote' | 'interp' | 'none' }
export function solveChainIvs(
  quotes: readonly ChainQuoteLite[],   // one entry per (strike,type) with a live quote
  future: number, expiryYears: number, rate?: number,
  opts?: { maxAgeMs?: number },        // default 120_000 — older quotes are junk
): readonly SolvedIv[]
export function ivFor(solved: readonly SolvedIv[], strike: number, type: OptionType): number | null
```
`solveChainIvs`: per quote fresh enough, `b76ImpliedVol`; strikes whose quote is stale/absent/unsolvable get `source:'interp'` — linear interpolation in strike over same-type solved neighbours (nearest below + above; one-sided → nearest single value; none at all → `iv: null, source:'none'`).

```ts
// view.ts — the analyzer's whole answer, pure
export interface PayoffViewInputs {
  readonly legs: readonly PayoffLeg[]         // ivs already stamped (from solveChainIvs via ivFor)
  readonly future: number                      // F now
  readonly expiry: string                      // book expiry ISO
  readonly today: string                       // ISO valuation date
  readonly realised: number                    // banked ₹ (0 when unknown — caller warns)
  readonly targetPnl: number | null
  readonly rate?: number
}
export interface PayoffPoint { readonly price: number; readonly expiry: number; readonly t0: number; readonly mid: number }
export interface PayoffRow extends PayoffPoint { readonly label: string }   // 'strike 700' | 'BE 683.2' | 'spot' | '+2%' | '-5%' …
export interface PayoffView {
  readonly curve: readonly PayoffPoint[]       // dense: 121 points, ±10% (step band/60) — all values INCLUDE realised
  readonly table: readonly PayoffRow[]         // strikes ∪ breakevens ∪ spot ∪ ±{1,2,3,5,8}% — sorted by price, deduped (0.01)
  readonly midDate: string                     // ISO halfway today→expiry (calendar)
  readonly summary: {
    readonly maxProfit: number; readonly maxLoss: number; readonly maxLossAt: number
    readonly breakevens: ExpiryBreakevens      // realised-shifted, exact (kinks method)
    readonly pop: number; readonly netCredit: number; readonly worstShock: number
    readonly floor: number                     // min over the dense expiry curve (== maxLoss, realised included)
    readonly booked: number                    // echo of realised, labeled
    readonly targetPnl: number | null
  }
  readonly greeks: B76Greeks
  readonly warnings: readonly string[]
}
export function buildPayoffView(i: PayoffViewInputs): PayoffView
```
Semantics: expiry values come from `expiryPnlAt` (exact) + realised; `t0`/`mid` from `legPnl` at `yearFrac(today→expiry)` / `yearFrac(mid→expiry)` + realised; summary maxProfit/maxLoss/maxLossAt/floor over the dense expiry curve; `breakevens` from `expiryBreakevens(legs, future, realised)`; pop/netCredit/worstShock/greeks from `buildSurface({legs, spot: future, dates:[today, midDate, expiry]})` with worstShock realised-shifted too (worstShock + realised — the question it answers is book-level).

- [ ] **Step 1: Failing tests.** `ivs.test.ts`: three strikes with quotes → all `source:'quote'`; middle strike stale → interp = average of neighbours' IVs (equidistant); lone unsolvable side → 'none'. `view.test.ts`: short-strangle book with realised 50_000 → every curve point == (hand `expiryPnlAt` + 50_000) at expiry; table contains a row labeled `spot` and rows for every strike; breakevens realised-shifted (compare against `expiryBreakevens` called directly); `floor == summary.maxLoss`; target echoed.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; typecheck.
- [ ] **Step 5: Commit** `feat(payoff): the view — three curves, one table, realised shifts everything`

---

### Task 7: Machine-mind arithmetic + moves

**Files:**
- Create: `packages/payoff/src/machine.ts`, `packages/payoff/src/moves.ts`; export from index.
- Test: `packages/payoff/test/machine.test.ts`, `packages/payoff/test/moves.test.ts`

**Read first (semantics source, do not port wholesale):** `sensibull-desk/sensibull_tools/sim/rules/playbooks.py` — `DEFAULTS["recenter-relief"]` (~:472) and the `recenter_shift` playbook function it maps to (registry ~:5394): extract the EXACT conditions under which (a) the delta-balancing rule fires (`delta_tol_pct` — find what quantity it is a tolerance OF: shorts-only delta imbalance, per side) and (b) strike-shifting is enabled (`margin > shift_margin_frac × margin_cap`). Write what you find as doc comments with playbooks.py line refs — the panel must state the bot's real rules, not a guess.

**Interfaces (Produces):**
```ts
// machine.ts
export interface ReliefState {
  readonly steering: { readonly delta: number; readonly gamma: number } | null   // from desk-declarations
  readonly dials: Readonly<Record<string, number | boolean>>                     // registry dials over variant defaults
  readonly marginUsed: number | null       // desk-book-margin brokerTotal
}
export interface ReliefTriggers {
  readonly deltaTolPct: number | null
  readonly deltaImbalance: number | null        // the quantity the bot compares (per extracted semantics)
  readonly wouldRebalance: boolean | null       // |imbalance| > tol
  readonly shiftEnabled: boolean | null          // margin > shift_margin_frac × margin_cap (null when margin unknown)
  readonly marginFrac: number | null             // marginUsed / margin_cap
  readonly targetPnl: number | null
  readonly notes: readonly string[]              // human sentences: "shift disabled: margin 41% of cap, needs >60%"
}
export function reliefTriggers(s: ReliefState): ReliefTriggers
// moves.ts
export type Move =
  | { readonly op: 'add';   readonly strike: number; readonly type: OptionType; readonly qty: number }  // qty<0 (sell)
  | { readonly op: 'hedge'; readonly strike: number; readonly type: OptionType; readonly qty: number }  // qty>0 (buy)
  | { readonly op: 'shift'; readonly legId: string; readonly toStrike: number }
  | { readonly op: 'close'; readonly legId: string }
export interface AppliedBook { readonly legs: readonly PayoffLeg[]; readonly creditDelta: number; readonly realisedDelta: number; readonly warnings: readonly string[] }
export function applyMoves(
  legs: readonly PayoffLeg[], moves: readonly Move[],
  priceOf: (strike: number, type: OptionType) => number | null,   // LTP for new entries
  ivOf: (strike: number, type: OptionType) => number | null,
): AppliedBook
```
`applyMoves`: add/hedge create a leg (`entry = priceOf(...)`, `iv = ivOf(...)`, book expiry, id `add:700CE` etc.); close removes the leg and books `realisedDelta += qty · (mark − entry)` where mark = priceOf at the leg's strike/type (fail-soft: unknown price → move dropped with warning, never a fabricated fill); shift = close + add at `toStrike` with the SAME qty; `creditDelta` = premium received − paid across the moves (new sells positive, buys negative, closes of shorts negative by buyback cost).

- [ ] **Step 1: Failing tests.** `machine.test.ts`: dials `{delta_tol_pct: 0.02, shift_margin_frac: 0.6, margin_cap: 10_000_000, target_pnl: 250_000}` + margin 4.1M → `shiftEnabled false`, `marginFrac 0.41`, a note naming 60%; margin null → nulls, no crash; assert `wouldRebalance` against the semantics you extracted (write the test AFTER reading playbooks.py, with a comment citing the line). `moves.test.ts`: shift preserves qty and books the close's realised; close of a short bought back below entry books positive realised; unknown price → warning + move dropped; creditDelta signs.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(payoff): the machine's mind on a card, and moves that book their own closes`

---

### Task 8: Candidate generator + goal-driven beam search

**Files:**
- Create: `packages/payoff/src/candidates.ts`, `packages/payoff/src/goals.ts`; export from index.
- Test: `packages/payoff/test/candidates.test.ts`, `packages/payoff/test/goals.test.ts`

**Grammar reference (read for family ideas, port the *spirit*):** `sensibull-desk/sensibull_tools/basket/candidates.py:126-300` and `sim/optimizer/generate.py:114+`. The goal-driven ≤4-move search is NEW — design per spec Q8'/Q9/Q13/Q14.

**Interfaces (Produces):**
```ts
// candidates.ts
export interface RepairDials {
  readonly addDeltaMin: number      // 0.15
  readonly addDeltaMax: number      // 0.35
  readonly shiftDeltaMin: number    // 0.20
  readonly shiftDeltaMax: number    // 0.30
  readonly hedgeDeltaMax: number    // 0.10
  readonly hedgeBudgetFrac: number  // 0.20 of open credit
  readonly minCreditPerShare: number // 1.0 ₹
  readonly maxMarginAdd: number | null // ₹; null = uncapped
  readonly lotSize: number
  readonly maxQuoteAgeMs: number    // 120_000
}
export const DEFAULT_REPAIR_DIALS: Omit<RepairDials, 'lotSize'>
export interface StrikeInfo { readonly strike: number; readonly type: OptionType; readonly price: number | null; readonly ageMs: number | null; readonly iv: number | null; readonly delta: number | null }
export function atomicMoves(legs: readonly PayoffLeg[], strikes: readonly StrikeInfo[], dials: RepairDials): readonly Move[]
// goals.ts
export type Goal = 'REDUCE-LOSS' | 'PROFITABLE-BY-EXPIRY' | 'CHEAP-TAIL-CAP' | 'MAX-CREDIT-SAFE'
export interface PlanScore {
  readonly credit: number; readonly maxLoss: number; readonly maxLossAt: number
  readonly breakevens: readonly number[]; readonly worstShock: number
  readonly marginBefore: number; readonly marginAfter: number; readonly marginDelta: number
  readonly profitableWidthPct: number    // % of the ±10% ladder with expiry P&L ≥ 0 (realised included)
  readonly pop: number
}
export interface RepairPlan { readonly goal: Goal; readonly moves: readonly Move[]; readonly score: PlanScore; readonly flags: readonly string[] }
export interface RepairContext {
  readonly legs: readonly PayoffLeg[]; readonly future: number; readonly today: string; readonly expiry: string
  readonly realised: number; readonly dials: RepairDials
  readonly priceOf: (strike: number, type: OptionType) => number | null
  readonly ivOf: (strike: number, type: OptionType) => number | null
  readonly strikes: readonly StrikeInfo[]
  readonly triggers: ReliefTriggers | null   // for conflict flags
  readonly tailCapRupees?: number            // CHEAP-TAIL-CAP target; default 0.5·|current floor|
}
export function searchRepairs(ctx: RepairContext, opts?: { maxMoves?: number; topN?: number; beamWidth?: number }): readonly RepairPlan[]
```
`atomicMoves`: per delta band, per type/side (delta from `StrikeInfo.delta`, computed upstream from solved IVs — |delta| bands): adds = Sell 1 lot at each in-band strike with fresh quote and `price ≥ minCreditPerShare`; shifts = for each SHORT leg, to each in-band same-type strike further OTM; hedges = Buy 1 lot at each |delta| ≤ max strike, both types; closes = every leg. Deterministic ordering (by op, then strike).

`searchRepairs` (per goal, beam search): state = move list (≤ maxMoves, default 4); extensions must not touch a legId already moved and not duplicate an (op,strike,type); score each candidate book via `applyMoves` → `buildSurface` (+ realised where P&L-denominated) + `spanLiteMargin` before/after; objectives — REDUCE-LOSS: maximize floor (`maxLoss`); PROFITABLE-BY-EXPIRY: maximize `profitableWidthPct`, tiebreak pop; CHEAP-TAIL-CAP: feasible iff `maxLoss ≥ −tailCapRupees`, minimize `−credit` (cheapest debit / most credit among feasible); MAX-CREDIT-SAFE: maximize `credit` s.t. `maxLoss ≥ current floor`. Hard constraints all goals: `marginDelta ≤ maxMarginAdd` (when set), hedge spend ≤ `hedgeBudgetFrac ·` current open credit. Beam width default 8; keep top `topN` (3) DISTINCT plans (differing move sets) per goal; always include the do-nothing baseline as a reference plan (empty moves, flagged `baseline`). Conflict flags from `triggers`: a shift whose target strike delta sits inside `[shiftDeltaMin, shiftDeltaMax]` while `shiftEnabled` — flag `"bot-may-reshift"`; any plan while `wouldRebalance` — flag `"bot-rebalance-pending"`.

- [ ] **Step 1: Failing tests.** `candidates.test.ts`: synthetic chain (strikes 500…900 step 20 around F=700, deltas from real solved IVs at 0.3 vol) + a 2-short book → adds only within 0.15–0.35 |delta|; hedges only ≤ 0.10; stale-quote strike excluded; every close present; deterministic (two calls, deep-equal). `goals.test.ts`: for a losing short-strangle book (F moved onto the call side) — REDUCE-LOSS's top plan has floor strictly better than baseline; CHEAP-TAIL-CAP plans all satisfy the cap and are sorted cheapest-first; MAX-CREDIT-SAFE never degrades the floor; every plan ≤ 4 moves; topN distinct; hedge-budget respected (construct a case where the only cap-satisfying hedge exceeds budget → goal returns baseline + warning flag `"no-feasible-plan"`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (keep the scorer memoized on the move-set key — the beam re-visits). **Step 4: Run** — PASS; whole-package `node --test 'packages/payoff/test/**/*.test.ts'` green.
- [ ] **Step 5: Commit** `feat(payoff): four goals, four moves, top three — the repairer searches, the human decides`

---

### Task 9: API routes + snapshots

**Files:**
- Create: `apps/api/src/routes/payoff.ts`
- Modify: `apps/api/src/store.ts` (COLLECTIONS const, ~:91-137: add `'desk-payoff-snapshots'`), `apps/api/src/main.ts` (routes array ~:841-859: add `payoffRoutes(routeDeps)`), `apps/api/package.json` (dep `@algomaker/payoff`)
- Test: `apps/api/test/payoff-routes.test.ts` (copy the harness style of an existing routes test in `apps/api/test/` — find one that fakes `ApiDeps`)

**Interfaces:**
- Consumes: everything `@algomaker/payoff` exports (Tasks 3-8); `deps.service.positions(tag, mode, {realised: true})` (legs, greeks, spot, steering, realised — see `service.ts:1304`); `buildChain` deps (`deps` already carries master + marks — verify how `routes/desk.ts` serves `/v1/desk/chain/`, reuse the same path); Mongo `desk-books-registry` (dials), `desk-variants` (defaults), `desk-book-margin` (`_id = tag`, `brokerTotal`), `desk-declarations` (steering fallback).
- Produces (wire contract — the web and CLI build against these exact shapes):
```
GET /v1/desk/payoff?tag=&mode=            → PayoffResponse
POST /v1/desk/payoff/whatif  {tag, mode, proposed: [{strike, type, qty, price?}]}
                                          → { current: PayoffView['summary'], combined: PayoffResponse }
GET /v1/desk/repair?tag=&mode=[&tailCap=] → RepairResponse
```
```ts
interface PayoffResponse {
  tag: string; mode: 'paper' | 'live'; symbol: string; expiry: string
  future: number | null; spot: number | null; asOf: number
  view: PayoffView | null                  // null + warnings when future/quotes unavailable
  machine: ReliefTriggers | null
  ivs: readonly SolvedIv[]
  warnings: readonly string[]
}
interface RepairResponse {
  tag: string; mode: 'paper' | 'live'; asOf: number
  dials: RepairDials
  goals: readonly { goal: Goal; plans: readonly RepairPlan[] }[]
  universe: { atomic: number; evaluated: number }
  warnings: readonly string[]
}
```
Assembly: positions → `PayoffLeg[]` (`qty` already signed shares; `entry = entryPrice`; `expiry` from book; iv stamped via `solveChainIvs` over the book-expiry chain with `future` from `ChainResponse.future`); `realised` null → treat 0 + warning `"realised unknown"`; `targetPnl` from registry dials; dials for `reliefTriggers` = variant defaults overlaid by row dials (same merge the Books page does). Each successful GET also fire-and-forgets an insert into `desk-payoff-snapshots`: `{ tag, mode, ts, kind: 'payoff' | 'repair', payload }` (create index `{tag: 1, ts: -1}` at store init, matching how other indexes are declared in store.ts). Repair route builds `RepairContext` (priceOf/ivOf close over chain + solved IVs; `StrikeInfo.delta` from `b76Greeks` at each solved strike).

- [ ] **Step 1: Failing test.** Fake deps (in-memory stubs): a 2-leg short book, a chain with fresh quotes, registry row with dials → GET payoff returns `view` with non-empty curve, `machine.marginFrac` computed, and a snapshot doc lands in the fake collection; GET repair returns 4 goals with ≥1 plan each and `universe.atomic > 0`; whatif with one proposed hedge returns `combined.view.summary.maxLoss ≥ current.maxLoss` for that book. Missing future → `view: null`, warning present, HTTP 200.
- [ ] **Step 2: Run** `node --test apps/api/test/payoff-routes.test.ts` — FAIL. **Step 3: Implement** (`payoffRoutes(deps): Route` following `routes/pnl.ts`'s handler shape). **Step 4: Run** — PASS; `make typecheck`; root `npm test` green.
- [ ] **Step 5: Commit** `feat(desk): /v1/desk/payoff and /v1/desk/repair — the book's shape, served and snapshotted`

---

### Task 10: Hypothetical basket-margin verify

**Files:**
- Modify: `apps/marketdata/src/history.ts` or `src/main.ts` — add `POST /v1/md/margin-basket` to the existing :8792 HTTP server (same bearer `DESK_API_TOKEN` auth as `/v1/md/history`; find where `HISTORY_PATH` requests are routed, ~history.ts:208, and add a sibling route)
- Modify: `apps/api/src/routes/payoff.ts` — add `POST /v1/desk/repair/verify-margin`
- Test: `apps/marketdata/test/margin-basket.test.ts`, extend `apps/api/test/payoff-routes.test.ts`

**Interfaces:**
- Consumes: `apps/marketdata/src/book-margin/basket.ts` `basketOrders(legs: BridgeLeg[])` and the Kite call in `book-margin/kite.ts` (`BASKET_URL`, :38) — read `book-margin/refresh.ts` to see how the two are already composed and reuse that path for an ad-hoc leg list.
- Produces:
```
POST /v1/md/margin-basket   {legs: [{underlying, expiry, strike, type, qty}]}  → {total, span, exposure} | {error}
POST /v1/desk/repair/verify-margin  {tag, mode, moves: Move[]}                 → {estimated: number, broker: {total, span, exposure} | null, warnings: string[]}
```
The api route applies `moves` to the stored book (via `applyMoves`), diffs the leg lists into the NEW/CHANGED contract set, resolves contracts via the chain's `ceContract`/`peContract` refs, and proxies the full combined book to marketdata (env `DESK_MD_URL`, default `http://127.0.0.1:8792` — check how other cross-app URLs are configured in `ecosystem.desk.config.cjs` and follow that pattern). Kite failure → `broker: null` + warning; the SPAN-lite `estimated` always present.

- [ ] **Step 1: Failing tests** (marketdata: fake Kite fn injected, assert basket built from legs and response mapped; api: fake fetch to marketdata, assert combined book posted and estimate present when broker fails).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(desk): the plan you are about to place gets the broker's real margin number`

---

### Task 11: CLI

**Files:**
- Create: `bin/desk-payoff.mjs` (plain Node, no build; look at an existing `bin/*.mjs` for arg/env conventions)

**Interfaces:** Consumes the Task 9/10 wire contracts. Usage:
```
node bin/desk-payoff.mjs <TAG> [--mode live|paper] [--repair] [--json]
  env: DESK_API_URL (default http://127.0.0.1:8790), DESK_API_TOKEN
```
Default output: summary block (floor, max profit/loss @, breakevens, POP, net credit, booked, target), the payoff table as aligned columns (price | label | expiry | T+0 | mid), machine-mind notes. `--repair`: the 4 goal sections, 3 plans each, one line per move + score columns. `--json`: raw response. Auth: `Authorization: Bearer $DESK_API_TOKEN` — verify how the Python bridge authenticates against desk-api (`sensibull-desk live/desk/bridge.py` sends the token; find the matching gate in apps/api `auth`/`kit` and use the same header).

- [ ] **Step 1:** Write the CLI. **Step 2: Smoke-test** against a fake: `node --test` is overkill here — instead run it with `DESK_API_URL` pointed at a tiny throwaway `node:http` stub started inline in a test file `apps/api/test/cli-smoke.test.ts` that serves a canned PayoffResponse and asserts the process exits 0 and prints the floor line (use `node:child_process.execFile`).
- [ ] **Step 3: Run** the smoke test — PASS. **Step 4: Commit** `feat(desk): desk-payoff at the terminal — the whole shape in one screen`

---

### Task 12: Web — payoff panel (chart, table, machine-mind)

**Files:**
- Create: `apps/web/src/payoff.tsx`
- Modify: `apps/web/src/api.ts` (wrappers `api.payoff(tag, mode)`, `api.payoffWhatif(body)`, `api.repair(tag, mode)`, `api.repairVerifyMargin(body)` — follow the existing wrapper idiom at api.ts:1573+ and reuse `get`/`post`), `apps/web/src/pages.tsx` (mount in `PositionsPage`, ~:414+, below the existing tile grid)
- Test: `apps/web/test/payoff.test.tsx`

**MANDATORY reading before writing any JSX:** `apps/web/AGENTS.md` (design-system rules — component-only, no raw divs), `apps/web/src/chart.tsx` (the recharts idiom: `ResponsiveContainer`, theme tokens via `useTheme().token('--color-data-…')`, `connectNulls` off), `apps/web/src/pages.tsx` `Stat`/`StatCell`/`LevelStat` (:89/:169/:217), `usePoll` (shell.tsx:459), formatters in api.ts:2276+.

**Produces:** `export function PayoffPanel({ tag, mode }: { tag: string; mode: 'paper' | 'live' }): JSX.Element` — polls `api.payoff` at 60s via `usePoll`; renders:
1. **Chart**: `LineChart` — X = price, three lines (expiry solid, T+0 dashed, mid dashed-lighter) from `view.curve`; `ReferenceLine y=0`, `y=targetPnl` (when set), `x=spot`; ₹-compact tick formatter.
2. **Summary stats row**: floor, max profit @, max loss @, breakevens, POP, net credit, booked, worst shock — via `Stat`/`StatCell`.
3. **Table**: `view.table` rows (price, label, expiry, T+0, mid) — negative cells in the data-negative color; scrolls in its own container.
4. **Machine-mind card**: `machine` notes + marginFrac + shiftEnabled + wouldRebalance, each a labeled stat; render "unknown" states honestly (nulls → em-dash, never 0).
5. Stale/error handling exactly like sibling panels (usePoll keeps last payload; show `updatedAt`).

- [ ] **Step 1: Failing test** (vitest/jsdom, testing-library): mock `api.payoff` → canned PayoffResponse fixture; render `<PayoffPanel tag="X" mode="paper"/>`; assert floor value appears, a row labeled `spot` appears, machine note text appears; mock a null-view response → assert the warning renders and no chart crashes.
- [ ] **Step 2: Run** `npm run -w apps/web test -- payoff` — FAIL. **Step 3: Implement** panel + api wrappers + mount in PositionsPage. **Step 4: Run** web tests + `npm run -w apps/web build` (the repo builds web on the box — a broken build is a broken task). **Step 5: Commit** `feat(desk): the book page grows its payoff — three curves, the floor, and the bot's mind`

---

### Task 13: Web — what-if overlay + repair plans

**Files:**
- Modify: `apps/web/src/payoff.tsx` (extend), `apps/web/test/payoff.test.tsx` (extend)

**Produces (inside PayoffPanel):**
1. **What-if overlay**: a small leg editor (strike select from `ivs` strikes, CE/PE, Buy/Sell, lots — qty = lots × lotSize from the payoff response's chain meta; price prefilled from chain, editable) → `api.payoffWhatif` → chart adds a fourth line (combined expiry, distinct color) + a before/after floor/maxLoss stat pair. Clear button resets.
2. **Repair section**: on-demand button ("Suggest repairs") → `api.repair` → four goal groups, each ≤3 plan cards: move list (one human line per move: "Sell 1 lot 720CE @ 6.10"), score columns (credit, floor, worst shock, margin Δ), flags as badges. Per-plan actions: **Load into overlay** (fills the what-if editor with the plan's moves → same preview path) and **Verify margin** (→ `api.repairVerifyMargin`, shows broker total next to the estimate, or the warning).
3. Placement stays manual: a "Place manually" hint links to the existing Manual Order dialog flow — do NOT wire any order submission from this panel.

- [ ] **Step 1: Failing tests**: mock `api.repair` → 4 goals render, plan card shows moves and flags; clicking Load fills the overlay state (assert the whatif call body contains the plan's legs); whatif response draws the combined stat pair; verify-margin renders broker total and the estimate side by side.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** web tests + build — PASS. **Step 5: Commit** `feat(desk): repairs you can try on — load a plan, see the shape, verify the margin, place by hand`

---

### Task 14: sensibull-desk — the `protected` leg flag (cross-repo)

**Repo:** `/Users/aaditya/Documents/dev/algo-engine/sensibull-desk` (work there; its own git history and test runner — check how existing tests in `tests/` are invoked, `pytest` style expected).

**Files (verify exact sites by reading, the explorer mapped them):**
- Modify: `sensibull_tools/live/desk/driver.py` — the manual/bridge-leg ADOPTION fold (state key `adopted`, `manual_pending`; find where an adopted fill becomes a book leg via `translate._leg_from_open_fill`, ~translate.py:147): stamp `protected: True` on legs the desk did not open itself.
- Modify: the rules layer that PICKS legs to shift/close/resize — the threat/selection helpers used by the `recenter-shift` playbook (`sim/rules/playbooks.py` `recenter_shift` and any `max(shorts, key=…)` selection paths it calls into `sim/rules/engine.py`): a leg with `leg.get('protected')` is excluded from shift/roll/close/resize CANDIDATE selection.
- Unchanged on purpose: marking, greeks, declared greeks (protected legs still count in every net figure), and the target-lock flatten in `engine.py:452` `_guard` (target hit closes EVERYTHING, protected included — banking the run outranks protecting a hedge).
- Test: `tests/test_protected_legs.py`

- [ ] **Step 1: Failing tests** (mirror the style of `tests/test_desk_declared_greeks.py`): (a) a book whose most-threatened short is `protected` → the shift playbook picks the next-most-threatened unprotected short (or holds if none), never the protected one; (b) protected legs appear in `mark_book` net greeks unchanged; (c) target-lock flatten still closes protected legs; (d) a leg adopted through the driver's manual-adoption fold carries `protected: True` and survives a state save/load round-trip.
- [ ] **Step 2: Run** the repo's test command on the new file — FAIL. **Step 3: Implement** — smallest possible diff; every touched selection site gets a one-line comment naming the flag's contract ("counted in greeks, exempt from routine shift/close"). **Step 4: Run** the new tests AND the repo's full suite (whatever `pyproject`/CI runs) — PASS, no regressions. **Step 5: Commit** in sensibull-desk: `feat(desk): protected legs — the human's hedge counts in the greeks and is not the bot's to sell`

---

## Self-Review (done at write time)

- **Spec coverage:** curves/table/markers → T4/T6; sticky-strike IVs → T6; overlay → T13; machine-mind → T7/T9/T12; 4 goals/≤4 moves/top 3/dials → T8; margin estimate+verify → T5/T10; suggest-only + conflict flags → T8/T13; adoption+protected → T14; TS port + black76 + parity → T1-T5; routes+snapshots → T9; CLI-first → T11; panel on positions page → T12; Mongo snapshots → T9. IV-shift columns, alerting, bot simulation, mixed expiry, history UI: deferred by spec — no tasks, correct.
- **Placeholder scan:** the two "extract semantics by reading playbooks.py" steps (T7, T14) are deliberate read-the-source steps with concrete output contracts and cited line anchors, not TBDs.
- **Type consistency:** `PayoffLeg`/`Move`/`PayoffView`/`ReliefTriggers`/`RepairPlan`/`SolvedIv` names checked across T3-T13 usage sites; wire shapes in T9 are the ones T11-T13 consume.
