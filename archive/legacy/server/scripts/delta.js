const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
let async = require('async');
let moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'Delta';

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
    console.log('Subscribing: ', subs.length);
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
  indexToken, futureToken,
  futureSymbol, timestamp;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    futureSymbol = optionData.currentFuture.symbol;
    indexToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, indexToken, ...optionTokens]);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

async function checkProfit(strike, ATM_CE_tmp, ATM_PE_tmp) {
  let ATM_CE_2_tmp, ATM_PE_2_tmp, case_1;
  diff = 1000;
  index_2 = indexPrice + diff;
  future_2 = futurePrice + diff;
  ATM_CE_2_tmp = strike < index_2 ? strike - index_2 : 0;
  ATM_PE_2_tmp = strike > index_2 ? strike - index_2 : 0;
  case_1 = Math.round((future_2 - futurePrice) + (ATM_CE_2_tmp + ATM_PE_2_tmp) + (ATM_CE_tmp + ATM_PE_tmp));

  if (Math.abs(case_1) > 45) {
    return true;
  } else return false;
}

let futurePrice = 0,
  indexPrice = 0,
  ATM_strike = 0,
  ticksCache = {},
  orderSend = true;

function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);
  if (ticksCache[futureToken]) futurePrice = -1 * ticksCache[futureToken].depth['buy'][0].price;
  else futurePrice = 0;
  if (ticksCache[indexToken]) indexPrice = ticksCache[indexToken].last_price;
  else indexPrice = 0;
  timestamp = moment(ticksCache[futureToken].timestamp, 'X').add(330, 'minutes').format('HH:mm:ss');

  ATM_strike = Math.abs(Math.round(futurePrice / 100) * 100);
  ATM_strike_Down = ATM_strike;
  ATM_strike_UP = ATM_strike;
  let resp = checkProfit(ATM_strike, ticksCache[currentExpiryOptions[ATM_strike + 'CE'].instrument_token].depth['sell'][0].price, -1 * ticksCache[currentExpiryOptions[ATM_strike + 'PE'].instrument_token].depth['buy'][0].price);

  if (resp && orderSend) {
    orderSend = false;
    sendOrder([
      [currentExpiryOptions[ATM_strike + 'CE'], 'BUY'],
      [{
        tradingsymbol: futureSymbol,
        lot_size: 25
      }, 'SELL'],
      [currentExpiryOptions[ATM_strike + 'PE'], 'SELL']
    ]);
  }
}

async function sendOrder(orders) {
  async.map(orders, function (order, cb) {
    Account.placeAllAccountNrml(strategyTag, account_quantities, running_accounts, order[0], order[1]).then(cb);
  }, function (err, resp) {
    console.log(err, resp);
    notify(strategyTag + ': Orders Sent!', channelId);
  });
}

// runStrategy();
new CronJob('0 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
