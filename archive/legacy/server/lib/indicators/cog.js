/**
 * @description Center of Gravity
 * @param {Array} ticks (open/high/low/close)
 * @param {Number} threshold threshold value for signal generation
 * @param {Number} barsBack How many bars back to calculate COG values
 * @param {Number} period_cog period for COG calculation
 * @param {Number} period_high_low
 * @returns {Array} cog, cog_high, cog_low
 */

function getCOG(data, index, period = 14) {
  let a = 0,
    b = 0;

  for (let i = 0, n = index; i < period; i++) {
    a += data[n - i].close * (i + 1);
    b += data[n - i].close;
  }

  return parseFloat((a / b).toFixed(4))
}

module.exports = async function cog(ticks, threshold = 0.0004, barsBack = 30, period = 14, period_high_low = 3) {
  return new Promise((resolve, reject) => {
    let cog = [];
    let startIndex = ticks.length - 1; // start from last candle

    // calculate cog values for n bars back
    for (j = barsBack; j >= 0; j--) {
      let candle = ticks[startIndex - j];
      candle.cog = getCOG(ticks, startIndex - j, period);
      cog.push(candle);
    }

    // inital direction 
    let direction = '';
    // backfill index 
    let fillStartIndex = startIndex - barsBack;
    for (j = period_high_low; j < cog.length; j++) {
      let high = cog[j - 1].cog;
      let low = cog[j - 1].cog;
      for (x = 2; x <= period_high_low; x++) {
        low = low > cog[j - x].cog ? cog[j - x].cog : low;
        high = high < cog[j - x].cog ? cog[j - x].cog : high;
      }

      cog[j].cog_high = high;
      cog[j].cog_low = low;
      if ((cog[j].cog - low) > threshold && direction != 'SHORT') {
        direction = 'SHORT';
      } else if ((high - cog[j].cog) > threshold && direction != 'LONG') {
        direction = 'LONG';
      }
      cog[j].cog_signal = direction;
      ticks[fillStartIndex + j] = cog[j];
    }

    resolve(ticks);
  });
}
