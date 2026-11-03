const test = require('node:test');
const assert = require('node:assert');
const logic = require('../slive/atr-band-logic.js');

test('trueRange: high-low dominates', () => {
  assert.strictEqual(logic.trueRange(12, 9, 11), 3);   // max(3, 1, 2)
});
test('trueRange: gap up dominates', () => {
  assert.strictEqual(logic.trueRange(20, 18, 10), 10); // max(2, 10, 8)
});
test('trueRange: gap down dominates', () => {
  assert.strictEqual(logic.trueRange(9, 5, 12), 7);    // max(4, 3, 7)
});

// Hand-computed Wilder ATR, period 3.
// TR[0]=H-L=2; TR[1]=max(3,3,0)=3; TR[2]=max(1,0,1)=1; TR[3]=max(3,3,0)=3; TR[4]=max(1,0,1)=1
// seed(i0..2)=mean(2,3,1)=2 ; i3=(2*2+3)/3=7/3 ; i4=(7/3*2+1)/3=1.8888...
const atrCandles = [
  { high: 10, low: 8, close: 9 },
  { high: 12, low: 9, close: 11 },
  { high: 11, low: 10, close: 10 },
  { high: 13, low: 10, close: 12 },
  { high: 12, low: 11, close: 11 },
];
test('wilderATR: matches hand-computed value (period 3)', () => {
  const atr = logic.wilderATR(atrCandles, 3);
  assert.ok(Math.abs(atr - 1.8888888888888888) < 1e-9, 'got ' + atr);
});
test('wilderATR: exact seed when candles.length == period', () => {
  const atr = logic.wilderATR(atrCandles.slice(0, 3), 3);
  assert.strictEqual(atr, 2);   // mean(TR[0..2]) = mean(2,3,1)
});
test('wilderATR: null when too few candles', () => {
  assert.strictEqual(logic.wilderATR(atrCandles.slice(0, 2), 3), null);
  assert.strictEqual(logic.wilderATR([], 14), null);
  assert.strictEqual(logic.wilderATR(null, 14), null);
});

test('bandWidth: divides by 3 by default', () => {
  assert.strictEqual(logic.bandWidth(30), 10);
  assert.strictEqual(logic.bandWidth(30, 3), 10);
});
test('lines: anchor +/- width', () => {
  assert.deepStrictEqual(logic.lines(22000, 30), { highLine: 22030, lowLine: 21970 });
});

test('candleColor: green/red/doji', () => {
  assert.strictEqual(logic.candleColor({ open: 100, close: 105 }), 'green');
  assert.strictEqual(logic.candleColor({ open: 105, close: 100 }), 'red');
  assert.strictEqual(logic.candleColor({ open: 100, close: 100 }), 'doji');
});

// Band: highLine 22030, lowLine 21970
test('entrySignal: two green closes above HighLine -> CE', () => {
  const c = [{ open: 22020, close: 22040 }, { open: 22040, close: 22060 }];
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), 'CE');
});
test('entrySignal: two red closes below LowLine -> PE', () => {
  const c = [{ open: 21980, close: 21960 }, { open: 21960, close: 21940 }];
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), 'PE');
});
test('entrySignal: mixed colour -> null', () => {
  const c = [{ open: 22020, close: 22040 }, { open: 22060, close: 22050 }]; // green then red
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: second candle back inside band -> null', () => {
  const c = [{ open: 22020, close: 22040 }, { open: 22024, close: 22025 }]; // both green; 2nd close < highLine
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: green but not above the line -> null', () => {
  const c = [{ open: 22000, close: 22010 }, { open: 22010, close: 22020 }]; // green, below 22030
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: doji in the pair -> null', () => {
  const c = [{ open: 22040, close: 22040 }, { open: 22040, close: 22060 }]; // doji + green
  assert.strictEqual(logic.entrySignal(c, 22030, 21970), null);
});
test('entrySignal: fewer than two candles -> null', () => {
  assert.strictEqual(logic.entrySignal([{ open: 22020, close: 22040 }], 22030, 21970), null);
  assert.strictEqual(logic.entrySignal([], 22030, 21970), null);
});

test('target: +20 binds above ~66.7 premium', () => {
  assert.strictEqual(logic.target(100), 120);   // min(120, 130)
  assert.strictEqual(logic.target(80), 100);    // min(100, 104)
});
test('target: +30% binds below ~66.7 premium', () => {
  assert.strictEqual(logic.target(50), 65);     // min(70, 65)
  assert.strictEqual(logic.target(60), 78);     // min(80, 78)
});
test('target: custom pts/pct', () => {
  assert.strictEqual(logic.target(100, 45, 0.30), 130); // min(145, 130)
});

test('stopHitOnClose: CE stops on close below LowLine', () => {
  assert.strictEqual(logic.stopHitOnClose('CE', 21960, 22030, 21970), true);
  assert.strictEqual(logic.stopHitOnClose('CE', 21980, 22030, 21970), false);
});
test('stopHitOnClose: PE stops on close above HighLine', () => {
  assert.strictEqual(logic.stopHitOnClose('PE', 22040, 22030, 21970), true);
  assert.strictEqual(logic.stopHitOnClose('PE', 22020, 22030, 21970), false);
});
