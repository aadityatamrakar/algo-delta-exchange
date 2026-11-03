const CronJob = require("cron").CronJob;
var async = require('async');
const app = require('../../server.js');
const zerodha = require('../../lib/zerodha.js');
const Supertrend = require('../../lib/indicators/atr.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const StrategyData = app.models.strategyData;
let strategyId = '5fe483efc644c954efac1483';
const optionConfig = require('../../tools/optionInstruments');

const notify = require("../../lib/notify.js");
let channelId = 0;
let strategyTag = 'Bentley';

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
  account_quantities = {};
async function getAccounts() {
  let accountsData = await XtsAccount.loadAccounts(strategyTag);
  accounts = accountsData.accounts;
  running_accounts = accounts;
  account_quantities = accountsData.account_quantities;
}

async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    instruments = await XtsAccount.loadInstruments(optionData.weeklyExpiry);
    // notify(accounts.length + ' XTS accounts logged in, total ' + strategyTag + ': ' + combineTotalLots + ' lots', channelId);

    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
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

        // console.log(lastCandle, currentCandle);
        // BULLISH
        if (strategyConfig.currentPosition != 'LONG' && currentCandle.supertrend < currentCandle.close) {
          if (strategyConfig.positions) await closePositions(strategyConfig.positions);

          notify('STG3: GOING LONG', channelId);
          await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentExpiryOptions[(lower_strike - 300) + 'PE'], 'BUY');
          await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentExpiryOptions[lower_strike + 'PE'], 'SELL');
          strategyConfig.positions = {
            BUY: [currentExpiryOptions[(lower_strike - 300) + 'PE']],
            SELL: [currentExpiryOptions[lower_strike + 'PE']]
          };
          strategyConfig.currentPosition = 'LONG';
          await strategyConfig.save();
        }

        // BEARISH
        if (strategyConfig.currentPosition != 'SHORT' && currentCandle.supertrend > currentCandle.close) {
          if (strategyConfig.positions) await closePositions(strategyConfig.positions);

          notify('STG3: GOING SHORT', channelId);
          await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentExpiryOptions[(upper_strike + 300) + 'CE'], 'BUY');
          await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentExpiryOptions[upper_strike + 'CE'], 'SELL');
          strategyConfig.positions = {
            BUY: [currentExpiryOptions[(upper_strike + 300) + 'CE']],
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
    async.parallel([
      function (mcb) {
        if (positions.BUY && positions.BUY.length > 0) {
          async.each(positions.BUY, function (position, cb) {
            XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, position, 'SELL').then(cb);
          }, mcb);
        } else mcb();
      },
      function (mcb) {
        if (positions.SELL && positions.SELL.length > 0) {
          async.each(positions.SELL, function (position, cb) {
            XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, position, 'BUY').then(cb);
          }, mcb);
        } else mcb();
      }
    ], resolve);
  });
}

// runStrategy();
new CronJob('0 19 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 18 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
