const tulind = require('tulind');

/**
 * @description Simple Moving Average
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} sma
 */

module.exports = async function sma(ticks, period) {
    return new Promise((resolve, reject) => {
        // ticks = ticks.slice(ticks.length - period);
        tulind.indicators.sma.indicator(
            [ticks],
            [period],
            function (err, results) {
                resolve(results[0]);
            }
        );
    })
}