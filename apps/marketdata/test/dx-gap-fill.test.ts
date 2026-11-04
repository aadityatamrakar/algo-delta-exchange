/**
 * A quiet socket is filled from REST: held contracts only, stamped with the
 * exchange's time, never over a newer tick, and a frozen market stays stale.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrame, type DxTicker } from '@algomaker/dx'
import { DxFeed } from '../src/dx-feed.ts'
import { DxGapFill } from '../src/dx-gap-fill.ts'
import type { DxPublicSocketOptions } from '../src/dx-ports.ts'

const T0 = 1_793_770_000_000
const CE = 'C-BTC-77000-131126'
const PE = 'P-BTC-77000-131126'
const FAR = 'C-BTC-90000-131126'

function rig(topic?: string) {
  let clock = T0
  const published: { topic: string; payload: Record<string, unknown> }[] = []
  let opts: DxPublicSocketOptions | null = null
  const feed = new DxFeed({
    url: 'wss://fake',
    socket: (_u, o) => {
      opts = o
      return { subscribe: () => {}, close: () => {} }
    },
    publish: (t, payload) => void published.push({ topic: t, payload }),
    staleAfterMs: 180_000,
    now: () => clock,
    ...(topic === undefined ? {} : { tickTopic: topic }),
  })
  feed.setInstruments(
    [
      { token: 1, symbol: CE },
      { token: 2, symbol: PE },
      { token: 3, symbol: FAR },
    ],
    null,
  )
  feed.start()
  opts!.onState?.('open')
  const wsTick = (symbol: string): void =>
    opts!.onFrame?.(parseFrame({ type: 'ticker', sy: symbol, m: '2400', ts: clock * 1000, q: ['2395', '10', '2405', '10', null] }))
  return { feed, published, wsTick, at: (ms: number) => void (clock = T0 + ms), now: () => clock }
}

const ticker = (symbol: string, tsMs: number, mark = '2410'): DxTicker => ({
  symbol,
  product_id: 0,
  mark_price: mark,
  quotes: { best_bid: '2400', best_ask: '2420' },
  timestamp: tsMs * 1000,
})

test('a held contract silent past the gap is read from REST and published with the exchange stamp', async () => {
  const r = rig('md.tick.demo')
  r.wsTick(CE)
  r.wsTick(PE)
  r.at(12_000)
  const asked: string[] = []
  const gf = new DxGapFill({
    feed: r.feed,
    held: () => [CE, PE],
    ticker: async (s) => (asked.push(s), ticker(s, r.now() - 2_000)),
    tickers: async () => assert.fail('bulk call not expected for two contracts'),
  })
  const pass = await gf.runOnce()
  assert.deepEqual([...pass.silent].sort(), [CE, PE])
  assert.deepEqual([...pass.filled].sort(), [CE, PE])
  assert.deepEqual(asked.sort(), [CE, PE])
  const fills = r.published.slice(2)
  assert.equal(fills.length, 2)
  for (const f of fills) {
    assert.equal(f.topic, 'md.tick.demo')
    assert.equal(f.payload['ts'], T0 + 10_000, 'the exchange stamp, not receipt time')
    assert.equal(f.payload['price'], 2410)
    assert.equal(f.payload['bid'], 2400)
    assert.equal(f.payload['ask'], 2420)
  }
})

test('a ticking contract, and one no feed carries, are never read', async () => {
  const r = rig()
  r.wsTick(CE)
  r.at(5_000)
  const gf = new DxGapFill({
    feed: r.feed,
    held: () => [CE, 'C-BTC-1-010101'],
    ticker: async () => assert.fail('nothing is silent'),
    tickers: async () => assert.fail('nothing is silent'),
  })
  assert.deepEqual(await gf.runOnce(), { silent: [], filled: [] })
})

test('a frozen market stays stale: a REST quote no newer than the last tick is not published', async () => {
  const r = rig()
  r.wsTick(CE)
  r.at(30_000)
  const gf = new DxGapFill({
    feed: r.feed,
    held: () => [CE],
    ticker: async (s) => ticker(s, T0 - 1_000),
    tickers: async () => [],
  })
  const pass = await gf.runOnce()
  assert.deepEqual(pass.filled, [])
  assert.equal(r.published.length, 1, 'only the socket tick')
  assert.deepEqual(r.feed.silent([CE], 10_000), [CE], 'still silent, so still stale downstream')
})

test('a quote stamped in the future, or with no stamp, is not used', () => {
  const r = rig()
  r.at(20_000)
  assert.equal(r.feed.fill({ ...quote(CE), tsMs: r.now() + 60_000 }), false)
  assert.equal(r.feed.fill({ ...quote(CE), tsMs: null }), false)
  assert.equal(r.published.length, 0)
})

test('the whole socket quiet: one bulk call, filtered to the silent held contracts', async () => {
  const r = rig()
  r.at(15_000)
  let bulk = 0
  const gf = new DxGapFill({
    feed: r.feed,
    held: () => [CE, PE],
    perSymbolMax: 1,
    ticker: async () => assert.fail('per-symbol not expected past perSymbolMax'),
    tickers: async () => (bulk++, [ticker(CE, r.now() - 1_000), ticker(PE, r.now() - 1_000), ticker(FAR, r.now() - 1_000)]),
  })
  const pass = await gf.runOnce()
  assert.equal(bulk, 1)
  assert.deepEqual([...pass.filled].sort(), [CE, PE])
  assert.equal(r.published.length, 2, 'FAR is not held and is not laid in')
})

test('a gap logs once when it opens and once when the socket is back; a REST failure logs once', async () => {
  const r = rig()
  r.wsTick(CE)
  r.at(12_000)
  const logs: string[] = []
  let fail = true
  const gf = new DxGapFill({
    feed: r.feed,
    held: () => [CE],
    label: 'demo',
    ticker: async (s) => {
      if (fail) throw new Error('503')
      return ticker(s, r.now() - 500)
    },
    tickers: async () => [],
    log: (m) => void logs.push(m),
  })
  await gf.runOnce()
  r.at(15_000)
  await gf.runOnce()
  assert.deepEqual(logs, ['demo gap fill: REST read failed', 'demo gap fill: socket quiet, reading REST'])
  fail = false
  r.at(18_000)
  const pass = await gf.runOnce()
  assert.deepEqual(pass.filled, [CE])
  r.at(19_000)
  r.wsTick(CE)
  await gf.runOnce()
  assert.deepEqual(logs.slice(2), ['demo gap fill: REST reads working again', 'demo gap fill: socket ticking again'])
})

function quote(symbol: string) {
  return {
    symbol,
    productId: null,
    mark: 2400,
    spot: null,
    bid: 2395,
    ask: 2405,
    bidSize: 1,
    askSize: 1,
    iv: null,
    bidIv: null,
    askIv: null,
    oi: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    rho: null,
    tsMs: 0 as number | null,
    oiReduceOnly: null,
  }
}

test('held symbols: every non-zero leg of every book, once; a closed leg is not held', async () => {
  const { heldSymbols } = await import('../src/dx-main.ts')
  const leg = (s: string, qty: number) => ({ qty, instrument: { tradingsymbol: s } })
  assert.deepEqual(heldSymbols([{ legs: [leg(PE, -20), leg(CE, -20), leg(FAR, 0)] }, { legs: [leg(CE, -5)] }]), [CE, PE])
})
