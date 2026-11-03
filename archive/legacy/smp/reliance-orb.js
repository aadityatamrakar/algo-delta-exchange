const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/futureInstruments');
const async = require('async');
const otmSelector = require('../lib/otmSelector');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Rel_ORB';

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
  account_quantities = {};

let tradeableSymbols, instrumentToken, startTrade = false;
async function runStrategy() {
  try {
    tradeableSymbols = await optionConfig(["RELIANCE"]);
    instrumentToken = 738561;
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([instrumentToken, ...Object.values(tradeableSymbols).map(c => c.instrument_token)]);

    new CronJob('0 20 9 * * 1-5', function () {
      placeTradeQ.push({
        check: 1
      });
    }, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log('main err', err);
  }
}

let pendingOrdersBuy = [],
  pendingOrdersSell = [],
  optionOrders = [];

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  // checkLimitQ.push({
  //   check: 1
  // });
  checkSLQ.push({
    check: 1
  });
}

async function placeTrade() {
  pendingOrdersBuy = Object.values(tradeableSymbols).map(symb => {
    let symbol_tick = JSON.parse(JSON.stringify(ticksCache[instrumentToken]));
    symb.upper_limit = symbol_tick.ohlc.high;
    return symb;
  });
  pendingOrdersSell = Object.values(tradeableSymbols).map(symb => {
    let symbol_tick = JSON.parse(JSON.stringify(ticksCache[instrumentToken]));
    symb.lower_limit = symbol_tick.ohlc.low;
    return symb;
  });

  console.log(pendingOrdersBuy, pendingOrdersSell);
  new CronJob('0 */5 * * * 1-5', checkLimit, null, true, 'Asia/Kolkata');
}

async function sendOrder(instrument, type) {
  let ltp = ticksCache[instrument.instrument_token].last_price;
  let sl_trigger, target_trigger;

  if (type == 'BUY') {
    sl_trigger = ticksCache[instrument.instrument_token].ohlc.low, target_trigger = ltp + 10;
  } else if (type == 'SELL') {
    sl_trigger = ticksCache[instrument.instrument_token].ohlc.high, target_trigger = ltp - 10;
  }

  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument, type);
  optionOrders.push({
    instrument: instrument,
    type: type,
    instrument_token: instrument.instrument_token,
    sl_trigger: sl_trigger,
    target_trigger: target_trigger
  });
}

async function checkLimit() {
  pendingOrdersBuy.forEach(async (symbol, idx) => {
    if (ticksCache[symbol.instrument_token].last_price >= symbol.upper_limit) {
      delete pendingOrdersBuy[idx];
      sendOrder(symbol, 'BUY');
      return false;
    } else return true;
  });
  pendingOrdersSell.forEach(async (symbol, idx) => {
    if (ticksCache[symbol.instrument_token].last_price <= symbol.lower_limit) {
      delete pendingOrdersSell[idx];
      sendOrder(symbol, 'SELL');
      return false;
    } else return true;
  });
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;

    if (check_option.type == 'BUY') {
      if (ticksCache[check_option.instrument_token].last_price < ce_position.sl_trigger) {
        delete optionOrders[idx];
        await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, check_option.instrument, 'SELL');
        return false;
      } else
      if (ticksCache[check_option.instrument_token].last_price > ce_position.target_trigger) {
        delete optionOrders[idx];
        await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, check_option.instrument, 'SELL');
        return false;
      }
    } else if (check_option.type == 'SELL') {
      if (ticksCache[check_option.instrument_token].last_price > ce_position.sl_trigger) {
        delete optionOrders[idx];
        await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, check_option.instrument, 'BUY');
        return false;
      } else
      if (ticksCache[check_option.instrument_token].last_price < ce_position.target_trigger) {
        delete optionOrders[idx];
        await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, check_option.instrument, 'BUY');
        return false;
      }
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
var checkLimitQ = async.queue(function (task, callback) {
  checkLimit().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('40 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  startTrade = false;
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
