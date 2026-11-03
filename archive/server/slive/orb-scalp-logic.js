// ORB + QuickScalp — pure decision logic (no I/O).
// Unit-tested via server/test/orb-scalp-logic.test.js.
//
// The ORB signal math (computeRange / passesFilter / breakoutSide) is reused
// from orb-fut-logic.js; this module covers the option-execution decisions:
// ATM strike, CE/PE mapping, the spot stop level, and the quick-scalp exit.
// TIME-stop is handled by a setTimeout in the engine (not here), matching
// bn-breakout.js.

// Nearest tradable strike to the spot LTP (step 100 for BANKNIFTY/SENSEX, 50 for NIFTY).
function atmStrike(spotLtp, step) {
  return Math.round(spotLtp / step) * step;
}

// Breakout direction -> option type: up-break buys a CE, down-break buys a PE.
function sideFromSignal(signal) {
  return signal === 'BUY' ? 'CE' : 'PE';
}

// The ORB-SL (spot) level = the opposite end of the opening range.
function spotSl(side, rangeHigh, rangeLow) {
  return side === 'CE' ? rangeLow : rangeHigh;
}

// Quick-scalp exit decision. Precedence: forceExit(EOD) -> TARGET -> SL.
// Returns { exit: true, reason } or { exit: false }. NaN prices are ignored
// (that leg's condition simply can't fire this tick).
function evaluateExit(position, optLtp, spotLtp, opts = {}) {
  if (!position || position.status !== 'ACTIVE') return { exit: false };

  if (opts.forceExit) return { exit: true, reason: 'EOD' };

  if (typeof optLtp === 'number' && !Number.isNaN(optLtp) && optLtp >= position.target) {
    return { exit: true, reason: 'TARGET' };
  }

  if (typeof spotLtp === 'number' && !Number.isNaN(spotLtp)) {
    const slHit = position.side === 'CE'
      ? spotLtp < position.slSpot   // long side stops below the range low
      : spotLtp > position.slSpot;  // short side stops above the range high
    if (slHit) return { exit: true, reason: 'SL' };
  }

  return { exit: false };
}

module.exports = { atmStrike, sideFromSignal, spotSl, evaluateExit };
