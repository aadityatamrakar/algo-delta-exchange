const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const otmSelector = require('../lib/otmSelector');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Fox-1';

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

let fetchingPosition = false;
async function fetchPositions() {
  if (!fetchingPosition) {
    fetchingPosition = true;
    PaperTrade.positions(function (err, resp) {
      fetchingPosition = false;
      positions = resp;
    });
  }
}

let accounts = [],
  running_accounts = [],
  account_quantities = {},
  firstRun = true;

let futureToken, currentExpiryOptions = {},
  fromDate, toDate, farOtm, startTrade = false;
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

    startTrade = true;
    setTimeout(placeTrade, 25000);
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [],
  trail_sl = 60;

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  // checkPNL();

  checkSLQ.push({
    check: 1
  });
}

const pair_price = (strike) => (ticksCache[currentExpiryOptions[(strike + farOtm) + 'CE'].instrument_token].last_price + ticksCache[currentExpiryOptions[(strike - farOtm) + 'PE'].instrument_token].last_price);
const pair_open = (strike) => (ticksCache[currentExpiryOptions[(strike + farOtm) + 'CE'].instrument_token].ohlc.open + ticksCache[currentExpiryOptions[(strike - farOtm) + 'PE'].instrument_token].ohlc.open);
let tradeStart = true;
async function placeTrade() {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

  if (tradeStart) {
    tradeStart = false;

    if (pair_open(new_ATM_Strike) > pair_price(new_ATM_Strike)) sendOrder(new_ATM_Strike, 'SELL');
    else sendOrder(new_ATM_Strike, 'BUY', 0);
  }
}

let maxOrderCount = 6,
  currentOrderCount = 0;
async function sendOrder(atm_strike, orderSide, mul = 1) {
  let pair_ltp = pair_price(atm_strike);
  let ce_option = currentExpiryOptions[(atm_strike + farOtm) + "CE"];
  let pe_option = currentExpiryOptions[(atm_strike - farOtm) + "PE"];
  if (mul > 0) {
    if (maxOrderCount > currentOrderCount) {
      currentOrderCount++;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, orderSide, 1 * mul);
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, orderSide, 1 * mul);
    }
  }
  optionOrders.push({
    atm: atm_strike,
    strike_ce: ce_option.strike + 'CE',
    strike_pe: pe_option.strike + 'PE',
    type: orderSide,
    entry: pair_ltp,
    low: pair_ltp,
    high: pair_ltp
  });
}

async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    let current_position = position;
    let sl_price, pair_ltp = pair_price(position.atm);
    if (position.type == 'SELL') {
      position.low = position.low > pair_ltp ? pair_ltp : position.low;
      sl_price = position.entry + (trail_sl - (position.entry - position.low));
      if (pair_ltp > sl_price) {
        delete optionOrders[idx];
        sendOrder(current_position.atm, 'BUY', 1);
        return false;
      } else return true;
    } else if (position.type == 'BUY') {
      position.high = position.high < pair_ltp ? pair_ltp : position.high;
      sl_price = position.entry - (trail_sl - (position.high - position.entry));
      if (pair_ltp < sl_price) {
        delete optionOrders[idx];
        let bn_quote = ticksCache[futureToken];
        let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
        sendOrder(new_ATM_Strike, 'SELL', 1);
        return false;
      } else return true;
    }
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

runStrategy();