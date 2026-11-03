const tulind = require('tulind');

/**
 * @description lin reg intercept
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} linregintercept
 */

module.exports = async function linregintercept(ticks, period = 9) {
  return new Promise((resolve, reject) => {
    tulind.indicators.linregintercept.indicator(
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
