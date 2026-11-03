# Delta-lean v2 — hold-and-adjust (replaces the delta controller)

**Date:** 2026-09-22 · **Status:** approved by the operator in chat, 2026-09-22 · **Supersedes:** the decide loop of `2026-09-15-delta-lean-index-book-design.md` §6–§9. The registry shape, the four paper books, the daily roll (§10, runbook) and the regime detector (§5) are kept.

## 1. Why

The 2026-09-15 engine is a controller: every second it re-derives a target delta and diffs it against the book. It has thirteen exit paths and almost all of them close the original leg. On 2026-09-22 the four paper books made 240 orders / 532 fills for ₹6,377 realised, mostly "quiet" strangles opened and unwound five minutes later, trend pyramids re-issued every 15 s, and trail-stop flattens followed by re-entry.

The operator's rules, in their words: trade much less; hedge once in the morning and hold it; never exit the original leg or an adjustment leg before the close; when direction or regime is off, **neutralise by adding** (buy the opposite option, or sell a same-side option) rather than closing; scale by adding lots, starting at 2–4 lots; hard cap of ₹25 lakh margin per book; exit only on the day target (₹10,000 per book), at the close, or when the cap is reached and no adjustment can still help.

## 2. Decisions

- **D1 Replace, don't fork.** The old controller (`decide.ts`, its lean/cut/flip/theta/roll/chop rules, their dials, their tests) is deleted. The operator: "just replace current engine, we wont use this in future". Family name, preset names, registry variant strings, tags and the roll script are unchanged so the 08:50 cron registers tomorrow's four books on the new engine with no script change.
- **D2 Adds only until the close.** No rule closes a leg except the four exits in §6. There is no roll, no stale-leg close, no trail, no per-lean stop, no chop unwind, no flip-by-closing.
- **D3 One hedge, placed at open.** For a trend open it is the sold further-OTM option of the same type (the debit pair's short). For a quiet open it is the strangle's two wings. Nothing removes a hedge before the close, and no later adjustment adds another.
- **D4 The cap is a SPAN-lite margin ceiling**, priced on the whole package with `spanLiteMargin` (`margin-project.ts`), so hedged and cross-side legs get their offset. The dial is the existing `margin_cap`, set to 2,500,000 in both presets.
- **D5 Sideways neutralisation sells at-the-money, not in-the-money.** The operator said "sell in the money ce or something"; ATM (delta 0.45–0.60) keeps the same net-delta effect with more time value and better liquidity. A dial band, so it can be pushed ITM.
- **D6 Day max loss stays as a disaster backstop only**, ₹2,00,000 per book (8 % of the fund), far beyond where the stuck exit fires. Raised to the operator as a question; no objection.
- **D7 Sizing is in contract lots**, not delta-lots. `dl_open_lots` 4 (aggressive) / 2 (conservative).

## 3. State (`RuleState` dl fields, replacing the old set)

| field | meaning |
|---|---|
| `dlDayStarted` | IST date; a new date resets every field below |
| `dlStopped` | terminal for the day: set by any of the four exits once the book is flat, or by the day-loss backstop immediately |
| `dlOpenedMs` | 0 = not opened today |
| `dlOpenSide` | `'up' \| 'down' \| 'none' \| ''` — what the open expressed (`none` = strangle) |
| `dlAdjustsToday` | count of adjustment packages routed |
| `dlLastAdjustMs` | cooldown reference (open counts as the first) |
| `dlLastAdjustRegime` | the regime that justified the last package; the same regime never justifies two packages in a row |
| `dlRegime`, `dlRegimeSinceMs` | the detector's current label and when it last changed (confirmation reference) |
| `dlBlockedSinceMs` | 0, or when an adjustment first became wanted-but-blocked (stuck reference) |
| `dlDayRealized` | realised rupees today, folded by the host's settle (was `dlLeanRealized`) |

Removed: `dlLeanId`, `dlLeanSide`, `dlLeanOpenedMs`, `dlLeanPeak`, `dlLeanPnlAtLastAdd`, `dlLeanAdds`, `dlTargetLots`, `dlFlips*`, `dlLastFlipMs`, `dlLastAddMs`, `dlLastUnwindMs`. `LegView.leanId` stays as an opaque package stamp if the fold path needs it; otherwise it goes too.

## 4. Dials

Kept as-is: `dl_eval_min_ms`, `dl_warmup_min`, `dl_flat_by_min`, `dl_flatten_urgent_min`, `dl_flatten_passive_min`, `dl_day_max_loss` (default → 200000), the regime-detector dials, `dl_long_delta_lo/hi`, `dl_short_delta_lo/hi`, `dl_credit_short_delta_max`, `dl_wing_delta`, `dl_min_strike_gap`, `dl_max_orders_s/min/day` (day → 40), `dl_dead_band_lots` (now in delta-lots of net exposure, default 0.5), `margin_cap` (→ 2,500,000).

New:

| dial | aggressive | conservative | meaning |
|---|---|---|---|
| `dl_open_lots` | 4 | 2 | contract lots per leg at open, and per pyramid add |
| `dl_day_target` | 10000 | 10000 | rupees, realised + unrealised, closes the book |
| `dl_adjust_confirm_s` | 60 | 120 | regime must hold this long before it justifies open or adjustment |
| `dl_adjust_cooldown_s` | 600 | 900 | minimum gap between packages |
| `dl_max_adjusts_day` | 6 | 4 | packages after the open |
| `dl_neutral_short_delta_lo/hi` | 0.45 / 0.60 | same | band for the sideways same-side sell |
| `dl_stuck_loss` | 25000 | 15000 | rupees; with the cap blocking, below this the stuck exit arms |
| `dl_stuck_confirm_s` | 300 | 300 | how long blocked-and-losing must persist |

Removed: every dial only the deleted rules read (`dl_base_unit_lots`, `dl_max_lean_lots`, `dl_add_step_pnl`, `dl_add_cooldown_s`, trail/lean-stop, flip caps and cooldowns, `dl_flip_confirm_s`, theta target/floor, roll deltas, `dl_chop_unwind_s`, `dl_min_hold_s`, `dl_cost_gate_mult`, `dl_gamma_drift_keep`, context dials, `dl_pause_theta_frac`, `dl_wings_on`, `dl_regime_dwell_s`, `dl_leg_stale_s`, …). `resolveDials` must **ignore unknown keys** on a stored registry row (today's rows carry the old keys until the roll erases them) rather than reject the row.

## 5. Decision order, every `dl_eval_min_ms`

0. Day roll.
1. `dlStopped` and legs remain → `closeAll`, urgent. Nothing else.
2. Past `dl_flat_by_min` / in the flatten window → `closeAll` (ladder / urgent as today), trigger `eod`; latch `dlStopped` once flat.
3. `totalPnl <= -dl_day_max_loss` → `closeAll` urgent, latch, trigger `dl-stop`.
4. `totalPnl >= dl_day_target` → `closeAll` ladder, **latch on the flattening tick**, trigger `dl-target`. A mark-based trigger does not survive its own ladder: `totalPnl` is `cumRealized + Σ leg.mtm`, the ladder takes the legs and the mark with them before the host has folded the fills back into `cumRealized`, and a flatten that slipped banks less than the target that fired it. Step 1 carries out any partial fill.
5. Before warm-up, detector not ready, session closed, `repairHold`, or a working package → none.
6. **Not opened** (`dlOpenedMs` 0): regime `trend-up`/`trend-down`/`quiet` held for `dl_adjust_confirm_s` → open (§6.1), trigger `dl-open`. `chop`/`unknown` → wait.
7. **Opened**: an opened book (`dlOpenedMs` non-zero) holding NO LEGS **holds** — "the day's package is gone, nothing to adjust" — before anything below is asked. A ladder filled, a repair took the package off, or the whole open was refused; read as a posture instead, a net delta of zero is a `lean` shortfall of the whole D and the engine buys a NAKED pyramid onto a day that is over. A wait, not a block. Otherwise compute `netLots` = book net delta in delta-lots (Σ delta × side × lots). Derive the wanted posture from the regime (§6.2). If the posture is already met (within `dl_dead_band_lots`) → none, reset `dlBlockedSinceMs`. Else an adjustment is *wanted*: check confirm, cooldown, `dl_max_adjusts_day`, same-regime-twice, and margin (§6.3). If all pass → route it (trigger `dl-neutral` or `dl-add`). If blocked by the cap or the adjust limit → stuck check (§6.4). If blocked only by confirm/cooldown → none.

## 6. Rules

### 6.1 Open
- `trend-up`: `debitUnit` CE — Buy `dl_open_lots` at `dl_long_delta` band, Sell `dl_open_lots` same type at `dl_short_delta` band (the hedge). `dlOpenSide = 'up'`.
- `trend-down`: same with PE, `'down'`.
- `quiet`: `creditUnit` both sides, `dl_open_lots` each: Sell ≤ `dl_credit_short_delta_max`, Buy wing at `dl_wing_delta`. `'none'`.
- Margin-projected like any package; if even one lot does not fit, do not open (and the stuck rule does not apply — there is nothing to lose).

### 6.2 Wanted posture and the add that expresses it
Let `D` = `dl_open_lots × (mid(dl_long_delta band) − mid(dl_short_delta band))` ≈ 4 × 0.35 = 1.4 delta-lots: the net exposure the opened, hedged pair actually carries, so a freshly opened trend book meets its own posture exactly.

The posture depends on the regime **relative to the open's own side** (`dlOpenSide`). Neutralise means *back to zero*, never *reverse*: the book only ever leans in the direction it opened.

| regime vs open | posture | acts when | expression (one leg, adds only) | trigger |
|---|---|---|---|---|
| trend in the **open's own direction** (`up`/`up`, `down`/`down`) | `lean`: `netLots` ≥ +D (or ≤ −D) | short of D by more than `band` | **Buy** the open's option type at the long band, `lots = max(1, round(gap / strikeDelta))` — the pyramid | `dl-add` |
| trend **against** the open (`up` open, `trend-down` regime; and vice versa), or any trend on a strangle book (`none`) | `counter`: `netLots` back to 0, one-sided | the book leans against the regime by more than `band` | **Buy** the regime's option type (PE when trend-down, CE when trend-up) at the long band, lots to close the gap to 0 | `dl-neutral` |
| `quiet` / `chop` | `flat`: `netLots` = 0, two-sided | `|netLots| > band` | **Sell** the same-side option in the `dl_neutral_short_delta` band: Sell CE when net long, Sell PE when net short; lots to bring `netLots` inside the band — but **never at a strike the book holds on the opposite side (an opposite-side fill on a held instrument is netted downstream)**, and no strike in the band means the ordinary wait | `dl-neutral` |

A `counter` posture is one-sided towards zero: a strangle book that has gone net long in a trend-up is *not* asked to do anything, because it is already on the right side. A `lean` posture is one-sided upwards: a book that has run past +D is never sold down.

The sideways sell is the only adjustment that adds margin. The opposite-option buy is what a flip does; it is a debit and always fits.

**No adjustment, in any mode, may select a strike the book holds ON THE OPPOSITE SIDE** — an opposite-side fill on a held instrument is netted downstream into a partial close of that leg, which D2 forbids and which no exit ever decided. It binds both ways and the expensive one is the BUY: the open's hedge is sold at `dl_short_delta` (0.20-0.30) and a day that trends the way the book opened carries it up into the `dl_long_delta` band (0.55-0.65) that `lean` and `counter` both select from, so the pyramid that expresses the trend picks the hedge's own strike and nets away the one leg D3 says is held all day. Same-side is untouched — adding to a leg the book already holds grows it, which is an add. No strike left in the band is the ordinary wait.

### 6.3 Margin gate
Project `spanLiteMargin(bookLegs + package)`; if `> margin_cap`, shrink the package's lots down to the largest that fits (truncation, never rounding up); if 0 lots fit, the adjustment is **blocked**. Buys are projected too (a Buy never raises SPAN-lite, so they always pass).

### 6.4 Stuck exit
An adjustment is wanted but blocked by the cap or by `dl_max_adjusts_day`, **and** `totalPnl <= -dl_stuck_loss`. Start `dlBlockedSinceMs` on the first such tick; if both conditions persist for `dl_stuck_confirm_s` → `closeAll` ladder, latch, trigger `dl-stuck`. Any tick where either condition clears resets the clock. This is "cap reached, no move can still make money, minimise the downside".

### 6.5 Exits, the complete list
`eod` (flatten windows), `dl-stop` (backstop), `dl-target`, `dl-stuck`. A `closeAll` keeps the existing ordering rule: buy back shorts before selling longs.

**All four latch, and three of them latch on the flattening tick** — `dl-stop`, `dl-target` and `dl-stuck`. The test is whether the trigger survives its own flatten, and none of those three does: the backstop's loss is still growing, the stuck condition evaporates with the book, and the target is a MARK the ladder removes with the legs. Left unlatched, each leaves an opened, legless book falling through to §6.2's `lean` gap of the whole D — a fresh unhedged pyramid on a day that was already over. Step 1 carries out any partial fill.

`eod` alone latches once flat, and for its ESCALATION LADDER rather than its trigger: the three windows are passive at 14:50, urgent at 14:55 and blind-ladder past 15:00, and latching on the first tick would hand every residual to step 1's urgent flatten and delete the passive window.

## 7. Triggers
`TRIGGERS` gains `dl-open`, `dl-neutral`, `dl-add`, `dl-target`, `dl-stuck`; keeps `dl-stop`; drops `dl-lean`, `dl-cut`, `dl-flip`, `dl-theta`, `dl-roll`. Engine-host's `DL_CUT_TRIGGERS` becomes `DL_EXIT_TRIGGERS = {dl-target, dl-stuck, dl-stop}` with the same fast path (no `confirm_ms`, cancels a working add, never dropped by the order budget). `#settle` folds realised closes into `dlDayRealized`.

## 8. Expected trade count
Open: 2 orders (trend) or 4 (quiet). Each adjustment: 1 order. Close: one per leg. With `dl_max_adjusts_day` 6 the ceiling is 10 opens + 10 closes ≈ 20 orders per book per day; typical is 6–10. Today: 44–80.

## 9. Fit
- `regime.ts` unchanged. `express.ts`: `debitUnit`, `creditUnit`, `deltaBandStrike`, `tradableStrikes` reused; `leanBestFit`, `rollNeeded`, `shortGammaLoss` deleted if nothing else reads them. `lean.ts`: `rollDay` rewritten for the new fields, `leanPnl`/`canFlip`/`rollFlipHour`/`newLeanId` deleted.
- `apps/supervisor/src/engine-host.ts`: trigger set rename, settle target field, nothing else. `main.ts` pacing unchanged.
- `apps/api`: trigger validation follows `TRIGGERS`; `paper-fold` unchanged (only an `open` creates a leg — still true).
- `apps/web/src/dials-plan.ts`: dial rows replaced.
- `scripts/delta-lean-books.mjs`: headline dial print updated. Roll script unchanged.
- `docs/runbooks/delta-lean-paper.md`: the "what it does" paragraph and the dial table updated; the operational sections stand.

## 10. Tests
Rewrite `packages/desk-engine/test/delta-lean-decide.test.ts` against §5–§6 (one `it` per row of §6.2 and per exit, plus cooldown/confirm/limit/margin-block/stuck-clock cases, plus "nothing ever closes before the close" as a property over a scripted day). Trim `delta-lean-express.test.ts`, `delta-lean-lean.test.ts`, `delta-lean-dials.test.ts`, `delta-lean-stamp.test.ts`, `presets.test.ts`, `dials.test.ts` to the surviving surface. Host: `engine-host-delta-lean.test.ts` for the renamed exit set and settle field. `make check` on the merged tree.

## 11. Out of scope
Going live; the `dl_open_lots` numbers beyond the two presets; per-leg PnL attribution; any change to the recenter engine.
