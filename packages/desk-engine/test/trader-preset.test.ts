/**
 * The `trader` preset (apps/traders advice): relief-r counting the whole
 * book's delta, with the target lock off. It sits beside PRESETS, not in it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDials } from '../src/dials.ts';
import { PRESETS, TRADER_PRESET } from '../src/presets.ts';

const reliefR = PRESETS.find((p) => p.key === 'recenter-relief-r');

test('trader is relief-r with two dials changed and nothing else', () => {
  assert.ok(reliefR);
  const base = reliefR.dials as Record<string, unknown>;
  const mine = TRADER_PRESET.dials as Record<string, unknown>;
  const diff: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (base[key] !== mine[key]) diff[key] = mine[key];
  }
  assert.deepEqual(diff, { delta_shorts_only: false, target_pnl: 0 });
});

test('gamma stays shorts-only', () => {
  assert.equal(TRADER_PRESET.dials.gamma_shorts_only, true);
});

test('trader is not a desk preset', () => {
  assert.equal(TRADER_PRESET.key, 'trader');
  assert.equal(PRESETS.some((p) => p.key === 'trader'), false);
});

test('it resolves with nothing refused', () => {
  assert.deepEqual(resolveDials(TRADER_PRESET.dials).unknown, []);
});

test('the clean-state facts advice relies on', () => {
  const d = resolveDials(TRADER_PRESET.dials).dials;
  assert.equal(d.anchor_ema_marks, 0);
  assert.equal(d.confirm_marks, 0);
  assert.equal(d.unwind_enabled, false);
  assert.equal(d.recycle_frac, 0);
  assert.equal(d.eod_flat_min, 0);
  assert.equal(d.balance_enabled, false);
  assert.equal(d.target_snap_multiple, 0);
  assert.equal(d.delta_lean_enabled, false);
});
