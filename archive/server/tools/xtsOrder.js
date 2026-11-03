const CronJob = require("cron").CronJob;
const XTSInteractive = require('xts-interactive-api').Interactive;
const app = require('../server.js');
const PaperTrade = app.models.PaperTrade;
const InstrumentDb = app.models.instrument;
const XtsAccount = app.models.xtsAccount;
const Orderbook2 = app.models.orderbook2;
const Manager = app.models.manager;
const notify = require('../lib/notify');
const async = require('async');
const moment = require('moment');
const optionConfig = require('./../tools/optionInstruments');
const tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
let instruments = {};
let maxOrderLots = {
  "BANKNIFTY": 20,
  "NIFTY": 27,
  "FINNIFTY": 45,
  "MIDCPNIFTY": 56,
  "SENSEX": 50
};
let isLoggingIn = {};
async function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let orderbook = [];
const debounce = (fn, delay) => {
  let timer = null;
  return function () {
    let context = this, args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(context, args);
    }, delay);
  };
};

async function saveOrders(orders) {
  try {
    Orderbook2.create(orders, function (err, resp) {
      if (err) console.log('saveOrders err', err);
      // console.log('saveOrders resp', resp);
    });
  } catch (err) {
    console.log('saveOrders err', err);
  }
}

const debounced = debounce(() => {
  // console.log('debounced');
  try {
    let orderbookCopy = JSON.parse(JSON.stringify(orderbook));
    orderbook = [];
    async.each(orderbookCopy, function (orderObj, cb) {
      saveOrders(orderObj);
      cb();
    }, function (err, resp) { });
  } catch (err) {
    console.log('debounced err', err);
  }
}, 200);


async function addToOrderbook(orderObj) {
  // push order to orderbook
  orderbook.push({
    "accountId": orderObj.accountId,
    "order_id": orderObj.orderId,
    "quantity": orderObj.quantity,
    "transaction_type": orderObj.transaction_type,
    "order_type": orderObj.order_type,
    "tag": orderObj.tag,
    "instrument_token": orderObj.instrument_token,
    "tradingsymbol": orderObj.tradingsymbol,
    "status": "New",
    "exchange_order_id": "",
    "placed_by": "",
    "average_price": 0,
    "exchange": orderObj.exchange,
    "product": "NRML",
    "validity": "DAY",
    "price": 0,
    "trigger_price": 0,
    "order_timestamp": moment().format("DD-MM-YYYY HH:mm:ss"),
    "exchange_update_timestamp": moment().format("DD-MM-YYYY HH:mm:ss")
  });
  debounced();
}


function placeAllAccount(orderObj, strategyTag, tradingsymbol, transType, orderType, quantity, dataObj) {
  let optionInstrument = instruments[tradingsymbol];
  return new Promise((resolve, reject) => {
    async.each(Object.values(xts_running_accounts), function (accountObj, cb) {
      (async () => {
        let account = accountObj.account;
        try {
          if (account.strategy && account.strategy[strategyTag]) {
            let orderQuantity = (quantity / optionInstrument.lot_size) * account.strategy[strategyTag];
            let index_name = tradingsymbol.match(/^\D*/)[0];
            if (index_name == 'SENSEX') orderObj.exchange = 'BSEFO';
            else orderObj.exchange = 'NSEFO';
            if (orderQuantity <= maxOrderLots[index_name]) {
              await placeOrder(orderObj, strategyTag, accountObj, optionInstrument.exchange_token, transType, orderType, parseInt(optionInstrument.lot_size) * orderQuantity, dataObj, cb);
            } else {
              let orderTranches = tranches(orderQuantity, maxOrderLots[index_name]);
              async.each(orderTranches, function (orderTranch, cb2) {
                placeOrder(orderObj, strategyTag, accountObj, optionInstrument.exchange_token, transType, orderType, parseInt(optionInstrument.lot_size) * orderTranch, dataObj, cb2);
              }, cb);
            }
          } else cb();
        } catch (err) {
          console.log('placeAllAccount err', err);
          notify(`Order Error: ${strategyTag} ${tradingsymbol} ${transType}`);
        }
      })();
    }, function () {
      resolve();
    });
  })
}

async function placeOrder(orderObj, strategyTag, accountObj, instrumentId, transType, orderType, lotSize, dataObj, cb) {
  let tradeFail;
  let account = accountObj.account;
  
  // Always get the latest client from the running accounts
  let client = xts_running_accounts[account.name].client;

  let retryCount = 0;
  console.log('---------------------------------------------------------------');
  do {
    tradeFail = false;
    let orderOptions = {
      clientID: client.clientCodes[0],
      exchangeSegment: orderObj.exchange,
      exchangeInstrumentID: instrumentId,
      productType: 'NRML',
      orderType: orderType,
      orderSide: transType,
      timeInForce: "DAY",
      disclosedQuantity: 0,
      limitPrice: orderType == 'Limit' ? parseInt(orderObj.limitPrice) : 0,
      stopPrice: orderType == 'StopMarket' ? parseInt(orderObj.stopPrice) : 0,
      orderQuantity: lotSize,
      orderUniqueIdentifier: [strategyTag, ...dataObj].join('|')
    };

    if (orderType == 'StopMarket') {
      orderOptions.orderType = 'StopLimit';
      orderOptions.stopPrice = parseInt(orderObj.stopPrice);
      if (orderOptions.stopPrice > 1000) {
        if (orderOptions.orderSide == 'BUY') {
          orderOptions.limitPrice = Math.round(orderObj.stopPrice * 1.01);
        } else {
          orderOptions.limitPrice = Math.round(orderObj.stopPrice * 0.99);
        }
      } else {
        if (orderOptions.orderSide == 'BUY') {
          orderOptions.limitPrice = Math.round((orderObj.stopPrice * 1.05) * 10) / 10;
        } else {
          orderOptions.limitPrice = Math.round((orderObj.stopPrice * 0.95) * 10) / 10;
        }
      }
    }

    let orderResp = await client.placeOrder(orderOptions);

    console.log(moment().utcOffset('+05:30').format(), strategyTag, orderObj.tradingsymbol, instrumentId, orderType, lotSize, orderResp);
    if (orderResp && orderResp.type && orderResp.type == 'success') {
      try {
        addToOrderbook({
          accountId: account.id,
          orderId: orderResp.result.AppOrderID,
          quantity: (orderObj.tradingsymbol.indexOf("BANKNIFTY") == 0) ? lotSize * 15 : lotSize * 50,
          transaction_type: transType,
          order_type: orderType,
          tag: strategyTag,
          instrument_token: orderObj.instrument_token,
          tradingsymbol: orderObj.tradingsymbol
        });
      } catch (err) {
        console.log('addToOrderbook err', err);
      }
    } else {
      retryCount += 1;
      console.log('Err', orderResp);
      if (retryCount < 3 && orderResp && orderResp.error && orderResp.error.message && orderResp.error.message == '400 - {"type":"error","code":"e-request-0004","description":"System Error : X10203. ApplicationType:OMSInjector. Error : An error occurred while sending the request."}') {
        tradeFail = true;
        await pause(1000); // Small delay before retry
      } else if (retryCount < 3 && orderResp && orderResp.error && orderResp.error.message && (orderResp.error.message.indexOf('"e-user-') != -1 || orderResp.error.message.indexOf('"e-session-0005"') != -1 || orderResp.error.message.indexOf('"e-session-00005"') != -1)) {
        if (isLoggingIn[account.id]) {
          console.log('Waiting for login to complete for account: ' + account.username);
          const delay = Math.floor(Math.random() * 3000) + 3000; // random between 3000-6000 ms
          await pause(delay);
          tradeFail = true;
          // Get the fresh client after login completes
          client = xts_running_accounts[account.name].client;
        } else {
          isLoggingIn[account.id] = true;
          try {
            account = await XtsAccount.findById(account.id);
            console.log('Re-logging in for account: ' + account.username);
            let new_client = await XtsAccount.loginClient_v2(account.id);
            if (new_client) {
              tradeFail = true;
              account.token = new_client._token;
              client = new_client;
              xts_running_accounts[account.name] = {
                client: client,
                account: account
              };
              await account.save();
              console.log('Re-logged in for account: ' + account.username);
            } else {
              console.log('Failed to re-login for account: ' + account.username);
            }
          } catch (loginErr) {
            console.log('Re-login error for account: ' + account.username, loginErr);
          } finally {
            isLoggingIn[account.id] = false;
          }
        }
      } else {
        notify('Order Err: ' + client.clientCodes[0] + ' - ' + strategyTag + `\n${orderObj.tradingsymbol} ${orderType} ${lotSize}`, 0);
      }
    }
  } while (tradeFail && retryCount < 3);
  console.log('---------------------------------------------------------------');
  cb();
}

let placeTrade = async function (order) {
  try {
    let orderObj = order.fullDocument;
    if (typeof runningStrategies[orderObj.tag] == 'number' && runningStrategies[orderObj.tag] > 0) {
      if (!orderObj.dataObj) orderObj.dataObj = [];
      await placeAllAccount(orderObj, orderObj.tag, orderObj.tradingsymbol, orderObj.transaction_type, orderObj.order_type, orderObj.quantity, orderObj.dataObj);
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
  console.log(account.name + ' loaded');
  return true;
}

function xtsGetAccounts() {
  return new Promise(async (resolve, reject) => {
    let accounts = await XtsAccount.find({});

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

let systemStarted = false;
async function init() {
  if (!systemStarted) {
    systemStarted = true;
    let optionData = await optionConfig();

    xtsGetAccounts();
    instruments = await loadInstruments(optionData.weeklyExpiry);
    PaperTrade.getDataSource().connector.connect(function (err, db) {
      notify(`XTS: Ready`);
      const collection = db.collection("paper-trade");
      const changeStream = collection.watch();
      changeStream.on("change", function (event) {
        if (event.operationType == 'insert' && event.fullDocument && event.fullDocument.tag) placeTrade(event);
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
  new CronJob('0 * * * * 1-5', delayStartStrategies, null, true, 'Asia/Kolkata');
}

async function startStrategies() {
  console.log(Manager.liveStrategies);
  for (let i = 0; i < Manager.liveStrategies.length; i++) {
    if (Manager.liveStrategies[i].autostart) {
      Manager.restart(Manager.liveStrategies[i].module, function (err, resp) {
        console.log('Starting...' + Manager.liveStrategies[i].name, resp);
      });
    }
  }
}
async function delayStartStrategies() {
  let currentTime = moment().add(330, 'minutes').format('HHmm');
  for (let i = 0; i < Manager.liveStrategies.length; i++) {
    if (Manager.liveStrategies[i].delay_start == currentTime) {
      Manager.restart(Manager.liveStrategies[i].module, function (err, resp) {
        console.log('Starting...' + Manager.liveStrategies[i].name, resp);
      });
    }
  }
}
async function stopStrategies() {
  console.log(Manager.liveStrategies);
  for (let i = 0; i < Manager.liveStrategies.length; i++) {
    Manager.stop(Manager.liveStrategies[i].module, function (err, resp) {
      console.log('Stopping...' + Manager.liveStrategies[i].name, resp);
    });
  }
  // placeTrade = function () {};
}

async function clearOrders() {
  async.each(Object.values(xts_running_accounts), function (accountObj, cb) {
    let accountId = accountObj.account.id;
    XtsAccount.removePending(String(accountId), false, function () {
      cb();
    });
  }, function () {
    notify('XTS Orders Clear Done');
  });
}
async function squareOff() {
  async.each(Object.values(xts_running_accounts), function (accountObj, cb) {
    let accountId = accountObj.account.id;
    XtsAccount.squareOff(String(accountId), {}, function () {
      cb();
    });
  }, function () {
    notify('XTS Square Off Done');
  });
}

process.on('uncaughtException', function (err) {
  notify('Caught exception: ' + err.message);
});
// init();
// setTimeout(startStrategies, 15000);
new CronJob('0 13 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('30 16 9 * * 1-5', startStrategies, null, true, 'Asia/Kolkata');
new CronJob('50 23 15 * * 1-5', stopStrategies, null, true, 'Asia/Kolkata');
new CronJob('5 24 15 * * 1-5', clearOrders, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
