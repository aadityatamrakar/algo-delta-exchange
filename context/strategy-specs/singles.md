# Family spec: `singles`

**Scope:** 14 one-off files in `server/slive/` that do not belong to any large lineage.
**Status of this document:** canonical. It is complete enough to implement the TypeScript
classes without re-opening the legacy JS.

| # | File | LOC | Last touched | Idea |
|---|------|-----|--------------|------|
| 1 | `dolphin-0020.js` | 254 | 2021-07-30 | A · premium-target pair seller |
| 2 | `nifty-s-1789.js` | 258 | 2022-05-23 | A |
| 3 | `nifty-s-sbm95.js` | 258 | 2022-05-23 | A |
| 4 | `target-15.js` | 260 | 2025-09-03 | A |
| 5 | `fox-1.js` | 175 | 2023-09-05 | B · trailing-flip pair |
| 6 | `snx-orb-1.js` | 376 | 2026-04-07 | C · option-premium ORB |
| 7 | `snx-orb-25.js` | 387 | 2026-07-03 | C |
| 8 | `snx-orb-50.js` | 387 | 2026-07-03 | C |
| 9 | `cal-ce.js` | 116 | 2023-02-22 | D · one-shot ATM calendar |
| 10 | `cal-pe.js` | 116 | 2023-02-22 | D |
| 11 | `fut-100.js` | 284 | 2025-06-10 | E · futures stop-and-reverse |
| 12 | `candlestrategy.js` | 132 | 2025-10-06 | F · external signal mirror (NOT a strategy) |
| 13 | `candlestrategy-a006.js` | 132 | 2025-09-01 | F |
| 14 | `candlestrategy-test3.js` | 132 | 2025-07-09 | F |

**6 distinct algorithms across 14 files.** This is a high idea-per-file ratio by construction:
`singles` is the residue family — everything that did *not* mass-replicate.

---

## 0. Shared runtime substrate (all files except F)

Every file 1–11 is a top-level script, `require`d/`node`-launched once, with the same 40-line
preamble. Extract this into the runner, not the strategy.

```
boot():
  optionData = await optionConfig(UNDERLYING)          # server/tools/optionInstruments.js
  masterAcc  = await Account.findById(app.get('masterId'))
  zapi       = await zerodha_init(masterAcc)           # logs in, MUTATES + SAVES the account doc
                                                       #   (lastLogin, config), yields public_token
  liveFeed   = new KiteTicker({api_key:'kitefront', access_token: public_token})
  liveFeed.subscribe(subs); liveFeed.setMode(modeFull, subs)
  liveFeed.on('ticks', t => Object.assign(ticksCache, byToken(t)))
```

### `optionConfig(underlying = 'BANKNIFTY')` contract

Returns (from a Sensibull scrape):

```
{ currentFuture: {token, symbol, ltp},   # nearest-MONTH future
  weeklyInstruments:   { "<strike><CE|PE>": {instrument_token, tradingsymbol, lot_size, strike, ...} },
  nextWeekInstruments: { same shape, expiry = 2nd nearest },
  weeklyExpiry, monthlyExpiry, options, futures, max_pain, ivp, ivTrend }
```

**Critical:** `config()` first tries `require('./../../optionConfig_<UND>.json')` — a file written
by a previous `download()`. If that file exists it is returned **without any freshness check**, and
`require` caches it for the process lifetime. A stale file means the strategy trades **expired
instrument tokens all day**. The new implementation must date-stamp and validate the cache.

### `otmSelector(tag)` contract

`server/lib/otmSelector.js` returns **0** for every tag these files pass
(`undefined`→`'Lion'`, and `'Cheetah'`). So:

* `nifty-s-*`: `farOtm = otmSelector()` → **0**
* `fox-1`: `farOtm = otmSelector('Cheetah')` → **0** → fox-1 trades an **ATM straddle**, not a strangle.

Only `dolphin-0020` has a real offset, and it is a hardcoded literal (`farOtm = 200`).

### Execution rails — measured, not assumed

| Rail | Mechanism | Used by |
|---|---|---|
| **Bus only** | `PaperTrade.trackOrder*` inserts a doc into Mongo `paper-trade`. Consumers: `server/boot/paperstream.js` (simulator, stamps `average_price` from its own tick cache), `server/tools/xtsOrder.js` / `sparkOrder.js` / `fyersOrder.js` (REAL brokers, but only for accounts whose `account.strategy[tag] > 0`). | `cal-ce`, `cal-pe`, `target-15`, `fut-100`, `candlestrategy*` |
| **Bus + Zerodha direct** | `Account.placeAllAccount(tag, account_quantities, running_accounts, instrument, side, lots)` → calls `Account.trackOrder` (bus) **first**, then places a synchronous Zerodha MARKET order per logged-in account. | `snx-orb-*` |
| **Bus only in practice, live-capable by design** | Same `Account.placeAllAccount` call, **but `running_accounts` is never populated**. | `dolphin-0020`, `nifty-s-*`, `fox-1` |

**Correction to prior catalog entries.** `dolphin-0020.js`, `nifty-s-1789.js`, `nifty-s-sbm95.js`
and `fox-1.js` are documented as `live`. Hard evidence they are **not** placing Zerodha orders:

```
$ grep -n getAccounts server/slive/{dolphin-0020,nifty-s-1789,fox-1}.js
server/slive/nifty-s-1789.js:127:    // await getAccounts();
server/slive/dolphin-0020.js:127:    // await getAccounts();
```

`fox-1.js` has no mention at all, and **none of the three defines a `getAccounts()` function**.
`running_accounts` / `account_quantities` stay at their module-scope initialisers (`[]`, `{}`).
Inside `placeAllAccount` (common/models/account.js:148) that means `async.map([])` completes
immediately, and the only side effect is the `trackOrder()` bus insert on the first line.
So they are **bus-routed**, one uncommented line away from live. `snx-orb-*` **does** call
`await getAccounts()` with `firstRun = true` → `Account.loadAccounts(tag, true)` → real Zerodha
logins → genuinely live.

> Latent landmine in `loadAccounts`: it keys `account_quantities` by `elm.name`, while
> `placeAllAccount` looks it up by `tmp_zapi.credentials.user_id`. If those differ for an
> account, its live leg is **silently skipped** while the bus leg still fires.

### Central exit paths outside the strategies

`server/tools/smp_target.js:124` runs `XtsAccount.squareOff(accountId, {})` when an XTS
account's aggregate M2M crosses a per-account target. That closes **all** positions on that
account and zeroes every `account.strategy[*]` allocation. None of these strategies observe it,
so after a central squareoff they keep tracking phantom positions and will emit exit orders for
positions that no longer exist. Any rewrite must expose a *position-reconciliation* hook.

---

## A. `premium-target-pair-seller`

**Members:** `dolphin-0020.js`, `nifty-s-1789.js`, `nifty-s-sbm95.js`, `target-15.js`

**One line:** sell an index CE+PE pair at (or a fixed offset around) the ATM, hold with **no stop
loss of any kind**, exit the whole pair on a pure premium-decay target, then re-arm and sell again
— forever, intraday, with no EOD flat.

The four files share one skeleton: tick → derive a strike from a price → sell CE+PE → watch the
premium → buy both back on target → re-enter. They differ on exactly two axes: **what re-arms the
entry** (a spot grid crossover vs. a fixed delay) and **how the target is measured** (combined
points vs. per-leg percent-of-combined).

### A.1 Canonical pseudocode

```
config = {
  underlying, atmSourceToken,       # dolphin/nifty-s: INDEX spot token; target-15: FUTURE token
  strikeStep,                       # 100 (BANKNIFTY) | 50 (NIFTY)
  gridStep,                         # crossover ladder step; dolphin 200, nifty-s 50
  farOtm,                           # 200 (dolphin) | 0 (all others)
  reentryTrigger: 'gridCrossover' | 'fixedDelay',
  reentryDelayMs,                   # fixedDelay only: 9000
  targetBasis: 'combinedPoints' | 'perLegPctOfCombined',
  targetPoints,                     # combinedPoints only: 70 (dolphin) | 25 (nifty-s)
  targetPct,                        # perLegPctOfCombined only: 0.015
  expiryRollDays,                   # weekday set that switches to nextWeekInstruments
  warmupMs                          # 10000 (dolphin) | 5000 (nifty-s, target-15)
}

state = { position: null, lastQuote: 0, midPrice: null, armed: false }

on boot:
  chain = expiryRollDays.includes(today.day())
            ? optionData.nextWeekInstruments
            : optionData.weeklyInstruments
  subscribe([atmSourceToken, ...all chain tokens])          # dolphin also subs VIX 264969 (unused)
  after warmupMs:
     state.lastQuote = tick(atmSourceToken).last_price       # THROWS if no tick yet — see risks
     state.armed = true

# ---------- ENTRY ----------
on tick, serialised through entryQueue (concurrency 1), only while state.armed:

  if reentryTrigger == 'gridCrossover':
      px = tick(atmSourceToken).last_price
      if state.midPrice == null:
          level = round(px / strikeStep) * strikeStep         # first trade: nearest strike
      else if px > state.midPrice: level = state.midPrice + gridStep
      else if px < state.midPrice: level = state.midPrice - gridStep
      else:                        level = undefined          # px exactly == midPrice → skip

      crossedUp   = level && px >= level && state.lastQuote <= level
      crossedDown = level && px <= level && state.lastQuote >= level
      isCrossover = crossedUp || crossedDown
      state.lastQuote = px                                    # updated EVERY evaluation

      if !isCrossover: return
      if state.position && state.position.level != level:
          # roll: close the old pair, then open at the new level in the SAME pass
          old = {...state.position}; state.position = null     # flag cleared BEFORE any await
          BUY  chain[old.ceKey];  BUY chain[old.peKey]
          proceed to open
      else if state.position == null:
          proceed to open
      else: return

  if reentryTrigger == 'fixedDelay':
      if state.position != null: return                       # isPositionActive guard
      level = round(tick(atmSourceToken).last_price / strikeStep) * strikeStep

  # ---------- OPEN ----------
  ceKey = (level + farOtm) + 'CE'
  peKey = (level - farOtm) + 'PE'
  ce = chain[ceKey]; pe = chain[peKey]
  if !ce || !pe: return                                       # target-15 guards; dolphin does NOT
  ceLtp = tick(ce).last_price; peLtp = tick(pe).last_price
  if !ceLtp || !peLtp: return                                 # target-15 guards; dolphin does NOT

  SELL ce (1x lot);  SELL pe (1x lot)                          # sequential awaits, CE then PE
  state.position = { level, ceKey, peKey, ceToken, peToken,
                     ceEntry: ceLtp, peEntry: peLtp,
                     combinedEntry: ceLtp + peLtp }
  state.midPrice = level                                       # gridCrossover only

# ---------- EXIT ----------
on tick, serialised through exitQueue (concurrency 1), independent of entryQueue:
  p = state.position; if !p: return
  ceLtp = tick(p.ceToken).last_price; peLtp = tick(p.peToken).last_price

  if targetBasis == 'combinedPoints':
      hit = (ceLtp + peLtp) < (p.combinedEntry - targetPoints)
  if targetBasis == 'perLegPctOfCombined':
      drop = round(p.combinedEntry * targetPct)                # RECOMPUTED EVERY TICK
      hit  = (ceLtp <= p.ceEntry - drop) || (peLtp <= p.peEntry - drop)

  if hit:
      old = {...p}; state.position = null                      # flag cleared BEFORE any await
      BUY chain[old.ceKey]; BUY chain[old.peKey]
      if reentryTrigger == 'fixedDelay': setTimeout(enter, reentryDelayMs)
      # gridCrossover: nothing — the next spot crossover re-enters
```

### A.2 Member config table

| Param | `dolphin-0020` | `nifty-s-1789` | `nifty-s-sbm95` | `target-15` |
|---|---|---|---|---|
| `strategyTag` | `Dolphin-0020` | `Nifty_S_1789` | `Nifty_S_SBM95` | `TGT15` |
| underlying | BANKNIFTY | NIFTY | NIFTY | BANKNIFTY (`optionConfig()` default) |
| `atmSourceToken` | `260105` (BN spot, hardcoded) | `256265` (NIFTY spot, hardcoded) | `256265` | `optionData.currentFuture.token` (**future**, not spot) |
| `strikeStep` | 100 | 50 | 50 | 100 |
| `gridStep` | 200 | 50 | 50 | n/a |
| `farOtm` | **200** (literal) | `otmSelector()` → 0, **and never used** — keys are `level+'CE'` | same | `OTM_DISTANCE = 0` |
| `reentryTrigger` | gridCrossover | gridCrossover | gridCrossover | fixedDelay 9000 ms |
| `targetBasis` | combinedPoints 70 | combinedPoints 25 | combinedPoints 25 | perLegPctOfCombined 1.5 % |
| stop loss | **none** | **none** | **none** | **none** |
| EOD flat | **none** | **none** | **none** | none (cron commented out) |
| `expiryRollDays` | Wed(3) + Thu(4) → next week | Wed + Thu | Wed + Thu | never (always weekly) |
| `warmupMs` | 10 000 | 5 000 | 5 000 | 5 000 |
| rail | bus (`placeAllAccount`, empty accounts) | bus | bus | bus (`PaperTrade.trackOrder`) |
| extra subs | VIX `264969` (subscribed, never read) | VIX `264969` | VIX | none |
| start | on module load | on module load | on module load | on module load, `setTimeout(5 s)` |

`nifty-s-sbm95.js` vs `nifty-s-1789.js`: **a single differing line** — `strategyTag`.
`nifty-s-1789.js` vs `dolphin-0020.js`: 11 differing lines, all constants + the ATM-vs-OTM key
construction. This is the family's proof-of-concept for the class+config rewrite.

### A.3 Notes specific to A

* **`farOtm` in `nifty-s-*` is dead.** It is assigned twice (`400` at declaration, then
  `otmSelector()` → `0` in `runStrategy`) and never referenced, because the option keys are
  built as `new_ATM_Strike + "CE"` / `+ "PE"`. Do not carry the variable forward.
* **`gridStep != strikeStep` in `dolphin`.** After the first trade it moves the ladder by 200
  while the strike grid is 100. So the second and later strikes are always even hundreds offset
  200 from the previous entry — never the true nearest strike. This is intentional (it is what
  makes the strategy require a 200-point move to re-trade) and MUST be preserved as a separate
  config axis from `strikeStep`.
* **`target-15` recomputes its target on every tick** (`TARGET_POINTS = round((ceEntry+peEntry)*0.015)`),
  overwriting the file's declared `TARGET_POINTS = 3`. The literal `3`, `setTargetPoints()`,
  `setOTMDistance()`, `setRestartDelay()` and the whole `module.exports` block are **dead**.
* **`target-15`'s `RESTART_DELAY = 3000 * 3` is 9 s**, though every log line and comment says
  "3 seconds". Preserve 9 s; fix the comment.
* **`dolphin`'s `checkPNL()` is dead code.** The call site in `checkTicks` is commented out
  (`// checkPNL();`). It contained the only account-level exit (`total_m2m > 10000` → fetch
  `PaperTrade.positions()`, flatten every nonzero leg via `Account.trackOrder`) and the only
  `notify()`. Reimplement it as a real, tested M2M kill-switch — this family has **no** risk
  ceiling today.

---

## B. `trailing-flip-pair`

**Member:** `fox-1.js` (only)

**One line:** at start-up, decide long-or-short an ATM BANKNIFTY pair by comparing the pair's
current combined premium to the pair's combined **opening** price; then run a 60-point trailing
stop on the combined premium and, on every hit, close and immediately register the **opposite**
side — capped at 6 placed orders.

```
config = { underlying: BANKNIFTY, atmSourceToken: 260105, strikeStep: 100,
           farOtm: otmSelector('Cheetah') = 0, trailSl: 60, maxOrderCount: 6,
           expiryRollDays: [Wed(3)], startDelayMs: 25000 }

pairPrice(level) = tick(chain[level+farOtm+'CE']).last_price
                 + tick(chain[level-farOtm+'PE']).last_price
pairOpen(level)  = tick(...CE).ohlc.open + tick(...PE).ohlc.open   # today's option open

# ---------- ONE-SHOT DIRECTION PICK, 25 s after boot ----------
level = round(tick(atmSourceToken).last_price / 100) * 100
if pairOpen(level) > pairPrice(level):  sendOrder(level, 'SELL', mul = 1)   # premium fell → sell
else:                                   sendOrder(level, 'BUY',  mul = 0)   # premium rose → "buy"

sendOrder(level, side, mul):
    entry = pairPrice(level)
    if mul > 0 and placedCount < maxOrderCount:
        placedCount++
        place(chain[level+farOtm+'CE'], side, mul)
        place(chain[level-farOtm+'PE'], side, mul)
    positions.push({ level, side, entry, low: entry, high: entry })   # pushed UNCONDITIONALLY

# ---------- TRAILING STOP, every tick, serialised (concurrency 1) ----------
for (pos, idx) in positions:                     # forEach; holes from `delete` are skipped
    ltp = pairPrice(pos.level)
    if pos.side == 'SELL':
        pos.low = min(pos.low, ltp)
        stop = pos.entry + trailSl - (pos.entry - pos.low)     # = entry + trailSl - runUpProfit
        if ltp > stop:
            delete positions[idx]
            sendOrder(pos.level, 'BUY', 1)                     # closes at the SAME strikes
    else:  # 'BUY'
        pos.high = max(pos.high, ltp)
        stop = pos.entry - trailSl + (pos.high - pos.entry)
        if ltp < stop:
            delete positions[idx]
            level2 = round(tick(atmSourceToken).last_price / 100) * 100   # FRESH ATM
            sendOrder(level2, 'SELL', 1)                        # opens a NEW pair
```

**Semantics that are easy to get wrong.** The "flip" is not a true side flip: the `BUY` that
closes a short is *recorded as a new long position at the same strikes*, so the book's net
exposure alternates **short-one-pair → flat → short-a-new-pair → flat → …**. The `BUY` phase is a
flat phase with a live trailing trigger that fires the next short. Any faithful port must keep
this "closing order becomes the next tracked position" behaviour, including the fact that the
short leg re-strikes to the current ATM while the long leg keeps the old strikes.

**The `mul = 0` opening BUY places nothing.** If the pair's premium has *risen* since the option
open, fox-1 registers a phantom long with zero orders on the wire, and the first real order is
only sent when that phantom's trailing stop hits.

---

## C. `premium-orb-dual-side`

**Members:** `snx-orb-1.js`, `snx-orb-25.js`, `snx-orb-50.js`
The most recently maintained lineage in the whole family (`-25`/`-50` edited 2026-07-03).

**One line:** at 09:31, pick one OTM CE above and one OTM PE below the SENSEX 09:15–09:30 range,
then trade an opening-range breakout **on each option's own premium** — four independent one-shot
triggers (CE-up, CE-down, PE-up, PE-down) — sized so the stop equals a fixed rupee loss, hard-stop
at the opposite trigger, one re-entry per side with a stop re-derived from the day's extreme, flat
at 15:20, `process.exit()` at 15:30.

### C.1 Canonical pseudocode

```
config = { underlying: 'SENSEX', indexToken: 265, lotSize: 20,
           levelRound: 25 | 50 | 100,          # premium rounding step
           offsetMode: 'abs' | 'pctOfClose',   # breakout cushion
           offsetAbs: 11, offsetPct: 0.01,
           maxLossPerSide: 20000,
           initCron: '09:00', rangeCron: '09:31', eodCron: '15:20', exitCron: '15:30' }

# ---------- 09:00 : INIT (cron; there is NO call at module load) ----------
chain = optionConfig('SENSEX').weeklyInstruments
await getAccounts()                                  # loadAccounts(tag, firstRun=true) → LIVE logins
subscribe([265, ...all chain tokens])

# ---------- 09:31 : RANGE SETUP (serialised, concurrency 1) ----------
today = ISO date
idxCandles = await zapi.historyData(265, '15minute', today, today)
if empty: retry in 30 s (unbounded retries)
rangeCandle = idxCandles[0]                          # the 09:15–09:30 bar

ceStrike = ceil(rangeCandle.high / 100) * 100        # strike GRID is always 100 for SENSEX
peStrike = floor(rangeCandle.low  / 100) * 100       #   (independent of levelRound)
instCE = chain[ceStrike+'CE']; instPE = chain[peStrike+'PE']
if !instCE || !instPE: ABORT (no retry, rangeSetup stays false → dead for the day)

ceBar = await zapi.historyData(instCE.token, '15minute', today, today)[0]
peBar = await zapi.historyData(instPE.token, '15minute', today, today)[0]
if either missing: ABORT (no retry)

ceHigh = ceil(ceBar.high / levelRound) * levelRound   # snx-orb-1 uses a hardcoded 100 here
ceLow  = floor(ceBar.low  / levelRound) * levelRound
peHigh = ceil(peBar.high / levelRound) * levelRound
peLow  = floor(peBar.low  / levelRound) * levelRound

ceOff = offsetMode=='abs' ? offsetAbs : ceBar.close * offsetPct   # per-leg, from the RANGE CLOSE
peOff = offsetMode=='abs' ? offsetAbs : peBar.close * offsetPct

ceBuyTrig  = ceHigh + ceOff;  ceSellTrig = ceLow - ceOff
peBuyTrig  = peHigh + peOff;  peSellTrig = peLow - peOff
rangeSetup = true

# ---------- EVERY TICK while rangeSetup ----------
breakoutQueue.push()            # concurrency 1
if openPositions: slQueue.push()  # concurrency 1, separate queue

checkBreakout():                                     # each flag fires ONCE PER DAY, never reset
  for (side, inst, buyTrig, sellTrig) in [CE, PE]:
    px = tick(inst).last_price
    if !flag[side].buy and px > buyTrig:
        flag[side].buy = true
        dyn = px * offsetPct                          # 'abs' mode uses offsetAbs instead
        sl  = firstTradeDone[side]
              ? floor(tick(inst).ohlc.low / levelRound) * levelRound - dyn   # re-entry: fresh day low
              : sellTrig                                                     # first trade: opposite trigger
        enter(side, 'BUY', px, calcQty(px, sl), inst, sl)
    else if !flag[side].sell and px < sellTrig:
        flag[side].sell = true
        dyn = px * offsetPct
        sl  = firstTradeDone[side]
              ? ceil(tick(inst).ohlc.high / levelRound) * levelRound + dyn   # re-entry: fresh day high
              : buyTrig
        enter(side, 'SELL', px, calcQty(px, sl), inst, sl)

calcQty(entry, sl):
    r = |entry - sl|
    if r <= 0: return lotSize
    return max(lotSize, floor(maxLossPerSide / (r * lotSize)) * lotSize)     # qty in UNITS

enter(...):  Account.placeAllAccount(tag, qtys, accounts, inst, type, qty / lotSize)  # arg = LOTS
             positions.push({side, type, strike, inst, entry, sl, qty, status:'ACTIVE', entryTime})

checkSL():                                            # iterate positions BACKWARDS and splice
  for idx from positions.length-1 down to 0:
    pos = positions[idx]; if pos.status != 'ACTIVE': continue
    px = tick(pos.inst).last_price; if !px: continue
    hit = (pos.type=='BUY'  && px <= pos.sl) || (pos.type=='SELL' && px >= pos.sl)
    if hit:
        pos.status = 'CLOSED'; positions.splice(idx, 1)          # BEFORE the await
        Account.placeAllAccount(..., opposite(pos.type), pos.qty / lotSize)
        firstTradeDone[pos.side] = true                          # unlocks the fresh-SL re-entry

# ---------- 15:20 EOD ----------  flatten every ACTIVE position, positions = []
# ---------- 15:30 ----------      setTimeout(process.exit, 3000)
```

### C.2 Member config table

| Param | `snx-orb-1` | `snx-orb-25` | `snx-orb-50` |
|---|---|---|---|
| `strategyTag` | `SNX_ORB_1` | `SNX_ORB_25` | `SNX_ORB_50` |
| `levelRound` (premium) | **100** (hardcoded inline, no variable) | 25 | 50 |
| re-entry SL rounding | 100 | `roundStep` = 25 | `roundStep` = 50 |
| `offsetMode` | `abs`, `offset = 11` Rs | `pctOfClose`, `offsetPct = 0.01` | `pctOfClose`, `0.01` |
| re-entry SL cushion | `offset` (11, static) | `px * 0.01` (live price) | `px * 0.01` |
| `lotSize` | 20 | 20 | 20 |
| `maxLossPerSide` | 20 000 | 20 000 | 20 000 |
| `indexToken` | 265 | 265 | 265 |
| LOC | 376 | 387 | 387 |

`snx-orb-25` vs `snx-orb-50`: **3 differing lines** (tag, `roundStep`, a comment).
`snx-orb-25` vs `snx-orb-1`: 22 lines, all the abs-vs-pct offset and the `roundStep`
parameterisation of what `-1` hardcodes as `100`. `-1` is the ancestor; `-25`/`-50` are the
parameterised descendants. **A single class with `levelRound` + `offsetMode` regenerates all three.**

### C.3 Notes specific to C

* **Restart semantics are the reason this lineage survives.** `runStrategy()` is *not* called at
  module load — line 364 is `// runStrategy();` and init is a `CronJob('0 0 9 * * 1-5')`. Combined
  with `process.exit()` at 15:30, pm2's autorestart yields: exit 15:30 → pm2 respawns → the
  process idles overnight holding only cron timers → 09:00 cron re-inits → 09:31 sets the range.
  A crash or pm2 restart **during** market hours leaves the strategy permanently dead for that day
  (no catch-up path). Preserve the intent (daily self-init) but the rewrite MUST add catch-up:
  if the runner starts after 09:31 and before 15:20, run `setupRange()` immediately.
* **`ceQty`/`peQty` computed in `setupRange` are dead** — sizing at entry uses `calcQty()`. The
  `ceSlRange`/`peSlRange` block exists only for the log line.
* **`futureToken = 265` is the SENSEX *index* token**, hardcoded, not `optionData.currentFuture`.
  `265` is subscribed and used only for the history call, never for a strike computation at tick
  time. There is no SENSEX future leg despite the variable name.
* **A CE-BUY and a CE-SELL can be open simultaneously** on the *same* instrument (they are
  independent flags). The book nets to flat while `positions` holds two rows with opposite stops,
  and whichever stop fires first sends a real order that *doubles* exposure in the other
  direction. This is a live behaviour, not obviously intended — flag it to the owner before
  "fixing" it, but the rewrite should make same-instrument opposing entries an explicit config
  choice (`allowOpposingEntries: boolean`).
* `placeAllAccount`'s tranching only special-cases `BANKNIFTY`/`NIFTY` symbol prefixes
  (`maxQty` 60/36); SENSEX falls through to `maxQty = 100` **lots**, so a large risk-based size is
  effectively never tranched on the Zerodha rail. The XTS rail (`xtsOrder.js`) uses its own
  `maxOrderLots[index_name]` table.

---

## D. `calendar-atm-oneshot`

**Members:** `cal-ce.js`, `cal-pe.js` (differ by **3 lines**: tag + `'CE'`→`'PE'` twice)

**One line:** at 09:25 exactly once, BUY the near-week ATM option and SELL the next-week ATM
option of the same type and same strike, using the current-month **future** price for the ATM.
Then nothing — no target, no stop, no EOD, no rollover, ever.

```
config = { underlying: BANKNIFTY (optionConfig() default),
           optType: 'CE' | 'PE', strikeStep: 100, fireCron: '09:25:00 Mon-Fri' }

boot: chain     = optionData.weeklyInstruments
      nextChain = optionData.nextWeekInstruments
      futureToken = optionData.currentFuture.token
      subscribe([futureToken])            # ONLY the future — option tokens are NOT subscribed
      cron('0 25 9 * * 1-5') → takeTrade

takeTrade():
  q = tick(futureToken)
  if !q?.last_price: return              # silently skipped forever, no retry
  atm = round(q.last_price / 100) * 100
  PaperTrade.trackOrder(chain[atm+optType],     'BUY',  tag)    # near week
  PaperTrade.trackOrder(nextChain[atm+optType], 'SELL', tag)    # next week
```

Notes:

* `nextExpiryOptions` is assigned without a declaration → an **implicit global**.
* `getAccounts()` is defined but never called; `runStrategy()`'s call site is commented out at
  line 68. Rail is therefore the bus only, via `PaperTrade.trackOrder` (v1: `status: "COMPLETE"`,
  `order_type: "MARKET"`, **no `average_price`** — `paperstream.js` stamps the fill price from its
  own tick cache; a real broker daemon fills it live if any account has the tag enabled).
* `getOptionPrice()` is dead.
* Because option tokens are not subscribed, this strategy cannot ever know its own P&L. The
  rewrite must subscribe the two legs so the position is markable, even if the entry logic is
  unchanged.
* **This is a short-calendar (short vega/theta on the back month, long the front).** Selling the
  *later* expiry and buying the *nearer* one is the unusual direction. Confirm intent with the
  owner before porting — but port it as written.

---

## E. `fut-stop-and-reverse`

**Member:** `fut-100.js` (only). The one file in this family that is **event-driven off broker
fills**, not off ticks.

**One line:** wait for the first ±15-point move of the BANKNIFTY future away from a base price
captured 10 s after boot, take 1 lot in that direction, then bracket it with a **2× stop and a 2×
limit target** so that whichever fills flips the position to 1 lot the other way — and immediately
re-bracket at 2× again, forever, with no EOD, no daily loss cap, and no process exit.

### E.1 Full event contract

```
config = { underlying: BANKNIFTY (optionConfig() default),
           lotSize: 30 (HARDCODED, not from optionConfig),
           triggerLevel: 15, slPoints: 50, targetPoints: 100,
           reverseMultiplier: 2, xtsAccountId: '65f7c2f15401da14d2bc7bbe' (HARDCODED),
           rearmDelayMs: 3000 }

boot:
  currentFuture = { instrument_token: optionData.currentFuture.token,
                    tradingsymbol:   optionData.currentFuture.symbol,
                    lot_size: 30 }
  subscribe([futureToken])
  after 10 s: basePrice = tick(futureToken).last_price

on tick:
  if basePrice == 0: basePrice = tick.last_price     # fallback
  move = tick.last_price - basePrice
  if isFirstTrade and move >= +triggerLevel:  fire('BUY');  isFirstTrade = false
  if isFirstTrade and move <= -triggerLevel:  fire('SELL'); isFirstTrade = false

fire(side):
  id = nextEventId()
  eventTrigger[id] = { side, instrument_token, action: 'place_sl_target' }
  PaperTrade.trackOrder_v2(currentFuture, side, tag, 1, [id])     # MARKET, qty = 30*1
```

**The fill loop.** `trackOrder_v2` writes a `paper-trade` doc with `dataObj: [id]`.
`server/tools/xtsOrder.js` picks it off the change stream and places it at XTS with
`orderUniqueIdentifier = [tag, ...dataObj].join('|')`.
`server/tools/smp_order_listener.js` receives the XTS interactive WS `onOrder` callback and, for
`FILLED`/`REJECTED` identifiers containing `|`, inserts an `OrderUpdate` doc:

```
{ updateType: 'order', strategy: <tag>, params: <dataObj as STRINGS>,
  status: <raw OrderStatus, e.g. 'Filled'>, price: <OrderAverageTradedPrice>, ...rawOrderData }
```

`fut-100` watches the `OrderUpdate` collection change stream itself and dispatches on
`eventTrigger[params[0]].action`:

```
'place_sl_target' + status=='Filled':
      price = parseInt(update.price.replace(/,/g,''))
      placeTargetStoploss(side, price);  eventTrigger[id] = false

'sl_hit' | 'target_hit' + status=='Filled':
      cancelPendingOrder()                                  # XtsAccount.removePending(xtsAccountId, tag)
      setTimeout(3000, () => placeTargetStoploss(side, parseInt(update.price.replace(/,/g,''))))
      executeSL(id, instrument_token, update.price)         # stamp the paper-trade doc COMPLETE
      eventTrigger[id] = false; eventTrigger[oppositeId] = false

placeTargetStoploss(side, price):
      exitSide = opposite(side)
      stop   = side=='BUY' ? price - slPoints     : price + slPoints
      target = side=='BUY' ? price + targetPoints : price - targetPoints
      slId = nextEventId(); tgId = nextEventId()
      eventTrigger[slId] = { action:'sl_hit',     oppositeOrderId: tgId, side: exitSide, stopPrice: stop }
      eventTrigger[tgId] = { action:'target_hit', oppositeOrderId: slId, side: exitSide, targetPrice: target }
      PaperTrade.trackOrder_slm  (currentFuture, exitSide, tag, 2, stop,   [slId])   # StopMarket
      PaperTrade.trackOrder_limit(currentFuture, exitSide, tag, 2, target, [tgId])   # Limit

executeSL(id, token, price):
      trade = PaperTrade.findOne({ tag, dataObj: [parseInt(id)], instrument_token: token })
      trade.status='COMPLETE'; trade.order_type='MARKET'
      trade.order_timestamp=now; trade.average_price=parseFloat(price); save()
```

**Why 2× works.** Entry is 1 lot. Both bracket legs are `multiplier = 2` (60 units at
`lot_size = 30`). Whichever fills takes you from +1 to −1 (or −1 to +1), and the new bracket is
again 2× against the new 1-lot position. The invariant `|net| == 1 lot` holds as long as exactly
one bracket leg ever fills and the other is successfully cancelled.

**`trackOrder_slm` is a StopMarket that `xtsOrder.js:150-166` rewrites to a StopLimit**:
`limitPrice = round(stop * 1.01)` for BUY / `round(stop * 0.99)` for SELL when `stop > 1000`
(BANKNIFTY futures always are). Preserve this ±1% slippage envelope — it is a real fill
characteristic, not an implementation detail.

---

## F. `external-signal-mirror` — **not a strategy**

**Members:** `candlestrategy.js`, `candlestrategy-a006.js`, `candlestrategy-test3.js`
(differ by **3 lines**: username, password, destination tag)

```
config = { baseUrl: 'https://optionbhai.com', socketUrl: 'wss://optionbhai.com',
           username, password, destinationTag }

init():
  if wsClient is OPEN or CONNECTING: return                       # re-entrancy guard
  token = POST /auth/login {username, password} → data.token
  ALL_INSTRUMENTS = GET /api/instruments (Bearer token)
                    → index by tradingsymbol → {tradingsymbol, instrument_token, lot_size}
  connectWebSocket(token):
      tear down any old client (removeAllListeners, close if OPEN)
      ws = connect(socketUrl + '/ws?token=' + token)
      on message:
         if type == 'ORDER_EXECUTION' and payload.status == 'EXECUTED':
             PaperTrade.trackOrder(ALL_INSTRUMENTS[payload.symbol], payload.side, destinationTag)
      on close: wsClient = null; setTimeout(init, 5000)            # full re-login on reconnect
  on token failure: setTimeout(init, 5000)
```

| File | `username` | `password` | destination tag |
|---|---|---|---|
| `candlestrategy.js` | `LIVE001` | `UNW3v5Q5Xf9Pj2Y` | `1PBUY` |
| `candlestrategy-a006.js` | `LIVE002` | `UNW3v5Q5Xf9Pj2Y` | `A006` |
| `candlestrategy-test3.js` | `test3` | `Live@987` | `EMA2050` |

Notes:

* **Plaintext credentials committed to the repo.** Rotate them and move to env/secret store as
  part of the port. This is the highest-severity finding in the family.
* Every mirrored order is a **market order at local price**, including the remote system's exits.
  Local fills therefore diverge from the source's fills — there is no reconciliation.
* `ALL_INSTRUMENTS[payload.symbol]` may be `undefined` if the remote trades a symbol not in the
  instruments snapshot (which is fetched **once per connection**). `PaperTrade.trackOrder(undefined, …)`
  then throws on `optionInstrument.tradingsymbol` inside an unguarded async function → unhandled
  rejection. The instrument map must be refreshed and the lookup guarded.
* `optionConfig` is required and never used.
* This belongs in the target architecture as a **SignalSource adapter feeding the order bus**, not
  as a `Strategy`. It has no entry/exit logic of its own.

---

## PRESERVE — behaviours that must survive the rewrite

1. **Clear the position flag *before* the first `await`.** In A and B (`optionOrders = false` /
   `state.position = null` on the line before the buy-back) and in C (`positions.splice(idx,1)`
   before `placeAllAccount`) this is the *only* thing preventing a double exit, because entry and
   exit run on two **separate** `async.queue(…, 1)` instances that interleave freely at every
   await. Reproduce with an explicit compare-and-set or a single serialised queue per strategy.
2. **`gridStep` is independent of `strikeStep`** (dolphin: 200 vs 100). Two config axes.
3. **`dolphin`'s roll closes the old pair and opens the new one in the same evaluation pass**,
   with the buy-back keyed off a *copy* of the old position (`tmpOrder`) taken before the flag
   clear. Order of wire messages: BUY old CE → BUY old PE → SELL new CE → SELL new PE.
4. **`lastQuote` is updated on *every* crossover evaluation**, including passes that do not trade
   and passes where `level` is `undefined`. Move it and the crossover test becomes a different
   strategy.
5. **`target-15`'s target is recomputed every tick** from the stored entry premiums, is expressed
   as a *per-leg absolute* drop equal to 1.5 % of the *combined* premium, and firing on **either**
   leg exits **both**.
6. **`target-15`'s 9 s reload delay** (not the documented 3 s), and its `isPositionActive` guard as
   the sole re-entrancy protection.
7. **`fox-1`'s closing order is registered as the next position** (short → flat-tracked-as-long →
   short at a *fresh* ATM), and `positions.push` happens **outside** the order-placement guard.
8. **`fox-1`'s `maxOrderCount = 6` counts exits as well as entries.**
9. **`snx-orb`'s four independent one-shot flags**, never reset; `firstTradeDone[side]` switching
   the stop basis from "opposite trigger" to "day extreme ± cushion"; the SENSEX **strike grid is
   always 100** regardless of `levelRound`, which applies only to *premium* rounding.
10. **`snx-orb`'s daily lifecycle**: 09:00 init cron (no module-load call), 09:31 range, 15:20
    flatten, 15:30 `process.exit()` + pm2 respawn. Preserve daily self-init; **add** the missing
    mid-day catch-up.
11. **`snx-orb`'s `setupRange` retries only the *index* history fetch** (30 s, unbounded); missing
    *option* history or a missing instrument key aborts the day silently.
12. **`snx-orb`'s risk sizing rounds down to whole lots with a 1-lot floor**, and `placeAllAccount`
    is called with **lots** (`qty / lotSize`) while `positions[].qty` is in **units**.
13. **`fut-100`'s bracket multiplier of 2** is what makes it a reverse rather than an exit; the
    3 s delay before re-bracketing; `cancelPendingOrder()` before, not after, the re-arm.
14. **`fut-100`'s `StopMarket` → `StopLimit` ±1 %** conversion in `xtsOrder.js`.
15. **`fut-100`'s `dataObj` round trip**: number in `paper-trade` → `tag|id` string in
    `orderUniqueIdentifier` → string in `OrderUpdate.params` → `parseInt` again in `executeSL`'s
    `where`. Any change to either end breaks fill attribution silently.
16. **Bus-first ordering in `placeAllAccount`**: the `trackOrder` bus insert happens *before* the
    Zerodha loop, so the bus record exists even if every broker leg fails. Downstream daemons
    depend on this.
17. **Expiry rollover is a weekday literal**: dolphin/nifty-s switch to `nextWeekInstruments` on
    `moment().day() == 3 || 4`; fox-1 on `== 3`; snx-orb/target-15/cal-* never. These encode the
    2021-2023 BANKNIFTY Thursday-then-Wednesday expiry regime and are **wrong for today's
    calendar**. The rewrite must derive the roll from `optionData.weeklyExpiry` + a
    days-to-expiry threshold, and this is a genuine behaviour change to be signed off.
18. **Tick-availability preconditions.** `target-15` and `cal-*` guard (`if (!bn_quote) return`);
    `dolphin`/`nifty-s`/`fox-1`/`fut-100` do **not** — they read `ticksCache[token].last_price`
    inside a warm-up `setTimeout` and throw if the feed is late. Keep the guard; make the
    warm-up a real "wait until N tokens have ticked" precondition.
19. **`optionConfig`'s on-disk cache is trusted blindly** (`require('optionConfig_<UND>.json')`).
    Every strategy here inherits that. Add a freshness assertion.
20. **A central `XtsAccount.squareOff` can flatten these positions behind the strategy's back**
    (`smp_target.js:124`). The rewrite needs a position-reconciliation hook so a strategy can
    discover it is flat.

---

## RISKS — bugs, dead code, dangerous behaviour

### Money-losing / unbounded risk

1. **No stop loss anywhere in idea A** (`dolphin-0020`, `nifty-s-1789`, `nifty-s-sbm95`,
   `target-15`). Four naked short-premium strategies whose only exit is a profit target. A gap
   is unbounded loss.
2. **`dolphin`'s only kill-switch is dead code** — `// checkPNL();` at
   `dolphin-0020.js:156`. The `total_m2m > 10000` flatten, the `notify()` and the
   `PaperTrade.positions()` reconciliation never run.
3. **No EOD square-off in A, B, or E.** `dolphin`, `nifty-s-*`, `fox-1`, `target-15`, `fut-100`
   have no 15:20/15:30 cron (target-15's is commented out at lines 250-260). Positions carry
   **overnight**, and on process restart the in-memory position is lost → permanently orphaned
   legs that no code will ever close.
4. **`fut-100` runs forever with no daily loss cap and no EOD flat**, reversing 1 lot of BANKNIFTY
   futures indefinitely. A choppy session pays 50-point stops repeatedly with no circuit breaker.
5. **`fut-100` stalls on a rejected bracket leg.** The change-stream handler only acts on
   `status == 'Filled'`; `smp_order_listener` also emits `REJECTED`. A rejected SL leaves an open,
   **unprotected** futures position and an `eventTrigger` entry that will never clear.
6. **`fox-1`'s order cap creates orphan positions.** Once `placedCount == 6`, `sendOrder` still
   pushes a tracked position but places nothing. The tracker then flips phantom positions forever
   while the real book is whatever the 6th order left. In the common path the 6th is a closing
   BUY (net flat), but nothing enforces that.
7. **`snx-orb` can hold a BUY and a SELL of the same instrument simultaneously** (independent
   one-shot flags). The book nets flat but each row carries its own stop; the first stop to fire
   sends a real order that *doubles* exposure the other way.

### Correctness bugs

8. **`fut-100`'s hardcoded `lot_size: 30`.** Every bus order's quantity is `30 * multiplier`
   regardless of the actual BANKNIFTY futures lot size (15 pre-2024, 35 from Nov 2024). Wrong
   size on every order; `optionConfig` already carries the right value.
9. **`fut-100`'s hardcoded XTS account id `'65f7c2f15401da14d2bc7bbe'`** in `cancelPendingOrder()`.
   If the strategy is enabled on a second XTS account, that account's stale bracket leg is never
   cancelled → runaway double position.
10. **`fut-100` truncates prices with `parseInt`** — `parseInt(update.price.replace(/,/g,''))`
    for the fill, `parseInt()` on the computed stop and target. Sub-rupee precision is discarded.
11. **`fut-100` assumes `update.price` is a comma-formatted string.** `smp_order_listener` copies
    `OrderAverageTradedPrice` straight through; if XTS sends a number, `.replace` throws (caught,
    turned into a `notify`) and the reverse leg is never placed.
12. **`fut-100` never cancels the losing bracket leg at the bus level.** `eventTrigger[oppositeId]
    = false` only clears the local map; the sibling `paper-trade` doc stays `Pending` forever, and
    cancellation relies entirely on `XtsAccount.removePending` succeeding at the broker.
13. **`fox-1` uses `delete positions[idx]` on an array**, leaving holes and growing `length`
    without bound. `forEach` skips holes so it works, but the array is a memory leak and the
    `async` callback's `return false` values are silently discarded.
14. **`dolphin`/`nifty-s` never validate the instrument key.** `currentExpiryOptions[level+'CE']`
    can be `undefined` when the ladder walks past the chain's strike range; then
    `ticksCache[ce_option.instrument_token]` throws (`placeTrade` line 209). `placeAllAccount`
    swallows an undefined instrument silently — so a roll can BUY back only *one* leg and leave
    the other short.
15. **`cal-*`'s `nextExpiryOptions` is an implicit global** (no declaration).
16. **`cal-*` subscribes only the future token**, so the two legs it trades are unmarkable and its
    own P&L is unknowable in-process. If the 09:25 tick has not arrived, the whole day is skipped
    silently with no retry and no alert.
17. **`snx-orb-1` hardcodes premium rounding to `100`** in four places where `-25`/`-50` use
    `roundStep`. Fine as a config value, but it means `-1` cannot be reproduced by
    parameterising `-25` unless `levelRound = 100` is allowed.
18. **`loadAccounts` key mismatch** (`elm.name` vs `credentials.user_id`) can silently drop the
    live leg of `snx-orb` while the bus leg still fires — a *partial* fill of the intended trade.

### Security

19. **Plaintext credentials committed** in all three `candlestrategy*.js` files
    (`LIVE001/UNW3v5Q5Xf9Pj2Y`, `LIVE002/…`, `test3/Live@987`). Rotate before anything else.

### Dead code to drop, not port

20. `dolphin-0020`: `checkPNL()`, `fetchPositions()`, `positions`, `ATM_Strike`, `positionsOpen`,
    `vixToken` subscription, `CronJob`/`notify`/`async`/`otmSelector` imports (`otmSelector` is
    imported but `farOtm` is a literal).
21. `nifty-s-*`: the whole `farOtm` variable (assigned twice, read never).
22. `fox-1`: `fetchPositions()`, `accounts`, `firstRun`, `fromDate`, `toDate`, `startTrade`
    (set true, never read), `CronJob`/`notify` imports.
23. `target-15`: `TARGET_POINTS = 3` literal, `setOTMDistance`, `setTargetPoints`,
    `setRestartDelay`, `module.exports` (the file is a pm2 entry point — nothing can import it),
    `getAccounts()` (defined, never called), `accounts`/`running_accounts`/`account_quantities`,
    the commented EOD cron.
24. `cal-*`: `getAccounts()` (defined, never called), `getOptionPrice()`, `ce_strike`/`pe_strike`,
    the commented `runStrategy` and `process.exit` crons.
25. `snx-orb-*`: `ceQty`/`peQty` and the `ceSlRange`/`peSlRange` computation in `setupRange`
    (superseded by `calcQty` at entry; kept only for a log line).
26. `candlestrategy*`: the `optionConfig` import.

---

## CONFIG AXES that regenerate all 14 files

| Axis | Type | Values observed in this family |
|---|---|---|
| `underlying` | enum | `BANKNIFTY` (dolphin, fox-1, cal-*, target-15, fut-100), `NIFTY` (nifty-s-*), `SENSEX` (snx-orb-*) |
| `atmSourceToken` | int / enum | index spot `260105` BN, `256265` NIFTY, `265` SENSEX; or `optionData.currentFuture.token` (target-15, cal-*, fut-100) |
| `strikeStep` | int | 100 (BANKNIFTY/SENSEX), 50 (NIFTY) |
| `gridStep` (crossover ladder) | int | 200 (dolphin), 50 (nifty-s), n/a elsewhere |
| `farOtm` / `OTM_DISTANCE` | int | 200 (dolphin), 0 (everything else — `otmSelector` always returns 0) |
| `entryTrigger` | enum | `gridCrossover` (A), `openVsLtpOneShot` (B), `premiumORB` (C), `cronOneShot` (D), `pointMoveFromBase` (E), `externalSignal` (F) |
| `reentryPolicy` | enum | `onNextCrossover` (dolphin/nifty-s), `fixedDelay 9000ms` (target-15), `onTrailingStopFlip` (fox-1), `oncePerSidePerDay + freshStop` (snx-orb), `never` (cal-*), `perpetualReverse` (fut-100) |
| `targetBasis` | enum | `combinedPoints` 70/25 · `perLegPctOfCombined` 1.5 % · `fixedPoints` 100 (fut-100) · `none` (fox-1, cal-*, snx-orb) |
| `stopBasis` | enum | `none` (A, D) · `trailingPoints` 60 (fox-1) · `oppositeTrigger`→`dayExtreme ± cushion` (snx-orb) · `fixedPoints` 50 (fut-100) |
| `sizing` | enum | `flat 1 lot` (A, B, fut-100 entry) · `riskBased maxLoss/side` 20 000 (snx-orb) · `reverseMultiplier 2` (fut-100 brackets) · `1 lot` (cal-*, mirror inherits remote size) |
| `premiumRoundStep` (`levelRound`) | int | 100 (snx-orb-1), 25 (snx-orb-25), 50 (snx-orb-50) |
| `breakoutOffsetMode` | enum | `abs` 11 Rs (snx-orb-1) · `pctOfRangeClose` 1 % (snx-orb-25/50) |
| `orderCap` | int/null | 6 (fox-1), null elsewhere |
| `schedule` | struct | module-load + warmup 5/10/25 s (A, B, E) · cron `09:25` one-shot (D) · cron `09:00` init + `09:31` range + `15:20` EOD + `15:30` exit (C) |
| `expiryRoll` | weekday set | `{Wed,Thu}` (dolphin, nifty-s), `{Wed}` (fox-1), `{}` (snx-orb, target-15), `{front + back pair}` (cal-*) |
| `executionRail` | enum | `bus` (A, D, F, E-entry) · `bus + zerodhaDirect` (C) · `bus + xtsEventLoop` (E) |
| `strategyTag` | string | `Dolphin-0020`, `Nifty_S_1789`, `Nifty_S_SBM95`, `TGT15`, `Fox-1`, `SNX_ORB_1/25/50`, `Cal_CE`, `Cal_PE`, `FUTURE-100`, `1PBUY`, `A006`, `EMA2050` |
| mirror `credentials` | secret | `LIVE001` / `LIVE002` / `test3` (move to secret store) |

---

## Cross-family dedup note

Idea **A**'s `gridCrossover` variant is the *same* core primitive as the `lion` / `bull` /
`eagle` / `stgl-mid` families: round the underlying to a strike, act on each crossing, sell a
CE+PE pair. `dolphin-0020` and `nifty-s-*` should almost certainly be **configs of the shared
`CrossoverStrangle` class** those families produce, with `targetBasis: 'combinedPoints'` and
`stopBasis: 'none'` — not a class of their own. `target-15` then becomes the same class with
`reentryPolicy: 'fixedDelay'` and `targetBasis: 'perLegPctOfCombined'`. Coordinate with the
`lion` family spec before creating a parallel implementation.

Genuinely new classes needed from this family: **C** (`PremiumOrb`, the only living lineage and
the only risk-sized one), **E** (`FuturesStopAndReverse`, the only fill-event-driven one),
**D** (`CalendarOneShot`, trivial), **B** (`TrailingFlipPair`, arguably not worth porting —
one file, dead since 2023, and its flip semantics are almost certainly a bug), and **F** which is
not a strategy at all but a signal-source adapter.
