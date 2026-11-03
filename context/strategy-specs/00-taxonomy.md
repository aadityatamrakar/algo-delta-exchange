# 00 — Unified Strategy Taxonomy for the TypeScript Rewrite

**Status:** canonical. Synthesised 2026-07-25 from the ten per-family specs in this directory
(`lion`, `bull`, `eagle`, `cheetah-hft`, `stgl`, `rv-cp`, `p718-spread`, `singles`, `modern`,
`smp-drift`), which together cover **290 live files** — `server/slive/` (156) and `server/smp/` (134).
The other strategy directories (`tob`, `monks`, `archive`, `asmp`, `wealth`, `insta`, `scripts`)
are dead and are retired wholesale (§8).

**Result: 12 strategy classes + 1 non-strategy adapter cover all 290 files.**
4 of the 290 files are pure-logic/factory modules that become shared library code, and 3 are
retired outright. Every remaining file becomes a **config record**, not code.

---

## 0. How the classes were derived

A "class" is defined by its **position state machine** — what the book looks like, what
transitions it, and who owns the exit. It is *not* defined by:

* the underlying (that is `config.underlying`),
* the strike offset (that is `config.strike`),
* the stop/target formula (that is `config.exit`),
* the size ladder (that is `config.sizing`),
* the broker rail (that is `config.rail`, and per every family spec it is an *environment*
  property, not a strategy property).

Those are exactly the five axes the owner already identified, and they are the reason ~380 files
encode ~15 ideas. Applying that rule mechanically across all ten specs:

| step | count |
|---|---|
| distinct "ideas" claimed by the ten family specs | **36** |
| after collapsing ideas that differ only on the 5 config axes | **17** |
| after cross-family dedup (§2) | **12 classes + 1 adapter** |
| after removing dead/broken files | 3 files retired |

12 sits at the low end of the 12–20 target. The justification for not going higher is in §2.3;
the justification for not going lower (10) is in §2.2.

---

## 1. The class list

| # | Class | Position machine in one line | slive | smp | total |
|---|---|---|---|---|---|
| 1 | `PremiumLegBook` | A book of independent short option legs opened by a *level or clock* signal, each carrying its own entry premium and its own stop/target; re-entry by policy. | 73 | 55 | **128** |
| 2 | `RollingLegStrangle` | Exactly one CE anchor + one PE anchor, never flat: an adverse premium move *rolls* the leg further OTM, a favourable one rolls it back in, against a shared refundable budget. | 9 | 6 | **15** |
| 3 | `RungLadderSeller` | N short rungs at fixed offsets around a moving centre; touching a boundary triggers an **atomic multi-leg recentre / translate**. No premium exit. | 7 | 9 | **16** |
| 4 | `PremiumDistanceAccumulator` | A grid of pending price triggers spaced by option premium; every fire adds one leg (or pair) and pushes two new triggers. **Never exits.** | 12 | 8 | **20** |
| 5 | `MomentumFlipDirectional` | Direction chosen once from a *vs-day-open* comparison; one leg or one ATM pair; on stop, flip to the other side and re-enter. | 15 | 20 | **35** |
| 6 | `BracketReverseChain` | Base-price breakout → one position → a broker-side **OCO** (StopMarket + Limit) priced off the *actual fill*; whichever fills reverses the position and re-brackets. Fill-event driven. | 10 | 4 | **14** |
| 7 | `RangeBreakoutDirectional` | Freeze a reference band in the morning; a **completed candle close** beyond an edge takes a directional position; premium/points target, opposite-edge stop, time stop, EOD flat. | 9 | 4 | **13** |
| 8 | `StraddleScalper` | **Long** the synthetic-ATM straddle; exit on a combined-premium target, a wall-clock timer, or a reversal; optional averaging pyramid. Fill-confirmation gated. | 5 | 14 | **19** |
| 9 | `SpreadLadderEngine` | An N-leg spread priced on **order-book depth**; scale in/out in chunks as the executable spread price crosses a ladder level that walks after each fill. | 6 | 7 | **13** |
| 10 | `IndicatorFlipStructure` | Supertrend on a candle series → a target *structure* state (`FLAT` / `SHORT_STRANGLE` / `BULL_PUT` / `BEAR_CALL`); reconcile the book to it on every flip. | 3 | 1 | **4** |
| 11 | `ChainScanBreakout` | Universe = **every contract in the chain**; signal is the contract's *own* intraday OHLC; per-contract independent entries with concurrency caps. | 0 | 3 | **3** |
| 12 | `CalendarPair` *(folded into #1 — see §2.2)* | — | — | — | — |
| A1 | `ExternalSignalMirror` *(adapter, not a Strategy)* | Mirrors another system's executed orders onto our order bus. | 3 | 0 | **3** |
| — | shared pure-logic / factory modules | `atr-band-logic`, `orb-scalp-logic`, `orb-fut-logic`, `orb-fut-core` | 4 | 0 | **4** |
| — | **retired** (§8) | `stgl-120`, `reliance-orb`, `hdfc_spread` | 0 | 3 | **3** |
| | | **totals** | **156** | **134** | **290** |

> Numbering note: slot 12 is deliberately left as a tombstone so nobody re-creates
> `CalendarPair` — the two `cal-*` / `calc-*` pairs are `PremiumLegBook` configs with a
> per-leg `expiry` field. See §2.2.

### 1.1 Per-class detail

#### 1 · `PremiumLegBook` — 128 files (44 % of the estate)

**Book:** `Map<legId, Leg>` where `Leg = {instrument, side, entryPremium, lots, stopState, groupId}`.
Legs may be grouped into pairs/ladders (`groupId`) when the exit is combined.

**Why it is one class:** every one of the 128 files has literally the same machine — *append a
short leg (usually a symmetric CE+PE pair) to a book when a signal fires; close a leg (or its
group) when a premium condition fires; maybe append again.* They differ only in the five policy
slots below, each of which is a small, separately-testable pure module:

| slot | implementations observed | legacy sources |
|---|---|---|
| `entrySignal` | `strike-crossover` (round-strike touch/cross) · `level-recross` (frozen entry-spot re-cross) · `once-at-start` · `fixed-delay-after-flat` · `clock-schedule` (per-weekday slot table) · `premium-limit` (premium decayed to k× its value at slot creation) · `premium-vs-vwap` | lion/bull/stgl-mid/dolphin · stgl-mid · samlion/stgl-s · target-15 · p718-4/5, cal-* · p718-7 · vwap |
| `strikeSelector` | `atm-offset(0…400)` · `wings[]` (`[0]`, `[0,100,200,300]`, `[100..400]`, `[0..900]`) · `nearest-premium(target[])` (250/200/150/120) · `max-pain-side` | lion/bull · biglion/samlion/stgl-s · stgl-mid/stgl-p/bull-200-1/strangle-* · p718-5 |
| `exit` | `per-leg-pct` (1.03…1.50) · `per-leg-trailing-pct` (0.15/0.25) · `per-leg-abs-points` (+50) · `combined-pct` (0.90…1.25) · `combined-points` (25/50/70) · `per-leg-pct-of-combined` (1.5 %) · `none` | lion/stgl/bull · lion-st* · bull-200-1 · lion-sp/lion-sl-8/stgl-p/p718-7 · dolphin/nifty-s · target-15 · cal-* |
| `reentry` | `none` · `paired` (re-sell both when either closes) · `per-leg` · `spot-recross` (frozen strikes) · `chain-next-premium-target` (250→200→150, max 3) · `replace-opposite-type` · `roll-otm-on-stop` | samlion/stgl-s · lion/bull · jk-* · stgl-mid · stgl-p · bull-200-1 · lion sub-modes |
| `sizing` | `flat(n)` · `pyramid-up(+1, cap?)` · `pyramid-down(7→0)` · `per-slot-table` | most · bull-s* · bull-r · p718-4 (Thu ×2) |
| `exitEngine` | `broker-resting-stop` (SLM armed off the real fill via the order-update stream) · `tick-monitor` · `both` (legacy sub-mode B — **do not port as-is**, see §7) | lion Alg1/stgl-sm/p718-4 · lion Alg2 C/T · lion Alg2 B |

**Sub-modes and their file counts** (all one class, listed so nothing is invisible):
`lion` ATM-crossover (34) · `samlion` static ladder (4) · `bull` crossover-straddle-pyramid (12) ·
`bull-200-1` premium-target flip (1) · `stgl` premium-recross / premium-ladder / wing-ladder (14) ·
`dolphin`/`nifty-s`/`target-15` premium-target pair seller (4) · `p718-4/5` clock-schedule (2) ·
`cal-*` calendar one-shot (2) · smp `lion-*`/`jk`/`samlion`/`nifty-s`/`dolphin`/`bull-s*`/
`strangle-*`/`stgl-*`/`bull-200/201`/`calc-*`/`p718-5`/`p718-7`/`vwap` (55).

**Invariants to preserve** (from the family specs — full list in §7): claim-before-await on every
exit; `lastQuote` written once per tick on *every* evaluation; `openStrikes[atm]` one-live-group
per level; per-position `lotSize` memory; `parseInt` truncation of stop/target levels; the
frozen-strike + frozen-entry-spot re-entry reference in `stgl-mid`; monotonic `generation`
increment before any await in `stgl-p`.

#### 2 · `RollingLegStrangle` — 15 files

**Book:** exactly `{ceAnchor: number|false, peAnchor: number|false}`; the traded strike is always
`anchor ± otm`. Never closed-and-flat except terminally.

Transitions: *adverse* (`ltp > entry × slPct`) → buy back, `budget--`, anchor moves **away** from
spot, re-sell; *favourable* (`ltp < entry × tgtPct`) → buy back, `budget++` (uncapped in legacy),
anchor moves **toward** spot but **never across ATM**, re-sell. Terminal on `budget ≤ 0`, on the
new leg's premium `< minimumPrice`, or on the portfolio breaker.

Covers `rv-1` (roll decided by a realised-volatility ranking instead of a premium %),
`rv-2/25n/40/40e1/40e2/40n/40sl/s2`, smp `rv-3/rv-4/rv-40/rv-40n/rv-25n`, and `tiger-s-5`
(combined-stop variant that rolls the *losing* leg to the new ATM).
`rv-4`'s next-week mirror leg becomes `hedge: {expiry:'next', side:'opposite'}`.

#### 3 · `RungLadderSeller` — 16 files

**Book:** `rungs: Array<{offset, legs[]}>` around a `centre`. The only transition is a
**recentre transaction**: on `spot ≥ centre + trigger` (or ≤), atomically close a defined subset
and open a defined subset, in a fixed wire order. Three modes:
`basket` (close all 6, recentre all 6 — `bull-300*`, `bulln-300*`), `perSide` (close the breached
side only — `bull-m`, `bull-m2`; **this is R2, the 3-orphaned-legs money bug**), `translate`
(retire the far rung, shift all rungs one step, open a new near rung — `bull-x`, `falcon-s`).
`bull-10` adds a per-rung quantity ramp (+100/1, +200/2, +300/3, mirrored).

Legs may be `otm` (CE above / PE below) or `itm` (PE above / CE below — the `i` suffix, deep-ITM
near-1.0-delta shorts, **not** a condor).

#### 4 · `PremiumDistanceAccumulator` — 20 files (eagle)

**Book:** `legs: Leg[]` (append-only) + `pending: Map<id, {trigger, action:'add_ce'|'add_pe'}>`.
Entry latch fires one ATM straddle and pushes 2 triggers. Every trigger that the price crosses
**in either direction** fires once, is consumed, and — if the new leg's premium clears
`premiumFloor` — pushes **two** replacements. Net +1 pending trigger per fill, so leg count is
super-linear in realised path length, not in net move. A rejected add prunes its branch
permanently (the family's only natural brake). **There is no exit at all** — flattening is a
central 15:24 square-off.

#### 5 · `MomentumFlipDirectional` — 35 files

One direction decision per process, taken from a *vs-open* comparison, then a flip-on-stop loop.
Two instrument models, one machine:

| | single-leg (cheetah, 30 files) | atm-pair (fox/spt/strad-ts, 5 files) |
|---|---|---|
| reference | spot (or monthly future) vs its `ohlc.open` | combined pair premium vs combined pair `ohlc.open` |
| position | one ATM CE **or** PE | one ATM straddle |
| on stop | flip CE↔PE, re-enter | flip SELL↔BUY, re-enter at a **fresh** ATM |
| on target | **does not re-enter** (goes idle for the day) — preserve this asymmetry | n/a |

Axes: `stop {trail|fixed|trailing-pct, points}` (60/30/10/1+15 %/20 %/25 %), `target` (none or
+90 / +70), `reentryStrikeRef` (`current-atm` | `frozen-first-atm`), `reentryCap`
(∞ / 3 / 0-disabled), `sizing` (flat / martingale +1 capped 12 / martingale uncapped /
flip-double 10-lots-at-2×), `portfolioBreaker` (−2500 / +2500 / +5000/−12500 / none),
`exitMechanism` (`local-tick` | `broker-slm`).

#### 6 · `BracketReverseChain` — 14 files

The only two lineages whose **entire lifecycle is driven by broker fill events**, not by ticks.
`basePrice` captured T+10 s → first ±N-point index/future move arms exactly one entry →
on the entry's `Filled` event, compute stop and target **from `OrderAverageTradedPrice`** and
place a `StopMarket` + a `Limit` as an OCO pair → whichever fills cancels its sibling
(`XtsAccount.removePending(tag)`), stamps the bus ledger row `COMPLETE`, and re-arms the opposite
position after a delay.

Two reverse mechanisms, one machine: `cp-*` places a fresh entry of the **opposite option type**
at 1× (9+4 files, with a net `+1 win / −2 losses` day stop); `fut-100` sizes both bracket legs at
**2×** so a fill *is* the reversal (1 file, no day stop, runs forever).

#### 7 · `RangeBreakoutDirectional` — 13 files (+4 shared modules)

The modern, tested lineage — **this is the reference implementation for the rewrite**.
Morning phase freezes a band; a 5-minute poller evaluates the last *completed* candle; a close
beyond an edge (optionally colour- and consecutive-candle-confirmed) opens one position.

Three band sources: `firstCandlePct` (±0.09 % of the 09:15–09:20 close), `atrAnchor`
(Wilder ATR-14 on 60-min ÷ 3, around the 11:35–11:40 close), `openingRange` (6×5-min, ±0.10 %).
Three execution mappings: `atm-option-of-side` (buy the CE/PE — `bn-breakout`, `atr-band-nifty`,
`orb-scalp`×3), `signal-instrument-itself` (trade the future — `orb-fut-{bn,nifty,snx}`),
`own-premium-both-sides` (the *option's own* 15-min range, traded long and short independently,
risk-sized to a fixed rupee loss — `snx-orb-{1,25,50}`).
`stop.measuredOn: 'signal' | 'traded'` and `exitPrecedence` (`[EOD,TARGET,SL]` for option-buy,
`[EOD,SL,T1]` for the future) are config, and both orderings are unit-tested today — keep them
opposite.

#### 8 · `StraddleScalper` — 19 files

The only **long-premium** family. Buy the synthetic-ATM straddle (put-call parity
`K + C − P`, on mid prices, with a graceful fallback to `K`), then exit the pair on
`avgPrice + target` — plus, by config, a wall-clock time stop, an averaging pyramid, or a
reversal. Sub-modes: `timer` (30 s / 120 s hard exit, no stop-loss, re-enter after 5 s — 6 files),
`averaged` (one slot per strike, qty-weighted average pair price, geometric target decay
`×(1−pct)` per step — 5 files), `independent` (each pyramid step is its own straddle with its own
*escalating* target — 3 files), `reversal` (`hft-snx-sell`: target → same direction, stop →
**flip to a naked short straddle**), plus the 4 slive files that ship with
`MAX_AVERAGING_STEPS = 1`, i.e. the pyramid switched off.

`atmPolicy: 'frozen' | 'recentre-on-flat' | 'per-entry'` is three deliberate behaviours — do not
unify (smp-drift P6).

#### 9 · `SpreadLadderEngine` — 13 files

The only depth-priced multi-leg engine, and the only place in the repo where a strategy is
**already a class + a config record** (`combo-trade` reads the `spreads` collection and hot-reloads
via a change stream). Signed executable spread price
`Σ (SELL ? +bid(tok) : −ask(tok)) × qty` — always the adverse side. Entry fires when the price
**crosses** a ladder level from either direction; each fill consumes `perTrade` of a `total`
budget and walks the level by `leap` (or, in the ratio-scanner variant, escalates the threshold by
`0.25` and permanently relaxes the entry band).

`legSource: 'static-config'` (`combo-trade`) | `'atm-relative-scan'` (the 24-pair 1×2 ratio front
spread of `ce/pe-d2-*`, `ce/pe-d-*`, `ce/pe-pd-*`) | `'stock-pair'` (`hdfc_spread`, retired —
pattern kept, underlying gone).
`book: 'paper-trade' | 'positional'` — `positional` is a **second live bus**, not a paper one.

#### 10 · `IndicatorFlipStructure` — 4 files

Supertrend(14, 5) → a target structure state; reconcile the book to it on flip.
Two indicator inputs: a **synthetic combined-premium 3-min series** where
`high = low = close = closeCE + closePE` (so ATR degenerates to a 14-period mean absolute
change and the bands are `close ± 5×ATR`) — `p718-1/2/3`; and plain 5-min future candles —
`jaguar`. Two structures: naked short strangle at ±`farAtm` (flip → flat) and a
300-wide credit spread with a bought wing (flip → **reverse**). `jaguar` is also the only file in
the repo with persisted state, a real expiry roll, and a defined-risk structure.

**Ordering is load-bearing:** unwind the short legs *before* selling the hedges.

#### 11 · `ChainScanBreakout` — 3 files

Universe = every instrument in the weekly chain; the signal never references the underlying.
`buy-breakout`: `dayLow ∈ band` and `ltp > dayLow × 1.5` → buy, stop `entry − 20`, target
`trigger × 1.5`; band is fixed `(121,161)` or per-weekday. `sell-open-is-high`: fired once 15 s
after connect, `int(open) == int(high)` and `high ∈ [100,400]` and `ltp < high` → sell, stop =
the day high, no target. Concurrency caps: one live position per `instrument_type`, ≤4 (really 3)
per strike per day.

#### A1 · `ExternalSignalMirror` — 3 files, **not a Strategy**

A `SignalSource` adapter: log in to `optionbhai.com`, subscribe its websocket, and replay every
`ORDER_EXECUTION / EXECUTED` message onto our order bus under a local tag. No entry or exit logic
of its own. **Plaintext credentials are committed in all three files — rotate before anything
else** (§8).

---

## 2. Merge decisions

### 2.1 The merges that actually collapsed the estate

| merge | what was separate before | files | why they are one machine |
|---|---|---|---|
| **`PremiumLegBook`** | lion Alg1 + lion Alg2 + samlion + bull idea B + bull-200-1 + all 3 stgl ideas + singles idea A + p718 idea B + cal-* + smp vwap/p718-7/strangle-* — **11 "ideas" across 6 family specs** | 128 | Identical book (independent short legs keyed by strike, each with an entry premium and a stop), identical claim-before-await guard, identical correlation-id/`executeSL` ledger contract, identical "emit units, broker scales by tag" sizing contract. The differences are 5 enumerable policy values. `singles.md` §"Cross-family dedup note" independently reached the same conclusion for `dolphin`/`nifty-s`/`target-15`. |
| **`MomentumFlipDirectional`** | cheetah `momentum-flip-single-leg` + singles `trailing-flip-pair` + smp `spt-*` + smp `strad-ts-*` | 35 | Both pick direction once from a *vs-open* comparison and flip on stop. The only differences are `instrumentModel` (single leg vs ATM pair) and which series the *vs-open* comparison runs on (spot vs combined pair premium). |
| **`BracketReverseChain`** | rv-cp idea C (`cp-*`) + singles idea E (`fut-100`) | 14 | Same base-price arming, same `dataObj → orderUniqueIdentifier → OrderUpdate.params` round trip, same OCO pair, same `removePending` sibling cancel, same `executeSL` ledger stamp, same "a fill is the next entry" chain. Reverse mechanism (1× opposite type vs 2× same instrument) is one config value. |
| **`StraddleScalper`** | cheetah `synthetic-atm-straddle-averaging` + cheetah `synthetic-atm-straddle-reversal` + smp idea 1 (`timer`) + smp idea 2a/2b (`hft-avg`, `multi-straddle`) | 19 | One file lineage. Same synthetic-ATM computation, same mid-price helpers, same fill-confirmation gate, same timed restart. `timeStop`, `averaging`, `reversal` are three optional policies on one pair book. |
| **`SpreadLadderEngine`** | p718 idea C (`ratio-spread-ladder`) + smp idea 6 (`combo-trade`) + smp `hdfc_spread` | 13 | `combo-trade` is literally the generic version of the ratio scanner: same signed depth-priced spread, same crossing detection against a walking level, same chunked budget. Only the *leg source* differs (config record vs ATM-relative scan). |
| **`IndicatorFlipStructure`** | p718 idea A + smp idea 5 (`jaguar`) | 4 | Both are "Supertrend(14,5) on a series → target structure state → reconcile". Structure template and flip semantics (`flat` vs `reverse`) are config. |
| **`RangeBreakoutDirectional`** | modern idea A + modern idea B + singles idea C (`snx-orb`) + smp `reliance-orb` | 13 | One `BandBreakSignal` + an `executionMapping`. This is exactly what `modern.md` §1 proposed; packaging it as one class + 3 mappings avoids duplicating the phase/catch-up/exit-precedence machinery three times. |
| **`RollingLegStrangle`** absorbs `rv-1` and `tiger-s-5` | rv-cp idea A + idea B + smp `tiger-s-5` | 15 | Same 2-anchor book and same roll transition; only the *roll trigger* differs (premium % vs realised-vol ranking vs combined stop). |

### 2.2 Things I merged that a reader might expect to stay separate

* **`cal-ce` / `cal-pe` / `calc-ce` / `calc-pe` (short calendars) → `PremiumLegBook`.**
  A 09:25 clock trigger, two legs at the same strike in different expiries, no exit. That is
  `entrySignal:'clock-schedule'`, `legs:[{expiry:'nearest',side:'BUY'},{expiry:'next',side:'SELL'}]`,
  `exit:{basis:'none'}`. It needs `leg.expiry` as a config field — which `rv-4` needs anyway.
  A dedicated class for 4 files that share the book would be duplication. **Slot 12 is a
  tombstone** so this decision is visible rather than forgotten.
* **`vwap.js` → `PremiumLegBook`** with `entrySignal:{kind:'premium-vs-vwap'}` and the same
  signal as the exit. It needs the tick's `average_price` field — a feed capability, not a class.
* **`p718-7` (premium-decay limit strangle) → `PremiumLegBook`** with
  `entrySignal:{kind:'premium-limit', mult:0.9}` and `exit:{basis:'combined-pct', value:1.1,
  scope:'losing-legs-only', disarmOnFire:true}`. The partial loser-only exit is a real policy
  value, not a new machine.
* **`p718-4` / `p718-5` (clock-table sellers) → `PremiumLegBook`.** The schedule *is* the alpha,
  but it is an entry signal; the book, the SLM-on-fill stop and the ledger contract are the
  family's standard ones.
* **`bull-200-1` → `PremiumLegBook`** with `strikeSelector:'nearest-premium'` and
  `reentry:'replace-opposite-type'`. Keep `replacementSide` as an explicit flag: the legacy value
  is `opposite`, and whether that is intent or a copy-paste inversion is unresolved (bull R8).

### 2.3 Things I refused to merge, and why

| kept apart | tempting merge | why not |
|---|---|---|
| `PremiumDistanceAccumulator` (eagle) vs `PremiumLegBook` | "it's just another re-entry policy" | Its risk model is categorically different: **no exit exists**, and the pending-trigger set grows by +1 per fill, so leg count is unbounded and super-linear in path length. Folding an unbounded-leg accumulator into the bounded leg engine would smuggle that risk profile behind a config flag. It needs its own `maxLegs` / `maxNotional` / margin guards. |
| `RollingLegStrangle` vs `PremiumLegBook` | "an adverse roll is just stop-then-re-enter" | Cardinality is invariant (≤2 legs, never flat), the budget is *refundable* (`++` on favourable rolls) and uncapped, roll-in is blocked from crossing ATM, and the terminal conditions are ordered (`close → minimumPrice → budget`). None of that fits a per-leg stop policy without making the policy interface a second engine. |
| `RungLadderSeller` vs `PremiumLegBook` | "rungs are just legs" | The transition is an **atomic multi-leg transaction against a moving centre**, ordered on the wire (close-then-open, PE before CE, `basket = null` *between* them). The exit trigger is an underlying level, not a premium. Modelling this as N independent legs loses the atomicity and reintroduces `bull-m`'s orphaning bug by construction. |
| `StraddleScalper` vs `PremiumLegBook` | "both trade ATM pairs" | Opposite sign of theta (long vs short premium), opposite exit semantics (target on a *rise* in combined premium vs a *fall*), and every decision is gated on **broker-confirmed fills**, not on ticks — which means the backtester must supply a synthetic fill stream for this class and need not for the other. |
| `BracketReverseChain` vs `MomentumFlipDirectional` | both "flip on stop" | `BracketReverseChain` **cannot function without an order-update stream**: stop and target are derived from `OrderAverageTradedPrice`, the position lives at the broker, and the sibling cancel is a broker call. `MomentumFlipDirectional` decides everything from ticks. That is an architectural split (different injected dependency set, different backtest harness), not a config value. The shared `flipOnStop` logic becomes a common policy module. |
| `ChainScanBreakout` vs `RangeBreakoutDirectional` | "both are breakouts of a day extreme" | Universe model: 300–400 independent per-contract state machines with cross-contract concurrency caps (`onePerOptionType`, `maxPerStrike`) versus 1–3 preselected instruments. The scan cost, the subscription profile and the position-cap bookkeeping are all different. |
| `ExternalSignalMirror` vs any Strategy | "it places orders" | It has no entry or exit logic, no position state and no market data. It is a `SignalSource` feeding the order bus. Modelling it as a Strategy would give it lifecycle hooks (`phases`, `squareOff`, day budget) that are meaningless for it. |

---

## 3. Config schema

Zod-style, TypeScript. One `BaseConfig` every class takes, plus a per-class extension.
The five known axes are the backbone: **underlying · strike offset · stop/target basis ·
sizing · execution rail**. Two axes the legacy code hides and that must become explicit are
added: **session** (from `smp/`) and **expiry policy** (owned by nobody today).

### 3.1 Primitives

```ts
import { z } from 'zod';

/* ---------- axis 1: underlying ---------- */
export const Underlying = z.enum([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX',
  'RELIANCE', 'HDFCBANK', 'STOCK',              // stock groups; extend per symbol
]);

export const UnderlyingSpec = z.object({
  symbol: Underlying,
  /** What the strategy rounds to a strike / measures moves on.
   *  'index-spot' and 'current-future' differ by the futures basis (tens of points on
   *  BANKNIFTY) — lion-s25-2, bull-s-1, eagle-s-1, cheetah-b1-1, target-15, cal-*, fut-100
   *  and 34 smp files deliberately use the future. Never collapse them. */
  reference: z.enum(['index-spot', 'current-future', 'traded-instrument']),
  /** Strike grid of the option chain. NEVER hardcode 100: NIFTY/FINNIFTY = 50,
   *  MIDCPNIFTY = 25 (legacy files wrongly use 50), BANKNIFTY/SENSEX = 100. */
  strikeStep: z.number().int().positive(),
  /** Ladder step for crossover signals, INDEPENDENT of strikeStep (dolphin: 200 vs 100). */
  gridStep: z.number().int().positive().optional(),
}).strict();

/* ---------- axis 2: strike / leg selection ---------- */
export const StrikeSelector = z.discriminatedUnion('by', [
  z.object({ by: z.literal('atm-offset'), offsetPoints: z.number().int().default(0) }),
  z.object({ by: z.literal('wings'),      offsets: z.array(z.number().int()).nonempty(),
             legTypes: z.enum(['otm', 'itm']).default('otm') }),
  z.object({ by: z.literal('nearest-premium'), targets: z.array(z.number()).nonempty(),
             /** distance assigned to an un-ticked contract; legacy 250 (one file 230).
              *  MUST be explicit — the legacy fallback makes far strikes win the scan. */
             missingQuoteDistance: z.number() }),
  z.object({ by: z.literal('synthetic-atm'), // put-call parity K + C - P, on mid prices
             offsets: z.array(z.number().int()).default([0]) }),
  z.object({ by: z.literal('max-pain-side') }),
  z.object({ by: z.literal('range-derived'), // ceil(rangeHigh/step)*step / floor(rangeLow/step)*step
             roundTo: z.number().int() }),
  z.object({ by: z.literal('full-chain-scan') }),
]);

/** A leg template. `expiry` exists so calendars (cal-*, rv-4) are config, not a class. */
export const LegSpec = z.object({
  type: z.enum(['CE', 'PE', 'FUT']),
  side: z.enum(['BUY', 'SELL', 'SAME', 'OPPOSITE']),
  offsetPoints: z.number().int().default(0),
  expiry: z.enum(['nearest', 'next', 'monthly']).default('nearest'),
  lotsMultiplier: z.number().default(1),
}).strict();

/* ---------- axis 3: stop / target basis ---------- */
export const StopBasis = z.discriminatedUnion('basis', [
  z.object({ basis: z.literal('none') }),
  z.object({ basis: z.literal('per-leg-pct'),        value: z.number() }),      // 1.03 … 1.50
  z.object({ basis: z.literal('per-leg-points'),     value: z.number() }),      // +50, +30, +10
  z.object({ basis: z.literal('per-leg-trailing-pct'),  value: z.number() }),   // 0.15 / 0.25
  z.object({ basis: z.literal('per-leg-trailing-points'), value: z.number() }), // 60 / 30 / 20 / 10 / 1
  z.object({ basis: z.literal('combined-pct'),       value: z.number(),
             scope: z.enum(['whole-group', 'losing-legs-only']).default('whole-group'),
             disarmOnFire: z.boolean().default(false) }),                       // p718-7, p718-2/3
  z.object({ basis: z.literal('combined-points'),    value: z.number() }),
  z.object({ basis: z.literal('underlying-level'),
             level: z.enum(['opposite-band-edge', 'opposite-orb-end', 'day-extreme', 'entry-band-edge']),
             cushion: z.union([z.object({ kind: z.literal('abs'),  value: z.number() }),
                               z.object({ kind: z.literal('pct'),  value: z.number() })]).optional() }),
  z.object({ basis: z.literal('own-day-extreme') }),                            // opt-sell
]);

export const TargetBasis = z.discriminatedUnion('basis', [
  z.object({ basis: z.literal('none') }),
  z.object({ basis: z.literal('per-leg-points'),      value: z.number() }),     // +90, +45, +40, +25, +20
  z.object({ basis: z.literal('per-leg-pct'),         value: z.number() }),     // 0.50 / 0.60 / 0.97 / 0.99
  z.object({ basis: z.literal('min-points-or-pct'),   points: z.number(), pct: z.number() }), // atr-band
  z.object({ basis: z.literal('combined-points'),     value: z.number() }),     // 70 / 25 / 10 / 5
  z.object({ basis: z.literal('per-leg-pct-of-combined'), value: z.number() }), // target-15, 0.015
  z.object({ basis: z.literal('range-multiple'),      value: z.number() }),     // orb-fut, 1×
  z.object({ basis: z.literal('trigger-multiple'),    value: z.number() }),     // opt-buy, 1.5×
]);

/** Explicit comparison strictness — both are unit-tested in the modern family and are opposite. */
export const ExitRules = z.object({
  stop: StopBasis,
  target: TargetBasis,
  /** Evaluated against ONE price snapshot, in this order. Option-buy: EOD,TARGET,SL.
   *  Directional-instrument: EOD,SL,T1. Keep them opposite (modern P12). */
  precedence: z.array(z.enum(['EOD', 'TIME', 'TARGET', 'T1', 'SL', 'BREAKER'])),
  stopStrict: z.boolean().default(true),   // true => price exactly at the stop does NOT fire
  targetStrict: z.boolean().default(false),
  /** Measured on the underlying/signal instrument or on the traded one. */
  stopMeasuredOn: z.enum(['signal', 'traded']).default('traded'),
  sampledOn: z.enum(['tick', 'candle-close']).default('tick'),
  /** Legacy truncates stop/target to int (parseInt) or to 1 dp. Reproduce or change deliberately. */
  levelRounding: z.enum(['none', 'int-truncate', 'tenth']).default('none'),
  timeStopMinutes: z.number().positive().optional(),   // 60 / 90 (modern), 0.5 / 2 (timer)
}).strict();

/* ---------- axis 4: sizing ---------- */
export const Sizing = z.discriminatedUnion('kind', [
  /** The contract the whole estate depends on: the strategy emits UNITS (lots), and the
   *  broker layer scales by account.strategy[tag] and tranches at maxOrderLots.
   *  Breaking this silently resizes every live account. */
  z.object({ kind: z.literal('flat'), lots: z.number().positive().default(1) }),
  z.object({ kind: z.literal('pyramid-linear'), start: z.number(), step: z.number(),
             cap: z.number().nullable(), floor: z.number().default(0) }),        // bull-s +1, bull-r -1
  z.object({ kind: z.literal('pyramid-double'), start: z.number(), cap: z.number() }),
  z.object({ kind: z.literal('averaging-ladder'), nextQty: z.enum(['n+1', 'x2']),
             maxSteps: z.number().int(), trigger: z.number(),
             targetDecayPct: z.number().default(0) }),
  z.object({ kind: z.literal('risk-based'), maxLossRupees: z.number(),
             lotSize: z.number().int(), roundTo: z.literal('whole-lots'),
             minLots: z.number().default(1) }),                                  // snx-orb
  z.object({ kind: z.literal('rung-ladder'), perRung: z.array(z.number()) }),     // bull-10
  z.object({ kind: z.literal('chunked-budget'), perTrade: z.number(),
             total: z.number(), leap: z.number() }),                             // spreads
  z.object({ kind: z.literal('per-slot-table'), byWeekday: z.record(z.number()) }), // p718-4 Thu ×2
]);

/* ---------- axis 5: execution rail ---------- */
export const Rail = z.object({
  book: z.enum(['paper-trade', 'positional']).default('paper-trade'),
  /** 'sim' = simulator fill; 'bus' = insert and let the broker daemons act;
   *  'zerodha-direct' = synchronous per-account orders; 'backtest' = replay fill model. */
  mode: z.enum(['sim', 'bus', 'zerodha-direct', 'backtest']).default('bus'),
  /** Where the protective order lives. broker-oco survives a strategy crash; local does not. */
  exitMechanism: z.enum(['local-tick', 'broker-resting-stop', 'broker-oco']).default('local-tick'),
  /** Only meaningful for broker-* mechanisms. */
  correlation: z.object({
    /** ids MUST embed the trading date: legacy hhmmss ids collide across days. */
    scheme: z.literal('tag|date|seq'),
  }).optional(),
  fillSource: z.enum(['optimistic-ltp', 'broker-confirmed', 'simulated-depth']).default('broker-confirmed'),
}).strict();

/* ---------- session (from server/smp/) ---------- */
export const Session = z.object({
  /** IST. In smp these are 21 distinct values, some 1 second apart, staggered on purpose to
   *  spread the login burst. samlion-9/10/11/12 differ ONLY by the hour here. */
  startAt: z.string(),                     // 'HH:mm:ss'
  stopEntriesAt: z.string().optional(),    // 13:31 / 14:00:30 / 14:15
  squareOffAt: z.string(),                 // MANDATORY in the rewrite — no legacy file has it
  cancelRestingAt: z.string().optional(),
  /** Replaces the legacy setTimeout warm-up: gate on DATA, not on wall clock. */
  warmup: z.object({
    requireQuotes: z.enum(['reference', 'reference+legs', 'reference+chain']),
    timeoutMs: z.number().default(60_000),
    onTimeout: z.enum(['skip-day', 'retry', 'alert-and-retry']).default('alert-and-retry'),
  }),
  tradingCalendar: z.literal('NSE-BSE'),   // fixes the holiday retry loop (modern RISK-7)
}).strict();

/* ---------- expiry (owned by nobody today) ---------- */
export const ExpiryPolicy = z.object({
  select: z.enum(['nearest', 'next', 'monthly']).default('nearest'),
  /** Replaces every `moment().day() == 3` literal. Those encode the 2021-2023 BANKNIFTY
   *  Wednesday/Thursday regime and are wrong for the current calendar. */
  rollWhenDaysToExpiryBelow: z.number().int().nullable().default(null),
  rollAtTime: z.string().optional(),       // jaguar rolls at Thu 15:00 without exiting
  /** Chain snapshot pinned for the instance lifetime (legacy behaviour) or refreshed. */
  chainSnapshot: z.enum(['pinned-at-init', 'refresh-daily']).default('refresh-daily'),
}).strict();

/* ---------- risk (all new; defaults reproduce legacy = unbounded) ---------- */
export const Risk = z.object({
  maxLegs: z.number().int().nullable().default(null),
  maxOpenGroups: z.number().int().nullable().default(null),
  maxLotsNet: z.number().int().nullable().default(null),
  dayLossRupees: z.number().nullable().default(null),
  dayProfitRupees: z.number().nullable().default(null),
  /** cp-* uses a NET counter (+1 win / -2 losses), so L,W returns to 0 and trading continues.
   *  Almost certainly unintended — model it explicitly and decide. */
  dayStopCounter: z.object({ mode: z.enum(['net', 'absolute']),
                             winStop: z.number(), lossStop: z.number() }).nullable().default(null),
  maxRolls: z.number().int().nullable().default(null),
}).strict();

/* ---------- data needs (see §5) ---------- */
export const DataNeed = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('index-spot'),     symbol: Underlying, mode: z.enum(['ltp','quote','full']) }),
  z.object({ kind: z.literal('current-future'), symbol: Underlying, mode: z.enum(['ltp','quote','full']) }),
  z.object({ kind: z.literal('option-chain'),   symbol: Underlying,
             expiry: z.enum(['nearest','next','monthly']),
             /** 'atm-window' is the default and what the market-data service should serve;
              *  'all' is the legacy behaviour and is only needed by full-chain scanners. */
             scope: z.union([z.object({ atmWindowStrikes: z.number().int() }), z.literal('all')]),
             mode: z.enum(['ltp','quote','full']) }),
  z.object({ kind: z.literal('instrument'),     token: z.number().int(), mode: z.enum(['ltp','quote','full']) }),
  z.object({ kind: z.literal('candles'),        of: z.enum(['index-spot','current-future','traded-leg']),
             timeframe: z.enum(['1m','3m','5m','15m','60m','1d']),
             lookbackTradingDays: z.number().int() }),
]);

/* ---------- the base every class takes ---------- */
export const BaseConfig = z.object({
  /** Unique. It is the sizing key (account.strategy[tag]), the P&L grouping key, the
   *  order-correlation key and the square-off key. FOUR smp/slive files share 'STGL-25' today —
   *  uniqueness must be enforced at config load. */
  tag: z.string().min(1),
  class: z.string(),                     // one of the 12 class ids
  enabled: z.boolean().default(false),
  /** N processes of one config with independent state (stgl-mid -1..-4, rv-40e1/e2).
   *  Instances get tag suffixes; they are NOT separate config records. */
  instances: z.number().int().default(1),
  underlying: UnderlyingSpec,
  expiry: ExpiryPolicy,
  session: Session,
  sizing: Sizing,
  rail: Rail,
  risk: Risk,
  data: z.array(DataNeed).nonempty(),
  notify: z.object({ onEntry: z.boolean().default(true), onExit: z.boolean().default(true),
                     onError: z.boolean().default(true), channel: z.string().default('SMPAlerts') }),
  /** Free-form provenance so the migration is auditable. */
  legacy: z.object({ files: z.array(z.string()), notes: z.string().optional() }),
}).strict();
```

### 3.2 Per-class extensions

```ts
/* 1 */ export const PremiumLegBookConfig = BaseConfig.extend({
  class: z.literal('premium-leg-book'),
  entrySignal: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('strike-crossover'),
               /** lastQuote starts at 0 in legacy, so the FIRST tick is a synthetic up-cross
                *  and the day's first trade happens then. Make it explicit. */
               enterOnFirstTick: z.boolean().default(true),
               forceFirstEntry: z.boolean().default(false) }),
    z.object({ kind: z.literal('level-recross'), reference: z.literal('entry-time-spot') }),
    z.object({ kind: z.literal('once-at-start') }),
    z.object({ kind: z.literal('fixed-delay-after-flat'), delayMs: z.number() }),   // target-15: 9000
    z.object({ kind: z.literal('clock-schedule'),
               slots: z.record(z.array(z.object({ at: z.string(), stopMultiple: z.number(),
                                                  hedged: z.boolean().default(false) }))) }),
    z.object({ kind: z.literal('premium-limit'), mult: z.number() }),               // p718-7: 0.9
    z.object({ kind: z.literal('premium-vs-vwap'), evalEvery: z.string() }),        // vwap: 3m
  ]),
  strike: StrikeSelector,
  legs: z.array(LegSpec).default([{ type:'CE', side:'SELL' }, { type:'PE', side:'SELL' }]),
  exit: ExitRules,
  reentry: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    /** 'paired' re-sells BOTH legs when EITHER closes -> one-sided pyramiding. It is the
     *  shipped behaviour of 31 lion files; default NEW configs to 'per-leg'. */
    z.object({ kind: z.literal('paired'),  maxLegsPerStrike: z.number().int().default(4) }),
    z.object({ kind: z.literal('per-leg'), maxLegsPerStrike: z.number().int().default(4) }),
    z.object({ kind: z.literal('spot-recross'), freezeStrikes: z.literal(true),
               maxCount: z.number().nullable() }),
    z.object({ kind: z.literal('chain-next-premium-target'), maxGenerations: z.number().int() }),
    z.object({ kind: z.literal('replace-opposite-type') }),
  ]),
  /** One live group per strike level (bull P5). */
  dedupePerStrike: z.boolean().default(true),
});

/* 2 */ export const RollingLegStrangleConfig = BaseConfig.extend({
  class: z.literal('rolling-leg-strangle'),
  otmPoints: z.number().int(),
  rollPoints: z.number().int(),
  rollTrigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('premium-pct'), adverse: z.number(), favourable: z.number() }),
    z.object({ kind: z.literal('realized-vol-rank'), lookback: z.number().int(),
               annualiser: z.number(), evalEvery: z.string() }),   // rv-1: preserve the formula verbatim
    z.object({ kind: z.literal('combined-pct'), value: z.number() }), // tiger-s-5
  ]),
  budget: z.object({ start: z.number().int(), refundOnFavourable: z.boolean(),
                     cap: z.number().int().nullable() }),           // legacy: refund uncapped
  minimumPremium: z.number(),          // retires a leg PERMANENTLY
  blockRollInAcrossAtm: z.literal(true),
  rollPauseMs: z.number().default(0),  // rv-40sl: 5000 between close and re-open
  hedge: z.object({ expiry: z.literal('next'), side: z.literal('opposite') }).nullable().default(null),
});

/* 3 */ export const RungLadderSellerConfig = BaseConfig.extend({
  class: z.literal('rung-ladder-seller'),
  rungs: z.array(z.number().int()).nonempty(),        // [300,400,500] | [150,200,250] | [100,200,300]
  legTypes: z.enum(['otm', 'itm']),
  rollMode: z.enum(['basket', 'per-side', 'translate']),
  rollTriggerRung: z.number().int().default(0),       // which rung the spot must touch
  rearmDebounceMs: z.number().default(500),           // bull-x: the family's only race guard
  maxRolls: z.number().int().nullable(),              // NEW; legacy is unbounded
});

/* 4 */ export const PremiumDistanceAccumulatorConfig = BaseConfig.extend({
  class: z.literal('premium-distance-accumulator'),
  addMode: z.enum(['single', 'pair']),
  premiumFloor: z.number(),                           // 10 (NIFTY) | 20
  /** Entry uses round(); adds use ceil() for CE and floor() for PE. Preserve both. */
  addStrikeRounding: z.literal('far-side'),
  /** add_ce spaces BOTH new triggers by the CE premium (and vice versa). Asymmetric on purpose. */
  triggerSpacing: z.literal('gating-leg-premium'),
  enterOnFirstTick: z.boolean().default(true),
});

/* 5 */ export const MomentumFlipDirectionalConfig = BaseConfig.extend({
  class: z.literal('momentum-flip-directional'),
  instrumentModel: z.enum(['single-leg', 'atm-pair']),
  momentumRef: z.enum(['underlying-vs-open', 'pair-premium-vs-pair-open']),
  bias: z.enum(['fade', 'follow']),                   // fade => SELL, follow => BUY
  strike: StrikeSelector,
  exit: ExitRules,
  flip: z.object({ onStop: z.boolean().default(true),
                   onTarget: z.boolean().default(false),   // asymmetry is deliberate
                   cap: z.number().int().nullable(),        // 3 | 0 | null
                   strikeRef: z.enum(['current-atm', 'frozen-first-atm']),
                   delayMs: z.number().default(0) }),
});

/* 6 */ export const BracketReverseChainConfig = BaseConfig.extend({
  class: z.literal('bracket-reverse-chain'),
  basePriceAfterMs: z.number().default(10_000),
  breakoutPoints: z.number(),                          // 3 | 15 | 20 | 50
  legOnUpMove: z.enum(['CE', 'PE', 'FUT']),
  entrySide: z.enum(['BUY', 'SELL']),
  bracket: z.object({
    stop:   z.union([z.object({ kind: z.literal('pct'), value: z.number() }),
                     z.object({ kind: z.literal('points'), value: z.number() })]),
    target: z.union([z.object({ kind: z.literal('pct'), value: z.number() }),
                     z.object({ kind: z.literal('points'), value: z.number() })]),
    pricedOff: z.literal('actual-fill'),
    lotsMultiplier: z.number().default(1),             // 2 => a fill IS the reversal (fut-100)
  }),
  reverse: z.object({ mode: z.enum(['opposite-option-type', 'double-multiplier']),
                      delayMs: z.number().default(3000) }),
  /** MUST resolve from the tag's account mapping, never a hardcoded ObjectId (legacy RISK-C4). */
  siblingCancel: z.literal('by-tag-on-owning-accounts'),
});

/* 7 */ export const RangeBreakoutDirectionalConfig = BaseConfig.extend({
  class: z.literal('range-breakout-directional'),
  band: z.discriminatedUnion('source', [
    z.object({ source: z.literal('first-candle-pct'), timeframe: z.literal('5m'),
               anchorAt: z.string(), pct: z.number() }),
    z.object({ source: z.literal('atr-anchor'), atrTimeframe: z.literal('60m'),
               atrPeriod: z.number().int(), divisor: z.number(), anchorAt: z.string() }),
    z.object({ source: z.literal('opening-range'), timeframe: z.literal('5m'),
               candles: z.number().int(), bufferPct: z.number() }),
    z.object({ source: z.literal('own-instrument-range'), timeframe: z.literal('15m'),
               premiumRound: z.number(),                 // 25 | 50 | 100
               cushion: z.union([z.object({ kind: z.literal('abs'),  value: z.number() }),
                                 z.object({ kind: z.literal('pct'),  value: z.number() })]) }),
  ]),
  bandAt: z.string(),
  confirm: z.object({ candles: z.number().int().default(1),
                      requireColourMatch: z.boolean().default(false) }),
  rangeFilterPoints: z.number().default(0),             // sticky day-block, BANKNIFTY 250
  executionMapping: z.enum(['atm-option-of-side', 'signal-instrument-itself', 'own-premium-both-sides']),
  allowOpposingEntries: z.boolean().default(false),     // snx-orb ships true — flag it, don't hide it
  exit: ExitRules,
  dayBudget: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('per-day'), n: z.number().int() }),
    z.object({ kind: z.literal('per-side'), n: z.number().int(),
               stopDayOnNonLoss: z.boolean().default(false) }),   // bn-breakout: breakeven counts as a win
  ]),
});

/* 8 */ export const StraddleScalperConfig = BaseConfig.extend({
  class: z.literal('straddle-scalper'),
  atmPolicy: z.enum(['frozen', 'recentre-on-flat', 'per-entry']),
  priceSource: z.literal('mid'),                        // (bestBid+bestAsk)/2 — requires depth
  offsets: z.array(z.number().int()).default([0]),      // [0] | [-100,0,100] | CE[100]/PE[-100]
  legs: z.object({ callOffsets: z.array(z.number().int()).optional(),
                   putOffsets:  z.array(z.number().int()).optional() }).optional(),
  target: z.object({ points: z.number(), escalatePerCycle: z.number().default(0) }),
  averaging: z.object({ enabled: z.boolean(), trigger: z.number(),
                        maxSteps: z.number().int(), nextQty: z.enum(['n+1','x2']),
                        targetDecayPct: z.number() }).nullable(),
  timeStopSeconds: z.number().nullable(),               // 30 | 120 | null
  reentry: z.object({ delayMs: z.number(), direction: z.enum(['same','flip-on-stop']) }),
  lotAccounting: z.enum(['averaged', 'independent']),
});

/* 9 */ export const SpreadLadderEngineConfig = BaseConfig.extend({
  class: z.literal('spread-ladder-engine'),
  legSource: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('static-config'), legs: z.array(LegSpec).nonempty() }),
    z.object({ kind: z.literal('atm-relative-scan'),
               side: z.enum(['CE','PE']),
               ladder: z.object({ nearFrom: z.number().int(), nearCount: z.number().int(),
                                  minGap: z.number().int(), farMax: z.number().int() }),
               ratio: z.number().int(),
               entryBand: z.object({ max: z.number(), min: z.number(),
                                     relaxMaxAfterFirstFill: z.boolean() }),
               /** Legacy comparator is inverted (picks the rung CLOSEST to ATM). Fix + retune. */
               rank: z.enum(['farthest-from-atm', 'closest-to-atm', 'legacy-buggy']) }),
  ]),
  pricing: z.literal('adverse-depth-l1'),               // ask to buy, bid to sell — modeFull required
  ladder: z.object({ perTrade: z.number(), total: z.number(),
                     leap: z.number(), thresholdJump: z.number().default(0) }),
  takeProfitPoints: z.number(),
  persistState: z.object({ debounceMs: z.number() }).nullable(),   // legacy 3000; make it synchronous
});

/* 10 */ export const IndicatorFlipStructureConfig = BaseConfig.extend({
  class: z.literal('indicator-flip-structure'),
  indicator: z.object({ kind: z.literal('supertrend'), period: z.number().int(), mult: z.number() }),
  series: z.discriminatedUnion('kind', [
    /** high = low = close = closeCE + closePE. ATR degenerates to mean absolute change.
     *  Re-deriving with real OHLC changes every signal. */
    z.object({ kind: z.literal('synthetic-pair-premium'), timeframe: z.literal('3m'),
               lookbackTradingDays: z.number().int(), alignByTimestamp: z.literal(true) }),
    z.object({ kind: z.literal('instrument-candles'), of: z.literal('current-future'),
               timeframe: z.literal('5m'), lookbackTradingDays: z.number().int() }),
  ]),
  evalEvery: z.string(),
  structure: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('short-strangle'), widthPoints: z.number().int() }),
    z.object({ kind: z.literal('credit-spread-with-wing'), hedgeWidthPoints: z.number().int() }),
  ]),
  onFlip: z.enum(['flat', 'reverse']),
  lockStrikesWhileInTrade: z.boolean().default(true),
  exit: ExitRules,                                       // p718-2/3: combined +30, disarmOnFire
  cumulativeLossPoints: z.number().nullable(),           // p718-2/3: 80
});

/* 11 */ export const ChainScanBreakoutConfig = BaseConfig.extend({
  class: z.literal('chain-scan-breakout'),
  mode: z.enum(['buy-breakout', 'sell-open-is-high']),
  band: z.union([z.tuple([z.number(), z.number()]),
                 z.record(z.tuple([z.number(), z.number()]))]),   // fixed or per-weekday
  bandInclusive: z.boolean(),
  breakoutMult: z.number().default(1.5),
  exit: ExitRules,
  caps: z.object({ onePerOptionType: z.boolean(), maxPerStrikePerDay: z.number().int(),
                   /** legacy increments the counter BEFORE the cap test AND on rejected
                    *  attempts => effective cap is one lower and inflated. Fix deliberately. */
                   countRejectedAttempts: z.boolean().default(false) }),
});

/* A1 */ export const ExternalSignalMirrorConfig = z.object({
  kind: z.literal('signal-source'),
  adapter: z.literal('optionbhai-ws'),
  destinationTag: z.string(),
  credentialsRef: z.string(),           // secret store key — NEVER inline (3 files leak them today)
  instrumentRefreshMinutes: z.number().default(15),
  onUnknownSymbol: z.enum(['drop-and-alert', 'throw']).default('drop-and-alert'),
});
```

### 3.3 Config-load-time assertions (non-negotiable)

1. `tag` unique across every enabled config (four files share `STGL-25` today).
2. `underlying.strikeStep` matches the instrument master's actual strike grid — reject
   `NIFTY/100`, `MIDCPNIFTY/50`.
3. `session.squareOffAt` present and ≥ 60 s before the exchange cut-off.
4. `rail.exitMechanism !== 'local-tick'` **or** `session.squareOffAt` is owned by the runner —
   a local stop dies with the process.
5. `sizing.kind !== 'flat'` requires a non-null `risk.maxLotsNet` (kills the uncapped martingale
   and the 1023-lot doubling ladder by construction).
6. Any `exit.stop.basis === 'none'` config must set `risk.dayLossRupees` explicitly (even to
   `null`) so "no stop anywhere" is a reviewed decision, not an omission.

---

## 4. `StrategyBase` — the lifecycle the runner hosts

Generalised from `server/slive/{bn-breakout, orb-fut-core, orb-scalp, atr-band-nifty}.js` — the
only files in the estate with a pure-logic/IO split and tests. **Every dependency is injected**,
which is what makes the same class runnable live, in the simulator, and in the backtester.

### 4.1 Injected services

```ts
/** Identical object graph in live and replay. Nothing below reads a global clock or a socket. */
export interface StrategyContext {
  clock: Clock;
  md: MarketData;
  instruments: Instruments;
  orders: OrderGateway;
  fills: FillStream;
  state: StateStore;
  notify: Notifier;
  log: Logger;
  metrics: Metrics;
}

export interface Clock {
  now(): DateTime;                 // IST-aware; in backtest it is the replay cursor
  istMinutes(): number;
  isTradingDay(d: DateTime): boolean;                 // holiday calendar — fixes the 30 s retry loop
  at(t: TimeOfDay, fn: () => Promise<void>): Disposable;   // replaces CronJob
  after(ms: number, fn: () => void): Disposable;           // replaces setTimeout
  /** Deadlines, not timers: `deadline(entryTime + 90min)` survives a restart. Timers do not. */
  deadline(at: DateTime, fn: () => Promise<void>): Disposable;
}

export interface MarketData {                          // §5 — one shared bus for the whole runner
  quote(token: number): Quote | undefined;             // {ltp, ohlc, depth?, vwap?, ts}
  ltp(token: number): number | undefined;
  mid(token: number): number | undefined;              // (bid0+ask0)/2, falls back to ltp
  depth(token: number, level: number): DepthLevel | undefined;
  /** Timestamp-anchored, never `candles[length-1]`. Fixes modern RISK-1 across the estate. */
  lastClosedCandle(token: number, tf: Timeframe, at?: DateTime): Promise<Candle | undefined>;
  candles(token: number, tf: Timeframe, fromTradingDays: number): Promise<Candle[]>;
  /** Resolves when every token has produced at least one quote, or rejects on timeout. */
  awaitQuotes(tokens: number[], timeoutMs: number): Promise<void>;
  hasQuote(token: number): boolean;
}

export interface Instruments {
  chain(u: Underlying, expiry: ExpirySelect): OptionChain;   // dated; refuses a stale snapshot
  option(u: Underlying, strike: number, type: 'CE'|'PE',
         expiry: ExpirySelect): Instrument | undefined;      // nearest-listed fallback ladder
  currentFuture(u: Underlying): Instrument;
  daysToExpiry(u: Underlying, expiry: ExpirySelect): number; // replaces every moment().day()==3
  atmStrike(u: Underlying, price: number): number;
}

export interface OrderGateway {
  /** MUST actually await the write and surface failures (fixes the fire-and-forget
   *  trackOrder/create bug that makes "flag only after a successful order" untrue). */
  market(o: { instrument: Instrument; side: Side; lots: number; corr: CorrelationId }): Promise<OrderAck>;
  stopMarket(o: { instrument: Instrument; side: Side; lots: number; stopPrice: number;
                  corr: CorrelationId }): Promise<OrderAck>;
  limit(o: { instrument: Instrument; side: Side; lots: number; limitPrice: number;
             corr: CorrelationId }): Promise<OrderAck>;
  cancel(corr: CorrelationId): Promise<void>;
  /** Cancel-then-replace. Never mutate a resting order's ledger row and call it closed —
   *  that is the lion sub-mode B orphaned-stop bug, and bus consumers only watch inserts. */
  replaceStop(corr: CorrelationId, newStopPrice: number): Promise<OrderAck>;
  /** Reconciliation source of truth on restart. */
  openPositions(tag: string): Promise<Position[]>;
  restingOrders(tag: string): Promise<RestingOrder[]>;
}

export interface FillStream {
  /** In live: the broker order-update feed. In backtest: synthesised by the fill model.
   *  Status is normalised — no more comparing against the exact string 'Filled'. */
  on(cb: (e: { corr: CorrelationId; status: 'FILLED'|'REJECTED'|'CANCELLED'|'PARTIAL';
               price: number; lots: number; ts: DateTime }) => void): Disposable;
}

export interface StateStore {   // keyed (tag, tradingDate); written on EVERY state transition
  load<T>(key: string): Promise<T | undefined>;
  save<T>(key: string, v: T): Promise<void>;
}
```

### 4.2 The contract

```ts
export abstract class StrategyBase<C extends BaseConfig, S> {
  constructor(protected readonly cfg: C, protected readonly ctx: StrategyContext) {}

  /** 1. Declare data needs. Called BEFORE init, by the market-data service, to build the
   *     deduplicated subscription set (§5). Pure — no IO. */
  abstract dataNeeds(): DataNeed[];

  /** 2. Idempotent. Resolve instruments, restore persisted state, reconcile against the
   *     broker book. `init()` must be safe to call twice and must set `started=false` on
   *     failure so the runner can retry. */
  abstract init(): Promise<void>;

  /** 3. Named, declarative phases. The host schedules them AND replays any whose time is
   *     already past for today (mid-session restart), in order, before arming the rest. */
  abstract phases(): Phase[];

  /** 4. Tick path. PURE and SYNCHRONOUS: reads only the quote snapshot and `this.state`,
   *     returns intents. It never places an order and never awaits. */
  abstract onTick(t: Tick): Intent[];

  /** 5. Candle path. Runs on the strategy's serial lane; may fetch history. */
  onCandleClose?(c: Candle): Promise<Intent[]>;

  /** 6. Fill path. Advances the order state machine for broker-driven classes. */
  onFill?(e: FillEvent): Promise<Intent[]>;

  /** 7. Forced flat. Called by the runner at `session.squareOffAt`, on a risk breach, and on
   *     graceful shutdown. Must be idempotent and must yield to an in-flight exit. */
  abstract squareOff(reason: ExitReason): Promise<void>;

  /** 8. Independent stop/reset. `stop()` disarms entries and disposes phases but leaves the
   *     book; `reset()` clears the day's counters. Neither touches other strategies. */
  async stop(): Promise<void> { /* base impl */ }
  async reset(): Promise<void> { /* base impl */ }

  /** Serialisable, versioned. This IS the restart contract. */
  abstract snapshot(): S;
  abstract restore(s: S): void;
}

export type Phase = {
  name: string;
  at: TimeOfDay;
  run(): Promise<void>;
  /** Top-of-function guard so a replay + a cron fire are idempotent. */
  isDone(): boolean;
  retry: { everyMs: number; maxAttempts: number };   // legacy retried forever — cap it
  replayOnLateStart: boolean;
};

export type Intent =
  | { kind: 'ENTER'; legs: LegOrder[]; groupId: string; meta: object }
  | { kind: 'EXIT';  groupId: string; legs?: LegOrder[]; reason: ExitReason }
  | { kind: 'ARM_STOP';    groupId: string; legId: string; price: number }
  | { kind: 'REPLACE_STOP';groupId: string; legId: string; price: number }
  | { kind: 'CANCEL';      corr: CorrelationId }
  | { kind: 'NOOP_WAITING'; reason: 'quote-missing' | 'instrument-missing' };
```

### 4.3 What the base class enforces (so 12 classes don't each re-implement it)

1. **Synchronous position state machine.** `IDLE → PENDING → ACTIVE → CLOSING → CLOSED`.
   The transition to `CLOSING` is applied *before* the awaited broker call. This is the
   claim-before-await guard that every single family spec calls out as the only thing
   preventing duplicate exits (`delete optionOrders[idx]`, `exitInProgress = true`,
   `position.status='CLOSING'`, `positions.splice`). It is base-class behaviour, not
   strategy behaviour.
2. **One serial lane per strategy instance** for anything that fetches history or emits orders.
   `onTick` runs synchronously and returns intents; the lane executes them. This removes the
   `async.queue(fn,1)` + `forEach(async …)` combination that voids serialisation today, and the
   missing `.catch` that permanently wedges a concurrency-1 queue (the single most common
   critical bug in the estate — it appears in **every** family spec).
   Lanes are bounded: on backlog, drop stale tick tasks and count them; never grow unbounded.
3. **Preconditions before intents are accepted.** Every instrument the strategy prices must
   have a quote. A missing quote yields `NOOP_WAITING` — which does **not** consume the day
   budget, does not burn a one-shot flag, and is retried on the next evaluation. This replaces
   both legacy failure modes (throw-and-die, or silent permanent skip).
4. **Budget counters move on the broker acknowledgement, never on the intent.**
5. **Fill events are status-checked and idempotent per logical leg**, not per broker order.
   One logical entry fans out across accounts and tranches with the *same* identifier, so the
   consume must be synchronous and one-shot. `REJECTED` must be handled explicitly — today a
   rejected stop is booked as a fill at price 0, and a rejected entry leaks its trigger forever.
6. **Correlation ids embed the trading date** (`tag|YYYYMMDD|seq`). Legacy per-process counters
   restart at 0 and legacy `hhmmss` ids are 12-hour with no date, so both collide with the
   previous run's still-live broker orders.
7. **Persisted state keyed by `(tag, tradingDate)`**, written on every transition and reloaded
   in `init()`. On start the runner reconciles `snapshot()` against `orders.openPositions(tag)`
   and `orders.restingOrders(tag)`; a mismatch is an alert, not a silent re-arm. This is the
   fix for the biggest structural gap in the estate: today a mid-session restart orphans open
   positions *and* re-enters.
8. **Duration-based stops are deadlines, not `setTimeout`s**, so a 90-minute time stop survives
   a restart.
9. **Mandatory `session.squareOffAt` owned by the runner.** No legacy family has an EOD flatten;
   several `process.exit()` on a live book. The runner flattens, then waits for order
   acknowledgements, then stops — it never exits with writes in flight.
10. **Exit precedence is declared and evaluated against one price snapshot**, with explicit
    strict/non-strict flags per comparison.
11. **Pure decision modules stay pure.** `wilderATR`, `entrySignal`, `computeRange`,
    `breakoutSide`, `evaluateExit`, `target`, `stopHitOnClose`, `realizedVolatility`,
    `syntheticAtm`, `spreadPrice` port over dependency-free. The existing 50 tests in
    `server/test/` port first and must keep passing.

### 4.4 Backtest equivalence

The only difference between live and replay is which implementations are injected:

| service | live | backtest |
|---|---|---|
| `Clock` | IST wall clock + timers | replay cursor; `at`/`after`/`deadline` fire off simulated time |
| `MarketData` | shared tick bus (§5) | historical tick/candle replay through the identical `Quote` shape |
| `OrderGateway` | `paper-trade` / `positional` insert, or Zerodha direct | in-memory book |
| `FillStream` | broker order-update feed | fill model, which **must reproduce** `lib/fill-price.js`: depth level 5 (`bidAsk=4`) when its price > 50, else LTP, else the ₹0.05 fallback — otherwise recorded paper history will not reconcile |
| `StateStore` | Mongo | in-memory |

Because `onTick` is pure and synchronous and every decision module is dependency-free, a
strategy is fully deterministic given `(config, tick sequence, fill sequence)`.

---

## 5. Subscription grouping and the shared market-data service

### 5.1 The problem being solved

Today each of ~290 processes performs its **own** Zerodha login (mutating and saving the *same*
master `Account` document — a lost-update race), opens its **own** `KiteTicker`, and subscribes
the **entire** option chain in `modeFull`. Every family spec independently names this as the
strongest argument for a shared bus. Kite's limits (3 connections per api_key, 3 000 tokens per
connection) are already exceeded by a wide margin.

### 5.2 How a strategy declares what it needs

A strategy declares `DataNeed[]` **symbolically** — never token numbers — via `dataNeeds()`,
which is pure and is called before `init()`:

```ts
// PremiumLegBook on BANKNIFTY, ATM straddle seller
dataNeeds() {
  return [
    { kind: 'index-spot',   symbol: 'BANKNIFTY', mode: 'ltp' },
    { kind: 'option-chain', symbol: 'BANKNIFTY', expiry: 'nearest',
      scope: { atmWindowStrikes: 10 }, mode: 'quote' },
  ];
}

// SpreadLadderEngine needs depth, and a wide window (rungs run 5..17 strikes out)
dataNeeds() {
  return [
    { kind: 'index-spot',   symbol: 'BANKNIFTY', mode: 'ltp' },
    { kind: 'option-chain', symbol: 'BANKNIFTY', expiry: 'nearest',
      scope: { atmWindowStrikes: 20 }, mode: 'full' },
  ];
}

// ChainScanBreakout is the only class that legitimately needs the whole chain
dataNeeds() {
  return [{ kind: 'option-chain', symbol: 'BANKNIFTY', expiry: 'nearest',
            scope: 'all', mode: 'quote' }];
}
```

### 5.3 The market-data service

```
                strategies (N instances)
                   |  dataNeeds()  (symbolic)
                   v
        +-------------------------------+
        | SubscriptionRegistry          |   per-token refcount + max(mode)
        |  resolve(need) -> token[]     |   symbolic -> tokens via Instruments
        |  add/remove(strategyId)       |   diffed on ATM drift & expiry roll
        +-------------------------------+
                   |  union token set, grouped by underlying
                   v
        +-------------------------------+
        | FeedConnections               |   1..3 KiteTicker sockets, one login
        |  pack(tokens) -> connections  |   packed BY GROUP so a group never straddles
        |  setMode(full|quote|ltp)      |   a socket boundary
        +-------------------------------+
                   |  raw ticks
                   v
        +-------------------------------+
        | TickBus                       |   normalise -> QuoteCache (token -> Quote)
        |  QuoteCache (authoritative)   |   fan out per-token to subscriber lanes
        |  fanout: token -> lane[]      |   ordered per strategy, batched per tick frame
        +-------------------------------+
```

**Grouping.** A *group* is one underlying: `NIFTY`, `BANKNIFTY`, `SENSEX`, `FINNIFTY`,
`MIDCPNIFTY`, and one group per stock (`RELIANCE`, `HDFCBANK`, …). A group owns:
its index/spot token, its current-future token, and its option chains by expiry. Groups are the
unit of packing onto sockets, of expiry rollover, and of health monitoring ("BANKNIFTY group is
stale" is actionable; "token 260105 is stale" is not).

**Deduplication rules.**
1. Resolve every `DataNeed` to a token set through `Instruments` (symbolic → tokens), so two
   strategies asking for "BANKNIFTY nearest chain, ATM ±10" resolve to the *same* tokens.
2. Refcount per `(token, mode)`. The subscribed mode is `max(mode)` over subscribers
   (`ltp < quote < full`) — one depth-hungry `SpreadLadderEngine` upgrades a token for
   everyone, and downgrades when it stops.
3. Subscribe the union once. Unsubscribe only when the refcount hits 0 **and** a grace period
   (30 s) has passed, so an ATM oscillation does not thrash the socket.
4. `scope:'all'` is a privileged declaration: it is allowed, logged at warn, and counted, because
   it is what makes token budgets explode. Only `ChainScanBreakout` uses it.

**ATM-window maintenance.** Each group tracks its own ATM from its spot/future quote. When the
ATM moves by ≥1 strike, the registry recomputes each subscriber's window, diffs it, and issues
one incremental `subscribe`/`unsubscribe`. This is what replaces "subscribe the whole chain at
boot and hope". It also removes the family-wide bug where a rolled/laddered strike walks outside
the boot-time snapshot and every lookup returns `undefined`.

**Token budget** (why this scales to 5–10 stocks):

| group | ATM ±10 strikes, both types | full chain (legacy) |
|---|---|---|
| BANKNIFTY | 42 | ~180 |
| NIFTY | 42 | ~350 |
| SENSEX | 42 | ~200 |
| each stock | ~22 | ~80 |

Three indices + 10 stocks on windows ≈ **350 tokens**, versus ≈ **1 500** on full chains, versus
≈ **50 000 token-subscriptions** across today's 290 sockets. One connection suffices; a second is
a hot standby. `modeFull` is reserved for tokens whose subscribers actually need depth
(`SpreadLadderEngine`, `StraddleScalper`, and the simulator's fill model), which is the dominant
bandwidth cost.

**Delivery.** The bus writes the `QuoteCache` first, then fans out. Each strategy instance has an
ordered lane; a tick frame is delivered as one batch so `onTick` sees a consistent snapshot
(this preserves the legacy "one task per tick batch" semantics without the wedging failure mode).
Lane delivery is per-strategy, so a slow strategy cannot delay another, and a crashed strategy is
unsubscribed without touching the socket.

**Expiry roll.** The group owns it. On roll, the registry re-resolves every `option-chain` need,
diffs, and notifies subscribers via `onChainRoll(oldChain, newChain)` so a strategy can decide
whether to roll its open legs (`jaguar` does; nothing else in the estate does, and that is a
latent overnight-risk bug in a long-lived runner).

**Instrument master.** One dated fetch per trading day, validated (`expiry >= today`), shared by
every group. The legacy `require('optionConfig_<UND>.json')` cache with no freshness check —
which silently trades expired tokens all day — is deleted.

---

## 6. Migration ledger

Every one of the 290 files appears below. Files that are byte-identical apart from
`strategyTag` share **one config record with N instances** and are listed on one row with all
filenames named, so nothing is dropped silently. Config names are
`<class-slug>/<underlying>-<variant>`.

### 6.1 `server/slive/` — 156 files

#### → `PremiumLegBook` (73 files)

| legacy file(s) | config name | key config | note |
|---|---|---|---|
| `lion-0020`, `lion-1789`, `lion-m6000`, `lion-zzj11574`, `lion-zzJ4351`, `lion-zzJ4351-2`, `lion-zzJ4351-3`, `lion-zzJ4351-4` | `plb/bn-atm-straddle-125-brokerstop` ×8 instances | crossover · atm-offset 0 · per-leg-pct 1.25 · paired · broker-resting-stop | 8 files, identical but for the tag (client codes) |
| `lion-s15-zzJ4351` | `plb/bn-atm-straddle-115-brokerstop` | as above, pct **1.15** | |
| `biglion-0020` | `plb/bn-atm-ladder4-125-brokerstop` | wings `[0,100,200,300]`, 4 pairs | counts `positionsOpen` in 4s |
| `jk-0020`, `jk-zzJ4351` | `plb/bn-atm-straddle-125-brokerstop-perleg` ×2 | reentry **per-leg** | the strictly-better re-entry dialect |
| `lion-s25-1`, `lion-fs25-1`, `lion-fs25-2`, `lion-ms25-1`, `lion-ms25-2`, `lion-ns25-1`, `jk-m6000` | `plb/{bn,fin,midcp,nifty}-atm-straddle-125-oco` ×7 | per-leg-pct 1.25 · `exitMechanism:'broker-oco'` | legacy sub-mode B **orphans its resting stop** — port as cancel-then-replace (§7 F4) |
| `lion-s25-2` | `plb/bn-fut-atm-straddle-125-tick` | reference **current-future** | the only `autostart:true` lion; futures basis shifts the ATM |
| `lion-s25-3`, `lion-s25-2e`, `lion-s25-3e`, `lion-ns25-2`, `lion-snx-1` | `plb/{bn,nifty,snx}-atm-straddle-125-tick` ×5 | tick-monitor exit | |
| `lion-b25-1` | `plb/bn-atm-straddle-long-tgt125` | side **BUY**, "stop" is a **target** | rename the field; it has no stop |
| `lion-sp5-1` | `plb/bn-atm-straddle-combined-tgt095` | combined-pct 0.95 = **+5 % take-profit**, no stop | |
| `lion-up-1` | `plb/bn-atm-directional-prevclose` | side = `strike > prevClose ? BUY : SELL`; long branch target 1.05 | |
| `lion-st15-1`, `lion-st15-2`, `lion-st15-3`, `lion-st15-0020`, `lion-st15-1789` | `plb/bn-atm-straddle-trail15` ×5 | per-leg-trailing-pct 0.15 | |
| `lion-st25-1` | `plb/bn-atm-straddle-trail25` | trailing 0.25 | |
| `samlion-9`, `samlion-10`, `samlion-11`, `samlion-12` | `plb/bn-wing-ladder-10pair-125` ×4 | once-at-start · wings `[0..900]` · reentry none | **exit is broken today** (`ce_option`/`pe_option` never stored) — fix on port |
| `stgl-mid-0020-2`, `stgl-mid-0020-3`, `stgl-mid-2117-1`, `stgl-mid-2117-2`, `stgl-mid-2117-3` | `plb/bn-prem250-recross` ×5 | nearest-premium `[250]` · missingQuoteDistance 250 · spot-recross, frozen strikes | |
| `stgl-mid-0020-4`, `stgl-mid-2117-4` | `plb/bn-prem250-recross-fb230` ×2 | missingQuoteDistance **230** | lone typo; keep as its own record until reviewed |
| `stgl-mid-0020-1`, `stgl-mid-3` | `plb/bn-prem250-recross` (merged) ×2 | — | legacy selector returns `NaN` for every strike (async fn) → sells the first CE/PE in chain order. **Bug, not config**: migrate onto the corrected selector and expect different strikes |
| `stgl-p-2117` | `plb/bn-prem-ladder-250-200-150` | chain-next-premium-target, 3 generations · combined-pct 1.25 | |
| `stgl-p-2203` | `plb/bn-prem-ladder-250-200-150-cron` | as above · `startAt 09:16:50` · no expiry roll | |
| `stgl-s`, `stgl-s2` | `plb/bn-wings-100-400-125` ×2 | once-at-start · wings `[100,200,300,400]` · resting SLM off pre-trade LTP | |
| `stgl-sm` | `plb/bn-wings-100-200-x2-fillstop` | wings `[100,200]`, rounds 2 · stop off the **actual fill** | the reference pattern for the new stop machine; its `remove_position` branch always throws today |
| `bull-s-1` | `plb/bn-fut-atm-straddle-125-pyramid` | reference **current-future** · pyramid +1 uncapped | |
| `bull-s-2` | `plb/bn-atm-straddle-125-pyramid` | spot reference | only difference from `bull-s-1` |
| `bull-s5-1`, `bull-s5-2` | `plb/bn-atm-straddle-105-pyramid` ×2 | combined-pct **1.05** | |
| `bull-ns-1`, `bull-ns-2` | `plb/nifty-atm-straddle-125-pyramid` ×2 | step 50 | |
| `bull-fs-1`, `bull-fs-2` | `plb/fin-atm-straddle-125-pyramid` ×2 | | expiry may no longer exist — verify before enabling |
| `bull-ms-1`, `bull-ms-2` | `plb/midcp-atm-straddle-125-pyramid` ×2 | **strikeStep 25**, not 50 | legacy uses 50 and misses half the strikes |
| `bull-snx-1` | `plb/snx-atm-straddle-125-pyramid` | | |
| `bull-r` | `plb/bn-atm-straddle-125-pyramid-down` | sizing 7→0, entry gated on `size>0` | safe-by-construction mirror of the above |
| `bull-200-1` | `plb/bn-prem-200-160-130-100-flip` | nearest-premium `[200,160,130,100]` · per-leg +50 pts · reentry `replace-opposite-type` | keep `replacementSide` explicit (intent unresolved) |
| `dolphin-0020` | `plb/bn-grid200-otm200-tgt70` | crossover · **gridStep 200 ≠ strikeStep 100** · offset 200 · combined-points 70 · no stop | |
| `nifty-s-1789`, `nifty-s-sbm95` | `plb/nifty-grid50-atm-tgt25` ×2 | gridStep 50 · combined-points 25 · no stop | |
| `target-15` | `plb/bn-fut-atm-straddle-tgt15pct` | fixed-delay-after-flat **9000 ms** · per-leg-pct-of-combined 0.015 · no stop | comment says 3 s; it is 9 s |
| `p718-4` | `plb/bn-clock-slots-20-slm` | clock-schedule (20 slots/weekday, per-slot stop multiple 1.1–2.0) · Thu qty 2 + ±1000 wings · SLM on fill | **SLM qty mismatch on Thu/Wed is a money bug** — fix on port |
| `p718-5` | `plb/bn-clock-slots-4-maxpain` | clock-schedule (4 slots) · max-pain-side single leg | **undeclared `optionOrders` + stop compares premium to a multiplier** — reimplement, do not transliterate |
| `cal-ce`, `cal-pe` | `plb/bn-calendar-atm` ×2 | clock 09:25 one-shot · legs `[{nearest,BUY},{next,SELL}]` · exit none | short calendar; subscribe both legs (legacy cannot mark its own P&L) |

#### → other classes (79 files)

| class | legacy file(s) | config name | note |
|---|---|---|---|
| `RollingLegStrangle` | `rv-40`, `rv-40e1`, `rv-40e2` | `rls/bn-otm100-140-050` (e1/e2: `otm 0`, ×2 instances) | 1.40/0.50, budget 2 |
| | `rv-2`, `rv-s2` | `rls/bn-otm100-125-060`, `…-nextweek` | budget 3; `rv-s2` trades the next-week chain |
| | `rv-25n`, `rv-40n` | `rls/nifty-otm50-125-060`, `rls/nifty-otm50-140-050` | floor ₹5 |
| | `rv-40sl` | `rls/bn-otm100-140-050-breaker` | portfolio breaker −1200 · `rollPauseMs 5000` · the only Zerodha-direct file in rv |
| | `rv-1` | `rls/bn-otm100-rv-rank` | rollTrigger `realized-vol-rank`; **inert today** (compares a pair against itself on the first run) — fix behind a flag |
| `RungLadderSeller` | `bull-300`, `bull-300i` | `rls-ladder/bn-300-400-500-{otm,itm}` | basket recentre |
| | `bulln-300`, `bulln-300i` | `rls-ladder/nifty-150-200-250-{otm,itm}` | |
| | `bull-m`, `bull-m2` | `rls-ladder/bn-100-200-300-perside` ×2 | **per-side roll orphans 3 short legs per roll** — fix on port |
| | `bull-x` | `rls-ladder/bn-translate-300` | 3 straddles, translate one rung, 500 ms re-arm debounce |
| `PremiumDistanceAccumulator` | `eagle-s-2`, `eagle-s-3`, `eagle-s-4` | `pda/bn-spot-floor20` ×3 | |
| | `eagle-s-1` | `pda/bn-fut-floor20` | reference **current-future** — materially different ATM |
| | `eagle-p-1` | `pda/bn-spot-floor20-pair` | `addMode:'pair'` + the (obsolete) Wednesday roll |
| | `eagle-ns-1`, `eagle-ns-2` | `pda/nifty-floor10` ×2 | floor ₹10 |
| | `eagle-fs-1`, `eagle-fs-2` | `pda/fin-floor20` ×2 | simulator books these at ₹0.05 — recorded P&L is meaningless |
| | `eagle-ms-1`, `eagle-ms-2` | `pda/midcp-floor20` ×2 | same; also strikeStep should be 25 |
| | `eagle-snx-1` | `pda/snx-floor20` | |
| `MomentumFlipDirectional` | `cheetah-1910`, `cheetah-1911` | `mfd/bn-fade-trail60-loss2500` ×2 | live loss breaker −2500 |
| | `cheetah-1963`, `cheetah-st-60` | `mfd/bn-fade-trail60` ×2 | breaker present but `checkPNL()` commented out — dead |
| | `cheetah-stp-2117` | `mfd/bn-fade-prem250-trail60` | strike by nearest-premium ₹250 |
| | `cheetah-bt-2117` | `mfd/bn-follow-trail60-profit2500` | bias **follow** (BUY) |
| | `cheetah-s-2203` | `mfd/bn-fade-fixed30` | |
| | `cheetah-2117` | `mfd/bn-fade-fixed30-slm-cap3` | broker SLM · flip cap 3 |
| | `cheetah-2204`, `cheetah-0042` | `mfd/bn-fade-fixed30-slm-noreentry` ×2 | re-entry block commented out; `executeSL` never matches (no token) |
| | `cheetah-b1-2117` | `mfd/bn-follow-fixed10-martingale-uncapped` | **uncapped martingale** — must get `risk.maxLotsNet` |
| | `cheetah-b1-1`, `cheetah-b1-2` | `mfd/bn-fut-follow-fixed10-tgt90-cap12` ×2 | frozen first-tick ATM · goes idle after a target |
| | `cheetah-b1-snx` | `mfd/snx-follow-fixed10-tgt90-cap12` | |
| | `fox-1` | `mfd/bn-pair-trail60-cap6` | `instrumentModel:'atm-pair'`, `momentumRef:'pair-premium-vs-pair-open'`; `maxOrderCount` counts exits too; the `mul=0` branch places nothing |
| `BracketReverseChain` | `cp-s-2040`, `cp-ns-2040`, `cp-snx-2040` | `brc/{bn,nifty,snx}-b20-120-060` ×3 | `legOnUpMove PE`; NIFTY needs step 50 |
| | `cp-s-030`, `cp-snx-030` | `brc/{bn,snx}-b3-103-097` ×2 | 3 index points ≈ noise — effectively enters at T+15 s |
| | `cp-s-010` | `brc/bn-b3-103-099` | R:R 1:3 |
| | `cp-rs-030` | `brc/bn-b3-103-097-fade` | `legOnUpMove CE` |
| | `cp-s-3370` | `brc/bn-b50-pts33-70` | absolute-point bracket; filename lies about its side |
| | `cp-b-2040` | `brc/bn-b20-long-080-140` | the only long variant |
| | `fut-100` | `brc/bn-fut-b15-sl50-tgt100-x2` | trades the **future**; bracket `lotsMultiplier 2` so a fill is the reversal; hardcoded lot_size 30 and hardcoded XTS account id must both become config |
| `RangeBreakoutDirectional` | `bn-breakout` | `rbd/bn-firstcandle-pct09-opt` | 1 trade **per side**, a non-loss ends the day |
| | `atr-band-nifty` | `rbd/nifty-atr14-div3-opt` | candle-close stop, 2-candle colour confirm |
| | `orb-scalp` (3 instances in one process) | `rbd/{bn,nifty,snx}-orb6-opt` | shared process, isolated per-underlying state |
| | `orb-fut-bn`, `orb-fut-nifty`, `orb-fut-snx` | `rbd/{bn,nifty,snx}-orb6-fut` ×3 | `executionMapping:'signal-instrument-itself'` |
| | `snx-orb-1` | `rbd/snx-ownpremium-round100-abs11` | risk-based sizing, ₹20 000/side |
| | `snx-orb-25`, `snx-orb-50` | `rbd/snx-ownpremium-round{25,50}-pct1` ×2 | parameterised descendants of `-1` |
| `StraddleScalper` | `bn-hft` | `ss/bn-atm-tgt10-noavg` | ships with averaging **off** (`maxSteps 1`) |
| | `hft-nifty` | `ss/nifty-atm-tgt5-noavg` | strikeStep must become 50 |
| | `hft-averaging` | `ss/snx-atm-tgt10-noavg` | |
| | `hft-multi` | `ss/snx-multi-tgt10-avg10` | `offsets [-100,0,100]`, averaging live |
| | `hft-snx-sell` | `ss/snx-atm-tgt10-sl20-reversal` | stop → **naked short straddle**; needs a hard loss breaker |
| `SpreadLadderEngine` | `ce-d2-0020`, `pe-d2-0020` | `sle/bn-{ce,pe}-ratio2-budget20-tp15` ×2 | |
| | `ce-d2-extra`, `pe-d2-extra` | `sle/bn-{ce,pe}-ratio2-budget50-tp15` ×2 | |
| | `ce-d2p-extra`, `pe-d2p-extra` | `sle/bn-{ce,pe}-ratio2-budget20-tp25-positional` ×2 | `book:'positional'` (carries overnight) + persisted state |
| `IndicatorFlipStructure` | `p718-1` | `ifs/bn-supertrend-strangle-100-nostop` | no stop at all |
| | `p718-2`, `p718-3` | `ifs/bn-supertrend-strangle-{200,300}-stop30` ×2 | one-shot stop disarm + cumulative 80-pt breaker |
| `ExternalSignalMirror` | `candlestrategy`, `candlestrategy-a006`, `candlestrategy-test3` | `mirror/optionbhai-{1pbuy,a006,ema2050}` ×3 | **rotate the committed credentials first** |
| shared modules | `atr-band-logic`, `orb-scalp-logic`, `orb-fut-logic` | `lib/indicators`, `lib/exit-rules` | port with their 50 existing tests |
| factory | `orb-fut-core` | becomes `RangeBreakoutDirectional` itself | it is already the class+config pattern |

### 6.2 `server/smp/` — 134 files

`server/smp/` is **not** a second set of ideas; it is a second *deployment mode* (each file
self-schedules its session) plus the pre-promotion ancestors of the slive families. Its unique
value is (a) 7 ideas that exist nowhere else, (b) the `startCron`/`exitCron` table, and (c) the
un-neutered risk parameters. **Harvest the config, then delete the code.**

> **Do not delete `server/smp/` before the `session.startAt` / `session.squareOffAt` column is
> extracted.** 21 distinct start times, some 1 second apart, exist in no other artefact.
> `samlion-9/10/11/12` differ *only* by the entry hour (09/10/11/12:16:50); in `slive/` the same
> four files are indistinguishable.

| class | legacy file(s) | disposition |
|---|---|---|
| `PremiumLegBook` (55) | `lion-s-25`, `lion-s-15`, `lion-s-40` | config only — SL 1.25 / 1.15 / **1.40** (the 1.40 value exists nowhere in slive) |
| | `lion-st-15`, `lion-st-25` | config only — trailing variants |
| | `lion-fs-25`, `lion-ms-25`, `lion-snx-25`, `lionN-s-25` | config only — FINNIFTY / MIDCPNIFTY / SENSEX / NIFTY. `lionN-s-25` correctly uses step 50 |
| | `lion-sl-25`, `lion-es-25`, `lion-sh-25` | config only |
| | `lion-sl-8` | config — **combined** SL 1.08 **+ target 0.95** (combination absent from slive) |
| | `lion-sp-3`, `lion-sp-5` | config — combined stop 0.97 / 0.95 |
| | `lion-sp-25` | config — 10 lots on the **`positional`** bus |
| | `lion-b-25` | config — BUY side |
| | `lion-b-3`, `lion-b-4`, `lion-b-5`, `lion-b-6` | config — combined stop 1.03 / 1.04 / 1.05 / 1.06 |
| | `lion-up`, `lion-down` | config — directional pair; `lion-down` is the `<` mirror with lot multiplier 10 |
| | `jk-s-25` | config — per-leg re-entry, dual SL tracker |
| | `samlion-9`, `samlion-10`, `samlion-11`, `samlion-12` | config — **entry hour is the whole difference** (09/10/11/12) |
| | `nifty-s`, `nifty-s-50` | config — adds `target_profit = 25` polled from `PaperTrade.positions` |
| | `dolphin`, `dolphin-bs2` | config — `target_profit = 70`; `-bs2` uses `otmSelector()` (⇒ 0) instead of the 200 literal |
| | `bull-s`, `bull-s1`, `bull-s5`, `bull-s10` | config — SL tiering; `sizeStep = 0` (flat) variants exist only here |
| | `bull-fs`, `bull-ms`, `bull-ns`, `bull-snx`, `bull-r` | config only |
| | `bull-200`, `bull-201` | config — `-201` adds a fixed 50-pt stop **+ reverse re-entry** (not in slive) |
| | `stgl-s`, `stgl-25`, `stgl-50`, `strangle-25` | config — `stgl-s` here is a **single** 100-pt pair (slive has 4); `stgl-50` is a premium-120 strangle with target 0.25 / SL 1.5 |
| | `strangle-mid`, `strangle-3`, `strangle-p` | config — ancestors of `stgl-mid-*` / `stgl-p-*` |
| | `calc-ce`, `calc-pe` | config — identical to `cal-ce/pe` except the cron wrapper |
| | `p718-5` | config — the **simple tick version**; squares off at 14:58 (earliest in the estate) |
| | `p718-7` | **port** — `entrySignal:'premium-limit' 0.9` + combined stop 1.1 `losing-legs-only` + `disarmOnFire`. Idea exists nowhere else |
| | `vwap` | **port** — `entrySignal:'premium-vs-vwap'`, 3-min eval. Only user of the tick's `average_price`. Fix the phantom-position bug (marks a side open before the sell condition passes) |
| `RollingLegStrangle` (6) | `rv-40`, `rv-40n`, `rv-25n` | config only |
| | `rv-3` | config — SL 1.25 / tgt 0.75 / budget **3** / `otm 0` on Wednesdays |
| | `rv-4` | **port config** — every roll also trades the same strike in `nextWeekInstruments` on the opposite side ⇒ `hedge:{expiry:'next',side:'opposite'}` |
| | `tiger-s-5` | **port config** — combined 5 % stop; on breach **rolls the losing leg** to the new ATM, alternating big/small |
| `RungLadderSeller` (9) | `bull-300`, `bull-300i`, `bulln-300`, `bulln-300i` | config only (trigger token is `dynamic` here, a literal in slive) |
| | `bull-m`, `bull-m1` | config only |
| | `bull-x` | config only |
| | `bull-10` | **port config** — per-rung quantity ramp (+100/1, +200/2, +300/3, mirrored) ⇒ `sizing:'rung-ladder'` |
| | `falcon-s` | **port config** — 2-slot rolling straddle; fires on a 50 **or** 100-pt crossing; rolls the slot farthest from ATM |
| `PremiumDistanceAccumulator` (8) | `eagle-s`, `eagle-fs`, `eagle-ms`, `eagle-ns`, `eagle-snx`, `eagle-p` | config only |
| | `eagle-sh` | config — hedged variant (82-line delta); the only eagle with any long leg |
| | `eagle-sp` | config — same engine on the **`positional`** bus |
| `MomentumFlipDirectional` (20) | `cheetah-s-10`, `cheetah-s-20`, `cheetah-s-30` | config — trail 10 / 20 / 30 |
| | `cheetah-s2-30`, `cheetah-t-1` | config — `t-1` adds trail 30 **and** a fixed +70 target |
| | `cheetah-s30-20m`, `cheetah-st60-20m` | config — **+20-minute entry** variants; the delta is `session.startAt` only |
| | `cheetah-st-60`, `cheetah-stp-60` | config only |
| | `cheetah-st-15p`, `cheetah-st-20p`, `cheetah-st-25p` | **port config** — **percent** trailing stop (`trailing-pct` 15/20/25), a basis absent from slive |
| | `cheetah-bf1-30` | config — BUY side, trail 30. **Hardcoded `lot_size: 25`** must be dropped |
| | `cheetah-b1-10`, `cheetah-b1-15`, `cheetah-b1-snx` | config — `b1-15` starts 09:14:00, the earliest in the estate |
| | `spt-30` | **port config** — 10 lots, flips with a **single 2× order** (`sizing:'flip-double'`); preserve the gross-vs-net distinction |
| | `spt-30s` | config — flips at 1×, initial BUY branch `mul = 0` (**tracking-only leg**) |
| | `strad-ts-20`, `strad-ts-33` | **port config** — pair-open direction with a **percent** trail (40 %/25 %, 20 %/15 %), `max_trades 5`, and a phantom BUY state that acts as a re-entry cooldown |
| `BracketReverseChain` (4) | `cp-s-2040`, `cp-ns-2040`, `cp-snx-2040`, `cp-s-3370` | config — these are the **tick-driven** variants (`exitMechanism:'local-tick'`) of the slive broker-OCO files. Both semantics are in production; record which each tag used |
| `RangeBreakoutDirectional` (4) | `bn-breakout` | stale fork — slive leads (1 trade **per day** here vs per side + loss-gated there). Harvest nothing; use slive |
| | `snx-orb-1`, `snx-orb-25`, `snx-orb-50` | byte-identical to slive. **Never run both copies — same tag, doubled orders** |
| `StraddleScalper` (14) | `bn-timer-120`, `bn-timer-straddle`, `nf-timer-120`, `nf-timer-straddle`, `snx-timer-120`, `snx-timer-straddle` | **port** — the only time-stop exit in the estate (120 s / 30 s), target +5, re-enter after 5 s, **no stop-loss** |
| | `bn-hft-avg`, `nf-hft-avg`, `snx-hft-avg` | **port config** — the *working* averaging parameters (`maxSteps 10`, decay −10 %/−5 %, `strikes [0,500,−500]`) that slive ships disabled |
| | `snx-hft-separate` | **port config** — independently configured CE/PE offsets (a bought strangle tracked as one pair), linear ladder |
| | `snx-hft-double` | **port config, disabled** — doubling ladder to **1 023 lots** with a ₹10 crore breaker that never fires. Must not be enabled without `risk.maxLotsNet` |
| | `bn-multi-straddle`, `nf-multi-straddle`, `snx-multi-straddle` | **port** — `lotAccounting:'independent'`, `atmPolicy:'frozen'`, escalating target `initial + increment × totalCreated` (counter never resets) |
| `SpreadLadderEngine` (7) | `ce-d-2`, `ce-d-3`, `pe-d-2`, `pe-d-3` | config — `otmSelector('SD_2'|'SD_3')`, `per_trade_qty 15`, `positional` bus |
| | `ce-pd-2`, `pe-pd-2` | config — ratio leg sizing |
| | `combo-trade` | **port first** — the only existing "strategy = class + config record" implementation; its `spreads` document is a working prototype of §3. Fix the `'BUy'` typo (exits are broken), the in-place `trades.reverse()` that persists, and the unqueued `checkSpreads()` |
| `IndicatorFlipStructure` (1) | `jaguar` | **port** — the only hedged/defined-risk, only positional, only persisted-state, only real-expiry-roll strategy in the estate |
| `ChainScanBreakout` (3) | `opt-buy`, `opt-buy-day`, `opt-sell` | **port** — `opt-buy-day` carries the per-weekday premium bands. Fix the leaked per-type slot on a target exit and the pre-test counter increment |
| **retired** (3) | `stgl-120` | **delete.** No CronJob at all, bare `runStrategy()`, never squares off, never exits, and its tag `STGL-25` collides with three other files |
| | `reliance-orb` | **delete.** Broken multi-symbol code (every symbol reads RELIANCE's high/low; each entry carries both limits). The ORB idea is properly implemented in `orb-fut-core` |
| | `hdfc_spread` | **delete.** HDFC Ltd merged into HDFC Bank 2023-07-13; the single-stock future does not exist, so every order throws. Keep the "2:1 stock-pair ratio ladder with persisted state" pattern as a note in `SpreadLadderEngine` |

---

## 7. Cross-cutting defects the taxonomy must fix once

These appear in **every** family spec. Fixing them in `StrategyBase` and the runner removes them
from all 12 classes at once; leaving them in the classes reproduces ~290 copies of each.

| # | Defect (families affected) | Fix location |
|---|---|---|
| F1 | `async.queue(fn,1)` workers written as `fn().then(cb)` with **no `.catch`**. One rejection means `cb` is never called, the concurrency-1 queue never drains, and every later tick piles up forever — the strategy dies silently while pm2 reports it healthy. *(all 10 families)* | Base-class lane with mandatory error handling, bounded backlog, and a stall alarm (§4.3-2) |
| F2 | Unguarded `ticksCache[token].last_price`. Missing quote → throw inside an un-awaited promise → either F1 or process death. *(all 10)* | `MarketData.hasQuote` precondition + `NOOP_WAITING` intent (§4.3-3) |
| F3 | **No EOD square-off anywhere.** Not one lion, bull, eagle, stgl, rv, cp or cheetah file flattens; several call `process.exit()` on a live book. Closure depends on an external pm2 stop that only *cancels* resting orders. *(all except `modern` and `snx-orb`)* | Mandatory `session.squareOffAt`, owned by the runner, with acknowledgement waiting before shutdown |
| F4 | Exit paths that only **mutate** a resting order's ledger row (`executeSL`) while the real StopLimit stays live at the broker — bus consumers subscribe to `insert` only. Local book flat, broker still short + a live BUY stop. *(lion sub-mode B, 7 files)* | `OrderGateway.replaceStop` / `cancel` — never edit a ledger row and call it closed |
| F5 | `REJECTED` treated as `FILLED` (a rejected stop books a phantom exit at price 0 and re-arms re-entry) or ignored entirely (a rejected entry leaks its trigger forever and blocks the strike). *(lion, stgl, cp, fut-100, cheetah)* | Normalised `FillStream` statuses; explicit handlers required by the type system |
| F6 | Correlation ids that collide across restarts and across days: per-process counters restarting at 0, and `moment().format('hhmmss')` (12-hour, no date) on tags whose ledger is never cleared. *(lion, stgl, cp, p718, fut-100)* | `tag\|YYYYMMDD\|seq` (§4.3-6) |
| F7 | No restart semantics. In-memory state only; a restart re-fires the entry, forgets open legs, and can re-issue ids that collide with in-flight orders from the previous incarnation. *(all 10)* | `snapshot()`/`restore()` + broker reconciliation in `init()` (§4.3-7) |
| F8 | `moment().day() == 3` as the expiry rule. Encodes the 2021–2023 BANKNIFTY regime; wrong for today's calendar and stale for NIFTY (Thursday). *(bull, eagle, stgl, rv, cheetah, singles)* | `ExpiryPolicy.rollWhenDaysToExpiryBelow`, derived from the chain |
| F9 | `optionConfig()` `require()`s an on-disk JSON with **no freshness check**, cached for the process lifetime → silently trades last week's tokens. FINNIFTY/MIDCPNIFTY refreshes are commented out. *(all 10)* | Dated instrument master, validated at load (§5) |
| F10 | `otmSelector()` returns 0 at 87/93 call sites, so ~120 nominally-OTM sellers are ATM straddle sellers; `otmSelector('SD_2')` returns `undefined` on **Thursdays**, crashing all 12 ratio-spread files weekly. *(lion, bull, cheetah, eagle, singles, p718, smp)* | Delete the module. Offsets become literal config values. Historical "OTM" P&L is ATM P&L |
| F11 | `delete arr[idx]` on arrays used as maps: holes, `.length` meaningless, unbounded growth, O(all trades ever) per tick. *(all 10)* | `Map<id, …>` in the base book |
| F12 | "Last completed candle" is `candles[length-1]` while the poller fires 10 s into a fresh bucket — so a "body close" breakout is really a 10-second snapshot. *(modern; and every history-driven file)* | `MarketData.lastClosedCandle`, timestamp-anchored |
| F13 | Order helpers call `Model.create()` without awaiting, so `await trackOrder(...)` resolves before the insert exists — "flag only after a successful order" is untrue, failures become unhandled rejections, and `process.exit()` races writes. *(all 10)* | `OrderGateway` awaits and surfaces failures (§4.1) |
| F14 | Risk breakers that are dead code (`checkPNL()` commented out), inverted (profit-only), or set beyond reach (₹20 lakh / ₹10 crore on 1-lot strategies) — combined with uncapped martingales (`+1` forever, `×2` to 1 023 lots). *(cheetah, hft, smp, bull, singles)* | `Risk` block is mandatory; non-flat sizing requires `maxLotsNet` (§3.3-5) |
| F15 | Plaintext credentials committed in three files; a hardcoded XTS account ObjectId in ten. *(singles, rv-cp, p718)* | Secret store + account resolution by tag |
| F16 | Every process logs in to the **same** master Zerodha account, mutating and saving that document, and opens its own full-chain `modeFull` socket. *(all 10)* | One login, one market-data service, deduplicated subscriptions (§5) |

**Behavioural changes that need explicit sign-off** (they alter live P&L, so they must not be
smuggled in as "fixes"): F8 (expiry rule), F10 (offsets), F12 (candle selection), and the
inverted rung comparator in `SpreadLadderEngine`. Each should ship behind a config flag defaulting
to the legacy behaviour, with a backtest comparison, and be flipped deliberately.

---

## 8. Retirements

| what | why |
|---|---|
| `server/tob/`, `server/monks/`, `server/archive/`, `server/asmp/`, `server/wealth/`, `server/insta/`, `server/scripts/` (strategy files) | Dead directories; out of scope per the project brief. Not ported, not harvested. |
| `server/smp/stgl-120.js` | No schedule, no square-off, no exit; tag collides with three other files. |
| `server/smp/reliance-orb.js` | Broken multi-symbol code; superseded by `orb-fut-core`. |
| `server/smp/hdfc_spread.js` | Underlying ceased to exist in 2023. Pattern noted, code deleted. |
| `server/lib/otmSelector.js` | Returns 0 at 87/93 call sites and `undefined` on Thursdays for `SD_2`/`SD_3`. Replaced by literal config offsets. |
| The whole `server/smp/` directory, **after** the config harvest | It is a deployment mode, not a set of ideas. Its 21 start times, its un-neutered risk parameters and its 7 unique ideas are captured in §6.2; nothing else in it is unique. |
| Dead-code list per family (`CronJob`/`notify`/`moment` unused imports, `channelId`, `accounts`/`firstRun`/`getAccounts`, `ATM_Strike`, `fromDate`/`toDate`, `takePositionQ` with no producer, `_SP`, `getAskPrice`/`getBidPrice`, `activeOrderIds`, `ceQty`/`peQty`, `setTargetPoints`/`module.exports` on pm2 entry points) | Enumerated in each family spec §"Dead code"; none of it ports. |

---

## 9. Suggested build order

1. `RangeBreakoutDirectional` — the modern files are already close to the target shape and carry
   the only tests. Porting it first proves `StrategyBase`, the phase/catch-up machinery and the
   backtest harness against known-good behaviour.
2. `SpreadLadderEngine` — port `combo-trade` next: it is the only existing class+config record
   and its `spreads` document validates the config schema end-to-end.
3. `PremiumLegBook` — the 128-file bulk. Build the five policy interfaces with the lion Algorithm-1
   configs first (they exercise the broker-resting-stop path), then stgl, then bull.
4. `MomentumFlipDirectional`, `BracketReverseChain`, `StraddleScalper` — these three need the
   `FillStream` and the synthetic fill model, so they come after the backtester is real.
5. `RollingLegStrangle`, `RungLadderSeller`, `PremiumDistanceAccumulator`,
   `IndicatorFlipStructure`, `ChainScanBreakout` — the long tail.
6. `ExternalSignalMirror` as a `SignalSource`, once secrets are rotated.
