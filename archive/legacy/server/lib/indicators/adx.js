const tulind = require('tulind');
const format = require('./../strategies/tulip_ticks');

/**
 * @description ADX
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} adx
 */

module.exports = async function adx(ticks, period = 14) {
    ticks = format(ticks);
    return new Promise((resolve, reject) => {
        tulind.indicators.adx.indicator(
            [ticks.high, ticks.low, ticks.close],
            [period],
            function (err, results) {
                resolve({adx: results[0]});
            }
        );
    })
}