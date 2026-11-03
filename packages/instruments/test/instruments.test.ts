import test from 'node:test'
import assert from 'node:assert/strict'
import {
  InstrumentUniverse,
  INDEX_UNDERLYINGS,
  defineStock,
} from '../src/index.ts'

test('the five index underlyings are present with legacy-verified tokens', () => {
  const u = new InstrumentUniverse()
  assert.deepEqual(
    [...u.symbols].sort(),
    ['BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTY', 'SENSEX'],
  )
  // Tokens cross-checked against the legacy strategy files.
  assert.equal(u.require('NIFTY').spotToken, 256265)
  assert.equal(u.require('BANKNIFTY').spotToken, 260105)
  assert.equal(u.require('SENSEX').spotToken, 265)
  assert.equal(u.require('FINNIFTY').spotToken, 257801)
  assert.equal(u.require('MIDCPNIFTY').spotToken, 288009)
})

test('strike steps match the legacy convention', () => {
  const u = new InstrumentUniverse()
  assert.equal(u.require('NIFTY').strikeStep, 50)
  assert.equal(u.require('BANKNIFTY').strikeStep, 100)
  assert.equal(u.require('SENSEX').strikeStep, 100)
})

test('BANKNIFTY has no weekly expiry (withdrawn Nov 2024)', () => {
  assert.equal(new InstrumentUniverse().require('BANKNIFTY').weeklyExpiryDay, null)
})

test('SENSEX derivatives are on BFO, NSE names on NFO', () => {
  const u = new InstrumentUniverse()
  assert.equal(u.require('SENSEX').derivativeExchange, 'BFO')
  assert.equal(u.require('NIFTY').derivativeExchange, 'NFO')
})

test('require() throws helpfully for an unknown symbol', () => {
  assert.throws(() => new InstrumentUniverse().require('NOPE'), /unknown underlying 'NOPE'/)
  assert.equal(new InstrumentUniverse().get('NOPE'), undefined)
})

test('atmStrike rounds to the underlying grid', () => {
  const u = new InstrumentUniverse()
  assert.equal(u.atmStrike('NIFTY', 24_512), 24_500)
  assert.equal(u.atmStrike('NIFTY', 24_526), 24_550)
  assert.equal(u.atmStrike('BANKNIFTY', 51_249), 51_200)
  assert.equal(u.atmStrike('BANKNIFTY', 51_251), 51_300)
})

test('strikeWindow yields 2N+1 strikes centred on ATM', () => {
  const u = new InstrumentUniverse()
  const w = u.strikeWindow('NIFTY', 24_512, 2)
  assert.deepEqual(w, [24_400, 24_450, 24_500, 24_550, 24_600])
  assert.equal(u.strikeWindow('BANKNIFTY', 51_200, 10).length, 21)
})

test('strikeWindow never emits a non-positive strike', () => {
  const u = new InstrumentUniverse()
  const w = u.strikeWindow('NIFTY', 60, 5) // ATM 50, step 50 -> would go negative
  assert.ok(w.every((s) => s > 0), `got ${w.join(',')}`)
})

// --- adding stocks is config, not code ---------------------------------------

test('a stock underlying can be added without touching any strategy code', () => {
  const u = new InstrumentUniverse()
  u.add(defineStock({ symbol: 'RELIANCE', spotToken: 738561, strikeStep: 20, lotSize: 500 }))
  const r = u.require('RELIANCE')
  assert.equal(r.kind, 'stock')
  assert.equal(r.strikeStep, 20)
  assert.equal(r.lotSize, 500)
  assert.equal(r.weeklyExpiryDay, null, 'single-stock options are monthly-only')
  assert.equal(r.spotExchange, 'NSE')
  assert.equal(u.atmStrike('RELIANCE', 1447), 1440)
})

test('stocks and indices are separable', () => {
  const u = new InstrumentUniverse()
  u.add(defineStock({ symbol: 'TCS', spotToken: 2953217, strikeStep: 50, lotSize: 175 }))
  assert.equal(u.filter('index').length, INDEX_UNDERLYINGS.length)
  assert.deepEqual(u.filter('stock').map((s) => s.symbol), ['TCS'])
})

test('per-symbol strike steps are respected (stocks are not uniform)', () => {
  const u = new InstrumentUniverse()
  u.add(defineStock({ symbol: 'CHEAP', spotToken: 1, strikeStep: 2.5, lotSize: 1000 }))
  u.add(defineStock({ symbol: 'PRICEY', spotToken: 2, strikeStep: 100, lotSize: 25 }))
  assert.equal(u.atmStrike('CHEAP', 101.2), 100)
  assert.equal(u.atmStrike('PRICEY', 3149), 3100)
})

test('invalid underlying definitions are rejected at add time', () => {
  const u = new InstrumentUniverse()
  assert.throws(() => u.add(defineStock({ symbol: 'A', spotToken: 1, strikeStep: 0, lotSize: 1 })), /strikeStep/)
  assert.throws(() => u.add(defineStock({ symbol: 'B', spotToken: 1, strikeStep: 5, lotSize: 0 })), /lotSize/)
  assert.throws(() => u.add(defineStock({ symbol: 'C', spotToken: 0, strikeStep: 5, lotSize: 1 })), /spotToken/)
})
