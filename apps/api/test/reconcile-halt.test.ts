/**
 * THE EXCHANGE RECONCILIATION HALT (lane A, 3 Nov) — `../src/reconcile-halt.ts`.
 *
 * Live: the desk and Delta disagree on any contract for 2 consecutive passes
 * → new opens halted on the LIVE rail (a live-scoped kill switch; closes still
 * go) and a critical alert naming the contracts. Released by the operator
 * only. Demo: alert only. No verdict (missing / stale snapshot) is never a
 * mismatch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeskAlert } from '@algomaker/core'
import { ReconcileHalt } from '../src/reconcile-halt.ts'
import { SIMULATOR_NO_COMPARE, type PositionsCompareReport, type SymbolCompare } from '../src/positions-compare.ts'
import { DEFAULT_KILL_SWITCH, haltApplies, killSwitchUpdate, type KillSwitchState } from '../src/safety.ts'
import { splitByKillSwitch } from '../src/decision-plan.ts'
import { screenSubmitGates } from '../src/submit-plan.ts'

const T0 = Date.UTC(2026, 10, 3, 10, 0)

const sym = (symbol: string, desk: number, broker: number | null): SymbolCompare => ({
  symbol,
  broker,
  books: desk,
  ledger: 0,
  agree: broker === null || broker === desk,
  claimedBy: ['BTC-bull-s'],
})

function report(symbols: SymbolCompare[], over: Partial<PositionsCompareReport> = {}): PositionsCompareReport {
  return {
    asOf: T0,
    day: '2026-11-03',
    mode: 'live',
    comparable: true,
    reason: '',
    brokerAsOf: T0 - 5_000,
    symbols,
    divergent: symbols.filter((s) => !s.agree).map((s) => s.symbol),
    unattributable: [],
    unmeasurable: [],
    intervalMs: 300_000,
    ...over,
  }
}

/**
 * Pass `n`, reading ITS OWN broker snapshot (the gateway rewrites it every
 * 30 s). Consecutive passes are consecutive snapshots: the same report handed
 * over twice is one read of one snapshot, not two passes.
 */
const at = (r: PositionsCompareReport, n: number): PositionsCompareReport => ({
  ...r,
  asOf: T0 + n * 60_000,
  brokerAsOf: T0 - 5_000 + n * 30_000,
})

const AGREE = report([sym('C-BTC-80000-041126', -50, -50)])
const OFF = report([sym('C-BTC-80000-041126', -50, -30), sym('P-BTC-80000-041126', -50, -50)])
const NO_SNAPSHOT = report([sym('C-BTC-80000-041126', -50, null)], {
  comparable: false,
  reason: 'the broker snapshot is 900s old (max 300s): no verdict',
})

function harness(rail: 'live' | 'demo' = 'live', halted = false) {
  const alerts: DeskAlert[] = []
  const halts: string[] = []
  const guard = new ReconcileHalt(
    {
      alert: (a) => alerts.push(a),
      halt: async (reason) => {
        halts.push(reason)
        return halted ? 'already' : 'engaged'
      },
      log: () => {},
    },
    rail,
  )
  return { guard, alerts, halts }
}

test('LIVE: one mismatched pass warns; the second consecutive one halts opens and raises a critical alert naming the contracts', async () => {
  const h = harness()
  await h.guard.observe(at(OFF, 1))
  assert.deepEqual(h.halts, [], 'one pass is not two')
  assert.equal(h.alerts.at(-1)?.severity, 'warn')
  await h.guard.observe(at(OFF, 2))
  assert.equal(h.halts.length, 1)
  assert.match(h.halts[0] ?? '', /C-BTC-80000-041126/)
  const crit = h.alerts.filter((a) => a.severity === 'critical')
  assert.equal(crit.length, 1)
  assert.equal(crit[0]?.mode, 'live')
  assert.equal(crit[0]?.source, 'api')
  assert.match(crit[0]?.message ?? '', /C-BTC-80000-041126: desk -50 vs exchange -30/)
  assert.doesNotMatch(crit[0]?.message ?? '', /P-BTC-80000-041126/, 'only the contracts that differ')
  // A third pass of the SAME mismatch does not engage the halt again (the
  // operator may have released it on purpose); the alert repeats (the sink dedupes).
  await h.guard.observe(at(OFF, 3))
  assert.equal(h.halts.length, 1)
})

test('an agreeing pass between two mismatches resets the count', async () => {
  const h = harness()
  await h.guard.observe(at(OFF, 1))
  await h.guard.observe(at(AGREE, 2))
  await h.guard.observe(at(OFF, 3))
  assert.deepEqual(h.halts, [])
  await h.guard.observe(at(OFF, 4))
  assert.equal(h.halts.length, 1)
})

test('a missing or stale snapshot is NOT a mismatch: a warn, and the count neither moves nor resets', async () => {
  const h = harness()
  await h.guard.observe(NO_SNAPSHOT)
  await h.guard.observe(NO_SNAPSHOT)
  assert.deepEqual(h.halts, [])
  const warn = h.alerts.filter((a) => a.severity === 'warn')
  assert.equal(warn.length, 2)
  assert.match(warn[0]?.message ?? '', /no verdict/)
  assert.equal(h.alerts.some((a) => a.severity === 'critical'), false)
  // No verdict says nothing either way: a mismatch, a blind pass, a mismatch is still two.
  const g = harness()
  await g.guard.observe(at(OFF, 1))
  await g.guard.observe(NO_SNAPSHOT)
  await g.guard.observe(at(OFF, 2))
  assert.equal(g.halts.length, 1)
})

test('a pass whose only disagreement is a fill in flight neither moves nor resets the count, and raises nothing', async () => {
  // The leg traded after the snapshot was read: no verdict on it this pass.
  const IN_FLIGHT = report([
    { ...sym('C-BTC-80000-041126', -50, null), inFlight: true },
    sym('P-BTC-80000-041126', -50, -50),
  ])
  assert.deepEqual(IN_FLIGHT.divergent, [])
  const quiet = harness()
  await quiet.guard.observe(at(IN_FLIGHT, 1))
  await quiet.guard.observe(at(IN_FLIGHT, 2))
  assert.deepEqual(quiet.halts, [])
  assert.deepEqual(quiet.alerts, [])
  // A real mismatch, the same leg in flight, the mismatch again: still two passes.
  const h = harness()
  await h.guard.observe(at(OFF, 1))
  await h.guard.observe(at(IN_FLIGHT, 2))
  await h.guard.observe(at(OFF, 3))
  assert.equal(h.halts.length, 1)
})

test('two reads of ONE broker snapshot are one pass, not two (4 Nov 15:01:19)', async () => {
  // The mirror sync's pass and the minute's pass ran 55 ms apart on the same
  // 15:00:56 snapshot: a WARN, then "2 consecutive passes" and a halt that
  // stopped the call leg of a straddle whose put had already gone.
  const h = harness()
  await h.guard.observe(at(OFF, 1))
  await h.guard.observe({ ...at(OFF, 1), asOf: T0 + 60_055 })
  assert.deepEqual(h.halts, [], 'the same snapshot read twice is one sighting')
  assert.equal(h.alerts.some((a) => a.severity === 'critical'), false)
  // The NEXT snapshot still showing it is the second pass.
  await h.guard.observe(at(OFF, 2))
  assert.equal(h.halts.length, 1)
})

test('a different leg on each pass is not a persisting mismatch (4 Nov 14:40 → 14:41)', async () => {
  const X = 'C-BTC-78800-051126'
  const Y = 'C-BTC-79000-051126'
  const h = harness()
  // 14:40:19 — the 78800 legs, opened after the snapshot.
  await h.guard.observe(at(report([sym(X, -0.04, 0)]), 1))
  // 14:41:19 — 78800 now agrees; the 79000 legs, opened after THIS snapshot.
  await h.guard.observe(at(report([sym(X, -0.04, -0.04), sym(Y, -0.05, 0)]), 2))
  assert.deepEqual(h.halts, [], 'no contract was wrong on two passes')
  assert.equal(h.alerts.some((a) => a.severity === 'critical'), false)
  // Y wrong on the next snapshot as well: that one persists.
  await h.guard.observe(at(report([sym(X, -0.04, -0.04), sym(Y, -0.05, 0)]), 3))
  assert.equal(h.halts.length, 1)
  assert.match(h.halts[0] ?? '', /C-BTC-79000-051126/)
  assert.doesNotMatch(h.halts[0] ?? '', /C-BTC-78800-051126/)
})

test('a leg wrong on both passes halts, and the halt names only the legs that persisted', async () => {
  const X = 'C-BTC-80000-041126'
  const Y = 'P-BTC-80000-041126'
  const Z = 'C-BTC-81000-041126'
  const h = harness()
  await h.guard.observe(at(report([sym(X, -50, -30), sym(Y, -50, -20)]), 1))
  await h.guard.observe(at(report([sym(X, -50, -30), sym(Y, -50, -50), sym(Z, -10, 0)]), 2))
  assert.equal(h.halts.length, 1)
  assert.match(h.halts[0] ?? '', /C-BTC-80000-041126: desk -50 vs exchange -30/)
  assert.doesNotMatch(h.halts[0] ?? '', /P-BTC-80000-041126/, 'Y agreed on the second pass')
  assert.doesNotMatch(h.halts[0] ?? '', /C-BTC-81000-041126/, 'Z has been wrong on one pass only')
  const crit = h.alerts.filter((a) => a.severity === 'critical')
  assert.equal(crit.length, 1)
  assert.match(crit[0]?.message ?? '', /C-BTC-80000-041126/)
})

test('no verdict on a rail where the desk holds nothing, or on the simulator, raises nothing', async () => {
  const h = harness()
  await h.guard.observe(report([], { comparable: false, reason: 'no broker snapshot' }))
  await h.guard.observe(report([sym('C-BTC-80000-041126', -50, null)], { comparable: false, reason: SIMULATOR_NO_COMPARE }))
  assert.deepEqual(h.alerts, [])
})

test('DEMO: a mismatch alerts but never halts — the demo keeps testing', async () => {
  const h = harness('demo')
  for (let i = 0; i < 4; i++) await h.guard.observe({ ...at(OFF, i + 1), mode: 'paper', rail: 'demo' })
  assert.deepEqual(h.halts, [])
  assert.ok(h.alerts.length > 0)
  assert.ok(h.alerts.every((a) => a.mode === 'paper' && a.severity !== 'critical'))
  assert.match(h.alerts[0]?.message ?? '', /C-BTC-80000-041126/)
})

test('a halt that throws still raises the critical alert, and says the halt failed', async () => {
  const alerts: DeskAlert[] = []
  const guard = new ReconcileHalt(
    { alert: (a) => alerts.push(a), halt: async () => Promise.reject(new Error('mongo down')), log: () => {} },
    'live',
  )
  await guard.observe(at(OFF, 1))
  await guard.observe(at(OFF, 2))
  const crit = alerts.filter((a) => a.severity === 'critical')
  assert.equal(crit.length, 1)
  assert.match(crit[0]?.message ?? '', /could NOT be engaged/)
})

// ── the live-scoped kill switch ─────────────────────────────────────────

const LIVE_HALT: KillSwitchState = { enabled: true, reason: 'reconcile', setBy: 'positions-compare', setAt: T0, scope: 'live' }

test('a LIVE-scoped halt blocks live opens only; paper trades on; an unscoped halt blocks both', () => {
  assert.equal(haltApplies(LIVE_HALT, 'live'), true)
  assert.equal(haltApplies(LIVE_HALT, 'paper'), false)
  const { scope: _scope, ...all } = LIVE_HALT
  void _scope
  assert.equal(haltApplies(all, 'paper'), true)
  assert.equal(haltApplies(DEFAULT_KILL_SWITCH, 'live'), false)

  const open = { op: 'open', ts: 'x', strike: 80_000, type: 'CE', side: 'Sell', qty: 50 } as never
  assert.equal(splitByKillSwitch({ halt: LIVE_HALT, actions: [open], book: [], mode: 'live' }).permitted.length, 0)
  assert.equal(splitByKillSwitch({ halt: LIVE_HALT, actions: [open], book: [], mode: 'paper' }).permitted.length, 1)

  const gate = (mode: 'paper' | 'live') =>
    screenSubmitGates({
      tag: 'T',
      mode,
      modes: { paper: { enabled: true }, live: { enabled: true } },
      halt: LIVE_HALT,
      liveTags: new Set(['T']),
    })
  assert.match(gate('live') ?? '', /kill switch/)
  assert.doesNotMatch(gate('paper') ?? '', /kill switch/)
})

test('saving an unscoped state UNSETS a stored scope — a release then a manual engage is never left live-only', () => {
  assert.deepEqual(killSwitchUpdate(LIVE_HALT), {
    $set: { enabled: true, reason: 'reconcile', setBy: 'positions-compare', setAt: T0, scope: 'live' },
  })
  assert.deepEqual(killSwitchUpdate({ enabled: false, reason: '', setBy: 'op', setAt: T0 }), {
    $set: { enabled: false, reason: '', setBy: 'op', setAt: T0 },
    $unset: { scope: '' },
  })
})
