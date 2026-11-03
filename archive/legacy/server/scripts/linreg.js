const CronJob = require("cron").CronJob;
var async = require('async');
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Account = app.models.account;
const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('../tools/optionInstruments');
let moment = require('moment');

let LL = require("../lib/indicators/low");
let HH = require("../lib/indicators/high");
let SMA = require("../lib/indicators/sma");
let TickType = require("../lib/strategies/tick");
let LinReg = require("../lib/indicators/linreg");

let channelId = 0;
let strategyTag = 'Math_AI';

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
      currentPosition_SL = position_tick.last_price + (110 + running_PNL);
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  }
  while (typeof position_tick != 'object' && checkQuote_attempt > 0);
}


let liveFeed;
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
  currentDirection, currentPosition, currentBar = 0;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    // ticker();

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

function checkTicks(ticks) {
  if (currentPosition) {
    ticks.forEach(async tick => {
      if (tick.instrument_token == currentPosition.instrument_token) {
        // current position tick
        let currentSqfPosition = currentPosition;
        if (tick.last_price > currentPosition_SL) {
          currentPosition = false;
          strategy_running = false;
          Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentSqfPosition, 'BUY');
          notify(strategyTag + ': SL HIT', channelId);
        }
      }
    })
  }
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
          let period = 20;
          candleData = await LL(candleData, 'low', 'LL', period);
          candleData = await HH(candleData, 'high', 'HH', period);
          candleData = await SMA(candleData, period, 'close', 'sma');
          candleData.forEach(tick => {
            tick.vol = Math.round((tick.close - ((((tick.HH + tick.LL) / 2) + tick.sma) / 2)) * 100) / 100;
          });
          candleData = await LinReg(candleData.slice(30), 'vol', 'linreg', 20);

          currentCandle = candleData.slice(-1)[0];
          lastCandle = candleData.slice(-2)[0];
          last2Candle = candleData.slice(-3)[0];

          currentBar += 1;
          if (currentPosition && currentBar == 3) {
            let green1 = TickType(currentCandle);
            let green2 = TickType(lastCandle);
            let green3 = TickType(last2Candle);
            let sumOfTicks = green1 + green2 + green3;
            
            if ((currentDirection == 'Long' && sumOfTicks < 2) || (currentDirection == 'Short' && sumOfTicks > 1)) {
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              currentPosition = false;
            }
          }

          console.log(moment().format('HH:mm'), currentCandle.linreg, lastCandle.linreg, currentBar, currentPosition);
          if (currentCandle.linreg > lastCandle.linreg && currentDirection != 'Long') {
            if (currentPosition) {
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              currentPosition = false;
              currentBar = 0;
            }
            currentPosition = currentExpiryOptions[upper_strike + 'CE'];
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'Long';
            currentBar = 1;
          }

          if (currentCandle.linreg < lastCandle.linreg && currentDirection != 'Short') {
            if (currentPosition) {
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              currentPosition = false;
              currentBar = 0;
            }
            currentPosition = currentExpiryOptions[lower_strike + 'PE'];
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'Short';
            currentBar = 1;
          }
        }
      } catch (err) {
        console.log(err);
        await zapi.login();
      }
    } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
  }
}

// runStrategy();
new CronJob('30 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
