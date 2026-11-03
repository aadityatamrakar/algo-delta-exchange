const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const COG = require('../lib/indicators/cog.js');
const Awesome = require('../lib/indicators/ao.js');
const moment = require('moment');
const pause = async (ms) => (new Promise((r, c) => setTimeout(r, ms)));

// Strategy Config
let channelId = 0;
let strategyTag = 'Tesla';

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

let currentPosition_LTP, currentPosition_SL, currentPosition_Tgt, running_PNL = 0;
async function trackPosition(token) {
  let checkQuote_attempt = 10;
  let position_tick;
  do {
    try {
      liveFeed.subscribe([token]);
      liveFeed.setMode(liveFeed.modeFull, [token]);

      position_tick = ticksCache[token];
      currentPosition_LTP = position_tick.last_price;
      currentPosition_SL = position_tick.last_price + (100 + running_PNL);
      currentPosition_Tgt = position_tick.last_price - (100 - running_PNL);
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
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', checkTesla, null, true, 'Asia/Kolkata');
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
  if (currentPosition) {
    let currentSqfPosition = currentPosition;
    // if (ticksCache[currentSqfPosition.instrument_token].last_price < currentPosition_SL) {
    //   currentPosition = false;
    //   strategy_running = false;
    //   Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentSqfPosition, 'SELL');
    //   notify(strategyTag + ': SL HIT', channelId);
    // }
    // if (ticksCache[currentSqfPosition.instrument_token].last_price < currentPosition_Tgt) {
    //   currentPosition = false;
    //   strategy_running = false;
    //   notify(strategyTag + ': TGT HIT', channelId);
    //   Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentSqfPosition, 'BUY');
    // }
  }
}


async function checkTesla() {
  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = ticksCache[futureToken];

      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        candleData = await COG(candleData, 0.0004, 15, 14, 3);

        let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
        let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        let newDirectionTesla = false,
          newPositionTesla = false;

        if (strategy_running) {
          if (currentDirection != currentCandle.cog_signal) {
            if (currentCandle.cog_signal == 'LONG') {
              newPositionTesla = currentExpiryOptions[upper_strike + 'CE'];
            }
            if (currentCandle.cog_signal == 'SHORT') {
              newPositionTesla = currentExpiryOptions[lower_strike + 'PE'];
            }
            newDirectionTesla = currentCandle.cog_signal;
          }
        }

        console.log(moment().format('HH:mm'), currentCandle.cog_signal, newDirectionTesla, currentPosition);

        if (newDirectionTesla) {
          if (currentPosition) {
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            let position_tick = ticksCache[currentPosition.instrument_token];
            running_PNL = running_PNL + Math.round(currentPosition_LTP - position_tick.last_price);
            // notify(strategyTag + ': PNL ' + running_PNL, channelId);
            currentPosition = false;
            await pause(300);
          }
          currentPosition = newPositionTesla;
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
          trackPosition(currentPosition.instrument_token);
          currentDirection = newDirectionTesla;
        }
      }
    } catch (err) {
      console.log(err);
      bn_quote = false;
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

let AWS_running = false,
  currentDirection_AWS, currentPosition_AWS;
async function checkAWS() {
  if (AWS_running) {
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

          if (currentCandle.ao < lastCandle.ao && currentDirection_AWS != "SHORT") {
            if (currentPosition_AWS) Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_AWS, 'SELL');

            currentPosition_AWS = currentExpiryOptions[lower_strike + 'PE'];
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_AWS, 'BUY');
            currentDirection_AWS = 'SHORT';
          }

          if (currentCandle.ao > lastCandle.ao && currentDirection_AWS != "LONG") {
            if (currentPosition_AWS) Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_AWS, 'SELL');

            currentPosition_AWS = currentExpiryOptions[upper_strike + 'CE'];
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_AWS, 'BUY');
            currentDirection_AWS = 'LONG';
          }
        }
      } catch (err) {
        bn_quote = false;
        await zapi.login();
      }
    } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
  }
}

// runStrategy();
new CronJob('0 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
