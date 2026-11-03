const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const COG = require('../lib/indicators/cog.js');
const Awesome = require('../lib/indicators/ao.js');

// Strategy Config
let channelId = 0;
let strategyTag = 'Tradetron';
let strategyToken = "3f7e819f-f37a-4af9-ad77-5c65cf5de12b";
// tradetron request

const request = require('request');

async function orderApi(key, strike, entry, exit) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'POST',
      'url': 'https://api.tradetron.tech/api',
      keepAlive: true,
      json: true,
      body: {
        "auth-token": strategyToken,
        "key": key + "_STRIKE",
        "value": strike,
        "key1": key + "_ENTRY",
        "value1": entry,
        "key2": key + "_EXIT",
        "value2": exit
      }
    };
    request(options, function (error, response) {
      if (error) {
        resolve({
          status: false,
          error: error
        });
      }

      resolve({
        status: true
      });
    });
  })
}


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
async function ticker() {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
  });
}

let currentPosition_LTP, currentPosition_SL, currentPosition_Tgt, running_PNL = 0;
async function trackPosition(token) {
  let checkQuote_attempt = 10;
  let position_tick;
  do {
    try {
      liveFeed.subscribe([token]);
      liveFeed.setMode(liveFeed.modeFull, [token]);

      position_tick = await zapi.getQoute(token);
      currentPosition_LTP = position_tick.last_price;
      currentPosition_SL = position_tick.last_price - (135 + running_PNL);
      currentPosition_Tgt = position_tick.last_price + (124 - running_PNL);
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  }
  while (typeof position_tick != 'object' && checkQuote_attempt > 0);
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

    // await getAccounts();
    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);
    ticker();

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    // new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', checkTesla, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', checkAWS, null, true, 'Asia/Kolkata');
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
  if (currentPosition) {
    ticks.forEach(async tick => {
      if (tick.instrument_token == currentPosition.instrument_token) {
        // current position tick
        let currentSqfPosition = currentPosition;
        if (tick.last_price < currentPosition_SL) {
          currentPosition = false;
          strategy_running = false;
          Spider_running = true;
          notify(strategyTag + ': Starting Selling Strategy', channelId);
          checkTesla();
        }
        if (tick.last_price > currentPosition_Tgt) {
          currentPosition = false;
          strategy_running = false;
          notify(strategyTag + ': Starting Buying Strategy', channelId);
          AWS_running = true;
          checkAWS();
        }
      }
    })
  }
}


let Spider_running = false,
  currentDirection_GCP, currentPosition_GCP;
async function checkTesla() {

  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = await zapi.getQoute(futureToken);

      if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
        let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
        candleData = await COG(candleData, 0.0004, 15, 14, 3);
        candleData = await Awesome(candleData);

        let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
        let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

        currentCandle = candleData.slice(-1)[0];
        lastCandle = candleData.slice(-2)[0];

        let newDirectionGCP = false,
          newPositionGCP = false;
        let newDirectionTesla = false,
          newPositionTesla = false;

        console.log(currentCandle.ts, currentDirection_GCP, currentDirection);

        if (Spider_running) {
          if (currentCandle.ao < lastCandle.ao && currentDirection_GCP != "SHORT") {
            newPositionGCP = currentExpiryOptions[lower_strike + 'PE'];
            newDirectionGCP = 'SHORT';
          }

          if (currentCandle.ao > lastCandle.ao && currentDirection_GCP != "LONG") {
            newPositionGCP = currentExpiryOptions[upper_strike + 'CE'];
            newDirectionGCP = 'LONG';
          }
        }

        if (strategy_running) {
          if (currentDirection != currentCandle.cog_signal) {
            if (currentCandle.cog_signal == 'LONG') {
              newPositionTesla = currentExpiryOptions[upper_strike + 'CE'];
            }
            if (currentCandle.cog_signal == 'SHORT') {
              newPositionTesla = currentExpiryOptions[lower_strike + 'PE'];
            }
            newDirectionTesla = currentCandle.cog_signal;
          }
        }

        console.log(currentCandle.ts, newDirectionGCP, newDirectionTesla);
        if (newDirectionTesla) {
          // Tesla Reverse Order
          if (currentPosition) {
            let position_tick = ticksCache[currentPosition.instrument_token];
            running_PNL = running_PNL + Math.round(position_tick.last_price - currentPosition_LTP);
            notify(strategyTag + ': PNL ' + running_PNL, channelId);
            currentPosition = false;
          }
          currentPosition = newPositionTesla;
          trackPosition(currentPosition.instrument_token);
          currentDirection = newDirectionTesla;
        }

        if (newDirectionGCP) {
          // Spider Reverse Order
          if (currentPosition_GCP) {
            await orderApi(currentPosition_GCP.instrument_type + '_SELL', 0, 0, 1);
            currentPosition_GCP = false;
          }
          currentPosition_GCP = newPositionGCP;
          await orderApi(currentPosition_GCP.instrument_type + '_SELL', currentPosition_GCP.strike, 1, 0);
          currentDirection_GCP = newDirectionGCP;
        }
        console.log(currentCandle.ts, currentDirection_GCP, currentDirection);
      }
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

let AWS_running = false,
  currentDirection_AWS, currentPosition_AWS;
async function checkAWS() {
  if (AWS_running) {
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

          if (currentCandle.ao < lastCandle.ao && currentDirection_AWS != "SHORT") {
            if (currentPosition_AWS) {
              await orderApi(currentPosition_AWS.instrument_type + '_BUY', 0, 0, 1);
            }

            currentPosition_AWS = currentExpiryOptions[lower_strike + 'PE'];
            await orderApi(currentPosition_AWS.instrument_type + '_BUY', currentPosition_AWS.strike, 1, 0);
            currentDirection_AWS = 'SHORT';
          }

          if (currentCandle.ao > lastCandle.ao && currentDirection_AWS != "LONG") {
            if (currentPosition_AWS) {
              await orderApi(currentPosition_AWS.instrument_type + '_BUY', 0, 0, 1);
            }

            currentPosition_AWS = currentExpiryOptions[upper_strike + 'CE'];
            await orderApi(currentPosition_AWS.instrument_type + '_BUY', currentPosition_AWS.strike, 1, 0);
            currentDirection_AWS = 'LONG';
          }
        }
      } catch (err) {
        await zapi.login();
      }
    }
    while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
  }
}

// runStrategy();
new CronJob('0 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
