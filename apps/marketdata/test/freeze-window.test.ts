/**
 * The FREEZE window, end to end: pool -> KiteFeed -> StalenessWatchdog.
 *
 * A stock chain's wings genuinely go 30-60 seconds between prints (measured on
 * BHEL, and stated in apps/api/src/marks.ts). KiteFeed's own default window is
 * 15s, which is the right number for "may I trade on this quote" and the wrong
 * one for "has this socket FROZEN" — on the 15s window more than half a quiet
 * chain's tokens are stale in normal conditions, so the F-14 alarm would fire
 * all session on a perfectly healthy wire and `md.health` would publish a
 * frightening stale count that means nothing.
 *
 * These tests pin the two ends: a 60s-quiet chain is silent, a 200s-quiet
 * socket alarms.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KiteFeedPool } from '../src/feed-pool.ts'
import { KiteFeed, type KiteTick, type RawTicker } from '../src/kite-feed.ts'
import { frozenSockets } from '../src/main.ts'

/** A scriptable ticker: emits on demand, no network. */
class FakeTicker implements RawTicker {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  modeLTP = 'ltp'
  modeQuote = 'quote'
  modeFull = 'full'
  connect(): void {}
  disconnect(): void {}
  autoReconnect(): void {}
  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event)
    if (list === undefined) this.handlers.set(event, [handler])
    else list.push(handler)
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args)
  }
  subscribe(): void {}
  unsubscribe(): void {}
  setMode(): void {}
}

/** 2026-08-14 10:00 IST — a real in-session wall clock for the mocked Date. */
const START = Date.UTC(2026, 7, 14, 4, 30)

const tick = (token: number): KiteTick => ({ instrument_token: token, last_price: 100 })

/**
 * A pool whose sockets are REAL `KiteFeed`s on fake tickers, so the window the
 * pool hands down is the window the watchdog actually applies. A pool that
 * threads nothing leaves each feed on its 15s default, which is exactly the
 * defect these tests exist to catch.
 */
function poolOnFakeWire(staleAfterMs?: number): { p: KiteFeedPool; tickers: FakeTicker[] } {
  const tickers: FakeTicker[] = []
  const p = new KiteFeedPool({
    accessToken: 'x',
    onTick: () => {},
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    createFeed: (_index, options) =>
      new KiteFeed({
        accessToken: 'x',
        onTick: () => {},
        ...options,
        createTicker: () => {
          const t = new FakeTicker()
          tickers.push(t)
          return t
        },
      }),
  })
  return { p, tickers }
}

function wire(p: KiteFeedPool, tickers: FakeTicker[], tokens: readonly number[]): FakeTicker {
  p.declare('BHEL', tokens)
  const ticker = tickers[0]
  assert.ok(ticker !== undefined, 'the pool opened a socket')
  ticker.emit('connect')
  ticker.emit('ticks', tokens.map(tick))
  return ticker
}

test('a chain whose wings print once a minute is NOT stale on the freeze window', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const { p, tickers } = poolOnFakeWire(180_000)
  wire(p, tickers, [1, 2, 3, 4])

  t.mock.timers.tick(60_000)

  const h = p.health()
  assert.equal(h.staleTokens, 0, 'md.health must not publish a 60s gap as a stale token')
  assert.equal(h.oldestAgeMs, 0)

  // And the alarm stays quiet however long the sweep runs.
  const streaks = new Map<number, number>()
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(frozenSockets(p.health().perSocket, true, streaks), [], 'sweep ' + String(i))
  }
})

test('a socket silent past the freeze window alarms on the SECOND sweep', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const { p, tickers } = poolOnFakeWire(180_000)
  wire(p, tickers, [1, 2, 3, 4])

  t.mock.timers.tick(200_000)

  const h = p.health()
  assert.equal(h.staleTokens, 4, 'every token on the socket is past the freeze window')
  assert.ok(h.oldestAgeMs >= 200_000)

  const streaks = new Map<number, number>()
  assert.deepEqual(frozenSockets(p.health().perSocket, true, streaks), [], 'one sweep is a hiccup')
  assert.equal(frozenSockets(p.health().perSocket, true, streaks).length, 1)
})

test('a fresh print inside the window clears the socket again', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const { p, tickers } = poolOnFakeWire(180_000)
  const ticker = wire(p, tickers, [1, 2, 3, 4])

  t.mock.timers.tick(200_000)
  assert.equal(p.health().staleTokens, 4)
  ticker.emit('ticks', [tick(1), tick(2), tick(3), tick(4)])
  assert.equal(p.health().staleTokens, 0, 'the watchdog re-times from the new print')
})
