const tulind = require('tulind');

/**
 * @description Lowest Low
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} Ticks
 */

module.exports = async function lowest(ticks, input_key = 'low', period = 20) {
  return new Promise((resolve, reject) => {
    tulind.indicators.linreg.indicator(
      [ticks[input_key]],
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
