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
  LEGACY_MIRROR_AUTOSTART,
  LEGACY_SEEDED_REASON,
  RETIRED_SEEDED_REASONS,
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

test('seeds every tag in the Phase C table, and only those', async () => {
  const { added } = await seedHostedStrategies(store, NOW, log)
  assert.equal(added, HOSTED_STRATEGIES.length)
  assert.deepEqual(
    [...store.rows.keys()].sort(),
    HOSTED_STRATEGIES.map((s) => s.tag).sort(),
  )
})

test('smp_order_listener gets NO row — it is infrastructure, not a strategy', async () => {
  await seedHostedStrategies(store, NOW, log)
  for (const tag of store.rows.keys()) {
    assert.doesNotMatch(tag.toLowerCase(), /smp/)
  }
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
  for (const tag of ['BN_BREAKOUT', 'ORB_FUT_NIFTY', 'LION_S25_2', 'CHEETAH_B1_1']) {
    assert.equal(store.rows.get(tag)?.disabledReason, '', `${tag} carries filler text`)
  }
})

/**
 * NO SEEDED ROW INVENTS A REASON — not even the mirrors.
 *
 * This test used to assert the opposite for the three `MIRROR_*` rows, whose
 * reason said their credentials were "not migrated to the broker store yet".
 * That described a PLAN, not a problem, and the plan changed: optionbhai is a
 * signal source rather than a broker, so its credentials live in the
 * environment by decision. A mirror whose pair is absent refuses to start and
 * says so at that moment, which is the honest place to report it.
 *
 * The rule this pins is the general one: `disabledReason` is for a reason a
 * HUMAN recorded. Once the seed fills it in, every row has text and a real
 * reason is invisible in the noise.
 */
test('no seeded row invents a disabledReason', async () => {
  await seedHostedStrategies(store, NOW, log)
  for (const row of store.rows.values()) {
    assert.equal(row.disabledReason, '', `${row.tag} invented a reason`)
  }
})

test('autostart times come from the legacy table, with autostart rows as an empty string', async () => {
  await seedHostedStrategies(store, NOW, log)
  assert.equal(store.rows.get('BN_BREAKOUT')?.autostartAt, '0916')
  assert.equal(store.rows.get('CHEETAH_B1_1')?.autostartAt, '0917')
  assert.equal(store.rows.get('ATR_BAND_NIFTY')?.autostartAt, '0918')
  // A mirror is '' — start with the process. MirrorHost has no schedule, and
  // delaying one risks mirroring an exit whose entry it never saw.
  assert.equal(store.rows.get('MIRROR_1PBUY')?.autostartAt, '')
  // The premium sellers were legacy `autostart: true` ('' — start with the
  // process), which the day-roll floor turned into an entry at the 09:15
  // bell. They now wait for the open to settle.
  for (const tag of ['LION_S25_2', 'EAGLE_S_1', 'BULL_S_1', 'BULL_SNX_1']) {
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
  store.rows.set('BN_BREAKOUT', {
    ...DEFAULT_STRATEGY,
    tag: 'BN_BREAKOUT',
    kind: 'hosted',
    modes: { paper: { enabled: true }, live: { enabled: true } },
    liveLots: 4,
    autostartAt: '0930',
    updatedAt: 1,
  })
  // ...and one they deliberately switched OFF with a reason.
  store.rows.set('EAGLE_S_1', {
    ...DEFAULT_STRATEGY,
    tag: 'EAGLE_S_1',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    liveLots: 2,
    disabledReason: 'blew through its stop on Tuesday',
    updatedAt: 1,
  })

  await seedHostedStrategies(store, NOW, log)

  const bn = store.rows.get('BN_BREAKOUT')
  assert.deepEqual(bn?.modes, { paper: { enabled: true }, live: { enabled: true } })
  assert.equal(bn?.liveLots, 4)
  assert.equal(bn?.autostartAt, '0930')
  assert.equal(bn?.updatedAt, 1, 'an untouched row must not even be re-stamped')

  const eagle = store.rows.get('EAGLE_S_1')
  assert.deepEqual(eagle?.modes, { paper: { enabled: false } })
  assert.equal(eagle?.liveLots, 2)
  assert.equal(eagle?.disabledReason, 'blew through its stop on Tuesday')

  assert.equal(store.registered.includes('BN_BREAKOUT'), false)
  assert.equal(store.registered.includes('EAGLE_S_1'), false)
})

test('a missing row is still added alongside rows that already exist', async () => {
  store.rows.set('BN_BREAKOUT', {
    ...DEFAULT_STRATEGY,
    tag: 'BN_BREAKOUT',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    updatedAt: 1,
  })
  const { added } = await seedHostedStrategies(store, NOW, log)
  assert.equal(added, HOSTED_STRATEGIES.length - 1)
  assert.deepEqual(store.rows.get('ORB_SCALP_SNX')?.modes, { paper: { enabled: false } })
})

// ------------------------------------------------- the one-off filler repair

test('the legacy filler reason is CLEARED from rows that already carry it', async () => {
  // The seed is insert-only by design, so the fifteen rows already in Mongo
  // would keep the filler forever unless something clears it.
  store.rows.set('BN_BREAKOUT', {
    ...DEFAULT_STRATEGY,
    tag: 'BN_BREAKOUT',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    disabledReason: LEGACY_SEEDED_REASON,
    updatedAt: 1,
  })
  const { cleared } = await seedHostedStrategies(store, NOW, log)
  assert.equal(cleared, 1)
  assert.equal(store.rows.get('BN_BREAKOUT')?.disabledReason, '')
  assert.deepEqual(store.cleared, ['BN_BREAKOUT'])
})

test("the repair cannot touch an OPERATOR's own note, or a row that is switched on", async () => {
  // An operator's note never equals the filler string, and a row somebody
  // switched on is not one the seeder has any business editing.
  store.rows.set('BN_BREAKOUT', {
    ...DEFAULT_STRATEGY,
    tag: 'BN_BREAKOUT',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    disabledReason: 'blew through its stop on Tuesday',
    updatedAt: 1,
  })
  store.rows.set('EAGLE_S_1', {
    ...DEFAULT_STRATEGY,
    tag: 'EAGLE_S_1',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    disabledReason: LEGACY_SEEDED_REASON,
    updatedAt: 1,
  })
  const { cleared } = await seedHostedStrategies(store, NOW, log)
  assert.equal(cleared, 0)
  assert.equal(store.rows.get('BN_BREAKOUT')?.disabledReason, 'blew through its stop on Tuesday')
  assert.equal(store.rows.get('EAGLE_S_1')?.disabledReason, LEGACY_SEEDED_REASON)
})

/**
 * A MIRROR row still carrying the old filler IS repaired now.
 *
 * It used to be exempt, because the seed declared a reason of its own for those
 * rows ("credentials not migrated to the broker store yet") and the repair
 * never touches a row whose seed states a real reason. That reason is gone —
 * optionbhai credentials come from the environment by decision, not pending a
 * migration — so the row is like any other and the stale text should go.
 *
 * Worth a test of its own rather than a line in the one above: this is the
 * behaviour that CHANGED, and if the seed ever reintroduces a reason for these
 * rows the exemption comes back silently with it.
 */
test('a MIRROR row carrying the old filler is repaired like any other', async () => {
  store.rows.set('MIRROR_A006', {
    ...DEFAULT_STRATEGY,
    tag: 'MIRROR_A006',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    disabledReason: LEGACY_SEEDED_REASON,
    updatedAt: 1,
  })
  const { cleared } = await seedHostedStrategies(store, NOW, log)
  assert.equal(cleared, 1)
  assert.equal(store.rows.get('MIRROR_A006')?.disabledReason, '')
})

test('the three ORB_SCALP variants get their OWN rows, not one shared switch', async () => {
  await seedHostedStrategies(store, NOW, log)
  // One legacy process ran all three off a CONFIGS array. Collapsing them here
  // would mean disabling the SENSEX variant silently disabled the NIFTY one.
  for (const tag of ['ORB_SCALP_BN', 'ORB_SCALP_NIFTY', 'ORB_SCALP_SNX']) {
    assert.ok(store.rows.has(tag), `${tag} needs its own row`)
  }
})

test('tags are unique — two rows for one tag would make the switch ambiguous', () => {
  const tags = HOSTED_STRATEGIES.map((s) => s.tag)
  assert.equal(new Set(tags).size, tags.length)
})

/**
 * The two RETIRED reasons are repaired on an existing deployment.
 *
 * Deleting them from the seed only helps a fresh install. Seeding is
 * insert-only by design, so a desk that is already running keeps the text
 * forever — which is precisely how "fixed in code, still wrong in production"
 * happens, and it happened once already with LEGACY_SEEDED_REASON.
 */
test('a retired seeded reason is cleared on a deployment that already has it', async () => {
  for (const [tag, reason] of [
    ['ATR_BAND_NIFTY', RETIRED_SEEDED_REASONS[0] as string],
    ['MIRROR_1PBUY', RETIRED_SEEDED_REASONS[1] as string],
  ] as const) {
    store.rows.set(tag, {
      ...DEFAULT_STRATEGY,
      tag,
      kind: 'hosted',
      modes: { paper: { enabled: false } },
      disabledReason: reason,
      updatedAt: 1,
    })
  }
  const { cleared } = await seedHostedStrategies(store, NOW, log)
  assert.equal(cleared, 2)
  assert.equal(store.rows.get('ATR_BAND_NIFTY')?.disabledReason, '')
  assert.equal(store.rows.get('MIRROR_1PBUY')?.disabledReason, '')
})

test('a retired reason is NOT cleared on a row somebody switched on', async () => {
  // Same guard as the filler repair: a row in use is not the seeder's business.
  store.rows.set('ATR_BAND_NIFTY', {
    ...DEFAULT_STRATEGY,
    tag: 'ATR_BAND_NIFTY',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    disabledReason: RETIRED_SEEDED_REASONS[0] as string,
    updatedAt: 1,
  })
  const { cleared } = await seedHostedStrategies(store, NOW, log)
  assert.equal(cleared, 0)
  assert.equal(store.rows.get('ATR_BAND_NIFTY')?.disabledReason, RETIRED_SEEDED_REASONS[0])
})

/**
 * EVERY seeded tag must be hostable — including the mirrors.
 *
 * The bulk switch and the add form both refuse a hosted tag with no
 * implementation, which is right: a row nothing runs is a switch that looks
 * armed. But they asked `CATALOGUE`, and the three `MIRROR_*` tags are
 * deliberately absent from it because `MirrorHost` runs them instead. The
 * operator was told three implemented strategies "would not run".
 *
 * This pins the seed against the union, so seeding a tag no host implements —
 * or adding a third host and forgetting to include it — fails here rather than
 * in the portal.
 */
test('every seeded tag is hostable by SOME runner path, not just the catalogue', async () => {
  const { isHostedTag } = await import('../../runner/src/catalogue.ts')
  for (const seed of HOSTED_STRATEGIES) {
    assert.equal(isHostedTag(seed.tag), true, `${seed.tag} is seeded but nothing hosts it`)
  }
})

/**
 * The mirrors' 0914 is corrected on a deployment that already has it.
 *
 * `MirrorHost` has no schedule, so the row displayed a start time nothing
 * honoured. Delaying a mirror is not merely pointless but dangerous — miss the
 * upstream's entry, see its exit, and it places a SELL with no position behind
 * it — so '' (start with the process) is the honest value AND the safe one.
 */
test("a mirror's legacy 0914 autostart is corrected to start-with-the-process", async () => {
  store.rows.set('MIRROR_1PBUY', {
    ...DEFAULT_STRATEGY,
    tag: 'MIRROR_1PBUY',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    autostartAt: LEGACY_MIRROR_AUTOSTART,
    updatedAt: 1,
  })
  await seedHostedStrategies(store, NOW, log)
  assert.equal(store.rows.get('MIRROR_1PBUY')?.autostartAt, '')
})

/**
 * A SWITCHED-ON mirror is corrected too — the one repair that ignores that guard.
 *
 * Every other repair refuses to touch a row in use, because editing something
 * running is how you change behaviour nobody asked to change. `autostartAt` is
 * different: it is INERT for a mirror (MirrorHost never reads it, Runner
 * excludes MIRROR_*), so there is no behaviour to protect. With the guard in
 * place, the rows an operator actually uses were the only ones left displaying
 * a time nothing honours — exactly backwards.
 */
test('a mirror an operator switched ON is corrected too, because the field is inert', async () => {
  store.rows.set('MIRROR_A006', {
    ...DEFAULT_STRATEGY,
    tag: 'MIRROR_A006',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    autostartAt: LEGACY_MIRROR_AUTOSTART,
    updatedAt: 1,
  })
  await seedHostedStrategies(store, NOW, log)
  assert.equal(store.rows.get('MIRROR_A006')?.autostartAt, '')
  assert.equal(
    isOn(store.rows.get('MIRROR_A006')?.modes ?? {}, 'paper'),
    true,
    'and the switch itself is untouched',
  )
})

test('a NON-mirror row keeping 0914 is never touched', async () => {
  // The repair is scoped to MIRROR_* on purpose: 0914 is a legitimate time for
  // anything the Runner supervises, and the seed's own value is authoritative.
  store.rows.set('BN_BREAKOUT', {
    ...DEFAULT_STRATEGY,
    tag: 'BN_BREAKOUT',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    autostartAt: LEGACY_MIRROR_AUTOSTART,
    updatedAt: 1,
  })
  await seedHostedStrategies(store, NOW, log)
  assert.equal(store.rows.get('BN_BREAKOUT')?.autostartAt, LEGACY_MIRROR_AUTOSTART)
})

/**
 * The premium sellers' seeded '' is corrected to 0918 on a deployment that
 * already has it — including rows an operator has switched ON, because the
 * bell-entry is the behaviour being retired and it lives precisely on the
 * rows in use. Unlike the mirrors' repair this one changes what runs, and
 * that is the point.
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

test("a mirror's '' is NOT dragged to 0918 — the bell repair is scoped to the sellers", async () => {
  // MIRROR_* keeps '' by design: a mirror has no session and delaying one can
  // mirror an exit whose entry it never saw.
  store.rows.set('MIRROR_1PBUY', {
    ...DEFAULT_STRATEGY,
    tag: 'MIRROR_1PBUY',
    kind: 'hosted',
    modes: { paper: { enabled: false } },
    autostartAt: '',
    updatedAt: 1,
  })
  await seedHostedStrategies(store, NOW, log)
  assert.equal(store.rows.get('MIRROR_1PBUY')?.autostartAt, '')
})
