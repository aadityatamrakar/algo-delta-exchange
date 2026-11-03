const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const otmSelector = require('../lib/otmSelector');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Cheetah_NF1_15',
  trail_sl = 15;

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
  futureInstrument, farOtm;
async function runStrategy() {
  try {
    let optionData = await optionConfig('NIFTY');
    // futureToken = moment().day() == 4 || moment().day() == 3 ? 260105 : optionData.currentFuture.token;
    futureToken = optionData.currentFuture.token;
    futureInstrument = {
      "instrument_token": optionData.currentFuture.token,
      "lot_size": 50,
      "tradingsymbol": optionData.currentFuture.symbol
    };

    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = otmSelector('Cheetah') / 2;
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(placeTrade, 10000);
    // new CronJob('0 17 9 * * 1-5', placeTrade, null, true, 'Asia/Kolkata');
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

  checkSLQ.push({
    check: 1
  });
}

let tradeStart = true;
async function placeTrade() {
  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = ticksCache[futureToken];
      let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

      if (tradeStart) {
        tradeStart = false;
        let typeBuy = bn_quote.last_price > bn_quote.ohlc.open ? 'CE' : 'PE';
        sendOrder(new_ATM_Strike, typeBuy);
      }
    } catch (err) {
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

let quantity = 1;
async function sendOrder(new_ATM_Strike, typeBuy) {
  // console.log(new_ATM_Strike + typeBuy);

  let tradeType;
  if (typeBuy == 'CE') tradeType = "BUY";
  else if (typeBuy == 'PE') tradeType = "SELL";

  let ce_option = futureInstrument;
  let ce_ltp = ticksCache[futureInstrument.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, tradeType, quantity);
  optionOrders.push({
    atm: new_ATM_Strike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    entry: ce_ltp,
    sl_trigger: tradeType == 'BUY' ? ce_ltp - trail_sl : ce_ltp + trail_sl,
    sl_hit: false,
    exitType: tradeType == 'BUY' ? 'SELL' : 'BUY',
    quantity: quantity++
  });
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;

    let sl_hit = false;
    if (ce_position.exitType == 'BUY') {
      if (ticksCache[check_option.instrument_token].last_price > ce_position.sl_trigger) sl_hit = true;
    } else if (ce_position.exitType == 'SELL') {
      if (ticksCache[check_option.instrument_token].last_price < ce_position.sl_trigger) sl_hit = true;
    }
    if (sl_hit) {
      delete optionOrders[idx];
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, futureInstrument, check_option.exitType, check_option.quantity);

      let bn_quote = ticksCache[futureToken];
      let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
      let typeBuy = check_option.type == 'PE' ? 'CE' : 'PE';
      sendOrder(new_ATM_Strike, typeBuy);

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
new CronJob('50 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
