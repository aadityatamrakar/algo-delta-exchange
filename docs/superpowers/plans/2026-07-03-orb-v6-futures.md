# ORB v6 Index-Futures (paper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a futures-only "ORB v6" opening-range-breakout paper strategy that trades NIFTY, BANKNIFTY and SENSEX current-month futures.

**Architecture:** A dependency-free pure-logic module (`orb-fut-logic.js`) holds all decision math (range, breakout, targets, scale-out state machine) and is unit-tested with Node's built-in `node:test`. A stateful engine (`orb-fut-core.js`) wires that logic to Zerodha market data (read-only), a KiteTicker feed, cron scheduling, and `PaperTrade.trackOrder_v2` paper orders — mirroring the shape of `server/slive/bn-breakout.js`. Three thin launchers (`orb-fut-nifty.js`, `orb-fut-bn.js`, `orb-fut-snx.js`) call the engine factory with per-index config, each run as its own process.

**Tech Stack:** Node.js (v24, built-in `node:test` runner), LoopBack app (`server/server.js`), `cron`, `moment`, `async`, existing libs `lib/zerodha.js` / `lib/KiteTicker.js` / `lib/notify.js`, `tools/optionInstruments.js`.

## Global Constraints

- **Paper only.** Orders go through `PaperTrade.trackOrder_v2(instrument, 'BUY'|'SELL', strategyTag, lots)`. Never call `Account.placeAllAccount` or any live-order path.
- **Instrument object shape** for `trackOrder_v2`: must have `{ tradingsymbol, instrument_token, lot_size }`. The current-month future is resolved at runtime via `optionConfig.download(underlying)` → `.futures.find(f => f.instrument_token === data.currentFuture.token)`. Never hardcode a future token.
- **All signals on the future** — range, breakout candle close, SL and target monitoring all use the future's own candles/ticks (token = `data.currentFuture.token`).
- **Buffer** = `0.001` (0.10%). **BANKNIFTY range filter** = `250` points; NIFTY & SENSEX = `0` (disabled). **Default lots** = `2`.
- **Times are IST** (`Asia/Kolkata`), Mon–Fri. Cron pattern order is `sec min hour dom mon dow`.
- Follow the existing `slive/bn-breakout.js` conventions (its own KiteTicker, `async.queue`-serialized breakout checks, `moment().utcOffset(330)` for IST minutes, `bootstrap()` for mid-session restart, `process.exit()` at 15:30).

---

## File Structure

- Create `server/slive/orb-fut-logic.js` — pure decision functions, no I/O, no `require` of app/zerodha/cron. (Tasks 1–2)
- Create `server/test/orb-fut-logic.test.js` — `node:test` unit tests for the logic. (Tasks 1–2)
- Create `server/slive/orb-fut-core.js` — stateful engine factory `module.exports = function startOrbFut(config)`. (Task 3)
- Create `server/slive/orb-fut-nifty.js`, `server/slive/orb-fut-bn.js`, `server/slive/orb-fut-snx.js` — thin launchers. (Task 4)

---

## Task 1: Pure logic — range, filter, breakout, levels

**Files:**
- Create: `server/slive/orb-fut-logic.js`
- Test: `server/test/orb-fut-logic.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `computeRange(candles, count = 6)` → `{ rangeHigh, rangeLow, range }` or `null` if fewer than `count` candles. Each candle is `{ open, high, low, close }` (as returned by `zapi.historyData`).
  - `passesFilter(range, filterPts)` → `boolean`. `filterPts` falsy → always `true`; else `range >= filterPts`.
  - `breakoutSide(close, rangeHigh, rangeLow, bufferPct)` → `'BUY'` | `'SELL'` | `null`.
  - `computeLevels(side, entry, range, rangeHigh, rangeLow)` → `{ sl, t1, t2 }`.
  - `openPosition(side, instrument, entry, range, rangeHigh, rangeLow, lots)` → position object `{ side, instrument, entry, sl, t1, t2, lotsTotal, lotsOpen, t1Done, status }`.

- [ ] **Step 1: Write the failing test**

Create `server/test/orb-fut-logic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const logic = require('../slive/orb-fut-logic.js');

const candles = [
  { open: 100, high: 110, low: 95, close: 108 },
  { open: 108, high: 112, low: 104, close: 106 },
  { open: 106, high: 109, low: 100, close: 101 },
  { open: 101, high: 103, low: 90, close: 99 },
  { open: 99, high: 107, low: 98, close: 105 },
  { open: 105, high: 111, low: 102, close: 109 },
  { open: 109, high: 120, low: 108, close: 118 }, // 7th (post-range) candle
];

test('computeRange aggregates first 6 candles', () => {
  const r = logic.computeRange(candles, 6);
  assert.strictEqual(r.rangeHigh, 112); // max high of first 6
  assert.strictEqual(r.rangeLow, 90);   // min low of first 6
  assert.strictEqual(r.range, 22);
});

test('computeRange returns null when not enough candles', () => {
  assert.strictEqual(logic.computeRange(candles.slice(0, 3), 6), null);
  assert.strictEqual(logic.computeRange([], 6), null);
});

test('passesFilter respects filter points', () => {
  assert.strictEqual(logic.passesFilter(300, 250), true);
  assert.strictEqual(logic.passesFilter(250, 250), true);  // inclusive
  assert.strictEqual(logic.passesFilter(200, 250), false);
  assert.strictEqual(logic.passesFilter(10, 0), true);      // disabled filter
});

test('breakoutSide applies the buffer', () => {
  // rangeHigh 112 -> buffered 112.112 ; rangeLow 90 -> buffered 89.91
  assert.strictEqual(logic.breakoutSide(112.2, 112, 90, 0.001), 'BUY');
  assert.strictEqual(logic.breakoutSide(89.8, 112, 90, 0.001), 'SELL');
  assert.strictEqual(logic.breakoutSide(112.05, 112, 90, 0.001), null); // inside buffer
  assert.strictEqual(logic.breakoutSide(100, 112, 90, 0.001), null);
});

test('computeLevels for long and short', () => {
  assert.deepStrictEqual(
    logic.computeLevels('BUY', 113, 22, 112, 90),
    { sl: 90, t1: 135, t2: 157 }
  );
  assert.deepStrictEqual(
    logic.computeLevels('SELL', 89, 22, 112, 90),
    { sl: 112, t1: 67, t2: 45 }
  );
});

test('openPosition builds a full position object', () => {
  const inst = { tradingsymbol: 'X', instrument_token: 1, lot_size: 15 };
  const p = logic.openPosition('BUY', inst, 113, 22, 112, 90, 2);
  assert.deepStrictEqual(p, {
    side: 'BUY', instrument: inst, entry: 113,
    sl: 90, t1: 135, t2: 157,
    lotsTotal: 2, lotsOpen: 2, t1Done: false, status: 'ACTIVE',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/orb-fut-logic.test.js`
Expected: FAIL — `Cannot find module '../slive/orb-fut-logic.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/slive/orb-fut-logic.js`:

```js
// ORB v6 — pure decision logic (no I/O). Unit-tested via server/test/orb-fut-logic.test.js.

// Aggregate the first `count` 5-min candles (09:15-09:45 -> count 6) into a range.
function computeRange(candles, count = 6) {
  if (!candles || candles.length < count) return null;
  const window = candles.slice(0, count);
  const rangeHigh = Math.max(...window.map(c => c.high));
  const rangeLow = Math.min(...window.map(c => c.low));
  return { rangeHigh, rangeLow, range: rangeHigh - rangeLow };
}

// BANKNIFTY needs range >= filterPts; a falsy filter is disabled (always passes).
function passesFilter(range, filterPts) {
  if (!filterPts) return true;
  return range >= filterPts;
}

// Direction of a buffered breakout for a candle close. 'BUY' up, 'SELL' down, else null.
function breakoutSide(close, rangeHigh, rangeLow, bufferPct) {
  if (close > rangeHigh * (1 + bufferPct)) return 'BUY';
  if (close < rangeLow * (1 - bufferPct)) return 'SELL';
  return null;
}

// SL = opposite ORB end; targets measured from the fill price as multiples of range.
function computeLevels(side, entry, range, rangeHigh, rangeLow) {
  if (side === 'BUY') {
    return { sl: rangeLow, t1: entry + range, t2: entry + 2 * range };
  }
  return { sl: rangeHigh, t1: entry - range, t2: entry - 2 * range };
}

function openPosition(side, instrument, entry, range, rangeHigh, rangeLow, lots) {
  const { sl, t1, t2 } = computeLevels(side, entry, range, rangeHigh, rangeLow);
  return {
    side, instrument, entry, sl, t1, t2,
    lotsTotal: lots, lotsOpen: lots, t1Done: false, status: 'ACTIVE',
  };
}

module.exports = { computeRange, passesFilter, breakoutSide, computeLevels, openPosition };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/orb-fut-logic.test.js`
Expected: PASS — 6 passing tests, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/slive/orb-fut-logic.js server/test/orb-fut-logic.test.js
git commit -m "feat: ORB futures pure logic (range, filter, breakout, levels)"
```

---

## Task 2: Pure logic — scale-out exit reducer

**Files:**
- Modify: `server/slive/orb-fut-logic.js` (add `evaluateExit`, export it)
- Test: `server/test/orb-fut-logic.test.js` (append tests)

**Interfaces:**
- Consumes: the position object from `openPosition` (Task 1).
- Produces:
  - `evaluateExit(position, price, opts = {})` → `{ actions, position }`.
    - `actions`: array of `{ side: 'BUY'|'SELL', lots: number, reason: string }` — orders to place (opposite side of the position). `reason` ∈ `SL | BREAKEVEN | T1 | T1_FULL | T2 | EOD`.
    - `position`: next state (new object). Priority per call: forceExit → SL → T1 → T2, all evaluated against the same `price` so a gap can trigger T1 and T2 in one call.
    - `opts.forceExit === true` → close all remaining lots (reason `EOD`), ignore `price`.
    - Only acts while `position.status === 'ACTIVE'`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/orb-fut-logic.test.js`:

```js
function longPos(lots = 2) {
  // entry 113, range 22 -> t1 135, t2 157, sl 90 (rangeLow)
  return logic.openPosition('BUY', { tradingsymbol: 'X', instrument_token: 1, lot_size: 15 }, 113, 22, 112, 90, lots);
}
function shortPos(lots = 2) {
  // entry 89, range 22 -> t1 67, t2 45, sl 112 (rangeHigh)
  return logic.openPosition('SELL', { tradingsymbol: 'X', instrument_token: 1, lot_size: 15 }, 89, 22, 112, 90, lots);
}

test('evaluateExit: no trigger yields no actions', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 120);
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(position.status, 'ACTIVE');
  assert.strictEqual(position.lotsOpen, 2);
});

test('evaluateExit: T1 books half and moves SL to breakeven', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 135);
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 1, reason: 'T1' }]);
  assert.strictEqual(position.lotsOpen, 1);
  assert.strictEqual(position.t1Done, true);
  assert.strictEqual(position.sl, 113); // breakeven = entry
  assert.strictEqual(position.status, 'ACTIVE');
});

test('evaluateExit: T2 after T1 closes the rest', () => {
  const afterT1 = logic.evaluateExit(longPos(), 135).position;
  const { actions, position } = logic.evaluateExit(afterT1, 157);
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 1, reason: 'T2' }]);
  assert.strictEqual(position.lotsOpen, 0);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: SL before T1 exits everything', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 90);
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 2, reason: 'SL' }]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: breakeven stop after T1', () => {
  const afterT1 = logic.evaluateExit(longPos(), 135).position;
  const { actions, position } = logic.evaluateExit(afterT1, 113);
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 1, reason: 'BREAKEVEN' }]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: gap through T1 and T2 in one tick', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 200);
  assert.deepStrictEqual(actions, [
    { side: 'SELL', lots: 1, reason: 'T1' },
    { side: 'SELL', lots: 1, reason: 'T2' },
  ]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: forceExit closes remaining as EOD', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 0, { forceExit: true });
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 2, reason: 'EOD' }]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: single lot cannot scale, full exit at T1', () => {
  const { actions, position } = logic.evaluateExit(longPos(1), 135);
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 1, reason: 'T1_FULL' }]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: short side mirrors (cover with BUY)', () => {
  const t1 = logic.evaluateExit(shortPos(), 67);
  assert.deepStrictEqual(t1.actions, [{ side: 'BUY', lots: 1, reason: 'T1' }]);
  assert.strictEqual(t1.position.sl, 89); // breakeven
  const t2 = logic.evaluateExit(t1.position, 45);
  assert.deepStrictEqual(t2.actions, [{ side: 'BUY', lots: 1, reason: 'T2' }]);
  assert.strictEqual(t2.position.status, 'CLOSED');
});

test('evaluateExit: ignores an already-closed position', () => {
  const closed = logic.evaluateExit(longPos(), 90).position;
  const again = logic.evaluateExit(closed, 200);
  assert.deepStrictEqual(again.actions, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/orb-fut-logic.test.js`
Expected: FAIL — `logic.evaluateExit is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/slive/orb-fut-logic.js`, add before `module.exports`:

```js
// Pure scale-out reducer. Given a position and the current price (or forceExit),
// return the orders to place and the next position state. Order of precedence per
// call: forceExit -> SL -> T1 -> T2, all against the same price (a gap can fire T1+T2).
function evaluateExit(position, price, opts = {}) {
  const actions = [];
  if (!position || position.status !== 'ACTIVE') {
    return { actions, position };
  }
  const p = Object.assign({}, position);
  const opp = p.side === 'BUY' ? 'SELL' : 'BUY';
  const long = p.side === 'BUY';

  if (opts.forceExit) {
    if (p.lotsOpen > 0) actions.push({ side: opp, lots: p.lotsOpen, reason: 'EOD' });
    p.lotsOpen = 0;
    p.status = 'CLOSED';
    return { actions, position: p };
  }

  const slHit = long ? price <= p.sl : price >= p.sl;
  if (slHit) {
    if (p.lotsOpen > 0) {
      actions.push({ side: opp, lots: p.lotsOpen, reason: p.t1Done ? 'BREAKEVEN' : 'SL' });
    }
    p.lotsOpen = 0;
    p.status = 'CLOSED';
    return { actions, position: p };
  }

  const t1Hit = long ? price >= p.t1 : price <= p.t1;
  if (!p.t1Done && t1Hit) {
    const half = Math.floor(p.lotsTotal / 2);
    if (half > 0) {
      actions.push({ side: opp, lots: half, reason: 'T1' });
      p.lotsOpen = p.lotsOpen - half;
      p.sl = p.entry;      // move stop to breakeven
      p.t1Done = true;
    } else {
      actions.push({ side: opp, lots: p.lotsOpen, reason: 'T1_FULL' });
      p.lotsOpen = 0;
      p.status = 'CLOSED';
      return { actions, position: p };
    }
  }

  const t2Hit = long ? price >= p.t2 : price <= p.t2;
  if (p.t1Done && p.lotsOpen > 0 && t2Hit) {
    actions.push({ side: opp, lots: p.lotsOpen, reason: 'T2' });
    p.lotsOpen = 0;
    p.status = 'CLOSED';
  }

  return { actions, position: p };
}
```

And update the exports line to include it:

```js
module.exports = { computeRange, passesFilter, breakoutSide, computeLevels, openPosition, evaluateExit };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/orb-fut-logic.test.js`
Expected: PASS — all tests green, `# fail 0` (6 from Task 1 + 10 from Task 2).

- [ ] **Step 5: Commit**

```bash
git add server/slive/orb-fut-logic.js server/test/orb-fut-logic.test.js
git commit -m "feat: ORB futures scale-out exit reducer + tests"
```

---

## Task 3: Engine `orb-fut-core.js`

**Files:**
- Create: `server/slive/orb-fut-core.js`
- Reference (read for pattern): `server/slive/bn-breakout.js`

**Interfaces:**
- Consumes: `logic.computeRange / passesFilter / breakoutSide / openPosition / evaluateExit` (Tasks 1–2); `optionConfig.download(underlying)`; `PaperTrade.trackOrder_v2(instrument, side, tag, lots)`.
- Produces: `module.exports = function startOrbFut(config)` where `config = { strategyTag, underlying, rangeFilterPts, lots, bufferPct }`. Calling it wires up the ticker + cron schedule for one index (one process).

- [ ] **Step 1: Write the module**

Create `server/slive/orb-fut-core.js`:

```js
// ORB v6 — Index Futures (paper) — shared engine.
//
// 09:15-09:45 opening range on the current-month future. A later 5-min candle
// whose CLOSE clears the range +/- 0.10% buffer goes long (BUY) / short (SELL)
// the future. SL at the opposite ORB end; scale out 1/2 at T1 (1x range, SL ->
// breakeven) and 1/2 at T2 (2x range). One trade/day, force-exit 15:15.
//
// Paper only: orders via PaperTrade.trackOrder_v2 (filled by boot/paperstream.js
// at the live tick price). Zerodha login is read-only (historyData + ticker).

const CronJob = require('cron').CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const optionConfig = require('../tools/optionInstruments.js');
const notify = require('../lib/notify.js');
const async = require('async');
const moment = require('moment');
const logic = require('./orb-fut-logic.js');

const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;

module.exports = function startOrbFut(config) {
  const strategyTag = config.strategyTag;
  const underlying = config.underlying;
  const rangeFilterPts = config.rangeFilterPts || 0;
  const lots = config.lots || 2;
  const bufferPct = config.bufferPct || 0.001;

  // ---- State ----
  let zapi, public_token;
  let futInstrument = null, futureToken = 0;
  let rangeHigh = 0, rangeLow = 0, range = 0;
  let linesReady = false, dayBlocked = false;
  let tradedToday = false, entryClosed = false, started = false;
  let position = null;
  let busy = false;            // guards overlapping order-emitting sections
  let ticksCache = {};

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
    liveFeed.on('ticks', checkTicks);
    liveFeed.on('connect', function () {
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
    linesReady = false; dayBlocked = false;
    tradedToday = false; entryClosed = false; position = null;
    try {
      let data = await optionConfig.download(underlying);
      futureToken = data.currentFuture.token;
      futInstrument = data.futures.find(f => f.instrument_token === futureToken);
      if (!futInstrument || !futureToken) {
        dayBlocked = true;
        console.log(strategyTag + ': no current future found, day blocked.');
        return;
      }
      let masterId = app.get('masterId');
      let base_acc = await Account.findById(masterId);
      zapi = await zerodha_init(base_acc);
      ticker([futureToken]);
      console.log(strategyTag + ': Initialized. Future ' + futInstrument.tradingsymbol +
        ' (' + futureToken + ') lot ' + futInstrument.lot_size + '. Waiting for 09:45 range...');
    } catch (err) {
      started = false;
      console.log(strategyTag + ' runStrategy error:', err);
    }
  }

  // Set the range from the first six 5-min candles (09:15-09:45) of the future.
  async function setupRange() {
    if (linesReady || dayBlocked) return;
    try {
      let today = new Date().toISOString().substr(0, 10);
      let candles = await zapi.historyData(futureToken, '5minute', today, today);
      let r = logic.computeRange(candles, 6);
      if (!r) {
        console.log(strategyTag + ': range candles not ready, retrying in 30s...');
        setTimeout(setupRange, 30000);
        return;
      }
      rangeHigh = r.rangeHigh; rangeLow = r.rangeLow; range = r.range;
      if (!logic.passesFilter(range, rangeFilterPts)) {
        dayBlocked = true;
        console.log(strategyTag + ': range ' + range.toFixed(2) + ' < filter ' + rangeFilterPts + ', day blocked.');
        notify(strategyTag + ' day blocked (range ' + range.toFixed(0) + ' < ' + rangeFilterPts + ')', 0);
        return;
      }
      linesReady = true;
      console.log(strategyTag + ': Range set. HIGH=' + rangeHigh.toFixed(2) +
        ' LOW=' + rangeLow.toFixed(2) + ' RANGE=' + range.toFixed(2));
    } catch (err) {
      console.log(strategyTag + ' setupRange error:', err);
      setTimeout(setupRange, 30000);
    }
  }

  function checkTicks(ticks) {
    let ticks2 = ticks.reduce(function (ob, el) { ob[el.instrument_token] = el; return ob; }, {});
    Object.assign(ticksCache, ticks2);
    if (position && position.status === 'ACTIVE') checkExits();
  }

  // Evaluate the last completed 5-min candle for a body break.
  async function checkBreakout() {
    if (!linesReady || tradedToday || entryClosed || position || dayBlocked) return;
    try {
      let today = new Date().toISOString().substr(0, 10);
      let candles = await zapi.historyData(futureToken, '5minute', today, today);
      if (!candles || candles.length < 7) return; // 6 range candles + >=1 more
      let c = candles[candles.length - 1];         // last completed candle
      let side = logic.breakoutSide(c.close, rangeHigh, rangeLow, bufferPct);
      if (side) {
        console.log(strategyTag + ': ' + side + ' breakout — close=' + c.close +
          ' H=' + rangeHigh.toFixed(2) + ' L=' + rangeLow.toFixed(2));
        await enterPosition(side);
      }
    } catch (err) {
      console.log(strategyTag + ' checkBreakout error:', err);
    }
  }

  async function enterPosition(side) {
    if (position || tradedToday) return;
    try {
      let tick = ticksCache[futureToken];
      if (!tick || typeof tick.last_price !== 'number') {
        console.log(strategyTag + ': no future tick, abort entry (retry next candle)');
        return; // do NOT set tradedToday — allow retry next 5-min check
      }
      let entry = tick.last_price;
      await PaperTrade.trackOrder_v2(futInstrument, side, strategyTag, lots);
      tradedToday = true;
      position = logic.openPosition(side, futInstrument, entry, range, rangeHigh, rangeLow, lots);
      let qty = futInstrument.lot_size * lots;
      console.log('=== ' + strategyTag + ' ENTRY ===');
      console.log('Side:', side, '| Symbol:', futInstrument.tradingsymbol, '| Entry:', entry,
        '| SL:', position.sl.toFixed(2), '| T1:', position.t1.toFixed(2),
        '| T2:', position.t2.toFixed(2), '| Qty:', qty);
      notify(strategyTag + ' ENTRY ' + side + ' ' + futInstrument.tradingsymbol + ' @ ' + entry +
        ' sl ' + position.sl.toFixed(0) + ' t1 ' + position.t1.toFixed(0) +
        ' t2 ' + position.t2.toFixed(0), 0);
    } catch (err) {
      console.log(strategyTag + ' enterPosition error:', err);
    }
  }

  // Place all orders from a reducer result, then adopt its next position state.
  async function executeActions(result) {
    for (let a of result.actions) {
      await PaperTrade.trackOrder_v2(futInstrument, a.side, strategyTag, a.lots);
      let tick = ticksCache[futureToken];
      let px = (tick && typeof tick.last_price === 'number') ? tick.last_price : position.entry;
      console.log('=== ' + strategyTag + ' EXIT (' + a.reason + ') ===');
      console.log('Symbol:', futInstrument.tradingsymbol, '|', a.side, a.lots, 'lot(s) @ ~' + px);
      notify(strategyTag + ' EXIT ' + a.reason + ' ' + a.side + ' ' + a.lots + 'lot ' +
        futInstrument.tradingsymbol + ' @ ' + px, 0);
    }
    position = result.position;
  }

  function checkExits() {
    if (!position || position.status !== 'ACTIVE' || busy) return;
    let tick = ticksCache[futureToken];
    if (!tick || typeof tick.last_price !== 'number') return;
    let result = logic.evaluateExit(position, tick.last_price);
    if (result.actions.length === 0) return;
    busy = true; // synchronous guard set before any await
    executeActions(result).then(function () { busy = false; })
      .catch(function (err) { busy = false; console.log(strategyTag + ' executeActions error:', err); });
  }

  async function eodExit() {
    if (!position || position.status !== 'ACTIVE') return;
    if (busy) { setTimeout(eodExit, 1000); return; }
    busy = true;
    try {
      let result = logic.evaluateExit(position, 0, { forceExit: true });
      await executeActions(result);
      console.log(strategyTag + ': EOD square-off done');
    } catch (err) {
      console.log(strategyTag + ' eodExit error:', err);
    }
    busy = false;
  }

  // Serialize breakout checks so overlapping historyData calls can't race.
  var checkBreakoutQ = async.queue(function (task, callback) {
    checkBreakout().then(function () { callback(); });
  }, 1);

  // ---- Schedule (IST, Mon-Fri) ----
  new CronJob('0 0 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');        // 09:00 init
  new CronJob('20 45 9 * * 1-5', setupRange, null, true, 'Asia/Kolkata');       // 09:45:20 range
  new CronJob('10 */5 9-13 * * 1-5', function () { checkBreakoutQ.push({}); }, null, true, 'Asia/Kolkata'); // 09:00..13:55 checks
  new CronJob('10 0 14 * * 1-5', function () { checkBreakoutQ.push({}); }, null, true, 'Asia/Kolkata');     // 14:00 last check
  new CronJob('30 0 14 * * 1-5', function () {                                  // 14:00:30 entry deadline
    entryClosed = true;
    console.log(strategyTag + ': entry window closed (14:00).');
  }, null, true, 'Asia/Kolkata');
  new CronJob('0 15 15 * * 1-5', eodExit, null, true, 'Asia/Kolkata');          // 15:15 square-off
  new CronJob('0 30 15 * * 1-5', function () {                                  // 15:30 process exit
    setTimeout(function () { process.exit(); }, 3000);
  }, null, true, 'Asia/Kolkata');

  // Mid-session (re)start bootstrap — covers pm2 restarts after 09:00.
  async function bootstrap() {
    let m = moment().utcOffset(330);
    let day = m.day();
    let mins = istMinutes();
    if (day >= 1 && day <= 5 && mins >= 540 && mins < 930) { // Mon-Fri 09:00-15:30
      console.log(strategyTag + ': mid-session start (IST ' + m.format('HH:mm') + '), bootstrapping...');
      await runStrategy();
      if (mins >= 586) await setupRange();   // past 09:46
      if (mins >= 840) entryClosed = true;   // past 14:00
    }
  }
  bootstrap();

  console.log(strategyTag + ': loaded. underlying=' + underlying +
    ' rangeFilter=' + rangeFilterPts + ' lots=' + lots + ' bufferPct=' + bufferPct);
};
```

- [ ] **Step 2: Verify the module parses**

Run: `node --check server/slive/orb-fut-core.js`
Expected: no output, exit 0 (syntax OK). It is a factory with no side effects until called, so `--check` is sufficient here; full runtime requires the LoopBack app + Zerodha login (exercised via a launcher in Task 4 / manual dry-run).

- [ ] **Step 3: Commit**

```bash
git add server/slive/orb-fut-core.js
git commit -m "feat: ORB futures engine (range, breakout, scale-out, cron)"
```

---

## Task 4: Launchers for NIFTY / BANKNIFTY / SENSEX

**Files:**
- Create: `server/slive/orb-fut-nifty.js`
- Create: `server/slive/orb-fut-bn.js`
- Create: `server/slive/orb-fut-snx.js`

**Interfaces:**
- Consumes: `startOrbFut(config)` from Task 3.
- Produces: three runnable process entrypoints (`node server/slive/orb-fut-<x>.js`).

- [ ] **Step 1: Create the three launchers**

Create `server/slive/orb-fut-nifty.js`:

```js
require('./orb-fut-core.js')({
  strategyTag: 'ORB_FUT_NIFTY',
  underlying: 'NIFTY',
  rangeFilterPts: 0,   // no filter
  lots: 2,
  bufferPct: 0.001,
});
```

Create `server/slive/orb-fut-bn.js`:

```js
require('./orb-fut-core.js')({
  strategyTag: 'ORB_FUT_BN',
  underlying: 'BANKNIFTY',
  rangeFilterPts: 250, // BANKNIFTY needs range >= 250
  lots: 2,
  bufferPct: 0.001,
});
```

Create `server/slive/orb-fut-snx.js`:

```js
require('./orb-fut-core.js')({
  strategyTag: 'ORB_FUT_SNX',
  underlying: 'SENSEX',
  rangeFilterPts: 0,   // no filter
  lots: 2,
  bufferPct: 0.001,
});
```

- [ ] **Step 2: Verify each launcher parses**

Run: `node --check server/slive/orb-fut-nifty.js && node --check server/slive/orb-fut-bn.js && node --check server/slive/orb-fut-snx.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add server/slive/orb-fut-nifty.js server/slive/orb-fut-bn.js server/slive/orb-fut-snx.js
git commit -m "feat: ORB futures launchers for NIFTY/BANKNIFTY/SENSEX"
```

- [ ] **Step 4: Manual dry-run note (not automated)**

Each strategy runs as its own process: `node server/slive/orb-fut-nifty.js` (and `-bn`, `-snx`). It boots the LoopBack app, does a read-only Zerodha login, subscribes the future token, and schedules the crons. On a trading day the expected log sequence is: `Live Feed Connected` → `Range set...` at ~09:45 (or `day blocked` for BANKNIFTY if range < 250) → `ENTRY ...` on the first buffered breakout close → `EXIT (T1/T2/SL/EOD) ...`. Paper fills appear in `PaperTrade` under the tag (`ORB_FUT_NIFTY` etc.), and net to flat by 15:15. This step is operational verification, performed on the server against live/replayed data — there is no unit test for the I/O shell.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-03-orb-v6-futures-design.md`):
- §3.1 opening range on future → `computeRange` (Task 1) + `setupRange` (Task 3). ✓
- §3.2 range filter (BN 250) → `passesFilter` (Task 1) + config `rangeFilterPts` (Task 4). ✓
- §3.3 buffered 5-min-close breakout → `breakoutSide` (Task 1) + `checkBreakout` (Task 3). ✓
- §3.4 14:00 entry deadline → `entryClosed` cron (Task 3). ✓
- §3.5 opposite-end SL → `computeLevels` (Task 1), monitored in `checkExits` (Task 3). ✓
- §3.6 scale-out T1/T2, SL→breakeven → `evaluateExit` (Task 2). ✓
- §3.7 one trade/day → `tradedToday` (Task 3). ✓
- §3.8 force exit 15:15 / process exit 15:30 → `eodExit` + exit crons (Task 3). ✓
- §4 shared core + 3 launchers → Tasks 3–4. ✓
- §5 scale-out lifecycle incl. `lots=1` degrade → covered by `evaluateExit` tests (Task 2). ✓
- §7 edge cases: no candles retry, filter block, missing tick abort, re-entrant guard (`busy`), serialized checks (`async.queue`), future-not-found block, `bootstrap` → Task 3. ✓
- §8 unit tests for pure helpers + manual integration → Tasks 1–2 tests + Task 4 dry-run. ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `computeRange/passesFilter/breakoutSide/computeLevels/openPosition/evaluateExit` signatures identical across Tasks 1–3; position object fields (`side, instrument, entry, sl, t1, t2, lotsTotal, lotsOpen, t1Done, status`) consistent between `openPosition`, `evaluateExit`, and core's usage; action shape `{ side, lots, reason }` consistent between `evaluateExit` and `executeActions`.
