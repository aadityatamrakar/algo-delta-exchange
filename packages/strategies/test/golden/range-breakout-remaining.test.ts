import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  firstCandleBand, firstCandleBreakoutSide, candleColor,
  trueRange, wilderAtr, atrBandWidth, atrLines, atrEntrySignal, atrTarget, atrStopHitOnClose,
  atmStrike, sideFromSignal, spotSl, evaluateOptionExit, type OptionPosition,
} from '../../src/range-breakout-directional/logic.ts'

const require_ = createRequire(import.meta.url)
const bnBreakoutLegacy = require_('../../../../archive/server/slive/bn-breakout-logic.js') as {
  firstCandleBand(close: number, pct: number): { highLine: number; lowLine: number }
  breakoutSide(c: { open: number; close: number }, highLine: number, lowLine: number): 'CE' | 'PE' | null
}
const atrLegacy = require_('../../../../archive/server/slive/atr-band-logic.js') as {
  wilderATR(candles: unknown[], period?: number): number | null
  bandWidth(atr: number, divisor?: number): number
  lines(anchorClose: number, width: number): { highLine: number; lowLine: number }
  entrySignal(last2: unknown[] | null, highLine: number, lowLine: number): 'CE' | 'PE' | null
  target(entryPremium: number, targetPts?: number, targetPct?: number): number
  stopHitOnClose(side: 'CE' | 'PE', candleClose: number, highLine: number, lowLine: number): boolean
}
const orbScalpLegacy = require_('../../../../archive/server/slive/orb-scalp-logic.js') as {
  atmStrike(spotLtp: number, step: number): number
  sideFromSignal(signal: 'BUY' | 'SELL'): 'CE' | 'PE'
  spotSl(side: 'CE' | 'PE', rangeHigh: number, rangeLow: number): number
  evaluateExit(position: OptionPosition, optLtp?: number, spotLtp?: number, opts?: { forceExit?: boolean }): { exit: boolean; reason?: string }
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// ---- bn-breakout ----

test('firstCandleBand matches bn-breakout-logic.js exactly', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const close = 45000 + rnd() * 10000
    assert.deepEqual(firstCandleBand(close, 0.0009), bnBreakoutLegacy.firstCandleBand(close, 0.0009), `seed=${seed}`)
  }
})

test('firstCandleBreakoutSide matches bn-breakout-logic.js breakoutSide across colour/line combinations', () => {
  const cases = [
    { ts: 0, open: 50000, high: 50110, low: 49990, close: 50100, highLine: 50045, lowLine: 49955 }, // green, above high -> CE
    { ts: 0, open: 50200, high: 50210, low: 50090, close: 50100, highLine: 50045, lowLine: 49955 }, // red, above high -> null
    { ts: 0, open: 50000, high: 50010, low: 49890, close: 49900, highLine: 50045, lowLine: 49955 }, // red, below low -> PE
    { ts: 0, open: 50000, high: 50030, low: 49990, close: 50020, highLine: 50045, lowLine: 49955 }, // green, inside band -> null
  ]
  for (const c of cases) {
    assert.equal(
      firstCandleBreakoutSide(c, c.highLine, c.lowLine),
      bnBreakoutLegacy.breakoutSide(c, c.highLine, c.lowLine),
      JSON.stringify(c),
    )
  }
})

// ---- atr-band-nifty ----

function randomCandles(n: number, seed: number) {
  const rnd = makeRng(seed)
  const out: { ts: number; open: number; high: number; low: number; close: number }[] = []
  let price = 22000 + rnd() * 2000
  for (let i = 0; i < n; i++) {
    const open = price
    const close = open + (rnd() - 0.5) * 100
    const high = Math.max(open, close) + rnd() * 30
    const low = Math.min(open, close) - rnd() * 30
    out.push({ ts: i, open, high, low, close })
    price = close
  }
  return out
}

// THE ONLY parity check on `wilderAtr` now: it was also covered in
// `packages/indicators`, which was deleted (2026-08-16) with zero importers —
// this file is where the claim lives, at the class boundary that uses it.
test('wilderAtr matches atr-band-logic.js wilderATR', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const candles = randomCandles(20, seed * 13)
    assert.equal(wilderAtr(candles, 14), atrLegacy.wilderATR(candles, 14), `seed=${seed}`)
  }
})

test('atrBandWidth, atrLines, atrTarget, atrStopHitOnClose match legacy exactly', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const atr = 20 + rnd() * 80
    assert.equal(atrBandWidth(atr, 3), atrLegacy.bandWidth(atr, 3), `width seed=${seed}`)
    const anchor = 22000 + rnd() * 1000
    const width = atrBandWidth(atr, 3)
    assert.deepEqual(atrLines(anchor, width), atrLegacy.lines(anchor, width), `lines seed=${seed}`)
    const premium = 10 + rnd() * 100
    assert.equal(atrTarget(premium, 20, 0.3), atrLegacy.target(premium, 20, 0.3), `target seed=${seed}`)
    const side = seed % 2 === 0 ? 'CE' : 'PE'
    const close = anchor + (rnd() - 0.5) * width * 3
    assert.equal(atrStopHitOnClose(side, close, anchor + width, anchor - width), atrLegacy.stopHitOnClose(side, close, anchor + width, anchor - width), `stop seed=${seed}`)
  }
})

test('atrEntrySignal matches legacy entrySignal across 2-candle windows', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const candles = randomCandles(2, seed * 17)
    const highLine = 22100, lowLine = 21900
    assert.equal(atrEntrySignal(candles, highLine, lowLine), atrLegacy.entrySignal(candles, highLine, lowLine), `seed=${seed}`)
  }
})

// ---- orb-scalp ----

test('atmStrike/sideFromSignal/spotSl match orb-scalp-logic.js exactly', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const ltp = 22000 + rnd() * 2000
    const step = seed % 2 === 0 ? 50 : 100
    assert.equal(atmStrike(ltp, step), orbScalpLegacy.atmStrike(ltp, step), `atmStrike seed=${seed}`)
    const signal = seed % 2 === 0 ? 'BUY' : 'SELL'
    assert.equal(sideFromSignal(signal), orbScalpLegacy.sideFromSignal(signal), `sideFromSignal seed=${seed}`)
    const side = signal === 'BUY' ? 'CE' : 'PE'
    assert.equal(spotSl(side, ltp + 100, ltp - 100), orbScalpLegacy.spotSl(side, ltp + 100, ltp - 100), `spotSl seed=${seed}`)
  }
})

test('evaluateOptionExit matches legacy evaluateExit, including the NaN-ignored guard', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = makeRng(seed)
    const side = seed % 2 === 0 ? 'CE' : 'PE'
    const position: OptionPosition = { side, target: 120, slSpot: side === 'CE' ? 21900 : 22100, status: 'ACTIVE' }
    const optLtp = seed % 20 === 0 ? Number.NaN : 50 + rnd() * 150
    const spotLtp = seed % 25 === 0 ? Number.NaN : 21800 + rnd() * 400
    const forceExit = seed % 15 === 0
    assert.deepEqual(
      evaluateOptionExit(position, optLtp, spotLtp, { forceExit }),
      orbScalpLegacy.evaluateExit(position, optLtp, spotLtp, { forceExit }),
      `seed=${seed} optLtp=${optLtp} spotLtp=${spotLtp}`,
    )
  }
})

import { BN_BREAKOUT } from '../../src/range-breakout-directional/configs/bn-breakout.ts'
import { ATR_BAND_NIFTY } from '../../src/range-breakout-directional/configs/atr-band-nifty.ts'
import { ORB_SCALP_BN, ORB_SCALP_NIFTY, ORB_SCALP_SNX } from '../../src/range-breakout-directional/configs/orb-scalp.ts'
import { assertValidRangeBreakoutConfig } from '../../src/range-breakout-directional/config.ts'

test('all 5 configs validate, have unique tags, and orb-scalp runs 3 ISOLATED instances not one shared underlying', () => {
  const tags = new Set<string>()
  for (const cfg of [BN_BREAKOUT, ATR_BAND_NIFTY, ORB_SCALP_BN, ORB_SCALP_NIFTY, ORB_SCALP_SNX]) {
    assert.doesNotThrow(() => assertValidRangeBreakoutConfig(cfg, tags))
    tags.add(cfg.tag)
  }
  // The 3 orb-scalp instances must be 3 SEPARATE StrategyBase instances at
  // runtime (design spec section 4.3) — proven here by 3 distinct tags/configs,
  // never one instance juggling three underlyings internally.
  assert.equal(tags.has('ORB_SCALP_BN') && tags.has('ORB_SCALP_NIFTY') && tags.has('ORB_SCALP_SNX'), true)
  assert.equal(ORB_SCALP_BN.underlying.symbol !== ORB_SCALP_NIFTY.underlying.symbol, true)
})
