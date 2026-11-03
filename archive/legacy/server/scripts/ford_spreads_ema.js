const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const EMA = require('../lib/indicators/ema.js');
const PaperTrade = app.models.PaperTrade;
const StrategyPNL = app.models.strategyPNL;
let moment = require('moment');


// Strategy Config
let channelId = 0;
let strategyTag = 'Spreads';

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

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    ticker([futureToken]);
    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let currentPosition = false,
  instrument_CE, instrument_PE,
  instrument_CE_2, instrument_PE_2,
  currentDirection, trade1, trade2;
async function check() {
  if (strategy_running) {
    let bn_quote;
    let checkQuote_attempt = 10;
    do {
      try {
        checkQuote_attempt--;
        bn_quote = ticksCache[futureToken];

        if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {

          let upper_strike = (Math.round(bn_quote.last_price / 100) * 100) - 400;
          let upper_strike_2 = (Math.round(bn_quote.last_price / 100) * 100) + 400;
          let lower_strike = (Math.round(bn_quote.last_price / 100) * 100) + 400;
          let lower_strike_2 = (Math.round(bn_quote.last_price / 100) * 100) - 400;
          upper_strike = currentExpiryOptions[upper_strike + "CE"];
          upper_strike_2 = currentExpiryOptions[upper_strike_2 + "CE"];
          lower_strike = currentExpiryOptions[lower_strike + "PE"];
          lower_strike_2 = currentExpiryOptions[lower_strike_2 + "PE"];

          if (currentPosition) {
            upper_strike = instrument_CE;
            upper_strike_2 = instrument_CE_2;
            lower_strike = instrument_PE;
            lower_strike_2 = instrument_PE_2;
          }
          console.log(
            upper_strike.strike + upper_strike.instrument_type,
            upper_strike_2.strike + upper_strike_2.instrument_type,
            lower_strike.strike + lower_strike.instrument_type,
            lower_strike_2.strike + lower_strike_2.instrument_type);

          let candleData = await zapi.historyData(upper_strike.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          let candleData2 = await zapi.historyData(lower_strike.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          let candleData3 = await zapi.historyData(upper_strike_2.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          let candleData4 = await zapi.historyData(lower_strike_2.instrument_token, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));

          console.log(candleData.slice(-1), candleData2.slice(-1), candleData3.slice(-1), candleData4.slice(-1));
          let candleLength_1 = candleData.length < candleData3.length ? candleData.length - 1 : candleData3.length - 1;
          let idx1 = candleData.length - 1;
          let idx2 = candleData3.length - 1;

          let candleData_ce = [];
          for (let i = candleLength_1; i > -1; i--, idx1--, idx2--) {
            let bar = {
              ts1: candleData[idx1].ts,
              ts2: candleData3[idx2].ts,
              high: candleData[idx1].close - candleData3[idx2].close,
              low: candleData[idx1].close - candleData3[idx2].close,
              close: candleData[idx1].close - candleData3[idx2].close,
            }
            candleData_ce.unshift(bar);
          }

          let candleLength_2 = candleData2.length < candleData4.length ? candleData2.length - 1 : candleData4.length - 1;
          let idx3 = candleData2.length - 1;
          let idx4 = candleData4.length - 1;

          let candleData_pe = [];
          for (let i = candleLength_2; i > -1; i--, idx3--, idx4--) {
            let bar = {
              ts1: candleData2[idx3].ts,
              ts2: candleData4[idx4].ts,
              high: candleData2[idx3].close - candleData4[idx4].close,
              low: candleData2[idx3].close - candleData4[idx4].close,
              close: candleData2[idx3].close - candleData4[idx4].close,
            }
            candleData_pe.unshift(bar);
          }

          candleData_pe = await EMA(candleData_pe, 21, 'close', 'ema');
          let currentCandle_pe = candleData_pe.slice(-1)[0];

          candleData_ce = await EMA(candleData_ce, 21, 'close', 'ema');
          let currentCandle_ce = candleData_ce.slice(-1)[0];

          console.log('CE', candleData_ce.slice(-1));
          console.log('PE', candleData_pe.slice(-1));

          let callSignal = currentCandle_ce.ema < currentCandle_ce.close;
          let putSignal = currentCandle_pe.ema < currentCandle_pe.close;

          let newDirection;
          if (callSignal && putSignal) {
            newDirection = 'no_trade';
          } else if (!callSignal && putSignal) {
            newDirection = 'call_buy';
          } else if (callSignal && !putSignal) {
            newDirection = 'put_buy';
          } else if (!callSignal && !putSignal) {
            newDirection = 'no_trade';
          }

          console.log(moment().utc().add(330, 'minutes').format('HH:mm'), bn_quote.last_price, newDirection);

          if (!currentPosition && newDirection != 'no_trade') {
            instrument_CE = upper_strike;
            instrument_CE_2 = upper_strike_2;
            instrument_PE = lower_strike;
            instrument_PE_2 = lower_strike_2;
            currentPosition = true;

            if (newDirection == 'call_buy') {
              let strike1 = (Math.round(bn_quote.last_price / 100) * 100) - 400;
              let strike2 = (Math.round(bn_quote.last_price / 100) * 100) + 400;
              trade1 = currentExpiryOptions[strike1 + "CE"];
              trade2 = currentExpiryOptions[strike2 + "CE"];
            } else if (newDirection == 'put_buy') {
              let strike1 = (Math.round(bn_quote.last_price / 100) * 100) + 400;
              let strike2 = (Math.round(bn_quote.last_price / 100) * 100) - 400;
              trade1 = currentExpiryOptions[strike1 + "PE"];
              trade2 = currentExpiryOptions[strike2 + "PE"];
            }

            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, trade2, 'BUY');
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, trade1, 'SELL');
            currentDirection = newDirection;
          } else if (currentPosition && currentDirection != newDirection) {
            currentPosition = false;
            currentDirection = newDirection;
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, trade1, 'BUY');
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, trade2, 'SELL');
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
