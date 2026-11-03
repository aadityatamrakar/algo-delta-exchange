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
let strategyTag = 'mStrangle';

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
  ce_strike = false,
  pe_strike = false;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(function () {
      takeTrade();
    }, 5000);
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

  checkReEntryQ.push({
    check: 1
  });

  checkSLQ.push({
    check: 1
  });
}

let sl_percent = 1.15,
  tradeStartPrice,
  lastPrice, position_open = {
    CE: false,
    PE: false
  },
  checkFlag = false;
async function takeTrade(type = 'both') {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    tradeStartPrice = bn_quote.last_price;
    lastPrice = bn_quote.last_price;
    let optionsStrikes = Object.values(currentExpiryOptions).map(c => {
      if (ticksCache[c.instrument_token] && ticksCache[c.instrument_token].last_price) {
        c.distance = Math.abs(ticksCache[c.instrument_token].last_price - 250);
      } else c.distance = 250;
      return c;
    }).sort((a, b) => {
      return (a.distance - b.distance);
    });

    ce_strike = false, pe_strike = false;
    for (i = 0; i < optionsStrikes.length; i++) {
      if (!ce_strike && optionsStrikes[i].instrument_type == 'CE') ce_strike = optionsStrikes[i].strike;
      if (!pe_strike && optionsStrikes[i].instrument_type == 'PE') pe_strike = optionsStrikes[i].strike;

      if (ce_strike && pe_strike) break;
    }

    position_open = {
      CE: true,
      PE: true
    };
    sendOrder(ce_strike, 'CE');
    sendOrder(pe_strike, 'PE');
    checkFlag = true;
  }
}

let optionOrders = [];
async function sendOrder(new_ATM_Strike, typeBuy) {
  // console.log(new_ATM_Strike + typeBuy);
  let tradeStrike = parseInt(new_ATM_Strike);

  let ce_option = currentExpiryOptions[tradeStrike + typeBuy];
  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  optionOrders.push({
    atm: new_ATM_Strike,
    strike: tradeStrike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    entry: ce_ltp,
    sl_trigger: Math.round(ce_ltp * sl_percent),
    sl_hit: false
  });
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    // console.log(current_price, sl_price, ce_position.entry, ce_position.high);
    if (ticksCache[check_option.instrument_token].last_price > ce_position.sl_trigger) {
      delete optionOrders[idx];
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[check_option.strike + check_option.type], 'BUY');
      position_open[check_option.type] = false;
      return false;
    } else return true;
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

async function checkReEntry() {
  let futurePrice = ticksCache[futureToken].last_price;
  if (tradeStartPrice >= futurePrice && tradeStartPrice <= lastPrice) {
    if (!position_open.CE) {
      position_open.CE = true;
      sendOrder(ce_strike, 'CE');
    }
    if (!position_open.PE) {
      position_open.PE = true;
      sendOrder(pe_strike, 'PE');
    }
  } else if (tradeStartPrice <= futurePrice && tradeStartPrice >= lastPrice) {
    if (!position_open.CE) {
      position_open.CE = true;
      sendOrder(ce_strike, 'CE');
    }
    if (!position_open.PE) {
      position_open.PE = true;
      sendOrder(pe_strike, 'PE');
    }
  }
  lastPrice = futurePrice;
}

var checkReEntryQ = async.queue(function (task, callback) {
  if (checkFlag) {
    checkReEntry().then(function (res) {
      callback();
    });
  } else callback();
}, 1);


runStrategy();
// new CronJob('50 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
