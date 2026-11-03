const tulind = require('tulind');

/**
 * @description Money flow index
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} mfi
 */

module.exports = async function mfi(ticks, period = 9) {
  return new Promise((resolve, reject) => {
    tulind.indicators.mfi.indicator(
      [ticks.high, ticks.low, ticks.close, ticks.vol],
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
