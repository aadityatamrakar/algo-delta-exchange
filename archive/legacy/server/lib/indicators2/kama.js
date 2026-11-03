const tulind = require('tulind');

/**
 * @description kaufman adaptive moving average
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} kama
 */

module.exports = async function kama(ticks, period = 9) {
  return new Promise((resolve, reject) => {
    tulind.indicators.kama.indicator(
      [ticks.close],
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
