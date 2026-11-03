const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Stoch
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function stoch(ticks, period = 3, out_key = 'stoch') {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.stoch.indicator(
      [tulip_ticks.high, tulip_ticks.low, tulip_ticks.close],
      [period, 3, 3],
      function (err, results) {
        for (let i = 1, i2 = (ticks.length - results[0].length) + 1; i < results[0].length; i++, i2++) {
          ticks[i2][out_key + '_k'] = results[0][i];
          ticks[i2][out_key + '_d'] = results[1][i];
        }
        resolve(ticks);
      }
    );
  })
}