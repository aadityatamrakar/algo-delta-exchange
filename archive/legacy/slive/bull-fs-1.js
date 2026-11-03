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
let strategyTag = 'Bull_FS-1';
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
    let optionData = await optionConfig('FINNIFTY');
    futureToken = 257801;
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


  takePositionQ.push({
    check: 1
  });

  checkSLQ.push({
    check: 1
  });
}

async function takeTrade() {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 50) * 50);

  let isCrossover = false;
  if (new_ATM_Strike && bn_quote.last_price >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    isCrossover = true;
  } else if (new_ATM_Strike && bn_quote.last_price <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    isCrossover = true;
  }
  lastQuote = bn_quote.last_price;

  if (isCrossover) {
    // init_pending = false;
    sendOrder('pair');
  }
}
var takePositionQ = async.queue(function (task, callback) {
  takeTrade().then(function (res) {
    callback();
  });
}, 1);

let optionOrders = [],
  currentSize = 1,
  currentOpenStrikes = {};
async function sendOrder() {
  let bn_quote = ticksCache[futureToken];
  let atm = Math.round(bn_quote.last_price / 50) * 50;
  let ce_s = atm + farOtm;
  let pe_s = atm - farOtm;

  let ce_option = currentExpiryOptions[ce_s + 'CE'];
  let pe_option = currentExpiryOptions[pe_s + 'PE'];

  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
  let bn_ltp = ticksCache[futureToken].last_price;

  if (!currentOpenStrikes[atm]) {
    PaperTrade.trackOrder(ce_option, "SELL", strategyTag, currentSize);
    PaperTrade.trackOrder(pe_option, "SELL", strategyTag, currentSize);

    let sl_trg = (ce_ltp + pe_ltp) * 1.25;
    optionOrders.push({
      atm: atm,
      trg: parseInt(sl_trg),
      ce_option: ce_option,
      pe_option: pe_option,
      lotSize: currentSize
    });

    currentOpenStrikes[atm] = true;
    currentSize += 1;
    console.log(optionOrders);
  }
}

let lastQuote = 0;
async function checkSL() {
  let bn_quote = ticksCache[futureToken];
  optionOrders.forEach(async (order, idx) => {
    if (order) {
      let ce_ltp = ticksCache[order.ce_option.instrument_token].last_price;
      let pe_ltp = ticksCache[order.pe_option.instrument_token].last_price;
      let ltp = ce_ltp + pe_ltp;

      if (order.trg <= ltp) {
        PaperTrade.trackOrder(order.pe_option, "BUY", strategyTag, order.lotSize);
        PaperTrade.trackOrder(order.ce_option, "BUY", strategyTag, order.lotSize);
        currentOpenStrikes[order.atm] = false;

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