const CronJob = require("cron").CronJob;
const app = require('../server.js');
const PaperTrade = app.models.PaperTrade;
const InstrumentDb = app.models.instrument;
const SparkAccount = app.models.sparkAccount;
const notify = require('../lib/notify');
const async = require('async');
const moment = require('moment');
const optionConfig = require('./optionInstruments');
const tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
let instruments = {};
let maxOrderLots = {
  "BANKNIFTY": 36,
  "NIFTY": 56
};
let strategies = ['AlgoEQ', 'Index', 'Index_Old', 'Bentley', 'RollsRoyce', 'Birbal_AI', 'Casino', 'Tesla', 'TR', 'Pi', 'ITCRT', 'LX1', 'LX2', 'LX3', 'LX4', 'STG3', 'STG4', 'Chai', 'Spider', 'F2', 'ST1', 'BTS', 'BBT', 'BBT5', 'BBTn5', 'iStraddle', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'Math_AI', 'Index', 'Index_Old', 'AlgoEQ', 'Bahubali', 'Birbal_AI', 'Birbal_LMT', 'Casino', 'Tesla', 'Pi', 'ITC', 'ITCRT', 'Chai', 'Spider', 'F2', 'ST1', 'S1', 'BTS', 'BBT', 'BBTn5', 'BBT5', 'Urvashi', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'mStrangleT', 'uStrangleT', 'Strangle40', 'Strangle60', 'ADMIN_SQF', 'SQF', "STG1", "STG2", "STG3", "STG4", "STG5", "STG6", "STG7", "STG8", "STG9", "STG10", "STG11", "STG12", "STG13", "STG14", "STG15", "STG16", "STG17", "STG18", "STG19", "STG20", "STG21", "STG22", "STG23", "MTM_1", "STGL-120", "STGL-160", "Strangle240", 'Strangle2k', 'MB-2k', "MB-N700", "MB-10", "AudiB1", "AudiB2","AudiB3","AudiB4", "AudiN1", "AudiN2", "AudiT60", "AudiTT","AudiTT2", "Banknifty12", "Nifty12", "Ford", "Ford2", "Ford3",'AudiT80R', 'AudiT120R','AudiB80R','AudiB120R', 'B5', 'B4', 'T4', 'T3', 'Volvo', 'Volvo2', "TWS", "TWSn", 'V1', 'V2', 'Hedge', 'Super20','Honda2k', 'S4'];
let strategyIdStart = 1001; 
let strategyMap = strategies.reduce((o, e) => (o[e] = strategyIdStart++, o), {})

function placeAllAccount(orderObj, strategyTag, tradingsymbol, transType, orderType, quantity, dataObj) {
  let optionInstrument = instruments[tradingsymbol];
  return new Promise((resolve, reject) => {
    async.each(Object.values(xts_running_accounts), function (accountObj, cb) {
      (async () => {
        let account = accountObj.account;
        try {
          if (account.strategy && account.strategy[strategyTag]) {
            account.strategy[strategyTag] = parseInt(account.strategy[strategyTag]);
            let orderQuantity = (quantity / optionInstrument.lot_size) * account.strategy[strategyTag];

            if (orderQuantity <= maxOrderLots[optionInstrument.name]) {
              await placeOrder(orderObj, strategyTag, accountObj, optionInstrument.exchange_token, transType, orderType, parseInt(optionInstrument.lot_size) * orderQuantity, dataObj, cb);
            } else {
              let orderTranches = tranches(orderQuantity, maxOrderLots[optionInstrument.name]);
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
  let tradeFail,
    client = accountObj.client,
    account = accountObj.account;

  console.log('---------------------------------------------------------------');
  let orderOptions = {
    exchange_token: instrumentId,
    quantity: lotSize,
    order_side: transType,
    product: "MIS",
    order_type: orderType == 'StopMarket' ? 'SL' : "MARKET",
    trigger_price: orderType == 'StopMarket' ? parseInt(orderObj.stopPrice) : 0,
    strategy_id: strategyMap[strategyTag]
  };

  if (orderType == 'StopMarket') {
    orderOptions.orderType = 'SL';
    orderOptions.trigger_price = parseInt(orderObj.stopPrice);

    if (orderOptions.order_side == 'BUY') {
      orderOptions.price = Math.round((orderObj.stopPrice * 1.05) * 10) / 10;
    } else {
      orderOptions.price = Math.round((orderObj.stopPrice * 0.95) * 10) / 10;
    }
  }
  console.log(orderOptions);
  let randomId = 'orderStart' + parseInt(Math.random() * 999999);
  console.time(randomId);
  let orderResp = await client.Order(orderOptions);
  console.timeEnd(randomId);
  if (orderResp == false) {
    notify('Tradelab Order Err: ' + strategyTag, 0);
    console.log('Order Error', orderResp);
  }
  console.log(moment().utcOffset('+05:30').format(), strategyTag, instrumentId, orderType, lotSize, orderResp);
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
  let xtsClient = await SparkAccount.loginClient_v2(account.id);
  Object.keys(account.strategy).forEach((strategyTag) => {
    if (typeof account.strategy[strategyTag] == 'number' && account.strategy[strategyTag] > 0) {
      if (typeof runningStrategies[strategyTag] != 'number') runningStrategies[strategyTag] = 0;
      runningStrategies[strategyTag] += account.strategy[strategyTag];
    }
  });
  xts_running_accounts[account.name] = {
    client: xtsClient,
    account: account
  };
  console.log(account.name + ' loaded');
  return true;
}

function xtsGetAccounts() {
  return new Promise(async (resolve, reject) => {
    let accounts = await SparkAccount.find({});

    async.each(accounts, function (account, cb) {
      (async () => {
        // delete account.credentials.token;
        // await account.save();

        loadAccount(account).then(_ => {
          cb();
        });
      })();
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
      notify(`Tradelab: Ready`);
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

      const collection2 = db.collection("sparkAccount");
      const changeStream2 = collection2.watch();
      changeStream2.on("change", async function (event) {
        if (event.operationType == 'insert' || event.operationType == 'replace' || event.operationType == 'update') {
          let account = await SparkAccount.findById(event.documentKey._id);
          await loadAccount(account);
        }
      });
    });
  }
}

// init();
// setTimeout(startStrategies, 15000);
new CronJob('0 13 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
