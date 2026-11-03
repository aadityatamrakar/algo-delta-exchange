const CronJob = require("cron").CronJob;
const app = require('../server.js');
const PaperTrade = app.models.PaperTrade;
const InstrumentDb = app.models.instrument;
const Algouser = app.models.algouser;
const Algopaper = app.models.algopaper;
const async = require('async');
const moment = require('moment');
const optionConfig = require('./optionInstruments');
const tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
let instruments = {};
let maxOrderLots = {
  "BANKNIFTY": 36,
  "NIFTY": 36
};

function placeAllAccount(strategyTag, tradingsymbol, token, transType, quantity) {
  let optionInstrument = instruments[tradingsymbol];
  return new Promise((resolve, reject) => {
    async.each(Object.values(algo_running_accounts), function (account, cb) {
      (async () => {
        try {
          if (account.strategy && account.strategy[strategyTag]) {
            account.strategy[strategyTag] = parseInt(account.strategy[strategyTag]);
            let orderQuantity = (quantity / optionInstrument.lot_size) * account.strategy[strategyTag];

            if (orderQuantity <= maxOrderLots[optionInstrument.name]) {
              placeOrder(strategyTag, account.id, tradingsymbol, token, transType, parseInt(optionInstrument.lot_size) * orderQuantity, cb);
            } else {
              let orderTranches = tranches(orderQuantity, maxOrderLots[optionInstrument.name]);
              async.eachSeries(orderTranches, function (orderTranch, cb2) {
                placeOrder(strategyTag, account.id, tradingsymbol, token, transType, parseInt(optionInstrument.lot_size) * orderTranch, cb2);
              }, cb);
            }
          } else cb();
        } catch (err) {
          console.log('placeAllAccount err', err);
        }
      })();
    }, function () {
      resolve();
    });
  })
}

async function placeOrder(strategyTag, accountId, symbol, token, transType, quantity, cb) {

  Algopaper.create({
    "status": "COMPLETE",
    "order_timestamp": new Date(moment().toDate()),
    "exchange": "NFO",
    "tradingsymbol": symbol,
    "instrument_token": token,
    "order_type": "MARKET",
    "transaction_type": transType,
    "quantity": quantity,
    // "average_price": price,
    "filled_quantity": quantity,
    "tag": strategyTag,
    "algouserId": String(accountId),
  });

  cb();
}

let placeTrade = async function (order) {
  try {
    let orderObj = order.fullDocument;
    if (typeof runningStrategies[orderObj.tag] == 'number' && runningStrategies[orderObj.tag] > 0) {
      if (!orderObj.dataObj) orderObj.dataObj = [];
      await placeAllAccount(orderObj.tag, orderObj.tradingsymbol, orderObj.instrument_token, orderObj.transaction_type, orderObj.quantity);
    }
  } catch (err) {
    console.log(err);
  }
}

let algo_running_accounts = {};
let runningStrategies = {};

async function loadAccount(account) {
  Object.keys(account.strategy).forEach((strategyTag) => {
    if (typeof account.strategy[strategyTag] == 'number' && account.strategy[strategyTag] > 0) {
      if (typeof runningStrategies[strategyTag] != 'number') runningStrategies[strategyTag] = 0;
      runningStrategies[strategyTag] += account.strategy[strategyTag];
    }
  });
  algo_running_accounts[account.name] = account;
  console.log(account.name + ' loaded');
  return true;
}

function algoGetAccounts() {
  return new Promise(async (resolve, reject) => {
    let accounts = await Algouser.find({});

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

    algoGetAccounts();
    instruments = await loadInstruments(optionData.weeklyExpiry);
    PaperTrade.getDataSource().connector.connect(function (err, db) {
      // notify(`PaperAlgo: Ready`);
      const collection = db.collection("paper-trade");
      const changeStream = collection.watch();
      changeStream.on("change", function (event) {
        if (event.operationType == 'insert' && event.fullDocument && event.fullDocument.tag) placeTrade(event);
      });

      const collection2 = db.collection("algouser");
      const changeStream2 = collection2.watch();
      changeStream2.on("change", async function (event) {
        if (event.operationType == 'insert' || event.operationType == 'replace' || event.operationType == 'update') {
          let account = await Algouser.findById(event.documentKey._id);
          await loadAccount(account);
        }
      });
    });
  }
}

process.on('uncaughtException', function (err) {
  notify('Caught exception: ' + err.message);
});

// init();
new CronJob('0 13 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
