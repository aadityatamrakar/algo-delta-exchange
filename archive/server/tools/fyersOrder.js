const CronJob = require("cron").CronJob;
const Fyers = require('./../lib/fyers');
const app = require('../server.js');
const PaperTrade = app.models.PaperTrade;
const FyersAccount = app.models.FyersAccount;
const InstrumentDb = app.models.instrument;
const notify = require('../lib/notify');
const async = require('async');
const optionConfig = require('./optionInstruments');
const tranches = (number) => ((new Array(Math.floor(number / 100)).fill(100).concat(number % 100)).filter(c => c > 0));
let instruments = {};

function placeAllAccount(strategyTag, tradingsymbol, orderType, quantity) {
  let optionInstrument = instruments[tradingsymbol];
  // console.log(strategyTag, optionInstrument, tradingsymbol, orderType, quantity);
  return new Promise((resolve, reject) => {
    async.each(Object.values(running_accounts), function (account, cb) {
      (async () => {
        try {
          if (account.strategy && account.strategy[strategyTag]) {
            account.strategy[strategyTag] = parseInt(account.strategy[strategyTag]);
            let orderQuantity = (quantity / optionInstrument.lot_size) * account.strategy[strategyTag];

            if (orderQuantity <= 40) {
              await placeOrder(strategyTag, account.client, tradingsymbol, orderType, parseInt(optionInstrument.lot_size) * orderQuantity, cb);
            } else {
              let orderTranches = tranches(orderQuantity);
              async.eachSeries(orderTranches, function (orderTranch, cb2) {
                placeOrder(strategyTag, account.client, tradingsymbol, orderType, parseInt(optionInstrument.lot_size) * orderTranch, cb2);
              }, cb);
            }
          } else cb();
        } catch (err) {
          console.log('placeAllAccount err', err);
          console.log(`Error: ${strategyTag} ${tradingsymbol} ${orderType}`);
        }
      })();
    }, function () {
      resolve();
    });
  })
}

async function placeOrder(strategyTag, client, instrument, orderType, lotSize, cb) {
  await client.login();
  let orderResp = await client.place_order({
    side: orderType == 'BUY' ? 1 : -1,
    symbol: "NSE:" + instrument,
    quantity: lotSize
  });
  if (orderResp === false) notify('Fyers API Order Error');
  console.log(orderResp);
  cb();
}

async function placeTrade(order) {
  try {
    let orderObj = order.fullDocument;
    await placeAllAccount(orderObj.tag, orderObj.tradingsymbol, orderObj.transaction_type, orderObj.quantity);
  } catch (err) {
    console.log(err);
  }
}

let running_accounts = {};
async function getAccounts() {
  return new Promise(async (resolve, reject) => {
    let users = await FyersAccount.find();

    async.each(users, function (user, cb) {
      (async () => {
        let fapi = new Fyers(user);
        await fapi.login();
        running_accounts[user.name] = {
          strategy: user.strategy,
          client: fapi
        };
        cb();
      })()
    }, function () {
      resolve(true);
    });
  })
}

var getAccountsQ = async.queue(function (task, callback) {
  getAccounts().then(function () {
    callback();
  });
}, 1);

function refreshAccounts() {
  getAccountsQ.push({
    check: 1
  });
}

async function loadInstruments() {
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

  refreshAccounts();
  instruments = await loadInstruments(optionData.weeklyExpiry);
  PaperTrade.getDataSource().connector.connect(function (err, db) {
    console.log(`Order Placement: Adapter Started`);
    const collection = db.collection("paper-trade");
    const changeStream = collection.watch();
    changeStream.on("change", function (event) {
      if (event.operationType == 'insert') placeTrade(event);
    });

    const collection2 = db.collection("fyers-account");
    const changeStream2 = collection2.watch();
    changeStream2.on("change", refreshAccounts);
  });
}

// init();
new CronJob('0 16 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 15 15 * * 1-5', function () {
  setTimeout(process.exit, 6000);
}, null, true, 'Asia/Kolkata');
