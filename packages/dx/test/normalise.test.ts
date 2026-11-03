import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  contractsOf,
  parseFrame,
  quoteFromTicker,
  spotInstrumentRow,
  toInstrumentRow,
  toInstrumentRows,
  type DxProduct,
  type DxTicker,
} from '../src/index.ts'

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T

const products = fixture<{ result: DxProduct[] }>('products-btc.json').result
const tickers = fixture<{ result: DxTicker[] }>('tickers-btc-041126.json').result
const bySymbol = <T extends { symbol: string }>(xs: T[], s: string): T => {
  const x = xs.find((r) => r.symbol === s)
  assert.ok(x, `fixture has ${s}`)
  return x
}

test('toInstrumentRow maps C-BTC-76600-041126 to a CE row on the 0.001 grid', () => {
  const row = toInstrumentRow(bySymbol(products, 'C-BTC-76600-041126'))
  assert.deepEqual(row, {
    instrument_token: 161669,
    tradingsymbol: 'C-BTC-76600-041126',
    name: 'BTC',
    expiry: '2026-11-04',
    strike: 76600,
    tick_size: 0.1,
    lot_size: 0.001,
    instrument_type: 'CE',
    segment: 'DX-OPT',
    exchange: 'DELTA',
  })
})

test('a put maps to PE; non-BTC and non-option products map to null', () => {
  assert.equal(toInstrumentRow(bySymbol(products, 'P-BTC-76600-041126'))?.instrument_type, 'PE')
  assert.equal(toInstrumentRow(bySymbol(products, 'C-ETH-2800-041126')), null)
  assert.equal(toInstrumentRow(bySymbol(products, 'BTCUSD')), null)
})

test('expiry is the UTC date of settlement_time, not a local date', () => {
  const p = { ...bySymbol(products, 'C-BTC-76600-041126'), settlement_time: '2026-11-04T12:00:00Z' }
  assert.equal(toInstrumentRow(p)?.expiry, '2026-11-04')
  assert.equal(toInstrumentRow({ ...p, settlement_time: null }), null)
})

test('toInstrumentRows adds one .DEXBTUSD spot row from the products spot_index', () => {
  const rows = toInstrumentRows(products)
  assert.equal(rows.filter((r) => r.segment === 'DX-OPT').length, 3)
  const spots = rows.filter((r) => r.tradingsymbol === '.DEXBTUSD')
  assert.equal(spots.length, 1)
  assert.deepEqual(spots[0], spotInstrumentRow({ id: 14, symbol: '.DEXBTUSD', tick_size: '0.5' }))
  assert.equal(spots[0]?.segment, 'DX-INDICES')
  assert.equal(spots[0]?.expiry, '')
})

test('a REST ticker yields mark, bid, ask, sizes, mark IV, OI and greeks as numbers', () => {
  const q = quoteFromTicker(bySymbol(tickers, 'C-BTC-76600-041126'))
  assert.equal(q.symbol, 'C-BTC-76600-041126')
  assert.equal(q.productId, 161669)
  assert.equal(q.mark, 804.6642913)
  assert.equal(q.bid, 808)
  assert.equal(q.ask, 813)
  assert.equal(q.bidSize, 12740)
  assert.equal(q.askSize, 8474)
  assert.equal(q.iv, 0.46186823)
  assert.equal(q.bidIv, 0.46045467)
  assert.equal(q.askIv, 0.4633109)
  assert.equal(q.oi, 2567)
  assert.equal(q.delta, 0.50602561)
  assert.equal(q.gamma, 0.0001968)
  assert.equal(q.theta, -337.47238761)
  assert.equal(q.vega, 17.505544)
  assert.equal(q.rho, 1.24559207)
  assert.equal(q.spot, 76592.3)
  // `timestamp` is MICROseconds
  assert.equal(q.tsMs, 1793690103896)
})

test('an empty quote side is null, never 0', () => {
  const t = bySymbol(tickers, 'C-BTC-80400-041126')
  const q = quoteFromTicker({ ...t, quotes: { ...t.quotes, best_bid: '', bid_size: null } } as DxTicker)
  assert.equal(q.bid, null)
  assert.equal(q.bidSize, null)
  assert.equal(q.ask, 20)
})

test('a ws ticker frame (compact keys) parses to the same quote shape', () => {
  const f = parseFrame({
    type: 'ticker', sy: 'C-BTC-76600-041126', s: 'C-BTC-76600-041126', i: 161669,
    m: '804.66', sp: '76592.3', ts: 1793690103896736,
    g: ['0.506', '0.0001968', '1.2456', '-337.47', '17.5055'],
    oi: ['2567', '196630.1'],
    q: ['813', '8474', '808', '12740', null],
    qiv: ['0.4633', '0.4604', '0.4618'],
  })
  assert.equal(f.kind, 'ticker')
  if (f.kind !== 'ticker') return
  const q = f.quote
  assert.equal(q.productId, 161669)
  assert.equal(q.mark, 804.66)
  assert.equal(q.ask, 813)
  assert.equal(q.askSize, 8474)
  assert.equal(q.bid, 808)
  assert.equal(q.bidSize, 12740)
  assert.equal(q.askIv, 0.4633)
  assert.equal(q.bidIv, 0.4604)
  assert.equal(q.iv, 0.4618)
  // g order is delta, gamma, rho, theta, vega
  assert.equal(q.delta, 0.506)
  assert.equal(q.gamma, 0.0001968)
  assert.equal(q.rho, 1.2456)
  assert.equal(q.theta, -337.47)
  assert.equal(q.vega, 17.5055)
  assert.equal(q.oi, 2567)
  assert.equal(q.spot, 76592.3)
  assert.equal(q.tsMs, 1793690103896)
})

test('a futures ws ticker has null greeks and IVs rather than zeros', () => {
  const f = parseFrame({ type: 'ticker', sy: 'BTCUSD', i: 27, m: '72124.5', g: null, q: ['72101', '822', '72100', '2123', null], ts: 1 })
  assert.equal(f.kind, 'ticker')
  if (f.kind !== 'ticker') return
  assert.equal(f.quote.delta, null)
  assert.equal(f.quote.iv, null)
  assert.equal(f.quote.bid, 72100)
})

test('spot_price and ob_l1 frames parse; unknown frames pass through as other', () => {
  assert.deepEqual(parseFrame({ type: 'spot_price', sy: '.DEXBTUSD', p: '76588.6', ts: 1793690000123456 }), {
    kind: 'spot', symbol: '.DEXBTUSD', price: 76588.6, tsMs: 1793690000123,
  })
  assert.deepEqual(parseFrame({ type: 'ob_l1', sy: 'BTCUSD', ap: '68519.0', as: '285', bp: '68518.0', bs: '2452', ts: 2000 }), {
    kind: 'ob_l1', symbol: 'BTCUSD', ask: 68519, askSize: 285, bid: 68518, bidSize: 2452, tsMs: 2,
  })
  assert.equal(parseFrame({ type: 'heartbeat' }).kind, 'heartbeat')
  assert.equal(parseFrame({ type: 'subscriptions', channels: [] }).kind, 'subscriptions')
  assert.equal(parseFrame({ type: 'mystery' }).kind, 'other')
  assert.equal(parseFrame('not an object').kind, 'other')
})

test('contractsOf: integer contracts, float-clean, RangeError off the step', () => {
  assert.equal(contractsOf(0.05 + 0.05 + 0.05, 0.001), 150)
  assert.equal(contractsOf(0.15, 0.001), 150)
  assert.throws(() => contractsOf(0.0005, 0.001), RangeError)
})
