'use strict';
const async = require('async');
var XTSInteractive = require('xts-interactive-api').Interactive;
const moment = require('moment');
const tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
const notify = require('./../../server/lib/notify');
const OptionAnalysis = require('./../../server/tools/position_analyse');
let channelId = 0;

module.exports = function (Xtsaccount) {
  Xtsaccount.validatesUniquenessOf('name');
  let instrumentsBySymbol = {};
  let instrumentsByToken = {};
  let allInstruments = [];
  let loadInstrumentsInit = async function () {
    const InstrumentDb = Xtsaccount.app.models.instrument;
    allInstruments = await InstrumentDb.find();
    allInstruments.forEach((elm) => {
      elm.exchange_token = parseInt(elm.exchange_token);
      instrumentsByToken[elm.exchange_token] = elm;
      instrumentsBySymbol[elm.tradingsymbol] = elm;
    });
    console.log('Loadded Instruments: ', allInstruments.length);
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
    // console.time('login_' + accountId);
    try {
      account = await Xtsaccount.findById(accountId);
      if (account) {
        // console.log(account);
        xtsClient = new XTSInteractive(account.credentials.url);
        if (typeof account.token != 'undefined' && account.token) {
          xtsClient.userID = account.username;
          xtsClient.token = account.token;
          xtsClient.enums = {};
          if (account.clientCode) xtsClient.clientCodes = [account.clientCode];
          else {
            xtsClient.clientCodes = [account.username];
            account.clientCode = account.username;
          }
          xtsClient._token = account.token;
          xtsClient.creds = account.credentials;
          xtsClient.xtsAccountId = accountId;
          if (account.clientCode) {
            if (account.clientCode === '*****') xtsClient.isInvestorClient = false;
            else
              xtsClient.isInvestorClient = account.clientCode == account.username ? true : false;
          } else xtsClient.isInvestorClient = true;
          xtsClient.isLoggedIn = true;
          loginResp = {
            type: "success"
          };
          // loginResp = await xtsClient.loginWithToken(account.username, account.token);
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
          if (account.hostlookup) {
            let tmp_xtsClient = new XTSInteractive(account.hostlookup);
            let lookup = await tmp_xtsClient.hostLookup();
            console.log('hostLookup', JSON.stringify(lookup, null, 2));
            account.credentials.url = lookup.connectionString;
            xtsClient.url = lookup.connectionString;
            account.credentials.uniqueKey = lookup.uniqueKey;
          }
          let loginData = {
            appKey: account.credentials.appKey,
            secretKey: account.credentials.secretKey
          };
          if (account.credentials.uniqueKey) loginData.uniqueKey = account.credentials.uniqueKey;
          loginResp = await xtsClient.logIn(loginData);
          console.log('new login', JSON.stringify(loginResp, null, 2));

          if (loginResp && loginResp.type && loginResp.type == 'success') {
            console.log('Logged in: ' + account.username);
            account.token = loginResp.result && loginResp.result.token ? loginResp.result.token : false;
            if (account.token) await account.save();
            console.timeEnd('login_' + accountId);
            console.log(xtsClient.isInvestorClient, xtsClient.clientCodes[0]);
            return xtsClient;
          } else {
            if (loginResp && loginResp.error && loginResp.error.message && loginResp.error.message.indexOf('"e-user-0016') != -1) {
              notify(account.username + ': API Key Expired, Kindly renew');
            }
            // console.timeEnd('login_' + accountId);
            return false;
          }

        } else if (loginResp && loginResp.type && loginResp.type == 'success') {
          // console.log('Token Login Success: ' + account.username);
          // console.timeEnd('login_' + accountId);
          // console.log(xtsClient.isInvestorClient, xtsClient.clientCodes[0]);
          return xtsClient;
        } else {
          console.log('Login Err: ' + account.username, loginResp);
          // console.timeEnd('login_' + accountId);
          return false;
        }
      } else {
        // console.timeEnd('login_' + accountId);
        return false;
      }
    } catch (err) {
      console.log('Login Try Err: ' + account.username, loginResp, err);
      // console.timeEnd('login_' + accountId);
      return false;
    }
  }
  Xtsaccount.loginClient_v2 = loginClient_v2;

  async function retryLogin(client) {
    let loginData = {
      appKey: client.creds.appKey,
      secretKey: client.creds.secretKey
    }
    if (client.creds.uniqueKey) loginData.uniqueKey = client.creds.uniqueKey;
    let loginResp = await client.logIn(loginData);
    if (loginResp && loginResp.type && loginResp.type == 'success') {
      let account = await Xtsaccount.findById(client.xtsAccountId);
      account.token = loginResp.result && loginResp.result.token ? loginResp.result.token : false;
      await account.save();
      return client;
    } else false;
  }

  async function loginClient(account) {
    try {
      console.log('Logging in: ', account);
      if (account.hostlookup) {
        let tmp_xtsClient = new XTSInteractive(account.hostlookup);
        let lookup = await tmp_xtsClient.hostLookup();
        account.credentials.url = lookup.connectionString;
        account.credentials.uniqueKey = lookup.uniqueKey;
      }
      let xtsClient = new XTSInteractive(account.credentials.url);
      let loginData = {
        appKey: account.credentials.appKey,
        secretKey: account.credentials.secretKey
      };
      // uniqueKey: account.credentials.uniqueKey
      if (account.credentials.uniqueKey) loginData.uniqueKey = account.credentials.uniqueKey;
      let loginResp = await xtsClient.logIn(loginData);
      if (loginResp && loginResp.type && loginResp.type == 'success') {
        return { status: true, client: xtsClient };
      } else {
        console.log('log', loginResp);
        return { status: false, error: loginResp?.error?.message };
      }
    } catch (err) {
      console.log('err', err);
      return false;
    }
  }
  Xtsaccount.loginClient = loginClient;

  Xtsaccount.check = function (account, cb) {
    (async () => {
      try {
        let login = await loginClient(account);
        if (login.status) {
          cb(null, {
            status: login.status,
            message: 'login success',
            userId: login.client._userID
          });
        } else {
          cb(null, {
            status: login.status,
            message: 'login failed, Error: ' + login.error
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
      async.each(running_accounts, function (accountObj, cb) {
        (async () => {
          if (account_quantities[accountObj.account.name]) {
            let maxQty = 20;
            if (optionInstrument.tradingsymbol.indexOf('BANKNIFTY') === 0) maxQty = 25;
            else if (optionInstrument.tradingsymbol.indexOf('NIFTY') === 0) maxQty = 24;
            if (account_quantities[accountObj.account.name] <= maxQty) {
              let client = accountObj.client;
              await placeOrder(strategyTag, client, instruments[optionInstrument.tradingsymbol], orderType, optionInstrument.lot_size * account_quantities[accountObj.account.name], cb);
            } else {
              let orderTranches = tranches(account_quantities[accountObj.account.name], maxQty);
              let client = accountObj.client;
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
    let uniqueId = parseInt(Math.random() * 99999);
    try {
      console.log('order sending: ' + uniqueId, moment().utc().add(330, 'minutes').format('HH:mm:ss'));
      console.log(strategyTag, instrumentsByToken[instrumentId].tradingsymbol, orderType, lotSize);
    } catch (err) { }
    let orderResp = await client.placeOrder({
      clientID: client.clientCodes[0],
      exchangeSegment: instrumentsByToken[instrumentId].name == 'SENSEX' ? "BSEFO": "NSEFO",
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
    try {
      console.log('order response received: ' + uniqueId, moment().utc().add(330, 'minutes').format('HH:mm:ss'));
    } catch (err) { }
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

  async function loadAccounts2(strategyTag) {
    return new Promise(async (resolve, reject) => {
      let xts_running_accounts = {};
      let accounts = await Xtsaccount.find({});

      let account_quantities = accounts.reduce((lotSize, elm) => {
        if (elm.strategy && elm.strategy[strategyTag]) {
          lotSize[elm.name] = parseInt(elm.strategy[strategyTag]);
        }
        return lotSize;
      }, {});

      async.each(accounts, function (account, cb) {
        (async () => {
          let xtsClient = await Xtsaccount.loginClient_v2(account.id);

          xts_running_accounts[account.name] = {
            client: xtsClient,
            account: account
          };
          cb();
        })();
      }, function () {
        let resp = {
          running_accounts: xts_running_accounts,
          account_quantities
        }
        resolve(resp);
      });
    });
  }
  Xtsaccount.loadAccounts2 = loadAccounts2;

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

  async function loadInstruments2() {
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
  Xtsaccount.loadInstruments2 = loadInstruments2;

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
              name: account.clientName || account.name,
              username: account.username,
              margin: account.margin || 0,
              fullname: account.clientName || account.name,
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

  Xtsaccount.all_positions_only = function (cb) {
    (async () => {
      let accounts = await Xtsaccount.find();

      async.map(accounts, function (account, cb2) {
        (async () => {
          let resp = {
            accountId: account.id,
            name: account.clientName || account.name,
            username: account.username,
            margin: account.margin || 0,
            fullname: account.clientName || account.name,
            strategy: account.strategy,
            positions: [],
            orders: [],
            platform: 'xts'
          };
          try {
            let client = await loginClient_v2(account.id);
            if (client) {
              let positions = await getPositions(client);
              // let orders = await getOrders(client);
              resp.positions = positions;
              // resp.orders = orders;
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
          cb(err, resp);
        }
      });
    })();
  };

  Xtsaccount.remoteMethod("all_positions_only", {
    http: {
      verb: "post"
    },
    accepts: [],
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
        orders = await client.getDealerOrders({
          clientID: client.clientCodes[0]
        });
        orders = orders.result;
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
          clientID: orders[i].ClientID
        });
      }
      cb();
    } catch (err) {
      console.log(err);
    }
  }

  async function closePositions(client, cb) {
    try {
      let positions;
      if (client.isInvestorClient) {
        positions = await client.getPositions({
          dayOrNet: "DayWise",
          clientID: client.clientCodes[0]
        });
      } else {
        positions = await client.getDealerPositions({
          dayOrNet: "DayWise",
          clientID: client.clientCodes[0]
        });
      }

      // console.log(positions);
      positions = positions.result.positionList.filter((pos) => (parseInt(pos.Quantity) != 0));
      console.log('positions', positions.length);
      for (let i = 0; i < positions.length; i++) {
        let transaction_type = parseInt(positions[i].Quantity) > 0 ? 'SELL' : 'BUY';
        let max_lot_size = parseInt(instrumentsByToken[positions[i].ExchangeInstrumentId].lot_size) * 100;
        if (instrumentsByToken[positions[i].ExchangeInstrumentId].name == 'BANKNIFTY') max_lot_size = 600;
        else if (instrumentsByToken[positions[i].ExchangeInstrumentId].name == 'NIFTY') max_lot_size = 1800;
        else if (instrumentsByToken[positions[i].ExchangeInstrumentId].name == 'SENSEX') max_lot_size = 1000;
        if (Math.abs(parseInt(positions[i].Quantity)) > max_lot_size) {
          let totalQuantity = Math.abs(parseInt(positions[i].Quantity));
          let runTimes = Math.ceil(totalQuantity / max_lot_size);

          for (let j = 0; j < runTimes; j++) {
            let resp = await client.placeOrder({
              clientID: client.clientCodes[0],
              exchangeSegment: instrumentsByToken[positions[i].ExchangeInstrumentId].name == 'SENSEX' ? "BSEFO": "NSEFO",
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

      let orders;
      if (client.isInvestorClient) {
        orders = await client.getOrderBook();
      } else {
        orders = await client.getDealerOrders({
          clientID: client.clientCodes[0]
        });
      }
      orders = orders.result;
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

  async function getPositions(client, retryOn = true) {
    let positions;
    if (client.isInvestorClient) {
      positions = await client.getPositions({
        dayOrNet: "DayWise",
        clientID: client.clientCodes[0]
      });
    } else {
      positions = await client.getDealerPositions({
        dayOrNet: "DayWise",
        clientID: client.clientCodes[0]
      });
    }

    // if (positions && positions.name == 'CustomError') return [];

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
          // console.log(position);
          // console.log(err);
          return false;
        }
      }).filter(c => c);
      return positions;
    } else {
      console.log('positions err', positions, client.isInvestorClient);
      if (retryOn) {
        client = await retryLogin(client);
        if (client) {
          return await getPositions(client, false);
        } else return [];
      } else return [];
    };
  }
  Xtsaccount.getPositions = getPositions;

  Xtsaccount.positions = function (accountId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          // console.time('getPositions_' + accountId);
          let positions = await getPositions(client);
          // console.timeEnd('getPositions_' + accountId);
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
                  clientID: account.username
                });
                netAvailable = balance.result.BalanceList[0].limitObject.RMSSubLimits.netMarginAvailable;
                account.margin = netAvailable;
                await account.save();
                cb2(null, {
                  available: netAvailable
                });
              } catch (err) {
                console.log(account, err, balance);
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
            console.log(account, err);
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


  async function getOrders(client, retryOn = true) {
    let orders = [];
    try {
      // console.log('getOrders', client.clientCodes);
      // if (orders && orders.name == 'CustomError') return [];

      if (client.isInvestorClient) {
        orders = await client.getOrderBook({
          clientID: client.clientCodes[0]
        });
      } else {
        try {
          orders = await client.getDealerOrders({
            clientID: client.clientCodes[0]
          });
        } catch (err) {
          console.log('get dealer orders', err);
          return [];
        }
      }

      orders = orders.result;
      if (orders && orders.length == 0) return [];
      if (!orders) {
        console.log('get orders err', orders);
        return [];
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
      console.log('get orders err', err);
      if (retryOn) {
        client = await retryLogin(client);
        if (client) {
          return await getOrders(client, false);
        } else return [];
      } else return [];
    };
  }
  Xtsaccount.getOrders = getOrders;

  Xtsaccount.orderbook = function (accountId, cb) {
    const Orderbook2 = Xtsaccount.app.models.orderbook2;
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          // console.time('getOrders_' + accountId);
          let orders = await getOrders(client);
          await Orderbook2.destroyAll({
            accountId: String(accountId)
          });
          orders = orders.map(order => {
            order.accountId = String(accountId);
            return order;
          });
          // save new orders
          await Orderbook2.create(orders);
          // console.timeEnd('getOrders_' + accountId);
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

  Xtsaccount.position2 = function (accountId, cb) {
    const Orderbook2 = Xtsaccount.app.models.orderbook2;
    (async () => {
      if (accountId && accountId.length == 24) {
        let orders = await Orderbook2.find({
          where: {
            accountId: accountId
          }
        });

        console.log(orders.length);

        let account_positions = {};
        orders.forEach((order) => {
          if (order.status == 'Filled') {
            if (!account_positions[order.tradingsymbol]) {
              account_positions[order.tradingsymbol] = {
                "tradingsymbol": order.tradingsymbol,
                "instrument_token": order.instrument_token,
                "quantity": order.transaction_type == 'SELL' ? -1 * order.quantity : order.quantity,
                "average_price": order.average_price,
                "last_price": order.average_price,
                "m2m": 0,
                "sell_quantity": 0,
                "sell_price": 0,
                "sell_value": 0,
                "buy_quantity": 0,
                "buy_price": 0,
                "buy_value": 0,
              };

              account_positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_quantity"] = order.quantity;
              account_positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_price"] = order.average_price;
              account_positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_value"] = order.average_price * order.quantity;
            } else {
              if (order.transaction_type == 'SELL') {
                account_positions[order.tradingsymbol].quantity += -1 * order.quantity;
                account_positions[order.tradingsymbol].sell_quantity += order.quantity;
                account_positions[order.tradingsymbol].sell_value += Math.round(order.quantity * order.average_price);
                account_positions[order.tradingsymbol].sell_price = Math.round(account_positions[order.tradingsymbol].sell_value / account_positions[order.tradingsymbol].sell_quantity * 100) / 100;
              } else {
                account_positions[order.tradingsymbol].quantity += order.quantity;
                account_positions[order.tradingsymbol].buy_quantity += order.quantity;
                account_positions[order.tradingsymbol].buy_value += Math.round(order.quantity * order.average_price);
                account_positions[order.tradingsymbol].buy_price = Math.round(account_positions[order.tradingsymbol].buy_value / account_positions[order.tradingsymbol].buy_quantity * 100) / 100;
              }
            }

            if (account_positions[order.tradingsymbol].quantity == 0) {
              account_positions[order.tradingsymbol].m2m = account_positions[order.tradingsymbol].sell_value - account_positions[order.tradingsymbol].buy_value;
            }
          }
        });

        cb(null, { position: Object.values(account_positions), orders });
      } else cb(null, {});
    })();
  };

  Xtsaccount.remoteMethod("position2", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Xtsaccount.sync_orderbook = function (accountId, cb) {
    const Orderbook2 = Xtsaccount.app.models.orderbook2;
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          // console.time('getOrders_' + accountId);
          let orders = await getOrders(client);
          // remove old orders
          await Orderbook2.destroyAll({
            accountId: String(accountId)
          });
          orders = orders.map(order => {
            order.accountId = String(accountId);
            return order;
          });
          // save new orders
          await Orderbook2.create(orders);
          // console.timeEnd('getOrders_' + accountId);
          cb(null, orders);
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Xtsaccount.remoteMethod("sync_orderbook", {
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

  Xtsaccount.backfill_orderbook = function (accountId, cb) {
    const Orderbook2 = Xtsaccount.app.models.orderbook2;
    (async () => {
      if (accountId && accountId.length == 24) {
        let ignore_order_status = ["Filled", "Replaced", "Cancelled", "Rejected"];
        let orders = await Orderbook2.find({
          where: {
            accountId: accountId,
            status: {
              nin: ignore_order_status
            }
          }
        });
        if (orders.length > 0) {
          let client = await loginClient_v2(accountId);
          async.eachLimit(orders, 3, (order, next) => {
            (async () => {
              let resp = await client.getOrderHistory(order.order_id);
              if (resp.code == "s-orders-0001" && resp.result.length > 0) {
                const orderDetails = resp.result[resp.result.length - 1];
                order = Object.assign(order, updateOrderbookVars(orderDetails));
                // console.log(order);
                order.average_price = parseInt(order.average_price);
                order.price = order.average_price;
                await order.save();
                next(null, true);
              }
            })();
          }, async function (err, resp) {
            if (err) console.log(err);
            cb(null, { count: orders.length });
          });
        } else cb(null, { count: 0 });
      } else cb(null, { count: 0 });
    })();
  };

  Xtsaccount.remoteMethod("backfill_orderbook", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Xtsaccount.removeAccount = function (accountId, cb) {
    let Tmp_account = Xtsaccount.app.models.tmp_account;
    (async () => {
      if (accountId && accountId.length == 24) {
        let account = await Xtsaccount.findById(accountId);
        console.log(account);
        if (account) {
          account.type = 'XtsAccount';
          await Tmp_account.create(account);
          await account.destroy();
          cb(null, {
            status: true
          });
        } else cb(null, {
          status: false
        });
      } else cb(null, {
        status: false
      });
    })();
  };

  Xtsaccount.remoteMethod("removeAccount", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  let loadedCurrentExpiry = false;
  let currentExpiryInstruments = [];
  Xtsaccount.instruments = function (cb) {
    if (!loadedCurrentExpiry) {
      let expiryDates = Array.from(new Set(allInstruments.map(c => c.expiry)));
      expiryDates = expiryDates
        .filter(c => moment(c[1], 'YYYY-MM-DD').diff(moment(), 'days') >= 0)
        .sort((a, b) => {
          return moment(a[1], 'YYYY-MM-DD').diff(moment(b[1], 'YYYY-MM-DD'));
        })
        .reduce((obj, curr) => {
          if (!obj[curr[0]]) obj[curr[0]] = [];
          if (obj[curr[0]].indexOf(curr[1]) == -1) obj[curr[0]].push(curr[1]);
          return obj;
        }, {});

      currentExpiryInstruments = allInstruments
        .filter(row => (expiryDates[row['name']] && expiryDates[row['name']][0] == row.expiry))
        .map(row => {
          return {
            "instrument_token": row['instrument_token'],
            "exchange_token": row['exchange_token'],
            "expiry": row['expiry'],
            "instrument_type": row['instrument_type'],
            "lot_size": row['lot_size'],
            "name": row['name'],
            "strike": row['strike'],
            "tradingsymbol": row['tradingsymbol'],
          };
        });
      cb(null, { status: true, instruments: currentExpiryInstruments });
    } else cb(null, { status: true, instruments: currentExpiryInstruments });
  };

  Xtsaccount.remoteMethod("instruments", {
    http: {
      verb: "post"
    },
    accepts: [],
    returns: {
      type: "object",
      root: true
    }
  });

  Xtsaccount.option_analysis = function (accountId, cb) {
    const Orderbook2 = Xtsaccount.app.models.orderbook2;
    (async () => {
      if (accountId && accountId.length == 24) {
        let orders = await Orderbook2.find({
          where: {
            accountId: accountId
          }
        });
        if (orders.length > 0) {
          OptionAnalysis(orders, (err, resp) => {
            if (err) cb(null, {});
            else cb(null, resp);
          });
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Xtsaccount.remoteMethod("option_analysis", {
    http: {
      verb: "get"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });
};
