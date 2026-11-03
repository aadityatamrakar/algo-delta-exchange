const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const COG = require('../lib/indicators/cog.js');
const Awesome = require('../lib/indicators/ao.js');

// Strategy Config
let channelId = 0;
let strategyTag = 'Pattern_L';

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
      currentPosition_SL = position_tick.last_price - (135 + running_PNL);
      currentPosition_Tgt = position_tick.last_price + (124 - running_PNL);
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  }
  while (typeof position_tick != 'object' && checkQuote_attempt > 0);
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
  currentCandle, strategy_running = true,
  currentDirection, currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);
    ticker([futureToken]);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */3 * * * 1-5', checkTesla, null, true, 'Asia/Kolkata');
    // new CronJob('0 */5 * * * 1-5', checkAWS, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let ticksCache = {};

async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  if (!currentPosition && lastCandleType && ticksCache[futureToken]) {
    if (lastCandleType == 'green' && (ticksCache[futureToken].last_price - lastLow) > 100) {
      currentPosition = currentExpiryOptions[(Math.ceil(ticksCache[futureToken].last_price / 100) * 100) + 'CE'];
      entryPrice = ticksCache[futureToken].last_price;
      currentDirection = 'Long';
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
    } else if (lastCandleType == 'red' && (lastHigh - ticksCache[futureToken].last_price) > 100) {
      currentPosition = currentExpiryOptions[(Math.floor(ticksCache[futureToken].last_price / 100) * 100) + 'PE'];
      currentDirection = 'Short';
      entryPrice = ticksCache[futureToken].last_price;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
    }
  }
}


let lastCandleType, lastHigh, lastLow, entryPrice;
async function checkTesla() {
  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = ticksCache[futureToken];

      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        let candleData = await zapi.historyData(futureToken, '3minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        currentCandle = candleData.slice(-1)[0];

        if (currentCandle.open < currentCandle.close) {
          lastCandleType = 'green';
          lastLow = currentCandle.low;
        }
        if (currentCandle.open > currentCandle.close) {
          lastCandleType = 'red';
          lastHigh = currentCandle.high;
        }

        if (currentPosition) {
          if (currentDirection == 'Short' && (currentCandle.open < currentCandle.close || entryPrice < bn_quote.last_price)) {
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            currentPosition = false;
          } else if (currentDirection == 'Long' && (currentCandle.open > currentCandle.close || entryPrice > bn_quote.last_price)) {
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            currentPosition = false;
          }
        }
      }
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

// runStrategy();
new CronJob('0 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
