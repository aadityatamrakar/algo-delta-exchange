const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const moment = require("moment");

// Strategy Config
let channelId = 0;
let strategyTag = 'Hedge-2K';

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
  currentExpiry = '',
  ce_strike = false,
  pe_strike = false;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    currentExpiry = optionData.weeklyExpiry;
    notify('Weekly Expiry: ' + currentExpiry);
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    setTimeout(takeTrade, 60000);
    // new CronJob('0 17 9 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
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
  let ce_strike, pe_strike;

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    ce_strike = atm_strike + 2000;
    pe_strike = atm_strike - 2000;
    console.log(moment().format('YYYY-MM-DD'), currentExpiry);
    if (moment().format('YYYY-MM-DD') == currentExpiry) {
      ce_strike = atm_strike + 1500;
      pe_strike = atm_strike - 1500;
    }

    let round_ce_strike = Math.round(ce_strike / 500) * 500;
    let round_pe_strike = Math.round(pe_strike / 500) * 500;
    if (round_ce_strike > ce_strike) round_ce_strike -= 500;
    if (round_pe_strike < pe_strike) round_pe_strike += 500;

    CE_opt = currentExpiryOptions[round_ce_strike + 'CE'];
    PE_opt = currentExpiryOptions[round_pe_strike + 'PE'];

    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'BUY');
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'BUY');
  }
}

runStrategy();
new CronJob('0 24 15 * * 1-5', function () {
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL');
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL');
}, null, true, 'Asia/Kolkata');
