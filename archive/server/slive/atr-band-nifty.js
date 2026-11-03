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
    let today = moment().utcOffset(330).format('YYYY-MM-DD');
    let from = moment().utcOffset(330).subtract(7, 'days').format('YYYY-MM-DD');
    let candles = await zapi.historyData(spotToken, '60minute', from, today);
    // Freeze the ATR at the 09:15-10:15 hourly candle (start ts "09:15"). Drop any
    // of TODAY's later/forming hourly candles so a mid-session restart still
    // anchors to 10:15 rather than the current hour. (Prior-day candles are kept.)
    let upto = (candles || []).filter(c =>
      c.ts.substr(0, 10) !== today || c.ts.substr(11, 5) <= '09:15');
    let atr = logic.wilderATR(upto, atrPeriod);
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
    // Anchor to the 11:35-11:40 candle by timestamp (start ts "11:35"), not array
    // position — so a mid-session restart still uses the frozen 11:40 anchor and a
    // still-forming 11:40 candle is never selected. (from==to==today here.)
    let upto = (candles || []).filter(c => c.ts.substr(11, 5) <= '11:35');
    if (upto.length === 0) {
      console.log(strategyTag + ': no 5-min candle up to 11:35 yet, retrying in 30s...');
      setTimeout(computeLines, 30000);
      return;
    }
    let anchor = upto[upto.length - 1];   // 11:35-11:40 candle
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
    // Don't leave the position stuck in CLOSING (which would block the opposite
    // side's single entry for the rest of the day) if the SELL insert throws.
    position = null;
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
    if (mins >= 615) await computeWidth();   // past 10:15
    if (mins >= 700) await computeLines();   // past 11:40
    if (mins >= 855) entryClosed = true;     // past 14:15
  }
}
bootstrap();

console.log(strategyTag + ': Strategy loaded. atrPeriod=' + atrPeriod + ' width=ATR/' + widthDivisor +
  ' targetPts=' + targetPts + ' targetPct=' + targetPct + ' timeStopMin=' + timeStopMin + ' lots=' + lots);
