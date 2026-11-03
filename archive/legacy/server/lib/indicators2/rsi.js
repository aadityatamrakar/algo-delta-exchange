const tulind = require('tulind');

/**
 * @description Directional Indicator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function rsi(ticks, period = 3, useVal = 'close') {
  return new Promise((resolve, reject) => {
    tulind.indicators.rsi.indicator(
      [ticks[useVal]],
      [period],
      function (err, results) {
        if (err) reject(err);
        let bf = ticks.close.length - results[0].length;
        for (let i = 0; i < bf; i++) results[0].unshift(0);
        resolve(results[0]);
      }
    );
  })
}
