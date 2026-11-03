'use strict';
const async = require('async');
var XTSInteractive = require('xts-interactive-api').Interactive;
const moment = require('moment');
const tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
const notify = require('./../../server/lib/notify');
let channelId = 0;

module.exports = function (Xtsaccount) {
  Xtsaccount.validatesUniquenessOf('name');
  let instrumentsBySymbol = {};
  let instrumentsByToken = {};
  let loadInstrumentsInit = async function () {
    const InstrumentDb = Xtsaccount.app.models.instrument;
    let instrumentsArr = await InstrumentDb.find();
    instrumentsArr.forEach((elm) => {
      elm.exchange_token = parseInt(elm.exchange_token);
      instrumentsByToken[elm.exchange_token] = elm;
      instrumentsBySymbol[elm.tradingsymbol] = elm;
    });
    console.log('Loadded Instruments: ', instrumentsArr.length);
  }
  setTimeout(loadInstrumentsInit, 3000);

  Xtsaccount.observe('before save', function (ctx, next) {
    if (ctx.isNewInstance) {
      try {
        let strategies = {
          'Spider': 0,
          'Strangle': 0,
          'Bently': 0,
          'Tesla': 0,
          'LowRisk': 0,
          'Pi': 0,
          'AWS': 0,
        };
        if (ctx.instance.strategy) {
          Object.assign(ctx.instance.strategy, strategies);
        } else ctx.instance.strategy = strategies;
        next();
      } catch (err) {
        console.log(err);
        next();
      }
    } else next();
  });

  async function loginClient_v2(accountId) {
    let account, xtsClient, loginResp;
    console.time('login_' + accountId);
    try {
      account = await Xtsaccount.findById(accountId);
      if (account) {
        // console.log(account);
        xtsClient = new XTSInteractive(account.credentials.url);
        if (typeof account.token != 'undefined' && account.token) {
          loginResp = await xtsClient.loginWithToken(account.username, account.token);
          // console.log('token login', JSON.stringify(loginResp, null,2));
        }

        if (loginResp && loginResp.error && loginResp.error.message && loginResp.error.message.indexOf('"e-session-') != -1) {
          console.log('Login Err: ' + account.username, loginResp);
          loginResp = false;
        }
        if (loginResp && loginResp.error && loginResp.error.message && loginResp.error.message.indexOf('"e-token-') != -1) {
          console.log('Login Err: ' + account.username, loginResp);
          loginResp = false;
        }
        if (loginResp && loginResp.error && loginResp.error.message && loginResp.error.message.indexOf('"e-user-') != -1) {
          console.log('Login Err: ' + account.username, loginResp);
          loginResp = false;
        }

        if (!loginResp || (loginResp && loginResp.type && loginResp.type != 'success')) {
          console.log('Logging in: ' + account.username);
          loginResp = await xtsClient.logIn({
            appKey: account.credentials.appKey,
            secretKey: account.credentials.secretKey
          });
          // console.log('new login', JSON.stringify(loginResp, null,2));

          if (loginResp && loginResp.type && loginResp.type == 'success') {
            // console.log('Logged in: ' + account.username);
            account.token = loginResp.result && loginResp.result.token ? loginResp.result.token : false;
            if (account.token) await account.save();
            console.timeEnd('login_' + accountId);
            // console.log(xtsClient.isInvestorClient, xtsClient.clientCodes[0]);
            return xtsClient;
          } else {
            console.timeEnd('login_' + accountId);
            return false;
          }

        } else if (loginResp && loginResp.type && loginResp.type == 'success') {
          // console.log('Token Login Success: ' + account.username);
          console.timeEnd('login_' + accountId);
          // console.log(xtsClient.isInvestorClient, xtsClient.clientCodes[0]);
          return xtsClient;
        } else {
          console.log('Login Err: ' + account.username, loginResp);
          console.timeEnd('login_' + accountId);
          return false;
        }
      } else {
        console.timeEnd('login_' + accountId);
        return false;
      }
    } catch (err) {
      console.log('Login Try Err: ' + account.username, loginResp, err);
      console.timeEnd('login_' + accountId);
      return false;
    }
  }
  Xtsaccount.loginClient_v2 = loginClient_v2;

  async function loginClient(account) {
    try {
      let xtsClient = new XTSInteractive(account.credentials.url);
      let loginResp = await xtsClient.logIn({
        appKey: account.credentials.appKey,
        secretKey: account.credentials.secretKey
      });
      if (loginResp && loginResp.type && loginResp.type == 'success') {
        return xtsClient;
      } else return false;
    } catch (err) {
      return false;
    }
  }
  Xtsaccount.loginClient = loginClient;

  Xtsaccount.check = function (account, cb) {
    (async () => {
      try {
        let login = await loginClient(account);
        if (login != false) {
          cb(null, {
            status: true,
            message: 'login success',
            userId: login.clientCodes[0]
          });
        } else {
          cb(null, {
            status: false,
            message: 'login failed'
          });
        }
      } catch (err) {
        cb(null, {
          status: false,
          message: 'something went wrong: ' + err.toString()
        });
      }

    })();
  };

  Xtsaccount.remoteMethod("check", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "account",
      type: "object"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  function placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, optionInstrument, orderType) {
    console.log(optionInstrument, orderType);
    let self = this;
    return new Promise((resolve, reject) => {
      async.each(running_accounts, function (account, cb) {
        (async () => {
          if (account_quantities[account.name]) {
            let maxQty = 100;
            if (instruments[optionInstrument.tradingsymbol].name == 'BANKNIFTY') maxQty = 48;
            else if (instruments[optionInstrument.tradingsymbol].name == 'NIFTY') maxQty = 56;
            if (account_quantities[account.name] <= maxQty) {
              let client = await self.loginClient(account);
              await placeOrder(strategyTag, client, instruments[optionInstrument.tradingsymbol], orderType, optionInstrument.lot_size * account_quantities[account.name], cb);
            } else {
              let orderTranches = tranches(account_quantities[account.name], maxQty);
              let client = await self.loginClient(account);
              async.each(orderTranches, function (orderTranch, cb2) {
                placeOrder(strategyTag, client, instruments[optionInstrument.tradingsymbol], orderType, optionInstrument.lot_size * orderTranch, cb2);
              }, cb);
            }
          } else cb();
        })();
      }, function () {
        resolve();
      });
    })
  }

  async function placeOrder(strategyTag, client, instrumentId, orderType, lotSize, cb) {
    console.log(instrumentId, orderType, lotSize);
    let orderResp = await client.placeOrder({
      clientID: client.clientCodes[0],
      exchangeSegment: "NSEFO",
      exchangeInstrumentID: instrumentId,
      productType: "NRML",
      orderType: "MARKET",
      orderSide: orderType,
      timeInForce: "DAY",
      disclosedQuantity: 0,
      limitPrice: 0,
      stopPrice: 0,
      orderQuantity: lotSize,
      orderUniqueIdentifier: strategyTag
    });
    console.log(orderResp);
    cb();
  }
  Xtsaccount.placeOrder = placeOrder;
  Xtsaccount.placeAllAccount = placeAllAccount;

  async function loadAccounts(strategyTag) {
    return new Promise(async (resolve, reject) => {
      let accounts = await Xtsaccount.find({});
      let account_quantities = accounts.reduce((lotSize, elm) => {
        if (elm.strategy && elm.strategy[strategyTag]) {
          lotSize[elm.name] = parseInt(elm.strategy[strategyTag]);
        }
        return lotSize;
      }, {});
      let combineTotalLots = Object.values(account_quantities).reduce((s, a) => (s += a, s), 0);
      resolve({
        accounts,
        account_quantities
      });
    })
  }
  Xtsaccount.loadAccounts = loadAccounts;

  async function loadInstruments(nearestExpiry) {
    return new Promise(async function (resolve, reject) {
      let InstrumentDb = Xtsaccount.app.models.instrument;
      let instruments = await InstrumentDb.find({
        where: {
          expiry: nearestExpiry
        }
      });
      instruments = instruments.reduce((ob, elm) => {
        ob[elm.tradingsymbol] = parseInt(elm.exchange_token);
        return ob;
      }, {});
      resolve(instruments);
    });
  }
  Xtsaccount.loadInstruments = loadInstruments;

  let all_position_cache = [];
  let lastRefreshTime = 0;
  Xtsaccount.all_positions = function (forceRefresh, cb) {
    let reqTime = moment().format('X');
    if ((reqTime - lastRefreshTime) > 300 || forceRefresh) {
      (async () => {
        let accounts = await Xtsaccount.find();
        // console.log(accounts.length);
        async.map(accounts, function (account, cb2) {
          (async () => {
            let resp = {
              accountId: account.id,
              name: account.name,
              username: account.username,
              fullname: account.username,
              strategy: account.strategy,
              positions: [],
              orders: [],
              platform: 'xts'
            };
            try {
              let client = await loginClient_v2(account.id);
              if (client) {
                let positions = await getPositions(client);
                let orders = await getOrders(client);
                resp.positions = positions;
                resp.orders = orders;
                cb2(null, resp);
              } else {
                cb2(null, resp);
              }
            } catch (err) {
              console.log(err);
              cb2(null, resp);
            }
          })();
        }, function (err, resp) {
          if (err) cb(err);
          else {
            resp = resp.filter(c => c);
            all_position_cache = resp;
            lastRefreshTime = reqTime;
            cb(err, resp);
          }
        });
      })();
    } else {
      cb(null, all_position_cache);
    }
  };

  Xtsaccount.remoteMethod("all_positions", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "forceRefresh",
      type: "boolean",
      default: false
    }],
    returns: {
      type: "array",
      root: true
    }
  });

  async function clearPending(client, strategy, cb) {
    try {

      let orders;
      if (client.isInvestorClient) {
        orders = await client.getOrderBook();
        orders = orders.result;
      } else {
        orders = await client.getOrderBook({
          clientID: client.clientCodes[0]
        });
        orders = orders.result.filter(c => c.LoginID == client._userID);
      }

      let closedOrderStatus = ['Filled', 'Replaced', 'Cancelled', 'Rejected'];
      if (strategy) {
        orders = orders.filter(row => {
          if (row.OrderUniqueIdentifier.indexOf('|') == -1) {
            return row.OrderUniqueIdentifier == strategy && closedOrderStatus.indexOf(row.OrderStatus) == -1;
          } else {
            return row.OrderUniqueIdentifier.split('|')[0] == strategy && closedOrderStatus.indexOf(row.OrderStatus) == -1;
          }
        });
      } else {
        orders = orders.filter(row => (closedOrderStatus.indexOf(row.OrderStatus) == -1));
      }
      console.log(client.clientCodes[0], 'orders', orders.length);
      for (let i = 0; i < orders.length; i++) {
        let cancelResp = await client.cancelOrder({
          appOrderID: orders[i].AppOrderID,
          orderUniqueIdentifier: orders[i].OrderUniqueIdentifier,
          clientID: orders[i].LoginID || orders[i].ClientID
        });
      }
      cb();
    } catch (err) {
      console.log(err);
    }
  }

  async function closePositions(client, cb) {
    try {
      let orders;
      if (client.isInvestorClient) {
        orders = await client.getOrderBook();
        orders = orders.result;
      } else {
        orders = await client.getOrderBook({
          clientID: client.clientCodes[0]
        });
        orders = orders.result.filter(c => c.LoginID == client._userID);
      }
      let closedOrderStatus = ['Filled', 'Replaced', 'Cancelled', 'Rejected'];
      orders = orders.filter(row => (closedOrderStatus.indexOf(row.OrderStatus) == -1));
      console.log(client.clientCodes[0], 'orders', orders.length);
      for (let i = 0; i < orders.length; i++) {
        let cancelResp = await client.cancelOrder({
          appOrderID: orders[i].AppOrderID,
          orderUniqueIdentifier: orders[i].OrderUniqueIdentifier,
          clientID: orders[i].ClientID
        });
        // console.log(cancelResp);
      }

      let positions;
      if (client.isInvestorClient) {
        positions = await client.getPositions({
          dayOrNet: "NetWise"
        });
      } else {
        positions = await client.getPositions({
          dayOrNet: "NetWise",
          clientID: client.clientCodes[0]
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

          for (let j = 0; j < runTimes; j++) {
            let resp = await client.placeOrder({
              clientID: client.clientCodes[0],
              exchangeSegment: "NSEFO",
              exchangeInstrumentID: positions[i].ExchangeInstrumentId,
              productType: "NRML",
              orderType: "MARKET",
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
          let resp = await client.placeOrder({
            clientID: client.clientCodes[0],
            exchangeSegment: "NSEFO",
            exchangeInstrumentID: positions[i].ExchangeInstrumentId,
            productType: "NRML",
            orderType: "MARKET",
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

      cb();
    } catch (err) {
      console.log(err);
      cb();
    }
  }


  Xtsaccount.place_order = function (accountId, order_options, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        console.log(accountId, client);
        if (client) {
          let orderTag = 'ADMIN';
          if (order_options.tag) orderTag = order_options.tag;
          placeOrder(orderTag, client, order_options.instrumentId, order_options.type, order_options.quantity, cb)
        } else {
          cb(null, {
            status: false
          });
        }
      } else {
        cb(null, {
          status: false
        });
      }
    })();
  };

  Xtsaccount.remoteMethod("place_order", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }, {
      arg: "order",
      type: "object"
    }],
    returns: {
      type: "object",
      root: true
    }
  });


  Xtsaccount.removePending = function (accountId, strategy, cb) {
    (async () => {
      console.log(accountId);
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        console.log(accountId, client);
        if (client) {
          clearPending(client, strategy, function () {
            cb(null, {
              status: true
            });
          });
        } else {
          cb(null, {
            status: false
          });
        }
      } else {
        cb(null, {
          status: false
        });
      }
    })();
  };

  Xtsaccount.remoteMethod("removePending", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }, {
      arg: "strategy",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Xtsaccount.clearPending = clearPending;

  Xtsaccount.squareOff = function (accountId, options, cb) {
    (async () => {
      console.log(accountId);
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        console.log(accountId, client);
        if (client) {
          closePositions(client, async function () {
            let account = await Xtsaccount.findById(accountId);
            try {
              if (typeof account.bkp_strategy != 'object') account.bkp_strategy = {};
              Object.keys(account.strategy).forEach(s => {
                if (parseInt(account.strategy[s]) > 0) {
                  account.bkp_strategy[s] = parseInt(account.strategy[s]);
                  account.strategy[s] = 0;
                }
              });
              await account.save();
            } catch (err) {
              console.log(err);
            }
            cb(null, {
              status: true
            });
          });
        } else {
          cb(null, {
            status: false
          });
        }
      } else {
        cb(null, {
          status: false
        });
      }
    })();
  };

  Xtsaccount.remoteMethod("squareOff", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }, {
      arg: "options",
      type: "object",
      http: "optionsFromRequest"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Xtsaccount.closePositions = closePositions;

  let updatePositionsConfig = [
    ["TradingSymbol", "tradingsymbol"],
    ["ExchangeSegment", "exchange"],
    ["ProductType", "product"],
    ["Multiplier", "multiplier"],
    ["BuyAveragePrice", "buy_price"],
    ["SellAveragePrice", "sell_price"],
    ["OpenBuyQuantity", "buy_quantity"],
    ["OpenSellQuantity", "sell_quantity"],
    ["Quantity", "quantity"],
    ["BuyAmount", "buy_value"],
    ["SellAmount", "sell_value"],
    ["NetAmount", "value"],
    ["UnrealizedMTM", "unrealised"],
    ["RealizedMTM", "realised"],
    ["SumOfTradedQuantityAndPriceBuy", "day_buy_value"],
    ["SumOfTradedQuantityAndPriceSell", "day_sell_value"]
  ];

  function updatePositionsVars(data) {
    for (let i = 0; i < updatePositionsConfig.length; i++) {
      data[updatePositionsConfig[i][1]] = data[updatePositionsConfig[i][0]];
      delete data[updatePositionsConfig[i][0]];
    }
    return data;
  }

  async function getPositions(client) {
    let positions;
    if (client.isInvestorClient) {
      positions = await client.getPositions({
        dayOrNet: "NetWise"
      });
    } else {
      positions = await client.getPositions({
        dayOrNet: "NetWise",
        clientID: client.clientCodes[0]
      });
    }

    if (positions && positions.type && positions.type == 'success') {
      positions = positions.result.positionList;
      positions = positions.map(updatePositionsVars);
      positions = positions.map(position => {
        try {
          position.instrument_token = instrumentsByToken[position.ExchangeInstrumentId].instrument_token;
          position.sell_price = parseFloat(String(position.sell_price).replace(/,/g, ''));
          position.buy_price = parseFloat(String(position.buy_price).replace(/,/g, ''));
          position.sell_value = parseFloat(String(position.sell_value).replace(/,/g, ''));
          position.buy_value = parseFloat(String(position.buy_value).replace(/,/g, ''));
          position.sell_quantity = parseFloat(String(position.sell_quantity).replace(/,/g, ''));
          position.buy_quantity = parseFloat(String(position.buy_quantity).replace(/,/g, ''));
          position.day_sell_price = parseFloat(String(position.sell_price).replace(/,/g, ''));
          position.day_buy_price = parseFloat(String(position.buy_price).replace(/,/g, ''));
          position.day_sell_quantity = parseFloat(String(position.sell_quantity).replace(/,/g, ''));
          position.day_buy_quantity = parseFloat(String(position.buy_quantity).replace(/,/g, ''));
          position.quantity = parseFloat(String(position.quantity).replace(/,/g, ''));
          position.m2m = parseFloat(String(position.value).replace(/,/g, ''));
          return position;
        } catch (err) {
          console.log(position);
          console.log(err);
          return false;
        }
      }).filter(c => c);
      return positions;
    } else return {};
  }
  Xtsaccount.getPositions = getPositions;

  Xtsaccount.positions = function (accountId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          console.time('getPositions_' + accountId);
          let positions = await getPositions(client);
          console.timeEnd('getPositions_' + accountId);
          cb(null, positions);
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Xtsaccount.remoteMethod("positions", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }],
    returns: {
      type: "array",
      root: true
    }
  });

  Xtsaccount.allMargins = function (cb) {
    (async () => {
      let accounts = await Xtsaccount.find();
      // console.log(accounts.length);
      async.mapLimit(accounts, 10, function (account, cb2) {
        (async () => {
          try {
            let netAvailable, balance;
            let client = await loginClient_v2(account.id);
            if (client) {
              try {
                balance = await client.getBalance({
                  clientID: client.clientCodes[0]
                });
                netAvailable = balance.result.BalanceList[0].limitObject.RMSSubLimits.netMarginAvailable;
                account.margin = netAvailable;
                await account.save();
                cb2(null, {
                  available: netAvailable
                });
              } catch (err) {
                console.log(err);
                cb2(null, {
                  status: false,
                  err: err
                });
              }
            } else {
              cb2(null, {
                status: false,
                err: 'Login Failed'
              });
            }
          } catch (err) {
            console.log(err);
            cb2(null, {
              status: false,
              err: err
            });
          }
        })();
      }, function (err, resp) {
        if (err) cb(err);
        cb(null, {
          status: true
        });
      });
    })();
  };

  Xtsaccount.remoteMethod("allMargins", {
    http: {
      verb: "post"
    },
    accepts: [],
    returns: {
      type: "array",
      root: true
    }
  });

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


  async function getOrders(client) {
    let orders;
    try {
      if (client.isInvestorClient) {
        orders = await client.getOrderBook();
        orders = orders.result;
      } else {
        orders = await client.getOrderBook({
          clientID: client.clientCodes[0]
        });
        orders = orders.result.filter(c => c.LoginID == client._userID);
      }

      orders = orders.map(updateOrderbookVars);
      orders.forEach(order => {
        try {
          order.instrument_token = instrumentsByToken[order.ExchangeInstrumentID].instrument_token;
          order.tradingsymbol = instrumentsByToken[order.ExchangeInstrumentID].tradingsymbol;
          order.average_price = parseFloat(String(order.average_price).replace(/,/g, ''));
        } catch (err) {

        }
      });
      return orders;
    } catch (err) {
      console.log(err);
      return {};
    };
  }
  Xtsaccount.getOrders = getOrders;

  Xtsaccount.orderbook = function (accountId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          console.time('getOrders_' + accountId);
          let orders = await getOrders(client);
          console.timeEnd('getOrders_' + accountId);
          cb(null, orders);
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Xtsaccount.remoteMethod("orderbook", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }],
    returns: {
      type: "array",
      root: true
    }
  });
};
