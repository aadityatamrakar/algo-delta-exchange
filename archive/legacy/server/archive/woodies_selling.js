const CronJob = require("cron").CronJob;
var request = require('request');
var async = require('async');
const notify = require("../lib/notify.js");
let channelId = 0;
let strategyTag = 'BN_PivotSell';
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
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

let underlying, futureSymbol, futureToken, NIFTY, nearestExpiry, monthlyExpiry, chain, futuresInstrument;
let orderbook = [],
  currentExpiryOptions = {},
  pivotLevels, currentLevel, currentPosition;
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
      // notify('Options Data Ready, Current Fut: ' + futureSymbol + ' Weekly: ' + nearestExpiry + ' Monthly: ' + monthlyExpiry, channelId);
      currentExpiryOptions = chain.data.filter(c => (c.expiry == nearestExpiry)).reduce((ob, elm) => {
        ob[elm.strike + elm.instrument_type] = elm;
        return ob;
      }, {});

      // accounts = await Account.find({
      //   where: {
      //     name: 'YO8965'
      //   }
      // });
      // strangle_qty = {
      //   YO8965: 4
      // };

      accounts = await Account.find({});
      strangle_qty = accounts.reduce((lotSize, elm) => {
        if (elm.strategy && elm.strategy[strategyTag]) {
          lotSize[elm.name] = parseInt(elm.strategy[strategyTag]);
        }
        return lotSize;
      }, {});

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
      let dailyCandle = await zapi.historyData(futureToken, 'day');

      let lastCandle, currentCandle;
      lastCandle = dailyCandle[dailyCandle.length - 2];
      currentCandle = dailyCandle[dailyCandle.length - 1];
      console.log(lastCandle, currentCandle);

      pivotLevels = calcWoodies(currentCandle, lastCandle);
      currentLevel = getPivotLoc(currentCandle.close);

      console.log(pivotLevels, currentLevel);

      new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
    }
  } catch (err) {
    console.log(err);
  }
}

async function check() {
  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = await zapi.getQoute(futureToken);
    } catch (err) {
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);

  let newLevel = getPivotLoc(bn_quote.last_price);
  let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
  let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

  console.log(currentLevel, newLevel);

  if (currentLevel != newLevel) {
    if (currentLevel > newLevel) {
      notify(strategyTag + ': SELL ' + (upper_strike + 'CE'), channelId);

      if (currentPosition && currentPosition.instrument_type == 'PE') {
        await placeAllAccount(currentPosition, "BUY");
        await placeAllAccount(currentExpiryOptions[upper_strike + 'CE'], "SELL");
        currentPosition = currentExpiryOptions[upper_strike + 'CE'];
      } else if (!currentPosition) {
        await placeAllAccount(currentExpiryOptions[upper_strike + 'CE'], "SELL");
        currentPosition = currentExpiryOptions[upper_strike + 'CE'];
      }
    } else if (currentLevel < newLevel) {
      notify(strategyTag + ': SELL ' + (lower_strike + 'PE'), channelId);

      if (currentPosition && currentPosition.instrument_type == 'CE') {
        await placeAllAccount(currentPosition, "BUY");
        await placeAllAccount(currentExpiryOptions[lower_strike + 'PE'], "SELL");
        currentPosition = currentExpiryOptions[lower_strike + 'PE'];
      } else if (!currentPosition) {
        await placeAllAccount(currentExpiryOptions[lower_strike + 'PE'], "SELL");
        currentPosition = currentExpiryOptions[lower_strike + 'PE'];
      }
    }
  }
  currentLevel = newLevel;
}

function calcWoodies(today, prev) {
  pivotLevels = {};
  let prevRange = prev.high - prev.low;
  pivotLevels.pp = ((prev.high + prev.low) + (prev.close * 2)) / 4;
  pivotLevels.r1 = (pivotLevels.pp * 2) - prev.low;
  pivotLevels.s1 = (pivotLevels.pp * 2) - prev.high;

  pivotLevels.r2 = pivotLevels.pp + prevRange;
  pivotLevels.r3 = prev.high + (2 * (pivotLevels.pp - prev.low));
  pivotLevels.s2 = pivotLevels.pp - (pivotLevels.r1 - pivotLevels.s1);
  pivotLevels.s3 = prev.low - (2 * (prev.high - pivotLevels.pp));
  return pivotLevels;
}


function getPivotLoc(ltp) {
  let currentLocation = 0;
  if (pivotLevels) {
    if (pivotLevels.r3 < ltp) currentLocation = 4;
    else if (pivotLevels.r2 < ltp) currentLocation = 3;
    else if (pivotLevels.r1 < ltp) currentLocation = 2;
    else if (pivotLevels.pp < ltp) currentLocation = 1;

    if (pivotLevels.s3 > ltp) currentLocation = -4;
    else if (pivotLevels.s2 > ltp) currentLocation = -3;
    else if (pivotLevels.s1 > ltp) currentLocation = -2;
    else if (pivotLevels.pp > ltp) currentLocation = -1;
  }
  return currentLocation;
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
new CronJob('0 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 18 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
