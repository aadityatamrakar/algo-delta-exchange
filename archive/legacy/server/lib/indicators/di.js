const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Directional Indicator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function di(ticks, period = 14) {
    ticks = format(ticks);
    return new Promise((resolve, reject) => {
        tulind.indicators.di.indicator(
            [ticks.high, ticks.low, ticks.close],
            [period],
            function (err, results) {
                resolve({plus: results[0], minus: results[1]});
            }
        );
    })
}