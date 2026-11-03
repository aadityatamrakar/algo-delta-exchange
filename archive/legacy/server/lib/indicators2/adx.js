const tulind = require('tulind');

/**
 * @description ADX
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} adx
 */

module.exports = async function adx(ticks, period = 14) {
    return new Promise((resolve, reject) => {
        tulind.indicators.adx.indicator(
            [ticks.high, ticks.low, ticks.close],
            [period],
            function (err, results) {
                if (err) reject(err);
                let bf = ticks.close.length - results[0].length;
                for (let i = 0; i < bf; i++) results[0].unshift(0);
                resolve(results[0]);
            }
        );
    })
}