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
const pause = async (ms) => (new Promise((r, c) => setTimeout(r, ms)));

// Strategy Config
let channelId = 0;
let strategyTag = 'Bull-10';
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
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // farOtm = otmSelector();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(() => { takeTrade(true); }, 15000);
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

  checkSLQ.push({
    check: 1
  });
}

async function takeTrade(forceTrade = false) {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

  let isCrossover = forceTrade ? forceTrade : false;
  if (new_ATM_Strike && bn_quote.last_price >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    isCrossover = true;
  } else if (new_ATM_Strike && bn_quote.last_price <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    isCrossover = true;
  }
  lastQuote = bn_quote.last_price;

  if (isCrossover) {
    init_pending = false;
    sendOrder('SELL');
  }
}
var takePositionQ = async.queue(function (task, callback) {
  takeTrade().then(function (res) {
    callback();
  });
}, 1);

let optionOrders = [];
let strategyQty = 1;
async function sendOrder(transType = 'SELL', atm = false, startQty = 1, optionType = 'both') {
  let bn_quote = ticksCache[futureToken];
  if (atm == false) atm = Math.round(bn_quote.last_price / 100) * 100;
  let strikes = [
    { strike: (atm + 100) + "CE", qty: startQty },
    { strike: (atm + 200) + "CE", qty: startQty + 1 },
    { strike: (atm + 300) + "CE", qty: startQty + 2 },
    { strike: (atm - 100) + "PE", qty: startQty },
    { strike: (atm - 200) + "PE", qty: startQty + 1 },
    { strike: (atm - 300) + "PE", qty: startQty + 2 },
  ];

  for (let i = 0; i < strikes.length; i++) {
    let strike_order = strikes[i];
    if (optionType == 'both') {
      PaperTrade.trackOrder(currentExpiryOptions[strike_order.strike], transType, strategyTag, strike_order.qty);
    } else if (optionType == 'CE' && strike_order.strike.includes('CE')) {
      PaperTrade.trackOrder(currentExpiryOptions[strike_order.strike], transType, strategyTag, strike_order.qty);
    } else if (optionType == 'PE' && strike_order.strike.includes('PE')) {
      PaperTrade.trackOrder(currentExpiryOptions[strike_order.strike], transType, strategyTag, strike_order.qty);
    }
  }

  if (transType == 'SELL') {
    optionOrders[atm] = {
      atm: atm,
      trg_ce: (atm + 100),
      trg_pe: (atm - 100),
      strategyQty: parseInt(strategyQty),
    };

    console.log('new order', optionOrders[atm]);
    strategyQty += 1;
  }
  // console.log(optionOrders);
}

let lastQuote = 0;
async function checkSL() {
  let bn_quote = ticksCache[futureToken];
  for (const sl_order_key of Object.keys(optionOrders)) {
    if (optionOrders[sl_order_key]) {
      if (optionOrders[sl_order_key].trg_ce && optionOrders[sl_order_key].trg_ce <= bn_quote.last_price) {
        optionOrders[sl_order_key].trg_ce = false;
        console.log('CE SL Triggered', optionOrders[sl_order_key]);
        pause(500);
        sendOrder('BUY', optionOrders[sl_order_key].atm, optionOrders[sl_order_key].strategyQty, 'CE');
        pause(500);
        let atm = Math.round(bn_quote.last_price / 100) * 100;
        if (optionOrders[atm] && typeof optionOrders[atm].trg_ce != "undefined" && typeof optionOrders[atm].trg_pe != "undefined" && (optionOrders[atm].trg_ce || optionOrders[atm].trg_pe)) {
          // no trade
        } else sendOrder('SELL', atm, strategyQty, 'both');
      }
      if (optionOrders[sl_order_key].trg_pe && optionOrders[sl_order_key].trg_pe >= bn_quote.last_price) {
        optionOrders[sl_order_key].trg_pe = false;
        console.log('PE SL Triggered', optionOrders[sl_order_key]);
        pause(500);
        sendOrder('BUY', optionOrders[sl_order_key].atm, optionOrders[sl_order_key].strategyQty, 'PE');
        pause(500);
        let atm = Math.round(bn_quote.last_price / 100) * 100;
        if (optionOrders[atm] && typeof optionOrders[atm].trg_ce != "undefined" && typeof optionOrders[atm].trg_pe != "undefined" && (optionOrders[atm].trg_ce || optionOrders[atm].trg_pe)) {
          // no trade
        } else sendOrder('SELL', atm, strategyQty, 'both');
      }
    }
  }
  lastQuote = bn_quote.last_price;
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);


// runStrategy();
new CronJob('45 24 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
