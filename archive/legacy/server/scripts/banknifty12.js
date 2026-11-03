const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const EMA = require('../lib/indicators/ema.js');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');

// Strategy Config
let channelId = 0;
let strategyTag = 'Banknifty12';

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
  fromDate, toDate;
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

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 20 9 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 30 9 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 34 9 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 5 10 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 20 10 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 34 10 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 20 11 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 34 11 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 20 12 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 34 12 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 20 13 * * 1-5', check, null, true, 'Asia/Kolkata');
    new CronJob('0 34 13 * * 1-5', check, null, true, 'Asia/Kolkata');
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

  checkSL();
}

function checkSL() {
  openOrders.forEach(async (order, idx) => {
    if (order) {
      let current_total = ticksCache[order.CE_opt.instrument_token].last_price + ticksCache[order.PE_opt.instrument_token].last_price;
      if (current_total > order.sl_price) {
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, order.CE_opt, 'BUY');
        Account.placeAllAccount(strategyTag, account_quantities, running_accounts, order.PE_opt, 'BUY');
        // notify(`Bn12(${order.orderId}): SL Hit`, 0);
        delete openOrders[idx];
      } else if (current_total < order.tgt_price) {
        order.tgt_price -= 10;
        order.sl_price -= 10;
        // notify(`Bn12(${order.orderId}): SL Trail`, 0);
      }
    }
  })
}

let nextId = 1;
const getNextId = () => nextId++;

let openOrders = [];
async function check() {
  let bn_quote = ticksCache[futureToken];
  let open_strike = Math.round(bn_quote.last_price / 100) * 100;
  let CE_opt = currentExpiryOptions[open_strike + 'CE'];
  let PE_opt = currentExpiryOptions[open_strike + 'PE'];

  let current_total = ticksCache[CE_opt.instrument_token].last_price + ticksCache[PE_opt.instrument_token].last_price;
  let sl_price = current_total + 20;
  let tgt_price = current_total - 20;
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL');
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL');
  openOrders.push({
    CE_opt,
    PE_opt,
    tgt_price,
    sl_price,
    orderId: getNextId()
  })
}

// runStrategy();
new CronJob('30 12 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
