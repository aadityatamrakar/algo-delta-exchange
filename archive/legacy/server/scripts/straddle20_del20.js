const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const Papertrade = app.models.PaperTrade;
const InstrumentDb = app.models.instrument;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
var XTSInteractive = require('xts-interactive-api').Interactive;
let xtsClient = new XTSInteractive("http://14.97.57.98:3000");
let instruments = {};
let instrumentsByToken = {};

// Strategy Config
let channelId = 0;
let strategyTag = 'Bahubali';
let orderQuantity = 50;


async function loadInstruments(nearestExpiry) {
  return new Promise(async function (resolve, reject) {
    let instrumentsArr = await InstrumentDb.find();

    instrumentsByToken = instrumentsArr.reduce((ob, elm) => {
      elm.exchange_token = parseInt(elm.exchange_token);
      ob[elm.exchange_token] = elm;
      return ob;
    }, {});

    instrumentsArr = instrumentsArr.reduce((ob, elm) => {
      elm.exchange_token = parseInt(elm.exchange_token);
      ob[elm.tradingsymbol] = elm;
      return ob;
    }, {});
    resolve(instrumentsArr);
  });
}


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

let futureToken, currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
    instruments = await loadInstruments(optionData.weeklyExpiry);

    // await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    // new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');

    let credentials = {
      "appKey": "7bf824e587e940854f9211",
      "secretKey": "Rhko213@OV"
    };
    let logIn = await xtsClient.logIn(credentials);
    console.log(logIn);

    // monday
    new CronJob('58 15 9 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 20 9 * * 1', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 25 9 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 30 9 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 5 10 * * 1', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 45 10 * * 1', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 55 10 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 0 11 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 5 11 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 30 11 * * 1', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 35 11 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 45 11 * * 1', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 50 11 * * 1', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 10 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 15 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 20 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 25 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 40 12 * * 1', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 45 12 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 55 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');

    // tuesday
    new CronJob('58 15 9 * * 2', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 20 9 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 25 9 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 30 9 * * 2', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 35 9 * * 2', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 40 9 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 50 9 * * 2', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 10 10 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 15 10 * * 2', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 35 10 * * 2', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 45 10 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 50 10 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 55 10 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 0 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 30 11 * * 2', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 40 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 50 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 55 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 0 12 * * 2', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 05 12 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');

    // wednesday
    new CronJob('58 15 9 * * 3', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 20 9 * * 3', () => takeTrade(1.8), null, true, 'Asia/Kolkata');
    new CronJob('58 25 9 * * 3', () => takeTrade(1.8), null, true, 'Asia/Kolkata');
    new CronJob('58 30 9 * * 3', () => takeTrade(1.8), null, true, 'Asia/Kolkata');
    new CronJob('58 35 9 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 40 9 * * 3', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 55 9 * * 3', () => takeTrade(2), null, true, 'Asia/Kolkata');
    new CronJob('58 0 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 05 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 15 10 * * 3', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 20 10 * * 3', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 25 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 30 10 * * 3', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 45 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 50 10 * * 3', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 0 11 * * 3', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 40 11 * * 3', () => takeTrade(2), null, true, 'Asia/Kolkata');
    new CronJob('58 10 12 * * 3', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 20 12 * * 3', () => takeTrade(1.3), null, true, 'Asia/Kolkata');
    new CronJob('58 45 12 * * 3', () => takeTrade(1.7), null, true, 'Asia/Kolkata');

    // thursday
    new CronJob('58 50 9 * * 4', () => takeTrade(1.9, true), null, true, 'Asia/Kolkata');
    new CronJob('58 20 12 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 10 11 * * 4', () => takeTrade(1.2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 15 9 * * 4', () => takeTrade(1.9, true), null, true, 'Asia/Kolkata');
    new CronJob('58 25 12 * * 4', () => takeTrade(1.7, true), null, true, 'Asia/Kolkata');
    new CronJob('58 10 10 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 15 11 * * 4', () => takeTrade(1.2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 0 11 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 20 9 * * 4', () => takeTrade(1.1, true), null, true, 'Asia/Kolkata');
    new CronJob('58 55 9 * * 4', () => takeTrade(1.5, true), null, true, 'Asia/Kolkata');
    new CronJob('58 30 11 * * 4', () => takeTrade(1.1, true), null, true, 'Asia/Kolkata');
    new CronJob('58 0 10 * * 4', () => takeTrade(1.3, true), null, true, 'Asia/Kolkata');
    new CronJob('58 30 9 * * 4', () => takeTrade(1.4, true), null, true, 'Asia/Kolkata');
    new CronJob('58 05 12 * * 4', () => takeTrade(1.8, true), null, true, 'Asia/Kolkata');
    new CronJob('58 05 10 * * 4', () => takeTrade(1.3, true), null, true, 'Asia/Kolkata');
    new CronJob('58 05 11 * * 4', () => takeTrade(1.3, true), null, true, 'Asia/Kolkata');
    new CronJob('58 10 12 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 50 12 * * 4', () => takeTrade(1.7, true), null, true, 'Asia/Kolkata');
    new CronJob('58 40 9 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
    new CronJob('58 45 9 * * 4', () => takeTrade(1.2, true), null, true, 'Asia/Kolkata');

    // friday
    new CronJob('58 20 9 * * 5', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 25 9 * * 5', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 30 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 35 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 45 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 50 9 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 05 10 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 10 10 * * 5', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 40 10 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 05 11 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 15 11 * * 5', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    new CronJob('58 20 11 * * 5', () => takeTrade(1.1), null, true, 'Asia/Kolkata');
    new CronJob('58 25 11 * * 5', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 30 11 * * 5', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
    new CronJob('58 45 11 * * 5', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 05 12 * * 5', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    new CronJob('58 10 12 * * 5', () => takeTrade(1.9), null, true, 'Asia/Kolkata');
    new CronJob('58 20 12 * * 5', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
    new CronJob('58 35 12 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    new CronJob('58 0 13 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');

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

  checkSLQ.push({
    check: 1
  });
}

async function sendOrder(instrument, orderSide, orderType, limitPrice, stopPrice) {
  let optionInstrument = instruments[instrument.tradingsymbol];
  let ts = Math.round(Math.random() * 10000);
  console.time('order' + ts);
  let credentials = {
    "appKey": "7bf824e587e940854f9211",
    "secretKey": "Rhko213@OV"
  };
  let logIn = await xtsClient.logIn(credentials);
  console.log(logIn);
  let response = await xtsClient.placeOrder({
    clientID: xtsClient.clientCodes[0],
    exchangeSegment: "NSEFO",
    exchangeInstrumentID: optionInstrument.exchange_token,
    productType: "NRML",
    orderType: orderType,
    orderSide: orderSide,
    timeInForce: "DAY",
    disclosedQuantity: 0,
    limitPrice: limitPrice,
    stopPrice: stopPrice,
    orderQuantity: orderQuantity,
    orderUniqueIdentifier: strategyTag
  });
  console.log(response);
  console.timeEnd('order' + ts);
}

// let SL_percent = 1.3;
async function takeTrade(SL_percent, hedge = false) {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    let CE_opt = currentExpiryOptions[atm_strike + 'CE'];
    let PE_opt = currentExpiryOptions[atm_strike + 'PE'];

    let CE_Entry = ticksCache[CE_opt.instrument_token].last_price;
    let PE_Entry = ticksCache[PE_opt.instrument_token].last_price;
    let CE_SL = parseInt(CE_Entry * SL_percent);
    let PE_SL = parseInt(PE_Entry * SL_percent);
    await sendOrder(CE_opt, 'SELL', 'Market', 0, 0);
    await sendOrder(PE_opt, 'SELL', 'Market', 0, 0);

    await sendOrder(CE_opt, 'BUY', 'StopLimit', parseInt(CE_SL * 1.05), CE_SL);
    await sendOrder(PE_opt, 'BUY', 'StopLimit', parseInt(PE_SL * 1.05), PE_SL);

    let hedge_ce = false,
      hedge_pe = false;
    if (hedge) {
      hedge_ce = currentExpiryOptions[(atm_strike + 2000) + 'CE'];
      hedge_pe = currentExpiryOptions[(atm_strike - 2000) + 'PE'];
      let CE_Hedge_entry = parseInt(ticksCache[hedge_ce.instrument_token].last_price * 1.05);
      let PE_Hedge_entry = parseInt(ticksCache[hedge_pe.instrument_token].last_price * 1.05);
      await sendOrder(hedge_ce, 'BUY', "Limit", CE_Hedge_entry, 0);
      await sendOrder(hedge_pe, 'BUY', "Limit", PE_Hedge_entry, 0);
    }

    optionOrders.push({
      CE_SL: CE_SL,
      PE_SL: PE_SL,
      CE_Entry: CE_Entry,
      PE_Entry: PE_Entry,
      CE_opt: CE_opt,
      PE_opt: PE_opt,
      CE_token: CE_opt.instrument_token,
      PE_token: PE_opt.instrument_token,
      hedge_ce: hedge_ce,
      hedge_pe: hedge_pe
    })
  }
}

let optionOrders = [];
async function checkSL() {
  optionOrders.forEach(async (position, idx) => {
    if (position.CE_SL && ticksCache[position.CE_token].last_price > position.CE_SL) {
      position.CE_SL = false;
      // await sendOrder(position.CE_opt, 'BUY');
      if (position.hedge_ce) {
        let CE_Hedge_entry = parseInt(ticksCache[position.hedge_ce.instrument_token].last_price * 1.05);
        await sendOrder(position.hedge_ce, 'BUY', "Limit", CE_Hedge_entry, 0);
      }
    }
    if (position.PE_SL && ticksCache[position.PE_token].last_price > position.PE_SL) {
      position.PE_SL = false;
      // await sendOrder(position.PE_opt, 'BUY');
      if (position.hedge_pe) {
        let CE_Hedge_entry = parseInt(ticksCache[position.hedge_pe.instrument_token].last_price * 1.05);
        await sendOrder(position.hedge_pe, 'BUY', "Limit", CE_Hedge_entry, 0);
      }
    }
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

async function squareOff() {
  try {
    let orders;
    if (xtsClient.isInvestorClient) {
      orders = await xtsClient.getOrderBook();
      orders = orders.result;
    } else {
      orders = await xtsClient.getOrderBook({
        clientID: xtsClient.clientCodes[0]
      });
      orders = orders.result.filter(c => c.LoginID == xtsClient._userID);
    }
    let closedOrderStatus = ['Filled', 'Replaced', 'Cancelled', 'Rejected'];
    orders = orders.filter(row => (closedOrderStatus.indexOf(row.OrderStatus) == -1));
    console.log(xtsClient.clientCodes[0], 'orders', orders.length);
    for (let i = 0; i < orders.length; i++) {
      let cancelResp = await xtsClient.cancelOrder({
        appOrderID: orders[i].AppOrderID,
        orderUniqueIdentifier: orders[i].OrderUniqueIdentifier,
        clientID: orders[i].ClientID
      });
      // console.log(cancelResp);
    }

    let positions;
    if (xtsClient.isInvestorClient) {
      positions = await xtsClient.getPositions({
        dayOrNet: "NetWise"
      });
    } else {
      positions = await xtsClient.getDealerPositions({
        dayOrNet: "NetWise",
        clientID: xtsClient.clientCodes[0]
      });
    }

    // console.log(positions);
    positions = positions.result.positionList.filter((pos) => (parseInt(pos.Quantity) != 0));
    console.log('positions', positions.length);
    for (let i = 0; i < positions.length; i++) {
      let transaction_type = parseInt(positions[i].Quantity) > 0 ? 'SELL' : 'BUY';
      let max_lot_size = parseInt(instrumentsByToken[positions[i].ExchangeInstrumentId].lot_size) * 100;
      if (instrumentsByToken[positions[i].ExchangeInstrumentId].name == 'BANKNIFTY') max_lot_size = 1200;
      else if (instrumentsByToken[positions[i].ExchangeInstrumentId].name == 'NIFTY') max_lot_size = 2800;
      if (Math.abs(parseInt(positions[i].Quantity)) > max_lot_size) {
        let totalQuantity = Math.abs(parseInt(positions[i].Quantity));
        let runTimes = Math.ceil(totalQuantity / max_lot_size);

        let limitPrice = ticksCache[instrumentsByToken[positions[i].ExchangeInstrumentId].instrument_token].last_price;
        for (let j = 0; j < runTimes; j++) {
          let resp = await xtsClient.placeOrder({
            clientID: xtsClient.clientCodes[0],
            exchangeSegment: "NSEFO",
            exchangeInstrumentID: positions[i].ExchangeInstrumentId,
            productType: "NRML",
            orderType: "Market",
            orderSide: transaction_type,
            timeInForce: "DAY",
            disclosedQuantity: 0,
            limitPrice: 0,
            stopPrice: 0,
            orderQuantity: (totalQuantity > max_lot_size ? max_lot_size : totalQuantity),
            orderUniqueIdentifier: 'SQF'
          });
          totalQuantity = totalQuantity - max_lot_size;
          console.log(resp);
        }
      } else {
        let resp = await xtsClient.placeOrder({
          clientID: xtsClient.clientCodes[0],
          exchangeSegment: "NSEFO",
          exchangeInstrumentID: positions[i].ExchangeInstrumentId,
          productType: "NRML",
          orderType: "Market",
          orderSide: transaction_type,
          timeInForce: "DAY",
          disclosedQuantity: 0,
          limitPrice: 0,
          stopPrice: 0,
          orderQuantity: Math.abs(parseInt(positions[i].Quantity)),
          orderUniqueIdentifier: 'SQF'
        });
        console.log(resp);
      }
    }
  } catch (err) {
    console.log(err);
  }
}

// runStrategy();
new CronJob('0 9 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 58 14 * * 1-5', function () {
  squareOff();
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
