const CronJob = require("cron").CronJob;
var async = require('async');
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Awesome = require('../lib/indicators/ao.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('../tools/optionInstruments');

let channelId = 0;
let strategyTag = 'Urvashi';

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

let instruments;
let xts_accounts = [],
  xts_running_accounts = [],
  xts_account_quantities = {};
async function xtsGetAccounts() {
  let accountsData = await XtsAccount.loadAccounts(strategyTag);
  xts_accounts = accountsData.accounts;
  xts_running_accounts = accounts;
  xts_account_quantities = accountsData.account_quantities;
}

let futureToken, currentExpiryOptions = {},
  fromDate, toDate,
  lastCandle, currentCandle,
  currentDirection, currentPosition, currentPosition2;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    // await xtsGetAccounts();
    instruments = await XtsAccount.loadInstruments(optionData.weeklyExpiry);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    // new CronJob('30 * * * * 1-5', xtsGetAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
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
          candleData = await Awesome(candleData);
          currentCandle = candleData.slice(-1)[0];
          lastCandle = candleData.slice(-2)[0];

          if (currentCandle.ao < lastCandle.ao && currentDirection != "SHORT") {
            if (currentPosition) {
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition2, 'BUY');
              currentPosition = false;
              currentPosition2 = false;
            }

            currentPosition = currentExpiryOptions[lower_strike + 'PE'];
            currentPosition2 = currentExpiryOptions[lower_strike + 'CE'];
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition2, 'SELL');
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            currentDirection = 'SHORT';
          }

          if (currentCandle.ao > lastCandle.ao && currentDirection != "LONG") {
            if (currentPosition) {
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition2, 'BUY');
              currentPosition = false;
              currentPosition2 = false;
            }

            currentPosition = currentExpiryOptions[upper_strike + 'CE'];
            currentPosition2 = currentExpiryOptions[upper_strike + 'PE'];
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition2, 'SELL');
            currentDirection = 'LONG';
          }
        }
      } catch (err) {
        console.log(err);
        bn_quote = false;
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
