# Family spec: `bull` / `bulln`

> **Inherited from the NSE desk** (`/opt/algomaker`, copied 3 Nov 2026). It describes the machinery this repo
> shares with the NSE desk as it stood there, and is not maintained here. The process names (`desk-*`), ports
> (87xx), database (`algomaker`) and paths in it are the **live NSE desk's**: in this repo they are `dx-*`,
> 8890–8897 and `algomaker_dx`. Never run a command from this page. Links to other NSE documents point into
> the NSE repo and were not carried over.

Canonical parameterized spec for `server/slive/bull-*.js` + `server/slive/bulln-*.js` (20 files).
Written so a TypeScript class can be built **without reading the legacy files**.

Source of truth read: all 20 slive files (2 read in full, 18 reduced by `diff`), plus the
7 staging siblings in `server/smp/bull-*.js` which expose two extra config axes
(take-profit, pyramid on/off) that no slive file currently enables.

---

## 0. Executive summary

20 files. **4 genuinely distinct algorithms.** All 4 are short-premium, intraday-launched,
never-hedged, no-daily-loss-cap sellers on a single index. All 4 share one identical
~55-line boilerplate prologue (Zerodha login on the master account → own KiteTicker
websocket → `optionConfig()` chain snapshot → `setTimeout(entry, 15s)` → two
`async.queue(…, 1)` pumps fed from every tick).

| Idea | Files | One line |
|---|---|---|
| `wing-basket-roll` | 6 | Sell 3 CE wings above + 3 PE wings below; when spot touches the innermost short strike, close and re-sell the whole basket recentred on the new ATM. |
| `crossover-straddle-pyramid` | 11 | Every time spot crosses a round strike, sell an ATM straddle (one per strike level); exit each straddle on combined-premium stop; per-trade size ramps up or down. |
| `straddle-ladder-roll` | 1 (`bull-x`) | Hold 3 straddles at ATM and ±300; on a ±300 touch, buy back the far rung and sell a new rung on the near side. Never flat, never recentred wholesale. |
| `premium-target-strangle-flip` | 1 (`bull-200-1`) | Pick 4 CE and 4 PE strikes by *premium* (200/160/130/100), sell all 8; per-leg stop at entry+50; a stopped leg is replaced by a fresh leg of the **opposite** type at the same premium. |

Everything else in the 20 files is constants: underlying, strike step, offsets, stop
multiplier, start size, size direction, expiry-roll weekday, and the `strategyTag` string.

---

## 1. Shared runtime skeleton (identical in all 20 files)

```
CONSTANTS (module scope)
  strategyTag : string          // the only per-file mandatory difference
  channelId   = 0               // DEAD, never used
  farOtm      = 0               // otmSelector() call is COMMENTED OUT in all 20 files

startup()                       // runs at module load: `runStrategy()` on the last line
  optionData        = await optionConfig(UNDERLYING)   // cached-JSON-or-download, see §5.1
  futureToken       = TRIGGER_TOKEN                   // see axis `triggerToken`
  chain             = optionData.weeklyInstruments     // map "<strike><CE|PE>" -> instrument
  if ROLL_TO_NEXT_WEEK_ON_DAY and moment().day() == ROLL_TO_NEXT_WEEK_ON_DAY:
        chain = optionData.nextWeekInstruments
  base_acc = Account.findById(app.get('masterId'))
  zapi     = zerodha_init(base_acc)      // logs in, MUTATES + SAVES the master account doc,
                                         //   yields public_token; return value IGNORED on failure
  ticker([futureToken, ...all chain tokens])   // OWN KiteTicker, api_key:'kitefront'
  setTimeout(() => takeTrade(FORCE_FIRST_ENTRY), 15_000)

onTicks(ticks)                  // every websocket tick batch
  ticksCache = { ...ticksCache, ...byToken(ticks) }
  if PUSH_ENTRY_ON_TICK: takePositionQ.push()     // async.queue concurrency 1
  checkSLQ.push()                                 // async.queue concurrency 1
```

Notes that matter for the rewrite:

* There is **no CronJob** in any slive `bull-*` file. Lifecycle is entirely external:
  `server/tools/ob_start.js` `pm2 restart`s every `autostart:true` module at **09:15:30 IST**,
  `pm2 stop`s **every** registered module at **15:23:50 IST**, and `process.exit()`s the host at
  15:25:00. Stopping the process does **not** square off — see §6 R1.
* Registration is `common/models/strategies.json` (`{name, module, autostart, delay_start?}`).
  Only **`Bull_SNX-1`** and **`Bull_S-1`** are `autostart:true`; the other 18 are manual/`delay_start`.
* `runStrategy()` is called at require time, so `pm2 restart` == immediate re-entry with
  **zero position recovery**: `optionOrders` is rebuilt empty, so any position open at restart
  becomes an untracked orphan that nothing will ever close.

### 1.1 Execution rail — bus-routed, conditionally live

Every order in this family goes through **`PaperTrade.trackOrder(instrument, side, tag, multiplier=1)`**
— the *legacy v1* helper (`common/models/paper-trade.js:61`), not `trackOrder_v2`. It inserts
one `paper-trade` document with `status:"COMPLETE"`, `order_type:"MARKET"`,
`quantity = instrument.lot_size * multiplier`, `exchange:"NFO"` **hardcoded**, and **no `dataObj`**.

Consumers of that insert (all watch the collection change stream, none filters by tag):

| Consumer | Effect |
|---|---|
| `server/boot/paperstream.js:352` `handleInsertEvent` | Simulator. Stamps `average_price` from its own tick cache via `lib/fill-price.js` (`0.05` fallback if no tick). Always runs. |
| `server/tools/xtsOrder.js:237` `placeTrade` | **REAL XTS/Jainam orders**, but only `if runningStrategies[tag] > 0`, i.e. only if some XTS account has `account.strategy[tag]` set to a lot count. Overwrites `exchange` to `NSEFO`/`BSEFO` by symbol prefix, and tranches orders above `maxOrderLots[index]`. |
| `server/tools/sparkOrder.js` / `fyersOrder.js` | Same pattern for Spark / Fyers. |

So the rail is **bus-routed with a live fan-out gate held outside the strategy**. Live size =
`multiplier × account.strategy[tag]` lots per account. The `multiplier` argument therefore is
*not* a lot count — it is a lot **scaler** on top of each account's configured allocation. This
matters for `crossover-straddle-pyramid`, the only idea that varies it.

The only exit that is *not* a strategy decision is **`POST /PaperTrades/squareoff {strategy: tag}`**
(`paper-trade.js:190`) — a manual REST/UI call that flattens every non-zero position for a tag by
inserting offsetting `trackOrder`s. No cron invokes it for this family.

---

## 2. Idea A — `wing-basket-roll`

**Members:** `bull-300.js`, `bull-300i.js`, `bulln-300.js`, `bulln-300i.js`, `bull-m.js`, `bull-m2.js`

Sell a 6-leg basket: three legs at `atm + off[i]` and three at `atm - off[i]`. The *type* assigned
to the upper and lower side is a config flag (`OTM` = CE above / PE below; `ITM` = PE above /
CE below). Roll when spot reaches the innermost short strike.

```
state: basket = null      // {atm, trgUp, trgDown}

// --- entry -------------------------------------------------------------
// PUSH_ENTRY_ON_TICK = false for all 6 members, so the crossover test below is
// EFFECTIVELY DEAD: takeTrade() is called exactly once, from the 15s timer,
// with force = true.
takeTrade(force):
  q = ticksCache[triggerToken]
  if TICK_WAIT_GUARD and (q is null or q.last_price is null):    // bull-m / bull-m2 only
        return setTimeout(() => takeTrade(force), 5_000)
  atmNow = round(q.last_price / STEP) * STEP
  cross  = force
        or (q.last_price >= atmNow and lastQuote <= atmNow)      // lastQuote starts at 0
        or (q.last_price <= atmNow and lastQuote >= atmNow)
  lastQuote = q.last_price
  if cross: sendOrder('SELL')

// --- order placement ---------------------------------------------------
sendOrder(side, atm = null, onlySide = 'both'):
  if atm is null: atm = round(ticksCache[triggerToken].last_price / STEP) * STEP
  legs = []
  for off in OFFSETS:                    // e.g. [300,400,500]
      legs.push( (atm + off) + UP_TYPE )     // UP_TYPE   = 'CE' (OTM) | 'PE' (ITM)
      legs.push( (atm - off) + DOWN_TYPE )   // DOWN_TYPE = 'PE' (OTM) | 'CE' (ITM)
  for key in legs:
      if onlySide == 'CE' and key ends with 'PE': continue
      if onlySide == 'PE' and key ends with 'CE': continue
      PaperTrade.trackOrder(chain[key], side, tag)      // multiplier = 1 ALWAYS
  if side == 'SELL':
      basket = { atm, trgUp: atm + OFFSETS[0], trgDown: atm - OFFSETS[0] }

// --- exit / roll -------------------------------------------------------
checkSL():                              // runs on EVERY tick batch
  p = ticksCache[triggerToken].last_price

  if ROLL_MODE == 'basket':             // bull-300, bull-300i, bulln-300, bulln-300i
      if basket and (basket.trgUp <= p or basket.trgDown >= p):
          sendOrder('BUY', basket.atm)      // close ALL 6 legs of the old basket
          basket = null
          sendOrder('SELL')                 // re-sell 6 fresh legs at the CURRENT atm

  if ROLL_MODE == 'perSide':            // bull-m, bull-m2
      if basket and basket.trgUp and basket.trgUp <= p:
          sendOrder('BUY', basket.atm, 'CE')   // closes ONLY the 3 CE legs   <-- see R2
          basket.trgUp = false                 // dead write, overwritten next line
          sendOrder('SELL')                    // re-sells ALL 6 legs, replaces `basket`
      else if basket and basket.trgDown and basket.trgDown >= p:
          sendOrder('BUY', basket.atm, 'PE')   // closes ONLY the 3 PE legs   <-- see R2
          basket.trgDown = false
          sendOrder('SELL')
  lastQuote = p
```

* **Entry trigger (effective):** unconditional, once, ~15 s after process start (≈09:15:45 IST
  for autostarted modules).
* **Exit paths:** *only* the roll. No premium stop, no target, no time stop, no EOD flatten.
  Terminal exits are (a) manual `PaperTrades.squareoff`, (b) weekly expiry settlement,
  (c) nothing.
* **Sizing:** flat, `multiplier = 1` (i.e. 1× each account's allocation) on every leg forever.
* **Rolls are unbounded** — no max-roll counter, no loss cap.

### Member config table (Idea A)

| File | tag | underlying | trigger token | STEP | OFFSETS | UP_TYPE/DOWN_TYPE | ROLL_MODE | next-week roll day | tick-wait guard | subscribes |
|---|---|---|---|---|---|---|---|---|---|---|
| `bull-300.js` | `B300` | BANKNIFTY | `260105` (spot) | 100 | 300,400,500 | CE / PE | basket | *disabled (commented)* | no | future + full chain |
| `bull-300i.js` | `B300i` | BANKNIFTY | `260105` | 100 | 300,400,500 | **PE / CE** | basket | Wed (`day==3`) | no | future + full chain |
| `bulln-300.js` | `N300` | NIFTY (`optionConfig('NIFTY')`) | `256265` | **50** | **150,200,250** | CE / PE | basket | Wed | no | future + full chain |
| `bulln-300i.js` | `N300i` | NIFTY | `256265` | 50 | 150,200,250 | **PE / CE** | basket | Wed | no | future + full chain |
| `bull-m.js` | `Bull_M` | BANKNIFTY | `260105` | 100 | **100,200,300** | CE / PE | **perSide** | disabled | **yes** | **future only** |
| `bull-m2.js` | `Bull_M2` | BANKNIFTY | `260105` | 100 | 100,200,300 | CE / PE | perSide | disabled | yes | future only |

`bull-m2.js` is byte-identical to `bull-m.js` except line 15 (`strategyTag`). `bull-300i` differs
from `bull-300` in exactly 4 hunks. `bulln-300i` differs from `bulln-300` in exactly 2 hunks.

The `i` suffix means **inverted leg types**: the basket becomes deep-ITM shorts (PE above spot,
CE below spot), which is a synthetic-future-ish structure with ~1.0 delta legs, not a condor.

---

## 3. Idea B — `crossover-straddle-pyramid`

**Members:** `bull-s-1.js`, `bull-s-2.js`, `bull-s5-1.js`, `bull-s5-2.js`, `bull-fs-1.js`,
`bull-fs-2.js`, `bull-ms-1.js`, `bull-ms-2.js`, `bull-ns-1.js`, `bull-ns-2.js`,
`bull-snx-1.js`, `bull-r.js`

```
state: openPositions = []      // sparse array; holes left by `delete`
       openStrikes   = {}      // atm -> bool, "is there a live straddle at this strike"
       size          = START_SIZE
       lastQuote     = 0

// --- entry: every round-strike crossover ------------------------------
// PUSH_ENTRY_ON_TICK = true for ALL 12 members -> this runs on every tick batch.
takeTrade(force):
  q      = ticksCache[triggerToken]
  atmNow = round(q.last_price / STEP) * STEP
  cross  = force
        or (q.last_price >= atmNow and lastQuote <= atmNow)
        or (q.last_price <= atmNow and lastQuote >= atmNow)
  lastQuote = q.last_price                 // NOTE: also written by checkSL() -> see P5
  if cross: sendOrder()

sendOrder():
  atm = round(ticksCache[triggerToken].last_price / STEP) * STEP
  ce  = chain[(atm + farOtm) + 'CE']       // farOtm is HARD 0 -> always the ATM straddle
  pe  = chain[(atm - farOtm) + 'PE']
  ceLtp = ticksCache[ce.instrument_token].last_price     // unguarded, see R5
  peLtp = ticksCache[pe.instrument_token].last_price

  if not openStrikes[atm] and (START_SIZE <= 1 or size > 0):      // `size > 0` only in bull-r
      PaperTrade.trackOrder(ce, 'SELL', tag, size)
      PaperTrade.trackOrder(pe, 'SELL', tag, size)
      openPositions.push({
          atm,
          trg: int((ceLtp + peLtp) * STOP_MULT),                  // combined-premium stop
          tgt: int((ceLtp + peLtp) * TARGET_MULT),                // only if TARGET_MULT set
          ce, pe, lotSize: size
      })
      openStrikes[atm] = true
      size = size + SIZE_STEP                                    // +1, -1, or 0
```

```
// --- exit: combined-premium stop (and optional target) ----------------
checkSL():                              // every tick batch
  for (order, idx) in openPositions:
      if order is empty: continue
      ltp = ticksCache[order.ce.instrument_token].last_price
          + ticksCache[order.pe.instrument_token].last_price
      if order.trg <= ltp:                          // STOP
          PaperTrade.trackOrder(order.pe, 'BUY', tag, order.lotSize)
          PaperTrade.trackOrder(order.ce, 'BUY', tag, order.lotSize)
          openStrikes[order.atm] = false            // strike becomes re-enterable
          delete openPositions[idx]
      else if TARGET_MULT and ltp <= order.tgt:     // TARGET (no slive member enables this)
          ...same two BUYs, same cleanup...
  lastQuote = ticksCache[triggerToken].last_price
```

* **Entry trigger:** spot (or future) crossing a `STEP`-multiple boundary in either direction,
  evaluated on every tick. Because `lastQuote` initialises to `0`, the **very first tick always
  satisfies the up-crossover test**, so the first straddle is sold on the first tick received —
  well before the 15 s timer. `bull-r` additionally passes `force=true` on the timer call.
* **Dedup:** `openStrikes[atm]` allows at most **one live straddle per strike level**. A stopped-out
  strike is immediately re-enterable at the *next* crossing of that boundary, at the *new* size.
* **Exit paths:** combined-premium stop only (`STOP_MULT`). No spot-based stop, no time stop, no
  EOD flatten, no target in any slive member. Position dies at manual squareoff or expiry.
* **Sizing:** `multiplier` starts at `START_SIZE` and moves by `SIZE_STEP` after **every** accepted
  entry, forever, uncapped in the `+1` direction. Each straddle remembers its own `lotSize` so its
  exit is size-matched.

### Member config table (Idea B)

| File | tag | underlying | trigger token | STEP | STOP_MULT | START_SIZE | SIZE_STEP | autostart |
|---|---|---|---|---|---|---|---|---|
| `bull-s-1.js` | `Bull_S-1` | BANKNIFTY | **`optionData.currentFuture.token`** (monthly FUT) | 100 | 1.25 | 1 | +1 | **true** |
| `bull-s-2.js` | `Bull_S-2` | BANKNIFTY | `260105` (spot) | 100 | 1.25 | 1 | +1 | false |
| `bull-s5-1.js` | `Bull_S5-1` | BANKNIFTY | `260105` | 100 | **1.05** | 1 | +1 | false |
| `bull-s5-2.js` | `Bull_S5-2` | BANKNIFTY | `260105` | 100 | 1.05 | 1 | +1 | false |
| `bull-ns-1.js` | `Bull_NS-1` | NIFTY | `256265` | **50** | 1.25 | 1 | +1 | false |
| `bull-ns-2.js` | `Bull_NS-2` | NIFTY | `256265` | 50 | 1.25 | 1 | +1 | false |
| `bull-fs-1.js` | `Bull_FS-1` | FINNIFTY | `257801` | 50 | 1.25 | 1 | +1 | false |
| `bull-fs-2.js` | `Bull_FS-2` | FINNIFTY | `257801` | 50 | 1.25 | 1 | +1 | false |
| `bull-ms-1.js` | `Bull_MS-1` | MIDCPNIFTY | `288009` | **50** (real step is 25) | 1.25 | 1 | +1 | false |
| `bull-ms-2.js` | `Bull_MS-2` | MIDCPNIFTY | `288009` | 50 | 1.25 | 1 | +1 | false |
| `bull-snx-1.js` | `Bull_SNX-1` | SENSEX | `265` | 100 | 1.25 | 1 | +1 | **true** |
| `bull-r.js` | `Bull_R` | BANKNIFTY | `260105` | 100 | 1.25 | **7** | **−1** (floor 0) | false |

`-1`/`-2` pairs are **duplicate deployments of the same rules under different tags**, not
different strategies. `bull-fs-1`≡`bull-fs-2`, `bull-ms-1`≡`bull-ms-2`, `bull-ns-1`≡`bull-ns-2`,
`bull-s5-1`≡`bull-s5-2` — byte-identical apart from line 15. `bull-s-1` vs `bull-s-2` differ only
in whether the ATM is derived from the **BANKNIFTY monthly future** or the **spot index** — a real
behavioural difference (futures carry a basis, so the two pick different ATMs and cross boundaries
at different times).

`bull-r` is the same code with `START_SIZE=7`, `SIZE_STEP=-1`, a `size > 0` entry gate, and
`force=true` on the 15 s timer: 7 lots, then 6, … then 1, then permanently stops entering.
Cumulative max 28 lots × allocation.

**Two axes visible only in `server/smp/`** (no slive member uses them; keep them in the config
type so the staging variants collapse into the same class):
`TARGET_MULT` — `0.95` (`smp/bull-s5.js`), `0.90` (`smp/bull-s10.js`), unset elsewhere; and
`SIZE_STEP = 0` (`smp/bull-s1.js`, `smp/bull-s5.js`, `smp/bull-s10.js`, where `currentSize += 1`
is commented out → flat 1 lot).

---

## 4. Idea C — `straddle-ladder-roll` (`bull-x.js`, tag `Bull_X`)

BANKNIFTY, trigger token `260105` (spot), `STEP = 100`, `RUNG = 300`, flat 1 lot, weekly expiry
(no next-week roll), `PUSH_ENTRY_ON_TICK = false` (single forced entry at t+15 s).

```
state: ladder = null

sendPair(strike, side):
  PaperTrade.trackOrder(chain[strike + 'PE'], side, tag)     // PE first, then CE
  PaperTrade.trackOrder(chain[strike + 'CE'], side, tag)

// --- entry (once, forced, ~t+15s) -------------------------------------
sendOrder('SELL'):
  atm = round(spot / 100) * 100
  sendPair(atm,        'SELL')
  sendPair(atm + 300,  'SELL')
  sendPair(atm - 300,  'SELL')
  ladder = { mid: atm, up: atm + 300, down: atm - 300, trgUp: true, trgDown: true }

// --- exit: roll one rung, never go flat ------------------------------
checkSL():                              // every tick batch
  p = spot
  if ladder.trgUp and ladder.up <= p:
      ladder.trgUp = false
      sendPair(ladder.down, 'BUY')                  // retire the far-down rung
      ladder.mid += 300; ladder.up += 300; ladder.down += 300
      sendPair(ladder.up, 'SELL')                   // open a new top rung
      setTimeout(() => ladder.trgUp = true, 500)    // 500 ms re-arm debounce
  if ladder.trgDown and ladder.down >= p:
      ladder.trgDown = false
      sendPair(ladder.up, 'BUY')                    // retire the far-up rung
      ladder.mid -= 300; ladder.up -= 300; ladder.down -= 300
      sendPair(ladder.down, 'SELL')
      setTimeout(() => ladder.trgDown = true, 500)
  lastQuote = p
```

* Always exactly **3 short straddles** (6 short legs), spaced 300 apart, straddling spot.
  Never flat, never recentred as a whole — it *translates* by one rung.
* **Exit paths:** rung retirement only. No stop, no target, no time exit, no EOD flatten.
* `trgUp`/`trgDown` are separate booleans re-armed after 500 ms — this is the only race guard
  in the entire family. Both `if`s are evaluated in the same pass (not `else if`), so an up-roll
  and a down-roll can both fire on one tick batch if the ladder is straddled by the price move.
* Sequence per roll: **BUY the retiring pair is emitted before the SELL of the new pair**, and
  the ATM rung is never touched. Order of `sendPair` legs is always PE then CE.

---

## 5. Idea D — `premium-target-strangle-flip` (`bull-200-1.js`, tag `B200-1`)

BANKNIFTY, trigger token `260105`, weekly expiry, flat 1 lot, `PUSH_ENTRY_ON_TICK = false`,
entry unconditional at t+15 s (no crossover test at all — `takeTrade()` just calls `sendOrder`).

```
state: openLegs = []        // one entry PER LEG (not per pair); holes set to null

// strike selection by PREMIUM, not by point offset
pickByPremium(target):
  cands = for each instrument in chain:
              distance = ticksCache[tok] ? abs(ticksCache[tok].last_price - target)
                                         : target          // <-- no-tick fallback, see R7
  sort cands by distance asc
  ce = first CE in sorted order ; pe = first PE in sorted order
  return { ce: chain[ce.strike+'CE'], pe: chain[pe.strike+'PE'] }

placeLeg(option, range, side):
  entry = ticksCache[option.instrument_token].last_price
  openLegs.push({ range, entry, stoploss: entry + 50, option })   // ABSOLUTE +50 pts
  PaperTrade.trackOrder(option, side, tag)

sendOrder('SELL'):
  for target in [200, 160, 130, 100]:
      pair = pickByPremium(target)
      placeLeg(pair.ce, target, 'SELL')
      placeLeg(pair.pe, target, 'SELL')
  // => 8 short legs

// --- exit: per-leg absolute stop, then FLIP TO THE OPPOSITE TYPE -------
checkSL():                          // every tick batch
  for i in 0 .. openLegs.length-1:  // length re-read each iteration; new legs are appended
      order = openLegs[i]; if !order: continue
      ltp = ticksCache[order.option.instrument_token].last_price
      if ltp >= order.stoploss:
          PaperTrade.trackOrder(order.option, 'BUY', tag)   // close the loser
          fresh = pickByPremium(order.range)                // re-pick at the SAME premium
          if order.option.instrument_type == 'CE': placeLeg(fresh.pe, order.range, 'SELL')
          else:                                    placeLeg(fresh.ce, order.range, 'SELL')
          openLegs[i] = null
```

* **Entry:** unconditional once, ~t+15 s. Strikes are chosen so each leg's premium is as close as
  possible to 200 / 160 / 130 / 100 → four strangles of decreasing width.
* **Exit paths:** per-leg stop at **entry premium + 50 absolute points** (so a 100-premium leg
  stops at +50 %, a 200-premium leg at +25 %). No target, no time exit, no EOD flatten. Never
  reaches flat — every stop opens a replacement.
* **The flip is the defining (and most suspicious) rule:** a stopped CE is replaced by a **PE**,
  and a stopped PE by a **CE**. Over a trending day this monotonically converts the book into a
  one-sided short of the *losing* direction. Whether this is intent or a copy-paste inversion is
  unresolved (see R8) — reproduce it behind an explicit `replacementSide: 'same' | 'opposite'`
  flag so it can be corrected without changing the migration.
* Positions are tracked **per leg**, never paired, so a stopped CE's partner PE stays open with
  its own original stop.

---

## 6. Config axes that regenerate all 20 files

```ts
type BullAlgo = 'wing-basket-roll' | 'crossover-straddle-pyramid'
              | 'straddle-ladder-roll' | 'premium-target-strangle-flip';

interface BullConfig {
  tag: string;                       // strategyTag; the PnL/routing key. Unique per instance.
  algo: BullAlgo;

  // --- underlying (axis 1) -------------------------------------------
  underlying: 'BANKNIFTY'|'NIFTY'|'FINNIFTY'|'MIDCPNIFTY'|'SENSEX';
  triggerToken: number | 'currentFuture';   // 260105 | 256265 | 257801 | 288009 | 265
                                            // 'currentFuture' == optionData.currentFuture.token
  strikeStep: 50 | 100;                     // rounding used for ATM AND for offset arithmetic
  subscribe: 'trigger-only' | 'trigger+chain';

  // --- strike selection (axis 2) -------------------------------------
  selection: 'offset' | 'premium';
  offsets?: number[];                       // [300,400,500] | [150,200,250] | [100,200,300]
  legTypes?: 'otm' | 'itm';                 // otm: CE above / PE below;  itm: PE above / CE below
  atmOffset?: number;                       // farOtm — HARD 0 everywhere (otmSelector disabled)
  premiumTargets?: number[];                // [200,160,130,100]
  ladderRung?: number;                      // 300 (idea C)

  // --- entry (axis 3) ------------------------------------------------
  entry: 'once-forced' | 'strike-crossover';
  forceFirstEntry: boolean;                 // pass force=true on the 15s timer
  entryDelayMs: 15_000;
  tickWaitGuard: boolean;                   // retry every 5s until the trigger tick exists
  dedupPerStrike: boolean;                  // openStrikes[atm] gate (idea B only)

  // --- exit / stop basis (axis 4) ------------------------------------
  exitBasis: 'spot-touch-inner-strike'      // idea A
           | 'combined-premium-mult'        // idea B
           | 'spot-touch-ladder-rung'       // idea C
           | 'per-leg-absolute-points';     // idea D
  stopMult?: 1.25 | 1.05;                   // idea B
  targetMult?: 0.95 | 0.90;                 // idea B, smp-only today
  perLegStopPoints?: 50;                    // idea D
  rollMode?: 'basket' | 'perSide';          // idea A
  replacementSide?: 'same' | 'opposite';    // idea D — legacy value is 'opposite'
  rearmDebounceMs?: 500;                    // idea C
  maxRolls?: number;                        // NOT in legacy — add, default Infinity to match

  // --- sizing (axis 5) ----------------------------------------------
  startSize: number;                        // 1 | 7
  sizeStep: number;                         // +1 (pyramid up) | -1 (pyramid down) | 0 (flat)
  sizeFloor: 0; sizeCap?: number;           // legacy floor 0 (bull-r gate), NO cap upward

  // --- expiry (axis 6) ----------------------------------------------
  expiry: 'weekly';
  rollToNextWeekOnWeekday?: 3;              // moment().day() — Wednesday, or undefined

  // --- rail (axis 7) ------------------------------------------------
  rail: 'bus';                              // PaperTrade.trackOrder for all 20
  autostart: boolean; delayStartHHmm?: string;
}
```

Recognisable in-repo precedent for the rewrite: `server/slive/orb-fut-core.js`
(`module.exports = function startOrbFut(config)`) with 7-line per-instance wrappers.

---

## 7. Behaviours that MUST be preserved

**P1 — `lastQuote` starts at `0`, which makes the first tick a synthetic up-crossover.**
For every Idea-B member, `lastQuote <= atmNow` is trivially true on the first tick, so the first
straddle is sold on the **first tick received**, not on a genuine boundary cross, and not at the
15 s timer. Any rewrite that initialises `lastQuote` to the first observed price silently removes
the day's opening entry. Reproduce it as an explicit `enterOnFirstTick: true`.

**P2 — entry is a one-shot `setTimeout(..., 15_000)` from module load, and `pm2 restart` restarts
that clock.** Ideas A/C/D therefore re-enter a brand-new basket every time the process is
restarted, with no knowledge of the previous one. There is no catch-up, no reconciliation against
`paper-trade`, and no idempotency key. Restart safety must be *added*, but the migration must
decide explicitly, because "restart == new basket" is what the live PnL history reflects.

**P3 — `async.queue(fn, 1)` serialises stop checks, and the two queues are independent.**
`checkSLQ` and `takePositionQ` each have concurrency 1 but run concurrently with each other. In
Idea B, both write the shared `lastQuote`, and `checkSL` writes it on *every* tick — so which of
the two last wrote it determines whether a crossover is detected. This race is load-bearing for
the observed entry frequency; a single-threaded rewrite will enter **more often** than the legacy
code unless the interleaving is modelled (recommendation: keep one ordered event loop, run entry
before exit within a tick — matching the `takePositionQ.push()` before `checkSLQ.push()` order in
`checkTicks` — and keep a single `lastQuote` updated once per tick).

**P4 — order-flag / leg ordering inside a roll.**
Idea A basket roll: 6 BUYs (old ATM) → `basket = null` → 6 SELLs (new ATM), in that order, with
`basket` cleared *between* them so a tick arriving mid-roll cannot double-roll.
Idea A perSide roll: 3 BUYs on the breached side → 6 SELLs.
Idea C: retire-pair BUY → mutate strikes → new-rung SELL, and within `sendPair` always **PE
before CE**. Idea D: loser BUY → replacement SELL.
None of these calls is `await`ed and `Papertrade.create` is itself fire-and-forget, so Mongo
insert order — and hence the simulator's fill order and the live rail's order sequence — is only
*probabilistically* the emission order. Preserving the emission order is the best available
fidelity; a rewrite that awaits each insert will produce *different* (better) fills.

**P5 — `openStrikes[atm]` is the only re-entrancy guard in Idea B.** One live straddle per strike
level; cleared on stop-out so the same level can be re-entered later at the then-current (larger)
size. Removing it turns the strategy into an unbounded adder on chop.

**P6 — per-position `lotSize` memory.** Each Idea-B straddle stores the `size` it was opened with
and exits with exactly that multiplier. Do not exit with the current `size`.

**P7 — `trg` / `tgt` are `parseInt()`-truncated** (`parseInt((ceLtp+peLtp)*1.25)`), so the stop
sits at most 1 point *below* the mathematical level. Keep the truncation to reproduce fills.

**P8 — `trgUp`/`trgDown` 500 ms re-arm in Idea C** is the debounce that stops a tick storm at a
rung boundary from rolling the ladder dozens of times. Any rewrite needs an equivalent
(price-hysteresis is *not* equivalent — the legacy guard is purely temporal).

**P9 — `farOtm = 0`.** `otmSelector()` is imported in all 20 files but **the call is commented out
everywhere**. Idea B is therefore an **ATM straddle seller**, not an OTM strangle seller, despite
the variable name and despite the `ce_s = atm + farOtm` / `pe_s = atm - farOtm` arithmetic. Do not
"restore" the `otmSelector` call.

**P10 — chain snapshot is taken once at startup and never refreshed.** `chain` is
`optionData.weeklyInstruments` (or `nextWeekInstruments` on the configured weekday), keyed
`"<strike><CE|PE>"`, carrying `instrument_token`, `lot_size`, `tradingsymbol`. Rolling the basket
far enough eventually indexes strikes outside the snapshot — see R6.

**P11 — the `multiplier` argument is a scaler, not a lot count.** Live size is
`multiplier × account.strategy[tag]` per XTS/Spark/Fyers account, tranched by
`maxOrderLots[index]`. `bull-r`'s 7→1 ramp and Idea B's 1,2,3,… ramp are ramps *of the
allocation*, so a 5-lot account running `Bull_R` sells 35 lots on the first straddle.

**P12 — expiry rollover is a weekday flag, not a DTE calculation.** `moment().day() == 3`
(Wednesday) is the only trigger, hardcoded, and only in `bull-300i`, `bulln-300`, `bulln-300i`.
`bull-300`, `bull-m`, `bull-m2`, `bull-x`, `bull-200-1` and every Idea-B member always use the
nearest weekly expiry, i.e. they trade **0-DTE on expiry day**.

**P13 — the `Bull_S-1` / `Bull_S-2` distinction is `currentFuture` vs spot as the trigger.**
This is the only file in the family that derives the ATM from the **monthly future**, which trades
at a basis to spot. Do not collapse it into `Bull_S-2`.

**P14 — `exchange` is hardcoded `"NFO"` in the `paper-trade` doc even for SENSEX (`Bull_SNX-1`).**
`xtsOrder.placeAllAccount` overwrites it to `BSEFO` by tradingsymbol prefix, so live routing is
correct, but the stored order document and any report built from it says NFO. Preserve or fix
deliberately; downstream reporting may depend on it.

---

## 8. Bugs, dead code, dangerous behaviour

**R1 (dangerous, whole family) — no EOD square-off anywhere.**
No slive `bull-*` file has a CronJob. `ob_start.js` `pm2 stop`s the process at **15:23:50 IST**,
which kills the monitor but leaves every short leg open. Positions are carried overnight and, if
nobody calls `PaperTrades.squareoff`, to weekly expiry — on naked short options, including the
deep-ITM baskets of `bull-300i`/`bulln-300i` and the ATM straddles of `bull-x`. The `smp/` siblings
*do* have a 15:22 exit cron; the slive versions had it deleted or commented (`bull-200-1.js`
lines 178-183 are the commented-out cron pair). Highest-priority thing to fix in the rewrite.

**R2 (money bug, `bull-m` / `bull-m2`) — the `perSide` roll orphans 3 short legs on every roll.**
`sendOrder('BUY', atm, 'CE')` closes only the 3 CE legs; the very next statement,
`sendOrder('SELL')`, **overwrites `basket` wholesale** with a new ATM and new triggers. The old
basket's 3 short **PE** legs (at `oldAtm−100/−200/−300`) are never bought back — not by this roll,
not by any later roll, not by any stop, because nothing tracks them any more. Symmetrically, a
PE-side roll orphans 3 short CE legs. Short-option exposure therefore grows by 3 naked legs per
roll, monotonically, all day. `basket.trgUp = false` on the line between is dead (immediately
overwritten). Both `Bull_M` and `Bull_M2` are affected; both are `autostart:false` today.

**R3 (silent death, whole family) — an unguarded tick lookup permanently wedges the
`async.queue`.** `checkSL()` begins with `ticksCache[triggerToken].last_price` (Ideas A, C) or
`ticksCache[order.ce.instrument_token].last_price` (Idea B). If that tick has not arrived, the
expression throws inside the `async` function, so the promise rejects, so the `.then(cb)` worker
callback **never fires**. With `concurrency: 1` the queue's only slot is never released and every
subsequent `push()` piles up forever: the strategy stops checking stops and stops rolling, while
the process stays alive and "running" in pm2, holding naked shorts. The first tick batch of the
day frequently contains only option ticks, so this is a live failure mode, not a theoretical one.
Only `bull-m`/`bull-m2` guard the *entry* path (`if (!bn_quote || !bn_quote.last_price) retry in
5 s`); **no file guards the exit path**. Under Node ≥15 the unhandled rejection may instead kill
the process outright, which is the *less* bad outcome.

**R4 (dead code, Ideas A/C/D) — the crossover entry logic never runs.** `takePositionQ` is
declared in `bull-300*`, `bulln-300*`, `bull-m*`, `bull-x`, `bull-200-1` but **`checkTicks` never
pushes to it** (only `checkSLQ`). The entire `isCrossover` block in those 10 files is unreachable;
entry is exactly one forced call from the 15 s timer. Anyone reading the file assumes it
re-enters on crossovers. It does not.

**R5 (crash / partial basket) — undefined chain lookups are unguarded.**
`chain[strike]` returns `undefined` for any strike outside the snapshot, and
`PaperTrade.trackOrder(undefined, …)` throws on `optionInstrument.tradingsymbol`. Because
`trackOrder` is an un-awaited `async` function, the rejection is silent and the loop continues:
the basket is placed **partially**, with no log and no alert. Idea B is worse — it dereferences
`ticksCache[ce.instrument_token]` *before* the `openStrikes` guard, so a missing tick throws
inside `takeTrade` and wedges `takePositionQ` per R3.

**R6 (structural) — the basket can walk off the end of the snapshot.** `chain` is captured once.
Idea A/C roll indefinitely (`R7` in `bull-x`: `strike_plus_300 += 300` with no bound), so on a
large trending move the required strikes stop existing in the snapshot, and per R5 the roll
silently places only the legs it can find — closing part of the old basket and opening part of a
new one. There is no `maxRolls`, no distance-from-open cap, and no alert.

**R7 (`bull-200-1`) — `pickByPremium` degrades to garbage when ticks are missing.**
The fallback is `c.distance = price`, i.e. *every* untick'd instrument gets the identical distance
`target`. The sort is then effectively arbitrary among them, and the first CE / first PE in that
arbitrary order is selected. At t+15 s the option chain is typically only partially ticked, so the
strategy can sell far-off strikes at 0.05 premium. (Independently: two different premium targets
can resolve to the **same strike**, silently doubling that leg.)

**R8 (`bull-200-1`, unresolved intent) — the stop flips to the opposite option type.** A stopped
CE is replaced by a fresh **PE** at the same premium band and vice versa, which sells *more* of the
side that is winning against you… i.e. it re-shorts into the trend on the far side while removing
protection-by-symmetry. Combined with per-leg absolute +50 stops (a 50 % stop on a 100-premium
leg, 25 % on a 200-premium leg), this makes the book progressively one-sided. Encode as a flag,
do not silently "fix".

**R9 (unbounded risk, Idea B) — pyramid-up has no cap.** `currentSize += 1` on every accepted
entry, forever. There is no `sizeCap`, no daily loss limit, no max-open-straddles limit. On a
choppy BANKNIFTY day that oscillates across a 100-point boundary, the 15th straddle is 15×
allocation. `bull-r` is the mirror image and is *safe by construction* (7→0), which is almost
certainly why it exists.

**R10 (`bull-s5-1` ≡ `bull-s5-2`, `bull-fs-1` ≡ `bull-fs-2`, `bull-ms-1` ≡ `bull-ms-2`,
`bull-ns-1` ≡ `bull-ns-2`, `bull-m` ≡ `bull-m2`) — five byte-identical pairs.** Ten files, five
behaviours. Each pair is two pm2 processes, two Zerodha logins, two full-chain websockets, and two
PnL tags for the same rules. Under the target design these are one config with two instance names
(or one instance with double allocation).

**R11 (`optionInstruments.js`) — stale-chain landmine.** `config(underlying)` does
`require('../../optionConfig_<UNDERLYING>.json')` and returns it **if the file exists**, with no
date check; it only hits the network when the `require` throws. There is **no scheduled
`download()`** anywhere in the boot path (the cron in `optionInstruments.js` line 155 is commented
out). If a stale file is left in the repo root, every `bull-*` process silently trades **last
week's expired instrument tokens**. No file currently exists, so today it downloads — that is luck,
not design. The rewrite's market-data service must own chain freshness.

**R12 (operational) — 20 processes, 20 Zerodha logins on the SAME master account, 19 full-chain
websockets.** Each file calls `zerodha_init(base_acc)`, which **mutates and `save()`s the shared
master `Account` document** (`lastLogin`, `config`) and then opens its own `KiteTicker` subscribed
to the *entire* weekly option chain plus the trigger token (only `bull-m`/`bull-m2` subscribe the
trigger token alone). Concurrent `account.save()` from 20 processes is a lost-update race on the
credential document. This is the single strongest argument for the shared tick bus in the target
architecture.

**R13 — `zerodha_init` failure is ignored.** It returns `false` on a failed login, and every caller
does `zapi = await zerodha_init(base_acc)` without checking. `ticker()` then connects with an
undefined/stale `public_token`, no ticks arrive, and the strategy sits silent — or throws per R3.

**R14 — implicit globals from `atm = optionOrders.atm` in a call argument.**
`bull-300.js:146` and `bull-m.js:151/155` write `sendOrder('BUY', atm = optionOrders.atm, …)`,
which in sloppy mode creates/assigns a **global** `atm`. It happens to evaluate to the right value,
so behaviour is correct, but it leaks module state; `bulln-300`, `bulln-300i` and `bull-x` were
already corrected to `optionOrders.atm`. Also `bull-200-1.js:108` uses `for (i = 0; …)` — another
implicit global.

**R15 — array holes and unbounded growth.** Idea B does `delete optionOrders[idx]`, Idea D does
`openLegs[i] = null`; neither compacts, so both arrays grow monotonically for the session and every
tick iterates the whole thing (Idea D re-reads `openLegs.length` each iteration, so replacements
appended during a pass are also checked in that pass — harmless only because a just-opened leg
cannot already be `entry+50`).

**R16 — `MIDCPNIFTY` strike step is wrong.** `bull-ms-1`/`-2` round to 50 while MIDCPNIFTY strikes
are 25 apart. Every 50-multiple is a valid strike, so nothing crashes; the strategy just ignores
half the available ATMs and can be up to 25 points off the true ATM. Also, the FINNIFTY and
MIDCPNIFTY weekly expiries were discontinued/changed by the exchange — these six files may be
trading a contract that no longer exists (they are all `autostart:false`).

**R17 — dead imports/state in all 20 files.** `CronJob`, `notify`, `moment` (except the three
next-week-roll files), `otmSelector`; and the variables `channelId`, `accounts`,
`running_accounts`, `account_quantities`, `firstRun`, `init_pending`, `bn_ltp` (Idea B). Notably
**`notify` is imported and never called**: this family runs completely silently — no alert on
entry, roll, stop, missing instrument, or wedged queue.
