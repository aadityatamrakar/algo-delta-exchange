# Family Spec: `lion` / `biglion` / `samlion` / `jk`

**Scope:** 38 files in `server/slive/` — `lion-*.js` (30), `biglion-0020.js` (1),
`samlion-{9,10,11,12}.js` (4), `jk-{0020,m6000,zzJ4351}.js` (3).
**Verified:** 2026-07-25, against working tree at `bdbc9099`.
**Distinct algorithms:** 3. **Everything else is a config record.**

Related-but-out-of-scope: `server/smp/` holds 28 staging siblings
(`lion-b-3..6`, `lion-down`, `lion-s-40`, `lion-sh-25`, `lion-sl-25`, `lion-sl-8`,
`lion-sp-3`, `lion-es-25`, `lionN-s-25`, `jk-s-25`, `samlion-9..12`, …). They add **no new
mechanism**, only new values on the axes below (`sl_percent` 1.03/1.4, lot `multiplier` 10,
`farOtm = otmSelector()/2`, and the mirror-image directional rule `atm < ohlc.close`). A
correct implementation of this spec regenerates them too.

---

## 0. The one-paragraph summary

Every file in this family does the same thing: subscribe to a Kite tick feed for one index
plus its entire weekly option chain; round the index LTP to the nearest strike step; and on
**every crossing of that rounded strike** sell (rarely buy) one CE + one PE at a symmetric
offset from it. Each open leg carries a premium-based stop; when a leg closes, that strike
becomes eligible for a fresh pair. There is no cron, no clock, no time-of-day logic, no
target (except in three files where the "stop" comparison is inverted and is therefore a
target), and **no end-of-day square-off anywhere**. The files differ in: which index, the
strike step, the offset, the stop formula, whether the exit is a resting broker stop or a
process-side tick monitor, whether a leg re-enters independently of its twin, how many pairs
are stacked, and which side is taken.

---

## 1. Shared skeleton (identical in all 38 files, byte-for-byte in most)

```
require: cron(UNUSED), notify(unused except one catch), server.js(app), lib/zerodha,
         lib/KiteTicker, models.account, models.PaperTrade(12 files only),
         tools/optionInstruments, async, lib/otmSelector, moment

runStrategy():                                   # called unconditionally at module load
  optionData        = await optionConfig(UNDERLYING)     # cached JSON or Sensibull API
  futureToken       = <SPOT INDEX TOKEN>                 # misnamed; see §6.1
  currentExpiryOptions = optionData.weeklyInstruments    # keyed "<strike><CE|PE>"
  optionTokens      = every token in that chain
  farOtm            = otmSelector(<tag?>)                # ALWAYS 0 — see §6.2
  # await getAccounts()   <-- COMMENTED OUT IN ALL 38 FILES. See §6.3
  base_acc = await Account.findById(app.get('masterId'))
  zapi = await zerodha_init(base_acc)   # logs in ONLY to mint a KiteTicker access_token
  ticker([futureToken, ...optionTokens])          # own private websocket, modeFull

  setTimeout(D1):                                # D1 = 5000 or 10000 ms
    lastQuote = ticksCache[futureToken].last_price
    setTimeout(D2):                              # D2 = 5000 ms
      startTrade = true
      placeTrade(forceTrade = true)              # FORCED first entry, no crossover needed

checkTicks(ticks):                               # every websocket batch
  Object.assign(ticksCache, byToken(ticks))      # last-writer-wins tick cache
  if (startTrade) takePositionQ.push({check:1})
  checkSLQ.push({check:1})                       # absent in the change-stream engine

takePositionQ = async.queue(t => placeTrade().then(cb), 1)
checkSLQ      = async.queue(t => checkSL().then(cb),  1)     # NOTE: no .catch — see §7.1
```

### 1.1 The crossover trigger (identical everywhere except `samlion`)

```
placeTrade(forceTrade=false):
  q     = ticksCache[futureToken]
  strike = round(q.last_price / STEP) * STEP
  cross  = forceTrade
        or (q.last_price >= strike and lastQuote <= strike)     # up-cross
        or (q.last_price <= strike and lastQuote >= strike)     # down-cross
  lastQuote = q.last_price                       # updated on EVERY tick, cross or not
  if (!cross) return
  ...
```

`strike` is recomputed from the *current* tick, so the boundary being tested is always the
strike nearest to right now, and the pair of inequalities detects a sign change of
`price - strike` across two consecutive ticks. A tick exactly *at* the strike satisfies both
branches. Note the asymmetry to preserve: the comparison uses the **new** strike against the
**previous** tick's price, so a tick that jumps a whole bucket (e.g. 45,240 → 45,310, new
strike 45,300) also registers as a cross. Net effect: the trigger fires on every touch or
crossing of a round strike, which on BANKNIFTY is many times per day.

### 1.2 The re-entry guard (`positionsOpen`)

`positionsOpen` is an *array used as a map*, keyed `"S" + strike`, value `{CE:n, PE:n}`.

```
takePosition = false
if (positionsOpen["S"+strike]) {
    if (positionsOpen["S"+strike].CE == 0) takePosition = true
    if (positionsOpen["S"+strike].PE == 0) takePosition = true
} else takePosition = true
```

Two dialects:

* **paired** (`lion-*`, `biglion`, `samlion`): if *either* side reads 0 the whole pair is
  re-sold. Counters for the still-open side therefore go 1 → 2 → 3 …, and that side can
  never fall back to 0 while a new leg keeps being added. Practical outcome: after the first
  one-sided stop-out, the strike accumulates unlimited legs on the surviving side.
* **per-leg** (`jk-*` only): `add_CE` / `add_PE` flags gate each leg independently, so only
  the leg that actually closed is re-sold. This is the strictly-better dialect and the one a
  rewrite should default to.

`ATM_Strike.push("S"+strike)` on every entry is **dead** — the array is never read.

---

## 2. Algorithm 1 — `atm-crossover-strangle-resting-stop`

**12 files.** Exit is a *real resting stop order at the broker*, armed by a broker fill
confirmation. Nothing about the exit depends on this process staying alive or on ticks.
This is the only sub-engine that touches the `OrderUpdate` collection.

### 2.1 Rails

| step | call | lands where |
|---|---|---|
| entry | `PaperTrade.trackOrder_v2(opt,'SELL',tag,1,[eventId])` | `paper-trade` insert, `status:COMPLETE`, `order_type:MARKET`, `dataObj:[eventId]` |
| → consumed by | `server/tools/xtsOrder.js` (real XTS/Jainam), `sparkOrder.js` (real Spark), `fyersOrder.js` (real Fyers), `boot/paperstream.js` (price stamper) | gated by `runningStrategies[tag] > 0`, i.e. at least one broker account has this tag in `account.strategy` |
| fill echo | XTS interactive WS → `smp_order_listener.js` / `smp_target.js` insert into `OrderUpdate` with `{updateType:'order', strategy:tag, params: OrderUniqueIdentifier.split('|').slice(1), status:'Filled'|'Rejected', price:OrderAverageTradedPrice}` | `orderUniqueIdentifier = [tag, ...dataObj].join('|')` (`xtsOrder.js:147`) |
| stop | `PaperTrade.trackOrder_slm(opt,'BUY',tag,1,stopPrice,[newEventId])` | `paper-trade` insert, `order_type:StopMarket`, `status:Pending` → xtsOrder converts to **StopLimit**: `stopPrice=parseInt(stop)`, limit `= stop*1.01` if `stop>1000` else `stop*1.05` (BUY side) |
| stop fill echo | same `OrderUpdate` path, `params[0] = newEventId` | closes the local book |

### 2.2 State machine

```
eventTrigger : Map<int, {atm, strike, type, instrument_token, sl_trigger?, action}>
eventIdx     : monotonic counter, process-local, starts at 0 EVERY restart

on crossover & takePosition:
  for side in [CE, PE]:                      # PE second, always
     opt  = chain[(strike ± farOtm) + side]
     ltp  = ticksCache[opt.instrument_token].last_price
     id   = eventId()
     eventTrigger[id] = {atm:strike, strike:opt.strike, type:side,
                         instrument_token:opt.instrument_token,
                         sl_trigger: ltp*SL_PCT,          # recorded, NEVER READ
                         action:'place_sl'}
     PaperTrade.trackOrder_v2(opt,'SELL',tag,1,[id])
  positionsOpen["S"+strike].{CE,PE} += LAYERS              # LAYERS = 1, or 4 for biglion

changeStream(OrderUpdate).on insert:
  if (doc.updateType=='order' && doc.strategy==tag && doc.params.length>0):
     e = eventTrigger[doc.params[0]]                       # string key, coerces fine
     if e && e.action=='place_sl':
        if (doc.status == 'Filled'):                       # exact case, not uppercased
           stop = parseFloat((parseFloat(doc.price) * SL_PCT).toFixed(1))
           nid  = eventId()
           eventTrigger[nid] = {atm:e.atm, strike:e.strike, type:e.type,
                                instrument_token: chain[e.strike+e.type].instrument_token,
                                action:'remove_position'}
           PaperTrade.trackOrder_slm(chain[e.strike+e.type],'BUY',tag,1,stop,[nid])
           eventTrigger[doc.params[0]] = false             # one-shot: dedups the N-account fan-out
        # NO else — a Rejected entry leaves action='place_sl' armed forever (§7.4)
     else if e && e.action=='remove_position':
        positionsOpen["S"+e.atm][e.type] -= 1
        executeSL(doc.params[0], e.instrument_token, doc.price)
        eventTrigger[doc.params[0]] = false
        # NO status check — a Rejected stop is booked as an exit (§7.3)

executeSL(orderId, token, price):                          # closes the local book only
  t = PaperTrade.findOne({tag, dataObj:[parseInt(orderId)], instrument_token:token})
  t.status='COMPLETE'; t.order_type='MARKET'
  t.order_timestamp=now(); t.average_price=parseFloat(price); t.save()
```

`executeSL` mutates the resting-SLM document in place, turning it into the completed exit
record. Because every bus consumer subscribes only to `operationType == 'insert'`, this
update is invisible to the brokers — correct here (the broker really did fill it), but the
same primitive is abused destructively in Algorithm 2 (§7.5).

### 2.3 Members

| file | tag | index / token | STEP | offset | SL_PCT | layers | re-entry | D1 |
|---|---|---|---|---|---|---|---|---|
| `lion-0020.js` | `Lion_0020` | BANKNIFTY 260105 | 100 | `otmSelector()`→0 | 1.25 | 1 | paired | 10 s |
| `lion-1789.js` | `Lion_1789` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | paired | 10 s |
| `lion-m6000.js` | `Lion_M6000` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | paired | 10 s |
| `lion-zzj11574.js` | `Lion_ZZJ11574` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | paired | 10 s |
| `lion-zzJ4351.js` | `Lion_ZZJ4351` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | paired | 10 s |
| `lion-zzJ4351-2.js` | `Lion_ZZJ4351-2` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | paired | 10 s |
| `lion-zzJ4351-3.js` | `Lion_ZZJ4351-3` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | paired | 10 s |
| `lion-zzJ4351-4.js` | `Lion_ZZJ4351-4` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | paired | 10 s |
| `lion-s15-zzJ4351.js` | `Lion_S15_ZZJ4351` | BANKNIFTY 260105 | 100 | →0 | **1.15** | 1 | paired | 10 s |
| `biglion-0020.js` | `BigLion_0020` | BANKNIFTY 260105 | 100 | →0, **+0/+100/+200/+300** | 1.25 | **4** | paired (all 4 must close) | 5 s |
| `jk-0020.js` | `JK_0020` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | **per-leg** | 5 s |
| `jk-zzJ4351.js` | `JK_ZZJ4351` | BANKNIFTY 260105 | 100 | →0 | 1.25 | 1 | **per-leg** | 5 s |

Diff between the nine BANKNIFTY `lion-*` members: **the tag string, and nothing else**
(`lion-1789` additionally inlines a local variable). `biglion` factors the leg-pair emit into
`sendPairOrder(strike, ce, pe)` and calls it four times with spread 0/100/200/300 — i.e. it
sells a 4-wide symmetric ladder and counts `positionsOpen` in units of 4.

---

## 3. Algorithm 2 — `atm-crossover-strangle-synthetic-stop`

**22 files.** Identical entry and re-entry logic; the exit is decided **in-process from
ticks** by `checkSL()`, running on its own `async.queue` on every tick batch. Three exit
sub-modes and three stop bases, freely combined.

### 3.1 Entry

```
on crossover & takePosition:
  for side in [CE, PE]:                       # BUY side for lion-b25-1; tradeType for lion-up-1
     opt = chain[(strike ± OFFSET) + side]
     ltp = ticksCache[opt.instrument_token].last_price
     await Account.placeAllAccount(tag, account_quantities, running_accounts, opt, SIDE, 1)
     optionOrders.push(<watch record>)        # shape depends on stop basis, §3.3
     # sub-mode B only: PaperTrade.trackOrder_slm(chain[opt.strike+side],'BUY',tag,1,
     #                                            parseInt(ltp*SL_PCT), [moment().format('hhmmss')])
  positionsOpen["S"+strike].{CE,PE} += 1
```

`Account.placeAllAccount` (`common/models/account.js:148`) does **two** things:

1. `PaperTrade.trackOrder(opt, side, tag, multiplier)` — a `paper-trade` insert with
   `status:COMPLETE`, `order_type:MARKET`, **no `dataObj`**. This is the real order: it is
   picked up by xtsOrder / sparkOrder / fyersOrder exactly like `trackOrder_v2`.
2. `async.map(running_accounts, …)` — direct synchronous Zerodha `orderFNO` calls. **`running_accounts`
   is `[]` in all 38 files** because `await getAccounts()` is commented out, so this loop is
   a no-op and no Zerodha order is ever placed.

> **Correction to prior family notes.** `lion-s25` is *not* a broker-rail mismatch. Its entry
> (`placeAllAccount`) and its stop (`trackOrder_slm`) both leave the process on the **same
> rail** — a `paper-trade` insert — and are executed by the same XTS/Spark/Fyers daemons.
> The Zerodha-direct code path is present but dead. The real asymmetries are elsewhere:
> see §7.5 (orphaned resting stop) and §7.6 (Spark drops `dataObj`).

### 3.2 Exit sub-modes

| sub-mode | what runs | broker-side protection if the process dies |
|---|---|---|
| **B — mirrored resting stop** (7 files) | tick monitor **and** a resting `StopMarket` on the bus. Tick hit → `delete optionOrders[idx]`, `executeSL(sl_id, token, ltp)` mutates the resting doc to `COMPLETE` **and nothing else** | yes, a real StopLimit rests at the broker — but see §7.5: the tick monitor never cancels it |
| **C — tick monitor only** (9 files) | tick hit → `delete optionOrders[idx]`, decrement `positionsOpen`, `await placeAllAccount(chain[strike+type], 'BUY'/'SELL', 1)` | **none** — position is naked if the process stops |
| **T — trailing, tick monitor only** (6 files) | same as C, with the trailing stop of §3.3 | **none** |

Ordering that must be preserved: `delete optionOrders[idx]` executes **before** the awaited
exit order, so a second `checkSL()` on the next tick cannot double-exit the same leg.
`Array.prototype.forEach` skips the resulting holes.

### 3.3 Stop bases

```
# per-leg fixed %              (sl_percent = 1.25, one file 1.03/1.4 in smp)
exit_leg if ltp(leg) > entry_ltp(leg) * SL_PCT

# per-leg trailing             (trail_sl = 0.15 or 0.25)
record  = {entry: ltp, low: ltp, trail_sl: ltp * TRAIL_PCT}
on tick: record.low = min(record.low, ltp)
         sl_price   = record.entry + (record.trail_sl - (record.entry - record.low))
                    = record.low + record.trail_sl          # algebraically
         exit_leg if ltp > sl_price
# i.e. a stop trailing TRAIL_PCT×entry_premium ABOVE the running minimum premium.
# The trail amount is fixed in points at entry; it never re-scales.

# combined-premium, PAIR exits together
record  = {ce_token, pe_token, ce_strike, pe_strike, sl_trigger:(ce_ltp+pe_ltp)*PCT}
lion-sp5-1:  exit both legs if (ce_ltp + pe_ltp) <  sl_trigger   # PCT=0.95 → +5% PROFIT TARGET
lion-up-1 (long straddle): exit both if (ce+pe) > entry*1.05     # +5% PROFIT TARGET
samlion:     exit ONE leg  if (ce_ltp + pe_ltp) >  entry*1.25    # 25% loss on the pair
lion-b25-1 (long strangle): exit leg if ltp > entry*1.25         # +25% PROFIT TARGET, no stop
```

**`lion-sp5-1`, `lion-up-1` and `lion-b25-1` have no stop-loss of any kind.** The variable
is named `sl_percent`/`sl_trigger`, the comparison is inverted, and the effect is a profit
target. Do not carry the misleading name into the rewrite.

### 3.4 Members

| file | tag | index / token | STEP | offset source | side | stop basis | value | exit sub-mode | in `strategies.json` |
|---|---|---|---|---|---|---|---|---|---|
| `lion-s25-1.js` | `Lion_S25_1` | BANKNIFTY 260105 | 100 | `otmSelector()`→0 | SELL | per-leg % | 1.25 | B | yes, autostart **false** |
| `lion-fs25-1.js` | `Lion_FS25_1` | FINNIFTY 257801 | 50 | hardcoded 0 | SELL | per-leg % | 1.25 | B | yes, false |
| `lion-fs25-2.js` | `Lion_FS25_2` | FINNIFTY 257801 | 50 | hardcoded 0 | SELL | per-leg % | 1.25 | B | yes, false |
| `lion-ms25-1.js` | `Lion_MS25_1` | MIDCPNIFTY 288009 | 50 | hardcoded 0 | SELL | per-leg % | 1.25 | B | yes, false |
| `lion-ms25-2.js` | `Lion_MS25_2` | MIDCPNIFTY 288009 | 50 | hardcoded 0 | SELL | per-leg % | 1.25 | B | yes, false |
| `lion-ns25-1.js` | `Lion_NS25_1` | NIFTY 256265 | 50 | hardcoded 0 | SELL | per-leg % | 1.25 | B | yes, false |
| `jk-m6000.js` | `JK_M6000` | BANKNIFTY 260105 | 100 | →0 | SELL | per-leg % | 1.25 | B, **per-leg re-entry** | no |
| `lion-s25-2.js` | `Lion_S25_2` | **BANKNIFTY MONTHLY FUTURE** `optionData.currentFuture.token` | 100 | →0 | SELL | per-leg % | 1.25 | C | yes, **autostart TRUE** |
| `lion-s25-3.js` | `Lion_S25_3` | BANKNIFTY 260105 | 100 | →0 | SELL | per-leg % | 1.25 | C | yes, false |
| `lion-s25-2e.js` | `Lion_S25_2E` | BANKNIFTY 260105 | 100 | hardcoded 0 | SELL | per-leg % | 1.25 | C | yes, false |
| `lion-s25-3e.js` | `Lion_S25_3E` | BANKNIFTY 260105 | 100 | hardcoded 0 | SELL | per-leg % | 1.25 | C | yes, false |
| `lion-ns25-2.js` | `Lion_NS25_2` | NIFTY 256265 | 50 | →0 | SELL | per-leg % | 1.25 | C | yes, false |
| `lion-snx-1.js` | `Lion_SNX-1` | SENSEX 265 | 100 | `otmSelector('Lion_SNX')`→0 | SELL | per-leg % | 1.25 | C | yes, false |
| `lion-b25-1.js` | `Lion_B25_1` | BANKNIFTY 260105 | 100 | →0 | **BUY** | per-leg % (**target**) | 1.25 | C (exit = SELL) | yes, false |
| `lion-sp5-1.js` | `Lion_SP5-1` | BANKNIFTY 260105 | 100 | hardcoded 0 | SELL | **combined-premium target** | 0.95 | C, pair exit, not awaited | yes, false |
| `lion-up-1.js` | `Lion_Up-1` | BANKNIFTY 260105 | 100 | →0 (SELL branch only) | **directional**, §3.5 | pair target 1.05 / per-leg 1.25 | — | C | yes, false |
| `lion-st15-1.js` | `Lion_ST15_1` | BANKNIFTY 260105 | 100 | →0 | SELL | trailing | 0.15 | T | yes, false |
| `lion-st15-2.js` | `Lion_ST15_2` | BANKNIFTY 260105 | 100 | →0 | SELL | trailing | 0.15 | T | yes, false |
| `lion-st15-3.js` | `Lion_ST15_3` | BANKNIFTY 260105 | 100 | →0 | SELL | trailing | 0.15 | T | yes, false |
| `lion-st15-0020.js` | `Lion_ST15_0020` | BANKNIFTY 260105 | 100 | →0 | SELL | trailing | 0.15 | T (D1 = 10 s) | no |
| `lion-st15-1789.js` | `Lion_ST15_1789` | BANKNIFTY 260105 | 100 | →0 | SELL | trailing | 0.15 | T (D1 = 10 s) | no |
| `lion-st25-1.js` | `Lion_ST25-1` | BANKNIFTY 260105 | 100 | →0 | SELL | trailing | **0.25** | T (D1 = 10 s) | yes, false |

`lion-fs25-1` vs `lion-fs25-2` and `lion-ms25-1` vs `lion-ms25-2` differ in **the tag only**.
They are two independent instances of the same strategy so that different broker accounts (or
different lot sizes for the same account) can subscribe: sizing is external, keyed by tag
(§4.3).

### 3.5 `lion-up-1` directional rule

```
tradeType  = strike > q.ohlc.close ? 'BUY' : 'SELL'    # ohlc.close = previous day's close
strike_gap = tradeType == 'BUY' ? 0 : farOtm(=0)
BUY  branch: buy ATM CE + ATM PE (a long straddle); exit both when
             ce+pe > (ce_entry+pe_entry) * 1.05         # +5% profit target, no stop
SELL branch: sell CE + PE at ±farOtm; per-leg stop at entry*1.25
```
Requires `modeFull` ticks for `ohlc.close`. The smp sibling `lion-down.js` is the same file
with `<` instead of `>` and lot multiplier 10.

---

## 4. Algorithm 3 — `static-strike-ladder` (`samlion`)

**4 files: `samlion-9.js`, `-10.js`, `-11.js`, `-12.js`.** No crossover, no re-entry, no ATM
tracking — a **one-shot** ladder fired once at startup.

```
runStrategy(): ... same skeleton, farOtm = 0 (hardcoded), D1 = D2 = 5000
checkTicks(): updates ticksCache; pushes ONLY to checkSLQ.
              # takePositionQ is NEVER pushed → placeTrade runs exactly once,
              # from the forced call in runStrategy.

placeTrade():                                    # runs once, ~10 s after start
  atm = round(ltp/100)*100
  for i in 0..9:
     sendSeriesOrder(atm + i*100, atm - i*100)   # 10 pairs: straddle + ±100 … ±900

sendSeriesOrder(ce_strike, pe_strike):
  ce = chain[ce_strike+"CE"]; pe = chain[pe_strike+"PE"]
  ce_ltp = ticksCache[ce.instrument_token].last_price
  Account.placeAllAccount(tag, {}, [], ce, 'SELL', 1)      # not awaited
  pe_ltp = ticksCache[pe.instrument_token].last_price
  Account.placeAllAccount(tag, {}, [], pe, 'SELL', 1)
  optionOrders.push({ce_strike, pe_strike, ce_token, pe_token,
                     ce_entry:ce_ltp, pe_entry:pe_ltp,
                     sl_trigger:(ce_ltp+pe_ltp)*1.25, sl_hit:false})

checkSL():                                       # per pair, on every tick
  total = ltp(ce_token) + ltp(pe_token)
  if (total > sl_trigger):                       # 25% loss on the PAIR's combined premium
     optionOrders[idx] = false                   # samlion-9;  delete optionOrders[idx] in 10/11/12
     if      ltp(ce) > ce_entry: placeAllAccount(..., position.ce_option, 'BUY', 1)
     else if ltp(pe) > pe_entry: placeAllAccount(..., position.pe_option, 'BUY', 1)
```

Total exposure: **20 short legs** (i=0 sells the ATM CE and the ATM PE, i.e. a straddle, then
9 progressively wider strangles). `positionsOpen` is declared and never used.

**`position.ce_option` / `position.pe_option` are never stored** — `sendSeriesOrder` pushes
`ce_token`/`pe_token`, not `ce_option`/`pe_option`. So the exit call receives `undefined`,
`placeAllAccount`'s guard `if (optionInstrument && optionInstrument.tradingsymbol)` fails, and
the function returns `undefined` without doing anything. **samlion has no working exit at
all**: 20 naked short legs, no stop, no target, no square-off. All four files share the bug.
Even if fixed, the `else if` closes only ONE leg of the losing pair.

The four files differ in: the tag, `for..in` vs `forEach` in `checkSL`, and a `console.log`.

---

## 5. Config axes that regenerate all 38 files

```ts
interface LionConfig {
  tag: string;                       // strategyTag — ALSO the broker sizing key (§4.3)

  underlying: {
    name: 'BANKNIFTY'|'NIFTY'|'FINNIFTY'|'MIDCPNIFTY'|'SENSEX';
    triggerToken: number | 'monthly-future';  // 260105 | 256265 | 257801 | 288009 | 265
                                              // 'monthly-future' ONLY in lion-s25-2
    strikeStep: 50 | 100;
  };

  offset: number;                    // strikes away from ATM, in points. ALWAYS 0 in practice.
  layers: number[];                  // extra spread per stacked pair: [0] | [0,100,200,300]

  side: 'SELL' | 'BUY' | 'above-prev-close-buy-else-sell';

  exit:
    | { basis:'per-leg-pct',            pct:number }        // 1.15 | 1.25 | (smp: 1.03, 1.4)
    | { basis:'per-leg-trailing-pct',   pct:number }        // 0.15 | 0.25
    | { basis:'combined-premium-pct',   pct:number,
        direction:'below'|'above', scope:'pair'|'single-losing-leg' };

  exitEngine: 'broker-resting-stop'    // Algorithm 1: OrderUpdate state machine
            | 'tick-monitor+resting'   // Algorithm 2 sub-mode B
            | 'tick-monitor';          // Algorithm 2 sub-modes C / T, Algorithm 3

  reentry: 'paired' | 'per-leg' | 'never';   // never = samlion

  entryTrigger: 'atm-crossover' | 'once-at-start';
  forceFirstEntry: boolean;                  // true in every file
  warmupMs: [number, number];                // [D1, D2]: [5000,5000] | [10000,5000]

  sizing: { units: 1 | 4 | 10; source: 'broker-account-map-by-tag' };
}
```

Nothing else varies. Two files that differ only in `tag` (`fs25-1`/`fs25-2`,
`ms25-1`/`ms25-2`, `st15-1`/`-2`/`-3`, the nine BANKNIFTY Algorithm-1 files, the four
`samlion`s) collapse to one class + N config records.

### 5.1 Sizing is not in these files

`placeAllAccount(..., multiplier)` sends `multiplier` **units of 1 lot** to the bus. The
actual quantity is resolved by the broker daemon:
`orderQuantity = (doc.quantity / lot_size) * account.strategy[tag]`
(`xtsOrder.js:98`), tranched at `maxOrderLots` = BANKNIFTY 20 / NIFTY 27 / FINNIFTY 45 /
MIDCPNIFTY 56 / SENSEX 50 lots per order. So position size is a per-account, per-tag number
in Mongo, and `multiplier` is only a *relative* scalar (1 everywhere in slive; 10 in
`smp/lion-down.js`). **The rewrite must keep the "strategy emits units, broker layer scales
by tag" contract**, otherwise every live account's size changes silently.

---

## 6. Facts an implementer will otherwise get wrong

**6.1 `futureToken` is a spot index token, not a future.** 260105 = NIFTY BANK index,
256265 = NIFTY 50, 265 = SENSEX, 257801 = FINNIFTY, 288009 = MIDCPNIFTY. Only
`lion-s25-2.js` (the sole `autostart:true` member) uses `optionData.currentFuture.token`, the
real monthly future. Futures trade at a premium/discount to spot, so `lion-s25-2` selects a
*different* ATM strike from `lion-s25-3` — the files are otherwise identical, and this is the
entire point of the pair. Keep the trigger instrument configurable.

**6.2 `otmSelector()` returns 0 for every tag this family passes.** `lib/otmSelector.js`
branches on `'Lion'` (default) and `'Lion_SNX'`; every branch of both returns `0`. So
`farOtm = 0` always, and **every "OTM strangle" in this family is in fact a short ATM
straddle**. The module-level `let farOtm = 400` is dead (overwritten in `runStrategy` before
the first tick). The declared-but-unread `sl_trigger` inside Algorithm 1's `eventTrigger`
records is likewise dead.

**6.3 `getAccounts()` is commented out in all 38 files**, so `running_accounts = []` and
`account_quantities = {}`. Consequences: (a) the Zerodha direct rail is dead everywhere;
(b) `placeAllAccount`'s only effect is its internal `PaperTrade.trackOrder` insert; (c) the
`multiplier` argument reaches the bus but the per-account Zerodha loop never runs.

**6.4 Every process opens its own Kite websocket using the *master* account's token.**
`zerodha_init(base_acc)` logs in to `app.get('masterId')`, writes `lastLogin` + `config` back
to that account document, and mints `public_token` purely to construct `new kiteTicker(...)`.
38 processes × (1 login + 1 websocket + 1 account write) against one Zerodha account, each
subscribing to the whole weekly chain in `modeFull`. This is the single strongest argument
for the shared tick-bus in the target architecture.

**6.5 `optionConfig()` prefers a cached file.** `tools/optionInstruments.js:148` does
`require('./../../optionConfig_<UNDERLYING>.json')` and only hits the Sensibull API if that
throws. A stale file means trading last week's expiry with last week's tokens. The download
cron in that module is commented out; `boot/paperstream.js` refreshes the files at 07:30 /
08:45 IST. Any rewrite must own expiry rollover explicitly.

**6.6 Process lifecycle is entirely external.** `server/tools/xtsOrder.js`:
09:13:00 `init` → 09:16:30 `startStrategies` (pm2 restart of every `autostart:true` entry in
`common/models/strategies.json`) → per-minute `delayStartStrategies` (matches
`delay_start == HHmm`; **no lion entry sets `delay_start`**) → 15:23:50 `stopStrategies`
(pm2 stop of **all** registered strategies) → 15:24:05 `clearOrders`
(`XtsAccount.removePending` — cancels resting stops) → 15:30:00 `process.exit()`.
`squareOff()` exists in that file but **is never scheduled** (the only `CronJob` for it, in
`am_xtsOrder.js:236`, is commented out).

**6.7 There is therefore NO end-of-day exit.** No lion file contains a `CronJob`, a
square-off, or any time check. At 15:23:50 the strategy process is killed mid-position; at
15:24:05 its resting stop orders are cancelled. Whatever was open stays open overnight unless
a human squares off. This is the family's largest structural risk and the first thing the
rewrite must add.

**6.8 `eventIdx` restarts at 0 on every process restart** (Algorithm 1). There is no catch-up
of open positions from Mongo, no reconciliation of broker positions, and no persistence of
`positionsOpen` / `optionOrders`. A restart therefore (a) forgets every open leg, (b) re-fires
`placeTrade(true)` and opens a fresh pair, and (c) can re-issue `eventId` values that collide
with `OrderUpdate` documents still arriving for the previous incarnation — those land in the
*new* `eventTrigger` map and can arm or close the wrong leg. `pm2 restart` on crash makes this
reachable.

**6.9 Only `Lion_S25_2` autostarts.** 23 of the 38 tags appear in
`common/models/strategies.json`; exactly one has `autostart:true`. The 12 Algorithm-1 files,
`jk-m6000`, `lion-st15-0020` and `lion-st15-1789` are **not registered at all** — they are
manual/pm2-only legacy processes named after client codes (0020, 1789, m6000, zzJ4351,
zzj11574). Registration status is a config field, not a code difference.

**6.10 Only 12 files import `PaperTrade` directly.** The other 26 reach the same bus through
`Account.placeAllAccount` → `PaperTrade.trackOrder`. "No `PaperTrade` in the file" does not
mean "not bus-routed".

---

## 7. Bugs, dead code, dangerous behaviour

**7.1 Unhandled rejection permanently wedges a queue. (critical)**
```js
async.queue(function (task, callback) { placeTrade().then(function (res) { callback(); }); }, 1)
```
No `.catch`. If `placeTrade()` or `checkSL()` rejects, `callback` is never invoked, the
concurrency-1 queue never drains, and every subsequent tick appends a task that will never
run (unbounded memory growth, silent death). Reachable whenever:
* `ticksCache[futureToken]` is undefined (first tick of the index not yet received, but
  option ticks already arrived — `startTrade` is set on a timer, not on data availability);
* `chain[(strike ± offset) + side]` is undefined (index moved outside the downloaded chain,
  or a wrong `strikeStep` for the underlying);
* `ticksCache[opt.instrument_token]` is undefined (that strike hasn't ticked yet — routine
  for the far wings of `samlion`'s ±900 ladder and for any freshly-moved ATM).

Because entries and exits use **separate queues**, a throw in `checkSL` freezes exits while
entries keep firing: the strategy silently converts into an unmanaged, ever-growing short.

**7.2 No tick-availability precondition.** `startTrade` is enabled by
`setTimeout(D1) → setTimeout(D2)`, i.e. 10–15 s of wall clock, with no check that ticks have
arrived. `lastQuote = ticksCache[futureToken].last_price` inside the outer `setTimeout` sits
*outside* `runStrategy`'s `try/catch`, so a missing first tick is an uncaught `TypeError` and
the process dies (then pm2 restarts it, see §6.8).

**7.3 A REJECTED stop-loss is booked as a fill. (critical, Algorithm 1)**
The `remove_position` branch checks only `action`, never `doc.status`, and
`smp_order_listener.js` inserts `OrderUpdate` documents for `REJECTED` as well as `FILLED`.
So a rejected stop order decrements `positionsOpen`, marks the resting `paper-trade` doc
`COMPLETE` with `average_price = doc.price` — which for a rejected order is
`OrderAverageTradedPrice`, typically `0` — and clears the trigger. Result: a phantom exit at
price 0 in the P&L, a real naked short still at the broker, and the strike immediately
re-eligible for another pair.

**7.4 A REJECTED entry leaks its trigger forever. (Algorithm 1)**
The `place_sl` branch acts only `if (update.status == 'Filled')`. On rejection nothing
happens: the trigger stays armed, **no stop is ever placed**, and `positionsOpen` stays at 1
— permanently blocking re-entry on that strike while the (unfilled, so harmless) book shows
a position. Silent and undiagnosable from logs.

**7.5 Sub-mode B orphans its resting broker stop. (critical, 7 files)**
`lion-s25-1`, `lion-fs25-{1,2}`, `lion-ms25-{1,2}`, `lion-ns25-1`, `jk-m6000` place a real
`StopMarket` (→ XTS `StopLimit`) *and* watch ticks. When the tick monitor fires it calls
`executeSL()`, which **mutates** the resting document to `COMPLETE`. Every bus consumer
listens only for `operationType == 'insert'`, so the broker never learns: the real StopLimit
remains live at the exchange. The local book says flat; the broker says short + a resting BUY
stop. If the stop later triggers, the account goes **long** the option. Note also that the
tick-monitor exit path in these 7 files places **no closing order of its own** — it only
edits the Mongo document — so the position is only ever really closed if the broker stop
fills. The tick monitor is pure bookkeeping fiction.

**7.6 `sparkOrder.js` drops `dataObj`. (critical for Algorithm 1)**
`server/tools/sparkOrder.js:51` never sets an order-identifier field and nothing in that file
writes `OrderUpdate`. A tag mapped to a Spark account therefore gets its entry filled but
**no fill echo ever returns**, so Algorithm 1 never places a stop: an unmanaged naked short
with no error anywhere. Same for `boot/paperstream.js`, which only stamps `average_price` on
`COMPLETE` inserts and never emits `OrderUpdate` — so under the simulator alone, Algorithm 1
sells and never protects, and its `StopMarket` docs stay `Pending` forever.

**7.7 `samlion` has no working exit at all. (critical, 4 files)** See §4 — `ce_option` /
`pe_option` are never stored, so `placeAllAccount(undefined, …)` silently no-ops. 20 naked
short legs, permanently.

**7.8 `lion-sp5-1`, `lion-up-1`, `lion-b25-1` have no stop-loss.** The `sl_percent` /
`sl_trigger` names are lies; the comparisons are profit targets (§3.3). `lion-sp5-1` sells an
ATM straddle and exits only on a 5% *decay* of the combined premium — an unlimited-loss
position with a 5% take-profit and nothing else.

**7.9 The paired re-entry guard leaks one-sided exposure.** With the `paired` dialect
(§1.2), one leg stopping out re-sells **both** legs, so the surviving side's counter climbs
1 → 2 → 3 … and can never return to 0. On a trending day the strategy pyramids into the
losing direction without limit. Only `jk-*` avoids this. Any rewrite should default to
per-leg re-entry and add an explicit max-legs cap.

**7.10 Only one stop is armed per entry regardless of fan-out. (Algorithm 1)**
`orderUniqueIdentifier` is shared by every account and every tranche of one logical entry, so
several `Filled` updates carry the same `params[0]`. The first one sets
`eventTrigger[idx] = false`, so the rest are ignored. That is correct today only because
`trackOrder_slm` re-fans-out to all accounts at 1 unit each; it breaks the moment partial
fills or heterogeneous per-account outcomes matter (account A filled, account B rejected →
one shared stop, sized for both).

**7.11 The stop price is derived from one account's fill.** `stopPrice = doc.price * SL_PCT`,
where `doc.price` is whichever account/tranche reported first. `xtsOrder` then
`parseInt()`s it (truncation to whole rupees) and sets the protective limit at
`stop × 1.05` for stops ≤ 1000 — a 5% slippage cap on a market-stop, which will simply not
fill in a fast move.

**7.12 A rejected order on *any* strategy can flatten the whole account.**
`boot/paperstream.js:141` reacts to any rejected Zerodha order by calling
`Account.squareOff(order.accountId, …)` for the entire account. An unrelated strategy's
margin rejection closes lion's positions behind its back; `positionsOpen` never learns.

**7.13 Dead code to drop, not port.** `const CronJob = require('cron').CronJob` (unused in
all 38); `notify` (used only in one Algorithm-1 catch); `channelId = 0`; `fromDate`/`toDate`;
`accounts`/`firstRun`/`getAccounts` (dead, §6.3); `ATM_Strike` (write-only);
`sl_trigger`/`sl_hit` inside Algorithm 1's `eventTrigger`; `let farOtm = 400`;
`positionsOpen` in `samlion`; the `zerodha`/`Account.findById(masterId)` login (needed only
for a market-data token, which the shared feed service should own).

**7.14 `optionOrders` never shrinks.** `delete optionOrders[idx]` (or `= false`) leaves holes;
the array grows for the life of the process. Harmless in a 6-hour session, but it means
`checkSL` cost grows linearly with the number of trades taken.

---

## 8. Target design notes

One class, `AtmCrossoverPair`, with an injected feed and an injected order gateway:

* **Feed** — `onTick(token, tick)` from the shared tick bus. Entry evaluation must be gated on
  "trigger instrument has ticked **and** both selected option tokens have ticked", replacing
  §7.2's timer. Backtesting then works by replaying history through the identical
  `onTick`.
* **Trigger** — `CrossoverDetector(step, source: 'spot'|'monthly-future')` holding `lastQuote`.
  Emit `cross(strike)`; `forceFirstEntry` becomes an explicit "prime at open" flag.
* **Book** — `Map<strike, {CE: Leg[], PE: Leg[]}>`, persisted, with `reentry: 'paired'|'per-leg'`
  and a hard `maxLegsPerStrike`. Restart must reconcile against broker positions before
  arming (fixes §6.8).
* **Exit policies** — small strategy objects over a common interface:
  `FixedPctStop`, `TrailingPctStop`, `CombinedPremiumTarget`, each returning
  `{ closeLegs: Leg[] }`. Their state (`entry`, `low`, `sl_trigger`) is per-leg and
  serialisable.
* **Exit engine** — a single mode, not three: place a real resting protective order **and**
  monitor ticks, with the tick monitor **cancel-then-replace** (never silently mutating the
  resting doc — fixes §7.5). Fill/reject confirmations must be status-checked (fixes §7.3,
  §7.4) and must be idempotent per logical leg rather than per broker order (fixes §7.10).
* **Lifecycle** — the class owns a mandatory `squareOffAt` (fixes §6.7) and a
  `stopEntriesAt`, and must not depend on an external pm2 kill for either.
* **Sizing** — keep the "emit N units, broker layer scales by tag" contract (§5.1).
* **Every queue gets a `catch`** that logs, notifies, and releases the slot (fixes §7.1).
