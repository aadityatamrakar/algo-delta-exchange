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
let strategyTag = 'Eagle_SH';
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

function getHedgeOptions() {
  let ce_strike, pe_strike;
  let hedge_price = 15;
  if (moment().day() == 3) hedge_price = 10;
  else if (moment().day() == 4) hedge_price = 5;
  let optionsStrikes = Object.values(currentExpiryOptions).map(c => {
    c.distance = Math.abs(ticksCache[c.instrument_token].last_price - hedge_price);
    return c;
  }).sort((a, b) => {
    return (a.distance - b.distance);
  });

  for (i = 0; i < optionsStrikes.length; i++) {
    if (!ce_strike && optionsStrikes[i].instrument_type == 'CE') ce_strike = optionsStrikes[i].strike;
    if (!pe_strike && optionsStrikes[i].instrument_type == 'PE') pe_strike = optionsStrikes[i].strike;

    if (ce_strike && pe_strike) break;
  }
  let ce_option = currentExpiryOptions[ce_strike + 'CE'];
  let pe_option = currentExpiryOptions[pe_strike + 'PE'];
  return {
    ce_option,
    pe_option
  };
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

  let hedge = getHedgeOptions();
  if (type == 'pair') {
    PaperTrade.trackOrder(hedge.ce_option, "BUY", strategyTag);
    PaperTrade.trackOrder(hedge.pe_option, "BUY", strategyTag);

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
    PaperTrade.trackOrder(hedge.ce_option, "BUY", strategyTag);
    ce_option = currentExpiryOptions[(Math.ceil(bn_quote.last_price / 100) * 100) + 'CE'];
    ce_ltp = ticksCache[ce_option.instrument_token].last_price;
    PaperTrade.trackOrder(ce_option, "SELL", strategyTag);

    optionOrders.push({
      trg: parseInt(bn_ltp - ce_ltp),
      action: 'add_ce'
    });
    optionOrders.push({
      trg: parseInt(bn_ltp + ce_ltp),
      action: 'add_pe'
    });
  } else if (type == 'add_pe') {
    PaperTrade.trackOrder(hedge.pe_option, "BUY", strategyTag);
    pe_option = currentExpiryOptions[(Math.floor(bn_quote.last_price / 100) * 100) + 'PE'];
    pe_ltp = ticksCache[pe_option.instrument_token].last_price;
    PaperTrade.trackOrder(pe_option, "SELL", strategyTag);

    optionOrders.push({
      trg: parseInt(bn_ltp + pe_ltp),
      action: 'add_pe'
    });
    optionOrders.push({
      trg: parseInt(bn_ltp - pe_ltp),
      action: 'add_ce'
    });
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


// runStrategy();
new CronJob('45 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
