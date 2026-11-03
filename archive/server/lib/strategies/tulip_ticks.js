/**
 * @description Convert format
 * @param {Array} ticks
 * @returns {Number} return array
 */

module.exports = function format(ticks, period) {
  if(typeof period == 'number') {
    ticks = ticks.slice(-period);
  }
  let vol_s = ticks[0].vol;
  ticks = ticks.reduce(
    (arr, tick) => {
      let { open, high, low, close, vol } = tick;
      arr.open.push(open);
      arr.high.push(high);
      arr.low.push(low);
      arr.close.push(close);
      arr.vol.push(vol - vol_s);
      vol_s = vol;
      return arr;
    },
    { open: [], high: [], low: [], close: [], vol: [] }
  );
  return ticks;
};
