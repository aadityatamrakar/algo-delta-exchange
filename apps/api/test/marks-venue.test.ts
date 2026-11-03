/**
 * Which exchange's prices mark a book: where its position LIVES.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEMO_TICK_TOPIC, marksVenueOf } from '../src/books-registry.ts'

test('a paper book on the demo rail is marked by Delta demo; sim and live by Delta', () => {
  assert.equal(marksVenueOf({ mode: 'paper', dx_paper_rail: 'demo', dx_rail_used: null }), 'demo')
  assert.equal(marksVenueOf({ mode: 'paper', dx_paper_rail: 'demo', dx_rail_used: 'demo' }), 'demo')
  assert.equal(marksVenueOf({ mode: 'paper', dx_paper_rail: 'sim', dx_rail_used: null }), 'prod')
  assert.equal(marksVenueOf({ mode: 'live', dx_paper_rail: 'demo', dx_rail_used: 'demo' }), 'prod')
})

test('the rail the gateway actually used wins over the setting', () => {
  // Demo setting, but no demo key: the gateway simulated it, so prod prices are its truth.
  assert.equal(marksVenueOf({ mode: 'paper', dx_paper_rail: 'demo', dx_rail_used: 'sim' }), 'prod')
  // Switched to sim while holding: the gateway keeps it on demo until flat, so demo prices stay.
  assert.equal(marksVenueOf({ mode: 'paper', dx_paper_rail: 'sim', dx_rail_used: 'demo' }), 'demo')
})

test('the demo tick topic is not matched by an md.tick subscription', async () => {
  const { topicMatches } = await import('@algomaker/bus')
  assert.equal(DEMO_TICK_TOPIC, 'md.tick.demo')
  assert.equal(topicMatches('md.tick', DEMO_TICK_TOPIC), false)
  assert.equal(topicMatches('md.*', DEMO_TICK_TOPIC), false)
})
