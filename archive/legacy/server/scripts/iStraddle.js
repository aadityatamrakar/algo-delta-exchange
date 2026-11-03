const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'iStraddle';

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

let futureToken, currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    // futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    // setTimeout(takeTrade, 5000);
    new CronJob('0 17 9 * * 1-4', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 30 9 * * 5', takeTrade, null, true, 'Asia/Kolkata');

  } catch (err) {
    console.log(err);
  }
}

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

let sl_percent = 1.05,
  tradeCount = 2;

async function takeTrade() {
  let bn_quote = ticksCache[futureToken];
  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm = Math.round(bn_quote.last_price / 100) * 100;
    if (tradeCount > 0) {
      tradeCount -= 1;
      sendOrder(atm, atm);
    }
  }
}

let optionOrders = [];
async function sendOrder(ce_s, pe_s) {
  // console.log(new_ATM_Strike + typeBuy);
  let ce_option, pe_option;

  // if (moment().day() == 3 || moment().day() == 4) {
  //   ce_s += 100;
  //   pe_s -= 100;
  // }

  ce_option = currentExpiryOptions[(ce_s - 100) + 'CE'];
  pe_option = currentExpiryOptions[(pe_s + 100) + 'PE'];

  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;

  let total_price = ce_ltp + pe_ltp;
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL');

  let total_sl = false,
    pe_sl = false,
    ce_sl = false;

  if (moment().day() == 2 || moment().day() == 3 || moment().day() == 4) {
    total_sl = total_price * sl_percent;
    pe_sl = false;
    ce_sl = false;
  } else if (moment().day() == 1) {
    total_sl = false;
    pe_sl = pe_ltp * 1.25;
    ce_sl = ce_ltp * 1.25;
  } else if (moment().day() == 5) {
    total_sl = false;
    pe_sl = pe_ltp * 1.2;
    ce_sl = ce_ltp * 1.2;
  }

  optionOrders.push({
    ce_strike: ce_s,
    pe_strike: pe_s,
    ce_token: ce_option.instrument_token,
    pe_token: pe_option.instrument_token,
    ce_entry: ce_ltp,
    pe_entry: pe_ltp,
    total_entry: total_price,
    total_sl: total_sl,
    pe_sl: pe_sl,
    ce_sl: ce_sl,
  });
  console.log(optionOrders);
}

async function supertrend_trail() {
  optionOrders.forEach(async (position, idx) => {
    let ce_ltp = ticksCache[position.ce_token].last_price;
    let pe_ltp = ticksCache[position.pe_token].last_price;
    let total = ce_ltp + pe_ltp;

    if (position.total_sl != false && total > position.total_sl) {
      if (ce_ltp > position.ce_entry && pe_ltp < position.pe_entry) {
        position.total_sl = false;
        position.pe_sl = position.pe_entry;
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
        console.log('Combine SL', optionOrders);
      } else if (ce_ltp < position.ce_entry && pe_ltp > position.pe_entry) {
        position.total_sl = false;
        position.ce_sl = position.pe_entry;
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
        console.log('Combine SL', optionOrders);
      }
    }

    if (position.total_sl == false && position.pe_sl != false && position.pe_sl < pe_ltp) {
      position.pe_sl = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
      if (position.ce_sl) position.ce_sl = position.ce_entry;
      else takeTrade();
      console.log('PE SL', optionOrders);
    }

    if (position.total_sl == false && position.ce_sl != false && position.ce_sl < ce_ltp) {
      position.ce_sl = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
      if (position.pe_sl) position.pe_sl = position.pe_entry;
      else takeTrade();
      console.log('CE SL', optionOrders);
    }
  });
}

async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    let ce_ltp = ticksCache[position.ce_token].last_price;
    let pe_ltp = ticksCache[position.pe_token].last_price;
    let total = ce_ltp + pe_ltp;

    if (position.total_sl != false && total > position.total_sl) {
      if (ce_ltp > position.ce_entry && pe_ltp < position.pe_entry) {
        position.total_sl = false;
        position.pe_sl = position.pe_entry;
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
        console.log('Combine SL', optionOrders);
      } else if (ce_ltp < position.ce_entry && pe_ltp > position.pe_entry) {
        position.total_sl = false;
        position.ce_sl = position.pe_entry;
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
        console.log('Combine SL', optionOrders);
      }
    }

    if (position.total_sl == false && position.pe_sl != false && position.pe_sl < pe_ltp) {
      position.pe_sl = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
      if (position.ce_sl) position.ce_sl = position.ce_entry;
      else takeTrade();
      console.log('PE SL', optionOrders);
    }

    if (position.total_sl == false && position.ce_sl != false && position.ce_sl < ce_ltp) {
      position.ce_sl = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
      if (position.pe_sl) position.pe_sl = position.pe_entry;
      else takeTrade();
      console.log('CE SL', optionOrders);
    }
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);


// runStrategy();
new CronJob('50 15 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
