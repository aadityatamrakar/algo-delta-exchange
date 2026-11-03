const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const PaperTrade = app.models.PaperTrade;
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const otmSelector = require('./../lib/otmSelector');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Opt_B';
let sl_pts = 20;

let zapi;
let public_token = false;
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

let futureToken, currentExpiryOptions = {},
  fromDate, toDate;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = otmSelector();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [];

let ticksCache = {},
  startTrade = false;
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  takePositionQ.push({
    check: 1
  });
  checkSLQ.push({
    check: 1
  });
}

let position = {
  CE: false,
  PE: false
};
let strikesTraded = {};
async function placeTrade() {
  Object.values(currentExpiryOptions).forEach(opt => {
    let ltp = ticksCache[opt.instrument_token].last_price;
    let low = ticksCache[opt.instrument_token].ohlc.low;
    let trg = low * 1.5;
    let tgt = trg * 1.5;
    if (!position[opt.instrument_type] && low > 121 && low < 161 && trg < ltp) {
      if (strikesTraded[opt.instrument_token]) strikesTraded[opt.instrument_token] += 1;
      else strikesTraded[opt.instrument_token] = 1;
      if (strikesTraded[opt.instrument_token] < 4) {
        position[opt.instrument_type] = true;
        PaperTrade.trackOrder(opt, 'BUY', strategyTag);
        optionOrders.push({
          strike: opt.strike,
          type: opt.instrument_type,
          instrument_token: opt.instrument_token,
          sl_trigger: ltp - sl_pts,
          tgt_trigger: tgt
        });
      }
    }
  });
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    if (ticksCache[check_option.instrument_token].last_price < check_option.sl_trigger) {
      delete optionOrders[idx];
      PaperTrade.trackOrder(currentExpiryOptions[check_option.strike + check_option.type], 'SELL', strategyTag);
      position[check_option.type] = false;
      return false;
    } else if (ticksCache[check_option.instrument_token].last_price > check_option.tgt_trigger) {
      delete optionOrders[idx];
      PaperTrade.trackOrder(currentExpiryOptions[check_option.strike + check_option.type], 'SELL', strategyTag);
      return false;
    } else return true;
  });
}

var takePositionQ = async.queue(function (task, callback) {
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
new CronJob('0 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
