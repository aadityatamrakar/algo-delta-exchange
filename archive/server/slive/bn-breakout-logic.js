// bn-breakout — pure decision logic (no I/O), extracted from bn-breakout.js.
// Mechanical extraction: every function body here is byte-identical to the
// inline code it replaces in bn-breakout.js. See git history for the diff.

// ±pct band from the first 5-min candle's close (09:15-09:20).
function firstCandleBand(firstCandleClose, pct) {
  const offset = firstCandleClose * pct;
  return { highLine: firstCandleClose + offset, lowLine: firstCandleClose - offset };
}

// 'green' | 'red' | 'doji', matching bn-breakout.js's inline isGreen/isRed.
function candleColor(candle) {
  if (candle.close > candle.open) return 'green';
  if (candle.close < candle.open) return 'red';
  return 'doji';
}

// Body-close-through-the-band with matching colour. CE iff green and close >
// highLine; PE iff red and close < lowLine. Matches bn-breakout.js:153-162.
function breakoutSide(candle, highLine, lowLine) {
  const color = candleColor(candle);
  if (color === 'green' && candle.close > highLine) return 'CE';
  if (color === 'red' && candle.close < lowLine) return 'PE';
  return null;
}

// Premium target = entry + targetPts (bn-breakout.js:208).
function optionTarget(entryPremium, targetPts) {
  return entryPremium + targetPts;
}

// Opposite-line spot stop: CE stops on lowLine, PE stops on highLine
// (bn-breakout.js:209).
function slSpotFor(side, highLine, lowLine) {
  return side === 'CE' ? lowLine : highLine;
}

// Tick-level exit check. Precedence: forceExit(EOD/TIME) -> TARGET -> SL.
// Matches bn-breakout.js:227-241, generalised so EOD and the 90-min time stop
// share one 'forceExit' entry point (they always did the same thing:
// closePosition(reason) with no further branching on which reason it was).
function evaluateExit(position, optLtp, spotLtp, opts = {}) {
  if (!position || position.status !== 'ACTIVE') return { exit: false };
  if (opts.forceExit) return { exit: true, reason: opts.forceReason || 'EOD' };
  if (typeof optLtp === 'number' && optLtp >= position.target) return { exit: true, reason: 'TARGET' };
  if (typeof spotLtp === 'number') {
    if (position.side === 'CE' && spotLtp < position.slSpot) return { exit: true, reason: 'SL' };
    if (position.side === 'PE' && spotLtp > position.slSpot) return { exit: true, reason: 'SL' };
  }
  return { exit: false };
}

// A profitable-or-breakeven trade ends the day; a loss leaves the opposite
// side tradeable. Matches bn-breakout.js:264-273.
function dayContinuesAfterExit(pnl, otherSideAlreadyTraded) {
  if (pnl >= 0) return false;
  return !otherSideAlreadyTraded;
}

module.exports = {
  firstCandleBand, candleColor, breakoutSide, optionTarget, slSpotFor,
  evaluateExit, dayContinuesAfterExit,
};
