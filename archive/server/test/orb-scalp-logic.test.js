const test = require('node:test');
const assert = require('node:assert');
const logic = require('../slive/orb-scalp-logic.js');

// ---- atmStrike ----
test('atmStrike rounds to nearest step 100 (BANKNIFTY/SENSEX)', () => {
  assert.strictEqual(logic.atmStrike(48240, 100), 48200);
  assert.strictEqual(logic.atmStrike(48260, 100), 48300);
  assert.strictEqual(logic.atmStrike(48250, 100), 48300); // .5 rounds up
  assert.strictEqual(logic.atmStrike(79860, 100), 79900); // SENSEX
});

test('atmStrike rounds to nearest step 50 (NIFTY)', () => {
  assert.strictEqual(logic.atmStrike(24522, 50), 24500);
  assert.strictEqual(logic.atmStrike(24526, 50), 24550);
  assert.strictEqual(logic.atmStrike(24525, 50), 24550); // .5 rounds up
});

// ---- sideFromSignal ----
test('sideFromSignal maps breakout direction to option type', () => {
  assert.strictEqual(logic.sideFromSignal('BUY'), 'CE');
  assert.strictEqual(logic.sideFromSignal('SELL'), 'PE');
});

// ---- spotSl ----
test('spotSl is the opposite ORB end', () => {
  assert.strictEqual(logic.spotSl('CE', 48500, 48000), 48000); // CE stops at rangeLow
  assert.strictEqual(logic.spotSl('PE', 48500, 48000), 48500); // PE stops at rangeHigh
});

// ---- evaluateExit ----
function cePos() {
  return {
    side: 'CE',
    instrument: { tradingsymbol: 'X', instrument_token: 1, lot_size: 15 },
    entryPremium: 200, target: 240, slSpot: 48000, status: 'ACTIVE',
  };
}
function pePos() {
  return {
    side: 'PE',
    instrument: { tradingsymbol: 'Y', instrument_token: 2, lot_size: 15 },
    entryPremium: 200, target: 225, slSpot: 48500, status: 'ACTIVE',
  };
}

test('evaluateExit: no trigger yields no exit', () => {
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 210, 48200), { exit: false });
});

test('evaluateExit: CE premium target hit', () => {
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 240, 48200), { exit: true, reason: 'TARGET' });
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 260, 48200), { exit: true, reason: 'TARGET' });
});

test('evaluateExit: CE spot stop when spot breaks below ORB-SL', () => {
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 210, 47990), { exit: true, reason: 'SL' });
});

test('evaluateExit: CE spot exactly at SL does not exit (strict cross)', () => {
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 210, 48000), { exit: false });
});

test('evaluateExit: PE premium target hit', () => {
  assert.deepStrictEqual(logic.evaluateExit(pePos(), 225, 48400), { exit: true, reason: 'TARGET' });
});

test('evaluateExit: PE spot stop when spot breaks above ORB-SL', () => {
  assert.deepStrictEqual(logic.evaluateExit(pePos(), 210, 48510), { exit: true, reason: 'SL' });
});

test('evaluateExit: PE spot exactly at SL does not exit', () => {
  assert.deepStrictEqual(logic.evaluateExit(pePos(), 210, 48500), { exit: false });
});

test('evaluateExit: forceExit closes as EOD regardless of price', () => {
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 0, 0, { forceExit: true }), { exit: true, reason: 'EOD' });
});

test('evaluateExit: TARGET takes precedence over SL on a combined tick', () => {
  // premium at target AND spot through SL in the same tick -> book the win
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 240, 47990), { exit: true, reason: 'TARGET' });
});

test('evaluateExit: forceExit takes precedence over everything', () => {
  assert.deepStrictEqual(logic.evaluateExit(cePos(), 240, 47990, { forceExit: true }), { exit: true, reason: 'EOD' });
});

test('evaluateExit: an already-closed position never exits', () => {
  const p = cePos(); p.status = 'CLOSED';
  assert.deepStrictEqual(logic.evaluateExit(p, 240, 47990, { forceExit: true }), { exit: false });
});

test('evaluateExit: tolerates a missing/NaN option or spot price', () => {
  // no option tick -> can't judge target; no spot tick -> can't judge SL; no exit
  assert.deepStrictEqual(logic.evaluateExit(cePos(), NaN, NaN), { exit: false });
  // spot present, still below-cross check works
  assert.deepStrictEqual(logic.evaluateExit(cePos(), NaN, 47990), { exit: true, reason: 'SL' });
});
