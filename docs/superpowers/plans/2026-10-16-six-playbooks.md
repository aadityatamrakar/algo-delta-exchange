# Six playbooks: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

## v2 amendments: these take precedence over the task text below

The spec is now **v2** (`docs/superpowers/specs/2026-10-16-six-playbooks-design.md`).
It follows the independent review: one blocker and five high findings. **Where the
spec v2 and a task below disagree, spec v2 wins.** The binding deltas per task:

**Done and merged into `playbooks`:**
- Task 2 (touch fills), Task 3 (the expiry buffer) and Task 4 (the scenario simulator).
- The touch-fill change also needed `apps/api/test/engine-paper-lifecycle.test.ts`
  updated (now `CROSSING_BID`).

**Task 1 (in flight) takes the interface delta of spec v2 §4.4 and §8.**
- New dials: `pb_gap_min_pct`, `pb_gap_max_pct`, `pb_trend_exit_s`,
  `pb_wing_fresh_s`, `pb_retry_s`, `pb_stage_gap_s`, `pb_rupee_hold_s` and
  `pb_max_gap_min`. Plus `dl_parity_forward`, which goes in the delta-lean section
  (now 41); `DELTA_LEAN_BASE` sets it true.
- `pb_min_dte` counts trading days.
- The preset values are spec v2 §8.2.
- `PlaybookState`:
  - gains `stageReadyMs`, `exitMs`, `rupeeSinceMs` and `maxGapMs`, and loses
    `planAdd`;
  - `planShorts` entries are `{strike, optType, cover}`;
  - `stageSpot` is the INDEX level.
- `DeltaLeanInputs` gains optional `prevClose`, `inFlight` and `forwardSource`.
- `SpotRing` gains `filteredRange` (median-of-3 extremes plus `maxGapMs`).
- `playbook/types.ts`:
  - `PlannedShort = {strike, optType, cover}`, and `OpenPlan.shorts: readonly PlannedShort[]`;
  - `PlaybookCtx` gains `gapPct`, `working`, `forwardOk`, `tradingDte` and `dayRobust`;
  - `tradingDaysToExpiry(dateIst, expiry)` is exported.

**Task 3 follow-up (main session):** F3 also covers trigger `eod`.

**Task 5 (the frame) implements spec v2 §4.3-§4.6 exactly.** That includes:
- the D2 close (shorts first, longs only once no short remains) for EVERY exit,
  including the frame's day exits. It is a playbook-local variant of `exitDecision`
  with the same latch semantics;
- exit escalation: passive to urgent after 60 s, or on a hard-stop condition;
- the rupee-stop debounce (`rupeeSinceMs`, `pb_rupee_hold_s`);
- step 7 (stage 1 incomplete) running the hard stop before stage 2;
- `working = pendingLots > 0 || inFlight === true`. Stage 2 and finish-trade run only
  when not working;
- stage-2 sizing at `min(planLots, held lots of the cover leg)`:
  - a cover at 0 → abort;
  - `stage = 2` until every short is held;
  - a missing short is re-sent no sooner than `pb_stage_gap_s`;
  - aborts as §4.6 lists them. A null STR or a stale S means wait;
- the new-risk gates applied to stage 2 and adds (minus the window), including
  `forwardOk`, the gap gates and `now − dlLastAdjustMs ≥ pb_retry_s`;
- every playbook open stamping `dlLastAdjustMs = now` in `stateAfter`;
- adds as single-stage buys;
- index rules reading `S` (index), never `F`;
- the day fold from `filteredRange`, writing `pb` only when a field changes;
- the per-wing liquidity test with `pb_wing_fresh_s` for protective legs;
- the gate on the newest OPTION quote's age (≤ 10 s), not only `chain.asOf`.

Task 5 also extends the scenario harness (`packages/desk-engine/test/scenario/sim.ts`)
with **fill-outcome injection**:
- a `fills?: (pass, action) => 'fill' | 'skip' | 'delay:N' | 'fail'` hook in
  `ScenarioSpec`;
- `inFlight` set while a delayed fill is pending;
- `nakedShortPasses` counting lot-coverage per option type (already done in Task 4).

**Task 6 (the supervisor) adds:**
- `dl_parity_forward` per book: parity only when the book's resolved dials have
  `delta_lean_enabled && dl_parity_forward`, and the env `DESK_CHAIN_FORWARD=future`
  still overrides;
- `forwardSource`, `inFlight` (`state.inFlight !== null || state.workingPackage !== null`)
  and `prevClose` passed into `DeltaLeanInputs`;
- the `md.spot` `prevClose` capture, plus the `apps/marketdata/src/main.ts` publish of
  `prevClose` from `t.ohlc?.close` (finite, > 0);
- F8: `alreadyWorking` treats a working `DL_EXIT_TRIGGERS` package as the same exit
  for an `eod` decision (`apps/supervisor/src/engine-host.ts` ~489-510).

**Task 7 (roll + api) implements spec v2 §4.9 as a THIRD family:**
- its own plan, create and retire, outside the daily four's single-expiry check and
  the `others` loop;
- the contract by trading days;
- `PLAYBOOK_EXPIRY_FROM = '2026-10-21'`;
- test dates 16, 19, 21 and 22 Oct.

It also adds F9: the registry PATCH refuses (409) changing `delta_lean_enabled` or
`pb_playbook` on a book with legs (`apps/api/src/routes/books.ts` /
`books-registry.ts`), with a test.

**Task 8 (web):** the delta-lean section pin goes from 40 to 41 (`dl_parity_forward`);
the Playbook section gains the new `pb_*` dials.

**Tasks 9-11 (the playbooks) implement spec v2 §5 rule by rule.** That includes:
- the gap gates;
- the flip only when losing;
- no trail before 13:00 on Trend Drive and Reversal;
- the Wing Straddle at 1 lot and 5 trading days, with combined and index stops;
- the Theta Fly with its trend exit and no index stop;
- Gamma's 0-lot rule;
- every scenario in spec v2 §7 marked for the scenario suite;
- the coverage invariant asserted on every run.

**Goal:** Ship six new paper books for NIFTY and SENSEX: Trend Drive, Wing Straddle,
Reversal Spread, Expiry Drive, Expiry Theta Fly and Expiry Gamma Breakout. They run as
playbooks on the native supervisor's delta-lean decide path. The foundation fixes that
make their chains, fills and expiry-day prices honest ship with them.

**Architecture:** A playbook book is a delta-lean book (`delta_lean_enabled: true`) with
`pb_playbook` between 1 and 6. The supervisor host dispatches it to a new pure
`decidePlaybook`. That function is a frame of shared lifecycle, exits, staging and
session statistics, and it calls one small module per strategy. Everything the host
already does for delta-lean books (spot ring, cadence, order budgets, fast exits, day
guard, roll) applies unchanged. A fail-safe preset dial (`dl_open_lots: 0`) makes the
book inert on a build that does not know the playbooks.

**Tech stack:** TypeScript, run directly by Node 24 (type stripping, no backend build),
`node:test` for engine, supervisor, API and scripts, vitest for `apps/web`, MongoDB
3.7 driver.

**Spec:** `docs/superpowers/specs/2026-10-16-six-playbooks-design.md`. Every task
implements a named section of it. Read the spec section before the task.

## Global constraints

- **Paper only.** No code path added here may create, enable or route a live book. The
  roll's mode is the constant `PAPER`.
- **Defined risk, D1.** No pass may leave a playbook book short an option it does not
  hold a protective long for. Tasks 9-11's scenario suites assert it.
- **Buy before you sell, D2.** Every playbook package containing a short is staged:
  protective buys first, shorts only after they are held.
- **Old-build fail-safe, D9.** Every playbook preset sets `dl_open_lots: 0`.
- **No new dial may change an existing book.** Every `pb_*` default is inert while
  `pb_playbook` is 0. Recenter books keep the future-mid forward.
- **Dials are `number | boolean` only.** They are required fields of `Dials` with
  values in `DEFAULT_DIALS`. Keep `packages/desk-engine/src/dials.ts` import-free;
  the browser imports it.
- **Never edit `archive/`.**
- **Tests on this box reach live loopback ports.** Any new api route test that drives
  registry, dials or paper-fold routes must use `startNudgeSink()`
  (`apps/api/test/require-mongo.ts`).
- **API Mongo suites use fixed database names.** In a worktree run only your own
  area's suites (see each task). One `make check` runs on the merged tree.
- **Worktrees need their own install.** Run `npm ci --ignore-scripts` in the worktree.
  Do not symlink the main checkout's `node_modules`.
- **Never run** `scripts/delta-lean-roll.mjs` against the live API, never `pm2
  restart`/`stop`, and never probe optionbhai or any external host.
- **Style.** Comments match the surrounding files: a docstring that says why, and
  absent-is-never-zero discipline. No `undefined` in a `Dials` or a `RuleState`.

## Review focus

1. **A short leg without its wing.** A stage-1 package that fills only one wing, then
   a stage 2 that sells both centre options. Expected: stage 2 waits until every
   protective leg is held, and after 120 s it aborts and closes what was bought. Pin
   in Task 5 ("stage 2 waits for every protective leg").
2. **An exit that never finishes.** An exit package that partly fills, then the trade
   target condition disappears. Expected: `pb.exiting` re-sends the close every pass
   until the book is flat. Pin in Task 5 ("exit latch re-sends until flat").
3. **Restart mid-trade.** The `pb` state round-trips through `hydratePlaybookState`
   with the trade intact, and an empty ring disables only the index-based stops.
   Pin in Tasks 1 and 5.
4. **Wrong contract.** An expiry preset given a non-expiry contract, for example by a
   hand-registered row. Expected: no entry, the mismatch journalled, exits still
   running. Pin in Task 5.
5. **Parity forward on a degenerate chain.** Fewer than 3 valid strikes, one outlier
   strike, or a stale wing. Expected: the median is robust, the sanity band rejects,
   and the fallback is `index-carry`. Pin in Task 1 (`forward.ts`) and Task 6 (chain
   view).

---

## Waves and ownership

| Wave | Task | Owner model | Depends on | Suites the task runs |
|---|---|---|---|---|
| 1 | 1 Engine foundation | Opus | — | `packages/desk-engine` |
| 1 | 2 Paper touch fills | Sonnet | — | `packages/brokers`, `apps/order-gateway` |
| 1 | 3 Expiry buffer on the decision path | Sonnet | — | `apps/api` (`decision-plan`, `marketable`, `service`) |
| 1 | 4 Scenario simulator | Opus | — (codes against `decideDeltaLean`'s signature) | `packages/desk-engine` (its own files) |
| 2 | 5 Playbook frame and kit | Opus | 1 | `packages/desk-engine` |
| 2 | 6 Supervisor wiring and parity forward | Opus | 1 | `apps/supervisor` |
| 2 | 7 Roll and registration | Opus | 1 | `apps/api` (roll and registration suites only) |
| 2 | 8 Web: dials and trigger label | Sonnet | 1 | `apps/web` |
| 3 | 9 Trend Drive + Expiry Drive | Opus | 4, 5 | `packages/desk-engine` |
| 3 | 10 Wing Straddle + Expiry Theta Fly | Opus | 4, 5 | `packages/desk-engine` |
| 3 | 11 Reversal Spread + Expiry Gamma Breakout | Opus | 4, 5 | `packages/desk-engine` |
| 4 | 12 Runbook and review report | Sonnet | 1-11 | — |
| 4 | 13 Integration, review, ship | main session | all | `make check`, web `tsc -b` |

Each task works in its own git worktree on its own branch, cut from `master` (wave 1) or
from the integration branch `playbooks` (waves 2-3). Each task ends with its own commit.
The main session merges each finished task into `playbooks`.

---

### Task 1: Engine foundation

**Files:**
- Modify: `packages/desk-engine/src/dials.ts`: the `pb_*` fields, their defaults, and a
  `DIAL_SECTIONS` entry `playbook`.
- Modify: `packages/desk-engine/src/presets.ts`: six presets.
- Modify: `packages/desk-engine/src/types.ts`: `PlaybookState`, `EMPTY_PLAYBOOK_STATE`,
  `RuleState.pb`, and `'dl-exit'` in `TRIGGERS`.
- Modify: `packages/desk-engine/src/delta-lean/lean.ts`: `rollDay` resets `pb` on a new
  date.
- Modify: `packages/desk-engine/src/delta-lean/regime.ts`: `SpotRing.latest()` and
  `SpotRing.range()`.
- Modify: `packages/desk-engine/src/delta-lean/decide.ts`: add `export` to `hold`,
  `wait`, `acted`, `closeAll`, `exitDecision`, `pace`, `projectFits`, `fitLots`,
  `scaleLots`, `confirmed`, `inr`, `clock` and `prevRegime`. No behaviour change.
- Create: `packages/desk-engine/src/forward.ts`: `parityForward` and `carryForward`.
- Create: `packages/desk-engine/src/delta-lean/playbook/state.ts`: `hydratePlaybookState`.
- Create: `packages/desk-engine/src/delta-lean/playbook/types.ts`: the playbook
  interfaces, exactly as below.
- Create: `packages/desk-engine/src/delta-lean/playbook/decide.ts`: a stub
  `decidePlaybook` that holds. Task 5 replaces its body.
- Modify: `packages/desk-engine/src/index.ts`: export the new modules.
- Tests:
  - modify `packages/desk-engine/test/dials.test.ts`, `delta-lean-dials.test.ts`,
    `presets.test.ts`, `types.test.ts`, `delta-lean-regime.test.ts`;
  - create `packages/desk-engine/test/forward.test.ts` and
    `packages/desk-engine/test/playbook-state.test.ts`.

**Interfaces produced (exact; every later task codes against these):**

```ts
// types.ts — beside RuleState
export interface PlaybookState {
  readonly dayOpen: number;        // first index sample at/after 09:15:00; 0 = none
  readonly dayHigh: number;        // 0 = none
  readonly dayLow: number;         // 0 = none
  readonly statsFromMs: number;    // epoch ms of the first folded sample; 0 = none
  readonly statsLastMs: number;    // epoch ms of the newest folded sample; 0 = none
  readonly dayImplied: number;     // Dday (spec §4.2); 0 = not frozen
  readonly entries: number;        // trades opened today
  readonly tradeOpenMs: number;    // 0 = no trade
  readonly side: 'up' | 'down' | 'none' | '';
  readonly stage: number;          // 1 = protective legs routed, shorts pending; 0 otherwise
  readonly planShorts: ReadonlyArray<{ readonly strike: number; readonly optType: OptType }>;
  readonly planLots: number;
  readonly planAdd: boolean;
  readonly stageMs: number;
  readonly stageSpot: number;      // chain forward when stage 1 routed
  readonly entrySpot: number;      // index level when the trade opened
  readonly entryStr: number;       // ATM straddle when the trade opened
  readonly entryExtreme: number;   // Reversal: the faded extreme
  readonly boxHi: number;          // Gamma: the box broken
  readonly boxLo: number;
  readonly basePnl: number;        // totalPnl when the trade began
  readonly peakPnl: number;
  readonly trailArmed: boolean;
  readonly adds: number;
  readonly condSinceMs: number;    // index-stop debounce; 0 = condition off
  readonly exiting: boolean;
  readonly exitReason: string;     // '' unless exiting
  readonly exitUrgency: 'passive' | 'urgent' | 'ladder' | '';
  readonly doneForDay: boolean;
  readonly lastExitMs: number;     // 0 = never
}
export const EMPTY_PLAYBOOK_STATE: PlaybookState = {
  dayOpen: 0, dayHigh: 0, dayLow: 0, statsFromMs: 0, statsLastMs: 0, dayImplied: 0,
  entries: 0, tradeOpenMs: 0, side: '', stage: 0, planShorts: [], planLots: 0, planAdd: false,
  stageMs: 0, stageSpot: 0, entrySpot: 0, entryStr: 0, entryExtreme: 0, boxHi: 0, boxLo: 0,
  basePnl: 0, peakPnl: 0, trailArmed: false, adds: 0, condSinceMs: 0,
  exiting: false, exitReason: '', exitUrgency: '', doneForDay: false, lastExitMs: 0,
};
// RuleState gains, LAST:  readonly pb: PlaybookState;
// EMPTY_RULE_STATE gains, LAST:  pb: EMPTY_PLAYBOOK_STATE,
// TRIGGERS gains 'dl-exit' after 'dl-stuck'.
```

```ts
// regime.ts — SpotRing
latest(): SpotSample | null
range(fromMs: number, toMs: number): {
  readonly hi: number; readonly lo: number; readonly first: number; readonly last: number;
  readonly firstMs: number; readonly lastMs: number; readonly samples: number; readonly spanMs: number;
} | null   // samples with fromMs <= ms <= toMs; null when none or fromMs > toMs
```

```ts
// forward.ts — pure
export const PARITY_STRIKES = 6;
export const PARITY_MIN_STRIKES = 3;
export const PARITY_QUOTE_AGE_MS = 10_000;
export interface ForwardInput {
  readonly strikes: ReadonlyArray<StrikeQuote>;
  readonly index: number;           // > 0
  readonly step: number;            // > 0
  readonly nowMs: number;
  readonly dateIst: string;
  readonly expiry: string;
  readonly minuteOfDay: number;
}
export interface ForwardRead { readonly forward: number; readonly strikesUsed: number }
export function parityForward(input: ForwardInput): ForwardRead | null;
export function carryForward(index: number, dateIst: string, expiry: string, minuteOfDay: number): number;
```

```ts
// delta-lean/playbook/state.ts
export function hydratePlaybookState(raw: unknown): PlaybookState;
```

```ts
// delta-lean/playbook/types.ts
import type { Dials } from '../../dials.ts';
import type { DeltaLeanInputs } from '../decide.ts';
import type { Regime, RegimeRead } from '../regime.ts';
import type { EngineAction, PlaybookState, RuleState, Urgency } from '../../types.ts';

export type OpenAction = Extract<EngineAction, { op: 'open' }>;

export interface PlaybookCtx {
  readonly inputs: DeltaLeanInputs;
  readonly dials: Dials;
  readonly st: RuleState;          // rolled, folded, regime-stamped
  readonly pb: PlaybookState;      // === st.pb, after this pass's peak/trail bookkeeping
  readonly read: RegimeRead;
  readonly regime: Regime;         // read.slow
  readonly regimeHeldMs: number;   // nowMs - st.dlRegimeSinceMs; 0 when unstamped
  readonly spot: number | null;    // ring.latest()?.spot
  readonly spotFresh: boolean;     // spot !== null && nowMs - spotAsOf <= dl_spot_stale_s*1000
  readonly fwd: number;            // inputs.chain.spot
  readonly str: number | null;     // atmStraddleMid(chain)
  readonly imp: (minutes: number) => number | null;  // impliedWindowMove(str, MTE, minutes*60)
  readonly dayComplete: boolean;
  readonly dayImplied: number | null;   // pb.dayImplied > 0 ? pb.dayImplied : null
  readonly totalPnl: number;
  readonly tradePnl: number;       // pb.tradeOpenMs > 0 ? totalPnl - pb.basePnl : 0
  readonly cost: number;           // Σ (Buy ? +1 : -1) * entry * lots * lotSize over held legs
  readonly expiryDay: boolean;     // chain.expiry === dateIst
  readonly nowMs: number;
  readonly minuteOfDay: number;
}

export interface OpenPlan {
  readonly side: 'up' | 'down' | 'none';
  readonly protective: readonly OpenAction[];  // Buys, lots: 1 each (the frame scales)
  readonly shorts: readonly OpenAction[];      // Sells, lots: 1 each; [] = single stage
  readonly lots: number;                       // wanted lots per leg; the frame truncates to the cap
  readonly reason: string;
  readonly stamps?: Partial<Pick<PlaybookState, 'entryStr' | 'entryExtreme' | 'boxHi' | 'boxLo'>>;
}

export type EntryVerdict =
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'open'; readonly plan: OpenPlan };

export interface PlaybookStep {
  readonly exit?: { readonly reason: string; readonly urgency: Urgency; readonly final: boolean };
  readonly add?: OpenPlan;
  readonly patch?: Partial<PlaybookState>;   // bookkeeping to persist (e.g. condSinceMs)
  readonly note?: string;                    // the hold reason when nothing fires
}

export interface Playbook {
  readonly id: number;      // pb_playbook
  readonly name: string;    // 'trend-drive' | 'wing-straddle' | 'reversal' | 'expiry-drive' | 'expiry-theta' | 'expiry-gamma'
  enter(ctx: PlaybookCtx): EntryVerdict;
  /** The playbook's OWN exits (stops and profit exits); the frame has run the hard stop. */
  exits(ctx: PlaybookCtx): PlaybookStep;
  /** Pyramid adds; return {} for none. Called only after no exit fired. */
  adds(ctx: PlaybookCtx): PlaybookStep;
}
```

```ts
// delta-lean/playbook/decide.ts (stub in Task 1; the real frame in Task 5)
export function decidePlaybook(
  inputs: DeltaLeanInputs, dials: Dials, state: RuleState, markCtx: MarkContext,
): EngineDecision  // Task 1: returns hold('playbook engine not built', state)
```

- [ ] **Step 1: Write the failing tests.**
  - `forward.test.ts`:
    - a clean synthetic chain (index 23,000, 3-DTE, call and put mids from Black-76 at
      F = 23,020) returns 23,020 ±1 with `strikesUsed` 6;
    - one strike with a CE mid off by +40 does not move the median by more than 2;
    - only 2 valid strikes → null;
    - a CE quote older than 10 s at a strike excludes that strike;
    - a parity value 1% from the index → null (sanity band);
    - `carryForward(23000, '2026-10-16', '2026-10-19', 600)` equals
      `23000 * Math.exp(0.065 * 3/365)` to 1e-9.
  - `playbook-state.test.ts`:
    - `hydratePlaybookState(undefined)` deep-equals `EMPTY_PLAYBOOK_STATE`;
    - a full state round-trips through `JSON.parse(JSON.stringify(x))` then the
      hydrator;
    - a malformed `planShorts` entry is dropped, not zero-filled;
    - a wrong-type field falls back to its zero;
    - `side: 'sideways'` → `''`;
    - `exitUrgency: 'fast'` → `''`.
  - `types.test.ts`: the `EMPTY_RULE_STATE` deep-equal pin gains `pb`, and
    `TRIGGERS` contains `dl-exit`.
  - `delta-lean-regime.test.ts`:
    - `latest()` is null on an empty ring and the newest sample after pushes;
    - `range()` on a known sequence returns hi/lo/first/last/firstMs/lastMs/samples,
      null for an empty interval, and null when `fromMs > toMs`;
    - `range` still works after the ring wraps.
  - `dials.test.ts` / `delta-lean-dials.test.ts`:
    - every `pb_*` dial is in exactly one section (`playbook`) and its defaults match
      spec §8.1;
    - `resolveDials({ pb_playbook: 3 })` resolves with no unknowns;
    - the delta-lean section's pinned list is unchanged.
  - `presets.test.ts`:
    - the preset count goes from 17 to 23;
    - each of the six new presets resolves with no unknowns and carries
      `delta_lean_enabled: true`, `dl_open_lots: 0` and its `pb_playbook` (1-6), plus
      the exact values in spec §8.2;
    - `delta_shorts_only: false` and `gamma_shorts_only: false` (inherited from
      `DELTA_LEAN_BASE`).
  - A lean test: `rollDay` on a new date returns `pb` equal to `EMPTY_PLAYBOOK_STATE`,
    and on the same date returns the same object.
  - A fail-safe test in `delta-lean-decide.test.ts`: under `decideDeltaLean`, a
    `trend-up` confirmed regime with dials resolved from `pb-trend-drive` minus every
    `pb_*` key (simulating an old build) never emits a `dl-open`.

- [ ] **Step 2: Run them.** `node --test packages/desk-engine/test/*.test.ts`. Expected:
  the new tests FAIL; all others PASS.

- [ ] **Step 3: Implement.**
  - **`dials.ts`:** add the 43 fields of spec §8.1 to `interface Dials` (after
    `dl_hold_to_expiry`) and to `DEFAULT_DIALS`, with exactly the spec defaults.
    Append a section after `delta-lean`:
    `{ key: 'playbook', label: 'Playbook', collapsed: true, fields: [...every pb_* key in §8.1 order] }`.
    It has no toggle; `pb_playbook` 0 is the off-state, and the header comment must
    say so. Update the file header's list of numeric off-states to name `pb_playbook` 0.
  - **`presets.ts`:** define `PLAYBOOK_BASE = { ...DELTA_LEAN_BASE, dl_open_lots: 0 }`,
    then the six presets `pb-trend-drive`, `pb-wing-straddle`, `pb-reversal`,
    `pb-expiry-drive`, `pb-expiry-theta` and `pb-expiry-gamma`, each
    `{ ...PLAYBOOK_BASE, pb_playbook: N, ...values }` with every value in spec §8.2's
    column. Labels: `Playbook — Trend Drive`, `Playbook — Wing Straddle`,
    `Playbook — Reversal Spread`, `Playbook — Expiry Drive`,
    `Playbook — Expiry Theta Fly`, `Playbook — Expiry Gamma Breakout`.
    Fix the header's stale "twelve presets".
  - **`types.ts`:** as in the interfaces block. Document `pb` the way the `dl*`
    fields are documented: one row, the playbook path's alone, required.
  - **`lean.ts` `rollDay`:** on a new date add `pb: EMPTY_PLAYBOOK_STATE` to the
    returned object, and update the docstring.
  - **`regime.ts`:** implement `latest()` (the newest written sample) and `range()`,
    walking back from the newest sample until one is older than `fromMs`. Samples are
    pushed in time order; skip `ms > toMs`.
  - **`forward.ts`:**
    - candidates = the `PARITY_STRIKES` rows nearest `index` (ties to the lower strike);
    - keep a row iff both wings are non-null, `bid` and `ask` are non-null, `ask > bid`,
      `nowMs - asOf <= PARITY_QUOTE_AGE_MS` for both, and each spread is ≤ max(0.03 × mid, 2);
    - `F_K = K + (cMid - pMid) * Math.exp(RISK_FREE * yearFrac(dateIst, expiry, minuteOfDay))`;
    - fewer than `PARITY_MIN_STRIKES` → null;
    - median (mean of the middle two for an even count);
    - reject when `Math.abs(F - index) > Math.max(0.006 * index, 2 * step)`;
    - non-finite input anywhere → null.
    - `carryForward = index * Math.exp(RISK_FREE * yearFrac(...))`.
    - Import `RISK_FREE`, `yearFrac` and `midOf` from `marking.ts`.
  - **`playbook/state.ts`:** a field-by-field hydrator in the style of
    `apps/supervisor/src/state-store.ts:319-366` (`num`/`str`/`bool` with fallbacks),
    with the `side` and `exitUrgency` enums validated and `planShorts` entries filtered
    to `{strike: finite number, optType: 'CE'|'PE'}`. Return keys in
    `EMPTY_PLAYBOOK_STATE` order, so `JSON.stringify` equality is stable.
  - **`playbook/types.ts`:** verbatim from the interfaces block.
  - **`playbook/decide.ts`:** the stub, with a docstring that points at the spec.
  - **`index.ts`:** export `./forward.ts`, `./delta-lean/playbook/types.ts`,
    `./delta-lean/playbook/state.ts` and `./delta-lean/playbook/decide.ts`.

- [ ] **Step 4: Run** `node --test packages/desk-engine/test/*.test.ts` and
  `npx tsc --noEmit -p tsconfig.json` from the repo root. Expected: all PASS, no type
  errors. If a root typecheck error appears in `apps/supervisor`, `apps/api` or
  `apps/web` because `RuleState` gained `pb`, fix it minimally:
  - `apps/supervisor/src/state-store.ts` `hydrateRuleState` gains
    `pb: hydratePlaybookState(d['pb'])`;
  - test fixtures that build a `RuleState` literal gain `pb: EMPTY_PLAYBOOK_STATE`.

  Run `node --test apps/supervisor/test/state-store.test.ts` after that edit.

- [ ] **Step 5: Commit.**
  `git commit -m "feat(engine): playbook foundation — pb_* dials and six presets (inert, dl_open_lots 0), RuleState.pb with its hydrator, dl-exit trigger, SpotRing.latest/range, parity forward helper, decidePlaybook stub"`

---

### Task 2: Paper fills on the touch (spec F2)

**Files:**
- Modify: `packages/brokers/src/simulator.ts`
- Modify: `apps/order-gateway/src/main.ts` (`tickFanout`)
- Tests: `packages/brokers/test/simulator*.test.ts` (extend the existing file) and the
  gateway test that covers `tickFanout` (find it with `grep -rn tickFanout apps/order-gateway/test`).

**Interfaces:**
- Produces: `SimulatorAdapter.feedTick(token: number, price: number, quote?: { readonly bid: number | null; readonly ask: number | null }): void`.
  `tickFanout`'s `sims` element type becomes
  `{ feedTick(token: number, price: number, quote?: { bid: number | null; ask: number | null }): void }`.

- [ ] **Step 1: Failing tests.**
  - A resting BUY LIMIT 105 fills at 101 when a tick arrives with `ask` 101 (price
    103, no trade-through).
  - A resting SELL LIMIT 100 fills at 102 on `bid` 102.
  - A BUY LIMIT 100 does not fill on `ask` 100.5 with price 100.2. Neither rule fires.
  - A BUY LIMIT 100 still fills at 99.5 on a trade-through tick with no quote (the old
    rule).
  - `SL_MARKET` and `SL_LIMIT` behaviour is unchanged by a quote.
  - A quote with `bid: null` does not trigger a sell-touch fill.
  - `tickFanout` passes `{bid, ask}` when the frame carries finite positive numbers
    for both, and omits the quote otherwise.
- [ ] **Step 2: Run.** `node --test packages/brokers/test/*.test.ts apps/order-gateway/test/*.test.ts`.
  Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Keep `#last`. Add `#touch: Map<number, {bid: number|null; ask: number|null}>`.
  - In `feedTick`, for a resting LIMIT:
    - BUY fills when `ask !== null && ask <= trigger` (at `ask`), else when
      `price < trigger` (at `price`);
    - SELL fills when `bid !== null && bid >= trigger` (at `bid`), else when
      `price > trigger`.
  - SL orders keep `#crosses` exactly.
  - Update the comment above `#crosses`: a marketable limit takes the touch, and a
    through-print still fills.
  - In `tickFanout`, read `f['bid']` and `f['ask']` and forward them when both are
    finite and > 0.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "fix(brokers): paper limits fill on the touch — a marketable limit takes the ask/bid instead of resting until a print trades through it (the 1 Oct stranded hedge); the gateway forwards md.tick's bid/ask"`

---

### Task 3: The expiry-day buffer on the decision path (spec F3)

**Files:**
- Modify: `apps/api/src/decision-plan.ts` (`marketableFallback`, `priceFillsForRoute`).
- Modify: `apps/api/src/service.ts` (`applyDecision`, at the `priceFillsForRoute` call
  near line 797).
- Tests: the existing suites that cover `priceFillsForRoute`/`marketableFallback`
  (find them with `grep -rln "priceFillsForRoute\|marketableFallback" apps/api/test`),
  plus one `applyDecision` test.

**Interfaces:**
- `marketableFallback(fill, marketable, expiresToday = false)`.
- `priceFillsForRoute(fills, pricing, marketable, expiresToday = false)`. Thread the
  flag into every `marketableFallback` call.

- [ ] **Step 1: Failing tests.**
  - An unpriced MARKET fill with `expiresToday: true` and `expiryBufferPct: 0.10`
    gets a limit 10% through the mark.
  - With `false`, 2%.
  - `applyDecision` with `via: 'engine'`, `action: 'dl-exit'` and
    `expiry === istDate(now)` prices at 10%.
  - The same with `action: 'shed'` (recenter) prices at 2%.
  - The same with `action: 'dl-open'` and tomorrow's expiry prices at 2%.
- [ ] **Step 2: Run.** `DESK_REQUIRE_MONGO=1 node --test` on the files found above.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `applyDecision`:
    `const expiresToday = req.via === 'engine' && typeof req.action === 'string' && req.action.startsWith('dl-') && req.expiry === istDate(<the service's clock now>)`.
    Use the same IST helper `submit.ts` uses.
  - Pass it through.
  - Update the comment in `marketable.ts:40-48`: the engine path now asserts for the
    delta-lean family only.
  - Confirm `expiryBufferPct` is set on the bridge service's config (`main.ts`). If it
    is read only for the submit service, read it once in the shared config function, as
    the existing comment insists.
- [ ] **Step 4: Run the same tests.** Expected: PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "fix(api): engine decisions from the delta-lean family get the expiry-day marketable buffer on a contract expiring today; recenter pricing unchanged"`

---

### Task 4: The scenario simulator (test-only; spec §9.2)

**Files:**
- Create: `packages/desk-engine/test/scenario/chain-model.ts`
- Create: `packages/desk-engine/test/scenario/paths.ts`
- Create: `packages/desk-engine/test/scenario/sim.ts`
- Create: `packages/desk-engine/test/scenario-sim.test.ts`, the harness's own tests,
  run against `decideDeltaLean`.

**Interfaces produced (exact):**

```ts
// paths.ts
export interface Segment {
  readonly minutes: number;     // length of the segment
  readonly drift: number;       // index points added over the segment (linear)
  readonly noise: number;       // Gaussian noise, points per sqrt(minute)
  readonly ivTo?: number;       // ATM IV at the END of the segment (linear ramp); default: unchanged
}
export interface ScenarioSpec {
  readonly name: string;
  readonly symbol: 'NIFTY' | 'SENSEX';
  readonly dateIst: string;     // must be an NSE trading day
  readonly expiry: string;      // >= dateIst; === dateIst for 0-DTE
  readonly open: number;        // index at 09:15:00
  readonly baseIv: number;      // ATM IV at 09:15 (e.g. 0.12)
  readonly segments: readonly Segment[];   // consecutive from 09:15; the path holds flat after the last
  readonly seed: number;
  readonly holes?: ReadonlyArray<{ readonly fromMin: number; readonly toMin: number }>;  // no index ticks
  readonly quoteFreezes?: ReadonlyArray<{ readonly fromMin: number; readonly toMin: number }>; // option quotes stop updating
  readonly spikes?: ReadonlyArray<{ readonly atMin: number; readonly pts: number }>;   // one bad print
  readonly startMin?: number;   // first pass, IST minute (default 555)
  readonly endMin?: number;     // last pass (default 905 = 15:05)
}
export function indexPath(spec: ScenarioSpec): (ms: number) => number;   // deterministic
export function ivPath(spec: ScenarioSpec): (ms: number) => number;
```

```ts
// chain-model.ts
export const LOT: Record<'NIFTY' | 'SENSEX', number>;   // 65, 20
export const STEP: Record<'NIFTY' | 'SENSEX', number>;  // 50, 100
export function buildChain(args: {
  symbol: 'NIFTY' | 'SENSEX'; expiry: string; dateIst: string; minuteOfDay: number;
  index: number; atmIv: number; nowMs: number; quoteAsOf?: number;
}): ChainSnap;
// Forward = index * exp(r*T); strikes = ATM ± 25 steps.
// IV(K) = atmIv * (1 + 0.8 * max(0, ln(F/K)) + 0.2 * max(0, ln(K/F)))   (put skew)
// Price = Black-76 (packages/greeks); mid floored at 0.05.
// Half-spread = max(0.05, 0.004 * mid), and 2x beyond 10 steps from ATM; ticks of 0.05.
// ltp = mid. asOf = quoteAsOf ?? nowMs.
export function impliedMove(chain: ChainSnap, minutesToExpiry: number, windowMin: number): number;
```

```ts
// sim.ts
export type DecideFn = (inputs: DeltaLeanInputs, dials: Dials, state: RuleState, markCtx: MarkContext) => EngineDecision;
export interface SimTrade {
  readonly openMin: number; readonly closeMin: number | null;
  readonly openTrigger: Trigger; readonly closeTrigger: Trigger | null; readonly closeReason: string;
  readonly side: string;        // pb.side at the open ('' for non-playbook decide fns)
  readonly pnl: number;         // realised over the round trip (flat -> holding -> flat)
}
export interface SimResult {
  readonly decisions: ReadonlyArray<{ readonly minute: number; readonly trigger: Trigger; readonly reason: string; readonly actions: readonly EngineAction[] }>;
  readonly trades: readonly SimTrade[];
  readonly finalPnl: number; readonly minPnl: number; readonly maxPnl: number;
  readonly orders: number;
  readonly nakedShortPasses: number;   // passes where a short leg had no same-type long further OTM held
  readonly finalState: RuleState;
}
export function runSession(decide: DecideFn, dials: Dials, spec: ScenarioSpec): SimResult;
export function minutesToExpiry(dateIst: string, minuteOfDay: number, expiry: string): number; // trading minutes, isTradingDay-aware
```

Driver rules:
- Clock from `startMin` to `endMin`.
- Push an index sample into a `SpotRing(32_768)` every 2 s, except inside holes. A
  spike replaces one sample.
- Every 4 s:
  - build the chain;
  - mark the legs with `markLeg` (pricing `'live'`);
  - build `DeltaLeanInputs`: `mode 'paper'`, `dte` in calendar days, `cumRealized`
    from the closed round trips, `pendingLots 0`, `repairHold false`, `margin` as a
    model figure, `ordersThisMinute` counted, `spotAsOf` the last pushed sample's ms,
    `expiry`;
  - call `decide`;
  - persist `decision.actions.length > 0 ? stateAfter : markState`;
  - fill every action at once at the current chain's touch: buy at the ask, sell at
    the bid; an `open` adds to or reduces the same instrument's position, and a
    `close` removes it;
  - stop the session at `endMin`.
- Record a trade on every flat → holding → flat transition.
- The naked-short check runs after every pass's fills.

- [ ] **Step 1: Write `scenario-sim.test.ts`.**
  - `indexPath` is deterministic for a seed.
  - A spike changes exactly one sample.
  - `buildChain` put-call parity holds at every strike to 0.1.
  - `impliedMove` scales as √window.
  - Under `decideDeltaLean` with `delta-lean-conservative` dials, a scenario of
    three 5-minute up-bursts of 3 × `impliedMove(5)` starting 09:31 produces a
    `dl-open` before 09:45, and the run ends flat by 15:00 with
    `nakedShortPasses === 0` on the open package.
  - A flat noise-only day produces no `dl-open` before 09:30.
- [ ] **Step 2: Run** `node --test packages/desk-engine/test/scenario-sim.test.ts`.
  Expected: FAIL (the modules are missing).
- [ ] **Step 3: Implement** the three modules. Keep each under 400 lines. Use a seeded
  PRNG (mulberry32) and Box-Muller.
- [ ] **Step 4: Run.** Expected: PASS, in under 20 s.
- [ ] **Step 5: Commit.**
  `git commit -m "test(engine): scenario simulator — seeded index paths with gaps, holes and spikes, a Black-76 chain with skew and spreads, touch fills, and a session driver for any decide function"`

---

### Task 5: The playbook frame and kit (spec §4)

**Files:**
- Modify: `packages/desk-engine/src/delta-lean/playbook/decide.ts`, the frame. Replace
  the stub.
- Create: `packages/desk-engine/src/delta-lean/playbook/kit.ts`, the strike and
  structure helpers.
- Create: `packages/desk-engine/src/delta-lean/playbook/session.ts`, the session fold.
- Create: `packages/desk-engine/src/delta-lean/playbook/registry.ts`,
  `PLAYBOOKS: ReadonlyMap<number, Playbook>`.
- Create four stub modules that Tasks 9-11 replace, each exporting the named
  `Playbook`s with `enter → {kind:'wait', reason:'<name>: not implemented'}`,
  `exits → {}` and `adds → {}`:
  - `trend-spread.ts` (`TREND_DRIVE` id 1, `EXPIRY_DRIVE` id 4);
  - `theta-fly.ts` (`WING_STRADDLE` 2, `EXPIRY_THETA` 5);
  - `reversal-spread.ts` (`REVERSAL` 3);
  - `gamma-breakout.ts` (`EXPIRY_GAMMA` 6).
- Test: `packages/desk-engine/test/playbook-frame.test.ts` and
  `packages/desk-engine/test/playbook-kit.test.ts`.

**Interfaces produced:**

```ts
// session.ts
export function sessionOpenMs(dateIst: string): number;   // 09:15:00 IST as epoch ms
export function foldSession(pb: PlaybookState, inputs: DeltaLeanInputs, minutesToExpiry: number, str: number | null): PlaybookState;
// Before sessionOpenMs → unchanged.
// r = ring.range(max(pb.statsLastMs + 1, openMs), nowMs). When r is present:
//   dayOpen  = pb.dayOpen  || r.first
//   dayHigh  = max(pb.dayHigh || r.hi, r.hi)
//   dayLow   = min(pb.dayLow  || r.lo, r.lo)
//   statsFromMs = pb.statsFromMs || r.firstMs
//   statsLastMs = r.lastMs
// dayImplied: when pb.dayImplied === 0, minuteOfDay >= 556, str > 0 and MTE > 0:
//   str * sqrt(min(375, MTE) / MTE)
// Returns the SAME object when nothing changed.
export function dayComplete(pb: PlaybookState, dateIst: string): boolean; // statsFromMs > 0 && statsFromMs <= sessionOpenMs + 60_000
```

```ts
// kit.ts — all pure
export function atmOf(chain: ChainSnap): number | null;                       // strike nearest chain.spot (ties → lower)
export function liquidWing(chain: ChainSnap, strike: number, optType: OptType, dials: Dials): boolean; // per-wing test, spec §4.6
export function listedBeyond(chain: ChainSnap, from: number, dir: 1 | -1, minDistance: number): number | null; // first listed strike with dir*(K - from) >= minDistance
export function stepsFrom(chain: ChainSnap, from: number, steps: number): number | null;  // from + steps*chain.step if listed
export function heldOpposite(legs: readonly LegView[], strike: number, optType: OptType, side: Side): boolean;
export function heldSame(legs: readonly LegView[], strike: number, optType: OptType, side: Side): boolean;
export function openOf(strike: number, optType: OptType, side: Side, legs: readonly LegView[]): OpenAction; // lots 1; add:true when heldSame
export function debitByBands(ctx: PlaybookCtx, side: 'up' | 'down'): { protective: OpenAction[]; shorts: OpenAction[] } | null;
//   delta-lean bands via deltaBandStrike with accept = !heldOpposite; short strictly further OTM than the long; both liquidWing
export function debitByStraddle(ctx: PlaybookCtx, side: 'up' | 'down'): { protective: OpenAction[]; shorts: OpenAction[] } | null;
//   long = atmOf; short = listedBeyond(long, dir, max(step, pb_short_str_k * str)); both liquidWing
export function flyPlan(ctx: PlaybookCtx): { centre: number; protective: OpenAction[]; shorts: OpenAction[] } | null;
//   centre = atmOf; w = max(pb_wing_min_steps, round(pb_wing_str_k * str / step)) steps; wings CE centre+w, PE centre-w; shorts CE+PE at centre; all liquidWing
export function held(ctx: PlaybookCtx, active: boolean, holdS: number): { fire: boolean; patch: Partial<PlaybookState> };
//   debounce on pb.condSinceMs: inactive → {fire:false, patch:{condSinceMs:0}}; first active → stamp now; fire when now - since >= holdS*1000
export function windowRange(ctx: PlaybookCtx, fromMs: number, toMs: number, minCoverage = 0.9): { hi: number; lo: number } | null;
//   ring.range with spanMs >= minCoverage * (toMs - fromMs) and samples >= 8, else null
export function shortsValue(legs: readonly LegView[]): { now: number; entry: number } | null;
//   Σ over Sell legs: ask × qty (now) and entry × qty (entry); null if any short has no ask
export function trendSide(regime: Regime): 'up' | 'down' | null;
```

```ts
// decide.ts — the frame
export function decidePlaybook(inputs: DeltaLeanInputs, dials: Dials, state: RuleState, markCtx: MarkContext): EngineDecision;
```

**Frame algorithm.** Implement spec §4.3 exactly. Reuse decide.ts's exported helpers.

```text
0  rolled = rollDay(state, dateIst, nowMs, false)
1  if rolled.dlStopped → exitDecision(inputs,'dl-stop','stopped for the day','urgent',rolled,false)
2  clock: identical to decideDeltaLean step 2 with clockRuns = true (use exitDecision, latchWhenFlat true)
3  pnl = totalPnl(inputs); pnl <= -dl_day_max_loss → exitDecision(...,'dl-stop',`day backstop …`,'urgent',rolled,false)
4  pnl >= dl_day_target → exitDecision(...,'dl-target',`day target …`,'ladder',rolled,false)
5  str = atmStraddleMid(chain); mte = inputs.minutesToExpiry
   pb1 = foldSession(rolled.pb, inputs, mte, str)
   read = readRegime(ring, chain, nowMs, mte, dials, prevRegime(rolled), rolled.dlRegimeSinceMs || null)
   st = regime stamp as decideDeltaLean (restamp dlRegimeSinceMs only on a change), with pb: pb1
   playbook = PLAYBOOKS.get(dials.pb_playbook); undefined → hold(`pb_playbook ${n} names no playbook`, st)
   ctx = build PlaybookCtx (types.ts definitions)
6  if pb.exiting:
     legs > 0 → pbExit(ctx, pb.exitReason, pb.exitUrgency || 'urgent', false)   // re-send; already latched
     pendingLots > 0 → hold('exit working', st)
     else → finishTrade(ctx)
7  if pb.stage === 1 && pendingLots === 0:
     legs === 0 → finishTrade(ctx)   (stage 1 never filled, or refused after routing)
     else → stageTwo(ctx)
8  if legs > 0:
     pb.tradeOpenMs === 0 → pbExit(ctx,'legs this playbook did not open','urgent',false)
     bookkeeping: peak = max(pb.peakPnl, tradePnl); armAt = minute >= pb_late_min ? pb_late_trail_start : pb_trail_start;
                  trailArmed = pb.trailArmed || (armAt > 0 && tradePnl >= armAt)
     ctx2 = ctx with pb updated
     tradePnl <= -pb_trade_max_loss → pbExit(ctx2,'hard stop …','urgent',false)
     own = playbook.exits(ctx2); own.exit → pbExit(ctx2 + own.patch, own.exit.reason, own.exit.urgency, own.exit.final)
     trailArmed && tradePnl <= pb_trail_keep * peak → pbExit(...,'trailing floor …','urgent',false)
     pb_trade_target > 0 && tradePnl >= pb_trade_target → pbExit(...,'take profit …','passive',false)
     pb_time_exit_min > 0 && minute >= pb_time_exit_min → pbExit(...,'time exit …','passive',true)
     if pendingLots === 0 and spot fresh: add = playbook.adds(ctx2); add.add → stageOne(ctx2 + add.patch, add.add, 'dl-add')
     → hold(own.note ?? 'holding', {...st, pb: {...pb2, ...own.patch, ...add.patch}})
9  if pb.tradeOpenMs > 0 && pendingLots === 0 → finishTrade(ctx)   (flat with a trade open)
10 gates (spec §4.3 step 10), each a hold whose reason names the gate; the contract check reads inputs.dte and chain.expiry
11 v = playbook.enter(ctx); wait → hold(v.reason, st); open → stageOne(ctx, v.plan, 'dl-open')

stageOne(ctx, plan, trigger):
  unit = [...plan.protective, ...plan.shorts]   (each lots 1)
  lots = fitLots(inputs, dials, unit, plan.lots); 0 → hold('… does not fit the margin cap')
  send = scaleLots(plan.protective.length > 0 ? plan.protective : plan.shorts, lots)
  pace(send) shorter than send → hold('… [order budget]')
  pbAfter = { ...pb, entries: trigger === 'dl-open' ? pb.entries + 1 : pb.entries,
              adds: trigger === 'dl-add' ? pb.adds + 1 : pb.adds,
              tradeOpenMs: trigger === 'dl-open' ? nowMs : pb.tradeOpenMs,
              side: trigger === 'dl-open' ? plan.side : pb.side,
              stage: plan.protective.length > 0 && plan.shorts.length > 0 ? 1 : 0,
              planShorts: plan.protective.length > 0 ? plan.shorts.map(({strike,optType}) => ({strike,optType})) : [],
              planLots: lots, planAdd: trigger === 'dl-add', stageMs: nowMs, stageSpot: fwd,
              ...(trigger === 'dl-open' ? { entrySpot: spot ?? fwd, entryStr: str ?? 0, basePnl: totalPnl, peakPnl: 0, trailArmed: false, condSinceMs: 0 } : {}),
              ...plan.stamps }
  → acted('adjust', trigger, `${playbook.name}: ${plan.reason} — ${send.length} leg(s) at ${lots} lot(s)…`, send, {...st, pb: pbAfter}, st, 'passive')

stageTwo(ctx):
  every planShort must be liquidWing and not heldOpposite; if not: now - stageMs > 120_000 → pbExit(...,'stage-2 abort: … not tradable','urgent',false) else hold('stage 2 waiting …')
  str === null || |fwd - stageSpot| > pb_stage_abort_k * str → pbExit(...,'stage-2 abort: the market moved …','urgent',false)
  now - stageMs > 120_000 → pbExit(...,'stage-2 abort: stale','urgent',false)
  send = planShorts.map(s => ({ ...openOf(s.strike, s.optType, 'Sell', legs), lots: planLots })); pace whole or hold
  → acted('adjust', pb.planAdd ? 'dl-add' : 'dl-open', `${name}: stage 2 — selling …`, send, {...st, pb:{...pb, stage:0, planShorts:[], planAdd:false}}, st, 'passive')

pbExit(ctx, reason, urgency, final):
  after = {...st, pb: {...pb, exiting:true, exitReason: reason, exitUrgency: urgency, doneForDay: pb.doneForDay || final, condSinceMs: 0}}
  legs === 0 → hold(`${reason} — flat already`, after)
  → acted('flatten','dl-exit', `${name}: ${reason} — closing all ${n} leg(s)`, closeAll(legs), after, after, urgency)

finishTrade(ctx):
  pbF = {...pb, exiting:false, exitReason:'', exitUrgency:'', stage:0, planShorts:[], planAdd:false, tradeOpenMs:0,
         lastExitMs: nowMs, condSinceMs:0, peakPnl:0, trailArmed:false, adds:0, basePnl:0, side: ''}
  done = pb.doneForDay || pb.entries >= pb_max_entries
  → hold(`${name}: trade finished${done ? ' — done for the day' : ''}`, {...st, dlStopped: st.dlStopped || done, pb: pbF})
```

The tests, `playbook-frame.test.ts`, use a scripted fake `Playbook` registered under
id 99 (a test-only registry override) and synthetic inputs. One test per point:

- step order (backstop beats target, clock beats a playbook exit);
- an exit latch that re-sends until flat (**review focus 2**);
- stage 2 waiting for every protective leg, then aborting at 120 s (**review focus 1**);
- stage 2 aborting when `|F − stageSpot|` exceeds 0.25 × STR;
- stage 2 using `dl-add` when `planAdd`;
- a refused stage 1 (the state rolled back to `markState`) leaving `entries`
  unchanged;
- finishing a trade with re-entry allowed, then the cooldown honoured;
- finishing at `pb_max_entries` setting `dlStopped`;
- unknown legs → `dl-exit`;
- the hard stop at exactly `−pb_trade_max_loss` firing (inclusive);
- trail arming at the late threshold from 13:00;
- the trail floor firing at `keep × peak`;
- take profit is passive;
- the time exit is final;
- each gate's hold reason: contract mismatch (expiry preset, `dte` 3), stale index,
  stale chain (`chain.asOf` 11 s old), unknown regime, outside the window, cooldown,
  working package (**review focus 4**);
- the index-based exits skipped while the index is stale (the fake playbook asserts
  `ctx.spotFresh` is false and no index exit fires);
- `pb` surviving a `JSON.stringify` → `hydratePlaybookState` round trip mid-trade,
  with the next pass identical (**review focus 3**);
- `foldSession`: open, high and low from a ring, `dayComplete` true and false, and
  `dayImplied` frozen once.

`playbook-kit.test.ts` gives every kit function a direct test on a synthetic chain:

- `liquidWing` refuses a one-sided, stale or wide quote;
- `listedBeyond` and `stepsFrom` handle the chain edge;
- `debitByBands` excludes a strike held short;
- `flyPlan` wings are at least `pb_wing_min_steps`;
- `held` stamps, fires and resets;
- `windowRange` refuses thin coverage;
- `shortsValue` is null when an ask is missing.

- [ ] **Step 1:** Write `playbook-frame.test.ts` and `playbook-kit.test.ts`. Run
  `node --test packages/desk-engine/test/playbook-*.test.ts`. Expected: FAIL.
- [ ] **Step 2:** Implement `session.ts`, `kit.ts`, `registry.ts`, the four stubs and
  the frame. Keep `decide.ts` (the frame) under 600 lines, with every rule's comment
  stating why, in the file's house style.
- [ ] **Step 3:** Run `node --test packages/desk-engine/test/*.test.ts` and the root
  `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 4: Commit.**
  `git commit -m "feat(engine): the playbook frame — day exits, session fold, exit latch, two-stage opens with abort, common exits (hard stop, trailing floor, take profit, time exit), re-entry, gates; kit helpers; registry with stub playbooks"`

---

### Task 6: Supervisor wiring and the parity forward (spec F1, F5, §4.1, §4.5)

**Files:**
- Modify: `apps/supervisor/src/chain-view.ts`. `snap(symbol, expiry, lotSize, step, opts?: { forward?: 'future' | 'parity'; nowMs?: number; dateIst?: string; minuteOfDay?: number })`
  gains the `forwardSource` getter: `'parity' | 'index-carry' | 'future' | 'proxy'`.
- Modify: `apps/supervisor/src/main.ts`:
  - pass `forward: 'parity'` for books with `delta_lean_enabled` unless
    `process.env.DESK_CHAIN_FORWARD === 'future'` (read once at boot);
  - `SPOT_RING_CAPACITY = 32_768`;
  - expose the index level the proxy uses to the chain view.
- Modify: `apps/supervisor/src/engine-host.ts`:
  - `#decide` dispatches `dials.pb_playbook > 0 ? decidePlaybook(dl, …) : decideDeltaLean(dl, …)`;
  - `DL_EXIT_TRIGGERS` gains `'dl-exit'`, and its docstring explains why.
- Modify: `apps/supervisor/src/marks-journal.ts` (and its caller) to write
  `forwardSource`.
- Modify: `apps/supervisor/src/state-store.ts`. If Task 1 did not already add
  `pb: hydratePlaybookState(d['pb'])`, add it.
- Tests: `apps/supervisor/test/chain-view*.test.ts`,
  `engine-host-delta-lean.test.ts` (the `DL_EXIT_TRIGGERS` pin at about line 634),
  `state-store.test.ts`, `main-lifecycle.test.ts` (ring capacity), and a new
  `engine-host-playbook.test.ts`.

- [ ] **Step 1: Failing tests.**
  - The chain view: a delta-lean snap with parity-consistent quotes returns `spot` ≈
    the parity forward and `forwardSource === 'parity'`, while the future quotes 300
    points higher.
  - With 2 valid strikes → `'index-carry'` with `spot = index × e^{rT}`.
  - With no index level → `'future'`.
  - A recenter snap (no opts) is unchanged: future mid, `'future'`.
  - `DESK_CHAIN_FORWARD=future` → the future for delta-lean too. Test the config
    function, not `process.env` mutation.
  - The engine host: a book with `pb_playbook: 1` calls `decidePlaybook`; this is
    spy-able through an injectable `decidePlaybook` dep, or by asserting the stub's
    hold reason. A book with `pb_playbook: 0` calls `decideDeltaLean`.
  - A `dl-exit` decision skips `confirm_ms` and pre-empts a working add. Mirror the
    existing `dl-stop` tests.
  - The state store hydrates `pb` (**review focus 3**).
- [ ] **Step 2: Run.** `node --test apps/supervisor/test/*.test.ts`. Expected: the new
  tests FAIL.
- [ ] **Step 3: Implement.**
  - In `snap`, after the strike rows are built: when `opts.forward === 'parity'` and an
    index level is fresh, call `parityForward({ strikes, index, step, nowMs, dateIst, expiry, minuteOfDay })`.
    On null, use `carryForward`. Set `spot` and `#forwardSource`. Keep `future`
    as the quoted future (the engine never reads it).
  - The clock fields come from the host's clock at snap time: pass them in opts from
    `main.ts`.
  - Comment `ChainSnap.spot` in `packages/desk-engine/src/types.ts`: "the forward
    of THIS chain's expiry (parity-implied for delta-lean books; the future mid for
    recenter books)".
- [ ] **Step 4: Run** `node --test apps/supervisor/test/*.test.ts` and the root
  `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "fix(supervisor): weekly chains are priced off their own parity forward (index×carry fallback, future last) for delta-lean-family books, DESK_CHAIN_FORWARD=future to revert; the mark journal records the source; feat: pb_playbook dispatches to decidePlaybook, dl-exit joins the fast exits, a full-session spot ring"`

---

### Task 7: The roll and registration (spec §4.9)

**Files:**
- Modify: `scripts/delta-lean-books.mjs`:
  - export `PLAYBOOK_PRESET_KEYS` (the six keys, in spec order), `PLAYBOOK_DIAL = 'pb_playbook'`,
    `isPlaybook(row)`, `engineKnowsPlaybookDial()` and
    `planPlaybookBooks(master, today)`;
  - extend `dialsFor`'s error text to name every family.
- Modify: `scripts/delta-lean-roll.mjs`:
  - membership: `isDeltaLean` accepts playbook rows, `byVariant` includes
    `PLAYBOOK_PRESET_KEYS`, and an `isPlaybook` cross-check sits beside `isHold`;
  - the create path ensures today's playbook plans (create → start → paper on), just
    after the four daily books;
  - the daily retire treats playbook rows like the four daily books (one row per
    day: flat → stop and erase the morning after; holding → alarm);
  - the engine gate: `engineKnowsPlaybookDial()` false → ATTENTION, exit 1, and
    everything else still rolls;
  - `printPlan` and the summary name the playbook books.
- Tests: `apps/api/test/delta-lean-roll.test.ts` and
  `apps/api/test/delta-lean-registration.test.ts`.

**Interfaces:**

```js
/** @returns {readonly BookPlan[]} */
export function planPlaybookBooks(master /* { nearestExpiry(symbol, onOrAfter): string|null } */, today /* 'YYYY-MM-DD' */)
// for each SYMBOL, for each PLAYBOOK_PRESET_KEYS variant:
//   dials = dialsFor(variant)   (resolved, no unknowns)
//   if dials.pb_expiry_day_only: if master.nearestExpiry(symbol, today) !== today → skip; expiry = today
//   else expiry = master.nearestExpiry(symbol, addCalendarDays(today, dials.pb_min_dte))
//   null expiry → throw (same message style as expiriesFrom)
//   { tag: `${symbol}-${variant}-${today}`, symbol, expiry, mode: PAPER, variant, series: `${symbol}-${variant}`, dials }
// assertAllPaper(books)
```

- [ ] **Step 1: Failing tests**, with a fake master keyed by the real October 2026
  calendar (NIFTY expiries 2026-10-19 and 2026-10-27; SENSEX 2026-10-22 and
  2026-10-29):
  - **Fri 2026-10-16:** 6 playbook books. Every NIFTY intraday book is on 10-19
    (`pb_min_dte` 1 → on or after 10-17; `pb_min_dte` 3 → on or after 10-19). Every
    SENSEX intraday book is on 10-22. No expiry book.
  - **Mon 2026-10-19:** NIFTY expiry presets ×3 on 10-19; the NIFTY intraday books on
    10-27 (on or after 10-20, and on or after 10-22); SENSEX on 10-22 (on or after 10-20,
    and on or after 10-22). 9 books.
  - **Thu 2026-10-22:** SENSEX expiry presets ×3 on 10-22; SENSEX intraday books on
    10-29; NIFTY intraday books on 10-27. 9 books.
  - Every plan is paper; the tags and series match the pattern; the dials carry
    `dl_open_lots: 0`.
  - The roll:
    - creates and starts today's playbook rows and switches paper on;
    - erases yesterday's flat playbook rows;
    - alarms on one holding legs;
    - flags no playbook row as an anomaly;
    - with the gate false, creates no playbook rows, prints ATTENTION and exits 1,
      while the four daily books and the hold pairs still roll;
    - is idempotent (a second run issues no calls);
    - the existing four daily books and hold-pair tests are unchanged.
- [ ] **Step 2: Run.**
  `DESK_REQUIRE_MONGO=1 node --test apps/api/test/delta-lean-roll.test.ts apps/api/test/delta-lean-registration.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** `addCalendarDays` is pure UTC arithmetic on `YYYY-MM-DD`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "feat(roll): the playbook family — three intraday presets per symbol every trading day (never 0-DTE, pb_min_dte), three expiry presets on the symbol's own expiry day, retired the morning after; behind an engine gate"`

---

### Task 8: Web: the dials metadata and the trigger label (spec §4.8, §8.1)

**Files:**
- Modify: `apps/web/src/dials-plan.ts`:
  - `DIAL_META` entries for all 43 `pb_*` dials, each with a unit kind and a
    one-line help taken from spec §8.1;
  - the risk flag on `pb_trade_max_loss` and `pb_premium_budget`;
  - a `PLAYBOOK_GROUPS` table: Selection and contract; Sizing and window; Common
    exits; Debit spreads; Short premium; Reversal; Gamma;
  - `groupFields` groups the `playbook` section as it groups `delta-lean`.
- Modify: `apps/web/src/report-orders.ts`: `'dl-exit': 'Exit'`.
- Tests:
  - `apps/web/test/dials-panel.test.tsx`: the Playbook section renders collapsed, its
    groups appear in order, no dial lands in "Not grouped", and the delta-lean
    section still reads 40.
  - `apps/web/test/report-orders.test.tsx`: `dl-exit` → "Exit".

- [ ] **Step 1:** Write the tests. Run `cd apps/web && npx vitest run test/dials-panel.test.tsx test/report-orders.test.tsx`.
  Expected: FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `cd apps/web && npx vitest run && npx tsc -b`. Expected: PASS.
- [ ] **Step 4: Commit.**
  `git commit -m "feat(web): the Playbook dials section, grouped, with units and help for every pb_* dial; dl-exit reads Exit in the order log"`

---

### Task 9: Trend Drive and Expiry Drive (spec §5.1, §5.4)

**Files:**
- Replace: `packages/desk-engine/src/delta-lean/playbook/trend-spread.ts`. Export
  `TREND_DRIVE` (id 1, name `trend-drive`) and `EXPIRY_DRIVE` (id 4, name
  `expiry-drive`), both built from one `trendSpread(id, name)` factory. The dials
  decide the differences.
- Test: `packages/desk-engine/test/playbook-trend.test.ts`, with unit and scenario
  tests.

**Rules.**

`enter`:
- side = `trendSide(regime)`; null → wait.
- `regimeHeldMs ≥ pb_confirm_s × 1000`.
- When `dayComplete`: `sign(spot − dayOpen)` equals the side's sign, else wait.
- Plan: `pb_strike_mode` 0 → `debitByBands`; 1 → `debitByStraddle`. null → wait.
- `lots = pb_lots`.

`exits`:
- **debit stop:** `pb_debit_stop_frac > 0 && cost > 0 && tradePnl ≤ −pb_debit_stop_frac × cost` → urgent, not final.
- **flip:** `pb_flip_confirm_s > 0`, the regime is the opposite trend, and
  `regimeHeldMs ≥ pb_flip_confirm_s × 1000` → urgent, not final.

`adds`:
- requires `pb.adds < pb_max_adds`, `tradePnl > 0`, the regime equal to the trade's
  side held ≥ `pb_confirm_s`, `dayImplied` non-null, and
  `dir × (spot − pb.entrySpot) ≥ pb_add_ext_k × dayImplied`;
- then a plan from the same strike rule at 1 lot, with `add: true` on any held
  same-side contract (from `openOf`).

**Scenario tests**, each one `runSession(decidePlaybook, resolveDials(<preset>), spec)`
with the preset `pb-trend-drive` or `pb-expiry-drive`. Size the segments from
`impliedMove` so the trend bursts are ≥ 2.5× the 5-minute implied move:

| Scenario | Expected |
|---|---|
| M1 | Trend Drive enters `up` before 10:15. One `dl-add`. It ends with `pnl > 0`, the close trigger being a trail (`dl-exit`) or `eod`. |
| M2 | Mirror of M1, side `down`, `pnl > 0` |
| M5 | No `dl-open` |
| M6 | At most one trade, `pnl ≥ −5,000 − 1` |
| M7 | An up entry, then a flip exit with `pnl ≥ −5,000` |
| M8 | No entry after 10:15 |
| M11 | No entry triggered by the spike alone |
| M14 | Expiry Drive on a 0-DTE spec (expiry === date): entry before 10:15, exit at or before 12:00 |
| O1 | A hole 09:28-09:40: no entry inside the hole |
| O9 | `startMin` 600: no open-direction filter, and an entry is still possible on a trend |
| O11 | Expiry Drive on a 3-DTE contract: no entry |

Every scenario asserts `nakedShortPasses === 0`.

- [ ] **Step 1:** Write the tests. Run `node --test packages/desk-engine/test/playbook-trend.test.ts`.
  Expected: FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run all engine tests. Expected: PASS.
- [ ] **Step 4: Commit.**
  `git commit -m "feat(engine): Trend Drive and Expiry Drive playbooks — confirmed opening trend as a debit spread (delta bands / straddle units), debit and flip stops, one capped pyramid, time exit on expiry; scenario suite"`

---

### Task 10: Wing Straddle and Expiry Theta Fly (spec §5.2, §5.5)

**Files:**
- Replace: `packages/desk-engine/src/delta-lean/playbook/theta-fly.ts`. Export
  `WING_STRADDLE` (id 2, `wing-straddle`) and `EXPIRY_THETA` (id 5,
  `expiry-theta`) from one `thetaFly(id, name)` factory.
- Test: `packages/desk-engine/test/playbook-theta.test.ts`.

**Rules.**

`enter`:
- regime ∈ {quiet, chop}, held ≥ `pb_confirm_s`;
- `pb_max_move_k > 0` → `dayComplete` is required and
  `|spot − dayOpen| ≤ pb_max_move_k × dayImplied`;
- `pb_calm_min > 0` → `windowRange(now − calm, now)` is required and its width is
  ≤ `pb_calm_mult × imp(pb_calm_min)`;
- plan = `flyPlan`; side `none`; stamps `entryStr: str`.

`exits`:
- **combined stop:** `pb_combined_stop > 0`, `shortsValue` non-null, and
  `now ≥ (1 + pb_combined_stop) × entry` → urgent, not final.
- **index stop:** `pb_stop_str_k > 0`; the centre = the strike of the held short
  CE; `held(ctx, |fwd − centre| ≥ pb_stop_str_k × pb.entryStr, pb_stop_hold_s)` fires
  → urgent, not final. Return the `held` patch on every path.
- **take profit by fraction:** `pb_target_frac > 0`, `cost < 0`, and
  `tradePnl ≥ pb_target_frac × (−cost)` → passive, not final.

`adds`: none.

**Scenario tests** (presets `pb-wing-straddle` and `pb-expiry-theta`):

| Scenario | Expected |
|---|---|
| M5 | Wing Straddle enters by 10:30, `pnl > 0` |
| M3 | No entry while the trend holds |
| M8 | Entry, then a combined stop or hard stop, `pnl ≥ −8,000 − 1` |
| M9 | The IV +30% ramp: an exit, with a loss bounded by the hard stop |
| M10 | The IV crush: `pnl > 0` |
| M12 | Expiry Theta on 0-DTE, calm: entry 13:00-14:15, `pnl > 0` |
| M13 | Calm, then a 1.5 × STR break at 13:40: the index stop fires; the loss is ≥ −4,000 − 1 and better than the fly's maximum loss |
| M6 | ≤ 2 trades, day ≥ −12,000 |
| O3 | A wing quote frozen: no entry |
| O4 | A move of 0.3 × STR between the stages: abort, wings closed, `nakedShortPasses === 0` |
| O9 | `startMin` 600: Wing Straddle does not enter (`dayComplete` false) |

Every scenario asserts `nakedShortPasses === 0`.

- [ ] **Steps 1-4:** as in Task 9, with commit
  `git commit -m "feat(engine): Wing Straddle and Expiry Theta Fly playbooks — staged iron flies in straddle units, combined and index stops, take-profit by fraction of credit, calm and max-move filters; scenario suite"`

---

### Task 11: Reversal Spread and Expiry Gamma Breakout (spec §5.3, §5.6)

**Files:**
- Replace: `packages/desk-engine/src/delta-lean/playbook/reversal-spread.ts`
  (`REVERSAL`, id 3, `reversal`).
- Replace: `packages/desk-engine/src/delta-lean/playbook/gamma-breakout.ts`
  (`EXPIRY_GAMMA`, id 6, `expiry-gamma`).
- Test: `packages/desk-engine/test/playbook-reversal.test.ts` and
  `packages/desk-engine/test/playbook-gamma.test.ts`.

**Reversal rules.**

`enter`:
- `dayComplete` and `dayImplied` are required;
- `up = dayHigh − dayOpen` and `dn = dayOpen − dayLow`; the excursion is the larger;
- the excursion must be ≥ `pb_rev_min_ext × dayImplied`;
- for an up-excursion:
  - `(dayHigh − spot) ≥ pb_rev_retrace × up` and `spot > dayOpen`;
  - the regime is `trend-down`, held ≥ `pb_confirm_s`;
  - side `down`, plan `debitByBands(ctx, 'down')`, stamps `entryExtreme: dayHigh`;
- a down-excursion is the mirror.

`exits`:
- **new extreme:** `held(ctx, dir × (spot − entryExtreme) ≥ pb_rev_stop_k × dayImplied, pb_stop_hold_s)`
  fires (dir +1 when fading an up-move) → urgent. Return the patch on every path.
- **flip back:** the regime is the original direction, held ≥ `pb_flip_confirm_s` →
  urgent.
- **debit stop**, as in Task 9.
- **back to the open:** the side is `down` and `spot ≤ dayOpen`, or `up` and
  `spot ≥ dayOpen` → passive, not final.

**Gamma rules.**

`enter`:
- box = `windowRange(now − pb_box_min min, now − 5 min)`, required;
- `width ≤ pb_box_max_k × imp(pb_box_min)`;
- `buf = pb_brk_buf_k × imp(5)`;
- **up:**
  - `spot ≥ box.hi + buf`;
  - `spot ≥ dayHigh − buf`;
  - the regime is `trend-up`, held ≥ `pb_confirm_s`;
  - strike = the first listed strike above `fwd` plus (`pb_otm_steps` − 1) steps;
  - CE, liquidWing;
- **down:** the mirror, with PE;
- lots = `min(pb_gamma_max_lots, floor(pb_premium_budget / (ask × lotSize)))`; < 1 → wait;
- plan: protective `[CE/PE Buy]`, shorts `[]`, side up/down;
- stamps: `boxHi`, `boxLo`.

`exits`:
- **premium stop:** `pb_prem_stop_frac > 0 && cost > 0 && tradePnl ≤ −pb_prem_stop_frac × cost` → urgent.
- **back in the box:**
  `held(ctx, side up ? spot ≤ boxHi − buf : spot ≥ boxLo + buf, pb_stop_hold_s)` fires →
  urgent.
- **premium trail:** armed when `tradePnl ≥ pb_prem_trail_arm × cost`, by setting
  `trailArmed` in the patch; fires when `tradePnl ≤ pb_trail_keep × peakPnl` → urgent.
  The common trail is off in this preset (`pb_trail_start` 0).

**Scenario tests:**

| Scenario | Expected |
|---|---|
| M7 | Reversal enters `down` after 10:00 and ends with `pnl > 0` |
| M4 | The fade: Reversal enters `down`, and the exit is back to the open or the trail, `pnl > 0` |
| M1 | No Reversal entry |
| M6 | Reversal: ≤ 1 trade, ≥ −5,000 − 1 |
| M13 | Gamma: an entry after 13:40 in the break direction, `pnl > 0` |
| M12 | Gamma: no entry |
| M15 | Gamma: ≤ 2 trades, day ≥ −2 × 3,000 − 1 |
| O8 | Gamma, the ring restarted at 13:30 (`startMin` 810): no entry before the box is covered |

Every scenario asserts `nakedShortPasses === 0`.

- [ ] **Steps 1-4:** as in Task 9, with commit
  `git commit -m "feat(engine): Reversal Spread and Expiry Gamma Breakout playbooks — excursion-and-retrace reversal debit spread with new-extreme, flip and back-to-open exits; box breakout long option inside a premium budget with premium stop, box re-entry stop and premium trail; scenario suites"`

---

### Task 12: Runbook and review report

**Files:**
- Modify: `docs/runbooks/delta-lean-paper.md`. Add §8, "Playbook books":
  - what the six are (one line each, with links to spec §5);
  - the tags and series;
  - the first-week checks of spec §10, as Mongo reads;
  - `DESK_CHAIN_FORWARD=future`;
  - the old-build fail-safe;
  - how to switch one preset off: stop its rows, and remove the preset key from
    `PLAYBOOK_PRESET_KEYS` before the next roll.

  Also update the "85 dials" counts.
- Create: `docs/reports/2026-10-16-desk-review.md`. It condenses
  `/tmp/claude-1000/-opt-algomaker/c608bff8-1e7a-4f59-af28-1a18709b5471/scratchpad/analysis/`
  (the trade review and algo review) into:
  - the scorecard;
  - what works and what does not;
  - conditional performance by day type and expiry;
  - the ranked defects;
  - the recommendations G1-G13 of spec §11.

  Paper and live are stated per row.
- [ ] **Step 1:** Write both documents.
- [ ] **Step 2: Commit.**
  `git commit -m "docs(runbook,report): the playbook books — tags, first-week checks, the forward kill switch, the old-build fail-safe; the 2026-10-16 desk review"`

---

### Task 13: Integration, review and ship (main session)

- [ ] Merge Tasks 1-12 into `playbooks`, in wave order, resolving conflicts in the
  shared files (`dials.ts`, `presets.ts`, `types.ts`, `index.ts`) by union.
- [ ] Run `npm ci --ignore-scripts` (if the lockfile changed), then
  `DESK_REQUIRE_MONGO=1 make check`, then `cd apps/web && npx tsc -b`. Everything must
  pass.
- [ ] Dispatch two independent reviewers against `master..playbooks`:
  - an Opus code reviewer for correctness, safety and D1/D2/D9 invariants;
  - an Opus adversarial verifier that re-checks every CRITICAL/HIGH finding against
    the code.

  Fix every confirmed finding, then re-run the checks.
- [ ] Merge `playbooks` into `master`, push (`git push origin master`), and build the
  dashboard (`npm run build --workspace @algomaker/web`).
- [ ] Hand the operator the restart order:
  - desk-api, desk-supervisor, desk-gateway, desk-marketdata (never desk-runner),
    after 15:30 today or before 09:15 Monday;
  - the verification reads of spec §10;
  - the note that Monday 19 Oct is a NIFTY expiry.
