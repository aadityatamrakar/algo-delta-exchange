const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Account = app.models.account;
const tulind = require('tulind');
const kiteTicker = require('./../lib/KiteTicker');
const optionConfig = require('./../tools/optionInstruments');
const async = require('async');
const fs = require('fs');
const sma = require('./../lib/indicators/sma');
const moment = require('moment');
const {
  b76_ivol
} = require('./../lib/option-pricing');
const otmSelector = require('./../lib/otmSelector');

let strategyTag = 'Whale';
let sl_percent = 1.10;

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

let farOtm, indexToken, futureToken, futureSymbol, currentExpiryOptions, zapi, timestamp, callOptions, putOptions;
async function init() {
  let optionData = await optionConfig();
  futureToken = optionData.currentFuture.token;
  futureSymbol = optionData.currentFuture.symbol;
  indexToken = 260105;
  farOtm = otmSelector();
  currentExpiryOptions = optionData.weeklyInstruments;
  callOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'CE');
  putOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'PE');
  let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
  ticker([futureToken, indexToken, ...optionTokens]);
}

let futurePrice = 0,
  indexPrice = 0,
  ticksCache = {},
  tickHistory = {},
  tte = moment().day(4).hour(15).minute(30).utcOffset('+05:30');
if ((tte.diff(moment(), 'minutes') / 1440) < 0) {
  tte = moment().add(1, 'week').day(4).hour(15).minute(30).utcOffset('+05:30');
}

let lastTs = '',
  price = [],
  ce_iv = [],
  pe_iv = [],
  takeTrade = {
    ce: true,
    pe: true
  },
  waitForNext = {
    ce: false,
    pe: false
  };
async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);

  checkSLQ.push({
    check: 1
  });

  let ts = moment().millisecond(0).utcOffset('+0530').format('X');
  if (lastTs != ts) {
    lastTs = ts;
    indexPrice = _TP(indexToken);
    futurePrice = _TP(futureToken);
    ATM_strike = Math.round(indexPrice / 100) * 100;

    let iv_tick = {
      'index': indexPrice,
      'future': futurePrice,
      'atm_strike': ATM_strike,
      'atm_ce_price': _SP(ATM_strike + 'CE'),
      'atm_pe_price': _SP(ATM_strike + 'PE'),
      'atm_ce_vol': getVol(ATM_strike, 'C'),
      'atm_pe_vol': getVol(ATM_strike, 'P')
    };
    tickHistory[ts] = {
      time: parseInt(ts),
      index: indexPrice,
      ce_vol: iv_tick.atm_ce_vol,
      pe_vol: iv_tick.atm_pe_vol,
    };
    price.push(indexPrice);
    ce_iv.push(iv_tick.atm_ce_vol);
    pe_iv.push(iv_tick.atm_pe_vol);

    if (price.length > 220) {
      let ce_iv_sma = await SMA(ce_iv, 200);
      let pe_iv_sma = await SMA(pe_iv, 200);
      let ce_iv_rsi = await RSI(ce_iv, 200);
      let pe_iv_rsi = await RSI(pe_iv, 200);

      let ce_iv_sma_val = ce_iv_sma.slice(-1)[0];
      let pe_iv_sma_val = pe_iv_sma.slice(-1)[0];
      let ce_iv_rsi_val = ce_iv_rsi.slice(-2)[0];
      let pe_iv_rsi_val = pe_iv_rsi.slice(-2)[0];

      let diff_per_ce = (iv_tick.atm_ce_vol / ce_iv_sma_val) * 100;
      let diff_per_pe = (iv_tick.atm_pe_vol / pe_iv_sma_val) * 100;

      if (takeTrade.ce && diff_per_ce > 110 && iv_tick.atm_ce_vol > ce_iv_sma_val) {
        takeTrade.ce = false;
        // notify(strategyTag + ': Bearish Setup found');
      } else if (!waitForNext.ce && !takeTrade.ce && iv_tick.atm_ce_vol < ce_iv_sma_val) {
        takeTrade.ce = true;
        waitForNext.ce = true;
        // notify(strategyTag + ': Entering Short CE Trade');
        sendOrder(currentExpiryOptions[(ATM_strike + farOtm) + "CE"]);
        setTimeout(_ => {
          waitForNext.ce = false;
        }, 120000);
      }

      if (takeTrade.pe && diff_per_pe > 110 && iv_tick.atm_pe_vol > pe_iv_sma_val) {
        takeTrade.pe = false;
        // notify(strategyTag + ': Bullish Setup found');
      } else if (!waitForNext.pe && !takeTrade.pe && iv_tick.atm_pe_vol < pe_iv_sma_val) {
        takeTrade.pe = true;
        waitForNext.pe = true;
        // notify(strategyTag + ': Entering Short PE Trade');
        sendOrder(currentExpiryOptions[(ATM_strike - farOtm) + "PE"]);
        setTimeout(_ => {
          waitForNext.pe = false;
        }, 120000);
      }

      console.log(moment().utcOffset('+0530').format(), diff_per_ce, diff_per_pe, ce_iv_rsi_val, pe_iv_rsi_val);

      price.shift();
      ce_iv.shift();
      pe_iv.shift();
    }
  }
}

let optionOrders = [];
let accounts = [],
  running_accounts = [],
  account_quantities = {},
  firstRun = true;
async function sendOrder(strike) {
  let opt_ltp = ticksCache[strike.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, strike, 'SELL', 4);
  optionOrders.push({
    strike: strike.strike,
    type: strike.instrument_type,
    instrument_token: strike.instrument_token,
    sl_trigger: opt_ltp * sl_percent,
    sl_hit: false
  });
}

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

// init();
new CronJob('0 14 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
