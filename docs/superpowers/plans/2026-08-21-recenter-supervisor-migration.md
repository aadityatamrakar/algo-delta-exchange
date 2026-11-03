# Recenter Supervisor Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python desk-supervisor with a native TypeScript recenter engine + supervisor process in this repo, per the 15 approved decisions in the spec.

**Architecture:** A pure decision engine (`packages/desk-engine`) verified against Python-generated fixtures; a new `apps/supervisor` process that evaluates it tick-driven off the WS bus and submits typed decisions to desk-api; the order-gateway extended with a quote-aware peg chaser and fill-gated tranches; the Books-page dials modal rebuilt as sections/toggles/presets. Single ledger: `desk-books`, folded by desk-api.

**Tech Stack:** Node 24 type-stripped TS (no build step), npm workspaces, node:test, Mongo (standalone — poll or HTTP, no change streams), pm2, `@algomaker/{greeks,bus,core}`.

**Spec:** `docs/superpowers/specs/2026-08-21-recenter-supervisor-migration-design.md` — read it before starting any task; decisions D1–D15 are binding.

## Global Constraints

- Every intra-repo import carries an explicit `.ts` extension; packages export `"./src/index.ts"`; NO emit, NO build step for backend code.
- tsconfig strictness applies: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (write `...(x === undefined ? {} : { x })`, never `{ x }` for optionals), `verbatimModuleSyntax` (use `import type`).
- Tests: `node --test test/*.test.ts` per workspace; a `.test.ts` under `apps/web/test` runs under node too. Mongo-touching tests follow the `apps/api/test/require-mongo.ts` pattern.
- Every new file starts with a doc-comment header stating what failure it exists to prevent, with dates and `file:line` citations (house style — see any file in `apps/api/src`).
- Every `setInterval`/`setTimeout` held past a function scope is `.unref()`ed.
- Collection-name constants are imported from their owning module, never restated.
- The supervisor holds NO broker credentials and never writes any order collection.
- Commit subjects are a sentence about the *effect*, ending with the standard co-author line.
- Numbers ported from Python keep their exact values (`shift_margin_frac` 0.60, `r` 0.065, scrap 0.10, crash 0.60, target streak 3). Do not "improve" a constant.
- Run `npm run typecheck` before every commit; it must be clean.

**Task order is the dependency spine. Do not reorder across phases.**

---

# PHASE 1 — `packages/desk-engine` (pure library, parity-gated)

### Task 1: Package scaffold + core types + wire contract

**Files:**
- Create: `packages/desk-engine/package.json`
- Create: `packages/desk-engine/src/index.ts`
- Create: `packages/desk-engine/src/types.ts`
- Create: `packages/desk-engine/src/contract.ts`
- Test: `packages/desk-engine/test/types.test.ts`

**Interfaces:**
- Consumes: nothing (root of the spine).
- Produces: every type below, verbatim. **All later tasks import from `@algomaker/desk-engine`; the names and shapes here are canonical.**

- [ ] **Step 1: Scaffold the package**

`packages/desk-engine/package.json` (copy the shape of `packages/payoff/package.json`):

```json
{
  "name": "@algomaker/desk-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "node --test test/*.test.ts" },
  "dependencies": { "@algomaker/greeks": "*" }
}
```

Run `npm install` at the repo root so the workspace links.

- [ ] **Step 2: Write `src/types.ts`** (complete file; header comment explains the two-sided quote decision, citing spec §6 and Python `store.py:139` where bid/ask died):

```ts
export type Side = 'Buy' | 'Sell';
export type OptType = 'CE' | 'PE';
export type Mode = 'paper' | 'live';
export type PricingMode = 'parity' | 'live';

/** Two-sided quote. bid/ask are BOTH-OR-NEITHER (a one-sided tick never
 * half-updates a book). asOf is epoch ms of the last update. */
export interface Quote {
  readonly bid: number | null;
  readonly ask: number | null;
  readonly ltp: number | null;
  readonly asOf: number;
}

export interface StrikeQuote {
  readonly strike: number;
  readonly ce: Quote | null;
  readonly pe: Quote | null;
}

export interface ChainSnap {
  readonly symbol: string;
  readonly expiry: string;        // YYYY-MM-DD
  readonly step: number;          // strike step
  readonly lotSize: number;
  readonly future: Quote;         // the forward for Black-76
  readonly spot: number;          // future mid in live mode; Python 'future' close in parity
  readonly strikes: ReadonlyArray<StrikeQuote>;
  readonly asOf: number;
}

export interface LegView {
  readonly instrument: string;    // real tradingsymbol
  readonly strike: number;
  readonly optType: OptType;
  readonly side: Side;            // Sell = short
  readonly lots: number;          // always positive; side carries direction
  readonly lotSize: number;
  readonly entry: number;         // per-share entry price
  readonly openedByEngine: boolean;
  readonly iv: number | null;     // marked IV (solved off mid; null = solve failed)
  readonly delta: number;         // per-share, unsigned magnitude with sign applied by consumers
  readonly gamma: number;
  readonly hasGreeks: boolean;    // false = IV solve failed; NEVER encoded as 0.0
  readonly mtm: number;           // exit-side in live pricing, mid-or-ltp in parity
  readonly exit: Quote;           // the pair mtm was valued off
}

export interface MarginInput {
  readonly value: number;
  readonly source: 'broker' | 'model';
  readonly asOf: number;
  readonly fresh: boolean;        // broker + within staleness window
}

export interface EngineInputs {
  readonly tag: string;
  readonly mode: Mode;
  readonly nowMs: number;
  readonly dateIst: string;       // YYYY-MM-DD
  readonly minuteOfDay: number;   // IST minutes since 00:00 (09:15 = 555)
  readonly dte: number;           // calendar days to expiry (0 on expiry day)
  readonly chain: ChainSnap;
  readonly legs: ReadonlyArray<LegView>;
  readonly protectedQty: Readonly<Record<string, number>>; // instrument -> lots
  readonly cumRealized: number;
  readonly margin: MarginInput;
  readonly pendingLots: number;   // remaining working-package lots
  readonly repairHold: boolean;   // desk-api repair-Apply hold is fresh: skip the action pass
  readonly pricing: PricingMode;
}

export type EngineAction =
  | { readonly op: 'open'; readonly strike: number; readonly optType: OptType; readonly side: Side; readonly lots: number }
  | { readonly op: 'close'; readonly instrument: string }
  | { readonly op: 'resize'; readonly instrument: string; readonly targetLots: number };

export type Trigger =
  | 'shift' | 'shed' | 'scrap' | 'lock' | 'margin' | 'expiry'
  | 'eod' | 'recycle' | 'unwind' | 'balance' | 'none';

export interface EngineDecision {
  readonly action: 'hold' | 'adjust' | 'flatten';
  readonly trigger: Trigger;
  readonly reason: string;
  readonly actions: ReadonlyArray<EngineAction>;
  readonly stateAfter: RuleState;
}

/** Persistent per-book rule state. Mirrors Python st[...] keys 1:1 so
 * parity fixtures can diff it structurally. All fields REQUIRED with
 * explicit zero-values — the absent-vs-zero trap died in the port. */
export interface RuleState {
  readonly rcCredit: number;              // st["rc_credit"]
  readonly rcEodDay: string;              // st["rc_eod_day"] ('' = never)
  readonly gkAnchor: number;              // st["gk_anchor"] (0 = unset)
  readonly gkStreak: number;              // st["gk_streak"]
  readonly scrapBanned: ReadonlyArray<string>;   // st["scrap_banned"] strike:optType:expiry keys
  readonly targetStreak: number;          // st["target_streak"]
  readonly targetLocked: boolean;         // st["target_locked"]
  readonly rcStack: ReadonlyArray<{ readonly strike: number; readonly optType: OptType; readonly lots: number }>; // _rc_stack for LIFO unwind
  readonly lastActionMs: number;          // cooldown reference
}
export const EMPTY_RULE_STATE: RuleState = {
  rcCredit: 0, rcEodDay: '', gkAnchor: 0, gkStreak: 0, scrapBanned: [],
  targetStreak: 0, targetLocked: false, rcStack: [], lastActionMs: 0,
};
```

- [ ] **Step 3: Write `src/contract.ts`** (the wire types from spec §9, complete):

```ts
import type { EngineAction, Mode, Side, Trigger } from './types.ts';

export type WorkMode = 'passive' | 'urgent';

export type WireAction =
  | { readonly op: 'open'; readonly instrument: string; readonly side: Side; readonly qty: number; readonly limitPrice?: number | undefined; readonly workMode?: WorkMode | undefined }
  | { readonly op: 'close'; readonly instrument: string; readonly limitPrice?: number | undefined; readonly workMode?: WorkMode | undefined }
  | { readonly op: 'resize'; readonly instrument: string; readonly targetQty: number; readonly limitPrice?: number | undefined; readonly workMode?: WorkMode | undefined };

export interface DecisionRequest {
  readonly tag: string;
  readonly mode: Mode;
  readonly decisionId: string;      // `${tag}:${mode}:${seq}`
  readonly symbol: string;
  readonly expiry: string;
  readonly trigger: Trigger;
  readonly reason: string;
  readonly actions: ReadonlyArray<WireAction>;
}

export interface WireFill {
  readonly instrument: string;
  readonly side: Side;
  readonly qty: number;
  readonly price: number;
  readonly resting?: boolean | undefined;
}

export interface DecisionResponse {
  readonly decisionId: string;
  readonly replayed: boolean;
  readonly status: 'DONE' | 'FAILED' | 'ROUTING' | 'WORKING';
  readonly fills: ReadonlyArray<WireFill>;
  readonly skips: ReadonlyArray<{ readonly instrument: string; readonly reason: string }>;
  readonly routeErrors: ReadonlyArray<string>;
}

export const ENGINE_DECISIONS_PATH = '/v1/desk/engine/decisions';
export const SUPERVISOR_NUDGE_PORT_DEFAULT = 8793;
```

`src/index.ts` re-exports both files: `export * from './types.ts'; export * from './contract.ts';`

- [ ] **Step 4: Write a compile-shape test** `test/types.test.ts` — construct one `EngineInputs` and one `DecisionRequest` literal, assert a field each (this pins `exactOptionalPropertyTypes` correctness at the boundary):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_RULE_STATE, ENGINE_DECISIONS_PATH } from '@algomaker/desk-engine';

test('canonical constants', () => {
  assert.equal(EMPTY_RULE_STATE.targetStreak, 0);
  assert.equal(ENGINE_DECISIONS_PATH, '/v1/desk/engine/decisions');
});
```

- [ ] **Step 5: Run** `npm test --workspace @algomaker/desk-engine` → PASS; `npm run typecheck` → clean.
- [ ] **Step 6: Commit** — `feat(engine): desk-engine package exists with the canonical types and the wire contract`

---

### Task 2: IST session + mark grid (`session.ts`)

**Files:**
- Create: `packages/desk-engine/src/session.ts` (+ export from index)
- Test: `packages/desk-engine/test/session.test.ts`

**Interfaces:**
- Produces: `isTradingDay(dateIst: string): boolean`, `SESSION_OPEN_MIN = 555`, `SESSION_CLOSE_MIN = 930`, `RULES_START_MIN = 560` (09:20), `markOf(minuteOfDay: number): number` (floor to 5-min grid within session), `isSameMark(a: number, b: number): boolean`.

- [ ] **Step 1: Port the calendar subset.** Source: `sensibull-desk/sensibull_tools/universe.py` — port ONLY `is_trading_day` (weekday check + the NSE holiday list constant for 2026; copy the literal holiday dates from `universe.py`, do not invent). Header comment cites the source lines.
- [ ] **Step 2: Failing tests** — `2026-08-24` (Mon) trading, `2026-08-23` (Sun) not, one holiday from the copied list not; `markOf(557) === 555`, `markOf(555) === 555`, `markOf(931) === 930` clamps.
- [ ] **Step 3: Implement; run; PASS.**
- [ ] **Step 4: Commit** — `feat(engine): the engine knows the NSE session, trading days and the 5-minute mark grid`

---

### Task 3: Dial schema + presets

**Files:**
- Create: `packages/desk-engine/src/dials.ts`
- Create: `packages/desk-engine/src/presets.ts` (+ exports from index)
- Test: `packages/desk-engine/test/dials.test.ts`, `packages/desk-engine/test/presets.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Dials {
  // Corridor
  readonly delta_tol_pct: number; readonly delta_shorts_only: boolean;
  readonly gamma_shorts_only: boolean; readonly tol_ref_dte: number;
  // Shift
  readonly shift_enabled: boolean; readonly shift_itm_steps: number;
  readonly shift_land_steps: number; readonly shift_margin_frac: number;
  readonly hedge_after_shift: boolean;
  // Band floor
  readonly min_band_lots: number; readonly no_band_floor: boolean;
  // Shed
  readonly shed_scan_strikes: number; readonly strikes_out: number;
  readonly min_sell_dte: number; readonly min_sell_delta: number;
  readonly scrap_close_delta: number;
  // Tiers
  readonly unwind_enabled: boolean;
  readonly recycle_frac: number; readonly recycle_bank: boolean; readonly recycle_opposite: boolean;
  readonly eod_flat_min: number;
  readonly trend_enabled: boolean; readonly trend_skew: number;
  readonly anchor_ema_marks: number; readonly confirm_marks: number;
  // Risk
  readonly target_pnl: number; readonly margin_cap: number;
  // Execution
  readonly work_tranche_lots: number; readonly chase_max_ms: number;
  readonly chase_cross_buffer_pct: number; readonly rest_max_min: number;
  // Tick
  readonly confirm_ms: number; readonly cooldown_s: number;
  // Advanced
  readonly scrap_close_px: number; readonly min_sell_px: number;
  readonly crash_delta: number; readonly target_confirm_marks: number;
  readonly sell_max_spread_pct: number; readonly quote_max_age_ms: number;
  readonly balance_min_dte: number; readonly balance_enabled: boolean;
}
export const DEFAULT_DIALS: Dials;              // relief-r live values per spec §5 table
export function resolveDials(raw: Readonly<Record<string, number | boolean>>): { dials: Dials; unknown: string[] };
export interface Preset { readonly key: string; readonly label: string; readonly dials: Partial<Dials>; }
export const PRESETS: ReadonlyArray<Preset>;    // 13 entries (12 + relief-r board)
```

- [ ] **Step 1: Failing tests.** `resolveDials({})` returns `DEFAULT_DIALS` exactly (deep-equal against the spec §5 table values — write the expected object out in the test, all ~38 fields, values copied from the spec). `resolveDials({ lot_size: 100 })` → `unknown: ['lot_size']` and value ignored. `resolveDials({ delta_tol_pct: 0.03 })` overrides one field. Every preset's `dials` keys are a subset of `Dials` keys (reflective check). `recenter-relief-r` preset has `delta_shorts_only: true`; `recenter-relief-r-board` has `false`.
- [ ] **Step 2: Implement.** Preset values come from the Python `DEFAULTS` dict — transliterate from `sensibull-desk/sensibull_tools/sim/rules/playbooks.py:349-660` and `sim/variants.py:387-564` using the consolidated dial diff table in the spec exploration report. Where a Python playbook OMITS a dial, the preset omits it too (the engine default applies); the eod3 quirk (`min_sell_delta` popped → inherits 0.10 via `scrap_close_delta`) is encoded as explicit values `{ scrap_close_delta: 0.10, min_sell_delta: 0.10 }` with a comment citing the quirk.
- [ ] **Step 3: Run; PASS; typecheck; commit** — `feat(engine): one dial schema with typed off-states; the 12 variants become presets`

---

### Task 4: Python decision-fixture generator

**Files:**
- Create: `scripts/gen-decision-fixtures.py`
- Create: `packages/desk-engine/test/fixtures/decisions/` (generated JSON, committed)

**Interfaces:**
- Produces: fixture files `decisions/<playbook-key>.json`, each an array of **sequences**; a sequence is `{ seed: {...}, marks: [{ ctx: <python rules_ctx>, decision: <python decision>, state_after: <ctx.state> }] }`.

- [ ] **Step 1: Write the generator.** Model on `scripts/gen-parity-fixtures.py` (same repo-relative path resolution, same venv invocation). Import the synthetic builders from the Python tests:

```python
import sys, json, copy, pathlib
PY = pathlib.Path.home() / 'Documents/dev/algo-engine/sensibull-desk'
sys.path.insert(0, str(PY)); sys.path.insert(0, str(PY / 'tests'))
from test_sim_hold_recycle import _ctx, _chain_rows, _sold_book   # the canonical synthetic builders
from sensibull_tools.sim.rules import playbooks as P

KEYS = [k for k in P.PLAYBOOKS if k.startswith('recenter')]
GRID = [  # (spot, net_delta_bias, dte, short_lots) — cover: inside band, past band,
          # deep-ITM (convexity floor), margin-armed shift, eod minute, expiry day
  (300.0, 0, 20, 4), (300.0, +900, 20, 4), (300.0, -900, 20, 4),
  (300.0, +900, 3, 4), (330.0, +2500, 20, 4),   # 10% rally -> ITM shift territory
  (300.0, +900, 20, 1), (300.0, +50, 20, 4), (300.0, +900, 0, 4),
]
```

For each `(key, grid-point)`: build ctx via `_ctx(...)`, set `ctx['margin']`/`ctx['margin_cap']` so the relief keys exercise BOTH sides of the `shift_margin_frac` 0.60 gate, then run a **6-mark sequence** (`09:20, 09:25, …`) threading `ctx['state']` forward, deep-copying ctx before each call, recording `{ctx, decision, state_after}` per mark. Write one JSON file per key under `packages/desk-engine/test/fixtures/decisions/`. Print a summary count.
- [ ] **Step 2: Run it** — `cd ~/Documents/dev/algo-engine/sensibull-desk && .venv/bin/python ~/Documents/dev/algomaker/scripts/gen-decision-fixtures.py`. Expect 12 files, each ≥ 8 sequences × 6 marks. Spot-check one relief sequence contains at least one non-hold decision (raise the grid's rally point until it does — a fixture set that never acts verifies nothing).
- [ ] **Step 3: Commit fixtures + script** — `test(engine): Python decision fixtures for all 12 recenter presets, state threaded across marks`

---

### Task 5: Marks, IV and greeks off the two-sided quote (`marking.ts`)

**Files:**
- Create: `packages/desk-engine/src/marking.ts` (+ export)
- Test: `packages/desk-engine/test/marking.test.ts`

**Interfaces:**
- Consumes: `@algomaker/greeks` — `b76Price`, `b76Greeks`, `b76ImpliedVol` (`packages/greeks/src/black76.ts`).
- Produces:

```ts
export function midOf(q: Quote): number | null;                 // both-sided -> mid, else ltp, else null
export function exitPrice(q: Quote, side: Side): number | null; // closing a long -> bid; closing a short -> ask; parity callers use midOf
export function markPrice(q: Quote, pricing: PricingMode, side: Side): number | null; // parity: mid-or-ltp; live: exitPrice
export const RISK_FREE = 0.065;
export function yearFrac(dateIst: string, expiry: string, minuteOfDay: number): number; // calendar/365, intraday-refined ONLY on expiry day (port pricing.py:119-149)
export function markLeg(leg: { strike: number; optType: OptType; side: Side; lots: number; lotSize: number; entry: number; instrument: string; openedByEngine: boolean }, q: Quote, chain: ChainSnap, dateIst: string, minuteOfDay: number, pricing: PricingMode): LegView;
export function strikeGreeks(chain: ChainSnap, strike: number, optType: OptType, dateIst: string, minuteOfDay: number): { delta: number; gamma: number } | null; // null when IV cannot solve — NO 0.30 fallback
```

- [ ] **Step 1: Failing tests** (real numbers — compute the expected side yourself):
  - `midOf({bid: 100, ask: 102, ltp: 95, asOf: 1})` → 101; ltp-only → 95; empty → null.
  - `exitPrice` — short leg (side Sell) values at **ask**; long at **bid**.
  - `markLeg` in `pricing:'parity'` reproduces mid-or-ltp mtm: leg Sell 2 lots × 25 shares, entry 10, quote {bid 8, ask 9} → mid 8.5 → mtm = +(10−8.5)×50 = **+75**; in `'live'` → ask 9 → mtm = +(10−9)×50 = **+50**.
  - `markLeg` where IV solve fails (price ≤ intrinsic) → `hasGreeks: false`, delta/gamma 0 but flag false.
  - `strikeGreeks` for an absent strike or unsolvable IV → **null** (assert not 0.3).
- [ ] **Step 2: Implement** (thin composition over `@algomaker/greeks`; IV always solved off `midOf`, greeks off that IV; `spot` = `chain.spot`). Header cites the TCS 2440PE stale-LTP case and the `dps=0.30` deletion.
- [ ] **Step 3: Run; PASS; commit** — `feat(engine): legs and strikes mark off the two-sided book, greeks are real or absent, never 0.30`

---

### Task 6: Corridor math (`corridor.ts`)

**Files:**
- Create: `packages/desk-engine/src/corridor.ts` (+ export)
- Test: `packages/desk-engine/test/corridor.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Corridor { allowed: number; netDelta: number; netGamma: number; hasGreeks: boolean; floorRef: number; excess: number; }
export function corridor(inputs: EngineInputs, dials: Dials): Corridor;
export function steeringPopulation(legs: ReadonlyArray<LegView>, shortsOnly: boolean): ReadonlyArray<LegView>;
```

Semantics (transliterate; cite each): `netDelta/netGamma` sum signed per-share greeks × lots × lotSize over the population picked per `delta_shorts_only`/`gamma_shorts_only` (`playbooks.py:2972-3018`); protected quantity **included** (protection limits actions, not measurement); `allowed = |netGamma| * tol * spot` with `tol_ref_dte` √dte shrink (`:3547-3549`) and `min_band_lots`/`no_band_floor` handling (`:4058-4061`); `hasGreeks` false if ANY leg in the population has `hasGreeks: false` — replaces the `netΓ == 0.0` sentinel (`:4063-4073`); `floorRef` = cheapest shed-candidate delta-shares × lotSize when `shed_scan_strikes > 0`, else `lotSize` (`:4115-4116`); `excess = |netDelta| − allowed`.

- [ ] **Step 1: Failing tests** with hand-computed numbers: a 4-lot short book with per-share Γ summing to |netΓ| 1000 at spot 300, tol 0.02 → `allowed = 6000`; netΔ +900 → excess −5100 (inside); netΔ +9000 → excess 3000. √dte: dte 5, ref 20 → tol × 0.5. Floor: `min_band_lots 2`, lotSize 25 → allowed = max(measured, 50). `hasGreeks:false` propagates. VEDL case shape: deep-ITM book where `allowed < floorRef` and scan off → the caller will hold (assert `floorRef` = lotSize when scan 0).
- [ ] **Step 2: Implement; run; PASS; commit** — `feat(engine): the corridor — band, floor, √dte shrink, and an honest hasGreeks flag`

---

### Task 7: Phase S — the ITM shift (`shift.ts`)

**Files:**
- Create: `packages/desk-engine/src/shift.ts` (+ export)
- Test: `packages/desk-engine/test/shift.test.ts`

**Interfaces:**
- Consumes: `corridor`, `strikeGreeks`, types.
- Produces: `export function phaseShift(inputs: EngineInputs, dials: Dials, state: RuleState): { actions: EngineAction[]; rolledDelta: number; rolledGamma: number; fired: boolean }` — `rolled*` are the greek adjustments phase R must apply post-shift.

Transliteration map (source `playbooks.py:3879-4027`, keep every branch):

| Python | TS |
|---|---|
| `spot <= 0 → hold` | guard at top |
| `_margin_ok = cap > 0 and margin/cap >= mfrac` | uses `inputs.margin`; **requires `margin.fresh` when source broker; model/stale → not ok** (spec §6) |
| `dte > min_sell_dte` gate | same |
| depth scan `K.unprotected(shorts)` | scan shorts minus `protectedQty` netting (Task 10 helper `unprotectedLots`) |
| `depth = (spot-k) CE / (k-spot) PE; depth < need → skip` | signed, OTM fails |
| `_otm_sell_strike(atm, step, ot, spot, shift_land_steps)` | `otmSellStrike()` — snap to chain strike, push until strictly OTM (`:2666-2680`) |
| roll-forward greeks `cd/cg` fallback to the leg's own | `strikeGreeks(...) ?? leg greeks` |
| `shift_slot` merge of two legs landing same target | merge opens by (strike, optType) |
| `hedge_after_shift false → return with shift alone` | `fired: true` and caller short-circuits |

- [ ] **Step 1: Failing unit tests**: (a) short CE 0.5 steps ITM at margin 65 % of cap → one close + one open at 2-steps-OTM, lots preserved; (b) margin 50 % → no shift; (c) `margin.source:'model'` at 90 % → **no shift** (the BHEL 42.9L-vs-20.8L case — cite it); (d) margin_cap 0 → never shifts; (e) protectedQty covering the ITM instrument → skipped; (f) two ITM legs → merged single open.
- [ ] **Step 2: Implement; run; PASS.**
- [ ] **Step 3: Wire the shift-family fixture subset**: add `test/parity-shift.test.ts` that loads `fixtures/decisions/recenter-{atm,otm,relief*}.json`, adapts each Python ctx → `EngineInputs` (adapter in `test/parity-adapter.ts` — map `ctx.marked_book` legs, `ctx.chain` rows, `ctx.spot`, `ctx.margin`, `ctx.state`; `pricing:'parity'`), runs ONLY sequences whose Python decision came from phase 1 (reason contains `shift`), and asserts **structural equality**: same action kind, same open (strike, optType, side, lots) set, same close instrument set, same `state_after` numeric fields. Reason strings are NOT compared (formatting differs); each mismatch prints both decisions.
- [ ] **Step 4: Run; make the subset PASS; commit** — `feat(engine): phase S — the margin-gated ITM shift, parity-green on the shift-family fixtures`

---

### Task 8: Phase R core — shed candidates, sizing (`shed.ts`)

**Files:**
- Create: `packages/desk-engine/src/shed.ts` (+ export)
- Test: `packages/desk-engine/test/shed.test.ts`

**Interfaces:**
- Produces:

```ts
export function shedCandidates(chain: ChainSnap, side: OptType, spot: number, scan: number, dateIst: string, minuteOfDay: number): ReadonlyArray<{ strike: number; dps: number }>; // _shed_candidates :4101-4159; nearest-first; dps from strikeGreeks; unsolvable strikes EXCLUDED
export function bestFit(cands: ReadonlyArray<{ strike: number; dps: number }>, excess: number, lotSize: number): { strike: number; lots: number } | null; // minimise |lots*dps*lotSize - excess|, ties to nearer; plain round, NEVER max(1,...) (:3710-3715)
export function phaseShed(inputs: EngineInputs, dials: Dials, state: RuleState, cor: Corridor): { actions: EngineAction[]; reason: string; sheddable: boolean };
```

`phaseShed` covers: side selection (`nd > 0 → CE`), the convexity floor (`allowed < floorRef` and no band-floor dials → hold with the VEDL-cited reason), candidacy liquidity gate in `'live'` pricing (spread ≤ `sell_max_spread_pct`, age ≤ `quote_max_age_ms`; gate SKIPPED in `'parity'`), and returns `sheddable:false` with the failing reason when no candidate survives (the supervisor's maker-quote path consumes this — Task 15).

- [ ] **Step 1: Failing tests**: hand-built 21-strike chain; excess 750 delta-shares, candidates dps {0.30, 0.18, 0.12}, lotSize 25 → bestFit picks the (strike, lots) minimizing the residual — compute it in the test; sub-one-lot excess → null (no forced 1-lot); wide-spread strike excluded only in `'live'`; all candidates excluded → `sheddable:false`.
- [ ] **Step 2: Implement; run; PASS; commit** — `feat(engine): phase R sheds to best-fit real greeks with a liquidity-gated candidate scan`

---

### Task 9: The remaining tiers — unwind, recycle, EOD, trend, anchor, balance

**Files:**
- Modify: `packages/desk-engine/src/shed.ts` (tiers compose into `phaseShed`)
- Create: `packages/desk-engine/src/tiers.ts` (+ export)
- Test: `packages/desk-engine/test/tiers.test.ts`

**Interfaces:**
- Produces (all pure, each consuming `(inputs, dials, state, cor)` and returning actions + state deltas):
  `applyEodSweep` (arm tol=0 once per `rcEodDay`, `playbooks.py:3527-3534`), `applyTrendTarget` (`:3652-3659`), `applyAnchor` (EMA `alpha=2/(n+1)` updated every mark incl. holds + confirm streak, `:3515-3525,:3608-3621`), `lifoUnwind` (LIFO buy-back from `state.rcStack`, bounded by delta budget AND gamma floor `g_floor = lotSize/(tol*spot)`, `:3677-3708,:2820-2898`), `applyRecycle` (`recycle_frac` of realized loss re-sold, same/opposite side, clipped to band room, bank in `rcCredit`, `:3761-3829`), `balanceTier` (one side entirely missing + dte > `balance_min_dte` → rebuild matched to live side, `:3578-3596`).

- [ ] **Step 1: Failing unit tests per tier** (one happy + one boundary each, hand-computed): unwind stops at the gamma floor (build a case where full unwind would breach it — assert the bounded lots); recycle credit banks the sub-lot remainder into `rcCredit`; EOD arms exactly once per date; anchor EMA advances on a hold mark; balance refuses at dte ≤ 7.
- [ ] **Step 2: Implement; run; PASS.**
- [ ] **Step 3: Full-family parity**: `test/parity.test.ts` runs ALL 12 fixture files end to end (same adapter + structural equality as Task 7 Step 3, now over every sequence, not just shift-triggered). Investigate every mismatch against the Python source before touching the TS — the fixture is right until proven otherwise.
- [ ] **Step 4: Run; PASS all 12; commit** — `feat(engine): every recenter-family tier is a toggle; all 12 preset fixtures parity-green`

---

### Task 10: Guard tiers + scrap + margin projection + the orchestrator

**Files:**
- Create: `packages/desk-engine/src/guards.ts`, `packages/desk-engine/src/scrap.ts`, `packages/desk-engine/src/margin-project.ts`, `packages/desk-engine/src/engine.ts` (+ exports)
- Test: `packages/desk-engine/test/guards.test.ts`, `test/scrap.test.ts`, `test/engine.test.ts`

**Interfaces:**
- Produces the single public entry:

```ts
export function decide(inputs: EngineInputs, dials: Dials, state: RuleState, markCtx: { isNewMark: boolean; markIndexToday: number }): EngineDecision;
export function unprotectedLots(legs: ReadonlyArray<LegView>, protectedQty: Readonly<Record<string, number>>): ReadonlyArray<LegView & { steerableLots: number }>;
```

`decide` implements the spec §5 evaluation order exactly (session → expiry settle → guards → scrap → phase S → phase R → sell gate → margin projection → state commit). Ports, with citations in headers:
- **Target lock** (`engine.py:490-662`): `total_pnl = cumRealized + Σmtm ≥ target_pnl` advances `targetStreak` **only when `markCtx.isNewMark`** (mark-anchored, D4/§7); streak ≥ `target_confirm_marks` → flatten-all (`trigger:'lock'`); `lock_exclude_mark0` skips `markIndexToday === 0`; `target_snap_multiple` ≥ 2× banks immediately. Cite TCS 2026-06-19.
- **Crash protect** `crash_delta` 0.60; **margin guard** trims worst shorts by |delta/share| one whole leg at a time, protected qty excluded at projection (`engine.py:663-752`).
- **Scrap tier** (`engine.py:753-815`): price test `0 < bid ≤ scrap_close_px` (bid in live, mid-or-ltp in parity), delta test `0 < |Δ| < scrap_close_delta` **strictly**, `hasGreeks:false` never scraps (TCS 2026-06-30: 72 phantom zero-delta scraps — cite), scrapped strike enters `scrapBanned` for its expiry, protected qty exempt.
- **Sell gate** (`engine.py:816-886`): strips banned / ≤`min_sell_px` / ≤`min_sell_delta` sells; roll degrades to its close; all-sells → hold.
- **Margin projection** (`engine.py:1009-1101`): Sell opens projected net of the decision's own closes against `margin_cap` (SPAN-lite port lives here — `sim/margin.py` 21-scenario grid, ~360 LOC arithmetic transliteration, used ONLY for projection, labeled); downsized or dropped; closes and Buy opens always survive.
- **Expiry settle**: `dte === 0` and past `SESSION_OPEN_MIN` → close every leg, `trigger:'expiry'`, before every other gate.
- **Repair hold**: `inputs.repairHold` → hold immediately after the expiry-settle check (settle still beats it — Python gate order, `driver.py:692-714`); marking and state carry on.

- [ ] **Step 1: Failing tests**: lock fires only after 3 *marks* over target (feed 10 tick-evaluations inside one mark → streak advances once); expiry settle beats a repair-hold-shaped hold (settle is checked first); scrap bans then sell-gate strips a re-sell at the banned strike; margin projection downsizes a 10-lot open to what 0.95×cap admits (hand-compute with the SPAN-lite port on a 2-leg book); `unprotectedLots` nets `protectedQty` 2 of 5 lots → steerable 3.
- [ ] **Step 2: Implement; run; PASS.** Re-run FULL parity (Task 9 Step 3) — still green (guards are in the fixtures' decision paths).
- [ ] **Step 3: Transliterate the remaining Python unit tests** — sweep `tests/test_sim_recenter*.py` (224 fns) and port every test that exercises logic now living in desk-engine; skip only those testing Python plumbing that no longer exists (bridge, translate). Target ≥ 150 ported assertions, spread across the existing test files by topic.
- [ ] **Step 4: Run everything; PASS; commit** — `feat(engine): decide() — guards, scrap, projection and both phases in the load-bearing order; parity + 150 ported tests green`

**PHASE 1 EXIT: `npm test --workspace @algomaker/desk-engine` fully green = the D15 readiness gate's item 1.**

---

# PHASE 2 — contract endpoint + `apps/supervisor` (working software on the paper rail)

### Task 11: desk-api endpoint `POST /v1/desk/engine/decisions`

**Files:**
- Create: `apps/api/src/routes/engine.ts`
- Create: `apps/api/src/engine-notify.ts`
- Modify: `apps/api/src/main.ts` (mount route; call notify on dial writes — find the `patchBookDials` call site in `routes/books.ts:806-830` and add the nudge)
- Test: `apps/api/test/engine-decisions.test.ts`

**Interfaces:**
- Consumes: `DecisionRequest`/`DecisionResponse`/`ENGINE_DECISIONS_PATH` from `@algomaker/desk-engine`; existing `BridgeService` internals: the gate evaluation used by `applyDecision` (`apps/api/src/service.ts:589`), rails (`apps/api/src/rail.ts`), book fold (`apps/api/src/book.ts` via the existing service path), idempotency store (`desk-decisions` unique `decisionId` — reuse the same collection constant from its owner).
- Produces: the endpoint; `notifySupervisor(kind: 'dials' | 'fill' | 'registry', payload: object): Promise<void>` (best-effort POST to `http://127.0.0.1:${DESK_SUPERVISOR_PORT ?? 8793}/nudge`, 1 s timeout, never throws — model on `apps/order-gateway/src/notify.ts`).

- [ ] **Step 1: Failing tests** (require-mongo pattern): (a) a valid open action on mode paper → 200 `status:'DONE'`, one fill with full instrument identity, book echo folded; (b) same decisionId re-posted → `replayed:true`, identical response, no second fill; (c) live-mode request for a tag whose strategy switch is off → exposure-increasing action refused (reuses `gateStrategy`), close passes; (d) malformed action → 400 REFUSED, nothing written; (e) `workMode`/`limitPrice` persisted onto the routed order document.
- [ ] **Step 2: Implement.** The handler validates against the wire types, resolves instrument → contract via the existing chain/instrument helpers in `apps/api/src/`, runs the SAME gate stack as `/v1/desk/actions` (call the existing functions — do not copy them), routes via the rails, folds, journals to `desk-decisions` AND `desk-engine-decisions` (new collection constant exported HERE, its owner). Response `status:'WORKING'` when the gateway path accepted but tranches remain (Phase 3 populates this; until then live returns ROUTING as today).
- [ ] **Step 3: Run; PASS; typecheck; commit** — `feat(api): the engine decisions endpoint — same gates, typed contract, full leg identity on fills`

---

### Task 12: Supervisor state store + lease

**Files:**
- Create: `apps/supervisor/package.json` (mirror `apps/runner/package.json`: name `@algomaker/supervisor`, node --test script)
- Create: `apps/supervisor/src/state-store.ts`, `apps/supervisor/src/lease.ts`
- Test: `apps/supervisor/test/state-store.test.ts`, `apps/supervisor/test/lease.test.ts`

**Interfaces:**
- Produces:

```ts
// state-store.ts — collection 'desk-supervisor-state', THIS FILE is the owner of the constant
export interface SupervisorBookState {
  readonly key: string;                    // `${tag}:${mode}`
  readonly ruleState: RuleState;
  readonly workingPackage: { readonly decisionId: string; readonly remaining: ReadonlyArray<WireAction>; } | null;
  readonly protectedQty: Readonly<Record<string, number>>;
  readonly cumRealized: number;
  readonly inFlight: string | null;        // unresolved decisionId
  readonly seq: number;                    // decision sequence
  readonly updatedAt: number;              // CAS version
}
export class StateStore {
  load(tag: string, mode: Mode): Promise<SupervisorBookState>;   // EMPTY defaults when absent
  save(prev: SupervisorBookState, next: SupervisorBookState): Promise<boolean>; // CAS on updatedAt; false = conflict, reload
}
// lease.ts — collection 'desk-supervisor-lease'
export class Lease { acquire(owner: string, ttlMs: number): Promise<boolean>; heartbeat(): Promise<boolean>; release(): Promise<void>; }
```

- [ ] **Step 1: Failing tests**: fresh load returns EMPTY_RULE_STATE + seq 0; save-CAS conflict returns false; two Lease instances — second `acquire` false while first heartbeats, true after TTL lapse.
- [ ] **Step 2: Implement (findOneAndUpdate CAS, per `apps/order-gateway/src/queue.ts:111-126` pattern); run; PASS; commit** — `feat(supervisor): durable per-book state with CAS and a lease that stops two supervisors steering one book`

---

### Task 13: ChainView — bus ticks to EngineInputs

**Files:**
- Create: `apps/supervisor/src/chain-view.ts`
- Test: `apps/supervisor/test/chain-view.test.ts`

**Interfaces:**
- Consumes: bus frames `md.tick {token, price, ts, oi?, volume?, bid?, ask?}`; instrument metadata via the existing instrument-master helpers (`packages/instruments` — chain windows per underlying+expiry as used by `apps/api/src/chain.ts`); `desk-marks` snapshot for boot warm-start (read-only).
- Produces:

```ts
export class ChainView {
  constructor(deps: { tokensFor(symbol: string, expiry: string): ReadonlyArray<{ token: number; strike: number; optType: OptType; instrument: string }>; futureToken(symbol: string): number; });
  onTick(t: { token: number; price: number; ts: number; bid?: number; ask?: number }): void;  // both-or-neither book update; book survives ltp-only tick (QuoteCache rule, marks.ts:190-219)
  warmStart(rows: ReadonlyArray<{ token: number; price: number; ts: number; bid: number | null; ask: number | null }>): void;
  snap(symbol: string, expiry: string, lotSize: number, step: number): ChainSnap | null;      // null until the future has a quote
  touchedSince(ms: number): boolean;
}
```

- [ ] **Step 1: Failing tests**: an ltp-only tick after a two-sided tick keeps the book pair (assert bid/ask survive); `snap()` mid of future feeds `spot`; unknown token ignored; warmStart then tick overrides.
- [ ] **Step 2: Implement; run; PASS; commit** — `feat(supervisor): ChainView turns md.tick into two-sided chain snapshots, book pairs survive LTP-only ticks`

---

### Task 14: EngineHost — damping, decision lifecycle, working package

**Files:**
- Create: `apps/supervisor/src/engine-host.ts`
- Create: `apps/supervisor/src/decisions-client.ts`
- Test: `apps/supervisor/test/engine-host.test.ts`

**Interfaces:**
- Consumes: `decide()` from desk-engine; `StateStore`; `ChainView.snap`; book read (`desk-books` via a `readBook(tag, mode)` dep injected — reads the collection through the api-owned constant, read-only).
- Produces:

```ts
// decisions-client.ts
export class DecisionsClient {
  constructor(baseUrl: string, token: string);
  submit(req: DecisionRequest): Promise<DecisionResponse | 'INDETERMINATE'>;  // 4xx -> throws RefusedError{body}; 5xx/timeout -> 'INDETERMINATE'
}
// engine-host.ts — one instance per (tag, mode)
export class EngineHost {
  constructor(deps: { tag: string; mode: Mode; dials(): Dials; snap(): ChainSnap | null; readBook(): Promise<ReadonlyArray<BookLeg>>; margin(): MarginInput; store: StateStore; client: DecisionsClient; now(): number; log: Logger });
  evaluate(): Promise<void>;   // the full pass; serialized internally (concurrency-1, StrategyBase style)
  onFillNudge(): void;         // re-poll inFlight immediately
  resolveInFlightOnBoot(): Promise<void>;
}
```

`evaluate()` behavior (each a test): builds `EngineInputs` (marking legs via desk-engine `markLeg`); calls `decide`; **damping** — a non-hold decision arms a pending intent, only routed once the same trigger+action-shape persists `confirm_ms` (or excess ≥ band + 1 lot-equivalent immediately); `cooldown_s` after any routed decision; one `inFlight` at a time; on route: `seq++`, save state (CAS) BEFORE posting (crash-safe: boot re-posts `inFlight` verbatim); RefusedError → roll back the armed intent's state delta, log error, do NOT retry; INDETERMINATE → keep `inFlight`, poll at 1 s; DONE → fold `cumRealized` from fills at fill price, update `workingPackage` remainder, clear `inFlight`. Working-package hold: `pendingLots > 0` suppresses new playbook actions in inputs; guard triggers (lock/expiry/margin/crash) bypass damping AND may preempt (cancel intent, act).

- [ ] **Step 1: Failing tests** with a fake client + fake clock (inject `now()`): (a) trigger appears then vanishes within confirm_ms → nothing routed; (b) persists → routed once, cooldown suppresses the next; (c) crash-kill between save and post simulated by calling `resolveInFlightOnBoot()` with a client that replays → exactly one fill folded; (d) REFUSED → state rolled back, mark advances, no retry; (e) guard trigger routes with zero damping delay.
- [ ] **Step 2: Implement; run; PASS; commit** — `feat(supervisor): EngineHost — damped tick evaluation, crash-safe idempotent routing, fill folding at fill price`

---

### Task 15: Supervisor main — boot, loops, nudges, journaling, maker-quote

**Files:**
- Create: `apps/supervisor/src/main.ts`, `apps/supervisor/src/http.ts`, `apps/supervisor/src/registry-poll.ts`, `apps/supervisor/src/marks-journal.ts`
- Create: `bin/desk-supervisor.mjs`
- Modify: `ecosystem.desk.config.cjs` (new `app()` entry, namespace desk, `max_memory_restart: '900M'`)
- Test: `apps/supervisor/test/main-lifecycle.test.ts`

**Interfaces:**
- Consumes: everything above; `WsTransportClient` from `@algomaker/bus`; `publishSubscription` (import from `apps/marketdata/src/subscription-store.ts` — cross-app import is house pattern); `installCrashGuards`, `connectWithRetry` from `@algomaker/core`.
- Produces: the running process. `http.ts`: `POST /nudge {kind}` → dispatch to hosts; `GET /health` → `{books, lease, feedAgeMs}`. `registry-poll.ts`: 5 s poll of `desk-books-registry` → build/drop EngineHosts on `desired`, `resolveDials` per row (unknown keys logged loudly), `POST .../registry/:tag/actual` heartbeat. `marks-journal.ts`: on each new 5-min mark per book, insert into `desk-book-marks` `{tag, mode, mark, ts, spot, netDelta, netGamma, band, totalPnl, marginSource}` (owner of that constant) and hand `markCtx` to the host (the target-lock clock).
- Maker-quote path lives here: when `decide` returns `sheddable:false` (Task 8), the host routes the intended sell with `limitPrice` = Black-76 theoretical (desk-engine `b76Price` off marked IV, tick-floored) + `workMode:'passive'`, alerts via log at error visibility, arms invalidation (cancel via the existing `POST /v1/desk/broker/orders/:id/cancel` + re-evaluate on ≥1 strike-step underlying move or `rest_max_min` or guard preemption).

- [ ] **Step 1: Failing lifecycle test** (fake bus + fake api): boot with one running registry row → host built, subscription row written (complete token list), first evaluate within 2 s of a tick; SIGTERM → **zero decision posts during shutdown** (the D6 test — assert the fake client received nothing after the signal); dial nudge → `dials()` reflects the change on the very next evaluate.
- [ ] **Step 2: Implement `main.ts`** in the runner's shape (`apps/runner/src/main.ts:84-104`): crash guards first line, connectWithRetry, lease acquire (retry loop — a second supervisor waits, never exits), boot unconditional (never gated on market hours), warm-start ChainView from `desk-marks`, wire loops (registry 5 s, subscription refresh 15 s, inFlight poll 1 s when armed, all `.unref()`ed). `bin/desk-supervisor.mjs` imports `main` and CALLS it (the pm2 fork-container trap — copy the comment from `bin/desk-runner.mjs`).
- [ ] **Step 3: Run tests; PASS. Boot it locally against dev Mongo + a synthetic tick script; watch one full evaluate log line.**
- [ ] **Step 4: Commit** — `feat(supervisor): the desk-supervisor process — boots, leases, subscribes, evaluates, journals marks, and its stop is inert`

**PHASE 2 EXIT: paper book steered end-to-end by the TS supervisor (instant paper fills; lifecycle upgrade next phase).**

---

# PHASE 3 — execution: peg chaser, fill-gated tranches, paper lifecycle

### Task 16: Gateway quote map + peg-mode chaser

**Files:**
- Modify: `apps/order-gateway/package.json` (add `"@algomaker/bus": "*"` — currently symlink-only)
- Modify: `apps/order-gateway/src/main.ts` (subscribe `md.tick` unconditionally — lift the simulate-only guard at `main.ts:1546-1551` into an always-on token→quote map)
- Create: `apps/order-gateway/src/quote-map.ts`
- Modify: `apps/order-gateway/src/order-chaser.ts` (peg mode)
- Test: `apps/order-gateway/test/quote-map.test.ts`, `apps/order-gateway/test/order-chaser-peg.test.ts`

**Interfaces:**
- Produces: `QuoteMap` — `onTick(frame)`, `touch(token): { bid: number; ask: number; ts: number } | null` (null when > `DESK_PEG_QUOTE_MAX_AGE_MS`, default 15 000). Chaser: order docs with `workMode:'passive'` enter **peg mode**: target = bid (BUY) / ask (SELL), tick-rounded; modify only when |target − lastChasePrice| ≥ 1 tick AND dwell ≥ `DESK_PEG_DWELL_MS` (default 1 000); worst-price bound = original limit ± `chase_cross_buffer_pct` × limit; stale touch → **pause** (no modify, no attempt consumed); after `chase_max_ms` from placedAt → one crossing modify at touch ∓ `chase_cross_buffer_pct` then `exhaust()` → the existing working-order alert takes over. `resting:true` remains an absolute skip (assert unchanged). Existing blind-escalation path untouched for non-passive docs.

- [ ] **Step 1: Failing tests** against the existing chaser test harness (find `apps/order-gateway/test/` chaser tests and extend): passive SELL placed at ask 10.00, touch moves to 10.10 after dwell → one `modifyOrder(10.10)`; touch flickers 10.00→10.05→10.00 within dwell → zero modifies; stale quote → zero; `chase_max_ms` elapsed, touch {bid 9.90} → crossing modify at `9.90 × (1 − 0.005)` tick-floored, then exhausted; cancel-pending doc → skipped (cancel wins, unchanged).
- [ ] **Step 2: Implement; run; PASS; typecheck; commit** — `feat(gateway): passive orders join the touch and re-peg by atomic modify; crossing is the last resort, never the first`

---

### Task 17: Fill-gated tranche placement

**Files:**
- Modify: `apps/order-gateway/src/main.ts` (split the place-all loop at `main.ts:1360-1461`)
- Modify: `apps/order-gateway/src/queue.ts` (tranche cursor state)
- Modify: `apps/order-gateway/src/fills.ts` (advance hook)
- Test: `apps/order-gateway/test/tranche-gating.test.ts`

**Interfaces:**
- Consumes: `aggregateTranches`/per-tranche terminality (`gateway.ts:419-505`), `FillWatcher.reconcile` (`fills.ts:193`).
- Produces: order docs gain `{ tranchePlan: ReadonlyArray<{ qty: number }>, trancheCursor: number }` when qty > tranche size. Placement: tranche 0 placed on claim; `FillWatcher` observing tranche `i` terminal-filled → CAS-advance `trancheCursor` and place tranche `i+1` (through the same claim machinery — no second placement path); tranche REJECTED → doc `state:'HALTED'`, alert journal line, **no further tranches** (D11); `workMode:'urgent'` docs get tranche size = freeze limit. Tranche size arrives on the doc as `trancheLots` from the api (desk-api passes the book's `work_tranche_lots` through the rail — add the field in `rail.ts:86-110` orderDocument and thread it from the engine endpoint's request context).

- [ ] **Step 1: Failing tests** (simulator adapter): 9-lot passive order, trancheLots 3 → exactly one 3-lot broker order live at a time; feed a crossing tick → tranche 1 fills → tranche 2 appears; reject tranche 2 → HALTED, journal has the alert line, tranche 3 never placed; urgent 9-lot with freeze 5 → tranches {5, 4}.
- [ ] **Step 2: Implement; run; PASS; commit** — `feat(gateway): big orders work in fill-gated tranches — the next slice waits for the last, a reject halts loudly`

---

### Task 18: Paper rail runs the real lifecycle

**Files:**
- Modify: `apps/api/src/rail.ts` (PaperRail routes engine-endpoint orders into `desk-gateway-orders` with `mode:'paper'` instead of instant-filling)
- Modify: `apps/order-gateway/src/main.ts` (paper-mode orders always use the simulator adapter, fed from the QuoteMap ticks; live adapter untouched for live docs)
- Test: `apps/api/test/engine-paper-lifecycle.test.ts`

**Interfaces:**
- Consumes: the simulator (`apps/order-gateway/src/simulator.ts` — modify + tick-crossing fills already supported), QuoteMap.
- Produces: engine paper decisions return `status:'WORKING'` with fills arriving via `desk-fills` (mode paper) exactly like live — D14. The OLD instant-fill PaperRail path remains for `/v1/desk/submit` (manual box, runner) — only the engine endpoint opts into lifecycle routing (a `via:'engine'` flag on the routed context). Supervisor already handles WORKING + fill nudges (Task 14).

- [ ] **Step 1: Failing test**: engine paper open → response WORKING, no instant fill; publish a crossing tick to the gateway's map → `desk-fills` row appears with `mode:'paper'`, desk-api folds the book, supervisor nudge fires (assert the notify call).
- [ ] **Step 2: Implement; run; PASS; commit** — `feat(desk): a paper order lives the live order's life — placed, worked, filled by ticks, folded on the fill event`

**PHASE 3 EXIT: paper session = full rehearsal (readiness items 2–3 testable).**

---

# PHASE 4 — UI, removal, drills, deploy

### Task 19: Dials panel — sections, toggles, presets, Protect

**Files:**
- Create: `apps/web/src/dials-panel.tsx` (replaces `DialsPanel` in `books.tsx:258`)
- Create: `apps/web/src/dials-plan.ts` (pure logic: section grouping, preset diffing, validation — node-testable)
- Modify: `apps/web/src/books.tsx` (mount new panel; preset picker on create)
- Modify: book/leg row component (find the leg-rows table in `apps/web/src` — the one rendering per-leg bid/ask from the exit-marks work) — add the Protect control (posts `{instrument, protectedQty}` to a new small api route `POST /v1/desk/engine/protect` added here, writing through `StateStore`'s collection via desk-api with re-auth like dials)
- Test: `apps/web/test/dials-plan.test.ts` (node), `apps/web/test/dials-panel.test.tsx` (vitest)

**Interfaces:**
- Consumes: `PRESETS`, `DEFAULT_DIALS`, `resolveDials`, section metadata from `@algomaker/desk-engine` (add `DIAL_SECTIONS: ReadonlyArray<{ key: string; label: string; toggle?: keyof Dials; fields: ReadonlyArray<keyof Dials> }>` to `dials.ts` — the panel renders from it, no field list duplicated in web).
- Produces: `planDialsView(preset: string, overrides: Record<string, number|boolean>): Array<{ section, fields: Array<{ key, value, overridden, inert }> }>` — `inert` when the section toggle is off.

- [ ] **Step 1: Failing node tests for `dials-plan.ts`**: preset relief-r + override `delta_tol_pct: 0.03` → that field `overridden:true`, all others false; `shift_enabled:false` → shift numerics `inert:true`; unknown override key → surfaced as an error row, not dropped (F-29).
- [ ] **Step 2: Implement plan + panel** (existing modal patterns from `books.tsx` — keep the live re-auth flow at `:304-308` verbatim); preset picker writes `preset` label + the preset's dials on create.
- [ ] **Step 3: vitest smoke: renders sections, toggle collapses, Save posts the PATCH. Run both suites; PASS.**
- [ ] **Step 4: `npm run build --workspace @algomaker/web` — clean. Commit** — `feat(web): the dials modal is sections and toggles with presets; legs can be protected by quantity`

---

### Task 20: The removal (D9)

**Files:**
- Delete: `apps/api/src` Python-facing pieces — `POST /v1/desk/actions` handler (`routes/desk.ts:121-…`), `POST /v1/desk/variants` (`routes/books.ts:81/174`), the `CE530#3` deskTag parsing in `apps/api/src/contract.ts:9-20` region and its validation, `docs/PYTHON-DESK.md`
- Modify: `bin/desk-reset.mjs` (learns `desk-supervisor-state`, `desk-engine-decisions`, `desk-supervisor-lease`, `desk-book-marks`)
- Modify: `context/00-live-system-map.md` (append a dated correction note: the Python boundary is retired; supervisor is native)

- [ ] **Step 1: Grep-audit before deleting** — `grep -rn "desk/actions\|desk/variants\|deskTag" apps/ packages/ bin/` and list every consumer; anything the dashboard or runner still uses stays (the spec keeps all GETs). Delete only what the audit shows dead.
- [ ] **Step 2: Delete; fix compiles; run the FULL repo suite** `make check` → green (this is the proof nothing living depended on the removed code).
- [ ] **Step 3: Commit** — `chore(desk): the Python-facing bridge surface is gone — actions, variants, pseudo-symbols, and their docs`

---

### Task 21: Restart drills + dry run

**Files:**
- Create: `apps/supervisor/test/drills.test.ts`
- Create: `scripts/dryrun-feed.mjs` (synthetic tick publisher: connects to the bus as a publisher is not possible — instead it runs a minimal WS server on `DESK_BUS_URL`'s port in a dev shell, or publishes through a marketdata test hook; use the same `WsTransportServer` from `@algomaker/bus` that marketdata uses, emitting fabricated `md.tick` walks for a 21-strike chain: drift, rally-to-shift, band-breach, scrap-decay scenarios)

- [ ] **Step 1: Drills as tests** (fake deps, real StateStore against Mongo): kill-mid-decision (state saved, post never sent) → boot → `resolveInFlightOnBoot` posts once, api fake replays → one fold; kill-mid-package → boot resumes tranche cursor; SIGTERM mid-evaluate → no post.
- [ ] **Step 2: The dry run (manual, scripted):** `DESK_BROKER=simulate make up` locally + `node scripts/dryrun-feed.mjs rally` → watch: registry book created from relief-r preset via the UI → paper decisions flow → shift fires on the rally scenario → tranches gate → maker-quote fires on the illiquid scenario → target-lock scenario flattens after 3 marks. Checklist each observation in the PR/commit message.
- [ ] **Step 3: Commit** — `test(supervisor): restart drills prove exactly-once routing; the dry-run feed rehearses shift, shed, lock and the maker-quote`

---

### Task 22: Deploy + prod cutover

**Files:**
- Modify: `ecosystem.desk.config.cjs` (already has the entry from Task 15 — verify env), `.env.local.example` (`DESK_SUPERVISOR_PORT=8793`)

- [ ] **Step 1: Deploy** — weekend, so the market-hours guard permits: `make deploy-remote`. Health-check `:8793/health` + pm2 list shows `desk-supervisor` online (namespace desk).
- [ ] **Step 2: Prod removal (D9), in order:** on the box — `tar czf ~/desk-state-archive-$(date +%F).tgz /home/ubuntu/sensibull_tools/data/desk && ls -la ~/desk-state-archive-*` (verify size > 0) → `npx pm2 delete desk-supervisor desk-supervisor-live` (the PYTHON ones, in the sensibull pm2 namespace — verify by `pm2 describe` BEFORE deleting; the new TS app has the same name in the `desk` namespace, do not delete it) → remove both from `sensibull-desk/ecosystem.config.js` and commit that repo → `rm -rf data/desk` only after the tar is verified.
- [ ] **Step 3: Leave the launch runbook in the spec (§13) — launch is operator-initiated on any trading day: create book from preset → paper session → password-gated live flip.**
- [ ] **Step 4: Commit anything remaining; final `make check` green.**

---

## Self-review notes (performed at write time)

- **Spec coverage:** D1–D8 → Tasks 1–10; D10 → 16; D11 → 17; D12 → 10/19; D14 → 18; D9 → 20/22; D15 → 4/7/9/10; §7 damping → 14; §10 lease/restart → 12/14/21; §11 → 19; maker-quote §8 → 15. Repair hold: consumed in Task 14's inputs via the positions payload — the engine holds when desk-api reports `repairHold` fresh; carried as a boolean on `EngineInputs`? **Gap found and fixed:** add `readonly repairHold: boolean` to `EngineInputs` (Task 1) and a hold branch in `decide` after expiry settle (Task 10) — included above.
- **Type consistency:** `WireAction.qty` is contracts; `EngineAction` lots — EngineHost converts (lots × lotSize) in Task 14; `trancheLots` threads api→rail→gateway in Task 17.
- **Placeholder scan:** transliteration tasks cite exact Python line ranges and carry mapping tables + hand-computed test values; no TBDs.
