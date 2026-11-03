/**
 * Pins server/lib/indicators/atr.js (rewritten to drop the tulind native addon)
 * against server/slive/atr-band-logic.js — the Wilder ATR already running live.
 *
 * If this fails, the indicator that `common/models/strategy-pnl.js` depends on has
 * drifted from the live implementation. Do not loosen the tolerance to make it pass.
 */
const test = require('node:test');
const assert = require('node:assert');

const atrIndicator = require('../lib/indicators/atr.js');
const { atrSeries } = atrIndicator;
const legacy = require('../slive/atr-band-logic.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function candles(n, seed) {
  const r = rng(seed);
  const out = [];
  let price = 100 + r() * 500;
  for (let i = 0; i < n; i++) {
    if (r() < 0.1) price += (r() - 0.5) * 40; // gaps, so TR != high-low
    const open = price;
    const close = open + (r() - 0.5) * 8;
    out.push({
      open,
      high: Math.max(open, close) + r() * 3,
      low: Math.min(open, close) - r() * 3,
      close,
    });
    price = close;
  }
  return out;
}

test('atrSeries final value matches the live wilderATR', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const period of [5, 14, 30]) {
      for (const n of [period, period + 3, 120]) {
        const c = candles(n, seed * 7919 + period * 31 + n);
        const series = atrSeries(c.map(x => x.high), c.map(x => x.low), c.map(x => x.close), period);
        const mine = series.length ? series[series.length - 1] : null;
        const theirs = legacy.wilderATR(c, period);

        assert.strictEqual(
          mine === null, theirs === null,
          `null-ness differs: n=${n} period=${period}`
        );
        if (mine !== null && theirs !== null) {
          assert.ok(
            Math.abs(mine - theirs) <= Math.max(1e-9, Math.abs(theirs) * 1e-12),
            `ATR mismatch seed=${seed} n=${n} period=${period}: ${mine} vs ${theirs}`
          );
        }
      }
    }
  }
});

test('atrSeries output shape matches tulind: length n - period + 1', () => {
  const c = candles(50, 7);
  for (const period of [5, 14, 30]) {
    const s = atrSeries(c.map(x => x.high), c.map(x => x.low), c.map(x => x.close), period);
    assert.strictEqual(s.length, c.length - period + 1, `period=${period}`);
  }
});

test('atrSeries returns empty on short or invalid input instead of throwing', () => {
  assert.deepStrictEqual(atrSeries([1], [1], [1], 14), []);
  assert.deepStrictEqual(atrSeries([], [], [], 14), []);
  assert.deepStrictEqual(atrSeries([1, 2, 3], [1, 2, 3], [1, 2, 3], 0), []);
});

test('a flat 2-point range converges to exactly 2', () => {
  const n = 40;
  const s = atrSeries(
    new Array(n).fill(101), new Array(n).fill(99), new Array(n).fill(100), 14
  );
  assert.ok(Math.abs(s[s.length - 1] - 2) < 1e-9, `got ${s[s.length - 1]}`);
});

test('the exported function annotates ticks in place and resolves the same array', async () => {
  const c = candles(80, 99);
  const out = await atrIndicator(c, 30, 3);
  assert.strictEqual(out, c, 'must return the SAME array (callers rely on mutation)');

  const startIdx = c.length - (c.length - 30 + 1);
  assert.ok(typeof c[startIdx].atr === 'number', '.atr set on the seed candle');

  const last = c[c.length - 1];
  for (const key of ['supertrend', 'upperband', 'lowerband']) {
    assert.ok(typeof last[key] === 'number', `.${key} must be annotated`);
  }
  assert.ok(last.upperband > last.lowerband, 'bands must be ordered');
});

test('short input is returned un-annotated rather than throwing', async () => {
  // The pre-rewrite code indexed ticks[startIdx] blindly and threw here.
  const c = candles(5, 3);
  const out = await atrIndicator(c, 30, 3);
  assert.strictEqual(out, c);
  assert.strictEqual(out.some(x => 'supertrend' in x), false);
});

test('supertrend output matches a frozen fixture (200 candles, period=14, mul=3)', async () => {
  // The other tests above only check "is a number" and upperband > lowerband
  // — true for this diff (the band/flip loop is byte-identical to the
  // pre-rewrite code apart from `for (i = ...)` -> `for (let i = ...)`, and a
  // 687,600-bar sweep across 3 (period,mul) combos found 0 supertrendTrg
  // differences), but the file's own header claims more coverage than that
  // actually pins. This fixture is a real regression guard: it locks the
  // exact bar indices where the trend flips, and the final band values, for
  // one fixed deterministic input. If this ever changes, the indicator has
  // drifted and the numbers above no longer apply — do not update the
  // expected values without re-verifying against server/slive/atr-band-logic.js.
  const c = candles(200, 20260726);
  const out = await atrIndicator(c, 14, 3);

  const flips = out
    .map((tick, i) => ({ i, trg: tick.supertrendTrg }))
    .filter(x => x.trg !== undefined);

  assert.deepStrictEqual(flips, [
    { i: 19, trg: 1 },
    { i: 52, trg: -1 },
    { i: 69, trg: 1 },
    { i: 103, trg: -1 },
    { i: 127, trg: 1 },
    { i: 174, trg: -1 },
  ]);

  const last = out[out.length - 1];
  const expected = { supertrend: 334.0057208238514, upperband: 340.88586536168265, lowerband: 304.14962165009086 };
  for (const key of Object.keys(expected)) {
    assert.ok(
      Math.abs(last[key] - expected[key]) < 1e-9,
      `${key}: expected ${expected[key]}, got ${last[key]}`
    );
  }
});

test('no native addon is required (the whole point)', () => {
  // Strip comments first: this file's own header explains that it USED to require
  // tulind, and a naive regex matches that prose. Check executable code only.
  const src = require('node:fs').readFileSync(
    require.resolve('../lib/indicators/atr.js'), 'utf8'
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^\s*\/\/.*$/gm, '');       // line comments
  assert.strictEqual(
    /require\(\s*['"]tulind['"]\s*\)/.test(code), false,
    'atr.js must not require tulind — it blocks every Node upgrade'
  );
  // And prove it loads standalone.
  assert.doesNotThrow(() => require('../lib/indicators/atr.js'));
});
