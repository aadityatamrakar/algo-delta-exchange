import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InProcessTransport } from '@algomaker/bus'
import { QuoteCache } from '../../api/src/marks.ts'
import type { TradersDb } from '../src/db.ts'
import { attachFeed, seedSnapshot, tradersQuotes } from '../src/market/quotes.ts'
import type { FeedHealth } from '../src/market/quotes.ts'
import { octCE } from './fixtures/master.ts'

test('ticks feed the quote cache; health is stamped on arrival', () => {
  const bus = new InProcessTransport()
  const marks = new QuoteCache({ now: () => 5_000 })
  const health: FeedHealth = { payload: null, receivedAt: null }
  const off = attachFeed(bus, marks, health, () => 5_000)
  bus.publish('md.tick', { token: octCE(3500), price: 45, ts: 4_000, bid: 44, ask: 46 }, 4_000)
  bus.publish('md.health', { tokens: 120 }, 4_000)
  const quotes = tradersQuotes(marks)
  const q = quotes.quote(octCE(3500))
  assert.equal(q?.price, 45)
  assert.equal(q?.bid, 44)
  assert.equal(q?.ask, 46)
  assert.equal(quotes.feedAlive(), true)
  assert.deepEqual(health, { payload: { tokens: 120 }, receivedAt: 5_000 })
  off()
  bus.publish('md.tick', { token: octCE(3500), price: 99, ts: 4_500 }, 4_500)
  assert.equal(quotes.quote(octCE(3500))?.price, 45)
})
test("the cache's stale flag is kept on the quote", () => {
  const clock = { now: 100_000 }
  const marks = new QuoteCache({ now: () => clock.now, staleAfterMs: 60_000, feedDeadAfterMs: 1_000_000 })
  marks.update(octCE(3500), 45, 90_000, {})
  assert.equal(tradersQuotes(marks).quote(octCE(3500))?.stale, false)
  clock.now = 151_000
  assert.equal(tradersQuotes(marks).quote(octCE(3500))?.stale, true)
})
test('the desk-marks snapshot seeds display prices', async () => {
  const marks = new QuoteCache({ now: () => 10_000_000 })
  const db = {
    desk: () => ({ find: () => ({ toArray: async () => [{ token: 77, price: 12.5, ts: 1_000 }, { token: 78, price: 3, ts: 2_000, bid: 2.9, ask: 3.1 }] }) }),
  } as unknown as TradersDb
  assert.equal(await seedSnapshot(db, marks), 2)
  const q = tradersQuotes(marks).quote(77)
  assert.equal(q?.price, 12.5)
  assert.ok((q?.ageMs ?? 0) > 9_000_000)
  assert.equal(tradersQuotes(marks).feedAlive(), false)
})
