const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const otmSelector = require('../lib/otmSelector');
const async = require('async');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Eagle_P-1';
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

let futureToken, farOtm = 0,
  currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // farOtm = otmSelector();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(takeTrade, 15000);
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

  if (init_pending) {
    takePositionQ.push({
      check: 1
    });
  } else {
    checkSLQ.push({
      check: 1
    });
  }
}

async function takeTrade() {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

  let isCrossover = false;
  if (new_ATM_Strike && bn_quote.last_price >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    isCrossover = true;
  } else if (new_ATM_Strike && bn_quote.last_price <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    isCrossover = true;
  }
  lastQuote = bn_quote.last_price;

  if (isCrossover) {
    init_pending = false;
    sendOrder('pair');
  }
}
var takePositionQ = async.queue(function (task, callback) {
  takeTrade().then(function (res) {
    callback();
  });
}, 1);

let optionOrders = [];
async function sendOrder(type = 'pair') {
  let bn_quote = ticksCache[futureToken];
  let atm = Math.round(bn_quote.last_price / 100) * 100;
  let ce_s = atm + farOtm;
  let pe_s = atm - farOtm;

  let ce_option = currentExpiryOptions[ce_s + 'CE'];
  let pe_option = currentExpiryOptions[pe_s + 'PE'];

  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
  let bn_ltp = ticksCache[futureToken].last_price;

  if (type == 'pair') {
    PaperTrade.trackOrder(ce_option, "SELL", strategyTag);
    PaperTrade.trackOrder(pe_option, "SELL", strategyTag);

    optionOrders.push({
      trg: parseInt(bn_ltp - ce_ltp),
      action: 'add_ce'
    });
    optionOrders.push({
      trg: parseInt(bn_ltp + pe_ltp),
      action: 'add_pe'
    });
  } else if (type == 'add_ce') {
    ce_option = currentExpiryOptions[(Math.ceil(bn_quote.last_price / 100) * 100) + 'CE'];
    pe_option = currentExpiryOptions[(Math.floor(bn_quote.last_price / 100) * 100) + 'PE'];
    ce_ltp = ticksCache[ce_option.instrument_token].last_price;
    if (ce_ltp > 20) {
      PaperTrade.trackOrder(ce_option, "SELL", strategyTag);
      PaperTrade.trackOrder(pe_option, "SELL", strategyTag);

      optionOrders.push({
        trg: parseInt(bn_ltp - ce_ltp),
        action: 'add_ce'
      });
      optionOrders.push({
        trg: parseInt(bn_ltp + ce_ltp),
        action: 'add_pe'
      });
    }
  } else if (type == 'add_pe') {
    ce_option = currentExpiryOptions[(Math.ceil(bn_quote.last_price / 100) * 100) + 'CE'];
    pe_option = currentExpiryOptions[(Math.floor(bn_quote.last_price / 100) * 100) + 'PE'];
    pe_ltp = ticksCache[pe_option.instrument_token].last_price;
    if (pe_ltp > 20) {
      PaperTrade.trackOrder(pe_option, "SELL", strategyTag);
      PaperTrade.trackOrder(ce_option, "SELL", strategyTag);

      optionOrders.push({
        trg: parseInt(bn_ltp + pe_ltp),
        action: 'add_pe'
      });
      optionOrders.push({
        trg: parseInt(bn_ltp - pe_ltp),
        action: 'add_ce'
      });
    }
  }

  console.log(optionOrders);
}

let lastQuote = 0;
async function checkSL() {
  let bn_quote = ticksCache[futureToken];
  optionOrders.forEach(async (order, idx) => {
    if (order) {
      if (order.trg >= lastQuote && order.trg <= bn_quote.last_price || order.trg <= lastQuote && order.trg >= bn_quote.last_price) {
        sendOrder(order.action);
        delete optionOrders[idx];
      }
    }
  });
  lastQuote = bn_quote.last_price;
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);


runStrategy();
