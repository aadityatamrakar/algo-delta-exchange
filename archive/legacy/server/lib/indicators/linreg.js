const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Lowest Low
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} Ticks
 */

module.exports = async function lowest(ticks, input_key = 'low', output_key = 'll', period = 20) {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    // console.log(tulind.indicators.linreg);
    tulind.indicators.linreg.indicator(
      [tulip_ticks[input_key]],
      [period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i][output_key] = results[0][i2];
        }
        resolve(ticks);
      }
    );
  })
}
