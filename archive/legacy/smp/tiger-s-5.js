const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const otmSelector = require('../lib/otmSelector');
const async = require('async');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Tiger_S_5';
let sl_percent = 1.05;

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

async function takeTrade() {
  let bn_quote = ticksCache[futureToken];
  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm = Math.round(bn_quote.last_price / 100) * 100;
    sendOrder(atm, atm);
  }
}

let optionOrders = [];
async function sendOrder(ce_s, pe_s) {
  ce_s = ce_s + farOtm;
  pe_s = pe_s - farOtm;

  let ce_option = currentExpiryOptions[ce_s + 'CE'];
  let pe_option = currentExpiryOptions[pe_s + 'PE'];

  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;

  let total_price = ce_ltp + pe_ltp;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL');

  let total_sl = total_price * sl_percent;
  optionOrders.push({
    ce_strike: ce_s,
    pe_strike: pe_s,
    ce_token: ce_option.instrument_token,
    pe_token: pe_option.instrument_token,
    ce_entry: ce_ltp,
    pe_entry: pe_ltp,
    total_entry: total_price,
    total_sl: total_sl,
    pe_sl: false,
    ce_sl: false,
  });
}

let moveLeg = 'big';
async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    let ce_ltp = ticksCache[position.ce_token].last_price;
    let pe_ltp = ticksCache[position.pe_token].last_price;
    let total = ce_ltp + pe_ltp;
    let bn_quote = ticksCache[futureToken];
    let atm = Math.round(bn_quote.last_price / 100) * 100;
    let ce_s = atm + farOtm
    let pe_s = atm - farOtm;

    if (position.total_sl != false && total > position.total_sl) {
      if (moveLeg == 'big') {
        if (ce_ltp > position.ce_entry && pe_ltp < position.pe_entry) {
          moveLeg = 'small';
          position.ce_token = currentExpiryOptions[ce_s + 'CE'].instrument_token;
          position.ce_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price + position.pe_entry;
          position.total_sl = position.total_entry * sl_percent;

          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[ce_s + 'CE'], 'SELL');

          position.ce_strike = ce_s;
          
        } else if (ce_ltp < position.ce_entry && pe_ltp > position.pe_entry) {
          moveLeg = 'small';
          position.pe_token = currentExpiryOptions[pe_s + 'PE'].instrument_token;
          position.pe_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price + position.ce_entry;
          position.total_sl = position.total_entry * sl_percent;
          
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[pe_s + 'PE'], 'SELL');
          
          position.pe_strike = pe_s;

        } else if (ce_ltp > pe_ltp) {
          moveLeg = 'small';
          position.ce_token = currentExpiryOptions[ce_s + 'CE'].instrument_token;
          position.ce_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price + position.pe_entry;
          position.total_sl = position.total_entry * sl_percent;

          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[ce_s + 'CE'], 'SELL');

          position.ce_strike = ce_s;

        } else if (pe_ltp > ce_ltp) {
          moveLeg = 'small';
          position.pe_token = currentExpiryOptions[pe_s + 'PE'].instrument_token;
          position.pe_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price + position.ce_entry;
          position.total_sl = position.total_entry * sl_percent;

          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[pe_s + 'PE'], 'SELL');

          position.pe_strike = pe_s;

        }
      } else {
        if (ce_ltp > position.ce_entry && pe_ltp < position.pe_entry) {
          moveLeg = 'big';
          position.pe_token = currentExpiryOptions[pe_s + 'PE'].instrument_token;
          position.pe_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price + position.ce_entry;
          position.total_sl = position.total_entry * sl_percent;

          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[pe_s + 'PE'], 'SELL');
          
          position.pe_strike = pe_s;

        } else if (ce_ltp < position.ce_entry && pe_ltp > position.pe_entry) {
          moveLeg = 'big';
          position.ce_token = currentExpiryOptions[ce_s + 'CE'].instrument_token;
          position.ce_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price + position.pe_entry;
          position.total_sl = position.total_entry * sl_percent;

          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[ce_s + 'CE'], 'SELL');
          
          position.ce_strike = ce_s;

        } else if (ce_ltp < pe_ltp) {
          moveLeg = 'big';
          position.ce_token = currentExpiryOptions[ce_s + 'CE'].instrument_token;
          position.ce_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[ce_s + 'CE'].instrument_token].last_price + position.pe_entry;
          position.total_sl = position.total_entry * sl_percent;

          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.ce_strike + 'CE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[ce_s + 'CE'], 'SELL');
          
          position.ce_strike = ce_s;
          
        } else if (pe_ltp < ce_ltp) {
          moveLeg = 'big';
          position.pe_token = currentExpiryOptions[pe_s + 'PE'].instrument_token;
          position.pe_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price;
          position.total_entry = ticksCache[currentExpiryOptions[pe_s + 'PE'].instrument_token].last_price + position.ce_entry;
          position.total_sl = position.total_entry * sl_percent;

          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[position.pe_strike + 'PE'], 'BUY');
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[pe_s + 'PE'], 'SELL');
          
          position.pe_strike = pe_s;

        }
      }
    }
  });
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
