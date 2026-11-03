# Delta Desk AI — NSE volatility: IV rank, IV percentile, VRP (addendum)

Date: 23 Oct 2026 (IST). Branch `ai/vol` (Lane 5). Addendum to `2026-10-23-traders-ai-desk-design.md` §5.

> "Is it possible to scrap daily eod data from nse for stocks that traders have positions and show IV percentile and
> iv rank and vrp info? … there is nsepython server edition that we can use."

Yes. End of day, per held stock: a fixed-tenor ATM IV, its rank and percentile, HV10/HV20, the volatility risk
premium (ex-ante, its percentile, and realized), term structure and 25-delta skew. The bhavcopy history (Lane 2) is the
backbone; NSE's live API adds only NSE's own IV figure.

## 1. Research (23 Oct, 00:25 IST, from this AWS box)

**nsepythonserver 2.101** (PyPI 7 Oct 2026; the version already in `.venv-nse`). Transport: a `curl_cffi` session
impersonating Chrome 124, warmed with three page GETs (home, live-equity-market, option-chain) for Akamai's cookies;
`nsefetch` re-warms once on a 403/404, then raises `NSEFetchError`. Useful here:

| Function | What it gives | Use |
|---|---|---|
| `nsefetch(url)` | any NSE JSON API through the warmed session | the job's chain fetch |
| `expiry_list(sym)` | listed expiries (`getOptionChainDropdown`) | only when the day's FO bhavcopy is missing |
| `nse_optionchain_scrapper` / `oi_chain_builder` | `getSymbolDerivativesData`: futures and options, prices and OI | not used: **no `impliedVolatility` field** (the builder's IV column is always 0) |
| `equity_history`, `derivative_history` | `historicalOR` endpoints, 40-day chunks, one contract per call | not used: a year of ATM series is thousands of calls; the bhavcopies have it |
| `nse_quote(sym, 'trade_info')` | `cmDailyVolatility`, `cmAnnualVolatility` of one symbol | not used: CMVOLT has every symbol in one file |

NSE requests made (5, all HTTP 200): home; `getSymbolDerivativesData` TCS (180 rows, no IV); `CMVOLT_22102026.CSV`
(4,986 rows); home; `option-chain-v3?type=Equity&symbol=TCS&expiry=27-Oct-2026` (has `impliedVolatility`, percent).

**Finding: NSE's per-side IVs carry a spot/rate convention.** TCS 27 Oct, strike 2500: CE 21.36%, PE 26.96%. Their
mean, 24.2%, matches a Black-76 solve off the future (24.4%). So the ATM IV takes the mean of both sides, and the skew is
not taken from NSE's per-side IVs (that gap is carry, not skew).

**CMVOLT** is EWMA (λ = 0.995) daily volatility × √365, not close-to-close × √252: kept as a cross-check (`nseHv`).

## 2. Sources and fallbacks

| Figure | First | Else |
|---|---|---|
| Near ATM IV, today | NSE `option-chain-v3`: mean of CE and PE IV at the ATM strike (`ivSource: 'nse'`); one request a stock, at most 40 stocks | solved from the day's FO bhavcopy closes (`'bhavcopy'`) |
| Next-month ATM IV | solved from the FO bhavcopy closes | null |
| IV history | the snapshots' near IV | the history's `atmIv`, solved from span_job's `ivAtm` (the nearest expiry's in summaries written before it) |
| Closes, HV | the history bars (cash close; an index's future) | the snapshot's spot |
| Skew | traded closes in the FO bhavcopy, solved against the near expiry's future | null (said) |
| NSE HV | `CMVOLT_<DDMMYYYY>.CSV` | null |

With NSE's API unreachable, everything but `ivSource: 'nse'` still comes from the bhavcopies on disk.

## 3. Definitions (as built)

- **Tenor (review fix 2, replaces the brief's "near month, roll at 3 days")**: every ranked IV is the ATM IV of the
  **first listed expiry at least 7 calendar days out**: span_job's `ivAtm` in the history, the vol job's near expiry,
  and the market context's live IV (`IV_TENOR_DAYS`). The series spans about 7–35 days for a stock and 7–13 for an
  index weekly, so an expiry-eve option, or a 1-day weekly (√2 a 4-day one), never sets the year's high. **Next** is
  the last expiry of the following calendar month (term structure).
- **IV**: that expiry's ATM IV, decimal. ATM = the strike listed both sides nearest the expiry's own future close
  (else the spot; solved off put-call parity when it lists no future). A day's IV is its snapshot's, else its history
  bar's.
- **Closed market (review fix 1)**: the context's live IV is the last closed session's end-of-day IV when the history
  holds it; else the quotes are solved with time to expiry measured from the quotes' own time (a 30% Friday chain read
  31% on Saturday before).
- **Corporate actions (review fix 3, 5)**: span_job writes NSE's previous close (`pc`); where it is not the day
  before's close by more than 1%, or an index's bars move to the next future contract, `HistoryStore.bars` scales
  every older price by pc ÷ that close (volume divided), only when every weekday between the two bars is known closed
  (NSE's 2025 and 2026 holidays, or recorded unpublished by the backfill in `history/unpublished.json`); never across
  a day that is simply missing. HV, ATR, SMAs and the
  52-week levels see no false gap; a corporate action is a warning naming the date on the context and the vol row.
- **IV rank / percentile**: levels.ts `ivStatsOf`, shared with the market context: over the last 252 days, today
  included; rank = (IV − min)/(max − min) × 100; percentile = % of those days with IV strictly below today's. Null
  under 60 days of IV, with the count.
- **HV10 / HV20**: levels.ts `hv`: sample stdev of log returns × √252.
- **VRP**: IV − HV20 (decimal; 0.05 = 5 vol points); ratio IV/HV20; its percentile as above (60 days).
- **Realized VRP**: for each day t in the window with t + 20 ≤ today, IV(t) − HV of the 21 closes t…t+20; mean,
  median, % positive ("paid"), count. Null under 60 pairs. Windows overlap: 232 pairs ≈ 11 independent periods.
- **Term**: near vs next ATM IV, from the snapshot.
- **Skew**: the near expiry, put IV − call IV at the traded strikes nearest −25Δ and +25Δ (Black-76 off the future,
  `DEFAULT_RATE`); each must land within 17–33Δ, else null. Changed from "NSE's chain IVs" for the bias in §1.
- **Premium cue** (page only): rich = IVR ≥ 50 and VRP > 0; cheap = IVR ≤ 20 and VRP < 0.

## 4. Files

| File | Role |
|---|---|
| `scripts/nse_vol_job.py`, `scripts/test_nse_vol_job.py`, `scripts/fixtures/nse_vol/` | the evening job and its tests (no network) |
| `scripts/span_job.py` | `ivAtm` and `pc` in each history entry; `iv_expiry`, `next_month_expiry`; the backfill's stops |
| `apps/traders/src/market/held.ts` | writes `held.json` from the open legs the SPAN pass reads each minute |
| `apps/traders/src/market/vol-store.ts` | reads `vol/*.json` each minute (with the end-of-day files), newest 400 days |
| `apps/traders/src/analytics/vol-metrics.ts` | pure: `summarizeChain`, `volMetrics` |
| `apps/traders/src/routes/vol.ts` | `GET /v1/traders/vol` |
| `apps/traders/src/market/history.ts`, `analytics/context.ts`, `analytics/levels.ts`, `analytics/context-wire.ts` | the tenor IV, `adjustBars`; the closed-market IV; the context's vol fields |
| `apps/web/src/traders/vol.tsx`, `portfolio.tsx`, `pages.tsx`, `api.ts` | the Vol page and the Portfolio's columns |

`<nseDir>/held.json`: `{ "asOf": "<ISO>", "stocks": ["TCS", …] }`: every trader's open books, symbols only.

`<nseDir>/vol/<YYYY-MM-DD>.json` (v1, ~150 KB with CMVOLT): `{ v, date, writtenAt, cmvolt: { file, symbols: { SYM:
[daily, annual] } } | null, stocks: { SYM: { spot, sources, near, next, errors } }, errors }`; `near`/`next` =
`{ expiry, rolled (near is not the first listed expiry), future, strikes: [[K, ceClose, peClose, ceIv, peIv], …] }`, strikes within ±30% of the future,
closes only of contracts that traded. `apps/traders/test/fixtures/vol/2026-10-22.json` pins the job and the app
together.

## 5. Route

`GET /v1/traders/vol` (kind trader): a trader's own open books; an admin with `?as=` that trader's, without it every
held stock (`trader: null`). `VolView { asOf, trader, rows: VolRow[], warnings }`; a row is `VolMetrics` plus `stock`
(context-wire.ts). Ownership case `vol.view`.

## 6. Page

- **Vol** (sidebar): held stocks by IV rank, highest first: premium cue, IV and its source, IVR, IVP, HV20, NSE HV,
  VRP, IV/HV, VRP percentile, realized VRP and % paid, near → next IV with months, 25Δ skew, days of IV. Row warnings
  are grouped under Notes. Polled every 5 minutes.
- **Portfolio**: IV, IVR (tinted by the cue), IVP, VRP per book; the IV cell's tooltip holds the rest.

## 7. Agent fields

`MarketContext.vol` gains optional end-of-day fields (filled when the vol store is wired, as in `createApp`):
`volAsOf, ivSource, vrp, vrpRatio, vrpPercentile, realizedVrp { mean, median, positivePct, days }, nearExpiry,
nearIv, nextExpiry, nextIv, skew25, nseHv`. The live `atmIv`, `ivRank`, `ivMinusHv20` are unchanged.

## 8. Operator

1. Venv: none new. `.venv-nse` already has `nsepythonserver==2.101` (`.venv-nse/bin/pip show nsepythonserver`).
2. Check NSE once (after 15:45 IST): `.venv-nse/bin/python scripts/nse_vol_job.py --symbols TCS --dry-run` — one
   `TCS:` line with `[bhavcopy+nse]` and `CMVOLT_<date>.CSV: N symbols`; nothing written.
3. Restart desk-traders onto the build (writes `held.json` within a minute), then the backfill
   `.venv-nse/bin/python scripts/span_job.py --backfill-history 260` (it now writes `ivAtm` and `pc` too; it stops,
   exit 1, after 5 failed or 10 not-published weekdays in a row; a day it already has breaks the row, and the days
   NSE did not publish are recorded and not asked again). A backfill run before this build skips the days it
   already wrote, so those keep no `ivAtm` or `pc`: move `data/nse/history` aside and run it again.
4. Start the job: `npx pm2 start ecosystem.traders.config.cjs --only desk-traders-vol` (cron `50 14 * * 1-5` UTC =
   20:20 IST Mon–Fri, five minutes after the span job's last download; logs `logs/desk-traders-vol-*.log`).

Limits: NSE's IV exists only for evenings the job ran (the live chain has no history); the tenor still varies within
7–35 days (no interpolation to a constant maturity); a blocked NSE leaves `ivSource: 'bhavcopy'` and the rest intact.

NSE politeness in the vol job: one request a stock (the near expiry; the next month is the bhavcopy's), at most 40
stocks a run (the rest are bhavcopy only, logged). 3 failures in a row stop NSE for the run, and an answer that cannot
be used counts as one (`{}`, no expiries); a chain stamped another day means NSE did not trade, and stops it at once.
