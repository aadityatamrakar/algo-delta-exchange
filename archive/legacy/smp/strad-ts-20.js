const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const otmSelector = require('../lib/otmSelector');
const async = require('async');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'StradTS-20';
let SL_Sell_percent = 0.40;
let SL_Buy_percent = 0.25;

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

let init_pending = false,
  ticksCache = {};
let futureToken, farOtm = 0,
  currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    // if (moment().day() == 3) {
    //   currentExpiryOptions = optionData.nextWeekInstruments;
    // }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // farOtm = otmSelector();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(() => {
      init_pending = true;
    }, 14000);
  } catch (err) {
    console.log(err);
  }
}

async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  if (init_pending) {
    takeTrade();
  }

  checkSLQ.push({
    check: 1
  });
}

let max_trades = 5;
async function takeTrade() {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

  let atm_ce = currentExpiryOptions[new_ATM_Strike + "CE"];
  let atm_pe = currentExpiryOptions[new_ATM_Strike + "PE"];

  let combine_premium = ticksCache[atm_ce.instrument_token].last_price + ticksCache[atm_pe.instrument_token].last_price;
  let open_premium = ticksCache[atm_ce.instrument_token].ohlc.open + ticksCache[atm_pe.instrument_token].ohlc.open;

  console.log('COMBINE', combine_premium, 'OPEN', open_premium, 'ATM', new_ATM_Strike);
  if (combine_premium < open_premium) {
    console.log('SELL', combine_premium, open_premium, new_ATM_Strike);
    init_pending = false;
    sendOrder('SELL');
  }
}
var takePositionQ = async.queue(function (task, callback) {
  takeTrade().then(function (res) {
    callback();
  });
}, 1);

let optionOrders = [];
async function sendOrder(tradeSide) {
  try {
    if (max_trades <= 0) return;
    else {
      let bn_quote = ticksCache[futureToken];
      let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

      let atm_ce = currentExpiryOptions[(new_ATM_Strike + 100) + "CE"];
      let atm_pe = currentExpiryOptions[(new_ATM_Strike - 100) + "PE"];

      let combine_premium = ticksCache[atm_ce.instrument_token].last_price + ticksCache[atm_pe.instrument_token].last_price;

      if (tradeSide == 'SELL') {
        PaperTrade.trackOrder(atm_ce, tradeSide, strategyTag);
        PaperTrade.trackOrder(atm_pe, tradeSide, strategyTag);

        let tradeObj = {
          atm: new_ATM_Strike,
          pe_ticker: atm_pe.instrument_token,
          ce_ticker: atm_ce.instrument_token,
          ce_opt: atm_ce,
          pe_opt: atm_pe,
          stoploss: false,
          entry: combine_premium,
          low: combine_premium,
          sl_points: Math.round(combine_premium * SL_Sell_percent),
          tradeSide: tradeSide,
        };
        tradeObj.sl_trigger = combine_premium + tradeObj.sl_points;
        optionOrders.push(tradeObj);
        max_trades--;
      } else if (tradeSide == "BUY") {
        let tradeObj = {
          atm: new_ATM_Strike,
          pe_ticker: atm_pe.instrument_token,
          ce_ticker: atm_ce.instrument_token,
          ce_opt: atm_ce,
          pe_opt: atm_pe,
          stoploss: false,
          entry: combine_premium,
          high: combine_premium,
          sl_points: Math.round(combine_premium * SL_Buy_percent),
          tradeSide: tradeSide,
        };
        tradeObj.sl_trigger = combine_premium - tradeObj.sl_points;
        optionOrders.push(tradeObj);
      }
    }
  } catch (err) {
    console.log(err);
  }

  return;
}

async function checkStoploss() {
  if (optionOrders.length == 0) return;

  for (let i = 0; i < optionOrders.length; i++) {
    let order = optionOrders[i];
    let ce_ltp = ticksCache[order.ce_ticker].last_price;
    let pe_ltp = ticksCache[order.pe_ticker].last_price;
    let combine_premium = ce_ltp + pe_ltp;

    if (order.tradeSide === "SELL") {
      if (combine_premium < order.low) {
        optionOrders[i].low = combine_premium;
        optionOrders[i].sl_trigger = combine_premium + order.sl_points;
        console.log('stoploss check: ' + order.atm, combine_premium, order.sl_trigger);
      }

      if (combine_premium > order.sl_trigger) {
        console.log("SELL STOPLOSS HIT", order.atm, combine_premium, order.sl_trigger);
        PaperTrade.trackOrder(order.ce_opt, "BUY", strategyTag);
        PaperTrade.trackOrder(order.pe_opt, "BUY", strategyTag);
        optionOrders.splice(i, 1);
        sendOrder('BUY');
      }
    } else if (order.tradeSide === "BUY") {
      if (combine_premium > order.high) {
        optionOrders[i].high = combine_premium;
        optionOrders[i].sl_trigger = combine_premium - order.sl_points;
        console.log('stoploss check: ' + order.atm, combine_premium, order.sl_trigger);
      }

      if (combine_premium < order.sl_trigger) {
        console.log("BUY STOPLOSS HIT", order.atm, combine_premium, order.sl_trigger);
        optionOrders.splice(i, 1);
        sendOrder('SELL');
      }
    }
  }
}


var checkSLQ = async.queue(function (task, callback) {
  checkStoploss().then(function (res) {
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
