const tulind = require('tulind');

/**
 * @description Directional Indicator
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function di(ticks, period = 14) {
    return new Promise((resolve, reject) => {
        tulind.indicators.di.indicator(
            [ticks.high, ticks.low, ticks.close],
            [period],
            function (err, results) {
                if (err) reject(err);
                let bf = ticks.close.length - results[0].length;
                for (let i = 0; i < bf; i++) {
                    results[0].unshift(0);
                    results[1].unshift(0);
                }
                resolve({ plus: results[0], minus: results[1] });
            }
        );
    })
}