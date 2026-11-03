/**
 * oiCapStatus — Delta's per-product open-interest cap. While a product's
 * `oi_reduce_only_mode` is on (its OI value at or over `product_specs.max_oi_usd`)
 * Delta accepts reduce-only orders only. Figures are the India testnet's, 3 Nov 2026.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DxRest, oiCapStatus, type DxProduct, type DxTicker } from '../src/index.ts'

const product = (specs: DxProduct['product_specs']): DxProduct => ({
  id: 207610, symbol: 'C-BTC-77200-041126', contract_type: 'call_options', contract_value: '0.001', tick_size: '0.1',
  ...(specs === undefined ? {} : { product_specs: specs }),
})
const ticker = (oiUsd: string | null, mode?: boolean): DxTicker => ({
  symbol: 'C-BTC-77200-041126', product_id: 207610, oi_value_usd: oiUsd, ...(mode === undefined ? {} : { oi_reduce_only_mode: mode }),
})

test('capped: flag on and OI over the cap (the testnet call that was rejected)', () => {
  assert.deepEqual(oiCapStatus(product({ max_oi_usd: 2000000, oi_reduce_only_mode: true }), ticker('4233771.8649', true)), {
    capped: true, enforced: true, oiUsd: 4233771.8649, capUsd: 2000000, headroomUsd: -2233771.8649,
  })
})

test('not capped: flag absent — not enforced, figures still reported', () => {
  assert.deepEqual(oiCapStatus(product({ max_oi_usd: 2000000 }), ticker('108096.957', false)), {
    capped: false, enforced: false, oiUsd: 108096.957, capUsd: 2000000, headroomUsd: 1891903.043,
  })
  // even over the cap: the flag is what Delta enforces
  assert.equal(oiCapStatus(product({ max_oi_usd: 100 }), ticker('200')).capped, false)
})

test('the order notional counts: flag on, OI under the cap but the order would reach it', () => {
  const p = product({ max_oi_usd: 500000, oi_reduce_only_mode: true })
  assert.equal(oiCapStatus(p, ticker('499000', true), 500).capped, false)
  assert.equal(oiCapStatus(p, ticker('499000', true), 1000).capped, true, 'at the cap is capped')
  assert.equal(oiCapStatus(p, ticker('499000', true), 1500).capped, true)
})

test('the flag on either the product or the ticker enforces; unknown figures under the flag are capped', () => {
  assert.equal(oiCapStatus(product({ max_oi_usd: 1000 }), ticker('2000', true)).capped, true)
  assert.equal(oiCapStatus(product({ max_oi_usd: 1000, oi_reduce_only_mode: true }), ticker('2000')).capped, true)
  const unknown = oiCapStatus(product({ oi_reduce_only_mode: true }), ticker(null))
  assert.equal(unknown.capped, true, 'Delta has said reduce-only; missing figures cannot overrule it')
  assert.equal(unknown.oiUsd, null)
  assert.equal(unknown.capUsd, null)
  assert.equal(unknown.headroomUsd, null)
  assert.equal(oiCapStatus(product({ only_reduce_only_orders_allowed: true }), null).capped, true)
  assert.equal(oiCapStatus(product(undefined), null).capped, false)
})

test('DxRest.product and DxRest.ticker read one symbol from the public endpoints', async () => {
  const urls: string[] = []
  const fetchFn = (async (url: string | URL) => {
    urls.push(String(url))
    const body = String(url).includes('/tickers/') ? ticker('1', false) : product({ max_oi_usd: 1 })
    return new Response(JSON.stringify({ success: true, result: body }), { status: 200 })
  }) as unknown as typeof fetch
  const r = new DxRest({ baseUrl: 'https://dx.test', userAgent: 'ua', fetch: fetchFn })
  assert.equal((await r.product('C-BTC-77200-041126')).id, 207610)
  assert.equal((await r.ticker('C-BTC-77200-041126')).oi_value_usd, '1')
  assert.deepEqual(urls, ['https://dx.test/v2/products/C-BTC-77200-041126', 'https://dx.test/v2/tickers/C-BTC-77200-041126'])
})
