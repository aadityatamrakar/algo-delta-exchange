import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DX_DEMO_PUBLIC_WS_URL,
  DX_DEMO_REST_URL,
  DX_DEMO_WS_URL,
  DX_PROD_REST_URL,
  DX_PROD_WS_URL,
  assertRailHost,
  isDemoHost,
} from '../src/hosts.ts'

test('the testnet hosts are the ones Delta publishes for India', () => {
  assert.equal(DX_DEMO_REST_URL, 'https://cdn-ind.testnet.deltaex.org')
  assert.equal(DX_DEMO_WS_URL, 'wss://socket-ind.testnet.deltaex.org')
  assert.equal(DX_DEMO_PUBLIC_WS_URL, 'wss://socket-ind-pub.testnet.deltaex.org')
  assert.equal(DX_PROD_REST_URL, 'https://api.india.delta.exchange')
  assert.equal(DX_PROD_WS_URL, 'wss://socket.india.delta.exchange')
})

test('isDemoHost: only a *.testnet.deltaex.org host is testnet', () => {
  assert.equal(isDemoHost(DX_DEMO_REST_URL), true)
  assert.equal(isDemoHost(DX_DEMO_WS_URL), true)
  assert.equal(isDemoHost('https://CDN-IND.TESTNET.DELTAEX.ORG/'), true)
  assert.equal(isDemoHost(DX_PROD_REST_URL), false)
  assert.equal(isDemoHost(DX_PROD_WS_URL), false)
  // A look-alike is not testnet: the suffix must be a real label boundary.
  assert.equal(isDemoHost('https://eviltestnet.deltaex.org'), false)
  assert.equal(isDemoHost('https://testnet.deltaex.org.example.com'), false)
  assert.equal(isDemoHost('not a url'), false)
})

test('demo credentials never reach a production (or any non-testnet) host', () => {
  assert.doesNotThrow(() => assertRailHost('demo', DX_DEMO_REST_URL))
  assert.doesNotThrow(() => assertRailHost('demo', DX_DEMO_WS_URL))
  for (const url of [DX_PROD_REST_URL, DX_PROD_WS_URL, 'https://example.com', 'http://cdn-ind.testnet.deltaex.org', '']) {
    assert.throws(() => assertRailHost('demo', url), /demo/i, url)
  }
})

test('production credentials never reach testnet', () => {
  assert.doesNotThrow(() => assertRailHost('live', DX_PROD_REST_URL))
  assert.doesNotThrow(() => assertRailHost('live', DX_PROD_WS_URL))
  for (const url of [DX_DEMO_REST_URL, DX_DEMO_WS_URL, DX_DEMO_PUBLIC_WS_URL]) {
    assert.throws(() => assertRailHost('live', url), /testnet/i, url)
  }
  assert.throws(() => assertRailHost('live', 'garbage'), /not a URL/)
})
