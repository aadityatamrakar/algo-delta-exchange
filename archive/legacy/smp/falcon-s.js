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
let strategyTag = 'Falcon_S';
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

let futureToken, farOtm = 0,
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

    setTimeout(_ => {
      lastQuote = ticksCache[futureToken].last_price;
      start_trade = true;
    }, 10000);
  } catch (err) {
    console.log(err);
  }
}

let ticksCache = {}, lastQuote = 0, start_trade = false;
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  if (start_trade) {
    takePositionQ.push({
      check: 1
    });
  }
}

async function takeTrade() {
  let bn_quote = ticksCache[futureToken].last_price;

  let new_ATM_Strike = (Math.round(bn_quote / 100) * 100);
  let mid_ATM_Strike = (Math.round(bn_quote / 50) * 50);

  let isCrossover_round = false;
  if (new_ATM_Strike && bn_quote >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    isCrossover_round = true;
  } else if (new_ATM_Strike && bn_quote <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    isCrossover_round = true;
  }

  let isCrossover_mid = false;
  if (mid_ATM_Strike && bn_quote >= mid_ATM_Strike && lastQuote <= mid_ATM_Strike) {
    isCrossover_mid = true;
  } else if (mid_ATM_Strike && bn_quote <= mid_ATM_Strike && lastQuote >= mid_ATM_Strike) {
    isCrossover_mid = true;
  }
  lastQuote = bn_quote;

  if (isCrossover_round || isCrossover_mid) {
    sendOrder(isCrossover_round, isCrossover_mid, new_ATM_Strike, mid_ATM_Strike);
  }
}
var takePositionQ = async.queue(function (task, callback) {
  takeTrade().then(function (res) {
    callback();
  });
}, 1);

let optionOrders = {
  first: false,
  second: false
};
let firstOrder = true;
async function sendOrder(trg_round, trg_mid, atm_round, atm_mid) {
  atm = trg_round ? atm_round : trg_mid ? atm_mid + 50 : false;

  let ce_option, pe_option;
  if (atm) {
    ce_option = currentExpiryOptions[atm + 'CE'];
    pe_option = currentExpiryOptions[atm + 'PE'];
  }

  if (!atm) return;
  else if (firstOrder) {
    firstOrder = false;
    optionOrders.first = {
      atm: atm,
      ce: ce_option,
      pe: pe_option
    };
    PaperTrade.trackOrder(ce_option, "SELL", strategyTag, 4);
    PaperTrade.trackOrder(pe_option, "SELL", strategyTag, 4);
  } else if (optionOrders.first && !optionOrders.second && optionOrders.first.atm !== atm) {
    PaperTrade.trackOrder(optionOrders.first.ce, "BUY", strategyTag, 2);
    PaperTrade.trackOrder(optionOrders.first.pe, "BUY", strategyTag, 2);
    optionOrders.second = {
      atm: atm,
      ce: ce_option,
      pe: pe_option
    };
    PaperTrade.trackOrder(ce_option, "SELL", strategyTag, 2);
    PaperTrade.trackOrder(pe_option, "SELL", strategyTag, 2);
  } else if (optionOrders.first && optionOrders.second && optionOrders.first.atm !== atm && optionOrders.second.atm !== atm) {
    let target;
    if (Math.abs(optionOrders.first.atm - atm) > Math.abs(optionOrders.second.atm - atm)) {
      PaperTrade.trackOrder(optionOrders.first.ce, "BUY", strategyTag, 2);
      PaperTrade.trackOrder(optionOrders.first.pe, "BUY", strategyTag, 2);
      target = 'first';
    } else {
      PaperTrade.trackOrder(optionOrders.second.ce, "BUY", strategyTag, 2);
      PaperTrade.trackOrder(optionOrders.second.pe, "BUY", strategyTag, 2);
      target = 'second';
    }
    optionOrders[target] = {
      atm: atm,
      ce: ce_option,
      pe: pe_option
    };
    PaperTrade.trackOrder(ce_option, "SELL", strategyTag, 2);
    PaperTrade.trackOrder(pe_option, "SELL", strategyTag, 2);
  }
}

// runStrategy();
new CronJob('45 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
