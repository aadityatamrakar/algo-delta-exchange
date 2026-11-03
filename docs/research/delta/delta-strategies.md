# Our strategies on BTC options, Delta Exchange India

Written 2026-11-03. Read-only analysis: no repo file was changed, no test was run, no host of
ours was contacted. Market facts come from the market-structure report
(`scratchpad/delta-market-structure.md`, a public-API snapshot of 3 Nov 2026 07:15 UTC with
spot at $76,592) and Delta's public guides. Numbers marked **sim** come from a stylised Monte
Carlo (`scratchpad/calc/bullsim.py`, `stress.py`, `monthly.py`). That model is not a
backtest; §1.5 says what it can and cannot tell you.

Contents
1. BULL-S on BTC (the priority)
2. Delta India BTC options: the facts used
3. What in our code is tied to NSE
4. A "day" and "intraday" on a 24x7 market
5. The other strategy families
6. A secondary starter set (after BULL-S)
7. What is dangerous on BTC

---

## 1. BULL-S on BTC

### 1.1 What it is, and what it did on NSE

BULL-S is the crossover straddle pyramid in `docs/reference/nse/strategy-bull.md` §3, hosted today
as `packages/strategies/src/premium-leg-book` (`Bull_S-1`, `Bull_SNX-1`).

- **Entry.** Each time the reference price crosses a strike level, it sells the ATM straddle at
  that level. It holds at most one live straddle per level (P5).
- **Stop.** Each straddle stops when its combined premium reaches 1.25× the entry premium.
- **Size.** The first straddle is `start` lots, and every accepted entry adds `step`. The
  pyramid is uncapped (D9), and each straddle exits at its own size (P6).
- **Square-off.** The port added a 15:20 square-off. The legacy code had none (R1).

The record, the NSE desk review of 16 Oct (`docs/reports/2026-10-16-desk-review.md` in the NSE repo), 28 Jul to 15 Oct:

| Book | As recorded | At a flat 1 lot | Notes |
|---|---|---|---|
| BULL_S_1, BANKNIFTY monthly, keyed off the monthly future | +₹5.60L | **+₹1.39L**, 54 days, 81% won, PF 3.33, max DD −₹26k; +₹56k at 25 bps | Won 97% of days that closed within 0.3% of the open. The best short-premium record on the desk. |
| BULL_SNX_1, SENSEX weekly | +₹2.42L | **−₹10k**; −₹64k at 25 bps; 188 stop-outs | Nearly all of the recorded total came on 1 Oct: +₹2.65L after an intraday low of −₹3.15L, with 117 straddle-lots open. Legs sold before 13:00 on expiry days lost −₹42.2k. It also opened 28 straddles after its own 15:20 square-off (−₹50.5k). |

The review's G4 recommendation has not been applied: cap the pyramid at 3 lots, key off index
spot, and keep off 0-DTE mornings. Neither book was switched off on 30 Oct.

**What this means for BTC.** The idea works on a long-dated contract at flat size. It loses on
a short-dated contract with dense stops, and the uncapped pyramid only turns those losses into
the occasional huge day. On BTC, the right contract and the cap matter more than anything else.

### 1.2 What "1 strike" means on Delta

Delta lists strikes unevenly. Spacing is dense near the listing-time spot and coarser outside
it, and the ladder differs by expiry. Live chain, 3 Nov, spot $76,592:

| Expiry | Spacing near ATM | Dense band | Outside the band | Whole chain |
|---|---|---|---|---|
| Daily (3, 4, 5 Nov) | **$200** | about 75,200/75,600 to 79,200/79,600 | $400 | 25-28 strikes. The 3 Nov daily's lowest strike is 75,200, only 1.8% below spot. |
| Weekly (6, 13, 20 Nov) | **$500** | 74,000-86,000 (6 Nov); 76,000-83,000 (13 Nov); 76,000-80,000 (20 Nov) | $1,000 | 21-33 strikes |
| Monthly (27 Nov) | **$1,000** | the whole chain | — | 40 strikes, 64,000-103,000 |

**Recommendation.** Define the jump as a fixed dollar grid per expiry type:

| Expiry | Jump 1 | Jump 2 |
|---|---|---|
| Daily | $200 | $400 |
| Weekly | $500 | $1,000 |
| Monthly | $1,000 | $2,000 |

Sell the listed strike at the grid level. Skip a level that has no listed strike. A weekly
trading below 76,000 on 13 Nov therefore behaves as a $1,000 grid, which is what "every listed
strike" means there anyway. The book must **refuse when the ATM is not listed**, and never fall
back to the nearest strike (R5). A 2% fall walks off the bottom of today's daily ladder.
Whether Delta adds strikes intraday is UNCONFIRMED.

How dense the grid is, measured two ways:

| Contract (IV) | ATM straddle, $/BTC | 1-sd day | Instant move to 1.25× stop | Strikes crossed before the first stop (jump 1) |
|---|---|---|---|---|
| Daily, fresh at 17:40 (45%) | 1,433 | $1,800 | $1,280 | 6.4 |
| Daily, 12h left (40%) | 905 | $1,600 | $812 | 4.1 |
| Daily, 4.75h left (30%, the snapshot) | 427 | $1,200 | $385 | 1.9 |
| Weekly, 7 days (40%) | 3,385 | $1,600 | $2,966 | 5.9 |
| Weekly, 3.2 days (40%) | 2,289 | $1,600 | $2,027 | 4.1 |
| Monthly, 24 days (35%) | 5,483 | $1,400 | $4,706 | 4.7 |
| *BANKNIFTY monthly, ~20 days (est.)* | | | ~1,200 pts | ~12 |
| *SENSEX weekly, ~3 days (est.)* | | | ~600 pts | ~6 |

A 1.25× stop sits about 0.87 straddle-premiums away. At jump 1, the pyramid therefore opens
four to six more straddles in the same direction before its first one stops.

- **At jump 1, BTC looks like BULL_SNX_1** (SENSEX weekly, the losing book), not BULL_S_1
  (BANKNIFTY monthly, the winning one).
- **Jump 2 halves the count.** That moves the daily and the weekly halfway toward BULL_S_1's
  shape.

The two BANKNIFTY/SENSEX rows are estimates from typical IVs, not measured.

### 1.3 The price reference: the index, not the perp

- **Trigger on the `.DEXBTUSD` index** (WebSocket `spot_price`, `ticker.spot_price`). Every
  Delta option settles on the 30-minute TWAP of this index, ending 17:30 IST (options guide;
  `spot_30mtwap_price` is the settlement feed).
- **Place the straddle at the listed strike nearest the expiry's own parity forward.**
  - Dailies: the forward is the index (carry is pennies).
  - Weekly 6 Nov: about +$45.
  - Monthly 27 Nov: about +$300, or 0.39%, from C − P at 77,000. That is a third of a monthly
    strike and worth getting right.
  - Delta's quoted IVs look spot-referenced (call IV above put IV at the same strike), so do not
    read the forward off their IV.
- **Not the perp mark.** It carries the funding basis (`annualized_funding` capped at 10.95%) and
  in a cascade can sit well away from the index. Keying off it repeats BULL_S_1's monthly-future
  defect (P13), which G4 says to drop. Use the perp only as a fallback quote while the index feed
  is stale, and open nothing until it returns.
- **The stop is measured on the shorts' ask side** (the desk's exit-side marking, as in the
  playbooks' combined stop), held about 3 s. Do not use LTP: a quiet strike's LTP can be minutes
  old. If a side is one-sided, use Delta's `mark_price`, which is vol-surface based and
  published every 2 s.

### 1.4 What a straddle round trip costs

Fees are 0.01% of notional per fill (≈ $7.66 per BTC at $76.6k), capped at 3.5% of premium, plus
18% GST. Spreads are from the snapshot. Sell at the bid, buy back at the ask:

| Contract | Round trip (fees + spread), $/BTC | Share of premium | Share of one 25% stop |
|---|---|---|---|
| Daily, fresh | 46 | 3.2% | 13% |
| Daily, 12h left | 46 | 5.1% | 20% |
| Daily, 4.75h left | 41 | 9.7% | **39%** |
| Weekly, 3-7 days | 52 | 1.5-2.3% | 6-9% |
| Monthly, 14-24 days ($55 spread) | 146 | 2.7-3.5% | 11-14% |

On BANKNIFTY the same round trip was a fraction of a percent of premium. The fee cap binds
below about $219/BTC of premium per leg, so on late dailies it is the cap that prices you. An
option that expires worthless pays no settlement fee. One that settles in the money pays the
taker rate (whether the cap applies there is UNCONFIRMED). Late daily straddles are therefore
dominated by costs.

### 1.5 What the dials do (sim)

**Model.**
- Paths: one-minute GBM plus Poisson jumps (two-minute steps on the weekly hold, five on the
  monthly hold).
- Pricing: Black-Scholes at a flat IV per expiry, r = 0.
- Costs: the §1.4 spreads and fees on every fill.
- Trading: the legacy crossover on the rounded ATM, a 1.25× stop, a first-tick entry, one
  straddle per level, the flatten at the window end.
- Runs: 400 episodes per cell, 200 for the monthly hold.

**Two worlds.**
- **Fair:** realised vol equals implied, so there is no edge.
- **VRP:** diffusive vol at 0.75 × IV plus jumps (5% a day, sd 3.5%). Total realised vol is
  about 0.84 × IV.

The sim cannot say whether BTC options are rich. It does show the counts, the cost drag, and
how the cap and the jump shape the tail.

**Results.** USD per **10 contracts** of start size (0.01 BTC). Multiply linearly for other
sizes. "Capped" means a 3× size cap and at most 4 open straddles.

| Book | Jump | Sizing | Mean, VRP / fair | P1 cycle, VRP / fair | Straddles a cycle | Peak open size (P95) |
|---|---|---|---|---|---|---|
| Daily, whole cycle 17:40-16:30 IST | 1 | uncapped | +77 / −37 | −515 / −625 | 9.5 / 13.9 | 77-108× start |
| | 1 | capped | +20 / −9 | −238 / −123 | 5.8 / 8.6 | 12× |
| | 2 | capped | +18 / −7 | −112 / −88 | 4.8 / 7.0 | 12× |
| **Daily, window 09:30-16:30 IST** | 1 | uncapped | +5.4 / −8.0 | −35 / −70 | 3.7 / 5.3 | 15-24× |
| | 1 | **capped** | **+4.9 / −5.6** | **−27 / −41** | 3.7 / 5.3 | 11-12× |
| | 2 | **capped** | **+2.1 / −2.2** | **−16 / −21** | 2.2 / 2.8 | 5-6× |
| Weekly, intraday 09:30-01:30, flat at night | 1 | capped | −0.6 / −4.3 | −45 / −64 | 3.1 / 3.8 | 9-11× |
| | 2 | capped | −0.3 / −1.7 | −21 / −26 | 1.9 / 2.2 | 6× |
| **Weekly, held to stop/expiry (7 days)** | 1 | uncapped | +193 / −65 | **−1,887 / −1,749** | 10.8 / 15.4 | 84-119× |
| | 1 | **capped** | **+56 / −16** | **−440 / −326** | 6.6 / 9.8 | 12× |
| | 2 | **capped** | **+42 / −12** | **−397 / −257** | 5.4 / 7.7 | 12× |
| Monthly, intraday 09:30-01:30 | 1 | capped | −3.4 / −4.8 | −19 / −25 | 1.7 / 2.0 | 6× |
| | 2 | capped | −1.6 / −2.3 | −15 / −15 | 1.1 / 1.3 | 3× |
| Monthly, held 28 to 7 DTE | 1 | capped | +35 / −38 | −304 / −420 | 5.8 / 7.5 | 12× |
| | 2 | capped | +20 / −28 | −228 / −322 | 4.3 / 5.6 | 12× |

What holds in both worlds:

1. **With no volatility premium, every BULL-S book loses its costs.** The edge, if there is one,
   is IV above realised. That is the first thing paper must measure: record the IV sold at entry
   against what BTC then realised over the hold.
2. **The uncapped pyramid makes the tail 2-5× worse** on the whole-cycle daily and the weekly
   hold, for a little more mean. A 10-contract start reaches about 1 BTC open on a bad daily
   cycle, and up to 1.7 BTC on a weekly hold.
3. **Jump 2 roughly halves the trade count**, and with it the fees and the tail. In the VRP world
   it keeps about half (daily window) to three quarters (weekly hold) of the mean.
4. **Flattening a weekly or monthly every night does not pay.** The book pays a round trip and
   gives up the night's theta. A monthly's 16-hour theta (~$76/BTC at 24 DTE) is below one
   round trip (~$146/BTC), so the intraday monthly book wins 0-7% of days in both worlds.

### 1.6 Starting Dials per expiry

The two presets differ **only in the jump**, so paper compares like with like. Sizes are
Delta contracts (0.001 BTC); "lots" in the dial names below are contracts. Suggested names are
for the desk-engine book; the implementer chooses.

| Dial | Daily | Weekly | Monthly |
|---|---|---|---|
| Contract | The daily settling at the end of the current cycle (today 17:30 IST) | The front Friday weekly. A new book is created after each Friday 17:30 settlement and runs to the next Friday. | **Off in v1.** If run: the front monthly from listing to 7 days before expiry. The last week belongs to the weekly book, since the last-Friday monthly is that week's weekly. |
| Flatten daily or hold | One cycle by construction | **Hold to stop or expiry**, 24x7 (§1.7) | Hold only; never intraday |
| Entry window, IST (`bull_entry_start/end_min`) | 09:30-15:30 | 09:30-00:30, Mon-Fri. No new straddles Sat 00:30 to Mon 09:30; carried ones keep their stops. | 09:30-00:30, Mon-Fri |
| Flatten (passive / urgent / flat-by), IST | 16:15 / 16:25 / **16:30** | Expiry Friday 16:00 / 16:15 / 16:30 | 7 days before expiry, 16:00 / 16:15 / 16:30 |
| Jump (`bull_jump`) | Preset 1: **$200**; preset 2: **$400** | Preset 1: **$500**; preset 2: **$1,000** | Preset 2 only: **$2,000** |
| Stop multiple (`bull_stop_mult`) | 1.25 (shorts' ask-side value, held 3 s) | 1.25 | 1.25 |
| Start lots (`bull_start_lots`) | 50 (0.05 BTC) | 10 (0.01 BTC) | 10 |
| Lot step (`bull_lot_step`) | +50 | +10 | +10 |
| Cap (`bull_lot_cap`) | 150 (3×, G4) | 30 (3×) | 30 |
| Max open straddles (`bull_max_open`) | 4 | 4 | 3 |
| USD loss cap (`bull_loss_cap`) | **$250 per cycle**: flatten, done until the next cycle | **$500 per book life**: flatten, done until the next weekly | $500 per book life |
| Size reset | Each cycle | Each cycle start (17:30 IST); carried straddles keep their own size | Each cycle start |
| First-tick entry (P1) | On, at the window start | On, at the window start | On |
| Reference | Index; strike at the parity forward | Index + parity basis | Index + parity basis |

**What to expect at these sizes (sim).**
- **Daily (50 contracts).** Jump 1: +$25 a cycle in the VRP world, −$28 in the fair one. P1
  cycle −$134 / −$204. Fees $12-21 a cycle. 4-5 straddles a cycle. The $250 cap binds on fewer
  than 1 cycle in 100. Jump 2: +$10 / −$11, P1 −$78 / −$105.
- **Weekly (10 contracts).** Jump 1: +$56 a week / −$16, P1 −$440 / −$326. Jump 2: +$42 / −$12,
  P1 −$397 / −$257.

**Why these numbers.**
- **The daily trades a quiet, attended window.** The window book has the best mean-to-tail ratio
  in the sim (P1 about 5× the mean, against 12× for the whole-cycle book). It sits inside desk
  hours. It ends before the settlement mark starts blending into the TWAP (from 16:30 IST, the
  fair-price-marking guide). It avoids the US session: at 8:30 ET, US data lands at 19:00 IST in
  winter and 18:00 IST in summer, both after the daily settles. NSE says the same thing: 0-DTE
  premium sold late beat premium sold early.
- **The whole-cycle daily is the later variant to try.** It earns more in the VRP world but
  carries 9× the tail through the unattended night.
- **The cap is 3×** because G4 says so, and because the sim shows the tail is set by the cap more
  than by anything else.
- **Max open 4** bounds simultaneous exposure at 12× start.
- **The loss caps sit near P1 of a capped book**, so they bind about once in a hundred cycles,
  not every bad day.
- **Entry closes 45 minutes before the flatten starts.** BULL_SNX_1's 28 straddles after its own
  square-off are why.

### 1.7 Weekly and monthly: flatten daily, or hold to stop or expiry?

| | Flatten every night (09:30-01:30, flat after) | Hold 24x7 to stop or expiry |
|---|---|---|
| What it earns | Nothing, in the sim: −$0.3 to −$4 a day per 10 contracts, weekly or monthly, in both worlds. | The night's and the weekend's theta. +$42-56 a week per 10 contracts in the VRP world. |
| Main risk | Pays a round trip every night and re-enters at a new ATM every morning (first-tick entry). On the monthly, costs exceed a day's theta every single day. | Nights and weekends unattended. Stops are in-process tick checks, and whether Delta accepts resting stop orders on options is UNCONFIRMED (the API has `stop_order_type` and `stop_trigger_method: mark_price/spot_price`; test on testnet). A dead supervisor at 03:00 leaves up to 4 short straddles with no stop. |
| Tail (P1, capped, per 10 contracts) | −$21 to −$64 a day | −$257 to −$440 a week |
| Pyramid | Resets every morning | Accumulates across the week unless reset by cycle and capped |
| NSE evidence | BULL_S_1's record is intraday (squared off 15:20) on a long-dated contract. That is the closest match, but on NSE the reason to flatten was the overnight gap, which BTC does not have in that form. | None. No NSE BULL book has carried by design (the legacy R1 carry was a defect). |

**Recommendation.**
- **Weekly: hold**, capped, with the book-life loss cap, no weekend entries, flat by 16:30 on
  expiry Friday, paper only. Do not go live until a 24x7 watchdog exists that alarms on a stale
  decision loop, and either resting stops work on options or the book buys a far wing per
  straddle.
- **Monthly: off.** Its intraday form cannot pay its spread. Its held form has the weakest
  mean-to-tail ratio (P1 9-12× the mean). Its $55-wide ATM book makes every stop expensive.

### 1.8 The weekend and overnight risk for an uncapped pyramid

BTC does not gap at the weekend the way NIFTY gaps at 09:15: it never closes. The danger has
another shape:

1. Thin weekend or night liquidity produces hours of chop.
2. Every crossing in the chop is an accepted entry.
3. Uncapped, every entry is bigger than the last.
4. Then a liquidation cascade (5-15% inside an hour, common on Friday nights and weekends) hits
   the largest, most recent straddles. Spreads widen and IV jumps with it.
5. The stops do not save it. A 1.25× stop sits four to six strikes away, so it fires after the
   damage, into a widened book.

The legacy code reset its size every morning only because pm2 restarted the process. A 24x7 book
has no such reset.

Two deterministic stress paths, USD per 10-contract start:
- **Weekly weekend.** 30 hours of ±1.5% chop, then −10% in 60 minutes; IV 40% → 70%; spreads 5×.
- **Daily overnight.** 20 hours of ±1.2% chop, then −8% in 45 minutes; IV 42% → 72%.

| Path | Jump | Uncapped | Cap 3×, max open 4 | Flat 1×, max open 4 |
|---|---|---|---|---|
| Weekly weekend | 1 | 19 straddles, peak 99× start open (≈ 1 BTC), **−$1,359** | −$350 | −$126 |
| | 2 | 9 straddles, peak 24×, −$338 | −$207 | −$79 |
| Daily overnight | 1 | 57 straddles, peak 168× (≈ 1.7 BTC), **−$4,546** | −$378 | −$130 |
| | 2 | 28 straddles, peak 55×, −$1,117 | −$242 | −$86 |

**An uncapped preset should not exist on BTC.** At jump 1, the cap and the max-open dial take
75-90% off the cascade loss. A flat size (step 0) takes another two thirds. If the operator wants to keep
the pyramid, keep it capped at 3×. Halting new entries over the weekend (§1.6) attacks the chop
half of the scenario directly.

### 1.9 What BULL-S needs to become a BTC desk-engine book

The hosted class (`premium-leg-book/strategy.ts`) is the logic to copy, not the host to reuse.
What changes:

- **Quantity and money.** The class sizes in integer lots of a positive lot size, and P&L is
  `qty × price`. On BTC a lot is one contract of 0.001 BTC, and P&L, stops and the loss cap are
  in USD. See §3: `Math.trunc(lotSize)` in SPAN-lite and the integer-qty validators.
- **ATM and the grid.** `ctx.md.atmStrike` rounds on the per-symbol step in
  `packages/strategy-config` (`STRIKE_STEP`, and the `Underlying` union admits only NIFTY,
  BANKNIFTY and SENSEX). Replace it with the per-expiry dollar grid and a listed-strike check
  (§1.2).
- **Trigger and stop prices.** Today it uses `lastPrice` from the future token (`reference:
  'current-future'`) and LTPs. Use the index for the trigger and the ask side for the stop
  (§1.3).
- **Clock.**
  - `squareOffIstMinute` with `cronAtIstMinute`, and the 09:15 day start, become the cycle
    clock and window of §4.
  - The day roll becomes the 17:30 IST cycle roll.
  - `onDayStart` resetting size and the group list is wrong for a hold book. It must keep
    carried straddles and reset only the size.
- **Behaviours to keep:**
  - P1, the first-tick entry, as an explicit dial;
  - P5, one straddle per level;
  - P6, per-straddle size;
  - the per-leg status and recovery rules the port already has (C3, `onRecover`).
- **Behaviours to drop:** P7's integer truncation of the trigger. It is harmless on USD prices,
  but there is no fixture to keep it for.
- **New gates the record asks for:**
  - entry closes before the flatten starts;
  - refuse when the grid level has no listed strike, or a leg has no two-sided quote;
  - the loss cap is checked ahead of entries;
  - nothing opens on a stale index (spot older than 10 s), while exits stay allowed.
- **Margin.** Delta's portfolio margin is SPAN-like (29 scenarios, short floor Σ max(5% premium,
  0.5-2% notional), maintenance at 75% of initial). Its liquidation path hedges with the perp
  and then scales the book down. Cap margin use at about 30% of the book's collateral, so a
  cascade's margin jump cannot trigger Delta's liquidation before the book's own stops.

### 1.10 What paper must measure, per book

1. IV sold at entry against realised vol over the hold (the edge exists only if IV is higher).
2. Fill price against the touch and against Delta's mark, by hour of day.
3. Straddles, stops and peak open size per cycle, against the sim table in §1.5.
4. Fees as a share of gross, from Delta's own `commission` on each fill.
5. How often the ATM was missing from the ladder, and how often the loss cap fired.
6. For the weekly hold, P&L split into attended hours, night, and weekend.

---

## 2. Delta India BTC options: the facts used

Sources: guides.delta.exchange (Delta India user guide; options, fair-price marking,
portfolio-margin and fee pages), www.delta.exchange/fees, docs.delta.exchange (changelog to
16 Oct 2026), and the public tickers endpoint `api.india.delta.exchange/v2/tickers`, read once
on 3 Nov 2026 07:15 UTC. Details and URLs are in `scratchpad/delta-market-structure.md` and
`scratchpad/delta-api-reference.md`.

| Fact | Value | Status |
|---|---|---|
| Contract | 0.001 BTC; price quoted in USD per 1 BTC | Confirmed (API `contract_value`) |
| Minimum order | 1 contract | UNCONFIRMED |
| Currency | Quoted, margined and settled in USD; the wallet is held in INR at a fixed 1 USD = 85 INR | Guide |
| Style and settlement | Cash-settled against the 30-minute TWAP of `.DEXBTUSD`, ending **17:30 IST (12:00 UTC)** for every BTC option. From one hour before, the mark migrates from the index to the TWAP. Worthless options pay no settlement fee; open ones pay the taker rate. | Guide. European style UNCONFIRMED but implied. |
| Expiries live | 3 dailies (3, 4, 5 Nov); Fridays 6, 13, 20 Nov; monthlies 27 Nov, 25 Dec, 29 Jan. No quarterly. New dailies list at 17:30 followed by a 5-minute auction. Weekends trade 24x7. | API, guide |
| Strikes | Dailies $200 near ATM / $400 outside, 25-28 strikes. Weeklies $500 / $1,000, 21-33. Monthlies $1,000, 32-43. The guide's own table is out of date. | API |
| Tick | $0.10 | API |
| Fees | 0.01% of notional, maker and taker; capped at 3.5% of premium; 18% GST on top. Liquidation fee min(50% premium, 0.25% notional). | Fees page; the 3.5% cap read from the current page |
| Liquidity, near ATM | Daily 3 Nov ATM $212/$215 (1.4% of mid), OI 28.7k/62.6k contracts. Daily 4 Nov $808/$813, OI ~2.7k. Weekly 6 Nov $1,199/$1,206, OI 5.0k/2.8k. Monthly 27 Nov $2,659/$2,715 ($55, 2%), OI 10.6k/12.6k. Top-of-book size 4-15k contracts. All BTC options: about $614M OI and $2.78B 24h turnover, $342M OI in the expiring daily alone. | API snapshot |
| IV | ATM daily 3 Nov ~29.5% with 4.75h left; daily 4 Nov ~46% (event premium, likely the 3 Nov US midterm election night, inferred); weekly ~40%; monthly ~35%. Deribit DVOL 39.4 (30-day range 35.7-44.3). India VIX 15.9. BTC runs at about 2.5× NIFTY's vol, and a 1-sd BTC day is about $1,200-1,800. | API, TradingView |
| Vol index | None on Delta found | UNCONFIRMED |
| Margin | Isolated, cross or portfolio. Portfolio is SPAN-like, as described in §1.9. | Guide |
| Position limits | Not published | UNCONFIRMED |
| Orders and limits | Limit, market (price-impact checked), stop, trailing, take-profit, bracket; GTC/IOC; post-only; reduce-only; MMP; batches of 50. 20,000 rate units per 5 min; 500 ops/s per product. Stops and brackets on options UNCONFIRMED. | Docs |
| Hosts | Testnet REST `cdn-ind.testnet.deltaex.org`; production WebSocket `public-socket.india.delta.exchange`. The old channel names were retired 31 Oct; the new ones are `ticker`, `ob_l1`, `ob_l2`, `trades`, `spot_price`. | Docs, delta-docs agent |

---

## 3. What in our code is tied to NSE

The engines decide off the option chain: the ATM straddle, solved deltas, real strikes. The
trading logic itself mostly ports. The coupling is in the clock, the calendar, the currency,
the quantity model and the venue plumbing. Every row below has to change before a BTC book can
run, paper included.

| Tie | Where | NSE today | BTC on Delta India |
|---|---|---|---|
| Session open / close | `packages/desk-engine/src/session.ts` `SESSION_OPEN_MIN` 555, `RULES_START_MIN` 560, `DECISIONS_END_MIN` 930, `DECISION_CLOCK_CLOSE_MIN` 930; `packages/core` `MARKET_OPEN_MIN`/`MARKET_CLOSE_MIN`/`FNO_CLOSE_MIN` | 09:15-15:30 (F&O to 15:40) | No session. One cycle per daily settlement, 17:30 IST to 17:30 IST (§4). |
| Trading calendar | `session.ts` `isTradingDay` and `MARKET_HOLIDAYS_2026` (fails open in 2027); the step-5 gate in `delta-lean/decide.ts` ("not an NSE trading day"), and `playbook/decide.ts`; `playbook/calendar.ts` `tradingDaysToExpiry` | Weekdays minus NSE holidays | Every day trades. As written, a BTC book would refuse to act on every Saturday, Sunday and NSE holiday while still carrying legs. Needs a per-venue calendar. |
| Time to expiry | `apps/supervisor/src/engine-host.ts` `tradingMinutesToExpiry` (09:15-15:30 sessions, holidays removed; the host already accepts an injected `minutesToExpiry`); `marking.ts` `yearFrac` (calendar days/365, refined to minutes left to 15:30 only on expiry day) | Trading minutes | Calendar minutes to 12:00 UTC on the expiry date, every day. One formula, no expiry-day special case. |
| Session length | `playbook/session.ts` `SESSION_MINUTES` = 375; `Dday = STR × √(min(375, MTE)/MTE)` | 375 min | The cycle (1,440 min), or the playbook's own window. |
| Open, gap, previous close | `playbook/decide.ts` `gapPct`, `dayComplete` (first print by 09:16), `dayRobust`; `DeltaLeanInputs.prevClose`; the gap gates; Reversal's morning excursion | 09:15 open against the previous close | No open and no gap. Use "the move since the cycle start" or since the window start, and drop the gap gates. |
| Clock dials | `dl_warmup_min`, `dl_open_by_min`, `dl_flatten_*_min`, `dl_flat_by_min`, `pb_entry_*_min`, `pb_late_min`, `pb_time_exit_min`; the hosted configs' `startAt`, `squareOffAt`, `formAtIstMinute`, `entryDeadlineIstMinute` and `squareOffIstMinute`; crons on days `1-5` | 09:30-15:00, never crosses midnight | BTC windows cross IST midnight. Put the BTC desk on a clock where the settlement is midnight (UTC+12, §4), and every existing minute comparison keeps working. |
| Day roll | `delta-lean/lean.ts` `rollDay` (IST date); the 08:50 IST roll; the 08:45 day-guard re-arm | IST date | The cycle date. Roll at about 17:45 IST, after the new daily lists and its auction ends. |
| Money | `dl_day_target`, `dl_day_max_loss`, `dl_stuck_loss`, `pb_trade_*`, the trails, `pb_premium_budget`, `margin_cap`; desk-api `guardStopFor` (1.5×); `inr()` in reasons; reports | Rupees | USD. Needs a currency on the book, and the venue's ₹85 rule for INR reporting. |
| Quantity | Integer `qty` required by `apps/api/src/validate.ts:131,204` and `routes/engine.ts:345`; `margin-project.ts:225` `Math.trunc(leg.lotSize)`; P&L = `qty × price` | Lot 65 / 20 / 30, integer | `Math.trunc(0.001)` is 0, so SPAN-lite would see no shorts and size without limit. Carry quantity in contracts (lot size 1) with a 0.001 multiplier on P&L, greeks and margin. |
| Strike step | `packages/strategy-config` `STRIKE_STEP` and the `Underlying` union, both enforced at config load; `dl_min_strike_gap`, `pb_wing_min_steps` and `pb_otm_steps` count steps | Uniform 50 / 100 | Uneven by expiry and by distance from ATM (§1.2). The engines walk listed strikes, so selection is fine, but every "steps" dial needs a dollar form. |
| Tick | `0.05` defaults in `apps/api/src/marketable.ts`, `safety.ts`, `repair-plan.ts`, `repair-apply.ts`, `settle-expired.ts`; `apps/order-gateway/src/order-chaser.ts` | ₹0.05 | $0.10, from the product master. |
| Spread bars | `dl_max_spread_abs` ₹1, `pb_wing_spread_abs` ₹2, `dl_max_spread_pct` 2% | Rupees | Percent of mid plus a USD floor. A $1 floor would reject nothing; a $3 ATM daily spread is normal. |
| Freeze and order limits | `packages/instruments/src/freeze.ts`, the gateway's freeze split; `dl_max_orders_s/_min/_day` (SEBI's 10/s) | NIFTY 1,800 units | Delta's rate units and max order size. |
| Rate and margin model | `marking.ts` `RISK_FREE` 0.065; `SPAN_LITE` (±21% price scan, 25% vol scan, 5% floor, 5% exposure, 35% default IV) | NSE SPAN shape | Rate ≈ 0; the parity forward (`dl_parity_forward`, on) absorbs carry. A 35% default IV is low for BTC, and Delta's own margin applies. |
| India VIX | Not read by any engine; the regime detector uses the book's own straddle | — | Nothing to port. DVOL could be an optional gate. |
| Expiry selection | `scripts/delta-lean-roll.mjs` `expiriesFrom`; NIFTY Tuesday, SENSEX Thursday | Weekly | Daily, weekly and monthly, all at 17:30 IST. |
| Settlement | `settle-expired` at intrinsic against the close; decisions end 15:30 | Last-30-min VWAP | The 30-minute TWAP of `.DEXBTUSD`. |
| Venue plumbing | `packages/brokers` (simulator, XTS, Zerodha data), the instrument master and the 08:45 `make sync`, desk-marketdata, `md.tick` keyed by numeric Kite tokens | Zerodha / XTS | Nothing exists for Delta. `scratchpad/delta-seams.md` maps the seams. This is the largest piece of work. |
| Operations | Deploys and pm2 restarts assume an idle desk after 15:30; mongod's unattended upgrade restarted it mid-session on 27 Oct; the supervisor's SIGTERM is inert | Flat or idle every night | A 24x7 book is never idle. A restart at 03:00 IST is a restart with legs on. |

Two things port without change. The regime detector's arithmetic, `implied(W) = straddle ×
√(W / minutes to expiry)`, is cleaner on calendar time than on trading minutes. The
defined-risk package shapes port too: the debit spread, condor and iron fly, with their
buy-before-sell order and margin projection.

---

## 4. A "day" and "intraday" on a 24x7 market

**The cycle is the day.** Delta settles every BTC option at 17:30 IST, and lists the next daily
then. A BTC desk day therefore runs from 17:30 IST to the next 17:30 IST, and is named by the
date of the settlement that ends it. These all key on the cycle:
- the day roll;
- the day loss caps;
- the desk day guard;
- the reports;
- the "one trade a day" counters.

**Put the desk on UTC+12 for BTC.** 12:00 UTC is midnight in UTC+12, so the cycle runs
00:00-24:00 on that clock. Every existing minute-of-day dial and comparison then works with no
midnight crossing.

| IST | Cycle minute | What happens |
|---|---|---|
| 17:30 | 0 | Settlement; the new daily lists; 5-minute auction |
| 17:45 | 15 | The roll |
| 19:00 | 90 | US data at 8:30 ET (winter; 18:00 IST in summer) |
| 20:00 | 150 | US cash open (winter) |
| 01:30 | 480 | US close (winter, 02:30); start of the thin hours |
| 09:30 | 960 | Attended desk hours begin |
| 16:30 | 1,380 | The mark starts blending toward the settlement TWAP |
| 17:00 | 1,410 | The TWAP window opens |

**Intraday on BTC** means a book that opens and is flat inside one window of one cycle, and
never holds an option into its own settlement. Two windows are natural:

- **The pre-settlement window, 09:30-16:30 IST.** This is the daily's last seven hours: Asia
  afternoon and the Europe morning, with no scheduled US data in it. It is the BTC analogue of
  NSE's 0-DTE afternoon. The BULL-S daily book and I2 use it.
- **The US window, 19:00-00:30 IST.** It holds the data releases and the cash open, where trend
  days start. I1 uses it.
- **01:30-09:30 IST is no-new-risk time** for intraday books. Weekends trade, but intraday books
  start weekdays-only in v1. Weekend dailies get their own record later.

**Positional** means carried across at least one 17:30 settlement:
- **Weekly:** Friday 17:30 IST. **Monthly:** the last Friday.
- Exits (stops, the book loss cap) run 24x7.
- Opens and adjustments run only in attended hours (09:30-00:30 IST, Mon-Fri). That replaces
  NSE's 14:50-to-close overnight freeze.
- The expiry ladder runs on the expiry Friday: 16:00 / 16:15 / 16:30 IST.
- A daily settlement touches no weekly leg, but it does roll the per-cycle counters.

---

## 5. The other strategy families

Verdicts: **Port** (the logic carries; only the §3 layers change), **Port later**, **Do not
port**.

### 5.1 Delta-lean v2, intraday (aggressive, conservative, zero, zero-0dte)

`packages/desk-engine/src/delta-lean/decide.ts`; the `DELTA_LEAN_*` presets in `presets.ts`.

- **Record.**
  - NIFTY conservative is the only index record that survived costs: +₹24.9k over 16 days, PF
    4.2, +₹17.3k after charges and 25 bps.
  - The money was in trend debit spreads opened early: put spreads +₹1.12L (67% won); opens at
    09:30-09:45 +₹1.26L.
  - The quiet-condor open lost −₹56.5k over 5. The same-side neutralising sales lost −₹1.43L.
  - On 30 Oct, conservative became open-and-hold (`dl_max_adjusts_day` 0). SENSEX conservative
    and SENSEX zero are on `SERIES_OFF`.
- **BTC.** The regime detector needs only calendar minutes. The delta bands are unit-free. The
  regime multipliers came from NIFTY and must be re-measured on recorded BTC ticks: a jumpier
  path may confirm fewer "clean" trends.
- **Verdict.**
  - **Port** the conservative held book, trend opens only (I1).
  - **Do not port** aggressive: its naked 0.45-0.60Δ sales are the record's worst package.
  - **Do not port** zero's 09:31 timing, since BTC has no opening minute. Keep its condor for P2.

### 5.2 Delta-lean hold-to-expiry

- **Record.** Too early on NSE (+₹18.2k realised by 16 Oct). The 09:15 blended-mark false exits
  were fixed by `dl_rupee_hold_s` 60.
- **BTC.**
  - Weekly, created after the Friday settlement.
  - The overnight freeze becomes no opens or adjustments outside attended hours.
  - The expiry ladder moves to Friday 16:00-16:30.
  - Keep the 60 s hold: thin hours have quote holes.
- **Verdict: Port**, conservative held (P1).

### 5.3 The six playbooks

| Playbook | NSE state | BTC verdict |
|---|---|---|
| Trend Drive | `SERIES_OFF` on both symbols | Port later. Without its gap gate it is close to I1. |
| Wing Straddle | `SERIES_OFF` on both symbols | Port later. It is BULL-S's idea with wings at 1 unit, and the natural follow-on if BULL-S paper shows an edge. |
| Reversal Spread | NIFTY on, SENSEX off | Port later. It needs a cycle or window "open" to measure an excursion from. |
| Expiry Drive | Off | Do not port. A 0-DTE "morning" on BTC is the evening before. |
| Expiry Theta Fly | Off | **Port (I2).** BTC has an expiry every day, so the record fills in weeks, not years. |
| Expiry Gamma Breakout | Off; no evidence | Do not port. A bought late daily pays about 8% of premium in fees at the cap, round trip. |

### 5.4 Recenter (the monthly stock books)

- **Record.** KALYANKJIL +₹1.08L, TATASTEEL +₹53k, TCS September −₹1.19L.
- **Why not on BTC.** A BTC month is a ~10-12% one-sigma move, and the engine sheds delta by
  selling more options: naked short gamma against fat tails. Its 5-minute mark grid and 09:20
  start are NSE-bound too.
- **Verdict: Do not port in v1.**

### 5.5 The hosted strategies (`apps/runner/src/catalogue.ts`)

| Strategy | NSE | BTC |
|---|---|---|
| BULL_S_1 / BULL_SNX_1 | §1 | §1 |
| ORB_FUT_* | Positive on SENSEX at 25 bps; exits defective | A futures strategy (the perp on Delta), so outside an options brief. Its 09:15-09:45 range has no BTC analogue; a fixed pre-US-open range would be a new design. |
| ORB_SCALP_*, BN_BREAKOUT, ATR_BAND_NIFTY | About zero or losing; three switched off on 30 Oct | Do not port |
| LION_S25_2 | About flat at 25 bps | Do not port. Naked, with re-entry at every crossing, and fee-heavy. |
| EAGLE_S_1 | +₹1.26L, 76% of it on one day; no stop | **Never port.** Its only exit is a square-off BTC does not have. |
| CHEETAH_B1_* | Never traded | Never port (martingale) |
| MIRROR_* | Source down | Not applicable |

---

## 6. A secondary starter set (after BULL-S)

All four are defined-risk, paper only, and indicative at spot $76,592. Every strike is chosen
by delta on the live chain, so the dollar figures move with spot and IV.

| Book | Engine and contract | Window, IST | Structure | Size | USD lines | Why |
|---|---|---|---|---|---|---|
| **I1 BTC trend spread** | Delta-lean conservative, opened and held; trend opens only (`dl_open_quiet` false); the daily expiring at the end of the cycle (~20-22h left) | Warm-up 18:00, opens 19:15-21:30, flatten 00:00 / 00:10 / 00:20 | Buy 0.55-0.65Δ, sell 0.20-0.30Δ, same type. At snapshot vol: buy 76,000, sell 77,500-78,000; debit ≈ $900/BTC, width $1,500-2,000. | 100 contracts per leg | Debit ≈ $90 at most; target $50; backstop $60 | The NSE record's only cost-surviving index edge. Few fills; fees ≈ 4-6% of the debit round trip. |
| **I2 BTC settlement fly** | Expiry Theta Fly; the daily, 0-DTE | Opens 13:00-15:00, after a calm 30 min (range ≤ 1.5 × imp(30)); flat by 16:30 | ATM iron fly with wings at ± max(2 strikes, 1.25 × straddle): at 4.75h left, ±$600 on a $424 straddle; credit ≈ $345, max loss ≈ $255 per BTC | 100 contracts | Credit ≈ $35; take profit 50% of credit; hard stop $20; trend exit after 60 s | One expiry a day gives fast evidence. No US data in the window. Wings bound the cascade. |
| **P1 BTC weekly hold** | Delta-lean hold-to-expiry, conservative held; the Friday weekly | Opens 19:15-23:00 on any weekday after creation; no adjustments; ladder Friday 16:00-16:30 | Trend: debit spread 0.60/0.25Δ (≈ buy 76,000, sell 80,000; debit ≈ $1,460, width $4,000). Quiet: condor 0.30Δ / 0.10Δ wings. | 50 contracts | Book target $60; book backstop $70; money hold 60 s | The NSE hold pair, carried over directly |
| **P2 BTC weekly condor** | Delta-lean-zero dials plus `dl_hold_to_expiry`; the Friday weekly | Opens Monday 19:15-22:00 (fallback condor at 22:00); exit Thursday 17:00 IST | Shorts ≤ 0.15Δ (≈ ±6%), wings ≤ 0.04Δ (≈ ±10%); credit ≈ $500, max loss ≈ $3,000-3,500 per BTC | 50 contracts | Target 50% of credit (≈ $13); backstop $25; close on a touch of a short strike | The desk's own monthly way (shorts ~0.6 SD, closed before expiry: 80% won against 46% held) at a weekly horizon. Needs one new dial: exit N cycles before expiry. |

---

## 7. What is dangerous on BTC

1. **No flat-by-close, so nothing backstops a dead process.** The NSE desk is flat or idle
   after 15:30, and its safety story leans on that:
   - the supervisor's SIGTERM is inert;
   - stops are local tick checks;
   - restarts happen after hours;
   - mongod was restarted mid-session by an unattended upgrade on 27 Oct.

   On BTC there is no after hours. Before any carried book: 24x7 alerting on a stale decision
   loop, and either resting stops at Delta or wings on every short.
2. **Jumps, not gaps.** Liquidation cascades move BTC 5-15% inside an hour, often on Friday
   nights, weekends or thin Asian hours, as spreads widen. A rupee-style stop fills far past its
   line. For BULL-S this is §1.8. Defined risk is the only protection that does not depend on
   getting a fill.
3. **Daily-expiry gamma.** With two hours left, the stop sits about 1.3 strikes away. Be flat by
   16:30, before the mark blends into the settlement TWAP, and never carry a short daily into
   settlement in v1.
4. **The daily ladder is narrow.** The 3 Nov daily lists only to 1.8% below spot. A move off the
   ladder leaves no ATM to sell and no wing to buy. Refuse; never take the nearest strike.
5. **Costs on short-dated and cheap options.** The fee cap (3.5% of premium plus GST) and $3-5
   spreads make a late daily straddle round trip about 10% of its premium. That is 39% of a 25%
   stop. The desk review's lesson 8 (gross edge well above costs, few orders) binds harder here.
6. **Currency and tax.** P&L is USD inside an INR wallet at ₹85. Indian tax treatment of crypto
   derivatives is not settled in this note. Report USD and INR both.
7. **Regime-detector calibration.** Its thresholds came from NIFTY, and a jump-priced straddle
   makes "trend" rarer. Replay recorded BTC ticks before trusting either label.
8. **Paper fills overstate.** On NSE, the 205 live fills came in 53-165 bps worse than the desk
   had booked them. Delta depth is 4-15k contracts at the touch, which is fine at these sizes.
   Measure from day one.
9. **Venue risk.** One exchange, one settlement index, announced maintenance windows (cancel-only,
   then frozen, then an auction). A feed gap must read like the NSE stale-spot rule: no opens,
   exits allowed.
