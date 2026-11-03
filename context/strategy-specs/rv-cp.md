# Family spec: `rv-*` + `cp-*` (18 production files)

> Canonical parameterised spec for `server/slive/rv-*.js` and `server/slive/cp-*.js`.
> Written to be implementable **without** re-reading the legacy files.
> Verified against the code on branch `master` @ `bdbc9099` (2026-07-25).

---

## 0. Executive summary

18 files. The `rv-` and `cp-` prefixes are **not** one family — they share nothing but the
boilerplate header. There are **three** genuinely distinct algorithms:

| # | Idea id | Files | One line |
|---|---------|-------|----------|
| A | `rv-vol-roll-strangle` | `rv-1.js` (1 file) | Minute-candle **realised-volatility** comparison decides whether to roll a short strangle to a new ATM-anchored strike pair. The only file in the repo that computes true RV. |
| B | `rv-pnl-roll-strangle` | `rv-2, rv-25n, rv-40, rv-40e1, rv-40e2, rv-40n, rv-40sl, rv-s2` (8 files) | One-shot short strangle/straddle, then per-leg **premium-based rolling**: roll further OTM on an ~N% adverse premium move, roll back toward ATM on an ~M% favourable move, budgeted by a shared `max_sl_count`. |
| C | `cp-breakout-single-leg` | `cp-s-010, cp-s-030, cp-s-2040, cp-s-3370, cp-rs-030, cp-b-2040, cp-ns-2040, cp-snx-030, cp-snx-2040` (9 files) | Capture a base index price at start; on the first ±N-point index move, take a **single-leg ATM option** position, attach a broker-side OCO (StopMarket SL + Limit target), and on each OCO fill **flip to the other option type** until a day-stop counter (+1 win or −2 losses) trips. |

Despite the shared `rv-` prefix, **`rv-2.js` implements idea B, not idea A** — its trading logic is
byte-for-byte the `rv-40` engine (see the diff table in §2.4). `rv-1.js` is the sole member of idea A.

Total distinct behaviour: **3 classes**. Everything else is a config record.

---

## 1. Shared infrastructure (all 18 files)

Every file is a standalone `node` process, started/stopped by `Manager.restart/stop`
(`server/tools/xtsOrder.js` cron `0 13 9 * * 1-5` → `init`, `30 16 9 * * 1-5` → `startStrategies`,
`50 23 15 * * 1-5` → `stopStrategies`, `5 24 15 * * 1-5` → `clearOrders`,
`0 30 15 * * 1-5` → `process.exit()`). All 15 registered members are
`"autostart": false` in `common/models/strategies.json` (`rv-40e1`, `rv-40e2`, `rv-s2` are not
registered at all — they are hand-started), and none has a `delay_start`, so **start time is an
operator decision, not code**. This matters: idea B and idea C both anchor their entire day on the
tick state a few seconds after process start.

### 1.1 Boot sequence (identical in all 18)

```
optionData      = await optionConfig(<UNDERLYING>)      // Sensibull chain scrape, server/tools/optionInstruments.js
futureToken     = <hardcoded SPOT index token>          // misnamed: it is the INDEX, not a future
currentExpiryOptions = optionData.weeklyInstruments     // map: "<strike><CE|PE>" -> instrument
                     | optionData.nextWeekInstruments   // rv-s2 only
optionTokens    = every token in currentExpiryOptions   // ~200-400 tokens
base_acc        = await Account.findById(app.get('masterId'))
zapi            = zerodha_init(base_acc)                // login, mutates+saves account.lastLogin/config
ticker([futureToken, ...optionTokens])                  // KiteTicker, modeFull
```

`checkTicks(ticks)` reduces the batch into `ticksCache[instrument_token] = tick` via
`Object.assign`. There is **no tick timestamp check, no staleness check, and no ordering guarantee**.

`optionConfig()` default underlying is `BANKNIFTY`. Signature: `optionConfig(underlying = 'BANKNIFTY')`.

### 1.2 Underlying constants observed

| Underlying | spot token | strike step used in code | correct step |
|---|---|---|---|
| BANKNIFTY | `260105` | 100 | 100 ✔ |
| NIFTY | `256265` | 50 (`rv-25n`, `rv-40n`) / **100** (`cp-ns-2040`) | 50 |
| SENSEX | `265` | 100 | 100 ✔ |

### 1.3 Execution rails used by this family

| Call | Where it goes |
|---|---|
| `PaperTrade.trackOrder(instr, side, tag)` | inserts `paper-trade` doc `{status:'COMPLETE', order_type:'MARKET', quantity: lot_size*1}`, **no `dataObj`**. Consumed by `paperstream.js` (price stamp only) and/or `xtsOrder.js` (real XTS). Used by **all 9 `rv-*` files**. |
| `PaperTrade.trackOrder_v2(instr, side, tag, 1, [eventId])` | same but carries `dataObj` — the OCO correlation id. Entry leg of idea C. |
| `PaperTrade.trackOrder_slm(instr, side, tag, 1, stopPrice, [eventId])` | `{status:'Pending', order_type:'StopMarket', stopPrice}`. `xtsOrder.js:150-165` rewrites StopMarket → **StopLimit** with limit = stop×1.01 (BUY) / ×0.99 (SELL) above ₹1000, else ×1.05 / ×0.95. |
| `PaperTrade.trackOrder_limit(instr, side, tag, 1, limitPrice, [eventId])` | `{status:'Pending', order_type:'Limit', limitPrice}`. **`xtsOrder.js:144` does `parseInt(limitPrice)`** — the `toFixed(1)` decimal is truncated. |
| `Account.placeAllAccount(tag, account_quantities, running_accounts, instr, side)` | Zerodha direct+synchronous, per-account lots, tranched at 60 (BN) / 36 (N) / 100 lots. **Also internally calls `trackOrder(...)`**, i.e. it writes a `paper-trade` doc too. Used by **`rv-40sl` only**. |
| `XtsAccount.removePending(accountId, tag, cb)` | cancels every non-closed XTS order whose `OrderUniqueIdentifier` starts with `tag`. Idea C's OCO cancel. |

**Sizing is uniform across the whole family: 1 lot on the bus** (`multiplier` is never passed).
Real size is resolved by the consumer:
`orderQuantity = (doc.quantity / lot_size) * account.strategy[tag]`
(`xtsOrder.js:100`) or `account_quantities[user_id]` (`account.js` `placeAllAccount`).
So *position sizing is a deployment config, not a strategy parameter,* for every file here.

### 1.4 The OCO correlation channel (idea C only — critical)

```
strategy: trackOrder_slm(..., [slEventId])
   -> paper-trade doc.dataObj = [slEventId]
   -> xtsOrder.placeOrder: orderUniqueIdentifier = [strategyTag, ...dataObj].join('|')
   -> XTS broker order tag "CP_S_2040|17"
   -> smp_order_listener.js onOrder: if status in {FILLED,REJECTED} and identifier contains '|'
        OrderUpdate.create({updateType:'order', strategy:'CP_S_2040', params:['17'],
                            status:'Filled', price: OrderAverageTradedPrice, ...})
   -> strategy's own change-stream on collection "OrderUpdate" fires
```

`eventId()` is a **per-process counter starting at 0**. It is the only join key.

---

## 2. Idea B — `rv-pnl-roll-strangle` (the real workhorse, 8 files)

Read this before idea A: A is a variant of the same intent, but B is what actually runs.

### 2.1 Config

```ts
interface RvRollConfig {
  tag: string;                 // 'RV-40'
  underlying: 'BANKNIFTY'|'NIFTY';
  spotToken: number;           // 260105 | 256265
  strikeStep: number;          // 100 | 50   -- used for ATM rounding
  otm: number;                 // strike offset from ATM at entry, in points (0 => straddle)
  moveOtm: number;             // roll distance in points (always == strikeStep here)
  slPercent: number;           // multiplier on entry premium => adverse trigger  (>1)
  tgtPercent: number;          // multiplier on entry premium => favourable trigger (<1)
  minimumPrice: number;        // stop rolling if the new leg's premium is below this
  maxSlCount: number;          // shared roll budget across BOTH legs
  expiry: 'weekly' | 'nextWeek';
  wednesdayAtmOverride: boolean; // if true and moment().day()===3 then otm = 0
  entryDelayMs: number;        // 20000 everywhere
  rail: 'bus' | 'zerodha-direct';
  portfolioStopLoss?: number;  // rv-40sl only, in rupees, negative
  rollPauseMs?: number;        // rv-40sl only: 5000 between close and re-open
}
```

### 2.2 Pseudocode (authoritative)

```
on start:
  load chain (weekly | nextWeek), subscribe [spotToken, ...allOptionTokens]
  if cfg.wednesdayAtmOverride and today is Wednesday: otm = 0
  if rail == 'zerodha-direct': await loadAccounts(tag); cron('30 * * * * 1-5', loadAccounts)
  after cfg.entryDelayMs: takeTrade()

# ---------- ENTRY : exactly once per process ----------
signal = true
takeTrade():
  if not signal: return
  signal = false                                   # <-- one-shot latch, set BEFORE any await
  spot = ticksCache[spotToken]
  if spot is undefined:
      signal = true; retry takeTrade() in 1000ms; return     # tick-availability precondition
  atm = round(spot.last_price / strikeStep) * strikeStep

  sendPair('SELL', anchor=atm)                     # sells (atm+otm)CE and (atm-otm)PE
  ce_ltp = ticksCache[ instr[(atm+otm)+'CE'] ].last_price     # <-- can throw; see RISK-B1
  pe_ltp = ticksCache[ instr[(atm-otm)+'PE'] ].last_price

  state = {
    ce_anchor: atm, pe_anchor: atm,
    ce_stop:  ce_ltp * slPercent,  ce_target: ce_ltp * tgtPercent,
    pe_stop:  pe_ltp * slPercent,  pe_target: pe_ltp * tgtPercent,
  }

# ---------- MANAGEMENT : every tick batch ----------
onTick():                                          # called from checkTicks, NOT queued
  if state is falsy: return
  atm = round(ticksCache[spotToken].last_price / strikeStep) * strikeStep

  # -- rv-40sl ONLY: portfolio circuit breaker, evaluated FIRST --
  if cfg.portfolioStopLoss is set:
      pnl = Orderbook.getPNL(ticksCache)           # tools/stoploss.js, marks open legs at LTP
      if pnl < cfg.portfolioStopLoss:
          if state.ce_anchor: sendPair('BUY', state.ce_anchor, 'CE'); state.ce_anchor = false
          if state.pe_anchor: sendPair('BUY', state.pe_anchor, 'PE'); state.pe_anchor = false
          state = false                            # terminal: no re-entry (signal is still false)
          return

  # ---- CE leg ----
  if state.ce_anchor is truthy:
      q = ticksCache[ instr[(state.ce_anchor+otm)+'CE'] ]
      if not q: return                             # <-- RISK-B3: also skips the PE leg this tick
      ce = q.last_price

      if ce > state.ce_stop:                                    # ADVERSE -> roll further OTM
          sendPair('BUY', state.ce_anchor, 'CE')                # close current
          maxSlCount -= 1
          state.ce_anchor += moveOtm                            # move away from spot
          ce = ltp( (state.ce_anchor+otm)+'CE' )
          if ce < minimumPrice: state.ce_anchor = false; return  # leg retired, stay flat
          if maxSlCount <= 0:   state.ce_anchor = false; return  # budget exhausted, stay flat
          if cfg.rollPauseMs: await pause(cfg.rollPauseMs)       # rv-40sl: 5s gap
          sendPair('SELL', state.ce_anchor, 'CE')
          state.ce_stop = ce * slPercent; state.ce_target = ce * tgtPercent

      elif ce < state.ce_target
           and (state.ce_anchor - moveOtm + otm) >= (atm + otm):  # do not roll into/through ATM
          sendPair('BUY', state.ce_anchor, 'CE')
          maxSlCount += 1                                        # budget REFUND (uncapped)
          state.ce_anchor -= moveOtm                             # move toward spot
          ce = ltp( (state.ce_anchor+otm)+'CE' )
          if ce < minimumPrice: state.ce_anchor = false; return
          if cfg.rollPauseMs: await pause(cfg.rollPauseMs)
          sendPair('SELL', state.ce_anchor, 'CE')
          state.ce_stop = ce * slPercent; state.ce_target = ce * tgtPercent

  # ---- PE leg : exact mirror ----
  #   adverse  : pe > pe_stop  -> pe_anchor -= moveOtm   (further OTM = lower strike)
  #   favourable: pe < pe_target and (pe_anchor + moveOtm - otm) <= (atm - otm)
  #              -> pe_anchor += moveOtm
  #   same maxSlCount--/++ , minimumPrice and budget checks, same ordering.

sendPair(side, anchor, legs='both'):
  strikes = [ (anchor+otm)+'CE', (anchor-otm)+'PE' ]
  filter by legs ('CE' keeps only CE, 'PE' keeps only PE)
  for each: sendOrder(strike, side)

sendOrder(strike, side):
  if rail == 'bus':            PaperTrade.trackOrder(instr[strike], side, tag)
  if rail == 'zerodha-direct': Orderbook.addOrder(instr[strike], ticksCache[token].last_price, side)   # BEFORE
                               Account.placeAllAccount(tag, account_quantities, running_accounts,
                                                       instr[strike], side)                            # AFTER
```

### 2.3 Exit paths, exhaustively

There is **no time exit, no EOD square-off, and no cron of any kind** in 8 of the 9 `rv-*` files
(`rv-1` has crons, but only for candles/roll evaluation). A leg leaves the book only via:

1. **Adverse roll chain terminates** — `maxSlCount <= 0` after a decrement → BUY-to-close, leg set
   flat permanently.
2. **Premium floor** — the *newly selected* strike's LTP `< minimumPrice` → BUY-to-close already
   happened, leg set flat permanently.
3. **Portfolio breaker** (`rv-40sl` only) — `Orderbook.getPNL(ticksCache) < -1200` → BUY-to-close
   both legs, whole strategy terminal.
4. **Process death / external square-off** — `xtsOrder.js` 15:24 `clearOrders`, 15:30 `process.exit`,
   plus whatever manual/`XtsAccount.squareOff` operator action. Positions carried into expiry
   otherwise settle themselves. **This is the normal path.** Any TypeScript rewrite must add an
   explicit EOD flatten because the legacy behaviour is "leave it to the broker".

Roll-in (favourable) is **not** an exit — it re-establishes the leg closer to ATM.

### 2.4 Member table (idea B)

| file | tag | underlying / spot | step | `otm` | `moveOtm` | `slPercent` | `tgtPercent` | `minimumPrice` | `maxSlCount` | expiry | Wed→ATM | rail | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `rv-2.js` | `RV-2` | BANKNIFTY / 260105 | 100 | 100 | 100 | 1.25 | 0.60 | 20 | 3 | weekly | **yes** | bus | assigns `max_sl_count = 3` a second time in `runStrategy` (no-op) |
| `rv-40.js` | `RV-40` | BANKNIFTY / 260105 | 100 | 100 | 100 | 1.40 | 0.50 | 20 | 2 | weekly | no | bus | reference implementation |
| `rv-40e1.js` | `RV-40e1` | BANKNIFTY / 260105 | 100 | **0** | 100 | 1.40 | 0.50 | 20 | 2 | weekly | no | bus | `OTM = 0` forced in `runStrategy` → ATM straddle |
| `rv-40e2.js` | `RV-40e2` | BANKNIFTY / 260105 | 100 | **0** | 100 | 1.40 | 0.50 | 20 | 2 | weekly | no | bus | **byte-identical to `rv-40e1` except the tag** — a second instance for a second entry time |
| `rv-40n.js` | `RV-40n` | NIFTY / 256265 | 50 | 50 | 50 | 1.40 | 0.50 | 5 | 2 | weekly | no | bus | extra `console.log`s; `runStrategy()` wrapped in try/catch; drops `notify`/`CronJob` imports |
| `rv-25n.js` | `RV-25n` | NIFTY / 256265 | 50 | 50 | 50 | 1.25 | 0.60 | 5 | 3 | weekly | **yes** | bus | Wednesday override is wrong for NIFTY (Thursday expiry) — leftover from the BN template |
| `rv-s2.js` | `RV-S2` | BANKNIFTY / 260105 | 100 | 100 | 100 | 1.25 | 0.60 | 20 | 3 | **nextWeek** | **yes** | bus | subscribes AND trades next-week chain |
| `rv-40sl.js` | `RV-40SL` | BANKNIFTY / 260105 | 100 | 100 | 100 | 1.40 | 0.50 | 20 | 2 | weekly | no | **zerodha-direct** | + `portfolioStopLoss = -1200`, + `rollPauseMs = 5000`, + `loadAccounts` cron `30 * * * * 1-5`, `onTickCheckStoploss` is `async` |

`rv-2 / rv-25n / rv-s2` form the "1.25 / 0.60 / count 3 / Wednesday-ATM" sub-config;
`rv-40 / rv-40e1 / rv-40e2 / rv-40n / rv-40sl` form the "1.40 / 0.50 / count 2" sub-config.

---

## 3. Idea A — `rv-vol-roll-strangle` (`rv-1.js`, 1 file)

The only file in the repo computing realised volatility.

### 3.1 Config

```ts
{ tag: 'RV-1', underlying: 'BANKNIFTY', spotToken: 260105, strikeStep: 100,
  otm: 100, expiry: 'weekly',
  candleCron: '0 * * * * 1-5',        // 1-minute close sampler
  evalCron:   '0 */3 * * * 1-5',      // every 3 minutes
  evalStartDelayMs: 13 * 60 * 1000,   // evalCron only installed 13 minutes after boot
  rvLookback: 14,                     // last 14 minute-closes
  rvAnnualiser: 15.748015748,
  rail: 'bus' }
```

### 3.2 Pseudocode

```
candlestick: Map<token, number[]>          # append-only minute closes

makeCandles()  every minute at :00        # for EVERY token in ticksCache (index + all options)
  candlestick[token].push(ticksCache[token].last_price)

realizedVolatility(prices):               # note: this is RMS of log returns, NOT stdev about mean
  r = [ log(p[i]/p[i-1]) for i in 1..n-1 ]
  return sqrt( sum(r^2) / r.length ) * 15.748015748

rv(strikeKey):  round( realizedVolatility( candlestick[token(strikeKey)].slice(-14) ) * 100 )
                # NaN (fewer than 2 samples) is coerced to 0 by the `? :` guard

# every 3 minutes, starting 13 minutes after boot
takeTrade():
  atm = round(ticksCache[spotToken].last_price / 100) * 100      # unguarded: throws if no tick
  if ce_strike unset: ce_strike = atm + otm
  if pe_strike unset: pe_strike = atm - otm
  if atm == current_atm: return                                  # only act when ATM shifts
  current_atm = atm

  old = { ce_rv: rv(ce_strike+'CE'), pe_rv: rv(pe_strike+'PE') }
  new = { ce_rv: rv((atm+otm)+'CE'), pe_rv: rv((atm-otm)+'PE') }

  if old.ce_rv < new.ce_rv and old.pe_rv < new.pe_rv:            # BOTH new legs are higher-vol
      if strikePositions == 1:                                   # close existing pair first
          BUY ce_strike CE ; BUY pe_strike PE
      SELL (atm+otm)CE ; SELL (atm-otm)PE
      strikePositions = 1 ; ce_strike = atm+otm ; pe_strike = atm-otm
  elif old.ce_rv < new.ce_rv and strikePositions == 1:            # roll CE only
      BUY ce_strike CE ; SELL (atm+otm)CE ; ce_strike = atm+otm
  elif old.pe_rv < new.pe_rv and strikePositions == 1:            # roll PE only
      BUY pe_strike PE ; SELL (atm-otm)PE ; pe_strike = atm-otm
```

Intent: **always be short the strike pair with the higher recent realised volatility** (i.e. the
richer premium), re-evaluated whenever the ATM moves a full step.

Exits: none. No target, no stop, no time exit, no EOD flatten. Positions are only ever *rolled*.
The single "flat" state is the initial one, and `strikePositions` never returns to 0.

**Structural bug (RISK-A1):** on the very first `takeTrade`, `ce_strike`/`pe_strike` are set to
`atm ± otm` *before* the comparison, so `old` and `new` are computed on the *same* strikes →
`old.ce_rv < new.ce_rv` is false → **no branch fires and no position is ever opened**. Entry can
only happen on a later ATM shift where both new legs beat the previously-held legs on RV. In
practice `rv-1.js` frequently trades nothing at all.

**Bug (RISK-A2):** `total_rv: (Math.round(ce_rv + pe_rv * 100)) / 100` — precedence error, should
be `Math.round((ce_rv+pe_rv)*100)/100`. Field is unused, so harmless today.

---

## 4. Idea C — `cp-breakout-single-leg` (9 files)

### 4.1 Config

```ts
interface CpConfig {
  tag: string;                     // 'CP_S_2040'
  underlying: 'BANKNIFTY'|'NIFTY'|'SENSEX';
  spotToken: number;               // 260105 | 256265 | 265
  strikeStep: number;              // 100 in every file (see RISK-C7 for NIFTY)
  side: 'SELL' | 'BUY';            // entry side; exits are the opposite
  breakoutLevel: number;           // absolute INDEX points from basePrice
  legOnUpMove: 'CE' | 'PE';        // which option type to trade when index rises by +breakoutLevel
  exitBasis: 'percent' | 'points';
  slPercent?: number;  tgtPercent?: number;    // multipliers on the entry FILL price
  slPoints?: number;   tgtPoints?: number;     // absolute premium points
  basePriceDelayMs: 10000;         // when basePrice is captured
  armDelayMs: 5000;                // additional delay before breakout arming
  reverseDelayMs: 3000;            // delay between an OCO fill and the flip order
  winStop: 1;                      // counter >= +1 -> stop for the day
  lossStop: -2;                    // counter <= -2 -> stop for the day
  xtsCancelAccountId: '65f7c2f15401da14d2bc7bbe';   // hardcoded in all 9 files
}
```

### 4.2 Pseudocode

```
# ---------- boot ----------
load chain(weekly), subscribe [spotToken, ...allOptionTokens]
open change-stream on Mongo collection "OrderUpdate"          # see 4.3
t+10s: basePrice = ticksCache[spotToken].last_price           # unguarded, see RISK-C1
t+15s: startTrade = true

# ---------- breakout : fires AT MOST ONCE per process ----------
onTick():
  if not (startTrade and isFirstTrade): return
  if not strategyActive: return
  spot = ticksCache[spotToken]; if !spot or !basePrice: return
  move = spot.last_price - basePrice

  if move >= +breakoutLevel and currentDirection != oppositeOf(legOnUpMove):
      currentDirection = legOnUpMove ; placeEntry(legOnUpMove) ; isFirstTrade = false
  elif move <= -breakoutLevel and currentDirection != legOnUpMove:
      currentDirection = oppositeOf(legOnUpMove) ; placeEntry(oppositeOf(legOnUpMove)) ; isFirstTrade = false
  # NOTE: the whole block is synchronous up to `isFirstTrade = false`, so no tick can interleave.

placeEntry(type):                        # identical body in placeBreakoutOrder / placeReverseOrder
  if not strategyActive: return
  atm = round(ticksCache[spotToken].last_price / strikeStep) * strikeStep
  option = instr[atm + type];  if not option: log and return
  id = eventId()
  eventTrigger[id] = { strike: atm, type, instrument_token: option.instrument_token,
                       action: 'place_sl_target' }
  currentDirection = type                                  # placeReverseOrder only
  PaperTrade.trackOrder_v2(option, cfg.side, tag, 1, [id])  # MARKET, status already COMPLETE

# ---------- OrderUpdate change-stream state machine ----------
on insert into OrderUpdate where updateType=='order' and strategy==tag and params.length>0:
  idx = params[0]
  trig = eventTrigger[idx]; if not trig: return             # <-- THE re-entrancy guard

  if trig.action == 'place_sl_target' and status == 'Filled':
      p = float(update.price)                               # broker average traded price
      stop   = round1( exitBasis=='percent' ? p * slPercent  : p + slPoints  )
      target = round1( exitBasis=='percent' ? p * tgtPercent : p - tgtPoints )
      slId = eventId(); tgtId = eventId()
      instrument = instr[ trig.strike + trig.type ]
      eventTrigger[slId]  = {action:'sl_hit',     oppositeOrderId: tgtId, direction: trig.type,
                             instrument_token: instrument.instrument_token, stopPrice: stop}
      eventTrigger[tgtId] = {action:'target_hit', oppositeOrderId: slId,  direction: trig.type,
                             instrument_token: instrument.instrument_token, targetPrice: target}
      trackOrder_slm  (instrument, opposite(cfg.side), tag, 1, stop,   [slId])
      trackOrder_limit(instrument, opposite(cfg.side), tag, 1, target, [tgtId])
      eventTrigger[idx] = false                             # consume, synchronously

  elif trig.action == 'sl_hit' and status == 'Filled':
      XtsAccount.removePending(cfg.xtsCancelAccountId, tag, cb)   # cancel the sibling limit order
      strategyCounter -= 1
      if strategyCounter <= cfg.lossStop:  strategyActive = false           # DAY STOP
      else: after cfg.reverseDelayMs: if strategyActive: placeEntry(flip(trig.direction))
      executeSL(idx, trig.instrument_token, update.price)    # stamp the bus doc COMPLETE
      eventTrigger[idx] = false ; eventTrigger[trig.oppositeOrderId] = false

  elif trig.action == 'target_hit' and status == 'Filled':
      XtsAccount.removePending(cfg.xtsCancelAccountId, tag, cb)   # cancel the sibling stop order
      strategyCounter += 1
      if strategyCounter >= cfg.winStop:  strategyActive = false            # DAY STOP
      else: after cfg.reverseDelayMs: if strategyActive: placeEntry(flip(trig.direction))
      executeSL(idx, trig.instrument_token, update.price)
      eventTrigger[idx] = false ; eventTrigger[trig.oppositeOrderId] = false

executeSL(orderId, token, price):
  trade = PaperTrade.findOne({tag, dataObj: [parseInt(orderId)], instrument_token: token})
  if trade: trade.status='COMPLETE'; trade.order_type='MARKET';
            trade.order_timestamp=now(); trade.average_price=float(price); save()
```

### 4.3 Behavioural consequences worth stating explicitly

- `winStop = 1` and the counter is **shared**, so the day ends after the **first winner**, or after
  **two net losses**. A loss then a win → counter `-1` then `0`, which is neither ≥1 nor ≤−2, so
  trading continues. A win first → counter `1` → stop. So the realistic sequences are
  `W` (stop), `L L` (stop), `L W` (counter 0, keeps going), `L W L` … — the counter is a *net*
  score, not a trade count. This is almost certainly not what the author intended but it is the
  shipped behaviour.
- **Only one base-price breakout per process.** `isFirstTrade` is never reset. Every subsequent
  position comes from the reverse chain.
- **No time/EOD exit inside the strategy at all.** Flattening depends on `xtsOrder.js`'s 15:24
  `clearOrders` + operator `XtsAccount.squareOff`. A position left open when `strategyActive`
  flips false stays open — but note that in both stop branches the position was just closed by the
  OCO fill, so `strategyActive=false` is always reached flat.
- `activeOrderIds` is written and never read (dead).

### 4.4 Member table (idea C)

| file | tag | underlying / spot | `side` | `breakoutLevel` (index pts) | `legOnUpMove` | exit basis | SL | target | notes |
|---|---|---|---|---|---|---|---|---|---|
| `cp-s-2040.js` | `CP_S_2040` | BANKNIFTY / 260105 | SELL | 20 | **PE** | percent | ×1.20 | ×0.60 | reference implementation |
| `cp-s-030.js` | `CP_S_030` | BANKNIFTY / 260105 | SELL | 3 | PE | percent | ×1.03 | ×0.97 | |
| `cp-s-010.js` | `CP_S_010` | BANKNIFTY / 260105 | SELL | 3 | PE | percent | ×1.03 | ×0.99 | target is 1% — reward:risk 1:3 |
| `cp-ns-2040.js` | `CP_NS_2040` | NIFTY / 256265 | SELL | 20 | PE | percent | ×1.20 | ×0.60 | **strike step left at 100** |
| `cp-snx-2040.js` | `CP_SNX_2040` | SENSEX / 265 | SELL | 20 | PE | percent | ×1.20 | ×0.60 | |
| `cp-snx-030.js` | `CP_SNX_030` | SENSEX / 265 | SELL | 3 | PE | percent | ×1.03 | ×0.97 | ±3 pts on a ~80 000 index ⇒ fires instantly |
| `cp-rs-030.js` | `CP_RS_030` | BANKNIFTY / 260105 | SELL | 3 | **CE** | percent | ×1.03 | ×0.97 | `rs` = reversed side vs `cp-s-030` |
| `cp-s-3370.js` | `CP_S_3370` | BANKNIFTY / 260105 | SELL | 50 | **CE** | **points** | `+33` | `−70` | only absolute-point variant; despite the `s` name it uses the CE-on-up mapping |
| `cp-b-2040.js` | `CP_B_2040` | BANKNIFTY / 260105 | **BUY** | 20 | **CE** | percent | ×0.80 | ×1.40 | only long variant; SL/target orders are `SELL` |

`legOnUpMove` interpretation, in position terms:
- `PE` on an up-move ⇒ short put on strength / short call on weakness ⇒ **momentum-following**
  (the 6 `cp-s-*`/`cp-ns-*`/`cp-snx-*` files).
- `CE` on an up-move ⇒ short call on strength ⇒ **momentum-fading** (`cp-rs-030`, `cp-s-3370`);
  with `side: BUY` it is long call on strength ⇒ momentum-following again (`cp-b-2040`).

---

## 5. Config axes that regenerate all 18 files

| axis | type | values seen | applies to |
|---|---|---|---|
| `underlying` (spot token + strike step) | enum | BANKNIFTY 260105/100, NIFTY 256265/50, SENSEX 265/100 | A, B, C |
| `expiry` | enum | `weekly` (17 files), `nextWeek` (`rv-s2`) | A, B |
| `otm` / strike offset from ATM | points | 0 (straddle), 50, 100 | A, B |
| `wednesdayAtmOverride` | bool | true (`rv-2`, `rv-25n`, `rv-s2`), false (rest) | B |
| stop/target basis | enum | `premium-percent` (`slPercent`/`tgtPercent`), `premium-points` (`cp-s-3370`), `realised-volatility-ranking` (`rv-1`) | A, B, C |
| `slPercent` / `tgtPercent` | float | B: 1.25/0.60, 1.40/0.50 · C: 1.03/0.99, 1.03/0.97, 1.20/0.60, 0.80/1.40 | B, C |
| `slPoints` / `tgtPoints` | points | 33 / 70 | C |
| `moveOtm` (roll distance) | points | 50, 100 | B |
| `minimumPrice` (premium floor) | ₹ | 5 (NIFTY), 20 (BANKNIFTY) | B |
| `maxSlCount` (roll budget) | int | 2, 3 | B |
| `portfolioStopLoss` | ₹ | `-1200` (`rv-40sl`) or absent | B |
| `rollPauseMs` | ms | 5000 (`rv-40sl`) or 0 | B |
| `entryTrigger` | enum | `immediate-after-delay` (B, 20 s) · `atm-shift-cron` (A, 3 min) · `index-point-breakout` (C) | A, B, C |
| `breakoutLevel` | index points | 3, 20, 50 | C |
| `side` | enum | SELL (8), BUY (1) | C |
| `legOnUpMove` | enum | PE (6), CE (3) | C |
| `winStop` / `lossStop` | int | +1 / −2 (all) | C |
| delays | ms | B: 20 000 entry, 1 000 retry · C: 10 000 base, 5 000 arm, 3 000 reverse · A: 780 000 eval-arm | A, B, C |
| `rail` | enum | `bus` (17), `zerodha-direct` (`rv-40sl`) | A, B, C |
| sizing | — | **flat 1 lot on the bus** in all 18; real lots from `account.strategy[tag]` | A, B, C |
| instance duplication | — | `rv-40e1` vs `rv-40e2` differ *only* by tag ⇒ "N instances of the same config, different start times" must be a first-class deployment concept | B |

---

## 6. MUST-PRESERVE behaviours

**Idea B**
1. **`signal` one-shot latch is set to `false` before any `await`.** Entry must be exactly once per
   process lifetime; a failed entry attempt (missing spot tick) resets it and retries at 1 s, but a
   *successful* entry latches it forever. There is no re-entry after a full exit.
2. **Tick-availability precondition:** entry aborts and retries if `ticksCache[spotToken]` is
   undefined. Same idea must gate every LTP read in a rewrite.
3. **Order-flag ordering inside a roll is close→(pause)→open**, never open→close.
   `rv-40sl` inserts a **5 000 ms pause between the BUY-to-close and the SELL-to-open** and the
   `Orderbook.addOrder(...)` bookkeeping happens **before** `Account.placeAllAccount(...)`.
   Both orderings are load-bearing for margin/PNL correctness.
4. **`maxSlCount` is a single budget shared by both legs, decremented on adverse rolls and
   *incremented* on favourable rolls.** It is not a per-leg counter and it is not monotone.
5. **The `maxSlCount <= 0` check happens *after* the buy-to-close and *after* the `minimumPrice`
   check.** Order of these three guards determines whether the final adverse move leaves you flat
   or short a new strike.
6. **Roll-in is blocked from crossing ATM:** CE requires `ce_anchor - moveOtm >= atm`;
   PE requires `pe_anchor + moveOtm <= atm`. Never roll a short leg into the money.
7. **`minimumPrice` retires a leg permanently** (`anchor = false`) rather than pausing it.
8. **`otm` may be mutated once at boot** (Wednesday override / `rv-40e*` forcing 0) and the stored
   state is the *anchor*, not the strike: actual strike is always `anchor ± otm`. Rolling moves the
   anchor. A rewrite that stores the strike directly will silently change `rv-2`'s Wednesday case.
9. **`rv-s2` subscribes and trades the next-week chain**, not the current week — chain selection is
   a config value read once at boot, with no intraday rollover.
10. **Portfolio breaker is evaluated before per-leg logic and is terminal**: it closes both legs,
    sets state falsy, and because `signal` is already false there is no re-entry for the day.
11. `Orderbook` (`tools/stoploss.js`) prices fills at the **LTP at submit time**, nets per
    `tradingsymbol`, and marks the open residual at LTP. The `-1200` threshold is calibrated to
    that specific (optimistic, slippage-free) PNL definition.

**Idea C**
12. **`eventTrigger[id] = false` set synchronously at the end of each handler branch is the only
    duplicate-fill guard.** `xtsOrder.js` tranches large orders and fans out across accounts, so the
    *same* logical fill produces **one `OrderUpdate` per account per tranche**. Without this
    synchronous consume, the counter would move N times and N reverse orders would be placed.
    Any async rewrite must consume the id **before** the first `await`.
13. **The OCO correlation key travels through the broker's `OrderUniqueIdentifier`**
    (`[tag, ...dataObj].join('|')` → `OrderUpdate.params`). It is a per-process integer counter
    from `eventId()`. Keep the tag/params round-trip intact or every exit stops working.
14. **`isFirstTrade` allows exactly one base-price breakout per process.** All later positions come
    from the reverse chain. Restart semantics: a restart re-captures `basePrice` from the current
    index and re-arms — there is **no catch-up and no position reconciliation**.
15. **SL/target prices are derived from the broker's actual `OrderAverageTradedPrice`** of the entry
    fill, not from the LTP at signal time.
16. **`XtsAccount.removePending(accountId, tag)` is a blanket cancel of every open order carrying
    the tag** — that is *how* the OCO sibling gets cancelled. `oppositeOrderId` is only used to
    null the in-memory trigger.
17. **`executeSL` manually stamps the `paper-trade` doc COMPLETE / MARKET / average_price** when the
    broker reports the SL or target fill. This is the only thing that closes the bus-side record for
    `Pending` StopMarket/Limit docs.
18. **`round1` on stop/target** (`toFixed(1)`), then `xtsOrder.js` applies `parseInt` on the limit
    price and `parseInt` on the stop price, and rewrites StopMarket→StopLimit with a ±1 % (>₹1000)
    or ±5 % (≤₹1000) protective limit. The effective exit price is *not* the number the strategy
    computed.
19. **Both stop conditions are on a net counter, not on trade count** (`+1` win, `−2` losses) — see
    §4.3.
20. **`strategyActive` is re-checked inside the 3 s reverse timer**, so a day-stop that lands during
    the delay cancels the pending flip.

**Both**
21. `optionConfig()` is scraped **once at boot**; the strike→instrument map never refreshes. A strike
    that walks outside the scraped chain simply does not exist (see RISK-B2).
22. The tag is the *only* thing binding a strategy to real money. Enabling `account.strategy[tag]` on
    a Zerodha `Account` and on an `xtsAccount` simultaneously doubles every order.

---

## 7. Bugs / dead code / dangerous behaviour

### Idea A (`rv-1.js`)
- **RISK-A1 (behavioural, severe):** the first `takeTrade` compares a strike pair against *itself*
  (`ce_strike`/`pe_strike` are initialised to `atm ± otm` immediately before the comparison), so no
  branch can fire and **no initial position is ever taken**. Entry is only possible on a later ATM
  shift, and the two "roll one leg" branches are gated on `strikePositions == 1`, which only branch 1
  can set. The strategy is largely inert.
- **RISK-A2:** `total_rv: (Math.round(ce_rv + pe_rv * 100)) / 100` — operator-precedence error.
  Currently unused.
- **RISK-A3:** `takeTrade` reads `ticksCache[futureToken].last_price` with **no guard and no
  try/catch** → `TypeError` → unhandled rejection if the index tick is missing (masked in practice by
  the 13-minute arming delay).
- **RISK-A4:** `printRV` indexes `currentExpiryOptions[strike+'CE'].instrument_token` unguarded —
  throws if the ATM has walked outside the scraped chain.
- **RISK-A5:** `realizedVolatility` computes the **RMS of log returns**, not the standard deviation
  (no mean subtraction), and annualises with a hardcoded `15.748015748` (= √248) on *minute* data,
  which is dimensionally wrong. Values are only meaningful as a relative ranking — which is all the
  code uses them for, so preserve the formula verbatim rather than "fixing" it.
- **RISK-A6:** `makeCandles` pushes a sample for **every** token in `ticksCache` (300-400 option
  tokens) every minute, forever, with no trimming — unbounded memory growth over a session.
- **RISK-A7:** `makeCandles` pushes the *last received tick* price, not a true minute close; if a
  strike stops ticking, its series silently repeats the stale price and its RV collapses toward 0.
- Dead code: `channelId`, `farOtm`, `init_pending`, `optionOrders`, `accounts`,
  `running_accounts`, `account_quantities`, `firstRun`, `notify` import, `tradeObj.CE/PE:false`
  initialisers.

### Idea B (`rv-2`, `rv-25n`, `rv-40*`, `rv-s2`)
- **RISK-B1 (severe, money):** in `takeTrade`, `sendPairOrder('SELL', atm)` is issued **before**
  reading `ce_ltp`/`pe_ltp`. If either option token is not yet in `ticksCache`, the LTP read throws,
  the `catch` swallows it, `optionOrders` is never populated — leaving a **naked short strangle with
  no stop, no target and no management for the rest of the day**, and `signal` is already `false` so
  nothing retries. The 20 s startup delay is the only mitigation.
- **RISK-B2 (severe):** every strike lookup is `currentExpiryOptions[<computed>].instrument_token`
  with no existence check. As a leg rolls outward it will eventually name a strike absent from the
  boot-time chain → `TypeError` on **every tick**. In `rv-2`/`rv-40*` `onTickCheckStoploss` has **no
  try/catch** at all; in `rv-40sl` it is `async` so the throw becomes a silent unhandled rejection.
  Either way management dies while the position stays open.
- **RISK-B3:** `if (!ce_ltp) return;` inside the CE block returns from the whole function, so a
  missing CE quote **starves the PE leg's stop-loss check** for that tick.
- **RISK-B4 (severe, `rv-40sl` only):** `onTickCheckStoploss` is `async` and `await`s
  `pause(5000)`, but `checkTicks` still calls it **directly and unawaited on every tick batch**.
  A single `async.queue` (`checkSLQ`, defined at `rv-40sl.js:246`) exists to serialise it but is
  **never pushed to — pure dead code**. Result: during the 5 s pause, dozens of concurrent
  invocations re-read the *pre-roll* state, so one adverse move fires **many** buy/sell roll pairs
  and drives `max_sl_count` far negative. This is the **only live-money file in the family**.
- **RISK-B5 (`rv-40sl`):** `sendOrder` comments out its own `PaperTrade.trackOrder` — but
  `Account.placeAllAccount` calls `trackOrder(...)` internally anyway. So a `paper-trade` doc *is*
  written. If `RV-40SL` is also enabled on an `xtsAccount`, every order is placed **twice**: once on
  Zerodha directly and once on XTS via the bus.
- **RISK-B6:** `Orderbook.getPNL(ticksCache)` does `ticksCache[position.instrument_token].last_price`
  unguarded → throws for a symbol that has stopped ticking, killing the circuit breaker.
- **RISK-B7:** `max_sl_count++` on favourable rolls is **uncapped**, so a chop-heavy day can inflate
  the roll budget without limit and turn a bounded-risk design into an unbounded one.
- **RISK-B8:** `moment().day() == 3` (Wednesday) ATM override is applied to **NIFTY** in `rv-25n.js`,
  whose expiry is Thursday. It is a copy-paste leftover from the BANKNIFTY template. It is also
  stale for BANKNIFTY post-2024 expiry-day changes — the rewrite must express this as
  "on expiry day, trade ATM", derived from the chain, not a weekday literal.
- **RISK-B9:** `rv-40e1.js` and `rv-40e2.js` are byte-identical except `strategyTag`. Pure
  duplication.
- **RISK-B10:** `rv-2.js` sets `max_sl_count = 3` in `runStrategy` on top of the identical
  declaration initialiser — harmless, but reveals the file was patched, not authored.
- **RISK-B11:** no EOD flatten, no time stop, no max-loss (except `rv-40sl`). A short strangle can
  be carried into expiry settlement.
- **RISK-B12:** the module-level `max_sl_count`, `OTM`, `optionOrders` are process globals; there is
  no way to run two configs in one process, and a restart resets the roll budget and forgets the
  open position entirely (**no position reconciliation on restart**).
- Dead code: `farOtm`, `channelId`, `init_pending`, `notify` import (unused in most),
  `accounts`/`firstRun` in the bus-rail files, the `optionOrders` re-declaration.

### Idea C (`cp-*`)
- **RISK-C1:** `basePrice = ticksCache[futureToken].last_price` runs inside a bare `setTimeout`
  callback with **no try/catch** — a missing index tick at t+10 s throws an uncaught exception and
  kills the process.
- **RISK-C2 (severe):** `eventId()` restarts at `0` on every process start. After a restart, new
  order ids **collide with the ids of still-pending broker orders from the previous run** on the same
  tag; an old order's fill will then drive the new run's state machine (or vice versa).
- **RISK-C3:** `smp_order_listener` emits `OrderUpdate` for `REJECTED` as well as `FILLED`, but the
  handler only acts on `status == 'Filled'`. A rejected entry leaves `eventTrigger[idx]` alive with
  no SL/target and **no notification** — the strategy silently stalls flat for the day. A rejected
  *SL* order leaves the position unprotected.
- **RISK-C4:** `XtsAccount.removePending` is called with a **hardcoded account ObjectId**
  `"65f7c2f15401da14d2bc7bbe"` in all 9 files. If the tag runs on any other XTS account, that
  account's OCO sibling is **never cancelled** → orphaned resting stop/limit orders that can fill
  into an unintended position.
- **RISK-C5:** `cancelPendingOrder()` is fire-and-forget and is called **before** the reverse order
  is placed on a 3 s timer, with no confirmation that the cancel succeeded. A slow cancel plus a fast
  flip can leave the old sibling live alongside the new position.
- **RISK-C6:** the day-stop uses a **net** counter, so `winStop = +1` / `lossStop = −2` does not mean
  "stop after 1 win or 2 losses"; `L,W` returns to 0 and trading continues indefinitely in an
  alternating win/loss sequence. Almost certainly unintended.
- **RISK-C7:** `cp-ns-2040.js` (NIFTY) keeps `Math.round(price/100)*100`. NIFTY strikes step by 50,
  so the "ATM" strike chosen can be up to 50 points away — a materially different option.
- **RISK-C8:** `breakoutLevel = 3` index points (`cp-s-010`, `cp-s-030`, `cp-rs-030`,
  `cp-snx-030`) is below one tick of normal noise on BANKNIFTY (~52 000) and absurd on SENSEX
  (~80 000). These variants effectively enter at t+15 s in whichever direction the first tick
  happens to point — there is no real breakout logic left.
- **RISK-C9:** `trackOrder_*` hardcodes `"exchange": "NFO"` for the SENSEX variants.
  `xtsOrder.js` repairs it (`index_name == 'SENSEX'` → `BSEFO`), but the Zerodha rail and
  `paperstream` would use the wrong segment.
- **RISK-C10:** the SL is a `StopMarket` that `xtsOrder.js` converts to a `StopLimit` with only a
  ±1 % protective band above ₹1000. On a gap the stop-limit can fail to fill, leaving a short option
  running with the strategy believing it is protected.
- **RISK-C11:** no EOD square-off, no time stop and no daily-loss rupee cap inside the strategy.
- **RISK-C12:** `activeOrderIds` is assigned and never read; `stopPrice`/`targetPrice` stored on the
  trigger objects are never read; `channelId`, `accounts`, `running_accounts`,
  `account_quantities`, `firstRun`, `fromDate`, `toDate`, `zapi` (after boot) are dead.
- **RISK-C13:** the change-stream on `OrderUpdate` is opened at module load with
  `collection.watch()` and **no resume token**. A dropped stream permanently disables all exits with
  no error surfaced.
- **RISK-C14:** `cp-s-3370.js`'s name says `s` (the "sell opposite-momentum" convention of its
  siblings) but its `legOnUpMove` is `CE`, i.e. it fades momentum like `cp-rs-030`. Do not trust
  the filename encoding.

---

## 8. Target TypeScript shape

Two classes plus a thin third:

```ts
// idea B — the one that matters
class PremiumRollStrangle implements Strategy {
  constructor(cfg: RvRollConfig, deps: { feed: TickFeed; chain: OptionChain; exec: OrderRouter; clock: Clock });
  // one-shot entry latch, per-leg roll state machine, serialised tick handler (mandatory)
}

// idea C
class BreakoutFlipSingleLeg implements Strategy {
  constructor(cfg: CpConfig, deps: { feed: TickFeed; chain: OptionChain; exec: OrderRouter;
                                     fills: FillStream; clock: Clock });
  // base-price capture -> one breakout -> OCO -> flip chain -> net-counter day stop
}

// idea A — keep, but fix RISK-A1 explicitly and behind a config flag
class RvRankedStrangle implements Strategy { /* rv-1 only */ }
```

Non-negotiable additions in the rewrite (all absent from the legacy code and all safe to add):

- serialised (queued) tick/fill handling — kill RISK-B4 and RISK-C2 by construction;
- `chain.get(strike, type)` returning `Option | undefined`, never throwing — kill RISK-A4/RISK-B2;
- LTP reads that require a quote before any order is sent, and an entry that is **atomic**
  (quotes first, then orders) — kill RISK-B1;
- an explicit EOD flatten time per config;
- durable, tag-scoped, restart-safe correlation ids for the OCO channel — kill RISK-C2;
- position reconciliation on start (read the broker/`paper-trade` book for the tag) so a restart
  resumes management instead of re-arming from scratch;
- expiry-day detection from the chain (`daysToExpiry == 0`), replacing every `moment().day() == 3`.
