const tulind = require('tulind');

/**
 * @description Fisher Transform
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} Ticks
 */

module.exports = async function fisher(ticks, period = 5, output_key = 'fisher') {
  return new Promise((resolve, reject) => {
    tulind.indicators.fisher.indicator(
      [ticks.high, ticks.low],
      [period],
      function (err, results) {
        if (err) reject(err);
        let bf = ticks.close.length - results[0].length;
        for (let i = 0; i < bf; i++) {
          results[0].unshift(0);
          results[1].unshift(0);
        }
        resolve({
          fisher: results[0],
          fisher_signal: results[1]
        });
      }
    );
  })
}
