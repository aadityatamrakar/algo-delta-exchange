# Delta-lean v2 — hold-and-adjust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the delta-lean controller with a hold-and-adjust engine that opens one hedged package a day, never closes a leg before the close except on four exits, and neutralises by ADDING.

**Architecture:** `packages/desk-engine/src/delta-lean/decide.ts` is rewritten from scratch against spec §5–§6. `regime.ts` is untouched. `express.ts` keeps `tradableStrikes`, `deltaBandStrike`, `debitUnit`, `creditUnit` and loses everything the deleted rules read. `lean.ts` shrinks to `rollDay`. `RuleState`'s `dl*` half and the `TRIGGERS` list are replaced. The host renames one trigger set and folds realised closes into a new `dlDayRealized`.

**Tech Stack:** TypeScript (node 22 native type stripping), `node:test` + `node:assert/strict` for `packages/*` and `apps/{api,supervisor}`, vitest + jsdom for `apps/web`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-delta-lean-hold-adjust-design.md` — read it alongside this plan; every task argues from it.

## Global Constraints

- **Family/preset/variant names are unchanged** (spec D1). Preset keys stay `delta-lean-aggressive` and `delta-lean-conservative`; the dial that selects the engine stays `delta_lean_enabled`; `scripts/delta-lean-roll.mjs` is not edited.
- **Adds only until the close** (spec D2). No rule in `decide.ts` may emit a `close` or `resize` except the four exits of spec §6.5: `eod`, `dl-stop`, `dl-target`, `dl-stuck`.
- **The cap is `margin_cap`, priced with `spanLiteMargin` on the whole package** (spec D4). `margin_cap` is `2_500_000` in both delta-lean presets.
- **Sizing is in CONTRACT LOTS** (spec D7). `dl_open_lots` is 4 aggressive / 2 conservative.
- **`dl_day_max_loss` default is `200000`**; `dl_max_orders_day` default is `40`.
- **`resolveDials` must IGNORE unknown stored keys** rather than reject the row (spec §4). It already does — every unrecognised key is collected into `unknown` and the resolved set still returns; the constraint is to KEEP that and pin it with a test.
- **PURE**: `decide.ts` takes no clock, no feed, no Mongo. `nowMs`, `dateIst` and `minuteOfDay` are fields of `inputs`.
- **Every `LegView.delta` is an UNSIGNED MAGNITUDE**; `wingSign` (CE +1, PE −1) and `sideSign` (Buy +1, Sell −1) are applied exactly once, in `legDeltaLots`. Nothing downstream reapplies either.
- **`closeAll` orders shorts first** (buy back shorts before selling longs), always.
- **Two engines, one `RuleState` row.** No recenter field (`rcCredit`, `gkAnchor`, `scrapBanned`, `rcStack`, `lastActionMs`, …) may change meaning or disappear.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `packages/desk-engine/src/types.ts` | `RuleState`'s eleven `dl*` fields, `EMPTY_RULE_STATE`, the six `TRIGGERS`. |
| `packages/desk-engine/src/dials.ts` | The `Dials` schema, `DEFAULT_DIALS`, `DIAL_KEYS`, `DIAL_SECTIONS`, `resolveDials`. |
| `packages/desk-engine/src/presets.ts` | `DELTA_LEAN_BASE` + the two preset rows. |
| `packages/desk-engine/src/delta-lean/regime.ts` | **UNCHANGED.** The detector. |
| `packages/desk-engine/src/delta-lean/express.ts` | Strike/structure vocabulary only: `tradableStrikes`, `deltaBandStrike`, `debitUnit`, `creditUnit`. |
| `packages/desk-engine/src/delta-lean/lean.ts` | `rollDay` and nothing else. |
| `packages/desk-engine/src/delta-lean/decide.ts` | `decideDeltaLean` — spec §5's order, §6's rules. Rewritten. |
| `packages/desk-engine/src/index.ts` | The barrel; drops nothing but re-exports the shrunk modules. |
| `apps/supervisor/src/state-store.ts` | Hydrates the new `dl*` fields. |
| `apps/supervisor/src/engine-host.ts` | `DL_EXIT_TRIGGERS`, `#settle` → `dlDayRealized`, `#rollBack` keeps `dlLastAdjustMs`. |
| `apps/web/src/dials-plan.ts` | The dial meta rows and the `DELTA_LEAN_GROUPS` table. |
| `scripts/delta-lean-books.mjs` | `HEADLINE_DIALS`. |
| `docs/runbooks/delta-lean-paper.md` | "What it does" and the risk-dial paragraph. |

---

### Task 1: Types — the new `dl*` state, the new triggers

**Files:**
- Modify: `packages/desk-engine/src/types.ts:212-243` (TRIGGERS), `:408-497` (RuleState + EMPTY_RULE_STATE)
- Modify: `apps/supervisor/src/state-store.ts:344-378` (the `// ── delta lean ──` hydration block) and `:390-392` (`leanSide`)
- Test: `packages/desk-engine/test/types.test.ts:33-74`
- Test: `apps/supervisor/test/state-store.test.ts:285-350`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `TRIGGERS` gains `'dl-open' | 'dl-neutral' | 'dl-add' | 'dl-target' | 'dl-stuck'`, keeps `'dl-stop'`, drops `'dl-lean' | 'dl-cut' | 'dl-flip' | 'dl-theta' | 'dl-roll'`. `export type Trigger = (typeof TRIGGERS)[number]`.
  - `RuleState`'s delta-lean half is exactly these eleven fields, all REQUIRED:
    ```ts
    readonly dlDayStarted: string;
    readonly dlStopped: boolean;
    readonly dlOpenedMs: number;
    readonly dlOpenSide: 'up' | 'down' | 'none' | '';
    readonly dlAdjustsToday: number;
    readonly dlLastAdjustMs: number;
    readonly dlLastAdjustRegime: string;
    readonly dlRegime: string;
    readonly dlRegimeSinceMs: number;
    readonly dlBlockedSinceMs: number;
    readonly dlDayRealized: number;
    ```
  - `EMPTY_RULE_STATE` carries `dlDayStarted: '', dlStopped: false, dlOpenedMs: 0, dlOpenSide: '', dlAdjustsToday: 0, dlLastAdjustMs: 0, dlLastAdjustRegime: '', dlRegime: '', dlRegimeSinceMs: 0, dlBlockedSinceMs: 0, dlDayRealized: 0`.
  - `LegView.leanId` and the `op: 'open'` action's optional `leanId` **STAY** (spec §3: "`LegView.leanId` stays as an opaque package stamp if the fold path needs it"). `apps/api/src/paper-fold.ts`, `apps/api/src/contract.ts`, `apps/api/src/book.ts` and `state-store.ts`'s `BridgeLeg.leanId` are NOT touched by this plan. The new engine simply never sets it, so every delta-lean leg reads `''`.
  - `apps/supervisor/src/state-store.ts` exports `hydrate`-adjacent helper `openSide(v: unknown): RuleState['dlOpenSide']` replacing the file-local `leanSide`.

- [ ] **Step 1: Write the failing test — the state shape**

Replace `packages/desk-engine/test/types.test.ts:33-74` (the whole `EMPTY_RULE_STATE spells out every zero-value` test) with:

```ts
test('EMPTY_RULE_STATE spells out every zero-value', () => {
  assert.deepEqual(EMPTY_RULE_STATE, {
    rcCredit: 0,
    rcEodDay: '',
    gkAnchor: 0,
    gkStreak: 0,
    scrapBanned: [],
    targetStreak: 0,
    targetLocked: false,
    rcStack: [],
    lastActionMs: 0,
    // The delta-lean book's half of the row (hold-and-adjust spec §3). Listed
    // one by one for the same reason as the recenter half: this literal IS the
    // field-for-field agreement between `RuleState` and `EMPTY_RULE_STATE`, and
    // a new field that reaches production without an explicit zero-value here
    // is the absent-vs-zero trap reopening.
    //
    // There is ONE P&L level now, and it is the DAY's. `dlDayRealized` is
    // written by the host's `#settle` and read by nothing in the engine — the
    // day budget and the day target are both `totalPnl(inputs)`, banked plus
    // the open book's mark, because a number counting only BANKED money would
    // ignore the open loss the backstop exists to stop.
    dlDayStarted: '',
    dlStopped: false,
    dlOpenedMs: 0,
    dlOpenSide: '',
    dlAdjustsToday: 0,
    dlLastAdjustMs: 0,
    dlLastAdjustRegime: '',
    dlRegime: '',
    dlRegimeSinceMs: 0,
    dlBlockedSinceMs: 0,
    dlDayRealized: 0,
  })
  assert.equal(SUPERVISOR_NUDGE_PORT_DEFAULT, 8793)
})

test('the trigger list is the hold-and-adjust set, and the old controller`s five are gone', () => {
  // desk-api validates an incoming trigger against this VALUE
  // (`apps/api/src/routes/engine.ts`), so a trigger the engine can emit and the
  // list does not name is a 400 on the wire — and one the list names and no
  // rule emits is a name an operator will look for in a journal and never find.
  for (const t of ['dl-open', 'dl-neutral', 'dl-add', 'dl-target', 'dl-stuck', 'dl-stop']) {
    assert.ok(TRIGGERS.includes(t as Trigger), `${t} must be a trigger`)
  }
  for (const gone of ['dl-lean', 'dl-cut', 'dl-flip', 'dl-theta', 'dl-roll']) {
    assert.ok(!(TRIGGERS as readonly string[]).includes(gone), `${gone} is deleted`)
  }
  // The recenter engine's eleven are untouched — widening or narrowing the
  // delta-lean half must move nothing on the other decide path.
  assert.deepEqual(
    TRIGGERS.filter((t) => !t.startsWith('dl-')),
    ['shift', 'shed', 'scrap', 'lock', 'margin', 'expiry', 'eod', 'recycle', 'unwind', 'balance', 'none'],
  )
})
```

Add `TRIGGERS` and `type Trigger` to the import block at `packages/desk-engine/test/types.test.ts:20-27`.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/types.test.ts`
Expected: FAIL — `deepEqual` reports the old `dlLean*`/`dlFlips*` keys present and the new ones missing; the trigger test reports `dl-open` missing.

- [ ] **Step 3: Replace the TRIGGERS block**

`packages/desk-engine/src/types.ts` — replace lines 220-243 (from `export const TRIGGERS = [` through `] as const;`) with:

```ts
export const TRIGGERS = [
  'shift', 'shed', 'scrap', 'lock', 'margin', 'expiry',
  'eod', 'recycle', 'unwind', 'balance', 'none',
  // ── THE DELTA-LEAN BOOK's own six ────────────────────────────────────────
  // In the SAME list rather than a second one: desk-api validates an incoming
  // `trigger` against this value, and a second list is a second copy that
  // agrees today and drifts silently tomorrow.
  //
  // Widening it moves NO existing decision. `GUARD_TRIGGERS`, `PHASE_R_TRIGGERS`
  // and `DL_EXIT_TRIGGERS` in `apps/supervisor/src/engine-host.ts` are explicit
  // sets, not complements, so nothing here joins them by accident.
  //
  //   dl-stop     the day's rupee backstop tripped; terminal until the day rolls
  //   dl-open     the one package of the day went on (§6.1)
  //   dl-add      a pyramid: the trend is the side the book already leans (§6.2)
  //   dl-neutral  an add that NEUTRALISES — the flip buy, or the sideways sell
  //   dl-target   the day target was made; the book banks it and stops
  //   dl-stuck    the cap or the adjust limit blocks every move and the book is
  //               losing: minimise the downside and stop
  //
  // ADDS ONLY (D2). Of the six, exactly three take risk off — `dl-stop`,
  // `dl-target`, `dl-stuck` — and they are `DL_EXIT_TRIGGERS`. `dl-open`,
  // `dl-add` and `dl-neutral` can never carry a close.
  'dl-stop', 'dl-open', 'dl-add', 'dl-neutral', 'dl-target', 'dl-stuck',
] as const;
```

- [ ] **Step 4: Replace the `RuleState` delta-lean half**

`packages/desk-engine/src/types.ts` — replace lines 421-487 (from the `// ── THE DELTA-LEAN BOOK …` comment through `readonly dlLastUnwindMs: number;`) with:

```ts
  // ── THE DELTA-LEAN BOOK (hold-and-adjust spec §3) ─────────────────────────
  // A second decide path shares this one state row, so every field below is
  // prefixed `dl`. None of it is read by a recenter book and none of it is
  // written by one — but it is REQUIRED here, not optional, for the reason the
  // file header gives: an absent `dlStopped` and a book that has not stopped
  // must never be the same read.
  //
  // ONE P&L LEVEL, and it is the DAY's. The v1 controller had two — the lean's
  // own peak and bank beside the day's — because it added on a new peak and cut
  // on the drawdown from it. This engine does neither: it opens once, adjusts
  // by adding, and exits on the day target, the day backstop, the clock or the
  // stuck rule. All four read `totalPnl(inputs)` (banked plus the open book's
  // mark), so the only stored money is `dlDayRealized`, which the host's
  // `#settle` writes for the ledger and the dashboard and the engine reads
  // nowhere. A budget that counted only banked money would sail past an
  // unrealised loss it exists to stop.

  /** The IST date this book last reset itself for. '' = never. */
  readonly dlDayStarted: string;
  /**
   * TERMINAL FOR THE DAY once set, and cleared only by a new `dlDayStarted`.
   *
   * Set by the EOD flatten, the day target and the stuck exit once the book is
   * flat, and by the day-loss backstop IMMEDIATELY — a backstop that waited for
   * the flatten to fill could add one more package into the loss it fired on.
   */
  readonly dlStopped: boolean;
  /** 0 = not opened today. The day's ONE package (D3) went on at this instant. */
  readonly dlOpenedMs: number;
  /** What the open expressed. 'none' = a quiet-regime strangle. '' = not opened. */
  readonly dlOpenSide: 'up' | 'down' | 'none' | '';
  /** Adjustment packages routed today, AFTER the open. Capped by
   * `dl_max_adjusts_day`; the open itself is not counted. */
  readonly dlAdjustsToday: number;
  /** The cooldown's reference. THE OPEN COUNTS AS THE FIRST package, so the
   * first adjustment is a full `dl_adjust_cooldown_s` after the open rather
   * than available on the next tick. 0 = nothing routed today. */
  readonly dlLastAdjustMs: number;
  /**
   * The regime that justified the last package — open or adjustment.
   *
   * THE SAME REGIME NEVER JUSTIFIES TWO PACKAGES IN A ROW (§5 step 7). This is
   * what stops a trend that merely persists from pyramiding every cooldown: the
   * tape has to change its mind and come back before the book adds again.
   * '' = nothing routed today.
   */
  readonly dlLastAdjustRegime: string;
  /** The detector's last classification. '' = not yet classified (warm-up),
   * never "quiet" — a book that has not measured is not a calm one. */
  readonly dlRegime: string;
  /** When `dlRegime` last CHANGED. The confirmation reference for
   * `dl_adjust_confirm_s`, and the day roll anchors it at the roll instant so
   * the morning's first confirm window is measured from this session. */
  readonly dlRegimeSinceMs: number;
  /**
   * 0, or when an adjustment first became WANTED-BUT-BLOCKED by the margin cap
   * or by `dl_max_adjusts_day`. The stuck exit's clock (§6.4).
   *
   * Reset to 0 on any tick where the block clears OR the loss condition clears,
   * so the clock measures one continuous stretch rather than a total.
   */
  readonly dlBlockedSinceMs: number;
  /**
   * Realised rupees today, folded by the host's `#settle` (spec §7).
   *
   * WRITTEN BY THE HOST, READ BY NOBODY IN THE ENGINE, and that asymmetry is
   * deliberate: the exits all read `totalPnl`, which already includes the same
   * money through `cumRealized`. This field exists so a ledger row, the run
   * page and an operator can see the day's banked half on its own without
   * subtracting a mark. Zeroed by the day roll; `cumRealized` is not (it is the
   * TAG's bank, and a delta-lean tag lives one trading day anyway).
   */
  readonly dlDayRealized: number;
```

Then replace `EMPTY_RULE_STATE`'s delta-lean half (lines 488-496) so the literal reads:

```ts
export const EMPTY_RULE_STATE: RuleState = {
  rcCredit: 0, rcEodDay: '', gkAnchor: 0, gkStreak: 0, scrapBanned: [],
  targetStreak: 0, targetLocked: false, rcStack: [], lastActionMs: 0,
  dlDayStarted: '', dlStopped: false,
  dlOpenedMs: 0, dlOpenSide: '',
  dlAdjustsToday: 0, dlLastAdjustMs: 0, dlLastAdjustRegime: '',
  dlRegime: '', dlRegimeSinceMs: 0,
  dlBlockedSinceMs: 0, dlDayRealized: 0,
};
```

Leave `LegView.leanId` (line 94) and the open action's `leanId` (line 188) exactly as they are — see the Interfaces block.

- [ ] **Step 5: Run the types test**

Run: `node --test packages/desk-engine/test/types.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing state-store test**

Replace the body of the round-trip test at `apps/supervisor/test/state-store.test.ts:285-350` with:

```ts
test('the delta-lean half of the rule state survives a Mongo round trip', async () => {
  /**
   * Field by field, because each one is a different kind of silent failure:
   *   - a dropped `dlStopped` re-opens a book that stopped itself
   *   - a dropped `dlOpenedMs` makes an OPENED book open a second package
   *   - a dropped `dlLastAdjustRegime` lets the same regime justify two
   *     packages in a row, which is the pyramiding this engine exists to stop
   *   - a dropped `dlBlockedSinceMs` restarts the stuck clock on every restart,
   *     so the stuck exit can never fire on a book that keeps being restarted
   */
  const { store, col } = make()
  const written: Partial<RuleState> = {
    dlDayStarted: DATE,
    dlStopped: true,
    dlOpenedMs: T0 - 900_000,
    dlOpenSide: 'up',
    dlAdjustsToday: 3,
    dlLastAdjustMs: T0 - 300_000,
    dlLastAdjustRegime: 'chop',
    dlRegime: 'trend-up',
    dlRegimeSinceMs: T0 - 120_000,
    dlBlockedSinceMs: T0 - 60_000,
    dlDayRealized: -3_200.5,
  }
  await store.update(TAG, 'paper', (s) => ({ ...s, ruleState: { ...s.ruleState, ...written } }))
  const back = (await store.read(TAG, 'paper')).ruleState
  for (const [k, v] of Object.entries(written)) {
    assert.deepEqual(back[k as keyof RuleState], v, `${k} must round trip`)
  }
  assert.equal(col.docs.length, 1)
})

test('an unrecognised open side reads as "not opened", never as a side the book never chose', () => {
  // The controller branches on this value: a string that is not one of the four
  // would send a book down the up-lean branch with a side nobody picked.
  const s = hydrateRuleState({ dlOpenSide: 'sideways', dlOpenedMs: 1 })
  assert.equal(s.dlOpenSide, '')
})

test('a document written by the v1 controller hydrates as a book that has not opened', () => {
  // Today's stored rows carry `dlLeanId`/`dlLeanPeak`/`dlFlipsToday` and none of
  // the new keys. An unknown key has always been ignored by this hydrator, and
  // a missing one takes its EMPTY_RULE_STATE zero — so yesterday's row reads as
  // a book with no open, no adjustments and no stuck clock, which is exactly
  // what it is under the new rules.
  const s = hydrateRuleState({
    dlLeanId: 'dl-up-1789533000000',
    dlLeanSide: 'up',
    dlLeanPeak: 21_400.75,
    dlFlipsToday: 2,
    dlDayStarted: DATE,
    dlStopped: true,
  })
  assert.equal(s.dlDayStarted, DATE)
  assert.equal(s.dlStopped, true, 'a stop the book set itself survives the engine swap')
  assert.equal(s.dlOpenedMs, 0)
  assert.equal(s.dlOpenSide, '')
  assert.equal(s.dlAdjustsToday, 0)
  assert.equal(s.dlLastAdjustRegime, '')
  assert.equal(s.dlBlockedSinceMs, 0)
  assert.equal(s.dlDayRealized, 0)
})
```

If `hydrateRuleState` is not already exported from `apps/supervisor/src/state-store.ts`, export it (`export function hydrateRuleState(d: Record<string, unknown>): RuleState`) and import it in the test beside `StateStore`.

- [ ] **Step 7: Run it and watch it fail**

Run: `node --test apps/supervisor/test/state-store.test.ts`
Expected: FAIL — `hydrateRuleState` is not exported and/or the new keys are not hydrated.

- [ ] **Step 8: Rewrite the hydration block**

`apps/supervisor/src/state-store.ts` — replace lines 344-378 (the `// ── delta lean ──` block through the closing `dlLastUnwindMs` / `dlDayRealized` comment) with:

```ts
    // ── delta lean (hold-and-adjust spec §3) ──
    //
    // Hydrated field by field like everything above, and for the same reason: a
    // stored document is whatever was written by whatever version wrote it. A
    // row written by the v1 controller carries `dlLeanId`, `dlLeanPeak` and the
    // flip counters and NONE of the eleven below — every one of those is an
    // unknown key, which this hydrator has always ignored, and every field here
    // falls back to its `EMPTY_RULE_STATE` zero. So yesterday's row reads back
    // as a book that has not opened, which is what it is under these rules.
    // `dlStopped` and `dlDayStarted` are the two that carry over by name, and
    // that is the half that matters: a mid-session restart must never clear a
    // stop the book set itself.
    dlDayStarted: str(d['dlDayStarted'], EMPTY_RULE_STATE.dlDayStarted),
    dlStopped: bool(d['dlStopped'], EMPTY_RULE_STATE.dlStopped),
    dlOpenedMs: num(d['dlOpenedMs'], EMPTY_RULE_STATE.dlOpenedMs),
    dlOpenSide: openSide(d['dlOpenSide']),
    dlAdjustsToday: num(d['dlAdjustsToday'], EMPTY_RULE_STATE.dlAdjustsToday),
    dlLastAdjustMs: num(d['dlLastAdjustMs'], EMPTY_RULE_STATE.dlLastAdjustMs),
    dlLastAdjustRegime: str(d['dlLastAdjustRegime'], EMPTY_RULE_STATE.dlLastAdjustRegime),
    dlRegime: str(d['dlRegime'], EMPTY_RULE_STATE.dlRegime),
    dlRegimeSinceMs: num(d['dlRegimeSinceMs'], EMPTY_RULE_STATE.dlRegimeSinceMs),
    dlBlockedSinceMs: num(d['dlBlockedSinceMs'], EMPTY_RULE_STATE.dlBlockedSinceMs),
    dlDayRealized: num(d['dlDayRealized'], EMPTY_RULE_STATE.dlDayRealized),
```

Replace `leanSide` (lines 383-392, comment included) with:

```ts
/**
 * A stored OPEN SIDE, or `''`.
 *
 * Narrowed rather than cast: the controller branches on this value, and a
 * string that is not one of the four would send a book down the up-side branch
 * with a side it never chose. Anything unrecognised reads as "not opened",
 * which is the state that opens the day's package.
 */
function openSide(v: unknown): RuleState['dlOpenSide'] {
  return v === 'up' || v === 'down' || v === 'none' ? v : ''
}
```

- [ ] **Step 9: Run the state-store test**

Run: `node --test apps/supervisor/test/state-store.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

The rest of the tree does not compile yet — `decide.ts`, `lean.ts` and `engine-host.ts` still name the deleted fields. That is expected and is Tasks 3, 4 and 9's work; do NOT chase it here.

```bash
git add packages/desk-engine/src/types.ts packages/desk-engine/test/types.test.ts \
        apps/supervisor/src/state-store.ts apps/supervisor/test/state-store.test.ts
git commit -m "feat(types): the hold-and-adjust dl state and trigger set"
```

---

### Task 2: Dials and presets

**Files:**
- Modify: `packages/desk-engine/src/dials.ts:112-158` (the `dl_*` schema fields), `:277-404` (the `dl_*` defaults), `:560-630` (the `delta-lean` section's `fields` array)
- Modify: `packages/desk-engine/src/presets.ts:185-198` (`DELTA_LEAN_BASE`), `:331-362` (the conservative preset)
- Test: `packages/desk-engine/test/dials.test.ts:95-160`
- Test: `packages/desk-engine/test/delta-lean-dials.test.ts` (rewritten)
- Test: `packages/desk-engine/test/presets.test.ts` (the delta-lean assertions only)

**Interfaces:**
- Consumes: Task 1's `RuleState`/`TRIGGERS` (not directly referenced here, but the tree must be on that commit).
- Produces — **the complete surviving `dl_*` set, 37 dials plus `delta_lean_enabled`**, with `DEFAULT_DIALS` carrying the AGGRESSIVE column:

  | dial | type | aggressive (`DEFAULT_DIALS`) | conservative override |
  |---|---|---|---|
  | `delta_lean_enabled` | boolean | `false` | (set `true` by `DELTA_LEAN_BASE`) |
  | `dl_day_max_loss` | number | `200000` | same |
  | `dl_day_target` | number | `10000` | same |
  | `dl_open_lots` | number | `4` | `2` |
  | `dl_stuck_loss` | number | `25000` | `15000` |
  | `dl_stuck_confirm_s` | number | `300` | same |
  | `dl_adjust_confirm_s` | number | `60` | `120` |
  | `dl_adjust_cooldown_s` | number | `600` | `900` |
  | `dl_max_adjusts_day` | number | `6` | `4` |
  | `dl_dead_band_lots` | number | `0.5` | same |
  | `dl_fast_window_s` | number | `60` | same |
  | `dl_slow_window_s` | number | `300` | same |
  | `dl_context_window_s` | number | `900` | same |
  | `dl_context_on` | boolean | `true` | same |
  | `dl_trend_mult` | number | `2` | same |
  | `dl_trend_exit_mult` | number | `1.2` | same |
  | `dl_clean_min` | number | `0.6` | same |
  | `dl_quiet_mult` | number | `0.7` | same |
  | `dl_regime_dwell_s` | number | `120` | same |
  | `dl_long_delta_lo` | number | `0.55` | same |
  | `dl_long_delta_hi` | number | `0.65` | same |
  | `dl_short_delta_lo` | number | `0.2` | same |
  | `dl_short_delta_hi` | number | `0.3` | same |
  | `dl_credit_short_delta_max` | number | `0.3` | same |
  | `dl_wing_delta` | number | `0.1` | same |
  | `dl_min_strike_gap` | number | `1` | same |
  | `dl_neutral_short_delta_lo` | number | `0.45` | same |
  | `dl_neutral_short_delta_hi` | number | `0.6` | same |
  | `dl_quote_fresh_s` | number | `3` | same |
  | `dl_max_spread_pct` | number | `0.02` | same |
  | `dl_max_spread_abs` | number | `1` | same |
  | `dl_spot_stale_s` | number | `10` | same |
  | `dl_warmup_min` | number | `570` | same |
  | `dl_flatten_passive_min` | number | `890` | same |
  | `dl_flatten_urgent_min` | number | `895` | same |
  | `dl_flat_by_min` | number | `900` | same |
  | `dl_eval_min_ms` | number | `1000` | same |
  | `dl_max_orders_min` | number | `40` | same |
  | `dl_max_orders_s` | number | `2` | same |
  | `dl_max_orders_day` | number | `40` | same |

  Plus the non-`dl_` dials `DELTA_LEAN_BASE` sets: `delta_lean_enabled: true`, `confirm_ms: 1000`, `cooldown_s: 0`, `chase_max_ms: 1500` (conservative `3000`), `delta_shorts_only: false`, `gamma_shorts_only: false`, `target_pnl: 250000`, **`margin_cap: 2_500_000`**.

  **DELETED** (every dial only the deleted rules read): `dl_capital`, `dl_lean_max_loss`, `dl_base_unit_lots`, `dl_max_lean_lots`, `dl_add_step_pnl`, `dl_add_cooldown_s`, `dl_cut_frac`, `dl_cut_floor`, `dl_flip_cooldown_s`, `dl_max_flips_hour`, `dl_max_flips_day`, `dl_flip_confirm_s`, `dl_gamma_drift_keep`, `dl_theta_floor_per_lot`, `dl_theta_target`, `dl_short_gamma_move_pct`, `dl_context_disagree_cap`, `dl_pause_theta_frac`, `dl_chop_unwind_s`, `dl_min_hold_s`, `dl_wings_on`, `dl_roll_long_delta`, `dl_roll_short_delta`, `dl_margin_frac`, `dl_cost_gate_mult`, `dl_leg_stale_s`, `dl_no_new_units_min`.

  **KEPT AGAINST §4's removed list, and why:** `dl_regime_dwell_s` is read by `regime.ts:265,321,330`, and §9 says `regime.ts` is unchanged — so it stays. `dl_context_on`/`dl_context_window_s` likewise (`regime.ts:283,302,335,336`); §4's "context dials" means the CONTROLLER's, which are `dl_context_disagree_cap` and `dl_pause_theta_frac`, and those go. `dl_quote_fresh_s`/`dl_max_spread_pct`/`dl_max_spread_abs` are read by `tradableStrikes`, which §9 keeps. `dl_spot_stale_s` is NOT in §4's removed list (its sibling `dl_leg_stale_s` is, explicitly), so the refusal of NEW RISK off a stale index price survives — see Task 5.

- [ ] **Step 1: Write the failing dials test**

Rewrite `packages/desk-engine/test/delta-lean-dials.test.ts` entirely:

```ts
/**
 * THE DIAL SURFACE OF THE HOLD-AND-ADJUST ENGINE.
 *
 * Two things are pinned here and nowhere else:
 *
 *   1. THE SET. A dial the engine no longer reads is a limit an operator can
 *      set that never applies — the most expensive kind of dead code there is,
 *      because it reads as a working guard. So the section list is asserted
 *      EXACTLY, both ways: every key present and no key extra.
 *   2. THE NUMBERS. `DEFAULT_DIALS` IS spec §4's aggressive column, and the
 *      conservative preset is the base plus exactly the five numbers §4's
 *      second column moves. Asserting both stops the two drifting apart.
 *
 * And one behaviour: `resolveDials` IGNORES an unknown stored key rather than
 * refusing the row. Today's four registry rows carry the v1 dials until the
 * 08:50 roll erases them, and a resolver that refused those rows would leave
 * four books unsteered on the morning this ships.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  DIAL_SECTIONS,
  PRESETS,
  resolveDials,
  type Dials,
  type Preset,
} from '@algomaker/desk-engine'

function preset(key: string): Preset {
  const p = PRESETS.find((x) => x.key === key)
  assert.ok(p !== undefined, `preset ${key} must exist`)
  return p
}

const dlSection = (): readonly string[] => {
  const s = DIAL_SECTIONS.find((x) => x.key === 'delta-lean')
  assert.ok(s !== undefined, 'the Delta lean section must exist')
  return [...(s.toggle === undefined ? [] : [s.toggle]), ...s.fields]
}

/** Spec §4's surviving set, written out so the assertion is a statement rather
 * than a restatement of whatever the file happens to contain. */
const EXPECTED = [
  'delta_lean_enabled',
  // Budget and exits
  'dl_day_max_loss', 'dl_day_target', 'dl_open_lots', 'dl_stuck_loss', 'dl_stuck_confirm_s',
  // Adjustment
  'dl_adjust_confirm_s', 'dl_adjust_cooldown_s', 'dl_max_adjusts_day', 'dl_dead_band_lots',
  // Regime detector
  'dl_fast_window_s', 'dl_slow_window_s', 'dl_context_window_s', 'dl_context_on',
  'dl_trend_mult', 'dl_trend_exit_mult', 'dl_clean_min', 'dl_quiet_mult', 'dl_regime_dwell_s',
  // Strike selection
  'dl_long_delta_lo', 'dl_long_delta_hi', 'dl_short_delta_lo', 'dl_short_delta_hi',
  'dl_credit_short_delta_max', 'dl_wing_delta', 'dl_min_strike_gap',
  'dl_neutral_short_delta_lo', 'dl_neutral_short_delta_hi',
  // Liquidity and staleness
  'dl_quote_fresh_s', 'dl_max_spread_pct', 'dl_max_spread_abs', 'dl_spot_stale_s',
  // Clock and pacing
  'dl_warmup_min', 'dl_flatten_passive_min', 'dl_flatten_urgent_min', 'dl_flat_by_min',
  'dl_eval_min_ms', 'dl_max_orders_min', 'dl_max_orders_s', 'dl_max_orders_day',
]

test('the Delta lean section is exactly the surviving dial set', () => {
  assert.deepEqual([...dlSection()].sort(), [...EXPECTED].sort())
})

test('every dl_ dial in the schema is in the section, and every one has a default', () => {
  const inSection = new Set(dlSection())
  for (const key of Object.keys(DEFAULT_DIALS)) {
    if (!key.startsWith('dl_')) continue
    assert.ok(inSection.has(key), `${key} has no section — it would be invisible in the panel`)
  }
  for (const key of EXPECTED) {
    assert.ok(key in DEFAULT_DIALS, `${key} must have a default`)
  }
})

test('every dial the deleted rules read is GONE from the schema', () => {
  // A dial the engine no longer reads reads as a working limit and is not one.
  const gone = [
    'dl_capital', 'dl_lean_max_loss', 'dl_base_unit_lots', 'dl_max_lean_lots',
    'dl_add_step_pnl', 'dl_add_cooldown_s', 'dl_cut_frac', 'dl_cut_floor',
    'dl_flip_cooldown_s', 'dl_max_flips_hour', 'dl_max_flips_day', 'dl_flip_confirm_s',
    'dl_gamma_drift_keep', 'dl_theta_floor_per_lot', 'dl_theta_target',
    'dl_short_gamma_move_pct', 'dl_context_disagree_cap', 'dl_pause_theta_frac',
    'dl_chop_unwind_s', 'dl_min_hold_s', 'dl_wings_on', 'dl_roll_long_delta',
    'dl_roll_short_delta', 'dl_margin_frac', 'dl_cost_gate_mult', 'dl_leg_stale_s',
    'dl_no_new_units_min',
  ]
  const section = new Set(dlSection())
  for (const key of gone) {
    assert.ok(!(key in DEFAULT_DIALS), `${key} must be out of the schema`)
    assert.ok(!section.has(key), `${key} must be out of the section`)
  }
})

test('DEFAULT_DIALS carries spec §4`s AGGRESSIVE column', () => {
  assert.equal(DEFAULT_DIALS.dl_open_lots, 4)
  assert.equal(DEFAULT_DIALS.dl_day_target, 10_000)
  assert.equal(DEFAULT_DIALS.dl_day_max_loss, 200_000)
  assert.equal(DEFAULT_DIALS.dl_adjust_confirm_s, 60)
  assert.equal(DEFAULT_DIALS.dl_adjust_cooldown_s, 600)
  assert.equal(DEFAULT_DIALS.dl_max_adjusts_day, 6)
  assert.equal(DEFAULT_DIALS.dl_neutral_short_delta_lo, 0.45)
  assert.equal(DEFAULT_DIALS.dl_neutral_short_delta_hi, 0.6)
  assert.equal(DEFAULT_DIALS.dl_stuck_loss, 25_000)
  assert.equal(DEFAULT_DIALS.dl_stuck_confirm_s, 300)
  assert.equal(DEFAULT_DIALS.dl_dead_band_lots, 0.5)
  assert.equal(DEFAULT_DIALS.dl_max_orders_day, 40)
})

test('the day clock is the §5 timeline, in minutes of day and in order', () => {
  const d = DEFAULT_DIALS
  assert.ok(d.dl_warmup_min < d.dl_flatten_passive_min)
  assert.ok(d.dl_flatten_passive_min < d.dl_flatten_urgent_min)
  assert.ok(d.dl_flatten_urgent_min < d.dl_flat_by_min)
  assert.equal(d.dl_warmup_min, 570)   // 09:30
  assert.equal(d.dl_flatten_passive_min, 890) // 14:50
  assert.equal(d.dl_flatten_urgent_min, 895)  // 14:55
  assert.equal(d.dl_flat_by_min, 900)  // 15:00
})

test('the neutral sell band is ATM, not ITM, and sits inside the long band', () => {
  // D5: the operator said "sell in the money ce or something"; ATM keeps the
  // same net-delta effect with more time value and a better book. The dial is
  // the band, so it can still be pushed in the money.
  const d = DEFAULT_DIALS
  assert.ok(d.dl_neutral_short_delta_lo < d.dl_neutral_short_delta_hi)
  assert.ok(d.dl_neutral_short_delta_hi <= d.dl_long_delta_hi)
})

test('both delta-lean presets select the path, confirm in 1s and never cool down', () => {
  for (const key of ['delta-lean-aggressive', 'delta-lean-conservative']) {
    const { dials } = resolveDials(preset(key).dials as Record<string, number | boolean>)
    assert.equal(dials.delta_lean_enabled, true, `${key} selects the engine`)
    // The HOST's damping is shared by both decide paths. At the recenter
    // defaults a delta-lean EXIT would wait out a window longer than the move
    // it is exiting.
    assert.equal(dials.confirm_ms, 1_000, `${key} confirms in 1s`)
    assert.equal(dials.cooldown_s, 0, `${key} never cools down`)
  }
})

test('the margin cap is the SPAN-lite ceiling of D4 — 25 lakh, in BOTH presets', () => {
  for (const key of ['delta-lean-aggressive', 'delta-lean-conservative']) {
    const { dials } = resolveDials(preset(key).dials as Record<string, number | boolean>)
    assert.equal(dials.margin_cap, 2_500_000, `${key} caps at 25 lakh`)
  }
})

test('the aggressive preset moves nothing the defaults do not already say', () => {
  // `DEFAULT_DIALS` IS the aggressive column, so restating it in the preset
  // would be a second copy of the operator-approved table to keep in step.
  const stated = preset('delta-lean-aggressive').dials as Record<string, number | boolean>
  for (const key of Object.keys(stated)) {
    if (!key.startsWith('dl_')) continue
    assert.equal(stated[key], DEFAULT_DIALS[key as keyof Dials], `${key} is restated needlessly`)
  }
})

test('conservative differs from aggressive on exactly the five §4 risk dials', () => {
  const agg = resolveDials(preset('delta-lean-aggressive').dials as Record<string, number | boolean>).dials
  const con = resolveDials(preset('delta-lean-conservative').dials as Record<string, number | boolean>).dials
  const moved = (Object.keys(agg) as (keyof Dials)[]).filter((k) => agg[k] !== con[k])
  assert.deepEqual([...moved].sort(), [
    'chase_max_ms',           // an EXECUTION dial: half the size, so twice the patience
    'dl_adjust_confirm_s',
    'dl_adjust_cooldown_s',
    'dl_max_adjusts_day',
    'dl_open_lots',
    'dl_stuck_loss',
  ].sort())
  assert.equal(con.dl_open_lots, 2)
  assert.equal(con.dl_adjust_confirm_s, 120)
  assert.equal(con.dl_adjust_cooldown_s, 900)
  assert.equal(con.dl_max_adjusts_day, 4)
  assert.equal(con.dl_stuck_loss, 15_000)
  assert.equal(con.chase_max_ms, 3_000)
  // "same" in §4's table is INHERITED, never restated.
  assert.equal(con.dl_day_target, agg.dl_day_target)
  assert.equal(con.dl_day_max_loss, agg.dl_day_max_loss)
  assert.equal(con.dl_stuck_confirm_s, agg.dl_stuck_confirm_s)
  assert.equal(con.margin_cap, agg.margin_cap)
})

test('resolveDials IGNORES an unknown stored key and still returns the row', () => {
  /**
   * Spec §4, and it is not a nicety: today's four registry rows carry the v1
   * dials (`dl_max_lean_lots`, `dl_cut_frac`, …) until the 08:50 roll writes
   * fresh ones. A resolver that REFUSED such a row would leave four paper books
   * unsteered on the morning this ships. The key is NAMED in `unknown` so the
   * dashboard and `delta-lean-books.mjs` can say what was dropped — reported,
   * never swallowed, and never fatal.
   */
  const { dials, unknown } = resolveDials({
    dl_max_lean_lots: 9,      // a v1 dial this engine does not have
    dl_cut_frac: 0.5,         // another
    not_a_dial_at_all: 1,     // a typo
    dl_open_lots: 3,          // a real one, and it must still land
  })
  assert.equal(dials.dl_open_lots, 3, 'the known key resolved')
  assert.equal(dials.dl_day_target, DEFAULT_DIALS.dl_day_target, 'the rest fell back to defaults')
  assert.deepEqual(unknown, ['dl_max_lean_lots', 'dl_cut_frac', 'not_a_dial_at_all'])
})

test('a wrong-typed or NaN delta-lean dial is refused BY NAME, never coerced', () => {
  const { dials, unknown } = resolveDials({
    dl_open_lots: 'four' as unknown as number,
    dl_day_target: Number.NaN,
    dl_context_on: 1 as unknown as boolean,
  })
  assert.deepEqual([...unknown].sort(), ['dl_context_on', 'dl_day_target', 'dl_open_lots'])
  assert.equal(dials.dl_open_lots, DEFAULT_DIALS.dl_open_lots)
  assert.equal(dials.dl_day_target, DEFAULT_DIALS.dl_day_target)
  assert.equal(dials.dl_context_on, DEFAULT_DIALS.dl_context_on)
})

test('every dl_ dial is a number or a boolean, never a string or a sentinel', () => {
  // The dial document round-trips through Mongo and an HTTP body. A string dial
  // would survive `resolveDials` as its own type and be compared against a
  // number at decide time.
  for (const key of EXPECTED) {
    const v = DEFAULT_DIALS[key as keyof Dials]
    assert.ok(typeof v === 'number' || typeof v === 'boolean', `${key} is ${typeof v}`)
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${key} is not finite`)
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/delta-lean-dials.test.ts`
Expected: FAIL — `dl_open_lots` and the seven other new dials are not in `DEFAULT_DIALS`.

- [ ] **Step 3: Replace the `dl_*` schema fields**

`packages/desk-engine/src/dials.ts` — replace lines 112-158 (the whole `dl_*` block of the `Dials` interface, from `readonly dl_capital: number;` down to and including `readonly dl_max_orders_min: number;`, leaving the `dl_max_orders_s`/`dl_max_orders_day` declarations at 170-175 in place) with:

```ts
  // ── Budget and the four exits (hold-and-adjust spec §4, §6.5) ────────────
  /** The DISASTER BACKSTOP (D6), not a working stop: 8% of the fund, far beyond
   * where the stuck exit fires. `totalPnl <= -this` flattens urgently and
   * latches the day. */
  readonly dl_day_max_loss: number;
  /** Rupees, realised PLUS unrealised. Reaching it closes the book and stops
   * the day — the operator's "exit on the day target". */
  readonly dl_day_target: number;
  /** CONTRACT LOTS per leg at open, and the size a pyramid add starts from
   * (D7). Not delta-lots: the operator sizes in lots. */
  readonly dl_open_lots: number;
  /** With the cap or the adjust limit blocking every move, a loss past this
   * arms the stuck exit (§6.4). */
  readonly dl_stuck_loss: number;
  /** How long blocked-AND-losing must persist before the stuck exit fires. */
  readonly dl_stuck_confirm_s: number;

  // ── Adjustment gating (spec §5 step 7, §6.2) ─────────────────────────────
  /** A regime must hold this long before it justifies the open or an
   * adjustment. The book's patience, in one dial. */
  readonly dl_adjust_confirm_s: number;
  /** Minimum gap between packages. The open counts as the first. */
  readonly dl_adjust_cooldown_s: number;
  /** Adjustment packages allowed AFTER the open. The open is not counted. */
  readonly dl_max_adjusts_day: number;

  // ── Regime detector (`regime.ts`, unchanged) ─────────────────────────────
  readonly dl_fast_window_s: number; readonly dl_slow_window_s: number;
  readonly dl_context_window_s: number; readonly dl_context_on: boolean;
  readonly dl_trend_mult: number; readonly dl_trend_exit_mult: number;
  readonly dl_clean_min: number; readonly dl_quiet_mult: number;
  readonly dl_regime_dwell_s: number;

  // ── Strike selection (`express.ts`) ──────────────────────────────────────
  readonly dl_long_delta_lo: number; readonly dl_long_delta_hi: number;
  readonly dl_short_delta_lo: number; readonly dl_short_delta_hi: number;
  readonly dl_credit_short_delta_max: number; readonly dl_wing_delta: number;
  readonly dl_min_strike_gap: number;
  /**
   * The band the SIDEWAYS NEUTRALISING SALE is picked in (D5).
   *
   * The operator asked for an in-the-money sale; ATM (0.45-0.60) carries the
   * same net-delta effect with more time value and a better book, and a BAND
   * rather than a constant is what lets it be pushed in the money later.
   */
  readonly dl_neutral_short_delta_lo: number;
  readonly dl_neutral_short_delta_hi: number;
  /**
   * The dead band, in DELTA-LOTS OF NET BOOK EXPOSURE.
   *
   * A posture inside this is already met and nothing is worth a spread. It is
   * net exposure now, not a per-package excess: the whole controller reduces to
   * "where is the book's delta, and where does the regime want it".
   */
  readonly dl_dead_band_lots: number;

  // ── Liquidity and staleness ──────────────────────────────────────────────
  readonly dl_quote_fresh_s: number; readonly dl_max_spread_pct: number;
  readonly dl_max_spread_abs: number;
  /** Spot older than this refuses NEW RISK — the open and every adjustment.
   * Exits never consult it: deciding an exit on a ten-second-old price is
   * safer than not exiting. */
  readonly dl_spot_stale_s: number;

  // ── Clock and pacing ─────────────────────────────────────────────────────
  readonly dl_warmup_min: number;
  readonly dl_flatten_passive_min: number; readonly dl_flatten_urgent_min: number;
  readonly dl_flat_by_min: number;
  readonly dl_eval_min_ms: number;
  readonly dl_max_orders_min: number;
```

- [ ] **Step 4: Replace the `dl_*` defaults**

`packages/desk-engine/src/dials.ts` — replace lines 277-399 (the `dl_capital: 2_500_000, …` block through `dl_eval_min_ms: 1_000, dl_add_cooldown_s: 15, dl_max_orders_min: 40,`) with:

```ts
  // ── THE DELTA-LEAN BOOK, spec §4's AGGRESSIVE column ─────────────────────
  // `DEFAULT_DIALS` IS that column, field for field, which is why the
  // aggressive preset states nothing but the base (`presets.ts`).

  // Budget and the four exits
  dl_day_max_loss: 200_000,
  dl_day_target: 10_000,
  dl_open_lots: 4,
  dl_stuck_loss: 25_000,
  dl_stuck_confirm_s: 300,

  // Adjustment gating
  dl_adjust_confirm_s: 60,
  dl_adjust_cooldown_s: 600,
  dl_max_adjusts_day: 6,

  // Regime detector — unchanged from v1; `regime.ts` is not touched.
  dl_fast_window_s: 60, dl_slow_window_s: 300, dl_context_window_s: 900,
  dl_context_on: true,
  dl_trend_mult: 2, dl_trend_exit_mult: 1.2, dl_clean_min: 0.6,
  dl_quiet_mult: 0.7,
  dl_regime_dwell_s: 120,

  // Strike selection
  dl_long_delta_lo: 0.55, dl_long_delta_hi: 0.65,
  dl_short_delta_lo: 0.2, dl_short_delta_hi: 0.3,
  dl_credit_short_delta_max: 0.3, dl_wing_delta: 0.1,
  dl_min_strike_gap: 1,
  dl_neutral_short_delta_lo: 0.45, dl_neutral_short_delta_hi: 0.6,
  // 0.5 delta-lots of NET book exposure — half a future's worth. Twice the v1
  // number, because this is the whole book's position rather than a per-package
  // excess, and adjusting for less than half a lot is paying a spread to stand
  // still.
  dl_dead_band_lots: 0.5,

  // Liquidity and staleness
  dl_quote_fresh_s: 3, dl_max_spread_pct: 0.02, dl_max_spread_abs: 1,
  dl_spot_stale_s: 10,

  // Clock and pacing. 09:30 warm-up, 14:50 passive, 14:55 urgent, 15:00 out.
  dl_warmup_min: 570,
  dl_flatten_passive_min: 890, dl_flatten_urgent_min: 895, dl_flat_by_min: 900,
  dl_eval_min_ms: 1_000, dl_max_orders_min: 40,
```

Then change line 404's `dl_max_orders_day: 600` to `dl_max_orders_day: 40` (spec §4; §8's ceiling is ~20 orders a book a day, so 40 is twice the design ceiling and still a third of the 09-22 incident).

- [ ] **Step 5: Replace the `delta-lean` section's field list**

`packages/desk-engine/src/dials.ts` — replace the `fields: [...]` array of the `key: 'delta-lean'` section (lines 566-629) with:

```ts
    fields: [
      // Budget and the four exits
      'dl_day_max_loss',
      'dl_day_target',
      'dl_open_lots',
      'dl_stuck_loss',
      'dl_stuck_confirm_s',
      // Adjustment gating
      'dl_adjust_confirm_s',
      'dl_adjust_cooldown_s',
      'dl_max_adjusts_day',
      'dl_dead_band_lots',
      // Regime detector
      'dl_fast_window_s',
      'dl_slow_window_s',
      'dl_context_window_s',
      'dl_context_on',
      'dl_trend_mult',
      'dl_trend_exit_mult',
      'dl_clean_min',
      'dl_quiet_mult',
      'dl_regime_dwell_s',
      // Strike selection
      'dl_long_delta_lo',
      'dl_long_delta_hi',
      'dl_short_delta_lo',
      'dl_short_delta_hi',
      'dl_credit_short_delta_max',
      'dl_wing_delta',
      'dl_min_strike_gap',
      'dl_neutral_short_delta_lo',
      'dl_neutral_short_delta_hi',
      // Liquidity and staleness
      'dl_quote_fresh_s',
      'dl_max_spread_pct',
      'dl_max_spread_abs',
      'dl_spot_stale_s',
      // Clock and pacing
      'dl_warmup_min',
      'dl_flatten_passive_min',
      'dl_flatten_urgent_min',
      'dl_flat_by_min',
      'dl_eval_min_ms',
      'dl_max_orders_min',
      'dl_max_orders_s',
      'dl_max_orders_day',
    ],
```

Also update the section's doc comment above it: it says "fifty-seven inputs nobody asked to see" — change that to "thirty-eight inputs nobody asked to see".

- [ ] **Step 6: Update the presets**

`packages/desk-engine/src/presets.ts` — in `DELTA_LEAN_BASE` (lines 185-198) change `margin_cap: 100000000` to:

```ts
  // D4: THE CAP IS A SPAN-LITE CEILING ON THE WHOLE PACKAGE, and this is it.
  // ₹25 lakh per book, priced with `spanLiteMargin` so a hedged or cross-side
  // package gets its offset. The recenter family's ₹10cr is a different number
  // answering a different question and must not be inherited here.
  margin_cap: 2_500_000,
```

Replace the conservative preset's `dials` object (lines 341-362) with:

```ts
    dials: {
      ...DELTA_LEAN_BASE,
      // Spec §4's second column, and NOTHING ELSE: a row §4 writes as "same" is
      // inherited rather than restated, so the two columns cannot drift apart.
      dl_open_lots: 2,
      dl_adjust_confirm_s: 120,
      dl_adjust_cooldown_s: 900,
      dl_max_adjusts_day: 4,
      dl_stuck_loss: 15_000,
      // Twice the aggressive book's patience at the touch: it is adding half
      // the size, so paying the spread hurts it more than arriving late does.
      chase_max_ms: 3000,
    },
```

Update the preset's doc comment (lines 332-340) to describe the new shape: same structure and clock, half the size, twice the patience, two fewer adjustments and a tighter stuck trigger.

Update `DELTA_LEAN_BASE`'s doc comment (lines 179-184): `target_pnl` is still the recenter family's number carried so every preset compares on one axis, but `margin_cap` is now READ by this path — it is D4's ceiling — so the sentence "The delta-lean path reads neither" must become "The delta-lean path reads `margin_cap` and not `target_pnl`".

- [ ] **Step 7: Fix `dials.test.ts`'s default snapshot**

`packages/desk-engine/test/dials.test.ts:95-160` holds a literal of every default. Replace its `dl_*` lines with the table from the Interfaces block above (the aggressive column), in the same order as `DEFAULT_DIALS`, and delete the lines for the 27 removed dials.

- [ ] **Step 8: Fix `presets.test.ts`**

`packages/desk-engine/test/presets.test.ts` — its sweep at line ~274 asserts `margin_cap` per preset family. Add the two delta-lean keys to whatever list it compares against with the value `2_500_000`, and leave every recenter row at `100000000`. Run the file and follow the failures; do not weaken an assertion to make one pass.

- [ ] **Step 9: Run the three dial suites**

Run: `node --test packages/desk-engine/test/delta-lean-dials.test.ts packages/desk-engine/test/dials.test.ts packages/desk-engine/test/presets.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/desk-engine/src/dials.ts packages/desk-engine/src/presets.ts \
        packages/desk-engine/test/delta-lean-dials.test.ts \
        packages/desk-engine/test/dials.test.ts packages/desk-engine/test/presets.test.ts
git commit -m "feat(dials): the hold-and-adjust dial set, 25L SPAN cap, 2L backstop"
```

---

### Task 3: `lean.ts` shrinks to `rollDay`; `express.ts` loses the deleted rules' helpers

**Files:**
- Modify: `packages/desk-engine/src/delta-lean/lean.ts` — delete lines 1-129 (the header and `LeanPnl`/`leanPnl`/`newLeanId`) and 160-206 (`rollFlipHour`, `canFlip`); rewrite `rollDay` (131-170)
- Modify: `packages/desk-engine/src/delta-lean/express.ts` — delete `RESIDUAL_EPS` (52-55), `Candidate` (57-99), `FitGate` (100-122), `leanBestFit` (283-340), `thetaRank` (342-345), `shortGammaLoss` (444-461), `rollNeeded` (463-490); change `creditUnit` (406, 433) so the wing is always bought
- Test: `packages/desk-engine/test/delta-lean-lean.test.ts` (rewritten to `rollDay` only)
- Test: `packages/desk-engine/test/delta-lean-express.test.ts` — delete lines 207-300 (the `leanBestFit` block) and 472-512 (`shortGammaLoss`/`rollNeeded`); adjust the `dl_wings_on` case at 447-453
- Test: `packages/desk-engine/test/delta-lean-stamp.test.ts` (rewritten small)

**Interfaces:**
- Consumes: Task 1's `RuleState` (the eleven `dl*` fields), Task 2's `Dials`.
- Produces:
  - `export function rollDay(state: RuleState, dateIst: string, nowMs: number): RuleState` — the ONLY export of `lean.ts`.
  - `express.ts`'s surviving exports, unchanged in signature:
    - `export function tradableStrikes(chain: ChainSnap, dials: Dials, nowMs: number): readonly StrikeQuote[]`
    - `export function deltaBandStrike(chain: ChainSnap, optType: OptType, lo: number, hi: number, dateIst: string, minuteOfDay: number, dials: Dials): number | null`
    - `export function debitUnit(chain: ChainSnap, side: 'up' | 'down', dials: Dials, dateIst: string, minuteOfDay: number): readonly EngineAction[] | null` — still ONE lot a leg; the caller scales it.
    - `export function creditUnit(chain: ChainSnap, side: 'up' | 'down', lots: number, dials: Dials, dateIst: string, minuteOfDay: number): readonly EngineAction[] | null` — wing FIRST, and now ALWAYS (D3: a quiet open's hedge IS the two wings, so a naked sale is no longer an option the dials offer).

- [ ] **Step 1: Write the failing `rollDay` test**

Replace `packages/desk-engine/test/delta-lean-lean.test.ts` entirely:

```ts
/**
 * THE DAY ROLL, AND THE HALF OF IT THAT MATTERS OPERATIONALLY.
 *
 * A NEW IST date clears the stop, the open, the adjustment counters and the
 * stuck clock: the book that stopped itself at a ₹25,000 loss yesterday trades
 * again this morning with no operator action and no restart.
 *
 * The SAME date returns the state UNCHANGED, and that is the half that matters:
 * a mid-session restart must never clear a stop the book set itself, or re-open
 * a second package against a book that already holds one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_RULE_STATE, type RuleState } from '@algomaker/desk-engine'
import { rollDay } from '../src/delta-lean/lean.ts'

const DATE = '2026-09-15'
const NEXT = '2026-09-16'
const NOW = 1_789_444_800_000    // 2026-09-15 09:30:00 IST
const NEXT_DAY = 1_789_530_300_000 // 2026-09-16 09:15:00 IST

/** A book that traded yesterday and stopped itself doing it. */
function spent(over: Partial<RuleState> = {}): RuleState {
  return {
    ...EMPTY_RULE_STATE,
    dlDayStarted: DATE,
    dlStopped: true,
    dlOpenedMs: NOW - 3_600_000,
    dlOpenSide: 'up',
    dlAdjustsToday: 6,
    dlLastAdjustMs: NOW - 600_000,
    dlLastAdjustRegime: 'chop',
    dlRegime: 'chop',
    dlRegimeSinceMs: NOW - 300_000,
    dlBlockedSinceMs: NOW - 240_000,
    dlDayRealized: -18_400,
    ...over,
  }
}

test('a new IST date clears the stop, the open, the counters and the stuck clock', () => {
  const s = rollDay(spent(), NEXT, NEXT_DAY)
  assert.equal(s.dlDayStarted, NEXT)
  assert.equal(s.dlStopped, false)
  assert.equal(s.dlOpenedMs, 0)
  assert.equal(s.dlOpenSide, '')
  assert.equal(s.dlAdjustsToday, 0)
  assert.equal(s.dlLastAdjustMs, 0)
  assert.equal(s.dlLastAdjustRegime, '')
  assert.equal(s.dlBlockedSinceMs, 0)
  assert.equal(s.dlDayRealized, 0)
})

test('the reset clears EVERY delta-lean field — a new field without a reset is a bug', () => {
  // Enumerated, not spot-checked: a field added to `RuleState` and forgotten
  // here carries yesterday's value into today's first decision, and the two
  // most dangerous carries (`dlStopped`, `dlOpenedMs`) are silent.
  const s = rollDay(spent(), NEXT, NEXT_DAY)
  const dl = Object.keys(s).filter((k) => k.startsWith('dl'))
  assert.equal(dl.length, 11, 'eleven delta-lean fields — update this test with the type')
  for (const key of dl) {
    if (key === 'dlDayStarted') continue        // set to the new date
    if (key === 'dlRegimeSinceMs') continue     // anchored, see below
    assert.deepEqual(
      s[key as keyof RuleState],
      EMPTY_RULE_STATE[key as keyof RuleState],
      `${key} must be back at its zero-value`,
    )
  }
})

test('the regime clock is ANCHORED at the roll, not zeroed', () => {
  // A zero would read as "the regime has been this way since the epoch", and
  // the very first tick of the session would satisfy `dl_adjust_confirm_s` and
  // open on an unconfirmed reading. Anchored, the morning's first confirm
  // window is measured from this morning.
  const s = rollDay(spent(), NEXT, NEXT_DAY)
  assert.equal(s.dlRegimeSinceMs, NEXT_DAY)
  assert.equal(s.dlRegime, '', 'and the label itself is unclassified, never "quiet"')
})

test('the same date is not a reset — a mid-session restart must not clear the stop', () => {
  const before = spent()
  const after = rollDay(before, DATE, NOW + 60_000)
  assert.equal(after, before, 'the SAME OBJECT: nothing was rewritten')
})

test('the first ever roll starts the day — "" is never, and never is not today', () => {
  const s = rollDay(EMPTY_RULE_STATE, DATE, NOW)
  assert.equal(s.dlDayStarted, DATE)
  assert.equal(s.dlRegimeSinceMs, NOW)
})

test('the reset leaves the recenter book`s state alone', () => {
  // One `RuleState` serves both decide paths. A roll that touched `rcCredit` or
  // the scrap ban list would corrupt a book that is not on this engine at all.
  const mixed: RuleState = {
    ...spent(),
    rcCredit: 12_500,
    rcEodDay: DATE,
    gkAnchor: 24_100,
    gkStreak: 4,
    scrapBanned: ['24000:CE:2026-09-22'],
    targetStreak: 2,
    targetLocked: true,
    rcStack: [{ strike: 24_000, optType: 'CE', lots: 2 }],
    lastActionMs: NOW - 1_000,
  }
  const s = rollDay(mixed, NEXT, NEXT_DAY)
  assert.equal(s.rcCredit, 12_500)
  assert.equal(s.rcEodDay, DATE)
  assert.equal(s.gkAnchor, 24_100)
  assert.equal(s.gkStreak, 4)
  assert.deepEqual(s.scrapBanned, ['24000:CE:2026-09-22'])
  assert.equal(s.targetStreak, 2)
  assert.equal(s.targetLocked, true)
  assert.deepEqual(s.rcStack, [{ strike: 24_000, optType: 'CE', lots: 2 }])
  assert.equal(s.lastActionMs, NOW - 1_000)
})

test('the reset moves STATE only — a leg that survived the night is not adopted', () => {
  // A book is flat by 15:00 (D4). If one somehow is not, `dlOpenedMs: 0` means
  // the new day opens its own package; the surviving leg is closed by the
  // EOD/latched-stop path, never pyramided on.
  const s = rollDay(spent({ dlStopped: false }), NEXT, NEXT_DAY)
  assert.equal(s.dlOpenedMs, 0)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/delta-lean-lean.test.ts`
Expected: FAIL — `rollDay` still writes `dlLeanId`, `dlFlipsToday` and friends, so the enumerated reset test and the field-count assertion both fail.

- [ ] **Step 3: Rewrite `lean.ts`**

Replace `packages/desk-engine/src/delta-lean/lean.ts` entirely with:

```ts
/**
 * THE DAY ROLL — the only thing left of the v1 lean module.
 *
 * The v1 controller had a LEAN: a directional bet with an identity, its own
 * banked P&L and a high-water mark, because it added on a new peak and cut on
 * the drawdown from it. This engine has neither an add-on-profit rule nor a cut
 * rule (hold-and-adjust spec D2), so the identity, the peak, the per-lean bank
 * and the flip counters are all gone, and with them `leanPnl`, `newLeanId`,
 * `canFlip` and `rollFlipHour`.
 *
 * What survives is the auto-start. A book is flat by 15:00 and lives one
 * trading day; on a new IST date it must forget the day it just had, and on the
 * SAME date it must forget nothing — a mid-session restart that cleared the
 * stop, or the open, would either re-enter a book that stopped itself or lay a
 * second package on top of the first.
 *
 * PURE: no clock, no feed, no Mongo. `nowMs` and `dateIst` are arguments so a
 * fixture can replay a session that is long over.
 */
import type { RuleState } from '../types.ts';

/**
 * The auto-start.
 *
 * A NEW IST date clears the stop, the open, the adjustment counters, the stuck
 * clock and the day's realised bank: the book that stopped itself yesterday
 * trades again this morning with no operator action and no restart.
 *
 * The SAME date returns the state UNCHANGED — the same object, so a caller
 * cannot accidentally persist a rewritten copy. `dlDayStarted` `''` is "never",
 * and never is not today, so a fresh row rolls on its first loop.
 *
 * `dlRegimeSinceMs` is ANCHORED at the roll rather than zeroed. A 0 would read
 * as "the regime has been this way since the epoch", so the session's very
 * first tick would satisfy `dl_adjust_confirm_s` and open on a reading the
 * detector has held for one second.
 *
 * `cumRealized` is NOT touched — it is the tag's bank, the supervisor's
 * `#settle` is its only writer, and a delta-lean tag lives one trading day
 * anyway (§6 of the runbook). `dlDayRealized` IS zeroed: it is this day's half
 * of the same money, kept for the ledger.
 *
 * This moves STATE only. A leg that somehow survived the night is orphaned by
 * `dlOpenedMs: 0` — the new day opens its own package and the survivor is
 * closed by the flatten path, never adjusted around.
 *
 * The recenter fields (`rcCredit`, `gkAnchor`, the scrap ban list, `rcStack`,
 * `lastActionMs` …) are untouched — one `RuleState` serves both decide paths.
 */
export function rollDay(state: RuleState, dateIst: string, nowMs: number): RuleState {
  if (dateIst === state.dlDayStarted) return state;
  return {
    ...state,
    dlDayStarted: dateIst,
    dlStopped: false,
    dlOpenedMs: 0,
    dlOpenSide: '',
    dlAdjustsToday: 0,
    dlLastAdjustMs: 0,
    dlLastAdjustRegime: '',
    dlBlockedSinceMs: 0,
    dlDayRealized: 0,
    dlRegime: '',
    dlRegimeSinceMs: nowMs,
  };
}
```

- [ ] **Step 4: Run the lean test**

Run: `node --test packages/desk-engine/test/delta-lean-lean.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing express test change**

In `packages/desk-engine/test/delta-lean-express.test.ts`:
- delete lines 207-300 (`// ── leanBestFit …` through the cost-gate test) and lines 472-512 (`shortGammaLoss` and `rollNeeded`);
- delete `leanBestFit`, `rollNeeded`, `shortGammaLoss` from the import at lines 46-53, and delete the `cand`/`THETA_HEADROOM_OK`/`AT_THE_FLOOR` helpers those tests used;
- replace the `with wings off a credit unit is a single, deliberately naked sale` test (447-453) with:

```ts
test('a credit unit ALWAYS buys its wing — a naked sale is not an option any more', () => {
  /**
   * D3: for a quiet open the hedge IS the strangle's two wings, and nothing
   * removes a hedge before the close. `dl_wings_on` was the dial that let an
   * operator choose a naked sale; it is gone, so the only way a short goes on
   * unbounded is a wing that is not on the ladder — and then the unit does not
   * form at all, which is the next test.
   */
  const u = creditUnit(CHAIN, 'up', 2, DIALS, DATE, MINUTE)
  assert.ok(u !== null)
  assert.equal(u.length, 2)
  assert.equal(u[0]?.side, 'Buy', 'the wing is bought FIRST — never short a leg not yet covered')
  assert.equal(u[1]?.side, 'Sell')
  assert.equal(u[0]?.optType, 'PE')
  assert.equal(u[1]?.optType, 'PE')
  assert.ok((u[0] as { strike: number }).strike < (u[1] as { strike: number }).strike,
    'the wing sits further OTM than the short it protects')
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/delta-lean-express.test.ts`
Expected: FAIL — `dl_wings_on` no longer exists on `Dials` (a type error at the old test's `dialsOf({ dl_wings_on: false })`), and `creditUnit` still branches on it.

- [ ] **Step 7: Prune `express.ts`**

In `packages/desk-engine/src/delta-lean/express.ts`:
1. Delete `RESIDUAL_EPS` (lines 52-55), the `Candidate` interface and its doc comment (57-99), the `FitGate` interface and its doc comment (100-122), `leanBestFit` and its two doc comments (283-340), and `thetaRank` (342-345).
2. Delete `shortGammaLoss` and its doc comment (444-461) and `rollNeeded` and its doc comment (463-490).
3. In `creditUnit`, replace lines 405-406 (`const sell: EngineAction = …` / `if (!dials.dl_wings_on) return [sell];`) with:

```ts
  const sell: EngineAction = { op: 'open', strike: short, optType, side: 'Sell', lots };
```

   and update the doc comment paragraph about `dl_wings_on` (lines 430-437) to:

```
 * The wing is emitted FIRST, and it is NOT optional (D3): for a quiet open the
 * hedge IS the strangle's two wings, and nothing removes a hedge before the
 * close. With no wing available on the ladder the unit does not form AT ALL —
 * selling the short and finding the wing unbuyable afterwards is the one
 * outcome the ordering rule exists to prevent.
```

4. Prune the now-unused imports at lines 36-47: `LegView` and `Side` were only used by the deleted code. Keep `ChainSnap`, `EngineAction`, `OptType`, `Quote`, `StrikeQuote`.
5. Update the file header (lines 1-35) so it describes what is left: the liquidity filter, the delta-band walk, and the two structures (`debitUnit`, `creditUnit`). Delete the paragraphs about best-fit sizing, the cost gate and the roll.

- [ ] **Step 8: Run the express test**

Run: `node --test packages/desk-engine/test/delta-lean-express.test.ts`
Expected: PASS.

- [ ] **Step 9: Rewrite the stamp test to the surviving surface**

`packages/desk-engine/test/delta-lean-stamp.test.ts` still imports `leanPnl` and asserts that `decideDeltaLean` stamps its opens. Both are gone. What survives is the PLUMBING: `markLeg` carries a stored leg's `leanId` through and defaults an unstamped one to `''`. Replace the file with:

```ts
/**
 * THE LEG STAMP, AFTER THE LEAN WENT AWAY.
 *
 * `LegView.leanId` is still a required field and `apps/api`'s fold path still
 * carries it end to end (spec §3: "stays as an opaque package stamp if the fold
 * path needs it"). What changed is that NOTHING WRITES IT any more: the
 * hold-and-adjust engine has no lean identity, so every leg it opens reads back
 * `''`. That is the same value a manual leg and a recenter leg have always had,
 * and the point of this file is that it stays a VALUE rather than becoming an
 * `undefined` the moment the writer stopped writing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { markLeg, type LegPosition } from '../src/marking.ts'
import type { Quote } from '../src/types.ts'

const NOW = Date.UTC(2026, 8, 16, 4, 30)
const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })

function position(over: Partial<LegPosition> = {}): LegPosition {
  return {
    instrument: 'NIFTY26SEP23950CE',
    strike: 23_950,
    optType: 'CE',
    side: 'Buy',
    lots: 4,
    lotSize: 65,
    entry: 210,
    openedByEngine: true,
    leanId: '',
    ...over,
  }
}

test('a marked leg exposes the stamp the stored leg carried', () => {
  const leg = markLeg(position({ leanId: 'pkg-1789533000000' }), q(214, 216), NOW)
  assert.equal(leg.leanId, 'pkg-1789533000000')
})

test('an unstamped stored leg reads as the empty string, never undefined', () => {
  // The read side is REQUIRED as `''` while the write side is optional
  // (`types.ts`). A mapper that omitted it would hand a consumer `undefined`,
  // which compares equal to every other unmapped leg's `undefined`.
  const leg = markLeg(position(), q(214, 216), NOW)
  assert.equal(leg.leanId, '')
  assert.equal(typeof leg.leanId, 'string')
})
```

If `markLeg`'s signature in `packages/desk-engine/src/marking.ts:243` differs from `(position, quote, nowMs)`, use its real one — read it before writing this file. Do not change `marking.ts`.

- [ ] **Step 10: Run the stamp test**

Run: `node --test packages/desk-engine/test/delta-lean-stamp.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

`decide.ts` still does not compile — it imports `leanBestFit`, `leanPnl`, `canFlip` and the rest. Task 4 replaces it wholesale.

```bash
git add packages/desk-engine/src/delta-lean/lean.ts packages/desk-engine/src/delta-lean/express.ts \
        packages/desk-engine/test/delta-lean-lean.test.ts \
        packages/desk-engine/test/delta-lean-express.test.ts \
        packages/desk-engine/test/delta-lean-stamp.test.ts
git commit -m "refactor(delta-lean): lean.ts is the day roll; express.ts keeps the structures"
```

---

### Task 4: `decide.ts` part A — day lifecycle and the exits (spec §5 steps 0-5, §6.5)

**Files:**
- Rewrite: `packages/desk-engine/src/delta-lean/decide.ts` (all 1683 lines replaced)
- Rewrite: `packages/desk-engine/test/delta-lean-decide.test.ts` (all 2127 lines replaced)

**Interfaces:**
- Consumes: Task 1's `RuleState`/`TRIGGERS`, Task 2's `Dials`, Task 3's `rollDay(state, dateIst, nowMs)`, and `regime.ts`'s `readRegime(ring, chain, nowMs, minutesToExpiry, dials, prevRegime, sinceMs): RegimeRead` with `RegimeRead.slow: Regime`, plus `guards.ts`'s `totalPnl(inputs: EngineInputs): number` and `session.ts`'s `isTradingDay(dateIst: string): boolean`.
- Produces — **every signature Tasks 5, 6, 7, 8 and 9 rely on**:
  - `export interface DeltaLeanInputs extends EngineInputs { readonly ring: SpotRing; readonly minutesToExpiry: number; readonly ordersThisMinute: number; readonly spotAsOf: number }` — UNCHANGED from v1, all four still required.
  - `export function decideDeltaLean(inputs: DeltaLeanInputs, dials: Dials, state: RuleState, markCtx: MarkContext): EngineDecision` — the four-argument signature the host's `#decide` already calls. `nowMs` is `inputs.nowMs`; `markCtx` is accepted and deliberately unread.
  - `function hold(reason: string, state: RuleState, trigger?: Trigger): EngineDecision` — `trigger` defaults `'none'`; `actions: []`, `stateAfter === markState === state`, `urgency: 'passive'`, `makerQuote: false`, `creditCommit: null`.
  - `function acted(action: 'adjust' | 'flatten', trigger: Trigger, reason: string, actions: readonly EngineAction[], stateAfter: RuleState, markState: RuleState, urgency: Urgency): EngineDecision` — **no `now` parameter and no stamping**; `makerQuote` is always `false` on this path.
  - `function closeAll(legs: readonly LegView[]): readonly EngineAction[]` — shorts first.
  - `function pace(actions: readonly EngineAction[], inputs: DeltaLeanInputs, dials: Dials): readonly EngineAction[]`.
  - `function legDeltaLots(leg: LegView): number` — `wingSign(optType) * sideSign(side) * |delta| * lots`.
  - `function spotStale(inputs: DeltaLeanInputs, dials: Dials): boolean`.
  - `function prevRegime(state: RuleState): Regime`, `const wingSign = (t: OptType) => number`, `const sideSign = (s: Side) => number`, `const inr = (x: number) => string`, `const clock = (m: number) => string`, `const EPS = 1e-9`.
  - `function exitDecision(inputs, dials, trigger: Trigger, reason: string, urgency: Urgency, st: RuleState, latchWhenFlat: boolean): EngineDecision` — the one place a `closeAll` is turned into a decision, so every exit latches the same way.

- [ ] **Step 1: Write the new test file's fixture and the lifecycle tests**

Replace `packages/desk-engine/test/delta-lean-decide.test.ts` entirely. This step writes the header, the fixture builder and sections 1-3; Tasks 5-8 append sections 4-8 to the same file.

```ts
/**
 * THE ORDER OF THESE CHECKS IS THE RISK MODEL.
 *
 * `decideDeltaLean` is the second decide path and it has no parity fixtures —
 * nothing recorded this book, because this book has never run. So the ORDER is
 * what this file is for, and every test below pins one ordering that is only
 * ever visible as a bug in money:
 *
 *   - ADDS ONLY UNTIL THE CLOSE (spec D2). Four things may close a leg: the
 *     flatten windows, the day-loss backstop, the day target and the stuck
 *     exit. Section 8's scripted day asserts that nothing else ever does,
 *     across a whole synthetic session of regime changes.
 *   - A latched stop is TERMINAL. It sits above the clock and above everything
 *     the regime has to say, so a book that stopped itself cannot be talked
 *     back in by a tape that looks good.
 *   - A flatten that sat below the session gate would never fire on a restart
 *     after 15:00 — and `apps/supervisor/src/main.ts` forbids a SIGTERM
 *     square-off, so that restart is the only thing between a hung book and the
 *     overnight carry D4 forbids.
 *   - THE SAME REGIME NEVER JUSTIFIES TWO PACKAGES IN A ROW. A CHURN GUARD: it
 *     turns "add when the trend is on" into "add when the tape changed its mind
 *     and came back". It used to be load-bearing as well, because `D` was
 *     defined off the long band alone and a fresh open read as short of its own
 *     posture; the amended §6.2 defines `D` as the hedged pair's own net delta,
 *     so the open meets its posture outright and this gate now only bounds how
 *     OFTEN a genuine shortfall may be topped up.
 *   - `'unknown'` is not `'quiet'`. Quiet is the regime that SELLS premium, and
 *     a strangle sold into a chain that stopped printing is the worst thing
 *     this path can cause.
 *
 * THE FIXTURE is a NIFTY-shaped weekly board, hand-derivable and built from
 * real `b76Price` marks so every greek below is the model's rather than a
 * typed-in number: 41 strikes (23,000…25,000 by 50) around spot 24,000, lot 65,
 * six calendar days to expiry, quoted so each MID is exactly the Black-76 price
 * at vol 0.12. The delta bands therefore land on real strikes:
 *
 *   debit 'up'     buy 23,950 CE (δ 0.556)   sell 24,200 CE (δ 0.297)
 *   debit 'down'   buy 24,050 PE (δ 0.556)   sell 23,800 PE (δ 0.297)
 *   credit 'up'    buy 23,500 PE (δ 0.084)   sell 23,800 PE (δ 0.290)
 *   credit 'down'  buy 24,500 CE (δ 0.091)   sell 24,200 CE (δ 0.297)
 *   neutral CE     sell 23,950 CE (δ 0.556, inside the 0.45-0.60 band)
 *   neutral PE     sell 24,050 PE (δ 0.556)
 *
 * THE TAPE is a `SpotRing` filled one sample a second, exactly as the host
 * fills it. Every regime below is REACHED through `readRegime` rather than
 * injected, because the composition of detector and controller is the thing
 * this task builds — a test that stubbed the regime would pass with the two
 * wired together backwards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import { DEFAULT_DIALS, type Dials } from '../src/dials.ts'
import { RISK_FREE, strikeGreeks } from '../src/marking.ts'
import { EMPTY_RULE_STATE } from '../src/types.ts'
import type {
  ChainSnap,
  EngineAction,
  LegView,
  MarginInput,
  OptType,
  Quote,
  RuleState,
  Side,
} from '../src/types.ts'
import type { MarkContext } from '../src/guards.ts'
import { SpotRing } from '../src/delta-lean/regime.ts'
import { decideDeltaLean, type DeltaLeanInputs } from '../src/delta-lean/decide.ts'

const DATE = '2026-09-16'   // a Wednesday
const NEXT_DAY = '2026-09-17' // the Thursday after it — both NSE trading days
const EXPIRY = '2026-09-22' // the following Tuesday: NIFTY's weekly (spec §3)
const MINUTE = 600          // 10:00 IST, comfortably inside the session
const DTE = 6
const T6 = DTE / 365
const VOL = 0.12            // an index vol, not a single-stock one
const SPOT = 24_000
const STEP = 50
const LOT = 65              // NIFTY, as of Jan 2026
/** 2026-09-16 10:00 IST as an epoch. A real instant, never `Date.now()`. */
const NOW = Date.UTC(2026, 8, 16, 4, 30)
/** Trading minutes from 10:00 on the 16th to the 22nd close: 330 left today
 * plus four whole sessions (17th, 18th, 21st, 22nd). */
const MTX = 330 + 4 * 375

const q = (bid: number, ask: number, asOf = NOW): Quote => ({ bid, ask, ltp: null, asOf })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so the IV
 * solve returns `VOL` and every greek is the model's. The 1% spread is inside
 * `dl_max_spread_pct` at every strike the bands reach. */
function bookAt(strike: number, type: OptType, asOf = NOW): Quote {
  const px = b76Price({ future: SPOT, strike, t: T6, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.995, px * 1.005, asOf)
}

const LADDER = Array.from({ length: 41 }, (_, i) => 23_000 + i * STEP)

function chainOf(over: Partial<ChainSnap> = {}): ChainSnap {
  return {
    symbol: 'NIFTY',
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: q(SPOT - 0.5, SPOT + 0.5),
    spot: SPOT,
    strikes: LADDER.map((k) => ({ strike: k, ce: bookAt(k, 'CE'), pe: bookAt(k, 'PE') })),
    asOf: NOW,
    ...over,
  }
}

const CHAIN = chainOf()

/** The per-share |delta| of a strike on this board, as `markLeg` stores it. */
function deltaOf(strike: number, optType: OptType): number {
  const g = strikeGreeks(CHAIN, strike, optType, DATE, MINUTE)
  assert.ok(g !== null, `${strike} ${optType} must be measurable on this board`)
  return Math.abs(g.delta)
}

const D_23950_CE = deltaOf(23_950, 'CE')
const D_24200_CE = deltaOf(24_200, 'CE')
const D_24050_PE = deltaOf(24_050, 'PE')

// ── the tape ────────────────────────────────────────────────────────────────

/** One sample a second over `[endMs - seconds*1000, endMs]`, priced by `fn(t)`
 * where `t` counts seconds from the START of the fill — exactly the cadence the
 * host pushes at. */
function fill(ring: SpotRing, endMs: number, seconds: number, fn: (t: number) => number): void {
  for (let t = 0; t <= seconds; t++) ring.push({ ms: endMs - (seconds - t) * 1000, spot: fn(t) })
}

/** A clean 300-point ramp over the last fifteen minutes, ENDING at `SPOT` so
 * the tape and the board agree on where the index is. ~19x the 5-minute implied
 * move, so all three windows read the same trend. */
function trending(dirSign: 1 | -1, endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, 900, (t) => SPOT - dirSign * 300 * (1 - t / 900))
  return ring
}

/** Fifteen minutes inside an 8-point band: a range well under `dl_quiet_mult` x
 * implied on BOTH the slow window and the one before it, which is what
 * `readRegime` demands before it will say quiet at all. */
function quietTape(endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, 900, (t) => SPOT + 4 * Math.sin((2 * Math.PI * t) / 200))
  return ring
}

/** A 60-point sine on a 5-minute period: every whole window has displacement 0
 * and a range four times the quiet bar. Chop under either trend multiplier. */
function choppy(endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, 900, (t) => SPOT + 30 * Math.sin((2 * Math.PI * t) / 300))
  return ring
}

/** No ticks at all: the feed died. Every window is `null`, the read is
 * `'unknown'`, and an unknown regime must open NOTHING. */
const DEAD_FEED = new SpotRing(4096)

// ── legs ────────────────────────────────────────────────────────────────────

/** A held leg, marked off the same board with the same signs `markLeg` uses:
 * `delta` an unsigned magnitude, `theta` and `gamma` the CONTRACT's, unsigned
 * by side. Nothing here is hand-typed. */
function legAt(
  strike: number,
  optType: OptType,
  side: Side,
  lots: number,
  over: Partial<LegView> = {},
): LegView {
  const g = strikeGreeks(CHAIN, strike, optType, DATE, MINUTE)
  assert.ok(g !== null, `${strike} ${optType} must be measurable on this board`)
  const row = CHAIN.strikes.find((s) => s.strike === strike)
  assert.ok(row !== undefined)
  const quote = optType === 'CE' ? row.ce : row.pe
  assert.ok(quote !== null)
  return {
    instrument: `NIFTY26SEP${strike}${optType}`,
    strike,
    optType,
    side,
    lots,
    lotSize: LOT,
    entry: 100,
    openedByEngine: true,
    // Unstamped. The hold-and-adjust engine writes no lean id at all.
    leanId: '',
    iv: g.iv,
    delta: Math.abs(g.delta),
    gamma: g.gamma,
    theta: g.theta,
    vega: g.vega,
    hasGreeks: true,
    mtm: 0,
    exit: quote,
    ...over,
  }
}

/** The book a `trend-up` open leaves behind: 4 lots long the 23,950 CE and 4
 * short the 24,200 CE. Net ≈ 4 × (0.556 − 0.297) ≈ +1.04 delta-lots. */
const OPENED_UP = (lots = 4): LegView[] => [
  legAt(23_950, 'CE', 'Buy', lots),
  legAt(24_200, 'CE', 'Sell', lots),
]

// ── inputs ──────────────────────────────────────────────────────────────────

const MARGIN: MarginInput = { value: 0, source: 'broker', asOf: NOW, fresh: true }

interface Over {
  readonly ring?: SpotRing
  readonly legs?: readonly LegView[]
  readonly minuteOfDay?: number
  readonly dateIst?: string
  readonly cumRealized?: number
  readonly chain?: ChainSnap
  readonly margin?: MarginInput
  readonly pendingLots?: number
  readonly repairHold?: boolean
  readonly spotAsOf?: number
  readonly ordersThisMinute?: number
  readonly nowMs?: number
}

function inputsIn(over: Over = {}): DeltaLeanInputs {
  return {
    tag: 'NIFTY-DL',
    mode: 'paper',
    nowMs: over.nowMs ?? NOW,
    dateIst: over.dateIst ?? DATE,
    minuteOfDay: over.minuteOfDay ?? MINUTE,
    dte: DTE,
    chain: over.chain ?? CHAIN,
    legs: over.legs ?? [],
    protectedQty: {},
    cumRealized: over.cumRealized ?? 0,
    margin: over.margin ?? MARGIN,
    pendingLots: over.pendingLots ?? 0,
    repairHold: over.repairHold ?? false,
    pricing: 'live',
    ring: over.ring ?? DEAD_FEED,
    minutesToExpiry: MTX,
    ordersThisMinute: over.ordersThisMinute ?? 0,
    spotAsOf: over.spotAsOf ?? (over.nowMs ?? NOW),
  }
}

const DIALS: Dials = DEFAULT_DIALS
const dialsOf = (over: Partial<Dials> = {}): Dials => ({ ...DEFAULT_DIALS, ...over })

/** Inert on this path — the delta-lean book evaluates every second and owns no
 * 5-minute mark grid (spec §10). Passed because the signature takes it. */
const MARK: MarkContext = { isNewMark: true, markIndexToday: 9 }

/** A state that has already rolled for `DATE`, so `rollDay` is a no-op and the
 * test is about the rule under it rather than about the auto-start. The regime
 * clock is set an hour back, so `dl_adjust_confirm_s` is satisfied the moment
 * the detector agrees with `dlRegime`. */
const TODAY: RuleState = {
  ...EMPTY_RULE_STATE,
  dlDayStarted: DATE,
  dlRegimeSinceMs: NOW - 3_600_000,
}

/** A book that has already opened `side` and is past its cooldown. */
function opened(side: 'up' | 'down' | 'none', over: Partial<RuleState> = {}): RuleState {
  return {
    ...TODAY,
    dlOpenedMs: NOW - 3_600_000,
    dlOpenSide: side,
    dlLastAdjustMs: NOW - 3_600_000,
    dlLastAdjustRegime: side === 'up' ? 'trend-up' : side === 'down' ? 'trend-down' : 'quiet',
    ...over,
  }
}

/** The `'open'` arm, narrowed once so every assertion can read a `strike` and
 * an `optType` without re-narrowing at the call site. */
type OpenAction = Extract<EngineAction, { op: 'open' }>

const opens = (actions: readonly EngineAction[]): OpenAction[] =>
  actions.filter((a): a is OpenAction => a.op === 'open')
const sells = (actions: readonly EngineAction[]): OpenAction[] =>
  opens(actions).filter((a) => a.side === 'Sell')
const buys = (actions: readonly EngineAction[]): OpenAction[] =>
  opens(actions).filter((a) => a.side === 'Buy')
const exits = (actions: readonly EngineAction[]): readonly EngineAction[] =>
  actions.filter((a) => a.op === 'close' || a.op === 'resize')

// ════════════════════════════════════════════════ 1. the tape reads as built

test('the fixture tapes reach the regimes the rest of this file assumes', () => {
  // Not a tautology: every controller test below is only testing what it claims
  // if the tape actually classifies. A drifting dial or a changed MIN_SPAN_FRAC
  // would otherwise turn half this file green for the wrong reason.
  const read = (ring: SpotRing): string =>
    decideDeltaLean(inputsIn({ ring }), DIALS, TODAY, MARK).stateAfter.dlRegime
  assert.equal(read(trending(1)), 'trend-up')
  assert.equal(read(trending(-1)), 'trend-down')
  assert.equal(read(quietTape()), 'quiet')
  assert.equal(read(choppy()), 'chop')
  assert.equal(read(DEAD_FEED), 'unknown')
})

test('a regime CHANGE restamps the clock; the same reading leaves it alone', () => {
  // `dlRegimeSinceMs` IS the confirmation clock for the open and for every
  // adjustment. Restamp it on an unchanged reading and no regime ever confirms;
  // fail to restamp it on a change and a one-second-old reading passes a
  // sixty-second gate.
  const held: RuleState = { ...TODAY, dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 10_000 }
  const same = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, held, MARK)
  assert.equal(same.stateAfter.dlRegimeSinceMs, NOW - 10_000, 'unchanged: the clock runs on')

  const changed = decideDeltaLean(inputsIn({ ring: trending(-1) }), DIALS, held, MARK)
  assert.equal(changed.stateAfter.dlRegime, 'trend-down')
  assert.equal(changed.stateAfter.dlRegimeSinceMs, NOW, 'changed: the clock restarts here')
})

// ══════════════════════════════════════════════════ 2. the day roll and latch

test('a new IST date clears the stop and the open — the book trades again', () => {
  const yesterday: RuleState = {
    ...TODAY,
    dlStopped: true,
    dlOpenedMs: NOW - 86_400_000,
    dlOpenSide: 'up',
    dlAdjustsToday: 6,
  }
  const d = decideDeltaLean(
    inputsIn({ ring: DEAD_FEED, dateIst: NEXT_DAY }),
    DIALS,
    yesterday,
    MARK,
  )
  assert.equal(d.stateAfter.dlStopped, false)
  assert.equal(d.stateAfter.dlOpenedMs, 0)
  assert.equal(d.stateAfter.dlAdjustsToday, 0)
  assert.equal(d.stateAfter.dlDayStarted, NEXT_DAY)
})

test('the latched stop outranks every regime, and flattens what is left', () => {
  const st: RuleState = { ...TODAY, dlStopped: true }
  const flat = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, st, MARK)
  assert.equal(flat.action, 'hold')
  assert.equal(flat.trigger, 'dl-stop')
  assert.equal(flat.actions.length, 0, 'the trend never got a look in')

  const held = decideDeltaLean(inputsIn({ ring: trending(1), legs: OPENED_UP() }), DIALS, st, MARK)
  assert.equal(held.action, 'flatten')
  assert.equal(held.trigger, 'dl-stop')
  assert.equal(held.urgency, 'urgent')
  assert.equal(exits(held.actions).length, 2)
  assert.equal(opens(held.actions).length, 0)
})

test('a closeAll buys back the SHORT before it sells the long', () => {
  // Not taste: between two fills the book must never be naked, and that instant
  // is exactly when an index gaps.
  const st: RuleState = { ...TODAY, dlStopped: true }
  const d = decideDeltaLean(inputsIn({ ring: quietTape(), legs: OPENED_UP() }), DIALS, st, MARK)
  const first = d.actions[0]
  assert.ok(first !== undefined && first.op === 'close')
  assert.equal(first.instrument, 'NIFTY26SEP24200CE', 'the SHORT call goes first')
})

// ═══════════════════════════════════════════════════════ 3. the four exits

test('past the flat-by the residual goes to the blind ladder', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 901 }),
    DIALS,
    TODAY,
    MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
  assert.equal(d.urgency, 'ladder')
})

test('14:55 is an urgent flatten and 14:50 a passive one — one trigger, two ways', () => {
  const urgent = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 896 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(urgent.trigger, 'eod')
  assert.equal(urgent.urgency, 'urgent')

  const passive = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 891 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(passive.trigger, 'eod')
  assert.equal(passive.urgency, 'passive')
})

test('the flatten window latches the day ONCE THE BOOK IS FLAT, and not before', () => {
  // Before flat: the latch would ride on a package that has not filled, and the
  // next tick would see `dlStopped` with legs still out — which is the same
  // flatten under a different trigger. After flat there is nothing left to do
  // all session, and the latch is what says so.
  const working = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), minuteOfDay: 891 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(working.stateAfter.dlStopped, false)

  const done = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], minuteOfDay: 891 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(done.action, 'hold')
  assert.equal(done.trigger, 'eod')
  assert.equal(done.stateAfter.dlStopped, true)
  assert.equal(done.markState.dlStopped, true, 'and on BOTH states — see the next test')
})

test('the flatten clock sits ABOVE the session gate', () => {
  // The supervisor's SIGTERM is deliberately inert, so a book can wake up after
  // 15:00 still carrying. This is the only thing between that and the overnight
  // carry D4 forbids — so it must not be gated on `isTradingDay`.
  const d = decideDeltaLean(
    inputsIn({ ring: DEAD_FEED, legs: OPENED_UP(), minuteOfDay: 901, dateIst: '2026-09-19' }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'eod')
})

test('the day-loss backstop flattens urgently and latches IMMEDIATELY', () => {
  // D6: a disaster backstop, ₹2,00,000, far beyond where the stuck exit fires.
  // It latches on BOTH states because `stateAfter` is persisted only when a
  // decision routes — a latch that lived there alone would be undone by a
  // dropped package, and the next loop would adjust on a spent budget.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -200_001 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.urgency, 'urgent')
  assert.equal(d.stateAfter.dlStopped, true)
  assert.equal(d.markState.dlStopped, true)
})

test('the backstop reads the OPEN book`s mark, not banked money alone', () => {
  // `totalPnl` is `cumRealized + Σ leg.mtm`. A budget counting only banked
  // rupees would ignore the unrealised loss it exists to stop.
  const bleeding = OPENED_UP().map((l) => ({ ...l, mtm: -100_001 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: bleeding, cumRealized: 0 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.stateAfter.dlStopped, true)
})

test('the day target banks the book on a LADDER and latches once flat', () => {
  const winning = OPENED_UP().map((l) => ({ ...l, mtm: 5_001 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: winning }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-target')
  assert.equal(d.urgency, 'ladder')
  assert.equal(d.stateAfter.dlStopped, false, 'not yet — the package has not filled')

  const banked = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [], cumRealized: 10_002 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(banked.action, 'hold')
  assert.equal(banked.trigger, 'dl-target')
  assert.equal(banked.stateAfter.dlStopped, true)
})

test('one rupee short of the target is not the target', () => {
  const nearly = OPENED_UP().map((l) => ({ ...l, mtm: 4_999.5 }))
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: nearly }),
    DIALS, opened('up'), MARK,
  )
  assert.notEqual(d.trigger, 'dl-target')
  assert.equal(exits(d.actions).length, 0)
})

test('the backstop outranks the target — a book at both is a book in trouble', () => {
  // Impossible on one number, but not on two rails: a stale `cumRealized` and a
  // collapsing mark can cross in the same tick. Whichever way they cross, the
  // decision must be the URGENT one.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -200_001 }),
    dialsOf({ dl_day_target: -300_000 }),   // a target this book has "made"
    opened('up'),
    MARK,
  )
  assert.equal(d.trigger, 'dl-stop')
  assert.equal(d.urgency, 'urgent')
})

// ══════════════════════════════════════════════════ 4. the gates before a rule

test('before the warm-up the detector runs and NOTHING is placed', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), minuteOfDay: 569 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
  assert.equal(d.stateAfter.dlRegime, 'trend-up', 'the detector ran — the warm-up is not a blindfold')
})

test('a non-trading day places nothing, whatever the tape says', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), dateIst: '2026-09-19' }),   // a Saturday
    DIALS, { ...TODAY, dlDayStarted: '2026-09-19' }, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
})

test('a repair hold stands the book down', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), repairHold: true }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
})

test('a working package holds the pass — one package per book', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), pendingLots: 4 }),
    DIALS, TODAY, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
})

test('but an EXIT jumps every one of those four gates', () => {
  // A book that cannot place its add misses a trade; a book that cannot place
  // its exit carries the position the exit exists to remove.
  for (const over of [
    { minuteOfDay: 569 },
    { repairHold: true },
    { pendingLots: 4 },
    { dateIst: '2026-09-19' as string },
  ]) {
    const d = decideDeltaLean(
      inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -200_001, ...over }),
      DIALS, opened('up'), MARK,
    )
    assert.equal(d.action, 'flatten', `the backstop must fire through ${JSON.stringify(over)}`)
    assert.equal(d.trigger, 'dl-stop')
  }
})

test('a stale index price refuses NEW RISK and never an exit', () => {
  const stale = { spotAsOf: NOW - 11_000 }
  const held = decideDeltaLean(inputsIn({ ring: trending(1), ...stale }), DIALS, TODAY, MARK)
  assert.equal(held.action, 'hold')
  assert.ok(held.reason.includes('stale'), `the ledger must say why: ${held.reason}`)

  const out = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP(), cumRealized: -200_001, ...stale }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(out.action, 'flatten')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: FAIL to even load — `decide.ts` still imports `leanBestFit`, `leanPnl` and `canFlip`, which Task 3 deleted.

- [ ] **Step 3: Write the new `decide.ts`**

Replace `packages/desk-engine/src/delta-lean/decide.ts` entirely. Tasks 5, 6 and 7 extend this file; Task 4's version ends at the open gate with an honest hold.

```ts
/**
 * `decideDeltaLean()` — THE SECOND DECIDE PATH: HOLD AND ADJUST.
 *
 * ── WHAT THIS ENGINE IS, IN ONE PARAGRAPH ───────────────────────────────────
 * It opens ONE hedged package a day and holds it. When the tape disagrees with
 * the book it NEUTRALISES BY ADDING — buys the opposite option, or sells a
 * same-side one — rather than closing anything. Nothing takes a leg off before
 * the close except four exits: the flatten windows, the day-loss backstop, the
 * day target, and the stuck rule. That is decision D2, and it is the whole
 * design: the engine it replaces had thirteen exit paths and spent 2026-09-22
 * opening strangles and unwinding them five minutes later, 240 orders across
 * four books for ₹6,377.
 *
 * ── THE ORDER, STEP FOR STEP (spec §5) ──────────────────────────────────────
 *
 *   0. **Day roll.** `rollDay` clears yesterday's stop, open and counters on a
 *      new IST date and does NOTHING on the same one. The second half is the
 *      operationally important one: a mid-session restart must never clear a
 *      stop the book set itself, nor let it lay a second package on the first.
 *   1. **The latched stop.** `dlStopped` is terminal until the next day roll.
 *      Legs remaining are flattened urgently; a flat book holds. ABOVE the
 *      clock and above everything the regime has to say, so a book that stopped
 *      itself cannot be talked back in by a tape that looks good.
 *   2. **The clock.** Past `dl_flat_by_min` the residual goes to the blind
 *      ladder; 14:55 urgent, 14:50 passive. ABOVE the session gate on purpose:
 *      the supervisor's SIGTERM is deliberately inert, so a book can wake up
 *      after 15:00 still carrying, and this is the only thing between that and
 *      the overnight carry D4 forbids.
 *   3. **The day-loss backstop** (D6). `totalPnl` — banked plus the open book's
 *      mark — against `dl_day_max_loss`. A DISASTER backstop at ₹2,00,000, not
 *      a working stop: the stuck exit fires an order of magnitude earlier. It
 *      is `totalPnl` and not the stored `dlDayRealized` because a budget
 *      counting only BANKED money would ignore the open loss it exists to stop.
 *   4. **The day target.** The same number, the other way: `dl_day_target`
 *      reached (realised plus unrealised) closes the book on a ladder and stops
 *      the day. The operator's "exit on the day target, ₹10,000 per book".
 *   5. **The gates**: session, detector, warm-up, repair hold, working package.
 *      The DETECTOR RUNS BEFORE THE WARM-UP RETURNS, so 09:15-09:30 classifies
 *      on all three windows and places nothing — a warm-up that returned before
 *      the read would hand the first tradable minute a cold slow window.
 *   6. **The open** (§6.1) — Task 5.
 *   7. **The posture and the adjustment** (§6.2-§6.4) — Tasks 6 and 7.
 *
 * ── WHY 3 AND 4 SIT BELOW 2 AND NOT ABOVE IT ────────────────────────────────
 * Both are exits and both end the day, so the only question their order settles
 * is WHICH REASON a 14:52 flatten is journalled under. The clock's is the one
 * an operator can act on: "it is 14:52" explains a package that the target
 * would also have explained, and the reverse is not true. The backstop still
 * outranks the target, because a book that is somehow at both is a book whose
 * two P&L rails disagree, and the urgent answer is the safe one.
 *
 * ── EVERY EXIT LATCHES, AND ALL BUT ONE LATCH ONCE FLAT ─────────────────────
 * `exitDecision` is the one place a `closeAll` becomes a decision, so the four
 * exits cannot drift apart on this. The BACKSTOP latches immediately, on both
 * states: it fires on a loss that is still growing, and a latch that waited for
 * the flatten to fill would let one more package out in between. The other
 * three latch ONCE FLAT, so a partial fill is re-decided against the book that
 * really exists rather than against a stop that has already been declared.
 *
 * The latch rides on `markState` as well as `stateAfter` wherever it is set.
 * `stateAfter` is persisted only when a decision ROUTES (`types.ts`), so a stop
 * that lived there alone would be undone by a dropped package.
 *
 * ── PACING IS SPLIT, AND DELIBERATELY ───────────────────────────────────────
 * `dl_max_orders_min` is enforced here, in `pace`, because a package's own size
 * is visible to a pure function of one tick. `dl_max_orders_s` and
 * `dl_max_orders_day` are NOT: counting routed orders over a second or a
 * session is the job of the thing that routes them, and the host does it.
 *
 * ── THE TWO GREEK SIGN CONVENTIONS, ONCE, HERE ──────────────────────────────
 * `LegView.delta` is an unsigned MAGNITUDE and `theta`/`gamma` are the
 * CONTRACT's, unsigned by side (`marking.ts`). `strikeGreeks` signs delta by
 * wing and leaves the rest contract-signed. Everything below therefore applies
 * BOTH signs — wing and side — exactly once, in `legDeltaLots` for held legs
 * and in `strikeDeltaLots` for candidates, and nothing downstream reapplies
 * either. A sign applied twice reads as a book leaning the wrong way, which is
 * indistinguishable from a bad strategy until it has paid for itself.
 *
 * ── URGENCY IS A FIELD, AND `makerQuote` IS FALSE EVERYWHERE HERE ───────────
 *   opens and adjustments              `'passive'`  — worked at the touch
 *   the backstop, the latched stop,    `'urgent'`   — crossed now
 *   the 14:55 flatten
 *   the 14:50 flatten                  `'passive'`  — worked, not crossed
 *   the target, the stuck exit, and    `'ladder'`   — it must be out
 *   the residual past `dl_flat_by_min`
 *
 * `makerQuote` means "the liquidity gate refused this strike's book" and this
 * controller never asks that gate, so it has nothing to report and says FALSE.
 *
 * PURE, like the rest of the engine: no clock, no feed, no Mongo. `nowMs`,
 * `dateIst` and `minuteOfDay` are fields of `inputs` so a fixture can replay a
 * session that is long over.
 */

import type { Dials } from '../dials.ts';
import { type MarkContext, totalPnl } from '../guards.ts';
import { isTradingDay } from '../session.ts';
import type {
  EngineAction,
  EngineDecision,
  EngineInputs,
  LegView,
  OptType,
  RuleState,
  Side,
  Trigger,
  Urgency,
} from '../types.ts';
import { rollDay } from './lean.ts';
import { readRegime, type Regime, type SpotRing } from './regime.ts';

/**
 * What the controller needs beyond an ordinary `EngineInputs`.
 *
 * Four quantities no snapshot of a chain can carry, each REQUIRED rather than
 * optional for the reason `types.ts` gives: an absent reading and a zero one
 * must never be the same read.
 *
 *   - `ring` is the host's shared spot buffer, one per symbol. The detector
 *     reads it; nothing here writes it.
 *   - `minutesToExpiry` is TRADING minutes, holidays already removed. Pass
 *     calendar minutes and every implied window move is quoted cheap, which
 *     turns ordinary noise into a trend the book acts on.
 *   - `ordersThisMinute` is the book's own count so far this minute, for
 *     `dl_max_orders_min`.
 *   - `spotAsOf` is the epoch ms of the newest tick pushed into `ring`. Derived
 *     from the chain it would be the wrong feed's clock, and `SpotRing` exposes
 *     no newest-sample accessor — so the host states it.
 */
export interface DeltaLeanInputs extends EngineInputs {
  readonly ring: SpotRing;
  readonly minutesToExpiry: number;
  readonly ordersThisMinute: number;
  readonly spotAsOf: number;
}

/** Rupees, grouped as every other reason in this engine groups them. */
const inr = (x: number): string => `Rs${Math.round(x).toLocaleString('en-US')}`;

/** An IST minute-of-day as `HH:MM`, so a clock gate names a time an operator
 * can find on a chart rather than a minute count. */
const clock = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Delta-lots are floats; two that agree to a billionth are the same number. */
const EPS = 1e-9;

const REGIME_NAMES: readonly string[] = ['trend-up', 'trend-down', 'quiet', 'chop', 'unknown'];

const wingSign = (t: OptType): number => (t === 'CE' ? 1 : -1);
const sideSign = (s: Side): number => (s === 'Buy' ? 1 : -1);

/** The book's own last label, read back off a `string` field that is '' before
 * the first classification. '' is 'unknown' — never 'quiet'. */
function prevRegime(state: RuleState): Regime {
  return REGIME_NAMES.includes(state.dlRegime) ? (state.dlRegime as Regime) : 'unknown';
}

/** One leg's contribution to the book's net delta, in DELTA-LOTS: both signs —
 * wing and side — applied exactly once, here. */
function legDeltaLots(leg: LegView): number {
  return wingSign(leg.optType) * sideSign(leg.side) * Math.abs(leg.delta) * leg.lots;
}

/**
 * Is the index price too old to take NEW RISK against?
 *
 * A refusal of new risk and nothing more. Deciding an EXIT on a price ten
 * seconds old is safer than not exiting; opening or adjusting on one is paying
 * a spread for a position the book cannot currently see.
 */
function spotStale(inputs: DeltaLeanInputs, dials: Dials): boolean {
  return (inputs.nowMs - inputs.spotAsOf) / 1000 > dials.dl_spot_stale_s;
}

// ── decisions ───────────────────────────────────────────────────────────────

/** A hold: no actions, so there is no acting delta to leave out of `markState`
 * and the two states are the same value by construction (`types.ts`). */
function hold(reason: string, state: RuleState, trigger: Trigger = 'none'): EngineDecision {
  return {
    action: 'hold',
    trigger,
    reason,
    actions: [],
    stateAfter: state,
    markState: state,
    urgency: 'passive',
    makerQuote: false,
    creditCommit: null,
  };
}

/**
 * A package.
 *
 * No stamping and no clock. The v1 version wrote a lean id onto every open and
 * a `dlLastAddMs` beside it, in here, so a new open site could not forget
 * either; this engine has no lean and stamps its cooldown at the two sites that
 * form a package (the open and the adjustment), because those are the only two
 * and each writes a different set of counters beside it.
 */
function acted(
  action: 'adjust' | 'flatten',
  trigger: Trigger,
  reason: string,
  actions: readonly EngineAction[],
  stateAfter: RuleState,
  markState: RuleState,
  urgency: Urgency,
): EngineDecision {
  return {
    action,
    trigger,
    reason,
    actions,
    stateAfter,
    markState,
    urgency,
    // ALWAYS false on this path: `makerQuote` is the liquidity gate's refusal
    // (`shed.ts` §4) and this controller never asks that gate.
    makerQuote: false,
    creditCommit: null,
  };
}

/**
 * Close the whole book, SHORTS FIRST.
 *
 * Spec §6.5's leg ordering, on the way out: the short is bought back before the
 * long or the wing is sold, so the book is never naked — not even for the
 * instant between two fills, which is exactly when an index gaps.
 */
function closeAll(legs: readonly LegView[]): readonly EngineAction[] {
  const ordered = [...legs].sort((a, b) => sideSign(a.side) - sideSign(b.side));
  return ordered.map((l): EngineAction => ({ op: 'close', instrument: l.instrument }));
}

/**
 * THE ONE PLACE A `closeAll` BECOMES A DECISION — so the four exits of §6.5
 * cannot drift apart on how they latch.
 *
 * `latchWhenFlat` false means "latch NOW, on both states": the day-loss
 * backstop alone, because it fires on a loss that is still growing and a latch
 * that waited for the flatten to fill would let one more package out in
 * between. The other three latch once the book is flat, so a partial fill is
 * re-decided against the book that really exists.
 */
function exitDecision(
  inputs: DeltaLeanInputs,
  trigger: Trigger,
  reason: string,
  urgency: Urgency,
  st: RuleState,
  latchWhenFlat: boolean,
): EngineDecision {
  const { legs } = inputs;
  if (legs.length === 0) {
    return hold(`${reason} — flat already`, { ...st, dlStopped: true }, trigger);
  }
  const after: RuleState = latchWhenFlat ? st : { ...st, dlStopped: true };
  return acted(
    'flatten',
    trigger,
    `${reason} — closing all ${legs.length} leg(s)`,
    closeAll(legs),
    after,
    after,
    urgency,
  );
}

/**
 * The per-minute order budget, applied to the CONTROLLER's package only — a
 * guard flatten is never budgeted.
 *
 * Opens go first and go WHOLE: half a debit pair is a naked leg, and a naked
 * leg is the one outcome every ordering rule in this file exists to prevent.
 * Exits survive to the last slot, because a book that cannot place its exit is
 * in more trouble than a book that cannot place its add.
 */
function pace(
  actions: readonly EngineAction[],
  inputs: DeltaLeanInputs,
  dials: Dials,
): readonly EngineAction[] {
  const budget = dials.dl_max_orders_min - inputs.ordersThisMinute;
  if (budget >= actions.length) return actions;
  const exits = actions.filter((a) => a.op !== 'open');
  if (budget >= exits.length) return exits;
  return exits.slice(0, Math.max(0, budget));
}

// ── the pass ────────────────────────────────────────────────────────────────

/**
 * One decision pass over one tick of one delta-lean book.
 *
 * `markCtx` is accepted so both decide paths present one signature to
 * `EngineHost` and is deliberately unread: the 5-minute mark grid is the
 * recenter engine's, and spec §10 requires it not to gate this variant's
 * per-second evaluation.
 */
export function decideDeltaLean(
  inputs: DeltaLeanInputs,
  dials: Dials,
  state: RuleState,
  markCtx: MarkContext,
): EngineDecision {
  void markCtx;
  const { legs, minuteOfDay, dateIst, nowMs } = inputs;

  // ── 0. the day roll ──────────────────────────────────────────────────────
  const rolled = rollDay(state, dateIst, nowMs);

  // ── 1. the latched stop ──────────────────────────────────────────────────
  if (rolled.dlStopped) {
    if (legs.length === 0) return hold('stopped for the day', rolled, 'dl-stop');
    return acted(
      'flatten',
      'dl-stop',
      `stopped for the day — closing all ${legs.length} leg(s)`,
      closeAll(legs),
      rolled,
      rolled,
      'urgent',
    );
  }

  // ── 2. the clock ─────────────────────────────────────────────────────────
  // ABOVE the session gate: a book that woke up after 15:00 still carrying has
  // nothing else between it and an overnight position.
  if (minuteOfDay >= dials.dl_flat_by_min) {
    return exitDecision(
      inputs, 'eod',
      `${clock(minuteOfDay)} is past the ${clock(dials.dl_flat_by_min)} flat-by`,
      'ladder', rolled, true,
    );
  }
  if (minuteOfDay >= dials.dl_flatten_urgent_min) {
    return exitDecision(inputs, 'eod', `${clock(minuteOfDay)}: urgent flatten`, 'urgent', rolled, true);
  }
  if (minuteOfDay >= dials.dl_flatten_passive_min) {
    return exitDecision(
      inputs, 'eod', `${clock(minuteOfDay)}: passive flatten — worked, not crossed`,
      'passive', rolled, true,
    );
  }

  // ── 3. the day-loss backstop (D6) ────────────────────────────────────────
  // `totalPnl` is banked plus the open book's mark. It latches IMMEDIATELY, on
  // both states — see `exitDecision`.
  const dayPnl = totalPnl(inputs);
  if (dayPnl <= -dials.dl_day_max_loss) {
    return exitDecision(
      inputs, 'dl-stop',
      `day backstop: ${inr(dayPnl)} through the ${inr(-dials.dl_day_max_loss)} floor`,
      'urgent', rolled, false,
    );
  }

  // ── 4. the day target ────────────────────────────────────────────────────
  if (dayPnl >= dials.dl_day_target) {
    return exitDecision(
      inputs, 'dl-target',
      `day target: ${inr(dayPnl)} at or past ${inr(dials.dl_day_target)} — banking it`,
      'ladder', rolled, true,
    );
  }

  // ── 5. the gates ─────────────────────────────────────────────────────────
  if (!isTradingDay(dateIst)) return hold(`${dateIst} is not an NSE trading day`, rolled);

  // The DETECTOR runs before the warm-up returns: 09:15-09:30 classifies on all
  // three windows and places nothing, so the first tradable minute has a warm
  // slow window rather than a cold one.
  const read = readRegime(
    inputs.ring,
    inputs.chain,
    nowMs,
    inputs.minutesToExpiry,
    dials,
    prevRegime(rolled),
    rolled.dlRegimeSinceMs === 0 ? null : rolled.dlRegimeSinceMs,
  );
  // The regime clock restamps on a CHANGE and only on a change: it is the
  // confirmation reference for the open and for every adjustment, so restamping
  // it on an unchanged reading would mean no regime ever confirms.
  const st: RuleState =
    read.slow === rolled.dlRegime
      ? rolled
      : { ...rolled, dlRegime: read.slow, dlRegimeSinceMs: nowMs };

  if (minuteOfDay < dials.dl_warmup_min) {
    return hold(
      `warm-up: ${clock(minuteOfDay)} is before ${clock(dials.dl_warmup_min)} — the detector ran (${read.slow}), no orders`,
      st,
    );
  }
  if (inputs.repairHold) {
    return hold('repair-Apply is working this tag — standing down until it finishes', st);
  }
  if (inputs.pendingLots > 0) {
    return hold(`working package: ${inputs.pendingLots} lots still being worked`, st);
  }
  if (spotStale(inputs, dials)) {
    const ageS = (nowMs - inputs.spotAsOf) / 1000;
    return hold(
      `the index is ${ageS.toFixed(1)}s stale, past ${dials.dl_spot_stale_s}s — no new risk (exits still run)`,
      st,
    );
  }

  // ── 6/7. the open and the adjustment ─────────────────────────────────────
  // Task 5 replaces this line with the open rule, and Tasks 6-7 with the
  // posture and the adjustment.
  return hold(`${read.slow}: holding`, st);
}
```

The unused `EPS` and `legDeltaLots` will be referenced by Task 6; TypeScript's `noUnusedLocals` may object in the meantime. If `tsc` complains, leave them and add `/* used by the posture rule below */` — do NOT delete them, Task 6 needs both and this plan's type consistency depends on the names.

- [ ] **Step 4: Run the decide tests**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: PASS for sections 1-4. (Section 3's `notEqual(d.trigger, 'dl-target')` passes because a near-target book falls through to the closing hold.)

- [ ] **Step 5: Check the package still type-checks**

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'delta-lean|types.ts|dials.ts|presets.ts'`
Expected: only `engine-host.ts`/`index.ts` errors about the deleted exports, which are Tasks 9 and 10.

- [ ] **Step 6: Commit**

```bash
git add packages/desk-engine/src/delta-lean/decide.ts packages/desk-engine/test/delta-lean-decide.test.ts
git commit -m "feat(delta-lean): the day lifecycle and the four exits"
```

---

### Task 5: `decide.ts` part B — the open (spec §6.1)

**Files:**
- Modify: `packages/desk-engine/src/delta-lean/decide.ts` — add the margin helpers and `openPackage`; replace the closing `return hold(...)` of `decideDeltaLean` with step 6
- Modify: `packages/desk-engine/test/delta-lean-decide.test.ts` — append section 5

**Interfaces:**
- Consumes: Task 4's `DeltaLeanInputs`, `decideDeltaLean(inputs, dials, state, markCtx)`, `hold(reason, state, trigger?)`, `acted(action, trigger, reason, actions, stateAfter, markState, urgency)`, `pace(actions, inputs, dials)`, `spotStale(inputs, dials)`, `inr`, `clock`; Task 3's `debitUnit(chain, side, dials, dateIst, minuteOfDay)` and `creditUnit(chain, side, lots, dials, dateIst, minuteOfDay)`; `margin-project.ts`'s `spanLiteMargin(legs: ReadonlyArray<SpanLeg>, spot: number, dateIst: string): SpanResult` (read `.total`), `bookSpanLegs(legs: ReadonlyArray<LegView>, expiry: string): ReadonlyArray<SpanLeg>` and `type SpanLeg { strike; optType; side; lots; lotSize; iv: number | null; expiry }`.
- Produces — used by Tasks 6, 7 and 8:
  - `type OpenAction = Extract<EngineAction, { op: 'open' }>`
  - `function spanLegOf(a: OpenAction, lotSize: number, expiry: string): SpanLeg` — `iv: null`, `lots: Math.trunc(a.lots)`.
  - `function projectFits(inputs: DeltaLeanInputs, dials: Dials, opens: readonly EngineAction[]): boolean` — `spanLiteMargin(bookLegs ++ opens, chain.spot, dateIst).total <= dials.margin_cap`.
  - `function scaleLots(actions: readonly EngineAction[], lots: number): readonly EngineAction[]` — every `open` action's `lots` set to `lots`; a non-open is returned untouched.
  - `function fitLots(inputs: DeltaLeanInputs, dials: Dials, unit: readonly EngineAction[], maxLots: number): number` — the LARGEST `n` in `[0, maxLots]` whose scaled package fits the cap. Truncation, never rounding up. `0` means nothing fits.
  - `function openPackage(inputs: DeltaLeanInputs, dials: Dials, regime: Regime): { readonly actions: readonly EngineAction[]; readonly side: 'up' | 'down' | 'none' } | null`
  - `function confirmed(st: RuleState, dials: Dials, nowMs: number): boolean` — `st.dlRegimeSinceMs !== 0 && nowMs - st.dlRegimeSinceMs >= dials.dl_adjust_confirm_s * 1000`.

- [ ] **Step 1: Append the failing open tests**

Append to `packages/desk-engine/test/delta-lean-decide.test.ts`:

```ts
// ════════════════════════════════════════════════════════════ 5. the open

test('a confirmed trend-up opens the debit pair: 4 lots long, 4 lots hedged', () => {
  // D3: one hedge, placed at open. For a trend it is the sold further-OTM
  // option of the same type — the debit pair's short — and nothing removes it
  // before the close.
  const d = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, TODAY, MARK)
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.urgency, 'passive', 'an open is WORKED at the touch, never crossed')
  assert.equal(d.actions.length, 2)
  const b = buys(d.actions)
  const s = sells(d.actions)
  assert.equal(b.length, 1)
  assert.equal(s.length, 1)
  assert.equal(b[0]?.strike, 23_950)
  assert.equal(b[0]?.optType, 'CE')
  assert.equal(b[0]?.lots, 4, 'dl_open_lots, in CONTRACT lots (D7)')
  assert.equal(s[0]?.strike, 24_200)
  assert.equal(s[0]?.optType, 'CE')
  assert.equal(s[0]?.lots, 4)
  assert.ok(
    d.actions.indexOf(b[0] as EngineAction) < d.actions.indexOf(s[0] as EngineAction),
    'the LONG is emitted first — the book is never short a leg it has not covered',
  )
})

test('the open records the side, the instant, the cooldown and the regime that justified it', () => {
  const d = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, TODAY, MARK)
  assert.equal(d.stateAfter.dlOpenSide, 'up')
  assert.equal(d.stateAfter.dlOpenedMs, NOW)
  assert.equal(d.stateAfter.dlLastAdjustMs, NOW, 'THE OPEN COUNTS AS THE FIRST PACKAGE')
  assert.equal(d.stateAfter.dlLastAdjustRegime, 'trend-up')
  assert.equal(d.stateAfter.dlAdjustsToday, 0, 'the open is not an adjustment')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0)
  // `markState` is the book BEFORE the package: a dropped open must not leave
  // the row saying the book opened.
  assert.equal(d.markState.dlOpenedMs, 0)
  assert.equal(d.markState.dlOpenSide, '')
})

test('a confirmed trend-down opens the same structure on the put ladder', () => {
  const d = decideDeltaLean(inputsIn({ ring: trending(-1) }), DIALS, TODAY, MARK)
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.stateAfter.dlOpenSide, 'down')
  assert.equal(buys(d.actions)[0]?.optType, 'PE')
  assert.equal(buys(d.actions)[0]?.strike, 24_050)
  assert.equal(sells(d.actions)[0]?.optType, 'PE')
  assert.equal(sells(d.actions)[0]?.strike, 23_800)
})

test('a confirmed quiet opens BOTH credit wings, four legs, and records `none`', () => {
  // D3: for a quiet open the hedge IS the strangle's two wings.
  const d = decideDeltaLean(inputsIn({ ring: quietTape() }), DIALS, TODAY, MARK)
  assert.equal(d.trigger, 'dl-open')
  assert.equal(d.stateAfter.dlOpenSide, 'none')
  assert.equal(d.actions.length, 4)
  assert.equal(sells(d.actions).length, 2, 'one short each side')
  assert.equal(buys(d.actions).length, 2, 'and a wing behind each of them')
  for (const sell of sells(d.actions)) assert.equal(sell.lots, 4)
  for (const wing of buys(d.actions)) assert.equal(wing.lots, 4)
  // Each side's wing is bought BEFORE its short is sold.
  const ceWing = buys(d.actions).find((a) => a.optType === 'CE')
  const ceShort = sells(d.actions).find((a) => a.optType === 'CE')
  assert.ok(ceWing !== undefined && ceShort !== undefined)
  assert.ok(d.actions.indexOf(ceWing) < d.actions.indexOf(ceShort))
})

test('chop opens NOTHING, and neither does unknown', () => {
  // `'unknown'` is not `'quiet'`. Quiet is the one regime that SELLS premium,
  // and a strangle sold into a chain that stopped printing is the worst thing
  // this path can cause.
  for (const ring of [choppy(), DEAD_FEED]) {
    const d = decideDeltaLean(inputsIn({ ring }), DIALS, TODAY, MARK)
    assert.equal(d.action, 'hold')
    assert.equal(d.actions.length, 0)
  }
})

test('an unconfirmed regime waits out `dl_adjust_confirm_s` before opening', () => {
  // The clock is `dlRegimeSinceMs` and the gate is 60s aggressive / 120s
  // conservative. A regime that has been on for one second is a tick, not a
  // reading.
  const fresh: RuleState = { ...TODAY, dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 59_000 }
  const early = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, fresh, MARK)
  assert.equal(early.action, 'hold')
  assert.ok(early.reason.includes('confirm'), `the ledger must say why: ${early.reason}`)

  const ripe: RuleState = { ...TODAY, dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 60_000 }
  const late = decideDeltaLean(inputsIn({ ring: trending(1) }), DIALS, ripe, MARK)
  assert.equal(late.trigger, 'dl-open', 'the boundary is inclusive')
})

test('the conservative preset waits twice as long', () => {
  const d = dialsOf({ dl_adjust_confirm_s: 120, dl_open_lots: 2 })
  const at60: RuleState = { ...TODAY, dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 60_000 }
  assert.equal(decideDeltaLean(inputsIn({ ring: trending(1) }), d, at60, MARK).action, 'hold')
  const at120: RuleState = { ...TODAY, dlRegime: 'trend-up', dlRegimeSinceMs: NOW - 120_000 }
  const open = decideDeltaLean(inputsIn({ ring: trending(1) }), d, at120, MARK)
  assert.equal(open.trigger, 'dl-open')
  assert.equal(buys(open.actions)[0]?.lots, 2, 'and opens two lots, not four')
})

test('an OPENED book never opens again, however good the tape looks', () => {
  // ONE PACKAGE A DAY (D3). `dlOpenedMs` is the whole gate, and it survives a
  // restart through the state row.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: OPENED_UP() }),
    DIALS, opened('up'), MARK,
  )
  assert.notEqual(d.trigger, 'dl-open')
})

test('a package that does not fit the SPAN cap is NOT opened, and the stuck rule does not apply', () => {
  /**
   * §6.1: "if even one lot does not fit, do not open (and the stuck rule does
   * not apply — there is nothing to lose)." The stuck clock must stay at 0: a
   * book that never opened cannot be stuck in a losing position, and arming the
   * clock here would exit a flat book on a cap it never spent.
   */
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape() }),          // a strangle: two shorts, real margin
    dialsOf({ margin_cap: 1 }),
    TODAY, MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0, 'no stuck clock on a book with nothing to lose')
  assert.equal(d.stateAfter.dlOpenedMs, 0)
  assert.ok(d.reason.includes('cap'), `the ledger must name the cap: ${d.reason}`)
})

test('a cap that fits fewer lots TRUNCATES the open — it never rounds up', () => {
  /**
   * §6.3's rule applied to the open: shrink to the largest size that fits.
   * Found by walking DOWN from `dl_open_lots`, so a cap between two sizes
   * always lands on the smaller.
   */
  const full = decideDeltaLean(inputsIn({ ring: quietTape() }), DIALS, TODAY, MARK)
  const fourLots = spanTotalOf(full.actions, 4)
  const twoLots = spanTotalOf(full.actions, 2)
  assert.ok(twoLots < fourLots, 'the fixture must price four lots dearer than two')

  // A cap between two and three lots: two is what fits.
  const squeezed = decideDeltaLean(
    inputsIn({ ring: quietTape() }),
    dialsOf({ margin_cap: Math.floor((twoLots + spanTotalOf(full.actions, 3)) / 2) }),
    TODAY, MARK,
  )
  assert.equal(squeezed.trigger, 'dl-open')
  for (const a of opens(squeezed.actions)) assert.equal(a.lots, 2)
})

test('a BUY-only package always fits — a long option never raises SPAN-lite', () => {
  // §6.3: "Buys are projected too (a Buy never raises SPAN-lite, so they always
  // pass)." A cap of one rupee must still let a pure debit through, which is
  // what makes the `counter` neutralising buy of §6.2 unconditional — the book
  // is long from an up open, the tape has turned down, and no margin ceiling
  // may stand between it and getting back to flat.
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    dialsOf({ margin_cap: 1 }),
    opened('up'),
    MARK,
  )
  assert.equal(opens(d.actions).length > 0, true, 'a debit adjustment is not capped out')
  assert.equal(buys(d.actions)[0]?.optType, 'PE')
  assert.equal(sells(d.actions).length, 0)
})

test('the open is paced like any package — but an exit is not', () => {
  const squeezed = decideDeltaLean(
    inputsIn({ ring: quietTape(), ordersThisMinute: 38 }),   // 2 slots left, 4 legs wanted
    DIALS, TODAY, MARK,
  )
  assert.equal(squeezed.action, 'hold', 'opens go WHOLE OR NOT AT ALL — half a strangle is naked')
  assert.ok(squeezed.reason.includes('budget'), `the ledger must say so: ${squeezed.reason}`)

  const out = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: OPENED_UP(), cumRealized: -200_001, ordersThisMinute: 40 }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(out.action, 'flatten', 'no rate limit is worth carrying the position')
  assert.equal(exits(out.actions).length, 2)
})
```

Add this helper beside the other fixture helpers (above section 1), because two tests above need it:

```ts
/** What `spanLiteMargin` prices a package at, at `lots` a leg — the same
 * arithmetic the engine's own gate does, so a cap in a test is a number the
 * engine will agree with rather than one guessed at. */
function spanTotalOf(actions: readonly EngineAction[], lots: number): number {
  const legs = opens(actions).map((a) => ({
    strike: a.strike,
    optType: a.optType,
    side: a.side,
    lots,
    lotSize: LOT,
    iv: null,
    expiry: EXPIRY,
  }))
  return spanLiteMargin(legs, SPOT, DATE).total
}
```

and add `import { spanLiteMargin } from '../src/margin-project.ts'` to the test's imports.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: FAIL — every section-5 test reports `action: 'hold'` with reason `"trend-up: holding"`.

- [ ] **Step 3: Add the margin helpers to `decide.ts`**

Add these imports to `packages/desk-engine/src/delta-lean/decide.ts`:

```ts
import { bookSpanLegs, spanLiteMargin, type SpanLeg } from '../margin-project.ts';
import { creditUnit, debitUnit } from './express.ts';
```

and insert this block after `pace` and before `// ── the pass ──`:

```ts
// ── the margin cap (D4, §6.3) ───────────────────────────────────────────────

/** The `'open'` arm, narrowed once so the sizing helpers can read a `strike`
 * and a `side` without re-narrowing at every call site. */
type OpenAction = Extract<EngineAction, { op: 'open' }>;

/**
 * A leg the decision would OPEN, as the SPAN-lite grid sees it.
 *
 * `iv: null` — so `SPAN_LITE.defaultIv` prices it — because that is what
 * `margin-project.ts` does for every projected sale on this desk, and solving
 * the strike's real IV here would be a better model and a worse port: it would
 * move this gate away from the numbers every committed board was sized under,
 * silently.
 */
function spanLegOf(a: OpenAction, lotSize: number, expiry: string): SpanLeg {
  return {
    strike: a.strike,
    optType: a.optType,
    side: a.side,
    lots: Math.trunc(a.lots),
    lotSize,
    iv: null,
    expiry,
  };
}

/**
 * DOES THE WHOLE PACKAGE FIT UNDER `margin_cap`? (D4.)
 *
 * The cap is priced on the BOOK PLUS THE PACKAGE with `spanLiteMargin`, never
 * on the package alone, because that is the only way a hedged or cross-side leg
 * gets its offset: a 4-lot short call against a 4-lot long call one strike in
 * is a bounded spread the grid prices as one, and a per-leg naked figure would
 * refuse the entire strategy.
 *
 * It is also why this is a projection and not a reading of `inputs.margin`: the
 * broker's number describes the book that exists, and this question is about
 * the book the package would create.
 */
function projectFits(
  inputs: DeltaLeanInputs,
  dials: Dials,
  opens: readonly EngineAction[],
): boolean {
  const { chain, dateIst, legs } = inputs;
  const projected = [
    ...bookSpanLegs(legs, chain.expiry),
    ...opens
      .filter((a): a is OpenAction => a.op === 'open')
      .map((a) => spanLegOf(a, chain.lotSize, chain.expiry)),
  ];
  if (projected.length === 0) return true;
  return spanLiteMargin(projected, chain.spot, dateIst).total <= dials.margin_cap;
}

/** The same package at `lots` a leg. `express.ts` builds its structures one lot
 * a leg and the caller scales them, so that the structure and the size are
 * decided in different places and neither can quietly imply the other. */
function scaleLots(actions: readonly EngineAction[], lots: number): readonly EngineAction[] {
  return actions.map((a) => (a.op === 'open' ? { ...a, lots } : a));
}

/**
 * THE LARGEST SIZE THAT FITS, BY TRUNCATION — never by rounding up (§6.3).
 *
 * Walked DOWN from `maxLots`, so a cap that lands between two sizes always
 * takes the smaller, and 0 is a real answer meaning "not even one lot". The
 * walk is linear rather than a binary search because `maxLots` here is
 * `dl_open_lots` (2-4) or an adjustment's computed lots (single digits), and a
 * loop that is obviously correct beats one that is merely fast — `spanLiteMargin`
 * is a 21-scenario grid over a handful of legs.
 */
function fitLots(
  inputs: DeltaLeanInputs,
  dials: Dials,
  unit: readonly EngineAction[],
  maxLots: number,
): number {
  for (let n = Math.max(0, Math.trunc(maxLots)); n >= 1; n -= 1) {
    if (projectFits(inputs, dials, scaleLots(unit, n))) return n;
  }
  return 0;
}

// ── the open (§6.1) ─────────────────────────────────────────────────────────

/**
 * THE DAY'S ONE PACKAGE, hedge included (D3).
 *
 *   `trend-up`   a CE debit pair: buy the `dl_long_delta` band, sell the
 *                `dl_short_delta` band further out. The SHORT IS THE HEDGE.
 *   `trend-down` the same on the put ladder.
 *   `quiet`      both credit units — the strangle, whose two WINGS are its
 *                hedge.
 *
 * `null` for `chop` and `unknown`, and for a chain the bands cannot be found
 * on. `'unknown'` is not `'quiet'`: quiet is the one regime that SELLS premium,
 * and a strangle sold into a chain that stopped printing is the worst thing
 * this engine can cause.
 *
 * The package is margin-projected and TRUNCATED down to what fits. If not one
 * lot fits it does not go on — and the stuck rule does not apply, because a
 * book that never opened has nothing to lose.
 */
function openPackage(
  inputs: DeltaLeanInputs,
  dials: Dials,
  regime: Regime,
): { readonly actions: readonly EngineAction[]; readonly side: 'up' | 'down' | 'none' } | null {
  const { chain, dateIst, minuteOfDay } = inputs;
  const side: 'up' | 'down' | 'none' | null =
    regime === 'trend-up' ? 'up' : regime === 'trend-down' ? 'down' : regime === 'quiet' ? 'none' : null;
  if (side === null) return null;

  let unit: readonly EngineAction[];
  if (side === 'none') {
    // Two credit units, one each way. `creditUnit` takes its own lots, so build
    // both at one lot and let `fitLots` scale the pair together — sizing the
    // two sides independently could leave a strangle lopsided.
    const up = creditUnit(chain, 'up', 1, dials, dateIst, minuteOfDay);
    const down = creditUnit(chain, 'down', 1, dials, dateIst, minuteOfDay);
    if (up === null || down === null) return null;
    unit = [...up, ...down];
  } else {
    const pair = debitUnit(chain, side, dials, dateIst, minuteOfDay);
    if (pair === null) return null;
    unit = pair;
  }

  const lots = fitLots(inputs, dials, unit, dials.dl_open_lots);
  if (lots === 0) return null;
  return { actions: scaleLots(unit, lots), side };
}

/**
 * Has the current regime held long enough to justify a package?
 *
 * `dlRegimeSinceMs` 0 is "no reading yet" and never confirms — a book whose
 * clock was never stamped has not measured anything. The comparison is
 * INCLUSIVE: exactly `dl_adjust_confirm_s` later is confirmed, because a gate
 * that fired one tick late would be a different dial.
 */
function confirmed(st: RuleState, dials: Dials, nowMs: number): boolean {
  return st.dlRegimeSinceMs !== 0 && nowMs - st.dlRegimeSinceMs >= dials.dl_adjust_confirm_s * 1000;
}
```

- [ ] **Step 4: Wire step 6 into `decideDeltaLean`**

Replace the closing two lines of `decideDeltaLean` (the `// ── 6/7 …` comment and `return hold(\`${read.slow}: holding\`, st);`) with:

```ts
  // ── 6. the open (§6.1) ───────────────────────────────────────────────────
  if (st.dlOpenedMs === 0) {
    if (read.slow === 'chop' || read.slow === 'unknown') {
      return hold(`${read.slow}: nothing to express — waiting for a trend or a quiet range`, st);
    }
    if (!confirmed(st, dials, nowMs)) {
      const heldS = ((nowMs - st.dlRegimeSinceMs) / 1000).toFixed(0);
      return hold(
        `${read.slow} for ${heldS}s — inside the ${dials.dl_adjust_confirm_s}s confirm window`,
        st,
      );
    }
    const pkg = openPackage(inputs, dials, read.slow);
    if (pkg === null) {
      return hold(
        `${read.slow}: the open does not fit the ${inr(dials.margin_cap)} SPAN cap (or the bands are not on this chain) — nothing opened`,
        st,
      );
    }
    const paced = pace(pkg.actions, inputs, dials);
    if (paced.length < pkg.actions.length) {
      // WHOLE OR NOTHING. Half a debit pair is a naked leg and two of a
      // strangle's four is a short with no wing.
      return hold(`${read.slow}: the open needs ${pkg.actions.length} orders [order budget]`, st);
    }
    const after: RuleState = {
      ...st,
      dlOpenedMs: nowMs,
      dlOpenSide: pkg.side,
      // THE OPEN COUNTS AS THE FIRST PACKAGE, so the first adjustment is a
      // whole `dl_adjust_cooldown_s` away rather than available next tick.
      dlLastAdjustMs: nowMs,
      // And it is the package this regime justified, so the SAME regime cannot
      // justify the next one.
      dlLastAdjustRegime: read.slow,
      dlBlockedSinceMs: 0,
    };
    return acted(
      'adjust',
      'dl-open',
      `${read.slow}: opening ${pkg.side} at ${paced.filter((a) => a.op === 'open').length} leg(s), hedge included`,
      paced,
      after,
      // `markState` is the book BEFORE the package: a dropped open must not
      // leave the row saying the book opened.
      st,
      'passive',
    );
  }

  // ── 7. the posture and the adjustment (§6.2-§6.4) ────────────────────────
  // Tasks 6 and 7 replace this line.
  return hold(`${read.slow}: opened ${st.dlOpenSide}, holding`, st);
```

- [ ] **Step 5: Run the decide tests**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: PASS for sections 1-5, except `a BUY-only package always fits` which needs Task 6's adjustment rule — mark that one `test.skip` with the comment `// unskipped in Task 6: the debit adjustment does not exist yet` and unskip it there.

- [ ] **Step 6: Commit**

```bash
git add packages/desk-engine/src/delta-lean/decide.ts packages/desk-engine/test/delta-lean-decide.test.ts
git commit -m "feat(delta-lean): the one hedged open of the day, SPAN-capped and truncated"
```

---

### Task 6: `decide.ts` part C — posture and adjustment (spec §6.2)

**Files:**
- Modify: `packages/desk-engine/src/delta-lean/decide.ts` — add the posture helpers and `adjustmentPackage`; replace step 7's hold
- Modify: `packages/desk-engine/test/delta-lean-decide.test.ts` — append section 6, unskip the Task 5 test

**Interfaces:**
- Consumes: Task 4's `legDeltaLots`, `EPS`, `hold`, `acted`, `pace`, `confirmed`; Task 5's `scaleLots`, `OpenAction`; Task 3's `deltaBandStrike(chain, optType, lo, hi, dateIst, minuteOfDay, dials)`; `marking.ts`'s `strikeGreeks(chain, strike, optType, dateIst, minuteOfDay): { delta; gamma; theta; vega; iv } | null` (delta SIGNED BY WING).
- Produces — used by Tasks 7 and 8:
  - `function netDeltaLots(legs: readonly LegView[]): { readonly lots: number; readonly priced: boolean }` — `priced` false when ANY leg has `hasGreeks: false`; `lots` is the sum over the priced ones. A caller HOLDS on `priced: false` rather than sizing against a partial sum.
  - `function unitDelta(dials: Dials): number` — spec §6.2's `D`: `dl_open_lots * (mid(long band) - mid(short band))`, i.e. `4 * (0.60 - 0.25) = 1.4`. The HEDGED PAIR's own net delta, which is why a freshly opened trend book meets its own posture exactly.
  - `type PostureMode = 'lean' | 'counter' | 'flat'`
  - `interface Posture { readonly mode: PostureMode; readonly target: number; readonly direction: 1 | -1 | 0 }` — `direction` is the only sign of gap the posture will act on; `0` means either (the two-sided `'flat'` case).
  - `function wantedPosture(regime: Regime, openSide: RuleState['dlOpenSide'], dials: Dials): Posture | null` — the posture is relative to the OPEN'S OWN SIDE:
    - `quiet`/`chop` → `{ mode: 'flat', target: 0, direction: 0 }`
    - `trend-up` and `openSide === 'up'` → `{ mode: 'lean', target: +D, direction: 1 }`
    - `trend-down` and `openSide === 'down'` → `{ mode: 'lean', target: -D, direction: -1 }`
    - `trend-up` otherwise (a `'down'` open, or a `'none'` strangle) → `{ mode: 'counter', target: 0, direction: 1 }`
    - `trend-down` otherwise → `{ mode: 'counter', target: 0, direction: -1 }`
    - `unknown` → `null`
  - `function postureGap(posture: Posture, net: number, band: number): number` — the signed delta-lots the book is SHORT OF ITS POSTURE, or `0` when the posture is met. A posture with a `direction` only ever reports a gap of that sign, which is what makes "adds only" and "never reverse" expressible at the same time.
  - `function adjustmentPackage(inputs: DeltaLeanInputs, dials: Dials, gap: number, mode: PostureMode): { readonly unit: readonly EngineAction[]; readonly lots: number } | null` — the ONE leg that expresses `gap`, at one lot, plus the lots wanted. `'flat'` SELLS in the neutral band; `'lean'` and `'counter'` both BUY at the long band. `null` when the band holds no tradable strike.
  - `function adjustTrigger(posture: Posture): Trigger` — `'dl-add'` for `'lean'` (the pyramid), `'dl-neutral'` for `'counter'` and `'flat'`.

- [ ] **Step 1: Append the failing posture tests**

Append to `packages/desk-engine/test/delta-lean-decide.test.ts`:

```ts
// ══════════════════════════════════════════════ 6. posture and adjustment

/**
 * D = `dl_open_lots` x (mid(long band) - mid(short band)) = 4 x (0.60 - 0.25)
 * = 1.4 delta-lots: THE HEDGED PAIR'S OWN NET DELTA, not the long leg's.
 *
 * That definition is what makes this engine coherent. The debit pair the open
 * puts on carries 4 x (0.556 - 0.297) = ~1.04 delta-lots on this board, and
 * `|1.4 - 1.04| = 0.36` is inside the 0.5 dead band — so A FRESHLY OPENED TREND
 * BOOK MEETS ITS OWN POSTURE EXACTLY and does nothing on its next tick. Defined
 * off the long band alone it would read as permanently short of itself, and
 * only the same-regime gate would stand between that and an instant pyramid.
 *
 * THE POSTURE IS RELATIVE TO `dlOpenSide`, in three modes, and the difference
 * between them is the operator's rule "neutralise, never reverse":
 *
 *   `lean`     the trend is the direction the book OPENED. One-sided at +-D:
 *              short of it, buy more of the open's own option (the pyramid).
 *              Past it, do nothing — a book that has run is never sold down.
 *   `counter`  the trend is AGAINST the open, or it is any trend on a strangle
 *              book. One-sided back TOWARDS ZERO: buy the regime's option only
 *              while the book leans against the regime. Never past zero, so a
 *              flip neutralises and the book never ends up short from a long
 *              open.
 *   `flat`     quiet or chop. Two-sided at zero: sell the same-side option in
 *              the ATM neutral band to bring the net back inside the band.
 */
const D_UNIT =
  4 *
  ((DIALS.dl_long_delta_lo + DIALS.dl_long_delta_hi) / 2 -
    (DIALS.dl_short_delta_lo + DIALS.dl_short_delta_hi) / 2)

/** The book's net delta in delta-lots, computed the way the engine computes it:
 * wing sign x side sign x |delta| x lots, each applied exactly once. */
function netOf(legs: readonly LegView[]): number {
  let net = 0
  for (const l of legs) {
    net += (l.optType === 'CE' ? 1 : -1) * (l.side === 'Buy' ? 1 : -1) * Math.abs(l.delta) * l.lots
  }
  return net
}

test('D is the hedged pair`s own net delta, so a fresh open meets its posture', () => {
  assert.ok(Math.abs(D_UNIT - 1.4) < 1e-9, `D must be 1.4, got ${D_UNIT}`)
  const legs = OPENED_UP()
  const net = netOf(legs)
  assert.ok(
    Math.abs(D_UNIT - net) <= DIALS.dl_dead_band_lots,
    `the opened pair (${net.toFixed(3)}) must be inside the band of D (${D_UNIT})`,
  )
  // And the engine agrees: the tick after the open does nothing at all.
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', { dlLastAdjustRegime: 'chop' }),   // every gate is open
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0, 'a met posture is not a blocked one')
})

test('LEAN: a trend in the open`s own direction buys more of the open`s option', () => {
  // §6.2 row 1: lots = max(1, round(gap / strikeDelta)).
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]              // ~0.556 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, opened('up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-add', 'the pyramid, and only the pyramid, is dl-add')
  assert.equal(d.actions.length, 1, 'ONE LEG — adds only, and one at a time')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'CE')
  assert.equal(a?.strike, 23_950, 'the long band, which is where a unit expresses direction')
  assert.equal(a?.lots, Math.max(1, Math.round((D_UNIT - netOf(legs)) / D_23950_CE)))
  assert.equal(exits(d.actions).length, 0, 'ADDS ONLY (D2)')
})

test('LEAN down is the same structure on the put ladder', () => {
  const legs = [legAt(24_050, 'PE', 'Buy', 1)]              // ~-0.556 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    DIALS, opened('down', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.trigger, 'dl-add')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'PE')
  assert.equal(a?.strike, 24_050)
  assert.equal(exits(d.actions).length, 0)
})

test('LEAN is ONE-SIDED — a book that has run past D is never sold down', () => {
  // 6 lots long is ~3.34 delta-lots against a D of 1.4. The v1 controller would
  // have diffed that back to target and SOLD the difference; this engine does
  // not own a rule that can sell a directional leg.
  const legs = [legAt(23_950, 'CE', 'Buy', 6)]
  assert.ok(netOf(legs) > D_UNIT + DIALS.dl_dead_band_lots, 'the fixture must be past D')
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, opened('up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.actions.length, 0)
})

test('COUNTER: a trend AGAINST the open buys the regime`s option back to ZERO', () => {
  /**
   * The book is long from an up open; the tape now says down. §6.2 row 2: buy
   * the PE at the long band, sized to close the gap to ZERO — not to -D. A flip
   * NEUTRALISES; it never reverses the book, so a long open can never end the
   * day short.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]              // ~+2.22 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-neutral', 'a correction, not a conviction')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'PE')
  assert.equal(a?.strike, 24_050)
  // Sized to ZERO: |net| / strikeDelta, never (|net| + D) / strikeDelta.
  assert.equal(a?.lots, Math.max(1, Math.round(netOf(legs) / D_24050_PE)))
  assert.equal(exits(d.actions).length, 0, 'the original leg is NEVER exited (D2)')
})

test('COUNTER never reverses: the neutralised book lands at zero, not on the other side', () => {
  // The arithmetic the test above pins, spelled out: fold the package in and the
  // net must be inside the band of ZERO, and must not have crossed past it by
  // more than the rounding of one strike.
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]
  const before = netOf(legs)
  const d = decideDeltaLean(
    inputsIn({ ring: trending(-1), legs }),
    DIALS, opened('up'), MARK,
  )
  const a = opens(d.actions)[0]
  assert.ok(a !== undefined)
  const after = netOf([...legs, legAt(a.strike, a.optType, a.side, a.lots)])
  assert.ok(Math.abs(after) < Math.abs(before), `${before} -> ${after} must move towards zero`)
  assert.ok(
    after > -(DIALS.dl_dead_band_lots + D_24050_PE),
    `${after} must not be a reversal — a long open never ends up short`,
  )
})

test('COUNTER does NOTHING when the book is already on the regime`s side', () => {
  // §6.2's own words: "a strangle book that has gone net long in a trend-up is
  // not asked to do anything, because it is already on the right side."
  const longBook = [legAt(23_950, 'CE', 'Buy', 2)]
  const rightSide = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: longBook }),
    DIALS, opened('none'), MARK,
  )
  assert.equal(rightSide.action, 'hold')
  assert.equal(rightSide.actions.length, 0)

  // And the mirror: a net-SHORT strangle book in a trend-up IS corrected.
  const shortBook = [legAt(24_050, 'PE', 'Buy', 2)]
  const wrongSide = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: shortBook }),
    DIALS, opened('none'), MARK,
  )
  assert.equal(wrongSide.trigger, 'dl-neutral')
  const a = opens(wrongSide.actions)[0]
  assert.equal(a?.side, 'Buy')
  assert.equal(a?.optType, 'CE')
  assert.equal(a?.lots, Math.max(1, Math.round(Math.abs(netOf(shortBook)) / D_23950_CE)))
})

test('FLAT: a quiet regime sells an ATM call to neutralise — it never closes the long', () => {
  // §6.2 row 3, and the operator's own rule: "when direction or regime is off,
  // neutralise by ADDING (buy the opposite option, or sell a same-side one)
  // rather than closing".
  const legs = [legAt(23_950, 'CE', 'Buy', 4)]              // ~+2.22 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    DIALS, opened('up'), MARK,
  )
  assert.equal(d.action, 'adjust')
  assert.equal(d.trigger, 'dl-neutral')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Sell')
  assert.equal(a?.optType, 'CE')
  assert.equal(a?.strike, 23_950, 'the 0.45-0.60 band — ATM, not ITM (D5)')
  assert.equal(a?.lots, Math.max(1, Math.round(netOf(legs) / D_23950_CE)))
  assert.equal(exits(d.actions).length, 0, 'nothing is closed, ever, here')
})

test('FLAT is TWO-SIDED — a net-short book in chop sells a PUT', () => {
  const legs = [legAt(24_050, 'PE', 'Buy', 4)]              // ~-2.22 delta-lots
  const d = decideDeltaLean(
    inputsIn({ ring: choppy(), legs }),
    DIALS, opened('down'), MARK,
  )
  assert.equal(d.trigger, 'dl-neutral')
  const a = opens(d.actions)[0]
  assert.equal(a?.side, 'Sell')
  assert.equal(a?.optType, 'PE')
  assert.equal(exits(d.actions).length, 0)
})

test('the trigger is the MODE, and nothing else', () => {
  // `dl-add` is more of the same bet; `dl-neutral` is damage control. An
  // operator reading a journal needs those two apart, and the mode is the only
  // thing that decides which is which.
  const cases: [string, SpotRing, LegView[], 'up' | 'down' | 'none', string][] = [
    ['lean', trending(1), [legAt(23_950, 'CE', 'Buy', 1)], 'up', 'dl-add'],
    ['counter, trend against the open', trending(-1), [legAt(23_950, 'CE', 'Buy', 4)], 'up', 'dl-neutral'],
    ['counter, any trend on a strangle', trending(1), [legAt(24_050, 'PE', 'Buy', 2)], 'none', 'dl-neutral'],
    ['flat', quietTape(), [legAt(23_950, 'CE', 'Buy', 4)], 'up', 'dl-neutral'],
  ]
  for (const [what, ring, legs, side, want] of cases) {
    const d = decideDeltaLean(
      inputsIn({ ring, legs }),
      DIALS, opened(side, { dlLastAdjustRegime: 'chop' }), MARK,
    )
    assert.equal(d.action, 'adjust', `${what} must act`)
    assert.equal(d.trigger, want, `${what} must be ${want}`)
  }
})


test('an adjustment stamps the cooldown, the count and the regime that justified it', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs: [legAt(23_950, 'CE', 'Buy', 1)] }),
    DIALS, opened('up', { dlAdjustsToday: 2, dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.stateAfter.dlAdjustsToday, 3)
  assert.equal(d.stateAfter.dlLastAdjustMs, NOW)
  assert.equal(d.stateAfter.dlLastAdjustRegime, 'trend-up')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0)
  assert.equal(d.stateAfter.dlOpenedMs, NOW - 3_600_000, 'the open instant is not rewritten')
  // A dropped package must not burn an adjustment.
  assert.equal(d.markState.dlAdjustsToday, 2)
  assert.equal(d.markState.dlLastAdjustMs, NOW - 3_600_000)
})

test('THE SAME REGIME NEVER JUSTIFIES TWO PACKAGES IN A ROW', () => {
  /**
   * THE CHURN GUARD. Without it a trend that merely PERSISTS tops the book up
   * every `dl_adjust_cooldown_s` all afternoon, which is the 15-second trend
   * pyramid of 2026-09-22 with a slower clock. With it the tape has to change
   * its mind and come back before the book adds again.
   *
   * It is no longer the thing standing between a fresh open and an instant
   * pyramid — the amended §6.2's `D` is the hedged pair's own net delta, so a
   * fresh open meets its posture and wants nothing. This gate bounds the
   * FREQUENCY of genuine top-ups, which is a smaller job and still a real one.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const again = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, opened('up', { dlLastAdjustRegime: 'trend-up' }), MARK,
  )
  assert.equal(again.action, 'hold')
  assert.ok(again.reason.includes('already'), `the ledger must say why: ${again.reason}`)
  assert.equal(again.stateAfter.dlBlockedSinceMs, 0, 'and it is NOT a stuck condition')

  const changed = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, opened('up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(changed.action, 'adjust')
})

test('the cooldown holds an adjustment the posture wants', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const hot = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', { dlLastAdjustMs: NOW - 599_000, dlLastAdjustRegime: 'chop' }),
    MARK,
  )
  assert.equal(hot.action, 'hold')
  assert.ok(hot.reason.includes('cooldown'), `the ledger must say why: ${hot.reason}`)
  assert.equal(hot.stateAfter.dlBlockedSinceMs, 0, 'a cooldown is not a stuck condition')

  const cooled = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', { dlLastAdjustMs: NOW - 600_000, dlLastAdjustRegime: 'chop' }),
    MARK,
  )
  assert.equal(cooled.action, 'adjust', 'the boundary is inclusive')
})

test('the confirm window holds an adjustment too', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', {
      dlRegime: 'trend-up',
      dlRegimeSinceMs: NOW - 30_000,
      dlLastAdjustRegime: 'chop',
    }),
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.ok(d.reason.includes('confirm'), `the ledger must say why: ${d.reason}`)
})

test('an unknown regime adjusts nothing and clears the stuck clock', () => {
  const d = decideDeltaLean(
    inputsIn({ ring: DEAD_FEED, legs: OPENED_UP() }),
    DIALS, opened('up', { dlBlockedSinceMs: NOW - 400_000 }), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, 0, 'no reading, no block')
})

test('an unpriced leg holds the pass — the book delta is not measurable', () => {
  // `types.ts`: absent is never zero. A leg whose IV would not solve is a leg
  // whose quote the book could not read, and sizing an order against a partial
  // sum would trade against a position the engine cannot see.
  const legs = [legAt(23_950, 'CE', 'Buy', 4), legAt(24_200, 'CE', 'Sell', 4, { hasGreeks: false })]
  const d = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, opened('up', { dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.ok(d.reason.includes('measurable'), `the ledger must say why: ${d.reason}`)
})

test('`dl_max_adjusts_day` is a hard ceiling on packages after the open', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 1)]
  const spent = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, opened('up', { dlAdjustsToday: 6, dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(spent.action, 'hold')
  assert.equal(opens(spent.actions).length, 0)

  const room = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS, opened('up', { dlAdjustsToday: 5, dlLastAdjustRegime: 'chop' }), MARK,
  )
  assert.equal(room.action, 'adjust')
})
```

Also delete the `test.skip` marker from Task 5's `a BUY-only package always fits` test.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: FAIL — every section-6 test reports `action: 'hold'` with reason `"… opened up, holding"`.

- [ ] **Step 3: Add the posture block to `decide.ts`**

Add `import { strikeGreeks } from '../marking.ts';` and `import { deltaBandStrike } from './express.ts';` (merge with the existing `express.ts` import). Insert this block after `confirmed` and before `// ── the pass ──`:

```ts
// ── the posture (§6.2) ──────────────────────────────────────────────────────

/**
 * The book's NET DELTA, in delta-lots, and whether it can be believed.
 *
 * `priced` false is the `hasGreeks` contract carried up a level: a book with
 * one unsolved leg has no measurable delta, and the caller HOLDS rather than
 * sizing an order against a sum that is missing a term. It is NOT a zero
 * (`types.ts`: absent is never zero) — a zero would read as a flat book, which
 * is the one reading that makes the engine act.
 */
function netDeltaLots(legs: readonly LegView[]): { readonly lots: number; readonly priced: boolean } {
  let lots = 0;
  let priced = true;
  for (const leg of legs) {
    if (!leg.hasGreeks) {
      priced = false;
      continue;
    }
    lots += legDeltaLots(leg);
  }
  return { lots, priced };
}

/**
 * `D` — THE HEDGED PAIR'S OWN NET DELTA, in delta-lots (§6.2).
 *
 * `dl_open_lots` x (mid(long band) - mid(short band)) = 4 x (0.60 - 0.25) =
 * 1.4. BOTH bands, because the unit the book actually opens is a PAIR and its
 * short leg carries delta too: a 4-lot 0.556/0.297 pair is ~1.04 delta-lots,
 * not ~2.2. So a freshly opened trend book MEETS ITS OWN POSTURE, which is the
 * whole point of defining D this way. Taken off the long band alone it would
 * read as permanently short of itself, and every tick after the open would want
 * a pyramid it had no business wanting.
 */
function unitDelta(dials: Dials): number {
  const long = (dials.dl_long_delta_lo + dials.dl_long_delta_hi) / 2;
  const short = (dials.dl_short_delta_lo + dials.dl_short_delta_hi) / 2;
  return dials.dl_open_lots * (long - short);
}

/**
 * WHERE THE REGIME WANTS THE BOOK'S DELTA — relative to the side it OPENED.
 *
 * Three modes, and the difference between them is the operator's rule
 * "neutralise by adding, never reverse":
 *
 *   `lean`     The trend is the direction the book opened. Target +-D,
 *              ONE-SIDED: short of it, buy more of the open's own option — the
 *              pyramid. Past it, nothing, because a book that has run is never
 *              sold down and this engine owns no rule that could sell it.
 *   `counter`  The trend is AGAINST the open, or it is any trend on a strangle
 *              book (`'none'`). Target ZERO, ONE-SIDED TOWARDS IT: buy the
 *              REGIME's option only while the book leans against the regime.
 *              Never past zero — a flip NEUTRALISES, so a long open can never
 *              end the day short. A book already on the regime's side is asked
 *              for nothing at all.
 *   `flat`     Quiet or chop. Target zero, TWO-SIDED: sell the same-side option
 *              in the ATM neutral band to bring the net back inside the band.
 *
 * `direction` is the only sign of gap the posture will act on, and it is what
 * carries the one-sidedness: `+1` will only ever add LONG delta, `-1` only
 * short, `0` (the `'flat'` case alone) either.
 *
 * `null` for `'unknown'`: no reading, no posture, and nothing is done.
 */
type PostureMode = 'lean' | 'counter' | 'flat';

interface Posture {
  readonly mode: PostureMode;
  readonly target: number;
  readonly direction: 1 | -1 | 0;
}

function wantedPosture(
  regime: Regime,
  openSide: RuleState['dlOpenSide'],
  dials: Dials,
): Posture | null {
  if (regime === 'quiet' || regime === 'chop') {
    return { mode: 'flat', target: 0, direction: 0 };
  }
  if (regime === 'trend-up') {
    return openSide === 'up'
      ? { mode: 'lean', target: unitDelta(dials), direction: 1 }
      : { mode: 'counter', target: 0, direction: 1 };
  }
  if (regime === 'trend-down') {
    return openSide === 'down'
      ? { mode: 'lean', target: -unitDelta(dials), direction: -1 }
      : { mode: 'counter', target: 0, direction: -1 };
  }
  return null;
}

/**
 * How many delta-lots the book is SHORT OF ITS POSTURE, signed — or 0 when the
 * posture is met.
 *
 * `+` means the book needs MORE long delta, `-` more short. A posture with a
 * `direction` reports a gap of THAT SIGN ONLY, which is what makes "adds only"
 * and "never reverse" the same line of code: a `lean` book past its target
 * reports 0 rather than a sale, and a `counter` book already on the regime's
 * side reports 0 rather than a reversal.
 */
function postureGap(posture: Posture, net: number, band: number): number {
  const gap = posture.target - net;
  if (Math.abs(gap) <= band + EPS) return 0;
  if (posture.direction === 0) return gap;
  return Math.sign(gap) === posture.direction ? gap : 0;
}

/**
 * THE ONE LEG THAT EXPRESSES A GAP — at one lot, with the lots wanted beside it
 * so the caller can shrink it against the cap without rebuilding it.
 *
 * Four rows, and every one of them is an ADD (§6.2):
 *
 *   `lean`/`counter`, gap > 0    BUY a CE at the long band
 *   `lean`/`counter`, gap < 0    BUY a PE at the long band
 *   `flat`, gap < 0 (net long)   SELL a CE in the neutral band
 *   `flat`, gap > 0 (net short)  SELL a PE in the neutral band
 *
 * The two `flat` rows are the only adjustment that ADDS MARGIN; the buy is a
 * debit and always fits (§6.3), which is what makes the counter-trend
 * neutralisation unconditional. The sideways sale is picked in
 * `dl_neutral_short_delta`, the ATM band: the operator asked for an ITM sale,
 * and ATM carries the same net-delta effect with more time value and a better
 * book (D5) — with the band as the dial, so it can be pushed in.
 *
 * The BUY's option type falls out of the GAP'S SIGN, and on both buying modes
 * that sign agrees with the regime by construction: a `lean` gap points the way
 * the book opened, which is the way the trend is going, and a `counter` gap
 * points from the book's own delta back towards zero, which is also the way the
 * trend is going. So §6.2's "buy the open's option" and "buy the regime's
 * option" are the same instruction, and there is one branch rather than two.
 *
 * `null` when the band holds no tradable strike. "Nearest miss" is how a book
 * ends up 40% off its posture while every individual decision looks defensible.
 */
function adjustmentPackage(
  inputs: DeltaLeanInputs,
  dials: Dials,
  gap: number,
  mode: PostureMode,
): { readonly unit: readonly EngineAction[]; readonly lots: number } | null {
  const { chain, dateIst, minuteOfDay } = inputs;
  const selling = mode === 'flat';
  const optType: OptType = selling ? (gap < 0 ? 'CE' : 'PE') : gap > 0 ? 'CE' : 'PE';
  const side: Side = selling ? 'Sell' : 'Buy';
  const [lo, hi] = selling
    ? [dials.dl_neutral_short_delta_lo, dials.dl_neutral_short_delta_hi]
    : [dials.dl_long_delta_lo, dials.dl_long_delta_hi];

  const strike = deltaBandStrike(chain, optType, lo, hi, dateIst, minuteOfDay, dials);
  if (strike === null) return null;

  const g = strikeGreeks(chain, strike, optType, dateIst, minuteOfDay);
  if (g === null) return null;
  // What ONE LOT of this leg does to the book's net delta, both signs applied
  // once — `strikeGreeks` signs by wing, this applies the side.
  const perLot = sideSign(side) * g.delta;
  if (!Number.isFinite(perLot) || Math.abs(perLot) < EPS) return null;
  // The gap and the leg must point the same way, or the leg is the wrong one.
  if (Math.sign(perLot) !== Math.sign(gap)) return null;

  // `max(1, round(...))` — §6.2's own formula. A round alone can be 0 on a gap
  // barely past the dead band, and an adjustment worth deciding is worth a lot.
  // ROUNDING rather than flooring is what lets a `counter` package land ON zero
  // rather than stopping short of it; it can overshoot by at most half a
  // strike's delta, which is inside the dead band and is not a reversal.
  const lots = Math.max(1, Math.round(Math.abs(gap) / Math.abs(perLot)));
  return {
    unit: [{ op: 'open', strike, optType, side, lots: 1 }],
    lots,
  };
}

/**
 * `dl-add` or `dl-neutral` — the ledger's word for what a package IS.
 *
 * A PYRAMID is exactly the `lean` mode: the trend is the direction the book
 * opened, and this is more of the same bet. `counter` and `flat` are both
 * CORRECTIONS — a flip neutralised to zero, a threatened strangle, a sideways
 * sale — and an operator reading a journal needs those two apart: one is
 * conviction, the other is damage control.
 *
 * Read off the MODE and nothing else, so the trigger and the rule that produced
 * the package can never disagree about which one happened.
 */
function adjustTrigger(posture: Posture): Trigger {
  return posture.mode === 'lean' ? 'dl-add' : 'dl-neutral';
}
```

- [ ] **Step 4: Wire step 7 into `decideDeltaLean`**

Replace the closing `// ── 7 …` comment and `return hold(\`${read.slow}: opened ${st.dlOpenSide}, holding\`, st);` with:

```ts
  // ── 7. the posture and the adjustment (§6.2) ─────────────────────────────
  const net = netDeltaLots(legs);
  if (!net.priced) {
    return hold('a leg has no solvable IV — the book delta is not measurable', st);
  }
  const posture = wantedPosture(read.slow, st.dlOpenSide, dials);
  if (posture === null) {
    // No reading, no posture — and no block either, so the stuck clock resets.
    return hold('the detector has no reading — holding what the book holds', {
      ...st,
      dlBlockedSinceMs: 0,
    });
  }
  const gap = postureGap(posture, net.lots, dials.dl_dead_band_lots);
  if (gap === 0) {
    // Either the posture is MET, or the book is already PAST it on a one-sided
    // posture — a `lean` book that has run, a `counter` book already on the
    // regime's side. Both are "nothing to add", and neither is a sale.
    return hold(
      `${read.slow}/${posture.mode}: the book is at ${net.lots.toFixed(2)} delta-lots against a wanted ${posture.target.toFixed(2)} — nothing to add`,
      { ...st, dlBlockedSinceMs: 0 },
    );
  }

  // An adjustment is WANTED. The gates, in the order their consequences differ:
  // the day limit first (it is terminal, and a book that can never adjust again
  // is a candidate for the stuck exit), then the three that are merely a wait.
  const shortfall = `${read.slow}/${posture.mode}: ${net.lots.toFixed(2)} delta-lots against a wanted ${posture.target.toFixed(2)}`;
  if (st.dlAdjustsToday >= dials.dl_max_adjusts_day) {
    return hold(`${shortfall} — all ${dials.dl_max_adjusts_day} adjustments are spent`, st);
  }
  if (read.slow === st.dlLastAdjustRegime) {
    // THE CHURN GUARD. A trend that merely persists must not top the book up
    // every cooldown; the tape has to change its mind and come back. Not a
    // stuck condition — the book is not blocked, it has already acted on this
    // reading, and the next change of tape frees it.
    return hold(`${shortfall} — ${read.slow} already justified the last package`, {
      ...st,
      dlBlockedSinceMs: 0,
    });
  }
  if (!confirmed(st, dials, nowMs)) {
    const heldS = ((nowMs - st.dlRegimeSinceMs) / 1000).toFixed(0);
    return hold(`${shortfall} — ${read.slow} for ${heldS}s, inside the ${dials.dl_adjust_confirm_s}s confirm window`, {
      ...st,
      dlBlockedSinceMs: 0,
    });
  }
  const sinceAdjust = st.dlLastAdjustMs === 0 ? Number.POSITIVE_INFINITY : nowMs - st.dlLastAdjustMs;
  if (sinceAdjust < dials.dl_adjust_cooldown_s * 1000) {
    const leftS = ((dials.dl_adjust_cooldown_s * 1000 - sinceAdjust) / 1000).toFixed(0);
    return hold(`${shortfall} — ${leftS}s left of the ${dials.dl_adjust_cooldown_s}s cooldown`, {
      ...st,
      dlBlockedSinceMs: 0,
    });
  }

  const pkg = adjustmentPackage(inputs, dials, gap, posture.mode);
  if (pkg === null) {
    return hold(`${shortfall} — no tradable strike in the band`, { ...st, dlBlockedSinceMs: 0 });
  }
  const actions = scaleLots(pkg.unit, pkg.lots);
  const paced = pace(actions, inputs, dials);
  if (paced.length < actions.length) {
    return hold(`${shortfall} [order budget]`, st);
  }
  const trigger = adjustTrigger(posture);
  const after: RuleState = {
    ...st,
    dlAdjustsToday: st.dlAdjustsToday + 1,
    dlLastAdjustMs: nowMs,
    dlLastAdjustRegime: read.slow,
    dlBlockedSinceMs: 0,
  };
  return acted(
    'adjust',
    trigger,
    `${shortfall} — ${trigger === 'dl-add' ? 'pyramiding' : 'neutralising'} by adding ${pkg.lots} lot(s)`,
    paced,
    after,
    // A dropped package must not burn an adjustment or start a cooldown.
    st,
    'passive',
  );
```

- [ ] **Step 5: Run the decide tests**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: PASS for sections 1-6.

- [ ] **Step 6: Commit**

```bash
git add packages/desk-engine/src/delta-lean/decide.ts packages/desk-engine/test/delta-lean-decide.test.ts
git commit -m "feat(delta-lean): posture, the adds that express it, and the four gates"
```

---

### Task 7: `decide.ts` part D — the margin gate on adjustments, and the stuck exit (spec §6.3, §6.4)

**Files:**
- Modify: `packages/desk-engine/src/delta-lean/decide.ts` — add `stuckExit`; wrap the adjustment's lots in `fitLots`
- Modify: `packages/desk-engine/test/delta-lean-decide.test.ts` — append section 7

**Interfaces:**
- Consumes: Task 5's `fitLots(inputs, dials, unit, maxLots)`, `projectFits(inputs, dials, opens)`, `scaleLots(actions, lots)`; Task 6's `adjustmentPackage(inputs, dials, gap, mode: PostureMode)` returning `{ unit, lots }`, `wantedPosture(regime, openSide, dials)`, `postureGap(posture, net, band)`, `netDeltaLots(legs)`, `adjustTrigger(posture)`, and the `Posture { mode, target, direction }` shape; Task 4's `exitDecision(inputs, trigger, reason, urgency, st, latchWhenFlat)`, `totalPnl`, `inr`.
- Produces:
  - `function stuckExit(inputs: DeltaLeanInputs, dials: Dials, st: RuleState, why: string): EngineDecision` — the §6.4 clock and, past it, the `dl-target`-shaped ladder exit under trigger `'dl-stuck'`. Returns a hold with the clock armed or reset when it is not yet due.
  - The adjustment branch of `decideDeltaLean` now truncates against the cap and routes blocked-by-cap and blocked-by-limit through `stuckExit`.

- [ ] **Step 1: Append the failing margin-gate and stuck tests**

Append to `packages/desk-engine/test/delta-lean-decide.test.ts`:

```ts
// ══════════════════════════════════ 7. the margin gate and the stuck exit

test('a sideways sale is TRUNCATED to the lots that fit — never rounded up', () => {
  /**
   * §6.3: "shrink the package's lots down to the largest that fits
   * (truncation, never rounding up)". The `flat` mode's sideways sell is the
   * ONLY adjustment that adds margin, so it is the only one this can bite on —
   * `lean` and `counter` both BUY, and a long option never raises SPAN-lite.
   *
   * A quiet tape on a book that is 4.4 delta-lots long: `flat`, two-sided,
   * gap -4.4, so it wants to sell ~8 lots of the ATM call.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 8)]      // ~4.4 delta-lots long
  const st = opened('up')
  const full = decideDeltaLean(inputsIn({ ring: quietTape(), legs }), DIALS, st, MARK)
  assert.equal(full.trigger, 'dl-neutral')
  const wanted = opens(full.actions)[0]?.lots ?? 0
  assert.ok(wanted >= 3, `the fixture must want at least three lots, wanted ${wanted}`)

  // A cap that fits exactly two of them.
  const bookSpan = spanLiteMargin(
    legs.map((l) => ({
      strike: l.strike, optType: l.optType, side: l.side, lots: l.lots,
      lotSize: LOT, iv: l.iv, expiry: EXPIRY,
    })),
    SPOT, DATE,
  ).total
  const capFor = (n: number): number =>
    spanLiteMargin(
      [
        ...legs.map((l) => ({
          strike: l.strike, optType: l.optType, side: l.side, lots: l.lots,
          lotSize: LOT, iv: l.iv, expiry: EXPIRY,
        })),
        { strike: 23_950, optType: 'CE' as OptType, side: 'Sell' as Side, lots: n, lotSize: LOT, iv: null, expiry: EXPIRY },
      ],
      SPOT, DATE,
    ).total
  assert.ok(capFor(2) < capFor(3), 'the fixture must price three lots dearer than two')
  assert.ok(bookSpan <= capFor(2), 'and the held book must fit under both')

  const squeezed = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: capFor(2) }),
    st, MARK,
  )
  assert.equal(squeezed.trigger, 'dl-neutral')
  assert.equal(opens(squeezed.actions)[0]?.lots, 2, 'truncated DOWN to what fits')
})

test('a cap that fits nothing BLOCKS the adjustment and arms the stuck clock', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 8)]
  const losing = legs.map((l) => ({ ...l, mtm: -26_000 }))
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: losing }),
    dialsOf({ margin_cap: 1 }),
    opened('up'), MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, NOW, 'the clock STARTS on the first blocked tick')
  assert.ok(d.reason.includes('cap'), `the ledger must name the cap: ${d.reason}`)
})

test('the stuck exit needs BOTH the block and the loss, and either clearing resets the clock', () => {
  /**
   * §6.4: "Any tick where either condition clears resets the clock." The clock
   * measures ONE CONTINUOUS STRETCH of cap-blocked-and-losing, not a total —
   * otherwise a book that is blocked all morning and losing all afternoon exits
   * on two conditions that never once held together.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 8)]
  const armed = opened('up', { dlBlockedSinceMs: NOW - 200_000 })

  // Blocked, but only just losing: under `dl_stuck_loss` the clock resets.
  const shallow = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: legs.map((l) => ({ ...l, mtm: -24_999 })) }),
    dialsOf({ margin_cap: 1 }),
    armed, MARK,
  )
  assert.equal(shallow.stateAfter.dlBlockedSinceMs, 0, 'not losing enough — clock reset')

  // Losing, but NOT blocked: the adjustment goes out instead.
  const free = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: legs.map((l) => ({ ...l, mtm: -26_000 })) }),
    DIALS, armed, MARK,
  )
  assert.equal(free.action, 'adjust', 'a move that still helps is made, not abandoned')
  assert.equal(free.stateAfter.dlBlockedSinceMs, 0)
})

test('blocked AND losing for `dl_stuck_confirm_s` exits on a ladder and latches', () => {
  // "Cap reached, no move can still make money, minimise the downside."
  const legs = [legAt(23_950, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    opened('up', { dlBlockedSinceMs: NOW - 300_000 }),
    MARK,
  )
  assert.equal(d.action, 'flatten')
  assert.equal(d.trigger, 'dl-stuck')
  assert.equal(d.urgency, 'ladder')
  assert.equal(exits(d.actions).length, 1)
  assert.equal(opens(d.actions).length, 0)
})

test('one second short of the stuck window is a hold with the clock still running', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const since = NOW - 299_000
  const d = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    opened('up', { dlBlockedSinceMs: since }),
    MARK,
  )
  assert.equal(d.action, 'hold')
  assert.equal(d.stateAfter.dlBlockedSinceMs, since, 'the clock is NOT restamped while it runs')
})

test('the ADJUST LIMIT also arms the stuck clock — a book that can never move again', () => {
  // §6.4's other arm: blocked by `dl_max_adjusts_day` rather than by the cap.
  // The book is not out of margin, it is out of permission, and the outcome for
  // the position is the same.
  //
  // A `lean` posture wants this one: one lot long (0.56 delta-lots) against a D
  // of 1.4, so the gap is 0.84 — past the 0.5 band, and a real pyramid the book
  // is not allowed to place.
  const legs = [legAt(23_950, 'CE', 'Buy', 1)].map((l) => ({ ...l, mtm: -26_000 }))
  const armed = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', { dlAdjustsToday: 6, dlLastAdjustRegime: 'chop' }),
    MARK,
  )
  assert.equal(armed.action, 'hold')
  assert.equal(armed.stateAfter.dlBlockedSinceMs, NOW)

  const out = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', {
      dlAdjustsToday: 6,
      dlLastAdjustRegime: 'chop',
      dlBlockedSinceMs: NOW - 300_000,
    }),
    MARK,
  )
  assert.equal(out.trigger, 'dl-stuck')
})

test('a cooldown or a same-regime hold NEVER arms the stuck clock', () => {
  /**
   * §6.4 arms on the cap and on the adjust limit ONLY. A cooldown clears by
   * itself in ten minutes and a same-regime hold clears the moment the tape
   * changes; exiting a losing book because it is inside a cooldown would turn
   * the engine's own patience into a stop.
   */
  const legs = [legAt(23_950, 'CE', 'Buy', 1)].map((l) => ({ ...l, mtm: -50_000 }))
  const cooling = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', { dlLastAdjustMs: NOW - 1_000, dlLastAdjustRegime: 'chop', dlBlockedSinceMs: NOW - 400_000 }),
    MARK,
  )
  assert.equal(cooling.action, 'hold')
  assert.equal(cooling.stateAfter.dlBlockedSinceMs, 0)

  const repeated = decideDeltaLean(
    inputsIn({ ring: trending(1), legs }),
    DIALS,
    opened('up', { dlLastAdjustRegime: 'trend-up', dlBlockedSinceMs: NOW - 400_000 }),
    MARK,
  )
  assert.equal(repeated.action, 'hold')
  assert.equal(repeated.stateAfter.dlBlockedSinceMs, 0)
})

test('the conservative book gets stuck ten thousand rupees sooner', () => {
  const legs = [legAt(23_950, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -16_000 }))
  const d = dialsOf({ margin_cap: 1, dl_stuck_loss: 15_000, dl_open_lots: 2 })
  const out = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    d,
    opened('up', { dlBlockedSinceMs: NOW - 300_000 }),
    MARK,
  )
  assert.equal(out.trigger, 'dl-stuck')

  const aggressive = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }),
    opened('up', { dlBlockedSinceMs: NOW - 300_000 }),
    MARK,
  )
  assert.equal(aggressive.action, 'hold', 'the same loss is not yet stuck at 25,000')
})

test('the stuck exit latches once flat, like the target — never before', () => {
  const st = opened('up', { dlBlockedSinceMs: NOW - 300_000 })
  const legs = [legAt(23_950, 'CE', 'Buy', 8)].map((l) => ({ ...l, mtm: -26_000 }))
  const flattening = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs }),
    dialsOf({ margin_cap: 1 }), st, MARK,
  )
  assert.equal(flattening.stateAfter.dlStopped, false, 'the package has not filled yet')

  const done = decideDeltaLean(
    inputsIn({ ring: quietTape(), legs: [], cumRealized: -26_000 }),
    dialsOf({ margin_cap: 1 }), st, MARK,
  )
  // A flat book with a 26,000 loss and no legs: the posture is met at 0 in a
  // quiet regime, so the stuck rule is not even asked — the book simply holds.
  assert.equal(done.action, 'hold')
  assert.equal(exits(done.actions).length, 0)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: FAIL — the truncation test gets the full un-shrunk lots, and every stuck test gets a plain hold with `dlBlockedSinceMs: 0`.

- [ ] **Step 3: Add `stuckExit` to `decide.ts`**

Insert after `adjustTrigger` and before `// ── the pass ──`:

```ts
// ── the stuck exit (§6.4) ───────────────────────────────────────────────────

/**
 * "CAP REACHED, NO MOVE CAN STILL MAKE MONEY, MINIMISE THE DOWNSIDE."
 *
 * Two conditions, both required, and BOTH must hold CONTINUOUSLY for
 * `dl_stuck_confirm_s`:
 *
 *   1. an adjustment is WANTED but blocked — by the SPAN cap, or by
 *      `dl_max_adjusts_day`, and by nothing else;
 *   2. `totalPnl <= -dl_stuck_loss`.
 *
 * `dlBlockedSinceMs` is the clock and ANY tick where either condition clears
 * resets it to 0, so the window measures one continuous stretch rather than a
 * total. Measured as a total, a book that was blocked all morning and losing
 * all afternoon would exit on two conditions that never once held together.
 *
 * WHY A COOLDOWN AND A SAME-REGIME HOLD DO NOT ARM IT: both clear by
 * themselves — the first in ten minutes, the second the moment the tape changes
 * its mind — so the book is not stuck, it is waiting. Arming on those would
 * turn the engine's own patience into a stop, which is the exact failure mode
 * this whole design exists to remove.
 *
 * The exit is a LADDER, like the target: it must be out, and it is not an
 * emergency. It latches once flat.
 */
function stuckExit(
  inputs: DeltaLeanInputs,
  dials: Dials,
  st: RuleState,
  why: string,
): EngineDecision {
  const { nowMs } = inputs;
  const pnl = totalPnl(inputs);
  if (pnl > -dials.dl_stuck_loss) {
    return hold(
      `${why} — but ${inr(pnl)} is inside the ${inr(-dials.dl_stuck_loss)} stuck floor, so the clock is not running`,
      { ...st, dlBlockedSinceMs: 0 },
    );
  }
  // 0 is "not yet started", so the first blocked-and-losing tick stamps NOW and
  // every tick after it leaves the stamp alone.
  const since = st.dlBlockedSinceMs === 0 ? nowMs : st.dlBlockedSinceMs;
  const armed: RuleState = { ...st, dlBlockedSinceMs: since };
  const heldMs = nowMs - since;
  if (heldMs < dials.dl_stuck_confirm_s * 1000) {
    const leftS = ((dials.dl_stuck_confirm_s * 1000 - heldMs) / 1000).toFixed(0);
    return hold(
      `${why} at ${inr(pnl)} — ${leftS}s left of the ${dials.dl_stuck_confirm_s}s stuck window`,
      armed,
    );
  }
  return exitDecision(
    inputs,
    'dl-stuck',
    `stuck: ${why} at ${inr(pnl)} for ${dials.dl_stuck_confirm_s}s — no move can still help, minimising the downside`,
    'ladder',
    armed,
    true,
  );
}
```

- [ ] **Step 4: Route the two blocking gates through it**

In `decideDeltaLean`'s step 7, replace the `dl_max_adjusts_day` branch:

```ts
  if (st.dlAdjustsToday >= dials.dl_max_adjusts_day) {
    return hold(`${shortfall} — all ${dials.dl_max_adjusts_day} adjustments are spent`, st);
  }
```

with:

```ts
  if (st.dlAdjustsToday >= dials.dl_max_adjusts_day) {
    // BLOCKED, not waiting: this cannot clear before tomorrow's roll, so it is
    // one of the two conditions the stuck exit arms on.
    return stuckExit(
      inputs, dials, st,
      `${shortfall} — all ${dials.dl_max_adjusts_day} adjustments are spent`,
    );
  }
```

and replace the package-building tail (from `const pkg = adjustmentPackage(...)` down to the closing `return acted(...)`) with:

```ts
  const pkg = adjustmentPackage(inputs, dials, gap, posture.mode);
  if (pkg === null) {
    return hold(`${shortfall} — no tradable strike in the band`, { ...st, dlBlockedSinceMs: 0 });
  }

  // ── §6.3, the margin gate ────────────────────────────────────────────────
  // TRUNCATE to the largest size that fits, never round up. A BUY always
  // survives this (a long option never raises SPAN-lite), which is what makes
  // the `counter` neutralising buy of §6.2 unconditional; only the `flat`
  // sideways SALE can shrink or be refused outright.
  const lots = fitLots(inputs, dials, pkg.unit, pkg.lots);
  if (lots === 0) {
    return stuckExit(
      inputs, dials, st,
      `${shortfall} — not one lot fits under the ${inr(dials.margin_cap)} SPAN cap`,
    );
  }

  const actions = scaleLots(pkg.unit, lots);
  const paced = pace(actions, inputs, dials);
  if (paced.length < actions.length) {
    return hold(`${shortfall} [order budget]`, st);
  }
  const trigger = adjustTrigger(posture);
  const shrunk = lots < pkg.lots ? ` (cut from ${pkg.lots} by the SPAN cap)` : '';
  const after: RuleState = {
    ...st,
    dlAdjustsToday: st.dlAdjustsToday + 1,
    dlLastAdjustMs: nowMs,
    dlLastAdjustRegime: read.slow,
    dlBlockedSinceMs: 0,
  };
  return acted(
    'adjust',
    trigger,
    `${shortfall} — ${trigger === 'dl-add' ? 'pyramiding' : 'neutralising'} by adding ${lots} lot(s)${shrunk}`,
    paced,
    after,
    // A dropped package must not burn an adjustment or start a cooldown.
    st,
    'passive',
  );
```

- [ ] **Step 5: Run the decide tests**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: PASS for sections 1-7.

- [ ] **Step 6: Commit**

```bash
git add packages/desk-engine/src/delta-lean/decide.ts packages/desk-engine/test/delta-lean-decide.test.ts
git commit -m "feat(delta-lean): the SPAN gate truncates, and the stuck exit gets its clock"
```

---

### Task 8: The scripted-day property test

**Files:**
- Modify: `packages/desk-engine/test/delta-lean-decide.test.ts` — append section 8

**Interfaces:**
- Consumes: everything Tasks 4-7 produced, through `decideDeltaLean` alone — the helper it needs from the fixture is `netOf(legs)` (Task 6, section 6's header). This task adds NO production code: if it fails, the bug is in Tasks 4-7 and is fixed there.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the property test**

Append to `packages/desk-engine/test/delta-lean-decide.test.ts`:

```ts
// ═══════════════════════════════════════════════ 8. a whole scripted day

/**
 * THE ONE PROPERTY THE WHOLE DESIGN REDUCES TO.
 *
 * Every test above pins one rule. This one drives a WHOLE SYNTHETIC SESSION —
 * 09:30 to 15:01, a decision every minute, through six regime changes — and
 * asserts the two things the operator actually asked for:
 *
 *   1. NOTHING CLOSES A LEG before the flatten window except `dl-target`,
 *      `dl-stuck` or `dl-stop`. This is D2, and it is the property that the
 *      2026-09-22 book violated 240 times.
 *   2. THE ORDER COUNT IS BOUNDED. At most one open package (2 or 4 legs) plus
 *      `dl_max_adjusts_day` one-leg adjustments — spec §8's "10 opens + 10
 *      closes ≈ 20 orders per book per day".
 *   3. THE BOOK NEVER REVERSES. Amended §6.2: a `counter` adjustment
 *      neutralises to ZERO and never past it, so a book that opened `'up'` can
 *      never end up meaningfully net short, whatever the tape does to it. The
 *      bound is the dead band plus one long-band strike's delta, because a
 *      `counter` package rounds to the nearest lot and may overshoot by half of
 *      one. A test that asserted a hard zero would fail on arithmetic rather
 *      than on a rule.
 *
 * The book is carried forward tick to tick exactly as the host carries it: the
 * decision's `stateAfter` becomes the next tick's state, and a routed open is
 * folded into the leg list, so the posture the engine reads is the posture its
 * own packages built. A test that reset the legs each tick would let the engine
 * re-open forever and prove nothing.
 */

/** A leg list with `action`'s opens folded in — the paper rail's fold, in four
 * lines. An open on a strike the book already holds on the same side grows that
 * leg rather than adding a second row, which is what `book.ts` does. */
function fold(legs: readonly LegView[], actions: readonly EngineAction[]): LegView[] {
  let out = [...legs]
  for (const a of actions) {
    if (a.op === 'close') {
      out = out.filter((l) => l.instrument !== a.instrument)
      continue
    }
    if (a.op === 'resize') {
      out = out.map((l) => (l.instrument === a.instrument ? { ...l, lots: a.targetLots } : l))
      continue
    }
    const at = out.findIndex(
      (l) => l.strike === a.strike && l.optType === a.optType && l.side === a.side,
    )
    if (at >= 0) {
      const held = out[at]
      assert.ok(held !== undefined)
      out[at] = { ...held, lots: held.lots + a.lots }
      continue
    }
    out.push(legAt(a.strike, a.optType, a.side, a.lots))
  }
  return out
}

/** The tape, minute by minute: quiet to 10:30, up to 11:30, chop to 12:15, down
 * to 13:15, quiet to 14:15, up to the close. Six regime changes, which is more
 * than any real session hands a book. */
function tapeFor(minute: number, endMs: number): SpotRing {
  if (minute < 630) return quietTape(endMs)
  if (minute < 690) return trending(1, endMs)
  if (minute < 735) return choppy(endMs)
  if (minute < 795) return trending(-1, endMs)
  if (minute < 855) return quietTape(endMs)
  return trending(1, endMs)
}

test('over a whole scripted day nothing closes early and the order count stays bounded', () => {
  let st: RuleState = { ...EMPTY_RULE_STATE }
  let legs: LegView[] = []
  let orders = 0
  let openLegs = 0
  let adjustments = 0
  const closesBefore: { minute: number; trigger: string }[] = []
  const triggers: string[] = []
  /** The most net-SHORT the book ever got. It opened long or flat, so under the
   * amended §6.2 this can never pass -(band + one strike's delta). */
  let mostShort = 0

  for (let minute = 555; minute <= 901; minute += 1) {
    const nowMs = NOW + (minute - MINUTE) * 60_000
    const d = decideDeltaLean(
      inputsIn({ ring: tapeFor(minute, nowMs), legs, minuteOfDay: minute, nowMs }),
      DIALS,
      st,
      MARK,
    )
    if (d.actions.length === 0) {
      st = d.stateAfter
      continue
    }
    triggers.push(`${clockOf(minute)} ${d.trigger}`)
    orders += d.actions.length
    const closing = d.actions.filter((a) => a.op !== 'open')
    if (closing.length > 0 && minute < DIALS.dl_flatten_passive_min) {
      closesBefore.push({ minute, trigger: d.trigger })
    }
    if (d.trigger === 'dl-open') openLegs = d.actions.length
    if (d.trigger === 'dl-add' || d.trigger === 'dl-neutral') adjustments += 1
    legs = fold(legs, d.actions)
    mostShort = Math.min(mostShort, netOf(legs))
    st = d.stateAfter
  }

  // 1. ADDS ONLY. Anything that closed before 14:50 must be one of the three
  //    exits — and on this tape, which never loses enough, none of them fire.
  for (const c of closesBefore) {
    assert.ok(
      c.trigger === 'dl-target' || c.trigger === 'dl-stuck' || c.trigger === 'dl-stop',
      `${clockOf(c.minute)}: a ${c.trigger} closed a leg before the flatten window — D2 is violated. Day: ${triggers.join(', ')}`,
    )
  }

  // 2. THE BOOK OPENED ONCE, AND ONLY ONCE.
  assert.ok(openLegs === 2 || openLegs === 4, `one open package of 2 or 4 legs, got ${openLegs}`)
  assert.equal(st.dlOpenedMs === 0, false, 'the book did open')
  assert.equal(
    triggers.filter((t) => t.endsWith('dl-open')).length,
    1,
    `exactly one open. Day: ${triggers.join(', ')}`,
  )

  // 3. THE COUNT IS BOUNDED. Spec §8: open (≤4) + `dl_max_adjusts_day` single
  //    legs + one close a leg at the flatten.
  assert.ok(
    adjustments <= DIALS.dl_max_adjusts_day,
    `${adjustments} adjustments against a cap of ${DIALS.dl_max_adjusts_day}`,
  )
  assert.equal(st.dlAdjustsToday, adjustments, 'the counter agrees with what went out')
  const ceiling = 4 + DIALS.dl_max_adjusts_day + (4 + DIALS.dl_max_adjusts_day)
  assert.ok(orders <= ceiling, `${orders} orders against a §8 ceiling of ${ceiling}`)

  // 4. THE BOOK NEVER REVERSED. A `counter` adjustment brings the net to ZERO
  //    and never past it, so an up-or-flat open can never turn into a short
  //    book. The tolerance is the dead band plus one long-band strike's delta:
  //    a package rounds to the nearest lot, so it may overshoot by half of one.
  const reversalBound = -(DIALS.dl_dead_band_lots + D_23950_CE)
  assert.ok(
    mostShort >= reversalBound,
    `the book went to ${mostShort.toFixed(2)} delta-lots, past the ${reversalBound.toFixed(2)} no-reversal bound. Day: ${triggers.join(', ')}`,
  )

  // 5. AND IT ENDED FLAT AND STOPPED. `dl_flat_by_min` is not a suggestion.
  assert.deepEqual(legs, [], `the book must be flat by 15:01, holding ${legs.length} leg(s)`)
  assert.equal(st.dlStopped, true)
})

test('a scripted day that hits the target stops there and trades no more', () => {
  // The same drive, with a book that marks +11,000 from the moment it opens.
  // Once `dl-target` banks it the day is over: no further package of any kind.
  let st: RuleState = { ...EMPTY_RULE_STATE }
  let legs: LegView[] = []
  const after: string[] = []
  let banked = 0

  for (let minute = 555; minute <= 901; minute += 1) {
    const nowMs = NOW + (minute - MINUTE) * 60_000
    const marked = legs.map((l, i) => ({ ...l, mtm: i === 0 ? 11_000 : 0 }))
    const d = decideDeltaLean(
      inputsIn({
        ring: tapeFor(minute, nowMs), legs: marked, minuteOfDay: minute, nowMs,
        cumRealized: banked,
      }),
      DIALS, st, MARK,
    )
    if (st.dlStopped && d.actions.length > 0) after.push(`${clockOf(minute)} ${d.trigger}`)
    if (d.trigger === 'dl-target' && d.action === 'flatten') banked = 11_000
    legs = fold(legs, d.actions)
    st = d.stateAfter
  }
  assert.deepEqual(after, [], `nothing may route after the latch. Got: ${after.join(', ')}`)
  assert.equal(st.dlStopped, true)
  assert.deepEqual(legs, [])
})
```

Add the minute formatter beside the other fixture helpers:

```ts
/** A minute-of-day as `HH:MM`, so an assertion message names a time an operator
 * can find on a chart. */
const clockOf = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
```

- [ ] **Step 2: Run it**

Run: `node --test packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: PASS. If it FAILS, the assertion message names the minute and the trigger — fix the RULE in Tasks 4-7, never the property. The two failures worth expecting:
- an early close under `dl-neutral` or `dl-add` means an adjustment built a `close`/`resize`, which means `adjustmentPackage` returned something other than a single `op: 'open'`;
- more than `dl_max_adjusts_day` adjustments means the counter is being written to `markState` instead of `stateAfter`, or the same-regime gate is comparing the wrong field;
- a breach of the no-reversal bound means `postureGap` is not honouring `Posture.direction` on the `'counter'` mode — it is targeting `-D` rather than `0`, or dropping the one-sided filter.

One thing that is NOT a failure: a day with very FEW adjustments, or none. The quiet open is a strangle whose net delta is ~0 by construction, so a `counter` posture on it is satisfied from the first tick and the book legitimately sits still. All three assertions are upper bounds; a still book passes them, which is the behaviour the operator asked for.

- [ ] **Step 3: Commit**

```bash
git add packages/desk-engine/test/delta-lean-decide.test.ts
git commit -m "test(delta-lean): a scripted day proves adds-only and the order ceiling"
```

---

### Task 9: The supervisor host — `DL_EXIT_TRIGGERS`, `#settle` into `dlDayRealized`

**Files:**
- Modify: `apps/supervisor/src/engine-host.ts:450-464` (`DL_CUT_TRIGGERS` → `DL_EXIT_TRIGGERS`), `:1403`, `:1973`, `:2471-2480`, `:2519-2530`, `:2574-2605` (`#rollBack`'s `keepAddStamp`), `:2635-2692` (`#settle`'s `leanBanked`), `:2718` (the `dlLeanRealized` write), `:130-145` and `:1608-1620` (doc comments naming deleted fields)
- Modify: `apps/api/test/delta-lean-fold-race.test.ts:10-13,50-68` (it asserts on `dl_add_cooldown_s`)
- Modify: `apps/api/test/delta-lean-registration.test.ts:21,144,153,155` (it asserts `dl_max_lean_lots` and `dl_gamma_drift_keep`)
- Test: `apps/supervisor/test/engine-host-delta-lean.test.ts` — the `DL_CUT_TRIGGERS` cases at `:395-410`, `:508-540`, the settle case at `:1337-1385`, the `dlLastAddMs` cases at `:1208-1230`, and every `dlLeanId` seed

**Interfaces:**
- Consumes: Task 1's `RuleState`/`TRIGGERS`, Task 2's `Dials`, Task 7's finished `decideDeltaLean`.
- Produces:
  - `const DL_EXIT_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>(['dl-target', 'dl-stuck', 'dl-stop'])` — replaces `DL_CUT_TRIGGERS` at both read sites with identical semantics: no `confirm_ms` wait, preempts a working add, never dropped by the order budget.
  - `#settle` folds the package's whole realised `banked` into `ruleState.dlDayRealized` alongside `cumRealized`; the `leanBanked`/`lean` attribution is deleted.
  - `#rollBack(request, markState, keepAdjustStamp: boolean)` keeps `dlLastAdjustMs` (was `dlLastAddMs`) from the current state when the refused package had an open in it.
  - `EngineHostDeps`, `#decide`, `#budgetRoom`, `#paced`, `openBudget`, `workModeFor` and `tradingMinutesToExpiry` are UNCHANGED in signature.

- [ ] **Step 1: Write the failing host tests**

In `apps/supervisor/test/engine-host-delta-lean.test.ts`:

1. Delete `dlLeanId` from every `seed({...})` call (lines 395, 402, 514, 573, 624, 687, 887, 964, 1020, 1075, 1156, 1161, 1346, 1372) — the field is gone, so each is a type error. `leanBook('L1')` still works: `LegPosition.leanId` survives (Task 1's Interfaces block), so keep the helper and leave its argument alone.

2. Replace the fast-path test at `:508-524` with:

```ts
test('a delta-lean EXIT takes the fast path — no confirm wait', async () => {
  // A minute-long confirm window, and the exit goes out on the FIRST sighting.
  // The controller emits one only after the day backstop, the target or the
  // stuck clock has already fired; waiting re-asks a question it has answered,
  // and on a book at the cap the wait is the difference between the stuck exit
  // and the day backstop.
  const h = make({ book: leanBook('L1'), dials: leanDials({ confirm_ms: 60_000 }) })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  await h.host.evaluate()

  const req = h.client.requests[0]
  assert.ok(req !== undefined, 'routed on the first sighting')
  assert.equal(req.trigger, 'dl-stop')
  assert.ok(
    h.lines.some((l) => l.msg.includes('routing without the confirm wait')),
    'and it took the escape hatch rather than happening to be past the window',
  )
})

test('an OPEN and an ADJUSTMENT still serve their confirm window', async () => {
  // Only the three exits skip it. An open is a new position on a tape that has
  // to still be there a second later, which is the whole reason damping exists.
  const h = make({ dials: leanDials({ confirm_ms: 1_000 }) })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'the first sighting only ARMS the intent')
  assert.ok(h.host.armedIntent !== null)

  h.advance(1_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'and the second, past confirm_ms, routes it')
  assert.equal(h.client.requests[0]?.trigger, 'dl-open')
})

test('the three exit triggers are exactly dl-target, dl-stuck and dl-stop', () => {
  // Pinned as a SET rather than one trigger at a time: a fourth name added here
  // would silently gain the no-confirm fast path, and the fast path is what
  // lets a package skip the damping every other decision serves.
  assert.deepEqual([...DL_EXIT_TRIGGERS].sort(), ['dl-stop', 'dl-stuck', 'dl-target'])
  for (const adds of ['dl-open', 'dl-add', 'dl-neutral'] as const) {
    assert.equal(DL_EXIT_TRIGGERS.has(adds), false, `${adds} is an ADD and must be damped`)
  }
})
```

   and export `DL_EXIT_TRIGGERS` from `engine-host.ts` so the last test can import it (add it to the test's import block beside `EngineHost`).

3. Replace the settle test at `:1337-1385` with:

```ts
test('a realised close folds into dlDayRealized as well as cumRealized', async () => {
  /**
   * Spec §7. `cumRealized` is the TAG's bank and drives `totalPnl`, which is
   * what the backstop, the target and the stuck rule all read. `dlDayRealized`
   * is this DAY's half of the same money, kept for the ledger and the run page
   * so an operator can see what was banked without subtracting a mark. The
   * engine reads it nowhere — which is exactly why it has to be written here or
   * it is permanently 0 and silently wrong.
   */
  const h = make({ book: leanBook('L1', 2) })
  await h.seed({ dlStopped: true, dlDayStarted: DATE, dlDayRealized: 1_000 })
  const before = await h.state()
  await h.host.evaluate()
  await h.settleWithFill({ price: 260 })   // above the leg's 210 entry: a gain
  const after = await h.state()

  const banked = after.cumRealized - before.cumRealized
  assert.ok(banked > 0, 'the fill banked something')
  assert.equal(
    after.ruleState.dlDayRealized,
    before.ruleState.dlDayRealized + banked,
    'the same rupees, counted for the day as well as for the tag',
  )
})

test('a package that opens and banks nothing leaves dlDayRealized alone', async () => {
  const h = make()
  await h.seed({ dlDayStarted: DATE, dlDayRealized: 4_200 })
  await h.host.evaluate()
  await h.settleWithFill({ price: 210 })
  const after = await h.state()
  assert.equal(after.ruleState.dlDayRealized, 4_200)
})
```

   Use whatever the file's existing fill helper is called (the current settle test at `:1337` shows it) rather than inventing `settleWithFill` — read that test before writing these.

4. Replace the two `dlLastAddMs` rollback tests at `:1208-1230` with the same tests against `dlLastAdjustMs`, keeping their assertions and comments:

```ts
test('a refused package keeps its adjust stamp, so the retry is paced', async () => {
  /**
   * Both delta-lean presets set `cooldown_s: 0`, so `lastActionMs` paces
   * nothing on this engine. What stands between a persistent 4xx and an
   * identical package every tick is `dlLastAdjustMs` → `dl_adjust_cooldown_s` —
   * and that stamp rides on `stateAfter` alone, which is exactly what a
   * rollback discards. So the rollback KEEPS it when the refused package had an
   * open in it, and a persistent 4xx costs one request every ten minutes rather
   * than one every two seconds.
   */
  const h = make({ dials: leanDials() })
  await h.seed({ dlDayStarted: DATE })
  h.client.refuseNext('strategy is switched off for paper')
  await h.host.evaluate()
  const after = await h.state()
  assert.equal(after.ruleState.dlLastAdjustMs, h.now, 'the stamp survived the rollback')
  assert.equal(after.ruleState.dlOpenedMs, 0, 'but nothing else did — the book did NOT open')
  assert.equal(after.ruleState.dlAdjustsToday, 0, 'and a refused package burns no adjustment')
})

test('a refused EXIT is paced by nothing — nothing may delay an exit', async () => {
  const h = make({ book: leanBook('L1'), dials: leanDials() })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  h.client.refuseNext('boom')
  await h.host.evaluate()
  const after = await h.state()
  assert.equal(after.ruleState.dlLastAdjustMs, 0, 'an exit carries no open, so no stamp is kept')
})
```

   Use the file's real refusal helper in place of `refuseNext` — the existing `#refused` tests around `:1240-1270` show it.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test apps/supervisor/test/engine-host-delta-lean.test.ts`
Expected: FAIL to load — `DL_EXIT_TRIGGERS` is not exported, and `dlDayRealized`/`dlLastAdjustMs` do not exist on the host's writes.

- [ ] **Step 3: Rename the trigger set**

`apps/supervisor/src/engine-host.ts:450-464` — replace the comment and the constant with:

```ts
/**
 * THE DELTA-LEAN BOOK'S RISK-OFF TRIGGERS — the ones that must not wait, and
 * the ones that cancel a working add to get out.
 *
 * All three are emitted only AFTER a rule has already fired: the day target
 * after `dl_day_target` was made, the stuck exit after `dl_stuck_confirm_s` of
 * blocked-and-losing, the day backstop after the rupee floor. `confirm_ms` on
 * top of that re-asks a question the controller has answered — and on a book at
 * its SPAN cap the wait is the difference between the stuck exit and the day
 * backstop.
 *
 * The other three delta-lean triggers — `dl-open`, `dl-add`, `dl-neutral` — are
 * ADDS and are damped like any other decision. Under spec D2 they can never
 * carry a close, so nothing they emit needs to jump a queue.
 *
 * `'eod'` is deliberately NOT here: it is already in `GUARD_TRIGGERS`, which
 * bypasses damping outright and preempts a working package on its own.
 *
 * EXPORTED for the test that pins the set: a fourth name added here would
 * silently gain the fast path.
 */
export const DL_EXIT_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>([
  'dl-target',
  'dl-stuck',
  'dl-stop',
])
```

Update both read sites — `:1403` (`DL_CUT_TRIGGERS.has(decision.trigger)` inside the `cutting` const of `#preempt`) and `:1973` (`if (dials.delta_lean_enabled && DL_CUT_TRIGGERS.has(...)) return true` in the obvious-breach escape) — to `DL_EXIT_TRIGGERS`. Rename the local `const cutting` at `:1400` to `const exiting` and its log line at `:1406` from `a ${decision.trigger} preempts the working add — cuts outrank adds` to `a ${decision.trigger} preempts the working add — exits outrank adds`.

- [ ] **Step 4: Rewrite `#settle`'s fold**

`apps/supervisor/src/engine-host.ts:2635-2692` — delete the `leanBanked` accumulator, the `const lean = current.ruleState.dlLeanId` line, and the `if (lean !== '' && b.leanId === lean) leanBanked += gain` line. Replace the `THE SAME RUPEES AGAIN…` doc comment with:

```ts
      /**
       * THE DAY'S HALF OF THE SAME RUPEES (spec §7).
       *
       * `cumRealized` is the TAG's bank. It drives `totalPnl`, which is what
       * the day backstop, the day target and the stuck rule all read, and it
       * also feeds the RECENTER target lock — which is why it is not zeroed per
       * day here. `dlDayRealized` is this day's slice of it, zeroed by
       * `rollDay` and read by nothing in the engine: it exists so a ledger row,
       * the run page and an operator can see what was BANKED without
       * subtracting a mark.
       *
       * The v1 engine attributed these rupees to a LEAN instead, off the basis
       * row's `leanId`, because its add/cut/flip rules read a per-lean P&L.
       * This engine has no lean and no such rule — every exit reads the day's
       * number — so the attribution is gone and the whole `banked` lands here.
       */
```

Replace the `ruleState` spread at `:2716-2720` with:

```ts
        ruleState: {
          ...current.ruleState,
          rcStack,
          dlDayRealized: current.ruleState.dlDayRealized + banked,
        },
```

- [ ] **Step 5: Rename the rollback stamp**

`apps/supervisor/src/engine-host.ts:2574-2605` — rename the `keepAddStamp` parameter of `#rollBack` to `keepAdjustStamp`, and change its body's spread from

```ts
                ...(keepAddStamp && hadOpen ? { dlLastAddMs: current.ruleState.dlLastAddMs } : {}),
```

to

```ts
                ...(keepAdjustStamp && hadOpen
                  ? { dlLastAdjustMs: current.ruleState.dlLastAdjustMs }
                  : {}),
```

Update both call sites (`#refused` and `#skipped`) and the doc comments at `:2465-2480`, `:2519-2530` and `:2574-2585`, replacing every `dl_add_cooldown_s` / `dlLastAddMs` with `dl_adjust_cooldown_s` / `dlLastAdjustMs` and "15 s" with "10 min".

- [ ] **Step 6: Fix the remaining comment-only references**

`grep -n 'dlLean\|dl_add_cooldown_s\|dl_max_lean_lots\|dl_lean_max_loss\|dl_cut_frac\|dl_spot_stale_s\|leanPnl\|newLeanId\|lean`s bank' apps/supervisor/src/engine-host.ts apps/supervisor/src/main.ts` and update each doc comment to the new vocabulary. These are comments, not code — `engine-host.ts:130-145`, `:632-647`, `:805-812`, `:1608-1620`, `:1964-1974`; `main.ts:153-160`, `:341`, `:950-956`. `dl_spot_stale_s` survives (Task 2), so `main.ts:156` and `:952` and `engine-host.ts:325` are still accurate and need no edit.

- [ ] **Step 7: Fix the two api tests**

`apps/api/test/delta-lean-fold-race.test.ts` — its whole premise is "the add cooldown is what stops the engine re-buying a leg the fold has not written yet". That premise survives under a different dial name and a much longer window. Replace `dl_add_cooldown_s` with `dl_adjust_cooldown_s` at lines 10, 13, 50, 53 and 68, and update the header paragraph: the cooldown is now 600 s aggressive / 900 s conservative against a worst-case fold lag measured in seconds, so the `>= WORST_CASE_FOLD_LAG_MS * 3` assertion passes with two orders of magnitude of headroom rather than a little.

`apps/api/test/delta-lean-registration.test.ts` — replace the `dl_max_lean_lots` assertions at `:144` and `:153` with `assert.equal(agg.dials['dl_open_lots'], 4)` and `assert.equal(cons.dials['dl_open_lots'], 2)`; replace the `dl_gamma_drift_keep` assertion at `:155` with `assert.equal(cons.dials['margin_cap'], 2_500_000)`; update the header comment at `:21` to name `dl_open_lots: 4` as the resolved number it is pinning.

- [ ] **Step 8: Run the host and api suites**

Run: `node --test apps/supervisor/test/engine-host-delta-lean.test.ts apps/supervisor/test/engine-host.test.ts apps/api/test/delta-lean-fold-race.test.ts apps/api/test/delta-lean-registration.test.ts apps/api/test/engine-decisions.test.ts`
Expected: PASS. `engine-decisions.test.ts` validates a trigger against `TRIGGERS`; if it names one of the deleted five in a fixture, change it to `'dl-open'` (an add) or `'dl-target'` (an exit) as the case requires.

- [ ] **Step 9: Commit**

```bash
git add apps/supervisor/src/engine-host.ts apps/supervisor/src/main.ts \
        apps/supervisor/test/engine-host-delta-lean.test.ts \
        apps/api/test/delta-lean-fold-race.test.ts \
        apps/api/test/delta-lean-registration.test.ts
git commit -m "feat(supervisor): DL_EXIT_TRIGGERS, and settle folds the day's realised"
```

---

### Task 10: The dashboard, the script, the docs, the barrel

**Files:**
- Modify: `apps/web/src/dials-plan.ts:345-530` (the `DIAL_META` `dl_*` rows) and `:612-716` (`DELTA_LEAN_GROUPS`)
- Modify: `apps/web/src/dials-panel.tsx:44-50` and `:158-166` (two doc comments naming deleted dials)
- Modify: `apps/web/test/dials-panel.test.tsx:315-330`
- Modify: `scripts/delta-lean-books.mjs:153-168` (`HEADLINE_DIALS`)
- Modify: `docs/runbooks/delta-lean-paper.md:1-32`, `:185-195`, `:290-300`, `:355-365`
- Modify: `docs/superpowers/specs/2026-09-15-delta-lean-index-book-design.md` (status note only)
- Modify: `packages/desk-engine/src/index.ts:88-95` (the delta-lean barrel comment)

**Interfaces:**
- Consumes: Task 2's dial set, Task 1's `TRIGGERS`.
- Produces: no new exports. `dialMeta(key)`, `readDial(key, value)` and the `DialGroupSpec` shape are unchanged.

- [ ] **Step 1: Write the failing web test**

`apps/web/test/dials-panel.test.tsx:315-330` — replace the `readDial` block with:

```tsx
  it('renders a dial in the units the spec states it in', () => {
    expect(readDial('dl_day_max_loss', 200000)).toBe('₹2,00,000')
    expect(readDial('dl_day_target', 10000)).toBe('₹10,000')
    expect(readDial('dl_stuck_loss', 25000)).toBe('₹25,000')
    expect(readDial('dl_adjust_cooldown_s', 600)).toBe('10 min')
    expect(readDial('dl_adjust_confirm_s', 60)).toBe('1 min')
    expect(readDial('dl_flat_by_min', 900)).toBe('15:00')
    expect(readDial('dl_warmup_min', 570)).toBe('09:30')
    expect(readDial('margin_cap', 2500000)).toBe('₹25,00,000')
    // A plain count reads as itself and gets no second line.
    expect(readDial('dl_open_lots', 4)).toBeNull()
    expect(readDial('dl_max_adjusts_day', 6)).toBeNull()
  })

  it('groups every delta-lean dial — none lands in "Not grouped"', () => {
    // A grouping that silently drops a dial is strictly worse than the wall it
    // replaced, because the wall at least showed the knob. The trailing group
    // is the safety net; this asserts the net is empty.
    const section = DIAL_SECTIONS.find((s) => s.key === 'delta-lean')
    expect(section).toBeDefined()
    const grouped = new Set(deltaLeanGroups().flatMap((g) => g.keys))
    for (const key of section!.fields) expect(grouped.has(key)).toBe(true)
  })
```

Import whatever `dials-plan.ts` exports for the grouping (the file's `DELTA_LEAN_GROUPS` consumer around `:716`); if it is not exported, export the grouping function it feeds and use that. Do not export the raw array if a function already wraps it.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test --workspace @algomaker/web -- dials-panel`
Expected: FAIL — `dl_adjust_cooldown_s` has no meta, so `readDial` returns `null` instead of `'10 min'`.

- [ ] **Step 3: Replace the `dl_*` meta rows**

`apps/web/src/dials-plan.ts` — replace every `dl_*` entry of `DIAL_META` between the `// ── Budget ──` marker (`:346`) and the end of the clock block (`:530`) with:

```ts
    // ── Budget and the four exits ───────────────────────────────────────────
    dl_day_max_loss: meta(
      'rupee',
      'The DISASTER backstop, not a working stop: the book flattens and stays stopped for the session. The stuck exit fires an order of magnitude earlier.',
      { risk: true },
    ),
    dl_day_target: meta(
      'rupee',
      'Realised plus unrealised. Reaching it closes the book and ends its day — the one exit that is good news.',
    ),
    dl_open_lots: meta(
      'lots',
      'CONTRACT lots per leg at open, and the size a pyramid add starts from. Not delta-lots.',
    ),
    dl_stuck_loss: meta(
      'rupee',
      'With the margin cap or the adjustment limit blocking every move, a loss past this arms the stuck exit.',
      { risk: true },
    ),
    dl_stuck_confirm_s: meta(
      'seconds',
      'How long blocked-AND-losing must persist before the stuck exit fires. Either condition clearing resets the clock.',
    ),

    // ── Adjustment gating ───────────────────────────────────────────────────
    dl_adjust_confirm_s: meta(
      'seconds',
      'A regime must hold this long before it justifies the open or an adjustment. The book`s patience, in one dial.',
    ),
    dl_adjust_cooldown_s: meta(
      'seconds',
      'Minimum gap between packages. The open counts as the first, so the earliest adjustment is this long after it.',
    ),
    dl_max_adjusts_day: meta(
      'count',
      'Adjustment packages allowed after the open. The open itself is not counted.',
      { units: 'per day' },
    ),
    dl_dead_band_lots: meta(
      'lots',
      'Net book delta inside this of the wanted posture is already met — there is nothing in it worth paying a spread for.',
    ),

    // ── Regime detector ─────────────────────────────────────────────────────
    dl_fast_window_s: meta('seconds', 'Fast window — gives direction.'),
    dl_slow_window_s: meta('seconds', 'Slow window — gives the regime the rules read.'),
    dl_context_window_s: meta(
      'seconds',
      'Context window — never classifies on its own; the detector uses it for confirmation.',
    ),
    dl_context_on: meta('plain', 'Off makes the context window inert and the two-window rules apply unchanged.'),
    dl_trend_mult: meta(
      'multiple',
      'Enter trend: realized displacement over this multiple of the straddle-implied move for the window.',
    ),
    dl_trend_exit_mult: meta(
      'multiple',
      'Leave trend: the ratio must fall back through this. The gap down from dl_trend_mult IS the hysteresis.',
    ),
    dl_clean_min: meta(
      'fraction',
      'Cleanliness floor, |displacement| / range. A big range with no displacement is chop, not trend.',
    ),
    dl_quiet_mult: meta(
      'multiple',
      'Quiet: range inside this multiple of implied for two consecutive windows.',
    ),
    dl_regime_dwell_s: meta('seconds', 'Minimum dwell before a trend may be left at all.'),

    // ── Sizing and strike selection ─────────────────────────────────────────
    dl_long_delta_lo: meta('delta', 'The directional leg: buy no lower than this delta. Also the band an adjustment buys in.'),
    dl_long_delta_hi: meta('delta', 'The directional leg: buy no higher than this delta.'),
    dl_short_delta_lo: meta('delta', 'The trend hedge: sell no lower than this delta.'),
    dl_short_delta_hi: meta('delta', 'The trend hedge: sell no higher than this delta.'),
    dl_credit_short_delta_max: meta('delta', 'A quiet open`s short sells no closer to spot than this delta.'),
    dl_wing_delta: meta('delta', 'Delta of the wing bought beyond a quiet open`s short. Always bought — a naked sale is not an option.'),
    dl_min_strike_gap: meta(
      'strikes',
      'How far from ATM, in strikes, a leg must sit — so a delta band cannot land on ATM by accident on expiry day, when every strike is a steep delta.',
    ),
    dl_neutral_short_delta_lo: meta(
      'delta',
      'The sideways neutralising SALE: sell no lower than this delta. At 0.45-0.60 it is ATM, which carries the same net-delta effect as an ITM sale with more time value and a better book.',
    ),
    dl_neutral_short_delta_hi: meta('delta', 'The sideways neutralising sale: sell no higher than this delta. Raise both to push the sale in the money.'),

    // ── Liquidity and staleness ─────────────────────────────────────────────
    dl_quote_fresh_s: meta('seconds', 'A quote older than this is not a candidate.'),
    dl_max_spread_pct: meta('fraction', 'Widest spread as a share of mid — or dl_max_spread_abs, whichever is larger.'),
    dl_max_spread_abs: meta(
      'rupee',
      'Widest spread in rupees — the floor under dl_max_spread_pct, because 2% of a ₹3 option is six paise.',
    ),
    dl_spot_stale_s: meta('seconds', 'Spot older than this refuses NEW RISK only; the four exits still run.'),

    // ── Clock and pacing ────────────────────────────────────────────────────
    dl_warmup_min: meta('clock', 'Warm-up ends. The detector runs from 09:15 but places no order before this.'),
    dl_flatten_passive_min: meta('clock', 'Start flattening passively.'),
    dl_flatten_urgent_min: meta('clock', 'Flatten urgently.'),
    dl_flat_by_min: meta('clock', 'Must be flat. Anything left over goes to the blind ladder.'),
    dl_eval_min_ms: meta('ms', 'The controller loop interval.'),
    dl_max_orders_min: meta('count', 'The per-book order rate the broker imposes.', { units: 'orders/min' }),
    dl_max_orders_s: meta('count', 'Per-second order budget — enforced by the supervisor host, not the engine.', { units: 'orders/s' }),
    dl_max_orders_day: meta(
      'count',
      'The whole day`s order budget — enforced by the host. Design ceiling is about twenty.',
      { units: 'orders/day' },
    ),
```

- [ ] **Step 4: Replace `DELTA_LEAN_GROUPS`**

`apps/web/src/dials-plan.ts:612-716` — replace the array with:

```ts
const DELTA_LEAN_GROUPS: ReadonlyArray<DialGroupSpec> = [
  {
    key: 'budget',
    label: 'Budget and the four exits',
    note: 'Nothing closes a leg before the close except these: the flatten windows, the day backstop, the day target, and the stuck rule.',
    keys: ['dl_day_max_loss', 'dl_day_target', 'dl_open_lots', 'dl_stuck_loss', 'dl_stuck_confirm_s'],
  },
  {
    key: 'adjust',
    label: 'Adjustment gating',
    note: 'How rarely the book may change its mind: a regime must hold, a cooldown must pass, the day has a ceiling, and the SAME regime never justifies two packages in a row.',
    keys: ['dl_adjust_confirm_s', 'dl_adjust_cooldown_s', 'dl_max_adjusts_day', 'dl_dead_band_lots'],
  },
  {
    key: 'regime',
    label: 'Regime detector',
    note: 'Three windows priced against the ATM straddle: fast gives direction, slow gives the regime the rules read, context confirms.',
    keys: [
      'dl_fast_window_s', 'dl_slow_window_s', 'dl_context_window_s', 'dl_context_on',
      'dl_trend_mult', 'dl_trend_exit_mult', 'dl_clean_min', 'dl_quiet_mult', 'dl_regime_dwell_s',
    ],
  },
  {
    key: 'strikes',
    label: 'Sizing and strike selection',
    note: 'Delta bands rather than strike offsets, because the same strike is a different delta on Monday and on expiry eve.',
    keys: [
      'dl_long_delta_lo', 'dl_long_delta_hi', 'dl_short_delta_lo', 'dl_short_delta_hi',
      'dl_credit_short_delta_max', 'dl_wing_delta', 'dl_min_strike_gap',
      'dl_neutral_short_delta_lo', 'dl_neutral_short_delta_hi',
    ],
  },
  {
    key: 'liquidity',
    label: 'Liquidity and staleness',
    note: 'What counts as a quote worth trading against, and when a price is too old to take new risk on.',
    keys: ['dl_quote_fresh_s', 'dl_max_spread_pct', 'dl_max_spread_abs', 'dl_spot_stale_s'],
  },
  {
    key: 'clock',
    label: 'Clock and pacing',
    note: 'The day timeline in minutes since midnight, and the rate the book may act at.',
    keys: [
      'dl_warmup_min', 'dl_flatten_passive_min', 'dl_flatten_urgent_min', 'dl_flat_by_min',
      'dl_eval_min_ms', 'dl_max_orders_min', 'dl_max_orders_s', 'dl_max_orders_day',
    ],
  },
]
```

Update the block comment above it (`:589-611`): "all fifty-seven fields" becomes "all thirty-eight fields", and the group list becomes "budget and the exits, adjustment gating, the regime detector, strike selection, liquidity and staleness, clock and pacing".

- [ ] **Step 5: Fix the two panel comments**

`apps/web/src/dials-panel.tsx:44-50` — replace `dl_capital: 2500000 is ₹25 lakh and dl_cut_frac: 0.5 is half the peak profit` with `dl_flat_by_min: 900 is 15:00, margin_cap: 2500000 is ₹25 lakh and dl_dead_band_lots: 0.5 is half a future's worth of delta`.

`apps/web/src/dials-panel.tsx:158-166` — replace the risk-dial list `dl_day_max_loss, dl_lean_max_loss and dl_max_lean_lots` with `dl_day_max_loss and dl_stuck_loss`.

- [ ] **Step 6: Run the web suite**

Run: `npm run test --workspace @algomaker/web`
Expected: PASS.

- [ ] **Step 7: Update the registration script's headline dials**

`scripts/delta-lean-books.mjs:153-168` — replace `HEADLINE_DIALS` with:

```js
const HEADLINE_DIALS = [
  'delta_lean_enabled',
  'margin_cap',
  'dl_day_max_loss',
  'dl_day_target',
  'dl_open_lots',
  'dl_max_adjusts_day',
  'dl_adjust_cooldown_s',
  'dl_stuck_loss',
  'dl_warmup_min',
  'dl_flat_by_min',
  'confirm_ms',
  'cooldown_s',
  'chase_max_ms',
]
```

and update its doc comment: "the money terms and the clock" now means the SPAN cap, the two day numbers, the size, and how rarely the book may act.

Leave `dialsFor`'s `unknown.length > 0` throw at `:408-418` exactly as it is: the script builds the payload from `PRESETS`, so an unknown key there is a preset/schema drift and should still be fatal. That is a different question from `resolveDials` refusing a STORED row, which Task 2 pinned as non-fatal.

- [ ] **Step 8: Update the barrel comment**

`packages/desk-engine/src/index.ts:82-95` — the delta-lean paragraph says the book "trades index delta on weekly options, long gamma when the tape trends and short gamma when it is quiet, with theta held near zero". Replace with:

```
/**
 * THE SECOND DECIDE PATH.
 *
 * `delta-lean/` is a whole engine beside the recenter one, not a tier of it: it
 * opens ONE hedged package a day on a weekly index option, holds it, and when
 * the tape disagrees it neutralises BY ADDING rather than by closing. Nothing
 * takes a leg off before the close except four exits — the flatten windows, the
 * day backstop, the day target and the stuck rule. A book reaches it through
 * one dial, `delta_lean_enabled`, which defaults off, so every existing book
 * decides exactly as it did before this directory existed.
 */
export * from './delta-lean/regime.ts';
export * from './delta-lean/lean.ts';
export * from './delta-lean/express.ts';
export * from './delta-lean/decide.ts';
```

The four `export *` lines are unchanged: `lean.ts` now exports only `rollDay`, `express.ts` only the four structure helpers, and `decide.ts` only `decideDeltaLean` and `DeltaLeanInputs`, so the barrel's surface shrinks with them and no dead export survives. Verify with `npx tsc -p tsconfig.json --noEmit`.

- [ ] **Step 9: Update the runbook**

`docs/runbooks/delta-lean-paper.md`:
- `:1-8` — the opening paragraph still stands (four paper books, D10 ends the delivery here). Add one sentence after it: "The engine those four books run is the hold-and-adjust one of `docs/superpowers/specs/2026-09-22-delta-lean-hold-adjust-design.md`: it opens one hedged package a day, neutralises by adding, and closes nothing before the 14:50 window except on the day target (₹10,000), the day backstop (₹2,00,000) or the stuck rule."
- `:16` — the "Its stops" row: replace `the engine's own day stop (dl_day_max_loss)` with `the engine's four exits (dl_day_target, dl_stuck_loss, dl_day_max_loss and the 14:50/14:55/15:00 flatten) and the desk's day guard, armed at registration off the same resolved dl_day_max_loss`.
- `:188-191` — the risk-dial paragraph: replace with "**The risk dials.** Both: `margin_cap 2500000`, `dl_day_max_loss 200000`, `dl_day_target 10000`. Aggressive: `dl_open_lots 4`, `dl_max_adjusts_day 6`, `dl_stuck_loss 25000`. Conservative: `2`, `4`, `15000`. These are spec §4's two columns. If they are not these numbers, the presets moved."
- `:193-194` — "every `DEFAULT_DIALS` key (103 today)" — recount after Task 2 and write the real number.
- `:294-295` — replace "a first `dl-lean` action" with "a first `dl-open` action, then at most a handful of `dl-add`/`dl-neutral` ones".
- `:355-360` — the day-one sweep's "resolved `dl_day_max_loss`: 100,000 on the aggressive rows, 15,000 on the conservative" becomes "200,000 on every row — the backstop is not a per-preset number any more; what differs is `dl_stuck_loss`, 25,000 against 15,000".
- `:444` — the two-day-stops paragraph still stands; add that the engine now normally exits on `dl_day_target` or `dl_stuck_loss` long before either day stop is reached.

- [ ] **Step 10: Mark the superseded spec**

`docs/superpowers/specs/2026-09-15-delta-lean-index-book-design.md` — add immediately under its title:

```markdown
> **SUPERSEDED, 2026-09-22.** §6-§9 (the decide loop, its lean/cut/flip/theta/roll
> rules, their dials and their tests) are replaced by
> `2026-09-22-delta-lean-hold-adjust-design.md`. What still stands: the registry
> shape, the four paper books, the daily roll (§10 and the runbook), and the
> regime detector (§5).
```

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/dials-plan.ts apps/web/src/dials-panel.tsx apps/web/test/dials-panel.test.tsx \
        scripts/delta-lean-books.mjs packages/desk-engine/src/index.ts \
        docs/runbooks/delta-lean-paper.md \
        docs/superpowers/specs/2026-09-15-delta-lean-index-book-design.md
git commit -m "feat(web,docs): the hold-and-adjust dial panel, headline dials and runbook"
```

---

### Task 11: Full check and merge

**Files:** none modified except by the fixes this task finds.

**Interfaces:**
- Consumes: every task above.
- Produces: a green tree.

- [ ] **Step 1: Sweep for every deleted identifier**

Run:

```bash
cd /opt/algomaker-delta && grep -rn --include='*.ts' --include='*.tsx' --include='*.mjs' \
  -e 'dlLeanId' -e 'dlLeanSide' -e 'dlLeanOpenedMs' -e 'dlLeanPeak' -e 'dlLeanRealized' \
  -e 'dlLeanPnlAtLastAdd' -e 'dlLeanAdds' -e 'dlTargetLots' -e 'dlFlips' -e 'dlLastFlipMs' \
  -e 'dlLastAddMs' -e 'dlLastUnwindMs' -e 'DL_CUT_TRIGGERS' \
  -e 'leanBestFit' -e 'rollNeeded' -e 'shortGammaLoss' -e 'canFlip' -e 'leanPnl' \
  -e 'newLeanId' -e 'rollFlipHour' \
  -e 'dl-lean' -e 'dl-cut' -e 'dl-flip' -e 'dl-theta' -e 'dl-roll' \
  -e 'dl_capital' -e 'dl_lean_max_loss' -e 'dl_base_unit_lots' -e 'dl_max_lean_lots' \
  -e 'dl_add_step_pnl' -e 'dl_add_cooldown_s' -e 'dl_cut_frac' -e 'dl_cut_floor' \
  -e 'dl_flip_' -e 'dl_max_flips' -e 'dl_gamma_drift_keep' -e 'dl_theta_' \
  -e 'dl_short_gamma_move_pct' -e 'dl_context_disagree_cap' -e 'dl_pause_theta_frac' \
  -e 'dl_chop_unwind_s' -e 'dl_min_hold_s' -e 'dl_wings_on' -e 'dl_roll_' \
  -e 'dl_margin_frac' -e 'dl_cost_gate_mult' -e 'dl_leg_stale_s' -e 'dl_no_new_units_min' \
  . | grep -v node_modules | grep -v '/dist/' | grep -v '^./archive/' \
    | grep -v '^./docs/superpowers/plans/2026-09-15' | grep -v '^./docs/superpowers/specs/'
```

Expected: EMPTY. `leanId` (the leg stamp) is deliberately NOT in this list — it survives, see Task 1. The two excluded doc paths are historical records and are left alone; Task 10 added the supersession note that explains them.

Anything this prints is a file a task above missed. Fix it in place, in the task's own spirit, and note which task should have caught it.

- [ ] **Step 2: Typecheck both projects**

Run: `npm run typecheck`
Expected: clean. Both projects — the root `tsconfig.json` excludes `apps/web`, so a run that stops after the first is a dashboard that was never checked.

- [ ] **Step 3: Run the full suite**

Run: `make check`
Expected: PASS. This is `typecheck` then `npm test`, which is `test:node` (every `packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts` under `node --test`) then `test:web` (the vitest/jsdom dashboard suite). Running only the first reports green while the dashboard is untested.

Run it ONCE on the merged tree, not per worktree — the api Mongo suites use fixed database names and parallel runs collide on them.

- [ ] **Step 4: Confirm the spec's expected trade count against the property test**

Run: `node --test --test-name-pattern 'scripted day' packages/desk-engine/test/delta-lean-decide.test.ts`
Expected: PASS, and the assertion messages in the failure text (if it ever fails) name the order count. Spec §8 predicts 6-10 orders typical, ceiling ~20. If the scripted day comes out at the ceiling every run, say so in the merge message — it is the number the operator will judge this by on day one.

- [ ] **Step 5: Merge**

The branch is a replacement, not a feature toggle: `delta_lean_enabled` still defaults off, no recenter book changes behaviour, and the four paper books pick up the new engine on the next 08:50 roll without a script change (D1). Nothing here needs a deploy step of its own.

```bash
git log --oneline master..HEAD          # ten commits, one per task
git checkout master && git merge --no-ff -
```

Merge message body:

```
Delta-lean v2 — hold-and-adjust, replacing the delta controller.

The v1 controller re-derived a target delta every second and diffed it
against the book; it had thirteen exit paths and almost all of them closed
the original leg. On 2026-09-22 the four paper books made 240 orders and
532 fills for Rs6,377.

This engine opens ONE hedged package a day and holds it. When the tape
disagrees it neutralises BY ADDING — buys the opposite option, or sells a
same-side one — and closes nothing before 14:50 except on the day target
(Rs10,000), the day backstop (Rs2,00,000) or the stuck rule. The cap is a
SPAN-lite ceiling of Rs25,00,000 on the whole package, so a hedged or
cross-side leg gets its offset.

Six triggers: dl-open, dl-add, dl-neutral, dl-target, dl-stuck, dl-stop.
Thirty-eight dials where there were fifty-seven. Registry shape, preset
names, variant strings and the 08:50 roll script are unchanged, so
tomorrow's four books register on the new engine with no script change.

Spec: docs/superpowers/specs/2026-09-22-delta-lean-hold-adjust-design.md
Plan: docs/superpowers/plans/2026-09-22-delta-lean-hold-adjust.md
```

**DO NOT** run `make deploy`, install a cron, or restart pm2 as part of this task. `pm2 restart` is the operator's, and the roll must never be installed before the restart onto the new build.

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 Why | The merge message, Task 11 step 5 |
| D1 replace not fork (names unchanged) | Global Constraints; Task 10 step 7 (script untouched apart from the print) |
| D2 adds only until the close | Global Constraints; Tasks 6, 7; Task 8 property 1 |
| D3 one hedge at open | Task 5 (`openPackage` — debit pair's short, or the strangle's two wings) |
| D4 SPAN-lite cap, `margin_cap` 2,500,000 | Task 2 (`DELTA_LEAN_BASE`); Task 5 (`projectFits`, `fitLots`) |
| D5 sideways sells ATM, band-dialled | Task 2 (`dl_neutral_short_delta_lo/hi`); Task 6 (`adjustmentPackage`) |
| D6 day max loss 200,000 as a backstop | Task 2; Task 4 step 3 (order position and doc) |
| D7 sizing in contract lots | Task 2 (`dl_open_lots`); Task 5 |
| §3 the eleven state fields, the removals | Task 1 |
| §4 kept/new/removed dials; `resolveDials` ignores unknown | Task 2 (with three documented deviations, below) |
| §5 step 0 day roll | Task 3 (`rollDay`); Task 4 |
| §5 steps 1-4 the exits | Task 4 (`exitDecision`) |
| §5 step 5 the gates | Task 4 |
| §5 step 6 the open | Task 5 |
| §5 step 7 the posture and gates | Tasks 6, 7 |
| §6.1 open | Task 5 |
| §6.2 `D` = the hedged pair's own net delta | Task 6 (`unitDelta`) |
| §6.2 the three posture modes, relative to `dlOpenSide` | Task 6 (`wantedPosture`, `postureGap`) |
| §6.2 neutralise to zero, never reverse | Task 6 (the `counter` tests); Task 8 property 3 |
| §6.2 the add that expresses each mode, and the trigger choice | Task 6 (`adjustmentPackage`, `adjustTrigger`) |
| §6.3 margin gate with truncation | Task 5 (`fitLots`), Task 7 (applied to adjustments) |
| §6.4 stuck exit and its clock | Task 7 |
| §6.5 the four exits, shorts-first ordering | Task 4 |
| §7 triggers, `DL_EXIT_TRIGGERS`, `#settle` → `dlDayRealized` | Tasks 1, 9 |
| §8 expected trade count | Task 8 property 3; Task 11 step 4 |
| §9 fit: regime/express/lean/host/api/web/script/runbook | Tasks 3, 9, 10 |
| §10 tests | Tasks 1-10, each with its own |
| §11 out of scope | Task 11 step 5 forbids the deploy path |

No gaps. Three deliberate deviations from §4's dial lists, each argued in Task 2's Interfaces block and repeated here because an executor reading one task will not see the others:
- **`dl_regime_dwell_s`, `dl_context_on`, `dl_context_window_s` are KEPT** although §4's removed list names the first and lumps the other two under "context dials". `regime.ts` reads all three and §9 says `regime.ts` is unchanged; the two cannot both be honoured, and keeping a detector dial is the harmless side.
- **`dl_quote_fresh_s`, `dl_max_spread_pct`, `dl_max_spread_abs` are KEPT** although §4's kept list omits them. `tradableStrikes` reads them and §9 keeps `tradableStrikes`.
- **`dl_spot_stale_s` is KEPT and `dl_no_new_units_min` is REMOVED**, though §4 names neither. The removed list explicitly names the sibling `dl_leg_stale_s` and pointedly does not name `dl_spot_stale_s`, so the refusal of NEW RISK off a stale index price survives (and keeps `DeltaLeanInputs.spotAsOf` alive, which the host and `main.ts` both feed). `dl_no_new_units_min` has no reader in §5's decision order at all, and the cooldown plus `dl_max_adjusts_day` already bound late-day activity.

**2. Placeholder scan**

Searched for TBD, TODO, "implement later", "add appropriate", "handle edge cases", "similar to Task", "write tests for the above". None present. Every code step carries the real code; every test step carries the real test; every `Run:` line is a command this repo answers (`node --test <file>` for `packages/*` and `apps/{api,supervisor}`, `npm run test --workspace @algomaker/web` for the dashboard, `npm run typecheck`, `make check`).

Three steps deliberately defer to the file rather than guess, and each names exactly what to read first rather than what to invent: Task 3 step 9 (`markLeg`'s real signature in `marking.ts:243`), Task 9 step 1 (the host test's existing fill and refusal helpers), Task 10 step 1 (whether `dials-plan.ts` exports its grouping). That is a deliberate instruction to read a named line, not a placeholder.

Two forward references are explicit and bounded, not placeholders: Task 4's `decideDeltaLean` ends at `return hold(\`${read.slow}: holding\`, st)` and Task 5's at `return hold(\`${read.slow}: opened ${st.dlOpenSide}, holding\`, st)`. Both are real, compiling, honest code that the next task replaces at a named line, and both are testable as written.

**3. Type consistency**

Checked every name that crosses a task boundary:
- `decideDeltaLean(inputs, dials, state, markCtx)` — four arguments everywhere (Tasks 4-8 and the host's `#decide`, which is unchanged). The task brief's `(inputs, dials, state, nowMs)` was corrected to the real signature; `nowMs` is `inputs.nowMs`.
- `hold(reason, state, trigger?)` / `acted(action, trigger, reason, actions, stateAfter, markState, urgency)` — the `acted` of Tasks 5, 6 and 7 has **no** `now` parameter, unlike v1's. Consistent at all six call sites.
- `exitDecision(inputs, trigger, reason, urgency, st, latchWhenFlat)` — Task 4 defines it; Task 7's `stuckExit` calls it with `true`.
- `fitLots(inputs, dials, unit, maxLots)` and `scaleLots(actions, lots)` and `projectFits(inputs, dials, opens)` — Task 5 defines, Tasks 5 and 7 call. `spanLegOf(a, lotSize, expiry)` is used only inside `projectFits`.
- `adjustmentPackage(inputs, dials, gap, mode)` returns `{ unit, lots }` — Task 6 defines it with FOUR parameters, the fourth a `PostureMode`; Tasks 6 and 7 both call it as `adjustmentPackage(inputs, dials, gap, posture.mode)`. No `sideways` boolean survives anywhere in the plan.
- `netDeltaLots(legs)` returns `{ lots, priced }` — Task 6 defines, Tasks 6 and 7 read both fields.
- `type PostureMode = 'lean' | 'counter' | 'flat'` and `interface Posture { mode; target; direction }` — Task 6 defines. Tasks 6 and 7 read `.mode` and `.target`; only `postureGap` reads `.direction`. The pre-amendment `twoSided` boolean is gone and its job is `direction === 0`.
- `wantedPosture(regime, openSide, dials)` returns `Posture | null` — THREE parameters, called exactly once, as `wantedPosture(read.slow, st.dlOpenSide, dials)`. `postureGap(posture, net, band)` returns a number. Both Task 6.
- `adjustTrigger(posture)` — ONE parameter, defined in Task 6, called as `adjustTrigger(posture)` in both Task 6's and Task 7's wiring. It reads `.mode` and nothing else, so the trigger and the rule that produced the package cannot disagree.
- `unitDelta(dials)` reads FOUR dials — `dl_open_lots`, `dl_long_delta_lo/hi`, `dl_short_delta_lo/hi` — where the pre-amendment version read three. All four are in Task 2's table.
- `netOf(legs)` — the TEST fixture's own net-delta helper, defined once in Task 6's section-6 header and used by Tasks 6, 7 and 8's tests. It restates `legDeltaLots`'s arithmetic deliberately: a test that imported the engine's own helper would pass even if both carried the same sign bug.
- `openPackage(inputs, dials, regime)` returns `{ actions, side }` — Task 5 only.
- `confirmed(st, dials, nowMs)` — Task 5 defines, Tasks 5 and 6 call.
- `rollDay(state, dateIst, nowMs)` — Task 3 defines, Task 4 calls.
- State field names: `dlDayStarted`, `dlStopped`, `dlOpenedMs`, `dlOpenSide`, `dlAdjustsToday`, `dlLastAdjustMs`, `dlLastAdjustRegime`, `dlRegime`, `dlRegimeSinceMs`, `dlBlockedSinceMs`, `dlDayRealized` — eleven, identical in Tasks 1, 3, 4, 5, 6, 7, 8, 9 and in `state-store.ts`. Task 3's test asserts the count is 11, which is what catches a twelfth added without a reset.
- Trigger names: `dl-open`, `dl-add`, `dl-neutral`, `dl-target`, `dl-stuck`, `dl-stop` — identical in Tasks 1, 4, 5, 6, 7, 8, 9. `DL_EXIT_TRIGGERS` holds exactly the last three.
- Dial names: the 37 of Task 2's table are the only ones Tasks 4-8 read. Cross-checked each read against the table — `dl_day_max_loss`, `dl_day_target`, `dl_open_lots`, `dl_stuck_loss`, `dl_stuck_confirm_s`, `dl_adjust_confirm_s`, `dl_adjust_cooldown_s`, `dl_max_adjusts_day`, `dl_dead_band_lots`, `dl_long_delta_lo/hi`, `dl_short_delta_lo/hi` (read by `unitDelta` now, as well as by `express.ts`), `dl_neutral_short_delta_lo/hi`, `dl_min_strike_gap`, `dl_spot_stale_s`, `dl_warmup_min`, `dl_flatten_passive_min`, `dl_flatten_urgent_min`, `dl_flat_by_min`, `dl_max_orders_min`, `margin_cap` — all present. `dl_credit_short_delta_max`, `dl_wing_delta`, `dl_quote_fresh_s`, `dl_max_spread_pct/abs` are read by `express.ts`; the nine detector dials by `regime.ts`; `dl_eval_min_ms`, `dl_max_orders_s`, `dl_max_orders_day` by the host. No dial in the table is unread and no read is unlisted.
