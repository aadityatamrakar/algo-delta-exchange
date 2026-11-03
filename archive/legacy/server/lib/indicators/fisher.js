const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Fisher Transform
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} Ticks
 */

module.exports = async function fisher(ticks, period = 5, output_key = 'fisher') {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.fisher.indicator(
      [tulip_ticks.high, tulip_ticks.low],
      [period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i][output_key] = results[0][i2];
          ticks[i][output_key + '_signal'] = results[1][i2];
        }
        resolve(ticks);
      }
    );
  })
}
