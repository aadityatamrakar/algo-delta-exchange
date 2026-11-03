// ORB v6 — Index Futures (paper) — shared engine.
//
// 09:15-09:45 opening range on the current-month future. A later 5-min candle
// whose CLOSE clears the range +/- 0.10% buffer goes long (BUY) / short (SELL)
// the future. One lot, SL at the opposite ORB end, single target T1 (1x range) —
// the whole position exits on the first trigger. One trade/day, force-exit 15:15.
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
        '| SL:', position.sl.toFixed(2), '| T1:', position.t1.toFixed(2), '| Qty:', qty);
      notify(strategyTag + ' ENTRY ' + side + ' ' + futInstrument.tradingsymbol + ' @ ' + entry +
        ' sl ' + position.sl.toFixed(0) + ' t1 ' + position.t1.toFixed(0), 0);
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

  // Log in / connect the feed on load — like every running slive strategy
  // (cheetah-b1-1, eagle-s-1). xtsOrder starts/stops the process; runStrategy()
  // runs unconditionally on load. Phase catch-up stays gated for mid-session restarts.
  async function bootstrap() {
    let m = moment().utcOffset(330);
    let day = m.day();
    let mins = istMinutes();
    console.log(strategyTag + ': start (IST ' + m.format('HH:mm') + '), initializing...');
    await runStrategy();
    if (day >= 1 && day <= 5 && mins >= 540 && mins < 930) { // mid-session restart: catch up phases
      if (mins >= 586) await setupRange();   // past 09:46
      if (mins >= 840) entryClosed = true;   // past 14:00
    }
  }
  bootstrap();

  console.log(strategyTag + ': loaded. underlying=' + underlying +
    ' rangeFilter=' + rangeFilterPts + ' lots=' + lots + ' bufferPct=' + bufferPct);
};
