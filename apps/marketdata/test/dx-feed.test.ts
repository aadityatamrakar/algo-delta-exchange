/**
 * The Delta price feed against a fake socket: frames in, bus messages out.
 * Raw frames go through `@algomaker/dx`'s own `parseFrame`, so the compact
 * wire keys are exercised end to end with no socket and no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrame, type DxFrame } from '@algomaker/dx'
import { DxFeed, dxTickPayload } from '../src/dx-feed.ts'
import { tickPayload } from '../src/main.ts'
import type { KiteTick } from '../src/kite-feed.ts'
import type { DxPublicSocketOptions } from '../src/dx-ports.ts'

const TS = 1_762_171_200_000

function rig(now = (): number => TS) {
  const published: { topic: string; payload: Record<string, unknown> }[] = []
  const subs: { channel: string; symbols: string[] }[] = []
  let opts: DxPublicSocketOptions | null = null
  let built = 0
  const feed = new DxFeed({
    url: 'wss://fake',
    socket: (_url, o) => {
      built++
      opts = o
      return { subscribe: (channel, symbols) => void subs.push({ channel, symbols: [...symbols] }), close: () => {} }
    },
    publish: (topic, payload) => void published.push({ topic, payload }),
    staleAfterMs: 180_000,
    now,
  })
  return {
    feed,
    published,
    subs,
    built: () => built,
    state: (s: string) => opts?.onState?.(s),
    frame: (raw: unknown) => opts?.onFrame?.(parseFrame(raw)),
  }
}

const tickerFrame = (over: Record<string, unknown> = {}) => ({
  type: 'ticker',
  sy: 'C-BTC-76600-041126',
  i: 161447,
  m: '212.4',
  sp: '76592.1',
  ts: 1_762_171_200_000_000,
  g: ['0.4815', '0.00012', '0.31', '-48.1', '21.7'],
  oi: ['1250', '95740.0'],
  q: ['215', '150', '209', '2000', null],
  qiv: ['0.452', '0.438', '0.445'],
  ...over,
})

test('a ticker frame becomes the Kite-shaped md.tick, plus the option fields', () => {
  const r = rig()
  r.feed.setInstruments([{ token: 161447, symbol: 'C-BTC-76600-041126' }], 14)
  r.feed.start()
  r.frame(tickerFrame())
  assert.equal(r.published.length, 1)
  const { topic, payload } = r.published[0]!
  assert.equal(topic, 'md.tick')
  assert.deepEqual(payload, {
    token: 161447,
    price: 212.4,
    ts: TS,
    oi: 1250,
    bid: 209,
    ask: 215,
    depth: { buy: [{ price: 209, qty: 2 }], sell: [{ price: 215, qty: 0.15 }] },
    bidSize: 2000,
    askSize: 150,
    mark: 212.4,
    iv: 0.445,
    delta: 0.4815,
    gamma: 0.00012,
    theta: -48.1,
    vega: 21.7,
  })

  // Every key the Kite path publishes for a two-sided packet with oi is here,
  // with the same type — the consumers read a Delta tick unchanged.
  const kite = tickPayload(
    {
      instrument_token: 1,
      last_price: 10,
      oi: 5,
      depth: { buy: [{ price: 9, quantity: 1, orders: 1 }], sell: [{ price: 11, quantity: 1, orders: 1 }] },
    } as unknown as KiteTick,
    TS,
  )
  const dx: Record<string, unknown> = r.published[0]!.payload
  for (const [k, v] of Object.entries(kite)) {
    assert.ok(k in dx, `md.tick is missing Kite field ${k}`)
    assert.equal(typeof dx[k], typeof v, `field ${k}`)
  }
})

test('a one-sided book publishes neither bid nor ask; price falls back to the mark', () => {
  const p = dxTickPayload(
    (parseFrame(tickerFrame({ q: ['', null, '209', '2000', null] })) as Extract<DxFrame, { kind: 'ticker' }>).quote,
    161447,
    TS,
  )
  assert.ok(p !== null)
  assert.equal(p['price'], 212.4)
  for (const k of ['bid', 'ask', 'depth', 'bidSize', 'askSize']) assert.ok(!(k in p), `${k} must be absent`)
})

test('no mark and a two-sided book: price is the mid; neither: nothing is published', () => {
  const r = rig()
  r.feed.setInstruments([{ token: 161447, symbol: 'C-BTC-76600-041126' }], null)
  r.feed.start()
  r.frame(tickerFrame({ m: null }))
  assert.equal(r.published[0]?.payload['price'], 212)
  assert.ok(!('mark' in r.published[0]!.payload))
  r.frame(tickerFrame({ m: '0', q: [null, null, null, null, null] }))
  assert.equal(r.published.length, 1)
})

test('absent option fields are omitted, never 0 or undefined', () => {
  const r = rig()
  r.feed.setInstruments([{ token: 161447, symbol: 'C-BTC-76600-041126' }], null)
  r.feed.start()
  r.frame({ type: 'ticker', sy: 'C-BTC-76600-041126', m: '212.4' })
  assert.deepEqual(r.published[0]?.payload, { token: 161447, price: 212.4, ts: TS, mark: 212.4 })
})

test('a ticker for a symbol the master does not hold is dropped', () => {
  const r = rig()
  r.feed.setInstruments([{ token: 161447, symbol: 'C-BTC-76600-041126' }], null)
  r.feed.start()
  r.frame(tickerFrame({ sy: 'C-BTC-99999-041126' }))
  r.frame({ not: 'a frame' })
  r.frame(null)
  assert.equal(r.published.length, 0)
})

test('spot_price .DEXBTUSD becomes md.spot BTC, and a tick on the spot token', () => {
  const r = rig()
  r.feed.setInstruments([], 14)
  r.feed.start()
  r.frame({ type: 'spot_price', sy: '.DEXBTUSD', p: '76588.6', ts: 1 })
  r.frame({ type: 'spot_price', sy: '.DEXETHUSD', p: '3000', ts: 1 })
  r.frame({ type: 'spot_price', sy: '.DEXBTUSD', p: '', ts: 1 })
  assert.deepEqual(r.published, [
    { topic: 'md.spot', payload: { underlying: 'BTC', price: 76588.6, ts: TS } },
    { topic: 'md.tick', payload: { token: 14, price: 76588.6, ts: TS } },
  ])
})

test('every connect subscribes spot and the whole chain; a reconnect replays it', () => {
  const r = rig()
  const options = Array.from({ length: 450 }, (_, i) => ({ token: 1000 + i, symbol: `C-BTC-${70000 + i * 100}-041126` }))
  r.feed.setInstruments(options, 14)
  r.feed.start()
  assert.equal(r.built(), 1)
  assert.equal(r.subs.length, 0, 'nothing is sent before the socket is open')

  r.state('connecting')
  r.state('open')
  const first = r.subs.splice(0)
  assert.deepEqual(first[0], { channel: 'spot_price', symbols: ['.DEXBTUSD'] })
  const chain = first.slice(1)
  assert.ok(chain.every((s) => s.channel === 'ticker' && s.symbols.length <= 200))
  assert.deepEqual(chain.flatMap((s) => s.symbols).sort(), options.map((o) => o.symbol).sort())

  r.state('reconnecting')
  assert.equal(r.feed.health().connected, false)
  r.state('open')
  const replay = r.subs.splice(0)
  assert.equal(replay.flatMap((s) => s.symbols).length, 451, 'spot + every option, again')
  assert.equal(r.built(), 1, 'the socket reconnects itself; the feed does not rebuild it')
})

test('a sync while connected subscribes only the new symbols; a delisted one is not replayed', () => {
  const r = rig()
  r.feed.setInstruments([{ token: 1, symbol: 'A' }, { token: 2, symbol: 'B' }], 14)
  r.feed.start()
  r.state('open')
  r.subs.splice(0)
  r.feed.setInstruments([{ token: 2, symbol: 'B' }, { token: 3, symbol: 'C' }], 14)
  assert.deepEqual(r.subs.splice(0), [{ channel: 'ticker', symbols: ['C'] }])
  assert.equal(r.feed.tokenCount, 2)
  r.state('closed')
  r.state('open')
  assert.deepEqual(r.subs.splice(0).flatMap((s) => s.symbols), ['.DEXBTUSD', 'B', 'C'])
})

test('health: never-ticked and silent tokens are stale; downForMs runs while disconnected', () => {
  let now = TS
  const r = rig(() => now)
  r.feed.setInstruments([{ token: 161447, symbol: 'C-BTC-76600-041126' }, { token: 2, symbol: 'B' }], null)
  r.feed.start()
  r.state('open')
  r.frame(tickerFrame())
  assert.deepEqual(r.feed.health(), { connected: true, downForMs: null, tokens: 2, staleTokens: 1, oldestAgeMs: 0 })
  now += 200_000
  r.state('reconnecting')
  now += 5_000
  assert.deepEqual(r.feed.health(), { connected: false, downForMs: 5_000, tokens: 2, staleTokens: 2, oldestAgeMs: 205_000 })
})

test('the display snapshot keeps the last two-sided book through a one-sided frame', () => {
  const r = rig()
  r.feed.setInstruments([{ token: 161447, symbol: 'C-BTC-76600-041126' }], null)
  r.feed.start()
  r.frame(tickerFrame())
  r.frame(tickerFrame({ m: '220', q: ['', null, '', null, null] }))
  assert.deepEqual(r.feed.lastPrice.get(161447), { price: 220, ts: TS, book: { bid: 209, ask: 215, ts: TS } })
})
