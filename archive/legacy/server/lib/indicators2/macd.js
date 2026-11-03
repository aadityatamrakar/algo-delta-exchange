const tulind = require('tulind');

/**
 * @description MACD
 * @param {Array} ticks (open/high/low/close/vol)
 * @param {Number} period
 * @returns {Array} ema
 */

module.exports = async function macd(ticks, slow = 12, fast = 26, k = 9) {
    return new Promise((resolve, reject) => {
        tulind.indicators.macd.indicator(
            [ticks.close],
            [slow, fast, k],
            function (err, results) {
                if (err) reject(err);
                let bf = ticks.close.length - results[0].length;
                for (let i = 0; i < bf; i++) {
                    results[0].unshift(0);
                    results[1].unshift(0);
                    results[2].unshift(0);
                }
                resolve({ macd: results[0], macd_signal: results[1], macd_histogram: results[2] });
            }
        );
    })
}