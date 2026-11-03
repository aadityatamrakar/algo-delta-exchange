const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const Supertrend = require('../lib/indicators/atr.js');

// Strategy Config
let channelId = 0;
let strategyTag = 'S2';

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
  callOptions, putOptions;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
    callOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'CE');
    putOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'PE');

    await getAccounts();
    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');

    new CronJob('0 16 9 * * 1-5', function () {
      if (Math.abs(ticksCache[futureToken].last_price - ticksCache[futureToken].ohlc.close) > 150) {
        new CronJob('0 59 9 * * 1-5', function () {
          new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
        }, null, true, 'Asia/Kolkata');
      } else {
        new CronJob('0 29 9 * * 1-5', function () {
          new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
        }, null, true, 'Asia/Kolkata');
      }
    }, null, true, 'Asia/Kolkata');
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
  if (typeof CE_SL == 'number') {
    if (ticksCache[instrument_CE.instrument_token].last_price > CE_SL) {
      CE_SL = false;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
      position_CE = 'EXITED';
      instrument_CE = false;
    }
  }
  if (typeof PE_SL == 'number') {
    if (ticksCache[instrument_PE.instrument_token].last_price > PE_SL) {
      PE_SL = false;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
      position_PE = 'EXITED';
      instrument_PE = false;
    }
  }
}

let CE_SL, PE_SL, position_CE = 'EXITED',
  position_PE = 'EXITED',
  instrument_CE, instrument_PE;
async function check() {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100) + 100;
    let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100) - 100;

    if (position_CE != 'ENTERED') {
      let rCeOpts = callOptions.map(ceOpt => {
          if (ticksCache[ceOpt.instrument_token] && ceOpt.strike >= upper_strike) {
            let tmp = {};
            Object.assign(tmp, ceOpt);
            Object.assign(tmp, ticksCache[ceOpt.instrument_token]);
            return (tmp);
          } else return false;
        })
        .filter(c => c)
        .sort((a, b) => (b.oi - a.oi))
        .slice(0, 5)
        .sort((a, b) => (b.volume - a.volume));

      instrument_CE = rCeOpts[0];
    }
    if (position_PE != 'ENTERED') {
      let rPeOpts = putOptions.map(peOpt => {
          if (ticksCache[peOpt.instrument_token] && peOpt.strike <= lower_strike) {
            let tmp = {};
            Object.assign(tmp, peOpt);
            Object.assign(tmp, ticksCache[peOpt.instrument_token]);
            return (tmp);
          } else return false;
        })
        .filter(c => c)
        .sort((a, b) => (b.oi - a.oi))
        .slice(0, 5)
        .sort((a, b) => (b.volume - a.volume));

      instrument_PE = rPeOpts[0];
    }

    let candleData = await zapi.historyData(instrument_CE.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
    candleData = await Supertrend(candleData, 14, 1.5);
    let currentCandle_CE = candleData.slice(-1)[0];

    let candleData2 = await zapi.historyData(instrument_PE.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
    candleData2 = await Supertrend(candleData2, 14, 1.5);
    let currentCandle_PE = candleData2.slice(-1)[0];

    if (position_CE == 'EXITED' && currentCandle_CE.supertrend > currentCandle_CE.close && ticksCache[instrument_CE.instrument_token].last_price < ticksCache[instrument_CE.instrument_token].average_price) {
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'SELL');
      position_CE = 'ENTERED';
      CE_SL = currentCandle_CE.supertrend;
    } else if (position_CE == 'ENTERED') {
      CE_SL = currentCandle_CE.supertrend;
    }
    if (position_PE == 'EXITED' && currentCandle_PE.supertrend > currentCandle_PE.close && ticksCache[instrument_PE.instrument_token].last_price < ticksCache[instrument_PE.instrument_token].average_price) {
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'SELL');
      position_PE = 'ENTERED';
      PE_SL = currentCandle_PE.supertrend;
    } else if (position_PE == 'ENTERED') {
      PE_SL = currentCandle_PE.supertrend;
    }
  }
}

// runStrategy();
new CronJob('0 15 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 9 15 * * 1-5', async function () {
  if (instrument_CE) {
    CE_SL = false;
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
    position_CE = 'EXITED';
    instrument_CE = false;
  }
  if (instrument_PE) {
    PE_SL = false;
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
    position_PE = 'EXITED';
    instrument_PE = false;
  }

  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
