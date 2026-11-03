const CronJob = require("cron").CronJob;
var async = require('async');
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Supertrend = require('../lib/indicators/atr.js');
const Account = app.models.account;
const StrategyData = app.models.strategyData;
const Positional = app.models.positional;
const PositionalReport = require('../lib/positionalReport.js');
let strategyId = "60ee9f956d78bc56025302a4";
const optionConfig = require('../tools/optionInstruments');

const notify = require("../lib/notify.js");
let channelId = 0;
let strategyTag = 'RollsRoyce';

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
async function getAccounts() {
  let accountsData = await Account.loadAccounts(strategyTag, firstRun);
  accounts = accountsData.accounts;
  account_quantities = accountsData.account_quantities;
  if (firstRun) {
    running_accounts = accountsData.running_accounts;
    firstRun = false;
  }
}

async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    // check();
    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
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

        let candleHedge = 200;
        // console.log(lastCandle, currentCandle);
        // BULLISH
        if (strategyConfig.currentPosition != 'LONG' && currentCandle.supertrend < currentCandle.close) {
          if (strategyConfig.positions) await closePositions(strategyConfig.positions);

          notify('Rolls: GOING LONG', channelId);
          Account.placeAllAccountNrml(strategyTag, account_quantities, running_accounts, currentExpiryOptions[lower_strike + 'PE'], 'SELL');
          await Positional.trackOrder(currentExpiryOptions[lower_strike + 'PE'], 'SELL', strategyTag, 1);
          strategyConfig.positions = {
            BUY: [],
            SELL: [currentExpiryOptions[lower_strike + 'PE']]
          };
          strategyConfig.currentPosition = 'LONG';
          await strategyConfig.save();
        }

        // BEARISH
        if (strategyConfig.currentPosition != 'SHORT' && currentCandle.supertrend > currentCandle.close) {
          if (strategyConfig.positions) await closePositions(strategyConfig.positions);

          notify('Rolls: GOING SHORT', channelId);
          Account.placeAllAccountNrml(strategyTag, account_quantities, running_accounts, currentExpiryOptions[upper_strike + 'CE'], 'SELL');
          await Positional.trackOrder(currentExpiryOptions[upper_strike + 'CE'], 'SELL', strategyTag, 1);
          strategyConfig.positions = {
            BUY: [],
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
      Account.placeAllAccountNrml(strategyTag, account_quantities, running_accounts, position, 'BUY').then(function () {
        Positional.trackOrder(position, 'BUY', strategyTag, 1).then(cb);
      });
    }, resolve);
  });
}

// runStrategy();
new CronJob('0 19 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 0 15 * * 4', async function () {
  let strategyConfig = await StrategyData.findById(strategyId);
  await closePositions(strategyConfig.positions);
  try {
    if (strategyConfig.positions.SELL && strategyConfig.positions.SELL[0].tradingsymbol) {
      await PositionalReport(strategyConfig.positions.SELL[0].tradingsymbol, strategyTag);
    }
  } catch (err) {
    console.log(err);
  }
  strategyConfig.positions = {};
  strategyConfig.currentPosition = 'NONE';
  await strategyConfig.save();
  let optionData = await optionConfig();
  futureToken = optionData.currentFuture.token;
  currentExpiryOptions = optionData.nextWeekInstruments;
  check();
}, null, true, 'Asia/Kolkata');
new CronJob('0 18 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
