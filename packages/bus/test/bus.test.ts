import test from 'node:test'
import assert from 'node:assert/strict'
import { InProcessTransport, topicMatches } from '../src/index.ts'

test('exact and wildcard topic matching', () => {
  assert.equal(topicMatches('md.index.NIFTY', 'md.index.NIFTY'), true)
  assert.equal(topicMatches('md.index.*', 'md.index.NIFTY'), true)
  assert.equal(topicMatches('md.index.*', 'md.index.NIFTY.extra'), false, '* is one segment')
  assert.equal(topicMatches('md.#', 'md.index.NIFTY'), true)
  assert.equal(topicMatches('md.#', 'md.opt.NIFTY.2026-07-30'), true)
  assert.equal(topicMatches('md.#', 'md'), false, '# needs at least one segment')
  assert.equal(topicMatches('md.index.NIFTY', 'md.index.BANKNIFTY'), false)
  assert.equal(topicMatches('sys.error.#', 'sys.error.marketdata.stale'), true)
  assert.equal(topicMatches('md.index.NIFTY', 'md.index'), false, 'pattern longer than topic')
})

test('publish reaches only matching subscribers', () => {
  const bus = new InProcessTransport()
  const got: string[] = []
  bus.subscribe('md.index.NIFTY', () => got.push('exact'))
  bus.subscribe('md.index.*', () => got.push('wild'))
  bus.subscribe('md.#', () => got.push('all'))
  bus.subscribe('md.opt.#', () => got.push('options'))

  bus.publish('md.index.NIFTY', { lastPrice: 1 }, 1000)
  assert.deepEqual(got.sort(), ['all', 'exact', 'wild'], 'the options subscriber must not fire')
})

test('payload and ts arrive intact', () => {
  const bus = new InProcessTransport()
  let seen: unknown = null
  let ts = 0
  bus.subscribe<{ v: number }>('t.a', (m) => {
    seen = m.payload
    ts = m.ts
  })
  bus.publish('t.a', { v: 42 }, 12345)
  assert.deepEqual(seen, { v: 42 })
  assert.equal(ts, 12345)
})

test('unsubscribe stops delivery', () => {
  const bus = new InProcessTransport()
  let n = 0
  const off = bus.subscribe('t.a', () => n++)
  bus.publish('t.a', {}, 1)
  off()
  bus.publish('t.a', {}, 2)
  assert.equal(n, 1)
  assert.equal(bus.subscriberCount, 0)
})

test('a throwing subscriber does not stop the others (isolation)', () => {
  const errors: string[] = []
  const bus = new InProcessTransport((_e, topic) => errors.push(topic))
  const delivered: string[] = []
  bus.subscribe('t.a', () => {
    throw new Error('boom')
  })
  bus.subscribe('t.a', () => delivered.push('second'))

  // Must not throw into the publisher — one bad strategy cannot kill the feed.
  assert.doesNotThrow(() => bus.publish('t.a', {}, 1))
  assert.deepEqual(delivered, ['second'], 'later subscribers still receive the message')
  assert.deepEqual(errors, ['t.a'], 'the failure is reported, not swallowed silently')
})

test('unsubscribing during dispatch does not skip other subscribers', () => {
  const bus = new InProcessTransport()
  const seen: string[] = []
  const offA = bus.subscribe('t.a', () => {
    seen.push('a')
    offA()
  })
  bus.subscribe('t.a', () => seen.push('b'))
  bus.publish('t.a', {}, 1)
  assert.deepEqual(seen, ['a', 'b'], 'mutation during dispatch must be safe')
})

test('publishing after close is a no-op', async () => {
  const bus = new InProcessTransport()
  let n = 0
  bus.subscribe('t.a', () => n++)
  await bus.close()
  bus.publish('t.a', {}, 1)
  assert.equal(n, 0)
})

test('one subscriber can receive many topics via #', () => {
  const bus = new InProcessTransport()
  const seen: string[] = []
  bus.subscribe('md.#', (m) => seen.push(m.topic))
  bus.publish('md.index.NIFTY', {}, 1)
  bus.publish('md.opt.NIFTY.2026-07-30', {}, 2)
  bus.publish('sys.error.x', {}, 3)
  assert.deepEqual(seen, ['md.index.NIFTY', 'md.opt.NIFTY.2026-07-30'])
})
