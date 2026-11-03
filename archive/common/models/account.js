'use strict';
const Zerodha = require('./../../server/lib/zerodha');
const kiteTicker = require('./../../server/lib/KiteTicker');
const optionConfig = require('./../../server/tools/optionInstruments');
const async = require('async');
const moment = require('moment');
const tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
const notify = require('./../../server/lib/notify');
let channelId = 0;

module.exports = function (Account) {
  Account.validatesUniquenessOf('name');
  let strategies = ['AlgoEQ', 'Index', 'Index_Old', 'Bentley', 'RollsRoyce', 'Birbal_AI', 'Casino', 'Tesla', 'TR', 'Pi', 'ITCRT', 'LX1', 'LX2', 'LX3', 'LX4', 'STG3', 'STG4', 'Chai', 'Spider', 'F2', 'ST1', 'BTS', 'BBT', 'BBT5', 'BBTn5', 'iStraddle', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'Math_AI', 'Index', 'Index_Old', 'AlgoEQ', 'Bahubali', 'Birbal_AI', 'Birbal_LMT', 'Casino', 'Tesla', 'Pi', 'ITC', 'ITCRT', 'Chai', 'Spider', 'F2', 'ST1', 'S1', 'BTS', 'BBT', 'BBTn5', 'BBT5', 'Urvashi', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'mStrangleT', 'uStrangleT', 'Strangle40', 'Strangle60', 'ADMIN_SQF', 'SQF', "STG1", "STG2", "STG3", "STG4", "STG5", "STG6", "STG7", "STG8", "STG9", "STG10", "STG11", "STG12", "STG13", "STG14", "STG15", "STG16", "STG17", "STG18", "STG19", "STG20", "STG21", "STG22", "STG23", "MTM_1", "STGL-120", "STGL-160", "Strangle240", 'Strangle2k', 'MB-2k', "MB-N700", "MB-10", "AudiB1", "AudiB2", "AudiB3", "AudiB4", "AudiN1", "AudiN2", "AudiT60", "AudiTT", "AudiTT2", "Banknifty12", "Nifty12", "Ford", "Ford2", "Ford3", 'AudiT80R', 'AudiT120R', 'AudiB80R', 'AudiB120R', 'AudiB5', 'B4', 'T4', 'T3', 'Volvo', 'Volvo2', "TWS", "TWSn", 'V1', 'V2', 'Hedge', 'Super20', 'Honda2k', 'S4', "AudiPC-800", "AudiPS-600", 'B100', "Hedge2", "B5-C", "AudiB4-C", "Hedge-5", "Hedge-2K", "Hedge-3K", "AudiB4-250", "AudiB4-300", "AudiB5-C", 'AudiN4', "AudiPC-800m", "Audi-NF", "Audi-NF800-50", "Audi-NF800-50", "Audi-NF800-100", "BMW-40", "BMW-25", "BMW-i25", "BMW-40d", "BMW-i25d", "BMW-N25", "BMW-N40", "Hedge-N5", "Hedge-N3", "Audi-NF800-e100", "BMW-e40d", "BMW-eN40", "AudiPC-e800m", "BMW-M40", "BMW-F40", "Audi-800F", "Audi-800M", "Audi-B4M", "Audi-B4F", "BMW-40dS", "BMW-40dST", "BMW-M40dST"];
  strategies = Array.from(new Set(strategies));

  Account.observe('before save', function (ctx, next) {
    if (ctx.isNewInstance) {
      try {
        let strategies = {
          'Spider': 0,
          'Strangle': 0,
          'Bentley': 0,
          'Tesla': 0,
          'LowRisk': 0,
          'Pi': 0,
          'AWS': 0,
          'Eagle': 0
        };
        if (ctx.instance.strategy) {
          Object.assign(ctx.instance.strategy, strategies);
        } else ctx.instance.strategy = strategies;
        next();
      } catch (err) {
        console.log(err);
        next();
      }
    } else {
      try {
        if (ctx.options && ctx.options.accessToken && ctx.options.accessToken.userId) {
          let Log = Account.app.models.log;
          let message = [];
          if (ctx.data.strategy) {
            Object.keys(ctx.data.strategy).forEach(k => {
              if (ctx.data.strategy[k] != ctx.currentInstance.strategy[k]) {
                message.push(`Changed ${k} Lot size from ${ctx.currentInstance.strategy[k]} to ${ctx.data.strategy[k]}`);
              }
            });
          }
          let logObj = {
            data: ctx.data,
            instance: ctx.currentInstance,
            userId: ctx.options.accessToken.userId,
            ts: new Date(),
            updated: message.join(', ')
          };
          Log.create(logObj);
        }
      } catch (err) {
        console.log(err);
      }
      next();
    }
  });

  let zapi = new Zerodha();

  Account.check = function (account, cb) {
    (async () => {
      try {
        let zapi_n = new Zerodha();
        zapi_n.loadConfig(account);
        let session = await zapi_n.login();
        if (session) {
          let profile = await zapi_n.getConfig();
          let margins = await zapi_n.margins();

          cb(null, {
            status: true,
            message: 'login success',
            profile,
            margins
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

  Account.remoteMethod("check", {
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

  async function trackOrder(optionInstrument, orderType, strategyTag, multiplier = 1) {
    let PaperTrade = Account.app.models.PaperTrade;
    PaperTrade.create({
      "status": "COMPLETE",
      "order_timestamp": new Date(moment().toDate()),
      "exchange": "NFO",
      "tradingsymbol": optionInstrument.tradingsymbol,
      "instrument_token": optionInstrument.instrument_token,
      "order_type": "MARKET",
      "transaction_type": orderType,
      "quantity": optionInstrument.lot_size * multiplier,
      // "average_price": instrument_quote.last_price,
      "filled_quantity": optionInstrument.lot_size * multiplier,
      "tag": strategyTag,
    });
  }
  Account.trackOrder = trackOrder;

  async function trackOrder_LMT(optionInstrument, orderType, price, strategyTag, multiplier = 1) {
    let PaperTrade = Account.app.models.PaperTrade;
    PaperTrade.create({
      "status": "COMPLETE",
      "order_timestamp": new Date(moment().toDate()),
      "exchange": "NFO",
      "tradingsymbol": optionInstrument.tradingsymbol,
      "instrument_token": optionInstrument.instrument_token,
      "order_type": "LIMIT",
      "transaction_type": orderType,
      "quantity": optionInstrument.lot_size * multiplier,
      "price": price,
      "filled_quantity": optionInstrument.lot_size * multiplier,
      "tag": strategyTag,
    });
  }
  Account.trackOrder_LMT = trackOrder_LMT;

  function placeAllAccount(strategyTag, account_quantities, running_accounts, optionInstrument, orderType, multiplier = 1) {
    if (optionInstrument && optionInstrument.tradingsymbol) {
      return new Promise((resolve, reject) => {
        trackOrder(optionInstrument, orderType, strategyTag, multiplier);
        async.map(running_accounts, function (tmp_zapi, cb) {
          if (account_quantities[tmp_zapi.credentials.user_id]) {
            let orderQuantity = account_quantities[tmp_zapi.credentials.user_id] * multiplier;
            let maxQty = 100;
            if (optionInstrument.tradingsymbol.indexOf('BANKNIFTY') == 0) maxQty = 60;
            else if (optionInstrument.tradingsymbol.indexOf('NIFTY') == 0) maxQty = 36;
            if (orderQuantity <= maxQty) {
              placeOrder(strategyTag, tmp_zapi, optionInstrument, orderType, orderQuantity, cb);
            } else {
              let orderTranches = tranches(orderQuantity, maxQty);
              async.map(orderTranches, function (orderTranch, cb2) {
                placeOrder(strategyTag, tmp_zapi, optionInstrument, orderType, orderTranch, cb2);
              }, cb);
            }
          } else cb();
        }, function (err, resp) {
          resp = resp.filter(c => c);
          if (resp.length > 0) {
            resp = [].concat.apply([], resp);
            notify(JSON.stringify(resp, null, 2));
            resolve(resp);
          } else {
            resolve(true);
          }
        });
      });
    }
  }

  async function placeOrder(strategyTag, tmp_zapi, optionInstrument, orderType, lot_size = 1, mcb) {
    try {
      await tmp_zapi.login();
      console.time('Order' + strategyTag + "_" + tmp_zapi.credentials.user_id);
      let firstLegOrder = await tmp_zapi.orderFNO({
        tradingsymbol: optionInstrument.tradingsymbol,
        transaction_type: orderType,
        order_type: "MARKET",
        quantity: optionInstrument.lot_size * lot_size,
        trigger_price: 0,
        price: 0,
        tag: strategyTag
      });
      console.timeEnd('Order' + strategyTag + "_" + tmp_zapi.credentials.user_id);
      // console.log(optionInstrument, firstLegOrder);
      console.log({
        user_id: tmp_zapi.credentials.user_id,
        resp: firstLegOrder
      });
      if (firstLegOrder && firstLegOrder.status != 'success') {
        mcb(null, {
          user_id: tmp_zapi.credentials.user_id,
          message: firstLegOrder.message + `\nOrder Invalid Response: ${tmp_zapi.credentials.user_id}, STG: ${strategyTag}\nSymbol: ${optionInstrument.tradingsymbol}, OrderType: ${orderType}`
        });
      } else if (firstLegOrder === false) {
        mcb(null, {
          user_id: tmp_zapi.credentials.user_id,
          message: `Order Invalid Response: ${tmp_zapi.credentials.user_id}, STG: ${strategyTag}\nSymbol: ${optionInstrument.tradingsymbol}, OrderType: ${orderType}`
        });
      } else mcb();
    } catch (err) {
      console.log('placeorder', err);
      mcb(null, {
        user_id: tmp_zapi.credentials.user_id,
        message: `Order Invalid Response: ${tmp_zapi.credentials.user_id}, STG: ${strategyTag}\nSymbol: ${optionInstrument.tradingsymbol}, OrderType: ${orderType}`
      })
    }
  }
  Account.placeOrder = placeOrder;
  Account.placeAllAccount = placeAllAccount;

  function placeAllAccount_LMT(strategyTag, account_quantities, running_accounts, optionInstrument, orderType, price, multiplier = 1) {
    return new Promise((resolve, reject) => {
      async.map(running_accounts, function (tmp_zapi, cb) {
        if (account_quantities[tmp_zapi.credentials.user_id]) {
          account_quantities[tmp_zapi.credentials.user_id] = account_quantities[tmp_zapi.credentials.user_id] * multiplier;
          if (account_quantities[tmp_zapi.credentials.user_id] <= 100) {
            placeOrder_LMT(strategyTag, tmp_zapi, optionInstrument, orderType, price, account_quantities[tmp_zapi.credentials.user_id], cb);
          } else {
            let orderTranches = tranches(account_quantities[tmp_zapi.credentials.user_id]);
            async.map(orderTranches, function (orderTranch, cb2) {
              placeOrder_LMT(strategyTag, tmp_zapi, optionInstrument, orderType, price, orderTranch, cb2);
            }, cb);
          }
        } else cb();
      }, function (err, resp) {
        trackOrder_LMT(optionInstrument, orderType, price, strategyTag, multiplier);
        resp = resp.filter(c => c);
        if (resp.length > 0) {
          resp = [].concat.apply([], resp);
          resolve(resp);
        } else {
          resolve(true);
        }
      });
    })
  }

  async function placeOrder_LMT(strategyTag, tmp_zapi, optionInstrument, orderType, price, lot_size = 1, mcb) {
    try {
      await tmp_zapi.login();
      let firstLegOrder = await tmp_zapi.orderFNO({
        tradingsymbol: optionInstrument.tradingsymbol,
        transaction_type: orderType,
        order_type: "LIMIT",
        quantity: optionInstrument.lot_size * lot_size,
        trigger_price: 0,
        price: price,
        tag: strategyTag
      });
      // console.log(optionInstrument, firstLegOrder);
      if (firstLegOrder && firstLegOrder.status != 'success') {
        mcb(null, {
          user_id: tmp_zapi.credentials.user_id,
          message: firstLegOrder.message
        });
      } else if (!firstLegOrder) {
        mcb(null, {
          user_id: tmp_zapi.credentials.user_id,
          message: firstLegOrder
        });
      } else {
        mcb(null, false);
      }
    } catch (err) {
      console.log('placeorder', err);
      mcb(null, {
        user_id: tmp_zapi.credentials.user_id,
        message: err.fileName + ':' + err.lineNumber + ' - ' + err.message
      })
    }
  }
  Account.placeOrder_LMT = placeOrder_LMT;
  Account.placeAllAccount_LMT = placeAllAccount_LMT;

  function placeAllAccountNrml(strategyTag, account_quantities, running_accounts, optionInstrument, orderType, multiplier = 1) {
    return new Promise((resolve, reject) => {
      async.map(running_accounts, function (tmp_zapi, cb) {
        if (account_quantities[tmp_zapi.credentials.user_id]) {
          let tradeQty = parseInt(account_quantities[tmp_zapi.credentials.user_id]) * multiplier;
          if (tradeQty <= 100) {
            placeOrderNrml(strategyTag, tmp_zapi, optionInstrument, orderType, tradeQty, cb);
          } else {
            let orderTranches = tranches(tradeQty);
            async.map(orderTranches, function (orderTranch, cb2) {
              placeOrderNrml(strategyTag, tmp_zapi, optionInstrument, orderType, orderTranch, cb2);
            }, cb);
          }
        } else cb();
      }, function (err, resp) {
        resp = resp.filter(c => c);
        if (resp.length > 0) {
          resp = [].concat.apply([], resp);
          resolve(resp);
        } else {
          resolve(true);
        }
      });
    })
  }

  async function placeOrderNrml(strategyTag, tmp_zapi, optionInstrument, orderType, lot_size = 1, mcb) {
    try {
      await tmp_zapi.login();
      let firstLegOrder = await tmp_zapi.orderFNONrml({
        tradingsymbol: optionInstrument.tradingsymbol,
        transaction_type: orderType,
        order_type: "MARKET",
        quantity: optionInstrument.lot_size * lot_size,
        trigger_price: 0,
        price: 0,
        tag: strategyTag
      });
      console.log(optionInstrument, firstLegOrder);
      if (firstLegOrder && firstLegOrder.status != 'success') {
        mcb(null, {
          user_id: tmp_zapi.credentials.user_id,
          message: firstLegOrder.message
        });
      } else if (!firstLegOrder) {
        mcb(null, {
          user_id: tmp_zapi.credentials.user_id,
          message: firstLegOrder
        });
      } else {
        mcb(null, false);
      }
    } catch (err) {
      mcb(null, {
        user_id: tmp_zapi.credentials.user_id,
        message: err.fileName + ':' + err.lineNumber + ' - ' + err.message
      })
    }
  }
  Account.placeOrderNrml = placeOrderNrml;
  Account.placeAllAccountNrml = placeAllAccountNrml;

  async function zerodha_init2(account) {
    let zapi_n = new Zerodha();
    zapi_n.loadConfig(account);
    return zapi_n;
  }

  async function zerodha_init(account) {
    let zapi_n = new Zerodha();
    zapi_n.loadConfig(account);
    let login_resp = await zapi_n.login();
    if (login_resp === false) return false;
    else return zapi_n;
  }

  async function loadAccounts(strategyTag, loginAccounts = false) {
    return new Promise(async (resolve, reject) => {
      let running_accounts = [],
        accounts = await Account.find({});
      let account_quantities = accounts.reduce((lotSize, elm) => {
        if (elm.strategy && elm.strategy[strategyTag]) {
          lotSize[elm.name] = parseInt(elm.strategy[strategyTag]);
        }
        return lotSize;
      }, {});
      let combineTotalLots = Object.values(account_quantities).reduce((s, a) => (s += a, s), 0);
      if (loginAccounts) {
        async.eachLimit(accounts, 3, function (account, cb) {
          zerodha_init(account).then(tmp_zapi => {
            if (tmp_zapi) running_accounts.push(tmp_zapi);
            cb();
          });
        }, function () {
          if (combineTotalLots > 0) {
            // notify(running_accounts.length + ' accounts logged in, total ' + strategyTag + ': ' + combineTotalLots + ' lots', channelId);
          }
          resolve({
            accounts,
            account_quantities,
            running_accounts
          });
        });
      } else {
        async.eachLimit(accounts, 3, function (account, cb) {
          zerodha_init2(account).then(tmp_zapi => {
            if (tmp_zapi) running_accounts.push(tmp_zapi);
            cb();
          });
        }, function () {
          resolve({
            accounts,
            account_quantities,
            running_accounts
          });
        });
      }
    })
  }
  Account.loadAccounts = loadAccounts;

  Account.margins = function (accountId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let zapi_n = new Zerodha();
        let account = await Account.findById(accountId);
        if (account) {
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          let margins = await zapi_n.margins();
          cb(null, margins);
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Account.remoteMethod("margins", {
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

  Account.loadMargins = function (cb) {
    (async () => {
      let accounts = await Account.find();
      // console.log(accounts.length);
      async.mapLimit(accounts, 3, function (account, cb2) {
        (async () => {
          try {
            let zapi_n = new Zerodha();
            zapi_n.loadConfig(account);
            let session = await zapi_n.checkSession();
            if (!session) {
              session = await zapi_n.login();
              account.lastLogin = (new Date()).getTime();
            }

            account.config = await zapi_n.getConfig();
            account.margins = await zapi_n.margins();
            if (account.margins && account.margins.equity && account.margins.equity.net) {
              account.margin = parseInt(account.margins.equity.net);
            }
            await account.save();
            // console.log(positions.day.length);
            let resp = {
              accountId: account.id,
              name: account.name,
              margins: account.margins,
              margin: account.margin
            };
            cb2(null, resp);
          } catch (err) {
            console.log(err);
            cb2(null, false);
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

  Account.remoteMethod("loadMargins", {
    http: {
      verb: "post"
    },
    accepts: [],
    returns: {
      type: "array",
      root: true
    }
  });

  Account.squareOff = function (accountId, options, cb) {
    (async () => {
      let Log = Account.app.models.log;
      if (accountId && accountId.length == 24) {
        let zapi_n = new Zerodha();
        let account = await Account.findById(accountId);
        if (account) {
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          closePositions(zapi_n, async function (err, resp) {
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
            try {
              let logObj = {
                instance: account,
                userId: options.accessToken.userId,
                ts: new Date(),
                updated: "Admin Square off Initiated"
              };
              Log.create(logObj);
            } catch (err) {
              console.log(err);
            }
            cb(null, {
              status: true
            });
          });
        } else cb(null, {
          status: false
        });
      } else cb(null, {
        status: false
      });
    })();
  };

  Account.remoteMethod("squareOff", {
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

  Account.closePositions = closePositions;

  Account.positions = function (accountId, cb) {
    (async () => {
      let strategyData = Account.app.models.strategyData;
      let strategiesPosition = await strategyData.find({});
      let strategiesOrders = strategiesPosition.reduce((a, s) => {
        if (s.positions) {
          if (s.positions.BUY && s.positions.BUY.length > 0) a.push(...s.positions.BUY);
          if (s.positions.SELL && s.positions.SELL.length > 0) a.push(...s.positions.SELL);
        }
        return a;
      }, []);
      if (accountId && accountId.length == 24) {
        let zapi_n = new Zerodha();
        let account = await Account.findById(accountId);
        if (account) {
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          let orderbook = await zapi_n.orders();
          orderbook = orderbook.filter(order => {
            return ((order.tag && strategies.indexOf(order.tag) != -1))
          });
          orderbook.push(...strategiesOrders);
          let symbols = Array.from(new Set(orderbook.map(c => c.tradingsymbol)));
          let positions = await zapi_n.positions();
          if (positions.net) {
            positions.net = positions.net.filter(c => symbols.indexOf(c.tradingsymbol) != -1);
            cb(null, positions.net);
          } else cb(null, {});
        } else cb(null, {});
      } else cb(null, {});
    })();
  };

  Account.remoteMethod("positions", {
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

  let removeKeys = ["cancelled_quantity", "disclosed_quantity", "filled_quantity", "guid", "market_protection", "meta", "pending_quantity", "tags", "validity", "variety"];
  let all_position_cache = [];
  let lastRefreshTime = 0;
  Account.all_positions = function (forceRefresh, cb) {
    let reqTime = moment().format('X');
    let strategyData = Account.app.models.strategyData;
    if ((reqTime - lastRefreshTime) > 300 || forceRefresh) {
      (async () => {
        let strategiesPosition = await strategyData.find({});
        let strategiesOrders = strategiesPosition.reduce((a, s) => {
          if (s.positions) {
            if (s.positions.BUY && s.positions.BUY.length > 0) a.push(...s.positions.BUY);
            if (s.positions.SELL && s.positions.SELL.length > 0) a.push(...s.positions.SELL);
          }
          return a;
        }, []);
        let accounts = await Account.find();
        // console.log(accounts.length);
        async.mapLimit(accounts, 50, function (account, cb2) {
          (async () => {
            try {
              let zapi_n = new Zerodha();
              zapi_n.loadConfig(account);
              let session = await zapi_n.login();
              if (session) {
                let positions = await zapi_n.positions();
                let orders = await zapi_n.orders();
                orders = orders.filter(order => {
                  return ((order.tag && strategies.indexOf(order.tag) != -1))
                });
                orders = orders.map(order => {
                  removeKeys.forEach(k => {
                    delete order[k]
                  });
                  return order;
                });
                let symbols = Array.from(new Set([...strategiesOrders, ...orders.map(c => c.tradingsymbol)]));
                if (positions.net) positions.net = positions.net.filter(c => symbols.indexOf(c.tradingsymbol) != -1);
                // console.log(positions.day.length);

                // Object.keys(account.strategy).forEach(k => {
                //   account.strategy[k] = parseInt(account.strategy[k]) * 10;
                // });

                let resp = {
                  accountId: account.id,
                  name: account.name,
                  margin: account.margin,
                  username: account.name,
                  fullname: account.username || account.config.data.user_name,
                  strategy: account.strategy,
                  positions: positions.net,
                  orders: orders,
                  createdAt: moment().startOf('day').toDate(),
                  platform: 'zerodha'
                };
                cb2(null, resp);
              } else cb2(null, null);
            } catch (err) {
              console.log(err);
              cb2(null, null);
            }
          })();
        }, function (err, resp) {
          if (resp) {
            resp = resp.filter(c => c);
            all_position_cache = resp;
            lastRefreshTime = reqTime;
            cb(null, resp);
          } else cb(null, []);
        });
      })();
    } else {
      cb(null, all_position_cache);
    }
  };

  Account.remoteMethod("all_positions", {
    http: {
      verb: "get"
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

  async function closePositions(tmp_zapi, cb, selected_strategies = false) {
    try {
      console.log('Sqf init: ' + tmp_zapi.credentials.user_id);
      if (!selected_strategies) selected_strategies = strategies;
      await tmp_zapi.login();
      let orders = await tmp_zapi.orders();
      let closedOrderStatus = ['COMPLETE', 'CANCELLED', 'REJECTED'];
      let strategy_symbols = orders
        .filter(row => (selected_strategies.indexOf(row.tag) != -1 && row.exchange == 'NFO'))
        .reduce((symbols, order_row) => {
          symbols[order_row.tradingsymbol] = 1;
          return symbols;
        }, {});
      orders = orders.filter(row => (selected_strategies.indexOf(row.tag) != -1 && row.exchange == 'NFO' && closedOrderStatus.indexOf(row.status) == -1));
      // console.log(orders);
      for (let i = 0; i < orders.length; i++) {
        await tmp_zapi.exitRegularOrder(orders[i].order_id);
      }

      let positions = await tmp_zapi.positions();
      positions = positions.day.filter((pos) => (pos.exchange == 'NFO' && pos.quantity != 0)).sort((c, d) => (c.quantity - d.quantity));
      // console.log(positions);
      for (let i = 0; i < positions.length; i++) {
        let transaction_type = positions[i].quantity > 0 ? 'SELL' : 'BUY';

        if (strategy_symbols[positions[i].tradingsymbol]) {
          if (positions[i].tradingsymbol.indexOf('BANKNIFTY') != -1 && Math.abs(positions[i].quantity) > 900) {
            let totalQuantity = Math.abs(positions[i].quantity);
            let runTimes = totalQuantity / 900;

            for (let j = 0; j < runTimes; j++) {
              if (positions[i].product == 'MIS') {
                let resp = await tmp_zapi.orderFNO({
                  tradingsymbol: positions[i].tradingsymbol,
                  transaction_type: transaction_type,
                  order_type: "MARKET",
                  quantity: (totalQuantity > 900 ? 900 : totalQuantity),
                  trigger_price: 0,
                  price: 0,
                  tag: "SQF"
                });
                console.log(resp);
              } else {
                let resp = await tmp_zapi.orderFNONrml({
                  tradingsymbol: positions[i].tradingsymbol,
                  transaction_type: transaction_type,
                  order_type: "MARKET",
                  quantity: (totalQuantity > 900 ? 900 : totalQuantity),
                  trigger_price: 0,
                  price: 0,
                  tag: "SQF"
                });
                console.log(resp);
              }
              totalQuantity = totalQuantity - 900;
            }
          } else {
            if (positions[i].product == 'MIS') {
              let resp = await tmp_zapi.orderFNO({
                tradingsymbol: positions[i].tradingsymbol,
                transaction_type: transaction_type,
                order_type: "MARKET",
                quantity: Math.abs(positions[i].quantity),
                trigger_price: 0,
                price: 0,
                tag: "SQF"
              });
              console.log(resp);
            } else {
              console.log('test');
              let resp = await tmp_zapi.orderFNONrml({
                tradingsymbol: positions[i].tradingsymbol,
                transaction_type: transaction_type,
                order_type: "MARKET",
                quantity: Math.abs(positions[i].quantity),
                trigger_price: 0,
                price: 0,
                tag: "SQF"
              });
              console.log(resp);
            }
          }
        }
      }

      let total = 0;
      cb(null, tmp_zapi.credentials.user_id + ' DAY PNL: ' + Math.round(total));
    } catch (err) {
      console.log(err);
      cb(null, tmp_zapi.credentials.user_id + ' SquareOff Failed');
    }
  }

  Account.cashout = function (strategy, cb) {
    let PaperTrade = Account.app.models.PaperTrade;
    (async () => {
      let accounts = await Account.find();
      // console.log(accounts.length);
      async.mapLimit(accounts, 3, function (account, cb2) {
        (async () => {
          try {
            let zapi_n = new Zerodha();
            zapi_n.loadConfig(account);
            let session = await zapi_n.checkSession();
            if (!session) session = await zapi_n.login();
            if (strategy != 'ALL') closePositions(zapi_n, cb2, strategy);
            else closePositions(zapi_n, cb2);
          } catch (err) {
            console.log(err);
            cb2(null, false);
          }
        })();
      }, function (err, resp) {
        if (err) cb(err);
        else {
          PaperTrade.positions(function (err, data) {
            data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0));
            data.positions[strategy].forEach(async (order) => {
              Account.trackOrder({
                instrument_token: order.instrument_token,
                tradingsymbol: order.tradingsymbol,
                lot_size: Math.abs(order.quantity)
              }, (order.quantity > 0 ? 'SELL' : 'BUY'), strategy);
            });
          });
          resp = resp.filter(c => c);
          cb(err, resp);
        }
      });
    })();
  };

  Account.remoteMethod("cashout", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "strategy",
      type: "string"
    }],
    returns: {
      type: "array",
      root: true
    }
  });

  Account.resetQuantity = function (strategy, cb) {
    (async () => {
      let accounts = await Account.find();
      async.eachLimit(accounts, 10, function (account, cb2) {
        (async () => {
          try {
            if (account.strategy) {
              account.strategy[strategy] = 0;
              await account.save();
              cb2();
            } else {
              account.strategy = {
                [strategy]: 0
              };
              await account.save();
              cb2();
            }
          } catch (err) {
            cb2();
          }
        })();
      }, function (err) {
        cb(null, {
          status: true
        });
      });
    })();
  };

  Account.remoteMethod("resetQuantity", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "strategy",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Account.orderbook = function (accountId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let zapi_n = new Zerodha();
        let account = await Account.findById(accountId);
        if (account) {
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          let orderbook = await zapi_n.orders();
          orderbook = orderbook.filter(order => {
            return ((order.tag && strategies.indexOf(order.tag) != -1))
          });
          cb(null, orderbook);
        } else cb(null, []);
      } else cb(null, []);
    })();
  };

  Account.remoteMethod("orderbook", {
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

  Account.orderFNO = function (accountId, orderOpt, cb) {
    (async () => {
      console.log(accountId, orderOpt);
      if (accountId && accountId.length == 24) {
        let zapi_n = new Zerodha();
        let account = await Account.findById(accountId);
        if (account) {
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          let resp = await zapi_n.orderFNO(orderOpt);
          cb(null, resp);
        } else cb(null, []);
      } else cb(null, []);
    })();
  };

  Account.remoteMethod("orderFNO", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }, {
      arg: "orderOpt",
      type: "object"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Account.exitStrangle = function (clientCode, cb) {
    (async () => {
      if (clientCode && clientCode.length == 6) {
        let zapi_n = new Zerodha();
        let account = await Account.findOne({
          where: {
            name: clientCode
          }
        });
        if (account) {
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          let resp = await zapi_n.orders();

          let pendingLegs = resp.filter(c => c.tag == 'Strangle' && c.status != 'REJECTED' && c.status != 'CANCELLED');
          async.map(pendingLegs, function (order, cb2) {
            if (order.status == 'COMPLETE' && order.transaction_type == 'SELL') {
              zapi_n.orderFNO({
                "tradingsymbol": order.tradingsymbol,
                "transaction_type": "BUY",
                "order_type": "MARKET",
                "quantity": Math.abs(order.quantity),
                "trigger_price": 0,
                "price": 0
              }).then(res => {
                cb2(null, res)
              });
            } else if (order.status == 'TRIGGER PENDING' && order.transaction_type == 'BUY') {
              zapi_n.exitRegularOrder(order.order_id)
                .then(res => {
                  cb2(null, res)
                });
            }
          }, function (err, res) {
            if (err) cb(err);
            else {
              cb(null, {
                status: true,
                response: res
              });
            }
          })

        } else cb(null, {
          status: false,
          message: 'ID not found'
        });
      } else cb(null, {
        status: false,
        message: 'NO ID'
      });
    })();
  };

  Account.remoteMethod("exitStrangle", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "clientCode",
      type: "string"
    }],
    returns: {
      type: "array",
      root: true
    }
  });

  Account.exitAllStrangle = function (cb) {
    (async () => {
      let accounts = await Account.find({});
      async.eachSeries(accounts, function (account, mcb) {
        (async () => {
          let zapi_n = new Zerodha();
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          let resp = await zapi_n.orders();

          let pendingLegs = resp.filter(c => c.tag == 'Strangle' && c.status != 'REJECTED' && c.status != 'CANCELLED');
          async.map(pendingLegs, function (order, cb2) {
            if (order.status == 'COMPLETE' && order.transaction_type == 'SELL') {
              zapi_n.orderFNO({
                "tradingsymbol": order.tradingsymbol,
                "transaction_type": "BUY",
                "order_type": "MARKET",
                "quantity": Math.abs(order.quantity),
                "trigger_price": 0,
                "price": 0
              }).then(res => {
                cb2(null, res)
              });
            } else if (order.status == 'TRIGGER PENDING' && order.transaction_type == 'BUY') {
              zapi_n.exitRegularOrder(order.order_id)
                .then(res => {
                  cb2(null, res)
                });
            }
          }, function (err, res) {
            mcb();
          })
        })();
      }, function () {
        cb(null, {
          status: true,
          message: 'done'
        });
      });
    })();
  };

  Account.remoteMethod("exitAllStrangle", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "clientCode",
      type: "string"
    }],
    returns: {
      type: "array",
      root: true
    }
  });

  Account.exitRegularOrder = function (accountId, orderId, cb) {
    (async () => {
      if (accountId && accountId.length == 24) {
        let zapi_n = new Zerodha();
        let account = await Account.findById(accountId);
        if (account) {
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) await zapi_n.login();
          let resp = await zapi_n.exitRegularOrder(orderId);
          cb(null, resp);
        } else cb(null, []);
      } else cb(null, []);
    })();
  };

  Account.remoteMethod("exitRegularOrder", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "accountId",
      type: "string"
    }, {
      arg: "orderId",
      type: "string"
    }],
    returns: {
      type: "array",
      root: true
    }
  });

  let public_token, public_token_refresh = 0;
  Account.token = function (options, cb) {
    (async () => {
      try {
        let masterId = Account.app.get('masterId');
        if (typeof options.accessToken != 'object' || typeof options.accessToken.userId == 'undefined') {
          cb(null, {
            status: false,
            message: 'user not logged in.'
          });
        } else {
          let clientId = options.accessToken.userId;
          let account = await Account.findOne({
            where: {
              clientId: clientId
            }
          });

          if (account) {
            let zapi_n = new Zerodha();
            zapi_n.loadConfig(account);
            let session = await zapi_n.checkSession();
            if (!session) await zapi_n.login();
            cb(null, {
              status: true,
              token: encodeURIComponent(zapi.getAuthorization()),
              id: zapi_n.credentials.user_id
            });
          } else {
            let reqTime = moment().format('X');
            if ((reqTime - public_token_refresh) > 36000) {
              let account = await Account.findById(masterId);
              zapi.loadConfig(account);
              let session = await zapi.checkSession();
              if (!session) await zapi.login();

              public_token = encodeURIComponent(zapi.getAuthorization());
              public_token_refresh = reqTime;
              cb(null, {
                status: true,
                token: encodeURIComponent(zapi.getAuthorization())
              });
            } else {
              cb(null, {
                status: true,
                token: public_token
              });
            }
          }
        }
      } catch (err) {
        console.log(err);
        cb(null, {
          status: false
        });
      }
    })();
  };

  Account.remoteMethod("token", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "options",
      type: "object",
      http: "optionsFromRequest"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Account.removeAccount = function (accountId, cb) {
    let Tmp_account = Account.app.models.tmp_account;
    (async () => {
      if (accountId && accountId.length == 24) {
        let account = await Account.findById(accountId);
        if (account) {
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

  Account.remoteMethod("removeAccount", {
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
};
