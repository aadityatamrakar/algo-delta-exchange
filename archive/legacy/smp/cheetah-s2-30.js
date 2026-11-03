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
let strategyTag = 'Cheetah_S2_30',
  trail_sl = 30;

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
  fromDate, toDate, farOtm;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = otmSelector('Cheetah');
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    new CronJob('0 17 9 * * 1-5', placeTrade, null, true, 'Asia/Kolkata');
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
        let typeBuy = bn_quote.last_price > bn_quote.ohlc.open ? 'PE' : 'CE';
        sendOrder(new_ATM_Strike, typeBuy);
      }
    } catch (err) {
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

async function sendOrder(new_ATM_Strike, typeBuy) {
  
  let tradeStrike, ce_strike, pe_strike;
  let optionsStrikes = Object.values(currentExpiryOptions).map(c => {
    c.distance = Math.abs(ticksCache[c.instrument_token].last_price - 200);
    return c;
  }).sort((a, b) => {
    return (a.distance - b.distance);
  });

  for (i = 0; i < optionsStrikes.length; i++) {
    if (!ce_strike && optionsStrikes[i].instrument_type == 'CE') ce_strike = optionsStrikes[i].strike;
    if (!pe_strike && optionsStrikes[i].instrument_type == 'PE') pe_strike = optionsStrikes[i].strike;

    if (ce_strike && pe_strike) break;
  }

  if (typeBuy == 'CE') tradeStrike = ce_strike;
  else if (typeBuy == 'PE') tradeStrike = pe_strike;

  let ce_option = currentExpiryOptions[tradeStrike + typeBuy];
  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  optionOrders.push({
    atm: new_ATM_Strike,
    strike: tradeStrike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    entry: ce_ltp,
    sl_trigger: ce_ltp + trail_sl,
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
new CronJob('0 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
