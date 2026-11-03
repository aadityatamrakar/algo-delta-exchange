# NIFTY Delta-Lean Conservative — how the intraday book works

Date: 2026-10-15. Operator: "write up a detailed spec document on how does
NIFTY-delta-lean-hold-conservative works, only keep intraday version and
conservative approach only."

Preset `delta-lean-conservative`, engine hold-and-adjust (delta-lean v2), paper
rail. Written against master @ 338df847 and the live registry, decisions and
daily reports, read on 15 Oct 2026.

This book opens one hedged options package a day, holds it, and corrects its
delta by adding legs instead of closing them. It is flat by 15:00. This document
specifies when it opens, how it adjusts, and the four ways it exits.

> **Scope.** This spec covers only the **intraday** book
> (`NIFTY-delta-lean-conservative-<date>`). The hold-to-expiry sibling,
> `NIFTY-delta-lean-hold-conservative-<expiry>`, runs the same engine with the
> same dials plus one switch, `dl_hold_to_expiry: true`. That switch carries the
> package overnight to expiry, opens it once per contract, and turns the day
> target and backstop into whole-book limits. All of that is left out here; see
> `2026-10-05-delta-lean-hold-to-expiry-design.md`. The aggressive preset is
> left out too. Every number below is the conservative value.

## Contents

1. [At a glance](#1-at-a-glance)
2. [The book](#2-the-book)
3. [The trading day](#3-the-trading-day)
4. [What the engine reads each pass](#4-what-the-engine-reads-each-pass)
5. [The regime detector](#5-the-regime-detector)
6. [Decision order, every pass](#6-decision-order-every-pass)
7. [The open](#7-the-open)
8. [Posture and adjustments](#8-posture-and-adjustments)
9. [The margin cap](#9-the-margin-cap)
10. [Exits](#10-exits)
11. [A real day: 15 Oct 2026](#11-a-real-day-15-oct-2026)
12. [Execution and order limits](#12-execution-and-order-limits)
13. [Holds and guards](#13-holds-and-guards)
14. [State, day roll and restarts](#14-state-day-roll-and-restarts)
15. [Dial sheet](#15-dial-sheet)
16. [Paper record](#16-paper-record)
17. [Known gaps](#17-known-gaps)

## 1. At a glance

| | Value | Note |
|---|---|---|
| Size at open | 2 lots | per leg; NIFTY lot is 65, so 130 qty a leg |
| Day target | +₹10,000 | realised + open mark; closes the book |
| Day backstop | −₹15,000 | urgent close; desk guard behind it at −₹23,000 |
| Margin cap | ₹25,00,000 | SPAN-lite on the whole book plus the new package |
| Adjustments | ≤ 4 a day | 120 s confirm, 900 s cooldown, never the same regime twice running |
| Clock | 09:30–15:00 | first order after 09:30; 14:50 / 14:55 / 15:00 flatten |

Each morning the book waits for the index to show a confirmed regime. In a
**trend** it buys a call or put debit spread in the trend's direction. In a
**quiet** market it sells a strangle with bought wings. Either way the hedge is
part of the opening package.

After that, nothing is closed until the end of the day. When the market moves
against the book's delta, the book **neutralises by adding**: it buys the
opposite option, or sells a near-the-money option on the side it is long. When
the trend runs the way the book opened, it can **pyramid** by buying more of the
same option. Only four things take legs off: the 14:50–15:00 flatten, the
₹10,000 target, the ₹15,000 backstop, and the stuck rule.

### The operator's rules this engine encodes

- Trade rarely: one open a day, at most four adjustments.
- Hedge once, at the open, and keep that hedge until the close.
- Never close the original leg or an adjustment leg before the close.
- Correct delta by adding legs. A correction goes back to zero and never
  reverses the book.
- Size in contract lots, starting at 2.
- Hard cap of ₹25 lakh margin per book.
- Exit only on the day target, the close, the backstop, or when the book is
  capped and losing with no adjustment left.

## 2. The book

| | |
|---|---|
| Preset key | `delta-lean-conservative` |
| Tag (one per trading day) | `NIFTY-delta-lean-conservative-2026-10-15` |
| Series (groups the days in Reports) | `NIFTY-delta-lean-conservative` |
| Contract | NIFTY weekly options, the nearest listed expiry on or after today, today included. NIFTY weeklies expire on Tuesday, moved earlier for holidays. Today's book trades the 19 Oct 2026 contract. |
| Lot size / strike step | 65 / 50 points |
| Engine | `decideDeltaLean` in `packages/desk-engine/src/delta-lean/decide.ts`, selected by `delta_lean_enabled: true` |
| Rail | Paper. Fills come from the desk's simulator, not a broker. |
| Created by | `scripts/delta-lean-roll.mjs --apply`, cron `20 3 * * 1-5` UTC (08:50 IST) |

The roll creates the registry row, starts it, and switches the paper strategy
on. It copies the fully resolved dial set into the row, so a later change to the
preset reaches only books created after it. The same run retires earlier days'
books: it stops and erases them once they are flat, and never touches a book
that still holds legs.

## 3. The trading day

All times IST. The minute dials count minutes after midnight (570 = 09:30).

| Time | What happens |
|---|---|
| 08:45 | The desk day guard re-arms for paper. |
| 08:50 | **Roll.** Today's tag is registered with the conservative dials and the nearest weekly expiry. Its desk day guard is armed at ₹23,000. Yesterday's flat book is erased. |
| 09:15 | **Warm-up.** The market opens. The supervisor evaluates the book about once a second. The regime detector reads every pass so its windows are full by 09:30. No orders. |
| 09:30 | **Open window.** `dl_warmup_min` 570. The book opens as soon as a trend or quiet regime has held for 120 s. On 15 Oct that was 09:51. |
| open + 15m | **Adjust window.** The open counts as the first package, so the earliest adjustment is 900 s after it. Up to four adjustments, each at least 900 s apart. |
| 14:50 | **Passive flatten.** Every leg is closed, shorts first, worked at the touch instead of crossed. |
| 14:55 | **Urgent flatten.** Whatever is left is crossed. |
| 15:00 | **Flat-by.** Any residue goes to the ladder. Once flat, the book latches "stopped for the day — flat already" and does nothing more. |
| next day | A new tag with an empty book. Nothing carries over except the series name. |

## 4. What the engine reads each pass

The supervisor's loop ticks every 250 ms. A delta-lean book is evaluated when at
least `dl_eval_min_ms` (1,000 ms) has passed since its last evaluation, so about
once every 1.0–1.25 s. The engine itself is a pure function: the same inputs
always give the same decision.

| Input | What it is |
|---|---|
| Spot ring | A shared buffer of NIFTY index ticks (4,096 samples), about one a second. The regime detector reads it. |
| Spot age | Time of the newest index tick. Zero until the first frame arrives, which counts as stale. |
| Option chain | Bid, ask and LTP per strike for the book's expiry, with a timestamp per quote. |
| Greeks | Black-76 implied vol solved from each option's mid, with the index as the forward and a 6.5% rate. Tenor is calendar days ÷ 365; on expiry day it counts the session minutes left, floored at 5. |
| Legs | The book's positions from `desk-books`, re-read every pass. Each is marked at its exit price: bid for a long, ask for a short. |
| P&L | `totalPnl = cumRealized + Σ leg mark-to-market`. Banked money plus the open book at its exit price. |
| Minutes to expiry | Trading minutes (09:15–15:30 sessions), holidays removed. |
| Work in progress | Lots still being worked from the last package, and whether a repair is running on this tag. |
| Saved state | The book's `RuleState` from the last pass (§14). |

## 5. The regime detector

The detector compares what the index did over the last five minutes with what
the options were charging for a five-minute move. There are no indicators. The
ATM straddle is the market's price for the expected move to expiry. Scaled by
the square root of time, it gives the move expected over any window:

```
implied(W) = ATM straddle mid × √( W minutes ÷ trading minutes to expiry )
```

For the 300 s window it measures **displacement** (last tick minus first),
**range** (high minus low) and **cleanliness** (|displacement| ÷ range). One
label comes out:

| Label | Rule (5-minute window) | Used for |
|---|---|---|
| `trend-up` / `trend-down` | \|displacement\| ≥ 2.0 × implied and cleanliness ≥ 0.6. Direction is the sign of the displacement. Once in a trend, the bar to stay is 1.2 × implied, and the label is held for at least 120 s. | Debit-spread open; pyramid or counter-buy |
| `quiet` | range ≤ 0.7 × implied in this window **and** in the five minutes before it. | Strangle open; same-side sale |
| `chop` | Anything else: a wide range that went nowhere. | Same-side sale only; never opens |
| `unknown` | No reading: either side of the ATM straddle unpriced, fewer than 8 ticks in the window, ticks spanning less than half of it, or a quiet window with no readable window before it. | Nothing. Never treated as quiet. |

**Worked example.** ATM straddle ₹240, two sessions (750 trading minutes) to
expiry. The five-minute implied move is 240 × √(5 ÷ 750) = **19.6 points**. A
trend needs a clean move of 39.2 points in five minutes. Staying in a trend
needs 23.5. Quiet needs both of the last two five-minute ranges inside 13.7
points.

**The regime clock.** `dlRegimeSinceMs` is restamped only when the label
changes. The 120 s confirmation for an open or an adjustment is measured from
it. At the start of each day it is anchored at the first pass, so nothing
confirms in the first 120 s.

The detector also computes a 60 s "fast" and a 900 s "context" window. In this
version no rule reads them; only the 300 s label decides anything.

## 6. Decision order, every pass

The steps run top to bottom and the first one that answers wins. Exits sit above
everything that adds risk, and the latched stop sits above the clock.

| Step | Name | Kind | What it does |
|---|---|---|---|
| 0 | Day roll | state | On a new IST date: clear the stop, the open, the open side, the adjustment count, the cooldown and churn references, the stuck clock and the day's realised figure. On the same date: change nothing. That is what makes a mid-session restart safe. |
| 1 | Latched stop | exit · urgent | If the day is already stopped, close any legs left, urgently. A flat stopped book does nothing for the rest of the day. |
| 2 | Clock | exit · `eod` | From 15:00 close everything on the ladder; from 14:55 urgently; from 14:50 passively. Latches once the book is flat. Runs above the session gate, so a book that wakes after 15:00 still holding legs gets flattened. |
| 3 | Backstop | exit · `dl-stop` | `totalPnl ≤ −₹15,000`: close everything urgently and latch now. |
| 4 | Target | exit · `dl-target` | `totalPnl ≥ +₹10,000`: close everything on the ladder and latch now. |
| 5 | Gates | wait | Not an NSE trading day; before 09:30 (the detector still reads); a repair running on the tag; lots still working from the last package; index older than 10 s. Any of these holds the book. The exits above still run. |
| 6 | Open | act · `dl-open` | If the book has not opened today: open on a confirmed trend or quiet regime (§7). Chop and unknown wait. |
| 7 | Posture and adjustment | act · `dl-add` / `dl-neutral` | If it has opened: compare the book's net delta with where the regime wants it, and add one leg if the gap is big enough and every gate passes (§8). |
| 8 | Stuck check | exit · `dl-stuck` | Reached only from step 7, when an adjustment is wanted but blocked by the cap or the four-adjustment limit. If the loss stays past ₹15,000 for 300 s straight, close everything on the ladder and latch now. |

## 7. The open

One package a day. It opens on the first pass where all of these hold:

- The book has not opened today (`dlOpenedMs = 0`).
- It is 09:30 or later and every gate in step 5 passes.
- The 5-minute label is `trend-up`, `trend-down` or `quiet`, and has been for
  at least 120 s.
- Every leg can be priced on the chain, and the package fits the margin cap at
  one lot or more.

### What it opens

| Regime | Legs, in the order sent | Shape |
|---|---|---|
| `trend-up` | **Buy** 2 lots CE at \|Δ\| 0.55–0.65<br>**Sell** 2 lots CE at \|Δ\| 0.20–0.30, strictly above the bought strike (the hedge) | Call debit spread. Long about 0.35 delta per pair, near-zero theta, loss capped at the debit. |
| `trend-down` | **Buy** 2 lots PE at \|Δ\| 0.55–0.65<br>**Sell** 2 lots PE at \|Δ\| 0.20–0.30, strictly below the bought strike (the hedge) | Put debit spread, the mirror image. |
| `quiet` | **Buy** 2 lots PE wing, \|Δ\| ≤ 0.10, below the short put<br>**Sell** 2 lots PE, \|Δ\| ≤ 0.30, below ATM<br>**Buy** 2 lots CE wing, \|Δ\| ≤ 0.10, above the short call<br>**Sell** 2 lots CE, \|Δ\| ≤ 0.30, above ATM | Short strangle with wings (an iron condor). Delta near zero, collects premium, loss capped by the wings. |

Within each package the bought leg is sent before the short it protects, so the
book is never naked between two fills. If either leg of a unit cannot be found,
the whole package is skipped and the book waits. Half a spread is never sent.

### How a strike is chosen

1. Find the ATM strike, the one nearest the index.
2. Keep only **tradable** strikes: both the call and the put have a two-sided
   quote no older than 3 s, with a spread no wider than the larger of 2% of mid
   and ₹1.
3. Drop strikes closer than one step (50 points) to ATM.
4. Walk outward from ATM and take the first strike whose solved |delta| falls
   inside the band. A strike whose IV cannot be solved is skipped. There is no
   fallback delta and no "nearest miss".

The quiet bands are ceilings, so the short is the strike nearest ATM at 0.30
delta or less, and the wing is the nearest strike beyond it at 0.10 or less.

### Sizing

The package starts at `dl_open_lots` = 2 a leg. It is margin-projected with the
existing book (§9). If 2 lots do not fit, it tries 1. If 1 does not fit, nothing
opens. That is a wait, not a stuck condition, because a book with nothing open
has nothing to lose. All legs of the open must fit inside the per-minute order
budget together, or none are sent.

### What the open records

`dlOpenedMs` = now; `dlOpenSide` = `up`, `down` or `none` (strangle);
`dlLastAdjustMs` = now, which starts the 900 s cooldown; `dlLastAdjustRegime` =
the opening regime, so that regime cannot also justify the next adjustment.

## 8. Posture and adjustments

### Net delta

The book's net delta is measured in **delta-lots**: for each leg, |delta| ×
lots, positive for long calls and short puts, negative for short calls and long
puts. One delta-lot is the exposure of one lot of NIFTY future. If any leg's IV
cannot be solved, the book holds for that pass.

The book's lean target is **D = 2 × (0.60 − 0.25) = 0.70 delta-lots**: open
lots × (middle of the long band − middle of the short band). That is about what
a freshly opened debit spread carries, so a new trend book already meets its own
posture. The dead band is **0.5 delta-lots**. Inside it, nothing is worth paying
a spread for.

### Where the regime wants the delta

The wanted posture depends on the regime *relative to the side the book
opened*:

| Regime | Book opened | Mode | Target | Acts when net is | Adds | Trigger |
|---|---|---|---:|---|---|---|
| `trend-up` | up | lean | +0.70 | `< +0.20` | **Buy** CE, \|Δ\| 0.55–0.65 | `dl-add` |
| `trend-down` | down | lean | −0.70 | `> −0.20` | **Buy** PE, \|Δ\| 0.55–0.65 | `dl-add` |
| `trend-up` | down, or strangle | counter | 0 | `< −0.50` | **Buy** CE, \|Δ\| 0.55–0.65 | `dl-neutral` |
| `trend-down` | up, or strangle | counter | 0 | `> +0.50` | **Buy** PE, \|Δ\| 0.55–0.65 | `dl-neutral` |
| `quiet`, `chop` | any | flat | 0 | `> +0.50` | **Sell** CE, \|Δ\| 0.45–0.60 | `dl-neutral` |
| `quiet`, `chop` | any | flat | 0 | `< −0.50` | **Sell** PE, \|Δ\| 0.45–0.60 | `dl-neutral` |
| `unknown` | any | none | — | never | nothing | — |

Where each posture acts, for a book that opened up (`#` = acts, `.` = nothing
asked):

```
Lean      |#### buy CE (dl-add) #####||. band .||. past .|
                                                ^ target +0.70
Counter   |........ nothing asked .........||## buy PE ##|
                                  ^ target 0
Flat      |# sell PE ##||... dead band ....||# sell CE ##|
                                  ^ target 0
          ----+---------+---------+---------+---------+----
            -1.0      -0.5        0       +0.5      +1.0
                      book net delta, delta-lots
```

Lean is trend-up on a book that opened up; counter is trend-down on a book that
opened up or a strangle; flat is quiet or chop on any book. A book that opened
down mirrors the first two rows around zero: its lean target is −0.70 and it
buys puts, and its counter-buy is a call when net delta falls below −0.50. A
strangle book has no lean row; both trends are counter for it.

### Two rules that make "adds only" hold

- **One-sided postures.** Lean only ever adds delta in the direction the book
  opened, so a book that has run past +0.70 is never sold down. Counter only
  ever moves the book toward zero, so a long book can never finish the day
  short. Only flat works in both directions.
- **Never trade against a held strike.** An adjustment may not buy a strike the
  book is short or sell a strike the book is long. Downstream, that order would
  net into the held leg and quietly close part of it. The case that matters
  most: a trending day carries the hedge's delta from 0.25 up into the 0.55–0.65
  band, and a pyramid would otherwise buy the hedge back.

### How many lots

```
lots = max( 1, round( |target − net| ÷ |delta of one lot| ) )
```

For a counter-buy, if that would carry the book more than one dead band past
zero, it takes one lot fewer (never below 1). The lots are then trimmed to
whatever fits the margin cap.

### Gates, in order, once an adjustment is wanted

| # | Gate | Fails when | Result |
|---:|---|---|---|
| 1 | Day limit | 4 adjustments already made today | block → stuck check |
| 2 | A strike exists | No tradable strike in the band, after excluding opposite-side held strikes | wait |
| 3 | Margin cap | Not even 1 lot fits under ₹25L (only a sale can fail this) | block → stuck check |
| 4 | Churn guard | The current regime already justified the last package (the open counts) | wait |
| 5 | Confirm | The regime has held for less than 120 s | wait |
| 6 | Cooldown | Less than 900 s since the last package (the open counts) | wait |
| 7 | Order budget | The order does not fit this minute's 40-order budget | wait |

A **wait** clears on its own and resets the stuck clock. A **block** cannot
clear on its own and runs the stuck clock. If every gate passes, one leg is sent
and the book records adjustment count + 1, the time (restarting the cooldown)
and the regime (arming the churn guard).

Taken together: adjustments are at least 15 minutes apart, the regime has to
change between any two packages, and a counter-buy always fits the cap because a
bought option never raises SPAN-lite.

## 9. The margin cap

Every open and adjustment is checked against `margin_cap` = ₹25,00,000, priced
with **SPAN-lite** on the existing book *plus* the new package. Pricing them
together is what gives a hedged package its offset.

- 21 scenarios: index × (1 + f × 21%) for f ∈ {0, ±⅓, ±⅔, ±1}, crossed with
  IV × {0.75, 1, 1.25}.
- Every leg is repriced with Black-76 in every scenario. The worst total loss is
  the SPAN figure.
- SPAN is floored at 5% of short notional, and a 5% exposure charge on short
  notional is added on top.
- Held legs use their solved IV. New legs are priced at a flat 35% IV.
- A book with no short legs needs no margin.

The size is cut down one lot at a time until it fits. It is never rounded up.
SPAN-lite is a model and can be off from the broker's figure by 2× either way,
so it is only ever used to refuse or shrink a trade.

### What the cap means at 2 lots

Computed with the engine's own `spanLiteMargin`: NIFTY at 22,800, lot 65, 19 Oct
expiry, valued on 15 Oct.

| Package | Short lots | SPAN-lite | Share of cap |
|---|---:|---:|---:|
| Trend open: 2-lot call debit spread | 2 | ₹2,96,400 | 12% |
| Quiet open: 2-lot strangle with wings | 4 | ₹5,92,800 | 24% |
| 15 Oct closing book, 5 legs (§11) | 4 | ₹5,92,800 | 24% |
| For scale: 1 naked ATM short call | 1 | ₹3,63,453 | 15% |

Hedged packages sit on the floor, 5% SPAN plus 5% exposure, so 10% of short
notional: about ₹1.48 lakh per short lot. The cap allows roughly 16 hedged short
lots. A conservative book opens with 2 or 4 and usually adds 1 lot per
adjustment, so in practice the cap does not bind.

## 10. Exits

These are the only things that take legs off. Every exit closes every leg, and
buys back shorts before selling longs.

| Exit | Fires when | How it closes | Latches |
|---|---|---|---|
| `eod` | 14:50 | Passive: worked at the touch | Once flat |
| `eod` | 14:55 | Urgent: crossed | Once flat |
| `eod` | 15:00 and after | Ladder | Once flat |
| `dl-stop` | `totalPnl ≤ −₹15,000` | Urgent | Immediately |
| `dl-target` | `totalPnl ≥ +₹10,000` | Ladder | Immediately |
| `dl-stuck` | Adjustment wanted but blocked by the cap or the 4-adjustment limit, **and** `totalPnl ≤ −₹15,000`, both continuously for 300 s | Ladder | Immediately |

**Why three latch immediately.** Their triggers do not survive the close. The
target is a mark that disappears with the legs. The backstop's loss is still
moving. The stuck condition vanishes once the book is empty. Without the latch,
an opened book with no legs would read as far short of its lean target and buy a
fresh unhedged pyramid. Once latched, step 1 closes any part fill urgently and
then holds for the day.

**Why the clock latches only once flat.** Latching at 14:50 would send every
leftover leg straight to step 1's urgent close and skip the five-minute passive
window.

**Priority.** Latched stop, then clock, then backstop, then target. A 14:52
close is recorded as `eod` even if the target was also hit.

**Behind the engine.** desk-api checks the book every 10 s. At a loss of ₹23,000
(1.5 × the backstop, rounded up to ₹1,000) it switches the strategy off and
flattens the tag, once per day.

> **Stuck exit cannot fire on this book.** The stuck floor (₹15,000) equals the
> backstop (₹15,000), and the backstop runs first at step 3. Any loss deep
> enough to start the stuck clock has already closed the book as `dl-stop`. The
> runbook notes the same thing. See §17.

## 11. A real day: 15 Oct 2026

Tag `NIFTY-delta-lean-conservative-2026-10-15`, 19 Oct contract, NIFTY around
22,800. Every non-hold decision the engine made that day:

| IST | Trigger | Engine's reason | Orders |
|---|---|---|---|
| 09:51:59 | `dl-open` | trend-up: opening up, 2 legs at 2 lots a leg, hedge included | **Buy** 130 × 22750 CE<br>**Sell** 130 × 23000 CE |
| 10:07:01 | `dl-neutral` | chop/flat: 0.63 delta-lots against a wanted 0.00 | **Sell** 65 × 22850 CE |
| 11:30:55 | `dl-add` | trend-up/lean: −0.03 delta-lots against a wanted 0.70 | **Buy** 65 × 22900 CE |
| 11:45:56 | `dl-neutral` | chop/flat: 0.54 delta-lots against a wanted 0.00 | **Sell** 65 × 22950 CE |
| 14:50:00 | `eod` | 14:50: passive flatten, closing all 5 legs | Shorts first: 23000, 22850 and 22950 CE bought back; then 22750 and 22900 CE sold |

What this shows:

- The open waited until 09:51 for a trend that held 120 s.
- The first adjustment came 15 minutes and 2 seconds after the open: the
  cooldown, then the next pass.
- The regime alternated (trend-up, chop, trend-up, chop), so the churn guard
  never held anything back. Three of the four adjustments were used.
- The chop sales went to 22850 and 22950, never to 22750 or 22900 where the book
  was long.
- Result: **+₹6,233.50** realised, 10 orders, intraday high +₹6,428.50, low
  −₹45.50. The target was not reached, so the clock closed the book.

## 12. Execution and order limits

### From decision to order

- Lots become quantity in one place: lots × 65.
- Opens and adjustments must repeat for 1 s (`confirm_ms`) before they route;
  there is no extra cooldown (`cooldown_s` 0). The engine's exits `dl-stop`,
  `dl-target` and `dl-stuck` skip that confirm. `eod` skips all damping.
- Each package gets a decision id `<tag>:paper:<seq>`, and the book's state is
  saved before the order is posted.

### Urgency

| Decision | Urgency | Gateway work mode |
|---|---|---|
| Open, adjustment, 14:50 flatten | `passive` | Peg at the touch, re-peg after a 1 s dwell, cross once after `chase_max_ms` = 3,000 ms. The chaser runs every 5 s, so in practice the cross comes at about 5 s. Pegging is bounded at the limit ± 0.5%. |
| Backstop, latched stop, 14:55 flatten | `urgent` | Urgent |
| Target, stuck exit, 15:00 residue | `ladder` | Urgent |

Every order is a limit. desk-api sets an unpriced order's limit at a marketable
level: the touch plus or minus the larger of 2% and 2 ticks (10% on an
expiry-day contract). Passive orders go out in tranches of up to 3 lots, so a
2-lot conservative leg is one order.

### Order budgets

| Budget | Limit | Enforced by | Behaviour |
|---|---:|---|---|
| Per second | 2 | Supervisor | Burst window on opens |
| Per minute | 40 | Engine | An open goes whole or not at all; closes are kept to the last slot |
| Per day | 40 | Supervisor | Opens only, counted in memory; exits are never dropped |

Expected orders a day: a trend day is 2 to open, up to 4 adjustments, and one
close per leg, so 12 at most. A quiet day is 4 + 4 + 8 = 16 at most. Paper days
since the cut-over have run 6–12.

### Paper fills

The simulator rests every limit order and fills it in full on the first tick
that trades through the limit, at that tick's price. There are no partial fills
and no slippage model.

## 13. Holds and guards

| Condition | Effect |
|---|---|
| Index tick older than 10 s | No open and no adjustment. Exits still run. |
| Quote older than 3 s or spread too wide | That strike is not tradable. No band strike means wait. |
| A held leg with no solvable IV | Net delta unknown; hold. |
| Detector reads unknown | Hold what the book holds. |
| Opened, but the book has no legs | Hold. The day's package is gone, so there is nothing to adjust around. |
| Lots still working from the last package | Wait. An engine exit cancels a working add. |
| Repair running on the tag | Wait. |
| Not an NSE trading day | Wait. |
| Paper strategy switched off | A flat book idles. A book with legs still runs its exits, but any package with an open is held. |
| Loss of ₹23,000 (desk day guard) | desk-api switches the strategy off and flattens the tag. Once per tag per day. |
| Gateway kill switch | Blocks new exposure. Exits pass. |
| Supervisor lease lost (30 s TTL) | That process stops steering. SIGTERM leaves positions untouched. |

## 14. State, day roll and restarts

The book's memory is its `RuleState`, saved in `desk-supervisor-state`.

| Field | Meaning | New day |
|---|---|---|
| `dlDayStarted` | IST date of the state | Set to today |
| `dlStopped` | The day is over; set by an exit | false |
| `dlOpenedMs` | When today's package opened; 0 = not yet | 0 |
| `dlOpenSide` | `up`, `down`, `none` (strangle) | empty |
| `dlAdjustsToday` | Adjustments made after the open | 0 |
| `dlLastAdjustMs` | Cooldown reference; the open counts | 0 |
| `dlLastAdjustRegime` | Churn guard reference | empty |
| `dlRegime` / `dlRegimeSinceMs` | Current label and when it last changed | empty / now |
| `dlBlockedSinceMs` | Stuck clock; 0 = not running | 0 |
| `dlDayRealized` | Today's banked rupees, for the ledger | 0 |

- When a package routes, the state after it is saved. When nothing routes, the
  state before it is saved, so a dropped package does not use up an adjustment
  or start a cooldown.
- The P&L the exits read is `cumRealized` plus the open mark. `cumRealized`
  belongs to the tag. Since each day is a new tag, it starts at zero every
  morning.
- A restart on the same date changes no saved field. It does reset two things
  kept in memory: the 1 s confirm timers and the 40-a-day order count.
- On boot the supervisor re-posts any order still in flight, which is safe
  because the decision id makes it idempotent. It never flattens on boot.
- **Operator rule:** restart onto a new build only while the book is flat, after
  15:00 or before 09:15.

## 15. Dial sheet

The resolved set stored on today's registry row, which matches the preset.
**(C)** marks the dials the conservative preset sets on top of the shared
delta-lean base.

| Dial | Value | Meaning |
|---|---:|---|
| **Budget and exits** | | |
| `dl_day_target` | 10,000 | ₹, realised + mark; closes the book |
| `dl_day_max_loss` (C) | 15,000 | ₹ backstop; urgent close |
| `dl_stuck_loss` (C) | 15,000 | ₹ loss that arms the stuck clock |
| `dl_stuck_confirm_s` | 300 | s blocked and losing before the stuck exit |
| `margin_cap` | 2,500,000 | ₹ SPAN-lite on book + package |
| **Size and adjustment** | | |
| `dl_open_lots` (C) | 2 | lots per leg at open |
| `dl_adjust_confirm_s` (C) | 120 | s a regime must hold before an open or adjustment |
| `dl_adjust_cooldown_s` (C) | 900 | s between packages; the open counts |
| `dl_max_adjusts_day` (C) | 4 | adjustments after the open |
| `dl_dead_band_lots` | 0.5 | delta-lots of net exposure ignored |
| **Regime detector** | | |
| `dl_slow_window_s` | 300 | the deciding window |
| `dl_trend_mult` | 2.0 | × implied to enter a trend |
| `dl_trend_exit_mult` | 1.2 | × implied to stay in a trend |
| `dl_clean_min` | 0.6 | minimum \|displacement\| ÷ range for a trend |
| `dl_quiet_mult` | 0.7 | × implied range ceiling for quiet |
| `dl_regime_dwell_s` | 120 | s a trend label is held at least |
| `dl_fast_window_s` / `dl_context_window_s` | 60 / 900 | computed, not used by any rule |
| `dl_context_on` | true | context window computed |
| **Strike selection** | | |
| `dl_long_delta_lo` / `hi` | 0.55 / 0.65 | bought leg of a debit spread; pyramid and counter-buy |
| `dl_short_delta_lo` / `hi` | 0.20 / 0.30 | the debit spread's hedge |
| `dl_credit_short_delta_max` | 0.30 | strangle short, ceiling |
| `dl_wing_delta` | 0.10 | strangle wing, ceiling |
| `dl_neutral_short_delta_lo` / `hi` | 0.45 / 0.60 | the flat-mode sale, near ATM |
| `dl_min_strike_gap` | 1 | steps from ATM a band strike must be |
| **Liquidity and staleness** | | |
| `dl_quote_fresh_s` | 3 | s maximum quote age |
| `dl_max_spread_pct` / `abs` | 0.02 / 1 | spread ≤ max(2% of mid, ₹1) |
| `dl_spot_stale_s` | 10 | s index age that refuses new risk |
| **Clock and pacing** | | |
| `dl_warmup_min` | 570 | 09:30, first order |
| `dl_flatten_passive_min` | 890 | 14:50 |
| `dl_flatten_urgent_min` | 895 | 14:55 |
| `dl_flat_by_min` | 900 | 15:00 |
| `dl_eval_min_ms` | 1,000 | ms between evaluations |
| `dl_max_orders_s` / `min` / `day` | 2 / 40 / 40 | order budgets (§12) |
| `dl_hold_to_expiry` | false | intraday book |
| **Execution** | | |
| `confirm_ms` / `cooldown_s` | 1,000 / 0 | supervisor damping |
| `chase_max_ms` (C) | 3,000 | ms at the touch before the single cross |
| `chase_cross_buffer_pct` | 0.005 | peg bound around the limit |
| `work_tranche_lots` | 3 | passive tranche size |
| `rest_max_min` | 10 | min a paper package may rest before a re-decide |

## 16. Paper record

Every day of the series on the hold-and-adjust engine, from
`desk-daily-reports`. **(E)** marks a NIFTY expiry day. 2 Oct was a holiday.
Paper fills carry no slippage, so treat these as an upper bound.

| Date | Day P&L ₹ | Orders | Intraday high ₹ | Intraday low ₹ |
|---|---:|---:|---:|---:|
| 23 Sep | −374 | 6 | 445 | −1,196 |
| 24 Sep | 5,752 | 10 | 5,752 | −65 |
| 25 Sep | −1,554 | 6 | 78 | −2,759 |
| 28 Sep | 1,482 | 6 | 1,596 | −956 |
| 29 Sep (E) | 780 | 6 | 2,646 | −1,589 |
| 30 Sep | 4,878 | 10 | 5,151 | −1,774 |
| 1 Oct | 946 | 12 | 2,444 | −2,730 |
| 5 Oct | 1,612 | 6 | 1,612 | −481 |
| 6 Oct (E) | 3,270 | 10 | 3,695 | −26 |
| 7 Oct | −3,201 | 10 | 1,131 | −3,419 |
| 8 Oct | −461 | 6 | 163 | −2,320 |
| 9 Oct | 3,201 | 6 | 3,201 | −462 |
| 12 Oct | −1,869 | 6 | −228 | −2,249 |
| 13 Oct (E) | −338 | 8 | 1,515 | −338 |
| 14 Oct | 4,547 | 10 | 5,912 | −2,412 |
| 15 Oct | 6,233 | 10 | 6,428 | 45 |
| **16 days** | **24,904** | **138** | **6,428** | **−3,419** |

- 10 winning days of 16, an average of ₹1,557 a day. Best day +₹6,233, worst
  −₹3,201.
- No day reached the ₹10,000 target; the best intraday high was ₹6,428. The
  worst intraday low, −₹3,419, is less than a quarter of the backstop. Every day
  ended on the clock.
- Expiry days made +₹3,712 over three days.

## 17. Known gaps

1. **The stuck exit is unreachable.** Since 5 Oct the backstop and the stuck
   floor are both ₹15,000, and the backstop is checked first. On top of that,
   the cap does not bind at 2 lots (§9), so the only block left is the
   four-adjustment limit. In effect the conservative book has three exits: the
   clock, the target and the backstop.
2. **Adding to a held strike is refused.** The engine allows a pyramid or a flat
   sale on a strike the book already holds on the same side. desk-api refuses it
   as "already open" because the engine does not mark the order as an add. This
   series saw 12 such refusals between 24 Sep and 8 Oct. A refused add does not
   use up an adjustment. On 30 Sep the book was refused three times and only
   placed the add at 14:25.
3. **The dead band is in absolute delta-lots.** At 2 lots, 0.5 delta-lots means
   each lot must drift about 0.25 delta before anything is wanted. The 4 Oct
   review considered halving it for this preset and did not recommend it.
4. **SPAN-lite is a model.** New legs are priced at a flat 35% IV, and the
   result can be off from the broker's figure by 2× either way.
5. **Paper fills are optimistic.** No slippage and no partial fills. A limit
   that is already marketable can rest until a print trades through it, and the
   chaser only crosses once.
6. **Restarts reset two limits.** The 40-a-day order count and the 1 s confirm
   timers live in memory.
7. **Holiday table.** Trading minutes to expiry use a 2026 holiday table that
   fails open in 2027.

## Sources

`packages/desk-engine/src/delta-lean/` (`decide.ts`, `regime.ts`, `express.ts`,
`lean.ts`), `dials.ts`, `presets.ts`, `margin-project.ts`;
`apps/supervisor/src/engine-host.ts` and `main.ts`; the desk-api books and
day-guard routes; `scripts/delta-lean-roll.mjs`; the 2026-09-22 hold-and-adjust
and 2026-10-05 hold-to-expiry specs; the 2026-10-04 review
(`docs/reports/2026-10-04-delta-lean-review.md`);
`docs/runbooks/delta-lean-paper.md`; the live registry, decisions and daily
reports, read on 15 Oct 2026.
