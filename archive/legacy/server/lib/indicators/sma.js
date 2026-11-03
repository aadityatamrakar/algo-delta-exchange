const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Simple Moving Average
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} sma
 */

module.exports = async function sma(ticks, period = 3, useVal = 'close', sma_key = 'sma') {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.sma.indicator(
      [tulip_ticks[useVal]],
      [period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i][sma_key] = results[0][i2];
        }
        resolve(ticks);
      }
    );
  })
}
