import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signRequest, signWsAuth } from '../src/index.ts'

/*
 * Expected digests computed OUTSIDE node, with
 *   printf '%s' '<prehash>' | openssl dgst -sha256 -hmac 'test-secret'
 * so the test does not merely re-run the implementation's own crypto.
 */

test('signs the documented pre-hash: GET + ts + path + query WITH the leading ?', () => {
  // delta-api-reference.md §2: `GET1542110948/v2/orders?product_id=1&state=open`
  const sig = signRequest('test-secret', 'GET', '/v2/orders', '?product_id=1&state=open', '', 1542110948)
  assert.equal(sig, '0d782b80c7da29f8316fb50c2bf9caf1fdf95a7036e3d2e9b6c2f232d87f9cd5')
})

test('a query passed without its ? signs differently (the ? is part of the pre-hash)', () => {
  const withQ = signRequest('test-secret', 'GET', '/v2/orders', '?product_id=1&state=open', '', 1542110948)
  const without = signRequest('test-secret', 'GET', '/v2/orders', 'product_id=1&state=open', '', 1542110948)
  assert.notEqual(withQ, without)
})

test('signs the documented order body as compact JSON', () => {
  const body = JSON.stringify({ order_type: 'limit_order', size: 3, side: 'buy', limit_price: '0.0005', product_id: 16 })
  assert.equal(body, '{"order_type":"limit_order","size":3,"side":"buy","limit_price":"0.0005","product_id":16}')
  const sig = signRequest('test-secret', 'POST', '/v2/orders', '', body, 1542110948)
  assert.equal(sig, '2e033c912a2861a4a8a41a1bac2de390aaf57235611259112d53e71a15ac3e71')
})

test('method is upper-cased before signing', () => {
  const a = signRequest('test-secret', 'get', '/v2/orders', '?product_id=1&state=open', '', 1542110948)
  assert.equal(a, '0d782b80c7da29f8316fb50c2bf9caf1fdf95a7036e3d2e9b6c2f232d87f9cd5')
})

test('the private-socket key-auth signs GET + ts + /live', () => {
  assert.equal(signWsAuth('test-secret', 1793690000), '514be687f67894ee28e10f4b8616d489fa79ab9e94200b053770c670ed58bab2')
})
