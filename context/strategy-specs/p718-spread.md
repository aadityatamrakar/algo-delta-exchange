# Family spec: `p718-spread`

**Scope:** 11 legacy files in `server/slive/`
`p718-1.js p718-2.js p718-3.js p718-4.js p718-5.js ce-d2-0020.js ce-d2-extra.js ce-d2p-extra.js pe-d2-0020.js pe-d2-extra.js pe-d2p-extra.js`

**Verdict:** the filename prefix is a red herring. There are **three genuinely unrelated
algorithms** here, sharing only boilerplate (Kite ticker bootstrap, `optionInstruments` config,
BANKNIFTY index token `260105`, `Math.round(spot/100)*100` ATM rounding).

| Idea | Proposed class | Files | One-liner |
|---|---|---|---|
| A | `SyntheticSupertrendStrangle` | p718-1, p718-2, p718-3 | Sell a symmetric BANKNIFTY strangle when Supertrend(14,5) computed on a **synthetic CE+PE combined-premium** 3-min series is above the synthetic close; flat when it flips. Only technical-indicator strategy in `slive/`; only live `tulind` consumer. |
| B | `ScheduledAtmSell` | p718-4, p718-5 | Sell ATM option(s) at ~20 (p718-4) / 4 (p718-5) hand-tuned clock times per weekday, each slot carrying its own SL multiple (1.1x–2.0x of fill). p718-4 = straddle + Thursday wings + broker-echo SLM; p718-5 = single leg chosen by option-chain max-pain. |
| C | `RatioSpreadLadder` | ce-d2-0020, ce-d2-extra, ce-d2p-extra, pe-d2-0020, pe-d2-extra, pe-d2p-extra | Scan a 24-pair ladder of same-side strike pairs on **live order-book depth**; buy 1x near strike / sell 2x far strike for a small net **debit**; take profit at +N points of spread value; ladder threshold escalates by 0.25 per fill. `-d2p-` variants persist ladder state and resume after restart. |

**Shared, non-negotiable prerequisites for all three:**
- `optionConfig()` = `server/tools/optionInstruments.js`; it **`require()`s the cached file
  `optionConfig_BANKNIFTY.json` from the repo root** and only hits Sensibull when that require
  throws. Keys are `` `${strike}${instrument_type}` `` e.g. `"44500CE"`. Values carry
  `instrument_token, tradingsymbol, strike, lot_size, expiry`.
- `futureToken = 260105` is hardcoded in all 11 files and is the **BANKNIFTY index** token; the
  variable name is a lie. Strike step is hardcoded `100` everywhere (never derived).
- Ticks arrive via `lib/KiteTicker` in `modeFull` (needed for `depth` in idea C).
- Every strategy is a *process*: module top-level side effects (`runStrategy()`, `new CronJob(...)`)
  fire at `require` time.

---

## Idea A — `SyntheticSupertrendStrangle`

Files: `p718-1.js` (187 L), `p718-2.js` (228 L), `p718-3.js` (228 L, byte-identical to p718-2
except tag + `farAtm`).

### Data preparation (the unusual part — preserve exactly)

```
every 3 minutes, cron '0 */3 * * * 1-5' Asia/Kolkata, while (strategy_running && final_running):
  spot = ticksCache[260105].last_price          # BANKNIFTY index LTP
  if spot missing -> spin the do/while up to 10 times, no sleep, then give up this cycle

  if not currentDirection:                       # not in a trade -> re-pick strikes
      atm   = round(spot/100)*100
      legCE = options[(atm + farAtm) + "CE"]
      legPE = options[(atm - farAtm) + "PE"]
  else:                                          # in a trade -> keep the held strikes
      legCE = instrument_CE ; legPE = instrument_PE

  barsCE = zapi.historyData(legCE.token, '3minute', today-30d, today)
  barsPE = zapi.historyData(legPE.token, '3minute', today-30d, today)

  # synthetic combined-premium series, walked BACKWARDS from each array's own end
  n = min(len(barsCE), len(barsPE)) - 1
  synth = []
  for k in n..0:  (i1 = len(barsCE)-1-  ..., i2 = len(barsPE)-1- ...)
      c = barsCE[i1].close + barsPE[i2].close
      synth.unshift({ ts1: barsCE[i1].ts, ts2: barsPE[i2].ts,
                      high: c, low: c, close: c })   # high == low == close  (!)

  synth = Supertrend(synth, period=14, mul=5)        # lib/indicators/atr.js
  cur   = synth[last]
```

`lib/indicators/atr.js` is a tulind ATR(14) followed by a hand-rolled Supertrend with
`mul = 5`. Because `high == low == close` on every synthetic bar, true range collapses to
`|close - prevClose|`, so **ATR here is a 14-period mean absolute change of the combined premium**
and the bands are `close ± 5 * meanAbsChange`. Any reimplementation must reproduce this, not a
textbook Supertrend on real OHLC.

### Entry

```
if (!currentDirection && cur.supertrend > cur.close):
    currentDirection = true
    instrument_CE = legCE ; instrument_PE = legPE     # lock strikes for the life of the trade
    if (takePositions):
        currentPosition = true
        # p718-2 / p718-3 only:
        entry_price    = parseInt(LTP(PE) + LTP(CE))   # truncated to int
        stoploss_price = entry_price + 30
        placeAllAccount(tag, qtys, accounts, instrument_CE, 'SELL')
        placeAllAccount(tag, qtys, accounts, instrument_PE, 'SELL')
```

`supertrend > close` = Supertrend line above the combined premium = premium downtrend = sell
the strangle. Note the entry is gated on `currentDirection`, **not** on `currentPosition`, and
the strikes are locked so subsequent 3-min cycles compute the indicator on the *held* pair.

### Exit paths

1. **Indicator flip** (all three files):
   `currentDirection && cur.supertrend < cur.close` -> `currentDirection = false`; if
   `currentPosition` then BUY both legs. p718-2/3 additionally accumulate
   `total_loss += -(entry_price - positionPnl)` where `positionPnl = LTP(PE)+LTP(CE)`.
2. **Combined-premium stop, p718-2/3 only** — evaluated on **every tick batch** (`checkSL()`
   called from `checkTicks`), not on the 3-min cron:
   `if (checkSLPrice && positionPnl > stoploss_price)` -> flat both legs,
   `checkSLPrice = false` **permanently**, `total_loss += currentLoss`.
   *`takePositions` stays true, so the strategy re-enters on the next flip — but with no price
   stop for the rest of the day.*
3. **Daily loss breaker, p718-2/3 only**: `else if (max_stoploss < total_loss + currentLoss)`
   -> flat both legs, `takePositions = false`, `strategy_running = false` (kills further cron
   evaluation for the day).
4. **14:59:30 kill switch** (all three): `new CronJob('30 59 14 * * 1-5')` sets
   `final_running = false; strategy_running = false`. **This does NOT flatten anything** — an
   open strangle is simply abandoned and carried to the next session / expiry.
5. p718-1 has **no stop of any kind** — exit 1 and the 14:59:30 no-op are its only paths.

### Sizing / rail

- `Account.placeAllAccount(tag, account_quantities, running_accounts, instrument, side)` with
  `multiplier` defaulted to `1`.
- `placeAllAccount` (common/models/account.js:148) **always** writes one `paper-trade` bus record
  via `Account.trackOrder` (status `COMPLETE`, `MARKET`, `quantity = lot_size * 1`, no
  `average_price`), *then* fires direct synchronous Zerodha orders for every entry in
  `running_accounts`, tranched at 60 qty for BANKNIFTY.
- **`getAccounts()` is defined but never called in any of p718-1/2/3.** Therefore
  `running_accounts = []` and `account_quantities = {}` for the whole process lifetime: no
  Zerodha order is ever placed. The effective rail is **bus-only, 1 lot**, and the fill price is
  stamped later by `server/boot/paperstream.js` from its own `ticksCache`.

### Config axes (idea A)

| axis | p718-1 | p718-2 | p718-3 |
|---|---|---|---|
| `strategyTag` | `P718-1` | `P718-2` | `P718-3` |
| `farAtm` (points OTM each side) | 100 | 200 | 300 |
| per-trade stop | none | `entry+30` combined pts | `entry+30` |
| `max_stoploss` (cumulative pts/day) | none | 80 | 80 |
| everything else | identical | identical | identical |

Fixed for the family: underlying BANKNIFTY / token 260105 / step 100, `3minute` candles,
30-day history window, Supertrend(14, 5), cron `0 */3 * * * 1-5`, kill at 14:59:30,
qty = 1 lot, weekly expiry (`weeklyInstruments`, **no** Wednesday roll to next week).

---

## Idea B — `ScheduledAtmSell`

Files: `p718-4.js` (356 L, ~18 KB of CronJob literals), `p718-5.js` (249 L).

### Schedule (the whole "algorithm" is this table)

Cron pattern is `'58 <mm> <hh> * * <dow>'` — i.e. entries fire at **hh:mm:58**. Only the
current weekday's branch is registered (`if (moment().day() == N)`), so the process must be
(re)started each morning.

**p718-4 — 20 slots/weekday, `time = SLmultiple` (`H` = hedged/qty-2 Thursday form):**

```
Mon: 09:16=1.1 09:21=1.3 09:26=1.1 09:31=1.2 10:06=1.4 10:46=1.3 10:56=1.2 11:01=1.1
     11:06=1.2 11:31=1.6 11:36=1.1 11:46=1.7 11:51=1.4 12:11=1.5 12:16=1.5 12:21=1.5
     12:26=1.5 12:41=1.1 12:46=1.2 12:56=1.5
Tue: 09:16=1.7 09:21=1.1 09:26=1.2 09:31=1.3 09:36=1.9 09:41=1.1 09:51=1.3 10:11=1.2
     10:16=1.6 10:36=1.3 10:46=1.2 10:51=1.4 10:56=1.1 11:01=1.4 11:31=1.5 11:41=1.4
     11:51=1.4 11:56=1.4 12:01=1.1 12:06=1.4
Wed: 09:16=1.1 09:21=1.8 09:26=1.8 09:31=1.8 09:36=1.2 09:41=1.1 09:56=2.0 10:01=1.2
     10:06=1.2 10:16=1.1 10:21=1.9 10:26=1.2 10:31=1.7 10:46=1.2 10:51=1.3 11:01=1.4
     11:41=2.0 12:11=1.6 12:21=1.3 12:46=1.7
Thu: 09:16=1.9H 09:21=1.1H 09:31=1.4H 09:41=2.0H 09:46=1.2H 09:51=1.9H 09:56=1.5H
     10:01=1.3H 10:06=1.3H 10:11=2.0H 11:01=2.0H 11:06=1.3H 11:11=1.2H 11:16=1.2H
     11:31=1.1H 12:06=1.8H 12:11=2.0H 12:21=2.0H 12:26=1.7H 12:51=1.7H
Fri: 09:21=1.7 09:26=1.7 09:31=1.1 09:36=1.1 09:46=1.1 09:51=1.1 10:06=1.1 10:11=1.2
     10:41=1.1 11:06=1.6 11:16=1.5 11:21=1.1 11:26=1.9 11:31=1.4 11:46=1.2 12:06=1.2
     12:11=1.9 12:21=1.7 12:36=1.6 13:01=1.6
```

**p718-5 — 4 slots/weekday:**

```
Mon: 09:16=1.2 10:06=1.4 11:01=1.2 12:11=1.5
Tue: 09:16=1.7 10:11=1.2 11:01=1.4 12:01=1.2
Wed: 09:16=1.2 10:01=1.2 11:01=1.4 12:11=1.6
Thu: 09:16=1.9H 10:01=1.3H 11:01=2.0H 12:06=1.8H
Fri: 09:21=1.7 11:06=1.6 12:06=1.2 13:01=1.6
```

There is no market condition, no filter, no state check: every slot fires unconditionally
(subject only to `ticksCache[260105]` being populated).

### Entry — p718-4

```
takeTrade(SL_percent, hedge=false):
  spot = ticksCache[260105].last_price ; if missing -> do nothing (slot is lost)
  atm  = round(spot/100)*100
  CE   = options[atm+'CE'] ; PE = options[atm+'PE']

  if hedge:                                             # Thursday only
      place_pair_order(atm, CE, PE, SL_percent, qty=2)
      hedgeCE = options[(ceil(atm/500)*500  + 1000) + 'CE']
      hedgePE = options[(floor(atm/500)*500 - 1000) + 'PE']
      PaperTrade.trackOrder(hedgeCE, 'BUY', tag, 2)      # naked long wings, no SL tracking
      PaperTrade.trackOrder(hedgePE, 'BUY', tag, 2)
  else:
      place_pair_order(atm, CE, PE, SL_percent, qty=1)

place_pair_order(atm, CE, PE, SL_percent, qty):
  for leg in [CE, PE]:
      id = eventId++                                    # process-local monotonic int
      eventTrigger[id] = { atm, strike: leg.strike, type, instrument_token,
                           sl_trigger: SL_percent, sl_hit: false, action: 'place_sl' }
      PaperTrade.trackOrder_v2(leg, 'SELL', tag, qty, [id])   # dataObj = [id]
```

### Exit — p718-4 (broker-echo SLM state machine)

`trackOrder_v2` writes a `paper-trade` doc with `dataObj:[id]`. `server/tools/xtsOrder.js`
watches the `paper-trade` change stream and, if the tag is mapped to an XTS/Jainam account,
places the real order with `OrderUniqueIdentifier = "<tag>|<id>"`.
`server/tools/smp_order_listener.js` receives the XTS interactive-WS order event and inserts an
`OrderUpdate` doc `{updateType:'order', strategy:tag, params:[<id as string>], status, price}`.
p718-4 watches the `OrderUpdate` change stream:

```
on insert where updateType=='order' and strategy==tag and params.length>0:
  key = params[0]
  if eventTrigger[key].action == 'place_sl' and status == 'Filled':
      stopPrice = round( parseFloat(update.price) * sl_trigger , 1 )
      newId = eventId++
      eventTrigger[newId] = { ...same strike/type..., instrument_token, action:'remove_position' }
      qty = (moment().day() == 3) ? 2 : 1                        # (!! see risks)
      PaperTrade.trackOrder_slm(slInstrument, 'BUY', tag, qty, stopPrice, [newId])
      eventTrigger[key] = false                                  # one-shot guard
  else if eventTrigger[key].action == 'remove_position':
      executeSL(key, instrument_token, update.price)
      eventTrigger[key] = false

executeSL(orderId, token, price):
  trade = PaperTrade.findOne({ tag, dataObj:[parseInt(orderId)], instrument_token: token })
  if trade: trade.status='COMPLETE'; trade.order_type='MARKET';
            trade.order_timestamp=now; trade.average_price=parseFloat(price); save()
```

So the stop is `entry_fill * SL_percent` (1.1x–2.0x of the sold premium), placed as a
`StopMarket` bus order which `xtsOrder.js:306-309` converts to a StopLimit +-1%; when it
triggers, the pending bus doc is flipped to `COMPLETE` with the real trigger price so the bus's
position accounting nets to flat.

**Second exit path — 14:58 central squareoff + self-termination:**

```
cron '0 58 14 * * 1-5':
  PaperTrade.squareoff(tag)                       # nets today's COMPLETE orders per symbol,
                                                  # emits offsetting MARKET bus orders
  XtsAccount.removePending('6180b8bf540ac40f3b38b863', tag)   # cancel live pending SLMs
  setTimeout(15000, () => Manager.stop('p718-4')) # pm2 stop -- kills its OWN process
```

### Entry / exit — p718-5 (single leg by max-pain)

```
runStrategy is NOT called at require time; cron '0 15 9 * * 1-5' calls it (fresh each day).

takeTrade(SL_percent, hedge ignored):
  spot = ticksCache[260105].last_price
  atm  = round(spot/100)*100
  optionData = await optionConfig.download()          # FRESH Sensibull fetch, per trade
  max_pain   = optionData.max_pain                    # NOTE: monthly-expiry max pain
  sell = (max_pain < spot) ? 'PE' : 'CE'
  place_single_order(atm, sell, options[atm+sell], SL_percent)

place_single_order:
  id = eventId++
  eventTrigger[id] = { atm, strike, type, instrument_token, sl_trigger: SL_percent, action:'place_sl' }
  PaperTrade.trackOrder(opt, 'SELL', tag)             # trackOrder_v2 line commented out ->
                                                      # NO dataObj -> the OrderUpdate/SLM
                                                      # state machine can never fire
  optionOrders.push(eventTrigger[id])

checkSL()  # every tick batch
  for each optionOrders[idx]:
      if ticksCache[token].last_price > sl_trigger:    # (!!) compares premium to 1.2..2.0
          delete optionOrders[idx]
          PaperTrade.trackOrder(options[strike+type], 'BUY', tag)

cron '0 58 14 * * 1-5': PaperTrade.squareoff(tag)      # XtsAccount/Manager.stop commented out
```

### Config axes (idea B)

| axis | p718-4 | p718-5 |
|---|---|---|
| `strategyTag` | `P718-4` | `P718-5` |
| legs per entry | ATM straddle (CE+PE) | single ATM leg |
| leg selection | both | `max_pain < spot ? 'PE' : 'CE'` (monthly max-pain) |
| slots/weekday | 20 | 4 |
| SL mechanism | broker-echo SLM at `fill * SL%` | per-tick premium poll (broken) |
| qty | 1 (Mon–Wed, Fri), 2 (Thu) | 1 (`trackOrder` default multiplier) |
| Thursday wings | +-1000 pts from 500-rounded ATM, BUY 2 | none |
| bootstrap | `runStrategy()` at require | cron 09:15:00 daily |
| 14:58 action | squareoff + removePending + `Manager.stop` | squareoff only |
| order helper | `trackOrder_v2` / `trackOrder_slm` | `trackOrder` |

---

## Idea C — `RatioSpreadLadder`

Files: `ce-d2-0020.js`, `ce-d2-extra.js`, `pe-d2-0020.js`, `pe-d2-extra.js` (all 190 L),
`ce-d2p-extra.js` (216 L), `pe-d2p-extra.js` (217 L). The only order-book-depth strategy and
the only real multi-leg spread scanner in `slive/`.

### Bootstrap

```
runStrategy():
  optionData = optionConfig()
  currentExpiryOptions = optionData.weeklyInstruments
  if (moment().day() == 3) currentExpiryOptions = optionData.nextWeekInstruments   # d2 only;
                                                                # COMMENTED OUT in d2p
  subscribe modeFull to [260105, ...all weekly option tokens]

  day_config = otmSelector('SD_2')          # lib/otmSelector.js:34
  #   every weekday branch returns the SAME array: [5, 3, 4, 18, -5, -10]
  #   day 4 (Thursday) branch is MISSING -> returns undefined  (see risks)
  # d2 :   current_spread = day_config[5]                        # -10
  # d2p:   strategyConf = StrategyData.findById(strategyId)
  #        optionOrders  = strategyConf.orders   || []
  #        pending_qty   = strategyConf.pending_qty (if number)
  #        current_spread= strategyConf.current_spread || day_config[5]
```

`day_config` semantics (index -> meaning, all values constant in practice):

| idx | value | meaning |
|---|---|---|
| 0 | 5 | first near-leg offset, in strike steps from ATM |
| 1 | 3 | how many near-leg offsets (`i` in `[5,6,7]`) |
| 2 | 4 | minimum gap: far leg starts at `i + 4` |
| 3 | 18 | far-leg exclusive upper bound (`j < 18`) |
| 4 | -5 | **upper** bound on `spread_diff` at entry; *mutated to `0` after the first fill* |
| 5 | -10 | **lower** bound on `spread_diff`, and the initial `current_spread` seed |

### Ladder construction (rebuilt only when ATM moves)

```
placeTrade():                                    # queued once per tick batch, concurrency 1
  currentATM = round(ticksCache[260105].last_price / 100) * 100
  if currentATM != lastATM:
      lastATM = currentATM
      spreadAvailable = { CE: [], PE: [] }
      for i in [day_config[0] .. day_config[0]+day_config[1]-1]:      # 5,6,7
          for j in [i+day_config[2] .. day_config[3]-1]:              # i+4 .. 17
              if i == j: continue                                     # never true
              spreadAvailable.CE.push([ATM + i*100, ATM + j*100])
              spreadAvailable.PE.push([ATM - i*100, ATM - j*100])
      # 24 pairs per side: i=5 -> j 9..17 (9), i=6 -> 10..17 (8), i=7 -> 11..17 (7)
      # NOTE: current_spread is deliberately NOT reset when the ATM moves.
```

### Scan + entry

```
  filtered = []
  for each [near, far] in spreadAvailable[option_type]:               # option_type 'CE' | 'PE'
      debit_leg  = ask(near + option_type)                            # depth.sell[0].price
      credit_leg = bid(far  + option_type) * ratio                    # depth.buy[0].price * 2
      spread_diff = credit_leg - debit_leg                            # NEGATIVE = net debit
      gap      = |near - far| ; distance = |near - currentATM|
      if spread_diff < day_config[4] and spread_diff > day_config[5]
                                     and spread_diff > current_spread:
          filtered.push([nearSym, farSym, ratio, debit_leg, bid(far), spread_diff, distance, gap])

  filtered.sort((a,b) => (b[6]+b[7]) - (a[6]+b[7])).reverse()         # (!! see risks)

  if filtered.length > 0 and pending_qty > 0 and pending_qty >= per_trade_qty:
      pick = filtered[0]
      pending_qty -= per_trade_qty
      TRACK(options[pick.nearSym], 'BUY',  tag, per_trade_qty)          # long 1x near
      TRACK(options[pick.farSym],  'SELL', tag, per_trade_qty * ratio)  # short 2x far
      current_spread = (current_spread === day_config[5])
                       ? pick.spread_diff + per_trade_jump
                       : current_spread + per_trade_jump                # escalate 0.25
      day_config[4] = 0                                                 # loosen upper bound
      optionOrders.push({ strike_1: nearSym, strike_2: farSym,
                          entry: pick.spread_diff,
                          target: pick.spread_diff - profit })
      # d2p only: d_saveStrategyData()   (debounced 3 s)
```

`TRACK` is `PaperTrade.trackOrder` in the `-d2-` files and `Positional.trackOrder` in the
`-d2p-` files. **Both collections (`paper-trade` and `positional`) are watched by
`server/tools/xtsOrder.js`, `am_xtsOrder*.js` and `sparkOrder.js`, so `positional` is a real
live rail too, not a paper one** — the difference is that `positional` rows are not
day-filtered by `Positional.positions()`, i.e. it is the overnight/carry book.

With `day_config = [5,3,4,18,-5,-10]` the position is: **buy 1 unit of the strike 500–700 pts
OTM, sell 2 units of a strike 900–1700 pts OTM, for a net debit of 5–10 points.** That is a 1x2
ratio *front* spread with unbounded tail risk beyond the short strikes.

### Exit — take-profit only (function is misleadingly named `checkSL`)

```
checkSL():                                       # queued once per tick batch, concurrency 1
  for each spread in optionOrders:
      # d2p only: if (!spread) continue          # holes come back as nulls after a DB reload
      exit_diff = ask(spread.strike_2) * ratio - bid(spread.strike_1)
      if exit_diff < spread.target:              # target = entry_diff - profit
          delete optionOrders[idx]               # leaves a hole in the array
          # d2p only: d_saveStrategyData()
          TRACK(options[spread.strike_2], 'BUY',  tag, per_trade_qty * ratio)   # close shorts
          TRACK(options[spread.strike_1], 'SELL', tag, per_trade_qty)           # close long
          pending_qty += per_trade_qty
```

Algebra: with `V = near - 2*far` (position value), entry cost is `-entry_diff` and exit proceeds
are `-exit_diff`, so `PnL = entry_diff - exit_diff`. The condition `exit_diff < entry_diff -
profit` is exactly `PnL > profit`. **It is a `profit`-point take-profit measured on adverse
quotes (sell the long at bid, buy the shorts at ask). There is no stop loss, no time stop, and
no EOD squareoff anywhere in these six files.**

### Persistence (`-d2p-` only)

```
saveStrategyData():                              # debounced 3000 ms, trailing
  StrategyData.replaceById(strategyId, { title: tag, orders: optionOrders,
                                         pending_qty, current_spread })
```

`strategyId`: `610c1fc18acb4b2cb15268c0` (CE), `610c1fbf8acb4b2cb15268bf` (PE).
On boot the record is read back, so a pm2 restart **resumes** the ladder (open spreads,
remaining budget, escalated threshold) instead of double-entering.

### Config axes (idea C)

| file | tag | `option_type` | `pending_qty` | `per_trade_qty` | `ratio` | `profit` | `per_trade_jump` | order model | Wed roll to next week | state persisted |
|---|---|---|---|---|---|---|---|---|---|---|
| `ce-d2-0020.js` | `CE_D2_0020` | CE | 20 | 2 | 2 | 15 | 0.25 | `PaperTrade` | yes | no |
| `ce-d2-extra.js` | `CE_D2_E` | CE | 50 | 2 | 2 | 15 | 0.25 | `PaperTrade` | yes | no |
| `ce-d2p-extra.js` | `CE_D2P_E` | CE | 20 | 2 | 2 | 25 | 0.25 | `Positional` | **no** (commented) | yes, `610c1fc18acb4b2cb15268c0` |
| `pe-d2-0020.js` | `PE_D2_0020` | PE | 20 | 2 | 2 | 15 | 0.25 | `PaperTrade` | yes | no |
| `pe-d2-extra.js` | `PE_D2_E` | PE | 50 | 2 | 2 | 15 | 0.25 | `PaperTrade` | yes | no |
| `pe-d2p-extra.js` | `PE_D2P_E` | PE | 20 | 2 | 2 | 25 | 0.25 | `Positional` | **no** (commented) | yes, `610c1fbf8acb4b2cb15268bf` |

`ce-d2-0020` -> `pe-d2-0020` diff is literally 2 lines (`strategyTag`, `option_type`).
`ce-d2-0020` -> `ce-d2-extra` diff is 2 lines (`strategyTag`, `pending_qty`).

---

## Consolidated config axes for the target system

```ts
// idea A
type SyntheticSupertrendStrangleConfig = {
  tag: string;
  underlying: { spotToken: number; strikeStep: number };   // 260105 / 100
  farAtm: number;                    // 100 | 200 | 300
  candle: '3minute'; historyDays: 30;
  supertrend: { period: 14; mul: 5 };
  evalCron: '0 */3 * * * 1-5';
  perTradeStopPoints: number | null; // null (p718-1) | 30
  maxDailyLossPoints: number | null; // null (p718-1) | 80
  stopIsOneShot: true;               // MUST preserve: SL disarms itself after firing
  killAt: '14:59:30'; flattenAtKill: false;
  lots: 1; rail: 'bus';              // running_accounts never loaded
};

// idea B
type ScheduledAtmSellConfig = {
  tag: string;
  underlying: { spotToken: 260105; strikeStep: 100 };
  legs: 'straddle' | 'maxpain-single';
  schedule: Record<1|2|3|4|5, Array<{ at: 'HH:mm:58'; slMultiple: number; hedged: boolean }>>;
  qtyByWeekday: Record<number, number>;            // p718-4: {4:2, default 1}
  wings?: { offset: 1000; roundTo: 500; qty: 2 };  // Thursday only
  stop: { kind: 'slm-on-fill'; multipleOfFill: number }  // p718-4
      | { kind: 'premium-poll'; level: number };         // p718-5 (broken as written)
  bootstrap: 'require' | 'cron 09:15';
  eod: { at: '14:58'; squareoff: true; cancelPendingXts: boolean; selfStopPm2: boolean };
};

// idea C
type RatioSpreadLadderConfig = {
  tag: string; side: 'CE' | 'PE';
  underlying: { spotToken: 260105; strikeStep: 100 };
  ladder: { nearFrom: 5; nearCount: 3; minGap: 4; farMax: 18 };   // otmSelector('SD_2')
  entryBand: { max: -5; min: -10 };      // on spread_diff; max relaxes to 0 after 1st fill
  ratio: 2; perTradeQty: 2; budgetQty: 20 | 50;
  profitPoints: 15 | 25; jump: 0.25;
  book: 'paper-trade' | 'positional';
  rollToNextWeekOnWednesday: boolean;
  persistState?: { strategyDataId: string; debounceMs: 3000 };
};
```

---

## MUST-PRESERVE behaviours

1. **Synthetic-bar Supertrend definition (A).** `high = low = close = closeCE + closePE`. ATR
   therefore degenerates to mean absolute change; bands are `close ± 5*ATR14`. Re-deriving with
   real OHLC changes every signal.
2. **Strike lock while in a trade (A).** Once `currentDirection` is true, the indicator is
   recomputed on the *held* CE/PE tokens, not on a fresh ATM±farAtm pair.
3. **`checkSLPrice` one-shot disarm (A, p718-2/3).** After the first price stop fires, the
   price stop never re-arms for the rest of the day; only the cumulative `max_stoploss` breaker
   remains. This is load-bearing behaviour, not obviously a bug — replicate behind an explicit
   `stopIsOneShot` flag.
4. **14:59:30 does not flatten (A).** Only the signal loop is disabled. If you "fix" this you
   change realised P&L.
5. **`eventTrigger[key] = false` one-shot guard (B, p718-4).** Prevents a duplicate SLM if the
   broker echoes the same fill twice. The `place_sl` -> `remove_position` handoff allocates a
   *new* `eventId` so the two phases can never be confused.
6. **`executeSL` closes the bus leg by `{tag, dataObj:[parseInt(id)], instrument_token}`** and
   sets `status='COMPLETE'`, `order_type='MARKET'`, `average_price = broker trigger price`,
   *in that order*, so `PaperTrade.positions()` (which counts only `status=='COMPLETE'`) nets to
   flat with the true fill. Field ordering/status flip semantics must survive.
7. **`Papertrade.positions()` only counts `status == 'COMPLETE'` and only today's
   `order_timestamp`.** Pending SLM rows are correctly excluded from squareoff netting; the
   14:58 `squareoff` therefore emits offsetting MARKET orders for the *net* open quantity and
   relies on `XtsAccount.removePending` to cancel the still-live stops. Both calls are required;
   dropping either leaves a naked stop or a double exit.
8. **`Manager.stop('p718-4')` self-termination (B).** p718-4 kills its own pm2 process 15 s
   after squareoff. Consequence: it *must* be restarted every morning, and it registers only
   the current weekday's crons at boot. Any runner replacement needs an equivalent
   start-of-day (re)initialisation contract.
9. **Ladder rebuild is ATM-gated, threshold is not (C).** `spreadAvailable` is regenerated only
   when `round(spot/100)*100` changes; `current_spread`, `pending_qty`, `optionOrders` and the
   mutated `day_config[4]` survive ATM moves. The escalating threshold is the risk control.
10. **`day_config[4] = -5 -> 0` after the first fill (C).** Permanent, process-lifetime mutation
    that widens the acceptable entry band for every subsequent rung.
11. **Depth-based pricing (C).** Entry uses `ask(near)` and `bid(far)`; exit uses `bid(near)` and
    `ask(far)`. Always the adverse side. Requires `modeFull` subscription — LTP is not a
    substitute and the strategy silently mis-prices without `depth`.
12. **`async.queue(..., 1)` serialisation (C).** `placeTrade` and `checkSL` each run
    single-flight, which is the only thing preventing double entries from a tick burst.
13. **Restart resume (C, `-d2p-`).** State (`orders`, `pending_qty`, `current_spread`) is
    debounced-persisted and reloaded on boot. Also: `delete optionOrders[idx]` leaves array
    holes; `forEach` skips holes in memory but a Mongo round-trip turns them into `null`, which
    `forEach` *does* visit — hence the `if (spreadElm)` guard that exists only in the `-d2p-`
    files. Any rewrite must keep entries positionally stable or the guard equivalent.
14. **`optionConfig()` is a cached-file read.** Instruments come from
    `optionConfig_BANKNIFTY.json` in the repo root; only p718-5 forces a fresh
    `optionConfig.download()`. Expiry rollover depends on that file being refreshed externally.
15. **Wednesday next-week roll (C, `-d2-` only).** `if (moment().day() == 3) use
    nextWeekInstruments` — the `-d2p-` variants deliberately have this commented out.
16. **Tick-availability precondition everywhere.** All three ideas no-op (A: 10 spin attempts;
    B: silently drops the slot; C: throws) when `ticksCache[260105]` is absent. A time-slot
    missed because the feed was late is simply lost — never retried.

---

## Bugs / dead code / dangerous behaviour

### Fatal

1. **`otmSelector('SD_2')` returns `undefined` on Thursdays** (`lib/otmSelector.js:34-45`: the
   `day() == 3` branch is duplicated and `day() == 4` is missing; days 0 and 6 also fall
   through). All six idea-C files then execute `day_config[5]` (`ce-d2-0020.js:64-65`) and die
   with `TypeError: Cannot read properties of undefined`. **The entire ratio-spread family is
   dead every Thursday.** All five weekday branches return the identical
   `[5, 3, 4, 18, -5, -10]`, so the whole per-weekday indirection is pointless — inline the
   constant and delete the lookup.
2. **`optionOrders` is never declared in `p718-5.js`** (used at :214 and :218). `checkSL()` runs
   from `checkTicks` on every tick batch, so on the first tick after 09:15 it throws
   `ReferenceError: optionOrders is not defined` inside an un-awaited async function ->
   unhandled rejection -> fatal on Node >= 22 (`package.json` requires `>=22`). p718-5 cannot
   run. Treat it as decommissioned; do not port without a rewrite.
3. **p718-5 compares a premium to a multiplier.** `checkSL` tests
   `ticksCache[token].last_price > check_option.sl_trigger` where `sl_trigger` is `1.2 … 2.0`.
   Any option priced above ~2 would exit on the very next tick. Also `place_single_order` uses
   `trackOrder` (no `dataObj`), so the `OrderUpdate`/SLM machinery it inherits from p718-4 can
   never fire — there is effectively no working stop at all.

### Money-losing

4. **p718-4 SLM quantity does not match the entry quantity.** Entries are qty 2 on **Thursday**
   (`hedge=true` -> `place_pair_order(..., 2)`) and qty 1 otherwise, but the stop leg uses
   `moment().day() == 3 ? 2 : 1`. Result: on Thursday the 2-lot straddle is protected by a
   1-lot stop (half the position runs naked); on Wednesday a 1-lot straddle gets a 2-lot stop,
   so triggering it flips the book **net long 1 lot** of a decaying option. The `day()==3` test
   is almost certainly a stale copy from when Wednesday was expiry.
5. **Selection is inverted in idea C.**
   `filtered.sort((a,b) => (b[6]+b[7]) - (a[6]+b[7]))` uses `b[7]` on both sides, so it reduces
   to `b[6] - a[6]` (descending by distance-from-ATM, `gap` ignored); the following `.reverse()`
   then makes it **ascending**, so `filtered[0]` is the pair *closest* to ATM — the highest-risk
   rung — when the evident intent was the farthest. Fix the comparator and drop the `.reverse()`
   together, and re-tune, because current live P&L reflects the buggy selection.
6. **Idea C has no stop loss, no time stop and no EOD squareoff.** A 1x2 ratio front spread has
   unbounded loss beyond the short strikes; the only exit is a `profit`-point take-profit that a
   trending market will never reach. The `-d2p-` variants book into `positional`, i.e. they carry
   overnight by design. Adding a stop is a behaviour change, but flag it loudly.
7. **Idea A p718-1 has no stop of any kind**, and none of p718-1/2/3 flatten at the 14:59:30
   kill. An open strangle survives the session and, since the instruments are weekly, can be
   carried into expiry.
8. **`entry_price = parseInt(LTP_PE + LTP_CE)`** (A, p718-2/3) truncates the combined premium to
   an integer before `stoploss_price = entry_price + 30`, biasing the stop up to 1 point tight.

### Correctness / robustness

9. **Synthetic bars are never timestamp-aligned (A).** The two candle arrays are walked
   backwards from their own ends and `ts1`/`ts2` are stored but never compared. Any hole or
   length difference in the CE vs PE history silently pairs bars from different minutes.
10. **`async.queue` worker has no error path (C).** `placeTrade().then(cb)` with no `.catch`.
    `_TP`, `_SP_bid`, `_SP_ask` all dereference `ticksCache[token].depth...` unguarded, so a
    single missing tick or missing strike key throws, the promise rejects, `callback()` is never
    called, and the concurrency-1 queue **stalls permanently** — the strategy goes silent
    without crashing or alerting. On Node >= 22 the unhandled rejection may instead kill the
    process. Guard every quote read.
11. **Unbounded queue growth (C).** Both queues get a task pushed per tick batch with no dedupe
    or drop-on-backlog. If `placeTrade` (24-pair scan) is slower than the tick rate the backlog
    grows without limit and acts on stale ATMs.
12. **Every 3-minute cycle fires two 30-day `historyData` calls (A)** = 40 Kite history calls per
    hour per process, times three processes. On error the handler does `await zapi.login()`
    (re-login on any exception, including a parse error) and the `do/while` exits anyway because
    `bn_quote` is an object.
13. **Trailing 3 s debounce loses state on kill (C, `-d2p-`).** A fill followed by a pm2 restart
    inside 3 s loses the `optionOrders` entry and the `pending_qty`/`current_spread` change ->
    duplicate entry and an orphaned live spread. Persist synchronously on fill.
14. **`Papertrade.squareoff` throws when the tag has no orders today** —
    `Object.values(data.positions[strategy])` on `undefined`. It happens inside the model's async
    IIFE, so the caller's `try/catch` in p718-4/5 does not catch it.
15. **p718-5 re-registers weekday crons every day at 09:15 without cancelling the previous
    set.** If the process survives a week, the second Monday has two Monday cron sets -> double
    entries; the third Monday, three. (Moot while bug 2 crashes it, but the pattern is copied
    from p718-4 and must not be reproduced.)
16. **p718-4 registers only the current weekday's crons at boot** and then `Manager.stop`s
    itself at 14:58. If it is not restarted before the next 09:16 it trades nothing that day —
    silent, invisible failure.
17. **p718-4 Thursday wings are naked longs with no bookkeeping.** `trackOrder(hedge, 'BUY',
    tag, 2)` has no `dataObj`, no SL, no target; they are only closed by the 14:58 squareoff.
    Also `ceil(atm/500)*500` on an ATM that is already a multiple of 100 makes the CE wing
    0–400 pts nearer than the PE wing, so the "hedge" is asymmetric.
18. **Implicit globals.** `for (i = ...)`/`for (j = ...)` in idea C and `optionData`/`max_pain`
    in p718-5 leak onto `global`. All would `ReferenceError` under `'use strict'` / ESM — a real
    hazard for the TypeScript port.

### Dead code to drop

19. `_SP` (mid-price helper) is defined and never used in all six idea-C files.
20. `ratiosAvailable = [ratio]` — a one-element array wrapped in a nested `async.each`; the
    multi-ratio generality was never used.
21. `spreadAvailable.PE` is built even in the CE files (and vice versa) and never read.
22. `if (i == j) continue` can never be true (`j >= i + 4`).
23. Idea A: `getAccounts` (defined, never called), `maxTrades = 3`, `target_price`, `channelId`,
    and the imports `notify`, `PaperTrade`, `StrategyPNL` are all unused; two blocks of
    commented-out `strategyTag2` mirror orders in every entry/exit branch.
24. Idea B: `XtsAccount`/`Manager` imported in p718-5 with both call sites commented out;
    `sl_hit: false` is written into `eventTrigger` and never read; `hedge` is accepted by
    p718-5's `takeTrade` and ignored.
25. `p718-3.js` is a pure 2-line config clone of `p718-2.js`; `pe-d2-*.js` are pure 2-line
    clones of `ce-d2-*.js`; `*-extra.js` differ from `*-0020.js` by one number. 9 of the 11
    files add zero algorithmic content.
