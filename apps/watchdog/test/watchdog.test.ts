/**
 * THE WATCHDOG: the one process that looks at the desk from outside and at
 * Delta directly. Alerts when a desk process is down while Delta shows
 * positions, cancels the desk's non-stop working orders when the gateway is
 * gone (the job the retired dead-man switch did), flattens the LIVE account
 * after a long outage, and checks every short leg has its exchange backstop.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backstopClientOrderId, type DxOrder, type DxPosition } from '@algomaker/dx'
import { createWatchdog, watchdogConfigFromEnv, type HealthReading, type WatchdogAlert, type WatchdogRest } from '../src/watchdog.ts'

const CE = 'C-BTC-77000-131126'

function fakeRest(state: { positions: DxPosition[]; open: DxOrder[] }) {
  const calls: string[] = []
  const rest: WatchdogRest = {
    positions: async () => state.positions,
    openOrders: async () => state.open,
    cancelAllOrders: async (b) => { calls.push(`cancelAll:${JSON.stringify(b)}`) },
    closeAllPositions: async () => { calls.push('closeAll'); return {} },
  }
  return { rest, calls }
}

const short = (size = -20): DxPosition => ({ product_id: 11, product_symbol: CE, size, entry_price: '2000' })
const backstop = (size = 20): DxOrder => ({
  id: 1, product_id: 11, product_symbol: CE, size, unfilled_size: size, side: 'buy', state: 'pending', reduce_only: true,
  stop_order_type: 'stop_loss_order', client_order_id: backstopClientOrderId('live', 'T', CE),
})
const entry: DxOrder = { id: 2, product_id: 11, product_symbol: CE, size: 5, unfilled_size: 5, side: 'sell', state: 'open', reduce_only: false, client_order_id: 'hdesk' }

const OK: HealthReading[] = [
  { component: 'dx-gateway', healthy: true, detail: '' },
  { component: 'dx-supervisor', healthy: true, detail: '' },
]
const GATEWAY_DOWN: HealthReading[] = [
  { component: 'dx-gateway', healthy: false, detail: 'heartbeat 120s old' },
  { component: 'dx-supervisor', healthy: true, detail: '' },
]
const SUPERVISOR_DOWN: HealthReading[] = [
  { component: 'dx-gateway', healthy: true, detail: '' },
  { component: 'dx-supervisor', healthy: false, detail: 'lease expired' },
]

function harness(opts: {
  health: () => HealthReading[]
  live?: ReturnType<typeof fakeRest> | null
  demo?: ReturnType<typeof fakeRest> | null
  env?: Record<string, string>
}) {
  let now = 1_000_000
  const alerts: WatchdogAlert[] = []
  const wd = createWatchdog({
    readHealth: async () => opts.health(),
    rails: [
      { rail: 'live', rest: async () => opts.live?.rest ?? null },
      { rail: 'demo', rest: async () => opts.demo?.rest ?? null },
    ],
    alert: (a) => alerts.push(a),
    log: () => {},
    now: () => now,
    config: watchdogConfigFromEnv(opts.env ?? {}),
  })
  return {
    wd,
    alerts,
    at: async (sec: number) => {
      now = 1_000_000 + sec * 1000
      await wd.tick()
    },
  }
}

test('config: alert 30 s, flatten 300 s on live, demo alert-only, 0 switches flatten off', () => {
  const c = watchdogConfigFromEnv({})
  assert.equal(c.alertAfterMs, 30_000)
  assert.equal(c.flattenAfterMs, 300_000)
  assert.equal(c.flattenDemo, false)
  assert.equal(watchdogConfigFromEnv({ DX_WATCHDOG_FLATTEN_S: '0' }).flattenAfterMs, 0)
  assert.equal(watchdogConfigFromEnv({ DX_WATCHDOG_FLATTEN_DEMO: '1' }).flattenDemo, true)
  assert.throws(() => watchdogConfigFromEnv({ DX_WATCHDOG_ALERT_S: 'soon' }), /DX_WATCHDOG_ALERT_S/)
})

test('a healthy desk: no alert, nothing cancelled, nothing flattened — whatever Delta holds', async () => {
  const live = fakeRest({ positions: [short()], open: [backstop(), entry] })
  const h = harness({ health: () => OK, live })
  for (const s of [0, 100, 400, 1000]) await h.at(s)
  assert.deepEqual(h.alerts, [])
  assert.deepEqual(live.calls, [])
})

test('a desk process down with Delta positions: critical after 30 s, not before', async () => {
  const live = fakeRest({ positions: [short()], open: [backstop()] })
  const h = harness({ health: () => SUPERVISOR_DOWN, live })
  await h.at(0)
  await h.at(20)
  assert.equal(h.alerts.length, 0)
  await h.at(31)
  assert.equal(h.alerts.length, 1)
  assert.equal(h.alerts[0]?.severity, 'critical')
  assert.equal(h.alerts[0]?.mode, 'live')
  assert.match(h.alerts[0]?.message ?? '', /dx-supervisor/)
})

test('down with NO positions: no alert (nothing at risk)', async () => {
  const live = fakeRest({ positions: [], open: [] })
  const h = harness({ health: () => SUPERVISOR_DOWN, live })
  await h.at(0)
  await h.at(60)
  assert.deepEqual(h.alerts.filter((a) => a.severity === 'critical'), [])
})

test('gateway down > 30 s: the desk\'s non-stop working orders are cancelled, stops and reduce-only kept — once per outage', async () => {
  const live = fakeRest({ positions: [short()], open: [backstop(), entry] })
  const h = harness({ health: () => GATEWAY_DOWN, live })
  await h.at(0)
  await h.at(31)
  await h.at(45)
  const cancels = live.calls.filter((c) => c.startsWith('cancelAll'))
  assert.equal(cancels.length, 1)
  assert.deepEqual(JSON.parse(cancels[0]!.slice('cancelAll:'.length)), {
    contract_types: 'call_options,put_options',
    cancel_limit_orders: true,
    cancel_stop_orders: false,
    cancel_reduce_only_orders: false,
  })
})

test('a supervisor outage alone cancels nothing: the gateway is still working its orders', async () => {
  const live = fakeRest({ positions: [short()], open: [backstop(), entry] })
  const h = harness({ health: () => SUPERVISOR_DOWN, live })
  await h.at(0)
  await h.at(100)
  assert.deepEqual(live.calls, [])
})

test('LIVE outage past DX_WATCHDOG_FLATTEN_S: cancel non-stop orders, close_all, alert — once', async () => {
  const live = fakeRest({ positions: [short()], open: [backstop()] })
  const h = harness({ health: () => SUPERVISOR_DOWN, live })
  await h.at(0)
  await h.at(299)
  assert.equal(live.calls.length, 0)
  await h.at(301)
  assert.equal(live.calls.filter((c) => c === 'closeAll').length, 1)
  const i = live.calls.indexOf('closeAll')
  assert.ok(live.calls.slice(0, i).some((c) => c.startsWith('cancelAll')), 'orders cancelled before close_all')
  assert.ok(h.alerts.some((a) => /FLATTEN/i.test(a.message) && a.severity === 'critical'))
  await h.at(320)
  assert.equal(live.calls.filter((c) => c === 'closeAll').length, 1, 'never a second close_all in one outage')
})

test('recovery resets the outage clock', async () => {
  let health = SUPERVISOR_DOWN
  const live = fakeRest({ positions: [short()], open: [backstop()] })
  const h = harness({ health: () => health, live })
  await h.at(0)
  await h.at(200)
  health = OK
  await h.at(210)
  health = SUPERVISOR_DOWN
  await h.at(220)
  await h.at(400) // 180 s into the second outage
  assert.equal(live.calls.filter((c) => c === 'closeAll').length, 0)
})

test('flatten 0 = off; the demo account is alert-only unless DX_WATCHDOG_FLATTEN_DEMO=1', async () => {
  const live = fakeRest({ positions: [short()], open: [backstop()] })
  const off = harness({ health: () => SUPERVISOR_DOWN, live, env: { DX_WATCHDOG_FLATTEN_S: '0' } })
  await off.at(0)
  await off.at(1000)
  assert.deepEqual(live.calls, [])

  const demo = fakeRest({ positions: [short()], open: [] })
  const d = harness({ health: () => SUPERVISOR_DOWN, demo })
  await d.at(0)
  await d.at(1000)
  assert.deepEqual(demo.calls, [])
  assert.ok(d.alerts.some((a) => a.mode === 'paper' && a.severity === 'critical'))

  const demo2 = fakeRest({ positions: [short()], open: [] })
  const d2 = harness({ health: () => SUPERVISOR_DOWN, demo: demo2, env: { DX_WATCHDOG_FLATTEN_DEMO: '1' } })
  await d2.at(0)
  await d2.at(301)
  assert.ok(demo2.calls.includes('closeAll'))
})

test('a short leg without its backstop is alerted after the grace period (live critical)', async () => {
  const live = fakeRest({ positions: [short(-20)], open: [backstop(5)] })
  const h = harness({ health: () => OK, live })
  await h.at(0)
  await h.at(30)
  assert.equal(h.alerts.length, 0)
  await h.at(61)
  assert.equal(h.alerts.length, 1)
  assert.equal(h.alerts[0]?.severity, 'critical')
  assert.match(h.alerts[0]?.message ?? '', /15 of 20/)
})

test('a fully covered leg is not alerted; DX_BACKSTOP=0 turns the check off', async () => {
  const live = fakeRest({ positions: [short(-20)], open: [backstop(20)] })
  const h = harness({ health: () => OK, live })
  await h.at(0)
  await h.at(100)
  assert.equal(h.alerts.length, 0)
  const bare = fakeRest({ positions: [short(-20)], open: [] })
  const off = harness({ health: () => OK, live: bare, env: { DX_BACKSTOP: '0' } })
  await off.at(0)
  await off.at(100)
  assert.equal(off.alerts.length, 0)
})

test('Delta unreadable: alerted, nothing acted on', async () => {
  const rest: WatchdogRest = {
    positions: async () => { throw new Error('503') },
    openOrders: async () => [],
    cancelAllOrders: async () => { throw new Error('must not be called') },
    closeAllPositions: async () => { throw new Error('must not be called') },
  }
  const h = harness({ health: () => SUPERVISOR_DOWN, live: { rest, calls: [] } })
  await h.at(0)
  await h.at(400)
  assert.ok(h.alerts.some((a) => /unreadable/i.test(a.message)))
})

test('the health read itself failing is an unhealthy desk, never a throw', async () => {
  const live = fakeRest({ positions: [short()], open: [backstop()] })
  const h = harness({ health: () => { throw new Error('mongo gone') }, live })
  await h.at(0)
  await h.at(31)
  assert.ok(h.alerts.some((a) => a.severity === 'critical'))
})
