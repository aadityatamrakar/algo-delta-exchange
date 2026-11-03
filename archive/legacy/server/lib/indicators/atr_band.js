const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Average true range
 * @param {Array} ticks (high/low/close)
 * @param {Number} period = 20
 * @returns {Number} ATR - number
 */

module.exports = async function atr(ticks, period = 30, mul = 3) {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.atr.indicator(
      [tulip_ticks.high, tulip_ticks.low, tulip_ticks.close],
      [period],
      function (err, results) {
        let startIdx = (ticks.length - results[0].length);
        ticks[startIdx].atr = results[0][0];

        for (i = startIdx + 1, i2 = 1; i < ticks.length; i2++, i++) {
          ticks[i].atr = results[0][i2];
        }

        resolve(ticks);
      }
    );
  })
}
