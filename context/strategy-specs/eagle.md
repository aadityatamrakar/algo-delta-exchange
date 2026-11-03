# Family spec: `eagle-*` — delta-rebalancing short-straddle accumulator

**Scope:** `server/slive/eagle-{s-1,s-2,s-3,s-4,p-1,ns-1,ns-2,fs-1,fs-2,ms-1,ms-2,snx-1}.js` (12 files, 199–205 LOC each).
**Staging twins (same engine, cron-wrapped):** `server/smp/eagle-{s,p,ns,snx,fs,ms}.js`.
**Verified:** 2026-07-25. All line references are against `server/slive/eagle-s-1.js` unless noted.

---

## 0. TL;DR

Two ideas, both the same engine:

| Idea | Files | What differs |
| --- | --- | --- |
| `eagle-straddle-rebalance` | 11 | On each trigger it adds **ONE** option leg on the side that restores delta. |
| `eagle-straddle-rebalance-pair` | 1 (`eagle-p-1`) | On each trigger it adds **BOTH** a CE and a PE (2 legs), and has the Wednesday next-expiry roll **active**. |

Everything else across all 12 files is constants: underlying, spot-vs-future reference token, strike step, premium floor.

**There is no exit anywhere in any eagle file.** Zero `BUY` orders, zero cron, zero stop, zero target, zero time exit. Flattening is entirely delegated to `server/scripts/squareoff_smp.js` (15:24:00 IST, Mon–Sat), which walks *every* tag's net paper positions and emits the opposing order onto the same bus. That is deliberate — but it means the family has **no intraday risk control of any kind**.

---

## 1. Runtime shape (identical in all 12 files)

```
process start (pm2)                        # module top-level, line 199: runStrategy()
  └─ runStrategy()
       optionData        = await optionConfig(UNDERLYING)      # tools/optionInstruments.js
       futureToken       = REFERENCE_TOKEN                     # per-file, see table
       currentExpiryOptions = optionData.weeklyInstruments     # == NEAREST expiry, not necessarily weekly
       if (WED_ROLL && moment().day() === 3)                   # only eagle-p-1
            currentExpiryOptions = optionData.nextWeekInstruments
       base_acc = await Account.findById(app.get('masterId'))
       zapi     = await zerodha_init(base_acc)                 # login ONLY to mint a public_token for the tick socket
       ticker([REFERENCE_TOKEN, ...all nearest-expiry option tokens])   # KiteTicker, modeFull, auto-reconnect on
       setTimeout(takeTrade, 15000)                            # see RISK-2: unqueued duplicate-entry path
```

Tick handler (line 78):

```
checkTicks(ticks):
    ticksCache = { ...ticksCache, ...byToken(ticks) }          # last tick wins, never expires
    if (init_pending) takePositionQ.push()                     # serial async.queue, concurrency 1
    else             checkSLQ.push()                           # serial async.queue, concurrency 1
```

`init_pending` starts `true` and is set `false` exactly once, the instant the entry trigger fires. It is the **only** state machine: phase 1 = hunt for entry, phase 2 = manage add-triggers forever. `takeTrade` is never called again after phase 2 begins (except via the stray `setTimeout`).

**No `CronJob` is ever instantiated** in any slive eagle file — `require("cron")` on line 1 is dead. The process lifecycle *is* the schedule:

- `server/tools/ob_start.js:38` — `09:15:30 IST Mon–Fri`: `pm2 restart` every `strategies.json` entry with `autostart:true`.
- `server/tools/xtsOrder.js:329` — `every minute Mon–Fri`: restart entries whose `delay_start` equals now (no eagle entry has `delay_start`).
- `ob_start.js:39` — `15:23:50 IST`: `pm2 stop` **all** strategies.
- `server/scripts/squareoff_smp.js:54` — `15:24:00 IST Mon–Sat`: flatten everything.

The 10-second gap between "stop the strategies" and "flatten" is the only thing preventing eagle from adding legs while squareoff is mid-flight. Preserve that ordering.

The `smp/` twins replace the bare `runStrategy()` call with `new CronJob('45 16 9 * * 1-5', runStrategy)` (09:16:45 IST) plus a `15:22:00` self-exit — the same lifecycle expressed in-file.

---

## 2. Canonical algorithm (pseudocode)

```
CONFIG
  underlying        : 'BANKNIFTY' | 'NIFTY' | 'FINNIFTY' | 'MIDCPNIFTY' | 'SENSEX'
  referenceToken    : number            # what "spot" means: index token OR monthly-future token
  strikeStep        : 50 | 100
  offset            : 0                 # farOtm — hard 0 in every file (see DEAD-1)
  premiumFloor      : 10 | 20           # rupees; minimum premium to justify an add
  addMode           : 'single' | 'pair'
  rollToNextExpiryOnWednesday : bool
  lots              : 1                 # trackOrder multiplier default; per-account scaling is downstream
  tag               : string            # e.g. 'Eagle_S-1'

STATE
  ticksCache   : Map<token, Tick>
  initPending  : bool  = true
  lastQuote    : number = 0             # shared by BOTH phases; see RISK-3
  pending      : SparseArray<{ trg:number, action:'add_ce'|'add_pe' }> = []

# ---------------- PHASE 1: entry ----------------
onTick (while initPending):                                  # takeTrade(), line 96
    px  = ticksCache[referenceToken].last_price               # THROWS if absent -> RISK-1
    atm = round(px / strikeStep) * strikeStep

    crossed = (px >= atm && lastQuote <= atm)                 # up-cross of the ATM line
           || (px <= atm && lastQuote >= atm)                 # down-cross of the ATM line
    lastQuote = px

    if crossed:
        initPending = false                                   # set BEFORE the order — ordering is load-bearing
        emit('pair')

# ---------------- PHASE 2: manage ----------------
onTick (while !initPending):                                  # checkSL(), line 180
    px = ticksCache[referenceToken].last_price
    for (idx, order) in pending:                              # holes skipped
        if order.trg is between lastQuote and px (inclusive, EITHER direction):
            emit(order.action)                                # fire-and-forget, not awaited
            delete pending[idx]                               # consumed; array never compacted
    lastQuote = px

# ---------------- order emitter ----------------
emit(type):                                                   # sendOrder(), line 120
    px  = ticksCache[referenceToken].last_price
    atm = round(px / strikeStep) * strikeStep

    if type == 'pair':
        ce = chain[(atm + offset) + 'CE']                     # offset == 0 -> a STRADDLE, not a strangle
        pe = chain[(atm - offset) + 'PE']
        ceLtp = ticksCache[ce.token].last_price
        peLtp = ticksCache[pe.token].last_price

        SELL ce, 1 lot                                        # no premium floor on the initial pair
        SELL pe, 1 lot
        pending.push({ trg: int(px - ceLtp), action: 'add_ce' })   # BELOW  spot
        pending.push({ trg: int(px + peLtp), action: 'add_pe' })   # ABOVE  spot

    if type == 'add_ce':
        ce = chain[(ceil(px / strikeStep) * strikeStep) + 'CE']    # nearest strike AT-OR-ABOVE spot
        ceLtp = ticksCache[ce.token].last_price
        if ceLtp > premiumFloor:
            SELL ce, 1 lot
            if addMode == 'pair':
                pe = chain[(floor(px / strikeStep) * strikeStep) + 'PE']
                SELL pe, 1 lot                                     # eagle-p-1 only
            pending.push({ trg: int(px - ceLtp), action: 'add_ce' })
            pending.push({ trg: int(px + ceLtp), action: 'add_pe' })   # NOTE: ceLtp, not peLtp
        # else: nothing emitted AND no new pending triggers -> this branch dies silently

    if type == 'add_pe':
        pe = chain[(floor(px / strikeStep) * strikeStep) + 'PE']   # nearest strike AT-OR-BELOW spot
        peLtp = ticksCache[pe.token].last_price
        if peLtp > premiumFloor:
            SELL pe, 1 lot
            if addMode == 'pair':
                ce = chain[(ceil(px / strikeStep) * strikeStep) + 'CE']
                SELL ce, 1 lot                                     # eagle-p-1 only
            pending.push({ trg: int(px + peLtp), action: 'add_pe' })
            pending.push({ trg: int(px - peLtp), action: 'add_ce' })

# ---------------- exit ----------------
# (none — intentionally absent from the strategy)
```

### 2.1 What the trigger geometry actually means

The catalog wording ("as spot approaches within either leg's own premium distance, sell one more leg") is directionally misleading. The precise semantics:

- A **fall** of one CE-premium width from the last action point → **sell another CE** (short delta added).
- A **rise** of one PE/CE-premium width from the last action point → **sell another PE** (long delta added).

So eagle sells the *opposite* wing into the move. Mechanically it is a crude **delta re-neutralisation ladder**: when the market drops, the short PE goes ITM and the book gets long delta, so eagle sells CEs to flatten it; when the market rises, the short CE goes ITM and the book gets short delta, so it sells PEs. Because the leg count only ever grows, the book gets progressively more short-gamma and short-vega, with the rebalance step size shrinking as premiums shrink (adds cluster tighter and tighter until the premium floor stops them).

### 2.2 Trigger-population arithmetic — the compounding mechanism

- `'pair'` consumes **0** pending triggers and creates **2**.
- every successful `add_*` consumes **1** and creates **2** → net **+1** pending trigger per fill.
- a rejected `add_*` (premium ≤ floor, missing strike, missing tick) consumes **1** and creates **0**.

Triggers fire on crossing in **either** direction, so a range-bound tape re-crosses the same accumulating grid of levels repeatedly. Leg count is therefore super-linear in realised path length, not in net move. There is no cap on leg count, no cap on notional, no cap on margin, and no cap on the size of `pending`.

The **only** natural brake is `premiumFloor` (Rs 10/20): once every reachable near strike prints below the floor — typically only on expiry afternoon — new adds stop.

---

## 3. Member-file table

`step` = strike rounding; `ref` = the token whose `last_price` is treated as "spot"; `floor` = premium floor for adds.

| File | Tag | Underlying | `optionConfig()` arg | `ref` token | `ref` is | step | floor | addMode | Wed roll | `strategies.json` autostart |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `eagle-s-1.js` | `Eagle_S-1` | BANKNIFTY | *(default)* | `optionData.currentFuture.token` | **monthly FUTURE** | 100 | 20 | single | off (commented) | **true** |
| `eagle-s-2.js` | `Eagle_S-2` | BANKNIFTY | *(default)* | `260105` | index spot | 100 | 20 | single | off | false |
| `eagle-s-3.js` | `Eagle_S-3` | BANKNIFTY | *(default)* | `260105` | index spot | 100 | 20 | single | off | false |
| `eagle-s-4.js` | `Eagle_S-4` | BANKNIFTY | *(default)* | `260105` | index spot | 100 | 20 | single | off | false |
| `eagle-p-1.js` | `Eagle_P-1` | BANKNIFTY | *(default)* | `260105` | index spot | 100 | 20 | **pair** | **ON** | false |
| `eagle-ns-1.js` | `Eagle_NS-1` | NIFTY | `"NIFTY"` | `256265` | index spot | 50 | **10** | single | off | false |
| `eagle-ns-2.js` | `Eagle_NS-2` | NIFTY | `"NIFTY"` | `256265` | index spot | 50 | **10** | single | off | false |
| `eagle-fs-1.js` | `Eagle_FS-1` | FINNIFTY | `'FINNIFTY'` | `257801` | index spot | 50 | 20 | single | off | false |
| `eagle-fs-2.js` | `Eagle_FS-2` | FINNIFTY | `'FINNIFTY'` | `257801` | index spot | 50 | 20 | single | off | false |
| `eagle-ms-1.js` | `Eagle_MS-1` | MIDCPNIFTY | `'MIDCPNIFTY'` | `288009` | index spot | 50 | 20 | single | off | false |
| `eagle-ms-2.js` | `Eagle_MS-2` | MIDCPNIFTY | `'MIDCPNIFTY'` | `288009` | index spot | 50 | 20 | single | off | false |
| `eagle-snx-1.js` | `Eagle_SNX-1` | SENSEX | `'SENSEX'` | `265` | index spot | 100 | 20 | single | off | false |

Non-behavioural diffs (ignore when porting): the `ns/fs/ms/snx` set writes `require('../lib/KiteTicker.js')` with the `.js` suffix; `snx-1` and `p-1` carry one extra blank line. `eagle-s-{2,3,4}` and `eagle-ns-{1,2}`, `eagle-fs-{1,2}`, `eagle-ms-{1,2}` are byte-identical to their `-1`/`-2` sibling except for `strategyTag`.

`eagle-s-1` was switched from `260105` → `currentFuture.token` in commit `711efd04` (2025-02-06), i.e. after NSE withdrew BANKNIFTY weekly options. Every other BANKNIFTY member still reads index spot. Treat "reference price source" as a first-class config axis, not an accident.

---

## 4. Config axes

```ts
interface EagleConfig {
  tag: string;                     // 'Eagle_S-1' ... — also the bus routing key
  underlying: 'BANKNIFTY' | 'NIFTY' | 'FINNIFTY' | 'MIDCPNIFTY' | 'SENSEX';
  referenceSource: 'index' | 'monthly-future';   // eagle-s-1 is the only 'monthly-future'
  referenceToken: number;          // 260105 | 256265 | 257801 | 288009 | 265 | <resolved FUT token>
  strikeStep: 50 | 100;
  offset: number;                  // farOtm; 0 in all 12 files
  premiumFloor: number;            // 10 (NIFTY) | 20 (all others)
  addMode: 'single' | 'pair';      // 'pair' only in eagle-p-1
  rollToNextExpiryOnWednesday: boolean;  // true only in eagle-p-1
  lots: number;                    // 1 everywhere
  startupDelayMs: number;          // 15000 (the stray setTimeout)
}
```

All 12 files are `{underlying, referenceSource, referenceToken, strikeStep, premiumFloor, addMode, rollToNextExpiryOnWednesday, tag}` tuples over one function body. The remaining implicit axes are **not** in the files and must become config in the rewrite: exit policy (currently `none`), max leg count (`Infinity`), max notional (`Infinity`), per-leg stop (`none`).

---

## 5. Execution rail

**Bus-routed, order-intent only.** Every order is:

```js
PaperTrade.trackOrder(optionInstrument, "SELL", strategyTag)   // multiplier defaults to 1
```

`common/models/paper-trade.js:61` inserts into the MongoDB `paper-trade` collection:

```
{ status:"COMPLETE", order_type:"MARKET", exchange:"NFO", transaction_type:"SELL",
  tradingsymbol, instrument_token, quantity: lot_size*1, filled_quantity: lot_size*1, tag }
```

Note: the **legacy** `trackOrder`, not `trackOrder_v2` — it has no `dataObj` field and no `average_price`. Four independent change-stream consumers watch that collection:

| Consumer | Effect |
| --- | --- |
| `server/boot/paperstream.js:438` → `handleInsertEvent(PaperTrade, event, 4)` | Simulator. Stamps `average_price` via `lib/fill-price.js#resolveFill` using level-**4** of the bid book (`depth.buy[4].price`, only when > 50), else `last_price`, else the `0.05` fallback. Also backfills `instrument_token`. |
| `server/tools/xtsOrder.js:233` | **Real** XTS/Jainam order, gated on `runningStrategies[tag] > 0` (i.e. some `xtsAccount.strategy['Eagle_*']` is a positive lot count). Live lots = `(quantity / lot_size) * account.strategy[tag]`, tranched at `maxOrderLots[index]`. Rewrites `exchange` to `BSEFO` for SENSEX, `NSEFO` otherwise. |
| `server/tools/sparkOrder.js:62` | **Real** Spark order. |
| `server/tools/fyersOrder.js:56` | **Real** Fyers order. |

So eagle's per-strategy size is fixed at **1 lot per order**; real-money sizing lives entirely in the broker-account `strategy` map. `exchange:"NFO"` written for SENSEX legs is wrong at the document level but corrected by every live consumer.

### 5.1 Exit rail (the only exit)

`server/scripts/squareoff_smp.js:37-51`, cron `0 24 15 * * 1-6` (**15:24:00 IST, Mon–Sat**):

```js
Papertrade.positions(function (err, data) {
  Object.keys(data.positions).forEach((strategy) => {
    ...filter(pos => pos.quantity != 0).forEach(order =>
      Account.trackOrder({ instrument_token, tradingsymbol,
                           lot_size: Math.abs(order.quantity) },
                         order.quantity > 0 ? 'SELL' : 'BUY', strategy));
  });
});
```

`Account.trackOrder` (`common/models/account.js:112`) writes back onto the *same* `paper-trade` collection, so the flattening order re-enters the bus and reaches the real brokers. `Papertrade.positions` only aggregates **today's** documents (`order_timestamp` between start-of-day and end-of-day), which is safe because eagle never carries positions overnight — but only because squareoff runs every day. If squareoff misses a day, the next day's `positions()` cannot see yesterday's legs and they are silently orphaned.

---

## 6. MUST-PRESERVE behaviours

1. **One-shot entry latch.** `init_pending` flips `false` *before* the order is emitted (line 109 precedes line 110). The whole "exactly one initial straddle per process lifetime" property depends on this ordering and on `checkTicks` routing to `checkSLQ` afterwards. In the class, this is `if (this.phase !== 'entry') return;` at the top of the entry handler.
2. **`lastQuote` is a single shared cursor across both phases.** After the entry fires, `lastQuote` still holds the *previous* tick's price, and the very first `checkSL()` pass uses that stale value as the low/high bracket. The initial pair's own triggers (`px ± premium`) are far enough away that this is harmless in practice, but a rewrite that resets the cursor changes first-tick behaviour. Keep one cursor.
3. **Bidirectional trigger firing.** `trg` fires when it lies between `lastQuote` and the current price in **either** direction. Do not turn this into a one-sided "crossed down through" test — a large chunk of the fill population comes from re-crossings in a range.
4. **Triggers are consumed, never re-armed.** Exactly one fill per `trg`, and the array is left sparse (`delete`, not `splice`). If you compact the array, indices shift inside the same iteration and you will double-fire or skip. Model this as an explicitly-keyed set with an idempotency id.
5. **Rejected adds prune their branch.** When `premium <= floor`, or the strike is absent from the chain, or the strike has no tick, the trigger is still consumed and **no** replacement triggers are pushed. That branch of the ladder dies permanently. This is what stops runaway growth near expiry; do not "fix" it into a retry.
6. **The initial pair has no premium floor.** Only `add_ce`/`add_pe` are gated. Reproduce exactly.
7. **`offset` (`farOtm`) is 0.** The advertised strangle is a **straddle**: `ce_s = atm + 0`, `pe_s = atm - 0`. `otmSelector` is imported and the call is commented out (line 64). Any rewrite must default `offset: 0`, and must not "restore" the `otmSelector` call — `otmSelector('Eagle_*')` falls through every branch and returns `undefined`, which would produce `NaN` strikes.
8. **Add strikes use `ceil` for CE and `floor` for PE, not `round`.** The add always sells the strike on the far side of spot (CE at-or-above, PE at-or-below) — a different rule from the `round`-based entry. Preserve both roundings.
9. **`add_ce`'s follow-up `add_pe` trigger is spaced by the CE premium** (`px + ceLtp`), and `add_pe`'s follow-up `add_ce` by the PE premium. Only the initial `'pair'` uses each side's own premium for its own side. This asymmetry is in the shipped code and materially affects trigger spacing.
10. **Fill price comes from bid level 4.** `handleInsertEvent(PaperTrade, event, 4)` + the `> 50` guard in `resolveFill` — for cheap legs (premium ≤ 50) the simulator uses `last_price` instead of the depth level. Any backtester must replicate this or its P&L will not match the recorded paper history.
11. **Reference token is subscribed alongside the option chain in one call:** `ticker([futureToken, ...optionTokens])`, `modeFull` (needed for `depth`). KiteTicker auto-reconnect is on and the `connect` handler re-subscribes, so a socket drop self-heals; the ticks missed during the drop are simply never seen (triggers spanning the gap fire on the first tick after reconnect, because the bracket test uses the stale `lastQuote`). Keep that "catch up on the next tick" property.
12. **`ticksCache` entries never expire.** A strike that ticked once at 09:20 and went dead is still quoted at 09:20's price at 15:00. Adds can therefore be priced off arbitrarily stale ticks. Present behaviour; flag it, don't silently change it.
13. **Nearest-expiry only.** `weeklyInstruments` is literally `expiryDateSorted[0]` — nearest expiry, whatever its tenor. `nextWeekInstruments` is `expiryDateSorted[1]`. The `rollToNextExpiryOnWednesday` flag swaps the whole chain at *process start only*; it never re-evaluates intraday, and it never rolls existing positions.
14. **Stop-then-squareoff ordering.** Strategies are `pm2 stop`ped at 15:23:50 and squareoff runs at 15:24:00. The runner must keep a guaranteed quiescent window before central flattening, or squareoff will race a fresh add.
15. **The strategy is the sole writer of its tag.** `Papertrade.positions()` nets by `tag` + `tradingsymbol`. Two processes sharing a tag would corrupt the net position that squareoff reads. `strategies.json` gives each file a unique tag; keep tag uniqueness a hard invariant in the config record.

---

## 7. Risks, bugs, dead code

### RISK-1 (severe) — a missing reference tick permanently stalls the strategy

`takeTrade()` line 97 and `checkSL()` line 181 both do `ticksCache[futureToken].last_price` with no guard. If the reference token has not yet ticked (first tick batch, or the token is not actually subscribed/valid), this throws a `TypeError` inside the `async.queue` worker:

```js
var takePositionQ = async.queue(function (task, callback) {
  takeTrade().then(function (res) { callback(); });   // no .catch
}, 1);
```

The rejection means `callback()` is never invoked. With `concurrency: 1` the queue is **permanently blocked** and every subsequent tick pushes another task that will never run — a dead strategy plus an unbounded task-list leak, with only an `UnhandledPromiseRejection` on stderr. Identical shape in `checkSLQ` (line 193). A single mid-session gap in the reference token's feed is enough to kill the manage phase while the position stays open and unmanaged. **This is the highest-priority defect in the family.**

### RISK-2 (moderate) — `setTimeout(takeTrade, 15000)` can double the initial straddle

`runStrategy` schedules an **unqueued** `takeTrade` at T+15s (line 70), but `checkTicks` already drives `takeTrade` through `takePositionQ` from the first tick. `takeTrade` does not check `init_pending`; it only *writes* it. So if the crossover condition happens to be true again at T+15s, a **second** `'pair'` is emitted — two straddles and four pending triggers instead of one and two. The 15 s timer also throws (RISK-1) if no reference tick has arrived, though outside the queue so it does not stall anything.

### RISK-3 (moderate) — the first evaluation fires on `lastQuote === 0`, not on a real crossover

`lastQuote` is initialised to `0`. On the very first evaluation, `px >= atm && lastQuote <= atm` reduces to `px >= atm`, which is true whenever `round()` rounded *down* — i.e. roughly half the time. So ~50% of sessions enter **immediately at startup** rather than on an actual ATM crossing. If instead `round()` rounded up, the branch is skipped and the strategy waits for a genuine cross. Whether this is intended (a "start immediately-ish" behaviour) or a bug must be decided explicitly in the rewrite; either way it is a coin-flip on entry semantics and needs a config flag (`enterOnFirstTick: boolean`).

### RISK-4 (severe) — silent dead state if the ATM strike is absent from the chain

`sendOrder('pair')` is called **without `await`** from `takeTrade`, *after* `init_pending = false`. If `currentExpiryOptions[atm + 'CE']` is `undefined` (spot outside the downloaded chain range, or a stale `optionConfig_*.json`), line 128 throws inside the un-awaited promise. Result: `init_pending` is already `false`, no legs were sold, `optionOrders` is empty — the process sits idle all day doing nothing, with only an unhandled-rejection log. Same failure mode, less severe, for `add_*` (trigger consumed, branch pruned, no order).

### RISK-5 (severe) — stale option chain from the on-disk cache

`tools/optionInstruments.js#config()` does `require('./../../optionConfig_' + underlying + '.json')` and returns it if the file exists — **only** falling back to a live `download()` when the `require` throws. `paperstream.js` refreshes `BANKNIFTY`, `NIFTY`, `SENSEX` at boot and again at 07:30 IST, but the `MIDCPNIFTY` and `FINNIFTY` downloads are **commented out** (`paperstream.js:316,323`). So `eagle-ms-*` / `eagle-fs-*` read whatever `optionConfig_MIDCPNIFTY.json` / `optionConfig_FINNIFTY.json` happens to be on disk — potentially an expired expiry with dead instrument tokens. Combined with RISK-4 that yields a silent no-op, or worse, orders in an expired series.

### RISK-6 (severe) — FINNIFTY / MIDCPNIFTY legs fill at Rs 0.05 in the simulator

`paperstream.js` builds `symbolTokenMap` from **only** `[BANKNIFTY, NIFTY, SENSEX]` option data (line 337) and the `ticker_m` / `ticker_fn` subscriptions are commented out (lines 347–348). `resolveFill` therefore finds no tick and no symbol mapping for a FINNIFTY/MIDCPNIFTY option and returns the `price = 0.05` fallback. **All recorded paper P&L for `Eagle_FS-*` and `Eagle_MS-*` is meaningless** (every short leg booked at 5 paise). Do not use it to validate the rewrite.

### RISK-7 (high) — the Wednesday roll in `eagle-p-1` is calendar-obsolete

`if (moment().day() == 3) currentExpiryOptions = optionData.nextWeekInstruments;` was added on 2023-09-05 (`bcd4126d`), when NSE had just moved BANKNIFTY weekly expiry to Wednesday — i.e. "on expiry day, trade the next series instead". NSE withdrew BANKNIFTY weekly options entirely in Nov 2024, so `expiryDateSorted[0]` for BANKNIFTY is now the nearest **monthly** and `[1]` the following monthly. On any Wednesday, `eagle-p-1` now sells a chain 4–5 weeks out with no expiry-day rationale at all. The condition must become `isExpiryDay(chain)`, not `day() === 3`.

Same class of drift affects the premium floors: Rs 20/Rs 10 were calibrated against weekly ATM premiums. BANKNIFTY, FINNIFTY and MIDCPNIFTY now have monthly-only options whose premiums stay far above the floor for weeks, so the family's only brake on leg accumulation is effectively disabled for 9 of the 12 files. Only `eagle-ns-*` (NIFTY) and `eagle-snx-1` (SENSEX) still see true weeklies.

### RISK-8 (high) — unbounded growth, no risk limits

No cap on leg count, notional, margin, or `optionOrders.length`. `delete optionOrders[idx]` leaves a permanently-growing sparse array that `forEach` re-walks on **every tick** — O(total triggers ever created) per tick. No stop-loss, no max-loss, no leg limit, no delta/margin check. A trending day pins the book against a wall of ITM shorts with the *only* relief being the 15:24 central squareoff. Any TypeScript rewrite must add `maxLegs`, `maxLossRupees`, and a per-leg stop as first-class config, defaulted to the legacy `Infinity`/`none` so behaviour is bit-comparable, then tightened deliberately.

### RISK-9 (moderate) — restart loses all state

pm2 `restart` (the ordinary intraday recovery action, and the mechanism `Manager.restart` uses from the UI) re-executes the module: `optionOrders = []`, `init_pending = true`, `lastQuote = 0`. The process then takes a **brand-new** straddle on top of the still-open pre-restart book, and every pre-restart pending trigger is forgotten forever. Nothing is persisted and nothing is reconciled against `Papertrade.positions()`. The rewrite must rehydrate open legs and pending triggers from the store, or refuse to enter when the tag already has a non-zero net position.

### RISK-10 (moderate) — `MIDCPNIFTY` strike step is likely wrong

`eagle-ms-*` uses `strikeStep = 50` while the MIDCPNIFTY chain is quoted at 25-point intervals (verify against `optionConfig_MIDCPNIFTY.json`). Multiples of 50 are a subset of multiples of 25, so the lookup succeeds and nothing crashes — but the "ATM" strike can be 25 points off, and the `ceil`/`floor` add strikes skip every other available strike.

### RISK-11 (low) — futures/spot basis skew in `eagle-s-1`

`eagle-s-1` alone rounds the **monthly future's** price to derive the strike (`round(futPx/100)*100`) and then looks that strike up in the **option** chain. With BANKNIFTY futures typically 50–200 points above spot, `eagle-s-1`'s "ATM" is systematically one or two strikes above the true spot ATM, and its crossover line is a futures level, not a spot level. Intentional or not, it makes `eagle-s-1` a materially different strategy from `eagle-s-{2,3,4}` despite the byte-level near-identity — do not collapse them onto one config value.

### RISK-12 (low) — non-unique `orderUniqueIdentifier` on the XTS rail

`xtsOrder.js` builds `orderUniqueIdentifier: [strategyTag, ...dataObj].join('|')` and eagle's legacy `trackOrder` sends **no** `dataObj`, so every eagle order for a given tag carries the identical identifier. Eagle emits dozens of orders per tag per day. Any downstream dedup or reconciliation keyed on that field will collapse them.

### RISK-13 (low) — `exchange` hardcoded to `"NFO"` for SENSEX

`trackOrder` writes `exchange:"NFO"` unconditionally; `eagle-snx-1` sells BFO instruments. Every live consumer overrides it (`xtsOrder.js:101`), so it is currently cosmetic — but the stored document is wrong and any new consumer that trusts the field will mis-route.

### Dead code / dead config

- **DEAD-1** `const otmSelector = require('../lib/otmSelector')` — imported in all 12 files, and `// farOtm = otmSelector();` (line 64) is commented out. `farOtm` is a hard `0`. Note that even if uncommented, `otmSelector('Eagle_*')` matches no branch and returns `undefined` → `NaN` strikes → total failure. Delete the import.
- **DEAD-2** `const CronJob = require("cron").CronJob` (line 1) — never used in any slive eagle file. (It *is* used in the `smp/` twins.)
- **DEAD-3** `const notify = require("../lib/notify.js")` (line 2) — never called. The family is completely silent: no start, error, fill or leg-count alert ever reaches Telegram.
- **DEAD-4** `let accounts = [], running_accounts = [], account_quantities = {}, firstRun = true;` (lines 47–50) — all four written once at declaration and never read. Copy-paste residue from the `placeAllAccount` (Zerodha direct) family.
- **DEAD-5** `let zapi` (line 18) is assigned from `zerodha_init()` and never used. The Zerodha login exists **only** to obtain `public_token` for the KiteTicker socket — but note it has a real side effect: it mutates and `save()`s the master `Account` document (`lastLogin`, `config`). Twelve eagle processes plus every other slive strategy all write that same document at startup.
- **DEAD-6** `let channelId = 0` (line 14) — only ever a would-be argument to the unused `notify`.
- **DEAD-7** `let sl_percent = 1.05` (line 16, commented out) — the fossil of a stop-loss that was removed. Confirms the no-exit design was a decision, not an omission.
- **DEAD-8** `console.log(optionOrders)` at the end of every `sendOrder` (line 176) dumps the entire, monotonically-growing sparse trigger array on every fill. On a busy day this is the dominant log volume.

---

## 8. Implementation notes for the TypeScript class

- One class, `EagleStraddleRebalance`, config-driven; `addMode: 'pair'` covers `eagle-p-1`. No subclass is warranted.
- Inject the feed (`onTick(tick)`) and the order sink (`sink.sell(instrument, lots, tag)`) so the same class runs live, paper, and backtest. Nothing in the legacy logic reads wall-clock time except the Wednesday roll — replace that with an injected `chainSelector` that answers "nearest or next expiry" from calendar data.
- Replace both `async.queue`s with a single synchronous `onTick` reducer. The queues exist only because the original author made the handlers `async` for no reason — there is not one `await` in `takeTrade`, `checkSL` or `sendOrder`. Removing them removes RISK-1's stall mode entirely.
- Model `pending` as `Map<string, {trigger:number, action:'add_ce'|'add_pe'}>` with generated ids; drop the sparse array.
- Guard every `ticksCache[token]` read; a missing tick must be a no-op with a counter, never a throw.
- Add, defaulted to legacy-equivalent values so a replay is bit-comparable: `maxLegs = Infinity`, `maxLossRupees = Infinity`, `perLegStopPercent = null`, `enterOnFirstTick = true` (matches the `lastQuote = 0` behaviour), `flattenAt = null` (central squareoff owns it). Then tighten them as a separate, reviewed change.
- The backtester must reproduce the fill model from `lib/fill-price.js` at `bidAsk = 4` including the `> 50` guard and the `0.05` fallback, or paper history will not reconcile.
