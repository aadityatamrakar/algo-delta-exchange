// ATR-Band NIFTY — pure decision logic (no I/O).
// Unit-tested via server/test/atr-band-logic.test.js.

// True Range for one candle given the previous candle's close.
function trueRange(high, low, prevClose) {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

// Wilder ATR over `period` on candles ordered oldest->newest ({high,low,close}).
// Returns the last ATR value, or null if fewer than `period` candles.
function wilderATR(candles, period = 14) {
  if (!candles || candles.length < period) return null;
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) tr.push(candles[i].high - candles[i].low);
    else tr.push(trueRange(candles[i].high, candles[i].low, candles[i - 1].close));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr = atr / period;                                  // seed = SMA of first `period` TRs
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;        // Wilder smoothing
  }
  return atr;
}

// Band half-width.
function bandWidth(atr, divisor = 3) {
  return atr / divisor;
}

// The frozen band lines around an anchor close.
function lines(anchorClose, width) {
  return { highLine: anchorClose + width, lowLine: anchorClose - width };
}

// 'green' (bullish), 'red' (bearish), or 'doji'.
function candleColor(candle) {
  if (candle.close > candle.open) return 'green';
  if (candle.close < candle.open) return 'red';
  return 'doji';
}

// Entry side from the last two completed candles. CE iff both green and both
// close above highLine; PE iff both red and both close below lowLine; else null.
function entrySignal(last2, highLine, lowLine) {
  if (!last2 || last2.length < 2) return null;
  const a = last2[last2.length - 2];
  const b = last2[last2.length - 1];
  const bothGreen = candleColor(a) === 'green' && candleColor(b) === 'green';
  const bothRed = candleColor(a) === 'red' && candleColor(b) === 'red';
  if (bothGreen && a.close > highLine && b.close > highLine) return 'CE';
  if (bothRed && a.close < lowLine && b.close < lowLine) return 'PE';
  return null;
}

// Premium target: the nearer of +pts and +pct%.
function target(entryPremium, targetPts = 20, targetPct = 0.30) {
  return Math.min(entryPremium + targetPts, entryPremium * (1 + targetPct));
}

// Far-opposite-line candle-close stop. CE stops if close < lowLine; PE if close > highLine.
function stopHitOnClose(side, candleClose, highLine, lowLine) {
  if (side === 'CE') return candleClose < lowLine;
  if (side === 'PE') return candleClose > highLine;
  return false;
}

module.exports = { trueRange, wilderATR, bandWidth, lines, candleColor, entrySignal, target, stopHitOnClose };
