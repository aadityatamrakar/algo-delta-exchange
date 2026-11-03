/**
 * ATR + Supertrend — pure JavaScript, no native dependencies.
 *
 * WHY THIS WAS REWRITTEN (2026-07-25)
 * -----------------------------------
 * This file used to `require('tulind')`, a native addon (nan + node-pre-gyp) that
 * does not load on modern Node: it looks for a prebuilt binary per V8 ABI
 * (`lib/binding/Release/node-v<abi>-<platform>/tulind.node`) which is not
 * published for current versions.
 *
 * That made it the SINGLE blocker for upgrading the server off Node 16 (EOL
 * September 2023). The chain was:
 *
 *     server/server.js
 *       -> loopback-boot
 *         -> common/models/strategy-pnl.js:3
 *           -> server/lib/indicators/atr.js
 *             -> tulind            <-- fails to load
 *
 * Because `strategy-pnl` is a LoopBack model it loads on every boot, so the whole
 * app — and all ~150 strategy processes — failed to start on any Node newer than
 * the ABI tulind was built for. Verified: with tulind off this path, 51 of 53
 * remaining dependencies load cleanly on Node 24.
 *
 * BEHAVIOUR IS PRESERVED. The ATR is the same Wilder-smoothed calculation tulind
 * computes, with the same output shape; the Supertrend band/flip logic below is
 * byte-for-byte the original. Only the source of the ATR numbers changed.
 * `server/test/atr-indicator.test.js` pins it against
 * `server/slive/atr-band-logic.js` — the implementation already running live.
 *
 * CONTRACT (unchanged): mutates and returns the SAME `ticks` array, annotating
 * `.atr` (on startIdx) and `.supertrend` / `.upperband` / `.lowerband` /
 * `.supertrendTrg` from `startIdx + 1` onward.
 */

const format = require('../strategies/tulip_ticks');

/**
 * Wilder-smoothed ATR over `period`.
 *
 * Matches tulind's `atr` output shape: length `n - period + 1`, where element 0
 * corresponds to input index `period - 1`. The seed is the plain mean of the first
 * `period` true ranges, INCLUDING bar 0 whose TR is the degenerate `high - low`
 * (there is no previous close). That is Wilder's original convention and the same
 * seeding used by server/slive/atr-band-logic.js — excluding bar 0 would shift
 * every subsequent value and change what the live strategies trade on.
 */
function atrSeries(high, low, close, period) {
  const n = close.length;
  if (!Number.isFinite(period) || period <= 0 || n < period) return [];

  const tr = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = high[i] - low[i];
    } else {
      const prevClose = close[i - 1];
      tr[i] = Math.max(
        high[i] - low[i],
        Math.abs(high[i] - prevClose),
        Math.abs(low[i] - prevClose)
      );
    }
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let value = sum / period;

  const out = [value];
  for (let i = period; i < n; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out.push(value);
  }
  return out;
}

/**
 * @description Average true range + Supertrend, annotated onto `ticks`.
 * @param {Array} ticks candles with {high, low, close}
 * @param {Number} period ATR period
 * @param {Number} mul Supertrend band multiplier
 * @returns {Promise<Array>} the same `ticks` array, annotated
 */
module.exports = async function atr(ticks, period = 30, mul = 3) {
  let tulip_ticks = format(ticks);
  const results = [atrSeries(tulip_ticks.high, tulip_ticks.low, tulip_ticks.close, period)];

  // Guard added in the rewrite: on short input tulind invoked its callback with an
  // empty result array and the original then indexed ticks[startIdx] blindly,
  // throwing. Returning the un-annotated array is strictly safer, and callers
  // already have to cope with missing annotations.
  if (results[0].length === 0) return ticks;

  let startIdx = (ticks.length - results[0].length);
  ticks[startIdx].atr = results[0][0];

  let bought = 0;
  let supertrend = {
    upperBandBasic: 0,
    lowerBandBasic: 0,
    upperBand: 0,
    lowerBand: 0,
    supertrend: 0,
  };

  let lastSupertrend = {
    upperBandBasic: 0,
    lowerBandBasic: 0,
    upperBand: 0,
    lowerBand: 0,
    supertrend: 0,
  };

  // NOTE: `i` and `i2` were implicit globals in the original (declared with no
  // `let`/`var`). Scoped here — as globals they leak across calls, so two
  // concurrent invocations could corrupt each other's loop counters.
  for (let i = startIdx + 1, i2 = 1; i < ticks.length; i2++, i++) {
    let candle = ticks[i];
    let lastCandleClose = ticks[i - 1].close;
    let atrResult = results[0][i2];

    supertrend.upperBandBasic = ((candle.high + candle.low) / 2) + (mul * atrResult);
    supertrend.lowerBandBasic = ((candle.high + candle.low) / 2) - (mul * atrResult);

    if (supertrend.upperBandBasic < lastSupertrend.upperBand || lastCandleClose > lastSupertrend.upperBand)
      supertrend.upperBand = supertrend.upperBandBasic;
    else
      supertrend.upperBand = lastSupertrend.upperBand;

    if (supertrend.lowerBandBasic > lastSupertrend.lowerBand || lastCandleClose < lastSupertrend.lowerBand)
      supertrend.lowerBand = supertrend.lowerBandBasic;
    else
      supertrend.lowerBand = lastSupertrend.lowerBand;

    if (lastSupertrend.supertrend == lastSupertrend.upperBand && candle.close <= supertrend.upperBand)
      supertrend.supertrend = supertrend.upperBand;
    else if (lastSupertrend.supertrend == lastSupertrend.upperBand && candle.close >= supertrend.upperBand)
      supertrend.supertrend = supertrend.lowerBand;
    else if (lastSupertrend.supertrend == lastSupertrend.lowerBand && candle.close >= supertrend.lowerBand)
      supertrend.supertrend = supertrend.lowerBand;
    else if (lastSupertrend.supertrend == lastSupertrend.lowerBand && candle.close <= supertrend.lowerBand)
      supertrend.supertrend = supertrend.upperBand;
    else
      supertrend.supertrend = 0


    if (candle.close > supertrend.supertrend && bought !== 1) {
      bought = 1;
      ticks[i].supertrendTrg = 1;
    }

    if (candle.close < supertrend.supertrend && bought !== 0) {
      bought = 0;
      ticks[i].supertrendTrg = -1;
    }

    ticks[i].supertrend = supertrend.supertrend;
    ticks[i].upperband = supertrend.upperBandBasic;
    ticks[i].lowerband = supertrend.lowerBandBasic;
    Object.assign(lastSupertrend, supertrend);
  }

  return ticks;
};

// Exposed for the parity test.
module.exports.atrSeries = atrSeries;
