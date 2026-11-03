
const CronJob = require("cron").CronJob;
const notify = require("../../lib/notify.js");
const app = require('../../server.js');
const zerodha = require('../../lib/zerodha.js');
const kiteTicker = require('../../lib/KiteTicker');
const EMA = require('../../lib/indicators/ema.js');
const Account = app.models.account;
const optionConfig = require('../../tools/optionInstruments');
const async = require('async');

// Strategy Config
let channelId = 0;
let strategyTag = 'EMA_B';

let zapi;
let public_token;
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
  fromDate, toDate,
  currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken]);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [],
  trail_sl = 120;

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
}

async function check() {
  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = await zapi.getQoute(futureToken);
      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        candleData = await EMA(candleData, 100, 'high', 'emaHigh');
        candleData = await EMA(candleData, 100, 'low', 'emaLow');

        let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
        let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        // console.log(currentCandle, lastCandle);

        let longCondition = currentCandle.close > currentCandle.emaHigh && lastCandle.close < lastCandle.emaHigh;
        let shortCondition = currentCandle.close < currentCandle.emaLow && lastCandle.close > lastCandle.emaLow;

        // console.log(currentCandle.ts, longCondition, shortCondition, currentPosition);

        let newPosition = longCondition ? 'LONG' : shortCondition ? 'SHORT' : false;

        if (currentPosition) {
          if (currentDirection != newPosition && longCondition) {
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            currentPosition = currentExpiryOptions[upper_strike + 'CE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'LONG';
          } else if (currentDirection != newPosition && shortCondition) {
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            currentPosition = currentExpiryOptions[lower_strike + 'PE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'SHORT';
          }
        } else {
          if (currentCandle.close > currentCandle.emaHigh) {
            currentPosition = currentExpiryOptions[upper_strike + 'CE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'LONG';
          } else if (currentCandle.close < currentCandle.emaLow) {
            currentPosition = currentExpiryOptions[lower_strike + 'PE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'SHORT';
          }
        }
      }
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  }
  while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

// runStrategy();
new CronJob('0 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');