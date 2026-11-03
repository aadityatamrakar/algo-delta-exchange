/*

Leap & Jump: 0.25p

*/

const CronJob = require("cron").CronJob;
const app = require('./server/server.js');
const Account = app.models.account;
const Positional = app.models.positional;
const kiteTicker = require('./server/lib/KiteTicker');
const optionConfig = require('./server/tools/optionInstruments');
const async = require('async');
const moment = require('moment');
let otmStrike = {};

let liveFeed;
const public_token = false;
async function ticker(subs) {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
    // console.log('subscribing', subs);
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

let farOtmMin, farOtmMax, indexToken, futureToken, futureSymbol, currentExpiryOptions, zapi, timestamp, callOptions, putOptions;
async function init() {
  let optionData = await optionConfig();
  futureToken = optionData.currentFuture.token;
  futureSymbol = optionData.currentFuture.symbol;
  indexToken = 260105;
  farOtmMin = 5;
  farOtmMid = 7;
  farOtmMax = 25;
  currentExpiryOptions = optionData.weeklyInstruments;
  callOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'CE');
  putOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'PE');
  let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
  ticker([futureToken, indexToken, ...optionTokens]);
}

let futurePrice = 0,
  indexPrice = 0,
  ticksCache = {},
  tickHistory = {};

let lastTs = '',
  price = [],
  takeTrade = true,
  waitForNext = false,
  spreadAvailable = [],
  currentATM = false,
  lastATM = null;

async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);

  currentATM = Math.round(_TP(indexToken) / 100) * 100;

  console.log(_TP(indexToken), currentATM);
  if (currentATM !== lastATM) {
    lastATM = currentATM;
    spreadAvailable_CE = [];
    spreadAvailable_PE = [];
    for (i = farOtmMin; i < farOtmMid; i++) {
      let strike_1_ce = currentATM + (i * 100);
      let strike_1_pe = currentATM - (i * 100);
      for (j = i + 4; j < farOtmMax; j++) {
        if (i == j) continue;
        let strike_2_ce = currentATM + (j * 100);
        let strike_2_pe = currentATM - (j * 100);
        spreadAvailable_CE.push([strike_1_ce, strike_2_ce]);
        spreadAvailable_PE.push([strike_1_pe, strike_2_pe]);
      }
    }
  }

  calcSpread();
}

let orderPlace = true;
let ratiosAvailable = [2];
let rangeLow = 0;
let rangeHigh = -20;
async function calcSpread() {
  let filtered_ce = [];
  async.each(spreadAvailable_CE, function (spreadStrikes, cb) {
    async.each(ratiosAvailable, function (spreadRatio, cb2) {
      let strike_1 = _SP_ask(spreadStrikes[0] + 'CE');
      let strike_2 = _SP_bid(spreadStrikes[1] + 'CE') * spreadRatio;

      let spread_diff = strike_2 - strike_1;
      let gap = Math.abs(spreadStrikes[0] - spreadStrikes[1]);
      let distance = Math.abs(spreadStrikes[0] - currentATM);

      if (spread_diff < rangeLow && spread_diff > rangeHigh) {
        filtered_ce.push([spreadStrikes[0] + 'CE', spreadStrikes[1] + 'CE', spreadRatio, roundOff(strike_1), roundOff(_SP_bid(spreadStrikes[1] + 'CE')), roundOff(spread_diff), distance, gap]);
      }
      cb2();
    }, cb);
  }, function () {
    filtered_ce = filtered_ce.sort((a, b) => {
      return b[5] - a[5];
    });
    if (filtered_ce.length > 0) {
      console.log("CE", filtered_ce);
    }
  });

  let filtered_pe = [];
  async.each(spreadAvailable_PE, function (spreadStrikes, cb) {
    async.each(ratiosAvailable, function (spreadRatio, cb2) {
      let strike_1 = _SP_ask(spreadStrikes[0] + 'PE');
      let strike_2 = _SP_bid(spreadStrikes[1] + 'PE') * spreadRatio;

      let spread_diff = strike_2 - strike_1;
      let gap = Math.abs(spreadStrikes[0] - spreadStrikes[1]);
      let distance = Math.abs(spreadStrikes[0] - currentATM);

      if (spread_diff < rangeLow && spread_diff > rangeHigh) {
        filtered_pe.push([spreadStrikes[0] + 'PE', spreadStrikes[1] + 'PE', spreadRatio, roundOff(strike_1), roundOff(_SP_bid(spreadStrikes[1] + 'PE')), roundOff(spread_diff), distance, gap]);
      }
      cb2();
    }, cb);
  }, function () {
    filtered_pe = filtered_pe.sort((a, b) => {
      return b[5] - a[5];
    });
    if (filtered_pe.length > 0) {
      console.log("PE", filtered_pe);
    }
  });
}

async function sendPairOrder(ce_option, pe_option) {
  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL', 1);
  optionOrders.push({
    strike: ce_option.strike,
    type: "CE",
    instrument_token: ce_option.instrument_token,
    sl_trigger: ce_ltp * sl_percent,
    sl_hit: false
  });
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL', 1);
  optionOrders.push({
    strike: pe_option.strike,
    type: "PE",
    instrument_token: pe_option.instrument_token,
    sl_trigger: pe_ltp * sl_percent,
    sl_hit: false
  });
}

let optionOrders = [];
async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    if (ticksCache[check_option.instrument_token].last_price > check_option.sl_trigger) {
      delete optionOrders[idx];
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[check_option.strike + check_option.type], 'BUY', 1);
      return false;
    } else return true;
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

function getVol(strike, type) {
  let dte = (tte.diff(moment(), 'minutes') / 1440);
  let underlying_price = _TP(indexToken);

  let time_to_expiry = dte / 365;
  let risk_free_interest = 3.5;
  let price;

  if (type == 'C') price = _SP(strike + 'CE');
  else price = _SP(strike + 'PE');


  return Math.round(10000 * b76_ivol(type, underlying_price, strike, time_to_expiry, risk_free_interest, price)) / 100;
}

function sum(ar) {
  return ar.reduce((s, a) => (s += a, s), 0);
}

function roundOff(price) {
  return Math.round(price * 100) / 100;
}

function _TP(token) {
  return ticksCache[token].last_price;
}

function _SP(strike) {
  return Math.round(((ticksCache[currentExpiryOptions[strike].instrument_token].depth.buy[0].price + ticksCache[currentExpiryOptions[strike].instrument_token].depth.sell[0].price) / 2) * 100) / 100;
}

function _SP_bid(strike) {
  return ticksCache[currentExpiryOptions[strike].instrument_token].depth.buy[0].price;
}

function _SP_ask(strike) {
  return ticksCache[currentExpiryOptions[strike].instrument_token].depth.sell[0].price;
}

function _SP_bid_qty(strike) {
  return ticksCache[currentExpiryOptions[strike].instrument_token].depth.buy[0].quantity;
}

function _SP_ask_qty(strike) {
  return ticksCache[currentExpiryOptions[strike].instrument_token].depth.sell[0].quantity;
}

function SMA(ticks, period = 200) {
  return new Promise((resolve, reject) => {
    tulind.indicators.sma.indicator(
      [ticks],
      [period],
      function (err, results) {
        resolve(results[0]);
      }
    );
  })
}

function RSI(ticks, period = 200) {
  return new Promise((resolve, reject) => {
    tulind.indicators.rsi.indicator(
      [ticks],
      [period],
      function (err, results) {
        resolve(results[0]);
      }
    );
  })
}

init();
// new CronJob('0 14 9 * * 1-5', init, null, true, 'Asia/Kolkata');
// new CronJob('0 30 15 * * 1-5', function () {
//   process.exit();
// }, null, true, 'Asia/Kolkata');
