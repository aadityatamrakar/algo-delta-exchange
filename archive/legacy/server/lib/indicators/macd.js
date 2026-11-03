const tulind = require('tulind');
const format = require('../strategies/tulip_ticks');

/**
 * @description MACD
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function macd(ticks, period = 14) {
    ticks = format(ticks);
    return new Promise((resolve, reject) => {
        tulind.indicators.macd.indicator(
            [ticks.close],
            [12, 26, 9],
            function (err, results) {
                resolve({macd: results[0], macd_signal: results[1], macd_histogram: results[2]});
            }
        );
    })
}