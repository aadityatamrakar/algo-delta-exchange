/**
 * @description Convert format
 * @param {Array} ticks
 * @returns {Object} return formatted object
 */

module.exports = function format(ticks) {
  ticks = ticks.reduce(
    (arr, tick) => {
      let [ts, open, high, low, close, vol] = tick;
      arr.ts.push(ts);
      arr.open.push(open);
      arr.high.push(high);
      arr.low.push(low);
      arr.close.push(close);
      arr.vol.push(vol);
      return arr;
    },
    { ts: [], open: [], high: [], low: [], close: [], vol: [] }
  );
  return ticks;
};
