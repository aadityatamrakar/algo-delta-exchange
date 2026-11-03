/**
 * The catalogue joins two lists that live in different apps: the seed table in
 * `apps/api/src/registry-seed.ts` and the ported configs in
 * `packages/strategies`. Nothing at runtime checks that they agree — a tag
 * present in one and absent from the other produces either a registry row
 * nothing ever runs, or a strategy nobody can switch off. Both are silent.
 *
 * So the agreement is asserted here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import {
  firstIstMinuteOfDay,
  makeLogger,
  MemoryStateStore,
  parseCron,
  RecordingGateway,
  type StrategyContext,
} from '@algomaker/strategy-kit'
import { HOSTED_STRATEGIES } from '../../api/src/registry-seed.ts'
import { CATALOGUE } from '../src/catalogue.ts'
import { ensureRuntimeIndexes, runtimePublisher, toRuntimeView, RUNTIME_STALE_MS } from '../src/runtime.ts'

test('every catalogue tag has a registry row — otherwise it could never be switched off', () => {
  const seeded = new Set(HOSTED_STRATEGIES.map((s) => s.tag))
  for (const tag of CATALOGUE.keys()) {
    assert.ok(seeded.has(tag), `${tag} runs but has no registry row`)
  }
})

test('every seeded row has an implementation', () => {
  for (const seed of HOSTED_STRATEGIES) {
    assert.ok(CATALOGUE.has(seed.tag), `${seed.tag} is seeded but nothing runs it`)
  }
})

test('the registry tag and the config tag are BOTH kept — neither can be renamed away', () => {
  // The config tag is what the golden-master fixtures and the legacy XTS
  // account map are keyed on; the registry tag is what every gate on the
  // bridge keys on. Collapsing them would break one or the other.
  assert.equal(CATALOGUE.get('BULL_S_1')?.configTag, 'Bull_S-1')
  assert.equal(CATALOGUE.get('BULL_SNX_1')?.configTag, 'Bull_SNX-1')
  assert.equal(CATALOGUE.get('LION_S25_2')?.configTag, 'Lion_S25_2')
})

test('every entry declares an underlying and at least one data need', () => {
  for (const [tag, entry] of CATALOGUE) {
    assert.ok(entry.underlying !== '', `${tag} has no underlying`)
    assert.ok(entry.dataNeeds.length > 0, `${tag} declares no data`)
  }
})

test('every entry actually constructs, and gets the REGISTRY tag as its ctx tag', () => {
  const clock = fixedClock(Date.UTC(2026, 6, 24, 4, 0))
  for (const [tag, entry] of CATALOGUE) {
    const gateway = new RecordingGateway()
    const ctx: StrategyContext = {
      tag,
      clock,
      md: {
        quote: () => null,
        candles: async () => [],
        option: () => null,
        selectOption: () => null,
        future: () => null,
        atmStrike: () => 0,
        spotToken: () => 1,
      },
      orders: gateway,
      fills: gateway.asFillStream(),
      state: new MemoryStateStore(),
      log: makeLogger(),
      mode: 'sim',
      destinations: ['sim'],
      feed: { isTrustworthy: () => true, reason: () => null },
    }
    const strategy = entry.build(ctx)
    assert.equal(strategy.tag, tag, `${tag} was built with the wrong ctx tag`)
    const jobs = strategy.jobs()
    assert.ok(jobs.length > 0, `${tag} declares no jobs`)

    /**
     * EVERY CRON IS ACTUALLY PARSED. The comment here used to promise this and
     * the assertion underneath it was `jobs().length > 0`, which is a different
     * claim entirely — a job with the expression `'nonsense'` satisfied it.
     *
     * Crons are parsed nowhere else until `StrategyBase.start()` runs, i.e. at
     * 09:15 on the day the strategy is first switched on, and a throw there is
     * caught by `start()`'s own handler: it logs "start failed, will retry",
     * resets `#started`, and the runner leaves the row `waiting` forever. So a
     * typo in a cron is a strategy that never runs and never says why, and the
     * only thing standing between that and a release is this loop.
     */
    for (const job of jobs) {
      assert.doesNotThrow(
        () => parseCron(job.cron),
        `${tag} job '${job.name}' has an unparseable cron: ${job.cron}`,
      )
      const minute = firstIstMinuteOfDay(job.cron)
      // And it has to fire inside a trading day. An expression that parses but
      // resolves to 03:00 is a job that will never run while the market is
      // open, which is the same outcome as not declaring it.
      assert.ok(
        minute >= 9 * 60 && minute <= 15 * 60 + 40,
        `${tag} job '${job.name}' fires at IST minute ${minute}, outside the session`,
      )
    }
  }
})

test('a malformed cron would be CAUGHT — the check above is not vacuous', () => {
  // The guard on the guard. `parseCron` has to reject garbage, or the loop
  // above passes for every expression anybody ever writes.
  assert.throws(() => parseCron('nonsense'))
  assert.throws(() => parseCron('0 99 9 * * 1-5'))
})

// ------------------------------------------------------------------ runtime

test('runtime snapshots are upserted one document per tag AND MODE', async () => {
  const writes: { filter: Record<string, unknown>; update: Record<string, unknown> }[] = []
  const deletes: Record<string, unknown>[] = []
  const publish = runtimePublisher(
    {
      updateOne: async (filter, update) => {
        writes.push({ filter, update })
        return {}
      },
      createIndex: async () => ({}),
      deleteMany: async (filter) => {
        deletes.push(filter)
        return {}
      },
    },
    'runner',
  )
  // The same tag on both rails: two supervised instances, two documents. Under
  // a `{ tag }` filter they would upsert over each other every second and the
  // portal would show whichever published last — "squared-off, 0 open" borrowed
  // from paper while the live instance is failed holding a leg.
  await publish([
    { tag: 'A', mode: 'paper', state: 'running', startedAt: 1, lastError: null, openPositions: 2, updatedAt: 9 },
    { tag: 'A', mode: 'live', state: 'failed', startedAt: 1, lastError: 'stuck', openPositions: 1, updatedAt: 9 },
  ])
  assert.deepEqual(writes[0]?.filter, { tag: 'A', mode: 'paper' })
  assert.deepEqual(writes[1]?.filter, { tag: 'A', mode: 'live' })
  assert.equal((writes[0]?.update['$set'] as Record<string, unknown>)['state'], 'running')
  assert.equal((writes[1]?.update['$set'] as Record<string, unknown>)['state'], 'failed')
})

test('the legacy single-field unique index is DROPPED before the compound one is made', async () => {
  // A collection still carrying `tag_1 unique` accepts the paper instance's
  // document and rejects the live one on every publish, so the live instance
  // never appears in the portal at all — the one state an operator most needs.
  const dropped: string[] = []
  const created: Record<string, 1 | -1>[] = []
  await ensureRuntimeIndexes({
    updateOne: async () => ({}),
    createIndex: async (spec) => {
      created.push(spec)
      return {}
    },
    dropIndex: async (name) => {
      dropped.push(name)
      return {}
    },
  })
  assert.deepEqual(dropped, ['tag_1'])
  assert.deepEqual(created, [{ tag: 1, mode: 1 }])
})

test('a fresh database with no legacy index still gets the compound one', async () => {
  const created: Record<string, 1 | -1>[] = []
  await ensureRuntimeIndexes({
    updateOne: async () => ({}),
    createIndex: async (spec) => {
      created.push(spec)
      return {}
    },
    dropIndex: async () => {
      throw new Error('index not found with name [tag_1]')
    },
  })
  assert.deepEqual(created, [{ tag: 1, mode: 1 }], 'the drop failing must not stop boot')
})

test('the runtime VIEW carries contract §6\'s four fields, plus whether they are current', () => {
  const now = 1_700_000_000_000
  const view = toRuntimeView({
    tag: 'A',
    state: 'running',
    startedAt: 5,
    lastError: '',
    openPositions: 3,
    updatedAt: now - 1_000,
  }, now)
  assert.deepEqual(view, {
    state: 'running',
    startedAt: 5,
    // An empty string is not an error — rendering one would put a blank red
    // banner on a healthy strategy.
    lastError: null,
    openPositions: 3,
    stale: false,
  })
})

/**
 * `updatedAt` ITSELF STAYS OFF THE VIEW. The runner rewrites it about once a
 * second, so putting the raw number on the wire would make every 8s poll look
 * like a change to the page. Its AGE is the only thing a reader needs, and one
 * boolean answers it without churning.
 */
test('a runtime document nobody has rewritten is flagged stale — the raw timestamp is not exposed', () => {
  const now = 1_700_000_000_000
  const view = toRuntimeView({
    tag: 'A', state: 'running', startedAt: 5, lastError: '', openPositions: 3,
    updatedAt: now - RUNTIME_STALE_MS - 1,
  }, now)
  assert.equal(view?.stale, true, 'a dead publisher leaves "running" on the page forever otherwise')
  assert.equal((view as unknown as Record<string, unknown>)['updatedAt'], undefined)
})

/**
 * A document with no usable `updatedAt` cannot be shown to be current, and
 * "cannot prove it is live" must read the same as "is not live": the whole
 * point of the flag is that `running` is only believed while something is
 * actively saying so.
 */
test('a runtime document with no readable updatedAt is stale, not assumed fresh', () => {
  const now = 1_700_000_000_000
  assert.equal(toRuntimeView({ state: 'running' }, now)?.stale, true)
  assert.equal(toRuntimeView({ state: 'running', updatedAt: 'soon' }, now)?.stale, true)
})

test('a missing or malformed runtime document reads as null, never as a fabricated state', () => {
  assert.equal(toRuntimeView(null, 0), null)
  assert.equal(toRuntimeView({ tag: 'A' }, 0), null)
})

/**
 * A STRATEGY SWITCHED OFF MUST STOP SAYING `running`.
 *
 * The publisher only upserted, so an instance dropped from the supervised map
 * simply stopped being published and its document kept its LAST value forever.
 * The portal then showed `running` beside a Trading toggle that was off — the
 * most misleading thing this field can say, because `running` is the word an
 * operator trusts before deciding whether to touch something.
 *
 * The sweep is scoped by host: two hosts write to this one collection, and an
 * unscoped delete would remove every mirror row a second before MirrorHost
 * rewrote it.
 */
test('a departed instance is REMOVED, and only within its own host', async () => {
  const deletes: Record<string, unknown>[] = []
  const publish = runtimePublisher(
    {
      updateOne: async () => ({}),
      createIndex: async () => ({}),
      deleteMany: async (filter) => {
        deletes.push(filter)
        return {}
      },
    },
    'runner',
  )
  await publish([
    { tag: 'A', mode: 'paper', state: 'running', startedAt: 1, lastError: null, openPositions: 0, updatedAt: 9 },
  ])

  const f = deletes[0] as { $or: Record<string, unknown>[] }
  assert.equal(deletes.length, 1, 'one sweep, not one delete per departed instance')
  assert.deepEqual(f.$or[0], { host: 'runner', key: { $nin: ['A:paper'] } })
  assert.deepEqual(
    f.$or[1],
    { host: { $exists: false } },
    'legacy rows from before the per-mode split are swept too',
  )
  // The mirror host is never touched by the runner's sweep.
  assert.equal(JSON.stringify(f).includes("'mirror'"), false)
})
