const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const Supertrend = require('../lib/indicators/atr.js');
const PaperTrade = app.models.PaperTrade;
const StrategyPNL = app.models.strategyPNL;

// Strategy Config
let channelId = 0;
let strategyTag = 'Pi';

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

let positions = {
  accounts: []
};
async function checkPNL() {
  try {
    positions.accounts.forEach(async function (account, idx) {
      if (account.accountId == 'Pi' && strategy_running) {
        let total_m2m = 0;
        positions.accounts[idx].positions.forEach(function (position) {
          if (ticksCache[position.instrument_token]) {
            if (position.quantity > 0) {
              position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price)) - (position.buy_price * position.buy_quantity);
            } else if (position.quantity < 0) {
              position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price));
            }
          }
          total_m2m += position.m2m;
        });
        positions.accounts[idx].total = total_m2m;
        positions.accounts[idx].totalAbs = Math.abs(positions.accounts[idx].total);
        // console.log(total_m2m);
        if (total_m2m < -2500) {
          strategy_running = false;
          notify(strategyTag + ': SL HIT', channelId);
          console.log(position_CE, position_PE);
          console.log(instrument_CE, instrument_PE);
          if (position_CE == 'ENTERED') Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
          if (position_PE == 'ENTERED') Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
        }
      }
    });
  } catch (err) {
    console.log(err);
  }
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
    connected = true;
  });
}
let alreadySubscribed = [];
async function subs(subscribeInstruments) {
  do {
    if (connected) {
      subscribeInstruments = Array.from(new Set(subscribeInstruments));
      subscribeInstruments = subscribeInstruments.filter(c => alreadySubscribed.indexOf(c) == -1);
      if (subscribeInstruments.length > 0) {
        console.log('subscribing', subscribeInstruments);
        liveFeed.subscribe(subscribeInstruments);
        liveFeed.setMode(liveFeed.modeFull, subscribeInstruments);
        alreadySubscribed.push(...subscribeInstruments);
        subscribeInstruments = [];
      }
    }
  } while (subscribeInstruments.length != 0);
}
let ticksCache = {};
async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);
  // checkPNL();
}

async function fetchPositions() {
  PaperTrade.positions(function (err, resp) {
    positions = resp;
    let order_tokens = Object.values(resp.orders).reduce((allTokens, orders) => {
      let tmp = orders.reduce((tokens, order) => {
        tokens.push(order.instrument_token);
        return tokens;
      }, []);
      allTokens.push(...tmp);
      return allTokens;
    }, []);

    subs(order_tokens);
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
  strategy_running = true;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker();
    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    // check();
    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    // new CronJob('30 * * * * 1-5', fetchPositions, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let position_CE = 'EXITED',
  position_PE = 'EXITED',
  instrument_CE, instrument_PE;
async function check() {
  if (strategy_running) {
    let bn_quote;
    let checkQuote_attempt = 10;
    do {
      try {
        checkQuote_attempt--;
        bn_quote = await zapi.getQoute(futureToken);

        if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {

          let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
          let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);
          upper_strike = currentExpiryOptions[upper_strike + "CE"];
          lower_strike = currentExpiryOptions[lower_strike + "PE"];

          if (position_CE == 'ENTERED') upper_strike = instrument_CE;
          if (position_PE == 'ENTERED') lower_strike = instrument_PE;

          let candleData = await zapi.historyData(upper_strike.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          candleData = await Supertrend(candleData, 14, 1.5);
          let currentCandle_CE = candleData.slice(-1)[0];

          let candleData2 = await zapi.historyData(lower_strike.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          candleData2 = await Supertrend(candleData2, 14, 1.5);
          let currentCandle_PE = candleData2.slice(-1)[0];

          if (currentCandle_CE.supertrend < currentCandle_CE.close && position_CE == 'ENTERED') {
            // strategyTag, account_quantities, running_accounts, optionInstrument, orderType
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
            position_CE = 'EXITED';
            // setTimeout(fetchPositions, 1500);
          } else if (currentCandle_CE.supertrend > currentCandle_CE.close && position_CE == 'EXITED') {
            instrument_CE = upper_strike;
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'SELL');
            position_CE = 'ENTERED';
            subs([instrument_CE.instrument_token]);
            // setTimeout(fetchPositions, 1500);
          }

          if (currentCandle_PE.supertrend < currentCandle_PE.close && position_PE == 'ENTERED') {
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
            position_PE = 'EXITED';
            // setTimeout(fetchPositions, 1500);
          } else if (currentCandle_PE.supertrend > currentCandle_PE.close && position_PE == 'EXITED') {
            instrument_PE = lower_strike;
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'SELL');
            position_PE = 'ENTERED';
            subs([instrument_PE.instrument_token]);
            // setTimeout(fetchPositions, 1500);
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
new CronJob('30 15 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  strategy_running = false;
}, null, true, 'Asia/Kolkata');
new CronJob('0 31 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
