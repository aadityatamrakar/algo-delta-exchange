import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveAllowlistFromStrategies } from '../src/strategies.ts'

/** Minimal stand-in for the `desk-strategies` collection. */
function coll(rows: Record<string, unknown>[], opts: { throws?: boolean } = {}) {
  return {
    calls: 0,
    async findOne(filter: Record<string, unknown>) {
      this.calls++
      if (opts.throws === true) throw new Error('mongo is down')
      return rows.find((r) => r['tag'] === filter['tag']) ?? null
    },
  }
}

const on = (tag: string) => ({ tag, modes: { live: { enabled: true }, paper: { enabled: true } } })
const off = (tag: string) => ({ tag, modes: { live: { enabled: false }, paper: { enabled: true } } })

test('a tag switched ON for live is allowed', async () => {
  const c = coll([on('BAJFINANCE-2026-08-25-recenter-r')])
  const allow = liveAllowlistFromStrategies(c, new Set())
  assert.equal(await allow('BAJFINANCE-2026-08-25-recenter-r'), true)
})

test('a tag switched OFF for live is refused', async () => {
  const c = coll([off('BAJFINANCE-2026-08-25-recenter-r')])
  const allow = liveAllowlistFromStrategies(c, new Set())
  assert.equal(await allow('BAJFINANCE-2026-08-25-recenter-r'), false)
})

test('a tag with no strategy row at all is refused', async () => {
  const allow = liveAllowlistFromStrategies(coll([]), new Set())
  assert.equal(await allow('NEVER_REGISTERED'), false)
})

test('a row with no modes object is refused, not crashed on', async () => {
  const allow = liveAllowlistFromStrategies(coll([{ tag: 'T' }]), new Set())
  assert.equal(await allow('T'), false)
})

test('enabled must be exactly true — truthy is not enough', async () => {
  // A stray string or 1 in the document must not read as permission to trade.
  for (const bad of ['true', 1, {}, [] as unknown]) {
    const c = coll([{ tag: 'T', modes: { live: { enabled: bad } } }])
    assert.equal(await liveAllowlistFromStrategies(c, new Set())('T'), false, `enabled=${String(bad)}`)
  }
})

test('IT FAILS CLOSED: a store that throws refuses rather than allows', async () => {
  // The single most important property here. An unreachable Mongo must never
  // read as "no restriction" — that would turn an outage into an open rail.
  const allow = liveAllowlistFromStrategies(coll([on('T')], { throws: true }), new Set())
  assert.equal(await allow('T'), false)
})

test('a non-empty env restriction can only NARROW, never widen', async () => {
  // DESK_LIVE_TAGS is now a box-level lock layered ON TOP of the dashboard
  // switch, so a machine can be pinned to a subset regardless of what the
  // dashboard says. It cannot enable anything by itself.
  const c = coll([on('A'), on('B')])
  const pinned = liveAllowlistFromStrategies(c, new Set(['A']))
  assert.equal(await pinned('A'), true, 'switched on AND pinned')
  assert.equal(await pinned('B'), false, 'switched on but not pinned')

  const pinnedToOff = liveAllowlistFromStrategies(coll([off('A')]), new Set(['A']))
  assert.equal(await pinnedToOff('A'), false, 'pinned cannot enable a switched-off tag')
})

test('an empty env restriction means no extra restriction', async () => {
  const allow = liveAllowlistFromStrategies(coll([on('A')]), new Set())
  assert.equal(await allow('A'), true)
})

test('it is queried per order, so a dashboard switch takes effect immediately', async () => {
  // The whole point of moving off the env var: no restart, no stale cache. A
  // tag turned off mid-session must stop routing on the very next order.
  const rows: Record<string, unknown>[] = [on('T')]
  const c = coll(rows)
  const allow = liveAllowlistFromStrategies(c, new Set())
  assert.equal(await allow('T'), true)
  rows[0] = off('T')
  assert.equal(await allow('T'), false)
  assert.equal(c.calls, 2, 'each check must hit the store, not a cache')
})
