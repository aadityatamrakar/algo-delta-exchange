'use strict';
let moment = require('moment');

module.exports = function (Algopaper) {

  async function trackOrder(userId, optionInstrument, orderType, strategyTag, price, multiplier = 1) {
    Algopaper.create({
      "status": "COMPLETE",
      "order_timestamp": new Date(moment().toDate()),
      "exchange": "NFO",
      "tradingsymbol": optionInstrument.tradingsymbol,
      "instrument_token": optionInstrument.instrument_token,
      "order_type": "MARKET",
      "transaction_type": orderType,
      "quantity": optionInstrument.lot_size * multiplier,
      "average_price": price,
      "filled_quantity": optionInstrument.lot_size * multiplier,
      "tag": strategyTag,
      "algouserId": userId,
    });
  }
  Algopaper.trackOrder = trackOrder;

  Algopaper.squareoff = function (strategy, cb) {
    Algopaper.all_positions(function (err, data) {
      data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0));
      data.positions[strategy].forEach(async (order) => {
        Algopaper.trackOrder({
          instrument_token: order.instrument_token,
          tradingsymbol: order.tradingsymbol,
          lot_size: Math.abs(order.quantity)
        }, (order.quantity > 0 ? 'SELL' : 'BUY'), strategy);
      });
    });
  }

  Algopaper.remoteMethod("squareoff", {
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

  Algopaper.clear = function (strategy, cb) {
    Algopaper.destroyAll({
      tag: strategy
    }).then(function () {
      cb(null, {
        status: true
      })
    })
  }

  Algopaper.remoteMethod("clear", {
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
