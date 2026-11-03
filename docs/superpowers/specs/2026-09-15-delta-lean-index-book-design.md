# Delta-Lean Index Book — Design Spec

> **SUPERSEDED, 2026-09-22.** §6-§9 (the decide loop, its lean/cut/flip/theta/roll
> rules, their dials and their tests) are replaced by
> `2026-09-22-delta-lean-hold-adjust-design.md`. What still stands: the registry
> shape, the four paper books, the daily roll (§10 and the runbook), and the
> regime detector (§5).

**Date:** 2026-09-15 (Tuesday)
**Status:** Approved design. Implementation plan next.
**Scope:** A new desk-engine book variant for NIFTY (NSE) and SENSEX (BSE)
weekly options that makes money from delta (price movement) while holding
theta near zero and leaving vega unmanaged. Intraday only, always flat by the
close. Design and logic only; no implementation in this document.

---

## 1. What this is

Today's desk-engine books are short-premium corridor managers: they hold a
short option structure and shed delta when it drifts outside a gamma-scaled
band. The recenter family is one point in greeks space (short gamma, positive
theta, delta near zero) and it stays there.

The delta-lean book is a **regime controller** that moves the book around a
two-axis greeks space every second:

- **Delta**: which side and how much, driven by the current lean's PnL.
- **Gamma versus theta**: long gamma when the index is trending, short gamma
  when it is quiet, flat when it is choppy.

The three familiar intraday option strategies are fixed points in that space.
Selling a strangle is short gamma, positive theta, zero delta. Selling one
side on trend is directional delta with positive theta. Buying one side on
trend is directional delta with long gamma. This book moves between them
instead of committing at entry, purely from price, position and greeks. No
indicators.

## 2. Decisions (operator-approved in the design session)

| # | Decision |
|---|---|
| D1 | **Seconds cadence.** A decision loop every 1 s on live ticks, orders through the broker API. Not tick-by-tick quoting, not minute bars. Stays inside the retail algo framework's 10 orders/s threshold. |
| D2 | **Options only, buy and sell.** No index futures, no synthetic futures. Delta is expressed as a mix of long and short option legs; theta is tuned by the mix. |
| D3 | **Two-level PnL.** The current lean's PnL since it opened, measured as drawdown from its own peak, drives add, cut and flip. The day's cumulative book PnL only sets the risk budget. |
| D4 | **Always flat, done by 15:00.** Every position is closed by 15:00. No carry, no expiry-day settlement exposure, no overnight margin. |
| D5 | **Aggressive, high-risk preset is the default** at 25 lakh capital, 9 delta-lots max lean. A conservative preset is recorded as a second dial set. |
| D6 | **Expiry day is not special.** Zero-day options are traded with the same parameters as every other day. |
| D7 | **Theta floor is soft, short-gamma cap is hard.** The controller works toward the theta floor by selling far-side credit units, but stops at the short-gamma cap. It never refuses a trend unit because of theta. |
| D8 | **Greeks target controller architecture** (Approach A). Four small units: regime detector, delta controller, expression layer, execution. Rejected: a three-strategy switcher (lumpy transitions, full round trip per switch) and a permanent long straddle with a delta hedger (pays theta every day). |
| D9 | **A 15-minute context window** modulates pyramiding, flips, strangle sizing and chop unwind speed; it does not classify on its own. **Trading starts at 09:30** so every window has a full reading first. |
| D10 | **Delivery ends in paper.** The implementation's last step registers four paper books (NIFTY and SENSEX, each with the aggressive and the conservative preset). Live enablement is a later, separate decision. |
| D11 | **Auto-start every trading day.** A book is a persistent registry row. At 09:15 on each trading day it clears `stopped` and lean state itself and begins warm-up; no operator action, no restart. |

## 3. Market facts the design rests on (as of 2026-09-15)

Researched this session; re-verify circular numbers against the exchanges
before implementation.

- **CAS does not touch index options.** The Closing Auction Session (live
  since 2026-08-03) applies to the cash segment for F&O-eligible stocks only,
  15:15 to 15:35. Index option trading continues, and F&O hours were extended
  to **09:15 to 15:40**. Weekly index option settlement remains the
  **last-30-minute index VWAP**; a SEBI consultation on a blended CAS/VWAP
  method is open until 2026-10-03 and is not in force.
- **Weekly expiries:** NIFTY Tuesday (NSE), SENSEX Thursday (BSE). BANKNIFTY
  is monthly only. One weekly benchmark expiry per exchange.
- **Lots:** NIFTY 65, SENSEX 20. NIFTY strike step 50, SENSEX 100. Tick 0.05.
- **Freeze quantity:** NIFTY 1,800 units (27 lots) since 2026-09-01. SENSEX
  freeze not confirmed; must come from the exchange file via `make sync`.
- **Costs:** option sell-side STT 0.1 percent of premium. Full premium upfront
  for buys. Expiry-day ELM +2 percent on shorts and no calendar-spread margin
  benefit on expiry day; both irrelevant to an always-flat intraday book.
- **Rate limits:** retail algo threshold 10 orders/s per segment; broker
  limits are tighter per minute and per day. OTR penalty excludes orders
  within 40 percent of LTP since 2026-04-06.
- **Position limits:** intraday FutEq monitoring since 2025-10-01 with a
  mandatory snapshot between 14:45 and 15:30. Irrelevant at this book's size
  (caps are in thousands of crore).

## 4. State model

A book is one underlying and one expiry, as today. Expiry is the nearest
weekly. On expiry day the book trades the zero-day contract (D6).

Each loop reads three groups of state.

**Measured** (from the existing greeks stack, every loop):

- Net delta in **delta-lots**: index-point exposure divided by one lot's
  exposure, so 1.0 equals one future.
- Net gamma, net theta in rupees per day, net vega.
- Per leg: delta, gamma, theta, IV, two-sided quote, spread, quote age,
  `hasGreeks`.

**Lean** (the controller's own state, persisted every mark):

- Side: up, down, or none. A quiet-regime strangle is a lean with side none.
- Target delta in delta-lots.
- Lean id, stamped on every leg the lean created.
- PnL since open (realized from its own closes plus MTM of its open legs),
  peak PnL, drawdown from peak, PnL at the last add.
- Adds count, flips this hour and today, time opened, time of last flip.

**Budget**:

- Capital, day PnL, remaining daily loss budget.
- Max lean, base unit.
- `stopped` flag, terminal for the day once set.

## 5. Regime detector

Compares what the index actually did over a window to what the options were
pricing for that window. Inputs: index spot ticks, the ATM straddle mid the
book already marks, and time.

**Implied move for a window.** The ATM straddle price approximates the
expected absolute move to expiry. Scale to a window of length W by
sqrt(W / trading minutes remaining). Example: straddle 200 points, 1,125
trading minutes left, W = 5 min gives about 13 points.

**Realized move over the same window.** Two numbers: net displacement
(end minus start) and path range (high minus low). Displacement over range is
the cleanliness of the move, 0 to 1.

**Classification**:

| Regime | Rule |
|---|---|
| Trend | |displacement| > `trend_mult` x implied and cleanliness > `clean_min`. Direction is the sign of displacement. |
| Quiet | range < `quiet_mult` x implied for two consecutive windows. |
| Chop | Everything else: large range, small displacement. |

**Three windows** run at once. Fast (`fast_window_s`, default 60) gives
direction. Slow (`slow_window_s`, default 300) gives regime. Context
(`context_window_s`, default 900, `context_on` default on) does not
classify; it modulates size and flips (section 6, "Context window").

**Hysteresis is asymmetric.** Quiet to trend is immediate, because that is
the breakout to catch. Leaving trend requires the ratio to fall through
`trend_exit_mult` (below `trend_mult`) and a minimum dwell
(`regime_dwell_s`). Warm-up (before 09:30) runs the detector but places no
orders, so the slow and context windows have a full reading before the first
order.

All multipliers, windows and dwell are dials.

## 6. Delta controller loop (every 1 s per book)

1. **Mark.** Mark legs, aggregate greeks, update lean PnL, peak and drawdown.
2. **Hard guards**, evaluated first, never damped:
   - Daily max loss reached: flatten, set `stopped`.
   - Past `no_new_units_min`: refuse new units; fine-tunes and cuts only.
   - Past `flatten_passive_min`: flatten passively. Past `flatten_urgent_min`:
     flatten urgently. Past `flat_by_min`: any residual goes to the blind
     ladder.
   - Spot stale > `spot_stale_s`: refuse adds.
   - Short leg quote stale > `leg_stale_s` while spot moved more than the
     implied window move: close that leg urgently; hold long legs.
   - Shutdown signal: flatten.
3. **Update regime** (section 5).
4. **Set targets** from regime and lean PnL:
   - **Trend.** No lean: open one base unit on the trend side. Lean exists on
     the trend side: add one unit each time lean PnL makes a new peak that
     exceeds PnL-at-last-add by `add_step`, up to `max_lean`. Drawdown from
     peak exceeds `cut_frac` of peak profit (floored at `cut_floor`): cut one
     unit. Lean PnL below minus `lean_max_loss`: cut to zero. After a cut to
     zero, if fast direction is opposite and regime is still trend: open a
     base unit the other way, subject to `flip_cooldown_s`, `max_flips_hour`,
     `max_flips_day`.
   - **Quiet.** Target delta 0, gamma mode short. One credit unit each side
     sized to `theta_target`, trailed on its own peak PnL with the same
     `cut_frac` rule.
   - **Chop.** Target delta 0, gamma mode flat. No new risk. Unwind existing
     legs one unit per loop (slower if the context window says quiet),
     short-gamma legs first.
5. **Theta constraint (soft, D7).** Compute theta of the target book. If below
   `theta_floor` x |target delta|, add far-side credit units (opposite the
   lean) until it clears, bounded by the short-gamma cap and margin. If the
   cap binds first, proceed with theta below the floor.
6. **Diff** current versus target greeks into open, close and resize actions
   in lots (section 7).
7. **Damp.** Adds need at least one unit of change and respect
   `add_cooldown_s` (15). Cuts are never damped. Orders per book are budgeted
   at `max_orders_s` (2) and `max_orders_min` (40).

**Context window (15 min).** The context window's own trend, quiet or chop
reading, computed with the same rules as the slow window, has four roles:

- **Pyramiding gate.** Full `max_lean` only when the context direction agrees
  with the slow direction. On disagreement the lean is capped at
  `max_lean` x `context_disagree_cap` (0.5). Adding into a 5-minute burst
  that is a pullback inside a 15-minute move is the main whipsaw loss.
- **Flip filter.** Slow says trend reversed but context still says trend the
  original way: cut as normal, but do not open the opposite lean until the
  context agrees, or fast and slow both confirm for `flip_confirm_s` (60).
- **Strangle sizing.** Quiet on slow and context: full `theta_target` both
  sides. Quiet on slow, trend on context: a pause in a trend; sell only the
  side against the context trend at `theta_target` x `pause_theta_frac`
  (0.5).
- **Chop confirmation.** Chop on slow, quiet on context: a shake inside a
  range; unwind one unit every `chop_slow_unwind_s` (30) instead of every
  loop.

With `context_on` off, all four roles are inert and the two-window rules
apply unchanged.

**Gamma drift.** A long call gains delta as spot runs, so the book leans harder
in the trend with no order. Aggressive preset: keep the drift, capped only by
`max_lean`. Conservative preset: trim it back to target.

**Rolls.** Long leg delta above `roll_long_delta` (0.80): sell it, buy ATM.
Same delta, profit banked, gamma restored. Short leg delta above
`roll_short_delta` (0.45), meaning spot ran into it: close it; re-sell further
out only if the regime still calls for it.

## 7. Sizing and strike selection

**Units.** Two structures, chosen by delta band rather than strike offset,
because the same strike is a different delta on Monday and on expiry eve.
Both clamp to a minimum strike distance so a band never lands on ATM by
accident.

| Unit | Legs | Net effect |
|---|---|---|
| Debit (trend) | Buy at delta 0.55 to 0.65 (ATM or one strike ITM). Sell same side 2 to 3 strikes OTM at delta 0.20 to 0.30. | About +0.35 delta per pair, theta near zero, long gamma at spot, bounded risk. |
| Credit (quiet, theta offset) | Sell at least 1 strike OTM, further if delta > 0.30. Buy a wing 3 to 4 strikes beyond at delta about 0.10 (`wings_on`, default on). | Positive theta, short gamma, bounded if wings on. |

One base unit of delta is expressed as however many debit pairs reach it.

**Liquidity filter** on every candidate: two-sided quote, quote age under
`quote_fresh_s` (3), spread at most `max_spread_pct` (2) of mid or
`max_spread_abs` (1 rupee), whichever is larger. Fails: not a candidate.

**Quantisation and best fit.** Excess = target delta minus current delta.

- |excess| < dead band: no order. Dead band is
  max(`dead_band_lots` (0.25), gamma-scaled corridor as in the recenter
  engine).
- 0.25 to 0.5: fine-tune with a single leg.
- Above 0.5: add or remove a whole unit, then fine-tune any remainder on the
  next loop.

For every candidate action (open a new leg at a strike in the scan, or close
lots of an existing leg) compute lots = round(excess / per-lot delta) and the
residual. Keep the smallest residual. Ties break on theta impact toward the
floor, then spread cost. The book never waits for a full ATM lot; a 0.35
excess is met by one lot of a 0.35-delta option.

Example, leaning up, target 1.5, current 1.15, excess +0.35:
buy one lot of a 0.35-delta call (residual 0, adds a little negative theta,
keeps gamma long) or sell one lot of a 0.35-delta put (residual 0, adds
positive theta, adds short gamma below spot). Theta at or below floor: sell
the put. Theta has room: buy the call. Buying one ATM lot at 0.55 loses on
residual.

**Reduction preference.** Chop: close short-gamma legs first. Quiet: close
long-gamma legs first. Trend: closest delta fit, structure left intact.

**Cost gate.** A fine-tune is skipped unless the delta it removes is worth at
least `cost_gate_mult` (3) round trips over the implied move of the next
window. One NIFTY lot at a one-rupee spread plus charges is roughly 150 to
200 rupees per round trip.

## 8. Expression and execution

- **Leg ordering never leaves the book naked.** Open a debit unit: buy the
  long, then sell the short. Open a credit unit: buy the wing, then sell the
  short. Close: buy back the short first, then sell the long or wing.
- **Urgency classes** onto the existing chaser: adds run passive peg with
  `chase_max_ms` (aggressive 1,500, conservative 3,000) then one bounded
  cross; cuts run urgent, crossing immediately with a worst-price bound;
  guard flattens run the blind ladder.
- **Cuts pre-empt adds.** A working add tranche is cancelled before a cut is
  placed. Otherwise one working package per book. Targets are computed
  against filled plus working lots.
- **Idempotency and journalling** through the existing decisions endpoint and
  `decisionId` unique index. Every decision records regime, fast and slow
  ratios, targets, lean state, and greeks before and after.
- **Order budget** per book: 2 per second, 40 per minute, `max_orders_day`.
  Freeze splitting applies.
- **Forward without a future quote.** When the near-month future is one-sided,
  forward = spot x carry so the book keeps evaluating.
- **Paper mode first** via the existing `mode` flag. Paper fills at the touch
  plus one tick of slippage.

## 9. Risk and day lifecycle

### Tunables

| Tunable | Aggressive (default) | Conservative |
|---|---|---|
| Capital per book | 25 lakh | 10 lakh |
| Daily max loss, terminal | 1 lakh | 15,000 |
| Per-lean max loss | 37,500 | 5,000 |
| Base unit | 1 delta-lot | 0.5 delta-lots |
| Max lean | 9 delta-lots | 3 delta-lots |
| Add step, new peak over last add | 2,500 | 1,500 |
| Cut trigger, drawdown from peak | 50 percent, floor 2,500 | 35 percent, floor 1,000 |
| Flip cooldown, max flips | 30 s, 8 per hour, 24 per day | 60 s, 4 per hour, 12 per day |
| Theta floor (soft) | minus 600 per delta-lot per day | minus 300 |
| Short-gamma cap (hard) | loss on a 1 percent move under per-lean max loss | same rule |
| Gamma drift in trend | kept, capped at max lean | trimmed to target |
| Expiry day | same as every day | same as every day |
| Warm-up ends | 09:30 | 09:30 |
| Context window | 15 min, on | 15 min, on |
| No new units after | 14:40 | 14:40 |
| Flatten passive, urgent, flat by | 14:50, 14:55, 15:00 | same |
| Add chase | 1,500 ms | 3,000 ms |
| Margin guard | adds refused above 70 percent of available | same |

**Short-gamma cap** is the greeks-consistent "how many strangles is too
many": 0.5 x net gamma x (1 percent of spot)^2 must stay under the per-lean
max loss.

**Money terms at the default.** Nine delta-lots of NIFTY is about 1.45 crore
of index exposure, so a 1 percent move against a full lean costs about
1.45 lakh; the 1 lakh daily stop fires on roughly a 0.7 percent adverse move
at full size. The 50 percent cut trigger lets a lean that made 20,000 give
back 10,000 before its first cut.

**Margin at full lean:** roughly 25 debit pairs plus up to 9 short credit lots
sits near 13 to 15 lakh, inside 25 lakh with headroom for intraday SPAN
changes.

### Day timeline

- 09:15 to 09:30: warm-up. Mark, run the detector on all three windows, no
  orders.
- Warm-up end to no-new-units: full operation.
- 14:40 to 14:50: fine-tunes and cuts only.
- 14:50 passive flatten. 14:55 urgent flatten. 15:00 must be flat; residual to
  the blind ladder. Trading runs to 15:40, so there is a 40-minute buffer and
  the book is out before the 15:15 CAS start in the cash segment.
- After 15:00 the book is idle. At 09:15 the next trading day it clears
  `stopped`, lean state and day PnL, and starts warm-up on its own (D11).
- Shutdown signal (SIGTERM): flatten. This differs from the recenter
  supervisor, whose SIGTERM is deliberately inert.

### Guards

- Daily max loss is a new engine guard, first in evaluation order, never
  damped. The day guard is extended to cover books (it skips them today).
- Kill switch unchanged: blocks new exposure, never an exit.
- Stale data rules as in section 6 step 2.
- Holiday calendar: the hardcoded 2026 table fails open in 2027 and must be
  replaced before this goes live.

## 10. Fit with the existing system

**Reused as is:** `packages/greeks` (Black-Scholes, Black-76, bisection IV,
`bookGreeks` with honest `unpriced`; vega and theta are already computed and
unused), `desk-engine/marking.ts` exit-side marking and intraday tenor
refinement, the `Dials` plus `presets` pattern, the supervisor scaffold
(lease, CAS state store, seq-then-save-then-post, `markState` versus
`stateAfter`, fill folding), `order-chaser.ts` peg and urgent modes, freeze
splitting, BFO routing for SENSEX, decision journalling, `OptionMaster`
expiry and index-spot handling.

**New:**

- A second decide path in desk-engine (regime detector, delta controller,
  expression) selected by a dial, alongside the recenter engine rather than
  inside it. The recenter engine's sell gates, scrap bans and margin
  projection only understand selling.
- Lean state and lean id on legs.
- Daily max loss guard for books; day guard extended to books.
- SIGTERM flatten for delta-lean books.
- Forward fallback (spot x carry) when the future is one-sided.
- Per-second tick recording for replay (history today is a 60 s snapshot).

**Changes required before this is credible at seconds cadence:**

1. Publish the `order.submitted` nudge so the gateway picks up orders
   immediately instead of waiting on the 5 s sweep. This is the single
   biggest latency item.
2. `confirm_ms` to 1,000 and `cooldown_s` to 0 for cuts on this variant; the
   sub-confirm fast path must not be phase-R-specific.
3. Mark grid: the 5-minute `MARK_STEP_MIN` must not gate this variant's
   per-second evaluation; streak and EOD dials calibrated to it do not apply.
4. Freeze limits synced daily (`make sync`), including SENSEX.
5. Holiday calendar replacement.

## 11. Validation path

1. Journal every decision with regime, ratios, targets, lean state, greeks
   before and after, and the best-fit candidates considered.
2. Record per-second ticks for NIFTY, SENSEX, their near-month futures and
   the ATM plus or minus 10 strikes of the current weekly, from go-live of
   recording, so the controller can be replayed.
3. **Final step of the implementation: four paper books registered and
   running** — NIFTY aggressive, NIFTY conservative, SENSEX aggressive,
   SENSEX conservative — each with its own registry row, preset and lease,
   evaluated side by side for at least two weeks.
4. Going live is a separate decision after the paper run: start at base unit
   0.5 and max lean 1 for one week, then open the dials to the preset.

## 12. Out of scope

- Vega management of any kind (explicitly left free).
- Index futures or synthetic futures as a delta instrument.
- Overnight carry.
- Cross-book portfolio greek aggregation.
- BANKNIFTY (monthly only, no weekly expiry).
- Any change to the recenter engine's own behaviour.
