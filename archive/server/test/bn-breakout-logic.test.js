const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../slive/bn-breakout-logic.js');

test('firstCandleBand: 0.09% of 50000 gives the documented band', () => {
  const { highLine, lowLine } = logic.firstCandleBand(50000, 0.0009);
  assert.equal(highLine, 50045);
  assert.equal(lowLine, 49955);
});

test('breakoutSide requires BOTH the line break AND matching candle colour', () => {
  const highLine = 50045, lowLine = 49955;
  // green candle closing above highLine -> CE
  assert.equal(logic.breakoutSide({ open: 50000, close: 50100 }, highLine, lowLine), 'CE');
  // red candle closing above highLine (gap-and-fade) -> no signal, colour mismatch
  assert.equal(logic.breakoutSide({ open: 50200, close: 50100 }, highLine, lowLine), null);
  // red candle closing below lowLine -> PE
  assert.equal(logic.breakoutSide({ open: 50000, close: 49900 }, highLine, lowLine), 'PE');
});

test('evaluateExit: TARGET beats SL when both would fire on the same tick (precedence)', () => {
  const position = { status: 'ACTIVE', side: 'CE', target: 120, slSpot: 49955 };
  const r = logic.evaluateExit(position, 125, 49900);
  assert.deepEqual(r, { exit: true, reason: 'TARGET' });
});

test('evaluateExit: SL fires when only the spot line is crossed', () => {
  const position = { status: 'ACTIVE', side: 'CE', target: 120, slSpot: 49955 };
  const r = logic.evaluateExit(position, 90, 49900);
  assert.deepEqual(r, { exit: true, reason: 'SL' });
});

test('dayContinuesAfterExit: a loss leaves the opposite side tradeable', () => {
  assert.equal(logic.dayContinuesAfterExit(-50, false), true);
  assert.equal(logic.dayContinuesAfterExit(-50, true), false); // both sides already used
  assert.equal(logic.dayContinuesAfterExit(0, false), false);  // breakeven ends the day
});
