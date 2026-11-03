/**
 * Registry seeding — the two rules that make it safe to run on every boot.
 *
 * The failure this file guards against is not a crash. It is a redeploy that
 * quietly turns a strategy back on after somebody switched it off, which nobody
 * would notice until it traded.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_STRATEGY, type StrategyRow, isOn } from '../src/strategies.ts'
import {
  HOSTED_STRATEGIES,
  LEGACY_SEEDED_REASON,
  seedHostedStrategies,
  type SeedStore,
} from '../src/registry-seed.ts'

class FakeSeedStore implements SeedStore {
  readonly rows = new Map<string, StrategyRow>()
  readonly registered: string[] = []
  readonly cleared: string[] = []

  async loadStrategy(tag: string): Promise<StrategyRow | null> {
    return this.rows.get(tag) ?? null
  }

  async registerStrategy(
    row: Partial<StrategyRow> & { tag: string },
    nowMs: number,
  ): Promise<StrategyRow> {
    // Same merge as DeskStore.registerStrategy: an upsert that overwrites.
    const merged: StrategyRow = { ...DEFAULT_STRATEGY, label: row.tag, ...row, updatedAt: nowMs }
    this.rows.set(row.tag, merged)
    this.registered.push(row.tag)
    return merged
  }

  /** Same filter as DeskStore's: the EXACT old value, or nothing happens. */
  async repairSeededAutostart(tag: string, from: string, to: string): Promise<boolean> {
    const row = this.rows.get(tag)
    if (row === undefined || row.autostartAt !== from) return false
    this.rows.set(tag, { ...row, autostartAt: to })
    return true
  }

  /** Same filter as DeskStore's: the EXACT text, or nothing happens. */
  async clearSeededDisabledReason(tag: string, seeded: string): Promise<boolean> {
    const row = this.rows.get(tag)
    if (row === undefined || row.disabledReason !== seeded) return false
    this.rows.set(tag, { ...row, disabledReason: '' })
    this.cleared.push(tag)
    return true
  }
}

let store: FakeSeedStore
const NOW = 1_800_000_000_000
const log = (): void => undefined

beforeEach(() => {
  store = new FakeSeedStore()
})

test('seeds every tag in the hosted table, and only those', async () => {
  const { added } = await seedHostedStrategies(store, NOW, log)
  assert.equal(added, HOSTED_STRATEGIES.length)
  assert.deepEqual(
    [...store.rows.keys()].sort(),
    HOSTED_STRATEGIES.map((s) => s.tag).sort(),
  )
})

test('every seeded row is OFF IN BOTH MODES — a deployment is not a trading permission', async () => {
  await seedHostedStrategies(store, NOW, log)
  for (const row of store.rows.values()) {
    assert.deepEqual(row.modes, { paper: { enabled: false } }, `${row.tag} was seeded switched on`)
    assert.equal(row.kind, 'hosted')
    // Zero, not one: flipping a row to live must not silently authorise a lot.
    assert.equal(row.liveLots, 0)
  }
})

/**
 * `disabledReason` records why a HUMAN switched something off. Filling it in
 * for every seeded row restated `modes.paper === false && modes.live === false`
 * — a fact the switch beside it already shows — and once every row carries a
 * reason, a REAL one is invisible in the noise.
 */
test('an ordinary seeded row carries NO disabledReason', async () => {
  await seedHostedStrategies(store, NOW, log)
  for (const tag of ['LION_S25_2', 'BULL_S_1', 'BULL_SNX_1']) {
    assert.equal(store.rows.get(tag)?.disabledReason, '', `${tag} carries filler text`)
  }
})

/**
 * NO SEEDED ROW INVENTS A REASON. `disabledReason` is for a reason a HUMAN
 * recorded. Once the seed fills it in, every row has text and a real
 * reason is invisible in the noise.
 */
test('no seeded row invents a disabledReason', async () => {
  await seedHostedStrategies(store, NOW, log)
  for (const row of store.rows.values()) {
    assert.equal(row.disabledReason, '', `${row.tag} invented a reason`)
  }
})

test('the premium sellers wait for 09:18', async () => {
  await seedHostedStrategies(store, NOW, log)
  // The premium sellers were legacy `autostart: true` ('' — start with the
  // process), which the day-roll floor turned into an entry at the 09:15
  // bell. They now wait for the open to settle.
  for (const tag of ['LION_S25_2', 'BULL_S_1', 'BULL_SNX_1']) {
    assert.equal(store.rows.get(tag)?.autostartAt, '0918', `${tag} should wait for 09:18`)
  }
})

test('every autostartAt is a valid IST HHmm or empty', async () => {
  await seedHostedStrategies(store, NOW, log)
  for (const row of store.rows.values()) {
    if (row.autostartAt === '') continue
    assert.match(row.autostartAt, /^\d{4}$/)
    const hh = Number(row.autostartAt.slice(0, 2))
    const mm = Number(row.autostartAt.slice(2))
    assert.ok(hh < 24 && mm < 60, `${row.tag}: ${row.autostartAt} is not a time`)
  }
})

test('a second run adds nothing — it is safe on every boot', async () => {
  await seedHostedStrategies(store, NOW, log)
  store.registered.length = 0
  const { added, cleared } = await seedHostedStrategies(store, NOW + 60_000, log)
  assert.equal(added, 0)
  assert.equal(cleared, 0, 'nothing left to repair either')
  assert.deepEqual(store.registered, [])
})

test('a redeploy NEVER re-enables something an operator turned off', async () => {
  // The operator's state: on, live, sized, with an autostart they edited.
  store.rows.set('BULL_S_1', {
    ...DEFAULT_STRATEGY,
    tag: 'BULL_S_1',
    kind: 'hosted',
    modes: { paper: { enabled: true }, live: { enabled: true } },
    liveLots: 4,
    autostartAt: '0930',
    updatedAt: 1,
  })
  // ...and one they deliberately switched OFF with a reason.
  store.rows.set('LION_S25_2', {
    ...DEFAULT_STRATEGY,
    tag: 'LION_S25_2',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    liveLots: 2,
    disabledReason: 'blew through its stop on Tuesday',
    updatedAt: 1,
  })

  await seedHostedStrategies(store, NOW, log)

  const bull = store.rows.get('BULL_S_1')
  assert.deepEqual(bull?.modes, { paper: { enabled: true }, live: { enabled: true } })
  assert.equal(bull?.liveLots, 4)
  assert.equal(bull?.autostartAt, '0930')
  assert.equal(bull?.updatedAt, 1, 'an untouched row must not even be re-stamped')

  const lion = store.rows.get('LION_S25_2')
  assert.deepEqual(lion?.modes, { paper: { enabled: false } })
  assert.equal(lion?.liveLots, 2)
  assert.equal(lion?.disabledReason, 'blew through its stop on Tuesday')

  assert.equal(store.registered.includes('BULL_S_1'), false)
  assert.equal(store.registered.includes('LION_S25_2'), false)
})

test('a missing row is still added alongside rows that already exist', async () => {
  store.rows.set('BULL_S_1', {
    ...DEFAULT_STRATEGY,
    tag: 'BULL_S_1',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    updatedAt: 1,
  })
  const { added } = await seedHostedStrategies(store, NOW, log)
  assert.equal(added, HOSTED_STRATEGIES.length - 1)
  assert.deepEqual(store.rows.get('BULL_SNX_1')?.modes, { paper: { enabled: false } })
})

// ------------------------------------------------- the one-off filler repair

test('the legacy filler reason is CLEARED from rows that already carry it', async () => {
  // The seed is insert-only by design, so rows already in Mongo
  // would keep the filler forever unless something clears it.
  store.rows.set('BULL_S_1', {
    ...DEFAULT_STRATEGY,
    tag: 'BULL_S_1',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    disabledReason: LEGACY_SEEDED_REASON,
    updatedAt: 1,
  })
  const { cleared } = await seedHostedStrategies(store, NOW, log)
  assert.equal(cleared, 1)
  assert.equal(store.rows.get('BULL_S_1')?.disabledReason, '')
  assert.deepEqual(store.cleared, ['BULL_S_1'])
})

test("the repair cannot touch an OPERATOR's own note, or a row that is switched on", async () => {
  // An operator's note never equals the filler string, and a row somebody
  // switched on is not one the seeder has any business editing.
  store.rows.set('BULL_S_1', {
    ...DEFAULT_STRATEGY,
    tag: 'BULL_S_1',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    disabledReason: 'blew through its stop on Tuesday',
    updatedAt: 1,
  })
  store.rows.set('LION_S25_2', {
    ...DEFAULT_STRATEGY,
    tag: 'LION_S25_2',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    disabledReason: LEGACY_SEEDED_REASON,
    updatedAt: 1,
  })
  const { cleared } = await seedHostedStrategies(store, NOW, log)
  assert.equal(cleared, 0)
  assert.equal(store.rows.get('BULL_S_1')?.disabledReason, 'blew through its stop on Tuesday')
  assert.equal(store.rows.get('LION_S25_2')?.disabledReason, LEGACY_SEEDED_REASON)
})

test('tags are unique — two rows for one tag would make the switch ambiguous', () => {
  const tags = HOSTED_STRATEGIES.map((s) => s.tag)
  assert.equal(new Set(tags).size, tags.length)
})

/**
 * EVERY seeded tag must be hostable. The bulk switch and the add form both
 * refuse a hosted tag with no implementation, which is right: a row nothing
 * runs is a switch that looks armed.
 */
test('every seeded tag is hostable', async () => {
  const { isHostedTag } = await import('../../runner/src/catalogue.ts')
  for (const seed of HOSTED_STRATEGIES) {
    assert.equal(isHostedTag(seed.tag), true, `${seed.tag} is seeded but nothing hosts it`)
  }
})

/**
 * The premium sellers' seeded '' is corrected to 0918 on a deployment that
 * already has it — including rows an operator has switched ON, because the
 * bell-entry is the behaviour being retired and it lives precisely on the
 * rows in use. This repair changes what runs, and that is the point.
 */
test("a premium seller's seeded '' autostart is corrected to 0918, even switched on", async () => {
  store.rows.set('BULL_SNX_1', {
    ...DEFAULT_STRATEGY,
    tag: 'BULL_SNX_1',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    autostartAt: '',
    updatedAt: 1,
  })
  await seedHostedStrategies(store, NOW, log)
  assert.equal(store.rows.get('BULL_SNX_1')?.autostartAt, '0918')
  assert.equal(
    isOn(store.rows.get('BULL_SNX_1')?.modes ?? {}, 'paper'),
    true,
    'and the switch itself is untouched',
  )
})

test("an operator's own chosen time on a premium seller is never overwritten", async () => {
  // The repair matches the exact seeded '' — a deliberate 0930 is a decision,
  // and rule 1 says a redeploy must never undo an operator's decision.
  store.rows.set('BULL_S_1', {
    ...DEFAULT_STRATEGY,
    tag: 'BULL_S_1',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    autostartAt: '0930',
    updatedAt: 1,
  })
  await seedHostedStrategies(store, NOW, log)
  assert.equal(store.rows.get('BULL_S_1')?.autostartAt, '0930')
})
