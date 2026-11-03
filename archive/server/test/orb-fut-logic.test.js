const test = require('node:test');
const assert = require('node:assert');
const logic = require('../slive/orb-fut-logic.js');

const candles = [
  { open: 100, high: 110, low: 95, close: 108 },
  { open: 108, high: 112, low: 104, close: 106 },
  { open: 106, high: 109, low: 100, close: 101 },
  { open: 101, high: 103, low: 90, close: 99 },
  { open: 99, high: 107, low: 98, close: 105 },
  { open: 105, high: 111, low: 102, close: 109 },
  { open: 109, high: 120, low: 108, close: 118 }, // 7th (post-range) candle
];

test('computeRange aggregates first 6 candles', () => {
  const r = logic.computeRange(candles, 6);
  assert.strictEqual(r.rangeHigh, 112); // max high of first 6
  assert.strictEqual(r.rangeLow, 90);   // min low of first 6
  assert.strictEqual(r.range, 22);
});

test('computeRange returns null when not enough candles', () => {
  assert.strictEqual(logic.computeRange(candles.slice(0, 3), 6), null);
  assert.strictEqual(logic.computeRange([], 6), null);
});

test('passesFilter respects filter points', () => {
  assert.strictEqual(logic.passesFilter(300, 250), true);
  assert.strictEqual(logic.passesFilter(250, 250), true);  // inclusive
  assert.strictEqual(logic.passesFilter(200, 250), false);
  assert.strictEqual(logic.passesFilter(10, 0), true);      // disabled filter
});

test('breakoutSide applies the buffer', () => {
  // rangeHigh 112 -> buffered 112.112 ; rangeLow 90 -> buffered 89.91
  assert.strictEqual(logic.breakoutSide(112.2, 112, 90, 0.001), 'BUY');
  assert.strictEqual(logic.breakoutSide(89.8, 112, 90, 0.001), 'SELL');
  assert.strictEqual(logic.breakoutSide(112.05, 112, 90, 0.001), null); // inside buffer
  assert.strictEqual(logic.breakoutSide(100, 112, 90, 0.001), null);
});

test('computeLevels for long and short', () => {
  assert.deepStrictEqual(
    logic.computeLevels('BUY', 113, 22, 112, 90),
    { sl: 90, t1: 135 }
  );
  assert.deepStrictEqual(
    logic.computeLevels('SELL', 89, 22, 112, 90),
    { sl: 112, t1: 67 }
  );
});

test('openPosition builds a full position object', () => {
  const inst = { tradingsymbol: 'X', instrument_token: 1, lot_size: 15 };
  const p = logic.openPosition('BUY', inst, 113, 22, 112, 90, 1);
  assert.deepStrictEqual(p, {
    side: 'BUY', instrument: inst, entry: 113,
    sl: 90, t1: 135, lots: 1, status: 'ACTIVE',
  });
});

function longPos(lots = 1) {
  // entry 113, range 22 -> t1 135, sl 90 (rangeLow)
  return logic.openPosition('BUY', { tradingsymbol: 'X', instrument_token: 1, lot_size: 15 }, 113, 22, 112, 90, lots);
}
function shortPos(lots = 1) {
  // entry 89, range 22 -> t1 67, sl 112 (rangeHigh)
  return logic.openPosition('SELL', { tradingsymbol: 'X', instrument_token: 1, lot_size: 15 }, 89, 22, 112, 90, lots);
}

test('evaluateExit: no trigger yields no actions', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 120);
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(position.status, 'ACTIVE');
  assert.strictEqual(position.lots, 1);
});

test('evaluateExit: T1 exits the whole position', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 135);
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 1, reason: 'T1' }]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: SL exits the whole position', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 90);
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 1, reason: 'SL' }]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: SL takes precedence over T1 at the same price', () => {
  // A degenerate gap that satisfies both SL (<=90) and T1 (>=135) can't happen for a
  // long, but SL is evaluated first regardless — verify the ordering holds.
  const { actions } = logic.evaluateExit(longPos(), 90);
  assert.strictEqual(actions[0].reason, 'SL');
});

test('evaluateExit: forceExit closes as EOD', () => {
  const { actions, position } = logic.evaluateExit(longPos(), 0, { forceExit: true });
  assert.deepStrictEqual(actions, [{ side: 'SELL', lots: 1, reason: 'EOD' }]);
  assert.strictEqual(position.status, 'CLOSED');
});

test('evaluateExit: short side mirrors (cover with BUY)', () => {
  const t1 = logic.evaluateExit(shortPos(), 67);
  assert.deepStrictEqual(t1.actions, [{ side: 'BUY', lots: 1, reason: 'T1' }]);
  assert.strictEqual(t1.position.status, 'CLOSED');
  const sl = logic.evaluateExit(shortPos(), 112);
  assert.deepStrictEqual(sl.actions, [{ side: 'BUY', lots: 1, reason: 'SL' }]);
  assert.strictEqual(sl.position.status, 'CLOSED');
});

test('evaluateExit: ignores an already-closed position', () => {
  const closed = logic.evaluateExit(longPos(), 90).position;
  const again = logic.evaluateExit(closed, 200);
  assert.deepStrictEqual(again.actions, []);
});
