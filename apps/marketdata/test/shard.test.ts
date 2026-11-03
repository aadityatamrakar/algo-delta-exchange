import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TokenSharder, DEFAULT_MAX_TOKENS_PER_SOCKET } from '../src/shard.ts'

const range = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => from + i)

test('Kite\'s cap is 900 per socket', () => {
  assert.equal(DEFAULT_MAX_TOKENS_PER_SOCKET, 900)
})

test('a set within one socket uses exactly one socket', () => {
  const s = new TokenSharder()
  const plan = s.reconcile(range(1, 900))
  assert.equal(plan.socketCount, 1)
  assert.equal(plan.added.size, 900)
  assert.deepEqual(plan.loads, [900])
})

test('crossing the cap opens a second socket, not a bigger one', () => {
  const s = new TokenSharder()
  const plan = s.reconcile(range(1, 901))
  assert.equal(plan.socketCount, 2)
  assert.deepEqual(plan.loads, [900, 1])
})

test('10 stock chains worth of tokens shard across the right number of sockets', () => {
  const s = new TokenSharder()
  const plan = s.reconcile(range(1, 4500))
  assert.equal(plan.socketCount, 5)
  assert.deepEqual(plan.loads, [900, 900, 900, 900, 900])
})

test('re-declaring an UNCHANGED set is a complete no-op', () => {
  // A Python client calls this on every tick. Any churn here is churn on a live
  // websocket.
  const s = new TokenSharder()
  s.reconcile(range(1, 2000))
  const again = s.reconcile(range(1, 2000))
  assert.equal(again.added.size, 0)
  assert.equal(again.removed.size, 0)
  assert.equal(again.socketCount, 3)
})

test('adding one token does NOT reshuffle the existing assignment', () => {
  // The defect this design exists to prevent: a chunking scheme would shift
  // every token after the insertion point across socket boundaries.
  const s = new TokenSharder()
  s.reconcile(range(1000, 2000))
  const before = new Map(range(1000, 2000).map((t) => [t, s.socketOf(t)]))

  const plan = s.reconcile([...range(1000, 2000), 1])
  assert.equal(plan.added.size, 1, 'only the new token should be subscribed')
  assert.equal(plan.removed.size, 0, 'nothing should be unsubscribed')
  for (const [token, socket] of before) {
    assert.equal(s.socketOf(token), socket, `token ${token} moved sockets`)
  }
})

test('a roll — drop one strike, add another — reuses the freed slot', () => {
  const s = new TokenSharder(900)
  s.reconcile(range(1, 900))
  assert.equal(s.socketCount, 1)

  // Swap one token. Applying additions before removals would need a 2nd socket.
  const plan = s.reconcile([...range(2, 899), 5000])
  assert.equal(plan.socketCount, 1, 'a roll must not grow the socket count')
  assert.equal(plan.added.size, 1)
  assert.equal(plan.removed.size, 1)
  assert.equal(s.socketOf(5000), 0)
})

test('repeated rolls do not grow the socket count without bound', () => {
  const s = new TokenSharder(900)
  let tokens = range(1, 900)
  for (let i = 0; i < 50; i++) {
    tokens = [...tokens.slice(1), 100_000 + i]
    s.reconcile(tokens)
  }
  assert.equal(s.socketCount, 1)
  assert.equal(s.size, 900)
})

test('removed tokens report which socket to unsubscribe them from', () => {
  const s = new TokenSharder(10)
  s.reconcile(range(1, 25))
  const target = s.socketOf(15)
  const plan = s.reconcile(range(1, 25).filter((t) => t !== 15))
  assert.equal(plan.removed.get(15), target)
  assert.equal(s.socketOf(15), undefined)
})

test('emptying the set releases every socket', () => {
  const s = new TokenSharder(10)
  s.reconcile(range(1, 30))
  assert.equal(s.socketCount, 3)
  const plan = s.reconcile([])
  assert.equal(plan.removed.size, 30)
  assert.equal(plan.socketCount, 0)
  assert.equal(s.size, 0)
})

test('a middle socket emptying does NOT renumber the sockets after it', () => {
  // Renumbering would leave every token on the later socket pointing at the
  // wrong connection. An idle socket is much cheaper than that.
  const s = new TokenSharder(2)
  s.reconcile([1, 2, 3, 4, 5, 6]) // sockets 0:[1,2] 1:[3,4] 2:[5,6]
  const socketOf5 = s.socketOf(5)
  const socketOf6 = s.socketOf(6)
  s.reconcile([1, 2, 5, 6]) // drop everything on socket 1
  assert.equal(s.socketOf(5), socketOf5, 'token 5 must not be renumbered')
  assert.equal(s.socketOf(6), socketOf6, 'token 6 must not be renumbered')
})

test('freed middle capacity is reused before a new socket opens', () => {
  const s = new TokenSharder(2)
  s.reconcile([1, 2, 3, 4, 5, 6])
  s.reconcile([1, 2, 5, 6]) // socket 1 is now empty
  const plan = s.reconcile([1, 2, 5, 6, 7])
  assert.equal(plan.added.get(7), 1, 'the empty middle socket should take it')
  assert.equal(plan.socketCount, 3)
})

test('tokensOn reports what to subscribe on each connection', () => {
  const s = new TokenSharder(3)
  s.reconcile([10, 20, 30, 40])
  assert.deepEqual(s.tokensOn(0).sort((a, b) => a - b), [10, 20, 30])
  assert.deepEqual(s.tokensOn(1), [40])
})

test('a non-positive cap is rejected rather than producing infinite sockets', () => {
  assert.throws(() => new TokenSharder(0), /must be positive/)
  assert.throws(() => new TokenSharder(-5), /must be positive/)
})
