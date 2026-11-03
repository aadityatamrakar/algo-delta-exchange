'use strict';
let moment = require('moment');

module.exports = function (Positional) {

  async function trackOrder(optionInstrument, orderType, strategyTag, multiplier = 1) {
    Positional.create({
      "status": "COMPLETE",
      "order_timestamp": new Date(moment().toDate()),
      "exchange": "NFO",
      "tradingsymbol": optionInstrument.tradingsymbol,
      "instrument_token": optionInstrument.instrument_token,
      "order_type": "MARKET",
      "transaction_type": orderType,
      "quantity": optionInstrument.lot_size * multiplier,
      "filled_quantity": optionInstrument.lot_size * multiplier,
      "tag": strategyTag,
    });
  }
  Positional.trackOrder = trackOrder;

  Positional.positions = function (ts, cb) {
    (async () => {
      try {
        if (typeof ts == 'function') {
          cb = ts;
          ts = false;
        }

        let today = moment().startOf('day').toDate();
        let todayEnd = moment().endOf('day').toDate();

        // if (ts) {
        //   today = moment(ts, 'X').startOf('day').toDate();
        //   todayEnd = moment(ts, 'X').endOf('day').toDate();
        // }

        let data = await Positional.find();

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
            platform: 'positional'
          })),
          orders: strategy_paper,
          ts: today,
          positions: strategy_positions
        });
      } catch (err) {
        console.log(err);
      }
    })();
  };

  Positional.remoteMethod("positions", {
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

  Positional.squareoff = function (strategy, cb) {
    Positional.positions(function (err, data) {
      data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0));
      data.positions[strategy].forEach(async (order) => {
        Positional.trackOrder({
          instrument_token: order.instrument_token,
          tradingsymbol: order.tradingsymbol,
          lot_size: Math.abs(order.quantity)
        }, (order.quantity > 0 ? 'SELL' : 'BUY'), strategy);
      });
      cb(null, {
        status: true
      });
    });
  }

  Positional.remoteMethod("squareoff", {
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

  Positional.clear = function (strategy, cb) {
    Positional.destroyAll({
      tag: strategy
    }).then(async function () {
      let strategyData = await Positional.app.models.strategyData.findOne({
        where: {
          title: strategy
        }
      });
      await Positional.app.models.strategyData.replaceById(strategyData.id, {
        title: strategy
      });
      cb(null, {
        status: true
      })
    })
  }

  Positional.remoteMethod("clear", {
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
