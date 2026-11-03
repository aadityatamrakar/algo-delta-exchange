// ORB + QuickScalp — 3-index Options (paper). Combined engine.
//
// ORB v6 SPOT signal (09:15-09:45 opening range, +/-0.10% buffer, body-close
// breakout) -> ATM option BUY (CE on up-break, PE on down-break). Managed by a
// small premium target, a per-index time-stop (setTimeout), and a wide spot
// stop at the opposite ORB end. One trade/day per index. BANKNIFTY, NIFTY and
// SENSEX all run in this one process (per-index state is isolated).
//
// Signal math reused from orb-fut-logic.js; execution decisions from
// orb-scalp-logic.js. Paper only: orders go through PaperTrade.trackOrder_v2
// (auto-filled by boot/paperstream.js at the live tick price). account/Zerodha
// are used ONLY for read-only login -> historyData + KiteTicker token. Never
// places live orders (no Account.placeAllAccount).

const CronJob = require('cron').CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const optionConfig = require('../tools/optionInstruments.js');
const notify = require('../lib/notify.js');
const async = require('async');
const moment = require('moment');
const orb = require('./orb-fut-logic.js');      // computeRange, passesFilter, breakoutSide (reused)
const scalp = require('./orb-scalp-logic.js');   // atmStrike, sideFromSignal, spotSl, evaluateExit

const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;

// ---- Per-index config ----
const CONFIGS = [
  { tag: 'ORB_SCALP_BN',    underlying: 'BANKNIFTY', spotToken: 260105, rangeFilterPts: 250, strikeStep: 100, targetPts: 40, timeStopMin: 90 },
  { tag: 'ORB_SCALP_NIFTY', underlying: 'NIFTY',     spotToken: 256265, rangeFilterPts: 0,   strikeStep: 50,  targetPts: 20, timeStopMin: 60 },
  { tag: 'ORB_SCALP_SNX',   underlying: 'SENSEX',    spotToken: 265,    rangeFilterPts: 0,   strikeStep: 100, targetPts: 25, timeStopMin: 90 },
];
const BUFFER_PCT = 0.001;   // 0.10%
const LOTS = 1;

// ---- State ----
let zapi, public_token;
let started = false;        // guards double init on the same morning
let ticksCache = {};
let states = {};            // keyed by underlying: per-index isolated state

function freshState() {
  return {
    chain: null,                                   // nearest-expiry option map (strike+type -> inst)
    rangeHigh: 0, rangeLow: 0, range: 0,
    linesReady: false, dayBlocked: false,
    tradedToday: false,                            // enforces 1 trade/day (blocks re-entry)
    entryClosed: false,                            // set at 14:00 — no new entries after
    position: null,                                // { side, instrument, entryPremium, target, slSpot, entryTime, status, timeStopTimer }
  };
}

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
  liveFeed.on('ticks', checkTicks);
  liveFeed.on('connect', function () {
    console.log('ORB_SCALP: Live Feed Connected');
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
  CONFIGS.forEach(function (cfg) { states[cfg.underlying] = freshState(); });
  try {
    let subs = [];
    for (let cfg of CONFIGS) {
      let data = await optionConfig.download(cfg.underlying);
      states[cfg.underlying].chain = data.weeklyInstruments;   // nearest expiry (monthly for BNF, weekly for NIFTY/SENSEX)
      let optionTokens = Object.values(data.weeklyInstruments).map(c => c.instrument_token);
      subs.push(cfg.spotToken);
      subs = subs.concat(optionTokens);
    }
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker(subs.filter(Boolean));
    console.log('ORB_SCALP: Initialized. ' + CONFIGS.length + ' indices, ' + subs.length + ' tokens subscribed.');
  } catch (err) {
    started = false;
    console.log('ORB_SCALP runStrategy error:', err);
  }
}

// Set each index's opening range from the first six 5-min SPOT candles (09:15-09:45).
async function setupRange() {
  let today = new Date().toISOString().substr(0, 10);
  for (let cfg of CONFIGS) {
    let st = states[cfg.underlying];
    if (!st || st.linesReady || st.dayBlocked) continue;
    try {
      let candles = await zapi.historyData(cfg.spotToken, '5minute', today, today);
      let r = orb.computeRange(candles, 6);
      if (!r) {
        console.log(cfg.tag + ': range candles not ready.');
        continue;   // outer retry below picks it up
      }
      st.rangeHigh = r.rangeHigh; st.rangeLow = r.rangeLow; st.range = r.range;
      if (!orb.passesFilter(r.range, cfg.rangeFilterPts)) {
        st.dayBlocked = true;
        console.log(cfg.tag + ': range ' + r.range.toFixed(2) + ' < filter ' + cfg.rangeFilterPts + ', day blocked.');
        notify(cfg.tag + ' day blocked (range ' + r.range.toFixed(0) + ' < ' + cfg.rangeFilterPts + ')', 0);
        continue;
      }
      st.linesReady = true;
      console.log(cfg.tag + ': Range set. HIGH=' + r.rangeHigh.toFixed(2) +
        ' LOW=' + r.rangeLow.toFixed(2) + ' RANGE=' + r.range.toFixed(2));
    } catch (err) {
      console.log(cfg.tag + ' setupRange error:', err);
    }
  }
  // Retry only for indices whose candles are not in yet (not ready and not blocked).
  let pending = CONFIGS.some(function (cfg) {
    let st = states[cfg.underlying];
    return st && !st.linesReady && !st.dayBlocked;
  });
  if (pending) setTimeout(setupRange, 30000);
}

function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) { ob[el.instrument_token] = el; return ob; }, {});
  Object.assign(ticksCache, ticks2);
  for (let cfg of CONFIGS) {
    let st = states[cfg.underlying];
    if (st && st.position && st.position.status === 'ACTIVE') checkExits(cfg, st);
  }
}

// Evaluate the last completed 5-min SPOT candle for a buffered body break, per index.
async function checkBreakout() {
  let today = new Date().toISOString().substr(0, 10);
  for (let cfg of CONFIGS) {
    let st = states[cfg.underlying];
    if (!st || !st.linesReady || st.tradedToday || st.entryClosed || st.position || st.dayBlocked) continue;
    try {
      let candles = await zapi.historyData(cfg.spotToken, '5minute', today, today);
      if (!candles || candles.length < 7) continue;   // 6 range candles + >=1 more
      let c = candles[candles.length - 1];             // last completed candle
      let signal = orb.breakoutSide(c.close, st.rangeHigh, st.rangeLow, BUFFER_PCT);
      if (signal) {
        console.log(cfg.tag + ': ' + signal + ' breakout — close=' + c.close +
          ' H=' + st.rangeHigh.toFixed(2) + ' L=' + st.rangeLow.toFixed(2));
        await enterPosition(cfg, st, signal);
      }
    } catch (err) {
      console.log(cfg.tag + ' checkBreakout error:', err);
    }
  }
}

// Find the ATM option, falling back to the nearest listed strike.
function findOption(chain, strike, type, strikeStep) {
  let deltas = [0, strikeStep, -strikeStep, 2 * strikeStep, -2 * strikeStep];
  for (let d of deltas) {
    let inst = chain[(strike + d) + type];
    if (inst) return inst;
  }
  return null;
}

async function enterPosition(cfg, st, signal) {
  if (st.position || st.tradedToday) return;
  try {
    let spotTick = ticksCache[cfg.spotToken];
    if (!spotTick || typeof spotTick.last_price !== 'number') {
      console.log(cfg.tag + ': no spot tick, abort entry (will retry next candle)');
      return;
    }
    let spotLtp = spotTick.last_price;
    let type = scalp.sideFromSignal(signal);          // 'CE' | 'PE'
    let strike = scalp.atmStrike(spotLtp, cfg.strikeStep);
    let inst = findOption(st.chain, strike, type, cfg.strikeStep);
    if (!inst) {
      console.log(cfg.tag + ': ATM option not found near ' + strike + type + ', abort entry');
      return;
    }

    let optTick = ticksCache[inst.instrument_token];
    if (!optTick || typeof optTick.last_price !== 'number') {
      console.log(cfg.tag + ': no option tick for ' + inst.tradingsymbol + ', abort entry (will retry next candle)');
      return;   // do NOT set tradedToday — allow retry on the next 5-min check
    }
    let entryPremium = optTick.last_price;

    await PaperTrade.trackOrder_v2(inst, 'BUY', cfg.tag, LOTS);
    st.tradedToday = true;   // only after a successful order — enforces 1 trade/day

    st.position = {
      side: type,
      instrument: inst,
      entryPremium: entryPremium,
      target: entryPremium + cfg.targetPts,
      slSpot: scalp.spotSl(type, st.rangeHigh, st.rangeLow),   // opposite ORB end (spot)
      entryTime: new Date(),
      status: 'ACTIVE',
      timeStopTimer: setTimeout(function () { closePosition(cfg, st, 'TIME'); }, cfg.timeStopMin * 60000),
    };

    let qty = inst.lot_size * LOTS;
    console.log('=== ' + cfg.tag + ' ENTRY ===');
    console.log('Type:', type, '| Symbol:', inst.tradingsymbol, '| Strike:', strike);
    console.log('Entry premium:', entryPremium, '| Target:', st.position.target,
      '| SL spot:', st.position.slSpot.toFixed(2), '| Qty:', qty);
    notify(cfg.tag + ' ENTRY ' + type + ' ' + inst.tradingsymbol + ' @ ' + entryPremium +
      ' tgt ' + st.position.target + ' slSpot ' + st.position.slSpot.toFixed(0), 0);
  } catch (err) {
    console.log(cfg.tag + ' enterPosition error:', err);
  }
}

function checkExits(cfg, st) {
  let pos = st.position;
  if (!pos || pos.status !== 'ACTIVE') return;
  let optTick = ticksCache[pos.instrument.instrument_token];
  let spotTick = ticksCache[cfg.spotToken];
  let optLtp = (optTick && typeof optTick.last_price === 'number') ? optTick.last_price : NaN;
  let spotLtp = (spotTick && typeof spotTick.last_price === 'number') ? spotTick.last_price : NaN;
  let res = scalp.evaluateExit(pos, optLtp, spotLtp);
  if (res.exit) closePosition(cfg, st, res.reason);
}

async function closePosition(cfg, st, reason) {
  let pos = st.position;
  if (!pos || pos.status !== 'ACTIVE') return;
  pos.status = 'CLOSING';   // synchronous guard against re-entrant ticks / timer race
  try {
    if (pos.timeStopTimer) clearTimeout(pos.timeStopTimer);
    let inst = pos.instrument;
    let optTick = ticksCache[inst.instrument_token];
    let exitPrice = (optTick && typeof optTick.last_price === 'number') ? optTick.last_price : pos.entryPremium;

    await PaperTrade.trackOrder_v2(inst, 'SELL', cfg.tag, LOTS);
    pos.status = 'CLOSED';

    let qty = inst.lot_size * LOTS;
    let pnl = (exitPrice - pos.entryPremium) * qty;
    console.log('=== ' + cfg.tag + ' EXIT (' + reason + ') ===');
    console.log('Symbol:', inst.tradingsymbol, '| Entry:', pos.entryPremium,
      '| Exit:', exitPrice, '| P&L:', pnl.toFixed(2), '| Qty:', qty);
    notify(cfg.tag + ' EXIT ' + reason + ' ' + inst.tradingsymbol + ' @ ' + exitPrice +
      ' pnl ' + pnl.toFixed(0), 0);
  } catch (err) {
    console.log(cfg.tag + ' closePosition error:', err);
  }
}

async function eodExit() {
  for (let cfg of CONFIGS) {
    let st = states[cfg.underlying];
    if (st && st.position && st.position.status === 'ACTIVE') {
      console.log(cfg.tag + ': EOD square-off (option)');
      await closePosition(cfg, st, 'EOD');
    }
  }
}

function closeEntries() {
  CONFIGS.forEach(function (cfg) { if (states[cfg.underlying]) states[cfg.underlying].entryClosed = true; });
  console.log('ORB_SCALP: entry window closed (14:00).');
}

// Serialize breakout checks so overlapping historyData calls can't race.
var checkBreakoutQ = async.queue(function (task, callback) {
  checkBreakout().then(function () { callback(); });
}, 1);

// ---- Schedule (IST, Mon-Fri) ----
new CronJob('20 45 9 * * 1-5', setupRange, null, true, 'Asia/Kolkata');       // 09:45:20 range
new CronJob('10 */5 9-13 * * 1-5', function () { checkBreakoutQ.push({}); }, null, true, 'Asia/Kolkata'); // 09:00..13:55 checks
new CronJob('10 0 14 * * 1-5', function () { checkBreakoutQ.push({}); }, null, true, 'Asia/Kolkata');     // 14:00 last check
new CronJob('30 0 14 * * 1-5', closeEntries, null, true, 'Asia/Kolkata');     // 14:00:30 entry deadline
new CronJob('0 15 15 * * 1-5', eodExit, null, true, 'Asia/Kolkata');          // 15:15 safety square-off
new CronJob('0 30 15 * * 1-5', function () {                                  // 15:30 process exit
  setTimeout(function () { process.exit(); }, 3000);
}, null, true, 'Asia/Kolkata');

// Log in / connect the feed on load — like every running slive strategy
// (cheetah-b1-1, eagle-s-1). xtsOrder starts/stops the process; runStrategy()
// runs unconditionally on load. Phase catch-up stays gated for mid-session restarts.
async function bootstrap() {
  let m = moment().utcOffset(330);
  let day = m.day();          // 0 Sun .. 6 Sat
  let mins = istMinutes();
  console.log('ORB_SCALP: start (IST ' + m.format('HH:mm') + '), initializing...');
  await runStrategy();
  if (day >= 1 && day <= 5 && mins >= 540 && mins < 930) {   // mid-session restart: catch up phases
    if (mins >= 586) await setupRange();   // past 09:46
    if (mins >= 840) closeEntries();       // past 14:00
  }
}
bootstrap();

console.log('ORB_SCALP: Strategy loaded. ' + CONFIGS.map(function (c) {
  return c.underlying + '(tgt' + c.targetPts + '/ts' + c.timeStopMin + '/filt' + c.rangeFilterPts + ')';
}).join(' ') + ' bufferPct=' + BUFFER_PCT + ' lots=' + LOTS);
