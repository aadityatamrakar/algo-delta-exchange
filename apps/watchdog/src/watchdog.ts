/**
 * THE WATCHDOG'S DECISIONS — one `tick` every 10 s, pure apart from its ports.
 *
 * It reads the desk's health from outside (`health.ts`) and the account
 * straight from Delta with its own client, and does at most four things:
 *
 *   1. ALERT. Any desk process unhealthy for > DX_WATCHDOG_ALERT_S (30) while
 *      Delta shows open positions → `critical`.
 *   2. CANCEL THE DESK'S WORKING ORDERS when the GATEWAY has been unhealthy
 *      for > DX_WATCHDOG_CANCEL_S (30): `DELETE /v2/orders/all` for BTC
 *      options with `cancel_stop_orders: false` and
 *      `cancel_reduce_only_orders: false`. This is the job the dead-man switch
 *      did — retired because its cancel_orders also cancelled the stop orders
 *      (testnet, 3 Nov 2026). Stops and reduce-only exits stay: they can only
 *      shrink the position. Once per outage.
 *   3. FLATTEN the LIVE account after > DX_WATCHDOG_FLATTEN_S (300; 0 = off)
 *      of any outage: cancel the non-stop orders, then `close_all`, then
 *      alert. Once per outage; positions still there afterwards are alerted.
 *      The demo account only with DX_WATCHDOG_FLATTEN_DEMO=1.
 *   4. CHECK THE BACKSTOPS (unless DX_BACKSTOP=0): every short leg on Delta
 *      must be covered by reduce-only buy orders carrying the backstop id
 *      prefix; uncovered for > DX_WATCHDOG_BACKSTOP_GRACE_S (60) → alert
 *      (live `critical`, demo `warn`).
 *
 * NEVER while the desk is healthy: the outage clock is null exactly while
 * every reading is healthy, and resets on the first healthy tick.
 * NEVER THROWS: a failed read is an alert, not a crash.
 */
import { isBackstopOrderId, type DxOrder, type DxPosition, type DxRest } from '@algomaker/dx'

type Env = Readonly<Record<string, string | undefined>>

export interface HealthReading {
  readonly component: string
  readonly healthy: boolean
  readonly detail: string
}

export type WatchdogRest = Pick<DxRest, 'positions' | 'openOrders' | 'cancelAllOrders' | 'closeAllPositions'>

export interface WatchdogRailPort {
  readonly rail: 'live' | 'demo'
  /** The rail's client, or null when it is not configured (asked every tick; build lazily). */
  readonly rest: () => Promise<WatchdogRest | null>
}

export interface WatchdogAlert {
  readonly severity: 'critical' | 'warn' | 'info'
  readonly mode: 'paper' | 'live'
  readonly key: string
  readonly message: string
}

export interface WatchdogConfig {
  readonly alertAfterMs: number
  readonly cancelAfterMs: number
  /** 0 = never flatten. */
  readonly flattenAfterMs: number
  readonly flattenDemo: boolean
  readonly checkBackstops: boolean
  readonly backstopGraceMs: number
}

function seconds(env: Env, name: string, dflt: number, allowZero: boolean): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return dflt * 1000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new Error(`${name}='${raw}' is not a ${allowZero ? 'non-negative' : 'positive'} number of seconds`)
  }
  return n * 1000
}

export function watchdogConfigFromEnv(env: Env): WatchdogConfig {
  return {
    alertAfterMs: seconds(env, 'DX_WATCHDOG_ALERT_S', 30, false),
    cancelAfterMs: seconds(env, 'DX_WATCHDOG_CANCEL_S', 30, false),
    flattenAfterMs: seconds(env, 'DX_WATCHDOG_FLATTEN_S', 300, true),
    flattenDemo: env['DX_WATCHDOG_FLATTEN_DEMO'] === '1',
    checkBackstops: env['DX_BACKSTOP'] !== '0',
    backstopGraceMs: seconds(env, 'DX_WATCHDOG_BACKSTOP_GRACE_S', 60, false),
  }
}

/** The filters that cancel the desk's ENTRY orders and nothing that can only reduce. */
export const NON_STOP_CANCEL = {
  contract_types: 'call_options,put_options',
  cancel_limit_orders: true,
  cancel_stop_orders: false,
  cancel_reduce_only_orders: false,
} as const

export interface WatchdogTickReport {
  readonly unhealthy: readonly HealthReading[]
  readonly downForMs: number
  readonly rails: Record<string, { positions: number; open: number; cancelled: boolean; flattened: boolean; unprotected: number } | { error: string }>
}

const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const secs = (ms: number): string => `${Math.round(ms / 1000)}s`

export function createWatchdog(deps: {
  readonly readHealth: () => Promise<readonly HealthReading[]>
  readonly rails: readonly WatchdogRailPort[]
  readonly alert: (a: WatchdogAlert) => void
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly now: () => number
  readonly config: WatchdogConfig
}): { tick(): Promise<WatchdogTickReport> } {
  const c = deps.config
  let downSince: number | null = null
  let gatewayDownSince: number | null = null
  /** Per outage: rails whose working orders were cancelled / that were flattened. */
  const cancelled = new Set<string>()
  const flattened = new Set<string>()
  /** rail|symbol → first seen without full backstop cover. */
  const uncoveredSince = new Map<string, number>()

  const tick = async (): Promise<WatchdogTickReport> => {
    const now = deps.now()
    let health: readonly HealthReading[]
    try {
      health = await deps.readHealth()
    } catch (err) {
      health = [{ component: 'desk-health', healthy: false, detail: `health unreadable: ${msgOf(err)}` }]
    }
    const bad = health.filter((h) => !h.healthy)
    const gatewayBad = bad.some((h) => h.component === 'dx-gateway')
    if (bad.length === 0) {
      if (downSince !== null) deps.log('WATCHDOG: desk healthy again', { downForMs: now - downSince })
      downSince = null
      cancelled.clear()
      flattened.clear()
    } else {
      downSince ??= now
    }
    gatewayDownSince = gatewayBad ? (gatewayDownSince ?? now) : null
    const downFor = downSince === null ? 0 : now - downSince
    const gatewayDownFor = gatewayDownSince === null ? 0 : now - gatewayDownSince
    const what = bad.map((h) => `${h.component} (${h.detail})`).join(', ')

    const rails: WatchdogTickReport['rails'] = {}
    for (const r of deps.rails) {
      const mode: 'paper' | 'live' = r.rail === 'live' ? 'live' : 'paper'
      const RAIL = r.rail.toUpperCase()
      let rest: WatchdogRest | null
      try {
        rest = await r.rest()
      } catch (err) {
        rails[r.rail] = { error: msgOf(err) }
        continue
      }
      if (rest === null) continue
      let positions: DxPosition[]
      let open: DxOrder[]
      try {
        ;[positions, open] = await Promise.all([rest.positions(), rest.openOrders()])
      } catch (err) {
        rails[r.rail] = { error: msgOf(err) }
        deps.alert({
          severity: bad.length > 0 ? 'critical' : 'warn',
          mode,
          key: `watchdog:${r.rail}:delta-unreadable`,
          message: `WATCHDOG ${RAIL}: Delta positions/orders unreadable — ${msgOf(err)}` + (bad.length > 0 ? `; desk unhealthy: ${what}` : ''),
        })
        continue
      }
      const held = positions.filter((p) => p.size !== 0)

      // 1. alert
      if (downSince !== null && downFor > c.alertAfterMs && held.length > 0) {
        deps.alert({
          severity: 'critical',
          mode,
          key: `watchdog:${r.rail}:desk-unhealthy`,
          message:
            `WATCHDOG ${RAIL}: desk unhealthy for ${secs(downFor)} — ${what} — while Delta holds ` +
            `${held.length} position(s): ${held.map((p) => `${p.product_symbol} ${p.size}`).join(', ')}`,
        })
      }

      // 2. cancel the desk's working (entry) orders when the gateway is gone
      let didCancel = false
      if (gatewayDownSince !== null && gatewayDownFor > c.cancelAfterMs && !cancelled.has(r.rail)) {
        const working = open.filter((o) => !isStopOrder(o) && o.reduce_only !== true)
        cancelled.add(r.rail)
        if (working.length > 0) {
          try {
            await rest.cancelAllOrders({ ...NON_STOP_CANCEL })
            didCancel = true
            deps.alert({
              severity: 'warn',
              mode,
              key: `watchdog:${r.rail}:cancelled-working`,
              message: `WATCHDOG ${RAIL}: gateway down ${secs(gatewayDownFor)} — cancelled ${working.length} working entry order(s); stops and reduce-only exits kept`,
            })
          } catch (err) {
            cancelled.delete(r.rail)
            deps.alert({ severity: 'critical', mode, key: `watchdog:${r.rail}:cancel-failed`, message: `WATCHDOG ${RAIL}: cancelling working orders FAILED — ${msgOf(err)}` })
          }
        }
      }

      // 3. flatten
      const flattenAfter = r.rail === 'live' || c.flattenDemo ? c.flattenAfterMs : 0
      let didFlatten = false
      if (flattenAfter > 0 && downSince !== null && downFor > flattenAfter && held.length > 0) {
        if (!flattened.has(r.rail)) {
          flattened.add(r.rail)
          try {
            await rest.cancelAllOrders({ ...NON_STOP_CANCEL })
          } catch (err) {
            deps.log(`WATCHDOG ${RAIL}: pre-flatten cancel failed — closing anyway`, { error: msgOf(err) })
          }
          try {
            await rest.closeAllPositions()
            didFlatten = true
            deps.alert({
              severity: 'critical',
              mode,
              key: `watchdog:${r.rail}:flattened`,
              message:
                `WATCHDOG ${RAIL}: FLATTENED — desk unhealthy for ${secs(downFor)} (${what}); close_all sent for ` +
                `${held.map((p) => `${p.product_symbol} ${p.size}`).join(', ')}. Check Delta and the books.`,
            })
          } catch (err) {
            flattened.delete(r.rail)
            deps.alert({ severity: 'critical', mode, key: `watchdog:${r.rail}:flatten-failed`, message: `WATCHDOG ${RAIL}: close_all FAILED — ${msgOf(err)}. FLATTEN BY HAND (scripts/dx-flatten.mts).` })
          }
        } else {
          deps.alert({
            severity: 'critical',
            mode,
            key: `watchdog:${r.rail}:still-held`,
            message: `WATCHDOG ${RAIL}: positions remain after close_all: ${held.map((p) => `${p.product_symbol} ${p.size}`).join(', ')}`,
          })
        }
      }

      // 4. backstop cover
      let unprotected = 0
      if (c.checkBackstops) {
        const seen = new Set<string>()
        for (const p of held) {
          if (p.size >= 0) continue
          const need = -p.size
          const cover = open
            .filter((o) => o.product_id === p.product_id && isBackstopOrderId(o.client_order_id) && o.side === 'buy' && o.reduce_only === true)
            .reduce((s, o) => s + (o.state === 'pending' ? o.size : o.unfilled_size), 0)
          const k = `${r.rail}|${p.product_symbol}`
          if (cover >= need) continue
          unprotected++
          seen.add(k)
          const since = uncoveredSince.get(k) ?? now
          uncoveredSince.set(k, since)
          if (now - since > c.backstopGraceMs) {
            deps.alert({
              severity: r.rail === 'live' ? 'critical' : 'warn',
              mode,
              key: `watchdog:${r.rail}:${p.product_symbol}:backstop`,
              message: `WATCHDOG ${RAIL}: ${p.product_symbol} short ${need} has exchange backstops for only ${cover} — ${need - cover} of ${need} contracts have NO resting stop on Delta`,
            })
          }
        }
        for (const k of [...uncoveredSince.keys()]) if (k.startsWith(`${r.rail}|`) && !seen.has(k)) uncoveredSince.delete(k)
      }
      rails[r.rail] = { positions: held.length, open: open.length, cancelled: didCancel, flattened: didFlatten, unprotected }
    }
    return { unhealthy: bad, downForMs: downFor, rails }
  }

  return {
    tick: async () => {
      try {
        return await tick()
      } catch (err) {
        deps.log('WATCHDOG tick threw', { error: msgOf(err) })
        return { unhealthy: [], downForMs: 0, rails: {} }
      }
    },
  }
}

const isStopOrder = (o: DxOrder): boolean =>
  (typeof o.stop_order_type === 'string' && o.stop_order_type !== '') || o.state === 'pending'
