/**
 * The day guard: a per-strategy daily target and stop-loss, enforced here.
 *
 * MONGO-FREE. Every decision the guard makes — is the number past the line,
 * has today already fired, does this rail need a flatten of our own, may this
 * row be re-armed in the morning — is expressible against fakes, and each of
 * those decisions is one an operator would be furious to find wrong. The one
 * thing these cannot cover is the create-only insert itself; `GuardStore.claim`
 * is the seam, and `store-tag`/`server` cover the real unique index.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DayGuard,
  guardRecordId,
  guardNumber,
  guardTrigger,
  type DayGuardPorts,
  type GuardAction,
  type GuardRecord,
} from '../src/day-guard.ts'
import { DEFAULT_STRATEGY, type StrategyPatch, type StrategyRow } from '../src/strategies.ts'
import type { PnlRow, PnlSummary } from '../src/pnl-jobs.ts'
import type { DeskMode } from '../src/contract.ts'
import { DX, type VenueSpec } from '@algomaker/venue'

/** 2026-08-14 12:00 IST, a Friday inside the session. */
const NOW = Date.parse('2026-08-14T06:30:00.000Z')
const TODAY = '2026-08-14'
const YESTERDAY = '2026-08-13'

const row = (over: Partial<StrategyRow> = {}): StrategyRow => ({
  ...DEFAULT_STRATEGY,
  tag: 'ORB_SCALP_BN',
  kind: 'hosted',
  label: 'ORB scalp',
  modes: { paper: { enabled: true } },
  updatedAt: 1_000,
  ...over,
})

const pnlRow = (over: Partial<PnlRow> = {}): PnlRow => ({
  tag: 'ORB_SCALP_BN',
  label: 'ORB scalp',
  mode: 'paper',
  realised: 0,
  gross: 0,
  fees: 0,
  unrealised: 0,
  total: 0,
  openLegs: 0,
  legs: [],
  unpriced: [],
  complete: true,
  ...over,
})

const summary = (mode: DeskMode, strategies: readonly PnlRow[]): PnlSummary => ({
  asOf: NOW,
  mode,
  strategies,
  totals: { realised: 0, unrealised: 0, total: 0, complete: true },
  truncated: false,
})

interface Harness {
  readonly ports: DayGuardPorts
  readonly guard: DayGuard
  readonly records: Map<string, GuardRecord>
  readonly logs: { msg: string; ctx?: Record<string, unknown> }[]
  readonly patches: { tag: string; patch: StrategyPatch; expected: number }[]
  readonly flattens: { tag: string; mode: DeskMode; decisionId: string; style: string; sinceMs?: number }[]
  readonly journalled: Record<string, unknown>[]
  rows: StrategyRow[]
}

function harness(input: {
  rows: readonly StrategyRow[]
  pnl?: Partial<Record<DeskMode, readonly PnlRow[]>>
  runtimeHost?: (tag: string, mode: DeskMode) => 'runner' | 'mirror' | null
  /** `undefined` falls through to the fake's own merge. */
  patchResult?: (attempt: number) => StrategyRow | null | 'conflict' | undefined
  now?: () => number
  venue?: VenueSpec
}): Harness {
  const records = new Map<string, GuardRecord>()
  const logs: { msg: string; ctx?: Record<string, unknown> }[] = []
  const patches: { tag: string; patch: StrategyPatch; expected: number }[] = []
  const flattens: { tag: string; mode: DeskMode; decisionId: string; style: string; sinceMs?: number }[] = []
  const journalled: Record<string, unknown>[] = []
  const state = { rows: [...input.rows] }
  let attempt = 0

  const ports: DayGuardPorts = {
    ...(input.venue === undefined ? {} : { venue: input.venue }),
    now: input.now ?? ((): number => NOW),
    log: (msg, ctx) => {
      logs.push(ctx === undefined ? { msg } : { msg, ctx })
    },
    listStrategies: async () => state.rows,
    loadStrategy: async (tag) => state.rows.find((r) => r.tag === tag) ?? null,
    pnl: async (mode) => summary(mode, input.pnl?.[mode] ?? []),
    patchStrategy: async (tag, patch, expected) => {
      patches.push({ tag, patch, expected })
      attempt++
      const forced = input.patchResult?.(attempt)
      if (forced !== undefined) return forced
      const current = state.rows.find((r) => r.tag === tag)
      if (current === undefined) return null
      // Enough of the real merge for these tests: the switch, the stamp and the
      // limits. `applyStrategyPatch` is proved on its own in strategies.test.ts.
      const modes = { ...current.modes }
      for (const m of ['paper', 'live'] as const) {
        const next = patch.modes?.[m]
        if (next !== undefined && modes[m] !== undefined) modes[m] = { enabled: next.enabled }
      }
      const stamps: Record<string, unknown> = { ...(current.disabledByGuard ?? {}) }
      for (const m of ['paper', 'live'] as const) {
        const stated = patch.disabledByGuard?.[m]
        if (stated === undefined) continue
        if (stated === null) delete stamps[m]
        else stamps[m] = stated
      }
      const updated: StrategyRow = {
        ...current,
        modes,
        updatedAt: current.updatedAt + 1,
        ...(Object.keys(stamps).length === 0 ? {} : { disabledByGuard: stamps }),
      }
      state.rows = state.rows.map((r) => (r.tag === tag ? updated : r))
      return updated
    },
    guards: {
      claim: async (record) => {
        if (records.has(record._id)) return false
        records.set(record._id, record)
        return true
      },
      appendAction: async (id: string, action: GuardAction) => {
        const existing = records.get(id)
        if (existing === undefined) return
        records.set(id, { ...existing, actions: [...existing.actions, action] })
      },
      today: async (day: string) => [...records.values()].filter((r) => r.day === day),
    },
    journal: async (events) => {
      journalled.push(...events)
    },
    runtimeHost: async (tag, mode) => input.runtimeHost?.(tag, mode) ?? null,
    flattenTag: async (params) => {
      flattens.push(params)
      return {
        decisionId: params.decisionId,
        replayed: false,
        flat: true,
        legs: [],
      }
    },
  }
  return {
    ports, guard: new DayGuard(ports), records, logs, patches, flattens, journalled,
    get rows() { return state.rows },
  }
}

// ------------------------------------------------------------- the arithmetic

test('guardNumber uses TOTAL when the row is complete', () => {
  assert.deepEqual(guardNumber(pnlRow({ realised: 100, unrealised: 50, total: 150 })), {
    value: 150,
    incomplete: false,
  })
})

test('guardNumber falls back to REALISED when the row is incomplete', () => {
  // An unpriced leg makes `total` null. The alternative — refusing to act — is
  // a stop-loss that stops working exactly when the feed does.
  assert.deepEqual(
    guardNumber(pnlRow({ realised: -4_000, unrealised: null, total: null, complete: false, unpriced: ['X'] })),
    { value: -4_000, incomplete: true },
  )
})

test('guardTrigger fires at the line, not past it', () => {
  assert.equal(guardTrigger({ target: 10_000 }, 9_999), null)
  assert.equal(guardTrigger({ target: 10_000 }, 10_000), 'target')
  assert.equal(guardTrigger({ stop: 3_000 }, -2_999), null)
  assert.equal(guardTrigger({ stop: 3_000 }, -3_000), 'stop')
  // The stop wins a tie it cannot actually have, and an unarmed side never fires.
  assert.equal(guardTrigger({ target: 10_000 }, -50_000), null)
  assert.equal(guardTrigger({ stop: 3_000 }, 50_000), null)
  assert.equal(guardTrigger(undefined, 50_000), null)
  assert.equal(guardTrigger({}, 50_000), null)
})

test('the record id is the tag, the rail AND the IST day', () => {
  assert.equal(guardRecordId('ORB_SCALP_BN', 'paper', TODAY), 'ORB_SCALP_BN|paper|2026-08-14')
})

// ------------------------------------------------------------------ tripping

test('a row past its TARGET is switched off, once, and stays off', async () => {
  const h = harness({
    rows: [row({ dailyLimits: { target: 10_000 } })],
    pnl: { paper: [pnlRow({ total: 12_500, realised: 12_500 })] },
    runtimeHost: () => 'runner',
  })

  await h.guard.runGuards(NOW)
  assert.equal(h.records.size, 1)
  const record = h.records.get(guardRecordId('ORB_SCALP_BN', 'paper', TODAY))
  assert.equal(record?.trigger, 'target')
  assert.equal(record?.pnlAtTrigger, 12_500)
  assert.equal(record?.incomplete, false)
  assert.equal(h.patches.length, 1)
  assert.deepEqual(h.patches[0]?.patch.modes, { paper: { enabled: false } })
  assert.deepEqual(h.patches[0]?.patch.disabledByGuard, {
    paper: { day: TODAY, trigger: 'target' },
  })

  // A SECOND PASS DOES NOTHING. The guard runs every ten seconds; without the
  // create-only claim it would re-switch-off (harmless) and re-flatten (not).
  await h.guard.runGuards(NOW + 10_000)
  assert.equal(h.records.size, 1)
  assert.equal(h.patches.length, 1, 'the switch is written once per tag, rail and day')
})

test('a row past its STOP is switched off, and the record says which line it crossed', async () => {
  const h = harness({
    rows: [row({ dailyLimits: { target: 10_000, stop: 3_000 } })],
    pnl: { paper: [pnlRow({ total: -3_100, realised: -3_100 })] },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(NOW)
  const record = h.records.get(guardRecordId('ORB_SCALP_BN', 'paper', TODAY))
  assert.equal(record?.trigger, 'stop')
  assert.equal(record?.pnlAtTrigger, -3_100)
})

test('an INCOMPLETE row is judged on realised, and the degradation is named ONCE a day', async () => {
  const h = harness({
    rows: [row({ dailyLimits: { stop: 3_000 } })],
    pnl: {
      paper: [pnlRow({ realised: -1_000, unrealised: null, total: null, complete: false, unpriced: ['BANKNIFTY26AUG54000CE'] })],
    },
    runtimeHost: () => 'runner',
  })

  await h.guard.runGuards(NOW)
  await h.guard.runGuards(NOW + 10_000)
  const degraded = h.logs.filter((l) => /realised/i.test(l.msg))
  assert.equal(degraded.length, 1, 'once a day, not every ten seconds')
  assert.match(degraded[0]?.msg ?? '', /day guard/i)
  assert.equal(degraded[0]?.ctx?.['tag'], 'ORB_SCALP_BN')
  // -1,000 has not crossed a 3,000 stop, so nothing fired.
  assert.equal(h.records.size, 0)
})

test('an incomplete row that DOES cross is recorded as incomplete', async () => {
  const h = harness({
    rows: [row({ dailyLimits: { stop: 3_000 } })],
    pnl: {
      paper: [pnlRow({ realised: -9_000, unrealised: null, total: null, complete: false, unpriced: ['X'] })],
    },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(NOW)
  const record = h.records.get(guardRecordId('ORB_SCALP_BN', 'paper', TODAY))
  assert.equal(record?.incomplete, true)
  assert.equal(record?.pnlAtTrigger, -9_000)
})

test('a row with NO limits is never read for P&L at all', async () => {
  let asked = 0
  const h = harness({ rows: [row()], pnl: { paper: [pnlRow({ total: 999_999 })] } })
  const ports: DayGuardPorts = {
    ...h.ports,
    pnl: async (mode) => {
      asked++
      return summary(mode, [])
    },
  }
  await new DayGuard(ports).runGuards(NOW)
  assert.equal(asked, 0, 'an unarmed desk must not cost a 30-day fill scan every ten seconds')
})

test('a rail that is switched OFF is not guarded — there is nothing left to stop', async () => {
  const h = harness({
    rows: [row({ modes: { paper: { enabled: false } }, dailyLimits: { target: 1 } })],
    pnl: { paper: [pnlRow({ total: 999_999 })] },
  })
  await h.guard.runGuards(NOW)
  assert.equal(h.records.size, 0)
})

test('the two rails are guarded INDEPENDENTLY against the same limits', async () => {
  const h = harness({
    rows: [
      row({
        modes: { paper: { enabled: true }, live: { enabled: true } },
        dailyLimits: { stop: 3_000 },
      }),
    ],
    pnl: {
      paper: [pnlRow({ mode: 'paper', total: -5_000, realised: -5_000 })],
      live: [pnlRow({ mode: 'live', total: 500, realised: 500 })],
    },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(NOW)
  assert.deepEqual([...h.records.keys()], [guardRecordId('ORB_SCALP_BN', 'paper', TODAY)])
  assert.deepEqual(h.patches[0]?.patch.modes, { paper: { enabled: false } })
})

// --------------------------------------------------------- who does the exit

test('a MIRROR is flattened by us, under a deterministic id', async () => {
  // `MirrorHost` deliberately never squares off — the upstream account owns the
  // exit — so switching a mirror off strands whatever it holds. Nothing else
  // will close it.
  const h = harness({
    rows: [row({ tag: 'MIRROR_A006', dailyLimits: { stop: 3_000 } })],
    pnl: { paper: [pnlRow({ tag: 'MIRROR_A006', total: -4_000, realised: -4_000 })] },
    runtimeHost: () => 'mirror',
  })
  await h.guard.runGuards(NOW)
  assert.deepEqual(h.flattens, [
    {
      tag: 'MIRROR_A006',
      mode: 'paper',
      decisionId: `daily-guard-MIRROR_A006-paper-${TODAY}`,
      style: 'limit',
      sinceMs: 0,
    },
  ])
})

test('the flatten reads EVERY fill that exists, not just today\'s', async () => {
  /**
   * MIRROR_A010, paper, 2026-09-07. The guard hit its ₹10,000 target, switched
   * the rail off and recorded `flattened (mirror: ...) — 2 leg(s), flat` — while
   * two legs, NIFTY 24050 CE and 24050 PE, stayed open. They had been opened on
   * an earlier session, so they contributed no fill to `flattenTag`'s default
   * one-IST-day window, never appeared in `buildPositions`, and were never
   * planned. The guard then reported FLAT over a position it had not read.
   *
   * The asymmetry is the bug: the number that FIRES the guard is the book's
   * carry-over P&L (`pnlFor` answers from `LiveBook`), so a leg opened days ago
   * can trip a limit that the day-bounded exit cannot then close. On 2026-09-04
   * the same tag recorded `0 leg(s), NOT flat` — it fired on P&L belonging
   * ENTIRELY to legs it could not see.
   *
   * `sinceMs: 0` is the same window `routes/books.ts` already gives the delete
   * guard's flatten, for the same reason and with the same comment. Reading too
   * much is safe: a closed round trip nets to zero and `planFlatten` drops it.
   */
  const h = harness({
    rows: [row({ tag: 'MIRROR_A010', dailyLimits: { target: 10_000 } })],
    pnl: { paper: [pnlRow({ tag: 'MIRROR_A010', total: 10_057.125, realised: -63 })] },
    runtimeHost: () => 'mirror',
  })
  await h.guard.runGuards(NOW)
  assert.equal(h.flattens[0]?.sinceMs, 0, 'the guard bounded its exit to one day')
})

test('a hosted RUNNER tag is NOT flattened here — the runner does it on switch-off', async () => {
  // Double-flattening is how one exit becomes two orders and a reversed
  // position. `runner.ts:#stopOne` is the tested path; this one stays out of it.
  const h = harness({
    rows: [row({ dailyLimits: { stop: 3_000 } })],
    pnl: { paper: [pnlRow({ total: -4_000, realised: -4_000 })] },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(NOW)
  assert.deepEqual(h.flattens, [])
  const record = h.records.get(guardRecordId('ORB_SCALP_BN', 'paper', TODAY))
  assert.ok(
    record?.actions.some((a) => a.step === 'flatten' && /runner/.test(a.note)),
    'the record still says who was expected to close it',
  )
})

test('NO runtime row at all is treated as mirror-unknown: we flatten, and say so', async () => {
  // A stopped runner cannot flatten anything. Leaving the position because we
  // could not identify the host is the one outcome with no upside.
  const h = harness({
    rows: [row({ dailyLimits: { stop: 3_000 } })],
    pnl: { paper: [pnlRow({ total: -4_000, realised: -4_000 })] },
    runtimeHost: () => null,
  })
  await h.guard.runGuards(NOW)
  assert.equal(h.flattens.length, 1)
  const record = h.records.get(guardRecordId('ORB_SCALP_BN', 'paper', TODAY))
  assert.ok(record?.actions.some((a) => a.step === 'flatten' && /unknown/.test(a.note)))
})

test('the switch-off is version-pinned and RETRIED when the row moves under it', async () => {
  let calls = 0
  const h = harness({
    rows: [row({ dailyLimits: { stop: 3_000 } })],
    pnl: { paper: [pnlRow({ total: -4_000, realised: -4_000 })] },
    runtimeHost: () => 'runner',
    patchResult: (attempt) => {
      calls = attempt
      return attempt === 1 ? 'conflict' : undefined
    },
  })
  await h.guard.runGuards(NOW)
  assert.equal(calls >= 2, true, 'a conflict is re-read and re-applied, not dropped')
  assert.equal(h.patches[0]?.expected, 1_000, 'the write pins the version it decided against')
  const record = h.records.get(guardRecordId('ORB_SCALP_BN', 'paper', TODAY))
  assert.ok(record?.actions.some((a) => a.step === 'switch-off' && a.note === 'off'))
})

test('the switch-off patch touches the switch and the stamp, and NOTHING else', async () => {
  const h = harness({
    rows: [row({ liveLots: 4, autostartAt: '0918', dailyLimits: { stop: 3_000 } })],
    pnl: { paper: [pnlRow({ total: -4_000, realised: -4_000 })] },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(NOW)
  assert.deepEqual(Object.keys(h.patches[0]?.patch ?? {}).sort(), ['disabledByGuard', 'modes'])
})

// ------------------------------------------------------------ morning re-arm

test('PAPER disabled by the guard YESTERDAY is re-armed, and the stamp is cleared', async () => {
  const h = harness({
    rows: [
      row({
        modes: { paper: { enabled: false } },
        dailyLimits: { stop: 3_000 },
        disabledByGuard: { paper: { day: YESTERDAY, trigger: 'stop' } },
      }),
    ],
  })
  const rearmed = await h.guard.rearm(NOW)
  assert.deepEqual(rearmed, ['ORB_SCALP_BN'])
  assert.deepEqual(h.patches[0]?.patch, {
    modes: { paper: { enabled: true } },
    disabledByGuard: { paper: null },
  })
})

test("a row the OPERATOR switched off is never re-armed — no stamp, no re-arm", async () => {
  const h = harness({
    rows: [
      row({
        modes: { paper: { enabled: false } },
        dailyLimits: { stop: 3_000 },
        disabledReason: 'misfiring on gap days',
      }),
    ],
  })
  assert.deepEqual(await h.guard.rearm(NOW), [])
  assert.equal(h.patches.length, 0)
})

test('TODAY’s stamp is not re-armed — the day it stopped for is not over', async () => {
  const h = harness({
    rows: [
      row({
        modes: { paper: { enabled: false } },
        disabledByGuard: { paper: { day: TODAY, trigger: 'stop' } },
      }),
    ],
  })
  assert.deepEqual(await h.guard.rearm(NOW), [])
})

test('LIVE is NEVER auto-re-armed, even with the guard’s own stamp on it', async () => {
  // Auto-arming live would put real money back on the wire with nobody's
  // password behind it. The operator re-enables it with the badge in view.
  const h = harness({
    rows: [
      row({
        modes: { live: { enabled: false } },
        disabledByGuard: { live: { day: YESTERDAY, trigger: 'stop' } },
      }),
    ],
  })
  assert.deepEqual(await h.guard.rearm(NOW), [])
  assert.equal(h.patches.length, 0)
})

test('re-arm runs once a day, after 08:45 IST', async () => {
  const early = Date.parse('2026-08-14T03:00:00.000Z') // 08:30 IST
  const h = harness({
    rows: [
      row({
        modes: { paper: { enabled: false } },
        disabledByGuard: { paper: { day: YESTERDAY, trigger: 'stop' } },
      }),
    ],
  })
  assert.deepEqual(await h.guard.rearm(early), [], 'before 08:45 nothing moves')
  assert.deepEqual(await h.guard.rearm(NOW), ['ORB_SCALP_BN'])
  assert.deepEqual(await h.guard.rearm(NOW + 60_000), [], 'and not again the same day')
})

test('a tick both guards and re-arms, and never runs two passes at once', async () => {
  const h = harness({
    rows: [
      row({ dailyLimits: { target: 10_000 } }),
      row({
        tag: 'ATR_BAND_NIFTY',
        modes: { paper: { enabled: false } },
        disabledByGuard: { paper: { day: YESTERDAY, trigger: 'stop' } },
      }),
    ],
    pnl: { paper: [pnlRow({ total: 11_000, realised: 11_000 })] },
    runtimeHost: () => 'runner',
  })
  await Promise.all([h.guard.tick(NOW), h.guard.tick(NOW)])
  assert.equal(h.records.size, 1)
  assert.equal(h.patches.filter((p) => p.tag === 'ATR_BAND_NIFTY').length, 1)
})

test('a rail turned back ON after a trip is NOT stopped twice — and the log says so', async () => {
  // The record is the idempotency, so a rail an operator re-enables after a
  // trip runs unguarded for the rest of the day. That is the design; the one
  // thing that must not happen is it being invisible.
  const h = harness({
    rows: [row({ dailyLimits: { stop: 3_000 } })],
    pnl: { paper: [pnlRow({ total: -4_000, realised: -4_000 })] },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(NOW)
  assert.equal(h.patches.length, 1)

  // The operator switches it back on.
  await h.ports.patchStrategy('ORB_SCALP_BN', { modes: { paper: { enabled: true } } }, 1_001)
  await h.guard.runGuards(NOW + 10_000)
  await h.guard.runGuards(NOW + 20_000)

  assert.equal(h.patches.filter((p) => p.patch.disabledByGuard !== undefined).length, 1)
  const warned = h.logs.filter((l) => /unguarded until tomorrow/.test(l.msg))
  assert.equal(warned.length, 1, 'said once, not every ten seconds')
})

test('the trip lands in the ORDER FEED, stamped with its rail', async () => {
  // "Why did nothing trade this afternoon?" has to be answerable from the
  // portal. A stop that leaves only a log line on a box is the same failure a
  // switched-off strategy's journalled refusals exist to prevent — and an event
  // with no `detail.mode` is read as LIVE, which would file a paper stop under
  // the live log.
  const h = harness({
    rows: [row({ dailyLimits: { stop: 3_000 } })],
    pnl: { paper: [pnlRow({ total: -3_400, realised: -3_400 })] },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(NOW)
  assert.equal(h.journalled.length, 1)
  const event = h.journalled[0] as Record<string, unknown>
  assert.equal(event['tag'], 'ORB_SCALP_BN')
  assert.equal(event['ok'], false)
  assert.equal(event['clientOrderId'], `daily-guard-ORB_SCALP_BN-paper-${TODAY}`)
  assert.deepEqual((event['detail'] as Record<string, unknown>)['mode'], 'paper')
  assert.match(String(event['error']), /daily stop-loss of ₹3,000/)
  assert.match(String(event['error']), /switched off for paper for the rest of 2026-08-14/)

  // Once, like everything else here.
  await h.guard.runGuards(NOW + 10_000)
  assert.equal(h.journalled.length, 1)
})

// ------------------------------------------------------- DX: the settlement day

/**
 * On Delta the day is the settlement cycle: 12:00 UTC to 12:00 UTC. An IST
 * midnight day would split one expiry cycle, and an 08:45 IST re-arm would sit
 * a stopped paper book out of hours of a market that never closes.
 */
test('DX: the guard keys 2026-11-04 at 12:00:00Z, and 2026-11-03 one second before', async () => {
  const before = Date.parse('2026-11-03T11:59:59.000Z')
  const at = Date.parse('2026-11-03T12:00:00.000Z')
  const mk = (): Harness =>
    harness({
      venue: DX,
      rows: [row({ dailyLimits: { stop: 250 } })],
      pnl: { paper: [pnlRow({ total: -300, realised: -300 })] },
      runtimeHost: () => 'runner',
    })
  const h1 = mk()
  await h1.guard.runGuards(before)
  assert.ok(h1.records.has(guardRecordId('ORB_SCALP_BN', 'paper', '2026-11-03')))
  const h2 = mk()
  await h2.guard.runGuards(at)
  assert.ok(h2.records.has(guardRecordId('ORB_SCALP_BN', 'paper', '2026-11-04')))
  assert.deepEqual(h2.patches[0]?.patch.disabledByGuard, {
    paper: { day: '2026-11-04', trigger: 'stop' },
  })
})

test('DX: a paper rail stopped in one settlement day re-arms right after the next 12:00 UTC', async () => {
  const h = harness({
    venue: DX,
    rows: [
      row({
        modes: { paper: { enabled: false } },
        disabledByGuard: { paper: { day: '2026-11-04', trigger: 'stop' } },
      }),
    ],
  })
  // 20:00 IST on 3 Nov is still the day that settles at 12:00 UTC on 4 Nov.
  assert.deepEqual(await h.guard.rearm(Date.parse('2026-11-03T14:30:00.000Z')), [])
  assert.deepEqual(await h.guard.rearm(Date.parse('2026-11-04T11:59:59.000Z')), [])
  // 12:00:30 UTC: a new day, no 08:45 IST wait.
  assert.deepEqual(await h.guard.rearm(Date.parse('2026-11-04T12:00:30.000Z')), ['ORB_SCALP_BN'])
})

test('DX: the trip in the order feed is in dollars', async () => {
  const h = harness({
    venue: DX,
    rows: [row({ dailyLimits: { stop: 250 } })],
    pnl: { paper: [pnlRow({ total: -312.5, realised: -312.5 })] },
    runtimeHost: () => 'runner',
  })
  await h.guard.runGuards(Date.parse('2026-11-03T14:30:00.000Z'))
  const msg = String(h.journalled[0]?.['error'])
  assert.match(msg, /of \$250\.00 at -\$312\.50/)
})
