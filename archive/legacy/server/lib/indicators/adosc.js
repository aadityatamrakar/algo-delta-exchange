const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Accumulation/Distribution Oscillator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} AO
 */

module.exports = async function adsoc(ticks, short_period, long_period) {
  let tulip_ticks = format(ticks);
  let lastVal = 0;
  tulip_ticks.vol.forEach(element => {
    element -= lastVal;
    lastVal = element;
  });
  return new Promise((resolve, reject) => {
    tulind.indicators.adosc.indicator(
      [tulip_ticks.high, tulip_ticks.low, tulip_ticks.close, tulip_ticks.vol],
      [short_period, long_period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i].adsoc = results[0][i2];
        }
        resolve(ticks);
      }
    );
  })
}
