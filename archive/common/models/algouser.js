'use strict';
let moment = require('moment');
let async = require('async');

module.exports = function (Algouser) {

  function getPositions(orders) {
    let _positions = {};
    orders.forEach((order) => {
      if (order.status == 'COMPLETE') {
        if (!_positions[order.tradingsymbol]) {
          _positions[order.tradingsymbol] = {
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

          _positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_quantity"] = order.quantity;
          _positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_price"] = order.average_price;
          _positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_value"] = order.average_price * order.quantity;
        } else {
          if (order.transaction_type == 'SELL') {
            _positions[order.tradingsymbol].quantity += -1 * order.quantity;
            _positions[order.tradingsymbol].sell_quantity += order.quantity;
            _positions[order.tradingsymbol].sell_value += Math.round(order.quantity * order.average_price);
            _positions[order.tradingsymbol].sell_price = Math.round(_positions[order.tradingsymbol].sell_value / _positions[order.tradingsymbol].sell_quantity * 100) / 100;
          } else {
            _positions[order.tradingsymbol].quantity += order.quantity;
            _positions[order.tradingsymbol].buy_quantity += order.quantity;
            _positions[order.tradingsymbol].buy_value += Math.round(order.quantity * order.average_price);
            _positions[order.tradingsymbol].buy_price = Math.round(_positions[order.tradingsymbol].buy_value / _positions[order.tradingsymbol].buy_quantity * 100) / 100;
          }
        }

        if (_positions[order.tradingsymbol].quantity == 0) {
          _positions[order.tradingsymbol].m2m = _positions[order.tradingsymbol].sell_value - _positions[order.tradingsymbol].buy_value;
        }
      }
    });
    return Object.values(_positions);
  }

  Algouser.all_positions = function (ts, cb) {
    (async () => {
      if (typeof ts == 'function') {
        cb = ts;
        ts = false;
      }

      let today = moment().startOf('day').toDate();
      let todayEnd = moment().endOf('day').toDate();
      let accounts = await Algouser.find({});

      async.map(accounts, function (account, cb2) {
        (async () => {
          account.accountId = account.id;
          account.fullname = account.username;
          account.platform = 'algopaper';
          account.orders = await Algouser.app.models.algopaper.find({
            where: {
              algouserId: String(account.id),
              order_timestamp: {
                between: [today, todayEnd]
              }
            }
          });
          account.positions = getPositions(account.orders);
          cb2(null, account);
        })();
      }, cb);
    })();
  };

  Algouser.remoteMethod("all_positions", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "ts",
      type: "number"
    }],
    returns: {
      type: "array",
      root: true
    }
  });

  Algouser.positions = function (userId, ts, cb) {
    (async () => {
      if (typeof ts == 'function') {
        cb = ts;
        ts = false;
      }

      let today = moment().startOf('day').toDate();
      let todayEnd = moment().endOf('day').toDate();

      let account = await Algouser.findOne({
        where: {
          id: userId
        }
      });

      account.accountId = account.id;
      account.fullname = account.username;
      account.platform = 'algopaper';
      account.orders = await Algouser.app.models.algopaper.find({
        where: {
          algouserId: String(account.id),
          order_timestamp: {
            between: [today, todayEnd]
          }
        }
      });
      account.positions = getPositions(account.orders);

      cb(null, account);
    })();
  };

  Algouser.remoteMethod("positions", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "algouserId",
      type: "string"
    }, {
      arg: "ts",
      type: "number"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

};
