/**
 * THE LEG STAMP, AFTER THE LEAN WENT AWAY.
 *
 * `LegView.leanId` is still a required field and `apps/api`'s fold path still
 * carries it end to end (spec §3: "stays as an opaque package stamp if the fold
 * path needs it"). What changed is that NOTHING WRITES IT any more: the
 * hold-and-adjust engine has no lean identity, so every leg it opens reads back
 * `''`. That is the same value a manual leg and a recenter leg have always had,
 * and the point of this file is that it stays a VALUE rather than becoming an
 * `undefined` the moment the writer stopped writing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import { markLeg, RISK_FREE, type LegPosition } from '../src/marking.ts'
import type { ChainSnap, OptType, Quote } from '../src/types.ts'

const DATE = '2026-09-16' // a Wednesday, an NSE trading day
const EXPIRY = '2026-09-22' // NIFTY's weekly, the following Tuesday
const MINUTE = 600 // 10:00 IST
const T6 = 6 / 365
const VOL = 0.12
const SPOT = 24_000
const STEP = 50
const LOT = 65
/** 2026-09-16 10:00 IST as an epoch. A real instant, never `Date.now()`. */
const NOW = Date.UTC(2026, 8, 16, 4, 30)

const q = (bid: number, ask: number, asOf = NOW): Quote => ({ bid, ask, ltp: null, asOf })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so the
 * IV solve returns `VOL` and every greek marking sees is the model's. */
function bookAt(strike: number, type: OptType): Quote {
  const px = b76Price({ future: SPOT, strike, t: T6, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.995, px * 1.005)
}

const LADDER = Array.from({ length: 41 }, (_, i) => 23_000 + i * STEP)

const CHAIN: ChainSnap = {
  symbol: 'NIFTY',
  expiry: EXPIRY,
  step: STEP,
  lotSize: LOT,
  future: q(SPOT - 0.5, SPOT + 0.5),
  spot: SPOT,
  strikes: LADDER.map((k) => ({ strike: k, ce: bookAt(k, 'CE'), pe: bookAt(k, 'PE') })),
  asOf: NOW,
}

function position(over: Partial<LegPosition> = {}): LegPosition {
  return {
    instrument: 'NIFTY26SEP23950CE',
    strike: 23_950,
    optType: 'CE',
    side: 'Buy',
    lots: 2,
    lotSize: LOT,
    entry: 100,
    openedByEngine: true,
    leanId: '',
    ...over,
  }
}

test('a marked leg exposes the stamp the stored leg carried', () => {
  const view = markLeg(position({ leanId: 'pkg-1789533000000' }), bookAt(23_950, 'CE'), CHAIN, DATE, MINUTE, 'live')
  assert.equal(view.leanId, 'pkg-1789533000000')
})

test('an unstamped stored leg reads as the empty string, never undefined', () => {
  // The read side is REQUIRED as `''` while the write side is optional
  // (`types.ts`). A mapper that omitted it would hand a consumer `undefined`,
  // which compares equal to every other unmapped leg's `undefined`.
  const view = markLeg(position(), bookAt(23_950, 'CE'), CHAIN, DATE, MINUTE, 'live')
  assert.equal(view.leanId, '')
  assert.equal(typeof view.leanId, 'string')
})
