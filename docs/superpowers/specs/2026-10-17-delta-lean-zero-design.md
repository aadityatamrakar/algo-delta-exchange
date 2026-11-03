# Delta-Lean Zero — the tuned conservative book, and its 0-DTE trend-down sibling

Status: APPROVED by the operator's ask, 2026-10-17 · paper only

Operator, 2026-10-17: "we ran backtest for delta-lean-conservative strategy on
1 year nifty options data, 1min candles, we got a tuned strategy params, spec
it to add a new strategy same as conservative approach, name new variant
delta-lean-zero" — then "do it same for sensex as well", "also add another
0dte variant which only runs on expiry days and if trend-down spread
detected", "same params".

Source of the numbers: the artifact *NIFTY Delta-Lean Backtest* (Optuna study,
5,004 trials, chosen trial **#2615**), built by
`sensibull_tools/scripts/dl_backtest.py`; spec
`sensibull_tools/docs/superpowers/specs/2026-10-17-nifty-delta-lean-backtest-optuna-design.md`;
findings `sensibull_tools/docs/findings/2026-10-17-nifty-delta-lean-bt.md`.
The replay is a Python port of `decideDeltaLean`
(`sensibull_tools/deltalean_bt/engine.py`); where this spec says "the replay"
it means that file.

## Contents

1. [What the two books are](#1-what-the-two-books-are)
2. [What the evidence does and does not say](#2-what-the-evidence-does-and-does-not-say)
3. [Decisions](#3-decisions)
4. [The dial table](#4-the-dial-table)
5. [Engine changes](#5-engine-changes)
6. [Roll and registration](#6-roll-and-registration)
7. [Dashboard and runbook](#7-dashboard-and-runbook)
8. [Live against the replay](#8-live-against-the-replay)
9. [Tests](#9-tests)
10. [Rollout and first-week checks](#10-rollout-and-first-week-checks)
11. [Known gaps](#11-known-gaps)

## 1. What the two books are

**`delta-lean-zero`** is the conservative book carrying trial #2615's dials. In
practice that makes it a far-winged iron condor opened at 09:31 and held to
14:30:

- it may open only between **09:29 and 09:31**;
- a trend-up or trend-down confirmed in that window opens the usual debit
  spread, and a confirmed quiet opens the usual condor;
- **no confirmed regime by 09:31 opens the condor anyway** (the fallback,
  146 of 165 in-sample opens), on any reading except `unknown`;
- the condor sells shorts at |Δ| ≤ 0.24 and buys wings at |Δ| ≤ 0.03;
- **no adjustments**: the book is opened and held;
- **no day target**; the backstop is ₹20,000;
- it starts flattening at **14:30**, 20 minutes earlier than the conservative
  book.

**`delta-lean-zero-0dte`** keeps every dial of `delta-lean-zero` ("same
params") and adds two gates:

- it opens **only on its contract's expiry day**;
- it opens **only on a confirmed trend-down**, which buys the put debit spread.
  No condor, no fallback, no call spread.

Both run on **NIFTY and SENSEX**, paper only, one row per trading day, created
by the 08:50 roll. The 0-DTE book is created only on the morning its symbol's
front contract expires: NIFTY on Tuesdays, SENSEX on Thursdays, holidays
shifting either.

## 2. What the evidence does and does not say

Tuned, at the modelled slippage (2 lots × 65, costs in):

| | Days | P&L | Sharpe | Max DD |
|---|---|---|---|---|
| In-sample, Jul 2025 – Feb 2026 | 165 | +₹1,18,316 | 4.49 | ₹14,105 |
| Holdout, Mar – Jun 2026 | 79 | +₹7,012 | 0.41 | ₹18,566 |
| Holdout, no slippage | 79 | +₹16,829 | 0.99 | ₹16,545 |
| Holdout, 3× slippage | 79 | −₹12,460 | −0.72 | ₹24,804 |

The artifact's own advice (§9) was **not** to move the tuned setting to paper
as it stands, because its holdout edge is smaller than the uncertainty in the
slippage. The operator has chosen to paper it. That is a reasonable way to
measure the real slippage, as long as the book is read with three things in
mind:

1. **Only expiry days paid out of sample.** Holdout expiry days made +₹9,542
   over 18 days; the other 59 days lost −₹2,533.
2. **Half the in-sample profit came from 12 trend-down days** (+₹54,877, all
   winners). The holdout had no trend-down mornings at all, so that half is
   untested.
3. **SENSEX was never replayed.** Its books carry NIFTY's dials. SENSEX and
   NIFTY lots are close in notional (about ₹16 lakh each), so the rupee lines
   mean about the same, but SENSEX's far wings are thinner and quoted wider
   (§11 G2).

**The 0-DTE variant rests on two days.** Split by the replay's own fills, the
12 in-sample trend-down opens include only **2 on an expiry day**
(13 Jan +₹7,679, 20 Jan +₹4,909). The holdout had 18 expiry days and none of
them opened trend-down. At that rate the book trades about once in 17 expiry
mornings per symbol, roughly three times a year each. It is a book for
**collecting real fills on a rare setup**. A month of paper will not say
whether it works. (The split was computed from
`docs/findings/nifty-dl-bt-chosen-*-fills.csv`: a day whose opening fills are
two PE legs is trend-down, and an option whose expiry is the date is 0-DTE.)

## 3. Decisions

**D1. Two presets on the conservative column.** `DELTA_LEAN_ZERO` spreads
`DELTA_LEAN_CONSERVATIVE` and restates only what trial #2615 moved. A dial the
study left alone, or found inert, is inherited, so the zero book cannot drift
from the conservative one on a dial nobody re-measured. The 0-DTE preset
spreads `DELTA_LEAN_ZERO` and adds its gates.

**D2. Both symbols, one table.** NIFTY and SENSEX get the same dials, as every
delta-lean pair always has. SENSEX's lack of a replay is stated (§2), not
tuned around.

**D3. The daily family, not a fourth one.** Both presets join
`PRESET_KEYS` in `scripts/delta-lean-books.mjs`, beside aggressive and
conservative. They live one trading day, are tagged
`<SYMBOL>-<preset>-<date>`, are retired the morning after, and are covered by
every rule the daily books already obey: paper only, the switch-on PATCH, and
the "covered" check before a retire. The family the roll's comments call "the
four" is now "the daily books": six every morning, seven on a symbol's
expiry morning.

**D4. Six new dials and one change of meaning, all inert at their defaults.**
Every new dial defaults to today's behaviour, so no existing row moves:

| Dial | Default | Meaning |
|---|---|---|
| `dl_open_by_min` | 0 (off) | The last minute of the day, inclusive, in which the day's package may open. After it, a book that has not opened stands down for the day. 0 = no limit. |
| `dl_open_fallback` | false | In `dl_open_by_min`'s minute, with no confirmed regime that opens, open the quiet package anyway on any reading except `unknown`. Inert while `dl_open_by_min` is 0 or `dl_open_quiet` is off. |
| `dl_open_trend_up` | true | A confirmed trend-up may open the call debit spread. |
| `dl_open_trend_down` | true | A confirmed trend-down may open the put debit spread. |
| `dl_open_quiet` | true | A confirmed quiet may open the condor, and so may the fallback. |
| `dl_expiry_day_only` | false | The book opens only when today is its contract's expiry (`dateIst === expiry`). |
| `dl_day_target` | 10,000 | **0 now means off**, on both delta-lean paths (`decideDeltaLean` and the playbook frame's day line). No preset or row sets it to 0 today, so nothing moves. |

All six gate **the open only**. Exits, the clock, the backstop and the
latched stop never read them. Adjustments (§6.2) are untouched; on the zero
books they are off anyway (`dl_max_adjusts_day: 0`).

The fallback needs `dl_open_quiet` because it opens the quiet package. An
operator who switches quiet off to stop condors stops every condor.

**D5. The window and the fallback follow the replay, at second resolution.**
The replay opens on the first minute in `[entry_start, entry_end]` with a
confirmed trend or quiet. At `entry_end`, with nothing confirmed and a reading
other than `unknown`, it opens the quiet package. If a confirmed trend's
spread cannot form at `entry_end`, the condor is tried instead. Live does the
same with `dl_warmup_min` as the start and `dl_open_by_min` as the end:

- from 09:29:00 on, a confirmed regime that opens is opened at once;
- on every pass inside 09:31:00–09:31:59, with no package yet, the fallback
  is tried: confirmed and openable first, then the quiet package;
- from 09:32:00 on, nothing opens that day.

A pass that waits inside 09:31 (an order in flight, a stale index, `unknown`)
tries again on the next pass in that minute. The replay had one try per
minute, so live is slightly more forgiving here.

**D6. The stuck rule is pinned out by its level.** The replay has no stuck
rule ("it cannot fire on this preset"). Live, with `dl_max_adjusts_day: 0`,
every wanted adjustment is BLOCKED by the day limit, so §6.4's clock arms on
any tick the book is past `dl_stuck_loss`. Setting `dl_stuck_loss` equal to
`dl_day_max_loss` (₹20,000) makes the backstop (step 3) fire on the same tick
the stuck floor is crossed, ahead of step 8. So the stuck exit can never fire,
which is what the replay assumed.

**D7. Rounded to what the artifact prints.** Trial #2615 is stored at full
precision (`trend_mult` 1.9354…, `condor_short_max` 0.2375…). The presets
carry the two-decimal values shown in the artifact's §4. The plateau check
nudged every numeric dial by ±10% and kept 84% of the score, so rounding moves
nothing that matters, and an operator can check two decimals against the page.

**D8. Clock: a 14:30 ladder, five minutes a rung.** The replay closes at one
fill at 14:30 (`flatten_time`), the ladder collapsed. Live keeps the
conservative book's three-rung shape, moved 20 minutes earlier: passive
14:30, urgent 14:35, flat by 14:40.

**D9. The old-build fail-safe is the day target.** The 08:50 roll runs from
the repository, so it can register a zero row before the operator has
restarted desk-api and desk-supervisor onto this build. A supervisor that does
not know the new dials drops them as unknown, but it still reads
`dl_day_target: 0` with the OLD meaning: `0 >= 0` on the first pass of a flat
book. The target fires, latches the day, and the book places nothing. A zero
row on an old build is therefore inert rather than an all-day opener with no
window and no regime switches. **Never set `dl_day_target` to anything but 0
on these presets** without re-checking this.

## 4. The dial table

`—` = inherited from the column to its left.

| Dial | Conservative | Trial #2615 | `delta-lean-zero` | `-0dte` |
|---|---|---|---|---|
| `dl_trend_mult` | 2.0 | 1.935 | **1.94** | — |
| `dl_trend_exit_mult` | 1.2 | 1.262 | **1.26** | — |
| `dl_clean_min` | 0.6 | 0.615 | **0.62** | — |
| `dl_quiet_mult` | 0.7 | 1.172 | **1.17** | — |
| `dl_adjust_confirm_s` | 120 | 3 min | **180** | — |
| `dl_regime_dwell_s` | 120 | 2 min | — | — |
| `dl_slow_window_s` | 300 | W = 5 min | — | — |
| `dl_warmup_min` | 570 (09:30) | 09:29 | **569** | — |
| `dl_open_by_min` | 0 (none) | 09:31 | **571** | — |
| `dl_open_fallback` | false | condor | **true** | **false** |
| `dl_open_trend_up` | true | | — | **false** |
| `dl_open_trend_down` | true | | — | — |
| `dl_open_quiet` | true | | — | **false** |
| `dl_expiry_day_only` | false | | — | **true** |
| `dl_day_target` | 10,000 | off | **0** | — |
| `dl_day_max_loss` | 15,000 | 20,000 | **20,000** | — |
| `dl_stuck_loss` | 15,000 | (none) | **20,000** (D6) | — |
| trailing lock | (none) | 7,000 / 37%, never fired | not ported (inert) | — |
| `dl_flatten_passive_min` | 890 (14:50) | 14:30 | **870** | — |
| `dl_flatten_urgent_min` | 895 | | **875** | — |
| `dl_flat_by_min` | 900 | | **880** | — |
| `dl_long_delta_lo / hi` | 0.55 / 0.65 | centre 0.679 | **0.63 / 0.73** | — |
| `dl_short_delta_lo / hi` | 0.20 / 0.30 | centre 0.35 | **0.30 / 0.40** | — |
| `dl_credit_short_delta_max` | 0.30 | 0.237 | **0.24** | — |
| `dl_wing_delta` | 0.10 | 0.03 | **0.03** | — |
| `dl_neutral_short_delta_*` | 0.45 / 0.60 | inert | — | — |
| `dl_max_adjusts_day` | 4 | 0 | **0** | — |
| `dl_adjust_cooldown_s`, `dl_dead_band_lots` | 900, 0.5 | inert | — | — |
| `dl_open_lots` | 2 | 2 | — | — |
| `margin_cap` | ₹25,00,000 | | — | — |
| expiry day | traded | traded | — | the only day |

The desk day guard arms at `guardStopFor(20,000)` = **₹30,000** on both books
(`apps/api/src/routes/books.ts`), against ₹23,000 on the conservative book.

## 5. Engine changes

### 5.1 `dials.ts`

The six dials join the DELTA LEAN block under a new comment group, "The open
(§6.1)", after the budget group. Their defaults are in D4. `DIAL_SECTIONS`'
delta-lean fields gain them in the same place (41 → 47 fields).
`dl_day_target`'s doc says "0 = off".

### 5.2 `decideDeltaLean`, step 4

```ts
if (dials.dl_day_target > 0 && pnl >= dials.dl_day_target) { …unchanged… }
```

The header's step-4 paragraph adds one line: 0 is off.

### 5.3 `decideDeltaLean`, step 6

Before (in words): chop or unknown waits; an unconfirmed reading waits; then
`openPackage(read.slow)`.

After, still only while `dlOpenedMs === 0`:

```ts
// 6a. the day: a book that opens only on its contract's expiry day
if (dials.dl_expiry_day_only && dateIst !== inputs.expiry) → wait
// 6b. the window: past dl_open_by_min, nothing opens today
if (dials.dl_open_by_min > 0 && minuteOfDay > dials.dl_open_by_min) → wait
// 6c. what may open
const wanted = opensOn(read.slow, dials)            // trend-up/down/quiet AND its switch
const ready = wanted && confirmed(st, dials, nowMs)
const lastMinute = fallbackMinute(inputs, dials, read.slow)
                   // dl_open_fallback && dl_open_quiet && dl_open_by_min > 0
                   // && minuteOfDay === dl_open_by_min && read.slow !== 'unknown'
if (!ready && !lastMinute) {
  chop | unknown → the existing "nothing to express" wait
  !wanted        → wait "<regime>: this book does not open on <regime> (<dial> is off)"
  else           → the existing confirm-window wait
}
let pkg = ready ? openPackage(inputs, dials, read.slow) : null
let fellBack = false
if (pkg === null && lastMinute) { pkg = openPackage(inputs, dials, 'quiet'); fellBack = true }
if (pkg === null) → the existing "does not fit / bands not on this chain" wait
…the existing pace check, state stamp and `dl-open` action; a fallback's
reason names it: "chop at 09:31, the open window's last minute — opening the
quiet package anyway, …"
```

At the defaults (`dl_open_by_min` 0, every switch on, `dl_expiry_day_only`
false) 6a and 6b never fire, `lastMinute` is false, `wanted` equals "trend or
quiet", and the branch is the one that ships today, word for word.

The open's state stamp is unchanged. `dlLastAdjustRegime` is still
`read.slow`, so a fallback condor opened on chop records `chop`. On the zero
books it is never read, because there are no adjustments.

### 5.4 The playbook frame's day line

`playbook/decide.ts` `dayLines`: `above = dials.dl_day_target > 0 && pnl >=
dials.dl_day_target`. Every playbook preset sets a positive target, so nothing
moves. The point is that the dial means one thing on both paths.

### 5.5 `presets.ts`

```ts
const DELTA_LEAN_ZERO: Partial<Dials> = { ...DELTA_LEAN_CONSERVATIVE, /* §4's column */ }
{ key: 'delta-lean-zero',      label: 'Delta lean — zero (25L)',               dials: DELTA_LEAN_ZERO }
{ key: 'delta-lean-zero-0dte', label: 'Delta lean — zero, 0-DTE trend-down (25L)',
  dials: { ...DELTA_LEAN_ZERO, dl_expiry_day_only: true, dl_open_trend_up: false,
           dl_open_quiet: false, dl_open_fallback: false } }
```

The 0-DTE preset states `dl_open_fallback: false` out loud even though
`dl_open_quiet: false` already makes it inert. A row showing "fallback on"
beside "quiet off" would read as a condor book to anyone scanning it.

## 6. Roll and registration

`scripts/delta-lean-books.mjs`:

- `PRESET_KEYS` gains `delta-lean-zero` and `delta-lean-zero-0dte`.
- `planBooks(expiries, tradingDay)` skips a preset whose resolved dials carry
  `dl_expiry_day_only: true` for a symbol whose expiry is not `tradingDay`.
  The rule reads the DIAL, never the key, like `isHold` and `isPlaybook`.
- The header's "TODAY'S FOUR" becomes the daily books, with one paragraph on
  the zero pair and the 0-DTE book.

`scripts/delta-lean-roll.mjs` needs no logic change. Its daily-family loop is
over `planBooks`' targets and `byVariant` reads `PRESET_KEYS`. A 0-DTE row
from an expiry morning is, the next morning, one more daily row "not one of
today's books", stopped and erased like any other. Its header gains the same
naming note.

Tests that pin "four" daily books (`apps/api/test/delta-lean-registration.test.ts`,
`apps/api/test/delta-lean-roll.test.ts`) move to the new counts. Each count
comes from the fixture's own day: six on a non-expiry day, plus one per symbol
whose expiry is that day.

## 7. Dashboard and runbook

- `apps/web/src/dials-plan.ts`: meta for the six dials. `dl_open_by_min` is a
  `clock` with `zeroOff`, the four switches and `dl_expiry_day_only` are
  `plain`, and `dl_day_target` gains `zeroOff` and "0 = off". A new group,
  "The open", goes between "Budget and the four exits" and "Adjustment
  gating", so the groups read back in `DIAL_SECTIONS` order. The 41-dial
  counts in comments and in `apps/web/test/dials-panel.test.tsx` become 47,
  with seven group headings.
- `docs/runbooks/delta-lean-paper.md`: the `DEFAULT_DIALS` count (140 → 146),
  and a new section for the zero books with the checks in §10.

## 8. Live against the replay

| Live | Replay | Effect |
|---|---|---|
| Index ticks about once a second, three windows | 1-minute future bars, one window | The slow-window label and two-window quiet match. The context window does not gate the open (`agrees` is unread by `decideDeltaLean`). |
| Confirmation and dwell in seconds (180 s, 120 s) | Whole minutes (3, 2) | A label stamped mid-minute confirms up to 59 s earlier or later. |
| The fallback is tried on every pass in 09:31:00–09:31:59 | Once, at the 09:31 bar's close | Live decides up to a minute earlier, and retries within the minute. |
| A strike is tradable only if its CE **and** PE are quoted and tight | Per option, bar ≤ 2 min old | A 0.03-delta wing whose deep ITM partner is quoted wide fails live, and the condor does not form (G2). |
| Fills worked at the touch (3 s chase), then one bounded cross | Next minute's close ± max(₹0.10, 0.25%) | This is what the paper run measures. The 3× row in §2 is the downside. |
| Lot 65 NIFTY, 20 SENSEX | Lot 65 throughout | Same. SENSEX was not replayed. |
| The stuck rule exists | Not ported | Pinned out by D6. |
| A 14:30 / 14:35 / 14:40 ladder | One fill at 14:30 | Live may hold up to ten minutes longer on a bad book. |

## 9. Tests

Engine (`packages/desk-engine/test/delta-lean-decide.test.ts`, a new section):

1. Defaults: a confirmed trend at 10:00 still opens. `dl_open_by_min` 0 is no
   window.
2. Window closed: `dl_open_by_min: 571` and a confirmed trend at 09:32 waits
   with "open window"; at 09:31 it opens.
3. Fallback: chop at 09:31 with fallback on opens four legs (both credit
   units), `dlOpenSide: 'none'`, and the reason names the fallback. At 09:30 it
   waits. With fallback off, it waits.
4. The fallback never sells into `unknown` (the dead feed at 09:31).
5. The fallback needs `dl_open_quiet`.
6. Regime switches: with `dl_open_trend_up: false` a confirmed trend-up waits
   and says why, and trend-down still opens. With `dl_open_quiet: false` a
   confirmed quiet waits.
7. Expiry-day-only: off its expiry date the book waits and opens nothing. On
   it, a confirmed trend-down opens the put spread.
8. The 0-DTE preset, resolved: a confirmed trend-down on expiry day opens two
   PE legs; trend-up, quiet and chop at 09:31 open nothing.
9. The zero preset, resolved: chop at 09:31 opens the condor at |Δ| ≤ 0.24 /
   ≤ 0.03; a positive mark never fires a target; the stuck exit cannot fire
   ahead of the backstop (D6).
10. `dl_day_target: 0` is off on both paths (the playbook frame too).

Presets (`presets.test.ts`): both presets pin §4's columns, and inherit the
conservative column for every dial §4 marks "—".

Dials (`dials.test.ts`): the six defaults and their section placement.

Roll (`apps/api/test/delta-lean-registration.test.ts`): `planBooks` plans the
0-DTE book only for a symbol whose expiry is the trading day; it reads the
dial, not the key; the zero pair is planned every day on both symbols; every
book is paper.

## 10. Rollout and first-week checks

1. Merge, push, build the dashboard. The restart is the operator's:
   desk-api and desk-supervisor together onto the new build (nothing in
   desk-marketdata or desk-gateway changed), never desk-runner, and only while
   the intraday books are flat (after 15:00, before 09:15 IST). Until then D9
   keeps a zero row registered by the roll inert.
2. The next 08:50 roll creates `NIFTY-delta-lean-zero-<date>` and
   `SENSEX-delta-lean-zero-<date>` every trading day, plus
   `<SYMBOL>-delta-lean-zero-0dte-<date>` on that symbol's expiry morning.
   Check the switches, not just the rows (memory: a purged book comes back
   switched off):

   ```js
   db["desk-strategies"].find({tag:/delta-lean-zero/},{tag:1,modes:1,dailyLimits:1,_id:0})
   ```

3. 09:29–09:32 on the first session: one `dl-open` per zero book, or one
   "open window closed" wait. Count the fallback opens:

   ```js
   db["desk-engine-decisions"].find({tag:/delta-lean-zero/, trigger:"dl-open"},{tag:1,reason:1,ts:1,_id:0}).sort({ts:-1})
   ```

4. Did the condor form? A "bands are not on this chain" wait at 09:31 on
   SENSEX means the 0.03 wing failed the liquidity row rule (G2).
5. After a week: entry fills against the replay's model price (the opening
   mid ± max(₹0.10, 0.25%)). The replay's edge is smaller than its slippage
   band (§2), so this number, not the P&L, is what the paper run is for.

## 11. Known gaps

- **G1. The trend-down half is untested out of sample.** No holdout morning
  opened trend-down, and the 0-DTE book is built from two in-sample days (§2).
- **G2. SENSEX's far wing.** At |Δ| ≤ 0.03, a SENSEX wing sits far out, where
  the six-playbooks review saw ₹20–40 options quoted ₹1–3 wide. The
  delta-lean liquidity bar (max(2% × mid, ₹1), CE and PE both) may refuse the
  wing's strike, and then no condor forms and the book does not open that day.
  If §10 check 4 shows this, the fix is a wing-specific spread bar like
  `pb_wing_spread_abs`. That is a separate change, not taken here.
- **G3. The trailing lock is not ported.** It never fired in the chosen
  setting (every tuned day closed on the clock), so leaving it out changes no
  replayed day.
- **G4. One year, one market, 5,004 settings searched on 165 days.** Part of
  the in-sample Sharpe is selection bias. Re-tune when more 1-minute history
  is in the lake, and once the paper fills can calibrate slippage.
