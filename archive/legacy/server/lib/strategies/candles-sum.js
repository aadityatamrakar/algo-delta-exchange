/**
 * @description Convert format
 * @param {Array} ticks
 * @returns {Object} return formatted object
 */

module.exports = function format(ticks1, ticks2) {
  ticks1 = ticks1.reduce(
    (arr, tick, index) => {
      let [ts, open, high, low, close, vol] = tick;
      let [ts2, open2, high2, low2, close2, vol2] = ticks2[index];
      arr.ts.push(ts);
      arr.open.push(open + open2);
      arr.high.push(high + high2);
      arr.low.push(low + low2);
      arr.close.push(close + close2);
      arr.vol.push(vol + vol2);
      return arr;
    },
    { ts: [], open: [], high: [], low: [], close: [], vol: [] }
  );
  return ticks1;
};
