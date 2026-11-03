const CronJob = require("cron").CronJob;
const async = require('async');
const moment = require('moment');
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Supertrend = require('../lib/indicators/atr.js');
const Account = app.models.account;
const StrategyData = app.models.strategyData;
const Positional = app.models.positional;
const PositionalReport = require('../lib/positionalReport.js');
const kiteTicker = require('../lib/KiteTicker');
let strategyId = "6280a22ca1d62fe92e775598";
const futureConfig = require('../tools/futureInstruments');

const notify = require("../lib/notify.js");
let channelId = 0;
let strategyTag = 'TWS';

let zapi, public_token;
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

let futureToken, currentExpiryOptions = {},
  toDate, fromDate, instruments, tradeInstrument, expiryDate;

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

async function runStrategy() {
  try {
    let optionData = await futureConfig();
    tradeInstrument = optionData['BANKNIFTY'];
    futureToken = tradeInstrument.instrument_token;
    expiryDate = tradeInstrument.expiry;

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken]);

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

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
  checkBreakout();
}

async function checkBreakout() {
  if (orderTrigger) {
    if (triggerDirection == 'BUY') {
      if (ticksCache[futureToken].last_price > triggerPrice) {
        orderTrigger = false;
        triggerPrice = null;
        triggerDirection = null;
        await openPosition('BUY');
      }
    } else if (triggerDirection == 'SELL') {
      if (ticksCache[futureToken].last_price < triggerPrice) {
        orderTrigger = false;
        triggerPrice = null;
        triggerDirection = null;
        await openPosition('SELL');
      }
    }
  }
}

let orderTrigger = false, triggerPrice, triggerDirection;
async function check() {
  let bn_quote;
  let checkQuote_attempt = 10;
  let strategyConfig = await StrategyData.findById(strategyId);
  // console.log(strategyConfig);
  if (!strategyConfig.currentPosition) strategyConfig.currentPosition = 'NONE';
  do {
    try {
      checkQuote_attempt--;
      bn_quote = await zapi.getQoute(futureToken);
      // console.log(bn_quote);
      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        console.time('candlestick_req');
        let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        console.timeEnd('candlestick_req');
        // console.log(candleData);
        candleData = await Supertrend(candleData, 20, 3);
        // console.log(max_pain_strike.tradingsymbol);
        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        let strategyConfig = await StrategyData.findById(strategyId);

        if (currentCandle.supertrend < currentCandle.close) {
          if (strategyConfig.currentPosition != 'LONG' && triggerDirection != 'BUY') {
            console.log('buy trg');
            triggerPrice = currentCandle.high;
            triggerDirection = 'BUY';
            orderTrigger = true;
          } else if (triggerDirection == 'SELL') {
            orderTrigger = false;
            triggerPrice = null;
            triggerDirection = null;
          }
        } else if (currentCandle.supertrend > currentCandle.close) {
          if (strategyConfig.currentPosition != 'SHORT' && triggerDirection != 'SELL') {
            console.log('sell trg');
            triggerPrice = currentCandle.low;
            triggerDirection = 'SELL';
            orderTrigger = true;
          } else if (triggerDirection == 'BUY') {
            orderTrigger = false;
            triggerPrice = null;
            triggerDirection = null;
          }
        }
        console.log(moment().format('HH:mm'), triggerPrice, currentCandle.low, currentCandle.high, triggerDirection);
      }
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

async function openPosition(direction) {
  let strategyConfig = await StrategyData.findById(strategyId);
  notify('TWS: ' + direction, channelId);
  if (strategyConfig.positions) await closePositions(strategyConfig.positions, true);
  else {
    Account.placeAllAccountNrml(strategyTag, account_quantities, running_accounts, tradeInstrument, direction);
    await Positional.trackOrder(tradeInstrument, direction, strategyTag, 1);
  }
  strategyConfig.positions = {
    BUY: false,
    SELL: false
  };
  strategyConfig.positions[direction] = tradeInstrument;
  strategyConfig.currentPosition = direction == 'BUY' ? 'LONG' : 'SHORT';
  await strategyConfig.save();
}

async function closePositions(positions, reverse = false) {
  console.log(positions);
  if (positions.BUY) {
    console.log(moment().format('HH:mm'), 'closing buy');
    Positional.trackOrder(positions.BUY, 'SELL', strategyTag, reverse ? 2 : 1);
    Account.placeAllAccountNrml(strategyTag, account_quantities, running_accounts, positions.BUY, 'SELL', reverse ? 2 : 1);
  }
  if (positions.SELL) {
    console.log(moment().format('HH:mm'), 'closing sell');
    Positional.trackOrder(positions.SELL, 'BUY', strategyTag, reverse ? 2 : 1);
    Account.placeAllAccountNrml(strategyTag, account_quantities, running_accounts, positions.SELL, 'BUY', reverse ? 2 : 1);
  }
}

// runStrategy();
new CronJob('0 19 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 20 15 * * 1-5', async function () {
  if (expiryDate == moment().format('YYYY-MM-DD')) {
    let strategyConfig = await StrategyData.findById(strategyId);
    await closePositions(strategyConfig.positions);
    try {
      if (strategyConfig.positions.BUY) {
        await PositionalReport(strategyConfig.positions.BUY.tradingsymbol, strategyTag);
      } else if (strategyConfig.positions.SELL) {
        await PositionalReport(strategyConfig.positions.SELL.tradingsymbol, strategyTag);
      }
    } catch (err) {
      console.log(err);
    }
    strategyConfig.positions = {};
    strategyConfig.currentPosition = 'NONE';
    await strategyConfig.save();
    setTimeout(function () {
      process.exit();
    }, 5000);  
  }
}, null, true, 'Asia/Kolkata');