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
let strategyTag = 'STGL-120';

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
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);
    
    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    setTimeout(function () {
      takeTrade();
    }, 10000);
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

let sl_points = 30,
  tradeCount = 1;
async function takeTrade() {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {

    let selectByPrice = 40;

    let optionsStrikes = Object.values(currentExpiryOptions).map(c => {
      if (ticksCache[c.instrument_token] && ticksCache[c.instrument_token].last_price) {
        c.distance = Math.abs(ticksCache[c.instrument_token].last_price - selectByPrice);
      } else c.distance = selectByPrice;
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

    sendOrder(ce_strike, pe_strike);
  }
}

let optionOrders = [];
async function sendOrder(ce_s, pe_s) {
  // console.log(new_ATM_Strike + typeBuy);
  let ce_option = currentExpiryOptions[ce_s + 'CE'];
  let pe_option = currentExpiryOptions[pe_s + 'PE'];

  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;

  let total_price = ce_ltp + pe_ltp;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL');

  optionOrders.push({
    ce_strike: ce_s,
    pe_strike: pe_s,
    ce_token: ce_option.instrument_token,
    pe_token: pe_option.instrument_token,
    sl_trigger: total_price + sl_points
  });
}

async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    let ce_ltp = ticksCache[position.ce_token].last_price;
    let pe_ltp = ticksCache[position.pe_token].last_price;
    let total = ce_ltp + pe_ltp;

    if (total > position.sl_trigger) {
      delete optionOrders[idx];
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
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
new CronJob('40 29 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
