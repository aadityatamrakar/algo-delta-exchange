const CronJob = require("cron").CronJob;
const async = require('async');
const moment = require('moment');
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Supertrend = require('../lib/indicators/atr.js');
const Account = app.models.account;
const Positional = app.models.positional;
const StrategyData = app.models.strategyData;
let strategyId = "60e6c79e1c2c6d4e5972bac4";
const optionConfig = require('../tools/optionInstruments');

let channelId = 0;
let strategyTag = 'Jaguar';

let zapi;
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

let futureToken, currentExpiryOptions = {},
  toDate, fromDate, instruments;

let accounts = [],
  running_accounts = [],
  account_quantities = {},
  firstRun = true;

async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 4 && moment().utcOffset('+05:30').hour() > 14) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    check();
    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

async function check() {
  let bn_quote;
  let checkQuote_attempt = 10;
  let strategyConfig = await StrategyData.findById(strategyId);
  // console.log(strategyConfig);
  if (!strategyConfig.currentPosition) strategyConfig.currentPosition = 'NONE';
  do {
    try {
      checkQuote_attempt--;
      bn_quote = await zapi.getQoute(futureToken);
      // console.log(bn_quote);
      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        // console.log(candleData);
        candleData = await Supertrend(candleData, 14, 5);
        // console.log(max_pain_strike.tradingsymbol);
        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
        let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

        let candleHedge = 300;

        // BULLISH
        if (strategyConfig.currentPosition != 'LONG' && currentCandle.supertrend < currentCandle.close) {
          if (strategyConfig.positions) await closePositions(strategyConfig.positions);

          await Positional.trackOrder(currentExpiryOptions[(lower_strike - candleHedge) + 'PE'], 'BUY', strategyTag, 8);
          await Positional.trackOrder(currentExpiryOptions[lower_strike + 'PE'], 'SELL', strategyTag, 8);
          strategyConfig.positions = {
            BUY: [currentExpiryOptions[(lower_strike - candleHedge) + 'PE']],
            SELL: [currentExpiryOptions[lower_strike + 'PE']]
          };
          strategyConfig.currentPosition = 'LONG';
          await strategyConfig.save();
        }

        // BEARISH
        if (strategyConfig.currentPosition != 'SHORT' && currentCandle.supertrend > currentCandle.close) {
          if (strategyConfig.positions) await closePositions(strategyConfig.positions);

          await Positional.trackOrder(currentExpiryOptions[(upper_strike + candleHedge) + 'CE'], 'BUY', strategyTag, 8);
          await Positional.trackOrder(currentExpiryOptions[upper_strike + 'CE'], 'SELL', strategyTag, 8);
          strategyConfig.positions = {
            BUY: [currentExpiryOptions[(upper_strike + candleHedge) + 'CE']],
            SELL: [currentExpiryOptions[upper_strike + 'CE']]
          }
          strategyConfig.currentPosition = 'SHORT';
          await strategyConfig.save();
        }
      }
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

async function closePositions(positions) {
  return new Promise((resolve, reject) => {
    async.eachSeries(positions.SELL, function (position, cb) {
      Positional.trackOrder(position, 'BUY', strategyTag, 8).then(cb);
    }, function () {
      async.eachSeries(positions.BUY, function (position, cb) {
        Positional.trackOrder(position, 'SELL', strategyTag, 8).then(cb);
      }, resolve);
    });
  });
}

// runStrategy();
new CronJob('0 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 0 15 * * 4', async function () {
  let strategyConfig = await StrategyData.findById(strategyId);
  await closePositions(strategyConfig.positions);
  strategyConfig.positions = {};
  strategyConfig.currentPosition = 'NONE';
  await strategyConfig.save();
  let optionData = await optionConfig();
  futureToken = optionData.currentFuture.token;
  currentExpiryOptions = optionData.nextWeekInstruments;
  check();
}, null, true, 'Asia/Kolkata');
new CronJob('0 26 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
