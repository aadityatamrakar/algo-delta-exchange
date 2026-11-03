# Family spec: `cheetah-hft`

**Scope:** 19 files — `server/slive/cheetah-*.js` (14), `server/slive/hft-*.js` (4), `server/slive/bn-hft.js` (1).
**Verified against source on 2026-07-25.** Everything below was read or `diff`ed; no inference from `dump.pm2`.

**Bottom line:** 19 files encode **3 distinct algorithms**:

| id | files | one line |
|---|---|---|
| `momentum-flip-single-leg` | 14 cheetah | One option leg picked from spot-vs-open momentum; on stop, flip to the other side and re-enter. Everything else is a config knob. |
| `synthetic-atm-straddle-averaging` | `hft-averaging`, `hft-multi`, `hft-nifty`, `bn-hft` | BUY the synthetic-ATM straddle, pyramid down on premium drops, exit the whole pair on a fixed premium gain, restart. |
| `synthetic-atm-straddle-reversal` | `hft-snx-sell` | BUY the synthetic-ATM straddle; on target re-enter same direction, on stop **reverse to a naked short straddle**. |

Ideas 2 and 3 share ~70% of their code (synthetic ATM, mid-price helpers, `OrderUpdate` fill state machine, `Stoploss` tracker, timed restart). They should become one base class with a `positionModel` axis.

---

## 0. Shared infrastructure (identical in all 19 files)

```
boot:
  optionData      = await optionConfig(UNDERLYING)      # server/tools/optionInstruments.js
  futureToken     = <hardcoded spot token>              # see per-file table
  weeklyOptions   = optionData.weeklyInstruments        # map "<strike><CE|PE>" -> instrument
  zerodha_init(masterAccount)  -> public_token          # login as app.get('masterId')
  kiteTicker.subscribe([futureToken, ...all weekly option tokens], modeFull)
  liveFeed.on('ticks', checkTicks)

checkTicks(ticks):
  ticksCache[token] = tick   for every tick     # full replace of the tick object
  <per-idea work queued through async.queue(worker, 1)>
```

`optionConfig(u)` does `require('./../../optionConfig_<u>.json')` and only hits the Sensibull API if that
file is absent. Because `require` is memoised, **a process sees exactly one instrument snapshot for its whole
lifetime**. Expiry rollover therefore happens only by (a) an external job rewriting the JSON *and* (b) a
process restart. `optionConfig()` with no argument defaults to `BANKNIFTY`.

Order rails available to this family:

| call | doc written to `paper-trade` | consumed by |
|---|---|---|
| `Account.trackOrder(instr, side, tag, mult)` | `status: COMPLETE`, `order_type: MARKET`, no price, `quantity = lot_size*mult` | `paperstream.js` stamps `average_price` from ticks; `xtsOrder.js` / `sparkOrder.js` / `fyersOrder.js` place **real** orders |
| `PaperTrade.trackOrder_v2(instr, side, tag, mult, dataObj)` | same, plus `dataObj` (round-trips as `orderUniqueIdentifier = tag\|...dataObj`) | same |
| `PaperTrade.trackOrder_slm(instr, side, tag, mult, stopPrice, dataObj)` | `status: Pending`, `order_type: StopMarket`, `stopPrice` | `xtsOrder.js` converts StopMarket → StopLimit ±1% |
| `Account.placeAllAccount(tag, qtys, runningAccounts, instr, side, mult)` | calls `Account.trackOrder(...)` **and then** loops `runningAccounts` placing synchronous Zerodha MARKET orders (tranched at 60 qty BANKNIFTY / 36 NIFTY / 100 other) | — |

`OrderUpdate` documents (`{updateType:'order', strategy, params, status, price}`) are produced **only** by
`server/tools/smp_order_listener.js` and `server/tools/smp_target.js`, from the XTS interactive websocket
(`orderUniqueIdentifier.split('|')` → `strategy` + `params`). The simulator never writes them. Any strategy
in this family that waits on `OrderUpdate` therefore **cannot progress without a live XTS account mapped to
its tag** (see Risks R7, R16).

> ### R0 — the single most important correction to make when porting
> **`getAccounts()` is defined in all 14 cheetah files and called in none of them.**
> ```
> $ grep -n getAccounts server/slive/cheetah-*.js     # 14 hits, all "async function getAccounts() {"
> ```
> (Contrast: `lion-*`, `jk-*`, `cal-*` etc. all call it.) So `running_accounts = []` and
> `account_quantities = {}` forever, and `Account.placeAllAccount(...)` degenerates to **one
> `Account.trackOrder` bus insert and nothing else** — zero Zerodha orders, zero per-account sizing.
> The effective execution rail of every cheetah file is **bus-routed**, and `multiplier` is the only
> sizing that exists. `context/sheets/slive-strategies.csv` labels these "live, zerodha"; that is the
> *intent*, not the behaviour.

---

## 1. `momentum-flip-single-leg` (14 cheetah files)

### Canonical pseudocode

```
CONFIG
  underlying, refToken, strikeStep            # refToken = spot or monthly-future token
  rollToNextWeekOnWednesday: bool
  sideBias:      'AGAINST' | 'WITH'           # AGAINST => SELL, WITH => BUY
  strikeSelect:  { mode:'ATM_OFFSET', offset } | { mode:'NEAREST_PREMIUM', targetPremium }
  stop:          { basis:'TRAIL'|'FIXED', points }
  target:        null | { points }            # per-leg premium target
  reentryAtm:    'CURRENT' | 'FROZEN_FIRST'
  reentryCap:    Infinity | int               # counts stop-outs, not entries
  sizing:        { mode:'FLAT', lots } | { mode:'PYRAMID_UP', step:1, cap:int|Infinity }
  stopExecution: 'LOCAL_TICK' | 'BROKER_SLM'
  portfolioBreaker: null | { onLoss?: -X, onProfit?: +Y }
  eod:           null | { disableAt, exitProcessAt }

STATE
  openLegs = []        # at most one element in practice
  entered  = false     # one-shot latch, process lifetime
  qty      = sizing.lots or 1
  stopOuts = 0
  frozenAtm = null

BOOT ... then  setTimeout(placeInitialTrade, bootDelay)      # 3s / 10s / 15s per file

placeInitialTrade():                                   # do/while, up to 10 attempts
  repeat up to 10 times, until refTick is an object:
    try:
      refTick = ticksCache[refToken]                   # throws on undefined -> catch
      atm     = round(refTick.last_price / strikeStep) * strikeStep
      frozenAtm = atm                                  # only if reentryAtm == FROZEN_FIRST
      if not entered:
        entered = true
        # sideBias AGAINST: fade the move -> sell the side the move is running away from
        # sideBias WITH:    follow the move
        type = (refTick.last_price > refTick.ohlc.open)
                 ? (sideBias=='AGAINST' ? 'PE' : 'CE')
                 : (sideBias=='AGAINST' ? 'CE' : 'PE')
        openLeg(atm, type)
    catch: await zerodhaLogin()                        # re-login and retry

openLeg(atm, type):
  strike = selectStrike(atm, type)
  instr  = weeklyOptions[strike + type]                # throws if the strike is absent
  ltp    = ticksCache[instr.instrument_token].last_price
  side   = (sideBias=='AGAINST') ? 'SELL' : 'BUY'

  if stopExecution == 'LOCAL_TICK':
      placeAllAccount(tag, {}, [], instr, side, qty)   # == one bus insert, see R0
      openLegs.push({ strike, type, token, entry: ltp, extreme: ltp,
                      target: target ? ltp ± target.points : null,
                      fixedStop: ltp ± stop.points, qty })
      if sizing.mode == 'PYRAMID_UP' and qty < cap: qty += 1
  else:  # BROKER_SLM
      id = nextEventId()
      eventTrigger[id] = { atm, strike, type, token, action:'place_sl' }
      PaperTrade.trackOrder_v2(instr, side, tag, qty, [id])

selectStrike(atm, type):
  ATM_OFFSET:       return atm + (type=='CE' ? +offset : -offset)     # offset is ALWAYS 0, see R1
  NEAREST_PREMIUM:  # scan every weekly instrument, pick the CE and the PE whose LTP
                    # is closest to targetPremium; ignore atm entirely
                    cand = values(weeklyOptions)
                             .map(c => c.distance = tick(c) ? |tick(c).last_price - targetPremium| : targetPremium)
                             .sort(by distance)
                    return first cand with instrument_type == type

# ---------- exit path A: LOCAL_TICK (every tick, serialised through async.queue(...,1)) ----------
onTick():
  if portfolioBreaker: checkPortfolio()
  for (idx, leg) of openLegs:                          # Array.forEach, holes skipped
      px = ticksCache[leg.token].last_price             # UNGUARDED, see R4

      if target and (sideBias=='WITH' ? px >= leg.target : px <= leg.target):
          delete openLegs[idx]                          # <-- claim BEFORE any await (dedup guard)
          placeAllAccount(..., closeSide, leg.qty)
          return                                        # NO re-entry after a target hit, see R11

      if stop.basis == 'TRAIL':
          leg.extreme = (sideBias=='AGAINST') ? min(leg.extreme, px) : max(leg.extreme, px)
          stopPx = (sideBias=='AGAINST') ? leg.extreme + stop.points
                                         : leg.extreme - stop.points
      else:  stopPx = leg.fixedStop                     # entry ± stop.points, never moves

      hit = (sideBias=='AGAINST') ? px > stopPx : px < stopPx
      if hit:
          delete openLegs[idx]                          # claim BEFORE await
          placeAllAccount(..., closeSide, leg.qty)      # close
          stopOuts += 1
          if stopOuts <= reentryCap:
              atm = (reentryAtm=='CURRENT')
                      ? round(ticksCache[refToken].last_price / strikeStep) * strikeStep
                      : frozenAtm
              openLeg(atm, flip(leg.type))              # PE<->CE
```
Note the trailing-stop algebra: the source writes
`sl = entry + (trail - (entry - low))`, which reduces to **`sl = low + trail`** (sell side) and
`sl = high - trail` (buy side). `low`/`high` are seeded at the entry price, so the initial stop is
exactly `entry ± trail`. Preserve the reduced form.

```
# ---------- exit path B: BROKER_SLM (driven by OrderUpdate change stream) ----------
on OrderUpdate insert where updateType=='order' and strategy==tag and params.length>0:
  id = params[0]
  if eventTrigger[id].action == 'place_sl' and update.status == 'Filled':
      stopPx = round(update.price + stop.points, 1)
      id2 = nextEventId()
      eventTrigger[id2] = { atm, strike, type, action:'remove_position' }   # NOTE: no token, see R6
      PaperTrade.trackOrder_slm(weeklyOptions[strike+type], 'BUY', tag, qty, stopPx, [id2])
      eventTrigger[id] = false                                             # idempotency: false, not delete
  elif eventTrigger[id].action == 'remove_position':                       # the SLM filled
      if stopOuts < reentryCap:                                            # max_sl_times countdown
          stopOuts += 1
          atm  = round(ticksCache[refToken].last_price / strikeStep) * strikeStep
          openLeg(atm, flip(type))
      executeSL(id, eventTrigger[id].instrument_token, update.price)       # marks the SLM doc COMPLETE
      eventTrigger[id] = false

executeSL(orderId, token, price):
  trade = PaperTrade.findOne({ tag, dataObj: [parseInt(orderId)], instrument_token: token })
  if trade: trade.status='COMPLETE'; trade.order_type='MARKET'; trade.average_price=price; save()

# ---------- portfolio breaker (only where checkPNL() is actually called) ----------
checkPortfolio():   # runs on EVERY tick against a cached position snapshot
  acct = cachedPositions.accounts.find(a => a.accountId == tag)   # PaperTrade.positions() shape
  if not acct or not entered: return
  m2m = sum over acct.positions:
          qty>0 ? (sell_price*sell_qty + |qty|*ltp) - buy_price*buy_qty
                : sell_price*sell_qty - (buy_price*buy_qty + |qty|*ltp)
          # if no tick for that token, fall back to the previously stored integer m2m
  if isNaN(m2m): refreshPositions()                               # debounced by fetchingPosition
  if (onLoss  and m2m < onLoss) or (onProfit and m2m > onProfit):
      openLegs = []            # abandon local tracking
      entered  = false         # hard stop: no further entries this process
      notify(tag + ': SL HIT' | ': TGT HIT')
      PaperTrade.positions(resp => for each pos of resp.positions[tag] with quantity != 0:
          Account.trackOrder({ instrument_token, tradingsymbol,
                               lot_size: |pos.quantity| },        # NOTE: absolute qty, not lots
                             pos.quantity > 0 ? 'SELL' : 'BUY', tag))

# cachedPositions is refreshed only by refreshPositions(), which is called
#   - on NaN m2m, and
#   - 2s after each entry (only in the files where that setTimeout is not commented out)
```

### Member file table

Common to all 14: `underlying = BANKNIFTY` (except `b1-snx` = SENSEX), `strikeStep = 100`,
`weeklyInstruments`, `offset = otmSelector('Cheetah') = 0` → **every leg is ATM**,
`sizing.lots = 1` unless noted, no EOD square-off unless noted.

| file | tag | refToken | side | strike select | stop | target | re-entry ATM | re-entry cap | sizing | stop exec | portfolio breaker | Wed roll | EOD cron | boot delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `cheetah-1910.js` | `Cheetah_1910` | 260105 spot | SELL (against) | ATM+0 | TRAIL 60 | — | CURRENT | ∞ | flat 1 | LOCAL | **live**, loss `< -2500` | yes | none | 15s |
| `cheetah-1911.js` | `Cheetah_1911` | 260105 | SELL | ATM+0 | TRAIL 60 | — | CURRENT | ∞ | flat 1 | LOCAL | **live**, loss `< -2500` | yes | none | 15s |
| `cheetah-1963.js` | `Cheetah_1963` | 260105 | SELL | ATM+0 | TRAIL 60 | — | CURRENT | ∞ | flat 1 | LOCAL | profit `> +2500` — **DEAD** (`checkPNL()` commented) | yes | 15:23:50 `entered=false`; 15:30:00 `process.exit()` | 15s |
| `cheetah-st-60.js` | `Cheetah_ST_60` | 260105 | SELL | ATM+0 | TRAIL 60 | — | CURRENT | ∞ | flat 1 | LOCAL | profit `> +2500` — **DEAD** (`checkPNL()` commented) | yes | none | 10s, `entered`-gate lifted at boot |
| `cheetah-stp-2117.js` | `Cheetah_STP_2117` | 260105 | SELL | **NEAREST_PREMIUM 250** | TRAIL 60 | — | CURRENT | ∞ | flat 1 | LOCAL | none (`checkPNL` deleted) | yes | none | 10s |
| `cheetah-bt-2117.js` | `Cheetah_BT_2117` | 260105 | **BUY (with)** | ATM+0 | TRAIL 60 (from high) | — | CURRENT | ∞ | flat 1 | LOCAL | **live**, profit `> +2500` | yes | none | 15s |
| `cheetah-s-2203.js` | `Cheetah_2203` | 260105 | SELL | ATM+0 | **FIXED 30** | — | CURRENT | ∞ | flat 1 | LOCAL | none (deleted) | yes | none | 10s |
| `cheetah-2117.js` | `Cheetah_S30_2117` | 260105 | SELL | ATM+0 | FIXED 30 (broker SLM at fill+30) | — | CURRENT | **3** | flat 1 | **BROKER_SLM** | none | yes | none | 10s |
| `cheetah-2204.js` | `Cheetah_2204` | 260105 | SELL | ATM+0 | FIXED 30 (broker SLM) | — | — | **0** (re-entry block commented out) | flat 1 | BROKER_SLM | none | yes | none | 10s |
| `cheetah-0042.js` | `Cheetah_0042` | 260105 | SELL | ATM+0 | FIXED 30 (broker SLM) | — | — | **0** (commented out) | flat 1 | BROKER_SLM | none | yes | none | 10s |
| `cheetah-b1-2117.js` | `Cheetah_B1_2117` | 260105 | **BUY** | ATM+0 | FIXED 10 (`entry-10`) | — | CURRENT | ∞ | **PYRAMID_UP, cap ∞** | LOCAL | **live**, profit `> +5000` / loss `< -12500` | yes | none | 10s |
| `cheetah-b1-1.js` | `CheetahB1-1` | **`currentFuture.token`** (monthly FUT) | BUY | ATM+0 | FIXED 10 | **+90** | **FROZEN_FIRST** | ∞ | PYRAMID_UP, **cap 12** | LOCAL | none | **no** (commented) | 15:23:40 `process.exit()` | 10s |
| `cheetah-b1-2.js` | `CheetahB1-2` | `currentFuture.token` | BUY | ATM+0 | FIXED 10 | +90 | FROZEN_FIRST | ∞ | PYRAMID_UP, cap 12 | LOCAL | none | no | 15:23:40 exit | 10s |
| `cheetah-b1-snx.js` | `Cheetah_B1_SNX` | **265** (SENSEX spot), `optionConfig('SENSEX')` | BUY | ATM+0 | FIXED 10 | +90 | FROZEN_FIRST | ∞ | PYRAMID_UP, cap 12 | LOCAL | none | no | **none** | **3s** |

Byte-identical except `strategyTag`: `1910`≡`1911`, `b1-1`≡`b1-2`.

---

## 2. `synthetic-atm-straddle-averaging` (`hft-averaging`, `hft-multi`, `hft-nifty`, `bn-hft`)

`bn-hft.js` and `hft-nifty.js` are the same file as `hft-averaging.js` modulo trailing whitespace,
tag, underlying and two constants. All four are **bus-routed** (`PaperTrade.trackOrder_v2` only —
no `placeAllAccount` anywhere).

### Canonical pseudocode

```
CONFIG
  underlying, refToken, strikeStep = 100            # hardcoded, see R12
  STRIKES: int[]                                    # offsets in points, 0 == ATM
  TARGET_POINTS                                     # pair-premium gain that closes the pair
  AVERAGING_TRIGGER                                 # pair-premium drop below avg that adds a leg
  MAX_AVERAGING_STEPS                               # cap on entries.length
  TARGET_REDUCTION_PERCENT = 0                      # target decay per added entry (no-op today)
  PROFIT_TARGET = 3_000_000                          # account kill switch (effectively infinite)
  RESTART_DELAY_MS = 10_000

STATE  positions[strikeKey] for each offset, strikeKey = offset==0 ? 'ATM' : offset>0 ? 'P<o>' : 'M<|o|>'
       { entries:[], totalQty, totalCost, avgPrice, currentTarget, isActive,
         exitInProgress, exitCEPrice, exitPEPrice, ceExitFilled, peExitFilled,
         ce:{option,lastPrice}, pe:{option,lastPrice} }
       stoplossTracker = new Stoploss()               # server/tools/stoploss.js, estimated prices
       STRATEGY_STOPPED = false                       # one-way latch

price helpers (all read ticksCache, all fall back to last_price):
  mid(token) = (depth.buy[0].price + depth.sell[0].price) / 2      # the ONLY one used
  ask(token) = depth.sell[2].price                                 # DEAD, never called
  bid(token) = depth.buy[2].price                                  # DEAD, never called

BOOT: optionConfig(underlying); subscribe(modeFull); initializePositions();
      setTimeout(startInitialTrades, 5000)

startInitialTrades():
  if not ticksCache[refToken]: retry in 1s               # tick-availability precondition
  atm = syntheticAtm()
  for offset of STRIKES: takeInitialPosition(atm, offset)

syntheticAtm():                                          # put-call parity F = K + C - P
  base = round(mid(refToken) / 100) * 100
  C, P = mid(weeklyOptions[base+'CE']), mid(weeklyOptions[base+'PE'])
  if either option missing or price falsy: return base
  return round((base + C - P) / 100) * 100

takeInitialPosition(atm, offset):
  if STRATEGY_STOPPED: return
  ce = weeklyOptions[(atm+offset)+'CE'];  pe = weeklyOptions[(atm+offset)+'PE']
  if not ce or not pe: return
  ceP, peP = mid(ce), mid(pe);  if either falsy: return
  pos.ce.option = ce; pos.pe.option = pe               # legs pinned until the pair is closed
  addPairEntry(strikeKey, ceP, peP, qty=1, isInitial=true)

addPairEntry(strikeKey, ceP, peP, qty, isInitial):
  if STRATEGY_STOPPED: return
  entries.push({ cePrice:ceP, pePrice:peP, pairPrice:ceP+peP,
                 estimatedCEPrice:ceP, estimatedPEPrice:peP, qty,
                 ceFilled:false, peFilled:false, fillPriceUpdated:false })
  totalQty  += qty                                     # provisional, from mid estimates
  totalCost += (ceP+peP) * qty
  avgPrice   = totalCost / totalQty
  isActive   = true
  if not isInitial and entries.length > 1:
      currentTarget *= (1 - TARGET_REDUCTION_PERCENT/100)
  send(ce, 'BUY', qty, action = isInitial ? 'buy_entry' : 'buy_averaging')
  send(pe, 'BUY', qty, same action)

send(option, side, qty, action):                        # sendOrderWithTracking
  price = mid(token) || last_price || 0
  id = nextEventId(); eventTrigger[id] = { strikeKey, optionType, action, instrument, transType, qty, isInitial, estimatedPrice: price }
  stoplossTracker.addOrder(option, price, side, qty)    # estimated price, never corrected
  PaperTrade.trackOrder_v2(option, side, tag, qty, [id])   # NOTE: price is NOT on the wire

# ---- per-tick loop, serialised through async.queue(...,1) ----
onTick():
  if not STRATEGY_STOPPED and stoplossTracker.getPNL(ticksCache) >= PROFIT_TARGET:
      STRATEGY_STOPPED = true; exitAllPositionsAtCost(); return
  if STRATEGY_STOPPED: return
  for strikeKey in positions where isActive: checkPair(strikeKey)

checkPair(strikeKey):
  ceM, peM = mid(ce), mid(pe);  if either falsy: return
  if exitInProgress: return                                     # duplicate-exit guard
  pair = ceM + peM
  if entries.filter(fillPriceUpdated).length == 0: return       # HARD GATE, see R16
  if pair >= avgPrice + currentTarget:  squareOffPair(); return
  if pair <= avgPrice - AVERAGING_TRIGGER:
      if entries.length >= MAX_AVERAGING_STEPS: return          # see R13
      addPairEntry(strikeKey, ceM, peM, qty = entries.length + 1, isInitial=false)   # 1,2,3,... pyramid up

squareOffPair(strikeKey):
  if exitInProgress: return
  exitInProgress = true; ceExitFilled = peExitFilled = false    # set BEFORE any await
  send(ce, 'SELL', totalQty, 'sell_exit');  send(pe, 'SELL', totalQty, 'sell_exit')

exitAllPositionsAtCost():   # same as squareOffPair for every active strikeKey, sets STRATEGY_STOPPED path

# ---- OrderUpdate change stream: the only thing that advances the state machine ----
on insert where updateType=='order' and strategy==tag and params.length>0 and status=='Filled':
  e = eventTrigger[params[0]];  if not e: ignore
  if e.action in ('buy_entry','buy_averaging'):
      entry = last(entries);  if not entry or entry.fillPriceUpdated: return
      diff = fillPrice - entry['estimated'+leg+'Price']
      entry[leg+'Price'] = fillPrice;  entry[leg+'Filled'] = true
      if diff != 0: totalCost += diff * qty;  avgPrice = totalCost / totalQty   # incremental correction
      if entry.ceFilled and entry.peFilled:
          entry.pairPrice = entry.cePrice + entry.pePrice
          entry.fillPriceUpdated = true
          recalculatePosition()      # totalCost/totalQty rebuilt from CONFIRMED entries only
  elif e.action == 'sell_exit' and exitInProgress:
      record exit leg fill; when both legs filled:
          pnl = (exitCE + exitPE - avgPrice) * totalQty         # logged only
          resetPosition(strikeKey)                              # currentTarget back to TARGET_POINTS
          setTimeout(RESTART_DELAY_MS, () => if not STRATEGY_STOPPED:
              atm = syntheticAtm()                              # RE-DERIVED: the strike can migrate
              takeInitialPosition(atm, offsetOf(strikeKey)))
  eventTrigger[params[0]] = false                               # idempotency
```

### Member file table

| file | tag | underlying | refToken | TARGET_POINTS | AVERAGING_TRIGGER | MAX_AVERAGING_STEPS | STRIKES | averaging live? |
|---|---|---|---|---|---|---|---|---|
| `hft-nifty.js` | `NF_HFT_AVG` | NIFTY | 256265 | 5 | 5 | **1** | `[0]` | **no** |
| `bn-hft.js` | `BN_HFT_AVG` | BANKNIFTY (`optionConfig()` default) | 260105 | 10 | 10 | **1** | `[0]` | **no** |
| `hft-averaging.js` | `SNX_HFT_AVG` | SENSEX | 265 | 10 | 10 | **1** | `[0]` | **no** |
| `hft-multi.js` | `SNX_HFT_MUL` | SENSEX | 265 | 10 | 10 | 10 | `[-100, 0, 100]` | **yes** |

All four: `TARGET_REDUCTION_PERCENT = 0`, `PROFIT_TARGET = 3_000_000`, restart delay 10s,
`setInterval(getStrategyStatus, 300000)`, no EOD cron (all commented out).

---

## 3. `synthetic-atm-straddle-reversal` (`hft-snx-sell.js`)

Same boot, same synthetic-ATM, same mid-price helpers, same `OrderUpdate` state machine and
`Stoploss` tracker as idea 2. Differences:

```
CONFIG  TARGET_POINTS = 10, STOPLOSS_POINTS = 20, STRIKES = [0], qty fixed at 1,
        PROFIT_TARGET = 3_000_000, REENTRY_DELAY_MS = 2_000, underlying SENSEX, refToken 265
        tag = SNX_HFT_SELL

STATE per strikeKey: { totalQty:1, entryPrice, isActive, positionType:'LONG'|'SHORT',
                       exitInProgress, exitTrigger:'TARGET'|'STOPLOSS',
                       targetPrice, stoplossPrice, cePrice, pePrice, ceFilled, peFilled,
                       fillPriceUpdated, estimatedCE/PEPrice, exitCE/PEPrice, ceExitFilled, peExitFilled }

boot: enterPosition(strikeKey, syntheticAtm(), offset, 'LONG')   # always starts LONG

enterPosition(key, atm, offset, type):
  legs = weeklyOptions[(atm+offset)+'CE'|'PE'];  require both present and mid() truthy
  pin legs; positionType = type; estimated prices = mid(); isActive = true
  side = (type=='LONG') ? 'BUY' : 'SELL'
  send(ce, side, 1, 'entry');  send(pe, side, 1, 'entry')

on entry fills (both legs confirmed):
  entryPrice = cePrice + pePrice
  if LONG:  target = entry + TARGET_POINTS;  stop = entry - STOPLOSS_POINTS
  if SHORT: target = entry - TARGET_POINTS;  stop = entry + STOPLOSS_POINTS
  fillPriceUpdated = true

per tick (queue concurrency 1), only if fillPriceUpdated and not exitInProgress:
  pair = mid(ce) + mid(pe)
  LONG:   pair >= target -> exitTrigger='TARGET';  pair <= stop -> exitTrigger='STOPLOSS'
  SHORT:  pair <= target -> exitTrigger='TARGET';  pair >= stop -> exitTrigger='STOPLOSS'
  -> exitPosition(): exitInProgress = true (before awaits); side = LONG?'SELL':'BUY'; both legs

on exit fills (both legs confirmed):
  pnl = LONG ? (exitPair - entryPrice)*qty : (entryPrice - exitPair)*qty
  nextType = (exitTrigger == 'STOPLOSS') ? flip(positionType) : positionType   # <-- THE IDEA
  resetPosition(key)
  setTimeout(2000, () => if not STRATEGY_STOPPED:
       enterPosition(key, syntheticAtm(), offsetOf(key), nextType))
```
So: **target ⇒ re-enter the same direction; stop ⇒ reverse.** A stopped-out long straddle becomes a
**naked short straddle** whose only protection is a 20-point pair stop.

---

## 4. Config axes that regenerate all 19 files

1. **underlying** — `NIFTY / BANKNIFTY / SENSEX`; carries `{ optionConfigKey, refToken, strikeStep, lotSize }`.
   Observed: NIFTY 256265, BANKNIFTY 260105 (spot) or `optionData.currentFuture.token` (monthly future),
   SENSEX 265. `strikeStep` is hardcoded 100 in all 19 files (wrong for NIFTY, see R12).
2. **expirySelect** — `weekly` always; `rollToNextWeekOnWednesday` true in 11/14 cheetah, false in `b1-1/b1-2/b1-snx` and all 5 hft.
3. **instrumentModel** — `SINGLE_LEG` (cheetah) vs `PAIR/STRADDLE` (hft).
4. **directionRule** — `momentum vs day-open, faded` (SELL) / `followed` (BUY) / `always LONG straddle` / `always ATM pair`.
5. **strikeSelect** — `ATM + offset` (offset from `otmSelector('Cheetah')` ⇒ always 0) | `nearest-premium-to-₹250` | `synthetic-ATM via put-call parity + offset list`.
6. **priceSource** — `last_price` (all cheetah) vs `mid = (bestBid+bestAsk)/2` (all hft). `depth[2]` bid/ask helpers exist and are dead.
7. **stopBasis** — `TRAIL points from running extreme` | `FIXED points from entry` | `FIXED pair points` | `none`.
8. **stopPoints** — 60 / 30 / 10 (cheetah); 20 (hft-snx-sell); none (hft averaging).
9. **targetBasis** — none | fixed per-leg points (90) | pair premium points above avg cost (5/10) | pair points (10).
10. **reentryPolicy** — `flip side, unlimited` | `flip side, capped (max_sl_times = 3)` | `disabled` | `same strikeKey after N ms` | `same direction on target / reversed on stop`.
11. **reentryStrikeRef** — `CURRENT ATM` vs `FROZEN first-tick ATM` (`b1-1/b1-2/b1-snx`) vs `freshly recomputed synthetic ATM` (hft).
12. **sizing** — `FLAT 1` | `PYRAMID_UP +1 capped 12` | `PYRAMID_UP +1 uncapped` | `PYRAMID_UP nextQty = entries.length+1 up to MAX_AVERAGING_STEPS`.
13. **stopExecution** — `LOCAL_TICK` (strategy watches ticks) vs `BROKER_SLM` (`trackOrder_slm`, advanced by the `OrderUpdate` change stream).
14. **executionRail** — `Account.placeAllAccount` (intended Zerodha-direct, **degenerates to one bus insert**, R0) vs `PaperTrade.trackOrder_v2/_slm` (bus).
15. **fillConfirmation** — `assume filled at the LTP we read` (cheetah LOCAL) vs `wait for OrderUpdate 'Filled' with a real price before any decision` (all BROKER_SLM + all hft).
16. **portfolioBreaker** — `{ onLoss?, onProfit?, enabled }`: `-2500` live | `+2500` live | `+2500` dead | `+5000 / -12500` live | absent.
17. **bootDelay** — 3s / 5s / 10s / 15s after ticker connect.
18. **eodPolicy** — none (16 files) | `disable 15:23:50 + exit 15:30:00` | `exit 15:23:40`. No file squares off at EOD.
19. **statusReportIntervalMs** — hft only, 300000.
20. **accountKillSwitch** — hft only, `PROFIT_TARGET` (profit-only, effectively disabled).

---

## 5. Behaviours that MUST survive the rewrite

**P1 — One-shot entry latch.** `tradeStart` guarantees exactly one *initial* entry per process lifetime.
The `do { ... } while (typeof refTick != 'object' && attempts > 0)` retry (10 attempts, each failure
followed by `await zapi.login()`) must not be able to produce two initial entries.

**P2 — Claim-before-await.** In every local exit path the position is removed from tracking
(`delete openLegs[idx]`, or `exitInProgress = true`) **synchronously, before the first `await`**. This is
the only thing preventing duplicate exit orders on back-to-back ticks. The `async.queue(..., 1)` wrapper
does *not* provide it (R5). Reproduce it as an explicit per-position `closing` flag.

**P3 — Trailing stop is `extreme ± trail`, seeded at entry.** `low`/`high` start at the entry price, so the
first stop equals `entry ± trail` and only ever tightens. Do not re-derive from the source's expanded form.

**P4 — Flip on stop, not on target.** A stop-out flips CE↔PE and re-enters. A target hit (`b1-1/2/snx`)
closes and **does not** re-enter — the strategy goes flat for the rest of the session. That asymmetry is
deliberate in the code and changes the P&L profile; keep it configurable, defaulting to observed behaviour.

**P5 — Re-entry ATM reference.** `b1-1/b1-2/b1-snx` re-enter at the **first-tick** ATM (`atm_index`, frozen
because `placeTrade` runs once); every other file re-derives ATM from the current reference tick. Both must
be expressible.

**P6 — Wednesday expiry roll.** `moment().day() == 3 → optionData.nextWeekInstruments`. Present in 11 cheetah
files, absent (commented) in `b1-1/b1-2`, absent in `b1-snx` and all hft. This decision is made **once at
boot**; a process started Tuesday and left running into Wednesday keeps the near expiry.

**P7 — Snapshot instrument universe.** `optionConfig()` is a `require`-cached JSON snapshot. The strike map,
lot sizes and token list are fixed for the process lifetime. The rewrite's market-data service must offer the
same "pinned snapshot per instance" option, and a restart must be the documented way to roll.

**P8 — `otmSelector('Cheetah')` returns 0 on every weekday.** Nominally "far OTM" sellers are in fact ATM
sellers. Port them as ATM (`offset: 0`) and make the offset an explicit config value; do not resurrect
`otmSelector`.

**P9 — Tick-availability preconditions.** Entry requires (a) a tick for the reference instrument and
(b) a tick for the chosen strike; hft additionally requires **market depth** (`modeFull`) for both ATM legs
before it can compute a synthetic ATM, and it retries `startInitialTrades` every 1s until the reference
tick exists. Today a missing *option* tick throws inside a non-awaited call and silently kills the day (R3).
The rewrite must retry/park explicitly instead.

**P10 — hft acts only on confirmed fills.** `fillPriceUpdated` (both legs) gates every target/averaging
decision, and `avgPrice` is corrected twice: incrementally by `(fill − estimate) * qty` per leg, then fully
rebuilt in `recalculatePosition()` from confirmed entries only. Slippage bookkeeping
(`estimatedCEPrice/estimatedPEPrice` per entry) is used for reporting and must be preserved as a concept.

**P11 — Averaging quantity schedule.** `nextQty = entries.length + 1` ⇒ 1, 2, 3, … lots; `totalQty` is the
sum; the exit sells `totalQty` on both legs in one order per leg.

**P12 — Timed restart with a fresh strike.** After a completed pair exit the same `strikeKey` is re-entered
after 10s (2s for the reversal variant) using a **newly computed** synthetic ATM — the traded strike can
migrate during the session. `resetPosition` also restores `currentTarget = TARGET_POINTS`.

**P13 — Event-trigger idempotency.** Handled `eventTrigger[id]` slots are set to `false`, not deleted, and
every handler re-checks truthiness first. Duplicate `OrderUpdate` documents for the same `params[0]` must be
no-ops. `params[0]` arrives as a **string** (from `orderUniqueIdentifier.split('|')`) and is used directly as
an object key; `executeSL` `parseInt`s it for the `dataObj` match. Keep the type handling explicit.

**P14 — `status == 'Filled'` exact case.** The producers filter on `toUpperCase()` but store the raw XTS
status. All consumers here compare against the exact string `'Filled'`.

**P15 — One-way kill switches.** `STRATEGY_STOPPED` (hft) and `startTrade = false` (cheetah breaker) are
never reset within a process. The breaker also clears local tracking (`optionOrders = []`) *before* flattening,
so the flatten is driven purely by the DB position snapshot, not by local state.

**P16 — Breaker flatten uses absolute quantity.** `Account.trackOrder({..., lot_size: Math.abs(pos.quantity)}, side, tag)`
with `multiplier = 1` ⇒ the emitted `quantity` is the absolute position quantity, *not* a lot count. Getting
this wrong multiplies the close order by the lot size.

**P17 — Order documents carry no price.** `trackOrder_v2` / `Account.trackOrder` deliberately omit
`average_price`; downstream (`paperstream.js`) stamps it from `ticksCache`, and the real rails place MARKET
orders. `trackOrder_slm` carries `stopPrice` (= `fillPrice + trail_sl`, 1 decimal) and `average_price = stopPrice`.

**P18 — Full-mode subscription of the entire weekly chain.** `[refToken, ...every weekly option token]` at
`modeFull`. hft *requires* depth; cheetah only needs LTP but subscribes identically. Preserve the "one
subscription set, computed at boot" property — several bugs here are masked by it.

**P19 — Portfolio-breaker snapshot staleness.** `checkPNL` runs on every tick against a snapshot refreshed
only by `fetchPositions()` (debounced by `fetchingPosition`), which is called on NaN m2m and 2s after each
entry. Files where that `setTimeout` is commented out never refresh. If you make the breaker read live
positions on every tick you will change behaviour materially.

---

## 6. Bugs, dead code, dangerous behaviour

### Correctness / money

- **R0 — `getAccounts()` never called in any of the 14 cheetah files.** `running_accounts = []`,
  `account_quantities = {}` ⇒ `Account.placeAllAccount` places **no broker orders**; it only writes one
  `Account.trackOrder` bus document. Per-account sizing is silently ignored; `multiplier` is the only size.
  Every "live, zerodha" label for a cheetah file is aspirational.
- **R1 — `cheetah-b1-2117` has an uncapped martingale.** `quantity += 1` with no cap, vs `if (quantity < 12) quantity += 1`
  in `b1-1/b1-2/b1-snx`. In a chopping market each stop-out increases size forever; the only brake is the
  `-12500` portfolio breaker, which is evaluated against a snapshot that may be up to one order stale (P19).
- **R2 — `cheetah-2117 / 0042 / 2204`: `executeSL` is called with `instrument_token: undefined`.**
  The `remove_position` trigger object is built as `{ atm, strike, type, action }` — no `instrument_token` —
  so `PaperTrade.findOne({ tag, dataObj:[id], instrument_token: undefined })` never matches and the
  `StopMarket` document is **never marked COMPLETE**. Position accounting for these three tags is wrong.
- **R3 — Un-awaited `sendOrder` with unguarded lookups.** `sendOrder(...)` is called without `await` from
  `placeTrade`, `checkSL` and the change-stream handler. `currentExpiryOptions[strike + type]` returns
  `undefined` for a strike outside the chain, and `ticksCache[token].last_price` throws when the strike has
  no tick yet. Either throw becomes an unhandled rejection: **the strategy silently never trades that day**
  (`tradeStart` is already `false`), with no notify.
- **R4 — `checkSL` dereferences `ticksCache[token].last_price` with no guard**, inside an `async` callback
  passed to `Array.forEach` — the rejection is dropped on the floor. Same pattern in
  `Stoploss.getPNL` (`ticksCache[token].last_price` on every tracked symbol), whose throw is swallowed by
  `checkPositions`' try/catch and silently skips **all** position checks for that tick.
- **R5 — `async.queue(worker, 1)` provides no serialisation.** The worker resolves on the promise returned by
  `checkSL()` / `checkPositions()`, but those use `Array.forEach(async ...)` (cheetah) or resolve before the
  timers they schedule, so the next tick's pass can start while orders from the previous pass are in flight.
  Only P2's synchronous claim actually prevents duplicates.
- **R6 — No stop at all if the broker never reports.** `cheetah-2117/0042/2204` have **zero** local stop
  monitoring; the short leg's only protection is a `StopMarket` order whose lifecycle is learned from
  `OrderUpdate`. If no XTS account is mapped to the tag, or `smp_order_listener.js` is down, the leg runs
  **naked and unstopped for the rest of the day** and there is no EOD flatten.
- **R7 — The entire hft cluster stalls under simulation.** `paperstream.js` never writes `OrderUpdate`.
  Without a live XTS fill feed, `fillPriceUpdated` stays `false`, `checkPairPosition` returns early forever,
  and the strategy buys one straddle and sits on it indefinitely — no target, no exit, no EOD. Not visible
  from the strategy file.
- **R8 — No EOD square-off anywhere in the family.** 16 of 19 files have no EOD cron at all;
  `cheetah-1963` (15:23:50 disable, 15:30:00 exit) and `cheetah-b1-1/b1-2` (15:23:40 exit) only call
  `process.exit()`, which **abandons open positions** rather than closing them. Position closure depends
  entirely on an external process (`xtsOrder.js` runs `stopStrategies` 15:23:50 / `clearOrders` 15:24:05 /
  `XtsAccount.squareOff`, and `process.exit()` at 15:30 — for XTS accounts only).
- **R9 — `hft-snx-sell` sells naked straddles.** On a stop-out it flips to `SELL CE + SELL PE` with a
  20-point pair stop and no margin/limit check, then keeps alternating LONG/SHORT indefinitely.
  Theoretical loss on the short side is unbounded; the only kill switch is `PROFIT_TARGET` (profit-side only).
- **R10 — hft has no loss breaker at all.** `PROFIT_TARGET = 3_000_000` is effectively infinite and there is
  no loss equivalent in any of the 5 hft files.
- **R11 — `b1-1/b1-2/b1-snx` go silently idle after a target hit.** Only the SL branch re-enters; the target
  branch closes and returns. `quantity` retains its escalated martingale value with nothing left to use it on.
- **R12 — Strike step hardcoded to 100.** `Math.round(price/100)*100` in all 19 files. NIFTY's step is 50, so
  `hft-nifty` picks a strike up to 50 points off true ATM, and a NIFTY port of `hft-multi`'s
  `STRIKES = [-100, 0, 100]` would be ±2 strikes rather than ±1.
- **R13 — `MAX_AVERAGING_STEPS = 1` disables the feature the file is named after.** The check is
  `entries.length >= MAX_AVERAGING_STEPS`, and `entries.length` is already 1 after the initial entry, so
  `hft-averaging`, `hft-nifty` and `bn-hft` can never average. Only `hft-multi` (10) exercises it.
  Likewise `TARGET_REDUCTION_PERCENT = 0` makes target decay a no-op in all four.
- **R14 — `cheetah-b1-1/b1-2` derive ATM from the monthly FUTURE.** `futureToken = optionData.currentFuture.token`,
  then `round(futurePrice/100)*100` — the strike is biased by the futures basis (tens of points in BANKNIFTY),
  and `ohlc.open` is the futures open, not the spot open. Every other cheetah file uses the spot token.
- **R15 — Portfolio breakers are inconsistent and half-dead.** `1910/1911` stop on **loss** `< -2500`;
  `st-60`, `1963` and `bt-2117` were flipped to stop on **profit** `> +2500`, but `checkPNL()` is commented
  out in `st-60` and `1963` (so their breaker is dead code) while it is live in `bt-2117`.
  `stp-2117`, `s-2203`, `b1-1/2/snx` and `2117/0042/2204` have no breaker function at all.
  `1910` writes `if (isNaN(m2m)) fetchPositions(); if (m2m < -2500) {...}` (no `else`), while `b1-2117`
  uses `else if` — harmless today (NaN comparisons are false) but a trap when porting.
- **R16 — `updatePositionWithFillPrice` only ever updates `entries[entries.length - 1]`.** If two entries are
  in flight (possible in `hft-multi`: an averaging entry placed while the previous one is unfilled), fills are
  attributed to the wrong entry. `recalculatePosition` then rebuilds from `fillPriceUpdated` entries only, so
  the mis-attributed cost persists in `totalCost` until the pair is closed.
- **R17 — Half-open positions on a dropped exit fill.** `exitInProgress` is cleared only by `resetPosition`,
  which runs only when **both** exit legs confirm. A single missing `OrderUpdate` leaves the position
  permanently `exitInProgress` — no further target checks, no re-entry, no retry.
- **R18 — `delete openLegs[idx]` leaves array holes.** `optionOrders` grows without bound for the whole
  session and `.length` is meaningless. Use a map keyed by position id.
- **R19 — `startTrade = true` before the entry succeeds.** In `1910/1911/1963` it is set inside `placeTrade`
  *before* the `tradeStart` check; in `st-60/stp-2117/bt-2117` it is set in `runStrategy` before any tick
  exists. Either way the breaker and the per-tick stop loop can run with zero positions.

### Dead code / hygiene

- `getAccounts()` — defined, never called (14 files). `accounts`, `channelId`, `fromDate`, `toDate` — unused.
- `getAskPrice()` / `getBidPrice()` (the `depth[2]` "3rd level" helpers) — defined in all 5 hft files, **never
  called**; every price in the hft cluster is `getMidPrice`. The commented intent ("ask for entry, bid for
  exit") was never wired.
- `sendOrder()` legacy wrapper, `cancelPendingOrders()` (exported, never called), `getStrikeOffset`'s unused
  `currentATM` parameter, `getSlippageAnalysis` / `getTradeAnalysis` / `setTargetPoints` etc. (exported from a
  file that is run as a script, so the exports are unreachable).
- `hft-snx-sell`: module globals `currentPosition` and `positionActive` are declared and never used.
- `setInterval(getStrategyStatus, 300000)` with the comment "every 30 seconds".
- Commented-out `CronJob` blocks for market-close square-off in all 5 hft files.
- `cheetah-stp-2117`: `for (i = 0; ...)` creates an **implicit global** `i`; the premium scan also **mutates
  the shared instrument objects** in `currentExpiryOptions` by writing a `distance` field onto them, and
  falls back to `distance = targetPremium (250)` for un-ticked strikes so an un-ticked strike can win the
  scan if every real distance exceeds 250.
- `cheetah-1910` and `cheetah-st-60` both carry the comment `// Cheetah_ST_60`; `1910`/`1911` and
  `b1-1`/`b1-2` are byte-identical apart from `strategyTag`.

---

## 7. Suggested target shape

```ts
// One class per idea; every file above becomes a config record.
class MomentumFlipSingleLeg  extends Strategy {}   // 14 cheetah configs
class SyntheticStraddlePair  extends Strategy {}   // positionModel: 'AVERAGING' | 'REVERSAL' -> 5 configs
```
Both take an injected `MarketFeed` (live ws bus or historical replay), an injected `OrderRouter`
(`bus` | `zerodha` | `paper`) and an injected `FillSource` (`optimistic-ltp` | `broker-confirmed`) — the
last one is exactly the `LOCAL_TICK` vs `BROKER_SLM` / hft axis, and making it injectable is what lets the
backtester run these strategies without an `OrderUpdate` change stream.
