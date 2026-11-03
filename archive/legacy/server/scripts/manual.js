const CronJob = require("cron").CronJob;
const app = require('../server.js');
const Account = app.models.account;
const async = require('async');
const optionConfig = require('../tools/optionInstruments');

// Strategy Config
let channelId = 0;
let strategyTag = 'S3';

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

    await getAccounts();

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 * * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log('main err', err);
  }
}

let positionEntered = false;
async function check() {
  if (!positionEntered) {
    positionEntered = true;
    let resp = await placeAllAccountNrml(strategyTag, account_quantities, running_accounts, {
      tradingsymbol: "RELIANCE21MARFUT",
      "instrument_token": 12481794,
      lot_size: 250
    }, 'BUY');
    console.log(resp);
    console.log('orders sent');
  }
}

function placeAllAccountNrml(strategyTag, account_quantities, running_accounts, optionInstrument, orderType) {
  return new Promise((resolve, reject) => {
    async.map(running_accounts, function (tmp_zapi, cb) {
      if (account_quantities[tmp_zapi.credentials.user_id]) {
        if (account_quantities[tmp_zapi.credentials.user_id] <= 100) {
          placeOrderNrml(strategyTag, tmp_zapi, optionInstrument, orderType, account_quantities[tmp_zapi.credentials.user_id], cb);
        } else {
          let orderTranches = tranches(account_quantities[tmp_zapi.credentials.user_id]);
          async.map(orderTranches, function (orderTranch, cb2) {
            placeOrderNrml(strategyTag, tmp_zapi, optionInstrument, orderType, orderTranch, cb2);
          }, cb);
        }
      } else cb();
    }, function (err, resp) {
      resp = resp.filter(c => c);
      if (resp.length > 0) {
        resp = [].concat.apply([], resp);
        resolve(resp);
      } else {
        resolve(true);
      }
    });
  })
}

async function placeOrderNrml(strategyTag, tmp_zapi, optionInstrument, orderType, lot_size = 1, mcb) {
  try {
    await tmp_zapi.login();
    let firstLegOrder = await tmp_zapi.orderFNONrml({
      tradingsymbol: optionInstrument.tradingsymbol,
      transaction_type: orderType,
      order_type: "SL-M",
      quantity: optionInstrument.lot_size * lot_size,
      trigger_price: 2176.5,
      price: 0,
      tag: strategyTag
    });
    console.log(firstLegOrder);
    if (firstLegOrder && firstLegOrder.status != 'success') {
      mcb(null, {
        user_id: tmp_zapi.credentials.user_id,
        message: firstLegOrder.message
      });
    } else if (!firstLegOrder) {
      mcb(null, {
        user_id: tmp_zapi.credentials.user_id,
        message: firstLegOrder
      });
    } else {
      mcb(null, false);
    }
  } catch (err) {
    console.log(err);
    mcb(null, {
      user_id: tmp_zapi.credentials.user_id,
      message: err.fileName + ':' + err.lineNumber + ' - ' + err.message
    })
  }
}

runStrategy();
// new CronJob('0 14 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
// new CronJob('0 23 15 * * 1-5', async function () {
//   setTimeout(function () {
//     process.exit();
//   }, 15000);
// }, null, true, 'Asia/Kolkata');
