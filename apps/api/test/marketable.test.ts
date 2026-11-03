import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketableFromEnv, marketableLimit, type MarketableConfig } from '../src/marketable.ts'

const cfg = (over: Partial<MarketableConfig> = {}): MarketableConfig => ({
  bufferPct: 0.02,
  minTicks: 2,
  tickSize: 0.05,
  ...over,
})

test('a SELL prices BELOW the mark so it crosses and fills', () => {
  // 2% of 28 = 0.56 (above the 2-tick floor of 0.10) -> 27.44, floored onto
  // the 0.05 grid.
  assert.equal(marketableLimit('Sell', 28, cfg()), 27.4)
})

test('a BUY prices ABOVE the mark so it crosses and fills', () => {
  // 28.56 -> ceiled onto the grid.
  assert.equal(marketableLimit('Buy', 28, cfg()), 28.6)
})

test('the tick floor takes over when the percentage is too small to cross', () => {
  // THE CASE THAT MOTIVATES THE FLOOR: 2% of 1.50 is 0.03 — smaller than one
  // 0.05 tick, so a percentage-only buffer rounds away to nothing and the
  // order rests instead of filling. The 2-tick floor (0.10) is what crosses.
  assert.equal(marketableLimit('Sell', 1.5, cfg()), 1.4)
  assert.equal(marketableLimit('Buy', 1.5, cfg()), 1.6)
})

test('the percentage takes over on an expensive contract', () => {
  // 2% of 500 = 10.00, hugely more than the 0.10 floor.
  assert.equal(marketableLimit('Buy', 500, cfg()), 510)
})

test('rounding goes in the direction that PRESERVES marketability', () => {
  // 2% of 7.35 = 0.147, so raw is 7.203 (sell) / 7.497 (buy) — neither on the
  // 0.05 grid. An off-grid limit is rejected or silently adjusted by the
  // exchange, so it is rounded here: a sell DOWN, a buy UP. Rounding to
  // NEAREST would pull the price back toward the mark and could cost the fill.
  assert.equal(marketableLimit('Sell', 7.35, cfg()), 7.2)
  assert.equal(marketableLimit('Buy', 7.35, cfg()), 7.5)
})

test('every result lands exactly on the tick grid', () => {
  for (const price of [1.5, 7.35, 28, 63.7, 104.25, 500]) {
    for (const side of ['Buy', 'Sell'] as const) {
      const p = marketableLimit(side, price, cfg()) as number
      assert.ok(p !== null, `${side} ${price} returned null`)
      assert.equal(
        Math.round(p * 100) % 5,
        0,
        `${side} ${price} -> ${p} is off the 0.05 grid`,
      )
    }
  }
})

test('a sell never prices at or below zero', () => {
  // A 0.05 option with a 0.10 buffer computes to -0.05, and a non-positive
  // price is rejected outright. It clamps to one tick: still legal, still
  // maximally aggressive.
  assert.equal(marketableLimit('Sell', 0.05, cfg()), 0.05)
  assert.equal(marketableLimit('Sell', 0.1, cfg()), 0.05)
})

test('an unusable mark yields null, never a fabricated price', () => {
  // Null means "leave this order alone". The caller must not invent a limit
  // from a price the feed never gave it.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(marketableLimit('Sell', bad, cfg()), null, `price ${bad}`)
  }
})

test('a non-positive tick size falls back to the NFO default of 0.05', () => {
  assert.equal(marketableLimit('Sell', 28, cfg({ tickSize: 0 })), 27.4)
})

test('a zero buffer still crosses by the tick floor', () => {
  // bufferPct 0 must not mean "price AT the mark" — that is a resting order,
  // which is the behaviour this whole module exists to avoid.
  assert.equal(marketableLimit('Sell', 28, cfg({ bufferPct: 0 })), 27.9)
})

// ------------------------------------------------------------ expiry day

test('a contract expiring TODAY prices with the WIDER expiry buffer', () => {
  // Expiry-day tape moves through 2% before the order rests a heartbeat —
  // a sell at 27.44 sat while the market fell through it. 10% of 28 = 2.80,
  // so the sell goes out at 25.20 and the fill is bought, not the price.
  assert.equal(marketableLimit('Sell', 28, cfg({ expiryBufferPct: 0.1 }), true), 25.2)
  assert.equal(marketableLimit('Buy', 28, cfg({ expiryBufferPct: 0.1 }), true), 30.8)
})

test('the expiry buffer is paid ONLY when the caller asserts expiry day', () => {
  // The decision path never asserts it — its config may carry the dial, but
  // its pricing must not move. Absent flag = base buffer, exactly as before.
  assert.equal(marketableLimit('Sell', 28, cfg({ expiryBufferPct: 0.1 })), 27.4)
})

test('a config without the expiry dial falls back to the base buffer on expiry day', () => {
  // A hand-built config that never opted in must not change behaviour just
  // because the caller learned the date.
  assert.equal(marketableLimit('Sell', 28, cfg(), true), 27.4)
})

test('the tick floor still wins on a cheap contract even on expiry day', () => {
  // 10% of 0.85 is 0.085 — still under the 2-tick floor of 0.10. The floor is
  // what crosses; the wide percentage changes nothing it did not already have.
  assert.equal(marketableLimit('Sell', 0.85, cfg({ expiryBufferPct: 0.1 }), true), 0.75)
  assert.equal(marketableLimit('Buy', 0.85, cfg({ expiryBufferPct: 0.1 }), true), 0.95)
})

// ------------------------------------------------------------- from the env

/**
 * ONE source for the config, because there are two construction sites —
 * `main.ts`'s bridge service and `routes/submit.ts`'s own — and this codebase
 * has twice been bitten by exactly that pair drifting apart (the live
 * allowlist, and the freeze table). Duplicating three `process.env` reads
 * would be the third.
 */
test('the env config defaults to 2% with a 2-tick floor on the NFO grid', () => {
  assert.deepEqual(marketableFromEnv({}), {
    bufferPct: 0.02,
    minTicks: 2,
    tickSize: 0.05,
    expiryBufferPct: 0.1,
  })
})

test('each dial is overridable independently', () => {
  assert.deepEqual(
    marketableFromEnv({
      DESK_MARKETABLE_BUFFER_PCT: '0.05',
      DESK_MARKETABLE_MIN_TICKS: '4',
      DESK_MARKETABLE_TICK: '0.1',
      DESK_MARKETABLE_EXPIRY_BUFFER_PCT: '0.15',
    }),
    { bufferPct: 0.05, minTicks: 4, tickSize: 0.1, expiryBufferPct: 0.15 },
  )
})

test('a non-numeric dial falls back to its default rather than becoming NaN', () => {
  // NaN would make `marketableLimit` answer NaN and route an order priced at
  // NaN — worse than the MARKET order this exists to replace.
  assert.deepEqual(
    marketableFromEnv({
      DESK_MARKETABLE_BUFFER_PCT: 'oops',
      DESK_MARKETABLE_EXPIRY_BUFFER_PCT: 'oops',
    }),
    { bufferPct: 0.02, minTicks: 2, tickSize: 0.05, expiryBufferPct: 0.1 },
  )
})
