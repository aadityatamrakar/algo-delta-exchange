/**
 * Delta's per-product open-interest cap. While a product's OI value is at or
 * over `product_specs.max_oi_usd`, Delta accepts reduce-only orders only.
 *
 * OI value = oi_contracts × contract_value (0.001) × index — checked against
 * Delta's own `oi_value_usd` on the India testnet, 3 Nov 2026:
 *   C-BTC-77200-041126  55,371 × 0.001 × 76,462 ≈ $4,233,772  (cap $2,000,000) — rejected
 *   P-BTC-77000-061126   9,010 × 0.001 × 77,460 ≈ $697,913    (cap $500,000)   — rejected
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DxRest,
  oiCapCheck,
  oiCapStatus,
  oiUsdOf,
  toInstrumentRow,
  type DxProduct,
  type DxTicker,
} from '../src/index.ts'

const near = (a: number | null, b: number, tol: number): void => {
  assert.ok(a !== null && Math.abs(a - b) <= tol, `${a} ≈ ${b} ± ${tol}`)
}

test('oiUsdOf reproduces Delta\'s oi_value_usd for the two rejected testnet legs', () => {
  near(oiUsdOf(55_371, 0.001, 76_462), 4_233_771.8649, 30)
  near(oiUsdOf(9_010, 0.001, 77_460), 697_912.798, 10)
  assert.equal(oiUsdOf(null, 0.001, 76_462), null)
  assert.equal(oiUsdOf(55_371, 0.001, null), null)
  assert.equal(oiUsdOf(55_371, 0.001, 0), null)
})

test('the two real cases are capped by the formula, with the flag (basis flag)', () => {
  const ce = oiCapCheck({ oiUsd: oiUsdOf(55_371, 0.001, 76_462), capUsd: 2_000_000, reduceOnly: true })
  assert.equal(ce.capped, true)
  assert.equal(ce.basis, 'flag')
  near(ce.headroomUsd, -2_233_772, 30)
  const pe = oiCapCheck({ oiUsd: oiUsdOf(9_010, 0.001, 77_460), capUsd: 500_000, reduceOnly: true })
  assert.equal(pe.capped, true)
  near(pe.headroomUsd, -197_913, 10)
})

test('no flag but a listed cap is ENFORCED (basis cap): over the cap is capped', () => {
  const s = oiCapCheck({ oiUsd: 697_913, capUsd: 500_000, reduceOnly: false })
  assert.equal(s.capped, true)
  assert.equal(s.basis, 'cap')
  assert.equal(oiCapCheck({ oiUsd: 108_097, capUsd: 2_000_000, reduceOnly: false }).capped, false)
})

test('the order notional counts toward the cap; at the cap is capped', () => {
  assert.equal(oiCapCheck({ oiUsd: 499_000, capUsd: 500_000, reduceOnly: false, orderNotionalUsd: 500 }).capped, false)
  assert.equal(oiCapCheck({ oiUsd: 499_000, capUsd: 500_000, reduceOnly: false, orderNotionalUsd: 1000 }).capped, true)
})

test('a missing figure: capped on the flag alone, else not checkable', () => {
  assert.deepEqual(oiCapCheck({ oiUsd: null, capUsd: 2_000_000, reduceOnly: true }), {
    capped: true, basis: 'flag-no-figures', oiUsd: null, capUsd: 2_000_000, headroomUsd: null,
  })
  assert.deepEqual(oiCapCheck({ oiUsd: 100, capUsd: null, reduceOnly: false }), {
    capped: false, basis: 'no-figures', oiUsd: 100, capUsd: null, headroomUsd: null,
  })
})

test('oiCapStatus off a REST product + ticker uses oi_contracts × contract_value × the ticker spot', () => {
  const product: DxProduct = {
    id: 207610, symbol: 'C-BTC-77200-041126', contract_type: 'call_options', contract_value: '0.001', tick_size: '0.1',
    product_specs: { max_oi_usd: 2_000_000, oi_reduce_only_mode: true },
  }
  const ticker: DxTicker = { symbol: 'C-BTC-77200-041126', product_id: 207610, oi_contracts: '55371', spot_price: '76462' }
  const s = oiCapStatus(product, ticker)
  assert.equal(s.capped, true)
  near(s.oiUsd, 4_233_771.86, 30)
  // no spot on the ticker: the index passed in
  near(oiCapStatus(product, { ...ticker, spot_price: null }, 0, 76_462).oiUsd, 4_233_771.86, 30)
})

test('toInstrumentRow carries the cap and the flag from product_specs; false, not absent, when lifted', () => {
  const p: DxProduct = {
    id: 207610, symbol: 'C-BTC-77200-041126', contract_type: 'call_options', contract_value: '0.001', tick_size: '0.1',
    strike_price: '77200', settlement_time: '2026-11-04T12:00:00Z', underlying_asset: { id: 13, symbol: 'BTC' },
    product_specs: { max_oi_usd: 2_000_000, oi_reduce_only_mode: true },
  }
  const row = toInstrumentRow(p)
  assert.equal(row?.dx_max_oi_usd, 2_000_000)
  assert.equal(row?.dx_oi_reduce_only, true)
  const lifted = toInstrumentRow({ ...p, product_specs: { max_oi_usd: 2_000_000 } })
  assert.equal(lifted?.dx_oi_reduce_only, false)
  const none = toInstrumentRow({ ...p, product_specs: {} })
  assert.equal(none?.dx_max_oi_usd, null)
})

test('DxRest.product and DxRest.ticker read one symbol from the public endpoints', async () => {
  const urls: string[] = []
  const fetchFn = (async (url: string | URL) => {
    urls.push(String(url))
    const body = String(url).includes('/tickers/')
      ? { symbol: 'X', product_id: 1, oi_contracts: '1' }
      : { id: 207610, symbol: 'X', contract_type: 'call_options', contract_value: '0.001', tick_size: '0.1' }
    return new Response(JSON.stringify({ success: true, result: body }), { status: 200 })
  }) as unknown as typeof fetch
  const r = new DxRest({ baseUrl: 'https://dx.test', userAgent: 'ua', fetch: fetchFn })
  assert.equal((await r.product('C-BTC-77200-041126')).id, 207610)
  assert.equal((await r.ticker('C-BTC-77200-041126')).oi_contracts, '1')
  assert.deepEqual(urls, ['https://dx.test/v2/products/C-BTC-77200-041126', 'https://dx.test/v2/tickers/C-BTC-77200-041126'])
})
