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
let strategyTag = 'BBT';

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

let futureToken, currentExpiryOptions = {},
  ce_strike = false,
  pe_strike = false;
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

    new CronJob('0 20 9 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 0 10 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 30 10 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 0 11 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 30 11 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 0 12 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 30 12 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 0 13 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 30 13 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    new CronJob('0 0 14 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
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

let SL_percent = 1.3;
async function takeTrade() {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    let CE_opt = currentExpiryOptions[atm_strike + 'CE'];
    let PE_opt = currentExpiryOptions[atm_strike + 'PE'];

    let CE_Entry = ticksCache[CE_opt.instrument_token].last_price;
    let PE_Entry = ticksCache[PE_opt.instrument_token].last_price;
    let CE_SL = CE_Entry * SL_percent;
    let PE_SL = PE_Entry * SL_percent;
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL');
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL');
    optionOrders.push({
      CE_SL: CE_SL,
      PE_SL: PE_SL,
      CE_Entry: CE_Entry,
      PE_Entry: PE_Entry,
      CE_opt: CE_opt,
      PE_opt: PE_opt,
      CE_token: CE_opt.instrument_token,
      PE_token: PE_opt.instrument_token,
    })
  }
}

let optionOrders = [];
async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    if (position.CE_SL && ticksCache[position.CE_token].last_price > position.CE_SL) {
      position.CE_SL = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.CE_opt, 'BUY');
      if (position.PE_SL) position.PE_SL = position.PE_Entry;
    }
    if (position.PE_SL && ticksCache[position.PE_token].last_price > position.PE_SL) {
      position.PE_SL = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, position.PE_opt, 'BUY');
      if (position.CE_SL) position.CE_SL = position.CE_Entry;
    }
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('0 18 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 10 15 * * 1-5', function () {
  // Papertrade.positions(function (err, data) {
  //   let strategy = 'BBT';
  //   data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0));
  //   data.positions[strategy].forEach(async (order) => {
  //     let strike = order.tradingsymbol.slice(-7);
  //     if (currentExpiryOptions[strike]) {
  //       Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[strike], (order.quantity > 0 ? 'SELL' : 'BUY'), (Math.abs(order.quantity) / 25));
  //     }
  //   });
  // });
  setTimeout(function () {
    process.exit();
  }, 60000);
}, null, true, 'Asia/Kolkata');
