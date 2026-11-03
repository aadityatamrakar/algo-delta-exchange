# Desk review: what we traded, what works, what does not

Written 2026-10-16. Window: **2026-07-28 to 2026-10-15**, 55 trading days; 16 Oct is
excluded. Everything is **paper** unless marked **LIVE**.

- **Paper is an upper bound.** The engine simulator paid no spread; touch fills
  arrive with this change. The hosted rail fills at the mid.
- **Sources.** Read-only queries over `desk-daily-reports`, `desk-decisions`,
  `desk-engine-decisions`, `desk-order-events`, `desk-gateway-orders`, `desk-fills`,
  `desk-submissions`, `desk-book-marks` and the pm2 logs, plus a code review of
  every algo.
- **Reconstruction check.** The fill ledger reproduces 840 of the 850 report rows.

The design that follows from this review is
`docs/superpowers/specs/2026-10-16-six-playbooks-design.md`.

## 1. Headline

1. **₹11.47 lakh of clean paper P&L, and 79% of it is short ATM straddles.** Most
   of that comes from one uncapped "+1 lot per new straddle" pyramid. At a flat
   1 lot:
   - BULL_S_1 makes **₹1.39 lakh**, not ₹5.60 lakh.
   - BULL_SNX_1 **loses ₹10k**, where its record shows +₹2.42 lakh. Its record is
     one day: 1 Oct, +₹2.65 lakh after an intraday low of −₹3.15 lakh, with 117
     straddle-lots open.
2. **Only one NIFTY/SENSEX record survives the artifact filter and costs: NIFTY
   delta-lean conservative.**
   - +₹24.9k over 16 days, PF 4.2, maximum drawdown −₹3.7k.
   - +₹17.3k after charges and 25 bps of slippage.
   - All 16 days fall in one volatile, falling regime.
3. **Short premium wins quiet days and breakouts win directional days.** Each loses
   on the other kind. The 09:15 gap tells the two apart (§4).
4. **The worst day on the desk was a pricing defect.** Weekly chains were priced
   off the monthly future, 300-560 points too high on SENSEX. On 1 Oct the "0.30Δ"
   short put was at the money.
5. **LIVE: ₹65k.** DLF +₹48.8k, TCS +₹21.5k, BHEL −₹7.1k, mirrors +₹2.0k over 4
   days. The 205 live fills came in 53-165 bps of premium worse than the desk had
   booked them.

## 2. Excluded as artifacts (≈ ₹1.81 lakh paper)

| Item | ₹ | What happened |
|---|---:|---|
| Stranded legs, 4-15 Aug | 1.13 lakh | The 13:47 switch-off on 4 Aug also blocked exits: 14,528 closes were refused. The legs were cleared on Saturday 15 Aug at stale marks. |
| Pre-market opens at the prior close, 28-31 Jul | 53.8k | |
| MIRROR_A010 guard closes before the open, 8 Sep | 11.8k | |
| Closes re-sent after the 12 Aug restarts | 2.9k | |
| BULL_* on 4 Aug | (day dropped) | Closed at cost; the real P&L is unknown |

**Never sum `total` in `desk-daily-reports`.** It reads ₹15.8 lakh against ₹12.9
lakh realised; the 30-day lookback invents legs.

## 3. Scorecard (clean paper)

| Strategy | Days | Total ₹ | Win | PF | Max DD | Note |
|---|---:|---:|---:|---:|---:|---|
| NIFTY-dl-conservative | 16 | +24,905 | 62% | 4.19 | −3,663 | the only index record that survives costs |
| NIFTY-dl-aggressive | 16 | +10,992 | 50% | 1.40 | −22,207 | 92% of it from one day |
| SENSEX-dl-conservative | 16 | −8,307 | 62% | 0.72 | −19,766 | 1 Oct |
| SENSEX-dl-aggressive | 16 | −4,767 | 62% | 0.92 | −45,805 | 1 Oct |
| BULL_S_1, flat 1 lot | 54 | +1,38,757 | 81% | 3.33 | −26,114 | BANKNIFTY monthly straddle; +₹56k at 25 bps |
| BULL_SNX_1, flat 1 lot | 51 | −10,206 | 57% | 0.94 | −70,817 | SENSEX weekly straddle |
| LION_S25_2 | 55 | +1,02,219 | 73% | 2.72 | −13,255 | ≈ flat at 25 bps |
| EAGLE_S_1 | 52 | +1,26,470 | 71% | 4.46 | −19,994 | 76% of it on 29 Sep (BANKNIFTY monthly expiry) |
| ORB_FUT_SNX / NIFTY / BN | 41 / 43 / 16 | +44,220 / +18,388 / +14,682 | | | | exits defective (§6) |
| ORB_SCALP_SNX / NIFTY / BN | 40 / 41 / 20 | +6,423 / +978 / +3,456 | | | | about zero after costs |
| BN_BREAKOUT | 55 | −1,483 | 56% | 0.96 | | |
| ATR_BAND_NIFTY | 24 | −6,451 | 38% | 0.54 | | traded only on restart days |
| Mirrors (A006, A010, 1PBUY, EMA2050) | | −49k together | | | | source down since 11 Oct |
| Hold-to-expiry (7 books from 6 Oct) | | +18.2k realised | | | | too early to judge |
| Stock recenter books | | KALYANKJIL +1.08L, TATASTEEL +53k, TCS Sept −1.19L (restated) | | | | multi-week holds |

**Costs.** Charges are ₹25-50 per option fill and about ₹225 per futures fill. At
25 bps of slippage only these stay positive:

| Strategy | At 25 bps |
|---|---:|
| BULL_S_1 (flat) | +₹56k |
| EAGLE | +₹98k |
| NIFTY-dl-conservative | +₹17.3k |
| ORB_FUT_SNX | +₹14.8k |
| ORB_SCALP_SNX | +₹2.8k |

## 4. Conditional results: what earns where

**By how the day closed (family-days):**

| Day | Short premium (BULL flat, LION, EAGLE) | Breakouts (8 configs) |
|---|---|---|
| Close within 0.3% of the open | 115 days, 90% won, **+₹3.75L** | 127 days, 39% won, −₹53k |
| Close 0.7% or more from the open | 33 days, 45% won, −₹72k | 53 days, 89% won, **+₹1.38L** |

**Delta-lean v2, by opening gap:**

| Gap | Book-days | Won | P&L |
|---|---:|---:|---:|
| ≥ 0.25% | 44 | 73% | +₹95k |
| < 0.25% | 20 | 30% | −₹73k |

**SENSEX gaps.**
- A gap of 0.6% or more became a directional day 57% of the time; under 0.25%, 6%.
- Breakouts won 70% of the ≥ 0.6% gap days.
- Short premium did best on 0.25-0.6% gaps (79% won).

**Expiry days are thin and concentrated:**

| Strategy | Expiry days, P&L | Other days, P&L |
|---|---|---|
| BULL_SNX_1, flat 1 lot (SENSEX) | 12 days, −₹33k (42% won) | 39 days, +₹23k |
| SENSEX delta-lean (both books) | 8 book-days, −₹39.5k (1 Oct alone −₹62k) | 24 book-days, +₹26.4k |
| EAGLE (BANKNIFTY monthly) | 3 days, +₹86.8k (29 Sep alone +₹96.7k) | 49 days, +₹39.7k |

- **BULL_SNX_1's SENSEX expiry-day legs, by sale time:**
  - before 13:00: −₹42.2k over 130 legs;
  - 13:00-14:30: **+₹11.2k over 26 legs, 62% won**;
  - after 14:30: −₹2.3k.
- **Delta-lean expiry mornings:** trend-spread opens made +₹37.9k (8 opens). Sales
  in the first hour lost −₹68.8k. Sales after 11:00 made +₹20k (7 of 8 won).

## 5. Delta-lean v2, package by package (64 book-days, 216 packages, +₹22,822)

| Package | n | ₹ | Won |
|---|---:|---:|---:|
| OPEN put debit spread (trend-down) | 27 | **+1,12,144** | 67% |
| OPEN call debit spread (trend-up) | 32 | +22,941 | 50% |
| OPEN iron condor (quiet) | 5 | **−56,552** | 20% |
| ADJ counter-buy | 15 | +47,008 | 67% |
| ADJ pyramid buy | 44 | +40,071 | 52% |
| ADJ same-side ATM sale (chop/quiet) | 93 | **−1,42,790** | 48% |

- Same-side sales within 40 minutes of the open: −₹1,66,784. At or after 12:00:
  +₹53,414.
- Opens at 09:30-09:45: +₹1,26,258.
- **Exits.** 61 of 64 book-days ended on the 14:50 flatten. The ₹10k target fired 3
  times. The stuck exit and the backstop never fired.
- **Winners run late.** 29 of 38 winning days printed their best mark after 13:30.
  Books up more than ₹2k at 13:00 never finished below that (15 of 15).
- **Same-strike adds refused as "already open".** 73 times (53 on the four daily
  books). The days with a refusal made +₹50.8k; the days without, −₹27.9k.

## 6. Defects found, ranked by likely cost

| # | Severity | Defect | Status |
|---|---|---|---|
| 1 | CRITICAL | Weekly chains are priced off the monthly future: the ATM strike, deltas, band strikes and the regime straddle are all biased (SENSEX by up to 0.8%) | **Fixed** (spec F1): a per-book parity forward and a kill switch |
| 2 | CRITICAL (by design) | BULL_S_1 / BULL_SNX_1 / EAGLE_S_1 accumulate naked shorts without a cap; BULL_SNX_1 is keyed off the monthly future | Recommended (G4, G5) |
| 3 | HIGH, live | `liveLots` resizes entries but not exits, on every hosted strategy and mirror | Recommended (G9) |
| 4 | HIGH | Recenter books have no loss exit and no day guard | Recommended |
| 5 | HIGH | Delta-lean "flat" adjustments are naked shorts at 0.45-0.60Δ | Recommended (G1) |
| 6 | HIGH | Delta-lean delta bands run dry on expiry afternoons | The playbooks use straddle units on 0-DTE; delta-lean is unchanged (G3) |
| 7 | HIGH | ORB_FUT exits are judged on index ticks | Recommended (G6) |
| 8 | HIGH | Mirrors: a missed entry becomes a reverse entry; no dedupe | Recommended (G8) |
| 9 | MED-HIGH | Paper fills: engine paper paid no spread, and a crossed limit could rest for ever | **Fixed** (F2): touch fills |
| 10 | MEDIUM | No expiry-day buffer on the decision path | **Fixed** (F3), for `dl-*` and `eod` |
| 11 | MEDIUM | The holiday table ends 2026-12-25 and fails open | Recommended (G10) |
| 12 | MEDIUM | CHEETAH_B1_* cannot trade (runner quotes carry no `ohlc`) | Recommended (G7) |

## 7. Operational problems that changed P&L

| Problem | Count | Effect |
|---|---:|---|
| A switch-off blocked exits (4 Aug) | 14,528 refused closes | ₹1.13L of stranded-leg P&L |
| BULL_SNX_1 opened straddles after its own 15:20 square-off | 28 | −₹50.5k |
| Hold-book exits fired on the incoherent 09:15:00 marks | 2 | a "₹12.1k target" banked ₹1.1k; a "−₹30.4k backstop" realised −₹0.9k |
| The 1 Oct 14:55 flatten wedged behind a cancel latch (fixed 4 Oct) | 1 | ≈ −₹9.6k |
| Live fills worse than booked | 205 | ₹14.4k adverse |

## 8. Lessons carried into the six new algos

1. Choose the structure for the regime, and read the regime at the open (the gap).
2. Set stop width by the contract's gamma and the expected move, not as a fixed
   multiple of premium. Define risk with wings.
3. Never let size grow with re-entries or losses.
4. Price every expiry off its own forward.
5. On expiry day, sell premium late, small and with wings. Avoid short gamma in the
   morning.
6. Neutralise directional books by buying, not by selling ATM.
7. Hold winners into the afternoon. Prefer a trailing floor or a time exit to a
   fixed target.
8. Require gross edge per fill well above costs, and favour few orders.
9. Size so that a winning day's normal intraday drawdown fits inside the stops.
10. Exits must never be blocked. Never act on the 09:15:00 tick. Filter exit checks
    by token. Fill a crossed limit on the touch.
11. Depend on no third-party signal.

## 9. Recommendations for the existing algos (not applied)

These are G1-G13 of the spec. The ones worth the operator's decision first:

- **G4.** Cap the BULL pyramid at 3 lots, key BULL_SNX_1 off index spot, and keep it
  off SENSEX 0-DTE before 13:00.
- **G1.** Restrict delta-lean's flat sales to after 12:00, or remove them.
- **G6.** Fix ORB_FUT's exit token filter. Its signal is real: breakouts won 89% of
  directional days.
- **G8.** Retire the mirrors, or fix them.
- **G5.** Put a day-loss guard on EAGLE_S_1.
