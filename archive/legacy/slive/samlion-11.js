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
let strategyTag = 'SamLion_11';

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
  fromDate, toDate;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = 0;
    // await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(function () {
      lastQuote = ticksCache[futureToken].last_price;
      setTimeout(function () {
        startTrade = true;
        placeTrade(true);
      }, 5000);
    }, 5000);
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [],
  ATM_Strike = [],
  positionsOpen = [],
  sl_percent = 1.25;

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

let farOtm = 400,
  lastQuote;
async function placeTrade(forceTrade = false) {
  let bn_quote = ticksCache[futureToken];
  let atm = (Math.round(bn_quote.last_price / 100) * 100);

  for (let i = 0; i < 10; i++) {
    let upper_strike = atm + (i * 100);
    let lower_strike = atm - (i * 100);
    sendSeriesOrder(upper_strike, lower_strike);
  }
}

async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    let total_prem = ticksCache[position.ce_token].last_price + ticksCache[position.pe_token].last_price;
    if (total_prem > position.sl_trigger) {
      delete optionOrders[idx];

      let ce_price = ticksCache[position.ce_token].last_price;
      let pe_price = ticksCache[position.pe_token].last_price;

      if (ce_price > position.ce_entry) {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.ce_option, "BUY", 1);
      } else if (pe_price > position.pe_entry) {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.pe_option, "BUY", 1);
      }
      return false;
    } else return true;
  });
}

function sendSeriesOrder(strike_ce, strike_pe) {
  let ce_option = currentExpiryOptions[strike_ce + "CE"];
  let pe_option = currentExpiryOptions[strike_pe + "PE"];

  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL', 1);
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL', 1);
  optionOrders.push({
    ce_strike: ce_option.strike + "CE",
    pe_strike: pe_option.strike + "PE",
    ce_token: ce_option.instrument_token,
    pe_token: pe_option.instrument_token,
    ce_entry: ce_ltp,
    pe_entry: pe_ltp,
    sl_trigger: (ce_ltp + pe_ltp) * sl_percent,
    sl_hit: false
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

runStrategy();
