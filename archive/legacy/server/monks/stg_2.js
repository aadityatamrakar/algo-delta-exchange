const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'STG2';

let zapi;
let public_token;
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
    console.log('Live Feed Connected');
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

let accounts = [],
  running_accounts = [],
  account_quantities = {},
  firstRun = true;
async function getAccounts() {
  let accountsData = await Account.loadAccounts(strategyTag, firstRun);
  accounts = accountsData.accounts;
  account_quantities = accountsData.account_quantities;
  if (firstRun) {
    running_accounts = accountsData.running_accounts;
    firstRun = false;
  }
}

let futureToken, currentExpiryOptions = {},
  fromDate, toDate, farOtm,
  prev_open, prev_close, startTrade = false;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 10);
    toDate = new Date();
    toDate.setDate(toDate.getDate() - 1);

    let candleData = await zapi.historyData(futureToken, 'day', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
    let lastCandle = candleData.slice(-1)[0];
    prev_open = lastCandle.open;
    prev_close = lastCandle.close;

    new CronJob('0 20 9 * * 1-5', function () {
      startTrade = true;
    }, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [];

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  if (startTrade) {
    placeTradeQ.push({
      check: 1
    });
  }

  checkSLQ.push({
    check: 1
  });
}

let tradePos = {
  CE: true,
  PE: true
};
async function placeTrade() {
  bn_quote = ticksCache[futureToken];

  let optionsStrikes = Object.values(currentExpiryOptions).map(c => {
    c.distance = Math.abs(ticksCache[c.instrument_token].last_price - 120);
    return c;
  }).sort((a, b) => {
    return (a.distance - b.distance);
  });

  let ce_strike = false,
    pe_strike = false;
  for (i = 0; i < optionsStrikes.length; i++) {
    if (!ce_strike && optionsStrikes[i].instrument_type == 'CE') ce_strike = optionsStrikes[i].strike;
    if (!pe_strike && optionsStrikes[i].instrument_type == 'PE') pe_strike = optionsStrikes[i].strike;

    if (ce_strike && pe_strike) break;
  }

  let insideOpen = false;
  if (bn_quote.last_price > prev_close && bn_quote.last_price < prev_open) insideOpen = true;
  else if (bn_quote.last_price > prev_open && bn_quote.last_price < prev_close) insideOpen = true;

  let outsideOpen = false,
    trend_direction;
  if (prev_close > prev_open && bn_quote.last_price > prev_close) outsideOpen = true, trend_direction = 'PE';
  else if (prev_close < prev_open && bn_quote.last_price < prev_close) outsideOpen = true, trend_direction = 'CE';

  if (insideOpen) {
    if (tradePos['CE']) {
      sendOrder(ce_strike, "CE");
      tradePos['CE'] = false;
    }
    if (tradePos['PE']) {
      sendOrder(pe_strike, "PE");
      tradePos['PE'] = false;
    }
  }
  if (outsideOpen) {
    if (tradePos['CE'] && trend_direction == 'CE') {
      sendOrder(ce_strike, "CE");
      tradePos['CE'] = false;
    }
    if (tradePos['PE'] && trend_direction == 'PE') {
      sendOrder(pe_strike, "PE");
      tradePos['PE'] = false;
    }
  }
}

async function sendOrder(new_ATM_Strike, typeBuy) {
  let tradeStrike = parseInt(new_ATM_Strike);

  let ce_option = currentExpiryOptions[tradeStrike + typeBuy];
  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let trade_quantity = 1;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL', trade_quantity);
  optionOrders.push({
    strike: tradeStrike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    entry: ce_ltp,
    sl_trigger: ce_ltp * 1.25,
    quantity: trade_quantity
  });
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;

    if (ticksCache[check_option.instrument_token].last_price > ce_position.sl_trigger) {
      delete optionOrders[idx];
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[check_option.strike + check_option.type], 'BUY', check_option.quantity);
      return false;
    } else return true;
  });
}

var placeTradeQ = async.queue(function (task, callback) {
  placeTrade().then(function (res) {
    callback();
  });
}, 1);
var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('0 12 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  startTrade = false;
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
