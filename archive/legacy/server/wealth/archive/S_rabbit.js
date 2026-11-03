const CronJob = require("cron").CronJob;
const notify = require("../../lib/notify.js");
const app = require('../../server.js');
const zerodha = require('../../lib/zerodha.js');
const kiteTicker = require('../../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../../tools/optionInstruments');
const async = require('async');

// Strategy Config
let channelId = 0;
let strategyTag = 'Rabbit_S';

let zapi;
let public_token;
async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  account.lastLogin = (new Date()).toISOString().substr(0, 10);
  account.config = await zapi_n.getConfig();
  public_token = zapi_n.getPublicToken();
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
  fromDate, toDate;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    new CronJob('58 15 9 * * 1-5', function () {
      lastQuote = ticksCache[futureToken].last_price;
    }, null, true, 'Asia/Kolkata');

    new CronJob('0 16 9 * * 1-5', function () {
      tradeStart = true;
    }, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [],
  sl_percent = 0.2;

let ticksCache = {};
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

let tradeStart = false,
  lastQuote, positionsOpen = {};
let farOtm = 0;
async function placeTrade() {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
  let ce_option = currentExpiryOptions[(new_ATM_Strike + farOtm) + "CE"];
  let pe_option = currentExpiryOptions[(new_ATM_Strike - farOtm) + "PE"];

  let tradeType, takePosition = false;

  if (bn_quote.last_price >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    takePosition = true;
    tradeType = 'CE';
  } else if (bn_quote.last_price <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    takePosition = true;
    tradeType = 'PE';
  }
  lastQuote = bn_quote.last_price;

  if (takePosition && typeof positionsOpen["S" + new_ATM_Strike + tradeType] != 'number') {
    positionsOpen["S" + new_ATM_Strike + tradeType] = 1;
    sendOrder(new_ATM_Strike, tradeType);
    return true;
  } else return false;
}

async function sendOrder(new_ATM_Strike, typeBuy) {
  // console.log(new_ATM_Strike + typeBuy);
  let ce_option = currentExpiryOptions[new_ATM_Strike + typeBuy];
  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  optionOrders.push({
    strike: new_ATM_Strike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    entry: ce_ltp,
    low: ce_ltp,
    trail_sl: (ce_ltp * sl_percent),
    sl_hit: false
  });
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    let current_price = ticksCache[check_option.instrument_token].last_price;
    ce_position.low = ce_position.low > current_price ? current_price : ce_position.low;
    let sl_price = ce_position.entry + (ce_position.trail_sl - (ce_position.entry - ce_position.low));
    // console.log(check_option.strike + check_option.type, current_price, sl_price, ce_position.entry, ce_position.low);
    if (ticksCache[check_option.instrument_token].last_price > sl_price) {
      delete optionOrders[idx];
      delete positionsOpen["S" + check_option.strike + check_option.type];
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[check_option.strike + check_option.type], 'BUY');
      return false;
    } else return true;
  });
}

var takePositionQ = async.queue(function (task, callback) {
  if (tradeStart) {
    placeTrade().then(function (res) {
      callback();
    });
  } else callback();
}, 1);

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('0 15 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
