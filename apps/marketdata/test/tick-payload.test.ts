/**
 * The `md.tick` payload, in isolation.
 *
 * The feed already subscribes in 'full' mode (`kite-feed.ts:138`), so `oi` and
 * `volume` arrive on every packet — `tickPayload` is the extracted, pure
 * mapping from a raw `KiteTick` to what goes on the bus, so the fact that they
 * ride along is testable without booting the feed host (no Mongo, no Kite
 * login, no bus).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tickPayload, acceptTick } from '../src/main.ts'
import type { KiteTick } from '../src/kite-feed.ts'

test('md.tick carries oi and volume when the packet has them', () => {
  const payload = tickPayload(
    { instrument_token: 700420, last_price: 15.4, oi: 123_400, volume: 8_800 } as KiteTick,
    1_700_000_000_000,
  )
  assert.equal(payload['token'], 700420)
  assert.equal(payload['price'], 15.4)
  assert.equal(payload['ts'], 1_700_000_000_000)
  assert.equal(payload['oi'], 123_400)
  assert.equal(payload['volume'], 8_800)
})

test('md.tick omits oi and volume entirely when the packet lacks them', () => {
  // A quote-mode or LTP-mode packet, or a full-mode one still filling in — the
  // key must be ABSENT, not present-as-undefined, so a naive spread on the
  // consumer side never manufactures a false zero.
  const payload = tickPayload({ instrument_token: 700420, last_price: 15.4 } as KiteTick, 1_000)
  assert.equal('oi' in payload, false)
  assert.equal('volume' in payload, false)
})

test('md.tick carries best bid/ask off the depth — the MID is the desk mark now', () => {
  // A deep-ITM strike prints rarely but its book is live all session (TCS
  // 2440PE, 2026-08-17: LTP from 14:20 while the 115.50/117.15 book moved
  // every second). The mid is the accurate mark; dropping the depth here was
  // why every consumer downstream had nothing but a stale LTP to price with.
  const payload = tickPayload(
    {
      instrument_token: 38264578, last_price: 116,
      depth: { buy: [{ price: 115.5 }, { price: 115.0 }], sell: [{ price: 117.15 }, { price: 117.2 }] },
    } as KiteTick,
    1_000,
  )
  assert.equal(payload['bid'], 115.5)
  assert.equal(payload['ask'], 117.15)
})

test('md.tick omits bid/ask when the depth is absent or empty-sided', () => {
  const bare = tickPayload({ instrument_token: 1, last_price: 5 } as KiteTick, 1_000)
  assert.equal('bid' in bare, false)
  assert.equal('ask' in bare, false)
  // One-sided book: a bid with no offer prices nothing — both must be present.
  const oneSided = tickPayload(
    { instrument_token: 1, last_price: 5, depth: { buy: [{ price: 4.9 }], sell: [] } } as KiteTick,
    1_000,
  )
  assert.equal('bid' in oneSided, false)
  assert.equal('ask' in oneSided, false)
})

test('md.tick rejects a zero-priced depth level rather than publishing it', () => {
  // An empty book slot parses as price 0; a 0 bid would make every mid half
  // the ask. Zero is absence, exactly as the oi/volume rule above.
  const payload = tickPayload(
    { instrument_token: 1, last_price: 5, depth: { buy: [{ price: 0 }], sell: [{ price: 5.2 }] } } as KiteTick,
    1_000,
  )
  assert.equal('bid' in payload, false)
  assert.equal('ask' in payload, false)
})

test('a NEVER-TRADED strike (ltp 0, two-sided book) publishes at the MID, not at 0', () => {
  // The subscribe-time snapshot for a strike with no trades carries
  // last_price 0 beside a live book. Dropping it (the old ingest rule) left
  // the strike "no mark" until its first print — a BHEL wing sat stuck
  // exactly this way on 2026-08-17. Every consumer types price as a number
  // it can use, so the payload substitutes the mid rather than shipping 0.
  const payload = tickPayload(
    {
      instrument_token: 19679490, last_price: 0,
      depth: { buy: [{ price: 6.2 }], sell: [{ price: 6.5 }] },
    } as KiteTick,
    1_000,
  )
  assert.equal(payload['price'], (6.2 + 6.5) / 2)
  assert.equal(payload['bid'], 6.2)
  assert.equal(payload['ask'], 6.5)
})

test('acceptTick admits a depth-only tick and still rejects the truly empty one', () => {
  const depthOnly = {
    instrument_token: 1, last_price: 0,
    depth: { buy: [{ price: 6.2 }], sell: [{ price: 6.5 }] },
  } as KiteTick
  assert.equal(acceptTick(depthOnly, 1_000), true)
  // No trade ever AND no book: nothing prices this — reject as before.
  assert.equal(acceptTick({ instrument_token: 1, last_price: 0 } as KiteTick, 1_000), false)
  // A crossed book is a malformed packet even when the ltp looks fine.
  const crossed = {
    instrument_token: 1, last_price: 5,
    depth: { buy: [{ price: 5.4 }], sell: [{ price: 5.1 }] },
  } as KiteTick
  assert.equal(acceptTick(crossed, 1_000), false)
})
