const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Simple Moving Average
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function wma(ticks, period = 3, useVal = 'close', ema_key = 'ema') {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.vwma.indicator(
      [tulip_ticks[useVal], tulip_ticks['vol']],
      [period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i][ema_key] = results[0][i2];
        }
        resolve(ticks);
      }
    );
  })
}
