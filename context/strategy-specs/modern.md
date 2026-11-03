# Family `modern` — canonical parameterized spec

**Scope:** 10 files, 1,445 LOC, committed 2026-07-03 → 2026-07-14. This is the newest and
cleanest code in `server/slive/`, the only part of the directory with a pure-logic/IO split and
unit tests. **It is the template for the TypeScript rewrite** — everything below is written so
the new `StrategyBase` + config records can be built without reopening the legacy files.

| File | Role | LOC |
|---|---|---|
| `server/slive/bn-breakout.js` | full engine, BANKNIFTY option-buy | 323 |
| `server/slive/atr-band-nifty.js` | full engine, NIFTY option-buy | 346 |
| `server/slive/atr-band-logic.js` | pure logic for the above | 69 |
| `server/slive/orb-scalp.js` | full engine, 3 indices in one process, option-buy | 319 |
| `server/slive/orb-scalp-logic.js` | pure logic for the above | 47 |
| `server/slive/orb-fut-core.js` | **factory** `module.exports = function startOrbFut(config)` | 247 |
| `server/slive/orb-fut-logic.js` | pure logic for the above | 73 |
| `server/slive/orb-fut-bn.js` | 7-line config wrapper | 7 |
| `server/slive/orb-fut-nifty.js` | 7-line config wrapper | 7 |
| `server/slive/orb-fut-snx.js` | 7-line config wrapper | 7 |

Tests: `server/test/atr-band-logic.test.js` (21 cases), `server/test/orb-fut-logic.test.js`
(13), `server/test/orb-scalp-logic.test.js` (16) — 50 in total. Runner: `npm test` →
`node --test 'server/test/*.test.js'`. The engines themselves are untested (no injectable feed).

---

## 1. The two distinct algorithms

There are **two** algorithms, not ten. They share one *signal core* and differ in the
*execution mapping* (what instrument the signal buys).

### Idea A — `band-break-option-buy`

> Establish a **reference band** on the underlying during the morning. When a completed 5-minute
> candle of the signal instrument **closes** beyond a band edge (optionally with colour /
> consecutive-candle confirmation), **BUY the ATM option** of the corresponding side
> (up-break → CE, down-break → PE) in the nearest expiry. Manage with a premium target, a
> wall-clock time stop, and an *underlying-level* stop at the **opposite** band edge. Flat by
> 15:15. Small per-day trade budget.

Members: `bn-breakout.js`, `atr-band-nifty.js` + `atr-band-logic.js`,
`orb-scalp.js` + `orb-scalp-logic.js`.

The three engines differ ONLY in: band source, confirmation strictness, stop trigger basis
(tick vs candle-close), target formula, time-stop length, day budget, range filter, and the
number of underlyings hosted per process. All of those are config, not code.

### Idea B — `orb-future-breakout`

> Establish the **09:15–09:45 opening range from the current-month FUTURE's own 5-minute
> candles**. When a later completed candle **closes** beyond `rangeHigh × (1+buffer)` /
> `rangeLow × (1−buffer)`, take a **directional position in the future itself** (BUY on the
> up-break, SELL on the down-break). SL = the opposite ORB end; single target
> `fill ± 1 × range`. Whole position exits on the first trigger. One trade/day. Flat by 15:15.

Members: `orb-fut-core.js` + `orb-fut-logic.js`, driven by `orb-fut-bn.js`,
`orb-fut-nifty.js`, `orb-fut-snx.js`.

### Why they are two and not one

The signal is identical in shape (`referenceBand → confirmedCloseBreak → side`). What differs
materially:

| | Idea A | Idea B |
|---|---|---|
| Signal instrument | spot index | current-month future |
| Traded instrument | ATM option of the side | the future itself |
| Payoff | long premium, convex, decays | linear, symmetric |
| Target basis | premium points / % | range multiple on the traded instrument |
| Stop measured on | the **underlying** (spot), not the traded option | the **traded instrument** |
| Direction of a down-break | BUY a PE (still a long) | SELL the future (a short) |
| Time stop | yes (60/90 min) | none |

**Rewrite guidance:** implement ONE `BandBreakSignal` module (pure) and ONE `StrategyBase`
lifecycle, then two thin `ExecutionMapping` strategies — `AtmOptionBuyMapping` and
`DirectionalInstrumentMapping`. All ten files collapse to 2 classes + 6 config records
(BN/NIFTY/SNX × option-scalp, BN/NIFTY/SNX × future) plus 2 bespoke configs
(`bn-breakout`, `atr-band-nifty`).

---

## 2. Canonical anatomy (the thing `StrategyBase` must generalise)

Line refs are `bn-breakout.js` unless marked. This ordering is identical in all four engines
and is the house style to preserve.

| # | Section | `bn-breakout.js` | `orb-fut-core.js` | `atr-band-nifty.js` | `orb-scalp.js` |
|---|---|---|---|---|---|
| 1 | Header comment: the rule in prose + explicit *paper-only / no `placeAllAccount`* disclosure | 1–13 | 1–9 | 1–12 | 1–13 |
| 2 | Requires: `cron`, `../server.js`, `lib/zerodha`, `lib/KiteTicker`, `tools/optionInstruments`, `lib/notify`, `async`, `moment`, `./*-logic` | 15–25 | 11–22 | 14–25 | 15–27 |
| 3 | Config: named module constants — **or** the `startOrbFut(config)` factory with `config.x \|\| default` | 27–34 | **24–29** | 27–37 | 30–36 (`CONFIGS[]`) |
| 4 | State: `zapi`, `public_token`, chain/instrument, band vars, ready flags, used/traded flags, `entryClosed`, `started`, single `position` object, `ticksCache` | 36–46 | 31–39 | 39–48 | 38–53 (`freshState()` per index) |
| 5 | `zerodha_init(account)` — **read-only** login; stamps `account.lastLogin`, `account.config`, captures `public_token`, `account.save()` | 49–59 | 41–51 | 51–61 | 56–66 |
| 6 | `ticker(subs)` — new `kiteTicker({api_key:'kitefront', access_token: public_token})`, `connect()`, `on('ticks', checkTicks)`, `on('connect')` → `subscribe(subs)` + `setMode(modeFull, subs)` | 62–74 | 53–63 | 63–73 | 68–78 |
| 7 | `istMinutes()` — `moment().utcOffset(330)` → `h*60+m` | 76–79 | 65–68 | 75–78 | 80–83 |
| 8 | `runStrategy()` — **idempotent** (`if (started) return; started = true`), resets all daily state, loads the instrument chain, logs in, subscribes; on error resets `started = false` so a retry can happen | 81–107 | 70–94 | 80–104 | 85–107 |
| 9 | Phase-setup fn(s), cron-triggered, guarded by their own ready flag, **self-retrying via `setTimeout(fn, 30000)`** on missing data or exception | 110–132 | 97–122 | 107–132 (width), 135–164 (lines) | 110–142 |
| 10 | `checkTicks(ticks)` — reduce array → `{token: tick}`, `Object.assign(ticksCache, …)`, then call `checkExits()` **synchronously** if a position is ACTIVE | 134–142 | 124–128 | 166–170 | 144–151 |
| 11 | 5-minute cron poller → `historyData` → evaluate the last candle → `enterPosition(side)` | 145–166 | 131–147 | 184–215 | 154–173 |
| 12 | `async.queue(fn, 1)` wrapper around #11 so overlapping `historyData` calls cannot race | 288–290 | 212–214 | 309–311 | 287–289 |
| 13 | `findOption(strike, type)` — ATM with nearest-listed-strike fallback, deltas `[0, +s, −s, +2s, −2s]` | 169–176 | n/a | 173–180 | 176–183 |
| 14 | `enterPosition(side)` — re-check guards, **require a live tick for both spot and the option**, place the order, **flip the used/traded flag only AFTER the order**, build `position`, arm the time-stop `setTimeout`, log + `notify` | 178–225 | 149–170 | 217–263 | 185–233 |
| 15 | `checkExits()` — pure, synchronous, reads only `ticksCache`; delegates the decision to the `*-logic` module where one exists | 227–242 | 186–195 | 265–271 | 235–244 |
| 16 | `closePosition(reason)` — set `position.status = 'CLOSING'` **synchronously before any `await`** (re-entrancy guard), `clearTimeout(timeStopTimer)`, place the reverse order, `status='CLOSED'`, log P&L + notify, then release the slot | 244–278 | 173–195 (`executeActions` + `busy`) | 273–299 | 246–269 |
| 17 | `eodExit()` — 15:15 safety square-off, only if ACTIVE | 280–285 | 197–209 | 301–306 | 271–279 |
| 18 | Cron block, IST `Asia/Kolkata`, `1-5` weekdays, ending in `process.exit()` at 15:30 (+3 s grace) because pm2 restarts fresh each morning | 292–304 | 216–227 | 313–326 | 291–299 |
| 19 | `bootstrap()` — runs **unconditionally on module load**; `await runStrategy()`, then **time-gated phase catch-up** for a mid-session restart, inside the window `540 ≤ mins < 930` and `day ∈ 1..5` | 309–320 | 232–243 | 331–343 | 304–315 |
| 20 | A final `console.log` echoing the effective config | 322–323 | 245–246 | 345–346 | 317–319 |

### Cron schedules, exactly as written

`new CronJob(spec, fn, null, true, 'Asia/Kolkata')`, 6-field spec = `s m h dom mon dow`.

| Job | `bn-breakout` | `atr-band-nifty` | `orb-fut-core` / `orb-scalp` |
|---|---|---|---|
| band/width phase | `0 21 9 * * 1-5` (09:21:00) | `20 15 10 * * 1-5` (10:15:20) width; `20 40 11 * * 1-5` (11:40:20) lines | `20 45 9 * * 1-5` (09:45:20) |
| poller | `10 */5 9-13 * * 1-5` → fires at **HH:MM:10 for MM∈{0,5,…,55}, HH∈9..13** (i.e. 09:00:10 … 13:55:10) | `10 */5 11-15 * * 1-5` (11:00:10 … 15:55:10) | `10 */5 9-13 * * 1-5` **plus** `10 0 14 * * 1-5` (14:00:10 last check) |
| entry deadline | `0 31 13 * * 1-5` (13:31:00) | `0 15 14 * * 1-5` (14:15:00) | `30 0 14 * * 1-5` (14:00:30) |
| EOD square-off | `0 15 15 * * 1-5` (15:15:00) | same | same |
| process exit | `0 30 15 * * 1-5` + `setTimeout(process.exit, 3000)` | same | same |

Deadline crons are deliberately placed **after** the last poller tick of the window
(13:30:10 < 13:31:00; 14:00:10 < 14:00:30), so the final scheduled check is still allowed to
trade. Preserve that ordering.

### `bootstrap()` catch-up thresholds (IST minutes since midnight)

Window for all four: `day >= 1 && day <= 5 && mins >= 540 && mins < 930` (09:00–15:30).

| Engine | Replays |
|---|---|
| `bn-breakout` | `mins ≥ 561` (09:21) → `computeLines()`; `mins ≥ 811` (13:31) → `entryClosed = true` |
| `atr-band-nifty` | `≥ 615` (10:15) → `computeWidth()`; `≥ 700` (11:40) → `computeLines()`; `≥ 855` (14:15) → `entryClosed = true` |
| `orb-fut-core` | `≥ 586` (09:46) → `setupRange()`; `≥ 840` (14:00) → `entryClosed = true` |
| `orb-scalp` | `≥ 586` (09:46) → `setupRange()`; `≥ 840` (14:00) → `closeEntries()` |

---

## 3. Idea A — precise pseudocode

```
CONFIG (Idea A)
  tag                  : string                      # PaperTrade.tag
  underlying           : 'NIFTY' | 'BANKNIFTY' | 'SENSEX'
  spotToken            : 256265 | 260105 | 265
  strikeStep           : 50 | 100
  chainSource          : 'cached' | 'download'       # optionConfig() vs optionConfig.download()
  band                 : BandSpec                    # see below
  confirmCandles       : 1 | 2
  requireColourMatch   : bool
  rangeFilterPts       : number                      # 0 = disabled
  target               : {kind:'pts', pts} | {kind:'minPtsOrPct', pts, pct}
  timeStopMin          : number
  stopBasis            : 'tick' | 'candleClose'      # how the opposite-edge stop is sampled
  dayBudget            : {perSide:1, stopDayOnNonLoss:bool} | {perDay:1}
  lots                 : number
  sched                : {bandAt, pollCron, entryDeadline, eodAt, exitAt}

BandSpec variants
  A1 firstCandlePct  : {tf:'5minute', anchorIndex:0 /*09:15-09:20*/, pct}
        base = anchor.close ;  high = base*(1+pct) ; low = base*(1-pct)
  A2 atrAnchor       : {atrTf:'60minute', atrPeriod:14, divisor:3,
                        anchorTf:'5minute', anchorTs:'11:35'}
        width = wilderATR(hourlyCandles, 14) / 3
        anchor = last 5-min candle whose ts ≤ anchorTs
        high = anchor.close + width ; low = anchor.close - width
  A3 openingRange    : {tf:'5minute', candles:6 /*09:15-09:45*/, bufferPct}
        high = max(c.high for first 6) ; low = min(c.low for first 6)
        range = high - low
        breakLevels: up = high*(1+bufferPct) ; down = low*(1-bufferPct)
        (A1/A2 break directly at high/low, buffer = 0)
```

```
STATE (per underlying instance)
  chain            : map "<strike><CE|PE>" -> instrument   # nearest expiry
  high, low, width, range, base
  bandReady, dayBlocked
  used             : {CE:bool, PE:bool}        # or tradedToday for perDay budgets
  stopForDay       : bool
  entryClosed      : bool
  position         : null | {
      side ('CE'|'PE'), instrument, entryPremium, target,
      slSpot,                    # only for stopBasis='tick'
      entryTime, status ('ACTIVE'|'CLOSING'|'CLOSED'),
      timeStopTimer }
  ticksCache       : map token -> tick
```

```
INIT (once per process, on load)
  runStrategy():
     if started: return ;  started = true
     reset all daily state
     try:
        chainData = chainSource == 'download' ? optionConfig.download(underlying)
                                              : optionConfig(underlying)
        chain      = chainData.weeklyInstruments        # NEAREST expiry
        expiry     = chainData.weeklyExpiry
        acc        = Account.findById(app.get('masterId'))
        zapi       = zerodha_init(acc)                  # READ-ONLY login
        ticker([spotToken, ...all chain tokens].filter(truthy))   # modeFull
     catch: started = false ; log

BAND PHASE  (cron sched.bandAt; also replayed by bootstrap)
  if bandReady or dayBlocked: return
  fetch candles per BandSpec via zapi.historyData(token, tf, today, today)
  if insufficient: log ; setTimeout(thisPhase, 30_000) ; return       # self-retry
  compute high/low (+ range)
  if rangeFilterPts and range < rangeFilterPts:
      dayBlocked = true ; notify('day blocked') ; return
  bandReady = true ; log the levels

ON TICK  (websocket 'ticks')
  merge ticks into ticksCache keyed by instrument_token
  if position and position.status == 'ACTIVE': checkExits()      # SYNCHRONOUS

POLLER  (cron sched.pollCron, pushed through async.queue concurrency 1)
  # --- in-position branch, only when stopBasis == 'candleClose' ---
  if not bandReady: return
  candles = zapi.historyData(spotToken,'5minute',today,today)
  if position and position.status == 'ACTIVE':
      last = LAST CLOSED candle            # see RISK-1
      if (side=='CE' and last.close < low) or (side=='PE' and last.close > high):
          closePosition('SL')
      return                               # never evaluate entry while in a position
  # --- entry branch ---
  if entryClosed or stopForDay or dayBlocked: return
  if candles.length < confirmCandles + (bandSource==openingRange ? 6 : 1): return
  window = last `confirmCandles` closed candles
  side = null
  if all(c.close > upLevel  for c in window) and (!requireColourMatch or all green): side='CE'
  if all(c.close < downLevel for c in window) and (!requireColourMatch or all red):   side='PE'
  if side and not used[side]: enterPosition(side)

enterPosition(side)
  if position or stopForDay or used[side]: return
  spotTick = ticksCache[spotToken]
  if spotTick?.last_price is not a number:  log ; return          # RETRY next candle
  strike = round(spotTick.last_price / strikeStep) * strikeStep
  inst   = findOption(strike, side)                               # deltas 0,+s,-s,+2s,-2s
  if not inst: log ; return
  optTick = ticksCache[inst.instrument_token]
  if optTick?.last_price is not a number: log ; return            # RETRY, do NOT burn the flag
  entryPremium = optTick.last_price

  await PaperTrade.trackOrder_v2(inst, 'BUY', tag, lots)
  used[side] = true                       # <<< ONLY AFTER THE ORDER

  position = { side, instrument: inst, entryPremium,
               target : target.kind=='pts' ? entryPremium + pts
                                           : min(entryPremium+pts, entryPremium*(1+pct)),
               slSpot : side=='CE' ? low : high,          # opposite edge, spot units
               entryTime: now, status:'ACTIVE',
               timeStopTimer: setTimeout(() => closePosition('TIME'), timeStopMin*60_000) }
  log + notify

checkExits()                               # pure, tick-driven, no awaits
  if !position or status != 'ACTIVE': return
  optLtp  = ticksCache[position.instrument.instrument_token]?.last_price
  spotLtp = ticksCache[spotToken]?.last_price
  if optLtp is number and optLtp >= position.target: closePosition('TARGET') ; return
  if stopBasis == 'tick' and spotLtp is number:
      if side=='CE' and spotLtp <  position.slSpot: closePosition('SL') ; return
      if side=='PE' and spotLtp >  position.slSpot: closePosition('SL') ; return
  # precedence per tick: TARGET before SL; strict inequality on the stop (== does not fire)

closePosition(reason)
  if !position or status != 'ACTIVE': return
  position.status = 'CLOSING'              # <<< SYNCHRONOUS, BEFORE ANY await
  try:
     clearTimeout(position.timeStopTimer)
     exitPrice = ticksCache[inst.token]?.last_price ?? position.entryPremium
     await PaperTrade.trackOrder_v2(inst, 'SELL', tag, lots)
     position.status = 'CLOSED'
     pnl = (exitPrice - entryPremium) * inst.lot_size * lots
     log + notify
     if dayBudget.stopDayOnNonLoss:
         if pnl >= 0: stopForDay = true                  # a win ends the day
         else if used[otherSide]: stopForDay = true       # both sides spent
     position = null                       # release the slot
  catch:
     position = null                       # MUST clear, else CLOSING wedges the day
     log

eodExit()   # 15:15
  if position?.status == 'ACTIVE': closePosition('EOD')

PROCESS EXIT  # 15:30 + 3s
```

### Idea A config table — every member

| Config field | `bn-breakout` (`BN_BREAKOUT`) | `atr-band-nifty` (`ATR_BAND_NIFTY`) | `orb-scalp` BN (`ORB_SCALP_BN`) | `orb-scalp` NIFTY (`ORB_SCALP_NIFTY`) | `orb-scalp` SNX (`ORB_SCALP_SNX`) |
|---|---|---|---|---|---|
| underlying | BANKNIFTY | NIFTY | BANKNIFTY | NIFTY | SENSEX |
| spotToken | 260105 | 256265 | 260105 | 256265 | 265 |
| strikeStep | 100 | 50 | 100 | 50 | 100 |
| chainSource | `optionConfig()` **cached** | `optionConfig()` **cached** | `.download()` | `.download()` | `.download()` |
| band | A1 `pct = 0.0009` (±0.09% off the 09:15–09:20 close) | A2 ATR-14 (60 min) / 3 around the 11:35–11:40 close | A3 6×5 min from 09:15, `bufferPct 0.001` | A3, `bufferPct 0.001` | A3, `bufferPct 0.001` |
| bandAt | 09:21:00 | 10:15:20 width + 11:40:20 lines | 09:45:20 | 09:45:20 | 09:45:20 |
| confirmCandles | 1 | **2 consecutive** | 1 | 1 | 1 |
| requireColourMatch | **yes** (green for CE, red for PE) | **yes** (both green / both red) | **no** | **no** | **no** |
| rangeFilterPts | – | – | **250** | 0 | 0 |
| target | `entry + 45` | `min(entry+20, entry×1.30)` | `entry + 40` | `entry + 20` | `entry + 25` |
| timeStopMin | 90 | 60 | 90 | 60 | 90 |
| stopBasis | **tick** on spot, opposite edge | **candleClose** on spot, far opposite edge | **tick** on spot, opposite ORB end | tick | tick |
| entryDeadline | 13:31 | 14:15 (stop keeps running after) | 14:00:30 | 14:00:30 | 14:00:30 |
| dayBudget | 1 per side; **a non-loss ends the day**; a loss leaves the other side open | 1 per side, independent | 1 per day per index | 1/day | 1/day |
| lots | 1 | 1 | 1 | 1 | 1 |
| process | own pm2 process | own pm2 process | **all three share one process**, isolated `states[underlying]` | ” | ” |
| pure-logic module | none (inline) | `atr-band-logic.js` | `orb-scalp-logic.js` + `orb-fut-logic.js` | ” | ” |

`atr-band-nifty` peculiarity to preserve: the 5-minute poller keeps running the **candle-close
stop after `entryClosed`** — `entryClosed` is checked *inside* `checkEntry` at line 201, after
the in-position branch returns (comment at `:182-183`). So the stop is live 11:40 → 15:30 while
entries only run 11:40 → 14:15.

### Pure logic contracts (Idea A)

`atr-band-logic.js`:
- `trueRange(high, low, prevClose)` = `max(h-l, |h-prevClose|, |l-prevClose|)`
- `wilderATR(candles, period=14)` → `null` if `candles.length < period`; `tr[0] = high-low`
  (no prev close), seed = SMA of the first `period` TRs, then Wilder smoothing
  `atr = (atr*(p-1) + tr[i]) / p`. Returns the last value.
- `bandWidth(atr, divisor=3)` = `atr/divisor`
- `lines(anchorClose, width)` = `{highLine: anchorClose+width, lowLine: anchorClose-width}`
- `candleColor(c)` → `'green' | 'red' | 'doji'` (doji when `close == open`, and a doji in the
  pair kills the signal)
- `entrySignal(last2, highLine, lowLine)` → `'CE' | 'PE' | null`; requires **both** candles the
  same colour **and** both closes strictly beyond the line
- `target(entryPremium, pts=20, pct=0.30)` = `min(entry+pts, entry*(1+pct))` — the +pts leg
  binds above ≈66.7 premium, the +pct leg below
- `stopHitOnClose(side, close, high, low)` → CE: `close < low`; PE: `close > high`

`orb-scalp-logic.js`:
- `atmStrike(spotLtp, step)` = `round(spotLtp/step)*step`
- `sideFromSignal(signal)` = `signal === 'BUY' ? 'CE' : 'PE'`
- `spotSl(side, rangeHigh, rangeLow)` = `side === 'CE' ? rangeLow : rangeHigh`
- `evaluateExit(position, optLtp, spotLtp, opts)` → `{exit, reason}`; precedence
  **forceExit(EOD) → TARGET → SL**; `NaN` prices are silently ignored (that leg cannot fire);
  a non-`ACTIVE` position never exits; the spot stop uses **strict** `<` / `>` so spot exactly
  at the SL does not fire.

---

## 4. Idea B — precise pseudocode

```
CONFIG (Idea B)  # exactly the 5 fields the wrappers pass
  strategyTag    : string
  underlying     : 'BANKNIFTY' | 'NIFTY' | 'SENSEX'
  rangeFilterPts : number     # 0/falsy = filter disabled
  lots           : number     # `config.lots || 2` — every wrapper passes 1
  bufferPct      : number     # `config.bufferPct || 0.001`

STATE
  futInstrument, futureToken
  rangeHigh, rangeLow, range
  linesReady, dayBlocked, tradedToday, entryClosed, started
  position : null | {side:'BUY'|'SELL', instrument, entry, sl, t1, lots, status}
  busy     : bool      # guards the order-emitting section
  ticksCache

INIT  runStrategy()
  if started: return ; started = true ; reset daily state
  data = optionConfig.download(underlying)          # ALWAYS fresh
  futureToken   = data.currentFuture.token
  futInstrument = data.futures.find(f => f.instrument_token === futureToken)
  if !futInstrument or !futureToken: dayBlocked = true ; return    # nothing tradeable today
  zapi = zerodha_init(Account.findById(app.get('masterId')))       # read-only
  ticker([futureToken])                                           # ONLY the future

RANGE PHASE  09:45:20   setupRange()
  if linesReady or dayBlocked: return
  candles = zapi.historyData(futureToken, '5minute', today, today)
  r = computeRange(candles, 6)              # first 6 candles = 09:15..09:45
  if !r: setTimeout(setupRange, 30_000) ; return
  rangeHigh, rangeLow, range = r
  if !passesFilter(range, rangeFilterPts): dayBlocked = true ; notify ; return
  linesReady = true

POLLER  09:00:10..13:55:10 + 14:00:10, via async.queue(1)   checkBreakout()
  if !linesReady or tradedToday or entryClosed or position or dayBlocked: return
  candles = historyData(futureToken,'5minute',today,today)
  if candles.length < 7: return                       # 6 range candles + >= 1
  c = candles[last]                                    # see RISK-1
  side = breakoutSide(c.close, rangeHigh, rangeLow, bufferPct)
         # 'BUY'  if c.close > rangeHigh*(1+bufferPct)
         # 'SELL' if c.close < rangeLow *(1-bufferPct)
  if side: enterPosition(side)

enterPosition(side)
  if position or tradedToday: return
  tick = ticksCache[futureToken]
  if tick?.last_price is not a number: log ; return   # RETRY next candle, flag not burned
  entry = tick.last_price
  await PaperTrade.trackOrder_v2(futInstrument, side, tag, lots)
  tradedToday = true                                  # <<< ONLY AFTER THE ORDER
  position = openPosition(side, futInstrument, entry, range, rangeHigh, rangeLow, lots)
        # BUY  -> sl = rangeLow , t1 = entry + range
        # SELL -> sl = rangeHigh, t1 = entry - range
  log + notify

ON TICK -> checkExits()
  if !position or status != 'ACTIVE' or busy: return
  ltp = ticksCache[futureToken]?.last_price ; if not a number: return
  result = evaluateExit(position, ltp)
  if result.actions.length == 0: return
  busy = true                                # <<< SYNCHRONOUS, before any await
  executeActions(result).finally(() => busy = false)

evaluateExit(position, price, opts)          # PURE reducer
  if !position or status != 'ACTIVE': return {actions:[], position}
  p = shallow copy ; opp = side=='BUY' ? 'SELL' : 'BUY' ; long = side=='BUY'
  if opts.forceExit: push {side:opp, lots:p.lots, reason:'EOD'} ; p.status='CLOSED' ; return
  slHit = long ? price <= sl : price >= sl        # NON-strict, SL wins ties
  if slHit: push {side:opp, lots, reason:'SL'} ; p.status='CLOSED' ; return
  t1Hit = long ? price >= t1 : price <= t1
  if t1Hit: push {side:opp, lots, reason:'T1'} ; p.status='CLOSED' ; return
  return {actions:[], position:p}
  # PRECEDENCE per call: forceExit -> SL -> T1, all against the SAME price

executeActions(result)
  for a in result.actions:
     await PaperTrade.trackOrder_v2(futInstrument, a.side, tag, a.lots)
     px = ticksCache[futureToken]?.last_price ?? position.entry
     log + notify
  position = result.position                 # adopt the reducer's next state

eodExit()   # 15:15
  if !position or status != 'ACTIVE': return
  if busy: setTimeout(eodExit, 1000) ; return        # WAIT for the tick path, don't double-send
  busy = true
  await executeActions(evaluateExit(position, 0, {forceExit:true}))
  busy = false
```

### Idea B config table

| File | `strategyTag` | `underlying` | `rangeFilterPts` | `lots` | `bufferPct` |
|---|---|---|---|---|---|
| `orb-fut-bn.js` | `ORB_FUT_BN` | BANKNIFTY | **250** | 1 | 0.001 |
| `orb-fut-nifty.js` | `ORB_FUT_NIFTY` | NIFTY | 0 | 1 | 0.001 |
| `orb-fut-snx.js` | `ORB_FUT_SNX` | SENSEX | 0 | 1 | 0.001 |

Defaults inside `orb-fut-core.js`: `rangeFilterPts = config.rangeFilterPts || 0`,
`lots = config.lots || 2`, `bufferPct = config.bufferPct || 0.001`. The `|| 2` default is
**dead** (no wrapper omits `lots`) and contradicts commit `89f8fe70` ("1 lot, single target");
do not carry it over.

`orb-fut-logic.js` also exports `computeLevels(side, entry, range, rangeHigh, rangeLow)`, used
only via `openPosition`. Its asymmetry is deliberate and load-bearing: **SL is an absolute
price level (the opposite ORB end) while T1 is measured from the fill**. On a breakout that
gaps well past the range edge this yields worse than 1:1 R:R — see RISK-9.

---

## 5. Shared infrastructure the family depends on

| Dependency | Contract |
|---|---|
| `PaperTrade.trackOrder_v2(instrument, 'BUY'\|'SELL', tag, multiplier)` | `common/models/paper-trade.js:43`. Inserts `{status:'COMPLETE', order_type:'MARKET', exchange:'NFO', tradingsymbol, instrument_token, transaction_type, quantity: lot_size*multiplier, filled_quantity: same, tag}` into `paper-trade`. **No price.** **`Papertrade.create()` is NOT awaited** inside — see RISK-3. |
| Fill stamping | `server/boot/paperstream.js:438-440` change-stream on `paper-trade` → `handleInsertEvent(PaperTrade, event, bidAsk = 4)` → `lib/fill-price.js resolveFill()`. When the tick has depth and the level-5 (`bidAsk=4`) opposite-side price is `> 50`, the fill uses **that depth price**, not the LTP; otherwise LTP; otherwise `0.05`. Also backfills `instrument_token` from a symbol map. |
| Chain / instruments | `server/tools/optionInstruments.js`. `module.exports = config(underlying)` reads the on-disk cache `optionConfig_<UND>.json` via `require()`, downloading only if it is missing. `module.exports.download(underlying)` always hits Sensibull (`api.sensibull.com/v1/instrument_details` + `/v1/instruments/<UND>`) and rewrites the cache file. Returns `{weeklyExpiry, weeklyInstruments (map "<strike><CE\|PE>"→inst), nextWeekInstruments, futures[], currentFuture{token,symbol,ltp}, monthlyExpiry, max_pain, ivp, ivTrend, options[]}`. **BANKNIFTY's "weekly" is actually its monthly** (nearest expiry). `paperstream.js` refreshes all three caches at 07:30 IST. |
| History | `zapi.historyData(token, interval, from, to)` → `server/lib/zerodha.js:146`. Returns `[{ts, open, high, low, close, vol, oi?}]` oldest→newest; `ts` is a Kite ISO string with offset, so `ts.substr(0,10)` = date and `ts.substr(11,5)` = `HH:mm` **of the candle's OPEN**. Rejects with the raw body when `body.data` is missing. |
| Feed | `server/lib/KiteTicker.js`, `api_key:'kitefront'`, `access_token = zapi.getAuthorization()` (the enctoken). `setMode(modeFull, subs)` so `depth` is present. Ticks are `[{instrument_token, last_price, depth:{buy[],sell[]}, …}]`. |
| Notify | `server/lib/notify.js` → Telegram `@SMPAlerts`, channel index `0`. Fire-and-forget, never rejects. |
| Login | `Account.findById(app.get('masterId'))` then `zerodha.login()`. Read-only: `Account.placeAllAccount` is **never** called anywhere in this family. |

**Execution rail: bus-routed, all ten files.** Every order is a `paper-trade` insert. Whether
it becomes a simulated fill or a real broker order depends on which daemons are running
(`boot/paperstream.js` = simulator; `tools/xtsOrder.js`, `sparkOrder.js`, `fyersOrder.js` = real).
None of these tags appears in any consumer whitelist in the repo, so today they are simulated —
but the code itself is rail-agnostic. `dump.pm2` is a stale 2023 snapshot and proves nothing
about what runs.

---

## 6. Behaviours that MUST survive the rewrite

**P1 — `status = 'CLOSING'` set synchronously before any `await`.**
`bn-breakout.js:246`, `atr-band-nifty.js:275`, `orb-scalp.js:249`. This is the entire
re-entrancy guard: `checkExits()` runs from the tick handler on every tick and the time-stop
timer can fire at any moment; both call `closePosition`, and both are filtered by
`status !== 'ACTIVE'`. Without the synchronous mutation, two concurrent `closePosition` calls
would each place a SELL. **In the TS version this must be a synchronous state transition, not
an `await`ed one.** The `busy` flag in `orb-fut-core.js:192` is the equivalent for the
multi-action reducer path (set before `executeActions`, cleared in both `then` and `catch`).

**P2 — `eodExit()` yields to an in-flight tick-driven exit.** `orb-fut-core.js:199`:
`if (busy) { setTimeout(eodExit, 1000); return; }`. Prevents a double square-off when 15:15
lands while a target exit is mid-flight.

**P3 — the used/traded flag flips only AFTER a successful order.**
`bn-breakout.js:202`, `atr-band-nifty.js:242`, `orb-scalp.js:210`, `orb-fut-core.js:159`.
Corollary, and the reason it matters: **a missing tick aborts the entry WITHOUT burning the
flag**, so the next 5-minute check retries. `bn-breakout.js:197`, `atr-band-nifty.js:237`,
`orb-scalp.js:205`, `orb-fut-core.js:155` all carry that comment explicitly.

**P4 — entry requires a live tick for every instrument it prices.** Idea A needs *both* a spot
tick (to pick the strike) and an option tick (to set `entryPremium`, hence `target`). Idea B
needs a future tick. `typeof x.last_price !== 'number'` — not truthiness, so a legitimate
`0` would pass the type check (and a missing key is caught by the `!tick` half).

**P5 — `async.queue(fn, 1)` around every `historyData`-driven evaluation.** The 5-minute cron
fires while the previous fetch may still be in flight; concurrency 1 makes the whole
fetch→decide→order sequence serial. Never replace it with a bare `setInterval(async …)`.

**P6 — phase functions are idempotent and self-retry.** Guarded by their own ready flag at the
top; on missing data or an exception they `setTimeout(self, 30000)` rather than giving up.
`bn-breakout.js:111,117,130`; `orb-fut-core.js:98,105,120`; `atr-band-nifty.js:111,121,130,
137,151,162`; `orb-scalp.js:114,141`.

**P7 — `bootstrap()` runs unconditionally on module load and replays already-due phases.**
Not gated on `require.main === module`. A pm2 restart at 12:10 must land in the same logical
state as a clean 09:00 boot, so `computeWidth` / `computeLines` / `setupRange` /
`entryClosed = true` are replayed based on `istMinutes()` (see §2 thresholds).

**P8 — phase anchors are pinned by candle timestamp, not array position, wherever a
mid-session restart could shift the array.** `atr-band-nifty.js:116-117` drops *today's*
hourly candles later than `09:15` so the ATR is always the 09:15–10:15 value even if computed
at 13:00; `:148` selects the anchor as the last 5-minute candle with `ts.substr(11,5) <= '11:35'`
so a still-forming 11:40 candle is never chosen. **This is the correct pattern and the rewrite
must apply it to the breakout/entry/stop paths too** (see RISK-1).

**P9 — daily state reset lives in `runStrategy()`**, not at module scope, so the same function
serves both a fresh boot and (in principle) an in-process new day. `bn-breakout.js:84-89`,
`orb-fut-core.js:73-74`, `atr-band-nifty.js:83-86`, `orb-scalp.js:88`.

**P10 — `started = false` on init failure** (`bn-breakout.js:104`, `orb-fut-core.js:91`,
`atr-band-nifty.js:101`, `orb-scalp.js:104`) so `runStrategy()` can be retried.

**P11 — the time stop is armed at entry and cleared in `closePosition` before anything else.**
`setTimeout(() => closePosition('TIME'), timeStopMin*60000)`; `clearTimeout` at
`bn-breakout.js:248`, `atr-band-nifty.js:277`, `orb-scalp.js:251`. A leaked timer would fire
against the *next* position.

**P12 — exit precedence is explicit and tested.** Idea A: `forceExit → TARGET → SL`
(`orb-scalp-logic.js:31-41`, test "TARGET takes precedence over SL on a combined tick").
Idea B: `forceExit → SL → T1` (`orb-fut-logic.js:50-68`, test "SL takes precedence over T1 at
the same price"). **They are opposite orderings — keep them opposite.**

**P13 — inequality strictness.** Idea A option target `>=`; Idea A spot stop **strict**
`<` / `>` (test: "CE spot exactly at SL does not exit (strict cross)"). Idea B SL
**non-strict** `<=` / `>=`, T1 `>=` / `<=`. Idea A candle-close stop strict.

**P14 — nearest-listed-strike fallback.** `findOption` probes `[0, +step, −step, +2step,
−2step]` and aborts the entry if none is listed. Prevents an `undefined` instrument reaching
`trackOrder_v2`. `bn-breakout.js:169-176`, `atr-band-nifty.js:173-180`, `orb-scalp.js:176-183`.

**P15 — nearest expiry only, resolved once per process at init.** `weeklyInstruments`, which
for BANKNIFTY is the *monthly* series (`bn-breakout.js:92` comment, `orb-scalp.js:93`). No
intraday rollover: a process booted on expiry day trades that day's expiry all day. The
rewrite must make this an explicit `expiry: 'nearest'` policy with an intraday-rollover
decision, not an accident of init ordering.

**P16 — per-underlying state isolation when several instances share a process.**
`orb-scalp.js` `freshState()` / `states[underlying]`, with a *single* shared `ticksCache` and a
*single* shared websocket. The runner in the new system must keep exactly this property:
shared feed, isolated strategy state.

**P17 — `process.exit()` at 15:30 with a 3-second grace, and no attempt at graceful shutdown.**
The design assumes pm2 restarts a clean process every morning, which is *why* `started` never
resets and `bootstrap()` runs on load. If the new runner is long-lived, the daily-reset
semantics must be re-implemented deliberately, not inherited.

**P18 — `entryClosed` gates entries only, never exits.** Explicit in
`atr-band-nifty.js:182-183, 201`.

**P19 — the "one trade per side, a win ends the day" budget in `bn-breakout`** —
`closePosition:266-273`: `pnl >= 0` (breakeven counts as a win) → `stopForDay = true`;
a loss leaves the untraded side open; if both sides are spent → `stopForDay = true`. Note this
budget is evaluated from an **LTP-derived** P&L, not the book fill (RISK-4). This is the only
member with a feedback loop from realised P&L into the day's trade budget, and it is
`bn-breakout`'s newest feature (commit `0ccf4432`).

**P20 — day-blocking by range filter is sticky for the whole day** and notified once
(`orb-fut-core.js:110-113`, `orb-scalp.js:123-127`). BANKNIFTY only, `250` points, and it
measures the **future's** range in Idea B vs the **spot's** range in Idea A — mechanically
different numbers for the same nominal filter.

**P21 — `position = null` in `closePosition`'s `catch`** (`atr-band-nifty.js:296`). Deliberate:
without it a throwing SELL would leave the position stuck in `CLOSING` and block the opposite
side's single entry for the rest of the day. `bn-breakout` and `orb-scalp` are missing this
(RISK-2).

---

## 7. Bugs, dead code, and dangerous behaviour

**RISK-1 (high) — "last completed candle" is probably the still-forming candle.**
`bn-breakout.js:152`, `orb-fut-core.js:137`, `orb-scalp.js:162`, `atr-band-nifty.js:192` and
`:203` all take `candles[candles.length - 1]` and call it the last *completed* candle. The
pollers fire at `HH:MM:10` — **ten seconds into a fresh 5-minute bucket** — so Kite will
normally already be returning a bucket for the new period, making the last element a candle
with ~10 s of data. The author clearly knew this: `atr-band-nifty.js:145-148` filters by
`ts.substr(11,5) <= '11:35'` for exactly this reason, and `:113-117` does the hourly
equivalent. The breakout/entry/stop paths do not. Consequences: the breakout "body close"
is really a 10-second snapshot; the atr-band candle-close stop is effectively a 5-minutely
tick stop. **Fix in the rewrite: one shared `lastClosedCandle(candles, tf, now)` helper that
selects by timestamp, and use it everywhere.** This changes trading behaviour, so it needs a
backtest comparison before it ships.

**RISK-2 (high) — a throwing SELL wedges the strategy for the rest of the day.**
`bn-breakout.js:275-277` and `orb-scalp.js:266-268` catch the error but leave
`position.status === 'CLOSING'` and `position` non-null. Then: `checkExits` returns early
(`status !== 'ACTIVE'`), `eodExit` skips it (requires `ACTIVE`), `checkBreakout` returns early
(`position` truthy) — a phantom open position, no square-off, no further trades.
`atr-band-nifty.js:294-298` fixes this with `position = null` in the catch; the fix was never
back-ported.

**RISK-3 (high) — `trackOrder_v2` never awaits its own insert, so "only after a successful
order" is not what it says.** `common/models/paper-trade.js:44` calls `Papertrade.create({…})`
without `await` or `return`. The `async` function therefore resolves immediately, before the
Mongo insert completes. So `await PaperTrade.trackOrder_v2(...)` guarantees only *enqueued*,
not *inserted*. Two consequences: (a) a create failure becomes an unhandled rejection that the
strategy's `try/catch` never sees, and the used/traded flag is flipped anyway; (b) the 15:30
`process.exit()` can kill the process with an insert still in flight. **The TS order client
must actually await, and surface failures.**

**RISK-4 (medium) — the strategy's P&L and the book's P&L are computed from different prices.**
The engines log `pnl = (ltpAtExit − ltpAtEntry) × qty` from their own `ticksCache`, while
`paperstream` stamps `average_price` from `resolveFill(..., bidAsk = 4)` — i.e. the **5th depth
level** when that level's price is `> 50` (`lib/fill-price.js:22-28`), else LTP, else `0.05`.
For `bn-breakout` this is not cosmetic: RISK/P19's `pnl >= 0` day-stop decision is driven by
the LTP number, so the *reported* trade can be a loss while the day stopped as a "win", or
vice-versa. The rewrite must pick one source of truth (read the stamped fill back, or make the
simulator use the same price the strategy saw).

**RISK-5 (medium) — stale option chain via the cached `optionConfig()` path.**
`bn-breakout.js:91` and `atr-band-nifty.js:88` call `optionConfig(underlying)`, which
`require()`s `optionConfig_<UND>.json` from the process CWD and only downloads when the file is
absent. If `paperstream`'s 07:30 refresh cron did not run (server process down, different CWD,
holiday), or if the strategy booted before 07:30, the strategy subscribes and trades **the
previous expiry's tokens**: no ticks → every entry aborts on the tick precondition (P4), or —
worse, right after a rollover — a valid-looking but expired `tradingsymbol` reaches
`trackOrder_v2`. `orb-fut-core.js:76` and `orb-scalp.js:92` use `optionConfig.download()` and
are immune. Unify on an explicit, dated instrument-master fetch.

**RISK-6 (high) — a mid-session restart orphans an open position and can double-enter.**
All state, including `position` and the time-stop `setTimeout`, is in-memory only.
`bootstrap()` replays *phase* functions but has no notion of an existing position, and
`runStrategy()` resets `tradedSides` / `ceUsed` / `tradedToday` to false. So a pm2 restart while
a trade is open leaves a real (bus-inserted) open position that **nothing will ever square
off** — `eodExit` sees `position === null` — while the day budget is refreshed and the same
signal can enter again. This is the single biggest structural gap and the strongest argument
for the planned persisted-state runner.

**RISK-7 (medium) — infinite 30-second retry loops on non-trading days and on persistent
`historyData` failures.** No holiday calendar: the crons fire Mon–Fri including exchange
holidays, `historyData` returns an empty array, the phase function reschedules itself every
30 s until the 15:30 exit. Also, `bootstrap()`'s catch-up can start one retry chain while the
cron starts a second, so two `setupRange`/`computeLines` chains can run concurrently
(harmless today only because the phase functions are idempotent — P6 is doing real work).
Add attempt caps and a trading-calendar gate.

**RISK-8 (low/latent) — `exchange` is hardcoded to `'NFO'` for SENSEX.**
`common/models/paper-trade.js:47`, used by `orb-fut-snx` (BFO-FUT) and `ORB_SCALP_SNX`
(BFO-OPT). Cosmetic while the simulator resolves by `instrument_token`, but wrong the moment
one of these tags is added to a live rail's whitelist.

**RISK-9 (medium, economics) — Idea B's risk:reward is not 1:1 and can be much worse.**
`orb-fut-logic.js:26-31`: `sl` is the absolute opposite ORB end while `t1 = entry ± range`.
Because the entry is the LTP *after* a candle closed beyond `rangeHigh × 1.001`, the stop
distance `entry − rangeLow` always exceeds `range`, while the reward is exactly `range`.
On a strong gap-through the R:R degrades without bound. Idea A has the mirror issue: the
premium target is a fixed small number of points (20/25/40/45) against a spot stop that can be
a full band-width away.

**RISK-10 (low) — dead code / dead defaults.**
`orb-fut-core.js:28` `lots = config.lots || 2` (no wrapper omits `lots`; contradicts commit
`89f8fe70` "1 lot, single target"). `orb-fut-logic.js` exports `computeLevels` and
`passesFilter` publicly although only the module itself and the tests call them.
`orb-scalp.js:246-269` `closePosition` never clears `st.position` (harmless only because
`tradedToday` already blocks re-entry and every consumer checks `status === 'ACTIVE'`), and
`orb-fut-core.js:183` likewise leaves a `CLOSED` position object in place.
`orb-scalp-logic.js:28` and `orb-fut-logic.js:41` accept an `opts.forceExit` that
`orb-scalp.js` never passes (its EOD path calls `closePosition(..., 'EOD')` directly).

**RISK-11 (low) — poller windows are wider than the comments claim.**
`'10 */5 9-13 * * 1-5'` fires 09:00:10 → 13:55:10, not "09:25..13:30"
(`bn-breakout.js:294`) and not "09:00..13:55" *plus a 13:55 stop* — in `bn-breakout` the
13:35/13:40/…/13:55 ticks still fire but are no-ops because `entryClosed` was set at 13:31.
Pre-open ticks at 09:00–09:20 are no-ops because `linesReady` is false. Harmless, but the
comments are wrong and a reader will trust them.

**RISK-12 (low) — UTC date used as the trading date.**
`new Date().toISOString().substr(0, 10)` in every `historyData` call. Correct only because
everything runs after 05:30 IST. `atr-band-nifty.js:110` uses
`moment().utcOffset(330).format('YYYY-MM-DD')` for the same purpose — inconsistent. Use one
IST-aware date helper.

**RISK-13 (low/scale) — `orb-scalp` subscribes three full nearest-expiry option chains in
`modeFull` on one socket.** `orb-scalp.js:90-101` pushes every token of
`weeklyInstruments` for BANKNIFTY + NIFTY + SENSEX. It only ever trades the ATM strike. The new
market-data service should subscribe an ATM neighbourhood (say ±5 strikes) and add tokens
on demand.

**RISK-14 (low) — `atr-band-nifty`'s ATR lookback can be short after a holiday cluster.**
`:111` fetches 60-minute candles from `today − 7 calendar days` and `wilderATR` needs ≥ 14.
Seven calendar days is normally ≈ 32 hourly candles, but a long weekend plus holidays can dip
under 14 → `atr === null` → the 30-second retry loop (RISK-7) runs all day and the strategy
never trades. Use a trading-day count, not a calendar offset.

**RISK-15 (informational) — `server/smp/bn-breakout.js` is a stale fork.** It still has the
older `tradedToday` (one trade *per day*) budget instead of `tradedSides` + `stopForDay`
(commit `0ccf4432`). Do not use it as a reference. The other nine files have no `smp` twin.

---

## 8. Proposed `StrategyBase` / lifecycle interface for the rewrite

The point of this family is that the anatomy in §2 is the *same* for all four engines. It
factors cleanly into a host (the runner), a strategy contract, and injected services — which is
also exactly what makes backtesting possible.

```ts
// ---------- injected services: identical objects in live and backtest ----------
interface Clock {
  now(): DateTime;                       // IST-aware
  istMinutes(): number;
  at(spec: TimeOfDay, fn: () => Promise<void>): Disposable;   // replaces CronJob
  after(ms: number, fn: () => void): Disposable;              // replaces setTimeout
  isTradingDay(d: Date): boolean;                             // fixes RISK-7
}

interface MarketData {                   // one shared tick bus + one data service
  subscribe(tokens: number[], mode?: 'full' | 'ltp'): void;
  onTick(cb: (t: Tick) => void): Disposable;
  ltp(token: number): number | undefined;             // reads the shared tick cache
  depth(token: number): Depth | undefined;
  candles(token: number, tf: Timeframe, from: Date, to: Date): Promise<Candle[]>;
  lastClosedCandle(token: number, tf: Timeframe): Promise<Candle | undefined>; // fixes RISK-1
}

interface Instruments {                  // replaces optionInstruments.js
  chain(underlying: Underlying, expiry: 'nearest' | 'next'): Promise<OptionChain>;
  currentFuture(underlying: Underlying): Promise<Instrument>;
  atmOption(u: Underlying, spot: number, type: 'CE' | 'PE',
            offsetSteps?: number): Instrument | undefined;     // keeps the P14 fallback ladder
}

interface Broker {                       // the execution rail, chosen by config
  market(inst: Instrument, side: 'BUY' | 'SELL', lots: number,
         tag: string): Promise<Fill>;    // MUST actually await — fixes RISK-3
}

interface StateStore {                   // fixes RISK-6
  load<T>(key: string): Promise<T | undefined>;
  save<T>(key: string, v: T): Promise<void>;
}

interface Notifier { info(msg: string): void; }
```

```ts
// ---------- the strategy contract ----------
abstract class StrategyBase<C, S> {
  constructor(protected readonly cfg: C, protected readonly ctx: {
    clock: Clock; md: MarketData; instruments: Instruments;
    broker: Broker; state: StateStore; notify: Notifier; log: Logger;
  }) {}

  /** #8 runStrategy: idempotent, resolve instruments, subscribe, restore state. */
  abstract init(): Promise<void>;

  /** #9 named phases, declared not hardcoded; the host schedules and replays them. */
  abstract phases(): Phase[];   // {name, at: TimeOfDay, run(), idempotentGuard(), retry: {every, maxAttempts}}

  /** #10/#15 pure, synchronous, tick-driven. Returns intents, never places orders. */
  abstract onTick(tick: Tick): Intent[];

  /** #11 candle-driven evaluation, run under a concurrency-1 lane per strategy. */
  abstract onCandleClose(c: Candle): Promise<Intent[]>;

  /** #17 forced flat. */
  abstract squareOff(reason: ExitReason): Promise<void>;
}

type Intent =
  | { kind: 'ENTER'; instrument: Instrument; side: 'BUY' | 'SELL'; lots: number; meta: object }
  | { kind: 'EXIT';  reason: ExitReason; lots?: number };
```

Requirements the base class must enforce, derived directly from §6:

1. **Synchronous position state machine** `IDLE → PENDING → ACTIVE → CLOSING → CLOSED`, with
   the transition applied *before* the awaited broker call (P1, P2). One `busy`/lane token per
   strategy instance.
2. **A single serial lane per strategy** for anything that fetches history and may order (P5);
   `onTick` is allowed to run concurrently with nothing.
3. **Order-then-flag ordering** built into the base: budget counters are decremented by the
   *broker acknowledgement*, never by the intent (P3), and preconditions (`ltp` present for
   every instrument the strategy prices) are checked by the base before the intent is accepted,
   with an `ABORT_RETRY` outcome that does not consume the budget (P4).
4. **Declarative phases with catch-up.** The host, on start, replays every phase whose
   `at` is already past for today, in order (P7), then arms the remainder. Retry policy is
   config, with an attempt cap (RISK-7).
5. **Timestamp-anchored candle selection** everywhere, provided once by `MarketData`
   (P8, RISK-1).
6. **Persisted position + budget + phase state** keyed by `(tag, tradingDate)`, written on
   every state-machine transition, reloaded in `init()` so a restart adopts an open position
   and its remaining time stop instead of orphaning it (RISK-6, P17).
7. **Duration-based stops expressed as deadlines, not timers** (`exitAfter: entryTime + 90min`
   evaluated by the clock), so they survive a restart (P11 + RISK-6).
8. **A declared exit-precedence list per strategy** (`['EOD','TARGET','SL']` for Idea A,
   `['EOD','SL','T1']` for Idea B) evaluated against one price snapshot (P12), with explicit
   strict/non-strict comparison flags (P13).
9. **Pure decision modules stay pure and stay tested.** `computeRange`, `breakoutSide`,
   `wilderATR`, `entrySignal`, `target`, `stopHitOnClose`, `evaluateExit` port over as
   dependency-free functions; their existing 50 test cases in `server/test/` port over first
   and must keep passing.
10. **Rail chosen by config, not by import.** `Broker` has a `paper-bus` implementation (insert
    into `paper-trade`), a `zerodha-direct` implementation (`Account.placeAllAccount`), and a
    `backtest` implementation (fill from the replayed feed). No strategy code changes.
