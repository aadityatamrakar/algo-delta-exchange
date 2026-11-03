const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const PaperTrade = app.models.PaperTrade;
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const otmSelector = require('../lib/otmSelector');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Opt_S';
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
  opt_high = 400,
  opt_low = 100;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // day range
    // if (moment().day() == 1) {
    //   opt_low = 100;
    //   opt_high = 400;
    // } else if (moment().day() == 2) {
    //   opt_low = 100;
    //   opt_high = 400;
    // } else if (moment().day() == 3) {
    //   opt_low = 100;
    //   opt_high = 400;
    // } else if (moment().day() == 3) {
    //   opt_low = 100;
    //   opt_high = 400;
    // } else if (moment().day() == 5) {
    //   opt_low = 100;
    //   opt_high = 400;
    // }

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(placeTrade, 15000);
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

  checkSLQ.push({
    check: 1
  });
}

let position = {
  CE: false,
  PE: false
};

async function placeTrade() {
  Object.values(currentExpiryOptions).forEach(opt => {
    let ltp = ticksCache[opt.instrument_token].last_price;
    let high = parseInt(ticksCache[opt.instrument_token].ohlc.high);
    let open = parseInt(ticksCache[opt.instrument_token].ohlc.open);

    if (high >= opt_low && high <= opt_high && open == high && ltp < high) {
      PaperTrade.trackOrder(opt, 'SELL', strategyTag);
      optionOrders.push({
        strike: opt.strike,
        type: opt.instrument_type,
        instrument_token: opt.instrument_token,
        sl_trigger: high
      });
    }
  });
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    if (ticksCache[check_option.instrument_token].last_price > check_option.sl_trigger) {
      delete optionOrders[idx];
      PaperTrade.trackOrder(currentExpiryOptions[check_option.strike + check_option.type], 'BUY', strategyTag);
      return false;
    } else return true;
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('45 19 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
