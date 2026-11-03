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
  await h.guard.observe(OFF)
  assert.deepEqual(h.halts, [], 'one pass is not two')
  assert.equal(h.alerts.at(-1)?.severity, 'warn')
  await h.guard.observe(OFF)
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
  await h.guard.observe(OFF)
  assert.equal(h.halts.length, 1)
})

test('an agreeing pass between two mismatches resets the count', async () => {
  const h = harness()
  await h.guard.observe(OFF)
  await h.guard.observe(AGREE)
  await h.guard.observe(OFF)
  assert.deepEqual(h.halts, [])
  await h.guard.observe(OFF)
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
  await g.guard.observe(OFF)
  await g.guard.observe(NO_SNAPSHOT)
  await g.guard.observe(OFF)
  assert.equal(g.halts.length, 1)
})

test('no verdict on a rail where the desk holds nothing, or on the simulator, raises nothing', async () => {
  const h = harness()
  await h.guard.observe(report([], { comparable: false, reason: 'no broker snapshot' }))
  await h.guard.observe(report([sym('C-BTC-80000-041126', -50, null)], { comparable: false, reason: SIMULATOR_NO_COMPARE }))
  assert.deepEqual(h.alerts, [])
})

test('DEMO: a mismatch alerts but never halts — the demo keeps testing', async () => {
  const h = harness('demo')
  for (let i = 0; i < 4; i++) await h.guard.observe({ ...OFF, mode: 'paper', rail: 'demo' })
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
  await guard.observe(OFF)
  await guard.observe(OFF)
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
