'use strict';
let moment = require('moment');

module.exports = function (Papertrade) {

  async function trackOrder_limit(optionInstrument, orderType, strategyTag, multiplier = 1, limitPrice, dataObj = []) {
    Papertrade.create({
      "status": "Pending",
      "order_timestamp": new Date(moment().toDate()),
      "exchange": "NFO",
      "tradingsymbol": optionInstrument.tradingsymbol,
      "instrument_token": optionInstrument.instrument_token,
      "order_type": "Limit",
      "transaction_type": orderType,
      "quantity": optionInstrument.lot_size * multiplier,
      "limitPrice": limitPrice,
      "average_price": limitPrice,
      "filled_quantity": optionInstrument.lot_size * multiplier,
      "tag": strategyTag,
      "dataObj": dataObj
    });
  }
  Papertrade.trackOrder_limit = trackOrder_limit;

  async function trackOrder_slm(optionInstrument, orderType, strategyTag, multiplier = 1, stopPrice, dataObj = []) {
    Papertrade.create({
      "status": "Pending",
      "order_timestamp": new Date(moment().toDate()),
      "exchange": "NFO",
      "tradingsymbol": optionInstrument.tradingsymbol,
      "instrument_token": optionInstrument.instrument_token,
      "order_type": "StopMarket",
      "transaction_type": orderType,
      "quantity": optionInstrument.lot_size * multiplier,
      "stopPrice": stopPrice,
      "average_price": stopPrice,
      "filled_quantity": optionInstrument.lot_size * multiplier,
      "tag": strategyTag,
      "dataObj": dataObj
    });
  }
  Papertrade.trackOrder_slm = trackOrder_slm;
  async function trackOrder_v2(optionInstrument, orderType, strategyTag, multiplier = 1, dataObj = []) {
    Papertrade.create({
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
      "dataObj": dataObj
    });
  }
  Papertrade.trackOrder_v2 = trackOrder_v2;

  async function trackOrder(optionInstrument, orderType, strategyTag, multiplier = 1) {
    Papertrade.create({
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
  Papertrade.trackOrder = trackOrder;

  Papertrade.positions = function (ts, cb) {
    (async () => {
      if (typeof ts == 'function') {
        cb = ts;
        ts = false;
      }

      let today = moment().startOf('day').toDate();
      let todayEnd = moment().endOf('day').toDate();

      if (ts) {
        today = moment(ts, 'X').startOf('day').toDate();
        todayEnd = moment(ts, 'X').endOf('day').toDate();
      }

      let data = await Papertrade.find({
        where: {
          order_timestamp: {
            between: [today, todayEnd]
          }
        }
      });

      let strategies = [];
      let strategy_paper = {};

      data.forEach((order) => {
        if (!strategy_paper[order.tag]) strategy_paper[order.tag] = [];
        strategy_paper[order.tag].push(order);
      });
      strategies = Object.keys(strategy_paper);

      let strategy_positions = {};

      strategies.forEach((strategy) => {
        if (strategy_paper[strategy] && strategy_paper[strategy].length > 0) {
          strategy_positions[strategy] = {};
          strategy_paper[strategy].forEach((order) => {
            if (order.status == 'COMPLETE') {
              if (!strategy_positions[strategy][order.tradingsymbol]) {
                strategy_positions[strategy][order.tradingsymbol] = {
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

                strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_quantity"] = order.quantity;
                strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_price"] = order.average_price;
                strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_value"] = order.average_price * order.quantity;
              } else {
                if (order.transaction_type == 'SELL') {
                  strategy_positions[strategy][order.tradingsymbol].quantity += -1 * order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].sell_quantity += order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].sell_value += Math.round(order.quantity * order.average_price);
                  strategy_positions[strategy][order.tradingsymbol].sell_price = Math.round(strategy_positions[strategy][order.tradingsymbol].sell_value / strategy_positions[strategy][order.tradingsymbol].sell_quantity * 100) / 100;
                } else {
                  strategy_positions[strategy][order.tradingsymbol].quantity += order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].buy_quantity += order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].buy_value += Math.round(order.quantity * order.average_price);
                  strategy_positions[strategy][order.tradingsymbol].buy_price = Math.round(strategy_positions[strategy][order.tradingsymbol].buy_value / strategy_positions[strategy][order.tradingsymbol].buy_quantity * 100) / 100;
                }
              }

              if (strategy_positions[strategy][order.tradingsymbol].quantity == 0) {
                strategy_positions[strategy][order.tradingsymbol].m2m = strategy_positions[strategy][order.tradingsymbol].sell_value - strategy_positions[strategy][order.tradingsymbol].buy_value;
              }
            }
          });
        }
      });

      cb(null, {
        accounts: Object.keys(strategy_positions).map(strategy => ({
          accountId: strategy,
          name: "Demo",
          username: strategy,
          fullname: strategy,
          strategy: strategy,
          positions: Object.values(strategy_positions[strategy]),
          orders: strategy_paper[strategy],
          platform: 'paper'
        })),
        orders: strategy_paper,
        ts: today,
        positions: strategy_positions
      });
    })();
  };

  Papertrade.remoteMethod("positions", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "ts",
      type: "number"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Papertrade.squareoff = function (strategy, cb) {
    Papertrade.positions(function (err, data) {
      data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0));
      data.positions[strategy].forEach(async (order) => {
        Papertrade.trackOrder({
          instrument_token: order.instrument_token,
          tradingsymbol: order.tradingsymbol,
          lot_size: Math.abs(order.quantity)
        }, (order.quantity > 0 ? 'SELL' : 'BUY'), strategy);
      });
      cb(null, {
        status: true
      })
    });
  }

  Papertrade.remoteMethod("squareoff", {
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

  Papertrade.clear = function (strategy, cb) {
    Papertrade.destroyAll({
      tag: strategy
    }).then(function () {
      cb(null, {
        status: true
      })
    })
  }

  Papertrade.remoteMethod("clear", {
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
};
