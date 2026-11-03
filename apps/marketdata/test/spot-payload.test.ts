/**
 * The `md.spot` payload, in isolation — and the previous close it now carries
 * (six-playbooks spec F6).
 *
 * The full-mode index tick's `ohlc.close` is the PREVIOUS session's close, and
 * the playbooks measure the opening gap against it. `spotPayload` is the pure
 * mapping from a raw `KiteTick` to what goes on the bus, so the rule — present
 * when it is a finite positive number, otherwise ABSENT — is testable without
 * booting the feed host (no Mongo, no Kite login, no bus).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spotPayload } from '../src/main.ts'
import type { KiteTick } from '../src/kite-feed.ts'

const TS = 1_760_000_000_000
const OHLC = { open: 24_100, high: 24_150, low: 23_980, close: 23_950.25 }

test('md.spot carries the previous close off a full-mode index tick', () => {
  const payload = spotPayload('NIFTY', { instrument_token: 256265, last_price: 24_010.5, ohlc: OHLC } as KiteTick, TS)
  assert.deepEqual(payload, { underlying: 'NIFTY', price: 24_010.5, ts: TS, prevClose: 23_950.25 })
})

test('md.spot omits the previous close entirely when the packet has no ohlc', () => {
  // An LTP-mode packet carries no ohlc at all. The key must be ABSENT, not
  // present-as-undefined: the consumer reads absent as "unknown".
  const payload = spotPayload('SENSEX', { instrument_token: 265, last_price: 81_000 } as KiteTick, TS)
  assert.deepEqual(payload, { underlying: 'SENSEX', price: 81_000, ts: TS })
  assert.equal('prevClose' in payload, false)
})

test('a close that is not a price is never published', () => {
  // A 0 close is an empty field, not a session that closed at nothing: read as
  // a previous close it is a gap of the whole index.
  for (const close of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const payload = spotPayload(
      'NIFTY',
      { instrument_token: 256265, last_price: 24_010.5, ohlc: { ...OHLC, close } } as KiteTick,
      TS,
    )
    assert.equal('prevClose' in payload, false, `close ${String(close)}`)
  }
})
