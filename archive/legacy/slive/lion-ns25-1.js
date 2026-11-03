const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments.js');
const async = require('async');
const otmSelector = require('../lib/otmSelector.js');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Lion_NS25_1';

async function executeSL(orderId, token, price) {
  try {
    let trade = await PaperTrade.findOne({
      where: {
        tag: strategyTag,
        dataObj: [orderId],
        instrument_token: token
      }
    });
    console.log(trade);
    if (trade) {
      trade.status = 'COMPLETE';
      trade.order_type = 'MARKET';
      trade.order_timestamp = new Date(moment().toDate());
      trade.average_price = parseFloat(price);
      await trade.save();
    }
  } catch (err) {
    console.log(err);
  }
}

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
    let optionData = await optionConfig("NIFTY");
    futureToken = 256265;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = 0; // otmSelector();
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

  if (startTrade) {
    takePositionQ.push({
      check: 1
    });
  }
  checkSLQ.push({
    check: 1
  });
}

let farOtm = 400,
  lastQuote;
async function placeTrade(forceTrade = false) {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 50) * 50);
  let isCrossover = forceTrade;
  if (bn_quote.last_price >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    isCrossover = true;
  } else if (bn_quote.last_price <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    isCrossover = true;
  }
  lastQuote = bn_quote.last_price;

  if (isCrossover) {
    let ce_option = currentExpiryOptions[(new_ATM_Strike + farOtm) + "CE"];
    let pe_option = currentExpiryOptions[(new_ATM_Strike - farOtm) + "PE"];

    let takePosition = false;

    if (positionsOpen["S" + new_ATM_Strike]) {
      // let totalOpen = positionsOpen["S" + new_ATM_Strike].CE + positionsOpen["S" + new_ATM_Strike].PE;
      // console.log(positionsOpen["S" + new_ATM_Strike].CE, positionsOpen["S" + new_ATM_Strike].PE);
      if (positionsOpen["S" + new_ATM_Strike].CE == 0) takePosition = true;
      if (positionsOpen["S" + new_ATM_Strike].PE == 0) takePosition = true;
    } else takePosition = true;

    if (takePosition) {
      // console.log(new_ATM_Strike);
      ATM_Strike.push("S" + new_ATM_Strike);

      let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL', 1);
      let ce_sl_trigger = parseInt(ce_ltp * sl_percent);
      let ce_sl_id = moment().format('hhmmss');
      optionOrders.push({
        atm: new_ATM_Strike,
        strike: ce_option.strike,
        type: "CE",
        instrument_token: ce_option.instrument_token,
        sl_trigger: ce_sl_trigger,
        sl_hit: false,
        sl_id: ce_sl_id
      });
      PaperTrade.trackOrder_slm(currentExpiryOptions[ce_option.strike + "CE"], 'BUY', strategyTag, 1, ce_sl_trigger, [ce_sl_id]);

      let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL', 1);
      let pe_sl_id = moment().format('hhmmss');
      let pe_sl_trigger = parseInt(pe_ltp * sl_percent);
      optionOrders.push({
        atm: new_ATM_Strike,
        strike: pe_option.strike,
        type: "PE",
        instrument_token: pe_option.instrument_token,
        sl_trigger: pe_sl_trigger,
        sl_hit: false,
        sl_id: pe_sl_id
      });
      PaperTrade.trackOrder_slm(currentExpiryOptions[pe_option.strike + "PE"], 'BUY', strategyTag, 1, pe_sl_trigger, [pe_sl_id]);

      if (positionsOpen["S" + new_ATM_Strike]) {
        positionsOpen["S" + new_ATM_Strike].CE += 1;
        positionsOpen["S" + new_ATM_Strike].PE += 1;
      } else {
        positionsOpen["S" + new_ATM_Strike] = {
          CE: 1,
          PE: 1
        };
      }
      return true;
    } else return false;
  }
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    if (ticksCache[check_option.instrument_token].last_price > check_option.sl_trigger) {
      delete optionOrders[idx];
      executeSL(check_option.sl_id, check_option.instrument_token, ticksCache[check_option.instrument_token].last_price);
      positionsOpen["S" + check_option.atm][check_option.type] -= 1;
      return false;
    } else return true;
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
