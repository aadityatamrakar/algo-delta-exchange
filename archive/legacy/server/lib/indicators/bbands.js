const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description Bollinger Bands
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period = 20
 * @returns {Object} bbands - {lower, middle, upper}
 */

module.exports = async function bbands(ticks, period = 20) {
    ticks = format(ticks, period);
    return new Promise((resolve, reject) => {
        tulind.indicators.bbands.indicator(
            [ticks.close],
            [period, 2],
            function (err, results) {
                let lower = results[0].slice(-1)[0], upper = results[2].slice(-1)[0], middle = results[1].slice(-1)[0];
                resolve({lower, middle, upper});
            }
        );
    })
}