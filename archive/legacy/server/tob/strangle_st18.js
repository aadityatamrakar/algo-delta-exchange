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
const getLoss = (entry, current) => (entry - current) * -1;
const price_ratio = (price1, price2) => Math.round((price1 / (price1 + price2)) * 100);

// Strategy Config
let channelId = 0;
let strategyTag = 'AudiPC-800';

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

  checkSL();
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
  final_running = true,
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
    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */3 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let currentPosition = false,
  currentDirection = false,
  maxTrades = 3,
  takePositions = true,
  instrument_CE, instrument_PE, entry_price, stoploss_price, target_price = 0;
async function check() {
  if (strategy_running && final_running) {
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

          if (currentDirection) {
            upper_strike = instrument_CE;
            lower_strike = instrument_PE;
          }

          let candleData = await zapi.historyData(upper_strike.instrument_token, '3minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          let candleData2 = await zapi.historyData(lower_strike.instrument_token, '3minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));

          let candleLength = candleData.length < candleData2.length ? candleData.length - 1 : candleData2.length - 1;
          let idx1 = candleData.length - 1;
          let idx2 = candleData2.length - 1;

          let candleData3 = [];
          for (let i = candleLength; i > -1; i--, idx1--, idx2--) {
            let bar = {
              ts1: candleData[idx1].ts,
              ts2: candleData2[idx2].ts,
              high: candleData[idx1].close + candleData2[idx2].close,
              low: candleData[idx1].close + candleData2[idx2].close,
              close: candleData[idx1].close + candleData2[idx2].close,
            }
            candleData3.unshift(bar);
          }

          candleData3 = await Supertrend(candleData3, 14, 5);
          let currentCandle = candleData3.slice(-1)[0];

          console.log(candleData3.slice(-1));
          console.log(moment().format('HH:mm'), lower_strike.strike, bn_quote.last_price, currentCandle.supertrend, currentCandle.close);

          if (!currentDirection && currentCandle.supertrend > currentCandle.close) {
            console.log('new direction');
            instrument_CE = upper_strike;
            instrument_PE = lower_strike;
            currentDirection = true;

            if (takePositions) {
              entry_price = parseInt(ticksCache[instrument_PE.instrument_token].last_price + ticksCache[instrument_CE.instrument_token].last_price);
              stoploss_price = entry_price + 30;
              currentPosition = true;
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'SELL');
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'SELL');
            }
          } else if (currentDirection && currentCandle.supertrend < currentCandle.close) {
            currentDirection = false;
            console.log('close direction');
            if (currentPosition) {
              currentPosition = false;

              let positionPnl = ticksCache[instrument_PE.instrument_token].last_price + ticksCache[instrument_CE.instrument_token].last_price;
              total_loss += getLoss(entry_price, positionPnl);
              console.log('total_loss: ' + total_loss, positionPnl, entry_price);

              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
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

let total_loss = 0;
let max_stoploss = 80;
let per_strangle_profit = 32;
let checkSLPrice = true;
async function checkSL() {
  if (currentPosition) {
    let positionPnl = Math.round(ticksCache[instrument_PE.instrument_token].last_price + ticksCache[instrument_CE.instrument_token].last_price);
    let currentLoss = getLoss(entry_price, positionPnl);
    let target_price = Math.round(entry_price - per_strangle_profit);

    let ce_price = ticksCache[instrument_CE.instrument_token].last_price;
    let pe_price = ticksCache[instrument_PE.instrument_token].last_price;
    let ratio = price_ratio(ce_price, pe_price);

    if (ratio >= 90 || ratio <= 10) {
      console.log('closed 90/10');
      console.log(`max stoploss: ${max_stoploss}\ntotal loss: ${total_loss}\nposition PNL: ${positionPnl}\nCurrent Loss: ${currentLoss}\nentry price: ${entry_price}\ntarget price: ${target_price}`);
      currentPosition = false;
      checkSLPrice = false;
      total_loss += currentLoss;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
    } else if (checkSLPrice && positionPnl <= target_price) {
      console.log('closed tgt');
      console.log(`max stoploss: ${max_stoploss}\ntotal loss: ${total_loss}\nposition PNL: ${positionPnl}\nCurrent Loss: ${currentLoss}\nentry price: ${entry_price}\ntarget price: ${target_price}`);
      currentPosition = false;
      checkSLPrice = false;
      total_loss += currentLoss;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
    } else if (checkSLPrice && positionPnl >= stoploss_price) {
      console.log('closed SL');
      console.log(`max stoploss: ${max_stoploss}\ntotal loss: ${total_loss}\nposition PNL: ${positionPnl}\nCurrent Loss: ${currentLoss}\nentry price: ${entry_price}\ntarget price: ${target_price}`);
      currentPosition = false;
      checkSLPrice = false;
      total_loss += currentLoss;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
    } else if (max_stoploss <= (total_loss + currentLoss)) {
      console.log('closed max sl');
      console.log(`max stoploss: ${max_stoploss}\ntotal loss: ${total_loss}\nposition PNL: ${positionPnl}\nCurrent Loss: ${currentLoss}\nentry price: ${entry_price}\ntarget price: ${target_price}`);
      currentPosition = false;
      takePositions = false;
      total_loss += currentLoss;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
    }
  }
}

runStrategy();
// new CronJob('30 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('30 59 14 * * 1-5', async function () {
  final_running = false;
  strategy_running = false;
}, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', async function () {
  final_running = false;
  strategy_running = false;

  if (currentPosition) {
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_CE, 'BUY');
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument_PE, 'BUY');
  }
}, null, true, 'Asia/Kolkata');
// new CronJob('0 24 15 * * 1-5', function () {
//   process.exit();
// }, null, true, 'Asia/Kolkata');

