const tulind = require('tulind');

/**
 * @description Directional Indicator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function rsi(series, period = 10) {
  return new Promise((resolve, reject) => {
    tulind.indicators.rsi.indicator(
      [series],
      [period],
      function (err, results) {
        resolve(results[0]);
      }
    );
  })
}
