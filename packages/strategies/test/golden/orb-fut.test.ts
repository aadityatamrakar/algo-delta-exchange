import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  computeOpeningRange, passesRangeFilter, breakoutSideFromRange,
  computeFutureLevels, evaluateFutureExit, type FuturePosition,
} from '../../src/range-breakout-directional/logic.ts'

const require_ = createRequire(import.meta.url)
// orb-fut-logic.js is pure and dependency-free — requireable directly, no shadow runner.
const legacy = require_('../../../../archive/server/slive/orb-fut-logic.js') as {
  computeRange(candles: unknown[], count?: number): { rangeHigh: number; rangeLow: number; range: number } | null
  passesFilter(range: number, filterPts: number): boolean
  breakoutSide(close: number, rangeHigh: number, rangeLow: number, bufferPct: number): 'BUY' | 'SELL' | null
  computeLevels(side: 'BUY' | 'SELL', entry: number, range: number, rangeHigh: number, rangeLow: number): { sl: number; t1: number }
  evaluateExit(position: FuturePosition, price: number, opts?: { forceExit?: boolean }): { actions: unknown[]; position: FuturePosition }
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function randomCandles(n: number, seed: number) {
  const rnd = makeRng(seed)
  const out: { ts: number; open: number; high: number; low: number; close: number }[] = []
  let price = 45000 + rnd() * 10000
  for (let i = 0; i < n; i++) {
    const open = price
    const close = open + (rnd() - 0.5) * 200
    const high = Math.max(open, close) + rnd() * 100
    const low = Math.min(open, close) - rnd() * 100
    out.push({ ts: i, open, high, low, close })
    price = close
  }
  return out
}

test('computeOpeningRange matches legacy computeRange across randomised 6-candle windows', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const candles = randomCandles(6 + (seed % 5), seed * 37)
    const mine = computeOpeningRange(candles, 6)
    const theirs = legacy.computeRange(candles, 6)
    assert.deepEqual(mine, theirs, `seed=${seed}`)
  }
})

test('passesRangeFilter matches legacy passesFilter, including the falsy-filter-disables-it case', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const range = rnd() * 500
    const filter = seed % 3 === 0 ? 0 : rnd() * 400
    assert.equal(passesRangeFilter(range, filter), legacy.passesFilter(range, filter), `seed=${seed}`)
  }
})

test('breakoutSideFromRange matches legacy breakoutSide across the buffer boundary', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = makeRng(seed)
    const rangeLow = 45000 + rnd() * 1000
    const rangeHigh = rangeLow + 100 + rnd() * 500
    const close = rangeLow - 200 + rnd() * (rangeHigh - rangeLow + 400)
    const bufferPct = 0.001
    assert.equal(
      breakoutSideFromRange(close, rangeHigh, rangeLow, bufferPct),
      legacy.breakoutSide(close, rangeHigh, rangeLow, bufferPct),
      `seed=${seed} close=${close} H=${rangeHigh} L=${rangeLow}`,
    )
  }
})

test('computeFutureLevels matches legacy computeLevels for both sides', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const side = seed % 2 === 0 ? 'BUY' : 'SELL'
    const entry = 45000 + rnd() * 5000
    const range = 100 + rnd() * 400
    const rangeHigh = entry + range / 2
    const rangeLow = entry - range / 2
    assert.deepEqual(
      computeFutureLevels(side, entry, range, rangeHigh, rangeLow),
      legacy.computeLevels(side, entry, range, rangeHigh, rangeLow),
      `seed=${seed}`,
    )
  }
})

test('evaluateFutureExit matches legacy evaluateExit across SL/T1/EOD and both sides', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = makeRng(seed)
    const side = seed % 2 === 0 ? 'BUY' : 'SELL'
    const position: FuturePosition = {
      side, entry: 50000, sl: side === 'BUY' ? 49800 : 50200, t1: side === 'BUY' ? 50400 : 49600,
      lots: 1, status: 'ACTIVE',
    }
    const price = 49500 + rnd() * 1500
    const forceExit = seed % 10 === 0
    const mine = evaluateFutureExit(position, price, { forceExit })
    const theirs = legacy.evaluateExit(position, price, { forceExit })
    assert.deepEqual(mine, theirs, `seed=${seed} price=${price} forceExit=${forceExit}`)
  }
})

import { ORB_FUT_BN, ORB_FUT_NIFTY, ORB_FUT_SNX } from '../../src/range-breakout-directional/configs/orb-fut.ts'
import { assertValidRangeBreakoutConfig } from '../../src/range-breakout-directional/config.ts'

test('the 3 wrapper configs carry the exact legacy literals and all pass config validation', () => {
  const tags = new Set<string>()
  for (const cfg of [ORB_FUT_BN, ORB_FUT_NIFTY, ORB_FUT_SNX]) {
    assert.doesNotThrow(() => assertValidRangeBreakoutConfig(cfg, tags))
    tags.add(cfg.tag)
  }
  assert.equal(ORB_FUT_BN.band.source === 'opening-range' && ORB_FUT_BN.band.rangeFilterPts, 250, 'BANKNIFTY needs range >= 250, per orb-fut-bn.js')
  assert.equal(ORB_FUT_NIFTY.band.source === 'opening-range' && ORB_FUT_NIFTY.band.rangeFilterPts, 0, 'NIFTY: no filter, per orb-fut-nifty.js')
  assert.equal(ORB_FUT_SNX.band.source === 'opening-range' && ORB_FUT_SNX.band.rangeFilterPts, 0, 'SENSEX: no filter, per orb-fut-snx.js')
})
