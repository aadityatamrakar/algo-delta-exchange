const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Awesome = require('../lib/indicators/ao.js');
const Fisher = require('../lib/indicators/fisher.js');
const Account = app.models.account;
const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('../tools/optionInstruments');
const moment = require('moment');

let strategyTag = 'X3';

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

let ticksCache = {};

function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
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
  lastCandle, currentCandle,
  currentDirection, currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, 264969]);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    // check();
    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let currentOrderType, positionType;
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
        let bn_candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        let vix_candleData = await zapi.historyData(264969, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        vix_candleData = await Fisher(vix_candleData, 14);
        let vix_currentCandle = vix_candleData.slice(-1)[0];
        let currentTs = moment().subtract(5, 'minute').startOf('minute').utcOffset('+0530').format().substr(0, 19) + '+0530';
        let currentCandleIdx = bn_candleData.findIndex(function (candle) {
          return candle.ts == currentTs;
        });
        let bn_currentCandle = bn_candleData[currentCandleIdx];

        if (vix_currentCandle.fisher < vix_currentCandle.fisher_signal && currentDirection != "SHORT") {
          currentOrderType = bn_currentCandle.open < bn_currentCandle.close ? upper_strike + 'CE' : lower_strike + 'PE';
          let newPosition = currentExpiryOptions[currentOrderType];
          if (typeof currentPosition != 'object' || newPosition.instrument_type != currentPosition.instrument_type) {
            if (currentPosition) await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            currentPosition = currentExpiryOptions[currentOrderType];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
          }
          currentDirection = 'SHORT';
        } else if (vix_currentCandle.fisher > vix_currentCandle.fisher_signal && currentDirection != "LONG") {
          currentOrderType = bn_currentCandle.open < bn_currentCandle.close ? lower_strike + 'PE' : upper_strike + 'CE';
          let newPosition = currentExpiryOptions[currentOrderType];
          if (typeof currentPosition != 'object' || newPosition.instrument_type != currentPosition.instrument_type) {
            if (currentPosition) await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            currentPosition = currentExpiryOptions[currentOrderType];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
          }
          currentDirection = 'LONG';
        }
      }
    } catch (err) {
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

// runStrategy();
new CronJob('0 18 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
