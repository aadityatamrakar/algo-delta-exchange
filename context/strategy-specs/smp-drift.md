# smp-drift — canonical spec for `server/smp/` (134 files)

> Status: verified 2026-07-25 by direct file reading + exhaustive `diff` against `server/slive/`.
> Everything below is evidence-based; line references are to files as of commit `bdbc9099`.
> This document is the **only** input an engineer should need to port `server/smp/` to the
> TypeScript class+config target architecture.

---

## 0. TL;DR — the one thing to understand about this directory

**`server/smp/` is not a second set of trading ideas. It is a second *deployment mode* of
`server/slive/`, plus an archive of the pre-production ancestors of the slive families.**

The defining structural delta, measured across all 290 files:

| | `server/smp/` (134) | `server/slive/` (156) |
|---|---|---|
| self-schedules its own session (`new CronJob('<s> <m> 9 * * 1-5', runStrategy)`) | **130**¹ | 14 |
| starts immediately on `require` (`runStrategy();` at module scope) | **1**² | **137** |
| has an EOD `process.exit()` cron | **131** | 20 |
| resolves the underlying token dynamically (`optionData.currentFuture.token`) | **34** | 10 |
| hardcodes a spot/future token (`260105`, `256265`, `265`, `257801`, `288009`) | 69 | **133** |

¹ Plus 3 more that self-schedule through a different entry symbol — `p718-5.js` and `p718-7.js`
use `() => runStrategy()`, `hdfc_spread.js` schedules `init` — for **133 / 134**.
² `stgl-120.js`, which has no CronJob at all (risk **R14**).

The smoking gun is `smp/calc-ce.js` vs `slive/cal-ce.js` — a 6-line diff in which the *only*
change is that slive **comments out the two CronJobs and uncomments `runStrategy()`**:

```diff
-new CronJob('0 24 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
-new CronJob('0 22 15 * * 1-5', function () { setTimeout(() => process.exit(), 3000); }, ...);
+runStrategy();
+// new CronJob('0 24 9 * * 1-5', runStrategy, ...);
```

Why: `slive` processes are pm2-managed and are (re)started **at** market open by
`server/tools/xtsOrder.js` (`startStrategies()` → `Manager.restart(module)`, driven by
`new CronJob('0 * * * * 1-5', delayStartStrategies)` at `xtsOrder.js:329`). An smp process,
by contrast, can stay resident 24×7 and wakes itself up. **The smp variant is architecturally
closer to the target system** (one long-lived runner hosting many strategy instances, each with
its own schedule), which is why the per-strategy session window must be lifted out of smp and
made a first-class config field.

### Corrected orphan count

The naive filename comparison says "108 smp files have no slive twin". That number is
misleading — most of those 108 have a near-identical slive counterpart under a **different
name** (client-code suffixes were added when files were promoted). Normalised-whitespace diffs:

| smp file | nearest slive file | diff lines | verdict |
|---|---|---|---|
| `bull-s`, `bull-fs`, `bull-ms`, `bull-ns`, `bull-snx` | `bull-{s,fs,ms,ns,snx}-1` | 9 each | same code |
| `eagle-s`, `eagle-fs`, `eagle-ms`, `eagle-snx` | `eagle-*-1` | 9–13 | same code |
| `calc-ce`, `calc-pe` | `cal-ce`, `cal-pe` | 9 | same code |
| `dolphin`, `dolphin-bs2` | `dolphin-0020` | 10, 15 | same code |
| `ce-d-2`, `pe-d-2` | `ce-d2-0020`, `pe-d2-0020` | 15 | same code |
| `lion-b-25`, `lion-snx-25`, `lion-sp-5`, `lion-up` | `lion-b25-1`, `lion-snx-1`, `lion-sp5-1`, `lion-up-1` | 15–19 | same code |
| `cheetah-b1-10`, `cheetah-stp-60` | `cheetah-b1-1`, `cheetah-stp-2117` | 15, 11 | same code |
| `nifty-s`, `nifty-s-50` | `nifty-s-1789`, `nifty-s-sbm95` | 20, 16 | same code |
| `rv-3` | `rv-40` | 22 | config only |
| `spt-30`, `spt-30s` | `fox-1` | ~30 (1-lot vs 10-lot) | same engine |
| `strangle-mid`, `strangle-3`, `strangle-p`, `strangle-25`, `stgl-25`, `stgl-50`, `stgl-120` | `stgl-mid-*`, `stgl-p-*`, `stgl-s*` | 13–290 | ancestors |
| `lion-{s,es,sh,sl,st,fs,ms}-*`, `lionN-s-25`, `jk-s-25`, `bull-{10,200,201,m1,s1,s5,s10,r,x}`, `eagle-{sh,sp,p,ns}`, `cheetah-{s,st,t,bf1,s2,s30,st60}-*`, `samlion-*`, `ce-d-3`, `ce-pd-2`, `pe-d-3`, `pe-pd-2` | corresponding slive family member | 13–170 | config only |

**Genuinely absent from `server/slive/` — would be LOST if smp were deleted: 22 files
encoding 7 ideas.** They are listed in §2. Everything else is either the self-scheduling
edition of a slive file or a pre-promotion ancestor; the value in those is *configuration
data* (§3) and *behavioural detail* (§5), not new algorithms.

### Drift direction (varies by vintage — do not assume one direction)

1. **2021 → 2023 legacy prototypes (≈70 files).** smp holds the **ancestor**; slive holds the
   productionised descendant that added the MongoDB `OrderUpdate` change-stream fill
   reconciliation, `XtsAccount.removePending()` OCO cancellation, `Manager`, and multi-account
   `placeAllAccount`. Example: `smp/p718-5.js` (2 crons, tick-driven) vs `slive/p718-5.js`
   (22 crons + `executeSL()` + change stream + `XtsAccount` + `Manager`).
2. **The 2025-09-19 bulk commit (≈45 files).** smp holds the **newer** copy: the self-scheduling
   crons were added *and* the hardcoded token was replaced with
   `optionData.currentFuture.token`. Example `smp/bull-300.js` vs `slive/bull-300.js`:
   `futureToken = optionData.currentFuture.token` vs `futureToken = 260105`.
3. **The 2025-10 → 2025-12 `cp-*` and `hft-*` work.** smp holds a **tick-driven** variant
   (in-process SL/target evaluation, exits as `trackOrder_v2` MARKET) and the *un-neutered*
   risk config; slive holds the **broker-order** variant (real `trackOrder_slm` +
   `trackOrder_limit` OCO pair, fills detected via the `OrderUpdate` change stream) with the
   averaging **disabled**:
   | | smp | slive |
   |---|---|---|
   | `bn-hft-avg` / `bn-hft` | `MAX_AVERAGING_STEPS = 10`, `TARGET_REDUCTION_PERCENT = 10`, `STRIKES = [0, 500, -500]` | `= 1`, `= 0`, `[0]` |
   | `snx-hft-avg` / `hft-averaging` | `= 10`, `= 5` | `= 1`, `= 0` |
4. **2026 modern files.** slive leads: `slive/bn-breakout.js` (2026-07-14) adds the
   "one trade per side per day, re-entry only after a loss" rule that `smp/bn-breakout.js`
   (2026-07-03) lacks. `snx-orb-{1,25,50}.js` are **byte-identical** in both directories.

---

## 1. Shared runtime skeleton (identical in ~125 of 134 files)

Every non-modern smp strategy is the same 9-step program. Port this once as the base class.

```
requires:  cron, ../server.js (loopback app), ../lib/zerodha.js, ../lib/KiteTicker.js,
           ../tools/optionInstruments.js, async, moment
           + optionally ../lib/otmSelector.js, ../tools/stoploss.js, ../lib/notify.js
models:    Account = app.models.account
           PaperTrade = app.models.PaperTrade        // the ORDER BUS
           Positional = app.models.positional        // a SECOND order bus (6 files)
           StrategyData = app.models.strategyData    // persisted state (2 files)
           Spreads = app.models.spreads              // config records (1 file)

STARTUP  (fired by `new CronJob(START_CRON, runStrategy, null, true, 'Asia/Kolkata')`)
  1. optionData = await optionConfig(UNDERLYING)      // Sensibull REST; see §1.1
  2. futureToken = optionData.currentFuture.token  OR  a hardcoded literal
     currentExpiryOptions = optionData.weeklyInstruments   // map "<strike><CE|PE>" -> instrument
  3. farOtm = otmSelector(TAG)   (or a literal)      // see §6 risk R1
  4. base_acc = await Account.findById(app.get('masterId'))
     zapi = await zerodha_init(base_acc)             // login, persist config, capture public_token
  5. liveFeed = new kiteTicker({api_key:'kitefront', access_token: public_token})
     liveFeed.subscribe([futureToken, ...all option tokens]); setMode(modeFull)
  6. setTimeout(() => { lastQuote = ticksCache[futureToken].last_price;      // ~5–10 s warmup
                        setTimeout(() => { startTrade = true; ... }, 5000) }, 5000|10000|15000)

TICK LOOP  (liveFeed.on('ticks', checkTicks))
  7. Object.assign(ticksCache, indexByInstrumentToken(ticks))     // full-mode ticks only
  8. if (startTrade) takePositionQ.push({check:1});  checkSLQ.push({check:1})
     // async.queue(fn, 1) — concurrency 1 is the ONLY re-entrancy guard in the codebase

SHUTDOWN (fired by `new CronJob(EXIT_CRON, ..., 'Asia/Kolkata')`)
  9. [optional] square off open legs, then setTimeout(() => process.exit(), 3000|5000|15000)
```

### 1.1 `optionConfig(underlying)` contract — `server/tools/optionInstruments.js`

Fetches from `api.sensibull.com` (`/v1/instrument_details` + `/v1/instruments/<UNDERLYING>`),
caches to `optionConfig_<UNDERLYING>.json`, and returns:

```ts
{
  symbol, options[], futures[],
  currentFuture: { token, symbol, ltp },   // the *monthly* future in the nearest-weekly's month
  monthlyExpiry, weeklyExpiry, max_pain, ivp, ivTrend,
  weeklyInstruments:   Record<`${strike}${'CE'|'PE'}`, Instrument>,   // nearest expiry
  nextWeekInstruments: Record<`${strike}${'CE'|'PE'}`, Instrument>    // 2nd-nearest expiry
}
// Instrument = { expiry, instrument_token, instrument_type, last_price, lot_size,
//                name, segment, strike, tradingsymbol }
```

`lot_size` is per-contract; **every order helper multiplies `lot_size * multiplier`**, so the
`multiplier` argument everywhere in this codebase means **lots, not shares**.

### 1.2 Execution rails — all four write to the same two collections

| call | collection written | `status` | `order_type` | live? |
|---|---|---|---|---|
| `PaperTrade.trackOrder(inst, side, tag, lots)` | `paper-trade` | `COMPLETE` | `MARKET` | via bus consumers |
| `PaperTrade.trackOrder_v2(inst, side, tag, lots, dataObj)` | `paper-trade` | `COMPLETE` | `MARKET` | via bus consumers |
| `PaperTrade.trackOrder_slm(inst, side, tag, lots, stopPrice, dataObj)` | `paper-trade` | `Pending` | `StopMarket` | via bus consumers |
| `PaperTrade.trackOrder_limit(inst, side, tag, lots, limitPrice, dataObj)` | `paper-trade` | `Pending` | `Limit` | via bus consumers |
| `Positional.trackOrder(inst, side, tag, lots)` | `positional` | `COMPLETE` | `MARKET` | via bus consumers |
| `Account.placeAllAccount(tag, qtyMap, accounts, inst, side, lots)` | **`paper-trade` (always, `account.js:151`)** + direct Zerodha `orderFNO` MARKET per account in `accounts` | `COMPLETE` | `MARKET` | both rails |

Bus consumers that turn a `paper-trade` **or `positional`** insert into a real broker order:
`server/tools/xtsOrder.js:306-318` (XTS/Jainam; `StopMarket` → XTS `StopLimit` ±1%),
`sparkOrder.js:62-67,169`, `fyersOrder.js`, `am_xtsOrder.js:208`,
`am_xtsOrder-cluster.js:216`. `server/boot/paperstream.js:401-430` is the simulator and
watches both collections too.

**Therefore: "execution rail" is NOT a property of the strategy file.** Every order in
`server/smp/` reaches the bus. Whether it becomes a broker order depends on (a) which consumer
daemons are running and (b) whether `running_accounts` is non-empty. In smp, `getAccounts()`
is commented out in 38 files; **only `snx-orb-1/25/50.js` actually populate
`running_accounts`**, so the direct-Zerodha half of `placeAllAccount` is dormant in the other
~44 `placeAllAccount` users — but their bus writes are *not*.

`placeAllAccount` also tranches large orders: max 60 lots/order for BANKNIFTY,
36 for NIFTY, 100 otherwise (`account.js:155-165`). And it silently **returns `undefined`
and places nothing** if `optionInstrument.tradingsymbol` is falsy (`account.js:149`).

---

## 2. The 7 distinct ideas that exist ONLY in `server/smp/`

### IDEA 1 — `timer-straddle-scalp` (6 files)

Long ATM straddle, tiny points target, **hard wall-clock time stop, no stop-loss**, sequential
single-position loop all day. Nothing in slive does a time-based exit.

```
CONFIG: underlying, strikeStep, targetPoints, exitTimerSec, entryDelaySec, lots,
        profitTargetRs, startCron, exitCron

ON START (after 5 s feed warmup):
  baseATM = syntheticATM(futureLtp)
  createStraddle()

syntheticATM(futLtp):                       # put–call parity, F = K + C − P
  K = round(futLtp / strikeStep) * strikeStep
  C = ltp(K+'CE'); P = ltp(K+'PE')
  if K'CE' or K'PE' missing, or C or P unavailable:  return K        # graceful fallback
  return round((K + C − P) / strikeStep) * strikeStep

createStraddle():
  if strategyStopped or active or waitingForEntry: return
  if futureLtp unavailable: retry in 1 s; return                     # unbounded retry
  atm = syntheticATM(futureLtp)                                      # RE-computed each entry
  ce = chain[atm+'CE']; pe = chain[atm+'PE']
  if either missing, or either LTP unavailable: return               # NO retry — see R7
  entry  = ltp(ce) + ltp(pe)
  target = entry + targetPoints
  active = {id:++n, ce, pe, entry, target, entryTime:now, lots}
  BUY ce (lots); BUY pe (lots)                                       # bus: trackOrder
  active.timerHandle = setTimeout(() => exit('TIMER'), exitTimerSec * 1000)

EVERY TICK (serialised through async.queue(...,1)):
  if !strategyStopped and stoplossTracker.getPNL(ticksCache) >= profitTargetRs:
      strategyStopped = true; exit('MANUAL'); return
  if strategyStopped: return
  if active and ltp(ce) and ltp(pe):
      active.ce.lastPrice = ltp(ce); active.pe.lastPrice = ltp(pe)   # cached for exit P&L
      if ltp(ce) + ltp(pe) >= active.target: exit('TARGET')

exit(reason):
  clearTimeout(active.timerHandle)
  SELL ce (lots); SELL pe (lots)
  active = null
  if !strategyStopped and reason != 'MANUAL':
      waitingForEntry = true
      setTimeout(() => { waitingForEntry = false; createStraddle() }, entryDelaySec * 1000)

ON exitCron: strategyStopped = true; if active: exit('MANUAL'); process.exit() after 5 s
```

Exit paths: (a) combined premium ≥ entry + `targetPoints`; (b) `exitTimerSec` elapsed;
(c) portfolio P&L ≥ `profitTargetRs` → stop for the day; (d) EOD cron.
**There is no stop-loss.** Sizing is flat 1 lot, always.

| file | underlying | step | fut token | targetPoints | exitTimerSec | entryDelaySec | start | exit |
|---|---|---|---|---|---|---|---|---|
| `bn-timer-120.js` | BANKNIFTY | 100 | 260105 | 5 | **120** | 5 | 09:16:45 | 15:21:00 |
| `bn-timer-straddle.js` | BANKNIFTY | 100 | 260105 | 5 | **30** | 5 | 09:16:45 | 15:21:00 |
| `nf-timer-120.js` | NIFTY | 100¹ | 256265 | 5 | 120 | 5 | 09:16:45 | 15:21:00 |
| `nf-timer-straddle.js` | NIFTY | 100¹ | 256265 | 5 | 30 | 5 | 09:16:45 | 15:21:00 |
| `snx-timer-120.js` | SENSEX | 100 | 265 | 5 | 120 | 5 | 09:16:45 | 15:21:00 |
| `snx-timer-straddle.js` | SENSEX | 100 | 265 | 5 | 30 | 5 | 09:16:45 | 15:21:00 |

¹ NIFTY strikes are 50 apart but these files round to 100 — see risk **R5**.

### IDEA 2 — `straddle-pyramid-scalp` (8 files)

Long ATM straddle (or a separately-legged strangle), **pyramid deeper on every N-point drop in
the combined premium**, no stop-loss, exit each unit on its own target, re-enter after a delay.
`slive/hft-averaging.js`, `hft-multi.js`, `hft-nifty.js`, `bn-hft.js` are the same engine with
`MAX_AVERAGING_STEPS = 1`, i.e. **averaging switched off** — the working configuration exists
only in smp.

Two sub-modes, selected by `lotAccounting`:

**2a `lotAccounting = 'averaged'`** (`*-hft-avg`, `snx-hft-double`, `snx-hft-separate`) — one
position per strike slot; entries fold into a running average pair price.

```
CONFIG: underlying, strikeStep, strikes[] (offsets from ATM) | {callOffsets[], putOffsets[]},
        targetPoints, averagingTrigger, targetReductionPct, maxAveragingSteps,
        qtyLadder: 'linear' | 'double', restartDelayMs = 10000, profitTargetRs?

ON START: atm = round(futLtp/step)*step;  for each offset o in strikes: openSlot(atm, o)

openSlot(atm, o):
  ce = chain[(atm+o)+'CE']; pe = chain[(atm+o)+'PE']
  if either missing or either LTP unavailable: return          # NO retry — slot dies, see R7
  slot.currentTarget = targetPoints
  addEntry(slot, ltp(ce), ltp(pe), qty=1, initial=true)

addEntry(slot, cP, pP, qty, initial):
  pair = cP + pP
  slot.entries.push({cP, pP, pair, qty})
  slot.totalQty  += qty
  slot.totalCost += pair * qty
  slot.avgPrice   = slot.totalCost / slot.totalQty        # average of PAIR prices, qty-weighted
  slot.isActive   = true
  if !initial and slot.entries.length > 1:
      slot.currentTarget *= (1 − targetReductionPct/100)   # geometric target decay
  BUY ce (qty); BUY pe (qty)

EVERY TICK, for each active slot (serialised, concurrency 1):
  if ltp(ce) or ltp(pe) unavailable: skip slot
  slot.ce.lastPrice = ltp(ce); slot.pe.lastPrice = ltp(pe)
  pair = ltp(ce) + ltp(pe)
  if pair >= slot.avgPrice + slot.currentTarget:  squareOff(slot); continue     # TARGET
  if pair <= slot.avgPrice − averagingTrigger:                                  # PYRAMID
      if slot.entries.length >= maxAveragingSteps: continue
      nextQty = (qtyLadder == 'double') ? lastEntry.qty * 2
                                        : slot.entries.length + 1
      addEntry(slot, ltp(ce), ltp(pe), nextQty, initial=false)

squareOff(slot):
  SELL ce (slot.totalQty); SELL pe (slot.totalQty)
  reset slot {entries:[], totalQty:0, totalCost:0, avgPrice:0,
              currentTarget: targetPoints, isActive:false}
  setTimeout(() => openSlot(round(futLtp/step)*step, offsetOf(slot)), restartDelayMs)
      # NB: re-centres on the CURRENT ATM, unlike mode 2b

ON exitCron: for each active slot: SELL ce/pe (totalQty); process.exit() after 5 s
```

`snx-hft-double` / `snx-hft-separate` differ only in that CE and PE offsets are configured
independently (`callOffsets = [100]`, `putOffsets = [-100]` → a bought strangle, tracked as one
pair) and in `qtyLadder`: `double` (1,2,4,8,…) vs `linear` (1,2,3,4,…).

**2b `lotAccounting = 'independent'`** (`*-multi-straddle`) — every pyramid step is its **own**
straddle with its own entry, its own escalating target, and its own exit.

```
CONFIG: underlying, strikeStep, initialTargetPoints, newTrigger, targetIncrement,
        maxStraddles = 10, reEntryDelayMs = 15000, profitTargetRs

ON START: baseATM = syntheticATM(futLtp)          # FROZEN for the whole day — see R6
          createStraddle(baseATM, offset=0, qty=1, target=initialTargetPoints)

createStraddle(atm, off, qty, targetPoints):
  if strategyStopped or activeStraddles.size >= maxStraddles: return
  ce/pe = chain[(atm+off)+'CE'|'PE'];  bail if missing or LTP unavailable
  entry = ltp(ce) + ltp(pe)
  s = {id:nextId++, entry, target: entry + targetPoints, qty, ce, pe, isActive:true}
  activeStraddles.set(s.id, s);  totalCreated++;  lastEntryPrice = entry
  BUY ce (qty); BUY pe (qty)

EVERY TICK (serialised):
  if pnl(all) >= profitTargetRs: strategyStopped = true; exitAll(); return
  # (1) target check, per straddle
  for s of activeStraddles: if ltp(ce)+ltp(pe) >= s.target: exitStraddle(s)
  # (2) pyramid trigger — measured on the FROZEN baseATM straddle, not on any position
  if lastEntryPrice and activeStraddles.size < maxStraddles:
      if pairPrice(baseATM) <= lastEntryPrice − newTrigger:
          createStraddle(baseATM, 0,
                         qty    = activeStraddles.size + 1,
                         target = initialTargetPoints + targetIncrement * totalCreated)

exitStraddle(s):
  SELL ce (s.qty); SELL pe (s.qty);  activeStraddles.delete(s.id);  s.isActive = false
  if !strategyStopped:
      setTimeout(() => createStraddle(baseATM, 0,                      # frozen ATM again
                       qty    = activeStraddles.size + 1,
                       target = initialTargetPoints + targetIncrement * totalCreated),
                 reEntryDelayMs)

ON exitCron: SELL every active straddle's ce/pe at its own qty; process.exit() after 5 s
```

| file | underlying | fut token | mode | target | trigger | steps | strikes / qtyLadder | profitTargetRs |
|---|---|---|---|---|---|---|---|---|
| `bn-hft-avg.js` | BANKNIFTY | 260105 | averaged | 10 | 10 | 10, −10 %/step | `[0, 500, −500]`, linear | — (no breaker) |
| `nf-hft-avg.js` | NIFTY | 256265 | averaged | 5 | 2 | **1** (off), −0 % | `[0]`, linear | 2 000 000 |
| `snx-hft-avg.js` | SENSEX | 265 | averaged | 10 | 10 | 10, −5 %/step | `[0]`, linear | 2 000 000 |
| `snx-hft-double.js` | SENSEX | 265 | averaged | 10 | 10 | 10, −0 % | CE `[100]` / PE `[−100]`, **double** | 100 000 000 (∞) |
| `snx-hft-separate.js` | SENSEX | 265 | averaged | 10 | 10 | 10, −0 % | CE `[100]` / PE `[−100]`, linear | 2 000 000 |
| `bn-multi-straddle.js` | BANKNIFTY | 260105 | independent | 10 | 10 | max 10 straddles, +2/straddle | `[0]` | 2 000 000 |
| `nf-multi-straddle.js` | NIFTY | 256265 | independent | 5 | 5 | max 10, +2 | `[0]` | 2 000 000 |
| `snx-multi-straddle.js` | SENSEX | 265 | independent | 10 | 10 | max 10, +2 | `[0]` | 2 000 000 |

### IDEA 3 — `option-chain-ohlc-scanner` (3 files)

The only strategies in the repo whose signal is the **option contract's own intraday OHLC**,
scanned across the *entire* weekly chain. No ATM offset, no underlying trigger.

```
CONFIG: underlying, mode: 'buy-breakout' | 'sell-open-is-high',
        bandLow, bandHigh,                  # premium band on the option's own day extreme
        bandByWeekday?: {1:{lo,hi}, …, 5:{lo,hi}},
        breakoutMult = 1.5, targetMult = 1.5, slPoints = 20,
        maxPerStrike = 4, onePerOptionType = true

ON START: if bandByWeekday: {bandLow, bandHigh} = bandByWeekday[moment().day()]

# ---- mode 'buy-breakout'  (opt-buy, opt-buy-day) -------- EVERY TICK, serialised
for opt of every instrument in weeklyInstruments:
  ltp = tick(opt).last_price;  low = tick(opt).ohlc.low
  trigger = low * breakoutMult;  target = trigger * targetMult
  if onePerOptionType and position[opt.instrument_type]: continue
  if low in [bandLow, bandHigh] and ltp > trigger:
      strikesTraded[opt.token] = (strikesTraded[opt.token] || 0) + 1   # incremented BEFORE the cap test
      if strikesTraded[opt.token] < maxPerStrike:
          position[opt.instrument_type] = true
          BUY opt (1 lot)
          orders.push({opt, sl: ltp − slPoints, tgt: target})

# ---- mode 'sell-open-is-high'  (opt-sell) ---- ONCE, 15 s after feed connect
for opt of every instrument in weeklyInstruments:
  ltp = tick(opt).last_price; high = int(tick(opt).ohlc.high); open = int(tick(opt).ohlc.open)
  if high in [bandLow, bandHigh] and open == high and ltp < high:
      SELL opt (1 lot);  orders.push({opt, sl: high})     # stop only, no target

# ---- exits, EVERY TICK, serialised
buy-breakout:  ltp < sl  -> SELL, free position[type]        # stop: frees the type slot
               ltp > tgt -> SELL, DO NOT free position[type] # target: slot stays blocked (R8)
sell-open-is-high: ltp > sl -> BUY (close)                   # no target, no re-entry
```

| file | mode | band | slPoints | start | exit |
|---|---|---|---|---|---|
| `opt-buy.js` | buy-breakout | fixed `[121, 161]` (`low > 121 && low < 161`, exclusive) | 20 | 09:17:00 | 15:23:40 |
| `opt-buy-day.js` | buy-breakout | per weekday: Mon `[70,130]`, Tue `[50,90]`, Wed `[30,70]`, Thu `[90,170]`, Fri `[80,150]` (inclusive) | 20 | 09:17:00 | 15:23:40 |
| `opt-sell.js` | sell-open-is-high | fixed `[100, 400]` | n/a (stop = day high) | 09:19:45 | 15:23:40 |

### IDEA 4 — `option-vwap-reversion` (1 file, `vwap.js`, newest orphan: 2026-01-18)

The only strategy that uses the option's own **day VWAP** — Kite full-mode ticks expose it as
`average_price`. Sell the fixed-OTM leg while its LTP is under its VWAP; buy it back when the
LTP crosses back above. Evaluated by a 3-minute cron, not per tick.

```
CONFIG: underlying, strikeStep, otmOffset = 100, lots = 1, evalCron = '0 */3 * * * 1-5'

ON evalCron:                                   # independently for the CE and the PE side
  atm = round(futLtp / strikeStep) * strikeStep
  for side in ['CE', 'PE']:
    if open[side] == false:
        strike = atm + (side=='CE' ? +otmOffset : −otmOffset)
        opt = chain[strike + side]
        if ltp(opt) < vwap(opt):    SELL opt (lots);  open[side] = strike;  return   # ← see R9
    else:
        opt = chain[open[side] + side]
        if ltp(opt) > vwap(opt):    BUY  opt (lots);  open[side] = false;   return
```

Exits: mean-reversion buy-back only. No stop-loss, no target, no EOD square-off (only
`process.exit()` at 15:22).

### IDEA 5 — `supertrend-hedged-spread` (1 file, `jaguar.js`)

The **only** defined-risk (hedged) directional spread, the **only** multi-day/positional
strategy, the **only** one with restart-surviving persisted state, and the **only** one with a
real expiry-rollover procedure. Routed on the `positional` bus.

```
CONFIG: underlying, strikeStep, indicator: Supertrend(period=14, mult=5) on 5-min futures
        candles over a rolling 30-day window, hedgeWidth = 300, lots = 8,
        stateId = '60e6c79e1c2c6d4e5972bac4' in model `strategyData`,
        evalCron = '0 */5 * * * 1-5', rollCron = '0 0 15 * * 4'   (Thursday 15:00)

ON START (09:17:00) + EVERY 5 MIN:
  state = await StrategyData.findById(stateId)          # {currentPosition, positions}
  state.currentPosition ||= 'NONE'
  retry up to 10 times until zapi.getQoute(futureToken) yields a last_price:
    candles = await zapi.historyData(futureToken, '5minute', today−30d, today)
    candles = Supertrend(candles, 14, 5)
    c = candles[-1]
    up = ceil(ltp/strikeStep)*strikeStep ; dn = floor(ltp/strikeStep)*strikeStep
    if state.currentPosition != 'LONG'  and c.supertrend < c.close:      # BULLISH
        closePositions(state.positions)                                  # unwind SELLs then BUYs
        BUY  chain[(dn − hedgeWidth) + 'PE'] (lots)                      # hedge leg first
        SELL chain[dn + 'PE'] (lots)                                     # bull put spread
        state.positions = {BUY:[…], SELL:[…]};  state.currentPosition = 'LONG';  save()
    if state.currentPosition != 'SHORT' and c.supertrend > c.close:      # BEARISH
        closePositions(state.positions)
        BUY  chain[(up + hedgeWidth) + 'CE'] (lots)
        SELL chain[up + 'CE'] (lots)                                     # bear call spread
        state.positions = {BUY:[…], SELL:[…]};  state.currentPosition = 'SHORT'; save()
  on any error: await zapi.login() and continue the retry loop

closePositions(p):   # ORDER MATTERS — buy back the shorts first, then sell the hedges
  eachSeries(p.SELL, leg => Positional.trackOrder(leg, 'BUY', tag, lots))
  then eachSeries(p.BUY,  leg => Positional.trackOrder(leg, 'SELL', tag, lots))

EXPIRY SELECTION at startup:
  chain = optionData.weeklyInstruments
  if moment().day() == 4 and IST hour > 14:  chain = optionData.nextWeekInstruments

ON rollCron (Thu 15:00): closePositions(state.positions); state = {positions:{}, 'NONE'};
                         save(); re-resolve optionData; futureToken = currentFuture.token
                         # NOTE: process is NOT exited — it rolls and keeps running
```

Exits: Supertrend flip (flip-and-reverse), Thursday-15:00 expiry roll (flat), or manual.
No stop-loss, no target. Sizing flat 8 lots.

### IDEA 6 — `spread-ladder-engine` (1 file, `combo-trade.js`) — **highest carry-forward value**

The one place in the whole repository where **a strategy is already a config record, not a
file**. A generic N-leg spread executor driven by documents in the `spreads` collection,
hot-reloaded via a MongoDB change stream. This is the precedent the target architecture should
generalise.

```
CONFIG RECORD (model `spreads`; schema is free-form — properties: {} in spreads.json):
  { name, running: bool, per_trade, total_quantity, entry_quantity, exit_quantity,
    entry_price, exit_price, last_price, leap,
    trades: [ { tradingsymbol, instrument_token, lot_size, trade_action:'BUY'|'SELL',
                quantity } ] }

BOOTSTRAP (09:15:00): subscribe futureToken; load all `spreads` where running == true,
                      subscribe every leg's instrument_token
HOT RELOAD: change stream on `spreads`
  insert                       -> push fullDocument; subscribe its legs          # see R11
  update {running: true}       -> re-findById, subscribe legs, push/replace in memory
  update {running: false}      -> mark in-memory copy running = false

spreadPrice(trades):                        # signed, executable (crossing-the-spread) price
  cmp = 0
  for t of trades:
    if t.trade_action == 'BUY'  : cmp -= ask(t.instrument_token) * t.quantity   # depth.sell[0]
    if t.trade_action == 'SELL' : cmp += bid(t.instrument_token) * t.quantity   # depth.buy[0]
  return cmp                                # false if any depth is missing (try/catch)

EVERY TICK, for every running strategy:
  cmp = spreadPrice(s.trades);  if cmp is falsy: skip

  # ENTRY LADDER — fires when cmp CROSSES entry_price from either side
  if (s.total_quantity − s.entry_quantity) > 0:
      crossed = (s.last_price >= s.entry_price and s.entry_price >= cmp)      # falling through
             or (s.last_price <= s.entry_price and s.entry_price <= cmp)      # rising through
      if crossed:
          for t of s.trades: order(t.instrument_token, t.trade_action, t.quantity * s.per_trade)
          s.entry_quantity += s.per_trade
          if s.leap != 0: s.entry_price = round((s.entry_price + s.leap) * 10) / 10
          setTimeout(() => s.save(), 1500)

  # EXIT LADDER — same crossing test against exit_price, legs reversed
  if (s.entry_quantity − s.exit_quantity) > 0:
      crossed = <same test with exit_price>
      if crossed:
          for t of reverse(s.trades): order(t.instrument_token, flip(t.trade_action),
                                           t.quantity * s.per_trade)
          s.exit_quantity += s.per_trade
          if s.leap != 0: s.exit_price = round((s.exit_price − s.leap) * 10) / 10
          setTimeout(() => s.save(), 1000)

  s.last_price = cmp        # crossing detection is stateful on the previous tick's price
```

Sizing: scale-in/scale-out in `per_trade` chunks up to `total_quantity`; `leap` walks the
entry level *away* and the exit level *toward* you after each chunk (a price ladder).
Exits: only the exit-price ladder. No stop, no target, no EOD square-off.

### IDEA 7 — `premium-decay-limit-strangle` (1 file, `p718-7.js`)

Entry is triggered by the option's **own premium decaying** to a fraction of its price at the
moment the strike slot was created — a synthetic limit order on premium, not a level on the
underlying. Slots accumulate as the ATM walks; each slot has a combined stop that closes only
the losing leg.

```
CONFIG: underlying, strikeStep, ceOffset = +100, peOffset = −100,
        entryTriggerMult = 0.9, stopMult = 1.1, lots = 1,
        startCron = '0 45 15 9 …' (09:15:45), squareOffCron = 15:23:50

EVERY TICK (after a 15 s warmup):
  atm = round(futLtp / strikeStep) * strikeStep
  if !slots[atm]:                                  # a new slot per newly-visited ATM, forever
      ce = chain[(atm + ceOffset) + 'CE'];  pe = chain[(atm + peOffset) + 'PE']
      slots[atm] = { ce, pe,
                     trigger: { ce: ltp(ce) * entryTriggerMult,
                                pe: ltp(pe) * entryTriggerMult },
                     entry:   { ce: false, pe: false },
                     stoploss: false }
  checkTrigger(atm)                                # only the CURRENT atm can open new legs
  for each k in slots: checkStop(k)                # every slot is stop-monitored

checkTrigger(atm):
  s = slots[atm]
  if s.entry.ce === false and ltp(s.ce) <= s.trigger.ce: SELL s.ce (lots); s.entry.ce = ltp(s.ce)
  if s.entry.pe === false and ltp(s.pe) <= s.trigger.pe: SELL s.pe (lots); s.entry.pe = ltp(s.pe)
  if s.entry.ce !== false and s.entry.pe !== false and s.stoploss === false:
      s.stoploss = (s.entry.ce + s.entry.pe) * stopMult      # armed only when BOTH legs are on

checkStop(atm):
  s = slots[atm]; if !s.stoploss: return
  if ltp(s.ce) + ltp(s.pe) >= s.stoploss:
      if ltp(s.ce) >= s.entry.ce: BUY s.ce (lots); s.entry.ce = false   # close only the loser(s)
      if ltp(s.pe) >= s.entry.pe: BUY s.pe (lots); s.entry.pe = false
      s.stoploss = false                                    # disarmed; re-arms if both legs re-fill
```

Exits: combined-premium stop (partial, loser-leg-only), then EOD square-off cron. No target.
Sizing flat 1 lot per leg per slot.

---

## 3. Config axes that regenerate every member file

Beyond the 5 axes already documented for slive, `server/smp/` adds four that exist **only**
here and must not be lost.

### A. Session lifecycle (NEW — smp-only, the family's whole reason for existing)

```ts
session: {
  startCron: string;   // 'ss mm HH * * 1-5' Asia/Kolkata — 21 distinct values across the 134
  exitCron:  string;   // '0 21|22 15' or '40 23 15' or '0 30 15'
  exitGraceMs: 3000 | 5000 | 15000;   // delay before process.exit()
  squareOffOnExit: boolean;           // most legacy files: NO. hft/timer/multi: YES.
}
```
Distinct `startCron` values observed and what they encode:

| start (IST) | files | note |
|---|---|---|
| 09:00:00 | `bn-breakout`, `snx-orb-{1,25,50}` | modern; needs the pre-open 09:15–09:20 range |
| 09:14:00 | `cheetah-b1-15` | earliest legacy entry |
| 09:15:00 | `combo-trade`, `lion-s-15`, `lion-s-40`, `lion-st-15`, `lion-st-25` | |
| 09:15:45 | `p718-7` | |
| 09:15:48 | `cp-s-3370` | |
| 09:16:00 | `cheetah-b1-10`, `cheetah-b1-snx`, `cheetah-s-*`, `cheetah-t-1` | |
| 09:16:30 | `rv-25n`, `rv-40n` | |
| 09:16:40 | `reliance-orb`, `rv-3`, `rv-4` | |
| 09:16:45 | all `*-hft-*`, `*-timer-*`, `*-multi-straddle`, `cp-*`, `eagle-*`, `bull-{s,fs,ms,ns,snx,s1,s5,s10,r}`, `falcon-s`, `rv-40`, `strad-ts-*`, `tiger-s-5`, `vwap` | the modal value |
| 09:16:50 | `cheetah-{bf1-30,st-*p,st-60,stp-60}`, `dolphin*`, `jk-s-25`, `lion-*` (most), `nifty-s*`, `samlion-9`, `spt-30*`, `stgl-s`, `strangle-*` | |
| 09:17:00 | `jaguar`, `opt-buy`, `opt-buy-day` | |
| 09:17:10 | `lion-up`, `lion-down` | |
| 09:19:40 | `cheetah-s30-20m` | "+20 min" variants |
| 09:19:45 | `opt-sell` | |
| 09:19:50 | `cheetah-st60-20m` | |
| 09:20:00 | `stgl-25`, `stgl-50` | |
| 09:24:00 | `calc-ce`, `calc-pe` | |
| 09:24:45 | `bull-{10,200,201,300,300i,m,m1,x}`, `bulln-300*` | |
| 09:30:00 | `ce-d-2`, `ce-d-3`, `ce-pd-2`, `pe-d-2`, `pe-d-3`, `pe-pd-2` | spread scanner |
| **10:16:50 / 11:16:50 / 12:16:50** | `samlion-10` / `-11` / `-12` | **entry HOUR is the whole config difference** |

`samlion-{9,10,11,12}` are the clearest proof this axis matters: in slive all four call
`runStrategy()` immediately and are indistinguishable; in smp the only difference between them
is the cron hour. **Delete smp and you lose the fact that these are 09:00/10:00/11:00/12:00
entries.**

### B. Underlying resolution (NEW dimension: static vs dynamic)

```ts
underlying: {
  symbol: 'BANKNIFTY' | 'NIFTY' | 'SENSEX' | 'FINNIFTY' | 'MIDCPNIFTY';
  strikeStep: 50 | 100;
  triggerToken: 'dynamic' | number;   // 'dynamic' = optionData.currentFuture.token
                                      // static:  BANKNIFTY 260105 | NIFTY 256265 |
                                      //          SENSEX 265 | FINNIFTY 257801 | MIDCPNIFTY 288009
}
```
34 smp files use `'dynamic'`; the same 34 files in slive use a literal. `'dynamic'` follows the
monthly-future roll automatically and is the correct choice for the rewrite; the static tokens
are index **spot** tokens (256265 = NIFTY 50 index, 265 = SENSEX index, 260105 = NIFTY BANK
index), so switching between them silently changes the trigger series from **future** to
**spot** — a real basis difference of tens of points. Record which each file used.

### C. Strike selection

```ts
strike:
  | { by: 'atm-offset',  offset: number | 'otmSelector'; roundTo: 50|100 }
  | { by: 'nearest-premium', targetPremium: 120 | 150 | 200 | 250 }   // stgl/strangle family
  | { by: 'synthetic-atm' }                                          // put–call parity, timer/hft
  | { by: 'chain-scan',  band: [lo, hi] | perWeekday }               // opt-* only
  | { by: 'max-pain' }                                               // p718 family
```

### D. Exit basis (all combinations observed)

```ts
exit: {
  stop?: { basis: 'per-leg-pct'      // 1.03 … 1.5   (lion, bull, cheetah, rv, strangle)
                | 'combined-pct'     // 0.95 … 1.25  (lion-sp-*, lion-sl-8, p718-7, strad-ts)
                | 'combined-points'  // 50           (bull-201)
                | 'trailing-points'  // 1, 10, 20, 30, 60 (cheetah-*, spt-*, fox)
                | 'day-extreme'      // opt-sell, reliance-orb
                | 'none';            // eagle-*, timer-*, hft-*, multi-*, vwap, jaguar
          value?: number };
  target?: { basis: 'pct' | 'points' | 'combined-points' | 'premium-target'; value: number };
  timeStop?: { seconds: number };                       // timer-* only
  portfolioBreaker?: { profitRs?: number; lossRs?: number };   // hft/timer/multi/nifty-s/dolphin
  eodSquareOff: boolean;
  dayStop?: { afterLosses?: number; afterWins?: number };      // cp-* only (−2 / +1)
}
```

### E. Sizing

```ts
sizing:
  | { kind:'flat',      lots: 1 | 4 | 8 | 10 | 15 }
  | { kind:'wing-ladder', legs:[{offset,lots}] }        // bull-10: +100/1, +200/2, +300/3, mirrored
  | { kind:'pyramid-linear', step:(n)=>n+1, cap:number }   // hft-avg, multi-straddle
  | { kind:'pyramid-double', step:(n)=>n*2, cap:number }   // snx-hft-double
  | { kind:'flip-double',    lots:10, flipMul:2 }          // spt-30 (see §5 P7)
  | { kind:'chunked-ladder', perTrade:number, total:number, leap:number }  // combo-trade
```

### F. Execution rail (per §1.2 — an *environment* axis, not a strategy axis)

```ts
rail: { bus: 'paper-trade' | 'positional';
        directZerodha: boolean;      // true only if getAccounts() populates running_accounts
                                     // in smp: ONLY snx-orb-{1,25,50}
        orderShape: 'market-only' | 'market+slm' | 'market+slm+limit-oco' }
```

---

## 4. Full member table (134 files)

`rail`: `PT`=`PaperTrade` bus, `POS`=`positional` bus, `AA`=`Account.placeAllAccount`
(bus + dormant Zerodha), `SLM`=also emits `trackOrder_slm`.
`twin`: the slive file with the same engine, `—` if none.

| file | tag | underlying / step | trigger token | start | exit | rail | idea | twin | distinguishing config |
|---|---|---|---|---|---|---|---|---|---|
| `bn-breakout.js` | BN_BREAKOUT | BANKNIFTY/100 | dynamic | 09:00:00 | 15:30:00 | PT+AA | modern ORB-band | `bn-breakout` | 1 trade/day (slive: 1 per side, loss-gated) |
| `snx-orb-1.js` | SNX_ORB_1 | SENSEX/100 | 265 | 09:00:00 | 15:30:00 | AA (live!) | modern ORB | identical | — |
| `snx-orb-25.js` | SNX_ORB_25 | SENSEX/100 | 265 | 09:00:00 | 15:30:00 | AA (live!) | modern ORB | identical | — |
| `snx-orb-50.js` | SNX_ORB_50 | SENSEX/100 | 265 | 09:00:00 | 15:30:00 | AA (live!) | modern ORB | identical | — |
| `bn-timer-120.js` | BN_TIMER_120 | BANKNIFTY/100 | 260105 | 09:16:45 | 15:21:00 | PT | **1** | — | timer 120 s, tgt +5 |
| `bn-timer-straddle.js` | BN_TIMER_STRADDLE | BANKNIFTY/100 | 260105 | 09:16:45 | 15:21:00 | PT | **1** | — | timer 30 s, tgt +5 |
| `nf-timer-120.js` | NF_TIMER_120 | NIFTY/**100**¹ | 256265 | 09:16:45 | 15:21:00 | PT | **1** | — | timer 120 s |
| `nf-timer-straddle.js` | NF_TIMER_STRADDLE | NIFTY/**100**¹ | 256265 | 09:16:45 | 15:21:00 | PT | **1** | — | timer 30 s |
| `snx-timer-120.js` | SNX_TIMER_120 | SENSEX/100 | 265 | 09:16:45 | 15:21:00 | PT | **1** | — | timer 120 s |
| `snx-timer-straddle.js` | SNX_TIMER_STRADDLE | SENSEX/100 | 265 | 09:16:45 | 15:21:00 | PT | **1** | — | timer 30 s |
| `bn-hft-avg.js` | BN_HFT_AVG | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | PT | **2a** | `bn-hft` (steps=1) | strikes `[0,500,−500]`, 10 steps, −10 %/step, **no breaker** |
| `nf-hft-avg.js` | NF_HFT_AVG | NIFTY/100¹ | 256265 | 09:16:45 | 15:21:00 | PT | **2a** | `hft-nifty` | tgt 5, trig 2, **steps=1 (off)** |
| `snx-hft-avg.js` | SNX_HFT_AVG | SENSEX/100 | 265 | 09:16:45 | 15:21:00 | PT | **2a** | `hft-averaging` (steps=1) | 10 steps, −5 %/step |
| `snx-hft-double.js` | SNX_HFT_DBL | SENSEX/100 | 265 | 09:16:45 | 15:21:00 | PT | **2a** | — | CE`[100]`/PE`[−100]`, qty **doubles**, breaker ∞ |
| `snx-hft-separate.js` | SNX_HFT_SGL | SENSEX/100 | 265 | 09:16:45 | 15:21:00 | PT | **2a** | — | CE`[100]`/PE`[−100]`, qty linear |
| `bn-multi-straddle.js` | BN_MULTI_STRADDLE | BANKNIFTY/100 | 260105 | 09:16:45 | 15:21:00 | PT | **2b** | — | trig 10, tgt 10 +2/straddle, max 10 |
| `nf-multi-straddle.js` | NF_MULTI_STRADDLE | NIFTY/100¹ | 256265 | 09:16:45 | 15:21:00 | PT | **2b** | — | trig 5, tgt 5 +2 |
| `snx-multi-straddle.js` | SNX_MULTI_STRADDLE | SENSEX/100 | 265 | 09:16:45 | 15:21:00 | PT | **2b** | — | trig 10, tgt 10 +2 |
| `opt-buy.js` | Opt_B | BANKNIFTY chain | 260105 | 09:17:00 | 15:23:40 | PT | **3** | — | band (121,161), 1.5× breakout, SL −20 |
| `opt-buy-day.js` | Opt_BD | BANKNIFTY chain | 260105 | 09:17:00 | 15:23:40 | PT | **3** | — | per-weekday bands |
| `opt-sell.js` | Opt_S | BANKNIFTY chain | 260105 | 09:19:45 | 15:23:40 | PT | **3** | — | `open==high`, band [100,400], stop = day high |
| `vwap.js` | VWAP | BANKNIFTY/100 | dynamic | 09:16:45 | 15:22:00 | PT | **4** | — | ±100 OTM, 3-min cron, LTP vs own VWAP |
| `jaguar.js` | Jaguar | BANKNIFTY/100 | 260105 | 09:17:00 | Thu 15:00 roll | POS | **5** | — | Supertrend(14,5) 5-min, hedge 300, 8 lots, persisted |
| `combo-trade.js` | *(per record)* | any legs | 260105 | 09:15:00 | 15:29:00 | PT | **6** | — | DB-driven N-leg spread ladder |
| `p718-7.js` | P718-7 | BANKNIFTY/100 | 260105 | 09:15:45 | 15:23:50 | PT | **7** | — | trigger 0.9×, stop 1.1× combined, ±100 |
| `p718-5.js` | P718-5 | BANKNIFTY/100 | 260105 | 09:17:45 | **14:58:00** `squareOff()`, no `process.exit` | PT | p718 straddle | `p718-5` (22 crons) | smp = simple tick version; earliest square-off in the directory |
| `cp-s-2040.js` | CP_S_2040 | BANKNIFTY/100 | dynamic | 09:16:45 | 15:22:00 | PT (v2) | cp momentum-fade | `cp-s-2040` | ±20 breakout, SL 1.20, tgt 0.60, tick-driven exits |
| `cp-ns-2040.js` | CP_NS_2040 | NIFTY/**100**¹ | 256265 | 09:16:45 | 15:22:00 | PT (v2) | cp | `cp-ns-2040` | as above, NIFTY |
| `cp-snx-2040.js` | CP_SNX_2040 | SENSEX/100 | 265 | 09:16:45 | 15:22:00 | PT (v2) | cp | `cp-snx-2040` | as above, SENSEX |
| `cp-s-3370.js` | CP_S_3370 | BANKNIFTY/100 | dynamic | 09:15:48 | 15:22:00 | PT (v2) | cp | `cp-s-3370` | absolute-point SL/target |
| `lion-s-25.js` | Lion_S_25 | BANKNIFTY/100 | dynamic | 09:16:50 | 15:23:40 | AA | lion ATM-cross strangle | `lion-s25-1` | SL 1.25 per leg |
| `lion-s-15.js` | Lion_S_15 | BANKNIFTY/100 | dynamic | 09:15:00 | 15:23:40 | AA | lion | `lion-s15-zzJ4351` | SL 1.15 |
| `lion-s-40.js` | Lion_S_40 | BANKNIFTY/100 | dynamic | 09:15:00 | 15:23:40 | AA | lion | — (config) | SL 1.40 |
| `lion-st-15.js` | Lion_ST_15 | BANKNIFTY/100 | dynamic | 09:15:00 | 15:23:40 | AA | lion trailing | `lion-st15-1` | trailing SL |
| `lion-st-25.js` | Lion_ST_25 | BANKNIFTY/100 | dynamic | 09:15:00 | 15:23:40 | AA | lion trailing | `lion-st25-1` | trailing SL |
| `lion-fs-25.js` | Lion_FS_25 | FINNIFTY/50 | 257801 | 09:16:50 | 15:23:40 | AA | lion | `lion-fs25-1` | — |
| `lion-ms-25.js` | Lion_MS_25 | MIDCPNIFTY/50 | 288009 | 09:16:50 | 15:23:40 | AA | lion | `lion-ms25-1` | — |
| `lion-snx-25.js` | Lion_SNX_25 | SENSEX/100 | 265 | 09:16:50 | 15:23:40 | AA | lion | `lion-snx-1` | `otmSelector('Lion_SNX')` |
| `lionN-s-25.js` | Lion_NS_25 | NIFTY/50 | 256265 | 09:16:50 | 15:23:40 | AA | lion | `lion-ns25-1` | — |
| `lion-sl-25.js` | Lion_SL_25 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion fixed-SL | `lion-0020` | — |
| `lion-es-25.js` | Lion_ES_25 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion | `lion-0020` | early-session variant |
| `lion-sh-25.js` | Lion_SH_25 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion | `lion-0020` | hedged variant |
| `lion-sl-8.js` | Lion_SL8T5 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion combined SL+TGT | — | SL 1.08 + target 0.95, **combined** |
| `lion-sp-25.js` | Lion_SP_25 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | **POS** | lion combined-premium | `lion-sp5-1` | 10 lots, `positional` bus |
| `lion-sp-3.js` | Lion_SP_3 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion combined | — | combined stop 0.97 |
| `lion-sp-5.js` | Lion_SP_5 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion combined | `lion-sp5-1` | combined stop 0.95 |
| `lion-b-25.js` | Lion_B_25 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion **BUY** side | `lion-b25-1` | — |
| `lion-b-3.js` … `lion-b-6.js` | Lion_BP_3…6 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion combined | — | combined stop 1.03/1.04/1.05/1.06 |
| `lion-up.js` | Lion_Up | BANKNIFTY/100 | 260105 | 09:17:10 | 15:23:40 | AA | lion directional | `lion-up-1` | buys near-ATM below strike |
| `lion-down.js` | Lion_Down | BANKNIFTY/100 | 260105 | 09:17:10 | 15:23:40 | AA | lion directional | — | mirror of `lion-up` |
| `jk-s-25.js` | JK_S_25 | BANKNIFTY/100 | dynamic | 09:16:50 | 15:23:40 | AA | lion (jk fork) | `jk-0020` | dual SL tracker |
| `nifty-s.js` | Nifty_S_25 | NIFTY/50 | dynamic | 09:16:50 | 15:23:40 | AA | lion + profit breaker | `nifty-s-1789` | farOtm 400, `target_profit = 25` polled via `PaperTrade.positions` |
| `nifty-s-50.js` | Nifty_S_50 | NIFTY/50 | dynamic | 09:16:50 | 15:23:40 | AA | as above | `nifty-s-sbm95` | — |
| `dolphin.js` | DolphinBN | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | lion + combined target | `dolphin-0020` | farOtm 200, `target_profit = 70` |
| `dolphin-bs2.js` | DolphinBN_S2 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | as above | `dolphin-0020` | `otmSelector()` |
| `bull-s.js` | Bull_S | BANKNIFTY/100 | dynamic | 09:16:45 | 15:22:00 | PT | bull straddle, pyramid-up | `bull-s-1` | SL 1.05 |
| `bull-s1.js` `bull-s5.js` `bull-s10.js` | Bull_S1/S5/S10 | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | PT | bull | `bull-s-1`, `bull-s5-1` | SL tiering |
| `bull-fs.js` `bull-ms.js` `bull-ns.js` `bull-snx.js` | Bull_FS/MS/NS/SNX | FIN/MIDCP/NIFTY/SENSEX | 257801/288009/256265/265 | 09:16:45 | 15:22:00 | PT | bull | `bull-*-1` | underlying only |
| `bull-r.js` | Bull_R | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | PT | bull sizing **down** 7→0 | `bull-r` | — |
| `bull-m.js` `bull-m1.js` | Bull_M/M1 | BANKNIFTY/100 | dynamic/260105 | 09:24:45 | 15:22:00 | PT | bull tight wings | `bull-m`, `bull-m2` | 100/200/300 independently stopped |
| `bull-300.js` `bull-300i.js` | B300/B300i | BANKNIFTY/100 | dynamic | 09:24:45 | 15:22:00 | PT | bull 6-wing basket | `bull-300`, `bull-300i` | OTM vs ITM mirror |
| `bulln-300.js` `bulln-300i.js` | N300/N300i | NIFTY/50 | dynamic | 09:24:45 | 15:22:00 | PT | bull basket | `bulln-300*` | — |
| `bull-x.js` | Bull_X | BANKNIFTY/100 | 260105 | 09:24:45 | 15:22:00 | PT | 3-strike rolling ladder | `bull-x` | never flat |
| `bull-10.js` | Bull-10 | BANKNIFTY/100 | dynamic | 09:24:45 | 15:22:00 | PT | wing ladder w/ qty ramp | — | +100/1, +200/2, +300/3 (mirrored) |
| `bull-200.js` `bull-201.js` | B200/B201 | BANKNIFTY/100 | dynamic | 09:24:45 | 15:22:00 | PT | premium-target strikes | `bull-200-1` | `-201`: fixed 50-pt stop + reverse re-entry |
| `eagle-s.js` `eagle-fs.js` `eagle-ms.js` `eagle-ns.js` `eagle-snx.js` | Eagle_* | per suffix | dyn/257801/288009/256265/265 | 09:16:45 | 15:22:00 | PT | eagle pyramid, **no stop, never closes** | `eagle-*-1` | underlying |
| `eagle-p.js` | Eagle_P | BANKNIFTY/100 | dynamic | 09:16:45 | 15:22:00 | PT | eagle, adds a full PAIR | `eagle-p-1` | — |
| `eagle-sh.js` | Eagle_SH | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | PT | eagle hedged | — | 82-line delta vs `eagle-s-1` |
| `eagle-sp.js` | Eagle_SP | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | **POS** | eagle, `positional` bus | `eagle-p-1` | — |
| `falcon-s.js` | Falcon_S | BANKNIFTY/100 | dynamic | 09:16:45 | 15:22:00 | PT | 2-slot rolling straddle | (≈`bull-x`) | fires on 50 **or** 100-pt crossing; 4 lots then 2+2; rolls the slot farthest from ATM |
| `cheetah-s-10/20/30.js` | Cheetah_S_10/20/30 | BANKNIFTY/100 | 260105 | 09:16:00 | 15:23:40 | AA | cheetah momentum-fade trail | `cheetah-1910` etc. | trail 10/20/30 |
| `cheetah-s2-30.js` | Cheetah_S2_30 | BANKNIFTY/100 | 260105 | 09:16:00 | 15:23:40 | AA | cheetah | `cheetah-s-2203` | 2-leg variant |
| `cheetah-s30-20m.js` | Cheetah_S30_20m | BANKNIFTY/100 | 260105 | **09:19:40** | 15:23:40 | AA | cheetah | — | +20 min entry |
| `cheetah-st-60.js` `cheetah-st60-20m.js` | Cheetah_ST_60 / ST60_20m | BANKNIFTY/100 | 260105 | 09:16:50 / **09:19:50** | 15:23:40 | AA | cheetah trail | `cheetah-2117` | trail 60 |
| `cheetah-st-15p/20p/25p.js` | Cheetah_SP_15/20/25 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | cheetah **percent** trail | `cheetah-2117` | `trail_sl = 1` + pct 15/20/25 |
| `cheetah-stp-60.js` | Cheetah_STP_60 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | premium-target strike | `cheetah-stp-2117` | nearest-to-₹250 |
| `cheetah-t-1.js` | Cheetah_T1 | BANKNIFTY/100 | 260105 | 09:16:00 | 15:23:40 | AA | cheetah + fixed target | — | trail 30 **and** `tgt_points = 70` |
| `cheetah-bf1-30.js` | Cheetah_BF1_30 | BANKNIFTY/100 | dynamic | 09:16:50 | 15:23:40 | AA | cheetah BUY side | (≈`cheetah-bt-2117`) | trail 30, hardcoded `lot_size: 25` (see R13) |
| `cheetah-b1-10.js` `cheetah-b1-15.js` `cheetah-b1-snx.js` | Cheetah_B1_10/915/SNX | BANKNIFTY / SENSEX | dyn / 265 | 09:16:00 / **09:14:00** / 09:16:00 | 15:23:40 | AA | b1 martingale BUY | `cheetah-b1-1/-2/-snx` | trail 10 |
| `samlion-9/10/11/12.js` | SamLion_9/10/11/12 | BANKNIFTY/100 | dyn/260105 | **09/10/11/12**:16:50 | 15:23:40 | AA | 10-pair wing ladder | `samlion-9/10/11/12` | **entry hour is the only difference** |
| `rv-40.js` | RV-40 | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | PT | rv roll-leg strangle | `rv-40` | OTM 100, SL 1.40, tgt 0.50, max_sl 2 |
| `rv-40n.js` `rv-25n.js` | RV-40n / RV-25n | NIFTY/50 | 256265 | 09:16:30 | 15:22:00 | PT | rv | `rv-40n`, `rv-25n` | OTM 50 |
| `rv-3.js` | RV-3 | BANKNIFTY/100 | 260105 | 09:16:40 | 15:23:40 | PT | rv | — (config) | SL 1.25, tgt 0.75, max_sl **3**, `OTM = 0` on Wednesdays |
| `rv-4.js` | RV-4 | BANKNIFTY/100 | 260105 | 09:16:40 | 15:23:40 | PT | rv + **calendar hedge** | — | every roll also trades the same strike in `nextWeekInstruments` on the opposite side |
| `stgl-s.js` | STGL-25 | BANKNIFTY/100 | dynamic | 09:16:50 | 15:22:00 | AA+SLM | stgl wing sell | `stgl-s` | smp: **single** 100-pt pair; slive: 100/200/300/400 (4 pairs) |
| `stgl-120.js` | STGL-25 | BANKNIFTY/100 | 260105 | **none — bare `runStrategy()` at line 236** | **none** | AA+SLM | stgl | `stgl-s` | farOtm 100; zero CronJobs, no square-off, no exit. Tag collides with 3 other files. See R14 |
| `stgl-25.js` | STGL-25 | BANKNIFTY/100 | 260105 | 09:20:00 | 15:23:40 | AA | stgl | `stgl-s2` | SL 1.25 |
| `stgl-50.js` | STGL-50 | BANKNIFTY/100 | dynamic | 09:20:00 | 15:22:00 | AA | premium-120 strangle | `stgl-s2` | tgt 0.25, SL 1.5, one-shot 09:30 cron |
| `strangle-25.js` | STGL-25 | BANKNIFTY/100 | 260105 | 09:16:50 | 15:22:00 | AA | nearest-₹250 strangle | `stgl-s2` | SL 1.25 |
| `strangle-mid.js` | STGL-Mid | BANKNIFTY/100 | 260105 | 09:16:50 | 15:22:00 | AA | nearest-₹250 + reversion re-entry | `stgl-mid-0020-1` | re-enters when spot re-crosses `tradeStartPrice` |
| `strangle-3.js` | STGL-3 | BANKNIFTY/100 | dynamic | 09:16:50 | 15:22:00 | AA | premium chain 250→200→150 | `stgl-p-2117` | 3 stacked entries off its own stop-outs |
| `strangle-p.js` | STGL-Pair | BANKNIFTY/100 | 260105 | 09:16:50 | 15:22:00 | AA | as above, pairs | `stgl-p-2117` | — |
| `spt-30.js` | Strad_30T | BANKNIFTY/100 | dynamic | 09:16:50 | 15:23:40 | AA | pair-open direction + trail | (`fox-1`) | 10 lots, flip at **2×** qty, trail 60 |
| `spt-30s.js` | Strad_30TS | BANKNIFTY/100 | 260105 | 09:16:50 | 15:23:40 | AA | as above | `fox-1` | BUY branch `mul = 0` (**tracking only**), flips at 1×, `maxOrderCount = 6` |
| `strad-ts-20.js` | StradTS-20 | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | PT | pair-open direction, **pct** trail | — | ATM gate, ±100 legs, SL 40 %/25 %, max 5 |
| `strad-ts-33.js` | StradTS-33 | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | PT | as above | — | ±100 gate, SL 20 %/15 % |
| `tiger-s-5.js` | Tiger_S_5 | BANKNIFTY/100 | 260105 | 09:16:45 | 15:22:00 | AA | combined-stop leg-roll | (`rv-s2`) | SL 5 % combined; on breach rolls the *big* leg to the new ATM, alternating `moveLeg` big/small |
| `ce-d-2.js` `ce-d-3.js` `pe-d-2.js` `pe-d-3.js` | CE_D_2/3, PE_D_2/3 | BANKNIFTY/100 | 260105 | 09:30:00 | 15:23:40 | POS | debit-spread scanner | `ce-d2-0020` etc. | `otmSelector('SD_2'\|'SD_3')`, `per_trade_qty = 15`, uses `depth` |
| `ce-pd-2.js` `pe-pd-2.js` | CE_PD_2, PE_PD_2 | BANKNIFTY/100 | 260105 | 09:30:00 | 15:23:40 | POS | ratio-spread scanner | `ce-d2p-extra` etc. | ratio leg sizing |
| `calc-ce.js` `calc-pe.js` | Calc_CE/PE | BANKNIFTY/100 | dynamic | 09:24:00 | 15:22:00 | PT | 2-leg calendar/vertical calc | `cal-ce`, `cal-pe` | **only** diff from slive is the cron wrapper |
| `reliance-orb.js` | Rel_ORB | RELIANCE equity | — | 09:16:40 (+ inner cron 09:20:00 freezes the range, then `checkLimit` every 5 min) | 15:23:40 | AA | equity ORB | — | day-high/low breakout, stop = opposite extreme, target ±₹10. **Broken: see R12** |
| `hdfc_spread.js` | HDFC_SPD | HDFC / HDFCBANK futures | — | 09:16:00 (entry point is `init`, not `runStrategy`) | 15:26:00 | POS | stock-pair ratio spread | — | `2 × ask(HDFCBANK) − bid(HDFC)` ladder, state in `strategyData`. **Dead: underlying merged 2023-07** |

¹ NIFTY strike step is 50; these files round to 100. See risk **R5**.

---

## 5. Behaviours that MUST survive the rewrite

**P1 — Session cron is part of the strategy, not the deployment.** 130 files carry a
`startCron` (21 distinct values, some differing by 1 second) and an `exitCron`. `samlion-9/10/11/12`
and `cheetah-{s-30, s30-20m}` / `{st-60, st60-20m}` differ *only* in start time. Model it as
`session.startCron` / `session.exitCron` / `session.exitGraceMs`, and preserve the exact
seconds — they are staggered deliberately to spread the Sensibull/Kite login burst.

**P2 — Warm-up staging before the first trade.** Every file waits 5 000 / 10 000 / 15 000 /
25 000 ms after the feed connects, then (usually) a further 5 000 ms, before setting
`startTrade = true`, and it seeds `lastQuote` from `ticksCache[futureToken].last_price` inside
that first timeout. Skipping the wait makes the first crossing test fire against `lastQuote = 0`
(→ a spurious "crossed up" on the very first tick). Replicate as an explicit
`awaitFirstQuote(token)` + `warmupMs` precondition, not a `setTimeout`.

**P3 — `async.queue(fn, 1)` is the only re-entrancy guard.** Ticks arrive in batches and
`checkTicks` pushes one task per batch onto a concurrency-1 queue. Every mutation of
`optionOrders` / `positions` / `slots` happens inside that serialised task. Two separate queues
(`takePositionQ` and `checkSLQ`) run *concurrently with each other* — entry and exit logic can
interleave. Preserve the serialisation; consider whether entry/exit should share one queue
(safer) and note the behaviour change if you merge them. The queues are **unbounded** — on a
tick burst thousands of tasks pile up.

**P4 — Tick-availability preconditions everywhere.** The newer files guard with `?.last_price`
and bail; the older ones index `ticksCache[token].last_price` unguarded and throw on the first
tick batch that does not include that token (see R7). The rewrite must make
"quote not yet available" a first-class, *retryable* state rather than either a crash or a
silent permanent skip.

**P5 — Bus writes are fire-and-forget.** `PaperTrade.trackOrder*` and `Positional.trackOrder`
call `Model.create({...})` **without awaiting or returning it**. `await trackOrder(...)`
therefore resolves *before* the document exists. Two consequences to preserve/repair:
(a) EOD square-off followed by `process.exit()` after 3–5 s races the write — in
`bn-multi-straddle` up to 20 order documents must land in that window;
(b) order *sequence* across two `trackOrder` calls is not guaranteed at the consumer.
Where sequence matters (`jaguar.closePositions` buys back shorts **before** selling hedges;
`combo-trade` reverses leg order on exit) the ordering is load-bearing for margin.

**P6 — Frozen vs re-centred ATM.** `*-multi-straddle` freezes `baseATM` at start and uses it
for *every* subsequent entry all day (so after a 500-point move it is still trading the
morning's strike). `*-hft-avg` re-centres on the current ATM after each square-off.
`*-timer-*` re-computes `syntheticATM` on **every** entry. These are three different, deliberate
behaviours — do not unify them; make it `atmPolicy: 'frozen' | 'recentre-on-flat' | 'per-entry'`.

**P7 — Flip-by-double-quantity.** `spt-30` closes a 10-lot short and opens a 10-lot long with a
*single* 20-lot BUY (`sendOrder(atm, 'BUY', 2)` → `placeAllAccount(..., 10 * mul)`). Net exposure
stays ±10 lots; gross per order is 20. If the rewrite emits separate close+open orders the
margin profile and the broker fee change. `spt-30s` uses the same trick with `mul = 1`
(close-only) and `mul = 0` on its initial BUY branch — meaning **that branch records a position
and places no order at all** (a tracking-only/paper leg inside a live strategy).

**P8 — Phantom / tracking-only states.** `strad-ts-*` records a `tradeSide: 'BUY'` `tradeObj`
and places **no orders** for it; its "stop" is really a re-entry gate that fires when the
combined premium retraces `SL_Buy_percent` from its high, at which point the strategy sells
again. Removing the phantom BUY state removes the cooldown and the strategy would re-sell
immediately. `max_trades = 5` decrements only on real SELL entries.

**P9 — Partial, loser-leg-only exits.** `p718-7` (combined stop → closes only legs trading
above their own entry, then **disarms** the stop so the surviving leg keeps running),
`lion-sl-8`, `lion-sp-*`, `tiger-s-5` (rolls the losing leg rather than closing) and `rv-*`
(rolls a leg further OTM at −40 % or back toward ATM at +50/60 %, capped by `max_sl_count`) all
implement per-leg, non-symmetric exits. A naive "flatten the position" exit destroys the edge.

**P10 — Geometric target decay on averaging.** `addEntry` in idea 2a multiplies
`slot.currentTarget` by `(1 − targetReductionPct/100)` on every non-initial entry, and resets it
to `targetPoints` on square-off. With `targetReductionPct = 10` and 10 steps the target shrinks
to 0.9⁹ ≈ 39 % of its initial value. Conversely `*-multi-straddle` *escalates*
(`initialTargetPoints + targetIncrement * totalStraddlesCreated`) using a counter that never
resets — see R6.

**P11 — Expiry rollover.** Only `jaguar` (Thursday after 14:00 IST → `nextWeekInstruments`, plus
a Thursday-15:00 roll cron that closes everything and re-resolves the chain **without exiting
the process**) and `rv-4` (deliberate cross-expiry calendar leg using `nextWeekInstruments`)
handle expiry. Everything else pins `weeklyInstruments` at startup and would trade an expired
chain if the process outlived the day — which, with `startCron`+`process.exit()`, it does not.
In a long-lived TS runner **rollover becomes mandatory for all of them**.

**P12 — `positional` is a second live bus.** 6 smp files (`ce-pd-2`, `pe-pd-2`, `ce-d-*`,
`pe-d-*`, `eagle-sp`, `hdfc_spread`, `jaguar`, `lion-sp-25`) write to `app.models.positional`,
not `PaperTrade`. `xtsOrder.js:314`, `sparkOrder.js:169`, `am_xtsOrder*.js` and
`paperstream.js:416` all watch that collection too. It must be modelled as a distinct order
channel, not treated as dead.

**P13 — `otmSelector` is called at startup only.** `farOtm` is resolved once inside
`runStrategy()`. Because the value is weekday-dependent, a process that survives midnight would
use a stale offset. With `startCron` this never happens today; in the new runner, re-resolve
per session.

**P14 — Order-flag ordering in the cp/hft/p718 slive twins.** Where the slive version uses the
`OrderUpdate` change stream, the sequence is: place entry with `dataObj:[eventId]` → on
`status == 'Filled'` compute stop and target from the **actual fill price** → place
`trackOrder_slm` + `trackOrder_limit` as an OCO pair → on either fill, call
`XtsAccount.removePending(accountId, tag, cb)` to cancel the sibling. The smp versions instead
evaluate stop/target from `ticksCache` LTP and emit a MARKET close. Both semantics exist in
production; the rewrite needs `exitMechanism: 'in-process-tick' | 'broker-oco'` as an explicit
axis, because they differ in slippage, in what happens on a gap, and in whether the stop
survives a strategy crash (broker-OCO does; in-process does **not**).

**P15 — Per-order quantity tranching.** `placeAllAccount` splits any order above 60 lots
(BANKNIFTY) / 36 (NIFTY) / 100 (other) into tranches. The pyramiding strategies reach these
limits (`snx-hft-double` at step 7 is 64 lots). Keep the tranching, keep the limits per symbol
prefix.

---

## 6. Bugs, dead code and dangerous behaviour

**R1 — `otmSelector` makes every "OTM" seller trade ATM.** `server/lib/otmSelector.js` returns
`0` on every branch for `'Lion'`, `'Lion_SNX'` and `'Cheetah'`. 40 smp files call it. So
`lion-*`, `cheetah-*`, `jk-*`, `nifty-s*`, `dolphin*`, `spt-*` and `opt-buy` all sell **at the
money** despite the naming and the `farOtm` variable. Any historical P&L attributed to "OTM"
configs is actually ATM P&L.

**R2 — `otmSelector('SD_2')` and `('SD_3')` return `undefined` on Thursdays.** Both branches
test `day() == 3` **twice** and never test `day() == 4`; days 0 and 6 are also unhandled. The 6
smp callers (`ce-d-2`, `ce-d-3`, `ce-pd-2`, `pe-d-2`, `pe-d-3`, `pe-pd-2`) all start at 09:30
Mon–Fri, so **every Thursday they destructure `undefined` and crash**. Same defect in the 6
slive twins.

**R3 — Averaging is disabled in production, enabled in staging.** `slive/{bn-hft, hft-averaging,
hft-nifty}.js` ship `MAX_AVERAGING_STEPS = 1`, which makes the pyramid unreachable; the smp
copies ship `10`. If smp is deleted, the only record that the strategy was *meant* to pyramid
(and with what trigger and target-decay) disappears. Conversely, deploying the smp config to
live multiplies the position by up to 55× (linear ladder 1+2+…+10) with **no stop-loss at all**.

**R4 — `snx-hft-double` has an effectively infinite portfolio breaker and a doubling ladder.**
`PROFIT_TARGET = 100000000` (₹10 crore) never fires, `MAX_AVERAGING_STEPS = 10` and
`nextQty = lastEntry.qty * 2` → 1,2,4,…,512 = **1 023 lots** on a SENSEX pair, with no
stop-loss. This is the single most dangerous config in the directory.

**R5 — Wrong strike step on NIFTY.** `nf-timer-120`, `nf-timer-straddle`, `nf-multi-straddle`,
`nf-hft-avg` and `cp-ns-2040` round to `100` while trading the NIFTY chain, whose strikes are
`50` apart. Effect: half the chain is unreachable and the chosen "ATM" can be 50 points from the
true ATM — a material mispricing on a 5-point target. (`lionN-s-25`, `bulln-300`, `bull-ns`,
`eagle-ns` correctly use `50`.)

**R6 — `*-multi-straddle` target escalates without bound.** `targetPoints =
INITIAL + INCREMENT * totalStraddlesCreated`, and `totalStraddlesCreated` never resets. After
30 completed cycles a new straddle needs +70 points on the combined premium; combined with the
frozen `baseATM` (P6) and **no stop-loss**, positions accumulate to `MAX_STRADDLES = 10` and are
held to the 15:21 square-off. Also: the pyramid trigger compares the *live* `baseATM` pair price
to `lastEntryPrice`, but `lastEntryPrice` is set from whichever straddle was created last — so a
re-entry at a higher price resets the ladder upward.

**R7 — Silent permanent slot death on a missing quote.** `takeInitialPosition` (idea 2a),
`createTimerStraddle` (idea 1) and `createNewStraddle` (idea 2b) all `return` without
rescheduling when `chain[strike]` is missing or its LTP is not yet in `ticksCache`. For idea 2a
this happens on the post-square-off `setTimeout` restart too, so a single missing tick kills that
strike slot for the rest of the day with no log at error level.

**R8 — `opt-buy` / `opt-buy-day` leak the per-type slot on a target exit.** The stop path clears
`position[type] = false`; the target path does not. After one winning trade that option type is
blocked for the day. Also `strikesTraded[token]` is incremented **before** the
`< maxPerStrike` test, so the effective cap is 3 trades, not 4, and it increments even when the
`position[type]` guard rejects the trade — the counter is inflated by rejected attempts. Both
files also index `ticksCache[opt.instrument_token].last_price` for **every** chain instrument
with no guard: the first tick batch that omits any subscribed token throws inside the queue task.

**R9 — `vwap.js` creates phantom positions.** `currentOpenStrikes[side]` is assigned the strike
*before* the `ltp < vwap` test:
```js
currentOpenStrikes.ce = new_ATM_Strike + farOtm;      // marked open …
if (ce_ltp < ce_avg) { SELL; return; }                // … but only sold if this passes
```
If the condition fails, the side is recorded as open with **no order placed**. On the next
3-minute tick the `else` branch runs and, when `ltp > vwap`, issues a **BUY with no prior
SELL** — an unintended naked long. Additionally: no stop-loss, no target, no EOD square-off
(the 15:22 cron only calls `process.exit()`), and the strike is captured once and never
re-centred, so a strong trend leaves a deep-ITM short open overnight.

**R10 — `combo-trade.js` defects.**
- `'BUy'` typo (line 134) in the exit branch → `transaction_type: 'BUy'`; XTS/Zerodha reject it
  and `PaperTrade.positions` mis-signs the quantity. **Exits are broken.**
- `trades.reverse()` (line 129) mutates the strategy document's own array in place; the
  subsequent `s.save()` persists the reversed leg order permanently, so the *next* entry places
  its legs in the wrong order (hedge after risk).
- The change-stream `insert` branch pushes the raw `event.fullDocument` (a plain object), while
  the `update` branch pushes a loopback model instance. A strategy inserted-then-run in the same
  process throws on `strategy.save()`.
- `_SP` (line 215) references an undeclared `token` — dead but a `ReferenceError` if ever called.
- `checkSpreads()` is invoked from `checkTicks` with **no queue and no await**, so ladder
  bookkeeping (`entry_quantity += per_trade`) races itself on adjacent ticks and can double-fire
  a chunk; the `setTimeout(save, 1500)` widens the window.

**R11 — `hdfc_spread.js` is dead.** HDFC Ltd merged into HDFC Bank on 2023-07-13; there is no
HDFC single-stock future, so `futureConfig` cannot resolve `futuresToken['HDFC']` and every
`Positional.trackOrder(undefined, …)` throws. (Its start cron at 09:16 calls `init`, not
`runStrategy` — which is why a `runStrategy`-based grep reports it as unscheduled.) Delete;
keep the "2:1 stock-pair ratio ladder with `strategyData` persistence" pattern as a note only.

**R12 — `reliance-orb.js` is broken multi-symbol code.** `placeTrade()` maps over
`Object.values(tradeableSymbols)` but reads `ticksCache[instrumentToken]` — a single module-level
variable — for every symbol, so all symbols get RELIANCE's high/low. It also mutates the shared
`symb` objects while building both `pendingOrdersBuy` and `pendingOrdersSell`, so each entry ends
up with **both** limits. Treat as an abandoned experiment; the ORB idea is properly implemented
in `slive/orb-fut-core.js`.

**R13 — `cheetah-bf1-30.js` hardcodes `lot_size: 25`.** BANKNIFTY's lot size changed (25 → 15
→ 35); a literal in the strategy file silently mis-sizes every order.

**R14 — `stgl-120.js` has no schedule at all and no exit.** It contains **zero** `CronJob`s and
ends with a bare `runStrategy()` at line 236 — the only smp file like this. It therefore starts
the moment the process starts (any time of day, including a weekend restart, when `ticksCache`
never fills and `runStrategy`'s warmup timeout throws on
`ticksCache[futureToken].last_price`), never squares off, and never exits. Its
`strategyTag` is `'STGL-25'`, **shared with `stgl-25.js`, `stgl-s.js` and `strangle-25.js`** —
four different engines writing to one tag, so their orders and P&L are merged in `paper-trade`,
in `PaperTrade.positions()`, in `PaperTrade.squareoff(tag)` and at every bus consumer (a
squareoff of one nets the other three). Tags must be unique in the rewrite; also note
`stgl-s.js` and `stgl-25.js` in **slive** share tags with their smp namesakes, so running both
directories at once merges them across deployments.

**R15 — `delete arr[idx]` inside `forEach`.** `opt-buy`, `opt-sell`, `spt-30*`, `reliance-orb`,
`stgl-120`, `lion-*` and `strangle-3` remove positions with `delete optionOrders[idx]`, leaving
holes. `forEach` skips holes so it happens to work, but `.length` never shrinks, `.map`/`for`
loops see `undefined`, and the arrays grow unboundedly over a session.
`strad-ts-*` uses `optionOrders.splice(i, 1)` inside a forward `for` loop → the element after
the removed one is skipped on that pass.

**R16 — `forEach` with an `async` callback and no `await`.** `checkSL` in `opt-*`, `spt-*`,
`tiger-s-5`, `reliance-orb`, `strangle-3`, `hdfc_spread` and most `lion-*` files is
`arr.forEach(async (pos, idx) => { … await placeAllAccount(…) … })`. The `async.queue`
serialisation guarantee is therefore **void inside `checkSL`**: the queue callback fires when the
synchronous part returns, so multiple `checkSL` invocations overlap and the same stop can be
placed twice. The `return false` / `return true` values in those callbacks are dead code (the
authors appear to have believed `forEach` short-circuits like `every`).

**R17 — Aggressive breakers that never fire.** `PROFIT_TARGET` is ₹20 lakh in the timer/multi
files and ₹10 crore in `snx-hft-double`, on strategies risking 1 lot. The
`stoplossTracker.getPNL()` breaker is therefore dead code and these strategies run **with no
risk limit of any kind** — no stop-loss, no loss breaker, only the 15:21 square-off.
`smp/bn-hft-avg.js` does not even declare `PROFIT_TARGET`/`STRATEGY_STOPPED` or require
`stoplossTracker` — it has literally no breaker (the slive twin added one).

**R18 — Dormant-then-live execution hazard.** `Account.placeAllAccount` writes to `paper-trade`
**unconditionally** (`account.js:151`) and *additionally* fires real Zerodha orders for every
entry in `running_accounts`. In smp, `getAccounts()` is commented out in 38 files and only
`snx-orb-{1,25,50}.js` populate `running_accounts` — so ~44 files look "not live" but are in
fact emitting bus orders that `xtsOrder`/`sparkOrder`/`fyersOrder` forward to real brokers.
Uncommenting one line in any of those 44 files doubles the position across two brokers.

**R19 — `snx-orb-{1,25,50}.js` are byte-identical to their slive twins and DO load accounts.**
They are the only smp files with a genuinely armed direct-Zerodha rail. Running both copies
simultaneously (one from `smp/`, one from `slive/`) would double every order — and both share
the same `strategyTag`, so the duplication is invisible in `PaperTrade.positions()`.

---

## 7. Recommended disposition

| action | files |
|---|---|
| **Port as new TS classes** (ideas 1–7) | 22: `*-timer-*` (6), `*-multi-straddle` (3), `*-hft-avg` (3), `snx-hft-{double,separate}` (2), `opt-{buy,buy-day,sell}` (3), `vwap`, `jaguar`, `combo-trade`, `p718-7` |
| **Harvest config only** (engine already covered by a slive family) | 106 |
| **Delete** | `hdfc_spread` (dead underlying), `reliance-orb` (broken), `stgl-120` (unstartable, tag collision) |
| **Extract as data before deletion** | the `startCron`/`exitCron` table in §3-A and the per-file config columns in §4 — this information exists **nowhere else** |

Port `combo-trade` first: it is the only existing implementation of "strategy = class + config
record", and its `spreads` document shape is a working prototype of the config schema the whole
migration needs.
