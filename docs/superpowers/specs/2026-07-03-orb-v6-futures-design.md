# ORB v6 — Index Futures (paper) — Design

**Date:** 2026-07-03
**Status:** Approved for planning
**Scope:** Opening-Range-Breakout ("ORB v6") paper strategy that trades **NIFTY, BANKNIFTY and SENSEX current-month futures**. Futures only — no options leg anywhere.

## 1. Goal

Port the STOXGEN "ORB v6" opening-range-breakout rules (originally documented for index/option-buying) to a **futures-only** paper strategy. On a confirmed breakout of the 09:15–09:45 opening range, go **long** (BUY) or **short** (SELL) the index's current-month future, manage it with a range-based stop and two range-based targets, and force-exit by 15:15.

Runs as **paper only**: orders go through `PaperTrade.trackOrder_v2` and are auto-filled by `server/boot/paperstream.js` at the live tick's `last_price`. Zerodha login is used **read-only** for `historyData` + KiteTicker. No live orders (`Account.placeAllAccount` is never called).

## 2. Prerequisites already in place (verified)

- **Futures are subscribed in paperstream.** `server/boot/paperstream.js` subscribes the current-month future for all three indices (`futureToken` for BANKNIFTY, `n_futureToken` for NIFTY, `sn_futureToken` for SENSEX) plus their spot index tokens (`256265` NIFTY 50, `260105` NIFTY BANK, `265` SENSEX). This means paperstream's `ticksCache` holds the future's `last_price`, so paper orders on those tokens fill correctly.
- **Shorting works in paper.** `trackOrder_v2(inst, 'SELL', tag, lots)` opens a short; a later `BUY` closes it. `PaperTrade.positions()` nets by `tradingsymbol` (`SELL` counted as negative qty), so open-short → cover nets and P&L computes correctly.
- **`historyData` works on a future token.** `zapi.historyData(instrument_token, '5minute', from, to)` hits Kite's historical endpoint for any token, futures included.
- **Future instrument object is obtainable.** `optionConfig.download(underlying)` returns `.futures` (full instrument list incl. `tradingsymbol`, `instrument_token`, `lot_size`) and `.currentFuture` (`{token, symbol, ltp}`). The monthly future used = `data.futures.find(f => f.instrument_token === data.currentFuture.token)`, which carries the `lot_size`/`tradingsymbol` needed by `trackOrder_v2`.

### Known cosmetic issue (not blocking)
`trackOrder_v2` hardcodes `exchange: "NFO"`. SENSEX futures are really **BFO**. Paper fills key off `instrument_token`, so fills/P&L are unaffected, but any exchange-filtered reporting would mislabel the SENSEX leg. Left as-is for now; noted for follow-up.

## 3. Strategy rules (futures-only)

Per index, once per day:

1. **Opening range** — from the future's own 5-min candles, aggregate the first six candles (09:15–09:45): `rangeHigh = max(highs)`, `rangeLow = min(lows)`, `range = rangeHigh − rangeLow`. Set at ~09:45.
2. **Range filter** — BANKNIFTY: skip the day if `range < 250`. NIFTY & SENSEX: no filter.
3. **Entry trigger** — every 5 min from 09:45 to 14:00, evaluate the **last completed 5-min candle** of the future:
   - `close > rangeHigh × 1.001` → **BUY** (go long)
   - `close < rangeLow × 0.999` → **SELL** (go short)
   - The 0.10% buffer + body close is the anti-fakeout filter (no entry on a wick/spike).
   - *Note:* a candle inside the opening range can never trigger — its close sits between `rangeLow` and `rangeHigh` by construction, so the first actionable candle is 09:45–09:50 (evaluated ~09:50).
4. **Entry deadline** — 14:00. No new entry after.
5. **Stop loss** — opposite ORB end, monitored on every tick: long → SL at `rangeLow`; short → SL at `rangeHigh`.
6. **Targets (scale-out)** — measured **from the fill price**:
   - **T1 = 1× range** (long: `entry + range`; short: `entry − range`). On T1: book **half** the lots and move SL to **breakeven** (`entry`).
   - **T2 = 2× range** (long: `entry + 2×range`; short: `entry − 2×range`). On T2: book the **remaining** lots → position closed.
7. **One trade/day** — first valid breakout only. After the position closes (SL / T2 / EOD), no re-entry that day.
8. **Force exit 15:15** — square off any remaining lots. Process exit 15:30.

### Decisions locked (from brainstorm, "go with defaults")
| # | Decision | Choice |
|---|---|---|
| A | Signal basis | **All on the future** — range, breakout, SL, targets from the future's candles/ticks. (Range & targets are differences, so spot↔future basis cancels → backtest-equivalent.) Spot tokens stay available for an easy later flip. |
| B | Trigger candle TF | **5-minute** close |
| C | T1/T2 handling | **Scale out** — ½ at T1 (SL→breakeven), ½ at T2 |
| D | Trades/day | **1 per day**, no re-entry |
| E | Sizing | **Fixed lots** per index, default **2** (even, so the ½ split is clean) |
| F | Code structure | **Shared core module + 3 thin launchers** → 3 pm2 processes |

## 4. Architecture

Shared parameterized core, thin per-index launchers — 3 independent processes.

```
server/slive/orb-fut-core.js     # the strategy engine; exports a factory: startOrbFut(config)
server/slive/orb-fut-nifty.js    # require core, call with NIFTY config
server/slive/orb-fut-bn.js       # require core, call with BANKNIFTY config
server/slive/orb-fut-snx.js      # require core, call with SENSEX config
```

Rationale: the ORB v6 rules are identical across the three indices except the range filter, so a shared core avoids the 3-way copy-paste drift the rest of `slive/` suffers from, while keeping the codebase's process-per-strategy convention (each launcher = one pm2 process, independently start/kill-able, one crash can't take down the others).

### Config object (per launcher)
```js
{
  strategyTag,        // e.g. 'ORB_FUT_NIFTY'
  underlying,         // 'NIFTY' | 'BANKNIFTY' | 'SENSEX'  (for optionConfig.download)
  rangeFilterPts,     // 250 for BANKNIFTY, 0 (disabled) for NIFTY/SENSEX
  lots,               // default 2
  bufferPct,          // 0.001 (0.10%)
}
```
The future token, `tradingsymbol`, and `lot_size` are resolved at runtime from `optionConfig.download(underlying)` — not hardcoded — so monthly rollover is automatic.

### Core module responsibilities (`orb-fut-core.js`)
Mirrors `bn-breakout.js`'s shape (self-contained lifecycle, its own KiteTicker, cron schedule), generalized over the config:
- `zerodha_init(account)` — read-only login for `historyData` + ticker token (unchanged pattern).
- `runStrategy()` — 09:00: `optionConfig.download(underlying)` → resolve monthly future instrument; read-only login; start KiteTicker subscribed to `[futureToken]`; reset daily state.
- `setupRange()` — 09:45: fetch `historyData(futureToken, '5minute', today, today)`, aggregate first 6 candles → `rangeHigh/rangeLow/range`; apply range filter (skip day if `range < rangeFilterPts`); mark `linesReady` (or `dayBlocked`).
- `checkBreakout()` — every 5 min 09:45→14:00 (async-queued so overlapping `historyData` calls can't race): last completed 5-min candle close vs buffered levels → `enterPosition('BUY'|'SELL')`. Guarded by `linesReady && !tradedToday && !entryClosed && !position`.
- `enterPosition(side)` — resolve fill price from the future's tick; `trackOrder_v2(fut, side, tag, lots)`; set `tradedToday`; build `position` with `entry`, `sl`, `t1`, `t2`, `lotsOpen`, `t1Done=false`.
- `checkExits()` — on every tick: SL hit → close remaining; T1 hit (and not `t1Done`) → book half (`trackOrder_v2(fut, opp, tag, halfLots)`), SL→entry, `t1Done=true`; T2 hit → book remaining, close.
- `closeRemaining(reason)` — book whatever lots are still open with the opposite `transaction_type`; guard against re-entrant ticks (`status` flag like bn-breakout's `CLOSING`).
- `eodExit()` — 15:15 square-off of any remaining lots.
- Cron schedule (IST, Mon–Fri) + mid-session `bootstrap()` for pm2 restarts, same pattern as `bn-breakout.js`.

### Position object
```js
{
  side: 'BUY' | 'SELL',        // long or short
  instrument: futInstrument,   // { tradingsymbol, instrument_token, lot_size }
  entry,                       // fill price
  sl, t1, t2,                  // absolute price levels
  lotsTotal,                   // = config.lots
  lotsOpen,                    // remaining open lots
  t1Done: false,               // scale-out flag
  status: 'ACTIVE' | 'CLOSING' | 'CLOSED',
  entryTime,
}
```

## 5. Scale-out lifecycle (worked example — long, 2 lots)

1. Breakout up → `trackOrder_v2(fut, 'BUY', tag, 2)`. `entry=E`, `sl=rangeLow`, `t1=E+range`, `t2=E+2×range`, `lotsOpen=2`.
2. Price ≥ `t1` → `trackOrder_v2(fut, 'SELL', tag, 1)`; `sl=E` (breakeven); `t1Done=true`; `lotsOpen=1`.
3a. Price ≥ `t2` → `trackOrder_v2(fut, 'SELL', tag, 1)`; `lotsOpen=0`; closed.
3b. Price ≤ `sl` (now breakeven) → `trackOrder_v2(fut, 'SELL', tag, 1)`; closed flat.
4. 15:15 with lots still open → `trackOrder_v2(fut, 'SELL', tag, lotsOpen)`; closed.

Short mirrors this with `SELL` to open and `BUY` to cover; `t1=E−range`, `t2=E−2×range`, `sl=rangeHigh`.

**Half-lot rule:** `halfLots = Math.floor(lotsTotal / 2)`. With the default `lots=2` → book 1 at T1, 1 at T2. If a launcher sets `lots=1`, `halfLots=0` → degrade gracefully to **full exit at T1** (no scale-out possible with a single lot); document this in the launcher.

## 6. Scheduling (IST, Mon–Fri)

Same cron style as `bn-breakout.js`:
- `09:00` — `runStrategy()` (download config, login, start ticker)
- `09:45:20` — `setupRange()` (range window closed)
- every 5 min `09:45`→`14:00` — queued `checkBreakout()`
- `14:00` — `entryClosed = true`
- `15:15` — `eodExit()`
- `15:30` — `process.exit()` after a short delay
- `bootstrap()` on load — mid-session restart recovery (re-run `runStrategy`, and re-derive `setupRange`/`entryClosed` if past those times)

## 7. Edge cases & error handling

- **No candle data yet** at 09:45 → retry `setupRange` in 30s (as `bn-breakout.js` does).
- **Range filter fails** (BANKNIFTY `range < 250`) → set `dayBlocked`, log, take no trade.
- **Missing future tick at entry** → abort this entry, do **not** set `tradedToday` (retry next 5-min check). Matches `bn-breakout.js`.
- **Re-entrant tick / timer races** → synchronous `status = 'CLOSING'` guard before any await in the close path.
- **Overlapping `historyData` calls** → serialize `checkBreakout` via an `async.queue` (concurrency 1).
- **Future not found in download** (`currentFuture.token === 0`) → log and disable the day.
- **pm2 mid-session restart** → `bootstrap()` restores state by wall-clock.

## 8. Testing

- **Unit (pure logic, extracted helpers):**
  - `computeRange(candles)` → correct `rangeHigh/rangeLow/range` from 6 candles.
  - `passesFilter(range, rangeFilterPts)` → BANKNIFTY 250 boundary; NIFTY/SENSEX always pass.
  - `breakoutSide(close, rangeHigh, rangeLow, bufferPct)` → BUY / SELL / null across buffered thresholds.
  - `targets(entry, range, side)` → correct `t1/t2/sl` for long and short.
  - Scale-out state machine: feed a tick sequence, assert the order calls (BUY 2 → SELL 1 at T1, SL→entry → SELL 1 at T2), incl. SL-after-T1 and EOD paths, and the `lots=1` degrade.
- **Integration (paper, dry):** point a launcher at a past trading day, confirm range/filter/entry/exit logs and that `PaperTrade` records net to flat.
- Extract the pure helpers so they're testable without the KiteTicker/cron shell.

## 9. Out of scope

- No options leg (the original ORB v6 option-buy interpretation is dropped).
- No live order routing.
- No risk-based sizing (fixed lots); no opposite-direction re-entry after SL.
- Fixing the `trackOrder_v2` NFO/BFO exchange label (tracked as a cosmetic follow-up).
