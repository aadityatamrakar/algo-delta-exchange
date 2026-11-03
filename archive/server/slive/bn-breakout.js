// BankNifty 0.09% Breakout (STOXGEN) — paper strategy
//
// First 5-min index candle (09:15-09:20) close defines a ±0.09% band.
// A later 5-min candle whose BODY closes through the band (with matching
// colour) buys the ATM option of that side. Managed by a +45 premium
// target, a 90-min time stop, and an opposite-line spot stop. One trade per
// side per day: a losing trade leaves the opposite side tradeable, a
// profitable (or breakeven) trade ends the day.
//
// Paper only: orders go through PaperTrade.trackOrder_v2 (market, auto-filled
// by boot/paperstream.js at the live tick price). account/Zerodha are used
// ONLY for read-only login -> historyData + KiteTicker token. Never places
// live orders (no Account.placeAllAccount).

const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const optionConfig = require('../tools/optionInstruments.js');
const notify = require('../lib/notify.js');
const async = require('async');
const moment = require('moment');
const logic = require('./bn-breakout-logic.js');

const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;

// ---- Strategy config ----
let strategyTag = 'BN_BREAKOUT';
let spotToken = 260105;   // NIFTY BANK index
let offsetPct = 0.0009;   // 0.09%
let targetPts = 45;       // premium target (points)
let timeStopMin = 90;     // minutes
let lots = 1;             // multiplier -> qty = lot_size * lots
let strikeStep = 100;     // BankNifty strike interval

// ---- State ----
let zapi, public_token;
let currentExpiryOptions = {}, weeklyExpiry = '';
let baseClose = 0, highLine = 0, lowLine = 0;
let linesReady = false;
let tradedSides = { CE: false, PE: false };   // one trade per side per day
let stopForDay = false;    // set when a trade closes at profit — no more entries today
let entryClosed = false;   // set at 13:30 — no new entries after
let started = false;       // guards double init on the same morning
let position = null;       // option leg: { side, instrument, entryPremium, target, slSpot, entryTime, status, timeStopTimer }
let ticksCache = {};

// ---- Zerodha read-only login (for market data only) ----
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
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
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
  linesReady = false;
  tradedSides = { CE: false, PE: false };
  stopForDay = false;
  entryClosed = false;
  position = null;
  try {
    let optionData = await optionConfig('BANKNIFTY');
    currentExpiryOptions = optionData.weeklyInstruments;   // nearest expiry = monthly for BankNifty
    weeklyExpiry = optionData.weeklyExpiry;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    ticker([spotToken, ...optionTokens].filter(Boolean));
    console.log(strategyTag + ': Initialized. Spot + ' +
      optionTokens.length + ' option tokens subscribed. Expiry: ' + weeklyExpiry);
  } catch (err) {
    started = false;
    console.log(strategyTag + ' runStrategy error:', err);
  }
}

// Set the ±0.09% band from the first 5-min spot candle (09:15-09:20)
async function computeLines() {
  if (linesReady) return;
  try {
    let today = new Date().toISOString().substr(0, 10);
    let candles = await zapi.historyData(spotToken, '5minute', today, today);
    if (!candles || candles.length === 0) {
      console.log(strategyTag + ': No spot candles yet, retrying in 30s...');
      setTimeout(computeLines, 30000);
      return;
    }
    let first = candles[0];   // 09:15-09:20
    baseClose = first.close;
    let band = logic.firstCandleBand(baseClose, offsetPct);
    highLine = band.highLine;
    lowLine = band.lowLine;
    let offset = highLine - baseClose;
    linesReady = true;
    console.log(strategyTag + ': Lines set. base(9:15-9:20 close)=' + baseClose +
      ' offset=' + offset.toFixed(2) + ' HIGH=' + highLine.toFixed(2) + ' LOW=' + lowLine.toFixed(2));
  } catch (err) {
    console.log(strategyTag + ' computeLines error:', err);
    setTimeout(computeLines, 30000);
  }
}

function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  if (position && position.status === 'ACTIVE') checkExits();
}

// Evaluate the last completed 5-min spot candle for a body break
async function checkBreakout() {
  if (!linesReady || stopForDay || entryClosed || position) return;
  try {
    let today = new Date().toISOString().substr(0, 10);
    let candles = await zapi.historyData(spotToken, '5minute', today, today);
    if (!candles || candles.length < 2) return;   // need the line candle + at least one more

    let c = candles[candles.length - 1];   // last completed candle
    let side = logic.breakoutSide(c, highLine, lowLine);

    if (side === 'CE' && !tradedSides.CE) {
      console.log(strategyTag + ': CE breakout — candle close=' + c.close + ' > HIGH=' + highLine.toFixed(2));
      await enterPosition('CE');
    } else if (side === 'PE' && !tradedSides.PE) {
      console.log(strategyTag + ': PE breakout — candle close=' + c.close + ' < LOW=' + lowLine.toFixed(2));
      await enterPosition('PE');
    }
  } catch (err) {
    console.log(strategyTag + ' checkBreakout error:', err);
  }
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

async function enterPosition(side) {
  if (position || stopForDay || tradedSides[side]) return;
  try {
    let spotTick = ticksCache[spotToken];
    if (!spotTick || typeof spotTick.last_price !== 'number') {
      console.log(strategyTag + ': no spot tick, abort entry (will retry next candle)');
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
      console.log(strategyTag + ': no option tick for ' + inst.tradingsymbol + ', abort entry (will retry next candle)');
      return;   // do NOT mark the side traded — allow retry on the next 5-min check
    }
    let entryPremium = optTick.last_price;

    await PaperTrade.trackOrder_v2(inst, 'BUY', strategyTag, lots);
    tradedSides[side] = true;   // only after a successful order — one trade per side per day

    position = {
      side: side,
      instrument: inst,
      entryPremium: entryPremium,
      target: logic.optionTarget(entryPremium, targetPts),
      slSpot: logic.slSpotFor(side, highLine, lowLine),   // opposite-line spot break
      entryTime: new Date(),
      status: 'ACTIVE',
      timeStopTimer: setTimeout(function () { closePosition('TIME'); }, timeStopMin * 60000)
    };

    let qty = inst.lot_size * lots;
    console.log('=== ' + strategyTag + ' ENTRY ===');
    console.log('Side:', side, '| Symbol:', inst.tradingsymbol, '| Strike:', strike);
    console.log('Entry premium:', entryPremium, '| Target:', position.target,
      '| SL spot:', position.slSpot.toFixed(2), '| Qty:', qty);
    notify(strategyTag + ' ENTRY ' + side + ' ' + inst.tradingsymbol + ' @ ' + entryPremium +
      ' tgt ' + position.target + ' slSpot ' + position.slSpot.toFixed(0), 0);
  } catch (err) {
    console.log(strategyTag + ' enterPosition error:', err);
  }
}

function checkExits() {
  if (!position || position.status !== 'ACTIVE') return;

  let optTick = ticksCache[position.instrument.instrument_token];
  let optLtp = (optTick && typeof optTick.last_price === 'number') ? optTick.last_price : undefined;
  let spotTick = ticksCache[spotToken];
  let spotLtp = (spotTick && typeof spotTick.last_price === 'number') ? spotTick.last_price : undefined;

  let result = logic.evaluateExit(position, optLtp, spotLtp);
  if (result.exit) closePosition(result.reason);
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

    // Profitable (or breakeven) trade ends the day; a loss leaves the
    // opposite side tradeable (one trade per side per day).
    let other = position.side === 'CE' ? 'PE' : 'CE';
    let continues = logic.dayContinuesAfterExit(pnl, tradedSides[other]);
    stopForDay = !continues;
    if (pnl >= 0) {
      console.log(strategyTag + ': trade closed in profit — done for the day');
    } else if (continues) {
      console.log(strategyTag + ': trade closed at a loss — ' + other + ' side still tradeable');
    }
    position = null;   // free the slot so an opposite-side breakout can enter
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

// Serialize breakout checks so overlapping historyData calls can't race
var checkBreakoutQ = async.queue(function (task, callback) {
  checkBreakout().then(function () { callback(); });
}, 1);

// ---- Schedule (IST, Mon-Fri) ----
new CronJob('0 21 9 * * 1-5', computeLines, null, true, 'Asia/Kolkata');      // 09:21 set band
new CronJob('10 */5 9-13 * * 1-5', function () {                              // 09:25..13:30 entry checks
  checkBreakoutQ.push({});
}, null, true, 'Asia/Kolkata');
new CronJob('0 31 13 * * 1-5', function () {                                  // 13:30 entry deadline
  entryClosed = true;
  console.log(strategyTag + ': entry window closed (13:30).');
}, null, true, 'Asia/Kolkata');
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
  console.log(strategyTag + ': start (IST ' + m.format('HH:mm') + '), initializing...');
  await runStrategy();
  if (day >= 1 && day <= 5 && mins >= 540 && mins < 930) {   // mid-session restart: catch up phases
    if (mins >= 561) await computeLines();   // past 09:21
    if (mins >= 811) entryClosed = true;     // past 13:30
  }
}
bootstrap();

console.log(strategyTag + ': Strategy loaded. offsetPct=' + offsetPct +
  ' targetPts=' + targetPts + ' timeStopMin=' + timeStopMin + ' lots=' + lots);
