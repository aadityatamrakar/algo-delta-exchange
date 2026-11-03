# Strategy Specs — Consolidated Operator Reference

**Status:** derived document. Compiled 2026-07-28 from the eleven specs in this directory
(`00-taxonomy.md` + ten family specs), `context/04-strategy-catalog.md`,
`context/09-active-strategy-scope.md`, and the live registry code
(`apps/runner/src/catalogue.ts`, `apps/runner/src/mirrors.ts`, `apps/api/src/registry-seed.ts`,
`packages/strategies/src/`). Where a spec and the code disagree, both are stated in §5 —
nothing is silently resolved.

**What this answers:** *what do we actually run, and what does each strategy do?*

---

## 0. How "status" is determined (read this first)

The legacy `server/` estate (~380 files, 290 in scope) is **archived** — the new system hosts
only what is in the runner's catalogue. Evidence chain:

1. `apps/runner/src/catalogue.ts` — 14 hosted strategy tags, built from exactly **4 implemented
   strategy classes** in `packages/strategies/src/`: `range-breakout-directional`,
   `momentum-flip-directional`, `premium-leg-book`, `premium-distance-accumulator`.
2. `apps/runner/src/mirrors.ts` — 4 mirror tags (`MIRROR_1PBUY`, `MIRROR_A006`,
   `MIRROR_A010`, `MIRROR_EMA2050`) hosted by `MirrorHost`, deliberately outside the catalogue
   (a `SignalSource` adapter, not a `StrategyBase`).
3. `apps/api/src/registry-seed.ts` — seeds all 18 rows into `desk-strategies`,
   **added to paper and switched OFF**, `liveLots: 0`. Turning anything on (paper or live) is
   an operator act in the portal, stored in Mongo.

Consequently the status vocabulary used below:

| status | meaning |
|---|---|
| **hosted** | Implemented in TypeScript and registered in the runner. Seeded to paper, off by default. Whether it is switched on *right now* (paper or live) is operator state in Mongo and **cannot be verified from the repo** — treat the on/off switch state as unverified. |
| **class ported, config not** | The strategy class exists in `packages/strategies` but this legacy config was never added to the catalogue. It cannot run. |
| **documented only** | Fully specified in this directory; no TypeScript implementation exists. Cannot run. |
| **retired** | Explicitly retired by `00-taxonomy.md` §8 (dead underlying, unstartable, or superseded). Do not port. |

Scope note: `00-taxonomy.md` classifies the **whole 290-file estate** into 12 classes + 1
adapter. `09-active-strategy-scope.md` records the owner's decision to port **only the 16
active legacy modules**, and the implemented system follows that decision — which is why only
4 of the 12 classes exist in code today.

---

## 1. The scannable table

### 1.1 The 17 hosted tags (everything that can actually run)

| registry tag | class | legacy module | underlying | instrument | approach | autostart |
|---|---|---|---|---|---|---|
| `BN_BREAKOUT` | RangeBreakoutDirectional | `bn-breakout` | BANKNIFTY | options (buy) | first-candle ±0.09% band break → buy ATM option | 09:16 |
| `ATR_BAND_NIFTY` | RangeBreakoutDirectional | `atr-band-nifty` | NIFTY | options (buy) | ATR-14/3 band anchored 11:40, 2-candle confirm → buy ATM option | 09:18 |
| `ORB_FUT_BN` / `ORB_FUT_NIFTY` / `ORB_FUT_SNX` | RangeBreakoutDirectional | `orb-fut-*` | BN / NIFTY / SENSEX | futures | 09:15–09:45 opening-range break → trade the future itself | 09:18 |
| `ORB_SCALP_BN` / `ORB_SCALP_NIFTY` / `ORB_SCALP_SNX` | RangeBreakoutDirectional | `orb-scalp` (one legacy process, 3 configs) | BN / NIFTY / SENSEX | options (buy) | opening-range break → buy ATM option | 09:18 |
| `CHEETAH_B1_1` | MomentumFlipDirectional | `cheetah-b1-1` | BANKNIFTY (monthly future ref) | options (buy) | momentum-follow ATM buy, flip on stop, martingale cap 12 | 09:17 |
| `CHEETAH_B1_SNX` | MomentumFlipDirectional | `cheetah-b1-snx` | SENSEX | options (buy) | same | 09:17 |
| `LION_S25_2` | PremiumLegBook | `lion-s25-2` | BANKNIFTY (monthly future ref) | options (sell) | sell ATM straddle on every strike crossing, 1.25× per-leg stop | at boot |
| `BULL_S_1` | PremiumLegBook | `bull-s-1` | BANKNIFTY (monthly future ref) | options (sell) | crossover straddle, combined 1.25× stop, pyramid-up sizing | at boot |
| `BULL_SNX_1` | PremiumLegBook | `bull-snx-1` | SENSEX | options (sell) | same, spot reference | at boot |
| `EAGLE_S_1` | PremiumDistanceAccumulator | `eagle-s-1` | BANKNIFTY (monthly future ref) | options (sell) | premium-spaced short accumulator, **no exit logic at all** | at boot |
| `MIRROR_1PBUY` / `MIRROR_A006` / `MIRROR_A010` / `MIRROR_EMA2050` | ExternalSignalMirror (adapter) | `candlestrategy*` | whatever upstream trades | any | replay optionbhai.com executed orders onto the order bus | at boot (deliberately not the legacy 09:14) |

All 17 are seeded **off**. The three that placed (or were intended to place) real broker
orders in the legacy system — `LION_S25_2`, `CHEETAH_B1_1`, `CHEETAH_B1_SNX` — get no special
treatment: live requires an explicit operator switch plus a non-zero `liveLots`.

### 1.2 The full taxonomy (12 classes + adapter) and where each stands

| # | class (taxonomy) | legacy families | underlyings | instrument | broad approach | current status |
|---|---|---|---|---|---|---|
| 1 | `PremiumLegBook` (128 files) | lion, biglion, samlion, jk, bull (idea B/D), stgl, dolphin, nifty-s, target-15, p718-4/5, cal-*, vwap, p718-7, smp lion/bull/stgl kin | BN, NIFTY, FINNIFTY, MIDCPNIFTY, SENSEX | options (mostly sell) | independent short legs opened by a level/clock signal, per-leg or combined premium stop, re-entry by policy | **class ported; only 3 configs hosted** (`LION_S25_2`, `BULL_S_1`, `BULL_SNX_1`). The other ~125 configs: documented only |
| 2 | `RollingLegStrangle` (15) | rv-2/25n/40/40e*/40n/40sl/s2/1, smp rv-3/4, tiger-s-5 | BN, NIFTY | options (sell) | one CE + one PE anchor, never flat; roll OTM on adverse premium move, roll in on favourable, refundable budget | documented only |
| 3 | `RungLadderSeller` (16) | bull-300\*, bulln-300\*, bull-m/m2, bull-x, smp bull-10, falcon-s | BN, NIFTY | options (sell) | N short rungs around a moving centre; boundary touch → atomic recentre/translate; no premium exit | documented only |
| 4 | `PremiumDistanceAccumulator` (20) | eagle-* | BN, NIFTY, FINNIFTY, MIDCPNIFTY, SENSEX | options (sell) | premium-spaced trigger grid; every fire adds a short leg and pushes two new triggers; **never exits** | **class ported; 1 config hosted** (`EAGLE_S_1`). Rest documented only |
| 5 | `MomentumFlipDirectional` (35) | cheetah-*, fox-1, smp spt-*/strad-ts-* | BN, SENSEX | options (buy or sell) | direction from vs-day-open once; flip to the other side on stop; idle after target | **class ported; 2 configs hosted** (`CHEETAH_B1_1`, `CHEETAH_B1_SNX`). Rest documented only |
| 6 | `BracketReverseChain` (14) | cp-*, fut-100 | BN, NIFTY, SENSEX | options / one future | base-price breakout → broker OCO off the actual fill → each fill reverses the position | documented only |
| 7 | `RangeBreakoutDirectional` (13) | modern (bn-breakout, atr-band-nifty, orb-scalp, orb-fut-*), snx-orb-* | BN, NIFTY, SENSEX | options (buy) / futures | morning reference band; completed-candle close beyond an edge → directional trade; target/stop/time-stop/EOD | **class ported; 8 configs hosted.** `snx-orb-1/25/50` (own-premium mapping): class exists, config not ported |
| 8 | `StraddleScalper` (19) | hft-*, bn-hft, smp timer-*/hft-avg/multi-straddle, hft-snx-sell | BN, NIFTY, SENSEX | options (buy) | **the only long-premium family**: buy the synthetic-ATM straddle, exit on combined-premium target / timer / reversal, optional averaging pyramid | documented only |
| 9 | `SpreadLadderEngine` (13) | ce/pe-d2-*, ce/pe-d2p-*, smp ce/pe-d-*/pd-*, combo-trade | BANKNIFTY (+ dead stock pair) | options (multi-leg) | depth-priced N-leg spread; scale in/out as the executable price crosses a walking ladder level | documented only |
| 10 | `IndicatorFlipStructure` (4) | p718-1/2/3, smp jaguar | BANKNIFTY | options (sell / spread) | Supertrend(14,5) → target structure (strangle or credit spread); reconcile the book on every flip | documented only |
| 11 | `ChainScanBreakout` (3) | smp opt-buy, opt-buy-day, opt-sell | BANKNIFTY chain | options (buy or sell) | scan every contract's own intraday OHLC; per-contract entries with concurrency caps | documented only |
| 12 | `CalendarPair` | — tombstone — | — | — | folded into #1 (`cal-*` are PremiumLegBook configs with per-leg `expiry`) | n/a (deliberately not a class) |
| A1 | `ExternalSignalMirror` (3) | candlestrategy* | n/a | any | mirrors optionbhai's executed orders onto the order bus; no logic of its own | **hosted** (all 3, via `MirrorHost`) |
| — | retired | `stgl-120`, `reliance-orb`, `hdfc_spread`, `lib/otmSelector.js`, dirs `tob/ monks/ archive/ asmp/ wealth/ insta/ scripts/` | — | — | — | **retired** (taxonomy §8) |

---

## 2. Per-family reference

Ordered hosted-first. Each entry: entry logic → exit/stop → sizing → session → hazards.
Legacy behaviour is described as specified; where the TS port deliberately changed it
(e.g. mandatory square-off), that is noted.

### 2.1 RangeBreakoutDirectional — `modern` family (HOSTED, 8 tags)

The reference lineage: the only legacy code with a pure-logic/IO split and unit tests
(50 tests in `server/test/`), and the template the whole rewrite copied.

- **Entry.** Freeze a reference band on the underlying in the morning, from one of three
  sources: `bn-breakout` = ±0.09% around the 09:15–09:20 close (band at 09:21);
  `atr-band-nifty` = Wilder ATR-14 on 60-min candles ÷ 3, anchored on the 11:35–11:40 close
  (width 10:15, lines 11:40); `orb-scalp`/`orb-fut` = 6×5-min opening range 09:15–09:45,
  ±0.10% buffer. A 5-minute poller then requires the last *completed* candle to close beyond
  an edge — `bn-breakout` also requires colour match, `atr-band-nifty` requires **2
  consecutive same-colour** candles. Up-break → buy ATM CE (or BUY the future); down-break →
  buy ATM PE (or SELL the future).
- **Exit / stop.** Options: premium target (`+45` BN, `min(+20, +30%)` NIFTY ATR,
  `+40/+20/+25` orb-scalp), time stop (90/60 min), spot stop at the *opposite* band edge
  (tick-sampled, except atr-band which is candle-close-sampled), EOD flat 15:15. Futures:
  SL = opposite ORB end (absolute level), T1 = fill ± 1×range, no time stop, EOD 15:15.
  Exit precedence is declared and tested: options `EOD → TARGET → SL`, futures
  `EOD → SL → T1` — **deliberately opposite**.
- **Sizing.** Flat 1 lot everywhere.
- **Session.** Entry deadlines 13:31 (`bn-breakout`) / 14:15 (`atr-band`) / 14:00:30 (orb).
  Day budget: 1 trade per side (`bn-breakout`: a non-loss — breakeven included — ends the
  day) or 1 per day per index (orb). BANKNIFTY range filter 250 pts blocks the day
  (`orb-fut-bn`, `orb-scalp` BN).
- **Hazards.** Legacy "last completed candle" was often the still-forming candle (RISK-1);
  the R:R on gap-throughs degrades without bound (stop is an absolute level, target measured
  from fill); a mid-session restart used to orphan the position (the port's persisted
  session-state addresses this). `ATR_BAND_NIFTY`'s two port defects (band formation, stop
  read from the option instead of the underlying) are **fixed** and its golden test is green
  — the old `disabledReason` saying otherwise is retired (registry-seed).

**Near-duplicate note:** the three `orb-fut-*` and three `orb-scalp-*` rows are one machine
with per-underlying constants; `snx-orb-1/25/50` (documented only) is the same class with the
`own-premium-both-sides` execution mapping — it breaks the **option's own** 15-min range,
long and short independently, risk-sized to ₹20,000 per side, and is the only legacy member
that had a real EOD flatten (15:20) and risk-based sizing.

### 2.2 MomentumFlipDirectional — `cheetah-b1` (HOSTED, 2 tags)

- **Entry.** Once per session: if the reference (BN **monthly future** for `b1-1`, SENSEX
  spot for `b1-snx`) is above its day open, BUY the ATM CE; below → ATM PE. ATM is
  **frozen at the first tick** for all re-entries.
- **Exit / stop.** Fixed stop `entry − 10` premium points; target `entry + 90`. On stop:
  close, flip CE↔PE, re-enter at the frozen ATM. **On target: close and go idle for the rest
  of the day** — the asymmetry is deliberate.
- **Sizing.** Martingale: +1 lot per stop-out, capped at 12. (The uncapped sibling
  `cheetah-b1-2117` is documented only — do not confuse them.)
- **Session.** Legacy delay-start 09:17; legacy EOD was `process.exit()` at 15:23:40
  (abandoning, not closing, positions) — the runner now owns square-off.
- **Hazards.** Martingale into chop; the legacy family had no working portfolio breaker on
  these two configs; `b1-1`'s ATM is biased by the futures basis (intentional — it is the
  point of the config).

The other 12 cheetah files (fade/trail sellers, broker-SLM variants), `fox-1` and the smp
`spt-*`/`strad-ts-*` pair variants are the **same machine** on different axes (single leg vs
ATM pair, SELL-fade vs BUY-follow, trail vs fixed stop) — all documented only.

### 2.3 PremiumLegBook — `lion-s25-2`, `bull-s-1`, `bull-snx-1` (HOSTED, 3 tags)

The 128-file class; only these three configs are ported.

- **`LION_S25_2`** — entry: every touch/cross of the rounded 100-pt strike of the
  **BANKNIFTY monthly future** sells one ATM CE + one ATM PE (the "OTM offset" is 0
  everywhere — see §5.9). First entry is forced ~15 s after start. Exit: per-leg stop at
  1.25× entry premium, tick-monitored (legacy had **no** broker-resting stop for this
  config — the position was unprotected if the process died). Re-entry: **paired** — when
  either leg closes, the *pair* is re-sold at the next crossing, so the surviving side's
  count climbs and the book pyramids into the losing direction on a trend (lion §7.9).
  Sizing: 1 unit; real size is `account.strategy[tag]` at the broker layer.
- **`BULL_S_1` / `BULL_SNX_1`** — entry: every 100-pt crossover (BN monthly future / SENSEX
  spot) sells one ATM straddle, max one live straddle per strike level; the first tick is a
  synthetic up-cross (lastQuote starts at 0), so the first straddle fires on the first tick.
  Exit: **combined**-premium stop at 1.25× (parseInt-truncated); no target, no per-leg stop.
  Sizing: **pyramid-up** — size starts 1 and increments after every accepted entry,
  uncapped in legacy; each straddle exits at the size it was opened with.
- **Session.** Legacy: autostart at boot, no EOD exit of any kind (the family's biggest
  structural risk); the new runner owns `squareOffAt`.
- **Hazards.** Uncapped pyramid on a choppy day (bull R9); paired re-entry leak (lion 7.9);
  the whole family's "OTM strangle" naming is false — everything is ATM (§5.9).

**Near-duplicates inside the class (all documented only):** 8 lion Algorithm-1 files are
byte-identical but for the tag; `dolphin`/`nifty-s-*`/`target-15` are the same book with a
premium **target and no stop at all**; `stgl-mid` adds frozen-strike re-entry on a re-cross
of the entry-time spot; `stgl-p` chains 3 generations at premium targets 250→200→150;
`samlion` is a one-shot 10-pair wing ladder whose **exit code has never worked**
(`ce_option`/`pe_option` never stored — 20 naked legs, lion §7.7); `p718-4/5` are pure
clock-table sellers; `cal-*`/`calc-*` are one-shot short calendars with no exit; `bull-200-1`
picks strikes by premium and **replaces a stopped leg with the opposite type** (intent
unresolved — §5.6); smp `p718-7` (premium-decay limit entry, loser-leg-only stop) and `vwap`
(LTP vs own VWAP reversion, with a phantom-position bug) are the two PremiumLegBook ideas
that exist nowhere in slive.

### 2.4 PremiumDistanceAccumulator — `eagle-s-1` (HOSTED, 1 tag)

**The dangerous one. There is no exit logic anywhere in this class.**

- **Entry.** On the first ATM crossing of the BN **monthly future** (≈50% of sessions this
  fires immediately at startup because lastQuote starts at 0): sell the ATM straddle and
  arm two triggers at `spot − cePremium` (add CE) and `spot + pePremium` (add PE).
- **Management (there is no exit).** Every trigger the price crosses **in either direction**
  fires once: sell one more leg on the far side of spot (CE at-or-above via `ceil`, PE
  at-or-below via `floor`), and push **two** replacement triggers spaced by the *gating
  leg's* premium. Net +1 pending trigger per fill → leg count is super-linear in realised
  path length. A leg whose premium is ≤ ₹20 is refused and its branch dies — the family's
  only natural brake. Zero BUY orders exist in the code.
- **Exit.** Entirely delegated to central square-off (legacy: `squareoff_smp.js` at
  15:24:00; new runner: its own square-off). If that ever misses a day, the legs are
  orphaned.
- **Sizing.** 1 lot per leg, forever; real size per account map.
- **Hazards.** Unhedged short-gamma accumulation with no stop, no leg cap, no notional cap;
  the premium floor was calibrated for weeklies and is nearly inert on today's monthly BN
  chain (eagle RISK-7/8); a restart re-enters on top of the old book. The taxonomy
  deliberately refused to fold this into PremiumLegBook so the no-exit risk profile stays
  visible (taxonomy §2.3).

The other 11 eagle configs (spot-referenced, NIFTY/FIN/MIDCP/SENSEX, the pair-adding
`eagle-p-1`) are documented only. FINNIFTY/MIDCPNIFTY eagle paper P&L is meaningless
(simulator filled them at ₹0.05 — eagle RISK-6).

### 2.5 ExternalSignalMirror — `MIRROR_1PBUY` / `MIRROR_A006` / `MIRROR_A010` / `MIRROR_EMA2050` (HOSTED)

> `MIRROR_A010` (upstream account LIVE003) was added on 2026-08-24, after the cutover. It is
> the only one of the four with no legacy `candlestrategy*.js` behind it — there is nothing to
> port and nothing to diff against, so it is purely a new config plus a registry row.

Not a strategy: logs into optionbhai.com, subscribes its websocket, and replays every
`ORDER_EXECUTION / EXECUTED` message onto our order bus as a market order under the local
tag. No entry/exit logic, no position state, no market data need.

- Hosted by `MirrorHost`, not `Runner` (no session, no cron, no square-off to supervise);
  the two hosts split the tags so nothing double-runs. `isHostedTag()` exists because the
  portal once refused to switch mirrors on, wrongly believing them unimplemented.
- **Start with the process, not the legacy 09:14 delay** — a delayed mirror can see an exit
  without its entry and open an inverted position; the seed actively repairs old `0914`
  rows.
- Credentials come from the environment via the config's `credentialsRef`
  (`OPTIONBHAI_*_USER/_PASS`); a mirror whose pair is absent refuses to start. The
  plaintext credentials committed in the legacy files must be treated as burned.
- Hazards: mirrored fills are at *local* prices (no reconciliation with upstream); an
  unknown upstream symbol is a drop-and-alert case.

### 2.6 RollingLegStrangle — `rv-*` (documented only)

- **Entry.** Once per process (~20 s after start): sell `(atm+otm)CE` + `(atm−otm)PE`
  (otm = 100 BN / 50 NIFTY / 0 for the straddle variants).
- **Roll, not exit.** Adverse (`ltp > entry × 1.25–1.40`): buy back, budget−1, move the
  anchor one step further OTM, re-sell (skip if new premium < floor ₹20/₹5 or budget ≤ 0 —
  the leg retires flat, permanently). Favourable (`ltp < entry × 0.50–0.60`): buy back,
  **budget+1 (refund, uncapped)**, move the anchor back toward spot — never across ATM —
  re-sell. The budget (2 or 3) is shared by both legs.
- No time exit, no EOD, no target; `rv-40sl` alone adds a −₹1200 portfolio breaker (and is
  the family's only Zerodha-direct file, with a serious concurrency bug — rv-cp RISK-B4).
- Variants: `rv-1` decides the roll by a realised-volatility ranking instead of premium %,
  but is **largely inert** — its first evaluation compares a strike pair against itself, so
  it frequently never opens a position (RISK-A1). `rv-4` (smp) adds a next-week
  opposite-side calendar hedge on every roll. `tiger-s-5` (smp) uses a combined 5% stop and
  rolls the *losing* leg to the new ATM.

### 2.7 RungLadderSeller — `bull-300*`, `bull-m*`, `bull-x`, `bull-10`, `falcon-s` (documented only)

One forced entry ~15 s after start sells N symmetric rungs (3 CE above + 3 PE below at
offsets 300/400/500, or 100/200/300; the `i` suffix sells the deep-ITM mirror). The only
transition is a recentre when spot touches the innermost rung: `basket` mode closes and
re-sells all 6 at the new ATM; `translate` (`bull-x`) retires the far rung and shifts by
one step (500 ms re-arm debounce — the family's only race guard); `perSide` (`bull-m/m2`)
**closes only the breached side then overwrites the whole basket state — orphaning 3 short
legs per roll, a known money bug** (bull R2). No premium stop, no target, no EOD, unbounded
rolls, flat 1-lot sizing (`bull-10` adds a per-rung qty ramp).

### 2.8 BracketReverseChain — `cp-*`, `fut-100` (documented only)

The only lineage driven by **broker fill events** rather than ticks. Base price captured
T+10 s; the first ±N-point index move (N = 20, or a noise-level 3, or 50) opens one
position (`cp-*`: single ATM option, SELL except `cp-b-2040`; `fut-100`: 1 lot of the BN
future). On the entry's `Filled` event, stop and target are computed **from the actual
fill price** and placed as a broker-side OCO (StopMarket + Limit); whichever fills cancels
its sibling (`XtsAccount.removePending`) and, after 3 s, reverses: `cp-*` enters the
opposite option type at 1×; `fut-100` sizes both bracket legs at **2×** so the fill *is*
the reversal, forever. Day stop (`cp-*` only): a **net** counter, +1 on a win / −1 on a
loss, stop at ≥+1 or ≤−2 — so `L,W` returns to zero and trading continues (almost
certainly unintended, §5.7). Hazards: correlation ids restart at 0 per process (collide
across restarts); rejected orders are ignored (a rejected stop leaves the leg naked); a
hardcoded XTS account ObjectId does the sibling cancel; no EOD; `fut-100` hardcodes
`lot_size: 30`.

### 2.9 StraddleScalper — `hft-*`, timer/multi/avg (documented only)

The only **long-premium** family. Buy the synthetic-ATM straddle (put-call parity
`K + C − P` on mid prices, fallback to `K`; requires depth), act **only on broker-confirmed
fills**, exit the pair on `avgPrice + target` (+5/+10 pts). Sub-modes: `timer` (smp, 30 s /
120 s hard wall-clock exit, **no stop-loss**, re-enter after 5 s); `averaged` (pyramid
1,2,3,… lots on each N-point drop in the pair, qty-weighted average, geometric target
decay — the working parameters exist **only in smp**; the slive files ship
`MAX_AVERAGING_STEPS = 1`, i.e. averaging off); `independent` (`multi-straddle`: each step
its own straddle at a **frozen** morning ATM, with an escalating target whose counter never
resets); `reversal` (`hft-snx-sell`: target → re-enter same direction, stop → **flip to a
naked short straddle**). `snx-hft-double` is the most dangerous config in the estate:
doubling ladder to 1,023 lots with a ₹10-crore breaker that can never fire. No loss breaker
anywhere in the family; under the simulator the whole cluster deadlocks (no `OrderUpdate`
is ever produced — cheetah-hft R7).

### 2.10 SpreadLadderEngine — `ce/pe-d2*`, `combo-trade` (documented only)

The only depth-priced multi-leg engine. Signed executable spread price
`Σ (SELL ? +bid : −ask) × qty` — always the adverse side. `combo-trade` (smp) is the
generic version and the repo's only existing "strategy = class + config record": it reads
`spreads` documents and hot-reloads via a change stream; entries/exits fire when the price
*crosses* a ladder level that walks by `leap` after each `per_trade` chunk. The
`ce/pe-d2-*` scanner builds a 24-pair 1×2 ratio **front** spread ladder (buy 1× near
strike, sell 2× ~900–1700 pts OTM, net debit 5–10 pts) — unbounded tail risk beyond the
short strikes, **no stop, no EOD**; take-profit only (+15/+25 pts on adverse quotes).
Known defects: the whole scanner **crashes every Thursday** (`otmSelector('SD_2')` returns
`undefined`); the rung-selection comparator is inverted (picks the rung *closest* to ATM);
`combo-trade`'s exit branch has a `'BUy'` typo (exits broken) and persists an in-place
`trades.reverse()`. The `-d2p-`/`ce-pd-*` variants persist ladder state and run on the
`positional` (overnight) bus — a second live bus, not a paper one.

### 2.11 IndicatorFlipStructure — `p718-1/2/3`, `jaguar` (documented only)

Supertrend(14, 5) → a target structure, reconciled on every flip. `p718-1/2/3`: the series
is a **synthetic combined CE+PE premium** 3-min series with `high = low = close`, so ATR
degenerates to mean absolute change (preserve verbatim — a textbook Supertrend changes
every signal); Supertrend above the synthetic close → sell the ±100/200/300 strangle; flip
→ flat. `p718-2/3` add a one-shot combined +30-pt stop (disarms itself after firing —
deliberate) and an 80-pt cumulative day breaker; `p718-1` has **no stop of any kind**. The
14:59:30 kill switch stops the signal loop but **does not flatten**. `jaguar` (smp): plain
5-min future candles → 300-wide credit spread with a bought wing (bull-put / bear-call);
flip → **reverse**; 8 lots on the `positional` bus. It is the estate's only defined-risk,
only persisted-state, only real-expiry-roll strategy (Thursday 15:00 roll without killing
the process). Unwind order is load-bearing: buy back shorts *before* selling hedges.

### 2.12 ChainScanBreakout — `opt-buy`, `opt-buy-day`, `opt-sell` (smp, documented only)

Universe = every contract in the weekly chain; the signal never references the underlying.
`buy-breakout`: option's own `dayLow` inside a premium band (fixed (121,161) or
per-weekday) and `ltp > dayLow × 1.5` → BUY 1 lot; stop `entry − 20`, target
`trigger × 1.5`. `sell-open-is-high`: once, 15 s after connect — `int(open) == int(high)`,
high ∈ [100,400], `ltp < high` → SELL; stop = the day high, no target. Concurrency caps:
one live position per option type, per-strike cap effectively 3 (the counter increments
before the cap test and on rejected attempts). Known leak: a **target** exit never frees
the per-type slot, so one winner blocks that option type for the rest of the day.

### 2.13 Retired outright

| what | why |
|---|---|
| `smp/stgl-120.js` | No schedule, no square-off, no exit; its tag `STGL-25` collides with three other files (four engines writing one tag). |
| `smp/reliance-orb.js` | Broken multi-symbol code (every symbol reads RELIANCE's range). The ORB idea lives properly in `orb-fut-core`. |
| `smp/hdfc_spread.js` | HDFC Ltd merged into HDFC Bank 2023-07-13; the underlying no longer exists. Pattern noted in SpreadLadderEngine. |
| `lib/otmSelector.js` | Returns 0 at 87/93 call sites and `undefined` on Thursdays. Offsets are literal config now. |
| `server/tob|monks|archive|asmp|wealth|insta|scripts` | Dead directories, out of scope. |
| `server/smp/` as a whole | A deployment mode, not a set of ideas — deleted **after** its session-time table and unique configs were harvested (done: taxonomy §6.2). |

---

## 3. What the families share

### 3.1 Execution and sizing (the contracts that must never break)

- **`PaperTrade` is the ORDER BUS, not paper trading.** Every legacy insert was forwarded
  to real XTS/Spark/Fyers accounts by consumer daemons, gated only on
  `account.strategy[tag] > 0`. "Paper" in any older document means "bus-routed".
- **Strategies emit units (lots); the broker layer scales by tag** —
  `orderQuantity = (quantity / lot_size) × account.strategy[tag]`, tranched at per-index
  `maxOrderLots`. Position size is deployment data, not strategy code. Breaking this
  contract silently resizes every live account.
- The `tag` is simultaneously the sizing key, P&L grouping key, order-correlation key and
  square-off key — uniqueness is a hard invariant (legacy had a four-way collision on
  `STGL-25`).

### 3.2 Square-off

**No legacy family had a working EOD square-off** (the two exceptions: the modern family's
15:15 `eodExit`, and `snx-orb`'s 15:20 flatten). Everything else relied on an external pm2
stop at 15:23:50 — which kills the monitor but leaves positions open — plus, for some tags,
the central `squareoff_smp.js` flatten at 15:24:00. Several files `process.exit()` on a
live book. The rewrite makes `session.squareOffAt` mandatory and runner-owned; the runner
flattens, waits for acknowledgements, then stops.

### 3.3 Common risk controls (mostly: their absence)

- Stops, where they exist, are almost always **local tick-monitored** — they die with the
  process. Only lion Algorithm-1, `stgl-sm`, `p718-4` and the `cp/fut` OCO chain rest a
  real stop at the broker. The active legacy set had **zero** broker-resting stops
  (09-active-strategy-scope risk 1).
- Portfolio breakers are inconsistent: dead code (`checkPNL()` commented out), inverted
  (profit-only), or set beyond reach (₹20 lakh / ₹10 crore on 1-lot books).
- Non-flat sizing (martingales, pyramids, doubling ladders) is uncapped in several configs;
  the taxonomy makes `risk.maxLotsNet` mandatory for any non-flat sizing (§3.3-5) and
  requires an explicit `dayLossRupees` decision wherever `stop: none`.

### 3.4 Common failure modes (each appeared in *every* family spec; fixed once in `StrategyBase`)

1. `async.queue(fn,1)` workers with no `.catch` — one rejection permanently wedges the
   queue; the strategy dies silently while pm2 reports it healthy (F1).
2. Unguarded `ticksCache[token].last_price` — a missing quote throws or stalls (F2).
3. `REJECTED` fills treated as `FILLED` (phantom exit at price 0, re-armed re-entry) or
   ignored (leaked trigger, naked leg) (F5).
4. Correlation ids that collide across days/restarts (per-process counters from 0;
   12-hour `hhmmss` ids) (F6).
5. No restart semantics: a mid-session restart orphans open positions *and* re-enters (F7).
6. Expiry as `moment().day() == 3` — the 2021–2023 BANKNIFTY regime, wrong today (F8).
7. Stale on-disk chain cache with no freshness check (F9).
8. `otmSelector()` ≡ 0 — every nominally-OTM seller is an ATM seller (F10).
9. One shared master Zerodha login + a full-chain `modeFull` socket per process — ~290
   sockets, a lost-update race on one Account document (F16).
10. Fire-and-forget order inserts (`Model.create()` un-awaited) racing `process.exit()` (F13).

---

## 4. Where the runner stands vs the taxonomy

Implemented today (`packages/strategies/src/`): **4 of 12 classes** —
`RangeBreakoutDirectional`, `MomentumFlipDirectional`, `PremiumLegBook`,
`PremiumDistanceAccumulator` — plus the `ExternalSignalMirror` adapter, covering exactly the
16-module active set of `09-active-strategy-scope.md` (17 registry rows; `orb-scalp` was
split into three rows so each index has its own switch, and `smp_order_listener` correctly
got no row — it is infrastructure, replaced by the order gateway's fill watcher).

Not implemented (documented only): `RollingLegStrangle`, `RungLadderSeller`,
`BracketReverseChain`, `StraddleScalper`, `SpreadLadderEngine`, `IndicatorFlipStructure`,
`ChainScanBreakout` — and all non-active configs of the four ported classes. The taxonomy's
suggested build order (§9) already prioritised the ported classes; `SpreadLadderEngine`
(`combo-trade` first) is the flagged next candidate because it validates the config-record
pattern end-to-end.

---

## 5. Discrepancies — spec vs code, spec vs spec (resolve, don't paper over)

These are stated as found; none is silently resolved in this summary.

1. **Are `LION_S25_2` / `CHEETAH_B1_1` / `CHEETAH_B1_SNX` "live (Zerodha)" strategies?**
   `09-active-strategy-scope.md` labels all three **LIVE (Zerodha)** and says they are
   "verified as genuine `Account.placeAllAccount` call sites". The family specs contradict
   this: `lion.md` §6.3 ("`getAccounts()` is commented out in all 38 files … no Zerodha
   order is ever placed") and `cheetah-hft.md` R0 ("`getAccounts()` is defined in all 14
   cheetah files and called in none") both conclude the Zerodha loop is a no-op and the
   effective rail is **bus-only**. Both documents are dated 2026-07-25. The reconciliation
   is probably that 09 records *call sites* (intent) while the family specs record
   *effective behaviour* — but the "LIVE" labels in 09 should not be trusted as evidence
   that Zerodha orders were placed. Unresolved; note that in the new system the question is
   moot (mode is a registry switch), but the historical P&L attribution depends on it.
2. **`slive-strategies.csv` rail labels are wrong** for cheetah ("live, zerodha"),
   stgl-mid/p/s ("live") and dolphin/nifty-s/fox-1 ("live") — each family spec corrects
   them to bus-routed, with grep evidence (`cheetah-hft.md` R0, `stgl.md` §0.1,
   `singles.md` §0). The CSV records intent, not behaviour.
3. **`04-strategy-catalog.md` vs `lion.md` on the lion-s25 rail.** The catalog says the
   lion-s25 stop rides "a different broker rail than the entry"; `lion.md` §3.1 corrects
   this — entry (`placeAllAccount` → `trackOrder`) and stop (`trackOrder_slm`) are the
   **same** rail (a `paper-trade` insert), executed by the same daemons. The catalog also
   carries its own top-of-file correction about `PaperTrade` being the order bus.
4. **`04-strategy-catalog.md` vs `eagle.md` on the eagle trigger.** The catalog's "each
   time spot nears a sold leg's own premium distance, it sells one MORE leg" is
   directionally misleading per `eagle.md` §2.1: eagle sells the **opposite** wing into the
   move (a crude delta re-neutralisation ladder), and `add_ce`'s follow-up `add_pe` trigger
   is spaced by the **CE** premium, not the PE's — an asymmetry that materially changes
   trigger spacing.
5. **`rv-1` is described as a working idea; the code is largely inert.** The catalog and
   the taxonomy list realised-vol rolling as a distinct idea; `rv-cp.md` RISK-A1 shows the
   first evaluation compares a pair against itself, so no initial position is ever taken.
   The taxonomy's disposition ("fix behind a flag") acknowledges this — but any historical
   P&L expectation for `rv-1` is unfounded.
6. **`bull-200-1`'s opposite-type replacement: intent or bug?** A stopped CE is replaced by
   a fresh PE at the same premium band (and vice versa), monotonically converting the book
   into a one-sided short of the losing direction. `bull.md` R8 marks the intent
   unresolved; the taxonomy encodes it as an explicit `replacementSide` flag with the
   legacy value `'opposite'`. Must be signed off before that config is ever ported.
7. **`cp-*` day-stop counter is net, not absolute.** `winStop +1 / lossStop −2` reads like
   "stop after 1 win or 2 losses", but `L,W` nets to 0 and trading continues
   (`rv-cp.md` RISK-C6, taxonomy `dayStopCounter` note: "almost certainly unintended —
   model it explicitly and decide").
8. **`orb-fut-core`'s `lots || 2` default contradicts commit `89f8fe70` ("1 lot, single
   target").** Dead in practice (every wrapper passes 1) but a trap if a wrapper ever omits
   `lots` (`modern.md` RISK-10). Also `target-15`'s comments say a 3 s reload delay; the
   code is 9 s (`singles.md`).
9. **"OTM" strategy names vs actual behaviour.** `otmSelector()` returns 0 for every tag
   actually passed, so ~120 nominally-OTM sellers (lion, bull, cheetah, eagle, fox,
   nifty-s, …) are **ATM** sellers. All historical "OTM" P&L is ATM P&L (F10; every family
   spec independently). The specs' *titles* ("strangle") are therefore systematically
   wrong; the bodies correct it.
10. **Spread-scanner selection is inverted vs evident intent.** The `ce/pe-d2*` comparator
    bug makes it pick the rung *closest* to ATM (highest risk) instead of the farthest;
    live P&L reflects the buggy selection, so fixing it is a behaviour change requiring
    re-tuning (`p718-spread.md` bug 5; taxonomy flags it in the `rank: 'legacy-buggy'`
    enum).
11. **smp vs slive parameter drift is bidirectional.** For the hft cluster smp holds the
    *newer, armed* config (averaging 10 steps) while slive ships it disabled (steps = 1);
    for `bn-breakout` slive leads (per-side loss-gated budget vs smp's stale 1/day). Never
    assume one directory is uniformly newer (`smp-drift.md` §0). The `snx-orb` files are
    byte-identical in both directories **with the same tags** — running both copies would
    double every order.
12. **Mirror autostart: legacy 0914 vs "start with the process".** The legacy registry
    delayed the mirrors to 09:14; `MirrorHost` never honoured a schedule, and delaying a
    mirror is dangerous (it can mirror an exit without its entry). The seed now writes `''`
    and actively repairs old `0914` rows (`registry-seed.ts`). Two retired
    `disabledReason` strings ("golden test still failing" for `ATR_BAND_NIFTY`,
    "credentials not migrated" for the mirrors) described defects/plans that no longer
    exist and are likewise cleared.
13. **"15 strategies" vs 17 registry rows.** The Phase C spec's count is 15 legacy
    *modules*; the registry has 17 rows because `orb-scalp.js` is one process running three
    independent configs, each needing its own switch (`registry-seed.ts` count note). Not a
    bug — but don't reconcile the numbers by deleting rows.
14. **`09-active-strategy-scope.md`'s 8 proposed classes vs the 4 implemented.** The
    implemented catalogue collapsed 09's `band-breakout-option` / `atr-band-option` /
    `opening-range-futures` / `opening-range-option` into one `RangeBreakoutDirectional`,
    and `atm-straddle-pyramid` + `atm-crossover-strangle` into `PremiumLegBook` — matching
    the taxonomy, not 09. 09's table is superseded on this point.
15. **Broken-by-construction members documented as if functional.** `samlion-*` has no
    working exit (lion §7.7); slive `p718-5` cannot run at all (undeclared `optionOrders`
    → crash on first tick; its "stop" also compares a premium to a multiplier —
    `p718-spread.md` bugs 2–3); `stgl-mid-0020-1`/`stgl-mid-3` sell the wrong strikes (a
    Promise minus 250 is NaN → chain-order selection, stgl R3); `stgl-sm`'s stop-fill
    handler always throws (stgl R2); `vwap` marks a side open before the entry condition
    passes (phantom position, smp R9). Any catalog line that describes these as working
    strategies overstates them; the taxonomy's ledger carries the correct
    "fix on port / reimplement" dispositions.

---

*End of summary. The per-family specs remain the source of truth for implementation detail;
this document is the operator's map, not a replacement for them.*
