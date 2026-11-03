const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Awesome = require('../lib/indicators/ao.js');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');

let strategyTag = 'Akbar_AI';

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
        let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        candleData = await Awesome(candleData);
        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        if (currentCandle.ao < lastCandle.ao && currentDirection != "SHORT") {
          if (currentPosition) await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');

          currentPosition = currentExpiryOptions[lower_strike + 'PE'];
          await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
          currentDirection = 'SHORT';
        }

        if (currentCandle.ao > lastCandle.ao && currentDirection != "LONG") {
          if (currentPosition) await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');

          currentPosition = currentExpiryOptions[upper_strike + 'CE'];
          await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
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
