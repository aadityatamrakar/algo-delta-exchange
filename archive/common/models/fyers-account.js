'use strict';
const async = require('async');
const FyersApi = require('./../../server/lib/fyers');
const moment = require('moment');
const tranches = (number) => ((new Array(Math.floor(number / 100)).fill(100).concat(number % 100)).filter(c => c > 0));
const notify = require('./../../server/lib/notify');
let channelId = 0;

module.exports = function (Fyersaccount) {
  Fyersaccount.validatesUniquenessOf('name');

  Fyersaccount.observe('before save', function (ctx, next) {
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
      account = await Fyersaccount.findById(accountId);
      if (account) {
        let client = new FyersApi(account);
        loginResp = await client.login();
        if (loginResp) {
          let token = client.getToken();
          account.credentials.token = token;
          account.save();
          return client;
        } else return false;
      } else return false;
    } catch (err) {
      console.log('Login Try Err: ' + account.name, loginResp, err);
      return false;
    }
  }
  Fyersaccount.loginClient_v2 = loginClient_v2;

  Fyersaccount.check = function (account, cb) {
    (async () => {
      try {
        let client = new FyersApi(account);
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

  Fyersaccount.remoteMethod("check", {
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


  let all_position_cache = [];
  let lastRefreshTime = 0;
  Fyersaccount.all_positions = function (forceRefresh, cb) {
    let reqTime = moment().format('X');
    if ((reqTime - lastRefreshTime) > 300 || forceRefresh) {
      (async () => {
        let accounts = await Fyersaccount.find();
        // console.log(accounts.length);
        async.mapLimit(accounts, 10, function (account, cb2) {
          (async () => {
            let resp = {
              accountId: account.id,
              name: account.name,
              username: account.username,
              fullname: account.username,
              strategy: account.strategy,
              positions: [],
              orders: [],
              platform: 'fyers'
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

  Fyersaccount.remoteMethod("all_positions", {
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
      let positions = await client.positions();
      positions = positions.filter((pos) => (pos.qty != 0));

      for (let i = 0; i < positions.length; i++) {
        let transaction_type = (positions[i].qty * positions[i].side) > 0 ? -1 : 1;

        let resp = await client.place_order({
          side: transaction_type,
          quantity: positions[i].qty,
          symbol: positions[i].symbol
        });
        console.log(resp);
      }

      cb();
    } catch (err) {
      console.log(err);
      cb();
    }
  }

  Fyersaccount.squareOff = function (accountId, options, cb) {
    (async () => {
      console.log(accountId);
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        console.log(accountId, client);
        if (client) {
          closePositions(client, async function () {
            let account = await Fyersaccount.findById(accountId);
            try {
              if (typeof account.bkp_strategy != 'object') account.bkp_strategy = {};
              Object.keys(account.strategy).forEach(s => {
                if (parseInt(account.strategy[s]) > 0) {
                  account.bkp_strategy[s] = parseInt(account.strategy[s]);
                  account.strategy[s] = 0;
                }
              });
            } catch (err) {
              console.log(err);
            }
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

  Fyersaccount.remoteMethod("squareOff", {
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


  Fyersaccount.place_order = function (accountId, order_options, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let client = await loginClient_v2(accountId);
        if (client) {
          let resp = await client.place_order({
            side: order_options.type.toUpperCase() == 'BUY' ? 1 : -1,
            quantity: order_options.quantity,
            symbol: "NSE:" + order_options.tradingsymbol
          });
          console.log(resp);
          cb(null, {
            status: true,
            resp: resp
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

  Fyersaccount.remoteMethod("place_order", {
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

  Fyersaccount.closePositions = closePositions;

  let updatePositionsConfig = [
    ["symbol", "tradingsymbol"],
    ["productType", "product"],
    ["buyAvg", "buy_price"],
    ["sellAvg", "sell_price"],
    ["buyQty", "buy_quantity"],
    ["sellQty", "sell_quantity"],
    ["qty", "quantity"],
    ["unrealized_profit", "unrealised"],
    ["realized_profit", "realised"],
    ["buyVal", "buy_value"],
    ["sellVal", "sell_value"],
    ["pl", "m2m"],
    ["netAvg", "value"]
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
      positions = await client.positions();
      positions = positions.map(updatePositionsVars);

      let tokens = positions.map(c => c.tradingsymbol.replace('NSE:', ''));
      let instrumentTokens = await Fyersaccount.app.models.instrument.find({
        where: {
          tradingsymbol: {
            in: tokens
          }
        }
      });

      instrumentTokens = instrumentTokens.reduce((s, a) => {
        s[a.tradingsymbol] = a.instrument_token;
        return s;
      }, {});

      positions.forEach(position => {
        position.tradingsymbol = position.tradingsymbol.replace('NSE:', '');
        position.instrument_token = instrumentTokens[position.tradingsymbol];
        position.quantity = position.quantity * position.side;
      });
      return positions;
    } catch (err) {
      console.log(err);
      return {};
    }
  }

  Fyersaccount.positions = function (accountId, cb) {
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

  Fyersaccount.remoteMethod("positions", {
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

  Fyersaccount.allMargins = function (cb) {
    (async () => {
      let accounts = await Fyersaccount.find();
      // console.log(accounts.length);
      async.mapLimit(accounts, 10, function (account, cb2) {
        (async () => {
          try {
            let balance;
            let client = await loginClient_v2(account.id);
            if (client) {
              try {
                balance = await client.funds();
                console.log(balance);
                account.margin = balance['Available Balance'];
                await account.save();
                cb2(null, {
                  available: true
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

  Fyersaccount.remoteMethod("allMargins", {
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
    ["id", "order_id"],
    ["qty", "quantity"],
    ["exchOrdId", "exchange_order_id"],
    ["tradedPrice", "average_price"],
    ["segment", "exchange"],
    ["side", "transaction_type"],
    ["type", "order_type"],
    ["productType", "product"],
    ["orderValidity", "validity"],
    ["discloseQty", "disclosed_quantity"],
    ["limitPrice", "price"],
    ["symbol", "tradingsymbol"],
    ["stopPrice", "trigger_price"],
    ["orderDateTime", "order_timestamp"]
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
      let orders = await client.orders();
      //   console.log(orders);
      orders = orders.map(updateOrderbookVars);
      let tokens = orders.map(c => String(c.tradingsymbol.replace('NSE:', '')));
      let instrumentTokens = await Fyersaccount.app.models.instrument.find({
        where: {
          tradingsymbol: {
            in: tokens
          }
        }
      });
      instrumentTokens = instrumentTokens.reduce((s, a) => {
        s[a.tradingsymbol] = a;
        return s;
      }, {})

      orders.forEach(order => {
        order.tradingsymbol = order.tradingsymbol.replace('NSE:', "");

        if (order.transaction_type == 1) order.transaction_type = 'BUY';
        else if (order.transaction_type == -1) order.transaction_type = 'SELL';

        if (order.order_type == 1) order.order_type = 'Limit';
        else if (order.order_type == 2) order.order_type = 'Market';
        else if (order.order_type == 3) order.order_type = 'SL-M';
        else if (order.order_type == 4) order.order_type = 'SL-L';

        if (order.status == 1) order.status = 'Cancelled';
        else if (order.status == 2) order.status = 'Filled';
        else if (order.status == 4) order.status = 'Pending';
        else if (order.status == 5) order.status = 'Rejected';
        else if (order.status == 6) order.status = 'Pending';

        order.instrument_token = instrumentTokens[order.tradingsymbol].instrument_token;
        order.average_price = order.average_price;
        order.order_timestamp = moment(order.order_timestamp, 'DD-MMM-YYYY HH:mm:ss').format('YYYY-MM-DD HH:mm:ss');
      });
      return orders;
    } catch (err) {
      console.log(err);
      return {};
    }
  }

  Fyersaccount.orderbook = function (accountId, cb) {
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

  Fyersaccount.remoteMethod("orderbook", {
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
