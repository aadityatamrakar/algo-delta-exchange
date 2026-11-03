/**
 * The Delta DEMO (testnet) price feed: which contracts it carries, the topic
 * it publishes on, and its line on md.health.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrame } from '@algomaker/dx'
import type { InstrumentRow } from '@algomaker/instruments'
import { DxFeed } from '../src/dx-feed.ts'
import { demoInstruments, dxHealthPayload, DX_DEMO_WS_URL } from '../src/dx-main.ts'
import type { DxPublicSocketOptions } from '../src/dx-ports.ts'

const TS = Date.UTC(2026, 10, 10, 8)

const opt = (token: number, strike: number, cp: 'CE' | 'PE', expiry: string): InstrumentRow => {
  const [y, m, d] = expiry.split('-')
  return {
    instrument_token: token,
    tradingsymbol: `${cp === 'CE' ? 'C' : 'P'}-BTC-${strike}-${d}${m}${y!.slice(2)}`,
    name: 'BTC',
    expiry,
    strike,
    tick_size: 0.1,
    lot_size: 0.001,
    instrument_type: cp,
    segment: 'DX-OPT',
    exchange: 'DELTA',
  }
}
const ROWS: InstrumentRow[] = [
  opt(1, 77000, 'CE', '2026-11-13'),
  opt(2, 77000, 'PE', '2026-11-13'),
  opt(3, 78000, 'CE', '2026-11-14'),
  opt(4, 78000, 'PE', '2026-11-14'),
  opt(5, 79000, 'CE', '2026-11-20'),
]
const row = (tag: string, expiry: string, over: Record<string, unknown> = {}) => ({
  tag,
  symbol: 'BTC',
  expiry,
  mode: 'paper' as const,
  dx_paper_rail: 'demo' as const,
  dx_rail_used: null,
  ...over,
})
const leg = (token: number, symbol: string) => ({ instrument: { tradingsymbol: symbol, instrumentToken: token } })

test('the demo set is the chains of demo-rail books and the legs they hold — nothing else', () => {
  const got = demoInstruments({
    rows: ROWS,
    registry: [
      row('bs-daily', '2026-11-13'), // demo, entering → whole 13 Nov chain
      row('bs-sim', '2026-11-14', { dx_paper_rail: 'sim' }), // sim → nothing
      row('bs-simmed', '2026-11-14', { dx_rail_used: 'sim' }), // demo setting, simulated → nothing
      row('bs-live', '2026-11-14', { mode: 'live' }), // live → nothing
      row('bs-old', '2026-11-20'), // demo; holds leg 5 below
    ],
    books: [
      { tag: 'bs-old', mode: 'paper', legs: [leg(5, 'C-BTC-79000-201126')] },
      { tag: 'bs-sim', mode: 'paper', legs: [leg(3, 'C-BTC-78000-141126')] },
    ],
  })
  assert.deepEqual(
    got.map((o) => o.symbol).sort(),
    ['C-BTC-77000-131126', 'C-BTC-79000-201126', 'P-BTC-77000-131126'],
  )
  assert.deepEqual(got.find((o) => o.symbol === 'P-BTC-77000-131126'), { token: 2, symbol: 'P-BTC-77000-131126' })
})

test('a held leg is carried even when its row has left the master (expired, settling)', () => {
  const got = demoInstruments({
    rows: [],
    registry: [row('bs-old', '2026-11-20')],
    books: [{ tag: 'bs-old', mode: 'paper', legs: [leg(5, 'C-BTC-79000-201126')] }],
  })
  assert.deepEqual(got, [{ token: 5, symbol: 'C-BTC-79000-201126' }])
})

test('the demo feed publishes md.tick.demo keyed by the desk token, and no spot', () => {
  const published: { topic: string; payload: Record<string, unknown> }[] = []
  const subs: { channel: string; symbols: string[] }[] = []
  let opts: DxPublicSocketOptions | null = null
  const feed = new DxFeed({
    url: DX_DEMO_WS_URL,
    socket: (_u, o) => {
      opts = o
      return { subscribe: (c, s) => void subs.push({ channel: c, symbols: [...s] }), close: () => {} }
    },
    publish: (topic, payload) => void published.push({ topic, payload }),
    staleAfterMs: 180_000,
    now: () => TS,
    tickTopic: 'md.tick.demo',
    spot: false,
  })
  feed.setInstruments([{ token: 2, symbol: 'P-BTC-77000-131126' }], null)
  feed.start()
  opts!.onState?.('open')
  assert.deepEqual(subs, [{ channel: 'ticker', symbols: ['P-BTC-77000-131126'] }], 'no spot_price subscription')
  opts!.onFrame?.(parseFrame({ type: 'ticker', sy: 'P-BTC-77000-131126', m: '1808.5', q: ['1812', '10', '1805', '20', null] }))
  opts!.onFrame?.(parseFrame({ type: 'spot_price', sy: '.DEXBTUSD', p: '76000' }))
  assert.equal(published.length, 1)
  assert.equal(published[0]?.topic, 'md.tick.demo')
  assert.equal(published[0]?.payload['token'], 2)
  assert.equal(published[0]?.payload['price'], 1808.5)
})

test('md.health carries the demo socket, so a dropped testnet socket shows', () => {
  const nowMs = TS
  const feed = { connected: true, downForMs: null, tokens: 550, staleTokens: 0, oldestAgeMs: 0 }
  const p = dxHealthPayload({
    feed,
    nowMs,
    lastSyncMs: nowMs,
    staleAfterMs: 180_000,
    demo: { url: DX_DEMO_WS_URL, health: { connected: false, downForMs: 42_000, tokens: 3, staleTokens: 3, oldestAgeMs: 0 } },
  })
  assert.deepEqual(p['demo'], {
    url: 'wss://socket-ind-pub.testnet.deltaex.org',
    connected: false,
    downForMs: 42_000,
    tokens: 3,
    staleTokens: 3,
    oldestAgeMs: 0,
  })
  assert.equal(p['tokens'], 550, 'the prod figures are untouched')
  assert.ok(!('demo' in dxHealthPayload({ feed, nowMs, lastSyncMs: nowMs, staleAfterMs: 180_000 })))
})
