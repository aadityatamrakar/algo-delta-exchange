const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const notify = require("../lib/notify.js");
const async = require('async');

let strategyTag = 'AlgoEQ';
let channelId = 0;

let zapi, public_token;
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
    running_accounts = accountsData.running_accounts.filter(function (account) {
      if (account_quantities[account.credentials.user_id] && account_quantities[account.credentials.user_id] > 0) {
        return true;
      } else return false;
    });
    console.log(running_accounts.length, account_quantities);
    firstRun = false;
  }
}

let stockName = '3IINFOLTD-BE'
async function runStrategy() {
  try {
    await getAccounts();

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    let bn_quote = await zapi.getQoute("NSE:" + stockName);
    let upper_circuit = bn_quote.upper_circuit_limit;
    console.log(stockName, upper_circuit);

    new CronJob('1 0 9 * * 1-5', async function () {
      placeAllAccount('BUY', upper_circuit);
    }, null, true, 'Asia/Kolkata');
    new CronJob('1 15 9 * * 1-5', async function () {
      placeAllAccount('BUY', upper_circuit);
    }, null, true, 'Asia/Kolkata');
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
  console.log(ticks2);
}

function placeAllAccount(type, price) {
  return new Promise((resolve, reject) => {
    async.map(running_accounts, function (tmp_zapi, cb) {
      placeOrder(tmp_zapi, type, price, cb);
    }, function (err, resp) {
      notify(stockName + ': Buy Sent!');
      resolve(true);
    });
  })
}

async function placeOrder(tmp_zapi, type, price, mcb) {
  try {
    let firstLegOrder = await tmp_zapi.orderCNC({
      exchange: "NSE",
      symbol: stockName,
      type: type,
      order_type: 'LIMIT',
      price: price,
      quantity: account_quantities[tmp_zapi.credentials.user_id],
      tag: 'AlgoEQ'
    });
    console.log(firstLegOrder);
    mcb();
  } catch (err) {
    console.log('placeorder', err);
    mcb();
  }
}

// runStrategy();
new CronJob('0 50 8 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 20 9 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
