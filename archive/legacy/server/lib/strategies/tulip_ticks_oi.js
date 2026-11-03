/**
 * @description Convert format
 * @param {Array} ticks
 * @returns {Number} return array
 */

module.exports = function format(ticks, period) {
  if(typeof period == 'number') {
    ticks = ticks.slice(-period);
  }
  ticks = ticks.reduce(
    (arr, tick) => {
      let { open, high, low, close, vol, oi } = tick;
      arr.open.push(open);
      arr.high.push(high);
      arr.low.push(low);
      arr.close.push(close);
      arr.vol.push(vol);
      arr.oi.push(oi);
      return arr;
    },
    { open: [], high: [], low: [], close: [], vol: [], oi: [] }
  );
  return ticks;
};
