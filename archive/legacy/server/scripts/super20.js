const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const Papertrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');

// Strategy Config
let channelId = 0;
let strategyTag = 'Super20';

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

let futureToken, currentExpiryOptions = {};
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

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');

    // monday
    new CronJob('58 16 9 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 21 9 * * 1', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 26 9 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 31 9 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 6 10 * * 1', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 46 10 * * 1', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 56 10 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 1 11 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 6 11 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 31 11 * * 1', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 36 11 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 46 11 * * 1', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 51 11 * * 1', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 11 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 16 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 21 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 26 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 41 12 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 46 12 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 56 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');

    // tuesday
    new CronJob('58 16 9 * * 2', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 21 9 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 26 9 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 31 9 * * 2', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 36 9 * * 2', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 41 9 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 51 9 * * 2', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 11 10 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 16 10 * * 2', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 36 10 * * 2', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 46 10 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 51 10 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 56 10 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 1 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 31 11 * * 2', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 41 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 51 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 56 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 1 12 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 6 12 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');

    // wednesday
    new CronJob('58 16 9 * * 3', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 21 9 * * 3', () => takeTrade(1.8), null, true, 'Asia/Kolkata');
    new CronJob('58 26 9 * * 3', () => takeTrade(1.8), null, true, 'Asia/Kolkata');
    new CronJob('58 31 9 * * 3', () => takeTrade(1.8), null, true, 'Asia/Kolkata');
    new CronJob('58 36 9 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 41 9 * * 3', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 56 9 * * 3', () => takeTrade(2), null, true, 'Asia/Kolkata');
    new CronJob('58 1 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 6 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 16 10 * * 3', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 21 10 * * 3', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 26 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 31 10 * * 3', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 46 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 51 10 * * 3', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 1 11 * * 3', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 41 11 * * 3', () => takeTrade(2), null, true, 'Asia/Kolkata');
    new CronJob('58 11 12 * * 3', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 21 12 * * 3', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 46 12 * * 3', () => takeTrade(1.7), null, true, 'Asia/Kolkata');

    // thursday
    new CronJob('0 56 10 * * 4', () => buyHedge("BUY"), null, true, 'Asia/Kolkata');
    new CronJob('58 16 9 * * 4', () => takeTrade(1.9, true), null, true, 'Asia/Kolkata');
    new CronJob('58 21 9 * * 4', () => takeTrade(1.1, true), null, true, 'Asia/Kolkata');
    new CronJob('58 31 9 * * 4', () => takeTrade(1.4, true), null, true, 'Asia/Kolkata');
    new CronJob('58 41 9 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 46 9 * * 4', () => takeTrade(1.2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 51 9 * * 4', () => takeTrade(1.9, true), null, true, 'Asia/Kolkata');
    new CronJob('58 56 9 * * 4', () => takeTrade(1.5, true), null, true, 'Asia/Kolkata');
    new CronJob('58 1 10 * * 4', () => takeTrade(1.3, true), null, true, 'Asia/Kolkata');
    new CronJob('58 6 10 * * 4', () => takeTrade(1.3, true), null, true, 'Asia/Kolkata');
    new CronJob('58 11 10 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 1 11 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 6 11 * * 4', () => takeTrade(1.3, true), null, true, 'Asia/Kolkata');
    new CronJob('58 11 11 * * 4', () => takeTrade(1.2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 16 11 * * 4', () => takeTrade(1.2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 31 11 * * 4', () => takeTrade(1.1, true), null, true, 'Asia/Kolkata');
    new CronJob('58 06 12 * * 4', () => takeTrade(1.8, true), null, true, 'Asia/Kolkata');
    new CronJob('58 11 12 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 21 12 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 26 12 * * 4', () => takeTrade(1.7, true), null, true, 'Asia/Kolkata');
    new CronJob('58 51 12 * * 4', () => takeTrade(1.7, true), null, true, 'Asia/Kolkata');

    // friday
    new CronJob('58 21 9 * * 5', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 26 9 * * 5', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 31 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 36 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 46 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 51 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 06 10 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 11 10 * * 5', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 41 10 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 06 11 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 16 11 * * 5', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 21 11 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 26 11 * * 5', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 31 11 * * 5', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 46 11 * * 5', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 06 12 * * 5', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 11 12 * * 5', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 21 12 * * 5', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 36 12 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 1 13 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');

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

  checkSLQ.push({
    check: 1
  });
}

async function buyHedge(orderType = 'BUY') {
  let bn_quote = ticksCache[futureToken];
  let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
  hedge_ce = currentExpiryOptions[(atm_strike + 2000) + 'CE'];
  hedge_pe = currentExpiryOptions[(atm_strike - 2000) + 'PE'];
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, hedge_ce, orderType, 40);
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, hedge_pe, orderType, 40);
}

// let SL_percent = 1.3;
async function takeTrade(SL_percent, hedge = false) {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    let CE_opt = currentExpiryOptions[atm_strike + 'CE'];
    let PE_opt = currentExpiryOptions[atm_strike + 'PE'];

    let CE_Entry = ticksCache[CE_opt.instrument_token].last_price;
    let PE_Entry = ticksCache[PE_opt.instrument_token].last_price;
    let CE_SL = CE_Entry * SL_percent;
    let PE_SL = PE_Entry * SL_percent;
    // Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL');
    // Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL');

    let hedge_ce = false,
      hedge_pe = false;
    if (hedge) {
      hedge_ce = currentExpiryOptions[(atm_strike + 2000) + 'CE'];
      hedge_pe = currentExpiryOptions[(atm_strike - 2000) + 'PE'];
      // Account.placeAllAccount(strategyTag, account_quantities, running_accounts, hedge_ce, 'BUY', 2);
      // Account.placeAllAccount(strategyTag, account_quantities, running_accounts, hedge_pe, 'BUY', 2);

      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL', 2);
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL', 2);
    } else {
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL');
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL');
    }

    optionOrders.push({
      CE_SL: CE_SL,
      PE_SL: PE_SL,
      CE_Entry: CE_Entry,
      PE_Entry: PE_Entry,
      CE_opt: CE_opt,
      PE_opt: PE_opt,
      CE_token: CE_opt.instrument_token,
      PE_token: PE_opt.instrument_token,
      hedge_ce: hedge_ce,
      hedge_pe: hedge_pe
    })
  }
}

let optionOrders = [];
async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    if (position.CE_SL && ticksCache[position.CE_token].last_price > position.CE_SL) {
      position.CE_SL = false;
      if (position.hedge_ce) {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.CE_opt, 'BUY', 2);
        // Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.hedge_ce, 'SELL', 2);
      } else {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.CE_opt, 'BUY');
      }
    }
    if (position.PE_SL && ticksCache[position.PE_token].last_price > position.PE_SL) {
      position.PE_SL = false;
      if (position.hedge_pe) {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.PE_opt, 'BUY', 2);
        // Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.hedge_pe, 'SELL', 2);
      } else {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.PE_opt, 'BUY');
      }
    }
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

function squareoff() {
  Papertrade.positions(function (err, data) {
    let strategy = 'Super20';
    data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0)).reverse();
    data.positions[strategy].forEach(async (order) => {
      let strike = order.tradingsymbol.slice(-7);
      if (currentExpiryOptions[strike]) {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[strike], (order.quantity > 0 ? 'SELL' : 'BUY'), (Math.abs(order.quantity) / 25));
      }
    });
  });

}

// runStrategy();
// setTimeout(squareoff, 5000);
new CronJob('0 9 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 23 15 * * 4', function () {
  squareoff();
  setTimeout(function () {
    process.exit();
  }, 20000);
}, null, true, 'Asia/Kolkata');
new CronJob('0 58 14 * * 1,2,3,5', function () {
  squareoff();
  setTimeout(function () {
    process.exit();
  }, 20000);
}, null, true, 'Asia/Kolkata');
