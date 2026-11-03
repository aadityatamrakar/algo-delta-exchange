/**
 * THE ROUTE FROM "a strategy needs BANKNIFTY" TO "the socket is subscribed to
 * it", end to end across the two processes.
 *
 * It did not exist. `RunnerMarketData.subscriptionSet()` was called by nothing
 * in the repo except its own test, and `apps/marketdata` built its plan purely
 * from the Python desk's open books — so a hosted strategy's instruments were
 * never subscribed. Nothing looked broken: BHEL ticked, the feed reported
 * healthy, and meanwhile `isTrustworthy()` was false all session, `canEnter()`
 * refused every entry, and no option token could ever be declared because a
 * chain window cannot be centred without a spot price.
 *
 * So the test below runs the REAL pieces of both halves — the runner's
 * `RunnerMarketData`, the store, and `KiteFeedPool` — and asserts a token
 * declared by a strategy ends up on a socket.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { makeLogger } from '@algomaker/strategy-kit'
import { RunnerMarketData } from '../../runner/src/market-data.ts'
import { KiteFeedPool, type FeedLike } from '../src/feed-pool.ts'
import {
  publishSubscription,
  readSubscriptions,
  splitByFreshness,
  RUNNER_SUBSCRIPTION_SOURCE,
  SUBSCRIPTION_MAX_AGE_MS,
  type SubscriptionCollection,
} from '../src/subscription-store.ts'

const NOW = Date.UTC(2026, 6, 24, 4, 0) // Fri 09:30 IST
const BANKNIFTY_SPOT = 260_105
const NIFTY_SPOT = 256_265

/** A one-document-per-source fake, with the same upsert semantics as Mongo. */
function fakeCollection(): SubscriptionCollection & { docs: Record<string, unknown>[] } {
  const docs: Record<string, unknown>[] = []
  return {
    docs,
    find: () => ({ toArray: async () => docs.map((d) => ({ ...d })) }),
    updateOne: async (filter, update) => {
      const set = (update['$set'] ?? {}) as Record<string, unknown>
      const existing = docs.find((d) => d['source'] === filter['source'])
      if (existing === undefined) docs.push({ ...set })
      else Object.assign(existing, set)
      return {}
    },
    createIndex: async () => ({}),
  }
}

function master(): OptionMaster {
  const rows: InstrumentRow[] = [
    {
      instrument_token: BANKNIFTY_SPOT,
      tradingsymbol: 'NIFTY BANK',
      name: 'NIFTY BANK',
      expiry: '',
      strike: 0,
      tick_size: 0.05,
      lot_size: 0,
      instrument_type: 'EQ',
      segment: 'INDICES',
      exchange: 'NSE',
    },
    {
      instrument_token: NIFTY_SPOT,
      tradingsymbol: 'NIFTY 50',
      name: 'NIFTY 50',
      expiry: '',
      strike: 0,
      tick_size: 0.05,
      lot_size: 0,
      instrument_type: 'EQ',
      segment: 'INDICES',
      exchange: 'NSE',
    },
  ]
  return new OptionMaster(rows)
}

/** A `KiteFeedPool` whose sockets record what they were told to subscribe to. */
function pool(): { pool: KiteFeedPool; tokensOnSockets: () => number[] } {
  const feeds: { tokens: number[] }[] = []
  const p = new KiteFeedPool({
    accessToken: 'x',
    onTick: () => {},
    createFeed: (): FeedLike => {
      const f = { tokens: [] as number[] }
      feeds.push(f)
      return {
        connect: () => {},
        disconnect: () => {},
        reconnect: () => {},
        noteAccessToken: () => {},
        declare: (_id, tokens) => {
          f.tokens = [...tokens]
        },
        connected: true,
        downForMs: () => null,
      }
    },
  })
  return { pool: p, tokensOnSockets: () => feeds.flatMap((f) => f.tokens).sort((a, b) => a - b) }
}

test("a strategy's declared tokens reach a socket, across both processes", async () => {
  const col = fakeCollection()

  // --- the RUNNER half: two strategies declare two indices -------------------
  const md = new RunnerMarketData({
    master: () => master(),
    clock: fixedClock(NOW),
    log: makeLogger(),
  })
  md.declare('ATR_BAND_NIFTY', [{ kind: 'index', underlying: 'NIFTY' }])
  md.declare('BN_BREAKOUT', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  await publishSubscription(
    col,
    RUNNER_SUBSCRIPTION_SOURCE,
    md.subscriptionSet().map((s) => s.token),
    NOW,
  )

  // --- the MARKETDATA half: read the declaration, hand it to the pool -------
  const feed = pool()
  const declared = await readSubscriptions(col, { nowMs: NOW })
  assert.equal(declared.stale.length, 0)
  for (const s of declared.live) feed.pool.declare(`sub:${s.source}`, s.tokens)

  assert.deepEqual(feed.tokensOnSockets(), [NIFTY_SPOT, BANKNIFTY_SPOT].sort((a, b) => a - b))
  assert.equal(feed.pool.tokenCount, 2)
})

test('the desk and the runner UNION rather than overwrite each other', async () => {
  // Both declare under their own subscriber id, so a token both want is one
  // subscription and neither can erase the other's set. Declaring them under a
  // single name is the mistake this asserts against.
  const feed = pool()
  feed.pool.declare('desk-books', [111, BANKNIFTY_SPOT])
  feed.pool.declare(`sub:${RUNNER_SUBSCRIPTION_SOURCE}`, [BANKNIFTY_SPOT, NIFTY_SPOT])
  assert.deepEqual(feed.tokensOnSockets(), [111, NIFTY_SPOT, BANKNIFTY_SPOT].sort((a, b) => a - b))

  // ...and releasing the runner's leaves the desk's alone.
  feed.pool.remove(`sub:${RUNNER_SUBSCRIPTION_SOURCE}`)
  assert.deepEqual(feed.tokensOnSockets(), [111, BANKNIFTY_SPOT].sort((a, b) => a - b))
})

test('a declaration is the WHOLE set, so a shrinking one releases tokens', async () => {
  const col = fakeCollection()
  await publishSubscription(col, 'x', [1, 2, 3], NOW)
  await publishSubscription(col, 'x', [1], NOW)
  const declared = await readSubscriptions(col, { nowMs: NOW })
  assert.deepEqual(declared.live[0]?.tokens, [1])
  assert.equal(col.docs.length, 1, 'one document per source — never an append log')
})

test('tokens are stored sorted and de-duplicated', async () => {
  const col = fakeCollection()
  await publishSubscription(col, 'x', [9, 3, 9, 1], NOW)
  const declared = await readSubscriptions(col, { nowMs: NOW })
  assert.deepEqual(declared.live[0]?.tokens, [1, 3, 9])
})

// ------------------------------------------------------------- staleness

test('a publisher that stopped refreshing goes STALE and is released', () => {
  const fresh = { source: 'a', tokens: [1], updatedAt: NOW - 60_000 }
  const dead = { source: 'b', tokens: [2], updatedAt: NOW - SUBSCRIPTION_MAX_AGE_MS - 1 }
  const split = splitByFreshness([fresh, dead], { nowMs: NOW })
  assert.deepEqual(split.live.map((s) => s.source), ['a'])
  assert.deepEqual(split.stale.map((s) => s.source), ['b'])
})

test('an EMPTY declaration is honoured, but a MALFORMED one is not', () => {
  // "I want nothing" is a real statement — a runner with every strategy
  // switched off makes it. A document with no token array is not that
  // statement, and treating it as one would silently unsubscribe a live
  // publisher's whole set.
  const split = splitByFreshness(
    [
      { source: 'empty', tokens: [], updatedAt: NOW },
      { source: 'broken', updatedAt: NOW },
      { source: 'garbage', tokens: 'nope', updatedAt: NOW },
      { tokens: [1], updatedAt: NOW },
    ],
    { nowMs: NOW },
  )
  assert.deepEqual(split.live.map((s) => s.source), ['empty'])
  assert.deepEqual(split.stale.map((s) => s.source), ['broken', 'garbage'])
})

test('the stale window is far wider than the refresh interval', () => {
  // The runner rewrites every 15s. A GC pass that fired on one slow Mongo round
  // trip would unsubscribe a running strategy mid-session, which is far more
  // expensive than carrying a dead publisher's tokens for a few minutes.
  assert.ok(SUBSCRIPTION_MAX_AGE_MS >= 40 * 15_000)
})
