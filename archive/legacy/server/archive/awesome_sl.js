const CronJob = require("cron").CronJob;
var request = require('request');
var async = require('async');
const notify = require("../lib/notify.js");
let channelId = 0;
let strategyTag = 'BN_STG10';
const Tradetron = require('../lib/tradetron');
const tt_authToken = 'cd5e7bb9-3eec-400b-9f6e-4c27ad059534';
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Awesome = require('../lib/indicators/ao.js');
const Account = app.models.account;
const tranches = (number) => ((new Array(Math.floor(number / 100)).fill(100).concat(number % 100)).filter(c => c > 0));

let accounts = [],
  strangle_qty = {};
let zapi, straddle_account_zapi = [];

async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  account.lastLogin = (new Date()).toISOString().substr(0, 10);
  account.config = await zapi_n.getConfig();
  public_token = zapi_n.getPublicToken();
  await account.save();
  if (login_resp === false) return false;
  else return zapi_n;
}

async function getInstrumentDetails(underlyings = 'NIFTY') {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'POST',
      'url': 'https://api.sensibull.com/v1/instrument_details',
      'headers': {
        'content-type': 'application/json;charset=UTF-8',
      },
      json: true,
      body: {
        underlyings: [underlyings]
      }
    };
    request(options, function (error, response) {
      if (error) throw new Error(error);
      resolve(JSON.parse(response.body[underlyings]));
    });
  })
}

async function getReq(url) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': url,
      'json': true,
    };
    request(options, function (error, response) {
      if (error) resolve(false);
      resolve(response.body);
    });
  });
}

let liveFeed, public_token;
async function ticker() {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
  });
}

let currentPosition_LTP, currentPosition_SL, currentPosition_Tgt, running_PNL = 0;
async function trackPosition(token) {
  let checkQuote_attempt = 10;
  let position_tick;
  do {
    try {
      liveFeed.subscribe([token]);
      liveFeed.setMode(liveFeed.modeFull, [token]);

      position_tick = await zapi.getQoute(token);
      currentPosition_LTP = position_tick.last_price;
      currentPosition_SL = position_tick.last_price - 20;
      // currentPosition_Tgt = position_tick.last_price + ();
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  }
  while (typeof position_tick != 'object' && checkQuote_attempt > 0);
}

let underlying, futureSymbol, futureToken, NIFTY, nearestExpiry, monthlyExpiry, chain, futuresInstrument;
let orderbook = [],
  currentExpiryOptions = {},
  max_pain_strike,
  fromDate, toDate,
  lastCandle, currentCandle,
  currentDirection, currentPosition;
async function runStrategy() {
  try {
    underlying = 'BANKNIFTY';
    NIFTY = await getInstrumentDetails(underlying);
    nearestExpiry = Object.values(NIFTY.per_expiry_data).sort((a, b) => (a.daysToExpiry - b.daysToExpiry))[0].expiry;
    chain = await getReq('https://api.sensibull.com/v1/instruments/' + underlying);

    if (typeof chain != 'object' || chain.status != true) notify('chain data not available.', channelId);
    else {
      futuresInstrument = chain.data.filter(c => c.segment == 'NFO-FUT');
      let monthlyIdx = futuresInstrument.findIndex(c => (c.expiry.substr(0, 7) == nearestExpiry.substr(0, 7)));
      monthlyExpiry = futuresInstrument[monthlyIdx].expiry;
      futureToken = futuresInstrument[monthlyIdx].instrument_token;
      futureSymbol = futuresInstrument[monthlyIdx].tradingsymbol;
      max_pain = parseInt(NIFTY.per_expiry_data[monthlyExpiry].max_pain);
      // notify('Options Data Ready, Current Fut: ' + futureSymbol + ' Weekly: ' + nearestExpiry + ' Monthly: ' + monthlyExpiry, channelId);
      currentExpiryOptions = chain.data.filter(c => (c.expiry == nearestExpiry)).reduce((ob, elm) => {
        ob[elm.strike + elm.instrument_type] = elm;
        return ob;
      }, {});

      accounts = await Account.find({
        where: {
          name: 'YO8965'
        }
      });
      strangle_qty = {
        YO8965: 99
      };

      // accounts = await Account.find({});
      // strangle_qty = accounts.reduce((lotSize, elm) => {
      //   if (elm.strategy && elm.strategy[strategyTag]) {
      //     lotSize[elm.name] = parseInt(elm.strategy[strategyTag]);
      //   }
      //   return lotSize;
      // }, {});

      let combineTotalLots = Object.values(strangle_qty).reduce((s, a) => (s += a, s), 0);

      async.eachLimit(accounts, 3, function (account, cb) {
        zerodha_init(account).then(tmp_zapi => {
          if (tmp_zapi) straddle_account_zapi.push(tmp_zapi);
          cb();
        });
      }, function () {
        notify(straddle_account_zapi.length + ' accounts logged in, total ' + strategyTag + ': ' + combineTotalLots + ' lots', channelId);
      });

      let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
      zapi = await zerodha_init(base_acc);
      ticker();

      toDate = new Date();
      fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30);
      new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
    }
  } catch (err) {
    console.log(err);
  }
}

function checkTicks(ticks) {
  if (currentPosition) {
    ticks.forEach(async tick => {
      if (tick.instrument_token == currentPosition.instrument_token) {
        // current position tick
        let currentSqfPosition = currentPosition;
        if (tick.last_price < currentPosition_SL) {
          currentPosition = false;
          // strategy_running = false;
          await placeAllAccount(currentSqfPosition, 'SELL');
          notify(strategyTag + ': SL HIT', channelId);
        }
      }
    })
  }
}

async function check() {
  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = await zapi.getQoute(futureToken);

      let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
      let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        candleData = await Awesome(candleData);
        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        if (currentCandle.ao < lastCandle.ao && currentDirection != "SHORT") {
          if (currentPosition) await placeAllAccount(currentPosition, 'SELL');

          currentPosition = currentExpiryOptions[lower_strike + 'PE'];
          await placeAllAccount(currentPosition, 'BUY');
          trackPosition(currentPosition.instrument_token);
          currentDirection = 'SHORT';
        }

        if (currentCandle.ao > lastCandle.ao && currentDirection != "LONG") {
          if (currentPosition) await placeAllAccount(currentPosition, 'SELL');

          currentPosition = currentExpiryOptions[upper_strike + 'CE'];
          await placeAllAccount(currentPosition, 'BUY');
          trackPosition(currentPosition.instrument_token);
          currentDirection = 'LONG';
        }
      }
    } catch (err) {
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

function placeAllAccount(optionInstrument, orderType) {
  return new Promise((resolve, reject) => {
    orderbook = [];
    async.each(straddle_account_zapi, function (tmp_zapi, cb) {
      if (strangle_qty[tmp_zapi.credentials.user_id]) {
        if (strangle_qty[tmp_zapi.credentials.user_id] <= 100) {
          placeOrder(tmp_zapi, optionInstrument, orderType, strangle_qty[tmp_zapi.credentials.user_id], cb);
        } else {
          let orderTranches = tranches(strangle_qty[tmp_zapi.credentials.user_id]);
          async.each(orderTranches, function (orderTranch, cb2) {
            placeOrder(tmp_zapi, optionInstrument, orderType, orderTranch, cb2);
          }, cb);
        }
      } else cb();
    }, function () {
      let orderbook_text = orderbook.sort((a, b) => (b.substr(0, 6) < a.substr(0, 6) ? -1 : 1)).join('\n');
      if (orderbook_text.length > 0) notify(orderbook_text, channelId);
      resolve();
    });
  })
}

async function placeOrder(tmp_zapi, optionInstrument, orderType, straddle_lots = 1, mcb) {
  try {
    await tmp_zapi.login();
    let firstLegOrder = await tmp_zapi.orderFNO({
      tradingsymbol: optionInstrument.tradingsymbol,
      transaction_type: orderType,
      order_type: "MARKET",
      quantity: optionInstrument.lot_size * straddle_lots,
      trigger_price: 0,
      price: 0,
      tag: strategyTag
    });
    // console.log(firstLegOrder);
    if (firstLegOrder && firstLegOrder.status != 'success') orderbook.push(tmp_zapi.credentials.user_id);
    else if (!firstLegOrder) orderbook.push(tmp_zapi.credentials.user_id);

    if (mcb) mcb();
  } catch (err) {
    console.log(err);
    orderbook.push(tmp_zapi.credentials.user_id);
    if (mcb) mcb();
  }
}

// runStrategy();
new CronJob('0 19 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 8 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
