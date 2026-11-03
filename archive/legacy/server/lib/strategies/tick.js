/**
 * @description check tick type - green / red (up/down) 
 * @param {Object} tick
 * @returns {Number} return green - 1 / red - 0
 */

module.exports = function green_red(tick) {
    return (tick.open < tick.close) ? 1 : 0;
}