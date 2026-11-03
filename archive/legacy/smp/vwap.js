const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments.js');
const otmSelector = require('../lib/otmSelector.js');
const async = require('async');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'VWAP';
// let sl_percent = 1.05;

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

let futureToken, farOtm = 100,
  currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // farOtm = otmSelector();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    // setTimeout(takeTrade, 15000);
    new CronJob('0 */3 * * * 1-5', takeTrade, null, true, 'Asia/Kolkata');

  } catch (err) {
    console.log(err);
  }
}

let init_pending = true,
  ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
}

let optionOrders = [],
  currentSize = 1,
  currentOpenStrikes = {
    ce: false,
    pe: false
  };

async function takeTrade() {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

  if (currentOpenStrikes.ce == false) {
    currentOpenStrikes.ce = new_ATM_Strike + farOtm;
    let ce_opt = currentExpiryOptions[currentOpenStrikes.ce + "CE"];
    let ce_ltp = ticksCache[ce_opt.instrument_token].last_price;
    let ce_avg = ticksCache[ce_opt.instrument_token].average_price;

    if (ce_ltp < ce_avg) {
      PaperTrade.trackOrder(ce_opt, "SELL", strategyTag);
      return;
    }
  } else {
    let ce_opt = currentExpiryOptions[currentOpenStrikes.ce + "CE"];
    let ce_ltp = ticksCache[ce_opt.instrument_token].last_price;
    let ce_avg = ticksCache[ce_opt.instrument_token].average_price;

    if (ce_ltp > ce_avg) {
      PaperTrade.trackOrder(ce_opt, "BUY", strategyTag);
      currentOpenStrikes.ce = false;
      return;
    }
  }

  if (currentOpenStrikes.pe == false) {
    currentOpenStrikes.pe = new_ATM_Strike - farOtm;
    let pe_opt = currentExpiryOptions[currentOpenStrikes.pe + "PE"];
    let pe_ltp = ticksCache[pe_opt.instrument_token].last_price;
    let pe_avg = ticksCache[pe_opt.instrument_token].average_price;

    if (pe_ltp < pe_avg) {
      PaperTrade.trackOrder(pe_opt, "SELL", strategyTag);
      return;
    }
  } else {
    let pe_opt = currentExpiryOptions[currentOpenStrikes.pe + "PE"];
    let pe_ltp = ticksCache[pe_opt.instrument_token].last_price;
    let pe_avg = ticksCache[pe_opt.instrument_token].average_price;

    if (pe_ltp > pe_avg) {
      PaperTrade.trackOrder(pe_opt, "BUY", strategyTag);
      currentOpenStrikes.pe = false;
      return;
    }
  }
}

new CronJob('45 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
