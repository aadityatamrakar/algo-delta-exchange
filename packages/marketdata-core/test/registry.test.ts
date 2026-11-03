import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SubscriptionRegistry,
  StalenessWatchdog,
  isPlausibleTick,
  maxMode,
  topics,
  type TokenNeed,
} from '../src/index.ts'

const need = (token: number, mode: TokenNeed['mode'] = 'ltp', topic = 'md.index.X'): TokenNeed => ({
  token,
  mode,
  topic,
})

// --- dedup: the whole point --------------------------------------------------

test('two subscribers wanting the same token produce ONE subscribe', () => {
  const r = new SubscriptionRegistry()
  const d1 = r.declare({ subscriberId: 's1', needs: [need(100)] })
  assert.deepEqual(d1.toSubscribe, [{ token: 100, mode: 'ltp' }])

  const d2 = r.declare({ subscriberId: 's2', needs: [need(100)] })
  assert.deepEqual(d2.toSubscribe, [], 'second subscriber must not resubscribe the wire')
  assert.equal(r.tokenCount, 1)
})

test('a token is only unsubscribed when the LAST holder leaves', () => {
  const r = new SubscriptionRegistry()
  r.declare({ subscriberId: 's1', needs: [need(100)] })
  r.declare({ subscriberId: 's2', needs: [need(100)] })

  assert.deepEqual(r.remove('s1').toUnsubscribe, [], 'still one holder left')
  assert.deepEqual(r.remove('s2').toUnsubscribe, [100], 'now it can go')
  assert.equal(r.tokenCount, 0)
})

test('re-declaring identical needs is a no-op (safe on strategy restart)', () => {
  const r = new SubscriptionRegistry()
  r.declare({ subscriberId: 's1', needs: [need(1), need(2)] })
  const again = r.declare({ subscriberId: 's1', needs: [need(1), need(2)] })
  assert.deepEqual(again, { toSubscribe: [], toUnsubscribe: [], toChangeMode: [] })
})

test('re-declaring a narrower set unsubscribes what was dropped', () => {
  const r = new SubscriptionRegistry()
  r.declare({ subscriberId: 's1', needs: [need(1), need(2), need(3)] })
  const d = r.declare({ subscriberId: 's1', needs: [need(1)] })
  assert.deepEqual([...d.toUnsubscribe].sort((a, b) => a - b), [2, 3])
  assert.equal(r.tokenCount, 1)
})

// --- mode escalation ---------------------------------------------------------

test('effective mode is the max across requesters', () => {
  assert.equal(maxMode('ltp', 'full'), 'full')
  assert.equal(maxMode('quote', 'ltp'), 'quote')

  const r = new SubscriptionRegistry()
  r.declare({ subscriberId: 's1', needs: [need(100, 'ltp')] })
  const d = r.declare({ subscriberId: 's2', needs: [need(100, 'full')] })
  assert.deepEqual(d.toChangeMode, [{ token: 100, mode: 'full' }])
  assert.equal(r.effectiveMode(100), 'full')
})

test('mode downgrades when the demanding subscriber leaves', () => {
  const r = new SubscriptionRegistry()
  r.declare({ subscriberId: 's1', needs: [need(100, 'ltp')] })
  r.declare({ subscriberId: 's2', needs: [need(100, 'full')] })
  const d = r.remove('s2')
  assert.deepEqual(d.toChangeMode, [{ token: 100, mode: 'ltp' }])
  assert.deepEqual(d.toUnsubscribe, [], 'token is still needed, just at a cheaper mode')
})

test('one subscriber declaring a token twice gets the richer mode', () => {
  const r = new SubscriptionRegistry()
  const d = r.declare({ subscriberId: 's1', needs: [need(7, 'ltp'), need(7, 'full')] })
  assert.deepEqual(d.toSubscribe, [{ token: 7, mode: 'full' }])
})

// --- topics ------------------------------------------------------------------

test('all requested topics for a token are retained', () => {
  const r = new SubscriptionRegistry()
  r.declare({ subscriberId: 's1', needs: [need(100, 'ltp', 'md.index.NIFTY')] })
  r.declare({ subscriberId: 's2', needs: [need(100, 'ltp', 'md.opt.NIFTY.2026-07-30')] })
  assert.deepEqual(
    [...r.topicsFor(100)].sort(),
    ['md.index.NIFTY', 'md.opt.NIFTY.2026-07-30'],
  )
})

test('topic builders are stable', () => {
  assert.equal(topics.index('NIFTY'), 'md.index.NIFTY')
  assert.equal(topics.stock('RELIANCE'), 'md.stock.RELIANCE')
  assert.equal(topics.option('NIFTY', '2026-07-30'), 'md.opt.NIFTY.2026-07-30')
  assert.equal(topics.future('BANKNIFTY', '2026-07-31'), 'md.fut.BANKNIFTY.2026-07-31')
})

// --- capacity ----------------------------------------------------------------

test('exceeding the connection cap throws BEFORE mutating state', () => {
  const r = new SubscriptionRegistry({ maxTokensPerConnection: 3 })
  r.declare({ subscriberId: 's1', needs: [need(1), need(2)] })
  assert.equal(r.tokenCount, 2)
  assert.equal(r.headroom, 1)

  assert.throws(
    () => r.declare({ subscriberId: 's2', needs: [need(3), need(4), need(5)] }),
    /subscription cap exceeded/,
  )
  // The critical property: a rejected declaration must not half-apply, or the
  // registry and the wire disagree forever.
  assert.equal(r.tokenCount, 2, 'state must be unchanged after a refused declaration')
  assert.equal(r.effectiveMode(3), undefined)
})

test('headroom reflects distinct tokens, not subscribers', () => {
  const r = new SubscriptionRegistry({ maxTokensPerConnection: 10 })
  for (let i = 0; i < 5; i++) r.declare({ subscriberId: `s${i}`, needs: [need(1)] })
  assert.equal(r.tokenCount, 1)
  assert.equal(r.headroom, 9)
})

// --- reconnect ---------------------------------------------------------------

test('fullSubscriptionSet rebuilds wire state after a disconnect', () => {
  const r = new SubscriptionRegistry()
  r.declare({ subscriberId: 's1', needs: [need(1, 'ltp'), need(2, 'full')] })
  r.declare({ subscriberId: 's2', needs: [need(3, 'quote')] })
  const full = [...r.fullSubscriptionSet()].sort((a, b) => a.token - b.token)
  assert.deepEqual(full, [
    { token: 1, mode: 'ltp' },
    { token: 2, mode: 'full' },
    { token: 3, mode: 'quote' },
  ])
})

// --- realistic scale ---------------------------------------------------------

test('3 indices + 10 stocks with ATM windows stays in the low hundreds', () => {
  // The legacy system subscribed whole chains per process: ~50,000
  // token-subscriptions across ~150 sockets. An ATM window per underlying on ONE
  // socket should be a few hundred.
  const r = new SubscriptionRegistry({ maxTokensPerConnection: 3000 })
  let token = 1000
  const underlyings = ['NIFTY', 'BANKNIFTY', 'SENSEX', ...Array.from({ length: 10 }, (_, i) => `STOCK${i}`)]
  for (const u of underlyings) {
    const needs: TokenNeed[] = [need(token++, 'ltp', topics.index(u))]
    // +/-10 strikes, CE+PE = 42 option tokens
    for (let i = 0; i < 42; i++) needs.push(need(token++, 'full', topics.option(u, '2026-07-30')))
    r.declare({ subscriberId: `strategy-${u}`, needs })
  }
  assert.equal(r.tokenCount, 13 * 43)
  assert.ok(r.tokenCount < 600, `expected < 600 tokens, got ${r.tokenCount}`)
  assert.ok(r.headroom > 2400)
})

// --- staleness watchdog ------------------------------------------------------

test('watchdog reports ok while ticks are fresh', () => {
  const w = new StalenessWatchdog(10_000)
  w.record(1, 1000)
  w.record(2, 1500)
  assert.deepEqual(w.check([1, 2], 5000), { state: 'ok' })
})

test('watchdog detects an open socket that stopped delivering ticks', () => {
  const w = new StalenessWatchdog(10_000)
  w.record(1, 1000)
  w.record(2, 1000)
  const h = w.check([1, 2], 30_000)
  assert.equal(h.state, 'stale')
  assert.equal(h.state === 'stale' && h.oldestAgeMs, 29_000)
  assert.deepEqual(h.state === 'stale' ? [...h.staleTokens].sort() : [], [1, 2])
})

test('a token that never ticked is stale, and all-never-ticked is no-data', () => {
  const w = new StalenessWatchdog(10_000)
  assert.deepEqual(w.check([1, 2], 5000), { state: 'no-data' })
  w.record(1, 4900)
  const h = w.check([1, 2], 5000)
  assert.equal(h.state, 'stale', 'token 2 has never ticked')
  assert.deepEqual(h.state === 'stale' ? h.staleTokens : [], [2])
})

test('an out-of-order tick cannot make a token look staler', () => {
  const w = new StalenessWatchdog(10_000)
  w.record(1, 5000)
  w.record(1, 1000) // late-arriving older packet
  assert.deepEqual(w.check([1], 9000), { state: 'ok' })
})

test('watchdog on an empty token list is ok, not no-data', () => {
  assert.deepEqual(new StalenessWatchdog().check([], 1000), { state: 'ok' })
})

// --- tick sanity -------------------------------------------------------------

test('implausible ticks are rejected at ingest', () => {
  const base = { token: 1, lastPrice: 100, ts: 1000 }
  assert.equal(isPlausibleTick(base), true)
  assert.equal(isPlausibleTick({ ...base, lastPrice: 0 }), false, 'zero price')
  assert.equal(isPlausibleTick({ ...base, lastPrice: -5 }), false, 'negative price')
  assert.equal(isPlausibleTick({ ...base, lastPrice: Number.NaN }), false, 'NaN price')
  assert.equal(isPlausibleTick({ ...base, token: 0 }), false, 'zero token')
  assert.equal(isPlausibleTick({ ...base, ts: 0 }), false, 'zero timestamp')
  assert.equal(isPlausibleTick({ ...base, bid: 101, ask: 100 }), false, 'crossed book')
  assert.equal(isPlausibleTick({ ...base, bid: 99, ask: 101 }), true, 'normal book')
  assert.equal(isPlausibleTick({ ...base, bid: 0, ask: 0 }), true, 'empty book is not implausible')
})
