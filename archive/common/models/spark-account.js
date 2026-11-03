'use strict';

const async = require('async');
const Spark = require('./../../server/lib/tradelab');
const moment = require('moment');
const tranches = (number) => ((new Array(Math.floor(number / 100)).fill(100).concat(number % 100)).filter(c => c > 0));
const notify = require('./../../server/lib/notify');
let channelId = 0;

module.exports = function (Sparkaccount) {
  Sparkaccount.validatesUniquenessOf('name');
  let strategies = ['AlgoEQ', 'Index', 'Index_Old', 'Bentley', 'RollsRoyce', 'Birbal_AI', 'Casino', 'Tesla', 'TR', 'Pi', 'ITCRT', 'LX1', 'LX2', 'LX3', 'LX4', 'STG3', 'STG4', 'Chai', 'Spider', 'F2', 'ST1', 'BTS', 'BBT', 'BBT5', 'BBTn5', 'iStraddle', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'Math_AI', 'Index', 'Index_Old', 'AlgoEQ', 'Bahubali', 'Birbal_AI', 'Birbal_LMT', 'Casino', 'Tesla', 'Pi', 'ITC', 'ITCRT', 'Chai', 'Spider', 'F2', 'ST1', 'S1', 'BTS', 'BBT', 'BBTn5', 'BBT5', 'Urvashi', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'mStrangleT', 'uStrangleT', 'Strangle40', 'Strangle60', 'ADMIN_SQF', 'SQF', "STG1", "STG2", "STG3", "STG4", "STG5", "STG6", "STG7", "STG8", "STG9", "STG10", "STG11", "STG12", "STG13", "STG14", "STG15", "STG16", "STG17", "STG18", "STG19", "STG20", "STG21", "STG22", "STG23", "MTM_1", "STGL-120", "STGL-160", "Strangle240", 'Strangle2k', 'MB-2k', "MB-N700", "MB-10", "AudiB1", "AudiB2", "AudiB3", "AudiB4", "AudiN1", "AudiN2", "AudiT60", "AudiTT", "AudiTT2", "Banknifty12", "Nifty12", "Ford", "Ford2", "Ford3", 'AudiT80R', 'AudiT120R', 'AudiB80R', 'AudiB120R', 'B5', 'B4', 'T4', 'T3', 'Volvo', 'Volvo2', "TWS", "TWSn", 'V1', 'V2', 'Hedge', 'Super20','Honda2k', 'S4'];
  let strategyIdStart = 1001;
  let strategyMap = strategies.reduce((o, e) => (o[strategyIdStart++] = e, o), {});
  let strategyMap_Id2Tag = Object.keys(strategyMap).reduce((o, e) => (o[e] = strategyMap[e], o), {});
  // console.log(strategyMap, strategyMap_Id2Tag);

  let instrumentsBySymbol = {};
  let instrumentsByToken = {};
  let loadInstrumentsInit = async function () {
    const InstrumentDb = Sparkaccount.app.models.instrument;
    let instrumentsArr = await InstrumentDb.find();
    instrumentsArr.forEach((elm) => {
      elm.exchange_token = parseInt(elm.exchange_token);
      instrumentsByToken[elm.exchange_token] = elm;
      instrumentsBySymbol[elm.tradingsymbol] = elm;
    });
    console.log('Loadded Instruments: ', instrumentsArr.length);
  }
  setTimeout(loadInstrumentsInit, 3000);

  Sparkaccount.observe('before save', function (ctx, next) {
    if (ctx.isNewInstance) {
      try {
        ctx.instance.strategy = {};
        next();
      } catch (err) {
        console.log(err);
        next();
      }
    } else next();
  });

  async function loginClient_v2(accountId) {
    let account, loginResp;
    try {
      account = await Sparkaccount.findById(accountId);
      if (account) {
        let client = new Spark(account, account.server_url);
        // loginResp = await client.login();
        // if (loginResp) {
        //   let token = client.getToken();
        //   account.credentials.token = token;
        //   account.save();
        //   return client;
        // } else return false;
        if (client.getToken()) return client;
        else return false;
      } else return false;
    } catch (err) {
      console.log('Login Try Err: ' + account.name, loginResp, err);
      return false;
    }
  }
  Sparkaccount.loginClient_v2 = loginClient_v2;

  Sparkaccount.check = function (account, cb) {
    (async () => {
      try {
        if (!account.server_url) account.server_url = 'https://itrade.trustline.in';
        let client = new Spark(account, account.server_url);
        let login = await client.login();
        if (login != false) {
          cb(null, {
            status: true,
            message: 'login success',
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

  Sparkaccount.remoteMethod("check", {
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

  Sparkaccount.allMargins = function (cb) {
    (async () => {
      let accounts = await Sparkaccount.find();
      // console.log(accounts.length);
      async.mapLimit(accounts, 10, function (account, cb2) {
        (async () => {
          try {
            let netAvailable, balance;
            let client = await loginClient_v2(account.id);
            if (client) {
              try {
                balance = await client.getBalance();
                let marginIdx = balance.values.findIndex(a => (a[0] === 'Available Margin'));
                if (marginIdx !== -1) {
                  netAvailable = parseInt(balance.values[marginIdx][1]);
                  account.margin = netAvailable;
                }
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

  Sparkaccount.remoteMethod("allMargins", {
    http: {
      verb: "post"
    },
    accepts: [],
    returns: {
      type: "array",
      root: true
    }
  });

  let all_position_cache = [];
  let lastRefreshTime = 0;
  Sparkaccount.all_positions = function (forceRefresh, cb) {
    let reqTime = moment().format('X');
    if ((reqTime - lastRefreshTime) > 300 || forceRefresh) {
      (async () => {
        let accounts = await Sparkaccount.find();
        // console.log(accounts.length);
        async.mapLimit(accounts, 10, function (account, cb2) {
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
              platform: 'spark'
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

  Sparkaccount.remoteMethod("all_positions", {
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

  async function closePositions(client, cb) {
    try {
      let positions = await client.getPositions();
      positions = positions.filter((pos) => (pos.quantity != 0));

      console.log('positions', positions.length);
      for (let i = 0; i < positions.length; i++) {
        let transaction_type = parseInt(positions[i].quantity) > 0 ? 'SELL' : 'BUY';
        let max_lot_size = parseInt(instrumentsByToken[positions[i].instrument_token].lot_size) * 100;
        if (Math.abs(parseInt(positions[i].quantity)) > max_lot_size) {
          let totalQuantity = Math.abs(parseInt(positions[i].quantity));
          let runTimes = totalQuantity / max_lot_size;

          for (let j = 0; j < runTimes; j++) {
            let resp = await client.Order({
              exchange_token: position.exchange_token,
              quantity: (totalQuantity > max_lot_size ? max_lot_size : totalQuantity),
              order_side: transaction_type,
              product: position.product,
            });
            totalQuantity = totalQuantity - max_lot_size;
            console.log(resp);
          }
        } else {
          let resp = await client.Order({
            exchange_token: position.exchange_token,
            quantity: Math.abs(position.quantity),
            order_side: transaction_type,
            product: position.product,
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

  Sparkaccount.squareOff = function (accountId, options, cb) {
    (async () => {
      console.log(accountId);
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        console.log(accountId, client);
        if (client) {
          closePositions(client, async function () {
            let account = await Sparkaccount.findById(accountId);
            let runningStrategies = JSON.parse(JSON.stringify(account.strategy));
            Object.assign(account.bkp_strategy, runningStrategies);
            Object.keys(account.strategy).forEach(s => {
              account.strategy[s] = 0;
            });
            await account.save();
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

  Sparkaccount.remoteMethod("squareOff", {
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

  Sparkaccount.closePositions = closePositions;

  async function placeOrder(client, strategyTag, instrumentId, transType, lotSize, cb) {
    console.log('---------------------------------------------------------------');
    let strategy_id = 1500;
    if (strategyMap_Id2Tag[strategyTag] && typeof strategyMap_Id2Tag[strategyTag] == 'number') {
      strategy_id = strategyMap_Id2Tag[strategyTag];
    }
    let orderOptions = {
      exchange_token: instrumentId,
      quantity: lotSize,
      order_side: transType,
      product: "MIS",
      order_type: "MARKET",
      trigger_price: 0,
      strategy_id: strategy_id
    };

    console.log(orderOptions);
    let orderResp = await client.Order(orderOptions);
    if (orderResp == false) {
      notify('Tradelab Order Err: ' + strategyTag, 0);
      console.log('Order Error', orderResp);
    }
    console.log('Order Response', orderResp);
    console.log('---------------------------------------------------------------');
    cb();
  }

  Sparkaccount.place_order = function (accountId, order_options, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        // console.log(accountId, client);
        if (client) {
          placeOrder(client, order_options.tag, order_options.instrumentId, order_options.type, order_options.quantity, cb)
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

  Sparkaccount.remoteMethod("place_order", {
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

  let updatePositionsConfig = [
    ["trading_symbol", "tradingsymbol"],
    ["average_buy_price", "buy_price"],
    ["average_sell_price", "sell_price"],
    ["net_quantity", "quantity"],
    ["realized_mtm", "realised"],
    ["buy_amount", "buy_value"],
    ["sell_amount", "sell_value"],
    ["net_amount", "m2m"]
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
    try {
      positions = await client.getPositions();
      if (Object.values(positions).length == 0) positions = [];
      positions = positions.map(updatePositionsVars);

      positions.forEach(position => {
        position.token = position.instrument_token;
        position.instrument_token = instrumentsByToken[position.token].instrument_token;
      });
      return positions;
    } catch (err) {
      console.log(err);
      return [];
    }
  }

  Sparkaccount.positions = function (accountId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          let positions = await getPositions(client);
          cb(null, positions);
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Sparkaccount.remoteMethod("positions", {
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

  let updateOrderbookConfig = [
    ["oms_order_id", "order_id"],
    ["rejection_reason", "message"],
    ["order_side", "transaction_type"],
    ["order_status", "status"],
    ["trading_symbol", "tradingsymbol"],
    ["exchange_time", "order_timestamp"]
  ];

  function updateOrderbookVars(data) {
    for (let i = 0; i < updateOrderbookConfig.length; i++) {
      data[updateOrderbookConfig[i][1]] = data[updateOrderbookConfig[i][0]];
      delete data[updateOrderbookConfig[i][0]];
    }
    return data;
  }

  async function getOrders(client) {
    try {
      let ordersCompleted = await client.getOrders('completed');
      let ordersPending = await client.getOrders('pending');
      let orders = [];
      if (ordersCompleted) orders.push(...ordersCompleted);
      if (ordersPending) orders.push(...ordersPending);
      orders = orders.map(updateOrderbookVars);

      orders.forEach(order => {
        try {
          order.token = order.instrument_token;
          order.message = order.message == 'NONE' ? null : order.message;
          order.instrument_token = instrumentsByToken[order.token].instrument_token;
          order.tradingsymbol = instrumentsByToken[order.token].tradingsymbol;
          order.tag = strategyMap[order.user_order_id];
          if (order.order_timestamp) {
            order.order_timestamp = moment(parseInt(order.order_timestamp), 'X').utcOffset("+05:30").format('YYYY-MM-DD HH:mm:ss');
          } else {
            order.order_timestamp = moment(parseInt(order.order_entry_time), 'X').utcOffset("+05:30").format('YYYY-MM-DD HH:mm:ss');
          }
        } catch (err) {
          console.log(err);
        }
      });
      return orders;
    } catch (err) {
      console.log(err);
      return [];
    }
  }

  Sparkaccount.orderbook = function (accountId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          let orders = await getOrders(client);
          cb(null, orders);
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Sparkaccount.remoteMethod("orderbook", {
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
