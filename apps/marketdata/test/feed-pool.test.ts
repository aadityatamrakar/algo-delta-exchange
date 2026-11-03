import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FeedHealth } from '@algomaker/marketdata-core'
import { KiteFeedPool, type FeedLike } from '../src/feed-pool.ts'

/** Records what each socket was told to hold, without any network. */
class FakeFeed implements FeedLike {
  connected = false
  declared: number[] = []
  declareCalls = 0
  reconnectTokens: string[] = []
  /** Tokens taken WITHOUT a rebuild — the live-socket rotation path. */
  notedTokens: string[] = []
  /** What this socket's watchdog says. `null` = the feed exposes no health. */
  reported: FeedHealth | null = null
  connect(): void {
    this.connected = true
  }
  disconnect(): void {
    this.connected = false
  }
  reconnect(accessToken: string): void {
    this.reconnectTokens.push(accessToken)
    this.connected = true
  }
  noteAccessToken(accessToken: string): void {
    this.notedTokens.push(accessToken)
  }
  declare(_id: string, tokens: readonly number[]): void {
    this.declared = [...tokens]
    this.declareCalls++
  }
  downForMs(): number | null {
    return this.connected ? null : 1
  }
  health(): FeedHealth {
    return this.reported ?? { state: 'ok' }
  }
}

function pool(maxPerSocket = 900): { p: KiteFeedPool; feeds: FakeFeed[] } {
  const feeds: FakeFeed[] = []
  const p = new KiteFeedPool({
    accessToken: 'x',
    onTick: () => {},
    maxTokensPerSocket: maxPerSocket,
    createFeed: () => {
      const f = new FakeFeed()
      feeds.push(f)
      return f
    },
  })
  return { p, feeds }
}

const range = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i)

test('a small book uses exactly one socket', () => {
  const { p, feeds } = pool()
  p.declare('BHEL', range(1, 40))
  assert.equal(p.socketCount, 1)
  assert.equal(feeds.length, 1)
  assert.equal(feeds[0]?.connected, true)
  assert.equal(feeds[0]?.declared.length, 40)
})

test('exceeding 900 tokens opens a second socket', () => {
  const { p, feeds } = pool()
  p.declare('BIG', range(1, 1500))
  assert.equal(p.socketCount, 2)
  assert.equal(feeds[0]?.declared.length, 900)
  assert.equal(feeds[1]?.declared.length, 600)
})

test('TEN subscribers on the SAME chain produce one subscription set', () => {
  // The legacy failure this design exists to prevent: 147 sockets for 18 ideas.
  const { p, feeds } = pool()
  const chain = range(1, 200)
  for (let i = 0; i < 10; i++) p.declare(`client-${i}`, chain)
  assert.equal(p.socketCount, 1)
  assert.equal(p.tokenCount, 200, 'the union, not 10x the chain')
  assert.equal(feeds[0]?.declared.length, 200)
})

test('distinct subscribers union onto the shared sockets', () => {
  const { p } = pool()
  p.declare('BHEL', range(1, 100))
  p.declare('KALYANKJIL', range(1000, 100))
  assert.equal(p.tokenCount, 200)
  assert.equal(p.socketCount, 1)
})

test('re-declaring an unchanged set touches no socket', () => {
  const { p, feeds } = pool()
  p.declare('BHEL', range(1, 100))
  const callsAfterFirst = feeds[0]?.declareCalls
  for (let i = 0; i < 20; i++) p.declare('BHEL', range(1, 100))
  assert.equal(
    feeds[0]?.declareCalls,
    callsAfterFirst,
    'a Python client re-declares every tick; this must not touch the wire',
  )
})

test('a roll swaps one token without opening a socket', () => {
  const { p, feeds } = pool(900)
  p.declare('BHEL', range(1, 900))
  assert.equal(p.socketCount, 1)
  p.declare('BHEL', [...range(2, 899), 99_999])
  assert.equal(p.socketCount, 1)
  assert.equal(feeds.length, 1, 'no new socket should have been created')
  assert.ok(feeds[0]?.declared.includes(99_999))
})

test('removing a subscriber releases only ITS tokens', () => {
  const { p } = pool()
  p.declare('BHEL', range(1, 100))
  p.declare('OTHER', range(1000, 50))
  p.remove('OTHER')
  assert.equal(p.tokenCount, 100)
})

test('a token wanted by two subscribers survives one of them leaving', () => {
  const { p } = pool()
  const shared = range(1, 50)
  p.declare('a', shared)
  p.declare('b', shared)
  p.remove('a')
  assert.equal(p.tokenCount, 50, 'b still wants them')
  p.remove('b')
  assert.equal(p.tokenCount, 0)
})

test('status reports per-socket connection state and load', () => {
  const { p } = pool(900)
  p.declare('BIG', range(1, 1000))
  const st = p.status()
  assert.equal(st.length, 2)
  assert.equal(st[0]?.tokens, 900)
  assert.equal(st[1]?.tokens, 100)
  assert.equal(st[0]?.connected, true)
})

test('reconnect rebuilds ONLY the dead sockets with the fresh token', () => {
  const { p, feeds } = pool(900)
  p.declare('BIG', range(1, 1500))
  assert.equal(feeds.length, 2)
  const alive = feeds[0]
  const dead = feeds[1]
  assert.ok(alive !== undefined && dead !== undefined)
  // Socket 1 lost its connection (say, the enctoken died mid-session).
  dead.connected = false

  p.reconnect('fresh-token')

  assert.deepEqual(dead.reconnectTokens, ['fresh-token'])
  // The healthy socket keeps its established session: rebuilding it would
  // drop live ticks for nothing.
  assert.deepEqual(alive.reconnectTokens, [])
})

test('a 10-stock desk sizes the pool from the token total', () => {
  const { p } = pool(900)
  // ~450 contracts per stock chain across 10 names.
  for (let i = 0; i < 10; i++) p.declare(`stock-${i}`, range(i * 1000, 450))
  assert.equal(p.tokenCount, 4500)
  assert.equal(p.socketCount, 5)
})

// ------------------------------------------------------------------ health

test('pool health aggregates the per-socket stale counts (F-14)', () => {
  const { p, feeds } = pool(900)
  p.declare('BIG', range(1, 1500))
  const a = feeds[0]
  const b = feeds[1]
  assert.ok(a !== undefined && b !== undefined)
  a.reported = { state: 'ok' }
  b.reported = { state: 'stale', staleTokens: [1001, 1002, 1003], oldestAgeMs: 42_000 }

  const h = p.health()
  assert.equal(h.staleTokens, 3, 'the sum across sockets')
  assert.equal(h.oldestAgeMs, 42_000, 'the WORST age on any socket')
  assert.equal(h.perSocket.length, 2)
  assert.deepEqual(
    h.perSocket.map((s) => ({ socket: s.socket, stale: s.staleTokens, tokens: s.tokens })),
    [
      { socket: 0, stale: 0, tokens: 900 },
      { socket: 1, stale: 3, tokens: 600 },
    ],
  )
})

test('a socket where NOTHING has ever ticked counts every token as stale', () => {
  // 'no-data' is the partially-failed resubscribe: tokens live in the registry
  // and reach no wire, so the watchdog has no timestamp for any of them.
  const { p, feeds } = pool(900)
  p.declare('BHEL', range(1, 100))
  const only = feeds[0]
  assert.ok(only !== undefined)
  only.reported = { state: 'no-data' }
  const h = p.health()
  assert.equal(h.staleTokens, 100)
  assert.equal(h.perSocket[0]?.state, 'no-data')
})

test('a feed that exposes no health is reported as ok rather than crashing the sweep', () => {
  const { p, feeds } = pool()
  p.declare('BHEL', range(1, 10))
  const only = feeds[0]
  assert.ok(only !== undefined)
  // Older FeedLike implementers (and every test fake written before F-14) have
  // no `health()`; the health call must stay optional.
  ;(only as { health?: unknown }).health = undefined
  const h = p.health()
  assert.equal(h.staleTokens, 0)
  assert.equal(h.perSocket[0]?.state, 'ok')
})

test('repairSocket rebuilds ONE frozen socket with the current token', () => {
  const { p, feeds } = pool(900)
  p.declare('BIG', range(1, 1500))
  const frozen = feeds[1]
  const healthy = feeds[0]
  assert.ok(frozen !== undefined && healthy !== undefined)
  p.repairSocket(1)
  assert.deepEqual(frozen.reconnectTokens, ['x'], 'the pool\'s CURRENT enctoken, never a captured one')
  assert.deepEqual(healthy.reconnectTokens, [], 'a repair is targeted, not a pool-wide bounce')
})
