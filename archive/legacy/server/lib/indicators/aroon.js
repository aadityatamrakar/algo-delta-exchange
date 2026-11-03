const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Aroon
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} Aroon Up/Down
 */

module.exports = async function aroon(ticks, period = 14) {
  let tulip_ticks = format(ticks);
  return new Promise((resolve, reject) => {
    tulind.indicators.aroon.indicator(
      [tulip_ticks.high, tulip_ticks.low],
      [period],
      function (err, results) {
        for (let i = (ticks.length - results[0].length), i2 = 0; i < ticks.length; i2++, i++) {
          ticks[i].aroon_up = Math.round(results[0][i2] * 100) / 100;
          ticks[i].aroon_down = Math.round(results[1][i2] * 100) / 100;

          if(ticks[i-1].aroon_up && ticks[i].aroon_up)
        }
        resolve(ticks);
      }
    );
  })
}
