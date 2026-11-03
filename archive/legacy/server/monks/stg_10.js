const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const COG = require('../lib/indicators/cog.js');
const Awesome = require('../lib/indicators/ao.js');
const moment = require('moment');
const PaperTrade = app.models.PaperTrade;
const StrategyPNL = app.models.strategyPNL;

// Strategy Config
let channelId = 0;
// let strategyTag = 'Chai';
let strategyTag = 'STG10';

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

let liveFeed, connected = false;
async function ticker(subs) {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    connected = true;
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
  currentCandle, strategy_running = true,
  currentDirection, currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken]);

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */3 * * * 1-5', checkTesla, null, true, 'Asia/Kolkata');
    new CronJob('30 * * * * 1-5', fetchPositions, null, true, 'Asia/Kolkata');
    // new CronJob('0 */5 * * * 1-5', checkAWS, null, true, 'Asia/Kolkata');
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
  // checkPNL();
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
let positions = {
  accounts: []
};
async function checkPNL() {
  try {
    positions.accounts.forEach(async function (account, idx) {
      if (account.accountId == strategyTag && strategy_running) {
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

        if (total_m2m < -3750) {
          strategy_running = false;
          notify(strategyTag + ': SL HIT', channelId);
          if (currentPosition) {
            currentPosition = false;
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
          }
        }
      }
    });
  } catch (err) {
    console.log(err);
  }
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

let entryPrice;
async function checkTesla() {
  let bn_quote;
  let checkQuote_attempt = 10;
  if (strategy_running) {
    do {
      try {
        checkQuote_attempt--;
        bn_quote = ticksCache[futureToken];

        if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
          let candleData = await zapi.historyData(futureToken, '3minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
          let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

          let currentTs = moment().subtract(3, 'minute').startOf('minute').utcOffset('+0530').format().substr(0, 19) + '+0530';
          let currentCandleIdx = candleData.findIndex(function (candle) {
            return candle.ts == currentTs;
          });
          currentCandle = candleData[currentCandleIdx];
          lastCandle = candleData[currentCandleIdx - 1];
          console.log(currentTs, currentCandle, lastCandle);

          let newDirection = false,
            newPosition = false;

          if (lastCandle.open < lastCandle.close &&
            currentCandle.open < currentCandle.close &&
            (currentCandle.close - lastCandle.low) > 100 &&
            (currentCandle.close - lastCandle.low) < 150 &&
            currentDirection != "Long") {

            console.log('going long');
            newPosition = currentExpiryOptions[upper_strike + 'PE'];
            newDirection = "Long";
          }

          if (lastCandle.open > lastCandle.close &&
            currentCandle.open > currentCandle.close &&
            (lastCandle.high - currentCandle.close) > 100 &&
            (lastCandle.high - currentCandle.close) < 150 &&
            currentDirection != "Short") {

            console.log('going short');
            newPosition = currentExpiryOptions[lower_strike + 'CE'];
            newDirection = "Short";
          }

          if (currentPosition) {
            if (currentDirection == 'Short' && (currentCandle.open < currentCandle.close)) {
              console.log('Exit Trade');
              await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              // setTimeout(fetchPositions, 1500);
              currentPosition = false;
              currentDirection = 'na';
            } else if (currentDirection == 'Long' && (currentCandle.open > currentCandle.close)) {
              console.log('Exit Trade');
              await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              // setTimeout(fetchPositions, 1500);
              currentPosition = false;
              currentDirection = 'na';
            }
          }

          if (newDirection) {
            if (currentPosition) {
              console.log('New Trade');
              await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
              currentPosition = false;
              currentDirection = 'na';
            }
            currentPosition = newPosition;
            entryPrice = bn_quote.last_price;
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            subs([currentPosition.instrument_token]);
            // setTimeout(fetchPositions, 1500);
            currentDirection = newDirection;
            console.log('New Position', currentDirection, currentPosition);
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
new CronJob('0 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
