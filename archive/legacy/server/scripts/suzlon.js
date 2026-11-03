const CronJob = require("cron").CronJob;
const app = require('../server.js');
const Account = app.models.account;
const async = require('async');

let strategyTag = 'ADMIN_SQF';

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

async function runStrategy() {
  try {
    await getAccounts();
    new CronJob('0 35 13 * * 1-5', _ => {
      placeAllAccount('BUY');
    }, null, true, 'Asia/Kolkata');

    new CronJob('3 35 13 * * 1-5', _ => {
      placeAllAccount('SELL');
    }, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

function placeAllAccount(type) {
  return new Promise((resolve, reject) => {
    async.map(running_accounts, function (tmp_zapi, cb) {
      placeOrder(strategyTag, tmp_zapi, type, cb);
    }, function (err, resp) {
      resolve(true);
    });
  })
}

async function placeOrder(strategyTag, tmp_zapi, type, mcb) {
  try {
    let firstLegOrder = await tmp_zapi.orderCNC({
      symbol: "SUZLON",
      type: type,
      order_type: 'MARKET',
      quantity: 1,
      tag: strategyTag
    });
    console.log(firstLegOrder);
    mcb();
  } catch (err) {
    console.log('placeorder', err);
    mcb();
  }
}

runStrategy();