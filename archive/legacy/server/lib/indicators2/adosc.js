const tulind = require('tulind');

/**
 * @description Accumulation/Distribution Oscillator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} AO
 */

module.exports = async function adsoc(ticks, short_period, long_period) {
  return new Promise((resolve, reject) => {
    tulind.indicators.adosc.indicator(
      [ticks.high, ticks.low, ticks.close, ticks.vol],
      [short_period, long_period],
      function (err, results) {
        if (err) reject(err);
        let bf = ticks.close.length - results[0].length;
        for (let i = 0; i < bf; i++) results[0].unshift(0);
        resolve(results[0]);
      }
    );
  })
}
