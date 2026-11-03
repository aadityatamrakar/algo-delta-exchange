# Traders risk: portfolio stress, historical replay, correlation, results-event risk, vol-cue fix

Date: 24 Oct 2026 (IST). Branch `feat/traders-risk`. Wire contract: `apps/traders/src/analytics/risk-wire.ts`.

> "use llmquant skills to rethink what we are missing … we are trading equity options … we dont need f&o ban list,
> things we can get from nse we dont need."

The operator chose all four (24 Oct): portfolio stress, results-event risk per book, the vol-cue fix, and concentration
and correlation. Everything here is computed on the traders' own books. The only thing taken from NSE is the results
date, which the event analytics need as an input. The page does not show it as a calendar.

## 1. What the llmquant checklists found missing

| llmquant workflow | Its check | Traders today | Gap |
|---|---|---|---|
| greeks-dashboard | the largest risk across the whole position | greeks per book; Portfolio sums deltas in shares | no common unit across stocks, no "largest risk" line |
| pnl-simulator | price, IV, gap and event shocks; tail loss | Scenario grid per book | no shock across all books together, no tail figure |
| single-stock playbook | stress the event outcomes | none | results dates are not known at all |
| earnings-iv-crush | implied move vs past actual moves, crush history | none | as above |
| iv-rank (guardrail) | "do not sell premium on IV rank alone; check event risk" | Vol cue rich = IVR ≥ 50 and VRP > 0 | the cue calls IV "rich" when results fall before expiry |
| (portfolio) | concentration, correlation | none | 11 stocks held; nothing says which move together |

Already covered and left alone: IV rank and percentile, VRP, term, 25Δ skew, the scenario grid, payoff, SPAN margin,
the range calculator, repair, band and advice, the AI desk.

On 24 Oct three held stocks reported around the 27 Oct expiry (PAYTM 26 Oct, MARUTI 27 Oct, ADANIPORTS 28 Oct), and no
screen showed it.

## 2. Rulings (the main session's; lanes do not re-decide these)

R1. **Change, not P&L.** Every rupee figure is a change from the book's value now under a stated shock. Labels: "Change"
and "Loss". No new P&L or MTM headline (memory: P&L and Today only).

R2. **Full reprice.** Every shock reprices the legs through `packages/payoff` `scenario()` on the book's minute
snapshot (`marketOf(snapshot)`, the same snapshot Analysis and Scenario use). Linear delta × move appears only as
`betaDeltaRupees`. Unmatched legs are left out with the snapshot's own warning.

R3. **Beta and correlation** come from `HistoryStore.bars(stock, 260)` closes (already back-adjusted). Use daily log
returns aligned by date with NIFTY's bars (`bars('NIFTY', 260)`, which are futures closes adjusted at the roll) and keep
the last ≤ 250 aligned pairs. Under 60 pairs the figure is null with a warning. NIFTY's own beta is 1. Pairwise
correlation uses the same rule.

R4. **Stress grid:** NIFTY moves [−10, −5, −3, −1, 0, 1, 3, 5, 10] % × vol shifts [−5, 0, +5, +10] points. Each stock
moves by beta × the NIFTY move, every option's IV takes `volShift`, and the valuation instant is now. Change per cell =
pnl(shocked) − pnl(unshocked) at the same instant. A book with no beta is excluded and named.

R5. **Historical replay:** take the last ≤ 250 dates on which every held stock has a return. For each date t, reprice
every book with spot × exp(r_stock,t), vol unchanged, valued now, and sum the changes. var95 / var99 are the 5th / 1st
percentiles (nearest-rank, losses negative), and es99 is the mean of the changes at or below var99. Show the three
worst dates with each book's part. Stocks with under 60 days of history drop out (warned). If fewer than 60 dates are
left, the replay is null. Notes: "vol unchanged", "today's legs", "one day".

R6. **Concentration:** daySigma = HV20 ÷ √252, else the context's near ATM IV ÷ √252. twoSigmaLoss = min(change at
+2σ, change at −2σ, 0). sharePct = the book's twoSigmaLoss ÷ the sum over books.

R7. **Clusters:** stocks joined when pairwise correlation ≥ 0.6, transitively (union-find). Only clusters of 2 or more
are listed. togetherLoss = the worse of every member moving +2σ_i together or −2σ_i together. standaloneLoss = the
sum of the members' own twoSigmaLoss.

R8. **Headline:** the worst grid cell, as one sentence: the move, the vol shift, the rupee change, and the book that
loses most in it. Null when nothing is valued.

R9. **Results dates (the one NSE input):** `scripts/nse_vol_job.py` gains an events step that writes
`<nseDir>/events.json` and never touches the vol file.
- One request to `/api/event-calendar?index=equities`.
- One request per held stock to `/api/corporate-board-meetings?index=equities&symbol=S&from_date=<today−400d>&to_date=<today>`
  (dates DD-MM-YYYY), for at most 40 stocks, cached in the file for 7 days.
- Keep only purposes that match `/financial results/i`. Dates are ISO, one per day (an intimation row on the same day
  is a duplicate).
- 3 failures in a row stop NSE for the run, and the previous file's entries are kept.
- The file is written atomically. The step runs only after the vol step and never fails it.

`events.json` v1:

```json
{ "v": 1, "writtenAt": "2026-10-24T15:00:00Z",
  "upcoming": { "MARUTI": [{ "date": "2026-10-27", "purpose": "Financial Results" }] },
  "past": { "TCS": { "fetched": "2026-10-24T15:00:00Z", "meetings": [{ "date": "2026-07-09", "purpose": "Financial Results/Dividend" }] } },
  "errors": [] }
```

`upcoming` covers every F&O symbol in the calendar (one request), and `past` covers the held stocks only.

R10. **Past reactions:** for each past results date d inside the bars: pre = the last bar before d, post = the first
bar after d, move = post.close ÷ pre.close − 1, and crush = (post.atmIv − pre.atmIv) × 100 when both are known.
provisional = fewer than 3 reactions, or the next date's purpose is not results.

R11. **Implied move** = (ATM CE + ATM PE) ÷ future of `next.expiry`. Use live quotes (mid when both sides are present,
else LTP) at the strike nearest the future, from the book snapshot when that month is held, else from the market
quotes for that expiry. Null with a warning when neither is quoted. ratio = impliedMove ÷ pastAbsMean. The verdict is
rich ≥ 1.25, cheap ≤ 0.8, otherwise fair. Note on the page: the straddle covers the whole time to expiry, not just the
event, so a far expiry reads rich.

R12. **Event outcomes**, only when the book holds through the date: move ±pastAbsMean ("up"/"down") and
±1.5 × pastAbsMean ("up-big"/"down-big"), plus "crush-only" (move 0). Every outcome gets volPts = crushMeanPts when 2 or
more reactions have it, else −5 (warned). The instant is the first NSE trading day after d at 09:15 IST, and the change
is measured against the book's value now. When pastAbsMean is null, impliedMove is the move (warned). When both are
null there are no outcomes.

R13. **Vol cue fix:** `VolRow` gains `results: { date, expiry, inNear } | null`. When `inNear` is true, the page's
cue is **event**, shown amber with the tooltip "IV includes results on <date>: rank not comparable". It replaces
rich or cheap. The assistant's context gets the same field, and its prompt gets one line: "IV rank with results before
the near expiry is event-inflated: never call premium rich on it".

R14. **Alert `results-ahead`:** from 09:15 IST on the trading day before the results date and on the day itself, one
alert per (trader, stock, date) for a book that holds through it. Body: date, expiry, and the down and up outcome
changes in rupees.

R15. **Access:** `GET /v1/traders/risk` and `GET /v1/traders/events`, both kind trader. An admin passes `?as=` for one
trader. Without it the admin gets every trader's books per stock: the stocks' books are summed by repricing every
trader's legs of that stock as one leg list, the way the admin Portfolio rolls up per underlying. Results are cached
60 s per (trader | null). Nothing is written.

R16. **Assistant:** a `get_risk` tool returns `RiskView` and `EventRiskView` for the trader in scope, read through the
same functions as the routes. One line in the prompt points to it for "what if the market falls" and "results" questions.

## 3. Page

Sidebar **Risk**, after Portfolio:
1. **Headline** (R8) and the totals: β-weighted Δ (₹ and NIFTY lots), and NIFTY ±1 % change.
2. **Stress grid** (R4): losses red, gains green, the 0/0 cell outlined, and the worst book in each cell's tooltip.
3. **Results**: one row per held stock with a date, soonest first. Columns: date and days, expiry ("near" badge),
   implied move, past mean |move| (n), ratio and verdict, mean crush, and the up / down / big / crush-only changes. The
   past reactions open on a click. Provisional rows are greyed and say so.
4. **Historical replay**: VaR 95 and 99, ES 99, and the three worst days with the per-book split.
5. **Concentration**: book, β, ρ to NIFTY, β-weighted Δ, 2σ loss and its share bar, sorted by share.
6. **Correlated clusters**: members, mean ρ, together loss vs standalone loss.
Polled every 60 s. Warnings go under Notes, as on Vol.

Book screen header: a badge "Results 27 Oct · near expiry" when the book holds through a results date. Its tooltip
gives the down and up outcome changes.

Vol page: the event cue (R13).

## 4. Files

| File | Lane |
|---|---|
| `scripts/nse_vol_job.py`, `scripts/test_nse_vol_job.py`, `scripts/fixtures/nse_vol/events-*.json` | A |
| `apps/traders/src/market/events-store.ts` (reads events.json, refresh like VolStore) | B |
| `apps/traders/src/analytics/event-risk.ts` (pure: reactions, implied move, outcomes) | B |
| `apps/traders/src/routes/events.ts`, the vol row `results`, the context field, `alerts/rules.ts` results-ahead | B |
| `apps/traders/src/analytics/returns.ts` (pure: aligned log returns, beta, corr, percentile) | C |
| `apps/traders/src/analytics/shock.ts` (pure: a book snapshot × [spot factor, volPts, instant] → change) | C (B imports it) |
| `apps/traders/src/analytics/portfolio-risk.ts`, `apps/traders/src/routes/risk.ts`, the assistant `get_risk` | C |
| `apps/web/src/traders/risk.tsx`, `pages.tsx`, `api.ts`, `vol.tsx` cue, the book header badge | D |

`shock.ts` signature (fixed here so B and C agree):

```ts
export interface Shock { readonly spotFactor: number; readonly volPts: number; readonly at: ValuationPoint | null /* null = now */ }
/** The change of the book's matched legs under each shock, rupees, vs its value now; null entries = unpriced. */
export function shockBook(s: BookSnapshot, shocks: readonly Shock[]): { readonly changes: readonly (number | null)[]; readonly warnings: readonly string[] }
```

## 5. Tests

Pure modules come with fixture tests. Each figure gets a hand-checked case: beta of a doubled series is 2; var99 by
nearest rank on 100 known values; a cluster of 3 joined through a chain; a reaction across a weekend; an outcome
instant on the trading day after a Friday result.

Route tests use the existing in-memory deps and the `TRADERS_TEST_LANE` db isolation. They must not reach live ports
(memory). The Python tests use fixtures and never the network.

`make check`, `cd apps/web && npx tsc -b`, and `.venv-nse/bin/python -m pytest scripts/test_nse_vol_job.py` must all
be green.

## 6. Operator after merge

1. `npm run build -w apps/web` (the agent does this). The page goes live on build; the routes need step 2.
2. `npx pm2 restart desk-traders --update-env` (the operator's step).
3. The events step runs with the vol job at 20:20 IST. To run it now:
   `.venv-nse/bin/python scripts/nse_vol_job.py --events-only`.
