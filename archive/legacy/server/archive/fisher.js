const CronJob = require("cron").CronJob;
var async = require('async');
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Fisher = require('../lib/indicators/fisher.js');
const Account = app.models.account;
const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('../tools/optionInstruments');

let channelId = 0;
let strategyTag = 'F1';

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
  currentDirection, currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    let base_acc = await Account.findById("5fcfd7fd795f486e2440be20");
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
          await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentSqfPosition, 'BUY');
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
          candleData = await Fisher(candleData, 14);
          currentCandle = candleData.slice(-1)[0];
          
          if (currentCandle.fisher < currentCandle.fisher_signal && currentDirection != "SHORT") {
            if (currentPosition) {
              await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              currentPosition = false;
            }

            currentPosition = currentExpiryOptions[lower_strike + 'PE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'SHORT';
          }

          if (currentCandle.fisher > currentCandle.fisher_signal && currentDirection != "LONG") {
            if (currentPosition) {
              await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              currentPosition = false;
            }

            currentPosition = currentExpiryOptions[upper_strike + 'CE'];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            currentDirection = 'LONG';
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
new CronJob('0 19 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
