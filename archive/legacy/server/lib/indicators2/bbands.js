const tulind = require('tulind');

/**
 * @description Bollinger Bands
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period = 20
 * @returns {Object} bbands - {lower, middle, upper}
 */

module.exports = async function bbands(ticks, period = 20, mul = 2) {
    return new Promise((resolve, reject) => {
        tulind.indicators.bbands.indicator(
            [ticks.close],
            [period, mul],
            function (err, results) {
                if (err) reject(err);
                let bf = ticks.close.length - results[0].length;
                for (let i = 0; i < bf; i++) {
                    results[0].unshift(0);
                    results[1].unshift(0);
                    results[2].unshift(0);
                }
                resolve({
                    lower: results[0],
                    middle: results[1],
                    upper: results[2]
                });
            }
        );
    })
}