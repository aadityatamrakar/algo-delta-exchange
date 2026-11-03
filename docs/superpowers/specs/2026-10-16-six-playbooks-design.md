# Six playbooks for NIFTY and SENSEX: three intraday, three expiry-day

Date: 2026-10-16. Master @ `e0e8ffb4`. Status: **design v2**. v2 folds in the
independent spec review (one blocker, five high findings and the rest) and the
trade analyst's final lessons. Approved for implementation by the operator's
standing instruction ("think through make a spec plan and then implement it").

The operator's request, verbatim:

> look at all the logs of what we traded, and check what is working and what is
> not working, do a review of algos as well, and generate 3 new algos for
> intraday based on nifty and sensex, and 3 for expiry day trading, it can be
> delta book based or normal strategy. think through make a spec plan and then
> implement it. think all possible scenerios how market can react and our
> strategy how will it handle it.

The review behind this spec is `docs/reports/2026-10-16-desk-review.md`. It covers
every series in `desk-daily-reports`, the order journal, the engine decisions, the
pm2 logs and a code review of every algo.

All six new books run on the **paper rail**. Nothing here enables live trading.

## Contents

1. [What the record says](#1-what-the-record-says)
2. [Design rules taken from it](#2-design-rules-taken-from-it)
3. [Foundation fixes](#3-foundation-fixes)
4. [The playbook frame](#4-the-playbook-frame)
5. [The six playbooks](#5-the-six-playbooks)
6. [How the six behave together, by day type](#6-how-the-six-behave-together-by-day-type)
7. [Scenario catalogue](#7-scenario-catalogue)
8. [Dials and presets](#8-dials-and-presets)
9. [Testing](#9-testing)
10. [Rollout](#10-rollout)
11. [Out of scope and known gaps](#11-out-of-scope-and-known-gaps)

---

## 1. What the record says

The window is 2026-07-28 to 2026-10-15. Everything is paper unless marked live.

- The engine simulator paid no spread, so short-premium paper results are an upper
  bound.
- At 25 bps of slippage plus charges, only five strategies stay positive:
  - BULL_S_1 at a flat size;
  - EAGLE_S_1;
  - NIFTY delta-lean conservative;
  - ORB_FUT_SNX;
  - ORB_SCALP_SNX.

### 1.1 What works

| Evidence | Numbers (paper) |
|---|---|
| **Trend debit spreads opened in the first 15 minutes after the warm-up.** These are the delta-lean v2 opens on a confirmed straddle-implied trend. | Put spreads: 27 opens, **+₹1,12,144**, 67% won. Call spreads: 32 opens, +₹22,941, 50% won. Opens at 09:30-09:45: 47, **+₹1,26,258**. On gap-and-go and trend-down days, every put spread won (16 of 16, +₹1.51L). |
| **The same trend open on expiry mornings** | 8 opens at 09:30-10:00 on the book's own expiry day: +₹37,919, 5 of 8 won |
| **Buying the new direction after a flip** (delta-lean counter-buys) | 15 counter-buys, **+₹47,008**, 67% won. Three were on trend-down days (+₹51k), one on a V-day (+₹8k). |
| **Premium sold late** | Delta-lean same-side sales at or after 12:00: 25, +₹53,414, 19 won. On expiry days, sales after 11:00: 8, +₹19,990, 7 won. BULL_SNX_1 legs sold 13:00-14:30 on SENSEX expiry: +₹11.2k, 62% won. |
| **Short ATM straddles with a 25% combined stop, held to the close, on a LONG-DATED contract** | BULL_S_1 (BANKNIFTY monthly) re-scaled to a flat 1 lot: 54 days, **+₹1,38,757**, 81% won, PF 3.33. It won 97% of the days that closed within 0.3% of the open, and was +₹56k at 25 bps. |
| **Winners run late** | 29 of 38 winning delta-lean book-days printed their best mark after 13:30. A book up more than ₹2,000 at 13:00 never finished below that level (15 of 15). |
| **The opening gap predicts the day** (SENSEX) | Gaps of 0.6% or more became directional days 57% of the time; gaps under 0.25%, 6%. Breakouts won 70% of the ≥ 0.6% gap days. Short premium did best on 0.25-0.6% gaps (79% won). Delta-lean won 30% of the < 0.25% gap days. |

### 1.2 What does not work

| Evidence | Numbers (paper) |
|---|---|
| **Selling near-ATM premium in the first 40 minutes** (delta-lean "flat" adjustments: naked short 0.45-0.60Δ) | 52 sales, **−₹1,66,784**, 19 won |
| **The quiet iron-condor open**, above all on expiry day | 5 opens, −₹56,552. SENSEX 1 Oct alone: −₹58,417. |
| **Short ATM straddles on weekly contracts with a 1.25× stop and re-entry at every strike crossing** | BULL_SNX_1 at 1 lot: −₹10k, and −₹64k at 25 bps. 188 stop-outs. On SENSEX expiry days, legs sold before 13:00 lost −₹42k. |
| **Uncapped pyramids** | BULL_SNX_1's whole paper total is 109% one day (1 Oct, 117 straddle-lots open, intraday low −₹3,15,239) |
| **Fixed point targets and time stops on option buys** | ORB_SCALP_NIFTY's time stops cost −₹16,664. ATR_BAND_NIFTY −₹6,451. BN_BREAKOUT −₹1,483. |
| **Signal mirrors** | −₹49k together. The source has been unreachable since 11 Oct. |
| **The ₹10,000 target as the main exit** | It fired 3 times in 64 delta-lean book-days |

### 1.3 Defects that distort the record

1. **Weekly chains are priced off the monthly future.**
   - The weekly's parity forward sat a median **308 points** below the future on
     SENSEX (15-561), and 35-71 points below it on NIFTY.
   - The 1 Oct condor's "0.30Δ" short put was at the money.
   - SENSEX opens with a gap over 300 points lost −₹40,032 over 20; the rest made
     +₹97,801 over 16.
2. **Engine paper fills pay no spread.** A crossed limit with no print through it
   rests for ever. That is how the 1 Oct hedge was stranded.
3. **The decision path has no expiry-day price buffer.**
4. **ORB_FUT exits are judged on index ticks as well.** 46 trips were stopped at the
   entry price inside 2 s.
5. **Same-strike adds refused as "already open".** 73 times on 36 book-days counting
   the hold books; 53 times on 25 on the four daily books.

### 1.4 How often each kind of day happens

| Day type | SENSEX (45 labelled days) | BANKNIFTY (56) |
|---|---:|---:|
| range | 23 (51%) | 30 (54%) |
| gap-and-go | 11 (24%) | 7 (13%) |
| trend-down / trend-up | 4 / 3 | 5 / 1 |
| gap-fade / V-reversal | 3 / 1 | 6 / 3 |

August was range-bound (median SENSEX range 0.39%). 23 Sep-15 Oct was volatile and
falling (gaps 0.4-0.9%, ranges 0.6-1.7%).

### 1.5 How far the evidence can be trusted

- **The trend open's record is confounded by defect 1.**
  - On SENSEX the "0.60/0.25" put spreads were really about 0.78/0.30, and the call
    spreads about 0.36/0.17.
  - The profit sits in gap-and-go days (28 opens, +₹1.74L). The 14 range-day trend
    opens won 29% (−₹18k).
  - After F1 the delta bands buy the structure that was designed, not the one that
    earned the money.
  - None of these paths ran the new exits.
- **The short-straddle evidence is BANKNIFTY monthlies.** NIFTY/SENSEX weeklies away
  from expiry made +₹593 a day per lot before costs. Wing Straddle (§5.2) therefore
  trades a 5+ trading-day contract at 1 lot. Its edge on these indices is a
  hypothesis to paper-test.
- **Expiry-day results rest on 3-12 expiry days** and are dominated by single days.
- **Expiry Gamma Breakout (§5.6) has no direct evidence at all.**

## 2. Design rules taken from it

| # | Rule | From |
|---|---|---|
| D1 | **Defined risk only, at every moment.** On every option type, short lots ≤ long lots of the same type, on every pass, while opening, holding and exiting. Structures: debit spreads, iron flies, long options. | §1.2: the condor, the flat sales, the pyramid |
| D2 | **Buy before you sell, and buy back before you sell out.** Opens send the protective longs first and the shorts only once those are held. Exits buy back every short first and sell the longs only once no short remains. | the 1 Oct stranded hedge; the gateway does not gate fills |
| D3 | **Trend trades open early. Premium on a long-dated contract is sold in the morning. Premium on 0-DTE is sold after 13:00.** | §1.1 |
| D4 | **Exits close the whole book.** Stops are urgent. A worked exit escalates to urgent after 60 s, or the moment a stop condition appears. | operator rule |
| D5 | **Let winners run.** No profit trailing before 13:00 on the intraday trend books. From 13:00, a floor is armed. A flip exit applies only to a losing trade. | §1.1, "winners run late" |
| D6 | **No pyramid without a cap.** At most one add: a single bought option, on a trade already in profit. | §1.2 |
| D7 | **Measure in the market's units.** Thresholds are in straddle units or implied-move units. 0-DTE strikes are chosen in straddle units. | review A.1 W3 |
| D8 | **Intraday books never trade 0-DTE.** The three expiry books own it. | §1.2 |
| D9 | **No book can trade on a build that does not know it.** | memory: an unknown dial is dropped |
| D10 | **Read the gap.** Trend books stand down on gaps under 0.25%. The straddle seller stands down on gaps of 0.6% or more. | §1.1, the gap row |
| D11 | **Time to expiry is counted in trading days.** | review (f) |

## 3. Foundation fixes

### F1. Each chain's own forward (critical)

**Where:**
- `apps/supervisor/src/chain-view.ts` (`snap`) and `main.ts` (the snap call);
- a new pure helper `packages/desk-engine/src/forward.ts`;
- a new dial, **`dl_parity_forward`**, in the delta-lean section, Lifecycle group.

**Rule.** A book whose resolved dials have `delta_lean_enabled` and
`dl_parity_forward` is priced off its own expiry's forward:

1. **Parity.** Take the 6 strikes nearest the index level. A strike counts only when
   both wings have a two-sided quote at most 10 s old, with a spread at most
   max(3% of mid, ₹2). Each counted strike gives
   `F_K = K + (C_mid − P_mid) × e^{rT}`.
   - The forward is the median of at least 3 strikes.
   - It is rejected when `|F − index| > max(0.6% × index, 2 × step)`.
2. **Index × carry** (`index × e^{rT}`) when parity is unavailable.
3. **The future mid**, as today, only when there is no index level.

**Which books get it.**
- `DEFAULT_DIALS` has `dl_parity_forward: false`, and `DELTA_LEAN_BASE` sets it true.
  So every book the roll creates after the deploy gets it: the daily four, new hold
  pairs and the six playbooks.
- Rows already on file keep `false` until they are replaced. The hold pairs carrying
  legs overnight are therefore not repriced mid-contract (review finding 8).
- Recenter books never get it.
- `DESK_CHAIN_FORWARD=future` in the supervisor's environment, read at boot,
  overrides every book back to the future mid — except a hold-to-expiry book, which
  keeps the forward its row names (see F9).

The view reports `forwardSource` (`parity`, `index-carry`, `future`, `proxy`). The
host passes it to the engine (F7) and the mark journal records it.

### F2. Paper fills on the touch

Every gateway-simulator paper book is affected: delta-lean, recenter, and every
playbook. The hosted runner's paper rail is unaffected.

- A resting BUY limit fills at the ask when `ask ≤ limit`.
- A resting SELL limit fills at the bid when `bid ≥ limit`.
- Otherwise the old trade-through rule applies.
- Stop orders are unchanged.

**The paper record breaks at the deploy.** Fills from that day pay the spread.

### F3. The expiry-day price buffer on the decision path

An engine decision whose trigger starts with `dl-`, **or is `eod`**, and whose book's
contract expires today (IST) is priced with the 10% expiry buffer the submit path
already uses.

- No recenter preset in use emits `eod`; `recenter-relief-r` has `eod_flat_min` 0.
- On a recenter book's own expiry day, a 15:15 sweep would take the buffer too. That
  is the intended behaviour for an exit on a dying contract.

### F4. Same-strike opens carry `add: true` (playbooks only)

**Not changed for delta-lean.** Its refusals coincide with its better days (+₹50,761
against −₹27,939), so releasing them is a strategy change, left to the operator
(§11, G2).

### F5. A full-session spot ring

- `SPOT_RING_CAPACITY` goes from 4,096 to 32,768 samples (about 9 h at 1 Hz).
- `SpotRing` gains:
  - `latest()`;
  - `range(fromMs, toMs)`;
  - `filteredRange(fromMs, toMs)`. Its high and low are the extremes of the running
    median-of-3, so one bad print never becomes an extreme. It also returns the
    largest gap between consecutive samples (`maxGapMs`).

### F6. The previous close on `md.spot`

`apps/marketdata` adds `prevClose` (the full-mode index tick's `ohlc.close`, the
previous session's close) to every `md.spot` frame when it is a finite positive
number. The supervisor keeps the latest per symbol. Absent means unknown.

### F7. Three host facts the engine cannot see

`DeltaLeanInputs` gains three OPTIONAL fields. The playbook frame reads them;
`decideDeltaLean` ignores them. Absent means unknown.

- `prevClose` (F6);
- `inFlight`: true while the book has a decision in flight or a working package.
  This closes the paper-fold race, where `pendingLots` reads 0 before the fill is in
  `desk-books`;
- `forwardSource` (F1).

### F8. An `eod` pass over a working playbook exit stands down

`alreadyWorking` treats a working `DL_EXIT_TRIGGERS` package as the same exit for an
`eod` decision. The 14:55 urgent pass still pre-empts a passive one, because work
modes are ranked.

### F9. No engine switch under held legs

The registry PATCH refuses (409) a change to `delta_lean_enabled` or `pb_playbook`
on a book that holds legs — and, after the integration review, to `dl_parity_forward`:
flipped under held legs it re-reads every delta off a forward 300-odd points away and
trades on it. It refuses as well while the supervisor still has a decision working on a
book that is flat on file (a stage-1 wing resting before its fill). For the same reason
as the forward dial, `DESK_CHAIN_FORWARD=future` does not move a hold-to-expiry book:
those carry legs across the restart that sets the switch.

## 4. The playbook frame

### 4.1 Selection and the old-build fail-safe

- **A playbook book** is `delta_lean_enabled: true` with `pb_playbook` 1-6. The host
  dispatches to `decidePlaybook`. Ring, cadence, budgets, the exit fast path,
  pre-emption, the folds and the day guard are inherited unchanged.
- **The roll** treats playbooks as their own family (§4.9).
- **D9.** Every playbook preset sets `dl_open_lots: 0`, so a supervisor that drops
  `pb_playbook` runs `decideDeltaLean`, which cannot open anything.
- **Restarts.** desk-api must restart together with the supervisor. It writes rule
  state on Protect, and an old hydrator would drop `pb`.

### 4.2 What a playbook reads each pass

| Name | Meaning |
|---|---|
| `S` | The newest index level (`ring.latest()`). Every **index rule** reads `S`: day statistics, excursions, boxes, index stops and the stage-2 abort. While `S` is stale they are skipped. |
| steadied `S` | The median of the newest three index prints within 30 s (`steadySpot`). Read wherever one bad print would otherwise act at once: the stage-2 abort, a trade's `stageSpot` and `entrySpot`, the Reversal's back-to-the-open, Trend Drive's pyramid extension and the flies' move-from-the-open gate. |
| `F` | The chain forward (`chain.spot`). Used only for **strike selection and greeks**. |
| `ATM`, `STR` | The strike nearest `F`, and the ATM straddle mid |
| `MTE`, `imp(m)` | Trading minutes to expiry, and `STR × √(m / MTE)`. `impliedWindowMove` takes seconds. |
| `Dday` | `STR × √(min(375, MTE) / MTE)`, frozen at the first straddle reading at or after 09:16 |
| `O`, `H`, `L` | Open, filtered high, filtered low. `dayComplete` means the first fold was at or before 09:16:00. `dayRobust` means `dayComplete` and `maxGapMs ≤ pb_max_gap_min`. |
| `gapPct` | `100 × (O − prevClose) / prevClose` when both are known |
| `tradingDte` | Trading sessions after today up to and including expiry, holidays removed |
| `working` | `pendingLots > 0` or `inFlight` |
| `forwardOk` | `forwardSource` is `parity` or `index-carry` |
| `tradePnl` | `totalPnl − pb.basePnl` while a trade is open |
| `cost` | Σ side × entry × qty over held legs: + debit, − credit |

### 4.3 Decision order, every pass

The first step that answers wins.

| Step | Name | What it does |
|---|---|---|
| 0 | Day roll | `rollDay`, which resets `pb` |
| 1 | Latched stop | Close what is left, D2 order, urgent |
| 2 | Clock | 14:50 passive, 14:55 urgent, 15:00 ladder, D2 order. Latches once flat. |
| 3 | Day backstop | `totalPnl ≤ −dl_day_max_loss`, held `pb_rupee_hold_s` → urgent, latch the day. At once at 1.25 × the floor or worse, or with no legs held. |
| 4 | Day target | `totalPnl ≥ dl_day_target`, held `pb_rupee_hold_s` → ladder, latch the day. At once with no legs held. |
| 5 | Fold | Day statistics from the filtered ring, `Dday`, the regime stamp |
| 6 | Exit latch | `exiting`: re-send the D2-ordered close, escalating to urgent after 60 s or on a hard-stop condition. Flat with nothing `working` → finish the trade. |
| 7 | Stage 1 incomplete | `stage = 1`: (a) the hard stop applies first; (b) while `working`, wait; (c) a protective leg missing with nothing working → abort; (d) all held → stamp `stageReadyMs`, go to step 8 |
| 8 | Stage 2 | `stage = 1` and ready, or `stage = 2`: see §4.6 |
| 9 | Manage | Legs held: the common exits (§4.5), then the playbook's exits, then adds |
| 10 | Flat bookkeeping | Trade open, no legs, nothing working → finish the trade |
| 11 | New-risk gates | See below |
| 12 | Enter | The playbook's rule → a plan → stage 1 |

**The new-risk gates (step 11).** They also gate stage 2 and adds, minus the entry
window:

- a trading day;
- the contract matches the preset (`pb_expiry_day_only` → it expires today;
  `tradingDte ≥ pb_min_dte`);
- inside the entry window and after `dl_warmup_min`;
- entries left and not done for the day;
- the re-entry cooldown has run;
- `now − dlLastAdjustMs ≥ pb_retry_s`;
- no repair hold and nothing `working`;
- `S` fresh;
- the chain fresh: `now − chain.asOf ≤ 10 s` **and** the newest option quote is
  ≤ 10 s old;
- `forwardOk`;
- the regime is not `unknown`;
- `STR` readable;
- the gap gates (D10) when `gapPct` is known.

A mismatched contract is journalled every pass. Exits never wait on these gates.

### 4.4 State (`RuleState.pb`)

`pb: PlaybookState` is nested and required. It has `EMPTY_PLAYBOOK_STATE` and an
engine-owned hydrator; the keys are hydrated in the `EMPTY` order because
`sameRuleState` compares with `JSON.stringify`. The day statistics are written only
when they change (a new extreme, the open, a new largest gap), so a quiet pass does
not write.

| Field | Meaning |
|---|---|
| `dayOpen`, `dayHigh`, `dayLow`, `statsFromMs`, `maxGapMs`, `dayImplied` | The day statistics |
| `entries`, `doneForDay`, `lastExitMs` | Trade counting |
| `tradeOpenMs`, `side`, `entrySpot`, `entryStr`, `entryExtreme`, `boxHi`, `boxLo`, `basePnl` | The trade |
| `stage`, `planShorts[{strike, optType, cover}]`, `planLots`, `stageMs`, `stageReadyMs`, `stageSpot` (`S`) | Staging |
| `peakPnl`, `trailArmed`, `adds`, `condSinceMs`, `rupeeSinceMs` | Management |
| `exiting`, `exitReason`, `exitUrgency`, `exitMs` | The exit latch |
| `dayLineSinceMs` | The day backstop's and day target's debounce clock (steps 3-4). A day field: a trade's finish leaves it. |

Every playbook open (stage 1, stage 2, add) stamps `dlLastAdjustMs = now` in
`stateAfter`. The host's rollback keeps that stamp, so a refused package is retried
no sooner than `pb_retry_s` later. Stage 2 retries no sooner than `pb_stage_gap_s`.

**Which outcomes refund an entry.** A first post that desk-api skips entirely rolls
back to `markState`, so the entry is refunded. A FAILED decision, a DONE with no
fills, or a replay keeps `stateAfter`: the entry is spent, and step 10 finishes the
empty trade.

### 4.5 Exits, latches and re-entry

**A playbook exit** has trigger `dl-exit`, which is in `TRIGGERS` and in
`DL_EXIT_TRIGGERS`.

- It latches `pb.exiting` with its reason, urgency and `exitMs`.
- Each pass sends the **D2 close**: buy back every short; once no short remains,
  sell the longs.
- A passive exit becomes urgent after 60 s, or as soon as `tradePnl ≤ −pb_trade_max_loss`.
- The frame's day exits (steps 1-4) use the same D2 close.

**Common exits**, in order:

| Exit | Fires when | Urgency |
|---|---|---|
| Hard stop | `tradePnl ≤ −pb_trade_max_loss`, held `pb_rupee_hold_s` | urgent |
| Playbook exits | §5 (rupee-based ones also held `pb_rupee_hold_s`) | per playbook |
| Trailing floor | Armed once `tradePnl ≥ pb_trail_start`, or `pb_late_trail_start` from `pb_late_min` (0 = off). Fires when `tradePnl ≤ pb_trail_keep × peakPnl`, held `pb_rupee_hold_s`. A floor that arms late (never armed before `pb_late_min`) starts `peakPnl` at the P&L it armed on, not at the morning's best. | urgent |
| Take profit | `tradePnl ≥ pb_trade_target` (0 = off), held `pb_rupee_hold_s`. On a whole debit spread (one long, one short, the same lots, every short held) the line is at most `pb_target_max_frac` × its maximum profit. | passive |
| Time exit | minute ≥ `pb_time_exit_min` (0 = off) | passive, final |

**Finishing a trade** happens when the book is flat and nothing is `working`. It
clears the trade fields and sets `lastExitMs`. It latches `dlStopped` if
`doneForDay` or `entries ≥ pb_max_entries`.

**Unknown legs.** Legs held with no trade open → an urgent `dl-exit`.

### 4.6 Opening, staging and adds

A plan has `protective` buys (1 lot each), `shorts` as `{strike, optType, cover}`,
`side`, `lots` and stamps. `cover` is the strike of the same-type protective long
that covers that short.

1. **Size.** `fitLots` on the whole structure against `margin_cap`. 0 lots → wait.
2. **Stage 1.** Route the protective buys (`dl-open`, passive). Stamp the trade,
   `entries + 1`, the plan, `stage = 1` (or 0 when there are no shorts),
   `stageMs`, `stageSpot = S` and `dlLastAdjustMs`.
3. **Stage 1 completes** (§4.3 step 7) when every protective leg is held and nothing
   is working. Stamp `stageReadyMs`. If 300 s pass from `stageMs` without that
   happening → abort.
4. **Stage 2.**
   - Each short is sold at `min(planLots, held lots of its cover leg)`. A cover at 0
     → abort.
   - **Abort** (urgent `dl-exit`, D2 close) when any of these holds:
     - `|S − stageSpot| > pb_stage_abort_k × STR` with `S` fresh (steadied), while a
       short is still unsold. Once every short is held the package is whole, and a
       market that kept moving is no reason to close it;
     - `now − stageReadyMs > 120 s` while a short is still unsold;
     - a planned short is not tradable at the end of that window.
   - A null `STR` or a stale `S` means wait, not abort.
   - The new-risk gates (minus the window) apply. Under a gate, stage 2 waits; its
     timer still runs.
   - After routing, `stage = 2`. With nothing working:
     - every short held at its size → `stage = 0`;
     - a short missing → re-send it no sooner than `pb_stage_gap_s`;
     - still missing 120 s after `stageReadyMs` → abort.
5. **Adds (pyramid).** A single bought option (`dl-add`, one stage). Same-strike adds
   carry `add: true`. Adds pass the new-risk gates minus the window.
6. **Strikes the book holds on the opposite side are never chosen.**

### 4.7 Strike selection and liquidity

| Mode | Used by | Rule |
|---|---|---|
| Delta bands | Trend Drive, Reversal | delta-lean's bands: buy 0.55-0.65, sell 0.20-0.30 strictly further OTM. The short's cover is the long. |
| Straddle units | Expiry Drive | Long = ATM. Short = the first strike ≥ max(1 step, `pb_short_str_k × STR`) beyond it. |
| Fly | Wing Straddle, Expiry Theta | Centre = ATM. Wings at ± max(`pb_wing_min_steps`, round(`pb_wing_str_k × STR / step`)) steps. CE short covered by the CE wing; PE short by the PE wing. |
| OTM single | Expiry Gamma | The `pb_otm_steps`-th strike beyond `F` |

**Liquidity is tested per wing** (playbook kit only; delta-lean's `tradableStrikes` is
untouched):

- a two-sided quote, with a spread at most max(`dl_max_spread_pct` × mid,
  `dl_max_spread_abs`); for a **protective** leg the rupee floor is the larger of
  `dl_max_spread_abs` and `pb_wing_spread_abs` (₹2) — a far SENSEX wing at ₹20-40 is
  often ₹1-3 wide (the 16 Oct close), and a ₹1 bar would leave a fly with no wing to buy;
- an age at most `dl_quote_fresh_s` for shorts and ATM legs, and at most
  `pb_wing_fresh_s` for protective wings.

### 4.8 Triggers

| Trigger | Meaning |
|---|---|
| `dl-open` | Stage 1 and stage 2 of an entry |
| `dl-add` | A pyramid add |
| `dl-exit` | A playbook exit (stop, trail, profit, time, abort, unknown legs). The reason names which. Reports label it "Exit". |
| `dl-stop`, `dl-target`, `eod` | Frame day exits |

### 4.9 The roll: a third family

The playbooks have their own create and retire in `scripts/delta-lean-roll.mjs`.
That keeps them out of the daily four's single-target-expiry check and out of the
"others" loop (review finding 3).

- **Membership.** The dials: `delta_lean_enabled === true` and `pb_playbook ≥ 1`,
  never `variant ∈ PLAYBOOK_PRESET_KEYS` — that list is what the roll creates, and
  a preset switched off by removing its key still has rows to retire. A variant in
  that list without those dials, a `pb_playbook` other than 0 without
  `delta_lean_enabled`, or playbook dials under a daily or hold variant, is an
  anomaly.
- **Contract.** The nearest listed expiry with `tradingDte ≥ pb_min_dte`.
- **Expiry presets** are created only when the symbol's nearest expiry is today. The
  first date they may be created is the constant `PLAYBOOK_EXPIRY_FROM = '2026-10-21'`,
  so the first playbook session runs the intraday presets alone.
- **Create.** Missing → create, start, switch paper on. Stopped and flat, created
  today and never started (no write on the row since its create: `updatedAt` =
  `createdAt`, `actual: stopped`, no `lastMarkAt`) → start it. Any other stopped
  row, one stopped by hand after its start included → ATTENTION.
- **Retire.** A row created before today: flat → stop and erase; every open leg on
  a contract that expired before today (O23's unsold 0-DTE wing) → settle at
  intrinsic (`settle-expired`), then stop and erase, as the other families do — a
  refused settle leaves it in ATTENTION; a leg on a live contract → an ALARM, left
  untouched; unreadable → an ALARM.
- **Gate.** The engine on disk must know `pb_playbook`; otherwise ATTENTION and exit 1,
  while the other families still roll.

## 5. The six playbooks

All sizes are per leg. NIFTY: lot 65, step 50. SENSEX: lot 20, step 100.

### 5.1 Trend Drive (`pb-trend-drive`, id 1, intraday)

- **Contract:** `tradingDte ≥ 1`.
- **Window:** 09:30-10:15.
- **Gate:** `|gapPct| ≥ 0.25` when known.
- **Signal:** the slow regime is a trend, held ≥ 120 s, agreeing with `sign(S − O)`
  when `dayComplete`.
- **Structure:** a debit spread by delta bands, 2 lots, two stages.
- **Pyramid:** at most one add, a single 1-lot long in the long band. It needs
  `tradePnl > 0`, the trend still holding (≥ 120 s), and the steadied `S` at least
  0.5 × `Dday` beyond `entrySpot`.
- **Own exits:**
  - **debit stop:** `tradePnl ≤ −0.4 × cost`, held;
  - **flip:** the opposite trend held ≥ 90 s **and** `tradePnl ≤ 0`.
- **Common exits:** hard stop ₹6,000; trail off before 13:00, armed at ₹2,000 from
  13:00, floor 60%; take profit ₹12,000, capped at 0.7 × the held spread's maximum
  (`pb_target_max_frac`). A 1-DTE band spread tops out at about ₹9-11.7k at 2 lots on
  SENSEX (10-16% IV) and about ₹10.7k on NIFTY's Monday contract at 12%.
- **Day:** one trade. Backstop ₹9,000; day target ₹15,000 (never binds before the
  take profit).

### 5.2 Wing Straddle (`pb-wing-straddle`, id 2, intraday)

The long-dated short straddle of the BULL_S_1 evidence, with wings, at 1 lot.

- **Contract:** `tradingDte ≥ 5`. NIFTY trades the contract a week or more out; so
  does SENSEX.
- **Window:** 09:30-12:30.
- **Gates:** `|gapPct| < 0.6` when known, and `dayComplete` with
  `|S − O| ≤ 0.75 × Dday` (steadied `S`).
- **Signal:** the slow regime is `quiet` or `chop`, held ≥ 120 s.
- **Structure:** sell the ATM CE and PE; wings at ± max(4 steps, round(1.5 × STR /
  step)); **1 lot**; two stages. (First drafted at 2.0 × STR. That put a SENSEX wing 25-30
  strikes out on a contract five or more sessions away, where it would seldom pass the
  liquidity bar. At 1.5 × STR the fly's worst loss at one lot is about 1.1-1.5 × the
  ₹12,000 day stop, against about 2-2.5 × at 2.0 × STR.)
- **Own exits:**
  - **combined stop** (the working exit): the shorts' ask-side value reaches 1.25 ×
    their entry value, held;
  - **index stop:** `|S − entrySpot| ≥ 1.0 × entryStr`, held 20 s.
- **Common exits:** hard stop ₹8,000, above the combined stop's ~₹4.5-6.5k at 1 lot;
  trail from 13:00 at ₹2,000, floor 50%; take profit ₹6,000.
- **Day:** up to 2 trades, 20-minute cooldown. Backstop ₹12,000.

### 5.3 Reversal Spread (`pb-reversal`, id 3, intraday)

- **Contract:** `tradingDte ≥ 1`.
- **Window:** 10:00-13:30.
- **Precondition:** `dayRobust`. The morning excursion (`H − O` or `O − L`, whichever
  is larger) is ≥ 0.6 × `Dday`.
- **Signal:** `S` has given back ≥ 35% of the excursion and is still on the
  excursion's side of `O`; the slow regime is the counter-trend, held ≥ 120 s.
- **Structure:** a debit spread by delta bands in the reversal direction, 2 lots,
  two stages. Stamps `entryExtreme`.
- **Own exits:**
  - **new extreme:** `S` beyond `entryExtreme` by 0.1 × `Dday`, held 20 s;
  - **flip back:** the original direction held ≥ 90 s and `tradePnl ≤ 0`;
  - **debit stop:** 0.4 × cost, held;
  - **back to the open:** `S` reaches `O` (passive).
- **Common exits:** hard stop ₹6,000; trail ₹2,000 from 13:00, floor 60%; take
  profit ₹12,000, capped at 0.7 × the held spread's maximum, as on Trend Drive.
- **Day:** one trade. Backstop ₹9,000.

### 5.4 Expiry Drive (`pb-expiry-drive`, id 4, 0-DTE)

- **Contract:** today's expiry.
- **Window:** 09:30-10:15.
- **Gate:** `|gapPct| ≥ 0.25` when known.
- **Signal:** a trend held ≥ 90 s, agreeing with `sign(S − O)`.
- **Structure:** a debit spread in straddle units: buy the ATM strike, sell the first
  strike ≥ max(1 step, 1.0 × STR) beyond it. 2 lots, two stages. (The first draft's
  0.6 × STR made a one-step spread on a 0-DTE morning, whose take profit sat at or
  above its maximum and whose hard stop sat above its debit.)
- **Own exits:**
  - **debit stop:** 0.5 × cost, held;
  - **flip:** 60 s, only when losing.
- **Common exits:** hard stop ₹4,000; trail armed at ₹3,000, floor 60%; take profit
  ₹5,000 (about 60-70% of the spread's maximum), capped at 0.7 × it: a two-step
  SENSEX pair on a calm morning tops out near ₹5,300; **time exit 12:00**.
- **Day:** one trade. Backstop ₹6,000.

### 5.5 Expiry Theta Fly (`pb-expiry-theta`, id 5, 0-DTE)

- **Contract:** today's expiry.
- **Window:** 13:00-14:15.
- **Signal:** `quiet` or `chop`, held ≥ 120 s.
- **Calm gate:** the index range over the last 30 minutes is ≤ 1.5 × `imp(30)`, with
  at least 90% ring coverage. The expected range is about 2 × `imp`, so this asks
  for a calmer-than-priced half hour.
- **Day gate:** `dayRobust` and `|S − O| ≤ 1.2 × Dday` (steadied `S`).
- **Structure:** an iron fly at the ATM strike; wings at ± max(2 steps, round(1.25 ×
  STR / step)); 2 lots; two stages.
- **Own exits:**
  - **trend exit:** the slow regime is a trend held ≥ 60 s, which is the start of a
    gamma blast;
  - **take profit** at 50% of the credit (passive), held `pb_rupee_hold_s`.
- **No index stop.** On a 0-DTE afternoon a stop at 0.6 × STR is touched on most days
  under the straddle's own variance. The hard stop and the wings bound the loss
  instead.
- **Common exits:** hard stop ₹4,000. On SENSEX the wings' maximum loss can sit
  below it.
- **Day:** up to 2 trades, 15-minute cooldown. Backstop ₹8,000.

### 5.6 Expiry Gamma Breakout (`pb-expiry-gamma`, id 6, 0-DTE)

There is no direct evidence for this one. It is the long-gamma hedge of §5.5, and
its loss is capped by its budget.

- **Contract:** today's expiry.
- **Window:** 12:30-14:30.
- **Box:** the filtered index range over `[now − 60 min, now − 5 min]`, with at least
  90% coverage and width ≤ 1.5 × `imp(60)`.
- **Signal:** `S` beyond the box by 0.5 × `imp(5)`, at or beyond the day's filtered
  extreme (`dayRobust`), with the slow regime that trend, held ≥ 30 s.
- **Structure:** buy the first OTM strike beyond `F`, with
  lots = floor(₹6,000 / (ask × lot)), capped at 4. 0 lots → no trade. One stage.
- **Own exits:**
  - **premium stop:** `tradePnl ≤ −0.5 × cost`, held;
  - **back in the box:** by 0.5 × `imp(5)`, held 30 s;
  - **premium trail:** armed at `tradePnl ≥ 0.8 × cost`, floor 60% of peak.
- **Common exits:** hard stop ₹4,000.
- **Day:** up to 2 trades, 10-minute cooldown. Backstop ₹8,000.

## 6. How the six behave together, by day type

"+" earns, "−" is a bounded loss, "0" is no trade or flat.

| Day type (share) | Trend Drive | Wing Straddle | Reversal Spread |
|---|---|---|---|
| Range (about 50%) | 0 when the gap is under 0.25%. Otherwise a false trend open can cost a debit stop (in the record, range days opened trend spreads that won 29%). | **+** decays | 0 |
| Gap-and-go (about 20-25%) | **+** (the record's profit sits here) | 0 (gap ≥ 0.6% or trend) or one stop | 0 |
| Trend day | **+** | − one stop, then no re-entry while it trends | 0 |
| Gap-fade | − a debit stop, or 0 | + once calm | **+** |
| V-reversal | − (the flip exit fires only when losing) | − or 0 | **+** |
| Whipsaw | − one stop | − up to two stops | − one stop at most |

On an expiry day, on the symbol whose contract expires:

| Afternoon | Expiry Theta Fly | Expiry Gamma Breakout |
|---|---|---|
| Calm, pinned | **+** | 0 |
| A late breakout | − trend exit or hard stop, inside the wings | **+** |
| Whipsaw | − up to two stops | − up to two premium stops |

Expiry Drive is out by 12:00.

**The worst plausible day per symbol** is a wide two-way chop: Trend Drive ₹6k,
Wing Straddle ₹8k + ₹4k behind its ₹12k backstop, Reversal ₹6k, so about ₹24k. On an
expiry day add up to ₹4k + ₹8k + ₹6k.

## 7. Scenario catalogue

Every row is a scenario-suite or unit test unless it is marked *(host)*, *(roll)* or
*(api)*.

### 7.1 Market

| # | Scenario | Expected |
|---|---|---|
| M1 | Trend up in bursts of ≥ 2.5 × the 5-minute implied move, after a 0.4% gap | Trend Drive enters up by 10:15, adds once, and ends positive. Wing Straddle and Reversal stay out. |
| M2 | Trend down | The mirror of M1 |
| M3 | Gap up 1 × `Dday` and go | Trend Drive enters and is positive. Wing Straddle stays out (gap ≥ 0.6%, or trend). |
| M4 | Gap up, then a fade to the previous close | Reversal enters down and is positive. Trend Drive's loss is bounded. |
| M5 | Tight range, gap under 0.25% | Trend Drive stays out (gap gate). Wing Straddle enters and is positive at the close. |
| M6 | Wide two-way chop | Every book's loss is within its stops and backstop |
| M7 | Morning trend up, then a V below the open | Trend Drive's loss is bounded. Reversal enters down and is positive. |
| M8 | Quiet morning, trend after 11:00 | Trend Drive stays out. Wing Straddle's combined or index stop fires, inside the hard stop. |
| M9 | IV +30% in 5 minutes with a 1% move | Wing Straddle exits on its combined stop or hard stop |
| M10 | IV crush | Wing Straddle and Theta Fly gain |
| M11 | One bad index print 1% away | No entry and no stop fires on it. `H`/`L` do not take it (median-of-3). |
| M12 | Expiry day, calm and pinned | Theta Fly enters 13:00-14:15 and is positive. Gamma stays out. |
| M13 | Expiry day, calm, then a 1.5 × STR break at 13:40 | Theta Fly takes its trend exit or hard stop, and the loss is at most the wings' maximum. Gamma enters on the break and is positive. |
| M14 | Expiry morning trend | Expiry Drive enters by 10:15 and is flat by 12:00 |
| M15 | Expiry day, two false breaks | Gamma takes at most 2 trades, and loses at most 2 × 50% of what it paid |
| M16 | NIFTY's holiday-moved Monday expiry (19 Oct) | *(roll)* The NIFTY intraday books trade 27 Oct. No expiry books before `PLAYBOOK_EXPIRY_FROM`. |
| M17 / M18 | IV at half, and at twice, the usual level | Behaviour scales with `STR`; `fitLots` may trim |
| M19 | A gap under 0.25% that trends after the open | Trend Drive stands down. This is the gate's cost: a missed trade. |
| M20 | A 0.8% gap, quiet until 10:30 | Wing Straddle stands down (gap ≥ 0.6%) |

### 7.2 Data and operations

| # | Scenario | Expected |
|---|---|---|
| O1 | Index stale | No new risk. Index rules are skipped; rupee stops and the clock run. |
| O2 | Option quotes frozen while the index ticks | No new risk (the newest-option-quote age gate) |
| O3 | A wing with no two-sided quote | No plan forms. At stage 2, an untradable short past the window → abort. |
| O4 | The market moves 0.3 × STR between the stages | Abort with the D2 close. Coverage holds on every pass. The same move after every short is held aborts nothing. |
| O5 | Stage 1 refused outright | Rolled back to `markState`; the entry is refunded; the retry waits `pb_retry_s` |
| O6 | An exit partly fills | The latch re-sends, shorts first, until flat. After 60 s it goes urgent. |
| O7 | The desk guard flattens the tag | The switch is off and the book is flat, so the host does not call decide. Nothing more happens that day. |
| O8 | Supervisor restart mid-trade *(host)* | `pb` survives. Index rules wait for fresh samples. Box and calm windows the ring does not cover → no entry. |
| O9 | The supervisor starts after 09:16 | `dayComplete` false: Reversal, Wing Straddle and Theta Fly do not trade; Trend Drive skips the open-direction test |
| O10 | An old supervisor build *(host)* | `pb_*` dropped → `decideDeltaLean` with `dl_open_lots` 0 → never opens |
| O11 | The wrong contract | No entry, journalled; exits run |
| O12 | An index halt | O1, and the structures bound the loss |
| O13 / O14 | The order budget, or the margin cap | An open waits whole; `fitLots` truncates |
| O15 | A trade open into the close | The 14:50/14:55/15:00 clock with the D2 close |
| O16 | One protective leg fills and the other is skipped or cancelled | Abort; no short is ever sold. Coverage holds. |
| O17 | Stage 2 fills one short and not the other | Re-sent; still missing after 120 s → abort. Coverage holds. |
| O18 | The paper-fold race: `pendingLots` 0, `inFlight` true, the leg not yet in `desk-books` | No finish-trade and no stage 2 until `inFlight` clears |
| O19 | A spread spike or a one-sided quote on an ATM leg for one pass | No rupee rule fires: no stop, take profit, day backstop or day target (held `pb_rupee_hold_s`) |
| O20 | The forward falls back to `future` (`DESK_CHAIN_FORWARD=future`, or no index) | No new risk; exits run |
| O21 | desk-api and the supervisor on different builds | *(host/api)* Documented. Restart both together. |
| O22 | A retune of `pb_playbook` or `delta_lean_enabled` with legs held | *(api)* 409 |
| O23 | A 0-DTE long wing with no bid at 14:55 | The D2 close buys the shorts back first. The wing's sale goes out on the ladder, and paper fills it on the touch or a print. |
| O24 | A refused-open retry storm | At most one attempt per `pb_retry_s`, and one per `pb_stage_gap_s` for stage 2 |
| O25 | `eod` arrives while a passive `dl-exit` is working | *(host)* It stands down until 14:55, then escalates |

## 8. Dials and presets

### 8.1 New dials

`dl_parity_forward` (default false) is in the delta-lean section, which grows to 41.
Everything else is in the collapsed `playbook` section and is inert at
`pb_playbook` 0.

| Dial | Default | Meaning |
|---|---:|---|
| `pb_playbook` | 0 | 1-6 select §5.1-5.6 |
| `pb_min_dte` | 1 | trading days to expiry, at least |
| `pb_expiry_day_only` | false | the contract must expire today |
| `pb_lots` | 2 | lots per leg |
| `pb_entry_start_min`, `pb_entry_end_min` | 570, 615 | entry window |
| `pb_max_entries`, `pb_reentry_cooldown_s` | 1, 1200 | trades a day; seconds between them |
| `pb_confirm_s` | 120 | the regime must hold this long |
| `pb_trade_max_loss`, `pb_trade_target` | 5000, 10000 | ₹ hard stop; ₹ take profit (0 = off) |
| `pb_trail_start`, `pb_late_trail_start`, `pb_late_min`, `pb_trail_keep` | 4000, 2000, 780, 0.6 | the trailing floor |
| `pb_time_exit_min` | 0 | minute of a final exit (0 = off) |
| `pb_stop_hold_s`, `pb_rupee_hold_s` | 20, 3 | how long index rules, and rupee rules (stops, the trail, both take profits, the day backstop and target), must hold |
| `pb_strike_mode`, `pb_short_str_k` | 0, 0.6 | delta bands or straddle units |
| `pb_debit_stop_frac`, `pb_target_max_frac`, `pb_flip_confirm_s` | 0.5, 0, 90 | debit stop; the take profit's ceiling, a share of a whole debit spread's maximum profit (0 = off); the flip (losing trades only) |
| `pb_max_adds`, `pb_add_ext_k` | 0, 0.5 | the pyramid |
| `pb_wing_str_k`, `pb_wing_min_steps`, `pb_wing_fresh_s`, `pb_wing_spread_abs` | 1.25, 2, 30, 2 | fly wings (the last: a protective leg's rupee spread floor) |
| `pb_combined_stop`, `pb_stop_str_k`, `pb_trend_exit_s` | 0, 0, 0 | short-premium stops (0 = off) |
| `pb_calm_min`, `pb_calm_mult`, `pb_max_move_k`, `pb_target_frac` | 0, 1.0, 0, 0 | short-premium gates and the take profit |
| `pb_gap_min_pct`, `pb_gap_max_pct` | 0, 0 | gap gates (0 = off) |
| `pb_stage_abort_k`, `pb_retry_s`, `pb_stage_gap_s`, `pb_max_gap_min` | 0.25, 30, 10, 5 | staging and robustness |
| `pb_rev_min_ext`, `pb_rev_retrace`, `pb_rev_stop_k` | 0.6, 0.35, 0.1 | Reversal |
| `pb_box_min`, `pb_box_max_k`, `pb_brk_buf_k` | 60, 1.5, 0.5 | Gamma box |
| `pb_premium_budget`, `pb_gamma_max_lots`, `pb_otm_steps`, `pb_prem_stop_frac`, `pb_prem_trail_arm` | 6000, 4, 1, 0.5, 0.8 | Gamma sizing and exits |

### 8.2 The six presets

All six are `DELTA_LEAN_BASE` (which now includes `dl_parity_forward: true`) plus
`dl_open_lots: 0`.

| Dial | Trend Drive | Wing Straddle | Reversal | Expiry Drive | Expiry Theta | Expiry Gamma |
|---|---:|---:|---:|---:|---:|---:|
| `pb_playbook` | 1 | 2 | 3 | 4 | 5 | 6 |
| `pb_min_dte` / expiry-only | 1 / no | 5 / no | 1 / no | 0 / yes | 0 / yes | 0 / yes |
| `pb_lots` | 2 | **1** | 2 | 2 | 2 | (budget) |
| window | 570-615 | 570-750 | 600-810 | 570-615 | 780-855 | 750-870 |
| entries / cooldown s | 1 | 2 / 1200 | 1 | 1 | 2 / 900 | 2 / 600 |
| `pb_confirm_s` | 120 | 120 | 120 | 90 | 120 | 30 |
| hard stop / take profit ₹ | 6,000 / 12,000 | 8,000 / 6,000 | 6,000 / 12,000 | 4,000 / 5,000 | 4,000 / 0 | 4,000 / 0 |
| take profit ceiling (`pb_target_max_frac`) | 0.7 | — | 0.7 | 0.7 | — | — |
| trail start / late / keep | 0 / 2,000 / 0.6 | 0 / 2,000 / 0.5 | 0 / 2,000 / 0.6 | 3,000 / 3,000 / 0.6 | off | premium trail |
| time exit | — | — | — | 720 | — | — |
| gap gate | ≥ 0.25 | < 0.6 | — | ≥ 0.25 | — | — |
| structure | bands; debit 0.4; flip 90; 1 add at 0.5 `Dday` | wings 1.5 STR ≥ 4 steps; combined 0.25; index stop 1.0 `entryStr`, 20 s; max move 0.75 | bands; debit 0.4; flip 90; ext 0.6, retrace 0.35, stop 0.1, 20 s | straddle units 1.0; debit 0.5; flip 60 | wings 1.25 STR ≥ 2 steps; calm 30 min ≤ 1.5; max move 1.2; target 0.5; trend exit 60 s | box 60 min ≤ 1.5; buffer 0.5; budget 6,000; ≤ 4 lots; 1 step OTM; stop 0.5; trail arm 0.8; box stop 30 s |
| `dl_day_max_loss` / `dl_day_target` | 9,000 / 15,000 | 12,000 / 12,000 | 9,000 / 15,000 | 6,000 / 10,000 | 8,000 / 10,000 | 8,000 / 15,000 |
| desk guard (1.5×) | 14,000 | 18,000 | 14,000 | 9,000 | 12,000 | 12,000 |

## 9. Testing

- **Unit** (`packages/desk-engine`):
  - `forward.ts`;
  - `SpotRing.latest`, `range` and `filteredRange` (spike, wrap, gaps);
  - the frame: every step, every gate, the latch, D2 closes, escalation, staging,
    sizing, every abort, retry intervals, refund semantics, finishing only when not
    working;
  - each playbook's rules;
  - the hydrator round trip and the `EMPTY` pins;
  - the dial and preset pins.
- **Scenario suite** (test-only harness, `packages/desk-engine/test/scenario/`): every
  §7.1 row except M16, and O1-O6, O9, O11, O16-O20, O23 and O24.
  - Each run asserts the **coverage invariant**: on every pass and every option type,
    short lots ≤ long lots.
  - The harness gains fill-outcome injection: skip, partial, delay and fail, per
    order.
- **Host:**
  - dispatch;
  - `dl-exit` in `DL_EXIT_TRIGGERS`;
  - the `eod`-over-`dl-exit` stand-down;
  - `inFlight`, `prevClose` and `forwardSource` passed through;
  - the parity forward per book, and the `DESK_CHAIN_FORWARD` override;
  - ring capacity;
  - `pb` hydration.
- **API:**
  - F3 for `dl-*` and `eod`, with recenter triggers unchanged;
  - F9's 409;
  - the paper-lifecycle test updated to touch fills.
- **Roll:** the third family on 16, 19, 21 and 22 Oct; the expiry-from date; the
  engine gate; idempotency; the retire. The daily four and the hold pairs are
  unchanged.
- **Web:** the Playbook section, the delta-lean section at 41, `dl-exit` → "Exit".
- **Merged tree:** `DESK_REQUIRE_MONGO=1 make check` and `cd apps/web && npx tsc -b`.

## 10. Rollout

1. Merge, push, build the web (the agent's part).
2. **The operator restarts**, while the intraday books are flat (after 15:00 or before
   09:15):
   - desk-marketdata (for `prevClose`);
   - desk-api **and** desk-supervisor together;
   - desk-gateway (touch fills).
   - Never desk-runner.
   - The two hold pairs carry legs overnight. They keep the future forward
     (`dl_parity_forward` false on their rows), so the restart does not reprice them.
3. **The first playbook session is Mon 19 Oct**, a NIFTY expiry moved forward by
   Dussehra. It runs the three intraday presets on both symbols, 6 books.
   - The expiry presets start from 21 Oct (`PLAYBOOK_EXPIRY_FROM`), so the first is
     SENSEX on Thu 22 Oct.
   - The operator can move that date in one line.
4. **First-week checks** (runbook §8):
   - `pb_playbook`, `dl_parity_forward` and `modes.paper.enabled` on each row;
   - `forwardSource: parity` and a forward within 0.2% of the index;
   - every stage 1 followed by a stage 2 or an abort within 300 s;
   - the coverage invariant on `desk-books`;
   - fills at the touch.
5. **The paper record breaks on the deploy day** (F1 and F2). Compare new days with
   new days.

## 11. Out of scope and known gaps

| # | Finding | Recommendation |
|---|---|---|
| G1 | Delta-lean "flat" adjustments are naked short 0.45-0.60Δ and lost ₹1.46L | Only after 12:00, or remove them |
| G2 | Delta-lean same-strike adds refused | Leave until G1 is decided |
| G3 | The delta-lean quiet condor on 0-DTE | No condor on 0-DTE, or the next contract on expiry day |
| G4 | BULL_* uncapped pyramid; BULL_SNX_1 keyed off the future | Cap at 3 lots; `reference: 'index-spot'`; no SENSEX 0-DTE before 13:00 |
| G5 | EAGLE_S_1 has no stop and no cap | A day-loss guard |
| G6 | ORB_FUT exits are judged on index ticks | Filter by token; the record is not evidence until then |
| G7 | CHEETAH cannot trade | Fix or retire it |
| G8 | Mirrors: reverse entries, no dedupe; the source has been down since 11 Oct | Retire, or fix before any live use |
| G9 | `liveLots` resizes entries only | Fix before any hosted strategy goes live |
| G10 | The holiday table ends 2026-12-25 and fails open | Add 2027 before 2027-01-01 |
| G11 | SPAN-lite charges hedged structures about 10% of short notional | Calibrate before sizing above 2 lots |
| G12 | The gateway does not gate fills | Playbooks stage their own opens and exits (D2); other books are not covered |
| G13 | No event calendar | Rely on the regime, calm and gap gates and the stops |
| G14 | Special sessions (an early close, Muhurat) | The fixed 14:50-15:00 clock does not adapt; the operator stops books on those days |
| G15 | A short ATM leg with no quote at all is marked at its entry (mtm 0) | The rupee stops are blind to it; the day guard and the clock remain. Watch the journal. |
| G16 | A supervisor rollback mid-trade | `pb` is dropped; `decideDeltaLean` manages the legs by backstop, target and clock only. Roll back only while flat. |
| G17 | NIFTY's 1-DTE contract (the Monday before a Tuesday expiry) at about 10.5% IV or less forms no band spread at all. `dl_min_strike_gap` 1 excludes the ATM strike, and the one-step-ITM call is 0.655-0.68Δ at 9-10.5% IV, outside the 0.55-0.65 long band (the harness board; the forward just above a strike). Trend Drive and Reversal then cannot trade NIFTY on a low-vol Monday. SENSEX is unaffected: its 100-point step is 0.12% of the index. | Not changed. Candidate fixes: allow ATM in the long band for the playbooks (`dl_min_strike_gap` 0 on presets 1 and 3); widen the long band to about 0.55-0.70 on 1-DTE; or strike a 1-DTE spread in straddle units (`pb_strike_mode` 1, as Expiry Drive does). |
