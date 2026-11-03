const tulind = require('tulind');

/**
 * @description Simple Moving Average
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function wma(ticks, period = 3) {
  return new Promise((resolve, reject) => {
    tulind.indicators.vwma.indicator(
      [ticks.close, ticks['vol']],
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
