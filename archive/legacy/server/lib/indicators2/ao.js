const tulind = require('tulind');

/**
 * @description Awesome Oscillator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} AO
 */

module.exports = async function ao(ticks) {
  return new Promise((resolve, reject) => {
    tulind.indicators.ao.indicator(
      [ticks.high, ticks.low],
      [],
      function (err, results) {
        if (err) reject(err);
        let bf = ticks.close.length - results[0].length;
        for (let i = 0; i < bf; i++) results[0].unshift(0);
        resolve(results[0]);
      }
    );
  })
}
