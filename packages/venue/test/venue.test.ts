import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NSE,
  DX,
  venueFromEnv,
  roundToStep,
  isOnStep,
  contractsOf,
} from '../src/index.ts';

const ms = (iso: string): number => Date.parse(iso);

test('DX dayKey rolls at the 12:00 UTC settlement', () => {
  assert.equal(DX.dayKey(ms('2026-11-03T11:59:59Z')), '2026-11-03');
  assert.equal(DX.dayKey(ms('2026-11-03T12:00:00Z')), '2026-11-04');
  assert.equal(DX.dayKey(ms('2026-11-03T00:00:00Z')), '2026-11-03');
});

test('NSE dayKey is the IST date', () => {
  assert.equal(NSE.dayKey(ms('2026-11-03T20:00:00Z')), '2026-11-04');
  assert.equal(NSE.dayKey(ms('2026-11-03T18:29:59Z')), '2026-11-03');
});

test('expiry instants', () => {
  assert.equal(DX.expiryInstantMs('2026-11-06'), Date.UTC(2026, 10, 6, 12));
  assert.equal(NSE.expiryInstantMs('2026-11-06'), Date.UTC(2026, 10, 6, 10));
});

test('isOpen', () => {
  assert.equal(DX.isOpen(ms('2026-11-01T03:00:00Z')), true); // Sunday
  assert.equal(NSE.isOpen(ms('2026-11-07T04:00:00Z')), false); // Saturday
  assert.equal(NSE.isOpen(ms('2026-11-03T04:00:00Z')), true);
  assert.equal(NSE.isOpen(ms('2026-11-03T03:29:59Z')), false); // 08:59 IST
  assert.equal(NSE.isOpen(ms('2026-11-03T10:00:00Z')), false); // 15:30 IST
  assert.equal(NSE.isOpen(ms('2026-11-10T04:00:00Z')), false); // holiday
});

test('spec constants', () => {
  assert.deepEqual(
    [NSE.id, NSE.currency, NSE.inrPerUnit, NSE.qtyStep, NSE.defaultTick, NSE.rate],
    ['nse', 'INR', 1, 1, 0.05, 0.065],
  );
  assert.deepEqual(
    [DX.id, DX.currency, DX.inrPerUnit, DX.qtyStep, DX.defaultTick, DX.rate],
    ['dx', 'USD', 85, 0.001, 0.1, 0],
  );
});

test('roundToStep is float-clean; flat is exactly 0', () => {
  assert.equal(roundToStep(0.05 + 0.05 + 0.05, 0.001), 0.15);
  assert.equal(roundToStep(0.15 - 0.05 - 0.05 - 0.05, 0.001), 0);
  assert.equal(roundToStep(7.4, 1), 7);
  assert.equal(roundToStep(0.1 + 0.2, 0.1), 0.3);
});

test('isOnStep and contractsOf round-trip', () => {
  assert.equal(isOnStep(0.15, 0.001), true);
  assert.equal(isOnStep(0.0005, 0.001), false);
  assert.equal(contractsOf(0.15, 0.001), 150);
  assert.equal(contractsOf(0.05 + 0.05 + 0.05, 0.001), 150);
  assert.equal(contractsOf(0, 0.001), 0);
  assert.equal(contractsOf(-0.007, 0.001), -7);
  assert.throws(() => contractsOf(0.0005, 0.001), RangeError);
  assert.throws(() => contractsOf(Number.NaN, 0.001), RangeError);
});

test('venueFromEnv', () => {
  assert.equal(venueFromEnv({}), NSE);
  assert.equal(venueFromEnv({ DESK_VENUE: 'nse' }), NSE);
  assert.equal(venueFromEnv({ DESK_VENUE: 'dx' }), DX);
  assert.throws(() => venueFromEnv({ DESK_VENUE: 'x' }));
});
