# BankNifty 0.09% Breakout — Design Spec

**Date:** 2026-07-02
**Module:** `bn-breakout`
**Strategy tag:** `BN_BREAKOUT`
**Mode:** Paper (PaperTrade class only — no live order placement)

## 1. Purpose

Intraday options breakout strategy on BankNifty (STOXGEN "0.09% Breakout").
The first 5-minute candle of the index spot defines a narrow band (±0.09% of its
close). When a later 5-minute candle closes through the band with a matching body
colour, buy the ATM option of the corresponding side and manage it with a premium
target, a spot-based structural stop, and a time stop. One trade per day.

This runs as a **paper strategy**: every order is placed via the `PaperTrade`
class and auto-filled by the existing `paperstream.js` boot engine at the live
tick price. It never calls `Account.placeAllAccount` or any live-order path.
`account` / Zerodha are used **only** for read-only login to obtain historical
candles (`historyData`) and a KiteTicker access token — identical to how
`paperstream.js` logs in.

## 2. Rules (source strategy)

| Step | Rule |
|------|------|
| Line | 1st 5-min (09:15-09:20) index-spot close × 0.09% = offset. HighLine = close + offset, LowLine = close − offset. |
| Entry | A 5-min candle whose **body** breaks a line (close beyond the line): green candle closing above HighLine → BUY ATM Call; red candle closing below LowLine → BUY ATM Put. |
| Entry price | Buy ATM option at market on the breakout candle's close. |
| Target | Option premium + 45 points. |
| Time-stop | 90 minutes from entry. |
| Stop loss | **Opposite** line spot break (Call: spot < LowLine; Put: spot > HighLine) → exit option. |
| Entry deadline | 13:30 — no new entries after. |
| Trades/day | 1. |
| Expiry | Nearest available monthly (BankNifty has no weeklies since Nov 2024). |
| Lot | 1 lot = 35 qty (multiplier = 1). |

## 3. Decisions locked during brainstorming

- **Position size:** fixed **1 lot** (`lots = 1` → `qty = lot_size × 1`, currently 35).
- **Exit evaluation:** **live ticks (intrabar)** — target and spot-SL react on the
  live KiteTicker feed, not on candle close.
- **Expiry:** **nearest available (monthly)** — `optionConfig('BANKNIFTY').weeklyInstruments`
  already resolves to the nearest expiry, which for BankNifty is the monthly.
- **Breakout candle detection:** **poll `zapi.historyData(260105, '5minute', …)`**
  at each 5-min boundary and evaluate the last completed candle (ORB pattern),
  rather than aggregating ticks in-process.
- **Parallel futures paper leg:** on the same breakout, also place a paper trade on the
  current-month BankNifty **future** (BUY on CE/bullish, SELL on PE/bearish) — added so we
  can track whether the future or the option is more profitable. It uses its **own
  points-based target/SL** (`+100 / −50`, configurable), the **same 90-min time-stop and
  EOD** square-off, and its **own tag `BN_BREAKOUT_FUT`** so its P&L aggregates separately
  from the option's. Same strategy file/process. (Note: the source sheet says the strategy
  is options-only because futures R:R is inverted — the futures leg exists to *observe*
  exactly that, on paper.)

## 4. Architecture

Cloned skeleton from `server/slive/snx-orb-1.js`, with live placement replaced by
`PaperTrade.trackOrder_v2`.

### Config constants (top of file)
```
strategyTag = 'BN_BREAKOUT'
spotToken   = 260105        // NIFTY BANK index
offsetPct   = 0.0009        // 0.09%
targetPts   = 45            // premium target (points)
timeStopMin = 90            // minutes
lots        = 1             // multiplier → qty = lot_size × lots
entryCutoff = 13*60+30      // 13:30 in minutes-of-day
strikeStep  = 100           // BankNifty strike interval

// Futures paper leg (parallel, own tag, own points target/SL)
futTag      = 'BN_BREAKOUT_FUT'
futTargetPts = 100
futSlPts    = 50
```

### State
```
highLine, lowLine, baseClose      // set by computeLines()
linesReady   = false
tradedToday  = false              // enforces 1 trade/day (blocks re-entry)
position     = null | {
  side, instrument, entryPremium, target, slSpot, entryTime, timeStopTimer, status
}
ticksCache   = {}                 // token -> latest tick
```

### Lifecycle (IST crons, Mon-Fri)

1. **09:00 `runStrategy()`**
   - `base_acc = Account.findById(masterId)`; `zapi = zerodha_init(base_acc)` (read-only login).
   - `optionData = optionConfig('BANKNIFTY')`; `currentExpiryOptions = optionData.weeklyInstruments`.
   - `ticker([spotToken, ...all monthly option tokens])` — subscribe up front so the ATM
     premium is already streaming when we enter (ORB pattern).

2. **09:21 `computeLines()`**
   - `candles = zapi.historyData(spotToken, '5minute', today, today)`.
   - `baseClose = candles[0].close` (09:15-09:20 candle).
   - `offset = baseClose × offsetPct`; `highLine = baseClose + offset`; `lowLine = baseClose − offset`.
   - `linesReady = true`. (Retry after 30s if candles not yet available.)

3. **Every 5 min, 09:25 → 13:30 `checkBreakout()`** (cron `5 */5 9-13 * * 1-5`, gated on
   `linesReady && !tradedToday && nowMinutes ≤ entryCutoff`)
   - `c = last completed candle` from `historyData(spotToken,'5minute',…)`.
   - `isGreen = c.close > c.open`; `isRed = c.close < c.open`.
   - **CE** if `c.close > highLine && isGreen`.
   - **PE** if `c.close < lowLine && isRed`.
   - First trigger → `enterPosition(side)`.

4. **`enterPosition(side)`** — option leg
   - `spotLtp = ticksCache[spotToken].last_price`.
   - `strike = round(spotLtp / strikeStep) × strikeStep`; find nearest listed strike as fallback (±100, ±200).
   - `inst = currentExpiryOptions[strike + (side==='CE'?'CE':'PE')]`.
   - `entryPremium = ticksCache[inst.instrument_token].last_price` (live tick at entry instant).
     If unavailable → abort + log, leave `tradedToday = false` (see Edge cases).
   - `PaperTrade.trackOrder_v2(inst, 'BUY', strategyTag, lots)` (market; paperstream fills at live price).
   - `tradedToday = true` (only after a successful order — enforces 1 trade/day).
   - `position = { side, instrument: inst, entryPremium, target: entryPremium + targetPts,
     slSpot: side==='CE' ? lowLine : highLine, entryTime: now, status: 'ACTIVE' }`.
   - Arm `timeStopTimer = setTimeout(() => closePosition('TIME'), timeStopMin × 60000)`.
   - Then `enterFuture(side)` for the parallel futures leg.

4a. **`enterFuture(side)`** — futures leg (own tag, own points target/SL)
   - `txn = side==='CE' ? 'BUY' : 'SELL'`.
   - `entryPrice = ticksCache[futureToken].last_price` (skip leg + log if unavailable).
   - `target = txn==='BUY' ? entryPrice+futTargetPts : entryPrice−futTargetPts`.
   - `sl     = txn==='BUY' ? entryPrice−futSlPts    : entryPrice+futSlPts`.
   - `PaperTrade.trackOrder_v2(futInst, txn, futTag, lots)`.
   - `futPosition = { side, txn, instrument: futInst, entryPrice, target, sl, status: 'ACTIVE' }`;
     arm its own 90-min `timeStopTimer → closeFuture('TIME')`.
   - `futInst = { tradingsymbol: currentFuture.symbol, instrument_token: currentFuture.token,
     lot_size }` (lot_size from the futures list, falling back to an option's lot_size or 35);
     `futureToken` is subscribed alongside spot + options at 09:00.

5. **`checkExits()`** (option) — invoked on every tick while the option leg is ACTIVE
   - `optPrice ≥ position.target` → `closePosition('TARGET')`.
   - `CE && spotPrice < slSpot` → `closePosition('SL')`; `PE && spotPrice > slSpot` → `closePosition('SL')`.

5a. **`checkFutExits()`** (future) — invoked on every tick while the futures leg is ACTIVE
   - `BUY` leg: `futPrice ≥ target` → TARGET; `futPrice ≤ sl` → SL.
   - `SELL` leg: `futPrice ≤ target` → TARGET; `futPrice ≥ sl` → SL.

6. **`closePosition(reason)`** / **`closeFuture(reason)`** — single funnel per leg
   (TARGET / SL / TIME / EOD)
   - Guard on that leg's `status === 'ACTIVE'`, then set `status='CLOSING'` synchronously
     (blocks re-entrant ticks / timer race) before awaiting the order.
   - Option: `PaperTrade.trackOrder_v2(position.instrument, 'SELL', strategyTag, lots)`.
   - Future: `PaperTrade.trackOrder_v2(futInst, txn==='BUY'?'SELL':'BUY', futTag, lots)`.
   - `clearTimeout(timeStopTimer)`; `status='CLOSED'`; log reason + P&L estimate.

7. **15:15 `eodExit()`** — safety square-off of **both** legs if still ACTIVE.

8. **15:30** — `setTimeout(process.exit, 3000)` (matches ORB / paperstream housekeeping).

### Tick handling
`checkTicks(ticks)` merges into `ticksCache`, then calls `checkExits()` if the option leg is
ACTIVE and `checkFutExits()` if the futures leg is ACTIVE. Both are synchronous and set
`status='CLOSING'` before any await, so no queue is needed (single-threaded guard). The
5-min breakout poll is the only path serialized through an `async.queue` (concurrency 1).

## 5. Order placement (PaperTrade)

- Option entry/exit under `strategyTag` (`BN_BREAKOUT`); futures entry/exit under `futTag`
  (`BN_BREAKOUT_FUT`) — separate tags so `PaperTrade.positions` aggregates each leg's P&L
  independently, which is what lets us compare futures vs option.
- Entry: `PaperTrade.trackOrder_v2(inst, 'BUY', <tag>, lots)`.
- Exit:  `PaperTrade.trackOrder_v2(inst, 'SELL'|'BUY', <tag>, lots)`.
- `trackOrder_v2` writes a `status: 'COMPLETE'` market order with
  `quantity = inst.lot_size × lots`. `paperstream.js` `handleInsertEvent` fills it at the
  live tick `last_price` (with depth-based slippage for prices > 50). No pending
  StopMarket / Limit orders and no OrderUpdate change-stream wiring are used — all
  exits are decided in-process from live ticks, keeping the strategy self-contained.

## 6. Registration & deployment

- Append one entry to `common/models/strategies.json`:
  ```json
  { "name": "BN_Breakout", "module": "bn-breakout", "autostart": true, "delay_start": "0900" }
  ```
- Drop the file byte-identical into **both** `server/smp/bn-breakout.js` and
  `server/slive/bn-breakout.js` (shared strategies are identical in both dirs; pm2 runs
  `bn-breakout` as the process name in each environment).

## 7. Edge cases

- **historyData latency at candle close** — evaluate the *last completed* candle in the
  returned array; the 5-min cron fires at second :05 to give Zerodha time to publish.
- **Line candle unavailable at 09:21** — retry `computeLines()` after 30s.
- **ATM strike not listed** — fall back to the nearest listed strike (search ±100, ±200).
- **No breakout by 13:30** — no trade taken; process idles to EOD then exits.
- **Missing option tick at entry** — if the ATM option's tick (`entryPremium`) is not yet
  in `ticksCache`, **abort the entry and log it** (do not enter a position we cannot set a
  target for). `tradedToday` is *not* set in this case, so the next 5-min breakout check can
  retry. Because all monthly option tokens are subscribed at 09:00, a missing tick at entry
  should be rare.
- **1 trade/day** — `tradedToday` set at entry and never reset intraday; blocks re-entry
  after any exit.

## 8. Out of scope

- Live/real order placement (paper only).
- Position sizing by risk (fixed 1 lot).
- Multiple concurrent trades or re-entry.
- Backtesting harness (the 5-year backtest referenced in the source sheet is prior art,
  not part of this deliverable).
