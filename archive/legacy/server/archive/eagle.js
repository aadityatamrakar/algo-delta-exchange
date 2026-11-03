const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Supertrend = require('../lib/indicators/atr.js');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const notify = require("../lib/notify.js");

const Tradetron = require('../lib/tradetron');
const tt_authToken = 'cd5e7bb9-3eec-400b-9f6e-4c27ad059534';
let strategyTag = 'Eagle';
let channelId = 0;

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


let futureToken, max_pain,
  max_pain_strike,
  sellOptionType,
  fromDate, toDate,
  lastCandle, currentCandle,
  currentPosition, skipTrades = 0;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    max_pain = optionData.max_pain;

    await getAccounts();
    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');

    new CronJob('0 19 9 * * 1-5', async function () {
      optionData = await optionConfig();
      if (optionData && optionData.max_pain) {
        max_pain = optionData.max_pain;
      }
    }, null, true, 'Asia/Kolkata');

    // new CronJob('0 16 9 * * 1-5', async function () {
    //   let bn_quote;
    //   let checkQuote_attempt = 10;
    //   do {
    //     try {
    //       checkQuote_attempt--;
    //       bn_quote = await zapi.getQoute(futureToken);
    //       if (Math.abs(bn_quote.last_price - bn_quote.ohlc.close) > 150) {
    //         notify(strategyTag + ': Gap Day.', channelId);
    //         skipTrades = 2;
    //       }
    //     } catch (err) {
    //       await zapi.login();
    //     }
    //   } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
    // }, null, true, 'Asia/Kolkata');

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
      sellOptionType = max_pain < bn_quote.last_price ? 'PE' : 'CE';
      max_pain_strike = currentExpiryOptions[max_pain + sellOptionType];
      // console.log(sellOptionType, max_pain_strike);
      toDate = new Date();
      fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30);
      check();
      new CronJob('0 */3 * * * 1-5', check, null, true, 'Asia/Kolkata');
    }, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let openInstrument = false,
  running_PNL;
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
        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        // console.log(openInstrument);
        if (currentPosition) {
          if (currentCandle.supertrend < currentCandle.close && currentPosition == 'ENTERED') {
            if (skipTrades > 0) {
              skipTrades -= 1;
            } else await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, openInstrument, 'SELL');
            notify(strategyTag + ': SELL ' + openInstrument.tradingsymbol, channelId);
            currentPosition = 'EXITED';
            openInstrument = false;
          }

          if (currentCandle.supertrend > currentCandle.close && currentPosition == 'EXITED') {
            if (sellOptionType == 'CE') {
              openInstrument = currentExpiryOptions[Math.floor(bn_quote.last_price / 100) * 100 + 'PE'];
            } else {
              openInstrument = currentExpiryOptions[Math.ceil(bn_quote.last_price / 100) * 100 + 'CE'];
            }

            if (skipTrades > 0) {
              skipTrades -= 1;
            } else await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, openInstrument, 'BUY');
            notify(strategyTag + ': BUY ' + openInstrument.tradingsymbol, channelId);
            currentPosition = 'ENTERED';
          }
        } else {
          if (sellOptionType == 'CE') {
            openInstrument = currentExpiryOptions[Math.floor(bn_quote.last_price / 100) * 100 + 'PE'];
          } else {
            openInstrument = currentExpiryOptions[Math.ceil(bn_quote.last_price / 100) * 100 + 'CE'];
          }

          if (currentCandle.supertrend > currentCandle.close) {
            if (skipTrades > 0) {
              skipTrades -= 1;
            } else await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, openInstrument, 'BUY');
            notify(strategyTag + ': BUY ' + openInstrument.tradingsymbol, channelId);
            currentPosition = 'ENTERED';
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
new CronJob('0 13 9 * * 1,2,3,5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1,2,3,5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
