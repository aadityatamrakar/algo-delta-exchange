# ATR-Band — NIFTY Weekly Options (paper) — Design

**Date:** 2026-07-04
**Status:** Approved for planning
**Scope:** An intraday "quick scalp" paper strategy that trades **NIFTY weekly ATM options** (single option leg — CE or PE). Signals and band lines live on the **NIFTY spot index**; the trade is the ATM weekly option. Options only — no futures leg, no spreads.

## 1. Goal

Port the STOXGEN "ATR-Band" rules to a NIFTY-only paper strategy. At 10:15 freeze a band **width** from the hourly ATR; at 11:40 place a fixed **HighLine / LowLine** around the 5-min close. When two consecutive, correctly-coloured 5-min spot candles close beyond a line, **buy the ATM weekly option** of that side. Manage it with a small premium target, a 60-minute time-stop, and a wide "full-reversal" opposite-line stop. At most one CE and one PE per day.

Runs as **paper only**: orders go through `PaperTrade.trackOrder_v2` and are filled by `server/boot/paperstream.js` (its Mongo change-stream stamps `average_price` from the option's live LTP in paperstream's `ticksCache`). Zerodha login is used **read-only** for `historyData` + KiteTicker. No live orders (`Account.placeAllAccount` is never called).

This is a near-sibling of the existing, merged `server/slive/bn-breakout.js` (band-on-spot → buy ATM weekly option → premium target + time-stop + opposite-line stop). That file is the primary template.

## 2. Prerequisites already in place (verified)

- **NIFTY spot + weekly options are subscribed in paperstream.** `server/boot/paperstream.js` calls `ticker_n([n_futureToken, ...n_optionTokens, ...n_nextWeekOptionTokens])` and subscribes the NIFTY 50 spot token `256265`. So paperstream's `ticksCache` holds the ATM weekly option's `last_price`, and paper orders on those tokens fill correctly.
- **Paper option fills are priced automatically.** `trackOrder_v2(inst, side, tag, lots)` inserts a `COMPLETE` order with no price; paperstream's `handleInsertEvent` change-stream then `updateAll`s `average_price` from `ticksCache[instrument_token].last_price` (depth/slippage tweak only for premiums > 50; default `0.05` if the token has no tick). `PaperTrade.positions()` nets BUY/SELL by `tradingsymbol` → realized P&L. Reused unchanged.
- **The weekly option instrument object is obtainable.** `optionConfig.download('NIFTY')` returns `weeklyInstruments`, keyed by `strike + instrument_type` (e.g. `24500CE`). Each entry carries `{ instrument_token, tradingsymbol, lot_size, strike, instrument_type, last_price, expiry }` — everything `trackOrder_v2` needs. Weekly expiry auto-rolls (`nearestExpiry`).
- **`historyData` works on the spot token** for both `'60minute'` (hourly ATR) and `'5minute'` (anchor + entry/stop candles): `zapi.historyData(256265, interval, from, to)`.

### Known inherited property (not blocking)
The paper fill is paperstream's LTP at order-insert time, so the strategy's own logged `entryPremium` (from its own ticker's `ticksCache`) may differ from the book fill by a tick. This is a platform property shared by every paper strategy (incl. `bn-breakout.js`); logged premium is for humans, book P&L is authoritative. Not changed here.

## 3. Strategy rules (locked in brainstorm)

Per day, on NIFTY:

1. **Band width** — at **10:15**, from the spot's 1-hour candles, compute **Wilder ATR-14** using True Range `TR = max(high−low, |high−prevClose|, |low−prevClose|)`; the ATR value taken is the one **at the 09:15–10:15 candle** (the hourly candle that closes at 10:15). `width = ATR14 / 3`. Requires ~14 hourly candles of history (≈ prior 3 sessions), so fetch ~5 sessions back.
2. **Lines** — at **11:40**, take the spot's 5-min close of the **11:35–11:40** candle. `HighLine = close + width`, `LowLine = close − width`. Both frozen for the rest of the day.
3. **Entry** — evaluate the **last two completed 5-min spot candles** every 5 min from 11:45:
   - **CE:** both candles **green** (`close > open`) **and** both `close > HighLine` → buy ATM weekly **CE**.
   - **PE:** both candles **red** (`close < open`) **and** both `close < LowLine` → buy ATM weekly **PE**.
   - A **doji** (`close == open`) is neither green nor red → breaks the streak (no entry).
   - The anchoring 11:35–11:40 candle cannot trigger (its close sits between the lines by construction); first eligible breakout candle is 11:40–11:45, so the earliest 2-candle entry is ~11:50.
4. **Entry deadline** — **14:15**. No new entry after.
5. **Target** — market exit when the **option premium** reaches `min(entry + 20, entry × 1.30)` ("+20 points or +30%, whichever comes first" = the nearer price level). Above ~₹66.7 premium the +20 binds; below it the +30% binds.
6. **Time-stop** — **60 minutes** from fill; if neither target nor stop has fired, exit at market (theta protection).
7. **Stop loss** — **full-reversal, far opposite line, on a candle close**: a single completed 5-min spot candle whose `close` breaks the **opposite** line closes the trade. CE → `close < LowLine`; PE → `close > HighLine`. Wide by design — usually the target or time-stop resolves first; this is the disaster brake.
8. **One entry per side per day** — at most **one CE and one PE**, never overlapping (one position at a time). After a side's position closes (target / time-stop / stop / EOD), that side is done; the other side may still take its single entry on a fresh signal before 14:15. This is the sheet's "opposite-signal re-entry", capped at one per side. (Intentionally narrower than the sheet's open-ended Reentry=ON, and broader than a single trade/day.)
9. **Force exit 15:15** — square off any open position. Process exit 15:30.

### Decisions locked (from brainstorm)
| # | Decision | Choice |
|---|----------|--------|
| A | Band width formula | **Wilder ATR-14** (True Range, gaps counted) on spot 1-hour candles at the 10:15 candle, `/3` |
| B | Line anchor | **11:35–11:40 spot 5-min close** ± width, frozen |
| C | Entry trigger | **2 consecutive** 5-min candles, **both** correctly coloured **and** both closing beyond the line |
| D | Target | `min(entry+20, entry×1.30)` premium, market exit |
| E | Time-stop | **60 min** from fill |
| F | Stop loss | **Far opposite line**, on a **1-candle close** (full reversal) |
| G | Re-entry | **One per side/day** (≤1 CE + ≤1 PE), never overlapping |
| H | Sizing | Fixed **1 lot** ATM weekly (configurable) |
| I | Instrument | ATM = `round(spot/50)*50`, nearest weekly from `weeklyInstruments` |
| J | Scope / structure | **NIFTY only**, single launcher + extracted pure logic; paper only |

## 4. Architecture

Single self-contained launcher + an extracted pure-logic module. One pm2 process.

```
server/slive/atr-band-logic.js    # pure decision logic (no I/O), unit-tested
server/slive/atr-band-nifty.js    # launcher: KiteTicker + cron + state machine
server/test/atr-band-logic.test.js
```

Rationale: the strategy is NIFTY-specific (the sheet is), so no shared 3-index core is warranted (YAGNI). The launcher config object is kept in one place so a later multi-index refactor is a lift-and-shift. Pure logic is extracted so it is testable without the KiteTicker/cron shell, mirroring `orb-fut-logic.js`.

### Config (in the launcher)
```js
{
  strategyTag: 'ATR_BAND_NIFTY',
  underlying:  'NIFTY',
  spotToken:   256265,        // NIFTY 50 index
  strikeStep:  50,            // NIFTY strike interval
  atrPeriod:   14,
  widthDivisor:3,             // width = ATR / 3
  targetPts:   20,            // premium target (points)
  targetPct:   0.30,          // OR +30% premium — nearer level wins
  timeStopMin: 60,
  lots:        1,             // qty = lot_size * lots
}
```
The weekly option `instrument_token` / `tradingsymbol` / `lot_size` are resolved at runtime from `optionConfig.download('NIFTY')`, not hardcoded — weekly rollover is automatic.

### Pure logic module (`atr-band-logic.js`)
```
trueRange(high, low, prevClose)                      -> number
wilderATR(candles, period=14)                        -> last ATR value; candles oldest→newest, {high,low,close}
bandWidth(atr, divisor=3)                            -> atr / divisor
lines(anchorClose, width)                            -> { highLine, lowLine }
candleColor(candle)                                  -> 'green' | 'red' | 'doji'
entrySignal(last2Candles, highLine, lowLine)         -> 'CE' | 'PE' | null
target(entryPremium, targetPts, targetPct)           -> min(entry+pts, entry*(1+pct))
stopHitOnClose(side, candleClose, highLine, lowLine) -> bool
```
- `entrySignal`: **CE** iff both candles green **and** both `close > highLine`; **PE** iff both red **and** both `close < lowLine`; else `null`.
- `stopHitOnClose`: CE → `candleClose < lowLine`; PE → `candleClose > highLine`.
- Position lifecycle (tick-based target, timer time-stop, candle-close stop) stays in the launcher, as `bn-breakout.js` keeps its exits in the launcher.

### Launcher responsibilities (`atr-band-nifty.js`)
Mirrors `bn-breakout.js` shape (self-contained lifecycle, own KiteTicker, cron schedule):
- `zerodha_init(account)` — read-only login for `historyData` + ticker token (unchanged pattern).
- `runStrategy()` — 09:00: `optionConfig.download('NIFTY')` → `weeklyInstruments`; read-only login; start KiteTicker on `[spotToken, ...weeklyOptionTokens]`; reset daily state.
- `computeWidth()` — 10:15: `historyData(spotToken,'60minute', ~5 sessions back, today)` → `wilderATR` at the 09:15–10:15 candle → `width = bandWidth(atr)`; set `widthReady` (retry on data lag, `bn`-style).
- `computeLines()` — 11:40: `historyData(spotToken,'5minute',today)` → 11:35–11:40 close → `lines(close, width)`; set `linesReady` (retry on lag). No-op if `!widthReady`.
- `checkEntry()` — every 5 min 11:45→14:15 (async-queued, concurrency 1): if a `position` is open → evaluate `stopHitOnClose` on the last completed candle; else if flat → `entrySignal` on the last two completed candles → `enterPosition(side)` if that side is unused. Guarded by `linesReady && !entryClosed`.
- `enterPosition(side)` — resolve ATM (`round(spotLtp/strikeStep)*strikeStep`), `findOption(strike, side)` with nearest-strike fallback (bn pattern), read option LTP from `ticksCache`; abort (no side flag set) if spot/option tick missing; else `trackOrder_v2(inst,'BUY',tag,lots)`; build `position` with `entryPremium`, `target`, `entryTime`, `timeStopTimer`; mark the side used only after a successful order.
- `checkExits()` — on every tick: option LTP ≥ `position.target` → `closePosition('TARGET')`. (The candle-close stop is handled in `checkEntry`; the time-stop is a `setTimeout`.)
- `closePosition(reason)` — synchronous `status='CLOSING'` guard; clear the time-stop timer; `trackOrder_v2(inst,'SELL',tag,lots)`; mark side used; log + notify.
- `eodExit()` — 15:15 square-off of an open position.
- Cron schedule (IST, Mon–Fri) + `bootstrap()` for pm2 restarts, same pattern as `bn-breakout.js`.

### Position object
```js
{
  side: 'CE' | 'PE',
  instrument: optInstrument,   // { tradingsymbol, instrument_token, lot_size }
  entryPremium,                // strategy-ticker LTP at entry (for logging)
  target,                      // = min(entry+20, entry*1.30)
  slHigh, slLow,               // the frozen lines (candle-close stop reads these)
  entryTime,
  timeStopTimer,               // setTimeout -> closePosition('TIME')
  status: 'ACTIVE' | 'CLOSING' | 'CLOSED',
}
```

## 5. Exit precedence

Three **independent** monitors, whichever fires first closes the position; a synchronous `status='CLOSING'` guard makes the close idempotent against re-entrant ticks / the timer:
1. **Target** (tick-based, `checkExits`) — premium ≥ `min(entry+20, entry×1.30)`.
2. **Time-stop** (timer) — 60 min from fill → `closePosition('TIME')`.
3. **Stop** (candle-close, `checkEntry` poll) — a completed 5-min candle closes the far opposite line → `closePosition('SL')`.

After close, the side is marked used; the opposite side may still take its single entry before 14:15.

## 6. Scheduling (IST, Mon–Fri)

Same cron style as `bn-breakout.js`:
- `09:00` — `runStrategy()` (download config, login, start ticker)
- `10:15:20` — `computeWidth()`
- `11:40:20` — `computeLines()`
- every 5 min `11:45`→`14:15` — queued `checkEntry()`
- `14:15` — `entryClosed = true`
- `15:15` — `eodExit()`
- `15:30` — `process.exit()` after a short delay
- `bootstrap()` on load — mid-session restart recovery: re-run `runStrategy`; if past 10:15 → `computeWidth`; if past 11:40 → `computeLines`; if past 14:15 → `entryClosed`.

## 7. Edge cases & error handling

- **Insufficient hourly history** for ATR-14 at 10:15 → retry `computeWidth`; if still short, leave `widthReady=false` → no lines → no trade that day.
- **No 5-min anchor candle** at 11:40 → retry `computeLines` in 30s (`bn` pattern).
- **Missing spot/option tick at entry** → abort this entry, do **not** mark the side used (retry next 5-min check).
- **Doji** at either of the last two candles → not coloured → no entry.
- **Gap through target** → tick-based `checkExits` fires on the first qualifying tick.
- **Target vs stop on the same bar** → target is monitored continuously (ticks), the stop only on candle close; if the premium reached target intraday the position is already closed, so the candle-close stop can only matter when the target was never hit.
- **0-DTE (weekly expiry day)** → still trades ATM weekly; the 60-min time-stop and premium target cover the steep theta.
- **pm2 mid-session restart** → `bootstrap()` restores time-based state (width/lines/deadline) but **cannot** restore an already-open in-memory `position` — same limitation as `bn-breakout.js`; noted, not solved here.
- **Re-entrant tick / timer races** → synchronous `status='CLOSING'` before any await in `closePosition`.
- **Overlapping `historyData` calls** → serialize `checkEntry` via an `async.queue` (concurrency 1).

## 8. Testing

- **Unit (pure logic, `atr-band-logic.js`):**
  - `trueRange` — H−L vs gap-up (`|high−prevClose|`) vs gap-down (`|low−prevClose|`) dominance.
  - `wilderATR(candles, 14)` — against a hand-computed series (seed = SMA of first 14 TRs, then Wilder smoothing).
  - `bandWidth` — `atr/3`.
  - `lines` — `anchorClose ± width`.
  - `candleColor` — green / red / doji boundaries.
  - `entrySignal` — both-green-above → CE; both-red-below → PE; mixed colour → null; one candle inside the band → null; doji in the pair → null.
  - `target` — boundary near premium ≈ 66.7 (where +20 and +30% cross); below and above it.
  - `stopHitOnClose` — CE close below LowLine true / above false; PE mirror.
- **Integration (paper, dry):** point the launcher at a past trading day, confirm the width/lines/entry/exit logs and that `PaperTrade` records net to flat.
- Keep the KiteTicker/cron/`trackOrder_v2` shell thin so all decision logic is exercised by the unit tests.

## 9. Out of scope

- No live order routing (`Account.placeAllAccount` never called).
- No multi-index shared core (NIFTY only).
- No risk-based sizing (fixed lots); no re-entry beyond one-per-side; no same-side re-entry.
- No spreads / hedge leg — single option buy only.
