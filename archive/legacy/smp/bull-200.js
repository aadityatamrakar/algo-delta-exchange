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
let strategyTag = 'B200';
// let sl_percent = 1.05;

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

let optionOrders = [];
let futureToken, farOtm = 0,
  currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
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

    setTimeout(() => { takeTrade(); }, 15000);
  } catch (err) {
    console.log(err);
  }
}

let init_pending = true,
  ticksCache = {};
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
  init_pending = false;
  sendOrder('SELL');
}

function getStrikeByPrice(price) {
  let ce_strike, pe_strike;

  let optionsStrikes = Object.values(currentExpiryOptions).map(c => {
    if (ticksCache[c.instrument_token] && ticksCache[c.instrument_token].last_price) {
      c.distance = Math.abs(ticksCache[c.instrument_token].last_price - price);
    } else c.distance = price;
    return c;
  }).sort((a, b) => {
    return (a.distance - b.distance);
  });

  for (i = 0; i < optionsStrikes.length; i++) {
    if (!ce_strike && optionsStrikes[i].instrument_type == 'CE') ce_strike = optionsStrikes[i].strike;
    if (!pe_strike && optionsStrikes[i].instrument_type == 'PE') pe_strike = optionsStrikes[i].strike;

    if (ce_strike && pe_strike) break;
  }
  let ce_option = currentExpiryOptions[ce_strike + 'CE'];
  let pe_option = currentExpiryOptions[pe_strike + 'PE'];

  return { ce: ce_option, pe: pe_option };
}

function placeSingleOrder(option, range, transType) {
  let instrument_qoute = ticksCache[option.instrument_token].last_price;

  optionOrders.push({
    range: range,
    entry: instrument_qoute,
    stoploss: instrument_qoute + 50,
    option: option
  });

  PaperTrade.trackOrder(option, transType, strategyTag);
}

function placePairOrder(strike_pair, price_range, transType) {
  let ce_option = strike_pair.ce;
  let pe_option = strike_pair.pe;
  placeSingleOrder(ce_option, price_range, transType);
  placeSingleOrder(pe_option, price_range, transType);
}

async function sendOrder(transType = 'SELL') {
  placePairOrder(getStrikeByPrice(200), 200, transType);
  placePairOrder(getStrikeByPrice(160), 160, transType);
  placePairOrder(getStrikeByPrice(130), 130, transType);
  placePairOrder(getStrikeByPrice(100), 100, transType);

  console.log(optionOrders);
}

let lastQuote = 0;
async function checkSL() {
  if (optionOrders.length > 0) {
    for (let i = 0; i < optionOrders.length; i++) {
      const order = optionOrders[i];
      if (order) {
        const current_ltp = ticksCache[order.option.instrument_token].last_price;
        if (current_ltp >= order.stoploss) {
          PaperTrade.trackOrder(order.option, 'BUY', strategyTag);
          let new_strike_pair = getStrikeByPrice(order.range);
          if (order.option.instrument_type == 'CE') {
            placeSingleOrder(new_strike_pair.pe, order.range, 'SELL');
          } else if (order.option.instrument_type == 'PE') {
            placeSingleOrder(new_strike_pair.ce, order.range, 'SELL');
          }
          optionOrders[i] = null;
        }
      }
    }
  }
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);


// runStrategy();
new CronJob('45 24 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
