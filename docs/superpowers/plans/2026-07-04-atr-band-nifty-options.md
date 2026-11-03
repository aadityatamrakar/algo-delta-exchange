# ATR-Band NIFTY Weekly Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a NIFTY-only paper "quick scalp" strategy that buys ATM weekly options on an ATR-band breakout, managed by a premium target, a 60-minute time-stop, and a far-opposite-line candle-close stop, at most one CE and one PE per day.

**Architecture:** A pure decision-logic module (`atr-band-logic.js`, unit-tested with Node's built-in test runner) plus a self-contained launcher (`atr-band-nifty.js`) that owns the KiteTicker, cron schedule, and state machine. The launcher is a near-clone of the existing merged `server/slive/bn-breakout.js` (band-on-spot → buy ATM weekly option → premium target + time-stop + opposite-line stop), differing in the width formula (Wilder ATR), the 2-consecutive-candle entry, the candle-close stop, and one-entry-per-side gating. Paper only.

**Tech Stack:** Node.js v24 (CommonJS), `node:test` + `node:assert`, `cron`, `moment`, the LoopBack `PaperTrade` model, `server/lib/KiteTicker.js`, `server/tools/optionInstruments.js`. Run as a pm2 process.

## Global Constraints

- **Paper only.** Orders go exclusively through `PaperTrade.trackOrder_v2(inst, 'BUY'|'SELL', strategyTag, lots)`. Never call `Account.placeAllAccount` or any live-order path.
- **Zerodha login is read-only** — used only for `historyData` + a KiteTicker `public_token`.
- **Strategy tag:** `ATR_BAND_NIFTY` (verbatim, on every paper order).
- **Spot token:** `256265` (NIFTY 50 index). **Strike step:** `50`. **Underlying:** `'NIFTY'`.
- **Signals/lines are on spot; the trade is the ATM weekly option.** ATM = `Math.round(spotLtp / 50) * 50`, weekly instrument from `optionConfig('NIFTY').weeklyInstruments` keyed by `strike + 'CE'|'PE'`.
- **Fixed sizing:** `lots = 1` (qty = `lot_size * lots`).
- **All times IST** (`Asia/Kolkata`), Mon–Fri. 6-field cron (`sec min hour dom mon dow`).
- **Tests run with:** `node --test server/test/atr-band-logic.test.js`.
- **Follow existing patterns** in `server/slive/bn-breakout.js` and `server/slive/orb-fut-logic.js` — do not restructure surrounding code.

---

### Task 1: Pure logic — ATR chain (trueRange, wilderATR, bandWidth, lines)

**Files:**
- Create: `server/slive/atr-band-logic.js`
- Test: `server/test/atr-band-logic.test.js`

**Interfaces:**
- Consumes: nothing (leaf module, no I/O).
- Produces:
  - `trueRange(high, low, prevClose) -> number`
  - `wilderATR(candles, period=14) -> number|null` — `candles` oldest→newest, each `{high, low, close}`; returns last ATR value, or `null` if `candles.length < period`.
  - `bandWidth(atr, divisor=3) -> number`
  - `lines(anchorClose, width) -> { highLine, lowLine }`

- [ ] **Step 1: Write the failing tests**

Create `server/test/atr-band-logic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const logic = require('../slive/atr-band-logic.js');

test('trueRange: high-low dominates', () => {
  assert.strictEqual(logic.trueRange(12, 9, 11), 3);   // max(3, 1, 2)
});
test('trueRange: gap up dominates', () => {
  assert.strictEqual(logic.trueRange(20, 18, 10), 10); // max(2, 10, 8)
});
test('trueRange: gap down dominates', () => {
  assert.strictEqual(logic.trueRange(9, 5, 12), 7);    // max(4, 3, 7)
});

// Hand-computed Wilder ATR, period 3.
// TR[0]=H-L=2; TR[1]=max(3,1,2)=3; TR[2]=max(1,0,1)=1; TR[3]=max(3,3,0)=3; TR[4]=max(1,0,1)=1
// seed(i0..2)=mean(2,3,1)=2 ; i3=(2*2+3)/3=7/3 ; i4=(7/3*2+1)/3=1.8888...
const atrCandles = [
  { high: 10, low: 8, close: 9 },
  { high: 12, low: 9, close: 11 },
  { high: 11, low: 10, close: 10 },
  { high: 13, low: 10, close: 12 },
  { high: 12, low: 11, close: 11 },
];
test('wilderATR: matches hand-computed value (period 3)', () => {
  const atr = logic.wilderATR(atrCandles, 3);
  assert.ok(Math.abs(atr - 1.8888888888888888) < 1e-9, 'got ' + atr);
});
test('wilderATR: exact seed when candles.length == period', () => {
  const atr = logic.wilderATR(atrCandles.slice(0, 3), 3);
  assert.strictEqual(atr, 2);   // mean(TR[0..2]) = mean(2,3,1)
});
test('wilderATR: null when too few candles', () => {
  assert.strictEqual(logic.wilderATR(atrCandles.slice(0, 2), 3), null);
  assert.strictEqual(logic.wilderATR([], 14), null);
  assert.strictEqual(logic.wilderATR(null, 14), null);
});

test('bandWidth: divides by 3 by default', () => {
  assert.strictEqual(logic.bandWidth(30), 10);
  assert.strictEqual(logic.bandWidth(30, 3), 10);
});
test('lines: anchor +/- width', () => {
  assert.deepStrictEqual(logic.lines(22000, 30), { highLine: 22030, lowLine: 21970 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/atr-band-logic.test.js`
Expected: FAIL — `Cannot find module '../slive/atr-band-logic.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `server/slive/atr-band-logic.js`:

```js
// ATR-Band NIFTY — pure decision logic (no I/O).
// Unit-tested via server/test/atr-band-logic.test.js.

// True Range for one candle given the previous candle's close.
function trueRange(high, low, prevClose) {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

// Wilder ATR over `period` on candles ordered oldest->newest ({high,low,close}).
// Returns the last ATR value, or null if fewer than `period` candles.
function wilderATR(candles, period = 14) {
  if (!candles || candles.length < period) return null;
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) tr.push(candles[i].high - candles[i].low);
    else tr.push(trueRange(candles[i].high, candles[i].low, candles[i - 1].close));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr = atr / period;                                  // seed = SMA of first `period` TRs
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;        // Wilder smoothing
  }
  return atr;
}

// Band half-width.
function bandWidth(atr, divisor = 3) {
  return atr / divisor;
}

// The frozen band lines around an anchor close.
function lines(anchorClose, width) {
  return { highLine: anchorClose + width, lowLine: anchorClose - width };
}

module.exports = { trueRange, wilderATR, bandWidth, lines };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/atr-band-logic.test.js`
Expected: PASS — all tests in the file green (10 assertions across 8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/slive/atr-band-logic.js server/test/atr-band-logic.test.js
git commit -m "feat: ATR-Band pure logic — trueRange, wilderATR, bandWidth, lines"
```

---

### Task 2: Pure logic — entry (candleColor, entrySignal)

**Files:**
- Modify: `server/slive/atr-band-logic.js` (add two functions + export them)
- Test: `server/test/atr-band-logic.test.js` (append tests)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `candleColor(candle) -> 'green'|'red'|'doji'` — `candle` is `{open, close}`.
  - `entrySignal(last2, highLine, lowLine) -> 'CE'|'PE'|null` — `last2` is the two most-recent completed candles `[{open,close}, {open,close}]`. `CE` iff both green **and** both `close > highLine`; `PE` iff both red **and** both `close < lowLine`; else `null` (including `last2.length < 2`).

- [ ] **Step 1: Write the failing tests**

Append to `server/test/atr-band-logic.test.js`:

```js
test('candleColor: green/red/doji', () => {
  assert.strictEqual(logic.candleColor({ open: 100, close: 105 }), 'green');
  assert.strictEqual(logic.candleColor({ open: 105, close: 100 }), 'red');
  assert.strictEqual(logic.candleColor({ open: 100, close: 100 }), 'doji');
});

// Band: highLine 22030, lowLine 21970
test('entrySignal: two green closes above HighLine -> CE', () => {
  const c = [{ open: 22020, close: 22040 }, { open: 22040, close: 22060 }];
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), 'CE');
});
test('entrySignal: two red closes below LowLine -> PE', () => {
  const c = [{ open: 21980, close: 21960 }, { open: 21960, close: 21940 }];
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), 'PE');
});
test('entrySignal: mixed colour -> null', () => {
  const c = [{ open: 22020, close: 22040 }, { open: 22060, close: 22050 }]; // green then red
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: second candle back inside band -> null', () => {
  const c = [{ open: 22020, close: 22040 }, { open: 22040, close: 22025 }]; // 2nd close < highLine
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: green but not above the line -> null', () => {
  const c = [{ open: 22000, close: 22010 }, { open: 22010, close: 22020 }]; // green, below 22030
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: doji in the pair -> null', () => {
  const c = [{ open: 22040, close: 22040 }, { open: 22040, close: 22060 }]; // doji + green
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: fewer than two candles -> null', () => {
  assert.strictEqual(logic.entrySignal([{ open: 22020, close: 22040 }], 22030, 21970), null);
  assert.strictEqual(logic.entrySignal([], 22030, 21970), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/atr-band-logic.test.js`
Expected: FAIL — `logic.candleColor is not a function` (and `entrySignal` undefined).

- [ ] **Step 3: Write the minimal implementation**

In `server/slive/atr-band-logic.js`, add these two functions **above** the `module.exports` line:

```js
// 'green' (bullish), 'red' (bearish), or 'doji'.
function candleColor(candle) {
  if (candle.close > candle.open) return 'green';
  if (candle.close < candle.open) return 'red';
  return 'doji';
}

// Entry side from the last two completed candles. CE iff both green and both
// close above highLine; PE iff both red and both close below lowLine; else null.
function entrySignal(last2, highLine, lowLine) {
  if (!last2 || last2.length < 2) return null;
  const a = last2[last2.length - 2];
  const b = last2[last2.length - 1];
  const bothGreen = candleColor(a) === 'green' && candleColor(b) === 'green';
  const bothRed = candleColor(a) === 'red' && candleColor(b) === 'red';
  if (bothGreen && a.close > highLine && b.close > highLine) return 'CE';
  if (bothRed && a.close < lowLine && b.close < lowLine) return 'PE';
  return null;
}
```

Update the export line to:

```js
module.exports = { trueRange, wilderATR, bandWidth, lines, candleColor, entrySignal };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/atr-band-logic.test.js`
Expected: PASS — all Task 1 + Task 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/slive/atr-band-logic.js server/test/atr-band-logic.test.js
git commit -m "feat: ATR-Band pure logic — candleColor, entrySignal (2-candle colour break)"
```

---

### Task 3: Pure logic — exit (target, stopHitOnClose)

**Files:**
- Modify: `server/slive/atr-band-logic.js` (add two functions + export them)
- Test: `server/test/atr-band-logic.test.js` (append tests)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `target(entryPremium, targetPts=20, targetPct=0.30) -> number` — `Math.min(entryPremium + targetPts, entryPremium * (1 + targetPct))` (the nearer of +pts and +pct%).
  - `stopHitOnClose(side, candleClose, highLine, lowLine) -> boolean` — CE → `candleClose < lowLine`; PE → `candleClose > highLine`; else `false`.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/atr-band-logic.test.js`:

```js
test('target: +20 binds above ~66.7 premium', () => {
  assert.strictEqual(logic.target(100), 120);   // min(120, 130)
  assert.strictEqual(logic.target(80), 100);    // min(100, 104)
});
test('target: +30% binds below ~66.7 premium', () => {
  assert.strictEqual(logic.target(50), 65);     // min(70, 65)
  assert.strictEqual(logic.target(60), 78);     // min(80, 78)
});
test('target: custom pts/pct', () => {
  assert.strictEqual(logic.target(100, 45, 0.30), 130); // min(145, 130)
});

test('stopHitOnClose: CE stops on close below LowLine', () => {
  assert.strictEqual(logic.stopHitOnClose('CE', 21960, 22030, 21970), true);
  assert.strictEqual(logic.stopHitOnClose('CE', 21980, 22030, 21970), false);
});
test('stopHitOnClose: PE stops on close above HighLine', () => {
  assert.strictEqual(logic.stopHitOnClose('PE', 22040, 22030, 21970), true);
  assert.strictEqual(logic.stopHitOnClose('PE', 22020, 22030, 21970), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/atr-band-logic.test.js`
Expected: FAIL — `logic.target is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `server/slive/atr-band-logic.js`, add these two functions **above** the `module.exports` line:

```js
// Premium target: the nearer of +pts and +pct%.
function target(entryPremium, targetPts = 20, targetPct = 0.30) {
  return Math.min(entryPremium + targetPts, entryPremium * (1 + targetPct));
}

// Far-opposite-line candle-close stop. CE stops if close < lowLine; PE if close > highLine.
function stopHitOnClose(side, candleClose, highLine, lowLine) {
  if (side === 'CE') return candleClose < lowLine;
  if (side === 'PE') return candleClose > highLine;
  return false;
}
```

Update the export line to:

```js
module.exports = {
  trueRange, wilderATR, bandWidth, lines, candleColor, entrySignal, target, stopHitOnClose,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/atr-band-logic.test.js`
Expected: PASS — full suite green (Tasks 1–3).

- [ ] **Step 5: Commit**

```bash
git add server/slive/atr-band-logic.js server/test/atr-band-logic.test.js
git commit -m "feat: ATR-Band pure logic — target and candle-close stop"
```

---

### Task 4: Launcher (KiteTicker + cron + state machine)

**Files:**
- Create: `server/slive/atr-band-nifty.js`

**Interfaces:**
- Consumes: `server/slive/atr-band-logic.js` (`wilderATR`, `bandWidth`, `lines`, `entrySignal`, `target`, `stopHitOnClose`); `PaperTrade.trackOrder_v2`; `optionConfig('NIFTY').weeklyInstruments`; `zapi.historyData(256265, '60minute'|'5minute', from, to)`; `KiteTicker`.
- Produces: a runnable pm2 process (no exported API).

This is an orchestration file modelled on `server/slive/bn-breakout.js`. It is verified by a syntax check here and a live dry-run in Task 5 (the decision logic it calls is already unit-tested in Tasks 1–3). Read `server/slive/bn-breakout.js` first to confirm the surrounding conventions (`zerodha_init`, `ticker`, `findOption`, `checkTicks`, cron style, `bootstrap`).

- [ ] **Step 1: Create the launcher file**

Create `server/slive/atr-band-nifty.js`:

```js
// ATR-Band — NIFTY Weekly Options (paper)
//
// 10:15 -> band WIDTH = Wilder ATR-14 of spot 1-hour candles / 3.
// 11:40 -> HighLine/LowLine = the 11:35-11:40 spot 5-min close +/- width.
// Entry: 2 consecutive 5-min spot candles, both green closing > HighLine -> ATM
//   weekly CE; both red closing < LowLine -> ATM weekly PE. Deadline 14:15.
// Exit: premium target min(entry+20, entry*1.30) | 60-min time-stop |
//   far-opposite-line candle-close stop. One entry per side per day.
//
// Paper only: orders via PaperTrade.trackOrder_v2 (auto-filled by
// boot/paperstream.js at the option's live LTP). Zerodha login is read-only
// (historyData + KiteTicker). Never places live orders.

const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const optionConfig = require('../tools/optionInstruments.js');
const notify = require('../lib/notify.js');
const async = require('async');
const moment = require('moment');
const logic = require('./atr-band-logic.js');

const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;

// ---- Strategy config ----
const strategyTag = 'ATR_BAND_NIFTY';
const underlying = 'NIFTY';
const spotToken = 256265;   // NIFTY 50 index
const strikeStep = 50;      // NIFTY strike interval
const atrPeriod = 14;
const widthDivisor = 3;     // width = ATR / 3
const targetPts = 20;       // premium target (points)
const targetPct = 0.30;     // OR +30% premium; nearer level wins
const timeStopMin = 60;
const lots = 1;             // qty = lot_size * lots

// ---- State ----
let zapi, public_token;
let currentExpiryOptions = {}, weeklyExpiry = '';
let width = 0, highLine = 0, lowLine = 0;
let widthReady = false, linesReady = false;
let entryClosed = false;
let started = false;
let ceUsed = false, peUsed = false;   // one entry per side per day
let position = null;
let ticksCache = {};

// ---- Zerodha read-only login (market data only) ----
async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  account.lastLogin = (new Date()).toISOString().substr(0, 10);
  account.config = await zapi_n.getConfig();
  public_token = zapi_n.getAuthorization();
  await account.save();
  if (login_resp === false) return false;
  else return zapi_n;
}

let liveFeed;
async function ticker(subs) {
  liveFeed = new kiteTicker({ api_key: 'kitefront', access_token: public_token });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log(strategyTag + ': Live Feed Connected');
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

function istMinutes() {
  let m = moment().utcOffset(330);
  return m.hours() * 60 + m.minutes();
}

async function runStrategy() {
  if (started) return;
  started = true;
  // Reset daily state (belt-and-suspenders; process also exits at 15:30)
  width = 0; highLine = 0; lowLine = 0;
  widthReady = false; linesReady = false; entryClosed = false;
  ceUsed = false; peUsed = false; position = null;
  try {
    let optionData = await optionConfig(underlying);
    currentExpiryOptions = optionData.weeklyInstruments;
    weeklyExpiry = optionData.weeklyExpiry;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    ticker([spotToken, ...optionTokens].filter(Boolean));
    console.log(strategyTag + ': Initialized. Spot + ' + optionTokens.length +
      ' option tokens subscribed. Expiry: ' + weeklyExpiry);
  } catch (err) {
    started = false;
    console.log(strategyTag + ' runStrategy error:', err);
  }
}

// 10:15 — band width from spot 1-hour candles: Wilder ATR-14 / 3
async function computeWidth() {
  if (widthReady) return;
  try {
    let today = new Date().toISOString().substr(0, 10);
    let from = moment().utcOffset(330).subtract(7, 'days').format('YYYY-MM-DD');
    let candles = await zapi.historyData(spotToken, '60minute', from, today);
    let atr = logic.wilderATR(candles, atrPeriod);
    if (atr === null) {
      console.log(strategyTag + ': not enough hourly candles for ATR, retrying in 30s...');
      setTimeout(computeWidth, 30000);
      return;
    }
    width = logic.bandWidth(atr, widthDivisor);
    widthReady = true;
    console.log(strategyTag + ': Width set. ATR' + atrPeriod + '=' + atr.toFixed(2) +
      ' width=' + width.toFixed(2));
  } catch (err) {
    console.log(strategyTag + ' computeWidth error:', err);
    setTimeout(computeWidth, 30000);
  }
}

// 11:40 — HighLine/LowLine from the 11:35-11:40 spot 5-min close
async function computeLines() {
  if (linesReady) return;
  if (!widthReady) {
    console.log(strategyTag + ': width not ready at 11:40, retrying lines in 30s...');
    setTimeout(computeLines, 30000);
    return;
  }
  try {
    let today = new Date().toISOString().substr(0, 10);
    let candles = await zapi.historyData(spotToken, '5minute', today, today);
    if (!candles || candles.length === 0) {
      console.log(strategyTag + ': no 5-min candles yet, retrying in 30s...');
      setTimeout(computeLines, 30000);
      return;
    }
    let anchor = candles[candles.length - 1];   // last completed 5-min candle (11:35-11:40)
    let l = logic.lines(anchor.close, width);
    highLine = l.highLine; lowLine = l.lowLine;
    linesReady = true;
    console.log(strategyTag + ': Lines set. anchor(11:35-11:40 close)=' + anchor.close +
      ' HIGH=' + highLine.toFixed(2) + ' LOW=' + lowLine.toFixed(2) + ' width=' + width.toFixed(2));
  } catch (err) {
    console.log(strategyTag + ' computeLines error:', err);
    setTimeout(computeLines, 30000);
  }
}

function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) { ob[el.instrument_token] = el; return ob; }, {});
  Object.assign(ticksCache, ticks2);
  if (position && position.status === 'ACTIVE') checkExits();
}

// Find the ATM option, falling back to the nearest listed strike
function findOption(strike, type) {
  let deltas = [0, strikeStep, -strikeStep, 2 * strikeStep, -2 * strikeStep];
  for (let d of deltas) {
    let inst = currentExpiryOptions[(strike + d) + type];
    if (inst) return inst;
  }
  return null;
}

// Every 5 min: if in a position -> candle-close far-line stop; else -> entry check.
// The candle-close stop must keep running past 14:15, so entryClosed gates only entry.
async function checkEntry() {
  if (!linesReady) return;
  try {
    let today = new Date().toISOString().substr(0, 10);
    let candles = await zapi.historyData(spotToken, '5minute', today, today);
    if (!candles || candles.length < 1) return;

    if (position && position.status === 'ACTIVE') {
      let last = candles[candles.length - 1];
      if (logic.stopHitOnClose(position.side, last.close, highLine, lowLine)) {
        console.log(strategyTag + ': SL candle-close — ' + position.side + ' close=' + last.close +
          ' HIGH=' + highLine.toFixed(2) + ' LOW=' + lowLine.toFixed(2));
        await closePosition('SL');
      }
      return;
    }

    if (entryClosed) return;
    if (candles.length < 2) return;
    let last2 = candles.slice(-2);
    let side = logic.entrySignal(last2, highLine, lowLine);
    if (side === 'CE' && !ceUsed) {
      console.log(strategyTag + ': CE signal — 2 green closes > HIGH=' + highLine.toFixed(2));
      await enterPosition('CE');
    } else if (side === 'PE' && !peUsed) {
      console.log(strategyTag + ': PE signal — 2 red closes < LOW=' + lowLine.toFixed(2));
      await enterPosition('PE');
    }
  } catch (err) {
    console.log(strategyTag + ' checkEntry error:', err);
  }
}

async function enterPosition(side) {
  if (position) return;
  if (side === 'CE' && ceUsed) return;
  if (side === 'PE' && peUsed) return;
  try {
    let spotTick = ticksCache[spotToken];
    if (!spotTick || typeof spotTick.last_price !== 'number') {
      console.log(strategyTag + ': no spot tick, abort entry (retry next candle)');
      return;
    }
    let spotLtp = spotTick.last_price;
    let strike = Math.round(spotLtp / strikeStep) * strikeStep;
    let inst = findOption(strike, side);
    if (!inst) {
      console.log(strategyTag + ': ATM option not found near ' + strike + side + ', abort entry');
      return;
    }
    let optTick = ticksCache[inst.instrument_token];
    if (!optTick || typeof optTick.last_price !== 'number') {
      console.log(strategyTag + ': no option tick for ' + inst.tradingsymbol + ', abort entry (retry next candle)');
      return;   // do NOT mark the side used — allow retry on the next 5-min check
    }
    let entryPremium = optTick.last_price;

    await PaperTrade.trackOrder_v2(inst, 'BUY', strategyTag, lots);
    if (side === 'CE') ceUsed = true; else peUsed = true;   // mark used only after a successful order

    position = {
      side: side,
      instrument: inst,
      entryPremium: entryPremium,
      target: logic.target(entryPremium, targetPts, targetPct),
      entryTime: new Date(),
      status: 'ACTIVE',
      timeStopTimer: setTimeout(function () { closePosition('TIME'); }, timeStopMin * 60000),
    };

    let qty = inst.lot_size * lots;
    console.log('=== ' + strategyTag + ' ENTRY ===');
    console.log('Side:', side, '| Symbol:', inst.tradingsymbol, '| Strike:', strike);
    console.log('Entry premium:', entryPremium, '| Target:', position.target.toFixed(2), '| Qty:', qty);
    notify(strategyTag + ' ENTRY ' + side + ' ' + inst.tradingsymbol + ' @ ' + entryPremium +
      ' tgt ' + position.target.toFixed(1), 0);
  } catch (err) {
    console.log(strategyTag + ' enterPosition error:', err);
  }
}

function checkExits() {
  if (!position || position.status !== 'ACTIVE') return;
  let optTick = ticksCache[position.instrument.instrument_token];
  if (optTick && typeof optTick.last_price === 'number' && optTick.last_price >= position.target) {
    closePosition('TARGET');
  }
}

async function closePosition(reason) {
  if (!position || position.status !== 'ACTIVE') return;
  position.status = 'CLOSING';   // synchronous guard against re-entrant ticks / timer race
  try {
    if (position.timeStopTimer) clearTimeout(position.timeStopTimer);
    let inst = position.instrument;
    let optTick = ticksCache[inst.instrument_token];
    let exitPrice = (optTick && typeof optTick.last_price === 'number') ? optTick.last_price : position.entryPremium;

    await PaperTrade.trackOrder_v2(inst, 'SELL', strategyTag, lots);
    position.status = 'CLOSED';

    let qty = inst.lot_size * lots;
    let pnl = (exitPrice - position.entryPremium) * qty;
    console.log('=== ' + strategyTag + ' EXIT (' + reason + ') ===');
    console.log('Symbol:', inst.tradingsymbol, '| Entry:', position.entryPremium,
      '| Exit:', exitPrice, '| P&L:', pnl.toFixed(2), '| Qty:', qty);
    notify(strategyTag + ' EXIT ' + reason + ' ' + inst.tradingsymbol + ' @ ' + exitPrice +
      ' pnl ' + pnl.toFixed(0), 0);
    position = null;   // clear so the opposite side may still take its single entry
  } catch (err) {
    console.log(strategyTag + ' closePosition error:', err);
  }
}

async function eodExit() {
  if (position && position.status === 'ACTIVE') {
    console.log(strategyTag + ': EOD square-off (option)');
    await closePosition('EOD');
  }
}

// Serialize entry/stop checks so overlapping historyData calls can't race
var checkEntryQ = async.queue(function (task, callback) {
  checkEntry().then(function () { callback(); });
}, 1);

// ---- Schedule (IST, Mon-Fri) ----
new CronJob('0 0 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');        // 09:00 init
new CronJob('20 15 10 * * 1-5', computeWidth, null, true, 'Asia/Kolkata');    // 10:15:20 band width
new CronJob('20 40 11 * * 1-5', computeLines, null, true, 'Asia/Kolkata');    // 11:40:20 lines
new CronJob('10 */5 11-15 * * 1-5', function () {                             // every 5 min, 11:00-15:55
  checkEntryQ.push({});                                                       // gated inside: entries 11:40-14:15, stop until close
}, null, true, 'Asia/Kolkata');
new CronJob('0 15 14 * * 1-5', function () {                                  // 14:15 entry deadline
  entryClosed = true;
  console.log(strategyTag + ': entry window closed (14:15).');
}, null, true, 'Asia/Kolkata');
new CronJob('0 15 15 * * 1-5', eodExit, null, true, 'Asia/Kolkata');          // 15:15 safety square-off
new CronJob('0 30 15 * * 1-5', function () {                                  // 15:30 process exit
  setTimeout(function () { process.exit(); }, 3000);
}, null, true, 'Asia/Kolkata');

// Mid-session (re)start bootstrap — covers pm2 restarts after 09:00
async function bootstrap() {
  let m = moment().utcOffset(330);
  let day = m.day();          // 0 Sun .. 6 Sat
  let mins = istMinutes();
  if (day >= 1 && day <= 5 && mins >= 540 && mins < 930) {   // Mon-Fri, 09:00-15:30 IST
    console.log(strategyTag + ': mid-session start (IST ' + m.format('HH:mm') + '), bootstrapping...');
    await runStrategy();
    if (mins >= 615) await computeWidth();   // past 10:15
    if (mins >= 700) await computeLines();   // past 11:40
    if (mins >= 855) entryClosed = true;     // past 14:15
  }
}
bootstrap();

console.log(strategyTag + ': Strategy loaded. atrPeriod=' + atrPeriod + ' width=ATR/' + widthDivisor +
  ' targetPts=' + targetPts + ' targetPct=' + targetPct + ' timeStopMin=' + timeStopMin + ' lots=' + lots);
```

- [ ] **Step 2: Syntax-check the file (do NOT require it — that boots the server + cron)**

Run: `node --check server/slive/atr-band-nifty.js`
Expected: exit 0, no output (parses clean). If it prints a `SyntaxError`, fix the reported line and re-run.

- [ ] **Step 3: Confirm the pure-logic suite still passes**

Run: `node --test server/test/atr-band-logic.test.js`
Expected: PASS — the launcher change did not touch the logic module.

- [ ] **Step 4: Commit**

```bash
git add server/slive/atr-band-nifty.js
git commit -m "feat: ATR-Band NIFTY weekly-options launcher (paper)"
```

---

### Task 5: Dry-run verification + run instructions

**Files:**
- None (operational verification + a short run note appended to the plan's sibling spec is optional).

**Interfaces:**
- Consumes: the launcher from Task 4 and a running `paperstream` (which subscribes NIFTY weekly option tokens and fills paper orders).
- Produces: a verified, launchable paper strategy.

This task confirms the wired strategy behaves on real data. Full end-to-end requires a Zerodha read-only login + `paperstream` running, so it is an **operational dry-run**, not an automated test. Do it on a trading day (or replay one).

- [ ] **Step 1: Pre-flight — logic suite + syntax**

Run:
```bash
node --test server/test/atr-band-logic.test.js
node --check server/slive/atr-band-nifty.js
```
Expected: logic suite fully green; syntax check exits 0.

- [ ] **Step 2: Confirm paperstream subscribes the NIFTY weekly chain**

Read `server/boot/paperstream.js` and confirm the line `ticker_n([n_futureToken, ...n_optionTokens, ...n_nextWeekOptionTokens])` is present and NIFTY spot `256265` is subscribed. This is what prices the paper fills. (No code change — verification only.)

- [ ] **Step 3: Launch under pm2 (paper)**

Run (during or before market hours, with the base account able to read-only login):
```bash
pm2 start server/slive/atr-band-nifty.js --name atr-band-nifty
pm2 logs atr-band-nifty --lines 50
```
Expected log line on load: `ATR_BAND_NIFTY: Strategy loaded. atrPeriod=14 width=ATR/3 targetPts=20 targetPct=0.3 timeStopMin=60 lots=1`.

- [ ] **Step 4: Verify the daily checkpoints in the logs**

Watch for, in order:
- ~09:00 — `Initialized. Spot + N option tokens subscribed. Expiry: <weekly>` and `Live Feed Connected`.
- ~10:15 — `Width set. ATR14=<n> width=<n>`.
- ~11:40 — `Lines set. anchor(11:35-11:40 close)=<n> HIGH=<n> LOW=<n> width=<n>`.
- On a signal — `=== ATR_BAND_NIFTY ENTRY ===` with side/symbol/strike/premium/target.
- On exit — `=== ATR_BAND_NIFTY EXIT (TARGET|TIME|SL|EOD) ===` with entry/exit/P&L.

- [ ] **Step 5: Verify the paper book nets flat**

After an entry+exit (or at EOD), confirm the strategy's paper position nets to zero for the day. Either:
- Hit the paper positions endpoint / dashboard filtered by tag `ATR_BAND_NIFTY`, or
- Confirm each `BUY` has a matching `SELL` for the same `tradingsymbol` in the `ATR_BAND_NIFTY` orders.

Expected: net quantity 0 per traded symbol; at most one CE and one PE entry for the day.

- [ ] **Step 6: Commit any operational note (optional)**

If you added run notes to the spec or a README, commit them:
```bash
git add docs/superpowers/specs/2026-07-04-atr-band-nifty-options-design.md
git commit -m "docs: ATR-Band NIFTY run/verify notes"
```
(If no doc changed, skip this step.)

---

## Self-Review

**1. Spec coverage** (checked against `docs/superpowers/specs/2026-07-04-atr-band-nifty-options-design.md`):
- §3.1 Band width (Wilder ATR-14 / 3) → Task 1 (`wilderATR`, `bandWidth`) + Task 4 (`computeWidth`). ✓
- §3.2 Lines (11:35–11:40 close ± width) → Task 1 (`lines`) + Task 4 (`computeLines`). ✓
- §3.3 Entry (2 consecutive coloured closes beyond line) → Task 2 (`candleColor`, `entrySignal`) + Task 4 (`checkEntry`). ✓
- §3.4 Entry deadline 14:15 → Task 4 (`entryClosed` cron; gates only the entry branch). ✓
- §3.5 Target min(+20, +30%) → Task 3 (`target`) + Task 4 (`checkExits`). ✓
- §3.6 Time-stop 60 min → Task 4 (`timeStopTimer` → `closePosition('TIME')`). ✓
- §3.7 Far-opposite-line candle-close stop → Task 3 (`stopHitOnClose`) + Task 4 (`checkEntry` stop branch). ✓
- §3.8 One entry per side → Task 4 (`ceUsed`/`peUsed`, set at entry, `position` cleared on close). ✓
- §3.9 15:15 EOD square-off / 15:30 exit → Task 4 (`eodExit`, exit cron). ✓
- §4 Architecture (logic module + launcher + tests) → Tasks 1–4. ✓
- §5 Exit precedence (3 independent monitors, `CLOSING` guard) → Task 4 (`checkExits` tick / timer / `checkEntry` candle-close; `status='CLOSING'`). ✓
- §6 Schedule → Task 4 cron + `bootstrap`. ✓
- §7 Edge cases (ATR retry, anchor retry, missing tick abort without marking side used, doji, re-entrant guard, async.queue) → Task 4. ✓
- §8 Testing (unit + dry-run) → Tasks 1–3 (unit) + Task 5 (dry-run). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every test step shows real assertions with hand-computed expected values. ✓

**3. Type consistency:** `wilderATR`/`bandWidth`/`lines`/`entrySignal`/`target`/`stopHitOnClose` signatures are identical between their defining task, the launcher's calls in Task 4, and the exports. `position` shape (`side`, `instrument`, `entryPremium`, `target`, `entryTime`, `status`, `timeStopTimer`) is used consistently across `enterPosition`/`checkExits`/`closePosition`/`checkEntry`. Side strings are `'CE'`/`'PE'` throughout. ✓

## Notes / deliberate limitations (from the spec)

- pm2 mid-session restart cannot restore an already-open in-memory `position` (same as `bn-breakout.js`). `bootstrap()` restores only time-based state.
- The launcher is orchestration and is not unit-tested in isolation (it boots the LoopBack server on require); all decision logic is unit-tested in the pure module. This mirrors the `orb-fut-logic.js` / launcher split already in the repo.
- `computeWidth`/`computeLines`/`checkEntry` rely on Kite `historyData` returning only completed candles (the assumption `bn-breakout.js` already makes for `candles[candles.length - 1]`).
