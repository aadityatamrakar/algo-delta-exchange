const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Strategy Config
let channelId = 0;
let strategyTag = 'S4';

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
    ticker([futureToken]);

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 17 9 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
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
}

let CE_opt, PE_opt, CE_Entry, PE_Entry, CE_SL, PE_SL, SL_percent = 1.4;
async function takeTrade() {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    let ce_strike = atm_strike + 2000;
    let pe_strike = atm_strike - 2000;

    CE_opt = currentExpiryOptions[ce_strike + 'CE'];
    PE_opt = currentExpiryOptions[pe_strike + 'PE'];

    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL', 4);
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL', 4);
  }
}

// runStrategy();
new CronJob('0 12 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 28 15 * * 1-5', async function () {
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'BUY', 4);
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'BUY', 4);
}, null, true, 'Asia/Kolkata');
new CronJob('0 31 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
