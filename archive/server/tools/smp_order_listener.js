const app = require('../server.js');
const XtsAccount = app.models.xtsAccount;
const OrderUpdate = app.models.OrderUpdate;
const InstrumentDb = app.models.instrument;
var XTSInteractive = require('xts-interactive-api').Interactive;
var XTSInteractiveWS = require('xts-interactive-api').WS;
const async = require('async');
const moment = require('moment');
const notify = require('../lib/notify.js');

let instruments = {}, accounts = [];
async function loadInstruments() {
  return new Promise(async function (resolve, reject) {
    let instrumentsArr = await InstrumentDb.find();
    instrumentsArr = instrumentsArr.reduce((ob, elm) => {
      ob[elm.exchange_token] = elm.instrument_token;
      return ob;
    }, {});
    resolve(instrumentsArr);
  });
}

async function getTokens() {
  let accounts = await XtsAccount.find({});
  accounts = accounts.map(account => {
    return account.token ? {
      accountId: account.id,
      userID: account.username,
      token: account.token,
      url: account.credentials.url,
      host: account.hostlookup
    } : false
  }).filter(c => c);
  return accounts;
}

function startSocket(account, cb) {
  console.log(account);
  console.log(account.url);
  let xtsInteractiveWS = new XTSInteractiveWS("https://smpa.jainam.in:6543");
  xtsInteractiveWS.init({
    userID: account.userID,
    token: account.token
  });
  // console.log(xtsInteractiveWS, account);
  xtsInteractiveWS.onConnect((connectData) => {
    console.log(account.userID, 'connectData', connectData);
    notify(`${account.userID} - Connected to XTS, order tracking service`, 0);
  });
  xtsInteractiveWS.onJoined((joinedData) => {
    console.log(account.userID, 'joinedData', joinedData);
  });
  xtsInteractiveWS.onError((errorData) => {
    console.log(account.userID, 'errorData', errorData);
  });
  xtsInteractiveWS.onDisconnect((disconnectData) => {
    console.log(account.userID, 'disconnectData', disconnectData);
    setTimeout(() => {
      notify(`${account.userID} - Disconnected from XTS, trying to reconnect...order tracking service`, 0);
      process.exit(1);
    }, 3000);
  });
  xtsInteractiveWS.onOrder((orderData) => {
    try {
      let clientId = orderData.ClientID;
      let filterOrders = ["FILLED", "REJECTED"];
      let status = orderData.OrderStatus.toUpperCase();
      console.log(clientId, orderData.OrderUniqueIdentifier, orderData.OrderStatus);

      if (orderData.OrderStatus == "REJECTED") {
        notify(`${clientId} - Order Rejected: ${orderData.OrderUniqueIdentifier} | Symbol: ${orderData.TradingSymbol} | Side: ${orderData.OrderSide} | Qty: ${orderData.OrderQuantity} | Type: ${orderData.OrderType}`, 0);
      }

      if (filterOrders.indexOf(status) != -1 && orderData.OrderUniqueIdentifier.indexOf('|') != -1) {
        let action = orderData.OrderUniqueIdentifier.split('|');
        console.log('action', action);
        OrderUpdate.create(Object.assign({
          updateTs: moment().utcOffset('+05:30').toDate(),
          updateType: "order",
          strategy: action[0],
          params: action.slice(1),
          status: orderData.OrderStatus,
          price: orderData.OrderAverageTradedPrice
        }, orderData));
      }
    } catch (err) {
      console.log('onOrder', err);
    }
  });
  xtsInteractiveWS.onTrade((tradeData) => { });
  xtsInteractiveWS.onPosition((pos) => { });
  if (cb) cb();
}

async function init() {
  instruments = await loadInstruments();
  // await getPositions();

  accounts = await getTokens();
  async.each(accounts, startSocket, async function () {
    console.log('Started Socket');
  });
}

process.on('uncaughtException', function (err) {
  notify('Caught exception: ' + err.message);
});

init();
