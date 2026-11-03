# Delta-lean review: hold-and-adjust, 2026-09-23 to 2026-10-02

Written 2026-10-04 from read-only queries against the live `algomaker`
database and the pm2 logs on the desk box. Every query is in the appendix.
Branch `ws3-delta-lean-review`. Workstream WS3 of
`docs/superpowers/specs/2026-10-04-october-housekeeping-design.md`.

The window covers seven trading days: 09-23, 09-24, 09-25, 09-28, 09-29, 09-30
and 10-01. 10-02 was a holiday (Gandhi Jayanti). Each day has four books, two
symbols times two presets, so the sample is 28 book-days. All of it is paper.
The simulator fills a limit order only when a print trades through it
(runbook §5.1), so these numbers are paper numbers.

## Headline

- **Desk total: −₹50,204** across the four series. Realised is −₹46,419.
  The ₹3,785 difference is the long `SENSEX26O0171800PE` that both SENSEX books
  still hold, marked at 0.05. It expired worthless on 1 Oct.
- **Expiry days lost ₹70,014 over 6 book-days. Other days made ₹19,810 over
  22 book-days.** 1 Oct SENSEX alone accounts for −₹62,139 of the expiry total.
  Leaving 1 Oct out, expiry days still lost ₹7,875 over 4 book-days.
- **The losses on expiry days came from the opening package, not from the
  adjustments.** Opening packages on expiry days lost ₹71,624. Adjustments on
  those same days made +₹1,607 net, and the ones placed after 12:00 made
  +₹9,072.
- **No exit except the clock ever fired.** The day target (₹10,000) was never
  reached; the best intraday peak was ₹8,654. The stuck rule never armed
  once in 2,760 five-minute marks. The ₹2,00,000 backstop sat 4.7× above the
  worst day.
- **Two defects turned 1 Oct into a stranded leg.** Both are fixed on this
  branch, each with a test that failed before the fix:
  - (a) The supervisor latched its own cancel sweep, which swallowed the
    14:55 urgent flatten.
  - (b) desk-api never folded the gateway's late REJECTED verdict. Separately,
    the gateway queue document said "COMPLETE 80 @ 149.15" from the moment it
    was queued.
- **The first change I would make: size `dl_day_max_loss` to the book**:
  30,000 for aggressive and 15,000 for conservative (§3, R1). **Applied
  2026-10-05**; the desk day guard now arms at 45,000 / 23,000.

---

## 1. P&L by series, by day

### 1.1 Per series, per day (₹, `total` from `desk-daily-reports`; realised in brackets where it differs)

E marks an expiry day for that book's contract. NIFTY weeklies expire on
Tuesday 09-29. SENSEX weeklies expire on Thursdays, 09-24 and 10-01. A book's
`expiry` comes from its own decisions.

| Date | NIFTY aggressive | NIFTY conservative | SENSEX aggressive | SENSEX conservative | Day, all four |
|---|---:|---:|---:|---:|---:|
| 09-23 Wed | 1,446 | −374 | −1,663 | −866 | −1,457 |
| 09-24 Thu | 4,560 | 5,752 | **E** 3,346 | **E** −4,971 | 8,687 |
| 09-25 Fri | −4,852 | −1,554 | −7,337 | −446 | −14,189 |
| 09-28 Mon | 956 | 1,482 | 4,898 | 1,274 | 8,610 |
| 09-29 Tue | **E** −7,030 | **E** 780 | 4,514 | 3,595 | 1,859 |
| 09-30 Wed | 3,949 | 4,878 | 67 | 1,198 | 10,092 |
| 10-01 Thu | −2,613 | 946 | **E** −42,591 (−40,024) | **E** −19,548 (−18,330) | −63,806 |
| **Series** | **−3,584** | **+11,910** | **−38,766** (−36,199) | **−19,764** (−18,546) | **−50,204** |
| Winning days | 4/7 | 5/7 | 4/7 | 3/7 | |

These match the spec's State found. One correction to its wording: "every
large loss day is an expiry day" does not hold. SENSEX-aggressive lost ₹7,337
on 09-25 and NIFTY-aggressive lost ₹4,852 on 09-25, and neither was an expiry
day. The two very large losses are both 1 Oct SENSEX.

The 10-02 rows in `desk-daily-reports`, −2,567 and −1,218 for the two SENSEX
10-01 tags, are the stranded hedge being marked on a holiday. They are not
trading days and are left out above.

### 1.2 Expiry days against other days

| Series | Expiry book-days | P&L on expiry days | Other book-days | P&L on other days |
|---|---:|---:|---:|---:|
| NIFTY aggressive | 1 | −7,030 | 6 | +3,446 |
| NIFTY conservative | 1 | +780 | 6 | +11,130 |
| SENSEX aggressive | 2 | −39,245 | 5 | +479 |
| SENSEX conservative | 2 | −24,519 | 5 | +4,755 |
| **All** | **6** | **−70,014** | **22** | **+19,810** |

Every book-day ended on the `eod` flatten. On every day except SENSEX 1 Oct
the book was flat by 15:00 (`closingPositions` 0).

### 1.3 What the expiry-day money was made and lost on, package by package

Realised P&L per package, from the fills ledger (`desk-decisions`), where each
leg runs from its open fill to its close fill:

| Book, expiry day | Opening package | Adjustments before 12:00 | Adjustments after 12:00 |
|---|---:|---:|---:|
| SENSEX aggressive 09-24 | −10,506 | +13,616, −7,022, +3,262 | +3,996 |
| SENSEX conservative 09-24 | +6,476 | −9,700 | −3,237, +1,490 |
| NIFTY aggressive 09-29 | −6,064 | +130, +3,127 | −1,969, −2,252 |
| NIFTY conservative 09-29 | −3,113 | +3,894 | — |
| SENSEX aggressive 10-01 | −36,296, plus the stranded hedge −2,571 | −14,772 | +8,004, +3,040 |
| SENSEX conservative 10-01 | −18,330, plus the stranded hedge −1,220 | — | — |
| **Total** | **−71,624** | **−7,465** | **+9,072** |

The damage comes from the open on expiry day, and above all from the quiet
strangle's short put on 1 Oct: 72400PE sold at 181.6, bought back at 650.3,
for −₹37,493 (aggressive) and −₹18,784 (conservative). Afternoon adjustments
on expiry days made money in this sample, so an adjustment cutoff would have
cost money (§3, R3).

### 1.4 Adjustments per day against P&L

"Filled" counts the adjustment packages (`dl-neutral`/`dl-add`) that traded.
"Refused" counts those desk-api answered DONE with every open skipped.

| Date | Book | Expiry? | Filled | Refused | Total P&L | Max loss | Max profit | Orders |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 09-23 | NIFTY agg | | 1 | 0 | 1,446 | −1,475 | 1,446 | 6 |
| 09-23 | NIFTY cons | | 1 | 0 | −374 | −1,196 | 445 | 6 |
| 09-23 | SENSEX agg | | 1 | 0 | −1,663 | −2,188 | 334 | 6 |
| 09-23 | SENSEX cons | | 1 | 0 | −866 | −1,113 | 148 | 6 |
| 09-24 | NIFTY agg | | 3 | 2 | 4,560 | −2,905 | 4,560 | 10 |
| 09-24 | NIFTY cons | | 3 | 1 | 5,752 | −65 | 5,752 | 10 |
| 09-24 | SENSEX agg | E | 4 | 0 | 3,346 | −5,681 | 5,157 | 12 |
| 09-24 | SENSEX cons | E | 3 | 0 | −4,971 | −6,566 | 1,182 | 10 |
| 09-25 | NIFTY agg | | 1 | 2 | −4,852 | −6,243 | 257 | 6 |
| 09-25 | NIFTY cons | | 1 | 2 | −1,554 | −2,759 | 78 | 6 |
| 09-25 | SENSEX agg | | 3 | 0 | −7,337 | −9,202 | 12 | 10 |
| 09-25 | SENSEX cons | | 1 | 1 | −446 | −1,179 | 52 | 6 |
| 09-28 | NIFTY agg | | 1 | 0 | 956 | −1,927 | 1,654 | 6 |
| 09-28 | NIFTY cons | | 1 | 0 | 1,482 | −956 | 1,596 | 6 |
| 09-28 | SENSEX agg | | 1 | 0 | 4,898 | −740 | 4,898 | 6 |
| 09-28 | SENSEX cons | | 1 | 0 | 1,274 | −1,181 | 1,274 | 6 |
| 09-29 | NIFTY agg | E | 4 | 0 | −7,030 | −7,273 | 7,101 | 14 |
| 09-29 | NIFTY cons | E | 1 | 0 | 780 | −1,589 | 2,646 | 6 |
| 09-29 | SENSEX agg | | 3 | 0 | 4,514 | −3,276 | 8,654 | 10 |
| 09-29 | SENSEX cons | | 3 | 0 | 3,595 | −1,209 | 4,674 | 10 |
| 09-30 | NIFTY agg | | 3 | 3 | 3,949 | −1,391 | 3,949 | 10 |
| 09-30 | NIFTY cons | | 3 | 3 | 4,878 | −1,774 | 5,151 | 10 |
| 09-30 | SENSEX agg | | 1 | 1 | 67 | −4,829 | 1,864 | 6 |
| 09-30 | SENSEX cons | | 1 | 0 | 1,198 | −3,616 | 1,254 | 6 |
| 10-01 | NIFTY agg | | 6 | 7 | −2,613 | −8,869 | −26 | 16 |
| 10-01 | NIFTY cons | | 4 | 0 | 946 | −2,730 | 2,444 | 12 |
| 10-01 | SENSEX agg | E | 3 | 0 | −42,591 | −42,591 | 2,438 | 13 |
| 10-01 | SENSEX cons | E | 0 | 0 | −19,548 | −19,548 | 1,040 | 7 |

The same book-days grouped by the number of filled adjustments:

| Filled adjustments | Book-days | Total P&L | Average | Winning | Average without SENSEX 10-01 |
|---:|---:|---:|---:|---:|---:|
| 0 | 1 | −19,548 | −19,548 | 0 | (none) |
| 1 | 14 | +2,346 | +168 | 8 | +168 |
| 3 | 9 | −27,651 | −3,072 | 6 | +1,868 (8 days) |
| 4 | 3 | −2,738 | −913 | 2 | −913 |
| 6 | 1 | −2,613 | −2,613 | 0 | −2,613 |

The number of adjustments does not predict P&L in this sample. The only
book-day that hit `dl_max_adjusts_day` was NIFTY aggressive and conservative
on 10-01; they lost ₹2,613 and made ₹946.

**Finding, not fixed here: 22 adjustments were refused as `open: tag 'X' is
already open`.** These are all the refusals in the window. The engine's `flat`
posture sells the same-side option in the 0.45–0.60 band, and spec §6.2 says a
same-side add "grows it, which is an add". desk-api refuses an `open` on an
instrument the book already holds, so those adjustments never happen. Each
refusal is retried on the cooldown. NIFTY aggressive on 10-01 tried to sell
22700CE seven times between 10:11 and 12:00 and was refused every time, while
its net delta sat at +1.17 to +1.23 delta-lots against a wanted 0. The engine
and the API need to agree on this: either the band should skip held
same-side strikes, or the API should treat a same-side open as a resize. It is
a design question, so I left it alone.

### 1.5 Aggressive against conservative

| | Aggressive | Conservative | Aggressive − conservative |
|---|---:|---:|---:|
| NIFTY, 7 days | −3,584 | +11,910 | −15,494 |
| SENSEX, 7 days | −38,766 | −19,764 | −19,002 |
| SENSEX, excluding 10-01 | +3,825 | −216 | +4,041 |
| SENSEX, non-expiry days only | +479 | +4,755 | −4,276 |
| All, 14 book-days each | −42,350 | −7,854 | −34,496 |
| Winning book-days | 8/14 | 8/14 | |

Conservative beat aggressive on both symbols. Aggressive trades twice the lots
(4 against 2), adjusts sooner (60 s confirm and 600 s cooldown, against 120 s
and 900 s) and may adjust six times instead of four. On these seven days that
mostly scaled the losses up. On 1 Oct SENSEX the ratio of the two losses
(42,591 / 19,548 = 2.18) is roughly the ratio of the lots.

---

## 2. Post-mortem: SENSEX, 1 Oct 2026 (expiry day)

### 2.1 Decision by decision: SENSEX-delta-lean-aggressive-2026-10-01 (dl_open_lots 4, lot 20)

Spot (the forward) and P&L are taken from the 5-minute `desk-book-marks`.

| IST | Decision | What it added | Realised from that package |
|---|---|---|---:|
| 10:25:33 | `dl-open` #1, "quiet: opening none, 4 leg(s) at 4 lot(s)", spot 72,974 | Buy 71800PE 80 @ 32.14 (wing), Sell 72400PE 80 @ 181.64, Sell 73100CE 80 @ 25.11, Buy 73400CE 80 @ 9.80 (wing) | **−36,296**, plus the 71800PE still held (−2,571 at settlement) |
| 10:36:31 | `dl-neutral` #2, "chop/flat: −0.57 delta-lots → adding 1 lot" | Sell 73000PE 20 @ 521.40 (ATM) | **−14,772** (bought back at 1,260) |
| 10:50–12:45 | (no decision) | Net delta went from +0.55 to +1.57 delta-lots long while SENSEX fell from 73,000 to 72,473. In 24 marks the engine said "no tradable strike in the band". P&L fell from −2,183 to −28,136. | |
| 12:47:08 | `dl-neutral` #3, "trend-down/counter: 1.54 delta-lots → adding 3 lot(s)" | Buy 72700PE 60 @ 823.95 | **+8,004** |
| 12:57:10 | `dl-neutral` #4, "chop/flat: −0.53 → adding 1 lot" | Sell 72000PE 20 @ 437.45 | **+3,040** |
| 13:00–14:45 | (no decision) | Posture met ("nothing to add"). SENSEX moved between 71,876 and 72,336. P&L stayed between −28,145 and −31,391. | |
| 14:50:00 | `eod` #5, passive flatten of 7 legs, spot 72,282 | Six closes filled 14:50:06–08. **The 71800PE close (`…:5#4`) rested.** | |
| 14:55 → 15:30 | Engine: "14:55: urgent flatten — closing all 1 leg(s)", then "past the 15:00 flat-by". **Nothing was routed.** | The 71800PE went from about 80 at 14:55 to 0.05 by 15:30. | |

Realised: −36,296 − 14,772 + 8,004 + 3,040 = **−40,024**, which matches the
daily report. The total of −42,591 includes the held 71800PE marked at 0.05.

### 2.2 SENSEX-delta-lean-conservative-2026-10-01 (dl_open_lots 2)

| IST | Decision | What it added | Realised |
|---|---|---|---:|
| 11:06:34 | `dl-open` #1, quiet strangle, spot ~72,968 | Buy 71800PE 40 @ 30.50, Sell 72400PE 40 @ 182.60, Sell 73100CE 40 @ 23.40, Buy 73300CE 40 @ 11.90 | **−18,330** (72400PE alone −18,784), plus the 71800PE still held (−1,220 at settlement) |
| 11:15–14:45 | (no decision) | Net delta stayed between +0.12 and +0.49 delta-lots. It never left the 0.5 delta-lot dead band, so the book read "nothing to add" all day. P&L fell to −16,416 by 14:05. | |
| 14:50:00 | `eod` #2, passive flatten of 4 legs | Three closes filled. **The 71800PE close (`…:2#2`) rested** after repricing to 145.45 and then crossing to 133.95 into a 134.65/135 touch. | |

### 2.3 Why `dl_stuck_loss` never acted

Dials, verified on the registry rows:

- aggressive: `dl_stuck_loss` 25,000, `dl_stuck_confirm_s` 300, `dl_max_adjusts_day` 6, `dl_adjust_cooldown_s` 600, `dl_open_lots` 4
- conservative: `dl_stuck_loss` **15,000**, `dl_stuck_confirm_s` 300, `dl_max_adjusts_day` 4, `dl_adjust_cooldown_s` 900, `dl_open_lots` 2

The brief said 25,000 on every book. The conservative books are on 15,000, as
the presets intend.

The stuck exit (spec §6.4, `stuckExit` in `decide.ts`) needs three things at
once:
- an adjustment that is **wanted**
- that adjustment **blocked**, either by the SPAN cap or by `dl_max_adjusts_day`
- `totalPnl ≤ −dl_stuck_loss`, held for 300 s

Neither SENSEX book was ever blocked:

- **Aggressive.** Its loss passed −25,000 at about 12:45. Between 10:50 and
  12:45 the wanted adjustment (sell a CE in the 0.45–0.60 band) had "no
  tradable strike in the band". That is a WAIT, which resets the clock, not a
  BLOCK. From 12:50 the posture was met, so nothing was wanted. It had used
  3 of its 6 adjustments, and the SPAN cap never bound.
- **Conservative.** Its loss passed −15,000 at about 13:45. Its net delta
  never left the dead band (0.49 at most against 0.5), so nothing was ever
  wanted.

Across all 2,760 marks in the window:
- the SPAN cap blocked 0 times
- `dl_max_adjusts_day` blocked 12 times, all on NIFTY 10-01, at losses inside the floor
- the stuck window armed 0 times

This is the behaviour the runbook (§3.5) describes: a book the tape has
already neutralised wants nothing, so it simply bleeds. On expiry day that
bleed is gamma on a book that looks flat.

I could not check from the database why the band held no tradable strike for
two hours. The chain snapshot is not persisted, and `desk-ticks` does not
exist, so the runbook §1.3 tick tape is not recording. `tradableStrikes`
requires **both** the CE and the PE of a row to quote inside
max(2 % of mid, ₹1). On an expiry-day SENSEX chain, an in-the-money put at
the strikes the CE band selects is a plausible reason that filter rejected
them.

### 2.4 Why `dl_day_max_loss` never acted

200,000 on every book, and the desk's day guard (`desk-strategies.dailyLimits.stop`)
is armed at the same 200,000. The worst `totalPnl` of the window was −42,591,
which is 21 % of the backstop. No `desk-daily-guard` row exists for any
delta-lean tag. The backstop was set as a "disaster backstop only" (D6). At
4.7 times the worst day it was ever going to be a disaster backstop and
nothing else.

### 2.5 Why the 14:50 passive flatten wedged

These are the gateway's own events for `SENSEX-delta-lean-aggressive-2026-10-01:paper:5#4`
(Sell 80 71800PE, tranches 60 + 20):

| IST | Event |
|---|---|
| 14:50:00.635 | queued; `limitPrice` 146.15 against a decision-time mark of 149.15 |
| 14:50:06.085 | tranche `5#4.1` (60) placed on the simulator, WORKING |
| 14:50:07.666 | "peg deadline: crossed to 136.65 (touch 137.35/137.7)" (chase_max_ms 1500) |
| 14:50:22.667 | "still resting after 1 reprices (last accepted reprice 136.65) — cancel it from the Broker page or handle it by hand" |
| 2026-10-04 22:18:34 | FAILED/REJECTED by the gateway's paper sweep: "paper order orphaned by a gateway restart" |

At 14:50:07 a sell limit at 136.65 sat below a 137.35 bid. A real exchange
fills that at once. The paper simulator (`packages/brokers/src/simulator.ts`,
`#crosses`) fills a SELL limit only when a **last-trade print is strictly
above** the limit, and ignores the touch. The put was falling as SENSEX
rallied (72,282 → 72,390 by 14:55 → 72,488 by 15:30), so no print above 136.65
ever came. The chaser stops after its one cross. The conservative book's
`2#2` went the same way, crossing to 133.95 into a 134.65 bid.

I did not change this simulator behaviour. It is pessimistic where runbook
§5.1 calls paper optimistic, and it is the reason a crossed exit can rest
forever in paper. Changing it alters every paper fill, so it is listed under
Unresolved.

### 2.6 Why the 14:55 urgent flatten never fired: defect (a), fixed

The engine did decide it. Every book mark from 14:55 to 15:30 reads "urgent
flatten — closing all 1 leg(s)" and then "past the 15:00 flat-by". The
supervisor swallowed it. From `logs/desk-supervisor-out__2026-10-02_00-00-00.log`
(timestamps in UTC):

```
09:20:00.630Z info decision routed  … SENSEX-delta-lean-aggressive-2026-10-01:paper:5 trigger eod "14:50: passive flatten …" actions 7
09:20:01.864Z warn a working order has no broker id yet — it cannot be cancelled … :5#0 … state PENDING
   … (the same for #1…#6, and for the conservative book's :2#0…#3)
```

The sequence was:

1. One second after routing, the next pass re-decided the same passive
   flatten.
2. `#watchWhileWorking` (`apps/supervisor/src/engine-host.ts`) treats any
   non-hold `eod` decision as a guard that "wants this book", so it swept the
   working package.
3. All seven orders were still PENDING at the gateway, which claimed them at
   14:50:06, so none had a broker id yet. The sweep requested nothing and
   answered `{requested: 0, failed: 0}`.
4. `#preempt` read that as "nothing left to cancel", logged it at debug and
   **latched** `#cancelled = decisionId`.
5. Every later pass hit "already cancelling this package" and returned. That
   included the 14:55 urgent decision, the 15:00 ladder and the
   `rest_max_min` invalidation at 15:00.
6. The flight never ended, because 5#4 never went terminal, so the host never
   decided again.

The supervisor state still shows `inFlight: …:5` and `…:2` today, with the
71800PE close as the `remaining` action.

The runbook's §3.2 line, "the EOD flatten windows … keep running regardless",
was true of the engine and false of the host.

**Fix (commits 959d7a84, 44fd644b and 8018aa7e):**

- **A package is not swept by its own exit.** A guard no longer preempts a
  working package that is already its own exit at the same or a stronger work
  mode (`alreadyWorking`).
  - The 14:50 passive package is left to be worked. The 14:55 escalation from
    passive to urgent does preempt it, logged at WARN. A different guard, such
    as a lock, a margin trim or `dl-stop`, still preempts at ERROR.
  - The delta-lean exit branch applies the same rule.
  - `dl-stop` counts as the same exit as a working `dl-target` or `dl-stuck`
    flatten. Those latch `dlStopped`, so the next pass re-decides them as
    "stopped for the day".
- **There is no per-decision latch any more.** On 1 Oct the hedge close was
  tranched 60 + 20. The gateway advances a close whose tranche was cancelled
  (`decideTrancheStep` rule 3), so a latch set when tranche .1 was cancelled
  would have left tranche .2 resting behind it, and blocked `rest_max_min`
  too.
  - `#preempt` now sweeps every pass it is called on.
  - It files a cancel only for a broker id it has not asked about in the last
    `CANCEL_REASK_MS` (60 s). A cancel that never took is asked again.
- **Only a PLACED order is cancellable.** The sweep counts every other
  non-terminal order as `unplaced` and files nothing for it. That covers
  orders not yet placed, and a close between tranches, which is PENDING
  while still carrying the finished tranche's broker id.

**Tests:**

- `apps/supervisor/test/engine-host-delta-lean.test.ts`. These run against the
  real `workingOrderCanceller`, over a fake queue that moves orders the way
  `queue.ts` does.
  - **"a RESTING passive flatten cannot wedge the book…"** replays the day:
    1. 14:50 the passive flatten routes WORKING.
    2. 14:50:01 it re-decides while the orders are unplaced.
    3. 14:50:06 the short fills and tranche .1 of the hedge rests.
    4. 14:55 the escalation must cancel tranche .1.
    5. Nothing may be filed while the close sits between tranches.
    6. Tranche .2 must be cancelled under its new id.
    7. After the decision settles, it must route `eod` with
       `[close, hedge, 'urgent']`.
    8. That close, resting in turn, must still be taken back by `rest_max_min`
       at ten minutes.
  - **"an escalation that finds the package NOT YET PLACED…"**: the sweep
    repeats, files once, and re-asks after the window.
  - **"an exit never sweeps ITSELF"** and **"a dl-target flatten is not swept
    by the dl-stop that its own latch decides next"**.
  - All of them except "an exit never sweeps ITSELF" fail on the previous code.
- `apps/supervisor/test/working-orders.test.ts` pins `unplaced`, the
  between-tranches case, `skip`, and the re-filing of a refused id.
- In `apps/supervisor/test/engine-host.test.ts`, the cancel tests are restated
  from "latched once" to "filed once per order".
- `packages/desk-engine/test/delta-lean-decide.test.ts` pins that the engine
  emits the 895 urgent flatten for every held leg under a working package.
  This passed already: the engine was never the suppressor.

### 2.7 Order `…:5#4`: which record is right: defect (b), fixed

| Record | What it says | Who wrote it, and when |
|---|---|---|
| `desk-gateway-orders`: `status`, `filled_quantity`, `price` | COMPLETE, 80, 149.15 | **desk-api, at enqueue** (14:50:00.635). `gatewayOrderDocument` spread the legacy positional shape (`orderDocument`) onto the queue document. `price` is `plannedFills[4].price` (149.14999999999998), the decision-time mark. |
| `desk-gateway-orders`: `state`, `filledQty`, `avgPrice` | REJECTED, 0, null | the gateway's own lifecycle (paper sweep, 4 Oct 22:18) |
| `desk-fills` | `5#4.1` WORKING 0, and no FILLED row | the gateway's fill watcher |
| `desk-order-events` | PLANNED → SUBMITTED → ACK → STATUS (cross to 136.65) → STATUS (resting) → FAILED/REJECTED | the gateway |
| `desk-decisions` | status **WORKING**, `5#4` not in `foldedOrders` | desk-api |
| `desk-supervisor-state` | `inFlight: …:5`, remaining `close 71800PE` | supervisor |

**The gateway is right: the order never filled.** The "COMPLETE 80 @ 149.15"
fields were never a fill. desk-api wrote them when it queued the order, before
anything had traded. Two things were wrong on the api side:

1. **desk-api never learned the gateway's verdict.** The paper fold scanned only
   documents **created** in the last two hours. 5#4 was created on 1 Oct and
   went terminal on 4 Oct, so the decision stayed WORKING and the supervisor
   kept holding it.
   - **Fix (commit 939e1392):** the fold now admits an order created **or
     resolved** (`resolvedAt`) inside the window. History, meaning orders both
     created and resolved long ago, is still left alone.
   - **Test:** `apps/api/test/paper-fold-late-terminal.test.ts` seeds the
     1 Oct shape. It failed on master ("the REJECTED order is in the pass")
     and passes now, with a companion test showing old history is not
     re-folded.
2. **The queue document claimed a fill at enqueue.** No code reads those three
   fields off this collection. Every reader uses `state`, `filledQty` and
   `avgPrice`. A person does read them, though, and the brief for this review
   took them for a lost fill.
   - **Fix (commit 94c0b08d):** the queue document drops `status` and
     `filled_quantity`, and carries the mark as `markPrice`.
     `desk-paper-trade` and `positional` keep the legacy shape, because there
     it is the fill.
   - **Test:** two new cases in `apps/order-gateway/test/rail-contract.test.ts`.

**Realised P&L is correctly stated.** The counterfactuals:

| | Aggressive | Conservative |
|---|---:|---:|
| Realised as booked (6 / 3 closes) | −40,024 | −18,330 |
| Hedge entry | 80 @ 32.1375 | 40 @ 30.50 |
| **If the 149.15 "fill" had been real**, realised would be | −30,663 (+9,361) | −13,584 (+4,746) |
| If the 14:55 urgent had crossed at ≈ 80.5 / 78.0 (backed out of the 14:55:01 marks) | ≈ −36,155 (+3,869) | ≈ −16,428 (+1,902) |
| **Actual: the hedge expired worthless** (SENSEX closed ≈ 72,488 on 1 Oct, above 71,800), settles at 0 | **−42,595** | **−19,550** |

The wedge cost ≈ ₹6,440 on aggressive and ≈ ₹3,122 on conservative, about
₹9,560 in all, against the urgent flatten having fired.

Settling the expired leg is WS1's job (`settle-expired`). Two points for that
workstream:
- The SENSEX spot mark on file in `desk-marks` (token 265, 71,909.7) is
  stamped 2026-10-04 22:16 IST, after the reboot, so it is not 1 Oct's close.
  The 1 Oct 15:30 book mark says 72,487.75. The 71800PE is worth 0 against
  either.
- Even after defect (b)'s fix is deployed, these two decisions will **not**
  fold by themselves. Their `resolvedAt` is 4 Oct 22:18, which is outside a
  two-hour window by the time anything restarts. See Unresolved.

---

## 3. Dial recommendations. R1 was applied on 2026-10-05; none of the others are.

How these take effect: a delta-lean book lives one day. The 08:50 roll copies
`PRESETS` (`packages/desk-engine/src/presets.ts`) into each new book, and it
runs from the repo, so a merged preset change applies at the next roll without
a restart. A `PATCH` changes only the book it names, so it is right for a
one-day trial on a book the roll has already created. The route takes `mode`
in the **body**, not the query string. Re-patching `dl_day_max_loss`
re-arms the desk's day guard (`armBookDayGuard`).

```
PATCH /v1/desk/books/registry/<tag>
{"mode":"paper","dials":{…}}
```

### R1: size `dl_day_max_loss` to the book. This is the first one to apply.

- **Status: APPLIED 2026-10-05**, on top of 1de95d13. The aggressive number
  went into `DEFAULT_DIALS` (which is the aggressive column) rather than into
  the aggressive preset as the diff below shows, and the conservative one into
  `DELTA_LEAN_CONSERVATIVE`; the hold-to-expiry presets inherit both, as a
  book-life backstop. The desk day guard arms at **45,000** aggressive and
  **23,000** conservative. The daily four pick it up at the first 08:50 roll
  after the merge; a hold pair registered before it keeps 200,000 / 300,000
  until patched or expired (runbook §7.7).
- **Change:** aggressive 200,000 → **30,000**; conservative 200,000 → **15,000**.
- **Evidence:**
  - Outside 1 Oct SENSEX, the worst intraday `maxLoss` was −9,202 on
    aggressive (SENSEX 09-25) and −6,566 on conservative (SENSEX 09-24). The
    new levels are about 3.3× and 2.3× those, so no other book-day in the
    window would have hit them.
  - On 1 Oct the aggressive mark crossed −30,000 at 12:50 (−30,689). It never
    recovered, and closed at −42,595. Against what actually happened, the
    backstop would have saved about ₹11,900. Against what the fixed host
    would have done (urgent flatten at 14:55, ≈ −36,155), it saves about
    ₹5,500.
  - The conservative mark crossed −15,000 at 13:45 (−15,060) and closed at
    −19,550. That is about ₹4,500 saved against what happened, and about
    ₹1,400 against the fixed host (≈ −16,428).
  - It is the only rule that acts on a book whose posture is met. The stuck
    rule cannot do that, by design (§2.3).
- **Depends on 1de95d13 (the day-guard arming rule). Do not apply R1
  without it.**
  - Registration, and any dials PATCH that touches `dl_day_max_loss`, arm the
    desk's day guard (`desk-strategies.dailyLimits.stop`) from this dial.
  - Before 1de95d13 the guard was armed at exactly the same line as the
    engine. A delta-lean tag has no runtime row, so the guard exits through
    `flattenTag` (`day-guard.ts`, the "host unknown" branch). That path does
    not check for orders already out, and rebuilds the book from
    `desk-decisions` fills that lag the paper fold.
  - At ₹2,00,000 the two never came near firing. At ₹30,000, on 1 Oct, the
    engine's `dl-stop` urgent flatten (1 s cadence) and the guard's flatten
    (10 s) would have crossed the same line together, both closes could have
    filled, and the book could have flipped.
  - `guardStopFor` now arms the guard at **1.5× the resolved
    `dl_day_max_loss`, rounded up to the next ₹1,000**. That is 45,000
    aggressive and 23,000 conservative under R1, and 300,000 at today's
    default. The engine exits first, and the guard stays a backstop.
  - Rows already armed keep their stop until they are re-registered or
    patched. Every delta-lean row is created fresh each morning, so the next
    roll after the merge arms them all by the new rule.
- **Preset diff:**

```diff
   {
     key: 'delta-lean-aggressive',
-    dials: { ...DELTA_LEAN_BASE },
+    dials: { ...DELTA_LEAN_BASE, dl_day_max_loss: 30_000 },
   },
   {
     key: 'delta-lean-conservative',
     dials: {
       ...DELTA_LEAN_BASE,
       dl_open_lots: 2,
       …
       dl_stuck_loss: 15_000,
+      dl_day_max_loss: 15_000,
       chase_max_ms: 3000,
```

- **Or for one day, on the books the roll creates:**
  - `PATCH /v1/desk/books/registry/NIFTY-delta-lean-aggressive-2026-10-05` and `…/SENSEX-delta-lean-aggressive-2026-10-05`:
    `{"mode":"paper","dials":{"dl_day_max_loss":30000}}`
  - `PATCH /v1/desk/books/registry/NIFTY-delta-lean-conservative-2026-10-05` and `…/SENSEX-delta-lean-conservative-2026-10-05`:
    `{"mode":"paper","dials":{"dl_day_max_loss":15000}}`
- The runbook §3.5 says "₹2 lakh per book and ₹8 lakh across the desk" is the
  worst case to plan for. This brings the engine's line down to ₹90,000 across
  the desk. The desk guard behind it sits at ₹1,36,000 (45,000 and 23,000 per
  book).

### R2: halve the open on expiry day

- **Change:** on the expiring symbol's own expiry day, `dl_open_lots` goes
  4 → **2** on aggressive and 2 → **1** on conservative.
- **Evidence:**
  - Opening packages on expiry days lost ₹71,624, against +₹1,607 from the
    adjustments on those days (§1.3).
  - Every expiry-day open except SENSEX-conservative 09-24 (+6,476) lost
    money.
  - Halving the opens would have cut that loss by about ₹35,800 net. That
    already counts the one winning expiry open, whose +₹6,476 would have
    halved.
- **There is no expiry-only dial today.** Options:
  - The proper fix is a code change: a `dl_expiry_open_lots` dial read when
    `chain.expiry === dateIst`, or the roll stamping the expiry-day lots at
    registration.
  - Until then it is a PATCH on the expiry mornings, after the 08:50 roll and
    before the 09:30 first trade:
    - Tuesday 2026-10-06, NIFTY:
      - `PATCH /v1/desk/books/registry/NIFTY-delta-lean-aggressive-2026-10-06` `{"mode":"paper","dials":{"dl_open_lots":2}}`
      - `PATCH /v1/desk/books/registry/NIFTY-delta-lean-conservative-2026-10-06` `{"mode":"paper","dials":{"dl_open_lots":1}}`
    - Thursday 2026-10-08, SENSEX:
      - `PATCH /v1/desk/books/registry/SENSEX-delta-lean-aggressive-2026-10-08` `{"mode":"paper","dials":{"dl_open_lots":2}}`
      - `PATCH /v1/desk/books/registry/SENSEX-delta-lean-conservative-2026-10-08` `{"mode":"paper","dials":{"dl_open_lots":1}}`
- `dl_open_lots` also sets the `lean` posture target D (spec §6.2), so the
  pyramid adds shrink with it. That is the right direction on expiry day.

### R3: an expiry-day adjustment cutoff. Considered, not recommended.

- **Evidence against:** the adjustments placed after 12:00 on the six
  expiry-day book-days made **+₹9,072**. On 1 Oct the two afternoon
  adjustments made +8,004 and +3,040. A cutoff at 12:00 or later would have
  cost money in this sample.
- The expensive expiry-day adjustment was the 10:36 morning ATM put sale on
  1 Oct (−14,772), and a cutoff would not catch that.
- If a cutoff is wanted anyway, it needs a new dial, because nothing in
  `DEFAULT_DIALS` gates adjustments by time of day except the warm-up and the
  flatten windows.

### R4: `dl_max_adjusts_day`. No change.

- **Evidence:** it bound on only one day, NIFTY 10-01 (12 marks after 14:15,
  at −832 to −8,456, all inside the stuck floor).
- Book-days with more adjustments did not do worse or better in a consistent
  way (§1.4).
- Lowering it would make the stuck rule easier to arm, but the stuck rule is
  not where the losses were (§2.3). R1 is the direct lever.

### R5: `dl_open_lots` on SENSEX. Low confidence. Only R2 for now.

- SENSEX aggressive against conservative was −19,002 over seven days, but
  +4,041 without 1 Oct, and the aggressive book lost on 4 of 7 SENSEX days.
- Per lot, a 1 % move is about ₹14,400 of delta exposure per delta-lot on
  SENSEX (72,000 × 1 % × 20) against about ₹16,000 on NIFTY. The two symbols
  are sized alike, so there is no notional case for cutting SENSEX alone.
- The case against SENSEX is the expiry day, which R2 covers. If the operator
  still wants it:
  - `{"mode":"paper","dials":{"dl_open_lots":2}}` on `SENSEX-delta-lean-aggressive-<date>`
  - or, in the preset, a SENSEX-specific row. Presets are per variant, not per
    symbol, so that is a new preset key and a `planBooks` change in
    `scripts/delta-lean-books.mjs`.

### Observation: the dead band is in absolute delta-lots

`dl_dead_band_lots` is 0.5 on both presets. A 2-lot conservative book has to
move 0.25 delta **per lot** before any adjustment is even wanted. On 1 Oct it
sat at 0.39–0.49 delta-lots for 2.5 hours while losing ₹16,000, and could not
act. Halving it for conservative (`dl_dead_band_lots: 0.25`) would make the
two presets equally sensitive per lot. I have not recommended it, because the
aggressive book did act on 1 Oct and lost more for it.

---

## 4. Defects found

| | Defect | Where | Status |
|---|---|---|---|
| a | A passive flatten re-decided under its own working package swept that package. A sweep that met unplaced orders latched, and the per-decision latch swallowed the 14:55 urgent flatten, the 15:00 ladder and the `rest_max_min` invalidation. It would also have stranded the second tranche of a tranched close. | `apps/supervisor/src/engine-host.ts` `#watchWhileWorking`/`#preempt`/`alreadyWorking`, `working-orders.ts` | **Fixed**, 959d7a84 + 44fd644b + 8018aa7e: no latch, cancels deduped by broker id. Tests in `engine-host-delta-lean.test.ts` (4 wedge/exit cases), `working-orders.test.ts`, the restated cancel tests in `engine-host.test.ts`, and an engine pin in 8972f60c. |
| b1 | The paper fold only scanned orders created in the last 2 h, so an order that went terminal later was never folded. The decision stayed WORKING against the gateway's REJECTED, and the supervisor held the flight. | `apps/api/src/paper-fold.ts` | **Fixed**, 939e1392; one-off catch-up `cli.ts fold-paper` in f08abff7. `paper-fold-late-terminal.test.ts` was red, now green. |
| b2 | The gateway queue document said `status: COMPLETE`, `filled_quantity: qty`, `price: mark` from enqueue. | `apps/api/src/rail.ts` `gatewayOrderDocument` | **Fixed**, 94c0b08d. `rail-contract.test.ts` was red, now green. |
| e | The desk day guard was armed at exactly `dl_day_max_loss`. Its delta-lean exit is `flattenTag`, which does not see orders already out and rebuilds from lagging fills, so it could fire beside the engine's `dl-stop` and close a leg twice. This mattered only once R1 brings the line close to the day's actual losses. | `apps/api/src/routes/books.ts` `bookGuardStop` | **Fixed**, 1de95d13: `guardStopFor` arms the guard at 1.5 x, rounded up to ₹1,000. Tests in `books-day-guard.test.ts`, with the registration test restated. |
| c | The simulator ignores the touch, so a crossed (marketable) limit rests until a print trades through it. In paper a crossed exit can rest forever, and the chaser stops after one cross. | `packages/brokers/src/simulator.ts` `#crosses`; `order-chaser.ts` | Not fixed: it changes every paper fill. Recommended follow-up: fill a resting LIMIT when the frame's bid (for a sell) or ask (for a buy) crosses it. |
| d | `flat`/`lean` adds that pick a strike the book already holds on the same side are refused by desk-api ("already open"). That happened 22 times in the window. | `decide.ts` `adjustmentPackage` and desk-api open validation | Not fixed: needs a design decision (§1.4). |

## 5. The one change I would make first

**R1: set `dl_day_max_loss` to 30,000 on aggressive and 15,000 on
conservative, in the presets.** Applied 2026-10-05; the guard arms at
45,000 / 23,000.

The defects are fixed in code. Of the dials, this is the only change that acts
on the failure mode the data shows. On 1 Oct it would have saved ≈ ₹16,400
against what happened, or ≈ ₹6,900 on top of the wedge fix.

- **It acts on the right failure.** The money is lost on a book whose posture
  looks met while gamma eats it. The stuck rule cannot fire then (§2.3), and
  the day target and the clock do not help.
- **It costs nothing elsewhere in the sample.** No other book-day came near
  it. The worst was −9,202 against 30,000 on aggressive, and −6,566 against
  15,000 on conservative.
- **It cuts the desk's planned worst case from ₹8 lakh to ₹90,000** on the
  engine's line. The desk guard, now armed at 1.5×, is at ₹1,36,000.
- **It is a dial, but it must ship with 1de95d13.** It is reversible and needs
  no code beyond that commit. It goes out with the
  next 08:50 roll once merged, and the day guard re-arms from it at 1.5×.

R2 is the second change. It is better aimed at expiry day, but it needs either
a daily PATCH or a new dial.

---

## Unresolved, handed to the orchestrator and operator

1. **Three paper decisions are still wedged behind orders the gateway
   REJECTED on 4 Oct 22:18 IST.** The 4 Oct restart sweep marked these orders
   REJECTED:

   | Decision held in flight | Order | Leg |
   |---|---|---|
   | `SENSEX-delta-lean-aggressive-2026-10-01:paper:5` | `…:5#4` | SENSEX26O0171800PE ×80, expired 1 Oct |
   | `SENSEX-delta-lean-conservative-2026-10-01:paper:2` | `…:2#2` | SENSEX26O0171800PE ×40, expired 1 Oct |
   | `TCS-2026-09-29-recenter-relief-r:paper:738` | `…:738#0` | TCS26SEP2080PE, expired 29 Sep |

   - `desk-decisions` has all three as WORKING. The gateway has the orders as
     REJECTED, with nothing filled and `deskFolded` unset.
   - The b1 fix will not fold them on a restart, because they were resolved
     more than 2 h before any restart. f08abff7 adds the one-off catch-up:

     ```sh
     node apps/api/src/cli.ts fold-paper --lookback-hours 72            # dry run: lists what it would fold
     node apps/api/src/cli.ts fold-paper --lookback-hours 72 --apply    # folds them
     ```

     Run read-only today, the dry run lists exactly those three orders and
     nothing else. Widen the window to cover 4 Oct 22:18 IST from whenever it
     runs.
   - **The order matters: settle first, then fold.**
     1. Run WS1's `POST /v1/desk/books/registry/<tag>/settle-expired?mode=paper`
        on all three tags.
     2. Then run `fold-paper --apply`.

     Folding settles the decision each host is holding in flight. The host's
     very next pass decides again against the book. If the expired leg is
     still in it, the host routes a fresh close on a contract that no longer
     trades. That close rests for ever, and the book is wedged again on a new
     id.
   - Until this is done, each host keeps polling its decision. Nothing new
     routes on those tags, which is harmless for dead books.
2. Defect (c), the simulator's touch, is the reason the hedge rested at all.
   It needs a decision because it moves every paper fill.
3. Defect (d), the 22 refused same-side adds.
4. The tick tape (`desk-ticks`) is not being recorded (runbook §1.3), so the
   1 Oct 71800PE prints cannot be replayed. The ≈80 price at 14:55 is backed
   out of the book marks.
5. **Residual risk in the cancel path.** A broker id is trusted as cancelled
   for `CANCEL_REASK_MS` (60 s) after the request is filed. If the gateway
   never acts on a cancel, the order can rest for up to a minute before it is
   asked again. That is bounded, where the old latch was for the whole
   session.

---

## Appendix: queries (read-only)

All of these run against `mongodb://127.0.0.1:27017/algomaker`, as
`mongosh --quiet mongodb://127.0.0.1:27017/algomaker --eval '…'`.

**Daily reports in the window (§1.1):**

```js
db.getCollection("desk-daily-reports").find({tag:/delta-lean/, date:{$gte:"2026-09-22",$lte:"2026-10-02"}},
  {date:1,tag:1,mode:1,realised:1,total:1,maxProfit:1,maxLoss:1,orderCount:1}).sort({date:1,tag:1})
  .forEach(d=>print(d.date,d.mode,d.tag,Math.round(d.realised),d.total==null?"null":Math.round(d.total),
    Math.round(d.maxProfit),Math.round(d.maxLoss),d.orderCount));
db.getCollection("desk-daily-reports").find({tag:/delta-lean/, date:{$gte:"2026-09-23",$lte:"2026-10-02"}},
  {date:1,tag:1,closingPositions:1,closingSource:1}).sort({date:1,tag:1})
  .forEach(d=>print(d.date,d.tag,d.closingSource,JSON.stringify(d.closingPositions)));
```

**Decisions per trigger per book-day, with each book's expiry:**

```js
const ist=ms=>new Date(+ms+19800000).toISOString().slice(0,10); const rows={};
db.getCollection("desk-engine-decisions").find({tag:/delta-lean/, receivedAt:{$gte: Date.parse("2026-09-22T18:30:00Z"), $lt: Date.parse("2026-10-02T18:30:00Z")}},
  {tag:1,trigger:1,receivedAt:1,expiry:1,"response.status":1}).forEach(d=>{
  const k=ist(d.receivedAt)+" "+d.tag; rows[k]=rows[k]||{exp:d.expiry,t:{},st:{}}; rows[k].t[d.trigger]=(rows[k].t[d.trigger]||0)+1;
  const s=d.response&&d.response.status; rows[k].st[s]=(rows[k].st[s]||0)+1;});
Object.keys(rows).sort().forEach(k=>print(k, rows[k].exp, JSON.stringify(rows[k].t), JSON.stringify(rows[k].st)));
```

**Per book-day table (§1.4), run with `mongosh … --file q1.js`:**

```js
const from = "2026-09-23", to = "2026-10-01";
const reports = db.getCollection("desk-daily-reports").find(
  { tag: /delta-lean-(aggressive|conservative)-2026-/, mode: "paper", date: { $gte: from, $lte: to } }).toArray();
const out = [];
for (const r of reports) {
  if (!r.tag.endsWith(r.date)) continue; // the book's own day only
  const decs = db.getCollection("desk-engine-decisions").find({ tag: r.tag }).toArray();
  const exp = decs.length ? decs[0].expiry : "?";
  const led = {};
  db.getCollection("desk-decisions").find({ tag: r.tag }).forEach(d => { led[d.decisionId] = d.fills.length; });
  const adj = decs.filter(d => d.trigger === "dl-neutral" || d.trigger === "dl-add");
  const filled = adj.filter(d => (led[d.decisionId] || 0) > 0).length;
  const eod = decs.filter(d => d.trigger === "eod").length;
  out.push([r.date, r.tag.replace(/-2026-.*/, ""), exp, exp === r.date ? "EXPIRY" : "", Math.round(r.realised),
    r.total == null ? "null" : Math.round(r.total), Math.round(r.maxLoss), Math.round(r.maxProfit),
    adj.length, filled, adj.length - filled, eod, r.orderCount].join("|"));
}
out.sort().forEach(l => print(l));
```

**Per-package realised P&L (§1.3, §2.1, §2.2), run with `mongosh … --eval 'var TAGS=[…]' --file q2.js`:**

```js
const tags = (typeof TAGS !== "undefined") ? TAGS : [];
const ist = (ms) => new Date(+ms + 19800000).toISOString().slice(11, 19);
for (const t of tags) {
  print("== " + t);
  const legs = {}; const byDec = [];
  db.getCollection("desk-decisions").find({ tag: t }).sort({ createdAt: 1 }).forEach((d) => {
    const ed = db.getCollection("desk-engine-decisions").findOne({ decisionId: d.decisionId }) || {};
    byDec.push({ id: d.decisionId.split(":").pop(), at: ist(d.createdAt), trig: ed.trigger, opened: [] });
    for (const f of d.fills) {
      const s = f.tradingsymbol;
      legs[s] = legs[s] || { open: null, closeQty: 0, closeVal: 0 };
      if (f.op === "open") { legs[s].open = { side: f.side, qty: f.qty, price: f.price }; byDec[byDec.length - 1].opened.push(s); }
      else { legs[s].closeQty += f.qty; legs[s].closeVal += f.qty * f.price; }
    }
  });
  for (const d of byDec) {
    if (d.opened.length === 0) continue;
    let pnl = 0; const parts = [];
    for (const s of d.opened) {
      const l = legs[s]; const sg = l.open.side === "Buy" ? 1 : -1;
      if (l.closeQty >= l.open.qty) { const x = sg * (l.closeVal - l.open.qty * l.open.price); pnl += x;
        parts.push(`${l.open.side} ${s} ${l.open.qty}@${l.open.price} -> ${(l.closeVal / l.closeQty).toFixed(2)}: ${Math.round(x)}`); }
      else parts.push(`${l.open.side} ${s} ${l.open.qty}@${l.open.price} -> STILL HELD`);
    }
    print(`${d.at} #${d.id} ${d.trig} realised ${Math.round(pnl)} | ${parts.join(" ; ")}`);
  }
}
```

TAGS were the two SENSEX 10-01 tags, the two NIFTY 09-29 tags, the two
SENSEX 09-24 tags and `SENSEX-delta-lean-aggressive-2026-09-25`.

**The 1 Oct engine decisions and fill ledger:**

```js
db.getCollection("desk-engine-decisions").find({tag:"SENSEX-delta-lean-aggressive-2026-10-01"}).sort({receivedAt:1})
  .forEach(d=>printjson({at:d.receivedAt, trig:d.trigger, reason:d.reason, actions:d.actions, resp:d.response}));
db.getCollection("desk-decisions").findOne({decisionId:"SENSEX-delta-lean-aggressive-2026-10-01:paper:5"});
```

**Order 5#4 in every record (§2.5, §2.7):**

```js
const id="SENSEX-delta-lean-aggressive-2026-10-01:paper:5#4";
db.getCollection("desk-order-events").find({clientOrderId:id}).sort({_id:1});
db.getCollection("desk-order-events").find({clientOrderId:/^SENSEX-delta-lean-(aggressive|conservative)-2026-10-01:paper:5#/}).sort({ts:1});
db.getCollection("desk-gateway-orders").findOne({clientOrderId:id});
db.getCollection("desk-fills").find({$or:[{brokerOrderId:"sim-mud1q35xnv2w24-342"},{baseClientOrderId:/aggressive-2026-10-01:paper:5#/}]}).sort({ts:1});
db.getCollection("desk-order-events").find({tag:"SENSEX-delta-lean-conservative-2026-10-01", tradingsymbol:"SENSEX26O0171800PE"}).sort({ts:1});
db.getCollection("desk-gateway-orders").findOne({tag:"SENSEX-delta-lean-conservative-2026-10-01", tradingsymbol:"SENSEX26O0171800PE", desk_op:"close"});
```

**Supervisor state, the wedge that is still there:**

```js
db.getCollection("desk-supervisor-state").find({key:/SENSEX-delta-lean-.*-2026-10-01/})
  .forEach(s=>printjson({key:s.key,inFlight:s.inFlight,remaining:s.workingPackage&&s.workingPackage.remaining,cum:s.cumRealized}));
```

**Book marks: spot, net delta, P&L and reason every 5 minutes (§2.1–2.3):**

```js
const ist=ms=>new Date(+ms+19800000).toISOString().replace("T"," ").slice(0,19);
db.getCollection("desk-book-marks").find({tag:"SENSEX-delta-lean-aggressive-2026-10-01", dateIst:"2026-10-01"}).sort({ts:1})
  .forEach(d=>print(ist(d.ts),d.mark,d.spot,d.netDelta.toFixed(2),Math.round(d.totalPnl),d.reason));
```

The same query was run for `SENSEX-delta-lean-conservative-2026-10-01`.

**Block and wait reasons across the window (§2.3):**

```js
const q={tag:/delta-lean-(aggressive|conservative)-2026-(09-2[3-9]|09-30|10-01)/, dateIst:{$gte:"2026-09-23",$lte:"2026-10-01"}};
const pats={spent:/adjustments are spent/, cap:/SPAN cap/, stuckwin:/stuck window/, nostrike:/no tradable strike/, notrun:/clock is not running/, met:/nothing to add/};
const c={}; for (const k in pats) c[k]=db.getCollection("desk-book-marks").countDocuments({...q, reason:pats[k]});
printjson({marks:db.getCollection("desk-book-marks").countDocuments(q), ...c});
db.getCollection("desk-book-marks").find({dateIst:{$gte:"2026-09-23",$lte:"2026-10-01"}, reason:/adjustments are spent/}).sort({ts:1});
```

**Refused adjustments (§1.4):**

```js
const c={};
db.getCollection("desk-engine-decisions").find({tag:/delta-lean/, trigger:{$in:["dl-neutral","dl-add"]},
  receivedAt:{$gte:Date.parse("2026-09-22T18:30:00Z"),$lt:Date.parse("2026-10-01T18:30:00Z")}, "response.skips.0":{$exists:true}})
  .forEach(d=>d.response.skips.forEach(s=>{const k=s.reason.replace(/'[^']*'/,"X"); c[k]=(c[k]||0)+1;}));
printjson(c);
```

**Dials, day guard and marks:**

```js
db.getCollection("desk-books-registry").findOne({tag:"SENSEX-delta-lean-aggressive-2026-10-01"}).dials;
db.getCollection("desk-books-registry").findOne({tag:"SENSEX-delta-lean-conservative-2026-10-01"}).dials;
db.getCollection("desk-strategies").findOne({tag:"SENSEX-delta-lean-aggressive-2026-10-01"}).dailyLimits;
db.getCollection("desk-daily-guard").find({tag:/SENSEX-delta-lean-.*-2026-10-01/});
db.getCollection("desk-marks").find({token:{$in:[227040261, 265]}});
```

**Supervisor log, 1 Oct (UTC):**

```sh
grep -n "SENSEX" logs/desk-supervisor-out__2026-10-02_00-00-00.log
sed -n 55,140p logs/desk-supervisor-out__2026-10-02_00-00-00.log
```
