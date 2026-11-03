const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const optionConfig = require('../tools/optionInstruments');
const Supertrend = require('../lib/indicators/atr.js');
const PaperTrade = app.models.PaperTrade;
const StrategyPNL = app.models.strategyPNL;
let moment = require('moment');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Strategy Config
let channelId = 0;
let strategyTag = 'STG5';

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

let ticksCache = {};
async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);
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
  strategy_running = true;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;

    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */3 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let currentPosition = false,
  instrument_CE, instrument_PE,
  entry, stoploss, trail;
async function check() {
  if (strategy_running) {
    let bn_quote;
    let checkQuote_attempt = 10;
    do {
      try {
        checkQuote_attempt--;
        bn_quote = ticksCache[futureToken];

        if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
          let upper_strike = (Math.round(bn_quote.last_price / 100) * 100) + 100;
          let lower_strike = (Math.round(bn_quote.last_price / 100) * 100) - 100;
          upper_strike = currentExpiryOptions[upper_strike + "CE"];
          lower_strike = currentExpiryOptions[lower_strike + "PE"];

          if (currentPosition) {
            upper_strike = instrument_CE;
            lower_strike = instrument_PE;
          }

          let price_ce = ticksCache[upper_strike.instrument_token].last_price;
          let price_pe = ticksCache[lower_strike.instrument_token].last_price;
          let combine_premium = Math.round(price_ce + price_pe);

          console.log(moment().format('HH:mm'), lower_strike.strike, bn_quote.last_price);
          console.log(combine_premium, stoploss, entry, trail, currentPosition);

          if (!currentPosition) {
            instrument_CE = upper_strike;
            instrument_PE = lower_strike;
            currentPosition = true;
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'SELL');
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'SELL');
            stoploss = Math.round(combine_premium * 1.1);
            trail = 0;
            entry = combine_premium;
          } else {
            if (combine_premium >= stoploss) {
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
              currentPosition = false;
            } else {
              let n_trail = (entry - combine_premium);
              if (n_trail > trail) {
                stoploss = stoploss - (n_trail - trail);
                trail = n_trail;
              }
            }
          }
        }
      } catch (err) {
        console.log(err);
        await zapi.login();
      }
    } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
  }
}

runStrategy();
// new CronJob('30 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('50 23 15 * * 1-5', async function () {
  strategy_running = false;
}, null, true, 'Asia/Kolkata');
new CronJob('30 30 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');

