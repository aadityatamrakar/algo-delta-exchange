const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Supertrend = require('../lib/indicators/atr.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const optionConfig = require('../tools/optionInstruments');

const notify = require("../lib/notify.js");
let channelId = 0;
let strategyTag = 'LowRisk';

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
  instruments = [],
  running_accounts = [],
  account_quantities = {};
async function getAccounts() {
  let accountsData = await XtsAccount.loadAccounts(strategyTag);
  accounts = accountsData.accounts;
  running_accounts = accounts;
  account_quantities = accountsData.account_quantities;
}

let futureToken, currentExpiryOptions = {},
  max_pain_strike, max_pain,
  fromDate, toDate,
  currentCandle,
  currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    max_pain = optionData.max_pain;

    await getAccounts();
    instruments = await XtsAccount.loadInstruments(optionData.weeklyExpiry);
    // notify(accounts.length + ' XTS accounts logged in, total ' + strategyTag + ': ' + combineTotalLots + ' lots', channelId);

    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);

    new CronJob('0 20 9 * * 1-5', async function () {
      let bn_quote;
      let checkQuote_attempt = 10;
      do {
        try {
          checkQuote_attempt--;
          bn_quote = await zapi.getQoute(futureToken);
        } catch (err) {
          await zapi.login();
        }
      } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);

      console.log(bn_quote.last_price, max_pain);
      let sellOptionType = max_pain < bn_quote.last_price ? 'PE' : 'CE';
      max_pain_strike = chain.data.filter(c => (c.expiry == nearestExpiry && c.strike == max_pain && c.instrument_type == sellOptionType));

      if (max_pain_strike.length == 1) {
        max_pain_strike = max_pain_strike[0];
        toDate = new Date();
        fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 30);
        check();
        new CronJob('0 */3 * * * 1-5', check, null, true, 'Asia/Kolkata');
      }
    }, null, true, 'Asia/Kolkata');

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

      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        let candleData = await zapi.historyData(max_pain_strike.instrument_token, '3minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        candleData = await Supertrend(candleData, 7, 2);
        console.log(max_pain_strike.tradingsymbol);
        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        if (currentPosition) {
          if (currentCandle.supertrend < currentCandle.close && currentPosition == 'ENTERED') {
            await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, max_pain_strike, 'BUY');
            currentPosition = 'EXITED';
          }

          if (currentCandle.supertrend > currentCandle.close && currentPosition == 'EXITED') {
            await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, max_pain_strike, 'SELL');
            currentPosition = 'ENTERED';
          }
        } else {
          if (currentCandle.supertrend > currentCandle.close) {
            await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, max_pain_strike, 'SELL');
            currentPosition = 'ENTERED';
          }
        }
      }
    } catch (err) {
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

// runStrategy();
new CronJob('0 18 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 8 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
