const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Kaufman Adaptive Moving Average
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} AO
 */

module.exports = async function ao(ticks, period) {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.kama.indicator(
      [tulip_ticks.close],
      [period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i].ama = results[0][i2];
        }
        resolve(ticks);
      }
    );
  })
}
