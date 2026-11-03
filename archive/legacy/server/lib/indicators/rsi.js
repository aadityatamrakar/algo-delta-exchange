const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Directional Indicator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function rsi(ticks, period = 3, useVal = 'close', out_key = 'rsi') {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.rsi.indicator(
      [tulip_ticks[useVal]],
      [period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i][out_key] = results[0][i2];
        }
        resolve(ticks);
      }
    );
  })
}
