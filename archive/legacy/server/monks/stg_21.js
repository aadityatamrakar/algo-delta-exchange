const CronJob = require("cron").CronJob;
var async = require('async');
var moment = require('moment');
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const ATR = require('../lib/indicators/atr_band.js');
const High = require('../lib/indicators/high.js');
const Low = require('../lib/indicators/low.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('../tools/optionInstruments');

let channelId = 0;
// let strategyTag = 'ITCRT';
let strategyTag = 'STG21';

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
  currentDirection_s, currentPosition_s,
  currentDirection_l, currentPosition_l;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    instruments = await XtsAccount.loadInstruments(optionData.weeklyExpiry);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let ticksCache = {};

function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  checkSLQ.push({
    check: 1
  });
}

let strategy_running = true;
async function check() {
  let bn_quote;
  let checkQuote_attempt = 10;
  if (strategy_running) {
    do {
      try {
        checkQuote_attempt--;
        bn_quote = await zapi.getQoute(futureToken);

        let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
        let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

        if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
          let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));

          candleData = await High(candleData, 'high', 'HH', 22);
          candleData = await Low(candleData, 'low', 'LL', 22);
          candleData = await ATR(candleData, 22, 3);

          let currentTs = moment().subtract(5, 'minute').startOf('minute').utcOffset('+0530').format().substr(0, 19) + '+0530';
          let currentCandleIdx = candleData.findIndex(function (candle) {
            return candle.ts == currentTs;
          });
          currentCandle = candleData[currentCandleIdx];
          lastCandle = candleData[currentCandleIdx - 1];
          console.log(currentTs, currentCandle, lastCandle);

          let red_line = currentCandle.HH - (currentCandle.atr * 3);
          let green_line = currentCandle.LL + (currentCandle.atr * 3);

          console.log(green_line, red_line, currentCandle.atr, currentCandle.close);
          if (currentCandle.close < green_line && currentDirection_s != "SHORT") {
            if (currentPosition_s) {
              openOrder_s = false;
              await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_s, 'BUY');
              console.log('Short Exit');
            }

            currentPosition_s = currentExpiryOptions[lower_strike + 'PE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_s, 'SELL');
            openOrder_s = {
              token: currentPosition_s.instrument_token,
              entry: ticksCache[currentPosition_s.instrument_token].last_price,
              sl_trigger: ticksCache[currentPosition_s.instrument_token].last_price + sl_points,
            };
            currentDirection_s = 'SHORT';
            console.log('Short Entry');
          } else if (currentCandle.close > green_line && currentDirection_s == "SHORT") {
            console.log('Short Exit');
            openOrder_s = false;
            if (currentPosition_s) await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_s, 'BUY');
            currentPosition_s = false;
            currentDirection_s = false;
          }

          if (currentCandle.close > red_line && currentDirection_l != "LONG") {
            if (currentPosition_l) {
              openOrder_l = false;
              await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_l, 'BUY');
            }

            currentPosition_l = currentExpiryOptions[upper_strike + 'CE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_l, 'SELL');
            openOrder_l = {
              token: currentPosition_l.instrument_token,
              entry: ticksCache[currentPosition_l.instrument_token].last_price,
              sl_trigger: ticksCache[currentPosition_l.instrument_token].last_price + sl_points,
            };
            currentDirection_l = 'LONG';
            console.log('Long Entry');
          } else if (currentCandle.close < red_line && currentDirection_l == "LONG") {
            console.log('Long Exit');
            openOrder_l = false;
            if (currentPosition_l) await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition_l, 'BUY');
            currentPosition_l = false;
            currentDirection_l = false;
          }
        }
      } catch (err) {
        console.log(err);
        bn_quote = false;
        await zapi.login();
      }
    }
    while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
  }
}


let openOrder_l = false,
  openOrder_s = false,
  sl_points = 80;
async function checkSL() {
  if (openOrder_l && ticksCache[openOrder_l.token].last_price > openOrder_l.sl_trigger) {
    openOrder_l = false;
    let tmpInstrument = JSON.parse(JSON.stringify(currentPosition_l));
    currentPosition_l = false;
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, tmpInstrument, 'BUY');
    console.log('SL Hit ', tmpInstrument);
    return false;
  }
  if (openOrder_s && ticksCache[openOrder_s.token].last_price > openOrder_s.sl_trigger) {
    openOrder_s = false;
    let tmpInstrument = JSON.parse(JSON.stringify(currentPosition_s));
    currentPosition_s = false;
    console.log('SL Hit ', tmpInstrument);
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, tmpInstrument, 'BUY');
    return false;
  }
  return false;
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('0 19 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
