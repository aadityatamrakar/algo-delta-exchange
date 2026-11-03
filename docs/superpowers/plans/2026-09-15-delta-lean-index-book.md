# Delta-Lean Index Book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second decide path to `desk-engine` that trades index delta on NIFTY/SENSEX weekly options — long gamma when the index trends, short gamma when it is quiet, theta held near zero — and end with four paper books running it.

**Architecture:** A new `packages/desk-engine/src/delta-lean/` module holds four pure units (regime detector, lean controller, expression layer, `decideDeltaLean`). It is selected per book by one new boolean dial, `delta_lean_enabled`, which flows through the existing `resolveDials`. `EngineHost` branches to it at its two `decide()` call sites; everything else — marking, damping, routing, freeze splitting, the peg chaser, paper simulation — is reused unchanged.

**Tech Stack:** TypeScript on Node 22+, executed directly (no build step). Tests are `node:test` + `node:assert/strict` in a sibling `test/` directory. Mongo standalone. pm2 namespace `desk`.

**Spec:** `docs/superpowers/specs/2026-09-15-delta-lean-index-book-design.md`

## Global Constraints

- **No build step.** TypeScript runs natively. Never add a compile stage.
- **Tests:** `npm test --workspace @algomaker/desk-engine`, `npm test --workspace @algomaker/supervisor`, one file with `node --test <path>`. Full gate: `make check` (typecheck + test).
- **Test style:** sibling `test/` dir, never colocated. A header docblock naming the failure the test prevents, then flat `test('...', () => {})` with `assert` from `node:assert/strict`. Real dates, never `Date.now()` in assertions.
- **Absent is never zero.** `LegView.hasGreeks` exists because a failed IV solve must not read as delta 0. Every new field follows this: no optional greeks, no sentinel zeros.
- **Every new dial is required** in the `Dials` interface, has an explicit value in `DEFAULT_DIALS`, and appears in exactly one `DIAL_SECTIONS` entry. `packages/desk-engine/test/dials.test.ts` fails otherwise.
- **`SIGTERM` stays inert.** `apps/supervisor/src/main.ts:44-57` forbids square-off on stop and there is no opt-out. The delta-lean book flattens on its own clock and on boot, never on a signal.
- **Lot size, strike step and expiry come from `OptionMaster`** (the synced instrument dump), never from `INDEX_UNDERLYINGS` in `packages/instruments/src/index.ts:49-110`, whose NIFTY lot size (75) and weekly expiry weekday (Thursday) are stale.
- **Rate limits:** at most 2 orders/second and 40 orders/minute per book.
- **Existing behaviour is frozen.** No recenter book may change its decisions. `packages/desk-engine/test/parity.test.ts` and `parity-shift.test.ts` must stay green untouched.

---

## Phase A — Prerequisites (Tasks 1-4 run in PARALLEL; they share no files)

### Task 1: Publish the order-submitted nudge

`apps/order-gateway/src/main.ts:2464` already subscribes to `ORDER_NUDGE_TOPIC` unconditionally, but nothing publishes it, so every order waits up to `DESK_SWEEP_MS` (5000) for the idle sweep. This is the single biggest latency item.

**Files:**
- Modify: `apps/api/src/rail.ts` (the paper insert at `:381-401` and its live sibling)
- Test: `apps/api/test/rail-nudge.test.ts` (create)

**Interfaces:**
- Consumes: `ORDER_NUDGE_TOPIC` from `apps/order-gateway/src/queue.ts:726` (value `'order.submitted'`)
- Produces: nothing new; a `bus.publish(ORDER_NUDGE_TOPIC, { decisionId })` side effect after each durable gateway-order insert

- [ ] **Step 1: Read the two insert sites**

Run: `sed -n '360,410p' apps/api/src/rail.ts` and `grep -n 'gatewayOrders' apps/api/src/rail.ts`

Both the paper branch (`:381-401`) and the live branch insert into `COLLECTIONS.gatewayOrders`. Find the single point after **both** inserts, or add one publish per branch. Do not publish before the insert resolves — the nudge must never arrive before the document is durable.

- [ ] **Step 2: Write the failing test**

```ts
/**
 * THE NUDGE THAT NEVER FIRED.
 *
 * The gateway subscribes to `order.submitted` and sweeps on it. Nothing ever
 * published it, so every order — paper and live — waited out the 5s idle
 * sweep instead. A seconds-cadence book cannot pay that. This test fails the
 * moment the publish is dropped again.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ORDER_NUDGE_TOPIC } from '@algomaker/order-gateway/queue'

test('a durable gateway-order insert publishes the nudge exactly once', async () => {
  const published: Array<{ topic: string; payload: unknown }> = []
  const bus = { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }) } }
  const rail = railUnderTest({ bus })          // harness: see apps/api/test/ for the existing pattern
  await rail.route(oneOpenAction())
  const nudges = published.filter((p) => p.topic === ORDER_NUDGE_TOPIC)
  assert.equal(nudges.length, 1)
})

test('the nudge is published AFTER the insert, never before', async () => {
  const order: string[] = []
  const bus = { publish: () => { order.push('nudge') } }
  const rail = railUnderTest({ bus, onInsert: () => { order.push('insert') } })
  await rail.route(oneOpenAction())
  assert.deepEqual(order, ['insert', 'nudge'])   // a nudge first would sweep an absent document
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --test apps/api/test/rail-nudge.test.ts`
Expected: FAIL, zero nudges published.

- [ ] **Step 4: Publish after each durable insert**

```ts
await this.#db.collection(COLLECTIONS.gatewayOrders)
  .insertOne({ ...gatewayOrderDocument(fill, ctx), mode: 'paper' })
this.#bus.publish(ORDER_NUDGE_TOPIC, { decisionId: ctx.decisionId })
return
```

If `rail.ts` has no bus handle, thread one through its deps object the same way `log` is threaded. Do not import the gateway package into `apps/api` for the constant if that creates a cycle — re-declare it in `packages/desk-engine/src/contract.ts` next to `ENGINE_DECISIONS_PATH` and have both sides import from there.

- [ ] **Step 5: Run the test and the gateway suite**

Run: `node --test apps/api/test/rail-nudge.test.ts && npm test --workspace @algomaker/order-gateway`
Expected: PASS, and no gateway regression.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rail.ts apps/api/test/rail-nudge.test.ts
git commit -m "perf(rail): publish the order nudge nothing ever published"
```

---

### Task 2: Carry theta and vega out of the mark

`marking.ts:419-439` solves Black-76 greeks and throws away `theta` and `vega`, which `b76Greeks` already returns. The delta-lean book needs both. `LegView` is consumed by every recenter code path and by the parity fixtures, so the new fields are **added as required fields with honest absence**, guarded by the existing `hasGreeks`.

**Files:**
- Modify: `packages/desk-engine/src/types.ts:70-85` (`LegView`)
- Modify: `packages/desk-engine/src/marking.ts:419-439` (`solveGreeks`), and `markLeg` (`:257`) and `strikeGreeks` (`:304`) where the solved object is spread
- Test: `packages/desk-engine/test/marking-greeks.test.ts` (create)

**Interfaces:**
- Consumes: `b76Greeks` from `@algomaker/greeks` returning `{ delta, gamma, theta, vega }` (`black76.ts:106`)
- Produces: `LegView.theta: number` and `LegView.vega: number`, both per-share and both meaningless unless `hasGreeks === true`; `strikeGreeks(...)` returns `{ iv, delta, gamma, theta, vega } | null`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THETA AND VEGA WERE ALWAYS THERE, AND ALWAYS DROPPED.
 *
 * b76Greeks returns four greeks; solveGreeks kept two. The delta-lean book
 * prices its whole theta constraint off the two that were thrown away. This
 * test pins that they survive the mark, and that they stay honestly absent
 * when the IV solve fails — a theta of 0 on an unsolvable leg would read as
 * "this leg costs nothing to hold".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { markLeg, RISK_FREE } from '@algomaker/desk-engine'
import { b76Greeks, b76Price } from '@algomaker/greeks'

test('a marked leg carries the theta and vega b76Greeks computed', () => {
  const leg = markLeg(longAtmCall(), chainOf(300), '2026-08-21', 600)
  assert.equal(leg.hasGreeks, true)
  const want = b76Greeks({ future: 300, strike: 300, t: 7 / 365, vol: leg.iv!, rate: RISK_FREE, type: 'CE' })
  assert.ok(Math.abs(leg.theta - want.theta) < 1e-9)
  assert.ok(Math.abs(leg.vega - want.vega) < 1e-9)
  assert.ok(leg.theta < 0) // a long option decays
})

test('an unsolvable leg reports hasGreeks false and is not read for theta', () => {
  const leg = markLeg(longAtmCall(), chainWithNoQuoteAt(300), '2026-08-21', 600)
  assert.equal(leg.hasGreeks, false)
  // The value is whatever the zero-init is; the CONTRACT is that no consumer
  // may read it. guards/controller must filter on hasGreeks first.
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/desk-engine/test/marking-greeks.test.ts`
Expected: FAIL, `Property 'theta' does not exist on type 'LegView'`.

- [ ] **Step 3: Widen the type**

In `types.ts`, immediately after `readonly gamma: number;`:

```ts
  /** Per-share, per CALENDAR DAY, negative for a long option. Read only when `hasGreeks`. */
  readonly theta: number;
  /** Per-share, per 1 point of vol (i.e. per 1%). Read only when `hasGreeks`. */
  readonly vega: number;
```

- [ ] **Step 4: Stop discarding them**

In `marking.ts`:

```ts
function solveGreeks(
  mid: number | null, chain: ChainSnap, strike: number, optType: OptType,
  dateIst: string, minuteOfDay: number,
): { iv: number; delta: number; gamma: number; theta: number; vega: number } | null {
  if (mid === null) return null;
  const inputs = { future: chain.spot, strike, t: yearFrac(dateIst, chain.expiry, minuteOfDay), rate: RISK_FREE, type: optType } as const;
  const iv = b76ImpliedVol(mid, inputs);
  if (iv === null) return null;
  const g = b76Greeks({ ...inputs, vol: iv });
  return { iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega };
}
```

Then at every site that builds a `LegView` from that result, carry the two new fields through, and at every site that builds one for an unsolvable leg, write `theta: 0, vega: 0` beside the existing `hasGreeks: false`.

- [ ] **Step 5: Run the whole engine suite, parity included**

Run: `npm test --workspace @algomaker/desk-engine`
Expected: PASS including `parity.test.ts` and `parity-shift.test.ts`. Those fixtures compare decisions, not `LegView` shape, so widening the type must not move a single recenter decision. If parity moves, the change leaked into a decision path — revert and find it.

- [ ] **Step 6: Commit**

```bash
git add packages/desk-engine/src/types.ts packages/desk-engine/src/marking.ts packages/desk-engine/test/marking-greeks.test.ts
git commit -m "feat(marking): keep the theta and vega the solver already computed"
```

---

### Task 3: Forward fallback when the future has no quote

`chain-view.ts:277-283` returns `null` when the future token has no quote at all, and `EngineHost.#evaluateOnce` bails on a null snap, so the book silently stops deciding. A one-sided future already works, because `midOf` falls back to LTP. The gap is "no quote at all".

**Files:**
- Modify: `apps/supervisor/src/chain-view.ts:277-300`
- Test: `apps/supervisor/test/chain-view-fallback.test.ts` (create)

**Interfaces:**
- Consumes: `ChainViewDeps` (`chain-view.ts:109-117`), extended with `spotFor(symbol: string): number | null` and `carryFor(symbol: string): number`
- Produces: `ChainSnap.future` synthesised as `{ bid: null, ask: null, ltp: spot * carry, asOf: nowMs }` when the real future has no quote; a new readonly `ChainView.syntheticForward: boolean`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * A BOOK THAT STOPS DECIDING IS WORSE THAN ONE DECIDING ON A PROXY.
 *
 * snap() returns null when the near-month future has no quote at all, and a
 * null snap makes the host bail without a word. For an index book whose whole
 * job is to react within seconds, that is an outage. A spot-times-carry
 * forward is a known approximation; silence is not.
 */
test('snap falls back to spot x carry when the future has no quote at all', () => {
  const view = viewWith({ spotFor: () => 24_000, carryFor: () => 1.0012 })
  view.onTick({ token: CE_TOKEN, price: 100, ts: NOW, bid: 99, ask: 101 })
  const snap = view.snap('NIFTY', '2026-09-22', 65, 50)
  assert.notEqual(snap, null)
  assert.ok(Math.abs(snap!.spot - 24_028.8) < 0.01)
  assert.equal(view.syntheticForward, true)
})

test('a real future quote always wins over the fallback', () => {
  const view = viewWith({ spotFor: () => 24_000, carryFor: () => 1.0012 })
  view.onTick({ token: FUT_TOKEN, price: 24_050, ts: NOW, bid: 24_049, ask: 24_051 })
  const snap = view.snap('NIFTY', '2026-09-22', 65, 50)
  assert.equal(snap!.spot, 24_050)
  assert.equal(view.syntheticForward, false)
})

test('no future quote AND no spot still returns null — never a made-up number', () => {
  const view = viewWith({ spotFor: () => null, carryFor: () => 1.0012 })
  assert.equal(view.snap('NIFTY', '2026-09-22', 65, 50), null)
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test apps/supervisor/test/chain-view-fallback.test.ts`
Expected: FAIL, `snap` returns null in the first test.

- [ ] **Step 3: Implement the fallback**

```ts
snap(symbol: string, expiry: string, lotSize: number, step: number): ChainSnap | null {
  const def = this.#declare(symbol, expiry)
  let spot: number | null = null
  let future: Quote | undefined
  if (isToken(def.futureToken)) {
    future = this.#quotes.get(def.futureToken)
    if (future !== undefined) spot = midOf(future)
  }
  if (spot === null) {
    // No tradable forward. Synthesise one rather than stop deciding: an index
    // spot times carry is within a few points of the future, and the engine's
    // own delta is far less sensitive to that than to not running at all.
    const cash = this.#d.spotFor(symbol)
    if (cash === null) return null
    spot = cash * this.#d.carryFor(symbol)
    future = { bid: null, ask: null, ltp: spot, asOf: this.#lastTickMs }
    this.#syntheticForward = true
  } else {
    this.#syntheticForward = false
  }
  // ... rest unchanged, using `future` and `spot`
}
```

Feed `spotFor` from the new `md.spot` subscription added in Task 11. Until that task lands, wire it to `() => null`, which preserves today's exact behaviour.

- [ ] **Step 4: Run the supervisor suite**

Run: `npm test --workspace @algomaker/supervisor`
Expected: PASS, including `chain-view.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/supervisor/src/chain-view.ts apps/supervisor/test/chain-view-fallback.test.ts
git commit -m "fix(chain-view): synthesise a forward instead of going silent"
```

---

### Task 4: Record ticks for replay

Nothing in the tree stores a tick time series. `desk-marks` is a 60-second upsert-in-place per token, explicitly display-only. The controller cannot be replayed or tuned without one.

**Files:**
- Create: `apps/marketdata/src/tick-recorder.ts`
- Modify: `apps/marketdata/src/main.ts` (subscribe near the existing snapshot timer around `:1115`)
- Test: `apps/marketdata/test/tick-recorder.test.ts` (create)

**Interfaces:**
- Consumes: the `md.tick` payload `{ token, price, ts, bid?, ask?, depth? }` built by `tickPayload` (`apps/marketdata/src/main.ts:504-529`)
- Produces: `class TickRecorder { constructor(deps: { db: Db; tokens(): ReadonlySet<number>; now(): number; flushMs?: number }); onTick(t: MdTick): void; async flush(): Promise<number>; stop(): void }`, writing to collection `desk-ticks` as `{ token, ts, price, bid, ask }`, batched

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THE TAPE WE NEVER KEPT.
 *
 * A delta controller that adds on a new peak and cuts on a drawdown cannot be
 * tuned against a 60-second display snapshot. This records the real tape for
 * the tokens a book actually watches, batched so it never blocks the feed.
 */
test('only admitted tokens are recorded', async () => {
  const rec = new TickRecorder({ db, tokens: () => new Set([111]), now: () => NOW })
  rec.onTick({ token: 111, price: 100, ts: NOW })
  rec.onTick({ token: 222, price: 200, ts: NOW })   // not this book's
  assert.equal(await rec.flush(), 1)
})

test('ticks batch and flush, and flush is idempotent when empty', async () => {
  const rec = new TickRecorder({ db, tokens: () => new Set([111]), now: () => NOW })
  for (let i = 0; i < 500; i++) rec.onTick({ token: 111, price: 100 + i, ts: NOW + i })
  assert.equal(await rec.flush(), 500)
  assert.equal(await rec.flush(), 0)
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test apps/marketdata/test/tick-recorder.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the recorder**

Buffer in memory, flush on a timer (`flushMs` default 5000) with `insertMany({ ordered: false })`, drop the buffer if it exceeds a hard cap so a Mongo stall can never grow unbounded, and log once when it does. Gate the whole recorder behind `DESK_RECORD_TICKS=1` so it costs nothing when off. Create a `{ token: 1, ts: 1 }` index and a TTL index on `ts` of 30 days.

- [ ] **Step 4: Run it and the marketdata suite**

Run: `node --test apps/marketdata/test/tick-recorder.test.ts && npm test --workspace @algomaker/marketdata`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/marketdata/src/tick-recorder.ts apps/marketdata/src/main.ts apps/marketdata/test/tick-recorder.test.ts
git commit -m "feat(marketdata): record the tape the controller needs to be tuned against"
```

---

## Phase B — The engine (Tasks 5-10, STRICTLY SEQUENTIAL)

### Task 5: Dials and presets

**Files:**
- Modify: `packages/desk-engine/src/dials.ts` (`Dials` `:58-92`, `DEFAULT_DIALS` `:99-177`, `DIAL_SECTIONS` `:219-320`)
- Modify: `packages/desk-engine/src/presets.ts` (`PRESETS` `:151`)
- Modify: `packages/desk-engine/test/presets.test.ts:61` (the count assertion, 13 to 15)
- Test: `packages/desk-engine/test/delta-lean-dials.test.ts` (create)

**Interfaces:**
- Produces: 46 new `dl_*` dials plus `delta_lean_enabled`, all required, all in `DEFAULT_DIALS`, all in a new `'Delta lean'` section of `DIAL_SECTIONS`; presets `delta-lean-aggressive` and `delta-lean-conservative`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * A DIAL THAT IS NOT IN A SECTION IS A DIAL THE OPERATOR CANNOT SEE.
 *
 * DIAL_SECTIONS is the dashboard's only field list. A dial missing from it is
 * invisible and therefore untunable, which for a risk dial means an operator
 * who believes they have a stop they cannot actually reach.
 */
test('the delta-lean preset selects the delta-lean path', () => {
  const p = PRESETS.find((x) => x.key === 'delta-lean-aggressive')
  assert.notEqual(p, undefined)
  assert.equal(p!.dials.delta_lean_enabled, true)
  assert.equal(p!.dials.dl_max_lean_lots, 9)
  assert.equal(p!.dials.dl_day_max_loss, 100_000)
})

test('conservative differs from aggressive on exactly the risk dials', () => {
  const a = PRESETS.find((x) => x.key === 'delta-lean-aggressive')!.dials
  const c = PRESETS.find((x) => x.key === 'delta-lean-conservative')!.dials
  assert.equal(c.dl_max_lean_lots, 3)
  assert.equal(c.dl_base_unit_lots, 0.5)
  assert.equal(c.dl_gamma_drift_keep, false)   // the aggressive book keeps the drift
  assert.equal(a.dl_gamma_drift_keep, true)
})

test('every dl_ dial has a default and a section', () => {
  for (const k of Object.keys(DEFAULT_DIALS).filter((k) => k.startsWith('dl_'))) {
    assert.ok(DIAL_SECTIONS.some((s) => s.fields.includes(k)), `${k} is in no section`)
  }
})

test('the default dials leave the delta-lean path OFF', () => {
  // Every existing book resolves against DEFAULT_DIALS. A default-on flag
  // would silently switch the live recenter books onto an untested engine.
  assert.equal(DEFAULT_DIALS.delta_lean_enabled, false)
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/desk-engine/test/delta-lean-dials.test.ts`
Expected: FAIL, `delta_lean_enabled` is not a key of `Dials`.

- [ ] **Step 3: Add the dials**

Append to the `Dials` interface:

```ts
  // Delta lean — the path selector
  readonly delta_lean_enabled: boolean;
  // Delta lean — budget
  readonly dl_capital: number; readonly dl_day_max_loss: number;
  readonly dl_lean_max_loss: number;
  readonly dl_base_unit_lots: number; readonly dl_max_lean_lots: number;
  // Delta lean — the add/cut/flip rule
  readonly dl_add_step_pnl: number; readonly dl_cut_frac: number;
  readonly dl_cut_floor: number; readonly dl_flip_cooldown_s: number;
  readonly dl_max_flips_hour: number; readonly dl_max_flips_day: number;
  readonly dl_gamma_drift_keep: boolean;
  // Delta lean — greeks constraints
  readonly dl_theta_floor_per_lot: number; readonly dl_theta_target: number;
  readonly dl_short_gamma_move_pct: number;
  // Delta lean — regime detector
  readonly dl_fast_window_s: number; readonly dl_slow_window_s: number;
  readonly dl_context_window_s: number; readonly dl_context_on: boolean;
  readonly dl_trend_mult: number; readonly dl_trend_exit_mult: number;
  readonly dl_clean_min: number; readonly dl_quiet_mult: number;
  readonly dl_regime_dwell_s: number;
  readonly dl_context_disagree_cap: number; readonly dl_flip_confirm_s: number;
  readonly dl_pause_theta_frac: number; readonly dl_chop_unwind_s: number;
  // Delta lean — strike selection
  readonly dl_long_delta_lo: number; readonly dl_long_delta_hi: number;
  readonly dl_short_delta_lo: number; readonly dl_short_delta_hi: number;
  readonly dl_credit_short_delta_max: number; readonly dl_wing_delta: number;
  readonly dl_wings_on: boolean; readonly dl_min_strike_gap: number;
  readonly dl_roll_long_delta: number; readonly dl_roll_short_delta: number;
  readonly dl_dead_band_lots: number; readonly dl_cost_gate_mult: number;
  // Delta lean — liquidity and staleness
  readonly dl_quote_fresh_s: number; readonly dl_max_spread_pct: number;
  readonly dl_max_spread_abs: number; readonly dl_spot_stale_s: number;
  readonly dl_leg_stale_s: number;
  // Delta lean — clock and pacing
  readonly dl_warmup_min: number; readonly dl_no_new_units_min: number;
  readonly dl_flatten_passive_min: number; readonly dl_flatten_urgent_min: number;
  readonly dl_flat_by_min: number;
  readonly dl_eval_min_ms: number; readonly dl_add_cooldown_s: number;
  readonly dl_max_orders_min: number;
```

`DEFAULT_DIALS` gets the aggressive numbers with `delta_lean_enabled: false`:

```ts
  delta_lean_enabled: false,
  dl_capital: 2_500_000, dl_day_max_loss: 100_000, dl_lean_max_loss: 37_500,
  dl_base_unit_lots: 1, dl_max_lean_lots: 9,
  dl_add_step_pnl: 2_500, dl_cut_frac: 0.5, dl_cut_floor: 2_500,
  dl_flip_cooldown_s: 30, dl_max_flips_hour: 8, dl_max_flips_day: 24,
  dl_gamma_drift_keep: true,
  dl_theta_floor_per_lot: -600, dl_theta_target: 3_000, dl_short_gamma_move_pct: 0.01,
  dl_fast_window_s: 60, dl_slow_window_s: 300, dl_context_window_s: 900, dl_context_on: true,
  dl_trend_mult: 2, dl_trend_exit_mult: 1.2, dl_clean_min: 0.6, dl_quiet_mult: 0.7,
  dl_regime_dwell_s: 120, dl_context_disagree_cap: 0.5, dl_flip_confirm_s: 60,
  dl_pause_theta_frac: 0.5, dl_chop_unwind_s: 30,
  dl_long_delta_lo: 0.55, dl_long_delta_hi: 0.65,
  dl_short_delta_lo: 0.2, dl_short_delta_hi: 0.3,
  dl_credit_short_delta_max: 0.3, dl_wing_delta: 0.1, dl_wings_on: true, dl_min_strike_gap: 1,
  dl_roll_long_delta: 0.8, dl_roll_short_delta: 0.45,
  dl_dead_band_lots: 0.25, dl_cost_gate_mult: 3,
  dl_quote_fresh_s: 3, dl_max_spread_pct: 0.02, dl_max_spread_abs: 1,
  dl_spot_stale_s: 10, dl_leg_stale_s: 30,
  dl_warmup_min: 570, dl_no_new_units_min: 880,
  dl_flatten_passive_min: 890, dl_flatten_urgent_min: 895, dl_flat_by_min: 900,
  dl_eval_min_ms: 1_000, dl_add_cooldown_s: 15, dl_max_orders_min: 40,
```

Add one `DIAL_SECTIONS` entry titled `Delta lean` listing every `dl_*` key plus `delta_lean_enabled`.

- [ ] **Step 4: Add the two presets**

```ts
const DELTA_LEAN_BASE: Partial<Dials> = {
  delta_lean_enabled: true,
  // The recenter engine's own dials are inert on this path, but confirm_ms
  // and cooldown_s are read by the HOST's damping, which both paths share.
  // 1s confirm, no cooldown: a cut must never wait out a 30s window.
  confirm_ms: 1_000, cooldown_s: 0,
}

{
  key: 'delta-lean-aggressive',
  label: 'Delta lean — aggressive (25L)',
  dials: { ...DELTA_LEAN_BASE },      // DEFAULT_DIALS already carries the aggressive numbers
},
{
  key: 'delta-lean-conservative',
  label: 'Delta lean — conservative (10L)',
  dials: {
    ...DELTA_LEAN_BASE,
    dl_capital: 1_000_000, dl_day_max_loss: 15_000, dl_lean_max_loss: 5_000,
    dl_base_unit_lots: 0.5, dl_max_lean_lots: 3,
    dl_add_step_pnl: 1_500, dl_cut_frac: 0.35, dl_cut_floor: 1_000,
    dl_flip_cooldown_s: 60, dl_max_flips_hour: 4, dl_max_flips_day: 12,
    dl_gamma_drift_keep: false,
    dl_theta_floor_per_lot: -300,
    dl_warmup_min: 570, dl_no_new_units_min: 880,
  },
},
```

- [ ] **Step 5: Update the preset count and run the suite**

Change `packages/desk-engine/test/presets.test.ts:61` from 13 to 15.

Run: `npm test --workspace @algomaker/desk-engine && make typecheck`
Expected: PASS. Parity untouched — no existing preset gained a key.

- [ ] **Step 6: Commit**

```bash
git add packages/desk-engine/src/dials.ts packages/desk-engine/src/presets.ts packages/desk-engine/test/
git commit -m "feat(dials): delta-lean dial set and its two presets"
```

---

### Task 6: The regime detector

**Files:**
- Create: `packages/desk-engine/src/delta-lean/regime.ts`
- Test: `packages/desk-engine/test/delta-lean-regime.test.ts` (create)

**Interfaces:**
- Consumes: `Dials` (the `dl_*` window and multiplier fields)
- Produces:

```ts
export interface SpotSample { readonly ms: number; readonly spot: number }
export interface WindowStat {
  readonly displacement: number   // last - first, signed
  readonly range: number          // high - low
  readonly cleanliness: number    // |displacement| / range; 0 when range is 0
  readonly samples: number
  readonly spanMs: number
}
export type Regime = 'trend-up' | 'trend-down' | 'quiet' | 'chop' | 'unknown'
export interface RegimeRead {
  readonly fast: Regime; readonly slow: Regime; readonly context: Regime
  readonly fastStat: WindowStat | null; readonly slowStat: WindowStat | null
  readonly impliedSlow: number | null
  readonly agrees: boolean        // slow and context point the same way
}
export class SpotRing {
  constructor(capacity: number)
  push(s: SpotSample): void
  window(nowMs: number, windowS: number): WindowStat | null
  get size(): number
}
export function impliedWindowMove(straddleMid: number, minutesToExpiry: number, windowS: number): number | null
export function atmStraddleMid(chain: ChainSnap): number | null
export function classifyWindow(stat: WindowStat | null, implied: number | null, dials: Dials, wasTrending: boolean): Regime
export function readRegime(ring: SpotRing, chain: ChainSnap, nowMs: number, minutesToExpiry: number, dials: Dials, prev: Regime): RegimeRead
```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THE DETECTOR IS THE WHOLE EDGE, AND IT HAS NO INDICATORS TO HIDE BEHIND.
 *
 * It asks one question: did the index move more than the options were pricing
 * for the same window, and did it move cleanly? Get the time-scaling wrong and
 * every threshold is wrong by a constant, which is the kind of bug that looks
 * like a bad strategy instead of a bad square root.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SpotRing, impliedWindowMove, classifyWindow, readRegime } from '@algomaker/desk-engine'

const NOW = 1_755_000_000_000

test('implied move scales with the square root of the window', () => {
  // 200-point straddle, 1125 trading minutes left, 5-minute window.
  const m = impliedWindowMove(200, 1125, 300)!
  assert.ok(Math.abs(m - 200 * Math.sqrt(5 / 1125)) < 1e-9)
  assert.ok(m > 13 && m < 13.5)   // the worked example in the spec
  // Four times the window is twice the move, never four times.
  assert.ok(Math.abs(impliedWindowMove(200, 1125, 1200)! / m - 2) < 1e-9)
})

test('implied move is absent, not zero, when there is no straddle or no time', () => {
  assert.equal(impliedWindowMove(0, 1125, 300), null)
  assert.equal(impliedWindowMove(200, 0, 300), null)
})

test('a clean move twice the implied is a trend', () => {
  const stat = { displacement: 25, range: 30, cleanliness: 25 / 30, samples: 60, spanMs: 300_000 }
  assert.equal(classifyWindow(stat, 13, DIALS, false), 'trend-up')
  assert.equal(classifyWindow({ ...stat, displacement: -25 }, 13, DIALS, false), 'trend-down')
})

test('a big range with no displacement is chop, not trend', () => {
  const stat = { displacement: 5, range: 40, cleanliness: 5 / 40, samples: 60, spanMs: 300_000 }
  assert.equal(classifyWindow(stat, 13, DIALS, false), 'chop')
})

test('a small range under the implied is quiet', () => {
  const stat = { displacement: 3, range: 8, cleanliness: 3 / 8, samples: 60, spanMs: 300_000 }
  assert.equal(classifyWindow(stat, 13, DIALS, false), 'quiet')
})

test('leaving a trend needs a lower bar than entering one', () => {
  // ratio 1.5: above trend_exit_mult (1.2), below trend_mult (2.0).
  const stat = { displacement: 19.5, range: 22, cleanliness: 19.5 / 22, samples: 60, spanMs: 300_000 }
  assert.equal(classifyWindow(stat, 13, DIALS, false), 'chop')       // would not START a trend
  assert.equal(classifyWindow(stat, 13, DIALS, true), 'trend-up')    // but does not END one either
})

test('a window with too few samples or too short a span is unknown, never quiet', () => {
  // "No data" must never read as "nothing is happening" — that would sell a
  // strangle into a feed outage.
  const ring = new SpotRing(4096)
  ring.push({ ms: NOW, spot: 24_000 })
  assert.equal(ring.window(NOW + 300_000, 300), null)
  assert.equal(classifyWindow(null, 13, DIALS, false), 'unknown')
})

test('the ring only reports samples inside the window', () => {
  const ring = new SpotRing(4096)
  for (let i = 0; i <= 600; i++) ring.push({ ms: NOW + i * 1000, spot: 24_000 + i })
  const w = ring.window(NOW + 600_000, 300)!
  assert.equal(w.displacement, 300)     // the last 300 seconds only
  assert.equal(w.range, 300)
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/desk-engine/test/delta-lean-regime.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
export function impliedWindowMove(straddleMid: number, minutesToExpiry: number, windowS: number): number | null {
  if (!(straddleMid > 0) || !(minutesToExpiry > 0) || !(windowS > 0)) return null
  return straddleMid * Math.sqrt(windowS / 60 / minutesToExpiry)
}

export function classifyWindow(stat: WindowStat | null, implied: number | null, dials: Dials, wasTrending: boolean): Regime {
  // Absent data is 'unknown'. It must never fall through to 'quiet', which is
  // the one regime that SELLS premium.
  if (stat === null || implied === null || !(implied > 0)) return 'unknown'
  if (stat.samples < MIN_SAMPLES) return 'unknown'
  const mult = wasTrending ? dials.dl_trend_exit_mult : dials.dl_trend_mult
  const ratio = Math.abs(stat.displacement) / implied
  if (ratio >= mult && stat.cleanliness >= dials.dl_clean_min) {
    return stat.displacement > 0 ? 'trend-up' : 'trend-down'
  }
  if (stat.range <= dials.dl_quiet_mult * implied) return 'quiet'
  return 'chop'
}
```

`SpotRing` is a fixed-capacity circular buffer of samples; `window()` walks back from the newest until `ms < nowMs - windowS*1000`, returning `null` if fewer than `MIN_SAMPLES` (8) fall inside or the span covers less than half the window. `readRegime` calls `classifyWindow` for all three windows, applies the `dl_regime_dwell_s` hold on leaving a trend, and sets `agrees` when slow and context are both `trend-up` or both `trend-down`. `atmStraddleMid` finds the strike nearest `chain.spot` and returns `midOf(ce) + midOf(pe)`, or `null` if either side is unpriced.

- [ ] **Step 4: Run it**

Run: `node --test packages/desk-engine/test/delta-lean-regime.test.ts`
Expected: PASS, all nine.

- [ ] **Step 5: Commit**

```bash
git add packages/desk-engine/src/delta-lean/regime.ts packages/desk-engine/test/delta-lean-regime.test.ts
git commit -m "feat(delta-lean): the regime detector, priced off the straddle"
```

---

### Task 7: Lean state

`RuleState` (`types.ts:284-298`) has no home for lean state, and `EMPTY_RULE_STATE` must agree with it field-for-field — `packages/desk-engine/test/types.test.ts` asserts that. Optional fields would reintroduce the absent-versus-zero trap the file exists to prevent, so these are required with explicit zero-values.

**Files:**
- Modify: `packages/desk-engine/src/types.ts:284-298` (`RuleState`, `EMPTY_RULE_STATE`)
- Create: `packages/desk-engine/src/delta-lean/lean.ts`
- Test: `packages/desk-engine/test/delta-lean-lean.test.ts` (create)

**Interfaces:**
- Produces, added to `RuleState`:

```ts
  /** '' = no lean. Otherwise the id stamped on every leg this lean opened. */
  readonly dlLeanId: string;
  readonly dlLeanSide: 'up' | 'down' | 'none' | '';   // 'none' = a quiet-regime strangle
  readonly dlLeanOpenedMs: number;
  readonly dlLeanPeak: number;
  readonly dlLeanPnlAtLastAdd: number;
  readonly dlLeanAdds: number;
  readonly dlTargetLots: number;
  readonly dlFlipsToday: number;
  readonly dlFlipsInHour: number;
  readonly dlFlipHourStartMs: number;
  readonly dlLastFlipMs: number;
  readonly dlLastAddMs: number;
  readonly dlRegime: string;
  readonly dlRegimeSinceMs: number;
  /** The IST date this book last reset itself for. '' = never. */
  readonly dlDayStarted: string;
  readonly dlStopped: boolean;
  readonly dlDayRealized: number;
```

- and from `lean.ts`:

```ts
export interface LeanPnl { readonly pnl: number; readonly peak: number; readonly drawdown: number; readonly priced: boolean }
export function leanPnl(legs: readonly LegView[], leanId: string, realized: number, peak: number): LeanPnl
export function newLeanId(nowMs: number, side: 'up' | 'down' | 'none'): string
export function rollDay(state: RuleState, dateIst: string, nowMs: number): RuleState
export function rollFlipHour(state: RuleState, nowMs: number): RuleState
export function canFlip(state: RuleState, dials: Dials, nowMs: number): boolean
```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THE LEAN'S OWN PNL, NOT THE DAY'S.
 *
 * The controller adds on a new peak and cuts on a drawdown FROM THAT PEAK.
 * Feed it the day's cumulative P&L instead and a green morning masks a losing
 * afternoon lean, so the cut arrives after the damage. These tests pin the
 * separation, and pin the daily reset that makes the book auto-start.
 */
test('lean pnl counts only legs stamped with this lean', () => {
  const legs = [leg({ leanId: 'A', mtm: 5_000 }), leg({ leanId: 'B', mtm: -9_000 })]
  const r = leanPnl(legs, 'A', 0, 0)
  assert.equal(r.pnl, 5_000)
  assert.equal(r.priced, true)
})

test('an unpriced leg makes the lean pnl unpriced, not smaller', () => {
  // A leg whose IV would not solve has no honest mtm. Treating it as 0 would
  // understate a loss and delay the cut.
  const legs = [leg({ leanId: 'A', mtm: 5_000 }), leg({ leanId: 'A', hasGreeks: false, mtm: 0 })]
  assert.equal(leanPnl(legs, 'A', 0, 0).priced, false)
})

test('drawdown is measured from the peak, and the peak only ratchets up', () => {
  assert.equal(leanPnl([leg({ leanId: 'A', mtm: 12_000 })], 'A', 0, 20_000).drawdown, 8_000)
  assert.equal(leanPnl([leg({ leanId: 'A', mtm: 25_000 })], 'A', 0, 20_000).peak, 25_000)
  assert.equal(leanPnl([leg({ leanId: 'A', mtm: 12_000 })], 'A', 0, 20_000).peak, 20_000)
})

test('a new IST date clears the stop, the lean and the flip counters', () => {
  // This is the auto-start. No operator action, no restart: the book that
  // stopped itself at a 1 lakh loss yesterday trades again this morning.
  const spent: RuleState = { ...EMPTY_RULE_STATE, dlStopped: true, dlDayStarted: '2026-09-15',
    dlFlipsToday: 24, dlLeanId: 'A', dlLeanSide: 'up', dlDayRealized: -100_000 }
  const fresh = rollDay(spent, '2026-09-16', NOW)
  assert.equal(fresh.dlStopped, false)
  assert.equal(fresh.dlFlipsToday, 0)
  assert.equal(fresh.dlLeanId, '')
  assert.equal(fresh.dlDayRealized, 0)
  assert.equal(fresh.dlDayStarted, '2026-09-16')
})

test('the same date is not a reset — a mid-session restart must not clear the stop', () => {
  const spent: RuleState = { ...EMPTY_RULE_STATE, dlStopped: true, dlDayStarted: '2026-09-15', dlDayRealized: -100_000 }
  assert.deepEqual(rollDay(spent, '2026-09-15', NOW), spent)
})

test('flips are capped per hour and per day, and by a cooldown', () => {
  const base = { ...EMPTY_RULE_STATE, dlFlipHourStartMs: NOW, dlLastFlipMs: NOW - 60_000 }
  assert.equal(canFlip({ ...base, dlFlipsInHour: 7 }, DIALS, NOW), true)
  assert.equal(canFlip({ ...base, dlFlipsInHour: 8 }, DIALS, NOW), false)
  assert.equal(canFlip({ ...base, dlFlipsToday: 24 }, DIALS, NOW), false)
  assert.equal(canFlip({ ...base, dlLastFlipMs: NOW - 5_000 }, DIALS, NOW), false)  // 30s cooldown
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/desk-engine/test/delta-lean-lean.test.ts`
Expected: FAIL, the new `RuleState` fields do not exist.

- [ ] **Step 3: Extend `RuleState` and `EMPTY_RULE_STATE` in the same edit**

Add every field above to both. `types.test.ts` compares their key sets and will catch a miss.

- [ ] **Step 4: Implement `lean.ts`**

`leanPnl` sums `mtm` over legs whose `leanId` matches, adds `realized`, and sets `priced: false` if any matching leg has `hasGreeks === false`. `peak` is `Math.max(peak, pnl)`. `rollDay` returns the state unchanged when `dateIst === state.dlDayStarted`, otherwise resets the day fields. `canFlip` checks the cooldown, the hourly cap (rolling the hour window first) and the daily cap.

- [ ] **Step 5: Run the engine suite**

Run: `npm test --workspace @algomaker/desk-engine`
Expected: PASS, parity included.

- [ ] **Step 6: Commit**

```bash
git add packages/desk-engine/src/types.ts packages/desk-engine/src/delta-lean/lean.ts packages/desk-engine/test/delta-lean-lean.test.ts
git commit -m "feat(delta-lean): lean state, its own P&L, and the daily reset"
```

---

### Task 8: The expression layer

**Files:**
- Create: `packages/desk-engine/src/delta-lean/express.ts`
- Test: `packages/desk-engine/test/delta-lean-express.test.ts` (create)

**Interfaces:**
- Consumes: `ChainSnap`, `LegView`, `Dials`, `strikeGreeks` from `marking.ts:304` (now returning theta and vega, Task 2)
- Produces:

```ts
export interface Candidate {
  readonly op: 'open' | 'close'
  readonly strike: number; readonly optType: OptType; readonly side: Side
  readonly lots: number
  readonly deltaPerLot: number; readonly thetaPerLot: number; readonly gammaPerLot: number
  readonly residual: number      // |excess| left after this action
  readonly spreadCost: number    // rupees, round trip
  readonly instrument?: string   // set for 'close'
}
export function tradableStrikes(chain: ChainSnap, dials: Dials, nowMs: number): readonly StrikeQuote[]
export function deltaBandStrike(chain: ChainSnap, optType: OptType, lo: number, hi: number, dateIst: string, minuteOfDay: number, dials: Dials): number | null
export function bestFit(candidates: readonly Candidate[], excess: number, thetaHeadroom: number): Candidate | null
export function debitUnit(chain: ChainSnap, side: 'up' | 'down', dials: Dials, dateIst: string, minuteOfDay: number): readonly EngineAction[] | null
export function creditUnit(chain: ChainSnap, side: 'up' | 'down', lots: number, dials: Dials, dateIst: string, minuteOfDay: number): readonly EngineAction[] | null
export function shortGammaLoss(netGamma: number, spot: number, movePct: number): number
export function rollNeeded(leg: LegView, dials: Dials): 'long' | 'short' | null
```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * BEST FIT, NOT BIGGEST HAMMER.
 *
 * A 0.35 delta-lot excess is met by one lot of a 0.35-delta option, never by
 * waiting for a full ATM lot that overshoots to 0.55 and then needs undoing.
 * The tie between buying a call and selling a put is broken by theta, which is
 * the entire mechanism keeping this book from being a naked long-gamma bleed.
 */
test('a 0.35 excess picks a 0.35-delta leg over an ATM lot', () => {
  const c = bestFit(candidates, 0.35, THETA_HEADROOM_OK)!
  assert.ok(Math.abs(c.deltaPerLot - 0.35) < 0.02)
  assert.equal(c.residual, 0)
})

test('with no theta headroom the tie breaks toward selling', () => {
  // Both fit the delta exactly. Buying adds negative theta; selling adds
  // positive. At the floor, only one of those is allowed.
  const buyCall = cand({ op: 'open', side: 'Buy', optType: 'CE', deltaPerLot: 0.35, thetaPerLot: -400 })
  const sellPut = cand({ op: 'open', side: 'Sell', optType: 'PE', deltaPerLot: 0.35, thetaPerLot: +380 })
  assert.equal(bestFit([buyCall, sellPut], 0.35, 0).side, 'Sell')
  assert.equal(bestFit([buyCall, sellPut], 0.35, 5_000).side, 'Buy')  // headroom: keep convexity
})

test('an excess inside the dead band produces nothing', () => {
  assert.equal(bestFit(candidates, 0.2, THETA_HEADROOM_OK), null)
})

test('a wide or stale strike is not a candidate at all', () => {
  // 2% of mid or Re 1, whichever is larger; and a quote older than 3s.
  assert.equal(tradableStrikes(chainWithWideCe(), DIALS, NOW).some((s) => s.strike === WIDE), false)
  assert.equal(tradableStrikes(chainWithStaleCe(NOW - 10_000), DIALS, NOW).some((s) => s.strike === STALE), false)
})

test('a debit unit buys near and sells 2-3 strikes out, long leg first', () => {
  const u = debitUnit(chainOf(24_000), 'up', DIALS, '2026-09-15', 600)!
  assert.equal(u.length, 2)
  assert.equal(u[0]!.side, 'Buy')     // never naked, even for an instant
  assert.equal(u[1]!.side, 'Sell')
  assert.ok(u[1]!.strike > u[0]!.strike)
})

test('a credit unit sells at least one strike out and buys its wing first', () => {
  const u = creditUnit(chainOf(24_000), 'up', 1, DIALS, '2026-09-15', 600)!
  assert.equal(u[0]!.side, 'Buy')     // the wing
  assert.equal(u[1]!.side, 'Sell')
  assert.ok(Math.abs(u[1]!.strike - 24_000) >= DIALS.dl_min_strike_gap * 50)
})

test('the short-gamma cap is the 1% move loss, in rupees', () => {
  // 0.5 * gamma * (1% of spot)^2. This is "how many strangles is too many",
  // expressed as the only number that matters: what a 1% gap costs.
  const loss = shortGammaLoss(-0.0002, 24_000, 0.01)
  assert.ok(Math.abs(loss - 0.5 * 0.0002 * 240 * 240) < 1e-6)
})

test('a long leg past 0.80 delta rolls, a short past 0.45 rolls', () => {
  assert.equal(rollNeeded(leg({ side: 'Buy', delta: 0.85 }), DIALS), 'long')
  assert.equal(rollNeeded(leg({ side: 'Sell', delta: 0.5 }), DIALS), 'short')
  assert.equal(rollNeeded(leg({ side: 'Buy', delta: 0.6 }), DIALS), null)
  assert.equal(rollNeeded(leg({ side: 'Buy', delta: 0.9, hasGreeks: false }), DIALS), null) // no honest delta
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/desk-engine/test/delta-lean-express.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`tradableStrikes` filters on two-sided quote, `asOf` within `dl_quote_fresh_s`, and spread at most `max(dl_max_spread_pct * mid, dl_max_spread_abs)`. `deltaBandStrike` walks `chain.strikes` from ATM outward, calls `strikeGreeks`, and returns the first strike whose `|delta|` falls in `[lo, hi]` and whose distance from ATM is at least `dl_min_strike_gap` steps; `null` if none. `bestFit` drops candidates when `|excess| < dl_dead_band_lots`, computes `lots = Math.round(excess / deltaPerLot)`, drops zero-lot and cost-gated candidates, sorts by residual then by theta direction against `thetaHeadroom` then by `spreadCost`. `debitUnit` and `creditUnit` compose two `EngineAction`s each in the order the tests pin. `shortGammaLoss` is `0.5 * |gamma| * (spot*movePct)^2`. `rollNeeded` returns `null` unless `hasGreeks`.

- [ ] **Step 4: Run it**

Run: `node --test packages/desk-engine/test/delta-lean-express.test.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Commit**

```bash
git add packages/desk-engine/src/delta-lean/express.ts packages/desk-engine/test/delta-lean-express.test.ts
git commit -m "feat(delta-lean): delta-band strike selection and best-fit sizing"
```

---

### Task 9: `decideDeltaLean`

The second decide path. Its evaluation order mirrors `engine.ts:230-363` but puts the day stop first, because the spec requires it never be damped and never be outranked.

**Files:**
- Create: `packages/desk-engine/src/delta-lean/decide.ts`
- Modify: `packages/desk-engine/src/index.ts` (export the new module)
- Test: `packages/desk-engine/test/delta-lean-decide.test.ts` (create)

**Interfaces:**
- Consumes: `EngineInputs`, `Dials`, `RuleState`, `MarkContext`, everything from Tasks 6-8
- Produces:

```ts
export interface DeltaLeanInputs extends EngineInputs {
  readonly ring: SpotRing
  readonly minutesToExpiry: number
  readonly ordersThisMinute: number
}
export function decideDeltaLean(
  inputs: DeltaLeanInputs, dials: Dials, state: RuleState, markCtx: MarkContext,
): EngineDecision
```

**What Task 6 actually shipped, which differs from the sketch above:**
- `readRegime` takes a trailing optional `prevSinceMs: number | null`. Pass `state.dlRegimeSinceMs` — without it the `dl_regime_dwell_s` hold is skipped and the regime label churns.
- `classifyWindow` stays per-window; the spec's "quiet for two consecutive windows" lives in `readRegime`, which re-reads the preceding slow window off the ring. A `slow === 'quiet'` therefore needs roughly two slow windows of history, which the 09:30 warm-up provides.
- `MIN_SAMPLES` and `MIN_SPAN_FRAC` are exported. A window that fails either is `null`, and a `null` classifies `'unknown'`.

Evaluation order, each step returning early:

```
0. day roll        rollDay(state, dateIst) — auto-start; never an action, always a state write
1. day stop        dlStopped -> flatten if legs remain, else hold. Trigger 'dl-stop'.
2. day max loss    dayPnl <= -dl_day_max_loss -> set dlStopped, flatten. Trigger 'dl-stop'.
3. boot/EOD flat   minuteOfDay >= dl_flat_by_min && legs -> flatten urgent. Trigger 'eod'.
4. flatten window  >= dl_flatten_urgent_min -> flatten urgent; >= dl_flatten_passive_min -> flatten passive.
5. session gate    !isTradingDay | minuteOfDay < dl_warmup_min -> hold (the detector still runs; the ring is fed by the host)
6. repair hold     inputs.repairHold -> hold
7. working hold    inputs.pendingLots > 0 -> hold
8. stale data      spot older than dl_spot_stale_s -> hold. A short leg staler than dl_leg_stale_s while spot moved past implied -> close it, urgent.
9. rolls           rollNeeded on any leg -> emit the roll
10. regime         readRegime(...)
11. targets        trend/quiet/chop per spec §6 step 4, capped by context (§5)
12. theta          soft floor: add far-side credit units until cleared, bounded by shortGammaLoss <= dl_lean_max_loss
13. diff           bestFit over the greek difference -> actions
14. pacing         no new units past dl_no_new_units_min; add cooldown; order budget
```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THE ORDER OF THESE CHECKS IS THE RISK MODEL.
 *
 * A day stop that sits below the add rule is a day stop that adds one more
 * unit before it fires. A flatten that sits below the session gate never fires
 * on a holiday-adjacent restart. Each test here pins one ordering that is only
 * visible as a bug in money.
 */
test('the day stop outranks every add, even a perfect trend', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', dayPnl: -100_000, legs: [] }), DIALS, EMPTY, MARK)
  assert.equal(d.action, 'hold')          // flat already; nothing to flatten
  assert.equal(d.stateAfter.dlStopped, true)
  assert.equal(d.actions.length, 0)
})

test('hitting the day max loss flattens and latches stopped', () => {
  const d = decideDeltaLean(inputsIn({ dayPnl: -100_001, legs: [longCall()] }), DIALS, EMPTY, MARK)
  assert.equal(d.action, 'flatten')
  assert.equal(d.stateAfter.dlStopped, true)
})

test('a stopped book stays stopped for the rest of the day', () => {
  const stopped = { ...EMPTY, dlStopped: true, dlDayStarted: '2026-09-15' }
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', dayPnl: 50_000 }), DIALS, stopped, MARK)
  assert.equal(d.actions.length, 0)
})

test('a new day clears the stop without an operator', () => {
  const stopped = { ...EMPTY, dlStopped: true, dlDayStarted: '2026-09-15' }
  const d = decideDeltaLean(inputsIn({ dateIst: '2026-09-16', regime: 'quiet' }), DIALS, stopped, MARK)
  assert.equal(d.stateAfter.dlStopped, false)
})

test('past the flat-by minute the book flattens urgently, whatever the regime', () => {
  const d = decideDeltaLean(inputsIn({ minuteOfDay: 901, regime: 'trend-up', legs: [longCall()] }), DIALS, EMPTY, MARK)
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
})

test('BOOTING past the flat-by minute holding legs also flattens — the restart case', () => {
  // The supervisor's SIGTERM is deliberately inert, so a book can wake up
  // after 15:00 still holding. This is the only thing standing between that
  // and an overnight carry the spec forbids.
  const d = decideDeltaLean(inputsIn({ minuteOfDay: 1_000, legs: [longCall()] }), DIALS, EMPTY, MARK)
  assert.equal(d.action, 'flatten')
})

test('before the warm-up minute nothing is opened', () => {
  const d = decideDeltaLean(inputsIn({ minuteOfDay: 565, regime: 'trend-up' }), DIALS, EMPTY, MARK)
  assert.equal(d.actions.length, 0)
})

test('a trend with no lean opens exactly one base unit', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up' }), DIALS, EMPTY, MARK)
  assert.equal(d.action, 'adjust')
  assert.ok(d.actions.some((a) => a.op === 'open' && a.side === 'Buy'))
  assert.notEqual(d.stateAfter.dlLeanId, '')
  assert.equal(d.stateAfter.dlLeanSide, 'up')
})

test('a new peak past the add step adds one unit, and no more than one', () => {
  const lean = { ...EMPTY, dlLeanId: 'A', dlLeanSide: 'up' as const, dlLeanPeak: 5_000, dlLeanPnlAtLastAdd: 5_000, dlTargetLots: 1 }
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', leanPnl: 7_600 }), DIALS, lean, MARK)
  assert.ok(d.stateAfter.dlTargetLots > 1 && d.stateAfter.dlTargetLots <= 2)
})

test('a 50% drawdown from the peak cuts, and is never damped', () => {
  const lean = { ...EMPTY, dlLeanId: 'A', dlLeanSide: 'up' as const, dlLeanPeak: 20_000, dlTargetLots: 4 }
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', leanPnl: 10_000, legs: [longCall()] }), DIALS, lean, MARK)
  assert.ok(d.stateAfter.dlTargetLots < 4)
})

test('the lean max loss cuts to zero regardless of regime', () => {
  const lean = { ...EMPTY, dlLeanId: 'A', dlLeanSide: 'up' as const, dlTargetLots: 4 }
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', leanPnl: -37_501, legs: [longCall()] }), DIALS, lean, MARK)
  assert.equal(d.stateAfter.dlTargetLots, 0)
})

test('the context window halves the cap when it disagrees with the slow window', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', context: 'trend-down', leanPnl: 100_000 }), DIALS, bigLean, MARK)
  assert.ok(d.stateAfter.dlTargetLots <= DIALS.dl_max_lean_lots * DIALS.dl_context_disagree_cap)
})

test('quiet sells a strangle and targets zero delta', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'quiet' }), DIALS, EMPTY, MARK)
  assert.equal(d.stateAfter.dlLeanSide, 'none')
  assert.equal(d.actions.filter((a) => a.op === 'open' && a.side === 'Sell').length, 2)
})

test('chop opens nothing', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'chop' }), DIALS, EMPTY, MARK)
  assert.equal(d.actions.filter((a) => a.op === 'open').length, 0)
})

test('unknown regime opens nothing — a dead feed is not a quiet market', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'unknown' }), DIALS, EMPTY, MARK)
  assert.equal(d.actions.filter((a) => a.op === 'open').length, 0)
})

test('past the no-new-units minute, cuts still run but adds do not', () => {
  const lean = { ...EMPTY, dlLeanId: 'A', dlLeanSide: 'up' as const, dlLeanPeak: 20_000, dlTargetLots: 4 }
  const add = decideDeltaLean(inputsIn({ minuteOfDay: 885, regime: 'trend-up', leanPnl: 30_000 }), DIALS, lean, MARK)
  assert.equal(add.actions.filter((a) => a.op === 'open').length, 0)
  const cut = decideDeltaLean(inputsIn({ minuteOfDay: 885, regime: 'trend-up', leanPnl: 10_000, legs: [longCall()] }), DIALS, lean, MARK)
  assert.ok(cut.actions.length > 0)
})

test('the theta floor never blocks a trend unit — it only adds a credit unit', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', netTheta: -9_000 }), DIALS, EMPTY, MARK)
  assert.ok(d.actions.some((a) => a.op === 'open' && a.side === 'Buy'))   // the lean still goes on
  assert.ok(d.actions.some((a) => a.op === 'open' && a.side === 'Sell'))  // plus the offset
})

test('the short-gamma cap stops the theta offset before the floor is met', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', netTheta: -9_000, netGamma: -0.02 }), DIALS, EMPTY, MARK)
  const sells = d.actions.filter((a) => a.op === 'open' && a.side === 'Sell')
  assert.equal(sells.length, 0)   // already at the cap: run with theta below the floor
})

test('a stale spot holds rather than deciding on an old price', () => {
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', spotAgeS: 11 }), DIALS, EMPTY, MARK)
  assert.equal(d.action, 'hold')
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the evaluation order above**

Each early return builds an `EngineDecision` with both `stateAfter` and `markState` set, exactly as `engine.ts` does. Add the new triggers `'dl-stop' | 'dl-lean' | 'dl-cut' | 'dl-flip' | 'dl-theta' | 'dl-roll'` to the `Trigger` union in `types.ts`.

- [ ] **Step 4: Run the engine suite**

Run: `npm test --workspace @algomaker/desk-engine && make typecheck`
Expected: PASS, parity untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/desk-engine/src/delta-lean/ packages/desk-engine/src/types.ts packages/desk-engine/src/index.ts packages/desk-engine/test/delta-lean-decide.test.ts
git commit -m "feat(delta-lean): the second decide path, day stop first"
```

---

### Task 9A: Stamp the lean id onto every leg it opens

**Why this task exists:** Task 7 discovered it. `leanPnl(legs, leanId, ...)` selects legs by a stamp, and no leg carries one. Without this, `dlLeanId` never matches anything, every lean reads as holding nothing, and the add/cut rule — which is the entire strategy — never fires. Task 7 shipped `LeanLeg extends LegView` and a structural reader as a placeholder; this task makes the stamp real end to end.

**Files:**
- Modify: `packages/desk-engine/src/types.ts` (`EngineAction` open variant, `LegView`)
- Modify: `packages/desk-engine/src/marking.ts` (`LegPosition`, `markLeg`)
- Modify: `packages/desk-engine/src/contract.ts` (`WireAction` open variant)
- Modify: `apps/api/src/contract.ts` (`BridgeLeg`)
- Modify: `apps/api/src/book.ts` (the action-to-leg writer)
- Modify: `apps/supervisor/src/main.ts` (`#readBook`, ~`:680-700`)
- Modify: `apps/supervisor/src/engine-host.ts` (wherever an `EngineAction` becomes a `WireAction`)
- Modify: `packages/desk-engine/src/delta-lean/lean.ts` (drop the structural reader for the real field)
- Test: `packages/desk-engine/test/delta-lean-stamp.test.ts` (create), `apps/supervisor/test/read-book-stamp.test.ts` (create)

**Interfaces:**
- Consumes: `LeanLeg`/`stampOf` from Task 7's `lean.ts`, which this task replaces
- Produces, with a deliberate split between optional and required:
  - **Optional on the write path**, because the recenter engine never sets one and absent genuinely means "no lean" — the same pattern `BridgeLeg.origin` already uses: `EngineAction` open gains `readonly leanId?: string`; `WireAction` open gains `readonly leanId?: string`; `BridgeLeg` gains `readonly leanId?: string`.
  - **Required on the read path**, because a mapper that silently omits it produces a lean holding nothing and no type error: `LegPosition.leanId: string` and `LegView.leanId: string`, both `''` for unstamped.

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * A LEAN THAT HOLDS NOTHING.
 *
 * The add/cut rule reads the P&L of legs stamped with the current lean. If the
 * stamp does not survive the trip from decision to order to stored leg and back
 * into the mark, every lean reads as flat: it never adds on a winner, never
 * cuts on a loser, and the whole strategy degrades to opening one base unit and
 * staring at it. Nothing throws. These tests are the only thing that notices.
 */
test('an open action carries its lean id onto the wire', () => {
  const wire = toWireActions([{ op: 'open', strike: 24_000, optType: 'CE', side: 'Buy', lots: 1, leanId: 'dl-up-123' }], resolve)
  assert.equal(wire[0]!.leanId, 'dl-up-123')
})

test('a recenter open carries no lean id, and that is not an error', () => {
  const wire = toWireActions([{ op: 'open', strike: 24_000, optType: 'CE', side: 'Sell', lots: 1 }], resolve)
  assert.equal(wire[0]!.leanId, undefined)
})

test('a marked leg exposes the stamp the stored leg carried', () => {
  const view = markLeg({ ...position, leanId: 'dl-up-123' }, chainOf(24_000), '2026-09-15', 600)
  assert.equal(view.leanId, 'dl-up-123')
})

test('an unstamped stored leg reads as the empty string, never undefined', () => {
  // leanPnl matches on equality. An undefined here would match an undefined
  // lean id and quietly adopt every manual leg in the book.
  const view = markLeg(position, chainOf(24_000), '2026-09-15', 600)
  assert.equal(view.leanId, '')
})

test('leanPnl on the empty lean matches nothing, stamped or not', () => {
  const legs = [leg({ leanId: '', mtm: 5_000 }), leg({ leanId: 'dl-up-1', mtm: 7_000 })]
  assert.equal(leanPnl(legs, '', 0, 0).pnl, 0)
})
```

And on the supervisor side:

```ts
/**
 * THE STAMP HAS TO SURVIVE MONGO.
 *
 * #readBook rebuilds LegPosition from a stored document field by field. A field
 * it does not map is a field that does not exist as far as the engine is
 * concerned, silently and with no type error on the stored-document side.
 */
test('#readBook carries leanId off the stored leg', async () => {
  const positions = await readBookFrom([storedLeg({ leanId: 'dl-up-123' })])
  assert.equal(positions[0]!.leanId, 'dl-up-123')
})

test('a stored leg with no leanId reads as the empty string', async () => {
  const positions = await readBookFrom([storedLeg({})])
  assert.equal(positions[0]!.leanId, '')
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --test packages/desk-engine/test/delta-lean-stamp.test.ts apps/supervisor/test/read-book-stamp.test.ts`
Expected: FAIL, `leanId` is not a property.

- [ ] **Step 3: Widen the types**

In `packages/desk-engine/src/types.ts`, the open variant of `EngineAction`:

```ts
  | {
      readonly op: 'open'; readonly strike: number; readonly optType: OptType;
      readonly side: Side; readonly lots: number;
      /**
       * The delta-lean lean this leg belongs to. ABSENT on every recenter
       * action — that engine has no leans — which is why it is optional here
       * and required, as `''`, on the read side.
       */
      readonly leanId?: string;
    }
```

and on `LegView`, beside `openedByEngine`:

```ts
  /** The lean that opened this leg. `''` = unstamped: a manual leg, a recenter leg, or one from before stamping existed. Matches no lean. */
  readonly leanId: string;
```

`LegPosition` in `marking.ts` gains the same required field, and `markLeg` copies it straight through.

- [ ] **Step 4: Carry it across the wire and into storage**

`WireAction`'s open variant and `BridgeLeg` each gain `readonly leanId?: string`. In `engine-host.ts`, wherever an `EngineAction` is turned into a `WireAction`, spread the field through rather than rebuilding the object field by field, so a future field cannot be dropped the same way. In `apps/api/src/book.ts`, the writer that turns a filled action into a `BridgeLeg` writes `leanId` when the action carried one, and omits the key entirely when it did not — never `leanId: undefined`, which Mongo stores as null and reads back as a value.

- [ ] **Step 5: Map it back in `#readBook`**

```ts
        openedByEngine: leg['origin'] === undefined,
        // Absent reads as '' rather than undefined: leanPnl matches on
        // equality, and an undefined would match an undefined lean id and
        // adopt every manual leg in the book.
        leanId: typeof leg['leanId'] === 'string' ? leg['leanId'] : '',
```

- [ ] **Step 6: Drop Task 7's placeholder**

In `delta-lean/lean.ts`, delete the module-local `stampOf()` and read `leg.leanId` directly. Keep `LeanLeg` only if something still needs it; if nothing does, delete it and say so.

- [ ] **Step 7: Run everything this touches**

Run: `npm test --workspace @algomaker/desk-engine && npm test --workspace @algomaker/api && npm test --workspace @algomaker/supervisor`
Expected: PASS. Parity must be green and unedited — a new optional field on the write path and a `''` default on the read path move no recenter decision. Test-helper `LegView`/`LegPosition` literals will need `leanId: ''`, exactly as they needed `theta: 0, vega: 0` in Task 2.

- [ ] **Step 8: Commit**

```bash
git add packages/desk-engine apps/api apps/supervisor
git commit -m "feat(delta-lean): stamp the lean id onto every leg it opens"
```

---

### Task 9B: Rulings on what Task 9 found

Task 9 composed the three modules and surfaced nineteen gaps. These are the rulings. Each is a real defect, not a preference; the rest of Task 9's findings are accepted as documented deviations and need no code.

**Files:** `packages/desk-engine/src/types.ts`, `packages/desk-engine/src/dials.ts`, `packages/desk-engine/src/delta-lean/decide.ts`, `packages/desk-engine/src/delta-lean/lean.ts`, `apps/supervisor/src/state-store.ts`, plus the tests that pin each one.

- [ ] **R1 — A working package must not outrank a cut.** Plan step 7 holds whenever `pendingLots > 0`, so a working ADD tranche blocks the per-lean stop and the trailing cut from ever being emitted. The host cannot cancel what the engine never says. Spec §8 is explicit that cuts pre-empt adds. **Move the working-package hold BELOW the two lean cuts** in the evaluation order, so a cut is emitted while a package is working and Task 10's host cancels the working add before routing it. Adds stay held. Test: a lean at its per-lean stop with `pendingLots > 0` emits the cut.

- [ ] **R2 — A stale spot refuses adds, not everything.** Plan step 8 holds on a stale spot, which blocks cuts too; `dl_spot_stale_s`'s own doc comment says adds only, and spec §6 agrees. Deciding a CUT on a slightly stale spot is safer than not cutting at all. **Refuse opens; let closes through.** Test: stale spot with a lean past its stop still emits the cut; stale spot in a trend opens nothing.

- [ ] **R3 — The lean's realized P&L needs a home.** `leanPnl` takes this lean's banked P&L, and `RuleState` carries only the day's. Add `dlLeanRealized: number` (zero-value 0) to `RuleState`, `EMPTY_RULE_STATE` and `hydrateRuleState`. **It resets to 0 whenever `dlLeanId` changes**, in the same write that changes it — a lean that inherits the previous lean's bank trails a peak that was never its own. Remove `leanRealized` from `DeltaLeanInputs` and read it from state. Test: opening a new lean zeroes it; a fold into the same lean accumulates.

- [ ] **R4 — Delete `dlDayRealized`.** Nothing writes it and nothing reads it, so it is always 0. The day budget is `totalPnl(inputs)`, which is `cumRealized + Σ leg.mtm` and correctly includes the open book — a stop that ignored unrealised loss would not be a stop. Remove the field from `RuleState`, `EMPTY_RULE_STATE`, `hydrateRuleState`, `rollDay` and `lean.ts`'s header, which currently names it as the budget input and is wrong.

- [ ] **R5 — Give `dl_chop_unwind_s` a clock.** It is unimplementable today because no timestamp records the last unwind, so Task 9 expressed "slower" as size instead and the dial is dead. Add `dlLastUnwindMs: number` to `RuleState`, `EMPTY_RULE_STATE` and `hydrateRuleState`, write it on every chop unwind, and gate the next unwind on it. Test: two unwinds inside the window emit one action; outside it, two.

- [ ] **R6 — Add the two pacing dials Task 10 needs.** Spec §8 wants at most 2 orders/second and a daily cap; only `dl_max_orders_min` exists, and one decision can emit four orders, so neither is enforceable in the engine. Add `dl_max_orders_s` (2) and `dl_max_orders_day` (600) to `Dials`, `DEFAULT_DIALS` and the `Delta lean` section. **The engine does not enforce them** — Task 10's host does, because it is the thing that counts routed orders over time. Add them with doc comments saying exactly that.

**Accepted without code, recorded so nobody re-finds them:** the gamma-scaled half of the dead band is not implemented and the flat `dl_dead_band_lots` stands alone; one `dlLeanId` cannot describe a strangle and a trend lean at once, so quiet-to-trend closes the strangle first at the cost of one loop; a reversal cut keeps the lean identity so flip caps bind while a stop or trail-to-zero clears it; `markCtx` is accepted and deliberately unread because the five-minute mark grid must not gate a per-second variant.

**Left for Task 10:** `makerQuote` is currently overloaded to carry urgency because it is the only channel an `EngineDecision` has. Task 10 adds a real `urgency: 'passive' | 'urgent' | 'ladder'` field and stops overloading it.

---

### Task 10: Host wiring — branch, cadence, damping, fast path

**Files:**
- Modify: `apps/supervisor/src/engine-host.ts:724` and `:839` (the two `decide()` call sites), `:1173-1191` (`#obviousBreach`), `:1336` (workMode), `:317-347` (trigger sets)
- Test: `apps/supervisor/test/engine-host-delta-lean.test.ts` (create)

**Interfaces:**
- Consumes: `decideDeltaLean` from Task 9, `dials.delta_lean_enabled` from Task 5
- Produces: `EngineHostDeps.ring?: SpotRing` and `EngineHostDeps.minutesToExpiry?(): number`; a per-book `lastEvalMs` cadence gate honouring `dl_eval_min_ms`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THE CUT THAT WAITED 30 SECONDS.
 *
 * #obviousBreach is gated on PHASE_R_TRIGGERS and on the action being an
 * open+Sell, so a delta-lean cut — a close, or a buy — could never take the
 * fast path, and the cooldown outranks the fast path anyway. On a book sized
 * at 9 delta-lots, thirty seconds of waiting is the difference between the
 * cut trigger and the day stop.
 */
test('a book with delta_lean_enabled routes to the delta-lean path', async () => {
  const host = hostWith({ dials: () => ({ ...DEFAULT_DIALS, delta_lean_enabled: true }) })
  await host.evaluate()
  assert.equal(spyDecideDeltaLean.calls, 1)
  assert.equal(spyDecide.calls, 0)
})

test('a book without it is untouched — the recenter path, exactly as before', async () => {
  const host = hostWith({ dials: () => DEFAULT_DIALS })
  await host.evaluate()
  assert.equal(spyDecide.calls, 1)
  assert.equal(spyDecideDeltaLean.calls, 0)
})

test('the cadence gate holds evaluation to dl_eval_min_ms', async () => {
  const host = hostWith({ dials: () => deltaLeanDials, now: clock })
  await host.evaluate(); clock.advance(400); await host.evaluate()
  assert.equal(spyDecideDeltaLean.calls, 1)      // 250ms timer, 1s gate
  clock.advance(700); await host.evaluate()
  assert.equal(spyDecideDeltaLean.calls, 2)
})

test('a delta-lean cut takes the fast path without the confirm wait', () => {
  const cut = decisionOf({ trigger: 'dl-cut', actions: [{ op: 'close', instrument: 'NIFTY...CE' }] })
  assert.equal(host.damped(cut, stateWithRecentAction, inputs, deltaLeanDials, NOW), true)
})

test('a delta-lean ADD still serves its confirm window', () => {
  const add = decisionOf({ trigger: 'dl-lean', actions: [{ op: 'open', side: 'Buy', strike: 24_000, optType: 'CE', lots: 1 }] })
  assert.equal(host.damped(add, freshState, inputs, deltaLeanDials, NOW), false)
  assert.equal(host.damped(add, freshState, inputs, deltaLeanDials, NOW + 1_100), true)
})

test('the recenter fast path is unchanged — a phase-R sale still qualifies', () => {
  assert.equal(host.damped(phaseRSale, state, inputs, DEFAULT_DIALS, NOW), true)
})

test('adds are passive, cuts are urgent, guard flattens are the blind ladder', () => {
  assert.equal(workModeFor(decisionOf({ trigger: 'dl-lean' })), undefined)   // passive-first default
  assert.equal(workModeFor(decisionOf({ trigger: 'dl-cut' })), 'urgent')
  assert.equal(workModeFor(decisionOf({ trigger: 'eod' })), undefined)       // ladder: no workMode
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test apps/supervisor/test/engine-host-delta-lean.test.ts`
Expected: FAIL.

- [ ] **Step 3: Branch at the two call sites**

```ts
const decision = dials.delta_lean_enabled
  ? decideDeltaLean({ ...inputs, ring: this.#ring, minutesToExpiry: this.#minutesToExpiry(), ordersThisMinute: this.#orderBudget.used() }, dials, state.ruleState, markCtx)
  : decide(inputs, dials, state.ruleState, markCtx)
```

- [ ] **Step 4: Widen the fast path without touching the recenter case**

```ts
const DL_CUT_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>(['dl-cut', 'dl-stop', 'dl-roll'])

#obviousBreach(decision: EngineDecision, inputs: EngineInputs, dials: Dials): boolean {
  // A delta-lean cut is always obvious: the controller only emits one once the
  // drawdown rule has already fired. Waiting re-asks a question already answered.
  if (dials.delta_lean_enabled && DL_CUT_TRIGGERS.has(decision.trigger)) return true
  if (!PHASE_R_TRIGGERS.has(decision.trigger)) return false
  // ... rest unchanged
}
```

The cooldown at `:1131` still outranks this, which is why `DELTA_LEAN_BASE` sets `cooldown_s: 0`. Add a test asserting `PRESETS.find(p => p.key.startsWith('delta-lean')).dials.cooldown_s === 0` so a retune cannot silently reintroduce the wait.

- [ ] **Step 5: Three urgency classes**

```ts
const workMode: WorkMode | undefined =
  LADDER_TRIGGERS.has(decision.trigger) ? undefined
  : URGENT_TRIGGERS.has(decision.trigger) ? 'urgent'
  : 'passive'
```

with `LADDER_TRIGGERS = new Set(['eod', 'expiry'])` and `URGENT_TRIGGERS = new Set(['lock', 'margin', 'dl-cut', 'dl-stop', 'dl-roll'])`. Guard against regression: the recenter guard triggers `'lock'` and `'margin'` keep `'urgent'`, and `'eod'`/`'expiry'` keep today's behaviour.

- [ ] **Step 6: Cadence gate**

In `main.ts:evaluateDue`, skip a book whose `nowMs - runtime.lastEvalMs < dials.dl_eval_min_ms` when `delta_lean_enabled`. Recenter books keep the tick-coalescing rule they have.

- [ ] **Step 7: Run both suites**

Run: `npm test --workspace @algomaker/supervisor && npm test --workspace @algomaker/desk-engine`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/supervisor/src/engine-host.ts apps/supervisor/src/main.ts apps/supervisor/test/engine-host-delta-lean.test.ts
git commit -m "feat(supervisor): route delta-lean books, and let their cuts skip the wait"
```

---

## Phase C — Feed, guard, delivery (Task 11 alone; then 12-13 in PARALLEL)

### Task 10A: Carry the lean stamp on the paper rail

**Why this task exists:** Task 9A found it and could not close it. On the LIVE rail the leg is written by `applyActions` in `apps/api/src/book.ts`, which carries `leanId`. On the PAPER rail the engine route answers `WORKING` and the leg is created later by `apps/api/src/paper-fold.ts` from `restoreView()` (`reconcile-live.ts:967`), which builds a meta-only `BridgeLeg` from the instrument master and carries no `leanId` at all. **The deliverable is four PAPER books.** Unfixed, the stamp stops at the gateway order, `leanPnl` matches nothing, and the entire add/cut/flip rule is inert on exactly the rail being shipped — silently, with every test green.

**Files:**
- Modify: `apps/api/src/rail.ts` (persist `leanId` on the gateway-order document)
- Modify: `apps/api/src/paper-fold.ts` (read it back onto the leg it creates)
- Modify: `apps/api/src/reconcile-live.ts` (`restoreView`, to accept and carry the stamp)
- Test: `apps/api/test/paper-stamp.test.ts` (create)

**Interfaces:**
- Consumes: `WireAction`'s optional `leanId` (Task 9A), already reaching desk-api
- Produces: the gateway-order document carries `leanId` when its action did; `paper-fold` writes it onto the `BridgeLeg` it creates

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THE PAPER RAIL FORGOT WHOSE BET IT WAS.
 *
 * Live legs are written by applyActions, which carries the stamp. Paper legs
 * are created later by the fold, from a view rebuilt out of the instrument
 * master — which knows the contract and nothing about the lean that asked for
 * it. Every test stays green while the four paper books quietly never add on a
 * winner and never cut on a loser.
 */
test('a paper fill lands a leg carrying the lean id its action had', async () => {
  await routeEngineDecision({ mode: 'paper', actions: [openWith({ leanId: 'dl-up-123' })] })
  await crossTheTick()
  const leg = await legOf(TAG, 'paper')
  assert.equal(leg.leanId, 'dl-up-123')
})

test('a paper fill with no lean id writes no key, not a null', async () => {
  await routeEngineDecision({ mode: 'paper', actions: [openWith({})] })
  await crossTheTick()
  assert.equal('leanId' in (await legOf(TAG, 'paper')), false)
})

test('the live rail is unchanged by this', async () => {
  await routeEngineDecision({ mode: 'live', actions: [openWith({ leanId: 'dl-up-9' })] })
  assert.equal((await legOf(TAG, 'live')).leanId, 'dl-up-9')
})
```

- [ ] **Step 2: Run it, confirm it fails on the first two, implement, run again**

Run: `npm test --workspace @algomaker/api`
Expected: the paper tests fail first (no `leanId` on the folded leg), then pass. The live test passes throughout — it is there to prove this change did not disturb the rail that already worked.

- [ ] **Step 3: Commit**

```bash
git add apps/api
git commit -m "fix(paper): carry the lean stamp through the fold"
```

---

### Task 10B: Do not re-open a position the book has not booked yet

**Why this task exists:** Task 10A found it. On the paper rail a leg is not written inside the request. The package goes terminal, `inFlight` clears, and only a later fold pass writes the leg — up to a fold interval afterwards. The controller runs every second. In that window `inputs.legs` is empty, so measured delta reads 0, so the difference step computes `excess = target - 0` and emits the whole unit **again**, against a position that already exists at the broker.

Verified in the source: `addCooled()` gates the three places that SET a target (`decide.ts:588`, `:619`, `:661`) but nothing gates the difference step that ACTS on one. Plan Task 9's own step 14 lists "add cooldown" under pacing; it was implemented in `targets()` only. The window is seconds on a passive peg, and the working-package hold does not cover it because the package is already terminal.

**Files:** `packages/desk-engine/src/delta-lean/decide.ts`, `packages/desk-engine/test/delta-lean-decide.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * THE BOOK THAT BOUGHT ITSELF TWICE.
 *
 * On the paper rail the leg appears a fold-pass after the order is done. Until
 * it does, the book measures as flat while the broker says otherwise, and the
 * difference step reads the whole target as missing. Nothing throws, nothing
 * is damped — the package was terminal, so the working hold has already let
 * go — and the book quietly carries double the size it chose.
 */
test('an open is refused while the add cooldown is still running', () => {
  // The lean is set and targeted, the package is terminal, and the leg has not
  // been booked yet. The controller must NOT read the empty book as room.
  const st = { ...EMPTY, dlLeanId: 'dl-up-1', dlLeanSide: 'up' as const, dlTargetLots: 1, dlLastAddMs: NOW - 2_000 }
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', legs: [], pendingLots: 0, nowMs: NOW }), DIALS, st, MARK)
  assert.equal(d.actions.filter((a) => a.op === 'open').length, 0)
})

test('the same book opens once the cooldown has elapsed', () => {
  const st = { ...EMPTY, dlLeanId: 'dl-up-1', dlLeanSide: 'up' as const, dlTargetLots: 1, dlLastAddMs: NOW - 16_000 }
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', legs: [], pendingLots: 0, nowMs: NOW }), DIALS, st, MARK)
  assert.ok(d.actions.some((a) => a.op === 'open'))
})

test('a CUT is never held by the add cooldown', () => {
  // The cooldown exists to stop the book buying twice. A cut has the opposite
  // risk profile and must not wait behind it.
  const st = { ...EMPTY, dlLeanId: 'dl-up-1', dlLeanSide: 'up' as const, dlTargetLots: 4, dlLastAddMs: NOW - 1_000 }
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', leanPnl: -37_501, legs: [longCall()], nowMs: NOW }), DIALS, st, MARK)
  assert.ok(d.actions.length > 0)
})

test('every emitted open stamps dlLastAddMs, wherever it came from', () => {
  // The three target-setting sites stamp it. The difference step emits opens
  // too, and one that does not stamp leaves the next loop uncooled.
  const d = decideDeltaLean(inputsIn({ regime: 'trend-up', legs: [] }), DIALS, EMPTY, MARK)
  if (d.actions.some((a) => a.op === 'open')) assert.notEqual(d.stateAfter.dlLastAddMs, 0)
})
```

- [ ] **Step 2: Run them, confirm the first fails, implement, run again**

Gate the difference step's OPEN branch on `addCooled(st, dials, now)` and stamp `dlLastAddMs` on every package that contains an open, wherever in the file it was formed. Closes are never gated — the cooldown exists to stop the book buying twice, and a cut has the opposite risk profile.

- [ ] **Step 3: Commit**

```bash
git add packages/desk-engine
git commit -m "fix(delta-lean): gate the open on the add cooldown, not just the target"
```

**Recorded, no code:** paper and live disagree on two more things and both are acceptable. `openedTs` is the decision instant on live and the fold-pass instant on paper, so anything per-leg and time-based reads a slightly younger leg on paper. `entryPrice` is the decision-time mark on live and the simulator's actual fill on paper — a fidelity improvement, but it means a paper book and a live book will not reconcile leg for leg from the same decisions.

---

### Task 11: Index spot into the supervisor

The supervisor subscribes only to `md.tick` and its token set is the future plus the option chain. The index spot token is not in it, so the regime detector has nothing to read.

**Files:**
- Modify: `apps/supervisor/src/main.ts` (a second `bus.subscribe`, near `:346`)
- Test: `apps/supervisor/test/spot-feed.test.ts` (create)

**Interfaces:**
- Consumes: `md.spot` payload `{ underlying: string; price: number; ts: number }`, filtered on `underlying` matching a managed book's symbol
- Produces: one `SpotRing` per symbol, handed to each `EngineHost` via `EngineHostDeps.ring`; and `spotFor(symbol)` for Task 3's fallback

- [ ] **Step 1: Write the failing test**

```ts
/**
 * 'NIFTY', NOT 'NIFTY 50'.
 *
 * Options list under NIFTY; the index itself is "NIFTY 50" in the dump.
 * md.spot publishes the CANONICAL key. Filtering on the wrong one yields a
 * ring that never fills, a detector that always reads 'unknown', and a book
 * that silently never trades.
 */
test('spot ticks land in the ring under the canonical symbol', () => {
  sup.onSpot({ underlying: 'NIFTY', price: 24_000, ts: NOW })
  assert.equal(sup.ringFor('NIFTY').size, 1)
})

test('a symbol no book manages is ignored', () => {
  sup.onSpot({ underlying: 'BHEL', price: 250, ts: NOW })
  assert.equal(sup.ringFor('BHEL'), undefined)
})

test('SENSEX is carried too', () => {
  sup.onSpot({ underlying: 'SENSEX', price: 81_000, ts: NOW })
  assert.equal(sup.ringFor('SENSEX').size, 1)
})
```

- [ ] **Step 2: Run it, confirm it fails, implement, run again**

Subscribe once at boot; keep a `Map<string, SpotRing>` keyed by symbol, created lazily for symbols that a managed book names. Ring capacity 4096, about 68 minutes at one sample per second, comfortably covering the 15-minute context window. Confirm `DESK_UNIVERSE` already contains NIFTY and SENSEX (it does by default).

- [ ] **Step 3: Commit**

```bash
git add apps/supervisor/src/main.ts apps/supervisor/test/spot-feed.test.ts
git commit -m "feat(supervisor): feed index spot to the regime detector"
```

---

### Task 12: Day-guard coverage for books (PARALLEL with 13)

Registering a book already creates a companion `desk-strategies` row (`apps/api/src/routes/books.ts:276-279`) but with no `dailyLimits`, so `isArmed()` is false and the book is silently unguarded. This is defence in depth behind the engine's own day stop, not a replacement for it.

**Files:**
- Modify: `apps/api/src/routes/books.ts:276-279`
- Test: `apps/api/test/books-day-guard.test.ts` (create)

**Interfaces:**
- Consumes: `StrategyRow.dailyLimits` (`apps/api/src/strategies.ts:246`), `isArmed` (`day-guard.ts:264`)
- Produces: the companion row carries `dailyLimits: { stop: dials.dl_day_max_loss }` when `delta_lean_enabled` is set

- [ ] **Step 1: Write the failing test**

```ts
/**
 * A STOP THE OPERATOR CANNOT REACH IS NOT A STOP.
 *
 * day-guard.ts never imports books-registry.ts. A book's companion strategy
 * row exists but carries no dailyLimits, so isArmed() is false and runGuards
 * skips it in silence. The engine has its own day stop; this is the second
 * one, for the case where the engine is the thing that is wrong.
 */
test('registering a delta-lean book arms the day guard', async () => {
  await post('/v1/desk/books/registry', bookCreate({ dials: { delta_lean_enabled: true, dl_day_max_loss: 100_000 } }))
  const row = await strategies.findOne({ tag: TAG })
  assert.equal(isArmed(row), true)
  assert.equal(row.dailyLimits.stop, 100_000)
})

test('a recenter book is registered exactly as before', async () => {
  await post('/v1/desk/books/registry', bookCreate({ dials: {} }))
  assert.equal(isArmed(await strategies.findOne({ tag: TAG })), false)
})
```

- [ ] **Step 2: Run it, confirm it fails, implement, run again**

Run: `npm test --workspace @algomaker/api`

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/books.ts apps/api/test/books-day-guard.test.ts
git commit -m "feat(books): arm the day guard for delta-lean books"
```

---

### Task 13: Register the four paper books (PARALLEL with 12)

There is no CLI path for registry rows — creation is HTTP only, two calls per book. This makes it reproducible.

**Files:**
- Create: `scripts/delta-lean-books.mjs`
- Create: `docs/runbooks/delta-lean-paper.md`
- Test: `apps/api/test/delta-lean-registration.test.ts` (create)

**Interfaces:**
- Consumes: `POST /v1/desk/books/registry` with `BookCreate` (`apps/api/src/books-registry.ts:80-87`), then `POST /v1/desk/books/registry/:tag/start`; `presetDials(key)` from `apps/web/src/dials-plan.ts:109-112`
- Produces: four registry rows, `desired: 'running'`, `mode: 'paper'`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * FOUR BOOKS, AND NOT ONE OF THEM LIVE.
 *
 * The one thing this script must never do is create a live row. The gates
 * behind it are good, but the cheapest place to be certain is here.
 */
test('every book the script plans is paper', () => {
  for (const b of planBooks({ nifty: '2026-09-22', sensex: '2026-09-24' })) assert.equal(b.mode, 'paper')
})

test('four books: two symbols times two presets', () => {
  const books = planBooks({ nifty: '2026-09-22', sensex: '2026-09-24' })
  assert.equal(books.length, 4)
  assert.deepEqual(books.map((b) => b.tag).sort(), [
    'NIFTY-2026-09-22-delta-lean-aggressive', 'NIFTY-2026-09-22-delta-lean-conservative',
    'SENSEX-2026-09-24-delta-lean-aggressive', 'SENSEX-2026-09-24-delta-lean-conservative',
  ].sort())
})

test('each book carries its preset dials, resolved not referenced', () => {
  const agg = planBooks(EXPIRIES).find((b) => b.tag.endsWith('aggressive'))!
  assert.equal(agg.dials.delta_lean_enabled, true)
  assert.equal(agg.dials.dl_max_lean_lots, 9)
  assert.equal(agg.dials.cooldown_s, 0)
})

test('expiries come from the instrument master, never from a hardcoded weekday', () => {
  // INDEX_UNDERLYINGS says NIFTY expires Thursday and its lot is 75. Both are
  // stale. Anything reading them mis-sizes every order in the book.
  const spy = masterSpy()
  planBooks(expiriesFrom(spy))
  assert.ok(spy.nearestExpiryCalls >= 2)
})
```

- [ ] **Step 2: Run it, confirm it fails, implement the script**

The script takes `--dry-run` (default) and `--apply`. It resolves each symbol's nearest weekly with at least one day to go via `OptionMaster.nearestExpiry`, builds four `BookCreate` payloads with `presetDials(...)`, prints them, and on `--apply` POSTs create-then-start for each. It refuses to run if any resolved payload has `mode !== 'paper'`.

- [ ] **Step 3: Write the runbook**

`docs/runbooks/delta-lean-paper.md` covers: `make sync` first so lot size, strike step and freeze limits are current (NIFTY lot is 65 as of Jan 2026 and SENSEX freeze is unverified); `DESK_RECORD_TICKS=1` for the replay tape; `node scripts/delta-lean-books.mjs --dry-run` then `--apply`; what to watch on day one (the book's first decision, the regime journal, whether the 15:00 flatten completed); and how to stop a book (`POST /v1/desk/books/registry/:tag/stop`).

- [ ] **Step 4: Verify end to end against a live-ish stack**

Run: `node scripts/delta-lean-books.mjs --dry-run`
Expected: four payloads printed, every one `mode: 'paper'`, expiries resolved from the master, dials showing `delta_lean_enabled: true`.

- [ ] **Step 5: Commit**

```bash
git add scripts/delta-lean-books.mjs docs/runbooks/delta-lean-paper.md apps/api/test/delta-lean-registration.test.ts
git commit -m "feat(scripts): register the four delta-lean paper books"
```

---

## Final gate

- [ ] `make check` passes: typecheck plus every suite, parity included.
- [ ] `git log --oneline` shows thirteen commits, one per task.
- [ ] `node scripts/delta-lean-books.mjs --dry-run` prints four paper books.
- [ ] No recenter decision moved: `parity.test.ts` and `parity-shift.test.ts` are untouched and green.

## Deliberately not in this plan

- **SIGTERM flatten.** `apps/supervisor/src/main.ts:44-57` forbids it with no opt-out, after a 2026-08-17 incident where a memory-limit restart flattened the hosted book. Task 9's boot-time flatten covers the same risk without touching an invariant the recenter books depend on.
- **Paper-fill slippage.** The simulator fills a limit order at the crossing tick with zero slippage (`packages/brokers/src/simulator.ts`). The spec's "touch plus one tick" would need a new slippage term; paper results will read slightly optimistic until then, and the runbook says so.
- **The 2027 holiday table.** `session.ts:101-105` fails open on an uncovered year, and its own test asserts that. It must be replaced before January 2027, which is outside this work.
- **A replay harness.** Task 4 records the tape; the tool that replays it through `decideDeltaLean` to tune thresholds is separate work, and is only useful once a few weeks of tape exist.
- **Live enablement.** Decision D10: the deliverable ends at four paper books.
