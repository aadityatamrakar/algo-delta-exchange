const CronJob = require("cron").CronJob;
var async = require('async');
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const notify = require("../lib/notify.js");
let moment = require('moment');

const Tradetron = require('./../lib/tradetron');
const tt_authToken = 'cd5e7bb9-3eec-400b-9f6e-4c27ad059534';
let strategyTag = 'Index';
let channelId = 0;

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

function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  checkSLQ.push({
    check: 1
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


let futureToken, currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
    max_pain = optionData.max_pain;

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 * * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

let lastTrend = 'na',
  currentTrend = 'na';
async function fetchPositions() {
  return new Promise((resolve, reject) => {
    try {
      let removeStrategies = ['S1', 'ST1', 'ITCBUY', 'BBT', 'ITCRT', 'ITC', 'LX1', 'MTM1', 'MTM3', 'MTM5', 'BBT5', 'BBTn5', 'iStraddle', 'LX2', 'LX3', 'LX4', 'STG3', 'STG4', 'Tesla', "Pi", 'MB-2k'];
      PaperTrade.positions(function (err, resp) {
        let positions = resp.positions;
        let total_CE = 0;
        let total_PE = 0;

        removeStrategies.forEach(s => {
          delete positions[s];
        });

        Object.values(positions).forEach(function (strategyPos) {
          Object.values(strategyPos).forEach(function (position) {
            if (position && position.tradingsymbol) {
              if (position.tradingsymbol.substr(-2) == 'CE') total_CE += position.quantity;
              if (position.tradingsymbol.substr(-2) == 'PE') total_PE += position.quantity;
            }
          });
        });

        console.log(Object.keys(positions), Object.values(positions).length, total_CE, total_PE, moment().format('HH:mm'));

        if (total_CE - total_PE > 0) {
          resolve('LONG');
        } else if (total_CE - total_PE < 0) {
          resolve('SHORT');
        } else {
          resolve('na');
        }
      });
    } catch (err) {
      console.log(err);
      resolve('na');
    }
  })
}

async function check() {
  try {
    currentTrend = await fetchPositions();
    let bn_quote = ticksCache[futureToken];
    let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);
    let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);

    if (currentTrend == 'LONG' && currentTrend != lastTrend) {
      if (currentPosition) {
        openOrder = false;
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
      }

      currentPosition = currentExpiryOptions[lower_strike + 'PE'];
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
      openOrder = {
        token: currentPosition.instrument_token,
        entry: ticksCache[currentPosition.instrument_token].last_price,
        sl_trigger: ticksCache[currentPosition.instrument_token].last_price + sl_points,
      };
      lastTrend = currentTrend;
    } else if (currentTrend == 'SHORT' && currentTrend != lastTrend) {
      if (currentPosition) {
        openOrder = false;
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
      }

      currentPosition = currentExpiryOptions[upper_strike + 'CE'];
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
      openOrder = {
        token: currentPosition.instrument_token,
        entry: ticksCache[currentPosition.instrument_token].last_price,
        sl_trigger: ticksCache[currentPosition.instrument_token].last_price + sl_points,
      };
      lastTrend = currentTrend;
    }
  } catch (err) {
    console.log(err);
  }
}

let openOrder = false,
  sl_points = 80;
async function checkSL() {
  if (openOrder && ticksCache[openOrder.token].last_price > openOrder.sl_trigger) {
    openOrder = false;
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
    currentPosition = false;
    return false;
  } else return true;
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('0 13 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
