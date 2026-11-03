# ORB + QuickScalp — 3-Index Options (paper) — Design

**Date:** 2026-07-03
**Status:** Approved for implementation
**Scope:** ORB v6 opening-range-breakout **spot signal** executed via **quick-scalp ATM option buying** for **BANKNIFTY, NIFTY and SENSEX**, in a single combined paper process.

## 1. Goal

Fuse the two strategies already in the repo:

- **Signal** = ORB v6 spot signal — the pure math already exists in `server/slive/orb-fut-logic.js` (`computeRange`, `passesFilter`, `breakoutSide`). Reused unchanged, computed on the **spot index** (not the future).
- **Execution** = quick-scalp ATM option BUY — the shape already exists in `server/slive/bn-breakout.js` (ATM option buy, premium target, opposite-side spot stop, time-stop, one trade/day).

On a confirmed breakout of the 09:15–09:45 opening range, buy the ATM option of that side (CE on an up-break, PE on a down-break), and manage it with a small premium target, a per-index time-stop, and a wide spot stop at the opposite ORB end.

Runs as **paper only**: orders go through `PaperTrade.trackOrder_v2` and are auto-filled by `server/boot/paperstream.js` at the live tick's `last_price`. Zerodha login is read-only (`historyData` + KiteTicker). No live orders (`Account.placeAllAccount` is never called).

## 2. Prerequisites already in place (verified)

- **Option ticks are subscribed in paperstream.** `server/boot/paperstream.js` downloads and subscribes the nearest-expiry (and next-week) option chains for BANKNIFTY, NIFTY and SENSEX, plus the three spot tokens (`256265` NIFTY 50, `260105` NIFTY BANK, `265` SENSEX). Paper fills key off `ticksCache[instrument_token].last_price`, so an ATM option BUY/SELL for any of the three fills correctly.
- **ATM option buying works in paper.** Proven by `bn-breakout.js`, which buys the ATM option via `trackOrder_v2(inst, 'BUY', tag, lots)` and later sells to close; `PaperTrade.positions()` nets by `tradingsymbol` and computes P&L.
- **`historyData` works on a spot token.** `zapi.historyData(spotToken, '5minute', from, to)` returns the index's 5-min candles for the range + breakout evaluation.
- **Option chain is obtainable per index.** `optionConfig.download(underlying)` returns `.weeklyInstruments` (nearest expiry, keyed `strike+CE`/`strike+PE`) which resolves to **monthly for BANKNIFTY** and **weekly for NIFTY/SENSEX** automatically — so expiry rollover needs no code change.

### Known cosmetic issue (inherited, not blocking)
`trackOrder_v2` hardcodes `exchange: "NFO"`. SENSEX options are really **BFO**. Paper fills key off `instrument_token`, so fills/P&L are unaffected; only exchange-filtered reporting would mislabel the SENSEX leg. Left as-is (same as the ORB-futures design noted).

## 3. Strategy rules

Per index, once per day:

1. **Opening range** — from the **spot** index's first six 5-min candles (09:15–09:45): `rangeHigh = max(highs)`, `rangeLow = min(lows)`, `range = rangeHigh − rangeLow`. Set at ~09:45.
2. **Range filter** — BANKNIFTY: skip the day if `range < 250`. NIFTY & SENSEX: no filter.
3. **Entry trigger** — every 5 min from ~09:50 to 14:00, evaluate the **last completed 5-min spot candle**: `breakoutSide(close, rangeHigh, rangeLow, 0.001)` → `'BUY'` (close > range +0.10%) or `'SELL'` (close < range −0.10%). The 0.10% buffer + body close is the anti-fakeout filter.
4. **Option entry** — on a signal, pick the ATM strike from the spot LTP (`round(spot/step)*step`), find that strike's **CE** (BUY signal) or **PE** (SELL signal) in the nearest-expiry chain (with ±strikeStep fallback), and `trackOrder_v2(inst, 'BUY', tag, lots)`. Fill = the option's live premium.
5. **Target** — premium + `targetPts` (BNF +40, NIFTY +20, SENSEX +25).
6. **Time-stop** — `setTimeout(close, timeStopMin*60000)` from entry (BNF 90, NIFTY 60, SENSEX 90). Target na aaye to exit.
7. **Stop loss** — the **spot** touching the ORB-SL level (opposite range end): CE → `rangeLow`, PE → `rangeHigh`. Wide, noise-proof — cut only on a genuine reversal.
8. **Entry deadline** — 14:00. No new entry after.
9. **One trade/day/index** — first valid breakout only; no re-entry after the leg closes.
10. **Force exit 15:15** — square off any open leg. Process exit 15:30.

### Per-index config
| | BANKNIFTY | NIFTY | SENSEX |
|---|---|---|---|
| `tag` | `ORB_SCALP_BN` | `ORB_SCALP_NIFTY` | `ORB_SCALP_SNX` |
| `underlying` | BANKNIFTY | NIFTY | SENSEX |
| `spotToken` | 260105 | 256265 | 265 |
| `rangeFilterPts` | 250 | 0 | 0 |
| `strikeStep` | 100 | 50 | 100 |
| `targetPts` | 40 | 20 | 25 |
| `timeStopMin` | 90 | 60 | 90 |
| `bufferPct` | 0.001 | 0.001 | 0.001 |
| `lots` | 1 | 1 | 1 |

## 4. Architecture

**One combined pm2 process, three indices** (user decision — trades process isolation for a single deployable).

```
server/slive/orb-scalp-logic.js       # NEW pure logic (unit-tested)
server/slive/orb-scalp.js             # combined engine: 1 KiteTicker, loops 3 index configs
server/test/orb-scalp-logic.test.js   # NEW node:test unit tests
```

- Reuses `orb-fut-logic.js` (`computeRange`, `passesFilter`, `breakoutSide`) unchanged for the signal.
- One KiteTicker subscribes to **3 spot tokens + the 3 nearest-expiry option chains** (proven pattern; paperstream subscribes the same tokens on the fill side).
- A `states` map keyed by index (`BANKNIFTY`/`NIFTY`/`SENSEX`) holds per-index `{ chain, rangeHigh, rangeLow, range, linesReady, dayBlocked, tradedToday, entryClosed, position }`. Per-index state is isolated so a bad tick for one index can't corrupt another.
- All three share identical timing, so each cron job iterates the three index states.
- `orb-scalp.js` is self-running on `require` (like `bn-breakout.js`), with the config array inline.

### `orb-scalp-logic.js` (pure, no I/O)
- `atmStrike(spotLtp, step)` → `Math.round(spotLtp / step) * step`
- `sideFromSignal(signal)` → `'BUY' → 'CE'`, `'SELL' → 'PE'`
- `spotSl(side, rangeHigh, rangeLow)` → `'CE' → rangeLow`, `'PE' → rangeHigh`
- `evaluateExit(pos, optLtp, spotLtp, opts)` → `{ exit: bool, reason }`, reason ∈ `TARGET | SL | EOD`:
  - `opts.forceExit` → `{ exit: true, reason: 'EOD' }`
  - `optLtp >= pos.target` → `TARGET`
  - `pos.side === 'CE' && spotLtp < pos.slSpot` (or `'PE' && spotLtp > pos.slSpot`) → `SL`
  - else `{ exit: false }`
  - **TIME is handled by `setTimeout`** in the engine (user choice), so it is not in this function — matching `bn-breakout.js`.

### Position object (per index)
```js
{
  side: 'CE' | 'PE',
  instrument,          // { tradingsymbol, instrument_token, lot_size }
  entryPremium,
  target,              // entryPremium + targetPts
  slSpot,              // rangeLow (CE) | rangeHigh (PE)
  entryTime,
  status: 'ACTIVE' | 'CLOSING' | 'CLOSED',
  timeStopTimer,       // setTimeout handle
}
```

## 5. Lifecycle (spot signal → option execution)

1. **09:00** `runStrategy()` — for each index: `optionConfig.download(underlying)` → nearest-expiry option map; read-only Zerodha login; start one KiteTicker on `[...spotTokens, ...allOptionTokens]`; reset state.
2. **09:45:20** `setupRange()` — per index: `historyData(spotToken,'5min')` → `computeRange(candles, 6)` → `passesFilter` (BNF 250). Set `linesReady` or `dayBlocked`. Retry in 30s if candles not ready.
3. **~09:50 → 14:00, every 5 min** `checkBreakout()` (async-queued) — per index, guarded by `linesReady && !tradedToday && !entryClosed && !position && !dayBlocked`: last completed 5-min spot candle → `breakoutSide` → `enterPosition`.
4. `enterPosition(cfg, state, signal)` — need spot tick and option tick; if either missing, abort **without** setting `tradedToday` (retry next candle). Pick ATM via `atmStrike`, `sideFromSignal`, `findOption` (±step fallback). `trackOrder_v2(inst,'BUY',tag,lots)`; set `tradedToday`; build position; arm `timeStopTimer`.
5. **On every tick** `checkExits()` — per active position: `evaluateExit(pos, optLtp, spotLtp)` → on `exit`, `closePosition(reason)`.
6. `closePosition(reason)` — synchronous `status='CLOSING'` guard; `clearTimeout(timeStopTimer)`; `trackOrder_v2(inst,'SELL',tag,lots)`; log + notify P&L.
7. **14:00** entry deadline (`entryClosed=true`, per index). **15:15** `eodExit()` force-close any open leg. **15:30** `process.exit()`.
8. `bootstrap()` — mid-session restart recovery by wall-clock (re-run `runStrategy`, re-derive `setupRange`/`entryClosed` if past those times), same as `bn-breakout.js` / `orb-fut-core.js`.

## 6. Scheduling (IST, Mon–Fri) — same style as the other two

- `09:00` `runStrategy()`
- `09:45:20` `setupRange()`
- every 5 min `09:50`→`14:00` — queued `checkBreakout()`
- `14:00` `entryClosed = true`
- `15:15` `eodExit()`
- `15:30` `process.exit()` (after a short delay)
- `bootstrap()` on load

## 7. Edge cases & error handling (mirror the proven files)

- **No candle data** at 09:45 → retry `setupRange` in 30s.
- **Range filter fails** (BANKNIFTY < 250) → `dayBlocked`, log, no trade.
- **Missing spot/option tick at entry** → abort this entry, do **not** set `tradedToday` (retry next 5-min check).
- **ATM option not found** near strike (after ±step fallback) → abort entry.
- **Re-entrant tick / timer race** → synchronous `status='CLOSING'` guard before any await; `clearTimeout` on close.
- **Overlapping `historyData` calls** → serialize `checkBreakout` via `async.queue` (concurrency 1); the queued task loops all three indices.
- **Per-index isolation** → one index's error/`dayBlocked` never blocks the others.
- **pm2 mid-session restart** → `bootstrap()` restores state by wall-clock.

## 8. Testing

- **Unit (`orb-scalp-logic.js`):**
  - `atmStrike` rounding for step 100 (BNF/SENSEX) and 50 (NIFTY), incl. exact-midpoint rounding.
  - `sideFromSignal`: BUY→CE, SELL→PE.
  - `spotSl`: CE→rangeLow, PE→rangeHigh.
  - `evaluateExit`: TARGET hit; SL for CE (spot < slSpot) and PE (spot > slSpot); `forceExit`→EOD; no-trigger→`{exit:false}`; already-closed position → no exit.
- **Integration (paper, dry):** point at a past trading day, confirm range/filter/entry/exit logs per index and that `PaperTrade` records net to flat.

## 9. Out of scope

- No live order routing (paper only).
- No scale-out — single leg, single premium target (unlike the ORB-futures T1/T2 scale-out).
- No opposite-direction re-entry after exit; one trade/day/index.
- Not fixing the `trackOrder_v2` NFO/BFO label for SENSEX options (cosmetic; fills key off token).
- Not moving to per-index processes (user chose one combined process).
