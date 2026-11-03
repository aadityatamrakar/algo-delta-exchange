import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as kiteFeed from '../src/kite-feed.ts'
import { KiteFeed, type RawTicker } from '../src/kite-feed.ts'

/** A scriptable ticker: records every call, emits on demand, no network. */
class FakeTicker implements RawTicker {
  readonly accessToken: string
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  connectCalls = 0
  disconnectCalls = 0
  autoReconnectCalls: boolean[] = []
  subscribed: number[] = []
  modeLTP = 'ltp'
  modeQuote = 'quote'
  modeFull = 'full'

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }
  connect(): void {
    this.connectCalls++
  }
  disconnect(): void {
    this.disconnectCalls++
  }
  autoReconnect(enable: boolean): void {
    this.autoReconnectCalls.push(enable)
  }
  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event)
    if (list === undefined) this.handlers.set(event, [handler])
    else list.push(handler)
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args)
  }
  subscribe(tokens: number[]): void {
    this.subscribed.push(...tokens)
  }
  unsubscribe(): void {}
  setMode(): void {}
}

function feedWithFakes(opts: { onDown?: () => void } = {}): { feed: KiteFeed; tickers: FakeTicker[] } {
  const tickers: FakeTicker[] = []
  const feed = new KiteFeed({
    accessToken: 'token-1',
    onTick: () => {},
    ...(opts.onDown === undefined ? {} : { onDown: opts.onDown }),
    createTicker: (p) => {
      const t = new FakeTicker(p.access_token)
      tickers.push(t)
      return t
    },
  })
  return { feed, tickers }
}

test('feed error formatting keeps object fields visible', () => {
  const describeFeedError = (kiteFeed as Record<string, unknown>)['describeFeedError']
  assert.equal(typeof describeFeedError, 'function')
  const rendered = (describeFeedError as (err: unknown) => string)({
    code: 1006,
    reason: 'websocket closed',
  })
  assert.match(rendered, /1006/)
  assert.match(rendered, /websocket closed/)
  assert.doesNotMatch(rendered, /^\[object Object\]$/)
})

test('feed error formatting preserves Error messages', () => {
  const describeFeedError = (kiteFeed as Record<string, unknown>)['describeFeedError']
  assert.equal(typeof describeFeedError, 'function')
  const rendered = (describeFeedError as (err: unknown) => string)(new Error('feed blew up'))
  assert.match(rendered, /feed blew up/)
})

test('feed error formatting keeps websocket close details visible', () => {
  const describeFeedError = (kiteFeed as Record<string, unknown>)['describeFeedError']
  assert.equal(typeof describeFeedError, 'function')
  const rendered = (describeFeedError as (err: unknown) => string)({
    code: 1006,
    reason: Buffer.from('timeout'),
    wasClean: false,
  })
  assert.match(rendered, /1006/)
  assert.match(rendered, /timeout/)
  assert.match(rendered, /wasClean/)
})

// ---------------------------------------------------------------- recovery
// The 2026-08-04 incident: the enctoken died mid-session, every vendored retry
// re-dialled with it, and the feed stayed dead until a human restarted the
// process. These tests pin the in-process replacement for that restart.

test('noreconnect invokes onDown so the host can re-login', () => {
  let downs = 0
  const { feed, tickers } = feedWithFakes({ onDown: () => downs++ })
  feed.connect()
  tickers[0]?.emit('connect')
  tickers[0]?.emit('disconnect')
  tickers[0]?.emit('noreconnect')
  assert.equal(downs, 1)
})

test('reconnect retires the dead ticker and rebuilds with the fresh token', () => {
  const { feed, tickers } = feedWithFakes()
  feed.connect()
  const first = tickers[0]
  assert.ok(first)
  first.emit('connect')
  feed.declare('desk', [101, 102])
  first.emit('disconnect')

  feed.reconnect('token-2')

  // The old ticker's retry loop is OFF and its socket closed — otherwise it
  // keeps re-dialling with the dead token behind the replacement's back.
  assert.deepEqual(first.autoReconnectCalls, [false])
  assert.equal(first.disconnectCalls, 1)

  const second = tickers[1]
  assert.ok(second, 'a fresh ticker must have been constructed')
  assert.equal(second.accessToken, 'token-2')
  assert.equal(second.connectCalls, 1)

  // Resubscription comes from the registry, exactly as a boot does.
  second.emit('connect')
  assert.deepEqual([...second.subscribed].sort(), [101, 102])
  assert.equal(feed.connected, true)
})

test('ghost events from a retired ticker cannot corrupt the live feed', () => {
  let downs = 0
  const { feed, tickers } = feedWithFakes({ onDown: () => downs++ })
  feed.connect()
  const first = tickers[0]
  assert.ok(first)
  first.emit('connect')
  first.emit('disconnect')

  feed.reconnect('token-2')
  const second = tickers[1]
  assert.ok(second)
  second.emit('connect')
  assert.equal(feed.connected, true)

  // One last in-flight attempt from the retired ticker fires late. It must
  // neither flip the connected flag nor trigger another recovery.
  first.emit('disconnect')
  first.emit('noreconnect')
  assert.equal(feed.connected, true)
  assert.equal(downs, 0)
})

test('downForMs runs from the FIRST disconnect and clears on connect', () => {
  const { feed, tickers } = feedWithFakes()
  feed.connect()
  const t = tickers[0]
  assert.ok(t)
  // Attempting but not yet connected: the outage clock is already running.
  assert.notEqual(feed.downForMs(), null)
  t.emit('connect')
  assert.equal(feed.downForMs(), null)

  t.emit('disconnect')
  const start = feed.downForMs()
  assert.ok(start !== null && start >= 0)
  // The vendored retry cycle emits 'disconnect' per failed attempt; the clock
  // must not reset on each one, or a dead feed always looks freshly dead.
  const later = Date.now() + 30_000
  t.emit('disconnect')
  const age = feed.downForMs(later)
  assert.ok(age !== null && age >= 30_000)
})