const tulind = require('tulind');

/**
 * @description Stoch
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function stoch(ticks, period = 3, out_key = 'stoch') {
  return new Promise((resolve, reject) => {
    tulind.indicators.stoch.indicator(
      [ticks.high, ticks.low, ticks.close],
      [period, 3, 3],
      function (err, results) {
        if (err) reject(err);
        let bf = ticks.close.length - results[0].length;
        for (let i = 0; i < bf; i++) {
          results[0].unshift(0);
          results[1].unshift(0);
        }
        resolve({
          k: results[0]
          d: results[0]
        });
      }
    );
  })
}