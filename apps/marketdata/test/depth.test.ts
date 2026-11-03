/**
 * Depth levels on the md.tick payload.
 *
 * The feed now retains the top 5 depth levels (price + quantity) per side so
 * the desk can estimate execution prices when it needs to repair. Quantities
 * are optional because older fixtures omit them; levels with price <= 0 are
 * skipped entirely (not present as null).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tickPayload } from '../src/main.ts'
import type { KiteTick } from '../src/kite-feed.ts'

test('tickPayload carries top-5 depth with quantities, skipping empty levels', () => {
  const t = {
    instrument_token: 111,
    last_price: 12.4,
    depth: {
      buy: [{ price: 12.3, quantity: 500 }, { price: 12.25, quantity: 900 }, { price: 0, quantity: 0 }],
      sell: [{ price: 12.5, quantity: 250 }],
    },
  } as KiteTick
  const p = tickPayload(t, 1755750000000)
  assert.deepEqual(p.depth, {
    buy: [{ price: 12.3, qty: 500 }, { price: 12.25, qty: 900 }],
    sell: [{ price: 12.5, qty: 250 }],
  })
})

test('tickPayload omits depth when the packet has none', () => {
  const p = tickPayload({ instrument_token: 1, last_price: 5 } as KiteTick, 1)
  assert.equal(p.depth, undefined)
})
