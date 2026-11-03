# Active Strategy Scope — the real porting target

*Established 2026-07-25 from the owner's scoping decision: **only strategies with `autostart: true`
or a `delay_start` value in `common/models/strategies.json` are in scope.** Everything else moves
to archive/legacy after its logic is documented.*

This resolves the biggest open question in the audit ("what actually runs?") and collapses the
porting effort by ~25×.

## The numbers

| Set | Count |
|---|---|
| `strategies.json` registry entries | 101 |
| **ACTIVE (`autostart: true` OR `delay_start` set)** | **16** |
| Registered but not auto-launched | 85 |
| Files in `server/slive` | 156 |
| Files across all strategy dirs | ~380 |

**So 15 strategies + 1 service are in scope, out of ~380 files.** Verified: no entry has *both*
`autostart: true` and `delay_start`, so the double-launch hazard noted in the project conventions
is not currently triggered.

## The active set

| Module | Dir | Launch | Tag | LOC | Execution rail |
|---|---|---|---|---|---|
| `atr-band-nifty` | slive | delay 09:18 | `ATR_Band_NIFTY` | 346 | bus-routed |
| `bn-breakout` | slive | delay 09:16 | `BN_Breakout` | 323 | bus-routed |
| `orb-scalp` | slive | delay 09:18 | `ORB_Scalp` | 319 | bus-routed |
| `orb-fut-bn` | slive | delay 09:18 | `ORB_Fut_BankNifty` | 7 | wrapper → `orb-fut-core` |
| `orb-fut-nifty` | slive | delay 09:18 | `ORB_Fut_NIFTY` | 7 | wrapper → `orb-fut-core` |
| `orb-fut-snx` | slive | delay 09:18 | `ORB_Fut_Sensex` | 7 | wrapper → `orb-fut-core` |
| `bull-s-1` | slive | **autostart** | `Bull_S-1` | 177 | bus-routed |
| `bull-snx-1` | slive | **autostart** | `Bull_SNX-1` | 178 | bus-routed |
| `eagle-s-1` | slive | **autostart** | `Eagle_S-1` | 199 | bus-routed |
| `lion-s25-2` | slive | **autostart** | `Lion_S25_2` | 199 | **LIVE (Zerodha) + bus stop** |
| `cheetah-b1-1` | slive | delay 09:17 | `CheetahB1-1` | 186 | **LIVE (Zerodha)** |
| `cheetah-b1-snx` | slive | delay 09:17 | `Cheetah_B1_SNX` | 174 | **LIVE (Zerodha)** |
| `candlestrategy` | slive | delay 09:14 | `1PBUY` | 132 | bus-routed (order mirror) |
| `candlestrategy-a006` | slive | delay 09:14 | `A006` | 132 | bus-routed (order mirror) |
| `candlestrategy-test3` | slive | delay 09:14 | `EMA2050` | 132 | bus-routed (order mirror) |
| `smp_order_listener` | tools | delay 09:14 | — | — | infrastructure service |

### Only 3 of these place real Zerodha orders
`cheetah-b1-1`, `cheetah-b1-snx`, `lion-s25-2` — verified as genuine `Account.placeAllAccount`
call sites (3 each).

**Watch out for a grep trap:** `bn-breakout.js:13` and `orb-scalp.js:13` also match
`placeAllAccount`, but only inside a header comment *promising the opposite* ("Never places live
orders (no `Account.placeAllAccount`)"). A naive `grep -c` misclassifies both as live. Always check
whether the hit is code or a comment.

## Two live risks now confirmed to be in the ACTIVE set

These were flagged in `07-verified-risks.md` as theoretical. Scoping promotes both to real:

1. **Every stop in the active set is a local, in-process tick stop — none rests at a broker.**
   Verified: all six non-modern active strategies (`bull-s-1`, `bull-snx-1`, `eagle-s-1`,
   `lion-s25-2`, `cheetah-b1-1`, `cheetah-b1-snx`) have `trackOrder_slm = 0` and `OrderUpdate = 0`.
   `lion-s25-2` is representative: entry at `:142,152`, then a tick-based check at `:178`
   (`ticksCache[...].last_price > sl_trigger`) firing a market BUY at `:182`. **If the process dies
   or the feed stalls, the position is unprotected until `squareoff_smp` runs.**

   *(An earlier draft claimed `lion-s25-2` had a broker-rail mismatch. That was wrong — the
   analysis was of `lion-s25-1`, which is NOT in the active set and differs by 64 diff lines
   including this mechanism. See `07-verified-risks.md` H3.)*

1b. **`Account.placeAllAccount` is dual-rail.** `common/models/account.js:151` calls `trackOrder()`
   — a `PaperTrade` insert onto the order bus — **and then** places Zerodha orders directly. Since
   `xtsOrder.js:311` forwards every tagged bus insert to XTS accounts, one strategy decision can
   fill on Zerodha **and** XTS/Spark/Fyers. Whether that doubles live size depends on account
   configuration under the tag. Affects `lion-s25-2`, `cheetah-b1-1`, `cheetah-b1-snx`.

2. **`eagle-s-1` is `autostart: true` and has no intraday stop.** Verified `BUY=0` and zero exit
   logic — it only ever adds short option legs. Exits rely entirely on the central
   `server/scripts/squareoff_smp.js:40-47` flatten. Bus-routed, so possibly simulated — but if a
   forwarding daemon is running, this is unhedged short gamma with no per-leg stop.

## What this means for the rewrite

The active set collapses to roughly **8 strategy classes**, not the 15–20 estimated from the full
380 files:

| Proposed class | Covers | Notes |
|---|---|---|
| `band-breakout-option` | `bn-breakout` | fixed-% band off first 5-min candle |
| `atr-band-option` | `atr-band-nifty` | Wilder-ATR band, 2-candle confirmation |
| `opening-range-futures` | `orb-fut-bn/nifty/snx` | already a factory + 3 configs — **the model to copy** |
| `opening-range-option` | `orb-scalp` | multi-index in one process |
| `atm-straddle-pyramid` | `bull-s-1`, `bull-snx-1` | pyramid-up, 25% premium stop |
| `momentum-buy-martingale` | `cheetah-b1-1`, `cheetah-b1-snx` | **LIVE**; note `-2117` variant is uncapped |
| `pyramid-short-no-exit` | `eagle-s-1` | central-squareoff exit model |
| `atm-crossover-strangle` | `lion-s25-2` | **LIVE**; the rail-mismatch case |
| `external-signal-mirror` | `candlestrategy` ×3 | not strategies — optionbhai order mirrors |

`orb-fut-*` already demonstrates the target: `orb-fut-core.js` exposes
`module.exports = function startOrbFut(config)` and the three underlyings are **7-line config
wrappers**. Six of the sixteen active modules are already in the good lineage (logic-split +
`node:test`).

## Archive plan

The other 85 registered entries and ~365 unregistered files move to `legacy/` **only after** their
logic is documented. The taxonomy workflow is producing that documentation now
(`context/strategy-specs/`), per the owner's instruction to document everything before archiving.

Do **not** delete: they are the historical record of what was tried, and several encode ideas
absent from the active set. Move, don't remove.

## Caveat

Registry membership is intent, not proof of execution. Per the project's own conventions,
`server/tools/ob_start.js` only ever `pm2.restart`s **existing** processes — there is no `pm2.start`
anywhere in the repo — so a module must have been manually `pm2 start`ed once for its registry
entry to have any effect. This list is therefore the **authoritative scope decision**, and a fresh
`pm2 jlist` from production would still be worth having to confirm the runtime matches.
