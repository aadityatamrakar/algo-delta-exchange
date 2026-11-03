const app = require('../server.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const OrderUpdate = app.models.OrderUpdate;
const Orderbook2 = app.models.orderbook2;
const InstrumentDb = app.models.instrument;
var XTSInteractive = require('xts-interactive-api').Interactive;
var XTSInteractiveWS = require('xts-interactive-api').WS;
const async = require('async');
const moment = require('moment');
const notify = require('../lib/notify');
const CronJob = require("cron").CronJob;
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('../tools/optionInstruments');

let instruments = {};
let zapi;
let public_token = false;
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
async function bn_ticker(subs) {
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

let n_liveFeed;
async function n_ticker(subs) {
  n_liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  n_liveFeed.connect();
  n_liveFeed.on("ticks", checkTicks);
  n_liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
    n_liveFeed.subscribe(subs);
    n_liveFeed.setMode(n_liveFeed.modeFull, subs);
  });
}

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  getPNL_Q.push({
    check: 1
  });
}

let accountPositions = {};
let accountIds = {};
async function getPositions() {
  return new Promise((resolve, reject) => {
    XtsAccount.all_positions(true, function (err, resp) {
      resp.forEach(account => {
        // console.log(account.positions);
        accountPositions[account.name] = {};
        accountIds[account.name] = String(account.accountId);
        account.positions.forEach(pos => {
          accountPositions[account.name][pos.ExchangeInstrumentId] = {
            buyValue: pos.buy_value,
            sellValue: pos.sell_value,
            buy_price: pos.buy_price,
            sell_price: pos.sell_price,
            buy_quantity: pos.buy_quantity,
            sell_quantity: pos.sell_quantity,
            quantity: pos.quantity
          };
        })
      });
      resolve();
    });
  })
}

let checkForPNL = {};

async function getPNL() {
  return new Promise((resolve, reject) => {
    async.each(Object.keys(accountPositions), function (accountName, cb) {
      if (typeof checkForPNL[accountName] == 'number') {
        let accountPnl = Object.keys(accountPositions[accountName]).reduce((total_m2m, exchangeId) => {
          let m2m = 0;
          let position = accountPositions[accountName][exchangeId];
          if (position.quantity > 0) {
            m2m = ((position.sellValue) + (Math.abs(position.quantity) * ticksCache[instruments[exchangeId]].last_price)) - (position.buyValue);
          } else if (position.quantity < 0) {
            m2m = (position.sellValue) - ((position.buyValue) + (Math.abs(position.quantity) * ticksCache[instruments[exchangeId]].last_price));
          } else {
            m2m = position.sellValue - position.buyValue;
          }

          return total_m2m += m2m;
        }, 0);

        // console.log(accountName, accountPnl);
        if (checkForPNL[accountName] < accountPnl) {
          checkForPNL[accountName] = false;
          XtsAccount.squareOff(accountIds[accountName], {}, function () {
            notify(`${accountName}: Target HIT`, 0);
          });
        }
        cb();
      } else cb();
    }, resolve);
  })
}

var getPNL_Q = async.queue(function (task, callback) {
  getPNL().then(function (res) {
    callback();
  });
}, 1);


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
    if (account.target) {
      checkForPNL[account.name] = account.target;
    } else checkForPNL[account.name] = false;
    return account.token ? {
      accountId: account.id,
      userID: account.username,
      token: account.token,
      url: account.credentials.market_url
    } : false
  }).filter(c => c);
  return accounts;
}

function updatePosition(name, token, data) {
  if (!accountPositions[name]) accountPositions[name] = {};
  accountPositions[name][token] = data;
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

async function saveOrders(orders_formatted, cbm) {
  try {
    async.eachSeries(orders_formatted, function (order_single, cb) {
      (async () => {
        let query = {
          where: {
            order_id: order_single.order_id,
            accountId: order_single.accountId
          }
        };
        let orderS = await Orderbook2.findOne(query);
        console.log(query, orderS, order_single)
        // orderS = Object.assign(orderS, order_single);
        // console.log(query, orderS)
        // if (orderS) {
        //   console.log('orderS found', orderS);
        //   orderS = Object.assign(orderS, order);
        //   let resp = await orderS.save();
        //   console.log(resp);
        //   cb();
        // } else {
        //   console.log('orderS creating');
        //   let resp = await Orderbook2.create(order);
        //   console.log(resp);
        //   cb();
        // }
        cb();
      })();
    }, function (err, resp) {
      if (err) console.log('saveOrders err', err);
      console.log('saveOrders resp', resp);
      cbm();
    });
  } catch (err) {
    console.log('saveOrders err', err);
    cbm();
  }
}

const debounced = debounce(() => {
  console.log('debounced');
  try {
    let orderbookCopy = JSON.parse(JSON.stringify(orderbook));
    orderbook = [];
    saveOrders(orderbookCopy, function () {
      console.log('saved');
    });
  } catch (err) {
    console.log('debounced err', err);
  }
}, 100);


async function addToOrderbook(orderObj) {
  console.log('addToOrderbook', orderObj)
  orderbook.push(orderObj);
  debounced();
}

let updateOrderbookConfig = [
  ["LoginID", "placed_by"],
  ["ClientID", "placed_by"],
  ["AppOrderID", "order_id"],
  ["OrderQuantity", "quantity"],
  ["OrderStatus", "status"],
  ["ExchangeOrderID", "exchange_order_id"],
  ["OrderAverageTradedPrice", "average_price"],
  ["ExchangeSegment", "exchange"],
  ["OrderSide", "transaction_type"],
  ["OrderType", "order_type"],
  ["ProductType", "product"],
  ["TimeInForce", "validity"],
  ["OrderUniqueIdentifier", "tag"],
  ["CancelRejectReason", "status_message"],
  ["OrderDisclosedQuantity", "disclosed_quantity"],
  ["OrderPrice", "price"],
  ["OrderStopPrice", "trigger_price"],
  ["ExchangeTransactTime", "order_timestamp"],
  ["ExchangeTransactTime", "exchange_timestamp"],
  ["LastUpdateDateTime", "exchange_update_timestamp"]
];

function updateOrderbookVars(data) {
  for (let i = 0; i < updateOrderbookConfig.length; i++) {
    data[updateOrderbookConfig[i][1]] = data[updateOrderbookConfig[i][0]];
    delete data[updateOrderbookConfig[i][0]];
  }
  return data;
}

function startSocket(account, cb) {
  console.log(account);
  console.log(account.url);
  let xtsInteractiveWS = new XTSInteractiveWS(account.url);
  xtsInteractiveWS.init({
    userID: account.userID,
    token: account.token
  });
  // console.log(xtsInteractiveWS, account);
  xtsInteractiveWS.onConnect((connectData) => {
    console.log(account.userID, 'connectData', connectData);
    // notify(`${account.userID}: Connected`, 0);
  });
  xtsInteractiveWS.onJoined((joinedData) => {
    console.log(account.userID, 'joinedData', joinedData);
  });
  xtsInteractiveWS.onError((errorData) => {
    console.log(account.userID, 'errorData', errorData);
  });
  xtsInteractiveWS.onDisconnect((disconnectData) => {
    console.log(account.userID, 'disconnectData', disconnectData);
    // notify(`${account.userID}: Disconnect`, 0);
  });
  xtsInteractiveWS.onOrder((orderData) => {
    try {
      let clientId = orderData.ClientID;
      let filterOrders = ["FILLED", "REJECTED"];
      let status = orderData.OrderStatus.toUpperCase();
      // try {
      //   let pushOrdersToDB = ["FILLED", "REJECTED", "REPLACED", "CANCELLED"];
      //   if (pushOrdersToDB.indexOf(status) != -1) {
      //     orderData.accountId = account.accountId;
      //     addToOrderbook(updateOrderbookVars(JSON.parse(JSON.stringify(orderData))));
      //   }
      // } catch (err) {
      //   console.log('addToOrderbook err', err);
      // }
      console.log(clientId, orderData.OrderUniqueIdentifier, orderData.OrderStatus);

      if (filterOrders.indexOf(status) != -1 && orderData.OrderUniqueIdentifier.indexOf('|') != -1) {
        let action = orderData.OrderUniqueIdentifier.split('|');
        OrderUpdate.create(Object.assign({
          updateTs: moment().utcOffset('+05:30').toDate(),
          updateType: "order",
          strategy: action[0],
          params: action.slice(1),
          status: orderData.OrderStatus,
          price: orderData.OrderAverageTradedPrice
        }, orderData));
      }
      if (status == 'REJECTED' || status == 'CANCELLED') {
        let reason = orderData.CancelRejectReason;
        let tag = orderData.OrderUniqueIdentifier;
        if (reason == "17070 : The Price is out of the current execution range") {
          notify(`${clientId} - ${tag} - Option Freeze, System will retry in 5 secs`, 0);
          setTimeout(() => {
            XtsAccount.place_order(accountIds[clientId], {
              instrumentId: orderData.ExchangeInstrumentID,
              quantity: orderData.LeavesQuantity,
              tag: tag,
              type: orderData.OrderSide,
            }, function (err, order_resp) {
              console.log(order_resp);
            })
          }, 5000);
        } else {
          if (reason != '') notify(`${clientId} - ${tag} - ${reason}`, 0);
        }
      }
    } catch (err) {
      console.log('onOrder', err);
    }
  });
  xtsInteractiveWS.onTrade((tradeData) => {
    // OrderUpdate.create(Object.assign({
    //   updateTs: moment().utcOffset('+05:30').toDate(),
    //   updateType: "trade"
    // }, tradeData));
  });
  xtsInteractiveWS.onPosition((pos) => {
    // OrderUpdate.create(Object.assign({
    //   updateTs: moment().utcOffset('+05:30').toDate(),
    //   updateType: "position"
    // }, pos));
    try {
      // console.log('before', pos.ClientID, pos.ExchangeInstrumentID, accountPositions[pos.ClientID][pos.ExchangeInstrumentID])
      updatePosition(pos.ClientID, pos.ExchangeInstrumentID, {
        buyValue: parseFloat(String(pos.BuyValue).replace(/,/g, '')),
        sellValue: parseFloat(String(pos.SellValue).replace(/,/g, '')),
        buy_price: parseFloat(String(pos.BuyAveragePrice).replace(/,/g, '')),
        sell_price: parseFloat(String(pos.SellAveragePrice).replace(/,/g, '')),
        buy_quantity: pos.LongPosition,
        sell_quantity: pos.ShortPosition,
        quantity: pos.NetPosition
      });
      // console.log('update', pos.ClientID, pos.ExchangeInstrumentID, accountPositions[pos.ClientID][pos.ExchangeInstrumentID])
    } catch (err) {
      console.log('onPosition', err);
    }
  });
  if (cb) cb();
}

async function init() {
  let optionData = await optionConfig();
  let currentExpiryOptions = optionData.weeklyInstruments;
  let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
  let b_currentExpiryOptions = optionData.nextWeekInstruments;
  let b_optionTokens = Object.values(b_currentExpiryOptions).map(c => c.instrument_token);
  let n_optionData = await optionConfig('NIFTY');
  let n_currentExpiryOptions = n_optionData.weeklyInstruments;
  let n_optionTokens = Object.values(n_currentExpiryOptions).map(c => c.instrument_token);
  let n2_currentExpiryOptions = n_optionData.nextWeekInstruments;
  let n2_optionTokens = Object.values(n2_currentExpiryOptions).map(c => c.instrument_token);

  instruments = await loadInstruments();
  // await getPositions();

  let masterId = app.get('masterId');
  let base_acc = await Account.findById(masterId);
  zapi = await zerodha_init(base_acc);
  let banknifty_tokens = [...optionTokens, ...b_optionTokens];
  let nifty_tokens = [...n_optionTokens, ...n2_optionTokens];
  console.log(banknifty_tokens.length, nifty_tokens.length);
  bn_ticker(banknifty_tokens);
  n_ticker(nifty_tokens);

  let accounts = await getTokens();
  Account.getDataSource().connector.connect(function (err, db) {
    const collection2 = db.collection("xtsAccount");
    const changeStream2 = collection2.watch();
    changeStream2.on("change", async function (event) {
      if (event.operationType == 'replace' || event.operationType == 'update') {
        let account = await XtsAccount.findById(event.documentKey._id);
        if (account && account.target && account.target > 0) {
          checkForPNL[account.name] = account.target;
          notify(`${account.name}: Target Set: ${account.target}`, 0);
        } else {
          checkForPNL[account.name] = false;
        }
      }
    });
  });
  async.each(accounts, startSocket, async function () {
    console.log('Started Socket');
  });
}

process.on('uncaughtException', function (err) {
  notify('Caught exception: ' + err.message);
});

init();
