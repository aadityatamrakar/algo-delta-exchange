const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');

// Strategy Config
let channelId = 0;
let strategyTag = 'Strangle';

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
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 30 9 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
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
  if (typeof CE_SL == 'number') {
    if (ticksCache[CE_opt.instrument_token].last_price > CE_SL) {
      CE_SL = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'BUY');
    }
  }
  if (typeof PE_SL == 'number') {
    if (ticksCache[PE_opt.instrument_token].last_price > PE_SL) {
      PE_SL = false;
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'BUY');
    }
  }
}

let CE_opt, PE_opt, CE_SL, PE_SL, SL_percent = 1.25;
async function takeTrade() {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100) + 100;
    let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100) - 100;
    CE_opt = currentExpiryOptions[upper_strike + 'CE'];
    PE_opt = currentExpiryOptions[lower_strike + 'PE'];

    CE_SL = ticksCache[CE_opt.instrument_token].last_price * SL_percent;
    PE_SL = ticksCache[PE_opt.instrument_token].last_price * SL_percent;
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL');
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL');
  }
}

// runStrategy();
new CronJob('0 25 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
