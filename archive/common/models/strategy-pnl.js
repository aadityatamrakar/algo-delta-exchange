'use strict';

let supertrend = require('./../../server/lib/indicators/atr.js');
const moment = require('moment');
module.exports = function (Strategypnl) {

  Strategypnl.candle = function (strategy, period, mul, cb) {
    (async () => {
      let todayStart = moment().startOf('day').toDate();
      let todayEnd = moment().endOf('day').toDate();
      let resp = await Strategypnl.find({
        where: {
          strategy: strategy,
          ts: {
            gte: todayStart.toISOString(),
            lte: todayEnd.toISOString()
          }
        },
        fields: {
          m2m: 1,
          ts: 1
        }
      });
      let k;
      let candleData = resp.reduce((candleData, tick) => {
        k = moment(tick.ts).format().substr(0, 17) + '00';
        if (!candleData[k]) {
          candleData[k] = {
            ts: moment(tick.ts).format(),
            high: tick.m2m,
            low: tick.m2m,
            open: tick.m2m,
            close: tick.m2m
          }
        } else {
          candleData[k].high = candleData[k].high > tick.m2m ? candleData[k].high : tick.m2m;
          candleData[k].low = candleData[k].low < tick.m2m ? candleData[k].low : tick.m2m;
          candleData[k].close = tick.m2m;
        }
        return candleData;
      }, {});
      candleData = Object.values(candleData);
      if (!period) period = 7;
      if (!mul) mul = 3;
      candleData = await supertrend(candleData, period, mul);
      cb(null, candleData);
    })();
  };

  Strategypnl.remoteMethod("candle", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "strategy",
      type: "string"
    }, {
      arg: "period",
      type: "number",
    }, {
      arg: "mul",
      type: "number"
    }],
    returns: {
      type: "array",
      root: true
    }
  });
};
