const os = require('os');
os.setPriority(os.constants.priority.PRIORITY_HIGHEST);

const CronJob = require("cron").CronJob;
const XTSInteractive = require('xts-interactive-api').Interactive;
const app = require('../server.js');
const PaperTrade = app.models.PaperTrade;
const InstrumentDb = app.models.instrument;
const XtsAccount = app.models.xtsAccount;
const Manager = app.models.manager;
const notify = require('../lib/notify');
const async = require('async');
const moment = require('moment');
const optionConfig = require('./optionInstruments');
const tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
let instruments = {};

function placeAllAccount(orderObj, strategyTag, tradingsymbol, orderType, quantity) {
  let optionInstrument = instruments[tradingsymbol];
  return new Promise((resolve, reject) => {
    async.each(Object.values(xts_running_accounts), function (accountObj, cb) {
      (async () => {
        let account = accountObj.account;
        try {
          if (account.strategy && account.strategy[strategyTag]) {
            let orderQuantity = (quantity / optionInstrument.lot_size) * account.strategy[strategyTag];

            let maxOrderQuantity = 36;
            if (tradingsymbol.indexOf('NIFTY') === 0) maxOrderQuantity = 56;

            if (orderQuantity <= maxOrderQuantity) {
              await placeOrder(orderObj, strategyTag, accountObj, optionInstrument.exchange_token, orderType, parseInt(optionInstrument.lot_size) * orderQuantity, cb);
            } else {
              let orderTranches = tranches(orderQuantity, maxOrderQuantity);
              async.each(orderTranches, function (orderTranch, cb2) {
                placeOrder(orderObj, strategyTag, accountObj, optionInstrument.exchange_token, orderType, parseInt(optionInstrument.lot_size) * orderTranch, cb2);
              }, cb);
            }
          } else cb();
        } catch (err) {
          console.log('placeAllAccount err', err);
          let clientId = '';
          if (accountObj && accountObj.client && accountObj.client.username) {
            clientId = accountObj.client.username;
          }
          notify(`Order Error: ${clientId} - ${strategyTag}\n${tradingsymbol} ${orderType}`);
        }
      })();
    }, function () {
      resolve();
    });
  })
}

async function placeOrder(orderObj, strategyTag, accountObj, instrumentId, orderType, lotSize, cb) {
  let tradeFail,
    client = accountObj.client,
    account = accountObj.account;

  console.log('---------------------------------------------------------------');
  do {
    tradeFail = false;
    let orderOptions = {
      exchangeSegment: "NSEFO",
      exchangeInstrumentID: instrumentId,
      productType: 'NRML',
      orderType: "Market",
      orderSide: orderType,
      timeInForce: "DAY",
      disclosedQuantity: 0,
      limitPrice: 0,
      stopPrice: 0,
      orderQuantity: lotSize,
      orderUniqueIdentifier: strategyTag
    };

    if (client.clientCodes && client.clientCodes[0]) {
      orderOptions.clientID = client.clientCodes[0];
    } else if (account && account.clientCode) {
      orderOptions.clientID = account.clientCode;
    }

    // if (orderObj.order_type == 'StopMarket') {
    //   orderOptions.orderType = 'StopLimit';
    //   orderOptions.stopPrice = parseInt(orderObj.stopPrice);

    //   if (orderOptions.orderSide == 'BUY') {
    //     orderOptions.limitPrice = Math.round((orderObj.stopPrice * 1.05) * 10) / 10;
    //   } else {
    //     orderOptions.limitPrice = Math.round((orderObj.stopPrice * 0.95) * 10) / 10;
    //   }
    // } else if (orderObj.order_type == 'LIMIT') {
    //   if (orderOptions.orderSide == 'BUY') {
    //     orderOptions.limitPrice = Math.round((orderObj.price * 1.05) * 10) / 10;
    //   } else {
    //     orderOptions.limitPrice = Math.round((orderObj.price * 0.95) * 10) / 10;
    //   }
    // }
    let randomId = 'orderStart' + parseInt(Math.random() * 999999);
    console.time(randomId);
    let orderResp = await client.placeOrder(orderOptions);
    console.timeEnd(randomId);
    console.log(moment().utcOffset('+05:30').format(), strategyTag, instrumentId, orderType, lotSize, orderResp);
    if (orderResp && orderResp.type && orderResp.type == 'success') { } else {
      console.log('Err', orderResp);
      if (orderResp && orderResp.error && orderResp.error.message && (orderResp.error.message.indexOf('"e-user-') != -1 || orderResp.error.message.indexOf('"e-session-0005"') != -1 || orderResp.error.message.indexOf('"e-session-00005"') != -1)) {
        console.log('Login Err');
        account = await XtsAccount.findById(account.id);
        client = new XTSInteractive(account.credentials.url);
        let loginResp;
        console.log('Logging in: ' + account.username);
        loginResp = await client.logIn({
          appKey: account.credentials.appKey,
          secretKey: account.credentials.secretKey
        });
        console.log(loginResp);
        if (loginResp && loginResp.type && loginResp.type == 'success') {
          account.token = loginResp.result && loginResp.result.token ? loginResp.result.token : false;
          if (account.token) await account.save();
          console.log(client);
          tradeFail = true;
        }
      } else {
        notify('Order Error: ' + strategyTag + ": " + account.username + "\n" + orderResp.error.message, 0);
      }
    }
  } while (tradeFail);
  console.log('---------------------------------------------------------------');
  cb();
}

async function placeTrade(order) {
  try {
    let orderObj = order.fullDocument;
    if ((orderObj.tag != 'AudiB1') && typeof runningStrategies[orderObj.tag] == 'number' && runningStrategies[orderObj.tag] > 0) {
      await placeAllAccount(orderObj, orderObj.tag, orderObj.tradingsymbol, orderObj.transaction_type, orderObj.quantity);
    }
  } catch (err) {
    console.log(err);
  }
}

let xts_running_accounts = {};
let runningStrategies = {};

async function loadAccount(account) {
  let xtsClient = await XtsAccount.loginClient_v2(account.id);
  let allStrategies = Object.keys(account.strategy);
  for (let i = 0; i < allStrategies.length; i++) {
    let strategyTag = allStrategies[i];
    try {
      if (account.strategy && account.strategy[strategyTag] && typeof account.strategy[strategyTag] != 'undefined' && typeof parseInt(account.strategy[strategyTag]) == 'number') {
        account.strategy[strategyTag] = parseInt(account.strategy[strategyTag]);
        if (typeof runningStrategies[strategyTag] != 'number') runningStrategies[strategyTag] = 0;
        runningStrategies[strategyTag] += account.strategy[strategyTag];
      }
    } catch (err) {
      console.log(err);
    }
  }
  xts_running_accounts[account.name] = {
    client: xtsClient,
    account: account
  };
  console.log(account.name + ' loaded', runningStrategies);
  return true;
}

function xtsGetAccounts(groupId = false) {
  return new Promise(async (resolve, reject) => {
    let query = {};
    if (groupId) query.groupId = groupId;
    let accounts = await XtsAccount.find(query);

    async.each(accounts, function (account, cb) {
      loadAccount(account).then(_ => {
        cb();
      });
    }, function () {
      resolve();
    });
  });
}

async function loadInstruments(nearestExpiry) {
  return new Promise(async function (resolve, reject) {
    let instrumentsArr = await InstrumentDb.find();
    instrumentsArr = instrumentsArr.reduce((ob, elm) => {
      elm.exchange_token = parseInt(elm.exchange_token);
      ob[elm.tradingsymbol] = elm;
      return ob;
    }, {});
    resolve(instrumentsArr);
  });
}

async function init() {
  let optionData = await optionConfig();

  let groupId = false;
  if (process.argv.length > 2) {
    let args = process.argv.slice(2);
    groupId = args[0];
  }
  xtsGetAccounts(groupId);
  
  instruments = await loadInstruments(optionData.weeklyExpiry);
  PaperTrade.getDataSource().connector.connect(function (err, db) {
    // notify(`Order Placement: Adapter Started`);
    const collection = db.collection("paper-trade");
    const changeStream = collection.watch();
    changeStream.on("change", function (event) {
      if (event.operationType == 'insert' && event.fullDocument && event.fullDocument.tag && event.fullDocument.tag != 'SOBU') placeTrade(event);
    });

    const collection3 = db.collection("positional");
    const changeStream3 = collection3.watch();
    changeStream3.on("change", function (event) {
      if (event.operationType == 'insert' && event.fullDocument && event.fullDocument.tag) placeTrade(event);
    });

    const collection2 = db.collection("xtsAccount");
    const changeStream2 = collection2.watch();
    changeStream2.on("change", async function (event) {
      if (event.operationType == 'insert' || event.operationType == 'replace' || event.operationType == 'update') {
        let account = await XtsAccount.findById(event.documentKey._id);
        await loadAccount(account);
      }
    });
  });
}

function squareOff() {
  Object.keys(accountIds).forEach((accountName) => {
    XtsAccount.squareOff(accountIds[accountName], {}, function () {
      notify(`${accountName}: SQF Done`, 0);
    });
  });
}

// init();
// startStrategies();
new CronJob('0 13 9 * * 1-5', init, null, true, 'Asia/Kolkata');
// new CronJob('0 23 15 * * 1-5', squareOff, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  setTimeout(process.exit, 6000);
}, null, true, 'Asia/Kolkata');
